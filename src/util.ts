export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function nulSplit(text: string): string[] {
  return text.split("\0").filter(Boolean)
}

export function unique<T>(values: Iterable<T>): T[] {
  return [...new Set(values)]
}

export function toPosix(file: string): string {
  return file.replaceAll("\\", "/")
}

// Returns the path in posix form when it is a safe path inside the project,
// or undefined. pi's own `.pi` directories are never part of a snapshot.
export function normalizeGitPath(file: string): string | undefined {
  if (!file || file.includes("\0")) return undefined
  const normalized = toPosix(file)
  if (normalized.startsWith("/") || /^[A-Za-z]:\//.test(normalized)) return undefined
  if (normalized === "." || normalized === ".." || normalized.startsWith("../") || normalized.includes("/../")) {
    return undefined
  }
  if (normalized === ".pi" || normalized.startsWith(".pi/") || normalized.includes("/.pi/")) return undefined
  return normalized
}

export function normalizeGitPaths(files: Iterable<string>): string[] {
  const result: string[] = []
  for (const file of files) {
    const normalized = normalizeGitPath(file)
    if (normalized !== undefined) result.push(normalized)
  }
  return result
}

// A pathspec that matches exactly this path from the repository root, with
// no glob interpretation.
export function literalPathspec(file: string): string {
  return `:(top,literal)${toPosix(file)}`
}

// NUL-separated literal pathspecs for --pathspec-from-file=- --pathspec-file-nul.
export function pathspecInput(files: readonly string[]): string {
  return files.map((file) => `${literalPathspec(file)}\0`).join("")
}

// Escapes a path so that a gitignore file matches it literally, anchored at
// the root.
export function gitignoreLiteral(file: string): string {
  const escaped = toPosix(file)
    .replace(/[\\*?[\]!#]/g, (char) => `\\${char}`)
    .replace(/ $/, "\\ ")
  return `/${escaped}`
}

export function intersect(values: readonly string[], allowed: ReadonlySet<string>): string[] {
  return values.filter((value) => allowed.has(value))
}

// "a, b, c, ..." for one-line notes.
export function listInline(paths: readonly string[], max = 5): string {
  const shown = paths.slice(0, max).join(", ")
  return paths.length > max ? `${shown}, and ${paths.length - max} more` : shown
}

// One path per line for dialogs.
export function listLines(paths: readonly string[], max = 10): string {
  const shown = paths.slice(0, max).join("\n")
  return paths.length > max ? `${shown}\n... and ${paths.length - max} more` : shown
}

export interface NumstatRow {
  file: string
  // Line counts are 0 for binary files.
  added: number
  removed: number
  binary: boolean
}

export function formatNumstat(rows: readonly NumstatRow[], maxRows = 20): string {
  const sorted = [...rows].sort((a, b) => b.added + b.removed - (a.added + a.removed))
  const lines = sorted
    .slice(0, maxRows)
    .map((row) => (row.binary ? `${row.file}  (binary)` : `${row.file}  +${row.added}/-${row.removed}`))
  if (rows.length > maxRows) lines.push(`... and ${rows.length - maxRows} more`)
  const added = rows.reduce((sum, row) => sum + row.added, 0)
  const removed = rows.reduce((sum, row) => sum + row.removed, 0)
  lines.push(`Total: +${added}/-${removed} across ${rows.length} file(s)`)
  return lines.join("\n")
}
