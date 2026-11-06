import assert from 'node:assert/strict';
import test from 'node:test';
import { PendingWrites, sharedPerTurn } from '../src/autoSync.js';

test('loads requested in one turn share a request, and a later turn sends a new one', async () => {
  let loads = 0;
  const load = sharedPerTurn(() => ++loads);
  assert.equal(load(), 1);
  assert.equal(load(), 1);
  await Promise.resolve();
  assert.equal(load(), 1);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(load(), 2);
});

test('keeps the user\'s own write over stale GitHub reads until GitHub reports it or it expires', () => {
  let now = 0;
  const written = new PendingWrites(1000, () => now);
  assert.equal(written.apply('open', true), true);
  written.expect('open', false);
  assert.equal(written.waiting, true);
  assert.equal(written.apply('open', true), false);
  assert.equal(written.apply('open', false), false);
  assert.equal(written.waiting, false);
  assert.equal(written.apply('open', true), true);
  written.expect('title', 'New');
  now = 1001;
  assert.equal(written.apply('title', 'Old'), 'Old');
  assert.equal(written.waiting, false);
});
