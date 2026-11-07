import { endpointsFor, githubPoll, githubRequest, type Polled } from './githubApi.js';
import { git } from './worktrees.js';

/** Open pull request shown in the sidebar, validated from provider output. */
export interface PullRequestSummary {
  readonly number: number;
  readonly title: string;
  readonly url: string;
  readonly author: string;
  readonly draft: boolean;
  readonly headBranch: string;
  readonly baseBranch: string;
  /** Strongest verdict among reviewers' latest reviews; absent when nobody reviewed yet. */
  readonly review?: ReviewVerdict;
  /** ISO times; absent in lists saved before they were read. */
  readonly createdAt?: string;
  readonly updatedAt?: string;
  /** Lines and files changed across the whole PR. */
  readonly changes?: { readonly additions: number; readonly deletions: number; readonly files: number };
  /** Reviewers asked for a review who have not reviewed since; absent when nobody is pending. */
  readonly requestedReviewers?: readonly RequestedReviewer[];
  /** In the viewer's review requests: whether GitHub asked the viewer directly or one of the viewer's teams. */
  readonly requestedVia?: 'you' | 'team';
}

/** A pending review request, to a person or a team; `name` is a login or a team's name. */
export interface RequestedReviewer { readonly name: string; readonly team: boolean }

export type ReviewVerdict = 'approved' | 'changes' | 'commented';

/** Changes requested outweighs approval, which outweighs plain comments. */
export function strongestVerdict(states: readonly string[]): ReviewVerdict | undefined {
  if (states.includes('CHANGES_REQUESTED')) return 'changes';
  if (states.includes('APPROVED')) return 'approved';
  if (states.includes('COMMENTED')) return 'commented';
  return undefined;
}

/** File changed by a pull request, as the code host reports it. */
export interface PullRequestFile {
  readonly path: string;
  readonly additions: number;
  readonly deletions: number;
  readonly change: 'added' | 'modified' | 'deleted' | 'renamed';
}

/** Repository whose pull requests the sidebar lists. */
export interface PullRequestRepository {
  readonly name: string;
  readonly url: string;
}

/** A comment for the PR's diff; without `lines` it applies to the whole file. */
export interface PullRequestComment {
  readonly path: string;
  readonly body: string;
  readonly commitId: string;
  readonly side: 'LEFT' | 'RIGHT';
  readonly lines?: { readonly start: number; readonly end: number };
}

/** A PR's description, review and CI state, as the overview shows them. */
export interface PullRequestDetails {
  /** Description already rendered and sanitized by the code host. */
  readonly bodyHtml: string;
  readonly title: string;
  /** The description as Markdown, for editing. */
  readonly body: string;
  readonly open: boolean;
  readonly merged: boolean;
  readonly draft: boolean;
  /** The viewer may edit the PR: title, description, labels, assignees, reviewers, draft and open state. */
  readonly canEdit: boolean;
  /** The head branch lives in this repository, still exists and GitHub does not delete it on merge. */
  readonly branchDeletable: boolean;
  readonly labels: readonly Label[];
  readonly assignees: readonly string[];
  readonly mergeable: 'yes' | 'no' | 'unknown';
  /** `owner/name` of the fork the head branch lives in; absent when it lives in this repository. */
  readonly headRepository?: string;
  readonly viewerIsAuthor: boolean;
  /** The signed-in user's GitHub avatar; empty when GitHub sent none. */
  readonly viewerAvatarUrl: string;
  /** The signed-in user's display name, or login when the profile has none; shown as initials when the avatar is missing. */
  readonly viewerName?: string;
  /** Comments in the viewer's unsubmitted review; undefined when there is no such review. */
  readonly pendingComments?: number;
  readonly mergeMethods: readonly MergeMethod[];
  /** `team` holds the team's slug for a requested team. */
  readonly reviewers: readonly { readonly name: string; readonly state: 'requested' | 'approved' | 'changes' | 'commented' | 'dismissed'; readonly team?: string }[];
  readonly checks: readonly { readonly name: string; readonly state: 'success' | 'failure' | 'pending' | 'neutral'; readonly url?: string }[];
  readonly milestone?: Milestone;
}

export interface Milestone { readonly number: number; readonly title: string }

export type ReactionContent = 'THUMBS_UP' | 'THUMBS_DOWN' | 'LAUGH' | 'HOORAY' | 'CONFUSED' | 'HEART' | 'ROCKET' | 'EYES';
export const reactionContents: readonly ReactionContent[] = ['THUMBS_UP', 'THUMBS_DOWN', 'LAUGH', 'HOORAY', 'CONFUSED', 'HEART', 'ROCKET', 'EYES'];

export interface ReactionCount { readonly content: ReactionContent; readonly count: number; readonly viewerReacted: boolean }

/** A comment anyone wrote on GitHub, with what the viewer may do to it. Bodies come rendered and sanitized by GitHub; `body` is the Markdown for editing and quoting. */
export interface GitHubComment {
  readonly id: string;
  readonly author: string;
  readonly authorName?: string;
  readonly avatarUrl: string;
  readonly createdAt: string;
  readonly bodyHtml: string;
  readonly body: string;
  readonly url?: string;
  readonly canEdit: boolean;
  readonly canDelete: boolean;
  readonly canHide: boolean;
  readonly canReact: boolean;
  /** Why it is hidden, such as "outdated"; absent when shown. */
  readonly hidden?: string;
  readonly edited: boolean;
  readonly reactions: readonly ReactionCount[];
}

/** One entry of a PR's Conversation tab, oldest first. */
export type TimelineItem =
  | (GitHubComment & { readonly kind: 'comment' })
  | (GitHubComment & { readonly kind: 'review'; readonly state: 'approved' | 'changes' | 'commented' | 'dismissed' | 'pending'; readonly commit?: string })
  | { readonly kind: 'commit'; readonly id: string; readonly oid: string; readonly headline: string; readonly message: string; readonly author: string; readonly avatarUrl: string; readonly createdAt: string; readonly checks?: 'success' | 'failure' | 'pending'
    /** Lines added and removed; `files` is missing when GitHub could not count them. */
    readonly additions?: number; readonly deletions?: number; readonly files?: number }
  | { readonly kind: 'event'; readonly id: string; readonly actor: string; readonly avatarUrl: string; readonly createdAt: string; readonly text: string };

export type MergeState = 'behind' | 'blocked' | 'clean' | 'dirty' | 'hasHooks' | 'unknown' | 'unstable';
export type RepositoryPermission = 'admin' | 'maintain' | 'write' | 'triage' | 'read' | 'none';

/** What GitHub's merge box knows beyond conflicts: branch protection, auto-merge and the merge queue. */
export interface MergeStatus {
  readonly state: MergeState;
  readonly reviewDecision?: 'approved' | 'changes' | 'required';
  readonly canUpdateBranch: boolean;
  /** The viewer may merge although branch protection blocks it. */
  readonly canBypass: boolean;
  readonly autoMerge?: { readonly method: MergeMethod; readonly enabledBy: string };
  readonly canEnableAutoMerge: boolean;
  readonly canDisableAutoMerge: boolean;
  /** The repository's settings allow auto-merge; GitHub offers it only while requirements are pending. */
  readonly autoMergeAllowed: boolean;
  readonly mergeQueue: boolean;
  /** 1-based place in the merge queue while queued. */
  readonly queuePosition?: number;
  readonly headOid: string;
  /** The head branch is gone from GitHub. */
  readonly headDeleted: boolean;
}

/** A check's extras for the merge box and the diff; `runId` is the GitHub Actions run, for re-running it. */
export interface CheckExtras { readonly name: string; readonly required: boolean; readonly runId?: number; readonly annotations: readonly Annotation[] }

/** A check's note on lines of the PR's version of a file. */
export interface Annotation { readonly path: string; readonly startLine: number; readonly endLine: number; readonly level: 'failure' | 'warning' | 'notice'; readonly title: string; readonly message: string }

/** How the repository words merge commits by default, as GitHub's merge box fills them in. */
export interface CommitDefaults {
  readonly squashTitle: 'PR_TITLE' | 'COMMIT_OR_PR_TITLE';
  readonly squashBody: 'PR_BODY' | 'COMMIT_MESSAGES' | 'BLANK';
  readonly mergeTitle: 'PR_TITLE' | 'MERGE_MESSAGE';
  readonly mergeBody: 'PR_TITLE' | 'PR_BODY' | 'BLANK';
}

/** The PR's Conversation tab and merge box extras, read apart from its details so older GitHub servers keep the rest of the page. */
export interface PullRequestConversation {
  readonly timeline: readonly TimelineItem[];
  /** The PR's own node, for reacting to its description. */
  readonly description: { readonly id: string; readonly reactions: readonly ReactionCount[]; readonly canReact: boolean };
  readonly viewerLogin: string;
  readonly permission: RepositoryPermission;
  readonly merge: MergeStatus;
  readonly checks: readonly CheckExtras[];
  readonly linkedIssues: readonly { readonly number: number; readonly title: string; readonly url: string; readonly open: boolean }[];
  /** Each reviewer's latest approving or change-requesting review, by login, for dismissing it. */
  readonly reviewIds: Readonly<Record<string, string>>;
  readonly commitDefaults: CommitDefaults;
  /** The head commit of the viewer's latest submitted review. */
  readonly lastReviewedCommit?: string;
  /** GitHub Actions runs from a fork waiting for a maintainer to approve them. */
  readonly awaitingApproval: readonly number[];
}

/** Optional merge commit wording; GitHub uses its defaults for what is left out. */
export interface MergeMessage { readonly headline?: string; readonly body?: string }

/** A diff comment thread on the code host, written by anyone. */
export interface RemoteThread {
  readonly id: string;
  readonly path: string;
  readonly side: 'LEFT' | 'RIGHT';
  readonly startLine: number;
  readonly endLine: number;
  /** The code changed since the comment, so its lines may no longer match. */
  readonly outdated: boolean;
  readonly resolved: boolean;
  readonly url: string;
  /** Still in the viewer's unsubmitted review, so only they see it. */
  readonly pending: boolean;
  readonly comments: readonly (GitHubComment & { readonly pending: boolean })[];
}

/** `description` is read only for the label picker. */
export interface Label { readonly name: string; readonly color: string; readonly description?: string }

/** Who can be asked to review, assigned or labeled on this repository. */
export interface PickerOptions {
  readonly users: readonly string[];
  readonly teams: readonly { readonly name: string; readonly slug: string }[];
  readonly labels: readonly Label[];
  readonly milestones: readonly Milestone[];
}

/** Users by login and teams by slug. */
export interface ReviewerSet { readonly users: readonly string[]; readonly teams: readonly string[] }

/** Fields to change on a PR; `labels` and `assignees` replace the current lists. */
export interface PullRequestEdit {
  readonly title?: string;
  readonly body?: string;
  readonly state?: 'open' | 'closed';
  readonly labels?: readonly string[];
  readonly assignees?: readonly string[];
  /** A milestone number, or null to clear it. */
  readonly milestone?: number | null;
}

/** Something on GitHub that holds comments and reactions, named by node id. */
export type CommentKind = 'issue' | 'review' | 'reviewComment';

export type ReviewEvent = 'approve' | 'requestChanges' | 'comment';
export type MergeMethod = 'merge' | 'squash' | 'rebase';
/** GitHub's reasons for hiding a comment. */
export type HideReason = 'OUTDATED' | 'RESOLVED' | 'DUPLICATE' | 'OFF_TOPIC' | 'LOW_QUALITY' | 'SPAM' | 'ABUSE';
const graphqlMethods: Record<MergeMethod, string> = { merge: 'MERGE', squash: 'SQUASH', rebase: 'REBASE' };

