import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { registerCommands, type CommandDeps } from "./commands.ts"
import { loadPiUndoConfig } from "./config.ts"
import { ShadowGit } from "./git.ts"
import { CheckpointStore } from "./store.ts"
import { TurnTracker, type RepoProvider } from "./tracker.ts"
import { errorMessage } from "./util.ts"

export default function piUndo(pi: ExtensionAPI): void {
  const store = new CheckpointStore(pi)
  let repo: ShadowGit | undefined

  // One shadow repo per working directory, reused across calls. Warnings go
  // to the UI of the latest caller.
  const repoFor: RepoProvider = (ctx) => {
    const warn = (message: string) => ctx.ui.notify(message, "warning")
    if (repo?.cwd === ctx.cwd) {
      repo.setWarn(warn)
      return repo
    }
    repo = new ShadowGit({ cwd: ctx.cwd, config: loadPiUndoConfig(), warn })
    return repo
  }

  const tracker = new TurnTracker(store, repoFor)
  const deps: CommandDeps = { store, tracker, repoFor, navigation: { active: false } }

  pi.on("session_start", async (_event, ctx) => {
    tracker.reset()
    store.load(ctx.sessionManager.getEntries())
    const current = repoFor(ctx)
    try {
      await current.ensure()
    } catch (error) {
      ctx.ui.notify(`pi-undo: snapshot store unavailable: ${errorMessage(error)}`, "warning")
      return
    }
    // Daily maintenance. Not awaited: it must not delay the session.
    current.gcIfDue().catch(() => {})
  })

  pi.on("session_shutdown", () => {
    tracker.reset()
    repo = undefined
  })

  pi.on("before_agent_start", async (event, ctx) => {
    // A new prompt means the previous run is over, even if its
    // agent_settled never arrived.
    await tracker.flush(ctx)
    tracker.notePrompt(event.prompt, event.images?.length ?? 0)
  })

  pi.on("agent_start", (_event, ctx) => tracker.start(ctx))

  pi.on("agent_settled", (_event, ctx) => tracker.finish(ctx))

  // A jump in the tree by the user (for example /tree) leaves the undone
  // messages behind, so the redo stack no longer applies.
  pi.on("session_tree", () => {
    if (!deps.navigation.active) store.clearReverted()
  })

  registerCommands(pi, deps)
}
