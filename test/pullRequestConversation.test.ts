import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import * as vscode from 'vscode';
import type { ChangeRequestConversation, ChangeRequestDetails, RemoteThread } from '../src/core/forge.js';
import { applyLineSuggestions } from '../src/core/suggestions.js';
import { generatedPaths, readPullRequestDiff } from '../src/core/unifiedDiff.js';
import { parseConversation } from '../src/forges/github/parse.js';
import { showPullRequestOverview } from '../src/hosts/vscode/reviewPanel.js';
import type { OverviewActions, OverviewState } from '../src/page/protocol.js';
import { githubPageActions, type PageContext, suggestionEdits } from '../src/page/pullRequestPageActions.js';
import { EventEmitter, resetFakeWindow, window } from './fakes/vscode.js';

const oid = (digit: string): string => digit.repeat(40);
const author = (login: string) => ({ login, avatarUrl: `https://avatars.githubusercontent.com/${login}` });
const reactions = [{ content: 'HEART', viewerHasReacted: true, reactors: { totalCount: 2 } }, { content: 'EYES', viewerHasReacted: false, reactors: { totalCount: 0 } }, { content: 'NOPE', reactors: { totalCount: 1 } }];

test('reads the Conversation tab: comments, reviews, pushes and events, and the merge box extras', () => {
  const timeline = [
    { __typename: 'IssueComment', id: 'IC1', url: 'https://github.com/acme/app/pull/7#issuecomment-1', body: 'Looks **good**', bodyHTML: '<p>Looks <b>good</b></p>', createdAt: '2026-01-01T00:00:00Z',
      lastEditedAt: '2026-01-02T00:00:00Z', viewerCanUpdate: true, viewerCanDelete: true, viewerCanMinimize: false, viewerCanReact: true, isMinimized: false, author: { ...author('alice'), name: 'Alice' }, reactionGroups: reactions },
    { __typename: 'IssueComment', id: 'IC2', body: 'spam', bodyHTML: '<p>spam</p>', createdAt: '2026-01-01T01:00:00Z', isMinimized: true, minimizedReason: 'OFF_TOPIC', author: null, reactionGroups: [] },
    { __typename: 'PullRequestCommit', id: 'PC1', pushed: { oid: oid('a'), messageHeadline: 'Add feature', messageBody: 'Details', committedDate: '2026-01-01T02:00:00Z', additions: 12, deletions: 3, changedFilesIfAvailable: null, statusCheckRollup: { state: 'FAILURE' }, author: { name: 'Bob B', avatarUrl: '', user: { login: 'bob' } } } },
    { __typename: 'PullRequestCommit', id: 'PC2', pushed: { oid: 'not-an-oid', messageHeadline: 'Broken' } },
    { __typename: 'PullRequestReview', id: 'R1', body: '', bodyHTML: '', state: 'APPROVED', createdAt: '2026-01-01T03:00:00Z', submittedAt: '2026-01-01T03:05:00Z', commit: { oid: oid('a') }, author: author('viewer'), reactionGroups: [],
      comments: { nodes: [{ id: 'RC1' }, { id: 'RC2' }, {}] } },
    { __typename: 'PullRequestReview', id: 'R2', body: 'later', bodyHTML: '<p>later</p>', state: 'PENDING', createdAt: '2026-01-01T04:00:00Z', commit: { oid: oid('b') }, author: author('viewer'), reactionGroups: [] },
    { __typename: 'HeadRefForcePushedEvent', id: 'E1', createdAt: '2026-01-01T05:00:00Z', actor: author('bob'), beforeCommit: { abbreviatedOid: 'aaaaaaa' }, afterCommit: { abbreviatedOid: 'bbbbbbb' } },
    { __typename: 'LabeledEvent', id: 'E2', createdAt: '2026-01-01T06:00:00Z', actor: author('alice'), label: { name: 'bug' } },
    { __typename: 'CrossReferencedEvent', id: 'E3', createdAt: '2026-01-01T07:00:00Z', actor: author('carol'), willCloseTarget: false, source: { number: 12, title: 'Crash on start', repository: { nameWithOwner: 'acme/app' } } },
    { __typename: 'SomethingNew', id: 'E4', createdAt: '2026-01-01T08:00:00Z' },
  ];
  const repository = {
    viewerPermission: 'WRITE', autoMergeAllowed: true, squashMergeCommitTitle: 'PR_TITLE', squashMergeCommitMessage: 'SOMETHING_NEW', mergeCommitTitle: 'MERGE_MESSAGE', mergeCommitMessage: 'PR_BODY',
    pullRequest: {
      id: 'PR_7', viewerCanReact: true, reactionGroups: reactions, mergeStateStatus: 'BLOCKED', reviewDecision: 'REVIEW_REQUIRED', viewerCanUpdateBranch: true, viewerCanMergeAsAdmin: false,
      viewerCanEnableAutoMerge: false, viewerCanDisableAutoMerge: true, isMergeQueueEnabled: true, mergeQueueEntry: { position: 0 }, headRefOid: oid('c'), headRef: null, isCrossRepository: false,
      autoMergeRequest: { mergeMethod: 'SQUASH', enabledBy: { login: 'alice' } },
      closingIssuesReferences: { nodes: [{ number: 12, title: 'Crash on start', url: 'https://github.com/acme/app/issues/12', state: 'OPEN' }, { number: 13, title: 'Bad link', url: 'javascript:alert(1)', state: 'OPEN' }] },
      latestOpinionatedReviews: { nodes: [{ id: 'R1', author: { login: 'viewer' } }, { id: 'R9', author: null }] },
      commits: { nodes: [{ commit: { statusCheckRollup: { contexts: { nodes: [
        { __typename: 'CheckRun', name: 'build', isRequired: true, checkSuite: { workflowRun: { databaseId: 99 } }, annotations: { nodes: [
          { path: 'src/a.ts', annotationLevel: 'FAILURE', title: 'TS2322', message: 'Wrong type', location: { start: { line: 4 }, end: { line: 3 } } },
          { path: 'src/a.ts', annotationLevel: 'FAILURE', message: 'no line', location: { start: {}, end: {} } },
        ] } },
        { __typename: 'StatusContext', context: 'ci/legacy', isRequired: false },
      ] } } } }] },
    },
  };
  const conversation = parseConversation(repository, { login: 'viewer' }, timeline);
  assert.deepEqual(conversation.timeline.map((item) => [item.kind, item.id]), [['comment', 'IC1'], ['comment', 'IC2'], ['commit', 'PC1'], ['review', 'R1'], ['review', 'R2'], ['event', 'E1'], ['event', 'E2'], ['event', 'E3']]);
  const [first, hidden, commit, review] = conversation.timeline;
  assert.deepEqual(first, {
    kind: 'comment', id: 'IC1', author: 'alice', authorName: 'Alice', avatarUrl: 'https://avatars.githubusercontent.com/alice', createdAt: '2026-01-01T00:00:00Z',
    bodyHtml: '<p>Looks <b>good</b></p>', body: 'Looks **good**', url: 'https://github.com/acme/app/pull/7#issuecomment-1', canEdit: true, canDelete: true, canHide: false, canReact: true,
    edited: true, reactions: [{ content: 'HEART', count: 2, viewerReacted: true }],
  });
  assert.equal(hidden?.kind === 'comment' && hidden.author, 'ghost');
  assert.equal(hidden?.kind === 'comment' && hidden.hidden, 'off topic');
  assert.deepEqual(commit, { kind: 'commit', id: 'PC1', oid: oid('a'), headline: 'Add feature', message: 'Details', author: 'bob', avatarUrl: '', createdAt: '2026-01-01T02:00:00Z', checks: 'failure', additions: 12, deletions: 3 });
  assert.equal(review?.kind === 'review' && review.createdAt, '2026-01-01T03:05:00Z');
  assert.deepEqual(review?.kind === 'review' && review.comments, ['RC1', 'RC2']);
  assert.deepEqual(conversation.timeline[4]?.kind === 'review' && conversation.timeline[4].comments, [], 'a review without a comments field has none');
  assert.deepEqual(conversation.timeline.slice(5).map((item) => item.kind === 'event' ? item.text : ''), [
    'force-pushed the branch from aaaaaaa to bbbbbbb', 'added the bug label', 'mentioned this in acme/app#12 Crash on start',
  ]);
  assert.equal(conversation.lastReviewedCommit, oid('a'), 'a pending review is not a review the viewer submitted');
  assert.deepEqual(conversation.description, { id: 'PR_7', reactions: [{ content: 'HEART', count: 2, viewerReacted: true }], canReact: true });
  assert.equal(conversation.permission, 'write');
  assert.deepEqual(conversation.merge, {
    state: 'blocked', reviewDecision: 'required', canUpdateBranch: true, canBypass: false, autoMerge: { method: 'squash', enabledBy: 'alice' },
    canEnableAutoMerge: false, canDisableAutoMerge: true, autoMergeAllowed: true, mergeQueue: true, queuePosition: 1, headOid: oid('c'), headDeleted: true,
  });
  assert.deepEqual(conversation.checks, [
    { name: 'build', required: true, runId: 99, annotations: [{ path: 'src/a.ts', startLine: 4, endLine: 4, level: 'failure', title: 'TS2322', message: 'Wrong type' }] },
    { name: 'ci/legacy', required: false, annotations: [] },
  ]);
  assert.deepEqual(conversation.linkedIssues, [{ number: 12, title: 'Crash on start', url: 'https://github.com/acme/app/issues/12', open: true }]);
  assert.deepEqual(conversation.reviewIds, { viewer: 'R1' });
  assert.deepEqual(conversation.commitDefaults, { squashTitle: 'PR_TITLE', squashBody: 'COMMIT_MESSAGES', mergeTitle: 'MERGE_MESSAGE', mergeBody: 'PR_BODY' });
});

