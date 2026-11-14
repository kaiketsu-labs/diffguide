import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach } from 'node:test';
import test from 'node:test';
import { promisify } from 'node:util';
import type * as vscode from 'vscode';
import type { ChangeRequestSummary, Forge } from '../src/core/forge.js';
import { FileReviews } from '../src/core/reviewedFiles.js';
import { mockPullRequestProvider } from '../src/forges/mockPullRequests.js';
import type { Checkout, Checkouts } from '../src/hosts/vscode/checkouts.js';
import type { SeenAnswers } from '../src/hosts/vscode/claudeAnswers.js';
import { pullRequestPages } from '../src/hosts/vscode/pullRequestPage.js';
import { PullRequestSessions } from '../src/hosts/vscode/pullRequestSessions.js';
import { isPageOpen } from '../src/hosts/vscode/reviewPanel.js';
import { commands, extensionContext, resetFakeWindow, Uri, window } from './fakes/vscode.js';

const executeFile = promisify(execFile);
const cleanup: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const dispose of cleanup.splice(0).reverse()) await dispose();
  resetFakeWindow();
});

async function git(root: string, args: readonly string[]): Promise<void> {
  await executeFile('git', [
    '-C', root, '-c', 'user.name=DiffGuide Test', '-c', 'user.email=diffguide@example.invalid',
    '-c', 'commit.gpgSign=false', '-c', `core.hooksPath=${path.join(root, 'no-hooks')}`, ...args,
  ], { encoding: 'utf8', timeout: 10_000 });
}

async function until(check: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 400 && !check(); attempt++) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.ok(check(), 'condition not reached');
}

const pullRequest: ChangeRequestSummary = {
  number: 5, title: 'Add feature', url: 'https://github.com/acme/app/pull/5',
  author: 'octo', draft: false, headBranch: 'feature', baseBranch: 'main',
};

/** A source clone without a PR worktree, and a page opener whose GitHub checkout waits for `release`. */
async function fixture(checkout: (worktree: string) => Promise<void>): Promise<{ show: () => Promise<void>; checkouts: () => number }> {
  const scratch = await mkdtemp(path.join(tmpdir(), 'diffguide-open-'));
  cleanup.push(async () => { await rm(scratch, { recursive: true, force: true }); });
  const origin = path.join(scratch, 'origin');
  const source = path.join(scratch, 'source');
  await git(scratch, ['init', '--quiet', '--initial-branch=main', origin]);
  await writeFile(path.join(origin, 'base.ts'), 'export const base = 1;\n');
  await git(origin, ['add', '.']);
  await git(origin, ['commit', '--quiet', '-m', 'base']);
  await git(origin, ['switch', '--quiet', '-c', 'feature']);
  await writeFile(path.join(origin, 'feature.ts'), 'export const feature = 1;\n');
  await git(origin, ['add', '.']);
  await git(origin, ['commit', '--quiet', '-m', 'feature']);
  await git(origin, ['switch', '--quiet', 'main']);
  await git(scratch, ['clone', '--quiet', origin, source]);
  let checkouts = 0;
  const provider: Forge = {
    ...mockPullRequestProvider,
    checkout: async (_number, worktree) => {
      checkouts++;
      await checkout(worktree);
      await git(worktree, ['switch', '--quiet', '-c', 'feature', 'origin/feature']);
    },
  };
  commands.handlers.set('setContext', () => undefined);
  const context = { ...extensionContext(), extensionPath: '/extension', extensionUri: Uri.file('/extension'), subscriptions: [] } as unknown as vscode.ExtensionContext;
  const storage = path.join(scratch, 'storage');
  const sessions = new PullRequestSessions(context, storage, source, async () => provider, {
    resolve: async () => ({ executable: '/bin/claude', mcpPath: '/data/mcp.json' }),
    spawn: (() => { throw new Error('not started in tests'); }) as never,
  });
  cleanup.push(async () => { sessions.dispose(); });
  const opened: Checkout = { root: source, storageRoot: storage, connect: async () => provider, sessions, fileReviews: new FileReviews(storage) };
  const showOverview = pullRequestPages(context, {} as Checkouts, { isNew: () => false, see: async () => undefined } as unknown as SeenAnswers, async () => new Map());
  return { show: () => showOverview(opened, provider, 'acme/app', pullRequest, 'reviewer'), checkouts: () => checkouts };
}

/** A checkout that waits until the test lets it go on. */
function held(): { checkout: () => Promise<void>; release: () => void } {
  let release = (): void => undefined;
  const waiting = new Promise<void>((resolve) => { release = resolve; });
  return { checkout: () => waiting, release };
}

test('shows a PR\'s tab before its worktree is made, and opens the page in that tab', async () => {
  const gate = held();
  const { show } = await fixture(gate.checkout);
  const opening = show();
  await until(() => window.panels.length === 1);
  assert.match(window.panels[0]?.webview.html ?? '', /Add feature/u);
  assert.equal(isPageOpen('acme/app#5'), false);
  gate.release();
  await opening;
  assert.equal(window.panels.length, 1);
  assert.equal(window.panels[0]?.disposed, false);
  assert.equal(isPageOpen('acme/app#5'), true);
});

test('brings the tab to the front on a second click while the worktree is made, and makes it once', async () => {
  const gate = held();
  const { show, checkouts } = await fixture(gate.checkout);
  const first = show();
  await until(() => window.panels.length === 1);
  await show();
  assert.equal(window.panels.length, 1);
  assert.equal(window.panels[0]?.revealCalls.length, 1);
  gate.release();
  await first;
  assert.equal(checkouts(), 1);
  assert.equal(window.panels.length, 1);
});

test('opens no page when its tab was closed while the worktree was made', async () => {
  const gate = held();
  const { show } = await fixture(gate.checkout);
  const opening = show();
  await until(() => window.panels.length === 1);
  window.panels[0]?.dispose();
  gate.release();
  await opening;
  assert.equal(window.panels.filter((panel) => !panel.disposed).length, 0);
  assert.equal(isPageOpen('acme/app#5'), false);
});

test('opens the page in a tab shown again after the first one was closed while the worktree was made', async () => {
  const gate = held();
  const { show, checkouts } = await fixture(gate.checkout);
  const first = show();
  await until(() => window.panels.length === 1);
  window.panels[0]?.dispose();
  await show();
  assert.equal(window.panels.length, 2);
  gate.release();
  await first;
  assert.equal(checkouts(), 1);
  assert.equal(window.panels[1]?.disposed, false);
  assert.equal(isPageOpen('acme/app#5'), true);
});

test('closes the tab when the worktree cannot be made', async () => {
  const { show } = await fixture(async () => { throw new Error('fetch failed'); });
  await assert.rejects(show(), /fetch failed/u);
  assert.equal(window.panels.length, 1);
  assert.equal(window.panels[0]?.disposed, true);
});
