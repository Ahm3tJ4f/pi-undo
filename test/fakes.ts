import type { Partition, SnapshotRepo } from "../src/git.ts"
import type { BranchEntry } from "../src/tracker.ts"
import type { NumstatRow } from "../src/util.ts"

// An in-memory SnapshotRepo. Trees are maps from path to content; the
// worktree is a map too. Good enough to drive the command and tracker logic
// without git.
export class FakeRepo implements SnapshotRepo {
  readonly storeDir = "/fake-store"
  readonly worktree = new Map<string, string>()
  readonly trees = new Map<string, Map<string, string>>()
  readonly calls: string[] = []
  readonly protected: string[] = []
  // Hooks to inject failures.
  failTrack: Error | undefined
  skipTrack = false
  failRestore: ((tree: string, paths: readonly string[]) => Error | undefined) | undefined
  excluded = new Set<string>()
  private counter = 0

  async ensure(): Promise<void> {}

  async track(): Promise<string | undefined> {
    this.calls.push("track")
    if (this.failTrack) throw this.failTrack
    if (this.skipTrack) return undefined
    return this.store(new Map(this.worktree))
  }

  async changedFiles(from: string, to: string): Promise<string[]> {
    const a = this.tree(from)
    const b = this.tree(to)
    return [...new Set([...a.keys(), ...b.keys()])].filter((file) => a.get(file) !== b.get(file)).sort()
  }

  async diffNumstat(from: string, to: string): Promise<NumstatRow[]> {
    return (await this.changedFiles(from, to)).map((file) => ({ file, added: 1, removed: 1, binary: false }))
  }

  async hasTrees(trees: readonly string[]): Promise<boolean> {
    return trees.every((tree) => this.trees.has(tree))
  }

  async partition(paths: readonly string[]): Promise<Partition> {
    return {
      restorable: paths.filter((file) => !this.excluded.has(file)),
      skipped: paths.filter((file) => this.excluded.has(file)).map((file) => ({ path: file, reason: "excluded" as const })),
    }
  }

  // Unlike git, the fake's capture holds every path; callers only compare
  // the paths they asked for, so the difference does not matter.
  async capture(_paths: readonly string[]): Promise<string> {
    return this.store(new Map(this.worktree))
  }

  async restore(tree: string, paths: readonly string[]): Promise<void> {
    this.calls.push(`restore:${tree}:${[...paths].sort().join(",")}`)
    const error = this.failRestore?.(tree, paths)
    if (error) throw error
    const source = this.tree(tree)
    for (const file of paths) {
      const content = source.get(file)
      if (content === undefined) this.worktree.delete(file)
      else this.worktree.set(file, content)
    }
  }

  async protect(trees: readonly string[]): Promise<void> {
    this.protected.push(...trees)
  }

  async gcIfDue(): Promise<void> {}

  // Stores a tree and returns its id.
  store(files: Map<string, string>): string {
    const id = `t${++this.counter}`
    this.trees.set(id, files)
    return id
  }

  private tree(id: string): Map<string, string> {
    const tree = this.trees.get(id)
    if (!tree) throw new Error(`no tree ${id}`)
    return tree
  }
}

export function userEntry(id: string): BranchEntry {
  return { id, type: "message", message: { role: "user" } }
}

export function assistantEntry(id: string): BranchEntry {
  return { id, type: "message", message: { role: "assistant" } }
}

export function entry(id: string, type: string): BranchEntry {
  return { id, type }
}

export interface FakeSession {
  branch: BranchEntry[]
  leafId(): string | null
  getLeafId(): string | null
  getBranch(): BranchEntry[]
  append(entry: BranchEntry): void
}

// A linear session branch. `append` adds an entry and moves the leaf to it.
export function fakeSession(initial: BranchEntry[] = []): FakeSession {
  const session: FakeSession = {
    branch: [...initial],
    leafId: () => session.branch.at(-1)?.id ?? null,
    getLeafId: () => session.leafId(),
    getBranch: () => session.branch,
    append: (item) => void session.branch.push(item),
  }
  return session
}

export interface FakeUi {
  notifications: { message: string; level: string | undefined }[]
  confirms: { title: string; message: string }[]
  answers: boolean[]
  editor: string
  notify(message: string, level?: "info" | "warning" | "error"): void
  confirm(title: string, message: string): Promise<boolean>
  getEditorText(): string
  setEditorText(text: string): void
}

// Confirms answer from `answers` in order, then true.
export function fakeUi(): FakeUi {
  return {
    notifications: [],
    confirms: [],
    answers: [],
    editor: "",
    notify(message, level) {
      this.notifications.push({ message, level })
    },
    async confirm(title, message) {
      this.confirms.push({ title, message })
      return this.answers.shift() ?? true
    },
    getEditorText() {
      return this.editor
    },
    setEditorText(text) {
      this.editor = text
    },
  }
}
