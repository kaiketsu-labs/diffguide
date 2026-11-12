import assert from 'node:assert/strict';
import test from 'node:test';
import * as vscode from 'vscode';
import type { PullRequestDetails, PullRequestProvider } from '../src/core/forge.js';
import { githubPageActions, type PageContext } from '../src/core/pullRequestPageActions.js';
import { sharedPerTurn } from '../src/hosts/vscode/autoSync.js';
import { showPullRequestOverview } from '../src/hosts/vscode/reviewPanel.js';
import type { OverviewActions, OverviewState } from '../src/page/protocol.js';
import { EventEmitter, resetFakeWindow, window } from './fakes/vscode.js';

const tick = async () => { await new Promise((resolve) => setTimeout(resolve, 200)); };
const base: OverviewState = {
  title: 'PR', author: 'alice', headBranch: 'feature', baseBranch: 'main', url: 'https://github.com/acme/app/pull/7',
  viewed: [], read: [], threads: [], claude: { text: '', running: false, retry: false }, analysis: { running: false, stale: false },
};
const details: PullRequestDetails = {
  title: 'PR', body: '', bodyHtml: '', open: true, merged: false, draft: false, canEdit: true,
  branchDeletable: false, labels: [], assignees: [], reviewers: [], mergeable: 'yes', viewerIsAuthor: false,
  viewerAvatarUrl: '', mergeMethods: [], checks: [],
};
async function fixture(canEdit?: boolean, fail = false) {
  resetFakeWindow();
  let state: OverviewState = { ...base, ...(canEdit === undefined ? {} : { details: { ...details, canEdit } }) };
  let writes = 0; let refreshes = 0;
  const write = async () => { writes++; if (fail) throw new Error('partial GitHub failure'); };
  const actions = {
    pick: write, editTitle: write, editBody: write, setDraft: write, setOpen: write, deleteBranch: write,
    merge: write, submitReview: write,
    refresh: () => {
      refreshes++;
      const { details: _details, ...rest } = state;
      state = { ...rest, title: 'Authoritative state', detailsError: 'Reload failed; stale details discarded' };
    },
  } as unknown as OverviewActions;
  const changed = new EventEmitter<void>();
  await showPullRequestOverview('management-test', async () => state, changed.event, actions, vscode.Uri.file('/extension'));
  const panel = window.panels.at(-1)!;
  return { panel, writes: () => writes, refreshes: () => refreshes };
}
for (const canEdit of [false, undefined]) {
  test(`rejects management messages when edit permission is ${String(canEdit)}`, async () => {
    const f = await fixture(canEdit);
    for (const message of [{ action: 'pick', what: 'reviewers', values: ['bob'], teams: [] }, { action: 'edit-title' }, { action: 'edit-body', body: 'x' }, { action: 'draft', draft: true }, { action: 'close' }, { action: 'reopen' }, { action: 'delete-branch' }]) {
      f.panel.receive(message); await tick();
    }
    assert.equal(f.writes(), 0);
    assert.ok(f.panel.sent.some((m) => String((m as { error?: string }).error).includes('permission')));
    f.panel.dispose();
  });
}
for (const message of [{ action: 'pick', what: 'reviewers', values: ['bob'], teams: [] }, { action: 'pick', what: 'assignees', values: ['bob'], teams: [] }, { action: 'pick', what: 'labels', values: ['bug'], teams: [] }, { action: 'merge', method: 'squash' }]) {
  test(`${JSON.stringify(message)} refreshes and redraws after partial failure`, async () => {
    const f = await fixture(true, true); f.panel.receive(message); await tick();
    assert.equal(f.writes(), 1); assert.equal(f.refreshes(), 1);
    assert.ok(f.panel.sent.some((m) => (m as { error?: string }).error === 'partial GitHub failure'));
    assert.ok(f.panel.sent.some((m) => (m as { idle?: boolean }).idle === true));
    assert.ok(f.panel.sent.some((m) => JSON.stringify(m).includes('Authoritative state')));
    f.panel.dispose();
  });
}
test('successful management action also reloads authoritative state', async () => {
  const f = await fixture(true); f.panel.receive({ action: 'pick', what: 'labels', values: ['bug'], teams: [] }); await tick();
  assert.equal(f.writes(), 1); assert.equal(f.refreshes(), 1); f.panel.dispose();
});

