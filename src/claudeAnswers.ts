import * as path from 'node:path';
import * as vscode from 'vscode';
import { record } from './connection.js';
import type { ReviewThread } from './contracts.js';
import { ago } from './pullRequestView.js';

/** Claude's latest reply in one local thread of a PR. */
export interface ClaudeAnswer {
  /** `owner/name#number`. */
  readonly pullRequest: string;
  readonly number: number;
  readonly threadId: string;
  readonly title: string;
  /** Empty for a thread about the whole PR. */
  readonly path: string;
  readonly line: number;
  readonly createdAt: string;
  readonly text: string;
}

/** One PR's threads, as the answers list reads them. */
export interface AnsweredPullRequest {
  readonly key: string;
  readonly number: number;
  readonly threads: readonly ReviewThread[];
}

/** The latest Claude reply of every unresolved, unarchived thread where Claude spoke last, newest first. */
export function latestAnswers(pullRequests: readonly AnsweredPullRequest[], limit = 50): ClaudeAnswer[] {
  return pullRequests.flatMap(({ key, number, threads }) => threads.flatMap((thread): ClaudeAnswer[] => {
    const last = thread.messages.at(-1);
    if (thread.resolved || thread.archived === true || thread.origin !== undefined || last?.author !== 'claude') return [];
    const asked = thread.messages[0]?.text.replaceAll(/\s+/gu, ' ').trim() ?? '';
    return [{
      pullRequest: key, number, threadId: thread.id, title: thread.title ?? asked.slice(0, 80),
      path: thread.anchor.path, line: thread.anchor.startLine, createdAt: last.createdAt, text: last.text,
    }];
  })).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, limit);
}

/** Which Claude answers the user has seen on a review page, by thread id and answer time; kept per workspace. */
export class SeenAnswers implements vscode.Disposable {
  static readonly key = 'diffGuide.seenAnswers';
  readonly #changed = new vscode.EventEmitter<void>();
  readonly onDidChange = this.#changed.event;

  constructor(private readonly memento: vscode.Memento, now = new Date()) {
    // Answers from before the first use count as seen, so the list does not start full.
    if (this.#stored().since === undefined) void memento.update(SeenAnswers.key, { since: now.toISOString(), seen: {} });
  }

  isNew(answer: Pick<ClaudeAnswer, 'threadId' | 'createdAt'>): boolean {
    const { since = '', seen } = this.#stored();
    return answer.createdAt > (seen[answer.threadId] ?? since);
  }

  /** Mark these answers seen, and forget marks older than a month. */
  async see(answers: readonly Pick<ClaudeAnswer, 'threadId' | 'createdAt'>[], now = Date.now()): Promise<void> {
    const fresh = answers.filter((answer) => this.isNew(answer));
    if (fresh.length === 0) return;
    const { since, seen } = this.#stored();
    const cutoff = new Date(now - 30 * 24 * 3_600_000).toISOString();
    const kept = Object.fromEntries(Object.entries(seen).filter(([, at]) => at > cutoff));
    for (const answer of fresh) kept[answer.threadId] = answer.createdAt;
    await this.memento.update(SeenAnswers.key, { since: since !== undefined && since > cutoff ? since : cutoff, seen: kept });
    this.#changed.fire();
  }

  dispose(): void {
    this.#changed.dispose();
  }

  #stored(): { readonly since?: string; readonly seen: Record<string, string> } {
    const value = this.memento.get<unknown>(SeenAnswers.key);
    const stored = record(value) ?? {};
    const seen = typeof stored['seen'] === 'object' && stored['seen'] !== null ? stored['seen'] as Record<string, unknown> : {};
    return {
      ...(typeof stored['since'] === 'string' ? { since: stored['since'] } : {}),
      seen: Object.fromEntries(Object.entries(seen).filter((entry): entry is [string, string] => typeof entry[1] === 'string')),
    };
  }
}

/** The sidebar list of Claude's latest answers across open PRs; a row opens its thread on the PR's review page. */
export class ClaudeAnswersTree implements vscode.TreeDataProvider<ClaudeAnswer>, vscode.Disposable {
  readonly #changed = new vscode.EventEmitter<undefined>();
  readonly onDidChangeTreeData = this.#changed.event;

  constructor(private readonly answers: () => readonly ClaudeAnswer[], private readonly seen: SeenAnswers) {}

  refresh(): void {
    this.#changed.fire(undefined);
  }

  getChildren(answer?: ClaudeAnswer): ClaudeAnswer[] {
    return answer === undefined ? [...this.answers()] : [];
  }

  getTreeItem(answer: ClaudeAnswer): vscode.TreeItem {
    const fresh = this.seen.isNew(answer);
    const item = new vscode.TreeItem(fresh ? { label: answer.title, highlights: [[0, answer.title.length]] } : answer.title, vscode.TreeItemCollapsibleState.None);
    item.id = `answer:${answer.threadId}`;
    item.description = `#${answer.number} · ${answer.path === '' ? 'Conversation' : `${path.posix.basename(answer.path)}:${answer.line}`} · ${ago(answer.createdAt)}`;
    item.iconPath = new vscode.ThemeIcon(fresh ? 'circle-filled' : 'comment', new vscode.ThemeColor(fresh ? 'charts.orange' : 'descriptionForeground'));
    item.tooltip = new vscode.MarkdownString().appendText(`${answer.pullRequest} · ${answer.path === '' ? 'Conversation' : `${answer.path}:${answer.line}`}${fresh ? ' · New' : ''}\n\n`).appendMarkdown(answer.text.slice(0, 1500));
    item.command = { command: 'diffGuide.openAnswer', title: 'Open answer', arguments: [answer.pullRequest, answer.threadId] };
    return item;
  }

  dispose(): void {
    this.#changed.dispose();
  }
}
