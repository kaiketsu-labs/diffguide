import assert from 'node:assert/strict';
import test from 'node:test';
import type * as vscode from 'vscode';
import { type FileFolder, fileTree } from '../src/core/fileTree.js';
import type { ChangeRequestSummary, Forge } from '../src/core/forge.js';
import { errorDetail, githubEndpoints, GitHubSignInRequired } from '../src/forges/github/githubApi.js';
import { parseDetails, parsePickerOptions, parsePullRequestFiles, parsePullRequestList, parseReviewThreads } from '../src/forges/github/parse.js';
import { groupSearchResults, remoteNameFor } from '../src/forges/github/provider.js';
import { parseGitRemote, parsePullRequestLink, pickGitHubRemote } from '../src/forges/github/remotes.js';
import { mockPullRequestProvider } from '../src/forges/mockPullRequests.js';
import { type PullRequestWorktrees, registerPullRequestView } from '../src/hosts/vscode/pullRequestView.js';
import { commands, DataTransfer, env, EventEmitter, FakeMemento, settle, window } from './fakes/vscode.js';

const ghEntry = {
  author: { id: 'MDQ', is_bot: false, login: 'octo', name: 'Octo' },
  baseRefName: 'main', headRefName: 'feature', isDraft: true, number: 7,
  title: 'Add review sidebar', url: 'https://github.com/acme/app/pull/7',
};

const summary: ChangeRequestSummary = {
  number: 7, title: 'Add review sidebar', url: 'https://github.com/acme/app/pull/7',
  author: 'octo', draft: true, headBranch: 'feature', baseBranch: 'main',
};

test('parses gh pr list output into summaries', () => {
  assert.deepEqual(parsePullRequestList([ghEntry]), [summary]);
});

test('reads when a PR was opened and updated and how much it changes, skipping values that do not parse', () => {
  const [parsed] = parsePullRequestList([{ ...ghEntry, createdAt: '2026-11-01T10:00:00Z', updatedAt: '2026-11-02T10:00:00Z', additions: 312, deletions: 48, changedFiles: 14 }]);
  assert.deepEqual(parsed, { ...summary, createdAt: '2026-11-01T10:00:00Z', updatedAt: '2026-11-02T10:00:00Z', changes: { additions: 312, deletions: 48, files: 14 } });
  assert.deepEqual(parsePullRequestList([{ ...ghEntry, createdAt: 'soon', additions: -1, deletions: 0, changedFiles: 1 }]), [summary]);
});

test('sums up the latest reviews with changes requested above approval above comments', () => {
  const reviewed = (...states: string[]) => parsePullRequestList([{ ...ghEntry, latestReviews: states.map((state) => ({ state })) }])[0]?.review;
  assert.equal(reviewed('COMMENTED', 'APPROVED'), 'approved');
  assert.equal(reviewed('APPROVED', 'CHANGES_REQUESTED'), 'changes');
  assert.equal(reviewed('COMMENTED'), 'commented');
  assert.equal(reviewed(), undefined);
});

test('rejects a PR list with a malformed entry or a non-https link', () => {
  assert.throws(() => parsePullRequestList({}));
  assert.throws(() => parsePullRequestList([{ ...ghEntry, number: '7' }]));
  assert.throws(() => parsePullRequestList([{ ...ghEntry, url: 'javascript:alert(1)' }]));
  assert.throws(() => parsePullRequestList([{ ...ghEntry, author: null }]));
});

test('parses PR files and rejects paths outside the repository', () => {
  assert.deepEqual(parsePullRequestFiles({ files: [{ path: 'src/a.ts', additions: 2, deletions: 1, changeType: 'MODIFIED' }] }),
    [{ path: 'src/a.ts', additions: 2, deletions: 1, change: 'modified' }]);
  assert.throws(() => parsePullRequestFiles({ files: [{ path: '../a.ts', additions: 0, deletions: 0, changeType: 'ADDED' }] }));
  assert.throws(() => parsePullRequestFiles({ files: [{ path: '/etc/passwd', additions: 0, deletions: 0, changeType: 'ADDED' }] }));
  assert.throws(() => parsePullRequestFiles([]));
});

test('sends github.com to its API and only the configured enterprise host to its own', () => {
  assert.deepEqual(githubEndpoints('github.com', undefined), { host: 'github.com', rest: 'https://api.github.com', graphql: 'https://api.github.com/graphql', authProvider: 'github' });
  assert.deepEqual(githubEndpoints('git.acme.dev', 'https://Git.Acme.dev/'), { host: 'git.acme.dev', rest: 'https://git.acme.dev/api/v3', graphql: 'https://git.acme.dev/api/graphql', authProvider: 'github-enterprise' });
  assert.deepEqual(githubEndpoints('acme.ghe.com', 'https://acme.ghe.com'), { host: 'acme.ghe.com', rest: 'https://api.acme.ghe.com', graphql: 'https://api.acme.ghe.com/graphql', authProvider: 'github-enterprise' });
  assert.throws(() => githubEndpoints('git.acme.dev', undefined), /github-enterprise\.uri/u);
  assert.throws(() => githubEndpoints('git.acme.dev', 'https://other.example.com'), /github-enterprise\.uri/u);
});

test('fetches a PR from the remote that points at its repository', () => {
  const config = 'remote.origin.url git@github.com:me/app.git\nremote.upstream.url https://github.com/Acme/App.git\nremote.-x.url https://github.com/acme/app';
  assert.equal(remoteNameFor(config, { host: 'github.com', owner: 'acme', name: 'app' }), 'upstream');
  assert.equal(remoteNameFor(config, { host: 'github.com', owner: 'acme', name: 'other' }), undefined);
  assert.equal(remoteNameFor('remote.-x.url https://github.com/acme/app', { host: 'github.com', owner: 'acme', name: 'app' }), undefined);
});

/** Record worktree requests instead of touching Git. */
function recordingWorktrees(): PullRequestWorktrees & { opened: string[]; checkedOut: Set<number>; reviewed: Set<string> } {
  const opened: string[] = [];
  const checkedOut = new Set<number>();
  const reviewed = new Set<string>();
  return {
    opened, checkedOut, reviewed,
    exists: async (_repository, number) => checkedOut.has(number),
    open: async (_provider, repository, pullRequest, role) => { opened.push(`${repository}#${pullRequest.number}:${role}`); checkedOut.add(pullRequest.number); },
    remove: async (_repository, number) => { checkedOut.delete(number); },
    showClaude: async () => undefined,
    claudeStatus: () => undefined,
    working: () => false,
    reviewedFiles: async (_provider, _repository, _number, paths) => new Set(paths.filter((file) => reviewed.has(file))),
    showOverview: async () => undefined,
    localChanges: async () => ({ commits: 0, files: new Map() }),
    forget: () => undefined,
  };
}

const noStatusChanges: vscode.Event<string | undefined> = () => ({ dispose: () => undefined });

/** Expand a tree level and render its items. */
async function level(provider: vscode.TreeDataProvider<unknown>, node?: unknown): Promise<{ node: unknown; item: vscode.TreeItem }[]> {
  const children = await provider.getChildren(node) ?? [];
  return await Promise.all(children.map(async (child) => ({ node: child, item: await provider.getTreeItem(child) })));
}

