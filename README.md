# pi-undo

[![npm version](https://img.shields.io/npm/v/@ahm3tj4f/pi-undo)](https://www.npmjs.com/package/@ahm3tj4f/pi-undo)
[![npm downloads](https://img.shields.io/npm/dm/@ahm3tj4f/pi-undo)](https://www.npmjs.com/package/@ahm3tj4f/pi-undo)
[![license](https://img.shields.io/npm/l/@ahm3tj4f/pi-undo)](https://github.com/ahm3tj4f/pi-undo/blob/main/LICENSE)

Undo/redo for pi. But this time it works.

This is a port of OpenCode's exact undo/redo philosophy: snapshot the files
per message with a shadow git repo, restore only what that message changed,
and never lose your work in the process.

## How it works

Each user message gets two git tree hashes: one before the turn, one after.
The trees live in a shadow repo under `~/.pi/agent/pi-undo/snapshots/`.
The checkpoints are persisted in the session, so undo and redo work after a
restart.

## Why this works

- **Works without git.** Non-git directories are fully supported.
- **Fast on big repos.** Object reuse via git alternates, incremental adds,
  batched restores. No full `git add` twice per turn.
- **Huge workspaces still get undo.** There is no snapshot size cap. The
  pre-turn capture runs in the background: the turn starts immediately, and
  `/undo` waits (bounded) for a capture that is still settling instead of
  blocking pi behind a minutes-long first `git add`. A turn that begins
  while a capture is still running gets no second capture rather than
  stacking overlapping git runs.
- **Baseline warmup.** A snapshot is taken in the background at session
  start, so the first message's capture is an incremental diff instead of
  a cold full enumeration.
- **Housekeeping is automatic.** Daily gc keeps the snapshot store bounded,
  a background gc runs every 20 captures, and stores whose workspace no
  longer exists are swept at session start.
- **Messages older than pi-undo can still be removed.** If the last message
  has no checkpoint (it predates arming in this workspace), `/undo` offers
  to remove it from the conversation without reverting files — those file
  states were never captured, so they cannot be restored.
- **Two snapshots per message.** Each user message gets a before and an
  after tree hash. Undo restores only the files that message changed.
- **Gitignored files are undoable when the session edits them.** The shadow
  repo snapshots gitignored files too, so a file the current pi session
  touched can always be undone, even if it is in `.gitignore`. A gitignored
  file with manual edits since the message triggers the manual-edits
  question. Confirming restores the file and loses the manual edits.
  Declining blocks the undo. Only pi-undo's own `excludeDirectories` are
  never snapshotted.
- **Undo restores only what this session wrote.** Each message records which
  files its `write` and `edit` tools touched. Undo restores those files.
  Files that changed during the message for another reason are listed in
  the dialog and never restored; a warning names them. Files that another
  pi session touched get the session id in the warning. The records live
  in a small journal under the snapshot store, so they survive restarts.
  Changes made by bash commands cannot be attributed and are warned about
  the same way.

## Configuration

pi-undo reads one config file: `~/.pi/agent/pi-undo.json`. On the first run
the file is created with the default values, and you edit it directly to
change them. Add or remove patterns in `excludeDirectories`. The list in
the file is the complete list: removing an entry really un-excludes that
path. A stale `maxFiles` key from an older install is ignored.

```json
{
  "excludeDirectories": ["node_modules", "dist", "Downloads", "tmp"]
}
```

| Field | What it does |
| -------- | ------------ |
| `excludeDirectories` | Full gitignore glob patterns, never snapshotted. Plain names match at any depth; globs like `**/build-*` or `*.tmp` work; a trailing slash means directories only |

## Commands

| Command | What it does                                                                                                     |
| ------- | ---------------------------------------------------------------------------------------------------------------- |
| `/undo` | Aborts the agent, shows a diff preview, restores the files to before the last message, and puts the prompt back. |
| `/redo` | Re-applies the most recently undone message. Survives restarts.                                                  |
| `/diff` | Shows what `/undo` would restore.                                                                                |

## Install

```bash
pi install npm:@ahm3tj4f/pi-undo

# OR

pi install git:github.com/ahm3tj4f/pi-undo
```
