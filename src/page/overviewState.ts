import type { ClaudeContext, ClaudeProgress } from '../core/agent.js';
import { conflictFixLabel } from '../core/conflicts.js';
import type { ReviewIntent, ReviewThread } from '../core/contracts.js';
import type { PullRequestConversation, PullRequestDetails, PullRequestSummary, RemoteThread } from '../core/forge.js';
import { type Publication, publishableText } from '../core/pullRequestComments.js';
import type { ReadRange } from '../core/reviewedFiles.js';
import { parseSuggestions, withoutSuggestions } from '../core/suggestions.js';
import { highlightSource } from '../core/unifiedDiff.js';
import { claudeStatus } from '../hosts/vscode/claudeStatus.js';
import type { PullRequestSession } from '../hosts/vscode/pullRequestSessions.js';
import { markdownHtml } from './preview/markdown.js';
import type { AnalysisView, GitHubThreadView, OverviewState, ReviewView } from './protocol.js';

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
  conversation?: PullRequestConversation | Error, claudeContext?: ClaudeContext, review?: ReviewView,
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
      ...(runner.activity.progress === undefined ? {} : { progress: runner.activity.progress }),
      ...(claudeContext === undefined ? {} : { context: claudeContext }) },
    analysis,
    ...(review === undefined ? {} : { review }),
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
  readonly commits?: readonly { readonly oid: string; readonly subject: string; readonly eventId?: string }[];
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
    ...(thread.finding === undefined ? {} : { finding: thread.finding }),
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
    ...(commits.length === 0 ? {} : { commits: commits.map(({ oid, subject, eventId }) => {
      // The comment's reply follows the comment, so the last message of its event is the reply once Claude answered.
      const after = eventId === undefined ? -1 : thread.messages.findLastIndex((entry) => entry.eventId === eventId);
      return { oid, subject, ...after === -1 ? {} : { after } };
    }) }),
  };
}
