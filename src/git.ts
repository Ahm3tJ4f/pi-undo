import { createHash } from "node:crypto"
import { existsSync } from "node:fs"
import { copyFile, lstat, mkdir, readFile, rm, rmdir, stat, writeFile } from "node:fs/promises"
import path from "node:path"
import { getAgentDir } from "@earendil-works/pi-coding-agent"
import ignore, { type Ignore } from "ignore"
import { DEFAULT_CONFIG, type PiUndoConfig } from "./config.ts"
import { type Runner, runProcess } from "./exec.ts"
import { Mutex } from "./mutex.ts"
import {
  errorMessage,
  gitignoreLiteral,
  listInline,
  literalPathspec,
  type NumstatRow,
  normalizeGitPaths,
  nulSplit,
  pathspecInput,
  toPosix,
  unique,
} from "./util.ts"

// Untracked files above this size are never snapshotted.
const MAX_UNTRACKED_SIZE = 2 * 1024 * 1024
const MAX_LARGE_EXCLUDES = 1000
const STAT_CONCURRENCY = 8
// Paths per command for commands that take paths as arguments.
const ARG_BATCH = 100
const GIT_TIMEOUT_MS = 120_000
const GC_TIMEOUT_MS = 10 * 60_000
const GC_INTERVAL_MS = 24 * 60 * 60 * 1000
const DAY_MS = 24 * 60 * 60 * 1000
// Objects that no ref and no index entry reach are deleted after this grace
// period. Snapshots that checkpoints use are kept alive by refs instead.
const UNREACHABLE_GRACE = "7.days"
const SNAPSHOT_REF_PREFIX = "refs/pi-undo/"
// Back-off delays when another git process (for example a second pi in the
// same directory) holds the shadow index lock.
const LOCK_RETRY_DELAYS_MS = [50, 100, 200, 400, 800, 1600]
const PI_EXCLUDE = [":(exclude).pi", ":(exclude,glob)**/.pi/**"]
const ALL_PATHS = ["--", ".", ...PI_EXCLUDE]

export function snapshotStoreRoot(): string {
  return process.env.PI_UNDO_STORE_ROOT ?? path.join(getAgentDir(), "pi-undo", "snapshots")
}

export type SkipReason = "symlink" | "excluded"

export interface SkippedPath {
  path: string
  reason: SkipReason
}

export interface Partition {
  restorable: string[]
  skipped: SkippedPath[]
}

// The operations undo and redo need. ShadowGit implements it with a shadow
// git repository; tests use fakes.
export interface SnapshotRepo {
  readonly storeDir: string
  ensure(): Promise<void>
  // Snapshots the whole worktree and returns the tree hash. Returns
  // undefined when the snapshot is skipped because of the file cap.
  track(): Promise<string | undefined>
  // Paths that differ between two trees.
  changedFiles(from: string, to: string): Promise<string[]>
  diffNumstat(from: string, to: string): Promise<NumstatRow[]>
  // True when every tree is present in the store.
  hasTrees(trees: readonly string[]): Promise<boolean>
  // Splits paths into the ones a restore may write and the ones it must not
  // touch: paths below a symlinked directory and paths excluded by config.
  partition(paths: readonly string[]): Promise<Partition>
  // Writes a tree that holds the current worktree state of `paths`. Other
  // paths in the tree are unspecified, so compare only `paths`.
  capture(paths: readonly string[]): Promise<string>
  // Makes `paths` in the worktree equal to their state in `tree`: paths in
  // the tree are written, paths not in the tree are deleted.
  restore(tree: string, paths: readonly string[]): Promise<void>
  // Keeps trees from being pruned until the retention period ends.
  protect(trees: readonly string[]): Promise<void>
  gcIfDue(): Promise<void>
}

export class GitError extends Error {
  readonly code: number
  readonly stderr: string

  constructor(args: readonly string[], code: number, stderr: string) {
    super(`git ${args[0] ?? ""} failed: ${stderr.trim() || `exit ${code}`}`)
    this.name = "GitError"
    this.code = code
    this.stderr = stderr
  }
}

interface GitOptions {
  input?: string
  allowFailure?: boolean
  timeoutMs?: number
}

interface GitResult {
  code: number
  stdout: string
  stderr: string
}

