import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { backUp, backupDays, listBackups, snapshot } from '../src/core/git/backups.js';
import { removeWorktree, worktreePath } from '../src/core/git/worktrees.js';
import { removeWorktreeQuestion } from '../src/page/removeWorktree.js';

const run = promisify(execFile);
const git = async (root: string, ...args: string[]): Promise<string> =>
  (await run('git', ['-C', root, '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'commit.gpgSign=false', ...args])).stdout.trim();

/** A repository with one commit holding `a.txt`. */
async function repository(t: test.TestContext): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'diffguide-backups-'));
  t.after(async () => { await rm(root, { recursive: true, force: true }); });
  await git(root, 'init', '--quiet', '--initial-branch=main');
  await writeFile(path.join(root, 'a.txt'), 'one\n');
  await git(root, 'add', '.');
  await git(root, 'commit', '--quiet', '-m', 'base');
  return root;
}

test('backs up staged, unstaged and untracked files and leaves the checkout as it was', async (t) => {
  const root = await repository(t);
  await writeFile(path.join(root, 'a.txt'), 'staged\n');
  await git(root, 'add', 'a.txt');
  await writeFile(path.join(root, 'a.txt'), 'unstaged\n');
  await writeFile(path.join(root, 'new.txt'), 'untracked\n');
  const status = await git(root, 'status', '--porcelain');
  const ref = await backUp(root, 'a test');
  assert.ok(ref !== undefined);
  assert.equal(await git(root, 'status', '--porcelain'), status);
  assert.equal(await git(root, 'show', `${ref}:a.txt`), 'unstaged');
  assert.equal(await git(root, 'show', `${ref}:new.txt`), 'untracked');
  assert.equal(await git(root, 'show', `${ref}^2:a.txt`), 'staged');
  assert.equal(await git(root, 'rev-parse', `${ref}^1`), await git(root, 'rev-parse', 'HEAD'));
});

test('backs up without a configured Git identity and during a merge with conflicts', async (t) => {
  const root = await repository(t);
  await git(root, 'switch', '--quiet', '-c', 'other');
  await writeFile(path.join(root, 'a.txt'), 'theirs\n');
  await git(root, 'commit', '--quiet', '-am', 'theirs');
  await git(root, 'switch', '--quiet', 'main');
  await writeFile(path.join(root, 'a.txt'), 'mine\n');
  await git(root, 'commit', '--quiet', '-am', 'mine');
  await git(root, 'merge', '--no-edit', 'other').catch(() => undefined);
  await git(root, 'config', 'user.useConfigOnly', 'true');
  const saved = { global: process.env['GIT_CONFIG_GLOBAL'], system: process.env['GIT_CONFIG_NOSYSTEM'] };
  process.env['GIT_CONFIG_GLOBAL'] = '/dev/null';
  process.env['GIT_CONFIG_NOSYSTEM'] = '1';
  t.after(() => {
    for (const [key, value] of [['GIT_CONFIG_GLOBAL', saved.global], ['GIT_CONFIG_NOSYSTEM', saved.system]] as const) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });
  const ref = await backUp(root, 'a test');
  assert.ok(ref !== undefined);
  assert.match(await git(root, 'show', `${ref}:a.txt`), /<<<<<<< HEAD\nmine\n=======\ntheirs\n>>>>>>> other/u);
  assert.equal(await git(root, 'rev-list', '--count', '--no-walk', `${ref}^@`), '1');
});

test('sees an edit of the same size saved in the second Git last wrote the index', async (t) => {
  const root = await repository(t);
  // Git builds without nanosecond times, as on Linux, compare whole seconds and size only.
  await git(root, 'config', 'core.checkStat', 'minimal');
  await git(root, 'config', 'core.trustctime', 'false');
  const second = new Date(Date.now() - 60_000);
  await utimes(path.join(root, 'a.txt'), second, second);
  await git(root, 'update-index', '--refresh');
  await writeFile(path.join(root, 'a.txt'), 'two\n');
  await utimes(path.join(root, 'a.txt'), second, second);
  await utimes(path.join(root, '.git', 'index'), second, second);
  const { files } = await snapshot(root);
  assert.equal(await git(root, 'show', `${files}:a.txt`), 'two');
});

test(`prunes a checkout's backups older than ${backupDays} days`, async (t) => {
  const root = await repository(t);
  const day = 86_400_000;
  const now = 100 * day;
  const old = await backUp(root, 'old', now - (backupDays + 1) * day);
  const recent = await backUp(root, 'recent', now - day);
  await backUp(root, 'now', now);
  const refs = (await listBackups(root)).map(({ ref }) => ref);
  assert.ok(old !== undefined && recent !== undefined);
  assert.ok(!refs.includes(old));
  assert.ok(refs.includes(recent));
  assert.equal(refs.length, 2);
});

test('removing a worktree with nothing to lose takes its backups along', async (t) => {
  const source = await repository(t);
  const storage = path.join(source, '.storage');
  const folder = worktreePath(storage, 'acme/app', 3);
  await mkdir(path.dirname(folder), { recursive: true });
  await git(source, 'worktree', 'add', '--quiet', '--detach', folder);
  await git(source, 'remote', 'add', 'origin', source);
  await git(source, 'fetch', '--quiet', 'origin');
  await backUp(folder, 'a test');
  assert.equal((await listBackups(folder)).length, 1);
  await removeWorktree(source, storage, 'acme/app', 3);
  assert.equal(await git(source, 'for-each-ref', 'refs/diffguide/'), '');
});

test('the Remove worktree confirm names unpushed commits and how long their backup stays', () => {
  assert.equal(removeWorktreeQuestion(7, 0), 'Remove the worktree for #7? Its local comments are deleted too. Git refuses if it has uncommitted changes.');
  assert.match(removeWorktreeQuestion(7, 1), /It has 1 commit GitHub does not have; DiffGuide keeps it in a backup for (\d+) days\./u);
  assert.match(removeWorktreeQuestion(undefined, 2), new RegExp(`^Remove the worktree for this PR\\? .* It has 2 commits GitHub does not have; DiffGuide keeps them in a backup for ${backupDays} days\\.`, 'u'));
});
