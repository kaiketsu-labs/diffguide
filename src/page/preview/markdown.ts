import MarkdownIt from 'markdown-it';
import { posix } from 'node:path';
import { codePreviewHtml, escapeCode } from '../../core/codePreview.js';
import { mediaType } from '../media.js';

const fenceFiles: Readonly<Record<string, string>> = {
  ts: 'x.ts', typescript: 'x.ts', tsx: 'x.tsx', js: 'x.js', javascript: 'x.js', jsx: 'x.jsx', json: 'x.json',
  py: 'x.py', python: 'x.py', sh: 'x.sh', bash: 'x.sh', shell: 'x.sh', zsh: 'x.sh',
  swift: 'x.swift', go: 'x.go', rust: 'x.rs', rs: 'x.rs', kotlin: 'x.kt', kt: 'x.kt', java: 'x.java', ruby: 'x.rb', rb: 'x.rb',
  c: 'x.c', cpp: 'x.cpp', csharp: 'x.cs', cs: 'x.cs', css: 'x.css', scss: 'x.scss', html: 'x.html', xml: 'x.xml',
  yaml: 'x.yaml', yml: 'x.yaml', toml: 'x.toml', sql: 'x.sql', md: 'x.md', markdown: 'x.md', php: 'x.php', dart: 'x.dart',
  diff: 'x.diff', patch: 'x.diff', jsonc: 'x.jsonc', scala: 'x.scala', objc: 'x.m', 'objective-c': 'x.m', ini: 'x.ini',
};
/** One top-level block of a rendered Markdown file and the source lines it came from. */
export interface MarkdownBlock {
  readonly startLine: number;
  readonly endLine: number;
  readonly html: string;
}

const preview = new MarkdownIt({
  html: false,
  highlight: (code, language) => codePreviewHtml(code.replace(/\n$/u, ''), fenceFiles[language.toLowerCase()] ?? 'x.txt'),
});

