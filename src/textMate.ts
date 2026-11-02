import { readFile } from 'node:fs/promises';
import * as vscode from 'vscode';
import * as path from 'node:path';
import { parse as parseJsonc } from 'jsonc-parser/lib/esm/main.js';
import { loadWASM, OnigScanner, OnigString } from 'vscode-oniguruma';
import { INITIAL, Registry, parseRawGrammar, type IGrammar, type IRawTheme, type StateStack } from 'vscode-textmate';
import { escapeCode } from './codePreview.js';

/** Languages and grammars that installed extensions contribute, as VS Code reads them. */
export interface TextMateContributions {
  readonly languages: readonly { readonly id: string; readonly extensions: readonly string[]; readonly filenames: readonly string[] }[];
  readonly grammars: readonly { readonly scopeName: string; readonly path: string; readonly language?: string; readonly injectTo?: readonly string[] }[];
}

type ThemeRule = IRawTheme['settings'][number];

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
export class TextMateHighlighter {
  readonly #registry: Registry;
  readonly #grammars = new Map<string, Promise<IGrammar | null>>();
  readonly #loaded = new Map<string, IGrammar | null>();
  readonly #colors: readonly string[];

  constructor(private readonly contributions: TextMateContributions, theme: TextMateTheme, wasmPath: string) {
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

  /** CSS for the `tm-` classes this theme can produce. */
  styles(): string {
    const colors = this.#colors.filter((color) => hexColor.test(color)).map((color) => `.tm-${color.slice(1).toLowerCase()} { color: ${color}; }`);
    return [...new Set(colors), '.tm-i { font-style: italic; }', '.tm-b { font-weight: 600; }', '.tm-u { text-decoration: underline; }'].join('\n');
  }

  /** Classes for one token; the default foreground stays the page's editor color. */
  #classes(attributes: number): string {
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

/** Scopes VS Code colors for each shorthand key of `editor.tokenColorCustomizations`. */
const customizationScopes: Readonly<Record<string, readonly string[]>> = {
  comments: ['comment', 'punctuation.definition.comment'],
  strings: ['string', 'meta.embedded.assembly'],
  keywords: ['keyword - keyword.operator', 'keyword.control', 'storage', 'storage.type'],
  numbers: ['constant.numeric'],
  types: ['entity.name.type', 'entity.name.class', 'support.type', 'support.class'],
  functions: ['entity.name.function', 'support.function'],
  variables: ['variable', 'entity.name.variable'],
};

/** Token rules from a theme file, following `include` chains; undefined when a file in the chain has no JSON rules, such as a .tmTheme. */
export async function readThemeRules(themePath: string): Promise<ThemeRule[] | undefined> {
  const theme = parseJsonc(await readFile(themePath, 'utf8')) as { include?: unknown; tokenColors?: unknown } | undefined;
  if (typeof theme !== 'object' || theme === null) return undefined;
  const base = typeof theme.include === 'string' ? await readThemeRules(path.join(path.dirname(themePath), theme.include)) : [];
  if (base === undefined || (theme.tokenColors !== undefined && !Array.isArray(theme.tokenColors))) return undefined;
  return [...base, ...(theme.tokenColors ?? []) as ThemeRule[]];
}

/** Rules for `editor.tokenColorCustomizations`, both global and for the named theme. */
export function customizationRules(customizations: unknown, themeName: string): ThemeRule[] {
  if (typeof customizations !== 'object' || customizations === null) return [];
  const blocks = [customizations, (customizations as Record<string, unknown>)[`[${themeName}]`]];
  return blocks.flatMap((block): ThemeRule[] => {
    if (typeof block !== 'object' || block === null) return [];
    const entries = block as Record<string, unknown>;
    const shorthand = Object.entries(customizationScopes).flatMap(([key, scope]): ThemeRule[] => {
      const value = entries[key];
      if (typeof value === 'string') return [{ scope: [...scope], settings: { foreground: value } }];
      if (typeof value === 'object' && value !== null) return [{ scope: [...scope], settings: value as ThemeRule['settings'] }];
      return [];
    });
    return [...shorthand, ...Array.isArray(entries['textMateRules']) ? entries['textMateRules'] as ThemeRule[] : []];
  });
}

/** Packaged parts of an installed extension that the highlighter reads. */
interface ContributedExtension {
  readonly extensionPath: string;
  readonly packageJSON: { readonly contributes?: {
    readonly languages?: readonly { readonly id?: unknown; readonly extensions?: unknown; readonly filenames?: unknown }[];
    readonly grammars?: readonly { readonly scopeName?: unknown; readonly path?: unknown; readonly language?: unknown; readonly injectTo?: unknown }[];
    readonly themes?: readonly { readonly id?: unknown; readonly label?: unknown; readonly path?: unknown }[];
  } };
}

const strings = (value: unknown): string[] => Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];

/** Languages and grammars of every installed extension, built-in ones included. */
function installedContributions(extensions: readonly ContributedExtension[]): TextMateContributions {
  const languages: TextMateContributions['languages'][number][] = [];
  const grammars: TextMateContributions['grammars'][number][] = [];
  for (const { extensionPath, packageJSON } of extensions) {
    for (const language of packageJSON.contributes?.languages ?? []) {
      if (typeof language.id === 'string') languages.push({ id: language.id, extensions: strings(language.extensions), filenames: strings(language.filenames) });
    }
    for (const grammar of packageJSON.contributes?.grammars ?? []) {
      if (typeof grammar.scopeName !== 'string' || typeof grammar.path !== 'string') continue;
      grammars.push({
        scopeName: grammar.scopeName, path: path.join(extensionPath, grammar.path), injectTo: strings(grammar.injectTo),
        ...typeof grammar.language === 'string' ? { language: grammar.language } : {},
      });
    }
  }
  return { languages, grammars };
}

/** The theme VS Code shows, following automatic light and dark switching. */
function activeThemeName(): string | undefined {
  const workbench = vscode.workspace.getConfiguration('workbench');
  if (vscode.workspace.getConfiguration('window').get('autoDetectColorScheme', false)) {
    const kind = vscode.window.activeColorTheme.kind;
    const light = kind === vscode.ColorThemeKind.Light || kind === vscode.ColorThemeKind.HighContrastLight;
    return workbench.get<string>(light ? 'preferredLightColorTheme' : 'preferredDarkColorTheme');
  }
  return workbench.get<string>('colorTheme');
}

/** A highlighter for the current theme, or undefined when its token colors cannot be read. */
export async function editorHighlighter(wasmPath: string): Promise<TextMateHighlighter | undefined> {
  const extensions = vscode.extensions.all as readonly ContributedExtension[];
  const name = activeThemeName() ?? 'Default Dark Modern';
  for (const { extensionPath, packageJSON } of extensions) {
    const theme = packageJSON.contributes?.themes?.find((candidate) => candidate.id === name || candidate.label === name);
    if (theme === undefined || typeof theme.path !== 'string') continue;
    const rules = await readThemeRules(path.join(extensionPath, theme.path)).catch(() => undefined);
    if (rules === undefined) return undefined;
    const customizations = customizationRules(vscode.workspace.getConfiguration('editor').get('tokenColorCustomizations'), name);
    return new TextMateHighlighter(installedContributions(extensions), { rules: [...rules, ...customizations] }, wasmPath);
  }
  return undefined;
}
