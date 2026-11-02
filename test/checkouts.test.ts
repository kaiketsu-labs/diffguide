import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Checkouts, nestedRepositoryRoots, type Checkout } from '../src/checkouts.js';
import type { FileReviews } from '../src/reviewedFiles.js';
import type { PullRequestSessions } from '../src/pullRequestSessions.js';
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
    ['/work/service-a', '/elsewhere/repo', '/work/service-b', '/work/.git/local-review/worktrees/acme__service-b/pr-1', '/work/service-b/.worktrees/fix', '/work/plain'],
    { '/work/service-a': '/work/service-a/.git/local-review', '/work/service-b': '/work/service-b/.git/local-review', '/work/service-b/.worktrees/fix': '/work/service-b/.git/local-review' },
  );
  t.after(() => { checkouts.dispose(); });

  const listed = await checkouts.list();
  assert.deepEqual(listed.map(({ root, storageRoot }) => [root, storageRoot]), [
    ['/work', '/global'],
    ['/work/service-a', '/work/service-a/.git/local-review'],
    ['/work/service-b', '/work/service-b/.git/local-review'],
  ]);
  const again = await checkouts.list();
  assert.ok(again.every((checkout, index) => checkout === listed[index]));
  assert.deepEqual(restored, ['/work', '/work/service-a', '/work/service-b']);
});

test('finds repositories one folder deep, including dot folders and worktree files, and skips ignored folders', async () => {
  const root = await mkdtemp(join(tmpdir(), 'local-review-scan-'));
  for (const folder of ['.git', 'api/.git', '.github-organization/.git', 'node_modules/lib/.git', 'docs', 'deep/inner/.git']) await mkdir(join(root, folder), { recursive: true });
  await mkdir(join(root, 'linked'));
  await writeFile(join(root, 'linked', '.git'), 'gitdir: ../.git/worktrees/linked');
  assert.deepEqual([...await nestedRepositoryRoots(root)].sort(), ['.github-organization', 'api', 'linked'].map((name) => join(root, name)));
});
