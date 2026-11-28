import assert from 'node:assert/strict';
import test from 'node:test';
import { formatNote, shortTitle, type Note } from '../src/notes/format.js';

const note: Note = { id: 'n1', title: 'Standup', body: 'Ship the sidebar.', tags: ['work', 'daily'], createdAt: '2025-03-03T09:00:00.000Z' };

test('formatNote puts the title, sorted tags and body on separate lines', () => {
  assert.equal(formatNote(note), 'Standup\n#daily #work\n\nShip the sidebar.');
});

test('shortTitle shortens long titles', () => {
  assert.equal(shortTitle({ ...note, title: 'x'.repeat(200) }).length, 80);
});