test('partial reviewer writes reach the page as actual remote state, and retry requests only the missing removal', async () => {
  resetFakeWindow();
  const { saveSelection } = await import('../src/core/pullRequestEdits.js');
  const remote = new Set(['alice']);
  let additions = 0; let withdrawals = 0; let fail = true;
  const snapshot = (): PullRequestDetails => ({ ...details, reviewers: [...remote].map((name) => ({ name, state: 'requested' })) });
  let current = snapshot();
  const provider = {
    requestReviewers: async (_n: number, value: { users: readonly string[] }) => { additions++; value.users.forEach((u) => remote.add(u)); },
    removeReviewers: async (_n: number, value: { users: readonly string[] }) => { withdrawals++; if (fail) throw new Error('Forbidden'); value.users.forEach((u) => remote.delete(u)); },
  } as unknown as import('../src/core/forge.js').PullRequestProvider;
  const changed = new EventEmitter<void>();
  const actions = {
    pick: async (what: 'reviewers', picked: { values: string[]; teams: string[] }) => saveSelection(provider, 7, current, what, picked),
    refresh: () => { current = snapshot(); },
  } as unknown as OverviewActions;
  await showPullRequestOverview('partial-reviewers', async () => ({ ...base, details: current }), changed.event, actions, vscode.Uri.file('/extension'));
  const panel = window.panels.at(-1)!;
  panel.receive({ action: 'pick', what: 'reviewers', values: ['bob'], teams: [] }); await tick();
  const posted = panel.sent.filter((m): m is { state: OverviewState } => typeof m === 'object' && m !== null && 'state' in m).at(-1);
  assert.deepEqual(posted?.state.details?.reviewers.map((r) => r.name), ['alice', 'bob']);
  fail = false;
  panel.receive({ action: 'pick', what: 'reviewers', values: ['bob'], teams: [] }); await tick();
  assert.equal(additions, 1); assert.equal(withdrawals, 2); assert.deepEqual([...remote], ['bob']);
  panel.dispose();
});

test('malformed picker selections never write', async () => {
  const f = await fixture(true);
  for (const message of [{ action: 'pick', what: 'labels' }, { action: 'pick', what: 'labels', values: [1], teams: [] }, { action: 'pick', what: 'labels', values: [''], teams: [] }, { action: 'pick', what: 'milestone', values: [], teams: [] }]) {
    f.panel.receive(message); await tick();
  }
  assert.equal(f.writes(), 0); f.panel.dispose();
});

test('sends picker options to the page, or the reason they failed to load', async () => {
  resetFakeWindow();
  let fail = false;
  const options = { users: ['bob'], teams: [], labels: [{ name: 'bug', color: 'd73a4a', description: 'Broken' }] };
  const actions = { pickerOptions: async () => { if (fail) throw new Error('offline'); return options; } } as unknown as OverviewActions;
  await showPullRequestOverview('picker-options', async () => base, new EventEmitter<void>().event, actions, vscode.Uri.file('/extension'));
  const panel = window.panels.at(-1)!;
  panel.receive({ action: 'picker-options' }); await tick();
  assert.ok(panel.sent.some((m) => JSON.stringify((m as { pickerOptions?: unknown }).pickerOptions) === JSON.stringify(options)));
  fail = true; panel.receive({ action: 'picker-options' }); await tick();
  assert.ok(panel.sent.some((m) => (m as { pickerError?: string }).pickerError === 'offline'));
  panel.dispose();
});

test('local replies carry the intent the user picked', async () => {
  resetFakeWindow();
  const replies: unknown[] = [];
  const actions = { reply: async (...args: unknown[]) => { replies.push(args); } } as unknown as OverviewActions;
  await showPullRequestOverview('reply-intent', async () => base, new EventEmitter<void>().event, actions, vscode.Uri.file('/extension'));
  const panel = window.panels.at(-1)!;
  panel.receive({ action: 'reply', form: 'reply:t1', id: 't1', text: ' Do it ', intent: 'implement' }); await tick();
  panel.receive({ action: 'reply', form: 'reply:t1', id: 't1', text: 'Why?', intent: 'ask' }); await tick();
  panel.receive({ action: 'reply', form: 'reply:t1', id: 't1', text: 'No intent' }); await tick();
  panel.receive({ action: 'reply', form: 'reply:t1', id: 't1', text: 'Bad', intent: 'summarize' }); await tick();
  assert.deepEqual(replies, [['t1', 'Do it', 'implement'], ['t1', 'Why?', 'ask']]);
  panel.dispose();
});

