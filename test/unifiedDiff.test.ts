import assert from 'node:assert/strict';
import test from 'node:test';

import { parseUnifiedDiff, splitHighlightedLines } from '../src/unifiedDiff.js';

const output = [
  'diff --git a/src/a.ts b/src/a.ts',
  'index 1111111..2222222 100644',
  '--- a/src/a.ts',
  '+++ b/src/a.ts',
  '@@ -1,3 +1,3 @@ export',
  ' const a = 1;',
  '--- old comment',
  '+const b = "two";',
  ' const c = 3;',
  'diff --git a/new.md b/new.md',
  'new file mode 100644',
  'index 0000000..3333333',
  '--- /dev/null',
  '+++ b/new.md',
  '@@ -0,0 +1 @@',
  '+hello',
  '\\ No newline at end of file',
  'diff --git a/old.txt b/renamed.txt',
  'similarity index 100%',
  'rename from old.txt',
  'rename to renamed.txt',
  'diff --git a/gone.bin b/gone.bin',
  'deleted file mode 100644',
  'Binary files a/gone.bin and /dev/null differ',
  '',
].join('\n');

test('parses changed, added, renamed and deleted binary files with line numbers', () => {
  const files = parseUnifiedDiff(output);
  assert.deepEqual(files.map((file) => [file.path, file.change, file.binary, file.additions, file.deletions]), [
    ['src/a.ts', 'modified', false, 1, 1],
    ['new.md', 'added', false, 1, 0],
    ['renamed.txt', 'renamed', false, 0, 0],
    ['gone.bin', 'deleted', true, 0, 0],
  ]);
  assert.equal(files[2]?.oldPath, 'old.txt');
  const lines = files[0]?.hunks[0]?.lines ?? [];
  assert.deepEqual(lines.map((line) => [line.kind, line.oldLine, line.newLine]), [
    ['context', 1, 1], ['del', 2, undefined], ['add', undefined, 2], ['context', 3, 3],
  ]);
  assert.match(lines[2]?.html ?? '', /<span class="hljs-string">&quot;two&quot;<\/span>/u);
  assert.equal(files[1]?.hunks[0]?.lines[0]?.html, 'hello');
});

test('splits highlight markup at line breaks and reopens spans that cross them', () => {
  assert.deepEqual(splitHighlightedLines('a<span class="hljs-comment">/* x\ny */</span>b\nc'),
    ['a<span class="hljs-comment">/* x</span>', '<span class="hljs-comment">y */</span>b', 'c']);
});
