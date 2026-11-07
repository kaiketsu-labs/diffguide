import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

import { catchUpWithPullRequest, commitAndPush, commitFiles, commitsSince, conflictTask, discardSince, localChanges, prepareConflictFix, pushCommits, syncKeepingLocalCommits, syncToPullRequestHead, unpushedCommits, worktreeSnapshot } from '../src/conflicts.js';

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

test('passes the user\'s answer on when Claude asked how to resolve the conflicts', () => {
  const fix = { base: 'a'.repeat(40), baseBranch: 'main', headBranch: 'feat/retry', pushTo: 'origin' };
  assert.ok(!conflictTask(fix).prompt.includes('They answered'));
  assert.match(conflictTask({ ...fix, answer: '4 attempts, 200 ms' }).prompt, /They answered:\n\n4 attempts, 200 ms$/u);
});

test('commits one file and pushes it to the PR branch, and takes the commit back when the push fails', async (t) => {
  const { origin, worktree, latest } = await fixture(t);
  for (const [key, value] of [['user.name', 't'], ['user.email', 't@example.invalid'], ['commit.gpgSign', 'false']] as const) await git(worktree, 'config', key, value);
  await syncToPullRequestHead(worktree, 7);
  await writeFile(path.join(worktree, 'a.txt'), 'suggested\n');
  await writeFile(path.join(worktree, 'b.txt'), 'unrelated edit\n');
  const push = { path: 'a.txt', message: 'Apply suggestion from code review', pushTo: 'origin', headBranch: 'feature', hooksOff: true };
  await commitAndPush(worktree, push);
  assert.equal(await git(origin, 'log', '-1', '--format=%s', 'feature'), 'Apply suggestion from code review');
  assert.equal(await git(origin, 'show', 'feature:a.txt'), 'suggested');
  assert.equal(await git(origin, 'show', 'feature:b.txt'), 'more');
  assert.equal(await git(origin, 'rev-parse', 'feature~1'), latest);

  const pushed = await git(worktree, 'rev-parse', 'HEAD');
  await git(worktree, 'remote', 'set-url', 'origin', path.join(origin, 'missing'));
  await writeFile(path.join(worktree, 'a.txt'), 'second\n');
  await assert.rejects(commitAndPush(worktree, push));
  assert.equal(await git(worktree, 'rev-parse', 'HEAD'), pushed);
  assert.equal(await readFile(path.join(worktree, 'a.txt'), 'utf8'), 'suggested\n');
  await assert.rejects(commitAndPush(worktree, { ...push, headBranch: '--force' }), /Unsupported/u);
});

test('commits a suggestion after unpushed commits without pushing, and catches up a worktree without any', async (t) => {
  const { origin, worktree, latest } = await fixture(t);
  for (const [key, value] of [['user.name', 't'], ['user.email', 't@example.invalid'], ['commit.gpgSign', 'false']] as const) await git(worktree, 'config', key, value);
  assert.deepEqual(await syncKeepingLocalCommits(worktree, 7), { head: latest, ahead: false });
  assert.equal(await git(worktree, 'rev-parse', 'HEAD'), latest);
  await git(worktree, 'commit', '--quiet', '--allow-empty', '-m', 'by claude');
  assert.deepEqual(await syncKeepingLocalCommits(worktree, 7), { head: latest, ahead: true });
  await writeFile(path.join(worktree, 'a.txt'), 'suggested\n');
  await commitFiles(worktree, { path: 'a.txt', message: 'Apply suggestion from code review', hooksOff: true });
  assert.equal(await git(worktree, 'log', '--format=%s', `${latest}..HEAD`), 'Apply suggestion from code review\nby claude');
  assert.equal(await git(origin, 'rev-parse', 'feature'), latest);
});

test('moves a worktree to the PR head and keeps uncommitted edits the new commits do not touch', async (t) => {
  const { worktree, latest } = await fixture(t);
  await writeFile(path.join(worktree, 'a.txt'), 'local edit\n');
  await syncToPullRequestHead(worktree, 7);
  assert.equal(await git(worktree, 'rev-parse', 'HEAD'), latest);
  assert.equal(await readFile(path.join(worktree, 'a.txt'), 'utf8'), 'local edit\n');
});

