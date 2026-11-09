import type { FileIcons } from './fileIcons.js';
import { randomUUID } from 'node:crypto';
import * as vscode from 'vscode';
import { pollWhileFocused } from './autoSync.js';
import { claudeStatus } from './claudeStatus.js';
import { orbLoaderStyles } from './orbLoader.js';
import type { ClaudeProgress } from './claudeRunner.js';
import type { ReviewIntent, ReviewThread } from './contracts.js';
import type { PullRequestSession } from './pullRequestSessions.js';
import type { Publication } from './pullRequestComments.js';
import { type CommentKind, type HideReason, type MergeMessage, type MergeMethod, type PickerOptions, type PullRequestConversation, type PullRequestDetails, type PullRequestSummary, type ReactionContent, reactionContents, type RemoteThread, type ReviewEvent } from './pullRequests.js';
import type { PickedSelection } from './pullRequestEdits.js';
import type { LinkedPullRequestState } from './pullRequests.js';
import { webviewStyles } from './webviewStyles.js';
import { icons } from './icons.js';
import { codePreviewStyles } from './codePreview.js';
import { type MarkdownBlock, markdownHtml } from './markdown.js';
import { parseSuggestions, withoutSuggestions } from './suggestions.js';
import { type FileDiff, highlightSource } from './unifiedDiff.js';
import type { DefinitionPeek } from './definitions.js';
import type { LineRange, ReadRange } from './reviewedFiles.js';
import type { Analysis } from './prAnalysis.js';
import { conflictFixLabel, type LocalChange, type LocalCommit } from './conflicts.js';
import { publishableText } from './pullRequestComments.js';
import type { MediaPreview } from './media.js';
import type { ClaudeConversation } from './claudeSessions.js';
import type { ClaudeChoice } from './setup.js';
import { isSessionId } from './sessionBinding.js';

/** Everything the review page shows for one PR, apart from the diff itself. */
export interface OverviewState {
  /** Set on the local review page: the workspace's own uncommitted changes, without GitHub. */
  readonly localMode?: true;
  /** On a local review page: your open PR from this branch, which the page can turn into. */
  readonly branchPullRequest?: { readonly number: number; readonly title: string };
  /** `#number title`, for the editor tab; the page shows `heading` beside a copyable number. */
  readonly title: string;
  readonly number?: number;
  readonly heading?: string;
  readonly author: string;
  readonly headBranch: string;
  readonly baseBranch: string;
  readonly url: string;
  readonly createdAt?: string;
  readonly updatedAt?: string;
  readonly changes?: { readonly additions: number; readonly deletions: number; readonly files: number };
  readonly reviewed?: { readonly done: number; readonly total: number };
  /** Paths of files marked reviewed. */
  readonly viewed: readonly string[];
  /** Line ranges marked read, collapsed in the diff. */
  readonly read: readonly ReadRange[];
  /** Claude's status; `fixingConflicts` is the current step while Claude fixes merge conflicts. */
  readonly claude: {
    readonly text: string; readonly running: boolean; readonly retry: boolean; readonly fixingConflicts?: string; readonly progress?: ClaudeProgress;
    /** The connected conversation's link, on pages whose comments go to a conversation you connect: whether it receives comments, and whether its review terminal is open. */
    readonly link?: { readonly delivering: boolean; readonly terminal: boolean };
  };
  readonly threads: readonly {
    readonly id: string;
    readonly location: string;
    readonly text: string;
    readonly status: string;
    /** What Claude is doing with this thread right now, while it waits for or works on it. */
    readonly working?: string;
    /** Claude's latest steps while it works on this thread. */
    readonly progress?: ClaudeProgress;
    /** The suggestion option written to the worktree from this thread, while the page is open. */
    readonly applied?: AppliedSuggestion;
    /** Commits Claude made while answering this thread, oldest first. */
    readonly commits?: readonly { readonly oid: string; readonly subject: string }[];
    readonly url?: string;
    /** The GitHub thread this one answers; the page shows it inside that thread, and publishing replies there. For a PR-level thread, the conversation comment it quotes. */
    readonly linkedTo?: string;
    /** What posting the thread on GitHub sends unless the user edits it; set while it is open and not posted. */
    readonly draft?: string;
    /** Claude's few-word name for the thread. */
    readonly title?: string;
    /** When Claude's latest answer, unseen on a review page yet, was written. */
    readonly newAnswer?: string;
    readonly path: string;
    /** Which diff side the comment is on: the base ("old") or the PR's version ("new"). */
    readonly side: DiffSide;
    readonly startLine: number;
    readonly endLine: number;
    /** `file` when the comment is about the whole file; the page shows it above the file's diff. `pullRequest` when it is about the PR, with an empty path; the page shows it under `linkedTo`, its conversation comment. */
    readonly scope?: 'file' | 'pullRequest';
    readonly resolved: boolean;
    /** Put away by the user; the page hides it unless archived threads are shown. */
    readonly archived?: true;
    /** Set when the thread holds a note from Claude's analysis. */
    readonly origin?: 'analysis';
    /** The commented code, shown as the lines a suggestion replaces. */
    /** The commented lines as highlighted HTML, sent when a message has suggestions. */
    readonly original?: readonly string[];
    /** Rendered from Markdown with escaped text only; `suggestions` holds each ```suggestion block's lines as highlighted HTML, shown as options. */
    /** `intent` is what the human sent the message with; messages from before it was shown leave it out. */
    readonly messages: readonly { readonly author: 'human' | 'claude'; readonly html: string; readonly createdAt: string; readonly intent?: ReviewIntent; readonly suggestions?: readonly (readonly string[])[] }[];
  }[];
  /** Diff comment threads on GitHub, by anyone; undefined while loading. */
  readonly github?: readonly GitHubThreadView[];
  readonly githubError?: string;
  /** Code host state; undefined while loading or when the host could not be reached. */
  readonly details?: PullRequestDetails;
  readonly detailsError?: string;
  /** Timeline, merge box extras and check notes; undefined while loading or when GitHub refused the query. */
  readonly conversation?: PullRequestConversation;
  readonly conversationError?: string;
  readonly analysis: AnalysisView;
  /** Claude's question, as HTML, when it stopped fixing conflicts without pushing. */
  readonly conflictQuestion?: string;
  /** Commits in the worktree that the PR's branch on GitHub does not have yet, oldest first. */
  readonly unpushed?: readonly LocalCommit[];
  /** Files the worktree changed beyond GitHub's head, by path: in unpushed commits, uncommitted, or both. */
  readonly local?: Readonly<Record<string, LocalChange>>;
  /** PRs and branches in other repositories this PR goes with; undefined until they are read. */
  readonly linked?: readonly LinkedChange[];
}

/** One row of the Linked changes card: another repository's PR, or a branch there without one. */
export interface LinkedChange {
  /** `owner/name#12`, or `owner/name` without a PR; what Unlink and the row's actions name. */
  readonly key: string;
  readonly repository: string;
  readonly sources: readonly ('mention' | 'pin' | 'claude' | 'manual')[];
  readonly pullRequest?: LinkedPullRequestState;
  /** The branch Claude's worktree is on, when there is one. */
  readonly branch?: string;
  readonly unpushed: number;
  /** The repository has a clone in this workspace, so its PR can open on its own review page. */
  readonly local: boolean;
  /** Why the row's state is missing, such as a failed read. */
  readonly problem?: string;
}

/** Claude's guided-review analysis: whether it runs, and the last result. */
export interface AnalysisView {
  readonly running: boolean;
  readonly step?: string;
  readonly progress?: ClaudeProgress;
  readonly error?: string;
  readonly result?: Analysis;
  /** The result was made for an older head commit. */
  readonly stale: boolean;
  /** Commits since the result's head, or undefined when that head is no longer in the branch's history, as after a force push. */
  readonly behind?: number;
}

export type DiffSide = 'old' | 'new';

export interface GitHubThreadView {
  readonly id: string;
  readonly location: string;
  readonly text: string;
  readonly status: string;
  readonly url: string;
  readonly path: string;
  readonly side: DiffSide;
  readonly startLine: number;
  readonly endLine: number;
  readonly outdated: boolean;
  readonly resolved: boolean;
  /** In the viewer's unsubmitted review, so only they see it. */
  readonly pending: boolean;
  /** Set when the thread is about the whole file; the page shows it above the file's diff. */
  readonly scope?: 'file';
  /** Bodies as GitHub rendered and sanitized them; `suggestion` when the body holds exactly one suggestion block to commit. */
  readonly messages: readonly GitHubMessageView[];
}

export interface GitHubMessageView {
  readonly id: string;
  readonly author: string;
  readonly authorName?: string;
  readonly avatarUrl: string;
  readonly pending: boolean;
  readonly html: string;
  readonly body: string;
  readonly canDelete: boolean;
  readonly canEdit: boolean;
  readonly canHide: boolean;
  readonly canReact: boolean;
  readonly hidden?: string;
  readonly edited: boolean;
  readonly reactions: PullRequestConversation['description']['reactions'];
  readonly createdAt: string;
  readonly suggestion?: true;
}

/** Which commits the Files tab shows: all of the PR, the commits since the viewer's last review, or the commits `from` to `to`. */
export type DiffRange = { readonly kind: 'all' } | { readonly kind: 'since' } | { readonly kind: 'commits'; readonly from: string; readonly to: string };
export interface DiffSelection { readonly range: DiffRange; readonly whitespace: boolean }
/** The files of a selection; `atHead` when the new side is the PR's latest version, so comments and context lines match it. */
export interface FilesView {
  readonly files: readonly FileDiff[];
  readonly selection: DiffSelection;
  readonly atHead: boolean;
  readonly icons?: FileIcons;
  /** Every file in the checkout, for the page's All files list. */
  readonly repositoryFiles?: readonly string[];
}
/** A GitHub suggestion picked for committing: the thread and its comment. */
/** A suggestion option written from a local thread: pushed, committed after unpushed commits, or only applied to the worktree. */
export interface AppliedSuggestion { readonly message: number; readonly option: number; readonly done: 'pushed' | 'committed' | 'applied' }
export interface PickedSuggestion { readonly thread: string; readonly comment: string }
export type FilePreview = { readonly kind: 'markdown'; readonly blocks: readonly MarkdownBlock[] } | { readonly kind: 'html'; readonly html: string; readonly marker: string; readonly scripted?: string };
type CommentIntent = Extract<ReviewIntent, 'ask' | 'implement'>;

/** A new comment written on lines of the page's diff. */
export interface PageComment {
  readonly path: string;
  readonly side: DiffSide;
  readonly startLine: number;
  readonly endLine: number;
  readonly text: string;
  readonly intent: CommentIntent;
}

/** What the page's buttons do. */
export interface OverviewActions {
  comment(comment: PageComment): Promise<void>;
  /** A new local comment about a whole file rather than some of its lines. */
  commentOnFile(path: string, text: string, intent: CommentIntent): Promise<void>;
  /** Reply in a local thread; `intent` decides whether Claude answers or changes the code. An empty `text` asks Claude to implement what the thread discussed. */
  reply(threadId: string, text: string, intent: CommentIntent): Promise<void>;
  resolve(threadId: string, resolved: boolean): Promise<void>;
  /** Hide a local thread from the page, or show it again; it keeps its conversation. */
  archive(threadId: string, archived: boolean): Promise<void>;
  publish(threadId: string): Promise<void>;
  /** Comment on the PR diff on GitHub, into the pending review or posted right away. */
  commentOnGitHub(comment: Omit<PageComment, 'intent'>, pending: boolean): Promise<void>;
  /** Comment on a whole file on GitHub, into the pending review or posted right away. */
  commentOnGitHubFile(path: string, text: string, pending: boolean): Promise<void>;
  replyOnGitHub(threadId: string, text: string): Promise<void>;
  /** Post a local thread on the PR diff with the text the user edited on the page. */
  postToGitHub(threadId: string, text: string, pending: boolean): Promise<void>;
  /** Hand a GitHub thread to Claude in a linked local thread; an empty `note` asks Claude to answer or implement the feedback as is. */
  askAboutGitHub(threadId: string, note: string, intent: CommentIntent): Promise<void>;
  /** Hand a conversation comment or review to Claude in a PR-level local thread that quotes and links it; an empty `note` asks about the comment as is. */
  askAboutComment(commentId: string, note: string, intent: CommentIntent): Promise<void>;
  resolveOnGitHub(threadId: string, resolved: boolean): Promise<void>;
  /** Delete one of the viewer's GitHub comments; the page asked first. */
  deleteOnGitHub(commentId: string): Promise<void>;
  /** The files of the current selection; `select` changes it first. */
  readFiles(select?: DiffSelection): Promise<FilesView>;
  /** Every line of a changed file's PR version, highlighted, to expand context. */
  readContext(path: string): Promise<readonly string[]>;
  /** A Markdown file as rendered blocks, or an HTML file's source for a sandboxed frame. */
  readPreview(path: string): Promise<FilePreview>;
  /** A changed image, SVG or PDF before and after the PR. */
  readMedia(path: string): Promise<MediaPreview>;
  /** Definition of the name at a position in a PR file, or in an earlier definition result. */
  findDefinition(at: { readonly path: string } | { readonly peek: string }, line: number, column: number): Promise<DefinitionPeek | undefined>;
  /** Whether the name at a position has a definition, to underline it while Cmd or Ctrl is held. */
  hasDefinition(at: { readonly path: string } | { readonly peek: string }, line: number, column: number): Promise<boolean>;
  openDefinition(peek: string): Promise<void>;
  /** The file extension to search language extensions for, when VS Code has no language support for the file. */
  missingLanguage(at: { readonly path: string } | { readonly peek: string }): Promise<string | undefined>;
  setViewed(path: string, viewed: boolean): Promise<void>;
  /** The user saw Claude's latest answers in these threads. */
  seeAnswers(threadIds: readonly string[]): Promise<void>;
  /** Mark lines read; `fileDone` also marks the whole file reviewed. */
  markRead(range: LineRange, fileDone: boolean): Promise<void>;
  unmarkRead(ids: readonly string[]): Promise<void>;
  openInEditor(path: string): Promise<void>;
  /** Show a repository file on the page, whole when it has no changes. */
  openFile?(path: string): Promise<void>;
  /** Stop showing unchanged files that were opened on the page. */
  closeFiles?(paths: readonly string[]): Promise<void>;
  /** Turn a local review page into the review page of its branch's PR, in the same tab. */
  openPullRequest?(): Promise<void>;
  /** Recent conversations of the page's folder, to resume one; only where you connect Claude yourself. */
  claudeConversations?(): Promise<readonly ClaudeConversation[]>;
  /** Connect Claude as the page's Claude menu chose; returns a notice for the page. */
  connectClaude?(choice: ClaudeChoice): Promise<string | undefined>;
  /** Open the PR's Claude conversation in a VS Code terminal. */
  openTerminal(): Promise<void>;
  /** Push the worktree's commits to the PR's branch. */
  push(): Promise<void>;
  /** The changes of one commit in the worktree, for a preview in the thread that made it. */
  readCommit(oid: string): Promise<readonly FileDiff[]>;
  retry(): void;
  /** Stop Claude's current run on this PR; resolves once it ended. */
  stopClaude(): Promise<void>;
  revealThread(id: string): Promise<void>;
  submitReview(event: ReviewEvent, body: string): Promise<void>;
  /** Merge the PR, then delete its branch when `deleteBranch` is set and GitHub allows it. */
  merge(method: MergeMethod, message: MergeMessage, deleteBranch: boolean): Promise<void>;
  /** Post a comment on the PR's conversation, outside any review. */
  addComment(text: string): Promise<void>;
  editComment(kind: CommentKind, id: string, text: string): Promise<void>;
  /** Delete one of the viewer's conversation comments; the page asked first. */
  deleteIssueComment(id: string): Promise<void>;
  /** Hide a comment for `reason`, or show it again with `undefined`. */
  hideComment(id: string, reason: HideReason | undefined): Promise<void>;
  react(subject: string, content: ReactionContent, on: boolean): Promise<void>;
  discardReview(): Promise<void>;
  /** Dismiss a reviewer's latest approval or change request, telling everyone `reason`. */
  dismissReview(login: string, reason: string): Promise<void>;
  rerequestReview(login: string): Promise<void>;
  /** Bring the base branch into the head branch with a merge commit or a rebase. */
  updateBranch(method: 'merge' | 'rebase'): Promise<void>;
  enableAutoMerge(method: MergeMethod, message: MergeMessage): Promise<void>;
  disableAutoMerge(): Promise<void>;
  enqueue(): Promise<void>;
  dequeue(): Promise<void>;
  /** Open a PR that reverts this merged one; returns its number and link. */
  revert(): Promise<{ readonly number: number; readonly url: string }>;
  restoreBranch(): Promise<void>;
  rerun(runId: number): Promise<void>;
  /** Approve the fork's waiting workflow runs; the page asked first. */
  approveRuns(): Promise<void>;
  /** Branches the PR could merge into instead, for the base menu. */
  branches(): Promise<readonly string[]>;
  /** Save a new base branch the page confirmed. */
  changeBase(branch: string): Promise<void>;
  renderMarkdown(text: string): Promise<string>;
  /** Commit GitHub suggestions to the PR branch in one commit and push it. */
  commitSuggestions(picked: readonly PickedSuggestion[]): Promise<void>;
  /** Replace a local thread's lines in the worktree with one option of a message's suggestions. */
  applySuggestion(threadId: string, message: number, option: number): Promise<void>;
  /** Post one option of a message's suggestions on GitHub as a suggestion on the thread's lines, in the pending review. */
  publishSuggestion(threadId: string, message: number, option: number): Promise<void>;
  /** Put back the file an uncommitted suggestion changed. */
  discardSuggestion(threadId: string): Promise<void>;
  /** Have the PR's Claude merge the base branch, resolve the conflicts and push; resolves when Claude is done. */
  fixConflicts(answer?: string): Promise<void>;
  /** Hide Claude's question about the conflicts. */
  dismissConflictQuestion(): void;
  editTitle(title: string): Promise<void>;
  editBody(body: string): Promise<void>;
  /** The repository's users, teams and labels for the page's pickers. */
  pickerOptions(): Promise<PickerOptions>;
  /** Save a picker's final selection. */
  pick(what: PickTarget, picked: PickedSelection): Promise<void>;
  setDraft(draft: boolean): Promise<void>;
  setOpen(open: boolean): Promise<void>;
  deleteBranch(): Promise<void>;
  /** Remove the PR's local worktree, which the page confirmed, and its local comments. */
  removeWorktree(): Promise<void>;
  refresh(): void;
  /** Ask GitHub whether the PR changed and move the worktree to a new head when that keeps local work; `problem` says why it stayed. */
  pollGitHub(): Promise<{ readonly reload: boolean; readonly files: boolean; readonly problem?: string }>;
  /** Open a linked PR's own review page. */
  openLinked(key: string): Promise<void>;
  /** Push Claude's commits in a linked worktree to its branch on GitHub. */
  pushLinked(key: string): Promise<void>;
  /** Push a linked branch without a PR and open a draft PR for it; returns the PR's link. */
  draftLinked(key: string): Promise<string>;
  /** Link a PR named by a GitHub link or `owner/name#12`. */
  link(link: string): Promise<void>;
  /** Hide a linked row until it is linked again. */
  unlink(key: string): Promise<void>;
  analyze(): Promise<void>;
  stopAnalysis(): void;
}