test('parses PR details into reviewers, commenters but not the author among them, re-requests, checks and allowed merge methods', () => {
  const details = parseDetails({
    squashMergeAllowed: true, mergeCommitAllowed: false, rebaseMergeAllowed: true, deleteBranchOnMerge: false,
    pullRequest: {
      bodyHTML: '<p>Hi</p>', body: 'Hi', title: 'Add search', state: 'OPEN', isDraft: true, mergeable: 'CONFLICTING', viewerDidAuthor: true,
      viewerCanUpdate: true, isCrossRepository: false, headRef: { id: 'R1' },
      labels: { nodes: [{ name: 'bug', color: 'd73a4a' }, { name: 'bad', color: 'red' }] }, assignees: { nodes: [{ login: 'alice' }, {}] },
      latestOpinionatedReviews: { nodes: [{ state: 'APPROVED', author: { login: 'alice' } }, { state: 'COMMENTED', author: null }] },
      author: { login: 'octo' },
      latestReviews: { nodes: [{ state: 'COMMENTED', author: { login: 'carol' } }, { state: 'COMMENTED', author: { login: 'alice' } }, { state: 'COMMENTED', author: { login: 'octo' } }] },
      reviewRequests: { nodes: [{ requestedReviewer: { login: 'bob' } }, { requestedReviewer: { name: 'core', slug: 'core-team' } }, { requestedReviewer: { login: 'alice' } }] },
      commits: { nodes: [{ commit: { statusCheckRollup: { contexts: { nodes: [
        { __typename: 'CheckRun', name: 'build', status: 'COMPLETED', conclusion: 'SUCCESS', detailsUrl: 'https://ci/1' },
        { __typename: 'CheckRun', name: 'test', status: 'IN_PROGRESS', conclusion: null, detailsUrl: 'javascript:alert(1)' },
        { __typename: 'StatusContext', context: 'deploy', state: 'FAILURE', targetUrl: null },
      ] } } } }] },
    },
  });
  assert.deepEqual(details, {
    bodyHtml: '<p>Hi</p>', title: 'Add search', body: 'Hi', open: true, merged: false, draft: true, canEdit: true, branchDeletable: true,
    labels: [{ name: 'bug', color: 'd73a4a' }], assignees: ['alice'],
    mergeable: 'no', viewerIsAuthor: true, viewerAvatarUrl: '', mergeMethods: ['squash', 'rebase'],
    reviewers: [{ name: 'alice', state: 'approved', rerequested: true }, { name: 'carol', state: 'commented' }, { name: 'bob', state: 'requested' }, { name: 'core', state: 'requested', team: 'core-team' }],
    checks: [{ name: 'build', state: 'success', url: 'https://ci/1' }, { name: 'test', state: 'pending' }, { name: 'deploy', state: 'failure' }],
  });
});

test('offers no branch deletion for forks, deleted branches or repositories that delete on merge', () => {
  const deletable = (repository: Record<string, unknown>, pullRequest: Record<string, unknown>) =>
    parseDetails({ ...repository, pullRequest: { latestOpinionatedReviews: { nodes: [] }, reviewRequests: { nodes: [] }, commits: { nodes: [] }, labels: { nodes: [] }, assignees: { nodes: [] },
      isCrossRepository: false, headRef: { id: 'R1' }, ...pullRequest } }).branchDeletable;
  assert.equal(deletable({}, {}), true);
  assert.equal(deletable({}, { isCrossRepository: true }), false);
  assert.equal(deletable({}, { headRef: null }), false);
  assert.equal(deletable({ deleteBranchOnMerge: true }, {}), false);
});

test('reads the viewer\'s avatar and drops links that are not https', () => {
  const pullRequest = { latestOpinionatedReviews: { nodes: [] }, reviewRequests: { nodes: [] }, commits: { nodes: [] }, labels: { nodes: [] }, assignees: { nodes: [] } };
  assert.equal(parseDetails({ pullRequest }, { avatarUrl: 'https://avatars.githubusercontent.com/u/1' }).viewerAvatarUrl, 'https://avatars.githubusercontent.com/u/1');
  assert.equal(parseDetails({ pullRequest }, { avatarUrl: 'javascript:alert(1)' }).viewerAvatarUrl, '');
  assert.equal(parseDetails({ pullRequest }, { login: 'fstermann', name: ' Fabian Stermann ' }).viewerName, 'Fabian Stermann');
  assert.equal(parseDetails({ pullRequest }, { login: 'fstermann', name: null }).viewerName, 'fstermann');
  assert.equal(parseDetails({ pullRequest }, {}).viewerName, undefined);
});

test('reads picker options, with teams only for organizations', () => {
  const repository = { assignableUsers: { nodes: [{ login: 'alice' }] }, labels: { nodes: [{ name: 'bug', color: 'd73a4a' }] } };
  assert.deepEqual(parsePickerOptions({ ...repository, owner: { teams: { nodes: [{ name: 'Core', slug: 'core' }, { name: 'No slug' }] } } }),
    { users: ['alice'], teams: [{ name: 'Core', slug: 'core' }], labels: [{ name: 'bug', color: 'd73a4a' }], milestones: [] });
  assert.deepEqual(parsePickerOptions({ ...repository, owner: {}, milestones: { nodes: [{ number: 3, title: 'v1' }, { title: 'No number' }] } }).milestones, [{ number: 3, title: 'v1' }]);
  assert.deepEqual(parsePickerOptions({ ...repository, owner: {} }).teams, []);
  assert.deepEqual(parsePickerOptions({ ...repository, owner: {}, labels: { nodes: [{ name: 'bug', color: 'd73a4a', description: ' Broken ' }, { name: 'docs', color: '0075ca', description: '' }] } }).labels,
    [{ name: 'bug', color: 'd73a4a', description: 'Broken' }, { name: 'docs', color: '0075ca' }]);
});

