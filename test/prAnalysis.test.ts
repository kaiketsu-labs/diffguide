import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import test from 'node:test';
import { type AnalysisOptions, PullRequestAnalysis, runStructuredClaude } from '../src/agents/claude/prAnalysisRunner.js';
import type { CodeAnchor } from '../src/core/contracts.js';
import { analysisPrompt, buildGuide, changeBlocks, groupReadMarks, noteSegments, parseClaudeAnalysis, readStoredAnalysis, stepSpans, stepViewed } from '../src/core/prAnalysis.js';
import { createReviewStore } from '../src/core/store.js';
import { parseUnifiedDiff } from '../src/core/unifiedDiff.js';
import { settle } from './fakes/vscode.js';

const diff = [
  'diff --git a/src/a.ts b/src/a.ts',
  '--- a/src/a.ts',
  '+++ b/src/a.ts',
  '@@ -1,9 +1,9 @@',
  ' const a = 1;',
  '-const b = 2;',
  '+const b = 3;',
  ' const c = 3;',
  ' const d = 4;',
  ' const e = 5;',
  ' const f = 6;',
  '-const g = 7;',
  ' const h = 8;',
  '+const i = 9;',
  'diff --git a/src/b.ts b/src/b.ts',
  '--- a/src/b.ts',
  '+++ b/src/b.ts',
  '@@ -1,2 +1,3 @@',
  ' export {};',
  '+export const x = 1;',
  ' // end',
  'diff --git a/logo.png b/logo.png',
  'Binary files a/logo.png and b/logo.png differ',
  '',
].join('\n');

test('splits a diff into change blocks with the lines to mark read', () => {
  const blocks = changeBlocks(parseUnifiedDiff(diff));
  assert.deepEqual(blocks.map((block) => [block.id, block.path, block.range.side, block.range.startLine, block.range.endLine]), [
    ['b1', 'src/a.ts', 'new', 2, 2],
    ['b2', 'src/a.ts', 'old', 7, 7],
    ['b3', 'src/a.ts', 'new', 8, 8],
    ['b4', 'src/b.ts', 'new', 2, 2],
  ]);
  const prompt = analysisPrompt(parseUnifiedDiff(diff), blocks, '#1 Demo');
  assert.match(prompt, /\[b2\] old lines 7-7\n-const g = 7;/u);
  assert.match(prompt, /logo\.png \(modified\)\nBinary file, no blocks\./u);
});

test('keeps each block in one step and sorts groups by severity', () => {
  const files = parseUnifiedDiff(diff);
  const blocks = changeBlocks(files);
  const analysis = parseClaudeAnalysis({
    overview: 'Changes constants.\u0007',
    files: [{ path: 'src/a.ts', note: 'Constants.' }, { path: 'nope.ts', note: 'Unknown.' }],
    groups: [
      { severity: 'trivial', title: 'Exports', steps: [{ blocks: ['b4'], note: 'Adds an export.' }] },
      { severity: 'critical', title: 'Values', steps: [{ blocks: ['b3', 'b1', 'b4', 'b9'], note: 'Changes b.', transition: 'First.' }, { blocks: ['b1'], note: 'Repeat.' }] },
      { severity: 'bogus', title: 'Dropped', steps: [{ blocks: ['b2'], note: 'x' }] },
    ],
  }, blocks, 'head1', '2026-11-03T00:00:00.000Z');
  assert.equal(analysis.overview, 'Changes constants.');
  assert.deepEqual(analysis.files, [{ path: 'src/a.ts', note: 'Constants.' }]);
  assert.deepEqual(analysis.groups.map((group) => [group.severity, group.steps.length]), [['critical', 1], ['trivial', 1]]);
  assert.equal(analysis.groups[0]?.steps[0]?.blocks.length, 2);

  const guide = buildGuide(analysis, files);
  const covered = guide.flatMap((group) => group.steps.flatMap((step) => step.blocks.map((block) => block.id)));
  assert.deepEqual([...covered].sort(), ['b1', 'b2', 'b3', 'b4']);
  assert.deepEqual(guide.map((group) => group.severity), ['critical', 'trivial', 'unclassified']);
  assert.deepEqual(guide[0]?.steps[0]?.blocks.map((block) => block.id), ['b1', 'b3']);
  assert.equal(guide[0]?.steps[0]?.fileNote, 'Constants.');
  assert.equal(guide[2]?.steps.find((step) => step.path === 'src/a.ts')?.fileNote, undefined);
  assert.deepEqual(guide[2]?.steps.map((step) => [step.path, step.blocks.map((block) => block.id)]), [['src/a.ts', ['b2']], ['logo.png', []]]);
});

