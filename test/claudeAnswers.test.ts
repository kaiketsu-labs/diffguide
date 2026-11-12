import assert from 'node:assert/strict';
import test from 'node:test';
import type { ReviewThread } from '../src/core/contracts.js';
import { latestAnswers, SeenAnswers } from '../src/hosts/vscode/claudeAnswers.js';
import { FakeMemento } from './fakes/vscode.js';

const anchor = { path: 'src/user.ts', startLine: 12, endLine: 12, selectedText: 'x', contextBefore: '', contextAfter: '', documentHash: 'h', side: 'working', baseRevision: 'HEAD' } as const;

function thread(id: string, messages: readonly [ReviewThread['messages'][number]['author'], string][], extra: Partial<ReviewThread> = {}): ReviewThread {
  return {
    id, anchor, intent: 'ask', status: 'answered', resolved: false, outdated: false, latestEventId: id,
    messages: messages.map(([author, createdAt], index) => ({ id: `${id}-${index}`, author, text: `${author} at ${createdAt}`, createdAt })),
    ...extra,
  };
}

test('lists the latest Claude answer of each open thread, newest first, across PRs', () => {
  const answers = latestAnswers([
    { key: 'acme/app#1', number: 1, threads: [
      thread('a', [['human', '2026-11-07T10:00:00Z'], ['claude', '2026-11-07T10:05:00Z']], { title: 'Null check' }),
      thread('b', [['human', '2026-11-07T10:00:00Z'], ['claude', '2026-11-07T10:01:00Z'], ['human', '2026-11-07T10:02:00Z']]),
      thread('c', [['human', '2026-11-07T10:00:00Z'], ['claude', '2026-11-07T10:09:00Z']], { resolved: true }),
      thread('d', [['claude', '2026-11-07T10:09:00Z']], { origin: 'analysis' }),
    ] },
    { key: 'acme/api#2', number: 2, threads: [thread('e', [['human', '2026-11-07T10:00:00Z'], ['claude', '2026-11-07T10:07:00Z']])] },
  ]);
  assert.deepEqual(answers.map((answer) => [answer.pullRequest, answer.threadId, answer.title]), [['acme/api#2', 'e', 'human at 2026-11-07T10:00:00Z'], ['acme/app#1', 'a', 'Null check']]);
});

test('counts answers from before first use as seen, and a later answer in a seen thread as new', async () => {
  const memento = new FakeMemento();
  const seen = new SeenAnswers(memento, new Date('2026-11-07T10:00:00Z'));
  assert.equal(seen.isNew({ threadId: 'a', createdAt: '2026-11-07T09:00:00Z' }), false);
  assert.equal(seen.isNew({ threadId: 'a', createdAt: '2026-11-07T10:05:00Z' }), true);
  let fired = 0;
  seen.onDidChange(() => { fired += 1; });
  await seen.see([{ threadId: 'a', createdAt: '2026-11-07T10:05:00Z' }], Date.parse('2026-11-07T11:00:00Z'));
  assert.equal(fired, 1);
  assert.equal(new SeenAnswers(memento).isNew({ threadId: 'a', createdAt: '2026-11-07T10:05:00Z' }), false);
  assert.equal(seen.isNew({ threadId: 'a', createdAt: '2026-11-07T10:20:00Z' }), true);
  await seen.see([{ threadId: 'a', createdAt: '2026-11-07T10:05:00Z' }]);
  assert.equal(fired, 1);
});
