import type { AgentStep } from './agent.js';
import { type FindingEvidence, type FindingSeverity, type Reviewer, reviewers } from './contracts.js';
import { lineText } from './prAnalysis.js';
import correctness from './prompts/correctness.md';
import design from './prompts/design.md';
import orchestratorTemplate from './prompts/orchestrator.md';
import performance from './prompts/performance.md';
import reviewerTemplate from './prompts/reviewer.md';
import security from './prompts/security.md';
import tests from './prompts/tests.md';
import type { DiffLine, FileDiff } from './unifiedDiff.js';

/** The picker's name and one-line description for each reviewer. */
export const reviewerInfo: Readonly<Record<Reviewer, { readonly label: string; readonly description: string }>> = {
  correctness: { label: 'Correctness', description: 'Wrong behavior, regressions' },
  design: { label: 'Design', description: 'Fit, structure, simpler code' },
  security: { label: 'Security', description: 'Exposure, unsafe input, secrets' },
  performance: { label: 'Performance', description: 'Wasted time or resources' },
  tests: { label: 'Tests', description: 'Changes no test would catch' },
};

/** Why the orchestrator did not post a candidate. */
export type DropReason = 'over-cap' | 'refuted' | 'unconfirmed' | 'duplicate' | 'out-of-scope' | 'unplaced';
const dropReasons: readonly DropReason[] = ['over-cap', 'refuted', 'unconfirmed', 'duplicate', 'out-of-scope', 'unplaced'];
const severities: readonly FindingSeverity[] = ['high', 'medium', 'low'];
const evidences: readonly FindingEvidence[] = ['tested', 'rewritten', 'traced', 'cited'];

/** The most findings one review posts; a ceiling, not a target. */
export const maximumFindings = 10;

/** What Re-check findings asks in each open finding's thread. */
export const recheckRequest = 'Re-check this finding against the current code. Is it fixed? Answer Fixed, Partly fixed or Not fixed first, then cite the lines that show it. Do not edit files.';
const maximumDropped = 60;
/** Lines a finding's anchor may span, as for guide notes. */
const maximumFindingLines = 50;

export interface ReviewFinding {
  readonly reviewers: readonly Reviewer[];
  readonly path: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly title: string;
  readonly body: string;
  readonly severity: FindingSeverity;
  readonly evidence: FindingEvidence;
  readonly evidenceDetail: string;
  /** Markdown; a ```suggestion block in it replaces exactly the finding's lines. Empty when there is no clear fix. */
  readonly fix: string;
}

export interface DroppedCandidate {
  readonly claim: string;
  readonly reviewers: readonly Reviewer[];
  readonly reason: DropReason;
  readonly why: string;
}

/** What a code review run returned, before its findings become threads. */
export interface ReviewOutput {
  readonly ran: readonly Reviewer[];
  readonly skipped: readonly { readonly reviewer: Reviewer; readonly reason: string }[];
  readonly candidates: number;
  readonly findings: readonly ReviewFinding[];
  readonly dropped: readonly DroppedCandidate[];
}

/** A finished code review as saved: the summary card's content, with each posted finding's thread. */
export interface CodeReviewResult {
  readonly createdAt: string;
  readonly ran: readonly Reviewer[];
  readonly skipped: readonly { readonly reviewer: Reviewer; readonly reason: string }[];
  readonly candidates: number;
  readonly findings: readonly {
    readonly threadId: string;
    readonly title: string;
    readonly severity: FindingSeverity;
    readonly evidence: FindingEvidence;
    readonly reviewers: readonly Reviewer[];
    readonly path: string;
    readonly startLine: number;
  }[];
  readonly dropped: readonly DroppedCandidate[];
  readonly usage?: ReviewUsage;
}

/** One model's share of a review run's tokens and cost. */
export interface ReviewModelUsage {
  readonly model: string;
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
  readonly cost: number;
}

/** Who in a review run spent tokens: the orchestrator or a review agent. */
export type ReviewAgent = 'orchestrator' | Reviewer;