/** Pull request queries and the user's own review actions, implemented once per code host CLI. */
export interface PullRequestProvider {
  readRepository(): Promise<PullRequestRepository>;
  listMine(): Promise<readonly PullRequestSummary[]>;
  listReviewRequested(): Promise<readonly PullRequestSummary[]>;
  listFiles(number: number): Promise<readonly PullRequestFile[]>;
  /** Check the PR's head branch out into an existing worktree folder. */
  checkout(number: number, worktree: string): Promise<void>;
  /** Files the user marked "Viewed" on the code host. */
  viewedFiles(number: number): Promise<ReadonlySet<string>>;
  setViewed(number: number, path: string, viewed: boolean): Promise<void>;
  /** Post a diff comment, into the user's pending review or right away, and return its link. */
  publishComment(number: number, comment: PullRequestComment, pending: boolean): Promise<string>;
  details(number: number): Promise<PullRequestDetails>;
  threads(number: number): Promise<readonly RemoteThread[]>;
  /** Details and review threads together, in as few requests as the code host allows. */
  overview(number: number): Promise<{ readonly details: PullRequestDetails; readonly threads: readonly RemoteThread[] }>;
  /** Post a reply to a code host thread right away, visible to everyone. */
  replyToThread(threadId: string, body: string): Promise<void>;
  resolveThread(threadId: string, resolved: boolean): Promise<void>;
  /** Delete one review comment; deleting a thread's only comment removes the thread. */
  deleteComment(commentId: string): Promise<void>;
  /** Submit the user's review, including comments already in their pending review. */
  submitReview(number: number, event: ReviewEvent, body: string): Promise<void>;
  merge(number: number, method: MergeMethod, message?: MergeMessage): Promise<void>;
  editPullRequest(number: number, edit: PullRequestEdit): Promise<void>;
  setDraft(number: number, draft: boolean): Promise<void>;
  requestReviewers(number: number, reviewers: ReviewerSet): Promise<void>;
  removeReviewers(number: number, reviewers: ReviewerSet): Promise<void>;
  deleteBranch(branch: string): Promise<void>;
  pickerOptions(): Promise<PickerOptions>;
  /** Search this repository's PRs with GitHub search syntax, such as `is:closed` or `assignee:@me`. */
  search(query: string): Promise<readonly PullRequestSummary[]>;
  /** The PRs among `numbers` that are still open, read fresh. */
  openPullRequests(numbers: readonly number[]): Promise<readonly PullRequestSummary[]>;
  /** One PR in any state, or undefined when the repository has none with that number. */
  pullRequest(number: number): Promise<PullRequestSummary | undefined>;
  conversation(number: number): Promise<PullRequestConversation>;
  /** Post a comment on the PR itself, outside any review. */
  addComment(number: number, body: string): Promise<void>;
  editComment(kind: CommentKind, id: string, body: string): Promise<void>;
  /** Delete a comment on the PR itself; review comments use `deleteComment`. */
  deleteIssueComment(id: string): Promise<void>;
  /** Hide a comment for a reason such as OUTDATED, or show it again with `undefined`. */
  hideComment(id: string, reason: string | undefined): Promise<void>;
  react(subjectId: string, content: ReactionContent, on: boolean): Promise<void>;
  discardPendingReview(number: number): Promise<void>;
  dismissReview(reviewId: string, message: string): Promise<void>;
  updateBranch(number: number, method: 'merge' | 'rebase'): Promise<void>;
  enableAutoMerge(number: number, method: MergeMethod, message: MergeMessage): Promise<void>;
  disableAutoMerge(number: number): Promise<void>;
  enqueue(number: number): Promise<void>;
  dequeue(number: number): Promise<void>;
  /** Open a PR that reverts this merged one; returns its number and link. */
  revert(number: number): Promise<{ readonly number: number; readonly url: string }>;
  /** Create the head branch again at `oid` after it was deleted. */
  restoreBranch(branch: string, oid: string): Promise<void>;
  rerunFailedJobs(runId: number): Promise<void>;
  approveWorkflowRun(runId: number): Promise<void>;
  changeBase(number: number, base: string): Promise<void>;
  /** Branch names of this repository, for picking a new base. */
  branches(): Promise<readonly string[]>;
  /** GitHub's rendering of Markdown in this repository, for previewing a comment. */
  renderMarkdown(text: string): Promise<string>;
  /** The PR's head and last update; returns `known` itself when nothing changed. */
  version(number: number, known?: PullRequestVersion): Promise<PullRequestVersion>;
  /** The repository's most recent PR update, which moves when any PR is opened, changed or closed; returns `known` itself when nothing changed. */
  listVersion(known?: ListVersion): Promise<ListVersion>;
  /** PRs in other repositories that this PR mentions or that mention it, as `CrossReferencedEvent` nodes with `source` and `target`. */
  crossReferences(number: number): Promise<readonly unknown[]>;
  /** A PR's state for the Linked changes card: open, merged or closed, draft, checks, review decision and pushed head. */
  linkedState(number: number): Promise<LinkedPullRequestState | undefined>;
  /** An open PR whose head is `branch`, if any. */
  pullRequestForBranch(branch: string): Promise<PullRequestSummary | undefined>;
  /** Open a draft PR from `branch` into the default branch; returns its number and link. */
  createDraft(branch: string, title: string, body: string): Promise<{ readonly number: number; readonly url: string }>;
}

/** What the Linked changes card shows for another repository's PR. */
export interface LinkedPullRequestState {
  readonly number: number;
  readonly title: string;
  readonly url: string;
  readonly state: 'open' | 'merged' | 'closed';
  readonly draft: boolean;
  readonly headBranch: string;
  readonly headOid: string;
  readonly checks?: 'success' | 'failure' | 'pending';
  readonly review?: 'approved' | 'changes' | 'required';
  readonly canPush: boolean;
}

export interface PullRequestVersion { readonly polled?: Polled; readonly head: string; readonly updatedAt: string }
export interface ListVersion { readonly polled?: Polled; readonly latest: string }

/** A repository on a GitHub host, as a git remote names it. */
export interface GitHubRemote {
  readonly host: string;
  readonly owner: string;
  readonly name: string;
}

/** Read a GitHub repository from an HTTPS, SSH or scp-style remote URL. */
export function parseGitRemote(url: string): GitHubRemote | undefined {
  const match = /^(?:https?:\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\/|ssh:\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\/|[^@/:]+@([^/:]+):)([^/]+)\/([^/]+?)(?:\.git)?\/?$/u.exec(url.trim());
  const host = match?.[1] ?? match?.[2] ?? match?.[3];
  const owner = match?.[4];
  const name = match?.[5];
  if (host === undefined || owner === undefined || name === undefined) return undefined;
  const valid = /^[A-Za-z0-9_.-]+$/u;
  return valid.test(owner) && valid.test(name) && valid.test(host) ? { host: host.toLowerCase(), owner, name } : undefined;
}

/** A pull request a link names; `host` is absent for the short `owner/name#57` form. */
export interface PullRequestLink {
  readonly host?: string;
  readonly owner: string;
  readonly name: string;
  readonly number: number;
}

