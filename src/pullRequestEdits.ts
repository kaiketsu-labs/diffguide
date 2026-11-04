import type { PullRequestDetails, PullRequestProvider, ReviewerSet } from './pullRequests.js';
import type { PickTarget } from './pullRequestOverview.js';

/** What the page's picker ended with: logins or label names in `values`, and team slugs in `teams` for reviewers. */
export interface PickedSelection { readonly values: readonly string[]; readonly teams: readonly string[] }

/** Save a picker's final selection on GitHub, writing only what changed. */
export async function saveSelection(provider: PullRequestProvider, number: number, details: PullRequestDetails, what: PickTarget, picked: PickedSelection): Promise<void> {
  if (!details.canEdit) throw new Error('You do not have permission to edit this pull request.');
  if (what === 'reviewers') {
    const before = details.reviewers.filter((reviewer) => reviewer.state === 'requested');
    const { add, remove } = reviewerChanges(
      { users: before.filter((reviewer) => reviewer.team === undefined).map((reviewer) => reviewer.name), teams: before.flatMap((reviewer) => reviewer.team ?? []) },
      { users: picked.values, teams: picked.teams },
    );
    if (add.users.length || add.teams.length) await provider.requestReviewers(number, add);
    if (remove.users.length || remove.teams.length) {
      try {
        await provider.removeReviewers(number, remove);
      } catch (error: unknown) {
        const detail = error instanceof Error ? error.message : String(error);
        throw new Error(`Could not withdraw reviewer requests. Earlier requests may already have been saved. Refresh before retrying. ${detail}`, { cause: error });
      }
    }
    return;
  }
  if (what === 'milestone') {
    const [chosen] = picked.values;
    const next = chosen === undefined ? null : Number(chosen);
    if (next === (details.milestone?.number ?? null)) return;
    await provider.editPullRequest(number, { milestone: next });
    return;
  }
  const current = what === 'labels' ? details.labels.map((label) => label.name) : details.assignees;
  if (sameSet(picked.values, current)) return;
  await provider.editPullRequest(number, what === 'labels' ? { labels: picked.values } : { assignees: picked.values });
}

/** Reviewers to request and requests to withdraw, going from `before` to `after`. */
export function reviewerChanges(before: ReviewerSet, after: ReviewerSet): { readonly add: ReviewerSet; readonly remove: ReviewerSet } {
  const minus = (a: readonly string[], b: readonly string[]): string[] => a.filter((item) => !b.includes(item));
  return {
    add: { users: minus(after.users, before.users), teams: minus(after.teams, before.teams) },
    remove: { users: minus(before.users, after.users), teams: minus(before.teams, after.teams) },
  };
}

function sameSet(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((item) => b.includes(item));
}
