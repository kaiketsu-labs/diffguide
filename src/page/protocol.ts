import type { AgentChoice, AgentContext, AgentConversation, AgentProgress } from '../core/agent.js';
import type { LocalChange, LocalCommit } from '../core/conflicts.js';
import type { Finding, Reviewer, ReviewIntent, WithdrawnComment } from '../core/contracts.js';
import type { ChangeRequestConversation, ChangeRequestDetails, CommentKind, HideReason, LinkedChangeRequestState, MergeMessage, MergeMethod, PickerOptions, ReactionContent, ReviewEvent } from '../core/forge.js';
import type { Analysis } from '../core/prAnalysis.js';
import type { ReviewView } from '../core/review.js';
import type { LineRange, ReadRange } from '../core/reviewedFiles.js';
import { isSessionId } from '../core/sessionBinding.js';
import type { ColorFiles, FileDiff } from '../core/unifiedDiff.js';
import type { MediaPreview } from './media.js';
import type { MarkdownBlock } from './preview/markdown.js';
import type { PickedSelection } from './pullRequestEdits.js';

/** Where the review page scrolls when it opens: a file, a step of the guided review or a thread. `reload` reads the files first, for a file the page may not show yet. */
export type OverviewReveal = { readonly path: string; readonly reload?: true } | { readonly step: string } | { readonly group: string } | { readonly thread: string };

/** A definition's code, ready for the review page's side panel. */
export interface DefinitionPeek {
  readonly id: string;
  /** Such as "src/state.ts:8". */
  readonly location: string;
  readonly startLine: number;
  /** Lines of the definition itself, counted from `startLine`. */
  readonly focus: { readonly start: number; readonly end: number };
  /** The defined name, marked in the panel; `start` and `end` are columns. */
  readonly name?: { readonly line: number; readonly start: number; readonly end: number };
  readonly lines: readonly string[];
  /** Found by matching the name to a declaration in the same file, without a language extension's answer. */
  readonly guessed?: true;
}

