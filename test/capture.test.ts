import assert from "node:assert/strict";
import { test } from "node:test";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { setupCapture, type CaptureDeps } from "../src/capture.ts";
import type { SnapshotRepo } from "../src/git.ts";
import { CheckpointStore } from "../src/store.ts";

type Handler = (event: unknown, ctx: unknown) => Promise<void> | void;

function makeHarness(trackQueue: (string | undefined)[] = ["before", "after"]) {
  const handlers = new Map<string, Handler>();
  const fakePi = {
    on: (event: string, handler: Handler) => void handlers.set(event, handler),
    appendEntry: () => {},
  } as unknown as Pick<ExtensionAPI, "on" | "appendEntry">;

  const store = new CheckpointStore(fakePi);
  const calls: string[] = [];
  const repo: SnapshotRepo = {
    async ensure() {},
    async track() {
      calls.push("track");
      const value = trackQueue.shift();
      return value;
    },
    async changedFiles(from, to) {
      calls.push(`changedFiles:${from}:${to}`);
      return ["a.txt"];
    },
    async dirtySince() {
      return [];
    },
    async restoreSnapshot() {
      return { skipped: [] };
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
  const h = makeHarness([undefined, undefined]);
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
    async ensure() {},
    async track() {
      throw new Error("git timed out");
    },
    async changedFiles() {
      return [];
    },
    async dirtySince() {
      return [];
    },
    async restoreSnapshot() {
      return { skipped: [] };
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