/** Read a PR from a GitHub link such as `https://github.com/owner/name/pull/57/files#discussion_r1`, or from `owner/name#57`. */
export function parsePullRequestLink(link: string): PullRequestLink | undefined {
  const trimmed = link.trim();
  const short = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)#(\d+)$/u.exec(trimmed);
  const full = short === null ? /^(?:https?:\/\/)?([A-Za-z0-9.-]+)(?::\d+)?\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/pull\/(\d+)(?:[/?#].*)?$/u.exec(trimmed) : null;
  const [owner, name, digits] = short === null ? [full?.[2], full?.[3], full?.[4]] : [short[1], short[2], short[3]];
  if (owner === undefined || name === undefined || digits === undefined) return undefined;
  const number = Number(digits);
  if (!Number.isSafeInteger(number) || number <= 0) return undefined;
  const host = full?.[1]?.toLowerCase();
  return host === undefined ? { owner, name, number } : { host, owner, name, number };
}

/** Order GitHub CLI uses when no default repository is set. */
const remotePriority = ['upstream', 'github', 'origin'];

/** The repository GitHub CLI picks from `git config --get-regexp ^remote\.` output: the `gh repo set-default` choice, else upstream, github, origin, then the rest. */
export function pickGitHubRemote(config: string): GitHubRemote | undefined {
  const remotes = new Map<string, { url?: string; resolved?: string }>();
  for (const line of config.split('\n')) {
    const match = /^remote\.(.+)\.(url|gh-resolved) (.+)$/u.exec(line.trim());
    if (match === null) continue;
    const [, remote = '', key, value = ''] = match;
    const entry = remotes.get(remote) ?? {};
    if (key === 'url') entry.url ??= value;
    else entry.resolved = value;
    remotes.set(remote, entry);
  }
  const rank = (remote: string): number => {
    const index = remotePriority.indexOf(remote);
    return index === -1 ? remotePriority.length : index;
  };
  const ordered = [...remotes].sort(([a], [b]) => rank(a) - rank(b) || a.localeCompare(b));
  const chosen = ordered.find(([, entry]) => entry.resolved !== undefined);
  if (chosen !== undefined) {
    const remote = chosen[1].url === undefined ? undefined : parseGitRemote(chosen[1].url);
    const [owner, name] = (chosen[1].resolved ?? '').split('/');
    if (remote !== undefined && owner !== undefined && name !== undefined && chosen[1].resolved !== 'base') return { host: remote.host, owner, name };
    if (remote !== undefined) return remote;
  }
  for (const [, entry] of ordered) {
    const remote = entry.url === undefined ? undefined : parseGitRemote(entry.url);
    if (remote !== undefined) return remote;
  }
  return undefined;
}

/** Open PRs by the viewer and requesting the viewer's review, keyed by lowercase `owner/name`. */
type SearchResults = ReadonlyMap<string, { readonly mine: readonly PullRequestSummary[]; readonly reviewRequested: readonly PullRequestSummary[] }>;

const searchFields = 'number title url isDraft headRefName baseRefName createdAt updatedAt additions deletions changedFiles author{login} repository{nameWithOwner} latestReviews(first:20){nodes{state}} '
  + 'reviewRequests(first:20){nodes{requestedReviewer{__typename ... on User{login} ... on Team{name} ... on Bot{login} ... on Mannequin{login}}}}';
const searchPages = 10;
const mergeMethodFields = 'mergeCommitAllowed squashMergeAllowed rebaseMergeAllowed deleteBranchOnMerge';
const viewerField = 'viewer{login name avatarUrl(size:40)}';
const detailsFields = `bodyHTML body title state isDraft mergeable viewerDidAuthor viewerCanUpdate isCrossRepository headRef{id} headRepository{nameWithOwner}
  labels(first:50){nodes{name color}} assignees(first:20){nodes{login}} milestone{number title}
  reviews(states:PENDING,first:20){nodes{viewerDidAuthor comments{totalCount}}}
  reviewRequests(first:30){nodes{requestedReviewer{... on User{login} ... on Team{name slug} ... on Bot{login}}}}
  latestOpinionatedReviews(first:30){nodes{state author{login}}}
  commits(last:1){nodes{commit{statusCheckRollup{contexts(first:100){nodes{__typename
    ... on CheckRun{name status conclusion detailsUrl} ... on StatusContext{context state targetUrl}}}}}}}`;
const reactionFields = 'reactionGroups{content viewerHasReacted reactors{totalCount}}';
const commentFields = `id url body bodyHTML createdAt lastEditedAt viewerCanUpdate viewerCanDelete viewerCanMinimize viewerCanReact isMinimized minimizedReason
  author{login avatarUrl(size:40) ... on User{name}} ${reactionFields}`;
const threadsField = `reviewThreads(first:100,after:$after){nodes{id path diffSide line startLine originalLine originalStartLine isOutdated isResolved
  comments(first:100){nodes{${commentFields} state}}} pageInfo{hasNextPage endCursor}}`;
const actorField = 'actor{login avatarUrl(size:40)}';
const userLogin = '... on User{login} ... on Bot{login} ... on Mannequin{login}';
const timelineTypes = ['ISSUE_COMMENT', 'PULL_REQUEST_REVIEW', 'PULL_REQUEST_COMMIT', 'HEAD_REF_FORCE_PUSHED_EVENT', 'LABELED_EVENT', 'UNLABELED_EVENT',
  'REVIEW_REQUESTED_EVENT', 'REVIEW_REQUEST_REMOVED_EVENT', 'REVIEW_DISMISSED_EVENT', 'MERGED_EVENT', 'CLOSED_EVENT', 'REOPENED_EVENT', 'READY_FOR_REVIEW_EVENT',
  'CONVERT_TO_DRAFT_EVENT', 'ASSIGNED_EVENT', 'UNASSIGNED_EVENT', 'RENAMED_TITLE_EVENT', 'BASE_REF_CHANGED_EVENT', 'HEAD_REF_DELETED_EVENT', 'HEAD_REF_RESTORED_EVENT',
  'CROSS_REFERENCED_EVENT', 'AUTO_MERGE_ENABLED_EVENT', 'AUTO_MERGE_DISABLED_EVENT', 'MILESTONED_EVENT', 'DEMILESTONED_EVENT'].join(',');
const timelineField = `timelineItems(first:100,after:$after,itemTypes:[${timelineTypes}]){pageInfo{hasNextPage endCursor} nodes{__typename
  ... on IssueComment{${commentFields}}
  ... on PullRequestReview{${commentFields} state submittedAt commit{oid}}
  ... on PullRequestCommit{id pushed:commit{oid messageHeadline messageBody committedDate additions deletions changedFilesIfAvailable statusCheckRollup{state} author{name avatarUrl(size:40) user{login}}}}
  ... on HeadRefForcePushedEvent{id createdAt ${actorField} beforeCommit{abbreviatedOid} afterCommit{abbreviatedOid}}
  ... on LabeledEvent{id createdAt ${actorField} label{name}}
  ... on UnlabeledEvent{id createdAt ${actorField} label{name}}
  ... on ReviewRequestedEvent{id createdAt ${actorField} requestedReviewer{${userLogin} ... on Team{name}}}
  ... on ReviewRequestRemovedEvent{id createdAt ${actorField} requestedReviewer{${userLogin} ... on Team{name}}}
  ... on ReviewDismissedEvent{id createdAt ${actorField} review{author{login}}}
  ... on MergedEvent{id createdAt ${actorField} commit{abbreviatedOid} mergeRefName}
  ... on ClosedEvent{id createdAt ${actorField}}
  ... on ReopenedEvent{id createdAt ${actorField}}
  ... on ReadyForReviewEvent{id createdAt ${actorField}}
  ... on ConvertToDraftEvent{id createdAt ${actorField}}
  ... on AssignedEvent{id createdAt ${actorField} assignee{${userLogin}}}
  ... on UnassignedEvent{id createdAt ${actorField} assignee{${userLogin}}}
  ... on RenamedTitleEvent{id createdAt ${actorField} previousTitle currentTitle}
  ... on BaseRefChangedEvent{id createdAt ${actorField} previousRefName currentRefName}
  ... on HeadRefDeletedEvent{id createdAt ${actorField} headRefName}
  ... on HeadRefRestoredEvent{id createdAt ${actorField}}
  ... on CrossReferencedEvent{id createdAt ${actorField} willCloseTarget source{... on Issue{number title repository{nameWithOwner}} ... on PullRequest{number title repository{nameWithOwner}}}}
  ... on AutoMergeEnabledEvent{id createdAt ${actorField}}
  ... on AutoMergeDisabledEvent{id createdAt ${actorField}}
  ... on MilestonedEvent{id createdAt ${actorField} milestoneTitle}
  ... on DemilestonedEvent{id createdAt ${actorField} milestoneTitle}}}`;
/** `latestOpinionatedReviews` comes first: after `reviewDecision`, GitHub lists only reviews by people with write access. */
const conversationFields = `viewerPermission autoMergeAllowed squashMergeCommitTitle squashMergeCommitMessage mergeCommitTitle mergeCommitMessage pullRequest(number:$number){
  latestOpinionatedReviews(first:30){nodes{id author{login}}}
  id viewerCanReact ${reactionFields} mergeStateStatus reviewDecision viewerCanUpdateBranch viewerCanMergeAsAdmin viewerCanEnableAutoMerge viewerCanDisableAutoMerge
  isMergeQueueEnabled mergeQueueEntry{position} headRefOid headRef{id} isCrossRepository autoMergeRequest{mergeMethod enabledBy{login}}
  closingIssuesReferences(first:10){nodes{number title url state}}
  commits(last:1){nodes{commit{statusCheckRollup{contexts(first:100){nodes{__typename
    ... on CheckRun{name isRequired(pullRequestNumber:$number) checkSuite{workflowRun{databaseId}} annotations(first:50){nodes{path annotationLevel title message location{start{line} end{line}}}}}
    ... on StatusContext{context isRequired(pullRequestNumber:$number)}}}}}}}
  ${timelineField}}`;

/** Group search hits by repository, in the shape `parsePullRequestList` reads; with the viewer's login, review requests say whether they came to the viewer or a team. */
export function groupSearchResults(mine: readonly unknown[], reviewRequested: readonly unknown[], viewer?: string): SearchResults {
  const grouped = new Map<string, { mine: unknown[]; reviewRequested: unknown[] }>();
  const add = (node: unknown, list: 'mine' | 'reviewRequested'): void => {
    const record = object(node);
    const repository = object(record['repository'])['nameWithOwner'];
    if (typeof repository !== 'string') return;
    const key = repository.toLowerCase();
    const entry = grouped.get(key) ?? { mine: [], reviewRequested: [] };
    entry[list].push({
      ...record,
      author: record['author'] ?? { login: 'ghost' },
      latestReviews: Array.isArray(object(record['latestReviews'] ?? {})['nodes']) ? object(record['latestReviews'])['nodes'] : [],
    });
    grouped.set(key, entry);
  };
  for (const node of mine) add(node, 'mine');
  for (const node of reviewRequested) add(node, 'reviewRequested');
  const via = (pullRequest: PullRequestSummary): PullRequestSummary => {
    const reviewers = pullRequest.requestedReviewers ?? [];
    const requestedVia = viewer !== undefined && reviewers.some((reviewer) => !reviewer.team && reviewer.name.toLowerCase() === viewer.toLowerCase()) ? 'you'
      : reviewers.some((reviewer) => reviewer.team) ? 'team' : undefined;
    return requestedVia === undefined ? pullRequest : { ...pullRequest, requestedVia };
  };
  return new Map([...grouped].map(([key, entry]) => [key, { mine: parsePullRequestList(entry.mine), reviewRequested: parsePullRequestList(entry.reviewRequested).map(via) }]));
}

/** Query pull requests through the user's GitHub sign-in in VS Code. */
export class GitHubApiProvider implements PullRequestProvider {
  /** One search per GitHub host serves every repository's PR lists. */
  static readonly #searches = new Map<string, Promise<SearchResults>>();
  /** One provider per repository keeps its remotes, PR ids and Viewed flags until `forget`. */
  static readonly #providers = new Map<string, GitHubApiProvider>();
  #repository: Promise<{ readonly owner: string; readonly name: string; readonly host: string }> | undefined;
  #renamed: Promise<string> | undefined;
  #remotes: Promise<string> | undefined;
  readonly #ids = new Map<number, Promise<string>>();
  /** Viewed flags from the latest file list of each PR, so reading them needs no second request. */
  readonly #viewed = new Map<number, ReadonlySet<string>>();

  private constructor(private readonly workspaceRoot: string) {}

  /** Connect to the repository the workspace's git remotes point to. */
  static async connect(workspaceRoot: string): Promise<GitHubApiProvider> {
    let provider = GitHubApiProvider.#providers.get(workspaceRoot);
    if (provider === undefined) GitHubApiProvider.#providers.set(workspaceRoot, provider = new GitHubApiProvider(workspaceRoot));
    return provider;
  }

  /** Search again and re-read remotes on the next listing. */
  static forget(): void {
    GitHubApiProvider.#searches.clear();
    GitHubApiProvider.#providers.clear();
  }

  /** Read from git remotes the way GitHub CLI picks its repository. */
  async readRepository(): Promise<PullRequestRepository> {
    const remote = pickGitHubRemote(await this.#remoteConfig());
    if (remote === undefined) throw new Error('No GitHub remote found in this repository.');
    return { name: `${remote.owner}/${remote.name}`, url: `https://${remote.host}/${remote.owner}/${remote.name}` };
  }

  async listMine(): Promise<readonly PullRequestSummary[]> {
    return (await this.#listed()).mine;
  }

  async listReviewRequested(): Promise<readonly PullRequestSummary[]> {
    return (await this.#listed()).reviewRequested;
  }

  async #listed(): Promise<{ readonly mine: readonly PullRequestSummary[]; readonly reviewRequested: readonly PullRequestSummary[] }> {
    const { owner, name, host } = await this.#repo();
    let search = GitHubApiProvider.#searches.get(host);
    if (search === undefined) {
      search = this.#search(host);
      search.catch(() => { GitHubApiProvider.#searches.delete(host); });
      GitHubApiProvider.#searches.set(host, search);
    }
    const results = await search;
    return results.get(`${owner}/${name}`.toLowerCase()) ?? results.get(await this.#currentName()) ?? { mine: [], reviewRequested: [] };
  }

  /** The repository's name on GitHub now, which search reports, when the remote still uses a name from before a rename or transfer. */
  #currentName(): Promise<string> {
    this.#renamed ??= this.#graphql('query($owner:String!,$name:String!){repository(owner:$owner,name:$name){nameWithOwner}}', {})
      .then((data) => text(object(data['repository'])['nameWithOwner']).toLowerCase())
      .catch(() => '');
    return this.#renamed;
  }

  async #search(host: string): Promise<SearchResults> {
    let viewer: string | undefined;
    const all = async (query: string): Promise<unknown[]> => {
      const nodes: unknown[] = [];
      let after: string | null = null;
      for (let page = 0; page < searchPages; page += 1) {
        const data = await this.#graphqlOn(host, `query($query:String!,$after:String){viewer{login} search(query:$query,type:ISSUE,first:100,after:$after){
          pageInfo{hasNextPage endCursor} nodes{... on PullRequest{${searchFields}}}}}`, { query, after });
        const login = object(data['viewer'] ?? {})['login'];
        if (typeof login === 'string') viewer = login;
        const result = object(data['search']);
        if (Array.isArray(result['nodes'])) nodes.push(...(result['nodes'] as unknown[]).filter((node) => typeof node === 'object' && node !== null && 'number' in node));
        const info = object(result['pageInfo']);
        if (info['hasNextPage'] !== true || typeof info['endCursor'] !== 'string') break;
        after = info['endCursor'];
      }
      return nodes;
    };
    const [mine, reviewRequested] = await Promise.all([
      all('is:pr is:open author:@me sort:created-desc'),
      all('is:pr is:open review-requested:@me sort:created-desc'),
    ]);
    return groupSearchResults(mine, reviewRequested, viewer);
  }

  async listFiles(number: number): Promise<readonly PullRequestFile[]> {
    const files: unknown[] = [];
    let after: string | null = null;
    for (let page = 0; page < 30; page++) {
      const data = await this.#graphql(`query($owner:String!,$name:String!,$number:Int!,$after:String){repository(owner:$owner,name:$name){pullRequest(number:$number){
        files(first:100,after:$after){nodes{path additions deletions changeType viewerViewedState} pageInfo{hasNextPage endCursor}}}}}`, { number, after });
      const connection = object(object(object(data['repository'])['pullRequest'])['files']);
      files.push(...list(connection['nodes']));
      const info = object(connection['pageInfo']);
      if (info['hasNextPage'] !== true) break;
      after = text(info['endCursor']);
    }
    const parsed = parsePullRequestFiles({ files });
    this.#viewed.set(number, new Set(files.map(object).filter((file) => file['viewerViewedState'] === 'VIEWED').map((file) => text(file['path']))));
    return parsed;
  }

  /** Fetch GitHub's `pull/<n>/head` ref, which also covers PRs from forks, through the user's git credentials. */
  async checkout(number: number, worktree: string): Promise<void> {
    const { owner, name, host } = await this.#repo();
    const remote = remoteNameFor(await this.#remoteConfig(), { host, owner, name }) ?? `https://${host}/${owner}/${name}.git`;
    await git(worktree, ['fetch', '--quiet', remote, `pull/${number}/head`]);
    await git(worktree, ['checkout', '--quiet', '--detach', 'FETCH_HEAD']);
  }

  async viewedFiles(number: number): Promise<ReadonlySet<string>> {
    const listed = this.#viewed.get(number);
    if (listed !== undefined) return listed;
    const viewed = new Set<string>();
    let after: string | null = null;
    for (let page = 0; page < 30; page++) {
      const data = await this.#graphql(`query($owner:String!,$name:String!,$number:Int!,$after:String){repository(owner:$owner,name:$name){pullRequest(number:$number){
        files(first:100,after:$after){nodes{path viewerViewedState} pageInfo{hasNextPage endCursor}}}}}`, { number, after });
      const files = object(object(object(data['repository'])['pullRequest'])['files']);
      for (const node of list(files['nodes'])) {
        const record = object(node);
        if (record['viewerViewedState'] === 'VIEWED') viewed.add(text(record['path']));
      }
      const info = object(files['pageInfo']);
      if (info['hasNextPage'] !== true) break;
      after = text(info['endCursor']);
    }
    return viewed;
  }

  async setViewed(number: number, path: string, viewed: boolean): Promise<void> {
    const mutation = viewed ? 'markFileAsViewed' : 'unmarkFileAsViewed';
    this.#viewed.delete(number);
    await this.#graphql(`mutation($id:ID!,$path:String!){${mutation}(input:{pullRequestId:$id,path:$path}){clientMutationId}}`,
      { id: await this.#pullRequestId(number), path });
  }

  async publishComment(number: number, comment: PullRequestComment, pending: boolean): Promise<string> {
    const { lines } = comment;
    const startLine = lines !== undefined && lines.start < lines.end ? lines.start : null;
    if (!pending) {
      const { owner, name, host } = await this.#repo();
      const body = {
        body: comment.body, commit_id: comment.commitId, path: comment.path,
        ...(lines === undefined ? { subject_type: 'file' } : { side: comment.side, line: lines.end, ...(startLine === null ? {} : { start_line: startLine, start_side: comment.side }) }),
      };
      const endpoints = endpointsFor(host);
      const created = object(await githubRequest(endpoints, `${endpoints.rest}/repos/${owner}/${name}/pulls/${number}/comments`, 'POST', body));
      return httpsUrl(created['html_url']);
    }
    const review = await this.#pendingReview(number, comment.commitId);
    const data = await this.#graphql(`mutation($review:ID!,$path:String!,$body:String!,$line:Int,$startLine:Int,$side:DiffSide,$subject:PullRequestReviewThreadSubjectType){
      addPullRequestReviewThread(input:{pullRequestReviewId:$review,path:$path,body:$body,line:$line,startLine:$startLine,side:$side,startSide:$side,subjectType:$subject}){thread{comments(first:1){nodes{url}}}}}`, {
      review, path: comment.path, body: comment.body, line: lines?.end ?? null, startLine,
      side: lines === undefined ? null : comment.side, subject: lines === undefined ? 'FILE' : 'LINE',
    });
    const thread = object(object(data['addPullRequestReviewThread'])['thread']);
    return httpsUrl(object(list(object(thread['comments'])['nodes'])[0])['url']);
  }

  async details(number: number): Promise<PullRequestDetails> {
    const data = await this.#graphql(`query($owner:String!,$name:String!,$number:Int!){${viewerField} repository(owner:$owner,name:$name){
      ${mergeMethodFields} pullRequest(number:$number){${detailsFields}}}}`, { number });
    return parseDetails(object(data['repository']), object(data['viewer']));
  }

  async threads(number: number): Promise<readonly RemoteThread[]> {
    return await this.#threads(number);
  }

  async overview(number: number): Promise<{ readonly details: PullRequestDetails; readonly threads: readonly RemoteThread[] }> {
    const data = await this.#graphql(`query($owner:String!,$name:String!,$number:Int!,$after:String){${viewerField} repository(owner:$owner,name:$name){
      ${mergeMethodFields} pullRequest(number:$number){id ${detailsFields} ${threadsField}}}}`, { number, after: null });
    const repository = object(data['repository']);
    const id = object(repository['pullRequest'])['id'];
    if (typeof id === 'string' && id !== '') this.#ids.set(number, Promise.resolve(id));
    return { details: parseDetails(repository, object(data['viewer'])), threads: await this.#threads(number, data) };
  }

  /** All review threads, continuing from an already fetched first page when given. */
  async #threads(number: number, firstPage?: Record<string, unknown>): Promise<readonly RemoteThread[]> {
    const threads: RemoteThread[] = [];
    let after: string | null = null;
    let data = firstPage;
    for (let page = 0; page < 30; page++) {
      data ??= await this.#graphql(`query($owner:String!,$name:String!,$number:Int!,$after:String){repository(owner:$owner,name:$name){pullRequest(number:$number){
        ${threadsField}}}}`, { number, after });
      const connection = object(object(object(data['repository'])['pullRequest'])['reviewThreads']);
      threads.push(...parseReviewThreads(connection['nodes']));
      const info = object(connection['pageInfo']);
      if (info['hasNextPage'] !== true) break;
      after = text(info['endCursor']);
      data = undefined;
    }
    return threads;
  }

  async replyToThread(threadId: string, body: string): Promise<void> {
    await this.#graphql('mutation($thread:ID!,$body:String!){addPullRequestReviewThreadReply(input:{pullRequestReviewThreadId:$thread,body:$body}){comment{id}}}',
      { thread: threadId, body });
  }

  async resolveThread(threadId: string, resolved: boolean): Promise<void> {
    const mutation = resolved ? 'resolveReviewThread' : 'unresolveReviewThread';
    await this.#graphql(`mutation($thread:ID!){${mutation}(input:{threadId:$thread}){thread{id}}}`, { thread: threadId });
  }

  async deleteComment(commentId: string): Promise<void> {
    await this.#graphql('mutation($id:ID!){deletePullRequestReviewComment(input:{id:$id}){clientMutationId}}', { id: commentId });
  }

  async submitReview(number: number, event: ReviewEvent, body: string): Promise<void> {
    const events: Record<ReviewEvent, string> = { approve: 'APPROVE', requestChanges: 'REQUEST_CHANGES', comment: 'COMMENT' };
    const pending = await this.#ownPendingReview(number);
    if (pending !== undefined) {
      await this.#graphql('mutation($review:ID!,$event:PullRequestReviewEvent!,$body:String){submitPullRequestReview(input:{pullRequestReviewId:$review,event:$event,body:$body}){clientMutationId}}',
        { review: pending, event: events[event], body });
      return;
    }
    await this.#graphql('mutation($id:ID!,$event:PullRequestReviewEvent!,$body:String){addPullRequestReview(input:{pullRequestId:$id,event:$event,body:$body}){clientMutationId}}',
      { id: await this.#pullRequestId(number), event: events[event], body });
  }

  async merge(number: number, method: MergeMethod, message: MergeMessage = {}): Promise<void> {
    await this.#graphql('mutation($id:ID!,$method:PullRequestMergeMethod!,$headline:String,$body:String){mergePullRequest(input:{pullRequestId:$id,mergeMethod:$method,commitHeadline:$headline,commitBody:$body}){clientMutationId}}',
      { id: await this.#pullRequestId(number), method: graphqlMethods[method], headline: message.headline ?? null, body: message.body ?? null });
  }

  async editPullRequest(number: number, edit: PullRequestEdit): Promise<void> {
    await this.#rest(`issues/${number}`, 'PATCH', edit);
  }

  async setDraft(number: number, draft: boolean): Promise<void> {
    const mutation = draft ? 'convertPullRequestToDraft' : 'markPullRequestReadyForReview';
    await this.#graphql(`mutation($id:ID!){${mutation}(input:{pullRequestId:$id}){clientMutationId}}`, { id: await this.#pullRequestId(number) });
  }

  async requestReviewers(number: number, reviewers: ReviewerSet): Promise<void> {
    await this.#rest(`pulls/${number}/requested_reviewers`, 'POST', { reviewers: reviewers.users, team_reviewers: reviewers.teams });
  }

  async removeReviewers(number: number, reviewers: ReviewerSet): Promise<void> {
    await this.#rest(`pulls/${number}/requested_reviewers`, 'DELETE', { reviewers: reviewers.users, team_reviewers: reviewers.teams });
  }

  async deleteBranch(branch: string): Promise<void> {
    await this.#rest(`git/refs/heads/${branch.split('/').map(encodeURIComponent).join('/')}`, 'DELETE');
  }

  async pickerOptions(): Promise<PickerOptions> {
    const data = await this.#graphql(`query($owner:String!,$name:String!){repository(owner:$owner,name:$name){
      assignableUsers(first:100){nodes{login}} labels(first:100){nodes{name color description}} milestones(first:50,states:OPEN){nodes{number title}}
      owner{... on Organization{teams(first:100){nodes{name slug}}}}}}`, {});
    return parsePickerOptions(object(data['repository']));
  }

  async search(query: string): Promise<readonly PullRequestSummary[]> {
    const { owner, name, host } = await this.#repo();
    const data = await this.#graphqlOn(host, `query($query:String!){search(query:$query,type:ISSUE,first:50){nodes{... on PullRequest{${searchFields}}}}}`,
      { query: `repo:${owner}/${name} is:pr ${query}` });
    const nodes = list(object(data['search'])['nodes']).filter((node) => typeof node === 'object' && node !== null && 'number' in node);
    return parsePullRequestList(nodes.map(searchNode));
  }

  async openPullRequests(numbers: readonly number[]): Promise<readonly PullRequestSummary[]> {
    const valid = numbers.filter((number) => Number.isSafeInteger(number) && number > 0);
    if (valid.length === 0) return [];
    const fields = valid.map((number) => `pr${number}:pullRequest(number:${number}){state ${searchFields}}`).join(' ');
    const repository = object((await this.#graphql(`query($owner:String!,$name:String!){repository(owner:$owner,name:$name){${fields}}}`, {}))['repository']);
    const open = valid.map((number) => object(repository[`pr${number}`])).filter((node) => node['state'] === 'OPEN');
    return parsePullRequestList(open.map(searchNode));
  }

  async pullRequest(number: number): Promise<PullRequestSummary | undefined> {
    if (!Number.isSafeInteger(number) || number <= 0) return undefined;
    const repository = object((await this.#graphql(`query($owner:String!,$name:String!){repository(owner:$owner,name:$name){pr:pullRequest(number:${number}){${searchFields}}}}`, {}))['repository']);
    return repository['pr'] === null || repository['pr'] === undefined ? undefined : parsePullRequestList([searchNode(repository['pr'])])[0];
  }

  async crossReferences(number: number): Promise<readonly unknown[]> {
    const side = '... on PullRequest{number repository{nameWithOwner}}';
    const data = await this.#graphql(`query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){
      timelineItems(first:100,itemTypes:[CROSS_REFERENCED_EVENT]){nodes{... on CrossReferencedEvent{source{${side}} target{${side}}}}}}}}`, { number });
    return list(object(object(object(object(data['repository'])['pullRequest'])['timelineItems']))['nodes']);
  }

  async linkedState(number: number): Promise<LinkedPullRequestState | undefined> {
    const data = await this.#graphql(`query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){
      number title url state isDraft headRefName headRefOid reviewDecision viewerCanUpdate commits(last:1){nodes{commit{statusCheckRollup{state}}}}}}}`, { number });
    const pr = object(object(data['repository'])['pullRequest']);
    if (typeof pr['number'] !== 'number') return undefined;
    return parseLinkedState(pr);
  }

  async pullRequestForBranch(branch: string): Promise<PullRequestSummary | undefined> {
    const data = await this.#graphql(`query($owner:String!,$name:String!,$branch:String!){repository(owner:$owner,name:$name){pullRequests(first:1,states:OPEN,headRefName:$branch){nodes{${searchFields}}}}}`, { branch });
    const nodes = list(object(object(data['repository'])['pullRequests'])['nodes']);
    return nodes.length === 0 ? undefined : parsePullRequestList(nodes.map(searchNode))[0];
  }

  async createDraft(branch: string, title: string, body: string): Promise<{ readonly number: number; readonly url: string }> {
    const repository = object((await this.#graphql('query($owner:String!,$name:String!){repository(owner:$owner,name:$name){id defaultBranchRef{name}}}', {}))['repository']);
    const created = object(object((await this.#graphql('mutation($repo:ID!,$base:String!,$head:String!,$title:String!,$body:String!){createPullRequest(input:{repositoryId:$repo,baseRefName:$base,headRefName:$head,title:$title,body:$body,draft:true}){pullRequest{number url}}}',
      { repo: text(repository['id']), base: text(object(repository['defaultBranchRef'])['name']), head: branch, title, body }))['createPullRequest'])['pullRequest']);
    if (!Number.isSafeInteger(created['number'])) throw new Error('GitHub did not open the draft PR.');
    return { number: created['number'] as number, url: httpsUrl(created['url']) };
  }

  async conversation(number: number): Promise<PullRequestConversation> {
    const data = await this.#graphql(`query($owner:String!,$name:String!,$number:Int!,$after:String){viewer{login} repository(owner:$owner,name:$name){${conversationFields}}}`,
      { number, after: null });
    const repository = object(data['repository']);
    const pullRequest = object(repository['pullRequest']);
    const nodes: unknown[] = [];
    let page = object(pullRequest['timelineItems']);
    for (let count = 0; count < 10; count++) {
      nodes.push(...list(page['nodes']));
      const info = object(page['pageInfo']);
      if (info['hasNextPage'] !== true) break;
      const next = await this.#graphql(`query($owner:String!,$name:String!,$number:Int!,$after:String){repository(owner:$owner,name:$name){pullRequest(number:$number){${timelineField}}}}`,
        { number, after: text(info['endCursor']) });
      page = object(object(object(next['repository'])['pullRequest'])['timelineItems']);
    }
    const parsed = parseConversation(repository, object(data['viewer']), nodes);
    if (pullRequest['isCrossRepository'] !== true || !canWrite(parsed.permission)) return parsed;
    const runs = await this.#restGet(`actions/runs?status=action_required&head_sha=${encodeURIComponent(parsed.merge.headOid)}&per_page=20`).catch(() => undefined);
    const ids = typeof runs === 'object' && runs !== null && Array.isArray((runs as Record<string, unknown>)['workflow_runs'])
      ? ((runs as Record<string, unknown>)['workflow_runs'] as unknown[]).map((run) => (typeof run === 'object' && run !== null ? (run as Record<string, unknown>)['id'] : undefined))
        .filter((id): id is number => Number.isSafeInteger(id))
      : [];
    return { ...parsed, awaitingApproval: ids };
  }

  async addComment(number: number, body: string): Promise<void> {
    await this.#graphql('mutation($id:ID!,$body:String!){addComment(input:{subjectId:$id,body:$body}){clientMutationId}}', { id: await this.#pullRequestId(number), body });
  }

  async editComment(kind: CommentKind, id: string, body: string): Promise<void> {
    const mutations: Record<CommentKind, string> = {
      issue: 'updateIssueComment(input:{id:$id,body:$body})',
      review: 'updatePullRequestReview(input:{pullRequestReviewId:$id,body:$body})',
      reviewComment: 'updatePullRequestReviewComment(input:{pullRequestReviewCommentId:$id,body:$body})',
    };
    await this.#graphql(`mutation($id:ID!,$body:String!){${mutations[kind]}{clientMutationId}}`, { id, body });
  }

  async deleteIssueComment(id: string): Promise<void> {
    await this.#graphql('mutation($id:ID!){deleteIssueComment(input:{id:$id}){clientMutationId}}', { id });
  }

  async hideComment(id: string, reason: string | undefined): Promise<void> {
    if (reason === undefined) await this.#graphql('mutation($id:ID!){unminimizeComment(input:{subjectId:$id}){clientMutationId}}', { id });
    else await this.#graphql('mutation($id:ID!,$reason:ReportedContentClassifiers!){minimizeComment(input:{subjectId:$id,classifier:$reason}){clientMutationId}}', { id, reason });
  }

  async react(subjectId: string, content: ReactionContent, on: boolean): Promise<void> {
    const mutation = on ? 'addReaction' : 'removeReaction';
    await this.#graphql(`mutation($id:ID!,$content:ReactionContent!){${mutation}(input:{subjectId:$id,content:$content}){clientMutationId}}`, { id: subjectId, content });
  }

  async discardPendingReview(number: number): Promise<void> {
    const review = await this.#ownPendingReview(number);
    if (review === undefined) throw new Error('You have no pending review on this PR.');
    await this.#graphql('mutation($id:ID!){deletePullRequestReview(input:{pullRequestReviewId:$id}){clientMutationId}}', { id: review });
  }

  async dismissReview(reviewId: string, message: string): Promise<void> {
    await this.#graphql('mutation($id:ID!,$message:String!){dismissPullRequestReview(input:{pullRequestReviewId:$id,message:$message}){clientMutationId}}', { id: reviewId, message });
  }

  async updateBranch(number: number, method: 'merge' | 'rebase'): Promise<void> {
    await this.#graphql('mutation($id:ID!,$method:PullRequestBranchUpdateMethod){updatePullRequestBranch(input:{pullRequestId:$id,updateMethod:$method}){clientMutationId}}',
      { id: await this.#pullRequestId(number), method: method === 'rebase' ? 'REBASE' : 'MERGE' });
  }

  async enableAutoMerge(number: number, method: MergeMethod, message: MergeMessage): Promise<void> {
    await this.#graphql('mutation($id:ID!,$method:PullRequestMergeMethod!,$headline:String,$body:String){enablePullRequestAutoMerge(input:{pullRequestId:$id,mergeMethod:$method,commitHeadline:$headline,commitBody:$body}){clientMutationId}}',
      { id: await this.#pullRequestId(number), method: graphqlMethods[method], headline: message.headline ?? null, body: message.body ?? null });
  }

  async disableAutoMerge(number: number): Promise<void> {
    await this.#graphql('mutation($id:ID!){disablePullRequestAutoMerge(input:{pullRequestId:$id}){clientMutationId}}', { id: await this.#pullRequestId(number) });
  }

  async enqueue(number: number): Promise<void> {
    await this.#graphql('mutation($id:ID!){enqueuePullRequest(input:{pullRequestId:$id}){clientMutationId}}', { id: await this.#pullRequestId(number) });
  }

  async dequeue(number: number): Promise<void> {
    await this.#graphql('mutation($id:ID!){dequeuePullRequest(input:{id:$id}){clientMutationId}}', { id: await this.#pullRequestId(number) });
  }

  async revert(number: number): Promise<{ readonly number: number; readonly url: string }> {
    const data = await this.#graphql('mutation($id:ID!){revertPullRequest(input:{pullRequestId:$id}){revertPullRequest{number url}}}', { id: await this.#pullRequestId(number) });
    const created = object(object(data['revertPullRequest'])['revertPullRequest']);
    const revertNumber = created['number'];
    if (!Number.isSafeInteger(revertNumber)) throw new Error('GitHub did not open the revert PR.');
    return { number: revertNumber as number, url: httpsUrl(created['url']) };
  }

  async restoreBranch(branch: string, oid: string): Promise<void> {
    if (!/^[a-f\d]{40,64}$/u.test(oid)) throw new Error('Unknown head commit.');
    await this.#rest('git/refs', 'POST', { ref: `refs/heads/${branch}`, sha: oid });
  }

  async rerunFailedJobs(runId: number): Promise<void> {
    await this.#rest(`actions/runs/${runId}/rerun-failed-jobs`, 'POST');
  }

  async approveWorkflowRun(runId: number): Promise<void> {
    await this.#rest(`actions/runs/${runId}/approve`, 'POST');
  }

  async changeBase(number: number, base: string): Promise<void> {
    await this.#rest(`pulls/${number}`, 'PATCH', { base });
  }

  async branches(): Promise<readonly string[]> {
    const names: string[] = [];
    let after: string | null = null;
    for (let page = 0; page < 10; page++) {
      const data = await this.#graphql('query($owner:String!,$name:String!,$after:String){repository(owner:$owner,name:$name){refs(refPrefix:"refs/heads/",first:100,after:$after){nodes{name} pageInfo{hasNextPage endCursor}}}}', { after });
      const refs = object(object(data['repository'])['refs']);
      names.push(...list(refs['nodes']).map((node) => text(object(node)['name'])));
      const info = object(refs['pageInfo']);
      if (info['hasNextPage'] !== true) break;
      after = text(info['endCursor']);
    }
    return names;
  }

  async renderMarkdown(markdown: string): Promise<string> {
    const { owner, name, host } = await this.#repo();
    const endpoints = endpointsFor(host);
    const html = await githubRequest(endpoints, `${endpoints.rest}/markdown`, 'POST', { text: markdown, mode: 'gfm', context: `${owner}/${name}` });
    return typeof html === 'string' ? html : '';
  }

  async version(number: number, known?: PullRequestVersion): Promise<PullRequestVersion> {
    const polled = await this.#poll(`pulls/${number}`, known?.polled);
    if (polled === known?.polled) return known;
    const pullRequest = object(polled.data);
    return { polled, head: text(object(pullRequest['head'])['sha']), updatedAt: text(pullRequest['updated_at']) };
  }

  async listVersion(known?: ListVersion): Promise<ListVersion> {
    const polled = await this.#poll('pulls?state=all&sort=updated&direction=desc&per_page=1', known?.polled);
    if (polled === known?.polled) return known;
    const latest = object(list(polled.data)[0]);
    return { polled, latest: `${String(latest['number'] ?? '')} ${String(latest['updated_at'] ?? '')}` };
  }

  async #poll(path: string, known: Polled | undefined): Promise<Polled> {
    const { owner, name, host } = await this.#repo();
    const endpoints = endpointsFor(host);
    return await githubPoll(endpoints, `${endpoints.rest}/repos/${owner}/${name}/${path}`, known);
  }

  async #restGet(path: string): Promise<unknown> {
    const { owner, name, host } = await this.#repo();
    const endpoints = endpointsFor(host);
    return await githubRequest(endpoints, `${endpoints.rest}/repos/${owner}/${name}/${path}`, 'GET');
  }

  /** Call a REST endpoint under this repository. */
  async #rest(path: string, method: 'POST' | 'PATCH' | 'DELETE', body?: unknown): Promise<unknown> {
    const { owner, name, host } = await this.#repo();
    const endpoints = endpointsFor(host);
    return await githubRequest(endpoints, `${endpoints.rest}/repos/${owner}/${name}/${path}`, method, body);
  }

  /** The user's pending review on a PR, started at `commitId` when there is none yet. */
  async #pendingReview(number: number, commitId: string): Promise<string> {
    const own = await this.#ownPendingReview(number);
    if (own !== undefined) return own;
    const created = await this.#graphql('mutation($id:ID!,$commit:GitObjectID){addPullRequestReview(input:{pullRequestId:$id,commitOID:$commit}){pullRequestReview{id}}}',
      { id: await this.#pullRequestId(number), commit: commitId });
    return text(object(object(created['addPullRequestReview'])['pullRequestReview'])['id']);
  }

  async #ownPendingReview(number: number): Promise<string | undefined> {
    const data = await this.#graphql(`query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){
      reviews(states:PENDING,first:20){nodes{id viewerDidAuthor}}}}}`, { number });
    const reviews = list(object(object(object(data['repository'])['pullRequest'])['reviews'])['nodes']).map(object);
    const own = reviews.find((review) => review['viewerDidAuthor'] === true);
    return own === undefined ? undefined : text(own['id']);
  }

  #pullRequestId(number: number): Promise<string> {
    let id = this.#ids.get(number);
    if (id === undefined) {
      id = this.#graphql('query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){id}}}', { number })
        .then((data) => text(object(object(data['repository'])['pullRequest'])['id']));
      id.catch(() => { this.#ids.delete(number); });
      this.#ids.set(number, id);
    }
    return id;
  }

  #repo(): Promise<{ readonly owner: string; readonly name: string; readonly host: string }> {
    this.#repository ??= this.readRepository().then(({ name, url }) => {
      const [owner = '', repository = ''] = name.split('/');
      return { owner, name: repository, host: new URL(url).host };
    });
    return this.#repository;
  }

  /** Remote lines from git config, read once per provider. */
  #remoteConfig(): Promise<string> {
    this.#remotes ??= git(this.workspaceRoot, ['config', '--get-regexp', '^remote\\.']).catch(() => '');
    return this.#remotes;
  }

  /** Run a GraphQL request for this repository. */
  async #graphql(query: string, variables: Readonly<Record<string, unknown>>): Promise<Record<string, unknown>> {
    const { owner, name, host } = await this.#repo();
    return await this.#graphqlOn(host, query, { owner, name, ...variables });
  }

  async #graphqlOn(host: string, query: string, variables: Readonly<Record<string, unknown>>): Promise<Record<string, unknown>> {
    const endpoints = endpointsFor(host);
    const response = object(await githubRequest(endpoints, endpoints.graphql, 'POST', { query, variables }));
    const errors = response['errors'];
    if (Array.isArray(errors) && errors.length > 0) {
      const message = (errors as unknown[]).map((error) => (typeof error === 'object' && error !== null ? (error as { message?: unknown }).message : undefined))
        .filter((value): value is string => typeof value === 'string').join(' ');
      throw new Error(`GitHub refused the request.${message ? ` ${message.slice(0, 400)}` : ''}`);
    }
    return object(response['data']);
  }
}

/** The git remote that points at `repository`, usable as a fetch source; undefined when none does. */
export function remoteNameFor(config: string, repository: GitHubRemote): string | undefined {
  for (const line of config.split('\n')) {
    const match = /^remote\.(.+)\.url (.+)$/u.exec(line.trim());
    const remote = match?.[2] === undefined ? undefined : parseGitRemote(match[2]);
    if (match?.[1] === undefined || match[1].startsWith('-') || remote === undefined) continue;
    if (remote.host === repository.host && remote.owner.toLowerCase() === repository.owner.toLowerCase()
      && remote.name.toLowerCase() === repository.name.toLowerCase()) return match[1];
  }
  return undefined;
}

/** A search or repository PR node in the shape `parsePullRequestList` reads. */
function searchNode(node: unknown): Record<string, unknown> {
  const record = object(node);
  return { ...record, author: record['author'] ?? { login: 'ghost' }, latestReviews: list(object(record['latestReviews'] ?? { nodes: [] })['nodes']) };
}

/** Validate a PR list from a GitHub search, rejecting the whole response on any malformed entry. */
export function parsePullRequestList(value: unknown): readonly PullRequestSummary[] {
  if (!Array.isArray(value)) throw new Error('GitHub returned an invalid PR list.');
  return (value as readonly unknown[]).map((entry) => {
    const record = object(entry);
    const number = record['number'];
    if (typeof number !== 'number' || !Number.isSafeInteger(number) || number <= 0) {
      throw new Error('GitHub returned an invalid PR number.');
    }
    const reviews = Array.isArray(record['latestReviews']) ? record['latestReviews'] as readonly unknown[] : [];
    const review = strongestVerdict(reviews.map((entry) => String(typeof entry === 'object' && entry !== null ? (entry as { state?: unknown }).state : '')));
    const createdAt = isoTime(record['createdAt']);
    const updatedAt = isoTime(record['updatedAt']);
    const [additions, deletions, files] = [record['additions'], record['deletions'], record['changedFiles']].map(count);
    const requestedReviewers = requestedReviewersOf(record['reviewRequests']);
    return {
      number,
      title: text(record['title']),
      url: httpsUrl(record['url']),
      author: text(object(record['author'])['login']),
      draft: record['isDraft'] === true,
      headBranch: text(record['headRefName']),
      baseBranch: text(record['baseRefName']),
      ...(review === undefined ? {} : { review }),
      ...createdAt === undefined ? {} : { createdAt },
      ...updatedAt === undefined ? {} : { updatedAt },
      ...additions === undefined || deletions === undefined || files === undefined ? {} : { changes: { additions, deletions, files } },
      ...requestedReviewers.length === 0 ? {} : { requestedReviewers },
    };
  });
}

/** Pending reviewers from a `reviewRequests` connection, skipping entries GitHub left incomplete. */
function requestedReviewersOf(value: unknown): readonly RequestedReviewer[] {
  const nodes = typeof value === 'object' && value !== null ? (value as { nodes?: unknown }).nodes : undefined;
  if (!Array.isArray(nodes)) return [];
  return (nodes as readonly unknown[]).flatMap((node): RequestedReviewer[] => {
    const reviewer = typeof node === 'object' && node !== null ? (node as { requestedReviewer?: unknown }).requestedReviewer : undefined;
    if (typeof reviewer !== 'object' || reviewer === null) return [];
    const { __typename: type, login, name } = reviewer as { __typename?: unknown; login?: unknown; name?: unknown };
    const team = type === 'Team';
    const label = team ? name : login;
    return typeof label === 'string' && label ? [{ name: label, team }] : [];
  });
}

const changeTypes: Record<string, PullRequestFile['change']> = {
  ADDED: 'added', MODIFIED: 'modified', DELETED: 'deleted', RENAMED: 'renamed', CHANGED: 'modified', COPIED: 'added',
};

/** Validate a PR's changed files, rejecting paths that leave the repository. */
export function parsePullRequestFiles(value: unknown): readonly PullRequestFile[] {
  const files = object(value)['files'];
  if (!Array.isArray(files)) throw new Error('GitHub returned an invalid file list.');
  return (files as readonly unknown[]).map((entry) => {
    const record = object(entry);
    const path = text(record['path']);
    const additions = record['additions'];
    const deletions = record['deletions'];
    const change = changeTypes[String(record['changeType'])] ?? 'modified';
    if (path.startsWith('/') || path.includes('\0') || path.split('/').includes('..')
      || typeof additions !== 'number' || typeof deletions !== 'number') {
      throw new Error('GitHub returned an invalid file entry.');
    }
    return { path, additions, deletions, change };
  });
}

const reviewStates: Record<string, PullRequestDetails['reviewers'][number]['state']> = {
  APPROVED: 'approved', CHANGES_REQUESTED: 'changes', COMMENTED: 'commented', DISMISSED: 'dismissed',
};

/** Map a check run conclusion or commit status to one of four states. */
function checkState(raw: unknown): PullRequestDetails['checks'][number]['state'] {
  const value = String(raw);
  if (value === 'SUCCESS') return 'success';
  if (['FAILURE', 'ERROR', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED', 'STARTUP_FAILURE'].includes(value)) return 'failure';
  if (['NEUTRAL', 'SKIPPED', 'STALE'].includes(value)) return 'neutral';
  return 'pending';
}

/** Validate PR details from GraphQL; reviewers without an account and malformed checks are left out. */
export function parseDetails(repository: Record<string, unknown>, viewer: Record<string, unknown> = {}): PullRequestDetails {
  const pullRequest = object(repository['pullRequest']);
  const methods: readonly [string, MergeMethod][] = [['squashMergeAllowed', 'squash'], ['mergeCommitAllowed', 'merge'], ['rebaseMergeAllowed', 'rebase']];
  const reviewers: PullRequestDetails['reviewers'][number][] = [];
  for (const node of list(object(pullRequest['latestOpinionatedReviews'])['nodes'])) {
    const review = object(node);
    const login = typeof review['author'] === 'object' && review['author'] !== null ? (review['author'] as { login?: unknown }).login : undefined;
    const state = reviewStates[String(review['state'])];
    if (typeof login === 'string' && state !== undefined) reviewers.push({ name: login, state });
  }
  for (const node of list(object(pullRequest['reviewRequests'])['nodes'])) {
    const reviewer = object(node)['requestedReviewer'];
    const record = typeof reviewer === 'object' && reviewer !== null ? reviewer as { login?: unknown; name?: unknown; slug?: unknown } : {};
    const name = record.login ?? record.name;
    if (typeof name !== 'string' || reviewers.some((entry) => entry.name === name)) continue;
    reviewers.push({ name, state: 'requested', ...(typeof record.slug === 'string' ? { team: record.slug } : {}) });
  }
  const commit = list(object(pullRequest['commits'])['nodes'])[0];
  const rollup = commit === undefined ? null : object(object(commit)['commit'])['statusCheckRollup'];
  const checks: PullRequestDetails['checks'][number][] = [];
  if (typeof rollup === 'object' && rollup !== null) {
    for (const node of list(object((rollup as Record<string, unknown>)['contexts'])['nodes'])) {
      const check = object(node);
      const run = check['__typename'] === 'CheckRun';
      const name = run ? check['name'] : check['context'];
      const link = run ? check['detailsUrl'] : check['targetUrl'];
      if (typeof name !== 'string') continue;
      const url = typeof link === 'string' && link.startsWith('https://') ? link : undefined;
      checks.push({ name, state: checkState(run ? (check['status'] === 'COMPLETED' ? check['conclusion'] : 'PENDING') : check['state']), ...(url === undefined ? {} : { url }) });
    }
  }
  const pending = pullRequest['reviews'] === undefined ? undefined
    : list(object(pullRequest['reviews'])['nodes']).map(object).find((review) => review['viewerDidAuthor'] === true);
  const pendingComments = pending === undefined ? undefined : object(pending['comments'])['totalCount'];
  const fork = object(pullRequest['headRepository'] ?? {})['nameWithOwner'];
  return {
    ...(pullRequest['isCrossRepository'] === true && typeof fork === 'string' && /^[\w.-]+\/[\w.-]+$/u.test(fork) ? { headRepository: fork } : {}),
    ...(typeof pendingComments === 'number' ? { pendingComments } : {}),
    bodyHtml: typeof pullRequest['bodyHTML'] === 'string' ? pullRequest['bodyHTML'] : '',
    title: typeof pullRequest['title'] === 'string' ? pullRequest['title'] : '',
    body: typeof pullRequest['body'] === 'string' ? pullRequest['body'] : '',
    open: pullRequest['state'] === 'OPEN',
    merged: pullRequest['state'] === 'MERGED',
    draft: pullRequest['isDraft'] === true,
    canEdit: pullRequest['viewerCanUpdate'] === true,
    branchDeletable: pullRequest['isCrossRepository'] === false && pullRequest['headRef'] !== null && pullRequest['headRef'] !== undefined && repository['deleteBranchOnMerge'] !== true,
    labels: parseLabels(pullRequest['labels']),
    assignees: logins(pullRequest['assignees']),
    mergeable: pullRequest['mergeable'] === 'MERGEABLE' ? 'yes' : pullRequest['mergeable'] === 'CONFLICTING' ? 'no' : 'unknown',
    viewerIsAuthor: pullRequest['viewerDidAuthor'] === true,
    viewerAvatarUrl: optionalHttpsUrl(viewer['avatarUrl']),
    ...displayName(viewer) === undefined ? {} : { viewerName: displayName(viewer) as string },
    mergeMethods: methods.filter(([key]) => repository[key] === true).map(([, method]) => method),
    reviewers,
    checks,
    ...parseMilestone(pullRequest['milestone']),
  };
}

function parseMilestone(value: unknown): { milestone?: Milestone } {
  if (typeof value !== 'object' || value === null) return {};
  const { number, title } = value as Record<string, unknown>;
  return Number.isSafeInteger(number) && typeof title === 'string' ? { milestone: { number: number as number, title } } : {};
}

const reactionSet: ReadonlySet<string> = new Set(reactionContents);

/** Reactions anyone left, in GitHub's order, without empty ones. */
function parseReactions(groups: unknown): readonly ReactionCount[] {
  if (!Array.isArray(groups)) return [];
  return groups.map(object).flatMap((group) => {
    const content = group['content'];
    const total = count(object(group['reactors'] ?? {})['totalCount']);
    return typeof content === 'string' && reactionSet.has(content) && total !== undefined && total > 0
      ? [{ content: content as ReactionContent, count: total, viewerReacted: group['viewerHasReacted'] === true }] : [];
  });
}

/** A comment, review or review comment as GitHub sent it; a deleted user shows as ghost. */
export function parseComment(comment: Record<string, unknown>): GitHubComment {
  const author = comment['author'] === null || comment['author'] === undefined ? {} : object(comment['author']);
  const url = typeof comment['url'] === 'string' ? optionalHttpsUrl(comment['url']) : '';
  const reason = comment['minimizedReason'];
  return {
    id: text(comment['id']),
    author: typeof author['login'] === 'string' ? author['login'] : 'ghost',
    ...typeof author['name'] === 'string' && author['name'].trim() ? { authorName: author['name'].trim() } : {},
    avatarUrl: optionalHttpsUrl(author['avatarUrl']),
    createdAt: typeof comment['createdAt'] === 'string' ? comment['createdAt'] : '',
    bodyHtml: typeof comment['bodyHTML'] === 'string' ? comment['bodyHTML'] : '',
    body: typeof comment['body'] === 'string' ? comment['body'] : '',
    ...url ? { url } : {},
    canEdit: comment['viewerCanUpdate'] === true,
    canDelete: comment['viewerCanDelete'] === true,
    canHide: comment['viewerCanMinimize'] === true,
    canReact: comment['viewerCanReact'] === true,
    ...comment['isMinimized'] === true ? { hidden: typeof reason === 'string' && reason ? reason.toLowerCase().replaceAll('_', ' ') : 'hidden' } : {},
    edited: typeof comment['lastEditedAt'] === 'string',
    reactions: parseReactions(comment['reactionGroups']),
  };
}

const reviewTimelineStates: Record<string, Extract<TimelineItem, { kind: 'review' }>['state']> = {
  APPROVED: 'approved', CHANGES_REQUESTED: 'changes', COMMENTED: 'commented', DISMISSED: 'dismissed', PENDING: 'pending',
};

function login(value: unknown): string {
  return typeof value === 'object' && value !== null && typeof (value as { login?: unknown }).login === 'string' ? (value as { login: string }).login : 'ghost';
}

/** What a timeline event says, in GitHub's words without the actor; undefined for events the page leaves out. */
function eventText(node: Record<string, unknown>): string | undefined {
  const name = (value: unknown): string => {
    const record = typeof value === 'object' && value !== null ? value as Record<string, unknown> : {};
    return typeof record['login'] === 'string' ? record['login'] : typeof record['name'] === 'string' ? record['name'] : 'someone';
  };
  const field = (key: string): string => typeof node[key] === 'string' ? node[key] : '';
  const label = (): string => typeof node['label'] === 'object' && node['label'] !== null ? String((node['label'] as { name?: unknown }).name ?? '') : '';
  const short = (key: string): string => typeof node[key] === 'object' && node[key] !== null ? String((node[key] as { abbreviatedOid?: unknown }).abbreviatedOid ?? '') : '';
  switch (node['__typename']) {
    case 'HeadRefForcePushedEvent': return `force-pushed the branch from ${short('beforeCommit') || 'an earlier commit'} to ${short('afterCommit') || 'a new commit'}`;
    case 'LabeledEvent': return `added the ${label()} label`;
    case 'UnlabeledEvent': return `removed the ${label()} label`;
    case 'ReviewRequestedEvent': return `requested a review from ${name(node['requestedReviewer'])}`;
    case 'ReviewRequestRemovedEvent': return `removed the review request for ${name(node['requestedReviewer'])}`;
    case 'ReviewDismissedEvent': return `dismissed ${login(object(node['review'] ?? {})['author'])}'s review`;
    case 'MergedEvent': return `merged commit ${short('commit')} into ${field('mergeRefName')}`;
    case 'ClosedEvent': return 'closed this';
    case 'ReopenedEvent': return 'reopened this';
    case 'ReadyForReviewEvent': return 'marked this ready for review';
    case 'ConvertToDraftEvent': return 'converted this to a draft';
    case 'AssignedEvent': return `assigned ${name(node['assignee'])}`;
    case 'UnassignedEvent': return `unassigned ${name(node['assignee'])}`;
    case 'RenamedTitleEvent': return `changed the title from "${field('previousTitle')}" to "${field('currentTitle')}"`;
    case 'BaseRefChangedEvent': return `changed the base branch from ${field('previousRefName')} to ${field('currentRefName')}`;
    case 'HeadRefDeletedEvent': return `deleted the ${field('headRefName')} branch`;
    case 'HeadRefRestoredEvent': return 'restored the head branch';
    case 'CrossReferencedEvent': {
      const source = typeof node['source'] === 'object' && node['source'] !== null ? node['source'] as Record<string, unknown> : {};
      if (!Number.isSafeInteger(source['number'])) return undefined;
      const where = String((source['repository'] as { nameWithOwner?: unknown } | undefined)?.nameWithOwner ?? '');
      return `${node['willCloseTarget'] === true ? 'linked' : 'mentioned this in'} ${where}#${String(source['number'])} ${String(source['title'] ?? '')}`.trim();
    }
    case 'AutoMergeEnabledEvent': return 'enabled auto-merge';
    case 'AutoMergeDisabledEvent': return 'disabled auto-merge';
    case 'MilestonedEvent': return `added this to the ${field('milestoneTitle')} milestone`;
    case 'DemilestonedEvent': return `removed this from the ${field('milestoneTitle')} milestone`;
    default: return undefined;
  }
}

