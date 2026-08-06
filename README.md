# pi-undo

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
- **Garbage collection.** Daily gc keeps the snapshot store bounded. Old
  snapshots get pruned, so storage doesn't grow forever.
- **Cancel and failures are safe.** Cancel mid-undo rolls the files back.
  Restores are verified by tree hash and roll back on mismatch. Manual
  edits trigger a question first, so nothing gets clobbered.
- **Two snapshots per message.** Each user message gets a before and an
  after tree hash. Undo restores only the files that message changed.

## Commands

| Command | What it does                                                                                                     |
| ------- | ---------------------------------------------------------------------------------------------------------------- |
| `/undo` | Aborts the agent, shows a diff preview, restores the files to before the last message, and puts the prompt back. |
| `/redo` | Re-applies the most recently undone message. Survives restarts.                                                  |
| `/diff` | Shows what `/undo` would restore.                                                                                |

## Install

```bash
pi install npm:@ahm3tj4f/pi-undo
```
