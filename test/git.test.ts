import assert from "node:assert/strict"
import { lstat, mkdir, readFile, readdir, rm, symlink } from "node:fs/promises"
import path from "node:path"
import { test } from "node:test"
import type { Runner } from "../src/exec.ts"
import { parseNumstat } from "../src/git.ts"
import { indexedPaths, makeSourceRepo, run, shadow, track, withDirs, write } from "./helpers.ts"

const read = (root: string, file: string) => readFile(path.join(root, file), "utf8")
const exists = (root: string, file: string) =>
  lstat(path.join(root, file)).then(
    () => true,
    () => false,
  )

// --- tracking ---------------------------------------------------------------

test("track: snapshots a plain directory and diffs two snapshots", () =>
  withDirs(2, async (cwd, store) => {
    await write(cwd, "a.txt", "one\n")
    await write(cwd, "sub/b.txt", "two\n")
    const git = await shadow(cwd, store)
    const before = await track(git)
    assert.match(before, /^[0-9a-f]{40}$/)

    await write(cwd, "a.txt", "one\nchanged\n")
    await write(cwd, "c.txt", "three\n")
    const after = await track(git)
    assert.deepEqual((await git.changedFiles(before, after)).sort(), ["a.txt", "c.txt"])
    // Nothing changed since: the same tree comes back.
    assert.equal(await track(git), after)
  }))

test("track: pi's own .pi directories are never snapshotted", () =>
  withDirs(2, async (cwd, store) => {
    const git = await shadow(cwd, store)
    const before = await track(git)
    await write(cwd, ".pi/settings.json", "{}\n")
    await write(cwd, "sub/.pi/x", "x\n")
    await write(cwd, "a.txt", "a\n")
    assert.deepEqual(await git.changedFiles(before, await track(git)), ["a.txt"])
  }))

test("track: gitignored files are snapshotted, so the session's edits to them are undoable", () =>
  withDirs(2, async (cwd, store) => {
    await makeSourceRepo(cwd, { ".gitignore": "*.log\n.env\n", "a.txt": "one\n" })
    await write(cwd, ".env", "SECRET=1\n")
    const git = await shadow(cwd, store)
    const before = await track(git)
    await write(cwd, "x.log", "noise\n")
    await write(cwd, ".env", "SECRET=2\n")
    const after = await track(git)
    assert.deepEqual((await git.changedFiles(before, after)).sort(), [".env", "x.log"])
  }))

test("track: files in the source repo's info/exclude are snapshotted", () =>
  withDirs(2, async (cwd, store) => {
    await makeSourceRepo(cwd, { "a.txt": "one\n" })
    await write(cwd, ".git/info/exclude", "secret.tmp\n")
    const git = await shadow(cwd, store)
    const before = await track(git)
    await write(cwd, "secret.tmp", "x\n")
    assert.deepEqual(await git.changedFiles(before, await track(git)), ["secret.tmp"])
  }))

test("track: tracked files that become gitignored stay snapshotted", () =>
  withDirs(2, async (cwd, store) => {
    await write(cwd, "a.txt", "one\n")
    const git = await shadow(cwd, store)
    const before = await track(git)
    await write(cwd, ".gitignore", "a.txt\n")
    await write(cwd, "a.txt", "changed\n")
    assert.deepEqual((await git.changedFiles(before, await track(git))).sort(), [".gitignore", "a.txt"])
  }))

test("track: untracked files over 2 MB are left out, even with special characters in the name", () =>
  withDirs(2, async (cwd, store) => {
    await write(cwd, "a.txt", "one\n")
    const git = await shadow(cwd, store)
    const before = await track(git)
    const big = Buffer.alloc(2 * 1024 * 1024 + 1, 0x61)
    await write(cwd, "big.bin", big)
    await write(cwd, "[draft] #1!.bin", big)
    const after = await track(git)
    assert.deepEqual(await git.changedFiles(before, after), [])
    // The exclude rules match the names literally, so a later small file
    // with a similar name is not caught by them.
    await write(cwd, "d.bin", "small\n")
    assert.deepEqual(await git.changedFiles(after, await track(git)), ["d.bin"])
  }))

