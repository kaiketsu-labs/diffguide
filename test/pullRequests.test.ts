import assert from 'node:assert/strict';
import test from 'node:test';
import type * as vscode from 'vscode';

import { parseDetails, parsePickerOptions, parsePullRequestFiles, parsePullRequestList, parseReviewThreads, remoteNameFor } from '../src/pullRequests.js';
import { GitHubSignInRequired, errorDetail, githubEndpoints } from '../src/githubApi.js';
import type { PullRequestProvider, PullRequestSummary } from '../src/pullRequests.js';
import { fileTree, type FileFolder } from '../src/fileTree.js';
import { registerPullRequestView } from '../src/pullRequestView.js';
import { groupSearchResults, parseGitRemote, pickGitHubRemote } from '../src/pullRequests.js';
import type { PullRequestWorktrees } from '../src/pullRequestView.js';
import { EventEmitter, FakeMemento, commands, env, settle, window } from './fakes/vscode.js';

const ghEntry = {
  author: { id: 'MDQ', is_bot: false, login: 'octo', name: 'Octo' },
  baseRefName: 'main', headRefName: 'feature', isDraft: true, number: 7,
  title: 'Add review sidebar', url: 'https://github.com/acme/app/pull/7',
};

const summary: PullRequestSummary = {
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
  assert.deepEqual(githubEndpoints('github.com', undefined), { rest: 'https://api.github.com', graphql: 'https://api.github.com/graphql', authProvider: 'github' });
  assert.deepEqual(githubEndpoints('git.acme.dev', 'https://Git.Acme.dev/'), { rest: 'https://git.acme.dev/api/v3', graphql: 'https://git.acme.dev/api/graphql', authProvider: 'github-enterprise' });
  assert.deepEqual(githubEndpoints('acme.ghe.com', 'https://acme.ghe.com'), { rest: 'https://api.acme.ghe.com', graphql: 'https://api.acme.ghe.com/graphql', authProvider: 'github-enterprise' });
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
    open: async (_provider, repository, pullRequest, role, revealPath) => { opened.push(`${repository}#${pullRequest.number}:${role}${revealPath === undefined ? '' : `@${revealPath}`}`); checkedOut.add(pullRequest.number); },
    remove: async (_repository, number) => { checkedOut.delete(number); },
    showClaude: async () => undefined,
    claudeStatus: () => undefined,
    reviewedFiles: async (_provider, _repository, _number, paths) => new Set(paths.filter((file) => reviewed.has(file))),
    setReviewed: async (_provider, _repository, _number, file, done) => { if (done) reviewed.add(file); else reviewed.delete(file); },
    showOverview: async () => undefined,
    guide: async () => undefined,
    forget: () => undefined,
  };
}

const noStatusChanges: vscode.Event<string | undefined> = () => ({ dispose: () => undefined });

/** Expand a tree level and render its items. */
async function level(provider: vscode.TreeDataProvider<unknown>, node?: unknown): Promise<{ node: unknown; item: vscode.TreeItem }[]> {
  const children = await provider.getChildren(node) ?? [];
  return await Promise.all(children.map(async (child) => ({ node: child, item: await provider.getTreeItem(child) })));
}

