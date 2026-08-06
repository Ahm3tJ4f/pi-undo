import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent"
import type { CaptureDeps } from "./capture.ts"
import type { SnapshotRepo } from "./git.ts"
import type { CheckpointStore } from "./store.ts"
import type { Checkpoint } from "./types.ts"
import { errorMessage, formatNumstat, listPaths } from "./util.ts"

async function restoreFiles(
  git: SnapshotRepo,
  target: string,
  files: string[],
): Promise<{ ok: boolean; skipped: string[] }> {
  const { skipped } = await git.restoreSnapshot(target, files)
  const ok = await git.verifySnapshot(target, skipped)
  return { ok, skipped }
}

async function rollbackFiles(git: SnapshotRepo, snapshot: string, files: string[]): Promise<boolean> {
  try {
    return (await restoreFiles(git, snapshot, files)).ok
  } catch {
    return false
  }
}

export function registerCommands(pi: ExtensionAPI, store: CheckpointStore, deps: CaptureDeps): void {
  pi.registerCommand("undo", {
    description: "Undo the last user message and restore file state",
    handler: async (_args, ctx) => {
      await undo(store, deps, ctx)
    },
  })

  pi.registerCommand("redo", {
    description: "Redo the most recently undone message",
    handler: async (_args, ctx) => {
      await redo(store, deps, ctx)
    },
  })

  pi.registerCommand("diff", {
    description: "Preview the file changes that /undo would restore",
    handler: async (_args, ctx) => {
      await diff(store, deps, ctx)
    },
  })
}

async function ensureIdle(ctx: ExtensionCommandContext): Promise<void> {
  if (ctx.isIdle()) return
  ctx.abort()
  await ctx.waitForIdle()
}

async function undo(store: CheckpointStore, deps: CaptureDeps, ctx: ExtensionCommandContext): Promise<void> {
  await ensureIdle(ctx)

  const checkpoint = store.latestOnBranch(ctx.sessionManager.getBranch())
  if (!checkpoint) {
    ctx.ui.notify("Nothing to undo", "info")
    return
  }
  if (!checkpoint.beforeLeafId) {
    ctx.ui.notify("Cannot undo the first message in place; fork before it instead", "warning")
    return
  }

  let skipped: string[] = []
  try {
    if (checkpoint.files.length > 0) {
      
      const git = deps.getGit(ctx)
      const dirty = await git.dirtySince(checkpoint.afterSnapshot!)
      if (dirty.length > 0) {
        const list = dirty.slice(0, 10).join("\n") + (dirty.length > 10 ? `\n... and ${dirty.length - 10} more` : "")
        const force = await ctx.ui.confirm(
          "Manual edits found",
          `These files changed since the last run:\n${list}\n\nRestore anyway and lose these edits?`,
        )
        if (!force) {
          ctx.ui.notify("Undo blocked: working tree has manual edits", "warning")
          return
        }
      }

      
      const stats = await git.diffNumstat(checkpoint.beforeSnapshot!, checkpoint.afterSnapshot!)
      const preview = formatNumstat(stats.rows, 20, stats.binaryCount)
      const ok = await ctx.ui.confirm(
        "Undo message",
        `${preview}\n\nRestore files to the state before this message?`,
      )
      if (!ok) {
        ctx.ui.notify("Undo cancelled", "info")
        return
      }

      const outcome = await restoreFiles(git, checkpoint.beforeSnapshot!, checkpoint.files)
      if (!outcome.ok) {
        const rolledBack = await rollbackFiles(git, checkpoint.afterSnapshot!, checkpoint.files)
        ctx.ui.notify(
          rolledBack
            ? "Undo failed: restored files do not match the snapshot; state rolled back"
            : "Undo failed: restored files do not match the snapshot, and the rollback also failed; the working tree can be inconsistent",
          "error",
        )
        return
      }
      skipped = outcome.skipped
    }

    
    let result: { cancelled: boolean }
    try {
      result = await ctx.navigateTree(checkpoint.beforeLeafId, { summarize: false })
    } catch (error) {
      if (checkpoint.files.length > 0) {
        const rolledBack = await rollbackFiles(deps.getGit(ctx), checkpoint.afterSnapshot!, checkpoint.files)
        if (!rolledBack) {
          ctx.ui.notify(
            `Undo failed: ${errorMessage(error)}; the file rollback also failed, the working tree can be inconsistent`,
            "error",
          )
          return
        }
      }
      ctx.ui.notify(`Undo failed: ${errorMessage(error)}`, "error")
      return
    }
    if (result.cancelled) {
      
      if (checkpoint.files.length > 0) {
        const rolledBack = await rollbackFiles(deps.getGit(ctx), checkpoint.afterSnapshot!, checkpoint.files)
        if (!rolledBack) {
          ctx.ui.notify("Undo cancelled; the file rollback also failed, the working tree can be inconsistent", "warning")
          return
        }
      }
      ctx.ui.notify("Undo cancelled", "info")
      return
    }

    store.markReverted(checkpoint)
    
    ctx.ui.setEditorText(checkpoint.prompt)
    const filesNote = checkpoint.files.length > 0 ? `, restored ${checkpoint.files.length} file(s)` : ""
    ctx.ui.notify(`Undid message${filesNote}`, "info")
    if (skipped.length > 0) {
      ctx.ui.notify(
        `Note: ${skipped.length} file(s) not restored, a parent directory is a symlink: ${listPaths(skipped)}`,
        "warning",
      )
    }
    if (checkpoint.imageCount > 0) {
      ctx.ui.notify(`Note: ${checkpoint.imageCount} image attachment(s) from the prompt were not restored`, "warning")
    }
  } catch (error) {
    ctx.ui.notify(`Undo failed: ${errorMessage(error)}`, "error")
  }
}

