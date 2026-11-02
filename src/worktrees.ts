import { execFile } from 'node:child_process';
import { mkdir, readdir, rm, stat } from 'node:fs/promises';
import { dirname, join, relative, isAbsolute } from 'node:path';
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

/** Keep PR worktrees inside the repository's Git folder, so folder-based shell setup such as Claude accounts applies to them. */
export async function repositoryStorage(sourceRoot: string): Promise<string | undefined> {
  const common = (await git(sourceRoot, ['rev-parse', '--path-format=absolute', '--git-common-dir']).catch(() => undefined))?.trim();
  return common === undefined || common === '' ? undefined : join(common, 'local-review');
}

/** Folder that holds the worktree for one PR. */
export function worktreePath(storageRoot: string, repository: string, number: number): string {
  return join(storageRoot, 'worktrees', repository.replace('/', '__'), `pr-${number}`);
}

/** Metadata file kept outside the checkout so it never shows up as a change. */
function metadataPath(worktree: string): string {
  return `${worktree}.json`;
}

/** Folder for the PR's local comments and Claude connection, beside its worktree. */
export function reviewDataPath(worktree: string): string {
  return `${worktree}.review`;
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
  if (await readWorktree(storageRoot, folder) !== undefined) return folder;
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

/** List PR worktrees created from one checkout. */
export async function listWorktrees(storageRoot: string, sourceRoot: string): Promise<readonly { folder: string; metadata: PullRequestWorktree }[]> {
  const root = join(storageRoot, 'worktrees');
  const repositories = await readdir(root).catch(() => [] as string[]);
  const found: { folder: string; metadata: PullRequestWorktree }[] = [];
  for (const repository of repositories) {
    const entries = await readdir(join(root, repository)).catch(() => [] as string[]);
    for (const entry of entries.filter((name) => /^pr-\d+\.json$/u.test(name))) {
      const folder = join(root, repository, entry.slice(0, -'.json'.length));
      const metadata = await readWorktree(storageRoot, folder);
      if (metadata?.sourceRoot === sourceRoot) found.push({ folder, metadata });
    }
  }
  return found;
}

/** Read PR metadata for a folder inside worktree storage, or undefined for any other folder. */
export async function readWorktree(storageRoot: string, folder: string): Promise<PullRequestWorktree | undefined> {
  const inside = relative(join(storageRoot, 'worktrees'), folder);
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
