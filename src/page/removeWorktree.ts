/** The confirm for Remove worktree, on the review page and in the sidebar. `commits` are the worktree's commits GitHub does not have. */
export function removeWorktreeQuestion(number: number | undefined, commits: number): string {
  const which = number === undefined ? 'this PR' : `#${number}`;
  // Matches backupDays in core/git/backups.ts, which the page bundle cannot import.
  const kept = commits === 0 ? '' : ` It has ${commits === 1 ? '1 commit' : `${commits} commits`} GitHub does not have; DiffGuide keeps ${commits === 1 ? 'it' : 'them'} in a backup for 14 days.`;
  return `Remove the worktree for ${which}? Its local comments are deleted too.${kept} Git refuses if it has uncommitted changes.`;
}
