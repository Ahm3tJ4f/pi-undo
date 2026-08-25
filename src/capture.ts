import type { ExtensionAPI, ExtensionContext, ExtensionUIContext, SessionEntry } from "@earendil-works/pi-coding-agent"
import path from "node:path"
import { canonicalizePath, type SnapshotRepo } from "./git.ts"
import * as journal from "./journal.ts"
import type { CheckpointStore } from "./store.ts"
import type { UserMessageEntry } from "./types.ts"
import { isUserMessageEntry } from "./types.ts"
import { errorMessage } from "./util.ts"

/**
 * How long a hook handler or an undo command waits for an in-flight pre-turn
 * capture before giving control back. A capture that overruns the deadline
 * keeps running in the background and finalizes on its own when it settles,
 * identity-bound to its own turn — so a huge first-ever capture over a big
 * workspace can never wedge the agent loop or stack overlapping git runs.
 *
 * Ported from omp-undo-redo#54 ("non-blocking begin/complete").
 */
export const DEFAULT_CAPTURE_DEADLINE_MS = 3_000

export interface CaptureDeps {
  getGit(ctx: {
    cwd: string
    ui: Pick<ExtensionUIContext, "notify">
    isProjectTrusted: () => boolean
  }): SnapshotRepo
  captureDeadlineMs?: number
  /** Wired up by index.ts from the capture controller: bounded wait for an
   *  in-flight pre-turn capture. The undo/redo/diff commands refuse with a
   *  warning while one is churning instead of blocking indefinitely. */
  waitForCapture?(cwd: string): Promise<{ settled: boolean }>
}

/** One pre-turn capture in flight: `complete` resolves once the tree is
 *  written or failed; `tree` resolves to it (or rejects). */
interface PendingCapture {
  complete: Promise<void>
  tree: Promise<string | undefined>
}

export interface CaptureController {
  /** Bounded wait used by /undo, /redo and /diff so a command never blocks
   *  behind a huge first capture longer than the deadline. */
  waitForPending(cwd: string): Promise<{ settled: boolean }>
}

export interface ActiveTurn {
  prompt: string
  imageCount: number
  userEntryId: string | null
  beforeLeafId: string | null
  /** The pre-turn capture for this turn, when one could begin. Null when a
   *  previous turn's capture was still churning (session-only boundary). */
  beforeCapture: PendingCapture | null
  touched: Map<string, number>
  startAt: number
}

function beginCapture(
  task: () => Promise<string | undefined>,
  cwd: string,
  pendingByCwd: Map<string, PendingCapture>,
): PendingCapture {
  let resolveComplete!: () => void
  const complete = new Promise<void>((resolve) => {
    resolveComplete = resolve
  })
  const tree = task().then(
    (value) => {
      pendingByCwd.delete(cwd)
      resolveComplete()
      return value
    },
    (error) => {
      pendingByCwd.delete(cwd)
      resolveComplete()
      throw error
    },
  )
  // Nobody is awaiting this tree yet while the turn starts up; keep an early
  // rejection here from crashing the process before finalize consumes it.
  void tree.catch(() => {})
  const pending = { complete, tree }
  // Register synchronously so a turn starting in the same tick already
  // sees the churn and skips its own capture instead of stacking a second
  // `git add` over the same workspace.
  pendingByCwd.set(cwd, pending)
  return pending
}

async function withDeadline(promise: Promise<void>, ms: number): Promise<"settled" | "timed-out"> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve("timed-out"), ms)
    void promise.then(
      () => {
        clearTimeout(timer)
        resolve("settled")
      },
      () => {
        clearTimeout(timer)
        resolve("settled")
      },
    )
  })
}