test("track: excludeDirectories match at any depth", () =>
  withDirs(2, async (cwd, store) => {
    await write(cwd, "a.txt", "one\n")
    await write(cwd, "sub/node_modules/x.js", "one\n")
    const git = await shadow(cwd, store)
    const before = await track(git)
    await write(cwd, "a.txt", "two\n")
    await write(cwd, "sub/node_modules/y.js", "two\n")
    assert.deepEqual(await git.changedFiles(before, await track(git)), ["a.txt"])
    assert.ok(!(await indexedPaths(git)).some((file) => file.includes("node_modules")))
  }))

test("track: excludeDirectories accept globs, file globs and a trailing slash", () =>
  withDirs(2, async (cwd, store) => {
    await write(cwd, "a.txt", "one\n")
    const git = await shadow(cwd, store, {
      config: { excludeDirectories: ["**/build-*", "*.tmp", "cache/"] },
    })
    const before = await track(git)
    await write(cwd, "a.txt", "two\n")
    await write(cwd, "sub/build-1/out.js", "x\n")
    await write(cwd, "sub/note.tmp", "x\n")
    await write(cwd, "deep/cache/c.bin", "x\n")
    assert.deepEqual(await git.changedFiles(before, await track(git)), ["a.txt"])
  }))

test("track: index entries that an exclude rule covers are dropped", () =>
  withDirs(2, async (cwd, store) => {
    await write(cwd, "a.txt", "one\n")
    await write(cwd, "node_modules/x.js", "one\n")
    // A store that tracked node_modules before it was excluded.
    const lax = await shadow(cwd, store, { config: { excludeDirectories: [] } })
    await track(lax)
    assert.ok((await indexedPaths(lax)).includes("node_modules/x.js"))

    const git = await shadow(cwd, store)
    const before = await track(git)
    await write(cwd, "node_modules/x.js", "changed\n")
    assert.deepEqual(await git.changedFiles(before, await track(git)), [])
    assert.ok(!(await indexedPaths(git)).includes("node_modules/x.js"))
  }))

test("track: config changes to excludeDirectories are honored", () =>
  withDirs(2, async (cwd, store) => {
    const git = await shadow(cwd, store, { config: { excludeDirectories: [] } })
    const before = await track(git)
    await write(cwd, "node_modules/m.js", "x\n")
    assert.deepEqual(await git.changedFiles(before, await track(git)), ["node_modules/m.js"])
  }))

test("track: nested git repositories are skipped with a warning", () =>
  withDirs(2, async (cwd, store) => {
    await makeSourceRepo(cwd, { "root.txt": "one\n" })
    await makeSourceRepo(path.join(cwd, "nested"), { "g.txt": "old\n" })
    const warnings: string[] = []
    const git = await shadow(cwd, store, { warnings })
    const before = await track(git)
    await write(cwd, "root.txt", "edited\n")
    await write(cwd, "nested/g.txt", "edited\n")
    assert.deepEqual(await git.changedFiles(before, await track(git)), ["root.txt"])
    assert.equal(warnings.filter((warning) => /nested git repo/.test(warning)).length, 1, "warned once")
  }))

test("track: over maxFiles the snapshot is skipped with one warning", () =>
  withDirs(2, async (cwd, store) => {
    for (let i = 0; i < 6; i++) await write(cwd, `f${i}.txt`, "x\n")
    const warnings: string[] = []
    const git = await shadow(cwd, store, { config: { excludeDirectories: [], maxFiles: 5 }, warnings })
    assert.equal(await git.track(), undefined)
    assert.equal(await git.track(), undefined)
    assert.equal(warnings.length, 1)
    assert.match(warnings[0]!, /maxFiles/)
  }))

test("track: fifos do not break tracking", { skip: process.platform === "win32" }, () =>
  withDirs(2, async (cwd, store) => {
    await write(cwd, "a.txt", "one\n")
    await run("mkfifo", [path.join(cwd, "pipe.fifo")], cwd)
    const git = await shadow(cwd, store)
    const before = await track(git)
    await write(cwd, "b.txt", "two\n")
    assert.deepEqual(await git.changedFiles(before, await track(git)), ["b.txt"])
  }))