/** One agent's share of a review run's cost. */
export interface ReviewAgentUsage {
  readonly agent: ReviewAgent;
  readonly cost: number;
}

/** What a review run used: wall time, turns, API list price and tokens per model, subagents included, and that cost split by agent. */
export interface ReviewUsage {
  readonly durationMs: number;
  readonly cost: number;
  readonly turns: number;
  readonly models: readonly ReviewModelUsage[];
  readonly agents: readonly ReviewAgentUsage[];
}

const maximumUsageModels = 20;
const count = (value: unknown): number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0;
const money = (value: unknown): number | undefined => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;

function readUsageModels(value: unknown, fields: { readonly input: string; readonly output: string; readonly cacheRead: string; readonly cacheWrite: string; readonly cost: string }): ReviewModelUsage[] {
  const list = Array.isArray(value) ? value : typeof value === 'object' && value !== null ? Object.entries(value).map(([model, row]) => ({ ...(typeof row === 'object' && row !== null ? row : {}), model })) : [];
  return records(list).flatMap((row) => {
    const model = cleanText(row['model'], 100);
    return model === undefined ? [] : [{ model, input: count(row[fields.input]), output: count(row[fields.output]), cacheRead: count(row[fields.cacheRead]), cacheWrite: count(row[fields.cacheWrite]), cost: money(row[fields.cost]) ?? 0 }];
  }).slice(0, maximumUsageModels);
}

/** Usage from a CLI result message, whose figures are session totals; undefined for any other message or one without a cost. */
export function parseReviewUsage(message: unknown, durationMs: number): ReviewUsage | undefined {
  const record = typeof message === 'object' && message !== null ? message as Record<string, unknown> : {};
  const cost = money(record['total_cost_usd']);
  if (record['type'] !== 'result' || cost === undefined) return undefined;
  const models = readUsageModels(record['modelUsage'], { input: 'inputTokens', output: 'outputTokens', cacheRead: 'cacheReadInputTokens', cacheWrite: 'cacheCreationInputTokens', cost: 'costUSD' });
  return { durationMs: Number.isFinite(durationMs) ? Math.max(0, Math.round(durationMs)) : 0, cost, turns: count(record['num_turns']), models, agents: [] };
}

/** One assistant message's tokens, weighted by their price relative to input tokens. */
export interface WeightedTurn {
  readonly id: string;
  readonly model: string;
  readonly weight: number;
}

// Price of a cache read relative to an input token where it differs from the usual 0.1, from the Anthropic list prices.
const cacheReadRatios: readonly (readonly [string, number])[] = [['claude-fable-5-2', 0.025], ['claude-opus-5-5', 0.05], ['claude-sonnet-5-5', 0.05]];

/** An assistant stream message's id, model and price-weighted tokens; undefined for any other message. */
export function weightedTurn(message: unknown): WeightedTurn | undefined {
  const record = typeof message === 'object' && message !== null ? message as Record<string, unknown> : {};
  const inner = record['type'] === 'assistant' && typeof record['message'] === 'object' && record['message'] !== null ? record['message'] as Record<string, unknown> : undefined;
  const usage = typeof inner?.['usage'] === 'object' && inner['usage'] !== null ? inner['usage'] as Record<string, unknown> : undefined;
  const { id, model } = inner ?? {};
  if (usage === undefined || typeof id !== 'string' || typeof model !== 'string') return undefined;
  const split = typeof usage['cache_creation'] === 'object' && usage['cache_creation'] !== null ? usage['cache_creation'] as Record<string, unknown> : undefined;
  const longWrite = count(split?.['ephemeral_1h_input_tokens']);
  const cacheRead = cacheReadRatios.find(([name]) => model.includes(name))?.[1] ?? 0.1;
  const weight = count(usage['input_tokens']) + 5 * count(usage['output_tokens']) + cacheRead * count(usage['cache_read_input_tokens'])
    + 1.25 * Math.max(0, count(usage['cache_creation_input_tokens']) - longWrite) + 2 * longWrite;
  return { id, model, weight };
}