test('applies suggestions bottom-up and refuses overlaps or lines past the end', () => {
  const text = 'one\ntwo\nthree\nfour\n';
  assert.equal(applyLineSuggestions(text, [{ startLine: 1, endLine: 1, code: 'ONE' }, { startLine: 3, endLine: 4, code: 'THREE+FOUR\nextra' }]), 'ONE\ntwo\nTHREE+FOUR\nextra\n');
  assert.equal(applyLineSuggestions('a\r\nb\r\n', [{ startLine: 2, endLine: 2, code: 'B' }]), 'a\r\nB\r\n');
  assert.throws(() => applyLineSuggestions(text, [{ startLine: 1, endLine: 2, code: 'x' }, { startLine: 2, endLine: 3, code: 'y' }]), /same lines/u);
  assert.throws(() => applyLineSuggestions(text, [{ startLine: 9, endLine: 9, code: 'x' }]), /past the end/u);
});

test('takes GitHub suggestions only from current threads with exactly one suggestion and a safe path', () => {
  const comment = (id: string, body: string): RemoteThread['comments'][number] => ({
    id, author: 'bob', avatarUrl: '', createdAt: '', bodyHtml: '', body, canEdit: false, canDelete: false, canHide: false, canReact: false, edited: false, reactions: [], pending: false,
  });
  const thread = (id: string, extra: Partial<RemoteThread>, body = '```suggestion\nfixed\n```'): RemoteThread => ({
    id, path: 'src/a.ts', side: 'RIGHT', startLine: 2, endLine: 3, outdated: false, resolved: false, url: 'https://github.com/acme/app/pull/7#r1', pending: false, comments: [comment('C' + id, body)], ...extra,
  });
  const threads = [thread('1', {}), thread('2', { startLine: 5, endLine: 5 }), thread('3', { outdated: true }), thread('4', {}, 'no suggestion'), thread('5', { path: '../escape.ts' })];
  assert.deepEqual([...suggestionEdits(threads, [{ thread: '1', comment: 'C1' }, { thread: '2', comment: 'C2' }])], [['src/a.ts', [{ startLine: 2, endLine: 3, code: 'fixed' }, { startLine: 5, endLine: 5, code: 'fixed' }]]]);
  assert.throws(() => suggestionEdits(threads, [{ thread: '3', comment: 'C3' }]), /outdated/u);
  assert.throws(() => suggestionEdits(threads, [{ thread: '4', comment: 'C4' }]), /outdated or gone/u);
  assert.throws(() => suggestionEdits(threads, [{ thread: '5', comment: 'C5' }]), /invalid file path/u);
});

