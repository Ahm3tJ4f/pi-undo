import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { realpathSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  ADD_TIMEOUT,
  canonicalizePath,
  evictStaleStores,
  GC_AFTER_CAPTURES,
  ShadowGit,
} from "../src/git.ts";

process.env.PI_UNDO_STORE_ROOT = path.join(tmpdir(), `pi-undo-port-store-${process.pid}`);

interface RecordedCall {
  args: string[];
  options?: { cwd?: string; timeout?: number } | undefined;
}

function recordingPi(): {
  calls: RecordedCall[];
  exec: (
    command: string,
    args: string[],
    options?: { cwd?: string; timeout?: number },
  ) => Promise<{ stdout: string; stderr: string; code: number; killed: boolean }>;
} {
  const calls: RecordedCall[] = [];
  return {
    calls,
    exec: (command, args, options) =>
      new Promise((resolve) => {
        if (command === "git") calls.push({ args: [...args], options });
        execFile(
          command,
          args,
          { cwd: options?.cwd, timeout: options?.timeout },
          (error, stdout, stderr) => {
            const raw = error as { code?: number | string } | null;
            const code = typeof raw?.code === "number" ? raw.code : error ? 1 : 0;
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

test("canonicalizePath returns the realpath for existing paths and resolve() fallback for missing ones", () => {
  const base = tmpdir();
  assert.equal(canonicalizePath(base), realpathSync(base));

  const missing = path.join(base, "pi-undo-missing-path", "sub");
  assert.equal(canonicalizePath(missing), path.resolve(missing));

  // Redundant spellings collapse to one canonical form.
  assert.equal(
    canonicalizePath(path.join(base, ".", "x")),
    canonicalizePath(path.join(base, "x")),
  );
});

test("the shadow store root inside the worktree is seeded into both exclude files", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "pi-undo-selfseed-"));
  const saved = process.env.PI_UNDO_STORE_ROOT;
  process.env.PI_UNDO_STORE_ROOT = path.join(dir, ".pi-store");
  try {
    const pi = recordingPi();
    const git = new ShadowGit(pi as never, dir);
    await git.ensure();

    const stagingExclude = await readFile(path.join(git.storeDir, "info", "pi-undo-exclude"), "utf8");
    assert.match(
      stagingExclude,
      /^\/\.pi-store\/[0-9a-f]+\/$/m,
      "staging filter must carry the relative store-root entry",
    );
    const infoExclude = await readFile(path.join(git.storeDir, "info", "exclude"), "utf8");
    assert.match(
      infoExclude,
      /^\/\.pi-store\/[0-9a-f]+\/$/m,
      "manual-edit guard must also ignore the store root",
    );

    // And the same workspace spelled through a redundant path lands on the
    // identical store (one hash, not two).
    const twin = new ShadowGit(pi as never, path.join(dir, ".") + path.sep);
    assert.equal(twin.storeDir, git.storeDir, "redundant path spellings share one store");
  } finally {
    process.env.PI_UNDO_STORE_ROOT = saved;
    await rm(dir, { recursive: true, force: true });
  }
});

test("evictStaleStores removes stores whose workspace vanished and keeps live or unknown ones", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "pi-undo-evict-root-"));
  const liveWorkspace = await mkdtemp(path.join(tmpdir(), "pi-undo-evict-live-"));
  try {
    const live = path.join(root, "live");
    const stale = path.join(root, "stale");
    const metaless = path.join(root, "metaless");
    await mkdir(live, { recursive: true });
    await mkdir(stale, { recursive: true });
    await mkdir(metaless, { recursive: true });
    await writeFile(path.join(live, "HEAD"), "ref: refs/heads/main\n");
    await writeFile(path.join(stale, "HEAD"), "ref: refs/heads/main\n");
    await writeFile(path.join(metaless, "HEAD"), "ref: refs/heads/main\n");
    await writeFile(path.join(live, "meta.json"), JSON.stringify({ cwd: liveWorkspace }));
    await writeFile(
      path.join(stale, "meta.json"),
      JSON.stringify({ cwd: path.join(root, "workspace-vanished-xyz") }),
    );

    await evictStaleStores(root);

    await assert.doesNotReject(readFile(path.join(live, "meta.json"), "utf8"), "live store kept");
    await assert.rejects(readFile(path.join(stale, "HEAD"), "utf8"), "stale store removed");
    await assert.doesNotReject(readFile(path.join(metaless, "HEAD"), "utf8"), "metaless store kept conservatively");
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(liveWorkspace, { recursive: true, force: true });
  }
});

test(`a background gc fires within ${GC_AFTER_CAPTURES} captures`, async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "pi-undo-gccount-"));
  try {
    const pi = recordingPi();
    const git = new ShadowGit(pi as never, dir);
    await git.ensure();
    pi.calls.length = 0;

    for (let i = 0; i < GC_AFTER_CAPTURES - 1; i++) {
      await git.track();
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.ok(
      !pi.calls.some((call) => call.args.includes("gc")),
      "no gc before the threshold",
    );

    await git.track();

    // The gc is fired without blocking track(); give it a moment to land.
    let sawGc = false;
    for (let i = 0; i < 40 && !sawGc; i++) {
      sawGc = pi.calls.some((call) => call.args.includes("gc"));
      if (!sawGc) await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.ok(sawGc, `expected a gc invocation among recorded git calls`);
  } finally {
    // The fire-and-forget gc child may still hold the directory open on
    // Windows; retry the cleanup and give up silently — the assertion
    // above is what this test is about.
    for (let i = 0; i < 6; i++) {
      try {
        await rm(dir, { recursive: true, force: true });
        break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
  }
});

test("staging git calls carry the long ADD_TIMEOUT", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "pi-undo-addtimeout-"));
  try {
    await writeFile(path.join(dir, "a.txt"), "one\n");
    const pi = recordingPi();
    const git = new ShadowGit(pi as never, dir);
    await git.track();
    assert.ok(
      pi.calls.some(
        (call) =>
          call.args.includes("add") && call.options?.timeout === ADD_TIMEOUT,
      ),
      `the bulk add must run with the generous ${ADD_TIMEOUT}ms ceiling`,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
