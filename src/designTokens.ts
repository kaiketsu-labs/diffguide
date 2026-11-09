/**
 * DiffGuide's design tokens: the one place to change colors, type, spacing and corners in every webview.
 * Each token becomes a CSS custom property of the same name (`brand` → `--brand`). Webview CSS uses only these properties.
 * The design system documents what each token is for.
 */

/** A token that follows the user's VS Code theme. The hex values are fallbacks for when VS Code does not set the variable. */
interface ThemeToken { readonly vscode: string; readonly dark: string; readonly light: string }

/** A token DiffGuide owns, per theme. */
interface BrandToken { readonly dark: string; readonly light: string }

const themeTokens: Readonly<Record<string, ThemeToken>> = {
  surface: { vscode: 'editor-background', dark: '#1f1f1f', light: '#ffffff' },
  'surface-raised': { vscode: 'editorWidget-background', dark: '#262729', light: '#f7f8f8' },
  'surface-sunken': { vscode: 'textCodeBlock-background', dark: '#181818', light: '#f2f3f3' },
  ink: { vscode: 'foreground', dark: '#cccccc', light: '#2b2b2b' },
  'ink-muted': { vscode: 'descriptionForeground', dark: '#9d9d9d', light: '#636669' },
  line: { vscode: 'input-border', dark: '#73777c', light: '#8a8f94' },
  'line-strong': { vscode: 'input-border', dark: '#73777c', light: '#8a8f94' },
  focus: { vscode: 'focusBorder', dark: '#3b9cf0', light: '#005fb8' },
  'action-secondary': { vscode: 'button-secondaryBackground', dark: '#313335', light: '#e6e8ea' },
  'on-action-secondary': { vscode: 'button-secondaryForeground', dark: '#cccccc', light: '#2b2b2b' },
  success: { vscode: 'testing-iconPassed', dark: '#4fbf7a', light: '#1a7f37' },
  warning: { vscode: 'editorWarning-foreground', dark: '#d9a33a', light: '#8a5d00' },
  danger: { vscode: 'testing-iconFailed', dark: '#f0726a', light: '#c4322a' },
  'diff-add': { vscode: 'diffEditor-insertedLineBackground', dark: '#9bb95533', light: '#9bb95533' },
  'diff-del': { vscode: 'diffEditor-removedLineBackground', dark: '#ff000033', light: '#ff00001f' },
  'git-added': { vscode: 'gitDecoration-addedResourceForeground', dark: '#81b88b', light: '#587c0c' },
  'git-modified': { vscode: 'gitDecoration-modifiedResourceForeground', dark: '#e2c08d', light: '#895503' },
  'git-deleted': { vscode: 'gitDecoration-deletedResourceForeground', dark: '#c74e39', light: '#ad0707' },
  'git-renamed': { vscode: 'gitDecoration-renamedResourceForeground', dark: '#73c991', light: '#007100' },
  // Our own color contributions in package.json, so users can override them; keep their defaults in sync.
  'brand-soft': { vscode: 'diffGuide-selectionBackground', dark: '#ffffff1a', light: '#0000000f' },
  'brand-line': { vscode: 'diffGuide-selectionBorder', dark: '#ffffff66', light: '#00000059' },
  'code-ink': { vscode: 'diffGuide-inlineCodeForeground', dark: '#eb9bc9', light: '#b0306f' },
};

const brandTokens: Readonly<Record<string, BrandToken>> = {
  // The coding agent, whichever one runs: its actions, replies and the orb that stands for it.
  agent: { dark: '#7fc0de', light: '#2f7ea6' },
  'agent-soft': { dark: '#7fc0de2e', light: '#2f7ea61f' },
  'on-agent': { dark: '#0b1f2a', light: '#ffffff' },
  github: { dark: '#7fa8f0', light: '#2f5fc4' },
  'github-soft': { dark: '#7fa8f024', light: '#2f5fc41a' },
  // GitHub's attention yellow (Primer), so pending review comments look like they do on GitHub.
  pending: { dark: '#d29922', light: '#9a6700' },
  'pending-soft': { dark: '#d2992226', light: '#9a67001a' },
  'danger-soft': { dark: '#f0726a26', light: '#c4322a14' },
  'shadow-overlay': { dark: '0 4px 16px rgba(0,0,0,.35)', light: '0 4px 16px rgba(0,0,0,.12)' },
};

/** Tokens that point at another token, in every theme. You are neutral: your accent is the theme's text color, so only the agent and GitHub carry a hue. */
const aliases: Readonly<Record<string, string>> = {
  brand: 'ink',
  'on-brand': 'surface',
  action: 'brand',
  'on-action': 'on-brand',
  // The orb's shading tones derive from its color.
  orb: 'agent',
  'orb-soft': 'agent-soft',
};

const fixedTokens: Readonly<Record<string, string>> = {
  'font-ui': "system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Arial, sans-serif",
  'font-code': "'SF Mono', SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', monospace",
  'space-2': '2px', 'space-4': '4px', 'space-6': '6px', 'space-8': '8px', 'space-12': '12px', 'space-16': '16px', 'space-24': '24px', 'space-32': '32px',
  'radius-sm': 'var(--vscode-cornerRadius-small, 4px)',
  'radius-md': '6px',
  'radius-lg': 'var(--vscode-cornerRadius-large, 8px)',
  'radius-pill': '999px',
};

/** High-contrast themes carry contrast in their own variables: tints go transparent and lines use the contrast border. */
const highContrast: Readonly<Record<string, string>> = {
  'brand-soft': 'transparent', 'agent-soft': 'transparent', 'github-soft': 'transparent', 'pending-soft': 'transparent', 'danger-soft': 'transparent',
  line: 'var(--vscode-contrastBorder)', 'line-strong': 'var(--vscode-contrastBorder)', 'shadow-overlay': 'none',
};

function declarations(theme: 'dark' | 'light'): string {
  const lines = [
    ...Object.entries(themeTokens).map(([name, token]) => `--${name}:var(--vscode-${token.vscode},${token[theme]});`),
    ...Object.entries(brandTokens).map(([name, token]) => `--${name}:${token[theme]};`),
  ];
  return lines.join('');
}

/** CSS that defines every token. Dark values are the default; VS Code's body classes switch to light or high contrast. */
export const designTokenStyles = [
  `:root{${declarations('dark')}${Object.entries(fixedTokens).map(([name, value]) => `--${name}:${value};`).join('')}}`,
  `body.vscode-light,body.vscode-high-contrast-light{${declarations('light')}}`,
  `body.vscode-high-contrast,body.vscode-high-contrast-light{${Object.entries(highContrast).map(([name, value]) => `--${name}:${value};`).join('')}}`,
  `:root,body{${Object.entries(aliases).map(([name, target]) => `--${name}:var(--${target});`).join('')}}`,
].join('\n');
