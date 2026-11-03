import assert from 'node:assert/strict';
import test from 'node:test';
import { reviewerChanges } from '../src/pullRequestEdits.js';

test('requests newly picked reviewers and withdraws unpicked requests', () => {
  assert.deepEqual(reviewerChanges({ users: ['alice', 'bob'], teams: ['core'] }, { users: ['bob', 'carol'], teams: ['core', 'web'] }), {
    add: { users: ['carol'], teams: ['web'] },
    remove: { users: ['alice'], teams: [] },
  });
});
