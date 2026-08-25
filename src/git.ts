import { createHash } from "node:crypto"
import { existsSync, realpathSync, rmSync, statSync, unlinkSync } from "node:fs"
import type { Dirent } from "node:fs"
import { copyFile, lstat, mkdir, readFile, readdir, rm, stat as fsStat, writeFile } from "node:fs/promises"
import { homedir, tmpdir } from "node:os"
import path from "node:path"
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import ignore from "ignore"
import { DEFAULT_CONFIG, type PiUndoConfig } from "./config.ts"
import type { NumstatRow } from "./util.ts"
import { literalPathspec, normalizeGitPath, nulSplit, unique } from "./util.ts"

const MAX_UNTRACKED_SIZE = 2 * 1024 * 1024

const PRUNE = "7.days"

const BATCH = 100
const GIT_TIMEOUT = 120_000

// Staging a first-ever capture over a huge worktree can legitimately run
// for minutes. Those calls happen outside any turn handler (bounded
// capture), so give them a generous ceiling instead of killing git
// mid-write, which would strand an index.lock behind.
export const ADD_TIMEOUT = 600_000

// Remove a shadow index.lock left behind by a git process that was killed
// mid-run (machine sleep, forced exit). Locks younger than this are left
// alone: another live pi session may legitimately hold them.
const LOCK_STALE_MS = 10 * 60 * 1000

// Housekeeping thresholds ported from omp-undo-redo#54: a background
// `git gc` every N captures, and startup eviction of stores whose
// workspace no longer exists.
export const GC_AFTER_CAPTURES = 20
const GC_INTERVAL_MS = 24 * 60 * 60 * 1000

const PI_EXCLUDE: string[] = [":(exclude).pi", ":(exclude,glob)**/.pi/**"]

const MAX_LARGE_EXCLUDES = 1000
const STAT_CONCURRENCY = 8
const MAX_NESTED_SCAN = 5000

interface GitResult {
  stdout: string
  stderr: string
  code: number
}

interface GitOptions {
  allowFailure?: boolean
  timeout?: number | undefined
}

interface StoreMeta {
  cwd: string
  updatedAt: number
  lastGcAt?: number
  largeExcludes?: string[]
}

export function snapshotStoreRoot(): string {
  return process.env.PI_UNDO_STORE_ROOT ?? path.join(homedir(), ".pi", "agent", "pi-undo", "snapshots")
}

export interface RestoreResult {
  skipped: string[]
  excluded: string[]
  manualSkipped: string[]
}

export interface DiffStatResult {
  rows: NumstatRow[]
  binaryCount: number
}

export interface SnapshotRepo {
  ensure(): Promise<void>
  track(): Promise<string | undefined>
  changedFiles(from: string, to: string): Promise<string[]>
  readonly storeDir: string
  dirtySinceAll(snapshot: string): Promise<{ manual: string[]; ignored: string[] }>
  restoreSnapshot(
    snapshot: string,
    files: string[],
    since?: string,
    opts?: { manualSet?: ReadonlySet<string>; force?: boolean },
  ): Promise<RestoreResult>
  verifySnapshot(snapshot: string, exclude?: string[]): Promise<boolean>
  diffNumstat(from: string, to: string): Promise<DiffStatResult>
  gcIfDue(): Promise<void>
}

export class ShadowGit implements SnapshotRepo {
  readonly cwd: string
  private readonly pi: Pick<ExtensionAPI, "exec">
  private readonly gitdir: string
  private readonly config: PiUndoConfig
  private initialized = false
  private warn: (message: string) => void
  private warnedExcludes = ""
  private capturesSinceGc = 0

  constructor(
    pi: Pick<ExtensionAPI, "exec">,
    cwd: string,
    warn: (message: string) => void = () => {},
    config: PiUndoConfig = DEFAULT_CONFIG,
  ) {
    this.pi = pi
    // Canonicalize once: every store key and path comparison derives from
    // this. Without it, a workspace spelled in Windows 8.3 short form (or
    // reached through a differing symlink) hashes to a second shadow store,
    // and checkpoints recorded against one store fail tree lookups in the
    // other ("snapshot tree not found").
    this.cwd = canonicalizePath(cwd)
    this.warn = warn
    this.config = config
    const key = createHash("sha256").update(this.cwd).digest("hex").slice(0, 24)
    this.gitdir = path.join(canonicalizePath(snapshotStoreRoot()), key)
  }

