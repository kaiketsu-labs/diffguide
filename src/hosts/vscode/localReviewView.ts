import { realpath } from 'node:fs/promises';
import { isAbsolute, relative, sep } from 'node:path';
import * as vscode from 'vscode';
import { backgroundStatus } from '../../core/agent.js';
import type { ReviewThread } from '../../core/contracts.js';
import { isWorkspaceRelativePath } from '../../core/git/git.js';
import { listLocalCheckouts, type LocalCheckout } from '../../core/git/localCheckouts.js';
import { git } from '../../core/git/worktrees.js';
import { type Checkouts, nestedRepositoryRoots } from './checkouts.js';
import { LocalFilesView } from './localFilesView.js';
import type { BranchPullRequests } from './localReview.js';
import type { LocalSession, LocalSessions } from './localSessions.js';
import type { ShowOverview } from './pullRequestPage.js';

/** The Git repository's top folder for `folder`, or undefined outside a repository. */
export async function repositoryRoot(folder: string): Promise<string | undefined> {
  const top = await git(folder, ['rev-parse', '--show-toplevel']).then((output) => output.trim(), () => undefined);
  return top === undefined ? undefined : await realpath(top).catch(() => top);
}

const localFilterKey = 'diffGuide.localFilter';

/**
 * The Local view and the checkouts' local review pages. A PR worktree's files open on that PR's page.
 * Without any checkout, when no workspace folder is or holds a Git repository, the view explains that instead.
 */
function registerLocalReview(
  state: vscode.Memento,
  sessions: LocalSessions,
  mainRoot: string,
  listCheckouts: () => Promise<readonly LocalCheckout[]>,
  openPullRequest: (checkout: LocalCheckout, path?: string) => Promise<void>,
  pullRequestThreads: (checkout: LocalCheckout) => Promise<readonly ReviewThread[]>,
  pullRequestBusy: (checkout: LocalCheckout) => Promise<string | undefined>,
  onDidChangePullRequests: vscode.Event<unknown>,
): vscode.Disposable[] {
  const report = (error: unknown): void => { void vscode.window.showErrorMessage(error instanceof Error ? error.message : String(error)); };
  const run = (action: () => Promise<void>): void => { void action().catch(report); };
  const files = new LocalFilesView(async () => {
    const checkouts = await listCheckouts();
    void vscode.commands.executeCommand('setContext', 'diffGuide.localAvailable', checkouts.length > 0);
    void vscode.commands.executeCommand('setContext', 'diffGuide.localSingle', checkouts.length === 1);
    return checkouts;
  }, async (checkout) => checkout.kind === 'pr' ? pullRequestThreads(checkout) : (await sessions.find(checkout.root))?.store.threads ?? [],
  async (checkout) => checkout.kind === 'pr' ? pullRequestBusy(checkout) : backgroundStatus(false, (await sessions.find(checkout.root))?.review.reviewing === true));
  /** A checkout the Local view lists, so command arguments cannot point anywhere else. */
  const listed = async (root: unknown): Promise<LocalCheckout> => {
    const checkout = typeof root === 'string' ? (await files.checkouts()).find((each) => each.root === root) : undefined;
    if (checkout === undefined) throw new Error('That checkout is no longer listed. Refresh the Local view.');
    return checkout;
  };
  const nodeOf = (node: unknown): { readonly root?: unknown } => {
    if (typeof node !== 'object' || node === null) return {};
    return { root: 'checkout' in node && typeof node.checkout === 'object' && node.checkout !== null && 'root' in node.checkout ? node.checkout.root : undefined };
  };
  const openCheckout = async (checkout: LocalCheckout, path?: string): Promise<void> => {
    if (checkout.kind === 'pr') { await openPullRequest(checkout, path); return; }
    const { review } = await sessions.get(checkout.root);
    await (path === undefined ? review.open() : review.openFile(path));
  };
  const tree = vscode.window.createTreeView('diffGuide.local', { treeDataProvider: files });
  /** Show only checkouts matching `filter`, remember it for this workspace, and say so above the tree. */
  const applyFilter = async (filter: string): Promise<void> => {
    files.setFilter(filter);
    tree.message = files.filter === '' ? '' : `Filter: ${files.filter}`;
    void vscode.commands.executeCommand('setContext', 'diffGuide.localFiltered', files.filter !== '');
    await state.update(localFilterKey, files.filter);
  };
  const chooseFilter = async (): Promise<void> => {
    const filter = await vscode.window.showInputBox({
      title: 'Filter checkouts', value: files.filter, placeHolder: 'Repository, branch or PR',
      prompt: 'Shows checkouts whose repository, branch, or PR number or title contains this text. Leave empty to show all.',
    });
    if (filter !== undefined) await applyFilter(filter);
  };
  void applyFilter(state.get<string>(localFilterKey, ''));
  let listing: ReturnType<typeof setTimeout> | undefined;
  const watcher = vscode.workspace.createFileSystemWatcher('**/*');
  const relist = (uri: vscode.Uri): void => {
    const parts = uri.fsPath.split(/[\\/]/u);
    const worktreeAdded = parts.at(-3) === '.git' && parts.at(-2) === 'worktrees';
    if (parts.includes('.git') && !worktreeAdded) return;
    if (listing !== undefined) clearTimeout(listing);
    listing = setTimeout(() => { listing = undefined; files.reload(); }, 500);
  };
  let counting: ReturnType<typeof setTimeout> | undefined;
  /** Count changed files again after an edit or commit, without listing the checkouts again. */
  const recount = (uri: vscode.Uri): void => {
    const parts = uri.fsPath.split(/[\\/]/u);
    if (parts.includes('.git') && parts.at(-1) !== 'index') return;
    if (counting !== undefined) clearTimeout(counting);
    counting = setTimeout(() => { counting = undefined; files.recount(); }, 500);
  };
  return [
    vscode.commands.registerCommand('diffGuide.openLocalReview', (node: unknown) => {
      run(async () => {
        const { root } = nodeOf(node);
        const checkouts = await files.checkouts();
        const checkout = root === undefined ? checkouts.find((each) => each.root === mainRoot) ?? checkouts[0] : await listed(root);
        if (checkout === undefined) throw new Error('Open a Git repository to review its local changes.');
        await openCheckout(checkout);
      });
    }),
    vscode.commands.registerCommand('diffGuide.showOnReviewPage', (uri: unknown) => {
      if (!(uri instanceof vscode.Uri) || uri.scheme !== 'file') return;
      run(async () => {
        // The innermost checkout holds the file, since worktrees can sit inside their repository's folder.
        const holding = (await files.checkouts()).filter((checkout) => !relative(checkout.root, uri.fsPath).startsWith('..') && !isAbsolute(relative(checkout.root, uri.fsPath)))
          .sort((a, b) => b.root.length - a.root.length)[0];
        const path = holding === undefined ? undefined : relative(holding.root, uri.fsPath).split(sep).join('/');
        if (holding === undefined || path === undefined || !isWorkspaceRelativePath(path)) throw new Error('This file is not in a checkout the Local view lists.');
        await openCheckout(holding, path);
      });
    }),
    vscode.commands.registerCommand('diffGuide.refreshLocalFiles', () => { files.reload(); }),
    vscode.commands.registerCommand('diffGuide.filterLocal', () => { run(chooseFilter); }),
    vscode.commands.registerCommand('diffGuide.filterLocalActive', () => { run(chooseFilter); }),
    files, watcher, watcher.onDidCreate(relist), watcher.onDidDelete(relist), watcher.onDidChange(recount),
    { dispose: () => { if (listing !== undefined) clearTimeout(listing); if (counting !== undefined) clearTimeout(counting); } },
    sessions.onDidChange(() => { files.redraw(); }),
    onDidChangePullRequests(() => { files.redraw(); }),
    tree,
  ];
}

