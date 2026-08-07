import type { ExtensionAPI, ExtensionContext, ExtensionUIContext, SessionEntry } from "@earendil-works/pi-coding-agent"
import type { SnapshotRepo } from "./git.ts"
import type { CheckpointStore } from "./store.ts"
import type { ActiveTurn, UserMessageEntry } from "./types.ts"
import { isUserMessageEntry } from "./types.ts"
import { errorMessage } from "./util.ts"

export interface CaptureDeps {
  getGit(ctx: {
    cwd: string
    ui: Pick<ExtensionUIContext, "notify">
    isProjectTrusted: () => boolean
  }): SnapshotRepo
}

export function setupCapture(pi: Pick<ExtensionAPI, "on">, store: CheckpointStore, deps: CaptureDeps): void {
  let active: ActiveTurn | null = null

  pi.on("before_agent_start", async (event, ctx) => {
    
    store.clearRevert()
    
    if (active) await finalize(ctx)

    try {
      const git = deps.getGit(ctx)
      const beforeSnapshot = await git.track()
      active = {
        prompt: event.prompt,
        imageCount: event.images?.length ?? 0,
        userEntryId: null,
        beforeLeafId: null,
        beforeSnapshot: beforeSnapshot ?? null,
      }
    } catch (error) {
      active = null
      ctx.ui.notify(`pi-undo: pre-turn snapshot failed, undo disabled for this message: ${errorMessage(error)}`, "warning")
    }
  })

  pi.on("message_start", (event, ctx) => {
    if (!active || active.userEntryId !== null) return
    if (event.message.role !== "assistant") return
    
    const userEntry = findLatestUserEntry(ctx.sessionManager.getBranch())
    if (!userEntry) return
    active.userEntryId = userEntry.id
    active.beforeLeafId = userEntry.parentId
  })

  pi.on("agent_settled", async (_event, ctx) => {
    if (!active) return
    await finalize(ctx)
  })

  async function finalize(ctx: ExtensionContext): Promise<void> {
    const turn = active
    active = null
    if (!turn || !turn.userEntryId || !turn.beforeSnapshot) return
    try {
      const git = deps.getGit(ctx)
      const afterSnapshot = await git.track()
      if (!afterSnapshot) return
      const files = await git.changedFiles(turn.beforeSnapshot, afterSnapshot)
      store.add({
        userEntryId: turn.userEntryId,
        beforeLeafId: turn.beforeLeafId,
        finalLeafId: ctx.sessionManager.getLeafId() ?? turn.userEntryId,
        prompt: turn.prompt,
        imageCount: turn.imageCount,
        
        
        beforeSnapshot: files.length > 0 ? turn.beforeSnapshot : null,
        afterSnapshot: files.length > 0 ? afterSnapshot : null,
        files,
        createdAt: Date.now(),
      })
    } catch (error) {
      ctx.ui.notify(`pi-undo: checkpoint finalize failed: ${errorMessage(error)}`, "warning")
    }
  }
}

function findLatestUserEntry(branch: SessionEntry[]): UserMessageEntry | undefined {
  for (let i = branch.length - 1; i >= 0; i--) {
    const entry = branch[i]
    if (entry && isUserMessageEntry(entry)) return entry
  }
  return undefined
}
