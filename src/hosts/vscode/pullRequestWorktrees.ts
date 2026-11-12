import * as vscode from 'vscode';
import { agentStatus, backgroundStatus } from '../../core/agent.js';
import { type LocalChange, localChanges } from '../../core/conflicts.js';
import type { ChangeRequestSummary, Forge } from '../../core/forge.js';
import { cleanUpWorktrees } from '../../core/git/worktreeCleanup.js';
import { ensureWorktree, hasWorktree, type PullRequestRole, removeWorktree, worktreePath } from '../../core/git/worktrees.js';
import { GitHubApiProvider } from '../../forges/github/provider.js';
import type { Checkout, Checkouts } from './checkouts.js';
import { showClaude } from './claudeStatus.js';
import type { ShowOverview } from './pullRequestPage.js';

/** Worktree operations the sidebar triggers, kept separate so the tree stays testable. */
export interface PullRequestWorktrees {
  exists(repository: string, number: number): Promise<boolean>;
  /** Ensure the PR's worktree and open its review page. */
  open(provider: Forge, repository: string, pullRequest: ChangeRequestSummary, role: PullRequestRole): Promise<void>;
  remove(repository: string, number: number): Promise<void>;
  /** Show what the PR's Claude did, and send skipped comments again. */
  showClaude(provider: Forge, repository: string, pullRequest: ChangeRequestSummary, role: PullRequestRole): Promise<void>;
  /** Claude's state for a PR with an open review, shown beside it. */
  claudeStatus(repository: string, number: number): string | undefined;
  /** Whether Claude answers comments, builds the guide or reviews for a PR with an open review. */
  working(repository: string, number: number): boolean;
  /** Files of a checked-out PR ticked Viewed and unchanged since, or marked Viewed on the code host. */
  reviewedFiles(provider: Forge, repository: string, number: number, paths: readonly string[]): Promise<ReadonlySet<string>>;
  /** Open a tab with the PR's review progress, threads and Claude activity. */
  showOverview(provider: Forge, repository: string, pullRequest: ChangeRequestSummary, role: PullRequestRole): Promise<void>;
  /** What a checked-out PR's worktree has that GitHub does not: commits ahead of `pushedHead`, and each changed file. */
  localChanges(repository: string, number: number, pushedHead: string | undefined): Promise<{ readonly commits: number; readonly files: ReadonlyMap<string, LocalChange> }>;
  /** Drop cached code host state so the next read is fresh. */
  forget(): void;
}

/** The PR worktrees of one checkout, as the PR list uses them. */
export function worktreesOf(checkouts: Checkouts, checkout: Checkout, showOverview: ShowOverview): PullRequestWorktrees {
  const { root: checkoutRoot, storageRoot, sessions, fileReviews } = checkout;
  return {
    exists: (repository, number) => hasWorktree(storageRoot, repository, number),
    open: (provider, repository, pullRequest, role) => showOverview(checkout, provider, repository, pullRequest, role),
    showClaude: async (provider, repository, pullRequest, role) => {
      await ensureWorktree(checkoutRoot, storageRoot, provider, repository, pullRequest, role);
      showClaude(await sessions.open(repository, pullRequest.number));
    },
    remove: async (repository, number) => {
      await sessions.close(repository, number);
      await removeWorktree(checkoutRoot, storageRoot, repository, number);
    },
    claudeStatus: (repository, number) => {
      const opened = sessions.get(repository, number);
      if (opened === undefined) return undefined;
      const claude = agentStatus(opened.runner.activity).text;
      const background = backgroundStatus(opened.analysis.activity.running, opened.review.activity.running);
      return background === undefined ? claude : [claude === 'Claude idle' ? undefined : claude, background].filter(Boolean).join(' · ');
    },
    working: (repository, number) => {
      const opened = sessions.get(repository, number);
      return opened !== undefined && (opened.runner.activity.running || opened.analysis.activity.running || opened.review.activity.running);
    },
    localChanges: (repository, number, pushedHead) => localChanges(worktreePath(storageRoot, repository, number), pushedHead),
    reviewedFiles: (provider, repository, number, paths) => fileReviews.reviewed(provider, repository, number, paths),
    forget: () => { fileReviews.forget(); GitHubApiProvider.forget(); checkouts.rescan(); },
    showOverview: (provider, repository, pullRequest, role) => showOverview(checkout, provider, repository, pullRequest, role),
  };
}

/** Remove the worktrees of merged, closed or unused PRs; `manual` also reports when nothing was removed. */
export async function cleanUpPullRequestWorktrees(checkouts: Checkouts, showOverview: ShowOverview, manual: boolean): Promise<void> {
  const days = vscode.workspace.getConfiguration('diffGuide').get<number>('worktreeCleanupDays', 14);
  const results = await Promise.all((await checkouts.list()).map((checkout) => cleanUpWorktrees({
    root: checkout.root, storageRoot: checkout.storageRoot, connect: checkout.connect, remove: worktreesOf(checkouts, checkout, showOverview).remove,
  }, days)));
  const removed = results.flatMap((result) => result.removed);
  const kept = results.flatMap((result) => result.kept);
  if (removed.length > 0) {
    void vscode.window.showInformationMessage(`Removed worktrees of merged, closed or unused PRs: ${removed.join(', ')}`);
    void vscode.commands.executeCommand('diffGuide.refreshPullRequests');
  }
  if (!manual) return;
  if (kept.length > 0) void vscode.window.showInformationMessage(`Kept ${kept.join(', ')}: uncommitted changes or unpushed commits.`);
  else if (removed.length === 0) void vscode.window.showInformationMessage('No PR worktrees to clean up.');
}
