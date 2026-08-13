import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { setupCapture, type CaptureDeps } from "../src/capture.ts";
import type { SnapshotRepo } from "../src/git.ts";
import { sessionJournalFile } from "../src/journal.ts";
import { CheckpointStore } from "../src/store.ts";

type Handler = (event: unknown, ctx: unknown) => Promise<void> | void;

interface HarnessOptions {
  trackQueue?: (string | undefined)[]
  changedFiles?: string[]
  storeDir?: string
}

function makeHarness(options: HarnessOptions = {}) {
  const trackQueue = options.trackQueue ?? ["before", "after"];
  const changedFilesResult = options.changedFiles ?? ["a.txt"];
  const storeDir =
    options.storeDir ??
    path.join(tmpdir(), `pi-undo-capture-${process.pid}-${Math.random().toString(36).slice(2)}`);
  const handlers = new Map<string, Handler>();
  const fakePi = {
    on: (event: string, handler: Handler) => void handlers.set(event, handler),
    appendEntry: () => {},
  } as unknown as Pick<ExtensionAPI, "on" | "appendEntry">;

  const store = new CheckpointStore(fakePi);
  const calls: string[] = [];
  const repo: SnapshotRepo = {
    storeDir,
    async ensure() {},
    async track() {
      calls.push("track");
      const value = trackQueue.shift();
      return value;
    },
    async changedFiles(from, to) {
      calls.push(`changedFiles:${from}:${to}`);
      return changedFilesResult;
    },
    async dirtySinceAll() {
      return { manual: [], ignored: [] };
    },
    async restoreSnapshot() {
      return { skipped: [], excluded: [], manualSkipped: [] };
    },
    async verifySnapshot() {
      return true;
    },
    async diffNumstat() {
      return { rows: [], binaryCount: 0 };
    },
    async gcIfDue() {},
  };
  const deps: CaptureDeps = { getGit: () => repo };

  setupCapture(fakePi, store, deps);

  const ui = { notify: (message: string) => void notifications.push(message) };
  const notifications: string[] = [];

  const baseCtx = {
    cwd: "/tmp/somewhere",
    ui,
    isProjectTrusted: () => true,
    sessionManager: {
      getBranch: () => [
        { type: "message", id: "u1", parentId: "p0", message: { role: "user", content: "hi" } },
      ],
      getLeafId: () => "l9",
      getSessionId: () => "sess-1",
    },
  };

  return {
    handlers,
    store,
    calls,
    notifications,
    baseCtx,
    emit: async (event: string, eventData: unknown, ctx: unknown) => {
      await handlers.get(event)!(eventData, ctx);
    },
  };
}

test("capture: a full turn creates one checkpoint with before and after trees", async () => {
  const h = makeHarness();
  await h.emit("before_agent_start", { prompt: "fix it", images: [] }, h.baseCtx);
  await h.emit(
    "message_start",
    { message: { role: "assistant" } },
    h.baseCtx,
  );
  await h.emit("agent_settled", {}, h.baseCtx);

  const checkpoint = h.store.get("u1");
  assert.ok(checkpoint, "checkpoint exists");
  assert.equal(checkpoint.beforeLeafId, "p0");
  assert.equal(checkpoint.finalLeafId, "l9");
  assert.equal(checkpoint.beforeSnapshot, "before");
  assert.equal(checkpoint.afterSnapshot, "after");
  assert.deepEqual(checkpoint.files, ["a.txt"]);
  assert.equal(checkpoint.prompt, "fix it");
  assert.deepEqual(h.calls, [
    "track",
    "track",
    "changedFiles:before:after",
  ]);
});

test("capture: skipped snapshot (cap) records no checkpoint", async () => {
  const h = makeHarness({ trackQueue: [undefined, undefined] });
  await h.emit("before_agent_start", { prompt: "fix it", images: [] }, h.baseCtx);
  await h.emit(
    "message_start",
    { message: { role: "assistant" } },
    h.baseCtx,
  );
  await h.emit("agent_settled", {}, h.baseCtx);

  assert.equal(h.store.get("u1"), undefined);
  assert.deepEqual(h.calls, ["track"]);
});

