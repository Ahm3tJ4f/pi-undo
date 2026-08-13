import { appendFile, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises"
import path from "node:path"

// The journal is best effort. A failed write or read must never break the
// caller, so every public function swallows its own errors.

const MAX_JOURNAL_BYTES = 64 * 1024
const KEEP_LINES = 2000

interface JournalEntry {
  p: string
  t: number
}

function sanitizeSessionId(sessionId: string): string {
  return sessionId.replace(/[^A-Za-z0-9_-]/g, "_")
}

export function sessionJournalFile(storeDir: string, sessionId: string): string {
  return path.join(storeDir, "journal", `${sanitizeSessionId(sessionId)}.jsonl`)
}

function journalDir(storeDir: string): string {
  return path.join(storeDir, "journal")
}

export async function appendTouches(
  storeDir: string,
  sessionId: string,
  entries: Array<{ p: string; t: number }>,
): Promise<void> {
  if (entries.length === 0) return
  const line = entries.map((entry) => JSON.stringify(entry satisfies JournalEntry)).join("\n") + "\n"
  try {
    await mkdir(journalDir(storeDir), { recursive: true })
    await appendFile(sessionJournalFile(storeDir, sessionId), line)
  } catch {
    return
  }
  try {
    const file = sessionJournalFile(storeDir, sessionId)
    const info = await stat(file)
    if (info.size > MAX_JOURNAL_BYTES) {
      const text = await readFile(file, "utf8")
      const kept = text.split("\n").filter(Boolean).slice(-KEEP_LINES)
      await writeFile(file, kept.join("\n") + "\n")
    }
  } catch {
    // Best effort: the cap is optional.
  }
}

export async function attributeTouches(
  storeDir: string,
  selfSessionId: string,
  paths: string[],
  window: { from: number; to: number },
): Promise<Map<string, string[]>> {
  const wanted = new Set(paths)
  const result = new Map<string, string[]>()
  let entries: string[]
  try {
    entries = await readdir(journalDir(storeDir))
  } catch {
    return result
  }
  const selfFile = sessionJournalFile(storeDir, selfSessionId)
  for (const name of entries) {
    if (!name.endsWith(".jsonl")) continue
    const file = path.join(journalDir(storeDir), name)
    if (file === selfFile) continue
    const sessionId = name.slice(0, -".jsonl".length)
    let text: string
    try {
      text = await readFile(file, "utf8")
    } catch {
      continue
    }
    for (const line of text.split("\n")) {
      if (!line) continue
      let entry: JournalEntry
      try {
        entry = JSON.parse(line) as JournalEntry
      } catch {
        continue
      }
      if (typeof entry.p !== "string" || !wanted.has(entry.p)) continue
      // Only touches made inside the message window count. A stale touch
      // from an old message must not attribute a path forever.
      if (typeof entry.t !== "number" || entry.t < window.from || entry.t > window.to) continue
      const existing = result.get(entry.p)
      if (existing) existing.push(sessionId)
      else result.set(entry.p, [sessionId])
    }
  }
  return result
}
