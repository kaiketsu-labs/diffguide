import { isAbsolute, relative, sep } from 'node:path';
import * as vscode from 'vscode';
import type { FileReviews } from './reviewedFiles.js';
import type { PullRequestProvider } from './pullRequests.js';
import type { PullRequestSession, PullRequestSessions } from './pullRequestSessions.js';
import type { ReviewSession, ReviewSessionSource } from './reviewSession.js';
import { hasWorktree, repositoryStorage } from './worktrees.js';

/** One local Git repository whose pull requests can be reviewed, with its own PR worktrees and sessions. */
export interface Checkout {
  readonly root: string;
  readonly storageRoot: string;
  readonly connect: () => Promise<PullRequestProvider>;
  readonly sessions: PullRequestSessions;
  readonly fileReviews: FileReviews;
}

/** How a checkout's parts are found and built, kept injectable for tests. */
export interface CheckoutOptions {
  /** Root folders of Git repositories VS Code found, in any order. */
  readonly discover: () => Promise<readonly string[]>;
  /** Storage for PR worktrees of a repository, or undefined when it is not a Git repository. */
  readonly storage?: (root: string) => Promise<string | undefined>;
  readonly create: (root: string, storageRoot: string) => Checkout;
  readonly onRestoreError: (error: unknown) => void;
}

/** PR checkouts for the workspace folder and the Git repositories nested inside it. */
export class Checkouts implements ReviewSessionSource, vscode.Disposable {
  readonly #changed = new vscode.EventEmitter<void>();
  readonly onDidChange = this.#changed.event;
  readonly #stateChanged = new vscode.EventEmitter<PullRequestSession>();
  /** Fires when a PR's comments or Claude activity change, in any checkout. */
  readonly onDidChangeState = this.#stateChanged.event;
  readonly onDidChangeActivity = this.#stateChanged.event;
  readonly #reviewsChanged = new vscode.EventEmitter<void>();
  /** Fires when a file is ticked or unticked as reviewed, in any checkout. */
  readonly onDidChangeReviewedFiles = this.#reviewsChanged.event;
  readonly #byStorage = new Map<string, Checkout>();
  readonly #storage = new Map<string, Promise<string | undefined>>();
  readonly #subscriptions: vscode.Disposable[] = [];

  /** `fallbackStorage` keeps PR worktrees when the workspace folder itself is not a Git repository. */
  constructor(private readonly workspaceRoot: string, private readonly fallbackStorage: string, private readonly options: CheckoutOptions) {}

  get sessions(): readonly ReviewSession[] {
    return [...this.#byStorage.values()].flatMap((checkout) => checkout.sessions.sessions);
  }

  /** The workspace folder first, then nested repositories by path; worktrees of one repository count once. */
  async list(): Promise<readonly Checkout[]> {
    const nested = (await this.options.discover()).filter((root) => isNested(this.workspaceRoot, root)).sort();
    const candidates = await Promise.all([this.workspaceRoot, ...nested].map(async (root) => ({
      root, storageRoot: await this.#storageOf(root) ?? (root === this.workspaceRoot ? this.fallbackStorage : undefined),
    })));
    const listed = new Map<string, Checkout>();
    for (const { root, storageRoot } of candidates) {
      if (storageRoot === undefined || listed.has(storageRoot)) continue;
      listed.set(storageRoot, this.#checkout(root, storageRoot));
    }
    return [...listed.values()];
  }

  /** The checkout that holds a PR's worktree, if any. */
  async locate(repository: string, number: number): Promise<Checkout | undefined> {
    for (const checkout of await this.list()) {
      if (await hasWorktree(checkout.storageRoot, repository, number)) return checkout;
    }
    return undefined;
  }

  /** Session that owns a PR file document, if it is open. */
  forUri(uri: vscode.Uri): PullRequestSession | undefined {
    for (const checkout of this.#byStorage.values()) {
      const found = checkout.sessions.forUri(uri);
      if (found !== undefined) return found;
    }
    return undefined;
  }

  /** Flush every PR's comments before the extension unloads. */
  async flush(): Promise<void> {
    await Promise.all([...this.#byStorage.values()].map((checkout) => checkout.sessions.flush()));
  }

  dispose(): void {
    for (const subscription of this.#subscriptions) subscription.dispose();
    for (const checkout of this.#byStorage.values()) {
      checkout.sessions.dispose();
      checkout.fileReviews.dispose();
    }
    this.#byStorage.clear();
    this.#changed.dispose();
    this.#stateChanged.dispose();
    this.#reviewsChanged.dispose();
  }

  #storageOf(root: string): Promise<string | undefined> {
    let found = this.#storage.get(root);
    if (found === undefined) {
      found = (this.options.storage ?? repositoryStorage)(root).catch(() => undefined);
      this.#storage.set(root, found);
    }
    return found;
  }

  /** Build a checkout once and bring back the PR reviews it created earlier. */
  #checkout(root: string, storageRoot: string): Checkout {
    const known = this.#byStorage.get(storageRoot);
    if (known !== undefined) return known;
    const checkout = this.options.create(root, storageRoot);
    this.#byStorage.set(storageRoot, checkout);
    this.#subscriptions.push(
      checkout.sessions.onDidChange(() => { this.#changed.fire(); }),
      checkout.sessions.onDidChangeState((session) => { this.#stateChanged.fire(session); }),
      checkout.fileReviews.onDidChange(() => { this.#reviewsChanged.fire(); }),
    );
    void checkout.sessions.restore().catch(this.options.onRestoreError);
    return checkout;
  }
}

/** Whether `root` lies inside the workspace folder and not inside a Git folder, where PR worktrees live. */
function isNested(workspaceRoot: string, root: string): boolean {
  const inside = relative(workspaceRoot, root);
  return inside !== '' && !inside.startsWith('..') && !isAbsolute(inside) && !inside.split(sep).includes('.git');
}

/** Root folders of the Git repositories VS Code's Git extension opened, once its first scan is done. */
export async function gitRepositoryRoots(): Promise<readonly string[]> {
  const extension = vscode.extensions.getExtension<GitExtension>('vscode.git');
  if (extension === undefined || !vscode.workspace.getConfiguration('git').get('enabled', true)) return [];
  const git = (extension.isActive ? extension.exports : await extension.activate()).getAPI(1);
  if (git.state !== 'initialized') {
    await new Promise<void>((resolve) => {
      const listener = git.onDidChangeState((state) => {
        if (state !== 'initialized') return;
        listener.dispose();
        resolve();
      });
    });
  }
  return git.repositories.map((repository) => repository.rootUri.fsPath);
}

/** The part of VS Code's Git extension API used here. */
interface GitExtension {
  getAPI(version: 1): {
    readonly state: 'uninitialized' | 'initialized';
    readonly onDidChangeState: vscode.Event<'uninitialized' | 'initialized'>;
    readonly repositories: readonly { readonly rootUri: vscode.Uri }[];
  };
}
