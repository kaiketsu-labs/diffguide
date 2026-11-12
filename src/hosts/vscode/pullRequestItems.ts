import * as vscode from 'vscode';
import type { ChangeRequestSummary, Forge, ForgeRepository, ReviewVerdict } from '../../core/forge.js';
import type { PullRequestRole } from '../../core/git/worktrees.js';
import type { GitHubSignInRequired } from '../../forges/github/githubApi.js';
import { workingIcon } from './claudeStatus.js';
import type { PullRequestWorktrees } from './pullRequestWorktrees.js';

export type Listing =
  | { readonly kind: 'ready'; readonly folder: string; readonly provider: Forge; readonly worktrees: PullRequestWorktrees; readonly repository: ForgeRepository; readonly mine: readonly ChangeRequestSummary[]; readonly reviewRequested: readonly ChangeRequestSummary[]; readonly openCount?: number }
  | { readonly kind: 'failed'; readonly folder: string; readonly message: string; readonly signIn?: GitHubSignInRequired['provider'] };

export type Ready = Extract<Listing, { kind: 'ready' }>;

/** Where a PR row sits, so a PR shown in two places redraws in both. */
export type Placement = 'pinned' | PullRequestRole | 'allOpen';

export type PullRequestNode = { readonly kind: 'pullRequest'; readonly listing: Ready; readonly role: PullRequestRole; readonly pullRequest: ChangeRequestSummary; readonly pinned?: true; readonly placement?: Placement };

export type RepositoryNode = { readonly kind: 'repository'; readonly listing: Ready; /** Set when grouped by role: the row then holds only that role's PRs. */ readonly role?: PullRequestRole };

export type Node =
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

export const groupByKey = 'diffGuide.groupBy';
export const hiddenKey = 'diffGuide.hiddenRepositories';
export const authorKey = 'diffGuide.authorFilter';
export const snapshotKey = 'diffGuide.pullRequestSnapshot';
export const pinnedKey = 'diffGuide.pinnedPullRequests';
export const awaitingReviewKey = 'diffGuide.awaitingReviewOnly';
export const pinMime = 'application/vnd.code.tree.diffguide.pullrequests';

/** A PR the user pinned, with its last known summary so it stays listed after it leaves the role searches, such as once reviewed. */
export interface Pin { readonly repository: string; readonly role: PullRequestRole; readonly pullRequest: ChangeRequestSummary }

export function pinKey(pin: Pin): string {
  return `${pin.repository}#${pin.pullRequest.number}`;
}

/** A repository's PR lists from the last load, shown at once while fresh ones load. */
export type Snapshot = Readonly<Record<string, { readonly repository: ForgeRepository; readonly mine: readonly ChangeRequestSummary[]; readonly reviewRequested: readonly ChangeRequestSummary[]; readonly openCount?: number }>>;

const pullRequestScheme = 'diffguide-pr';

/** A PR row's local state, worst first: commits GitHub does not have, uncommitted edits only, or checked out with nothing to push. */
type RowState = { readonly kind: 'ahead'; readonly commits: number } | { readonly kind: 'edited' } | { readonly kind: 'checkedOut' };

/** Address for a PR row, so the decoration can badge and color it by its local state. */
function pullRequestRowUri(repository: string, number: number, state: RowState | undefined): vscode.Uri {
  const query = state === undefined ? '' : state.kind === 'ahead' ? `ahead=${state.commits}` : state.kind;
  return vscode.Uri.from({ scheme: pullRequestScheme, path: `/${repository}/${number}`, query });
}

/** Badge PR rows by local state, and tint the title too when something is not on GitHub. */
export const rowDecorationProvider: vscode.FileDecorationProvider = {
  provideFileDecoration: (uri) => {
    if (uri.scheme !== pullRequestScheme) return undefined;
    if (uri.query === 'checkedOut') return new vscode.FileDecoration('W', 'Checked out in a worktree');
    if (uri.query === 'edited') return new vscode.FileDecoration('✎', 'Uncommitted edits in the worktree', new vscode.ThemeColor('charts.yellow'));
    const commits = Number(/^ahead=(\d+)$/u.exec(uri.query)?.[1]);
    // A badge holds at most two characters.
    if (commits > 0) return new vscode.FileDecoration(commits < 10 ? `↑${commits}` : '↑+', 'Commits not pushed to GitHub', new vscode.ThemeColor('charts.orange'));
    return undefined;
  },
};

