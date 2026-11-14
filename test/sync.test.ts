import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { commitAndPush, discardSince, prepareConflictFix, worktreeSnapshot } from '../src/core/conflicts.js';
import { snapshot } from '../src/core/git/backups.js';
import { recordGitHubHead, syncWithPullRequest } from '../src/core/git/sync.js';
import { removeWorktree, worktreePath } from '../src/core/git/worktrees.js';

// Every cell of docs/SYNC.md's decision table against a real checkout and a fake GitHub repository.
// A cell named in `gaps` runs as a todo: it reports what fails today without failing the suite. Fixing a gap removes its name.

const run = promisify(execFile);
const git = async (root: string, ...args: string[]): Promise<string> => (await run('git', ['-C', root, ...args])).stdout.trim();
const identity = [['user.name', 't'], ['user.email', 't@example.invalid'], ['commit.gpgSign', 'false']] as const;
const lines = (first: string, last = 'five'): string => `${first}\ntwo\nthree\nfour\n${last}\n`;

interface Repos { readonly origin: string; readonly worktree: string; readonly scratch: string }

/** GitHub as `origin` with `main` and PR #7 on `feature`, and a clone detached at the PR's head. */
async function fixture(t: test.TestContext): Promise<Repos> {
  const scratch = await mkdtemp(path.join(tmpdir(), 'diffguide-sync-'));
  t.after(async () => { await rm(scratch, { recursive: true, force: true }); });
  const origin = path.join(scratch, 'origin');
  await git(scratch, 'init', '--quiet', '--initial-branch=main', origin);
  for (const [key, value] of identity) await git(origin, 'config', key, value);
  await writeFile(path.join(origin, 'a.txt'), lines('one'));
  await writeFile(path.join(origin, 'b.txt'), 'b\n');
  await git(origin, 'add', '.');
  await git(origin, 'commit', '--quiet', '-m', 'base');
  await git(origin, 'switch', '--quiet', '-c', 'feature');
  await writeFile(path.join(origin, 'b.txt'), 'feature\n');
  await git(origin, 'commit', '--quiet', '-am', 'feature');
  await git(origin, 'update-ref', 'refs/pull/7/head', 'feature');
  await git(origin, 'switch', '--quiet', 'main');
  const worktree = path.join(scratch, 'worktree');
  await git(scratch, 'clone', '--quiet', origin, worktree);
  for (const [key, value] of identity) await git(worktree, 'config', key, value);
  await git(worktree, 'fetch', '--quiet', 'origin', 'pull/7/head');
  await git(worktree, 'checkout', '--quiet', '--detach', 'FETCH_HEAD');
  await recordGitHubHead(worktree, 7, await git(worktree, 'rev-parse', 'HEAD'));
  return { origin, worktree, scratch };
}

/** Commit on GitHub's PR branch: line one of `a.txt` changes and `n.txt` appears. */
async function pushOnGitHub(origin: string, { force }: { force: boolean }): Promise<void> {
  await git(origin, 'switch', '--quiet', 'feature');
  await writeFile(path.join(origin, 'a.txt'), lines('remote'));
  await writeFile(path.join(origin, 'n.txt'), 'from github\n');
  await git(origin, 'add', '.');
  await git(origin, 'commit', '--quiet', ...force ? ['--amend', '-m', 'feature, rewritten'] : ['-m', 'more']);
  await git(origin, 'update-ref', 'refs/pull/7/head', 'feature');
  await git(origin, 'switch', '--quiet', 'main');
}

/** What the checkout holds that GitHub's PR head does not: commits, and every tracked, staged or untracked file version. */
interface Material { readonly commits: readonly string[]; readonly files: ReadonlyMap<string, string> }

async function material(worktree: string, githubHead: string): Promise<Material> {
  const commits = (await git(worktree, 'rev-list', 'HEAD', '--not', githubHead)).split('\n').filter(Boolean);
  const files = new Map<string, string>();
  for (const file of (await git(worktree, 'ls-files', '-z', '--cached', '--others', '--exclude-standard')).split('\0').filter(Boolean)) {
    if (await stat(path.join(worktree, file)).then(() => true, () => false)) files.set(`${file} (working)`, await git(worktree, 'hash-object', '--', file));
  }
  for (const entry of (await git(worktree, 'ls-files', '-s', '-z')).split('\0').filter(Boolean)) {
    const [, blob = ''] = entry.split(' ');
    files.set(`${entry.slice(entry.indexOf('\t') + 1)} (staged)`, blob);
  }
  return { commits, files };
}

