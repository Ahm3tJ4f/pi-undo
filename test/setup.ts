// Loaded before every test file (see the "test" script). Keeps tests away
// from the real ~/.pi/agent directory and snapshot store.
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

const root = mkdtempSync(path.join(tmpdir(), "pi-undo-tests-"))
process.env.PI_CODING_AGENT_DIR = path.join(root, "agent")
process.env.PI_UNDO_STORE_ROOT = path.join(root, "snapshots")
process.on("exit", () => rmSync(root, { recursive: true, force: true }))