test('a state read never lands while a Viewed tick is still being written', async () => {
  resetFakeWindow();
  const changed = new EventEmitter<void>();
  let viewed: string[] = [];
  const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  const actions = {
    setViewed: async (path: string) => {
      await wait(path === 'a.ts' ? 10 : 500);
      viewed = [...viewed, path];
      changed.fire();
    },
  } as unknown as OverviewActions;
  await showPullRequestOverview('viewed-race', async () => ({ ...base, viewed }), changed.event, actions, vscode.Uri.file('/extension'));
  const panel = window.panels.at(-1)!;
  panel.receive({ action: 'viewed', path: 'a.ts', viewed: true });
  await wait(50);
  const sentBefore = panel.sent.length;
  panel.receive({ action: 'viewed', path: 'b.ts', viewed: true });
  await wait(800);
  const states = panel.sent.slice(sentBefore).flatMap((m) => 'state' in (m as object) ? [(m as { state: OverviewState }).state.viewed] : []);
  assert.deepEqual(states, [['a.ts', 'b.ts']]);
  panel.dispose();
});

test('hands a GitHub thread to Claude only with a known thread and a valid intent', async () => {
  resetFakeWindow();
  const asked: unknown[] = [];
  const github = { id: 'g1', location: 'a.ts:3', text: '', status: 'Open', url: 'https://github.com/acme/app/pull/7#discussion_r1', path: 'a.ts', side: 'new', startLine: 3, endLine: 3, outdated: false, resolved: false, pending: false, messages: [] };
  const actions = { askAboutGitHub: async (...args: unknown[]) => { asked.push(args); } } as unknown as OverviewActions;
  await showPullRequestOverview('github-ask', async () => ({ ...base, github: [github] }) as OverviewState, new EventEmitter<void>().event, actions, vscode.Uri.file('/extension'));
  const panel = window.panels.at(-1)!;
  panel.receive({ action: 'ready' }); await tick();
  panel.receive({ action: 'github-ask', form: 'reply:g1', id: 'g1', text: '', intent: 'implement' }); await tick();
  panel.receive({ action: 'github-ask', form: 'reply:g1', id: 'g1', text: 'Why?', intent: 'ask' }); await tick();
  panel.receive({ action: 'github-ask', form: 'reply:g1', id: 'other', text: 'x', intent: 'ask' }); await tick();
  panel.receive({ action: 'github-ask', form: 'reply:g1', id: 'g1', text: 'x', intent: 'summarize' }); await tick();
  assert.deepEqual(asked, [['g1', '', 'implement'], ['g1', 'Why?', 'ask']]);
  panel.dispose();
});

test('a page action reads each part of the PR from GitHub once', async () => {
  resetFakeWindow();
  const reads = { details: 0, threads: 0, conversation: 0 };
  const wait = () => new Promise((resolve) => setTimeout(resolve, 5));
  const provider = {
    enqueue: wait,
    details: async () => { reads.details++; await wait(); return details; },
    threads: async () => { reads.threads++; await wait(); return []; },
    conversation: async () => { reads.conversation++; await wait(); return {}; },
  } as unknown as PullRequestProvider;
  const load = { details: sharedPerTurn(() => provider.details(7)), threads: sharedPerTurn(() => provider.threads(7)), conversation: sharedPerTurn(() => provider.conversation(7)) };
  const reloadAll = (): void => { void load.details(); void load.threads(); void load.conversation(); };
  const actions = {
    ...githubPageActions({ provider, number: 7, reload: reloadAll } as unknown as PageContext),
    refresh: reloadAll,
    pollGitHub: async () => ({ reload: false, files: false }),
  } as unknown as OverviewActions;
  const state = { ...base, details, conversation: { merge: { mergeQueue: true } } } as unknown as OverviewState;
  await showPullRequestOverview('reads-once', async () => state, new EventEmitter<void>().event, actions, vscode.Uri.file('/extension'));
  const panel = window.panels.at(-1)!;
  panel.receive({ action: 'enqueue' }); await tick();
  assert.deepEqual(reads, { details: 1, threads: 1, conversation: 1 });
  panel.dispose();
});