/** Material the checkout lost: not in HEAD's history or the working tree, and not reachable from any ref. Reflogs do not count; Git expires them. */
async function lost(repository: string, worktree: string | undefined, before: Material): Promise<readonly string[]> {
  const reachable = new Set((await git(repository, 'rev-list', '--objects', '--all')).split('\n').map((line) => line.split(' ')[0]));
  if (worktree !== undefined && await stat(worktree).then(() => true, () => false)) {
    for (const line of (await git(worktree, 'rev-list', '--objects', 'HEAD')).split('\n')) reachable.add(line.split(' ')[0]);
    for (const entry of (await git(worktree, 'ls-files', '-s', '-z')).split('\0').filter(Boolean)) reachable.add(entry.split(' ')[1]);
    for (const file of (await git(worktree, 'ls-files', '-z', '--cached', '--others', '--exclude-standard')).split('\0').filter(Boolean)) {
      if (await stat(path.join(worktree, file)).then(() => true, () => false)) reachable.add(await git(worktree, 'hash-object', '--', file));
    }
  }
  return [...before.commits.filter((commit) => !reachable.has(commit)).map((commit) => `commit ${commit.slice(0, 7)}`),
    ...[...before.files].filter(([, blob]) => !reachable.has(blob)).map(([file]) => file)];
}

type Outcome = 'synced' | 'waits' | 'claude' | 'error';

/** The poll path, as `worktreeActions.pollGitHub` runs it: an error becomes the page's red problem line. */
async function sync(worktree: string, pushedHead: string | undefined): Promise<{ outcome: Outcome; error?: string }> {
  try {
    return { outcome: (await syncWithPullRequest(worktree, 7, pushedHead)).outcome };
  } catch (error: unknown) {
    return { outcome: 'error', error: error instanceof Error ? error.message : String(error) };
  }
}

interface Local { readonly name: string; readonly setUp: (repos: Repos) => Promise<void> }

const locals: readonly Local[] = [
  { name: 'nothing local', setUp: async () => undefined },
  { name: 'edits to another file', setUp: async ({ worktree }) => { await writeFile(path.join(worktree, 'b.txt'), 'mine\n'); } },
  { name: 'edits to other lines of the same file', setUp: async ({ worktree }) => { await writeFile(path.join(worktree, 'a.txt'), lines('one', 'mine')); } },
  { name: 'staged and unstaged edits to other lines', setUp: async ({ worktree }) => {
    await writeFile(path.join(worktree, 'a.txt'), lines('one', 'staged'));
    await git(worktree, 'add', 'a.txt');
    await writeFile(path.join(worktree, 'a.txt'), lines('one', 'unstaged'));
  } },
  { name: 'edits to the same line', setUp: async ({ worktree }) => { await writeFile(path.join(worktree, 'a.txt'), lines('mine')); } },
  { name: 'an untracked file GitHub also adds', setUp: async ({ worktree }) => { await writeFile(path.join(worktree, 'n.txt'), 'mine\n'); } },
  { name: 'local commits', setUp: async ({ worktree }) => {
    await writeFile(path.join(worktree, 'c.txt'), 'mine\n');
    await git(worktree, 'add', 'c.txt');
    await git(worktree, 'commit', '--quiet', '-m', 'local');
  } },
  { name: 'local commits and edits', setUp: async ({ worktree }) => {
    await writeFile(path.join(worktree, 'c.txt'), 'mine\n');
    await git(worktree, 'add', 'c.txt');
    await git(worktree, 'commit', '--quiet', '-m', 'local');
    await writeFile(path.join(worktree, 'b.txt'), 'mine\n');
  } },
  { name: 'your merge in progress', setUp: async ({ worktree }) => {
    const start = await git(worktree, 'rev-parse', 'HEAD');
    await writeFile(path.join(worktree, 'b.txt'), 'theirs\n');
    await git(worktree, 'commit', '--quiet', '-am', 'theirs');
    const theirs = await git(worktree, 'rev-parse', 'HEAD');
    await git(worktree, 'checkout', '--quiet', '--detach', start);
    await writeFile(path.join(worktree, 'b.txt'), 'mine\n');
    await git(worktree, 'commit', '--quiet', '-am', 'local');
    await git(worktree, 'merge', '--no-edit', theirs).catch(() => undefined);
  } },
  { name: 'index.lock held for a moment', setUp: async ({ worktree }) => {
    await writeFile(path.join(worktree, '.git', 'index.lock'), '');
    setTimeout(() => { void rm(path.join(worktree, '.git', 'index.lock'), { force: true }); }, 1_000);
  } },
];

