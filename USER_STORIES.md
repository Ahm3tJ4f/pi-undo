# pi-undo user stories and edge cases

Severity: **core** = must always work, **edge** = rare, must not break badly,
**rare** = unlikely, handle it safely.

Each story names the test that covers it, in `test/`.

## 1. Basic undo and redo

- US-1 (core) The last message changed files. `/undo` restores the files to their state before the message. It moves the conversation back and puts the prompt in an empty editor. (`extension.test.ts`)
- US-2 (core) No message has a checkpoint. `/undo` shows "Nothing to undo" and changes nothing. (`commands.test.ts`)
- US-3 (core) The agent runs when you type `/undo`. pi-undo stops the agent, records its run, and undoes that run. (`commands.test.ts`)
- US-4 (core) `/redo` after an undo applies the files and the conversation again. (`commands.test.ts`)
- US-5 (core) The redo stack is empty. `/redo` shows "Nothing to redo". (`commands.test.ts`)
- US-6 (core) A new message after an undo clears the redo stack. (`tracker.test.ts`)
- US-7 (core) Two undos in a row undo the last two messages. (`extension.test.ts`)
- US-8 (core) Undo and redo work after a restart. (`extension.test.ts`)
- US-9 (core) The first message of a session can be undone. pi moves the session leaf to the root. (`extension.test.ts`)
- US-10 (core) The editor has a draft. `/undo` keeps the draft and does not put the prompt in the editor. (`commands.test.ts`)

## 2. Which files undo restores

- US-11 (core) `/undo` restores every file that differs between the two snapshots of the message. The tool that changed the file has no effect: the `edit` tool, bash, a formatter, and a subagent are all the same. (`extension.test.ts`, `restore.test.ts`)
- US-12 (core) A file created by the message is deleted. Directories that become empty are removed too. (`git.test.ts`)
- US-13 (core) A file deleted by the message comes back. (`git.test.ts`)
- US-14 (core) A file changed by the message gets its old content back. (`git.test.ts`)
- US-15 (edge) A file replaced by a directory with the same name, and the opposite, restore correctly. (`git.test.ts`)
- US-16 (edge) Binary files restore correctly. The dialog marks them as binary. (`git.test.ts`)
- US-17 (edge) A message that changed no files needs no dialog. `/undo` moves the conversation only. (`commands.test.ts`)
- US-18 (edge) A chmod-only change restores the old mode. (`git.test.ts`)
- US-19 (edge) A file name with a tab restores correctly. (`git.test.ts`)
- US-20 (core) `/undo` never touches a file that the message did not change. (`restore.test.ts`)

## 3. Manual edits

- US-21 (core) You change a file of the message after the message. The undo dialog lists the file under "These changes will be lost". (`commands.test.ts`)
- US-22 (core) You decline the dialog. Nothing changes. (`commands.test.ts`)
- US-23 (core) You confirm the dialog. The file gets its state before the message. (`restore.test.ts`)
- US-24 (core) A file of the message already has its target state. pi-undo does not write it and does not list it as a manual edit. (`restore.test.ts`)
- US-25 (core) Gitignored files follow the same rules as other files. (`restore.test.ts`)
- US-26 (edge) Without a UI, nobody can confirm. Manual edits then stop the undo. (`commands.test.ts`)
- US-27 (edge) `/redo` follows the same rules as `/undo`. (`commands.test.ts`)

## 4. Failures

- US-30 (core) A restore fails in the middle. pi-undo puts every file back to its state just before the undo, manual edits included. The conversation does not move. (`restore.test.ts`, `commands.test.ts`)
- US-31 (core) A restored file does not match the snapshot. pi-undo rolls back the same way. (`restore.test.ts`)
- US-32 (edge) The rollback fails too. The error names the files to check. (`commands.test.ts`)
- US-33 (edge) The conversation cannot move, or you cancel the move. The files go back. (`commands.test.ts`)
- US-34 (edge) The snapshots of the message are gone: the retention period ended, or the session moved to another directory. `/undo` tells you and offers to undo the conversation only. It never deletes files because of a missing snapshot. (`commands.test.ts`, `git.test.ts`)
- US-35 (edge) The snapshot of a message failed or was skipped (`maxFiles`). The checkpoint records the reason. `/undo` shows it and offers to undo the conversation only. (`tracker.test.ts`, `commands.test.ts`)
- US-36 (edge) A broken checkpoint entry in the session file is skipped. Other checkpoints still load. (`store.test.ts`)
- US-37 (edge) Checkpoints from pi-undo 0.4 still load. (`store.test.ts`)

## 5. Runs and the session

- US-40 (core) One agent run gives one checkpoint, keyed by its first user message. Steering messages and retries in the same run do not start a new checkpoint. (`tracker.test.ts`)
- US-41 (core) A run that an extension starts with a custom message gets a checkpoint too. (`tracker.test.ts`)
- US-42 (core) A command runs after the agent stops but before pi calls `agent_settled`. The command still sees the checkpoint of that run. (`tracker.test.ts`)
- US-43 (edge) The `agent_settled` event of a run never arrives. The next prompt records the run first. (`extension.test.ts`)
- US-44 (edge) You jump in the session tree with `/tree`. The redo stack clears. (`extension.test.ts`)
- US-45 (edge) The prompt had images. `/undo` tells you that the images are not back in the editor. (`commands.test.ts`)

## 6. Large directories and exclusions

- US-50 (core) pi-undo never snapshots paths that match `excludeDirectories`. (`git.test.ts`)
- US-51 (core) pi-undo never snapshots pi's own `.pi` directories. (`git.test.ts`)
- US-52 (edge) pi-undo never snapshots nested git repositories. It shows one warning. (`git.test.ts`)
- US-53 (edge) pi-undo never snapshots new files over 2 MB. It shows a warning. (`git.test.ts`)
- US-54 (edge) More than `maxFiles` files to add: pi-undo skips the snapshot and shows one warning. (`git.test.ts`)
- US-55 (edge) A path becomes excluded after the message. Undo does not restore it and tells you. (`commands.test.ts`)
- US-56 (edge) pi runs in a subdirectory of a git repository. Only that subdirectory counts. (`git.test.ts`)
- US-57 (edge) A symlinked directory is in the path. pi-undo never writes through it. (`git.test.ts`)

## 7. Concurrency

- US-60 (edge) Two pi sessions in the same directory share one snapshot store. Git commands retry when the other session holds the index lock. (`git.test.ts`)
- US-61 (edge) Calls on one store in one process run one at a time. (`git.test.ts`)
- US-62 (edge) `GIT_DIR` and similar variables in the environment do not reach the shadow repository. (`git.test.ts`, `exec.test.ts`)

## Open questions

- OQ-1 Two sessions change the same file during one message. `/undo` in one session rolls back the change of the other session too. A warning for this case needs a reliable record of which session wrote a file.
