import type { SessionEntry } from "@earendil-works/pi-coding-agent"

export interface Checkpoint {
  
  userEntryId: string
  
  beforeLeafId: string | null
  
  finalLeafId: string
  
  prompt: string
  
  imageCount: number
  
  beforeSnapshot: string | null
  
  afterSnapshot: string | null
  
  files: string[]
  createdAt: number
}

export interface RevertState {
  revertedEntryIds: string[]
}

export interface ActiveTurn {
  prompt: string
  imageCount: number
  
  userEntryId: string | null
  beforeLeafId: string | null
  beforeSnapshot: string | null
}

export type UserMessageEntry = Extract<SessionEntry, { type: "message" }> & {
  message: { role: "user" }
}

export function isUserMessageEntry(entry: SessionEntry): entry is UserMessageEntry {
  return entry.type === "message" && entry.message.role === "user"
}
