import * as vscode from 'vscode';
import * as path from 'node:path';
import type { PullRequestFile, PullRequestProvider, PullRequestRepository, PullRequestSummary, ReviewVerdict } from './pullRequests.js';
import type { PullRequestRole } from './worktrees.js';

type Listing =
  | { readonly kind: 'ready'; readonly provider: PullRequestProvider; readonly worktrees: PullRequestWorktrees; readonly repository: PullRequestRepository; readonly mine: readonly PullRequestSummary[]; readonly reviewRequested: readonly PullRequestSummary[] }
  | { readonly kind: 'failed'; readonly folder: string; readonly message: string };

type Ready = Extract<Listing, { kind: 'ready' }>;

type PullRequestNode = { readonly kind: 'pullRequest'; readonly listing: Ready; readonly role: PullRequestRole; readonly pullRequest: PullRequestSummary };

type Node =
  | { readonly kind: 'repository'; readonly listing: Ready; readonly expanded: boolean }
  | { readonly kind: 'section'; readonly listing: Ready; readonly role: PullRequestRole; readonly pullRequests: readonly PullRequestSummary[] }
  | PullRequestNode
  | FileNode
  | FolderNode
  | { readonly kind: 'message'; readonly text: string; readonly icon: string };

type FileNode = { readonly kind: 'file'; readonly parent: PullRequestNode; readonly file: PullRequestFile; readonly inTree: boolean };
type FolderNode = { readonly kind: 'folder'; readonly parent: PullRequestNode; readonly folder: FileFolder };

/** A folder of changed files; `name` spans several path parts when folders hold only one folder each. */
export interface FileFolder {
  readonly name: string;
  readonly path: string;
  readonly folders: readonly FileFolder[];
  readonly files: readonly PullRequestFile[];
}

/** Group changed files by folder like Source Control's tree view, folding single-folder chains into one row. */
export function fileTree(files: readonly PullRequestFile[]): FileFolder {
  type Building = { folders: Map<string, Building>; files: PullRequestFile[] };
  const root: Building = { folders: new Map(), files: [] };
  for (const file of files) {
    let folder = root;
    for (const part of file.path.split('/').slice(0, -1)) {
      let next = folder.folders.get(part);
      if (next === undefined) folder.folders.set(part, next = { folders: new Map(), files: [] });
      folder = next;
    }
    folder.files.push(file);
  }
  const finish = (name: string, path: string, folder: Building): FileFolder => {
    if (folder.files.length === 0 && folder.folders.size === 1) {
      const [[child, only]] = [...folder.folders] as [[string, Building]];
      return finish(`${name}/${child}`, `${path}/${child}`, only);
    }
    return {
      name, path,
      folders: [...folder.folders].sort(([a], [b]) => a.localeCompare(b)).map(([child, next]) => finish(child, path === '' ? child : `${path}/${child}`, next)),
      files: [...folder.files].sort((a, b) => a.path.localeCompare(b.path)),
    };
  };
  return {
    name: '', path: '',
    folders: [...root.folders].sort(([a], [b]) => a.localeCompare(b)).map(([name, folder]) => finish(name, name, folder)),
    files: [...root.files].sort((a, b) => a.path.localeCompare(b.path)),
  };
}

const fileViewKey = 'localReview.fileView';

const fileScheme = 'local-review-pr-file';

/** Source Control letters and colors for each kind of change. */
const changeDecorations: Record<PullRequestFile['change'], { readonly badge: string; readonly color: string; readonly tooltip: string }> = {
  added: { badge: 'A', color: 'gitDecoration.addedResourceForeground', tooltip: 'Added' },
  modified: { badge: 'M', color: 'gitDecoration.modifiedResourceForeground', tooltip: 'Modified' },
  deleted: { badge: 'D', color: 'gitDecoration.deletedResourceForeground', tooltip: 'Deleted' },
  renamed: { badge: 'R', color: 'gitDecoration.renamedResourceForeground', tooltip: 'Renamed' },
};

/** Address for a PR file row, so the icon theme picks its file icon and the decoration its change letter. */
function fileRowUri(number: number, file: PullRequestFile): vscode.Uri {
  return vscode.Uri.from({ scheme: fileScheme, authority: `pr-${number}`, path: `/${file.path}`, query: `change=${file.change}` });
}