test('reads GitHub review threads, using original lines for outdated ones and line 1 for file-level ones', () => {
  const comment = (login: string | null, body: string, url = 'https://github.com/acme/app/pull/7#discussion_r1', state = 'SUBMITTED') => ({ id: 'C-' + body, viewerCanDelete: login === 'alice', url, bodyHTML: `<p>${body}</p>`, state, createdAt: login === null ? undefined : '2026-01-02T03:04:05Z', author: login === null ? null : { login, avatarUrl: `https://avatars.githubusercontent.com/${login}`, ...login === 'alice' ? { name: 'Alice Liddell' } : {} } });
  const threads = parseReviewThreads([
    { id: 'T1', path: 'src/a.ts', diffSide: 'RIGHT', line: 12, startLine: 10, originalLine: 3, originalStartLine: 1, isOutdated: false, isResolved: true,
      comments: { nodes: [comment('alice', 'Why?'), comment(null, 'Because.')] } },
    { id: 'T2', path: 'src/b.ts', diffSide: 'LEFT', line: null, startLine: null, originalLine: 7, originalStartLine: null, isOutdated: true, isResolved: false,
      comments: { nodes: [{ ...comment('bob', 'Typo', undefined, 'PENDING'), diffHunk: '@@ -7 +7 @@\n-teh' }] } },
    { id: 'T3', path: 'README.md', diffSide: 'RIGHT', line: null, startLine: null, originalLine: null, originalStartLine: null, isOutdated: false, isResolved: false, subjectType: 'FILE',
      comments: { nodes: [comment('bob', 'Whole file')] } },
    { id: 'T5', path: 'README.md', diffSide: 'RIGHT', line: null, startLine: null, originalLine: null, originalStartLine: null, isOutdated: false, isResolved: false, subjectType: 'LINE',
      comments: { nodes: [comment('bob', 'No line')] } },
  ]);
  assert.deepEqual(threads, [
    { id: 'T1', path: 'src/a.ts', side: 'RIGHT', startLine: 10, endLine: 12, outdated: false, resolved: true, pending: false, url: 'https://github.com/acme/app/pull/7#discussion_r1',
      comments: [{ id: 'C-Why?', author: 'alice', authorName: 'Alice Liddell', avatarUrl: 'https://avatars.githubusercontent.com/alice', pending: false, bodyHtml: '<p>Why?</p>', canDelete: true, createdAt: '2026-01-02T03:04:05Z', body: '', url: 'https://github.com/acme/app/pull/7#discussion_r1', canEdit: false, canHide: false, canReact: false, edited: false, reactions: [] }, { id: 'C-Because.', author: 'ghost', avatarUrl: '', pending: false, bodyHtml: '<p>Because.</p>', canDelete: false, createdAt: '', body: '', url: 'https://github.com/acme/app/pull/7#discussion_r1', canEdit: false, canHide: false, canReact: false, edited: false, reactions: [] }] },
    { id: 'T2', path: 'src/b.ts', side: 'LEFT', startLine: 7, endLine: 7, outdated: true, resolved: false, pending: true, url: 'https://github.com/acme/app/pull/7#discussion_r1', diffHunk: '@@ -7 +7 @@\n-teh',
      comments: [{ id: 'C-Typo', author: 'bob', avatarUrl: 'https://avatars.githubusercontent.com/bob', pending: true, bodyHtml: '<p>Typo</p>', canDelete: false, createdAt: '2026-01-02T03:04:05Z', body: '', url: 'https://github.com/acme/app/pull/7#discussion_r1', canEdit: false, canHide: false, canReact: false, edited: false, reactions: [] }] },
    { id: 'T3', path: 'README.md', side: 'RIGHT', startLine: 1, endLine: 1, outdated: false, resolved: false, pending: false, url: 'https://github.com/acme/app/pull/7#discussion_r1', scope: 'file',
      comments: [{ id: 'C-Whole file', author: 'bob', avatarUrl: 'https://avatars.githubusercontent.com/bob', pending: false, bodyHtml: '<p>Whole file</p>', canDelete: false, createdAt: '2026-01-02T03:04:05Z', body: '', url: 'https://github.com/acme/app/pull/7#discussion_r1', canEdit: false, canHide: false, canReact: false, edited: false, reactions: [] }] },
  ]);
  assert.throws(() => parseReviewThreads([{ id: 'T4', path: 'a', line: 1, isOutdated: false, comments: { nodes: [comment('x', 'y', 'javascript:alert(1)')] } }]), /invalid link/u);
});

test('keeps the reasons GitHub gives from a failed API call', () => {
  assert.equal(errorDetail('{"message":"Validation Failed","errors":[{"message":"one pending review per pull request"},"line must be part of the diff"]}'),
    'Validation Failed one pending review per pull request line must be part of the diff');
  assert.equal(errorDetail('not json'), '');
});

test('groups PRs by role, opens a worktree on click and the browser from the inline action', async (t) => {
  window.trees.length = 0;
  env.opened.length = 0;
  const provider: Forge = {
  ...mockPullRequestProvider,
    readRepository: async () => ({ name: 'acme/app', url: 'https://github.com/acme/app' }),
    listMine: async () => [],
    listReviewRequested: async () => [summary],
    listFiles: async () => [{ path: 'src/sidebar.ts', additions: 3, deletions: 1, change: 'modified' }, { path: 'README.md', additions: 1, deletions: 0, change: 'added' }],
    checkout: async () => undefined,
    viewedFiles: async () => new Set(),
    setViewed: async () => undefined,
    publishComment: async () => { throw new Error('not used'); },
    details: async () => { throw new Error('not used'); },
    threads: async () => [],
    overview: async () => { throw new Error('not used'); },
    replyToThread: async () => { throw new Error('not used'); },
    resolveThread: async () => { throw new Error('not used'); },
    deleteComment: async () => { throw new Error('not used'); },
    submitReview: async () => { throw new Error('not used'); },
    merge: async () => { throw new Error('not used'); },
    editPullRequest: async () => { throw new Error('not used'); },
    setDraft: async () => { throw new Error('not used'); },
    requestReviewers: async () => { throw new Error('not used'); },
    removeReviewers: async () => { throw new Error('not used'); },
    deleteBranch: async () => { throw new Error('not used'); },
    pickerOptions: async () => { throw new Error('not used'); },
  };
  const worktrees = recordingWorktrees();
  const settings = new FakeMemento();
  const view = registerPullRequestView(async () => [{ folder: 'app', connect: async () => provider, worktrees }], noStatusChanges, settings, new FakeMemento());
  t.after(() => { view.dispose(); });
  const tree = window.trees.at(-1)?.provider as vscode.TreeDataProvider<unknown>;

  const roleRows = await level(tree);
  assert.deepEqual(roleRows.map(({ item }) => [item.label, item.description]), [['REVIEW REQUESTED', '1'], ['MINE', '0'], ['ALL OPEN', '0']]);
  const [empty] = await level(tree, roleRows[1]?.node);
  assert.equal(empty?.item.label, 'No open PRs');
  const [repository] = await level(tree, roleRows[0]?.node);
  assert.deepEqual([repository?.item.label, repository?.item.description], ['app', 'acme · 1']);
  const [pr] = await level(tree, repository?.node);
  assert.equal(pr?.item.label, 'Add review sidebar');
  assert.equal(pr?.item.description, '#7 · octo');
  const icon = pr?.item.iconPath as vscode.ThemeIcon;
  assert.deepEqual([icon.id, icon.color?.id], ['diffguide-draft-pull-request', 'descriptionForeground']);
  const decoratePullRequest = (item: vscode.TreeItem | undefined) => window.fileDecorations.at(-1)?.provideFileDecoration(item?.resourceUri as vscode.Uri, undefined as never) as { badge?: string; color?: vscode.ThemeColor } | undefined;
  assert.equal(decoratePullRequest(pr?.item), undefined);

  assert.equal(pr?.item.contextValue, 'diffGuide.pullRequest');
  assert.equal(pr?.item.collapsibleState, 0);

  const command = pr?.item.command as vscode.Command;
  await commands.executeCommand(command.command, ...(command.arguments ?? []));
  assert.deepEqual(worktrees.opened, ['acme/app#7:reviewer']);
  const [reopened] = await level(tree, repository?.node);
  assert.equal(reopened?.item.contextValue, 'diffGuide.pullRequest.checkedOut');
  assert.deepEqual([decoratePullRequest(reopened?.item)?.badge, decoratePullRequest(reopened?.item)?.color], ['W', undefined]);

  const legend = await level(window.trees.at(-2)?.provider as vscode.TreeDataProvider<unknown>);
  assert.deepEqual(legend.map(({ item }) => [item.label, (item.iconPath as vscode.ThemeIcon).id]), [
    ['Repository', 'diffguide-repository'], ['Open', 'diffguide-pull-request'], ['Draft', 'diffguide-draft-pull-request'], ['Merged', 'diffguide-merge'], ['Awaiting review', 'diffguide-show'],
    ['Approved', 'diffguide-ready'], ['Changes requested', 'diffguide-request-changes'], ['Commented', 'diffguide-comment'],
    ['Commits not pushed to GitHub', 'diffguide-pull-request'], ['Uncommitted edits', 'diffguide-pull-request'], ['Checked out in a worktree', 'diffguide-pull-request'],
  ]);
  assert.deepEqual(legend.slice(-3).map(({ item }) => [decoratePullRequest(item)?.badge, decoratePullRequest(item)?.color?.id]), [['↑1', 'charts.orange'], ['✎', 'charts.yellow'], ['W', undefined]]);

  await commands.executeCommand('diffGuide.openPullRequestInBrowser', pr?.node);
  assert.deepEqual(env.opened.map(String), ['https://github.com/acme/app/pull/7']);
  await commands.executeCommand('diffGuide.openPullRequestInBrowser', { kind: 'pullRequest', pullRequest: { url: 'https://evil.example' } });
  await commands.executeCommand('diffGuide.openPullRequest', { kind: 'pullRequest', pullRequest: summary });
  assert.equal(env.opened.length, 1);
  assert.equal(worktrees.opened.length, 1);

  assert.equal(reopened?.item.description, '#7 · octo · 0/2 reviewed');

  worktrees.reviewed.add('README.md');
  await commands.executeCommand('diffGuide.refreshPullRequests');
  const [progressed] = await level(tree, (await level(tree, (await level(tree))[0]?.node))[0]?.node);
  assert.equal(progressed?.item.description, '#7 · octo · 1/2 reviewed');

  await commands.executeCommand('diffGuide.markPullRequestMerged', 'acme/app#7');
  const [merged] = await level(tree, repository?.node);
  assert.equal((merged?.item.iconPath as vscode.ThemeIcon).id, 'diffguide-merge');
  assert.equal(merged?.item.description, '#7 · octo · 1/2 reviewed');
});

