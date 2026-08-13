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

test("journal: appendTouches writes one JSON line per path", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "pi-undo-journal-"));
  try {
    await appendTouches(dir, "sess1", ["a.txt", "sub/b.txt"], 123);
    const file = sessionJournalFile(dir, "sess1");
    const lines = (await readFile(file, "utf8")).trim().split("\n");
    assert.deepEqual(
      lines.map((line) => JSON.parse(line)),
      [
        { p: "a.txt", t: 123 },
        { p: "sub/b.txt", t: 123 },
      ],
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("journal: attributeTouches maps paths to other session ids and ignores the caller", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "pi-undo-journal-"));
  try {
    await appendTouches(dir, "sess-a", ["a.txt", "shared.txt"]);
    await appendTouches(dir, "sess-b", ["b.txt", "shared.txt"]);
    await appendTouches(dir, "sess-c", ["c.txt"]);

    const map = await attributeTouches(dir, "sess-a", ["a.txt", "b.txt", "shared.txt", "missing.txt"]);
    assert.equal(map.get("a.txt"), undefined, "self-only path is excluded");
    assert.deepEqual(map.get("b.txt"), ["sess-b"]);
    assert.deepEqual(map.get("shared.txt"), ["sess-b"]);
    assert.equal(map.has("missing.txt"), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("journal: attributeTouches ignores broken lines and missing files", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "pi-undo-journal-"));
  try {
    await appendTouches(dir, "good", ["a.txt"]);
    const file = sessionJournalFile(dir, "bad");
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, '{"p": "a.txt", "t": 1}\nnot-json\n{"broken": true}\n');

    const map = await attributeTouches(dir, "self", ["a.txt", "b.txt"]);
    assert.deepEqual((map.get("a.txt") ?? []).sort(), ["bad", "good"]);
    assert.equal(map.has("b.txt"), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
