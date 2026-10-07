export interface FileSnapshot {
  // Tree hashes in the shadow repo, taken when the run started and settled.
  before: string
  after: string
  // Paths that differ between the two trees. Never empty.
  files: string[]
}

// One agent run: the conversation entries it added and the file changes it
// made.
export interface Checkpoint {
  // First entry of the run: the user message, or the custom message that
  // started it. Undo navigates to it, which moves the session leaf to its
  // parent.
  entryId: string
  // Session leaf when the run settled. Redo navigates back to it.
  finalLeafId: string
  prompt: string
  imageCount: number
  // Null when the run changed no files, or when it has no snapshot.
  snapshot: FileSnapshot | null
  // Set when the run's files could not be snapshotted, with the reason.
  // Undo can then roll back the conversation only.
  unavailable?: string
  createdAt: number
}