test('reads one commit\'s changes, hides whitespace changes and marks generated files', async (t) => {
  const repo = mkdtempSync(join(tmpdir(), 'diffguide-range-'));
  t.after(() => { rmSync(repo, { recursive: true, force: true }); });
  const git = (...args: string[]): string => execFileSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { encoding: 'utf8' }).trim();
  git('init', '--quiet');
  mkdirSync(join(repo, 'dist'));
  writeFileSync(join(repo, '.gitattributes'), 'dist/** linguist-generated\nyarn.lock -linguist-generated\n');
  writeFileSync(join(repo, 'a.ts'), 'const a = 1;\nconst b = 2;\n');
  git('add', '.');
  git('commit', '--quiet', '-m', 'base');
  const base = git('rev-parse', 'HEAD');
  writeFileSync(join(repo, 'a.ts'), 'const a = 1;\nconst b = 3;\n');
  writeFileSync(join(repo, 'dist', 'out.js'), 'x();\n');
  writeFileSync(join(repo, 'package-lock.json'), '{}\n');
  writeFileSync(join(repo, 'yarn.lock'), '# lock\n');
  git('add', '.');
  git('commit', '--quiet', '-m', 'first');
  const first = git('rev-parse', 'HEAD');
  writeFileSync(join(repo, 'a.ts'), 'const a  =  1;\nconst b = 4;\n');
  git('commit', '--quiet', '-am', 'second');

  const only = await readPullRequestDiff(repo, base, { to: first });
  assert.deepEqual(only.map((file) => [file.path, file.generated === true]), [['a.ts', false], ['dist/out.js', true], ['package-lock.json', true], ['yarn.lock', false]]);
  assert.ok(only[0]?.hunks.flatMap((hunk) => hunk.lines).some((line) => line.kind === 'add' && line.html.includes('3')), 'the new side is the commit, not the worktree');

  const all = await readPullRequestDiff(repo, first);
  const quiet = await readPullRequestDiff(repo, first, { ignoreWhitespace: true });
  assert.equal(all[0]?.additions, 2);
  assert.equal(quiet[0]?.additions, 1);
  assert.deepEqual([...await generatedPaths(repo, ['src/x.min.js', 'Cargo.lock', 'src/app.ts'])], ['src/x.min.js', 'Cargo.lock']);
});

