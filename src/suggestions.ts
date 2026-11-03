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
