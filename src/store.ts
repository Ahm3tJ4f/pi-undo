import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import type { Checkpoint, FileSnapshot } from "./types.ts"

export const CHECKPOINT_TYPE = "pi-undo/checkpoint"
export const REVERT_TYPE = "pi-undo/revert"

// The fields of a session entry that the store reads.
export interface StoreEntry {
  type: string
  customType?: string
  data?: unknown
}

// Checkpoints and the redo stack, persisted as custom session entries so
// that undo and redo survive a restart.
export class CheckpointStore {
  private readonly pi: Pick<ExtensionAPI, "appendEntry">
  private readonly checkpoints = new Map<string, Checkpoint>()
  // Undone checkpoints, oldest first. The last one is the next redo.
  private reverted: Checkpoint[] = []

  constructor(pi: Pick<ExtensionAPI, "appendEntry">) {
    this.pi = pi
  }

  load(entries: readonly StoreEntry[]): void {
    this.checkpoints.clear()
    let revertedIds: string[] = []
    for (const entry of entries) {
      if (entry.type !== "custom") continue
      if (entry.customType === CHECKPOINT_TYPE) {
        const checkpoint = parseCheckpoint(entry.data)
        if (checkpoint) this.checkpoints.set(checkpoint.entryId, checkpoint)
      } else if (entry.customType === REVERT_TYPE) {
        revertedIds = parseRevertedIds(entry.data) ?? revertedIds
      }
    }
    this.reverted = revertedIds.flatMap((id) => this.checkpoints.get(id) ?? [])
  }

  get(entryId: string): Checkpoint | undefined {
    return this.checkpoints.get(entryId)
  }

  add(checkpoint: Checkpoint): void {
    this.checkpoints.set(checkpoint.entryId, checkpoint)
    this.pi.appendEntry(CHECKPOINT_TYPE, { v: 2, ...checkpoint })
  }

  // The checkpoint of the newest run on the branch.
  latestOnBranch(branch: readonly { id: string }[]): Checkpoint | undefined {
    for (let i = branch.length - 1; i >= 0; i--) {
      const checkpoint = this.checkpoints.get(branch[i]!.id)
      if (checkpoint) return checkpoint
    }
    return undefined
  }

  peekReverted(): Checkpoint | undefined {
    return this.reverted.at(-1)
  }

  pushReverted(checkpoint: Checkpoint): void {
    this.reverted.push(checkpoint)
    this.persistReverted()
  }

  popReverted(): Checkpoint | undefined {
    const checkpoint = this.reverted.pop()
    if (checkpoint) this.persistReverted()
    return checkpoint
  }

  clearReverted(): void {
    if (this.reverted.length === 0) return
    this.reverted = []
    this.persistReverted()
  }

  private persistReverted(): void {
    this.pi.appendEntry(REVERT_TYPE, { revertedEntryIds: this.reverted.map((cp) => cp.entryId) })
  }
}

type Fields = Record<string, unknown>

function isFields(value: unknown): value is Fields {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function strings(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every((item) => typeof item === "string") ? value : undefined
}

function parseRevertedIds(value: unknown): string[] | undefined {
  return isFields(value) ? strings(value.revertedEntryIds) : undefined
}

// Accepts the current format and the format of pi-undo 0.4 and older, which
// keyed checkpoints by `userEntryId` and kept the snapshot fields flat.
export function parseCheckpoint(value: unknown): Checkpoint | null {
  if (!isFields(value)) return null
  const entryId = typeof value.entryId === "string" ? value.entryId : value.userEntryId
  if (typeof entryId !== "string" || typeof value.finalLeafId !== "string" || typeof value.prompt !== "string") {
    return null
  }
  const snapshot = value.v === 2 ? parseSnapshot(value.snapshot) : parseLegacySnapshot(value)
  if (snapshot === undefined) return null
  const checkpoint: Checkpoint = {
    entryId,
    finalLeafId: value.finalLeafId,
    prompt: value.prompt,
    imageCount: typeof value.imageCount === "number" ? value.imageCount : 0,
    snapshot,
    createdAt: typeof value.createdAt === "number" ? value.createdAt : 0,
  }
  if (typeof value.unavailable === "string") checkpoint.unavailable = value.unavailable
  return checkpoint
}

// Undefined means the value is malformed; null means "no snapshot".
function parseSnapshot(value: unknown): FileSnapshot | null | undefined {
  if (value === null) return null
  if (!isFields(value)) return undefined
  const files = strings(value.files)
  if (typeof value.before !== "string" || typeof value.after !== "string" || !files || files.length === 0) {
    return undefined
  }
  return { before: value.before, after: value.after, files }
}

function parseLegacySnapshot(value: Fields): FileSnapshot | null | undefined {
  const files = strings(value.files)
  if (!files) return undefined
  if (files.length === 0) return null
  if (typeof value.beforeSnapshot !== "string" || typeof value.afterSnapshot !== "string") return undefined
  return { before: value.beforeSnapshot, after: value.afterSnapshot, files }
}
