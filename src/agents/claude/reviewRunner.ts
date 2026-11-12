import type { spawn as spawnProcess } from 'node:child_process';
import { cp, mkdir, readdir, readFile, rm, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { AgentCodeReview, CodeReviewActivity, CodeReviewInput } from '../../core/agent.js';
import { type Reviewer, reviewers, type ReviewStore } from '../../core/contracts.js';
import { Emitter } from '../../core/events.js';
import { excludeFromGit, git } from '../../core/git/worktrees.js';
import type { KeyValueStore } from '../../core/host.js';
import { writePrivateJson } from '../../core/privateFiles.js';
import { type CodeReviewResult, type DroppedCandidate, findingText, handbackItems, parseReviewOutput, parseReviewUsage, readStoredReview, type ReviewAgent, reviewAgents, type ReviewLane, type ReviewLaneItem, type ReviewLive, reviewPrompt, reviewSchema, type ReviewStage, type ReviewUsage, type ReviewView, splitAgentCost, weightedTurn, type WeightedTurn } from '../../core/review.js';
import { quotePosix, stopProcess } from '../../core/shell.js';
import { type ClaudeRunnerOptions, contentBlocks, StepLog, type StreamMessage, untrustedCheckoutFlags } from './claudeRunner.js';
import { worktreeFolder } from './editGuard.js';
import { runStructuredClaude, type StructuredRun } from './prAnalysisRunner.js';

interface AgentCall {
  readonly reviewer: Reviewer;
  readonly phase: ReviewLane['phase'];
  readonly startedAt: number;
  readonly log: StepLog;
  endedAt?: number;
  failed?: boolean;
  items?: ReviewLaneItem[];
}

/** Splits a review run's stream into the orchestrator and one lane per review agent call, by each message's parent tool call. */
export class ReviewTracker {
  readonly #orchestrator: StepLog;
  readonly #calls = new Map<unknown, AgentCall>();
  #reporting = false;
  #endedAt: number | undefined;
  #usage: ReviewUsage | undefined;
  // Keyed by message id: the stream repeats a message once per content block.
  readonly #turns = new Map<string, WeightedTurn & { readonly agent: ReviewAgent }>();

  constructor(
    private readonly cwd: string,
    private readonly reviewers: readonly Reviewer[],
    private readonly worktrees: ReadonlyMap<Reviewer, string>,
    private readonly startedAt: number,
    private readonly now: () => number = Date.now,
  ) {
    this.#orchestrator = new StepLog(cwd);
  }

  /** Take one stream message; true when the live state changed. */
  read(message: StreamMessage): boolean {
    if (message.type === 'result') {
      // A result holds session totals, so the last one stands; wall time runs to the result.
      const usage = parseReviewUsage(message, this.now() - this.startedAt);
      if (usage !== undefined) { this.#usage = { ...usage, agents: splitAgentCost(usage.models, this.#turns) }; return true; }
    }
    const parent = message.parent_tool_use_id;
    const turn = weightedTurn(message);
    // Subagents other than the review agents count toward the orchestrator that called them.
    if (turn !== undefined) this.#turns.set(turn.id, { ...turn, agent: (parent === undefined || parent === null ? undefined : this.#calls.get(parent)?.reviewer) ?? 'orchestrator' });
    if (parent !== undefined && parent !== null) {
      const call = this.#calls.get(parent);
      if (call === undefined) return false;
      for (const block of contentBlocks(message)) {
        const input = block.input as Record<string, unknown> | undefined;
        if (message.type === 'assistant' && block.type === 'tool_use' && block.name === 'SubagentHandback' && typeof input?.['message'] === 'string') call.items = handbackItems(input['message']);
      }
      return call.log.read(message);
    }
    let changed = this.#orchestrator.read(message);
    for (const block of contentBlocks(message)) {
      const input = typeof block.input === 'object' && block.input !== null ? block.input as Record<string, unknown> : {};
      if (message.type === 'assistant' && block.type === 'tool_use' && (block.name === 'Agent' || block.name === 'Task')) {
        const reviewer = this.reviewers.find((name) => input['subagent_type'] === `${name}-reviewer`);
        if (reviewer === undefined) continue;
        // The prompt has each reviewer called once for candidates, then again to verify them.
        const phase = [...this.#calls.values()].some((call) => call.reviewer === reviewer) ? 'verification' : 'candidates';
        this.#calls.set(block.id, { reviewer, phase, startedAt: this.now(), log: new StepLog(this.worktrees.get(reviewer) ?? this.cwd) });
        changed = true;
      } else if (message.type === 'assistant' && block.type === 'tool_use' && block.name === 'StructuredOutput') {
        this.#reporting = true;
        changed = true;
      } else if (message.type === 'user' && block.type === 'tool_result') {
        const call = this.#calls.get(block.tool_use_id);
        if (call === undefined || call.endedAt !== undefined) continue;
        call.endedAt = this.now();
        if (block.is_error === true) call.failed = true;
        changed = true;
      }
    }
    return changed;
  }

  /** Mark the run as over, so timers stop. */
  end(): void {
    this.#endedAt ??= this.now();
  }

  get live(): ReviewLive {
    const latest = new Map<Reviewer, AgentCall>();
    for (const call of this.#calls.values()) latest.set(call.reviewer, call);
    const calls = [...latest.values()];
    const lanes = calls.map((call): ReviewLane => ({
      reviewer: call.reviewer, phase: call.phase, startedAt: call.startedAt, steps: call.log.steps,
      ...(call.endedAt === undefined ? {} : { endedAt: call.endedAt }), ...(call.failed ? { failed: true } : {}), ...(call.items === undefined ? {} : { items: call.items }),
    }));
    return {
      reviewers: this.reviewers, stage: this.#stage(calls), startedAt: this.startedAt, orchestrator: this.#orchestrator.steps, lanes,
      ...(this.#endedAt === undefined ? {} : { endedAt: this.#endedAt }), ...(this.#usage === undefined ? {} : { usage: this.#usage }),
    };
  }

  #stage(calls: readonly AgentCall[]): ReviewStage {
    if (this.#reporting) return 'report';
    const running = calls.filter((call) => call.endedAt === undefined);
    if (running.some((call) => call.phase === 'verification')) return 'verify';
    if (running.length > 0) return 'candidates';
    if (calls.length === 0) return 'triage';
    return calls.some((call) => call.phase === 'verification') ? 'report' : 'select';
  }
}

export interface CodeReviewOptions {
  readonly store: ReviewStore;
  /** The checkout under review; review worktrees go below it. */
  readonly cwd: string;
  readonly dataPath: string;
  readonly role: ClaudeRunnerOptions['role'];
  readonly resolve: StructuredRun['resolve'];
  readonly log: (line: string) => void;
  /** The edit guard script and the Node.js that runs it. */
  readonly guard: () => Promise<{ readonly guard: string; readonly node: string }>;
  readonly spawn?: typeof spawnProcess;
}

// Not review.json: the thread store owns that name in the same folder.
const reviewFile = (dataPath: string): string => join(dataPath, 'code-review.json');
const runsFolder = (cwd: string): string => join(cwd, worktreeFolder, 'review');
/** A run folder this old is left over from a crash or a closed window. */
const staleRunMs = 24 * 60 * 60 * 1000;
const noHooks = ['-c', 'core.hooksPath=/dev/null'];

/** The review saved in a data folder, if any. */
function readSavedReview(dataPath: string): Promise<CodeReviewResult | undefined> {
  return readFile(reviewFile(dataPath), 'utf8').then((text) => readStoredReview(JSON.parse(text)), () => undefined);
}

/** One scratch worktree per reviewer, from the checkout as it is: tracked edits through a stash commit, untracked files copied. */
async function createWorktrees(cwd: string, root: string, picked: readonly Reviewer[]): Promise<Map<Reviewer, string>> {
  await excludeFromGit(cwd);
  const snapshot = (await git(cwd, ['stash', 'create'])).trim() || 'HEAD';
  const untracked = (await git(cwd, ['ls-files', '--others', '--exclude-standard', '-z'])).split('\0').filter((path) => path !== '');
  await mkdir(root, { recursive: true, mode: 0o700 });
  const worktrees = new Map(picked.map((reviewer) => [reviewer, join(root, reviewer)]));
  for (const folder of worktrees.values()) {
    await git(cwd, [...noHooks, 'worktree', 'add', '--detach', folder, snapshot]);
    for (const path of untracked) {
      await mkdir(dirname(join(folder, path)), { recursive: true });
      await cp(join(cwd, path), join(folder, path), { force: true, verbatimSymlinks: true }).catch(() => undefined);
    }
  }
  return worktrees;
}

async function removeRun(cwd: string, root: string): Promise<void> {
  for (const name of await readdir(root).catch(() => [] as string[])) await git(cwd, ['worktree', 'remove', '--force', join(root, name)]).catch(() => undefined);
  await rm(root, { recursive: true, force: true });
  await git(cwd, ['worktree', 'prune']).catch(() => undefined);
}

/** Remove run folders a crashed or closed window left behind. */
async function sweepRuns(cwd: string): Promise<void> {
  const folder = runsFolder(cwd);
  for (const name of await readdir(folder).catch(() => [] as string[])) {
    const changed = await stat(join(folder, name)).then((info) => info.mtimeMs, () => Date.now());
    if (Date.now() - changed > staleRunMs) await removeRun(cwd, join(folder, name));
  }
}

/** A headless Claude run that has review agents look for defects, prove them in scratch worktrees, and posts the proven ones as threads. */
export class CodeReview implements AgentCodeReview {
  readonly #changed = new Emitter<void>();
  readonly onDidChange = this.#changed.event;
  #activity: CodeReviewActivity = { running: false };
  #result: Promise<CodeReviewResult | undefined> | undefined;
  #child: ReturnType<typeof spawnProcess> | undefined;
  #tracker: ReviewTracker | undefined;
  #stopped = false;
  #disposed = false;

  constructor(private readonly options: CodeReviewOptions) {
    void sweepRuns(options.cwd);
  }

  get activity(): CodeReviewActivity {
    return this.#activity;
  }

  /** The last finished review, if any. */
  result(): Promise<CodeReviewResult | undefined> {
    this.#result ??= readSavedReview(this.options.dataPath);
    return this.#result;
  }

  /** Start a run unless one is going. */
  start(input: CodeReviewInput): void {
    if (this.#activity.running || this.#disposed) return;
    this.#stopped = false;
    this.#tracker = undefined;
    this.#set({ running: true });
    void this.#run(input).then(
      () => { this.#set({ running: false }); },
      (failure: unknown) => {
        const error = this.#stopped ? 'Stopped.' : failure instanceof Error ? failure.message : String(failure);
        this.options.log(`Review failed: ${error}`);
        this.#tracker?.end();
        const live = this.#tracker?.live;
        this.#set({ running: false, error, ...(live === undefined ? {} : { live }) });
      },
    );
  }

  stop(): void {
    this.#stopped = true;
    if (this.#child !== undefined) stopProcess(this.#child);
  }

  dispose(): void {
    this.#disposed = true;
    this.stop();
    this.#changed.dispose();
  }

  #set(activity: CodeReviewActivity): void {
    this.#activity = activity;
    if (!this.#disposed) this.#changed.fire();
  }

  async #run(input: CodeReviewInput): Promise<void> {
    const files = input.files.filter((file) => file.change !== 'unchanged' && file.saved !== true);
    if (files.length === 0) throw new Error('There are no changes to review.');
    if (input.reviewers.length === 0) throw new Error('Pick at least one reviewer.');
    const { cwd, dataPath } = this.options;
    const root = join(runsFolder(cwd), Date.now().toString(36));
    let output: unknown;
    try {
      const worktrees = await createWorktrees(cwd, root, input.reviewers);
      if (this.#stopped) throw new Error('Stopped.');
      const agentsPath = join(dataPath, 'review-agents.json');
      await writePrivateJson(agentsPath, reviewAgents(worktrees));
      this.options.log(`Reviewing with ${input.reviewers.join(', ')}`);
      const tracker = new ReviewTracker(cwd, input.reviewers, worktrees, Date.now());
      this.#tracker = tracker;
      this.#set({ ...this.#activity, live: tracker.live });
      output = await runStructuredClaude({
        ...this.options, prompt: reviewPrompt(files, input.about, worktrees), schema: reviewSchema, missing: 'Claude returned no review.',
        args: [
          '--agents', agentsPath, '--settings', await this.#guardSettings(),
          '--allowedTools', 'Read', 'Grep', 'Glob', 'Bash', 'Write', 'Edit', 'WebFetch', 'Agent', 'Task',
          ...(this.options.role === 'reviewer' ? untrustedCheckoutFlags : []),
        ],
        env: {
          // The CLI may launch agents as background tasks; the orchestrator then ends its turn before they report, and the review comes back empty.
          CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: '1',
          // On someone else's PR, Git hooks stay off, since the PR's author controls the checkout.
          ...this.options.role === 'reviewer' ? { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.hooksPath', GIT_CONFIG_VALUE_0: '/dev/null' } : {},
        },
        startedAt: tracker.live.startedAt,
        stopped: () => this.#stopped,
        onChild: (child) => { this.#child = child; },
        onStep: () => undefined,
        onProgress: () => undefined,
        onMessage: (message) => { if (tracker.read(message)) this.#set({ ...this.#activity, live: tracker.live }); },
      });
    } finally {
      await removeRun(cwd, root);
    }
    const usage = this.#tracker?.live.usage;
    const parsed = parseReviewOutput(output, input.reviewers, files);
    const anchors = await Promise.all(parsed.findings.map((finding) => input.anchor({ path: finding.path, side: 'new', startLine: finding.startLine, endLine: finding.endLine }).catch(() => undefined)));
    const placed = parsed.findings.flatMap((finding, index) => {
      const anchor = anchors[index];
      return anchor === undefined ? [] : [{ finding, anchor }];
    });
    const unplaced = parsed.findings.filter((_, index) => anchors[index] === undefined).map((finding): DroppedCandidate => ({
      claim: finding.title, reviewers: finding.reviewers, reason: 'unplaced', why: `Could not place it on ${finding.path}:${finding.startLine}.`,
    }));
    const ids = await this.options.store.replaceReviewFindings(placed.map(({ finding, anchor }) => ({
      anchor, text: findingText(finding), title: finding.title,
      finding: { reviewers: finding.reviewers, severity: finding.severity, evidence: finding.evidence },
    })));
    const saved: CodeReviewResult = {
      createdAt: new Date().toISOString(), ran: parsed.ran, skipped: parsed.skipped, candidates: parsed.candidates,
      findings: placed.flatMap(({ finding }, index) => {
        const threadId = ids[index];
        return threadId === undefined ? [] : [{ threadId, title: finding.title, severity: finding.severity, evidence: finding.evidence, reviewers: finding.reviewers, path: finding.path, startLine: finding.startLine }];
      }),
      dropped: [...parsed.dropped, ...unplaced],
      ...usage === undefined ? {} : { usage },
    };
    await writePrivateJson(reviewFile(dataPath), saved);
    this.#result = Promise.resolve(saved);
    this.options.log(`Review done: ${saved.findings.length} findings, ${saved.dropped.length} dropped.`);
  }

  /** Settings with the edit guard: file tools may write only below the checkout's DiffGuide worktrees, where the review worktrees are. */
  async #guardSettings(): Promise<string> {
    const { guard, node } = await this.options.guard();
    const foldersPath = join(this.options.dataPath, 'review-read-only.json');
    const settingsPath = join(this.options.dataPath, 'review-guard.json');
    await writePrivateJson(foldersPath, [this.options.cwd]);
    const command = [node, guard, foldersPath].map(quotePosix).join(' ');
    await writePrivateJson(settingsPath, { hooks: { PreToolUse: [{ matcher: 'Edit|MultiEdit|Write|NotebookEdit', hooks: [{ type: 'command', command }] }] } });
    return settingsPath;
  }
}

const picksKey = (repository: string): string => `diffGuide.reviewers:${repository}`;

/** The reviewers picked for a repository's next review; all of them until the user picks. */
export function readPicks(state: KeyValueStore, repository: string): Reviewer[] {
  const saved = state.get<unknown>(picksKey(repository));
  return Array.isArray(saved) ? reviewers.filter((reviewer) => saved.includes(reviewer)) : [...reviewers];
}

export async function savePicks(state: KeyValueStore, repository: string, picks: readonly Reviewer[]): Promise<void> {
  await state.update(picksKey(repository), [...picks]);
}

/** The page's view of a code review. */
export async function reviewView(review: AgentCodeReview, picked: readonly Reviewer[]): Promise<ReviewView> {
  const result = await review.result();
  const { running, live, error } = review.activity;
  return { running, picked, ...(live === undefined ? {} : { live }), ...(error === undefined ? {} : { error }), ...(result === undefined ? {} : { result }) };
}
