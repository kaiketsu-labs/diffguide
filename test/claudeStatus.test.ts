import assert from 'node:assert/strict';
import test from 'node:test';
import { backgroundStatus, claudeStatus } from '../src/core/agent.js';

const idle = { running: false, threads: new Set<string>(), skipped: 0 };

test('shows the current step while Claude runs', () => {
  assert.deepEqual(claudeStatus({ ...idle, running: true, step: 'Reading src/app.ts' }), { text: 'Claude · Reading src/app.ts', icon: 'sync~spin', retry: false });
});

test('offers a retry after a failure or skipped comments, and is idle otherwise', () => {
  assert.equal(claudeStatus({ ...idle, error: 'boom' }).retry, true);
  assert.equal(claudeStatus({ ...idle, skipped: 2 }).text, 'Claude skipped 2');
  assert.deepEqual(claudeStatus(idle), { text: 'Claude idle', icon: 'comment-discussion', retry: false });
});

test('says Claude stopped after the user stops it, offering a retry for the comments it left', () => {
  assert.deepEqual(claudeStatus({ ...idle, stopped: true, skipped: 1 }), { text: 'Claude stopped', icon: 'debug-stop', retry: true });
  assert.equal(claudeStatus({ ...idle, stopped: true }).retry, false);
});

test('names a running guide build and code review for the sidebar', () => {
  assert.equal(backgroundStatus(false, false), undefined);
  assert.equal(backgroundStatus(true, false), 'Building guide');
  assert.equal(backgroundStatus(true, true), 'Building guide · Reviewing');
});