test("track: a file created and deleted within one run leaves no trace", () =>
  withDirs(2, async (cwd, store) => {
    const git = await shadow(cwd, store)
    const before = await track(git)
    await write(cwd, "tmp.txt", "x\n")
    await track(git)
    await rm(path.join(cwd, "tmp.txt"))
    assert.deepEqual(await git.changedFiles(before, await track(git)), [])
  }))

test("track: a seeded store reuses the source repo's objects", () =>
  withDirs(2, async (cwd, store) => {
    await makeSourceRepo(cwd, { "a.txt": "one\n", "sub/b.txt": "two\n" })
    const git = await shadow(cwd, store)
    await track(git)
    const counted = await run("git", ["--git-dir", git.storeDir, "count-objects", "-v"], cwd)
    assert.match(counted, /^count: 0$/m)
  }))

test("track: git location variables in the environment are ignored", () =>
  withDirs(3, async (cwd, store, other) => {
    await makeSourceRepo(other)
    const saved = process.env.GIT_DIR
    process.env.GIT_DIR = path.join(other, ".git")
    try {
      await write(cwd, "a.txt", "one\n")
      const git = await shadow(cwd, store)
      const before = await track(git)
      await write(cwd, "a.txt", "two\n")
      assert.deepEqual(await git.changedFiles(before, await track(git)), ["a.txt"])
    } finally {
      if (saved === undefined) delete process.env.GIT_DIR
      else process.env.GIT_DIR = saved
    }
    // The other repository was never touched.
    assert.equal(await run("git", ["status", "--porcelain"], other), "")
  }))

// --- diff stats ---------------------------------------------------------------

test("diffNumstat: line counts, binary files and names with tabs", () =>
  withDirs(2, async (cwd, store) => {
    await write(cwd, "a.txt", "one\n")
    await write(cwd, "bin.dat", "text")
    await write(cwd, "tab\tname.txt", "one\n")
    const git = await shadow(cwd, store)
    const before = await track(git)
    await write(cwd, "a.txt", "one\ntwo\nthree\n")
    await write(cwd, "bin.dat", Buffer.from([0, 1, 2, 0xff, 0]))
    await write(cwd, "tab\tname.txt", "one\ntwo\n")
    const rows = await git.diffNumstat(before, await track(git))
    const byFile = new Map(rows.map((row) => [row.file, row]))
    assert.deepEqual(byFile.get("a.txt"), { file: "a.txt", added: 2, removed: 0, binary: false })
    assert.deepEqual(byFile.get("bin.dat"), { file: "bin.dat", added: 0, removed: 0, binary: true })
    assert.equal(byFile.get("tab\tname.txt")?.added, 1)
  }))

test("parseNumstat: skips malformed records", () => {
  assert.deepEqual(parseNumstat("1\t2\ta.txt\0x\ty\tb.txt\0garbage\0"), [
    { file: "a.txt", added: 1, removed: 2, binary: false },
  ])
})

// --- capture and restore ------------------------------------------------------

test("restore: modified, created and deleted files go back to the snapshot", () =>
  withDirs(2, async (cwd, store) => {
    await write(cwd, "mod.txt", "old\n")
    await write(cwd, "del.txt", "keep me\n")
    const git = await shadow(cwd, store)
    const before = await track(git)
    await write(cwd, "mod.txt", "new\n")
    await write(cwd, "new/deep/created.txt", "x\n")
    await rm(path.join(cwd, "del.txt"))
    const after = await track(git)
    const files = await git.changedFiles(before, after)
    assert.deepEqual(files.sort(), ["del.txt", "mod.txt", "new/deep/created.txt"])

    await git.restore(before, files)
    assert.equal(await read(cwd, "mod.txt"), "old\n")
    assert.equal(await read(cwd, "del.txt"), "keep me\n")
    // Directories that only held deleted files are removed too.
    assert.equal(await exists(cwd, "new"), false)
    assert.deepEqual(await git.changedFiles(before, await git.capture(files)), [])

    await git.restore(after, files)
    assert.equal(await read(cwd, "mod.txt"), "new\n")
    assert.equal(await read(cwd, "new/deep/created.txt"), "x\n")
    assert.equal(await exists(cwd, "del.txt"), false)
  }))

