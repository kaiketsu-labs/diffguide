import { lstat, mkdir, readFile, stat } from 'node:fs/promises';
import { basename, join, relative } from 'node:path';
import * as vscode from 'vscode';
import { createReviewBridge } from './bridge.js';
import { createReviewStore } from './store.js';
import { createReviewController } from './reviewController.js';
import { prepareConnection, registerClaudeLauncher } from './setup.js';
import { registerPrExport } from './prExportController.js';
import { registerReviewAppearance } from './reviewAppearance.js';
import { GitHubApiProvider } from './pullRequests.js';
import { signInToGitHub, watchGitHubSessions } from './githubApi.js';
import { mockPullRequestProvider } from './mockPullRequests.js';
import { conflictTask, prepareConflictFix } from './conflicts.js';
import { registerPullRequestView, type PullRequestWorktrees } from './pullRequestView.js';
import { type PullRequestRole, ensureWorktree, git, hasWorktree, readPullRequestBase, removeWorktree, reviewDataPath, worktreePath } from './worktrees.js';
import { buildGuide, guideOutline } from './prAnalysis.js';
import { readSavedAnalysis } from './prAnalysisRunner.js';
import { highlightSource, readPlainPullRequestDiff, readPullRequestDiff, type FileDiff } from './unifiedDiff.js';
import { fenceFilePaths, inlineLocalImages, markdownBlocks, markdownHtml } from './markdown.js';
import { htmlPreview } from './htmlPreview.js';
import { DefinitionPeeks } from './definitions.js';
import { FileReviews } from './reviewedFiles.js';
import { pickAndSave } from './pullRequestEdits.js';
import { buildOverviewState, showPullRequestOverview, type AnalysisView, type OverviewReveal, type PageComment } from './pullRequestOverview.js';
import type { PullRequestDetails, PullRequestProvider, PullRequestSummary, RemoteThread } from './pullRequests.js';
import { openPullRequestFile, readBaseContent, registerPullRequestDiffs } from './pullRequestDiff.js';
import { PullRequestSessions, type PullRequestSession } from './pullRequestSessions.js';
import { Checkouts, nestedRepositoryRoots, type Checkout } from './checkouts.js';
import { claudeStatus } from './claudeStatus.js';
import { getHeadRevision, readGitBaseBytes } from './git.js';
import { maxMediaBytes, mediaType, type MediaSide } from './media.js';
import { anchorFromText } from './anchors.js';
import { prepareHighlighting, useEditorHighlighter } from './codePreview.js';
import { editorHighlighter } from './textMate.js';
import { placeComment } from './pullRequestComments.js';
import type { CodeAnchor, ReviewBridge, ReviewStore, ReviewThread } from './contracts.js';

let activeStore: ReviewStore | undefined;
let activeBridge: ReviewBridge | undefined;
let activePullRequests: Checkouts | undefined;

