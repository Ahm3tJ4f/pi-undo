import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"

import { ShadowGit, snapshotStoreRoot } from "../src/git.ts";
import { loadPiUndoConfig } from "../src/config.ts";

process.env.PI_UNDO_STORE_ROOT = path.join(tmpdir(), `pi-undo-test-store-${process.pid}`);

type Exec = (
  command: string,
  args: string[],
  options?: { cwd?: string; timeout?: number },
) => Promise<{
  stdout: string;
  stderr: string;
  code: number;
  killed: boolean;
}>;

function fakePi(): { exec: Exec } {
  return {
    exec: (command, args, options) =>
      new Promise((resolve) => {
        execFile(
          command,
          args,
          { cwd: options?.cwd, timeout: options?.timeout },
          (error, stdout, stderr) => {
            const raw = error as { code?: number | string } | null;
            const code =
              typeof raw?.code === "number" ? raw.code : error ? 1 : 0;
            resolve({
              stdout: String(stdout),
              stderr: String(stderr),
              code,
              killed: false,
            });
          },
        );
      }),
  };
}

const exec = fakePi().exec;

async function newTempDir(prefix: string): Promise<string> {
  return mkdtemp(path.join(tmpdir(), prefix));
}

async function newShadow(cwd: string): Promise<ShadowGit> {
  const git = new ShadowGit(fakePi() as unknown as ExtensionAPI, cwd);
  await git.ensure();
  return git;
}

async function tracked(git: ShadowGit): Promise<string> {
  const snapshot = await git.track();
  assert.ok(snapshot, "track() returned undefined");
  return snapshot;
}

async function makeSourceRepo(
  cwd: string,
  files: Record<string, string>,
): Promise<void> {
  for (const [rel, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(cwd, rel)), { recursive: true });
    await writeFile(path.join(cwd, rel), content);
  }
  await exec("git", ["init", "--quiet"], { cwd });
  await exec("git", ["config", "user.email", "t@example.com"], { cwd });
  await exec("git", ["config", "user.name", "test"], { cwd });
  await exec("git", ["add", "--all"], { cwd });
  await exec("git", ["commit", "--quiet", "-m", "init"], { cwd });
}

