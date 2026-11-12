import { join } from 'node:path';
import * as vscode from 'vscode';
import { readPicks, reviewView, savePicks } from '../../agents/claude/reviewRunner.js';
import type { AgentChoice } from '../../core/agent.js';
import type { ChangeRequestSummary, Forge, WorkspaceRepository } from '../../core/forge.js';
import { isWorkspaceRelativePath } from '../../core/git/git.js';
import { ensureWorktree, type PullRequestRole, removeWorktree, worktreePath } from '../../core/git/worktrees.js';
import { FileReviews } from '../../core/reviewedFiles.js';
import { parsePullRequestLink } from '../../forges/github/remotes.js';
import type { OverviewReveal } from '../../page/protocol.js';
import type { PageHost } from '../../page/pullRequest/context.js';
import { pullRequestPageController } from '../../page/pullRequest/controller.js';
import type { Checkout, Checkouts } from './checkouts.js';
import { latestAnswers, type SeenAnswers } from './claudeAnswers.js';
import { claudeFinished } from './claudeStatus.js';
import { DefinitionPeeks } from './definitions.js';
import { readFileIcons } from './fileIcons.js';
import { listRepositoryFiles, localClaudeStatus, toDisposable, wholeFile } from './localReview.js';
import type { LocalSession } from './localSessions.js';
import { openPullRequestFile, readBaseContent } from './pullRequestDiff.js';
import { checkoutDataPath } from './pullRequestSessions.js';
import { isPageOpen, revealOpenPage, showPullRequestOverview } from './reviewPanel.js';

/**
 * Show a PR's review page. `onCheckout` opens your own PR on that checkout instead of a worktree, in its local page's tab:
 * its comments stay in the checkout's review and reach the conversation you connected there, and the checkout never moves on its own.
 */
export type ShowOverview = (checkout: Checkout, provider: Forge, repository: string, pullRequest: ChangeRequestSummary, role: PullRequestRole, reveal?: OverviewReveal, onCheckout?: LocalSession) => Promise<void>;

