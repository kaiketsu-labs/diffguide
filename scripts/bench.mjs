// Times the review page's user waits on fixed fixtures and compares runs.
// Usage: npm run bench -- [--runs 7] [--label name] [--scale 1] [--fixture typical|large]...
//        npm run bench -- --compare .bench/before.json .bench/after.json
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { build } from 'esbuild';
import { chromium } from 'playwright-core';

const args = process.argv.slice(2);
const option = (name, fallback) => { const at = args.indexOf(name); return at < 0 ? fallback : args.splice(at, 2)[1]; };
const options = (name) => { const found = []; for (let at = args.indexOf(name); at >= 0; at = args.indexOf(name)) found.push(args.splice(at, 2)[1]); return found; };

/** Commit ranges of this repository that stand in for PRs; pinned so every run reads the same diff. */
const fixtures = {
  typical: { base: '79b6c6088a24601fb6ba51f2eaa9ef1a20801fa5', head: 'f25ee0a3166720673f61f5bbdaa2f62fef3e4dc6' },
  large: { base: 'c6f292673870a9c39bcf13fa9a928249b41589cc', head: 'f25ee0a3166720673f61f5bbdaa2f62fef3e4dc6' },
};

const quantile = (values, q) => { const sorted = [...values].sort((a, b) => a - b); return sorted[Math.min(sorted.length - 1, Math.round(q * (sorted.length - 1)))]; };
const summary = (values) => ({ median: quantile(values, 0.5), p95: quantile(values, 0.95), runs: values.length });

/** Flatten nested numbers to `a.b` keys; lists become their length. */
function metrics(result, prefix = '', into = {}) {
  for (const [key, value] of Object.entries(result)) {
    const name = prefix ? `${prefix}.${key}` : key;
    if (typeof value === 'number') into[name] = value;
    else if (Array.isArray(value)) into[name] = value.length;
    else if (value && typeof value === 'object') metrics(value, name, into);
  }
  return into;
}

function aggregate(results) {
  const keys = Object.keys(metrics(results[0]));
  return Object.fromEntries(keys.map((key) => [key, summary(results.map((result) => metrics(result)[key]).filter((value) => value !== undefined))]));
}

const format = (value) => value === undefined ? '-' : Math.abs(value) >= 100 ? value.toFixed(0) : value.toFixed(1);

function table(rows) {
  const widths = rows[0].map((_, column) => Math.max(...rows.map((row) => String(row[column]).length)));
  return rows.map((row) => row.map((cell, column) => column === 0 ? String(cell).padEnd(widths[column]) : String(cell).padStart(widths[column])).join('  ')).join('\n');
}

if (args[0] === '--compare') {
  const [before, after] = await Promise.all(args.slice(1, 3).map(async (path) => JSON.parse(await readFile(path, 'utf8'))));
  for (const fixture of Object.keys(after.fixtures)) {
    const was = before.fixtures[fixture] ?? {};
    const now = after.fixtures[fixture];
    const rows = [['metric', 'before p50', 'after p50', 'change', 'before p95', 'after p95']];
    for (const key of Object.keys(now)) {
      const a = was[key]?.median;
      const b = now[key].median;
      const change = a === undefined || a === 0 ? '' : `${b - a >= 0 ? '+' : ''}${(((b - a) / a) * 100).toFixed(0)}%`;
      rows.push([key, format(a), format(b), change, format(was[key]?.p95), format(now[key].p95)]);
    }
    console.log(`\n${fixture} (${before.label} → ${after.label})\n${table(rows)}`);
  }
  process.exit(0);
}

