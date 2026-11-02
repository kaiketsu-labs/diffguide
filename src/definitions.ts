import { randomUUID } from 'node:crypto';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { highlightSource } from './unifiedDiff.js';
import { prepareHighlighting } from './codePreview.js';

/** A definition's code, ready for the review page's side panel. */
export interface DefinitionPeek {
  readonly id: string;
  /** Such as "src/state.ts:8". */
  readonly location: string;
  readonly startLine: number;
  /** Lines of the definition itself, counted from `startLine`. */
  readonly focus: { readonly start: number; readonly end: number };
  /** The defined name, marked in the panel; `start` and `end` are columns. */
  readonly name?: { readonly line: number; readonly start: number; readonly end: number };
  readonly lines: readonly string[];
}

/** Lines shown around a definition, so the panel scrolls through its surroundings. */
const linesBefore = 100;
const linesAfter = 400;

type Definition = vscode.Location | vscode.LocationLink;

/** Look up definitions through VS Code's language features and remember where each result lives. */
export class DefinitionPeeks {
  readonly #found = new Map<string, vscode.Location>();

  constructor(private readonly root: string) {}

  /** Whether a language extension knows a definition for the name at this position. */
  async has(uri: vscode.Uri, line: number, column: number): Promise<boolean> {
    return (await this.#lookup(uri, line, column)) !== undefined;
  }

  async find(uri: vscode.Uri, line: number, column: number): Promise<DefinitionPeek | undefined> {
    const first = await this.#lookup(uri, line, column);
    if (first === undefined) return undefined;
    const target = 'targetUri' in first ? new vscode.Location(first.targetUri, first.targetRange) : first;
    const document = await vscode.workspace.openTextDocument(target.uri);
    const { start, end } = target.range;
    const from = Math.max(0, start.line - linesBefore);
    const to = Math.min(document.lineCount - 1, end.line + linesAfter);
    await prepareHighlighting([target.uri.path]);
    // Highlighting from the top keeps strings and comments that open above the shown lines intact.
    const lines = highlightSource(document.getText(new vscode.Range(0, 0, to, Number.MAX_SAFE_INTEGER)), target.uri.path).slice(from);
    const selected = 'targetUri' in first ? first.targetSelectionRange ?? first.targetRange : first.range;
    const nameRange = selected.isSingleLine ? selected : document.getWordRangeAtPosition(selected.start);
    const id = randomUUID();
    this.#found.set(id, target);
    return {
      id, location: `${this.#label(target.uri)}:${start.line + 1}`, startLine: from + 1,
      focus: { start: start.line + 1, end: end.line + 1 }, lines,
      ...nameRange === undefined ? {} : { name: { line: nameRange.start.line + 1, start: nameRange.start.character, end: nameRange.end.character } },
    };
  }

  async #lookup(uri: vscode.Uri, line: number, column: number): Promise<Definition | undefined> {
    const results = await vscode.commands.executeCommand<readonly Definition[] | undefined>(
      'vscode.executeDefinitionProvider', uri, new vscode.Position(line - 1, column));
    return results?.[0];
  }

  /** Where an earlier result lives, so lookups can continue from inside the panel. */
  location(id: string): vscode.Location {
    const found = this.#found.get(id);
    if (found === undefined) throw new Error('This definition is no longer available. Look it up again.');
    return found;
  }

  #label(uri: vscode.Uri): string {
    const relative = path.relative(this.root, uri.fsPath);
    return uri.scheme === 'file' && !relative.startsWith('..') && !path.isAbsolute(relative) ? relative : vscode.workspace.asRelativePath(uri);
  }
}