// The project's own git repository, when the working directory is in one.
interface SourceRepo {
  // Directory with this worktree's index.
  gitDir: string
  // Directory with the objects; differs from gitDir in linked worktrees.
  commonDir: string
  // Path of the working directory inside the repository; "" at the top.
  prefix: string
}

interface StoreMeta {
  cwd: string
  updatedAt: number
  lastGcAt?: number
  largeExcludes?: string[]
}

export interface ShadowGitOptions {
  cwd: string
  config?: PiUndoConfig
  warn?: (message: string) => void
  runner?: Runner
  storeRoot?: string
}

// A git repository outside the project that snapshots the project's files.
// The project's own git repository (if any) is never written to: its object
// store is only borrowed through alternates so unchanged files cost nothing.
export class ShadowGit implements SnapshotRepo {
  readonly cwd: string
  readonly storeDir: string
  private readonly config: PiUndoConfig
  private readonly runner: Runner
  private readonly mutex = new Mutex()
  private warn: (message: string) => void
  private ready = false
  private source: Promise<SourceRepo | null> | undefined
  private exclude: { content: string; matcher: Ignore } | undefined
  private warnedNested = ""
  private warnedCap = false

  constructor(options: ShadowGitOptions) {
    this.cwd = options.cwd
    this.config = options.config ?? DEFAULT_CONFIG
    this.runner = options.runner ?? runProcess
    this.warn = options.warn ?? (() => {})
    const key = createHash("sha256").update(options.cwd).digest("hex").slice(0, 24)
    this.storeDir = path.join(options.storeRoot ?? snapshotStoreRoot(), key)
  }

  setWarn(warn: (message: string) => void): void {
    this.warn = warn
  }

  ensure(): Promise<void> {
    return this.exclusive(async () => {})
  }

  track(): Promise<string | undefined> {
    return this.exclusive(() => this.trackWorktree())
  }

  changedFiles(from: string, to: string): Promise<string[]> {
    return this.exclusive(async () => {
      const result = await this.git(["diff-tree", "-r", "-z", "--name-only", "--no-renames", from, to, ...ALL_PATHS])
      return unique(normalizeGitPaths(nulSplit(result.stdout)))
    })
  }

  diffNumstat(from: string, to: string): Promise<NumstatRow[]> {
    return this.exclusive(async () => {
      const result = await this.git(["diff-tree", "-r", "-z", "--numstat", "--no-renames", from, to, ...ALL_PATHS])
      return parseNumstat(result.stdout)
    })
  }

  hasTrees(trees: readonly string[]): Promise<boolean> {
    return this.exclusive(async () => {
      for (const tree of unique(trees)) {
        if (!(await this.treeExists(tree))) return false
      }
      return true
    })
  }

  partition(paths: readonly string[]): Promise<Partition> {
    return this.exclusive(async () => {
      const matcher = await this.syncExcludes()
      const restorable: string[] = []
      const skipped: SkippedPath[] = []
      for (const file of unique(normalizeGitPaths(paths))) {
        if (await this.hasSymlinkParent(file)) skipped.push({ path: file, reason: "symlink" })
        else if (matcher.ignores(file)) skipped.push({ path: file, reason: "excluded" })
        else restorable.push(file)
      }
      return { restorable, skipped }
    })
  }

  capture(paths: readonly string[]): Promise<string> {
    return this.exclusive(async () => {
      await this.stageExactly(unique(normalizeGitPaths(paths)))
      return this.writeTree()
    })
  }

  restore(tree: string, paths: readonly string[]): Promise<void> {
    return this.exclusive(() => this.restorePaths(tree, unique(normalizeGitPaths(paths))))
  }

  protect(trees: readonly string[]): Promise<void> {
    return this.exclusive(async () => {
      const stamp = Date.now()
      const input = unique(trees)
        .map((tree) => `update ${SNAPSHOT_REF_PREFIX}${stamp}-${tree} ${tree}\n`)
        .join("")
      if (input) await this.git(["update-ref", "--stdin"], { input })
    })
  }

  // Not run under the mutex: gc can take a while and git keeps it safe next
  // to other git processes. The grace period protects objects that a
  // concurrent track has written but not referenced yet.
  async gcIfDue(): Promise<void> {
    await this.ensure()
    const meta = await this.readMeta()
    if (meta.lastGcAt !== undefined && Date.now() - meta.lastGcAt < GC_INTERVAL_MS) return
    await this.writeMeta({ lastGcAt: Date.now() })
    await this.expireSnapshotRefs()
    // Older versions kept a file-attribution journal here.
    await rm(path.join(this.storeDir, "journal"), { recursive: true, force: true })
    await this.git(["gc", "--quiet", `--prune=${UNREACHABLE_GRACE}`], { allowFailure: true, timeoutMs: GC_TIMEOUT_MS })
  }