/** Each model's reported cost split across agents by their share of its weighted tokens; cost no agent's turns account for goes to the orchestrator. */
export function splitAgentCost(models: readonly ReviewModelUsage[], turns: ReadonlyMap<string, WeightedTurn & { readonly agent: ReviewAgent }>): ReviewAgentUsage[] {
  const costs = new Map<ReviewAgent, number>();
  for (const row of models) {
    const shares = [...turns.values()].filter((turn) => turn.model === row.model);
    const total = shares.reduce((sum, turn) => sum + turn.weight, 0);
    if (total === 0) { costs.set('orchestrator', (costs.get('orchestrator') ?? 0) + row.cost); continue; }
    for (const turn of shares) costs.set(turn.agent, (costs.get(turn.agent) ?? 0) + row.cost * turn.weight / total);
  }
  const order: readonly ReviewAgent[] = ['orchestrator', ...reviewers];
  return order.flatMap((agent) => (costs.get(agent) ?? 0) > 0 ? [{ agent, cost: costs.get(agent) ?? 0 }] : []);
}

/** Usage as saved; undefined when a file has none or it is malformed. */
function readStoredUsage(raw: unknown): ReviewUsage | undefined {
  const record = typeof raw === 'object' && raw !== null ? raw as Record<string, unknown> : {};
  const cost = money(record['cost']);
  if (cost === undefined) return undefined;
  const agents = records(Array.isArray(record['agents']) ? record['agents'] : []).flatMap((row): ReviewAgentUsage[] => {
    const agent = pick<ReviewAgent>(row['agent'], ['orchestrator', ...reviewers]);
    const share = money(row['cost']);
    return agent === undefined || share === undefined ? [] : [{ agent, cost: share }];
  });
  return { durationMs: count(record['durationMs']), cost, turns: count(record['turns']), models: readUsageModels(record['models'], { input: 'input', output: 'output', cacheRead: 'cacheRead', cacheWrite: 'cacheWrite', cost: 'cost' }), agents };
}

const reviewerList = { type: 'array', items: { type: 'string', enum: reviewers } } as const;

/** Structured output the orchestrator must return. */
export const reviewSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['ran', 'skipped', 'candidates', 'findings', 'dropped'],
  properties: {
    ran: reviewerList,
    skipped: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['reviewer', 'reason'], properties: { reviewer: { type: 'string', enum: reviewers }, reason: { type: 'string' } } } },
    candidates: { type: 'integer', minimum: 0 },
    findings: {
      type: 'array', maxItems: maximumFindings,
      items: {
        type: 'object', additionalProperties: false,
        required: ['reviewers', 'path', 'startLine', 'endLine', 'title', 'body', 'severity', 'evidence', 'evidenceDetail', 'fix'],
        properties: {
          reviewers: reviewerList, path: { type: 'string' }, startLine: { type: 'integer', minimum: 1 }, endLine: { type: 'integer', minimum: 1 },
          title: { type: 'string' }, body: { type: 'string' }, severity: { type: 'string', enum: severities }, evidence: { type: 'string', enum: evidences }, evidenceDetail: { type: 'string' }, fix: { type: 'string' },
        },
      },
    },
    dropped: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false, required: ['claim', 'reviewers', 'reason', 'why'],
        properties: { claim: { type: 'string' }, reviewers: reviewerList, reason: { type: 'string', enum: dropReasons.filter((reason) => reason !== 'unplaced') }, why: { type: 'string' } },
      },
    },
  },
} as const;

const focus: Readonly<Record<Reviewer, string>> = { correctness, design, security, performance, tests };

/** A prompt file with each `{{name}}` replaced by its value. */
function fill(template: string, values: Readonly<Record<string, string>>): string {
  return template.trim().replaceAll(/\{\{(\w+)\}\}/gu, (placeholder, name: string) => values[name] ?? placeholder);
}