const details: ChangeRequestDetails = {
  title: 'PR', body: '', bodyHtml: '', open: true, merged: false, draft: false, canEdit: true, branchDeletable: false, labels: [], assignees: [], reviewers: [],
  mergeable: 'yes', viewerIsAuthor: false, viewerAvatarUrl: '', mergeMethods: ['squash'], checks: [],
};
const conversation: ChangeRequestConversation = {
  timeline: [
    { kind: 'commit', id: 'PC1', oid: oid('a'), headline: 'One', message: '', author: 'bob', avatarUrl: '', createdAt: '' },
    { kind: 'comment', id: 'IC1', author: 'bob', avatarUrl: '', createdAt: '', bodyHtml: '', body: 'x', canEdit: false, canDelete: false, canHide: false, canReact: true, edited: false, reactions: [] },
  ],
  description: { id: 'PR_7', reactions: [], canReact: true }, viewerLogin: 'viewer', permission: 'read',
  merge: { state: 'clean', canUpdateBranch: false, canBypass: false, canEnableAutoMerge: false, canDisableAutoMerge: false, autoMergeAllowed: false, mergeQueue: false, headOid: oid('c'), headDeleted: false },
  checks: [], linkedIssues: [], reviewIds: {}, awaitingApproval: [],
  commitDefaults: { squashTitle: 'PR_TITLE', squashBody: 'PR_BODY', mergeTitle: 'PR_TITLE', mergeBody: 'BLANK' },
};

