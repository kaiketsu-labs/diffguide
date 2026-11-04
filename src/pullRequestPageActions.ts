import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import * as vscode from 'vscode';
import { commitAndPush, syncToPullRequestHead } from './conflicts.js';
import type { OverviewActions, PickedSuggestion } from './pullRequestOverview.js';
import type { PullRequestConversation, PullRequestDetails, PullRequestProvider, RemoteThread } from './pullRequests.js';
import { applyLineSuggestions, parseSuggestions, type LineSuggestion } from './suggestions.js';
import { git } from './worktrees.js';

/** What the review page's GitHub actions need from the page that runs them. */
export interface PageContext {
  readonly provider: PullRequestProvider;
  readonly number: number;
  readonly headBranch: string;
  readonly baseBranch: () => string;
  /** The PR's worktree. */
  readonly folder: string;
  /** Skip Git hooks when committing, for someone else's PR. */
  readonly hooksOff: boolean;
  details(): Promise<PullRequestDetails>;
  conversation(): Promise<PullRequestConversation>;
  /** Read GitHub's review threads again. */
  threads(): Promise<readonly RemoteThread[]>;
  pushTarget(details: PullRequestDetails): string;
  claudeBusy(): boolean;
  /** Reload the page's GitHub state after a change; `listed` also refreshes the sidebar, for changes it shows. */
  reload(listed?: boolean): void;
  /** Use a new base branch for the diff. */
  useBase(branch: string): Promise<void>;
}

export type GitHubPageActions = Pick<OverviewActions, 'addComment' | 'editComment' | 'deleteIssueComment' | 'hideComment' | 'react' | 'discardReview' | 'dismissReview'
  | 'rerequestReview' | 'updateBranch' | 'enableAutoMerge' | 'disableAutoMerge' | 'enqueue' | 'dequeue' | 'revert' | 'restoreBranch' | 'rerun' | 'approveRuns'
  | 'branches' | 'changeBase' | 'renderMarkdown' | 'commitSuggestions'>;

/** GitHub's reasons for hiding a comment, as its menu names them. */
const hideReasons: readonly { readonly label: string; readonly classifier: string }[] = [
  { label: 'Outdated', classifier: 'OUTDATED' }, { label: 'Resolved', classifier: 'RESOLVED' }, { label: 'Duplicate', classifier: 'DUPLICATE' },
  { label: 'Off-topic', classifier: 'OFF_TOPIC' }, { label: 'Low quality', classifier: 'LOW_QUALITY' }, { label: 'Spam', classifier: 'SPAM' }, { label: 'Abuse', classifier: 'ABUSE' },
];

