// Renders the built review page with fixture scenes in a VS Code theme and screenshots it.
// Usage: npm run render -- [scene...] [--theme "<label>"] [--out <dir>]
import { build } from 'esbuild';
import { readFile, readdir, mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { parse } from 'jsonc-parser';
import { chromium } from 'playwright-core';

const args = process.argv.slice(2);
const option = (name) => { const at = args.indexOf(name); return at < 0 ? undefined : args.splice(at, 2)[1]; };
const out = resolve(option('--out') ?? '.render');
const themeOption = option('--theme');
await mkdir(out, { recursive: true });

const bundle = join(out, 'page.cjs');
await build({
  entryPoints: ['test/render/entry.ts'], outfile: bundle, alias: { vscode: resolve('test/fakes/vscode.ts') },
  loader: { '.md': 'text' }, bundle: true, platform: 'node', target: 'node20', format: 'cjs', logLevel: 'error',
});
const { overviewHtml, scenes } = createRequire(import.meta.url)(bundle);
const names = args.length ? args : Object.keys(scenes);
const unknown = names.filter((name) => !(name in scenes));
if (unknown.length) throw new Error(`Unknown scene: ${unknown.join(', ')}. Scenes: ${Object.keys(scenes).join(', ')}`);

const readJsonc = async (path) => parse(await readFile(path, 'utf8'));
const settingsPath = process.platform === 'darwin'
  ? join(homedir(), 'Library/Application Support/Code/User/settings.json')
  : join(homedir(), '.config/Code/User/settings.json');
const settings = existsSync(settingsPath) ? await readJsonc(settingsPath) : {};

/** Finds a theme by label in installed and built-in extensions, following its `include` chain. */
async function loadTheme(label) {
  const roots = [join(homedir(), '.vscode/extensions'), '/Applications/Visual Studio Code.app/Contents/Resources/app/extensions', '/usr/share/code/resources/app/extensions'];
  for (const root of roots.filter(existsSync)) {
    for (const entry of await readdir(root)) {
      const manifest = join(root, entry, 'package.json');
      if (!existsSync(manifest)) continue;
      const themes = (await readJsonc(manifest))?.contributes?.themes ?? [];
      const match = themes.find((theme) => (theme.label ?? theme.id) === label || theme.id === label);
      if (!match) continue;
      const colors = {};
      for (let path = join(root, entry, match.path); path;) {
        const theme = await readJsonc(path);
        for (const [key, value] of Object.entries(theme.colors ?? {})) colors[key] ??= value;
        path = theme.include ? join(dirname(path), theme.include) : undefined;
      }
      return { label, uiTheme: match.uiTheme, colors };
    }
  }
  return undefined;
}

const label = themeOption ?? settings['workbench.colorTheme'] ?? 'Dark Modern';
const theme = await loadTheme(label);
if (!theme) console.warn(`Theme "${label}" not found; rendering without theme colors.`);
const colors = theme?.colors ?? {};
const bodyClass = { 'vs': 'vscode-light', 'hc-black': 'vscode-high-contrast', 'hc-light': 'vscode-high-contrast-light' }[theme?.uiTheme] ?? 'vscode-dark';
const vars = {
  ...Object.fromEntries(Object.entries(colors).map(([key, value]) => [`--vscode-${key.replaceAll('.', '-')}`, value])),
  '--vscode-font-family': '-apple-system, BlinkMacSystemFont, sans-serif', '--vscode-font-size': '13px', '--vscode-font-weight': 'normal',
  '--vscode-editor-font-family': settings['editor.fontFamily'] ?? 'Menlo, Monaco, monospace',
  '--vscode-editor-font-size': `${settings['editor.fontSize'] ?? 12}px`,
};
const style = Object.entries(vars).map(([key, value]) => `${key}:${String(value).replaceAll('"', "'")}`).join(';');
const script = await readFile('dist/overview.js', 'utf8');

const browser = await chromium.launch();
let failed = false;
for (const name of names) {
  const scene = scenes[name];
  // The CSP blocks Playwright's injected scripts, and the page loads its script by URL; both are replaced here.
  const html = overviewHtml(scene.state, 'overview.js')
    .replace(/<meta http-equiv="Content-Security-Policy"[^>]*>/u, '')
    .replace('<html lang="en">', `<html lang="en" style="${style}">`)
    .replace(/<body([^>]*)>/u, `<body$1 class="${bodyClass}" style="background:${colors['editor.background'] ?? '#1e1e1e'};color:${colors['editor.foreground'] ?? '#ccc'}">`)
    .replace(/<script nonce="[^"]*" src="overview.js"><\/script>/u, '');
  const page = await browser.newPage({ viewport: { width: scene.width ?? 1280, height: scene.height ?? 900 }, deviceScaleFactor: 2 });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
  await page.setContent(html);
  await page.addScriptTag({ content: `window.__posted=[];window.acquireVsCodeApi=()=>({postMessage:(m)=>window.__posted.push(m),getState:()=>(${JSON.stringify(scene.saved ?? {})}),setState:()=>{}});` });
  await page.addScriptTag({ content: script });
  for (const message of scene.messages) await page.evaluate((m) => window.postMessage(m, '*'), message);
  await page.waitForTimeout(300);
  const shots = [];
  for (const step of scene.steps) {
    if (step.send) await page.evaluate((m) => window.postMessage(m, '*'), step.send);
    if (step.click) await page.click(step.click);
    if (step.scroll !== undefined) await page.evaluate((y) => window.scrollTo(0, y), step.scroll);
    if (step.scrollTo) await page.evaluate((selector) => document.querySelector(selector)?.scrollIntoView({ block: 'start' }), step.scrollTo);
    if (step.hover) await page.hover(step.hover);
    await page.waitForTimeout(step.wait ?? 200);
    if (step.expect) {
      const found = await page.$(step.expect);
      const text = found ? await found.textContent() : null;
      if (!found) errors.push(`expected ${step.expect}`);
      else if (step.text !== undefined && !text?.includes(step.text)) errors.push(`expected ${step.expect} to contain "${step.text}", got "${text?.trim()}"`);
    }
    if (step.absent && await page.$(step.absent)) errors.push(`expected no ${step.absent}`);
    if (step.shot) { await page.screenshot({ path: join(out, step.shot), fullPage: step.full === true }); shots.push(join(out, step.shot)); }
  }
  await writeFile(join(out, `${name}.posted.json`), JSON.stringify(await page.evaluate(() => window.__posted), null, 1));
  await page.close();
  failed ||= errors.length > 0;
  console.log(`${name}: ${shots.join(', ')}${errors.length ? `\n  page errors:\n  ${errors.join('\n  ')}` : ''}`);
}
await browser.close();
console.log(`theme: ${theme ? label : 'none'}`);
process.exitCode = failed ? 1 : 0;
