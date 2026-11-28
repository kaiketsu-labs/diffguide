import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { ChangeRequestComment } from '../src/core/forge.js';
import { ensureWorktree, git, readPullRequestBase, reviewDataPath } from '../src/core/git/worktrees.js';
import { createReviewStore } from '../src/core/store.js';
import { readStoredAnalysis } from '../src/core/prAnalysis.js';
import { createDemoForge } from '../src/forges/demo/fakeForge.js';
import { demoCommits, demoFixture, demoNumber, demoRepository } from '../src/forges/demo/fixture.js';
import { buildSampleRepository, demoBranch } from '../src/forges/demo/sampleRepo.js';

const recipe = 'demo/sample-repo';

async function scratch(t: { after(callback: () => Promise<void>): void }): Promise<string> {
  const folder = await mkdtemp(path.join(tmpdir(), 'diffguide-demo-'));
  t.after(async () => { await rm(folder, { recursive: true, force: true }); });
  return folder;
}

test('the sample repository gets the same commit ids on every build, and they match the fixture', async (t) => {
  const first = await buildSampleRepository(recipe, path.join(await scratch(t), 'repo'));
  const second = await buildSampleRepository(recipe, path.join(await scratch(t), 'repo'));
  assert.deepEqual(second, first);
  assert.deepEqual({ base: first.base, pushed: first.pushed }, { base: demoCommits.base, pushed: [...demoCommits.pushed] });
});

test('the sample repository has a pushed PR branch, one unpushed commit and one uncommitted edit', async (t) => {
  const root = path.join(await scratch(t), 'repo');
  const { unpushed } = await buildSampleRepository(recipe, root);
  assert.equal((await git(root, ['branch', '--show-current'])).trim(), demoBranch);
  assert.equal((await git(root, ['rev-parse', 'HEAD'])).trim(), unpushed);
  assert.equal((await git(root, ['rev-list', '--count', `origin/${demoBranch}..HEAD`])).trim(), '1');
  assert.equal((await git(root, ['status', '--porcelain'])).trim(), 'M src/export/stream.ts');
  const changes = (await git(root, ['diff', '--name-status', '-M', 'origin/main', `origin/${demoBranch}`])).trim().split('\n').map((line) => line.split('\t')[0]?.[0]);
  for (const kind of ['A', 'D', 'M', 'R']) assert.ok(changes.includes(kind), `the PR has no ${kind} file`);
  assert.deepEqual(demoFixture.files.map((file) => file.path).sort(), (await git(root, ['diff', '--name-only', '-M', 'origin/main', `origin/${demoBranch}`])).trim().split('\n').sort());
});

test('the demo PR is the first row and carries every kind of seed data', async () => {
  const forge = createDemoForge();
  assert.equal((await forge.listMine())[0]?.number, demoNumber);
  const { details, threads } = await forge.overview(demoNumber);
  assert.deepEqual([...new Set(details.reviewers.map((reviewer) => reviewer.state))].sort(), ['approved', 'commented', 'requested']);
  assert.deepEqual([...new Set(details.checks.map((check) => check.state))].sort(), ['failure', 'neutral', 'pending', 'success']);
  assert.ok(threads.some((thread) => !thread.resolved && !thread.outdated && thread.comments.length === 1), 'no open thread');
  assert.ok(threads.some((thread) => thread.comments.length > 1 && thread.comments.some((comment) => comment.author === 'you') && !thread.resolved), 'no answered thread');
  assert.ok(threads.some((thread) => thread.resolved), 'no resolved thread');
  assert.ok(threads.some((thread) => thread.outdated), 'no outdated thread');
  const conversation = await forge.conversation(demoNumber);
  assert.deepEqual([...new Set(conversation.timeline.map((item) => item.kind))].sort(), ['comment', 'commit', 'event', 'review']);
  assert.equal(conversation.linkedIssues.length, 1);
  assert.ok(details.labels.length > 0 && details.milestone !== undefined);
});

test('writes to the demo PR can be read back and do not outlive the forge', async () => {
  const forge = createDemoForge();
  const comment: ChangeRequestComment = { path: 'src/notes/store.ts', body: 'Name this `exportTo` option.', commitId: demoCommits.pushed[3], side: 'RIGHT', lines: { start: 4, end: 5 } };
  const url = await forge.publishComment(demoNumber, comment, true);
  let threads = await forge.threads(demoNumber);
  const created = threads.find((thread) => url.endsWith(thread.id));
  assert.ok(created !== undefined && created.pending && created.comments[0]?.body === comment.body);
  assert.equal((await forge.details(demoNumber)).pendingComments, 1);

  await forge.replyToThread(created.id, 'Done.');
  await forge.resolveThread(created.id, true);
  threads = await forge.threads(demoNumber);
  assert.deepEqual(threads.find((thread) => thread.id === created.id)?.comments.map((each) => each.body), [comment.body, 'Done.']);
  assert.equal(threads.find((thread) => thread.id === created.id)?.resolved, true);

  await forge.submitReview(demoNumber, 'requestChanges', 'Please rename it.');
  const { details } = await forge.overview(demoNumber);
  assert.equal(details.pendingComments, undefined);
  assert.equal(details.reviewers.find((reviewer) => reviewer.name === 'you')?.state, 'changes');
  const review = (await forge.conversation(demoNumber)).timeline.find((item) => item.kind === 'review' && item.body === 'Please rename it.');
  assert.ok(review?.kind === 'review' && review.state === 'changes' && review.comments.length === 1);

  await forge.addComment(demoNumber, 'Merging after checks.');
  assert.ok((await forge.conversation(demoNumber)).timeline.some((item) => item.kind === 'comment' && item.body === 'Merging after checks.'));

  await forge.deleteComment(created.comments[0]?.id ?? '');
  assert.equal((await forge.threads(demoNumber)).find((thread) => thread.id === created.id)?.comments.length, 1);

  assert.equal((await createDemoForge().threads(demoNumber)).length, demoFixture.threads.length);
});

test('opening the demo PR seeds its guide and Local threads from the real diff', async (t) => {
  const folder = await scratch(t);
  const source = path.join(folder, 'repo');
  const { pushed } = await buildSampleRepository(recipe, source);
  const worktree = await ensureWorktree(source, path.join(folder, 'storage'), createDemoForge(), demoRepository.name, demoFixture.summary, 'author');
  assert.equal((await git(worktree, ['rev-parse', 'HEAD'])).trim(), pushed.at(-1));

  const analysis = readStoredAnalysis(JSON.parse(await readFile(path.join(reviewDataPath(worktree), 'analysis.json'), 'utf8')));
  assert.equal(analysis?.head, pushed.at(-1));
  assert.equal(analysis?.groups.length, 4);
  assert.ok(analysis?.groups.flatMap((group) => group.steps).every((step) => step.blocks.length > 0), 'a guide step names no changed block');
  const base = await readPullRequestBase(worktree, 'main');
  assert.equal(base, demoCommits.base);

  const store = await createReviewStore(path.join(reviewDataPath(worktree), 'review.json'), worktree);
  assert.deepEqual(store.threads.map((thread) => [thread.status, thread.resolved, thread.messages.map((message) => message.author)]), [
    ['answered', false, ['human', 'claude']],
    ['answered', true, ['human', 'claude']],
  ]);
  assert.deepEqual(store.pendingEvents, []);
});
