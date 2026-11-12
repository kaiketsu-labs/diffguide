import assert from 'node:assert/strict';
import test from 'node:test';
import { findDeclaration } from '../src/hosts/vscode/definitions.js';

test('finds a same-file declaration by name when no language extension answers', () => {
  const source = ['import os', '', 'def load_config(path):', '    return path', '', 'class Loader:', '    pass', 'config = load_config("x")'].join('\n');
  assert.deepEqual(findDeclaration(source, 'load_config'), { line: 2, start: 4 });
  assert.deepEqual(findDeclaration(source, 'Loader'), { line: 5, start: 6 });
  assert.equal(findDeclaration(source, 'config'), undefined);
  assert.equal(findDeclaration(source, 'load'), undefined);
  assert.deepEqual(findDeclaration('const $store = 1;\nexport function run() {}', '$store'), { line: 0, start: 6 });
});
