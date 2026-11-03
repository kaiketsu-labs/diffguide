import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import * as vscode from 'vscode';
import { createReviewBridge } from './bridge.js';
import { readCustomInstructions, type InstructionKind } from './customInstructions.js';
import type { ReviewBridge } from './contracts.js';
import { parsePullRequestFileUri, pullRequestFileUri } from './pullRequestDiff.js';
import { placeComment, readPublications, writePublications } from './pullRequestComments.js';
import type { PullRequestProvider } from './pullRequests.js';
import { showPublishPanel } from './publishPanel.js';
import type { ReviewSession, ReviewSessionSource } from './reviewSession.js';
import { ClaudeRunner, type ClaudeRunnerOptions } from './claudeRunner.js';
import { PullRequestAnalysis } from './prAnalysisRunner.js';
import { requireNodeRuntime, resolveExecutable } from './executables.js';
import { prepareConnection } from './setup.js';
import { createReviewStore } from './store.js';
import { listWorktrees, readPullRequestBase, readWorktree, reviewDataPath, worktreePath } from './worktrees.js';

/** A PR's review: its comments, the bridge Claude replies through, and the background Claude that answers them. */
export interface PullRequestSession {
  readonly session: ReviewSession;
  readonly bridge: ReviewBridge;
  readonly runner: ClaudeRunner;
  /** Claude's guided-review analysis of the PR. */
  readonly analysis: PullRequestAnalysis;
  /** Full log of what Claude did for this PR. */
  readonly output: vscode.OutputChannel;
}