export function setupCapture(
  pi: Pick<ExtensionAPI, "on">,
  store: CheckpointStore,
  deps: CaptureDeps,
): CaptureController {
  let active: ActiveTurn | null = null
  // At most one capture churn per canonical workspace at any time.
  const pendingByCwd = new Map<string, PendingCapture>()
  const deadlineMs = () => deps.captureDeadlineMs ?? DEFAULT_CAPTURE_DEADLINE_MS

  function freshTurn(prompt: string, imageCount: number, pending: PendingCapture | null): ActiveTurn {
    return {
      prompt,
      imageCount,
      userEntryId: null,
      beforeLeafId: null,
      beforeCapture: pending,
      touched: new Map(),
      startAt: Date.now(),
    }
  }

  pi.on("before_agent_start", async (event, ctx) => {
    store.clearRevert()
    if (active) await finalize(ctx)

    // The capture begins without awaiting it: the handler returns within
    // its budget even when the pre-turn snapshot needs minutes (huge
    // first-ever capture over a big workspace).
    // Key by the canonical spelling so a client-supplied non-canonical cwd
    // (RPC mode) cannot fork the churn map or miss a pending capture.
    const cwdKey = canonicalizePath(ctx.cwd)
    const existing = pendingByCwd.get(cwdKey)
    if (existing) {
      active = freshTurn(event.prompt, event.images?.length ?? 0, null)
      return
    }
    try {
      const git = deps.getGit(ctx)
      active = freshTurn(event.prompt, event.images?.length ?? 0, beginCapture(() => git.track(), cwdKey, pendingByCwd))
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

  // Record the paths this session's write/edit tools touch, with the time of
  // the first touch. The built-in `write` and `edit` tools take a `path`
  // field. Bash can change files too, but we cannot see which files it
  // writes, so those changes stay unattributed.
  pi.on("tool_call", (event, ctx) => {
    if (!active) return
    if (event.toolName !== "write" && event.toolName !== "edit") return
    const input = event.input as unknown as { path?: unknown }
    const p = input.path
    if (typeof p !== "string") return
    const abs = path.isAbsolute(p) ? p : path.resolve(ctx.cwd, p)
    const rel = path.relative(ctx.cwd, abs)
    if (rel.startsWith("..") || path.isAbsolute(rel)) return
    const normalized = rel.replaceAll("\\", "/")
    if (normalized === "" || normalized === ".") return
    if (!active.touched.has(normalized)) active.touched.set(normalized, Date.now())
  })

  async function finalize(ctx: ExtensionContext): Promise<void> {
    const turn = active
    active = null
    if (!turn || !turn.userEntryId) return

    const pending = turn.beforeCapture
    if (!pending) return

    // Leaf identity is fixed at the moment settle happens — not whenever a
    // slow capture finally lands.
    const finalLeafId = ctx.sessionManager.getLeafId() ?? turn.userEntryId

    const outcome = await withDeadline(pending.complete, deadlineMs())
    if (outcome === "timed-out") {
      // The handler budget is spent; the capture keeps running. Finalize
      // THIS turn identity-bound (same context, same leaf ids) when it
      // settles instead of letting a later turn consume the checkpoint.
      void pending.complete.then(
        () => void finishTurn(turn, pending, finalLeafId, ctx).catch(() => {}),
        () => void finishTurn(turn, pending, finalLeafId, ctx).catch(() => {}),
      )
      return
    }
    await finishTurn(turn, pending, finalLeafId, ctx)
  }

  async function finishTurn(
    turn: ActiveTurn,
    pending: PendingCapture,
    finalLeafId: string,
    ctx: ExtensionContext,
  ): Promise<void> {
    let beforeSnapshot: string | undefined
    try {
      beforeSnapshot = await pending.tree
    } catch (error) {
      ctx.ui.notify(
        `pi-undo: pre-turn snapshot failed, undo disabled for this message: ${errorMessage(error)}`,
        "warning",
      )
      return
    }
    if (!turn || !turn.userEntryId || !beforeSnapshot) return

      // This AFTER track can serialize against a next turn's BEFORE track
      // via the shadow index.lock when a deferred finalize lands late. Git
      // handles that safely; only latency is shared.
    try {
      const git = deps.getGit(ctx)
      const afterSnapshot = await git.track()
      if (!afterSnapshot) return
      const files = await git.changedFiles(beforeSnapshot, afterSnapshot)
      const unattributed = files.filter((file) => !turn.touched.has(file))
      const createdAt = Date.now()
      try {
        const entries = [...turn.touched.entries()].map(([p, t]) => ({ p, t }))
        await journal.appendTouches(git.storeDir, ctx.sessionManager.getSessionId(), entries)
      } catch {
        // Journal is best effort.
      }
      store.add({
        userEntryId: turn.userEntryId,
        beforeLeafId: turn.beforeLeafId,
        finalLeafId,
        prompt: turn.prompt,
        imageCount: turn.imageCount,
        beforeSnapshot: files.length > 0 ? beforeSnapshot : null,
        afterSnapshot: files.length > 0 ? afterSnapshot : null,
        files,
        unattributed,
        startedAt: turn.startAt,
        createdAt,
      })
    } catch (error) {
      ctx.ui.notify(`pi-undo: checkpoint finalize failed: ${errorMessage(error)}`, "warning")
    }
  }

  const controller: CaptureController = {
    waitForPending: async (cwd) => {
      const pending = pendingByCwd.get(canonicalizePath(cwd))
      if (!pending) return { settled: true }
      const outcome = await withDeadline(pending.complete, deadlineMs())
      return { settled: outcome !== "timed-out" }
    },
  }
  return controller
}

function findLatestUserEntry(branch: SessionEntry[]): UserMessageEntry | undefined {
  for (let i = branch.length - 1; i >= 0; i--) {
    const entry = branch[i]
    if (entry && isUserMessageEntry(entry)) return entry
  }
  return undefined
}
