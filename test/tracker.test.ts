import assert from "node:assert/strict"
import { test } from "node:test"
import { CheckpointStore } from "../src/store.ts"
import { findRunStart, type TrackerContext, TurnTracker } from "../src/tracker.ts"
import { assistantEntry, entry, FakeRepo, type FakeSession, fakeSession, userEntry } from "./fakes.ts"

function setup(initial = [entry("m0", "model_change")]) {
  const repo = new FakeRepo()
  const appended: { type: string; data: unknown }[] = []
  const store = new CheckpointStore({ appendEntry: (type, data) => void appended.push({ type, data }) })
  const tracker = new TurnTracker(store, () => repo)
  const session = fakeSession(initial)
  const notifications: string[] = []
  let idle = true
  const ctx: TrackerContext = {
    cwd: "/project",
    ui: { notify: (message) => void notifications.push(message) },
    isIdle: () => idle,
    sessionManager: session,
  }
  const setIdle = (value: boolean) => {
    idle = value
  }
  return { repo, store, tracker, session, ctx, notifications, appended, setIdle }
}

// Simulates one agent run that writes `files` and adds a user message.
async function runTurn(
  h: ReturnType<typeof setup>,
  id: string,
  files: Record<string, string> = {},
  session: FakeSession = h.session,
): Promise<void> {
  h.tracker.notePrompt(`prompt ${id}`, 0)
  h.setIdle(false)
  await h.tracker.start(h.ctx)
  session.append(entry(`sys-${id}`, "message"))
  session.append(userEntry(id))
  for (const [file, content] of Object.entries(files)) h.repo.worktree.set(file, content)
  session.append(assistantEntry(`a-${id}`))
  h.setIdle(true)
  await h.tracker.finish(h.ctx)
}

test("tracker: one run gives one checkpoint keyed by its user message", async () => {
  const h = setup()
  await runTurn(h, "u1", { "a.txt": "x" })
  const checkpoint = h.store.get("u1")
  assert.ok(checkpoint)
  assert.equal(checkpoint.finalLeafId, "a-u1")
  assert.equal(checkpoint.prompt, "prompt u1")
  assert.deepEqual(checkpoint.snapshot?.files, ["a.txt"])
  assert.deepEqual(h.repo.protected, [checkpoint.snapshot?.before, checkpoint.snapshot?.after])
  assert.equal(checkpoint.unavailable, undefined)
})

test("tracker: a run that changes no files records a conversation-only checkpoint", async () => {
  const h = setup()
  await runTurn(h, "u1")
  const checkpoint = h.store.get("u1")
  assert.ok(checkpoint)
  assert.equal(checkpoint.snapshot, null)
  assert.deepEqual(h.repo.protected, [])
})

test("tracker: a run started by a custom message is keyed by that message", async () => {
  const h = setup()
  h.setIdle(false)
  await h.tracker.start(h.ctx)
  h.session.append(entry("c1", "custom_message"))
  h.repo.worktree.set("a.txt", "x")
  h.session.append(assistantEntry("a1"))
  h.setIdle(true)
  await h.tracker.finish(h.ctx)
  const checkpoint = h.store.get("c1")
  assert.ok(checkpoint)
  assert.equal(checkpoint.prompt, "")
})

test("tracker: a steering message during the run does not start a new checkpoint", async () => {
  const h = setup()
  h.setIdle(false)
  await h.tracker.start(h.ctx)
  h.session.append(userEntry("u1"))
  h.session.append(assistantEntry("a1"))
  h.session.append(userEntry("steer"))
  // A retry inside the same run fires agent_start again.
  await h.tracker.start(h.ctx)
  h.session.append(assistantEntry("a2"))
  h.setIdle(true)
  await h.tracker.finish(h.ctx)
  assert.ok(h.store.get("u1"))
  assert.equal(h.store.get("steer"), undefined)
  assert.equal(h.repo.calls.filter((call) => call === "track").length, 2)
})

