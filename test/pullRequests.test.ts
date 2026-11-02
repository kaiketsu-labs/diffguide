import assert from 'node:assert/strict';
import test from 'node:test';
import type * as vscode from 'vscode';

import { apiErrorDetail, parseDetails, parsePullRequestFiles, parsePullRequestList, parseRepository, parseReviewThreads } from '../src/pullRequests.js';
import type { PullRequestProvider, PullRequestSummary } from '../src/pullRequests.js';
import { fileTree, registerPullRequestView } from '../src/pullRequestView.js';
import type { FileFolder, PullRequestWorktrees } from '../src/pullRequestView.js';
import { FakeMemento, commands, env, settle, window } from './fakes/vscode.js';

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

test('parses the repository and rejects credentials in its link', () => {
  assert.deepEqual(parseRepository({ nameWithOwner: 'acme/app', url: 'https://github.com/acme/app' }), { name: 'acme/app', url: 'https://github.com/acme/app' });
  assert.throws(() => parseRepository({ nameWithOwner: 'acme/app', url: 'https://user:token@github.com/acme/app' }));
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
    forget: () => undefined,
  };
}

const noStatusChanges: vscode.Event<unknown> = () => ({ dispose: () => undefined });

/** Expand a tree level and render its items. */
async function level(provider: vscode.TreeDataProvider<unknown>, node?: unknown): Promise<{ node: unknown; item: vscode.TreeItem }[]> {
  const children = await provider.getChildren(node) ?? [];
  return await Promise.all(children.map(async (child) => ({ node: child, item: await provider.getTreeItem(child) })));
}

test('parses PR details into reviewers, checks and allowed merge methods', () => {
  const details = parseDetails({
    squashMergeAllowed: true, mergeCommitAllowed: false, rebaseMergeAllowed: true,
    pullRequest: {
      bodyHTML: '<p>Hi</p>', state: 'OPEN', mergeable: 'CONFLICTING', viewerDidAuthor: true,
      latestOpinionatedReviews: { nodes: [{ state: 'APPROVED', author: { login: 'alice' } }, { state: 'COMMENTED', author: null }] },
      reviewRequests: { nodes: [{ requestedReviewer: { login: 'bob' } }, { requestedReviewer: { name: 'core' } }, { requestedReviewer: { login: 'alice' } }] },
      commits: { nodes: [{ commit: { statusCheckRollup: { contexts: { nodes: [
        { __typename: 'CheckRun', name: 'build', status: 'COMPLETED', conclusion: 'SUCCESS', detailsUrl: 'https://ci/1' },
        { __typename: 'CheckRun', name: 'test', status: 'IN_PROGRESS', conclusion: null, detailsUrl: 'javascript:alert(1)' },
        { __typename: 'StatusContext', context: 'deploy', state: 'FAILURE', targetUrl: null },
      ] } } } }] },
    },
  });
  assert.deepEqual(details, {
    bodyHtml: '<p>Hi</p>', open: true, mergeable: 'no', viewerIsAuthor: true, mergeMethods: ['squash', 'rebase'],
    reviewers: [{ name: 'alice', state: 'approved' }, { name: 'bob', state: 'requested' }, { name: 'core', state: 'requested' }],
    checks: [{ name: 'build', state: 'success', url: 'https://ci/1' }, { name: 'test', state: 'pending' }, { name: 'deploy', state: 'failure' }],
  });
});

