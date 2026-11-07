import { watch } from 'node:fs';
import { readFile, stat, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { isWorkspaceRelativePath, readGitBase } from './git.js';
import type { PullRequestSummary } from './pullRequests.js';
import { readPullRequestBase, readWorktree, worktreePath } from './worktrees.js';

const scheme = 'diffguide-pr';

/** Recently read files at a fixed commit; their content can never change. */
const baseContents = new Map<string, Promise<string>>();
const maxBaseContents = 64;

/** A file's content at a commit, read once for the diff editor's size check, its read and the open check. */
export function readBaseContent(folder: string, relativePath: string, revision: string): Promise<string> {
  const key = `${folder}\0${revision}\0${relativePath}`;
  let content = baseContents.get(key);
  if (content === undefined) {
    content = readGitBase(folder, relativePath, revision);
    content.catch(() => { baseContents.delete(key); });
  } else {
    baseContents.delete(key);
  }
  baseContents.set(key, content);
  const oldest = baseContents.keys().next().value;
  if (baseContents.size > maxBaseContents && oldest !== undefined) baseContents.delete(oldest);
  return content;
}

/** File in a PR worktree: the working copy, or its content at `revision` when given. */
interface PullRequestFileAddress {
  readonly repository: string;
  readonly number: number;
  readonly relativePath: string;
  readonly revision?: string;
}

/** Short address for a PR file, so diff headers show `pr-<n>/<path>` instead of the storage location. */
export function pullRequestFileUri(address: PullRequestFileAddress): vscode.Uri {
  const query = new URLSearchParams({ repo: address.repository, ...(address.revision === undefined ? {} : { rev: address.revision }) });
  return vscode.Uri.from({ scheme, authority: `pr-${address.number}`, path: `/${address.relativePath}`, query: query.toString() });
}

/** Decode a PR file address, rejecting paths that leave the worktree and revisions that can move. */
export function parsePullRequestFileUri(uri: vscode.Uri): PullRequestFileAddress | undefined {
  const number = Number(/^pr-(\d+)$/u.exec(uri.authority)?.[1]);
  const query = new URLSearchParams(uri.query);
  const repository = query.get('repo');
  const revision = query.get('rev');
  const relativePath = uri.path.replace(/^\//u, '');
  if (uri.scheme !== scheme || !Number.isSafeInteger(number) || number <= 0 || repository === null
    || !/^[\w.-]+\/[\w.-]+$/u.test(repository) || !isWorkspaceRelativePath(relativePath)
    || (revision !== null && !/^[a-f\d]{40,64}$/u.test(revision))) {
    return undefined;
  }
  return { repository, number, relativePath, ...(revision === null ? {} : { revision }) };
}

/** Serve PR files from their worktrees: base revisions read-only, working copies read and written on disk. */
class PullRequestFileSystem implements vscode.FileSystemProvider {
  readonly #changed = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
  readonly onDidChangeFile = this.#changed.event;

  /** `storageRoot` finds where the repository that holds a PR keeps its worktrees. */
  constructor(private readonly storageRoot: (repository: string, number: number) => Promise<string | undefined>) {}

  watch(uri: vscode.Uri): vscode.Disposable {
    const address = parsePullRequestFileUri(uri);
    if (address === undefined || address.revision !== undefined) return new vscode.Disposable(() => undefined);
    let watcher: ReturnType<typeof watch> | undefined;
    let disposed = false;
    void this.storageRoot(address.repository, address.number).then((root) => {
      if (disposed || root === undefined) return;
      const file = path.join(worktreePath(root, address.repository, address.number), address.relativePath);
      watcher = watch(file, () => { this.#changed.fire([{ type: vscode.FileChangeType.Changed, uri }]); });
    }).catch(() => undefined);
    return new vscode.Disposable(() => { disposed = true; watcher?.close(); });
  }

  async stat(uri: vscode.Uri): Promise<vscode.FileStat> {
    const target = await this.#resolve(uri);
    if (target.revision !== undefined) {
      const size = Buffer.byteLength(await readBaseContent(target.folder, target.relativePath, target.revision));
      return { type: vscode.FileType.File, ctime: 0, mtime: 0, size, permissions: vscode.FilePermission.Readonly };
    }
    const info = await stat(target.file).catch(() => { throw vscode.FileSystemError.FileNotFound(uri); });
    return { type: vscode.FileType.File, ctime: info.ctimeMs, mtime: info.mtimeMs, size: info.size };
  }

  async readFile(uri: vscode.Uri): Promise<Uint8Array> {
    const target = await this.#resolve(uri);
    if (target.revision !== undefined) return Buffer.from(await readBaseContent(target.folder, target.relativePath, target.revision));
    return await readFile(target.file).catch(() => { throw vscode.FileSystemError.FileNotFound(uri); });
  }

  async writeFile(uri: vscode.Uri, content: Uint8Array): Promise<void> {
    const target = await this.#resolve(uri);
    if (target.revision !== undefined) throw vscode.FileSystemError.NoPermissions(uri);
    await writeFile(target.file, content);
    this.#changed.fire([{ type: vscode.FileChangeType.Changed, uri }]);
  }

  readDirectory(): never { throw vscode.FileSystemError.NoPermissions(); }
  createDirectory(): never { throw vscode.FileSystemError.NoPermissions(); }
  delete(): never { throw vscode.FileSystemError.NoPermissions(); }
  rename(): never { throw vscode.FileSystemError.NoPermissions(); }

  /** Map an address to its worktree, refusing PRs without one. */
  async #resolve(uri: vscode.Uri): Promise<{ folder: string; file: string; relativePath: string; revision?: string }> {
    const address = parsePullRequestFileUri(uri);
    if (address === undefined) throw vscode.FileSystemError.FileNotFound(uri);
    const root = await this.storageRoot(address.repository, address.number);
    if (root === undefined) throw vscode.FileSystemError.Unavailable(uri);
    const folder = worktreePath(root, address.repository, address.number);
    if (await readWorktree(root, folder) === undefined) throw vscode.FileSystemError.Unavailable(uri);
    return { folder, file: path.join(folder, address.relativePath), ...address };
  }
}

/** Register the file system that backs PR diffs. */
export function registerPullRequestDiffs(storageRoot: (repository: string, number: number) => Promise<string | undefined>): vscode.Disposable {
  return vscode.workspace.registerFileSystemProvider(scheme, new PullRequestFileSystem(storageRoot), { isCaseSensitive: true });
}

async function fileSides(folder: string, repository: string, number: number, relativePath: string, base: string) {
  const exists = await stat(path.join(folder, relativePath)).then(() => true, () => false);
  const atBase = await readBaseContent(folder, relativePath, base) !== '' || !exists;
  return {
    originalUri: atBase ? pullRequestFileUri({ repository, number, relativePath, revision: base }) : undefined,
    modifiedUri: exists ? pullRequestFileUri({ repository, number, relativePath }) : undefined,
  };
}

async function readBase(folder: string, pullRequest: PullRequestSummary): Promise<string> {
  const base = await readPullRequestBase(folder, pullRequest.baseBranch);
  if (base === undefined) throw new Error(`Could not find where #${pullRequest.number} branched off ${pullRequest.baseBranch}.`);
  return base;
}

/** Open one PR file in VS Code's own diff editor, or as a plain file when it was added or deleted. */
export async function openPullRequestFile(storageRoot: string, repository: string, pullRequest: PullRequestSummary, relativePath: string): Promise<void> {
  const folder = worktreePath(storageRoot, repository, pullRequest.number);
  const { originalUri, modifiedUri } = await fileSides(folder, repository, pullRequest.number, relativePath, await readBase(folder, pullRequest));
  if (originalUri !== undefined && modifiedUri !== undefined) {
    await vscode.commands.executeCommand('vscode.diff', originalUri, modifiedUri, `${relativePath} (#${pullRequest.number})`);
  } else {
    await vscode.commands.executeCommand('vscode.open', modifiedUri ?? originalUri);
  }
}
