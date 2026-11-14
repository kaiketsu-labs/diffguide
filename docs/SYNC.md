# Keeping checkouts in sync

Design and status of sync. See Status for what is built.

DiffGuide moves code in three kinds of checkout: PR worktrees under `.claude/worktrees/diffguide/`, linked-repository worktrees, and your own checkout when a PR page opens on it. Remote changes arrive from GitHub while you, Claude, or both edit locally. This page lists every state a sync can meet and what DiffGuide does in each, so no sync loses local work or ends in an error you must fix by hand.

## Rules

1. Back up before every Git write. DiffGuide saves HEAD, the index, the working tree and untracked files under `refs/diffguide/backup/<checkout>/<time>` before it moves anything. Ignored files are never touched, so they need no backup.
2. Dry-run before touching files. `git merge-tree --write-tree` decides whether a merge or rebase applies cleanly without changing the checkout.
3. Try the deterministic steps in a fixed order: fast-forward, then clean 3-way merge of edits, then clean rebase of local commits. Claude resolves only what is left.
4. Claude resolves in a scratch worktree made after the backup, never in the checkout you edit. Its result is applied only when `git diff --check` finds no conflict markers and your checkout has not changed since the backup.
5. A failed step restores the backup and leaves a page notice with one action. A transient failure (offline, lock held) waits and retries without a notice.
6. Review data follows code through `anchors.ts`. A thread or read mark whose code no longer matches lapses; it never moves to other lines.

## Backup recipe

Verified on Git 2.50.1. `git stash create` leaves out untracked files, so it is not enough.

```sh
cp .git/index "$tmp"                                   # the worktree's own index file
GIT_INDEX_FILE="$tmp" git add -A                       # tracked edits and untracked files
worktree=$(GIT_INDEX_FILE="$tmp" git write-tree)
index=$(git commit-tree -p HEAD -m index "$(git write-tree)")
backup=$(git commit-tree -p HEAD -p "$index" -m backup "$worktree")
git update-ref "refs/diffguide/backup/<checkout>/<time>" "$backup"
```

`git status` shows the same state before and after.

## Current behavior

Every path below either loses work or stops on an error. Line numbers are at `b16ecec`.

### Loses work

The first two rows are fixed: both now save a backup first (`src/core/git/backups.ts`). On someone else's PR, the cleanup still removes your files from the worktree; they are only recoverable from the backup until it discards just Claude's files.

| Where | What happens |
|---|---|
| `src/hosts/vscode/pullRequestSessions.ts:318` | On someone else's PR, after Claude's run, `discardSince` runs `reset --hard` and `clean -d --force` when the worktree was clean at the start. Edits or new files you made in the worktree during the run are deleted. |
| `src/core/git/worktrees.ts:156` | Remove worktree runs `git worktree remove`, which refuses uncommitted changes but not unpushed commits. On the detached HEAD, those commits become unreachable. Reproduced in a temp repo: `git fsck` lists the commit as unreachable after removal. The page's confirm text does not mention commits. |
| `src/core/git/git.ts:14` | `runGit` treats exit codes 1 and 128 as "no output". A failed read, such as a missing commit after a force push, shows an empty file instead of an error. No data is lost, but the page shows the wrong code. |

### Stops on an error

| Where | Situation | Message today |
|---|---|---|
| `conflicts.ts:25` | Local commits on top of GitHub's head | "has commits that are not on GitHub. Push or drop them first." |
| `conflicts.ts:26` | Local commits and new GitHub commits (diverged) | "Rebase them onto the PR's latest commit or drop them first." |
| `conflicts.ts:24`, `worktreeActions.ts:56` | Force push seen on the first poll after the page opens: `previous` is unset, so the old head is unknown and the worktree reads as diverged | Same as the row above |
| `conflicts.ts:30` | GitHub changed files that have local edits | "Commit, push or discard them to update." |
| `conflicts.ts:9` | Fix conflicts with uncommitted changes | "Commit or discard them first." |
| `worktreeActions.ts:40` | `followBase` fetch fails (offline, auth) and is not caught, so the whole poll fails and the head never syncs | Nothing: `pollWhileFocused` drops the error |
| `conflicts.ts:20` via `worktreeActions.ts:56` | PR head fetch fails (offline, auth) | Raw `git fetch failed` |
| `suggestionActions.ts:27`, `pullRequestPageActions.ts:136` | Apply or commit a suggestion on a file with local edits | "has uncommitted changes. Commit or discard them first." |
| `pullRequestPageActions.ts:140` | Commit suggestions while unpushed commits changed those files | "Push or rebase the unpushed commits first." |
| `conflicts.ts:86` | Push rejected because GitHub moved meanwhile | Raw `git push failed` (the commit is taken back) |
| `worktreeActions.ts:54` | Your own checkout is behind GitHub | "Pull them to see them here." |
| `linkedChanges.ts:202` | Linked branch is checked out in your own checkout | "Switch that checkout to another branch" |
| none | Claude's conflict run stops mid-merge (crash, stop): `MERGE_HEAD` stays, and the next sync fails on "resolve your current index first" | Raw Git error |
| none | `index.lock` held by VS Code's Git extension or a terminal | Raw Git error |

