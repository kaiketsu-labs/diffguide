import type { AgentCodeReview, AgentGuideAnalysis, AgentRunner } from '../../core/agent.js';
import type { ReviewThread, Reviewer } from '../../core/contracts.js';
import type { ChangeRequestDetails, ChangeRequestLink, ChangeRequestSummary, Forge, WorkspaceRepository } from '../../core/forge.js';
import type { PullRequestRole } from '../../core/git/worktrees.js';
import type { GitHubLink } from '../../core/pullRequestComments.js';
import type { FileReviews } from '../../core/reviewedFiles.js';
import type { ReviewView } from '../../core/review.js';
import type { FileDiff } from '../../core/unifiedDiff.js';
import type { OpenedReview } from '../overviewState.js';
import type { AppliedSuggestion, FileIcons, OverviewReveal } from '../protocol.js';
import type { DiffView } from './diffView.js';
import type { RemoteData } from './remoteData.js';

/** The PR's open review session, as its page uses it. */
export interface PageSession extends OpenedReview {
  readonly session: OpenedReview['session'] & {
    readonly key: string;
    publish?(threadId: string): Promise<void>;
    postToGitHub?(threadId: string, body: string, pending: boolean): Promise<void>;
    linkToGitHub?(threadId: string, link: GitHubLink): Promise<void>;
  };
  readonly runner: AgentRunner;
  readonly analysis: AgentGuideAnalysis;
  readonly review: AgentCodeReview;
  /** Where the PR keeps manual links, unlinks and the repositories Claude worked in. */
  readonly dataPath: string;
  /** Diff against a new base branch from now on, after the PR was retargeted. */
  useBase(baseBranch: string): Promise<void>;
}

/** What a PR's review page needs from the host that shows it. */
export interface PageHost {
  fileIcons(paths: readonly string[]): Promise<FileIcons | undefined>;
  listRepositoryFiles(folder: string): Promise<readonly string[]>;
  wholeFile(folder: string, path: string, change: 'unchanged'): Promise<FileDiff | undefined>;
  /** `path` at the base `revision`; the host may cache it. */
  readBaseContent(folder: string, path: string, revision: string): Promise<string>;
  /** Claude's answers on this PR the user has not seen yet: when each was written, by thread. */
  newAnswers(): ReadonlyMap<string, string>;
  seeAnswers(threadIds: readonly string[]): Promise<void>;
  /** The code reviewers last picked for this repository. */
  picks(): readonly Reviewer[];
  savePicks(picks: readonly Reviewer[]): Promise<void>;
  reviewView(picked: readonly Reviewer[]): Promise<ReviewView>;
  /** Reload the PR list, after a change it shows. */
  refreshSidebar(): void;
  markMerged(): Promise<void>;
  /** Show a thread or file on the open page. */
  reveal(at: OverviewReveal): void;
  openInEditor(pullRequest: ChangeRequestSummary, path: string): Promise<void>;
  removeWorktree(): Promise<void>;
  workspaceRepositories(): Promise<ReadonlyMap<string, WorkspaceRepository>>;
  /** Open another workspace repository's PR on its own page. */
  openLinkedPage(repository: string, number: number): Promise<void>;
  parseLink(link: string): ChangeRequestLink | undefined;
}

/** One PR's review page: the PR, where it is checked out, and its review session. */
export interface PullRequestPage {
  readonly provider: Forge;
  readonly repository: string;
  readonly pullRequest: ChangeRequestSummary;
  readonly role: PullRequestRole;
  /** The PR's worktree, or your own checkout. */
  readonly folder: string;
  readonly opened: PageSession;
  readonly fileReviews: FileReviews;
  /** Files outside the diff opened on the page, kept while the page stays open. */
  readonly revealed: Set<string>;
  /** Set when the PR is open on your own checkout, which the page must never move or remove. */
  readonly onCheckout: boolean;
  readonly host: PageHost;
}

/** What the page changed in the worktree while it stays open. */
export interface PageEdits {
  /** Suggestion options written to the worktree, by thread. */
  readonly applied: Map<string, AppliedSuggestion>;
  /** File contents around each suggestion applied without committing, so Discard can put the file back. */
  readonly undo: Map<string, { readonly path: string; readonly before: string; readonly after: string }>;
  /** What Claude asked when it last stopped fixing conflicts without pushing. */
  conflictQuestion: string | undefined;
}

/** The parts of an open PR page that its action groups share. */
export interface PageParts {
  readonly page: PullRequestPage;
  readonly remote: RemoteData;
  readonly diff: DiffView;
  readonly edits: PageEdits;
  findThread(id: string): ReviewThread;
  /** Refuses what would move or remove your own checkout. */
  notOnCheckout(what: string): void;
  /** Where to push the PR's branch: `origin`, or the fork's URL when the branch lives in a fork. */
  pushTarget(loaded: ChangeRequestDetails): string;
}