test("restore: a directory that still holds other files is kept", () =>
  withDirs(2, async (cwd, store) => {
    await write(cwd, "dir/keep.txt", "keep\n")
    const git = await shadow(cwd, store)
    const before = await track(git)
    await write(cwd, "dir/new.txt", "x\n")
    await git.restore(before, ["dir/new.txt"])
    assert.equal(await read(cwd, "dir/keep.txt"), "keep\n")
    assert.equal(await exists(cwd, "dir/new.txt"), false)
  }))

test("restore: a file replaced by a directory of the same name", () =>
  withDirs(2, async (cwd, store) => {
    await write(cwd, "x", "file\n")
    const git = await shadow(cwd, store)
    const before = await track(git)
    await rm(path.join(cwd, "x"))
    await write(cwd, "x/inner.txt", "dir\n")
    const after = await track(git)
    const files = await git.changedFiles(before, after)
    assert.deepEqual(files.sort(), ["x", "x/inner.txt"])

    await git.restore(before, files)
    assert.equal(await read(cwd, "x"), "file\n")
    await git.restore(after, files)
    assert.equal(await read(cwd, "x/inner.txt"), "dir\n")
  }))

test("restore: chmod-only changes", { skip: process.platform === "win32" }, () =>
  withDirs(2, async (cwd, store) => {
    await write(cwd, "run.sh", "#!/bin/sh\n")
    const git = await shadow(cwd, store)
    const before = await track(git)
    await run("chmod", ["+x", path.join(cwd, "run.sh")], cwd)
    const files = await git.changedFiles(before, await track(git))
    assert.deepEqual(files, ["run.sh"])
    await git.restore(before, files)
    assert.equal((await lstat(path.join(cwd, "run.sh"))).mode & 0o111, 0)
  }))

test("restore: a file deleted by hand is recreated", () =>
  withDirs(2, async (cwd, store) => {
    const git = await shadow(cwd, store)
    await write(cwd, "f.txt", "content\n")
    const after = await track(git)
    await rm(path.join(cwd, "f.txt"))
    await git.restore(after, ["f.txt"])
    assert.equal(await read(cwd, "f.txt"), "content\n")
  }))

test("restore: a tree from another store fails before touching any file", () =>
  withDirs(4, async (cwdA, storeA, cwdB, storeB) => {
    await write(cwdA, "keep.txt", "a\n")
    const gitA = await shadow(cwdA, storeA)
    const foreign = await track(gitA)
    await write(cwdB, "keep.txt", "precious\n")
    const gitB = await shadow(cwdB, storeB)
    assert.equal(await gitB.hasTrees([foreign]), false)
    await assert.rejects(gitB.restore(foreign, ["keep.txt"]), /not in the store/)
    assert.equal(await read(cwdB, "keep.txt"), "precious\n")
  }))

test("partition and restore never write through a symlinked directory", { skip: process.platform === "win32" }, () =>
  withDirs(3, async (cwd, store, outside) => {
    await write(cwd, "a/keep.txt", "keep\n")
    const git = await shadow(cwd, store)
    const before = await track(git)
    await write(cwd, "a/keep.txt", "agent\n")
    await write(cwd, "a/new.txt", "agent\n")
    const files = await git.changedFiles(before, await track(git))

    // The directory is swapped for a symlink to somewhere outside.
    await rm(path.join(cwd, "a"), { recursive: true })
    await symlink(outside, path.join(cwd, "a"))
    await write(outside, "new.txt", "outside\n")

    const { restorable, skipped } = await git.partition(files)
    assert.deepEqual(restorable, [])
    assert.deepEqual(skipped.map((s) => s.reason), ["symlink", "symlink"])
    await assert.rejects(git.restore(before, files), /symlinked directory/)
    assert.equal(await read(outside, "new.txt"), "outside\n")
  }))

test("partition: paths excluded by config are skipped", () =>
  withDirs(2, async (cwd, store) => {
    const git = await shadow(cwd, store, { config: { excludeDirectories: ["*.log"] } })
    assert.deepEqual(await git.partition(["a.txt", "x.log", "../evil", ".pi/x"]), {
      restorable: ["a.txt"],
      skipped: [{ path: "x.log", reason: "excluded" }],
    })
  }))