async function redo(store: CheckpointStore, deps: CaptureDeps, ctx: ExtensionCommandContext): Promise<void> {
  await ensureIdle(ctx)

  const checkpoint = store.peekReverted()
  if (!checkpoint) {
    ctx.ui.notify("Nothing to redo", "info")
    return
  }

  let skipped: string[] = []
  try {
    if (checkpoint.files.length > 0) {
      const git = deps.getGit(ctx)
      const dirty = await git.dirtySince(checkpoint.beforeSnapshot!)
      if (dirty.length > 0) {
        ctx.ui.notify(
          `Redo blocked: working tree has manual edits (${dirty.slice(0, 5).join(", ")})`,
          "warning",
        )
        return
      }
      const outcome = await restoreFiles(git, checkpoint.afterSnapshot!, checkpoint.files)
      if (!outcome.ok) {
        const rolledBack = await rollbackFiles(git, checkpoint.beforeSnapshot!, checkpoint.files)
        ctx.ui.notify(
          rolledBack
            ? "Redo failed: restored files do not match the snapshot; state rolled back"
            : "Redo failed: restored files do not match the snapshot, and the rollback also failed; the working tree can be inconsistent",
          "error",
        )
        return
      }
      skipped = outcome.skipped
    }

    
    let result: { cancelled: boolean }
    try {
      result = await ctx.navigateTree(checkpoint.finalLeafId, { summarize: false })
    } catch (error) {
      if (checkpoint.files.length > 0) {
        const rolledBack = await rollbackFiles(deps.getGit(ctx), checkpoint.beforeSnapshot!, checkpoint.files)
        if (!rolledBack) {
          ctx.ui.notify(
            `Redo failed: ${errorMessage(error)}; the file rollback also failed, the working tree can be inconsistent`,
            "error",
          )
          return
        }
      }
      ctx.ui.notify(`Redo failed: ${errorMessage(error)}`, "error")
      return
    }
    if (result.cancelled) {
      if (checkpoint.files.length > 0) {
        const rolledBack = await rollbackFiles(deps.getGit(ctx), checkpoint.beforeSnapshot!, checkpoint.files)
        if (!rolledBack) {
          ctx.ui.notify("Redo cancelled; the file rollback also failed, the working tree can be inconsistent", "warning")
          return
        }
      }
      ctx.ui.notify("Redo cancelled", "info")
      return
    }

    store.unmarkReverted()
    ctx.ui.setEditorText("")
    const filesNote = checkpoint.files.length > 0 ? `, restored ${checkpoint.files.length} file(s)` : ""
    ctx.ui.notify(`Redid message${filesNote}`, "info")
    if (skipped.length > 0) {
      ctx.ui.notify(
        `Note: ${skipped.length} file(s) not restored, a parent directory is a symlink: ${listPaths(skipped)}`,
        "warning",
      )
    }
  } catch (error) {
    ctx.ui.notify(`Redo failed: ${errorMessage(error)}`, "error")
  }
}

async function diff(store: CheckpointStore, deps: CaptureDeps, ctx: ExtensionCommandContext): Promise<void> {
  await ensureIdle(ctx)

  const checkpoint: Checkpoint | undefined = store.latestOnBranch(ctx.sessionManager.getBranch())
  if (!checkpoint) {
    ctx.ui.notify("Nothing to preview: no checkpointed messages", "info")
    return
  }
  if (checkpoint.files.length === 0) {
    ctx.ui.notify("The last message changed no files", "info")
    return
  }
  try {
    const git = deps.getGit(ctx)
    const stats = await git.diffNumstat(checkpoint.beforeSnapshot!, checkpoint.afterSnapshot!)
    ctx.ui.notify(
      `Changes made by the last message (what /undo restores):\n\n${formatNumstat(stats.rows, 20, stats.binaryCount)}`,
      "info",
    )
  } catch (error) {
    ctx.ui.notify(`Preview failed: ${errorMessage(error)}`, "error")
  }
}
