import assert from "node:assert/strict"
import { readFile, rm } from "node:fs/promises"
import path from "node:path"
import { test } from "node:test"
import type { SnapshotRepo } from "../src/git.ts"
import { applyRestore, planRestore, RestoreError } from "../src/restore.ts"
import { shadow, track, withDirs, write } from "./helpers.ts"

const read = (root: string, file: string) => readFile(path.join(root, file), "utf8")

test("plan: finds what to restore and nothing else", () =>
  withDirs(2, async (cwd, store) => {
    await write(cwd, "a.txt", "one\n")
    const git = await shadow(cwd, store)
    const before = await track(git)
    await write(cwd, "a.txt", "two\n")
    await write(cwd, "b.txt", "new\n")
    const after = await track(git)
    const files = await git.changedFiles(before, after)

    const plan = await planRestore(git, files, after, before)
    assert.deepEqual(plan.paths.sort(), ["a.txt", "b.txt"])
    assert.deepEqual(plan.manualEdits, [])
    await applyRestore(git, plan)
    assert.equal(await read(cwd, "a.txt"), "one\n")
    assert.equal((await git.partition(["b.txt"])).restorable.length, 1)
  }))

test("plan: a file that already matches the target is left out", () =>
  withDirs(2, async (cwd, store) => {
    await write(cwd, "a.txt", "one\n")
    await write(cwd, "b.txt", "one\n")
    const git = await shadow(cwd, store)
    const before = await track(git)
    await write(cwd, "a.txt", "two\n")
    await write(cwd, "b.txt", "two\n")
    const after = await track(git)
    // b.txt was put back by hand already.
    await write(cwd, "b.txt", "one\n")
    const plan = await planRestore(git, ["a.txt", "b.txt"], after, before)
    assert.deepEqual(plan.paths, ["a.txt"])
    assert.deepEqual(plan.manualEdits, [])
  }))

test("plan: edits made after the message are reported as manual edits", () =>
  withDirs(2, async (cwd, store) => {
    await write(cwd, ".gitignore", "*.log\n")
    await write(cwd, "a.txt", "one\n")
    await write(cwd, "x.log", "one\n")
    const git = await shadow(cwd, store)
    const before = await track(git)
    await write(cwd, "a.txt", "agent\n")
    await write(cwd, "x.log", "agent\n")
    const after = await track(git)
    // Hand edits after the message, one of them in a gitignored file.
    await write(cwd, "a.txt", "manual\n")
    await write(cwd, "x.log", "manual\n")
    await write(cwd, "other.txt", "manual\n")

    const plan = await planRestore(git, ["a.txt", "x.log"], after, before)
    assert.deepEqual(plan.manualEdits.sort(), ["a.txt", "x.log"])
    await applyRestore(git, plan)
    assert.equal(await read(cwd, "a.txt"), "one\n")
    assert.equal(await read(cwd, "x.log"), "one\n")
    // Files outside the message are never touched.
    assert.equal(await read(cwd, "other.txt"), "manual\n")
  }))

// Regression: verification used to compare the whole shadow index with the
// snapshot. A hand edit to any file between two messages made the second
// undo fail with "restored files do not match the snapshot".
test("two undos in a row work with a hand edit between the messages", () =>
  withDirs(2, async (cwd, store) => {
    await write(cwd, "a.txt", "one\n")
    await write(cwd, "notes.txt", "notes\n")
    const git = await shadow(cwd, store)

    const before1 = await track(git)
    await write(cwd, "a.txt", "message 1\n")
    const after1 = await track(git)

    await write(cwd, "notes.txt", "edited by hand between messages\n")

    const before2 = await track(git)
    await write(cwd, "b.txt", "message 2\n")
    const after2 = await track(git)

    const files2 = await git.changedFiles(before2, after2)
    await applyRestore(git, await planRestore(git, files2, after2, before2))
    const files1 = await git.changedFiles(before1, after1)
    await applyRestore(git, await planRestore(git, files1, after1, before1))

    assert.equal(await read(cwd, "a.txt"), "one\n")
    await assert.rejects(read(cwd, "b.txt"))
    assert.equal(await read(cwd, "notes.txt"), "edited by hand between messages\n")
  }))

// Regression: a failing restore used to escape without any rollback, and
// the rollback target was the old snapshot, not the real pre-undo state.
test("a failed restore rolls back to the exact state before it, manual edits included", () =>
  withDirs(2, async (cwd, store) => {
    await write(cwd, "a.txt", "one\n")
    await write(cwd, "b.txt", "one\n")
    const git = await shadow(cwd, store)
    const before = await track(git)
    await write(cwd, "a.txt", "agent\n")
    await write(cwd, "b.txt", "agent\n")
    const after = await track(git)
    await write(cwd, "b.txt", "manual\n")

    let calls = 0
    const flaky: SnapshotRepo = Object.create(git) as SnapshotRepo
    flaky.restore = async (tree, paths) => {
      calls++
      if (calls === 1) {
        // Restore one file, then fail.
        await git.restore(tree, ["a.txt"])
        throw new Error("disk full")
      }
      return git.restore(tree, paths)
    }

    const plan = await planRestore(git, ["a.txt", "b.txt"], after, before)
    await assert.rejects(applyRestore(flaky, plan), (error: unknown) => {
      assert.ok(error instanceof RestoreError)
      assert.equal(error.rolledBack, true)
      assert.match(error.message, /disk full/)
      return true
    })
    assert.equal(await read(cwd, "a.txt"), "agent\n")
    assert.equal(await read(cwd, "b.txt"), "manual\n")
  }))

test("a restore that does not verify is rolled back", () =>
  withDirs(2, async (cwd, store) => {
    await write(cwd, "a.txt", "one\n")
    const git = await shadow(cwd, store)
    const before = await track(git)
    await write(cwd, "a.txt", "agent\n")
    const after = await track(git)

    // The first restore claims success but writes nothing.
    const lying: SnapshotRepo = Object.create(git) as SnapshotRepo
    let first = true
    lying.restore = async (tree, paths) => {
      if (first) {
        first = false
        return
      }
      return git.restore(tree, paths)
    }
    const plan = await planRestore(git, ["a.txt"], after, before)
    // Another writer changes the file after the plan was made.
    await write(cwd, "a.txt", "concurrent\n")
    await assert.rejects(applyRestore(lying, plan), /do not match/)
    // Rolled back to the state the plan saw.
    assert.equal(await read(cwd, "a.txt"), "agent\n")
  }))

test("restore of the bash-edited files from the reported session", () =>
  withDirs(2, async (cwd, store) => {
    // The run edited one file with the edit tool and six with python via
    // bash. Every one of them must be restored.
    const names = ["capture", "commands", "git", "journal", "store", "types", "util"].map((n) => `src/${n}.ts`)
    for (const name of names) await write(cwd, name, `original ${name}\n`)
    const git = await shadow(cwd, store)
    const before = await track(git)
    for (const name of names) await write(cwd, name, `refactored ${name}\n`)
    await rm(path.join(cwd, "src/journal.ts"))
    const after = await track(git)

    const files = await git.changedFiles(before, after)
    assert.equal(files.length, 7)
    await applyRestore(git, await planRestore(git, files, after, before))
    for (const name of names) assert.equal(await read(cwd, name), `original ${name}\n`)
  }))
