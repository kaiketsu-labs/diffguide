import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { Forge } from '../src/core/forge.js';
import { worktreePath } from '../src/core/git/worktrees.js';
import { FileReviews } from '../src/core/reviewedFiles.js';
import { createReviewStore } from '../src/core/store.js';
import type { PageHost, PageSession } from '../src/page/pullRequest/context.js';
import { pullRequestPageController } from '../src/page/pullRequest/controller.js';
import { conversation, details, remoteThreads } from './bench/forge.js';

/** A PR page on a one-commit worktree, with GitHub answering each call through `answer`. */
async function page(answer: (method: string) => Promise<unknown>) {
  const storage = await mkdtemp(join(tmpdir(), 'diffguide-page-'));
  const folder = worktreePath(storage, 'o/r', 1);
  await mkdir(folder, { recursive: true });
  const git = (...args: string[]): string => execFileSync('git', args, { cwd: folder, encoding: 'utf8' }).trim();
  git('init', '-q');
  await writeFile(join(folder, 'a.ts'), 'export const a = 1;\n');
  git('add', '.');
  git('-c', 'user.name=t', '-c', 'user.email=t@example.test', 'commit', '-q', '-m', 'init');
  git('update-ref', 'refs/remotes/origin/main', 'HEAD');
  const head = git('rev-parse', 'HEAD');
  const forge = new Proxy({}, { get: (_, method: string) => method === 'then' ? undefined : () => answer(method) }) as Forge;
  const idle = { running: false };
  const quiet = () => ({ dispose: () => undefined });
  const opened = {
    session: { store: await createReviewStore(join(storage, 'store.json'), folder), key: 'k', publication: () => undefined },
    runner: { activity: { running: false, threads: new Set() }, onDidChange: quiet, context: async () => undefined },
    analysis: { activity: idle, result: async () => undefined }, review: { activity: idle, result: async () => undefined },
    commits: () => [], dataPath: join(storage, 'data'), useBase: async () => undefined,
  } as unknown as PageSession;
  const host = {
    fileIcons: async () => undefined, listRepositoryFiles: async () => [], wholeFile: async () => undefined, readBaseContent: async () => '',
    newAnswers: () => new Map(), picks: () => [], reviewView: async (picked) => ({ running: false, picked }), refreshSidebar: () => undefined,
    workspaceRepositories: async () => new Map(), parseLink: () => undefined,
  } as Partial<PageHost> as PageHost;
  const pullRequest = { number: 1, title: 'PR', url: 'https://github.com/o/r/pull/1', author: 'a', draft: false, headBranch: 'b', baseBranch: 'main', createdAt: '', updatedAt: '' };
  return { head, controller: pullRequestPageController({ provider: forge, repository: 'o/r', pullRequest, role: 'reviewer', folder, opened, fileReviews: new FileReviews(storage), revealed: new Set(), onCheckout: false, host }) };
}

test('the page asks GitHub for linked changes while its other reads are still out', async () => {
  const asked: string[] = [];
  let answerConversation: (() => void) | undefined;
  let head = '';
  const { head: commit, controller } = await page(async (method) => {
    asked.push(method);
    if (method === 'conversation') {
      await new Promise<void>((resolve) => { answerConversation = resolve; });
      return conversation(head);
    }
    if (method === 'overview') return { details: details(), threads: remoteThreads(['a.ts']) };
    if (method === 'listFiles') return [{ path: 'a.ts', additions: 1, deletions: 0, change: 'added' }];
    if (method === 'crossReferences') return [];
    return undefined;
  });
  head = commit;
  const reading = controller.read();
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.ok(asked.includes('crossReferences'), `asked only ${asked.join(', ')}`);
  answerConversation?.();
  assert.equal((await reading).linked?.length, 0);
});

test('the page shows before GitHub sends the conversation, and redraws with it once it arrives', async () => {
  let answerConversation: (() => void) | undefined;
  let head = '';
  const { head: commit, controller } = await page(async (method) => {
    if (method === 'conversation') {
      await new Promise<void>((resolve) => { answerConversation = resolve; });
      return conversation(head);
    }
    if (method === 'overview') return { details: details(), threads: remoteThreads(['a.ts']) };
    if (method === 'listFiles') return [{ path: 'a.ts', additions: 1, deletions: 0, change: 'added' }];
    if (method === 'crossReferences') return [];
    return undefined;
  });
  head = commit;
  const first = await Promise.race([controller.read(), new Promise<undefined>((resolve) => setTimeout(resolve, 1000))]);
  assert.ok(first !== undefined, 'the page waited for the conversation');
  assert.equal(first.conversation, undefined);
  assert.ok(first.details !== undefined);
  const redrawn = new Promise<void>((resolve) => { controller.onDidChange(() => { resolve(); }); });
  answerConversation?.();
  await redrawn;
  assert.equal((await controller.read()).conversation?.viewerLogin, 'bench');
});

test('the page shows before GitHub sends the details and threads, and redraws with them once they arrive', async () => {
  let answerOverview: (() => void) | undefined;
  const { controller } = await page(async (method) => {
    if (method === 'overview') {
      await new Promise<void>((resolve) => { answerOverview = resolve; });
      return { details: details(), threads: remoteThreads(['a.ts']) };
    }
    if (method === 'listFiles') return [{ path: 'a.ts', additions: 1, deletions: 0, change: 'added' }];
    if (method === 'crossReferences') return [];
    return undefined;
  });
  const first = await Promise.race([controller.read(), new Promise<undefined>((resolve) => setTimeout(resolve, 1000))]);
  assert.ok(first !== undefined, 'the page waited for the details');
  assert.equal(first.details, undefined);
  assert.equal(first.detailsError, undefined);
  assert.equal(first.github, undefined);
  const redrawn = new Promise<void>((resolve) => { controller.onDidChange(() => { resolve(); }); });
  answerOverview?.();
  await redrawn;
  const second = await controller.read();
  assert.equal(second.details?.title, 'Bench PR');
  assert.equal(second.github?.length, 40);
});

test('the page shows before GitHub sends the file list, and redraws with the viewed count once it arrives', async () => {
  let answerFiles: (() => void) | undefined;
  const { controller } = await page(async (method) => {
    if (method === 'listFiles') {
      await new Promise<void>((resolve) => { answerFiles = resolve; });
      return [{ path: 'a.ts', additions: 1, deletions: 0, change: 'added' }];
    }
    if (method === 'overview') return { details: details(), threads: remoteThreads(['a.ts']) };
    if (method === 'crossReferences') return [];
    return undefined;
  });
  const first = await Promise.race([controller.read(), new Promise<undefined>((resolve) => setTimeout(resolve, 1000))]);
  assert.ok(first !== undefined, 'the page waited for the file list');
  assert.equal(first.reviewed, undefined);
  assert.equal(first.reviewedPending, true);
  const redrawn = new Promise<void>((resolve) => { controller.onDidChange(() => { resolve(); }); });
  answerFiles?.();
  await redrawn;
  const second = await controller.read();
  assert.deepEqual(second.reviewed, { done: 0, total: 1 });
  assert.equal(second.reviewedPending, undefined);
});
