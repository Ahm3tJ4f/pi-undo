# Changelog

## 0.5.0

This release fixes `/undo` that rolled back the conversation but not the files.

### Breaking

- `/undo` and `/redo` restore every file that the message changed. Before, they restored only the files that the `write` and `edit` tools touched. Files changed by bash, by formatters, or by subagents stayed changed.
- The file attribution journal is removed. The daily gc deletes the old journal directory.
- The `ShadowGit` constructor takes an options object. The `SnapshotRepo` interface changed. This affects code that imports these modules only.

### Fixed

- Two undos in a row failed when you changed any file by hand between the two messages.
- A restore that failed in the middle did not roll back.
- A rollback now goes back to the real state before the undo. Before, it went back to the old snapshot and lost your manual edits.
- A command that ran just after the agent stopped could undo the wrong message. pi marks the session idle before the extension records the checkpoint. Commands now wait for the checkpoint.
- Runs that an extension starts with a custom message now get a checkpoint.
- A run whose `agent_settled` event never arrived merged with the next run.
- In a subdirectory of a git repository, the first snapshot counted every file of the repository. In a large monorepo, snapshots stopped.
- `/diff` stopped a running agent.
- gc deleted snapshots after 7 days. Snapshots now stay for `retentionDays` (default 30).
- A redo after a jump in the session tree applied a stale message.
- Large file names with gitignore special characters, like `[draft].bin`, became patterns.
- Undo left empty directories behind.

### Added

- `retentionDays` in `pi-undo.json`.
- The first message of a session can be undone.
- When the snapshots of a message are missing, or the snapshot failed, `/undo` tells you why. It then offers to undo the conversation only.
- One dialog shows the changes, the manual edits that the undo overwrites, and the files that it cannot restore.
- A warning for new files over 2 MB, which pi-undo does not snapshot.
- Object reuse for linked git worktrees.
- Git commands retry when a second pi process holds the index lock.

## 0.4.0

- Undo restored only files that the session edited with its file tools.

## 0.3.0

- `excludeDirectories` entries are full gitignore glob patterns.

## 0.2.0

- One editable config file with defaults.
