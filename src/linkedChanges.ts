import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { readPrivateJson, writePrivateJson } from './privateFiles.js';
import { git } from './worktrees.js';

/** A PR in another repository that this PR's change goes with. */
export interface LinkedPullRequest { readonly repository: string; readonly number: number }

/** Why a linked repository shows up: GitHub cross-references, a dependency pin in the diff, Claude's edit, or the user. */
export type LinkSource = 'mention' | 'pin' | 'claude' | 'manual';

/** Links the user added and removed by hand, and repositories Claude worked in, kept beside the PR's review data. */
export interface StoredLinks {
  readonly added: readonly LinkedPullRequest[];
  readonly removed: readonly string[];
  /** Repositories Claude opened a worktree in for this PR, by `owner/name`. */
  readonly worked: readonly string[];
}

const emptyLinks: StoredLinks = { added: [], removed: [], worked: [] };
const repositoryPattern = /^[\w.-]+\/[\w.-]+$/u;
/** `owner/name` without `.` or `..` parts, so a stored name cannot leave worktree storage. */
const repositoryName = { test: (name: string): boolean => repositoryPattern.test(name) && name.split('/').every((part) => part !== '.' && part !== '..') };

/** `owner/name#12` for a linked PR, `owner/name` for a repository without one; the key Unlink removes. */
export function linkKey(link: { readonly repository: string; readonly number?: number }): string {
  return (link.number === undefined ? link.repository : `${link.repository}#${link.number}`).toLowerCase();
}

function linksPath(dataPath: string): string {
  return join(dataPath, 'linked-changes.json');
}

export async function readStoredLinks(dataPath: string): Promise<StoredLinks> {
  const value = await readPrivateJson(linksPath(dataPath)).catch(() => undefined) as Partial<Record<keyof StoredLinks, unknown>> | undefined;
  if (typeof value !== 'object' || value === null) return emptyLinks;
  const strings = (list: unknown): string[] => Array.isArray(list) ? list.filter((item): item is string => typeof item === 'string') : [];
  const added = Array.isArray(value.added) ? value.added.flatMap((item: unknown) => {
    const { repository, number } = (typeof item === 'object' && item !== null ? item : {}) as { repository?: unknown; number?: unknown };
    return typeof repository === 'string' && repositoryName.test(repository) && Number.isSafeInteger(number) && (number as number) > 0 ? [{ repository, number: number as number }] : [];
  }) : [];
  return { added, removed: strings(value.removed), worked: strings(value.worked).filter((name) => repositoryName.test(name)) };
}

export async function writeStoredLinks(dataPath: string, links: StoredLinks): Promise<void> {
  await writePrivateJson(linksPath(dataPath), links);
}

/** Link a PR by hand; it also undoes an earlier Unlink of it. */
export function addLink(links: StoredLinks, link: LinkedPullRequest): StoredLinks {
  const key = linkKey(link);
  return { ...links, added: [...links.added.filter((each) => linkKey(each) !== key), link], removed: links.removed.filter((each) => each !== key) };
}

/** Unlink a PR or a repository; found links with that key stay hidden until linked again. */
export function removeLink(links: StoredLinks, key: string): StoredLinks {
  const lower = key.toLowerCase();
  return { added: links.added.filter((each) => linkKey(each) !== lower), removed: [...new Set([...links.removed, lower])], worked: links.worked.filter((name) => name.toLowerCase() !== lower) };
}

/** Remember that Claude worked in `repository` for this PR. */
export function addWorked(links: StoredLinks, repository: string): StoredLinks {
  const lower = repository.toLowerCase();
  return links.worked.some((name) => name.toLowerCase() === lower) ? links
    : { ...links, worked: [...links.worked, repository], removed: links.removed.filter((each) => each !== lower) };
}