  private exclusive<T>(task: () => Promise<T>): Promise<T> {
    return this.mutex.run(async () => {
      await this.prepare()
      return task()
    })
  }

  private async prepare(): Promise<void> {
    if (this.ready) return
    await mkdir(this.storeDir, { recursive: true })
    if (!existsSync(path.join(this.storeDir, "HEAD"))) {
      await this.git(["init", "--quiet"])
      for (const [key, value] of [
        ["core.autocrlf", "false"],
        ["core.longpaths", "true"],
        ["core.symlinks", "true"],
        ["core.fsmonitor", "false"],
        ["core.untrackedCache", "true"],
        ["feature.manyFiles", "true"],
        ["index.version", "4"],
        ["index.threads", "true"],
      ] as const) {
        await this.git(["config", key, value], { allowFailure: true })
      }
      await this.seed()
    }
    // gcIfDue() owns garbage collection. Set on every start so stores made
    // by older versions get it too.
    await this.git(["config", "gc.auto", "0"], { allowFailure: true })
    await this.writeMeta({ updatedAt: Date.now() })
    this.ready = true
  }

  private async trackWorktree(): Promise<string | undefined> {
    await this.syncExcludes()
    await this.dropExcludedFromIndex()
    const [modified, untracked] = await Promise.all([
      this.git(["diff-files", "--name-only", "-z", ...ALL_PATHS]),
      // No --exclude-standard: files that the project's .gitignore ignores
      // are snapshotted too, so the session's edits to them are undoable.
      // Only pi-undo's own patterns filter the listing.
      this.git(["ls-files", "--others", "--full-name", "-z", "--exclude-from", this.excludeFile(), ...ALL_PATHS]),
    ])
    const untrackedEntries = nulSplit(untracked.stdout)
    // ls-files lists an untracked nested repository as "dir/" and does not
    // descend into it. Nested repositories have their own history and are
    // never snapshotted.
    this.reportNested(untrackedEntries.filter((entry) => entry.endsWith("/")))
    const untrackedFiles = normalizeGitPaths(untrackedEntries.filter((entry) => !entry.endsWith("/")))
    const pending = unique([...normalizeGitPaths(nulSplit(modified.stdout)), ...untrackedFiles])

    if (pending.length > this.config.maxFiles) {
      if (!this.warnedCap) {
        this.warnedCap = true
        this.warn(
          `pi-undo: ${pending.length} files to snapshot exceeds the limit (${this.config.maxFiles}); snapshots are skipped. Add patterns to excludeDirectories in pi-undo.json or raise maxFiles.`,
        )
      }
      return undefined
    }

    const large = await this.findLargeFiles(untrackedFiles)
    if (large.length > 0) {
      this.warn(
        `pi-undo: ${large.length} new file(s) over ${MAX_UNTRACKED_SIZE / 1024 / 1024} MB are not snapshotted, so undo cannot remove them: ${listInline(large)}`,
      )
      const meta = await this.readMeta()
      const next = unique([...(meta.largeExcludes ?? []), ...large]).slice(-MAX_LARGE_EXCLUDES)
      await this.writeMeta({ largeExcludes: next })
      await this.syncExcludes()
    }
    const largeSet = new Set(large)
    await this.stageBestEffort(pending.filter((file) => !largeSet.has(file)))
    return this.writeTree()
  }

  private async writeTree(): Promise<string> {
    const result = await this.git(["write-tree"])
    return result.stdout.trim()
  }

  private async treeExists(tree: string): Promise<boolean> {
    const result = await this.git(["cat-file", "-e", `${tree}^{tree}`], { allowFailure: true })
    return result.code === 0
  }

  // Stages the current worktree state of `paths`: existing paths are added,
  // missing paths are removed from the index. Throws on any failure, because
  // callers compare the result against snapshots.
  private async stageExactly(paths: string[]): Promise<void> {
    if (paths.length === 0) return
    const present: string[] = []
    const gone: string[] = []
    for (const file of paths) {
      if (await this.exists(file)) present.push(file)
      else gone.push(file)
    }
    if (gone.length > 0) await this.unstage(gone)
    if (present.length > 0) {
      await this.git(["add", "--all", "--force", "--pathspec-from-file=-", "--pathspec-file-nul"], {
        input: pathspecInput(present),
      })
    }
  }

