import { spawn } from "node:child_process"

export interface RunResult {
  code: number
  stdout: string
  stderr: string
}

export interface RunOptions {
  cwd: string
  // Written to the child's stdin, then stdin is closed.
  input?: string
  timeoutMs?: number
}

export type Runner = (command: string, args: string[], options: RunOptions) => Promise<RunResult>

// Variables that point git at another repository, index or object store.
// pi can be started from a git hook or a wrapper that sets them. Inherited,
// they would make the shadow repo read or write the wrong repository.
const GIT_LOCATION_VARS = [
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_INDEX_FILE",
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_COMMON_DIR",
  "GIT_NAMESPACE",
  "GIT_PREFIX",
]

function childEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env }
  for (const name of GIT_LOCATION_VARS) delete env[name]
  // Never block on a credential or editor prompt, and keep messages in
  // English so error matching (for example index.lock) is stable.
  env.GIT_TERMINAL_PROMPT = "0"
  env.LC_ALL = "C"
  return env
}

// Runs a command without a shell. Never rejects: spawn errors and timeouts
// come back as a non-zero code with the reason in stderr.
export const runProcess: Runner = (command, args, options) =>
  new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: childEnv(),
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    })
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    let timedOut = false
    let settled = false
    const finish = (result: RunResult) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      resolve(result)
    }
    const timer =
      options.timeoutMs !== undefined
        ? setTimeout(() => {
            timedOut = true
            child.kill("SIGKILL")
          }, options.timeoutMs)
        : undefined

    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk))
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk))
    child.on("error", (error) => finish({ code: 127, stdout: "", stderr: error.message }))
    child.on("close", (code) => {
      const err = Buffer.concat(stderr).toString("utf8")
      finish({
        code: timedOut ? 124 : (code ?? 1),
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: timedOut ? `timed out after ${options.timeoutMs}ms\n${err}` : err,
      })
    })
    // A child that exits before reading its input closes the pipe; that is
    // not an error for us.
    child.stdin.on("error", () => {})
    child.stdin.end(options.input ?? "")
  })
