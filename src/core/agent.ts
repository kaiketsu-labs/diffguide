
/** What a PR's background Claude is doing right now. */
export interface ClaudeActivity {
  readonly running: boolean;
  /** Current step in a few words, such as "Reading src/app.ts". */
  readonly step?: string;
  /** The current run's latest steps, while it runs. */
  readonly progress?: ClaudeProgress;
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
export interface ClaudeContext {
  readonly tokens: number;
  /** The model's window, when Claude reported it. */
  readonly window?: number;
}

/** One step of a Claude run, shown like a Claude Code transcript line: `verb(target)`, then `detail`. */
export interface ClaudeStep {
  readonly verb: string;
  readonly target?: string;
  /** Claude's sentence before the step while it runs; once done, its exact result, such as "Read 120 lines". */
  readonly detail?: string;
  readonly done: boolean;
  readonly failed?: boolean;
}

/** A run's latest steps, oldest first, and when the run started in epoch milliseconds. */
export interface ClaudeProgress {
  readonly steps: readonly ClaudeStep[];
  readonly startedAt: number;
}

/** How a task ended: an error message, or Claude's last message on success. */
export interface ClaudeTaskResult {
  readonly error?: string;
  readonly reply?: string;
}

/** A one-off job for a PR's Claude conversation, outside the comment queue, such as fixing merge conflicts. */
export interface ClaudeTask {
  /** What the log calls the run, such as "fixing merge conflicts". */
  readonly label: string;
  readonly prompt: string;
  /** Tools Claude may use without asking, beyond DiffGuide's own. */
  readonly allowedTools: readonly string[];
}

/** How to start this PR's Claude conversation interactively, such as in a terminal. */
export interface ClaudeLaunch {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
}

/** Minimal, local metadata shown only after the human asks to choose a conversation. */
export interface ClaudeConversation {
  readonly id: string;
  readonly title: string;
  readonly modifiedAt: number;
  readonly branch: string;
  readonly running: boolean;
}
