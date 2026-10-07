import type { ExtensionAPI, ExtensionUIContext } from "@earendil-works/pi-coding-agent"
import type { SkippedPath, SkipReason, SnapshotRepo } from "./git.ts"
import { applyRestore, planRestore, RestoreError, type RestorePlan, rollback } from "./restore.ts"
import type { CheckpointStore } from "./store.ts"
import type { RepoProvider, TrackerContext, TurnTracker } from "./tracker.ts"
import type { Checkpoint } from "./types.ts"
import { errorMessage, formatNumstat, listInline, listLines, type NumstatRow } from "./util.ts"

export interface CommandContext extends TrackerContext {
  hasUI: boolean
  ui: Pick<ExtensionUIContext, "notify" | "confirm" | "getEditorText" | "setEditorText">
  abort(): void
  waitForIdle(): Promise<void>
  navigateTree(targetId: string, options?: { summarize?: boolean }): Promise<{ cancelled: boolean }>
}

export interface CommandDeps {
  store: CheckpointStore
  tracker: TurnTracker
  repoFor: RepoProvider
  // True while a command navigates the session tree, so the tree listener
  // can tell these navigations from the user's own.
  navigation: { active: boolean }
}

type Direction = "undo" | "redo"

const WORDS = {
  undo: { name: "Undo", past: "Undid", state: "before" },
  redo: { name: "Redo", past: "Redid", state: "after" },
} as const

const SKIP_REASONS: Record<SkipReason, string> = {
  symlink: "below a symlinked directory",
  excluded: "excluded by pi-undo.json",
}

export function registerCommands(pi: Pick<ExtensionAPI, "registerCommand">, deps: CommandDeps): void {
  pi.registerCommand("undo", {
    description: "Undo the last message: roll back the conversation and the files it changed",
    handler: (_args, ctx) => undo(deps, ctx),
  })
  pi.registerCommand("redo", {
    description: "Redo the last undone message",
    handler: (_args, ctx) => redo(deps, ctx),
  })
  pi.registerCommand("diff", {
    description: "Show the file changes that /undo would roll back",
    handler: (_args, ctx) => diff(deps, ctx),
  })
}

export async function undo(deps: CommandDeps, ctx: CommandContext): Promise<void> {
  await settle(deps, ctx)
  const checkpoint = deps.store.latestOnBranch(ctx.sessionManager.getBranch())
  if (!checkpoint) {
    ctx.ui.notify("Nothing to undo", "info")
    return
  }
  await revert(deps, ctx, checkpoint, "undo")
}

export async function redo(deps: CommandDeps, ctx: CommandContext): Promise<void> {
  await settle(deps, ctx)
  const checkpoint = deps.store.peekReverted()
  if (!checkpoint) {
    ctx.ui.notify("Nothing to redo", "info")
    return
  }
  await revert(deps, ctx, checkpoint, "redo")
}

export async function diff(deps: CommandDeps, ctx: CommandContext): Promise<void> {
  // A preview must not stop a running agent. It shows the last finished
  // message instead.
  const running = !ctx.isIdle()
  if (!running) await deps.tracker.flush(ctx)
  const checkpoint = deps.store.latestOnBranch(ctx.sessionManager.getBranch())
  const header = running ? "The agent is running; this is the last finished message.\n\n" : ""
  if (!checkpoint) {
    ctx.ui.notify(`${header}Nothing to preview: no message has a checkpoint yet`, "info")
    return
  }
  if (!checkpoint.snapshot) {
    const text = checkpoint.unavailable
      ? `The last message has no file snapshot: ${checkpoint.unavailable}`
      : "The last message changed no files"
    ctx.ui.notify(header + text, "info")
    return
  }
  try {
    const repo = deps.repoFor(ctx)
    const { before, after, files } = checkpoint.snapshot
    if (!(await repo.hasTrees([before, after]))) {
      ctx.ui.notify(
        `${header}The file snapshots of the last message are gone; /undo can roll back the conversation only`,
        "info",
      )
      return
    }
    const rows = await repo.diffNumstat(before, after)
    let text = `${header}Changes made by the last message (what /undo rolls back):\n\n${formatNumstat(rows)}`
    if (!running) {
      const plan = await planRestore(repo, files, after, before)
      text += planDetails(plan)
    }
    ctx.ui.notify(text, "info")
  } catch (error) {
    ctx.ui.notify(`Preview failed: ${errorMessage(error)}`, "error")
  }
}

// Stops a running agent and makes sure its run has a checkpoint.
async function settle(deps: CommandDeps, ctx: CommandContext): Promise<void> {
  if (!ctx.isIdle()) {
    ctx.abort()
    await ctx.waitForIdle()
  }
  await deps.tracker.flush(ctx)
}

interface Restored {
  repo: SnapshotRepo
  plan: RestorePlan
}

