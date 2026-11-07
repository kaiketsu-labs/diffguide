import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

import { getHeadRevision, listChangedFiles, readGitBase } from '../src/git.js';

const executeFile = promisify(execFile);

/** Run a fixture Git command directly without shell expansion. */
async function git(root: string, args: readonly string[]): Promise<void> {
  await executeFile('git', ['-C', root, ...args], { encoding: 'utf8', timeout: 10_000 });
}

test('keeps both sides of a staged rename available with the correct original contents', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'diffguide-git-'));
  t.after(async () => { await rm(root, { recursive: true, force: true }); });
  await git(root, ['init', '--quiet']);
  const original = 'export const cachedValue = 42;\n';
  await writeFile(path.join(root, 'before.ts'), original);
  await git(root, ['add', '--', 'before.ts']);
  await git(root, [
    '-c', 'user.name=DiffGuide Test', '-c', 'user.email=diffguide@example.invalid',
    '-c', 'commit.gpgSign=false', '-c', `core.hooksPath=${path.join(root, 'no-hooks')}`,
    'commit', '--quiet', '-m', 'create fixture',
  ]);
  const revision = await getHeadRevision(root);
  assert.ok(revision !== undefined);
  await git(root, ['mv', '--', 'before.ts', 'after.ts']);

  assert.deepEqual(await listChangedFiles(root), ['after.ts', 'before.ts']);
  assert.equal(await readGitBase(root, 'before.ts', revision), original);
  assert.equal(await readGitBase(root, 'after.ts', revision), '');
});

/** Commit everything staged in a fixture without user Git configuration or hooks. */
async function commit(root: string, message: string): Promise<void> {
  await git(root, [
    '-c', 'user.name=DiffGuide Test', '-c', 'user.email=diffguide@example.invalid',
    '-c', 'commit.gpgSign=false', '-c', `core.hooksPath=${path.join(root, 'no-hooks')}`,
    'commit', '--quiet', '-m', message,
  ]);
}

/** Create a fixture repository with one committed file. */
async function fixture(t: { after(callback: () => Promise<void>): void }): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'diffguide-git-'));
  t.after(async () => { await rm(root, { recursive: true, force: true }); });
  await git(root, ['init', '--quiet']);
  await writeFile(path.join(root, 'kept.ts'), 'export const kept = 1;\n');
  await writeFile(path.join(root, 'removed.ts'), 'export const removed = 1;\n');
  await git(root, ['add', '--', '.']);
  await commit(root, 'create fixture');
  return root;
}

test('lists modified, deleted and untracked files against HEAD by default', async (t) => {
  const root = await fixture(t);
  await writeFile(path.join(root, 'kept.ts'), 'export const kept = 2;\n');
  await rm(path.join(root, 'removed.ts'));
  await writeFile(path.join(root, 'added.ts'), 'export const added = 1;\n');

  assert.deepEqual(await listChangedFiles(root), ['added.ts', 'kept.ts', 'removed.ts']);
});

test('lists nothing for a clean working tree', async (t) => {
  const root = await fixture(t);

  assert.deepEqual(await listChangedFiles(root), []);
});

test('lists staged and untracked files in a repository without commits', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'diffguide-git-'));
  t.after(async () => { await rm(root, { recursive: true, force: true }); });
  await git(root, ['init', '--quiet']);
  await writeFile(path.join(root, 'staged.ts'), 'export const staged = 1;\n');
  await git(root, ['add', '--', 'staged.ts']);
  await writeFile(path.join(root, 'loose.ts'), 'export const loose = 1;\n');

  assert.equal(await getHeadRevision(root), undefined);
  assert.deepEqual(await listChangedFiles(root), ['loose.ts', 'staged.ts']);
});

test('includes committed changes when comparing against an earlier base', async (t) => {
  const root = await fixture(t);
  const base = await getHeadRevision(root);
  assert.ok(base !== undefined);
  await writeFile(path.join(root, 'kept.ts'), 'export const kept = 2;\n');
  await git(root, ['add', '--', 'kept.ts']);
  await commit(root, 'change kept');
  await writeFile(path.join(root, 'added.ts'), 'export const added = 1;\n');

  assert.deepEqual(await listChangedFiles(root), ['added.ts']);
  assert.deepEqual(await listChangedFiles(root, base), ['added.ts', 'kept.ts']);
  assert.equal(await readGitBase(root, 'kept.ts', base), 'export const kept = 1;\n');
});
