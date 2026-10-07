import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import path from "node:path"
import { test } from "node:test"
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import piUndo from "../src/index.ts"
import { assistantEntry, type FakeSession, fakeSession, fakeUi, userEntry } from "./fakes.ts"
import { withDirs, write } from "./helpers.ts"

type Handler = (event: unknown, ctx: unknown) => unknown

// Loads the real extension against a fake pi with a real working directory
// and a real snapshot store.
function loadExtension(cwd: string) {
  const handlers = new Map<string, Handler[]>()
  const commands = new Map<string, (args: string, ctx: unknown) => Promise<void>>()
  const appended: { type: string; customType: string; data: unknown }[] = []
  const pi = {
    on: (event: string, handler: Handler) => void handlers.set(event, [...(handlers.get(event) ?? []), handler]),
    registerCommand: (name: string, options: { handler: (args: string, ctx: unknown) => Promise<void> }) =>
      void commands.set(name, options.handler),
    appendEntry: (customType: string, data: unknown) => void appended.push({ type: "custom", customType, data }),
  }
  piUndo(pi as unknown as ExtensionAPI)

  const session: FakeSession & { getEntries(): unknown[] } = Object.assign(fakeSession([]), {
    getEntries: () => appended,
  })
  const ui = fakeUi()
  let idle = true
  const ctx = {
    cwd,
    hasUI: true,
    ui,
    isIdle: () => idle,
    abort: () => {},
    waitForIdle: async () => {},
    sessionManager: session,
    navigateTree: async (target: string) => {
      // pi moves the leaf to the parent of a user message.
      const index = session.branch.findIndex((item) => item.id === target)
      const isUser = session.branch[index]?.message?.role === "user"
      session.branch.splice(isUser ? index : index + 1)
      await emit("session_tree", {})
      return { cancelled: false }
    },
  }
  const emit = async (event: string, data: unknown) => {
    for (const handler of handlers.get(event) ?? []) await handler(data, ctx)
  }
  let turn = 0
  // One agent run: the prompt, then `work` changes files.
  const prompt = async (text: string, work: () => Promise<void>, settled = true) => {
    turn++
    await emit("before_agent_start", { prompt: text })
    idle = false
    await emit("agent_start", {})
    session.append(userEntry(`u${turn}`))
    await work()
    session.append(assistantEntry(`a${turn}`))
    idle = true
    if (settled) await emit("agent_settled", {})
  }
  const command = (name: string) => commands.get(name)!("", ctx)
  return { emit, prompt, command, ui, session, appended }
}

test("extension: the reported session, undone end to end", () =>
  withDirs(2, async (cwd, store) => {
    process.env.PI_UNDO_STORE_ROOT = store
    const pi = loadExtension(cwd)
    await pi.emit("session_start", { reason: "startup" })

    await pi.prompt("write text1.txt", () => write(cwd, "text1.txt", ""))
    await pi.prompt("write inside of it something", () => write(cwd, "text1.txt", "Hello, world.\n"))
    // A refactor where most files are edited through bash, not the edit tool.
    await pi.prompt("do lots of refactoring", async () => {
      for (const name of ["a", "b", "c", "d", "e", "f", "g"]) await write(cwd, `src/${name}.ts`, `refactored ${name}\n`)
    })

    await pi.command("undo")
    for (const name of ["a", "b", "c", "d", "e", "f", "g"]) {
      await assert.rejects(readFile(path.join(cwd, `src/${name}.ts`)), `src/${name}.ts is removed`)
    }
    assert.equal(await readFile(path.join(cwd, "text1.txt"), "utf8"), "Hello, world.\n")
    assert.deepEqual(
      pi.session.branch.map((item) => item.id),
      ["u1", "a1", "u2", "a2"],
    )

    await pi.command("undo")
    assert.equal(await readFile(path.join(cwd, "text1.txt"), "utf8"), "")

    await pi.command("redo")
    await pi.command("redo")
    assert.equal(await readFile(path.join(cwd, "src/a.ts"), "utf8"), "refactored a\n")
    assert.deepEqual(
      pi.ui.notifications.map((n) => n.message),
      [
        "Undid message, restored 7 file(s)",
        "Undid message, restored 1 file(s)",
        "Redid message, restored 1 file(s)",
        "Redid message, restored 7 file(s)",
      ],
    )
  }))

test("extension: a jump in the tree by the user clears the redo stack", () =>
  withDirs(2, async (cwd, store) => {
    process.env.PI_UNDO_STORE_ROOT = store
    const pi = loadExtension(cwd)
    await pi.emit("session_start", { reason: "startup" })
    await pi.prompt("one", () => write(cwd, "a.txt", "1\n"))
    await pi.command("undo")
    await pi.emit("session_tree", {})
    await pi.command("redo")
    assert.equal(pi.ui.notifications.at(-1)?.message, "Nothing to redo")
  }))

test("extension: undo and redo survive a restart", () =>
  withDirs(2, async (cwd, store) => {
    process.env.PI_UNDO_STORE_ROOT = store
    const first = loadExtension(cwd)
    await first.emit("session_start", { reason: "startup" })
    await first.prompt("one", () => write(cwd, "a.txt", "1\n"))
    await first.command("undo")

    // A new process loads the same session entries.
    const second = loadExtension(cwd)
    second.appended.push(...first.appended)
    second.session.branch.push(...first.session.branch)
    await second.emit("session_start", { reason: "resume" })
    await second.command("redo")
    assert.equal(await readFile(path.join(cwd, "a.txt"), "utf8"), "1\n")
  }))

test("extension: a run without agent_settled still gets its own checkpoint", () =>
  withDirs(2, async (cwd, store) => {
    process.env.PI_UNDO_STORE_ROOT = store
    const pi = loadExtension(cwd)
    await pi.emit("session_start", { reason: "startup" })
    await pi.prompt("one", () => write(cwd, "a.txt", "1\n"), false)
    await pi.prompt("two", () => write(cwd, "b.txt", "2\n"))
    await pi.command("undo")
    assert.equal(await readFile(path.join(cwd, "a.txt"), "utf8"), "1\n")
    await assert.rejects(readFile(path.join(cwd, "b.txt")))
    await pi.command("undo")
    await assert.rejects(readFile(path.join(cwd, "a.txt")))
  }))
