import assert from "node:assert/strict"
import { tmpdir } from "node:os"
import { test } from "node:test"
import { runProcess } from "../src/exec.ts"
import { Mutex } from "../src/mutex.ts"

const cwd = tmpdir()

test("runProcess: returns stdout, stderr and the exit code", async () => {
  const result = await runProcess("node", ["-e", "process.stdout.write('out'); process.stderr.write('err'); process.exit(3)"], {
    cwd,
  })
  assert.deepEqual(result, { code: 3, stdout: "out", stderr: "err" })
})

test("runProcess: passes input on stdin", async () => {
  const result = await runProcess("node", ["-e", "process.stdin.pipe(process.stdout)"], { cwd, input: "a\0b" })
  assert.equal(result.stdout, "a\0b")
})

test("runProcess: a missing command resolves with an error instead of throwing", async () => {
  const result = await runProcess("pi-undo-no-such-command", [], { cwd })
  assert.equal(result.code, 127)
  assert.match(result.stderr, /ENOENT/)
})

test("runProcess: kills the child after the timeout", async () => {
  const started = Date.now()
  const result = await runProcess("node", ["-e", "setTimeout(() => {}, 10000)"], { cwd, timeoutMs: 100 })
  assert.equal(result.code, 124)
  assert.match(result.stderr, /timed out/)
  assert.ok(Date.now() - started < 5000)
})

test("runProcess: git location variables do not reach the child", async () => {
  const saved = process.env.GIT_INDEX_FILE
  process.env.GIT_INDEX_FILE = "/tmp/wrong-index"
  try {
    const result = await runProcess("node", ["-e", "process.stdout.write(String(process.env.GIT_INDEX_FILE))"], { cwd })
    assert.equal(result.stdout, "undefined")
  } finally {
    if (saved === undefined) delete process.env.GIT_INDEX_FILE
    else process.env.GIT_INDEX_FILE = saved
  }
})

test("Mutex: runs tasks one at a time in call order, failures included", async () => {
  const mutex = new Mutex()
  const log: string[] = []
  const task = (name: string, ms: number, fail = false) =>
    mutex.run(async () => {
      log.push(`start ${name}`)
      await new Promise((resolve) => setTimeout(resolve, ms))
      log.push(`end ${name}`)
      if (fail) throw new Error(name)
      return name
    })
  const results = await Promise.allSettled([task("a", 30), task("b", 10, true), task("c", 0)])
  assert.deepEqual(log, ["start a", "end a", "start b", "end b", "start c", "end c"])
  assert.deepEqual(
    results.map((r) => r.status),
    ["fulfilled", "rejected", "fulfilled"],
  )
})