/** How a checked-out PR's worktree differs from GitHub. */
function rowState(local: { readonly commits: number; readonly edited: number }): RowState {
  if (local.commits > 0) return { kind: 'ahead', commits: local.commits };
  return local.edited > 0 ? { kind: 'edited' } : { kind: 'checkedOut' };
}

/** A local repository the sidebar lists PRs for. */
export interface PullRequestCheckout {
  /** Folder named when its PRs cannot be listed. */
  readonly folder: string;
  connect(): Promise<Forge>;
  readonly worktrees: PullRequestWorktrees;
}

/** Repositories listed at once, so a folder of many repositories does not start dozens of GitHub requests together. */
export const parallelListings = 4;

/** Sidebar icon and label for each review verdict. */
const verdicts: Record<ReviewVerdict, { readonly icon: string; readonly color: string; readonly label: string }> = {
  approved: { icon: 'diffguide-ready', color: 'testing.iconPassed', label: 'Approved' },
  changes: { icon: 'diffguide-request-changes', color: 'testing.iconFailed', label: 'Changes requested' },
  commented: { icon: 'diffguide-comment', color: 'descriptionForeground', label: 'Commented' },
};

const repositoryIcon = new vscode.ThemeIcon('diffguide-repository', new vscode.ThemeColor('charts.purple'));

export const mergedIcon = new vscode.ThemeIcon('diffguide-merge', new vscode.ThemeColor('charts.purple'));

export const closedIcon = new vscode.ThemeIcon('diffguide-close-pull-request', new vscode.ThemeColor('charts.red'));

const awaitingReviewIcon = new vscode.ThemeIcon('diffguide-show', new vscode.ThemeColor('charts.yellow'));

/** A PR row's icon: its review verdict, else awaiting review, else open or draft. */
export function pullRequestIcon(draft: boolean, review?: ReviewVerdict, awaitingReview = false): vscode.ThemeIcon {
  if (review !== undefined) return new vscode.ThemeIcon(verdicts[review].icon, new vscode.ThemeColor(verdicts[review].color));
  if (awaitingReview && !draft) return awaitingReviewIcon;
  return draft
    ? new vscode.ThemeIcon('diffguide-draft-pull-request', new vscode.ThemeColor('descriptionForeground'))
    : new vscode.ThemeIcon('diffguide-pull-request', new vscode.ThemeColor('charts.green'));
}

/** Key to the Pull Requests icons and badge, drawn with the same icons as the rows. */
export const legendProvider: vscode.TreeDataProvider<vscode.TreeItem> = {
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
      row('Commits not pushed to GitHub', pullRequestIcon(false), pullRequestRowUri('legend', 0, { kind: 'ahead', commits: 1 })),
      row('Uncommitted edits', pullRequestIcon(false), pullRequestRowUri('legend', 1, { kind: 'edited' })),
      row('Checked out in a worktree', pullRequestIcon(false), pullRequestRowUri('legend', 2, { kind: 'checkedOut' })),
    ];
  },
};

const sectionLabels: Record<PullRequestRole, string> = { author: 'Mine', reviewer: 'Review requested' };
const roleIcons: Record<PullRequestRole, string> = { author: 'diffguide-outbox', reviewer: 'diffguide-inbox' };
export const roles: readonly PullRequestRole[] = ['reviewer', 'author'];

/** "alice, team Core" for a PR's pending reviewers. */
function reviewerNames(pullRequest: ChangeRequestSummary): string {
  return (pullRequest.requestedReviewers ?? []).map((reviewer) => reviewer.team ? `team ${reviewer.name}` : reviewer.name).join(', ');
}