test('reads GitHub review threads, using original lines for outdated ones and skipping file-level threads', () => {
  const comment = (login: string | null, body: string, url = 'https://github.com/acme/app/pull/7#discussion_r1', state = 'SUBMITTED') => ({ url, bodyHTML: `<p>${body}</p>`, state, author: login === null ? null : { login, avatarUrl: `https://avatars.githubusercontent.com/${login}` } });
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
      comments: [{ author: 'alice', avatarUrl: 'https://avatars.githubusercontent.com/alice', pending: false, bodyHtml: '<p>Why?</p>' }, { author: 'ghost', avatarUrl: '', pending: false, bodyHtml: '<p>Because.</p>' }] },
    { id: 'T2', path: 'src/b.ts', side: 'LEFT', startLine: 7, endLine: 7, outdated: true, resolved: false, pending: true, url: 'https://github.com/acme/app/pull/7#discussion_r1',
      comments: [{ author: 'bob', avatarUrl: 'https://avatars.githubusercontent.com/bob', pending: true, bodyHtml: '<p>Typo</p>' }] },
  ]);
  assert.throws(() => parseReviewThreads([{ id: 'T4', path: 'a', line: 1, isOutdated: false, comments: { nodes: [comment('x', 'y', 'javascript:alert(1)')] } }]), /invalid link/u);
});

test('keeps the reasons GitHub gives from a failed API call', () => {
  assert.equal(apiErrorDetail('{"message":"Validation Failed","errors":[{"message":"one pending review per pull request"},"line must be part of the diff"]}'),
    'one pending review per pull request line must be part of the diff');
  assert.equal(apiErrorDetail('not json'), '');
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
    replyToThread: async () => { throw new Error('not used'); },
    resolveThread: async () => { throw new Error('not used'); },
    submitReview: async () => { throw new Error('not used'); },
    merge: async () => { throw new Error('not used'); },
  };
  const worktrees = recordingWorktrees();
  const settings = new FakeMemento();
  await settings.update('localReview.fileView', 'list');
  const view = registerPullRequestView(async () => [{ folder: 'app', connect: async () => provider, worktrees }], noStatusChanges, settings);
  t.after(() => { view.dispose(); });
  const tree = window.trees.at(-1)?.provider as vscode.TreeDataProvider<unknown>;

  const [repository] = await level(tree);
  assert.equal(repository?.item.label, 'acme/app');
  const sections = await level(tree, repository?.node);
  assert.deepEqual(sections.map(({ item }) => [item.label, item.description]), [['Mine', '0'], ['Review requested', '1']]);
  const [empty] = await level(tree, sections[0]?.node);
  assert.equal(empty?.item.label, 'No open PRs');
  const [pr] = await level(tree, sections[1]?.node);
  assert.equal(pr?.item.label, '#7 Add review sidebar');
  assert.equal(pr?.item.description, 'octo · Draft');

  assert.equal(pr?.item.contextValue, 'localReview.pullRequest');

  const command = pr?.item.command as vscode.Command;
  await commands.executeCommand(command.command, ...(command.arguments ?? []));
  assert.deepEqual(worktrees.opened, ['acme/app#7:reviewer']);
  const [reopened] = await level(tree, sections[1]?.node);
  assert.equal(reopened?.item.contextValue, 'localReview.pullRequest.checkedOut');

  await commands.executeCommand('localReview.openPullRequestInBrowser', pr?.node);
  assert.deepEqual(env.opened.map(String), ['https://github.com/acme/app/pull/7']);
  await commands.executeCommand('localReview.openPullRequestInBrowser', { kind: 'pullRequest', pullRequest: { url: 'https://evil.example' } });
  await commands.executeCommand('localReview.openPullRequest', { kind: 'pullRequest', pullRequest: summary });
  assert.equal(env.opened.length, 1);
  assert.equal(worktrees.opened.length, 1);

  assert.equal(reopened?.item.description, 'octo · Draft · Worktree · 0/2 reviewed');

  const files = await level(tree, pr?.node);
  assert.deepEqual(files.map(({ item }) => [item.label, item.description, item.checkboxState]), [['sidebar.ts', 'src', 0], ['README.md', '', 0]]);
  const decorate = (index: number) => window.fileDecorations.at(-1)?.provideFileDecoration(files[index]?.item.resourceUri as vscode.Uri, undefined as never) as { badge?: string } | undefined;
  assert.deepEqual([decorate(0)?.badge, decorate(1)?.badge], ['M', 'A']);
  window.trees.at(-1)?.checkboxes.fire({ items: [[files[1]?.node, 1]] });
  await settle();
  assert.deepEqual([...worktrees.reviewed], ['README.md']);
  const [progressed] = await level(tree, sections[1]?.node);
  assert.equal(progressed?.item.description, 'octo · Draft · Worktree · 1/2 reviewed');
  assert.equal((await level(tree, pr?.node))[1]?.item.checkboxState, 1);
  const fileCommand = files[0]?.item.command as vscode.Command;
  await commands.executeCommand(fileCommand.command, ...(fileCommand.arguments ?? []));
  assert.deepEqual(worktrees.opened, ['acme/app#7:reviewer', 'acme/app#7:reviewer@src/sidebar.ts']);

  await commands.executeCommand('localReview.viewFilesAsTree');
  const tree2 = await level(tree, pr?.node);
  assert.deepEqual(tree2.map(({ item }) => [item.label, item.description]), [['src', undefined], ['README.md', '']]);
  assert.deepEqual((await level(tree, tree2[0]?.node)).map(({ item }) => [item.label, item.description]), [['sidebar.ts', '']]);
  assert.equal(settings.get('localReview.fileView'), 'tree');
});

