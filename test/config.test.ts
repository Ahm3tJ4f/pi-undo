import assert from "node:assert/strict"
import { readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { test } from "node:test"
import ignore from "ignore"
import { DEFAULT_CONFIG, DEFAULT_EXCLUDE_DIRECTORIES, loadPiUndoConfig } from "../src/config.ts"
import { withDirs } from "./helpers.ts"

test("config: a missing file is created with the defaults", () =>
  withDirs(1, async (dir) => {
    const file = path.join(dir, "nested", "pi-undo.json")
    assert.deepEqual(loadPiUndoConfig(file), DEFAULT_CONFIG)
    assert.deepEqual(JSON.parse(await readFile(file, "utf8")), DEFAULT_CONFIG)
  }))

test("config: values in the file replace the defaults", () =>
  withDirs(1, async (dir) => {
    const file = path.join(dir, "pi-undo.json")
    await writeFile(file, JSON.stringify({ excludeDirectories: ["Downloads"], maxFiles: 7.9, retentionDays: 3 }))
    assert.deepEqual(loadPiUndoConfig(file), { excludeDirectories: ["Downloads"], maxFiles: 7, retentionDays: 3 })
  }))

test("config: an empty exclude list really excludes nothing", () =>
  withDirs(1, async (dir) => {
    const file = path.join(dir, "pi-undo.json")
    await writeFile(file, JSON.stringify({ excludeDirectories: [] }))
    assert.deepEqual(loadPiUndoConfig(file).excludeDirectories, [])
  }))

test("config: invalid values and invalid JSON fall back to the defaults", () =>
  withDirs(1, async (dir) => {
    const file = path.join(dir, "pi-undo.json")
    await writeFile(file, JSON.stringify({ excludeDirectories: "nope", maxFiles: -3, retentionDays: "x" }))
    assert.deepEqual(loadPiUndoConfig(file), DEFAULT_CONFIG)
    await writeFile(file, JSON.stringify({ excludeDirectories: ["ok", 5, "  "] }))
    assert.deepEqual(loadPiUndoConfig(file).excludeDirectories, ["ok"])
    await writeFile(file, "{ not json")
    assert.deepEqual(loadPiUndoConfig(file), DEFAULT_CONFIG)
    await writeFile(file, "null")
    assert.deepEqual(loadPiUndoConfig(file), DEFAULT_CONFIG)
  }))

test("config: default excludes have no duplicates", () => {
  assert.equal(new Set(DEFAULT_EXCLUDE_DIRECTORIES).size, DEFAULT_EXCLUDE_DIRECTORIES.length)
})

test("config: default cache patterns match at any depth", () => {
  const matcher = ignore().add(DEFAULT_EXCLUDE_DIRECTORIES)
  for (const file of [
    "node_modules/x.js",
    "a/b/node_modules/x.js",
    "pkg/__pycache__/m.cpython-312.pyc",
    "src/mod.pyc",
    "x/.pytest_cache/v/cache",
    "web/.turbo/log",
    "app/.vite/deps/a.js",
  ]) {
    assert.ok(matcher.ignores(file), file)
  }
  assert.ok(!matcher.ignores("src/index.ts"))
})
