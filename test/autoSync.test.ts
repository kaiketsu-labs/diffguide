import assert from 'node:assert/strict';
import test from 'node:test';
import { sharedPerTurn } from '../src/autoSync.js';

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
