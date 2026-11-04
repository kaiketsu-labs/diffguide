import assert from 'node:assert/strict';
import test from 'node:test';
import * as vscode from 'vscode';
import { showPullRequestOverview, type OverviewActions, type OverviewState } from '../src/pullRequestOverview.js';
import type { PullRequestDetails } from '../src/pullRequests.js';
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
  const { saveSelection } = await import('../src/pullRequestEdits.js');
  const remote = new Set(['alice']);
  let additions = 0; let withdrawals = 0; let fail = true;
  const snapshot = (): PullRequestDetails => ({ ...details, reviewers: [...remote].map((name) => ({ name, state: 'requested' })) });
  let current = snapshot();
  const provider = {
    requestReviewers: async (_n: number, value: { users: readonly string[] }) => { additions++; value.users.forEach((u) => remote.add(u)); },
    removeReviewers: async (_n: number, value: { users: readonly string[] }) => { withdrawals++; if (fail) throw new Error('Forbidden'); value.users.forEach((u) => remote.delete(u)); },
  } as unknown as import('../src/pullRequests.js').PullRequestProvider;
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