/** The subagent definition for one reviewer, given the scratch worktree it verifies in. */
function reviewerAgent(reviewer: Reviewer, worktree: string): { description: string; prompt: string; tools: readonly string[]; model: string } {
  const { label } = reviewerInfo[reviewer];
  return {
    description: `${label} reviewer for DiffGuide's code review. Call it with a brief and a phase: candidates or verification.`,
    model: 'sonnet',
    tools: ['Read', 'Grep', 'Glob', 'Bash', 'Write', 'Edit', 'WebFetch'],
    prompt: fill(reviewerTemplate, { label, focus: focus[reviewer].trim(), worktree }),
  };
}

/** The `--agents` definitions for one run, keyed by subagent name. */
export function reviewAgents(worktrees: ReadonlyMap<Reviewer, string>): Record<string, ReturnType<typeof reviewerAgent>> {
  return Object.fromEntries([...worktrees].map(([reviewer, worktree]) => [`${reviewer}-reviewer`, reviewerAgent(reviewer, worktree)]));
}

const orchestration = fill(orchestratorTemplate, { maximumFindings: String(maximumFindings) });

/** Lines of one file's diff with new-side line numbers, so findings can name them. */
function numberedDiff(file: FileDiff): string {
  const head = `=== ${file.path} (${file.change}${file.oldPath ? `, was ${file.oldPath}` : ''})`;
  if (file.binary) return `${head}\nBinary file.`;
  const line = (entry: DiffLine): string => `${String(entry.newLine ?? '').padStart(5)} ${entry.kind === 'add' ? '+' : entry.kind === 'del' ? '-' : ' '}${lineText(entry)}`;
  return [head, ...file.hunks.map((hunk) => [hunk.header, ...hunk.lines.map(line)].join('\n'))].join('\n');
}

const maximumFileDiffLength = 40_000;

/** The orchestrator's prompt: the process, the picked reviewers and their worktrees, then the diff. */
export function reviewPrompt(files: readonly FileDiff[], about: string, worktrees: ReadonlyMap<Reviewer, string>): string {
  const picked = [...worktrees.keys()].map((reviewer) => `- ${reviewer}: subagent ${reviewer}-reviewer`).join('\n');
  const diff = files.map((file) => {
    const text = numberedDiff(file);
    return text.length <= maximumFileDiffLength ? text : `=== ${file.path}\nToo large to show; read the file.`;
  }).join('\n\n');
  return `${orchestration}\n\nReviewers the user picked:\n${picked}\n\nUnder review: ${about}\n\nBEGIN DIFF\n${diff}\nEND DIFF`;
}

/** Plain text from untrusted output: no control characters except newlines and tabs, capped. */
function cleanText(value: unknown, maximum: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const text = value.replaceAll(/[\u0000-\u0008\u000b-\u001f\u007f]+/gu, ' ').trim();
  if (text === '') return undefined;
  return text.length > maximum ? text.slice(0, maximum - 1) + '…' : text;
}

const records = (value: unknown): Record<string, unknown>[] => Array.isArray(value)
  ? value.filter((item): item is Record<string, unknown> => typeof item === 'object' && item !== null && !Array.isArray(item))
  : [];

function readReviewers(value: unknown, allowed: readonly Reviewer[]): Reviewer[] {
  const list = Array.isArray(value) ? value : [];
  return allowed.filter((reviewer) => list.includes(reviewer));
}

const pick = <T extends string>(value: unknown, options: readonly T[]): T | undefined => options.find((option) => option === value);
const positive = (value: unknown): number | undefined => typeof value === 'number' && Number.isInteger(value) && value >= 1 ? value : undefined;