test('marks a whole guide group read: only its unread lines, and Viewed for files it finishes', () => {
  const files = parseUnifiedDiff(diff);
  const blocks = changeBlocks(files);
  const analysis = parseClaudeAnalysis({
    overview: '', files: [],
    groups: [{ severity: 'critical', title: 'Values', steps: [{ blocks: ['b1', 'b3'], note: 'Changes b.' }] }],
  }, blocks, 'head1', '2026-11-03T00:00:00.000Z');
  const [values, rest] = buildGuide(analysis, files);
  const lines = (marks: ReturnType<typeof groupReadMarks>) => marks.read.map((range) => [range.path, range.side, range.startLine]);
  const already = [{ path: 'src/a.ts', side: 'new' as const, startLine: 2, endLine: 2 }];
  const first = groupReadMarks(values!, files, already, new Set());
  assert.deepEqual(lines(first), [['src/a.ts', 'new', 8]]);
  assert.deepEqual(first.viewed, []);
  const second = groupReadMarks(rest!, files, [...already, ...first.read], new Set(['src/b.ts']));
  assert.deepEqual(lines(second), [['src/a.ts', 'old', 7], ['src/b.ts', 'new', 2]]);
  assert.deepEqual(second.viewed, ['src/a.ts', 'logo.png']);
});

test('puts every diff line in exactly one guide step and folds lines far from its changes', () => {
  const tail = ['diff --git a/src/c.ts b/src/c.ts', '--- a/src/c.ts', '+++ b/src/c.ts', '@@ -1,8 +1,8 @@', '-const a = 0;', '+const a = 1;', ...[2, 3, 4, 5, 6, 7, 8].map((n) => ' const n' + n + ' = ' + n + ';'), ''].join('\n');
  const files = parseUnifiedDiff(diff + tail);
  const blocks = changeBlocks(files);
  const analysis = parseClaudeAnalysis({
    overview: '', files: [],
    groups: [{ severity: 'critical', title: 'Values', steps: [{ blocks: ['b1', 'b3'], note: 'Changes b.' }] }],
  }, blocks, 'head1', '2026-11-03T00:00:00.000Z');
  const guide = buildGuide(analysis, files);
  const spans = stepSpans(guide, files);
  const steps = guide.flatMap((group) => group.steps);
  const of = (path: string, index = 0) => spans.get(steps.filter((step) => step.path === path)[index]?.key ?? '')?.map((span) => [span.hunk, span.from, span.to, span.folded]);
  assert.deepEqual(of('src/a.ts'), [[0, 0, 4, false], [0, 9, 9, false]]);
  assert.deepEqual(of('src/a.ts', 1), [[0, 5, 8, false]]);
  assert.deepEqual(of('src/c.ts'), [[0, 0, 4, false], [0, 5, 8, true]]);
  for (const file of files) {
    const lines = file.hunks.reduce((sum, hunk) => sum + hunk.lines.length, 0);
    const placed = steps.filter((step) => step.path === file.path).flatMap((step) => spans.get(step.key) ?? []).reduce((sum, span) => sum + span.to - span.from + 1, 0);
    assert.equal(placed, lines, file.path);
  }
});