export type PickTarget = 'reviewers' | 'assignees' | 'labels' | 'milestone';
const pickTargets: readonly unknown[] = ['reviewers', 'assignees', 'labels', 'milestone'] satisfies PickTarget[];

export type DefinitionTarget = { readonly path: string } | { readonly peek: string };
type PageRange = { readonly path: string; readonly side: DiffSide; readonly startLine: number; readonly endLine: number };

/** What the page sends. The extension still validates each message, since the page renders untrusted HTML. */
export type PageMessage =
  | { readonly action: 'ready' | 'terminal' | 'push' | 'retry' | 'stop-claude' | 'refresh' | 'pr' | 'analyze' | 'analysis-stop' | 'remove-worktree' | 'open-pr' }
  | { readonly action: 'publish' | 'github' | 'thread'; readonly id: string }
  | { readonly action: 'context' | 'preview' | 'media' | 'editor' | 'open-file'; readonly path: string }
  | { readonly action: 'close-files'; readonly paths: readonly string[] }
  | { readonly action: 'linked-open' | 'linked-push' | 'linked-draft' | 'unlink'; readonly key: string }
  | { readonly action: 'link'; readonly link: string }
  | (PageRange & { readonly action: 'comment'; readonly form: string; readonly text: string; readonly intent: CommentIntent })
  | { readonly action: 'file-comment'; readonly form: string; readonly path: string; readonly text: string; readonly intent: CommentIntent }
  | (PageRange & { readonly action: 'github-comment'; readonly form: string; readonly text: string; readonly pending: boolean })
  | { readonly action: 'github-file-comment'; readonly form: string; readonly path: string; readonly text: string; readonly pending: boolean }
  | (PageRange & { readonly action: 'read'; readonly viewed: boolean })
  | { readonly action: 'unread'; readonly ids: readonly string[] }
  | { readonly action: 'seen-answers'; readonly ids: readonly string[] }
  | { readonly action: 'reply'; readonly form: string; readonly id: string; readonly text: string; readonly intent: CommentIntent }
  | { readonly action: 'github-reply'; readonly form: string; readonly id: string; readonly text: string }
  | { readonly action: 'github-publish'; readonly form: string; readonly id: string; readonly text: string; readonly pending: boolean }
  | { readonly action: 'github-ask'; readonly form: string; readonly id: string; readonly text: string; readonly intent: CommentIntent }
  | { readonly action: 'comment-ask'; readonly form: string; readonly id: string; readonly text: string; readonly intent: CommentIntent }
  | { readonly action: 'resolve' | 'github-resolve'; readonly id: string; readonly resolved: boolean }
  | { readonly action: 'archive'; readonly id: string; readonly archived: boolean }
  | { readonly action: 'github-delete'; readonly id: string }
  | { readonly action: 'apply-suggestion' | 'publish-suggestion'; readonly id: string; readonly message: number; readonly option: number }
  | { readonly action: 'discard-suggestion'; readonly id: string }
  | { readonly action: 'commit-diff'; readonly oid: string }
  | { readonly action: 'viewed'; readonly path: string; readonly viewed: boolean }
  | (DefinitionTarget & { readonly action: 'definition'; readonly line: number; readonly column: number })
  | (DefinitionTarget & { readonly action: 'probe'; readonly id: string; readonly line: number; readonly column: number })
  | { readonly action: 'open-definition'; readonly peek: string }
  | { readonly action: 'find-extension'; readonly extension: string }
  | { readonly action: 'review'; readonly event: ReviewEvent; readonly body: string }
  | { readonly action: 'merge' | 'auto-merge'; readonly method: MergeMethod; readonly headline?: string; readonly body?: string; readonly deleteBranch?: boolean }
  | { readonly action: 'edit-title'; readonly title: string }
  | { readonly action: 'update-branch'; readonly method: 'merge' | 'rebase' }
  | { readonly action: 'close' | 'reopen' | 'delete-branch' | 'fix-conflicts' | 'dismiss-conflict-question' }
  | { readonly action: 'discard-review' | 'auto-merge-off' | 'enqueue' | 'dequeue' | 'revert' | 'restore-branch' | 'approve-runs' | 'branches' }
  | { readonly action: 'change-base'; readonly branch: string }
  | { readonly action: 'dismiss-review'; readonly login: string; readonly text: string }
  | { readonly action: 'rerequest'; readonly login: string }
  | { readonly action: 'rerun'; readonly run: number }
  | { readonly action: 'files'; readonly range: DiffRange; readonly whitespace: boolean }
  | { readonly action: 'conversation-comment'; readonly form: string; readonly text: string }
  | { readonly action: 'edit-comment'; readonly form: string; readonly kind: CommentKind; readonly id: string; readonly text: string }
  | { readonly action: 'delete-issue-comment'; readonly id: string }
  | { readonly action: 'hide-comment'; readonly id: string; readonly hide: boolean; readonly reason?: HideReason }
  | { readonly action: 'react'; readonly id: string; readonly content: ReactionContent; readonly on: boolean }
  | { readonly action: 'markdown'; readonly form: string; readonly text: string }
  | { readonly action: 'commit-suggestions'; readonly picked: readonly PickedSuggestion[] }
  | { readonly action: 'fix-conflicts'; readonly text: string }
  | { readonly action: 'edit-body'; readonly body: string }
  | { readonly action: 'picker-options' | 'claude-conversations' }
  | ({ readonly action: 'connect-claude' } & ClaudeChoice)
  | { readonly action: 'copy-connect'; readonly command: 'reload' | 'connect' }
  | ({ readonly action: 'pick'; readonly what: PickTarget } & PickedSelection)
  | { readonly action: 'draft'; readonly draft: boolean };

/** What the extension sends the page; each field is handled on its own. */
export interface ExtensionMessage {
  readonly state?: OverviewState;
  readonly files?: readonly FileDiff[];
  /** Theme icons for the page's files and the repository's. */
  readonly icons?: FileIcons;
  /** Every file in the checkout, for the All files list. */
  readonly repositoryFiles?: readonly string[];
  /** The selection `files` shows, and whether its new side is the PR's latest version. */
  readonly selection?: DiffSelection;
  readonly atHead?: boolean;
  /** A commit's changes for the preview under it in a Local thread, or why they could not be read. */
  readonly commitDiff?: { readonly oid: string; readonly files: readonly FileDiff[] } | { readonly oid: string; readonly error: string };
  /** GitHub's rendering of a form's text, for its Preview tab. */
  readonly markdown?: { readonly form: string; readonly html: string };
  readonly reveal?: string | undefined;
  /** A guide step's key: show the guided layout at that step. */
  readonly revealStep?: string | undefined;
  /** A guide group's key: show the guided layout at that section. */
  readonly revealGroup?: string | undefined;
  /** A thread's id: open it and scroll to it. */
  readonly revealThread?: string | undefined;
  readonly filesError?: string;
  readonly preview?: FilePreview & { readonly path: string };
  readonly media?: MediaPreview & { readonly path: string };
  readonly context?: { readonly path: string; readonly lines: readonly string[] };
  readonly definition?: DefinitionPeek;
  readonly probe?: { readonly id: string; readonly found: boolean };
  readonly error?: string;
  /** A passing hint that clears itself; `extension` offers to search language extensions for that file extension. */
  readonly notice?: { readonly text: string; readonly extension?: string; readonly url?: string };
  /** The form whose send failed, so the page can enable it again. */
  readonly form?: string | undefined;
  /** The form whose send succeeded, or 'review'. */
  readonly done?: string | undefined;
  readonly idle?: true;
  readonly pickerOptions?: PickerOptions;
  readonly pickerError?: string;
  readonly branches?: readonly string[];
  readonly branchesError?: string;
  readonly conversations?: readonly ClaudeConversation[];
  readonly conversationsError?: string;
  /** A running Claude can now connect itself with `/diffguide:connect`. */
  readonly runningReady?: true;
}

const reviewEvents: readonly ReviewEvent[] =['approve', 'requestChanges', 'comment'];
const mergeMethods: readonly MergeMethod[] = ['squash', 'merge', 'rebase'];
const hideReasons: readonly unknown[] = ['OUTDATED', 'RESOLVED', 'DUPLICATE', 'OFF_TOPIC', 'LOW_QUALITY', 'SPAM', 'ABUSE'] satisfies HideReason[];
const commentIntents: readonly unknown[] = ['ask', 'implement'] satisfies CommentIntent[];
const maximumReviewLength = 60_000;
const isNameList = (value: unknown): value is readonly string[] => Array.isArray(value) && value.length <= 500
  && value.every((item) => typeof item === 'string' && item.length > 0 && item.length <= 200);
/** Actions that change the PR on GitHub, one at a time. */
const pullRequestActions = new Set(['review', 'merge', 'edit-title', 'edit-body', 'pick', 'draft', 'close', 'reopen', 'delete-branch',
  'discard-review', 'update-branch', 'auto-merge', 'auto-merge-off', 'enqueue', 'dequeue', 'revert', 'restore-branch', 'approve-runs', 'change-base',
  'dismiss-review', 'rerequest', 'rerun', 'commit-suggestions']);
/** Of those, the ones that need permission to edit the PR; the others check GitHub's own per-action flags. */
const editActions = new Set(['edit-title', 'edit-body', 'pick', 'draft', 'close', 'reopen', 'delete-branch', 'revert', 'restore-branch', 'change-base', 'rerequest', 'commit-suggestions']);
const commentKinds: readonly unknown[] = ['issue', 'review', 'reviewComment'] satisfies CommentKind[];
const isOid = (value: unknown): value is string => typeof value === 'string' && /^[a-f\d]{40,64}$/u.test(value);
const isOptionalText = (value: unknown): value is string | undefined => value === undefined || (typeof value === 'string' && value.length <= maximumReviewLength);

/** A Claude menu choice the page sent; a resumed conversation must be a session ID. */
function parseClaudeChoice(value: unknown): ClaudeChoice | undefined {
  const { how, session } = value as Record<string, unknown>;
  if (how === 'show' || how === 'new' || how === 'running' || how === 'copy') return { how };
  if (how !== 'resume') return undefined;
  if (session === undefined) return { how };
  return isSessionId(session) ? { how, session } : undefined;
}

/** A range the page asked for, checked against the PR's own commits. */
function parseRange(value: unknown, commits: readonly string[]): DiffRange | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const { kind, from, to } = value as Record<string, unknown>;
  if (kind === 'all' || kind === 'since') return { kind };
  return kind === 'commits' && isOid(from) && isOid(to) && commits.includes(from) && commits.includes(to) ? { kind, from, to } : undefined;
}
/** Open review pages by key; `sendFiles` reads the files again and then shows `reveal`. */
const panels = new Map<string, { readonly panel: vscode.WebviewPanel; readonly sendFiles: (reveal?: OverviewReveal) => void; readonly detach: () => vscode.WebviewPanel }>();

const isLine = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 1;
const isText = (value: unknown): value is string => typeof value === 'string' && value.trim() !== '' && value.length <= maximumReviewLength;

/** Where the review page scrolls when it opens: a file, a step of the guided review or a thread. `reload` reads the files first, for a file the page may not show yet. */
export type OverviewReveal = { readonly path: string; readonly reload?: true } | { readonly step: string } | { readonly group: string } | { readonly thread: string };

const revealMessage = (reveal: OverviewReveal | undefined): ExtensionMessage => reveal === undefined ? {}
  : 'path' in reveal ? { reveal: reveal.path } : 'step' in reveal ? { revealStep: reveal.step } : 'thread' in reveal ? { revealThread: reveal.thread } : { revealGroup: reveal.group };

/** Whether a review page is open. */
export function isPageOpen(key: string): boolean {
  return panels.has(key);
}

/** Show a review page if it is open; a reveal with `reload` reads the files again first, since the file may not be on the page yet. */
export function revealOpenPage(key: string, reveal?: OverviewReveal): boolean {
  const page = panels.get(key);
  if (page === undefined) return false;
  page.panel.reveal();
  if (reveal !== undefined && 'path' in reveal && reveal.reload === true) page.sendFiles(reveal);
  else if (reveal !== undefined) void page.panel.webview.postMessage(revealMessage(reveal)).then(undefined, () => undefined);
  return true;
}

/**
 * Show a review page, reusing it when already open, and redraw it whenever `onDidChange` fires.
 * `onDidChangeFiles` reads the files again, for a page whose files change without a commit.
 */
