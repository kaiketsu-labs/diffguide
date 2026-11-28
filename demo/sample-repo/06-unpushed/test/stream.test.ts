import assert from 'node:assert/strict';
import test from 'node:test';
import { toLines } from '../src/export/stream.js';
import type { Note } from '../src/notes/format.js';

const note = (id: string, tags: string[]): Note => ({ id, title: id, body: '', tags, createdAt: '2025-03-03T09:00:00.000Z' });

test('toLines writes one JSON document per note', () => {
  assert.deepEqual(toLines([note('n1', []), note('n2', [])]).map((line) => JSON.parse(line).id), ['n1', 'n2']);
});

test('toLines keeps only notes with the requested tag', () => {
  assert.equal(toLines([note('n1', ['work']), note('n2', ['home'])], { tag: 'work' }).length, 1);
});

test('toLines returns nothing for an empty store', () => {
  assert.deepEqual(toLines([]), []);
});
