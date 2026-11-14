import type { Event } from '../../core/events.js';
import type { OverviewActions, OverviewState } from '../protocol.js';
import { type ClaudeActions, claudeActions } from './claudeActions.js';
import type { PageParts, PullRequestPage } from './context.js';
import { DiffView } from './diffView.js';
import { type FileActions, fileActions } from './fileActions.js';
import { type GitHubActions, githubActions } from './githubActions.js';
import { LinkedCard, type LinkedActions } from './linked.js';
import { type ListedFiles, readPageState } from './pageState.js';
import { RemoteData } from './remoteData.js';
import { type SuggestionActions, suggestionActions } from './suggestionActions.js';
import { type ThreadActions, threadActions } from './threadActions.js';
import { type WorktreeActions, worktreeActions } from './worktreeActions.js';

export type PageActions = ThreadActions & GitHubActions & SuggestionActions & ClaudeActions & WorktreeActions & FileActions & LinkedActions & Pick<OverviewActions, 'refresh'>;

/** A PR's open review page: what it shows, when that changes, and what it can do. */
export interface PageController {
  read(): Promise<OverviewState>;
  /** Fires when GitHub's data or the page's own edits change. */
  readonly onDidChange: Event<void>;
  /** Tell the page its review session changed, so a newly published thread reloads GitHub's threads. */
  sessionChanged(): void;
  /** Reload from GitHub after a Claude run, which may have changed the PR, such as its title with `gh pr edit`. */
  refreshAfterClaude(): void;
  /** `path` is one of the files the Files tab last read as changed. */
  inDiff(path: string): boolean;
  readonly actions: PageActions;
}

export function pullRequestPageController(page: PullRequestPage): PageController {
  const { provider, pullRequest, opened, host } = page;
  const remote = new RemoteData(provider, pullRequest.number, () => { host.refreshSidebar(); });
  /** GitHub's file list once it has arrived; the page shows without it until then. */
  let listed: ListedFiles | undefined;
  void provider.listFiles(pullRequest.number).then((files) => files.map((file) => file.path), () => undefined)
    .then((paths) => { listed = { paths }; remote.changed(); });
  const diff = new DiffView(page, async () => (await remote.currentConversation()).lastReviewedCommit);
  const parts: PageParts = {
    page, remote, diff, edits: { applied: new Map(), undo: new Map(), conflictQuestion: undefined },
    findThread: (id) => {
      const thread = opened.session.store.threads.find((candidate) => candidate.id === id);
      if (thread === undefined) throw new Error('This thread no longer exists.');
      return thread;
    },
    notOnCheckout: (what) => { if (page.onCheckout) throw new Error(`${what} works on PR worktrees only, not on your own checkout.`); },
    pushTarget: (loaded) => loaded.headRepository === undefined ? 'origin' : `https://${new URL(pullRequest.url).host}/${loaded.headRepository}.git`,
  };
  const linked = new LinkedCard(page, diff, remote);
  const publishedThreads = (): number => opened.session.store.threads.filter((thread) => opened.session.publication?.(thread.id) !== undefined).length;
  /** Local threads posted on GitHub at the last state change; one more means GitHub has a comment the page has not read yet. */
  let published = publishedThreads();
  return {
    read: () => readPageState(parts, linked, listed),
    onDidChange: remote.onDidChange,
    sessionChanged: () => {
      const now = publishedThreads();
      if (now !== published) void remote.loadThreads();
      published = now;
    },
    refreshAfterClaude: () => {
      remote.reloadBehind();
      linked.reloadBehind();
      host.refreshSidebar();
    },
    inDiff: (path) => diff.paths.includes(path),
    actions: {
      ...fileActions(parts),
      ...threadActions(parts),
      ...githubActions(parts),
      ...suggestionActions(parts),
      ...claudeActions(parts),
      ...worktreeActions(parts),
      ...linked.actions(),
      refresh: async () => {
        linked.forget();
        const reads = await Promise.all([remote.loadDetails(), remote.loadThreads(), remote.loadConversation()]);
        return reads.find((read) => read instanceof Error)?.message;
      },
    },
  };
}
