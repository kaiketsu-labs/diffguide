import assert from 'node:assert/strict';
import test from 'node:test';
import { editedPaths, editRefusal } from '../src/agents/claude/editGuard.js';

test('lets Claude edit read-only repositories only inside their DiffGuide worktrees', () => {
  const readOnly = ['/repos/a', '/repos/b'];
  const own = '/repos/a/.claude/worktrees/diffguide/acme__a/pr-3';
  assert.match(editRefusal('/repos/b/src/x.ts', own, readOnly) ?? '', /\/repos\/b is open for reading only/u);
  assert.equal(editRefusal('/repos/b/.claude/worktrees/diffguide/acme__b/pr-9/x.ts', own, readOnly), undefined);
  assert.equal(editRefusal('src/x.ts', own, readOnly), undefined);
  assert.match(editRefusal('../../../../../src/x.ts', own, readOnly) ?? '', /\/repos\/a/u);
  assert.equal(editRefusal('/repos/bb/x.ts', own, readOnly), undefined);
  assert.equal(editRefusal('/tmp/scratch.txt', own, readOnly), undefined);
});

test('reads the written path of each file-editing tool and ignores the rest', () => {
  assert.deepEqual(editedPaths('Edit', { file_path: '/a' }), ['/a']);
  assert.deepEqual(editedPaths('Write', { file_path: '/b' }), ['/b']);
  assert.deepEqual(editedPaths('NotebookEdit', { notebook_path: '/c' }), ['/c']);
  assert.deepEqual(editedPaths('Read', { file_path: '/d' }), []);
  assert.deepEqual(editedPaths('Edit', 'junk'), []);
});