/** Timeline entries the page shows, skipping kinds it does not know and entries GitHub sent incomplete. */
export function parseTimeline(nodes: readonly unknown[]): readonly TimelineItem[] {
  const items: TimelineItem[] = [];
  for (const entry of nodes) {
    if (typeof entry !== 'object' || entry === null || typeof (entry as { id?: unknown }).id !== 'string') continue;
    const node = entry as Record<string, unknown>;
    const kind = node['__typename'];
    if (kind === 'IssueComment') items.push({ kind: 'comment', ...parseComment(node) });
    else if (kind === 'PullRequestReview') {
      const state = reviewTimelineStates[String(node['state'])];
      if (state === undefined) continue;
      const commit = typeof node['commit'] === 'object' && node['commit'] !== null ? (node['commit'] as { oid?: unknown }).oid : undefined;
      const comment = parseComment(node);
      const submitted = typeof node['submittedAt'] === 'string' ? node['submittedAt'] : comment.createdAt;
      items.push({ kind: 'review', ...comment, createdAt: submitted, state, ...typeof commit === 'string' ? { commit } : {} });
    } else if (kind === 'PullRequestCommit') {
      const commit = object(node['pushed']);
      const oid = commit['oid'];
      if (typeof oid !== 'string' || !/^[a-f\d]{40,64}$/u.test(oid)) continue;
      const author = object(commit['author'] ?? {});
      const user = typeof author['user'] === 'object' && author['user'] !== null ? author['user'] as Record<string, unknown> : undefined;
      const rollup = typeof commit['statusCheckRollup'] === 'object' && commit['statusCheckRollup'] !== null ? String((commit['statusCheckRollup'] as { state?: unknown }).state) : undefined;
      const checks = rollup === 'SUCCESS' ? 'success' : rollup === 'FAILURE' || rollup === 'ERROR' ? 'failure' : rollup === 'PENDING' || rollup === 'EXPECTED' ? 'pending' : undefined;
      items.push({
        kind: 'commit', id: node['id'] as string, oid,
        headline: typeof commit['messageHeadline'] === 'string' ? commit['messageHeadline'] : '',
        message: typeof commit['messageBody'] === 'string' ? commit['messageBody'] : '',
        author: typeof user?.['login'] === 'string' ? user['login'] : typeof author['name'] === 'string' ? author['name'] : 'unknown',
        avatarUrl: optionalHttpsUrl(author['avatarUrl']),
        createdAt: typeof commit['committedDate'] === 'string' ? commit['committedDate'] : '',
        ...checks === undefined ? {} : { checks },
        ...typeof commit['additions'] === 'number' && typeof commit['deletions'] === 'number' ? { additions: commit['additions'], deletions: commit['deletions'] } : {},
        ...typeof commit['changedFilesIfAvailable'] === 'number' ? { files: commit['changedFilesIfAvailable'] } : {},
      });
    } else {
      const said = eventText(node);
      if (said === undefined) continue;
      const actor = typeof node['actor'] === 'object' && node['actor'] !== null ? node['actor'] as Record<string, unknown> : {};
      items.push({
        kind: 'event', id: node['id'] as string, actor: typeof actor['login'] === 'string' ? actor['login'] : 'ghost',
        avatarUrl: optionalHttpsUrl(actor['avatarUrl']), createdAt: typeof node['createdAt'] === 'string' ? node['createdAt'] : '', text: said,
      });
    }
  }
  return items;
}