/** PRs in other repositories that GitHub reports as mentioned from or mentioning this PR, from `CrossReferencedEvent` nodes. */
export function crossReferences(nodes: readonly unknown[], self: string): readonly LinkedPullRequest[] {
  const found = new Map<string, LinkedPullRequest>();
  for (const node of nodes) {
    const { source, target } = (typeof node === 'object' && node !== null ? node : {}) as { source?: unknown; target?: unknown };
    for (const side of [source, target]) {
      const { number, repository } = (typeof side === 'object' && side !== null ? side : {}) as { number?: unknown; repository?: unknown };
      const name = typeof repository === 'object' && repository !== null ? (repository as { nameWithOwner?: unknown }).nameWithOwner : undefined;
      if (typeof name !== 'string' || !repositoryName.test(name) || !Number.isSafeInteger(number) || name.toLowerCase() === self.toLowerCase()) continue;
      const link = { repository: name, number: number as number };
      found.set(linkKey(link), link);
    }
  }
  return [...found.values()];
}

/** A branch of another GitHub repository that added lines of the diff pin, such as a git dependency in `pyproject.toml`, `package.json` or `Cargo.toml`. */
export interface BranchPin { readonly repository: string; readonly branch: string }

/**
 * Read branch pins from added diff lines: `owner/name.git@branch` (pip, uv, poetry), `github:owner/name#branch` and
 * `github.com/owner/name#branch` (npm), and a GitHub URL with `branch = "..."` on the same line (Cargo, uv sources).
 */
