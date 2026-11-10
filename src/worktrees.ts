import { execFile } from 'node:child_process';
import { appendFile, mkdir, readdir, readFile, rename, rm, stat, utimes } from 'node:fs/promises';
import { basename, dirname, join, relative, isAbsolute } from 'node:path';
import { readPrivateJson, writePrivateJson } from './privateFiles.js';
import type { PullRequestProvider, PullRequestSummary } from './pullRequests.js';

/** Whether the user wrote the PR (Claude may implement) or reviews someone else's (Claude only suggests). */
export type PullRequestRole = 'author' | 'reviewer';

/** PR checked out into its own worktree, stored beside that worktree. */
export interface PullRequestWorktree {
  readonly version: 1;
  readonly repository: string;
  readonly role: PullRequestRole;
  readonly pullRequest: PullRequestSummary;
  /** Checkout the worktree was created from; only that window restores its review session. */
  readonly sourceRoot?: string;
}

const baseRemote = 'origin';

/** Run Git without a shell and surface its error output on failure. */
export function git(cwd: string, args: readonly string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('git', ['-C', cwd, ...args], { encoding: 'utf8', timeout: 120_000, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error === null) resolve(stdout);
      else reject(new Error(`git ${args[0] ?? ''} failed: ${stderr.trim().slice(0, 400) || error.message}`));
    });
  });
}

/** Reject repository names and branches that could escape storage or be read as Git options. */
function checkNames(repository: string, branch: string): void {
  if (!/^[\w.-]+\/[\w.-]+$/u.test(repository) || repository.split('/').some((part) => part === '.' || part === '..')) {
    throw new Error(`Unsupported repository name: ${repository}`);
  }
  if (!/^[\w./-]+$/u.test(branch) || branch.startsWith('-') || branch.includes('..')) {
    throw new Error(`Unsupported base branch name: ${branch}`);
  }
}

/** The repository's shared Git folder, which every checkout of it uses. */
async function gitCommonDir(sourceRoot: string): Promise<string | undefined> {
  const common = (await git(sourceRoot, ['rev-parse', '--path-format=absolute', '--git-common-dir']).catch(() => undefined))?.trim();
  return common === undefined || common === '' ? undefined : common;
}

/**
 * Keep PR worktrees where Claude Code keeps its own, under the main checkout's `.claude/worktrees`:
 * Claude may edit there, unlike under `.git`, and folder-based setup such as Claude accounts and parent `CLAUDE.md` files still applies.
 */
export async function repositoryStorage(sourceRoot: string): Promise<string | undefined> {
  const common = await gitCommonDir(sourceRoot);
  if (common === undefined) return undefined;
  const mainRoot = basename(common) === '.git' ? dirname(common) : (await git(sourceRoot, ['rev-parse', '--show-toplevel'])).trim();
  return join(mainRoot, '.claude', 'worktrees', 'diffguide');
}

/** Where PR worktrees lived earlier: in the Git folder, then in Pair Review's folder beside `storageRoot`. */
async function legacyStorage(sourceRoot: string, storageRoot: string): Promise<readonly string[]> {
  const common = await gitCommonDir(sourceRoot);
  return [...common === undefined ? [] : [join(common, 'pair-review', 'worktrees')], join(dirname(storageRoot), 'pair-review')];
}

/** Hide worktree storage from Git through the repository's local exclude file, so no `.gitignore` changes are needed. */
export async function excludeFromGit(sourceRoot: string): Promise<void> {
  const common = await gitCommonDir(sourceRoot);
  if (common === undefined) return;
  const pattern = '/.claude/worktrees/diffguide/';
  const file = join(common, 'info', 'exclude');
  const current = await readFile(file, 'utf8').catch(() => '');
  if (current.split('\n').some((line) => line.trim() === pattern)) return;
  await mkdir(dirname(file), { recursive: true });
  await appendFile(file, `${current === '' || current.endsWith('\n') ? '' : '\n'}${pattern}\n`);
}

/** Folder that holds the worktree for one PR. */
export function worktreePath(storageRoot: string, repository: string, number: number): string {
  return join(storageRoot, repository.replace('/', '__'), `pr-${number}`);
}

/** Metadata file kept outside the checkout so it never shows up as a change. */
function metadataPath(worktree: string): string {
  return `${worktree}.json`;
}

