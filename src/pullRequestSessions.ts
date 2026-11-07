import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import * as vscode from 'vscode';
import { createReviewBridge } from './bridge.js';
import { readCustomInstructions, type InstructionKind } from './customInstructions.js';
import type { CodeAnchor, ReviewBridge } from './contracts.js';
import { parsePullRequestFileUri, pullRequestFileUri } from './pullRequestDiff.js';
import { type CommentPlacement, placeComment, publishableText, readClaudeCommits, readGitHubLinks, readPublications, writeClaudeCommits, writeGitHubLinks, writePublications } from './pullRequestComments.js';
import type { PullRequestProvider } from './pullRequests.js';
import { showPublishPanel } from './publishPanel.js';
import type { ReviewSession, ReviewSessionSource } from './reviewSession.js';
import { ClaudeRunner, type ClaudeRunnerOptions } from './claudeRunner.js';
import { catchUpWithPullRequest, commitsSince, discardSince, worktreeSnapshot, type WorktreeCommit } from './conflicts.js';
import { PullRequestAnalysis } from './prAnalysisRunner.js';
import { requireNodeRuntime, resolveExecutable } from './executables.js';
import { prepareConnection } from './setup.js';
import { createReviewStore } from './store.js';
import { addWorked, crossReferences, ensureBranchWorktree, isWorktreeIdle, linkedBranchName, linkedWorktreePath, lockWorktree, readStoredLinks, writeStoredLinks } from './linkedChanges.js';
import { findLinked } from './linkedController.js';
import { createReviewData, ensureWorktree, git, listWorktrees, migrateWorktrees, readPullRequestBase, readWorktree, worktreePath } from './worktrees.js';

/** Another workspace repository Claude may change for a PR: where its worktrees live and how to reach its PRs. */
export interface WorkspaceRepository {
  readonly root: string;
  readonly storageRoot: string;
  readonly connect: () => Promise<PullRequestProvider>;
}

