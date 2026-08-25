import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import path from "node:path"
import { getAgentDir } from "@earendil-works/pi-coding-agent"

export interface PiUndoConfig {
  excludeDirectories: string[]
}

// Matched at any depth in every project. These are regenerated or app-owned,
// never worth snapshotting: dependencies, build output, tool caches. Entries
// are full gitignore glob patterns: plain names match at any depth, globs are
// supported (for example "**/build-*" or "*.tmp"), and a trailing slash
// means the pattern matches directories only, as in gitignore.
//
// ".pi" keeps the agent's own state directory out of snapshots: when pi runs
// in a home directory the snapshot store lives inside the worktree, and a
// capture that swallowed it would chase its own growing output forever.
export const DEFAULT_EXCLUDE_DIRECTORIES: string[] = [
  ".pi",
  "node_modules",
  "Pods",
  "vendor",
  "dist",
  "build",
  "target",
  ".next",
  "coverage",
  "__pycache__",
  "*.pyc",
  "*.pyo",
  ".pytest_cache",
  ".mypy_cache",
  ".ruff_cache",
  ".tox",
  ".turbo",
  ".parcel-cache",
  ".vite",
  ".venv",
  "Library",
  "AppData",
  ".cache",
  ".gradle",
  ".android",
  ".npm",
  ".yarn",
  ".rustup",
  ".cargo",
  ".nuget",
  ".pods",
  ".m2",
  ".pnpm-store",
  ".idea",
  ".terraform",
  ".svn",
  ".hg",
  ".local",
  ".paseo",
  ".opencode",
  ".agent-browser",
  ".dev-browser",
  ".antigravity",
  ".docker",
  ".expo",
  ".gem",
  ".cocoapods",
  ".nvm",
  ".mozilla",
  ".vscode",
  "snap",
  "flatpak",
]

export const DEFAULT_CONFIG: PiUndoConfig = {
  excludeDirectories: DEFAULT_EXCLUDE_DIRECTORIES,
}

/**
 * Load the pi-undo.json config file: <agent dir>/pi-undo.json
 * (e.g. ~/.pi/agent/pi-undo.json).
 *
 * When the file does not exist it is created with the default values, so the
 * user can open it and add or remove entries. The values in the file are the
 * complete effective configuration: removing an entry from
 * excludeDirectories really un-excludes that directory.
 *
 * If a key is missing or invalid, the default for that key is used. Unknown
 * keys (for example a stale "maxFiles" left by an older install) are ignored;
 * there is no snapshot size cap anymore.
 */
export function loadPiUndoConfig(globalPath?: string): PiUndoConfig {
  const file = globalPath ?? path.join(getAgentDir(), "pi-undo.json")
  if (!existsSync(file)) writeDefaults(file)
  const config = readConfigFile(file)
  return {
    excludeDirectories: config.excludeDirectories ?? DEFAULT_EXCLUDE_DIRECTORIES,
  }
}

function writeDefaults(file: string): void {
  try {
    mkdirSync(path.dirname(file), { recursive: true })
    writeFileSync(file, JSON.stringify(DEFAULT_CONFIG, null, 2) + "\n")
  } catch {
    // Best effort: if the file cannot be created, the in-memory defaults are
    // still used.
  }
}

function readConfigFile(file: string): Partial<PiUndoConfig> {
  try {
    const raw = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>
    const excludeDirectories = Array.isArray(raw.excludeDirectories)
      ? raw.excludeDirectories.filter(
          (value): value is string => typeof value === "string" && value.length > 0,
        )
      : undefined
    return {
      ...(excludeDirectories !== undefined ? { excludeDirectories } : {}),
    }
  } catch {
    return {}
  }
}