interface Remote { readonly name: string; readonly event: (repos: Repos) => Promise<void>; readonly pushedHead: 'known' | 'unknown' }

const remotes: readonly Remote[] = [
  { name: 'GitHub added commits', event: async ({ origin }) => { await pushOnGitHub(origin, { force: false }); }, pushedHead: 'known' },
  { name: 'GitHub force-pushed', event: async ({ origin }) => { await pushOnGitHub(origin, { force: true }); }, pushedHead: 'known' },
  { name: 'GitHub force-pushed before the first poll', event: async ({ origin }) => { await pushOnGitHub(origin, { force: true }); }, pushedHead: 'unknown' },
  { name: 'offline', event: async ({ origin, worktree }) => {
    await pushOnGitHub(origin, { force: false });
    await git(worktree, 'remote', 'set-url', 'origin', path.join(origin, 'missing'));
  }, pushedHead: 'known' },
];

/** What each cell should end in once sync is fixed. */
function expected(local: Local, remote: Remote): Outcome {
  if (remote.name === 'offline' || local.name === 'your merge in progress') return 'waits';
  if (local.name === 'edits to the same line' || local.name === 'an untracked file GitHub also adds') return 'claude';
  return 'synced';
}

/** Cells that fail today, by `<local> / <remote>`. */
const gaps = new Set([
  'index.lock held for a moment / GitHub added commits',
  'index.lock held for a moment / GitHub force-pushed',
  'index.lock held for a moment / GitHub force-pushed before the first poll',
  'your merge in progress / GitHub added commits',
  'your merge in progress / GitHub force-pushed',
  'your merge in progress / GitHub force-pushed before the first poll',
  ...locals.map((local) => `${local.name} / offline`),
]);

const show = (worktree: string, spec: string): Promise<string> => git(worktree, 'show', spec);
const read = (worktree: string, file: string): Promise<string> => readFile(path.join(worktree, file), 'utf8');

/** What a synced checkout shows besides GitHub's commits: the local work, merged onto them and still staged, unstaged or committed as before. */
const syncedWork: Readonly<Record<string, (worktree: string, githubHead: string) => Promise<void>>> = {
  'edits to another file': async (worktree) => { assert.equal(await read(worktree, 'b.txt'), 'mine\n'); },
  'edits to other lines of the same file': async (worktree) => {
    assert.equal(await read(worktree, 'a.txt'), lines('remote', 'mine'));
    assert.equal(await git(worktree, 'status', '--porcelain', '--', 'a.txt'), 'M a.txt');
  },
  'staged and unstaged edits to other lines': async (worktree) => {
    assert.equal(await show(worktree, ':a.txt'), lines('remote', 'staged').trimEnd());
    assert.equal(await read(worktree, 'a.txt'), lines('remote', 'unstaged'));
  },
  'local commits': async (worktree, githubHead) => {
    assert.equal(await git(worktree, 'rev-parse', 'HEAD^'), githubHead);
    assert.equal(await git(worktree, 'log', '-1', '--format=%s'), 'local');
    assert.equal(await show(worktree, 'HEAD:c.txt'), 'mine');
  },
  'local commits and edits': async (worktree, githubHead) => {
    assert.equal(await git(worktree, 'rev-parse', 'HEAD^'), githubHead);
    assert.equal(await show(worktree, 'HEAD:c.txt'), 'mine');
    assert.equal(await read(worktree, 'b.txt'), 'mine\n');
    assert.equal(await git(worktree, 'status', '--porcelain'), 'M b.txt');
  },
};

