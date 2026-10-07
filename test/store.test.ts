import assert from "node:assert/strict"
import { test } from "node:test"
import { CHECKPOINT_TYPE, CheckpointStore, parseCheckpoint, REVERT_TYPE, type StoreEntry } from "../src/store.ts"
import type { Checkpoint } from "../src/types.ts"

function recordingStore() {
  const entries: StoreEntry[] = []
  const store = new CheckpointStore({
    appendEntry: (customType, data) => void entries.push({ type: "custom", customType, data }),
  })
  return { store, entries }
}

const checkpoint = (entryId: string): Checkpoint => ({
  entryId,
  finalLeafId: `a-${entryId}`,
  prompt: `prompt ${entryId}`,
  imageCount: 0,
  snapshot: { before: "b", after: "a", files: ["x.txt"] },
  createdAt: 5,
})

test("store: checkpoints and the redo stack survive a reload", () => {
  const { store, entries } = recordingStore()
  store.add(checkpoint("u1"))
  store.add(checkpoint("u2"))
  store.pushReverted(store.get("u2")!)
  store.pushReverted(store.get("u1")!)
  store.popReverted()

  const reloaded = new CheckpointStore({ appendEntry: () => {} })
  reloaded.load(entries)
  assert.deepEqual(reloaded.get("u1"), checkpoint("u1"))
  assert.equal(reloaded.peekReverted()?.entryId, "u2")
})

test("store: latestOnBranch finds the newest checkpoint on the branch only", () => {
  const { store } = recordingStore()
  store.add(checkpoint("u1"))
  store.add(checkpoint("u2"))
  assert.equal(store.latestOnBranch([{ id: "u1" }, { id: "x" }, { id: "u2" }, { id: "y" }])?.entryId, "u2")
  assert.equal(store.latestOnBranch([{ id: "u1" }, { id: "x" }])?.entryId, "u1")
  assert.equal(store.latestOnBranch([{ id: "x" }]), undefined)
})

test("store: clearing an empty redo stack writes nothing", () => {
  const { store, entries } = recordingStore()
  store.clearReverted()
  assert.deepEqual(entries, [])
})

test("store: malformed entries are skipped", () => {
  const store = new CheckpointStore({ appendEntry: () => {} })
  store.load([
    { type: "custom", customType: CHECKPOINT_TYPE, data: { entryId: "u1" } },
    { type: "custom", customType: CHECKPOINT_TYPE, data: null },
    { type: "custom", customType: CHECKPOINT_TYPE, data: { v: 2, ...checkpoint("u2"), snapshot: { before: "b" } } },
    { type: "custom", customType: REVERT_TYPE, data: { revertedEntryIds: "nope" } },
    { type: "custom", customType: CHECKPOINT_TYPE, data: { v: 2, ...checkpoint("u3") } },
  ])
  assert.equal(store.get("u1"), undefined)
  assert.equal(store.get("u2"), undefined)
  assert.ok(store.get("u3"))
  assert.equal(store.peekReverted(), undefined)
})

test("store: checkpoints written by pi-undo 0.4 still load", () => {
  const legacy = {
    userEntryId: "1fc919e2",
    beforeLeafId: "3e353ddd",
    finalLeafId: "9fd91188",
    prompt: "write text1.txt",
    imageCount: 0,
    beforeSnapshot: "80d2e7cd",
    afterSnapshot: "b0df5b77",
    files: ["text1.txt"],
    unattributed: [],
    startedAt: 1,
    createdAt: 2,
  }
  assert.deepEqual(parseCheckpoint(legacy), {
    entryId: "1fc919e2",
    finalLeafId: "9fd91188",
    prompt: "write text1.txt",
    imageCount: 0,
    snapshot: { before: "80d2e7cd", after: "b0df5b77", files: ["text1.txt"] },
    createdAt: 2,
  })
  assert.equal(parseCheckpoint({ ...legacy, files: [], beforeSnapshot: null, afterSnapshot: null })?.snapshot, null)
  assert.equal(parseCheckpoint({ ...legacy, afterSnapshot: null }), null)
})

test("store: the unavailable reason round-trips", () => {
  const { store, entries } = recordingStore()
  store.add({ ...checkpoint("u1"), snapshot: null, unavailable: "the snapshot failed" })
  const reloaded = new CheckpointStore({ appendEntry: () => {} })
  reloaded.load(entries)
  assert.equal(reloaded.get("u1")?.unavailable, "the snapshot failed")
})
