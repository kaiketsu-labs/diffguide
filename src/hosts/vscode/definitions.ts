import { randomUUID } from 'node:crypto';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { highlightSource } from '../../core/unifiedDiff.js';
import { prepareHighlighting } from '../../page/preview/codePreview.js';
import type { DefinitionPeek } from '../../page/protocol.js';

/** Lines shown around a definition, so the panel scrolls through its surroundings. */
const linesBefore = 100;
const linesAfter = 400;

type Definition = vscode.Location | vscode.LocationLink;

/** Where a definition lies, and the defined name within it. */
interface Found {
  readonly location: vscode.Location;
  readonly selection: vscode.Range;
  readonly guessed: boolean;
}

/** Keywords that introduce a declaration in common languages, for the same-file fallback. */
const declarationKeywords = 'def|class|function|func|fn|struct|enum|interface|type|trait|module|let|const|var|val|macro';

/** The first line that declares `name` with a common keyword such as `def`, `class` or `const`; `line` and `start` count from 0. */
export function findDeclaration(text: string, name: string): { readonly line: number; readonly start: number } | undefined {
  const declaration = new RegExp(`\\b(?:${declarationKeywords})\\s+${name.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}(?![\\w$])`, 'u');
  const lines = text.split('\n');
  for (const [line, content] of lines.entries()) {
    const match = declaration.exec(content);
    if (match !== null) return { line, start: match.index + match[0].length - name.length };
  }
  return undefined;
}

function flattenSymbols(symbols: readonly (vscode.DocumentSymbol | vscode.SymbolInformation)[]): { readonly name: string; readonly range: vscode.Range; readonly selection: vscode.Range }[] {
  return symbols.flatMap((symbol) => 'children' in symbol
    ? [{ name: symbol.name, range: symbol.range, selection: symbol.selectionRange }, ...flattenSymbols(symbol.children)]
    : [{ name: symbol.name, range: symbol.location.range, selection: symbol.location.range }]);
}

/** Look up definitions through VS Code's language features and remember where each result lives. */
export class DefinitionPeeks {
  readonly #found = new Map<string, vscode.Location>();

  constructor(private readonly root: string) {}

  /** Whether a language extension knows a definition for the name at this position. */
  async has(uri: vscode.Uri, line: number, column: number): Promise<boolean> {
    return (await this.#lookup(uri, line, column)) !== undefined;
  }

  async find(uri: vscode.Uri, line: number, column: number): Promise<DefinitionPeek | undefined> {
    const found = await this.#lookup(uri, line, column);
    if (found === undefined) return undefined;
    const { location: target, selection: selected } = found;
    const document = await vscode.workspace.openTextDocument(target.uri);
    const { start, end } = target.range;
    const from = Math.max(0, start.line - linesBefore);
    const to = Math.min(document.lineCount - 1, end.line + linesAfter);
    await prepareHighlighting([target.uri.path]);
    // Highlighting from the top keeps strings and comments that open above the shown lines intact.
    const lines = highlightSource(document.getText(new vscode.Range(0, 0, to, Number.MAX_SAFE_INTEGER)), target.uri.path).slice(from);
    const nameRange = selected.isSingleLine ? selected : document.getWordRangeAtPosition(selected.start);
    const id = randomUUID();
    this.#found.set(id, target);
    return {
      id, location: `${this.#label(target.uri)}:${start.line + 1}`, startLine: from + 1,
      focus: { start: start.line + 1, end: end.line + 1 }, lines,
      ...found.guessed ? { guessed: true } : {},
      ...nameRange === undefined ? {} : { name: { line: nameRange.start.line + 1, start: nameRange.start.character, end: nameRange.end.character } },
    };
  }

  /** The file extension to search language extensions for, when VS Code knows neither definitions nor symbols in this file. */
  async missingLanguage(uri: vscode.Uri): Promise<string | undefined> {
    const symbols = await vscode.commands.executeCommand<readonly unknown[] | undefined>('vscode.executeDocumentSymbolProvider', uri).then(undefined, () => undefined);
    if (symbols !== undefined && symbols.length > 0) return undefined;
    const extension = path.extname(uri.path).slice(1);
    return extension === '' ? undefined : extension;
  }

  /** Ask the language extension, then fall back to a declaration of the same name in the same file. */
  async #lookup(uri: vscode.Uri, line: number, column: number): Promise<Found | undefined> {
    const position = new vscode.Position(line - 1, column);
    const results = await vscode.commands.executeCommand<readonly Definition[] | undefined>('vscode.executeDefinitionProvider', uri, position);
    const first = results?.[0];
    if (first !== undefined) {
      return 'targetUri' in first
        ? { location: new vscode.Location(first.targetUri, first.targetRange), selection: first.targetSelectionRange ?? first.targetRange, guessed: false }
        : { location: first, selection: first.range, guessed: false };
    }
    const document = await vscode.workspace.openTextDocument(uri);
    const word = document.getWordRangeAtPosition(position);
    if (word === undefined) return undefined;
    const name = document.getText(word);
    const symbols = await vscode.commands.executeCommand<readonly (vscode.DocumentSymbol | vscode.SymbolInformation)[] | undefined>('vscode.executeDocumentSymbolProvider', uri).then(undefined, () => undefined);
    const symbol = flattenSymbols(symbols ?? []).find((each) => each.name === name);
    if (symbol !== undefined) return { location: new vscode.Location(uri, symbol.range), selection: symbol.selection, guessed: false };
    const declaration = findDeclaration(document.getText(), name);
    if (declaration !== undefined) {
      const range = new vscode.Range(declaration.line, declaration.start, declaration.line, declaration.start + name.length);
      return { location: new vscode.Location(uri, document.lineAt(declaration.line).range), selection: range, guessed: true };
    }
    return undefined;
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
