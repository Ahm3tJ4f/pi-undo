import assert from "node:assert/strict";
import { test } from "node:test";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import {
  DEFAULT_CAPTURE_DEADLINE_MS,
  setupCapture,
  type CaptureController,
  type CaptureDeps,
} from "../src/capture.ts";
import type { SnapshotRepo } from "../src/git.ts";
import { CheckpointStore } from "../src/store.ts";

type Handler = (event: unknown, ctx: unknown) => Promise<void> | void;

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

interface Deferred<T> {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (error: unknown) => void
}

type TrackItem = string | undefined | { gate: Deferred<string | undefined> }

interface HarnessOptions {
  /** Track results consumed in call order. A gated entry blocks that
   *  track() call until its gate is resolved. */
  trackQueue: TrackItem[]
  deadlineMs?: number
}

function makeHarness(options: HarnessOptions) {
  const trackQueue = [...options.trackQueue];
  const handlers = new Map<string, Handler>();
  const notifications: string[] = [];
  const calls: string[] = [];
  const fakePi = {
    on: (event: string, handler: Handler) => void handlers.set(event, handler),
    appendEntry: () => {},
  } as unknown as Pick<ExtensionAPI, "on" | "appendEntry">;

  const store = new CheckpointStore(fakePi);
  const repo: SnapshotRepo = {
    storeDir: "/tmp/fake-store",
    async ensure() {},
    async track() {
      calls.push("track");
      const next = trackQueue.shift();
      if (next && typeof next === "object") return next.gate.promise;
      return next;
    },
    async changedFiles(from, to) {
      calls.push(`changedFiles:${from}:${to}`);
      return ["a.txt"];
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
  const deps: CaptureDeps & { captureDeadlineMs?: number } = {
    getGit: () => repo,
    ...(options.deadlineMs !== undefined ? { captureDeadlineMs: options.deadlineMs } : {}),
  };

  const controller: CaptureController = setupCapture(fakePi, store, deps);

  const ui = { notify: (message: string) => void notifications.push(message) };
  let userSeq = 0;
  const baseCtx = () => {
    userSeq += 1;
    const id = `u${userSeq}`;
    const parent = `p${userSeq}`;
    return {
      cwd: "/tmp/somewhere",
      ui,
      isProjectTrusted: () => true,
      sessionManager: {
        getBranch: () => [
          { type: "message", id, parentId: parent, message: { role: "user", content: "hi" } },
        ],
        getLeafId: () => `l${userSeq}`,
        getSessionId: () => "sess-1",
      },
      __ids: { id, parent },
    };
  };

  return {
    handlers,
    store,
    calls,
    notifications,
    controller,
    baseCtx,
    emit: async (event: string, eventData: unknown, ctx: unknown) => {
      await handlers.get(event)!(eventData, ctx);
    },
  };
}

const flush = (ms = 50) => new Promise((resolve) => setTimeout(resolve, ms));

test("capture: DEFAULT_CAPTURE_DEADLINE_MS is 3 seconds", () => {
  assert.equal(DEFAULT_CAPTURE_DEADLINE_MS, 3_000);
});

test("bounded capture: a slow pre-turn capture does not block before_agent_start", async () => {
  const gate = deferred<string | undefined>();
  const h = makeHarness({
    trackQueue: [{ gate }, "after"],
    deadlineMs: 100,
  });
  const ctx = h.baseCtx();

  const started = Date.now();
  await h.emit("before_agent_start", { prompt: "fix it", images: [] }, ctx);
  assert.ok(
    Date.now() - started < 3_000,
    "before_agent_start must return without waiting for the slow capture",
  );

  await h.emit("message_start", { message: { role: "assistant" } }, ctx);
  await h.emit("agent_settled", {}, ctx);
  assert.equal(h.store.get("u1"), undefined, "no checkpoint while the capture is unsettled");

  gate.resolve("before");
  await flush(100);

  const checkpoint = h.store.get("u1");
  assert.ok(checkpoint, "checkpoint recorded once the capture settles");
  assert.equal(checkpoint.beforeSnapshot, "before");
  assert.equal(checkpoint.afterSnapshot, "after");
  assert.deepEqual(checkpoint.files, ["a.txt"]);
});

test("bounded capture: agent_settled returns within the deadline when the capture overruns", async () => {
  const gate = deferred<string | undefined>();
  const h = makeHarness({
    trackQueue: [{ gate }],
    deadlineMs: 100,
  });
  const ctx = h.baseCtx();

  await h.emit("before_agent_start", { prompt: "fix it", images: [] }, ctx);
  await h.emit("message_start", { message: { role: "assistant" } }, ctx);

  const settledAt = Date.now();
  await h.emit("agent_settled", {}, ctx);
  assert.ok(
    Date.now() - settledAt < 2_000,
    "agent_settled waits at most the injected deadline, not the full capture",
  );
});

test("bounded capture: a failing pre-turn capture warns when it settles", async () => {
  const h = makeHarness({
    trackQueue: [
      (() => {
        const g = deferred<string | undefined>();
        queueMicrotask(() => g.reject(new Error("git exploded")));
        return { gate: g };
      })(),
    ],
    deadlineMs: 100,
  });
  const ctx = h.baseCtx();

  await h.emit("before_agent_start", { prompt: "fix it", images: [] }, ctx);
  await flush(50);
  assert.equal(
    h.notifications.length,
    0,
    "no warning before the capture settles",
  );
  await h.emit("message_start", { message: { role: "assistant" } }, ctx);
  await h.emit("agent_settled", {}, ctx);
  await flush(100);

  assert.equal(h.store.get("u1"), undefined);
  assert.ok(
    h.notifications.some((message) => /pre-turn snapshot failed/.test(message)),
    "user warned once the failed capture settles",
  );
});

test("bounded capture: a turn starting mid-capture gets no second capture", async () => {
  const gate1 = deferred<string | undefined>();
  const h = makeHarness({
    trackQueue: [{ gate: gate1 }, "after"],
    deadlineMs: 100,
  });
  const ctx1 = h.baseCtx(); // u1/p1

  await h.emit("before_agent_start", { prompt: "turn one", images: [] }, ctx1);
  await h.emit("message_start", { message: { role: "assistant" } }, ctx1);
  await h.emit("agent_settled", {}, ctx1);

  // Turn two starts while turn one's capture is still in flight.
  const ctx2 = h.baseCtx(); // u2/p2
  await h.emit("before_agent_start", { prompt: "turn two", images: [] }, ctx2);

  gate1.resolve("before");
  await flush(150);

  assert.ok(h.store.get("u1"), "turn one still finalizes from its own capture");
  assert.equal(h.store.get("u2"), undefined, "turn two got no pre-capture");
  assert.deepEqual(
    h.calls.filter((call) => call === "track").length,
    2,
    "exactly two track calls total: turn one before + after; no stacking for turn two",
  );
});

test("commands: undo warns and refuses while a capture is in flight", async () => {
  // Registered through the real command surface with a stubbed waitForCapture.
  const handlers = new Map<string, Handler>();
  const notifications: string[] = [];
  const fakePi = {
    on: (event: string, handler: Handler) => void handlers.set(event, handler),
    registerCommand: (name: string, def: { handler: Handler }) =>
      void handlers.set(`cmd:${name}`, def.handler),
    appendEntry: () => {},
  } as unknown as ExtensionAPI;
  const store = new CheckpointStore(fakePi);
  const repo: SnapshotRepo = {
    storeDir: "/tmp/fake-store",
    async ensure() {},
    async track() {
      return "tree";
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
  let inFlight = true;
  const deps: CaptureDeps = {
    getGit: () => repo,
    waitForCapture: async () => ({ settled: !inFlight }),
  };
  const { registerCommands } = await import("../src/commands.ts");
  registerCommands(fakePi, store, deps);

  const ctx = {
    cwd: "/tmp/somewhere",
    ui: {
      notify: (message: string) => void notifications.push(message),
      confirm: async () => true,
      setEditorText: () => {},
    },
    isIdle: () => true,
    abort: () => {},
    waitForIdle: async () => {},
    sessionManager: {
      getBranch: () => [],
      getSessionId: () => "sess-1",
    },
  };

  await handlers.get("cmd:undo")!(undefined, ctx);
  assert.equal(
    store.peekReverted(),
    undefined,
    "undo refused while the checkpoint is being captured",
  );
  assert.ok(
    notifications.some((message) => /still being captured/.test(message)),
    "busy warning shown",
  );

  inFlight = false;
  await handlers.get("cmd:undo")!(undefined, ctx);
  assert.ok(
    notifications.some((message) => /Nothing to undo/.test(message)),
    "with no capture in flight, undo proceeds to its normal path",
  );
});
