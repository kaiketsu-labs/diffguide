import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { worktreePath } from '../src/core/git/worktrees.js';
import type { FileReviews } from '../src/core/reviewedFiles.js';
import { type Checkout, Checkouts, nestedRepositoryRoots } from '../src/hosts/vscode/checkouts.js';
import type { PullRequestSessions } from '../src/hosts/vscode/pullRequestSessions.js';
import { EventEmitter } from './fakes/vscode.js';

/** Checkouts with sessions that only count restores. */
function fixture(roots: readonly string[], storage: Record<string, string>) {
  const restored: string[] = [];
  const checkouts = new Checkouts('/work', '/global', {
    discover: async () => roots,
    storage: async (root) => storage[root],
    create: (root, storageRoot): Checkout => ({
      root, storageRoot, connect: async () => { throw new Error('not used'); },
      sessions: {
        sessions: [], onDidChange: new EventEmitter<void>().event, onDidChangeState: new EventEmitter<never>().event,
        restore: async () => { restored.push(root); }, dispose: () => undefined,
      } as unknown as PullRequestSessions,
      fileReviews: { onDidChange: new EventEmitter<void>().event, dispose: () => undefined } as unknown as FileReviews,
    }),
    onRestoreError: (error) => { throw error; },
  });
  return { checkouts, restored };
}

test('lists the workspace folder first, then its nested repositories once each', async (t) => {
  const { checkouts, restored } = fixture(
    ['/work/service-a', '/elsewhere/repo', '/work/service-b', '/work/.git/pair-review/worktrees/acme__service-b/pr-1', '/work/service-b/.claude/worktrees/diffguide/acme__service-b/pr-2', '/work/service-b/.worktrees/fix', '/work/plain'],
    { '/work/service-a': '/work/service-a/.git/pair-review', '/work/service-b': '/work/service-b/.git/pair-review', '/work/service-b/.worktrees/fix': '/work/service-b/.git/pair-review' },
  );
  t.after(() => { checkouts.dispose(); });

  const listed = await checkouts.list();
  assert.deepEqual(listed.map(({ root, storageRoot }) => [root, storageRoot]), [
    ['/work', '/global'],
    ['/work/service-a', '/work/service-a/.git/pair-review'],
    ['/work/service-b', '/work/service-b/.git/pair-review'],
  ]);
  const again = await checkouts.list();
  assert.ok(again.every((checkout, index) => checkout === listed[index]));
  assert.deepEqual(restored, ['/work', '/work/service-a', '/work/service-b']);
});

test('finds repositories one folder deep, including dot folders and worktree files, and skips ignored folders', async () => {
  const root = await mkdtemp(join(tmpdir(), 'diffguide-scan-'));
  for (const folder of ['.git', 'api/.git', '.github-organization/.git', 'node_modules/lib/.git', 'docs', 'deep/inner/.git']) await mkdir(join(root, folder), { recursive: true });
  await mkdir(join(root, 'linked'));
  await writeFile(join(root, 'linked', '.git'), 'gitdir: ../.git/worktrees/linked');
  assert.deepEqual([...await nestedRepositoryRoots(root)].sort(), ['.github-organization', 'api', 'linked'].map((name) => join(root, name)));
});

test('finds a PR\'s checkout without rescanning the folder, and rescans once for a repository it has not seen', async (t) => {
  const storage = await mkdtemp(join(tmpdir(), 'diffguide-locate-'));
  t.after(async () => { await rm(storage, { recursive: true, force: true }); });
  const addWorktree = async (storageRoot: string, number: number): Promise<void> => {
    const folder = worktreePath(storageRoot, 'acme/app', number);
    await mkdir(folder, { recursive: true });
    await writeFile(`${folder}.json`, JSON.stringify({ version: 1, repository: 'acme/app', role: 'reviewer', pullRequest: { number, baseBranch: 'main' } }));
  };
  const roots = ['/work/a'];
  let scans = 0;
  const checkouts = new Checkouts('/work', join(storage, 'global'), {
    discover: async () => { scans += 1; return [...roots]; },
    storage: async (root) => root === '/work' ? undefined : join(storage, root.slice('/work/'.length)),
    create: (root, storageRoot): Checkout => ({
      root, storageRoot, connect: async () => { throw new Error('not used'); },
      sessions: { sessions: [], onDidChange: new EventEmitter<void>().event, onDidChangeState: new EventEmitter<never>().event, restore: async () => undefined, dispose: () => undefined } as unknown as PullRequestSessions,
      fileReviews: { onDidChange: new EventEmitter<string>().event, dispose: () => undefined } as unknown as FileReviews,
    }),
    onRestoreError: (error) => { throw error; },
  });
  t.after(() => { checkouts.dispose(); });
  await addWorktree(join(storage, 'a'), 1);

  assert.equal((await checkouts.locate('acme/app', 1))?.root, '/work/a');
  assert.equal((await checkouts.locate('acme/app', 1))?.root, '/work/a');
  assert.equal(scans, 1);

  roots.push('/work/b');
  await addWorktree(join(storage, 'b'), 2);
  assert.equal((await checkouts.locate('acme/app', 2))?.root, '/work/b');
  assert.equal(scans, 2);
  assert.equal(await checkouts.locate('acme/app', 3), undefined);
});