test('groups changed files into folders and folds single-folder chains into one row', () => {
  const file = (path: string) => ({ path, change: 'modified' as const, additions: 1, deletions: 0 });
  const root = fileTree([file('Modules/Sources/Todos/Notes/Note.swift'), file('Modules/Sources/Todos/Notes/Link.swift'),
    file('Modules/Sources/Todos/TodoList.swift'), file('Tests/NoteTests.swift'), file('README.md')]);
  const names = (folder: FileFolder): unknown => ({ [folder.name]: [...folder.folders.map(names), ...folder.files.map((entry) => entry.path.split('/').at(-1))] });
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
  }, worktrees: recordingWorktrees() }], noStatusChanges, new FakeMemento());
  t.after(() => { view.dispose(); });
  const tree = window.trees.at(-1)?.provider as vscode.TreeDataProvider<unknown>;

  const [message] = await level(tree);
  assert.equal(message?.item.label, 'GitHub CLI wurde nicht gefunden.');
  await level(tree);
  assert.equal(attempts, 1);
  await commands.executeCommand('localReview.refreshPullRequests');
  await level(tree);
  assert.equal(attempts, 2);
});

test('lists every repository, collapses those without PRs and routes actions to the PR\'s own repository', async (t) => {
  window.trees.length = 0;
  const listed: string[] = [];
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
    replyToThread: async () => { throw new Error('not used'); },
    resolveThread: async () => { throw new Error('not used'); },
    submitReview: async () => { throw new Error('not used'); },
    merge: async () => { throw new Error('not used'); },
  });
  const serviceA = recordingWorktrees();
  const serviceB = recordingWorktrees();
  const view = registerPullRequestView(async () => [
    { folder: 'service-a', connect: async () => provider('acme/service-a', [summary]), worktrees: serviceA },
    { folder: 'service-b', connect: async () => provider('acme/service-b', [summary]), worktrees: serviceB },
    { folder: 'service-c', connect: async () => provider('acme/service-c', []), worktrees: recordingWorktrees() },
    { folder: 'scratch', connect: async () => { throw new Error('no GitHub remote'); }, worktrees: recordingWorktrees() },
  ], noStatusChanges, new FakeMemento());
  t.after(() => { view.dispose(); });
  const tree = window.trees.at(-1)?.provider as vscode.TreeDataProvider<unknown>;

  const rows = await level(tree);
  assert.deepEqual(rows.map(({ item }) => [item.label, item.collapsibleState]), [
    ['acme/service-a', 2], ['acme/service-b', 2], ['acme/service-c', 1], ['scratch: no GitHub remote', 0],
  ]);
  const pullRequestIn = async (row: number): Promise<{ node: unknown; item: vscode.TreeItem } | undefined> => {
    const [mine] = await level(tree, rows[row]?.node);
    return (await level(tree, mine?.node))[0];
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
});