test('groups changed files into folders and folds single-folder chains into one row', () => {
  const file = (path: string) => ({ path, change: 'modified' as const, additions: 1, deletions: 0 });
  const root = fileTree([file('Modules/Sources/Todos/Notes/Note.swift'), file('Modules/Sources/Todos/Notes/Link.swift'),
    file('Modules/Sources/Todos/TodoList.swift'), file('Tests/NoteTests.swift'), file('README.md')]);
  const names = (folder: FileFolder<{ readonly path: string }>): unknown => ({ [folder.name]: [...folder.folders.map(names), ...folder.files.map((entry) => entry.path.split('/').at(-1))] });
  assert.deepEqual(names(root), { '': [
    { 'Modules/Sources/Todos': [{ Notes: ['Link.swift', 'Note.swift'] }, 'TodoList.swift'] },
    { Tests: ['NoteTests.swift'] },
    'README.md',
  ] });
  assert.equal(root.folders[0]?.folders[0]?.path, 'Modules/Sources/Todos/Notes');
});

test('shows the CLI error instead of the tree and reloads on refresh', async (t) => {
  window.trees.length = 0;
  let attempts = 0;
  const view = registerPullRequestView(async () => [{ folder: 'app', connect: async () => {
    attempts += 1;
    throw new Error('GitHub CLI was not found.');
  }, worktrees: recordingWorktrees() }], noStatusChanges, new FakeMemento(), new FakeMemento());
  t.after(() => { view.dispose(); });
  const tree = window.trees.at(-1)?.provider as vscode.TreeDataProvider<unknown>;

  const [message] = await level(tree);
  assert.equal(message?.item.label, 'GitHub CLI was not found.');
  await level(tree);
  assert.equal(attempts, 1);
  await commands.executeCommand('diffGuide.refreshPullRequests');
  await level(tree);
  assert.equal(attempts, 2);
});

test('offers GitHub sign-in as the welcome button, or on the repository row when other repositories loaded', async (t) => {
  window.trees.length = 0;
  const signedOut = async (): Promise<Forge> => { throw new GitHubSignInRequired('github'); };
  const loaded = async (): Promise<Forge> => ({
    readRepository: async () => ({ name: 'acme/app', url: 'https://github.com/acme/app' }), listMine: async () => [summary], listReviewRequested: async () => [],
    openCount: async () => 0,
  } as unknown as Forge);
  let checkouts = [{ folder: 'app', connect: signedOut, worktrees: recordingWorktrees() }];
  const settings = new FakeMemento();
  await settings.update('diffGuide.groupBy', 'repository');
  const view = registerPullRequestView(async () => checkouts, noStatusChanges, settings, new FakeMemento());
  t.after(() => { view.dispose(); });
  const tree = window.trees.at(-1)?.provider as vscode.TreeDataProvider<unknown>;

  assert.deepEqual(await level(tree), []);
  checkouts = [{ folder: 'app', connect: loaded, worktrees: recordingWorktrees() }, { folder: 'enterprise', connect: signedOut, worktrees: recordingWorktrees() }];
  await commands.executeCommand('diffGuide.refreshPullRequests');
  const row = (await level(tree)).at(-1)?.item;
  assert.equal(row?.label, 'enterprise: Sign in to GitHub to load pull requests.');
  assert.deepEqual(row?.command, { command: 'diffGuide.signInToGitHub', title: 'Sign in to GitHub', arguments: ['github'] });
});