test("capture: failed pre-turn snapshot disables undo for the message", async () => {
  const handlers = new Map<string, Handler>();
  const notifications: string[] = [];
  const failingPi = {
    on: (event: string, handler: Handler) => void handlers.set(event, handler),
    appendEntry: () => {},
  } as unknown as Pick<ExtensionAPI, "on" | "appendEntry">;
  const store = new CheckpointStore(failingPi);
  const failing: SnapshotRepo = {
    storeDir: "/tmp/fake-store",
    async ensure() {},
    async track() {
      throw new Error("git timed out");
    },
    async changedFiles() {
      return [];
    },
    async dirtySinceAll() {
      return { manual: [], ignored: [] };
    },
    async restoreSnapshot() {
      return { skipped: [], excluded: [], manualSkipped: [] };
    },
    async verifySnapshot() {
      return true;
    },
    async diffNumstat() {
      return { rows: [], binaryCount: 0 };
    },
    async gcIfDue() {},
  };
  const deps: CaptureDeps = { getGit: () => failing };
  setupCapture(failingPi, store, deps);

  const ctx = {
    cwd: "/tmp/somewhere",
    ui: { notify: (message: string) => void notifications.push(message) },
    isProjectTrusted: () => true,
    sessionManager: {
      getBranch: () => [
        { type: "message", id: "u1", parentId: "p0", message: { role: "user", content: "hi" } },
      ],
      getLeafId: () => "l9",
    },
  };
  const emit = async (event: string, eventData: unknown) => {
    await handlers.get(event)!(eventData, ctx);
  };

  await emit("before_agent_start", { prompt: "fix it", images: [] });
  await emit("message_start", { message: { role: "assistant" } });
  await emit("agent_settled", {});

  assert.equal(store.get("u1"), undefined);
  assert.ok(
    notifications.some((message) => /pre-turn snapshot failed/.test(message)),
    "user is warned",
  );
});

test("capture: tool_call records write and edit paths and splits unattributed files", async () => {
  const h = makeHarness({ changedFiles: ["a.txt", "b.txt", "c.txt"] });
  await h.emit("before_agent_start", { prompt: "fix it", images: [] }, h.baseCtx);
  await h.emit("message_start", { message: { role: "assistant" } }, h.baseCtx);
  await h.emit("tool_call", { toolName: "write", input: { path: "a.txt" } }, h.baseCtx);
  await h.emit("tool_call", { toolName: "edit", input: { path: "/tmp/somewhere/b.txt" } }, h.baseCtx);
  await h.emit("tool_call", { toolName: "read", input: { path: "c.txt" } }, h.baseCtx);
  await h.emit("tool_call", { toolName: "bash", input: { command: "ls" } }, h.baseCtx);
  await h.emit("agent_settled", {}, h.baseCtx);

  const checkpoint = h.store.get("u1");
  assert.ok(checkpoint, "checkpoint exists");
  assert.deepEqual(checkpoint.files, ["a.txt", "b.txt", "c.txt"]);
  assert.deepEqual(checkpoint.unattributed, ["c.txt"]);
});

test("capture: touched paths are journaled, normalized, and outside paths are skipped", async () => {
  const storeDir = await mkdtemp(path.join(tmpdir(), "pi-undo-capture-"));
  try {
    const h = makeHarness({ changedFiles: ["a.txt"], storeDir });
    await h.emit("before_agent_start", { prompt: "x", images: [] }, h.baseCtx);
    await h.emit("message_start", { message: { role: "assistant" } }, h.baseCtx);
    await h.emit("tool_call", { toolName: "write", input: { path: "src/a.ts" } }, h.baseCtx);
    await h.emit("tool_call", { toolName: "edit", input: { path: "/tmp/somewhere/sub/b.ts" } }, h.baseCtx);
    await h.emit("tool_call", { toolName: "write", input: { path: "/tmp/elsewhere/c.ts" } }, h.baseCtx);
    await h.emit("tool_call", { toolName: "read", input: { path: "ignored.txt" } }, h.baseCtx);
    await h.emit("tool_call", { toolName: "bash", input: { command: "ls" } }, h.baseCtx);
    await h.emit("agent_settled", {}, h.baseCtx);

    const file = sessionJournalFile(storeDir, "sess-1");
    const lines = (await readFile(file, "utf8")).trim().split("\n");
    const paths = lines.map((line) => (JSON.parse(line) as { p: string }).p).sort();
    assert.deepEqual(paths, ["src/a.ts", "sub/b.ts"]);
  } finally {
    await rm(storeDir, { recursive: true, force: true });
  }
});