export async function showPullRequestOverview(
  key: string, read: () => Promise<OverviewState>, onDidChange: vscode.Event<unknown>, actions: OverviewActions, extensionUri: vscode.Uri, revealAt?: OverviewReveal,
  onDidChangeFiles?: vscode.Event<unknown>,
  /** An open page whose tab this page takes over, such as the local review of the checkout a PR is open on. */
  adopt?: string,
): Promise<void> {
  if (revealOpenPage(key, revealAt)) return;
  let reveal = revealAt;
  let state = await read();
  const adopted = adopt === undefined ? undefined : panels.get(adopt)?.detach();
  if (adopted !== undefined) adopted.title = state.title;
  const panel = adopted ?? vscode.window.createWebviewPanel('diffGuide.pullRequestOverview', state.title, vscode.ViewColumn.Active,
    { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'resources'), vscode.Uri.joinPath(extensionUri, 'dist')], retainContextWhenHidden: true, enableFindWidget: true });
  const resource = (...parts: string[]): string => panel.webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, ...parts)).toString();
  panel.webview.html = overviewHtml(state, resource('dist', 'overview.js'), resource('dist', 'pdf.js'));
  const post = (message: ExtensionMessage): void => { void panel.webview.postMessage(message).then(undefined, () => undefined); };
  const sendFiles = (select?: DiffSelection): void => {
    void actions.readFiles(select).then(({ files, selection, atHead, icons, repositoryFiles }) => {
      post({ files, selection, atHead, ...icons === undefined ? {} : { icons }, ...repositoryFiles === undefined ? {} : { repositoryFiles }, ...revealMessage(reveal) });
      reveal = undefined;
    }, (error: unknown) => {
      post({ filesError: error instanceof Error ? error.message : String(error) });
    });
  };
  panels.set(key, { panel, sendFiles: (next) => { reveal = next; sendFiles(); }, detach: () => { release(); disposed.dispose(); return panel; } });
  const conversation = (): PullRequestConversation | undefined => state.conversation;
  /** A comment on this page the viewer may change in the way `may` names, found in the conversation or a GitHub thread. */
  const findComment = (id: unknown, may: 'canEdit' | 'canDelete' | 'canHide' | 'canReact'): boolean => typeof id === 'string'
    && ((conversation()?.timeline ?? []).some((item) => item.kind !== 'commit' && item.kind !== 'event' && item.id === id && item[may])
      || (state.github ?? []).some((thread) => thread.messages.some((entry) => entry.id === id && entry[may])));
  let timer: ReturnType<typeof setTimeout> | undefined;
  /** Bumped by each read and each mark write; a read that is no longer the latest may predate a write, so it is dropped. */
  let generation = 0;
  /** Mark writes still running. A read during one would undo the page's own ticks, so the last write to finish redraws. */
  let writing = 0;
  const redraw = (): void => {
    if (timer !== undefined) return;
    timer = setTimeout(() => {
      timer = undefined;
      if (writing > 0) return;
      const started = ++generation;
      void read().then((next) => {
        if (started !== generation) return;
        const claudeStopped = state.claude.running && !next.claude.running;
        state = next;
        panel.title = next.title;
        post({ state: next });
        if (claudeStopped) sendFiles();
      }, () => undefined);
    }, 150);
  };
  const marking = async (write: Promise<void>): Promise<void> => {
    generation++;
    writing++;
    try { await write; } finally { writing--; redraw(); }
  };
  let busy = false;
  const subscriptions = [
    onDidChange(redraw),
    panel.webview.onDidReceiveMessage(async (value: unknown) => {
      if (typeof value !== 'object' || value === null) return;
      const { action, id, ids, paths, event, body, method, what, values, teams, draft, path, viewed, side, startLine, endLine, text, intent, resolved, archived, pending, form, peek, line, column, extension, message, option,
        range, whitespace, kind, hide, reason, content, on, login, run, headline, picked, branch, oid, title, deleteBranch, key, link, command } = value as Record<string, unknown>;
      const formKey = typeof form === 'string' && form.length <= 200 ? form : undefined;
      try {
        if (action === 'ready') sendFiles();
        else if (action === 'comment' && typeof path === 'string' && (side === 'old' || side === 'new') && isLine(startLine) && isLine(endLine)
          && startLine <= endLine && isText(text) && commentIntents.includes(intent)) {
          await actions.comment({ path, side, startLine, endLine, text: text.trim(), intent: intent as CommentIntent });
          post({ done: formKey });
        } else if (action === 'file-comment' && typeof path === 'string' && isText(text) && commentIntents.includes(intent)) {
          await actions.commentOnFile(path, text.trim(), intent as CommentIntent);
          post({ done: formKey });
        } else if (action === 'github-comment' && typeof path === 'string' && (side === 'old' || side === 'new') && isLine(startLine) && isLine(endLine)
          && startLine <= endLine && isText(text) && typeof pending === 'boolean') {
          await actions.commentOnGitHub({ path, side, startLine, endLine, text: text.trim() }, pending);
          post({ done: formKey });
        } else if (action === 'github-file-comment' && typeof path === 'string' && isText(text) && typeof pending === 'boolean') {
          await actions.commentOnGitHubFile(path, text.trim(), pending);
          post({ done: formKey });
        } else if (action === 'reply' && typeof id === 'string' && commentIntents.includes(intent) && (isText(text) || (intent === 'implement' && isOptionalText(text)))) {
          await actions.reply(id, (text ?? '').trim(), intent as CommentIntent);
          post({ done: formKey });
        } else if (action === 'resolve' && typeof id === 'string' && typeof resolved === 'boolean') await actions.resolve(id, resolved);
        else if (action === 'archive' && typeof id === 'string' && typeof archived === 'boolean' && state.threads.some((thread) => thread.id === id)) await actions.archive(id, archived);
        else if (action === 'publish' && typeof id === 'string') await actions.publish(id);
        else if (action === 'github-reply' && typeof id === 'string' && isText(text) && state.github?.some((thread) => thread.id === id)) {
          await actions.replyOnGitHub(id, text.trim());
          post({ done: formKey });
        } else if (action === 'github-publish' && typeof id === 'string' && isText(text) && typeof pending === 'boolean') {
          await actions.postToGitHub(id, text.trim(), pending);
          post({ done: formKey });
        } else if (action === 'github-ask' && typeof id === 'string' && isOptionalText(text) && commentIntents.includes(intent) && state.github?.some((thread) => thread.id === id)) {
          await actions.askAboutGitHub(id, text ?? '', intent as CommentIntent);
          post({ done: formKey });
        } else if (action === 'comment-ask' && typeof id === 'string' && isOptionalText(text) && commentIntents.includes(intent)
          && (conversation()?.timeline ?? []).some((item) => (item.kind === 'comment' || item.kind === 'review') && item.id === id && item.body.trim() !== '')) {
          await actions.askAboutComment(id, text ?? '', intent as CommentIntent);
          post({ done: formKey });
        } else if (action === 'github-resolve' && typeof id === 'string' && typeof resolved === 'boolean' && state.github?.some((thread) => thread.id === id)) {
          await actions.resolveOnGitHub(id, resolved);
        } else if (action === 'github-delete' && typeof id === 'string' && state.github?.some((thread) => thread.messages.some((entry) => entry.id === id && entry.canDelete))) {
          await actions.deleteOnGitHub(id);
        }
        else if (action === 'context' && typeof path === 'string') post({ context: { path, lines: await actions.readContext(path) } });
        else if (action === 'preview' && typeof path === 'string') post({ preview: { path, ...await actions.readPreview(path) } });
        else if (action === 'media' && typeof path === 'string') post({ media: { path, ...await actions.readMedia(path) } });
        else if (action === 'definition' && (typeof path === 'string' || typeof peek === 'string') && isLine(line) && Number.isSafeInteger(column) && (column as number) >= 0) {
          const at = typeof peek === 'string' ? { peek } : { path: path as string };
          const found = await actions.findDefinition(at, line, column as number);
          if (found !== undefined) post({ definition: found });
          else {
            const missing = await actions.missingLanguage(at).catch(() => undefined);
            post({ notice: missing === undefined ? { text: 'No definition found here.' } : { text: `No definition found. VS Code has no language support for .${missing} files.`, extension: missing } });
          }
        } else if (action === 'probe' && (typeof path === 'string' || typeof peek === 'string') && isLine(line) && Number.isSafeInteger(column) && (column as number) >= 0
          && typeof id === 'string' && id.length <= 400) {
          const found = await actions.hasDefinition(typeof peek === 'string' ? { peek } : { path: path as string }, line, column as number).catch(() => false);
          post({ probe: { id, found } });
        } else if (action === 'open-definition' && typeof peek === 'string') await actions.openDefinition(peek);
        else if ((action === 'apply-suggestion' || action === 'publish-suggestion') && typeof id === 'string' && state.threads.some((thread) => thread.id === id)
          && Number.isSafeInteger(message) && (message as number) >= 0 && Number.isSafeInteger(option) && (option as number) >= 0) {
          await (action === 'apply-suggestion' ? actions.applySuggestion : actions.publishSuggestion)(id, message as number, option as number);
          if (action === 'apply-suggestion') sendFiles();
        } else if (action === 'discard-suggestion' && typeof id === 'string' && state.threads.some((thread) => thread.id === id)) {
          await actions.discardSuggestion(id);
          sendFiles();
        } else if (action === 'dismiss-conflict-question') actions.dismissConflictQuestion();
        else if (action === 'fix-conflicts' && (text === undefined || isText(text))) {
          void actions.fixConflicts(text?.trim()).catch((error: unknown) => { post({ error: error instanceof Error ? error.message : String(error) }); });
        }
        else if (action === 'find-extension' && typeof extension === 'string' && /^[\w+-]{1,20}$/u.test(extension)) {
          await vscode.commands.executeCommand('workbench.extensions.search', `ext:${extension}`);
        }
        else if (action === 'commit-diff' && isOid(oid) && state.threads.some((thread) => thread.commits?.some((commit) => commit.oid === oid))) {
          try { post({ commitDiff: { oid, files: await actions.readCommit(oid) } }); } catch (error: unknown) { post({ commitDiff: { oid, error: error instanceof Error ? error.message : String(error) } }); }
        }
        else if (action === 'files' && typeof whitespace === 'boolean') {
          const commits = [
            ...(conversation()?.timeline ?? []).flatMap((item) => item.kind === 'commit' ? [item.oid] : []),
            ...state.threads.flatMap((thread) => thread.commits ?? []).map((commit) => commit.oid),
            ...(state.unpushed ?? []).map((commit) => commit.oid),
          ];
          const parsed = parseRange(range, commits);
          if (parsed !== undefined) sendFiles({ range: parsed, whitespace });
        } else if (action === 'conversation-comment' && isText(text)) {
          await actions.addComment(text.trim());
          post({ done: formKey });
        } else if (action === 'edit-comment' && commentKinds.includes(kind) && findComment(id, 'canEdit') && isText(text)) {
          await actions.editComment(kind as CommentKind, id as string, text.trim());
          post({ done: formKey });
        } else if (action === 'delete-issue-comment' && findComment(id, 'canDelete')) await actions.deleteIssueComment(id as string);
        else if (action === 'hide-comment' && typeof hide === 'boolean' && (!hide || hideReasons.includes(reason)) && findComment(id, 'canHide')) {
          await actions.hideComment(id as string, hide ? reason as HideReason : undefined);
        }
        else if (action === 'react' && reactionContents.includes(content as ReactionContent) && typeof on === 'boolean'
          && (findComment(id, 'canReact') || (id === conversation()?.description.id && conversation()?.description.canReact === true))) {
          await actions.react(id as string, content as ReactionContent, on);
        } else if (action === 'markdown' && typeof text === 'string' && text.length <= maximumReviewLength && formKey !== undefined) {
          post({ markdown: { form: formKey, html: text.trim() ? await actions.renderMarkdown(text) : '' } });
        }
        else if (action === 'branches') {
          try { post({ branches: await actions.branches() }); } catch (error: unknown) { post({ branchesError: error instanceof Error ? error.message : String(error) }); }
        }
        else if (action === 'picker-options') {
          try { post({ pickerOptions: await actions.pickerOptions() }); } catch (error: unknown) { post({ pickerError: error instanceof Error ? error.message : String(error) }); }
        }
        else if ((action === 'linked-open' || action === 'linked-push' || action === 'linked-draft' || action === 'unlink') && typeof key === 'string' && state.linked?.some((row) => row.key === key)) {
          if (action === 'linked-open') await actions.openLinked(key);
          else if (action === 'linked-push') await actions.pushLinked(key);
          else if (action === 'unlink') await actions.unlink(key);
          else post({ notice: { text: 'Opened a draft PR.', url: await actions.draftLinked(key) } });
          redraw();
        } else if (action === 'link' && typeof link === 'string' && link.length <= 500) {
          await actions.link(link);
          post({ done: 'link' });
          redraw();
        }
        else if (action === 'claude-conversations' && actions.claudeConversations !== undefined) {
          try { post({ conversations: await actions.claudeConversations() }); } catch (error: unknown) { post({ conversationsError: error instanceof Error ? error.message : String(error) }); }
        }
        else if (action === 'connect-claude' && actions.connectClaude !== undefined) {
          const choice = parseClaudeChoice(value);
          if (choice !== undefined) {
            const notice = await actions.connectClaude(choice);
            if (choice.how === 'running') post({ runningReady: true });
            if (notice !== undefined) post({ notice: { text: notice } });
          }
        }
        else if (action === 'copy-connect' && (command === 'reload' || command === 'connect')) {
          await vscode.env.clipboard.writeText(command === 'reload' ? '/reload-plugins --force' : '/diffguide:connect');
        }
        else if (action === 'open-pr' && actions.openPullRequest !== undefined) await actions.openPullRequest();
        else if (action === 'terminal') await actions.openTerminal();
        else if (action === 'push') await actions.push();
        else if (action === 'retry') actions.retry();
        else if (action === 'stop-claude') await actions.stopClaude();
        else if (action === 'analyze') await actions.analyze();
        else if (action === 'analysis-stop') actions.stopAnalysis();
        else if (action === 'remove-worktree') { await actions.removeWorktree(); panel.dispose(); }
        else if (action === 'refresh') {
          actions.refresh();
          sendFiles();
        } else if (action === 'pr') await vscode.env.openExternal(vscode.Uri.parse(state.url));
        else if (action === 'thread' && typeof id === 'string') await actions.revealThread(id);
        else if (action === 'viewed' && typeof path === 'string' && typeof viewed === 'boolean') await marking(actions.setViewed(path, viewed));
        else if (action === 'read' && typeof path === 'string' && (side === 'old' || side === 'new') && isLine(startLine) && isLine(endLine)
          && startLine <= endLine && typeof viewed === 'boolean') await marking(actions.markRead({ path, side, startLine, endLine }, viewed));
        else if (action === 'seen-answers' && isNameList(ids)) await actions.seeAnswers(ids.filter((each) => state.threads.some((thread) => thread.id === each)));
        else if (action === 'unread' && Array.isArray(ids) && ids.length <= 1000 && ids.every((item) => typeof item === 'string')) await marking(actions.unmarkRead(ids as string[]));
        else if (action === 'editor' && typeof path === 'string') await actions.openInEditor(path);
        else if (action === 'open-file' && typeof path === 'string' && actions.openFile !== undefined) await actions.openFile(path);
        else if (action === 'close-files' && isNameList(paths) && actions.closeFiles !== undefined) {
          await actions.closeFiles(paths);
          sendFiles();
        }
        else if (action === 'github' && typeof id === 'string') {
          const url = [...state.threads, ...state.github ?? []].find((thread) => thread.id === id)?.url;
          if (url !== undefined) await vscode.env.openExternal(vscode.Uri.parse(url));
        } else if (typeof action === 'string' && pullRequestActions.has(action) && !busy) {
          busy = true;
          try {
            if (editActions.has(action) && state.details?.canEdit !== true) {
              throw new Error('You do not have permission to edit this pull request.');
            }
            const merge = conversation()?.merge;
            const mergeMessage = (): MergeMessage => ({ ...typeof headline === 'string' && headline.trim() ? { headline: headline.trim() } : {}, ...typeof body === 'string' ? { body } : {} });
            if (action === 'review' && reviewEvents.includes(event as ReviewEvent) && typeof body === 'string' && body.length <= maximumReviewLength) {
              await actions.submitReview(event as ReviewEvent, body.trim());
              post({ done: 'review' });
            } else if ((action === 'merge' || action === 'auto-merge') && mergeMethods.includes(method as MergeMethod) && isOptionalText(headline) && isOptionalText(body)
              && (deleteBranch === undefined || typeof deleteBranch === 'boolean')) {
              if (action === 'merge') await actions.merge(method as MergeMethod, mergeMessage(), deleteBranch === true);
              else if (merge?.canEnableAutoMerge === true) await actions.enableAutoMerge(method as MergeMethod, mergeMessage());
              else throw new Error(merge?.autoMergeAllowed === false ? 'Auto-merge is off in this repository\'s settings.' : 'GitHub does not offer auto-merge for this PR right now.');
              post({ done: 'merge' });
            } else if (action === 'auto-merge-off' && merge?.canDisableAutoMerge === true) await actions.disableAutoMerge();
            else if (action === 'enqueue' && merge?.mergeQueue === true) await actions.enqueue();
            else if (action === 'dequeue' && merge?.queuePosition !== undefined) await actions.dequeue();
            else if (action === 'update-branch' && (method === 'merge' || method === 'rebase') && merge?.canUpdateBranch === true) await actions.updateBranch(method);
            else if (action === 'discard-review' && state.details?.pendingComments !== undefined) await actions.discardReview();
            else if (action === 'dismiss-review' && typeof login === 'string' && isText(text) && conversation()?.reviewIds[login] !== undefined) {
              await actions.dismissReview(login, text.trim());
              post({ done: 'dismiss' });
            }
            else if (action === 'rerequest' && typeof login === 'string' && state.details?.reviewers.some((reviewer) => reviewer.name === login && reviewer.team === undefined)) await actions.rerequestReview(login);
            else if (action === 'rerun' && Number.isSafeInteger(run) && conversation()?.checks.some((check) => check.runId === run)) await actions.rerun(run as number);
            else if (action === 'approve-runs' && (conversation()?.awaitingApproval.length ?? 0) > 0) await actions.approveRuns();
            else if (action === 'revert' && state.details?.merged === true) {
              const created = await actions.revert();
              post({ notice: { text: `Opened #${created.number} to revert this PR.`, url: created.url } });
            }
            else if (action === 'restore-branch' && merge?.headDeleted === true) await actions.restoreBranch();
            else if (action === 'change-base' && state.details?.open === true && typeof branch === 'string' && branch.length <= 255) {
              await actions.changeBase(branch);
              sendFiles();
            } else if (action === 'commit-suggestions' && Array.isArray(picked) && picked.length > 0 && picked.length <= 100) {
              const valid = (picked as unknown[]).every((item) => {
                const { thread, comment } = (typeof item === 'object' && item !== null ? item : {}) as Record<string, unknown>;
                return state.github?.some((entry) => entry.id === thread && !entry.outdated && entry.side === 'new' && entry.messages.some((each) => each.id === comment && each.suggestion === true));
              });
              if (!valid) throw new Error('A picked suggestion is no longer on this PR. Refresh and pick again.');
              await actions.commitSuggestions(picked as PickedSuggestion[]);
              post({ done: 'suggestions' });
              sendFiles();
            } else if (action === 'edit-title' && isText(title) && title.length <= 256) {
              await actions.editTitle(title.trim());
              post({ done: 'title' });
            }
            else if (action === 'edit-body' && typeof body === 'string' && body.length <= maximumReviewLength) {
              await actions.editBody(body);
              post({ done: 'body' });
            } else if (action === 'pick' && pickTargets.includes(what) && isNameList(values) && isNameList(teams) && (what !== 'milestone' || (values.length <= 1 && values.every((entry) => /^\d{1,9}$/u.test(entry))))) {
              await actions.pick(what as PickTarget, { values, teams });
            }
            else if (action === 'draft' && typeof draft === 'boolean') await actions.setDraft(draft);
            else if (action === 'close' || action === 'reopen') await actions.setOpen(action === 'reopen');
            else if (action === 'delete-branch') await actions.deleteBranch();
          } finally {
            // GitHub writes can succeed before a later step or the response fails.
            // Re-read authoritative state even when the action rejects.
            actions.refresh();
            redraw();
            busy = false;
            post({ idle: true });
          }
        }
      } catch (error: unknown) {
        post({ error: error instanceof Error ? error.message : String(error), form: formKey });
      }
    }),
  ];
  let shownProblem: string | undefined;
  const sync = pollWhileFocused(30_000, () => panel.visible, async () => {
    const { reload, files, problem } = await actions.pollGitHub();
    if (reload) actions.refresh();
    if (files) sendFiles();
    if (problem !== undefined && problem !== shownProblem) post({ error: problem });
    shownProblem = problem;
  });
  subscriptions.push(sync, panel.onDidChangeViewState(({ webviewPanel }) => { if (webviewPanel.visible) sync.now(); }));
  if (onDidChangeFiles !== undefined) subscriptions.push(onDidChangeFiles(() => { sendFiles(); }));
  sync.now();
  const release = (): void => {
    if (timer !== undefined) clearTimeout(timer);
    for (const subscription of subscriptions) subscription.dispose();
    panels.delete(key);
  };
  const disposed = panel.onDidDispose(release);
}