## Decision table

Rows are what the checkout holds. Columns are what GitHub did since the last sync. "Edits" means uncommitted or untracked files. "Local commits" means commits GitHub's head does not contain.

| Checkout holds | GitHub added commits | GitHub force-pushed | Base moved or retargeted | Branch deleted, PR closed or merged | Offline or auth failed |
|---|---|---|---|---|---|
| Nothing local | Fast-forward. | Move to the new head. | Fetch the base, rediff. | Keep the checkout, mark the PR, let cleanup remove it. | Keep last state, show "Offline", retry next poll. |
| Edits, no overlap with GitHub's change | Fast-forward; edits stay. | Move; edits stay. | Fetch, rediff. | Keep. | Retry. |
| Edits that overlap | Back up, move, 3-way merge the edits onto the new head. Clean: done. Conflict: Claude. | Same, against the new head. | Fetch, rediff. | Keep. | Retry. |
| Local commits on GitHub's head | Back up, rebase the local commits onto the new head. Clean: done. Conflict: Claude. | Rebase only the commits after the old head (`rebase --onto new old`). The old head comes from the last poll or the backup ref, so a first poll no longer misreads it. | Fetch, rediff. | Keep; Remove worktree warns about them. | Retry. |
| Local commits and edits | Back up, rebase commits, then merge edits, each step as above. | Same, with `--onto`. | Fetch, rediff. | Keep. | Retry. |
| Merge or rebase in progress, started by DiffGuide | Abort it, restore the backup, then sync as above. | Same. | Same. | Same. | Retry. |
| Merge or rebase in progress, started by you | Wait. Show "Finish your merge to sync". No writes. | Wait. | Fetch only. | Keep. | Retry. |
| Claude is running | Wait until it finishes, then sync. The page already says the files are out of date. | Wait. | Fetch only. | Wait. | Retry. |
| `index.lock` held | Retry with backoff. After 30 s, show "Waiting for Git". Never delete the lock. | Same. | Same. | Same. | Retry. |
| Worktree folder missing | Recreate it from GitHub's head; the review data folder is kept. | Same. | Same. | Drop the record. | Retry. |

Actions outside polling follow the same steps:

- Apply or commit a suggestion on a file with edits: back up, apply the suggestion as a 3-way merge with the edits, commit only the suggestion's hunk. Conflict: Claude.
- Fix conflicts with edits: back up, set the edits aside, run the fix, merge the edits back.
- Push rejected because GitHub moved: sync (row "Local commits"), then push again once.
- After Claude's run on someone else's PR: back up before `discardSince`, and only discard what Claude changed. Files you touched during the run stay.
- Remove worktree with local commits: the confirm names the count; removal backs them up first, so the commits stay reachable for 14 days.

## Claude's step

Each clashing step (a local commit, or the uncommitted edits) goes to Claude in a scratch worktree under the system temp folder: the step's new parent is checked out and the clashing files hold diff3 conflict markers from `git merge-tree`. Claude runs in a new conversation that is not kept, may read history with `git diff`, `log`, `show` and `status`, and edits only those files. DiffGuide then checks:

- `git diff --check` finds no leftover conflict marker in the resolved files. As in Git, nothing parses the files.
- Your checkout still matches the snapshot the sync started from. When it does not, nothing is written and the next poll starts over.

Only the clashing files are taken from Claude's copy. A staged edit that clashes leaves GitHub's version in the index, so the resolved file shows as unstaged. The page's notice offers Undo, which backs up the checkout and restores the backup taken before the sync; the page then leaves GitHub's head alone until it moves again.

