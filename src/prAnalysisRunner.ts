import { spawn as spawnProcess } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import * as vscode from 'vscode';
import { contentBlocks, describeTool, parseLine, StepLog, untrustedCheckoutFlags, type ClaudeProgress, type ClaudeRunnerOptions, type StreamMessage } from './claudeRunner.js';
import type { CodeAnchor, ReviewStore } from './contracts.js';
import { analysisPrompt, analysisSchema, changeBlocks, parseClaudeAnalysis, readStoredAnalysis, type Analysis, type ChangeBlock } from './prAnalysis.js';
import { writePrivateJson } from './privateFiles.js';
import { stopProcess } from './shell.js';
import type { FileDiff } from './unifiedDiff.js';

/** What the analysis run is doing right now. */
export interface AnalysisActivity {
  readonly running: boolean;
  readonly step?: string;
  readonly progress?: ClaudeProgress;
  readonly error?: string;
}

export interface AnalysisOptions {
  readonly store: ReviewStore;
  readonly cwd: string;
  readonly dataPath: string;
  readonly role: ClaudeRunnerOptions['role'];
  readonly resolve: ClaudeRunnerOptions['resolve'];
  readonly log: (line: string) => void;
  readonly spawn?: typeof spawnProcess;
  /** The user's own analysis instructions, read fresh for each run. */
  readonly instructions?: () => Promise<string>;
}

/** What one run analyzes. */
export interface AnalysisInput {
  readonly files: readonly FileDiff[];
  readonly head: string;
  /** Title and branches, for the prompt. */
  readonly about: string;
  /** Anchor for a block's lines, to open its note as a thread. */
  readonly anchor: (block: ChangeBlock) => Promise<CodeAnchor>;
}

const analysisFile = (dataPath: string): string => join(dataPath, 'analysis.json');

/** The analysis saved in a PR's review data folder, if any. */
function readSavedAnalysis(dataPath: string): Promise<Analysis | undefined> {
  return readFile(analysisFile(dataPath), 'utf8').then((text) => readStoredAnalysis(JSON.parse(text)), () => undefined);
}

const blockedTools = ['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Bash', 'WebFetch', 'WebSearch', 'Task', 'Agent'];
const maximumPromptLength = 800_000;

/** A one-shot, read-only Claude run that orders a PR's changes for review; separate from the conversation that answers comments. */
export class PullRequestAnalysis implements vscode.Disposable {
  readonly #changed = new vscode.EventEmitter<void>();
  readonly onDidChange = this.#changed.event;
  #activity: AnalysisActivity = { running: false };
  #result: Promise<Analysis | undefined> | undefined;
  #child: ReturnType<typeof spawnProcess> | undefined;
  #stopped = false;
  #disposed = false;

  constructor(private readonly options: AnalysisOptions) {}

  get activity(): AnalysisActivity {
    return this.#activity;
  }

  /** The last finished analysis, if any. */
  result(): Promise<Analysis | undefined> {
    this.#result ??= readSavedAnalysis(this.options.dataPath);
    return this.#result;
  }

