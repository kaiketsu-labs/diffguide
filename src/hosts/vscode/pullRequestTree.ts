import * as vscode from 'vscode';
import type { ChangeRequestSummary, ListVersion } from '../../core/forge.js';
import type { PullRequestRole } from '../../core/git/worktrees.js';
import { GitHubSignInRequired } from '../../forges/github/githubApi.js';
import { parsePullRequestLink } from '../../forges/github/remotes.js';
import {
  allOpenItem, allOpenRootItem, authorKey, awaitingReviewKey, groupByKey, hiddenKey, limited, messageItem, parallelListings, pinKey, pinnedItem, pinnedKey,
  pullRequestItem, pullRequestKey, pullRequestsOf, repositoryItem, roleItem, roles, sectionItem, snapshotKey,
  type Listing, type Node, type Pin, type Placement, type PullRequestCheckout, type PullRequestNode, type PullRequestRowLookups, type Ready, type RepositoryNode, type Snapshot,
} from './pullRequestItems.js';
import type { PullRequestWorktrees } from './pullRequestWorktrees.js';

/** List each repository's open pull requests by the user's role in them. */
export class PullRequestTree implements vscode.TreeDataProvider<Node> {
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
  /** The repository rows shown per repository name, so a PR's change also redraws their "to push" count. */
  readonly #repositoryRows = new Map<string, Set<RepositoryNode>>();
  /** Whether each PR row last showed commits to push, so only a change to that redraws its repository rows. */
  readonly #aheadShown = new Map<string, boolean>();
  /** Each repository's open PRs, loaded once its All open group is expanded. */
  readonly #allOpen = new Map<string, Promise<readonly ChangeRequestSummary[]>>();
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
  #sectionOf(listing: Ready, role: PullRequestRole): readonly ChangeRequestSummary[] {
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

  #repositoryRow(row: RepositoryNode): RepositoryNode {
    const name = row.listing.repository.name;
    const rows = this.#repositoryRows.get(name) ?? new Set<RepositoryNode>();
    rows.add(row);
    this.#repositoryRows.set(name, rows);
    return row;
  }

  /** How many of a repository row's PRs have commits not pushed to GitHub. */
  async #toPushOf(listing: Ready, role: PullRequestRole | undefined): Promise<number> {
    const ahead = await Promise.all((role === undefined ? roles : [role]).flatMap((each) => this.#sectionOf(listing, each).map(async (pullRequest) => {
      const node: PullRequestNode = { kind: 'pullRequest', listing, role: each, pullRequest };
      if (!await this.#isCheckedOut(node).catch(() => false)) return false;
      return ((await this.#localOf(node).catch(() => undefined))?.commits ?? 0) > 0;
    })));
    return ahead.filter(Boolean).length;
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
  async #allOpenOf(listing: Ready): Promise<readonly ChangeRequestSummary[]> {
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
    this.#repositoryRows.clear();
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
        : node.listings.map((listing) => this.#repositoryRow({ kind: 'repository', listing, role: node.role }));
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
    const sectionOf = (listing: Ready, role: PullRequestRole): readonly ChangeRequestSummary[] => this.#sectionOf(listing, role);
    const openCountOf = (listing: Ready): number | undefined => this.#openCountOf(listing);
    switch (node.kind) {
      case 'pinned': return pinnedItem(node);
      case 'role': return roleItem(node, sectionOf);
      case 'repository': return repositoryItem(node, sectionOf, await this.#toPushOf(node.listing, node.role));
      case 'section': return sectionItem(node, sectionOf);
      case 'allOpenRoot': return allOpenRootItem(node, openCountOf);
      case 'allOpen': return allOpenItem(node, this.byRole, openCountOf);
      case 'pullRequest': return await pullRequestItem(node, this.#rowLookups);
      case 'message': return messageItem(node);
    }
  }

  readonly #rowLookups: PullRequestRowLookups = {
    isCheckedOut: (node) => this.#isCheckedOut(node),
    progress: (node) => this.#progress(node),
    localOf: (node) => this.#localOf(node),
    isMerged: (node) => this.#merged.has(pullRequestKey(node)),
    noteAhead: (node, ahead) => {
      const shown = this.#aheadShown.get(pullRequestKey(node));
      this.#aheadShown.set(pullRequestKey(node), ahead);
      const repositoryRows = this.#repositoryRows.get(node.listing.repository.name);
      if (shown !== undefined && shown !== ahead && repositoryRows !== undefined) this.#changed.fire([...repositoryRows]);
    },
  };

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
      ...withPullRequests.map((listing): Node => this.#repositoryRow({ kind: 'repository', listing })),
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