/** A file's icon from the user's file icon theme: a glyph of one of its fonts, or one of its images by id. */
export type FileIcon = { readonly font: string; readonly char: string; readonly color?: string } | { readonly image: string };
/** Icons for some files, with the theme's fonts and images as data URIs by id, so files sharing an icon send it once. */
export interface FileIcons { readonly fonts: Readonly<Record<string, string>>; readonly images: Readonly<Record<string, string>>; readonly byPath: Readonly<Record<string, FileIcon>> }

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
  /** The code host's file list, which gives `reviewed` and its Viewed marks, has not arrived yet. */
  readonly reviewedPending?: true;
  /** Paths of files marked reviewed. */
  readonly viewed: readonly string[];
  /** Line ranges marked read, collapsed in the diff. */
  readonly read: readonly ReadRange[];
  /** Claude's status; `fixingConflicts` is the current step while Claude fixes merge conflicts. */
  readonly claude: {
    readonly text: string; readonly running: boolean; readonly retry: boolean; readonly fixingConflicts?: string; readonly progress?: AgentProgress;
    /** How full the PR's Claude conversation is after its latest run; left out before its first run and on pages whose conversation you connect. */
    readonly context?: AgentContext;
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
    readonly progress?: AgentProgress;
    /** The suggestion option written to the worktree from this thread, while the page is open. */
    readonly applied?: AppliedSuggestion;
    /** Commits Claude made while answering this thread, oldest first; `after` is the index of the message they show under, else they show at the end. */
    readonly commits?: readonly { readonly oid: string; readonly subject: string; readonly after?: number }[];
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
    /** Set when the thread holds a note from Claude's guide (`analysis`) or a code review finding (`review`). */
    readonly origin?: 'analysis' | 'review';
    /** The code review agents, severity and evidence of a finding. */
    readonly finding?: Finding;
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
  readonly details?: ChangeRequestDetails;
  readonly detailsError?: string;
  /** Timeline, merge box extras and check notes; undefined while loading or when GitHub refused the query. */
  readonly conversation?: ChangeRequestConversation;
  readonly conversationError?: string;
  readonly analysis: AnalysisView;
  /** Missing on pages that cannot run a code review. */
  readonly review?: ReviewView;
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
  readonly pullRequest?: LinkedChangeRequestState;
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
  readonly progress?: AgentProgress;
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
  readonly reactions: ChangeRequestConversation['description']['reactions'];
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
  /** Colors the files in `files` that lack syntax colors; set when some do. */
  readonly colored?: ColorFiles;
}
/** A GitHub suggestion picked for committing: the thread and its comment. */
/** A suggestion option written from a local thread: pushed, committed after unpushed commits, or only applied to the worktree. */
export interface AppliedSuggestion { readonly message: number; readonly option: number; readonly done: 'pushed' | 'committed' | 'applied' }
export interface PickedSuggestion { readonly thread: string; readonly comment: string }
export type FilePreview = { readonly kind: 'markdown'; readonly blocks: readonly MarkdownBlock[] } | { readonly kind: 'html'; readonly html: string; readonly marker: string; readonly scripted?: string };
export type CommentIntent = Extract<ReviewIntent, 'ask' | 'implement'>;

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
  /** Stop Claude's work on a thread's latest comment and take the comment back, so the page can put it back in a box to edit; an Implement without a note comes back empty. */
  withdraw(threadId: string): Promise<WithdrawnComment>;
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
  claudeConversations?(): Promise<readonly AgentConversation[]>;
  /** Connect Claude as the page's Claude menu chose; returns a notice for the page. */
  connectClaude?(choice: AgentChoice): Promise<string | undefined>;
  /** Open the PR's Claude conversation in a VS Code terminal. */
  openTerminal(): Promise<void>;
  /** Push the worktree's commits to the PR's branch. */
  push(): Promise<void>;
  /** The changes of one commit in the worktree, for a preview in the thread that made it. */
  readCommit(oid: string): Promise<readonly FileDiff[]>;
  retry(): void;
  /** Stop Claude's current run on this PR; resolves once it ended. */
  stopClaude(): Promise<void>;
  /** Start a new Claude conversation for this PR on its next run; on pages whose conversation you connect, absent. */
  newConversation?(): Promise<void>;
  /** Have Claude Code compact this PR's conversation. */
  compactConversation?(): Promise<void>;
  /** Claude's draft of the GitHub comment that sums up a local thread for the PR's other reviewers, following the human's `notes`. */
  draftReply?(id: string, notes: string): Promise<string>;
  /** Claude's draft of the human's next reply in a GitHub thread, following the human's `notes`. */
  draftGitHubReply?(id: string, notes: string): Promise<string>;
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
  /** Re-read the page's state; resolves with the first failed read's message, or undefined. */
  refresh(): Promise<string | undefined>;
  /** Ask GitHub whether the PR changed and move the worktree to a new head when that keeps local work; `problem` says why it stayed. */
  pollGitHub(): Promise<{ readonly reload: boolean; readonly files: boolean; readonly problem?: string; readonly stale?: boolean }>;
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
  /** Run a code review with these reviewers, and remember them for the next run. */
  review(reviewers: readonly Reviewer[]): Promise<void>;
  stopReview(): void;
  /** Remember the reviewers for the next run without starting one. */
  pickReviewers(reviewers: readonly Reviewer[]): Promise<void>;
}

export type PickTarget = 'reviewers' | 'assignees' | 'labels' | 'milestone';
export const pickTargets: readonly unknown[] = ['reviewers', 'assignees', 'labels', 'milestone'] satisfies PickTarget[];

export type DefinitionTarget = { readonly path: string } | { readonly peek: string };
type PageRange = { readonly path: string; readonly side: DiffSide; readonly startLine: number; readonly endLine: number };

/** What the page sends. The extension still validates each message, since the page renders untrusted HTML. */
export type PageMessage =
  | { readonly action: 'ready' | 'terminal' | 'push' | 'retry' | 'stop-claude' | 'refresh' | 'pr' | 'analyze' | 'analysis-stop' | 'review-stop' | 'review-recheck' | 'remove-worktree' | 'open-pr' | 'new-conversation' | 'compact' }
  | { readonly action: 'draft-reply' | 'github-draft-reply'; readonly form: string; readonly id: string; readonly text: string }
  | { readonly action: 'publish' | 'github' | 'thread'; readonly id: string }
  | { readonly action: 'review' | 'review-pick'; readonly reviewers: readonly Reviewer[] }
  | { readonly action: 'context' | 'preview' | 'media' | 'editor' | 'open-file'; readonly path: string }
  | { readonly action: 'close-files'; readonly paths: readonly string[] }
  | { readonly action: 'theme-colors'; readonly colors: Readonly<Record<string, string>> }
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
  | { readonly action: 'withdraw'; readonly form: string; readonly id: string }
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
  | ({ readonly action: 'connect-claude' } & AgentChoice)
  | { readonly action: 'copy-connect'; readonly command: 'reload' | 'connect' }
  | ({ readonly action: 'pick'; readonly what: PickTarget } & PickedSelection)
  | { readonly action: 'draft'; readonly draft: boolean };

