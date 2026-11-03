import * as vscode from 'vscode';
import * as path from 'node:path';
import type { PullRequestFile, PullRequestProvider, PullRequestRepository, PullRequestSummary, ReviewVerdict } from './pullRequests.js';
import type { PullRequestRole } from './worktrees.js';
import { GitHubSignInRequired } from './githubApi.js';
import { fileTree, type FileFolder } from './fileTree.js';
import type { OutlineGroup, OutlineStep } from './prAnalysis.js';

type Listing =
  | { readonly kind: 'ready'; readonly folder: string; readonly provider: PullRequestProvider; readonly worktrees: PullRequestWorktrees; readonly repository: PullRequestRepository; readonly mine: readonly PullRequestSummary[]; readonly reviewRequested: readonly PullRequestSummary[] }
  | { readonly kind: 'failed'; readonly folder: string; readonly message: string; readonly signIn?: GitHubSignInRequired['provider'] };

type Ready = Extract<Listing, { kind: 'ready' }>;

type PullRequestNode = { readonly kind: 'pullRequest'; readonly listing: Ready; readonly role: PullRequestRole; readonly pullRequest: PullRequestSummary };

type RepositoryNode = { readonly kind: 'repository'; readonly listing: Ready; /** Set when grouped by role: the row then holds only that role's PRs. */ readonly role?: PullRequestRole };

type Node =
  | { readonly kind: 'role'; readonly role: PullRequestRole; readonly listings: readonly Ready[] }
  | RepositoryNode
  | { readonly kind: 'section'; readonly listing: Ready; readonly role: PullRequestRole }
  | PullRequestNode
  | FileNode
  | FolderNode
  | { readonly kind: 'guide'; readonly parent: PullRequestNode; readonly groups: readonly OutlineGroup[] }
  | { readonly kind: 'guideGroup'; readonly parent: PullRequestNode; readonly group: OutlineGroup }
  | { readonly kind: 'guideStep'; readonly parent: PullRequestNode; readonly step: OutlineStep; readonly number: number }
  | { readonly kind: 'message'; readonly text: string; readonly icon: string; readonly command?: vscode.Command };

type FileNode = { readonly kind: 'file'; readonly parent: PullRequestNode; readonly file: PullRequestFile; readonly inTree: boolean };
type FolderNode = { readonly kind: 'folder'; readonly parent: PullRequestNode; readonly folder: FileFolder<PullRequestFile> };

const fileViewKey = 'pairReview.fileView';
const groupByKey = 'pairReview.groupBy';
const hiddenKey = 'pairReview.hiddenRepositories';
const snapshotKey = 'pairReview.pullRequestSnapshot';

/** A repository's PR lists from the last load, shown at once while fresh ones load. */
type Snapshot = Readonly<Record<string, { readonly repository: PullRequestRepository; readonly mine: readonly PullRequestSummary[]; readonly reviewRequested: readonly PullRequestSummary[] }>>;

const fileScheme = 'pair-review-pr-file';

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
  /** Open a tab with the PR's review progress, threads and Claude activity; with `step`, in the guided layout at that step. */
  showOverview(provider: PullRequestProvider, repository: string, pullRequest: PullRequestSummary, role: PullRequestRole, step?: string): Promise<void>;
  /** The steps of a checked-out PR's guided review, or undefined before it is analyzed. */
  guide(provider: PullRequestProvider, repository: string, pullRequest: PullRequestSummary): Promise<readonly OutlineGroup[] | undefined>;
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

/** Repositories listed at once, so a folder of many repositories does not start dozens of GitHub requests together. */
const parallelListings = 4;

/** Sidebar icon and label for each review verdict. */
const verdicts: Record<ReviewVerdict, { readonly icon: string; readonly color: string; readonly label: string }> = {
  approved: { icon: 'pass', color: 'testing.iconPassed', label: 'Approved' },
  changes: { icon: 'request-changes', color: 'testing.iconFailed', label: 'Changes requested' },
  commented: { icon: 'comment-discussion', color: 'descriptionForeground', label: 'Commented' },
};

