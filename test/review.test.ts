import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import type { CodeAnchor, Finding } from '../src/contracts.js';
import { maximumFindings, parseReviewOutput, readStoredReview, reviewAgents, reviewPrompt } from '../src/review.js';
import { createReviewStore } from '../src/store.js';
import { parseUnifiedDiff } from '../src/unifiedDiff.js';

const diff = [
  'diff --git a/src/a.ts b/src/a.ts',
  '--- a/src/a.ts',
  '+++ b/src/a.ts',
  '@@ -1,3 +1,4 @@',
  ' const a = 1;',
  '-const b = 2;',
  '+const b = 3;',
  '+const c = 4;',
  ' const d = 5;',
  'diff --git a/src/gone.ts b/src/gone.ts',
  'deleted file mode 100644',
  '--- a/src/gone.ts',
  '+++ /dev/null',
  '@@ -1,1 +0,0 @@',
  '-export {};',
  'diff --git a/logo.png b/logo.png',
  'Binary files a/logo.png and b/logo.png differ',
  '',
].join('\n');
const files = parseUnifiedDiff(diff);

const anchor = (startLine: number): CodeAnchor => ({
  path: 'src/a.ts', startLine, endLine: startLine, selectedText: 'x', contextBefore: '', contextAfter: '', documentHash: 'h', side: 'working', baseRevision: 'base',
});
const finding: Finding = { reviewers: ['correctness'], severity: 'high', evidence: 'tested' };
const note = (line: number, title = 'Wrong result'): { anchor: CodeAnchor; text: string; title: string; finding: Finding } => ({ anchor: anchor(line), text: `Claim ${line}`, title, finding });

async function openStore(t: test.TestContext): ReturnType<typeof createReviewStore> {
  const root = await mkdtemp(path.join(tmpdir(), 'diffguide-review-'));
  t.after(async () => { await rm(root, { recursive: true, force: true }); });
  return createReviewStore(path.join(root, 'review.json'), root);
}

test('opens review findings as threads that start with Claude and carry the title and finding', async (t) => {
  const store = await openStore(t);
  const [id] = await store.replaceReviewFindings([note(1, 'Off by one')]);
  assert.ok(id !== undefined);
  const thread = store.threads.find((candidate) => candidate.id === id);
  assert.equal(thread?.origin, 'review');
  assert.equal(thread?.title, 'Off by one');
  assert.deepEqual(thread?.finding, finding);
  assert.deepEqual(thread?.messages.map((message) => [message.author, message.text]), [['claude', 'Claim 1']]);
  assert.equal(store.pendingEvents.length, 0);
});

test('replaces untouched review threads but keeps ones that got a reply or were resolved', async (t) => {
  const store = await openStore(t);
  const [replied, resolved, untouched] = await store.replaceReviewFindings([note(1), note(2), note(3)]);
  assert.ok(replied !== undefined && resolved !== undefined && untouched !== undefined);
  await store.submit(anchor(1), 'Why?', 'ask', replied);
  await store.resolve(resolved, true);
  const [fresh] = await store.replaceReviewFindings([note(4)]);
  assert.deepEqual(store.threads.map((thread) => thread.id), [replied, resolved, fresh]);
});

test('keeps guide threads when findings are replaced and review threads when notes are replaced', async (t) => {
  const store = await openStore(t);
  const [guide] = await store.replaceAnalysisNotes([{ anchor: anchor(1), text: 'Guide note' }]);
  const [review] = await store.replaceReviewFindings([note(2)]);
  assert.deepEqual(store.threads.map((thread) => thread.id), [guide, review]);
  const [guideTwo] = await store.replaceAnalysisNotes([{ anchor: anchor(3), text: 'Guide two' }]);
  assert.deepEqual(store.threads.map((thread) => [thread.id, thread.origin]), [[review, 'review'], [guideTwo, 'analysis']]);
  const [reviewTwo] = await store.replaceReviewFindings([note(4)]);
  assert.deepEqual(store.threads.map((thread) => thread.id), [guideTwo, reviewTwo]);
});

test('reloads a review thread from disk', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'diffguide-review-'));
  t.after(async () => { await rm(root, { recursive: true, force: true }); });
  const file = path.join(root, 'review.json');
  const store = await createReviewStore(file, root);
  await store.replaceReviewFindings([note(1)]);
  const reopened = await createReviewStore(file, root);
  assert.deepEqual(reopened.threads, store.threads);
  assert.equal(reopened.threads[0]?.origin, 'review');
});

test('rejects findings with an unknown reviewer, no reviewers or a bad severity', async (t) => {
  const store = await openStore(t);
  const bad = (value: unknown): Finding => value as Finding;
  await assert.rejects(async () => store.replaceReviewFindings([{ ...note(1), finding: bad({ ...finding, reviewers: ['style'] }) }]));
  await assert.rejects(async () => store.replaceReviewFindings([{ ...note(1), finding: bad({ ...finding, reviewers: [] }) }]));
  await assert.rejects(async () => store.replaceReviewFindings([{ ...note(1), finding: bad({ ...finding, severity: 'critical' }) }]));
  assert.equal(store.threads.length, 0);
});

const rawFinding = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  reviewers: ['correctness'], path: 'src/a.ts', startLine: 2, endLine: 3, title: 'Wrong result', body: 'It breaks.', severity: 'high', evidence: 'tested', evidenceDetail: 'ran it', ...overrides,
});
const rawOutput = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({ ran: ['correctness'], skipped: [], candidates: 1, findings: [rawFinding()], dropped: [], ...overrides });
const picked = ['correctness', 'security'] as const;

