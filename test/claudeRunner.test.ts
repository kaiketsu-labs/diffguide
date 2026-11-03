import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import test from 'node:test';

import { ClaudeRunner, describeTool, type ClaudeRunnerOptions } from '../src/claudeRunner.js';
import type { ReviewEvent, ReviewStore } from '../src/contracts.js';
import { settle } from './fakes/vscode.js';

/** Wait for the runner's file and process work to reach a state. */
async function until(check: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200 && !check(); attempt++) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.ok(check(), 'condition not reached');
}

/** A Claude process stand-in whose output the test writes line by line. */
class FakeChild extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  input = '';
  env: NodeJS.ProcessEnv | undefined;
  readonly stdin = new Writable({ write: (chunk: Buffer, _encoding, done) => { this.input += chunk.toString(); done(); } });
  constructor(readonly args: readonly string[], readonly cwd: string, readonly command: string) { super(); }
  send(message: unknown): void { this.stdout.write(`${JSON.stringify(message)}\n`); }
  async exit(code: number): Promise<void> {
    this.stdout.end();
    this.stderr.end();
    await settle();
    this.emit('close', code);
  }
  kill(): void { void this.exit(143); }
}

const event = (id: string): ReviewEvent => ({
  id, sequence: 1, threadId: `thread-${id}`, intent: 'ask', text: `Question ${id}`, createdAt: '2026-11-02T00:00:00.000Z', acknowledged: false,
  anchor: { path: 'src/a.ts', startLine: 1, endLine: 1, selectedText: 'x', contextBefore: '', contextAfter: '', documentHash: 'a'.repeat(64), side: 'working', baseRevision: 'b'.repeat(40) },
});

/** Store with only what the runner reads, plus a way to change pending comments. */
function fakeStore(): ReviewStore & { setPending(events: ReviewEvent[]): void } {
  let pending: ReviewEvent[] = [];
  const listeners = new Set<() => void>();
  return {
    get pendingEvents() { return pending; },
    threads: [], events: [], workspaceRoot: '/repo',
    onChange: (listener: () => void) => { listeners.add(listener); return { dispose: () => { listeners.delete(listener); } }; },
    setPending: (events: ReviewEvent[]) => { pending = events; for (const listener of listeners) listener(); },
  } as unknown as ReviewStore & { setPending(events: ReviewEvent[]): void };
}

async function runner(role: ClaudeRunnerOptions['role'], t: test.TestContext, shell?: string) {
  const dataPath = await mkdtemp(path.join(tmpdir(), 'pair-review-runner-'));
  t.after(async () => { await rm(dataPath, { recursive: true, force: true }); });
  const store = fakeStore();
  const children: FakeChild[] = [];
  const log: string[] = [];
  const instance = new ClaudeRunner({
    store, cwd: '/worktree', dataPath, role, log: (line) => { log.push(line); },
    resolve: async () => ({ executable: shell === undefined ? '/bin/claude' : 'claude', mcpPath: '/data/mcp.json', ...(shell === undefined ? {} : { shell }) }),
    spawn: ((executable: string, args: readonly string[], options: { cwd: string; env?: NodeJS.ProcessEnv }) => {
      const child = new FakeChild(args, options.cwd, executable);
      child.env = options.env;
      children.push(child);
      return child;
    }) as unknown as NonNullable<ClaudeRunnerOptions['spawn']>,
  });
  t.after(() => { instance.dispose(); });
  return { instance, store, children, log };
}