/** What the extension sends the page; each field is handled on its own. */
export interface ExtensionMessage {
  readonly state?: OverviewState;
  /** Claude's draft for a local thread's Publish form, or with `github` for a GitHub thread's Reply form. */
  readonly drafted?: { readonly thread: string; readonly text: string; readonly github?: true };
  readonly files?: readonly FileDiff[];
  /** Files of the last `files` with their syntax colors, which replace the uncolored ones of the same path. */
  readonly colors?: readonly FileDiff[];
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
  /** A Refresh the page asked for finished; any failure arrives as `error`. */
  readonly refreshed?: true;
  /** The shown files are out of date and stay so until the user refreshes. */
  readonly stale?: true;
  /** The page's key, which the page keeps in its saved state for restoring after a reload. */
  readonly pageKey?: string;
  readonly pickerOptions?: PickerOptions;
  readonly pickerError?: string;
  readonly branches?: readonly string[];
  readonly branchesError?: string;
  readonly conversations?: readonly AgentConversation[];
  readonly conversationsError?: string;
  /** A running Claude can now connect itself with `/diffguide:connect`. */
  readonly runningReady?: true;
  /** A comment taken back to edit: its reply box when its thread stays, else a new comment box on its lines or file. */
  readonly restored?: { readonly thread: string; readonly text: string; readonly threadRemoved: boolean; readonly path: string; readonly side: DiffSide; readonly startLine: number; readonly endLine: number; readonly scope?: 'file' };
}

export const reviewEvents: readonly ReviewEvent[] =['approve', 'requestChanges', 'comment'];
export const mergeMethods: readonly MergeMethod[] = ['squash', 'merge', 'rebase'];
export const hideReasons: readonly unknown[] = ['OUTDATED', 'RESOLVED', 'DUPLICATE', 'OFF_TOPIC', 'LOW_QUALITY', 'SPAM', 'ABUSE'] satisfies HideReason[];
export const commentIntents: readonly unknown[] = ['ask', 'implement'] satisfies CommentIntent[];
export const maximumReviewLength = 60_000;
export const isNameList = (value: unknown): value is readonly string[] => Array.isArray(value) && value.length <= 500
  && value.every((item) => typeof item === 'string' && item.length > 0 && item.length <= 200);
/** Actions that change the PR on GitHub, one at a time. */
export const pullRequestActions = new Set(['review', 'merge', 'edit-title', 'edit-body', 'pick', 'draft', 'close', 'reopen', 'delete-branch',
  'discard-review', 'update-branch', 'auto-merge', 'auto-merge-off', 'enqueue', 'dequeue', 'revert', 'restore-branch', 'approve-runs', 'change-base',
  'dismiss-review', 'rerequest', 'rerun', 'commit-suggestions']);
/** Of those, the ones that need permission to edit the PR; the others check GitHub's own per-action flags. */
export const editActions = new Set(['edit-title', 'edit-body', 'pick', 'draft', 'close', 'reopen', 'delete-branch', 'revert', 'restore-branch', 'change-base', 'rerequest', 'commit-suggestions']);
export const commentKinds: readonly unknown[] = ['issue', 'review', 'reviewComment'] satisfies CommentKind[];
export const isOid = (value: unknown): value is string => typeof value === 'string' && /^[a-f\d]{40,64}$/u.test(value);
export const isOptionalText = (value: unknown): value is string | undefined => value === undefined || (typeof value === 'string' && value.length <= maximumReviewLength);

/** A Claude menu choice the page sent; a resumed conversation must be a session ID. */
export function parseClaudeChoice(value: unknown): AgentChoice | undefined {
  const { how, session } = value as Record<string, unknown>;
  if (how === 'show' || how === 'new' || how === 'running' || how === 'copy') return { how };
  if (how !== 'resume') return undefined;
  if (session === undefined) return { how };
  return isSessionId(session) ? { how, session } : undefined;
}

/** A range the page asked for, checked against the PR's own commits. */
export function parseRange(value: unknown, commits: readonly string[]): DiffRange | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const { kind, from, to } = value as Record<string, unknown>;
  if (kind === 'all' || kind === 'since') return { kind };
  return kind === 'commits' && isOid(from) && isOid(to) && commits.includes(from) && commits.includes(to) ? { kind, from, to } : undefined;
}

export const isLine = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 1;
export const isText = (value: unknown): value is string => typeof value === 'string' && value.trim() !== '' && value.length <= maximumReviewLength;
