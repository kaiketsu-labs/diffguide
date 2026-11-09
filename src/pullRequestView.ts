import * as vscode from 'vscode';
import { parsePullRequestLink, type ListVersion, type PullRequestProvider, type PullRequestRepository, type PullRequestSummary, type ReviewVerdict } from './pullRequests.js';
import type { LocalChange } from './conflicts.js';
import type { PullRequestRole } from './worktrees.js';
import { pollWhileFocused } from './autoSync.js';
import { GitHubSignInRequired } from './githubApi.js';

type Listing =
  | { readonly kind: 'ready'; readonly folder: string; readonly provider: PullRequestProvider; readonly worktrees: PullRequestWorktrees; readonly repository: PullRequestRepository; readonly mine: readonly PullRequestSummary[]; readonly reviewRequested: readonly PullRequestSummary[]; readonly openCount?: number }
  | { readonly kind: 'failed'; readonly folder: string; readonly message: string; readonly signIn?: GitHubSignInRequired['provider'] };

type Ready = Extract<Listing, { kind: 'ready' }>;

/** Where a PR row sits, so a PR shown in two places redraws in both. */
type Placement = 'pinned' | PullRequestRole | 'allOpen';

type PullRequestNode = { readonly kind: 'pullRequest'; readonly listing: Ready; readonly role: PullRequestRole; readonly pullRequest: PullRequestSummary; readonly pinned?: true; readonly placement?: Placement };

type RepositoryNode = { readonly kind: 'repository'; readonly listing: Ready; /** Set when grouped by role: the row then holds only that role's PRs. */ readonly role?: PullRequestRole };

type Node =
  | { readonly kind: 'pinned'; readonly rows: readonly PullRequestNode[] }
  | { readonly kind: 'role'; readonly role: PullRequestRole; readonly listings: readonly Ready[] }
  | RepositoryNode
  | { readonly kind: 'section'; readonly listing: Ready; readonly role: PullRequestRole }
  /** One repository's open PRs, loaded when expanded. */
  | { readonly kind: 'allOpen'; readonly listing: Ready }
  /** The All open section when grouped by role, with one row per repository. */
  | { readonly kind: 'allOpenRoot'; readonly listings: readonly Ready[] }
  | PullRequestNode
  | { readonly kind: 'message'; readonly text: string; readonly icon: string; readonly command?: vscode.Command };

const groupByKey = 'diffGuide.groupBy';
const hiddenKey = 'diffGuide.hiddenRepositories';
const authorKey = 'diffGuide.authorFilter';
const snapshotKey = 'diffGuide.pullRequestSnapshot';
const pinnedKey = 'diffGuide.pinnedPullRequests';
const awaitingReviewKey = 'diffGuide.awaitingReviewOnly';
const pinMime = 'application/vnd.code.tree.diffguide.pullrequests';

/** A PR the user pinned, with its last known summary so it stays listed after it leaves the role searches, such as once reviewed. */
interface Pin { readonly repository: string; readonly role: PullRequestRole; readonly pullRequest: PullRequestSummary }

function pinKey(pin: Pin): string {
  return `${pin.repository}#${pin.pullRequest.number}`;
}

/** A repository's PR lists from the last load, shown at once while fresh ones load. */
type Snapshot = Readonly<Record<string, { readonly repository: PullRequestRepository; readonly mine: readonly PullRequestSummary[]; readonly reviewRequested: readonly PullRequestSummary[]; readonly openCount?: number }>>;

const pullRequestScheme = 'diffguide-pr';

/** Address for a PR row, so the decoration can badge checked-out PRs. */
function pullRequestRowUri(repository: string, number: number, checkedOut: boolean): vscode.Uri {
  return vscode.Uri.from({ scheme: pullRequestScheme, path: `/${repository}/${number}`, query: checkedOut ? 'checkedOut' : '' });
}

/** Badge checked-out PR rows. */
const rowDecorationProvider: vscode.FileDecorationProvider = {
  provideFileDecoration: (uri) => uri.scheme === pullRequestScheme && uri.query === 'checkedOut' ? new vscode.FileDecoration('W', 'Checked out in a worktree') : undefined,
};

