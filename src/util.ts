import path from "node:path"

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function nulSplit(text: string): string[] {
  return text.split("\0").filter(Boolean)
}

export function unique(values: string[]): string[] {
  return [...new Set(values)]
}

export function userText(content: unknown): string {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  return content
    .filter(
      (block): block is { type: "text"; text: string } => {
        if (typeof block !== "object" || block === null) return false
        const candidate = block as { type?: unknown; text?: unknown }
        return candidate.type === "text" && typeof candidate.text === "string"
      },
    )
    .map((block) => block.text)
    .join("")
}

export function imageCount(content: unknown): number {
  if (!Array.isArray(content)) return 0
  return content.filter(
    (block) =>
      Boolean(block && typeof block === "object" && (block as { type?: unknown }).type === "image"),
  ).length
}

export function normalizeGitPath(file: string): string | undefined {
  if (!file || path.isAbsolute(file) || file.includes("\0")) return
  const normalized = file.replaceAll("\\", "/")
  if (normalized === "." || normalized.startsWith("../") || normalized.includes("/../")) return
  if (normalized === ".pi" || normalized.startsWith(".pi/")) return
  return normalized
}

export function literalPathspec(file: string): string {
  return `:(top,literal)${file.replaceAll("\\", "/")}`
}

export function listPaths(paths: string[], max = 5): string {
  const shown = paths.slice(0, max).join(", ")
  return paths.length > max ? `${shown}, ...` : shown
}

export interface NumstatRow {
  file: string
  added: number
  removed: number
}

export function formatNumstat(rows: NumstatRow[], maxRows = 20, binaryCount = 0): string {
  const sorted = [...rows].sort((a, b) => b.added + b.removed - (a.added + a.removed))
  const shown = sorted.slice(0, maxRows)
  const lines = shown.map((row) => `${row.file}  +${row.added}/-${row.removed}`)
  const totalAdded = rows.reduce((sum, row) => sum + row.added, 0)
  const totalRemoved = rows.reduce((sum, row) => sum + row.removed, 0)
  const more = rows.length > maxRows ? `... and ${rows.length - maxRows} more` : ""
  const binary = binaryCount > 0 ? `Binary: ${binaryCount} file(s) not shown` : ""
  return [...lines, more, `Total: +${totalAdded}/-${totalRemoved} across ${rows.length} file(s)`, binary]
    .filter(Boolean)
    .join("\n")
}
