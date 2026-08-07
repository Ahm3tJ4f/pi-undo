# pi-undo user stories and edge cases

Severity: **core** = must always work, **edge** = rare but should not break badly,
**rare** = unlikely, nice to handle gracefully.

## 1. Basic undo/redo

- US-1 (core) Last message changed a file: `/undo` restores the file to its
  before-state, rolls the session tree back, and puts the prompt back in the
  editor.
- US-2 (core) No checkpoint exists (first message or nothing yet): `/undo`
  says "Nothing to undo" and does nothing else.
- US-3 (core) `/undo` while the agent is streaming: pi aborts the agent, waits
  for idle, then runs the undo.
- US-4 (core) `/redo` after an undo: re-applies the file state and moves the
  tree forward again.
- US-5 (core) `/redo` with an empty redo stack: says "Nothing to redo".
- US-6 (core) `/undo` then a NEW user message: the redo stack is cleared, so
  `/redo` says "Nothing to redo".
- US-7 (core) Two undos in a row: each undo targets the previous message, so
  the second undo rolls back the message before the first.
- US-8 (core) Undo/redo survive a pi restart: checkpoints are persisted in the
  session, so the redo stack reloads.
- US-9 (edge) Undo the very first message in a session: the message has no
  parent leaf, so pi-undo refuses with "Cannot undo the first message in
  place; fork before it instead".

## 2. File states

- US-10 (core) File created during the message: undo deletes it.
- US-11 (core) File deleted during the message: undo restores it from the
  snapshot.
- US-12 (core) File modified during the message: undo restores the old
  content.
- US-13 (edge) File replaced by a directory with the same name: undo removes
  the directory and restores the file.
- US-14 (edge) Directory replaced by a file with the same name: undo restores
  the directory contents and the file.
- US-15 (edge) Binary file changed: the diff preview shows it as binary
  (no line stats) but restore still works.
- US-16 (edge) Message changed no files (only tree/session work): `/undo`
  rolls the tree back and restores the prompt without touching any files.
- US-17 (edge) File renamed: rename shows as delete + create in the diff.
  Undo deletes the new name and restores the old one.
- US-18 (edge) File with tabs or unusual characters in its name: diff preview
  and restore handle it (numstat parsing covers tabs).
- US-19 (rare) Symlinked parent directory: restore refuses that path (it is
  reported as skipped) so undo never writes through a symlink.
- US-20 (rare) Chmod-only change: restore brings back the old mode.
- US-21 (rare) FIFO/socket/special file created during a message: the size
  check skips non-files, but `git add` could hang on a FIFO. Should be
  investigated or blocked.
- US-22 (rare) File larger than 2 MB, newly created: it is excluded from
  snapshots, so undo cannot restore it. The diff preview should make this
  visible.

## 3. Conflicts with manual edits

- US-23 (core) User edits a file by hand after the message, then `/undo`: the
  dirty check detects it, shows the "Manual edits found" dialog, and asks
  before restoring.
- US-24 (core) Dialog answered "No": undo is blocked and the working tree is
  left untouched.
- US-25 (core) Dialog answered "Yes": undo restores and the manual edits to
  the restored files are lost.
- US-26 (edge) Manual edits exist in files the undo will NOT touch: the dialog
  still lists them today (conservative). It over-warns, because those edits
  survive the undo. Consider narrowing the list to checkpoint files.
- US-27 (core) Nested git repos near the worktree: they are never reported as
  manual edits (fixed), so `/undo` in `~/` does not show false dialogs.
- US-28 (edge) `/redo` with manual edits: redo is blocked with a warning (no
  confirmation dialog, unlike undo).
- US-29 (edge) Dirty check passes but the user edits files between the check
  and the restore: the post-restore verification fails and pi-undo rolls the
  files back to the after-state.

## 4. Failures and verification

- US-30 (core) Restore fails partway (git checkout error): pi-undo rolls the
  files back to the after-state.