const mergeStates: Record<string, MergeState> = {
  BEHIND: 'behind', BLOCKED: 'blocked', CLEAN: 'clean', DIRTY: 'dirty', HAS_HOOKS: 'hasHooks', UNKNOWN: 'unknown', UNSTABLE: 'unstable',
};
const permissions: Record<string, RepositoryPermission> = { ADMIN: 'admin', MAINTAIN: 'maintain', WRITE: 'write', TRIAGE: 'triage', TRIAGE_PLUS: 'triage', READ: 'read' };
const mergeMethodNames: Record<string, MergeMethod> = { MERGE: 'merge', SQUASH: 'squash', REBASE: 'rebase' };
const annotationLevels: Record<string, Annotation['level']> = { FAILURE: 'failure', WARNING: 'warning', NOTICE: 'notice' };

/** Whether a repository role may push, dismiss reviews and re-run workflows. */
export function canWrite(permission: RepositoryPermission): boolean {
  return permission === 'admin' || permission === 'maintain' || permission === 'write';
}

/** Validate the Conversation query: `repository` holds the PR's extras, `timeline` every page of timeline nodes. */
export function parseConversation(repository: Record<string, unknown>, viewer: Record<string, unknown>, timeline: readonly unknown[]): PullRequestConversation {
  const pullRequest = object(repository['pullRequest']);
  const viewerLogin = typeof viewer['login'] === 'string' ? viewer['login'] : '';
  const items = parseTimeline(timeline);
  const auto = typeof pullRequest['autoMergeRequest'] === 'object' && pullRequest['autoMergeRequest'] !== null ? pullRequest['autoMergeRequest'] as Record<string, unknown> : undefined;
  const autoMethod = auto === undefined ? undefined : mergeMethodNames[String(auto['mergeMethod'])];
  const queue = typeof pullRequest['mergeQueueEntry'] === 'object' && pullRequest['mergeQueueEntry'] !== null ? (pullRequest['mergeQueueEntry'] as { position?: unknown }).position : undefined;
  const decision = pullRequest['reviewDecision'];
  const headOid = typeof pullRequest['headRefOid'] === 'string' ? pullRequest['headRefOid'] : '';
  const commit = list(object(pullRequest['commits'] ?? { nodes: [] })['nodes'])[0];
  const rollup = commit === undefined ? null : object(object(commit)['commit'])['statusCheckRollup'];
  const checks: CheckExtras[] = [];
  if (typeof rollup === 'object' && rollup !== null) {
    for (const node of list(object((rollup as Record<string, unknown>)['contexts'])['nodes'])) {
      const check = object(node);
      const run = check['__typename'] === 'CheckRun';
      const name = run ? check['name'] : check['context'];
      if (typeof name !== 'string') continue;
      const workflow = run && typeof check['checkSuite'] === 'object' && check['checkSuite'] !== null ? (check['checkSuite'] as { workflowRun?: unknown }).workflowRun : undefined;
      const runId = typeof workflow === 'object' && workflow !== null ? (workflow as { databaseId?: unknown }).databaseId : undefined;
      const annotations = run ? list(object(check['annotations'] ?? { nodes: [] })['nodes']).map(object).flatMap((note): Annotation[] => {
        const location = object(note['location'] ?? {});
        const start = object(location['start'] ?? {})['line'];
        const end = object(location['end'] ?? {})['line'];
        const path = note['path'];
        const level = annotationLevels[String(note['annotationLevel'])];
        if (typeof path !== 'string' || !Number.isSafeInteger(start) || !Number.isSafeInteger(end) || level === undefined || (start as number) < 1) return [];
        return [{ path, startLine: start as number, endLine: Math.max(start as number, end as number), level,
          title: typeof note['title'] === 'string' ? note['title'] : '', message: typeof note['message'] === 'string' ? note['message'] : '' }];
      }) : [];
      checks.push({ name, required: check['isRequired'] === true, ...Number.isSafeInteger(runId) ? { runId: runId as number } : {}, annotations });
    }
  }
  const reviewIds: Record<string, string> = {};
  for (const node of list(object(pullRequest['latestOpinionatedReviews'] ?? { nodes: [] })['nodes']).map(object)) {
    const author = login(node['author']);
    if (typeof node['id'] === 'string' && author !== 'ghost') reviewIds[author] = node['id'];
  }
  const lastReviewedCommit = items.filter((item): item is Extract<TimelineItem, { kind: 'review' }> => item.kind === 'review' && item.author === viewerLogin && item.state !== 'pending' && item.commit !== undefined).at(-1)?.commit;
  const pick = <T extends string>(value: unknown, allowed: readonly T[], fallback: T): T => allowed.includes(value as T) ? value as T : fallback;
  return {
    timeline: items,
    description: { id: text(pullRequest['id']), reactions: parseReactions(pullRequest['reactionGroups']), canReact: pullRequest['viewerCanReact'] === true },
    viewerLogin,
    permission: permissions[String(repository['viewerPermission'])] ?? 'none',
    merge: {
      state: mergeStates[String(pullRequest['mergeStateStatus'])] ?? 'unknown',
      ...decision === 'APPROVED' ? { reviewDecision: 'approved' } : decision === 'CHANGES_REQUESTED' ? { reviewDecision: 'changes' } : decision === 'REVIEW_REQUIRED' ? { reviewDecision: 'required' } : {},
      canUpdateBranch: pullRequest['viewerCanUpdateBranch'] === true,
      canBypass: pullRequest['viewerCanMergeAsAdmin'] === true,
      ...autoMethod === undefined ? {} : { autoMerge: { method: autoMethod, enabledBy: login(auto?.['enabledBy']) } },
      canEnableAutoMerge: pullRequest['viewerCanEnableAutoMerge'] === true,
      canDisableAutoMerge: pullRequest['viewerCanDisableAutoMerge'] === true,
      autoMergeAllowed: repository['autoMergeAllowed'] === true,
      mergeQueue: pullRequest['isMergeQueueEnabled'] === true,
      ...Number.isSafeInteger(queue) ? { queuePosition: (queue as number) + 1 } : {},
      headOid,
      headDeleted: pullRequest['headRef'] === null && pullRequest['isCrossRepository'] !== true,
    },
    checks,
    linkedIssues: list(object(pullRequest['closingIssuesReferences'] ?? { nodes: [] })['nodes']).map(object).flatMap((issue) => {
      const url = optionalHttpsUrl(issue['url']);
      return Number.isSafeInteger(issue['number']) && typeof issue['title'] === 'string' && url
        ? [{ number: issue['number'] as number, title: issue['title'], url, open: issue['state'] === 'OPEN' }] : [];
    }),
    reviewIds,
    commitDefaults: {
      squashTitle: pick(repository['squashMergeCommitTitle'], ['PR_TITLE', 'COMMIT_OR_PR_TITLE'], 'COMMIT_OR_PR_TITLE'),
      squashBody: pick(repository['squashMergeCommitMessage'], ['PR_BODY', 'COMMIT_MESSAGES', 'BLANK'], 'COMMIT_MESSAGES'),
      mergeTitle: pick(repository['mergeCommitTitle'], ['PR_TITLE', 'MERGE_MESSAGE'], 'MERGE_MESSAGE'),
      mergeBody: pick(repository['mergeCommitMessage'], ['PR_TITLE', 'PR_BODY', 'BLANK'], 'PR_TITLE'),
    },
    ...lastReviewedCommit === undefined ? {} : { lastReviewedCommit },
    awaitingApproval: [],
  };
}