test('page-confirmed actions carry the choice the page made, and malformed choices never write', async () => {
  resetFakeWindow();
  const calls: unknown[] = [];
  const record = (name: string) => async (...args: unknown[]) => { calls.push([name, ...args]); };
  const actions = {
    merge: record('merge'), editTitle: record('title'), updateBranch: record('update'), dismissReview: record('dismiss'), hideComment: record('hide'),
    refresh: () => undefined,
  } as unknown as OverviewActions;
  const comment = { kind: 'comment', id: 'c1', canHide: true, canEdit: false, canDelete: false, canReact: false };
  const state = { ...base, details, conversation: { merge: { canUpdateBranch: true }, reviewIds: { bob: 'r1' }, timeline: [comment] } } as unknown as OverviewState;
  await showPullRequestOverview('page-confirmed', async () => state, new EventEmitter<void>().event, actions, vscode.Uri.file('/extension'));
  const panel = window.panels.at(-1)!;
  for (const message of [
    { action: 'merge', method: 'squash', deleteBranch: true }, { action: 'merge', method: 'squash', deleteBranch: 'yes' },
    { action: 'edit-title', title: ' New title ' }, { action: 'edit-title', title: ' ' },
    { action: 'update-branch', method: 'rebase' }, { action: 'update-branch', method: 'squash' },
    { action: 'dismiss-review', login: 'bob', text: ' Stale ' }, { action: 'dismiss-review', login: 'bob', text: '' },
    { action: 'hide-comment', id: 'c1', hide: true, reason: 'OUTDATED' }, { action: 'hide-comment', id: 'c1', hide: true, reason: 'BORING' }, { action: 'hide-comment', id: 'c1', hide: false },
  ]) { panel.receive(message); await tick(); }
  assert.deepEqual(calls, [
    ['merge', 'squash', {}, true], ['title', 'New title'], ['update', 'rebase'], ['dismiss', 'bob', 'Stale'], ['hide', 'c1', 'OUTDATED'], ['hide', 'c1', undefined],
  ]);
  panel.dispose();
});

test('enables auto-merge only when GitHub offers it, and says why not otherwise', async () => {
  const cases = [
    { merge: { canEnableAutoMerge: true, autoMergeAllowed: true }, error: undefined },
    { merge: { canEnableAutoMerge: false, autoMergeAllowed: false }, error: 'Auto-merge is off in this repository\'s settings.' },
    { merge: { canEnableAutoMerge: false, autoMergeAllowed: true }, error: 'GitHub does not offer auto-merge for this PR right now.' },
  ];
  for (const { merge, error } of cases) {
    resetFakeWindow();
    const calls: unknown[] = [];
    const actions = { enableAutoMerge: async (...args: unknown[]) => { calls.push(args); }, refresh: () => undefined } as unknown as OverviewActions;
    const state = { ...base, details, conversation: { merge } } as unknown as OverviewState;
    await showPullRequestOverview('auto-merge', async () => state, new EventEmitter<void>().event, actions, vscode.Uri.file('/extension'));
    const panel = window.panels.at(-1)!;
    panel.receive({ action: 'auto-merge', method: 'squash', headline: ' Ship it ', body: '' }); await tick();
    assert.deepEqual(calls, error === undefined ? [['squash', { headline: 'Ship it', body: '' }]] : []);
    assert.equal(panel.sent.some((m) => (m as { done?: string }).done === 'merge'), error === undefined);
    if (error !== undefined) assert.ok(panel.sent.some((m) => (m as { error?: string }).error === error));
    panel.dispose();
  }
});

test('re-requesting a review reloads the sidebar too, since it lists pending reviewers', async () => {
  const requested: unknown[] = [];
  const reloads: unknown[] = [];
  const provider = { requestReviewers: async (...args: unknown[]) => { requested.push(args); } } as unknown as PullRequestProvider;
  await githubPageActions({ provider, number: 7, reload: (listed?: boolean) => { reloads.push(listed); } } as unknown as PageContext).rerequestReview('bob');
  assert.deepEqual(requested, [[7, { users: ['bob'], teams: [] }]]);
  assert.deepEqual(reloads, [true]);
});