test('shows a guide step viewed once its file is Viewed, even with unread lines', () => {
  const files = parseUnifiedDiff(diff);
  const [step] = buildGuide(parseClaudeAnalysis({ overview: '', files: [], groups: [] }, changeBlocks(files), 'head1', '2026-11-03T00:00:00.000Z'), files)[0]?.steps ?? [];
  assert.ok(step);
  const file = files.find((item) => item.path === step.path);
  assert.equal(stepViewed(step, file, [], false), false);
  assert.equal(stepViewed(step, file, [], true), true);
});

test('moves steps whose code changed to Unclassified and survives a round trip', () => {
  const files = parseUnifiedDiff(diff);
  const analysis = parseClaudeAnalysis({ overview: 'x', files: [], groups: [{ severity: 'routine', title: 'All', steps: [{ blocks: ['b1', 'b2', 'b3', 'b4'], note: 'All of a.' }] }] },
    changeBlocks(files), 'head1', '2026-11-03T00:00:00.000Z');
  const stored = readStoredAnalysis(JSON.parse(JSON.stringify(analysis)));
  assert.deepEqual(stored, analysis);
  const edited = parseUnifiedDiff(diff.replace('+const b = 3;', '+const b = 30;'));
  const guide = buildGuide(analysis, edited);
  assert.deepEqual(guide.map((group) => [group.severity, group.steps.map((step) => step.blocks.map((block) => block.id))]), [
    ['routine', [['b2', 'b3']]],
    ['unclassified', [['b1'], ['b4'], []]],
  ]);
  assert.equal(readStoredAnalysis({ head: 1 }), undefined);
});

const anchor = (startLine: number): CodeAnchor => ({
  path: 'src/a.ts', startLine, endLine: startLine, selectedText: 'x', contextBefore: '', contextAfter: '', documentHash: 'h', side: 'working', baseRevision: 'base',
});

test('opens analysis notes as threads that start with Claude, and replaces only untouched ones', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'diffguide-analysis-'));
  t.after(async () => { await rm(root, { recursive: true, force: true }); });
  const file = path.join(root, 'review.json');
  const store = await createReviewStore(file, root);
  const [first, second] = await store.replaceAnalysisNotes([{ anchor: anchor(1), text: 'Note one' }, { anchor: anchor(2), text: 'Note two' }]);
  assert.ok(first !== undefined && second !== undefined);
  assert.equal(store.pendingEvents.length, 0);
  assert.deepEqual(store.threads.map((thread) => [thread.origin, thread.messages[0]?.author, thread.status]), [['analysis', 'claude', 'answered'], ['analysis', 'claude', 'answered']]);
  await store.submit(anchor(1), 'Why?', 'ask', first);
  assert.deepEqual(store.pendingEvents.map((event) => event.threadId), [first]);
  const [third] = await store.replaceAnalysisNotes([{ anchor: anchor(3), text: 'Note three' }]);
  assert.deepEqual(store.threads.map((thread) => thread.id), [first, third]);
  assert.ok(!store.events.some((event) => event.threadId === second));
  const lastSequence = store.events.at(-1)?.sequence;
  assert.deepEqual(await store.replaceAnalysisNotes([]), []);
  assert.equal(store.events.at(-1)?.sequence, lastSequence);
  const reopened = await createReviewStore(file, root);
  assert.deepEqual(reopened.threads, store.threads);
});

class FakeChild extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  input = '';
  readonly stdin = new Writable({ write: (chunk: Buffer, _encoding, done) => { this.input += chunk.toString(); done(); } });
  constructor(readonly args: readonly string[]) { super(); }
  send(message: unknown): void { this.stdout.write(`${JSON.stringify(message)}\n`); }
  async exit(code: number): Promise<void> {
    this.stdout.end();
    this.stderr.end();
    await settle();
    this.emit('close', code);
  }
  kill(): void { void this.exit(143); }
}

