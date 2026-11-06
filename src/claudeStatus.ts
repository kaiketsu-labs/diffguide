import type { ClaudeActivity } from './claudeRunner.js';

/** What a PR's Claude is doing, in a few words. */
export interface ClaudeStatus {
  readonly text: string;
  readonly icon: string;
  /** Clicking should send waiting comments again instead of only showing the log. */
  readonly retry: boolean;
}

/** Summarize a PR's background Claude for the sidebar and status bar. */
export function claudeStatus(activity: ClaudeActivity): ClaudeStatus {
  if (activity.running) return { text: `Claude · ${activity.step ?? 'Working'}`, icon: 'sync~spin', retry: false };
  if (activity.stopped === true) return { text: 'Claude stopped', icon: 'debug-stop', retry: activity.skipped > 0 };
  if (activity.error !== undefined) return { text: 'Claude failed', icon: 'error', retry: true };
  if (activity.skipped > 0) return { text: `Claude skipped ${activity.skipped}`, icon: 'warning', retry: true };
  return { text: 'Claude idle', icon: 'comment-discussion', retry: false };
}