/** The review page: PR overview on top, every changed file below. `script` (src/webview/overview.ts) draws it from state and file messages. */
/** `pdfScript` is the URL of pdf.js, which the page loads on its first PDF. */
export function overviewHtml(state: OverviewState, script: string, pdfScript?: string): string {
  const nonce = randomUUID().replaceAll('-', '');
  // Inline styles are allowed because an HTML preview frame inherits this policy; its scripts run only with the nonce the page gives them.
  return `<!doctype html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src https: data:; font-src data:; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<title>Review</title>
<style nonce="${nonce}">
${webviewStyles}
${codePreviewStyles()}
body{margin:0;padding:var(--space-24) var(--space-24) 48px}
[hidden],body.local .pr-only{display:none!important}
h1{font-size:18px;line-height:26px;font-weight:600;margin:0;overflow-wrap:anywhere}
h2{font-size:14px;font-weight:600;margin:0}
h3{margin:0 0 var(--space-8);font-size:12px;line-height:18px;font-weight:600;color:var(--ink)}
.row{display:flex;align-items:center;gap:var(--space-8);flex-wrap:wrap}#conflict-row{flex-wrap:nowrap}#conflict-row>button{margin-left:auto;flex-shrink:0}#conflict-note{min-width:0;max-width:100%}#conflict-note::before{flex-shrink:0}#conflict-note>span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}#conflict-ask{margin-top:var(--space-8)}#conflict-reply{margin-top:var(--space-8)}.head{justify-content:space-between}
.byline,.facts{margin-top:var(--space-6)}
.status{margin-top:var(--space-12);font-size:12px}
.layout{display:grid;grid-template-columns:minmax(0,1fr) 320px;gap:var(--space-16);margin-top:var(--space-16);align-items:start}
@media (max-width:760px){.layout{grid-template-columns:minmax(0,1fr)}}
body.local .layout{grid-template-columns:minmax(0,1fr)}
.main-col{display:grid;gap:var(--space-16);min-width:0}
.card{padding:var(--space-12);border:1px solid var(--line);border-radius:var(--radius-md)}
#linked-rows{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:var(--space-8)}.linked-row{display:flex;align-items:center;gap:var(--space-12)}.linked-row+.linked-row{padding-top:var(--space-8);border-top:1px solid var(--line)}
.linked-row .what{flex:1;min-width:0}.linked-row .name{display:flex;gap:var(--space-8);align-items:baseline;min-width:0}.linked-row .repo{font-family:var(--font-code);font-size:12px;color:var(--ink-muted)}.linked-row .name a,.linked-row .name .title{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.linked-row .facts{display:flex;flex-wrap:wrap;align-items:center;gap:var(--space-4) var(--space-8);font-size:12px;color:var(--ink-muted)}
.link-form{display:flex;gap:var(--space-8);align-items:center;margin-top:var(--space-8)}.link-form input{flex:1;height:26px;padding:0 var(--space-8);font-size:12px}
.rail{border:1px solid var(--line);border-radius:var(--radius-md)}.rail section{padding:var(--space-12)}.rail p.muted,.rail span.muted,#review-note{font-size:12px;line-height:16px}.rail section+section{border-top:1px solid var(--line)}
.seg{display:inline-flex;gap:var(--space-2);padding:var(--space-2);border-radius:var(--radius-sm);background:color-mix(in srgb,var(--ink) 7%,transparent)}
.seg button{min-height:22px;height:22px;padding:0 var(--space-8);border:0;border-radius:3px;color:var(--ink-muted);background:none;font-size:12px}
.seg button:hover{color:var(--ink);filter:none}
.seg button[aria-pressed=true]{color:var(--ink);background:var(--surface);box-shadow:0 0 0 1px var(--line);font-weight:600}
.seg.icons button{width:26px;padding:0}
.toolbar{display:flex;align-items:center;gap:var(--space-4)}.toolbar .divider{width:1px;height:16px;margin:0 var(--space-4);background:var(--line)}
.progress{display:inline-flex;align-items:center;gap:var(--space-8)}
.bar{width:160px;height:6px;border-radius:var(--radius-pill);background:color-mix(in srgb,var(--ink) 16%,transparent);overflow:hidden}
.bar span{display:block;height:100%;border-radius:inherit;background:var(--brand)}
.ref{min-height:20px;height:20px;gap:var(--space-4);padding:0 var(--space-6);border:0;color:var(--github);background:var(--github-soft);font:12px/18px var(--font-code)}
.ref:hover{filter:none}.ref svg{width:12px;height:12px;opacity:.55}.ref:hover svg,.ref:focus-visible svg{opacity:1}
.ref .done,.ref.copied .copy{display:none}.ref.copied .done{display:block;opacity:1}
ul{list-style:none;margin:0;padding:0}li{padding:var(--space-6) 0;font-size:12px}li+li{border-top:1px solid var(--line)}
.where{font-family:var(--font-code);font-size:12px}.text{overflow-wrap:anywhere}
.ok{color:var(--success)}.bad{color:var(--danger)}.wait{color:var(--warning)}
.state-icon{display:inline-flex;flex:none;align-items:center;justify-content:center;width:16px;height:16px}.state-icon svg{width:14px;height:14px;fill:currentColor}
#body{overflow-wrap:anywhere}#body img{max-width:100%}#body pre{overflow:auto;padding:var(--space-8);border-radius:var(--radius-sm);background:var(--surface-sunken)}#body>:first-child{margin-top:0}#body>:last-child{margin-bottom:0}
textarea{width:100%;min-height:80px}
.actions,.spaced{margin-top:var(--space-8)}
.review-actions{justify-content:flex-end}.state-actions{justify-content:flex-end}
.title-row{display:flex;align-items:center;gap:var(--space-4);min-width:0}#number{display:contents}#number .ref{flex:none;margin-right:var(--space-4)}
.section-head{display:flex;align-items:center;justify-content:space-between;gap:var(--space-8);margin-bottom:var(--space-8)}.section-head h3{margin:0}.section-head .icon-button{width:22px;height:22px;min-height:22px;margin:-2px 0}
section:has(>.picker){position:relative}.picker{position:absolute;top:28px;left:0;right:0;z-index:6;display:flex;flex-direction:column;gap:var(--space-4);padding:var(--space-6);border:1px solid var(--line);border-radius:var(--radius-lg);background:var(--surface-raised);box-shadow:var(--shadow-overlay)}.picker input[type=text]{width:100%;height:26px;padding:0 var(--space-8);font-size:12px}.picker input[type=text]:focus-visible{outline:1px solid var(--focus);outline-offset:-1px}
.picker-list{display:flex;flex-direction:column;max-height:280px;overflow:auto}.picker-row{position:relative;display:flex;flex:none;align-items:center;gap:var(--space-8);min-height:24px;padding:0 var(--space-4);border-radius:var(--radius-sm);font-size:12px;cursor:pointer}.picker-row:hover{background:color-mix(in srgb,var(--ink) 8%,transparent)}.picker-row input{position:absolute;opacity:0;pointer-events:none}.picker-row .check{flex:none;width:16px;height:16px;fill:currentColor;visibility:hidden}.picker-row:has(input:checked) .check{visibility:visible}.picker-row>svg:not(.check){flex:none;width:14px;height:14px;color:var(--ink-muted)}.picker-row:has(input:focus-visible){outline:1px solid var(--focus);outline-offset:-1px}.picker-row .muted{margin-left:auto}.picker-note{padding:var(--space-6);font-size:12px}.picker-label{display:grid;grid-template-columns:16px 10px minmax(0,1fr);column-gap:var(--space-8);align-items:center;flex:1;min-width:0;padding:var(--space-4) 0}.picker-label .dot{width:10px;height:10px;border-radius:50%;background:var(--label)}.picker-row .picker-description{grid-column:3;margin-left:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.picker-row:has(.picker-label)+.picker-row{border-top:1px solid color-mix(in srgb,var(--ink) 10%,transparent)}
.labels{display:flex;flex-wrap:wrap;gap:var(--space-4)}.label{display:inline-flex;align-items:center;height:20px;padding:0 var(--space-8);border:1px solid color-mix(in srgb,var(--label) 55%,transparent);border-radius:var(--radius-pill);font-size:12px;background:color-mix(in srgb,var(--label) 16%,transparent)}
.state-actions:not(:empty){margin-top:var(--space-8)}.state-actions .gap{flex:1}#body textarea{width:100%;min-height:120px}
.verdict{display:inline-flex;align-items:center;height:24px;box-sizing:border-box;padding:0 var(--space-12);border:1px solid currentColor;border-radius:var(--radius-pill);font-size:12px;font-weight:600}
.verdict.muted{color:var(--ink-muted)}
.answers{position:fixed;right:var(--space-24);bottom:var(--space-16);z-index:5;display:flex;flex-direction:column;width:min(340px,calc(100vw - 32px));border:1px solid var(--agent);border-radius:var(--radius-lg);overflow:hidden;color:var(--ink);background:var(--surface-raised);box-shadow:var(--shadow-overlay);font-size:12px}
.answers[hidden]{display:none}.answers .answers-head{display:flex;align-items:center;gap:var(--space-6);padding:var(--space-6) var(--space-8) var(--space-6) var(--space-12);font-weight:600;color:var(--agent)}.answers .answers-head .gap{flex:1}
.answers .answer{display:grid;grid-template-columns:16px minmax(0,1fr) auto;align-items:center;column-gap:var(--space-6);width:100%;min-height:28px;padding:0 var(--space-12);border:0;border-top:1px solid var(--line);color:var(--ink);background:none;font:inherit;text-align:left;cursor:pointer}.answers .answer:hover{background:var(--agent-soft)}.answers .answer:focus-visible{outline:1px solid var(--focus);outline-offset:-1px}
.answers .answer .text{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.answers .answer .muted{white-space:nowrap}.answers .answer svg{width:14px;height:14px;color:var(--ink-muted)}
#notice{position:fixed;left:var(--space-24);bottom:var(--space-16);z-index:5;display:flex;align-items:center;gap:var(--space-12);max-width:520px;margin:0;padding:var(--space-8) var(--space-12);border:1px solid var(--line);border-radius:var(--radius-lg);color:var(--ink);background:var(--surface-raised);box-shadow:var(--shadow-overlay)}#notice:empty{display:none}
#error{position:fixed;left:var(--space-24);right:var(--space-24);bottom:var(--space-16);z-index:5;max-width:520px;margin:0;padding:var(--space-8) var(--space-12);border:1px solid var(--danger);border-radius:var(--radius-lg);color:var(--ink);background:linear-gradient(var(--danger-soft),var(--danger-soft)),var(--surface-raised);box-shadow:var(--shadow-overlay);white-space:pre-wrap;cursor:pointer}#error:empty{display:none}
#files-bar{position:sticky;top:0;z-index:3;margin-top:var(--space-16);padding:var(--space-8) 0;background:var(--surface);border-bottom:1px solid var(--line)}#files-bar::after{content:'';position:absolute;left:0;right:0;top:calc(100% + 1px);height:var(--space-12);background:var(--surface);pointer-events:none}
#files-bar.on-overview .view-head>:not(.tabs):not(#nav-toggle),#files-bar.on-overview .toolbar>:not(#bar-review){display:none}#files-bar.on-overview #nav-toggle{visibility:hidden}.bar-review{gap:var(--space-6)}.pending-chip{padding:0 var(--space-6);border-radius:var(--radius-pill);font-size:11px;font-weight:600;line-height:18px;color:var(--pending);background:var(--pending-soft)}
#files-bar h2 .muted{font-weight:400}
#files-bar .view-head{flex:1 1 0;flex-wrap:nowrap;min-width:min(320px,100%)}#files-bar .toolbar{flex:0 1 auto}#files-title{flex:none;white-space:nowrap}
.view-head{gap:var(--space-12);min-width:0;max-width:100%}.tabs{display:flex;gap:var(--space-4);min-width:0;max-width:100%}
.tabs button{display:inline-flex;align-items:center;gap:var(--space-6);min-height:28px;padding:0 var(--space-8);border:0;border-bottom:2px solid transparent;border-radius:0;color:var(--ink-muted);background:none;font-size:14px;font-weight:600}
.tabs button:hover{color:var(--ink);filter:none}.tabs button[aria-selected=true]{color:var(--ink);border-bottom-color:var(--ink)}
.tabs svg{width:16px;height:16px;fill:currentColor}
.tabs>*{flex:none;white-space:nowrap}.file-icon{display:inline-block;width:16px;font-size:14px;font-weight:400;line-height:1;text-align:center}img.file-icon{height:16px}.file-head .file-icon{flex:none}
.tabs .count{min-width:18px;height:18px;padding:0 var(--space-6);border-radius:var(--radius-pill);font-size:11px;font-weight:600;line-height:18px;text-align:center;color:var(--ink);background:color-mix(in srgb,var(--ink) 12%,transparent)}.tabs .count:empty{display:none}
#view-guide.busy>svg{color:var(--agent)}#view-guide.busy>svg>path{animation:guide-busy 1.2s steps(1,end) infinite}@keyframes guide-busy{25%{transform:translateY(-1px)}50%{transform:none}75%{transform:translateY(1px)}}
@media (prefers-reduced-motion:reduce){#view-guide.busy>svg>path{animation:none}}
${orbLoaderStyles()}
.off-view{display:none}
.files-layout{display:grid;grid-template-columns:minmax(160px,240px) minmax(0,1fr);gap:var(--space-16);align-items:start}.files-layout>#files{min-width:0}.files-layout.no-nav,.files-layout.list-hidden{grid-template-columns:minmax(0,1fr)}.files-layout.no-nav>#nav-col,.files-layout.list-hidden>#nav-col{display:none}
.files-layout{grid-template-columns:var(--nav-width,minmax(160px,240px)) minmax(0,1fr)}#nav-resize{position:absolute;top:0;bottom:0;right:calc(-1 * var(--space-8) - 3px);z-index:1;width:6px;cursor:ew-resize}#nav-resize:hover,#nav-resize.dragging{background:var(--brand-line)}
#nav-split{flex:none;height:var(--space-8);margin:calc(-1 * var(--space-8)) 0;cursor:ns-resize}#nav-split:hover,#nav-split.dragging{background:linear-gradient(var(--brand-line),var(--brand-line)) center/100% 2px no-repeat}body.resizing-rows{cursor:ns-resize;user-select:none}
#nav-threads{flex:none;box-sizing:border-box;height:var(--nav-threads-height,200px);overflow:auto;padding:var(--space-4) 0;border:1px solid var(--line);border-radius:var(--radius-md);font-size:12px}#nav-threads .nav-head{position:sticky;top:calc(-1 * var(--space-4));z-index:1;background:var(--surface)}
.nav-thread-file{display:flex;align-items:center;gap:var(--space-6);min-height:22px;padding:0 var(--space-8);color:var(--ink-muted);font-family:var(--font-code)}.nav-thread-file .nav-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.nav-thread-file .file-icon{flex:none;width:14px;font-size:13px}.nav-thread-file img.file-icon{height:14px}
.nav-thread{--accent:var(--ink-muted)}.nav-thread.github{--accent:var(--github)}.nav-thread.analysis{--accent:var(--agent)}.nav-kind{flex:none;display:inline-flex;color:var(--accent)}.nav-kind svg{width:12px;height:12px;fill:currentColor}.nav-lines{flex:none;color:var(--ink-muted);font-variant-numeric:tabular-nums}.nav-file.nav-thread .nav-name{font-family:var(--font-ui)}
#nav-col{position:sticky;top:calc(var(--bar-height,46px) + var(--space-12));display:flex;flex-direction:column;gap:var(--space-8);max-height:calc(100vh - var(--bar-height,46px) - var(--space-12) - 48px);margin-top:var(--space-12);min-width:0}.nav-tools{display:flex;align-items:center;gap:var(--space-4);flex:none}.nav-tools .filter-box{flex:1;min-width:0}.nav-tools #file-filter{width:100%;height:26px}.nav-tools #filter-clear{top:3px}.nav-tools .toolbar-menu{right:auto;left:0}#nav-toggle{position:relative}#nav-toggle::after{right:auto;left:0}#nav-toggle.filtered::before{content:'';position:absolute;top:3px;right:3px;width:6px;height:6px;border-radius:var(--radius-pill);background:var(--git-modified)}#file-nav{min-height:0;overflow:auto;padding:var(--space-4) 0;border:1px solid var(--line);border-radius:var(--radius-md);font-size:12px}
#nav-col{z-index:3}
.nav-head{display:flex;align-items:center;justify-content:flex-start;gap:var(--space-6);width:100%;min-height:26px;height:26px;padding:0 var(--space-8);border:0;border-radius:0;background:none;color:var(--ink);font-size:12px;font-weight:600;text-align:left}.nav-head:hover{filter:none}.nav-head .muted{font-weight:400}.nav-head .chevron{display:none}
.nav-list{list-style:none;margin:0;padding:0}.nav-list li{padding:0}.nav-list li+li{border-top:0}.nav-list .nav-folder{display:flex;align-items:center;gap:var(--space-4);min-height:22px;padding:0 var(--space-8) 0 calc(var(--space-8) + var(--depth,0) * 12px);color:var(--ink-muted);font-family:var(--font-code);font-size:12px;cursor:pointer;user-select:none}.nav-folder .chevron{width:12px;height:12px;-webkit-mask-size:12px;mask-size:12px}
.nav-file{display:flex;align-items:center;justify-content:flex-start;gap:var(--space-6);width:100%;min-height:22px;height:22px;padding:0 var(--space-8) 0 calc(var(--space-8) + var(--depth,0) * 12px);border:0;border-radius:0;background:none;color:var(--ink);font-size:12px;text-align:left}.nav-file:hover{filter:none;background:var(--brand-soft)}.nav-file[aria-current=true]{background:var(--brand-soft);box-shadow:inset 2px 0 0 var(--brand-line)}
.nav-file .nav-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:var(--font-code)}.nav-file.done .nav-name,.nav-file.unchanged .nav-name{color:var(--ink-muted)}.nav-file .badge{flex:none;width:12px;font:600 11px var(--font-code);text-align:center}.nav-file .file-icon{flex:none;width:14px;font-size:13px}.nav-file img.file-icon{height:14px}
.nav-folder .nav-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.nav-dot{flex:none;width:6px;height:6px;margin-right:var(--space-4);border-radius:var(--radius-pill);background:var(--git-modified)}
.nav-list .nav-group{display:flex;align-items:center;gap:var(--space-6);min-height:24px;margin-top:var(--space-4);padding:var(--space-4) var(--space-8) 0;border-top:1px solid var(--line);color:var(--ink);font-size:12px;font-weight:600}.nav-list .nav-group .muted{font-weight:400}.nav-list .nav-group:first-child{margin-top:0;border-top:0}.nav-list .nav-sep{margin:var(--space-4) 0;padding:0;border-top:1px solid var(--line)}.nav-close-all{margin-left:auto}
.nav-list li.closable{position:relative}.nav-list li.closable .nav-file{padding-right:calc(var(--space-8) + 18px)}.nav-close{position:absolute;top:2px;right:var(--space-4);width:18px;height:18px;min-height:18px;padding:0;visibility:hidden}.nav-close svg{width:12px;height:12px}.nav-list li.closable:hover .nav-close,.nav-close:focus-visible{visibility:visible}
.nav-section{display:flex;align-items:center;justify-content:flex-start;gap:var(--space-6);width:100%;min-height:24px;height:24px;margin-top:var(--space-4);padding:0 var(--space-8);border:0;border-radius:0;background:none;color:var(--ink);font-size:12px;font-weight:600;text-align:left}.nav-section:hover{filter:none;background:var(--brand-soft)}.nav-section .chevron{width:12px;height:12px;-webkit-mask-size:12px;mask-size:12px;margin-left:calc(-1 * var(--space-4))}.nav-sev{flex:none;width:8px;height:8px;border-radius:var(--radius-pill);background:var(--sev)}.nav-section .nav-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.nav-progress{flex:none;font-weight:400;color:var(--ink-muted);font-variant-numeric:tabular-nums}
.nav-step{padding-left:calc(var(--space-8) + 26px)}.nav-step .nav-name{font-family:var(--font-ui)}.nav-number{flex:none;min-width:14px;color:var(--ink-muted);font-variant-numeric:tabular-nums;text-align:right}
.nav-count{flex:none;min-width:16px;padding:0 var(--space-4);border-radius:var(--radius-pill);font-size:10px;line-height:16px;text-align:center;color:var(--ink-muted);background:var(--action-secondary)}.nav-done{flex:none;width:12px;height:12px;color:var(--success)}.nav-done svg{width:12px;height:12px}
@media (max-width:1000px){.files-layout{grid-template-columns:minmax(0,1fr)}#nav-col{position:static;max-height:none}#file-nav .nav-head .chevron{display:inline-block}#file-nav.folded .nav-list{display:none}}
@media (max-width:1000px){#nav-resize{display:none}}
@media (max-width:1000px){#nav-split{display:none}#nav-threads{height:auto;max-height:240px}}
.file{margin-top:var(--space-12);border:1px solid var(--line-strong);border-top:0;border-radius:var(--radius-md);scroll-margin-top:calc(var(--bar-height,46px) + var(--space-12) + 10px)}
.file-head{position:sticky;top:calc(var(--bar-height,46px) + var(--space-12));z-index:2;box-shadow:0 -12px 0 var(--surface);display:flex;align-items:center;gap:var(--space-8);margin:0 -1px;padding:var(--space-6) var(--space-12);background:var(--surface-raised);border:1px solid var(--line-strong);border-bottom-color:var(--line);border-radius:var(--radius-md) var(--radius-md) 0 0}
.file>.diff{border-radius:0 0 calc(var(--radius-md) - 1px) calc(var(--radius-md) - 1px);overflow:clip}.file.ending{border-color:transparent}.file.ending>.file-head{border-bottom-color:var(--line-strong);border-radius:var(--radius-md)}.file.collapsed{border:0}.file.collapsed .file-head{margin:0;border-bottom-color:var(--line-strong);border-radius:var(--radius-md)}.file.collapsed .diff{display:none}
.file-head .name{font-family:var(--font-code);font-size:12px;overflow-wrap:anywhere;flex:1;cursor:pointer}
.chevron{display:inline-block;flex-shrink:0;width:16px;height:16px;vertical-align:-3px;color:var(--ink-muted);background:currentColor;-webkit-mask:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'%3E%3Cpath d='M3.146 5.854l4.5 4.5a.5.5 0 0 0 .707 0l4.5-4.5a.5.5 0 0 0-.707-.707L8 9.293 3.854 5.147a.5.5 0 0 0-.708.707z'/%3E%3C/svg%3E") center/16px no-repeat;mask:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'%3E%3Cpath d='M3.146 5.854l4.5 4.5a.5.5 0 0 0 .707 0l4.5-4.5a.5.5 0 0 0-.707-.707L8 9.293 3.854 5.147a.5.5 0 0 0-.708.707z'/%3E%3C/svg%3E") center/16px no-repeat;transition:transform .1s}.chevron{cursor:pointer}.chevron.closed{transform:rotate(-90deg)}.badge{width:14px;font:700 11px var(--font-code);text-align:center}
.local-mark{flex:none;font:600 11px var(--font-code);color:var(--warning)}.folder-head .local-mark{margin-left:var(--space-6)}
.badge.added{color:var(--git-added)}.badge.modified{color:var(--git-modified)}.badge.deleted{color:var(--git-deleted)}.badge.renamed{color:var(--git-renamed)}
.stats{font:12px var(--font-code)}.stat-add{color:var(--git-added)}.stat-del{color:var(--git-deleted)}
label.viewed{display:inline-flex;align-items:center;gap:var(--space-4);height:22px;box-sizing:border-box;padding:0 var(--space-8);border:1px solid var(--line-strong);border-radius:var(--radius-sm);font-size:12px;cursor:pointer}
label.viewed:has(input:checked){color:var(--brand);font-weight:600;background:color-mix(in srgb,var(--ink) 6%,transparent)}
label.viewed input,label.check input{margin:0;accent-color:var(--brand)}
.file-head button{min-height:22px;padding:0 var(--space-8);font-size:12px}.file-head .icon-button{width:22px;height:22px;padding:0}
.file-threads{padding:var(--space-8) 10px;border-bottom:1px solid var(--line)}
table{border-collapse:collapse;width:100%;table-layout:fixed;font-family:var(--vscode-editor-font-family,var(--font-code));font-size:var(--vscode-editor-font-size,12px);line-height:1.6}
col.num{width:52px}td{vertical-align:top;padding:0}
td.num{text-align:right;padding:0 var(--space-8);color:var(--vscode-editorLineNumber-foreground,var(--ink-muted));user-select:none}
td.code{white-space:pre-wrap;word-break:break-all;padding:0 10px 0 18px;text-indent:-10px}
td.code::before{content:'';display:inline-block;width:10px;color:var(--ink-muted)}
tr.add td.code::before{content:'+'}tr.del td.code::before{content:'-'}td.code.add::before{content:'+'}td.code.del::before{content:'-'}
tr.add td,td.add{background:var(--diff-add)}
tr.del td,td.del{background:var(--diff-del)}
td.empty{background:color-mix(in srgb,var(--ink) 4%,transparent)}
tr.hunk td{padding:var(--space-2) var(--space-12);color:var(--ink-muted);background:color-mix(in srgb,var(--ink) 6%,transparent);font-size:11px}
tr.read-run td{padding:var(--space-2) var(--space-12);color:var(--ink-muted);background:color-mix(in srgb,var(--ink) 3%,transparent);box-shadow:inset 2px 0 0 var(--brand);font-family:var(--font-ui);font-size:11px}
tr.read-run .read-label{display:inline-flex;align-items:center;gap:var(--space-4);vertical-align:middle;cursor:pointer;margin-right:10px}
tr.read-run button,.expand button{min-height:18px;padding:0 var(--space-8);font-size:11px;line-height:1.6}
.expand{display:inline-flex;gap:var(--space-2);margin-right:10px}
.composer-actions{gap:var(--space-8);margin-top:var(--space-8)}.composer-actions .gap,.actions .gap{flex:1}
label.check{display:flex;align-items:center;gap:var(--space-6);padding-left:var(--space-12);border-left:1px solid var(--line);cursor:pointer;font-size:12px}.strip label.check{padding-left:10px;margin-left:2px}.strip .muted:has(+label.check){margin-left:auto}
td.code.linked{cursor:pointer}::highlight(lr-link){color:var(--vscode-textLink-activeForeground,var(--vscode-textLink-foreground));text-decoration:underline}
::highlight(lr-name){background-color:var(--vscode-editor-wordHighlightStrongBackground,rgba(255,213,0,.3))}
#peek{position:fixed;top:var(--space-8);right:var(--space-8);bottom:var(--space-8);z-index:6;width:var(--peek-width,min(560px,92vw));max-width:calc(100vw - 2 * var(--space-8));display:flex;flex-direction:column;border:1px solid var(--line);border-radius:var(--radius-lg);overflow:hidden;background:var(--surface-raised);box-shadow:var(--shadow-overlay)}
.peek-head{display:flex;align-items:center;gap:var(--space-8);padding:var(--space-8) 10px;border-bottom:1px solid var(--line)}.peek-head .where{flex:1;overflow-wrap:anywhere}
.peek-head button{min-height:24px;padding:0 var(--space-6)}.peek-head button[disabled]{opacity:.4;cursor:default}.peek-head svg{width:14px;height:14px}
.claude-live{display:flex;align-items:flex-start;gap:var(--space-12);margin:var(--space-8) 0 0 calc(20px + var(--space-8))}.claude-live .step-log{flex:1}.claude-box{display:flex;flex:1 1 100%;align-items:flex-start;gap:var(--space-12);padding:var(--space-8) var(--space-12);border:1px solid var(--line);border-radius:var(--radius-md)}.claude-box .step-log{flex:1}
.claude-box>button,.claude-live>button{margin-block:calc((18px - 26px) / 2)}.claude-box>button.small{margin-block:calc((18px - 22px) / 2)}
.step-log{display:flex;flex-direction:column;gap:var(--space-2);min-width:0;font:12px/18px var(--font-code);color:var(--ink)}
.step-log .step{display:grid;grid-template-columns:30px minmax(0,1fr) auto;column-gap:var(--space-6);align-items:center}
.step-log .mark{justify-self:center}.step-log .orb.step{justify-self:center;margin-block:-1px}.step-log .done{color:var(--ink-muted)}.step-log .failed .mark{color:var(--danger)}
.step-log .step-call,.step-log .detail{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.step-log .time{color:var(--ink-muted)}
.step-log .detail{grid-column:2/-1;color:var(--ink-muted)}.step-log .detail::before{content:'⎿ '}
.step-log .step:has(>.stop-claude,>#stop-claude){grid-template-columns:30px minmax(0,1fr) auto auto}.step-log .step>button{grid-column:-2;width:20px;height:20px;min-height:20px;margin-block:-1px}.step-log .step>button svg{width:14px;height:14px}
.thread-commits{margin-top:var(--space-8)}.thread-commits .chevron{cursor:pointer}.commit-preview{display:flex;flex-direction:column;gap:var(--space-8);margin:var(--space-4) 0 var(--space-8) 22px}.commit-preview>*{border:1px solid var(--line);border-radius:var(--radius-md);overflow:hidden}.commit-preview .preview-file{display:flex;gap:var(--space-8);padding:var(--space-4) var(--space-8);font-size:12px;background:var(--tint);border-bottom:1px solid var(--line)}.commit-preview .preview-file .name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;font-family:var(--font-code)}.commit-preview table{width:100%}.commit-preview .note{padding:var(--space-4) var(--space-8);font-size:12px}.thread-commits svg{flex:none;width:14px;height:14px;align-self:center;color:var(--ink-muted)}.thread-commits .chip{flex:none}
.suggestion{margin-top:var(--space-8);border:1px solid var(--line-strong);border-radius:var(--radius-md);overflow:hidden}
.suggestion-head{gap:var(--space-8);padding:var(--space-6) var(--space-8);background:var(--surface-raised);border-bottom:1px solid var(--line-strong)}
.suggestion-diff .add{background:var(--diff-add)}.suggestion-diff .del{background:var(--diff-del)}
.suggestion-diff{margin:0;padding:var(--space-4) 0;font:12px/18px var(--font-code);overflow:auto}.suggestion-diff div{padding:0 var(--space-8);white-space:pre}.suggestion-diff .sign{display:inline-block;width:16px;color:var(--ink-muted);user-select:none}
.suggestion .actions{margin:0;padding:var(--space-6) var(--space-8);border-top:1px solid var(--line-strong)}
.media{display:flex;flex-wrap:wrap;gap:var(--space-12);padding:var(--space-12)}
.media-side{flex:1 1 280px;min-width:0;margin:0;display:flex;flex-direction:column;gap:var(--space-6)}
.media-side figcaption{font-size:12px}
.media-side img{max-width:100%;max-height:600px;align-self:flex-start;border:1px solid var(--line);border-radius:var(--radius-sm);background:repeating-conic-gradient(color-mix(in srgb,var(--ink) 10%,transparent) 0 25%,transparent 0 50%) 0 0/16px 16px}
.pdf-pages{display:flex;flex-direction:column;gap:var(--space-8);max-height:min(70vh,800px);overflow:auto}.pdf-pages canvas{max-width:100%;height:auto;border:1px solid var(--line);border-radius:var(--radius-sm)}
#peek-code{flex:1;overflow:auto}
#peek-resize{position:absolute;left:0;top:0;bottom:0;z-index:1;width:6px;cursor:ew-resize}#peek-resize:hover,body.resizing #peek-resize{background:var(--brand-line)}body.resizing{cursor:ew-resize;user-select:none}tr.focus td{background:var(--vscode-editor-rangeHighlightBackground,rgba(255,213,0,.12))}
.note{padding:10px 14px}
.preview.md{padding:var(--space-8) 20px var(--space-12);font-family:var(--font-ui);line-height:1.6;overflow-wrap:anywhere}
.md-block{margin:0 -10px;padding:1px 10px;border-left:2px solid transparent;border-radius:var(--radius-sm);cursor:pointer}
.md-block:hover{background:color-mix(in srgb,var(--ink) 6%,transparent);border-left-color:var(--brand-line)}
.md-block.sel{background:var(--brand-soft);border-left-color:var(--brand-line)}
.preview.md>.thread{margin:4px 0 10px}
.md-block h1,.md-block h2{padding-bottom:4px;border-bottom:1px solid var(--line)}.md-block h1{font-size:1.8em}.md-block h2{font-size:1.4em}.md-block h3{font-size:1.15em}
.md-block code,.msg-text code{font-family:var(--font-code);font-size:.92em;padding:1px var(--space-4);border-radius:var(--radius-sm);background:var(--surface-sunken)}
.md-block pre,.msg-text pre{padding:var(--space-8) 10px;border:1px solid var(--line);border-radius:var(--radius-md);overflow:auto;background:var(--surface-sunken)}.md-block pre code,.msg-text pre code{padding:0;background:none}
.md-block table{border-collapse:collapse}.md-block th,.md-block td{padding:4px 10px;border:1px solid var(--line)}
.md-block blockquote,.msg-text blockquote{margin:var(--space-8) 0;padding-left:var(--space-12);border-left:3px solid var(--line);color:var(--ink-muted)}.md-block img,.msg-text img{max-width:100%}
.msg-text table{display:block;width:auto;max-width:100%;overflow-x:auto;margin:var(--space-6) 0;table-layout:auto;font:inherit}.msg-text th,.msg-text td{padding:var(--space-4) var(--space-8);border:1px solid var(--line);text-align:left;white-space:normal}.msg-text th{font-weight:600;background:var(--surface-sunken)}.msg-text .right{text-align:right}.msg-text .center{text-align:center}
.md-block hr{border:0;border-top:1px solid var(--line)}
.html-preview{display:block;width:100%;border:0}
.preview-note{margin:0;flex-wrap:nowrap}.preview-note>span{flex:1}
.html-split{display:grid;grid-template-columns:minmax(0,1fr) 320px;gap:var(--space-12);padding:0 var(--space-12) var(--space-12) 0}.html-margin{position:relative}.html-margin>.thread{position:absolute;left:0;right:0;margin:0}
@media (max-width:760px){.html-split{grid-template-columns:1fr;padding-right:0}.html-margin>.thread{position:static;margin:8px 12px}}
.html-split{max-height:min(70vh,800px);overflow:auto}
td.num.pick{cursor:pointer;position:relative}td.num.has-marks{position:relative}
.margin-marks{position:absolute;top:calc(.8em - 5px);left:var(--space-2);z-index:2;display:flex;gap:var(--space-2);line-height:0}.margin-mark{width:10px;height:10px;min-width:0;min-height:0;padding:0;border:0;border-radius:var(--radius-pill);background:var(--agent);cursor:pointer}.margin-mark.github{background:var(--github)}.margin-mark.analysis{background:var(--ink-muted)}.margin-mark:hover{box-shadow:0 0 0 2px var(--surface),0 0 0 3px currentColor}.margin-mark:focus-visible{outline:1px solid var(--focus);outline-offset:1px}
td.num.pick:hover::after,td.num.pick:has(+td.code:hover)::after,td.num.pick:has(+td.num:not(.pick)+td.code:hover)::after{content:'';position:absolute;top:calc(.8em - 8px);right:-13px;z-index:1;width:16px;height:16px;border-radius:var(--radius-sm);background:linear-gradient(var(--on-brand),var(--on-brand)) center/8px 2px no-repeat,linear-gradient(var(--on-brand),var(--on-brand)) center/2px 8px no-repeat,var(--brand)}td.num.pick:hover{color:var(--brand);background:color-mix(in srgb,var(--ink) 10%,transparent)}
td.drag-sel,td.sel{box-shadow:inset 0 0 0 999px var(--brand-soft)}
td.sel-start{box-shadow:inset 2px 0 0 var(--brand-line),inset 0 0 0 999px var(--brand-soft)}
tr.inline>td{padding:var(--space-6) 10px var(--space-8)}
.thread{--accent:var(--agent);--tint:var(--agent-soft);max-width:860px;box-sizing:border-box;padding:0 var(--space-12) var(--space-12);border:1px solid var(--line-strong);border-radius:var(--radius-md);overflow:clip;background:var(--surface-raised);font:13px/20px var(--font-ui)}
.thread.github{--accent:var(--github);--tint:var(--github-soft)}.thread.pending,.thread.draft{border:1px dashed var(--accent)}
.thread+.thread{margin-top:var(--space-6)}
.thread .thread{max-width:none;margin-top:var(--space-8)}.thread .thread>summary.strip{position:static}.strip .title{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:600;color:var(--ink)}
.thread>summary,.thread>.strip{display:flex;align-items:center;gap:var(--space-8);flex-wrap:wrap;margin:0 calc(-1 * var(--space-12));padding:var(--space-4) var(--space-12);font-size:12px;line-height:18px;background:var(--tint);border-bottom:1px solid var(--line-strong)}
.thread:not([open])>summary{border-bottom:0}
.thread>summary.strip{position:sticky;top:calc(var(--bar-height,46px) + var(--space-12) + var(--depth,0) * 32px + 36px);z-index:1;background:linear-gradient(var(--tint),var(--tint)),var(--surface-raised);cursor:pointer;list-style:none}
.thread>.unfold{display:block;width:calc(100% + 2 * var(--space-12));margin:0 calc(-1 * var(--space-12));border:0;border-radius:0;font-size:12px}.thread>summary::-webkit-details-marker{display:none}
details.thread:not([open]){padding-bottom:0}
.source{display:inline-flex;align-items:center;gap:var(--space-4);font-weight:600;color:var(--accent)}.source svg{width:14px;height:14px;fill:currentColor}
.strip .muted:last-child{margin-left:auto}
.thread textarea{margin-top:var(--space-12);min-height:64px}
.msg{display:grid;grid-template-columns:20px minmax(0,1fr);column-gap:var(--space-8);margin-top:var(--space-8);padding:var(--space-6) var(--space-8);border:1px solid color-mix(in srgb,var(--line) 40%,transparent);border-radius:var(--radius-md);background:var(--surface)}
.msg .avatar{display:grid;place-items:center;width:20px;height:20px;border-radius:50%;color:var(--ink-muted)}.msg .avatar.orb-avatar{position:relative;isolation:isolate}
.orb-avatar::before{content:'';position:absolute;inset:0;border-radius:50%;background:var(--orb-soft)}
.orb-avatar .orb{position:absolute;left:2px;top:2px;z-index:1}.msg .avatar svg{width:20px;height:20px;fill:currentColor}.msg .avatar.initials{font:600 9px/1 var(--font-ui);color:var(--ink);background:color-mix(in srgb,var(--ink) 14%,transparent)}
.msg-head{display:flex;align-items:center;gap:var(--space-6);min-height:20px}.msg-head b{font-weight:600}.msg-head .msg-meta{margin-left:auto}
.msg-meta{display:flex;align-items:center;gap:var(--space-6)}.msg-main>.msg-meta{float:right;margin-left:var(--space-12)}.when{font-size:12px;color:var(--ink-muted)}
.pill{padding:0 var(--space-6);border:1px solid var(--warning);border-radius:var(--radius-pill);font-size:11px;font-weight:500;color:var(--warning)}
.msg-text{overflow-wrap:anywhere}.msg-text>:first-child{margin-top:0}.msg-text>:last-child{margin-bottom:0}
.msg-text p,.msg-text ul,.msg-text ol,.msg-text pre,.msg-text blockquote{margin:var(--space-6) 0}.msg-text ul,.msg-text ol{padding-left:20px}.msg-text ul{list-style:disc}.msg-text li{padding:1px 0;border:0;font-size:inherit}
.outside{padding:var(--space-8) 10px;border-bottom:1px solid var(--line)}.outside>.muted{margin-bottom:var(--space-6);font-size:12px}
.comments{display:inline-flex;align-items:center;gap:var(--space-4);font-size:12px}.comments:empty{display:none}.comments svg{width:14px;height:14px}.head-tools{display:inline-flex;gap:var(--space-2)}.head-tools .icon-button{color:var(--ink-muted)}.head-tools .icon-button:hover{color:var(--ink)}.head-tools svg{width:16px;height:16px}
.card-thread{--accent:var(--agent)}.card-thread.github{--accent:var(--github)}.card-thread .source{font-size:12px}
.main-col{grid-template-columns:minmax(0,1fr)}
.file{scroll-margin-top:calc(var(--bar-height,46px) + var(--space-12) + var(--depth,0) * 32px + 10px)}
.file-head{top:calc(var(--bar-height,46px) + var(--space-12) + var(--depth,0) * 32px)}
.thread.local,.card-thread.local,.thread-group.local{--accent:var(--ink-muted);--tint:color-mix(in srgb,var(--ink) 5%,transparent)}
.thread.analysis,.card-thread.analysis,.thread-group.analysis{--accent:var(--agent);--tint:var(--agent-soft)}
.thread.github,.card-thread.github,.thread-group.github{--accent:var(--github);--tint:var(--github-soft)}
.strip .gap{flex:1}.strip .icon-button{width:20px;height:20px;min-height:20px;margin:-2px -4px -2px 0}.strip .icon-button svg{width:14px;height:14px}.pill.state{border-color:var(--line-strong);color:var(--ink-muted)}.strip .pill{line-height:16px}
.msg .delete{min-height:20px;padding:0 var(--space-2)}.msg .delete svg{width:14px;height:14px}.msg .delete:hover{color:var(--danger);text-decoration:none}
details.thread .composer-actions button{min-height:24px;padding:0 10px;font-size:12px}
.chip.bad{color:var(--danger);background:var(--danger-soft)}.chip.orb-chip::before{display:none}.chip.orb-chip svg{width:12px;height:12px;color:var(--agent)}
.chip.intent{height:18px;padding:0 var(--space-6);gap:var(--space-4);font-size:11px;color:var(--agent);background:var(--agent-soft)}.chip.intent::before{display:none}.chip.intent svg{width:12px;height:12px}
.guide-intro{margin-top:var(--space-12)}.guide-intro p{margin:var(--space-6) 0}
.tree-node{margin-top:var(--space-12)}
.node-head{position:sticky;top:calc(var(--bar-height,46px) + var(--space-12) + var(--depth,0) * 32px);z-index:2;box-shadow:0 -12px 0 var(--surface);box-sizing:border-box;height:32px;display:flex;align-items:center;gap:var(--space-8);padding:0 10px;background:var(--surface);cursor:pointer;user-select:none}
.folder-head .name{flex:1;font-family:var(--font-code);font-size:12px;overflow-wrap:anywhere}.node-head .progress{font-size:12px}
.fold-rail{--rail:var(--line-strong);position:relative;margin-left:17px}.fold-rail:has(>.fold-line:hover){--rail:var(--focus)}
.fold-line{position:absolute;left:-5px;top:0;bottom:0;width:12px;cursor:pointer;z-index:1}
.rail-item{position:relative;display:flow-root;padding:var(--space-8) 0 0 var(--space-16);overflow:clip}.fold-rail>.rail-item>*{margin-top:0}.step-wrap>.transition:first-child{margin-top:0}.step-wrap>.file:first-child{margin-top:0}
.rail-item:not(:last-child)::after{content:'';position:absolute;left:0;top:0;bottom:0;border-left:2px solid var(--rail)}
.rail-item:has(>.tree-node)::before,.rail-item>.file::before,.rail-item>.step-wrap>.file::before{content:'';position:absolute;left:0;top:0;width:12px;height:25px;border-left:2px solid var(--rail);border-bottom:2px solid var(--rail);border-bottom-left-radius:var(--radius-lg)}
.rail-item>.file,.rail-item>.step-wrap>.file{position:relative}.rail-item>.file::before,.rail-item>.step-wrap>.file::before{left:-17px;top:auto;bottom:calc(100% - 21px);height:400px}
.fold-toggle{display:inline-flex;flex:none;width:16px;height:16px;color:var(--ink-muted)}.node-head:hover .fold-toggle{color:var(--focus)}.fold-toggle svg{width:16px;height:16px}
.step-wrap{scroll-margin-top:calc(var(--bar-height,46px) + var(--space-12) + var(--depth,0) * 32px + 10px)}
.step-title{font-family:var(--font-ui);font-size:13px;font-weight:600;margin-right:var(--space-8)}.step-path{color:var(--ink-muted)}
.guide-group{margin-top:var(--space-24)}
.guide-group .sev{display:inline-flex;align-items:center;height:20px;padding:0 var(--space-8);border-radius:var(--radius-pill);font-size:12px;font-weight:600;color:var(--sev);background:var(--sev-soft)}
.guide-group .title{flex:1;font-weight:600;overflow-wrap:anywhere}.guide-group .progress{font-size:12px;color:var(--ink-muted)}
.sev-critical{--sev:var(--danger);--sev-soft:var(--danger-soft)}.sev-significant{--sev:var(--warning);--sev-soft:color-mix(in srgb,var(--warning) 14%,transparent)}
.sev-routine{--sev:var(--ink);--sev-soft:color-mix(in srgb,var(--ink) 9%,transparent)}.sev-trivial,.sev-unclassified{--sev:var(--ink-muted);--sev-soft:color-mix(in srgb,var(--ink) 5%,transparent)}
.transition{margin:var(--space-12) 0 0 14px;font-size:12px;line-height:18px;color:var(--ink-muted)}.step-wrap>.transition+.file{margin-top:var(--space-12)}
.file-note,.step-note{padding:var(--space-8) var(--space-12);border-bottom:1px solid var(--line)}.file-note .tag{font-size:12px;font-weight:600;color:var(--agent)}
.step>.diff>.thread{max-width:none;margin:var(--space-8) 10px}
.thread-group{padding:var(--space-2) 0}.thread-group-head{display:flex;align-items:center;gap:var(--space-6);padding:var(--space-4) 0;cursor:pointer;user-select:none}
.card-thread{display:grid;grid-template-columns:minmax(0,11em) minmax(0,1fr) auto auto;align-items:baseline;column-gap:var(--space-12);padding:var(--space-2) var(--space-6) var(--space-2) var(--space-8);border-left:2px solid var(--accent);font-size:12px;cursor:pointer}.card-thread+.card-thread{border-top:0}.card-thread.nested .where{padding-left:var(--space-12)}.card-thread:hover{background:color-mix(in srgb,var(--ink) 6%,transparent)}
.card-thread .name,.card-thread .text{overflow:hidden;white-space:nowrap;text-overflow:ellipsis}.card-thread .where{display:flex;min-width:0;font-family:var(--font-code);color:var(--ink-muted)}.card-thread .state{color:var(--ink-muted)}
.card-thread code{font-family:var(--font-code);font-size:.92em}
.toolbar button.icon-button[aria-pressed=true]{color:var(--ink);background:color-mix(in srgb,var(--ink) 12%,transparent)}
.filter-box{position:relative}#file-filter{width:120px;height:24px;padding:0 var(--space-24) 0 var(--space-8);font-size:12px}#filter-clear{position:absolute;top:2px;right:2px;width:20px;height:20px;min-height:20px}#filter-clear svg{width:14px;height:14px}
.toolbar{flex-wrap:wrap;justify-content:flex-end}#files-bar .toolbar{gap:var(--space-8)}#files-bar .toolbar .divider{margin:0 var(--space-2)}.menu-anchor{position:relative;display:inline-flex}.toolbar-menu{top:calc(100% + var(--space-4));left:auto;right:0;width:max-content;min-width:180px;max-width:420px}.toolbar-menu .picker-row .text{display:flex;gap:var(--space-8);min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.toolbar-menu .picker-row .text .muted{margin-left:auto}.toolbar-menu code{font-family:var(--font-code);color:var(--ink-muted)}.base-menu .picker-row .text{display:block}.base-menu{left:0;right:auto;width:300px;max-width:none}.base-menu .picker-list{gap:var(--space-2)}.base-menu input[type=text]{position:sticky;top:0;z-index:1;flex:none;width:100%;height:26px;margin-bottom:var(--space-4);padding:0 var(--space-8);font-size:12px}.menu-foot{display:flex;justify-content:flex-end;padding-top:var(--space-4);border-top:1px solid var(--line)}
.connect-menu{left:0;right:auto;width:max-content;min-width:0;max-width:min(420px,90vw)}.connect-menu .picker-list{gap:var(--space-2)}.connect-row{width:100%;justify-content:flex-start;align-items:flex-start;gap:var(--space-8);min-height:0;padding:var(--space-4) var(--space-8) var(--space-4) var(--space-6);border:0;color:var(--ink);background:none;font:inherit;font-size:12px;font-weight:400;text-align:left}.connect-row:focus-visible{outline:1px solid var(--focus);outline-offset:-1px}.connect-row>svg{flex:none;width:14px;height:14px;margin-top:var(--space-2);color:var(--ink-muted)}.connect-text{display:flex;flex-direction:column;min-width:0}.connect-text .connect-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.connect-text .muted{margin-left:0;font-size:11px;white-space:nowrap}.connect-menu .picker-note{padding:var(--space-4) var(--space-6) 0;font-size:11px}.menu-divider{height:1px;margin:var(--space-2) 0;background:var(--line)}.connect-command{gap:var(--space-8);padding:var(--space-4) var(--space-6)}.connect-command code{font-family:var(--font-code);font-size:12px;color:var(--ink)}
.range-menu{left:0;right:auto;width:min(680px,90vw);max-width:none}.range-menu .picker-list{display:grid;grid-template-columns:16px max-content minmax(0,1fr) repeat(6,max-content);column-gap:var(--space-8)}.range-menu .range-row{display:grid;grid-column:1/-1;grid-template-columns:subgrid}.range-row:not(.commit)>.text{grid-column:2/8}.range-row:not(.commit)>.muted{grid-column:8/-1;text-align:right}.range-row .num{text-align:right;font-variant-numeric:tabular-nums}.range-row .ok.num,.range-row .bad.num{font-family:var(--font-code);font-size:11px}.range-row .when{text-align:right}.menu-hint{grid-column:1/-1}.range-row{width:100%;justify-content:flex-start;min-height:28px;padding:0 var(--space-6);border:0;color:var(--ink);background:none;font:inherit;font-size:12px;text-align:left}.range-row:focus-visible{outline:1px solid var(--focus);outline-offset:-1px}.range-row[aria-checked=true] .check{visibility:visible}.range-row .text{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.range-row .ref{display:inline-flex;align-items:center;flex:none}.range-row .when{flex:none;color:var(--ink-muted)}.range-row .muted{flex:none}.menu-hint{margin-top:var(--space-4);padding:var(--space-6) var(--space-6) var(--space-2);border-top:1px solid var(--line);font-size:11px}
.range-button{gap:var(--space-6);min-height:26px;height:26px;max-width:340px;padding:0 var(--space-4) 0 var(--space-8);border:1px solid var(--line);color:var(--ink);background:none;font-size:12px}.range-button:hover{filter:none;background:color-mix(in srgb,var(--ink) 6%,transparent)}.range-button[aria-expanded=true]{border-color:var(--line-strong);background:color-mix(in srgb,var(--ink) 6%,transparent)}.range-button>svg{color:var(--ink-muted)}.range-button .ref{display:inline-flex;align-items:center;height:18px;min-height:18px}.range-button .range-text{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.range-button.on{color:var(--brand);background:var(--brand-soft)}
.range-note{flex-wrap:nowrap;align-items:center;gap:var(--space-12);margin-top:var(--space-12);padding:var(--space-8) var(--space-12);border:1px solid var(--line);border-radius:var(--radius-md);font-size:12px;line-height:20px;background:color-mix(in srgb,var(--ink) 4%,transparent)}.range-note>svg{flex:none;width:16px;height:16px;color:var(--ink-muted)}.range-note .gap{flex:1;min-width:0}.range-title{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--ink)}.range-title{display:flex;align-items:center;gap:var(--space-6);font-weight:600}.range-title .headline{min-width:0;overflow:hidden;text-overflow:ellipsis}.range-title .ok,.range-title .bad,.range-title .wait{flex:none;font-weight:400}.range-title .ref{flex:none;font-weight:400}.range-facts b{color:var(--ink);font-weight:600}.range-note>button{flex:none}
.timeline-item{display:grid;grid-template-columns:20px minmax(0,1fr);column-gap:var(--space-8);padding:var(--space-8) 0;font-size:13px;line-height:20px}.timeline-item+.timeline-item{border-top:1px solid var(--line)}.timeline-more{min-height:28px;margin-left:28px}.timeline-more+.timeline-item{border-top:1px dashed var(--line)}
.section-fold{gap:var(--space-6);min-height:22px;margin:0 0 var(--space-8) calc(-1 * var(--space-4));padding:0 var(--space-4);border:0;color:var(--ink);background:none}.section-fold:hover{filter:none}.section-fold h3{margin:0}.section-fold svg{color:var(--ink-muted);transition:transform .15s}.section-fold .count{font-size:12px;color:var(--ink-muted)}.section-fold .count::before{content:'· '}.section-fold .count:empty{display:none}#conversation.folded .section-fold{margin-bottom:0}#conversation.folded .section-fold svg{transform:rotate(-90deg)}#conversation.folded #timeline,#conversation.folded #conversation-form{display:none}
.timeline-item .avatar{display:grid;place-items:center;width:20px;height:20px;border-radius:50%;color:var(--ink-muted)}.timeline-item .avatar svg{width:16px;height:16px;fill:currentColor}.timeline-item .avatar.initials{font:600 9px/1 var(--font-ui);color:var(--ink);background:color-mix(in srgb,var(--ink) 14%,transparent)}
.timeline-item.event,.timeline-item.commits{font-size:12px;color:var(--ink-muted)}.timeline-item.event b,.timeline-item.commits b{color:var(--ink);font-weight:600}
.commit-list{margin-top:var(--space-4)}.commit-row{display:flex;align-items:center;gap:var(--space-8);padding:var(--space-2) 0;font-size:12px}.commit-row code{font-family:var(--font-code);color:var(--ink-muted)}.commit-row .text{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--ink)}
.commit-row .ref{flex:none}.commit-lines{display:inline-flex;gap:var(--space-4);font-family:var(--font-code);font-size:11px}
.msg-tools{display:flex;align-items:center;gap:var(--space-2);margin-left:auto}.msg-tools button{min-height:20px;width:22px;padding:0;border:0;background:none;color:var(--ink-muted)}.msg-tools button:hover{color:var(--ink);filter:none}.msg-tools svg{width:14px;height:14px;fill:currentColor}
.edited{font-size:12px;color:var(--ink-muted)}.verb{color:var(--ink-muted)}
.reactions{display:flex;flex-wrap:wrap;align-items:center;gap:var(--space-4);margin-top:var(--space-6)}.reactions:empty{display:none}
.reaction{min-height:22px;height:22px;padding:0 var(--space-6);border:1px solid var(--line-strong);border-radius:var(--radius-pill);background:none;font-size:12px;gap:var(--space-4)}.reaction[aria-pressed=true]{border-color:var(--github);background:var(--github-soft)}
.reaction.add{width:26px;padding:0;color:var(--ink-muted)}.reaction.add svg{width:14px;height:14px;fill:currentColor}
.emoji-pop{display:inline-flex;gap:var(--space-2);padding:var(--space-2);border:1px solid var(--line);border-radius:var(--radius-pill);background:var(--surface-raised);box-shadow:var(--shadow-overlay)}.emoji-pop button{min-height:24px;width:28px;padding:0;border:0;background:none;font-size:14px}.emoji-pop button:hover{background:color-mix(in srgb,var(--ink) 10%,transparent)}
.hidden-note{display:flex;align-items:center;gap:var(--space-8);font-size:12px;color:var(--ink-muted)}.hidden-note button{min-height:20px;padding:0 var(--space-6);font-size:12px}
.field-tabs{display:flex;gap:var(--space-4);margin-top:var(--space-8)}.field-tabs+textarea,.field-tabs+.md-preview{margin-top:var(--space-4)}
.md-preview{min-height:64px;padding:var(--space-8);border:1px solid var(--line);border-radius:var(--radius-sm);overflow-wrap:anywhere}
.field{position:relative}.mentions{position:absolute;left:0;z-index:7;display:flex;flex-direction:column;min-width:180px;max-height:200px;overflow:auto;padding:var(--space-4);border:1px solid var(--line);border-radius:var(--radius-md);background:var(--surface-raised);box-shadow:var(--shadow-overlay)}
.mentions button{justify-content:flex-start;min-height:22px;padding:0 var(--space-8);border:0;background:none;font-size:12px}.mentions button[aria-selected=true]{background:color-mix(in srgb,var(--ink) 12%,transparent)}
#conversation-form .row{margin-top:var(--space-8)}#timeline:empty{display:none}
.merge-status:not(:empty){margin-bottom:var(--space-8)}.merge-status li{display:flex;align-items:center;gap:var(--space-8)}
#merge-form{margin-bottom:var(--space-8)}#merge-row .gap{flex:1}.merge-delete{display:inline-flex;align-items:center;gap:var(--space-4);font-size:12px;cursor:pointer}.merge-delete input{margin:0;accent-color:var(--brand)}.method-menu{left:0;right:auto}
.ask-row{justify-content:flex-end;margin-top:var(--space-6)}.ask-row .gap{flex:1 1 180px}.ask-buttons{display:flex;gap:var(--space-8);margin-left:auto}.ask-row .muted{font-size:12px}.ask-menu{width:280px}.ask-text{margin:var(--space-4) var(--space-4) var(--space-8);font-size:12px}.ask-actions{justify-content:flex-end}
.title-row:has(.title-form){flex:1;min-width:0}.title-form{display:flex;flex:1;align-items:center;gap:var(--space-8);min-width:0}.title-form input{flex:1;min-width:0;height:28px;padding:0 var(--space-8);font-size:14px}.dismiss-form{display:block}.dismiss-form textarea{width:100%;min-height:60px}#merge-form input{width:100%;height:26px;box-sizing:border-box;padding:0 var(--space-8);font-size:12px}#merge-form textarea{margin-top:var(--space-6)}
#update-row,#auto-row,#queue-row{margin-top:var(--space-8)}#update-row .gap,#auto-row .gap,#queue-row .gap,.awaiting .gap,.pending-row .gap{flex:1}.pending-row{margin-bottom:var(--space-8)}.awaiting{margin-bottom:var(--space-6);font-size:12px}
.check-tools{margin-left:auto;display:inline-flex;gap:var(--space-4);align-items:center}.check-tools button{min-height:18px;padding:0 var(--space-6);font-size:11px}
.reviewer-tools{margin-left:auto;display:inline-flex;align-items:center;gap:var(--space-4);white-space:nowrap}.reviewer-tools .small{min-height:20px;padding:0 var(--space-6);font-size:11px}.reviewer-tools button{min-height:20px;width:22px;padding:0;border:0;background:none;color:var(--ink-muted)}.reviewer-tools button:hover{color:var(--ink);filter:none}.reviewer-tools svg{width:14px;height:14px;fill:currentColor}
.file-chip{padding:0 var(--space-6);border:1px solid var(--line-strong);border-radius:var(--radius-pill);font-size:11px;color:var(--ink-muted)}
tr.annotation td{padding:var(--space-4) 10px}.annotation-box{display:flex;gap:var(--space-8);padding:var(--space-6) var(--space-8);border-left:3px solid var(--level);border-radius:var(--radius-sm);background:color-mix(in srgb,var(--level) 10%,transparent);font:12px/18px var(--font-ui);white-space:pre-wrap}.annotation-box svg{flex:none;width:16px;height:16px;color:var(--level)}
.annotation-box.failure{--level:var(--danger)}.annotation-box.warning{--level:var(--warning)}.annotation-box.notice{--level:var(--github)}
.suggest-row{margin-top:var(--space-6);gap:var(--space-6)}.suggest-row button{min-height:22px;padding:0 var(--space-8);font-size:12px}

.byline .icon-button{width:20px;height:20px;min-height:20px}.byline .pr-chip{gap:var(--space-4);min-height:22px;height:22px;margin-left:var(--space-4)}.pr-chip svg{width:14px;height:14px}
#body table{display:block;width:max-content;max-width:100%;overflow-x:auto;margin:var(--space-8) 0;table-layout:auto;font:inherit}#body th,#body td{padding:var(--space-4) var(--space-8);border:1px solid var(--line);text-align:left;vertical-align:top}#body th{font-weight:600;background:var(--surface-sunken)}#body [align=right]{text-align:right}#body [align=center]{text-align:center}
#body code{font-family:var(--font-code);font-size:.92em;padding:1px var(--space-4);border-radius:var(--radius-sm);background:var(--surface-sunken)}#body pre code{padding:0;background:none}
.md-block code,.msg-text code,#body code{color:var(--code-ink)}.md-block pre code,.msg-text pre code,#body pre code{color:inherit}
.pr-state{gap:var(--space-4)}.pr-state svg{width:14px;height:14px}.pr-state.merged{color:var(--merged);background:var(--merged-soft)}.pr-state.closed{color:var(--danger);background:var(--danger-soft)}
</style></head><body${state.localMode ? ' class="local"' : ''}>
<div class="row head"><span class="title-row"><span id="number"></span><h1 id="title"></h1><button id="edit-title" class="icon-button" data-pr-action data-tip="Edit title" aria-label="Edit title" hidden>${icons.edit}</button></span><span class="toolbar"><button id="pr" class="icon-button pr-only" data-tip="Open on GitHub" aria-label="Open on GitHub">${icons.github}</button><button id="refresh" class="icon-button" data-tip="Refresh" aria-label="Refresh">${icons.refresh}</button><span class="menu-anchor pr-only"><button id="remove-worktree" class="icon-button" data-tip="Remove worktree" aria-label="Remove worktree" aria-haspopup="true" aria-expanded="false">${icons.trash}</button></span></span></div>
<div class="row byline"><span id="pr-state" class="verdict pr-state pr-only" hidden></span><span id="byline" class="row muted"></span><span id="verdict" class="verdict" hidden></span></div>
<div id="facts" class="muted facts pr-only"></div>
<div class="row status"><div class="progress" id="reviewed"></div><span id="claude"></span><button id="stop-claude" class="icon-button" data-tip="Stop. The comments it was answering wait for Retry." aria-label="Stop Claude" hidden>${icons.stop}</button><button id="terminal" class="quiet" data-tip="Continue this PR's Claude conversation in a terminal">${icons.terminal}Open in terminal</button><span class="menu-anchor" hidden><button id="connect" class="range-button" aria-haspopup="true" aria-expanded="false"></button></span><button id="retry" class="small">${icons.sync}Retry</button></div>
<p id="error" role="alert"></p>
<p id="notice" role="status"></p>
<div id="answers" class="answers" role="status" hidden></div>
<aside id="peek" hidden aria-label="Definition"><div id="peek-resize" title="Drag to resize. Double-click to reset."></div><div class="peek-head">
<button id="peek-back" title="Back" aria-label="Back">${icons.back}</button>
<button id="peek-forward" title="Forward" aria-label="Forward">${icons.forward}</button>
<span id="peek-title" class="where"></span>
<button id="peek-open" title="Open in editor">${icons.openExternal}Open in editor</button>
<button id="peek-close" title="Close" aria-label="Close">${icons.close}</button></div><div id="peek-code"></div></aside>
<div id="files-bar" class="row head"><span class="row view-head"><button id="nav-toggle" class="icon-button" aria-controls="nav-col">${icons.fileList}</button><span class="tabs" role="tablist" aria-label="Show">
<button id="view-overview" role="tab">${icons.overview}Overview</button>
<button id="view-files" role="tab">${icons.file}Files<span id="files-count" class="count"></span></button>
<button id="view-guide" class="pr-only" role="tab">${icons.agentGuide}Guide<span id="guide-count" class="count" hidden></span></button></span>
<span class="menu-anchor pr-only"><button id="range" class="range-button" aria-label="Changes from" aria-haspopup="true" aria-expanded="false">${icons.commit}<span class="range-text">All changes</span>${icons.chevronDown}</button></span>
</span><span class="toolbar">
<span id="analysis-status" class="pr-only"></span><button id="analyze" class="small pr-only">Build guide</button>
<span id="analyze-divider" class="divider pr-only"></span>
<button id="commit-batch" class="primary small pr-only" data-pr-action hidden></button>
<button id="show-unpushed" class="small pr-only" data-tip="Show the commits you would push" hidden>${icons.show}Show changes</button><button id="push" class="primary small pr-only" data-tip="Commits in this worktree that GitHub does not have yet" hidden></button>
<span class="seg icons" role="group" aria-label="Diff layout"><button id="unified" data-tip="Unified diff" aria-label="Unified diff">${icons.unified}</button><button id="split" data-tip="Side-by-side diff" aria-label="Side-by-side diff">${icons.split}</button></span>
<button id="fold-all" class="icon-button" data-tip="Collapse all files" aria-label="Collapse all files">${icons.collapseAll}</button>
<span class="menu-anchor"><button id="view-menu" class="range-button" aria-haspopup="true" aria-expanded="false"><span class="range-text">View</span>${icons.chevronDown}</button></span>
<span id="bar-review" class="row bar-review pr-only" hidden><span id="bar-pending" class="pending-chip" hidden></span><button id="finish-review" class="primary small">${icons.check}Finish review</button></span></span></div>
<div class="layout" id="panel-overview" role="tabpanel" aria-labelledby="view-overview">
<div class="main-col">
<section class="card pr-only" id="linked" hidden><div class="section-head"><h3>Linked changes</h3><button id="link-pr" class="small">${icons.link}Link a PR…</button></div><ul id="linked-rows"></ul></section>
<section class="card pr-only"><div class="section-head"><h3>Description</h3><button id="edit-body" class="icon-button" data-pr-action data-tip="Edit description" aria-label="Edit description" hidden>${icons.edit}</button></div><div id="body"></div><div id="description-reactions"></div></section>
<section class="card"><h3 id="threads-title">Threads</h3><ul id="threads"></ul></section>
<section class="card pr-only" id="conversation"><button id="fold-conversation" class="section-fold" aria-expanded="true" aria-controls="timeline">${icons.chevronDown}<h3>Conversation</h3><span id="conversation-count" class="count"></span></button><div id="timeline"></div><div id="conversation-form"></div></section>
</div>
<aside class="rail pr-only">
<section id="review-box"><h3>Finish your review</h3>
<div class="row pending-row"><span class="gap"><span id="pending-note" class="chip pending" title="Only you see them until you submit." hidden></span></span><span class="menu-anchor"><button id="discard-review" class="quiet small" data-pr-action aria-haspopup="true" aria-expanded="false" hidden>${icons.trash}Discard</button></span></div>
<textarea id="review" placeholder="Leave a summary (optional for approval)" aria-label="Review summary"></textarea>
<div class="row actions review-actions"><button data-event="comment">${icons.comment}Comment</button><button data-event="requestChanges" data-reviewer>${icons.requestChanges}Request changes</button><button class="primary" data-event="approve" data-reviewer>${icons.check}Approve</button></div></section>
<section id="merge-box"><h3 id="merge-title">Merge</h3><ul id="merge-status" class="merge-status"></ul><div class="row" id="update-row" hidden><span class="muted gap">The branch is behind the base branch.</span><span class="menu-anchor"><button id="update-branch" class="small" data-pr-action aria-haspopup="true" aria-expanded="false">${icons.sync}Update branch</button></span></div><div id="merge-form" hidden><input id="merge-headline" type="text" aria-label="Commit title"><textarea id="merge-body" aria-label="Commit message"></textarea></div>
<div class="row" id="merge-row"><span class="menu-anchor"><button id="method" class="range-button" aria-label="Merge method" aria-haspopup="true" aria-expanded="false"><span class="range-text" id="method-text"></span>${icons.chevronDown}</button></span><label class="merge-delete" id="merge-delete-label" hidden><input type="checkbox" id="merge-delete">Delete branch</label><span class="gap"></span><button id="merge-cancel" class="quiet" hidden>${icons.close}Cancel</button><button id="merge">Merge</button><button id="auto-merge" class="quiet" data-pr-action hidden>Enable auto-merge</button></div>
<div class="row" id="auto-row" hidden><span id="auto-note" class="muted gap"></span><button id="auto-merge-off" class="small" data-pr-action>${icons.close}Disable auto-merge</button></div>
<div class="row" id="queue-row" hidden><span id="queue-note" class="muted gap"></span><button id="dequeue" class="small" data-pr-action>${icons.close}Remove from queue</button></div><p id="mergeable" class="muted"></p><div class="row" id="conflict-row" hidden><span id="conflict-note"></span><button id="fix-conflicts" class="agent" title="Claude merges the base branch, resolves the conflicts and pushes.">${icons.agentFix}Fix conflicts</button></div><div id="conflict-ask" class="thread analysis" hidden><div class="strip">Claude needs your input</div><div id="conflict-reply" class="msg-text"></div><textarea id="conflict-answer" aria-label="Your answer" placeholder="Your answer, such as 4 attempts and a 200 ms first delay"></textarea><div class="row composer-actions"><span class="gap"></span><button id="conflict-cancel" class="quiet">${icons.close}Cancel</button><button id="conflict-send" class="agent">${icons.agentFix}Fix conflicts</button></div></div><div class="row state-actions" id="state-actions"></div></section>
<section><div class="section-head"><h3>Reviewers</h3><button id="pick-reviewers" class="icon-button" data-pr-action data-tip="Request reviewers" aria-label="Request reviewers" hidden>${icons.gear}</button></div><ul id="reviewers"></ul></section>
<section><div class="section-head"><h3>Assignees</h3><button id="pick-assignees" class="icon-button" data-pr-action data-tip="Edit assignees" aria-label="Edit assignees" hidden>${icons.gear}</button></div><ul id="assignees"></ul></section>
<section><div class="section-head"><h3>Labels</h3><button id="pick-labels" class="icon-button" data-pr-action data-tip="Edit labels" aria-label="Edit labels" hidden>${icons.gear}</button></div><div id="labels" class="labels"></div></section>
<section><div class="section-head"><h3>Milestone</h3><button id="pick-milestone" class="icon-button" data-pr-action data-tip="Set milestone" aria-label="Set milestone" hidden>${icons.gear}</button></div><div id="milestone"></div></section>
<section id="development" hidden><h3>Development</h3><ul id="linked-issues"></ul></section>
<section><h3>Checks</h3><div id="awaiting" class="row awaiting" hidden><span class="wait gap" id="awaiting-note"></span><span class="menu-anchor"><button id="approve-runs" class="small" data-pr-action aria-haspopup="true" aria-expanded="false">${icons.check}Approve and run</button></span></div><ul id="checks"></ul></section>

</aside>
</div>
<div id="panel-files" role="tabpanel">
<div id="range-note" class="row range-note" hidden></div>
<div class="files-layout"><div id="nav-col"><div id="nav-tools" class="nav-tools"><span id="filter-box" class="filter-box"><input id="file-filter" type="text" placeholder="Filter files" aria-label="Filter files"><button id="filter-clear" class="icon-button" aria-label="Clear filter" hidden>${icons.close}</button></span><span class="menu-anchor"><button id="filter-menu" class="icon-button" data-tip="Filter files" aria-label="Filter files" aria-haspopup="true" aria-expanded="false">${icons.filter}</button></span></div><nav id="file-nav" aria-label="Changed files"></nav><div id="nav-split" title="Drag to resize. Double-click to reset." hidden></div><section id="nav-threads" aria-label="Open comments" hidden></section><div id="nav-resize" title="Drag to resize. Double-click to reset."></div></div><div id="files"><p class="muted">Loading changes…</p></div></div>
</div>
<script id="initial" type="application/json">${JSON.stringify({ state, pdfScript }).replaceAll('<', '\\u003c')}</script>
<script nonce="${nonce}" src="${script}"></script>
</body></html>`;
}