  setWarn(warn: (message: string) => void): void {
    this.warn = warn
  }

  get storeDir(): string {
    return this.gitdir
  }

  // A git process killed mid-add strands index.lock and every later git
  // call fails until it is removed. Clear only provably dead locks.
  private clearStaleLock(): void {
    const lock = path.join(this.gitdir, "index.lock")
    try {
      if (!existsSync(lock)) return
      if (Date.now() - statSync(lock).mtimeMs < LOCK_STALE_MS) return
      unlinkSync(lock)
    } catch {
      // Best effort: a live lock survives; git surfaces it on the next call.
    }
  }

  async ensure(): Promise<void> {
    if (this.initialized) return
    await mkdir(this.gitdir, { recursive: true })
    const existed = existsSync(path.join(this.gitdir, "HEAD"))
    if (!existed) {
      const init = await this.git(["init", "--quiet"], { allowFailure: true })
      if (init.code !== 0) {
        throw new Error(`git init failed: ${init.stderr.trim() || `exit ${init.code}`}`)
      }
      const configs: string[][] = [
        ["config", "core.autocrlf", "false"],
        ["config", "core.longpaths", "true"],
        ["config", "core.symlinks", "true"],
        ["config", "core.fsmonitor", "false"],
        ["config", "feature.manyFiles", "true"],
        ["config", "index.version", "4"],
        ["config", "index.threads", "true"],
        ["config", "core.untrackedCache", "true"],
      ]
      for (const args of configs) {
        await this.git(args, { allowFailure: true })
      }
      await this.seed()
      // The exclude files exist from the very first moment so the snapshot
      // store can never become a capture subject (the home-directory
      // case), even before any track has run.
      await this.syncExcludes()
    }
    this.clearStaleLock()
    await this.writeMeta({ updatedAt: Date.now() })
    this.initialized = true
  }

  async track(): Promise<string | undefined> {
    await this.ensure()
    await this.add()
    const result = await this.git(["write-tree"])
    const tree = result.stdout.trim()
    if (tree) {
      this.capturesSinceGc += 1
      if (this.capturesSinceGc >= GC_AFTER_CAPTURES) {
        this.capturesSinceGc = 0
        // Fire-and-forget: a slow gc must never sit inside a turn handler's
        // deadline budget. A concurrent capture makes the gc fail on its
        // lock (allowFailure), which just defers it to the next threshold.
        void this.gc().catch(() => {})
      }
    }
    return tree || undefined
  }

  async changedFiles(from: string, to: string): Promise<string[]> {
    await this.ensure()
    const result = await this.git(
      ["diff", "--name-only", "-z", "--no-renames", from, to, "--", ".", ...PI_EXCLUDE],
      { allowFailure: true },
    )
    if (result.code !== 0) return []
    return unique(nulSplit(result.stdout).map(normalizeGitPath).filter((f): f is string => Boolean(f)))
  }

  async dirtySinceAll(snapshot: string): Promise<{ manual: string[]; ignored: string[] }> {
    return this.dirtyLists(snapshot)
  }

