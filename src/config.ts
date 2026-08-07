import { readFileSync } from "node:fs"
import path from "node:path"
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent"

export interface PiUndoConfig {
  extraExcludes: string[]
  maxFiles: number
}

export const DEFAULT_MAX_FILES = 100_000

export const DEFAULT_CONFIG: PiUndoConfig = {
  extraExcludes: [],
  maxFiles: DEFAULT_MAX_FILES,
}

/**
 * Load pi-undo.json configuration.
 *
 * Global: <agent dir>/pi-undo.json (e.g. ~/.pi/agent/pi-undo.json)
 * Project: <cwd>/.pi/pi-undo.json, only honored for trusted projects.
 *
 * Project values override global values. extraExcludes are merged.
 */
export function loadPiUndoConfig(
  cwd: string,
  trusted: boolean,
  globalPath?: string,
): PiUndoConfig {
  const global = readConfigFile(globalPath ?? path.join(getAgentDir(), "pi-undo.json"))
  const project = trusted ? readConfigFile(path.join(cwd, CONFIG_DIR_NAME, "pi-undo.json")) : {}
  return {
    extraExcludes: [...new Set([...(global.extraExcludes ?? []), ...(project.extraExcludes ?? [])])],
    maxFiles: project.maxFiles ?? global.maxFiles ?? DEFAULT_MAX_FILES,
  }
}

function readConfigFile(file: string): Partial<PiUndoConfig> {
  try {
    const raw = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>
    const extraExcludes = Array.isArray(raw.extraExcludes)
      ? raw.extraExcludes.filter((value): value is string => typeof value === "string")
      : undefined
    const maxFiles =
      typeof raw.maxFiles === "number" && Number.isFinite(raw.maxFiles) && raw.maxFiles > 0
        ? raw.maxFiles
        : undefined
    return {
      ...(extraExcludes ? { extraExcludes } : {}),
      ...(maxFiles ? { maxFiles } : {}),
    }
  } catch {
    return {}
  }
}
