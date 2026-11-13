import assert from 'node:assert/strict';
import test from 'node:test';
import { githubCodeFilePaths, githubCodeHtml } from '../src/page/preview/githubCode.js';

const python = '<div class="highlight highlight-source-python notranslate position-relative overflow-auto" dir="auto" data-snippet-clipboard-copy-content="if a > b:\n    pass"><pre class="notranslate"><span class="pl-k">if</span> <span class="pl-s1">a</span> <span class="pl-c1">&gt;</span> <span class="pl-s1">b</span>:\n    <span class="pl-k">pass</span></pre></div>';

test('highlights GitHub code blocks with our highlighter and names their grammars', () => {
  assert.deepEqual(githubCodeFilePaths(`<p>x</p>${python}`), ['x.py']);
  assert.equal(githubCodeHtml(python), '<pre><code><span class="hljs-keyword">if</span> a &gt; b:\n    <span class="hljs-keyword">pass</span></code></pre>');
});

test('keeps GitHub\'s highlighting for a language without a grammar name', () => {
  const elixir = '<div class="highlight highlight-source-elixir"><pre><span class="pl-k">def</span></pre></div>';
  assert.equal(githubCodeHtml(elixir), elixir);
});

test('highlights suggested lines in the commented file\'s language, only when the file is known', () => {
  const line = '<td class="border-0 px-2 py-1 blob-code-inner blob-code-addition js-blob-code-addition">    <span class="pl-k">return</span> <span class="pl-c1">None</span></td>';
  assert.equal(githubCodeHtml(line, 'src/app.py'), '<td class="border-0 px-2 py-1 blob-code-inner blob-code-addition js-blob-code-addition">    <span class="hljs-keyword">return</span> <span class="hljs-literal">None</span></td>');
  assert.equal(githubCodeHtml(line), line);
});
