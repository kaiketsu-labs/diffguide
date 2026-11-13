// Times the extension side of a PR review page: opening it, ticking Viewed and refreshing, on a real git worktree with
// GitHub answering after measured latencies. Prints one JSON result; scripts/bench.mjs runs it and compares runs.
import childProcess from 'node:child_process';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as vscode from 'vscode';
import { reviewView } from '../../src/agents/claude/reviewRunner.js';
import { useEditorHighlighter } from '../../src/core/codePreview.js';
import { worktreePath } from '../../src/core/git/worktrees.js';
import { FileReviews } from '../../src/core/reviewedFiles.js';
import { createReviewStore } from '../../src/core/store.js';
import type { PageHost, PageSession } from '../../src/page/pullRequest/context.js';
import { pullRequestPageController } from '../../src/page/pullRequest/controller.js';
import { listRepositoryFiles, wholeFile } from '../../src/hosts/vscode/localReview.js';
import { readBaseContent } from '../../src/hosts/vscode/pullRequestDiff.js';
import { showPullRequestOverview } from '../../src/hosts/vscode/reviewPanel.js';
import { readThemeRules, TextMateHighlighter, type TextMateContributions } from '../../src/hosts/vscode/textMate.js';
import { benchForge } from './forge.js';
import type { FakePanel } from '../fakes/vscode.js';

const t0 = performance.now();
const clock = (): number => performance.now() - t0;

/** Git processes, by when they started and ended and their first argument. */
interface GitCall { readonly command: string; readonly start: number; end: number }
const gitCalls: GitCall[] = [];
let running = 0;
const track = (args: readonly string[]): GitCall => {
  const call = { command: args.find((arg, index) => index > 0 && args[index - 1] !== '-C' && args[index - 1] !== '-c' && !arg.startsWith('-') && arg !== args[0]) ?? '', start: clock(), end: NaN };
  gitCalls.push(call);
  running++;
  return call;
};
const done = (call: GitCall): void => { if (Number.isNaN(call.end)) { call.end = clock(); running--; } };
const execFile = childProcess.execFile;
const spawn = childProcess.spawn;
// Bundled modules read these properties at call time, so patching the module object counts every git process.
(childProcess as { execFile: unknown }).execFile = (file: string, args: readonly string[], ...rest: unknown[]) => {
  if (file !== 'git') return (execFile as (...a: unknown[]) => unknown)(file, args, ...rest);
  const call = track(['git', ...args]);
  const callback = rest.findIndex((value) => typeof value === 'function');
  if (callback >= 0) { const original = rest[callback] as (...a: unknown[]) => void; rest[callback] = (...result: unknown[]) => { done(call); original(...result); }; }
  return (execFile as (...a: unknown[]) => unknown)(file, args, ...rest);
};
(childProcess as { spawn: unknown }).spawn = (file: string, args: readonly string[], ...rest: unknown[]) => {
  const child = (spawn as (...a: unknown[]) => childProcess.ChildProcess)(file, args, ...rest);
  if (file === 'git') { const call = track(['git', ...args]); child.on('close', () => { done(call); }); child.on('error', () => { done(call); }); }
  return child;
};

const app = '/Applications/Visual Studio Code.app/Contents/Resources/app/extensions';

/** VS Code's built-in grammars and the Dark Modern theme, so code is colored as in the editor; undefined without a VS Code install. */
async function editorHighlighter(): Promise<TextMateHighlighter | undefined> {
  if (!existsSync(app)) return undefined;
  const contributions: { languages: TextMateContributions['languages'][number][]; grammars: TextMateContributions['grammars'][number][] } = { languages: [], grammars: [] };
  for (const entry of readdirSync(app)) {
    const manifest = join(app, entry, 'package.json');
    if (!existsSync(manifest)) continue;
    const contributes = (JSON.parse(readFileSync(manifest, 'utf8')) as { contributes?: { languages?: { id: string; extensions?: string[]; filenames?: string[] }[]; grammars?: { scopeName?: string; path?: string; language?: string; injectTo?: string[] }[] } }).contributes;
    for (const language of contributes?.languages ?? []) contributions.languages.push({ id: language.id, extensions: language.extensions ?? [], filenames: language.filenames ?? [] });
    for (const grammar of contributes?.grammars ?? []) {
      if (grammar.scopeName === undefined || grammar.path === undefined) continue;
      contributions.grammars.push({ scopeName: grammar.scopeName, path: join(app, entry, grammar.path), injectTo: grammar.injectTo ?? [], ...grammar.language === undefined ? {} : { language: grammar.language } });
    }
  }
  const rules = await readThemeRules(join(app, 'theme-defaults/themes/dark_modern.json'));
  return new TextMateHighlighter(contributions, { rules: rules ?? [] }, require.resolve('vscode-oniguruma/release/onig.wasm'));
}

