import { execFile } from 'node:child_process';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentTask, AgentTaskResult } from '../agent.js';
import { backUp, restoreBackup, snapshot } from './backups.js';
import { makeScratchWorktree, type ScratchWorktree, showInScratch } from './scratch.js';
import { git } from './worktrees.js';

/** Why a sync left the checkout for now: GitHub out of reach, Git's sign-in failing, Git busy or files changing in the checkout, or a Git operation you started. */
export type SyncWait = 'offline' | 'sign-in' | 'busy' | 'merge' | 'rebase' | 'cherry-pick' | 'revert';

/** What Claude resolved in a sync: the files, the backup Undo restores, and how many commits GitHub added. */
export interface SyncResolution {
  readonly files: readonly string[];
  readonly backup: string;
  readonly commits: number;
}

/**
 * How a sync with the PR's head on GitHub ended. `synced` has `resolved` when Claude merged clashing files.
 * Every other outcome leaves the checkout as it was. `claude` names the files whose local and GitHub changes clash, with no resolver or one that `tried` this state before;
 * no files means DiffGuide could not tell local commits from GitHub's earlier ones. `question` is Claude asking how to resolve; `rejected` is a result
 * that kept conflict markers in `files`, or Claude's `error`. `again` means the checkout changed while Claude worked, so the next sync starts over.
 * `waits` means the next sync tries again. `attempt` names the state Claude tried, for `SyncResolver.tried`.
 */
export type SyncResult =
  | { readonly outcome: 'synced'; readonly head: string; readonly resolved?: SyncResolution }
  | { readonly outcome: 'claude'; readonly head: string; readonly files: readonly string[]; readonly tried?: true }
  | { readonly outcome: 'question'; readonly head: string; readonly files: readonly string[]; readonly question: string; readonly attempt: string }
  | { readonly outcome: 'rejected'; readonly head: string; readonly files: readonly string[]; readonly error?: string; readonly attempt: string }
  | { readonly outcome: 'again' }
  | { readonly outcome: 'waits'; readonly reason: SyncWait };

/**
 * Claude's part of a sync: `run` runs a task in a scratch worktree, and `answer` is your reply to Claude's last question.
 * A sync whose state equals `tried` stays as it is instead of asking Claude again.
 */
export interface SyncResolver {
  readonly run: (task: AgentTask) => Promise<AgentTaskResult>;
  readonly answer?: string;
  readonly tried?: string;
}

/** What the page says while a sync waits. */
export function waitMessage(reason: SyncWait): string {
  if (reason === 'offline') return 'GitHub is out of reach, so this checkout stays at the last commit fetched. DiffGuide tries again on its own.';
  if (reason === 'sign-in') return 'Git could not sign in to GitHub, so this checkout stays at the last commit fetched. DiffGuide tries again on its own.';
  if (reason === 'busy') return 'Git is busy in this checkout. DiffGuide syncs it when Git is done.';
  return `A ${reason} is in progress in this checkout. DiffGuide syncs it once you finish or abort the ${reason}.`;
}

/** Git's messages when it reached GitHub but could not sign in. */
const signInFailed = /Authentication failed|could not read Username|terminal prompts disabled|Permission denied \(publickey|returned error: 403/u;

/** Another Git process holds a lock file in the repository. */
const lockHeld = /\.lock': File exists/u;

/** Retry delays while another Git process holds a lock, about five seconds in all. */
const lockDelays = [250, 500, 1_000, 1_500, 2_000];

/** Run a Git step again while another Git process holds a lock, up to `lockDelays`. */
async function whileLocked<T>(step: () => Promise<T>): Promise<T> {
  for (const delay of lockDelays) {
    try {
      return await step();
    } catch (error: unknown) {
      if (!lockHeld.test(String(error))) throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, delay));
  }
  return await step();
}

/** The Git operation in progress in a checkout, from the files Git keeps while it waits for you. */
async function operationInProgress(checkout: string): Promise<SyncWait | undefined> {
  const markers = [['MERGE_HEAD', 'merge'], ['rebase-merge', 'rebase'], ['rebase-apply', 'rebase'], ['CHERRY_PICK_HEAD', 'cherry-pick'], ['REVERT_HEAD', 'revert']] as const;
  for (const [marker, operation] of markers) {
    const where = (await git(checkout, ['rev-parse', '--path-format=absolute', '--git-path', marker])).trim();
    if (await stat(where).then(() => true, () => false)) return operation;
  }
  return (await git(checkout, ['ls-files', '--unmerged'])).trim() === '' ? undefined : 'merge';
}

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

