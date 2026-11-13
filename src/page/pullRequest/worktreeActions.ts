import { pushCommits, syncToPullRequestHead } from '../../core/conflicts.js';
import type { ChangeRequestVersion } from '../../core/forge.js';
import { followBase, git } from '../../core/git/worktrees.js';
import { readPullRequestDiff } from '../../core/unifiedDiff.js';
import type { OverviewActions } from '../protocol.js';
import type { PageParts } from './context.js';

export type WorktreeActions = Pick<OverviewActions, 'push' | 'pollGitHub' | 'readCommit' | 'removeWorktree'>;

/** The page's actions that move the PR's worktree: push it, keep it at GitHub's head, read its commits and remove it. */
export function worktreeActions({ page, remote, diff, notOnCheckout, pushTarget }: PageParts): WorktreeActions {
  const { provider, pullRequest, folder, role, opened, host } = page;
  /** The PR on GitHub at the last check, so the next one can ask whether it changed. */
  let version: ChangeRequestVersion | undefined;
  /** The worktree commit the page's files were last sent for, so a move by Claude's run or a sync shows up. */
  let shownHead: string | undefined;
  return {
    push: async () => {
      if (opened.runner.activity.running) throw new Error('Claude is working on this PR. Push when it is done.');
      const loaded = await remote.currentDetails();
      if (!loaded.canEdit) throw new Error('You cannot push to this PR.');
      await pushCommits(folder, { pushTo: pushTarget(loaded), headBranch: pullRequest.headBranch, hooksOff: role === 'reviewer' });
      remote.changedOnGitHub();
    },
    readCommit: async (oid) => {
      await diff.haveCommit(oid);
      return readPullRequestDiff(folder, (await git(folder, ['rev-parse', `${oid}^`])).trim(), { to: oid });
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
      const baseMoved = baseBranch !== undefined && baseBranch !== '' && baseHead !== undefined && await followBase(folder, baseBranch, baseHead);
      if (retargeted) {
        diff.baseBranch = baseBranch;
        await opened.useBase(baseBranch);
      }
      const reload = (previous !== undefined && version !== previous) || remote.written.waiting || retargeted;
      if (opened.runner.activity.running) return { reload, files: false };
      const before = await diff.readHead();
      shownHead ??= before;
      let problem: string | undefined;
      const ahead = await git(folder, ['merge-base', '--is-ancestor', version.head, 'HEAD']).then(() => true, () => false);
      if (version.head !== before && !ahead && page.onCheckout) {
        problem = `GitHub has commits on ${pullRequest.headBranch} that this checkout does not. Pull them to see them here.`;
      } else if (version.head !== before && !ahead) {
        await syncToPullRequestHead(folder, pullRequest.number, previous?.head).catch((error: unknown) => { problem = error instanceof Error ? error.message : String(error); });
      }
      const head = await diff.readHead();
      const files = head !== shownHead || baseMoved || retargeted;
      shownHead = head;
      return { reload: reload || files, files, ...(problem === undefined ? {} : { problem }) };
    },
  };
}