async function until(check: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200 && !check(); attempt++) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.ok(check(), 'condition not reached');
}

test('runs Claude read-only, saves the analysis and links each step to its note thread', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'diffguide-analysis-run-'));
  t.after(async () => { await rm(root, { recursive: true, force: true }); });
  const store = await createReviewStore(path.join(root, 'review.json'), root);
  const children: FakeChild[] = [];
  const analysis = new PullRequestAnalysis({
    store, cwd: '/worktree', dataPath: root, role: 'reviewer', log: () => undefined,
    resolve: async () => ({ executable: '/bin/claude', mcpPath: '/mcp.json' }),
    spawn: ((_command: string, args: readonly string[]) => {
      const child = new FakeChild(args);
      children.push(child);
      return child;
    }) as unknown as NonNullable<AnalysisOptions['spawn']>,
  });
  t.after(() => { analysis.dispose(); });
  const files = parseUnifiedDiff(diff);
  analysis.start({ files, head: 'head1', about: '#1 Demo', anchor: async (block) => anchor(block.range.startLine) });
  await until(() => children.length === 1);
  const child = children[0];
  assert.ok(child !== undefined);
  assert.ok(child.args.includes('--json-schema') && child.args.includes('Bash') && !child.args.includes('acceptEdits'));
  assert.equal(child.args[child.args.indexOf('--setting-sources') + 1], 'user');
  assert.ok(child.args.includes('--strict-mcp-config'));
  await until(() => child.input.includes('[b4]'));
  child.send({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Read', input: { file_path: '/worktree/src/a.ts' } }] } });
  await until(() => analysis.activity.step === 'Reading src/a.ts');
  child.send({ type: 'result', is_error: false, structured_output: { overview: 'Demo.', files: [], groups: [{ severity: 'significant', title: 'Values', steps: [{ blocks: ['b1'], note: 'Changes b.' }] }] } });
  await child.exit(0);
  await until(() => !analysis.activity.running);
  assert.equal(analysis.activity.error, undefined);
  const result = await analysis.result();
  const threadId = result?.groups[0]?.steps[0]?.threadId;
  assert.equal(store.threads.find((thread) => thread.id === threadId)?.messages[0]?.text, 'Changes b.');
  const saved = readStoredAnalysis(JSON.parse(await readFile(path.join(root, 'analysis.json'), 'utf8')));
  assert.deepEqual(saved, result);
});

test('keeps the structured output when a later turn ends with a result that has none', async () => {
  let child: FakeChild | undefined;
  const run = runStructuredClaude({
    resolve: async () => ({ executable: '/bin/claude' }), cwd: '/worktree', log: () => undefined, prompt: 'Review.', schema: {}, args: [], missing: 'No review.',
    startedAt: Date.now(), stopped: () => false, onChild: () => undefined, onStep: () => undefined, onProgress: () => undefined,
    spawn: ((_command: string, args: readonly string[]) => { child = new FakeChild(args); return child; }) as unknown as NonNullable<AnalysisOptions['spawn']>,
  });
  await until(() => child !== undefined);
  child?.send({ type: 'result', is_error: false, structured_output: { ran: ['design'] } });
  child?.send({ type: 'result', is_error: false, origin: { kind: 'task-notification' }, result: '' });
  await child?.exit(0);
  assert.deepEqual(await run, { ran: ['design'] });
});

test('summarizes a file whose diff is too large to show in full', () => {
  const lines = Array.from({ length: 3000 }, (_, index) => `+  "package-${index}": "1.0.${index}",`);
  const files = parseUnifiedDiff(['diff --git a/package-lock.json b/package-lock.json', '--- a/package-lock.json', '+++ b/package-lock.json', '@@ -1 +1,3001 @@', ' {', ...lines, ''].join('\n'));
  const prompt = analysisPrompt(files, changeBlocks(files), '#1 Lock');
  assert.match(prompt, /\[b1\] new lines 2-3001, 3000 changed\n\+  "package-0"/u);
  assert.ok(prompt.length < 5000);
});

