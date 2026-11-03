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

test('keeps identifiers with underscores and stars intact', () => {
  assert.equal(markdownHtml('snake_case_name and a*b*c'), '<p>snake_case_name and a*b*c</p>');
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
  assert.deepEqual(fenceFilePaths('Text\n```python\nx = 1\n```\n  ~~~TS\nlet a\n~~~\n```\nplain\n```\n```brainfuck\n+\n```'), ['x.py', 'x.ts']);
});
