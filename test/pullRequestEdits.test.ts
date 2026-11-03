import assert from 'node:assert/strict';
import test from 'node:test';
import { reviewerChanges } from '../src/pullRequestEdits.js';

test('requests newly picked reviewers and withdraws unpicked requests', () => {
  assert.deepEqual(reviewerChanges({ users: ['alice', 'bob'], teams: ['core'] }, { users: ['bob', 'carol'], teams: ['core', 'web'] }), {
    add: { users: ['carol'], teams: ['web'] },
    remove: { users: ['alice'], teams: [] },
  });
});

import { pickAndSave } from '../src/pullRequestEdits.js';
import type { PickerOptions, PullRequestDetails, PullRequestProvider } from '../src/pullRequests.js';
import { resetFakeWindow, window } from './fakes/vscode.js';

const details: PullRequestDetails = {
  title: 'Test', body: '', bodyHtml: '', open: true, merged: false, draft: false, canEdit: true,
  branchDeletable: false, labels: [{ name: 'old', color: 'ffffff' }], assignees: ['alice'],
  reviewers: [{ name: 'alice', state: 'requested' }, { name: 'Core', team: 'core', state: 'requested' }],
  mergeable: 'yes', viewerIsAuthor: false, viewerAvatarUrl: '', mergeMethods: [], checks: [],
};
const options: PickerOptions = { users: ['alice', 'bob'], teams: [{ name: 'Core', slug: 'core' }, { name: 'Web', slug: 'web' }], labels: [{ name: 'new', color: 'ffffff' }] };
function fixture(fail?: string) {
  resetFakeWindow();
  const calls: unknown[] = [];
  const write = async (kind: string, ...args: unknown[]) => { calls.push([kind, ...args]); if (fail === kind) throw new Error('GitHub refused'); };
  const provider = {
    pickerOptions: async () => options,
    requestReviewers: async (n: number, value: unknown) => write('add', n, value),
    removeReviewers: async (n: number, value: unknown) => write('remove', n, value),
    editPullRequest: async (n: number, value: unknown) => write('edit', n, value),
  } as unknown as PullRequestProvider;
  return { calls, provider };
}
for (const what of ['reviewers', 'assignees', 'labels'] as const) {
  test(`${what}: cancellation never writes`, async () => {
    const { calls, provider } = fixture(); window.quickPickIndex = undefined;
    await pickAndSave(provider, 7, details, what); assert.deepEqual(calls, []);
  });
  test(`${what}: missing permission never opens a picker or writes`, async () => {
    const { calls, provider } = fixture();
    await assert.rejects(pickAndSave(provider, 7, { ...details, canEdit: false }, what), /permission/);
    assert.deepEqual(calls, []); assert.equal(window.quickPicks.length, 0);
  });
  test(`${what}: accepting unchanged selection never writes`, async () => {
    const { calls, provider } = fixture(); window.quickPickManyIndexes = what === 'reviewers' ? [0, 2] : what === 'labels' ? [1] : [0];
    await pickAndSave(provider, 7, details, what); assert.deepEqual(calls, []);
  });
}
test('requests users and teams before withdrawing old requests', async () => {
  const { calls, provider } = fixture(); window.quickPickManyIndexes = [1, 3];
  await pickAndSave(provider, 7, details, 'reviewers');
  assert.deepEqual(calls, [['add', 7, { users: ['bob'], teams: ['web'] }], ['remove', 7, { users: ['alice'], teams: ['core'] }]]);
});
test('failed request stops before removing existing reviewers', async () => {
  const { calls, provider } = fixture('add'); window.quickPickManyIndexes = [1, 3];
  await assert.rejects(pickAndSave(provider, 7, details, 'reviewers'), /GitHub refused/);
  assert.equal(calls.length, 1);
});
test('failed withdrawal reports partial success and preserves original cause', async () => {
  const { calls, provider } = fixture('remove'); window.quickPickManyIndexes = [1, 3];
  await assert.rejects(pickAndSave(provider, 7, details, 'reviewers'), (error: Error) => {
    assert.match(error.message, /already have been saved/); assert.match(String(error.cause), /GitHub refused/); return true;
  }); assert.equal(calls.length, 2);
});
for (const what of ['assignees', 'labels'] as const) {
  test(`${what}: empty selection explicitly clears values`, async () => {
    const { calls, provider } = fixture(); window.quickPickManyIndexes = [];
    await pickAndSave(provider, 7, details, what); assert.deepEqual(calls, [['edit', 7, { [what]: [] }]]);
  });
  test(`${what}: write failures propagate`, async () => {
    const { provider } = fixture('edit'); window.quickPickManyIndexes = [];
    await assert.rejects(pickAndSave(provider, 7, details, what), /GitHub refused/);
  });
}
test('a team with the same display name cannot mask a user review request', async () => {
  const { provider, calls } = fixture(); window.quickPickManyIndexes = [0, 1];
  await pickAndSave(provider, 7, { ...details, reviewers: [{ name: 'alice', team: 'core', state: 'requested' }, { name: 'alice', state: 'requested' }] }, 'reviewers');
  assert.equal(window.quickPicks.at(-1)?.[0]?.picked, true);
  assert.deepEqual(calls[0], ['add', 7, { users: ['bob'], teams: [] }]);
});
test('picker loading failure never writes', async () => {
  const { provider, calls } = fixture();
  const broken = { ...provider, pickerOptions: async () => { throw new Error('Options unavailable'); } };
  await assert.rejects(pickAndSave(broken, 7, details, 'reviewers'), /Options unavailable/);
  assert.deepEqual(calls, []);
});
test('keeps current assignees and labels selectable when absent from options', async () => {
  const { provider } = fixture(); window.quickPickIndex = undefined;
  await pickAndSave(provider, 7, details, 'assignees');
  assert.ok(window.quickPicks.at(-1)?.some((c) => c.label === 'alice' && c.picked));
  await pickAndSave(provider, 7, details, 'labels');
  assert.ok(window.quickPicks.at(-1)?.some((c) => c.label === 'old' && c.picked));
});