/** Worktree operations the sidebar triggers, kept separate so the tree stays testable. */
export interface PullRequestWorktrees {
  exists(repository: string, number: number): Promise<boolean>;
  /** Ensure the PR's worktree and open its review page. */
  open(provider: PullRequestProvider, repository: string, pullRequest: PullRequestSummary, role: PullRequestRole): Promise<void>;
  remove(repository: string, number: number): Promise<void>;
  /** Show what the PR's Claude did, and send skipped comments again. */
  showClaude(provider: PullRequestProvider, repository: string, pullRequest: PullRequestSummary, role: PullRequestRole): Promise<void>;
  /** Claude's state for a PR with an open review, shown beside it. */
  claudeStatus(repository: string, number: number): string | undefined;
  /** Files of a checked-out PR ticked Viewed and unchanged since, or marked Viewed on the code host. */
  reviewedFiles(provider: PullRequestProvider, repository: string, number: number, paths: readonly string[]): Promise<ReadonlySet<string>>;
  /** Open a tab with the PR's review progress, threads and Claude activity. */
  showOverview(provider: PullRequestProvider, repository: string, pullRequest: PullRequestSummary, role: PullRequestRole): Promise<void>;
  /** What a checked-out PR's worktree has that GitHub does not: commits ahead of `pushedHead`, and each changed file. */
  localChanges(repository: string, number: number, pushedHead: string | undefined): Promise<{ readonly commits: number; readonly files: ReadonlyMap<string, LocalChange> }>;
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

const repositoryIcon = new vscode.ThemeIcon('diffguide-repository', new vscode.ThemeColor('charts.purple'));

const mergedIcon = new vscode.ThemeIcon('git-merge', new vscode.ThemeColor('charts.purple'));

const awaitingReviewIcon = new vscode.ThemeIcon('eye', new vscode.ThemeColor('charts.yellow'));

function pullRequestIcon(draft: boolean, review?: ReviewVerdict, awaitingReview = false): vscode.ThemeIcon {
  if (review !== undefined) return new vscode.ThemeIcon(verdicts[review].icon, new vscode.ThemeColor(verdicts[review].color));
  if (awaitingReview && !draft) return awaitingReviewIcon;
  return draft
    ? new vscode.ThemeIcon('git-pull-request-draft', new vscode.ThemeColor('descriptionForeground'))
    : new vscode.ThemeIcon('git-pull-request', new vscode.ThemeColor('charts.green'));
}

/** Key to the Pull Requests icons and badge, drawn with the same icons as the rows. */
const legendProvider: vscode.TreeDataProvider<vscode.TreeItem> = {
  getTreeItem: (item) => item,
  getChildren: (item) => {
    if (item !== undefined) return [];
    const row = (label: string, icon: vscode.ThemeIcon, resourceUri?: vscode.Uri): vscode.TreeItem => {
      const each = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);
      each.iconPath = icon;
      if (resourceUri !== undefined) each.resourceUri = resourceUri;
      return each;
    };
    return [
      row('Repository', repositoryIcon),
      row('Open', pullRequestIcon(false)),
      row('Draft', pullRequestIcon(true)),
      row('Merged', mergedIcon),
      row('Awaiting review', awaitingReviewIcon),
      ...(['approved', 'changes', 'commented'] as const).map((review) => row(verdicts[review].label, pullRequestIcon(false, review))),
      row('Checked out in a worktree', pullRequestIcon(false), pullRequestRowUri('legend', 0, true)),
    ];
  },
};

const sectionLabels: Record<PullRequestRole, string> = { author: 'Mine', reviewer: 'Review requested' };
const roleIcons: Record<PullRequestRole, string> = { author: 'diffguide-outbox', reviewer: 'diffguide-inbox' };
const roles: readonly PullRequestRole[] = ['reviewer', 'author'];

/** "alice, team Core" for a PR's pending reviewers. */
function reviewerNames(pullRequest: PullRequestSummary): string {
  return (pullRequest.requestedReviewers ?? []).map((reviewer) => reviewer.team ? `team ${reviewer.name}` : reviewer.name).join(', ');
}

/** "Direct" or "via Core" for a review request to the viewer, or undefined when unknown. */
function requestedViaLabel(pullRequest: PullRequestSummary): string | undefined {
  if (pullRequest.requestedVia === 'you') return 'Direct';
  if (pullRequest.requestedVia !== 'team') return undefined;
  const teams = (pullRequest.requestedReviewers ?? []).filter((reviewer) => reviewer.team);
  return teams.length === 1 && teams[0] !== undefined ? `via ${teams[0].name}` : 'via team';
}

/** Split `owner/name` so the name can lead the row. */
function splitRepository(fullName: string): { readonly owner: string; readonly name: string } {
  const slash = fullName.indexOf('/');
  return slash < 0 ? { owner: '', name: fullName } : { owner: fullName.slice(0, slash), name: fullName.slice(slash + 1) };
}

/** Split a Conventional Commits prefix such as `feat(scope):` off a PR title, so the subject leads the row. */
function splitCommitType(title: string): { readonly type?: string; readonly subject: string } {
  const match = /^([a-z]+(?:\([^)]*\))?!?):\s+(\S.*)$/iu.exec(title);
  return match === null ? { subject: title } : { type: match[1] as string, subject: match[2] as string };
}

function pullRequestsOf(listing: Ready, role: PullRequestRole, author?: string): readonly PullRequestSummary[] {
  const all = role === 'author' ? listing.mine : listing.reviewRequested;
  return author === undefined ? all : all.filter((pullRequest) => pullRequest.author === author);
}