/** How the sidebar shows each guide group's severity; folded groups start closed, as on the review page. */
const severityLooks: Record<OutlineGroup['severity'], { readonly label: string; readonly icon: string; readonly color: string; readonly folded?: true }> = {
  critical: { label: 'Critical', icon: 'error', color: 'errorForeground' },
  significant: { label: 'Significant', icon: 'warning', color: 'editorWarning.foreground' },
  routine: { label: 'Routine', icon: 'info', color: 'editorInfo.foreground' },
  trivial: { label: 'Trivial', icon: 'circle-small', color: 'descriptionForeground', folded: true },
  unclassified: { label: 'Unclassified', icon: 'question', color: 'descriptionForeground' },
};

const sectionLabels: Record<PullRequestRole, string> = { author: 'Mine', reviewer: 'Review requested' };
const roleIcons: Record<PullRequestRole, string> = { author: 'account', reviewer: 'eye' };
const roles: readonly PullRequestRole[] = ['reviewer', 'author'];

function pullRequestsOf(listing: Ready, role: PullRequestRole): readonly PullRequestSummary[] {
  return role === 'author' ? listing.mine : listing.reviewRequested;
}

/** `owner/name#number`, the key change events name a PR by. */
function pullRequestKey(node: PullRequestNode): string {
  return `${node.listing.repository.name}#${node.pullRequest.number}`;
}

/** Run at most `count` tasks at once, starting the rest in call order. */
function limited(count: number): <T>(task: () => Promise<T>) => Promise<T> {
  let running = 0;
  const waiting: (() => void)[] = [];
  return async (task) => {
    if (running < count) running += 1;
    else await new Promise<void>((resolve) => { waiting.push(resolve); });
    try {
      return await task();
    } finally {
      const next = waiting.shift();
      if (next === undefined) running -= 1;
      else next();
    }
  };
}

/** List each repository's open pull requests by the user's role in them. */
class PullRequestTree implements vscode.TreeDataProvider<Node> {
  readonly #changed = new vscode.EventEmitter<Node | undefined>();
  readonly onDidChangeTreeData = this.#changed.event;
  #checkouts: Promise<readonly PullRequestCheckout[]> | undefined;
  #listed: readonly PullRequestCheckout[] = [];
  readonly #listings = new Map<string, Promise<Listing>>();
  readonly #done = new Map<string, Listing>();
  #saving: Promise<void> = Promise.resolve();
  readonly #queue = limited(parallelListings);
  readonly #files = new Map<string, Promise<readonly PullRequestFile[]>>();
  /** The row shown for each PR, so a change to one PR redraws only that row. */
  readonly #rows = new Map<string, PullRequestNode>();
  /** Worktree and reviewed state per PR, read once per redraw and shared by the PR's row and its file rows. */
  readonly #checkedOut = new Map<string, Promise<boolean>>();
  readonly #reviewed = new Map<string, Promise<ReadonlySet<string>>>();
  readonly #guides = new Map<string, Promise<readonly OutlineGroup[] | undefined>>();

  constructor(
    private readonly checkouts: () => Promise<readonly PullRequestCheckout[]>,
    private readonly settings: vscode.Memento,
    private readonly workspace: vscode.Memento,
    private readonly describe: (text: string | undefined) => void,
    private readonly report: (message: string | undefined) => void,
  ) {}

  get byRole(): boolean {
    return this.settings.get(groupByKey, 'role') === 'role';
  }

  async setByRole(byRole: boolean): Promise<void> {
    await this.settings.update(groupByKey, byRole ? 'role' : 'repository');
    this.#changed.fire(undefined);
  }

