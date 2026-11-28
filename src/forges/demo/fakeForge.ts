import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { anchorFromText } from '../../core/anchors.js';
import type { ChangeRequestComment, ChangeRequestDetails, ChangeRequestEdit, ChangeRequestSummary, ConversationComment, Forge, RemoteThread, ReviewEvent, TimelineItem } from '../../core/forge.js';
import { git, readPullRequestBase, reviewDataPath } from '../../core/git/worktrees.js';
import { type Analysis, changeBlocks } from '../../core/prAnalysis.js';
import { createReviewStore } from '../../core/store.js';
import { readPullRequestDiffPlainFirst } from '../../core/unifiedDiff.js';
import { writePrivateJson } from '../../core/privateFiles.js';
import { demoFixture, demoNumber, demoRepository, viewerLogin } from './fixture.js';
import { demoBase, demoBranch } from './sampleRepo.js';

const fixture = demoFixture;
const unavailable = (): Promise<never> => Promise.reject(new Error('The demo pull request does not support this action.'));
const html = (text: string): string => `<p>${text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')}</p>`;
const reviewState: Readonly<Record<ReviewEvent, 'approved' | 'changes' | 'commented'>> = { approve: 'approved', requestChanges: 'changes', comment: 'commented' };

/** A fake code host that serves the demo pull request and keeps every write in memory, so a fresh window starts from the seed again. */
export function createDemoForge(): Forge {
  let details: ChangeRequestDetails = fixture.details;
  let threads: readonly RemoteThread[] = fixture.threads;
  let timeline: readonly TimelineItem[] = fixture.conversation.timeline;
  let viewed: ReadonlySet<string> = new Set();
  let serial = 0;
  const nextId = (kind: string): string => `${kind}-new-${++serial}`;
  const now = (): string => new Date().toISOString();
  const mine = (id: string, body: string): ConversationComment => ({
    id, author: viewerLogin, avatarUrl: '', createdAt: now(), bodyHtml: html(body), body, canEdit: true, canDelete: true, canHide: false, canReact: true, edited: false, reactions: [],
  });
  const pendingCount = (): number => threads.reduce((sum, thread) => sum + thread.comments.filter((each) => each.pending).length, 0);
  const withPending = (): ChangeRequestDetails => {
    const { pendingComments: _unused, ...rest } = details;
    const count = pendingCount();
    return count === 0 ? rest : { ...rest, pendingComments: count };
  };
  // The sample rows other than the demo PR belong to someone else: the viewer reviews them and cannot edit them.
  const detailsFor = (number: number): ChangeRequestDetails => number === demoNumber ? withPending() : { ...withPending(), title: [...fixture.reviewRequested, ...fixture.mine].find((each) => each.number === number)?.title ?? details.title, canEdit: false, viewerIsAuthor: false };
  const changeThread = (id: string, change: (thread: RemoteThread) => RemoteThread): void => {
    if (!threads.some((thread) => thread.id === id)) throw new Error('That thread no longer exists.');
    threads = threads.map((thread) => thread.id === id ? change(thread) : thread);
  };
  const editSummary = (summary: ChangeRequestSummary): ChangeRequestSummary => summary.number === demoNumber ? { ...summary, title: details.title, draft: details.draft } : summary;
  const setTimelineComment = (id: string, change: (item: ConversationComment) => ConversationComment): void => {
    timeline = timeline.map((item) => (item.kind === 'comment' || item.kind === 'review') && item.id === id ? { ...item, ...change(item) } : item);
  };

  const forge: Forge = {
    readRepository: async () => demoRepository,
    listMine: async () => fixture.mine.map(editSummary),
    listReviewRequested: async () => fixture.reviewRequested,
    listFiles: async () => fixture.files,
    // Every sample row opens the demo branch: only the first one has data of its own.
    async checkout(number, worktree) {
      await git(worktree, ['checkout', '--quiet', '--detach', `origin/${demoBranch}`]);
      if (number === demoNumber) await seedReview(worktree);
    },
    viewedFiles: async () => viewed,
    setViewed: async (_number, path, on) => { const next = new Set(viewed); if (on) next.add(path); else next.delete(path); viewed = next; },
    async publishComment(_number, comment: ChangeRequestComment, pending) {
      const id = nextId('thread');
      const start = comment.lines?.start ?? 1;
      const end = comment.lines?.end ?? 1;
      threads = [...threads, {
        id, path: comment.path, side: comment.side, startLine: start, endLine: end, outdated: false, resolved: false, pending, url: `${demoRepository.url}/pull/${demoNumber}#discussion_${id}`,
        comments: [{ ...mine(nextId('comment'), comment.body), pending }], ...comment.lines === undefined ? { scope: 'file' as const } : {},
      }];
      return `${demoRepository.url}/pull/${demoNumber}#discussion_${id}`;
    },
    details: async (number) => detailsFor(number),
    threads: async () => threads,
    overview: async (number) => ({ details: detailsFor(number), threads }),
    async replyToThread(threadId, body) {
      changeThread(threadId, (thread) => ({ ...thread, comments: [...thread.comments, { ...mine(nextId('comment'), body), pending: false }] }));
    },
    async resolveThread(threadId, resolved) { changeThread(threadId, (thread) => ({ ...thread, resolved })); },
    async deleteComment(commentId) {
      threads = threads.flatMap((thread) => {
        const comments = thread.comments.filter((each) => each.id !== commentId);
        return comments.length === 0 ? [] : [{ ...thread, comments }];
      });
    },
    async submitReview(_number, event, body) {
      const state = reviewState[event];
      const own = threads.flatMap((thread) => thread.comments.filter((each) => each.pending).map((each) => each.id));
      threads = threads.map((thread) => ({ ...thread, pending: false, comments: thread.comments.map((each) => ({ ...each, pending: false })) }));
      const id = nextId('review');
      timeline = [...timeline, { kind: 'review', ...mine(id, body), state, comments: own }];
      details = { ...details, reviewers: [...details.reviewers.filter((each) => each.name !== viewerLogin), { name: viewerLogin, state }] };
    },
    merge: unavailable,
    async editPullRequest(_number, edit: ChangeRequestEdit) {
      const milestone = edit.milestone === undefined ? details.milestone : edit.milestone === null ? undefined : fixture.milestones.find((each) => each.number === edit.milestone);
      const { milestone: _previous, ...rest } = details;
      details = {
        ...rest,
        ...edit.title === undefined ? {} : { title: edit.title },
        ...edit.body === undefined ? {} : { body: edit.body, bodyHtml: html(edit.body) },
        ...edit.state === undefined ? {} : { open: edit.state === 'open' },
        ...edit.labels === undefined ? {} : { labels: fixture.labels.filter((label) => edit.labels?.includes(label.name)) },
        ...edit.assignees === undefined ? {} : { assignees: edit.assignees },
        ...milestone === undefined ? {} : { milestone },
      };
    },
    async setDraft(_number, draft) { details = { ...details, draft }; },
    requestReviewers: unavailable,
    removeReviewers: unavailable,
    deleteBranch: unavailable,
    pickerOptions: async () => ({ users: fixture.users, teams: [{ name: 'Core', slug: 'core' }], labels: fixture.labels, milestones: fixture.milestones }),
    search: async () => [],
    openCount: async () => 0,
    openPullRequests: async () => [],
    pullRequest: async () => undefined,
    conversation: async () => ({ ...fixture.conversation, timeline }),
    async addComment(_number, body) {
      const id = nextId('comment');
      timeline = [...timeline, { kind: 'comment', ...mine(id, body) }];
      return `${demoRepository.url}/pull/${demoNumber}#issuecomment-${id}`;
    },
    async editComment(_kind, id, body) { setTimelineComment(id, (item) => ({ ...item, body, bodyHtml: html(body), edited: true })); },
    async deleteIssueComment(id) { timeline = timeline.filter((item) => !('id' in item && item.kind === 'comment' && item.id === id)); },
    async hideComment() { /* hiding has no visible effect in the demo */ },
    async react() { /* reactions are not kept */ },
    async discardPendingReview() {
      threads = threads.flatMap((thread) => {
        const comments = thread.comments.filter((each) => !each.pending);
        return comments.length === 0 ? [] : [{ ...thread, comments }];
      });
    },
    dismissReview: unavailable, updateBranch: unavailable, enableAutoMerge: unavailable, disableAutoMerge: unavailable, enqueue: unavailable, dequeue: unavailable,
    revert: unavailable, restoreBranch: unavailable, rerunFailedJobs: unavailable, approveWorkflowRun: unavailable, changeBase: unavailable,
    branches: async () => [demoBase],
    renderMarkdown: async (text) => html(text),
    version: unavailable,
    listVersion: unavailable,
    crossReferences: async () => [],
    linkedState: async () => undefined,
    pullRequestForBranch: async () => undefined,
    createDraft: unavailable,
  };
  return forge;
}