  /** Start a run unless one is going. */
  start(input: AnalysisInput): void {
    if (this.#activity.running || this.#disposed) return;
    this.#stopped = false;
    this.#set({ running: true, step: 'Starting', progress: { steps: [], startedAt: Date.now() } });
    void this.#run(input).then(
      () => { this.#set({ running: false }); },
      (failure: unknown) => {
        const error = this.#stopped ? 'Stopped.' : failure instanceof Error ? failure.message : String(failure);
        this.options.log(`Guide failed: ${error}`);
        this.#set({ running: false, error });
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

  #set(activity: AnalysisActivity): void {
    this.#activity = activity;
    if (!this.#disposed) this.#changed.fire();
  }

  async #run(input: AnalysisInput): Promise<void> {
    const blocks = changeBlocks(input.files);
    if (blocks.length === 0) throw new Error('This PR has no line changes to analyze.');
    const prompt = analysisPrompt(input.files, blocks, input.about, await this.options.instructions?.() ?? '');
    if (prompt.length > maximumPromptLength) throw new Error(`This PR is too large to analyze (${blocks.length} changed blocks).`);
    const output = await this.#spawn(prompt);
    const analysis = parseClaudeAnalysis(output, blocks, input.head, new Date().toISOString());
    const byRef = new Map(blocks.map((block) => [block.path + '\0' + block.signature, block]));
    const anchors = await Promise.all(analysis.groups.flatMap((group) => group.steps).map(async (step) => {
      const first = step.blocks[0];
      const block = first === undefined ? undefined : byRef.get(first.path + '\0' + first.signature);
      return block === undefined ? undefined : await input.anchor(block).catch(() => undefined);
    }));
    const notes = analysis.groups.flatMap((group) => group.steps).flatMap((step, index) => {
      const anchor = anchors[index];
      return anchor === undefined ? [] : [{ index, anchor, text: step.note }];
    });
    const ids = await this.options.store.replaceAnalysisNotes(notes);
    const threadOf = new Map(notes.map((note, position) => [note.index, ids[position]]));
    let index = 0;
    const saved: Analysis = {
      ...analysis,
      groups: analysis.groups.map((group) => ({
        ...group,
        steps: group.steps.map((step) => {
          const threadId = threadOf.get(index++);
          return threadId === undefined ? step : { ...step, threadId };
        }),
      })),
    };
    await writePrivateJson(analysisFile(this.options.dataPath), saved);
    this.#result = Promise.resolve(saved);
    this.options.log(`Guide done: ${saved.groups.length} groups, ${index} steps.`);
  }

  /** Run Claude and resolve with its structured output. */
  async #spawn(prompt: string): Promise<unknown> {
    this.options.log('Building the PR guide');
    return await runStructuredClaude({
      ...this.options, prompt, schema: analysisSchema, missing: 'Claude returned no guide.',
      args: ['--allowedTools', 'Read', 'Grep', 'Glob', '--disallowedTools', ...blockedTools, ...(this.options.role === 'reviewer' ? untrustedCheckoutFlags : [])],
      startedAt: this.#activity.progress?.startedAt ?? Date.now(),
      stopped: () => this.#stopped,
      onChild: (child) => { this.#child = child; },
      onStep: (step) => { this.#set({ ...this.#activity, step }); },
      onProgress: (progress) => { this.#set({ ...this.#activity, progress }); },
    });
  }
}

/** One headless Claude run that must return structured output matching `schema`. */
export interface StructuredRun {
  readonly resolve: () => Promise<{ readonly executable: string; readonly shell?: string }>;
  readonly cwd: string;
  readonly log: (line: string) => void;
  readonly spawn?: typeof spawnProcess;
  readonly prompt: string;
  readonly schema: object;
  /** Flags after the output flags, such as tool permissions. */
  readonly args: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
  /** The error when Claude finished without structured output. */
  readonly missing: string;
  readonly startedAt: number;
  readonly stopped: () => boolean;
  readonly onChild: (child: ReturnType<typeof spawnProcess> | undefined) => void;
  readonly onStep: (step: string) => void;
  readonly onProgress: (progress: ClaudeProgress) => void;
  /** Every parsed stream message, for callers that track more than the step log. */
  readonly onMessage?: (message: StreamMessage) => void;
}

/** Run Claude once and resolve with its structured output; streams each tool call as a step. */
export async function runStructuredClaude(run: StructuredRun): Promise<unknown> {
  const { executable, shell } = await run.resolve();
  if (run.stopped()) throw new Error('Stopped.');
  const args = ['-p', '--output-format', 'stream-json', '--verbose', '--no-session-persistence', '--json-schema', JSON.stringify(run.schema), ...run.args];
  const [command, commandArgs] = shell === undefined ? [executable, args] : [shell, ['-l', '-i', '-c', '"$0" "$@"', executable, ...args]];
  const child = (run.spawn ?? spawnProcess)(command, commandArgs, { cwd: run.cwd, stdio: ['pipe', 'pipe', 'pipe'], detached: true, ...run.env === undefined ? {} : { env: { ...process.env, ...run.env } } });
  run.onChild(child);
  child.stdin?.end(run.prompt);
  let stderr = '';
  child.stderr?.on('data', (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-2000); });
  let output: unknown;
  let error: string | undefined;
  const steps = new StepLog(run.cwd);
  createInterface({ input: child.stdout! }).on('line', (line) => {
    const message = parseLine(line);
    if (message !== undefined) run.onMessage?.(message);
    if (message !== undefined && steps.read(message)) run.onProgress({ steps: steps.steps, startedAt: run.startedAt });
    if (message?.type === 'assistant') {
      for (const block of contentBlocks(message)) {
        if (block.type === 'tool_use' && typeof block.name === 'string') {
          const step = describeTool(block.name, block.input, run.cwd);
          run.log(`→ ${step}`);
          run.onStep(step);
        } else if (block.type === 'thinking') run.onStep('Thinking');
      }
    }
    if (message?.type === 'result') {
      if (message.is_error === true) error = typeof message.result === 'string' ? message.result.slice(0, 200) : 'Claude reported an error.';
      // A turn started by a background task's notification ends with a result that has no structured output; it must not clear the report.
      else if (message.structured_output !== undefined) output = message.structured_output;
    }
  });
  const code = await new Promise<number | null>((resolveExit, rejectExit) => {
    child.once('error', rejectExit);
    child.once('close', resolveExit);
  });
  run.onChild(undefined);
  if (run.stopped()) throw new Error('Stopped.');
  if (error !== undefined) throw new Error(error);
  if (output === undefined) {
    const reason = stderr.trim().split('\n').at(-1);
    throw new Error(code === 0 ? run.missing : `Claude exited with code ${code ?? 'unknown'}${reason ? `: ${reason.slice(0, 200)}` : ''}`);
  }
  return output;
}
