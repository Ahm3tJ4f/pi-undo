import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent"
import type { CaptureDeps } from "./capture.ts"
import type { SnapshotRepo } from "./git.ts"
import { attributeTouches } from "./journal.ts"
import type { CheckpointStore } from "./store.ts"
import type { Checkpoint } from "./types.ts"
import { errorMessage, formatNumstat, listPaths } from "./util.ts"

interface RestoreOutcome {
  ok: boolean
  skipped: string[]
  excluded: string[]
  manualSkipped: string[]
}

interface AttributionGroups {
  editedFiles: string[]
  unknownFiles: string[]
  otherSession: string[]
}

async function restoreFiles(
  git: SnapshotRepo,
  target: string,
  files: string[],
  since?: string,
  opts?: { manualSet?: ReadonlySet<string>; force?: boolean },
): Promise<RestoreOutcome> {
  const { skipped, excluded, manualSkipped } = await git.restoreSnapshot(target, files, since, opts)
  const ok = await git.verifySnapshot(target, [...skipped, ...excluded, ...manualSkipped])
  return { ok, skipped, excluded, manualSkipped }
}

async function rollbackFiles(
  git: SnapshotRepo,
  snapshot: string,
  files: string[],
  outcome: { skipped: string[]; excluded: string[]; manualSkipped: string[] },
): Promise<boolean> {
  try {
    // Rollback must skip exactly the files the failed restore skipped: those
    // files were never changed by it. Recomputing the manual-edit list now
    // would see the failed restore's own changes and skip files it just
    // restored. Pass the original manualSkipped list through as manualSet.
    return (await restoreFiles(git, snapshot, files, undefined, { manualSet: new Set(outcome.manualSkipped) })).ok
  } catch {
    return false
  }
}

function formatList(paths: string[], max = 10): string {
  const shown = paths.slice(0, max).join("\n")
  return shown + (paths.length > max ? `\n... and ${paths.length - max} more` : "")
}

// Splits the checkpoint files into the three groups the dialogs need:
// editedFiles (this session's write/edit tools touched them), otherSession
// (another pi session's journal names them), and unknownFiles (changed, but
// no known source). The journal is best effort: any failure means every
// unattributed file is treated as unknown.
async function splitFiles(
  git: SnapshotRepo,
  checkpoint: Checkpoint,
  selfSessionId: string,
): Promise<AttributionGroups> {
  const unattributed = checkpoint.unattributed ?? []
  const unattributedSet = new Set(unattributed)
  const editedFiles = checkpoint.files.filter((file) => !unattributedSet.has(file))
  let attributed = new Map<string, string[]>()
  if (unattributed.length > 0) {
    try {
      attributed = await attributeTouches(git.storeDir, selfSessionId, unattributed)
    } catch {
      attributed = new Map()
    }
  }
  const otherSession = unattributed
    .filter((file) => attributed.has(file))
    .map((file) => {
      const sessions = attributed.get(file) ?? []
      return `${file} (session ${sessions.join(", ")})`
    })
  const unknownFiles = unattributed.filter((file) => !attributed.has(file))
  return { editedFiles, unknownFiles, otherSession }
}