  // Splits the files changed since `snapshot` into two groups: `manual` are
  // files undo may clobber (they trigger the manual-edit dialog), `ignored`
  // are files matched by an exclude rule (our patterns, the project's own
  // .gitignore, or the source repo's info/exclude). Manual edits to ignored
  // files trigger the same prompt as manual edits to tracked files; they are
  // never reverted without a confirmation.
  private async dirtyLists(snapshot: string): Promise<{ manual: string[]; ignored: string[] }> {
    await this.ensure()
    const meta = await this.readMeta()
    await this.syncExcludes(meta.largeExcludes ?? [])
    const [worktree, staged, untracked] = await Promise.all([
      this.git(["diff-files", "--name-only", "-z", "--", ".", ...PI_EXCLUDE], { allowFailure: true }),
      this.git(["diff", "--cached", "--name-only", "-z", snapshot, "--", ".", ...PI_EXCLUDE], {
        allowFailure: true,
      }),
      // No --exclude-standard: a gitignored file deleted by the session
      // leaves the index, and a hand recreated copy would be invisible if we
      // filtered by the project's ignore rules here. Use pi-undo's own
      // exclude file instead; checkIgnored below then classifies the still
      // visible gitignored files into the `ignored` group, so manual
      // recreations after a session deletion are protected.
      this.git(["ls-files", "--full-name", "--others", "--exclude-from", this.excludeFile(), "-z", "--", ".", ...PI_EXCLUDE], {
        allowFailure: true,
      }),
    ])
    const tracked = [...nulSplit(worktree.stdout), ...nulSplit(staged.stdout)]
      .map(normalizeGitPath)
      .filter((f): f is string => Boolean(f))
    // Untracked nested git repos are reported as dir/ entries. They are never
    // staged into snapshots, so they cannot be manual edits over a snapshot
    // and must not block undo. Untracked gitignored files stay visible (the
    // listing uses pi-undo's exclude file, not --exclude-standard), so a
    // gitignored file the session deleted and the user then recreated by hand
    // is detected as a manual edit instead of being clobbered.
    const untrackedFiles = nulSplit(untracked.stdout)
      .map(normalizeGitPath)
      .filter((f): f is string => f !== undefined && !f.endsWith("/"))
    const merged = unique([...tracked, ...untrackedFiles])
    if (merged.length === 0) return { manual: [], ignored: [] }
    const ignored = await this.checkIgnored(merged)
    const ignoredSet = new Set(ignored)
    return {
      manual: merged.filter((file) => !ignoredSet.has(file)),
      ignored: merged.filter((file) => ignoredSet.has(file)),
    }
  }

  async restoreSnapshot(
    snapshot: string,
    files: string[],
    since?: string,
    opts: { manualSet?: ReadonlySet<string>; force?: boolean } = {},
  ): Promise<RestoreResult> {
    await this.ensure()
    // Make sure info/exclude reflects the current config and large-file
    // excludes before the ignore checks below: callers do not always go
    // through track() or dirtySinceAll first.
    const meta = await this.readMeta()
    await this.syncExcludes(meta.largeExcludes ?? [])
    const rels = unique(files.map(normalizeGitPath).filter((f): f is string => Boolean(f)))
    if (rels.length === 0) return { skipped: [], excluded: [], manualSkipped: [] }

    const blocked: string[] = []
    const excluded: string[] = []
    const manualSkipped: string[] = []
    const safe: string[] = []
    // Files that match a current pi-undo exclude rule are not part of any new
    // snapshot, so restoring them from an old tree would clobber manual edits
    // (the transition window after an exclude rule appears). Skip them like
    // symlink-blocked files. Files ignored only by the project's own
    // .gitignore ARE part of new snapshots, so they are restored normally.
    const matcher = ignore().add([
      ...this.config.excludeDirectories,
      ...(meta.largeExcludes ?? []).map((file) => `/${file.replaceAll("\\", "/")}`),
    ])
    // Manual edits to gitignored files are never reverted: when `since` is
    // given (the other snapshot of the message), files that are ignored AND
    // changed since that snapshot are left alone, even if the session edited
    // them in the message being undone.
    const manualSet = opts.force
      ? new Set<string>()
      : opts.manualSet
        ? new Set(opts.manualSet)
        : since
          ? new Set((await this.dirtyLists(since)).ignored)
          : new Set<string>()
    for (const rel of rels) {
      if (await this.hasSymlinkParent(rel)) blocked.push(rel)
      else if (matcher.ignores(rel)) excluded.push(rel)
      else if (manualSet.has(rel)) manualSkipped.push(rel)
      else safe.push(rel)
    }
    if (blocked.length > 0) {
      await this.dropPaths(blocked)
    }
    if (excluded.length > 0) {
      await this.dropPaths(excluded)
    }
    if (safe.length === 0) return { skipped: blocked, excluded, manualSkipped }

    // Never delete files based on a tree this store does not have (for
    // example a session resumed in a different directory). ls-tree on a
    // missing tree returns nothing, which would turn every file into
    // "missing" and delete it.
    const treeOk = await this.git(["cat-file", "-e", `${snapshot}^{tree}`], { allowFailure: true })
    if (treeOk.code !== 0) {
      throw new Error(`snapshot tree not found in this store: ${snapshot}`)
    }

    const inTree = await this.listTree(snapshot, safe)
    const missing = safe.filter((rel) => !inTree.has(rel))
    const present = safe.filter((rel) => inTree.has(rel))

    const deleted: string[] = []
    for (const rel of [...missing].sort((a, b) => b.length - a.length)) {
      try {
        await rm(path.join(this.cwd, rel), { recursive: true, force: true })
        deleted.push(rel)
      } catch {
        // Best effort: the file may already be gone.
      }
    }
    if (deleted.length > 0) await this.stagePaths(deleted)

    await this.checkoutPaths(snapshot, [...present].sort((a, b) => a.length - b.length))
    return { skipped: blocked, excluded, manualSkipped }
  }

