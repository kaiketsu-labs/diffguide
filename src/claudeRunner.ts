import { spawn as spawnProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { join, relative } from 'node:path';
import { createInterface } from 'node:readline';
import * as vscode from 'vscode';
import type { ReviewEvent, ReviewStore } from './contracts.js';
import { buildReviewBatchPrompt } from './eventPrompt.js';
import { readPrivateJson, writePrivateJson } from './privateFiles.js';
import type { PullRequestRole } from './worktrees.js';

/** What a PR's background Claude is doing right now. */
export interface ClaudeActivity {
  readonly running: boolean;
  /** Current step in a few words, such as "Reading src/app.ts". */
  readonly step?: string;
  /** Label of the task running instead of comments, such as "fixing merge conflicts". */
  readonly task?: string;
  /** Threads whose comments the current or last run handles. */
  readonly threads: ReadonlySet<string>;
  readonly error?: string;
  /** Comments sent to Claude that it did not pick up; they wait for a retry. */
  readonly skipped: number;
}

/** A one-off job for a PR's Claude conversation, outside the comment queue, such as fixing merge conflicts. */
export interface ClaudeTask {
  /** What the log calls the run, such as "fixing merge conflicts". */
  readonly label: string;
  readonly prompt: string;
  /** Tools Claude may use without asking, beyond Pair Review's own. */
  readonly allowedTools: readonly string[];
}

/** How to start Claude for one PR worktree. */
export interface ClaudeRunnerOptions {
  readonly store: ReviewStore;
  readonly cwd: string;
  readonly dataPath: string;
  readonly role: PullRequestRole;
  /** Claude command and MCP config; with `shell`, Claude starts through the user's login shell so their own `claude` setup applies. */
  readonly resolve: () => Promise<{ readonly executable: string; readonly mcpPath: string; readonly shell?: string }>;
  readonly log: (line: string) => void;
  readonly spawn?: typeof spawnProcess;
  /** The user's own instructions for answering comments, read fresh for each run. */
  readonly instructions?: () => Promise<string>;
}

const reviewerNote = 'This is someone else\'s pull request. You cannot edit files or run commands. For implement requests, reply with the proposed change as a diff code block instead.';
const reviewerBlockedTools = ['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Bash'];
/** On someone else's PR the checkout is the author's: skip its CLAUDE.md, skills, hooks, settings and MCP servers. */
export const untrustedCheckoutFlags = ['--setting-sources', 'user', '--strict-mcp-config'];

/** One resumable background Claude conversation per PR that answers comments as they are sent. */
export class ClaudeRunner implements vscode.Disposable {
  readonly #changed = new vscode.EventEmitter<void>();
  readonly onDidChange = this.#changed.event;
  readonly #subscription: { dispose(): void };
  readonly #sent = new Set<string>();
  #activity: ClaudeActivity = { running: false, threads: new Set(), skipped: 0 };
  #child: ReturnType<typeof spawnProcess> | undefined;
  #disposed = false;

  constructor(private readonly options: ClaudeRunnerOptions) {
    this.#subscription = options.store.onChange(() => { this.#next(); });
    this.#next();
  }

  get activity(): ClaudeActivity {
    return this.#activity;
  }

  /**
   * Run a task in this PR's conversation; resolves with an error message, or undefined on success.
   * On someone else's PR, Git hooks stay off, since the PR's author controls the checkout.
   */
  async runTask(task: ClaudeTask): Promise<string | undefined> {
    if (this.#disposed || this.#child !== undefined || this.#activity.running) throw new Error('Claude is still working on this PR. Try again when it is done.');
    this.#set({ running: true, step: 'Starting', task: task.label, threads: new Set(), skipped: 0, error: undefined });
    let error: string | undefined;
    try {
      error = await this.#spawn({
        prompt: task.prompt, label: task.label, allowedTools: task.allowedTools, edits: true,
        env: this.options.role === 'reviewer' ? { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.hooksPath', GIT_CONFIG_VALUE_0: '/dev/null' } : {},
      });
    } catch (failure: unknown) {
      error = failure instanceof Error ? failure.message : String(failure);
    }
    if (error !== undefined) this.options.log(`Failed: ${error}`);
    this.#child = undefined;
    this.#set({ running: false, step: undefined, task: undefined, threads: new Set(), skipped: 0, error });
    this.#next();
    return error;
  }

  /** Send comments Claude did not pick up again, and clear the last error. */
  retry(): void {
    this.#sent.clear();
    this.#set({ ...this.#activity, skipped: 0, error: undefined });
    this.#next();
  }

  dispose(): void {
    this.#disposed = true;
    this.#subscription.dispose();
    this.#child?.kill('SIGTERM');
    this.#changed.dispose();
  }

  #set(activity: { [K in keyof ClaudeActivity]: ClaudeActivity[K] | undefined }): void {
    const { step, task, error, ...rest } = activity;
    this.#activity = { ...rest, ...(step === undefined ? {} : { step }), ...(task === undefined ? {} : { task }), ...(error === undefined ? {} : { error }) } as ClaudeActivity;
    if (!this.#disposed) this.#changed.fire();
  }

  #next(): void {
    if (this.#disposed || this.#child !== undefined || this.#activity.running) return;
    const pending = this.options.store.pendingEvents;
    const fresh = pending.filter((event) => !this.#sent.has(event.id));
    const skipped = pending.length - fresh.length;
    if (fresh.length === 0) {
      if (skipped !== this.#activity.skipped) this.#set({ ...this.#activity, skipped });
      return;
    }
    void this.#run(fresh);
  }

  async #run(events: readonly ReviewEvent[]): Promise<void> {
    for (const event of events) this.#sent.add(event.id);
    const threads = new Set(events.map((event) => event.threadId));
    this.#set({ running: true, step: 'Starting', threads, skipped: 0, error: undefined });
    let error: string | undefined;
    try {
      const prompt = buildReviewBatchPrompt(events, this.options.store.threads, await this.options.instructions?.() ?? '');
      error = await this.#spawn({
        prompt: this.options.role === 'reviewer' ? `${reviewerNote}\n\n${prompt}` : prompt,
        label: `${events.length} comment${events.length === 1 ? '' : 's'}`, allowedTools: [], edits: this.options.role === 'author', env: {},
      });
    } catch (failure: unknown) {
      error = failure instanceof Error ? failure.message : String(failure);
    }
    if (error !== undefined) this.options.log(`Failed: ${error}`);
    this.#child = undefined;
    this.#set({ running: false, step: undefined, threads, skipped: 0, error });
    this.#next();
  }

  /**
   * Run Claude once in the PR's conversation; resolves with an error message, or undefined on success.
   * `edits` lets Claude change files; without it, edits and commands are blocked.
   */
  async #spawn(run: { readonly prompt: string; readonly label: string; readonly allowedTools: readonly string[]; readonly edits: boolean; readonly env: Readonly<Record<string, string>> }): Promise<string | undefined> {
    const { executable, mcpPath, shell } = await this.options.resolve();
    const sessionPath = join(this.options.dataPath, 'claude-session.json');
    const saved = await readPrivateJson(sessionPath).catch(() => undefined) as { sessionId?: unknown } | undefined;
    const resume = typeof saved?.sessionId === 'string' && /^[\da-f-]{36}$/u.test(saved.sessionId) ? saved.sessionId : undefined;
    const sessionId = resume ?? randomUUID();
    const args = [
      '-p', run.prompt, '--output-format', 'stream-json', '--verbose', '--mcp-config', mcpPath, '--allowedTools', 'mcp__pair-review', ...run.allowedTools,
      ...(this.options.role === 'reviewer' ? untrustedCheckoutFlags : []),
      ...(run.edits ? ['--permission-mode', 'acceptEdits'] : ['--disallowedTools', ...reviewerBlockedTools]),
      ...(resume === undefined ? ['--session-id', sessionId] : ['--resume', sessionId]),
    ];
    this.options.log(`Starting Claude for ${run.label} (${resume === undefined ? 'new' : 'resumed'} conversation ${sessionId})`);
    const [command, commandArgs] = shell === undefined ? [executable, args] : [shell, ['-l', '-i', '-c', '"$0" "$@"', executable, ...args]];
    const child = (this.options.spawn ?? spawnProcess)(command, commandArgs, { cwd: this.options.cwd, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...run.env } });
    this.#child = child;
    let stderr = '';
    child.stderr?.on('data', (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-2000); });
    let result: string | undefined | null = null;
    let saving: Promise<void> = Promise.resolve();
    const lines = createInterface({ input: child.stdout! });
    lines.on('line', (line) => {
      const message = parseLine(line);
      if (message === undefined) return;
      if (message.type === 'assistant') {
        for (const block of contentBlocks(message)) {
          if (block.type === 'tool_use' && typeof block.name === 'string') {
            const step = describeTool(block.name, block.input, this.options.cwd);
            this.options.log(`→ ${step}`);
            this.#set({ ...this.#activity, step });
          } else if (block.type === 'thinking') {
            this.#set({ ...this.#activity, step: 'Thinking' });
          } else if (block.type === 'text' && typeof block.text === 'string' && block.text.trim() !== '') {
            this.options.log(block.text.trim());
            this.#set({ ...this.#activity, step: 'Writing' });
          }
        }
      }
      if (message.type === 'result') {
        result = message.is_error === true ? clean(typeof message.result === 'string' ? message.result : 'Claude reported an error.', 200) : undefined;
        if (result === undefined && resume === undefined) saving = writePrivateJson(sessionPath, { sessionId });
      }
    });
    const code = await new Promise<number | null>((resolveExit, rejectExit) => {
      child.once('error', rejectExit);
      child.once('close', resolveExit);
    });
    await saving;
    const reason = stderr.trim().split('\n').at(-1);
    const error = result !== null ? result : code === 0 ? undefined
      : `Claude exited with code ${code ?? 'unknown'}${reason ? `: ${clean(reason, 200)}` : ''}`;
    if (resume !== undefined && /no conversation found/iu.test(`${error ?? ''} ${stderr}`)) {
      await writePrivateJson(sessionPath, {});
      return 'The earlier Claude conversation was not found. Retry to start a new one.';
    }
    return error;
  }
}

