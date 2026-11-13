import type { ChangeRequestConversation, ChangeRequestDetails, ChangeRequestVersion, ConversationComment, Forge, RemoteThread, TimelineItem } from '../../src/core/forge.js';

/**
 * Median GitHub response times in ms, measured on 2026-11-13 with `GitHubApiProvider` against microsoft/vscode#347805
 * (11 files, 40 review comments, 5 runs each). Calls not listed answer at once.
 */
export const githubLatency: Readonly<Record<string, number>> = {
  overview: 1553, conversation: 2342, listFiles: 553, details: 1085, threads: 1242, linkedState: 728, crossReferences: 470, version: 524, setViewed: 600,
};

/** One forge call: its method, when it started and ended, relative to the bench clock. */
export interface ForgeCall { readonly method: string; readonly start: number; readonly end: number }

const codeBlock = '<div class="highlight highlight-source-ts notranslate position-relative overflow-auto"><pre>'
  + '<span class="pl-k">export</span> <span class="pl-k">function</span> <span class="pl-en">retry</span>(<span class="pl-s1">attempts</span>: <span class="pl-smi">number</span>) {\n'
  + '  <span class="pl-k">return</span> <span class="pl-s1">attempts</span> <span class="pl-c1">&gt;</span> <span class="pl-c1">0</span>;\n}</pre></div>';
const paragraph = '<p>This changes the retry loop so a failed request waits before the next attempt. Could we keep the old limit for callers that pass zero? '
  + 'The tests cover the happy path only; a case for the timeout would help.</p>';

function comment(id: string, index: number): ConversationComment {
  return {
    id, author: `user${index % 7}`, avatarUrl: '', createdAt: new Date(Date.UTC(2026, 9, 1, 0, index)).toISOString(),
    bodyHtml: paragraph + (index % 3 === 0 ? codeBlock : '') + paragraph, body: 'Review text '.repeat(40), url: `https://github.com/o/r/pull/1#c${id}`,
    canEdit: false, canDelete: false, canHide: false, canReact: true, edited: false, reactions: [],
  };
}

/** Review threads on the given paths, sized like the measured PR: 40 threads, 3 comments each. */
export function remoteThreads(paths: readonly string[]): RemoteThread[] {
  return Array.from({ length: 40 }, (_, index) => ({
    id: `T${index}`, path: paths[index % paths.length] ?? 'README.md', side: 'RIGHT', startLine: 1 + index, endLine: 1 + index, outdated: index % 5 === 0, resolved: index % 4 === 0,
    url: `https://github.com/o/r/pull/1#t${index}`, pending: false,
    comments: Array.from({ length: 3 }, (_, at) => ({ ...comment(`T${index}C${at}`, index * 3 + at), pending: false })),
  }));
}

export function details(): ChangeRequestDetails {
  return {
    bodyHtml: paragraph.repeat(6) + codeBlock, title: 'Bench PR', body: 'Body', open: true, merged: false, draft: false, canEdit: true, branchDeletable: false,
    labels: [{ name: 'perf', color: 'ededed' }], assignees: [], mergeable: 'yes', viewerIsAuthor: false, viewerAvatarUrl: '', mergeMethods: ['merge', 'squash'],
    reviewers: [{ name: 'user1', state: 'commented' }], checks: Array.from({ length: 12 }, (_, index) => ({ name: `check ${index}`, state: 'success' as const })),
  };
}

/** A conversation of 80 timeline items, sized like the measured PR's. */
export function conversation(headOid: string): ChangeRequestConversation {
  const timeline: TimelineItem[] = Array.from({ length: 80 }, (_, index): TimelineItem => index % 4 === 0
    ? { kind: 'commit', id: `K${index}`, oid: headOid, headline: `Commit ${index}`, message: '', author: 'user1', avatarUrl: '', createdAt: new Date(Date.UTC(2026, 9, 2, 0, index)).toISOString() }
    : index % 4 === 1 ? { kind: 'event', id: `E${index}`, actor: 'user2', avatarUrl: '', createdAt: new Date(Date.UTC(2026, 9, 2, 0, index)).toISOString(), text: 'added the perf label' }
      : { ...comment(`C${index}`, index), kind: 'comment' });
  return {
    timeline, description: { id: 'PR1', reactions: [], canReact: true }, viewerLogin: 'bench', permission: 'write',
    merge: { state: 'clean', canUpdateBranch: false, canBypass: false, canEnableAutoMerge: false, canDisableAutoMerge: false, autoMergeAllowed: false, mergeQueue: false, headOid, headDeleted: false },
    checks: [], linkedIssues: [], reviewIds: {}, awaitingApproval: [],
    commitDefaults: { squashTitle: 'PR_TITLE', squashBody: 'COMMIT_MESSAGES', mergeTitle: 'MERGE_MESSAGE', mergeBody: 'PR_TITLE' },
  };
}

/** A forge that answers like GitHub after `githubLatency`, logging each call. `scale` multiplies every latency; 0 answers at once. */
export function benchForge(fixture: { readonly paths: readonly string[]; readonly head: string; readonly base: string; readonly baseBranch: string }, clock: () => number, scale = 1): { forge: Forge; calls: ForgeCall[] } {
  const calls: ForgeCall[] = [];
  const polled = { etag: 'e', data: {} };
  const version: ChangeRequestVersion = { polled, head: fixture.head, updatedAt: '2026-11-13T00:00:00Z', baseBranch: fixture.baseBranch, baseHead: fixture.base };
  const answers: Record<string, () => unknown> = {
    listFiles: () => fixture.paths.map((path) => ({ path, additions: 1, deletions: 1, change: 'modified' })),
    viewedFiles: () => new Set<string>(),
    details, threads: () => remoteThreads(fixture.paths), conversation: () => conversation(fixture.head),
    overview: () => ({ details: details(), threads: remoteThreads(fixture.paths) }),
    crossReferences: () => [], linkedState: () => undefined, version: () => version,
    readRepository: () => ({ name: 'bench/repo', url: 'https://github.com/bench/repo' }),
  };
  const forge = new Proxy({}, {
    get: (_, method: string) => method === 'then' ? undefined : async (): Promise<unknown> => {
      const start = clock();
      await new Promise((resolve) => { setTimeout(resolve, (githubLatency[method] ?? 0) * scale); });
      calls.push({ method, start, end: clock() });
      return answers[method]?.();
    },
  }) as Forge;
  return { forge, calls };
}