  private async hasSymlinkParent(rel: string): Promise<boolean> {
    let current = this.cwd
    const parts = rel.split("/")
    for (let i = 0; i < parts.length - 1; i++) {
      const part = parts[i]
      if (!part) continue
      current = path.join(current, part)
      try {
        if ((await lstat(current)).isSymbolicLink()) return true
      } catch {
        return false
      }
    }
    return false
  }

  async verifySnapshot(snapshot: string, exclude: string[] = []): Promise<boolean> {
    await this.ensure()
    if (exclude.length === 0) {
      const result = await this.git(["write-tree"], { allowFailure: true })
      return result.code === 0 && result.stdout.trim() === snapshot
    }
    const result = await this.git(
      ["diff", "--cached", "--name-only", "-z", snapshot, "--", ".", ...PI_EXCLUDE],
      { allowFailure: true },
    )
    if (result.code !== 0) return false
    const excluded = new Set(exclude)
    return nulSplit(result.stdout)
      .map(normalizeGitPath)
      .filter((f): f is string => Boolean(f))
      .every((file) => excluded.has(file))
  }

  async diffNumstat(from: string, to: string): Promise<DiffStatResult> {
    await this.ensure()
    const result = await this.git(
      ["diff", "--numstat", "-z", "--no-renames", "--no-ext-diff", from, to, "--", ".", ...PI_EXCLUDE],
      { allowFailure: true },
    )
    if (result.code !== 0) return { rows: [], binaryCount: 0 }
    const rows: NumstatRow[] = []
    let binaryCount = 0
    for (const record of result.stdout.split("\0").filter(Boolean)) {
      const fields = record.split("\t")
      const added = fields[0]
      const removed = fields[1]
      const file = fields.slice(2).join("\t")
      if (added === undefined || removed === undefined || !file) continue
      if (added === "-" || removed === "-") {
        binaryCount++
        continue
      }
      const a = Number.parseInt(added, 10)
      const r = Number.parseInt(removed, 10)
      if (Number.isNaN(a) || Number.isNaN(r)) continue
      rows.push({ file: normalizeGitPath(file) ?? file, added: a, removed: r })
    }
    return { rows, binaryCount }
  }

  async gcIfDue(): Promise<void> {
    await this.ensure()
    const meta = await this.readMeta()
    if (meta.lastGcAt !== undefined && Date.now() - meta.lastGcAt < GC_INTERVAL_MS) return
    await this.gc()
  }

  private async gc(): Promise<void> {
    const result = await this.git(["gc", `--prune=${PRUNE}`], { allowFailure: true })
    if (result.code !== 0) return
    await this.writeMeta({ lastGcAt: Date.now() })
  }

