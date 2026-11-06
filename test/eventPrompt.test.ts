import assert from 'node:assert/strict';
import test from 'node:test';
import type { ReviewEvent, ReviewThread } from '../src/contracts.js';
import { buildReviewBatchPrompt, buildReviewPrompt, reviewInstructions } from '../src/eventPrompt.js';

/** Capture representative user feedback without involving the editor or transport. */
function event(id: string, text: string): ReviewEvent {
  return {
    id, sequence: 1, threadId: `thread-${id}`, intent: 'implement', text,
    createdAt: '2026-10-21T12:00:00.000Z', acknowledged: false,
    anchor: {
      path: 'retry.js', startLine: 5, endLine: 14, selectedText: 'return operation();',
      contextBefore: '', contextAfter: '', documentHash: 'hash', side: 'working', baseRevision: 'HEAD',
    },
  };
}

test('hook batches lead with actual feedback while preserving complete event and conversation data', () => {
  const first = event('first', 'Use exponential backoff.\nPreserve the original error.');
  const second = { ...event('second', '/r'), intent: 'summarize' as const, sequence: 2 };
  const thread: ReviewThread = {
    id: first.threadId, anchor: first.anchor, intent: first.intent, status: 'queued',
    resolved: false, outdated: false, latestEventId: first.id,
    messages: [{ id: 'reply', author: 'claude', text: 'Previous discussion.', createdAt: first.createdAt }],
  };
  const prompt = buildReviewBatchPrompt([first, second], [thread]);
  assert.ok(prompt.startsWith('VS Code review · Implement · "retry.js:5–14"\nFeedback: "Use exponential backoff. Preserve the original error."'));
  assert.ok(prompt.includes('VS Code review · Summarize'));
  assert.equal(prompt.split(reviewInstructions).length - 1, 1);
  const data = [...prompt.matchAll(/BEGIN REVIEW DATA \(JSON\)\n([\s\S]*?)\nEND REVIEW DATA/gu)]
    .map((match) => JSON.parse(match[1] ?? '') as Record<string, unknown>);
  assert.deepEqual(data.map((value) => value['event_id']), [first.id, second.id]);
  assert.equal(data[0]?.['currentHumanFeedback'], first.text);
  assert.ok(JSON.stringify(data[0]?.['conversation']).includes('Previous discussion.'));
  assert.ok(buildReviewPrompt(first, thread).startsWith(reviewInstructions));
});

test('hook summaries bound long feedback and escape terminal controls without truncating delivery data', () => {
  const feedback = `Question \u001b[31m${'long '.repeat(100)}`;
  const captured = event('long', feedback);
  const prompt = buildReviewBatchPrompt([captured], []);
  const summary = prompt.split('\n\n')[0] ?? '';
  assert.ok(summary.length < 260);
  assert.ok(summary.includes('…'));
  assert.ok(!prompt.includes('\u001b'));
  const match = /BEGIN REVIEW DATA \(JSON\)\n([\s\S]*?)\nEND REVIEW DATA/u.exec(prompt);
  const data = JSON.parse(match?.[1] ?? '') as Record<string, unknown>;
  assert.equal(data['currentHumanFeedback'], feedback);
});

test('custom instructions follow the built-in ones and are left out when empty', () => {
  const captured = event('custom', 'Why?');
  assert.equal(buildReviewPrompt(captured, undefined, ''), buildReviewPrompt(captured));
  const prompt = buildReviewBatchPrompt([captured], [], 'Prefer short answers.');
  assert.ok(prompt.indexOf(reviewInstructions) < prompt.indexOf('Prefer short answers.'));
  assert.ok(prompt.indexOf('Prefer short answers.') < prompt.indexOf('BEGIN REVIEW DATA'));
});

test('tells Claude a whole-file comment is about the file, not about lines', () => {
  const whole = event('file', 'Split this module.');
  const fileEvent = { ...whole, anchor: { ...whole.anchor, startLine: 1, endLine: 1, selectedText: '', scope: 'file' as const } };
  const prompt = buildReviewBatchPrompt([fileEvent], []);
  assert.ok(prompt.startsWith('VS Code review · Implement · "retry.js (whole file)"'));
  assert.match(prompt, /"scope": "Whole file: the comment is about the file as a whole, not about particular lines\./u);
  assert.doesNotMatch(buildReviewBatchPrompt([whole], []), /"scope"/u);
});
