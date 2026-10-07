import type { SkippedPath, SnapshotRepo } from "./git.ts"
import { errorMessage, listInline } from "./util.ts"

export interface RestorePlan {
  target: string
  // Tree with the state of `paths` right before the restore. Rollback goes
  // back to it, so a failed restore never loses manual edits.
  original: string
  // Paths whose current state differs from the target. The restore rewrites
  // exactly these.
  paths: string[]
  // Paths that match neither snapshot of the message: someone changed them
  // after it. The restore overwrites these changes.
  manualEdits: string[]
  // Paths the restore must not touch.
  skipped: SkippedPath[]
}

export class RestoreError extends Error {
  // False when the rollback failed too and `paths` can be half restored.
  readonly rolledBack: boolean
  readonly paths: string[]

  constructor(message: string, rolledBack: boolean, paths: string[]) {
    super(message)
    this.name = "RestoreError"
    this.rolledBack = rolledBack
    this.paths = paths
  }
}

// Plans a restore of `files` from the `current` snapshot (where the files
// should be now) to the `target` snapshot. Reads the worktree, writes nothing
// to it.
export async function planRestore(
  repo: SnapshotRepo,
  files: readonly string[],
  current: string,
  target: string,
): Promise<RestorePlan> {
  const { restorable, skipped } = await repo.partition(files)
  if (restorable.length === 0) return { target, original: target, paths: [], manualEdits: [], skipped }

  const original = await repo.capture(restorable)
  const differsFromTarget = await changedPaths(repo, target, original, restorable)
  const differsFromCurrent = new Set(await changedPaths(repo, current, original, restorable))
  return {
    target,
    original,
    paths: differsFromTarget,
    manualEdits: differsFromTarget.filter((file) => differsFromCurrent.has(file)),
    skipped,
  }
}

// Restores the plan's paths and verifies the result. On any failure the
// paths go back to their original state and a RestoreError is thrown.
export async function applyRestore(repo: SnapshotRepo, plan: RestorePlan): Promise<void> {
  if (plan.paths.length === 0) return
  try {
    await repo.restore(plan.target, plan.paths)
    await verify(repo, plan.target, plan.paths)
  } catch (error) {
    throw new RestoreError(errorMessage(error), await rollback(repo, plan), plan.paths)
  }
}

// Puts the plan's paths back to their state before applyRestore. Returns
// false when that fails too.
export async function rollback(repo: SnapshotRepo, plan: RestorePlan): Promise<boolean> {
  if (plan.paths.length === 0) return true
  try {
    await repo.restore(plan.original, plan.paths)
    await verify(repo, plan.original, plan.paths)
    return true
  } catch {
    return false
  }
}

async function verify(repo: SnapshotRepo, tree: string, paths: readonly string[]): Promise<void> {
  const now = await repo.capture(paths)
  const mismatched = await changedPaths(repo, tree, now, paths)
  if (mismatched.length > 0) {
    throw new Error(`restored files do not match the snapshot: ${listInline(mismatched)}`)
  }
}

async function changedPaths(
  repo: SnapshotRepo,
  from: string,
  to: string,
  paths: readonly string[],
): Promise<string[]> {
  if (from === to) return []
  const wanted = new Set(paths)
  return (await repo.changedFiles(from, to)).filter((file) => wanted.has(file))
}
