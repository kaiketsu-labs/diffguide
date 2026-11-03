import type { ClaudeTask } from './claudeRunner.js';
import { git } from './worktrees.js';

/**
 * Bring a PR worktree to the PR's latest commit on GitHub and fetch its base branch; returns the base commit to merge.
 * Refuses a worktree with uncommitted changes or commits GitHub does not have, so a merge never builds on stale work.
 */
export async function prepareConflictFix(worktree: string, number: number, baseBranch: string): Promise<string> {
  if ((await git(worktree, ['status', '--porcelain'])).trim() !== '') throw new Error('The PR worktree has uncommitted changes. Commit or discard them first.');
  await git(worktree, ['fetch', '--quiet', 'origin', `pull/${number}/head`]);
  const head = (await git(worktree, ['rev-parse', 'FETCH_HEAD'])).trim();
  const local = (await git(worktree, ['rev-parse', 'HEAD'])).trim();
  if (local !== head) {
    const behind = await git(worktree, ['merge-base', '--is-ancestor', local, head]).then(() => true, () => false);
    if (!behind) throw new Error('The PR worktree has commits that are not on GitHub. Push or drop them first.');
    await git(worktree, ['checkout', '--quiet', '--detach', head]);
  }
  await git(worktree, ['fetch', '--quiet', 'origin', baseBranch]);
  return (await git(worktree, ['rev-parse', 'FETCH_HEAD'])).trim();
}

/** What to merge and where to push the result. */
export interface ConflictFix {
  readonly base: string;
  readonly baseBranch: string;
  readonly headBranch: string;
  /** `origin`, or the fork's URL when the head branch lives in a fork. */
  readonly pushTo: string;
}

/** The label of the conflict fix task, which the review page shows progress for. */
export const conflictFixLabel = 'fixing merge conflicts';

/** Ask Claude to merge the base, resolve the conflicts, commit and push; it may run only the Git commands this needs. */
export function conflictTask({ base, baseBranch, headBranch, pushTo }: ConflictFix): ClaudeTask {
  if (!/^[a-f\d]{40,64}$/u.test(base) || [baseBranch, headBranch].some((branch) => !/^[\w./-]+$/u.test(branch) || branch.startsWith('-') || branch.includes('..'))
    || !(pushTo === 'origin' || /^https:\/\/[\w.-]+\/[\w.-]+\/[\w.-]+\.git$/u.test(pushTo))) {
    throw new Error('Unsupported branch or remote for fixing conflicts.');
  }
  const push = `git push ${pushTo} HEAD:refs/heads/${headBranch}`;
  return {
    label: conflictFixLabel,
    prompt: [
      `GitHub reports merge conflicts between this pull request and its base branch ${baseBranch}. The worktree is at the PR's latest commit, on a detached HEAD.`,
      `Run \`git merge --no-edit ${base}\` to merge the base branch. Resolve every conflicted file so both sides' intent survives, then \`git add\` the files and \`git commit --no-edit\`.`,
      `Then run \`${push}\` to update the pull request.`,
      'Run only these Git commands. If a conflict needs a decision the code does not answer, run `git merge --abort`, push nothing, and explain what is needed.',
      'Finish with one line per conflicted file saying how you resolved it.',
    ].join('\n\n'),
    allowedTools: ['Bash(git merge *)', 'Bash(git status)', 'Bash(git status *)', 'Bash(git diff)', 'Bash(git diff *)', 'Bash(git log *)', 'Bash(git show *)', 'Bash(git add *)', 'Bash(git commit *)', `Bash(${push})`],
  };
}