/** Your open PR from a checkout's branch, and opening it in the checkout's local page tab. */
export function branchPullRequests(checkouts: Checkouts, showOverview: ShowOverview): (session: LocalSession) => BranchPullRequests {
  return (session) => ({
    find: async (branch) => {
      if (!/^[\w./-]+$/u.test(branch)) return undefined;
      const repository = await checkouts.forFolder(session.root);
      if (repository === undefined) return undefined;
      const found = await (await repository.connect()).search(`is:open author:@me head:${branch}`);
      return found.find((pullRequest) => pullRequest.headBranch === branch);
    },
    open: async (pullRequest) => {
      const repository = await checkouts.forFolder(session.root);
      if (repository === undefined) throw new Error('This folder is not a GitHub repository.');
      const provider = await repository.connect();
      await showOverview(repository, provider, (await provider.readRepository()).name, pullRequest, 'author', undefined, session);
    },
  });
}

/** The Local view over every checkout of the workspace: its repositories, their worktrees, and PR worktrees opening on their PR's page. */
export function registerLocalReviewView(state: vscode.Memento, checkouts: Checkouts, localSessions: LocalSessions, mainRoot: string, showOverview: ShowOverview): vscode.Disposable[] {
  const openPullRequestCheckout = async (local: LocalCheckout, path?: string): Promise<void> => {
    const metadata = local.pullRequest;
    if (metadata === undefined) throw new Error(`${local.root} holds no pull request.`);
    const located = await checkouts.locate(metadata.repository, metadata.pullRequest.number);
    if (located === undefined) throw new Error(`#${metadata.pullRequest.number} is no longer checked out.`);
    await showOverview(located, await located.connect(), metadata.repository, metadata.pullRequest, metadata.role, path === undefined ? undefined : { path, reload: true });
  };
  const pullRequestThreads = async (local: LocalCheckout): Promise<readonly ReviewThread[]> => {
    const metadata = local.pullRequest;
    if (metadata === undefined) return [];
    const located = await checkouts.locate(metadata.repository, metadata.pullRequest.number).catch(() => undefined);
    return located?.sessions.get(metadata.repository, metadata.pullRequest.number)?.session.store.threads ?? [];
  };
  const pullRequestBusy = async (local: LocalCheckout): Promise<string | undefined> => {
    const metadata = local.pullRequest;
    if (metadata === undefined) return undefined;
    const located = await checkouts.locate(metadata.repository, metadata.pullRequest.number).catch(() => undefined);
    const opened = located?.sessions.get(metadata.repository, metadata.pullRequest.number);
    if (opened === undefined) return undefined;
    return backgroundStatus(opened.analysis.activity.running, opened.review.activity.running) ?? (opened.runner.activity.running ? 'Claude working' : undefined);
  };
  const repositories = async (): Promise<readonly string[]> => {
    const folders = (vscode.workspace.workspaceFolders ?? []).filter((each) => each.uri.scheme === 'file').map((each) => each.uri.fsPath);
    const tops = await Promise.all(folders.map(async (folder) => await repositoryRoot(folder) === await realpath(folder).catch(() => folder) ? [folder] : []));
    const nested = await Promise.all(folders.map((folder) => nestedRepositoryRoots(folder)));
    return [...tops.flat(), ...nested.flat()];
  };
  return registerLocalReview(state, localSessions, mainRoot, async () => listLocalCheckouts(await repositories()), openPullRequestCheckout, pullRequestThreads, pullRequestBusy, checkouts.onDidChangeState);
}