  // Stages `paths` for a whole-worktree snapshot. A file can vanish between
  // the listing and the add; that is not worth failing the snapshot for.
  private async stageBestEffort(paths: string[]): Promise<void> {
    const failed = await this.stageBisect(paths)
    const real: string[] = []
    for (const file of failed) {
      if (await this.exists(file)) real.push(file)
    }
    if (real.length > 0) this.warn(`pi-undo: could not snapshot ${real.length} file(s): ${listInline(real)}`)
  }

  // Adds `paths` in one command. When that fails, splits the list in halves
  // to find the paths that fail, instead of one command per path. Returns
  // the paths that could not be added.
  private async stageBisect(paths: string[]): Promise<string[]> {
    if (paths.length === 0) return []
    const result = await this.git(["add", "--all", "--force", "--pathspec-from-file=-", "--pathspec-file-nul"], {
      input: pathspecInput(paths),
      allowFailure: true,
    })
    if (result.code === 0) return []
    if (paths.length === 1) return paths
    const middle = Math.ceil(paths.length / 2)
    return [...(await this.stageBisect(paths.slice(0, middle))), ...(await this.stageBisect(paths.slice(middle)))]
  }

  private async unstage(paths: string[]): Promise<void> {
    if (paths.length === 0) return
    await this.git(
      ["rm", "--cached", "-r", "-q", "--ignore-unmatch", "--pathspec-from-file=-", "--pathspec-file-nul"],
      {
        input: pathspecInput(paths),
      },
    )
  }

  private async restorePaths(tree: string, paths: string[]): Promise<void> {
    if (paths.length === 0) return
    // Never delete files based on a tree this store does not have, for
    // example a session resumed in another directory: every path would look
    // absent from the tree and be deleted.
    if (!(await this.treeExists(tree))) throw new Error(`snapshot ${tree.slice(0, 12)} is not in the store`)
    // Checked again right before writing: a directory can become a symlink
    // after partition() ran.
    for (const file of paths) {
      if (await this.hasSymlinkParent(file)) throw new Error(`refusing to write through a symlinked directory: ${file}`)
    }

    const inTree = await this.listTree(tree, paths)
    // Deepest paths first, so a directory is emptied before it is removed.
    const absent = paths.filter((file) => !inTree.has(file)).sort((a, b) => b.length - a.length)
    for (const file of absent) {
      await rm(path.join(this.cwd, file), { recursive: true, force: true })
      await this.removeEmptyParents(file)
    }
    await this.unstage(absent)

    // Shallowest first. A path and its own parent in one checkout would
    // clash, so they go to separate commands.
    const present = paths.filter((file) => inTree.has(file)).sort((a, b) => a.length - b.length)
    for (const group of nonClashingGroups(present)) {
      await this.git(["checkout", "--force", tree, "--pathspec-from-file=-", "--pathspec-file-nul"], {
        input: pathspecInput(group),
      })
    }
  }

  // Removes directories that became empty, up to the project root. Git does
  // not record empty directories, so this matches what git itself does when
  // it deletes files.
  private async removeEmptyParents(file: string): Promise<void> {
    let dir = path.posix.dirname(file)
    while (dir !== "." && dir !== "/" && dir !== "") {
      try {
        await rmdir(path.join(this.cwd, dir))
      } catch {
        return
      }
      dir = path.posix.dirname(dir)
    }
  }

  private async listTree(tree: string, paths: string[]): Promise<Set<string>> {
    const found = new Set<string>()
    for (let i = 0; i < paths.length; i += ARG_BATCH) {
      const chunk = paths.slice(i, i + ARG_BATCH)
      const result = await this.git(["ls-tree", "--name-only", "-z", tree, "--", ...chunk.map(literalPathspec)])
      for (const name of nulSplit(result.stdout)) found.add(name)
    }
    return found
  }

  private async exists(file: string): Promise<boolean> {
    try {
      await lstat(path.join(this.cwd, file))
      return true
    } catch {
      return false
    }
  }