test('keeps valid review findings', () => {
  const result = parseReviewOutput(rawOutput(), picked, files);
  assert.deepEqual(result.ran, ['correctness']);
  assert.equal(result.candidates, 1);
  assert.deepEqual(result.findings, [{ reviewers: ['correctness'], path: 'src/a.ts', startLine: 2, endLine: 3, title: 'Wrong result', body: 'It breaks.', severity: 'high', evidence: 'tested', evidenceDetail: 'ran it' }]);
  assert.deepEqual(result.dropped, []);
});

test('drops reviewers that were not picked from a finding and from ran', () => {
  const result = parseReviewOutput(rawOutput({ ran: ['correctness', 'design'], findings: [rawFinding({ reviewers: ['correctness', 'design'] }), rawFinding({ reviewers: ['design'] })] }), picked, files);
  assert.deepEqual(result.ran, ['correctness']);
  assert.deepEqual(result.findings.map((item) => item.reviewers), [['correctness']]);
});

test('turns findings off the diff, on deleted or binary files, or with a reversed span into unplaced drops', () => {
  const result = parseReviewOutput(rawOutput({
    findings: [rawFinding({ path: 'src/missing.ts' }), rawFinding({ path: 'src/gone.ts' }), rawFinding({ path: 'logo.png' }), rawFinding({ startLine: 5, endLine: 4 })],
  }), picked, files);
  assert.deepEqual(result.findings, []);
  assert.deepEqual(result.dropped.map((item) => item.reason), ['unplaced', 'unplaced', 'unplaced', 'unplaced']);
});

test('caps findings at the maximum', () => {
  const many = Array.from({ length: maximumFindings + 5 }, (_, index) => rawFinding({ title: `Finding ${index}` }));
  const result = parseReviewOutput(rawOutput({ findings: many }), picked, files);
  assert.equal(maximumFindings, 10);
  assert.deepEqual(result.findings.map((item) => item.title), many.slice(0, maximumFindings).map((item) => item['title']));
});

test('clamps a finding span to 50 lines', () => {
  const result = parseReviewOutput(rawOutput({ findings: [rawFinding({ startLine: 10, endLine: 500 })] }), picked, files);
  assert.deepEqual(result.findings.map((item) => [item.startLine, item.endLine]), [[10, 59]]);
});

test('drops a skipped entry for a reviewer that also ran', () => {
  const result = parseReviewOutput(rawOutput({ ran: ['correctness'], skipped: [{ reviewer: 'correctness', reason: 'x' }, { reviewer: 'security', reason: 'Nothing to check.' }, { reviewer: 'design', reason: 'not picked' }] }), picked, files);
  assert.deepEqual(result.skipped, [{ reviewer: 'security', reason: 'Nothing to check.' }]);
});

test('returns an empty result for output that is not an object', () => {
  for (const raw of [undefined, null, 'text', 3]) {
    assert.deepEqual(parseReviewOutput(raw, picked, files), { ran: [], skipped: [], candidates: 0, findings: [], dropped: [] });
  }
});

const storedReview = {
  createdAt: '2026-11-10T00:00:00.000Z',
  ran: ['correctness'],
  skipped: [{ reviewer: 'security', reason: 'Nothing to check.' }],
  candidates: 3,
  findings: [{ threadId: 't1', title: 'Wrong result', severity: 'high', evidence: 'tested', reviewers: ['correctness'], path: 'src/a.ts', startLine: 2 }],
  dropped: [{ claim: 'A guess', reviewers: ['correctness'], reason: 'refuted', why: 'Test passed.' }],
};

test('round-trips a saved review', () => {
  assert.deepEqual(readStoredReview(JSON.parse(JSON.stringify(storedReview))), storedReview);
});

test('reads no review without createdAt', () => {
  const { createdAt: _createdAt, ...rest } = storedReview;
  assert.equal(readStoredReview(rest), undefined);
  assert.equal(readStoredReview(null), undefined);
});

test('drops malformed findings from a saved review', () => {
  const good = storedReview.findings[0];
  const result = readStoredReview({ ...storedReview, findings: [good, { ...good, severity: 'bad' }, { ...good, threadId: 4 }, { ...good, startLine: 0 }, { ...good, title: '' }] });
  assert.deepEqual(result?.findings, [good]);
});

test('names each review agent after its reviewer with its worktree and the sonnet model', () => {
  const agents = reviewAgents(new Map([['correctness', '/tmp/wt-c'], ['security', '/tmp/wt-s']]));
  assert.deepEqual(Object.keys(agents), ['correctness-reviewer', 'security-reviewer']);
  assert.match(agents['correctness-reviewer']?.prompt ?? '', /\/tmp\/wt-c/u);
  assert.doesNotMatch(agents['correctness-reviewer']?.prompt ?? '', /\/tmp\/wt-s/u);
  assert.match(agents['security-reviewer']?.prompt ?? '', /\/tmp\/wt-s/u);
  assert.deepEqual(Object.values(agents).map((agent) => agent.model), ['sonnet', 'sonnet']);
});

test('lists only the picked reviewers in the prompt and numbers added lines on the new side', () => {
  const prompt = reviewPrompt(files, '#1 Demo', new Map([['security', '/tmp/wt-s']]));
  assert.match(prompt, /- security: subagent security-reviewer/u);
  assert.doesNotMatch(prompt, /- (correctness|design|performance): subagent/u);
  assert.match(prompt, /#1 Demo/u);
  assert.match(prompt, /^ {4}2 \+const b = 3;$/mu);
  assert.match(prompt, /^ {4}3 \+const c = 4;$/mu);
  assert.match(prompt, /^ {4}1 {2}const a = 1;$/mu);
});
