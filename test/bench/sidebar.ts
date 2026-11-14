// Times the PR sidebar: from VS Code asking for its rows to the rows being drawn, with the last list saved and without.
// GitHub answers after measured latencies and Git runs on this repository. Prints one JSON result for scripts/bench.mjs.
import type * as vscode from 'vscode';
import { localChanges } from '../../src/core/conflicts.js';
import type { ChangeRequestSummary, Forge } from '../../src/core/forge.js';
import { registerPullRequestView } from '../../src/hosts/vscode/pullRequestView.js';
import type { PullRequestWorktrees } from '../../src/hosts/vscode/pullRequestWorktrees.js';
import { FakeMemento, window } from '../fakes/vscode.js';
import { githubLatency } from './forge.js';

/**
 * Median GitHub response times in ms for the sidebar's searches, measured on 2026-11-14 with `gh api graphql` and the queries
 * of `GitHubApiProvider` (9 open PRs by the viewer, 5 runs each); they include starting `gh`.
 */
const searchLatency: Readonly<Record<string, number>> = { listMine: 1554, listReviewRequested: 637, openCount: 524 };

const pullRequests: ChangeRequestSummary[] = Array.from({ length: 9 }, (_, index) => ({
  number: index + 1, title: `feat(bench): change ${index + 1}`, url: `https://github.com/bench/repo/pull/${index + 1}`, author: 'bench', draft: false,
  headBranch: `bench-${index + 1}`, baseBranch: 'main',
}));
/** PRs with a worktree, whose rows also show review progress and local changes. */
const checkedOut = new Set([1, 2, 3]);

async function main(): Promise<void> {
  const { source, scale } = JSON.parse(process.env['BENCH_OPTIONS'] ?? '{}') as { source: string; scale: number };
  const after = <T>(method: string, value: T) => async (): Promise<T> => {
    await new Promise((resolve) => { setTimeout(resolve, ({ ...githubLatency, ...searchLatency }[method] ?? 0) * scale); });
    return value;
  };
  const provider = {
    readRepository: async () => ({ name: 'bench/repo', url: 'https://github.com/bench/repo' }),
    listMine: after('listMine', pullRequests), listReviewRequested: after('listReviewRequested', []), openCount: after('openCount', pullRequests.length),
    listFiles: after('listFiles', [{ path: 'a.ts', additions: 1, deletions: 0, change: 'modified' }]),
  } as unknown as Forge;
  const worktrees = {
    exists: async (_repository: string, number: number) => checkedOut.has(number),
    claudeStatus: () => undefined, working: () => false, reviewedFiles: async () => new Set<string>(), forget: () => undefined,
    localChanges: (_repository: string, _number: number, pushedHead: string | undefined) => localChanges(source, pushedHead),
  } as unknown as PullRequestWorktrees;
  const noChanges: vscode.Event<string | undefined> = () => ({ dispose: () => undefined });

  /** One window: until the expanded rows are drawn, and until no row is redrawn any more. */
  const open = async (saved: boolean): Promise<Record<string, number>> => {
    window.trees.length = 0;
    const workspace = new FakeMemento();
    if (saved) await workspace.update('diffGuide.pullRequestSnapshot', { repo: { repository: { name: 'bench/repo', url: 'https://github.com/bench/repo' }, mine: pullRequests, reviewRequested: [], openCount: pullRequests.length } });
    const view = registerPullRequestView(async () => [{ folder: 'repo', connect: async () => provider, worktrees }], noChanges, new FakeMemento(), workspace);
    const tree = window.trees.at(-1)?.provider as vscode.TreeDataProvider<unknown>;
    let changed = performance.now();
    let filled = NaN;
    /** VS Code draws a level once all its rows are known, then asks for the rows under the expanded ones. */
    const draw = async (node?: unknown): Promise<number> => {
      const children = await tree.getChildren(node) ?? [];
      const items = await Promise.all(children.map((child) => tree.getTreeItem(child)));
      if (Number.isNaN(filled) && items.some((item) => String(item.description).includes('reviewed'))) filled = performance.now();
      return items.length + (await Promise.all(children.map((child, index) => items[index]?.collapsibleState === 2 ? draw(child) : 0))).reduce((sum, count) => sum + count, 0);
    };
    tree.onDidChangeTreeData?.((node) => { changed = performance.now(); void draw(Array.isArray(node) ? undefined : node); });
    const from = performance.now();
    const rows = await draw();
    const drawn = performance.now() - from;
    while (performance.now() - changed < 2000 * Math.max(scale, 1)) await new Promise((resolve) => { setTimeout(resolve, 50); });
    view.dispose();
    return { rows, drawn, progress: filled - from, settled: changed - from };
  };
  process.stdout.write(JSON.stringify({ saved: await open(true), fresh: await open(false) }) + '\n');
  process.exit(0);
}

void main().catch((error: unknown) => { console.error(error); process.exit(1); });
