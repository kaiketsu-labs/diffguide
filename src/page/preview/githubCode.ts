import { codePreviewHtml } from '../../core/codePreview.js';

/** Stand-in file names for GitHub's highlight scopes, as in `highlight-source-python`, so our highlighter picks the grammar. */
const scopeFiles: Readonly<Record<string, string>> = {
  'source-python': 'x.py', 'source-ts': 'x.ts', 'source-tsx': 'x.tsx', 'source-js': 'x.js', 'source-json': 'x.json',
  'source-shell': 'x.sh', 'text-shell-session': 'x.sh', 'source-go': 'x.go', 'source-rust': 'x.rs', 'source-java': 'x.java',
  'source-kotlin': 'x.kt', 'source-swift': 'x.swift', 'source-ruby': 'x.rb', 'source-cs': 'x.cs', 'source-c++': 'x.cpp', 'source-c': 'x.c',
  'source-css': 'x.css', 'source-css-scss': 'x.scss', 'source-yaml': 'x.yaml', 'source-toml': 'x.toml', 'text-html-basic': 'x.html',
  'text-xml': 'x.xml', 'text-md': 'x.md', 'source-diff': 'x.diff', 'source-sql': 'x.sql', 'text-html-php': 'x.php', 'source-dart': 'x.dart',
  'source-scala': 'x.scala', 'source-objc': 'x.m', 'source-ini': 'x.ini',
};

// Attribute values may hold `>`, such as the code in `data-snippet-clipboard-copy-content`.
const codeBlock = /<div class="highlight highlight-([\w.+-]+)[^"]*"(?:[^>"]|"[^"]*")*>\s*<pre[^>]*>([\s\S]*?)<\/pre>\s*<\/div>/gu;
const suggestionLine = /(<td class="[^"]*\bblob-code-inner\b[^"]*">)([\s\S]*?)(<\/td>)/gu;
const entities: Readonly<Record<string, string>> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

/** The text of GitHub's highlighted code: its spans dropped and its entities decoded. */
function codeText(html: string): string {
  return html.replaceAll(/<[^>]*>/gu, '').replaceAll(/&(#x[\da-f]+|#\d+|[a-z]+);/giu, (entity, name: string) => {
    const hex = /^#x/iu.test(name);
    return name.startsWith('#') ? String.fromCodePoint(Number.parseInt(name.slice(hex ? 2 : 1), hex ? 16 : 10)) : entities[name] ?? entity;
  });
}

/** Stand-in file names for the languages of GitHub's code blocks, so their grammars can load before `githubCodeHtml`. */
export function githubCodeFilePaths(html: string): string[] {
  return [...html.matchAll(codeBlock)].flatMap((match) => scopeFiles[match[1] ?? ''] ?? []);
}

/**
 * Highlight the code in GitHub's rendered HTML with our highlighter, as the diff shows code.
 * Code blocks in languages it has no grammar name for keep GitHub's highlighting; suggested lines take the language of `path`, the commented file.
 */
export function githubCodeHtml(html: string, path?: string): string {
  const blocks = html.replaceAll(codeBlock, (block, scope: string, code: string) => {
    const file = scopeFiles[scope];
    return file === undefined ? block : `<pre><code>${codePreviewHtml(codeText(code), file)}</code></pre>`;
  });
  return path === undefined ? blocks : blocks.replaceAll(suggestionLine, (_line, open: string, code: string, close: string) => open + codePreviewHtml(codeText(code), path) + close);
}
