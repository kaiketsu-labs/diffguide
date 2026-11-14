import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { useEditorHighlighter } from '../src/core/codePreview.js';
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
  /** What the page handed Claude's guide build and code review. */
  const started: { files: readonly { hunks: readonly { lines: readonly { html: string }[] }[] }[] }[] = [];
  const start = (input: (typeof started)[number]): void => { started.push(input); };
  const quiet = () => ({ dispose: () => undefined });
  const opened = {
    session: { store: await createReviewStore(join(storage, 'store.json'), folder), key: 'k', publication: () => undefined },
    runner: { activity: { running: false, threads: new Set() }, onDidChange: quiet, context: async () => undefined },
    analysis: { activity: idle, result: async () => undefined, start }, review: { activity: idle, result: async () => undefined, start },
    commits: () => [], dataPath: join(storage, 'data'), useBase: async () => undefined,
  } as unknown as PageSession;
  const host = {
    fileIcons: async () => undefined, listRepositoryFiles: async () => [], wholeFile: async () => undefined, readBaseContent: async () => '',
    newAnswers: () => new Map(), picks: () => [], savePicks: async () => undefined, reviewView: async (picked) => ({ running: false, picked }), refreshSidebar: () => undefined,
    workspaceRepositories: async () => new Map(), parseLink: () => undefined,
  } as Partial<PageHost> as PageHost;
  const pullRequest = { number: 1, title: 'PR', url: 'https://github.com/o/r/pull/1', author: 'a', draft: false, headBranch: 'b', baseBranch: 'main', createdAt: '', updatedAt: '' };
  return { head, folder, git, started, controller: pullRequestPageController({ provider: forge, repository: 'o/r', pullRequest, role: 'reviewer', folder, opened, fileReviews: new FileReviews(storage), revealed: new Set(), onCheckout: false, host }) };
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
  await reading;
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

test('the page shows before GitHub sends the linked changes, and redraws with them once they arrive', async () => {
  let answerMentions: (() => void) | undefined;
  const { controller } = await page(async (method) => {
    if (method === 'crossReferences') {
      await new Promise<void>((resolve) => { answerMentions = resolve; });
      return [];
    }
    if (method === 'overview') return { details: details(), threads: remoteThreads(['a.ts']) };
    if (method === 'listFiles') return [{ path: 'a.ts', additions: 1, deletions: 0, change: 'added' }];
    return undefined;
  });
  const first = await Promise.race([controller.read(), new Promise<undefined>((resolve) => setTimeout(resolve, 1000))]);
  assert.ok(first !== undefined, 'the page waited for the linked changes');
  assert.equal(first.linked, undefined);
  const redrawn = new Promise<void>((resolve) => { controller.onDidChange(() => { resolve(); }); });
  answerMentions?.();
  await redrawn;
  assert.deepEqual((await controller.read()).linked, []);
});

test('a commit preview and the changes Claude reads do not wait for syntax colors', async (t) => {
  let colorings = 0;
  useEditorHighlighter({ prepare: async () => undefined, styles: () => '', highlight: (code: string) => { colorings++; return `<span class="tm-ff0000">${code.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')}</span>`; } });
  t.after(() => { useEditorHighlighter(undefined); });
  const { controller, folder, git, started } = await page(async (method) => method === 'listFiles' ? [] : undefined);
  git('update-ref', 'refs/remotes/origin/main', 'HEAD');
  await writeFile(join(folder, 'a.ts'), 'export const a = 2;\n');
  git('-c', 'user.name=t', '-c', 'user.email=t@example.test', 'commit', '-q', '-am', 'change');
  const lines = (files: (typeof started)[number]['files']): string[] => files.flatMap((file) => file.hunks.flatMap((hunk) => hunk.lines.map((line) => line.html)));

  const commit = await controller.actions.readCommit(git('rev-parse', 'HEAD'));
  assert.equal(colorings, 0, 'the commit preview waited for colors');
  assert.deepEqual(lines(commit.files), ['export const a = 1;', 'export const a = 2;']);

  await controller.actions.analyze();
  await controller.actions.review([]);
  assert.equal(colorings, 0, 'Claude waited for colors');
  assert.deepEqual(started.map(({ files }) => lines(files)), [['export const a = 1;', 'export const a = 2;'], ['export const a = 1;', 'export const a = 2;']]);

  assert.ok(commit.colored !== undefined);
  assert.ok(lines(await commit.colored()).every((html) => html.includes('<span')));
});