test('the page reaches GitHub only for commits, comments and reactions the PR has and the viewer may touch', async () => {
  resetFakeWindow();
  const calls: string[] = [];
  const state: OverviewState = {
    title: 'PR', author: 'alice', headBranch: 'feature', baseBranch: 'main', url: 'https://github.com/acme/app/pull/7', viewed: [], read: [], threads: [],
    claude: { text: '', running: false, retry: false }, analysis: { running: false, stale: false }, details, conversation, github: [],
  };
  const actions = {
    readFiles: async (select?: unknown) => { calls.push('files ' + JSON.stringify(select ?? null)); return { files: [], selection: select ?? { range: { kind: 'all' }, whitespace: false }, atHead: true }; },
    addComment: async (text: string) => { calls.push('comment ' + text); },
    editComment: async () => { calls.push('edit'); },
    react: async (id: string, content: string, on: boolean) => { calls.push(`react ${id} ${content} ${String(on)}`); },
    commitSuggestions: async () => { calls.push('suggestions'); },
    changeBase: async (branch: string) => { calls.push('base ' + branch); },
    refresh: () => undefined,
  } as unknown as OverviewActions;
  await showPullRequestOverview('conversation-test', async () => state, new EventEmitter<void>().event, actions, vscode.Uri.file('/extension'));
  const panel = window.panels.at(-1)!;
  const tick = async () => { await new Promise((resolve) => setTimeout(resolve, 50)); };
  for (const message of [
    { action: 'files', range: { kind: 'commits', from: oid('f'), to: oid('f') }, whitespace: false },
    { action: 'files', range: { kind: 'commits', from: oid('a'), to: oid('a') }, whitespace: true },
    { action: 'conversation-comment', form: 'conversation', text: '  Thanks  ' },
    { action: 'edit-comment', form: 'edit:IC1', kind: 'issue', id: 'IC1', text: 'changed' },
    { action: 'react', id: 'IC1', content: 'ROCKET', on: true },
    { action: 'react', id: 'PR_7', content: 'NOPE', on: true },
    { action: 'react', id: 'PR_7', content: 'HEART', on: false },
    { action: 'commit-suggestions', picked: [{ thread: 'T1', comment: 'C1' }] },
    { action: 'change-base', branch: ['main'] },
    { action: 'change-base', branch: 'release' },
  ]) {
    panel.receive(message);
    await tick();
  }
  assert.deepEqual(calls, [
    // The page reads its files as it opens.
    `files ${JSON.stringify(null)}`,
    `files ${JSON.stringify({ range: { kind: 'commits', from: oid('a'), to: oid('a') }, whitespace: true })}`,
    'comment Thanks',
    'react IC1 ROCKET true',
    'react PR_7 HEART false',
    'base release',
    `files ${JSON.stringify(null)}`,
  ]);
  assert.ok(panel.sent.some((sent) => (sent as { done?: string }).done === 'conversation'));
  assert.ok(panel.sent.some((sent) => String((sent as { error?: string }).error).includes('no longer on this PR')));
  panel.dispose();
});

test('changes the base only to a branch GitHub lists, never the head or the current base', async () => {
  const changed: string[] = [];
  const provider = { branches: async () => ['main', 'feature', 'release'], changeBase: async (_: number, branch: string) => { changed.push(branch); } };
  const actions = githubPageActions({ provider, number: 7, headBranch: 'feature', baseBranch: () => 'main' } as unknown as PageContext);
  assert.deepEqual(await actions.branches(), ['release']);
  for (const branch of ['main', 'feature', 'evil']) await assert.rejects(actions.changeBase(branch), /not a branch this PR can merge into/u);
  assert.deepEqual(changed, []);
});

