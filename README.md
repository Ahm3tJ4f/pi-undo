# pi-undo

[![npm version](https://img.shields.io/npm/v/@ahm3tj4f/pi-undo)](https://www.npmjs.com/package/@ahm3tj4f/pi-undo)
[![npm downloads](https://img.shields.io/npm/dm/@ahm3tj4f/pi-undo)](https://www.npmjs.com/package/@ahm3tj4f/pi-undo)
[![license](https://img.shields.io/npm/l/@ahm3tj4f/pi-undo)](https://github.com/ahm3tj4f/pi-undo/blob/main/LICENSE)

Undo and redo for [pi](https://github.com/earendil-works/pi). One command rolls back the last message: the conversation and the files that the message changed.

The design follows OpenCode: a snapshot of the files before and after each message, in a shadow git repository.

## Commands

| Command | What it does |
| ------- | ------------ |
| `/undo` | Stops the agent if it runs. Shows the changes of the last message. Restores the files to their state before the message. Moves the conversation back and puts the prompt in the editor. |
| `/redo` | Applies the last undone message again: the files and the conversation. |
| `/diff` | Shows the changes that `/undo` rolls back. It does not stop a running agent. |

For example, the agent edits `src/app.ts` and creates `src/new.ts`. `/undo` restores `src/app.ts`, deletes `src/new.ts`, and removes the message from the conversation.

## Install

```bash
pi install npm:@ahm3tj4f/pi-undo
```

You can also install from git:

```bash
pi install git:github.com/ahm3tj4f/pi-undo
```

pi-undo needs git 2.31 or newer.

## How it works

Each agent run gets two snapshots. pi-undo takes the first snapshot when the run starts. It takes the second snapshot when the run ends. A snapshot is a git tree in a shadow repository under `~/.pi/agent/pi-undo/snapshots/`. Your own git repository never changes.

The two snapshots show which files the message changed. `/undo` restores all of these files. The tool that changed a file has no effect: the `edit` tool, a bash command, a formatter, and a subagent are all the same.

The checkpoints are part of the pi session. Undo and redo work after a restart.

## Safety

- **Manual edits.** You can change a file after the message. In that case, the undo dialog shows the file and tells you that your change will be lost. Nothing changes until you confirm.
- **Files outside the message.** `/undo` never touches a file that the message did not change.
- **Verification.** After a restore, pi-undo compares each restored file with the snapshot.
- **Rollback.** If a restore fails, pi-undo puts every file back to its state just before the undo. Your manual edits stay.
- **Order.** pi-undo restores the files first and moves the conversation after. If the conversation cannot move, the files go back.
- **Symlinks.** pi-undo never writes through a symlinked directory.
- **Gitignored files.** pi-undo snapshots files that your `.gitignore` ignores. A change to `.env` by the agent is undoable.

## Configuration

pi-undo reads `~/.pi/agent/pi-undo.json`. On the first run, pi-undo writes this file with the default values. Edit the file to change them. The file is the full configuration: when you remove an entry from `excludeDirectories`, pi-undo snapshots that path again.

```json
{
  "excludeDirectories": ["node_modules", "dist", "build", ".venv", "..."],
  "maxFiles": 100000,
  "retentionDays": 30
}
```

| Field | What it does |
| ----- | ------------ |
| `excludeDirectories` | Gitignore patterns that pi-undo never snapshots. A plain name matches at all depths. Globs like `**/build-*` and `*.tmp` work. A trailing slash matches directories only. |
| `maxFiles` | The largest number of new or changed files that one snapshot can add. Above this number, pi-undo skips the snapshot and shows a warning. Undo of that message can then move the conversation only. |
| `retentionDays` | The number of days that pi-undo keeps snapshots. After this period, undo of the message can move the conversation only. |

## Limits

- pi-undo does not snapshot new files larger than 2 MB. It shows a warning when this occurs.
- pi-undo does not snapshot nested git repositories. They have their own history.
- pi-undo does not restore image attachments of a prompt to the editor.
- Two pi sessions in the same directory share one snapshot store. If both sessions change the same file during one message, `/undo` in one session also rolls back the change of the other session.

## Development

```bash
npm install
npm run typecheck
npm test
```

The tests use real git in temporary directories. They never touch `~/.pi`.

## License

MIT