/** Color PR file rows and add their change letter, like the Source Control view. */
const changeDecorationProvider: vscode.FileDecorationProvider = {
  provideFileDecoration: (uri) => {
    if (uri.scheme !== fileScheme) return undefined;
    const change = new URLSearchParams(uri.query).get('change');
    const decoration = change !== null && Object.hasOwn(changeDecorations, change) ? changeDecorations[change as PullRequestFile['change']] : undefined;
    return decoration === undefined ? undefined : new vscode.FileDecoration(decoration.badge, decoration.tooltip, new vscode.ThemeColor(decoration.color));
  },
};

/** Worktree operations the sidebar triggers, kept separate so the tree stays testable. */
export interface PullRequestWorktrees {
  exists(repository: string, number: number): Promise<boolean>;
  /** Ensure the PR's worktree and show all its changes in one diff tab, scrolled to `revealPath` when given. */
  open(provider: PullRequestProvider, repository: string, pullRequest: PullRequestSummary, role: PullRequestRole, revealPath?: string): Promise<void>;
  remove(repository: string, number: number): Promise<void>;
  /** Show what the PR's Claude did, and send skipped comments again. */
  showClaude(provider: PullRequestProvider, repository: string, pullRequest: PullRequestSummary, role: PullRequestRole): Promise<void>;
  /** Claude's state for a PR with an open review, shown beside it. */
  claudeStatus(repository: string, number: number): string | undefined;
  /** Files of a checked-out PR ticked here and unchanged since, or marked Viewed on the code host. */
  reviewedFiles(provider: PullRequestProvider, repository: string, number: number, paths: readonly string[]): Promise<ReadonlySet<string>>;
  setReviewed(provider: PullRequestProvider, repository: string, number: number, path: string, reviewed: boolean): Promise<void>;
  /** Open a tab with the PR's review progress, threads and Claude activity. */
  showOverview(provider: PullRequestProvider, repository: string, pullRequest: PullRequestSummary, role: PullRequestRole): Promise<void>;
  /** Drop cached code host state so the next read is fresh. */
  forget(): void;
}

/** A local repository the sidebar lists PRs for. */
export interface PullRequestCheckout {
  /** Folder named when its PRs cannot be listed. */
  readonly folder: string;
  connect(): Promise<PullRequestProvider>;
  readonly worktrees: PullRequestWorktrees;
}

/** Repositories listed at once, so a folder of many repositories does not start dozens of GitHub CLI calls together. */
const parallelListings = 4;

/** Sidebar icon and label for each review verdict. */
const verdicts: Record<ReviewVerdict, { readonly icon: string; readonly color: string; readonly label: string }> = {
  approved: { icon: 'pass', color: 'testing.iconPassed', label: 'Approved' },
  changes: { icon: 'request-changes', color: 'testing.iconFailed', label: 'Changes requested' },
  commented: { icon: 'comment-discussion', color: 'descriptionForeground', label: 'Commented' },
};

const sectionLabels: Record<PullRequestRole, string> = { author: 'Mine', reviewer: 'Review requested' };

/** List each repository's open pull requests by the user's role in them. */
class PullRequestTree implements vscode.TreeDataProvider<Node> {
  readonly #changed = new vscode.EventEmitter<undefined>();
  readonly onDidChangeTreeData = this.#changed.event;
  #listings: Promise<readonly Listing[]> | undefined;
  #listed: readonly PullRequestCheckout[] = [];
  readonly #files = new Map<string, Promise<readonly PullRequestFile[]>>();

  constructor(
    private readonly checkouts: () => Promise<readonly PullRequestCheckout[]>,
    private readonly settings: vscode.Memento,
  ) {}

  get asTree(): boolean {
    return this.settings.get(fileViewKey, 'tree') === 'tree';
  }

  async setAsTree(asTree: boolean): Promise<void> {
    await this.settings.update(fileViewKey, asTree ? 'tree' : 'list');
    this.#changed.fire(undefined);
  }

