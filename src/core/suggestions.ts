import { locateCodeAnchor } from './anchors.js';
import type { CodeAnchor } from './contracts.js';

/** Code proposed in place of a comment's lines, from a ```suggestion block as on GitHub. */
export interface Suggestion {
  readonly code: string;
}

const fence = /^ {0,3}(`{3,}|~{3,})[ \t]*suggestion[ \t]*\n([\s\S]*?)\n? {0,3}\1[ \t]*$/gmu;

/** Every suggestion block in a message, in order; several blocks are options to choose from. */
export function parseSuggestions(markdown: string): readonly Suggestion[] {
  return [...markdown.replaceAll('\r\n', '\n').matchAll(fence)].map((match) => ({ code: match[2] ?? '' }));
}

/** The message without its suggestion blocks, which the review page shows as their own cards. */
export function withoutSuggestions(markdown: string): string {
  return markdown.replaceAll('\r\n', '\n').replace(fence, '').replace(/\n{3,}/gu, '\n\n').trim();
}

/** A suggestion as GitHub writes it, so publishing it gives the author GitHub's Commit suggestion button. */
export function suggestionMarkdown(suggestion: Suggestion): string {
  return `\`\`\`suggestion\n${suggestion.code}\n\`\`\``;
}

/**
 * Replace a comment's lines with a suggestion in `text`, the file's current content.
 * Fails when the commented code moved ambiguously or changed, instead of editing other lines.
 */
export function applySuggestion(text: string, anchor: CodeAnchor, suggestion: Suggestion): string {
  const location = locateCodeAnchor(text, anchor);
  if (location === undefined) throw new Error('The commented code changed since the comment, so the suggestion no longer applies.');
  const newline = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(newline);
  lines.splice(location.startLine - 1, location.endLine - location.startLine + 1, ...suggestion.code.split('\n'));
  return lines.join(newline);
}

/** Where a comment's lines are in `text`, for publishing a suggestion against that version of the file. */
export function suggestionLines(text: string, anchor: CodeAnchor): { readonly start: number; readonly end: number } {
  const location = locateCodeAnchor(text, anchor);
  if (location === undefined) throw new Error('The commented code is not in the pushed version of the file, so GitHub cannot take the suggestion.');
  return { start: location.startLine, end: location.endLine };
}

/** A suggestion on fixed lines of a file, as a GitHub thread that is not outdated places it. */
export interface LineSuggestion { readonly startLine: number; readonly endLine: number; readonly code: string }

/** Replace each suggestion's lines in `text`; refuses overlapping suggestions and lines past the end, so no edit lands on other code. */
export function applyLineSuggestions(text: string, suggestions: readonly LineSuggestion[]): string {
  const newline = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(newline);
  const ordered = [...suggestions].sort((a, b) => b.startLine - a.startLine);
  ordered.forEach((suggestion, index) => {
    const below = ordered[index - 1];
    if (suggestion.startLine < 1 || suggestion.endLine < suggestion.startLine || suggestion.endLine > lines.length) throw new Error('A suggestion points past the end of its file.');
    if (below !== undefined && suggestion.endLine >= below.startLine) throw new Error('Two suggestions change the same lines. Commit them one at a time.');
    lines.splice(suggestion.startLine - 1, suggestion.endLine - suggestion.startLine + 1, ...suggestion.code.split('\n'));
  });
  return lines.join(newline);
}