/** "3d ago", or the date after a month. */
export function ago(iso: string, now = Date.now()): string {
  const minutes = Math.floor((now - Date.parse(iso)) / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  if (minutes < 24 * 60) return `${Math.floor(minutes / 60)}h ago`;
  if (minutes < 30 * 24 * 60) return `${Math.floor(minutes / (24 * 60))}d ago`;
  return new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
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
  readonly #changed = new vscode.EventEmitter<Node | Node[] | undefined>();
  readonly onDidChangeTreeData = this.#changed.event;
  #checkouts: Promise<readonly PullRequestCheckout[]> | undefined;
  #listed: readonly PullRequestCheckout[] = [];
  readonly #listings = new Map<string, Promise<Listing>>();
  readonly #done = new Map<string, Listing>();
  #saving: Promise<void> = Promise.resolve();
  readonly #queue = limited(parallelListings);
  readonly #files = new Map<string, Promise<readonly { readonly path: string }[]>>();
  /** The rows shown for each PR by placement, so a change to one PR redraws only its rows. */
  readonly #rows = new Map<string, Map<Placement, PullRequestNode>>();
  /** Each repository's open PRs, loaded once its All open group is expanded. */
  readonly #allOpen = new Map<string, Promise<readonly PullRequestSummary[]>>();
  /** Worktree and reviewed state per PR, read once per redraw. */
  readonly #checkedOut = new Map<string, Promise<boolean>>();
  readonly #reviewed = new Map<string, Promise<ReadonlySet<string>>>();
  readonly #local = new Map<string, ReturnType<PullRequestWorktrees['localChanges']>>();
  /** PRs merged from this window; GitHub's search keeps listing them as open for a while. */
  readonly #merged = new Set<string>();
  /** Each listed repository's latest PR update at the last check. */
  readonly #versions = new Map<string, ListVersion>();
  /** GitHub search can lag behind a change, so the check after one reloads again. */
  #settling = false;
  /** Fresh lists were shown once; later reloads keep the rows still instead of adding a message above them. */
  #loadedOnce = false;

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

  get #pins(): readonly Pin[] {
    return this.workspace.get<readonly Pin[]>(pinnedKey, []);
  }

  /** Pin PRs, or move pinned ones, before `before` or at the end. */
  async pin(nodes: readonly PullRequestNode[], before?: PullRequestNode): Promise<void> {
    const moving = nodes.map((node): Pin => ({ repository: node.listing.repository.name, role: node.role, pullRequest: node.pullRequest }));
    const keys = new Set(moving.map(pinKey));
    const pins = this.#pins.filter((pin) => !keys.has(pinKey(pin)));
    const at = before === undefined ? -1 : pins.findIndex((pin) => pinKey(pin) === pullRequestKey(before));
    pins.splice(at < 0 ? pins.length : at, 0, ...moving);
    await this.workspace.update(pinnedKey, pins);
    this.#changed.fire(undefined);
  }

  async unpin(key: string): Promise<void> {
    const pins = this.#pins;
    if (!pins.some((pin) => pinKey(pin) === key)) return;
    await this.workspace.update(pinnedKey, pins.filter((pin) => pinKey(pin) !== key));
    this.#changed.fire(undefined);
  }

  /** A listing's PRs in a role section: those by the chosen author, without the pinned ones; in Mine only those awaiting review while that filter is on. */
  #sectionOf(listing: Ready, role: PullRequestRole): readonly PullRequestSummary[] {
    const pinned = new Set(this.#pins.map(pinKey));
    const awaitingOnly = role === 'author' && this.awaitingReviewOnly;
    return pullRequestsOf(listing, role, this.author).filter((pullRequest) => !pinned.has(`${listing.repository.name}#${pullRequest.number}`)
      && (!awaitingOnly || pullRequest.requestedReviewers !== undefined));
  }

  /** Remember a row by its PR and placement, so `redraw` reaches it. */
  #row(row: PullRequestNode): PullRequestNode {
    const key = pullRequestKey(row);
    const placed = this.#rows.get(key) ?? new Map<Placement, PullRequestNode>();
    placed.set(row.placement ?? row.role, row);
    this.#rows.set(key, placed);
    return row;
  }

  /** Whether Mine lists only PRs with pending review requests. */
  get awaitingReviewOnly(): boolean {
    return this.workspace.get<boolean>(awaitingReviewKey, false);
  }

  async setAwaitingReviewOnly(only: boolean): Promise<void> {
    await this.workspace.update(awaitingReviewKey, only ? true : undefined);
    this.#changed.fire(undefined);
  }

  /** A repository's open PRs by the chosen author, searched once until refresh. */
  async #allOpenOf(listing: Ready): Promise<readonly PullRequestSummary[]> {
    let all = this.#allOpen.get(listing.folder);
    if (all === undefined) {
      all = listing.provider.search('is:open sort:updated-desc');
      all.catch(() => { this.#allOpen.delete(listing.folder); });
      this.#allOpen.set(listing.folder, all);
    }
    const author = this.author;
    return (await all).filter((pullRequest) => author === undefined || pullRequest.author === author);
  }

  /** A repository's open PR count for its All open row; unknown while an author filter is on, since the count covers every author. */
  #openCountOf(listing: Ready): number | undefined {
    return this.author === undefined ? listing.openCount : undefined;
  }

  /** Open the review page of a PR named by a GitHub link or `owner/name#57`, from the workspace folder that holds its repository. */
  async openLink(link: string): Promise<void> {
    const parsed = parsePullRequestLink(link);
    if (parsed === undefined) throw new Error(`Not a GitHub PR link: ${link.trim()}`);
    const fullName = `${parsed.owner}/${parsed.name}`;
    const listing = await this.#listingFor(parsed.host, fullName);
    if (listing === undefined) throw new Error(`No workspace folder holds ${fullName}. Open a clone of it to review #${parsed.number}.`);
    const pullRequest = await listing.provider.pullRequest(parsed.number);
    if (pullRequest === undefined) throw new Error(`${fullName} has no PR #${parsed.number}.`);
    const role: PullRequestRole = listing.mine.some((mine) => mine.number === pullRequest.number) ? 'author' : 'reviewer';
    await listing.worktrees.showOverview(listing.provider, listing.repository.name, pullRequest, role);
  }

  /** The listing of a repository by name, among hidden folders too; `host` must match when given. */
  async #listingFor(host: string | undefined, fullName: string): Promise<Ready | undefined> {
    const matches = (listing: Listing): listing is Ready => listing.kind === 'ready' && listing.repository.name.toLowerCase() === fullName.toLowerCase()
      && (host === undefined || new URL(listing.repository.url).host.toLowerCase() === host);
    for (const checkout of await this.#allCheckouts()) {
      const listing = await this.#listingOf(checkout);
      if (matches(listing)) return listing;
    }
    return undefined;
  }

  /** Pinned PRs of the loaded repositories, in the user's order, with their freshest summary. */
  #pinnedRows(ready: readonly Ready[]): PullRequestNode[] {
    return this.#pins.flatMap((pin) => {
      const listing = ready.find((each) => each.repository.name === pin.repository);
      if (listing === undefined) return [];
      const fresh = [...listing.mine, ...listing.reviewRequested].find((pullRequest) => pullRequest.number === pin.pullRequest.number);
      return [this.#row({ kind: 'pullRequest', listing, role: pin.role, pullRequest: fresh ?? pin.pullRequest, pinned: true, placement: 'pinned' })];
    });
  }

  /** Drop pins of a freshly listed repository whose PRs were merged or closed, and refresh the summaries of those its searches no longer list. */
  async #refreshPins(listing: Ready): Promise<void> {
    const listed = new Set([...listing.mine, ...listing.reviewRequested].map((pullRequest) => pullRequest.number));
    const unlisted = this.#pins.filter((pin) => pin.repository === listing.repository.name && !listed.has(pin.pullRequest.number));
    if (unlisted.length === 0) return;
    const open = await listing.provider.openPullRequests(unlisted.map((pin) => pin.pullRequest.number)).catch(() => undefined);
    if (open === undefined) return;
    const fresh = new Map(open.map((pullRequest) => [pullRequest.number, pullRequest]));
    await this.workspace.update(pinnedKey, this.#pins.flatMap((pin) => {
      if (pin.repository !== listing.repository.name || listed.has(pin.pullRequest.number)) return [pin];
      const pullRequest = fresh.get(pin.pullRequest.number);
      return pullRequest === undefined ? [] : [{ ...pin, pullRequest }];
    }));
  }

  /** Only PRs by this author are listed, when set. */
  get author(): string | undefined {
    return this.workspace.get<string>(authorKey);
  }

  /** Let the user pick an author among the listed PRs, or all authors. */
  async chooseAuthor(): Promise<void> {
    const authors = new Set([...this.#done.values()].flatMap((listing) => listing.kind === 'ready' ? [...listing.mine, ...listing.reviewRequested].map((pr) => pr.author) : []));
    const all = '$(clear-all) All authors';
    const picked = await vscode.window.showQuickPick([all, ...[...authors].sort((a, b) => a.localeCompare(b))], { title: 'Show PRs by', placeHolder: 'Type to filter' });
    if (picked === undefined) return;
    await this.workspace.update(authorKey, picked === all ? undefined : picked);
    this.#changed.fire(undefined);
  }

  /** Find a PR of a listed repository with GitHub search, including closed ones, and open its review page. */
  async search(): Promise<void> {
    const ready = [...this.#done.values()].filter((listing): listing is Ready => listing.kind === 'ready');
    if (ready.length === 0) throw new Error('No repository with pull requests has loaded yet.');
    const listing = ready.length === 1 ? ready[0]
      : (await vscode.window.showQuickPick(ready.map((each) => ({ label: each.repository.name, listing: each })), { title: 'Search pull requests in' }))?.listing;
    if (listing === undefined) return;
    const custom = '$(search) Search with GitHub syntax…';
    const presets: readonly { readonly label: string; readonly query: string }[] = [
      { label: 'Assigned to you', query: 'is:open assignee:@me' },
      { label: 'Mentioning you', query: 'is:open mentions:@me' },
      { label: 'All open', query: 'is:open sort:updated-desc' },
      { label: 'Recently closed or merged', query: 'is:closed sort:updated-desc' },
    ];
    const preset = await vscode.window.showQuickPick([...presets.map((entry) => ({ label: entry.label, description: entry.query })), { label: custom, description: '' }],
      { title: `Search pull requests in ${listing.repository.name}` });
    if (preset === undefined) return;
    const query = preset.label === custom
      ? await vscode.window.showInputBox({ title: 'Search pull requests', prompt: 'GitHub search syntax, such as "is:open label:bug" or "author:alice"', value: 'is:open ' })
      : preset.description;
    if (query === undefined || !query.trim()) return;
    const found = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Searching pull requests' }, () => listing.provider.search(query.trim()));
    if (found.length === 0) { void vscode.window.showInformationMessage(`No pull requests match "${query.trim()}".`); return; }
    const picked = await vscode.window.showQuickPick(found.map((pullRequest) => ({
      label: `#${pullRequest.number} ${pullRequest.title}`, description: [pullRequest.author, pullRequest.draft ? 'Draft' : undefined, `${pullRequest.headBranch} → ${pullRequest.baseBranch}`].filter(Boolean).join(' · '), pullRequest,
    })), { title: `${found.length} pull requests`, matchOnDescription: true });
    if (picked === undefined) return;
    const role: PullRequestRole = listing.mine.some((mine) => mine.number === picked.pullRequest.number) ? 'author' : 'reviewer';
    await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Opening #${picked.pullRequest.number}` },
      () => listing.worktrees.showOverview(listing.provider, listing.repository.name, picked.pullRequest, role));
  }

  refresh(): void {
    this.#checkouts = undefined;
    this.#listings.clear();
    this.#done.clear();
    this.#files.clear();
    this.#rows.clear();
    this.#allOpen.clear();
    this.#forgetState();
    for (const checkout of this.#listed) checkout.worktrees.forget();
    this.#changed.fire(undefined);
  }

  /** Reload the list when a PR in a listed repository changed on GitHub since the last check. */
  async pollGitHub(): Promise<void> {
    const ready = [...this.#done.values()].filter((listing): listing is Ready => listing.kind === 'ready');
    const changes = await Promise.all(ready.map(async ({ provider, repository }) => {
      const known = this.#versions.get(repository.name);
      const next = await provider.listVersion(known).catch(() => known);
      if (next !== undefined) this.#versions.set(repository.name, next);
      return known !== undefined && next !== undefined && next.latest !== known.latest;
    }));
    const changed = changes.includes(true);
    if (changed || this.#settling) this.refresh();
    this.#settling = changed;
  }

  /** Show a PR as merged from now on, keyed `repository#number`. */
  markMerged(pullRequest: string): void {
    this.#merged.add(pullRequest);
    this.redraw(pullRequest);
    void this.unpin(pullRequest);
  }

  /** Redraw checkout state without querying the code host again: one PR's rows when it is shown, else the whole tree. */
  redraw(pullRequest?: string): void {
    const rows = pullRequest === undefined ? undefined : this.#rows.get(pullRequest);
    this.#forgetState(rows === undefined ? undefined : pullRequest);
    this.#changed.fire(rows === undefined ? undefined : [...rows.values()]);
  }

  #forgetState(pullRequest?: string): void {
    if (pullRequest === undefined) {
      this.#checkedOut.clear();
      this.#reviewed.clear();
      this.#local.clear();
    } else {
      this.#checkedOut.delete(pullRequest);
      this.#reviewed.delete(pullRequest);
      this.#local.delete(pullRequest);
    }
  }

  async getChildren(node?: Node): Promise<Node[]> {
    if (node === undefined) return await this.#rootChildren();
    if (node.kind === 'role') {
      return node.listings.length === 0
        ? [{ kind: 'message', text: 'No open PRs', icon: 'check' }]
        : node.listings.map((listing) => ({ kind: 'repository', listing, role: node.role }));
    }
    if (node.kind === 'pinned') return [...node.rows];
    if (node.kind === 'repository' && node.role === undefined) {
      return [
        ...roles.filter((role) => this.#sectionOf(node.listing, role).length > 0).map((role): Node => ({ kind: 'section', listing: node.listing, role })),
        { kind: 'allOpen', listing: node.listing },
      ];
    }
    if (node.kind === 'repository' || node.kind === 'section') {
      const role = node.role as PullRequestRole;
      return this.#sectionOf(node.listing, role).map((pullRequest) => this.#row({ kind: 'pullRequest', listing: node.listing, role, pullRequest }));
    }
    if (node.kind === 'allOpenRoot') return node.listings.map((listing): Node => ({ kind: 'allOpen', listing }));
    if (node.kind === 'allOpen') {
      const { listing } = node;
      try {
        const all = await this.#allOpenOf(listing);
        if (all.length === 0) return [{ kind: 'message', text: 'No open PRs', icon: 'check' }];
        const mine = new Set(listing.mine.map((pullRequest) => pullRequest.number));
        return all.map((pullRequest) => this.#row({ kind: 'pullRequest', listing, role: mine.has(pullRequest.number) ? 'author' : 'reviewer', pullRequest, placement: 'allOpen' }));
      } catch (error: unknown) {
        return [{ kind: 'message', text: error instanceof Error ? error.message : String(error), icon: 'warning' }];
      }
    }
    return [];
  }

  async getTreeItem(node: Node): Promise<vscode.TreeItem> {
    switch (node.kind) {
      case 'pinned': {
        const item = new vscode.TreeItem('BOOKMARKS', vscode.TreeItemCollapsibleState.Expanded);
        item.id = 'pinned';
        item.iconPath = new vscode.ThemeIcon('diffguide-bookmark');
        item.description = String(node.rows.length);
        item.tooltip = 'Drag PRs here to bookmark them, and within this section to reorder them.';
        return item;
      }
      case 'role': {
        const item = new vscode.TreeItem(sectionLabels[node.role].toUpperCase(), vscode.TreeItemCollapsibleState.Expanded);
        item.id = `role:${node.role}`;
        item.iconPath = new vscode.ThemeIcon(roleIcons[node.role]);
        item.description = String(node.listings.reduce((sum, listing) => sum + this.#sectionOf(listing, node.role).length, 0));
        return item;
      }
      case 'repository': {
        const { listing, role } = node;
        const { owner, name } = splitRepository(listing.repository.name);
        const item = new vscode.TreeItem(name, vscode.TreeItemCollapsibleState.Expanded);
        item.id = `repository:${role ?? ''}:${listing.folder}`;
        item.iconPath = repositoryIcon;
        const counts = role === undefined
          ? roles.filter((each) => this.#sectionOf(listing, each).length > 0).map((each) => `${this.#sectionOf(listing, each).length} ${each === 'author' ? 'mine' : 'review'}`).join(' · ')
          : String(this.#sectionOf(listing, role).length);
        item.description = [owner, counts].filter(Boolean).join(' · ');
        item.tooltip = listing.folder;
        item.contextValue = 'diffGuide.repository';
        return item;
      }
      case 'section': {
        const item = new vscode.TreeItem(sectionLabels[node.role], vscode.TreeItemCollapsibleState.Expanded);
        item.id = `section:${node.role}:${node.listing.folder}`;
        item.iconPath = new vscode.ThemeIcon(roleIcons[node.role]);
        item.description = String(this.#sectionOf(node.listing, node.role).length);
        return item;
      }
      case 'allOpenRoot': {
        const item = new vscode.TreeItem('ALL OPEN', vscode.TreeItemCollapsibleState.Collapsed);
        item.iconPath = new vscode.ThemeIcon('diffguide-stack');
        const counts = node.listings.map((listing) => this.#openCountOf(listing));
        if (counts.every((count) => count !== undefined)) item.description = String(counts.reduce((sum, count) => sum + count, 0));
        return item;
      }
      case 'allOpen': {
        const { owner, name } = splitRepository(node.listing.repository.name);
        const item = new vscode.TreeItem(this.byRole ? name : 'All open', vscode.TreeItemCollapsibleState.Collapsed);
        item.iconPath = this.byRole ? repositoryIcon : new vscode.ThemeIcon('diffguide-stack');
        const count = this.#openCountOf(node.listing);
        const description = [this.byRole ? owner : undefined, count === undefined ? undefined : String(count)].filter(Boolean).join(' · ');
        if (description) item.description = description;
        item.tooltip = `Every open PR in ${node.listing.repository.name}`;
        return item;
      }
      case 'pullRequest': {
        const pr = node.pullRequest;
        const checkedOut = await this.#isCheckedOut(node);
        const { type, subject } = splitCommitType(pr.title);
        const item = new vscode.TreeItem(subject, vscode.TreeItemCollapsibleState.None);
        item.id = `pullRequest:${node.placement ?? node.role}:${node.listing.folder}:${pr.number}`;
        item.resourceUri = pullRequestRowUri(node.listing.repository.name, pr.number, checkedOut);
        const claude = checkedOut ? node.listing.worktrees.claudeStatus(node.listing.repository.name, pr.number) : undefined;
        const progress = checkedOut ? await this.#progress(node) : undefined;
        const local = checkedOut ? await this.#localOf(node).catch(() => undefined) : undefined;
        const ahead = local === undefined || local.commits === 0 ? undefined : `↑${local.commits}`;
        const edited = local === undefined ? 0 : [...local.files.values()].filter((change) => change !== 'unpushed').length;
        const merged = this.#merged.has(pullRequestKey(node));
        const verdict = pr.review === undefined || merged ? undefined : verdicts[pr.review];
        const size = pr.changes === undefined ? undefined : `+${pr.changes.additions} −${pr.changes.deletions}`;
        const pinnedFrom = node.pinned === true ? [splitRepository(node.listing.repository.name).name, node.role === 'author' ? 'mine' : 'review'] : [];
        const awaitingReview = node.role === 'author' && !merged && pr.requestedReviewers !== undefined;
        const via = node.role === 'reviewer' && node.placement !== 'allOpen' ? requestedViaLabel(pr) : undefined;
        item.description = [`#${pr.number}`, ...pinnedFrom, type, verdict?.label, awaitingReview ? 'Awaiting review' : undefined, via, pr.author, merged ? 'Merged' : pr.draft ? 'Draft' : undefined, claude ?? (checkedOut ? 'Worktree' : undefined), ahead, edited === 0 ? undefined : `✎${edited}`, progress, size].filter(Boolean).join(' · ');
        item.tooltip = [
          `#${pr.number} ${pr.title}`,
          `${pr.headBranch} → ${pr.baseBranch}`,
          ahead === undefined ? undefined : `${local?.commits} ${local?.commits === 1 ? 'commit' : 'commits'} in the worktree not pushed to GitHub`,
          edited === 0 ? undefined : `${edited} ${edited === 1 ? 'file' : 'files'} with uncommitted edits`,
          verdict?.label,
          pr.requestedReviewers === undefined ? undefined : `Review requested from ${reviewerNames(pr)}`,
          via === undefined ? undefined : pr.requestedVia === 'you' ? 'You were asked directly' : 'You were asked through a team',
          pr.changes === undefined ? undefined : `${size} in ${pr.changes.files} ${pr.changes.files === 1 ? 'file' : 'files'}`,
          [pr.createdAt === undefined ? undefined : `Opened ${new Date(pr.createdAt).toLocaleString()}`, pr.updatedAt === undefined ? undefined : `updated ${ago(pr.updatedAt)}`].filter(Boolean).join(', ') || undefined,
        ].filter(Boolean).join('\n');
        item.iconPath = merged ? mergedIcon : pullRequestIcon(pr.draft, pr.review, awaitingReview);
        item.contextValue = `diffGuide.pullRequest${checkedOut ? '.checkedOut' : ''}${node.pinned === true ? '.pinned' : ''}`;
        item.command = { command: 'diffGuide.openPullRequest', title: 'Open changes', arguments: [node] };
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

  #filesOf(node: PullRequestNode): Promise<readonly { readonly path: string }[]> {
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

  #localOf(node: PullRequestNode): ReturnType<PullRequestWorktrees['localChanges']> {
    const key = pullRequestKey(node);
    let local = this.#local.get(key);
    if (local === undefined) {
      local = node.listing.worktrees.localChanges(node.listing.repository.name, node.pullRequest.number, node.pullRequest.headOid);
      local.catch(() => { this.#local.delete(key); });
      this.#local.set(key, local);
    }
    return local;
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
    const author = this.author;
    this.describe([author === undefined ? undefined : `Author: ${author}`, this.awaitingReviewOnly ? 'Awaiting review' : undefined, shown.length < all.length ? `${all.length - shown.length} hidden` : undefined].filter(Boolean).join(' · ') || undefined);
    if (shown.length === 0 && all.length > 0) return [{ kind: 'message', text: 'All repositories are hidden', icon: 'eye-closed' }];
    const loading = Promise.all(shown.map((checkout) => this.#listingOf(checkout)));
    let listings: readonly Listing[];
    const cached = shown.every((checkout) => this.#done.has(checkout.folder)) ? undefined : await this.#cachedListings(shown);
    if (cached === undefined) {
      listings = await loading;
      this.#loadedOnce = true;
      this.report(undefined);
    } else {
      listings = cached;
      if (!this.#loadedOnce) this.report('Updating pull requests...');
      void loading.then(() => { this.#changed.fire(undefined); });
    }
    const failed = listings.flatMap((listing): Node[] => listing.kind === 'failed'
      ? [{ kind: 'message', text: shown.length === 1 ? listing.message : `${listing.folder}: ${listing.message}`, ...listing.signIn === undefined
        ? { icon: 'warning' } : { icon: 'account', command: { command: 'diffGuide.signInToGitHub', title: 'Sign in to GitHub', arguments: [listing.signIn] } } }]
      : []);
    const ready = listings.filter((listing): listing is Ready => listing.kind === 'ready');
    const signIn = ready.length === 0 ? listings.find((listing) => listing.kind === 'failed' && listing.signIn !== undefined) : undefined;
    void vscode.commands.executeCommand('setContext', 'diffGuide.gitHubSignIn', signIn?.kind === 'failed' ? signIn.signIn : undefined);
    if (signIn !== undefined) return [];
    if (ready.length === 0) return failed;
    const pinnedRows = this.#pinnedRows(ready);
    const pinned: Node[] = pinnedRows.length === 0 ? [] : [{ kind: 'pinned', rows: pinnedRows }];
    if (this.byRole) {
      return [...pinned, ...roles.map((role): Node => ({ kind: 'role', role, listings: ready.filter((listing) => this.#sectionOf(listing, role).length > 0) })),
        { kind: 'allOpenRoot', listings: ready }, ...failed];
    }
    const withPullRequests = ready.filter((listing) => roles.some((role) => this.#sectionOf(listing, role).length > 0));
    return [
      ...pinned,
      ...withPullRequests.length === 0 && pinned.length === 0 ? [{ kind: 'message', text: this.author === undefined ? 'No open PRs' : `No open PRs by ${this.author}`, icon: 'check' } as const] : [],
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
    if (listing.kind === 'ready') snapshot[listing.folder] = { repository: listing.repository, mine: listing.mine, reviewRequested: listing.reviewRequested, ...listing.openCount === undefined ? {} : { openCount: listing.openCount } };
    else delete snapshot[listing.folder];
    await this.workspace.update(snapshotKey, snapshot);
  }

  async #loadOne({ folder, connect, worktrees }: PullRequestCheckout): Promise<Listing> {
    try {
      const provider = await connect();
      const [repository, mine, reviewRequested, openCount] = await Promise.all([
        provider.readRepository(), provider.listMine(), provider.listReviewRequested(), provider.openCount().catch(() => undefined),
      ]);
      const listing: Ready = { kind: 'ready', folder, provider, worktrees, repository, mine, reviewRequested, ...openCount === undefined ? {} : { openCount } };
      await this.#refreshPins(listing);
      return listing;
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
    void vscode.commands.executeCommand('setContext', 'diffGuide.groupByRole', tree.byRole);
    void vscode.commands.executeCommand('setContext', 'diffGuide.authorFiltered', tree.author !== undefined);
    void vscode.commands.executeCommand('setContext', 'diffGuide.awaitingReviewOnly', tree.awaitingReviewOnly);
  };
  showMode();
  const report = (error: unknown): void => {
    void vscode.window.showErrorMessage(error instanceof Error ? error.message : String(error));
  };
  const legend = vscode.window.createTreeView('diffGuide.legend', { treeDataProvider: legendProvider });
  const dragAndDropController: vscode.TreeDragAndDropController<Node> = {
    dragMimeTypes: [pinMime],
    dropMimeTypes: [pinMime],
    handleDrag: (nodes, data) => {
      const rows = nodes.filter(isPullRequestNode);
      if (rows.length > 0) data.set(pinMime, new vscode.DataTransferItem(rows));
    },
    handleDrop: async (target, data) => {
      const dragged: unknown = data.get(pinMime)?.value;
      const rows = Array.isArray(dragged) ? dragged.filter(isPullRequestNode) : [];
      if (rows.length === 0) return;
      if (target?.kind === 'pinned') await tree.pin(rows);
      else if (target?.kind === 'pullRequest' && target.pinned === true) await tree.pin(rows, target);
    },
  };
  const view = vscode.window.createTreeView('diffGuide.pullRequests', { treeDataProvider: tree, dragAndDropController });
  const sync = pollWhileFocused(60_000, () => view.visible, () => tree.pollGitHub());
  return vscode.Disposable.from(
    view,
    legend,
    vscode.window.registerFileDecorationProvider(rowDecorationProvider),
    onDidChangeStatus((pullRequest) => { tree.redraw(pullRequest); }),
    vscode.commands.registerCommand('diffGuide.refreshPullRequests', () => { tree.refresh(); }),
    sync,
    view.onDidChangeVisibility(({ visible }) => { if (visible) sync.now(); }),
    vscode.commands.registerCommand('diffGuide.searchPullRequests', async () => {
      try {
        await tree.search();
      } catch (error: unknown) {
        report(error);
      }
    }),
    vscode.commands.registerCommand('diffGuide.pinPullRequest', async (node: unknown) => {
      if (isPullRequestNode(node)) await tree.pin([node]);
    }),
    vscode.commands.registerCommand('diffGuide.unpinPullRequest', async (node: unknown) => {
      if (isPullRequestNode(node)) await tree.unpin(pullRequestKey(node));
    }),
    vscode.commands.registerCommand('diffGuide.markPullRequestMerged', (key: unknown) => {
      if (typeof key === 'string') tree.markMerged(key);
    }),
    vscode.commands.registerCommand('diffGuide.groupByRole', async () => { await tree.setByRole(true); showMode(); }),
    vscode.commands.registerCommand('diffGuide.groupByRepository', async () => { await tree.setByRole(false); showMode(); }),
    vscode.commands.registerCommand('diffGuide.chooseRepositories', async () => { await tree.chooseRepositories(); }),
    vscode.commands.registerCommand('diffGuide.filterByAuthor', async () => { await tree.chooseAuthor(); showMode(); }),
    vscode.commands.registerCommand('diffGuide.filterByAuthorActive', async () => { await tree.chooseAuthor(); showMode(); }),
    vscode.commands.registerCommand('diffGuide.showAwaitingReviewOnly', async () => { await tree.setAwaitingReviewOnly(true); showMode(); }),
    vscode.commands.registerCommand('diffGuide.showAllMine', async () => { await tree.setAwaitingReviewOnly(false); showMode(); }),
    vscode.commands.registerCommand('diffGuide.openPullRequestLink', async () => {
      const link = await vscode.window.showInputBox({
        title: 'Open PR in DiffGuide', prompt: 'GitHub PR link, or owner/repo#57', placeHolder: 'https://github.com/owner/repo/pull/57',
        validateInput: (value) => !value.trim() || parsePullRequestLink(value) !== undefined ? undefined : 'Paste a GitHub PR link, such as https://github.com/owner/repo/pull/57',
      });
      if (link === undefined || !link.trim()) return;
      try {
        await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Opening PR' }, () => tree.openLink(link));
      } catch (error: unknown) {
        report(error);
      }
    }),
    vscode.commands.registerCommand('diffGuide.copyPullRequestLink', async (node: unknown) => {
      if (isPullRequestNode(node)) await vscode.env.clipboard.writeText(node.pullRequest.url);
    }),
    vscode.commands.registerCommand('diffGuide.hideRepository', async (node: unknown) => {
      if (isRepositoryNode(node)) await tree.hide(node);
    }),
    vscode.commands.registerCommand('diffGuide.openPullRequestInBrowser', async (node: unknown) => {
      if (isPullRequestNode(node)) await vscode.env.openExternal(vscode.Uri.parse(node.pullRequest.url));
    }),
    vscode.commands.registerCommand('diffGuide.openPullRequest', async (node: unknown) => {
      if (!isPullRequestNode(node)) return;
      try {
        await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: `Opening #${node.pullRequest.number}` },
          () => node.listing.worktrees.open(node.listing.provider, node.listing.repository.name, node.pullRequest, node.role),
        );
      } catch (error: unknown) {
        report(error);
      }
      tree.redraw(pullRequestKey(node));
    }),
    vscode.commands.registerCommand('diffGuide.showPullRequestClaude', async (node: unknown) => {
      if (!isPullRequestNode(node)) return;
      try {
        await node.listing.worktrees.showClaude(node.listing.provider, node.listing.repository.name, node.pullRequest, node.role);
      } catch (error: unknown) {
        report(error);
      }
      tree.redraw(pullRequestKey(node));
    }),
    vscode.commands.registerCommand('diffGuide.showPullRequestOverview', async (node: unknown) => {
      if (!isPullRequestNode(node)) return;
      try {
        await node.listing.worktrees.showOverview(node.listing.provider, node.listing.repository.name, node.pullRequest, node.role);
      } catch (error: unknown) {
        report(error);
      }
      tree.redraw(pullRequestKey(node));
    }),
    vscode.commands.registerCommand('diffGuide.removePullRequestWorktree', async (node: unknown) => {
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
