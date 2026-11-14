import { parse as parseJsonc } from 'jsonc-parser/lib/esm/main.js';
import { readFile } from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { useEditorHighlighter } from '../../core/codePreview.js';
import { type TextMateContributions, TextMateHighlighter, type ThemeRule } from './textMateHighlighter.js';

export { type TextMateContributions, TextMateHighlighter } from './textMateHighlighter.js';

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
export async function editorHighlighter(wasmPath: string, workerPath: string): Promise<TextMateHighlighter | undefined> {
  const extensions = vscode.extensions.all as readonly ContributedExtension[];
  const name = activeThemeName() ?? 'Default Dark Modern';
  for (const { extensionPath, packageJSON } of extensions) {
    const theme = packageJSON.contributes?.themes?.find((candidate) => candidate.id === name || candidate.label === name);
    if (theme === undefined || typeof theme.path !== 'string') continue;
    const rules = await readThemeRules(path.join(extensionPath, theme.path)).catch(() => undefined);
    if (rules === undefined) return undefined;
    const customizations = customizationRules(vscode.workspace.getConfiguration('editor').get('tokenColorCustomizations'), name);
    return new TextMateHighlighter(installedContributions(extensions), { rules: [...rules, ...customizations] }, wasmPath, workerPath);
  }
  return undefined;
}

/** Highlight code in the editor's theme, loading it again when the theme, an extension or a color setting changes. */
export function registerEditorHighlighter(context: vscode.ExtensionContext): vscode.Disposable[] {
  let themeLoads = 0;
  const loadHighlighter = (): void => {
    const load = ++themeLoads;
    void editorHighlighter(context.asAbsolutePath(path.join('dist', 'onig.wasm')), context.asAbsolutePath(path.join('dist', 'highlight-worker.cjs'))).catch(() => undefined).then((highlighter) => {
      if (load === themeLoads) useEditorHighlighter(highlighter);
      else highlighter?.dispose();
    });
  };
  loadHighlighter();
  return [
    { dispose: () => { themeLoads++; useEditorHighlighter(undefined); } },
    vscode.window.onDidChangeActiveColorTheme(loadHighlighter),
    vscode.extensions.onDidChange(loadHighlighter),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration('editor.tokenColorCustomizations') || event.affectsConfiguration('workbench.colorTheme')) loadHighlighter();
    }),
  ];
}