export function registerCommands(
  pi: Pick<ExtensionAPI, "registerCommand">,
  store: CheckpointStore,
  deps: CaptureDeps,
): void {
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

interface SnapshotChanges {
  before: string
  after: string
}

function snapshotChanges(checkpoint: Checkpoint): SnapshotChanges | null {
  if (checkpoint.files.length === 0) return null
  if (!checkpoint.beforeSnapshot || !checkpoint.afterSnapshot) return null
  return { before: checkpoint.beforeSnapshot, after: checkpoint.afterSnapshot }
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

  const changes = snapshotChanges(checkpoint)
  let skipped: string[] = []
  let excluded: string[] = []
  let manualSkipped: string[] = []
  let filesToRestore: string[] = []
  let unknownDeclined: string[] = []
  let otherSession: string[] = []
  let outcome: RestoreOutcome | null = null
  let didRestore = false
  try {
    if (changes) {
      const git = deps.getGit(ctx)
      const dirty = await git.dirtySinceAll(changes.after)
      // Only files the message changed can be clobbered by the restore.
      // Manual edits in other files survive the undo, so they must not
      // block it or trigger the dialog. Gitignored files are included too:
      // the dialog now covers them instead of skipping them silently.
      const messageFiles = new Set(checkpoint.files)
      const manualInMessage = [...dirty.manual, ...dirty.ignored].filter((file) => messageFiles.has(file))
      if (manualInMessage.length > 0) {
        const list = formatList(manualInMessage)
        const force = await ctx.ui.confirm(
          "Manual edits found",
          `These files were changed by the last message and have manual edits since:\n${list}\n\nRestore anyway and lose these edits?`,
        )
        if (!force) {
          ctx.ui.notify("Undo blocked: working tree has manual edits in files changed by the message", "warning")
          return
        }
      }

      const groups = await splitFiles(git, checkpoint, ctx.sessionManager.getSessionId())
      otherSession = groups.otherSession
      const editedSet = new Set(groups.editedFiles)

      const stats = await git.diffNumstat(changes.before, changes.after)
      const preview = formatNumstat(
        stats.rows.filter((row) => editedSet.has(row.file)),
        20,
        stats.binaryCount,
      )
      let message = `${preview}\n\nRestore files to the state before this message?`
      if (groups.unknownFiles.length > 0) {
        message += `\n\nAlso changed during the message, not by this session's file tools:\n${formatList(groups.unknownFiles)}`
      }
      if (otherSession.length > 0) {
        message += `\n\nEdited by other pi sessions, never restored:\n${formatList(otherSession)}`
      }
      const ok = await ctx.ui.confirm("Undo message", message)
      if (!ok) {
        ctx.ui.notify("Undo cancelled", "info")
        return
      }

      if (groups.unknownFiles.length > 0) {
        const restoreUnknown = await ctx.ui.confirm(
          "Unattributed changes",
          `These changed during the message but this session's file tools did not edit them. Restore them too?\n\n${formatList(groups.unknownFiles)}`,
        )
        if (restoreUnknown) {
          filesToRestore = [...groups.editedFiles, ...groups.unknownFiles]
        } else {
          filesToRestore = groups.editedFiles
          unknownDeclined = groups.unknownFiles
        }
      } else {
        filesToRestore = groups.editedFiles
      }

      if (filesToRestore.length > 0) {
        outcome = await restoreFiles(git, changes.before, filesToRestore, changes.after, {
          force: manualInMessage.length > 0,
        })
        if (!outcome.ok) {
          const rolledBack = await rollbackFiles(git, changes.after, filesToRestore, outcome)
          ctx.ui.notify(
            rolledBack
              ? "Undo failed: restored files do not match the snapshot; state rolled back"
              : "Undo failed: restored files do not match the snapshot, and the rollback also failed; the working tree can be inconsistent",
            "error",
          )
          return
        }
        didRestore = true
        skipped = outcome.skipped
        excluded = outcome.excluded
        manualSkipped = outcome.manualSkipped
      }
    }

    
    let result: { cancelled: boolean }
    try {
      result = await ctx.navigateTree(checkpoint.beforeLeafId, { summarize: false })
    } catch (error) {
      if (didRestore && outcome && changes) {
        const rolledBack = await rollbackFiles(deps.getGit(ctx), changes.after, filesToRestore, outcome)
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
      
      if (didRestore && outcome && changes) {
        const rolledBack = await rollbackFiles(deps.getGit(ctx), changes.after, filesToRestore, outcome)
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
    const restoredCount = filesToRestore.length - skipped.length - excluded.length - manualSkipped.length
    const filesNote = restoredCount > 0 ? `, restored ${restoredCount} file(s)` : ""
    ctx.ui.notify(`Undid message${filesNote}`, "info")
    if (skipped.length > 0) {
      ctx.ui.notify(
        `Note: ${skipped.length} file(s) not restored, a parent directory is a symlink: ${listPaths(skipped)}`,
        "warning",
      )
    }
    if (excluded.length > 0) {
      ctx.ui.notify(
        `Note: ${excluded.length} file(s) not restored, excluded by pi-undo.json: ${listPaths(excluded)}`,
        "warning",
      )
    }
    if (manualSkipped.length > 0) {
      ctx.ui.notify(
        `Note: ${manualSkipped.length} file(s) not restored, manual edits in gitignored files: ${listPaths(manualSkipped)}`,
        "warning",
      )
    }
    if (unknownDeclined.length > 0) {
      ctx.ui.notify(
        `Note: ${unknownDeclined.length} file(s) changed during the message but were not edited by this session; left alone: ${listPaths(unknownDeclined)}`,
        "warning",
      )
    }
    if (otherSession.length > 0) {
      ctx.ui.notify(
        `Note: ${otherSession.length} file(s) edited by other pi sessions, never restored: ${listPaths(otherSession)}`,
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

  const changes = snapshotChanges(checkpoint)
  let skipped: string[] = []
  let excluded: string[] = []
  let manualSkipped: string[] = []
  let filesToRestore: string[] = []
  let unknownDeclined: string[] = []
  let otherSession: string[] = []
  let outcome: RestoreOutcome | null = null
  let didRestore = false
  try {
    if (changes) {
      const git = deps.getGit(ctx)
      const dirty = await git.dirtySinceAll(changes.before)
      const messageFiles = new Set(checkpoint.files)
      const manualInMessage = [...dirty.manual, ...dirty.ignored].filter((file) => messageFiles.has(file))
      if (manualInMessage.length > 0) {
        const list = formatList(manualInMessage)
        const force = await ctx.ui.confirm(
          "Manual edits found",
          `These files were changed by the last message and have manual edits since:\n${list}\n\nRestore anyway and lose these edits?`,
        )
        if (!force) {
          ctx.ui.notify("Redo blocked: working tree has manual edits in files changed by the message", "warning")
          return
        }
      }

      const groups = await splitFiles(git, checkpoint, ctx.sessionManager.getSessionId())
      otherSession = groups.otherSession
      const editedSet = new Set(groups.editedFiles)

      const stats = await git.diffNumstat(changes.before, changes.after)
      const preview = formatNumstat(
        stats.rows.filter((row) => editedSet.has(row.file)),
        20,
        stats.binaryCount,
      )
      let message = `${preview}\n\nRestore files to the state after this message?`
      if (groups.unknownFiles.length > 0) {
        message += `\n\nAlso changed during the message, not by this session's file tools:\n${formatList(groups.unknownFiles)}`
      }
      if (otherSession.length > 0) {
        message += `\n\nEdited by other pi sessions, never restored:\n${formatList(otherSession)}`
      }
      const ok = await ctx.ui.confirm("Redo message", message)
      if (!ok) {
        ctx.ui.notify("Redo cancelled", "info")
        return
      }

      if (groups.unknownFiles.length > 0) {
        const restoreUnknown = await ctx.ui.confirm(
          "Unattributed changes",
          `These changed during the message but this session's file tools did not edit them. Restore them too?\n\n${formatList(groups.unknownFiles)}`,
        )
        if (restoreUnknown) {
          filesToRestore = [...groups.editedFiles, ...groups.unknownFiles]
        } else {
          filesToRestore = groups.editedFiles
          unknownDeclined = groups.unknownFiles
        }
      } else {
        filesToRestore = groups.editedFiles
      }

      if (filesToRestore.length > 0) {
        outcome = await restoreFiles(git, changes.after, filesToRestore, changes.before, {
          force: manualInMessage.length > 0,
        })
        if (!outcome.ok) {
          const rolledBack = await rollbackFiles(git, changes.before, filesToRestore, outcome)
          ctx.ui.notify(
            rolledBack
              ? "Redo failed: restored files do not match the snapshot; state rolled back"
              : "Redo failed: restored files do not match the snapshot, and the rollback also failed; the working tree can be inconsistent",
            "error",
          )
          return
        }
        didRestore = true
        skipped = outcome.skipped
        excluded = outcome.excluded
        manualSkipped = outcome.manualSkipped
      }
    }

    
    let result: { cancelled: boolean }
    try {
      result = await ctx.navigateTree(checkpoint.finalLeafId, { summarize: false })
    } catch (error) {
      if (didRestore && outcome && changes) {
        const rolledBack = await rollbackFiles(deps.getGit(ctx), changes.before, filesToRestore, outcome)
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
      if (didRestore && outcome && changes) {
        const rolledBack = await rollbackFiles(deps.getGit(ctx), changes.before, filesToRestore, outcome)
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
    const restoredCount = filesToRestore.length - skipped.length - excluded.length - manualSkipped.length
    const filesNote = restoredCount > 0 ? `, restored ${restoredCount} file(s)` : ""
    ctx.ui.notify(`Redid message${filesNote}`, "info")
    if (skipped.length > 0) {
      ctx.ui.notify(
        `Note: ${skipped.length} file(s) not restored, a parent directory is a symlink: ${listPaths(skipped)}`,
        "warning",
      )
    }
    if (excluded.length > 0) {
      ctx.ui.notify(
        `Note: ${excluded.length} file(s) not restored, excluded by pi-undo.json: ${listPaths(excluded)}`,
        "warning",
      )
    }
    if (manualSkipped.length > 0) {
      ctx.ui.notify(
        `Note: ${manualSkipped.length} file(s) not restored, manual edits in gitignored files: ${listPaths(manualSkipped)}`,
        "warning",
      )
    }
    if (unknownDeclined.length > 0) {
      ctx.ui.notify(
        `Note: ${unknownDeclined.length} file(s) changed during the message but were not edited by this session; left alone: ${listPaths(unknownDeclined)}`,
        "warning",
      )
    }
    if (otherSession.length > 0) {
      ctx.ui.notify(
        `Note: ${otherSession.length} file(s) edited by other pi sessions, never restored: ${listPaths(otherSession)}`,
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
  const changes = snapshotChanges(checkpoint)
  if (!changes) {
    ctx.ui.notify("The last message changed no files", "info")
    return
  }
  try {
    const git = deps.getGit(ctx)
    const stats = await git.diffNumstat(changes.before, changes.after)
    const unattributed = checkpoint.unattributed ?? []
    const unattributedSet = new Set(unattributed)
    let message = `Changes made by the last message (what /undo restores):\n\n${formatNumstat(
      stats.rows.filter((row) => !unattributedSet.has(row.file)),
      20,
      stats.binaryCount,
    )}`
    if (unattributed.length > 0) {
      let attributed = new Map<string, string[]>()
      try {
        attributed = await attributeTouches(git.storeDir, ctx.sessionManager.getSessionId(), unattributed)
      } catch {
        attributed = new Map()
      }
      const lines = unattributed.map((file) => {
        const sessions = attributed.get(file)
        return sessions && sessions.length > 0 ? `${file} (session ${sessions.join(", ")})` : file
      })
      message += `\n\nChanged during the message by other sources (not restored by /undo):\n${lines.join("\n")}`
    }
    ctx.ui.notify(message, "info")
  } catch (error) {
    ctx.ui.notify(`Preview failed: ${errorMessage(error)}`, "error")
  }
}
