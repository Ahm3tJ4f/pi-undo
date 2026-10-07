import assert from "node:assert/strict"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import type { PiUndoConfig } from "../src/config.ts"
import { DEFAULT_CONFIG } from "../src/config.ts"
import { type Runner, runProcess } from "../src/exec.ts"
import { ShadowGit } from "../src/git.ts"

// Runs `fn` with fresh temp directories and removes them afterwards.
export async function withDirs<T>(count: number, fn: (...dirs: string[]) => Promise<T>): Promise<T> {
  const dirs: string[] = []
  for (let i = 0; i < count; i++) dirs.push(await mkdtemp(path.join(tmpdir(), "pi-undo-test-")))
  try {
    return await fn(...dirs)
  } finally {
    for (const dir of dirs) await rm(dir, { recursive: true, force: true })
  }
}

export async function write(root: string, file: string, content: string | Buffer): Promise<void> {
  await mkdir(path.dirname(path.join(root, file)), { recursive: true })
  await writeFile(path.join(root, file), content)
}

export async function run(command: string, args: string[], cwd: string): Promise<string> {
  const result = await runProcess(command, args, { cwd })
  assert.equal(result.code, 0, `${command} ${args.join(" ")} failed: ${result.stderr}`)
  return result.stdout
}

export async function makeSourceRepo(cwd: string, files: Record<string, string> = {}): Promise<void> {
  for (const [file, content] of Object.entries(files)) await write(cwd, file, content)
  await run("git", ["init", "--quiet", "-b", "main"], cwd)
  await run("git", ["config", "user.email", "t@example.com"], cwd)
  await run("git", ["config", "user.name", "test"], cwd)
  await run("git", ["add", "--all"], cwd)
  await run("git", ["commit", "--quiet", "--allow-empty", "-m", "init"], cwd)
}

export interface ShadowOptions {
  config?: Partial<PiUndoConfig>
  warnings?: string[]
  runner?: Runner
}

// A shadow repo for `cwd` with its store under `storeRoot`.
export async function shadow(cwd: string, storeRoot: string, options: ShadowOptions = {}): Promise<ShadowGit> {
  const git = new ShadowGit({
    cwd,
    storeRoot,
    config: { ...DEFAULT_CONFIG, ...options.config },
    warn: (message) => options.warnings?.push(message),
    ...(options.runner ? { runner: options.runner } : {}),
  })
  await git.ensure()
  return git
}

export async function track(git: ShadowGit): Promise<string> {
  const tree = await git.track()
  assert.ok(tree, "track() skipped the snapshot")
  return tree
}

// Paths in the shadow index.
export async function indexedPaths(git: ShadowGit): Promise<string[]> {
  const out = await run("git", ["--git-dir", git.storeDir, "ls-files", "-z"], git.cwd)
  return out.split("\0").filter(Boolean)
}