  get #hidden(): ReadonlySet<string> {
    return new Set(this.workspace.get<readonly string[]>(hiddenKey, []));
  }

  async hide(node: RepositoryNode): Promise<void> {
    await this.workspace.update(hiddenKey, [...this.#hidden, node.listing.folder]);
    this.#changed.fire(undefined);
  }

  /** Let the user tick the repositories the view lists; unticked ones are not queried. */
  async chooseRepositories(): Promise<void> {
    const all = await this.#allCheckouts().catch(() => []);
    if (all.length === 0) return;
    const hidden = this.#hidden;
    const picked = await vscode.window.showQuickPick(
      all.map((checkout) => ({ label: checkout.folder, picked: !hidden.has(checkout.folder) })),
      { canPickMany: true, title: 'Repositories to show', placeHolder: 'Type to filter' },
    );
    if (picked === undefined) return;
    const shown = new Set(picked.map((item) => item.label));
    await this.workspace.update(hiddenKey, all.map((checkout) => checkout.folder).filter((folder) => !shown.has(folder)));
    this.#changed.fire(undefined);
  }

  get asTree(): boolean {
    return this.settings.get(fileViewKey, 'tree') === 'tree';
  }

  async setAsTree(asTree: boolean): Promise<void> {
    await this.settings.update(fileViewKey, asTree ? 'tree' : 'list');
    this.#changed.fire(undefined);
  }

  refresh(): void {
    this.#checkouts = undefined;
    this.#listings.clear();
    this.#done.clear();
    this.#files.clear();
    this.#rows.clear();
    this.#forgetState();
    for (const checkout of this.#listed) checkout.worktrees.forget();
    this.#changed.fire(undefined);
  }

  /** Redraw checkout state without querying the code host again: one PR's row when it is shown, else the whole tree. */
  redraw(pullRequest?: string): void {
    const row = pullRequest === undefined ? undefined : this.#rows.get(pullRequest);
    this.#forgetState(row === undefined ? undefined : pullRequest);
    this.#changed.fire(row);
  }

  #forgetState(pullRequest?: string): void {
    if (pullRequest === undefined) {
      this.#checkedOut.clear();
      this.#reviewed.clear();
      this.#guides.clear();
    } else {
      this.#checkedOut.delete(pullRequest);
      this.#reviewed.delete(pullRequest);
      this.#guides.delete(pullRequest);
    }
  }

  async getChildren(node?: Node): Promise<Node[]> {
    if (node === undefined) return await this.#rootChildren();
    if (node.kind === 'role') {
      return node.listings.length === 0
        ? [{ kind: 'message', text: 'No open PRs', icon: 'check' }]
        : node.listings.map((listing) => ({ kind: 'repository', listing, role: node.role }));
    }
    if (node.kind === 'repository' && node.role === undefined) {
      return roles.filter((role) => pullRequestsOf(node.listing, role).length > 0).map((role) => ({ kind: 'section', listing: node.listing, role }));
    }
    if (node.kind === 'repository' || node.kind === 'section') {
      const role = node.role as PullRequestRole;
      return pullRequestsOf(node.listing, role).map((pullRequest) => {
        const row: PullRequestNode = { kind: 'pullRequest', listing: node.listing, role, pullRequest };
        this.#rows.set(pullRequestKey(row), row);
        return row;
      });
    }
    if (node.kind === 'folder') return this.#folderChildren(node.parent, node.folder);
    if (node.kind === 'pullRequest') {
      const groups = await this.#isCheckedOut(node).then((checkedOut) => checkedOut ? this.#guideOf(node) : undefined).catch(() => undefined);
      const guide: Node[] = groups === undefined || groups.length === 0 ? [] : [{ kind: 'guide', parent: node, groups }];
      try {
        const files = await this.#filesOf(node);
        return [...guide, ...files.length === 0
          ? [{ kind: 'message', text: 'No changed files', icon: 'info' } as const]
          : this.asTree ? this.#folderChildren(node, fileTree(files)) : files.map((file): Node => ({ kind: 'file', parent: node, file, inTree: false }))];
      } catch (error: unknown) {
        return [...guide, { kind: 'message', text: error instanceof Error ? error.message : String(error), icon: 'warning' }];
      }
    }
    if (node.kind === 'guide') return node.groups.map((group): Node => ({ kind: 'guideGroup', parent: node.parent, group }));
    if (node.kind === 'guideGroup') return node.group.steps.map((step, index): Node => ({ kind: 'guideStep', parent: node.parent, step, number: index + 1 }));
    return [];
  }

  async getTreeItem(node: Node): Promise<vscode.TreeItem> {
    switch (node.kind) {
      case 'role': {
        const item = new vscode.TreeItem(sectionLabels[node.role].toUpperCase(), vscode.TreeItemCollapsibleState.Expanded);
        item.iconPath = new vscode.ThemeIcon(roleIcons[node.role]);
        item.description = String(node.listings.reduce((sum, listing) => sum + pullRequestsOf(listing, node.role).length, 0));
        return item;
      }
      case 'repository': {
        const { listing, role } = node;
        const item = new vscode.TreeItem(listing.repository.name, vscode.TreeItemCollapsibleState.Expanded);
        item.iconPath = new vscode.ThemeIcon('repo');
        item.description = role === undefined
          ? roles.filter((each) => pullRequestsOf(listing, each).length > 0).map((each) => `${pullRequestsOf(listing, each).length} ${each === 'author' ? 'mine' : 'review'}`).join(' · ')
          : String(pullRequestsOf(listing, role).length);
        item.tooltip = listing.folder;
        item.contextValue = 'pairReview.repository';
        return item;
      }
      case 'section': {
        const item = new vscode.TreeItem(sectionLabels[node.role], vscode.TreeItemCollapsibleState.Expanded);
        item.iconPath = new vscode.ThemeIcon(roleIcons[node.role]);
        item.description = String(pullRequestsOf(node.listing, node.role).length);
        return item;
      }
      case 'pullRequest': {
        const pr = node.pullRequest;
        const checkedOut = await this.#isCheckedOut(node);
        const item = new vscode.TreeItem(`#${pr.number} ${pr.title}`, vscode.TreeItemCollapsibleState.Collapsed);
        const claude = checkedOut ? node.listing.worktrees.claudeStatus(node.listing.repository.name, pr.number) : undefined;
        const progress = checkedOut ? await this.#progress(node) : undefined;
        const verdict = pr.review === undefined ? undefined : verdicts[pr.review];
        item.description = [verdict?.label, pr.author, pr.draft ? 'Draft' : undefined, claude ?? (checkedOut ? 'Worktree' : undefined), progress].filter(Boolean).join(' · ');
        item.tooltip = `${pr.title}\n${pr.headBranch} → ${pr.baseBranch}${verdict === undefined ? '' : `\n${verdict.label}`}`;
        item.iconPath = verdict === undefined
          ? new vscode.ThemeIcon(pr.draft ? 'git-pull-request-draft' : 'git-pull-request')
          : new vscode.ThemeIcon(verdict.icon, new vscode.ThemeColor(verdict.color));
        item.contextValue = checkedOut ? 'pairReview.pullRequest.checkedOut' : 'pairReview.pullRequest';
        item.command = { command: 'pairReview.openPullRequest', title: 'Open changes', arguments: [node] };
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
        if (await this.#isCheckedOut(node.parent)) {
          const reviewed = await this.#reviewedOf(node.parent).catch(() => new Set<string>());
          item.checkboxState = reviewed.has(file.path) ? vscode.TreeItemCheckboxState.Checked : vscode.TreeItemCheckboxState.Unchecked;
        }
        item.command = { command: 'pairReview.openPullRequest', title: 'Open changes', arguments: [node.parent, file.path] };
        return item;
      }
      case 'folder': {
        const item = new vscode.TreeItem(node.folder.name, vscode.TreeItemCollapsibleState.Expanded);
        item.tooltip = node.folder.path;
        return item;
      }
      case 'guide': {
        const steps = node.groups.flatMap((group) => group.steps);
        const item = new vscode.TreeItem('Guide', vscode.TreeItemCollapsibleState.Expanded);
        item.iconPath = new vscode.ThemeIcon('compass');
        item.description = `${steps.filter((step) => step.viewed).length}/${steps.length} viewed`;
        return item;
      }
      case 'guideGroup': {
        const { group } = node;
        const look = severityLooks[group.severity];
        const item = new vscode.TreeItem(`${look.label} · ${group.title}`, look.folded ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.Expanded);
        item.iconPath = new vscode.ThemeIcon(look.icon, new vscode.ThemeColor(look.color));
        item.description = `${group.steps.filter((step) => step.viewed).length}/${group.steps.length}`;
        return item;
      }
      case 'guideStep': {
        const { step, parent } = node;
        const name = path.posix.basename(step.path);
        const item = new vscode.TreeItem(`${node.number}. ${step.title ?? name}`, vscode.TreeItemCollapsibleState.None);
        item.description = step.title === undefined ? path.posix.dirname(step.path).replace(/^\.$/u, '') : name;
        item.iconPath = step.viewed ? new vscode.ThemeIcon('pass-filled', new vscode.ThemeColor('testing.iconPassed')) : new vscode.ThemeIcon('circle-large-outline');
        item.tooltip = new vscode.MarkdownString().appendText(`${step.path}${step.viewed ? ' · Viewed' : ''}${step.note === undefined ? '' : `\n\n${step.note}`}`);
        item.command = { command: 'pairReview.showGuideStep', title: 'Show step', arguments: [parent, step.key] };
        return item;
      }
      case 'message': {
        const item = new vscode.TreeItem(node.text, vscode.TreeItemCollapsibleState.None);
        item.iconPath = new vscode.ThemeIcon(node.icon);
        if (node.command !== undefined) item.command = node.command;
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

  #folderChildren(parent: PullRequestNode, folder: FileFolder<PullRequestFile>): Node[] {
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
    const reviewed = await this.#reviewedOf(node).catch(() => undefined);
    return reviewed === undefined ? undefined : `${reviewed.size}/${files.length} reviewed`;
  }

  #guideOf(node: PullRequestNode): Promise<readonly OutlineGroup[] | undefined> {
    const key = pullRequestKey(node);
    let guide = this.#guides.get(key);
    if (guide === undefined) {
      guide = node.listing.worktrees.guide(node.listing.provider, node.listing.repository.name, node.pullRequest);
      guide.catch(() => { this.#guides.delete(key); });
      this.#guides.set(key, guide);
    }
    return guide;
  }

  #isCheckedOut(node: PullRequestNode): Promise<boolean> {
    const key = pullRequestKey(node);
    let checkedOut = this.#checkedOut.get(key);
    if (checkedOut === undefined) {
      checkedOut = node.listing.worktrees.exists(node.listing.repository.name, node.pullRequest.number);
      checkedOut.catch(() => { this.#checkedOut.delete(key); });
      this.#checkedOut.set(key, checkedOut);
    }
    return checkedOut;
  }

  #reviewedOf(node: PullRequestNode): Promise<ReadonlySet<string>> {
    const key = pullRequestKey(node);
    let reviewed = this.#reviewed.get(key);
    if (reviewed === undefined) {
      reviewed = this.#filesOf(node).then((files) => node.listing.worktrees.reviewedFiles(node.listing.provider, node.listing.repository.name, node.pullRequest.number, files.map((file) => file.path)));
      reviewed.catch(() => { this.#reviewed.delete(key); });
      this.#reviewed.set(key, reviewed);
    }
    return reviewed;
  }

  async #rootChildren(): Promise<Node[]> {
    let all: readonly PullRequestCheckout[];
    try {
      all = await this.#allCheckouts();
    } catch (error: unknown) {
      this.describe(undefined);
      return [{ kind: 'message', text: error instanceof Error ? error.message : String(error), icon: 'warning' }];
    }
    const hidden = this.#hidden;
    const shown = all.filter((checkout) => !hidden.has(checkout.folder));
    this.describe(shown.length < all.length ? `${all.length - shown.length} hidden` : undefined);
    if (shown.length === 0 && all.length > 0) return [{ kind: 'message', text: 'All repositories are hidden', icon: 'eye-closed' }];
    const loading = Promise.all(shown.map((checkout) => this.#listingOf(checkout)));
    let listings: readonly Listing[];
    const cached = shown.every((checkout) => this.#done.has(checkout.folder)) ? undefined : await this.#cachedListings(shown);
    if (cached === undefined) {
      listings = await loading;
      this.report(undefined);
    } else {
      listings = cached;
      this.report('Updating pull requests...');
      void loading.then(() => { this.#changed.fire(undefined); });
    }
    const failed = listings.flatMap((listing): Node[] => listing.kind === 'failed'
      ? [{ kind: 'message', text: shown.length === 1 ? listing.message : `${listing.folder}: ${listing.message}`, ...listing.signIn === undefined
        ? { icon: 'warning' } : { icon: 'account', command: { command: 'pairReview.signInToGitHub', title: 'Sign in to GitHub', arguments: [listing.signIn] } } }]
      : []);
    const ready = listings.filter((listing): listing is Ready => listing.kind === 'ready');
    const signIn = ready.length === 0 ? listings.find((listing) => listing.kind === 'failed' && listing.signIn !== undefined) : undefined;
    void vscode.commands.executeCommand('setContext', 'pairReview.gitHubSignIn', signIn?.kind === 'failed' ? signIn.signIn : undefined);
    if (signIn !== undefined) return [];
    if (ready.length === 0) return failed;
    if (this.byRole) {
      return [...roles.map((role): Node => ({ kind: 'role', role, listings: ready.filter((listing) => pullRequestsOf(listing, role).length > 0) })), ...failed];
    }
    const withPullRequests = ready.filter((listing) => listing.mine.length + listing.reviewRequested.length > 0);
    return [
      ...withPullRequests.length === 0 ? [{ kind: 'message', text: 'No open PRs', icon: 'check' } as const] : [],
      ...withPullRequests.map((listing): Node => ({ kind: 'repository', listing })),
      ...failed,
    ];
  }

  #allCheckouts(): Promise<readonly PullRequestCheckout[]> {
    this.#checkouts ??= this.checkouts().then((all) => { this.#listed = all; return all; });
    return this.#checkouts;
  }

  #listingOf(checkout: PullRequestCheckout): Promise<Listing> {
    let listing = this.#listings.get(checkout.folder);
    if (listing === undefined) {
      const loaded = listing = this.#queue(() => this.#loadOne(checkout));
      this.#listings.set(checkout.folder, loaded);
      void loaded.then((done) => {
        if (this.#listings.get(checkout.folder) !== loaded) return;
        this.#done.set(checkout.folder, done);
        this.#saving = this.#saving.then(() => this.#remember(done), () => this.#remember(done));
      });
    }
    return listing;
  }

  /** Last load's lists for repositories still loading, or undefined when there is nothing saved to show. */
  async #cachedListings(shown: readonly PullRequestCheckout[]): Promise<readonly Listing[] | undefined> {
    const snapshot = this.workspace.get<Snapshot>(snapshotKey, {});
    if (!shown.some((checkout) => Object.hasOwn(snapshot, checkout.folder) && !this.#done.has(checkout.folder))) return undefined;
    const listings = await Promise.all(shown.map(async (checkout): Promise<Listing | undefined> => {
      const done = this.#done.get(checkout.folder);
      if (done !== undefined) return done;
      const saved = Object.hasOwn(snapshot, checkout.folder) ? snapshot[checkout.folder] : undefined;
      if (saved === undefined) return undefined;
      const provider = await checkout.connect().catch(() => undefined);
      return provider === undefined ? undefined : { kind: 'ready', folder: checkout.folder, provider, worktrees: checkout.worktrees, ...saved };
    }));
    return listings.filter((listing): listing is Listing => listing !== undefined);
  }

  async #remember(listing: Listing): Promise<void> {
    const snapshot = { ...this.workspace.get<Snapshot>(snapshotKey, {}) };
    if (listing.kind === 'ready') snapshot[listing.folder] = { repository: listing.repository, mine: listing.mine, reviewRequested: listing.reviewRequested };
    else delete snapshot[listing.folder];
    await this.workspace.update(snapshotKey, snapshot);
  }

  async #loadOne({ folder, connect, worktrees }: PullRequestCheckout): Promise<Listing> {
    try {
      const provider = await connect();
      const [repository, mine, reviewRequested] = await Promise.all([
        provider.readRepository(), provider.listMine(), provider.listReviewRequested(),
      ]);
      return { kind: 'ready', folder, provider, worktrees, repository, mine, reviewRequested };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      return error instanceof GitHubSignInRequired ? { kind: 'failed', folder, message, signIn: error.provider } : { kind: 'failed', folder, message };
    }
  }
}

/** Register the pull request sidebar and its commands. */
export function registerPullRequestView(
  checkouts: () => Promise<readonly PullRequestCheckout[]>,
  /** Fires with `owner/name#number` when that PR's Claude activity or reviewed files change, or undefined to redraw all. */
  onDidChangeStatus: vscode.Event<string | undefined>,
  settings: vscode.Memento, workspace: vscode.Memento,
): vscode.Disposable {
  const tree = new PullRequestTree(checkouts, settings, workspace,
    (text) => { view.description = text ?? ''; }, (message) => { view.message = message ?? ''; });
  const showMode = (): void => {
    void vscode.commands.executeCommand('setContext', 'pairReview.filesAsTree', tree.asTree);
    void vscode.commands.executeCommand('setContext', 'pairReview.groupByRole', tree.byRole);
  };
  showMode();
  const report = (error: unknown): void => {
    void vscode.window.showErrorMessage(error instanceof Error ? error.message : String(error));
  };
  const view = vscode.window.createTreeView('pairReview.pullRequests', { treeDataProvider: tree, manageCheckboxStateManually: true });
  return vscode.Disposable.from(
    view,
    vscode.window.registerFileDecorationProvider(changeDecorationProvider),
    view.onDidChangeCheckboxState(async (event) => {
      try {
        for (const [node, state] of event.items) await tree.setReviewed(node, state);
      } catch (error: unknown) {
        report(error);
      }
      for (const [node] of event.items) tree.redraw(node.kind === 'file' ? pullRequestKey(node.parent) : undefined);
    }),
    onDidChangeStatus((pullRequest) => { tree.redraw(pullRequest); }),
    vscode.commands.registerCommand('pairReview.refreshPullRequests', () => { tree.refresh(); }),
    vscode.commands.registerCommand('pairReview.viewFilesAsTree', async () => { await tree.setAsTree(true); showMode(); }),
    vscode.commands.registerCommand('pairReview.viewFilesAsList', async () => { await tree.setAsTree(false); showMode(); }),
    vscode.commands.registerCommand('pairReview.groupByRole', async () => { await tree.setByRole(true); showMode(); }),
    vscode.commands.registerCommand('pairReview.groupByRepository', async () => { await tree.setByRole(false); showMode(); }),
    vscode.commands.registerCommand('pairReview.chooseRepositories', async () => { await tree.chooseRepositories(); }),
    vscode.commands.registerCommand('pairReview.hideRepository', async (node: unknown) => {
      if (isRepositoryNode(node)) await tree.hide(node);
    }),
    vscode.commands.registerCommand('pairReview.openPullRequestInBrowser', async (node: unknown) => {
      if (isPullRequestNode(node)) await vscode.env.openExternal(vscode.Uri.parse(node.pullRequest.url));
    }),
    vscode.commands.registerCommand('pairReview.openPullRequest', async (node: unknown, revealPath: unknown) => {
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
      tree.redraw(pullRequestKey(node));
    }),
    vscode.commands.registerCommand('pairReview.showPullRequestClaude', async (node: unknown) => {
      if (!isPullRequestNode(node)) return;
      try {
        await node.listing.worktrees.showClaude(node.listing.provider, node.listing.repository.name, node.pullRequest, node.role);
      } catch (error: unknown) {
        report(error);
      }
      tree.redraw(pullRequestKey(node));
    }),
    vscode.commands.registerCommand('pairReview.showPullRequestOverview', async (node: unknown) => {
      if (!isPullRequestNode(node)) return;
      try {
        await node.listing.worktrees.showOverview(node.listing.provider, node.listing.repository.name, node.pullRequest, node.role);
      } catch (error: unknown) {
        report(error);
      }
      tree.redraw(pullRequestKey(node));
    }),
    vscode.commands.registerCommand('pairReview.showGuideStep', async (node: unknown, step: unknown) => {
      if (!isPullRequestNode(node) || typeof step !== 'string') return;
      try {
        await node.listing.worktrees.showOverview(node.listing.provider, node.listing.repository.name, node.pullRequest, node.role, step);
      } catch (error: unknown) {
        report(error);
      }
    }),
    vscode.commands.registerCommand('pairReview.removePullRequestWorktree', async (node: unknown) => {
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
      tree.redraw(pullRequestKey(node));
    }),
  );
}

function isRepositoryNode(value: unknown): value is RepositoryNode {
  return typeof value === 'object' && value !== null && (value as { kind?: unknown }).kind === 'repository'
    && typeof (value as { listing?: { folder?: unknown } }).listing?.folder === 'string';
}

/** Accept only tree nodes this view created; command arguments are otherwise untrusted. */
function isPullRequestNode(value: unknown): value is PullRequestNode {
  return typeof value === 'object' && value !== null && (value as { kind?: unknown }).kind === 'pullRequest'
    && typeof (value as { listing?: { provider?: unknown } }).listing?.provider === 'object'
    && typeof (value as { listing?: { worktrees?: unknown } }).listing?.worktrees === 'object';
}