const refDiff = parseUnifiedDiff(diff);
const refNote = 'Changes b to three, then adds an export.';
const refStep = (refs: unknown): unknown => ({ overview: 'x', files: [], groups: [{ severity: 'routine', title: 'All', steps: [{ blocks: ['b1'], note: refNote, refs }] }] });
const parseRefs = (refs: unknown): readonly { text: string; path: string; from: number; to: number }[] | undefined =>
  parseClaudeAnalysis(refStep(refs), changeBlocks(refDiff), 'head1', '2026-11-03T00:00:00.000Z', refDiff).groups[0]?.steps[0]?.refs;

test('keeps line references that cite shown lines of the step file and links their phrases', () => {
  const given = [{ text: 'b to three', path: 'src/a.ts', from: 2, to: 3 }];
  const refs = parseRefs(given);
  assert.deepEqual(refs, given);
  assert.deepEqual(noteSegments(refNote, refs, refDiff[0]).map((segment) => [segment.text, segment.ref?.from]), [['Changes ', undefined], ['b to three', 2], [', then adds an export.', undefined]]);
  const analysis = parseClaudeAnalysis(refStep(given), changeBlocks(refDiff), 'h', 'c', refDiff);
  assert.deepEqual(readStoredAnalysis(JSON.parse(JSON.stringify(analysis))), analysis);
});

test('shows a reference as plain text when its path is unknown, its lines are out of range or its phrase is not in the note', () => {
  assert.equal(parseRefs([{ text: 'b to three', path: 'src/other.ts', from: 2, to: 2 }]), undefined);
  assert.equal(parseRefs([{ text: 'b to three', path: 'src/a.ts', from: 2, to: 99 }]), undefined);
  assert.equal(parseRefs([{ text: 'b to three', path: 'src/a.ts', from: 0, to: 2 }]), undefined);
  assert.equal(parseRefs([{ text: 'b to three', path: 'src/a.ts', from: 3, to: 2 }]), undefined);
  assert.equal(parseRefs([{ text: 'b to three', path: 'src/a.ts', from: 1.5, to: 2 }]), undefined);
  assert.equal(parseRefs([{ text: 'not in the note', path: 'src/a.ts', from: 2, to: 2 }]), undefined);
  assert.equal(parseRefs('src/a.ts:2'), undefined);
  const stale = { text: 'b to three', path: 'src/a.ts', from: 2, to: 3 };
  assert.deepEqual(noteSegments(refNote, [stale], { ...refDiff[0]!, hunks: [] }), [{ text: refNote }]);
  assert.deepEqual(noteSegments(refNote, [stale], refDiff[1]), [{ text: refNote }]);
});

test('renders a guide stored before line references existed', () => {
  const stored = readStoredAnalysis({
    head: 'h', createdAt: 'c', overview: 'x', files: [],
    groups: [{ severity: 'routine', title: 'All', steps: [{ blocks: [{ path: 'src/a.ts', signature: changeBlocks(refDiff)[0]?.signature }], note: refNote }] }],
  });
  const step = stored?.groups[0]?.steps[0];
  assert.ok(step !== undefined && !('refs' in step));
  const guided = buildGuide(stored!, refDiff)[0]?.steps[0];
  assert.deepEqual(noteSegments(guided?.note ?? '', guided?.refs, refDiff[0]), [{ text: refNote }]);
});

test('tells Claude each block\'s line numbers and how to cite them', () => {
  const prompt = analysisPrompt(refDiff, changeBlocks(refDiff), '#1 Demo');
  assert.match(prompt, /\[b1\] new lines 2-2\n-const b = 2;\n\+const b = 3;/u);
  assert.match(prompt, /refs: .*from and to/u);
});
