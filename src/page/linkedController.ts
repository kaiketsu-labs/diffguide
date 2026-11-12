import { stat } from 'node:fs/promises';
import { pushCommits } from '../core/conflicts.js';
import type { PullRequestLink, PullRequestProvider, PullRequestSummary, WorkspaceRepository } from '../core/forge.js';
import { git, worktreePath } from '../core/git/worktrees.js';
import { addedLines, addLink, branchPins, crossReferences, linkedBranchName, linkedWorktreePath, linkKey, type LinkSource, lockWorktree, readStoredLinks, removeLink, writeStoredLinks } from '../core/linkedChanges.js';
import type { LinkedChange } from './protocol.js';

/** What the Linked changes card needs from the PR whose page shows it. */
export interface LinkedContext {
  readonly repository: string;
  readonly pullRequest: PullRequestSummary;
  readonly provider: PullRequestProvider;
  /** The PR's own worktree, whose diff may pin other repositories' branches. */
  readonly folder: string;
  readonly base: () => Promise<string>;
  readonly dataPath: string;
  readonly repositories: () => Promise<ReadonlyMap<string, WorkspaceRepository>>;
  /** Open another workspace repository's PR on its own review page. */
  readonly openPage: (repository: string, number: number) => Promise<void>;
  /** Read a PR link the user pasted, in the code host's link format. */
  readonly parseLink: (link: string) => PullRequestLink | undefined;
}

/** A found row before its state is read: the repository, maybe a PR, and why it is linked. */
export interface Found { repository: string; number?: number; branch?: string; sources: Set<LinkSource> }

const count = async (folder: string, range: string): Promise<number> => Number((await git(folder, ['rev-list', '--count', range]).catch(() => '0')).trim()) || 0;

/** The rows a PR links to: GitHub mentions, branch pins in its diff, repositories Claude worked in and manual links, without unlinked ones. */
export async function findLinked({ repository, folder, dataPath, base, mentions }: {
  readonly repository: string; readonly folder: string; readonly dataPath: string; readonly base: () => Promise<string>;
  readonly mentions: Promise<readonly { readonly repository: string; readonly number: number }[]>;
}): Promise<Map<string, Found>> {
  const stored = await readStoredLinks(dataPath);
  const found = new Map<string, Found>();
  const add = (name: string, source: LinkSource, extra: { number?: number; branch?: string } = {}): void => {
    if (name.toLowerCase() === repository.toLowerCase()) return;
    const key = linkKey({ repository: name, ...(extra.number === undefined ? {} : { number: extra.number }) });
    const byRepo = [...found.values()].find((row) => row.repository.toLowerCase() === name.toLowerCase() && (row.number === undefined || extra.number === undefined || row.number === extra.number));
    const row = found.get(key) ?? byRepo ?? { repository: name, sources: new Set<LinkSource>() };
    row.sources.add(source);
    if (extra.number !== undefined) row.number = extra.number;
    if (extra.branch !== undefined) row.branch ??= extra.branch;
    for (const [other, each] of found) if (each === row) found.delete(other);
    found.set(linkKey({ repository: row.repository, ...(row.number === undefined ? {} : { number: row.number }) }), row);
  };
  for (const link of await mentions) add(link.repository, 'mention', { number: link.number });
  const diff = await git(folder, ['diff', '--no-color', '-U0', await base()]).catch(() => '');
  for (const pin of branchPins(addedLines(diff))) add(pin.repository, 'pin', { branch: pin.branch });
  for (const name of stored.worked) add(name, 'claude');
  for (const link of stored.added) add(link.repository, 'manual', { number: link.number });
  for (const [key, row] of found) if (stored.removed.includes(key) || stored.removed.includes(row.repository.toLowerCase())) found.delete(key);
  return found;
}

