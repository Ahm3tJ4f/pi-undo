import assert from "node:assert/strict"
import { test } from "node:test"
import { type CommandContext, type CommandDeps, diff, redo, undo } from "../src/commands.ts"
import { CheckpointStore } from "../src/store.ts"
import { TurnTracker } from "../src/tracker.ts"
import type { Checkpoint } from "../src/types.ts"
import { assistantEntry, entry, FakeRepo, fakeSession, fakeUi, userEntry } from "./fakes.ts"

interface Options {
  hasUI?: boolean
  navigate?: (target: string) => Promise<{ cancelled: boolean }>
}

// A session with one finished message "u1" that changed a.txt from "old" to
// "new", unless `files` says otherwise.
function setup(options: Options = {}) {
  const repo = new FakeRepo()
  const store = new CheckpointStore({ appendEntry: () => {} })
  const tracker = new TurnTracker(store, () => repo)
  const deps: CommandDeps = { store, tracker, repoFor: () => repo, navigation: { active: false } }
  const session = fakeSession([entry("m0", "model_change"), userEntry("u1"), assistantEntry("a1")])
  const ui = fakeUi()
  const navigations: string[] = []
  let idle = true
  const ctx: CommandContext = {
    cwd: "/project",
    hasUI: options.hasUI ?? true,
    ui,
    isIdle: () => idle,
    abort: () => {
      idle = true
    },
    waitForIdle: async () => {},
    sessionManager: session,
    navigateTree: async (target) => {
      navigations.push(target)
      assert.equal(deps.navigation.active, true, "navigation flag is set while navigating")
      return options.navigate ? options.navigate(target) : { cancelled: false }
    },
  }
  const setIdle = (value: boolean) => {
    idle = value
  }
  return { repo, store, deps, session, ui, ctx, navigations, setIdle }
}

type Harness = ReturnType<typeof setup>

function addCheckpoint(
  h: Harness,
  before: Record<string, string>,
  after: Record<string, string>,
  extra: Partial<Checkpoint> = {},
) {
  const beforeTree = h.repo.store(new Map(Object.entries(before)))
  const afterTree = h.repo.store(new Map(Object.entries(after)))
  for (const [file, content] of Object.entries(after)) h.repo.worktree.set(file, content)
  const files = [...new Set([...Object.keys(before), ...Object.keys(after)])].filter((f) => before[f] !== after[f])
  const checkpoint: Checkpoint = {
    entryId: "u1",
    finalLeafId: "a1",
    prompt: "fix the bug",
    imageCount: 0,
    snapshot: files.length > 0 ? { before: beforeTree, after: afterTree, files } : null,
    createdAt: 1,
    ...extra,
  }
  h.store.add(checkpoint)
  return checkpoint
}

const messages = (h: Harness) => h.ui.notifications.map((n) => n.message)

test("undo: nothing to undo", async () => {
  const h = setup()
  await undo(h.deps, h.ctx)
  assert.deepEqual(messages(h), ["Nothing to undo"])
  assert.deepEqual(h.navigations, [])
})

test("undo: restores every changed file and navigates to the message", async () => {
  const h = setup()
  addCheckpoint(h, { "a.txt": "old", "gone.txt": "keep" }, { "a.txt": "new", "made.txt": "x" })
  await undo(h.deps, h.ctx)
  assert.deepEqual(Object.fromEntries(h.repo.worktree), { "a.txt": "old", "gone.txt": "keep" })
  assert.deepEqual(h.navigations, ["u1"])
  assert.equal(h.ui.confirms.length, 1)
  assert.match(h.ui.confirms[0]!.message, /Restore 3 file\(s\) to their state before this message/)
  assert.equal(messages(h)[0], "Undid message, restored 3 file(s)")
  assert.equal(h.store.peekReverted()?.entryId, "u1")
  assert.equal(h.ui.editor, "fix the bug")
})

test("undo: never replaces a draft in the editor", async () => {
  const h = setup()
  addCheckpoint(h, { "a.txt": "old" }, { "a.txt": "new" })
  h.ui.editor = "my draft"
  await undo(h.deps, h.ctx)
  assert.equal(h.ui.editor, "my draft")
})

test("undo: a conversation-only message needs no dialog", async () => {
  const h = setup()
  addCheckpoint(h, {}, {})
  await undo(h.deps, h.ctx)
  assert.deepEqual(h.ui.confirms, [])
  assert.deepEqual(h.navigations, ["u1"])
  assert.deepEqual(messages(h), ["Undid message"])
})

