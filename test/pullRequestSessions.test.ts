import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { afterEach } from 'node:test';
import { promisify } from 'node:util';
import type * as vscode from 'vscode';

import { pullRequestFileUri } from '../src/pullRequestDiff.js';
import type { PullRequestComment, PullRequestProvider, PullRequestSummary } from '../src/pullRequests.js';
import { readPublications } from '../src/pullRequestComments.js';
import { PullRequestSessions } from '../src/pullRequestSessions.js';
import { createReviewController } from '../src/reviewController.js';
import { createReviewStore } from '../src/store.js';
import { ensureWorktree, readPullRequestBase, reviewDataPath } from '../src/worktrees.js';
import {
  commands, comments, extensionContext, FakeInteractiveEditor, FakeTextDocument, resetFakeEditor, resetFakeWindow,
  Selection, settle, Uri, window, workspace,
} from './fakes/vscode.js';

const executeFile = promisify(execFile);
const cleanup: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const dispose of cleanup.splice(0).reverse()) await dispose();
  resetFakeEditor();
  resetFakeWindow();
});

/** Wait for background file and Git work to reach a state. */
async function until(check: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 400 && !check(); attempt++) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.ok(check(), 'condition not reached');
}

/** Run a fixture Git command without user configuration or hooks. */
async function git(root: string, args: readonly string[]): Promise<void> {
  await executeFile('git', [
    '-C', root, '-c', 'user.name=Local Review Test', '-c', 'user.email=local-review@example.invalid',
    '-c', 'commit.gpgSign=false', '-c', `core.hooksPath=${path.join(root, 'no-hooks')}`, ...args,
  ], { encoding: 'utf8', timeout: 10_000 });
}

const pullRequest: PullRequestSummary = {
  number: 5, title: 'Add feature', url: 'https://github.com/acme/app/pull/5',
  author: 'octo', draft: false, headBranch: 'feature', baseBranch: 'main',
};

const published: { number: number; comment: PullRequestComment; pending: boolean }[] = [];
const provider: PullRequestProvider = {
  readRepository: async () => ({ name: 'acme/app', url: 'https://github.com/acme/app' }),
  listMine: async () => [],
  listReviewRequested: async () => [],
  listFiles: async () => [],
  checkout: async (_number, worktree) => { await git(worktree, ['switch', '--quiet', '-c', 'feature', 'origin/feature']); },
  viewedFiles: async () => new Set(),
  setViewed: async () => undefined,
  publishComment: async (number, comment, pending) => { published.push({ number, comment, pending }); return 'https://github.com/acme/app/pull/5#discussion_r1'; },
  details: async () => { throw new Error('not used'); },
  threads: async () => [],
  overview: async () => { throw new Error('not used'); },
  replyToThread: async () => { throw new Error('not used'); },
  resolveThread: async () => { throw new Error('not used'); },
  deleteComment: async () => { throw new Error('not used'); },
  submitReview: async () => { throw new Error('not used'); },
  merge: async () => { throw new Error('not used'); },
};
const connect = async (): Promise<PullRequestProvider> => provider;

/** Source clone with a PR worktree for `feature`, plus a separate local review store. */
async function fixture(): Promise<{ source: string; storage: string; worktree: string; context: vscode.ExtensionContext }> {
  const scratch = await mkdtemp(path.join(tmpdir(), 'local-review-sessions-'));
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
  const storage = path.join(scratch, 'storage');
  const worktree = await ensureWorktree(source, storage, provider, 'acme/app', pullRequest, 'reviewer');
  commands.handlers.set('setContext', () => undefined);
  const context = { ...extensionContext(), extensionPath: '/extension', extensionUri: Uri.file('/extension'), subscriptions: [] } as unknown as vscode.ExtensionContext;
  return { source, storage, worktree, context };
}