/** Folder for the PR's local comments and Claude connection, beside its worktree. */
export function reviewDataPath(worktree: string): string {
  return `${worktree}.review`;
}

/** Create a worktree's review data folder, retrying briefly when the file system reports a transient error. */
export async function createReviewData(
  worktree: string, create?: (folder: string) => Promise<void>, attempts?: number, delayMs?: number,
): Promise<string> {
  return await createDataFolder(reviewDataPath(worktree), create, attempts, delayMs);
}

/** Create a private review data folder, retrying briefly when the file system reports a transient error. */
export async function createDataFolder(
  folder: string, create = async (path: string): Promise<void> => { await mkdir(path, { recursive: true, mode: 0o700 }); }, attempts = 5, delayMs = 200,
): Promise<string> {
  for (let attempt = 1; ; attempt++) {
    try {
      await create(folder);
      return folder;
    } catch (error: unknown) {
      const code = (error as NodeJS.ErrnoException).code;
      if ((code !== 'EIO' && code !== 'EBUSY') || attempt >= attempts) {
        throw new Error(`Could not create ${folder} (${code ?? String(error)}). If iCloud or another sync service manages this folder, wait for it to finish or move VS Code's storage out of it, then try again.`, { cause: error });
      }
      await new Promise((resolve) => setTimeout(resolve, delayMs * attempt));
    }
  }
}

/** Check whether a PR already has a worktree. */
export async function hasWorktree(storageRoot: string, repository: string, number: number): Promise<boolean> {
  return await readWorktree(storageRoot, worktreePath(storageRoot, repository, number)) !== undefined;
}

/** Create the PR's worktree unless it exists, and return its folder. */
export async function ensureWorktree(
  sourceRoot: string, storageRoot: string, provider: PullRequestProvider,
  repository: string, pullRequest: PullRequestSummary, role: PullRequestRole,
): Promise<string> {
  checkNames(repository, pullRequest.baseBranch);
  const folder = worktreePath(storageRoot, repository, pullRequest.number);
  if (await readWorktree(storageRoot, folder) !== undefined) {
    await touchWorktree(folder);
    return folder;
  }
  await excludeFromGit(sourceRoot);
  await mkdir(dirname(folder), { recursive: true, mode: 0o700 });
  await git(sourceRoot, ['worktree', 'add', '--detach', folder]);
  try {
    await provider.checkout(pullRequest.number, folder);
    await git(folder, ['fetch', '--quiet', baseRemote, pullRequest.baseBranch]);
  } catch (error: unknown) {
    await git(sourceRoot, ['worktree', 'remove', '--force', folder]).catch(() => undefined);
    throw error;
  }
  const metadata: PullRequestWorktree = { version: 1, repository, role, pullRequest, sourceRoot };
  await writePrivateJson(metadataPath(folder), metadata);
  return folder;
}

/** Remove a PR worktree and its local comments; Git refuses while it has uncommitted changes. */
export async function removeWorktree(sourceRoot: string, storageRoot: string, repository: string, number: number): Promise<void> {
  const folder = worktreePath(storageRoot, repository, number);
  const exists = await stat(folder).then(() => true, () => false);
  if (exists) await git(sourceRoot, ['worktree', 'remove', folder]);
  await rm(metadataPath(folder), { force: true });
  await rm(reviewDataPath(folder), { recursive: true, force: true });
}

/** PR worktrees in one storage folder, from every checkout. */
async function storedWorktrees(storageRoot: string): Promise<readonly { folder: string; metadata: PullRequestWorktree }[]> {
  const repositories = await readdir(storageRoot).catch(() => [] as string[]);
  const found: { folder: string; metadata: PullRequestWorktree }[] = [];
  for (const repository of repositories) {
    const entries = await readdir(join(storageRoot, repository)).catch(() => [] as string[]);
    for (const entry of entries.filter((name) => /^pr-\d+\.json$/u.test(name))) {
      const folder = join(storageRoot, repository, entry.slice(0, -'.json'.length));
      const metadata = await readWorktree(storageRoot, folder);
      if (metadata !== undefined) found.push({ folder, metadata });
    }
  }
  return found;
}