Claude asks by leaving the files unchanged with a reply. The checkout stays as before the sync, the question shows above the tabs with an answer box, and Sync runs the sync again with the answer. A result that keeps markers, or a failed run, shows a notice and leaves the checkout as it was. Either way, polls do not ask Claude again until the checkout or GitHub's head changes.

Fix conflicts also runs in a scratch worktree, at GitHub's head, and pushes from there. The checkout's edits and local commits follow at the next sync.

## Status

Built (`src/core/git/sync.ts`, `src/core/git/backups.ts`): backups, fast-forward with edits, 3-way merge of staged and unstaged edits, replay of local commits, force pushes, your own checkout. Waiting without an error: offline, failed Git sign-in, `index.lock` held (retried for about 5 s first), and your own merge, rebase, cherry-pick or revert. The page says why in a notice that hides after 4 s and shows again only when the reason changes. The sync records GitHub's head in `refs/diffguide/github/pr-<n>` at every fetch, so it can tell local commits from replaced ones.

Claude's step: clashing commits and edits are merged by Claude in a scratch worktree and applied after the checks, with Undo. Fix conflicts runs in a scratch worktree and accepts uncommitted edits. A push rejected because the PR moved syncs and pushes again once. After Claude's run on someone else's PR, files saved in VS Code during the run stay; the rest is discarded after a backup.

Known limits:

- Replayed commits are not signed, even with `commit.gpgSign`: `git commit-tree` ignores that setting (checked on Git 2.50.1).
- On your own checkout, the branch moves but `origin/<branch>` stays until the next fetch, so VS Code may show it as ahead meanwhile. Not yet checked in VS Code.
- A worktree made before this change has no recorded head. A force push seen on its page's first check still stops with the old message; later checks have the head.
- `merge-tree` with trees as inputs is checked on Git 2.50.1 only.
- A merge left in a PR worktree by an interrupted conflict fix from before this change counts as yours, so the sync waits for it. Conflict fixes now run in a scratch worktree, so new runs cannot leave one.
- Nothing checks that Claude's resolved files parse; Git does not either. TypeScript 7 has no JavaScript API to bundle, and TextMate grammars report no errors.
- An edit saved while Claude resolves discards Claude's result; the next poll asks Claude again from the new state.
- A clashing staged edit with no clash in the working files syncs without Claude and without the Undo notice; the backup still holds the staged version.
- When the GitHub API itself is out of reach, the poll stops before the sync and shows nothing, as before.

## Proof

`test/sync.test.ts` runs every cell of the table and each action above against a real checkout and a fake GitHub repository. Cells that fail today are listed in its `gaps` sets and run as todos; fixing one removes it from the list.


- A harness in `test/sync/` builds a bare "GitHub" repo and a checkout in a temp folder for every table cell, runs the sync, and checks two things. First, every file version and commit that existed before is reachable from the checkout or a backup ref. Second, every commit GitHub pushed is in the checkout, or the page shows Claude's question.
- Fault injection: kill Git mid-rebase, hold `index.lock`, make the remote unreachable, and force-push between the fetch and the move.
- A property test generates random sequences of local edits, local commits and remote pushes and checks the same two invariants after each sync.
- Claude's step runs against fixed conflict fixtures with a simulated agent in tests, and against authenticated Claude by hand.
- `scripts/e2e.mjs` gains scenarios for a remote push while you edit, run several times.

## Decisions

- Claude's resolution is applied once the checks pass. The page notice offers Undo, which restores the backup.
- Your own checkout follows the same rules as PR worktrees. The page no longer says "Pull them".
- On someone else's PR, DiffGuide backs up, then discards only the files Claude changed during its run: every file changed during the run except those you saved in a VS Code editor meanwhile. Edits made in a terminal during the run are discarded, and stay in the backup.
- Claude's checks are Git's: no leftover conflict markers. No parse check.
- Claude's question shows inline above the tabs, not as a modal, with a notice whose Show button brings it into view.
- The Undo notice stays until Undo, close or the next sync. Undo backs up first, so edits made after the sync stay in a backup.
- Backup refs live 14 days, and the page menu lists recent ones for restore. Removing a worktree deletes its backups only when it held no edits and no unpushed commits; otherwise they stay for the full 14 days.
