import type { ClaudeTask } from './claudeRunner.js';
import { git } from './worktrees.js';

/**
 * Bring a PR worktree to the PR's latest commit on GitHub and fetch its base branch; returns the base commit to merge.
 * Refuses a worktree with uncommitted changes or commits GitHub does not have, so a merge never builds on stale work.
 */
export async function prepareConflictFix(worktree: string, number: number, baseBranch: string): Promise<string> {
  if ((await git(worktree, ['status', '--porcelain'])).trim() !== '') throw new Error('The PR worktree has uncommitted changes. Commit or discard them first.');
  await syncToPullRequestHead(worktree, number);
  await git(worktree, ['fetch', '--quiet', 'origin', baseBranch]);
  return (await git(worktree, ['rev-parse', 'FETCH_HEAD'])).trim();
}

/**
 * Move a PR worktree to the PR's latest commit on GitHub, keeping uncommitted edits; refuses when it has commits GitHub does not have.
 * `pushedHead` is a commit GitHub had as the PR's head, so a worktree still there may follow a force push.
 */
export async function syncToPullRequestHead(worktree: string, number: number, pushedHead?: string): Promise<void> {
  await git(worktree, ['fetch', '--quiet', 'origin', `pull/${number}/head`]);
  const head = (await git(worktree, ['rev-parse', 'FETCH_HEAD'])).trim();
  const local = (await git(worktree, ['rev-parse', 'HEAD'])).trim();
  if (local === head) return;
  const behind = local === pushedHead || await git(worktree, ['merge-base', '--is-ancestor', local, head]).then(() => true, () => false);
  if (!behind) throw new Error('The PR worktree has commits that are not on GitHub. Push or drop them first.');
  await git(worktree, ['checkout', '--quiet', '--detach', head]).catch((error: unknown) => {
    const blocking = /would be overwritten/u.test(String(error)) ? String(error).split('\n').filter((line) => line.startsWith('\t')).map((line) => line.trim()) : [];
    if (blocking.length === 0) throw error;
    throw new Error(`GitHub has newer commits that change files with local edits: ${blocking.join(', ')}. Commit, push or discard them to update.`);
  });
}

/**
 * Before Claude works on a PR: move to the PR's latest commit unless the worktree already has it, keeping local commits built on top.
 * Returns false when GitHub could not be reached, leaving the worktree as it is.
 */
export async function catchUpWithPullRequest(worktree: string, number: number): Promise<boolean> {
  if (!await git(worktree, ['fetch', '--quiet', 'origin', `pull/${number}/head`]).then(() => true, () => false)) return false;
  const head = (await git(worktree, ['rev-parse', 'FETCH_HEAD'])).trim();
  if (!await git(worktree, ['merge-base', '--is-ancestor', head, 'HEAD']).then(() => true, () => false)) await syncToPullRequestHead(worktree, number);
  return true;
}

/**
 * Commit files of a PR worktree and push them to the PR's branch. A failed push takes the commit back and restores the files.
 * `hooksOff` skips Git hooks, for someone else's PR, whose author controls the checkout.
 */
export async function commitAndPush(worktree: string, { path, message, pushTo, headBranch, hooksOff }: {
  readonly path: string | readonly string[]; readonly message: string; readonly pushTo: string; readonly headBranch: string; readonly hooksOff: boolean;
}): Promise<void> {
  if (!isPushTarget(pushTo, headBranch)) throw new Error('Unsupported branch or remote for pushing.');
  const paths = typeof path === 'string' ? [path] : path;
  const hooks = hooksOff ? ['-c', 'core.hooksPath=/dev/null'] : [];
  await git(worktree, ['add', '--', ...paths]);
  await git(worktree, [...hooks, 'commit', '--quiet', '--only', '-m', message, '--', ...paths]);
  try {
    await git(worktree, [...hooks, 'push', '--quiet', pushTo, `HEAD:refs/heads/${headBranch}`]);
  } catch (error: unknown) {
    await git(worktree, ['reset', '--quiet', '--soft', 'HEAD~1']);
    await git(worktree, ['restore', '--quiet', '--staged', '--worktree', '--', ...paths]);
    throw error;
  }
}

/** What to merge and where to push the result. */
export interface ConflictFix {
  readonly base: string;
  readonly baseBranch: string;
  readonly headBranch: string;
  /** `origin`, or the fork's URL when the head branch lives in a fork. */
  readonly pushTo: string;
  /** The user's answer to what Claude asked when it last stopped. */
  readonly answer?: string;
}

/** The label of the conflict fix task, which the review page shows progress for. */
export const conflictFixLabel = 'fixing merge conflicts';

/** Ask Claude to merge the base, resolve the conflicts, commit and push; it may run only the Git commands this needs. */
export function conflictTask({ base, baseBranch, headBranch, pushTo, answer }: ConflictFix): ClaudeTask {
  if (!/^[a-f\d]{40,64}$/u.test(base) || !isBranch(baseBranch) || !isPushTarget(pushTo, headBranch)) throw new Error('Unsupported branch or remote for fixing conflicts.');
  const push = `git push ${pushTo} HEAD:refs/heads/${headBranch}`;
  return {
    label: conflictFixLabel,
    prompt: [
      `GitHub reports merge conflicts between this pull request and its base branch ${baseBranch}. The worktree is at the PR's latest commit, on a detached HEAD.`,
      `Run \`git merge --no-edit ${base}\` to merge the base branch. Resolve every conflicted file so both sides' intent survives, then \`git add\` the files and \`git commit --no-edit\`.`,
      `Then run \`${push}\` to update the pull request.`,
      'Run only these Git commands. If a conflict needs a decision the code does not answer, run `git merge --abort`, push nothing, and explain what is needed.',
      'Finish with one line per conflicted file saying how you resolved it.',
      ...(answer === undefined ? [] : [`You stopped here before and asked the user how to resolve the conflicts. They answered:\n\n${answer}`]),
    ].join('\n\n'),
    allowedTools: ['Bash(git merge *)', 'Bash(git status)', 'Bash(git status *)', 'Bash(git diff)', 'Bash(git diff *)', 'Bash(git log *)', 'Bash(git show *)', 'Bash(git add *)', 'Bash(git commit *)', `Bash(${push})`],
  };
}

const isBranch = (branch: string): boolean => /^[\w./-]+$/u.test(branch) && !branch.startsWith('-') && !branch.includes('..');

/** `origin` or a GitHub HTTPS URL, and a branch name Git cannot read as an option. */
const isPushTarget = (pushTo: string, headBranch: string): boolean =>
  isBranch(headBranch) && (pushTo === 'origin' || /^https:\/\/[\w.-]+\/[\w.-]+\/[\w.-]+\.git$/u.test(pushTo));
