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
- **Garbage collection.** Daily gc keeps the snapshot store bounded. Old
  snapshots get pruned, so storage doesn't grow forever.
- **Cancel and failures are safe.** Cancel mid-undo rolls the files back.
  Restores are verified by tree hash and roll back on mismatch. Manual
  edits trigger a question first, so nothing gets clobbered.
- **Two snapshots per message.** Each user message gets a before and an
  after tree hash. Undo restores only the files that message changed.

## What is not snapshotted

A built-in blacklist skips directories that are never worth undoing:

- **Dependencies and build output:** `node_modules`, `Pods`, `vendor`,
  `dist`, `build`, `target`, `.next`, `coverage`, `.venv`, `venv`
- **Tool caches and app data:** `Library`, `AppData`, `.cache`, `.gradle`,
  `.android`, `.npm`, `.yarn`, `.rustup`, `.cargo`, `.nuget`, `.m2`,
  `.pnpm-store`, `.idea`, `.terraform`

These names are matched at any depth, so `some/project/node_modules` is
skipped inside any folder, not just at the top level.

Nested git repositories are excluded from snapshots automatically (they
are covered by their own repo).

## Configuration

Create a `pi-undo.json` file:

- Global: `~/.pi/agent/pi-undo.json`
- Project: `.pi/pi-undo.json` (only honored for trusted projects)

Project values override global values.

```json
{
  "extraExcludes": ["Downloads", "tmp"],
  "maxFiles": 100000
}
```

| Field | What it does |
| -------- | ------------ |
| `extraExcludes` | Additional directory names to skip, matched at any depth |
| `maxFiles` | Snapshot size cap (default 100000). Over this, snapshots are skipped for that message with a one-time warning instead of making pi slow |

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
