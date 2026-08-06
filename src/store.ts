import type {
  ExtensionAPI,
  SessionEntry,
} from "@earendil-works/pi-coding-agent";
import type { Checkpoint, RevertState } from "./types.ts";

export const CHECKPOINT_TYPE = "pi-undo/checkpoint";
export const REVERT_TYPE = "pi-undo/revert";

export class CheckpointStore {
  private readonly pi: ExtensionAPI;
  private readonly checkpoints = new Map<string, Checkpoint>();
  
  private reverted: Checkpoint[] = [];

  constructor(pi: ExtensionAPI) {
    this.pi = pi;
  }

  load(sessionManager: { getEntries(): SessionEntry[] }): void {
    this.checkpoints.clear();
    this.reverted = [];
    let lastRevert: RevertState | undefined;
    for (const entry of sessionManager.getEntries()) {
      if (entry.type !== "custom") continue;
      if (entry.customType === CHECKPOINT_TYPE) {
        const checkpoint = parseCheckpoint(
          entry.data as Partial<Checkpoint> | undefined,
        );
        if (checkpoint)
          this.checkpoints.set(checkpoint.userEntryId, checkpoint);
      } else if (entry.customType === REVERT_TYPE) {
        lastRevert = entry.data as RevertState | undefined;
      }
    }
    if (lastRevert && Array.isArray(lastRevert.revertedEntryIds)) {
      this.reverted = lastRevert.revertedEntryIds
        .map((id) => this.checkpoints.get(id))
        .filter((cp): cp is Checkpoint => Boolean(cp));
    }
  }

  get(id: string): Checkpoint | undefined {
    return this.checkpoints.get(id);
  }

  
  add(checkpoint: Checkpoint): void {
    this.checkpoints.set(checkpoint.userEntryId, checkpoint);
    this.pi.appendEntry(CHECKPOINT_TYPE, checkpoint);
  }

  
  latestOnBranch(branch: SessionEntry[]): Checkpoint | undefined {
    for (let i = branch.length - 1; i >= 0; i--) {
      const entry = branch[i];
      if (!entry || entry.type !== "message" || entry.message.role !== "user")
        continue;
      const checkpoint = this.checkpoints.get(entry.id);
      if (checkpoint) return checkpoint;
    }
    return undefined;
  }

  
  peekReverted(): Checkpoint | undefined {
    return this.reverted[this.reverted.length - 1];
  }

  markReverted(checkpoint: Checkpoint): void {
    this.reverted.push(checkpoint);
    this.persistRevert();
  }

  
  unmarkReverted(): Checkpoint | undefined {
    const checkpoint = this.reverted.pop();
    if (checkpoint) this.persistRevert();
    return checkpoint;
  }

  
  clearRevert(): void {
    if (this.reverted.length === 0) return;
    this.reverted = [];
    this.persistRevert();
  }

  private persistRevert(): void {
    this.pi.appendEntry(REVERT_TYPE, {
      revertedEntryIds: this.reverted.map((cp) => cp.userEntryId),
    } satisfies RevertState);
  }
}

function parseCheckpoint(
  value: Partial<Checkpoint> | undefined,
): Checkpoint | null {
  if (!value || typeof value !== "object") return null;
  if (typeof value.userEntryId !== "string") return null;
  if (typeof value.finalLeafId !== "string") return null;
  if (typeof value.prompt !== "string") return null;
  if (!Array.isArray(value.files)) return null;
  const beforeSnapshot =
    typeof value.beforeSnapshot === "string" ? value.beforeSnapshot : null;
  const afterSnapshot =
    typeof value.afterSnapshot === "string" ? value.afterSnapshot : null;
  if (value.files.length > 0 && (!beforeSnapshot || !afterSnapshot))
    return null;
  return {
    userEntryId: value.userEntryId,
    beforeLeafId:
      typeof value.beforeLeafId === "string" ? value.beforeLeafId : null,
    finalLeafId: value.finalLeafId,
    prompt: value.prompt,
    imageCount: typeof value.imageCount === "number" ? value.imageCount : 0,
    beforeSnapshot,
    afterSnapshot,
    files: value.files.filter(
      (file): file is string => typeof file === "string",
    ),
    createdAt:
      typeof value.createdAt === "number" ? value.createdAt : Date.now(),
  };
}
