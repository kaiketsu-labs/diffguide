import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { CodeAnchor, Finding } from '../src/core/contracts.js';
import { findingText, handbackItems, maximumFindings, parseReviewOutput, readStoredReview, reviewAgents, reviewPrompt } from '../src/core/review.js';
import { ReviewTracker } from '../src/core/reviewRunner.js';
import { createReviewStore } from '../src/core/store.js';
import { parseUnifiedDiff } from '../src/core/unifiedDiff.js';

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
  reviewers: ['correctness'], path: 'src/a.ts', startLine: 2, endLine: 3, title: 'Wrong result', body: 'It breaks.', severity: 'high', evidence: 'tested', evidenceDetail: 'ran it', fix: 'Use `<=`.', ...overrides,
});
const rawOutput = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({ ran: ['correctness'], skipped: [], candidates: 1, findings: [rawFinding()], dropped: [], ...overrides });
const picked = ['correctness', 'security'] as const;

test('keeps valid review findings', () => {
  const result = parseReviewOutput(rawOutput(), picked, files);
  assert.deepEqual(result.ran, ['correctness']);
  assert.equal(result.candidates, 1);
  assert.deepEqual(result.findings, [{ reviewers: ['correctness'], path: 'src/a.ts', startLine: 2, endLine: 3, title: 'Wrong result', body: 'It breaks.', severity: 'high', evidence: 'tested', evidenceDetail: 'ran it', fix: 'Use `<=`.' }]);
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

test('fills every placeholder in the bundled prompt files', () => {
  const agents = reviewAgents(new Map([['correctness', '/tmp/wt-c'], ['design', '/tmp/wt-d'], ['security', '/tmp/wt-s'], ['performance', '/tmp/wt-p'], ['tests', '/tmp/wt-t']]));
  const prompts = [...Object.values(agents).map((agent) => agent.prompt), reviewPrompt(files, '#1 Demo', new Map([['design', '/tmp/wt-d']]))];
  for (const prompt of prompts) assert.doesNotMatch(prompt, /\{\{\w+\}\}/u);
  assert.match(agents['design-reviewer']?.prompt ?? '', /^You are the Design reviewer in a code review\. You ask: is this the simplest structure/u);
  assert.match(prompts[5] ?? '', new RegExp(`Keep at most ${maximumFindings};`, 'u'));
});

test('lists only the picked reviewers in the prompt and numbers added lines on the new side', () => {
  const prompt = reviewPrompt(files, '#1 Demo', new Map([['security', '/tmp/wt-s']]));
  assert.match(prompt, /- security: subagent security-reviewer/u);
  assert.doesNotMatch(prompt, /- (correctness|design|performance|tests): subagent/u);
  assert.match(prompt, /#1 Demo/u);
  assert.match(prompt, /^ {4}2 \+const b = 3;$/mu);
  assert.match(prompt, /^ {4}3 \+const c = 4;$/mu);
  assert.match(prompt, /^ {4}1 {2}const a = 1;$/mu);
});

test('reads candidates and verdicts from an agent handback, skipping what does not parse', () => {
  assert.deepEqual(handbackItems('Found these.\n```json\n[{"title":"Off by one","severity":"high"},{"severity":"low"},{"title":"Bad","severity":"urgent"}]\n```'),
    [{ title: 'Off by one', severity: 'high' }, { title: 'Bad' }]);
  assert.deepEqual(handbackItems('Note first.\n[{"title":"Off by one","verdict":"refuted","evidence":"tested"}]'), [{ title: 'Off by one', verdict: 'refuted' }]);
  assert.deepEqual(handbackItems('Nothing provable.'), []);
  assert.deepEqual(handbackItems('```json\n[{"title": \n```'), []);
});

test('tracks the orchestrator and one lane per review agent through each stage', () => {
  let now = 1000;
  const tracker = new ReviewTracker('/repo', ['design', 'security'], new Map([['design', '/repo/wt/design'], ['security', '/repo/wt/security']]), now, () => now);
  const agent = (id: string, reviewer: string) => ({ type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'tool_use', id, name: 'Agent', input: { subagent_type: `${reviewer}-reviewer`, prompt: 'Brief.' } }] } });
  const done = (id: string) => ({ type: 'user', parent_tool_use_id: null, message: { content: [{ type: 'tool_result', tool_use_id: id, content: 'Delivered.' }] } });
  const handback = (parent: string, text: string) => ({ type: 'assistant', parent_tool_use_id: parent, message: { content: [{ type: 'tool_use', id: parent + '-h', name: 'SubagentHandback', input: { message: text } }] } });
  assert.equal(tracker.live.stage, 'triage');
  assert.ok(tracker.read(agent('a1', 'design')));
  tracker.read(agent('a2', 'security'));
  assert.equal(tracker.live.stage, 'candidates');
  assert.ok(tracker.read({ type: 'assistant', parent_tool_use_id: 'a1', message: { content: [{ type: 'tool_use', id: 'r1', name: 'Read', input: { file_path: '/repo/wt/design/src/a.ts' } }] } }));
  assert.deepEqual(tracker.live.lanes.find((lane) => lane.reviewer === 'design')?.steps.map((step) => [step.verb, step.target]), [['Read', 'src/a.ts']]);
  assert.deepEqual(tracker.live.orchestrator.map((step) => step.verb), ['Agent', 'Agent']);
  assert.equal(tracker.read({ type: 'assistant', parent_tool_use_id: 'unknown', message: { content: [] } }), false);
  tracker.read(handback('a1', '```json\n[{"title":"Duplicated helper","severity":"low"}]\n```'));
  now = 4000;
  tracker.read(done('a1'));
  tracker.read(done('a2'));
  assert.equal(tracker.live.stage, 'select');
  assert.deepEqual(tracker.live.lanes.map((lane) => [lane.reviewer, lane.phase, lane.endedAt, lane.items?.length ?? 0]), [['design', 'candidates', 4000, 1], ['security', 'candidates', 4000, 0]]);
  tracker.read(agent('a3', 'design'));
  assert.equal(tracker.live.stage, 'verify');
  assert.deepEqual(tracker.live.lanes.map((lane) => [lane.reviewer, lane.phase]), [['design', 'verification'], ['security', 'candidates']]);
  tracker.read(handback('a3', '[{"title":"Duplicated helper","verdict":"confirmed"}]'));
  tracker.read(done('a3'));
  assert.equal(tracker.live.stage, 'report');
  assert.deepEqual(tracker.live.lanes[0]?.items, [{ title: 'Duplicated helper', verdict: 'confirmed' }]);
  assert.equal(tracker.live.endedAt, undefined);
  now = 9000;
  tracker.end();
  assert.equal(tracker.live.endedAt, 9000);
});

test('keeps a suggestion on its lines and turns it into plain code when the span was clamped', () => {
  const suggestion = 'Replace it:\n\n```suggestion\nfixed\n```';
  assert.equal(parseReviewOutput(rawOutput({ findings: [rawFinding({ fix: suggestion })] }), picked, files).findings[0]?.fix, suggestion);
  assert.equal(parseReviewOutput(rawOutput({ findings: [rawFinding({ fix: suggestion, startLine: 1, endLine: 60 })] }), picked, files).findings[0]?.fix, 'Replace it:\n\n```\nfixed\n```');
  assert.equal(parseReviewOutput(rawOutput({ findings: [rawFinding({ fix: undefined })] }), picked, files).findings[0]?.fix, '');
});

test('a finding message puts the fix after the claim and folds the evidence', () => {
  const finding = parseReviewOutput(rawOutput(), picked, files).findings[0];
  assert.ok(finding);
  assert.equal(findingText(finding), 'It breaks.\n\n#### Suggested fix\n\nUse `<=`.\n\n<details>\n<summary>Evidence: tested</summary>\n\nran it\n\n</details>');
  assert.equal(findingText({ ...finding, fix: '', evidenceDetail: '' }), 'It breaks.');
});