/** Clone this repository and check out `head` as a PR worktree whose `origin/main` is `base`. */
async function fixture(source: string, base: string, head: string): Promise<{ storage: string; folder: string; paths: string[] }> {
  const storage = await mkdtemp(join(tmpdir(), 'diffguide-bench-'));
  const folder = worktreePath(storage, 'bench/repo', 1);
  await mkdir(folder, { recursive: true });
  const run = (cwd: string, ...args: string[]): string => childProcess.execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  run(storage, 'clone', '--quiet', '--shared', '--no-checkout', source, folder);
  run(folder, 'update-ref', 'refs/remotes/origin/main', base);
  run(folder, 'checkout', '--quiet', '--detach', head);
  const paths = run(folder, 'diff', '--name-only', base, head).split('\n').filter(Boolean);
  return { storage, folder, paths };
}

const settle = async (quietMs = 400): Promise<void> => {
  let quietSince = clock();
  let posts = 0;
  for (;;) {
    await new Promise((resolve) => { setTimeout(resolve, 25); });
    const busy = running > 0 || inFlight() > 0 || sentCount() !== posts;
    posts = sentCount();
    if (busy) quietSince = clock();
    else if (clock() - quietSince >= quietMs) return;
  }
};
let inFlight = (): number => 0;
let sentCount = (): number => 0;

interface Window { readonly from: number; readonly to: number }
const between = <T extends { start: number }>(list: readonly T[], { from, to }: Window): T[] => list.filter((call) => call.start >= from && call.start <= to);