/** Initialize one workspace-scoped review and its private local connection. */
export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (folder === undefined || folder.uri.scheme !== 'file' || !vscode.workspace.isTrusted) return;
  const root = folder.uri.fsPath;
  let themeLoads = 0;
  const loadHighlighter = (): void => {
    const load = ++themeLoads;
    void editorHighlighter(context.asAbsolutePath(join('dist', 'onig.wasm'))).catch(() => undefined).then((highlighter) => {
      if (load === themeLoads) useEditorHighlighter(highlighter);
    });
  };
  loadHighlighter();
  context.subscriptions.push(
    vscode.window.onDidChangeActiveColorTheme(loadHighlighter),
    vscode.extensions.onDidChange(loadHighlighter),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration('editor.tokenColorCustomizations') || event.affectsConfiguration('workbench.colorTheme')) loadHighlighter();
    }),
  );
  const mockPullRequests = (): boolean => vscode.workspace.getConfiguration('pairReview').get('mockPullRequests', false);
  const checkouts = new Checkouts(root, context.globalStorageUri.fsPath, {
    discover: async () => mockPullRequests() ? [] : await nestedRepositoryRoots(root),
    create: (checkoutRoot, storageRoot) => {
      const connect = async (): Promise<PullRequestProvider> => mockPullRequests() ? mockPullRequestProvider : await GitHubApiProvider.connect(checkoutRoot);
      return { root: checkoutRoot, storageRoot, connect, sessions: new PullRequestSessions(context, storageRoot, checkoutRoot, connect), fileReviews: new FileReviews(storageRoot) };
    },
    onRestoreError: (error) => {
      void vscode.window.showErrorMessage(`Pair Review could not restore pull request reviews: ${error instanceof Error ? error.message : String(error)}`);
    },
  });
  context.subscriptions.push(checkouts, registerPullRequestDiffs(async (repository, number) => (await checkouts.locate(repository, number))?.storageRoot));
  const storage = context.storageUri;
  if (storage === undefined) return;
  try {
    await mkdir(storage.fsPath, { recursive: true, mode: 0o700 });
    const store = await createReviewStore(join(storage.fsPath, 'review.json'), folder.uri.fsPath);
    activeStore = store;
    activePullRequests = checkouts;
    const showOverview = async (checkout: Checkout, provider: PullRequestProvider, repository: string, pullRequest: PullRequestSummary, role: PullRequestRole, reveal?: OverviewReveal): Promise<void> => {
      const { storageRoot, sessions: pullRequestSessions, fileReviews } = checkout;
      await ensureWorktree(checkout.root, storageRoot, provider, repository, pullRequest, role);
      const opened = await pullRequestSessions.open(repository, pullRequest.number);
      const folder = worktreePath(storageRoot, repository, pullRequest.number);
      const listed = provider.listFiles(pullRequest.number).then((files) => files.map((file) => file.path), () => undefined);
      let diffPaths: readonly string[] = [];
      /** Changed files from the latest diff read, so media previews need no second read. */
      let diffFiles: readonly FileDiff[] = [];
      const definitions = new DefinitionPeeks(folder);
      const readBase = async (): Promise<string> => {
        const base = await readPullRequestBase(folder, pullRequest.baseBranch);
        if (base === undefined) throw new Error(`Could not find where #${pullRequest.number} branched off ${pullRequest.baseBranch}.`);
        return base;
      };
      const findThread = (id: string): ReviewThread => {
        const thread = opened.session.store.threads.find((candidate) => candidate.id === id);
        if (thread === undefined) throw new Error('This thread no longer exists.');
        return thread;
      };
      const pageAnchor = async ({ path, side, startLine, endLine }: Omit<PageComment, 'text' | 'intent'>): Promise<{ anchor: CodeAnchor; base: string }> => {
        if (!diffPaths.includes(path)) throw new Error(`${path} is not part of this PR's changes.`);
        const base = await readBase();
        const content = side === 'old' ? await readBaseContent(folder, path, base) : await readFile(join(folder, path), 'utf8');
        const anchor = anchorFromText(content, { path, startLine, endLine, side: side === 'old' ? 'original' : 'working', baseRevision: base });
        return { anchor, base };
      };
      const readFiles = async (): Promise<readonly FileDiff[]> => {
        const files = await readPullRequestDiff(folder, await readBase());
        diffPaths = files.map((file) => file.path);
        diffFiles = files;
        return files;
      };
      const readHead = async (): Promise<string> => (await git(folder, ['rev-parse', 'HEAD'])).trim();
      const readAnalysis = async (): Promise<AnalysisView> => {
        const result = await opened.analysis.result();
        const { running, step, error } = opened.analysis.activity;
        const stale = result !== undefined && result.head !== await readHead().catch(() => result.head);
        return { running, stale, ...(step === undefined ? {} : { step }), ...(error === undefined ? {} : { error }), ...(result === undefined ? {} : { result }) };
      };
      const detailsChanged = new vscode.EventEmitter<void>();
      let details: Promise<PullRequestDetails | Error> | undefined;
      const asError = (error: unknown): Error => error instanceof Error ? error : new Error(String(error));
      const currentDetails = async (): Promise<PullRequestDetails> => {
        const loaded = await (details ?? loadDetails());
        if (loaded instanceof Error) throw loaded;
        return loaded;
      };
      /** Reload the page's details and the sidebar after a change it lists, such as title, draft or open state. */
      const changedOnGitHub = (): void => {
        void loadDetails();
        void vscode.commands.executeCommand('pairReview.refreshPullRequests');
      };
      const loadDetails = (): Promise<PullRequestDetails | Error> => {
        details = provider.details(pullRequest.number).catch(asError);
        void details.then(() => { detailsChanged.fire(); });
        return details;
      };
      let remote: Promise<readonly RemoteThread[] | Error> | undefined;
      /** What Claude asked when it last stopped fixing conflicts without pushing. */
      let conflictQuestion: string | undefined;
      const loadThreads = (): Promise<readonly RemoteThread[] | Error> => {
        remote = provider.threads(pullRequest.number).catch(asError);
        void remote.then(() => { detailsChanged.fire(); });
        return remote;
      };
      /** Details and threads in one request on first load; a failed combined request falls back to separate ones. */
      const loadOverview = (): void => {
        const both = provider.overview(pullRequest.number);
        details = both.then(({ details: loaded }) => loaded, () => provider.details(pullRequest.number)).catch(asError);
        remote = both.then(({ threads }) => threads, () => provider.threads(pullRequest.number)).catch(asError);
        void details.then(() => { detailsChanged.fire(); });
        void remote.then(() => { detailsChanged.fire(); });
      };
      const read = async (): Promise<ReturnType<typeof buildOverviewState>> => {
        if (details === undefined && remote === undefined) loadOverview();
        const paths = await listed;
        const all = [...new Set([...(paths ?? []), ...diffPaths])];
        const [viewed, read] = await Promise.all([
          fileReviews.reviewed(provider, repository, pullRequest.number, all),
          readBase().then((base) => fileReviews.readRanges(repository, pullRequest.number, base)).catch(() => []),
        ]);
        const [loadedDetails, loadedThreads, analysis] = await Promise.all([details ?? loadDetails(), remote ?? loadThreads(), readAnalysis()]);
        await prepareHighlighting(opened.session.store.threads.flatMap((thread) => thread.messages.flatMap((entry) => fenceFilePaths(entry.text))));
        const state = buildOverviewState(pullRequest, opened, [...viewed], read, paths?.length, loadedDetails, loadedThreads, analysis);
        return conflictQuestion === undefined ? state : { ...state, conflictQuestion: markdownHtml(conflictQuestion) };
      };
      const changed: vscode.Event<unknown> = (listener) => vscode.Disposable.from(
        pullRequestSessions.onDidChangeState((changedSession) => { if (changedSession === opened) listener(changedSession); }),
        fileReviews.onDidChange((changed) => { if (changed === `${repository}#${pullRequest.number}`) listener(changed); }),
        detailsChanged.event(listener),
      );
      await showPullRequestOverview(`${repository}#${pullRequest.number}`, read, changed, {
        readFiles,
        readContext: async (path) => {
          if (!diffPaths.includes(path)) throw new Error(`${path} is not part of this PR's changes.`);
          const text = await readFile(join(folder, path), 'utf8');
          await prepareHighlighting([path]);
          return highlightSource(text, path);
        },
        readPreview: async (path) => {
          if (!diffPaths.includes(path)) throw new Error(`${path} is not part of this PR's changes.`);
          const text = await readFile(join(folder, path), 'utf8');
          if (/\.html?$/iu.test(path)) return { kind: 'html', ...htmlPreview(text) };
          const readImage = async (image: string): Promise<Buffer | undefined> => {
            const file = join(folder, image);
            const info = await lstat(file).catch(() => undefined);
            return info?.isFile() === true && info.size <= maxMediaBytes ? await readFile(file) : undefined;
          };
          const blocks = await Promise.all(markdownBlocks(text).map(async (block) => ({ ...block, html: await inlineLocalImages(block.html, path, readImage) })));
          return { kind: 'markdown', blocks };
        },
        readMedia: async (path) => {
          const file = diffFiles.find((each) => each.path === path);
          const mime = mediaType(path);
          if (file === undefined || mime === undefined) throw new Error(`${path} is not an image or PDF in this PR's changes.`);
          const side = async (read: () => Promise<Buffer>, size: () => Promise<number>): Promise<MediaSide> =>
            await size() > maxMediaBytes ? { mime, tooBig: true } : { mime, data: (await read()).toString('base64') };
          const base = await readBase();
          const oldPath = file.oldPath ?? path;
          const [before, after] = await Promise.all([
            file.change === 'added' ? undefined : side(() => readGitBaseBytes(folder, oldPath, base, maxMediaBytes), async () => Number((await git(folder, ['cat-file', '-s', `${base}:${oldPath}`])).trim())),
            file.change === 'deleted' ? undefined : side(() => readFile(join(folder, path)), async () => (await stat(join(folder, path))).size),
          ]);
          return { ...before === undefined ? {} : { old: before }, ...after === undefined ? {} : { new: after } };
        },
        findDefinition: async (at, line, column) => {
          if ('peek' in at) return definitions.find(definitions.location(at.peek).uri, line, column);
          if (!diffPaths.includes(at.path)) throw new Error(`${at.path} is not part of this PR's changes.`);
          return definitions.find(vscode.Uri.file(join(folder, at.path)), line, column);
        },
        hasDefinition: async (at, line, column) => {
          if ('peek' in at) return definitions.has(definitions.location(at.peek).uri, line, column);
          if (!diffPaths.includes(at.path)) return false;
          return definitions.has(vscode.Uri.file(join(folder, at.path)), line, column);
        },
        openDefinition: async (peek) => {
          const { uri, range } = definitions.location(peek);
          await vscode.window.showTextDocument(uri, { selection: range, preview: true });
        },
        comment: async ({ text, intent, ...lines }) => {
          const { anchor } = await pageAnchor(lines);
          await opened.session.store.submit(anchor, text, intent);
        },
        reply: async (id, text) => {
          const thread = findThread(id);
          if (thread.resolved) throw new Error('Reopen this thread before replying.');
          await opened.session.store.submit(thread.anchor, text, thread.intent, id);
        },
        resolve: (id, resolved) => opened.session.store.resolve(findThread(id).id, resolved),
        publish: async (id) => { await opened.session.publish?.(findThread(id).id); },
        commentOnGitHub: async ({ text, ...lines }, pending) => {
          const { anchor, base } = await pageAnchor(lines);
          const placement = await placeComment(folder, base, anchor);
          if (placement.lines === undefined) throw new Error('GitHub only takes comments on lines its diff shows. Pick lines inside a changed section.');
          await provider.publishComment(pullRequest.number, { ...placement, body: text }, pending);
          await Promise.all([loadThreads(), loadDetails()]);
        },
        replyOnGitHub: async (id, text) => {
          await provider.replyToThread(id, text);
          await loadThreads();
        },
        resolveOnGitHub: async (id, resolved) => {
          await provider.resolveThread(id, resolved);
          await loadThreads();
        },
        deleteOnGitHub: async (id) => {
          const choice = await vscode.window.showWarningMessage('Delete this comment on GitHub?', { modal: true, detail: 'Everyone on the PR loses it. This cannot be undone.' }, 'Delete');
          if (choice !== 'Delete') return;
          await provider.deleteComment(id);
          await Promise.all([loadThreads(), loadDetails()]);
        },
        setViewed: (path, viewed) => fileReviews.set(provider, repository, pullRequest.number, path, viewed),
        markRead: async (range, fileDone) => {
          if (!diffPaths.includes(range.path)) throw new Error(`${range.path} is not part of this PR's changes.`);
          await fileReviews.markRead(repository, pullRequest.number, await readBase(), range);
          if (fileDone) await fileReviews.set(provider, repository, pullRequest.number, range.path, true);
        },
        unmarkRead: (ids) => fileReviews.unmarkRead(repository, pullRequest.number, ids),
        openInEditor: (path) => openPullRequestFile(storageRoot, repository, pullRequest, path),
        showLog: () => { opened.output.show(true); },
        retry: () => { opened.runner.retry(); },
        revealThread: async (id) => { await vscode.commands.executeCommand('pairReview.revealThread', id); },
        submitReview: async (event, body) => {
          await provider.submitReview(pullRequest.number, event, body);
          void loadDetails();
        },
        fixConflicts: async (answer) => {
          const loaded = await currentDetails();
          if (loaded.mergeable !== 'no' || !loaded.canEdit) throw new Error('GitHub reports no conflicts you can fix on this PR.');
          const base = await prepareConflictFix(folder, pullRequest.number, pullRequest.baseBranch);
          const head = (await git(folder, ['rev-parse', 'HEAD'])).trim();
          conflictQuestion = undefined;
          const pushTo = loaded.headRepository === undefined ? 'origin' : `https://${new URL(pullRequest.url).host}/${loaded.headRepository}.git`;
          const { error, reply } = await opened.runner.runTask(conflictTask({ base, baseBranch: pullRequest.baseBranch, headBranch: pullRequest.headBranch, pushTo, ...(answer === undefined ? {} : { answer }) }));
          const pushedNothing = (await git(folder, ['rev-parse', 'HEAD'])).trim() === head;
          if (error === undefined && pushedNothing && reply !== undefined) conflictQuestion = reply;
          changedOnGitHub();
          if (error !== undefined) throw new Error(`Claude did not fix the conflicts: ${error}`);
        },
        dismissConflictQuestion: () => {
          conflictQuestion = undefined;
          detailsChanged.fire();
        },
        merge: async (method) => {
          const merge = 'Merge';
          const mergeAndDelete = 'Merge and delete branch';
          const { branchDeletable } = await currentDetails();
          const answer = await vscode.window.showWarningMessage(`Merge #${pullRequest.number} into ${pullRequest.baseBranch}?`, { modal: true },
            ...branchDeletable ? [merge, mergeAndDelete] : [merge]);
          if (answer === undefined) return;
          await provider.merge(pullRequest.number, method);
          if (answer === mergeAndDelete) await provider.deleteBranch(pullRequest.headBranch);
          changedOnGitHub();
        },
        editTitle: async () => {
          const { title } = await currentDetails();
          const next = await vscode.window.showInputBox({ title: 'Edit title', value: title, validateInput: (value) => value.trim() ? undefined : 'Enter a title.' });
          if (next === undefined || next.trim() === title) return;
          await provider.editPullRequest(pullRequest.number, { title: next.trim() });
          changedOnGitHub();
        },
        editBody: async (body) => {
          await provider.editPullRequest(pullRequest.number, { body });
          void loadDetails();
        },
        pick: async (what) => {
          await pickAndSave(provider, pullRequest.number, await currentDetails(), what);
          void loadDetails();
        },
        setDraft: async (draft) => {
          await provider.setDraft(pullRequest.number, draft);
          changedOnGitHub();
        },
        setOpen: async (open) => {
          if (!open) {
            const close = 'Close';
            const answer = await vscode.window.showWarningMessage(`Close #${pullRequest.number} without merging?`, { modal: true, detail: 'You can reopen it later.' }, close);
            if (answer !== close) return;
          }
          await provider.editPullRequest(pullRequest.number, { state: open ? 'open' : 'closed' });
          changedOnGitHub();
        },
        deleteBranch: async () => {
          const remove = 'Delete branch';
          const answer = await vscode.window.showWarningMessage(`Delete the branch ${pullRequest.headBranch} on GitHub?`, { modal: true }, remove);
          if (answer !== remove) return;
          await provider.deleteBranch(pullRequest.headBranch);
          void loadDetails();
        },
        removeWorktree: async () => {
          const confirm = 'Remove worktree';
          const answer = await vscode.window.showWarningMessage(
            `Remove the worktree for #${pullRequest.number}? Its local comments are deleted too. Git refuses if it has uncommitted changes.`, { modal: true }, confirm);
          if (answer !== confirm) return false;
          await pullRequestSessions.close(repository, pullRequest.number);
          await removeWorktree(checkout.root, storageRoot, repository, pullRequest.number);
          void vscode.commands.executeCommand('pairReview.refreshPullRequests');
          return true;
        },
        refresh: () => { void loadDetails(); void loadThreads(); },
        analyze: async () => {
          const [files, head] = await Promise.all([readFiles(), readHead()]);
          opened.analysis.start({
            files, head,
            about: `#${pullRequest.number} ${pullRequest.title} (${pullRequest.headBranch} into ${pullRequest.baseBranch})`,
            anchor: async ({ range }) => (await pageAnchor({ ...range, endLine: Math.min(range.endLine, range.startLine + 49) })).anchor,
          });
        },
        stopAnalysis: () => { opened.analysis.stop(); },
      }, context.extensionUri, reveal);
    };
    const worktreesOf = (checkout: Checkout): PullRequestWorktrees => {
      const { root: checkoutRoot, storageRoot, sessions, fileReviews } = checkout;
      return {
        exists: (repository, number) => hasWorktree(storageRoot, repository, number),
        open: (provider, repository, pullRequest, role, revealPath) => showOverview(checkout, provider, repository, pullRequest, role, revealPath === undefined ? undefined : { path: revealPath }),
        showClaude: async (provider, repository, pullRequest, role) => {
          await ensureWorktree(checkoutRoot, storageRoot, provider, repository, pullRequest, role);
          showClaude(await sessions.open(repository, pullRequest.number));
        },
        remove: async (repository, number) => {
          await sessions.close(repository, number);
          await removeWorktree(checkoutRoot, storageRoot, repository, number);
        },
        claudeStatus: (repository, number) => {
          const opened = sessions.get(repository, number);
          return opened === undefined ? undefined : claudeStatus(opened.runner.activity).text;
        },
        reviewedFiles: (provider, repository, number, paths) => fileReviews.reviewed(provider, repository, number, paths),
        setReviewed: (provider, repository, number, path, reviewed) => fileReviews.set(provider, repository, number, path, reviewed),
        forget: () => { fileReviews.forget(); GitHubApiProvider.forget(); checkouts.rescan(); },
        showOverview: (provider, repository, pullRequest, role, step) => showOverview(checkout, provider, repository, pullRequest, role, step === undefined ? undefined : { step }),
        guide: async (provider, repository, pullRequest) => {
          const folder = worktreePath(storageRoot, repository, pullRequest.number);
          const analysis = await readSavedAnalysis(reviewDataPath(folder));
          const base = analysis === undefined ? undefined : await readPullRequestBase(folder, pullRequest.baseBranch);
          if (analysis === undefined || base === undefined) return undefined;
          const files = await readPlainPullRequestDiff(folder, base);
          const [read, viewed] = await Promise.all([
            fileReviews.readRanges(repository, pullRequest.number, base),
            fileReviews.reviewed(provider, repository, pullRequest.number, files.map((file) => file.path)),
          ]);
          return guideOutline(buildGuide(analysis, files), files, read, viewed);
        },
      };
    };
    context.subscriptions.push(
      registerPullRequestView(
        async () => (await checkouts.list()).map((checkout) => ({
          folder: relative(root, checkout.root) || basename(root), connect: checkout.connect, worktrees: worktreesOf(checkout),
        })),
        (listener) => vscode.Disposable.from(
          checkouts.onDidChangeState((changed) => { listener(changed.session.key); }),
          checkouts.onDidChangeReviewedFiles(listener),
        ),
        context.globalState,
        context.workspaceState,
      ),
      watchGitHubSessions(() => { void vscode.commands.executeCommand('pairReview.refreshPullRequests'); }),
      vscode.commands.registerCommand('pairReview.signInToGitHub', async (provider: unknown) => {
        try {
          await signInToGitHub(provider === 'github' || provider === 'github-enterprise' ? provider : undefined);
          await vscode.commands.executeCommand('pairReview.refreshPullRequests');
        } catch (error: unknown) {
          void vscode.window.showErrorMessage(error instanceof Error ? error.message : String(error));
        }
      }),
      reportClaudeFailures(checkouts),
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration('pairReview.mockPullRequests') || event.affectsConfiguration('github-enterprise.uri')) void vscode.commands.executeCommand('pairReview.refreshPullRequests');
      }),
    );
    await createReviewController(store, context, getHeadRevision, checkouts);
    context.subscriptions.push(registerReviewAppearance(context));
    context.subscriptions.push(registerPrExport(context, store));
    const bridge = await createReviewBridge(store, join(storage.fsPath, 'selected-session.json'));
    activeBridge = bridge;
    context.subscriptions.push(bridge, registerClaudeLauncher(context, bridge, storage.fsPath), vscode.commands.registerCommand('pairReview.showFocusedClaude', () => {
      const document = vscode.window.activeTextEditor?.document;
      const focused = document === undefined ? undefined : checkouts.forUri(document.uri);
      if (focused !== undefined) showClaude(focused);
    }));
    void checkouts.list().catch((error: unknown) => {
      void vscode.window.showErrorMessage(`Pair Review could not restore pull request reviews: ${error instanceof Error ? error.message : String(error)}`);
    });
    await prepareConnection(context, bridge, storage.fsPath);
    const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 20);
    status.command = 'pairReview.startClaude';
    const updateStatus = (): void => {
      const document = vscode.window.activeTextEditor?.document;
      const focused = document === undefined ? undefined : checkouts.forUri(document.uri);
      if (focused !== undefined) {
        const current = claudeStatus(focused.runner.activity);
        status.text = `$(${current.icon}) ${focused.session.label} · ${current.text}`;
        status.tooltip = current.retry ? `${focused.runner.activity.error ?? 'Some comments were not picked up.'} Click to send them again.` : `Show what Claude did for ${focused.session.label}`;
        status.command = 'pairReview.showFocusedClaude';
        status.show();
        return;
      }
      status.command = 'pairReview.startClaude';
      const waiting = store.pendingEvents.length;
      const ready = bridge.state.deliveryReady === true;
      const label = !bridge.state.connected ? '$(debug-disconnect) Review · Verbinden'
        : ready ? '$(comment-discussion) Review' : '$(warning) Review · Zustellung pausiert';
      status.text = `${label}${waiting ? ` · ${waiting} wartet` : ''}`;
      status.tooltip = !bridge.state.connected
        ? 'Mit Claude Code verbinden. Abgeschickte Kommentare bleiben bis zur Bestätigung gespeichert.'
        : ready ? 'Automatische Zustellung aktiv. Claude bestätigt jeden Kommentar separat.'
          : 'Claude-Verbindung vorhanden. Die automatische Zustellung ist noch nicht aktiv. Zum Wiederverbinden klicken.';
      status.show();
    };
    context.subscriptions.push(
      status, store.onChange(updateStatus), bridge.onChange(updateStatus),
      checkouts.onDidChangeState(updateStatus), vscode.window.onDidChangeActiveTextEditor(updateStatus),
    );
    updateStatus();
  } catch (error: unknown) {
    activeBridge?.dispose();
    await vscode.window.showErrorMessage(`Pair Review konnte nicht starten: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** Finish persisted mutations before VS Code unloads the extension. */
export async function deactivate(): Promise<void> {
  activeBridge?.dispose();
  await activeStore?.flush();
  await activePullRequests?.flush();
  activePullRequests = undefined;
  activeBridge = undefined;
  activeStore = undefined;
}

/** Open a PR's Claude log, and send comments again after a failed or skipped run. */
function showClaude({ runner, output }: PullRequestSession): void {
  if (claudeStatus(runner.activity).retry) runner.retry();
  output.show(true);
}

/** Tell the user once per failed run why Claude did not answer, instead of leaving comments waiting silently. */
function reportClaudeFailures(sessions: Pick<Checkouts, 'onDidChangeState'>): vscode.Disposable {
  const reported = new WeakMap<PullRequestSession, string>();
  return sessions.onDidChangeState((opened) => {
    const { running, error } = opened.runner.activity;
    if (running || error === undefined) {
      reported.delete(opened);
      return;
    }
    if (reported.get(opened) === error) return;
    reported.set(opened, error);
    const log = 'Show log';
    const retry = 'Retry';
    void vscode.window.showErrorMessage(`Claude could not answer on ${opened.session.label}: ${error}`, retry, log).then((choice) => {
      if (choice === retry) opened.runner.retry();
      if (choice === log) opened.output.show(true);
    });
  });
}
