import type { PullRequestProvider, PullRequestSummary, ReviewVerdict } from './pullRequests.js';

/** Build a sample PR whose link points at a placeholder repository. */
function sample(number: number, title: string, author: string, draft: boolean, headBranch: string, review?: ReviewVerdict): PullRequestSummary {
  return {
    number, title, url: `https://github.com/mock/sample-repo/pull/${number}`, author, draft, headBranch, baseBranch: 'main', ...(review === undefined ? {} : { review }),
    createdAt: new Date(Date.now() - number * 3_600_000).toISOString(), updatedAt: new Date(Date.now() - number * 60_000).toISOString(),
    changes: { additions: 60, deletions: 15, files: 3 },
  };
}

/** Fixed sample data that fills every sidebar section without contacting a code host. */
export const mockPullRequestProvider: PullRequestProvider = {
  readRepository: async () => ({ name: 'mock/sample-repo', url: 'https://github.com/mock/sample-repo' }),
  listMine: async () => [
    sample(101, 'Add pull request sidebar', 'you', false, 'feature/pr-sidebar', 'approved'),
    sample(102, 'Track reviewed files per PR', 'you', true, 'feature/reviewed-files'),
  ],
  listReviewRequested: async () => [
    sample(201, 'Migrate auth to OAuth device flow', 'alice', false, 'refactor/auth-migration', 'changes'),
    sample(202, 'Cache diff results per commit', 'bob', false, 'perf/diff-cache', 'commented'),
    sample(203, 'Draft: new settings page', 'carol', true, 'ui/settings-page'),
  ],
  listFiles: async () => [
    { path: 'src/sidebar.ts', additions: 42, deletions: 3, change: 'modified' },
    { path: 'src/reviewed.ts', additions: 18, deletions: 0, change: 'added' },
    { path: 'docs/legacy.md', additions: 0, deletions: 12, change: 'deleted' },
  ],
  checkout: async () => { throw new Error('Sample pull requests cannot be checked out. Turn off pairReview.mockPullRequests to open real PRs.'); },
  viewedFiles: async () => new Set(),
  setViewed: async () => undefined,
  publishComment: async () => { throw new Error('Sample pull requests cannot receive comments.'); },
  details: async () => ({
    bodyHtml: '<p>Sample description.</p>', title: 'Sample pull request', body: 'Sample description.', open: true, merged: false, draft: false,
    canEdit: false, branchDeletable: false, labels: [], assignees: [], mergeable: 'yes', viewerAvatarUrl: '', viewerIsAuthor: false, mergeMethods: ['squash', 'merge'],
    reviewers: [{ name: 'alice', state: 'approved' }, { name: 'bob', state: 'requested' }],
    checks: [{ name: 'build', state: 'success' }, { name: 'lint', state: 'pending' }],
  }),
  threads: async () => [],
  overview: async (number) => ({ details: await mockPullRequestProvider.details(number), threads: await mockPullRequestProvider.threads(number) }),
  replyToThread: async () => { throw new Error('Sample pull requests cannot receive comments.'); },
  resolveThread: async () => { throw new Error('Sample pull requests cannot receive comments.'); },
  deleteComment: async () => { throw new Error('Sample pull requests cannot receive comments.'); },
  submitReview: async () => { throw new Error('Sample pull requests cannot be reviewed.'); },
  merge: async () => { throw new Error('Sample pull requests cannot be merged.'); },
  editPullRequest: async () => { throw new Error('Sample pull requests cannot be changed.'); },
  setDraft: async () => { throw new Error('Sample pull requests cannot be changed.'); },
  requestReviewers: async () => { throw new Error('Sample pull requests cannot be changed.'); },
  removeReviewers: async () => { throw new Error('Sample pull requests cannot be changed.'); },
  deleteBranch: async () => { throw new Error('Sample pull requests cannot be changed.'); },
  pickerOptions: async () => ({ users: [], teams: [], labels: [] }),
};