/** A PR's review: its comments, the bridge Claude replies through, and the background Claude that answers them. */
export interface PullRequestSession {
  readonly session: ReviewSession;
  readonly bridge: ReviewBridge;
  readonly runner: ClaudeRunner;
  /** Claude's guided-review analysis of the PR. */
  readonly analysis: PullRequestAnalysis;
  /** Full log of what Claude did for this PR. */
  readonly output: vscode.OutputChannel;
  /** Commits Claude made while answering a local thread, oldest first. */
  readonly commits: (threadId: string) => readonly WorktreeCommit[];
  /** Where this PR keeps manual links, unlinks and the repositories Claude worked in. */
  readonly dataPath: string;
  readonly worktree: string;
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
    /** Other repositories of the workspace by `owner/name`, which Claude reaches only through Pair Review worktrees. */
    private readonly repositories: () => Promise<ReadonlyMap<string, WorkspaceRepository>> = async () => new Map(),
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
    const stuck = await migrateWorktrees(this.sourceRoot, this.storageRoot);
    if (stuck.length > 0) {
      void vscode.window.showWarningMessage(`Pair Review could not move ${stuck.length === 1 ? 'a PR worktree' : `${stuck.length} PR worktrees`} out of the Git folder, so Claude cannot edit there: ${stuck.join(', ')}`);
    }
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
    const dataPath = await createReviewData(worktree);
    const store = await createReviewStore(join(dataPath, 'review.json'), worktree);
    const bridge = await createReviewBridge(store, join(dataPath, 'selected-session.json'), (name, purpose) => linkedRepository(name, purpose));
    try {
      await prepareConnection(this.context, bridge, dataPath);
    } catch (error: unknown) {
      bridge.dispose();
      throw error;
    }
    const publications = await readPublications(dataPath);
    const links = await readGitHubLinks(dataPath);
    const commits = await readClaudeCommits(dataPath);
    const publishing = new Map<string, vscode.WebviewPanel>();
    const output = vscode.window.createOutputChannel(`Claude · #${number}`);
    const configuration = vscode.workspace.getConfiguration('pairReview');
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
    /** The worktree before Claude's current run, to find its commits or undo its throwaway changes. */
    let before: Awaited<ReturnType<typeof worktreeSnapshot>> | undefined;
    const owner = `${repository}#${number}`;
    /** Locks this run holds: its own worktree, and linked worktrees Claude opened; released when the run ends. */
    const held = new Map<string, () => Promise<void>>();
    let stopping: AbortController | undefined;
    const hold = async (folder: string): Promise<void> => {
      if (held.has(folder)) return;
      held.set(folder, await lockWorktree(folder, owner, {
        ...(stopping === undefined ? {} : { signal: stopping.signal }),
        waiting: (holder) => { runner.wait(`Waiting for ${holder}`); },
      }));
    };
    const releaseAll = async (): Promise<void> => {
      const locks = [...held.values()];
      held.clear();
      await Promise.all(locks.map((unlock) => unlock().catch(() => undefined)));
    };
    /** Open a worktree of another workspace repository for Claude: the linked PR's, or this PR's own branch there. */
    /** GitHub mentions of this PR change only on GitHub, so one read per session is enough. */
    let mentions: Promise<readonly { readonly repository: string; readonly number: number }[]> | undefined;
    /**
     * The worktree of another workspace repository that goes with this PR. Reads get the linked PR's worktree, a worktree on a pinned branch,
     * or the user's own checkout when nothing links; edits get the linked PR's worktree or this PR's own branch there, and hold its lock.
     */
    const linkedRepository = async (name: string, purpose: 'read' | 'edit'): Promise<{ path: string; branch: string; pullRequest?: number; note?: string }> => {
      if (name.toLowerCase() === repository.toLowerCase()) throw new Error(`${name} is this PR's own repository; work in ${worktree}.`);
      const other = (await this.repositories()).get(name.toLowerCase());
      if (other === undefined) throw new Error(`${name} is not a repository in this workspace. Open a clone of it in the workspace folder first.`);
      if (purpose === 'edit' && metadata.role === 'reviewer') throw new Error('This is someone else\'s PR, so Claude only proposes changes. Show the change for that repository as a ```diff block instead.');
      const provider = await other.connect();
      mentions ??= this.connect().then((own) => own.crossReferences(number)).then((nodes) => crossReferences(nodes, repository), () => []);
      const base = async (): Promise<string> => await readPullRequestBase(worktree, metadata.pullRequest.baseBranch) ?? 'HEAD';
      const row = [...(await findLinked({ repository, folder: worktree, dataPath, base, mentions })).values()].find((each) => each.repository.toLowerCase() === name.toLowerCase());
      const ownBranch = linkedBranchName(metadata.pullRequest.headBranch);
      const linked = row?.number !== undefined ? await provider.pullRequest(row.number)
        : await provider.pullRequestForBranch(row?.branch ?? ownBranch) ?? (row?.branch === undefined ? undefined : await provider.pullRequestForBranch(ownBranch));
      const usable = linked !== undefined && (await provider.linkedState(linked.number).catch(() => undefined))?.state === 'open' ? linked : undefined;
      let result: { path: string; branch: string; pullRequest?: number; note?: string };
      if (usable !== undefined) {
        const path = await ensureWorktree(other.root, other.storageRoot, provider, name, usable, metadata.role);
        if (purpose === 'edit') await hold(path);
        if (await isWorktreeIdle(path, held.has(path)) && !await catchUpWithPullRequest(path, usable.number)) log(`Could not bring ${name}#${usable.number}'s worktree to its latest commit.`);
        result = { path, branch: usable.headBranch, pullRequest: usable.number };
      } else if (purpose === 'read' && row?.branch !== undefined) {
        const path = linkedWorktreePath(other.storageRoot, name, { repository, number });
        result = { path, branch: await ensureBranchWorktree(other.root, path, row.branch, 'read') };
      } else if (purpose === 'read') {
        const branch = (await git(other.root, ['rev-parse', '--abbrev-ref', 'HEAD']).catch(() => '')).trim() || 'unknown';
        const existing = linkedWorktreePath(other.storageRoot, name, { repository, number });
        if (await stat(existing).then(() => true, () => false)) result = { path: existing, branch: (await git(existing, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim() };
        else result = { path: other.root, branch, note: `Nothing links ${name} to this PR, so this is the user's own checkout on ${branch}, which may not match what this PR needs. Read only; never edit or run git commands that change it.` };
      } else {
        const path = linkedWorktreePath(other.storageRoot, name, { repository, number });
        result = { path, branch: await ensureBranchWorktree(other.root, path, ownBranch) };
      }
      if (purpose === 'edit') {
        await hold(result.path);
        await writeStoredLinks(dataPath, addWorked(await readStoredLinks(dataPath), name));
      }
      log(`Gave Claude ${name} to ${purpose} at ${result.path} (${result.branch})`);
      return result;
    };
    const runner = new ClaudeRunner({
      store, cwd: worktree, dataPath, role: metadata.role, log, resolve, instructions: instructions('comments'),
      folders: async () => [...new Set([this.sourceRoot, ...[...(await this.repositories()).values()].map((other) => other.root)])],
      readOnly: async () => ({
        folders: [...new Set([this.sourceRoot, ...[...(await this.repositories()).values()].map((other) => other.root)])],
        guard: join(this.context.extensionPath, 'dist', 'edit-guard.cjs'),
        node: await resolveExecutable(configuration.get<string>('nodePath', 'node'), worktree),
      }),
      hold: async () => {
        stopping = new AbortController();
        await hold(worktree);
      },
      prepare: async () => {
        if (!await catchUpWithPullRequest(worktree, number)) log('Could not reach GitHub for the PR\'s latest commit; Claude works on the worktree as it is.');
        before = await worktreeSnapshot(worktree);
      },
      stopped: () => { stopping?.abort(); },
      released: releaseAll,
      finish: async (threads) => {
        const start = before;
        before = undefined;
        if (start === undefined) return;
        if (metadata.role === 'reviewer') {
          if (start.clean) await discardSince(worktree, start.head);
          else log('Kept the worktree as it is: it had uncommitted changes before Claude started.');
          return;
        }
        const made = await commitsSince(worktree, start.head).catch(() => []);
        if (made.length === 0) return;
        for (const threadId of threads) commits.set(threadId, [...commits.get(threadId) ?? [], ...made]);
        await writeClaudeCommits(dataPath, commits);
      },
      ...this.claude,
    });
    const analysis = new PullRequestAnalysis({ store, cwd: worktree, dataPath, role: metadata.role, log, resolve, instructions: instructions('guide'), ...this.claude });
    const record = async (threadId: string, url: string, pending: boolean): Promise<void> => {
      publications.set(threadId, { url, pending });
      await writePublications(dataPath, publications);
      this.#stateChanged.fire(result);
      void vscode.window.showInformationMessage(pending ? 'Added to your pending review on GitHub.' : 'Posted on GitHub.', 'Open')
        .then((choice) => { if (choice !== undefined) void vscode.env.openExternal(vscode.Uri.parse(url)); });
    };
    const place = async (anchor: CodeAnchor): Promise<CommentPlacement> => {
      const base = await readPullRequestBase(worktree, metadata.pullRequest.baseBranch);
      if (base === undefined) throw new Error(`Could not find where #${number} branched off ${metadata.pullRequest.baseBranch}.`);
      return placeComment(worktree, base, anchor);
    };
    const commentOnDiff = async (threadId: string, placement: CommentPlacement, body: string, pending: boolean): Promise<void> => {
      const url = await (await this.connect()).publishComment(number, { ...placement, body }, pending);
      await record(threadId, url, pending);
    };
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
        const { running, step, threads, error, skipped, stopped } = runner.activity;
        if (!threads.has(threadId)) return undefined;
        if (running) return `Claude · ${step ?? 'Working'}`;
        if (stopped === true) return 'Stopped';
        if (error !== undefined) return `Claude failed · ${error}`;
        const waiting = skipped > 0 && store.pendingEvents.some((event) => event.threadId === threadId);
        return waiting && stopped === true ? 'Stopped' : waiting ? 'Not picked up by Claude' : undefined;
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
        const { startLine, endLine, path } = thread.anchor;
        const lines = lineLabel(thread.anchor);
        const text = publishableText(thread);
        const link = links.get(threadId);
        if (link !== undefined) {
          const panel = showPublishPanel({ title: `#${number} · ${path}:${lines}`, placement: 'Reply in the GitHub thread', body: text, reply: true }, async (body) => {
            await (await this.connect()).replyToThread(link.id, body);
            await record(threadId, link.url, false);
          });
          publishing.set(threadId, panel);
          panel.onDidDispose(() => { publishing.delete(threadId); });
          return;
        }
        const placement = await place(thread.anchor);
        const panel = showPublishPanel({
          title: thread.anchor.scope === 'file' ? `#${number} · ${path}` : `#${number} · ${path}:${lines}`,
          placement: thread.anchor.scope === 'file' ? 'Whole file' : placement.lines === undefined ? `Whole file: line ${lines} is outside the PR diff` : `${endLine === startLine ? 'Line' : 'Lines'} ${lines}`,
          body: `${outsideDiff(thread.anchor, placement)}${text}`,
        }, (body, pending) => commentOnDiff(threadId, placement, body, pending));
        publishing.set(threadId, panel);
        panel.onDidDispose(() => { publishing.delete(threadId); });
      },
      postToGitHub: async (threadId, body, pending) => {
        const thread = store.threads.find((candidate) => candidate.id === threadId);
        if (thread === undefined) throw new Error('This thread no longer exists.');
        const placement = await place(thread.anchor);
        await commentOnDiff(threadId, placement, `${outsideDiff(thread.anchor, placement)}${body}`, pending);
      },
      linkToGitHub: async (threadId, link) => {
        links.set(threadId, link);
        await writeGitHubLinks(dataPath, links);
      },
      linkedGitHubThread: (threadId) => links.get(threadId)?.id,
    };
    const result: PullRequestSession = { session, bridge, runner, analysis, output, commits: (threadId) => commits.get(threadId) ?? [], dataPath, worktree };
    return result;
  }
}

/** "Line 12:" before a line comment GitHub can only take on the whole file; nothing for a whole-file thread or one on its lines. */
function outsideDiff(anchor: CodeAnchor, placement: CommentPlacement): string {
  return anchor.scope === 'file' || placement.lines !== undefined ? '' : `Line ${lineLabel(anchor)}:\n\n`;
}

/** Such as "12" or "12–14". */
function lineLabel({ startLine, endLine }: CodeAnchor): string {
  return endLine === startLine ? `${startLine}` : `${startLine}–${endLine}`;
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