test('lists repositories with PRs, routes actions to the PR\'s own repository and hides unticked repositories', async (t) => {
  window.trees.length = 0;
  const listed: string[] = [];
  const connected: string[] = [];
  const provider = (name: string, pullRequests: readonly ChangeRequestSummary[]): Forge => ({
  ...mockPullRequestProvider,
    readRepository: async () => ({ name, url: `https://github.com/${name}` }),
    listMine: async () => pullRequests,
    listReviewRequested: async () => [],
    listFiles: async () => { listed.push(name); return [{ path: `${name.split('/')[1]}.ts`, additions: 1, deletions: 0, change: 'added' }]; },
    checkout: async () => undefined,
    viewedFiles: async () => new Set(),
    setViewed: async () => undefined,
    publishComment: async () => { throw new Error('not used'); },
    details: async () => { throw new Error('not used'); },
    threads: async () => [],
    overview: async () => { throw new Error('not used'); },
    replyToThread: async () => { throw new Error('not used'); },
    resolveThread: async () => { throw new Error('not used'); },
    deleteComment: async () => { throw new Error('not used'); },
    submitReview: async () => { throw new Error('not used'); },
    merge: async () => { throw new Error('not used'); },
    editPullRequest: async () => { throw new Error('not used'); },
    setDraft: async () => { throw new Error('not used'); },
    requestReviewers: async () => { throw new Error('not used'); },
    removeReviewers: async () => { throw new Error('not used'); },
    deleteBranch: async () => { throw new Error('not used'); },
    pickerOptions: async () => { throw new Error('not used'); },
  });
  const connect = (name: string, pullRequests: readonly ChangeRequestSummary[]) => async () => { connected.push(name); return provider(name, pullRequests); };
  const serviceA = recordingWorktrees();
  const serviceB = recordingWorktrees();
  const settings = new FakeMemento();
  await settings.update('diffGuide.groupBy', 'repository');
  const view = registerPullRequestView(async () => [
    { folder: 'service-a', connect: connect('acme/service-a', [summary]), worktrees: serviceA },
    { folder: 'service-b', connect: connect('acme/service-b', [summary]), worktrees: serviceB },
    { folder: 'service-c', connect: connect('acme/service-c', []), worktrees: recordingWorktrees() },
    { folder: 'scratch', connect: async () => { throw new Error('no GitHub remote'); }, worktrees: recordingWorktrees() },
  ], noStatusChanges, settings, new FakeMemento());
  t.after(() => { view.dispose(); });
  const tree = window.trees.at(-1)?.provider as vscode.TreeDataProvider<unknown>;
  const labels = async (): Promise<unknown[]> => (await level(tree)).map(({ item }) => item.label);

  const rows = await level(tree);
  assert.deepEqual(rows.map(({ item }) => [item.label, item.description]), [
    ['service-a', 'acme · 1 mine'], ['service-b', 'acme · 1 mine'], ['scratch: no GitHub remote', undefined],
  ]);
  const pullRequestIn = async (row: number): Promise<{ node: unknown; item: vscode.TreeItem } | undefined> => {
    const sections = await level(tree, rows[row]?.node);
    assert.deepEqual(sections.map(({ item }) => item.label), ['Mine', 'All open']);
    return (await level(tree, sections[0]?.node))[0];
  };
  const firstPr = await pullRequestIn(0);
  const secondPr = await pullRequestIn(1);
  assert.deepEqual([await level(tree, firstPr?.node), await level(tree, secondPr?.node)], [[], []]);
  assert.deepEqual(listed, []);

  const command = secondPr?.item.command as vscode.Command;
  await commands.executeCommand(command.command, ...(command.arguments ?? []));
  assert.deepEqual(serviceB.opened, ['acme/service-b#7:author']);
  assert.deepEqual(serviceA.opened, []);

  assert.equal(rows[0]?.item.contextValue, 'diffGuide.repository');
  await commands.executeCommand('diffGuide.hideRepository', rows[0]?.node);
  assert.deepEqual(await labels(), ['service-b', 'scratch: no GitHub remote']);
  assert.equal(window.trees.at(-1)?.description, '1 hidden');

  window.quickPickIndex = 0;
  await commands.executeCommand('diffGuide.chooseRepositories');
  assert.deepEqual(window.quickPicks.at(-1)?.map(({ label, picked }) => [label, picked]), [
    ['service-a', false], ['service-b', true], ['service-c', true], ['scratch', true],
  ]);
  assert.deepEqual(await labels(), ['service-a']);
  assert.equal(window.trees.at(-1)?.description, '3 hidden');
  assert.deepEqual(connected, ['acme/service-a', 'acme/service-b', 'acme/service-c']);

  await commands.executeCommand('diffGuide.groupByRole');
  assert.deepEqual(await labels(), ['REVIEW REQUESTED', 'MINE', 'ALL OPEN']);
});

test('reads GitHub repositories from remote URLs and picks the remote GitHub CLI would use', () => {
  assert.deepEqual(parseGitRemote('git@github.com:acme/app.git'), { host: 'github.com', owner: 'acme', name: 'app' });
  assert.deepEqual(parseGitRemote('https://github.com/acme/app'), { host: 'github.com', owner: 'acme', name: 'app' });
  assert.deepEqual(parseGitRemote('https://token@GitHub.example.com/acme/app.git/'), { host: 'github.example.com', owner: 'acme', name: 'app' });
  assert.deepEqual(parseGitRemote('ssh://git@github.com:22/acme/app.git'), { host: 'github.com', owner: 'acme', name: 'app' });
  assert.equal(parseGitRemote('/srv/git/app.git'), undefined);
  assert.equal(parseGitRemote('https://github.com/acme/app/extra'), undefined);

  const remotes = 'remote.origin.url git@github.com:me/app.git\nremote.upstream.url https://github.com/acme/app.git\nremote.backup.url https://github.com/old/app.git';
  assert.deepEqual(pickGitHubRemote(remotes), { host: 'github.com', owner: 'acme', name: 'app' });
  assert.deepEqual(pickGitHubRemote(`${remotes}\nremote.origin.gh-resolved base`), { host: 'github.com', owner: 'me', name: 'app' });
  assert.deepEqual(pickGitHubRemote('remote.origin.url /srv/git/app.git\nremote.mirror.url git@github.com:acme/mirror.git'), { host: 'github.com', owner: 'acme', name: 'mirror' });
  assert.equal(pickGitHubRemote(''), undefined);
});

test('groups PR search hits by repository and reads their review verdicts', () => {
  const hit = (repository: string, number: number, reviews: readonly string[] = []) => ({
    number, title: `PR ${number}`, url: `https://github.com/${repository}/pull/${number}`, isDraft: false, headRefName: 'feature', baseRefName: 'main',
    author: number === 3 ? null : { login: 'octo' }, repository: { nameWithOwner: repository }, latestReviews: { nodes: reviews.map((state) => ({ state })) },
  });
  const grouped = groupSearchResults([hit('Acme/App', 1, ['APPROVED']), hit('acme/other', 2)], [hit('acme/app', 3)]);
  assert.deepEqual(grouped.get('acme/app')?.mine.map((pr) => [pr.number, pr.review]), [[1, 'approved']]);
  assert.deepEqual(grouped.get('acme/app')?.reviewRequested.map((pr) => [pr.number, pr.author]), [[3, 'ghost']]);
  assert.deepEqual(grouped.get('acme/other')?.reviewRequested, []);
});

test('shows the last loaded PR lists at once and replaces them when the fresh ones arrive', async (t) => {
  window.trees.length = 0;
  let release: () => void = () => undefined;
  const slow = new Promise<void>((resolve) => { release = resolve; });
  const provider: Forge = {
  ...mockPullRequestProvider,
    readRepository: async () => ({ name: 'acme/app', url: 'https://github.com/acme/app' }),
    listMine: async () => { await slow; return [{ ...summary, number: 8, title: 'feat(ui): Fresh' }]; },
    listReviewRequested: async () => [],
  } as unknown as Forge;
  const workspace = new FakeMemento();
  await workspace.update('diffGuide.pullRequestSnapshot', { app: { repository: { name: 'acme/app', url: 'https://github.com/acme/app' }, mine: [summary], reviewRequested: [] } });
  const view = registerPullRequestView(async () => [{ folder: 'app', connect: async () => provider, worktrees: recordingWorktrees() }], noStatusChanges, new FakeMemento(), workspace);
  t.after(() => { view.dispose(); });
  const tree = window.trees.at(-1)?.provider as vscode.TreeDataProvider<unknown>;
  const titles = async (): Promise<unknown[]> => {
    const [mine] = (await level(tree)).slice(1);
    const [repository] = await level(tree, mine?.node);
    return (await level(tree, repository?.node)).map(({ item }) => [item.label, item.description]);
  };

  assert.deepEqual(await titles(), [['Add review sidebar', '#7']]);
  assert.equal(window.trees.at(-1)?.message, 'Updating pull requests...');
  release();
  await settle();
  assert.deepEqual(await titles(), [['Fresh', '#8']]);
  assert.equal(window.trees.at(-1)?.message, '');
  assert.deepEqual((workspace.get('diffGuide.pullRequestSnapshot') as Record<string, { mine: { number: number }[] }>)['app']?.mine.map((pr) => pr.number), [8]);

  await commands.executeCommand('diffGuide.refreshPullRequests');
  const [mine] = (await level(tree)).slice(1);
  const [repository] = await level(tree, mine?.node);
  const rows = await level(tree, repository?.node);
  assert.equal(window.trees.at(-1)?.message, '', 'a reload keeps the rows in place instead of adding a message above them');
  assert.deepEqual(rows.map(({ item }) => item.id), ['pullRequest:author:app:8']);
});

