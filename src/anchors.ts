import { createHash } from 'node:crypto';
import type { CodeAnchor } from './contracts.js';

/** Confirmed line positions in either current code or a captured context document. */
export interface AnchorLocation {
  readonly startLine: number;
  readonly endLine: number;
}

/** Read-only code excerpt retaining the exact context of the original review. */
export interface CapturedContext extends AnchorLocation {
  readonly text: string;
}

/** Identify a complete document without treating unchanged line numbers as evidence. */
export function hashDocumentText(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/** Compare code across normal line-ending changes without changing its whitespace. */
function normalizeLineEndings(text: string): string {
  return text.replaceAll('\r\n', '\n');
}

/** Compare a complete captured line sequence at one possible document location. */
function matchesLines(lines: readonly string[], expected: readonly string[], start: number): boolean {
  return start >= 0 && start + expected.length <= lines.length
    && expected.every((line, index) => lines[start + index] === line);
}

/** Locate captured code only when document identity or unique code context confirms it. */
export function locateCodeAnchor(text: string, anchor: CodeAnchor): AnchorLocation | undefined {
  const lines = normalizeLineEndings(text).split('\n');
  const selected = normalizeLineEndings(anchor.selectedText).split('\n');
  const originalStart = anchor.startLine - 1;
  if (hashDocumentText(text) === anchor.documentHash && matchesLines(lines, selected, originalStart)) {
    return { startLine: anchor.startLine, endLine: anchor.startLine + selected.length - 1 };
  }
  const candidates = lines.map((_, index) => index)
    .filter((index) => matchesLines(lines, selected, index));
  const beforeText = normalizeLineEndings(anchor.contextBefore);
  const before = beforeText.length === 0 ? [] : beforeText.replace(/\n$/u, '').split('\n');
  const afterText = normalizeLineEndings(anchor.contextAfter);
  const after = afterText.length === 0 ? [] : afterText.split('\n');
  if (before.length === 0 && after.length === 0 && anchor.selectedText.trim().length === 0) {
    return undefined;
  }
  const contextual = candidates.filter((index) => matchesLines(lines, before, index - before.length)
    && matchesLines(lines, after, index + selected.length));
  const start = contextual.length === 1 ? contextual[0] : undefined;
  return start === undefined ? undefined : { startLine: start + 1, endLine: start + selected.length };
}

/** Render an uncertain anchor in its saved context instead of attaching it to unrelated code. */
export function capturedCodeContext(anchor: CodeAnchor): CapturedContext {
  const before = normalizeLineEndings(anchor.contextBefore);
  const selected = normalizeLineEndings(anchor.selectedText);
  const after = normalizeLineEndings(anchor.contextAfter);
  const startLine = before.split('\n').length;
  return {
    text: `${before}${selected}${after.length === 0 ? '' : `\n${after}`}`,
    startLine,
    endLine: startLine + selected.split('\n').length - 1,
  };
}

/** Capture lines of a whole file the way an editor selection would, so page comments match editor comments. */
export function anchorFromText(
  text: string, target: Pick<CodeAnchor, 'path' | 'startLine' | 'endLine' | 'side' | 'baseRevision'>,
): CodeAnchor {
  const lines = text.split('\n');
  const { path, startLine, endLine } = target;
  if (!Number.isSafeInteger(startLine) || !Number.isSafeInteger(endLine) || startLine < 1 || endLine < startLine || endLine > lines.length) {
    throw new Error(`Lines ${startLine}–${endLine} are outside ${path}.`);
  }
  const start = startLine - 1;
  return {
    ...target,
    selectedText: lines.slice(start, endLine).join('\n'),
    contextBefore: lines.slice(Math.max(0, start - 3), start).map((line) => `${line}\n`).join(''),
    contextAfter: lines.slice(endLine, endLine + 3).join('\n'),
    documentHash: hashDocumentText(text),
  };
}
