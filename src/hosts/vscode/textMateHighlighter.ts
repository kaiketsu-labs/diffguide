import { readFile } from 'node:fs/promises';
import * as path from 'node:path';
import { loadWASM, OnigScanner, OnigString } from 'vscode-oniguruma';
import { type IGrammar, INITIAL, type IRawTheme, parseRawGrammar, Registry, type StateStack } from 'vscode-textmate';
import { type CodeSource, type EditorHighlighter, escapeCode } from '../../core/codePreview.js';
import { HighlightPool } from './highlightPool.js';

/** Languages and grammars that installed extensions contribute, as VS Code reads them. */
export interface TextMateContributions {
  readonly languages: readonly { readonly id: string; readonly extensions: readonly string[]; readonly filenames: readonly string[] }[];
  readonly grammars: readonly { readonly scopeName: string; readonly path: string; readonly language?: string; readonly injectTo?: readonly string[] }[];
}

export type ThemeRule = IRawTheme['settings'][number];

/** The active color theme's token rules, with the user's `editor.tokenColorCustomizations` appended. */
export interface TextMateTheme {
  readonly rules: readonly ThemeRule[];
}

/** Token rule bits in the encoded token attributes of `tokenizeLine2`. */
const fontStyleMask = 0x7800;
const fontStyleOffset = 11;
const foregroundMask = 0xff8000;
const foregroundOffset = 15;
const italic = 1;
const bold = 2;
const underline = 4;

/** Lines longer than this are left plain, like VS Code's `editor.maxTokenizationLineLength`. */
const maxLineLength = 20_000;
const timeLimitMs = 500;
const hexColor = /^#(?:[0-9a-f]{6}|[0-9a-f]{8})$/iu;

let wasm: Promise<void> | undefined;

/** Color code like the editor: VS Code's grammars, the user's theme and token color settings. */
export class TextMateHighlighter implements EditorHighlighter {
  readonly highlightAll?: (sources: readonly CodeSource[]) => Promise<readonly (string | undefined)[]>;
  readonly #pool: HighlightPool | undefined;
  readonly #registry: Registry;
  readonly #grammars = new Map<string, Promise<IGrammar | null>>();
  readonly #loaded = new Map<string, IGrammar | null>();
  readonly #colors: readonly string[];
  /** Class names per token attribute value; this theme's colors only, so it goes with the highlighter. */
  readonly #classNames = new Map<number, string>();

  /** `workerPath` is the bundled highlight worker; given it, `highlightAll` colors on worker threads. */
  constructor(private readonly contributions: TextMateContributions, theme: TextMateTheme, wasmPath: string, workerPath?: string) {
    if (workerPath !== undefined) {
      const pool = this.#pool = new HighlightPool(workerPath, { contributions, theme, wasmPath });
      this.highlightAll = (sources) => pool.run(sources);
    }
    wasm ??= readFile(wasmPath).then((data) => loadWASM({ data }));
    const byScope = new Map(contributions.grammars.map((grammar) => [grammar.scopeName, grammar]));
    this.#registry = new Registry({
      onigLib: wasm.then(() => ({ createOnigScanner: (patterns) => new OnigScanner(patterns), createOnigString: (text) => new OnigString(text) })),
      loadGrammar: async (scopeName) => {
        const grammar = byScope.get(scopeName);
        return grammar === undefined ? null : parseRawGrammar(await readFile(grammar.path, 'utf8'), grammar.path);
      },
      getInjections: (scopeName) => contributions.grammars.filter((grammar) => grammar.injectTo?.includes(scopeName)).map((grammar) => grammar.scopeName),
      theme: { settings: [...theme.rules] },
    });
    this.#colors = this.#registry.getColorMap();
  }

  /** Load the grammars for these files so `highlight` can color them. */
  async prepare(filePaths: readonly string[]): Promise<void> {
    await Promise.all(filePaths.map(async (filePath) => {
      const scope = this.#scopeOf(filePath);
      if (scope !== undefined) await this.#grammar(scope);
    }));
  }

  /** Escaped markup with `tm-` color classes, or undefined until the file's grammar is loaded. */
  highlight(code: string, filePath: string): string | undefined {
    const scope = this.#scopeOf(filePath);
    if (scope === undefined) return undefined;
    const grammar = this.#loaded.get(scope);
    if (grammar === undefined) {
      void this.#grammar(scope);
      return undefined;
    }
    if (grammar === null) return undefined;
    let state: StateStack = INITIAL;
    return code.split('\n').map((line) => {
      if (line.length > maxLineLength) return escapeCode(line);
      const { tokens, ruleStack } = grammar.tokenizeLine2(line, state, timeLimitMs);
      state = ruleStack;
      let html = '';
      for (let index = 0; index < tokens.length; index += 2) {
        const start = tokens[index] ?? 0;
        const end = tokens[index + 2] ?? line.length;
        const classes = this.#classes(tokens[index + 1] ?? 0);
        const text = escapeCode(line.slice(start, end));
        html += classes === '' || text === '' ? text : `<span class="${classes}">${text}</span>`;
      }
      return html;
    }).join('\n');
  }

  dispose(): void {
    this.#pool?.dispose();
  }

  /** CSS for the `tm-` classes this theme can produce. */
  styles(): string {
    const colors = this.#colors.filter((color) => hexColor.test(color)).map((color) => `.tm-${color.slice(1).toLowerCase()} { color: ${color}; }`);
    return [...new Set(colors), '.tm-i { font-style: italic; }', '.tm-b { font-weight: 600; }', '.tm-u { text-decoration: underline; }'].join('\n');
  }

  /** Classes for one token; the default foreground stays the page's editor color. */
  #classes(attributes: number): string {
    let classes = this.#classNames.get(attributes);
    if (classes === undefined) this.#classNames.set(attributes, classes = this.#buildClasses(attributes));
    return classes;
  }

  #buildClasses(attributes: number): string {
    const foreground = (attributes & foregroundMask) >>> foregroundOffset;
    const fontStyle = (attributes & fontStyleMask) >>> fontStyleOffset;
    const color = foreground > 1 ? this.#colors[foreground] : undefined;
    return [
      color === undefined || !hexColor.test(color) ? undefined : `tm-${color.slice(1).toLowerCase()}`,
      fontStyle & italic ? 'tm-i' : undefined,
      fontStyle & bold ? 'tm-b' : undefined,
      fontStyle & underline ? 'tm-u' : undefined,
    ].filter(Boolean).join(' ');
  }

  #grammar(scope: string): Promise<IGrammar | null> {
    let grammar = this.#grammars.get(scope);
    if (grammar === undefined) {
      grammar = this.#registry.loadGrammar(scope).catch(() => null);
      grammar.then((loaded) => { this.#loaded.set(scope, loaded); }, () => undefined);
      this.#grammars.set(scope, grammar);
    }
    return grammar;
  }

  /** The grammar scope VS Code would pick for a file name, by file name first and then the longest matching extension. */
  #scopeOf(filePath: string): string | undefined {
    const name = path.posix.basename(filePath).toLowerCase();
    let language: string | undefined;
    let matched = 0;
    for (const candidate of this.contributions.languages) {
      if (candidate.filenames.some((filename) => filename.toLowerCase() === name)) {
        language = candidate.id;
        break;
      }
      for (const extension of candidate.extensions) {
        if (extension.length > matched && name.endsWith(extension.toLowerCase())) {
          language = candidate.id;
          matched = extension.length;
        }
      }
    }
    return language === undefined ? undefined : this.contributions.grammars.find((grammar) => grammar.language === language)?.scopeName;
  }
}