  private async hasSymlinkParent(file: string): Promise<boolean> {
    const parts = file.split("/").slice(0, -1)
    let current = this.cwd
    for (const part of parts) {
      current = path.join(current, part)
      try {
        if ((await lstat(current)).isSymbolicLink()) return true
      } catch {
        return false
      }
    }
    return false
  }

  private reportNested(nested: string[]): void {
    const list = nested.sort().join(", ")
    if (list === this.warnedNested) return
    this.warnedNested = list
    if (nested.length > 0) {
      this.warn(`pi-undo: excluding ${nested.length} nested git repo(s) from snapshots: ${listInline(nested)}`)
    }
  }

  private async findLargeFiles(files: string[]): Promise<string[]> {
    const large: string[] = []
    let next = 0
    const worker = async (): Promise<void> => {
      for (let i = next++; i < files.length; i = next++) {
        const file = files[i]!
        try {
          const info = await stat(path.join(this.cwd, file))
          if (info.isFile() && info.size > MAX_UNTRACKED_SIZE) large.push(file)
        } catch {
          // Deleted between the listing and the stat.
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(STAT_CONCURRENCY, files.length) }, worker))
    return large
  }

  private excludeFile(): string {
    return path.join(this.storeDir, "info", "pi-undo-exclude")
  }

  // Writes pi-undo's exclude file (config patterns plus large files) and
  // returns a matcher for the same rules. The project's own .gitignore is
  // deliberately not part of it.
  private async syncExcludes(): Promise<Ignore> {
    const meta = await this.readMeta()
    const patterns = this.config.excludeDirectories.map(toPosix)
    const configMatcher = ignore().add(patterns)
    const large = (meta.largeExcludes ?? []).map(toPosix).filter((file) => !configMatcher.ignores(file))
    const lines = [...patterns, ...large.map(gitignoreLiteral)]
    const content = `${lines.join("\n")}\n`
    if (this.exclude?.content !== content) {
      await mkdir(path.dirname(this.excludeFile()), { recursive: true })
      await writeFile(this.excludeFile(), content)
      this.exclude = { content, matcher: ignore().add(lines) }
    }
    return this.exclude.matcher
  }

  // Drops index entries that an exclude rule covers. They come from a seeded
  // source index or from before a pattern was added; once in the index they
  // would be snapshotted forever.
  private async dropExcludedFromIndex(): Promise<void> {
    const result = await this.git(["ls-files", "--cached", "--ignored", "--exclude-from", this.excludeFile(), "-z"])
    const stale = normalizeGitPaths(nulSplit(result.stdout))
    if (stale.length > 0) await this.unstage(stale)
  }

  private async expireSnapshotRefs(): Promise<void> {
    const cutoff = Date.now() - this.config.retentionDays * DAY_MS
    const result = await this.git(["for-each-ref", "--format=%(refname)", SNAPSHOT_REF_PREFIX])
    const expired = result.stdout.split("\n").filter((ref) => {
      const stamp = Number.parseInt(ref.slice(SNAPSHOT_REF_PREFIX.length), 10)
      return Number.isFinite(stamp) && stamp < cutoff
    })
    if (expired.length === 0) return
    await this.git(["update-ref", "--stdin"], { input: expired.map((ref) => `delete ${ref}\n`).join("") })
  }

  // Borrows the source repository's objects and index, so a fresh store does
  // not copy and re-hash every tracked file.
  private async seed(): Promise<void> {
    const source = await this.findSource()
    if (!source) return
    const sourceObjects = path.join(source.commonDir, "objects")
    if (!existsSync(sourceObjects)) return
    const alternates = [sourceObjects]
    try {
      const chained = await readFile(path.join(sourceObjects, "info", "alternates"), "utf8")
      for (const line of chained.split("\n")) {
        const candidate = line.trim()
        if (candidate && existsSync(candidate) && !alternates.includes(candidate)) alternates.push(candidate)
      }
    } catch {
      // No chained alternates.
    }
    await mkdir(path.join(this.storeDir, "objects", "info"), { recursive: true })
    await writeFile(path.join(this.storeDir, "objects", "info", "alternates"), `${alternates.join("\n")}\n`)

    // The source index lists paths from the repository top. Below the top
    // they do not match this worktree: every entry would look deleted. A
    // sparse index lists directories instead of files. Neither is a valid
    // starting point.
    if (source.prefix !== "" || (await this.sourceIsSparse())) return
    const sourceIndex = path.join(source.gitDir, "index")
    if (!existsSync(sourceIndex)) return
    const shadowIndex = path.join(this.storeDir, "index")
    try {
      await copyFile(sourceIndex, shadowIndex)
      const check = await this.git(["ls-files", "--cached", "-z"], { allowFailure: true })
      if (check.code !== 0) await rm(shadowIndex, { force: true })
    } catch {
      await rm(shadowIndex, { force: true })
    }
  }