test('hands only a conversation comment with text to the agent, with a known intent', async () => {
  resetFakeWindow();
  const calls: string[] = [];
  const state: OverviewState = {
    title: 'PR', author: 'alice', headBranch: 'feature', baseBranch: 'main', url: 'https://github.com/acme/app/pull/7', viewed: [], read: [], threads: [],
    claude: { text: '', running: false, retry: false }, analysis: { running: false, stale: false }, details, conversation, github: [],
  };
  const actions = {
    readFiles: async () => ({ files: [], selection: { range: { kind: 'all' }, whitespace: false }, atHead: true }),
    askAboutComment: async (id: string, note: string, intent: string) => { calls.push(`ask ${id} ${note} ${intent}`); },
    refresh: () => undefined,
  } as unknown as OverviewActions;
  await showPullRequestOverview('comment-ask-test', async () => state, new EventEmitter<void>().event, actions, vscode.Uri.file('/extension'));
  const panel = window.panels.at(-1)!;
  for (const message of [
    { action: 'comment-ask', form: 'comment-ask:IC1', id: 'IC1', text: 'Agree?', intent: 'ask' },
    { action: 'comment-ask', form: 'comment-ask:IC1', id: 'IC1', intent: 'implement' },
    { action: 'comment-ask', form: 'comment-ask:PC1', id: 'PC1', text: '', intent: 'ask' },
    { action: 'comment-ask', form: 'comment-ask:X', id: 'X', text: '', intent: 'ask' },
    { action: 'comment-ask', form: 'comment-ask:IC1', id: 'IC1', text: '', intent: 'summarize' },
    { action: 'comment-ask', form: 'comment-ask:IC1', id: 'IC1', text: 7, intent: 'ask' },
  ]) {
    panel.receive(message);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.deepEqual(calls, ['ask IC1 Agree? ask', 'ask IC1  implement']);
  assert.ok(panel.sent.some((sent) => (sent as { done?: string }).done === 'comment-ask:IC1'));
  panel.dispose();
});

test('sends the files uncolored first and their colors in batches after, unless a newer read replaced them', async () => {
  resetFakeWindow();
  const state: OverviewState = {
    title: 'PR', author: 'alice', headBranch: 'feature', baseBranch: 'main', url: 'https://github.com/acme/app/pull/7', viewed: [], read: [], threads: [],
    claude: { text: '', running: false, retry: false }, analysis: { running: false, stale: false }, details, conversation, github: [],
  };
  const file = (html: string) => ({ path: 'a.ts', change: 'modified' as const, binary: false, additions: 1, deletions: 0, hunks: [{ header: '@@ -1 +1 @@', lines: [{ kind: 'add' as const, newLine: 1, html }] }] });
  const selection = { range: { kind: 'all' as const }, whitespace: false };
  let colorings = 0;
  const releases: (() => void)[] = [];
  const actions = {
    readFiles: async () => ({ files: [file('a')], selection, atHead: true, colored: async (onBatch?: (files: readonly ReturnType<typeof file>[]) => void) => {
      colorings++;
      await new Promise<void>((resolve) => { releases.push(resolve); });
      onBatch?.([file('<span class="tm-ff0000">a</span>')]);
      return [file('<span class="tm-ff0000">a</span>')];
    } }),
    refresh: () => undefined,
  } as unknown as OverviewActions;
  await showPullRequestOverview('plain-first-test', async () => state, new EventEmitter<void>().event, actions, vscode.Uri.file('/extension'));
  const panel = window.panels.at(-1)!;
  const tick = async () => { await new Promise((resolve) => setTimeout(resolve, 20)); };
  const sentFiles = () => panel.sent.flatMap((sent) => {
    const { files, colors } = sent as { files?: ReturnType<typeof file>[]; colors?: ReturnType<typeof file>[] };
    return (files ?? colors ?? []).slice(0, 1).map((each) => (colors ? 'colors ' : '') + each.hunks[0]?.lines[0]?.html);
  });
  panel.receive({ action: 'ready' });
  await tick();
  assert.deepEqual(sentFiles(), ['a']);
  assert.equal(colorings, 1);
  releases.shift()?.();
  await tick();
  assert.deepEqual(sentFiles(), ['a', 'colors <span class="tm-ff0000">a</span>']);

  panel.receive({ action: 'files', range: { kind: 'all' }, whitespace: false });
  await tick();
  panel.receive({ action: 'files', range: { kind: 'all' }, whitespace: false });
  await tick();
  for (const release of releases.splice(0)) release();
  await tick();
  assert.deepEqual(sentFiles(), ['a', 'colors <span class="tm-ff0000">a</span>', 'a', 'a', 'colors <span class="tm-ff0000">a</span>'], 'the first read\'s colors arrived after the second read');
  panel.dispose();
});