/** Stand-in file names for the code fences' languages, so their grammars can load before rendering. */
export function fenceFilePaths(markdown: string): string[] {
  return [...markdown.matchAll(/^\s*(?:`{3,}|~{3,})\s*([\w+-]+)/gmu)].flatMap((match) => fenceFiles[(match[1] ?? '').toLowerCase()] ?? []);
}

/** Render a Markdown file block by block, so each block can take comments on its source lines. Raw HTML stays escaped. */
export function markdownBlocks(markdown: string): readonly MarkdownBlock[] {
  const lines = markdown.split('\n');
  const tokens = preview.parse(markdown, {});
  const blocks: MarkdownBlock[] = [];
  let index = 0;
  while (index < tokens.length) {
    const open = tokens[index];
    let close = index;
    if (open?.nesting === 1) {
      let depth = 0;
      for (; close < tokens.length; close++) {
        depth += tokens[close]?.nesting ?? 0;
        if (depth === 0) break;
      }
    }
    const map = open?.map;
    if (map !== null && map !== undefined) {
      let endLine = map[1];
      while (endLine > map[0] + 1 && (lines[endLine - 1] ?? '').trim() === '') endLine -= 1;
      blocks.push({ startLine: map[0] + 1, endLine, html: preview.renderer.render(tokens.slice(index, close + 1), preview.options, {}) });
    }
    index = close + 1;
  }
  return blocks;
}

const listItem = /^\s*([-*+]|\d+[.)])\s+(.*)$/u;
const blockStart = /^\s*(?:```|~~~|#{1,6}\s|>|[-*+]\s|\d+[.)]\s|\|)/u;
const tableDivider = /^\s*\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)*\|?\s*$/u;
const isTableRow = (line: string): boolean => line.trim().startsWith('|') || tableCells(line).length > 1;
/** A GFM table starts on a row followed by a divider with as many columns; outer pipes are optional. */
const isTableStart = (lines: readonly string[], index: number): boolean => {
  const line = lines[index] ?? '';
  const divider = lines[index + 1] ?? '';
  return isTableRow(line) && tableDivider.test(divider) && tableCells(divider).length === tableCells(line).length;
};

/** A table row's cells, split on pipes outside inline code; `\|` is a literal pipe. */
function tableCells(line: string): string[] {
  const cells: string[] = [];
  let cell = '';
  let code = false;
  const text = line.trim().replace(/^\|/u, '').replace(/(?<!\\)\|$/u, '');
  for (let at = 0; at < text.length; at += 1) {
    const char = text[at] ?? '';
    if (char === '\\' && text[at + 1] === '|') { cell += '|'; at += 1; }
    else if (char === '`') { code = !code; cell += char; }
    else if (char === '|' && !code) { cells.push(cell.trim()); cell = ''; }
    else cell += char;
  }
  cells.push(cell.trim());
  return cells;
}

/** A `<details>` section as GitHub folds it: `<details>`, `<summary>text</summary>` and `</details>` each on their own line, Markdown between. */
function foldedSection(lines: readonly string[], index: number): { readonly html: string; readonly next: number } | undefined {
  const summary = /^\s*<summary>(.*)<\/summary>\s*$/u.exec(lines[index + 1] ?? '');
  if ((lines[index] ?? '').trim() !== '<details>' || summary === null) return undefined;
  const close = lines.findIndex((line, at) => at > index + 1 && line.trim() === '</details>');
  if (close === -1) return undefined;
  return { html: `<details class="md-details"><summary>${inline(summary[1] ?? '')}</summary>${markdownHtml(lines.slice(index + 2, close).join('\n'))}</details>`, next: close + 1 };
}

/** Render the Markdown subset Claude writes as HTML built only from escaped text and fixed tags. */
export function markdownHtml(markdown: string): string {
  const lines = markdown.replaceAll('\r\n', '\n').split('\n');
  const out: string[] = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index] ?? '';
    if (fenceStart.test(line)) {
      const block = fencedCode(lines, index);
      out.push(block.html);
      index = block.next;
      continue;
    }
    if (line.trim() === '') {
      index += 1;
      continue;
    }
    const folded = foldedSection(lines, index);
    if (folded !== undefined) {
      out.push(folded.html);
      index = folded.next;
      continue;
    }
    const heading = /^(#{1,6})\s+(.*)$/u.exec(line);
    if (heading !== null) {
      out.push(`<p class="md-heading"><strong>${inline(heading[2] ?? '')}</strong></p>`);
      index += 1;
      continue;
    }
    if (line.startsWith('>')) {
      const quoted: string[] = [];
      while (index < lines.length && (lines[index] ?? '').startsWith('>')) quoted.push((lines[index++] ?? '').replace(/^>\s?/u, ''));
      out.push(`<blockquote>${markdownHtml(quoted.join('\n'))}</blockquote>`);
      continue;
    }
    if (isTableStart(lines, index)) {
      const align = tableCells(lines[index + 1] ?? '').map((cell) => cell.endsWith(':') ? (cell.startsWith(':') ? ' class="center"' : ' class="right"') : '');
      const row = (cells: readonly string[], tag: 'th' | 'td'): string => `<tr>${align.map((attribute, column) => `<${tag}${attribute}>${inline(cells[column] ?? '')}</${tag}>`).join('')}</tr>`;
      const head = row(tableCells(line), 'th');
      index += 2;
      const body: string[] = [];
      while (index < lines.length && isTableRow(lines[index] ?? '')) body.push(row(tableCells(lines[index++] ?? ''), 'td'));
      out.push(`<table><thead>${head}</thead><tbody>${body.join('')}</tbody></table>`);
      continue;
    }
    const first = listItem.exec(line);
    if (first !== null) {
      const ordered = /\d/u.test(first[1] ?? '');
      const items: { text: string; code: string }[] = [];
      while (index < lines.length) {
        const current = lines[index] ?? '';
        const item = listItem.exec(current);
        const last = items.at(-1);
        if (item !== null) items.push({ text: item[2] ?? '', code: '' });
        else if (last !== undefined && /^\s+/u.test(current) && fenceStart.test(current)) {
          const block = fencedCode(lines, index);
          last.code += block.html;
          index = block.next;
          continue;
        } else if (/^\s+\S/u.test(current) && last !== undefined) last.text += ` ${current.trim()}`;
        else break;
        index += 1;
      }
      const tag = ordered ? 'ol' : 'ul';
      out.push(`<${tag}>${items.map((item) => `<li>${inline(item.text)}${item.code}</li>`).join('')}</${tag}>`);
      continue;
    }
    const paragraph: string[] = [];
    while (index < lines.length && (lines[index] ?? '').trim() !== '' && (paragraph.length === 0 || !(blockStart.test(lines[index] ?? '') || isTableStart(lines, index)))) {
      paragraph.push(lines[index++] ?? '');
    }
    out.push(`<p>${paragraph.map(inline).join('<br>')}</p>`);
  }
  return out.join('');
}

// A backtick fence's info string has no backticks, so ```x``` on its own line is inline code.
const fenceStart = /^\s*(?:`{3,}(?!.*`)|~{3,})/u;

/** The fenced block starting at `start`, rendered with its language's highlighting, and the line after its closing fence. Indented fences lose their indent from each code line, as in CommonMark. */
function fencedCode(lines: readonly string[], start: number): { readonly html: string; readonly next: number } {
  const [, indent = '', marker = '```', language = ''] = /^(\s*)(`{3,}|~{3,})\s*([\w+-]*)/u.exec(lines[start] ?? '') ?? [];
  const body: string[] = [];
  let index = start + 1;
  const closing = new RegExp(`^\\s*${marker.charAt(0)}{${marker.length},}\\s*$`, 'u');
  while (index < lines.length && !closing.test(lines[index] ?? '')) {
    const line = lines[index++] ?? '';
    body.push(line.startsWith(indent) ? line.slice(indent.length) : line.trimStart());
  }
  return { html: `<pre><code>${codePreviewHtml(body.join('\n'), fenceFiles[language.toLowerCase()] ?? 'x.txt')}</code></pre>`, next: index + 1 };
}

/** Inline code, bold, italics and https links; everything else stays escaped text. Emphasis may span inline code, as on GitHub. */
function inline(text: string): string {
  const spans: string[] = [];
  const marked = text.replaceAll('\u0000', '').replaceAll(/(`+)(?!`)(.+?)(?<!`)\1(?!`)/gu, (_match, _ticks: string, code: string) => `\u0000${spans.push(`<code>${escapeCode(code)}</code>`) - 1}\u0000`);
  return escapeCode(marked)
    .replaceAll(/\[([^\]]+)\]\((https:\/\/[^\s)]+)\)/gu, '<a href="$2">$1</a>')
    .replaceAll(/\*\*(?!\s)(.+?)\*\*/gu, '<strong>$1</strong>')
    .replaceAll(/(^|[^\w])__(?!\s)(.+?)__(?!\w)/gu, '$1<strong>$2</strong>')
    .replaceAll(/(^|[^\w*])\*([^*\s][^*]*)\*(?![\w*])/gu, '$1<em>$2</em>')
    .replaceAll(/(^|[^\w])_([^_\s][^_]*)_(?!\w)/gu, '$1<em>$2</em>')
    .replaceAll(/\u0000(\d+)\u0000/gu, (_match, at: string) => spans[Number(at)] ?? '');
}

/**
 * Embed Markdown images that point into the repository as data URIs, since the review page loads only https and data images.
 * `readImage` gets a repository path and returns its bytes, or undefined to leave the image as it is.
 */
export async function inlineLocalImages(html: string, documentPath: string, readImage: (path: string) => Promise<Buffer | undefined>): Promise<string> {
  const sources = [...new Set([...html.matchAll(/<img src="([^"]*)"/gu)].map((match) => match[1] ?? ''))];
  const inlined = new Map<string, string>();
  await Promise.all(sources.map(async (source) => {
    const path = repositoryPath(source, documentPath);
    const mime = path === undefined ? undefined : mediaType(path);
    if (path === undefined || !mime?.startsWith('image/')) return;
    const bytes = await readImage(path);
    if (bytes !== undefined) inlined.set(source, `data:${mime};base64,${bytes.toString('base64')}`);
  }));
  return html.replace(/<img src="([^"]*)"/gu, (tag, source: string) => {
    const data = inlined.get(source);
    return data === undefined ? tag : `<img src="${data}"`;
  });
}

/** The repository path a relative image link names, or undefined for links with a scheme and paths outside the repository. */
function repositoryPath(source: string, documentPath: string): string | undefined {
  const link = source.replaceAll('&amp;', '&').replace(/[?#].*$/u, '');
  if (link === '' || /^[a-z][a-z0-9+.-]*:|^\/\//iu.test(link)) return undefined;
  let decoded: string;
  try { decoded = decodeURIComponent(link); } catch { return undefined; }
  const path = posix.normalize(decoded.startsWith('/') ? decoded.slice(1) : posix.join(posix.dirname(documentPath), decoded));
  return path.startsWith('../') || path === '..' || posix.isAbsolute(path) ? undefined : path;
}
