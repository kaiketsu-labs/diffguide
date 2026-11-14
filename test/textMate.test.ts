import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { codePreviewHtml, codePreviewStyles, colorAhead, knownPreviewHtml, useEditorHighlighter } from '../src/core/codePreview.js';
import { customizationRules, readThemeRules, TextMateHighlighter } from '../src/hosts/vscode/textMate.js';

const wasm = require.resolve('vscode-oniguruma/release/onig.wasm');

const grammar = {
  scopeName: 'source.toy',
  patterns: [
    { match: '\\b(def|return)\\b', name: 'keyword.control.toy' },
    { match: '"[^"]*"', name: 'string.quoted.toy' },
    { match: '#.*$', name: 'comment.line.toy' },
  ],
};

async function toyHighlighter(workerPath?: string): Promise<TextMateHighlighter> {
  const folder = await mkdtemp(join(tmpdir(), 'diffguide-textmate-'));
  await writeFile(join(folder, 'toy.tmLanguage.json'), JSON.stringify(grammar));
  await writeFile(join(folder, 'base.json'), '{\n  // base theme\n  "tokenColors": [{ "scope": "string", "settings": { "foreground": "#E6DB74" } }],\n}');
  await writeFile(join(folder, 'theme.json'), JSON.stringify({ include: './base.json', tokenColors: [{ scope: 'keyword', settings: { foreground: '#F92672', fontStyle: 'italic' } }] }));
  const rules = await readThemeRules(join(folder, 'theme.json'));
  assert.ok(rules !== undefined);
  return new TextMateHighlighter({
    languages: [{ id: 'toy', extensions: ['.toy'], filenames: ['Toyfile'] }],
    grammars: [{ scopeName: 'source.toy', path: join(folder, 'toy.tmLanguage.json'), language: 'toy' }],
  }, { rules: [...rules, ...customizationRules({ comments: '#75715E' }, 'Toy')] }, wasm, workerPath);
}

test('colors code with the editor grammar and theme, after the grammar is loaded', async () => {
  const highlighter = await toyHighlighter();
  assert.equal(highlighter.highlight('def f', 'a.toy'), undefined);
  await highlighter.prepare(['src/a.toy', 'Toyfile', 'other.txt']);
  assert.equal(highlighter.highlight('def f():\n  return "<x>" # done', 'src/a.toy'),
    '<span class="tm-f92672 tm-i">def</span> f():\n  <span class="tm-f92672 tm-i">return</span> <span class="tm-e6db74">&quot;&lt;x&gt;&quot;</span> <span class="tm-75715e"># done</span>');
  assert.match(highlighter.highlight('return', 'Toyfile') ?? '', /tm-f92672/u);
  assert.equal(highlighter.highlight('return', 'other.txt'), undefined);
  assert.match(highlighter.styles(), /\.tm-e6db74 \{ color: #E6DB74; \}/u);
});

test('code previews use the editor highlighter and fall back to highlight.js for other files', async (t) => {
  const highlighter = await toyHighlighter();
  await highlighter.prepare(['a.toy']);
  useEditorHighlighter(highlighter);
  t.after(() => { useEditorHighlighter(undefined); });
  assert.match(codePreviewHtml('return "x"', 'a.toy'), /<span class="tm-e6db74">&quot;x&quot;<\/span>/u);
  assert.match(codePreviewHtml('return x', 'b.py'), /class="hljs-keyword">return/u);
  assert.match(codePreviewStyles(), /\.tm-f92672/u);
});

test('reads shorthand and theme-specific token color customizations', () => {
  assert.deepEqual(customizationRules({
    strings: '#111111',
    '[Toy]': { textMateRules: [{ scope: 'keyword', settings: { foreground: '#222222' } }] },
    '[Other]': { textMateRules: [{ scope: 'keyword', settings: { foreground: '#333333' } }] },
  }, 'Toy'), [
    { scope: ['string', 'meta.embedded.assembly'], settings: { foreground: '#111111' } },
    { scope: 'keyword', settings: { foreground: '#222222' } },
  ]);
});

test('worker threads color code exactly as the highlighter does on its own thread', async (t) => {
  const highlighter = await toyHighlighter(resolve('dist/highlight-worker.cjs'));
  t.after(() => { highlighter.dispose(); });
  const sources = [
    ...Array.from({ length: 12 }, (_, index) => ({ code: `def f${index}():\n  return "<${index}>" # done\n\n# \u00e9 & 'quote'\nreturn`, filePath: `src/${index}.toy` })),
    { code: 'return "x"', filePath: 'Toyfile' }, { code: 'return', filePath: 'other.txt' },
  ];
  assert.ok(highlighter.highlightAll !== undefined);
  // One call per source, so several workers take part.
  const threaded = await Promise.all(sources.map(async (source) => (await highlighter.highlightAll?.([source]))?.[0]));
  await highlighter.prepare(sources.map((source) => source.filePath));
  assert.deepEqual(threaded, sources.map(({ code, filePath }) => highlighter.highlight(code, filePath)));
  assert.match(threaded[0] ?? '', /tm-f92672/u);
  assert.equal(threaded.at(-1), undefined);
});

test('code colored ahead on worker threads is known to code previews, until the theme changes', async (t) => {
  const highlighter = await toyHighlighter(resolve('dist/highlight-worker.cjs'));
  useEditorHighlighter(highlighter);
  t.after(() => { useEditorHighlighter(undefined); });
  await colorAhead([{ code: 'return "x"', filePath: 'a.toy' }]);
  assert.match(knownPreviewHtml('return "x"', 'a.toy') ?? '', /<span class="tm-e6db74">&quot;x&quot;<\/span>/u);
  assert.equal(codePreviewHtml('return "x"', 'a.toy'), knownPreviewHtml('return "x"', 'a.toy'));

  const late = colorAhead([{ code: 'return "y"', filePath: 'a.toy' }]);
  useEditorHighlighter(undefined);
  await late;
  assert.equal(knownPreviewHtml('return "y"', 'a.toy'), undefined, 'colors of the replaced theme were kept');
});

test('code is colored on this thread when the worker threads fail', async (t) => {
  const highlighter = await toyHighlighter(join(tmpdir(), 'diffguide-no-such-worker.cjs'));
  await highlighter.prepare(['a.toy']);
  useEditorHighlighter(highlighter);
  t.after(() => { useEditorHighlighter(undefined); });
  await colorAhead([{ code: 'return "x"', filePath: 'a.toy' }]);
  assert.equal(knownPreviewHtml('return "x"', 'a.toy'), undefined);
  assert.match(codePreviewHtml('return "x"', 'a.toy'), /<span class="tm-e6db74">&quot;x&quot;<\/span>/u);
});