function githubThreadView(thread: RemoteThread): GitHubThreadView {
  return {
    id: thread.id,
    location: thread.scope === 'file' ? thread.path : `${thread.path}:${thread.startLine}`,
    text: plainText(thread.comments[0]?.bodyHtml ?? '').slice(0, 140),
    status: [thread.pending ? 'Pending' : thread.resolved ? 'Resolved' : 'Open', thread.outdated ? 'Outdated' : undefined].filter(Boolean).join(' · '),
    url: thread.url,
    path: thread.path,
    side: thread.side === 'LEFT' ? 'old' : 'new',
    startLine: thread.startLine,
    endLine: thread.endLine,
    outdated: thread.outdated,
    resolved: thread.resolved,
    pending: thread.pending,
    ...(thread.scope === 'file' ? { scope: 'file' as const } : {}),
    messages: thread.comments.map(({ id, author, authorName, avatarUrl, pending, bodyHtml, body, canDelete, canEdit, canHide, canReact, hidden, edited, reactions, createdAt }) => ({
      id, author, ...authorName === undefined ? {} : { authorName }, avatarUrl, pending, html: bodyHtml, body, canDelete, canEdit, canHide, canReact,
      ...hidden === undefined ? {} : { hidden }, edited, reactions, createdAt, ...thread.scope !== 'file' && parseSuggestions(body).length === 1 ? { suggestion: true as const } : {} })),
  };
}