function readDropped(value: unknown, allowed: readonly Reviewer[]): DroppedCandidate[] {
  return records(value).flatMap((item): DroppedCandidate[] => {
    const claim = cleanText(item['claim'], 300);
    const reason = pick(item['reason'], dropReasons);
    return claim === undefined || reason === undefined ? [] : [{ claim, reviewers: readReviewers(item['reviewers'], allowed), reason, why: cleanText(item['why'], 1000) ?? '' }];
  }).slice(0, maximumDropped);
}

/** Validate the orchestrator's output against the reviewers that could run and the diff's files; a finding outside them becomes an unplaced drop. */
export function parseReviewOutput(raw: unknown, picked: readonly Reviewer[], files: readonly FileDiff[]): ReviewOutput {
  const record = typeof raw === 'object' && raw !== null ? raw as Record<string, unknown> : {};
  const paths = new Set(files.filter((file) => !file.binary && file.change !== 'deleted').map((file) => file.path));
  const unplaced: DroppedCandidate[] = [];
  const findings = records(record['findings']).flatMap((item): ReviewFinding[] => {
    const title = cleanText(item['title'], 120);
    const body = cleanText(item['body'], 4000);
    const severity = pick(item['severity'], severities);
    const evidence = pick(item['evidence'], evidences);
    const agents = readReviewers(item['reviewers'], picked);
    if (title === undefined || body === undefined || severity === undefined || evidence === undefined || agents.length === 0) return [];
    const path = typeof item['path'] === 'string' ? item['path'] : '';
    const startLine = positive(item['startLine']);
    const endLine = positive(item['endLine']);
    if (!paths.has(path) || startLine === undefined || endLine === undefined || endLine < startLine) {
      unplaced.push({ claim: title, reviewers: agents, reason: 'unplaced', why: `It named ${path || 'no file'}${startLine === undefined ? '' : `:${startLine}`}, which is not a changed line in this diff.` });
      return [];
    }
    const clamped = endLine - startLine + 1 > maximumFindingLines;
    const fix = cleanText(item['fix'], 6000) ?? '';
    // A suggestion replaces the anchored lines, so on a clamped range it would drop the rest; show it as plain code instead.
    return [{ reviewers: agents, path, startLine, endLine: clamped ? startLine + maximumFindingLines - 1 : endLine, title, body, severity, evidence, evidenceDetail: cleanText(item['evidenceDetail'], 8000) ?? '', fix: clamped ? fix.replace(/^( {0,3}(?:`{3,}|~{3,})[ \t]*)suggestion\b/gmu, '$1') : fix }];
  });
  const ran = readReviewers(record['ran'], picked);
  const skipped = records(record['skipped']).flatMap((item) => {
    const reviewer = pick(item['reviewer'], picked);
    return reviewer === undefined || ran.includes(reviewer) ? [] : [{ reviewer, reason: cleanText(item['reason'], 300) ?? '' }];
  });
  const candidates = typeof record['candidates'] === 'number' && Number.isInteger(record['candidates']) && record['candidates'] >= 0 ? record['candidates'] : 0;
  return { ran, skipped, candidates, findings: findings.slice(0, maximumFindings), dropped: [...readDropped(record['dropped'], picked), ...unplaced].slice(0, maximumDropped) };
}

/** The thread message for a finding: its claim, the fix, then the evidence folded away as on GitHub. */
export function findingText(finding: ReviewFinding): string {
  return [
    finding.body,
    ...finding.fix === '' ? [] : [`#### Suggested fix\n\n${finding.fix}`],
    ...finding.evidenceDetail === '' ? [] : [`<details>\n<summary>Evidence: ${finding.evidence}</summary>\n\n${finding.evidenceDetail}\n\n</details>`],
  ].join('\n\n');
}

/** Read a saved review, or undefined when the file is missing parts. */
export function readStoredReview(raw: unknown): CodeReviewResult | undefined {
  const record = typeof raw === 'object' && raw !== null ? raw as Record<string, unknown> : {};
  if (typeof record['createdAt'] !== 'string') return undefined;
  const ran = readReviewers(record['ran'], reviewers);
  const skipped = records(record['skipped']).flatMap((item) => {
    const reviewer = pick(item['reviewer'], reviewers);
    return reviewer === undefined ? [] : [{ reviewer, reason: cleanText(item['reason'], 300) ?? '' }];
  });
  const findings = records(record['findings']).flatMap((item) => {
    const title = cleanText(item['title'], 120);
    const severity = pick(item['severity'], severities);
    const evidence = pick(item['evidence'], evidences);
    const startLine = positive(item['startLine']);
    const { threadId, path } = item;
    return title === undefined || severity === undefined || evidence === undefined || startLine === undefined || typeof threadId !== 'string' || typeof path !== 'string'
      ? [] : [{ threadId, title, severity, evidence, reviewers: readReviewers(item['reviewers'], reviewers), path, startLine }];
  });
  const candidates = typeof record['candidates'] === 'number' && Number.isInteger(record['candidates']) && record['candidates'] >= 0 ? record['candidates'] : 0;
  const usage = readStoredUsage(record['usage']);
  return { createdAt: record['createdAt'], ran, skipped, candidates, findings, dropped: readDropped(record['dropped'], reviewers), ...usage === undefined ? {} : { usage } };
}

/** Where a review run is, following the orchestrator's process. */
export type ReviewStage = 'triage' | 'candidates' | 'select' | 'verify' | 'report';
export const reviewStages: readonly ReviewStage[] = ['triage', 'candidates', 'select', 'verify', 'report'];

/** One item a review agent handed back: a candidate with its severity, or a verdict on one. */
export interface ReviewLaneItem {
  readonly title: string;
  readonly severity?: FindingSeverity;
  readonly verdict?: 'confirmed' | 'refuted' | 'unconfirmed';
}

/** One review agent's latest call. */
export interface ReviewLane {
  readonly reviewer: Reviewer;
  readonly phase: 'candidates' | 'verification';
  readonly startedAt: number;
  readonly endedAt?: number;
  readonly failed?: boolean;
  readonly steps: readonly AgentStep[];
  readonly items?: readonly ReviewLaneItem[];
}

/** A review run as the page shows it: the stage, the orchestrator's steps and a lane per agent it called. */
export interface ReviewLive {
  readonly reviewers: readonly Reviewer[];
  readonly stage: ReviewStage;
  readonly startedAt: number;
  readonly endedAt?: number;
  readonly orchestrator: readonly AgentStep[];
  readonly lanes: readonly ReviewLane[];
  readonly usage?: ReviewUsage;
}

const verdicts = ['confirmed', 'refuted', 'unconfirmed'] as const;
const maximumLaneItems = 10;

/** The items in an agent's handback: the first JSON array in it, as the agent prompt asks for. */
export function handbackItems(text: string): ReviewLaneItem[] {
  const fenced = /```json\s*([\s\S]*?)```/u.exec(text)?.[1];
  const start = text.indexOf('[');
  const json = fenced ?? (start === -1 ? undefined : text.slice(start, text.lastIndexOf(']') + 1));
  let value: unknown;
  try { value = json === undefined ? undefined : JSON.parse(json); } catch { return []; }
  if (!Array.isArray(value)) return [];
  return value.flatMap((item: unknown): ReviewLaneItem[] => {
    if (typeof item !== 'object' || item === null) return [];
    const record = item as Record<string, unknown>;
    const title = cleanText(record['title'], 160);
    if (title === undefined) return [];
    const severity = severities.find((option) => option === record['severity']);
    const verdict = verdicts.find((option) => option === record['verdict']);
    return [{ title, ...(severity === undefined ? {} : { severity }), ...(verdict === undefined ? {} : { verdict }) }];
  }).slice(0, maximumLaneItems);
}

/** The code review: whether it runs, the reviewers picked for the next run, and the last result. */
export interface ReviewView {
  readonly running: boolean;
  readonly live?: ReviewLive;
  readonly error?: string;
  readonly result?: CodeReviewResult;
  readonly picked: readonly Reviewer[];
}