test("tracker: a skipped snapshot records why file undo is unavailable", async () => {
  const h = setup()
  h.repo.skipTrack = true
  await runTurn(h, "u1", { "a.txt": "x" })
  const checkpoint = h.store.get("u1")
  assert.ok(checkpoint)
  assert.equal(checkpoint.snapshot, null)
  assert.match(checkpoint.unavailable ?? "", /maxFiles/)
})

test("tracker: a failing snapshot warns and records the reason", async () => {
  const h = setup()
  h.repo.failTrack = new Error("git timed out")
  await runTurn(h, "u1")
  assert.match(h.store.get("u1")?.unavailable ?? "", /git timed out/)
  assert.ok(h.notifications.some((message) => /git timed out/.test(message)))
})

test("tracker: a run that left the branch records nothing", async () => {
  const h = setup()
  h.setIdle(false)
  await h.tracker.start(h.ctx)
  // Something moved the session to an unrelated branch.
  h.session.branch.splice(0, h.session.branch.length, entry("x0", "model_change"), userEntry("x1"))
  h.setIdle(true)
  await h.tracker.finish(h.ctx)
  assert.equal(h.store.latestOnBranch(h.session.branch), undefined)
})

test("tracker: a new run clears the redo stack", async () => {
  const h = setup()
  await runTurn(h, "u1")
  h.store.pushReverted(h.store.get("u1")!)
  await runTurn(h, "u2")
  assert.equal(h.store.peekReverted(), undefined)
})

// Regression: pi marks the session idle before it runs the agent_settled
// handlers. A command in that gap used to miss the newest checkpoint and
// undo the message before it.
test("tracker: flush records a finished run whose agent_settled has not run yet", async () => {
  const h = setup()
  await runTurn(h, "u1")
  h.tracker.notePrompt("second", 0)
  h.setIdle(false)
  await h.tracker.start(h.ctx)
  h.session.append(userEntry("u2"))
  h.repo.worktree.set("b.txt", "x")
  h.setIdle(true)

  await h.tracker.flush(h.ctx)
  assert.equal(h.store.latestOnBranch(h.session.branch)?.entryId, "u2")
  // The late agent_settled is a no-op.
  await h.tracker.finish(h.ctx)
  assert.equal(h.appended.filter((item) => item.type === "pi-undo/checkpoint").length, 2)
})

test("tracker: flush does not end a run that is still going", async () => {
  const h = setup()
  h.setIdle(false)
  await h.tracker.start(h.ctx)
  h.session.append(userEntry("u1"))
  await h.tracker.flush(h.ctx)
  assert.equal(h.store.get("u1"), undefined)
})

test("tracker: a run whose agent_settled never came is recorded before the next prompt", async () => {
  const h = setup()
  h.setIdle(false)
  await h.tracker.start(h.ctx)
  h.session.append(userEntry("u1"))
  h.repo.worktree.set("a.txt", "x")
  h.setIdle(true)
  // No agent_settled. The next prompt flushes before it is noted.
  await h.tracker.flush(h.ctx)
  await runTurn(h, "u2", { "b.txt": "y" })
  assert.deepEqual(h.store.get("u1")?.snapshot?.files, ["a.txt"])
  assert.deepEqual(h.store.get("u2")?.snapshot?.files, ["b.txt"])
})

test("findRunStart: first user or custom message after the start leaf", () => {
  const branch = [
    entry("m0", "model_change"),
    userEntry("u0"),
    assistantEntry("a0"),
    entry("sys", "message"),
    userEntry("u1"),
    userEntry("u2"),
  ]
  assert.equal(findRunStart(branch, "a0"), "u1")
  assert.equal(findRunStart(branch, null), "u0")
  assert.equal(findRunStart(branch, "u2"), undefined)
  assert.equal(findRunStart(branch, "missing"), undefined)
})