const htmlEntities: Readonly<Record<string, string>> = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'" };

/** One-line text of GitHub's rendered HTML, for the thread list. */
function plainText(html: string): string {
  return html.replaceAll(/<[^>]*>/gu, ' ').replaceAll(/&(?:amp|lt|gt|quot|#39);/gu, (entity) => htmlEntities[entity] ?? entity).replaceAll(/\s+/gu, ' ').trim();
}

const threadStatus: Record<ReviewThread['status'], string> = {
  queued: 'Waiting for Claude', received: 'Picked up', working: 'Claude is working', answered: 'Answered', ready: 'Ready for review',
};

/** Collect a PR's overview from its summary, file progress and review session. */
export function buildOverviewState(
  pullRequest: PullRequestSummary, opened: PullRequestSession, viewed: readonly string[], read: readonly ReadRange[], total: number | undefined,
  details?: PullRequestDetails | Error, remote?: readonly RemoteThread[] | Error, analysis: AnalysisView = { running: false, stale: false },
  conversation?: PullRequestConversation | Error,
): OverviewState {
  const { session, runner } = opened;
  const claude = claudeStatus(runner.activity);
  const intents = eventIntents(session.store.events);
  return {
    title: `#${pullRequest.number} ${pullRequest.title}`,
    number: pullRequest.number,
    heading: pullRequest.title,
    author: pullRequest.author,
    headBranch: pullRequest.headBranch,
    baseBranch: pullRequest.baseBranch,
    url: pullRequest.url,
    ...(pullRequest.createdAt === undefined ? {} : { createdAt: pullRequest.createdAt }),
    ...(pullRequest.updatedAt === undefined ? {} : { updatedAt: pullRequest.updatedAt }),
    ...(pullRequest.changes === undefined ? {} : { changes: pullRequest.changes }),
    viewed,
    read,
    ...(total === undefined ? {} : { reviewed: { done: viewed.length, total } }),
    ...(details === undefined ? {} : details instanceof Error ? { detailsError: details.message } : { details }),
    ...(remote === undefined ? {} : remote instanceof Error ? { githubError: remote.message } : { github: remote.map(githubThreadView) }),
    ...(conversation === undefined ? {} : conversation instanceof Error ? { conversationError: conversation.message } : { conversation }),
    claude: { text: claude.text, running: runner.activity.running, retry: claude.retry,
      ...(runner.activity.task === conflictFixLabel ? { fixingConflicts: runner.activity.step ?? 'Starting' } : {}),
      ...(runner.activity.progress === undefined ? {} : { progress: runner.activity.progress }) },
    analysis,
    threads: session.store.threads.map((thread) => {
      const activity = session.activity?.(thread.id);
      const publication = session.publication?.(thread.id);
      const linkedTo = session.linkedGitHubThread?.(thread.id);
      const progress = runner.activity.progress;
      return threadView(thread, {
        ...(activity === undefined ? {} : { activity }), ...(publication === undefined ? {} : { publication }),
        ...(linkedTo === undefined ? {} : { linkedTo }), ...(progress === undefined ? {} : { progress }),
        running: runner.activity.threads.has(thread.id), publishable: true, commits: opened.commits(thread.id), intents,
      });
    }),
  };
}

/** What Claude is doing on a thread, where it was published and the commits Claude made for it, when the session knows. */
interface ThreadExtras {
  readonly activity?: string;
  readonly progress?: ClaudeProgress;
  /** Whether the current Claude run answers this thread. */
  readonly running?: boolean;
  readonly publication?: Publication;
  readonly linkedTo?: string;
  /** Whether the thread can be posted on GitHub, so the page offers its text as a draft. */
  readonly publishable?: boolean;
  readonly commits?: readonly { readonly oid: string; readonly subject: string }[];
  /** Each event's intent by event ID, so a human message can show whether it was sent with Ask or Implement. */
  readonly intents?: ReadonlyMap<string, ReviewIntent>;
}

/** Each stored event's intent by event ID, for `threadView`. */
export function eventIntents(events: readonly { readonly id: string; readonly intent: ReviewIntent }[]): ReadonlyMap<string, ReviewIntent> {
  return new Map(events.map((event) => [event.id, event.intent]));
}

/** One local thread as the review page shows it, its messages rendered from Markdown. */
export function threadView(thread: ReviewThread, { activity, progress, running = false, publication, linkedTo, publishable = false, commits = [], intents }: ThreadExtras = {}): OverviewState['threads'][number] {
  const last = thread.messages.at(-1);
  const wholeFile = thread.anchor.scope === 'file';
  const onPullRequest = thread.anchor.scope === 'pullRequest';
  // Claude's reply ends the thread's live log, even while the run is still wrapping up.
  const replied = last?.author === 'claude' && Date.parse(last.createdAt) >= (progress?.startedAt ?? Infinity);
  const working = thread.resolved || replied ? undefined : activity?.startsWith('Claude · ') ? activity.slice('Claude · '.length)
    : activity === undefined && (thread.status === 'queued' || thread.status === 'received' || thread.status === 'working') ? threadStatus[thread.status] : undefined;
  const status = [
    thread.resolved ? 'Resolved' : working !== undefined ? undefined : replied ? threadStatus[thread.status] : activity ?? threadStatus[thread.status],
    publication === undefined ? undefined : publication.pending ? 'On GitHub (pending)' : 'On GitHub',
    thread.archived ? 'Archived' : undefined,
  ].filter(Boolean).join(' · ');
  return {
    id: thread.id,
    location: onPullRequest ? 'Conversation' : wholeFile ? thread.anchor.path : `${thread.anchor.path}:${thread.anchor.startLine}`,
    text: thread.messages[0]?.text.replaceAll(/\s+/gu, ' ').slice(0, 140) ?? '',
    status,
    ...(working === undefined ? {} : { working }),
    ...(working !== undefined && running && progress !== undefined ? { progress } : {}),
    path: thread.anchor.path,
    side: thread.anchor.side === 'original' ? 'old' : 'new',
    startLine: thread.anchor.startLine,
    endLine: thread.anchor.endLine,
    ...(wholeFile ? { scope: 'file' as const } : onPullRequest ? { scope: 'pullRequest' as const } : {}),
    resolved: thread.resolved,
    ...(thread.archived ? { archived: true as const } : {}),
    ...(thread.origin === undefined ? {} : { origin: thread.origin }),
    ...(!wholeFile && !onPullRequest && thread.messages.some(({ text }) => parseSuggestions(text).length) ? { original: highlightSource(thread.anchor.selectedText, thread.anchor.path) } : {}),
    messages: thread.messages.map(({ author, text, createdAt, eventId }) => {
      // A suggestion replaces the commented lines, and a whole-file comment has none.
      const suggestions = wholeFile || onPullRequest ? [] : parseSuggestions(text).map((suggestion) => highlightSource(suggestion.code, thread.anchor.path));
      const intent = author === 'human' && eventId !== undefined ? intents?.get(eventId) : undefined;
      return { author, html: markdownHtml(suggestions.length ? withoutSuggestions(text) : text), createdAt, ...(intent === undefined ? {} : { intent }), ...(suggestions.length ? { suggestions } : {}) };
    }),
    ...(publication === undefined ? {} : { url: publication.url }),
    ...(linkedTo === undefined ? {} : { linkedTo }),
    ...(publishable && publication === undefined && !thread.resolved ? { draft: publishableText(thread) } : {}),
    ...(thread.title === undefined ? {} : { title: thread.title }),
    ...(commits.length === 0 ? {} : { commits }),
  };
}