test('answers a sent comment in the background, shows each step, and resumes the same conversation next time', async (t) => {
  const { instance, store, children, log } = await runner('reviewer', t);
  store.setPending([event('one')]);
  await until(() => children.length === 1);
  const first = children[0];
  assert.ok(first !== undefined);
  assert.equal(first.cwd, '/worktree');
  assert.ok(first.args.includes('--disallowedTools') && first.args.includes('Edit') && first.args.includes('Bash'));
  assert.equal(first.args[first.args.indexOf('--setting-sources') + 1], 'user');
  assert.ok(first.args.includes('--strict-mcp-config'));
  assert.equal(first.args[0], '-p');
  assert.ok(first.args[1]?.startsWith('This is someone else\'s pull request.'));
  assert.match(first.args[1] ?? '', /Question one/u);
  const sessionId = first.args[first.args.indexOf('--session-id') + 1];
  assert.ok(sessionId !== undefined);
  assert.deepEqual([...instance.activity.threads], ['thread-one']);

  first.send({ type: 'system', subtype: 'init', session_id: sessionId });
  first.send({ type: 'assistant', message: { content: [{ type: 'thinking', thinking: '' }] } });
  await until(() => instance.activity.step === 'Thinking');
  first.send({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Read', input: { file_path: '/worktree/src/a.ts' } }] } });
  await until(() => instance.activity.step === 'Reading src/a.ts');
  assert.equal(instance.activity.running, true);

  store.setPending([]);
  first.send({ type: 'result', subtype: 'success', is_error: false });
  await first.exit(0);
  await until(() => !instance.activity.running);
  assert.equal(instance.activity.error, undefined);
  assert.ok(log.includes('→ Reading src/a.ts'));

  store.setPending([event('two')]);
  await until(() => children.length === 2);
  const second = children[1];
  assert.ok(second !== undefined);
  assert.equal(second.args[second.args.indexOf('--resume') + 1], sessionId);
});

test('lets Claude edit only on the author\'s own PR', async (t) => {
  const { store, children } = await runner('author', t);
  store.setPending([event('one')]);
  await until(() => children.length === 1);
  const args = children[0]?.args ?? [];
  assert.ok(!args.includes('--disallowedTools'));
  assert.ok(!args.includes('--setting-sources') && !args.includes('--strict-mcp-config'));
  assert.equal(args[args.indexOf('--permission-mode') + 1], 'acceptEdits');
  assert.ok(!children[0]?.args[1]?.includes('someone else'));
});

test('runs a task in the PR conversation with its own tools, and keeps Git hooks off on someone else\'s PR', async (t) => {
  const task = { label: 'fixing merge conflicts', prompt: 'Merge the base.', allowedTools: ['Bash(git merge *)'] };
  for (const role of ['author', 'reviewer'] as const) {
    const { instance, children } = await runner(role, t);
    const done = instance.runTask(task);
    await until(() => children.length === 1);
    const child = children[0];
    assert.ok(child !== undefined);
    assert.equal(child.args[1], 'Merge the base.');
    assert.equal(instance.activity.task, 'fixing merge conflicts');
    assert.deepEqual(child.args.slice(child.args.indexOf('--allowedTools') + 1, child.args.indexOf('--allowedTools') + 3), ['mcp__pair-review', 'Bash(git merge *)']);
    assert.equal(child.args[child.args.indexOf('--permission-mode') + 1], 'acceptEdits');
    assert.ok(!child.args.includes('--disallowedTools'));
    assert.equal(child.args.includes('--setting-sources'), role === 'reviewer');
    assert.equal(child.env?.['GIT_CONFIG_VALUE_0'], role === 'reviewer' ? '/dev/null' : undefined);
    await assert.rejects(instance.runTask(task), /still working/u);
    child.send({ type: 'assistant', message: { content: [{ type: 'text', text: 'Which value wins?' }] } });
    child.send({ type: 'result', subtype: 'success', is_error: false });
    await child.exit(0);
    assert.deepEqual(await done, { reply: 'Which value wins?' });
    assert.equal(instance.activity.running, false);
    assert.equal(instance.activity.task, undefined);
  }
});

test('does not loop on comments Claude skipped, and sends them again on retry', async (t) => {
  const { instance, store, children } = await runner('reviewer', t);
  store.setPending([event('one')]);
  await until(() => children.length === 1);
  await children[0]?.exit(0);
  await until(() => instance.activity.skipped === 1);
  assert.equal(children.length, 1);

  instance.retry();
  await until(() => children.length === 2);
});

test('reports a failed run with Claude\'s last error line', async (t) => {
  const { instance, store, children } = await runner('reviewer', t);
  store.setPending([event('one')]);
  await until(() => children.length === 1);
  children[0]?.stderr.write('warming up\nNot logged in\n');
  await children[0]?.exit(1);
  await until(() => instance.activity.error !== undefined);
  assert.equal(instance.activity.error, 'Claude exited with code 1: Not logged in');
});

test('starts Claude through the login shell so the user\'s own claude setup applies', async (t) => {
  const { store, children } = await runner('reviewer', t, '/bin/zsh');
  store.setPending([event('one')]);
  await until(() => children.length === 1);
  assert.equal(children[0]?.command, '/bin/zsh');
  assert.deepEqual(children[0]?.args.slice(0, 6), ['-l', '-i', '-c', '"$0" "$@"', 'claude', '-p']);
});

test('remembers the conversation only after a successful run', async (t) => {
  const { store, children } = await runner('reviewer', t);
  store.setPending([event('one')]);
  await until(() => children.length === 1);
  children[0]?.send({ type: 'result', is_error: true, result: 'Not logged in · Please run /login' });
  await children[0]?.exit(1);
  store.setPending([event('two')]);
  await until(() => children.length === 2);
  assert.ok(children[1]?.args.includes('--session-id'));
});

test('describes tool calls in plain words and keeps paths short', () => {
  assert.equal(describeTool('Grep', { pattern: 'foo' }, '/w'), 'Searching for "foo"');
  assert.equal(describeTool('Bash', { command: 'git log', description: 'Show history' }, '/w'), 'Running Show history');
  assert.equal(describeTool('mcp__pair-review__reply_to_review', {}, '/w'), 'Writing the reply');
  assert.equal(describeTool('Read', { file_path: '/elsewhere/x.ts' }, '/w'), 'Reading /elsewhere/x.ts');
  assert.equal(describeTool('Weird\ntool', {}, '/w'), 'Using Weird tool');
});