/** Write Claude's guide and the Local threads into the review data folder of the demo PR's worktree, as if Claude had made them. */
async function seedReview(worktree: string): Promise<void> {
  await git(worktree, ['fetch', '--quiet', 'origin', demoBase]);
  const base = await readPullRequestBase(worktree, demoBase);
  if (base === undefined) throw new Error('The demo repository has no merge base with main.');
  const head = (await git(worktree, ['rev-parse', 'HEAD'])).trim();
  const dataPath = reviewDataPath(worktree);
  await mkdir(dataPath, { recursive: true, mode: 0o700 });

  const blocks = changeBlocks((await readPullRequestDiffPlainFirst(worktree, base)).files);
  const analysis: Analysis = {
    head, createdAt: '2025-03-05T17:00:00.000Z', overview: fixture.guide.overview, files: fixture.guide.files,
    groups: fixture.guide.chapters.map((chapter) => ({
      severity: chapter.severity, title: chapter.title,
      steps: chapter.steps.map((step) => ({
        title: step.title, note: step.note, ...step.transition === undefined ? {} : { transition: step.transition },
        blocks: blocks.filter((block) => block.path === step.path).map(({ path, signature }) => ({ path, signature })),
      })),
    })),
  };
  await writePrivateJson(join(dataPath, 'analysis.json'), analysis);

  const store = await createReviewStore(join(dataPath, 'review.json'), worktree);
  for (const local of fixture.localThreads) {
    const text = await readFile(join(worktree, local.path), 'utf8');
    const thread = await store.submit(anchorFromText(text, { path: local.path, startLine: local.startLine, endLine: local.endLine, side: 'working', baseRevision: base }), local.question, 'ask');
    await store.updateFromAgent({ eventId: thread.latestEventId, status: 'received' });
    await store.updateFromAgent({ eventId: thread.latestEventId, status: 'answered', text: local.answer.text, title: local.answer.title });
    if (local.resolved) await store.resolve(thread.id, true);
  }
  await store.flush();
}