  refresh(): void {
    this.#listings = undefined;
    this.#files.clear();
    for (const checkout of this.#listed) checkout.worktrees.forget();
    this.#changed.fire(undefined);
  }

  /** Redraw checkout state without querying the code host again. */
  redraw(): void {
    this.#changed.fire(undefined);
  }

  async getChildren(node?: Node): Promise<Node[]> {
    if (node === undefined) {
      this.#listings ??= this.#load();
      const listings = await this.#listings;
      const single = listings.length === 1;
      return listings.map((listing): Node => listing.kind === 'failed'
        ? { kind: 'message', text: single ? listing.message : `${listing.folder}: ${listing.message}`, icon: 'warning' }
        : { kind: 'repository', listing, expanded: single || listing.mine.length + listing.reviewRequested.length > 0 });
    }
    if (node.kind === 'repository') {
      return [
        { kind: 'section', listing: node.listing, role: 'author', pullRequests: node.listing.mine },
        { kind: 'section', listing: node.listing, role: 'reviewer', pullRequests: node.listing.reviewRequested },
      ];
    }
    if (node.kind === 'section') {
      return node.pullRequests.length === 0
        ? [{ kind: 'message', text: 'No open PRs', icon: 'check' }]
        : node.pullRequests.map((pullRequest) => ({ kind: 'pullRequest', listing: node.listing, role: node.role, pullRequest }));
    }
    if (node.kind === 'folder') return this.#folderChildren(node.parent, node.folder);
    if (node.kind === 'pullRequest') {
      try {
        const files = await this.#filesOf(node);
        return files.length === 0
          ? [{ kind: 'message', text: 'No changed files', icon: 'info' }]
          : this.asTree ? this.#folderChildren(node, fileTree(files)) : files.map((file) => ({ kind: 'file', parent: node, file, inTree: false }));
      } catch (error: unknown) {
        return [{ kind: 'message', text: error instanceof Error ? error.message : String(error), icon: 'warning' }];
      }
    }
    return [];
  }

  async getTreeItem(node: Node): Promise<vscode.TreeItem> {
    switch (node.kind) {
      case 'repository': {
        const item = new vscode.TreeItem(node.listing.repository.name, node.expanded ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed);
        item.iconPath = new vscode.ThemeIcon('repo');
        return item;
      }
      case 'section': {
        const item = new vscode.TreeItem(sectionLabels[node.role], vscode.TreeItemCollapsibleState.Expanded);
        item.description = String(node.pullRequests.length);
        return item;
      }
      case 'pullRequest': {
        const pr = node.pullRequest;
        const checkedOut = await node.listing.worktrees.exists(node.listing.repository.name, pr.number);
        const item = new vscode.TreeItem(`#${pr.number} ${pr.title}`, vscode.TreeItemCollapsibleState.Collapsed);
        const claude = checkedOut ? node.listing.worktrees.claudeStatus(node.listing.repository.name, pr.number) : undefined;
        const progress = checkedOut ? await this.#progress(node) : undefined;
        const verdict = pr.review === undefined ? undefined : verdicts[pr.review];
        item.description = [verdict?.label, pr.author, pr.draft ? 'Draft' : undefined, claude ?? (checkedOut ? 'Worktree' : undefined), progress].filter(Boolean).join(' · ');
        item.tooltip = `${pr.title}\n${pr.headBranch} → ${pr.baseBranch}${verdict === undefined ? '' : `\n${verdict.label}`}`;
        item.iconPath = verdict === undefined
          ? new vscode.ThemeIcon(pr.draft ? 'git-pull-request-draft' : 'git-pull-request')
          : new vscode.ThemeIcon(verdict.icon, new vscode.ThemeColor(verdict.color));
        item.contextValue = checkedOut ? 'localReview.pullRequest.checkedOut' : 'localReview.pullRequest';
        item.command = { command: 'localReview.openPullRequest', title: 'Open changes', arguments: [node] };
        return item;
      }
      case 'file': {
        const { file } = node;
        const item = new vscode.TreeItem(path.posix.basename(file.path), vscode.TreeItemCollapsibleState.None);
        const folder = path.posix.dirname(file.path);
        item.description = node.inTree || folder === '.' ? '' : folder;
        item.tooltip = `${file.path} · +${file.additions} −${file.deletions}`;
        item.resourceUri = fileRowUri(node.parent.pullRequest.number, file);
        item.iconPath = vscode.ThemeIcon.File;
        const { repository, worktrees } = node.parent.listing;
        if (await worktrees.exists(repository.name, node.parent.pullRequest.number)) {
          const reviewed = await worktrees.reviewedFiles(node.parent.listing.provider, repository.name, node.parent.pullRequest.number, [file.path]);
          item.checkboxState = reviewed.has(file.path) ? vscode.TreeItemCheckboxState.Checked : vscode.TreeItemCheckboxState.Unchecked;
        }
        item.command = { command: 'localReview.openPullRequest', title: 'Open changes', arguments: [node.parent, file.path] };
        return item;
      }
      case 'folder': {
        const item = new vscode.TreeItem(node.folder.name, vscode.TreeItemCollapsibleState.Expanded);
        item.resourceUri = vscode.Uri.from({ scheme: fileScheme, authority: `pr-${node.parent.pullRequest.number}`, path: `/${node.folder.path}` });
        item.iconPath = vscode.ThemeIcon.Folder;
        item.tooltip = node.folder.path;
        return item;
      }
      case 'message': {
        const item = new vscode.TreeItem(node.text, vscode.TreeItemCollapsibleState.None);
        item.iconPath = new vscode.ThemeIcon(node.icon);
        return item;
      }
    }
  }

  /** Mark a file reviewed from its checkbox. */
  async setReviewed(node: Node, state: vscode.TreeItemCheckboxState): Promise<void> {
    if (node.kind !== 'file') return;
    const { pullRequest, listing } = node.parent;
    await listing.worktrees.setReviewed(listing.provider, listing.repository.name, pullRequest.number, node.file.path, state === vscode.TreeItemCheckboxState.Checked);
  }

  #folderChildren(parent: PullRequestNode, folder: FileFolder): Node[] {
    return [
      ...folder.folders.map((child): Node => ({ kind: 'folder', parent, folder: child })),
      ...folder.files.map((file): Node => ({ kind: 'file', parent, file, inTree: true })),
    ];
  }

