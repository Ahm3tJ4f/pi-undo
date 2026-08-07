import assert from "node:assert/strict";
import { test } from "node:test";

import type { ExtensionAPI, RegisteredCommand } from "@earendil-works/pi-coding-agent";

import type { CaptureDeps } from "../src/capture.ts";
import { registerCommands } from "../src/commands.ts";
import type { SnapshotRepo } from "../src/git.ts";
import { CheckpointStore } from "../src/store.ts";
import type { Checkpoint } from "../src/types.ts";
import type { NumstatRow } from "../src/util.ts";

interface FakeUi {
  notifications: string[];
  editorText: string | undefined;
  confirmCalls: { title: string; message: string }[];
  confirmResult: boolean;
  notify: (message: string, level?: string) => void;
  confirm: (title: string, message: string) => Promise<boolean>;
  setEditorText: (text: string) => void;
}

function makeUi(): FakeUi {
  return {
    notifications: [],
    editorText: undefined,
    confirmCalls: [],
    confirmResult: true,
    notify(message) {
      this.notifications.push(message);
    },
    async confirm(title, message) {
      this.confirmCalls.push({ title, message });
      return this.confirmResult;
    },
    setEditorText(text) {
      this.editorText = text;
    },
  };
}

function makeEntry(
  id: string,
  role: "user" | "assistant",
  parentId: string | null,
): {
  type: "message";
  id: string;
  parentId: string | null;
  message: { role: string; content: unknown };
} {
  return {
    type: "message",
    id,
    parentId,
    message: { role, content: `text of ${id}` },
  };
}

function makeRepo(): {
  repo: SnapshotRepo;
  state: {
    calls: string[];
    dirty: string[];
    verify: (snapshot: string) => boolean;
    numstat: NumstatRow[];
  };
} {
  const state = {
    calls: [] as string[],
    dirty: [] as string[],
    verify: (_snapshot: string) => true,
    numstat: [] as NumstatRow[],
  };
  const repo: SnapshotRepo = {
    async ensure() {},
    async track() {
      state.calls.push("track");
      return "tree";
    },
    async changedFiles() {
      state.calls.push("changedFiles");
      return [];
    },
    async dirtySince() {
      state.calls.push("dirtySince");
      return state.dirty;
    },
    async restoreSnapshot(_snapshot, files) {
      state.calls.push(`restore:${_snapshot}:${files.join(",")}`);
      return { skipped: [] };
    },
    async verifySnapshot(snapshot) {
      state.calls.push(`verify:${snapshot}`);
      return state.verify(snapshot);
    },
    async diffNumstat() {
      state.calls.push("diffNumstat");
      return { rows: state.numstat, binaryCount: 0 };
    },
    async gcIfDue() {
      state.calls.push("gcIfDue");
    },
  };
  return { repo, state };
}

function makeCheckpoint(overrides: Partial<Checkpoint> = {}): Checkpoint {
  return {
    userEntryId: "u1",
    beforeLeafId: "l0",
    finalLeafId: "l3",
    prompt: "fix the bug",
    imageCount: 0,
    beforeSnapshot: "before1",
    afterSnapshot: "after1",
    files: ["a.txt"],
    createdAt: 1,
    ...overrides,
  };
}

function setup() {
  const appended: unknown[] = [];
  const handlers = new Map<string, Omit<RegisteredCommand, "name" | "sourceInfo">>();
  const fakePi: Pick<ExtensionAPI, "appendEntry" | "registerCommand"> = {
    appendEntry: (_type, data) => void appended.push(data),
    registerCommand: (name, opts) => void handlers.set(name, opts),
  };
  const store = new CheckpointStore(fakePi);
  const repoState = makeRepo();
  const deps: CaptureDeps = { getGit: () => repoState.repo };
  registerCommands(fakePi, store, deps);
  return {
    store,
    appended,
    repoState,
    run: (name: string, ctx: unknown) =>
      (handlers.get(name)!.handler as (args: string, ctx: unknown) => Promise<void>)("", ctx),
  };
}

function sessionCtx(
  branch: ReturnType<typeof makeEntry>[],
  opts: {
    idle?: boolean;
    navigateCancelled?: boolean;
    navigateError?: string;
  } = {},
) {
  const ui = makeUi();
  const navigations: { target: string }[] = [];
  const ctx = {
    ui,
    isIdle: () => opts.idle ?? true,
    abort: () => {},
    waitForIdle: async () => {},
    sessionManager: { getBranch: () => branch },
    navigateTree: async (target: string) => {
      navigations.push({ target });
      if (opts.navigateError) throw new Error(opts.navigateError);
      return { cancelled: Boolean(opts.navigateCancelled) };
    },
  };
  return { ctx, ui, navigations };
}

test("undo: nothing to undo when no checkpoint is on the branch", async () => {
  const { run, repoState } = setup();
  const { ctx, ui, navigations } = sessionCtx([makeEntry("u1", "user", null)]);
  await run("undo", ctx);
  assert.equal(ui.notifications[0], "Nothing to undo");
  assert.deepEqual(repoState.state.calls, []);
  assert.equal(navigations.length, 0);
});

