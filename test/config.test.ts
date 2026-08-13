import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import ignore from "ignore";

import {
  DEFAULT_EXCLUDE_DIRECTORIES,
  DEFAULT_CONFIG,
  loadPiUndoConfig,
} from "../src/config.ts";

const NEW_CACHE_PATTERNS = [
  "__pycache__",
  "*.pyc",
  "*.pyo",
  ".pytest_cache",
  ".mypy_cache",
  ".ruff_cache",
  ".tox",
  ".turbo",
  ".parcel-cache",
  ".vite",
];

test("config: default excludes contain every new cache pattern", () => {
  for (const entry of NEW_CACHE_PATTERNS) {
    assert.ok(
      DEFAULT_EXCLUDE_DIRECTORIES.includes(entry),
      `missing default exclude: ${entry}`,
    );
  }
});

test("config: default excludes have no duplicates", () => {
  assert.deepEqual(
    new Set(DEFAULT_EXCLUDE_DIRECTORIES).size,
    DEFAULT_EXCLUDE_DIRECTORIES.length,
    "duplicate entry found in DEFAULT_EXCLUDE_DIRECTORIES",
  );
});

test("config: loadPiUndoConfig returns defaults when the file does not exist", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "pi-undo-config-test-"));
  const file = path.join(dir, "pi-undo.json");
  try {
    const config = loadPiUndoConfig(file);
    assert.deepEqual(config, DEFAULT_CONFIG);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("config: cache patterns match at any depth", () => {
  const matcher = ignore().add(DEFAULT_EXCLUDE_DIRECTORIES);
  assert.ok(matcher.ignores("pkg/__pycache__/x.pyc"));
  assert.ok(matcher.ignores("src/a.pyc"));
});