test('stays put and names the files when local edits clash with the new commits', async (t) => {
  const { worktree, older } = await fixture(t);
  await writeFile(path.join(worktree, 'b.txt'), 'local\n');
  await assert.rejects(syncToPullRequestHead(worktree, 7), /change files with local edits: b\.txt\./u);
  assert.equal(await git(worktree, 'rev-parse', 'HEAD'), older);
});

test('catches up with the PR before Claude works, keeping local commits built on its latest commit', async (t) => {
  const { worktree, latest } = await fixture(t);
  assert.equal(await catchUpWithPullRequest(worktree, 7), true);
  assert.equal(await git(worktree, 'rev-parse', 'HEAD'), latest);
  await git(worktree, 'commit', '--quiet', '--allow-empty', '-m', 'unpushed');
  const ahead = await git(worktree, 'rev-parse', 'HEAD');
  await catchUpWithPullRequest(worktree, 7);
  assert.equal(await git(worktree, 'rev-parse', 'HEAD'), ahead);
  await git(worktree, 'remote', 'set-url', 'origin', path.join(worktree, 'missing'));
  assert.equal(await catchUpWithPullRequest(worktree, 7), false);
  assert.equal(await git(worktree, 'rev-parse', 'HEAD'), ahead);
});

test('refuses to catch up a worktree whose commits went another way than the PR', async (t) => {
  const { worktree, older } = await fixture(t);
  await git(worktree, 'commit', '--quiet', '--allow-empty', '-m', 'built on an old commit');
  await assert.rejects(catchUpWithPullRequest(worktree, 7), /commits that are not on GitHub/u);
  assert.equal(await git(worktree, 'rev-parse', 'HEAD^'), older);
});

test('follows a force push only from a head GitHub had', async (t) => {
  const { worktree, latest } = await fixture(t);
  await git(worktree, 'commit', '--quiet', '--allow-empty', '-m', 'replaced on GitHub');
  const replaced = await git(worktree, 'rev-parse', 'HEAD');
  await assert.rejects(syncToPullRequestHead(worktree, 7), /commits that are not on GitHub/u);
  await syncToPullRequestHead(worktree, 7, replaced);
  assert.equal(await git(worktree, 'rev-parse', 'HEAD'), latest);
});

test('lists the commits Claude made, counts and pushes them, and can undo a run\'s commits and files', async (t) => {
  const { origin, worktree, latest } = await fixture(t);
  for (const [key, value] of [['user.name', 't'], ['user.email', 't@example.invalid'], ['commit.gpgSign', 'false']] as const) await git(worktree, 'config', key, value);
  await syncToPullRequestHead(worktree, 7);
  const before = await worktreeSnapshot(worktree);
  assert.deepEqual(before, { head: latest, clean: true });
  await writeFile(path.join(worktree, 'a.txt'), 'claude\n');
  await git(worktree, 'commit', '--quiet', '-am', 'Use the configured limit');
  const made = await commitsSince(worktree, before.head);
  assert.deepEqual(made.map((commit) => commit.subject), ['Use the configured limit']);
  assert.equal(made[0]?.oid, await git(worktree, 'rev-parse', 'HEAD'));
  const [local, ...more] = await unpushedCommits(worktree, latest);
  assert.deepEqual({ ...local, createdAt: undefined }, { oid: made[0]?.oid, subject: 'Use the configured limit', author: 't', createdAt: undefined, files: 1, additions: 1, deletions: 1 });
  assert.equal(more.length, 0);
  assert.deepEqual(await unpushedCommits(worktree, 'not-a-commit'), []);

  await pushCommits(worktree, { pushTo: 'origin', headBranch: 'feature', hooksOff: false });
  assert.equal(await git(origin, 'rev-parse', 'feature'), made[0]?.oid);
  await assert.rejects(pushCommits(worktree, { pushTo: 'origin', headBranch: '--force', hooksOff: false }), /Unsupported/u);

  await writeFile(path.join(worktree, 'b.txt'), 'throwaway\n');
  await writeFile(path.join(worktree, 'scratch.txt'), 'test\n');
  await git(worktree, 'commit', '--quiet', '-am', 'Try something');
  await writeFile(path.join(worktree, 'a.txt'), 'uncommitted\n');
  await discardSince(worktree, before.head);
  assert.deepEqual(await worktreeSnapshot(worktree), before);
});

