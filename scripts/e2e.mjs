// Drives the installed extension in one real VS Code window through each scenario in turn.
// Usage: npm run e2e [-- --vsix <file>] [--code <binary>] [--out <dir>] [--keep]
import { spawn, execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chmod, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parse } from 'jsonc-parser';
import { chromium } from 'playwright-core';
import { createRequire } from 'node:module';

const args = process.argv.slice(2);
const option = (name) => { const at = args.indexOf(name); return at < 0 ? undefined : args.splice(at, 2)[1]; };
const keep = args.includes('--keep');
const out = resolve(option('--out') ?? '.render/e2e');
const metadata = JSON.parse(await readFile('package.json', 'utf8'));
const vsix = resolve(option('--vsix') ?? `${metadata.name}-${metadata.version}.vsix`);
const code = option('--code') ?? (process.platform === 'darwin' ? '/Applications/Visual Studio Code.app/Contents/MacOS/Code' : '/usr/share/code/code');
// The CLI sits beside the binary in the macOS app, the Linux tarball and the .deb install alike.
const cli = join(code, process.platform === 'darwin' ? '../../Resources/app/bin/code' : '../bin/code');
if (!existsSync(vsix)) throw new Error(`${vsix} is missing. Run npm run package first.`);
await mkdir(out, { recursive: true });
const fixtures = resolve('.render/e2e-fixtures.cjs');
if (args.includes('--prepare')) {
  const { build } = await import('esbuild');
  await build({ entryPoints: ['test/render/fixtures.ts'], outfile: fixtures, bundle: true, platform: 'node', format: 'cjs', logLevel: 'error' });
  process.exit(0);
}
const { scenes } = createRequire(import.meta.url)(fixtures);
for (const file of await readdir(out)) if (file.startsWith('failure')) await rm(join(out, file), { force: true });

const root = await mkdtemp(join(tmpdir(), 'diffguide-e2e-'));
const userData = join(root, 'user-data');
const extensions = join(root, 'extensions');
const repo = join(root, 'repo');
const claude = join(root, 'mock-claude');
const terminalLaunch = join(root, 'terminal-launch.json');
await writeFile(claude, `#!/usr/bin/env node\nrequire('node:fs').writeFileSync(${JSON.stringify(terminalLaunch)}, JSON.stringify({ cwd: process.cwd(), args: process.argv.slice(2) }));\nsetInterval(() => {}, 1000);\n`);
await chmod(claude, 0o755);
const git = (...command) => execFileSync('git', command, { cwd: repo, stdio: 'pipe' });
await mkdir(join(repo, 'src'), { recursive: true });
const before = Array.from({ length: 12 }, (_, index) => `export const value${index + 1} = ${index + 1};`);
await writeFile(join(repo, 'src/app.ts'), before.join('\n') + '\n');
git('init', '-q', '-b', 'main');
git('-c', 'user.name=e2e', '-c', 'user.email=e2e@example.test', 'add', '.');
git('-c', 'user.name=e2e', '-c', 'user.email=e2e@example.test', 'commit', '-q', '-m', 'init');
// The mock forge checks PRs out on top of origin/main.
execFileSync('git', ['clone', '-q', '--bare', repo, join(root, 'origin.git')], { stdio: 'pipe' });
git('remote', 'add', 'origin', join(root, 'origin.git'));
git('fetch', '-q', 'origin');
await writeFile(join(repo, 'src/app.ts'), before.map((line, index) => index === 4 ? 'export const value5 = parse(input) ?? 5;' : line).join('\n') + '\n');