/** The review page's actions on GitHub conversations, reviews, the merge box and checks. */
export function githubPageActions(context: PageContext): GitHubPageActions {
  const { provider, number } = context;
  const confirm = async (message: string, action: string, detail?: string): Promise<boolean> =>
    await vscode.window.showWarningMessage(message, { modal: true, ...detail === undefined ? {} : { detail } }, action) === action;
  return {
    addComment: async (text) => {
      await provider.addComment(number, text);
      context.reload();
    },
    editComment: async (kind, id, text) => {
      await provider.editComment(kind, id, text);
      context.reload();
    },
    deleteIssueComment: async (id) => {
      if (!await confirm('Delete this comment on GitHub?', 'Delete', 'Everyone on the PR loses it. This cannot be undone.')) return;
      await provider.deleteIssueComment(id);
      context.reload();
    },
    hideComment: async (id, hide) => {
      if (hide) {
        const reason = await vscode.window.showQuickPick(hideReasons.map((entry) => entry.label), { title: 'Hide comment', placeHolder: 'Why hide it?' });
        const classifier = hideReasons.find((entry) => entry.label === reason)?.classifier;
        if (classifier === undefined) return;
        await provider.hideComment(id, classifier);
      } else await provider.hideComment(id, undefined);
      context.reload();
    },
    react: async (subject, content, on) => {
      await provider.react(subject, content, on);
      context.reload();
    },
    discardReview: async () => {
      if (!await confirm('Discard your pending review?', 'Discard review', 'Its comments are deleted. Nobody saw them yet.')) return;
      await provider.discardPendingReview(number);
      context.reload();
    },
    dismissReview: async (login) => {
      const review = (await context.conversation()).reviewIds[login];
      if (review === undefined) throw new Error(`${login} has no review to dismiss.`);
      const message = await vscode.window.showInputBox({ title: `Dismiss ${login}'s review`, prompt: 'Why dismiss it? Everyone on the PR sees this.', validateInput: (value) => value.trim() ? undefined : 'Enter a reason.' });
      if (message === undefined) return;
      await provider.dismissReview(review, message.trim());
      context.reload(true);
    },
    rerequestReview: async (login) => {
      await provider.requestReviewers(number, { users: [login], teams: [] });
      context.reload();
    },
    updateBranch: async () => {
      const merge = 'Update with merge commit';
      const rebase = 'Update with rebase';
      const answer = await vscode.window.showWarningMessage(`Bring the latest ${context.baseBranch()} into ${context.headBranch}?`, { modal: true, detail: 'A rebase rewrites the PR\'s commits.' }, merge, rebase);
      if (answer === undefined) return;
      await provider.updateBranch(number, answer === rebase ? 'rebase' : 'merge');
      context.reload(true);
    },
    enableAutoMerge: async (method, message) => {
      await provider.enableAutoMerge(number, method, message);
      context.reload();
    },
    disableAutoMerge: async () => {
      await provider.disableAutoMerge(number);
      context.reload();
    },
    enqueue: async () => {
      await provider.enqueue(number);
      context.reload();
    },
    dequeue: async () => {
      await provider.dequeue(number);
      context.reload();
    },
    revert: async () => {
      if (!await confirm(`Open a PR that reverts #${number}?`, 'Revert', 'GitHub creates a branch with a revert commit and opens a PR for it.')) return;
      const created = await provider.revert(number);
      context.reload(true);
      const open = 'Open on GitHub';
      if (await vscode.window.showInformationMessage(`Opened #${created.number} to revert #${number}.`, open) === open) await vscode.env.openExternal(vscode.Uri.parse(created.url));
    },
    restoreBranch: async () => {
      const { merge } = await context.conversation();
      if (!merge.headDeleted || merge.headOid === '') throw new Error('The head branch still exists.');
      await provider.restoreBranch(context.headBranch, merge.headOid);
      context.reload();
    },
    rerun: async (runId) => {
      await provider.rerunFailedJobs(runId);
      context.reload();
    },
    approveRuns: async () => {
      const { awaitingApproval } = await context.conversation();
      if (!await confirm(`Run ${awaitingApproval.length === 1 ? 'the workflow' : `${awaitingApproval.length} workflows`} from this fork?`, 'Approve and run',
        'Workflows from a fork run code its author wrote. Review the changes to workflow files first.')) return;
      for (const run of awaitingApproval) await provider.approveWorkflowRun(run);
      context.reload();
    },
    branches: async () => (await provider.branches()).filter((name) => name !== context.baseBranch() && name !== context.headBranch),
    changeBase: async (picked) => {
      const branches = (await provider.branches()).filter((name) => name !== context.baseBranch() && name !== context.headBranch);
      if (!branches.includes(picked)) throw new Error(`${picked} is not a branch this PR can merge into.`);
      if (!await confirm(`Change the base branch to ${picked}?`, 'Change base', `The PR then merges into ${picked} instead of ${context.baseBranch()}. Its diff and checks follow.`)) return;
      await provider.changeBase(number, picked);
      await context.useBase(picked);
      context.reload(true);
    },
    renderMarkdown: (text) => provider.renderMarkdown(text),
    commitSuggestions: async (picked) => {
      if (context.claudeBusy()) throw new Error('Claude is working on this PR. Commit the suggestions when it is done.');
      const details = await context.details();
      if (!details.canEdit) throw new Error('You cannot push to this PR.');
      const edits = suggestionEdits(await context.threads(), picked);
      const paths = [...edits.keys()];
      if ((await git(context.folder, ['status', '--porcelain', '--', ...paths])).trim() !== '') throw new Error('Files these suggestions change have uncommitted changes. Commit or discard them first.');
      await syncToPullRequestHead(context.folder, number);
      const before = new Map<string, string>();
      try {
        for (const [path, suggestions] of edits) {
          const file = join(context.folder, path);
          const text = await readFile(file, 'utf8');
          before.set(path, text);
          await writeFile(file, applyLineSuggestions(text, suggestions));
        }
      } catch (error: unknown) {
        for (const [path, text] of before) await writeFile(join(context.folder, path), text);
        throw error;
      }
      await commitAndPush(context.folder, {
        path: paths, message: picked.length === 1 ? 'Apply suggestion from code review' : 'Apply suggestions from code review',
        pushTo: context.pushTarget(details), headBranch: context.headBranch, hooksOff: context.hooksOff,
      });
      context.reload(true);
    },
  };
}

/** Each picked suggestion's lines and code, by file; refuses outdated threads and comments without exactly one suggestion. */
export function suggestionEdits(threads: readonly RemoteThread[], picked: readonly PickedSuggestion[]): ReadonlyMap<string, readonly LineSuggestion[]> {
  const edits = new Map<string, LineSuggestion[]>();
  for (const { thread: threadId, comment: commentId } of picked) {
    const thread = threads.find((entry) => entry.id === threadId);
    const comment = thread?.comments.find((entry) => entry.id === commentId);
    const suggestions = parseSuggestions(comment?.body ?? '');
    const [suggestion] = suggestions;
    if (thread === undefined || suggestion === undefined || suggestions.length !== 1 || thread.outdated || thread.side !== 'RIGHT') {
      throw new Error('A suggestion is outdated or gone. Refresh and pick again.');
    }
    if (thread.path.startsWith('/') || thread.path.includes('\0') || thread.path.split('/').includes('..')) throw new Error('GitHub returned an invalid file path.');
    const list = edits.get(thread.path) ?? [];
    list.push({ startLine: thread.startLine, endLine: thread.endLine, code: suggestion.code });
    edits.set(thread.path, list);
  }
  return edits;
}