  private async git(args: string[], opts: GitOptions = {}): Promise<GitResult> {
    const result = await this.pi.exec(
      "git",
      ["--git-dir", this.gitdir, "--work-tree", this.cwd, ...args],
      { cwd: this.cwd, timeout: opts.timeout ?? GIT_TIMEOUT },
    )
    if (!opts.allowFailure && result.code !== 0) {
      throw new Error(`git ${args[0] ?? ""} failed: ${result.stderr.trim() || `exit ${result.code}`}`)
    }
    return { stdout: result.stdout, stderr: result.stderr, code: result.code }
  }

  private async sourceGitDir(): Promise<string | null> {
    const result = await this.pi.exec("git", ["rev-parse", "--absolute-git-dir"], { cwd: this.cwd })
    if (result.code !== 0) return null
    const dir = result.stdout.trim()
    if (!dir || dir === this.gitdir) return null
    return dir
  }

  private async seed(): Promise<void> {
    const source = await this.sourceGitDir()
    if (!source) return

    const sourceObjects = path.join(source, "objects")
    if (!existsSync(sourceObjects)) return
    const alternates = [sourceObjects]
    try {
      const chained = await readFile(path.join(sourceObjects, "info", "alternates"), "utf8")
      for (const line of chained.split("\n")) {
        const candidate = line.trim()
        if (candidate && existsSync(candidate) && !alternates.includes(candidate)) {
          alternates.push(candidate)
        }
      }
    } catch {
      // No chained alternates.
    }
    await mkdir(path.join(this.gitdir, "objects", "info"), { recursive: true })
    await writeFile(path.join(this.gitdir, "objects", "info", "alternates"), alternates.join("\n") + "\n")

    if (await this.sourceHasSparseCheckout()) return
    const sourceIndex = path.join(source, "index")
    if (!existsSync(sourceIndex)) return
    try {
      await copyFile(sourceIndex, path.join(this.gitdir, "index"))
      const check = await this.git(["ls-files"], { allowFailure: true })
      if (check.code !== 0) {
        await rm(path.join(this.gitdir, "index"), { force: true })
      }
    } catch {
      await rm(path.join(this.gitdir, "index"), { force: true })
    }
  }

  private async sourceHasSparseCheckout(): Promise<boolean> {
    for (const key of ["core.sparseCheckout", "index.sparse"]) {
      const result = await this.pi.exec("git", ["config", "--get", key], { cwd: this.cwd })
      if (result.code === 0 && result.stdout.trim() === "true") return true
    }
    return false
  }

  private async add(): Promise<void> {
    const meta = await this.readMeta()
    const largeExcludes = meta.largeExcludes ?? []
    await this.syncExcludes(largeExcludes)
    // Files tracked before an exclude directory was configured (or before
    // this cleanup existed) stay in the index forever, bloat every snapshot
    // and surface as false manual edits. Drop them before the listings so
    // they never enter a snapshot again. Gitignored files are NOT dropped:
    // the current pi session's edits to them must stay undoable.
    await this.dropTrackedUnderExcludedDirs()
    const [changed, untracked] = await Promise.all([
      this.git(["diff-files", "--name-only", "-z", "--", ".", ...PI_EXCLUDE], { allowFailure: true }),
      // No --exclude-standard: files ignored by the project's own .gitignore
      // are snapshotted too, so the session's edits to them are undoable.
      // Only pi-undo's own patterns (excludeDirectories, large files) filter
      // the listing, via the pi-undo-exclude file.
      this.git(["ls-files", "--full-name", "--others", "-z", "--exclude-from", this.excludeFile(), "--", ".", ...PI_EXCLUDE], {
        allowFailure: true,
      }),
    ])
    const changedList = nulSplit(changed.stdout)
      .map(normalizeGitPath)
      .filter((f): f is string => Boolean(f))
    const untrackedList = nulSplit(untracked.stdout)
      .map(normalizeGitPath)
      .filter((f): f is string => Boolean(f))
    const all = unique([...changedList, ...untrackedList])
    if (all.length === 0) return

    const nested = new Set<string>()
    for (const file of all) {
      if (!file.endsWith("/")) continue
      if (await this.containsNestedRepo(file)) nested.add(file)
    }
    if (nested.size > 0) {
      const list = [...nested].sort().join(", ")
      if (this.warnedExcludes !== list) {
        this.warnedExcludes = list
        this.warn(`pi-undo: excluding ${nested.size} nested git repo(s) from snapshot: ${list}`)
      }
    } else if (this.warnedExcludes !== "") {
      this.warnedExcludes = ""
    }
    const allowAll = all.filter((file) => !nested.has(file))
    if (allowAll.length === 0) return


    const untrackedSet = new Set(untrackedList)
    const large = await this.findLargeFiles(allowAll.filter((file) => untrackedSet.has(file)))
    if (large.size > 0) {
      const next = unique([...largeExcludes, ...large]).slice(0, MAX_LARGE_EXCLUDES)
      await this.writeMeta({ largeExcludes: next })
      await this.syncExcludes(next)
    }

    await this.stagePaths(allowAll.filter((file) => !large.has(file)))
  }