// Moves files and conversation together to the state before (undo) or after
// (redo) the checkpoint's message. Files first: if the files cannot be
// restored, the conversation stays where it is. If the conversation cannot
// move, the files are rolled back.
async function revert(
  deps: CommandDeps,
  ctx: CommandContext,
  checkpoint: Checkpoint,
  direction: Direction,
): Promise<void> {
  const words = WORDS[direction]
  const notes: string[] = []
  let restored: Restored | undefined
  try {
    const outcome = await restoreFiles(deps, ctx, checkpoint, direction, notes)
    if (outcome === "cancelled") {
      ctx.ui.notify(`${words.name} cancelled`, "info")
      return
    }
    restored = outcome
  } catch (error) {
    ctx.ui.notify(failureText(words.name, error), "error")
    return
  }

  const navigationError = await navigate(deps, ctx, direction === "undo" ? checkpoint.entryId : checkpoint.finalLeafId)
  if (navigationError !== undefined) {
    const rolledBack = restored ? await rollback(restored.repo, restored.plan) : true
    const reason =
      navigationError === "cancelled" ? `${words.name} cancelled` : `${words.name} failed: ${navigationError}`
    ctx.ui.notify(
      rolledBack
        ? reason
        : `${reason}. The files could not be put back either; check: ${listInline(restored?.plan.paths ?? [])}`,
      rolledBack && navigationError === "cancelled" ? "info" : "error",
    )
    return
  }

  if (direction === "undo") {
    deps.store.pushReverted(checkpoint)
    // pi fills an empty editor with the undone prompt on its own. This only
    // covers modes where it does not, and never replaces a draft.
    if (!ctx.ui.getEditorText().trim()) ctx.ui.setEditorText(checkpoint.prompt)
    if (checkpoint.imageCount > 0) {
      notes.push(`${checkpoint.imageCount} image attachment(s) of the prompt are not back in the editor.`)
    }
  } else {
    deps.store.popReverted()
    if (ctx.ui.getEditorText().trim() === checkpoint.prompt.trim()) ctx.ui.setEditorText("")
  }

  const count = restored?.plan.paths.length ?? 0
  ctx.ui.notify(`${words.past} message${count > 0 ? `, restored ${count} file(s)` : ""}`, "info")
  if (notes.length > 0) ctx.ui.notify(notes.join("\n"), "warning")
}

// Restores the checkpoint's files, after the user confirms. Returns the
// applied plan (undefined when no file had to change) or "cancelled".
async function restoreFiles(
  deps: CommandDeps,
  ctx: CommandContext,
  checkpoint: Checkpoint,
  direction: Direction,
  notes: string[],
): Promise<Restored | undefined | "cancelled"> {
  const words = WORDS[direction]
  if (!checkpoint.snapshot) {
    if (!checkpoint.unavailable) return undefined
    const ok = await confirmConversationOnly(
      ctx,
      words.name,
      `This message has no file snapshot: ${checkpoint.unavailable}.`,
    )
    if (!ok) return "cancelled"
    notes.push("Files were not restored: the message has no file snapshot.")
    return undefined
  }

  const repo = deps.repoFor(ctx)
  const { before, after, files } = checkpoint.snapshot
  if (!(await repo.hasTrees([before, after]))) {
    const ok = await confirmConversationOnly(
      ctx,
      words.name,
      "The file snapshots of this message are gone: they were pruned, or the session moved to another directory.",
    )
    if (!ok) return "cancelled"
    notes.push("Files were not restored: the snapshots are gone.")
    return undefined
  }

  const [current, target] = direction === "undo" ? [after, before] : [before, after]
  const plan = await planRestore(repo, files, current, target)
  const rows = await repo.diffNumstat(before, after)
  if (ctx.hasUI) {
    if (!(await ctx.ui.confirm(`${words.name} message`, restoreDialog(direction, plan, rows)))) return "cancelled"
  } else if (plan.manualEdits.length > 0) {
    // Without a UI nobody can confirm that manual edits may be lost.
    throw new Error(`files were changed after the message: ${listInline(plan.manualEdits)}`)
  }

  await applyRestore(repo, plan)
  notes.push(...skippedNotes(plan.skipped))
  return { repo, plan }
}

async function confirmConversationOnly(ctx: CommandContext, name: string, reason: string): Promise<boolean> {
  if (!ctx.hasUI) return true
  return ctx.ui.confirm(
    `${name} message`,
    `${reason}\n\n${name} the conversation only and leave the files as they are?`,
  )
}

async function navigate(deps: CommandDeps, ctx: CommandContext, targetId: string): Promise<string | undefined> {
  deps.navigation.active = true
  try {
    const result = await ctx.navigateTree(targetId, { summarize: false })
    return result.cancelled ? "cancelled" : undefined
  } catch (error) {
    return errorMessage(error)
  } finally {
    deps.navigation.active = false
  }
}

function restoreDialog(direction: Direction, plan: RestorePlan, rows: readonly NumstatRow[]): string {
  const { state } = WORDS[direction]
  const intro =
    plan.paths.length > 0
      ? `Restore ${plan.paths.length} file(s) to their state ${state} this message?`
      : `The files already match their state ${state} this message. Move the conversation only?`
  return `${intro}\n\nChanges made by the message:\n${formatNumstat(rows)}${planDetails(plan)}`
}

function planDetails(plan: RestorePlan): string {
  let text = ""
  if (plan.manualEdits.length > 0) {
    text += `\n\nChanged after the message. These changes will be lost:\n${listLines(plan.manualEdits)}`
  }
  for (const [reason, paths] of groupSkipped(plan.skipped)) {
    text += `\n\nNot restored, ${SKIP_REASONS[reason]}:\n${listLines(paths)}`
  }
  return text
}

function skippedNotes(skipped: readonly SkippedPath[]): string[] {
  return [...groupSkipped(skipped)].map(
    ([reason, paths]) => `${paths.length} file(s) not restored, ${SKIP_REASONS[reason]}: ${listInline(paths)}`,
  )
}

function groupSkipped(skipped: readonly SkippedPath[]): Map<SkipReason, string[]> {
  const groups = new Map<SkipReason, string[]>()
  for (const { path, reason } of skipped) {
    const paths = groups.get(reason)
    if (paths) paths.push(path)
    else groups.set(reason, [path])
  }
  return groups
}

function failureText(name: string, error: unknown): string {
  if (error instanceof RestoreError) {
    return error.rolledBack
      ? `${name} failed, the files are unchanged: ${error.message}`
      : `${name} failed, and putting the files back failed too (${error.message}). Check: ${listInline(error.paths)}`
  }
  return `${name} failed: ${errorMessage(error)}`
}