test("tracks, diffs and verifies in a non-git directory", async () => {
  const dir = await newTempDir("pi-undo-plain-");
  try {
    await writeFile(path.join(dir, "a.txt"), "one\n");
    await mkdir(path.join(dir, "sub"));
    await writeFile(path.join(dir, "sub", "b.txt"), "two\n");

    const git = await newShadow(dir);
    const before = await tracked(git);
    assert.match(before, /^[0-9a-f]{40}$/);

    await writeFile(path.join(dir, "a.txt"), "one\nchanged\n");
    await writeFile(path.join(dir, "c.txt"), "three\n");

    const after = await tracked(git);
    assert.notEqual(after, before);
    assert.deepEqual((await git.changedFiles(before, after)).sort(), [
      "a.txt",
      "c.txt",
    ]);
    assert.deepEqual(await git.dirtySince(after), []);

    
    await writeFile(path.join(dir, "a.txt"), "user edit\n");
    assert.deepEqual(await git.dirtySince(after), ["a.txt"]);

    
    await writeFile(path.join(dir, "a.txt"), "one\nchanged\n");
    await git.restoreSnapshot(before, ["a.txt", "c.txt"]);
    assert.equal(await readFile(path.join(dir, "a.txt"), "utf8"), "one\n");
    await assert.rejects(readFile(path.join(dir, "c.txt")));
    assert.equal(await git.verifySnapshot(before), true);

    
    assert.equal(await tracked(git), before);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("ignored files are not snapshotted and not dirty", async () => {
  const dir = await newTempDir("pi-undo-ignore-");
  try {
    await writeFile(path.join(dir, ".gitignore"), "*.log\n");
    await writeFile(path.join(dir, "a.txt"), "one\n");

    const git = await newShadow(dir);
    const before = await tracked(git);

    await writeFile(path.join(dir, "x.log"), "noise\n");
    await writeFile(path.join(dir, "b.txt"), "two\n");
    const after = await tracked(git);

    assert.deepEqual(await git.changedFiles(before, after), ["b.txt"]);
    assert.deepEqual(await git.dirtySince(after), []);
    await git.restoreSnapshot(before, ["b.txt"]);
    assert.equal(await git.verifySnapshot(before), true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("untracked files over the size cap are excluded from snapshots", async () => {
  const dir = await newTempDir("pi-undo-large-");
  try {
    await writeFile(path.join(dir, "a.txt"), "one\n");
    const git = await newShadow(dir);
    const before = await tracked(git);

    const big = Buffer.alloc(2 * 1024 * 1024 + 1, 0x61);
    await writeFile(path.join(dir, "big.bin"), big);
    const after = await tracked(git);

    assert.deepEqual(await git.changedFiles(before, after), []);
    
    assert.deepEqual(await git.dirtySince(after), []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("seeds from the source repo: no blobs are stored twice", async () => {
  const dir = await newTempDir("pi-undo-repo-");
  try {
    await makeSourceRepo(dir, { "a.txt": "one\n", "sub/b.txt": "two\n" });

    const git = await newShadow(dir);

    const before = await tracked(git);
    assert.match(before, /^[0-9a-f]{40}$/);

    
    
    const gitDir = await findShadowGitDir(dir);
    const counted = await exec("git", [
      "--git-dir",
      gitDir,
      "count-objects",
      "-v",
    ]);
    assert.match(
      counted.stdout,
      /^count: 0$/m,
      "shadow repo should reuse source objects",
    );

    
    await writeFile(path.join(dir, "a.txt"), "one\nchanged\n");
    const after = await tracked(git);
    assert.deepEqual(await git.changedFiles(before, after), ["a.txt"]);

    
    await git.restoreSnapshot(before, ["a.txt"]);
    assert.equal(await git.verifySnapshot(before), true);
    assert.equal(await readFile(path.join(dir, "a.txt"), "utf8"), "one\n");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("source repo ignore rules (info/exclude) are honored", async () => {
  const dir = await newTempDir("pi-undo-excl-");
  try {
    await makeSourceRepo(dir, { "a.txt": "one\n" });
    
    const gitDir = await exec("git", ["rev-parse", "--absolute-git-dir"], {
      cwd: dir,
    });
    await writeFile(
      path.join(gitDir.stdout.trim(), "info", "exclude"),
      "secret.tmp\n",
    );

    const git = await newShadow(dir);
    const before = await tracked(git);

    await writeFile(path.join(dir, "secret.tmp"), "nope\n");
    await writeFile(path.join(dir, "b.txt"), "two\n");
    const after = await tracked(git);

    assert.deepEqual(await git.changedFiles(before, after), ["b.txt"]);
    assert.deepEqual(await git.dirtySince(after), []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("file to directory transitions restore correctly", async () => {
  const dir = await newTempDir("pi-undo-trans-");
  try {
    await writeFile(path.join(dir, "a.txt"), "one\n");
    const git = await newShadow(dir);
    const before = await tracked(git);

    
    await rm(path.join(dir, "a.txt"));
    await mkdir(path.join(dir, "a"));
    await writeFile(path.join(dir, "a", "b.txt"), "two\n");

    const after = await tracked(git);
    const files = (await git.changedFiles(before, after)).sort();
    assert.ok(files.includes("a.txt"));
    assert.ok(files.includes("a/b.txt"));

    await git.restoreSnapshot(before, files);
    assert.equal(await git.verifySnapshot(before), true);
    assert.equal(await readFile(path.join(dir, "a.txt"), "utf8"), "one\n");
    await assert.rejects(readFile(path.join(dir, "a", "b.txt")));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("directory to file transitions restore correctly", async () => {
  const dir = await newTempDir("pi-undo-trans2-");
  try {
    await mkdir(path.join(dir, "a"));
    await writeFile(path.join(dir, "a", "b.txt"), "two\n");
    const git = await newShadow(dir);
    const before = await tracked(git);

    await rm(path.join(dir, "a"), { recursive: true });
    await writeFile(path.join(dir, "a.txt"), "one\n");

    const after = await tracked(git);
    const files = (await git.changedFiles(before, after)).sort();
    assert.ok(files.includes("a/b.txt"));

    await git.restoreSnapshot(before, files);
    assert.equal(await git.verifySnapshot(before), true);
    assert.equal(await readFile(path.join(dir, "a", "b.txt"), "utf8"), "two\n");
    await assert.rejects(readFile(path.join(dir, "a.txt")));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("numstat: parses add/remove stats between snapshots", async () => {
  const dir = await newTempDir("pi-undo-numstat-");
  try {
    await writeFile(path.join(dir, "a.txt"), "one\n");
    await writeFile(path.join(dir, "bin.dat"), "binary");
    const git = await newShadow(dir);
    const before = await tracked(git);

    await writeFile(path.join(dir, "a.txt"), "one\ntwo\nthree\n");
    await writeFile(path.join(dir, "bin.dat"), Buffer.alloc(64, 0x00));
    await writeFile(path.join(dir, "c.txt"), "new\n");
    const after = await tracked(git);

    const { rows, binaryCount } = await git.diffNumstat(before, after);
    const byFile = new Map(rows.map((row) => [row.file, row]));
    assert.equal(byFile.get("a.txt")?.added, 2);
    assert.equal(byFile.get("a.txt")?.removed, 0);
    assert.equal(byFile.get("c.txt")?.added, 1);
    assert.ok(!byFile.has("bin.dat"), "binary files are skipped");
    assert.equal(binaryCount, 1, "binary files are counted");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("numstat: filenames containing tabs parse correctly", async () => {
  const dir = await newTempDir("pi-undo-numtab-");
  try {
    await writeFile(path.join(dir, "weird\tname.txt"), "one\n");
    const git = await newShadow(dir);
    const before = await tracked(git);

    await writeFile(path.join(dir, "weird\tname.txt"), "one\ntwo\n");
    const after = await tracked(git);

    const { rows } = await git.diffNumstat(before, after);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.file, "weird\tname.txt");
    assert.equal(rows[0]?.added, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("restore: never deletes or writes through a symlinked parent directory", async () => {
  const dir = await newTempDir("pi-undo-sym-")
  const outside = await newTempDir("pi-undo-sym-out-")
  try {
    await mkdir(path.join(dir, "a"))
    await writeFile(path.join(dir, "a", "keep.txt"), "keep\n")
    const git = await newShadow(dir)
    const before = await tracked(git)

    
    await writeFile(path.join(dir, "a", "keep.txt"), "agent changed\n")
    await writeFile(path.join(dir, "a", "new.txt"), "agent created\n")
    const after = await tracked(git)
    const files = (await git.changedFiles(before, after)).sort()
    assert.deepEqual(files, ["a/keep.txt", "a/new.txt"])

    
    
    await rm(path.join(dir, "a"), { recursive: true })
    await symlink(outside, path.join(dir, "a"))
    await writeFile(path.join(outside, "keep.txt"), "outside keep\n")
    await writeFile(path.join(outside, "new.txt"), "outside new\n")

    const result = await git.restoreSnapshot(before, files)
    assert.deepEqual(result.skipped.sort(), ["a/keep.txt", "a/new.txt"])

    
    assert.equal(await readFile(path.join(outside, "keep.txt"), "utf8"), "outside keep\n")
    assert.equal(await readFile(path.join(outside, "new.txt"), "utf8"), "outside new\n")
    assert.equal((await lstat(path.join(dir, "a"))).isSymbolicLink(), true)

    
    
    assert.equal(await git.verifySnapshot(before, result.skipped), true)
    assert.equal(await git.verifySnapshot(before), false)
  } finally {
    await rm(dir, { recursive: true, force: true })
    await rm(outside, { recursive: true, force: true })
  }
})

test("tracked files that become ignored are dropped from snapshots", async () => {
  const dir = await newTempDir("pi-undo-trig-");
  try {
    await writeFile(path.join(dir, "a.txt"), "one\n");
    const git = await newShadow(dir);
    const before = await tracked(git);

    
    await writeFile(path.join(dir, ".gitignore"), "a.txt\n");
    await writeFile(path.join(dir, "a.txt"), "changed\n");
    const after = await tracked(git);

    
    
    await writeFile(path.join(dir, "a.txt"), "manual edit\n");
    assert.deepEqual(await git.dirtySince(after), []);
    
    assert.ok((await git.changedFiles(before, after)).includes("a.txt"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("gc runs on a seeded repo", async () => {
  const dir = await newTempDir("pi-undo-gc-");
  try {
    await makeSourceRepo(dir, { "a.txt": "one\n" });
    const git = await newShadow(dir);
    await tracked(git);
    await git.gcIfDue();
    
    await writeFile(path.join(dir, "b.txt"), "two\n");
    const tree = await tracked(git);
    assert.match(tree, /^[0-9a-f]{40}$/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

async function makeNestedRepo(parent: string, name: string, file: string, content: string): Promise<void> {
  const dir = path.join(parent, name);
  await mkdir(dir, { recursive: true });
  await exec("git", ["init", "--quiet", "-b", "main"], { cwd: dir });
  await writeFile(path.join(dir, file), content);
  await exec("git", ["config", "user.email", "t@example.com"], { cwd: dir });
  await exec("git", ["config", "user.name", "test"], { cwd: dir });
  await exec("git", ["add", "--all"], { cwd: dir });
  await exec("git", ["commit", "--quiet", "-m", "init"], { cwd: dir });
}

test("nested git repos are excluded: edits inside them are not undoable", async () => {
  const dir = await newTempDir("pi-undo-nested-");
  try {
    
    await writeFile(path.join(dir, "root.txt"), "one\n");
    await exec("git", ["init", "--quiet"], { cwd: dir });
    await exec("git", ["config", "user.email", "t@example.com"], { cwd: dir });
    await exec("git", ["config", "user.name", "test"], { cwd: dir });
    await exec("git", ["add", "--all"], { cwd: dir });
    await exec("git", ["commit", "--quiet", "-m", "init"], { cwd: dir });

    
    await makeNestedRepo(dir, "nested", "g.txt", "old\n");
    
    const empty = path.join(dir, "empty");
    await mkdir(empty, { recursive: true });
    await exec("git", ["init", "--quiet", "-b", "main"], { cwd: empty });
    await writeFile(path.join(empty, "f.txt"), "old\n");

    const git = await newShadow(dir);
    const before = await tracked(git);

    
    await writeFile(path.join(dir, "root.txt"), "edited\n");
    await writeFile(path.join(dir, "nested", "g.txt"), "edited\n");
    await writeFile(path.join(empty, "f.txt"), "edited\n");
    const after = await tracked(git);

    
    assert.deepEqual(await git.changedFiles(before, after), ["root.txt"]);

    
    await git.restoreSnapshot(before, ["root.txt"]);
    assert.equal(await readFile(path.join(dir, "root.txt"), "utf8"), "one\n");
    assert.equal(await readFile(path.join(dir, "nested", "g.txt"), "utf8"), "edited\n");
    assert.equal(await readFile(path.join(empty, "f.txt"), "utf8"), "edited\n");
    assert.equal(await git.verifySnapshot(before), true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("project pi-undo.json extraExcludes are honored for trusted projects", async () => {
  const dir = await newTempDir("pi-undo-extra-");
  try {
    await writeFile(path.join(dir, "a.txt"), "one\n");
    await mkdir(path.join(dir, "myjunk"));
    await writeFile(path.join(dir, "myjunk", "j.txt"), "x\n");
    await mkdir(path.join(dir, ".pi"));
    await writeFile(
      path.join(dir, ".pi", "pi-undo.json"),
      JSON.stringify({ extraExcludes: ["myjunk"] }),
    );

    const git = new ShadowGit(fakePi() as unknown as ExtensionAPI, dir, undefined, loadPiUndoConfig(dir, true));
    await git.ensure();
    const before = await tracked(git);

    await writeFile(path.join(dir, "myjunk", "j.txt"), "y\n");
    await writeFile(path.join(dir, "b.txt"), "two\n");
    const after = await tracked(git);

    assert.deepEqual(await git.changedFiles(before, after), ["b.txt"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("project pi-undo.json is ignored for untrusted projects", async () => {
  const dir = await newTempDir("pi-undo-untrusted-");
  try {
    await writeFile(path.join(dir, "a.txt"), "one\n");
    await mkdir(path.join(dir, "myjunk"));
    await writeFile(path.join(dir, "myjunk", "j.txt"), "x\n");
    await mkdir(path.join(dir, ".pi"));
    await writeFile(
      path.join(dir, ".pi", "pi-undo.json"),
      JSON.stringify({ extraExcludes: ["myjunk"] }),
    );

    const git = new ShadowGit(fakePi() as unknown as ExtensionAPI, dir, undefined, loadPiUndoConfig(dir, false));
    await git.ensure();
    const before = await tracked(git);

    await writeFile(path.join(dir, "myjunk", "j.txt"), "y\n");
    const after = await tracked(git);

    assert.deepEqual(await git.changedFiles(before, after), ["myjunk/j.txt"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("global pi-undo.json merges and project maxFiles wins", async () => {
  const dir = await newTempDir("pi-undo-global-");
  const globalFile = path.join(dir, "global.json");
  try {
    await writeFile(globalFile, JSON.stringify({ extraExcludes: ["g1"], maxFiles: 500 }));
    await mkdir(path.join(dir, ".pi"));
    await writeFile(path.join(dir, ".pi", "pi-undo.json"), JSON.stringify({ maxFiles: 7 }));

    const config = loadPiUndoConfig(dir, true, globalFile);
    assert.deepEqual(config.extraExcludes, ["g1"]);
    assert.equal(config.maxFiles, 7);

    const untrusted = loadPiUndoConfig(dir, false, globalFile);
    assert.equal(untrusted.maxFiles, 500);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("file cap skips snapshots with a warning", async () => {
  const dir = await newTempDir("pi-undo-cap-");
  try {
    for (let i = 0; i < 6; i++) {
      await writeFile(path.join(dir, `f${i}.txt`), "x\n");
    }
    const git = new ShadowGit(fakePi() as unknown as ExtensionAPI, dir, undefined, { extraExcludes: [], maxFiles: 5 });
    await git.ensure();
    assert.equal(await git.track(), undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

async function findShadowGitDir(cwd: string): Promise<string> {
  const storeRoot = snapshotStoreRoot();
  const { readdir } = await import("node:fs/promises");
  const dirs = await readdir(storeRoot);
  for (const dir of dirs) {
    const metaFile = path.join(storeRoot, dir, "meta.json");
    try {
      const meta = JSON.parse(await readFile(metaFile, "utf8")) as {
        cwd?: string;
      };
      if (meta.cwd === cwd) return path.join(storeRoot, dir);
    } catch {
      
    }
  }
  throw new Error(`no shadow store found for ${cwd}`);
}