/** Two trees merged with conflicts: the clashing files, and a tree holding them with diff3 conflict markers. */
interface Clash {
  readonly clashes: readonly string[];
  readonly markers: string;
}

/** Three-way merge of trees or commits in the object store only; the checkout's files and index stay as they are. */
function mergeTree(checkout: string, base: string, ours: string, theirs: string): Promise<{ readonly tree: string } | Clash> {
  return new Promise((resolve, reject) => {
    execFile('git', ['-C', checkout, '-c', 'merge.conflictStyle=diff3', 'merge-tree', '--write-tree', '--name-only', '--no-messages', '--merge-base', base, ours, theirs],
      { encoding: 'utf8', timeout: 120_000, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
        const [result = '', ...clashes] = stdout.split('\n').filter(Boolean);
        if (error === null) resolve({ tree: result });
        else if (error.code === 1) resolve({ clashes: [...new Set(clashes)], markers: result });
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
 * merges, after a backup. With a `resolver`, Claude merges clashing files in a scratch worktree, and its result applies only when no conflict
 * marker is left and the checkout did not change meanwhile. A staged edit that clashes leaves GitHub's version in the index, so the resolved
 * file shows as unstaged. `pushedHead` is a head GitHub had earlier, so a force push can be followed.
 */
export async function syncWithPullRequest(checkout: string, number: number, pushedHead?: string, resolver?: SyncResolver): Promise<SyncResult> {
  const fetched = await fetchGitHubHead(checkout, number).catch((error: unknown) => ({ reason: signInFailed.test(String(error)) ? 'sign-in' as const : 'offline' as const }));
  if ('reason' in fetched) return { outcome: 'waits', reason: fetched.reason };
  for (const delay of [...lockDelays, undefined]) {
    try {
      const result = await syncOnce(checkout, fetched, pushedHead, resolver);
      if (result !== 'changed') return result;
    } catch (error: unknown) {
      if (!lockHeld.test(String(error))) throw error;
    }
    if (delay === undefined) return { outcome: 'waits', reason: 'busy' };
    await new Promise((resolve) => setTimeout(resolve, delay));
  }
  return { outcome: 'waits', reason: 'busy' };
}

/** One try at a sync; `changed` when the checkout changed while it ran, so nothing was written. */
async function syncOnce(checkout: string, { head, previous }: { readonly head: string; readonly previous: string | undefined }, pushedHead: string | undefined,
  resolver: SyncResolver | undefined): Promise<SyncResult | 'changed'> {
  const local = (await git(checkout, ['rev-parse', 'HEAD'])).trim();
  if (await isAncestor(checkout, head, local)) return { outcome: 'synced', head };
  const operation = await operationInProgress(checkout);
  if (operation !== undefined) return { outcome: 'waits', reason: operation };
  const from = await isAncestor(checkout, local, head) ? local : await lastGitHubHead(checkout, local, [previous, pushedHead]);
  if (from === undefined) return { outcome: 'claude', head, files: [] };
  const before = await snapshot(checkout);
  if (before.staged === undefined) return { outcome: 'waits', reason: 'merge' };
  const attempt = [head, local, before.files, before.staged].join(' ');
  let backup: string | undefined;
  let scratch: ScratchWorktree | undefined;
  const resolved = new Set<string>();
  /** Claude's merge of a clash on `parent`, or how the sync ends instead. */
  const resolve = async (parent: string, clash: Clash, what: string): Promise<{ readonly tree: string } | SyncResult> => {
    if (resolver === undefined) return { outcome: 'claude', head, files: clash.clashes };
    if (resolver.tried === attempt) return { outcome: 'claude', head, files: clash.clashes, tried: true };
    backup ??= await backUp(checkout, 'syncing with GitHub');
    scratch ??= await makeScratchWorktree(checkout, local);
    const result = await resolveClash(scratch.path, parent, clash, what, resolver);
    if ('tree' in result) for (const file of clash.clashes) resolved.add(file);
    return 'tree' in result ? result
      : 'question' in result ? { outcome: 'question', head, files: clash.clashes, question: result.question, attempt }
      : { outcome: 'rejected', head, files: result.files ?? clash.clashes, ...result.error === undefined ? {} : { error: result.error }, attempt };
  };
  try {
    let target = head;
    for (const commit of (await git(checkout, ['rev-list', '--reverse', '--first-parent', `${from}..${local}`])).split('\n').filter(Boolean)) {
      const merged = await mergeTree(checkout, `${commit}^`, target, commit);
      const result = 'clashes' in merged ? await resolve(target, merged, `the local commit "${(await git(checkout, ['log', '-1', '--format=%s', commit])).trim()}"`) : merged;
      if ('outcome' in result) return result;
      // A commit GitHub already has changes nothing, so it goes, as in a rebase.
      if (result.tree !== await tree(checkout, target)) target = await replayCommit(checkout, commit, result.tree, target);
    }
    const localTree = await tree(checkout, local);
    const mergedFiles = before.files === localTree ? { tree: await tree(checkout, target) } : await mergeTree(checkout, localTree, target, before.files);
    const files = 'clashes' in mergedFiles ? await resolve(target, mergedFiles, 'uncommitted edits') : mergedFiles;
    if ('outcome' in files) return files;
    const mergedStaged = before.staged === localTree ? { tree: await tree(checkout, target) } : await mergeTree(checkout, localTree, target, before.staged);
    if ('clashes' in mergedStaged && resolver === undefined) return { outcome: 'claude', head, files: mergedStaged.clashes };
    const staged = 'clashes' in mergedStaged ? { tree: await withTargetVersions(checkout, mergedStaged, target) } : mergedStaged;
    const ignored = await ignoredFilesIn(checkout, before.files, files.tree);
    if (ignored.length > 0) return { outcome: 'claude', head, files: ignored };
    backup ??= await backUp(checkout, 'syncing with GitHub');
    // An edit saved since the snapshot would be overwritten; start over from the new state instead.
    if ((await snapshot(checkout)).files !== before.files || (await git(checkout, ['rev-parse', 'HEAD'])).trim() !== local) return resolved.size > 0 ? { outcome: 'again' } : 'changed';
    await git(checkout, ['update-ref', '-m', 'DiffGuide: sync with GitHub', 'HEAD', target, local]);
    try {
      await git(checkout, ['read-tree', '--reset', '-u', files.tree]);
    } catch (error: unknown) {
      // read-tree takes the index lock before it writes, so only HEAD moved.
      await git(checkout, ['update-ref', '-m', 'DiffGuide: undo a sync', 'HEAD', local, target]);
      throw error;
    }
    const restore = backup;
    await whileLocked(() => git(checkout, ['read-tree', staged.tree])).catch(async (error: unknown) => {
      if (restore !== undefined) await whileLocked(() => restoreBackup(checkout, restore));
      throw error;
    });
    if (resolved.size === 0 || backup === undefined) return { outcome: 'synced', head };
    const commits = Number((await git(checkout, ['rev-list', '--count', `${from}..${head}`])).trim());
    return { outcome: 'synced', head, resolved: { files: [...resolved], backup, commits } };
  } finally {
    await scratch?.remove();
  }
}

/** The label of Claude's run when GitHub's new commits clash with local work. */
export const clashLabel = 'merging GitHub\'s new commits';

/** Ask Claude to resolve conflict markers in a scratch worktree; it may read history but not change it. */
export function clashTask(scratch: string, files: readonly string[], what: string, answer?: string): AgentTask {
  return {
    label: clashLabel,
    cwd: scratch,
    prompt: [
      `The pull request has new commits on GitHub that clash with ${what}. This folder is a scratch copy at GitHub's latest commit, with these files merged and marked with diff3 conflict markers: ${files.join(', ')}.`,
      'Resolve every conflict in those files so both sides\' intent survives, and remove every conflict marker. Change no other file, and run no Git command that changes commits, branches or the index. DiffGuide checks your result and then applies it to the user\'s checkout.',
      'If a conflict needs a decision the code does not answer, leave the files as they are and explain what is needed.',
      'Finish with one line per file saying how you resolved it.',
      ...(answer === undefined ? [] : [`You stopped here before and asked the user how to resolve the conflicts. They answered:\n\n${answer}`]),
    ].join('\n\n'),
    allowedTools: ['Bash(git status)', 'Bash(git status *)', 'Bash(git diff)', 'Bash(git diff *)', 'Bash(git log *)', 'Bash(git show *)'],
  };
}

/** Let Claude resolve a clash in the scratch worktree: the merged tree, Claude's question, or the files that kept markers or Claude's error. */
async function resolveClash(scratch: string, parent: string, { clashes, markers }: Clash, what: string, { run, answer }: SyncResolver):
  Promise<{ readonly tree: string } | { readonly question: string } | { readonly files?: readonly string[]; readonly error?: string }> {
  await showInScratch(scratch, parent, markers);
  const { error, reply } = await run(clashTask(scratch, clashes, what, answer));
  if (error !== undefined) return { error };
  const resolved = await treeWith(scratch, markers, clashes);
  // Claude asks by leaving the files as they were.
  if (resolved === markers) return reply === undefined ? { error: 'Claude changed none of the files.' } : { question: reply };
  const left = await markersLeft(scratch, parent, resolved, clashes);
  return left.length === 0 ? { tree: resolved } : { files: left };
}

const literal = (files: readonly string[]): string[] => files.map((file) => `:(literal)${file}`);

/** `tree` with `files` as they are in the scratch worktree; other files stay as in `tree`. */
async function treeWith(scratch: string, tree: string, files: readonly string[]): Promise<string> {
  const folder = await mkdtemp(join(tmpdir(), 'diffguide-resolved-'));
  try {
    const env = { GIT_INDEX_FILE: join(folder, 'index') };
    await git(scratch, ['read-tree', tree], env);
    await git(scratch, ['add', '--all', '--', ...literal(files)], env);
    return (await git(scratch, ['write-tree'], env)).trim();
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
}

/** A merged tree whose clashing files take `target`'s version, so a staged edit that clashed shows as unstaged. */
async function withTargetVersions(checkout: string, { clashes, markers }: Clash, target: string): Promise<string> {
  const folder = await mkdtemp(join(tmpdir(), 'diffguide-staged-'));
  try {
    const env = { GIT_INDEX_FILE: join(folder, 'index') };
    await git(checkout, ['read-tree', markers], env);
    await git(checkout, ['reset', '--quiet', target, '--', ...literal(clashes)], env);
    return (await git(checkout, ['write-tree'], env)).trim();
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
}

/** Files among `files` where `tree` adds conflict markers to `parent`, as `git diff --check` finds them. */
function markersLeft(scratch: string, parent: string, tree: string, files: readonly string[]): Promise<readonly string[]> {
  return new Promise((resolve, reject) => {
    execFile('git', ['-C', scratch, '-c', 'core.quotePath=false', 'diff', '--check', parent, tree, '--', ...literal(files)],
      { encoding: 'utf8', timeout: 120_000, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
        // Exit code 2 means problems; whitespace errors count too, so only marker lines are read.
        if (error !== null && error.code !== 2) reject(new Error(`git diff --check failed: ${stderr.trim().slice(0, 400) || error.message}`));
        else resolve([...new Set(stdout.split('\n').flatMap((line) => /^(.*):\d+: leftover conflict marker$/u.exec(line)?.[1] ?? []))]);
      });
  });
}

/** Undo a sync Claude resolved: back up the checkout as it is now, then put back the state from before the sync. */
export async function undoSync(checkout: string, backup: string): Promise<void> {
  await backUp(checkout, 'undoing a sync');
  await restoreBackup(checkout, backup);
}

/** Ignored files the sync would overwrite, because GitHub now tracks a file at their path. */
async function ignoredFilesIn(checkout: string, current: string, next: string): Promise<readonly string[]> {
  const changed = new Set((await git(checkout, ['diff-tree', '-r', '-z', '--name-only', '--no-renames', current, next])).split('\0').filter(Boolean));
  if (changed.size === 0) return [];
  const ignored = (await git(checkout, ['ls-files', '-z', '--others', '--ignored', '--exclude-standard'])).split('\0').filter(Boolean);
  return ignored.filter((path) => changed.has(path));
}
