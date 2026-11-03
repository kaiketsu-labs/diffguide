import { codePreviewHtml, prepareHighlighting } from './codePreview.js';
import { git } from './worktrees.js';

export interface DiffLine {
  readonly kind: 'context' | 'add' | 'del';
  readonly oldLine?: number;
  readonly newLine?: number;
  /** Escaped source, with allowlisted highlight spans. */
  readonly html: string;
}

export interface DiffHunk {
  readonly header: string;
  readonly lines: readonly DiffLine[];
}

export interface FileDiff {
  readonly path: string;
  readonly oldPath?: string;
  readonly change: 'added' | 'modified' | 'deleted' | 'renamed';
  readonly binary: boolean;
  readonly additions: number;
  readonly deletions: number;
  readonly hunks: readonly DiffHunk[];
}

interface RawLine { readonly kind: DiffLine['kind']; readonly oldLine?: number; readonly newLine?: number; readonly text: string }
interface RawFile { path: string; oldPath?: string; change: FileDiff['change']; binary: boolean; hunks: { header: string; lines: RawLine[] }[] }

/** A PR worktree's tracked changes against its base, highlighted per line; yields between files so a large PR does not block the extension host. */
export async function readPullRequestDiff(worktree: string, base: string): Promise<readonly FileDiff[]> {
  const output = await diffOutput(worktree, base);
  await prepareHighlighting([...output.matchAll(/^\+\+\+ b\/(.+)$/gmu)].map((match) => match[1] ?? ''));
  const files: FileDiff[] = [];
  for (const file of parseRawDiff(output)) {
    files.push(highlightFile(file));
    await new Promise((resolve) => { setImmediate(resolve); });
  }
  return files;
}

function diffOutput(worktree: string, base: string): Promise<string> {
  return git(worktree, ['-c', 'core.quotePath=false', 'diff', '--no-color', '--no-ext-diff', '--no-textconv', '--src-prefix=a/', '--dst-prefix=b/', '-M', '-U3', base, '--']);
}

/** The PR's changes without syntax colors, for counting and matching lines where nothing is shown. */
export async function readPlainPullRequestDiff(worktree: string, base: string): Promise<readonly FileDiff[]> {
  return parsePlainDiff(await diffOutput(worktree, base));
}

export function parsePlainDiff(output: string): readonly FileDiff[] {
  return parseRawDiff(output).map((file) => highlightFile(file, (lines) => lines.map(escapeHtml)));
}

const escapeHtml = (text: string): string => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');

/** Parse `git diff` output; lines are highlighted per side so tokens spanning lines stay correct. */
export function parseUnifiedDiff(output: string): readonly FileDiff[] {
  return parseRawDiff(output).map((file) => highlightFile(file));
}

function parseRawDiff(output: string): readonly RawFile[] {
  const files: RawFile[] = [];
  let file: RawFile | undefined;
  let hunk: RawFile['hunks'][number] | undefined;
  let oldLine = 0;
  let newLine = 0;
  let oldLeft = 0;
  let newLeft = 0;
  for (const line of output.split('\n')) {
    if (line.startsWith('diff --git ')) {
      const paths = / a\/(.+) b\/(.+)$/u.exec(line);
      file = { path: paths?.[2] ?? '', change: 'modified', binary: false, hunks: [] };
      files.push(file);
      hunk = undefined;
    } else if (file === undefined) {
      continue;
    } else if (hunk !== undefined && (oldLeft > 0 || newLeft > 0) && /^[ +-]/u.test(line)) {
      const text = line.slice(1);
      if (line[0] === '+') {
        hunk.lines.push({ kind: 'add', newLine: newLine++, text });
        newLeft -= 1;
      } else if (line[0] === '-') {
        hunk.lines.push({ kind: 'del', oldLine: oldLine++, text });
        oldLeft -= 1;
      } else {
        hunk.lines.push({ kind: 'context', oldLine: oldLine++, newLine: newLine++, text });
        oldLeft -= 1;
        newLeft -= 1;
      }
    } else if (line.startsWith('@@ ')) {
      const numbers = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/u.exec(line);
      oldLine = Number(numbers?.[1] ?? 0);
      oldLeft = Number(numbers?.[2] ?? 1);
      newLine = Number(numbers?.[3] ?? 0);
      newLeft = Number(numbers?.[4] ?? 1);
      hunk = { header: line, lines: [] };
      file.hunks.push(hunk);
    } else if (line.startsWith('new file mode')) {
      file.change = 'added';
    } else if (line.startsWith('deleted file mode')) {
      file.change = 'deleted';
    } else if (line.startsWith('rename from ')) {
      file.change = 'renamed';
      file.oldPath = line.slice('rename from '.length);
    } else if (line.startsWith('rename to ')) {
      file.path = line.slice('rename to '.length);
    } else if (line.startsWith('+++ b/')) {
      file.path = line.slice('+++ b/'.length);
    } else if (line.startsWith('--- a/') && file.change === 'deleted') {
      file.path = line.slice('--- a/'.length);
    } else if (line.startsWith('Binary files ')) {
      file.binary = true;
    }
  }
  return files.filter((entry) => entry.path !== '');
}

function highlightFile(file: RawFile, highlight = highlightLines): FileDiff {
  let additions = 0;
  let deletions = 0;
  const hunks = file.hunks.map(({ header, lines }) => {
    const oldSide = lines.filter((line) => line.kind !== 'add');
    const newSide = lines.filter((line) => line.kind !== 'del');
    const html = new Map<RawLine, string>();
    const oldHtml = highlight(oldSide.map((line) => line.text), file.oldPath ?? file.path);
    const newHtml = highlight(newSide.map((line) => line.text), file.path);
    oldSide.forEach((line, index) => { html.set(line, oldHtml[index] ?? ''); });
    newSide.forEach((line, index) => { html.set(line, newHtml[index] ?? ''); });
    return {
      header,
      lines: lines.map((line): DiffLine => {
        if (line.kind === 'add') additions += 1;
        if (line.kind === 'del') deletions += 1;
        const { text: _text, ...position } = line;
        return { ...position, html: html.get(line) ?? '' };
      }),
    };
  });
  return { ...file, additions, deletions, hunks };
}

/** A whole file's lines, highlighted, for showing context the diff left out. */
export function highlightSource(text: string, filePath: string): readonly string[] {
  return highlightLines((text.endsWith('\n') ? text.slice(0, -1) : text).split('\n'), filePath);
}

/** Highlight consecutive lines together, then cut the markup at line breaks. */
function highlightLines(lines: readonly string[], filePath: string): readonly string[] {
  return splitHighlightedLines(codePreviewHtml(lines.join('\n'), filePath));
}

/** Split highlight markup into lines, closing and reopening spans that cross a line break. */
export function splitHighlightedLines(html: string): readonly string[] {
  const lines: string[] = [];
  const open: string[] = [];
  let current = '';
  for (const match of html.matchAll(/<[^>]*>|[^<]+/gu)) {
    const part = match[0];
    if (part === '</span>') {
      open.pop();
      current += part;
    } else if (part.startsWith('<')) {
      open.push(part);
      current += part;
    } else {
      const pieces = part.split('\n');
      current += pieces[0] ?? '';
      for (const piece of pieces.slice(1)) {
        lines.push(current + '</span>'.repeat(open.length));
        current = open.join('') + piece;
      }
    }
  }
  lines.push(current);
  return lines;
}