test('commits a suggestion after unpushed commits built on an older PR commit, keeping them', async (t) => {
  const { origin, worktree, older, latest } = await fixture(t);
  for (const [key, value] of [['user.name', 't'], ['user.email', 't@example.invalid'], ['commit.gpgSign', 'false']] as const) await git(worktree, 'config', key, value);
  await writeFile(path.join(worktree, 'c.txt'), 'claude\n');
  await git(worktree, 'add', 'c.txt');
  await git(worktree, 'commit', '--quiet', '-m', 'by claude');
  const claude = await git(worktree, 'rev-parse', 'HEAD');
  assert.deepEqual(await syncKeepingLocalCommits(worktree, 7), { head: latest, ahead: true });
  assert.equal(await git(worktree, 'rev-parse', 'HEAD'), claude);
  await writeFile(path.join(worktree, 'a.txt'), 'suggested\n');
  await commitFiles(worktree, { path: 'a.txt', message: 'Apply suggestion from code review', hooksOff: true });
  assert.equal(await git(worktree, 'log', '--format=%s', `${older}..HEAD`), 'Apply suggestion from code review\nby claude');
  assert.equal(await git(origin, 'rev-parse', 'feature'), latest);
});

test('commits a suggestion after Claude rewrote the pushed commits locally', async (t) => {
  const { worktree, latest } = await fixture(t);
  for (const [key, value] of [['user.name', 't'], ['user.email', 't@example.invalid'], ['commit.gpgSign', 'false']] as const) await git(worktree, 'config', key, value);
  await syncToPullRequestHead(worktree, 7);
  await git(worktree, 'commit', '--quiet', '--amend', '-m', 'latest, reworded');
  const rewritten = await git(worktree, 'rev-parse', 'HEAD');
  assert.deepEqual(await syncKeepingLocalCommits(worktree, 7), { head: latest, ahead: true });
  assert.equal(await git(worktree, 'rev-parse', 'HEAD'), rewritten);
});

test('says to push commits GitHub lacks, or to rebase them when GitHub moved on', async (t) => {
  const { worktree } = await fixture(t);
  await git(worktree, 'commit', '--quiet', '--allow-empty', '-m', 'on the older commit');
  await assert.rejects(syncToPullRequestHead(worktree, 7), /GitHub has newer commits they do not build on\. Rebase them onto the PR's latest commit or drop them first\./u);
  await git(worktree, 'fetch', '--quiet', 'origin', 'pull/7/head');
  await git(worktree, 'checkout', '--quiet', '--detach', 'FETCH_HEAD');
  await git(worktree, 'commit', '--quiet', '--allow-empty', '-m', 'on the latest commit');
  await assert.rejects(syncToPullRequestHead(worktree, 7), /^Error: The PR worktree has commits that are not on GitHub\. Push or drop them first\.$/u);
});

test('tells which files hold unpushed commits and which hold uncommitted edits', async (t) => {
  const { worktree, latest } = await fixture(t);
  await syncToPullRequestHead(worktree, 7);
  assert.deepEqual(await localChanges(worktree, latest), { commits: 0, files: new Map() });
  await writeFile(path.join(worktree, 'a.txt'), 'claude\n');
  await git(worktree, 'commit', '--quiet', '-am', 'Use the configured limit');
  await writeFile(path.join(worktree, 'a.txt'), 'claude again\n');
  await writeFile(path.join(worktree, 'b.txt'), 'edited\n');
  await writeFile(path.join(worktree, 'new.txt'), 'untracked\n');
  const changes = await localChanges(worktree, latest);
  assert.equal(changes.commits, 1);
  assert.deepEqual([...changes.files].sort(), [['a.txt', 'both'], ['b.txt', 'edited'], ['new.txt', 'edited']]);
  assert.deepEqual((await localChanges(worktree, 'f'.repeat(40))).commits, 0);
});
