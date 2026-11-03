import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import test from 'node:test';

import type { CodeAnchor } from '../src/contracts.js';
import { analysisPrompt, buildGuide, changeBlocks, guideOutline, parseClaudeAnalysis, readStoredAnalysis } from '../src/prAnalysis.js';
import { PullRequestAnalysis, type AnalysisOptions } from '../src/prAnalysisRunner.js';
import { createReviewStore } from '../src/store.js';
import { parsePlainDiff, parseUnifiedDiff } from '../src/unifiedDiff.js';
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
  assert.match(prompt, /\[b2\]\n-const g = 7;/u);
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
  const root = await mkdtemp(path.join(tmpdir(), 'pair-review-analysis-'));
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
  const root = await mkdtemp(path.join(tmpdir(), 'pair-review-analysis-run-'));
  t.after(async () => { await rm(root, { recursive: true, force: true }); });
  const store = await createReviewStore(path.join(root, 'review.json'), root);
  const children: FakeChild[] = [];
  const analysis = new PullRequestAnalysis({
    store, cwd: '/worktree', dataPath: root, log: () => undefined,
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

test('summarizes a file whose diff is too large to show in full', () => {
  const lines = Array.from({ length: 3000 }, (_, index) => `+  "package-${index}": "1.0.${index}",`);
  const files = parseUnifiedDiff(['diff --git a/package-lock.json b/package-lock.json', '--- a/package-lock.json', '+++ b/package-lock.json', '@@ -1 +1,3001 @@', ' {', ...lines, ''].join('\n'));
  const prompt = analysisPrompt(files, changeBlocks(files), '#1 Lock');
  assert.match(prompt, /\[b1\] new lines 2-3001, 3000 changed\n\+  "package-0"/u);
  assert.ok(prompt.length < 5000);
});

test('lists the same steps from an uncolored diff and marks a step viewed once its lines are read', () => {
  const tricky = diff.replace('+const b = 3;', '+const b = a < 3 && "x" !== \'y\';');
  const colored = parseUnifiedDiff(tricky);
  const plain = parsePlainDiff(tricky);
  assert.deepEqual(changeBlocks(plain).map((block) => block.signature), changeBlocks(colored).map((block) => block.signature));
  const analysis = parseClaudeAnalysis({ overview: '', files: [], groups: [{ severity: 'routine', title: 'All', steps: [{ blocks: ['b1'], title: 'Change b', note: 'B.' }] }] },
    changeBlocks(colored), 'head1', '2026-11-03T00:00:00.000Z');
  const read = [{ path: 'src/a.ts', side: 'new' as const, startLine: 2, endLine: 2 }];
  const outline = guideOutline(buildGuide(analysis, plain), plain, read, new Set(['logo.png']));
  assert.deepEqual(outline.map((group) => group.steps.map((step) => [step.key, step.title, step.viewed])), [
    [['g0.0', 'Change b', true]],
    [['u:src/a.ts', undefined, false], ['u:src/b.ts', undefined, false], ['u:logo.png', undefined, true]],
  ]);
});

