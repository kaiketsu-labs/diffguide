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

/** The GitHub thread a local thread answers, so publishing replies inside it. */
export interface GitHubLink {
  readonly id: string;
  readonly url: string;
}

function linksPath(dataPath: string): string {
  return join(dataPath, 'github-links.json');
}

/** Local threads opened from a GitHub thread, by local thread id. */
export async function readGitHubLinks(dataPath: string): Promise<Map<string, GitHubLink>> {
  const value = await readPrivateJson(linksPath(dataPath)).catch(() => undefined);
  const threads = typeof value === 'object' && value !== null ? (value as { threads?: unknown }).threads : undefined;
  const found = new Map<string, GitHubLink>();
  if (typeof threads !== 'object' || threads === null) return found;
  for (const [id, entry] of Object.entries(threads)) {
    const record = typeof entry === 'object' && entry !== null ? entry as Partial<GitHubLink> : {};
    if (typeof record.id === 'string' && record.id !== '' && typeof record.url === 'string' && record.url.startsWith('https://')) {
      found.set(id, { id: record.id, url: record.url });
    }
  }
  return found;
}

export async function writeGitHubLinks(dataPath: string, links: ReadonlyMap<string, GitHubLink>): Promise<void> {
  await writePrivateJson(linksPath(dataPath), { threads: Object.fromEntries(links) });
}

/** The request Claude gets for a GitHub thread: the user's note, or a default for the intent, then the thread's comments quoted. */
export function githubFeedbackRequest(note: string, intent: 'ask' | 'implement', comments: readonly { readonly author: string; readonly body: string }[]): string {
  const request = note.trim() || (intent === 'implement' ? 'Address this feedback from GitHub.' : 'What do you think of this feedback from GitHub?');
  const quoted = comments.map(({ author, body }) => `> **@${author}:**\n${body.trim().split('\n').map((line) => `> ${line}`.trimEnd()).join('\n')}`);
  return `${request}\n\nGitHub thread:\n\n${quoted.join('\n>\n')}`;
}
