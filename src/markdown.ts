import MarkdownIt from 'markdown-it';
import { codePreviewHtml, escapeCode } from './codePreview.js';

const fenceFiles: Readonly<Record<string, string>> = {
  ts: 'x.ts', typescript: 'x.ts', tsx: 'x.tsx', js: 'x.js', javascript: 'x.js', jsx: 'x.jsx', json: 'x.json',
  py: 'x.py', python: 'x.py', sh: 'x.sh', bash: 'x.sh', shell: 'x.sh', zsh: 'x.sh',
  swift: 'x.swift', go: 'x.go', rust: 'x.rs', rs: 'x.rs', kotlin: 'x.kt', kt: 'x.kt', java: 'x.java', ruby: 'x.rb', rb: 'x.rb',
  c: 'x.c', cpp: 'x.cpp', csharp: 'x.cs', cs: 'x.cs', css: 'x.css', scss: 'x.scss', html: 'x.html', xml: 'x.xml',
  yaml: 'x.yaml', yml: 'x.yaml', toml: 'x.toml', sql: 'x.sql', md: 'x.md', markdown: 'x.md', php: 'x.php', dart: 'x.dart',
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
const isTableRow = (line: string): boolean => line.trim().startsWith('|');

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

/** Render the Markdown subset Claude writes as HTML built only from escaped text and fixed tags. */
export function markdownHtml(markdown: string): string {
  const lines = markdown.replaceAll('\r\n', '\n').split('\n');
  const out: string[] = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index] ?? '';
    const fence = /^\s*(`{3,}|~{3,})\s*([\w+-]*)/u.exec(line);
    if (fence !== null) {
      const body: string[] = [];
      index += 1;
      while (index < lines.length && !(lines[index] ?? '').trim().startsWith(fence[1] ?? '```')) body.push(lines[index++] ?? '');
      index += 1;
      out.push(`<pre><code>${codePreviewHtml(body.join('\n'), fenceFiles[(fence[2] ?? '').toLowerCase()] ?? 'x.txt')}</code></pre>`);
      continue;
    }
    if (line.trim() === '') {
      index += 1;
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
    if (isTableRow(line) && tableDivider.test(lines[index + 1] ?? '')) {
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
      const items: string[] = [];
      while (index < lines.length) {
        const current = lines[index] ?? '';
        const item = listItem.exec(current);
        if (item !== null) items.push(item[2] ?? '');
        else if (/^\s+\S/u.test(current) && items.length > 0) items[items.length - 1] += ` ${current.trim()}`;
        else break;
        index += 1;
      }
      const tag = ordered ? 'ol' : 'ul';
      out.push(`<${tag}>${items.map((item) => `<li>${inline(item)}</li>`).join('')}</${tag}>`);
      continue;
    }
    const paragraph: string[] = [];
    while (index < lines.length && (lines[index] ?? '').trim() !== '' && (paragraph.length === 0 || !blockStart.test(lines[index] ?? ''))) {
      paragraph.push(lines[index++] ?? '');
    }
    out.push(`<p>${paragraph.map(inline).join('<br>')}</p>`);
  }
  return out.join('');
}

/** Inline code, bold, italics and https links; everything else stays escaped text. */
function inline(text: string): string {
  return text.split(/(`[^`]+`)/u).map((part) => {
    if (part.length > 2 && part.startsWith('`') && part.endsWith('`')) return `<code>${escapeCode(part.slice(1, -1))}</code>`;
    return escapeCode(part)
      .replaceAll(/\[([^\]]+)\]\((https:\/\/[^\s)]+)\)/gu, '<a href="$2">$1</a>')
      .replaceAll(/\*\*([^*]+)\*\*/gu, '<strong>$1</strong>')
      .replaceAll(/(^|[^\w*])\*([^*\s][^*]*)\*(?![\w*])/gu, '$1<em>$2</em>')
      .replaceAll(/(^|[^\w])_([^_\s][^_]*)_(?!\w)/gu, '$1<em>$2</em>');
  }).join('');
}
