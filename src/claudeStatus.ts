import * as vscode from 'vscode';
import type { ClaudeActivity } from './claudeRunner.js';

/** What a PR's Claude is doing, in a few words. */
export interface ClaudeStatus {
  readonly text: string;
  readonly icon: string;
  /** Clicking should send waiting comments again instead of only showing the log. */
  readonly retry: boolean;
}

/** "Building guide" or "Reviewing" while a guide build or code review runs, for the sidebar. */
export function backgroundStatus(guide: boolean, review: boolean): string | undefined {
  return [guide ? 'Building guide' : undefined, review ? 'Reviewing' : undefined].filter(Boolean).join(' · ') || undefined;
}

/** The orb in the agent's color: the icon of a sidebar row or review page tab while Claude works there. */
export const workingIcon = new vscode.ThemeIcon('diffguide-orb', new vscode.ThemeColor('diffGuide.agent'));

/** Summarize a PR's background Claude for the sidebar and status bar. */
export function claudeStatus(activity: ClaudeActivity): ClaudeStatus {
  if (activity.running) return { text: `Claude · ${activity.step ?? 'Working'}`, icon: 'sync~spin', retry: false };
  if (activity.stopped === true) return { text: 'Claude stopped', icon: 'debug-stop', retry: activity.skipped > 0 };
  if (activity.error !== undefined) return { text: 'Claude failed', icon: 'error', retry: true };
  if (activity.skipped > 0) return { text: `Claude skipped ${activity.skipped}`, icon: 'warning', retry: true };
  return { text: 'Claude idle', icon: 'comment-discussion', retry: false };
}
