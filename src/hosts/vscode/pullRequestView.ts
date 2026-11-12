import * as vscode from 'vscode';
import { parsePullRequestLink } from '../../forges/github/remotes.js';
import { pollWhileFocused } from './autoSync.js';
import { legendProvider, pinMime, pullRequestKey, rowDecorationProvider, type Node, type PullRequestCheckout, type PullRequestNode, type RepositoryNode } from './pullRequestItems.js';
import { PullRequestTree } from './pullRequestTree.js';

export type { PullRequestWorktrees } from './pullRequestItems.js';

/** Register the pull request sidebar and its commands. */
export function registerPullRequestView(
  checkouts: () => Promise<readonly PullRequestCheckout[]>,
  /** Fires with `owner/name#number` when that PR's Claude activity or reviewed files change, or undefined to redraw all. */
  onDidChangeStatus: vscode.Event<string | undefined>,
  settings: vscode.Memento, workspace: vscode.Memento,
): vscode.Disposable {
  const tree = new PullRequestTree(checkouts, settings, workspace,
    (text) => { view.description = text ?? ''; }, (message) => { view.message = message ?? ''; });
  const showMode = (): void => {
    void vscode.commands.executeCommand('setContext', 'diffGuide.groupByRole', tree.byRole);
    void vscode.commands.executeCommand('setContext', 'diffGuide.authorFiltered', tree.author !== undefined);
    void vscode.commands.executeCommand('setContext', 'diffGuide.awaitingReviewOnly', tree.awaitingReviewOnly);
  };
  showMode();
  const report = (error: unknown): void => {
    void vscode.window.showErrorMessage(error instanceof Error ? error.message : String(error));
  };
  const legend = vscode.window.createTreeView('diffGuide.legend', { treeDataProvider: legendProvider });
  const dragAndDropController: vscode.TreeDragAndDropController<Node> = {
    dragMimeTypes: [pinMime],
    dropMimeTypes: [pinMime],
    handleDrag: (nodes, data) => {
      const rows = nodes.filter(isPullRequestNode);
      if (rows.length > 0) data.set(pinMime, new vscode.DataTransferItem(rows));
    },
    handleDrop: async (target, data) => {
      const dragged: unknown = data.get(pinMime)?.value;
      const rows = Array.isArray(dragged) ? dragged.filter(isPullRequestNode) : [];
      if (rows.length === 0) return;
      if (target?.kind === 'pinned') await tree.pin(rows);
      else if (target?.kind === 'pullRequest' && target.pinned === true) await tree.pin(rows, target);
    },
  };
  const view = vscode.window.createTreeView('diffGuide.pullRequests', { treeDataProvider: tree, dragAndDropController });
  const sync = pollWhileFocused(60_000, () => view.visible, () => tree.pollGitHub());
  return vscode.Disposable.from(
    view,
    legend,
    vscode.window.registerFileDecorationProvider(rowDecorationProvider),
    onDidChangeStatus((pullRequest) => { tree.redraw(pullRequest); }),
    vscode.commands.registerCommand('diffGuide.refreshPullRequests', () => { tree.refresh(); }),
    sync,
    view.onDidChangeVisibility(({ visible }) => { if (visible) sync.now(); }),
    vscode.commands.registerCommand('diffGuide.searchPullRequests', async () => {
      try {
        await tree.search();
      } catch (error: unknown) {
        report(error);
      }
    }),
    vscode.commands.registerCommand('diffGuide.pinPullRequest', async (node: unknown) => {
      if (isPullRequestNode(node)) await tree.pin([node]);
    }),
    vscode.commands.registerCommand('diffGuide.unpinPullRequest', async (node: unknown) => {
      if (isPullRequestNode(node)) await tree.unpin(pullRequestKey(node));
    }),
    vscode.commands.registerCommand('diffGuide.markPullRequestMerged', (key: unknown) => {
      if (typeof key === 'string') tree.markMerged(key);
    }),
    vscode.commands.registerCommand('diffGuide.groupByRole', async () => { await tree.setByRole(true); showMode(); }),
    vscode.commands.registerCommand('diffGuide.groupByRepository', async () => { await tree.setByRole(false); showMode(); }),
    vscode.commands.registerCommand('diffGuide.chooseRepositories', async () => { await tree.chooseRepositories(); }),
    vscode.commands.registerCommand('diffGuide.filterByAuthor', async () => { await tree.chooseAuthor(); showMode(); }),
    vscode.commands.registerCommand('diffGuide.filterByAuthorActive', async () => { await tree.chooseAuthor(); showMode(); }),
    vscode.commands.registerCommand('diffGuide.showAwaitingReviewOnly', async () => { await tree.setAwaitingReviewOnly(true); showMode(); }),
    vscode.commands.registerCommand('diffGuide.showAllMine', async () => { await tree.setAwaitingReviewOnly(false); showMode(); }),
    vscode.commands.registerCommand('diffGuide.openPullRequestLink', async () => {
      const link = await vscode.window.showInputBox({
        title: 'Open PR in DiffGuide', prompt: 'GitHub PR link, or owner/repo#57', placeHolder: 'https://github.com/owner/repo/pull/57',
        validateInput: (value) => !value.trim() || parsePullRequestLink(value) !== undefined ? undefined : 'Paste a GitHub PR link, such as https://github.com/owner/repo/pull/57',
      });
      if (link === undefined || !link.trim()) return;
      try {
        await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Opening PR' }, () => tree.openLink(link));
      } catch (error: unknown) {
        report(error);
      }
    }),
    vscode.commands.registerCommand('diffGuide.copyPullRequestLink', async (node: unknown) => {
      if (isPullRequestNode(node)) await vscode.env.clipboard.writeText(node.pullRequest.url);
    }),
    vscode.commands.registerCommand('diffGuide.hideRepository', async (node: unknown) => {
      if (isRepositoryNode(node)) await tree.hide(node);
    }),
    vscode.commands.registerCommand('diffGuide.openPullRequestInBrowser', async (node: unknown) => {
      if (isPullRequestNode(node)) await vscode.env.openExternal(vscode.Uri.parse(node.pullRequest.url));
    }),
    vscode.commands.registerCommand('diffGuide.openPullRequest', async (node: unknown) => {
      if (!isPullRequestNode(node)) return;
      try {
        await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: `Opening #${node.pullRequest.number}` },
          () => node.listing.worktrees.open(node.listing.provider, node.listing.repository.name, node.pullRequest, node.role),
        );
      } catch (error: unknown) {
        report(error);
      }
      tree.redraw(pullRequestKey(node));
    }),
    vscode.commands.registerCommand('diffGuide.showPullRequestClaude', async (node: unknown) => {
      if (!isPullRequestNode(node)) return;
      try {
        await node.listing.worktrees.showClaude(node.listing.provider, node.listing.repository.name, node.pullRequest, node.role);
      } catch (error: unknown) {
        report(error);
      }
      tree.redraw(pullRequestKey(node));
    }),
    vscode.commands.registerCommand('diffGuide.showPullRequestOverview', async (node: unknown) => {
      if (!isPullRequestNode(node)) return;
      try {
        await node.listing.worktrees.showOverview(node.listing.provider, node.listing.repository.name, node.pullRequest, node.role);
      } catch (error: unknown) {
        report(error);
      }
      tree.redraw(pullRequestKey(node));
    }),
    vscode.commands.registerCommand('diffGuide.removePullRequestWorktree', async (node: unknown) => {
      if (!isPullRequestNode(node)) return;
      const confirm = 'Remove worktree';
      const answer = await vscode.window.showWarningMessage(
        `Remove the worktree for #${node.pullRequest.number}? Its local comments are deleted too. Git refuses if it has uncommitted changes.`,
        { modal: true }, confirm,
      );
      if (answer !== confirm) return;
      try {
        await node.listing.worktrees.remove(node.listing.repository.name, node.pullRequest.number);
      } catch (error: unknown) {
        report(error);
      }
      tree.redraw(pullRequestKey(node));
    }),
  );
}

function isRepositoryNode(value: unknown): value is RepositoryNode {
  return typeof value === 'object' && value !== null && (value as { kind?: unknown }).kind === 'repository'
    && typeof (value as { listing?: { folder?: unknown } }).listing?.folder === 'string';
}

/** Accept only tree nodes this view created; command arguments are otherwise untrusted. */
function isPullRequestNode(value: unknown): value is PullRequestNode {
  return typeof value === 'object' && value !== null && (value as { kind?: unknown }).kind === 'pullRequest'
    && typeof (value as { listing?: { provider?: unknown } }).listing?.provider === 'object'
    && typeof (value as { listing?: { worktrees?: unknown } }).listing?.worktrees === 'object';
}