test("undo: conversation-only checkpoint navigates and restores the prompt", async () => {
  const { store, run, repoState } = setup();
  store.add(makeCheckpoint({ files: [] }));
  const { ctx, ui, navigations } = sessionCtx([
    makeEntry("u1", "user", "l0"),
    makeEntry("a1", "assistant", "u1"),
  ]);
  await run("undo", ctx);
  assert.deepEqual(navigations, [{ target: "l0" }]);
  assert.equal(ui.editorText, "fix the bug");
  assert.equal(ui.notifications[0], "Undid message");
  
  assert.deepEqual(repoState.state.calls, []);
  assert.equal(store.peekReverted()?.userEntryId, "u1");
});

test("undo: dirty guard blocks when manual edits exist and user declines", async () => {
  const { store, repoState, run } = setup();
  store.add(makeCheckpoint({}));
  repoState.state.dirty = ["a.txt", "b.txt"];
  const { ctx, ui, navigations } = sessionCtx([makeEntry("u1", "user", "l0")]);
  ui.confirmResult = false;
  await run("undo", ctx);
  assert.equal(
    ui.notifications[0],
    "Undo blocked: working tree has manual edits",
  );
  assert.equal(ui.confirmCalls.length, 1);
  assert.deepEqual(navigations, []);
  assert.deepEqual(repoState.state.calls, ["dirtySince"]);
});

test("undo: dirty guard shows the preview and restores after force", async () => {
  const { store, repoState, run } = setup();
  store.add(makeCheckpoint({}));
  repoState.state.dirty = ["a.txt"];
  const { ctx, ui, navigations } = sessionCtx([makeEntry("u1", "user", "l0")]);
  ui.confirmResult = true;
  await run("undo", ctx);
  assert.deepEqual(navigations, [{ target: "l0" }]);
  assert.equal(ui.editorText, "fix the bug");
  assert.ok(repoState.state.calls.includes("restore:before1:a.txt"));
  assert.ok(repoState.state.calls.includes("verify:before1"));
  assert.ok(repoState.state.calls.includes("diffNumstat"));
  
  assert.match(ui.confirmCalls[1]!.message, /Total:/);
});

test("undo: cancel before restore leaves everything untouched", async () => {
  const { store, repoState, run } = setup();
  store.add(makeCheckpoint({}));
  const { ctx, ui, navigations } = sessionCtx([makeEntry("u1", "user", "l0")]);
  ui.confirmResult = false;
  await run("undo", ctx);
  assert.deepEqual(navigations, []);
  assert.deepEqual(repoState.state.calls, ["dirtySince", "diffNumstat"]);
  assert.equal(ui.editorText, undefined);
});

test("undo: verify failure rolls the files back and does not navigate", async () => {
  const { store, repoState, run } = setup();
  store.add(makeCheckpoint({}));
  repoState.state.verify = (snapshot) => snapshot !== "before1";
  const { ctx, ui, navigations } = sessionCtx([makeEntry("u1", "user", "l0")]);
  await run("undo", ctx);
  assert.deepEqual(navigations, []);
  assert.ok(
    repoState.state.calls.includes("restore:after1:a.txt"),
    "rollback restore runs",
  );
  assert.ok(
    repoState.state.calls.includes("verify:after1"),
    "rollback is verified",
  );
  assert.match(ui.notifications[0]!, /roll/);
});

test("undo: failed rollback after a bad restore warns about inconsistency", async () => {
  const { store, repoState, run } = setup();
  store.add(makeCheckpoint({}));
  repoState.state.verify = () => false;
  const { ctx, ui, navigations } = sessionCtx([makeEntry("u1", "user", "l0")]);
  await run("undo", ctx);
  assert.deepEqual(navigations, []);
  assert.match(ui.notifications[0]!, /rollback also failed/);
  assert.equal(store.peekReverted(), undefined);
});

test("undo: cancelled navigation rolls the files back to the after state", async () => {
  const { store, repoState, run } = setup();
  store.add(makeCheckpoint({}));
  const { ctx, ui } = sessionCtx([makeEntry("u1", "user", "l0")], {
    navigateCancelled: true,
  });
  await run("undo", ctx);
  assert.ok(
    repoState.state.calls.includes("restore:after1:a.txt"),
    "files rolled back on cancel",
  );
  assert.equal(ui.notifications[0], "Undo cancelled");
  assert.equal(store.peekReverted(), undefined);
});

test("undo: navigation error rolls the files back and reports failure", async () => {
  const { store, repoState, run } = setup();
  store.add(makeCheckpoint({}));
  const { ctx, ui, navigations } = sessionCtx([makeEntry("u1", "user", "l0")], {
    navigateError: "target missing",
  });
  await run("undo", ctx);
  assert.deepEqual(navigations, [{ target: "l0" }]);
  assert.ok(
    repoState.state.calls.includes("restore:after1:a.txt"),
    "files rolled back on navigation error",
  );
  assert.ok(
    repoState.state.calls.includes("verify:after1"),
    "rollback is verified",
  );
  assert.match(ui.notifications[0]!, /Undo failed/);
  assert.equal(store.peekReverted(), undefined);
});

