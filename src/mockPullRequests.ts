import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { PullRequestProvider, PullRequestSummary, ReviewVerdict } from './pullRequests.js';
import { git } from './worktrees.js';

const sampleHtmlPath = 'docs/sample-page.html';
const sampleHtml = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Release notes</title>
  <style>
    body { font-family: system-ui, sans-serif; max-width: 640px; margin: 2rem auto; padding: 0 1rem; color: #1f2328; }
    h1 { border-bottom: 1px solid #d0d7de; padding-bottom: .3rem; }
    .badge { display: inline-block; padding: 0 .5rem; border-radius: 1rem; background: #ddf4ff; color: #0969da; font-size: .85rem; }
    table { border-collapse: collapse; width: 100%; }
    th, td { border: 1px solid #d0d7de; padding: .4rem .6rem; text-align: left; }
    button { padding: .4rem .9rem; border-radius: 6px; border: 1px solid #1f883d; background: #1f883d; color: #fff; }
  </style>
</head>
<body>
  <h1>Release notes <span class="badge">v2.4</span></h1>
  <p>This release adds a pull request sidebar and remembers which files you reviewed.</p>
  <h2>Changes</h2>
  <ul>
    <li>Sidebar lists your PRs and the ones waiting for your review.</li>
    <li>Viewed ticks sync with GitHub.</li>
    <li>Legacy docs were removed.</li>
  </ul>
  <h2>Compatibility</h2>
  <table>
    <tr><th>Editor</th><th>Minimum version</th></tr>
    <tr><td>VS Code</td><td>1.95</td></tr>
    <tr><td>Cursor</td><td>0.42</td></tr>
  </table>
  <p><button type="button">Update now</button></p>
</body>
</html>
`;

/** Commit the sample HTML page on top of the base branch, so the overview has a real diff to preview. */
async function checkoutSample(worktree: string): Promise<void> {
  await git(worktree, ['fetch', '--quiet', 'origin', 'main']);
  await git(worktree, ['checkout', '--quiet', '--detach', 'FETCH_HEAD']);
  const file = join(worktree, sampleHtmlPath);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, sampleHtml);
  await git(worktree, ['add', sampleHtmlPath]);
  await git(worktree, ['-c', 'user.name=Sample', '-c', 'user.email=sample@example.com', 'commit', '--quiet', '--no-verify', '-m', 'Add sample release notes page']);
}

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
    { path: sampleHtmlPath, additions: sampleHtml.split('\n').length - 1, deletions: 0, change: 'added' },
  ],
  checkout: async (_number, worktree) => { await checkoutSample(worktree); },
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
  pickerOptions: async () => ({ users: [], teams: [], labels: [], milestones: [] }),
  search: async () => [],
  conversation: async () => ({
    timeline: [], description: { id: 'mock', reactions: [], canReact: false }, viewerLogin: 'you', permission: 'read',
    merge: { state: 'clean', canUpdateBranch: false, canBypass: false, canEnableAutoMerge: false, canDisableAutoMerge: false, mergeQueue: false, headOid: '', headDeleted: false },
    checks: [], linkedIssues: [], reviewIds: {}, awaitingApproval: [],
    commitDefaults: { squashTitle: 'COMMIT_OR_PR_TITLE', squashBody: 'COMMIT_MESSAGES', mergeTitle: 'MERGE_MESSAGE', mergeBody: 'PR_TITLE' },
  }),
  addComment: unchanged, editComment: unchanged, deleteIssueComment: unchanged, hideComment: unchanged, react: unchanged,
  discardPendingReview: unchanged, dismissReview: unchanged, updateBranch: unchanged, enableAutoMerge: unchanged, disableAutoMerge: unchanged,
  enqueue: unchanged, dequeue: unchanged, revert: unchanged, restoreBranch: unchanged, rerunFailedJobs: unchanged, approveWorkflowRun: unchanged,
  changeBase: unchanged, branches: async () => ['main'], renderMarkdown: async (text) => `<p>${text.replace(/[&<>]/gu, (char) => `&#${char.charCodeAt(0)};`)}</p>`,
  version: unchanged, listVersion: unchanged,
};

function unchanged(): Promise<never> {
  return Promise.reject(new Error('Sample pull requests cannot be changed.'));
}