  #filesOf(node: PullRequestNode): Promise<readonly PullRequestFile[]> {
    const { number } = node.pullRequest;
    const key = `${node.listing.repository.name}#${number}`;
    let files = this.#files.get(key);
    if (files === undefined) {
      files = node.listing.provider.listFiles(number);
      files.catch(() => { this.#files.delete(key); });
      this.#files.set(key, files);
    }
    return files;
  }

  /** "2/5 reviewed" for a checked-out PR, or undefined while its files are unknown. */
  async #progress(node: PullRequestNode): Promise<string | undefined> {
    const files = await this.#filesOf(node).catch(() => undefined);
    if (files === undefined || files.length === 0) return undefined;
    const reviewed = await node.listing.worktrees.reviewedFiles(node.listing.provider, node.listing.repository.name, node.pullRequest.number, files.map((file) => file.path));
    return `${reviewed.size}/${files.length} reviewed`;
  }

  async #load(): Promise<readonly Listing[]> {
    try {
      this.#listed = await this.checkouts();
    } catch (error: unknown) {
      return [{ kind: 'failed', folder: '', message: error instanceof Error ? error.message : String(error) }];
    }
    const checkouts = this.#listed;
    const listings: Listing[] = [];
    let next = 0;
    const work = async (): Promise<void> => {
      for (let index = next++; index < checkouts.length; index = next++) {
        const checkout = checkouts[index];
        if (checkout !== undefined) listings[index] = await this.#loadOne(checkout);
      }
    };
    await Promise.all(Array.from({ length: Math.min(parallelListings, checkouts.length) }, work));
    return listings;
  }

  async #loadOne({ folder, connect, worktrees }: PullRequestCheckout): Promise<Listing> {
    try {
      const provider = await connect();
      const [repository, mine, reviewRequested] = await Promise.all([
        provider.readRepository(), provider.listMine(), provider.listReviewRequested(),
      ]);
      return { kind: 'ready', provider, worktrees, repository, mine, reviewRequested };
    } catch (error: unknown) {
      return { kind: 'failed', folder, message: error instanceof Error ? error.message : String(error) };
    }
  }
}