test("undo: aborts a running agent first", async () => {
  const { store, run } = setup();
  store.add(makeCheckpoint({ files: [] }));
  let aborted = false;
  let waited = false;
  const ui = makeUi();
  const ctx = {
    ui,
    isIdle: () => false,
    abort: () => {
      aborted = true;
    },
    waitForIdle: async () => {
      waited = true;
    },
    sessionManager: { getBranch: () => [makeEntry("u1", "user", "l0")] },
    navigateTree: async () => ({ cancelled: false }),
  };
  await run("undo", ctx);
  assert.equal(aborted, true);
  assert.equal(waited, true);
});

test("redo: nothing to redo when the stack is empty", async () => {
  const { run, repoState } = setup();
  const { ctx, ui } = sessionCtx([]);
  await run("redo", ctx);
  assert.equal(ui.notifications[0], "Nothing to redo");
  assert.deepEqual(repoState.state.calls, []);
});

test("redo: restores files and navigates forward to the final leaf", async () => {
  const { store, repoState, run } = setup();
  store.add(makeCheckpoint({}));
  store.markReverted(store.get("u1")!);
  const { ctx, ui, navigations } = sessionCtx([makeEntry("u1", "user", "l0")]);
  await run("redo", ctx);
  assert.deepEqual(navigations, [{ target: "l3" }]);
  assert.ok(repoState.state.calls.includes("restore:after1:a.txt"));
  assert.ok(repoState.state.calls.includes("verify:after1"));
  assert.equal(ui.editorText, "");
  assert.equal(store.peekReverted(), undefined, "redo stack is popped");
});

test("redo: verify failure rolls the files back and does not navigate", async () => {
  const { store, repoState, run } = setup();
  store.add(makeCheckpoint({}));
  store.markReverted(store.get("u1")!);
  repoState.state.verify = (snapshot) => snapshot !== "after1";
  const { ctx, ui, navigations } = sessionCtx([makeEntry("u1", "user", "l0")]);
  await run("redo", ctx);
  assert.deepEqual(navigations, []);
  assert.ok(
    repoState.state.calls.includes("restore:before1:a.txt"),
    "rollback restore runs",
  );
  assert.ok(
    repoState.state.calls.includes("verify:before1"),
    "rollback is verified",
  );
  assert.match(ui.notifications[0]!, /roll/);
});

test("redo: blocked by the dirty guard", async () => {
  const { store, repoState, run } = setup();
  store.add(makeCheckpoint({}));
  store.markReverted(store.get("u1")!);
  repoState.state.dirty = ["a.txt"];
  const { ctx, ui, navigations } = sessionCtx([makeEntry("u1", "user", "l0")]);
  await run("redo", ctx);
  assert.match(ui.notifications[0]!, /blocked/);
  assert.deepEqual(navigations, []);
  assert.equal(store.peekReverted()?.userEntryId, "u1", "still reverted");
});

test("diff: shows the preview of what undo would restore", async () => {
  const { store, repoState, run } = setup();
  store.add(makeCheckpoint({}));
  repoState.state.numstat = [{ file: "a.txt", added: 12, removed: 3 }];
  const { ctx, ui } = sessionCtx([makeEntry("u1", "user", "l0")]);
  await run("diff", ctx);
  assert.match(ui.notifications[0]!, /a\.txt/);
  assert.match(ui.notifications[0]!, /\+12\/-3/);
});

test("diff: reports when the last message changed no files", async () => {
  const { store, run } = setup();
  store.add(makeCheckpoint({ files: [] }));
  const { ctx, ui } = sessionCtx([makeEntry("u1", "user", "l0")]);
  await run("diff", ctx);
  assert.equal(ui.notifications[0], "The last message changed no files");
});

test("store: redo stack survives a reload from appended entries", async () => {
  const fresh = new CheckpointStore({ appendEntry: () => {} });
  const entries = [
    {
      type: "custom",
      customType: "pi-undo/checkpoint",
      data: makeCheckpoint({}),
    },
    {
      type: "custom",
      customType: "pi-undo/revert",
      data: { revertedEntryIds: ["u1"] },
    },
  ];
  fresh.load({ getEntries: () => entries });
  assert.equal(fresh.peekReverted()?.userEntryId, "u1");
});

test("store: corrupted checkpoint entries are ignored on load", async () => {
  const fresh = new CheckpointStore({ appendEntry: () => {} });
  const entries = [
    {
      type: "custom",
      customType: "pi-undo/checkpoint",
      data: { userEntryId: "u1" },
    },
  ];
  fresh.load({ getEntries: () => entries });
  assert.equal(fresh.peekReverted(), undefined);
});
