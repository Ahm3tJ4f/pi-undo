import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import type { ExtensionAPI, RegisteredCommand } from "@earendil-works/pi-coding-agent";

import type { CaptureDeps } from "../src/capture.ts";
import { registerCommands } from "../src/commands.ts";
import { ShadowGit, type SnapshotRepo } from "../src/git.ts";
import { appendTouches } from "../src/journal.ts";
import { CheckpointStore } from "../src/store.ts";
import type { Checkpoint } from "../src/types.ts";
import type { NumstatRow } from "../src/util.ts";

process.env.PI_UNDO_STORE_ROOT = path.join(tmpdir(), `pi-undo-commands-store-${process.pid}`);

interface FakeUi {
  notifications: string[];
  editorText: string | undefined;
  confirmCalls: { title: string; message: string }[];
  confirmResult: boolean;
  confirmQueue: boolean[];
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
    confirmQueue: [],
    notify(message) {
      this.notifications.push(message);
    },
    async confirm(title, message) {
      this.confirmCalls.push({ title, message });
      if (this.confirmQueue.length > 0) return this.confirmQueue.shift()!;
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

function makeRepo(storeDir = "/tmp/fake-store"): {
  repo: SnapshotRepo;
  state: {
    calls: string[];
    dirty: string[];
    ignored: string[];
    verify: (snapshot: string) => boolean;
    numstat: NumstatRow[];
    skipped: string[];
    excluded: string[];
    manualSkipped: string[];
    restoreOpts: ({ manualSet?: ReadonlySet<string>; force?: boolean; verifyExclude?: string[] } | undefined)[];
    verifyExcludes: string[][];
  };
} {
  const state = {
    calls: [] as string[],
    dirty: [] as string[],
    ignored: [] as string[],
    verify: (_snapshot: string) => true,
    numstat: [] as NumstatRow[],
    skipped: [] as string[],
    excluded: [] as string[],
    manualSkipped: [] as string[],
    restoreOpts: [] as ({ manualSet?: ReadonlySet<string>; force?: boolean; verifyExclude?: string[] } | undefined)[],
    verifyExcludes: [] as string[][],
  };
  const repo: SnapshotRepo = {
    storeDir,
    async ensure() {},
    async track() {
      state.calls.push("track");
      return "tree";
    },
    async changedFiles() {
      state.calls.push("changedFiles");
      return [];
    },
    async dirtySinceAll() {
      state.calls.push("dirtySinceAll");
      return { manual: state.dirty, ignored: state.ignored };
    },
    async restoreSnapshot(_snapshot, files, _since, opts) {
      state.calls.push(`restore:${_snapshot}:${files.join(",")}`);
      state.restoreOpts.push(opts);
      return { skipped: state.skipped, excluded: state.excluded, manualSkipped: state.manualSkipped };
    },
    async verifySnapshot(snapshot, exclude) {
      state.calls.push(`verify:${snapshot}`);
      state.verifyExcludes.push(exclude ?? []);
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
    unattributed: [],
    startedAt: 1,
    createdAt: 1,
    ...overrides,
  };
}

function setup(repoState = makeRepo()) {
  const appended: unknown[] = [];
  const handlers = new Map<string, Omit<RegisteredCommand, "name" | "sourceInfo">>();
  const fakePi: Pick<ExtensionAPI, "appendEntry" | "registerCommand"> = {
    appendEntry: (_type, data) => void appended.push(data),
    registerCommand: (name, opts) => void handlers.set(name, opts),
  };
  const store = new CheckpointStore(fakePi);
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
    sessionManager: { getBranch: () => branch, getSessionId: () => "self-session" },
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
    "Undo blocked: working tree has manual edits in files changed by the message",
  );
  assert.equal(ui.confirmCalls.length, 1);
  assert.match(ui.confirmCalls[0]!.message, /a\.txt/);
  assert.doesNotMatch(ui.confirmCalls[0]!.message, /b\.txt/);
  assert.deepEqual(navigations, []);
  assert.deepEqual(repoState.state.calls, ["dirtySinceAll", "dirtySinceAll"]);
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

test("undo: manual edits in files the message did not change do not block", async () => {
  const { store, repoState, run } = setup();
  store.add(makeCheckpoint({}));
  repoState.state.dirty = ["b.txt"];
  const { ctx, ui, navigations } = sessionCtx([makeEntry("u1", "user", "l0")]);
  await run("undo", ctx);
  // Only the diff preview confirm runs. No manual-edit dialog.
  assert.equal(ui.confirmCalls.length, 1);
  assert.match(ui.confirmCalls[0]!.message, /Restore files to the state before/);
  assert.deepEqual(navigations, [{ target: "l0" }]);
  assert.equal(ui.editorText, "fix the bug");
  assert.ok(repoState.state.calls.includes("restore:before1:a.txt"));
});

test("undo: confirm restores all message files when only some have manual edits", async () => {
  const { store, repoState, run } = setup();
  store.add(makeCheckpoint({ files: ["a.txt", "c.txt"] }));
  repoState.state.dirty = ["a.txt", "b.txt"];
  const { ctx, ui, navigations } = sessionCtx([makeEntry("u1", "user", "l0")]);
  await run("undo", ctx);
  // The manual-edit dialog lists only the overlapping file, not the dirty
  // file outside the message and not the untouched message file.
  assert.match(ui.confirmCalls[0]!.message, /a\.txt/);
  assert.doesNotMatch(ui.confirmCalls[0]!.message, /b\.txt/);
  assert.doesNotMatch(ui.confirmCalls[0]!.message, /c\.txt/);
  // Restore still targets ALL message files.
  assert.ok(repoState.state.calls.includes("restore:before1:a.txt,c.txt"));
  assert.ok(repoState.state.calls.includes("verify:before1"));
  assert.deepEqual(navigations, [{ target: "l0" }]);
});

test("undo: cancel before restore leaves everything untouched", async () => {
  const { store, repoState, run } = setup();
  store.add(makeCheckpoint({}));
  const { ctx, ui, navigations } = sessionCtx([makeEntry("u1", "user", "l0")]);
  ui.confirmResult = false;
  await run("undo", ctx);
  assert.deepEqual(navigations, []);
  assert.deepEqual(repoState.state.calls, ["dirtySinceAll", "diffNumstat"]);
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

test("undo: rollback passes the original manualSkipped list to the restore", async () => {
  const { store, repoState, run } = setup();
  store.add(makeCheckpoint({ files: ["a.txt", "x.log"] }));
  repoState.state.verify = (snapshot) => snapshot !== "before1";
  repoState.state.manualSkipped = ["x.log"];
  const { ctx } = sessionCtx([makeEntry("u1", "user", "l0")]);
  await run("undo", ctx);
  // The first restore targets before1 and returns manualSkipped ["x.log"].
  // The rollback restore targets after1 and must reuse that same list.
  const rollbackOpts = repoState.state.restoreOpts[1];
  assert.ok(rollbackOpts?.manualSet?.has("x.log"));
  assert.equal(rollbackOpts?.manualSet?.size, 1);
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

test("redo: dirty guard dialog blocks when the user declines", async () => {
  const { store, repoState, run } = setup();
  store.add(makeCheckpoint({}));
  store.markReverted(store.get("u1")!);
  repoState.state.dirty = ["a.txt"];
  const { ctx, ui, navigations } = sessionCtx([makeEntry("u1", "user", "l0")]);
  ui.confirmResult = false;
  await run("redo", ctx);
  assert.match(ui.notifications[0]!, /blocked/);
  assert.match(ui.confirmCalls[0]!.message, /a\.txt/);
  assert.deepEqual(navigations, []);
  assert.equal(store.peekReverted()?.userEntryId, "u1", "still reverted");
});

test("redo: dirty guard dialog forces the restore on confirm", async () => {
  const { store, repoState, run } = setup();
  store.add(makeCheckpoint({}));
  store.markReverted(store.get("u1")!);
  repoState.state.dirty = ["a.txt"];
  const { ctx, navigations } = sessionCtx([makeEntry("u1", "user", "l0")]);
  await run("redo", ctx);
  assert.deepEqual(navigations, [{ target: "l3" }]);
  assert.ok(repoState.state.calls.includes("restore:after1:a.txt"));
  assert.equal(repoState.state.restoreOpts[0]?.force, true);
  assert.equal(store.peekReverted(), undefined, "redo stack is popped");
});

test("redo: manual edits in files the message did not change do not block", async () => {
  const { store, repoState, run } = setup();
  store.add(makeCheckpoint({}));
  store.markReverted(store.get("u1")!);
  repoState.state.dirty = ["b.txt"];
  const { ctx, ui, navigations } = sessionCtx([makeEntry("u1", "user", "l0")]);
  await run("redo", ctx);
  assert.deepEqual(navigations, [{ target: "l3" }]);
  assert.ok(repoState.state.calls.includes("restore:after1:a.txt"));
  assert.ok(repoState.state.calls.includes("verify:after1"));
  assert.equal(ui.editorText, "");
  assert.equal(store.peekReverted(), undefined, "redo stack is popped");
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

test("undo: cannot undo the first message in place", async () => {
  const { store, run } = setup();
  store.add(makeCheckpoint({ beforeLeafId: null }));
  const { ctx, ui, navigations } = sessionCtx([makeEntry("u1", "user", null)]);
  await run("undo", ctx);
  assert.equal(
    ui.notifications[0],
    "Cannot undo the first message in place; fork before it instead",
  );
  assert.deepEqual(navigations, []);
  assert.equal(store.peekReverted(), undefined);
});

test("undo: warns when the prompt had image attachments", async () => {
  const { store, run } = setup();
  store.add(makeCheckpoint({ imageCount: 2, files: [] }));
  const { ctx, ui } = sessionCtx([makeEntry("u1", "user", "l0")]);
  await run("undo", ctx);
  assert.ok(
    ui.notifications.some((message) => /2 image attachment/.test(message)),
    "image note is shown",
  );
});

test("undo: a new message clears the redo stack", async () => {
  const { store, run } = setup();
  store.add(makeCheckpoint({}));
  store.markReverted(store.get("u1")!);
  assert.equal(store.peekReverted()?.userEntryId, "u1");

  // A new message starts: capture clears the reverted state.
  store.clearRevert();
  const { ctx, ui } = sessionCtx([makeEntry("u1", "user", "l0")]);
  await run("redo", ctx);
  assert.equal(ui.notifications[0], "Nothing to redo");
});

test("store: two undos in a row target the previous message", async () => {
  const { store, appended } = setup();
  store.add(makeCheckpoint({ userEntryId: "u1", beforeLeafId: "l0", files: ["a.txt"] }));
  store.add(makeCheckpoint({ userEntryId: "u2", beforeLeafId: "l4", files: ["b.txt"] }));
  appended.length = 0;

  const branchBoth = [
    makeEntry("u1", "user", "l0"),
    makeEntry("a1", "assistant", "u1"),
    makeEntry("u2", "user", "l4"),
    makeEntry("a2", "assistant", "u2"),
  ];
  assert.equal(store.latestOnBranch(branchBoth as never)?.userEntryId, "u2");

  // After undoing u2 the branch no longer contains it.
  const branchAfterFirst = branchBoth.slice(0, 2);
  assert.equal(store.latestOnBranch(branchAfterFirst as never)?.userEntryId, "u1");
});

test("undo: gitignored manual edits trigger the dialog and force the restore", async () => {
  const { store, repoState, run } = setup();
  store.add(makeCheckpoint({ files: ["a.txt", "x.log"] }));
  // x.log is gitignored and has manual edits since the message. a.txt is clean.
  repoState.state.ignored = ["x.log"];
  const { ctx, ui, navigations } = sessionCtx([makeEntry("u1", "user", "l0")]);
  await run("undo", ctx);
  assert.equal(ui.confirmCalls[0]!.title, "Manual edits found");
  assert.match(ui.confirmCalls[0]!.message, /x\.log/);
  assert.doesNotMatch(ui.confirmCalls[0]!.message, /a\.txt/);
  // Confirm forces the restore so x.log is not silently skipped.
  assert.equal(repoState.state.restoreOpts[0]?.force, true);
  assert.ok(repoState.state.calls.includes("restore:before1:a.txt,x.log"));
  assert.deepEqual(navigations, [{ target: "l0" }]);
});

test("undo: declining the gitignored manual-edit dialog blocks undo", async () => {
  const { store, repoState, run } = setup();
  store.add(makeCheckpoint({ files: ["a.txt", "x.log"] }));
  repoState.state.ignored = ["x.log"];
  const { ctx, ui, navigations } = sessionCtx([makeEntry("u1", "user", "l0")]);
  ui.confirmResult = false;
  await run("undo", ctx);
  assert.match(ui.notifications[0]!, /Undo blocked/);
  assert.deepEqual(navigations, []);
  assert.deepEqual(repoState.state.calls, ["dirtySinceAll", "dirtySinceAll"]);
});

test("undo: unattributed files are never restored and are warned about in the dialog", async () => {
  const storeDir = path.join(tmpdir(), `pi-undo-nojournal-${process.pid}-${Math.random().toString(36).slice(2)}`);
  const { store, repoState, run } = setup(makeRepo(storeDir));
  store.add(makeCheckpoint({ files: ["a.txt", "b.txt"], unattributed: ["b.txt"] }));
  const { ctx, ui, navigations } = sessionCtx([makeEntry("u1", "user", "l0")]);
  await run("undo", ctx);
  // One dialog only: no second "restore them too?" question.
  assert.equal(ui.confirmCalls.length, 1);
  assert.equal(ui.confirmCalls[0]!.title, "Undo message");
  assert.match(ui.confirmCalls[0]!.message, /not restored/);
  assert.match(ui.confirmCalls[0]!.message, /b\.txt/);
  assert.ok(repoState.state.calls.includes("restore:before1:a.txt"));
  assert.ok(!repoState.state.calls.includes("restore:before1:a.txt,b.txt"));
  assert.ok(!repoState.state.calls.includes("restore:before1:b.txt"));
  assert.deepEqual(navigations, [{ target: "l0" }]);
  assert.ok(
    ui.notifications.some((m) => /not edited by this session/.test(m)),
    "unattributed files get a note",
  );
  // b.txt is left in the shadow index, so the verify must exclude it or
  // the restore would roll back.
  assert.ok(repoState.state.verifyExcludes[0]?.includes("b.txt"));
});

test("undo: other-session files are never restored and the session is named", async () => {
  const storeDir = await mkdtemp(path.join(tmpdir(), "pi-undo-commands-"));
  try {
    await appendTouches(storeDir, "other-session", [{ p: "b.txt", t: 100 }]);
    const { store, repoState, run } = setup(makeRepo(storeDir));
    store.add(makeCheckpoint({ files: ["a.txt", "b.txt"], unattributed: ["b.txt"], startedAt: 50, createdAt: 150 }));
    const { ctx, ui, navigations } = sessionCtx([makeEntry("u1", "user", "l0")]);
    await run("undo", ctx);
    assert.equal(ui.confirmCalls.length, 1);
    assert.match(ui.confirmCalls[0]!.message, /not restored/);
    assert.ok(repoState.state.calls.includes("restore:before1:a.txt"));
    assert.ok(!repoState.state.calls.includes("restore:before1:b.txt"));
    assert.ok(!repoState.state.calls.includes("restore:before1:a.txt,b.txt"));
    assert.ok(
      ui.notifications.some((m) => /other-session/.test(m)),
      "the other session id appears in a note",
    );
    // b.txt is still in the shadow index at its after state, so the undo
    // verify must exclude it or verification fails and the restore rolls back.
    assert.ok(repoState.state.verifyExcludes[0]?.includes("b.txt"));
    assert.deepEqual(navigations, [{ target: "l0" }]);
  } finally {
    await rm(storeDir, { recursive: true, force: true });
  }
});

test("redo: verify excludes other-session files left in the index", async () => {
  const storeDir = await mkdtemp(path.join(tmpdir(), "pi-undo-commands-"));
  try {
    await appendTouches(storeDir, "other-session", [{ p: "b.txt", t: 100 }]);
    const { store, repoState, run } = setup(makeRepo(storeDir));
    store.add(makeCheckpoint({ files: ["a.txt", "b.txt"], unattributed: ["b.txt"], startedAt: 50, createdAt: 150 }));
    store.markReverted(store.get("u1")!);
    const { ctx, navigations } = sessionCtx([makeEntry("u1", "user", "l0")]);
    await run("redo", ctx);
    assert.ok(repoState.state.calls.includes("restore:after1:a.txt"));
    assert.ok(!repoState.state.calls.includes("restore:after1:a.txt,b.txt"));
    assert.ok(repoState.state.verifyExcludes[0]?.includes("b.txt"));
    assert.deepEqual(navigations, [{ target: "l3" }]);
  } finally {
    await rm(storeDir, { recursive: true, force: true });
  }
});

test("undo: journal read failure treats unattributed files as unknown", async () => {
  // A store dir that cannot be read: attributeTouches fails, so every
  // unattributed file is unknown, warned about, and left alone.
  const storeDir = path.join(tmpdir(), `pi-undo-missing-${process.pid}`);
  const { store, repoState, run } = setup(makeRepo(storeDir));
  store.add(makeCheckpoint({ files: ["a.txt"], unattributed: ["a.txt"] }));
  const { ctx, ui, navigations } = sessionCtx([makeEntry("u1", "user", "l0")]);
  await run("undo", ctx);
  assert.equal(ui.confirmCalls.length, 1);
  assert.match(ui.confirmCalls[0]!.message, /not restored/);
  assert.ok(!ui.notifications.some((m) => /other pi sessions/.test(m)));
  // No restore ran: the only file is unattributed and never restored.
  assert.ok(!repoState.state.calls.some((c) => c.startsWith("restore:")));
  assert.deepEqual(navigations, [{ target: "l0" }]);
});

test("undo: restored count subtracts skipped and excluded files", async () => {
  const { store, repoState, run } = setup();
  store.add(makeCheckpoint({ files: ["a.txt", "b.txt", "c.txt"] }));
  repoState.state.skipped = ["b.txt"];
  repoState.state.excluded = ["c.txt"];
  const { ctx, ui } = sessionCtx([makeEntry("u1", "user", "l0")]);
  await run("undo", ctx);
  assert.equal(ui.notifications[0], "Undid message, restored 1 file(s)");
});

test("diff: splits edited and unattributed files and marks other sessions", async () => {
  const storeDir = await mkdtemp(path.join(tmpdir(), "pi-undo-commands-"));
  try {
    await appendTouches(storeDir, "other-session", [{ p: "b.txt", t: 100 }]);
    const { store, repoState, run } = setup(makeRepo(storeDir));
    store.add(makeCheckpoint({ files: ["a.txt", "b.txt", "c.txt"], unattributed: ["b.txt", "c.txt"], startedAt: 50, createdAt: 150 }));
    repoState.state.numstat = [
      { file: "a.txt", added: 1, removed: 0 },
      { file: "b.txt", added: 2, removed: 0 },
      { file: "c.txt", added: 3, removed: 0 },
    ];
    const { ctx, ui } = sessionCtx([makeEntry("u1", "user", "l0")]);
    await run("diff", ctx);
    const message = ui.notifications[0]!;
    assert.match(message, /Changes made by the last message/);
    assert.match(message, /a\.txt/);
    assert.match(message, /b\.txt \(session other-session\)/);
    assert.match(message, /Changed during the message by other sources/);
  } finally {
    await rm(storeDir, { recursive: true, force: true });
  }
});

test("undo then redo does not show a spurious manual-edit prompt for a declined file", async () => {
  const storeDir = path.join(tmpdir(), `pi-undo-redo-${process.pid}-${Math.random().toString(36).slice(2)}`);
  const { store, repoState, run } = setup(makeRepo(storeDir));
  // Snapshot-aware dirty state: b.txt differs from before1 (it sits at the
  // after state because the undo declined it) but equals after1.
  repoState.repo.dirtySinceAll = async (snapshot: string) =>
    snapshot === "before1" ? { manual: ["b.txt"], ignored: [] } : { manual: [], ignored: [] };
  store.add(makeCheckpoint({ files: ["a.txt", "b.txt"], unattributed: ["b.txt"] }));

  // Undo: one dialog, b.txt is unattributed and stays at after1.
  const undo = sessionCtx([makeEntry("u1", "user", "l0")]);
  await run("undo", undo.ctx);
  assert.ok(repoState.state.calls.includes("restore:before1:a.txt"));
  assert.ok(!repoState.state.calls.includes("restore:before1:a.txt,b.txt"));

  // Redo must not ask about manual edits: b.txt already equals the target.
  const redo = sessionCtx([makeEntry("u1", "user", "l0")]);
  await run("redo", redo.ctx);
  assert.equal(
    redo.ui.confirmCalls.some((c) => c.title === "Manual edits found"),
    false,
    "no spurious manual-edit prompt on redo",
  );
  assert.ok(repoState.state.calls.includes("restore:after1:a.txt"));
  assert.ok(!repoState.state.calls.includes("restore:after1:a.txt,b.txt"));
});

test("undo: a file that equals the undo target is exempt from the manual-edit prompt", async () => {
  const storeDir = path.join(tmpdir(), `pi-undo-sym-${process.pid}-${Math.random().toString(36).slice(2)}`);
  const { store, repoState, run } = setup(makeRepo(storeDir));
  // b.txt differs from after1 (it sits at the before state) but equals before1.
  repoState.repo.dirtySinceAll = async (snapshot: string) =>
    snapshot === "after1" ? { manual: ["b.txt"], ignored: [] } : { manual: [], ignored: [] };
  store.add(makeCheckpoint({ files: ["a.txt", "b.txt"], unattributed: ["b.txt"] }));

  const { ctx, ui } = sessionCtx([makeEntry("u1", "user", "l0")]);
  await run("undo", ctx);
  assert.equal(
    ui.confirmCalls.some((c) => c.title === "Manual edits found"),
    false,
    "a file already at the undo target is not a manual edit",
  );
  assert.ok(repoState.state.calls.includes("restore:before1:a.txt"));
  assert.ok(!repoState.state.calls.includes("restore:before1:a.txt,b.txt"));
});

function fakeExec(): (command: string, args: string[], options?: { cwd?: string; timeout?: number }) => Promise<{
  stdout: string;
  stderr: string;
  code: number;
  killed: boolean;
}> {
  return (command, args, options) =>
    new Promise((resolve) => {
      execFile(command, args, { cwd: options?.cwd, timeout: options?.timeout }, (error, stdout, stderr) => {
        const raw = error as { code?: number | string } | null;
        const code = typeof raw?.code === "number" ? raw.code : error ? 1 : 0;
        resolve({ stdout: String(stdout), stderr: String(stderr), code, killed: false });
      });
    });
}

test("undo: real git verifies correctly when another session's file is left in the index", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "pi-undo-undo-it-"));
  try {
    await writeFile(path.join(cwd, "a.txt"), "one\n");
    const git = new ShadowGit({ exec: fakeExec() }, cwd);
    await git.ensure();
    const before = await git.track();
    assert.ok(before, "before snapshot exists");

    // The message edits a.txt. Another pi session creates b.txt during it.
    await writeFile(path.join(cwd, "a.txt"), "one\nchanged\n");
    await writeFile(path.join(cwd, "b.txt"), "other session\n");
    const after = await git.track();
    assert.ok(after, "after snapshot exists");

    // The other session's touch on b.txt falls inside the message window.
    await appendTouches(git.storeDir, "other-session", [{ p: "b.txt", t: 100 }]);

    const appended: unknown[] = [];
    const handlers = new Map<string, Omit<RegisteredCommand, "name" | "sourceInfo">>();
    const fakePi: Pick<ExtensionAPI, "appendEntry" | "registerCommand"> = {
      appendEntry: (_type, data) => void appended.push(data),
      registerCommand: (name, opts) => void handlers.set(name, opts),
    };
    const store = new CheckpointStore(fakePi);
    store.add({
      userEntryId: "u1",
      beforeLeafId: "l0",
      finalLeafId: "l3",
      prompt: "change a",
      imageCount: 0,
      beforeSnapshot: before,
      afterSnapshot: after,
      files: ["a.txt", "b.txt"],
      unattributed: ["b.txt"],
      startedAt: 50,
      createdAt: 150,
    });
    const deps: CaptureDeps = { getGit: () => git };
    registerCommands(fakePi, store, deps);

    const ui = makeUi();
    const ctx = {
      ui,
      isIdle: () => true,
      abort: () => {},
      waitForIdle: async () => {},
      sessionManager: {
        getBranch: () => [makeEntry("u1", "user", "l0")],
        getSessionId: () => "self-session",
      },
      navigateTree: async () => ({ cancelled: false }),
    };
    await (handlers.get("undo")!.handler as (args: string, ctx: unknown) => Promise<void>)("", ctx);

    // a.txt is restored; the other session's b.txt is left untouched.
    assert.equal(await readFile(path.join(cwd, "a.txt"), "utf8"), "one\n");
    assert.equal(await readFile(path.join(cwd, "b.txt"), "utf8"), "other session\n");
    assert.match(ui.notifications[0]!, /^Undid message/);
    assert.ok(!ui.notifications.some((m) => /rolled back/.test(m)));
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