/** Review sessions for the PR worktrees of one checkout, opened on demand and restored on startup. */
export class PullRequestSessions implements ReviewSessionSource, vscode.Disposable {
  readonly #changed = new vscode.EventEmitter<void>();
  readonly onDidChange = this.#changed.event;
  readonly #stateChanged = new vscode.EventEmitter<PullRequestSession>();
  /** Fires when a PR's comments or Claude activity change. */
  readonly onDidChangeState = this.#stateChanged.event;
  readonly onDidChangeActivity = this.#stateChanged.event;
  readonly #watchers = new Map<string, vscode.Disposable>();
  readonly #open = new Map<string, Promise<PullRequestSession>>();
  readonly #ready = new Map<string, PullRequestSession>();

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly storageRoot: string,
    private readonly sourceRoot: string,
    /** The code host that published threads go to. */
    private readonly connect: () => Promise<PullRequestProvider>,
    /** Replaces how Claude is found and started, for tests. */
    private readonly claude: Partial<Pick<ClaudeRunnerOptions, 'resolve' | 'spawn'>> = {},
  ) {}

  get sessions(): readonly ReviewSession[] {
    return [...this.#ready.values()].map(({ session }) => session);
  }

  /** Session that owns a PR file document, if it is open. */
  forUri(uri: vscode.Uri): PullRequestSession | undefined {
    const address = parsePullRequestFileUri(uri);
    return address === undefined ? undefined : this.#ready.get(key(address.repository, address.number));
  }

  /** The open session of a PR, if any. */
  get(repository: string, number: number): PullRequestSession | undefined {
    return this.#ready.get(key(repository, number));
  }

  /** Open the session for a PR whose worktree exists; repeated calls share one session. */
  open(repository: string, number: number): Promise<PullRequestSession> {
    const id = key(repository, number);
    let pending = this.#open.get(id);
    if (pending === undefined) {
      pending = this.#create(repository, number);
      this.#open.set(id, pending);
      const opening = pending;
      opening.then((session) => {
        if (this.#open.get(id) !== opening) {
          release(session);
          return;
        }
        this.#ready.set(id, session);
        const fire = (): void => { this.#stateChanged.fire(session); };
        this.#watchers.set(id, vscode.Disposable.from(session.session.store.onChange(fire), session.runner.onDidChange(fire), session.analysis.onDidChange(fire)));
        this.#changed.fire();
        fire();
      }, () => { if (this.#open.get(id) === opening) this.#open.delete(id); });
    }
    return pending;
  }

  /** Reopen sessions for worktrees this checkout created earlier, so their comments come back. */
  async restore(): Promise<void> {
    for (const { metadata } of await listWorktrees(this.storageRoot, this.sourceRoot)) {
      await this.open(metadata.repository, metadata.pullRequest.number);
    }
  }

  /** Stop a PR's connection and save its comments before its worktree goes away. */
  async close(repository: string, number: number): Promise<void> {
    const id = key(repository, number);
    const pending = this.#open.get(id);
    this.#open.delete(id);
    this.#ready.delete(id);
    this.#watchers.get(id)?.dispose();
    this.#watchers.delete(id);
    if (pending === undefined) return;
    const closing = await pending.catch(() => undefined);
    if (closing === undefined) return;
    release(closing);
    await closing.session.store.flush();
    this.#changed.fire();
  }

  dispose(): void {
    for (const session of this.#ready.values()) release(session);
    for (const watcher of this.#watchers.values()) watcher.dispose();
    this.#watchers.clear();
    this.#ready.clear();
    this.#open.clear();
    this.#changed.dispose();
    this.#stateChanged.dispose();
  }

  /** Flush every PR's comments before the extension unloads. */
  async flush(): Promise<void> {
    await Promise.all([...this.#ready.values()].map(({ session }) => session.store.flush()));
  }

  async #create(repository: string, number: number): Promise<PullRequestSession> {
    const worktree = worktreePath(this.storageRoot, repository, number);
    const metadata = await readWorktree(this.storageRoot, worktree);
    if (metadata === undefined) throw new Error(`#${number} has no worktree.`);
    const dataPath = reviewDataPath(worktree);
    await mkdir(dataPath, { recursive: true, mode: 0o700 });
    const store = await createReviewStore(join(dataPath, 'review.json'), worktree);
    const bridge = await createReviewBridge(store, join(dataPath, 'selected-session.json'));
    try {
      await prepareConnection(this.context, bridge, dataPath);
    } catch (error: unknown) {
      bridge.dispose();
      throw error;
    }
    const publications = await readPublications(dataPath);
    const publishing = new Map<string, vscode.WebviewPanel>();
    const output = vscode.window.createOutputChannel(`Claude · #${number}`);
    const configuration = vscode.workspace.getConfiguration('localReview');
    const log = (line: string): void => { output.appendLine(`[${new Date().toLocaleTimeString()}] ${line}`); };
    const resolve: ClaudeRunnerOptions['resolve'] = async () => {
      const claudePath = configuration.get<string>('claudePath', 'claude');
      const shell = loginShell();
      const [executable, nodePath] = await Promise.all([
        shell === undefined ? resolveExecutable(claudePath, worktree) : claudePath,
        resolveExecutable(configuration.get<string>('nodePath', 'node'), worktree),
      ]);
      await requireNodeRuntime(nodePath);
      const mcpPath = (await prepareConnection(this.context, bridge, dataPath, nodePath)).mcpPath;
      return shell === undefined ? { executable, mcpPath } : { executable, mcpPath, shell };
    };
    const instructions = (kind: InstructionKind) => async (): Promise<string> => {
      const revision = metadata.role === 'reviewer' ? await readPullRequestBase(worktree, metadata.pullRequest.baseBranch) : undefined;
      if (metadata.role === 'reviewer' && revision === undefined) log('Skipping the repository\'s review instructions: could not find the base branch.');
      return readCustomInstructions(kind, { projectRoot: this.sourceRoot, repository: { cwd: worktree, ...(revision === undefined ? {} : { revision }) } });
    };
    const runner = new ClaudeRunner({ store, cwd: worktree, dataPath, role: metadata.role, log, resolve, instructions: instructions('ask'), ...this.claude });
    const analysis = new PullRequestAnalysis({ store, cwd: worktree, dataPath, role: metadata.role, log, resolve, instructions: instructions('analysis'), ...this.claude });
    const session: ReviewSession = {
      key: key(repository, number),
      label: `#${number}`,
      store,
      resolveBase: () => readPullRequestBase(worktree, metadata.pullRequest.baseBranch),
      locate: (uri) => {
        const address = parsePullRequestFileUri(uri);
        if (address === undefined || address.repository !== repository || address.number !== number) return undefined;
        return address.revision === undefined
          ? { path: address.relativePath, original: false }
          : { path: address.relativePath, original: true, revision: address.revision };
      },
      workingUri: (relativePath) => pullRequestFileUri({ repository, number, relativePath }),
      originalUri: (relativePath, revision) => pullRequestFileUri({ repository, number, relativePath, revision }),
      activity: (threadId) => {
        const { running, step, threads, error, skipped } = runner.activity;
        if (!threads.has(threadId)) return undefined;
        if (running) return `Claude · ${step ?? 'Working'}`;
        if (error !== undefined) return `Claude failed · ${error}`;
        return skipped > 0 && store.pendingEvents.some((event) => event.threadId === threadId) ? 'Not picked up by Claude' : undefined;
      },
      publication: (threadId) => publications.get(threadId),
      publish: async (threadId) => {
        const thread = store.threads.find((candidate) => candidate.id === threadId);
        if (thread === undefined) return;
        const published = publications.get(threadId);
        if (published !== undefined) {
          await vscode.env.openExternal(vscode.Uri.parse(published.url));
          return;
        }
        const open = publishing.get(threadId);
        if (open !== undefined) {
          open.reveal();
          return;
        }
        const base = await readPullRequestBase(worktree, metadata.pullRequest.baseBranch);
        if (base === undefined) throw new Error(`Could not find where #${number} branched off ${metadata.pullRequest.baseBranch}.`);
        const placement = await placeComment(worktree, base, thread.anchor);
        const { startLine, endLine, path } = thread.anchor;
        const lines = endLine === startLine ? `${startLine}` : `${startLine}–${endLine}`;
        const answer = [...thread.messages].reverse().find((message) => message.author === 'claude') ?? thread.messages[0];
        const panel = showPublishPanel({
          title: `#${number} · ${path}:${lines}`,
          placement: placement.lines === undefined ? `Whole file: line ${lines} is outside the PR diff` : `${endLine === startLine ? 'Line' : 'Lines'} ${lines}`,
          body: `${placement.lines === undefined ? `Line ${lines}:\n\n` : ''}${answer?.text ?? ''}`,
        }, async (body, pending) => {
          const url = await (await this.connect()).publishComment(number, { ...placement, body }, pending);
          publications.set(threadId, { url, pending });
          await writePublications(dataPath, publications);
          this.#stateChanged.fire(result);
          void vscode.window.showInformationMessage(pending ? 'Added to your pending review on GitHub.' : 'Posted on GitHub.', 'Open')
            .then((choice) => { if (choice !== undefined) void vscode.env.openExternal(vscode.Uri.parse(url)); });
        });
        publishing.set(threadId, panel);
        panel.onDidDispose(() => { publishing.delete(threadId); });
      },
    };
    const result: PullRequestSession = { session, bridge, runner, analysis, output };
    return result;
  }
}

/** Stop a PR's Claude and its connection. */
function release({ runner, analysis, bridge, output }: PullRequestSession): void {
  runner.dispose();
  analysis.dispose();
  bridge.dispose();
  output.dispose();
}

/** The user's login shell, when it is one Claude can be started through like in a terminal. */
function loginShell(): string | undefined {
  const shell = process.env['SHELL'];
  return shell !== undefined && /\/(zsh|bash)$/u.test(shell) ? shell : undefined;
}

/** Identify a PR across repositories. */
function key(repository: string, number: number): string {
  return `${repository}#${number}`;
}