const runs = Number(option('--runs', '7'));
const label = option('--label', execFileSync('git', ['rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim());
const scale = Number(option('--scale', '1'));
const chosen = options('--fixture');
const names = chosen.length ? chosen : Object.keys(fixtures);
await mkdir('.bench', { recursive: true });

await build({
  entryPoints: ['test/bench/host.ts'], outfile: '.bench/host.cjs', alias: { vscode: resolve('test/fakes/vscode.ts') }, external: ['vscode-oniguruma'],
  loader: { '.md': 'text' }, bundle: true, platform: 'node', target: 'node20', format: 'cjs', logLevel: 'error',
});
await build({ entryPoints: ['src/page/webview/main.ts'], outfile: '.bench/overview.js', bundle: true, platform: 'browser', target: 'chrome120', format: 'iife', loader: { '.md': 'text' }, logLevel: 'error' });
const script = await readFile('.bench/overview.js', 'utf8');

/** One extension-side run in a fresh process, so caches start cold. */
function hostRun(fixture, boot, dump) {
  const env = { ...process.env, BENCH_OPTIONS: JSON.stringify({ source: process.cwd(), ...fixture, boot, scale }), ...dump ? { BENCH_DUMP: dump } : {} };
  const child = spawnSync(process.execPath, ['.bench/host.cjs'], { env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (child.status !== 0) throw new Error(`host bench failed: ${child.stderr}`);
  return JSON.parse(child.stdout);
}

/** One page run in Chromium: boot until `ready`, then the files, a Viewed tick and a state update, each until the next frame is painted. */
async function pageRun(browser, dump) {
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  const html = dump.html.replace(/<meta http-equiv="Content-Security-Policy"[^>]*>/u, '').replace(/<script nonce="[^"]*" src="[^"]*"><\/script>/gu, '');
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.setContent(html);
  const boot = await page.evaluate(async (source) => {
    window.__posted = [];
    window.__long = [];
    new PerformanceObserver((list) => { for (const entry of list.getEntries()) window.__long.push(entry.duration); }).observe({ type: 'longtask' });
    window.acquireVsCodeApi = () => ({ postMessage: (message) => window.__posted.push([performance.now(), message]), getState: () => ({ view: 'files' }), setState: () => undefined });
    const start = performance.now();
    const tag = document.createElement('script');
    tag.textContent = source;
    document.body.append(tag);
    await new Promise((done) => requestAnimationFrame(() => setTimeout(done, 0)));
    const ready = window.__posted.find(([, message]) => message.action === 'ready');
    return { ready: ready[0] - start, painted: performance.now() - start };
  }, script);
  const deliver = (message) => page.evaluate(async (data) => {
    const start = performance.now();
    window.dispatchEvent(new MessageEvent('message', { data }));
    const handled = performance.now() - start;
    await new Promise((done) => requestAnimationFrame(() => setTimeout(done, 0)));
    return { handled, painted: performance.now() - start };
  }, message);
  const filesMessages = dump.messages.filter((message) => 'files' in message);
  const filesMessage = filesMessages[0];
  const stateMessage = { state: JSON.parse(dump.html.match(/<script[^>]*id="initial"[^>]*>([\s\S]*?)<\/script>/u)?.[1] ?? 'null')?.state };
  const files = await deliver(filesMessage);
  // The colored files replace the uncolored ones when they came in two messages.
  const colored = filesMessages.length > 1 ? await deliver(filesMessages.at(-1)) : undefined;
  const viewed = await page.evaluate(async () => {
    const box = document.querySelector('.file .viewed input');
    const start = performance.now();
    box.click();
    const handled = performance.now() - start;
    await new Promise((done) => requestAnimationFrame(() => setTimeout(done, 0)));
    return { handled, painted: performance.now() - start };
  });
  const state = stateMessage.state ? await deliver(stateMessage) : undefined;
  const long = await page.evaluate(() => window.__long);
  const nodes = await page.evaluate(() => document.getElementsByTagName('*').length);
  await page.close();
  if (errors.length) throw new Error(`page errors: ${errors.join('; ')}`);
  return { boot, files, ...colored ? { colored } : {}, viewed, ...state ? { state } : {}, longTasks: long.length, longTaskMs: long.reduce((sum, value) => sum + value, 0), nodes };
}

const report = { label, scale, runs, date: new Date().toISOString(), fixtures: {} };
const browser = await chromium.launch();
for (const name of names) {
  const fixture = fixtures[name];
  const dumpPath = resolve(`.bench/${name}.page.json`);
  hostRun(fixture, 150, dumpPath);
  const dump = JSON.parse(await readFile(dumpPath, 'utf8'));
  const pages = [];
  for (let run = 0; run < runs; run++) pages.push(await pageRun(browser, dump));
  const boot = quantile(pages.map((page) => page.boot.ready), 0.5);
  const hosts = [];
  for (let run = 0; run < runs; run++) hosts.push(hostRun(fixture, boot));
  report.fixtures[name] = { ...aggregate(hosts.map(({ coldTimeline: _, highlighter: __, ...rest }) => ({ host: rest }))), ...aggregate(pages.map((page) => ({ page }))) };
  report.timelines ??= {};
  report.timelines[name] = hosts[0].coldTimeline;
  const rows = [['metric', 'p50', 'p95']];
  for (const [key, value] of Object.entries(report.fixtures[name])) rows.push([key, format(value.median), format(value.p95)]);
  console.log(`\n${name}: ${hosts[0].files} files, ${hosts[0].highlighter}, ${runs} runs, GitHub latency ×${scale}\n${table(rows)}`);
}
await browser.close();
const out = `.bench/${label}.json`;
await writeFile(out, JSON.stringify(report, null, 1));
console.log(`\nwrote ${out}`);