- US-31 (core) Verification fails after restore (tree hash mismatch): files
  are rolled back and the user is told undo failed.
- US-32 (edge) Rollback also fails: pi-undo warns that the working tree may be
  inconsistent.
- US-33 (edge) Tree navigation fails after files were restored: files are
  rolled back and the user sees the navigation error.
- US-34 (edge) User cancels the confirmation dialog: files are rolled back and
  undo reports cancelled.
- US-35 (edge) Snapshot store was deleted or pruned (gc older than 7 days):
  restore cannot find the tree, verification fails, rollback also fails, user
  gets the inconsistent-state warning.
- US-36 (edge) Corrupted checkpoint entry in the session file: it is skipped
  on load and does not break other checkpoints.
- US-37 (edge) Cap exceeded during a message (too many files): no checkpoint
  is recorded for that message, so `/undo` reports nothing to undo.
- US-38 (edge) Snapshot creation failed at message start (git timeout): undo
  is disabled for that message with a warning.

## 5. Session lifecycle

- US-39 (core) Undo works after restart because checkpoints live in the
  session file.
- US-40 (edge) Session was compacted: old leaves may be gone. Undo of a
  message before the compaction point may fail to navigate.
- US-41 (edge) Session resumed in a DIFFERENT directory: the snapshot store is
  keyed by cwd, so the old tree hashes do not exist in the new store. Restore
  fails and rollback fails. Should detect and degrade gracefully.
- US-42 (edge) Undo after a fork or branch switch: checkpoints are loaded from
  the branch entries; behavior should be verified.
- US-43 (edge) Message had image attachments: undo notes that the images are
  not restored.
- US-44 (rare) Undo, then redo, then undo again: the redo stack pops in order
  (LIFO), verify the sequence stays consistent.

## 6. Huge folders and exclusions

- US-45 (core) Undo in `~/`: no false manual-edits dialog, restore only
  touches the message's files.
- US-46 (core) Files under blacklisted dirs (node_modules, dist, tool caches)
  are not snapshotted and not undoable.
- US-47 (edge) Edits inside nested git repos are not undoable (the repo has
  its own git undo).
- US-48 (edge) A file that was snapshotted earlier and later becomes
  blacklisted (config change): the old snapshot still restores it; new
  messages do not track it.
- US-49 (edge) `maxFiles` reached: snapshots skip for that message, /undo
  reports nothing to undo, one-time warning shown.

## 7. Concurrency and races

- US-50 (edge) Two pi instances open in the same directory: they share the
  same shadow store (same cwd hash). Concurrent git writes can conflict
  (index.lock). Should serialize or use a lock.
- US-51 (rare) Agent creates and deletes a file within one message: the diff
  is empty for it, undo is a no-op for that path.
- US-52 (rare) A file changes while the snapshot is being taken: the
  before/after trees may disagree with the final content; verification at
  undo time catches mismatches.
- US-53 (rare) Files created during the message but removed by hand before
  `/undo`: restore recreates them from the snapshot (they existed at
  after-time).

## 8. Configuration

- US-54 (core) `~/.pi/agent/pi-undo.json` is created with defaults
  (`excludeDirectories` list, `maxFiles`) on first run; the user edits the
  file to configure pi-undo.
- US-55 (core) The `excludeDirectories` list in the file is the complete
  list: adding a name excludes that directory, removing a name
  un-excludes it.
- US-56 (edge) Config changes take effect on the next snapshot;
  already-staged files stay tracked until removed.

## Open questions

- OQ-1 Should the manual-edits dialog only list files the undo will actually
  restore (checkpoint files)? Today it lists every dirty path.
- OQ-2 Should pi-undo guard against FIFO/special files during `git add`?
- OQ-3 Should resuming a session in a different directory warn that old undo
  checkpoints are unusable?
- OQ-4 Should two concurrent pi instances share one shadow store safely?
