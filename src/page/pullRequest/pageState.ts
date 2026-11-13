import { prepareHighlighting } from '../../core/codePreview.js';
import { localChanges, unpushedCommits } from '../../core/conflicts.js';
import { git } from '../../core/git/worktrees.js';
import { buildOverviewState } from '../overviewState.js';
import { githubCodeFilePaths, githubCodeHtml } from '../preview/githubCode.js';
import { fenceFilePaths, markdownHtml } from '../preview/markdown.js';
import type { AnalysisView, OverviewState } from '../protocol.js';
import type { PageParts } from './context.js';
import type { LinkedCard } from './linked.js';

async function readAnalysis({ page: { opened, folder }, diff }: PageParts): Promise<AnalysisView> {
  const result = await opened.analysis.result();
  const { running, step, progress, error } = opened.analysis.activity;
  const stale = result !== undefined && result.head !== await diff.readHead().catch(() => result.head);
  const behind = stale ? await git(folder, ['rev-list', '--count', `${result.head}..HEAD`]).then((count) => Number(count.trim()), () => undefined) : undefined;
  return {
    running, stale, ...(behind === undefined ? {} : { behind }), ...(step === undefined ? {} : { step }), ...(progress === undefined ? {} : { progress }),
    ...(error === undefined ? {} : { error }), ...(result === undefined ? {} : { result }),
  };
}

/** Everything the PR's page shows, read from GitHub, the worktree and the review session. `listed` is the PR's file list on GitHub. */
export async function readPageState(parts: PageParts, linked: LinkedCard, listed: Promise<readonly string[] | undefined>): Promise<OverviewState> {
  const { page, remote, diff, edits } = parts;
  const { provider, repository, pullRequest, folder, opened, fileReviews, host } = page;
  remote.loadFirst();
  void remote.conversation();
  const linkedRows = linked.read();
  const paths = await listed;
  const all = [...new Set([...(paths ?? []), ...diff.paths])];
  const [viewed, read] = await Promise.all([
    fileReviews.reviewed(provider, repository, pullRequest.number, all),
    diff.readBase().then((base) => fileReviews.readRanges(repository, pullRequest.number, base)).catch(() => []),
  ]);
  const [readDetails, readThreads, analysis, loadedConversation, review] = await Promise.all([remote.details(), remote.threads(), readAnalysis(parts), remote.shownConversation(), host.reviewView(host.picks())]);
  const { written } = remote;
  const loadedDetails = readDetails instanceof Error ? readDetails : {
    ...readDetails, title: written.apply('title', readDetails.title), draft: written.apply('draft', readDetails.draft), open: written.apply('open', readDetails.open),
  };
  const loadedThreads = readThreads instanceof Error ? readThreads : readThreads.map((thread) => ({ ...thread, resolved: written.apply(`resolved:${thread.id}`, thread.resolved) }));
  const githubHtml = [
    ...readDetails instanceof Error ? [] : [readDetails.bodyHtml],
    ...readThreads instanceof Error ? [] : readThreads.flatMap((thread) => thread.comments.map((comment) => comment.bodyHtml)),
    ...loadedConversation === undefined || loadedConversation instanceof Error ? [] : loadedConversation.timeline.flatMap((item) => 'bodyHtml' in item ? [item.bodyHtml] : []),
  ];
  await prepareHighlighting([
    ...opened.session.store.threads.flatMap((thread) => [thread.anchor.path, ...thread.messages.flatMap((entry) => fenceFilePaths(entry.text))]),
    ...readThreads instanceof Error ? [] : readThreads.map((thread) => thread.path),
    ...githubHtml.flatMap(githubCodeFilePaths),
  ]);
  const highlightedThreads = loadedThreads instanceof Error ? loadedThreads
    : loadedThreads.map((thread) => ({ ...thread, comments: thread.comments.map((comment) => ({ ...comment, bodyHtml: githubCodeHtml(comment.bodyHtml, thread.path) })) }));
  const highlightedDetails = loadedDetails instanceof Error ? loadedDetails : { ...loadedDetails, bodyHtml: githubCodeHtml(loadedDetails.bodyHtml) };
  const highlightedConversation = loadedConversation === undefined || loadedConversation instanceof Error ? loadedConversation : {
    ...loadedConversation, timeline: loadedConversation.timeline.map((item) => 'bodyHtml' in item ? { ...item, bodyHtml: githubCodeHtml(item.bodyHtml) } : item),
  };
  const summary = loadedDetails instanceof Error ? diff.current() : { ...diff.current(), title: loadedDetails.title, draft: loadedDetails.draft };
  const state = buildOverviewState(summary, opened, [...viewed], read, paths?.length, highlightedDetails, highlightedThreads, analysis, highlightedConversation, await opened.runner.context(), review);
  const answers = host.newAnswers();
  const threads = state.threads.map((thread) => {
    const done = edits.applied.get(thread.id);
    const newAnswer = answers.get(thread.id);
    return { ...thread, ...(done === undefined ? {} : { applied: done }), ...(newAnswer === undefined ? {} : { newAnswer }) };
  });
  const pushedHead = loadedConversation === undefined || loadedConversation instanceof Error ? undefined : loadedConversation.merge.headOid;
  const [unpushed, local] = await Promise.all([pushedHead === undefined ? [] : unpushedCommits(folder, pushedHead), localChanges(folder, pushedHead)]);
  const linkedNow = await linkedRows;
  const { conflictQuestion } = edits;
  return {
    ...state, threads, ...(conflictQuestion === undefined ? {} : { conflictQuestion: markdownHtml(conflictQuestion) }), ...(unpushed.length === 0 ? {} : { unpushed }),
    ...(local.files.size === 0 ? {} : { local: Object.fromEntries(local.files) }), linked: linkedNow,
  };
}