test("undo: declining the dialog changes nothing", async () => {
  const h = setup()
  addCheckpoint(h, { "a.txt": "old" }, { "a.txt": "new" })
  h.ui.answers = [false]
  await undo(h.deps, h.ctx)
  assert.equal(h.repo.worktree.get("a.txt"), "new")
  assert.deepEqual(h.navigations, [])
  assert.deepEqual(messages(h), ["Undo cancelled"])
  assert.equal(h.store.peekReverted(), undefined)
})

test("undo: manual edits are named in the one dialog and overwritten on confirm", async () => {
  const h = setup()
  addCheckpoint(h, { "a.txt": "old", "b.txt": "old" }, { "a.txt": "new", "b.txt": "new" })
  h.repo.worktree.set("a.txt", "edited by hand")
  h.repo.worktree.set("other.txt", "edited by hand")
  await undo(h.deps, h.ctx)
  assert.equal(h.ui.confirms.length, 1)
  assert.match(h.ui.confirms[0]!.message, /These changes will be lost:\na\.txt$/m)
  assert.doesNotMatch(h.ui.confirms[0]!.message, /other\.txt/)
  assert.equal(h.repo.worktree.get("a.txt"), "old")
  assert.equal(h.repo.worktree.get("other.txt"), "edited by hand")
})

test("undo: without a UI, manual edits block instead of being overwritten", async () => {
  const h = setup({ hasUI: false })
  addCheckpoint(h, { "a.txt": "old" }, { "a.txt": "new" })
  h.repo.worktree.set("a.txt", "edited by hand")
  await undo(h.deps, h.ctx)
  assert.equal(h.repo.worktree.get("a.txt"), "edited by hand")
  assert.match(messages(h)[0]!, /Undo failed: files were changed after the message: a\.txt/)
})

test("undo: excluded files are reported, not restored", async () => {
  const h = setup()
  addCheckpoint(h, { "a.txt": "old", "x.log": "old" }, { "a.txt": "new", "x.log": "new" })
  h.repo.excluded.add("x.log")
  await undo(h.deps, h.ctx)
  assert.match(h.ui.confirms[0]!.message, /Not restored, excluded by pi-undo\.json:\nx\.log/)
  assert.equal(h.repo.worktree.get("x.log"), "new")
  assert.equal(messages(h)[0], "Undid message, restored 1 file(s)")
  assert.match(messages(h)[1]!, /1 file\(s\) not restored, excluded by pi-undo\.json: x\.log/)
})

test("undo: a failed restore is rolled back and the conversation stays", async () => {
  const h = setup()
  addCheckpoint(h, { "a.txt": "old" }, { "a.txt": "new" })
  let first = true
  h.repo.failRestore = () => {
    if (!first) return undefined
    first = false
    return new Error("disk full")
  }
  await undo(h.deps, h.ctx)
  assert.equal(h.repo.worktree.get("a.txt"), "new")
  assert.deepEqual(h.navigations, [])
  assert.match(messages(h)[0]!, /Undo failed, the files are unchanged: disk full/)
})

test("undo: when the rollback fails too, the files to check are named", async () => {
  const h = setup()
  addCheckpoint(h, { "a.txt": "old" }, { "a.txt": "new" })
  h.repo.failRestore = () => new Error("disk full")
  await undo(h.deps, h.ctx)
  assert.match(messages(h)[0]!, /putting the files back failed too .*Check: a\.txt/)
})

test("undo: a cancelled navigation puts the files back", async () => {
  const h = setup({ navigate: async () => ({ cancelled: true }) })
  addCheckpoint(h, { "a.txt": "old" }, { "a.txt": "new" })
  await undo(h.deps, h.ctx)
  assert.equal(h.repo.worktree.get("a.txt"), "new")
  assert.deepEqual(messages(h), ["Undo cancelled"])
  assert.equal(h.store.peekReverted(), undefined)
})

test("undo: a navigation error puts the files back and keeps manual edits", async () => {
  const h = setup({
    navigate: async () => {
      throw new Error("entry not found")
    },
  })
  addCheckpoint(h, { "a.txt": "old", "b.txt": "old" }, { "a.txt": "new", "b.txt": "new" })
  h.repo.worktree.set("b.txt", "edited by hand")
  await undo(h.deps, h.ctx)
  assert.equal(h.repo.worktree.get("a.txt"), "new")
  assert.equal(h.repo.worktree.get("b.txt"), "edited by hand")
  assert.match(messages(h)[0]!, /Undo failed: entry not found/)
})