test('parses PR details into reviewers, checks and allowed merge methods', () => {
  const details = parseDetails({
    squashMergeAllowed: true, mergeCommitAllowed: false, rebaseMergeAllowed: true, deleteBranchOnMerge: false,
    pullRequest: {
      bodyHTML: '<p>Hi</p>', body: 'Hi', title: 'Add search', state: 'OPEN', isDraft: true, mergeable: 'CONFLICTING', viewerDidAuthor: true,
      viewerCanUpdate: true, isCrossRepository: false, headRef: { id: 'R1' },
      labels: { nodes: [{ name: 'bug', color: 'd73a4a' }, { name: 'bad', color: 'red' }] }, assignees: { nodes: [{ login: 'alice' }, {}] },
      latestOpinionatedReviews: { nodes: [{ state: 'APPROVED', author: { login: 'alice' } }, { state: 'COMMENTED', author: null }] },
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
    reviewers: [{ name: 'alice', state: 'approved' }, { name: 'bob', state: 'requested' }, { name: 'core', state: 'requested', team: 'core-team' }],
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
});

test('reads picker options, with teams only for organizations', () => {
  const repository = { assignableUsers: { nodes: [{ login: 'alice' }] }, labels: { nodes: [{ name: 'bug', color: 'd73a4a' }] } };
  assert.deepEqual(parsePickerOptions({ ...repository, owner: { teams: { nodes: [{ name: 'Core', slug: 'core' }, { name: 'No slug' }] } } }),
    { users: ['alice'], teams: [{ name: 'Core', slug: 'core' }], labels: [{ name: 'bug', color: 'd73a4a' }] });
  assert.deepEqual(parsePickerOptions({ ...repository, owner: {} }).teams, []);
});

test('reads GitHub review threads, using original lines for outdated ones and skipping file-level threads', () => {
  const comment = (login: string | null, body: string, url = 'https://github.com/acme/app/pull/7#discussion_r1', state = 'SUBMITTED') => ({ id: 'C-' + body, viewerCanDelete: login === 'alice', url, bodyHTML: `<p>${body}</p>`, state, createdAt: login === null ? undefined : '2026-01-02T03:04:05Z', author: login === null ? null : { login, avatarUrl: `https://avatars.githubusercontent.com/${login}` } });
  const threads = parseReviewThreads([
    { id: 'T1', path: 'src/a.ts', diffSide: 'RIGHT', line: 12, startLine: 10, originalLine: 3, originalStartLine: 1, isOutdated: false, isResolved: true,
      comments: { nodes: [comment('alice', 'Why?'), comment(null, 'Because.')] } },
    { id: 'T2', path: 'src/b.ts', diffSide: 'LEFT', line: null, startLine: null, originalLine: 7, originalStartLine: null, isOutdated: true, isResolved: false,
      comments: { nodes: [comment('bob', 'Typo', undefined, 'PENDING')] } },
    { id: 'T3', path: 'README.md', diffSide: 'RIGHT', line: null, startLine: null, originalLine: null, originalStartLine: null, isOutdated: false, isResolved: false,
      comments: { nodes: [comment('bob', 'Whole file')] } },
  ]);
  assert.deepEqual(threads, [
    { id: 'T1', path: 'src/a.ts', side: 'RIGHT', startLine: 10, endLine: 12, outdated: false, resolved: true, pending: false, url: 'https://github.com/acme/app/pull/7#discussion_r1',
      comments: [{ id: 'C-Why?', author: 'alice', avatarUrl: 'https://avatars.githubusercontent.com/alice', pending: false, bodyHtml: '<p>Why?</p>', canDelete: true, createdAt: '2026-01-02T03:04:05Z' }, { id: 'C-Because.', author: 'ghost', avatarUrl: '', pending: false, bodyHtml: '<p>Because.</p>', canDelete: false, createdAt: '' }] },
    { id: 'T2', path: 'src/b.ts', side: 'LEFT', startLine: 7, endLine: 7, outdated: true, resolved: false, pending: true, url: 'https://github.com/acme/app/pull/7#discussion_r1',
      comments: [{ id: 'C-Typo', author: 'bob', avatarUrl: 'https://avatars.githubusercontent.com/bob', pending: true, bodyHtml: '<p>Typo</p>', canDelete: false, createdAt: '2026-01-02T03:04:05Z' }] },
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
  const provider: PullRequestProvider = {
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
  await settings.update('pairReview.fileView', 'list');
  const view = registerPullRequestView(async () => [{ folder: 'app', connect: async () => provider, worktrees }], noStatusChanges, settings, new FakeMemento());
  t.after(() => { view.dispose(); });
  const tree = window.trees.at(-1)?.provider as vscode.TreeDataProvider<unknown>;

  const roleRows = await level(tree);
  assert.deepEqual(roleRows.map(({ item }) => [item.label, item.description]), [['REVIEW REQUESTED', '1'], ['MINE', '0']]);
  const [empty] = await level(tree, roleRows[1]?.node);
  assert.equal(empty?.item.label, 'No open PRs');
  const [repository] = await level(tree, roleRows[0]?.node);
  assert.deepEqual([repository?.item.label, repository?.item.description], ['app', 'acme · 1']);
  const [pr] = await level(tree, repository?.node);
  assert.equal(pr?.item.label, 'Add review sidebar');
  assert.equal(pr?.item.description, '#7 · octo · Draft');
  const icon = pr?.item.iconPath as vscode.ThemeIcon;
  assert.deepEqual([icon.id, icon.color?.id], ['git-pull-request-draft', 'descriptionForeground']);
  const decoratePullRequest = (item: vscode.TreeItem | undefined) => window.fileDecorations.at(-1)?.provideFileDecoration(item?.resourceUri as vscode.Uri, undefined as never) as { badge?: string; color?: vscode.ThemeColor } | undefined;
  assert.equal(decoratePullRequest(pr?.item), undefined);

  assert.equal(pr?.item.contextValue, 'pairReview.pullRequest');

  const command = pr?.item.command as vscode.Command;
  await commands.executeCommand(command.command, ...(command.arguments ?? []));
  assert.deepEqual(worktrees.opened, ['acme/app#7:reviewer']);
  const [reopened] = await level(tree, repository?.node);
  assert.equal(reopened?.item.contextValue, 'pairReview.pullRequest.checkedOut');
  assert.deepEqual([decoratePullRequest(reopened?.item)?.badge, decoratePullRequest(reopened?.item)?.color], ['W', undefined]);

  const legend = await level(window.trees.at(-2)?.provider as vscode.TreeDataProvider<unknown>);
  assert.deepEqual(legend.map(({ item }) => [item.label, (item.iconPath as vscode.ThemeIcon).id]), [
    ['Repository', 'repo'], ['Open', 'git-pull-request'], ['Draft', 'git-pull-request-draft'], ['Merged', 'git-merge'],
    ['Approved', 'pass'], ['Changes requested', 'request-changes'], ['Commented', 'comment-discussion'], ['Checked out in a worktree', 'git-pull-request'],
  ]);
  assert.equal(decoratePullRequest(legend.at(-1)?.item)?.badge, 'W');

  await commands.executeCommand('pairReview.openPullRequestInBrowser', pr?.node);
  assert.deepEqual(env.opened.map(String), ['https://github.com/acme/app/pull/7']);
  await commands.executeCommand('pairReview.openPullRequestInBrowser', { kind: 'pullRequest', pullRequest: { url: 'https://evil.example' } });
  await commands.executeCommand('pairReview.openPullRequest', { kind: 'pullRequest', pullRequest: summary });
  assert.equal(env.opened.length, 1);
  assert.equal(worktrees.opened.length, 1);

  assert.equal(reopened?.item.description, '#7 · octo · Draft · Worktree · 0/2 reviewed');

  const files = await level(tree, pr?.node);
  assert.deepEqual(files.map(({ item }) => [item.label, item.description, item.checkboxState]), [['sidebar.ts', 'src', 0], ['README.md', '', 0]]);
  const decorate = (index: number) => window.fileDecorations.at(-1)?.provideFileDecoration(files[index]?.item.resourceUri as vscode.Uri, undefined as never) as { badge?: string } | undefined;
  assert.deepEqual([decorate(0)?.badge, decorate(1)?.badge], ['M', 'A']);
  window.trees.at(-1)?.checkboxes.fire({ items: [[files[1]?.node, 1]] });
  await settle();
  assert.deepEqual([...worktrees.reviewed], ['README.md']);
  const [progressed] = await level(tree, repository?.node);
  assert.equal(progressed?.item.description, '#7 · octo · Draft · Worktree · 1/2 reviewed');
  assert.equal((await level(tree, pr?.node))[1]?.item.checkboxState, 1);
  const fileCommand = files[0]?.item.command as vscode.Command;
  await commands.executeCommand(fileCommand.command, ...(fileCommand.arguments ?? []));
  assert.deepEqual(worktrees.opened, ['acme/app#7:reviewer', 'acme/app#7:reviewer@src/sidebar.ts']);

  await commands.executeCommand('pairReview.viewFilesAsTree');
  const tree2 = await level(tree, pr?.node);
  assert.deepEqual(tree2.map(({ item }) => [item.label, item.description]), [['src', undefined], ['README.md', '']]);
  assert.deepEqual((await level(tree, tree2[0]?.node)).map(({ item }) => [item.label, item.description]), [['sidebar.ts', '']]);
  assert.equal(settings.get('pairReview.fileView'), 'tree');

  await commands.executeCommand('pairReview.markPullRequestMerged', 'acme/app#7');
  const [merged] = await level(tree, repository?.node);
  assert.equal((merged?.item.iconPath as vscode.ThemeIcon).id, 'git-merge');
  assert.equal(merged?.item.description, '#7 · octo · Merged · Worktree · 1/2 reviewed');
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
    throw new Error('GitHub CLI wurde nicht gefunden.');
  }, worktrees: recordingWorktrees() }], noStatusChanges, new FakeMemento(), new FakeMemento());
  t.after(() => { view.dispose(); });
  const tree = window.trees.at(-1)?.provider as vscode.TreeDataProvider<unknown>;

  const [message] = await level(tree);
  assert.equal(message?.item.label, 'GitHub CLI wurde nicht gefunden.');
  await level(tree);
  assert.equal(attempts, 1);
  await commands.executeCommand('pairReview.refreshPullRequests');
  await level(tree);
  assert.equal(attempts, 2);
});

test('offers GitHub sign-in as the welcome button, or on the repository row when other repositories loaded', async (t) => {
  window.trees.length = 0;
  const signedOut = async (): Promise<PullRequestProvider> => { throw new GitHubSignInRequired('github'); };
  const loaded = async (): Promise<PullRequestProvider> => ({
    readRepository: async () => ({ name: 'acme/app', url: 'https://github.com/acme/app' }), listMine: async () => [summary], listReviewRequested: async () => [],
  } as unknown as PullRequestProvider);
  let checkouts = [{ folder: 'app', connect: signedOut, worktrees: recordingWorktrees() }];
  const settings = new FakeMemento();
  await settings.update('pairReview.groupBy', 'repository');
  const view = registerPullRequestView(async () => checkouts, noStatusChanges, settings, new FakeMemento());
  t.after(() => { view.dispose(); });
  const tree = window.trees.at(-1)?.provider as vscode.TreeDataProvider<unknown>;

  assert.deepEqual(await level(tree), []);
  checkouts = [{ folder: 'app', connect: loaded, worktrees: recordingWorktrees() }, { folder: 'enterprise', connect: signedOut, worktrees: recordingWorktrees() }];
  await commands.executeCommand('pairReview.refreshPullRequests');
  const row = (await level(tree)).at(-1)?.item;
  assert.equal(row?.label, 'enterprise: Sign in to GitHub to load pull requests.');
  assert.deepEqual(row?.command, { command: 'pairReview.signInToGitHub', title: 'Sign in to GitHub', arguments: ['github'] });
});

test('lists repositories with PRs, routes actions to the PR\'s own repository and hides unticked repositories', async (t) => {
  window.trees.length = 0;
  const listed: string[] = [];
  const connected: string[] = [];
  const provider = (name: string, pullRequests: readonly PullRequestSummary[]): PullRequestProvider => ({
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
  const connect = (name: string, pullRequests: readonly PullRequestSummary[]) => async () => { connected.push(name); return provider(name, pullRequests); };
  const serviceA = recordingWorktrees();
  const serviceB = recordingWorktrees();
  const settings = new FakeMemento();
  await settings.update('pairReview.groupBy', 'repository');
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
    assert.deepEqual(sections.map(({ item }) => item.label), ['Mine']);
    return (await level(tree, sections[0]?.node))[0];
  };
  const firstPr = await pullRequestIn(0);
  const secondPr = await pullRequestIn(1);
  assert.deepEqual((await level(tree, firstPr?.node)).map(({ item }) => item.label), ['service-a.ts']);
  assert.deepEqual((await level(tree, secondPr?.node)).map(({ item }) => item.label), ['service-b.ts']);
  assert.deepEqual(listed, ['acme/service-a', 'acme/service-b']);

  const command = secondPr?.item.command as vscode.Command;
  await commands.executeCommand(command.command, ...(command.arguments ?? []));
  assert.deepEqual(serviceB.opened, ['acme/service-b#7:author']);
  assert.deepEqual(serviceA.opened, []);

  assert.equal(rows[0]?.item.contextValue, 'pairReview.repository');
  await commands.executeCommand('pairReview.hideRepository', rows[0]?.node);
  assert.deepEqual(await labels(), ['service-b', 'scratch: no GitHub remote']);
  assert.equal(window.trees.at(-1)?.description, '1 hidden');

  window.quickPickIndex = 0;
  await commands.executeCommand('pairReview.chooseRepositories');
  assert.deepEqual(window.quickPicks.at(-1)?.map(({ label, picked }) => [label, picked]), [
    ['service-a', false], ['service-b', true], ['service-c', true], ['scratch', true],
  ]);
  assert.deepEqual(await labels(), ['service-a']);
  assert.equal(window.trees.at(-1)?.description, '3 hidden');
  assert.deepEqual(connected, ['acme/service-a', 'acme/service-b', 'acme/service-c']);

  await commands.executeCommand('pairReview.groupByRole');
  assert.deepEqual(await labels(), ['REVIEW REQUESTED', 'MINE']);
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
  const provider: PullRequestProvider = {
    readRepository: async () => ({ name: 'acme/app', url: 'https://github.com/acme/app' }),
    listMine: async () => { await slow; return [{ ...summary, number: 8, title: 'feat(ui): Fresh' }]; },
    listReviewRequested: async () => [],
  } as unknown as PullRequestProvider;
  const workspace = new FakeMemento();
  await workspace.update('pairReview.pullRequestSnapshot', { app: { repository: { name: 'acme/app', url: 'https://github.com/acme/app' }, mine: [summary], reviewRequested: [] } });
  const view = registerPullRequestView(async () => [{ folder: 'app', connect: async () => provider, worktrees: recordingWorktrees() }], noStatusChanges, new FakeMemento(), workspace);
  t.after(() => { view.dispose(); });
  const tree = window.trees.at(-1)?.provider as vscode.TreeDataProvider<unknown>;
  const titles = async (): Promise<unknown[]> => {
    const [mine] = (await level(tree)).slice(1);
    const [repository] = await level(tree, mine?.node);
    return (await level(tree, repository?.node)).map(({ item }) => [item.label, item.description]);
  };

  assert.deepEqual(await titles(), [['Add review sidebar', '#7 · octo · Draft']]);
  assert.equal(window.trees.at(-1)?.message, 'Updating pull requests...');
  release();
  await settle();
  assert.deepEqual(await titles(), [['Fresh', '#8 · feat(ui) · octo · Draft']]);
  assert.equal(window.trees.at(-1)?.message, '');
  assert.deepEqual((workspace.get('pairReview.pullRequestSnapshot') as Record<string, { mine: { number: number }[] }>)['app']?.mine.map((pr) => pr.number), [8]);
});

test('reads a PR\'s reviewed files once for its row and file rows, and redraws only that PR when its status changes', async (t) => {
  window.trees.length = 0;
  const provider = {
    readRepository: async () => ({ name: 'acme/app', url: 'https://github.com/acme/app' }),
    listMine: async () => [summary],
    listReviewRequested: async () => [],
    listFiles: async () => [{ path: 'a.ts', additions: 1, deletions: 0, change: 'added' }, { path: 'b.ts', additions: 1, deletions: 0, change: 'added' }],
  } as unknown as PullRequestProvider;
  const worktrees = recordingWorktrees();
  worktrees.checkedOut.add(7);
  let reads = 0;
  const reviewedFiles = worktrees.reviewedFiles;
  worktrees.reviewedFiles = async (...arguments_) => { reads += 1; return await reviewedFiles(...arguments_); };
  const status = new EventEmitter<string | undefined>();
  const settings = new FakeMemento();
  await settings.update('pairReview.groupBy', 'repository');
  await settings.update('pairReview.fileView', 'list');
  const view = registerPullRequestView(async () => [{ folder: 'app', connect: async () => provider, worktrees }], status.event, settings, new FakeMemento());
  t.after(() => { view.dispose(); });
  const tree = window.trees.at(-1)?.provider as vscode.TreeDataProvider<unknown>;
  const redrawn: unknown[] = [];
  tree.onDidChangeTreeData?.((node) => { redrawn.push(node); });

  const [repository] = await level(tree);
  const [section] = await level(tree, repository?.node);
  const [pr] = await level(tree, section?.node);
  assert.equal(pr?.item.description, '#7 · octo · Draft · Worktree · 0/2 reviewed');
  assert.deepEqual((await level(tree, pr?.node)).map(({ item }) => item.checkboxState), [0, 0]);
  assert.equal(reads, 1);

  worktrees.reviewed.add('a.ts');
  status.fire('acme/app#7');
  assert.deepEqual(redrawn, [pr?.node]);
  assert.equal((await tree.getTreeItem(pr?.node))?.description, '#7 · octo · Draft · Worktree · 1/2 reviewed');
  assert.equal(reads, 2);

  status.fire('acme/other#1');
  assert.deepEqual(redrawn, [pr?.node, undefined]);
});

test('lists a checked-out PR\'s files or its guide steps, and opens the review page at a step', async (t) => {
  window.trees.length = 0;
  const provider = {
    readRepository: async () => ({ name: 'acme/app', url: 'https://github.com/acme/app' }),
    listMine: async () => [summary],
    listReviewRequested: async () => [],
    listFiles: async () => [{ path: 'src/a.ts', additions: 1, deletions: 0, change: 'added' }],
  } as unknown as PullRequestProvider;
  const worktrees = recordingWorktrees();
  worktrees.checkedOut.add(7);
  const shown: (string | undefined)[] = [];
  worktrees.showOverview = async (_provider, _repository, _pullRequest, _role, step) => { shown.push(step); };
  worktrees.guide = async () => [
    { key: 'g0', severity: 'critical', title: 'Auth', steps: [{ key: 'g0.0', path: 'src/a.ts', title: 'Check tokens', note: 'Rejects expired tokens.', viewed: true }, { key: 'g0.1', path: 'src/b.ts', viewed: false }] },
    { key: 'g1', severity: 'trivial', title: 'Format', steps: [{ key: 'g1.0', path: 'README.md', viewed: false }] },
  ];
  const settings = new FakeMemento();
  await settings.update('pairReview.groupBy', 'repository');
  await settings.update('pairReview.fileView', 'list');
  const view = registerPullRequestView(async () => [{ folder: 'app', connect: async () => provider, worktrees }], noStatusChanges, settings, new FakeMemento());
  t.after(() => { view.dispose(); });
  const tree = window.trees.at(-1)?.provider as vscode.TreeDataProvider<unknown>;

  const [repository] = await level(tree);
  const [section] = await level(tree, repository?.node);
  const [pr] = await level(tree, section?.node);
  assert.deepEqual((await level(tree, pr?.node)).map(({ item }) => item.label), ['a.ts']);
  await commands.executeCommand('pairReview.showGuideInTree');
  const groups = await level(tree, pr?.node);
  assert.deepEqual(groups.map(({ item }) => [item.label, item.description, item.collapsibleState]), [['Critical · Auth', '1/2', 2], ['Trivial · Format', '0/1', 1]]);
  const steps = await level(tree, groups[0]?.node);
  assert.deepEqual(steps.map(({ item }) => [item.label, item.description, (item.iconPath as vscode.ThemeIcon).id]), [['1. Check tokens', 'a.ts', 'pass-filled'], ['2. b.ts', 'src', 'circle-large-outline']]);
  const command = steps[0]?.item.command;
  await commands.executeCommand(command?.command ?? '', ...command?.arguments ?? []);
  assert.deepEqual(shown, ['g0.0']);

  worktrees.checkedOut.delete(7);
  view.dispose();
  const unchecked = registerPullRequestView(async () => [{ folder: 'app', connect: async () => provider, worktrees }], noStatusChanges, settings, new FakeMemento());
  t.after(() => { unchecked.dispose(); });
  const fresh = window.trees.at(-1)?.provider as vscode.TreeDataProvider<unknown>;
  const [freshRepository] = await level(fresh);
  const [freshSection] = await level(fresh, freshRepository?.node);
  const [freshPr] = await level(fresh, freshSection?.node);
  assert.deepEqual((await level(fresh, freshPr?.node)).map(({ item }) => item.label), ['a.ts']);
});

test('filters PRs by author and shows their size and dates', async (t) => {
  window.trees.length = 0;
  const pr = (number: number, author: string): PullRequestSummary => ({
    ...summary, number, author, draft: false, createdAt: '2026-11-01T10:00:00Z', updatedAt: new Date(Date.now() - 2 * 3_600_000).toISOString(),
    changes: { additions: 312, deletions: 48, files: 14 },
  });
  const provider = {
    readRepository: async () => ({ name: 'acme/app', url: 'https://github.com/acme/app' }),
    listMine: async () => [],
    listReviewRequested: async () => [pr(7, 'octo'), pr(8, 'alice')],
  } as unknown as PullRequestProvider;
  const settings = new FakeMemento();
  await settings.update('pairReview.groupBy', 'repository');
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
  assert.equal(first?.item.description, '#7 · octo · +312 −48');
  assert.match(String(first?.item.tooltip), /\+312 −48 in 14 files\nOpened .+, updated 2h ago$/u);

  window.quickPickIndex = 2;
  await commands.executeCommand('pairReview.filterByAuthor');
  assert.deepEqual(window.quickPicks.at(-1), ['$(clear-all) All authors', 'alice', 'octo']);
  assert.deepEqual((await rows()).map(({ item }) => item.description), ['#7 · octo · +312 −48']);
  assert.equal(registered?.description, 'Author: octo');

  window.quickPickIndex = 0;
  await commands.executeCommand('pairReview.filterByAuthorActive');
  assert.equal((await rows()).length, 2);
  assert.equal(workspace.get('pairReview.authorFilter'), undefined);
});

