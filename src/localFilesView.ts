import * as vscode from 'vscode';
import { workingIcon } from './claudeStatus.js';
import type { ReviewThread } from './contracts.js';
import { checkoutLabel, groupByRepository, type LocalCheckout, matchesFilter } from './localCheckouts.js';
import { gitPaths, listRepositoryFiles } from './localReview.js';

type Node =
  | { readonly kind: 'repository'; readonly repository: string; readonly name: string; readonly checkouts: readonly LocalCheckout[] }
  | { readonly kind: 'checkout'; readonly checkout: LocalCheckout };

const checkoutIcons: Record<LocalCheckout['kind'], string> = { folder: 'repo', worktree: 'git-branch', pr: 'git-pull-request' };
const checkoutNotes: Record<LocalCheckout['kind'], string> = { folder: '', worktree: 'worktree', pr: 'PR' };

/** Files with uncommitted changes in `root`, new files included; every file when the branch has no commit yet. */
async function countChangedFiles(root: string): Promise<number> {
  const [changed, untracked] = await Promise.all([
    gitPaths(root, ['diff', '--name-only', 'HEAD']).catch(() => listRepositoryFiles(root)),
    gitPaths(root, ['ls-files', '--others', '--exclude-standard']),
  ]);
  return new Set([...changed, ...untracked]).size;
}

/**
 * The Local view: every checkout under its repository, with how many files changed and how many comments are open.
 * With one checkout it is the only row. Clicking a checkout opens its review page, which lists its files.
 */
export class LocalFilesView implements vscode.TreeDataProvider<Node>, vscode.Disposable {
  readonly #changed = new vscode.EventEmitter<Node | undefined>();
  readonly onDidChangeTreeData = this.#changed.event;
  #checkouts: Promise<readonly LocalCheckout[]> | undefined;
  readonly #counts = new Map<string, Promise<number>>();
  #filter = '';

  constructor(
    private readonly listCheckouts: () => Promise<readonly LocalCheckout[]>,
    /** A checkout's threads, or none while its review has not started. */
    private readonly threads: (checkout: LocalCheckout) => Promise<readonly ReviewThread[]>,
    /** What runs in the background for a checkout, such as "Reviewing", or undefined. */
    private readonly busy: (checkout: LocalCheckout) => Promise<string | undefined> = async () => undefined,
  ) {}

  /** List the checkouts and count their changes again, after files or worktrees changed. */
  reload(): void {
    this.#checkouts = undefined;
    this.#counts.clear();
    this.#changed.fire(undefined);
  }

  /** Count changed files again, after an edit or a commit. */
  recount(): void {
    this.#counts.clear();
    this.#changed.fire(undefined);
  }

  /** Show only checkouts whose repository, branch or PR matches `filter`; empty shows all. */
  setFilter(filter: string): void {
    this.#filter = filter.trim();
    this.#changed.fire(undefined);
  }

  get filter(): string {
    return this.#filter;
  }

  /** Redraw comment counts without listing the checkouts again. */
  redraw(): void {
    this.#changed.fire(undefined);
  }

  /** The checkouts last listed. */
  checkouts(): Promise<readonly LocalCheckout[]> {
    this.#checkouts ??= this.listCheckouts().catch(() => []);
    return this.#checkouts;
  }

  #count(checkout: LocalCheckout): Promise<number> {
    let count = this.#counts.get(checkout.root);
    if (count === undefined) {
      count = countChangedFiles(checkout.root).catch(() => 0);
      this.#counts.set(checkout.root, count);
    }
    return count;
  }

  async getChildren(node?: Node): Promise<Node[]> {
    if (node !== undefined) return node.kind === 'repository' ? node.checkouts.map((checkout): Node => ({ kind: 'checkout', checkout })) : [];
    const all = await this.checkouts();
    const [only] = all;
    if (all.length === 1 && only !== undefined && this.#filter === '') return [{ kind: 'checkout', checkout: only }];
    return groupByRepository(all.filter((checkout) => matchesFilter(checkout, this.#filter)))
      .map(({ repository, name, checkouts }): Node => ({ kind: 'repository', repository, name, checkouts }));
  }

  async getTreeItem(node: Node): Promise<vscode.TreeItem> {
    if (node.kind === 'repository') {
      // A filter opens every matching repository; its own id keeps VS Code from reusing the closed state.
      const filtering = this.#filter !== '';
      const item = new vscode.TreeItem(node.name, filtering ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed);
      item.id = `repository:${node.repository}${filtering ? ':filtered' : ''}`;
      item.iconPath = new vscode.ThemeIcon('diffguide-repository', new vscode.ThemeColor('charts.purple'));
      item.description = String(node.checkouts.length);
      item.tooltip = node.repository;
      return item;
    }
    const { checkout } = node;
    const [changed, threads, busy] = await Promise.all([this.#count(checkout), this.threads(checkout), this.busy(checkout).catch(() => undefined)]);
    const open = threads.filter((thread) => !thread.resolved).length;
    const item = new vscode.TreeItem(checkoutLabel(checkout), vscode.TreeItemCollapsibleState.None);
    item.id = `checkout:${checkout.root}`;
    const working = busy !== undefined || threads.some((thread) => !thread.resolved && (thread.status === 'received' || thread.status === 'working'));
    item.iconPath = working ? workingIcon : new vscode.ThemeIcon(checkoutIcons[checkout.kind]);
    item.description = [checkoutNotes[checkout.kind], changed > 0 ? `${changed} changed` : '', open === 0 ? '' : open === 1 ? '1 comment' : `${open} comments`, busy].filter(Boolean).join(' · ');
    item.tooltip = checkout.root;
    item.contextValue = 'diffGuide.checkout';
    item.command = { command: 'diffGuide.openLocalReview', title: 'Review local changes', arguments: [node] };
    return item;
  }

  dispose(): void {
    this.#changed.dispose();
  }
}
