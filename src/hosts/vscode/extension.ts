import { mkdir, realpath, stat } from 'node:fs/promises';
import { basename, join, relative } from 'node:path';
import * as vscode from 'vscode';
import { createReviewBridge } from '../../agents/claude/bridge.js';
import type { ReviewBridge, ReviewStore } from '../../core/contracts.js';
import type { Forge, WorkspaceRepository } from '../../core/forge.js';
import { listWorktrees } from '../../core/git/worktrees.js';
import { FileReviews } from '../../core/reviewedFiles.js';
import { createReviewStore } from '../../core/store.js';
import { signInToGitHub, useGitHubHost, watchGitHubSessions } from '../../forges/github/githubApi.js';
import { GitHubApiProvider } from '../../forges/github/provider.js';
import { mockPullRequestProvider } from '../../forges/mockPullRequests.js';
import { Checkouts, nestedRepositoryRoots } from './checkouts.js';
import { registerAnswersView, SeenAnswers } from './claudeAnswers.js';
import { registerClaudeStatus, reportClaudeFailures, showClaude } from './claudeStatus.js';
import { vscodeGitHubHost } from './githubHost.js';
import { LocalReview, mainPageKey } from './localReview.js';
import { branchPullRequests, registerLocalReviewView, repositoryRoot } from './localReviewView.js';
import { LocalSessions } from './localSessions.js';
import { registerPullRequestDiffs } from './pullRequestDiff.js';
import { pullRequestPages } from './pullRequestPage.js';
import { PullRequestSessions } from './pullRequestSessions.js';
import { registerPullRequestView } from './pullRequestView.js';
import { cleanUpPullRequestWorktrees, worktreesOf } from './pullRequestWorktrees.js';
import { restoreReviewPages } from './reviewPanel.js';
import { prepareConnection, registerClaudeLauncher } from './setup.js';
import { registerEditorHighlighter } from './textMate.js';

let activeStore: ReviewStore | undefined;
let activeLocalSessions: LocalSessions | undefined;
let activeBridge: ReviewBridge | undefined;
let activePullRequests: Checkouts | undefined;

