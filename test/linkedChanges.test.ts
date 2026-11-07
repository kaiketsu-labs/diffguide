import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { addLink, addWorked, addedLines, branchPins, crossReferences, ensureBranchWorktree, linkedBranchName, linkKey, lockWorktree, readStoredLinks, removeLink, writeStoredLinks } from '../src/linkedChanges.js';
import { git } from '../src/worktrees.js';

test('reads branch pins of other GitHub repositories from added diff lines', () => {
  const diff = [
    '+++ b/pyproject.toml',
    '+    "acme-api @ git+https://github.com/acme/api.git@feat/retry",',
    '+acme-web = { git = "https://github.com/acme/web.git", branch = "feat/retry-button" }',
    '+    "ui": "github:acme/ui#feat/retry",',
    '+    "pinned": "git+https://github.com/acme/lib.git@v1.2.3",',
    '+    "sha": "git+https://github.com/acme/lib.git@0a1b2c3d4e5f",',
    '-    "old": "git+https://github.com/acme/old.git@feat/retry",',
  ].join('\n');
  assert.deepEqual(branchPins(addedLines(diff)), [
    { repository: 'acme/api', branch: 'feat/retry' },
    { repository: 'acme/web', branch: 'feat/retry-button' },
    { repository: 'acme/ui', branch: 'feat/retry' },
  ]);
});

test('reads PRs in other repositories from cross-references in both directions', () => {
  const pr = (repository: string, number: number) => ({ number, repository: { nameWithOwner: repository } });
  assert.deepEqual(crossReferences([
    { source: pr('acme/api', 12), target: pr('acme/app', 3) },
    { source: pr('acme/app', 3), target: pr('acme/web', 7) },
    { source: pr('acme/app', 9), target: pr('acme/app', 3) },
    { source: {}, target: pr('acme/api', 12) },
    'junk',
  ], 'acme/app'), [{ repository: 'acme/api', number: 12 }, { repository: 'acme/web', number: 7 }]);
});

test('stores manual links, unlinks and the repositories Claude worked in', async () => {
  const data = await mkdtemp(join(tmpdir(), 'pair-review-links-'));
  assert.deepEqual(await readStoredLinks(data), { added: [], removed: [], worked: [] });
  let links = addLink(await readStoredLinks(data), { repository: 'acme/api', number: 12 });
  links = addWorked(links, 'acme/web');
  links = removeLink(links, 'acme/API#12');
  assert.deepEqual(links, { added: [], removed: ['acme/api#12'], worked: ['acme/web'] });
  links = addLink(links, { repository: 'acme/api', number: 12 });
  links = removeLink(links, linkKey({ repository: 'acme/web' }));
  await writeStoredLinks(data, links);
  assert.deepEqual(await readStoredLinks(data), { added: [{ repository: 'acme/api', number: 12 }], removed: ['acme/web'], worked: [] });
  await writeFile(join(data, 'linked-changes.json'), JSON.stringify({ added: [{ repository: '../x', number: 1 }, { repository: 'a/b', number: -1 }], worked: ['ok/name', 'bad'] }));
  assert.deepEqual(await readStoredLinks(data), { added: [], removed: [], worked: ['ok/name'] });
});

test('names a linked branch after the PR head branch', () => {
  assert.equal(linkedBranchName('feat/retry'), 'feat/retry');
  assert.equal(linkedBranchName('weird name!'), 'weird-name-');
  assert.equal(linkedBranchName('...'), 'pair-review/linked');
});

test('lets one run at a time into a worktree, reports who holds it, and frees a dead holder', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pair-review-lock-'));
  const worktree = join(root, 'pr-12');
  const releaseFirst = await lockWorktree(worktree, 'acme/app#3');
  const waited: string[] = [];
  const second: { release?: () => Promise<void> } = {};
  const taking = lockWorktree(worktree, 'acme/api#12', { pollMs: 10, waiting: (holder) => { waited.push(holder); } }).then((release) => { second.release = release; });
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(second.release, undefined);
  assert.equal(waited[0], 'acme/app#3');
  await releaseFirst();
  await taking;
  const releaseSecond = second.release as (() => Promise<void>) | undefined;
  if (releaseSecond === undefined) assert.fail('the second run never got the lock');

  const stop = new AbortController();
  const stopped = lockWorktree(worktree, 'acme/web#7', { pollMs: 10, signal: stop.signal });
  stop.abort();
  await assert.rejects(stopped, /Stopped/u);
  await releaseSecond();

  await writeFile(`${worktree}.lock`, JSON.stringify({ owner: 'gone', pid: 2 ** 22 + 12345, at: 0 }));
  const release = await lockWorktree(worktree, 'acme/app#3', { pollMs: 10 });
  await release();
});

test('reads a pinned branch from GitHub, detaches when it is checked out elsewhere, and refuses to edit it twice', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pair-review-branch-'));
  const run = (cwd: string, ...args: string[]): Promise<string> => git(cwd, args);
  await run(root, 'init', '--quiet', '--bare', 'remote.git');
  await run(join(root, 'remote.git'), 'symbolic-ref', 'HEAD', 'refs/heads/main');
  await run(root, 'clone', '--quiet', join(root, 'remote.git'), 'b');
  const b = join(root, 'b');
  const commit = (message: string): Promise<string> => run(b, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '--quiet', '--allow-empty', '-m', message);
  await commit('init');
  await run(b, 'push', '--quiet', 'origin', 'HEAD:main');
  await run(b, 'switch', '--quiet', '-c', 'feat/retry');
  await writeFile(join(b, 'api.txt'), 'retry v2\n');
  await run(b, 'add', '.');
  await commit('retry');
  await run(b, 'push', '--quiet', 'origin', 'feat/retry');
  const storage = join(b, '.claude', 'worktrees', 'pair-review');
  assert.equal(await ensureBranchWorktree(b, join(storage, 'read'), 'feat/retry', 'read'), 'feat/retry');
  assert.equal(await readFile(join(storage, 'read', 'api.txt'), 'utf8'), 'retry v2\n');
  await assert.rejects(ensureBranchWorktree(b, join(storage, 'edit'), 'feat/retry', 'edit'), /checked out in another worktree/u);
  assert.equal((await run(b, 'rev-parse', '--abbrev-ref', 'HEAD')).trim(), 'feat/retry');
});