test('stores a comment on a PR file in that PR\'s own review, anchored to the PR base', async () => {
  const { source, storage, worktree, context } = await fixture();
  const local = await createReviewStore(path.join(storage, 'local-review.json'), source);
  const started: string[] = [];
  const sessions = new PullRequestSessions(context, storage, source, connect, {
    resolve: async () => ({ executable: '/bin/claude', mcpPath: '/data/mcp.json' }),
    spawn: ((_executable: string, _args: readonly string[], options: { cwd: string }) => {
      started.push(options.cwd);
      throw new Error('not started in tests');
    }) as never,
  });
  cleanup.push(async () => { sessions.dispose(); });
  const opened = await sessions.open('acme/app', 5);
  const controller = await createReviewController(local, context, async () => undefined, sessions);
  cleanup.push(async () => { controller.dispose(); });

  const uri = pullRequestFileUri({ repository: 'acme/app', number: 5, relativePath: 'feature.ts' });
  const document = new FakeTextDocument(uri as unknown as Uri, 'export const feature = 1;\n', 'typescript');
  workspace.textDocuments.push(document);
  const editor = new FakeInteractiveEditor(document);
  editor.selection = new Selection(0, 0, 0, 10);
  window.visibleTextEditors.push(editor);
  window.activeTextEditor = editor;
  assert.equal(sessions.forUri(uri)?.session, opened.session);

  await commands.executeCommand('localReview.addComment');
  const draft = comments.controllers[0]?.threads.at(-1);
  assert.ok(draft !== undefined);
  await commands.executeCommand('localReview.submitInline', { thread: draft, text: '/a Why is this exported?' });
  await opened.session.store.flush();
  await settle();

  assert.equal(local.threads.length, 0);
  const [thread] = opened.session.store.threads;
  assert.equal(thread?.anchor.path, 'feature.ts');
  assert.equal(thread?.anchor.side, 'working');
  assert.equal(thread?.anchor.baseRevision, await readPullRequestBase(worktree, 'main'));
  assert.equal(opened.session.store.pendingEvents.length, 1);
  assert.equal(opened.bridge.descriptor.workspaceRoot, worktree);
  for (let wait = 0; started.length === 0 && wait < 100; wait += 1) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(started, [worktree]);

  assert.ok(thread !== undefined);
  await commands.executeCommand('localReview.publishThread', thread.id);
  const panel = window.panels.at(-1);
  assert.ok(panel?.webview.html.includes('Why is this exported?'));
  panel?.receive({ body: 'Why is this exported?', pending: true });
  await until(() => opened.session.publication?.(thread.id) !== undefined);
  assert.equal(published[0]?.pending, true);
  assert.deepEqual({ ...published[0]?.comment, commitId: undefined }, { path: 'feature.ts', side: 'RIGHT', lines: { start: 1, end: 1 }, body: 'Why is this exported?', commitId: undefined });
  assert.equal(panel?.disposed, true);
  assert.deepEqual(await readPublications(reviewDataPath(worktree)), new Map([[thread.id, { url: 'https://github.com/acme/app/pull/5#discussion_r1', pending: true }]]));
  assert.match(comments.controllers[0]?.threads.find((native) => native.contextValue?.endsWith('.published'))?.label ?? '', /On GitHub \(pending\)/u);
  await stat(path.join(reviewDataPath(worktree), 'review.json'));
  await stat(path.join(reviewDataPath(worktree), 'connection.json'));
});

test('restores PR reviews created from this checkout and ignores other checkouts', async () => {
  const { source, storage, context } = await fixture();
  const noClaude = { resolve: () => Promise.reject(new Error('not started in tests')) };
  const first = new PullRequestSessions(context, storage, source, connect, noClaude);
  const opened = await first.open('acme/app', 5);
  await opened.session.store.submit({
    path: 'feature.ts', startLine: 1, endLine: 1, selectedText: 'export const feature = 1;',
    contextBefore: '', contextAfter: '', documentHash: 'a'.repeat(64), side: 'working', baseRevision: 'b'.repeat(40),
  }, 'Keep this', 'ask');
  await first.close('acme/app', 5);
  first.dispose();

  const other = new PullRequestSessions(context, storage, '/somewhere/else', connect, noClaude);
  cleanup.push(async () => { other.dispose(); });
  await other.restore();
  assert.equal(other.sessions.length, 0);

  const restored = new PullRequestSessions(context, storage, source, connect, noClaude);
  cleanup.push(async () => { restored.dispose(); });
  await restored.restore();
  assert.equal(restored.sessions.length, 1);
  assert.equal(restored.sessions[0]?.store.threads[0]?.messages[0]?.text, 'Keep this');
});
