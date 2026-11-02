import { join } from 'node:path';
import type { CodeAnchor } from './contracts.js';
import { readPrivateJson, writePrivateJson } from './privateFiles.js';
import type { PullRequestComment } from './pullRequests.js';
import { git } from './worktrees.js';

/** A local thread that was posted to the code host. */
export interface Publication {
  readonly url: string;
  readonly pending: boolean;
}

/** Where a thread lands on the code host, minus the text. */
export type CommentPlacement = Omit<PullRequestComment, 'body'>;

/** Place a thread on the PR diff: on its lines when the diff shows them, else on the whole file. */
export async function placeComment(worktree: string, base: string, anchor: CodeAnchor): Promise<CommentPlacement> {
  const side = anchor.side === 'original' ? 'LEFT' : 'RIGHT';
  if (side === 'RIGHT' && (await git(worktree, ['status', '--porcelain', '--', anchor.path])).trim() !== '') {
    throw new Error(`${anchor.path} has uncommitted changes, so its lines may not match GitHub. Commit and push them first.`);
  }
  const commitId = (await git(worktree, ['rev-parse', 'HEAD'])).trim();
  const diff = await git(worktree, ['diff', '--unified=3', '--no-color', base, commitId, '--', anchor.path]);
  const shown = diffRanges(diff, side).some((range) => range.start <= anchor.startLine && anchor.endLine <= range.end);
  return {
    path: anchor.path, commitId, side,
    ...(shown ? { lines: { start: anchor.startLine, end: anchor.endLine } } : {}),
  };
}

/** Line ranges of one side that a unified diff shows, hunk by hunk. */
export function diffRanges(diff: string, side: 'LEFT' | 'RIGHT'): readonly { start: number; end: number }[] {
  const ranges: { start: number; end: number }[] = [];
  for (const match of diff.matchAll(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/gmu)) {
    const start = Number(side === 'LEFT' ? match[1] : match[3]);
    const count = Number((side === 'LEFT' ? match[2] : match[4]) ?? 1);
    if (count > 0) ranges.push({ start, end: start + count - 1 });
  }
  return ranges;
}

function publicationsPath(dataPath: string): string {
  return join(dataPath, 'published-threads.json');
}

/** Threads of a PR already posted to the code host. */
export async function readPublications(dataPath: string): Promise<Map<string, Publication>> {
  const value = await readPrivateJson(publicationsPath(dataPath)).catch(() => undefined);
  const threads = typeof value === 'object' && value !== null ? (value as { threads?: unknown }).threads : undefined;
  const found = new Map<string, Publication>();
  if (typeof threads !== 'object' || threads === null) return found;
  for (const [id, entry] of Object.entries(threads)) {
    const record = typeof entry === 'object' && entry !== null ? entry as Partial<Publication> : {};
    if (typeof record.url === 'string' && record.url.startsWith('https://') && typeof record.pending === 'boolean') {
      found.set(id, { url: record.url, pending: record.pending });
    }
  }
  return found;
}

export async function writePublications(dataPath: string, publications: ReadonlyMap<string, Publication>): Promise<void> {
  await writePrivateJson(publicationsPath(dataPath), { threads: Object.fromEntries(publications) });
}