test("capture: records the exact worktree state of the given paths", () =>
  withDirs(2, async (cwd, store) => {
    await write(cwd, "a.txt", "one\n")
    await write(cwd, "b.txt", "one\n")
    const git = await shadow(cwd, store)
    const base = await track(git)
    await write(cwd, "a.txt", "two\n")
    await rm(path.join(cwd, "b.txt"))
    await write(cwd, "c.txt", "new\n")
    const now = await git.capture(["a.txt", "b.txt", "c.txt"])
    assert.deepEqual((await git.changedFiles(base, now)).sort(), ["a.txt", "b.txt", "c.txt"])
  }))

// --- retention ------------------------------------------------------------------

test("protect and gc: protected snapshots survive gc, expired ones lose their refs", () =>
  withDirs(2, async (cwd, store) => {
    await makeSourceRepo(cwd, { "a.txt": "one\n" })
    const git = await shadow(cwd, store)
    const before = await track(git)
    await write(cwd, "a.txt", "two\n")
    const after = await track(git)
    await git.protect([before, after])
    await mkdir(path.join(git.storeDir, "journal"), { recursive: true })

    await git.gcIfDue()
    assert.equal(await git.hasTrees([before, after]), true)
    assert.equal(await exists(git.storeDir, "journal"), false, "the legacy journal is removed")
    const refs = await run("git", ["--git-dir", git.storeDir, "for-each-ref", "--format=%(refname)"], cwd)
    assert.equal(refs.trim().split("\n").length, 2)

    // A second gc on the same day does nothing.
    const meta = JSON.parse(await read(git.storeDir, "meta.json")) as { lastGcAt: number }
    await git.gcIfDue()
    const again = JSON.parse(await read(git.storeDir, "meta.json")) as { lastGcAt: number }
    assert.equal(again.lastGcAt, meta.lastGcAt)

    // With a tiny retention, the next gc deletes the refs.
    const strict = await shadow(cwd, store, { config: { retentionDays: 1e-9 } })
    await write(git.storeDir, "meta.json", JSON.stringify({ ...again, lastGcAt: 0 }))
    await strict.gcIfDue()
    const left = await run("git", ["--git-dir", git.storeDir, "for-each-ref", "--format=%(refname)"], cwd)
    assert.equal(left.trim(), "")
  }))

test("gc: a seeded store still snapshots afterwards", () =>
  withDirs(2, async (cwd, store) => {
    await makeSourceRepo(cwd, { "a.txt": "one\n" })
    const git = await shadow(cwd, store)
    await track(git)
    await git.gcIfDue()
    await write(cwd, "b.txt", "two\n")
    assert.match(await track(git), /^[0-9a-f]{40}$/)
  }))

// --- robustness -----------------------------------------------------------------

test("git commands retry while another process holds the index lock", () =>
  withDirs(2, async (cwd, store) => {
    const { runProcess } = await import("../src/exec.ts")
    let locked = 2
    const runner: Runner = async (command, args, options) => {
      if (args.includes("write-tree") && locked > 0) {
        locked--
        return { code: 128, stdout: "", stderr: "fatal: Unable to create '/x/index.lock': File exists.\n" }
      }
      return runProcess(command, args, options)
    }
    await write(cwd, "a.txt", "one\n")
    const git = await shadow(cwd, store, { runner })
    assert.match(await track(git), /^[0-9a-f]{40}$/)
    assert.equal(locked, 0)
  }))

test("concurrent calls on one repo are serialized", () =>
  withDirs(2, async (cwd, store) => {
    for (let i = 0; i < 20; i++) await write(cwd, `f${i}.txt`, `${i}\n`)
    const git = await shadow(cwd, store)
    const base = await track(git)
    for (let i = 0; i < 20; i++) await write(cwd, `f${i}.txt`, `changed ${i}\n`)
    const trees = await Promise.all([git.track(), git.track(), git.capture(["f1.txt"]), git.track()])
    assert.ok(trees.every((tree) => typeof tree === "string"))
    assert.equal((await git.changedFiles(base, trees[3]!)).length, 20)
    assert.deepEqual(await readdir(cwd).then((names) => names.length), 20)
  }))
