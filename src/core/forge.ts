
/** Open pull request shown in the sidebar, validated from provider output. */
export interface PullRequestSummary {
  readonly number: number;
  readonly title: string;
  readonly url: string;
  readonly author: string;
  readonly draft: boolean;
  readonly headBranch: string;
  readonly baseBranch: string;
  /** The PR's latest commit on GitHub when listed; absent in lists saved before it was read. */
  readonly headOid?: string;
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
  /** `team` holds the team's slug for a requested team; `rerequested` marks a reviewer asked again after their review, whose `state` stays that review's. */
  readonly reviewers: readonly { readonly name: string; readonly state: 'requested' | 'approved' | 'changes' | 'commented' | 'dismissed'; readonly team?: string; readonly rerequested?: true }[];
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
  /** `comments` holds the IDs of the review's diff comments, which the page shows from their threads. */
  | (GitHubComment & { readonly kind: 'review'; readonly state: 'approved' | 'changes' | 'commented' | 'dismissed' | 'pending'; readonly commit?: string; readonly comments: readonly string[] })
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
  /** Set when the thread is about the whole file; its lines are then a placeholder for line 1. */
  readonly scope?: 'file';
  /** The diff hunk the first comment was written on, ending at its last line. */
  readonly diffHunk?: string;
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
  /** How many open PRs this repository has, from GitHub search's count without listing them. */
  openCount(): Promise<number>;
  /** The PRs among `numbers` that are still open, read fresh. */
  openPullRequests(numbers: readonly number[]): Promise<readonly PullRequestSummary[]>;
  /** One PR in any state, or undefined when the repository has none with that number. */
  pullRequest(number: number): Promise<PullRequestSummary | undefined>;
  conversation(number: number): Promise<PullRequestConversation>;
  /** Post a comment on the PR itself, outside any review; resolves with its link. */
  addComment(number: number, body: string): Promise<string>;
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

/** A GET answered with its ETag, for asking later whether it changed. */
export interface Polled { readonly etag: string; readonly data: unknown }

/** A pull request a link names; `host` is absent for the short `owner/name#57` form. */
export interface PullRequestLink {
  readonly host?: string;
  readonly owner: string;
  readonly name: string;
  readonly number: number;
}

/** Another workspace repository Claude may change for a PR: where its worktrees live and how to reach its PRs. */
export interface WorkspaceRepository {
  readonly root: string;
  readonly storageRoot: string;
  readonly connect: () => Promise<PullRequestProvider>;
}
