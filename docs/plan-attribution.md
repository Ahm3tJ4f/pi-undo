# Plan: Attribute file changes to the right source

## Goal

`/undo` must restore only the files that THIS pi session edited during the
last message. Changes from other sources must not be restored by default.
The preview and the dialogs must show the source of each file when it is
known.

## The problems we fix

1. **Rollback bug.** Rollback recomputes the manual-edit list after the
   failed undo already changed the tree. A gitignored file that the undo
   restored looks like a manual edit at rollback time. Rollback skips it
   and reports success. The file stays at the wrong state. See the code
   review findings, issue 1.

2. **Noise in the undo list.** The checkpoint compares two snapshots:
   before the message and after the message. Every change between the two
   snapshots counts as a change by this session. Changes from other pi
   sessions, from watchers, and from caches appear in `/undo` too.

3. **Missing cache patterns.** The default exclude list misses common
   caches: `__pycache__`, `*.pyc`, `.pytest_cache`, `.mypy_cache`,
   `.ruff_cache`, `.tox`, `.turbo`, `.parcel-cache`, and `.vite`. These
   churn files enter every snapshot. See the code review findings,
   issue 2.

4. **Silent skip for gitignored files.** A gitignored file with manual
   edits is skipped silently today. The user wants a prompt: "Manual
   edits found. Restore anyway?"

## Design decisions

### D1. Track which files this session writes

pi emits a `tool_call` event before each tool run. The `write` tool and
the `edit` tool take a `path` field in their input. The capture module
records these paths during the message. These paths form the "touched"
set.

A file in the checkpoint counts as "edited by this session" when the
session touched it. All other changed files count as "unattributed".

Limit: `bash` can change files too. We cannot see which files a bash
command writes. Bash changes stay unattributed.

### D2. Split the checkpoint files into two groups

The checkpoint keeps `files`: all files that changed between the two
snapshots. The checkpoint gains a new field `unattributed`: the subset
of `files` that no `write` or `edit` tool touched.

The edited list is `files` minus `unattributed`. We compute it at undo
time. Old checkpoints without the field treat every file as edited. This
keeps backward compatibility.

### D3. Journal: which other pi session edited a file

Each session appends its touched paths to a journal file. The file lives
under the shadow store directory:
`<store>/journal/<sessionId>.jsonl`. The store directory is keyed by the
project path. Two pi sessions in the same project share it.

At undo time, the commands read the journal files of OTHER sessions.
They map each unattributed file to the sessions that touched it.

The journal is best effort. A missing or broken file is ignored.

### D4. Undo and redo dialogs

The undo flow gains three groups:

- **Edited by this session.** Restored.
- **Unattributed.** The dialog asks: "Also restore these?" The default
  is no. The default is safe: a missed undo is annoying, but restoring
  another agent's work is data loss.
- **Touched by another pi session.** Never restored. A note shows the
  session id.

The manual-edit prompt now covers gitignored files too. If the user
confirms, the restore overwrites the manual edits. If the user declines,
undo is blocked. Redo mirrors undo.

### D5. Fix the rollback bug

`restoreSnapshot` gains options: `{ manualSet, force }`.

- `manualSet` replaces the recomputed gitignored skip list.
- `force` disables the gitignored skip list.

Rollback receives the skip lists from the failed restore. It passes the
original `manualSkipped` list as `manualSet`. Then rollback skips the
same files the failed restore skipped. Files the failed restore changed
get restored. Verification uses the same lists.

## New code

### src/journal.ts (new)

```ts
export function sessionJournalFile(storeDir: string, sessionId: string): string
export async function appendTouches(
  storeDir: string,
  sessionId: string,
  paths: string[],
  at?: number,
): Promise<void>
export async function attributeTouches(
  storeDir: string,
  selfSessionId: string,
  paths: string[],
): Promise<Map<string, string[]>>
```

One JSON object per line: `{"p": "src/a.ts", "t": 1234567890}`.
The append is best effort. The file is capped at 64 KB: the writer keeps
the last 2000 lines.

`attributeTouches` reads every journal file except the caller's own. It
returns a map from path to session ids. Session ids are sanitized for
file names: only letters, digits, `-`, and `_` stay.

### src/git.ts changes

- `SnapshotRepo` gains `readonly storeDir: string` and
  `dirtySinceAll(snapshot): Promise<{ manual: string[]; ignored: string[] }>`.
  `dirtySince` goes away.
- `restoreSnapshot(snapshot, files, since?, opts?)`. The options:
  `manualSet?: ReadonlySet<string>` and `force?: boolean`.
  `force` makes the skip list empty. `manualSet` replaces the
  recomputation.

### src/capture.ts changes

- Subscribe to `tool_call`. For `write` and `edit`, read `input.path`.
  Convert it to a path relative to `ctx.cwd`. Skip paths outside the
  project. Store the result in the active turn's touched set.
- At finalize: split `files` into touched and unattributed. Store the
  unattributed list in the checkpoint. Append the touched paths to the
  journal.

### src/commands.ts changes

- Use `dirtySinceAll` for the manual-edit check. The prompt lists both
  tracked and gitignored files. Confirmation forces the restore.
- Split the restore into edited and unattributed files. Ask about the
  unattributed files in a second dialog.
- Show other-session files in a note. Never restore them.
- Fix the rollback calls: pass the original skip lists.
- Fix the "restored N file(s)" count: use the real restored count.

### src/config.ts changes

Add to `DEFAULT_EXCLUDE_DIRECTORIES`:

```
"__pycache__", "*.pyc", "*.pyo", ".pytest_cache", ".mypy_cache",
".ruff_cache", ".tox", ".turbo", ".parcel-cache", ".vite"
```

### src/types.ts and src/store.ts changes

- `Checkpoint` gains `unattributed: string[]`.
- `parseCheckpoint` defaults it to `[]` when the field is missing.

## Dialog flow for /undo

1. Check for manual edits since the message in the message files. The
   check covers tracked and gitignored files. When it finds any, show
   the prompt. Decline blocks the undo.
2. Compute the three groups: edited, unattributed, other-session.
3. Show the main dialog. It lists the edited files and notes the other
   groups.
4. When unattributed files exist, ask: "Also restore them?" Yes
   restores them. No leaves them.
5. Restore the chosen files. Verify. Roll back on failure with the
   original skip lists.
6. After success, show notes for skipped, excluded, and other-session
   files.

`/redo` mirrors this flow with the after snapshot as the target.
`/diff` shows the edited group and the unattributed group separately.

## User stories to change

- US-58 and US-60 change: the prompt replaces the silent skip.
- New section for attribution: US-63 through US-66.
- US-46 wording mentions the new cache patterns.

## Work order

The workers run one after the other in the same checkout. Each worker
commits its own change. Each worker runs `npm test` and
`npm run typecheck` before it commits.

1. **Worker 1: rollback fix.** `src/git.ts`, `src/commands.ts`
   (rollback part), tests.
2. **Worker 2: cache patterns.** `src/config.ts`, a small config test.
3. **Worker 3: capture and journal.** `src/capture.ts`,
   `src/types.ts`, `src/store.ts`, new `src/journal.ts`, interface
   updates, tests.
4. **Worker 4: dialogs.** `src/commands.ts` undo, redo, diff. Tests.

The parent updates README and USER_STORIES after the workers finish.
The parent then dispatches a code reviewer.

## Checks before merge

- `npm test` passes.
- `npm run typecheck` passes.
- A real-git test covers the rollback bug with a gitignored file.
- A real-git test covers the cache pattern exclusion.
- Unit tests cover the dialogs, the touched set, and the journal.
