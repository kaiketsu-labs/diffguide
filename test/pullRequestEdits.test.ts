import assert from 'node:assert/strict';
import test from 'node:test';
import type { PullRequestDetails, PullRequestProvider } from '../src/core/forge.js';
import { reviewerChanges, saveSelection } from '../src/core/pullRequestEdits.js';

test('requests newly picked reviewers and withdraws unpicked requests', () => {
  assert.deepEqual(reviewerChanges({ users: ['alice', 'bob'], teams: ['core'] }, { users: ['bob', 'carol'], teams: ['core', 'web'] }), {
    add: { users: ['carol'], teams: ['web'] },
    remove: { users: ['alice'], teams: [] },
  });
});

const details: PullRequestDetails = {
  title: 'Test', body: '', bodyHtml: '', open: true, merged: false, draft: false, canEdit: true,
  branchDeletable: false, labels: [{ name: 'old', color: 'ffffff' }], assignees: ['alice'],
  reviewers: [{ name: 'alice', state: 'requested' }, { name: 'Core', team: 'core', state: 'requested' }],
  mergeable: 'yes', viewerIsAuthor: false, viewerAvatarUrl: '', mergeMethods: [], checks: [],
};
function fixture(fail?: string) {
  const calls: unknown[] = [];
  const write = async (kind: string, ...args: unknown[]) => { calls.push([kind, ...args]); if (fail === kind) throw new Error('GitHub refused'); };
  const provider = {
    requestReviewers: async (n: number, value: unknown) => write('add', n, value),
    removeReviewers: async (n: number, value: unknown) => write('remove', n, value),
    editPullRequest: async (n: number, value: unknown) => write('edit', n, value),
  } as unknown as PullRequestProvider;
  return { calls, provider };
}
const unchanged = { reviewers: { values: ['alice'], teams: ['core'] }, assignees: { values: ['alice'], teams: [] }, labels: { values: ['old'], teams: [] } };
for (const what of ['reviewers', 'assignees', 'labels'] as const) {
  test(`${what}: missing permission never writes`, async () => {
    const { calls, provider } = fixture();
    await assert.rejects(saveSelection(provider, 7, { ...details, canEdit: false }, what, { values: [], teams: [] }), /permission/);
    assert.deepEqual(calls, []);
  });
  test(`${what}: unchanged selection never writes`, async () => {
    const { calls, provider } = fixture();
    await saveSelection(provider, 7, details, what, unchanged[what]); assert.deepEqual(calls, []);
  });
}
const swap = { values: ['bob'], teams: ['web'] };
test('requests users and teams before withdrawing old requests', async () => {
  const { calls, provider } = fixture();
  await saveSelection(provider, 7, details, 'reviewers', swap);
  assert.deepEqual(calls, [['add', 7, { users: ['bob'], teams: ['web'] }], ['remove', 7, { users: ['alice'], teams: ['core'] }]]);
});
test('failed request stops before removing existing reviewers', async () => {
  const { calls, provider } = fixture('add');
  await assert.rejects(saveSelection(provider, 7, details, 'reviewers', swap), /GitHub refused/);
  assert.equal(calls.length, 1);
});
test('failed withdrawal reports partial success and preserves original cause', async () => {
  const { calls, provider } = fixture('remove');
  await assert.rejects(saveSelection(provider, 7, details, 'reviewers', swap), (error: Error) => {
    assert.match(error.message, /already have been saved/); assert.match(String(error.cause), /GitHub refused/); return true;
  }); assert.equal(calls.length, 2);
});
for (const what of ['assignees', 'labels'] as const) {
  test(`${what}: empty selection explicitly clears values`, async () => {
    const { calls, provider } = fixture();
    await saveSelection(provider, 7, details, what, { values: [], teams: [] }); assert.deepEqual(calls, [['edit', 7, { [what]: [] }]]);
  });
  test(`${what}: write failures propagate`, async () => {
    const { provider } = fixture('edit');
    await assert.rejects(saveSelection(provider, 7, details, what, { values: [], teams: [] }), /GitHub refused/);
  });
}
test('a team with the same display name as a user stays a separate request', async () => {
  const { provider, calls } = fixture();
  await saveSelection(provider, 7, { ...details, reviewers: [{ name: 'alice', team: 'core', state: 'requested' }, { name: 'alice', state: 'requested' }] }, 'reviewers', { values: ['alice', 'bob'], teams: [] });
  assert.deepEqual(calls, [['add', 7, { users: ['bob'], teams: [] }], ['remove', 7, { users: [], teams: ['core'] }]]);
});
test('a re-requested reviewer counts as requested: kept when ticked, withdrawn when unticked', async () => {
  const reviewed: PullRequestDetails = { ...details, reviewers: [{ name: 'bob', state: 'approved', rerequested: true }] };
  const kept = fixture();
  await saveSelection(kept.provider, 7, reviewed, 'reviewers', { values: ['bob'], teams: [] });
  assert.deepEqual(kept.calls, []);
  const withdrawn = fixture();
  await saveSelection(withdrawn.provider, 7, reviewed, 'reviewers', { values: [], teams: [] });
  assert.deepEqual(withdrawn.calls, [['remove', 7, { users: ['bob'], teams: [] }]]);
});