function logins(connection: unknown): readonly string[] {
  return list(object(connection)['nodes']).map((node) => object(node)['login']).filter((login): login is string => typeof login === 'string');
}

/** Labels with a six-digit hex color; others are left out. */
function parseLabels(connection: unknown): readonly Label[] {
  return list(object(connection)['nodes']).map(object).flatMap((label) => {
    const { name, color, description } = label;
    if (typeof name !== 'string' || typeof color !== 'string' || !/^[0-9a-f]{6}$/iu.test(color)) return [];
    return [typeof description === 'string' && description.trim() ? { name, color, description: description.trim() } : { name, color }];
  });
}

/** A linked PR's state from a `pullRequest` node. */
export function parseLinkedState(pr: Record<string, unknown>): LinkedPullRequestState {
  const rollup = object(object(object(list(object(pr['commits'])['nodes'])[0])['commit'])['statusCheckRollup'])['state'];
  const checks = rollup === 'SUCCESS' ? 'success' : rollup === 'FAILURE' || rollup === 'ERROR' ? 'failure' : rollup === 'PENDING' || rollup === 'EXPECTED' ? 'pending' : undefined;
  const decision = pr['reviewDecision'];
  const review = decision === 'APPROVED' ? 'approved' : decision === 'CHANGES_REQUESTED' ? 'changes' : decision === 'REVIEW_REQUIRED' ? 'required' : undefined;
  return {
    number: pr['number'] as number, title: text(pr['title']), url: httpsUrl(pr['url']),
    state: pr['state'] === 'MERGED' ? 'merged' : pr['state'] === 'CLOSED' ? 'closed' : 'open', draft: pr['isDraft'] === true,
    headBranch: text(pr['headRefName']), headOid: text(pr['headRefOid']), canPush: pr['viewerCanUpdate'] === true,
    ...(checks === undefined ? {} : { checks }), ...(review === undefined ? {} : { review }),
  };
}