/** "Direct" or "via Core" for a review request to the viewer, or undefined when unknown. */
function requestedViaLabel(pullRequest: ChangeRequestSummary): string | undefined {
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

export function pullRequestsOf(listing: Ready, role: PullRequestRole, author?: string): readonly ChangeRequestSummary[] {
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
export function pullRequestKey(node: PullRequestNode): string {
  return `${node.listing.repository.name}#${node.pullRequest.number}`;
}

/** Run at most `count` tasks at once, starting the rest in call order. */
export function limited(count: number): <T>(task: () => Promise<T>) => Promise<T> {
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

type SectionOf = (listing: Ready, role: PullRequestRole) => readonly ChangeRequestSummary[];

export function pinnedItem(node: Extract<Node, { kind: 'pinned' }>): vscode.TreeItem {
  const item = new vscode.TreeItem('BOOKMARKS', vscode.TreeItemCollapsibleState.Expanded);
  item.id = 'pinned';
  item.iconPath = new vscode.ThemeIcon('diffguide-bookmark');
  item.description = String(node.rows.length);
  item.tooltip = 'Drag PRs here to bookmark them, and within this section to reorder them.';
  return item;
}

export function roleItem(node: Extract<Node, { kind: 'role' }>, sectionOf: SectionOf): vscode.TreeItem {
  const item = new vscode.TreeItem(sectionLabels[node.role].toUpperCase(), vscode.TreeItemCollapsibleState.Expanded);
  item.id = `role:${node.role}`;
  item.iconPath = new vscode.ThemeIcon(roleIcons[node.role]);
  item.description = String(node.listings.reduce((sum, listing) => sum + sectionOf(listing, node.role).length, 0));
  return item;
}

export function repositoryItem(node: RepositoryNode, sectionOf: SectionOf, toPush: number): vscode.TreeItem {
  const { listing, role } = node;
  const { owner, name } = splitRepository(listing.repository.name);
  const item = new vscode.TreeItem(name, vscode.TreeItemCollapsibleState.Expanded);
  item.id = `repository:${role ?? ''}:${listing.folder}`;
  item.iconPath = repositoryIcon;
  const counts = role === undefined
    ? roles.filter((each) => sectionOf(listing, each).length > 0).map((each) => `${sectionOf(listing, each).length} ${each === 'author' ? 'mine' : 'review'}`).join(' · ')
    : String(sectionOf(listing, role).length);
  item.description = [owner, counts, toPush === 0 ? undefined : `${toPush} to push`].filter(Boolean).join(' · ');
  item.tooltip = [listing.folder, toPush === 0 ? undefined : `${toPush} ${toPush === 1 ? 'PR has' : 'PRs have'} commits not pushed to GitHub`].filter(Boolean).join('\n');
  item.contextValue = 'diffGuide.repository';
  return item;
}

export function sectionItem(node: Extract<Node, { kind: 'section' }>, sectionOf: SectionOf): vscode.TreeItem {
  const item = new vscode.TreeItem(sectionLabels[node.role], vscode.TreeItemCollapsibleState.Expanded);
  item.id = `section:${node.role}:${node.listing.folder}`;
  item.iconPath = new vscode.ThemeIcon(roleIcons[node.role]);
  item.description = String(sectionOf(node.listing, node.role).length);
  return item;
}

export function allOpenRootItem(node: Extract<Node, { kind: 'allOpenRoot' }>, openCountOf: (listing: Ready) => number | undefined): vscode.TreeItem {
  const item = new vscode.TreeItem('ALL OPEN', vscode.TreeItemCollapsibleState.Collapsed);
  item.iconPath = new vscode.ThemeIcon('diffguide-stack');
  const counts = node.listings.map((listing) => openCountOf(listing));
  if (counts.every((count) => count !== undefined)) item.description = String(counts.reduce((sum, count) => sum + count, 0));
  return item;
}

export function allOpenItem(node: Extract<Node, { kind: 'allOpen' }>, byRole: boolean, openCountOf: (listing: Ready) => number | undefined): vscode.TreeItem {
  const { owner, name } = splitRepository(node.listing.repository.name);
  const item = new vscode.TreeItem(byRole ? name : 'All open', vscode.TreeItemCollapsibleState.Collapsed);
  item.iconPath = byRole ? repositoryIcon : new vscode.ThemeIcon('diffguide-stack');
  const count = openCountOf(node.listing);
  const description = [byRole ? owner : undefined, count === undefined ? undefined : String(count)].filter(Boolean).join(' · ');
  if (description) item.description = description;
  item.tooltip = `Every open PR in ${node.listing.repository.name}`;
  return item;
}

/** What a PR row reads from the tree, which caches it per PR. */
export interface PullRequestRowLookups {
  isCheckedOut(node: PullRequestNode): Promise<boolean>;
  progress(node: PullRequestNode): Promise<string | undefined>;
  localOf(node: PullRequestNode): ReturnType<PullRequestWorktrees['localChanges']>;
  isMerged(node: PullRequestNode): boolean;
  /** Record whether the row shows commits to push, so a change redraws its repository rows. */
  noteAhead(node: PullRequestNode, ahead: boolean): void;
}

export async function pullRequestItem(node: PullRequestNode, lookups: PullRequestRowLookups): Promise<vscode.TreeItem> {
  const pr = node.pullRequest;
  const checkedOut = await lookups.isCheckedOut(node);
  const { subject } = splitCommitType(pr.title);
  const item = new vscode.TreeItem(subject, vscode.TreeItemCollapsibleState.None);
  item.id = `pullRequest:${node.placement ?? node.role}:${node.listing.folder}:${pr.number}`;
  const claude = checkedOut ? node.listing.worktrees.claudeStatus(node.listing.repository.name, pr.number) : undefined;
  const progress = checkedOut ? await lookups.progress(node) : undefined;
  const local = checkedOut ? await lookups.localOf(node).catch(() => undefined) : undefined;
  const commits = local?.commits ?? 0;
  const edited = local === undefined ? 0 : [...local.files.values()].filter((change) => change !== 'unpushed').length;
  item.resourceUri = pullRequestRowUri(node.listing.repository.name, pr.number, checkedOut ? rowState({ commits, edited }) : undefined);
  lookups.noteAhead(node, commits > 0);
  const merged = lookups.isMerged(node);
  const verdict = pr.review === undefined || merged ? undefined : verdicts[pr.review];
  const size = pr.changes === undefined ? undefined : `+${pr.changes.additions} −${pr.changes.deletions}`;
  const pinnedFrom = node.pinned === true ? [splitRepository(node.listing.repository.name).name, node.role === 'author' ? 'mine' : 'review'] : [];
  const awaitingReview = node.role === 'author' && !merged && pr.requestedReviewers !== undefined;
  const via = node.role === 'reviewer' && node.placement !== 'allOpen' ? requestedViaLabel(pr) : undefined;
  const author = node.role === 'author' ? undefined : pr.author;
  // The badge carries the commit count, so edits show their count here only beside unpushed commits.
  const editedBesideCommits = commits > 0 && edited > 0 ? `✎${edited}` : undefined;
  const busyClaude = claude === 'Claude idle' ? undefined : claude;
  item.description = [`#${pr.number}`, ...pinnedFrom, editedBesideCommits, via, author, busyClaude, progress].filter(Boolean).join(' · ');
  item.tooltip = [
    `#${pr.number} ${pr.title}`,
    `${pr.headBranch} → ${pr.baseBranch}`,
    commits === 0 ? undefined : `${commits} ${commits === 1 ? 'commit' : 'commits'} not pushed to GitHub`,
    edited === 0 ? undefined : `${edited} ${edited === 1 ? 'file' : 'files'} with uncommitted edits`,
    [merged ? 'Merged' : pr.draft ? 'Draft' : undefined, awaitingReview ? 'Awaiting review' : undefined, verdict?.label, claude].filter(Boolean).join(' · ') || undefined,
    node.role === 'author' ? undefined : `By ${pr.author}`,
    pr.requestedReviewers === undefined ? undefined : `Review requested from ${reviewerNames(pr)}`,
    via === undefined ? undefined : pr.requestedVia === 'you' ? 'You were asked directly' : 'You were asked through a team',
    pr.changes === undefined ? undefined : `${size} in ${pr.changes.files} ${pr.changes.files === 1 ? 'file' : 'files'}`,
    [pr.createdAt === undefined ? undefined : `Opened ${new Date(pr.createdAt).toLocaleString()}`, pr.updatedAt === undefined ? undefined : `updated ${ago(pr.updatedAt)}`].filter(Boolean).join(', ') || undefined,
  ].filter(Boolean).join('\n');
  item.iconPath = checkedOut && node.listing.worktrees.working(node.listing.repository.name, pr.number) ? workingIcon : merged ? mergedIcon : pullRequestIcon(pr.draft, pr.review, awaitingReview);
  item.contextValue = `diffGuide.pullRequest${checkedOut ? '.checkedOut' : ''}${node.pinned === true ? '.pinned' : ''}`;
  item.command = { command: 'diffGuide.openPullRequest', title: 'Open changes', arguments: [node] };
  return item;
}

export function messageItem(node: Extract<Node, { kind: 'message' }>): vscode.TreeItem {
  const item = new vscode.TreeItem(node.text, vscode.TreeItemCollapsibleState.None);
  item.iconPath = new vscode.ThemeIcon(node.icon);
  if (node.command !== undefined) item.command = node.command;
  return item;
}
