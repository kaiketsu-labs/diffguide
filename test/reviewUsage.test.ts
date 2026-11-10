import assert from 'node:assert/strict';
import test from 'node:test';

import { parseReviewUsage, readStoredReview } from '../src/review.js';

const result = {
  type: 'result',
  total_cost_usd: 1.84,
  num_turns: 12,
  duration_ms: 5,
  modelUsage: {
    'claude-opus-4-1': { inputTokens: 1200, outputTokens: 340, cacheReadInputTokens: 1_200_000, cacheCreationInputTokens: 34_000, costUSD: 1.5, costBasis: 'list' },
    'claude-haiku-4-5': { inputTokens: 10, outputTokens: 20, cacheReadInputTokens: 30, cacheCreationInputTokens: 40, costUSD: 0.34 },
  },
};

test('parseReviewUsage reads totals and per-model rows from a result message', () => {
  assert.deepEqual(parseReviewUsage(result, 252_400), {
    durationMs: 252_400, cost: 1.84, turns: 12,
    models: [
      { model: 'claude-opus-4-1', input: 1200, output: 340, cacheRead: 1_200_000, cacheWrite: 34_000, cost: 1.5 },
      { model: 'claude-haiku-4-5', input: 10, output: 20, cacheRead: 30, cacheWrite: 40, cost: 0.34 },
    ],
  });
});

test('parseReviewUsage ignores other messages and results without a valid cost', () => {
  assert.equal(parseReviewUsage({ ...result, type: 'assistant' }, 1), undefined);
  assert.equal(parseReviewUsage({ type: 'result' }, 1), undefined);
  assert.equal(parseReviewUsage({ ...result, total_cost_usd: '1.84' }, 1), undefined);
  assert.equal(parseReviewUsage({ ...result, total_cost_usd: -1 }, 1), undefined);
  assert.equal(parseReviewUsage({ ...result, total_cost_usd: Number.NaN }, 1), undefined);
  assert.equal(parseReviewUsage(null, 1), undefined);
});

test('parseReviewUsage zeroes invalid fields and skips malformed model rows', () => {
  const usage = parseReviewUsage({
    type: 'result', total_cost_usd: 0.5, num_turns: -3,
    modelUsage: { a: { inputTokens: 1.5, outputTokens: '9', cacheReadInputTokens: -1, costUSD: 'x' }, b: 'nope', c: null },
  }, Number.NaN);
  assert.deepEqual(usage, {
    durationMs: 0, cost: 0.5, turns: 0,
    models: [
      { model: 'a', input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
      { model: 'b', input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
      { model: 'c', input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
    ],
  });
  assert.deepEqual(parseReviewUsage({ type: 'result', total_cost_usd: 1, modelUsage: 'x' }, 1)?.models, []);
});

test('parseReviewUsage caps the model rows', () => {
  const modelUsage = Object.fromEntries(Array.from({ length: 50 }, (_, index) => [`m${index}`, { inputTokens: 1 }]));
  assert.equal(parseReviewUsage({ type: 'result', total_cost_usd: 1, modelUsage }, 1)?.models.length, 20);
});

test('a stored review keeps its usage and reads older files without it', () => {
  const usage = parseReviewUsage(result, 1000);
  const base = { createdAt: '2026-01-01T00:00:00.000Z', ran: [], skipped: [], candidates: 0, findings: [], dropped: [] };
  assert.deepEqual(readStoredReview(JSON.parse(JSON.stringify({ ...base, usage })))?.usage, usage);
  assert.equal(readStoredReview(base)?.usage, undefined);
  assert.equal('usage' in (readStoredReview(base) ?? {}), false);
  assert.equal(readStoredReview({ ...base, usage: { cost: 'free' } })?.usage, undefined);
});