/** Users, teams and labels for the reviewer, assignee and label pickers; a repository owned by a user has no teams. */
export function parsePickerOptions(repository: Record<string, unknown>): PickerOptions {
  const owner = repository['owner'];
  const teams = typeof owner === 'object' && owner !== null && 'teams' in owner ? list(object((owner as Record<string, unknown>)['teams'])['nodes']).map(object) : [];
  return {
    users: logins(repository['assignableUsers']),
    teams: teams.flatMap(({ name, slug }) => typeof name === 'string' && typeof slug === 'string' ? [{ name, slug }] : []),
    labels: parseLabels(repository['labels']),
    milestones: list(object(repository['milestones'] ?? { nodes: [] })['nodes']).map(parseMilestone).flatMap((entry) => entry.milestone === undefined ? [] : [entry.milestone]),
  };
}

/** Read review threads, skipping file-level ones and threads whose comments are all gone. */
export function parseReviewThreads(nodes: unknown): readonly RemoteThread[] {
  const threads: RemoteThread[] = [];
  for (const node of list(nodes)) {
    const thread = object(node);
    const outdated = thread['isOutdated'] === true;
    const endLine = outdated ? thread['originalLine'] : thread['line'];
    const startLine = (outdated ? thread['originalStartLine'] : thread['startLine']) ?? endLine;
    const comments = list(object(thread['comments'])['nodes']).map(object);
    if (!Number.isSafeInteger(endLine) || !Number.isSafeInteger(startLine) || comments.length === 0) continue;
    threads.push({
      id: text(thread['id']),
      path: text(thread['path']),
      side: thread['diffSide'] === 'LEFT' ? 'LEFT' : 'RIGHT',
      startLine: startLine as number,
      endLine: endLine as number,
      outdated,
      resolved: thread['isResolved'] === true,
      pending: comments[0]?.['state'] === 'PENDING',
      url: httpsUrl(comments[0]?.['url']),
      comments: comments.map((comment) => ({ ...parseComment(comment), pending: comment['state'] === 'PENDING' })),
    });
  }
  return threads;
}

