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
  await page.addScriptTag({ content: `window.__posted=[];window.acquireVsCodeApi=()=>({postMessage:(m)=>window.__posted.push(m),getState:()=>(${JSON.stringify(scene.saved ?? {})}),setState:()=>{}});Object.defineProperty(navigator,'clipboard',{value:{writeText:async(t)=>{document.body.dataset.copied=t;}}});` });
  await page.addScriptTag({ content: script });
  for (const message of scene.messages) await page.evaluate((m) => window.postMessage(m, '*'), message);
  await page.waitForTimeout(300);
  const shots = [];
  for (const step of scene.steps) {
    const top = (selector) => page.evaluate((s) => document.querySelector(s)?.getBoundingClientRect().top, selector);
    const before = step.stay ? await top(step.stay) : undefined;
    if (step.send) await page.evaluate((m) => window.postMessage(m, '*'), step.send);
    if (step.select) await page.evaluate((selector) => { const node = document.querySelector(selector); if (node) getSelection().selectAllChildren(node); document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true })); }, step.select);
    if (step.drag) {
      const [from, to] = await Promise.all(step.drag.map((selector) => page.$eval(selector, (node) => { const r = node.getBoundingClientRect(); return { x: r.left, y: r.top + r.height / 2, right: r.right }; })));
      await page.mouse.move(from.x + 40, from.y);
      await page.mouse.down();
      await page.mouse.move(to.x + 120, to.y, { steps: 5 });
      await page.mouse.up();
    }
    if (step.click) await page.click(step.click);
    if (step.fill) await page.fill(...step.fill);
    if (step.press) await page.keyboard.press(step.press);
    if (step.scroll !== undefined) await page.evaluate((y) => window.scrollTo(0, y), step.scroll);
    if (step.scrollTo) await page.evaluate((selector) => document.querySelector(selector)?.scrollIntoView({ block: 'start' }), step.scrollTo);
    if (step.hover) await page.hover(step.hover);
    await page.waitForTimeout(step.wait ?? 200);
    if (step.expect) {
      const found = await page.$(step.expect);
      const text = found ? await found.textContent() : null;
      if (!found) errors.push(`expected ${step.expect}`);
      else if (step.count !== undefined && (await page.$$(step.expect)).length !== step.count) errors.push(`expected ${step.count} of ${step.expect}, got ${(await page.$$(step.expect)).length}`);
      else if (step.text !== undefined && !text?.includes(step.text)) errors.push(`expected ${step.expect} to contain "${step.text}", got "${text?.trim()}"`);
    }
    if (step.stay) {
      const after = await top(step.stay);
      if (before === undefined || after !== before) errors.push(`expected ${step.stay} to stay at ${before}, got ${after}`);
    }
    if (step.below) {
      const [lower, upper] = await page.evaluate(([a, b]) => [document.querySelector(a)?.getBoundingClientRect().top, document.querySelector(b)?.getBoundingClientRect().bottom], step.below);
      if (lower === undefined || upper === undefined || lower < upper) errors.push(`expected ${step.below[0]} (top ${lower}) below ${step.below[1]} (bottom ${upper})`);
    }
    if (step.after) {
      const [left, right] = await page.evaluate(([a, b]) => [document.querySelector(a)?.getBoundingClientRect().left, document.querySelector(b)?.getBoundingClientRect().right], step.after);
      if (left === undefined || right === undefined || left < right) errors.push(`expected ${step.after[0]} (left ${left}) after ${step.after[1]} (right ${right})`);
    }
    if (step.next) {
      const [left, right] = await page.evaluate(([a, b]) => [document.querySelector(a)?.getBoundingClientRect().left, document.querySelector(b)?.getBoundingClientRect().right], step.next);
      if (left === undefined || right === undefined || left < right || left - right > step.next[2]) errors.push(`expected ${step.next[0]} (left ${left}) within ${step.next[2]} px after ${step.next[1]} (right ${right})`);
    }
    if (step.inside) {
      // Measures a's contents, not its box, so text that spills out of a shrunken box counts.
      const [inner, outer] = await page.evaluate(([a, b]) => {
        const node = document.querySelector(a);
        const range = document.createRange();
        if (node) range.selectNodeContents(node);
        const box = (r) => r && { left: r.left, right: r.right };
        return [node ? box(range.getBoundingClientRect()) : undefined, box(document.querySelector(b)?.getBoundingClientRect())];
      }, step.inside);
      if (!inner || !outer || inner.left < outer.left - 1 || inner.right > outer.right + 1) errors.push(`expected ${step.inside[0]} (${inner?.left}-${inner?.right}) inside ${step.inside[1]} (${outer?.left}-${outer?.right})`);
    }
    if (step.tallest) {
      const height = await page.evaluate((s) => document.querySelector(s)?.getBoundingClientRect().height, step.tallest[0]);
      if (height === undefined || height > step.tallest[1]) errors.push(`expected ${step.tallest[0]} at most ${step.tallest[1]} px tall, got ${height}`);
    }
    if (step.css) {
      const value = await page.evaluate(([selector, pseudo, property]) => { const found = document.querySelector(selector); return found ? getComputedStyle(found, pseudo).getPropertyValue(property) : 'no such element'; }, step.css);
      if (value !== step.css[3]) errors.push(`expected ${step.css[0]} ${step.css[1]} ${step.css[2]} to be ${step.css[3]}, got ${value}`);
    }
    if (step.level) {
      const [a, b] = await page.evaluate((selectors) => selectors.map((s) => { const r = document.querySelector(s)?.getBoundingClientRect(); return r && r.top + r.height / 2; }), step.level);
      if (a === undefined || b === undefined || Math.abs(a - b) > 4) errors.push(`expected ${step.level[0]} (middle ${a}) level with ${step.level[1]} (middle ${b})`);
    }
    if (step.highlight) {
      const text = await page.evaluate((name) => [...(CSS.highlights.get(name) ?? [])].filter((range) => range.startContainer.isConnected).map((range) => range.toString()).join('|'), step.highlight[0]);
      if (text !== step.highlight[1]) errors.push(`expected highlight ${step.highlight[0]} to mark "${step.highlight[1]}", got "${text}"`);
    }
    if (step.value) {
      const value = await page.evaluate((selector) => document.querySelector(selector)?.value, step.value[0]);
      if (value !== step.value[1]) errors.push(`expected ${step.value[0]} to hold "${step.value[1]}", got "${value}"`);
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