/** Register the pull request sidebar and its commands. */
export function registerPullRequestView(
  checkouts: () => Promise<readonly PullRequestCheckout[]>, onDidChangeStatus: vscode.Event<unknown>, settings: vscode.Memento,
): vscode.Disposable {
  const tree = new PullRequestTree(checkouts, settings);
  const showMode = (): void => { void vscode.commands.executeCommand('setContext', 'localReview.filesAsTree', tree.asTree); };
  showMode();
  const report = (error: unknown): void => {
    void vscode.window.showErrorMessage(error instanceof Error ? error.message : String(error));
  };
  const view = vscode.window.createTreeView('localReview.pullRequests', { treeDataProvider: tree, manageCheckboxStateManually: true });
  return vscode.Disposable.from(
    view,
    vscode.window.registerFileDecorationProvider(changeDecorationProvider),
    view.onDidChangeCheckboxState(async (event) => {
      try {
        for (const [node, state] of event.items) await tree.setReviewed(node, state);
      } catch (error: unknown) {
        report(error);
      }
      tree.redraw();
    }),
    onDidChangeStatus(() => { tree.redraw(); }),
    vscode.commands.registerCommand('localReview.refreshPullRequests', () => { tree.refresh(); }),
    vscode.commands.registerCommand('localReview.viewFilesAsTree', async () => { await tree.setAsTree(true); showMode(); }),
    vscode.commands.registerCommand('localReview.viewFilesAsList', async () => { await tree.setAsTree(false); showMode(); }),
    vscode.commands.registerCommand('localReview.openPullRequestInBrowser', async (node: unknown) => {
      if (isPullRequestNode(node)) await vscode.env.openExternal(vscode.Uri.parse(node.pullRequest.url));
    }),
    vscode.commands.registerCommand('localReview.openPullRequest', async (node: unknown, revealPath: unknown) => {
      if (!isPullRequestNode(node)) return;
      const reveal = typeof revealPath === 'string' ? revealPath : undefined;
      try {
        await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: `Opening #${node.pullRequest.number}` },
          () => node.listing.worktrees.open(node.listing.provider, node.listing.repository.name, node.pullRequest, node.role, reveal),
        );
      } catch (error: unknown) {
        report(error);
      }
      tree.redraw();
    }),
    vscode.commands.registerCommand('localReview.showPullRequestClaude', async (node: unknown) => {
      if (!isPullRequestNode(node)) return;
      try {
        await node.listing.worktrees.showClaude(node.listing.provider, node.listing.repository.name, node.pullRequest, node.role);
      } catch (error: unknown) {
        report(error);
      }
      tree.redraw();
    }),
    vscode.commands.registerCommand('localReview.showPullRequestOverview', async (node: unknown) => {
      if (!isPullRequestNode(node)) return;
      try {
        await node.listing.worktrees.showOverview(node.listing.provider, node.listing.repository.name, node.pullRequest, node.role);
      } catch (error: unknown) {
        report(error);
      }
      tree.redraw();
    }),
    vscode.commands.registerCommand('localReview.removePullRequestWorktree', async (node: unknown) => {
      if (!isPullRequestNode(node)) return;
      const confirm = 'Remove worktree';
      const answer = await vscode.window.showWarningMessage(
        `Remove the worktree for #${node.pullRequest.number}? Its local comments are deleted too. Git refuses if it has uncommitted changes.`,
        { modal: true }, confirm,
      );
      if (answer !== confirm) return;
      try {
        await node.listing.worktrees.remove(node.listing.repository.name, node.pullRequest.number);
      } catch (error: unknown) {
        report(error);
      }
      tree.redraw();
    }),
  );
}

/** Accept only tree nodes this view created; command arguments are otherwise untrusted. */
function isPullRequestNode(value: unknown): value is PullRequestNode {
  return typeof value === 'object' && value !== null && (value as { kind?: unknown }).kind === 'pullRequest'
    && typeof (value as { listing?: { provider?: unknown } }).listing?.provider === 'object'
    && typeof (value as { listing?: { worktrees?: unknown } }).listing?.worktrees === 'object';
}
