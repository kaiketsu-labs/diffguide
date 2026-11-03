import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

import { conflictTask, prepareConflictFix } from '../src/conflicts.js';

const run = promisify(execFile);
const git = async (root: string, ...args: string[]): Promise<string> => (await run('git', ['-C', root, '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'commit.gpgSign=false', ...args])).stdout.trim();

/** An origin with `main` and PR #7, and a worktree checked out at an older PR commit. */
async function fixture(t: test.TestContext): Promise<{ origin: string; worktree: string; older: string; latest: string; base: string }> {
  const scratch = await mkdtemp(path.join(tmpdir(), 'pair-review-conflicts-'));
  t.after(async () => { await rm(scratch, { recursive: true, force: true }); });
  const origin = path.join(scratch, 'origin');
  await git(scratch, 'init', '--quiet', '--initial-branch=main', origin);
  await writeFile(path.join(origin, 'a.txt'), 'one\n');
  await git(origin, 'add', '.');
  await git(origin, 'commit', '--quiet', '-m', 'base');
  await git(origin, 'switch', '--quiet', '-c', 'feature');
  await writeFile(path.join(origin, 'a.txt'), 'feature\n');
  await git(origin, 'commit', '--quiet', '-am', 'older');
  const older = await git(origin, 'rev-parse', 'HEAD');
  await writeFile(path.join(origin, 'b.txt'), 'more\n');
  await git(origin, 'add', '.');
  await git(origin, 'commit', '--quiet', '-m', 'latest');
  const latest = await git(origin, 'rev-parse', 'HEAD');
  await git(origin, 'update-ref', 'refs/pull/7/head', latest);
  await git(origin, 'switch', '--quiet', 'main');
  await writeFile(path.join(origin, 'a.txt'), 'main\n');
  await git(origin, 'commit', '--quiet', '-am', 'conflicting');
  const base = await git(origin, 'rev-parse', 'HEAD');
  const worktree = path.join(scratch, 'worktree');
  await git(scratch, 'clone', '--quiet', origin, worktree);
  await git(worktree, 'checkout', '--quiet', '--detach', older);
  return { origin, worktree, older, latest, base };
}

test('brings the worktree to the PR\'s latest commit and returns the base to merge', async (t) => {
  const { worktree, latest, base } = await fixture(t);
  assert.equal(await prepareConflictFix(worktree, 7, 'main'), base);
  assert.equal(await git(worktree, 'rev-parse', 'HEAD'), latest);
});

test('refuses a worktree with uncommitted changes or commits GitHub does not have', async (t) => {
  const { worktree } = await fixture(t);
  await writeFile(path.join(worktree, 'a.txt'), 'unsaved\n');
  await assert.rejects(prepareConflictFix(worktree, 7, 'main'), /uncommitted changes/u);
  await git(worktree, 'commit', '--quiet', '-am', 'local only');
  await assert.rejects(prepareConflictFix(worktree, 7, 'main'), /not on GitHub/u);
});

test('lets Claude push only the PR branch, and rejects names that could be read as options', () => {
  const fix = { base: 'a'.repeat(40), baseBranch: 'main', headBranch: 'feat/retry', pushTo: 'origin' };
  const task = conflictTask(fix);
  assert.ok(task.allowedTools.includes('Bash(git push origin HEAD:refs/heads/feat/retry)'));
  assert.ok(!task.allowedTools.some((tool) => tool === 'Bash' || tool.startsWith('Bash(git push *')));
  assert.match(task.prompt, new RegExp(`git merge --no-edit ${fix.base}`, 'u'));
  assert.ok(conflictTask({ ...fix, pushTo: 'https://github.com/someone/app.git' }).allowedTools.includes('Bash(git push https://github.com/someone/app.git HEAD:refs/heads/feat/retry)'));
  assert.throws(() => conflictTask({ ...fix, headBranch: '--force' }));
  assert.throws(() => conflictTask({ ...fix, pushTo: 'ext::sh -c id' }));
  assert.throws(() => conflictTask({ ...fix, base: 'HEAD' }));
});
