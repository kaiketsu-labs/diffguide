import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import type { PullRequestProvider } from '../src/pullRequests.js';
import { FileReviews, readReviewedFiles, setFileReviewed } from '../src/reviewedFiles.js';
import { worktreePath } from '../src/worktrees.js';

test('keeps a file reviewed until its content changes, and clears it on untick', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'local-review-reviewed-'));
  t.after(async () => { await rm(root, { recursive: true, force: true }); });
  const worktree = path.join(root, 'pr-3');
  await mkdir(path.join(worktree, 'src'), { recursive: true });
  await writeFile(path.join(worktree, 'src/a.ts'), 'one');
  await writeFile(path.join(worktree, 'b.ts'), 'two');

  await setFileReviewed(worktree, 'src/a.ts', true);
  await setFileReviewed(worktree, 'b.ts', true);
  await setFileReviewed(worktree, 'gone.ts', true);
  assert.deepEqual([...await readReviewedFiles(worktree, ['src/a.ts', 'b.ts', 'gone.ts'])], ['src/a.ts', 'b.ts', 'gone.ts']);

  await writeFile(path.join(worktree, 'src/a.ts'), 'changed');
  await setFileReviewed(worktree, 'b.ts', false);
  assert.deepEqual([...await readReviewedFiles(worktree, ['src/a.ts', 'b.ts', 'gone.ts'])], ['gone.ts']);

  await assert.rejects(setFileReviewed(worktree, '../outside.ts', true));
});

test('notices a same-size edit that keeps the old modification time', async (t) => {
  const worktree = await mkdtemp(path.join(tmpdir(), 'local-review-reviewed-'));
  t.after(async () => { await rm(worktree, { recursive: true, force: true }); });
  const file = path.join(worktree, 'a.ts');
  await writeFile(file, 'one');
  await setFileReviewed(worktree, 'a.ts', true);
  assert.deepEqual([...await readReviewedFiles(worktree, ['a.ts'])], ['a.ts']);
  const { atime, mtime } = await stat(file);

  await writeFile(file, 'two');
  await utimes(file, atime, mtime);
  assert.deepEqual([...await readReviewedFiles(worktree, ['a.ts'])], []);
});

test('merges local ticks with the code host\'s Viewed flags and sends ticks to it', async (t) => {
  const storage = await mkdtemp(path.join(tmpdir(), 'local-review-reviews-'));
  t.after(async () => { await rm(storage, { recursive: true, force: true }); });
  const worktree = worktreePath(storage, 'acme/app', 3);
  await mkdir(worktree, { recursive: true });
  await writeFile(path.join(worktree, 'a.ts'), 'a');
  const calls: string[] = [];
  let reads = 0;
  const provider = {
    viewedFiles: async () => { reads += 1; return new Set(['b.ts']); },
    setViewed: async (_number: number, file: string, viewed: boolean) => { calls.push(`${file}:${viewed}`); },
  } as unknown as PullRequestProvider;
  const reviews = new FileReviews(storage);
  t.after(() => { reviews.dispose(); });

  assert.deepEqual([...await reviews.reviewed(provider, 'acme/app', 3, ['a.ts', 'b.ts'])], ['b.ts']);
  await reviews.set(provider, 'acme/app', 3, 'a.ts', true);
  await reviews.set(provider, 'acme/app', 3, 'b.ts', false);
  assert.deepEqual([...await reviews.reviewed(provider, 'acme/app', 3, ['a.ts', 'b.ts'])], ['a.ts']);
  assert.deepEqual(calls, ['a.ts:true', 'b.ts:false']);
  assert.equal(reads, 1);
  reviews.forget();
  await reviews.reviewed(provider, 'acme/app', 3, ['a.ts']);
  assert.equal(reads, 2);
});