test('reads a PR\'s reviewed files once for its row, and redraws only that PR when its status changes', async (t) => {
  window.trees.length = 0;
  const provider = {
    readRepository: async () => ({ name: 'acme/app', url: 'https://github.com/acme/app' }),
    listMine: async () => [summary],
    listReviewRequested: async () => [],
    listFiles: async () => [{ path: 'a.ts', additions: 1, deletions: 0, change: 'added' }, { path: 'b.ts', additions: 1, deletions: 0, change: 'added' }],
    openCount: async () => 0,
  } as unknown as Forge;
  const worktrees = recordingWorktrees();
  worktrees.checkedOut.add(7);
  let reads = 0;
  const reviewedFiles = worktrees.reviewedFiles;
  worktrees.reviewedFiles = async (...arguments_) => { reads += 1; return await reviewedFiles(...arguments_); };
  const status = new EventEmitter<string | undefined>();
  const settings = new FakeMemento();
  await settings.update('diffGuide.groupBy', 'repository');
  const view = registerPullRequestView(async () => [{ folder: 'app', connect: async () => provider, worktrees }], status.event, settings, new FakeMemento());
  t.after(() => { view.dispose(); });
  const tree = window.trees.at(-1)?.provider as vscode.TreeDataProvider<unknown>;
  const redrawn: unknown[] = [];
  tree.onDidChangeTreeData?.((node) => { redrawn.push(node); });

  const [repository] = await level(tree);
  const [section] = await level(tree, repository?.node);
  const [pr] = await level(tree, section?.node);
  assert.equal(pr?.item.description, '#7 · 0/2 reviewed');
  assert.deepEqual(await level(tree, pr?.node), []);
  assert.equal(reads, 1);

  worktrees.reviewed.add('a.ts');
  status.fire('acme/app#7');
  assert.deepEqual(redrawn, [[pr?.node]]);
  assert.equal((await tree.getTreeItem(pr?.node))?.description, '#7 · 1/2 reviewed');
  assert.equal(reads, 2);

  status.fire('acme/other#1');
  assert.deepEqual(redrawn, [[pr?.node], undefined]);
});

test('shows unpushed commits and uncommitted edits on a checked-out PR row', async (t) => {
  window.trees.length = 0;
  const provider = {
    readRepository: async () => ({ name: 'acme/app', url: 'https://github.com/acme/app' }),
    listMine: async () => [summary],
    listReviewRequested: async () => [],
    listFiles: async () => [{ path: 'src/a.ts', additions: 1, deletions: 0, change: 'added' }],
    openCount: async () => 0,
  } as unknown as Forge;
  const worktrees = recordingWorktrees();
  worktrees.checkedOut.add(7);
  worktrees.localChanges = async () => ({ commits: 2, files: new Map([['src/a.ts', 'both' as const]]) });
  const settings = new FakeMemento();
  await settings.update('diffGuide.groupBy', 'repository');
  const view = registerPullRequestView(async () => [{ folder: 'app', connect: async () => provider, worktrees }], noStatusChanges, settings, new FakeMemento());
  t.after(() => { view.dispose(); });
  const tree = window.trees.at(-1)?.provider as vscode.TreeDataProvider<unknown>;

  const decorate = (item: vscode.TreeItem | undefined) => {
    const decoration = window.fileDecorations.at(-1)?.provideFileDecoration(item?.resourceUri as vscode.Uri, undefined as never) as { badge?: string; color?: vscode.ThemeColor } | undefined;
    return [decoration?.badge, decoration?.color?.id];
  };
  const rows = async () => {
    const [repository] = await level(tree);
    const [section] = await level(tree, repository?.node);
    return { repository, pr: (await level(tree, section?.node))[0] };
  };

  const { repository, pr } = await rows();
  assert.equal(repository?.item.description, 'acme · 1 mine · 1 to push');
  assert.equal(pr?.item.description, '#7 · ✎1 · 0/1 reviewed');
  assert.deepEqual(decorate(pr?.item), ['↑2', 'charts.orange']);
  assert.match(String(pr?.item.tooltip), /\n2 commits not pushed to GitHub\n1 file with uncommitted edits\nDraft$/u);
  assert.deepEqual(await level(tree, pr?.node), []);

  worktrees.localChanges = async () => ({ commits: 12, files: new Map() });
  await commands.executeCommand('diffGuide.refreshPullRequests');
  assert.deepEqual(decorate((await rows()).pr?.item), ['↑+', 'charts.orange']);

  worktrees.localChanges = async () => ({ commits: 0, files: new Map([['src/a.ts', 'edited' as const]]) });
  await commands.executeCommand('diffGuide.refreshPullRequests');
  const edited = await rows();
  assert.equal(edited.repository?.item.description, 'acme · 1 mine');
  assert.equal(edited.pr?.item.description, '#7 · 0/1 reviewed');
  assert.deepEqual(decorate(edited.pr?.item), ['✎', 'charts.yellow']);
});

test('filters PRs by author and shows their size and dates', async (t) => {
  window.trees.length = 0;
  const pr = (number: number, author: string): ChangeRequestSummary => ({
    ...summary, number, author, draft: false, createdAt: '2026-11-01T10:00:00Z', updatedAt: new Date(Date.now() - 2 * 3_600_000).toISOString(),
    changes: { additions: 312, deletions: 48, files: 14 },
  });
  const provider = {
    readRepository: async () => ({ name: 'acme/app', url: 'https://github.com/acme/app' }),
    listMine: async () => [],
    listReviewRequested: async () => [pr(7, 'octo'), pr(8, 'alice')],
    openCount: async () => 0,
  } as unknown as Forge;
  const settings = new FakeMemento();
  await settings.update('diffGuide.groupBy', 'repository');
  const workspace = new FakeMemento();
  const view = registerPullRequestView(async () => [{ folder: 'app', connect: async () => provider, worktrees: recordingWorktrees() }], noStatusChanges, settings, workspace);
  t.after(() => { view.dispose(); });
  const registered = window.trees.at(-1);
  const tree = registered?.provider as vscode.TreeDataProvider<unknown>;
  const rows = async () => {
    const [repository] = await level(tree);
    const [section] = await level(tree, repository?.node);
    return await level(tree, section?.node);
  };

  const [first] = await rows();
  assert.equal(first?.item.description, '#7 · octo');
  assert.match(String(first?.item.tooltip), /\+312 −48 in 14 files\nOpened .+, updated 2h ago$/u);

  window.quickPickIndex = 2;
  await commands.executeCommand('diffGuide.filterByAuthor');
  assert.deepEqual(window.quickPicks.at(-1), ['$(clear-all) All authors', 'alice', 'octo']);
  assert.deepEqual((await rows()).map(({ item }) => item.description), ['#7 · octo']);
  assert.equal(registered?.description, 'Author: octo');

  window.quickPickIndex = 0;
  await commands.executeCommand('diffGuide.filterByAuthorActive');
  assert.equal((await rows()).length, 2);
  assert.equal(workspace.get('diffGuide.authorFilter'), undefined);
});