/** The Linked changes card's rows and actions for one PR. */
export function linkedChanges(context: LinkedContext): {
  read(): Promise<readonly LinkedChange[]>;
  open(key: string): Promise<void>;
  push(key: string): Promise<void>;
  draft(key: string): Promise<string>;
  link(link: string): Promise<void>;
  unlink(key: string): Promise<void>;
} {
  const { repository, pullRequest, provider, folder, dataPath } = context;
  /** Mentions only change on GitHub, so one read per page is enough until a reload. */
  let mentions: Promise<readonly { repository: string; number: number }[]> | undefined;

  const find = async (): Promise<Map<string, Found>> => {
    mentions ??= provider.crossReferences(pullRequest.number).then((nodes) => crossReferences(nodes, repository), () => []);
    return await findLinked({ repository, folder, dataPath, base: context.base, mentions });
  };

  /** Where Claude's worktree for a row is, if it made one: the linked PR's worktree, or this PR's own branch worktree. */
  const worktreeOf = async (row: Found, other: WorkspaceRepository | undefined): Promise<string | undefined> => {
    if (other === undefined) return undefined;
    const candidates = [
      ...(row.number === undefined ? [] : [worktreePath(other.storageRoot, row.repository, row.number)]),
      linkedWorktreePath(other.storageRoot, row.repository, { repository, number: pullRequest.number }),
    ];
    for (const candidate of candidates) if (await stat(candidate).then(() => true, () => false)) return candidate;
    return undefined;
  };

  const readRow = async (key: string, row: Found, repositories: ReadonlyMap<string, WorkspaceRepository>): Promise<LinkedChange> => {
    const other = repositories.get(row.repository.toLowerCase());
    const sources = [...row.sources];
    try {
      const otherProvider = await other?.connect();
      if (row.number === undefined && row.branch !== undefined && otherProvider !== undefined) {
        const open = await otherProvider.pullRequestForBranch(row.branch);
        if (open !== undefined) row.number = open.number;
      }
      if (row.number === undefined && otherProvider !== undefined) {
        const open = await otherProvider.pullRequestForBranch(linkedBranchName(pullRequest.headBranch));
        if (open !== undefined) row.number = open.number;
      }
      const state = row.number === undefined || otherProvider === undefined ? undefined : await otherProvider.linkedState(row.number);
      const worktree = await worktreeOf(row, other);
      const branch = worktree === undefined ? row.branch : (await git(worktree, ['rev-parse', '--abbrev-ref', 'HEAD']).catch(() => '')).trim() || row.branch;
      const unpushed = worktree === undefined ? 0
        : state !== undefined && /^[\da-f]{40}$/u.test(state.headOid) ? await count(worktree, `${state.headOid}..HEAD`)
        : await count(worktree, 'HEAD --not --remotes');
      return {
        key, repository: row.repository, sources, unpushed, local: other !== undefined,
        ...(state === undefined ? {} : { pullRequest: state }), ...(branch === undefined || branch === '' ? {} : { branch }),
        ...(other === undefined && row.number === undefined ? { problem: 'No clone of this repository in the workspace.' } : {}),
      };
    } catch (error: unknown) {
      return { key, repository: row.repository, sources, unpushed: 0, local: other !== undefined, problem: error instanceof Error ? error.message : String(error) };
    }
  };

  const rowFor = async (key: string): Promise<{ row: Found; other: WorkspaceRepository }> => {
    const row = (await find()).get(key);
    if (row === undefined) throw new Error('This link no longer exists.');
    const other = (await context.repositories()).get(row.repository.toLowerCase());
    if (other === undefined) throw new Error(`No clone of ${row.repository} in this workspace.`);
    return { row, other };
  };

  /** Push a linked worktree's branch while no Claude run works in it. */
  const pushWorktree = async (worktree: string, branch: string): Promise<void> => {
    const unlock = await lockWorktree(worktree, `${repository}#${pullRequest.number} push`, { pollMs: 200, signal: AbortSignal.timeout(5000) })
      .catch(() => { throw new Error('Claude is working in this worktree. Push when it is done.'); });
    try {
      await pushCommits(worktree, { pushTo: 'origin', headBranch: branch, hooksOff: false });
    } finally {
      await unlock();
    }
  };

  return {
    async read() {
      const [found, repositories] = await Promise.all([find(), context.repositories()]);
      return await Promise.all([...found].map(([key, row]) => readRow(key, row, repositories)));
    },
    async open(key) {
      const { row } = await rowFor(key);
      if (row.number === undefined) throw new Error(`${row.repository} has no PR for this change yet.`);
      await context.openPage(row.repository, row.number);
    },
    async push(key) {
      const { row, other } = await rowFor(key);
      const worktree = await worktreeOf(row, other);
      if (worktree === undefined) throw new Error('Claude has no worktree in this repository.');
      const state = row.number === undefined ? undefined : await (await other.connect()).linkedState(row.number);
      if (state !== undefined && !state.canPush) throw new Error(`You cannot push to ${row.repository}#${state.number}.`);
      const branch = state?.headBranch ?? (await git(worktree, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
      await pushWorktree(worktree, branch);
    },
    async draft(key) {
      const { row, other } = await rowFor(key);
      if (row.number !== undefined) throw new Error(`${row.repository} already has #${row.number} for this change.`);
      const worktree = await worktreeOf(row, other);
      if (worktree === undefined) throw new Error('Claude has no worktree in this repository.');
      const branch = (await git(worktree, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
      await pushWorktree(worktree, branch);
      const created = await (await other.connect()).createDraft(branch, pullRequest.title, `Goes with ${repository}#${pullRequest.number}.`);
      await writeStoredLinks(dataPath, addLink(await readStoredLinks(dataPath), { repository: row.repository, number: created.number }));
      return created.url;
    },
    async link(link) {
      const parsed = context.parseLink(link);
      if (parsed === undefined) throw new Error('Paste a GitHub PR link, or owner/repo#12.');
      const name = `${parsed.owner}/${parsed.name}`;
      if (name.toLowerCase() === repository.toLowerCase()) throw new Error('That PR is in this repository. Link PRs from other repositories.');
      await writeStoredLinks(dataPath, addLink(await readStoredLinks(dataPath), { repository: name, number: parsed.number }));
    },
    async unlink(key) {
      await writeStoredLinks(dataPath, removeLink(await readStoredLinks(dataPath), key));
    },
  };
}
