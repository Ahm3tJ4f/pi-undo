import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { appendTouches, attributeTouches, sessionJournalFile } from "../src/journal.ts";

test("journal: sessionJournalFile sanitizes the session id", () => {
  assert.equal(
    sessionJournalFile("/store", "abc-123_XYZ"),
    path.join("/store", "journal", "abc-123_XYZ.jsonl"),
  );
  assert.equal(
    sessionJournalFile("/store", "a/b c!d"),
    path.join("/store", "journal", "a_b_c_d.jsonl"),
  );
});

test("journal: appendTouches writes one JSON line per entry", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "pi-undo-journal-"));
  try {
    await appendTouches(dir, "sess1", [
      { p: "a.txt", t: 100 },
      { p: "sub/b.txt", t: 200 },
    ]);
    const file = sessionJournalFile(dir, "sess1");
    const lines = (await readFile(file, "utf8")).trim().split("\n");
    assert.deepEqual(
      lines.map((line) => JSON.parse(line)),
      [
        { p: "a.txt", t: 100 },
        { p: "sub/b.txt", t: 200 },
      ],
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("journal: attributeTouches maps paths to other session ids inside the window only", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "pi-undo-journal-"));
  try {
    await appendTouches(dir, "sess-a", [
      { p: "a.txt", t: 100 },
      { p: "stale.txt", t: 999 },
    ]);
    await appendTouches(dir, "sess-b", [
      { p: "b.txt", t: 150 },
      { p: "shared.txt", t: 50 },
    ]);
    // The caller's own touch must never attribute a path to itself.
    await appendTouches(dir, "sess-c", [{ p: "a.txt", t: 100 }]);

    // Window [100, 200]: a.txt (100), b.txt (150) count. stale.txt (999) is
    // outside. shared.txt (50) is outside too.
    const map = await attributeTouches(dir, "sess-c", ["a.txt", "b.txt", "stale.txt", "shared.txt", "missing.txt"], {
      from: 100,
      to: 200,
    });
    assert.deepEqual(map.get("a.txt"), ["sess-a"], "self touch is excluded");
    assert.deepEqual(map.get("b.txt"), ["sess-b"]);
    assert.equal(map.has("stale.txt"), false);
    assert.equal(map.has("shared.txt"), false);
    assert.equal(map.has("missing.txt"), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("journal: attributeTouches ignores broken lines and missing files", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "pi-undo-journal-"));
  try {
    await appendTouches(dir, "good", [{ p: "a.txt", t: 10 }]);
    const file = sessionJournalFile(dir, "bad");
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, '{"p": "a.txt", "t": 10}\nnot-json\n{"broken": true}\n');

    const map = await attributeTouches(dir, "self", ["a.txt", "b.txt"], { from: 0, to: 100 });
    assert.deepEqual((map.get("a.txt") ?? []).sort(), ["bad", "good"]);
    assert.equal(map.has("b.txt"), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
