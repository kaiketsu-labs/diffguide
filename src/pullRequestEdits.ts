import * as vscode from 'vscode';
import type { PickerOptions, PullRequestDetails, PullRequestProvider, ReviewerSet } from './pullRequests.js';
import type { PickTarget } from './pullRequestOverview.js';

interface Choice extends vscode.QuickPickItem { readonly value: string; readonly team: boolean }

const titles: Record<PickTarget, string> = { reviewers: 'Request reviewers', assignees: 'Assignees', labels: 'Labels' };
const reviewStates: Record<PullRequestDetails['reviewers'][number]['state'], string> = {
  requested: 'Review requested', approved: 'Approved', changes: 'Requested changes', commented: 'Commented', dismissed: 'Dismissed',
};

/** Pick reviewers, assignees or labels in VS Code, then save what changed on GitHub. */
export async function pickAndSave(provider: PullRequestProvider, number: number, details: PullRequestDetails, what: PickTarget): Promise<void> {
  if (!details.canEdit) throw new Error('You do not have permission to edit this pull request.');
  const choices = provider.pickerOptions().then((options) => choicesFor(what, options, details));
  const picked = await vscode.window.showQuickPick(choices, { canPickMany: true, title: titles[what], matchOnDescription: true });
  if (picked === undefined) return;
  if (what === 'reviewers') {
    const before = details.reviewers.filter((reviewer) => reviewer.state === 'requested');
    const { add, remove } = reviewerChanges(
      { users: before.filter((reviewer) => reviewer.team === undefined).map((reviewer) => reviewer.name), teams: before.flatMap((reviewer) => reviewer.team ?? []) },
      { users: picked.filter((choice) => !choice.team).map((choice) => choice.value), teams: picked.filter((choice) => choice.team).map((choice) => choice.value) },
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
  const values = picked.map((choice) => choice.value);
  const current = what === 'labels' ? details.labels.map((label) => label.name) : details.assignees;
  if (sameSet(values, current)) return;
  await provider.editPullRequest(number, what === 'labels' ? { labels: values } : { assignees: values });
}

/** Reviewers to request and requests to withdraw, going from `before` to `after`. */
export function reviewerChanges(before: ReviewerSet, after: ReviewerSet): { readonly add: ReviewerSet; readonly remove: ReviewerSet } {
  const minus = (a: readonly string[], b: readonly string[]): string[] => a.filter((item) => !b.includes(item));
  return {
    add: { users: minus(after.users, before.users), teams: minus(after.teams, before.teams) },
    remove: { users: minus(before.users, after.users), teams: minus(before.teams, after.teams) },
  };
}

function choicesFor(what: PickTarget, options: PickerOptions, details: PullRequestDetails): Choice[] {
  if (what === 'labels') {
    const names = [...new Set([...options.labels.map((label) => label.name), ...details.labels.map((label) => label.name)])];
    return names.map((name) => ({ label: name, value: name, team: false, picked: details.labels.some((label) => label.name === name) }));
  }
  if (what === 'assignees') {
    return [...new Set([...details.assignees, ...options.users])].map((login) => ({ label: login, value: login, team: false, picked: details.assignees.includes(login) }));
  }
  const reviewer = (name: string) => details.reviewers.find((entry) => entry.team === undefined && entry.name === name);
  const users = [...new Set([...details.reviewers.filter((entry) => entry.team === undefined).map((entry) => entry.name), ...options.users])].map((login): Choice => {
    const state = reviewer(login)?.state;
    return { label: login, value: login, team: false, picked: state === 'requested', ...(state === undefined || state === 'requested' ? {} : { description: reviewStates[state] }) };
  });
  const requestedTeams = details.reviewers.flatMap((entry) => entry.team === undefined ? [] : [{ name: entry.name, slug: entry.team }]);
  const teams = [...requestedTeams, ...options.teams.filter((team) => !requestedTeams.some((entry) => entry.slug === team.slug))].map((team): Choice => ({
    label: team.name, value: team.slug, team: true, description: 'Team', picked: requestedTeams.some((entry) => entry.slug === team.slug),
  }));
  return [...users, ...teams];
}

function sameSet(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((item) => b.includes(item));
}
