/** What DiffGuide needs from a coding agent. `agents/claude` implements it for Claude Code; hosts construct the implementation and pass these interfaces on. */
import type { CodeAnchor, Reviewer } from './contracts.js';
import type { Disposable, Event } from './events.js';
import type { Analysis, ChangeBlock } from './prAnalysis.js';
import type { CodeReviewResult, ReviewLive } from './review.js';
import type { FileDiff } from './unifiedDiff.js';

/** What the analysis run is doing right now. */
export interface AnalysisActivity {
  readonly running: boolean;
  readonly step?: string;
  readonly progress?: AgentProgress;
  readonly error?: string;
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

/** What the code review is doing right now; a failed run keeps its last live state. */
export interface CodeReviewActivity {
  readonly running: boolean;
  readonly live?: ReviewLive;
  readonly error?: string;
}

/** What one review covers. */
export interface CodeReviewInput {
  readonly files: readonly FileDiff[];
  /** What is under review, for the prompt. */
  readonly about: string;
  readonly reviewers: readonly Reviewer[];
  /** Anchor for a finding's lines on the new side. */
  readonly anchor: (range: { readonly path: string; readonly side: 'new'; readonly startLine: number; readonly endLine: number }) => Promise<CodeAnchor>;
}
/** What a PR's background Claude is doing right now. */
export interface AgentActivity {
  readonly running: boolean;
  /** Current step in a few words, such as "Reading src/app.ts". */
  readonly step?: string;
  /** The current run's latest steps, while it runs. */
  readonly progress?: AgentProgress;
  /** Label of the task running instead of comments, such as "fixing merge conflicts". */
  readonly task?: string;
  /** Threads whose comments the current or last run handles. */
  readonly threads: ReadonlySet<string>;
  readonly error?: string;
  /** Comments sent to Claude that it did not pick up; they wait for a retry. */
  readonly skipped: number;
  /** The last run ended because the user stopped it. */
  readonly stopped?: true;
}

/** How much of Claude's context window this PR's conversation fills, after its latest run. */
export interface AgentContext {
  readonly tokens: number;
  /** The model's window, when Claude reported it. */
  readonly window?: number;
}

/** One step of a Claude run, shown like a Claude Code transcript line: `verb(target)`, then `detail`. */
export interface AgentStep {
  readonly verb: string;
  readonly target?: string;
  /** Claude's sentence before the step while it runs; once done, its exact result, such as "Read 120 lines". */
  readonly detail?: string;
  readonly done: boolean;
  readonly failed?: boolean;
}

/** A run's latest steps, oldest first, and when the run started in epoch milliseconds. */
export interface AgentProgress {
  readonly steps: readonly AgentStep[];
  readonly startedAt: number;
}

/** How a task ended: an error message, or Claude's last message on success. */
export interface AgentTaskResult {
  readonly error?: string;
  readonly reply?: string;
}

/** A one-off job for a PR's Claude conversation, outside the comment queue, such as fixing merge conflicts. */
export interface AgentTask {
  /** What the log calls the run, such as "fixing merge conflicts". */
  readonly label: string;
  readonly prompt: string;
  /** Tools Claude may use without asking, beyond DiffGuide's own. */
  readonly allowedTools: readonly string[];
}

/** How to start this PR's Claude conversation interactively, such as in a terminal. */
export interface AgentLaunch {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
}

/** Minimal, local metadata shown only after the human asks to choose a conversation. */
export interface AgentConversation {
  readonly id: string;
  readonly title: string;
  readonly modifiedAt: number;
  readonly branch: string;
  readonly running: boolean;
}

/** What a PR's Claude is doing, in a few words. */
export interface AgentStatus {
  readonly text: string;
  readonly icon: string;
  /** Clicking should send waiting comments again instead of only showing the log. */
  readonly retry: boolean;
}

/** "Building guide" or "Reviewing" while a guide build or code review runs, for the sidebar. */
export function backgroundStatus(guide: boolean, review: boolean): string | undefined {
  return [guide ? 'Building guide' : undefined, review ? 'Reviewing' : undefined].filter(Boolean).join(' · ') || undefined;
}

/** Summarize a PR's background Claude for the sidebar and status bar. */
export function agentStatus(activity: AgentActivity): AgentStatus {
  if (activity.running) return { text: `Claude · ${activity.step ?? 'Working'}`, icon: 'sync~spin', retry: false };
  if (activity.stopped === true) return { text: 'Claude stopped', icon: 'debug-stop', retry: activity.skipped > 0 };
  if (activity.error !== undefined) return { text: 'Claude failed', icon: 'error', retry: true };
  if (activity.skipped > 0) return { text: `Claude skipped ${activity.skipped}`, icon: 'warning', retry: true };
  return { text: 'Claude idle', icon: 'comment-discussion', retry: false };
}

/** How the review page connects Claude: show its terminal, start or resume a conversation there, prepare a running one, or copy a start command. */
export type AgentChoice = { readonly how: 'show' | 'new' | 'running' | 'copy' } | { readonly how: 'resume'; readonly session?: string };

/** The agent working in one checkout: it answers review comments, runs tasks, and keeps one conversation. */
export interface AgentRunner extends Disposable {
  readonly onDidChange: Event<void>;
  readonly activity: AgentActivity;
  /** How full the conversation's context window is, when known. */
  context(): Promise<AgentContext | undefined>;
  /** Start the next run in a new conversation. */
  forget(): Promise<void>;
  compact(): Promise<void>;
  runTask(task: AgentTask): Promise<AgentTaskResult>;
  /** The command that opens this conversation in a terminal. */
  launch(): Promise<AgentLaunch>;
  /** Send comments the last run skipped again. */
  retry(): void;
  /** Show `step` while the runner waits for something outside it. */
  wait(step: string): void;
  stop(): Promise<void>;
}

/** The agent's code review of a change, by the reviewers the user picked. */
export interface AgentCodeReview extends Disposable {
  readonly onDidChange: Event<void>;
  readonly activity: CodeReviewActivity;
  result(): Promise<CodeReviewResult | undefined>;
  start(input: CodeReviewInput): void;
  stop(): void;
}

/** The agent's guide through a change: its blocks in reading order, with notes. */
export interface AgentGuideAnalysis extends Disposable {
  readonly onDidChange: Event<void>;
  readonly activity: AnalysisActivity;
  result(): Promise<Analysis | undefined>;
  start(input: AnalysisInput): void;
  stop(): void;
}