export type StreamMessage = Record<string, unknown>;

/** Parse one stream-json line; Claude output is untrusted, so anything unexpected is skipped. */
export function parseLine(line: string): StreamMessage | undefined {
  try {
    const value: unknown = JSON.parse(line);
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as StreamMessage : undefined;
  } catch {
    return undefined;
  }
}

export function contentBlocks(message: StreamMessage): readonly Record<string, unknown>[] {
  const inner = message.message;
  const content = typeof inner === 'object' && inner !== null ? (inner as Record<string, unknown>).content : undefined;
  return Array.isArray(content) ? content.filter((block): block is Record<string, unknown> => typeof block === 'object' && block !== null) : [];
}

/** Strip control characters and cap length before showing model-provided text in labels. */
function clean(value: string, maximum = 80): string {
  const single = value.replace(/[\u0000-\u001f\u007f]+/gu, ' ').trim();
  return single.length > maximum ? `${single.slice(0, maximum - 1)}…` : single;
}

const reviewTools: Record<string, string> = {
  acknowledge_review: 'Picked up the comment',
  set_review_working: 'Working on it',
  reply_to_review: 'Writing the reply',
  list_pending_reviews: 'Checking open comments',
};

/** Describe a tool call as a short step, such as "Reading src/app.ts". */
export function describeTool(name: string, input: unknown, cwd: string): string {
  const fields = typeof input === 'object' && input !== null ? input as Record<string, unknown> : {};
  const text = (key: string): string | undefined => typeof fields[key] === 'string' ? fields[key] : undefined;
  const file = (key: string): string => {
    const value = text(key);
    if (value === undefined) return 'a file';
    const inside = relative(cwd, value);
    return clean(inside === '' || inside.startsWith('..') ? value : inside);
  };
  const review = name.startsWith('mcp__pair-review__') ? reviewTools[name.slice('mcp__pair-review__'.length)] : undefined;
  if (review !== undefined) return review;
  switch (name) {
    case 'Read': return `Reading ${file('file_path')}`;
    case 'Edit': case 'MultiEdit': case 'Write': return `Editing ${file('file_path')}`;
    case 'Grep': return `Searching for ${clean(JSON.stringify(text('pattern') ?? ''), 60)}`;
    case 'Glob': return `Looking for ${clean(text('pattern') ?? 'files', 60)}`;
    case 'Bash': return `Running ${clean(text('description') ?? text('command') ?? 'a command', 60)}`;
    case 'WebFetch': case 'WebSearch': return 'Searching the web';
    case 'Task': case 'Agent': return 'Delegating to a subagent';
    case 'TodoWrite': return 'Planning';
    default: return `Using ${clean(name, 40)}`;
  }
}
