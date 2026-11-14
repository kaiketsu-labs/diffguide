// Times the first open of a PR without a worktree: from the sidebar's click to the tab, the files and the end of the open.
// The worktree is made from a clone of this repository; fetches answer after measured GitHub latencies. Prints one JSON result for scripts/bench.mjs.
import childProcess from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type * as vscode from 'vscode';
import type { Forge } from '../../src/core/forge.js';
import { FileReviews } from '../../src/core/reviewedFiles.js';
import type { Checkout, Checkouts } from '../../src/hosts/vscode/checkouts.js';
import type { SeenAnswers } from '../../src/hosts/vscode/claudeAnswers.js';
import { pullRequestPages } from '../../src/hosts/vscode/pullRequestPage.js';
import { PullRequestSessions } from '../../src/hosts/vscode/pullRequestSessions.js';
import { commands, extensionContext, type FakePanel, Uri, window } from '../fakes/vscode.js';
import { benchForge } from './forge.js';

/** Median `git fetch` times in ms against github.com, measured on 2026-11-14 on this repository (5 runs each, nothing new to download). */
const fetchLatency = { pullRequest: 505, base: 440 };

const t0 = performance.now();
const clock = (): number => performance.now() - t0;

async function main(): Promise<void> {
  const { source: repository, base, head, scale } = JSON.parse(process.env['BENCH_OPTIONS'] ?? '{}') as { source: string; base: string; head: string; scale: number };
  const run = (cwd: string, ...args: string[]): string => childProcess.execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  const scratch = await mkdtemp(join(tmpdir(), 'diffguide-bench-open-'));
  const source = join(scratch, 'source');
  run(scratch, 'clone', '--quiet', '--shared', '--no-checkout', repository, source);
  run(source, 'checkout', '--quiet', '--detach', base);
  run(source, 'update-ref', 'refs/remotes/origin/main', base);
  const paths = run(source, 'diff', '--name-only', base, head).split('\n').filter(Boolean);

  // A fetch from the local clone is instant, so it answers after GitHub's time instead.
  const execFile = childProcess.execFile;
  (childProcess as { execFile: unknown }).execFile = (file: string, args: readonly string[], ...rest: unknown[]) => {
    const callback = rest.findIndex((value) => typeof value === 'function');
    if (file === 'git' && args.includes('fetch') && callback >= 0) {
      const delay = (args.at(-1) === 'main' ? fetchLatency.base : fetchLatency.pullRequest) * scale;
      const original = rest[callback] as (...a: unknown[]) => void;
      rest[callback] = (...result: unknown[]) => { setTimeout(() => { original(...result); }, delay); };
    }
    return (execFile as (...a: unknown[]) => unknown)(file, args, ...rest);
  };

  const { forge } = benchForge({ paths, head, base, baseBranch: 'main' }, clock, scale);
  const git = async (cwd: string, ...args: string[]): Promise<void> => {
    await new Promise<void>((resolve, reject) => { childProcess.execFile('git', ['-C', cwd, ...args], (error) => { if (error) reject(error); else resolve(); }); });
  };
  const checkoutHead = async (_number: number, worktree: string): Promise<void> => { await git(worktree, 'fetch', '--quiet', source, head); await git(worktree, 'checkout', '--quiet', '--detach', head); };
  const provider: Forge = new Proxy(forge, { get: (target, method) => method === 'checkout' ? checkoutHead : Reflect.get(target, method) });
  commands.handlers.set('setContext', () => undefined);
  const context = { ...extensionContext(), extensionPath: '/extension', extensionUri: Uri.file('/extension'), subscriptions: [] } as unknown as vscode.ExtensionContext;
  const storage = join(scratch, 'storage');
  const connect = async (): Promise<Forge> => provider;
  const sessions = new PullRequestSessions(context, storage, source, connect, {
    resolve: async () => ({ executable: '/bin/claude', mcpPath: '/data/mcp.json' }),
    spawn: (() => { throw new Error('not started in the bench'); }) as never,
  });
  const checkout: Checkout = { root: source, storageRoot: storage, connect, sessions, fileReviews: new FileReviews(storage) };
  const seenAnswers = { isNew: () => false, see: async () => undefined } as unknown as SeenAnswers;
  const show = pullRequestPages(context, {} as Checkouts, seenAnswers, async () => new Map());

  let tab = NaN;
  let files = NaN;
  const fake = window as unknown as { createWebviewPanel(): FakePanel };
  const createPanel = fake.createWebviewPanel.bind(fake);
  fake.createWebviewPanel = () => {
    const panel = createPanel();
    if (Number.isNaN(tab)) tab = clock();
    const post = panel.webview.postMessage;
    panel.webview.postMessage = async (sent: unknown) => {
      if (Number.isNaN(files) && typeof sent === 'object' && sent !== null && 'files' in sent) files = clock();
      return post(sent);
    };
    // The page script posts `ready` each time its HTML loads; the PR page sends its files after that.
    let html = '';
    Object.defineProperty(panel.webview, 'html', {
      get: () => html,
      set: (next: string) => { html = next; setTimeout(() => { panel.receive({ action: 'ready' }); }, 10); },
    });
    return panel;
  };
  const pullRequest = { number: 1, title: 'Bench PR', url: 'https://github.com/bench/repo/pull/1', author: 'bench', draft: false, headBranch: 'bench', baseBranch: 'main' };
  const from = clock();
  await show(checkout, provider, 'bench/repo', pullRequest, 'reviewer');
  const shown = clock();
  while (Number.isNaN(files) && clock() - shown < 10_000) await new Promise((resolve) => { setTimeout(resolve, 10); });
  process.stdout.write(JSON.stringify({ tab: tab - from, files: files - from, opened: shown - from }) + '\n');
  process.exit(0);
}

void main().catch((error: unknown) => { console.error(error); process.exit(1); });