const userSettings = process.platform === 'darwin' ? join(homedir(), 'Library/Application Support/Code/User/settings.json') : join(homedir(), '.config/Code/User/settings.json');
const theme = existsSync(userSettings) ? parse(await readFile(userSettings, 'utf8'))?.['workbench.colorTheme'] : undefined;
await mkdir(join(userData, 'User'), { recursive: true });
await writeFile(join(userData, 'User/settings.json'), JSON.stringify({
  'security.workspace.trust.enabled': false, 'workbench.startupEditor': 'none', 'workbench.tips.enabled': false,
  'update.mode': 'none', 'extensions.autoUpdate': false, 'telemetry.telemetryLevel': 'off', 'window.restoreWindows': 'none',
  'chat.disableAIFeatures': true, 'diffGuide.mockPullRequests': true, 'diffGuide.claudePath': claude, ...theme ? { 'workbench.colorTheme': theme } : {},
}));
// Only themes that ship with VS Code are available in the throwaway profile; others fall back to the default.
execFileSync(cli, ['--user-data-dir', userData, '--extensions-dir', extensions, '--install-extension', vsix, '--force'], { stdio: 'pipe' });

const port = await new Promise((done) => { const server = createServer().listen(0, () => { const { port } = server.address(); server.close(() => done(port)); }); });
const app = spawn(code, [
  '--user-data-dir', userData, '--extensions-dir', extensions, '--remote-debugging-port=' + port,
  '--disable-workspace-trust', '--skip-welcome', '--skip-release-notes', '--disable-telemetry', '--new-window', repo,
  // Docker gives a container 64 MB of /dev/shm, too little for the window to survive a reload.
  ...process.platform === 'linux' ? ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'] : [],
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

const palette = async (workbench, title) => {
  await workbench.keyboard.press(process.platform === 'darwin' ? 'Meta+Shift+P' : 'Control+Shift+P');
  await workbench.keyboard.type(title);
  await workbench.waitForSelector('.quick-input-list .monaco-list-row', { timeout: 10_000 });
  await workbench.keyboard.press('Enter');
};
/** The review page frame that shows `selector`, so a page closed by an earlier scenario is skipped. */
const reviewPage = (workbench, selector) => until('the review page', async () => {
  for (const frame of workbench.frames()) if (await frame.$('#view-code') && await frame.$(selector)) return frame;
  return undefined;
}, 30_000);

/** Each scenario starts with no editors open and leaves its own files untouched by the others. */
const scenarios = [
  {
    name: 'local review',
    async run(workbench, step) {
      await palette(workbench, 'DiffGuide: Review local changes');
      const page = await reviewPage(workbench, 'body');
      step('Review local changes opened the review page');

      if (await page.isVisible('#view-code') || await page.isVisible('#view-overview') || await page.isVisible('#finish-review')) throw new Error('Local mode still shows tabs or Finish review');
      await page.waitForSelector('#panel-files:visible #code-bar', { timeout: 5_000 });
      if (await page.isVisible('#panel-overview')) throw new Error('Local mode still shows Overview');
      step('Local mode opened Code directly without tabs, Overview or Finish review');
      const line = 'td.num.pick[data-path="src/app.ts"][data-side="new"]';
      await page.waitForSelector(line, { timeout: 15_000 });
      await page.waitForSelector('.file[data-path="src/app.ts"] td.code span', { timeout: 15_000 });
      step('The diff got its syntax colors');
      const cell = await until('line 5 of src/app.ts', async () => {
        for (const each of await page.$$(line)) if ((await each.textContent())?.trim() === '5') return each;
        return undefined;
      });
      await cell.click();
      await page.waitForSelector('textarea[data-draft="composer"]', { timeout: 5_000 });
      await page.fill('textarea[data-draft="composer"]', 'Why the fallback here?');
      await page.click('.composer-actions button:has-text("Ask")');
      step('Commented on src/app.ts:5 and sent it with Ask');

      await page.waitForSelector('#files tr.inline .thread >> text=Simulated agent:', { timeout: 30_000 });
      await workbench.screenshot({ path: join(out, 'local-answered.png') });
      step('The simulated agent answer appeared in the thread under its line');

      await page.click('#claude-chip');
      await page.waitForSelector('#claude-menu:visible #claude-body .claude-head', { timeout: 5_000 });
      await page.click('#claude-chip');
      await page.waitForSelector('#claude-menu', { state: 'hidden', timeout: 5_000 });
      step('The Claude chip opened and closed its menu');

      await page.click('button:has-text("Resolve")');
      await page.locator('.state:visible', { hasText: 'Resolved' }).first().waitFor({ timeout: 10_000 });
      await workbench.screenshot({ path: join(out, 'local-resolved.png') });
      step('Resolve marked the thread resolved');
    },
  },
  {
    name: 'pull request',
    async run(workbench, step) {
      await palette(workbench, 'Focus on Pull Requests View');
      const row = (title) => workbench.locator(`.monaco-list-row[aria-label*="${title}"]`).first();
      await row('Add pull request sidebar').waitFor({ timeout: 30_000 });
      await row('Migrate auth to OAuth device flow').waitFor({ timeout: 5_000 });
      await workbench.screenshot({ path: join(out, 'pr-sidebar.png') });
      step('The sidebar listed the mock PRs in Mine and Review requested');

      await row('Migrate auth to OAuth device flow').click();
      const page = await reviewPage(workbench, 'text=Sample pull request');
      await page.evaluate(() => {
        window.__layoutState = JSON.parse(document.querySelector('#initial').textContent).state;
        window.addEventListener('message', (event) => { if (event.data?.state) window.__layoutState = event.data.state; });
      });
      await page.click('#view-code');
      await page.waitForSelector('td.num.pick[data-path="docs/sample-page.html"][data-side="new"]', { timeout: 30_000 });
      await workbench.screenshot({ path: join(out, 'pr-files.png') });
      step('Opening #201 checked it out and showed its diff');
      // The tab shown while the worktree is made is the one the page opens in.
      const tabs = await workbench.locator('.tabs-container .tab[aria-label*="201"]').count();
      if (tabs !== 1) throw new Error(`expected one tab for #201, found ${tabs}`);
      step('The page of #201 opened in the tab shown while its worktree was made');

      await page.click('#refresh');
      await page.locator('#notice', { hasText: 'Refreshed.' }).waitFor({ timeout: 30_000 });
      await until('the Refresh button to settle', async () => !await page.$('#refresh.busy') && !await page.$('#refresh[disabled]'), 5_000);
      step('Refresh said Refreshed. and the button settled');

      await page.click('#page-menu-button');
      for (const [selector, text] of [['#pr', 'Open on GitHub'], ['#remove-worktree', 'Remove worktree'], ['#terminal', 'Open in terminal'], ['#link-pr', 'Link a PR']]) {
        await page.locator(selector, { hasText: text }).waitFor({ timeout: 5_000 });
      }
      await workbench.screenshot({ path: join(out, 'pr-page-menu.png') });
      await page.click('#remove-worktree');
      await page.locator('.ask-menu', { hasText: 'Remove worktree' }).waitFor({ timeout: 5_000 });
      await page.click('.ask-menu button:has-text("Cancel")');
      await page.waitForSelector('.ask-menu', { state: 'detached', timeout: 5_000 });
      await page.click('#page-menu-button');
      await page.click('#link-pr');
      await page.waitForSelector('.link-form input[aria-label="PR to link"]', { timeout: 5_000 });
      const linkActionsAligned = await page.evaluate(() => {
        const field = document.querySelector('.link-form input').getBoundingClientRect();
        const confirm = document.querySelector('.link-form button:last-child').getBoundingClientRect();
        return Math.abs(field.right - confirm.right) <= 1;
      });
      if (!linkActionsAligned) throw new Error('Link a PR actions do not align with the right of the field');
      await page.press('.link-form input', 'Escape');
      await page.waitForSelector('.link-form', { state: 'detached', timeout: 5_000 });
      await page.press('#page-menu-button', 'Escape');
      step('The header menu labeled its actions, Remove worktree kept its confirm, and Link a PR opened an inline form');

      await page.click('#view-overview');
      await page.waitForSelector('#merge-box #checks:visible', { timeout: 5_000 });
      if (await page.locator('#checks').count() !== 1 || await page.isVisible('#linked')) throw new Error('Overview repeats checks or shows an empty Linked changes card');
      await page.click('#details-box > summary');
      for (const selector of ['#assignees', '#labels', '#milestone']) await page.waitForSelector('#details-box ' + selector, { timeout: 5_000 });
      await workbench.screenshot({ path: join(out, 'pr-overview-details.png') });
      step('Overview put checks inside Merge, hid empty Linked changes, and unfolded Details');

      // Exercise editable layout from a controlled host state; the mock forge grants read access only.
      const original = await page.evaluate(() => window.__layoutState);
      await page.evaluate((state) => window.postMessage({ state: {
        ...state,
        unpushed: [{ oid: 'a'.repeat(40), subject: 'Layout fixture commit', author: 'e2e', createdAt: new Date().toISOString(), files: 1, additions: 1, deletions: 0 }],
        analysis: { running: false, stale: false, result: { head: 'a'.repeat(40), createdAt: new Date().toISOString(), overview: 'Layout fixture guide summary.', files: [], groups: [] } },
        details: { ...state.details, canEdit: false },
      } }, '*'), original);
      await page.waitForSelector('#unpushed-chip:visible', { timeout: 5_000 });
      await page.click('#unpushed-chip');
      await page.waitForSelector('#show-unpushed:visible', { timeout: 5_000 });
      if (await page.isVisible('#push')) throw new Error('Read-only PR shows Push');
      await page.press('#unpushed-chip', 'Escape');
      await page.evaluate((state) => window.postMessage({ state: {
        ...state,
        details: { ...state.details, canEdit: true, assignees: ['e2e'], labels: [{ name: 'layout', color: 'abcdef' }], milestone: { number: 1, title: 'Layout' } },
      } }, '*'), await page.evaluate(() => window.__layoutState));
      await page.click('#unpushed-chip');
      await page.waitForSelector('#push:visible', { timeout: 5_000 });
      if (await page.locator('#files-bar #push, #files-bar #show-unpushed').count()) throw new Error('Unpushed actions remain in the tab row');
      await workbench.screenshot({ path: join(out, 'pr-unpushed-menu.png') });
      await page.press('#unpushed-chip', 'Escape');
      const descriptionBeforeGuide = await page.evaluate(() => Boolean(document.querySelector('#body').compareDocumentPosition(document.querySelector('#overview-guide')) & Node.DOCUMENT_POSITION_FOLLOWING));
      if (!descriptionBeforeGuide) throw new Error('Overview guide precedes the description');
      await page.waitForSelector('#overview-guide:visible', { timeout: 5_000 });
      for (const [what, placeholder, value] of [['assignees', 'Filter people', 'e2e'], ['labels', 'Filter labels', 'layout'], ['milestone', 'Filter milestones', 'Layout']]) {
        await page.click('#pick-' + what);
        const input = `.picker input[placeholder="${placeholder}"]`;
        await page.waitForSelector(input, { timeout: 5_000 });
        await page.fill(input, value);
        await page.locator('#details-box .picker-row', { hasText: value }).waitFor({ timeout: 5_000 });
        await page.press(input, 'Escape');
        await page.waitForSelector(input, { state: 'detached', timeout: 5_000 });
      }
      await page.evaluate((state) => window.postMessage({ state }, '*'), original);
      await page.click('#view-code');
      step('Controlled host states kept Push permission-gated, placed unpushed actions by the branch, ordered description before guide, and opened all three Details pickers');

      // Finish review opens its form under the button and stays on Code.
      await page.click('#finish-review');
      await page.waitForSelector('#review-box:visible', { timeout: 5_000 });
      await page.locator('#finish-label', { hasText: 'Submit comment' }).waitFor({ timeout: 5_000 });
      if (!await page.isVisible('#panel-files') || await page.isVisible('#panel-overview')) throw new Error('Finish review left the Code tab');
      await page.press('#review', 'Escape');
      await page.waitForSelector('#review-box', { state: 'hidden', timeout: 5_000 });
      step('Finish review opened its form on Code, named Submit comment, and Escape closed it');
    },
  },
  {
    name: 'pending mock PR checks',
    async run(workbench, step) {
      await palette(workbench, 'Focus on Pull Requests View');
      await workbench.locator('.monaco-list-row[aria-label*="Migrate auth to OAuth device flow"]').first().click();
      const page = await reviewPage(workbench, 'text=Sample pull request');
      await page.click('#view-code');
      for (const verdict of ['comment', 'requestChanges', 'approve']) {
        await page.click('#finish-review');
        await page.fill('#review', `Mock QA ${verdict} summary`);
        await page.click(`[data-verdict="${verdict}"]`);
        await page.click('#finish-review');
        await page.locator('#error', { hasText: 'Sample pull requests cannot be reviewed.' }).waitFor({ timeout: 10_000 });
        if (await page.inputValue('#review') !== `Mock QA ${verdict} summary`) throw new Error('Failed review lost its summary');
        await page.waitForSelector('#finish-review:not([disabled])', { timeout: 5_000 });
        await page.press('#review', 'Escape');
      }
      step('All three verdicts reached the mock host, showed its rejection, preserved the summary and released the submit button');

      // Host refreshes cannot replace a controlled page state while its UI is under test.
      await page.evaluate(() => window.addEventListener('message', (event) => {
        if (event.data?.state && !event.data.qa && window.__qaState) window.postMessage({ state: window.__qaState, qa: true }, '*');
      }, true));
      const sendScene = async (name) => {
        const messages = scenes[name].messages.map((message) => name === 'claude' || !message.state ? message
          : { ...message, state: { ...message.state, threads: message.state.threads.map(({ newAnswer, ...thread }) => thread) } });
        await page.evaluate((messages) => { for (const message of messages) { if (message.state) window.__qaState = message.state; window.postMessage({ ...message, qa: true }, '*'); } }, messages);
      };
      await sendScene('finishReview');
      await page.click('#finish-review');
      await page.locator('#pending-note', { hasText: '2 pending' }).waitFor();
      await page.click('#review-foot button:has-text("Discard pending")');
      await page.click('#review-foot button:has-text("Cancel")');
      await page.locator('#pending-note', { hasText: '2 pending' }).waitFor();
      await page.click('#review-foot button:has-text("Discard pending")');
      await page.click('#review-foot button.primary');
      await page.waitForSelector('#finish-review:not([disabled])');
      if (await page.textContent('#error')) throw new Error('Discard without a host pending review reported an error');
      await page.press('#review', 'Escape');
      step('With simulated pending comments, Discard supported Cancel and confirmation returned idle; the mock host has no pending review to discard');

      const suggestions = structuredClone(scenes.finishReview.state);
      suggestions.github[0].messages[0].suggestion = true;
      suggestions.threads = [];
      await page.evaluate((state) => { window.__qaState = state; window.postMessage({ state, qa: true }, '*'); }, suggestions);
      await page.click('.suggest-row button:has-text("Add to batch")');
      await page.click('#commit-batch');
      await page.locator('#error', { hasText: 'You do not have permission to edit this pull request.' }).waitFor();
      await page.waitForSelector('#finish-review:not([disabled])');
      step('A simulated picked suggestion reached the host and the read-only mock PR rejected the commit');

      await sendScene('code-guide');
      await page.click('#order-guide');
      await page.waitForSelector('.folded-body[hidden="until-found"]', { state: 'attached' });
      const lineCount = await page.locator('#files tr:is(.context,.add,.del)').count();
      if (lineCount !== 78) throw new Error(`Guide retained ${lineCount} lines instead of 78`);
      const target = await page.locator('.folded-body[hidden="until-found"]').first().evaluate((body) => {
        const cell = body.querySelector('td.code');
        return cell.textContent.trim();
      });
      await page.click('#title');
      await workbench.keyboard.press('Control+f');
      await workbench.keyboard.type(target);
      await workbench.keyboard.press('Enter');
      try {
        await until('find-in-page to unfold its match', () => page.$$eval('.folded-body:not([hidden])', (bodies, text) => bodies.some((body) => body.textContent.includes(text)), target), 10_000);
        step('A simulated guide retained all 78 lines and native find-in-page opened an unchanged folded run');
      } catch (error) {
        failures.push({ name: 'folded native find', step: 'Guide retained all 78 lines', error });
        await workbench.screenshot({ path: join(out, 'pr-guide-find-failure.png') });
        step('FAILED: native find-in-page did not open the folded match');
      }
      await workbench.keyboard.press('Escape');
      await workbench.screenshot({ path: join(out, 'pr-guide-find.png') });

      await page.click('#order-files');
      await sendScene('claude');
      await page.locator('[data-answer="11111111-1111-1111-1111-111111111111"]').scrollIntoViewIfNeeded();
      await page.waitForSelector('#claude-chip .chip-new:has-text("1 new")');
      await page.click('#claude-chip');
      await page.waitForSelector('#claude-menu .answer-row');
      const working = scenes.claude.steps.find((entry) => entry.send?.state?.claude.running).send;
      await page.evaluate((message) => { window.__qaState = message.state; window.postMessage({ ...message, qa: true }, '*'); }, working);
      await page.waitForSelector('#claude-chip.working');
      await page.waitForSelector('#claude-menu #stop-claude:visible');
      const reviewing = scenes.claude.steps.find((entry) => entry.send?.state?.review?.running).send;
      await page.evaluate((message) => { window.__qaState = message.state; window.postMessage({ ...message, qa: true }, '*'); }, reviewing);
      await page.waitForSelector('#claude-review .review-live');
      await page.click('#claude-chip');
      await page.locator('[data-answer="33333333-3333-3333-3333-333333333333"]').scrollIntoViewIfNeeded();
      await until('the visible answer to clear the new count', async () => (await page.textContent('#claude-chip .chip-new')) === '', 5_000);
      await workbench.screenshot({ path: join(out, 'pr-answers-seen.png') });
      step('Simulated work and code review appeared in the chip menu, and scrolling to the unseen answer cleared its count');
      await page.locator('#page-menu-button').scrollIntoViewIfNeeded();
      await page.click('#page-menu-button');
      await page.click('#terminal');
      const launch = await until('the simulated Claude terminal launch', async () => JSON.parse(await readFile(terminalLaunch, 'utf8')), 15_000);
      if (!launch.args.includes('--session-id') || !launch.cwd.includes('201')) throw new Error('The terminal did not launch a PR conversation in its worktree');
      step('Open in terminal launched a simulated Claude executable with a session in the PR worktree');
    },
  },
  {
    name: 'reload',
    async run(workbench, step) {
      await palette(workbench, 'DiffGuide: Review local changes');
      await reviewPage(workbench, 'body');
      await palette(workbench, 'Focus on Pull Requests View');
      await workbench.locator('.monaco-list-row[aria-label*="Migrate auth to OAuth device flow"]').first().click();
      const before = await reviewPage(workbench, 'text=Sample pull request');
      await before.click('#view-code');
      await before.click('#order-guide');
      await before.waitForSelector('#order-guide[aria-pressed=true]', { timeout: 5_000 });
      await before.click('#nav-toggle');
      await before.waitForSelector('#files-layout.list-hidden', { timeout: 5_000 });
      step('Opened the local page and the page of #201, on Code in Guide order with the list hidden');

      const tab = (label) => workbench.locator(`.tabs-container .tab[aria-label*="${label}"]`).first();
      const prTab = (await tab('201').getAttribute('aria-label')) ?? '';
      // The page holds keyboard focus, which swallows the palette shortcut.
      await workbench.click('.part.sidebar .composite.title');
      const loaded = await workbench.evaluate(() => performance.timeOrigin);
      await palette(workbench, 'Developer: Reload Window');
      await until('the window to reload', async () => await workbench.evaluate(() => performance.timeOrigin) !== loaded && await workbench.$('.monaco-workbench .tabs-container .tab'), 60_000);
      step('Reloaded the window');

      const after = await reviewPage(workbench, 'text=Sample pull request');
      await after.waitForSelector('#view-code[aria-selected=true]', { timeout: 10_000 });
      // The hidden list hides the order switch too.
      await after.waitForSelector('#order-guide[aria-pressed=true]', { state: 'attached', timeout: 5_000 });
      await after.waitForSelector('#files-layout.list-hidden', { timeout: 5_000 });
      await workbench.screenshot({ path: join(out, 'reload-pr.png') });
      step(`The PR page opened again in its tab (${prTab}), on Code in Guide order with the list hidden`);

      await tab('Local ·').click();
      const local = await until('the local page after the reload', async () => {
        for (const frame of workbench.frames()) if (await frame.$('#view-code') && !await frame.$('text=Sample pull request')) return frame;
        return undefined;
      });
      await local.waitForSelector('#panel-files:visible #code-bar', { timeout: 5_000 });
      if (await local.isVisible('#view-code') || await local.isVisible('#view-overview') || await local.isVisible('#finish-review') || await local.isVisible('#panel-overview')) throw new Error('Reload restored local tabs, Overview or Finish review');
      await workbench.screenshot({ path: join(out, 'reload-local.png') });
      step('The local page opened again in its tab');
    },
  },
];

let browser;
let workbench;
const failures = [];
let passed = 0;
const agent = { done: false };
try {
  browser = await until('VS Code to accept a debugger', () => chromium.connectOverCDP(`http://127.0.0.1:${port}`), 60_000);
  workbench = await until('the workbench window', async () => browser.contexts().flatMap((context) => context.pages()).find((page) => page.url().includes('workbench')), 30_000);
  workbench.setDefaultTimeout(10_000);
  workbench.on('pageerror', (error) => console.error('Page script: ' + error.message));
  await workbench.waitForSelector('.monaco-workbench', { timeout: 30_000 });
  console.log('VS Code started with the installed VSIX');
} catch (error) {
  failures.push({ name: 'startup', step: 'nothing', error });
}
const agentRun = workbench === undefined ? undefined : fakeAgent(agent);
for (const scenario of workbench === undefined ? [] : scenarios) {
  console.log(scenario.name);
  let last = 'nothing';
  const step = (name) => { last = name; console.log(`  - ${name}`); };
  try {
    await scenario.run(workbench, step);
    passed += 1;
  } catch (error) {
    failures.push({ name: scenario.name, step: last, error });
    console.error(`${scenario.name}: ${error.message}`);
    await workbench.screenshot({ path: join(out, `failure-${scenario.name.replaceAll(' ', '-')}.png`) }).catch(() => undefined);
  }
  await workbench.keyboard.press('Escape').catch(() => undefined);
  await workbench.click('.part.sidebar .composite.title').catch(() => undefined);
  await palette(workbench, 'View: Close All Editors').catch(() => undefined);
}
agent.done = true;
await agentRun;
await browser?.close().catch(() => undefined);
app.kill();
if (!keep) await rm(root, { recursive: true, force: true }).catch(() => undefined);
for (const { name, step, error } of failures) console.error(`FAILED ${name} after: ${step}\n${error.stack ?? error}`);
if (failures.length > 0) {
  console.error(`Screenshots in ${out}${keep ? `\nProfile and repo kept in ${root}` : ''}`);
  if (process.env.E2E_LOG) console.error(appLog.slice(-4000));
  process.exitCode = 1;
} else console.log(`passed: ${passed} scenarios, screenshots in ${out}`);
