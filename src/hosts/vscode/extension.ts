import { mkdir, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { basename, isAbsolute, join, relative, sep } from 'node:path';
import * as vscode from 'vscode';
import { createReviewBridge } from '../../agents/claude/bridge.js';
import { readPicks, reviewView, savePicks } from '../../agents/claude/reviewRunner.js';
import { type AgentChoice, agentStatus, type AgentTask, backgroundStatus } from '../../core/agent.js';
import { anchorFromText, fileAnchor, pullRequestAnchor } from '../../core/anchors.js';
import { prepareHighlighting, useEditorHighlighter } from '../../core/codePreview.js';
import { commitAndPush, commitFiles, conflictTask, localChanges, prepareConflictFix, pushCommits, syncKeepingLocalCommits, syncToPullRequestHead, unpushedCommits } from '../../core/conflicts.js';
import type { CodeAnchor, ReviewBridge, ReviewStore, ReviewThread } from '../../core/contracts.js';
import type { ChangeRequestConversation, ChangeRequestDetails, ChangeRequestSummary, ChangeRequestVersion, Forge, RemoteThread, WorkspaceRepository } from '../../core/forge.js';
import { isWorkspaceRelativePath, readGitBase } from '../../core/git/git.js';
import { listLocalCheckouts, type LocalCheckout } from '../../core/git/localCheckouts.js';
import { cleanUpWorktrees } from '../../core/git/worktreeCleanup.js';
import { ensureWorktree, git, hasWorktree, type PullRequestRole, readPullRequestBase, removeWorktree, worktreePath } from '../../core/git/worktrees.js';
import { maximumReplyLength } from '../../core/limits.js';
import { draftReplyTask, githubFeedbackRequest, githubReplyTask, placeComment } from '../../core/pullRequestComments.js';
import { FileReviews } from '../../core/reviewedFiles.js';
import { createReviewStore } from '../../core/store.js';
import { applySuggestion, parseSuggestions, suggestionLines, suggestionMarkdown } from '../../core/suggestions.js';
import { type FileDiff, highlightSource, readPullRequestDiff, savedCodeDiff } from '../../core/unifiedDiff.js';
import { signInToGitHub, useGitHubHost, watchGitHubSessions } from '../../forges/github/githubApi.js';
import { GitHubApiProvider } from '../../forges/github/provider.js';
import { parsePullRequestLink } from '../../forges/github/remotes.js';
import { mockPullRequestProvider } from '../../forges/mockPullRequests.js';
import { linkedChanges } from '../../page/linkedController.js';
import { mediaType } from '../../page/media.js';
import { buildOverviewState } from '../../page/overviewState.js';
import { readFilePreview, readMediaSides } from '../../page/preview/fileContent.js';
import { fenceFilePaths, markdownHtml } from '../../page/preview/markdown.js';
import type { AnalysisView, AppliedSuggestion, DiffSelection, FilesView, LinkedChange, OverviewReveal, PageComment } from '../../page/protocol.js';
import { saveSelection } from '../../page/pullRequestEdits.js';
import { githubPageActions } from '../../page/pullRequestPageActions.js';
import { PendingWrites, sharedPerTurn } from './autoSync.js';
import { type Checkout, Checkouts, nestedRepositoryRoots } from './checkouts.js';
import { type ClaudeAnswer, ClaudeAnswersTree, latestAnswers, SeenAnswers } from './claudeAnswers.js';
import { DefinitionPeeks } from './definitions.js';
import { readFileIcons } from './fileIcons.js';
import { vscodeGitHubHost } from './githubHost.js';
import { LocalFilesView } from './localFilesView.js';
import { type BranchPullRequests, implementThreadRequest, listRepositoryFiles, localClaudeStatus, LocalReview, toDisposable, wholeFile } from './localReview.js';
import { type LocalSession, LocalSessions } from './localSessions.js';
import { openPullRequestFile, readBaseContent, registerPullRequestDiffs } from './pullRequestDiff.js';
import { checkoutDataPath, type PullRequestSession, PullRequestSessions } from './pullRequestSessions.js';
import { type PullRequestWorktrees, registerPullRequestView } from './pullRequestView.js';
import { isPageOpen, revealOpenPage, showPullRequestOverview } from './reviewPanel.js';
import { prepareConnection, registerClaudeLauncher } from './setup.js';
import { editorHighlighter } from './textMate.js';

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
  const allAnswers = (): ClaudeAnswer[] => latestAnswers(checkouts.opened.map(({ session }) => ({ key: session.session.key, number: session.metadata.pullRequest.number, threads: session.session.store.threads })));
  const answersTree = new ClaudeAnswersTree(allAnswers, seenAnswers);
  const answersView = vscode.window.createTreeView('diffGuide.answers', { treeDataProvider: answersTree });
  const showAnswerCount = (): void => {
    const fresh = allAnswers().filter((answer) => seenAnswers.isNew(answer)).length;
    answersView.badge = fresh === 0 ? undefined : { value: fresh, tooltip: `${fresh} new ${fresh === 1 ? 'answer' : 'answers'} from Claude` };
  };
  const answersChanged = (): void => { answersTree.refresh(); showAnswerCount(); };
  showAnswerCount();
  context.subscriptions.push(seenAnswers, answersTree, answersView, checkouts.onDidChangeState(answersChanged), checkouts.onDidChange(answersChanged), seenAnswers.onDidChange(answersChanged));
  const storage = context.storageUri;
  if (storage === undefined) return;
  try {
    await mkdir(storage.fsPath, { recursive: true, mode: 0o700 });
    const store = await createReviewStore(join(storage.fsPath, 'review.json'), folder.uri.fsPath);
    activeStore = store;
    activePullRequests = checkouts;
    /** Files outside the diff each open PR page shows whole, kept across calls that reveal a file on an open page. */
    const revealedFiles = new Map<string, Set<string>>();
    /** Review marks of your PRs open on checkouts, by checkout folder. */
    const checkoutFileReviews = new Map<string, FileReviews>();
    /**
     * Show a PR's review page. `onCheckout` opens your own PR on that checkout instead of a worktree, in its local page's tab:
     * its comments stay in the checkout's review and reach the conversation you connected there, and the checkout never moves on its own.
     */
    const showOverview = async (checkout: Checkout, provider: Forge, repository: string, pullRequest: ChangeRequestSummary, role: PullRequestRole, reveal?: OverviewReveal, onCheckout?: LocalSession): Promise<void> => {
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
      /** Refuses what would move or remove your own checkout. */
      const notOnCheckout = (what: string): void => { if (onCheckout !== undefined) throw new Error(`${what} works on PR worktrees only, not on your own checkout.`); };
      const listed = provider.listFiles(pullRequest.number).then((files) => files.map((file) => file.path), () => undefined);
      let diffPaths: readonly string[] = [];
      /** Changed files from the latest diff read, so media previews need no second read. */
      let diffFiles: readonly FileDiff[] = [];
      const definitions = new DefinitionPeeks(folder);
      /** The base branch, which the page can change. */
      let baseBranch = pullRequest.baseBranch;
      const current = (): ChangeRequestSummary => ({ ...pullRequest, baseBranch });
      const readBase = async (): Promise<string> => {
        const base = await readPullRequestBase(folder, baseBranch);
        if (base === undefined) throw new Error(`Could not find where #${pullRequest.number} branched off ${baseBranch}.`);
        return base;
      };
      /** What the Files tab shows; comments and read marks need the whole PR at its latest version. */
      let selection: DiffSelection = { range: { kind: 'all' }, whitespace: false };
      let selectionAtHead = true;
      const findThread = (id: string): ReviewThread => {
        const thread = opened.session.store.threads.find((candidate) => candidate.id === id);
        if (thread === undefined) throw new Error('This thread no longer exists.');
        return thread;
      };
      const pageAnchor = async ({ path, side, startLine, endLine }: Omit<PageComment, 'text' | 'intent'>): Promise<{ anchor: CodeAnchor; base: string }> => {
        if (!diffPaths.includes(path)) throw new Error(`${path} is not part of this PR's changes.`);
        if (!selectionAtHead || (side === 'old' && selection.range.kind !== 'all')) throw new Error('Show all changes to comment on these lines.');
        const base = await readBase();
        const content = side === 'old' ? await readBaseContent(folder, path, base) : await readFile(join(folder, path), 'utf8');
        const anchor = anchorFromText(content, { path, startLine, endLine, side: side === 'old' ? 'original' : 'working', baseRevision: base });
        return { anchor, base };
      };
      /** Run a drafting task in the PR's conversation and return Claude's comment. */
      const runDraft = async (task: AgentTask): Promise<string> => {
        const { error, reply } = await opened.runner.runTask(task);
        if (error !== undefined) throw new Error(`Claude could not draft the reply: ${error}`);
        if (reply === undefined) throw new Error('Claude did not write a draft. Try again.');
        return reply.slice(0, maximumReplyLength);
      };
      const readHead = async (): Promise<string> => (await git(folder, ['rev-parse', 'HEAD'])).trim();
      /** The PR on GitHub at the last check, so the next one can ask whether it changed. */
      let version: ChangeRequestVersion | undefined;
      /** The worktree commit the page's files were last sent for, so a move by Claude's run or a sync shows up. */
      let shownHead: string | undefined;
      /** A commit the diff needs, fetched when a force push left it out of the worktree. */
      const haveCommit = async (oid: string): Promise<void> => {
        if (await git(folder, ['cat-file', '-e', `${oid}^{commit}`]).then(() => true, () => false)) return;
        await git(folder, ['fetch', '--quiet', 'origin', oid]).catch(() => { throw new Error('That commit is no longer on GitHub, probably after a force push.'); });
      };
      /** Files outside the diff opened on the page, such as from the Local view; files with open Local threads show without being opened. */
      const pageKey = `${repository}#${pullRequest.number}`;
      if (!isPageOpen(pageKey)) revealedFiles.set(pageKey, new Set());
      const revealed = revealedFiles.get(pageKey) ?? new Set<string>();
      if (reveal !== undefined && 'path' in reveal && reveal.reload === true && isWorkspaceRelativePath(reveal.path)) revealed.add(reveal.path);
      /** Files outside the diff with Local threads, shown whole after the changes, or as their saved code once the file is gone. */
      const threadFiles = async (shown: readonly string[]): Promise<FileDiff[]> => {
        const threads = opened.session.store.threads;
        const paths = [...new Set([...threads.filter((thread) => !thread.resolved).map((thread) => thread.anchor.path), ...revealed])]
          .filter((path) => isWorkspaceRelativePath(path) && !shown.includes(path));
        await prepareHighlighting(paths);
        return Promise.all(paths.map(async (path) => await wholeFile(folder, path, 'unchanged')
          ?? savedCodeDiff(path, threads.filter((thread) => thread.anchor.path === path).map((thread) => thread.anchor))));
      };
      const readFiles = async (select?: DiffSelection): Promise<FilesView> => {
        const wanted = select ?? selection;
        const { range } = wanted;
        let base: string;
        let to: string | undefined;
        if (range.kind === 'all') base = await readBase();
        else if (range.kind === 'since') {
          const since = (await currentConversation()).lastReviewedCommit;
          if (since === undefined) throw new Error('You have not reviewed this PR yet.');
          await haveCommit(since);
          base = since;
        } else {
          await haveCommit(range.from);
          await haveCommit(range.to);
          base = (await git(folder, ['rev-parse', `${range.from}^`])).trim();
          to = range.to === await readHead() ? undefined : range.to;
        }
        const files = await readPullRequestDiff(folder, base, { ...to === undefined ? {} : { to }, ignoreWhitespace: wanted.whitespace });
        selection = wanted;
        selectionAtHead = to === undefined;
        diffPaths = files.map((file) => file.path);
        diffFiles = files;
        const [whole, repositoryFiles] = await Promise.all([range.kind === 'all' ? threadFiles(diffPaths) : [], listRepositoryFiles(folder).catch(() => [])]);
        const icons = await readFileIcons([...new Set([...repositoryFiles, ...diffPaths, ...whole.map((file) => file.path)])]).catch(() => undefined);
        return { files: [...files, ...whole], repositoryFiles, selection, atHead: selectionAtHead, ...icons === undefined ? {} : { icons } };
      };
      const readAnalysis = async (): Promise<AnalysisView> => {
        const result = await opened.analysis.result();
        const { running, step, progress, error } = opened.analysis.activity;
        const stale = result !== undefined && result.head !== await readHead().catch(() => result.head);
        const behind = stale ? await git(folder, ['rev-list', '--count', `${result.head}..HEAD`]).then((count) => Number(count.trim()), () => undefined) : undefined;
        return {
          running, stale, ...(behind === undefined ? {} : { behind }), ...(step === undefined ? {} : { step }), ...(progress === undefined ? {} : { progress }),
          ...(error === undefined ? {} : { error }), ...(result === undefined ? {} : { result }),
        };
      };
      const detailsChanged = new vscode.EventEmitter<void>();
      /** The user's own changes on GitHub, kept on the page until GitHub's reads catch up with them. */
      const written = new PendingWrites();
      let details: Promise<ChangeRequestDetails | Error> | undefined;
      const asError = (error: unknown): Error => error instanceof Error ? error : new Error(String(error));
      const currentDetails = async (): Promise<ChangeRequestDetails> => {
        const loaded = await (details ?? loadDetails());
        if (loaded instanceof Error) throw loaded;
        return loaded;
      };
      /** Reload the page's details and the sidebar after a change it lists, such as title, draft or open state. */
      const changedOnGitHub = (): void => {
        void loadDetails();
        void loadConversation();
        void vscode.commands.executeCommand('diffGuide.refreshPullRequests');
      };
      const loadDetails = sharedPerTurn((): Promise<ChangeRequestDetails | Error> => {
        details = provider.details(pullRequest.number).catch(asError);
        void details.then(() => { detailsChanged.fire(); });
        return details;
      });
      let remote: Promise<readonly RemoteThread[] | Error> | undefined;
      let conversation: Promise<ChangeRequestConversation | Error> | undefined;
      const loadConversation = sharedPerTurn((): Promise<ChangeRequestConversation | Error> => {
        conversation = provider.conversation(pullRequest.number).catch(asError);
        void conversation.then(() => { detailsChanged.fire(); });
        return conversation;
      });
      const currentConversation = async (): Promise<ChangeRequestConversation> => {
        const loaded = await (conversation ?? loadConversation());
        if (loaded instanceof Error) throw loaded;
        return loaded;
      };
      /** What Claude asked when it last stopped fixing conflicts without pushing. */
      let conflictQuestion: string | undefined;
      /** Suggestion options written to the worktree while this page is open, by thread. */
      const applied = new Map<string, AppliedSuggestion>();
      /** File contents around each suggestion applied without committing, so Discard can put the file back. */
      const undo = new Map<string, { readonly path: string; readonly before: string; readonly after: string }>();
      /** Where to push the PR's branch: `origin`, or the fork's URL when the branch lives in a fork. */
      const pushTarget = (loaded: ChangeRequestDetails): string => loaded.headRepository === undefined ? 'origin' : `https://${new URL(pullRequest.url).host}/${loaded.headRepository}.git`;
      const loadThreads = sharedPerTurn((): Promise<readonly RemoteThread[] | Error> => {
        remote = provider.threads(pullRequest.number).catch(asError);
        void remote.then(() => { detailsChanged.fire(); });
        return remote;
      });
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
        if (conversation === undefined) void loadConversation();
        const paths = await listed;
        const all = [...new Set([...(paths ?? []), ...diffPaths])];
        const [viewed, read] = await Promise.all([
          fileReviews.reviewed(provider, repository, pullRequest.number, all),
          readBase().then((base) => fileReviews.readRanges(repository, pullRequest.number, base)).catch(() => []),
        ]);
        const [readDetails, readThreads, analysis, loadedConversation, review] = await Promise.all([details ?? loadDetails(), remote ?? loadThreads(), readAnalysis(), conversation ?? loadConversation(), reviewView(opened.review, readPicks(context.globalState, repository))]);
        const loadedDetails = readDetails instanceof Error ? readDetails : {
          ...readDetails, title: written.apply('title', readDetails.title), draft: written.apply('draft', readDetails.draft), open: written.apply('open', readDetails.open),
        };
        const loadedThreads = readThreads instanceof Error ? readThreads : readThreads.map((thread) => ({ ...thread, resolved: written.apply(`resolved:${thread.id}`, thread.resolved) }));
        await prepareHighlighting(opened.session.store.threads.flatMap((thread) => [thread.anchor.path, ...thread.messages.flatMap((entry) => fenceFilePaths(entry.text))]));
        const summary = loadedDetails instanceof Error ? current() : { ...current(), title: loadedDetails.title, draft: loadedDetails.draft };
        const state = buildOverviewState(summary, opened, [...viewed], read, paths?.length, loadedDetails, loadedThreads, analysis, loadedConversation, await opened.runner.context(), review);
        const answers = new Map(latestAnswers([{ key: opened.session.key, number: pullRequest.number, threads: opened.session.store.threads }], Infinity).filter((answer) => seenAnswers.isNew(answer)).map((answer) => [answer.threadId, answer.createdAt]));
        const threads = state.threads.map((thread) => {
          const done = applied.get(thread.id);
          const newAnswer = answers.get(thread.id);
          return { ...thread, ...(done === undefined ? {} : { applied: done }), ...(newAnswer === undefined ? {} : { newAnswer }) };
        });
        const pushedHead = loadedConversation instanceof Error ? undefined : loadedConversation.merge.headOid;
        const [unpushed, local] = await Promise.all([pushedHead === undefined ? [] : unpushedCommits(folder, pushedHead), localChanges(folder, pushedHead)]);
        const linkedNow = await readLinked();
        const claude = onCheckout === undefined ? state.claude : { ...localClaudeStatus(onCheckout.bridge, onCheckout.store.pendingEvents.length),
          link: { delivering: onCheckout.bridge.state.deliveryReady === true, terminal: onCheckout.launcher.hasTerminal } };
        return {
          ...state, claude, threads, ...(conflictQuestion === undefined ? {} : { conflictQuestion: markdownHtml(conflictQuestion) }), ...(unpushed.length === 0 ? {} : { unpushed }),
          ...(local.files.size === 0 ? {} : { local: Object.fromEntries(local.files) }), linked: linkedNow,
        };
      };
      const publishedThreads = (): number => opened.session.store.threads.filter((thread) => opened.session.publication?.(thread.id) !== undefined).length;
      /** Local threads posted on GitHub at the last state change; one more means GitHub has a comment the page has not read yet. */
      let published = publishedThreads();
      const linked = linkedChanges({
        repository, pullRequest, provider, folder, base: readBase, dataPath: opened.dataPath, repositories: workspaceRepositories, parseLink: parsePullRequestLink,
        openPage: async (name, number) => {
          const other = (await workspaceRepositories()).get(name.toLowerCase());
          const target = other === undefined ? undefined : (await checkouts.list()).find((each) => each.storageRoot === other.storageRoot);
          if (target === undefined) throw new Error(`No clone of ${name} in this workspace.`);
          const otherProvider = await target.connect();
          const summary = await otherProvider.pullRequest(number);
          if (summary === undefined) throw new Error(`${name} has no PR #${number}.`);
          const mine = (await otherProvider.listMine()).some((each) => each.number === number);
          await showOverview(target, otherProvider, name, summary, mine ? 'author' : 'reviewer');
        },
      });
      /** The card's rows from the last read; reading them takes several GitHub requests, so redraws reuse them until the next reload. */
      let linkedRows: Promise<readonly LinkedChange[]> | undefined;
      const readLinked = (): Promise<readonly LinkedChange[]> => {
        linkedRows ??= linked.read().catch(() => []);
        return linkedRows;
      };
      const changedLinks = (): void => { linkedRows = undefined; detailsChanged.fire(); };
      /** After a Claude run, reload from GitHub behind the last values, so the page shows the run ended without waiting for GitHub. */
      const refreshAfterClaude = (): void => {
        const nextDetails = provider.details(pullRequest.number).catch(asError);
        const nextConversation = provider.conversation(pullRequest.number).catch(asError);
        const nextLinked = linked.read().catch(() => []);
        void nextDetails.then(() => { details = nextDetails; detailsChanged.fire(); });
        void nextConversation.then(() => { conversation = nextConversation; detailsChanged.fire(); });
        void nextLinked.then(() => { linkedRows = nextLinked; detailsChanged.fire(); });
        void vscode.commands.executeCommand('diffGuide.refreshPullRequests');
      };
      const changed: vscode.Event<unknown> = (listener) => vscode.Disposable.from(
        pullRequestSessions.onDidChangeState((changedSession) => {
          if (changedSession !== opened) return;
          const now = publishedThreads();
          if (now !== published) void loadThreads();
          published = now;
          listener(changedSession);
        }),
        fileReviews.onDidChange((changed) => { if (changed === `${repository}#${pullRequest.number}`) listener(changed); }),
        detailsChanged.event(listener),
        claudeFinished(opened.runner, refreshAfterClaude),
        ...onCheckout === undefined ? [] : [toDisposable(onCheckout.bridge.onChange(() => { listener(undefined); })), onCheckout.launcher.onDidChange(listener)],
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
          return readFilePreview(folder, path);
        },
        readMedia: async (path) => {
          const file = diffFiles.find((each) => each.path === path);
          if (file === undefined || mediaType(path) === undefined) throw new Error(`${path} is not an image or PDF in this PR's changes.`);
          return readMediaSides(folder, file, await readBase());
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
        missingLanguage: async (at) => {
          if ('peek' in at) return definitions.missingLanguage(definitions.location(at.peek).uri);
          return diffPaths.includes(at.path) ? definitions.missingLanguage(vscode.Uri.file(join(folder, at.path))) : undefined;
        },
        openDefinition: async (peek) => {
          const { uri, range } = definitions.location(peek);
          await vscode.window.showTextDocument(uri, { selection: range, preview: true });
        },
        comment: async ({ text, intent, ...lines }) => {
          const { anchor } = await pageAnchor(lines);
          await opened.session.store.submit(anchor, text, intent);
        },
        commentOnFile: async (path, text, intent) => {
          if (!diffPaths.includes(path)) throw new Error(`${path} is not part of this PR's changes.`);
          if (!selectionAtHead) throw new Error('Show all changes to comment on this file.');
          const base = await readBase();
          await opened.session.store.submit(fileAnchor(await readFile(join(folder, path), 'utf8'), { path, side: 'working', baseRevision: base }), text, intent);
        },
        reply: async (id, text, intent) => {
          const thread = findThread(id);
          if (thread.resolved) throw new Error('Reopen this thread before replying.');
          if (thread.archived) throw new Error('Unarchive this thread before replying.');
          await opened.session.store.submit(thread.anchor, text || implementThreadRequest, intent, id);
        },
        resolve: (id, resolved) => opened.session.store.resolve(findThread(id).id, resolved),
        archive: (id, archived) => opened.session.store.archive(findThread(id).id, archived),
        withdraw: async (id) => {
          const thread = findThread(id);
          // A background run was given the comment in its prompt, whether or not Claude confirmed it yet.
          const running = opened.runner.activity.running && opened.runner.activity.threads.has(thread.id);
          if (running) await opened.runner.stop();
          const taken = await opened.session.store.withdraw(thread.id);
          return { ...taken, text: taken.text === implementThreadRequest ? '' : taken.text, received: taken.received || running };
        },
        publish: async (id) => { await opened.session.publish?.(findThread(id).id); },
        postToGitHub: async (id, text, pending) => {
          const thread = findThread(id);
          await opened.session.postToGitHub?.(thread.id, text, pending);
          if (thread.anchor.scope === 'pullRequest') void loadConversation();
        },
        commentOnGitHub: async ({ text, ...lines }, pending) => {
          const { anchor, base } = await pageAnchor(lines);
          const placement = await placeComment(folder, base, anchor);
          if (placement.lines === undefined) throw new Error('GitHub only takes comments on lines its diff shows. Pick lines inside a changed section.');
          await provider.publishComment(pullRequest.number, { ...placement, body: text }, pending);
          await Promise.all([loadThreads(), loadDetails()]);
        },
        commentOnGitHubFile: async (path, text, pending) => {
          if (!diffPaths.includes(path)) throw new Error(`${path} is not part of this PR's changes.`);
          const base = await readBase();
          const anchor = fileAnchor(await readFile(join(folder, path), 'utf8'), { path, side: 'working', baseRevision: base });
          await provider.publishComment(pullRequest.number, { ...await placeComment(folder, base, anchor), body: text }, pending);
          await Promise.all([loadThreads(), loadDetails()]);
        },
        replyOnGitHub: async (id, text) => {
          await provider.replyToThread(id, text);
          await loadThreads();
        },
        askAboutGitHub: async (id, note, intent) => {
          const loaded = await (remote ?? loadThreads());
          const thread = loaded instanceof Error ? undefined : loaded.find((each) => each.id === id);
          if (thread === undefined) throw new Error('This GitHub thread no longer exists.');
          // An outdated thread's lines no longer hold its code, so its local thread is about the whole file.
          const wholeFile = thread.scope === 'file' || thread.outdated;
          const anchor = wholeFile
            ? fileAnchor(await readFile(join(folder, thread.path), 'utf8'), { path: thread.path, side: 'working', baseRevision: await readBase() })
            : (await pageAnchor({ path: thread.path, side: thread.side === 'LEFT' ? 'old' : 'new', startLine: thread.startLine, endLine: thread.endLine })).anchor;
          const comments = thread.comments.filter((comment) => comment.hidden === undefined);
          const earlier = thread.outdated && thread.scope !== 'file';
          const source = earlier ? `GitHub thread on lines ${thread.startLine}-${thread.endLine} of an earlier version of ${thread.path}; the code changed since` : undefined;
          const request = githubFeedbackRequest(note, intent, comments, source);
          const hunk = earlier && thread.diffHunk !== undefined ? `\n\nThe diff the comment was written on:\n\n\`\`\`\`diff\n${thread.diffHunk}\n\`\`\`\`` : '';
          const created = await opened.session.store.submit(anchor, request + hunk, intent);
          await opened.session.linkToGitHub?.(created.id, { id: thread.id, url: thread.url });
        },
        askAboutComment: async (id, note, intent) => {
          const comment = (await currentConversation()).timeline.find((item) => (item.kind === 'comment' || item.kind === 'review') && item.id === id);
          if (comment === undefined || comment.kind === 'commit' || comment.kind === 'event' || !comment.body.trim()) throw new Error('This comment no longer exists.');
          const request = githubFeedbackRequest(note, intent, [comment], 'GitHub PR comment');
          const created = await opened.session.store.submit(pullRequestAnchor(await readBase()), request, intent);
          await opened.session.linkToGitHub?.(created.id, { id: comment.id, url: comment.url ?? pullRequest.url });
        },
        resolveOnGitHub: async (id, resolved) => {
          await provider.resolveThread(id, resolved);
          written.expect(`resolved:${id}`, resolved);
          await loadThreads();
        },
        deleteOnGitHub: async (id) => {
          await provider.deleteComment(id);
          await Promise.all([loadThreads(), loadDetails()]);
        },
        setViewed: (path, viewed) => fileReviews.set(provider, repository, pullRequest.number, path, viewed),
        seeAnswers: async (ids) => {
          const answers = latestAnswers([{ key: opened.session.key, number: pullRequest.number, threads: opened.session.store.threads }], Infinity);
          await seenAnswers.see(answers.filter((answer) => ids.includes(answer.threadId)));
        },
        markRead: async (range, fileDone) => {
          if (!diffPaths.includes(range.path)) throw new Error(`${range.path} is not part of this PR's changes.`);
          if (selection.range.kind !== 'all') throw new Error('Show all changes to mark lines read.');
          await fileReviews.markRead(repository, pullRequest.number, await readBase(), range);
          if (fileDone) await fileReviews.set(provider, repository, pullRequest.number, range.path, true);
        },
        unmarkRead: (ids) => fileReviews.unmarkRead(repository, pullRequest.number, ids),
        openInEditor: (path) => openPullRequestFile(storageRoot, repository, current(), path),
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
        readCommit: async (oid) => {
          await haveCommit(oid);
          return readPullRequestDiff(folder, (await git(folder, ['rev-parse', `${oid}^`])).trim(), { to: oid });
        },
        push: async () => {
          if (opened.runner.activity.running) throw new Error('Claude is working on this PR. Push when it is done.');
          const loaded = await currentDetails();
          if (!loaded.canEdit) throw new Error('You cannot push to this PR.');
          await pushCommits(folder, { pushTo: pushTarget(loaded), headBranch: pullRequest.headBranch, hooksOff: role === 'reviewer' });
          changedOnGitHub();
        },
        retry: () => { opened.runner.retry(); },
        stopClaude: () => opened.runner.stop(),
        newConversation: async () => { notOnCheckout('New conversation'); await opened.runner.forget(); },
        compactConversation: async () => { notOnCheckout('Compact'); await opened.runner.compact(); },
        draftReply: async (id, notes) => {
          const thread = findThread(id);
          const linked = opened.session.linkedGitHubThread?.(thread.id);
          const loaded = linked === undefined ? [] : await (remote ?? loadThreads());
          const quoted = loaded instanceof Error ? [] : loaded.find((each) => each.id === linked)?.comments.filter((comment) => comment.hidden === undefined) ?? [];
          return runDraft(draftReplyTask(thread, quoted, notes));
        },
        draftGitHubReply: async (id, notes) => {
          const loaded = await (remote ?? loadThreads());
          const thread = loaded instanceof Error ? undefined : loaded.find((each) => each.id === id);
          if (thread === undefined) throw new Error('This GitHub thread no longer exists.');
          const lines = thread.scope === 'file' ? undefined : `${thread.path} lines ${thread.startLine}-${thread.endLine}`;
          // An outdated thread's lines no longer hold the code it was written on, so Claude gets none.
          const code = lines === undefined || thread.outdated ? undefined : await (thread.side === 'LEFT' ? readBaseContent(folder, thread.path, await readBase()) : readFile(join(folder, thread.path), 'utf8'))
            .then((content) => content.split('\n').slice(thread.startLine - 1, thread.endLine).join('\n'), () => undefined);
          const you = await (conversation ?? loadConversation());
          const comments = thread.comments.filter((comment) => comment.hidden === undefined).map(({ author, body }) => ({ author, body }));
          return runDraft(githubReplyTask({ location: lines ?? `the file ${thread.path}`, ...code === undefined ? {} : { code }, comments, ...you instanceof Error || !you.viewerLogin ? {} : { you: you.viewerLogin } }, notes));
        },
        revealThread: async (id) => {
          const { path, scope } = findThread(id).anchor;
          if (scope === 'pullRequest') { revealOpenPage(`${repository}#${pullRequest.number}`, { thread: id }); return; }
          if (selection.range.kind !== 'all') { await openPullRequestFile(storageRoot, repository, current(), path); return; }
          revealed.add(path);
          revealOpenPage(`${repository}#${pullRequest.number}`, { path, reload: true });
        },
        openFile: async (path) => {
          if (!isWorkspaceRelativePath(path)) throw new Error(`Unsupported file path: ${path}`);
          if (selection.range.kind !== 'all') { await openPullRequestFile(storageRoot, repository, current(), path); return; }
          revealed.add(path);
          revealOpenPage(pageKey, { path, reload: true });
        },
        closeFiles: async (paths) => { for (const path of paths) revealed.delete(path); },
        submitReview: async (event, body) => {
          await provider.submitReview(pullRequest.number, event, body);
          void loadDetails();
          void loadConversation();
          void loadThreads();
        },
        applySuggestion: async (id, message, option) => {
          const { anchor, messages } = findThread(id);
          const suggestion = parseSuggestions(messages[message]?.text ?? '')[option];
          if (suggestion === undefined || anchor.scope !== undefined) throw new Error('This suggestion no longer exists.');
          if (anchor.side !== 'working') throw new Error('Suggestions apply only to the PR\'s version of a file.');
          if (opened.runner.activity.running) throw new Error('Claude is working on this PR. Apply the suggestion when it is done.');
          const loaded = await currentDetails();
          const file = join(folder, anchor.path);
          let ahead = false;
          if (loaded.canEdit) {
            if ((await git(folder, ['status', '--porcelain', '--', anchor.path])).trim() !== '') throw new Error(`${anchor.path} has uncommitted changes. Commit or discard them first.`);
            // On your own checkout the suggestion becomes a local commit you push yourself, so the branch never moves under you.
            ahead = onCheckout !== undefined || (await syncKeepingLocalCommits(folder, pullRequest.number)).ahead;
          }
          const before = await readFile(file, 'utf8');
          const after = applySuggestion(before, anchor, suggestion);
          await writeFile(file, after);
          const commit = { path: anchor.path, message: 'Apply suggestion from code review', hooksOff: role === 'reviewer' };
          if (!loaded.canEdit) undo.set(id, { path: anchor.path, before, after });
          else if (ahead) await commitFiles(folder, commit);
          else {
            await commitAndPush(folder, { ...commit, pushTo: pushTarget(loaded), headBranch: pullRequest.headBranch });
            changedOnGitHub();
          }
          applied.set(id, { message, option, done: !loaded.canEdit ? 'applied' : ahead ? 'committed' : 'pushed' });
          detailsChanged.fire();
        },
        discardSuggestion: async (id) => {
          const change = undo.get(id);
          if (change === undefined) throw new Error('There is no applied suggestion to discard.');
          const file = join(folder, change.path);
          if (await readFile(file, 'utf8') !== change.after) throw new Error(`${change.path} changed since the suggestion was applied, so it was not discarded.`);
          await writeFile(file, change.before);
          undo.delete(id);
          applied.delete(id);
          detailsChanged.fire();
        },
        publishSuggestion: async (id, message, option) => {
          const { anchor, messages } = findThread(id);
          const suggestion = parseSuggestions(messages[message]?.text ?? '')[option];
          if (suggestion === undefined || anchor.scope !== undefined) throw new Error('This suggestion no longer exists.');
          if (anchor.side !== 'working') throw new Error('GitHub takes suggestions only on the PR\'s version of a file.');
          const head = await readHead();
          const lines = suggestionLines(await readGitBase(folder, anchor.path, head), anchor);
          await provider.publishComment(pullRequest.number, { path: anchor.path, body: suggestionMarkdown(suggestion), commitId: head, side: 'RIGHT', lines }, true);
          void loadThreads();
          void loadDetails();
        },
        fixConflicts: async (answer) => {
          notOnCheckout('Fix conflicts');
          const loaded = await currentDetails();
          if (loaded.mergeable !== 'no' || !loaded.canEdit) throw new Error('GitHub reports no conflicts you can fix on this PR.');
          const base = await prepareConflictFix(folder, pullRequest.number, baseBranch);
          const head = (await git(folder, ['rev-parse', 'HEAD'])).trim();
          conflictQuestion = undefined;
          const pushTo = pushTarget(loaded);
          const { error, reply } = await opened.runner.runTask(conflictTask({ base, baseBranch, headBranch: pullRequest.headBranch, pushTo, ...(answer === undefined ? {} : { answer }) }));
          const pushedNothing = (await git(folder, ['rev-parse', 'HEAD'])).trim() === head;
          if (error === undefined && pushedNothing && reply !== undefined) conflictQuestion = reply;
          changedOnGitHub();
          if (error !== undefined) throw new Error(`Claude did not fix the conflicts: ${error}`);
        },
        dismissConflictQuestion: () => {
          conflictQuestion = undefined;
          detailsChanged.fire();
        },
        merge: async (method, message, deleteBranch) => {
          const { branchDeletable } = await currentDetails();
          try {
            await provider.merge(pullRequest.number, method, message);
            await vscode.commands.executeCommand('diffGuide.markPullRequestMerged', `${repository}#${pullRequest.number}`);
            if (deleteBranch && branchDeletable) await provider.deleteBranch(pullRequest.headBranch);
          } finally {
            changedOnGitHub();
          }
        },
        editTitle: async (next) => {
          const { title } = await currentDetails();
          if (next === title) return;
          await provider.editPullRequest(pullRequest.number, { title: next });
          written.expect('title', next);
          changedOnGitHub();
        },
        editBody: async (body) => {
          await provider.editPullRequest(pullRequest.number, { body });
          void loadDetails();
        },
        pickerOptions: () => provider.pickerOptions(),
        pick: async (what, picked) => {
          try {
            await saveSelection(provider, pullRequest.number, await currentDetails(), what, picked);
          } finally {
            if (what === 'reviewers') changedOnGitHub(); else void loadDetails();
          }
        },
        setDraft: async (draft) => {
          await provider.setDraft(pullRequest.number, draft);
          written.expect('draft', draft);
          changedOnGitHub();
        },
        setOpen: async (open) => {
          await provider.editPullRequest(pullRequest.number, { state: open ? 'open' : 'closed' });
          written.expect('open', open);
          changedOnGitHub();
        },
        deleteBranch: async () => {
          await provider.deleteBranch(pullRequest.headBranch);
          void loadDetails();
        },
        removeWorktree: async () => {
          notOnCheckout('Remove worktree');
          await pullRequestSessions.close(repository, pullRequest.number);
          await removeWorktree(checkout.root, storageRoot, repository, pullRequest.number);
          void vscode.commands.executeCommand('diffGuide.refreshPullRequests');
        },
        refresh: () => { linkedRows = undefined; void loadDetails(); void loadThreads(); void loadConversation(); },
        openLinked: (key) => linked.open(key),
        pushLinked: async (key) => { await linked.push(key); changedLinks(); },
        draftLinked: async (key) => { const url = await linked.draft(key); changedLinks(); return url; },
        link: async (link) => { await linked.link(link); changedLinks(); },
        unlink: async (key) => { await linked.unlink(key); changedLinks(); },
        pollGitHub: async () => {
          const previous = version;
          version = await provider.version(pullRequest.number, previous);
          const reload = (previous !== undefined && version !== previous) || written.waiting;
          if (opened.runner.activity.running) return { reload, files: false };
          const before = await readHead();
          shownHead ??= before;
          let problem: string | undefined;
          const ahead = await git(folder, ['merge-base', '--is-ancestor', version.head, 'HEAD']).then(() => true, () => false);
          if (version.head !== before && !ahead && onCheckout !== undefined) {
            problem = `GitHub has commits on ${pullRequest.headBranch} that this checkout does not. Pull them to see them here.`;
          } else if (version.head !== before && !ahead) {
            await syncToPullRequestHead(folder, pullRequest.number, previous?.head).catch((error: unknown) => { problem = error instanceof Error ? error.message : String(error); });
          }
          const head = await readHead();
          const files = head !== shownHead;
          shownHead = head;
          return { reload: reload || files, files, ...(problem === undefined ? {} : { problem }) };
        },
        ...githubPageActions({
          provider, number: pullRequest.number, headBranch: pullRequest.headBranch, baseBranch: () => baseBranch, folder, hooksOff: role === 'reviewer', keepCheckout: onCheckout !== undefined,
          details: currentDetails, conversation: currentConversation,
          threads: async () => { const loaded = await loadThreads(); if (loaded instanceof Error) throw loaded; return loaded; },
          pushTarget, claudeBusy: () => opened.runner.activity.running,
          reload: (listed) => { if (listed === true) changedOnGitHub(); else { void loadDetails(); void loadConversation(); } void loadThreads(); },
          useBase: async (branch) => {
            await git(folder, ['fetch', '--quiet', 'origin', branch]).catch(() => undefined);
            baseBranch = branch;
          },
        }),
        analyze: async () => {
          const [files, head] = await Promise.all([readPullRequestDiff(folder, await readBase()), readHead()]);
          opened.analysis.start({
            files, head,
            about: `#${pullRequest.number} ${pullRequest.title} (${pullRequest.headBranch} into ${pullRequest.baseBranch})`,
            anchor: async ({ range }) => (await pageAnchor({ ...range, endLine: Math.min(range.endLine, range.startLine + 49) })).anchor,
          });
        },
        stopAnalysis: () => { opened.analysis.stop(); },
        review: async (picks) => {
          await savePicks(context.globalState, repository, picks);
          const files = await readPullRequestDiff(folder, await readBase());
          opened.review.start({
            files, reviewers: picks,
            about: `#${pullRequest.number} ${pullRequest.title} (${pullRequest.headBranch} into ${pullRequest.baseBranch})`,
            anchor: async (range) => (await pageAnchor(range)).anchor,
          });
        },
        stopReview: () => { opened.review.stop(); },
        pickReviewers: async (picks) => { await savePicks(context.globalState, repository, picks); detailsChanged.fire(); },
      }, context.extensionUri, reveal, undefined, onCheckout?.review.key);
    };
    const worktreesOf = (checkout: Checkout): PullRequestWorktrees => {
      const { root: checkoutRoot, storageRoot, sessions, fileReviews } = checkout;
      return {
        exists: (repository, number) => hasWorktree(storageRoot, repository, number),
        open: (provider, repository, pullRequest, role) => showOverview(checkout, provider, repository, pullRequest, role),
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
          if (opened === undefined) return undefined;
          const claude = agentStatus(opened.runner.activity).text;
          const background = backgroundStatus(opened.analysis.activity.running, opened.review.activity.running);
          return background === undefined ? claude : [claude === 'Claude idle' ? undefined : claude, background].filter(Boolean).join(' · ');
        },
        working: (repository, number) => {
          const opened = sessions.get(repository, number);
          return opened !== undefined && (opened.runner.activity.running || opened.analysis.activity.running || opened.review.activity.running);
        },
        localChanges: (repository, number, pushedHead) => localChanges(worktreePath(storageRoot, repository, number), pushedHead),
        reviewedFiles: (provider, repository, number, paths) => fileReviews.reviewed(provider, repository, number, paths),
        forget: () => { fileReviews.forget(); GitHubApiProvider.forget(); checkouts.rescan(); },
        showOverview: (provider, repository, pullRequest, role) => showOverview(checkout, provider, repository, pullRequest, role),
      };
    };
    const cleanUp = async (manual: boolean): Promise<void> => {
      const days = vscode.workspace.getConfiguration('diffGuide').get<number>('worktreeCleanupDays', 14);
      const results = await Promise.all((await checkouts.list()).map((checkout) => cleanUpWorktrees({
        root: checkout.root, storageRoot: checkout.storageRoot, connect: checkout.connect, remove: worktreesOf(checkout).remove,
      }, days)));
      const removed = results.flatMap((result) => result.removed);
      const kept = results.flatMap((result) => result.kept);
      if (removed.length > 0) {
        void vscode.window.showInformationMessage(`Removed worktrees of merged, closed or unused PRs: ${removed.join(', ')}`);
        void vscode.commands.executeCommand('diffGuide.refreshPullRequests');
      }
      if (!manual) return;
      if (kept.length > 0) void vscode.window.showInformationMessage(`Kept ${kept.join(', ')}: uncommitted changes or unpushed commits.`);
      else if (removed.length === 0) void vscode.window.showInformationMessage('No PR worktrees to clean up.');
    };
    if (!mockPullRequests()) void cleanUp(false).catch(() => undefined);
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
    /** Your open PR from a checkout's branch, and opening it in the checkout's local page tab. */
    const branchPullRequests = (session: LocalSession): BranchPullRequests => ({
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
    const localSessions = new LocalSessions(context, storage.fsPath, main, (session) => { session.review.usePullRequests(branchPullRequests(session)); });
    activeLocalSessions = localSessions;
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
    context.subscriptions.push(localSessions, ...registerLocalReview(context.workspaceState, localSessions, mainRoot, async () => listLocalCheckouts(await repositories()), openPullRequestCheckout, pullRequestThreads, pullRequestBusy, checkouts.onDidChangeState));
    void localSessions.restore(async (folder) => stat(folder).then((info) => info.isDirectory(), () => false));
    context.subscriptions.push(bridge, launchers, vscode.commands.registerCommand('diffGuide.showFocusedClaude', () => {
      const document = vscode.window.activeTextEditor?.document;
      const focused = document === undefined ? undefined : checkouts.forUri(document.uri);
      if (focused !== undefined) showClaude(focused);
    }));
    void checkouts.list().catch((error: unknown) => {
      void vscode.window.showErrorMessage(`DiffGuide could not restore pull request reviews: ${error instanceof Error ? error.message : String(error)}`);
    });
    await prepareConnection(context, bridge, storage.fsPath);
    const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 20);
    status.command = 'diffGuide.showFocusedClaude';
    const updateStatus = (): void => {
      const document = vscode.window.activeTextEditor?.document;
      const focused = document === undefined ? undefined : checkouts.forUri(document.uri);
      if (focused === undefined) {
        status.hide();
        return;
      }
      const current = agentStatus(focused.runner.activity);
      status.text = `$(${current.icon}) ${focused.session.label} · ${current.text}`;
      status.tooltip = current.retry ? `${focused.runner.activity.error ?? 'Some comments were not picked up.'} Click to send them again.` : `Show what Claude did for ${focused.session.label}`;
      status.show();
    };
    context.subscriptions.push(status, checkouts.onDidChangeState(updateStatus), vscode.window.onDidChangeActiveTextEditor(updateStatus));
    updateStatus();
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

/** The Git repository's top folder for `folder`, or undefined outside a repository. */
async function repositoryRoot(folder: string): Promise<string | undefined> {
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

/** Call `then` each time a Claude run ends, since Claude may have changed the PR on GitHub, such as its title with `gh pr edit`. */
function claudeFinished(runner: Pick<PullRequestSession['runner'], 'activity' | 'onDidChange'>, then: () => void): vscode.Disposable {
  let running = runner.activity.running;
  return runner.onDidChange(() => {
    if (running && !runner.activity.running) then();
    running = runner.activity.running;
  });
}

/** Open a PR's Claude log, and send comments again after a failed or skipped run. */
function showClaude({ runner, output }: PullRequestSession): void {
  if (agentStatus(runner.activity).retry) runner.retry();
  output.show(true);
}

/** Tell the user once per failed run why Claude did not answer, instead of leaving comments waiting silently. */
function reportClaudeFailures(sessions: Pick<Checkouts, 'onDidChangeState'>): vscode.Disposable {
  const reported = new WeakMap<PullRequestSession, string>();
  return sessions.onDidChangeState((opened) => {
    const { running, error, stopped } = opened.runner.activity;
    if (running || error === undefined || stopped === true) {
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
