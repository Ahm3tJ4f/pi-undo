import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent"
import type { SnapshotRepo } from "./git.ts"
import type { CheckpointStore } from "./store.ts"
import type { Checkpoint, FileSnapshot } from "./types.ts"
import { errorMessage } from "./util.ts"

export interface RepoContext {
  cwd: string
  ui: Pick<ExtensionUIContext, "notify">
}

export type RepoProvider = (ctx: RepoContext) => SnapshotRepo

// The fields of a session entry the tracker reads.
export interface BranchEntry {
  id: string
  type: string
  message?: { role: string }
}

export interface TrackerContext extends RepoContext {
  isIdle(): boolean
  sessionManager: {
    getLeafId(): string | null
    getBranch(): readonly BranchEntry[]
  }
}

const SNAPSHOT_SKIPPED = "the project has more files than maxFiles in pi-undo.json"

interface Run {
  // Session leaf when the run started. The run's own entries follow it.
  startLeafId: string | null
  prompt: string
  imageCount: number
  // Settles when the pre-run snapshot is done.
  ready: Promise<void>
  before?: string
  unavailable?: string
}

// Records one checkpoint per agent run: a snapshot when the run starts, a
// snapshot when it settles, and the session entries in between.
//
// The run starts at `agent_start`, not at `before_agent_start`: every run
// has it (including runs that an extension starts with a custom message),
// pi awaits it before the first model request, and pi already counts the
// session as busy then, so /undo cannot slip in before the snapshot.
export class TurnTracker {
  private readonly store: CheckpointStore
  private readonly repoFor: RepoProvider
  private nextPrompt: { text: string; imageCount: number } | undefined
  private run: Run | undefined
  // Settles when every finished run has its checkpoint.
  private recording: Promise<void> = Promise.resolve()

  constructor(store: CheckpointStore, repoFor: RepoProvider) {
    this.store = store
    this.repoFor = repoFor
  }

  // Called on `before_agent_start`, which carries the prompt.
  notePrompt(text: string, imageCount: number): void {
    this.nextPrompt = { text, imageCount }
  }

  // Called on `agent_start`. A second `agent_start` before the run settles
  // (a retry or a queued continuation) belongs to the same run.
  async start(ctx: TrackerContext): Promise<void> {
    if (this.run) return
    const prompt = this.nextPrompt
    this.nextPrompt = undefined
    // A new run moves history forward, so the redo stack is stale.
    this.store.clearReverted()
    let markReady = () => {}
    const run: Run = {
      startLeafId: ctx.sessionManager.getLeafId(),
      prompt: prompt?.text ?? "",
      imageCount: prompt?.imageCount ?? 0,
      ready: new Promise((resolve) => {
        markReady = resolve
      }),
    }
    this.run = run
    try {
      const before = await this.repoFor(ctx).track()
      if (before) run.before = before
      else run.unavailable = SNAPSHOT_SKIPPED
    } catch (error) {
      run.unavailable = `the snapshot failed: ${errorMessage(error)}`
      ctx.ui.notify(`pi-undo: snapshot failed, file undo is off for this message: ${errorMessage(error)}`, "warning")
    } finally {
      markReady()
    }
  }

  // Called on `agent_settled`. Returns when the checkpoint is stored.
  finish(ctx: TrackerContext): Promise<void> {
    const run = this.run
    if (run) {
      this.run = undefined
      this.recording = this.recording.then(() => this.record(ctx, run))
    }
    return this.recording
  }

  // Makes sure the last finished run has its checkpoint. pi marks the session
  // idle before it calls the `agent_settled` handlers, so a command can run
  // in between; it calls this before it reads the store.
  flush(ctx: TrackerContext): Promise<void> {
    if (this.run && ctx.isIdle()) return this.finish(ctx)
    return this.recording
  }

  // Drops the current run, for example when the session is replaced.
  reset(): void {
    this.run = undefined
    this.nextPrompt = undefined
  }

  private async record(ctx: TrackerContext, run: Run): Promise<void> {
    await run.ready
    const entryId = findRunStart(ctx.sessionManager.getBranch(), run.startLeafId)
    // The run added no message to this branch, so there is nothing to undo.
    if (!entryId) return

    let snapshot: FileSnapshot | null = null
    let unavailable = run.unavailable
    if (run.before) {
      try {
        const result = await this.snapshotRun(ctx, run.before)
        snapshot = result.snapshot
        unavailable = result.unavailable
      } catch (error) {
        unavailable = `the snapshot failed: ${errorMessage(error)}`
        ctx.ui.notify(`pi-undo: snapshot failed, file undo is off for this message: ${errorMessage(error)}`, "warning")
      }
    }

    const checkpoint: Checkpoint = {
      entryId,
      finalLeafId: ctx.sessionManager.getLeafId() ?? entryId,
      prompt: run.prompt,
      imageCount: run.imageCount,
      snapshot,
      createdAt: Date.now(),
    }
    if (unavailable) checkpoint.unavailable = unavailable
    this.store.add(checkpoint)
  }

  private async snapshotRun(
    ctx: TrackerContext,
    before: string,
  ): Promise<{ snapshot: FileSnapshot | null; unavailable?: string }> {
    const repo = this.repoFor(ctx)
    const after = await repo.track()
    if (!after) return { snapshot: null, unavailable: SNAPSHOT_SKIPPED }
    const files = await repo.changedFiles(before, after)
    if (files.length === 0) return { snapshot: null }
    try {
      await repo.protect([before, after])
    } catch (error) {
      // The trees still exist; without the refs they survive only until the
      // next gc grace period ends.
      ctx.ui.notify(`pi-undo: could not pin the snapshot: ${errorMessage(error)}`, "warning")
    }
    return { snapshot: { before, after, files } }
  }
}

function isRunStart(entry: BranchEntry): boolean {
  return (entry.type === "message" && entry.message?.role === "user") || entry.type === "custom_message"
}

// The first user or custom message after `startLeafId` on the branch, or
// undefined when the run left the branch (for example after a tree jump).
export function findRunStart(branch: readonly BranchEntry[], startLeafId: string | null): string | undefined {
  let first: string | undefined
  for (let i = branch.length - 1; i >= 0; i--) {
    const entry = branch[i]!
    if (entry.id === startLeafId) return first
    if (isRunStart(entry)) first = entry.id
  }
  return startLeafId === null ? first : undefined
}
