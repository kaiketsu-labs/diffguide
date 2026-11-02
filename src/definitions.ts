import { randomUUID } from 'node:crypto';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { highlightSource } from './unifiedDiff.js';

/** A definition's code, ready for the review page's side panel. */
export interface DefinitionPeek {
  readonly id: string;
  /** Such as "src/state.ts:8". */
  readonly location: string;
  readonly startLine: number;
  /** Lines of the definition itself, counted from `startLine`. */
  readonly focus: { readonly start: number; readonly end: number };
  readonly lines: readonly string[];
}

const maximumLines = 80;

/** Look up definitions through VS Code's language features and remember where each result lives. */
export class DefinitionPeeks {
  readonly #found = new Map<string, vscode.Location>();

  constructor(private readonly root: string) {}

  async find(uri: vscode.Uri, line: number, column: number): Promise<DefinitionPeek | undefined> {
    const results = await vscode.commands.executeCommand<readonly (vscode.Location | vscode.LocationLink)[] | undefined>(
      'vscode.executeDefinitionProvider', uri, new vscode.Position(line - 1, column));
    const first = results?.[0];
    if (first === undefined) return undefined;
    const target = 'targetUri' in first ? new vscode.Location(first.targetUri, first.targetRange) : first;
    const document = await vscode.workspace.openTextDocument(target.uri);
    const { start, end } = target.range;
    const from = Math.max(0, start.line - (start.line === end.line ? 3 : 0));
    const to = Math.min(document.lineCount - 1, from + maximumLines - 1, Math.max(end.line, start.line + 20));
    const lines = highlightSource(document.getText(new vscode.Range(from, 0, to, Number.MAX_SAFE_INTEGER)), target.uri.path);
    const id = randomUUID();
    this.#found.set(id, target);
    return {
      id, location: `${this.#label(target.uri)}:${start.line + 1}`, startLine: from + 1,
      focus: { start: start.line + 1, end: end.line + 1 }, lines,
    };
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
