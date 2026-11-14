import type { AgentTask } from '../../core/agent.js';
import { pushCommits } from '../../core/conflicts.js';
import type { ChangeRequestVersion } from '../../core/forge.js';
import { type SyncResult, syncWithPullRequest, undoSync, waitMessage } from '../../core/git/sync.js';
import { followBase, git } from '../../core/git/worktrees.js';
import { readPullRequestDiffPlainFirst } from '../../core/unifiedDiff.js';
import type { OverviewActions, SyncNotice } from '../protocol.js';
import type { PageParts } from './context.js';

export type WorktreeActions = Pick<OverviewActions, 'push' | 'pollGitHub' | 'readCommit' | 'removeWorktree' | 'undoSync' | 'dismissSyncUndo' | 'answerSync' | 'dismissSyncQuestion'>;

const commitCount = (count: number): string => count === 1 ? '1 new commit' : `${count} new commits`;

/** The page's actions that move the PR's worktree: push it, keep it at GitHub's head with Claude merging clashes, read its commits and remove it. */
export function worktreeActions({ page, remote, diff, edits, notOnCheckout, pushTarget }: PageParts): WorktreeActions {
  const { provider, pullRequest, folder, role, opened, host } = page;
  /** The PR on GitHub at the last check, so the next one can ask whether it changed. */
  let version: ChangeRequestVersion | undefined;
  /** The worktree commit the page's files were last sent for, so a move by Claude's run or a sync shows up. */
  let shownHead: string | undefined;
  /** The state Claude last asked about or failed to merge, so polls do not run Claude on it again. */
  let tried: string | undefined;
  /** Your answer to Claude's question, for the next sync. */
  let answer: string | undefined;
  /** GitHub's head whose sync you undid; the checkout stays without it until GitHub's head moves on. */
  let undone: string | undefined;
  /** What the page shows for a sync's result, and the notice it brings. */
  const showSync = (result: SyncResult): { readonly problem?: string; readonly notice?: SyncNotice } => {
    if (result.outcome === 'claude') {
      if (result.tried === true) return {};
      return { problem: result.files.length === 0 ? `GitHub rewrote ${pullRequest.headBranch}, and DiffGuide cannot tell which commits here are yours, so this checkout stays as it is.`
        : `GitHub's new commits clash with changes here in ${result.files.join(', ')}, so this checkout stays as it is.` };
    }
    if (result.outcome === 'question') {
      tried = result.attempt;
      edits.syncQuestion = result.question;
      return { notice: { text: 'Claude needs your input to sync.', show: 'sync-question' } };
    }
    if (result.outcome === 'rejected') {
      tried = result.attempt;
      edits.syncQuestion = undefined;
      return { notice: { text: result.error === undefined ? `Claude's merge of ${result.files.join(', ')} left conflict markers, so your checkout stays as it was.`
        : `Claude could not merge ${result.files.join(', ')}, so your checkout stays as it was. ${result.error}` } };
    }
    if (result.outcome === 'synced') {
      edits.syncQuestion = undefined;
      const { resolved } = result;
      edits.syncUndo = resolved === undefined ? undefined : {
        text: `Claude merged your edits to ${resolved.files.join(', ')} with GitHub's ${commitCount(resolved.commits)}.`, backup: resolved.backup, head: result.head, commits: resolved.commits,
      };
    }
    return {};
  };
  return {
    push: async () => {
      if (opened.runner.activity.running) throw new Error('Claude is working on this PR. Push when it is done.');
      const loaded = await remote.currentDetails();
      if (!loaded.canEdit) throw new Error('You cannot push to this PR.');
      await pushCommits(folder, { pushTo: pushTarget(loaded), headBranch: pullRequest.headBranch, hooksOff: role === 'reviewer', number: pullRequest.number });
      remote.changedOnGitHub();
    },
    readCommit: async (oid) => {
      await diff.haveCommit(oid);
      return readPullRequestDiffPlainFirst(folder, (await git(folder, ['rev-parse', `${oid}^`])).trim(), { to: oid });
    },
    removeWorktree: async () => {
      notOnCheckout('Remove worktree');
      await host.removeWorktree();
      host.refreshSidebar();
    },
    pollGitHub: async () => {
      const previous = version;
      version = await provider.version(pullRequest.number, previous);
      const { baseBranch, baseHead } = version;
      // GitHub diffs against the base's current tip, so a retarget or a moved base changes which files are in the PR.
      const retargeted = baseBranch !== undefined && baseBranch !== '' && baseBranch !== diff.baseBranch;
      // Offline, the base stays as last fetched; the head's sync below says why.
      if (baseBranch !== undefined && baseBranch !== '' && baseHead !== undefined) await followBase(folder, baseBranch, baseHead).catch(() => false);
      if (retargeted) {
        diff.baseBranch = baseBranch;
        await opened.useBase(baseBranch);
      }
      const reload = (previous !== undefined && version !== previous) || remote.written.waiting || retargeted;
      const stale = await diff.baseChanged();
      // While Claude works the files stay as they are; the page says they are out of date.
      if (opened.runner.activity.running) return { reload, files: false, ...stale ? { stale } : {} };
      const before = await diff.readHead();
      shownHead ??= before;
      let problem: string | undefined;
      let waiting: string | undefined;
      let notice: SyncNotice | undefined;
      const ahead = await git(folder, ['merge-base', '--is-ancestor', version.head, 'HEAD']).then(() => true, () => false);
      if (version.head !== before && !ahead && version.head !== undone) {
        const given = answer;
        answer = undefined;
        const resolver = { run: (task: AgentTask) => opened.runner.runTask(task), ...tried === undefined ? {} : { tried }, ...given === undefined ? {} : { answer: given } };
        const result = await syncWithPullRequest(folder, pullRequest.number, previous?.head, resolver).catch((error: unknown) => error instanceof Error ? error : new Error(String(error)));
        if (result instanceof Error) problem = result.message;
        else if (result.outcome === 'waits') waiting = waitMessage(result.reason);
        else ({ problem, notice } = showSync(result));
      }
      const head = await diff.readHead();
      const files = head !== shownHead || stale;
      shownHead = head;
      return { reload: reload || files || notice !== undefined, files, ...(problem === undefined ? {} : { problem }), ...(waiting === undefined ? {} : { waiting }), ...(notice === undefined ? {} : { notice }) };
    },
    undoSync: async () => {
      const last = edits.syncUndo;
      if (last === undefined) throw new Error('There is no sync to undo.');
      if (opened.runner.activity.running) throw new Error('Claude is working on this PR. Undo when it is done.');
      await undoSync(folder, last.backup);
      undone = last.head;
      edits.syncUndo = undefined;
      remote.changed();
      return `Undid the sync. Your checkout is as it was, without GitHub's ${commitCount(last.commits)}.`;
    },
    dismissSyncUndo: () => {
      edits.syncUndo = undefined;
      remote.changed();
    },
    answerSync: (text) => {
      answer = text;
      tried = undefined;
      edits.syncQuestion = undefined;
      remote.changed();
    },
    dismissSyncQuestion: () => {
      edits.syncQuestion = undefined;
      remote.changed();
    },
  };
}