test('pins PRs above the role sections in the dragged order and drops them once GitHub reports them closed', async (t) => {
  window.trees.length = 0;
  const pr = (number: number, title: string): ChangeRequestSummary => ({ ...summary, number, title, draft: false });
  let reviewRequested = [pr(1, 'One'), pr(2, 'Two'), pr(3, 'Three')];
  let open = new Set<number>();
  const asked: number[][] = [];
  const provider = {
    ...mockPullRequestProvider,
    readRepository: async () => ({ name: 'acme/app', url: 'https://github.com/acme/app' }),
    listMine: async () => [],
    listReviewRequested: async () => reviewRequested,
    openPullRequests: async (numbers: readonly number[]) => {
      asked.push([...numbers]);
      return numbers.filter((number) => open.has(number)).map((number) => pr(number, `Still open ${number}`));
    },
    openCount: async () => 0,
  } as unknown as Forge;
  const workspace = new FakeMemento();
  const view = registerPullRequestView(async () => [{ folder: 'app', connect: async () => provider, worktrees: recordingWorktrees() }], noStatusChanges, new FakeMemento(), workspace);
  t.after(() => { view.dispose(); });
  const fake = window.trees.at(-1);
  const tree = fake?.provider as vscode.TreeDataProvider<unknown>;
  const reviewRows = async () => {
    const roles = await level(tree);
    const review = roles.find(({ item }) => item.label === 'REVIEW REQUESTED');
    const [repository] = await level(tree, review?.node);
    return repository === undefined ? [] : await level(tree, repository.node);
  };
  const shown = async () => {
    const roles = await level(tree);
    const pinned = roles[0]?.item.label === 'BOOKMARKS' ? await level(tree, roles[0].node) : [];
    return {
      roles: roles.map(({ item }) => `${String(item.label)} ${String(item.description)}`),
      pinned: pinned.map(({ item }) => `${String(item.label)} · ${String(item.description)} · ${String(item.contextValue)}`),
    };
  };

  const [one, two, three] = await reviewRows();
  await commands.executeCommand('diffGuide.pinPullRequest', three?.node);
  await commands.executeCommand('diffGuide.pinPullRequest', one?.node);
  assert.deepEqual(await shown(), {
    roles: ['BOOKMARKS 2', 'REVIEW REQUESTED 1', 'MINE 0', 'ALL OPEN 0'],
    pinned: ['Three · #3 · app · review · octo · diffGuide.pullRequest.pinned', 'One · #1 · app · review · octo · diffGuide.pullRequest.pinned'],
  });
  assert.deepEqual((await reviewRows()).map(({ item }) => item.label), ['Two']);

  const [pinnedThree, pinnedOne] = await level(tree, (await level(tree))[0]?.node);
  const drag = async (nodes: unknown[], target: unknown): Promise<void> => {
    const data = new DataTransfer();
    await fake?.dragAndDrop?.handleDrag?.(nodes, data as unknown as vscode.DataTransfer, undefined as never);
    await fake?.dragAndDrop?.handleDrop?.(target, data as unknown as vscode.DataTransfer, undefined as never);
  };
  await drag([pinnedOne?.node], pinnedThree?.node);
  assert.deepEqual((await shown()).pinned.map((row) => row.split(' · ')[0]), ['One', 'Three']);
  await drag([two?.node], (await level(tree))[0]?.node);
  assert.deepEqual((await shown()).pinned.map((row) => row.split(' · ')[0]), ['One', 'Three', 'Two']);
  assert.deepEqual((await shown()).roles, ['BOOKMARKS 3', 'REVIEW REQUESTED 0', 'MINE 0', 'ALL OPEN 0']);

  await commands.executeCommand('diffGuide.unpinPullRequest', (await level(tree, (await level(tree))[0]?.node))[2]?.node);
  assert.deepEqual((await shown()).roles, ['BOOKMARKS 2', 'REVIEW REQUESTED 1', 'MINE 0', 'ALL OPEN 0']);

  reviewRequested = [pr(2, 'Two')];
  open = new Set([1]);
  await commands.executeCommand('diffGuide.refreshPullRequests');
  await level(tree);
  await settle();
  assert.deepEqual(await shown(), {
    roles: ['BOOKMARKS 1', 'REVIEW REQUESTED 1', 'MINE 0', 'ALL OPEN 0'],
    pinned: ['Still open 1 · #1 · app · review · octo · diffGuide.pullRequest.pinned'],
  });
  assert.deepEqual(asked, [[1, 3]]);

  await commands.executeCommand('diffGuide.markPullRequestMerged', 'acme/app#1');
  await settle();
  assert.deepEqual((await shown()).roles, ['REVIEW REQUESTED 1', 'MINE 0', 'ALL OPEN 0']);
});

test('reads a PR from a GitHub link with any tab, comment anchor or query, or from owner/repo#57', () => {
  const pr = { host: 'github.com', owner: 'acme', name: 'app', number: 57 };
  for (const link of [
    'https://github.com/acme/app/pull/57', 'https://github.com/acme/app/pull/57/', 'https://github.com/acme/app/pull/57/files',
    'https://github.com/acme/app/pull/57/commits/abc123', 'https://github.com/acme/app/pull/57#discussion_r123', 'https://github.com/acme/app/pull/57?w=1',
    '  https://GitHub.com/acme/app/pull/57/files#diff-1  ', 'github.com/acme/app/pull/57',
  ]) assert.deepEqual(parsePullRequestLink(link), pr, link);
  assert.deepEqual(parsePullRequestLink('https://github.example.com/acme/app/pull/57'), { ...pr, host: 'github.example.com' });
  assert.deepEqual(parsePullRequestLink('acme/app#57'), { owner: 'acme', name: 'app', number: 57 });
  for (const link of ['https://github.com/acme/app/issues/57', 'https://github.com/acme/app/pull/', 'https://github.com/acme/app/pull/0', 'acme#57', 'https://github.com/acme/app/pull/57x', '']) {
    assert.equal(parsePullRequestLink(link), undefined, link);
  }
});

test('reads pending reviewers and whether a review request reached the viewer directly or through a team', () => {
  const requests = (...reviewers: unknown[]) => ({ nodes: reviewers.map((requestedReviewer) => ({ requestedReviewer })) });
  const hit = (number: number, reviewRequests: unknown) => ({
    number, title: `PR ${number}`, url: `https://github.com/acme/app/pull/${number}`, isDraft: false, headRefName: 'feature', baseRefName: 'main',
    author: { login: 'octo' }, repository: { nameWithOwner: 'acme/app' }, reviewRequests,
  });
  const grouped = groupSearchResults(
    [hit(1, requests({ __typename: 'User', login: 'alice' }, { __typename: 'Team', name: 'Core' }, null, {})), hit(2, requests())],
    [hit(3, requests({ __typename: 'User', login: 'Me' }, { __typename: 'Team', name: 'Core' })), hit(4, requests({ __typename: 'Team', name: 'Core' })), hit(5, undefined)],
    'me',
  ).get('acme/app');
  assert.deepEqual(grouped?.mine.map((pr) => pr.requestedReviewers), [[{ name: 'alice', team: false }, { name: 'Core', team: true }], undefined]);
  assert.deepEqual(grouped?.reviewRequested.map((pr) => pr.requestedVia), ['you', 'team', undefined]);
});