export function branchPins(addedLines: readonly string[]): readonly BranchPin[] {
  const pins = new Map<string, BranchPin>();
  const add = (owner: string | undefined, name: string | undefined, branch: string | undefined): void => {
    if (owner === undefined || name === undefined || branch === undefined) return;
    const repository = `${owner}/${name.replace(/\.git$/u, '')}`;
    const clean = branch.replace(/["',\s]+$/u, '');
    if (!repositoryName.test(repository) || !/^[\w./-]+$/u.test(clean) || /^[\da-f]{7,40}$/u.test(clean) || /^v?\d+(\.\d+)*$/u.test(clean)) return;
    pins.set(`${repository.toLowerCase()}@${clean}`, { repository, branch: clean });
  };
  for (const line of addedLines) {
    for (const match of line.matchAll(/github\.com[/:]([\w.-]+)\/([\w.-]+?)(?:\.git)?@([\w./-]+)/gu)) add(match[1], match[2], match[3]);
    for (const match of line.matchAll(/(?:github:|github\.com\/)([\w.-]+)\/([\w.-]+?)(?:\.git)?#([\w./-]+)/gu)) add(match[1], match[2], match[3]);
    const url = /github\.com[/:]([\w.-]+)\/([\w.-]+?)(?:\.git)?["'\s,}]/u.exec(line);
    const branch = /\bbranch\s*=\s*["']([\w./-]+)["']/u.exec(line);
    if (url !== null && branch !== null) add(url[1], url[2], branch[1]);
  }
  return [...pins.values()];
}

/** Lines a unified diff adds, without the leading `+`. */
export function addedLines(diff: string): readonly string[] {
  return diff.split('\n').filter((line) => line.startsWith('+') && !line.startsWith('+++')).map((line) => line.slice(1));
}

/** A lock file another window's Claude run holds; `owner` names it for the waiting run's step. */
interface LockFile { readonly owner: string; readonly pid: number; readonly at: number }

/** Locks older than this belong to a run that died without releasing them. */
const staleLockMs = 2 * 60 * 60 * 1000;

/** Whether a process with this ID is still running. */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: unknown) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * One Claude run at a time in a worktree, across VS Code windows: a lock file beside the worktree, created exclusively.
 * Waits while another live run holds it, reporting the holder through `waiting`, and gives up when `signal` aborts.
 */
export async function lockWorktree(worktree: string, owner: string, options: { readonly signal?: AbortSignal; readonly waiting?: (holder: string) => void; readonly pollMs?: number } = {}): Promise<() => Promise<void>> {
  const file = `${worktree}.lock`;
  await mkdir(dirname(file), { recursive: true });
  const mine: LockFile = { owner, pid: process.pid, at: Date.now() };
  for (;;) {
    if (options.signal?.aborted === true) throw new Error('Stopped.');
    try {
      await writeFile(file, JSON.stringify(mine), { flag: 'wx', mode: 0o600 });
      return async () => {
        const held = await readFile(file, 'utf8').catch(() => '');
        if (held === JSON.stringify(mine)) await rm(file, { force: true });
      };
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    const held = await readFile(file, 'utf8').then((text) => JSON.parse(text) as Partial<LockFile>, () => undefined);
    const modified = (await stat(file).catch(() => undefined))?.mtimeMs ?? 0;
    const holder = typeof held?.owner === 'string' ? held.owner : 'another run';
    if (held === undefined || (typeof held.pid === 'number' && !alive(held.pid)) || Date.now() - modified > staleLockMs) {
      await rm(file, { force: true });
      continue;
    }
    if (holder === owner && held.pid === process.pid) throw new Error(`${owner} already holds this worktree.`);
    options.waiting?.(holder);
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, options.pollMs ?? 1000);
      options.signal?.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
    });
  }
}

/** Whether no other Claude run holds the worktree's lock, so moving its files cannot disturb one; `mine` when this run holds it. */
export async function isWorktreeIdle(worktree: string, mine: boolean): Promise<boolean> {
  if (mine) return true;
  const held = await readFile(`${worktree}.lock`, 'utf8').then((text) => JSON.parse(text) as Partial<LockFile>, () => undefined);
  return held === undefined || (typeof held.pid === 'number' && !alive(held.pid));
}

/** A branch name for a linked repository without a PR, taken from this PR's head branch. */
export function linkedBranchName(headBranch: string): string {
  const safe = headBranch.replace(/[^\w./-]+/gu, '-').replace(/^[-./]+|\.lock$|\.+$/gu, '');
  return safe === '' ? 'pair-review/linked' : safe;
}

/** Folder of this PR's own worktree in another repository that has no PR for the change yet. */
export function linkedWorktreePath(storageRoot: string, repository: string, from: { readonly repository: string; readonly number: number }): string {
  return join(storageRoot, repository.replace('/', '__'), `for-${from.repository.replace('/', '__')}-${from.number}`);
}

/**
 * Create a worktree of `sourceRoot` on `branch` unless it exists, and return the branch it is on.
 * The branch starts from `origin/<branch>` when GitHub has it, else from the default branch. A branch checked out in another worktree,
 * such as the user's own checkout, cannot be checked out twice: for reading the worktree detaches at that branch's tip, for editing it fails.
 */
export async function ensureBranchWorktree(sourceRoot: string, folder: string, branch: string, purpose: 'read' | 'edit' = 'edit'): Promise<string> {
  if (await stat(folder).then(() => true, () => false)) return (await git(folder, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
  await mkdir(dirname(folder), { recursive: true, mode: 0o700 });
  await git(sourceRoot, ['fetch', '--quiet', 'origin']).catch(() => undefined);
  const has = (ref: string): Promise<boolean> => git(sourceRoot, ['rev-parse', '--verify', '--quiet', ref]).then(() => true, () => false);
  const remote = `refs/remotes/origin/${branch}`;
  const base = await has(remote) ? remote : (await git(sourceRoot, ['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD']).catch(() => 'HEAD')).trim() || 'HEAD';
  const local = await has(`refs/heads/${branch}`);
  const busy = local && (await git(sourceRoot, ['worktree', 'list', '--porcelain'])).split('\n').some((line) => line === `branch refs/heads/${branch}`);
  if (busy && purpose === 'read') {
    await git(sourceRoot, ['worktree', 'add', '--detach', folder, await has(remote) ? remote : `refs/heads/${branch}`]);
    return branch;
  }
  if (busy) throw new Error(`${branch} is checked out in another worktree of this repository, such as your own checkout. Switch that checkout to another branch, or link a PR for it, so Claude can work on it in its own worktree.`);
  await git(sourceRoot, local ? ['worktree', 'add', folder, branch] : ['worktree', 'add', '-b', branch, folder, base]);
  if (!local && base === remote) await git(folder, ['branch', '--quiet', '--set-upstream-to', `origin/${branch}`]).catch(() => undefined);
  return branch;
}
