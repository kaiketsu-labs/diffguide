// Drives the installed extension in a real VS Code: local review page, comment, simulated agent answer, resolve.
// Usage: npm run e2e [-- --vsix <file>] [--code <binary>] [--out <dir>] [--keep]
import { spawn, execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parse } from 'jsonc-parser';
import { chromium } from 'playwright-core';

const args = process.argv.slice(2);
const option = (name) => { const at = args.indexOf(name); return at < 0 ? undefined : args.splice(at, 2)[1]; };
const keep = args.includes('--keep');
const out = resolve(option('--out') ?? '.render/e2e');
const metadata = JSON.parse(await readFile('package.json', 'utf8'));
const vsix = resolve(option('--vsix') ?? `${metadata.name}-${metadata.version}.vsix`);
const code = option('--code') ?? (process.platform === 'darwin' ? '/Applications/Visual Studio Code.app/Contents/MacOS/Code' : '/usr/share/code/code');
const cli = process.platform === 'darwin' ? '/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code' : '/usr/bin/code';
if (!existsSync(vsix)) throw new Error(`${vsix} is missing. Run npm run package first.`);
await mkdir(out, { recursive: true });
await rm(join(out, 'failure.png'), { force: true });

const root = await mkdtemp(join(tmpdir(), 'diffguide-e2e-'));
const userData = join(root, 'user-data');
const extensions = join(root, 'extensions');
const repo = join(root, 'repo');
const git = (...command) => execFileSync('git', command, { cwd: repo, stdio: 'pipe' });
await mkdir(join(repo, 'src'), { recursive: true });
const before = Array.from({ length: 12 }, (_, index) => `export const value${index + 1} = ${index + 1};`);
await writeFile(join(repo, 'src/app.ts'), before.join('\n') + '\n');
git('init', '-q', '-b', 'main');
git('-c', 'user.name=e2e', '-c', 'user.email=e2e@example.test', 'add', '.');
git('-c', 'user.name=e2e', '-c', 'user.email=e2e@example.test', 'commit', '-q', '-m', 'init');
await writeFile(join(repo, 'src/app.ts'), before.map((line, index) => index === 4 ? 'export const value5 = parse(input) ?? 5;' : line).join('\n') + '\n');

const userSettings = process.platform === 'darwin' ? join(homedir(), 'Library/Application Support/Code/User/settings.json') : join(homedir(), '.config/Code/User/settings.json');
const theme = existsSync(userSettings) ? parse(await readFile(userSettings, 'utf8'))?.['workbench.colorTheme'] : undefined;
await mkdir(join(userData, 'User'), { recursive: true });
await writeFile(join(userData, 'User/settings.json'), JSON.stringify({
  'security.workspace.trust.enabled': false, 'workbench.startupEditor': 'none', 'workbench.tips.enabled': false,
  'update.mode': 'none', 'extensions.autoUpdate': false, 'telemetry.telemetryLevel': 'off', 'window.restoreWindows': 'none',
  'chat.disableAIFeatures': true, ...theme ? { 'workbench.colorTheme': theme } : {},
}));
// Only themes that ship with VS Code are available in the throwaway profile; others fall back to the default.
execFileSync(cli, ['--user-data-dir', userData, '--extensions-dir', extensions, '--install-extension', vsix, '--force'], { stdio: 'pipe' });

const port = await new Promise((done) => { const server = createServer().listen(0, () => { const { port } = server.address(); server.close(() => done(port)); }); });
const app = spawn(code, [
  '--user-data-dir', userData, '--extensions-dir', extensions, '--remote-debugging-port=' + port,
  '--disable-workspace-trust', '--skip-welcome', '--skip-release-notes', '--disable-telemetry', '--new-window', repo,
  ...process.platform === 'linux' ? ['--no-sandbox', '--disable-gpu'] : [],
], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, VSCODE_CLI: undefined, ELECTRON_RUN_AS_NODE: undefined } });
let appLog = '';
app.stdout.on('data', (chunk) => { appLog += chunk; });
app.stderr.on('data', (chunk) => { appLog += chunk; });

const until = async (what, check, timeout = 30_000) => {
  const end = Date.now() + timeout;
  for (;;) {
    const value = await check().catch(() => undefined);
    if (value) return value;
    if (Date.now() > end) throw new Error(`Timed out waiting for ${what}.`);
    await new Promise((done) => setTimeout(done, 250));
  }
};