/** Narrow an untrusted CLI value to a plain object. */
function object(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('GitHub returned incomplete data.');
  return value as Record<string, unknown>;
}

/** Narrow an untrusted CLI value to an array. */
function list(value: unknown): readonly unknown[] {
  if (!Array.isArray(value)) throw new Error('GitHub returned incomplete data.');
  return value as readonly unknown[];
}

/** Require a non-empty string without coercion. */
/** A non-negative count from GitHub, or undefined. */
function count(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

/** An ISO time from GitHub, or undefined when it does not parse. */
function isoTime(value: unknown): string | undefined {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value)) ? value : undefined;
}

function text(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error('GitHub returned incomplete data.');
  return value;
}

/** Accept only credential-free HTTPS links for browser navigation. */
/** A user's profile name, else their login; undefined when GitHub sent neither. */
function displayName(user: Record<string, unknown>): string | undefined {
  const name = user['name'];
  if (typeof name === 'string' && name.trim()) return name.trim();
  return typeof user['login'] === 'string' && user['login'] ? user['login'] : undefined;
}

/** A link GitHub may leave out, such as a deleted user's avatar; empty when missing or not https. */
function optionalHttpsUrl(value: unknown): string {
  try {
    return httpsUrl(value);
  } catch {
    return '';
  }
}

function httpsUrl(value: unknown): string {
  const url = new URL(text(value));
  if (url.protocol !== 'https:' || url.username || url.password) throw new Error('GitHub returned an invalid link.');
  return url.toString();
}