/** Initialize one workspace-scoped review and its private local connection. */
export async function activate(context: vscode.ExtensionContext): Promise<void> {
  useGitHubHost(vscodeGitHubHost);
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (folder === undefined || folder.uri.scheme !== 'file' || !vscode.workspace.isTrusted) return;
  const root = folder.uri.fsPath;
  context.subscriptions.push(...registerEditorHighlighter(context));
  const mockPullRequests = (): boolean => vscode.workspace.getConfiguration('diffGuide').get('mockPullRequests', false);
  /** Every repository of the workspace by lowercase `owner/name`; Claude reaches the others only through their DiffGuide worktrees. */
  const workspaceRepositories = async (): Promise<ReadonlyMap<string, WorkspaceRepository>> => {
    const found = new Map<string, WorkspaceRepository>();
    for (const checkout of await checkouts.list()) {
      const name = await checkout.connect().then((provider) => provider.readRepository()).then(({ name: full }) => full, () => undefined);
      if (name !== undefined && !found.has(name.toLowerCase())) found.set(name.toLowerCase(), checkout);
    }
    return found;
  };
  const checkouts = new Checkouts(root, context.globalStorageUri.fsPath, {
    discover: async () => mockPullRequests() ? [] : await nestedRepositoryRoots(root),
    create: (checkoutRoot, storageRoot) => {
      const connect = async (): Promise<Forge> => mockPullRequests() ? mockPullRequestProvider : await GitHubApiProvider.connect(checkoutRoot);
      return { root: checkoutRoot, storageRoot, connect, sessions: new PullRequestSessions(context, storageRoot, checkoutRoot, connect, {}, workspaceRepositories), fileReviews: new FileReviews(storageRoot) };
    },
    onRestoreError: (error) => {
      void vscode.window.showErrorMessage(`DiffGuide could not restore pull request reviews: ${error instanceof Error ? error.message : String(error)}`);
    },
  });
  context.subscriptions.push(checkouts, registerPullRequestDiffs(async (repository, number) => (await checkouts.locate(repository, number))?.storageRoot));
  const seenAnswers = new SeenAnswers(context.workspaceState);
  context.subscriptions.push(seenAnswers, ...registerAnswersView(checkouts, seenAnswers));
  const storage = context.storageUri;
  if (storage === undefined) return;
  try {
    await mkdir(storage.fsPath, { recursive: true, mode: 0o700 });
    const store = await createReviewStore(join(storage.fsPath, 'review.json'), folder.uri.fsPath);
    activeStore = store;
    activePullRequests = checkouts;
    const showOverview = pullRequestPages(context, checkouts, seenAnswers, workspaceRepositories);
    const cleanUp = (manual: boolean): Promise<void> => cleanUpPullRequestWorktrees(checkouts, showOverview, manual);
    if (!mockPullRequests()) void cleanUp(false).catch(() => undefined);
    context.subscriptions.push(
      registerPullRequestView(
        async () => (await checkouts.list()).map((checkout) => ({
          folder: relative(root, checkout.root) || basename(root), connect: checkout.connect, worktrees: worktreesOf(checkouts, checkout, showOverview),
        })),
        (listener) => vscode.Disposable.from(
          checkouts.onDidChangeState((changed) => { listener(changed.session.key); }),
          checkouts.onDidChangeReviewedFiles(listener),
        ),
        context.globalState,
        context.workspaceState,
      ),
      watchGitHubSessions(() => { void vscode.commands.executeCommand('diffGuide.refreshPullRequests'); }),
      vscode.commands.registerCommand('diffGuide.openAnswer', async (pullRequest: unknown, threadId: unknown) => {
        const found = checkouts.opened.find(({ session }) => session.session.key === pullRequest);
        if (found === undefined || typeof threadId !== 'string') return;
        const { checkout, session } = found;
        try {
          const provider = await checkout.connect();
          await showOverview(checkout, provider, session.metadata.repository, session.metadata.pullRequest, session.metadata.role, { thread: threadId });
        } catch (error: unknown) {
          void vscode.window.showErrorMessage(error instanceof Error ? error.message : String(error));
        }
      }),
      vscode.commands.registerCommand('diffGuide.cleanUpWorktrees', async () => {
        try {
          await cleanUp(true);
        } catch (error: unknown) {
          void vscode.window.showErrorMessage(error instanceof Error ? error.message : String(error));
        }
      }),
      vscode.commands.registerCommand('diffGuide.signInToGitHub', async (provider: unknown) => {
        try {
          await signInToGitHub(provider === 'github' || provider === 'github-enterprise' ? provider : undefined);
          await vscode.commands.executeCommand('diffGuide.refreshPullRequests');
        } catch (error: unknown) {
          void vscode.window.showErrorMessage(error instanceof Error ? error.message : String(error));
        }
      }),
      reportClaudeFailures(checkouts),
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration('diffGuide.mockPullRequests') || event.affectsConfiguration('github-enterprise.uri')) void vscode.commands.executeCommand('diffGuide.refreshPullRequests');
      }),
    );
    const bridge = await createReviewBridge(store, join(storage.fsPath, 'selected-session.json'));
    activeBridge = bridge;
    const launchers = registerClaudeLauncher(context, bridge, storage.fsPath);
    const mainRoot = await realpath(root).catch(() => root);
    const main = await repositoryRoot(root) === mainRoot
      ? { root: mainRoot, folder: storage.fsPath, store, bridge, launcher: launchers.local, review: new LocalReview(context, root, store, bridge, join(storage.fsPath, 'local-review'), launchers.local) } : undefined;
    const pullRequestsOfBranch = branchPullRequests(checkouts, showOverview);
    const localSessions = new LocalSessions(context, storage.fsPath, main, (session) => { session.review.usePullRequests(pullRequestsOfBranch(session)); });
    activeLocalSessions = localSessions;
    context.subscriptions.push(localSessions, ...registerLocalReviewView(context.workspaceState, checkouts, localSessions, mainRoot, showOverview));
    void localSessions.restore(async (folder) => stat(folder).then((info) => info.isDirectory(), () => false));
    context.subscriptions.push(restoreReviewPages(async (key) => {
      if (key === mainPageKey) return main?.review.open();
      if (key.startsWith(mainPageKey + ':')) {
        const folder = key.slice(mainPageKey.length + 1);
        if (!await stat(folder).then((info) => info.isDirectory(), () => false)) return;
        return (await localSessions.get(folder)).review.open();
      }
      // Sessions reopen in the background after a reload, so the PR is found by its worktree, not among open sessions.
      for (const checkout of await checkouts.list()) {
        const found = (await listWorktrees(checkout.storageRoot, checkout.root)).find(({ metadata }) => `${metadata.repository}#${metadata.pullRequest.number}` === key);
        if (found === undefined) continue;
        const { repository, pullRequest, role } = found.metadata;
        return showOverview(checkout, await checkout.connect(), repository, pullRequest, role);
      }
    }));
    context.subscriptions.push(bridge, launchers, vscode.commands.registerCommand('diffGuide.showFocusedClaude', () => {
      const document = vscode.window.activeTextEditor?.document;
      const focused = document === undefined ? undefined : checkouts.forUri(document.uri);
      if (focused !== undefined) showClaude(focused);
    }));
    void checkouts.list().catch((error: unknown) => {
      void vscode.window.showErrorMessage(`DiffGuide could not restore pull request reviews: ${error instanceof Error ? error.message : String(error)}`);
    });
    await prepareConnection(context, bridge, storage.fsPath);
    context.subscriptions.push(...registerClaudeStatus(checkouts));
  } catch (error: unknown) {
    activeBridge?.dispose();
    await vscode.window.showErrorMessage(`DiffGuide could not start: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** Finish persisted mutations before VS Code unloads the extension. */
export async function deactivate(): Promise<void> {
  activeBridge?.dispose();
  await activeStore?.flush();
  await activeLocalSessions?.flush();
  await activePullRequests?.flush();
  activePullRequests = undefined;
  activeBridge = undefined;
  activeStore = undefined;
  activeLocalSessions = undefined;
}