/** Answers every pending comment through the extension's local bridge, as the hook helper and MCP tools would. */
async function fakeAgent(stop) {
  const answered = new Set();
  while (!stop.done) {
    const files = (await readdir(userData, { recursive: true }).catch(() => [])).filter((path) => path.endsWith('connection.json'));
    for (const file of files) {
      const descriptor = JSON.parse(await readFile(join(userData, file), 'utf8').catch(() => '{}'));
      if (descriptor.workspaceRoot !== repo && descriptor.workspaceRoot !== await realRepo) continue;
      const headers = { authorization: `Bearer ${descriptor.token}`, 'x-diffguide-client': 'watcher' };
      const pending = await fetch(`${descriptor.url}/pending`, { headers }).then((response) => response.json()).catch(() => ({ events: [] }));
      for (const event of pending.events ?? []) {
        if (answered.has(event.id)) continue;
        answered.add(event.id);
        const update = (body) => fetch(`${descriptor.url}/update`, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify({ eventId: event.id, ...body }) });
        await update({ status: 'received' });
        await update({ status: 'answered', text: 'Simulated agent: `parse` returns undefined for empty input, so the fallback keeps 5.', title: 'Fallback for empty input' });
      }
    }
    await new Promise((done) => setTimeout(done, 500));
  }
}
const realRepo = import('node:fs/promises').then(({ realpath }) => realpath(repo));

const steps = [];
const step = (name) => { steps.push(name); console.log(`- ${name}`); };
const agent = { done: false };
let browser;
let failure;
try {
  browser = await until('VS Code to accept a debugger', () => chromium.connectOverCDP(`http://127.0.0.1:${port}`), 60_000);
  const workbench = await until('the workbench window', async () => browser.contexts().flatMap((context) => context.pages()).find((page) => page.url().includes('workbench')), 30_000);
  await workbench.waitForSelector('.monaco-workbench', { timeout: 30_000 });
  step('VS Code started with the installed VSIX');
  const agentRun = fakeAgent(agent);

  await workbench.keyboard.press(process.platform === 'darwin' ? 'Meta+Shift+P' : 'Control+Shift+P');
  await workbench.keyboard.type('DiffGuide: Review local changes');
  await workbench.waitForSelector('.quick-input-list .monaco-list-row', { timeout: 10_000 });
  await workbench.keyboard.press('Enter');
  const page = await until('the review page', async () => {
    for (const frame of workbench.frames()) if (await frame.$('#view-files')) return frame;
    return undefined;
  }, 30_000);
  step('Review local changes opened the review page');

  await page.click('#view-files');
  const line = 'td.num.pick[data-path="src/app.ts"][data-side="new"]';
  await page.waitForSelector(line, { timeout: 15_000 });
  const cell = await until('line 5 of src/app.ts', async () => {
    for (const each of await page.$$(line)) if ((await each.textContent())?.trim() === '5') return each;
    return undefined;
  });
  await cell.click();
  await page.waitForSelector('textarea[data-draft="composer"]', { timeout: 5_000 });
  await page.fill('textarea[data-draft="composer"]', 'Why the fallback here?');
  await page.click('.composer-actions button:has-text("Ask")');
  step('Commented on src/app.ts:5 and sent it with Ask');

  await page.waitForSelector('text=Simulated agent:', { timeout: 30_000 });
  await workbench.screenshot({ path: join(out, 'answered.png') });
  step('The simulated agent answer appeared in the thread');

  await page.click('button:has-text("Resolve")');
  await page.locator('.state:visible', { hasText: 'Resolved' }).first().waitFor({ timeout: 10_000 });
  await workbench.screenshot({ path: join(out, 'resolved.png') });
  step('Resolve marked the thread resolved');
  agent.done = true;
  await agentRun;
} catch (error) {
  failure = error;
  const page = browser?.contexts().flatMap((context) => context.pages())[0];
  await page?.screenshot({ path: join(out, 'failure.png') }).catch(() => undefined);
} finally {
  agent.done = true;
  await browser?.close().catch(() => undefined);
  app.kill();
  if (!keep) await rm(root, { recursive: true, force: true }).catch(() => undefined);
}
if (failure) {
  console.error(`FAILED after: ${steps.at(-1) ?? 'nothing'}\n${failure.stack ?? failure}\nScreenshot: ${join(out, 'failure.png')}${keep ? `\nProfile and repo kept in ${root}` : ''}`);
  if (process.env.E2E_LOG) console.error(appLog.slice(-4000));
  process.exitCode = 1;
} else console.log(`passed: ${steps.length} steps, screenshots in ${out}`);