for (const local of locals) {
  for (const remote of remotes) {
    const cell = `${local.name} / ${remote.name}`;
    test(`sync: ${cell}`, { todo: gaps.has(cell) ? 'gap' : false }, async (t) => {
      const repos = await fixture(t);
      const githubHead = await git(repos.worktree, 'rev-parse', 'HEAD');
      await local.setUp(repos);
      const before = await material(repos.worktree, githubHead);
      const state = { head: await git(repos.worktree, 'rev-parse', 'HEAD'), files: await snapshot(repos.worktree).catch(() => undefined) };
      await remote.event(repos);
      const result = await sync(repos.worktree, remote.pushedHead === 'known' ? githubHead : undefined);
      assert.deepEqual(await lost(repos.worktree, repos.worktree, before), [], 'lost local work');
      assert.equal(result.outcome, expected(local, remote), result.error);
      if (result.outcome === 'synced') {
        const newHead = await git(repos.origin, 'rev-parse', 'refs/pull/7/head');
        assert.ok(await git(repos.worktree, 'merge-base', '--is-ancestor', newHead, 'HEAD').then(() => true, () => false), 'GitHub\'s commits are missing');
        assert.equal(await show(repos.worktree, 'HEAD:n.txt'), 'from github');
        await syncedWork[local.name]?.(repos.worktree, newHead);
      } else {
        assert.equal(await git(repos.worktree, 'rev-parse', 'HEAD'), state.head, 'HEAD moved');
        assert.deepEqual(await snapshot(repos.worktree).catch(() => undefined), state.files, 'files changed');
      }
    });
  }
}

/** Actions outside polling that write to the checkout. */
const actionGaps = new Set([
  'Fix conflicts with uncommitted edits keeps them and proceeds',
  'a push GitHub rejects because the PR moved syncs and pushes again',
  'after Claude\'s run on someone else\'s PR, files you changed meanwhile stay in place',
]);

const action = (name: string, body: (t: test.TestContext) => Promise<void>): void => {
  test(`action: ${name}`, { todo: actionGaps.has(name) ? 'gap' : false }, body);
};

action('after Claude\'s run on someone else\'s PR, files you changed meanwhile survive', async (t) => {
  const { worktree } = await fixture(t);
  const start = await worktreeSnapshot(worktree);
  await writeFile(path.join(worktree, 'a.txt'), lines('claude'));
  await writeFile(path.join(worktree, 'b.txt'), 'mine\n');
  await writeFile(path.join(worktree, 'c.txt'), 'mine\n');
  const yours = { commits: [], files: new Map([...(await material(worktree, start.head)).files].filter(([file]) => !file.startsWith('a.txt'))) };
  await discardSince(worktree, start.head);
  assert.deepEqual(await lost(worktree, worktree, yours), []);
});

action('after Claude\'s run on someone else\'s PR, files you changed meanwhile stay in place', async (t) => {
  const { worktree } = await fixture(t);
  const start = await worktreeSnapshot(worktree);
  await writeFile(path.join(worktree, 'a.txt'), lines('claude'));
  await writeFile(path.join(worktree, 'b.txt'), 'mine\n');
  await discardSince(worktree, start.head);
  assert.equal(await readFile(path.join(worktree, 'b.txt'), 'utf8'), 'mine\n');
});

action('Remove worktree keeps unpushed commits', async (t) => {
  const { scratch, worktree: source } = await fixture(t);
  const storage = path.join(scratch, 'storage');
  const folder = worktreePath(storage, 'acme/app', 7);
  await mkdir(path.dirname(folder), { recursive: true });
  await git(source, 'worktree', 'add', '--quiet', '--detach', folder);
  const githubHead = await git(folder, 'rev-parse', 'HEAD');
  await writeFile(path.join(folder, 'c.txt'), 'mine\n');
  await git(folder, 'add', 'c.txt');
  await git(folder, 'commit', '--quiet', '-m', 'unpushed');
  const before = await material(folder, githubHead);
  await removeWorktree(source, storage, 'acme/app', 7).catch(() => undefined);
  assert.deepEqual(await lost(source, undefined, before), []);
});

action('a push GitHub rejects because the PR moved syncs and pushes again', async (t) => {
  const { origin, worktree } = await fixture(t);
  await pushOnGitHub(origin, { force: false });
  await writeFile(path.join(worktree, 'b.txt'), 'suggested\n');
  await commitAndPush(worktree, { path: 'b.txt', message: 'Apply suggestion from code review', pushTo: 'origin', headBranch: 'feature', hooksOff: true });
  assert.equal(await git(origin, 'show', 'feature:b.txt'), 'suggested');
  assert.equal(await git(origin, 'show', 'feature:n.txt'), 'from github');
});

action('Fix conflicts with uncommitted edits keeps them and proceeds', async (t) => {
  const { worktree } = await fixture(t);
  await writeFile(path.join(worktree, 'c.txt'), 'mine\n');
  await prepareConflictFix(worktree, 7, 'main');
  assert.equal(await readFile(path.join(worktree, 'c.txt'), 'utf8'), 'mine\n');
});