  private async checkIgnored(files: string[]): Promise<Set<string>> {
    const ignored = new Set<string>()
    for (let i = 0; i < files.length; i += BATCH) {
      const chunk = files.slice(i, i + BATCH)
      const result = await this.git(
        [
          "-c",
          "core.quotepath=false",
          "check-ignore",
          "--no-index",
          ...chunk.map((file) => (file.startsWith(":") ? `./${file}` : file)),
        ],
        { allowFailure: true },
      )
      // Exit 0 means at least one path is ignored, 1 means none are.
      if (result.code === 0 || result.code === 1) {
        for (const file of result.stdout.split("\n").filter(Boolean)) {
          ignored.add(file.startsWith("./:") ? file.slice(2) : file)
        }
      }
    }
    return ignored
  }

  private async stagePaths(files: string[]): Promise<void> {
    if (files.length === 0) return
    // -f: gitignored files are snapshotted too, and plain "git add" skips them.
    if (await this.tryPathspec(["add", "-f", "--all", "--sparse"], files, ADD_TIMEOUT)) return

    const failed: string[] = []
    for (const file of files) {
      if (!(await this.tryPathspec(["add", "-f", "--all", "--sparse"], [file], ADD_TIMEOUT))) failed.push(file)
    }
    if (failed.length > 0) {
      this.warn(`pi-undo: could not stage ${failed.length} path(s) for snapshot: ${failed.join(", ")}`)
    }
  }

  private async tryPathspec(command: string[], files: string[], timeout?: number): Promise<boolean> {
    if (files.length === 0) return true
    const specFile = path.join(
      tmpdir(),
      `pi-undo-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.paths`,
    )
    await writeFile(specFile, files.map(literalPathspec).join("\0") + "\0")
    try {
      const result = await this.git(
        [...command, `--pathspec-from-file=${specFile}`, "--pathspec-file-nul"],
        { allowFailure: true, timeout },
      )
      return result.code === 0
    } finally {
      await rm(specFile, { force: true })
    }
  }

  private async containsNestedRepo(rel: string): Promise<boolean> {
    const stack = [path.join(this.cwd, rel)]
    let visited = 0
    while (stack.length > 0) {
      if (++visited > MAX_NESTED_SCAN) return true
      const dir = stack.pop()!
      let entries: Dirent[]
      try {
        entries = await readdir(dir, { withFileTypes: true })
      } catch {
        continue
      }
      for (const entry of entries) {
        if (entry.name === ".git") return true
        if (entry.isDirectory()) stack.push(path.join(dir, entry.name))
      }
    }
    return false
  }

  private async dropPaths(files: string[]): Promise<void> {
    await this.gitWithPathspec(["rm", "--cached", "-f", "--ignore-unmatch"], files)
  }

  private async gitWithPathspec(command: string[], files: string[]): Promise<void> {
    if (files.length === 0) return
    const specFile = path.join(tmpdir(), `pi-undo-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.paths`)
    await writeFile(specFile, files.map(literalPathspec).join("\0") + "\0")
    try {
      const result = await this.git(
        [...command, `--pathspec-from-file=${specFile}`, "--pathspec-file-nul"],
        { allowFailure: true },
      )
      if (result.code !== 0) {
        throw new Error(`${command[0] ?? "git"} failed: ${result.stderr.trim() || `exit ${result.code}`}`)
      }
    } finally {
      await rm(specFile, { force: true })
    }
  }