test('marks my PRs awaiting review, filters Mine to them, tells direct from team requests, and copies a PR link', async (t) => {
  window.trees.length = 0;
  env.clipboard.writes.length = 0;
  const waiting: ChangeRequestSummary = { ...summary, number: 8, draft: false, requestedReviewers: [{ name: 'alice', team: false }, { name: 'Core', team: true }] };
  const idle: ChangeRequestSummary = { ...summary, number: 9, draft: false };
  const provider = {
    ...mockPullRequestProvider,
    readRepository: async () => ({ name: 'acme/app', url: 'https://github.com/acme/app' }),
    listMine: async () => [waiting, idle],
    listReviewRequested: async () => [{ ...summary, number: 10, requestedVia: 'you' }, { ...summary, number: 11, requestedVia: 'team', requestedReviewers: [{ name: 'Core', team: true }] }],
  } as unknown as Forge;
  const settings = new FakeMemento();
  await settings.update('diffGuide.groupBy', 'repository');
  const view = registerPullRequestView(async () => [{ folder: 'app', connect: async () => provider, worktrees: recordingWorktrees() }], noStatusChanges, settings, new FakeMemento());
  t.after(() => { view.dispose(); });
  const tree = window.trees.at(-1)?.provider as vscode.TreeDataProvider<unknown>;
  const sections = async () => level(tree, (await level(tree))[0]?.node);

  const [review, mine] = await sections();
  const reviewRows = await level(tree, review?.node);
  assert.deepEqual(reviewRows.map(({ item }) => item.description), ['#10 · Direct · octo', '#11 · via Core · octo']);
  assert.match(String(reviewRows[1]?.item.tooltip), /You were asked through a team/u);
  const mineRows = await level(tree, mine?.node);
  assert.deepEqual(mineRows.map(({ item }) => [item.description, (item.iconPath as vscode.ThemeIcon).id]), [['#8', 'diffguide-show'], ['#9', 'diffguide-pull-request']]);
  assert.match(String(mineRows[0]?.item.tooltip), /Review requested from alice, team Core/u);

  await commands.executeCommand('diffGuide.showAwaitingReviewOnly');
  assert.deepEqual((await level(tree, (await sections())[1]?.node)).map(({ item }) => String(item.description).split(' · ')[0]), ['#8']);
  assert.equal(window.trees.at(-1)?.description, 'Awaiting review');
  await commands.executeCommand('diffGuide.showAllMine');
  assert.equal((await level(tree, (await sections())[1]?.node)).length, 2);

  await commands.executeCommand('diffGuide.copyPullRequestLink', mineRows[0]?.node);
  await commands.executeCommand('diffGuide.copyPullRequestLink', { kind: 'pullRequest', pullRequest: { url: 'https://evil.example' } });
  assert.deepEqual(env.clipboard.writes, ['https://github.com/acme/app/pull/7']);
});

test('lists every open PR of a repository under All open only once expanded, with rows that open like the others', async (t) => {
  window.trees.length = 0;
  const searched: string[] = [];
  const provider = {
    ...mockPullRequestProvider,
    readRepository: async () => ({ name: 'acme/app', url: 'https://github.com/acme/app' }),
    listMine: async () => [summary],
    listReviewRequested: async () => [],
    search: async (query: string) => { searched.push(query); return [summary, { ...summary, number: 12, title: 'Someone else', author: 'bob' }]; },
    openCount: async () => 2,
  } as unknown as Forge;
  const worktrees = recordingWorktrees();
  const settings = new FakeMemento();
  await settings.update('diffGuide.groupBy', 'repository');
  const view = registerPullRequestView(async () => [{ folder: 'app', connect: async () => provider, worktrees }], noStatusChanges, settings, new FakeMemento());
  t.after(() => { view.dispose(); });
  const tree = window.trees.at(-1)?.provider as vscode.TreeDataProvider<unknown>;

  const [repository] = await level(tree);
  const groups = await level(tree, repository?.node);
  const allOpen = groups.at(-1);
  assert.deepEqual([allOpen?.item.label, allOpen?.item.description, allOpen?.item.collapsibleState], ['All open', '2', 1]);
  assert.deepEqual(searched, []);
  const rows = await level(tree, allOpen?.node);
  assert.deepEqual(searched, ['is:open sort:updated-desc']);
  assert.deepEqual(rows.map(({ item }) => [item.label, item.contextValue]), [['Add review sidebar', 'diffGuide.pullRequest'], ['Someone else', 'diffGuide.pullRequest']]);
  const mineRows = await level(tree, groups[0]?.node);
  const ids = [...mineRows, ...rows].map(({ item }) => item.id);
  assert.equal(new Set(ids).size, ids.length, 'a PR under Mine and All open needs distinct tree ids');
  await level(tree, allOpen?.node);
  assert.equal(searched.length, 1);
  const command = rows[1]?.item.command as vscode.Command;
  await commands.executeCommand(command.command, ...(command.arguments ?? []));
  await commands.executeCommand('diffGuide.openPullRequest', rows[0]?.node);
  assert.deepEqual(worktrees.opened, ['acme/app#12:reviewer', 'acme/app#7:author']);
});

test('opens a PR from a pasted link in the workspace folder of its repository, or says which repository is missing', async (t) => {
  window.trees.length = 0;
  window.errors.length = 0;
  const asked: number[] = [];
  const provider = (name: string) => ({
    ...mockPullRequestProvider,
    readRepository: async () => ({ name, url: `https://github.com/${name}` }),
    listMine: async () => [],
    listReviewRequested: async () => [],
    pullRequest: async (number: number) => { asked.push(number); return number === 57 ? { ...summary, number } : undefined; },
  } as unknown as Forge);
  const other = recordingWorktrees();
  const app = recordingWorktrees();
  const shown: string[] = [];
  app.showOverview = async (_provider, repository, pullRequest, role) => { shown.push(`${repository}#${pullRequest.number}:${role}`); };
  const view = registerPullRequestView(async () => [
    { folder: 'other', connect: async () => provider('acme/other'), worktrees: other },
    { folder: 'app', connect: async () => provider('Acme/App'), worktrees: app },
  ], noStatusChanges, new FakeMemento(), new FakeMemento());
  t.after(() => { view.dispose(); });
  const inputs = [
    'https://github.com/acme/app/pull/57/files#discussion_r1', 'acme/app#58', 'https://github.com/acme/missing/pull/1', 'https://ghe.example.com/acme/app/pull/57', undefined,
  ];
  const original = (window as { showInputBox?: unknown }).showInputBox;
  (window as { showInputBox?: unknown }).showInputBox = async () => inputs.shift();
  t.after(() => { (window as { showInputBox?: unknown }).showInputBox = original; });

  for (let run = 0; run < 5; run += 1) await commands.executeCommand('diffGuide.openPullRequestLink');
  assert.deepEqual(shown, ['Acme/App#57:reviewer']);
  assert.deepEqual(asked, [57, 58]);
  assert.deepEqual(window.errors, [
    'acme/app has no PR #58.',
    'No workspace folder holds acme/missing. Open a clone of it to review #1.',
    'No workspace folder holds acme/app. Open a clone of it to review #57.',
  ]);
});
