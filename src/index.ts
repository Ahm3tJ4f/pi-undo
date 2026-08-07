import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { setupCapture, type CaptureDeps } from "./capture.ts"
import { registerCommands } from "./commands.ts"
import { loadPiUndoConfig } from "./config.ts"
import { ShadowGit } from "./git.ts"
import { CheckpointStore } from "./store.ts"
import { errorMessage } from "./util.ts"

export default function (pi: ExtensionAPI): void {
  const store = new CheckpointStore(pi)
  let git: ShadowGit | undefined

  const deps: CaptureDeps = {
    getGit(ctx) {
      const notify = (message: string) => ctx.ui.notify(message, "warning")
      if (!git || git.cwd !== ctx.cwd) {
        git = new ShadowGit(pi, ctx.cwd, notify, loadPiUndoConfig(ctx.cwd, ctx.isProjectTrusted()))
      } else {
        git.setWarn(notify)
      }
      return git
    },
  }

  pi.on("session_start", async (_event, ctx) => {
    store.load(ctx.sessionManager)
    const snap = deps.getGit(ctx)
    try {
      await snap.ensure()
      await snap.gcIfDue()
    } catch (error) {
      ctx.ui.notify(`pi-undo: snapshot store unavailable: ${errorMessage(error)}`, "warning")
    }
  })

  pi.on("session_shutdown", () => {
    git = undefined
  })

  setupCapture(pi, store, deps)
  registerCommands(pi, store, deps)
}