test("undo: missing snapshots offer a conversation-only undo", async () => {
  const h = setup()
  const checkpoint = addCheckpoint(h, { "a.txt": "old" }, { "a.txt": "new" })
  h.repo.trees.delete(checkpoint.snapshot!.before)
  await undo(h.deps, h.ctx)
  assert.match(h.ui.confirms[0]!.message, /snapshots of this message are gone/)
  assert.deepEqual(h.navigations, ["u1"])
  assert.equal(h.repo.worktree.get("a.txt"), "new")
  assert.match(messages(h)[1]!, /Files were not restored/)
})

test("undo: a message without a snapshot says why before undoing the conversation", async () => {
  const h = setup()
  addCheckpoint(h, {}, {}, { unavailable: "the snapshot failed: git timed out" })
  h.ui.answers = [false]
  await undo(h.deps, h.ctx)
  assert.match(h.ui.confirms[0]!.message, /no file snapshot: the snapshot failed: git timed out/)
  assert.deepEqual(h.navigations, [])
})

test("undo: stops a running agent and records its run first", async () => {
  const h = setup()
  h.setIdle(false)
  await h.deps.tracker.start(h.ctx)
  h.session.append(userEntry("u2"))
  h.repo.worktree.set("b.txt", "x")
  h.session.append(assistantEntry("a2"))
  // abort() makes the session idle, but agent_settled has not run yet.
  await undo(h.deps, h.ctx)
  assert.deepEqual(h.navigations, ["u2"])
  assert.equal(h.repo.worktree.has("b.txt"), false)
})

test("undo: warns that image attachments are not restored", async () => {
  const h = setup()
  addCheckpoint(h, {}, {}, { imageCount: 2 })
  await undo(h.deps, h.ctx)
  assert.match(messages(h)[1]!, /2 image attachment/)
})

test("redo: re-applies the files, navigates forward and pops the stack", async () => {
  const h = setup()
  addCheckpoint(h, { "a.txt": "old" }, { "a.txt": "new" })
  await undo(h.deps, h.ctx)
  h.ui.notifications.length = 0
  await redo(h.deps, h.ctx)
  assert.equal(h.repo.worktree.get("a.txt"), "new")
  assert.deepEqual(h.navigations, ["u1", "a1"])
  assert.match(h.ui.confirms[1]!.message, /state after this message/)
  assert.equal(messages(h)[0], "Redid message, restored 1 file(s)")
  assert.equal(h.store.peekReverted(), undefined)
  assert.equal(h.ui.editor, "", "the restored prompt is cleared again")
})

test("redo: nothing to redo", async () => {
  const h = setup()
  await redo(h.deps, h.ctx)
  assert.deepEqual(messages(h), ["Nothing to redo"])
})

test("redo: a manual edit after the undo is named in the dialog", async () => {
  const h = setup()
  addCheckpoint(h, { "a.txt": "old" }, { "a.txt": "new" })
  await undo(h.deps, h.ctx)
  h.repo.worktree.set("a.txt", "edited by hand")
  h.ui.answers = [false]
  await redo(h.deps, h.ctx)
  assert.match(h.ui.confirms[1]!.message, /These changes will be lost:\na\.txt/)
  assert.equal(h.repo.worktree.get("a.txt"), "edited by hand")
  assert.equal(h.store.peekReverted()?.entryId, "u1")
})

test("diff: shows the changes and the manual edits", async () => {
  const h = setup()
  addCheckpoint(h, { "a.txt": "old", "b.txt": "old" }, { "a.txt": "new", "b.txt": "new" })
  h.repo.worktree.set("b.txt", "edited by hand")
  await diff(h.deps, h.ctx)
  const text = messages(h)[0]!
  assert.match(text, /what \/undo rolls back/)
  assert.match(text, /a\.txt {2}\+1\/-1/)
  assert.match(text, /These changes will be lost:\nb\.txt/)
  assert.equal(h.repo.worktree.get("b.txt"), "edited by hand", "diff changes nothing")
})

test("diff: never stops a running agent", async () => {
  const h = setup()
  addCheckpoint(h, { "a.txt": "old" }, { "a.txt": "new" })
  let aborted = false
  h.ctx.abort = () => {
    aborted = true
  }
  h.setIdle(false)
  await diff(h.deps, h.ctx)
  assert.equal(aborted, false)
  assert.match(messages(h)[0]!, /^The agent is running/)
})

test("diff: explains a message without file changes or snapshot", async () => {
  const h = setup()
  addCheckpoint(h, {}, {})
  await diff(h.deps, h.ctx)
  assert.deepEqual(messages(h), ["The last message changed no files"])
})