  private async listTree(tree: string, paths: string[]): Promise<Set<string>> {
    const found = new Set<string>()
    for (let i = 0; i < paths.length; i += BATCH) {
      const chunk = paths.slice(i, i + BATCH)
      const result = await this.git(
        ["ls-tree", "--name-only", "-z", tree, "--", ...chunk.map(literalPathspec)],
        { allowFailure: true },
      )
      if (result.code !== 0) continue
      for (const name of nulSplit(result.stdout)) found.add(name)
    }
    return found
  }

  private async checkoutPaths(tree: string, paths: string[]): Promise<void> {
    for (const group of this.chunkNonClashing(paths)) {
      const result = await this.git(
        ["checkout", "-f", tree, "--", ...group.map(literalPathspec)],
        { allowFailure: true },
      )
      if (result.code === 0) continue
      for (const file of group) {
        const single = await this.git(["checkout", "-f", tree, "--", literalPathspec(file)], {
          allowFailure: true,
        })
        if (single.code !== 0) {
          throw new Error(`failed to restore ${file}: ${single.stderr.trim() || `exit ${single.code}`}`)
        }
      }
    }
  }

  private chunkNonClashing(paths: string[]): string[][] {
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

  private excludeFile(): string {
    return path.join(this.gitdir, "info", "pi-undo-exclude")
  }

  private async syncExcludes(extra: string[] = []): Promise<void> {
    const source = await this.sourceGitDir()
    let text = ""
    if (source) {
      const excludePath = path.join(source, "info", "exclude")
      if (existsSync(excludePath)) {
        text = (await readFile(excludePath, "utf8")).trimEnd()
      }
    }
    // Entries are written as-is: full gitignore glob syntax, no leading slash
    // (so plain names match at any depth) and no forced trailing slash (so
    // "node_modules/" keeps its gitignore meaning of directories only, and
    // never becomes the unmatched "node_modules//"). A home-directory
    // snapshot contains projects in subdirectories
    // (github/<repo>/node_modules/...), so a root-anchored /node_modules/
    // would let every one of those nested copies into the snapshot.
    const configLines = this.config.excludeDirectories.map((name) => name.replaceAll("\\", "/"))
    // The snapshot store itself is never a snapshot subject: when pi runs
    // with its state directory inside the workspace (the home-directory
    // case), a capture that swallowed it would chase its own growing
    // output forever. Seed the store root as a relative ignore when it
    // lives in the worktree; skip the entry when it does not.
    const relStore = path.relative(this.cwd, this.gitdir)
    const storeLines =
      relStore && relStore !== "." && !relStore.startsWith("..") && !path.isAbsolute(relStore)
        ? [`/${relStore.replaceAll("\\", "/")}/`]
        : []
    // Keep only the large-file excludes that no config pattern covers.
    // Entries covered by a config pattern are redundant; entries covered only
    // by the project's own ignore rules are still needed, because gitignored
    // files are snapshotted and would be re-detected on every track.
    const matcher = ignore().add(configLines)
    const largeLines = extra
      .filter((file) => !matcher.ignores(file.replaceAll("\\", "/")))
      .map((file) => `/${file.replaceAll("\\", "/")}`)
    // info/exclude feeds git's own ignore matching for the manual-edit guard:
    // it must cover the source repo's local excludes too, so manual edits to
    // any gitignored file never block undo.
    const lines: string[] = text ? text.split("\n") : []
    lines.push(...configLines, ...largeLines, ...storeLines)
    await mkdir(path.join(this.gitdir, "info"), { recursive: true })
    await writeFile(path.join(this.gitdir, "info", "exclude"), lines.join("\n") + "\n")
    // pi-undo-exclude feeds the snapshot side (staging filters): only
    // pi-undo's own patterns, never the project's gitignore rules.
    await writeFile(this.excludeFile(), [...configLines, ...largeLines, ...storeLines].join("\n") + "\n")
  }

  // Removes from the index any tracked file that a pi-undo exclude rule
  // (excludeDirectories or a large-file rule) considers ignored. Such files
  // were staged before directory exclusions worked at every depth
  // (root-anchored patterns) or came from a seeded source index; once tracked
  // they never honor info/exclude and would be snapshotted and reported as
  // manual edits forever. Delegating to git's own matcher (ls-files -i with
  // the pi-undo-exclude file) means glob patterns in excludeDirectories are
  // honored for free. Files ignored by the project's own .gitignore are kept:
  // the session's edits to them stay undoable.
  private async dropTrackedUnderExcludedDirs(): Promise<void> {
    const result = await this.git(
      ["ls-files", "-c", "-i", "--exclude-from", this.excludeFile(), "--full-name", "-z"],
      { allowFailure: true },
    )
    if (result.code !== 0) return
    const stale = nulSplit(result.stdout)
      .map(normalizeGitPath)
      .filter((f): f is string => Boolean(f))
    if (stale.length === 0) return
    await this.dropPaths(stale)
  }

  private async findLargeFiles(files: string[]): Promise<Set<string>> {
    const large = new Set<string>()
    let next = 0
    const worker = async () => {
      while (true) {
        const i = next++
        const file = files[i]
        if (file === undefined) return
        try {
          const info = await fsStat(path.join(this.cwd, file))
          if (info.isFile() && info.size > MAX_UNTRACKED_SIZE) large.add(file)
        } catch {
          // Deleted between the walk and the stat; skip.
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(STAT_CONCURRENCY, files.length) }, worker))
    return large
  }

  private metaFile(): string {
    return path.join(this.gitdir, "meta.json")
  }

  private async readMeta(): Promise<Partial<StoreMeta>> {
    try {
      return JSON.parse(await readFile(this.metaFile(), "utf8")) as Partial<StoreMeta>
    } catch {
      return {}
    }
  }

  private async writeMeta(patch: Partial<StoreMeta>): Promise<void> {
    const meta = { cwd: this.cwd, ...(await this.readMeta()), ...patch }
    await writeFile(this.metaFile(), JSON.stringify(meta)).catch(() => {})
  }
}

/** One canonical spelling of a path: the realpath when it exists, the
 *  resolved absolute path otherwise. Windows 8.3 short names and symlinked
 *  parents yield different strings for one directory; every store key and
 *  comparison in pi-undo goes through here so those spellings cannot fork
 *  the state into two shadow stores. */
export function canonicalizePath(target: string): string {
  try {
    return realpathSync(target)
  } catch {
    return path.resolve(target)
  }
}

/** Removes stores whose workspace no longer exists (workspaces come and
 *  go; their shadow repos would otherwise accumulate forever). Best-effort
 *  and retried; stores without a readable meta.json are kept — eviction
 *  never guesses. */
export async function evictStaleStores(root: string = snapshotStoreRoot()): Promise<number> {
  let entries: Dirent[]
  try {
    entries = await readdir(root, { withFileTypes: true })
  } catch {
    return 0
  }
  let evicted = 0
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const dir = path.join(root, entry.name)
    let cwd: unknown
    try {
      cwd = (JSON.parse(await readFile(path.join(dir, "meta.json"), "utf8")) as { cwd?: unknown }).cwd
    } catch {
      continue
    }
    if (typeof cwd !== "string" || cwd.length === 0) continue
    try {
      statSync(cwd)
      continue
    } catch (error) {
      // Only a proven-missing workspace makes the store droppable. EIO,
      // EACCES or ENODEV mean the volume is merely unreachable right now
      // (VPN down, sleeping disk) — evicting then would destroy undo
      // history for a workspace that still exists.
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") continue
    }
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        rmSync(dir, { recursive: true, force: true })
        evicted++
        break
      } catch {
        // A concurrent git child may still hold the directory; retry.
        await new Promise((resolve) => setTimeout(resolve, 50 * (attempt + 1)))
      }
    }
  }
  return evicted
}