/** Opens PR review pages, keeping what must outlive one page across reopenings. */
export function pullRequestPages(
  context: vscode.ExtensionContext, checkouts: Checkouts, seenAnswers: SeenAnswers,
  workspaceRepositories: () => Promise<ReadonlyMap<string, WorkspaceRepository>>,
): ShowOverview {
  /** Files outside the diff each open PR page shows whole, kept across calls that reveal a file on an open page. */
  const revealedFiles = new Map<string, Set<string>>();
  /** Review marks of your PRs open on checkouts, by checkout folder. */
  const checkoutFileReviews = new Map<string, FileReviews>();
  const showOverview: ShowOverview = async (checkout, provider, repository, pullRequest, role, reveal, onCheckout) => {
    const { storageRoot, sessions: pullRequestSessions } = checkout;
    if (onCheckout === undefined) await ensureWorktree(checkout.root, storageRoot, provider, repository, pullRequest, role);
    const opened = onCheckout === undefined ? await pullRequestSessions.open(repository, pullRequest.number)
      : await pullRequestSessions.openOnCheckout(repository, pullRequest, { root: onCheckout.root, store: onCheckout.store, bridge: onCheckout.bridge, dataPath: onCheckout.folder });
    const folder = onCheckout?.root ?? worktreePath(storageRoot, repository, pullRequest.number);
    let fileReviews = checkout.fileReviews;
    if (onCheckout !== undefined) {
      const known = checkoutFileReviews.get(onCheckout.root);
      fileReviews = known ?? new FileReviews(storageRoot, { folder, data: checkoutDataPath(onCheckout.folder, repository, pullRequest.number) });
      if (known === undefined) { checkoutFileReviews.set(onCheckout.root, fileReviews); context.subscriptions.push(fileReviews); }
    }
    const definitions = new DefinitionPeeks(folder);
    /** Files outside the diff opened on the page, such as from the Local view; files with open Local threads show without being opened. */
    const pageKey = `${repository}#${pullRequest.number}`;
    if (!isPageOpen(pageKey)) revealedFiles.set(pageKey, new Set());
    const revealed = revealedFiles.get(pageKey) ?? new Set<string>();
    if (reveal !== undefined && 'path' in reveal && reveal.reload === true && isWorkspaceRelativePath(reveal.path)) revealed.add(reveal.path);
    const answered = (): ReturnType<typeof latestAnswers> => latestAnswers([{ key: opened.session.key, number: pullRequest.number, threads: opened.session.store.threads }], Infinity);
    const host: PageHost = {
      fileIcons: readFileIcons,
      listRepositoryFiles,
      wholeFile,
      readBaseContent,
      newAnswers: () => new Map(answered().filter((answer) => seenAnswers.isNew(answer)).map((answer) => [answer.threadId, answer.createdAt])),
      seeAnswers: async (ids) => { await seenAnswers.see(answered().filter((answer) => ids.includes(answer.threadId))); },
      picks: () => readPicks(context.globalState, repository),
      savePicks: (picks) => savePicks(context.globalState, repository, picks),
      reviewView: (picked) => reviewView(opened.review, picked),
      refreshSidebar: () => { void vscode.commands.executeCommand('diffGuide.refreshPullRequests'); },
      markMerged: async () => { await vscode.commands.executeCommand('diffGuide.markPullRequestMerged', pageKey); },
      reveal: (at) => { revealOpenPage(pageKey, at); },
      openInEditor: (summary, path) => openPullRequestFile(storageRoot, repository, summary, path),
      removeWorktree: async () => {
        await pullRequestSessions.close(repository, pullRequest.number);
        await removeWorktree(checkout.root, storageRoot, repository, pullRequest.number);
      },
      workspaceRepositories,
      openLinkedPage: async (name, number) => {
        const other = (await workspaceRepositories()).get(name.toLowerCase());
        const target = other === undefined ? undefined : (await checkouts.list()).find((each) => each.storageRoot === other.storageRoot);
        if (target === undefined) throw new Error(`No clone of ${name} in this workspace.`);
        const otherProvider = await target.connect();
        const summary = await otherProvider.pullRequest(number);
        if (summary === undefined) throw new Error(`${name} has no PR #${number}.`);
        const mine = (await otherProvider.listMine()).some((each) => each.number === number);
        await showOverview(target, otherProvider, name, summary, mine ? 'author' : 'reviewer');
      },
      parseLink: parsePullRequestLink,
    };
    const page = pullRequestPageController({ provider, repository, pullRequest, role, folder, opened, fileReviews, revealed, onCheckout: onCheckout !== undefined, host });
    const read = onCheckout === undefined ? page.read : async (): ReturnType<typeof page.read> => ({
      ...await page.read(),
      claude: { ...localClaudeStatus(onCheckout.bridge, onCheckout.store.pendingEvents.length), link: { delivering: onCheckout.bridge.state.deliveryReady === true, terminal: onCheckout.launcher.hasTerminal } },
    });
    const changed: vscode.Event<unknown> = (listener) => vscode.Disposable.from(
      pullRequestSessions.onDidChangeState((changedSession) => {
        if (changedSession !== opened) return;
        page.sessionChanged();
        listener(changedSession);
      }),
      fileReviews.onDidChange((changed) => { if (changed === pageKey) listener(changed); }),
      page.onDidChange(listener),
      claudeFinished(opened.runner, page.refreshAfterClaude),
      ...onCheckout === undefined ? [] : [toDisposable(onCheckout.bridge.onChange(() => { listener(undefined); })), onCheckout.launcher.onDidChange(listener)],
    );
    await showPullRequestOverview(pageKey, read, changed, {
      ...page.actions,
      findDefinition: async (at, line, column) => {
        if ('peek' in at) return definitions.find(definitions.location(at.peek).uri, line, column);
        if (!page.inDiff(at.path)) throw new Error(`${at.path} is not part of this PR's changes.`);
        return definitions.find(vscode.Uri.file(join(folder, at.path)), line, column);
      },
      hasDefinition: async (at, line, column) => {
        if ('peek' in at) return definitions.has(definitions.location(at.peek).uri, line, column);
        if (!page.inDiff(at.path)) return false;
        return definitions.has(vscode.Uri.file(join(folder, at.path)), line, column);
      },
      missingLanguage: async (at) => {
        if ('peek' in at) return definitions.missingLanguage(definitions.location(at.peek).uri);
        return page.inDiff(at.path) ? definitions.missingLanguage(vscode.Uri.file(join(folder, at.path))) : undefined;
      },
      openDefinition: async (peek) => {
        const { uri, range } = definitions.location(peek);
        await vscode.window.showTextDocument(uri, { selection: range, preview: true });
      },
      ...onCheckout === undefined ? {} : {
        claudeConversations: () => onCheckout.launcher.conversations(),
        connectClaude: (choice: AgentChoice) => onCheckout.launcher.connect(choice),
      },
      openTerminal: async () => {
        if (onCheckout !== undefined) { await onCheckout.launcher.connect({ how: 'show' }); return; }
        await opened.runner.stop();
        const { command, args, cwd, env } = await opened.runner.launch();
        vscode.window.createTerminal({ name: `Claude · #${pullRequest.number}`, shellPath: command, shellArgs: [...args], cwd, env }).show();
      },
    }, context.extensionUri, reveal, undefined, onCheckout?.review.key);
  };
  return showOverview;
}
