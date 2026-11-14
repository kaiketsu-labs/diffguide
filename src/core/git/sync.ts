import { execFile } from 'node:child_process';
import { backUp, restoreBackup, snapshot } from './backups.js';
import { git } from './worktrees.js';

/**
 * How a sync with the PR's head on GitHub ended. `claude` leaves the checkout as it was and names the files whose local and GitHub changes clash;
 * no files means DiffGuide could not tell local commits from GitHub's earlier ones.
 */
export type SyncResult =
  | { readonly outcome: 'synced'; readonly head: string }
  | { readonly outcome: 'claude'; readonly head: string; readonly files: readonly string[] };

/** Where DiffGuide keeps the PR head it last fetched, so a force push can tell local commits from the ones GitHub replaced. */
const githubHeadRef = (number: number): string => `refs/diffguide/github/pr-${number}`;

/** Record the PR head a checkout was given from GitHub. */
export async function recordGitHubHead(checkout: string, number: number, head: string): Promise<void> {
  await git(checkout, ['update-ref', githubHeadRef(number), head]);
}

/** Fetch the PR's head from GitHub and record it; `previous` is the head recorded before, if any. */
export async function fetchGitHubHead(checkout: string, number: number): Promise<{ readonly head: string; readonly previous: string | undefined }> {
  const previous = (await git(checkout, ['rev-parse', '--verify', '--quiet', githubHeadRef(number)]).catch(() => '')).trim();
  await git(checkout, ['fetch', '--quiet', 'origin', `pull/${number}/head`]);
  const head = (await git(checkout, ['rev-parse', 'FETCH_HEAD'])).trim();
  await recordGitHubHead(checkout, number, head);
  return { head, previous: previous === '' ? undefined : previous };
}

const isAncestor = (checkout: string, older: string, newer: string): Promise<boolean> =>
  git(checkout, ['merge-base', '--is-ancestor', older, newer]).then(() => true, () => false);

const tree = async (checkout: string, revision: string): Promise<string> => (await git(checkout, ['rev-parse', `${revision}^{tree}`])).trim();

/** Three-way merge of trees or commits in the object store only; the checkout's files and index stay as they are. */
function mergeTree(checkout: string, base: string, ours: string, theirs: string): Promise<{ readonly tree: string } | { readonly clashes: readonly string[] }> {
  return new Promise((resolve, reject) => {
    execFile('git', ['-C', checkout, 'merge-tree', '--write-tree', '--name-only', '--no-messages', '--merge-base', base, ours, theirs],
      { encoding: 'utf8', timeout: 120_000, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
        const [result = '', ...clashes] = stdout.split('\n').filter(Boolean);
        if (error === null) resolve({ tree: result });
        else if (error.code === 1) resolve({ clashes: [...new Set(clashes)] });
        else reject(new Error(`git merge-tree failed: ${stderr.trim().slice(0, 400) || error.message}`));
      });
  });
}

/** Commit `files` on `parent` with another commit's author and message, as a rebase would. */
async function replayCommit(checkout: string, commit: string, files: string, parent: string): Promise<string> {
  const [name = '', email = '', date = '', ...message] = (await git(checkout, ['log', '-1', '--format=%an%n%ae%n%aI%n%B', commit])).split('\n');
  return (await git(checkout, ['commit-tree', '-p', parent, '-m', message.join('\n').trimEnd(), files],
    { GIT_AUTHOR_NAME: name, GIT_AUTHOR_EMAIL: email, GIT_AUTHOR_DATE: date })).trim();
}

/** The latest GitHub head that local commits build on: the recorded one or the page's last known one, whichever is newer and in HEAD's history. */
async function lastGitHubHead(checkout: string, local: string, known: readonly (string | undefined)[]): Promise<string | undefined> {
  let found: string | undefined;
  for (const candidate of known) {
    if (candidate === undefined || !await isAncestor(checkout, candidate, local)) continue;
    if (found === undefined || await isAncestor(checkout, found, candidate)) found = candidate;
  }
  return found;
}

/**
 * Bring a checkout to the PR's head on GitHub without losing local work: local commits are replayed onto it and uncommitted edits,
 * staged or not, are merged into its files. Everything is worked out in the object store first; the checkout changes only when all of it
 * merges cleanly, after a backup. `pushedHead` is a head GitHub had earlier, so a force push can be followed.
 */
export async function syncWithPullRequest(checkout: string, number: number, pushedHead?: string): Promise<SyncResult> {
  const { head, previous } = await fetchGitHubHead(checkout, number);
  for (let attempt = 1; ; attempt++) {
    const local = (await git(checkout, ['rev-parse', 'HEAD'])).trim();
    if (await isAncestor(checkout, head, local)) return { outcome: 'synced', head };
    const from = await isAncestor(checkout, local, head) ? local : await lastGitHubHead(checkout, local, [previous, pushedHead]);
    if (from === undefined) return { outcome: 'claude', head, files: [] };
    let target = head;
    for (const commit of (await git(checkout, ['rev-list', '--reverse', '--first-parent', `${from}..${local}`])).split('\n').filter(Boolean)) {
      const merged = await mergeTree(checkout, `${commit}^`, target, commit);
      if ('clashes' in merged) return { outcome: 'claude', head, files: merged.clashes };
      // A commit GitHub already has changes nothing, so it goes, as in a rebase.
      if (merged.tree !== await tree(checkout, target)) target = await replayCommit(checkout, commit, merged.tree, target);
    }
    const before = await snapshot(checkout);
    if (before.staged === undefined) throw new Error('A merge with conflicts is in progress in this checkout.');
    const localTree = await tree(checkout, local);
    const files = before.files === localTree ? { tree: await tree(checkout, target) } : await mergeTree(checkout, localTree, target, before.files);
    if ('clashes' in files) return { outcome: 'claude', head, files: files.clashes };
    const staged = before.staged === localTree ? { tree: await tree(checkout, target) } : await mergeTree(checkout, localTree, target, before.staged);
    if ('clashes' in staged) return { outcome: 'claude', head, files: staged.clashes };
    const ignored = await ignoredFilesIn(checkout, before.files, files.tree);
    if (ignored.length > 0) return { outcome: 'claude', head, files: ignored };
    const backup = await backUp(checkout, 'syncing with GitHub');
    // An edit saved since the snapshot would be overwritten; start over from the new state instead.
    if ((await snapshot(checkout)).files !== before.files || (await git(checkout, ['rev-parse', 'HEAD'])).trim() !== local) {
      if (attempt < 3) continue;
      throw new Error('The checkout kept changing during the sync.');
    }
    try {
      await git(checkout, ['update-ref', '-m', 'DiffGuide: sync with GitHub', 'HEAD', target, local]);
      await git(checkout, ['read-tree', '--reset', '-u', files.tree]);
      await git(checkout, ['read-tree', staged.tree]);
    } catch (error: unknown) {
      if (backup !== undefined) await restoreBackup(checkout, backup);
      throw error;
    }
    return { outcome: 'synced', head };
  }
}

/** Ignored files the sync would overwrite, because GitHub now tracks a file at their path. */
async function ignoredFilesIn(checkout: string, current: string, next: string): Promise<readonly string[]> {
  const changed = new Set((await git(checkout, ['diff-tree', '-r', '-z', '--name-only', '--no-renames', current, next])).split('\0').filter(Boolean));
  if (changed.size === 0) return [];
  const ignored = (await git(checkout, ['ls-files', '-z', '--others', '--ignored', '--exclude-standard'])).split('\0').filter(Boolean);
  return ignored.filter((path) => changed.has(path));
}
