import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { AgentTask } from '../../core/agent.js';
import { conflictTask, prepareConflictFix } from '../../core/conflicts.js';
import { git } from '../../core/git/worktrees.js';
import { maximumReplyLength } from '../../core/limits.js';
import { draftReplyTask, githubReplyTask } from '../../core/pullRequestComments.js';
import { type FileDiff, readPullRequestDiffPlainFirst } from '../../core/unifiedDiff.js';
import type { OverviewActions } from '../protocol.js';
import type { PageParts } from './context.js';

export type ClaudeActions = Pick<OverviewActions, 'retry' | 'stopClaude' | 'newConversation' | 'compactConversation' | 'draftReply' | 'draftGitHubReply'
  | 'fixConflicts' | 'dismissConflictQuestion' | 'analyze' | 'stopAnalysis' | 'review' | 'stopReview' | 'pickReviewers'>;

/** The page's actions that run Claude: its conversation, drafted replies, conflict fixes, the guide and the code review. */
export function claudeActions({ page, remote, diff, edits, findThread, notOnCheckout, pushTarget }: PageParts): ClaudeActions {
  const { pullRequest, folder, opened, host } = page;
  /** Run a drafting task in the PR's conversation and return Claude's comment. */
  const runDraft = async (task: AgentTask): Promise<string> => {
    const { error, reply } = await opened.runner.runTask(task);
    if (error !== undefined) throw new Error(`Claude could not draft the reply: ${error}`);
    if (reply === undefined) throw new Error('Claude did not write a draft. Try again.');
    return reply.slice(0, maximumReplyLength);
  };
  /** The PR's changes without syntax colors, which Claude's prompts strip anyway. */
  const readChanges = async (): Promise<readonly FileDiff[]> => (await readPullRequestDiffPlainFirst(folder, await diff.readBase())).files;
  const about = `#${pullRequest.number} ${pullRequest.title} (${pullRequest.headBranch} into ${pullRequest.baseBranch})`;
  return {
    retry: () => { opened.runner.retry(); },
    stopClaude: () => opened.runner.stop(),
    newConversation: async () => { notOnCheckout('New conversation'); await opened.runner.forget(); },
    compactConversation: async () => { notOnCheckout('Compact'); await opened.runner.compact(); },
    draftReply: async (id, notes) => {
      const thread = findThread(id);
      const linked = opened.session.linkedGitHubThread?.(thread.id);
      const loaded = linked === undefined ? [] : await remote.threads();
      const quoted = loaded instanceof Error ? [] : loaded.find((each) => each.id === linked)?.comments.filter((comment) => comment.hidden === undefined) ?? [];
      return runDraft(draftReplyTask(thread, quoted, notes));
    },
    draftGitHubReply: async (id, notes) => {
      const loaded = await remote.threads();
      const thread = loaded instanceof Error ? undefined : loaded.find((each) => each.id === id);
      if (thread === undefined) throw new Error('This GitHub thread no longer exists.');
      const lines = thread.scope === 'file' ? undefined : `${thread.path} lines ${thread.startLine}-${thread.endLine}`;
      // An outdated thread's lines no longer hold the code it was written on, so Claude gets none.
      const code = lines === undefined || thread.outdated ? undefined : await (thread.side === 'LEFT' ? host.readBaseContent(folder, thread.path, await diff.readBase()) : readFile(join(folder, thread.path), 'utf8'))
        .then((content) => content.split('\n').slice(thread.startLine - 1, thread.endLine).join('\n'), () => undefined);
      const you = await remote.conversation();
      const comments = thread.comments.filter((comment) => comment.hidden === undefined).map(({ author, body }) => ({ author, body }));
      return runDraft(githubReplyTask({ location: lines ?? `the file ${thread.path}`, ...code === undefined ? {} : { code }, comments, ...you instanceof Error || !you.viewerLogin ? {} : { you: you.viewerLogin } }, notes));
    },
    fixConflicts: async (answer) => {
      notOnCheckout('Fix conflicts');
      const loaded = await remote.currentDetails();
      if (loaded.mergeable !== 'no' || !loaded.canEdit) throw new Error('GitHub reports no conflicts you can fix on this PR.');
      const { baseBranch } = diff;
      const base = await prepareConflictFix(folder, pullRequest.number, baseBranch);
      const head = (await git(folder, ['rev-parse', 'HEAD'])).trim();
      edits.conflictQuestion = undefined;
      const pushTo = pushTarget(loaded);
      const { error, reply } = await opened.runner.runTask(conflictTask({ base, baseBranch, headBranch: pullRequest.headBranch, pushTo, ...(answer === undefined ? {} : { answer }) }));
      const pushedNothing = (await git(folder, ['rev-parse', 'HEAD'])).trim() === head;
      if (error === undefined && pushedNothing && reply !== undefined) edits.conflictQuestion = reply;
      remote.changedOnGitHub();
      if (error !== undefined) throw new Error(`Claude did not fix the conflicts: ${error}`);
    },
    dismissConflictQuestion: () => {
      edits.conflictQuestion = undefined;
      remote.changed();
    },
    analyze: async () => {
      const [files, head] = await Promise.all([readChanges(), diff.readHead()]);
      opened.analysis.start({
        files, head, about,
        anchor: async ({ range }) => (await diff.anchor({ ...range, endLine: Math.min(range.endLine, range.startLine + 49) })).anchor,
      });
    },
    stopAnalysis: () => { opened.analysis.stop(); },
    review: async (picks) => {
      await host.savePicks(picks);
      const files = await readChanges();
      opened.review.start({
        files, reviewers: picks, about,
        anchor: async (range) => (await diff.anchor(range)).anchor,
      });
    },
    stopReview: () => { opened.review.stop(); },
    pickReviewers: async (picks) => { await host.savePicks(picks); remote.changed(); },
  };
}