  private findSource(): Promise<SourceRepo | null> {
    this.source ??= this.runner(
      "git",
      ["rev-parse", "--absolute-git-dir", "--path-format=absolute", "--git-common-dir", "--show-prefix"],
      { cwd: this.cwd, timeoutMs: GIT_TIMEOUT_MS },
    ).then((result) => {
      if (result.code !== 0) return null
      const [gitDir, commonDir, prefix = ""] = result.stdout.split("\n")
      if (!gitDir || !commonDir || gitDir === this.storeDir) return null
      return { gitDir, commonDir, prefix }
    })
    return this.source
  }

  private async sourceIsSparse(): Promise<boolean> {
    for (const key of ["core.sparseCheckout", "index.sparse"]) {
      const result = await this.runner("git", ["config", "--get", key], { cwd: this.cwd, timeoutMs: GIT_TIMEOUT_MS })
      if (result.code === 0 && result.stdout.trim() === "true") return true
    }
    return false
  }

  private async git(args: string[], options: GitOptions = {}): Promise<GitResult> {
    const fullArgs = ["--git-dir", this.storeDir, "--work-tree", this.cwd, ...args]
    const runOptions = {
      cwd: this.cwd,
      timeoutMs: options.timeoutMs ?? GIT_TIMEOUT_MS,
      ...(options.input !== undefined ? { input: options.input } : {}),
    }
    let result = await this.runner("git", fullArgs, runOptions)
    for (const delay of LOCK_RETRY_DELAYS_MS) {
      if (result.code === 0 || !isLockContention(result.stderr)) break
      await sleep(delay)
      result = await this.runner("git", fullArgs, runOptions)
    }
    if (result.code !== 0 && !options.allowFailure) throw new GitError(args, result.code, result.stderr)
    return result
  }

  private metaFile(): string {
    return path.join(this.storeDir, "meta.json")
  }

  private async readMeta(): Promise<Partial<StoreMeta>> {
    try {
      const parsed: unknown = JSON.parse(await readFile(this.metaFile(), "utf8"))
      return parsed && typeof parsed === "object" ? (parsed as Partial<StoreMeta>) : {}
    } catch {
      return {}
    }
  }

  private async writeMeta(patch: Partial<StoreMeta>): Promise<void> {
    const meta = { ...(await this.readMeta()), ...patch, cwd: this.cwd }
    try {
      await writeFile(this.metaFile(), JSON.stringify(meta))
    } catch (error) {
      this.warn(`pi-undo: could not write ${this.metaFile()}: ${errorMessage(error)}`)
    }
  }
}

function isLockContention(stderr: string): boolean {
  return /\.lock': File exists|Unable to create '.*\.lock'/.test(stderr)
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// Splits sorted paths into groups where no path is an ancestor of another.
function nonClashingGroups(paths: string[]): string[][] {
  const groups: string[][] = []
  let current: string[] = []
  for (const file of paths) {
    if (current.some((other) => file.startsWith(`${other}/`) || other.startsWith(`${file}/`))) {
      groups.push(current)
      current = []
    }
    current.push(file)
  }
  if (current.length > 0) groups.push(current)
  return groups
}

// Parses `git diff-tree -z --numstat` output. Each record is
// "added\tremoved\tpath\0"; binary files report "-" for both counts.
export function parseNumstat(output: string): NumstatRow[] {
  const rows: NumstatRow[] = []
  for (const record of nulSplit(output)) {
    const [added, removed, ...rest] = record.split("\t")
    const file = normalizeGitPaths([rest.join("\t")])[0]
    if (added === undefined || removed === undefined || file === undefined) continue
    if (added === "-" || removed === "-") {
      rows.push({ file, added: 0, removed: 0, binary: true })
      continue
    }
    const a = Number.parseInt(added, 10)
    const r = Number.parseInt(removed, 10)
    if (Number.isNaN(a) || Number.isNaN(r)) continue
    rows.push({ file, added: a, removed: r, binary: false })
  }
  return rows
}
