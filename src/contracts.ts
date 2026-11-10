/** Intent attached to an individual human review comment. */
export type ReviewIntent = 'ask' | 'implement' | 'summarize';

/** Processing state; only the human can resolve a thread. */
export type ReviewStatus = 'queued' | 'received' | 'working' | 'answered' | 'ready';

/** Immutable code context captured when a comment is submitted. */
export interface CodeAnchor {
  readonly path: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly selectedText: string;
  readonly contextBefore: string;
  readonly contextAfter: string;
  readonly documentHash: string;
  readonly side: 'working' | 'original';
  readonly baseRevision: string;
  /**
   * `file` when the comment is about the whole file; its lines are then a placeholder for line 1.
   * `pullRequest` when it is about the PR as a whole, such as a conversation comment: no code, an empty path and document hash, placeholder line 1.
   */
  readonly scope?: 'file' | 'pullRequest';
}

/** A comment displayed in a native VS Code thread. */
export interface ReviewMessage {
  readonly id: string;
  readonly eventId?: string;
  readonly author: 'human' | 'claude';
  readonly text: string;
  readonly createdAt: string;
  /** Claude's proposed reply for the GitHub thread this local thread discusses, shorter than its answer to the human. */
  readonly githubReply?: string;
}

/** The review agents a code review can run. */
export type Reviewer = 'correctness' | 'design' | 'security' | 'performance';
export const reviewers: readonly Reviewer[] = ['correctness', 'design', 'security', 'performance'];

/** How a code review's finding was proven: by a test that ran, a simpler rewrite that passes the tests, a trace through the code, or a quoted rule or precedent. */
export type FindingEvidence = 'tested' | 'rewritten' | 'traced' | 'cited';
export type FindingSeverity = 'high' | 'medium' | 'low';

/** What a code review thread found, and which agents raised it. */
export interface Finding {
  readonly reviewers: readonly Reviewer[];
  readonly severity: FindingSeverity;
  readonly evidence: FindingEvidence;
}

/** Durable review thread, independent of the agent transport. */
export interface ReviewThread {
  readonly id: string;
  readonly anchor: CodeAnchor;
  readonly messages: readonly ReviewMessage[];
  readonly intent: ReviewIntent;
  readonly status: ReviewStatus;
  readonly resolved: boolean;
  readonly outdated: boolean;
  readonly latestEventId: string;
  /** Set when Claude's guide (`analysis`) or code review (`review`) opened the thread; its first message is then Claude's. */
  readonly origin?: 'analysis' | 'review';
  /** Set on threads a code review opened. */
  readonly finding?: Finding;
  /** A few words naming what the thread is about, written by Claude with its first reply. */
  readonly title?: string;
  /** The human put the thread away; it keeps its events and can be unarchived. */
  readonly archived?: true;
}

/** A single immutable work item sent to Claude at least once. */
export interface ReviewEvent {
  readonly id: string;
  readonly sequence: number;
  readonly threadId: string;
  readonly intent: ReviewIntent;
  readonly text: string;
  readonly anchor: CodeAnchor;
  readonly createdAt: string;
  readonly acknowledged: boolean;
  /** The human took the comment back to edit it before Claude answered. It keeps its ID and sequence but is no longer work, and its message left the thread. */
  readonly withdrawn?: true;
}

/** A comment the human took back, with what the page needs to put it back in a box. */
export interface WithdrawnComment {
  readonly text: string;
  readonly intent: ReviewIntent;
  readonly anchor: CodeAnchor;
  /** Claude had confirmed receiving it, so it may already have acted on it. */
  readonly received: boolean;
  /** It was the thread's only comment, so the thread is gone. */
  readonly threadRemoved: boolean;
}

/** Snapshot persisted to workspace-scoped extension storage. */
export interface ReviewSnapshot {
  readonly version: 1;
  readonly workspaceRoot: string;
  readonly threads: readonly ReviewThread[];
  readonly events: readonly ReviewEvent[];
}

/** Loopback connection descriptor, stored outside the source repository. */
export interface ConnectionDescriptor {
  readonly version: 1;
  readonly url: string;
  readonly token: string;
  readonly workspaceRoot: string;
}

/** Agent response tied to an immutable event to reject obsolete updates. */
export interface AgentUpdate {
  readonly eventId: string;
  readonly status: Exclude<ReviewStatus, 'queued'>;
  readonly text?: string;
  /** Kept only when the thread has no title yet. */
  readonly title?: string;
  /** A reply Claude proposes posting on the GitHub thread; stored with this update's message. */
  readonly githubReply?: string;
}

/** Handles used by the native editor and extension lifecycle. */
export interface Disposable {
  dispose(): void;
}

/** Storage interface shared by UI and local transport. */
export interface ReviewStore {
  readonly threads: readonly ReviewThread[];
  readonly events: readonly ReviewEvent[];
  readonly workspaceRoot: string;
  readonly pendingEvents: readonly ReviewEvent[];
  submit(anchor: CodeAnchor, text: string, intent: ReviewIntent, threadId?: string): Promise<ReviewThread>;
  updateFromAgent(update: AgentUpdate): Promise<ReviewThread>;
  resolve(threadId: string, resolved: boolean): Promise<void>;
  /** Hide a thread from the review page, or show it again, without touching its events. */
  archive(threadId: string, archived: boolean): Promise<void>;
  setOutdated(threadId: string, outdated: boolean): Promise<void>;
  /** Take back the thread's latest human comment before Claude answers it, from an explicit human action. */
  withdraw(threadId: string): Promise<WithdrawnComment>;
  /** Replace the analysis's notes that nobody replied to or resolved with new ones; resolves with the new thread ids in order. */
  replaceAnalysisNotes(notes: readonly { readonly anchor: CodeAnchor; readonly text: string }[]): Promise<readonly string[]>;
  /** Replace the code review's findings that nobody replied to or resolved with new ones; resolves with the new thread ids in order. */
  replaceReviewFindings(findings: readonly { readonly anchor: CodeAnchor; readonly text: string; readonly title: string; readonly finding: Finding }[]): Promise<readonly string[]>;
  onChange(listener: () => void): Disposable;
  flush(): Promise<void>;
}

/** Local client activity shown in VS Code, separate from acknowledgment of any review. */
export interface BridgeState {
  readonly connected: boolean;
  /** A feedback receiver was recently active; this never acknowledges a comment. */
  readonly deliveryReady?: boolean;
  readonly lastSeenAt?: number;
}

/** Loopback server lifecycle without a dependency on the VS Code module. */
/** Finds the worktree of another workspace repository that goes with this PR, for Claude to read or edit; an edit holds its lock for the current run. `repository` is `owner/name`. */
export type LinkedRepositoryHandler = (repository: string, purpose: 'read' | 'edit') => Promise<{ readonly path: string; readonly branch: string; readonly pullRequest?: number; readonly note?: string }>;

export interface ReviewBridge extends Disposable {
  readonly descriptor: ConnectionDescriptor;
  readonly state: BridgeState;
  onChange(listener: () => void): Disposable;
}
