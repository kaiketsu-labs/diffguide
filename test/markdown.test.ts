import assert from 'node:assert/strict';
import test from 'node:test';

import { fenceFilePaths, markdownBlocks, markdownHtml } from '../src/markdown.js';

test('renders the Markdown Claude writes: paragraphs, lists, inline code, emphasis, links and fenced code', () => {
  const html = markdownHtml('`5` is **hardcoded**, see _notes_.\nSecond line.\n\n- `a.json` has 3\n- b\n\n1. one\n2. two\n\n> quoted\n\n## Fix\n\n```typescript\nconst total = 2;\n```');
  assert.equal(html, '<p><code>5</code> is <strong>hardcoded</strong>, see <em>notes</em>.<br>Second line.</p>'
    + '<ul><li><code>a.json</code> has 3</li><li>b</li></ul><ol><li>one</li><li>two</li></ol>'
    + '<blockquote><p>quoted</p></blockquote><p class="md-heading"><strong>Fix</strong></p>'
    + '<pre><code><span class="hljs-keyword">const</span> total = <span class="hljs-number">2</span>;</code></pre>');
});

test('renders tables with aligned columns, inline code and escaped pipes, and leaves a lone pipe line as text', () => {
  const html = markdownHtml('With:\n\n| attempt | base wait |\n|---|--:|\n| `0` | 200 ms |\n| 1 | a \\| b |\n\n| not a table |');
  assert.equal(html, '<p>With:</p><table><thead><tr><th>attempt</th><th class="right">base wait</th></tr></thead>'
    + '<tbody><tr><td><code>0</code></td><td class="right">200 ms</td></tr><tr><td>1</td><td class="right">a | b</td></tr></tbody></table>'
    + '<p>| not a table |</p>');  assert.equal(markdownHtml('Calls:\n| a | b |\n|---|---|\n| 1 | 2 |'), '<p>Calls:</p><table><thead><tr><th>a</th><th>b</th></tr></thead><tbody><tr><td>1</td><td>2</td></tr></tbody></table>');
});

test('renders GFM tables without outer pipes, also right after a paragraph line', () => {
  assert.equal(markdownHtml('Calls:\nname | count\n:-: | ---\n`retry()` | 2\nlast | 3'),
    '<p>Calls:</p><table><thead><tr><th class="center">name</th><th>count</th></tr></thead>'
    + '<tbody><tr><td class="center"><code>retry()</code></td><td>2</td></tr><tr><td class="center">last</td><td>3</td></tr></tbody></table>');
});

test('needs a divider with as many columns as the header to make a table', () => {
  assert.equal(markdownHtml('a | b\n---'), '<p>a | b<br>---</p>');
  assert.equal(markdownHtml('a \\| b\n---|---'), '<p>a \\| b<br>---|---</p>');
  assert.equal(markdownHtml('| a | b |\n|---|\n| 1 | 2 |'), '<p>| a | b |</p><p>|---|</p><p>| 1 | 2 |</p>');
});

test('keeps identifiers with underscores and stars intact', () => {
  assert.equal(markdownHtml('snake_case_name and a*b*c'), '<p>snake_case_name and a*b*c</p>');
});

test('bolds labels ending in punctuation, bold around inline code or emphasis, and __bold__', () => {
  assert.equal(markdownHtml('**Why asdf :** because'), '<p><strong>Why asdf :</strong> because</p>');
  assert.equal(markdownHtml('**Use `retry()` here**'), '<p><strong>Use <code>retry()</code> here</strong></p>');
  assert.equal(markdownHtml('**bold *and* more**'), '<p><strong>bold <em>and</em> more</strong></p>');
  assert.equal(markdownHtml('__bold__ and ** not bold**'), '<p><strong>bold</strong> and ** not bold**</p>');
  assert.equal(markdownHtml('`**not bold**` and `a\u0000`'), '<p><code>**not bold**</code> and <code>a</code></p>');
});

test('highlights fenced code inside list items and diff fences, without the list indent', () => {
  assert.equal(markdownHtml('1. Change it:\n   ```ts\n   const a = 1;\n   ```\n2. Test it'),
    '<ol><li>Change it:<pre><code><span class="hljs-keyword">const</span> a = <span class="hljs-number">1</span>;</code></pre></li><li>Test it</li></ol>');
  assert.equal(markdownHtml('```diff\n-old\n+new\n```'), '<pre><code><span class="hljs-deletion">-old</span>\n<span class="hljs-addition">+new</span></code></pre>');
});

test('never emits markup from the text itself', () => {
  const html = markdownHtml('<img src=x onerror=alert(1)> [x](javascript:alert(1)) [y](https://a.test/"onmouseover=alert(1)) `<b>`\n```html\n</code><script>alert(1)</script>\n```');
  assert.ok(!/<img|<script|<b>|href="javascript/u.test(html), html);
  assert.ok(!html.includes('"onmouseover'), html);
  assert.match(html, /<a href="https:\/\/a\.test\/&quot;onmouseover=alert\(1">y<\/a>/u);
});

test('a Markdown file renders block by block with the source lines of each block', () => {
  const blocks = markdownBlocks('# Setup\n\nInstall with `npm i`.\nThen run it.\n\n- one\n- two\n\n<img src=x onerror=alert(1)>\n[bad](javascript:alert(1))\n\n```swift\nlet a = 1\n```\n');
  assert.deepEqual(blocks.map(({ startLine, endLine }) => [startLine, endLine]), [[1, 1], [3, 4], [6, 7], [9, 10], [12, 14]]);
  assert.equal(blocks[0]?.html, '<h1>Setup</h1>\n');
  assert.match(blocks[2]?.html ?? '', /<ul>\n<li>one<\/li>/u);
  assert.doesNotMatch(blocks[3]?.html ?? '', /<img|href="javascript/u);
  assert.match(blocks[4]?.html ?? '', /class="hljs-keyword">let/u);
});

test('names a stand-in file for each known code fence language', () => {
  assert.deepEqual(fenceFilePaths('Text\n```python\nx = 1\n```\n  ~~~TS\nlet a\n~~~\n```\nplain\n```\n```brainfuck\n+\n```\n```diff\n-a\n```'), ['x.py', 'x.ts', 'x.diff']);
});

test('folds a details section with Markdown inside and escapes anything looser', () => {
  assert.equal(markdownHtml('Claim.\n\n<details>\n<summary>Evidence: `tested`</summary>\n\n- ran it\n\n</details>'),
    '<p>Claim.</p><details class="md-details"><summary>Evidence: <code>tested</code></summary><ul><li>ran it</li></ul></details>');
  assert.equal(markdownHtml('<details>\n<summary>x</summary>\nno end').includes('<details'), false);
  assert.equal(markdownHtml('<details open>\n<summary>x</summary>\n</details>').includes('<details'), false);
});