/** List PR worktrees created from one checkout. */
export async function listWorktrees(storageRoot: string, sourceRoot: string): Promise<readonly { folder: string; metadata: PullRequestWorktree }[]> {
  return (await storedWorktrees(storageRoot)).filter(({ metadata }) => metadata.sourceRoot === sourceRoot);
}

/**
 * Move PR worktrees from earlier storage folders to `storageRoot`, with their comments and review marks.
 * Uncommitted changes move along. Claude starts a new conversation afterwards, since its saved one belongs to the old folder.
 * Returns the worktrees Git refused to move, which stay where they were.
 */
export async function migrateWorktrees(sourceRoot: string, storageRoot: string): Promise<readonly string[]> {
  const failed: string[] = [];
  for (const legacy of await legacyStorage(sourceRoot, storageRoot)) {
    const found = await storedWorktrees(legacy);
    if (found.length === 0) continue;
    await excludeFromGit(sourceRoot);
    for (const { folder } of found) {
      const target = join(storageRoot, relative(legacy, folder));
      try {
        await moveWorktree(sourceRoot, folder, target);
      } catch {
        failed.push(folder);
      }
    }
  }
  return failed;
}

async function moveWorktree(sourceRoot: string, folder: string, target: string): Promise<void> {
  if (await stat(target).then(() => true, () => false)) throw new Error(`${target} already exists`);
  await mkdir(dirname(target), { recursive: true, mode: 0o700 });
  await git(sourceRoot, ['worktree', 'move', folder, target]);
  await rename(metadataPath(folder), metadataPath(target));
  const data = reviewDataPath(folder);
  if (!await stat(data).then(() => true, () => false)) return;
  await rename(data, reviewDataPath(target));
  await rm(join(reviewDataPath(target), 'claude-session.json'), { force: true });
  const storeFile = join(reviewDataPath(target), 'review.json');
  const store = await readFile(storeFile, 'utf8').then((text) => JSON.parse(text) as unknown, () => undefined);
  if (typeof store === 'object' && store !== null) await writePrivateJson(storeFile, { ...store, workspaceRoot: target });
}

/** Record that a PR worktree was opened, so cleanup measures its age from now. */
async function touchWorktree(folder: string): Promise<void> {
  const now = new Date();
  await utimes(metadataPath(folder), now, now).catch(() => undefined);
}

/** When a PR worktree was last opened. */
export async function worktreeOpenedAt(folder: string): Promise<Date | undefined> {
  return (await stat(metadataPath(folder)).catch(() => undefined))?.mtime;
}

/** Whether removing a worktree loses nothing: no uncommitted or untracked files, and no commits missing from every remote. */
export async function isWorktreeDisposable(folder: string): Promise<boolean> {
  const [status, unpushed] = await Promise.all([
    git(folder, ['status', '--porcelain']).catch(() => undefined),
    git(folder, ['log', '--oneline', 'HEAD', '--not', '--remotes']).catch(() => undefined),
  ]);
  return status?.trim() === '' && unpushed?.trim() === '';
}

/** Read PR metadata for a folder inside worktree storage, or undefined for any other folder. */
export async function readWorktree(storageRoot: string, folder: string): Promise<PullRequestWorktree | undefined> {
  const inside = relative(storageRoot, folder);
  if (inside.startsWith('..') || isAbsolute(inside)) return undefined;
  const value = await readPrivateJson(metadataPath(folder)).catch(() => undefined);
  if (typeof value !== 'object' || value === null) return undefined;
  const record = value as Partial<PullRequestWorktree>;
  const pr = record.pullRequest;
  if (record.version !== 1 || typeof record.repository !== 'string' || (record.role !== 'author' && record.role !== 'reviewer')
    || typeof pr !== 'object' || pr === null || !Number.isSafeInteger(pr.number) || typeof pr.baseBranch !== 'string') {
    return undefined;
  }
  try {
    checkNames(record.repository, pr.baseBranch);
  } catch {
    return undefined;
  }
  return record as PullRequestWorktree;
}

/** Commit where the PR branched off its target, so the review shows exactly the PR's changes. */
export async function readPullRequestBase(worktree: string, baseBranch: string): Promise<string | undefined> {
  const revision = (await git(worktree, ['merge-base', 'HEAD', `${baseRemote}/${baseBranch}`]).catch(() => undefined))?.trim();
  return revision !== undefined && /^[a-f\d]{40,64}$/u.test(revision) ? revision : undefined;
}