async function main(): Promise<void> {
  const options = JSON.parse(process.env['BENCH_OPTIONS'] ?? '{}') as { source: string; base: string; head: string; boot: number; scale: number };
  const highlighter = await editorHighlighter();
  useEditorHighlighter(highlighter);
  const { storage, folder, paths } = await fixture(options.source, options.base, options.head);
  const { forge, calls } = benchForge({ paths, head: options.head, base: options.base, baseBranch: 'main' }, clock, options.scale);
  const started = new Map<string, number>();
  const counting = new Proxy(forge, { get: (target, method: string) => {
    const call = (target as unknown as Record<string, unknown>)[method];
    return typeof call !== 'function' ? call : async (...args: unknown[]) => {
      started.set(method, (started.get(method) ?? 0) + 1);
      try { return await (call as (...a: unknown[]) => Promise<unknown>)(...args); } finally { started.set(method, (started.get(method) ?? 0) - 1); }
    };
  } });
  inFlight = () => [...started.values()].reduce((sum, count) => sum + count, 0);
  const store = await createReviewStore(join(storage, 'store.json'), folder);
  const activity = { running: false, threads: new Set<string>() };
  const idle = { running: false };
  const quiet = (): { dispose(): void } => ({ dispose: () => undefined });
  const opened = {
    session: { store, key: 'bench', publication: () => undefined, activity: () => undefined },
    runner: { activity, onDidChange: quiet, context: async () => undefined },
    analysis: { activity: idle, onDidChange: quiet, result: async () => undefined },
    review: { activity: idle, onDidChange: quiet, result: async () => undefined },
    commits: () => [], dataPath: join(storage, 'data'), useBase: async () => undefined,
  } as unknown as PageSession;
  const host: PageHost = {
    fileIcons: async () => undefined, listRepositoryFiles, wholeFile, readBaseContent,
    newAnswers: () => new Map(), seeAnswers: async () => undefined, picks: () => [], savePicks: async () => undefined,
    reviewView: (picked) => reviewView(opened.review, picked), refreshSidebar: () => undefined, markMerged: async () => undefined, reveal: () => undefined,
    openInEditor: async () => undefined, removeWorktree: async () => undefined, workspaceRepositories: async () => new Map(), openLinkedPage: async () => undefined,
    parseLink: () => undefined,
  };
  const pullRequest = { number: 1, title: 'Bench PR', url: 'https://github.com/bench/repo/pull/1', author: 'bench', draft: false, headBranch: 'bench', baseBranch: 'main', createdAt: '', updatedAt: '' };
  const fileReviews = new FileReviews(storage);
  const fake = vscode.window as unknown as { panels: FakePanel[]; state: { focused: boolean }; createWebviewPanel(): FakePanel };
  fake.state.focused = true;

  /** Resolves with the time a message carrying `key` reaches the page, counting from message `after` on. */
  const waiters = new Set<() => void>();
  const message = async (panel: FakePanel, key: string, after: number): Promise<number> => {
    const has = (): boolean => panel.sent.slice(after).some((sent) => key in (sent as object));
    while (!has()) await new Promise<void>((resolve) => { waiters.add(resolve); });
    return clock();
  };
  let created: ((panel: FakePanel) => void) | undefined;
  const createPanel = fake.createWebviewPanel.bind(fake);
  fake.createWebviewPanel = () => {
    const panel = createPanel();
    const post = panel.webview.postMessage;
    panel.webview.postMessage = async (sent: unknown) => {
      const result = await post(sent);
      for (const wake of [...waiters]) { waiters.delete(wake); wake(); }
      return result;
    };
    created?.(panel);
    return panel;
  };

  /** One page open: from the command to the shown state and the shown files. */
  const open = async (): Promise<Record<string, unknown>> => {
    const from = clock();
    const page = pullRequestPageController({ provider: counting, repository: 'bench/repo', pullRequest, role: 'reviewer', folder, opened, fileReviews, revealed: new Set(), onCheckout: false, host });
    const changed: vscode.Event<unknown> = (listener) => vscode.Disposable.from(page.onDidChange(listener), fileReviews.onDidChange(listener));
    let panelAt = NaN;
    const shown = new Promise<FakePanel>((resolve) => {
      created = (panel) => {
        panelAt = clock();
        sentCount = () => panel.sent.length;
        // The page script posts `ready` once it has loaded, `boot` ms after the panel gets its HTML.
        setTimeout(() => { panel.receive({ action: 'ready' }); }, options.boot);
        resolve(panel);
      };
    });
    void showPullRequestOverview('bench/repo#1', page.read, changed, page.actions as never, vscode.Uri.file('/bench'));
    const panel = await shown;
    const filesAt = await message(panel, 'files', 0);
    const filesMessage = panel.sent.find((sent) => 'files' in (sent as object));
    // Files without any color span came before their colors; `colored` is when the colored files reached the page.
    const coloredAt = JSON.stringify(filesMessage).includes('<span') ? filesAt : await message(panel, 'files', panel.sent.indexOf(filesMessage) + 1);
    await settle();
    const window = { from, to: clock() };
    return {
      from, panel: panelAt - from, files: filesAt - from, colored: coloredAt - from, settled: window.to - from,
      htmlBytes: panel.webview.html.length, filesBytes: JSON.stringify(filesMessage).length,
      git: between(gitCalls, window).length, github: between(calls, window).map((call) => call.method),
      panelObject: panel,
    };
  };

  const timeline = (window: Window): { git: string[]; github: string[] } => ({
    git: between(gitCalls, window).map((call) => `${call.command} ${Math.round(call.start - window.from)}-${Math.round(call.end - window.from)}`),
    github: between(calls, window).map((call) => `${call.method} ${Math.round(call.start - window.from)}-${Math.round(call.end - window.from)}`),
  });

  const cold = await open();
  const panel = cold['panelObject'] as FakePanel;
  const dump = process.env['BENCH_DUMP'];
  // The page bench replays what this page got: its HTML, then the files message.
  if (dump !== undefined) writeFileSync(dump, JSON.stringify({ html: panel.webview.html, messages: panel.sent }));
  const coldTimeline = timeline({ from: cold['from'] as number, to: clock() });

  /** Tick Viewed on a file: from the click to the next state the page gets. */
  const viewed = async (): Promise<Record<string, unknown>> => {
    const sent = panel.sent.length;
    const from = clock();
    panel.receive({ action: 'viewed', path: paths[0], viewed: true });
    const stateAt = await message(panel, 'state', sent);
    await settle();
    const window = { from, to: clock() };
    const state = panel.sent.slice(sent).find((each) => 'state' in (each as object));
    return { state: stateAt - from, settled: window.to - from, stateBytes: JSON.stringify(state).length, git: between(gitCalls, window).length, github: between(calls, window).map((call) => call.method) };
  };
  const tick = await viewed();

  /** Press Refresh: from the click to the new files and to the "Refreshed" notice. */
  const refresh = async (): Promise<Record<string, unknown>> => {
    const sent = panel.sent.length;
    const from = clock();
    panel.receive({ action: 'refresh' });
    const [filesAt, refreshedAt] = await Promise.all([message(panel, 'files', sent), message(panel, 'refreshed', sent)]);
    await settle();
    const window = { from, to: clock() };
    return { files: filesAt - from, refreshed: refreshedAt - from, settled: window.to - from, git: between(gitCalls, window).length, github: between(calls, window).map((call) => call.method) };
  };
  const refreshed = await refresh();

  panel.dispose();
  const warm = await open();
  (warm['panelObject'] as FakePanel).dispose();
  for (const result of [cold, warm]) { delete result['panelObject']; delete result['from']; }
  process.stdout.write(JSON.stringify({ highlighter: highlighter === undefined ? 'highlight.js' : 'textmate', files: paths.length, cold, warm, viewed: tick, refresh: refreshed, coldTimeline }) + '\n');
  process.exit(0);
}

void main().catch((error: unknown) => { console.error(error); process.exit(1); });
