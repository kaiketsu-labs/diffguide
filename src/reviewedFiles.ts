import { createHash } from 'node:crypto';
import { mkdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import * as vscode from 'vscode';
import { isWorkspaceRelativePath } from './git.js';
import { readPrivateJson, writePrivateJson } from './privateFiles.js';
import type { PullRequestProvider } from './pullRequests.js';
import { reviewDataPath, worktreePath } from './worktrees.js';

/** Hashes by file, reused while size, inode and change times match; any write changes the change time. */
const fingerprints = new Map<string, { readonly version: string; readonly hash: string }>();
const maxFingerprints = 10_000;

/** Content hash of a worktree file, so a mark lapses once the file changes. */
async function fingerprint(worktree: string, relativePath: string): Promise<string> {
  const file = join(worktree, relativePath);
  const info = await stat(file, { bigint: true }).catch(() => undefined);
  if (info === undefined) return 'deleted';
  const version = `${info.size}:${info.ino}:${info.mtimeNs}:${info.ctimeNs}`;
  const known = fingerprints.get(file);
  if (known?.version === version) return known.hash;
  const content = await readFile(file).catch(() => undefined);
  const hash = content === undefined ? 'deleted' : createHash('sha256').update(content).digest('hex').slice(0, 16);
  if (fingerprints.size >= maxFingerprints) fingerprints.clear();
  fingerprints.set(file, { version, hash });
  return hash;
}

function marksPath(worktree: string): string {
  return join(reviewDataPath(worktree), 'reviewed-files.json');
}

async function readMarks(worktree: string): Promise<Record<string, string>> {
  const value = await readPrivateJson(marksPath(worktree)).catch(() => undefined);
  const files = typeof value === 'object' && value !== null ? (value as { files?: unknown }).files : undefined;
  if (typeof files !== 'object' || files === null) return {};
  return Object.fromEntries(Object.entries(files).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
}

/** Paths among `paths` marked reviewed whose content is unchanged since. */
export async function readReviewedFiles(worktree: string, paths: readonly string[]): Promise<ReadonlySet<string>> {
  const marks = await readMarks(worktree);
  const current = await Promise.all(paths.map(async (path) => marks[path] !== undefined && marks[path] === await fingerprint(worktree, path)));
  return new Set(paths.filter((_path, index) => current[index]));
}

/** Mark a file reviewed at its current content, or clear the mark. */
export async function setFileReviewed(worktree: string, relativePath: string, reviewed: boolean): Promise<void> {
  if (!isWorkspaceRelativePath(relativePath)) throw new Error(`Unsupported file path: ${relativePath}`);
  const marks = await readMarks(worktree);
  if (reviewed) marks[relativePath] = await fingerprint(worktree, relativePath);
  else delete marks[relativePath];
  await mkdir(reviewDataPath(worktree), { recursive: true, mode: 0o700 });
  await writePrivateJson(marksPath(worktree), { files: marks });
}

/** Reviewed files per PR: local ticks merged with the code host's "Viewed" flags, which are cached until `forget`. */
export class FileReviews implements vscode.Disposable {
  readonly #changed = new vscode.EventEmitter<string>();
  /** Fires with `owner/name#number` of the PR whose files were ticked or unticked. */
  readonly onDidChange = this.#changed.event;
  readonly #viewed = new Map<string, Promise<Set<string>>>();

  constructor(private readonly storageRoot: string) {}

  /** Files among `paths` that are reviewed locally or marked Viewed on the code host. */
  async reviewed(provider: PullRequestProvider, repository: string, number: number, paths: readonly string[]): Promise<ReadonlySet<string>> {
    const [local, viewed] = await Promise.all([
      readReviewedFiles(worktreePath(this.storageRoot, repository, number), paths),
      this.#viewedOn(provider, repository, number).catch(() => new Set<string>()),
    ]);
    return new Set(paths.filter((path) => local.has(path) || viewed.has(path)));
  }

  /** Tick or untick a file here and on the code host. */
  async set(provider: PullRequestProvider, repository: string, number: number, path: string, reviewed: boolean): Promise<void> {
    await setFileReviewed(worktreePath(this.storageRoot, repository, number), path, reviewed);
    const viewed = await this.#viewedOn(provider, repository, number).catch(() => undefined);
    if (reviewed) viewed?.add(path);
    else viewed?.delete(path);
    this.#changed.fire(`${repository}#${number}`);
    await provider.setViewed(number, path, reviewed);
  }

  /** Read the code host's Viewed flags again next time. */
  forget(): void {
    this.#viewed.clear();
  }

  dispose(): void {
    this.#changed.dispose();
  }

  #viewedOn(provider: PullRequestProvider, repository: string, number: number): Promise<Set<string>> {
    const key = `${repository}#${number}`;
    let viewed = this.#viewed.get(key);
    if (viewed === undefined) {
      viewed = provider.viewedFiles(number).then((files) => new Set(files));
      viewed.catch(() => { this.#viewed.delete(key); });
      this.#viewed.set(key, viewed);
    }
    return viewed;
  }
}
