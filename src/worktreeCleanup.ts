import type { PullRequestProvider } from './pullRequests.js';
import { isWorktreeDisposable, listWorktrees, worktreeOpenedAt } from './worktrees.js';

/** What cleanup needs from one checkout. */
export interface CleanupTarget {
  readonly root: string;
  readonly storageRoot: string;
  readonly connect: () => Promise<PullRequestProvider>;
  /** Close the PR's session and remove its worktree. */
  readonly remove: (repository: string, number: number) => Promise<void>;
}

/** Outcome of one cleanup, as `#number` labels. */
export interface CleanupResult {
  readonly removed: readonly string[];
  /** Due for removal, but holding uncommitted changes or unpushed commits. */
  readonly kept: readonly string[];
}

/**
 * Remove PR worktrees whose PR was merged or closed, or that were not opened for `maxAgeDays` (0 turns age off).
 * A worktree with uncommitted changes or unpushed commits is never removed.
 */
export async function cleanUpWorktrees(target: CleanupTarget, maxAgeDays: number, now = Date.now()): Promise<CleanupResult> {
  const worktrees = await listWorktrees(target.storageRoot, target.root);
  if (worktrees.length === 0) return { removed: [], kept: [] };
  const provider = await target.connect();
  const removed: string[] = [];
  const kept: string[] = [];
  for (const { folder, metadata } of worktrees) {
    const { number } = metadata.pullRequest;
    const openedAt = await worktreeOpenedAt(folder);
    const stale = maxAgeDays > 0 && openedAt !== undefined && now - openedAt.getTime() > maxAgeDays * 86_400_000;
    const finished = stale || await provider.details(number).then((details) => details.merged || !details.open, () => false);
    if (!finished) continue;
    const label = `#${number}`;
    if (!await isWorktreeDisposable(folder)) {
      kept.push(label);
      continue;
    }
    await target.remove(metadata.repository, number);
    removed.push(label);
  }
  return { removed, kept };
}
