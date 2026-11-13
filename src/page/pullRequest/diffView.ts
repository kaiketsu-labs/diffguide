import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { anchorFromText } from '../../core/anchors.js';
import { prepareHighlighting } from '../../core/codePreview.js';
import type { CodeAnchor } from '../../core/contracts.js';
import type { ChangeRequestSummary } from '../../core/forge.js';
import { isWorkspaceRelativePath } from '../../core/git/git.js';
import { git, readPullRequestBase } from '../../core/git/worktrees.js';
import { type FileDiff, readPullRequestDiff, savedCodeDiff } from '../../core/unifiedDiff.js';
import type { DiffSelection, FilesView, PageComment } from '../protocol.js';
import type { PullRequestPage } from './context.js';

/** What the Files tab shows: which commits, against which base, and the files outside the diff the page shows whole. */
export class DiffView {
  /** The base branch, which the page can change. */
  baseBranch: string;
  #selection: DiffSelection = { range: { kind: 'all' }, whitespace: false };
  /** Comments and read marks need the whole PR at its latest version. */
  #atHead = true;
  #paths: readonly string[] = [];
  /** The merge base the shown files were read against, while they show all changes. */
  #shownBase: string | undefined;
  /** Changed files from the latest diff read, so media previews need no second read. */
  #files: readonly FileDiff[] = [];

  constructor(private readonly page: PullRequestPage, private readonly lastReviewedCommit: () => Promise<string | undefined>) {
    this.baseBranch = page.pullRequest.baseBranch;
  }

  get selection(): DiffSelection { return this.#selection; }
  get atHead(): boolean { return this.#atHead; }
  get paths(): readonly string[] { return this.#paths; }
  get files(): readonly FileDiff[] { return this.#files; }

  current(): ChangeRequestSummary {
    return { ...this.page.pullRequest, baseBranch: this.baseBranch };
  }

  async readBase(): Promise<string> {
    const base = await readPullRequestBase(this.page.folder, this.baseBranch);
    if (base === undefined) throw new Error(`Could not find where #${this.page.pullRequest.number} branched off ${this.baseBranch}.`);
    return base;
  }

  /** Whether the base moved since the shown files were read, such as after fetching a moved or retargeted base branch. */
  async baseChanged(): Promise<boolean> {
    const shown = this.#shownBase;
    return shown !== undefined && await this.readBase().catch(() => shown) !== shown;
  }

  async readHead(): Promise<string> {
    return (await git(this.page.folder, ['rev-parse', 'HEAD'])).trim();
  }

  /** A commit the diff needs, fetched when a force push left it out of the worktree. */
  async haveCommit(oid: string): Promise<void> {
    const { folder } = this.page;
    if (await git(folder, ['cat-file', '-e', `${oid}^{commit}`]).then(() => true, () => false)) return;
    await git(folder, ['fetch', '--quiet', 'origin', oid]).catch(() => { throw new Error('That commit is no longer on GitHub, probably after a force push.'); });
  }

  /** Refuses a path outside the PR's changes. */
  requireInDiff(path: string): void {
    if (!this.#paths.includes(path)) throw new Error(`${path} is not part of this PR's changes.`);
  }

  async anchor({ path, side, startLine, endLine }: Omit<PageComment, 'text' | 'intent'>): Promise<{ anchor: CodeAnchor; base: string }> {
    this.requireInDiff(path);
    if (!this.#atHead || (side === 'old' && this.#selection.range.kind !== 'all')) throw new Error('Show all changes to comment on these lines.');
    const base = await this.readBase();
    const { folder, host } = this.page;
    const content = side === 'old' ? await host.readBaseContent(folder, path, base) : await readFile(join(folder, path), 'utf8');
    const anchor = anchorFromText(content, { path, startLine, endLine, side: side === 'old' ? 'original' : 'working', baseRevision: base });
    return { anchor, base };
  }

  async read(select?: DiffSelection): Promise<FilesView> {
    const { folder, host } = this.page;
    const wanted = select ?? this.#selection;
    const { range } = wanted;
    let base: string;
    let to: string | undefined;
    if (range.kind === 'all') base = await this.readBase();
    else if (range.kind === 'since') {
      const since = await this.lastReviewedCommit();
      if (since === undefined) throw new Error('You have not reviewed this PR yet.');
      await this.haveCommit(since);
      base = since;
    } else {
      await this.haveCommit(range.from);
      await this.haveCommit(range.to);
      base = (await git(folder, ['rev-parse', `${range.from}^`])).trim();
      to = range.to === await this.readHead() ? undefined : range.to;
    }
    const files = await readPullRequestDiff(folder, base, { ...to === undefined ? {} : { to }, ignoreWhitespace: wanted.whitespace });
    this.#selection = wanted;
    this.#atHead = to === undefined;
    this.#paths = files.map((file) => file.path);
    this.#files = files;
    this.#shownBase = range.kind === 'all' ? base : undefined;
    const [whole, repositoryFiles] = await Promise.all([range.kind === 'all' ? this.#threadFiles(this.#paths) : [], host.listRepositoryFiles(folder).catch(() => [])]);
    const icons = await host.fileIcons([...new Set([...repositoryFiles, ...this.#paths, ...whole.map((file) => file.path)])]).catch(() => undefined);
    return { files: [...files, ...whole], repositoryFiles, selection: this.#selection, atHead: this.#atHead, ...icons === undefined ? {} : { icons } };
  }

  /** Files outside the diff with Local threads, shown whole after the changes, or as their saved code once the file is gone. */
  async #threadFiles(shown: readonly string[]): Promise<FileDiff[]> {
    const { folder, host, opened, revealed } = this.page;
    const threads = opened.session.store.threads;
    const paths = [...new Set([...threads.filter((thread) => !thread.resolved).map((thread) => thread.anchor.path), ...revealed])]
      .filter((path) => isWorkspaceRelativePath(path) && !shown.includes(path));
    await prepareHighlighting(paths);
    return Promise.all(paths.map(async (path) => await host.wholeFile(folder, path, 'unchanged')
      ?? savedCodeDiff(path, threads.filter((thread) => thread.anchor.path === path).map((thread) => thread.anchor))));
  }
}
