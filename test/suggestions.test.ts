import assert from 'node:assert/strict';
import test from 'node:test';

import { anchorFromText } from '../src/anchors.js';
import { applySuggestion, parseSuggestions, suggestionMarkdown, withoutSuggestions } from '../src/suggestions.js';

const reply = [
  'Two ways to do it.',
  '',
  'Option 1: read the limit from config.',
  '```suggestion',
  'const retries = config.retries;',
  '```',
  '',
  'Option 2: keep a constant.',
  '```suggestion',
  'const retries = 3;',
  'const delay = 100;',
  '```',
  '',
  '```ts',
  'unrelated();',
  '```',
].join('\n');

test('reads each suggestion block as an option and leaves other code blocks in the text', () => {
  assert.deepEqual(parseSuggestions(reply), [{ code: 'const retries = config.retries;' }, { code: 'const retries = 3;\nconst delay = 100;' }]);
  const text = withoutSuggestions(reply);
  assert.doesNotMatch(text, /suggestion/u);
  assert.match(text, /Option 2: keep a constant\.\n\n```ts\nunrelated\(\);\n```/u);
  assert.equal(suggestionMarkdown({ code: 'a\nb' }), '```suggestion\na\nb\n```');
  assert.deepEqual(parseSuggestions('```suggestion\n```'), [{ code: '' }]);
});

test('applies a suggestion where the commented code is now, and refuses once that code changed', () => {
  const original = 'import x;\n\nconst retries = 5;\nrun(retries);\n';
  const anchor = anchorFromText(original, { path: 'a.ts', startLine: 3, endLine: 3, side: 'working', baseRevision: 'b'.repeat(40) });
  const moved = `// header\n${original}`;
  assert.equal(applySuggestion(moved, anchor, { code: 'const retries = 3;' }), '// header\nimport x;\n\nconst retries = 3;\nrun(retries);\n');
  assert.throws(() => applySuggestion(original.replace('5', '6'), anchor, { code: 'x' }), /no longer applies/u);
});
