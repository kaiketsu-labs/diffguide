import type { DiffLine, FileDiff } from '../../src/core/unifiedDiff.js';
import type { ExtensionMessage, OverviewState } from '../../src/page/protocol.js';

/** One render: the page's state and messages, the saved page state, and the steps that take screenshots. */
export interface Scene {
  readonly state: OverviewState;
  readonly messages: readonly ExtensionMessage[];
  /** What `acquireVsCodeApi().getState()` returns, such as `{ view: 'guide' }`. */
  readonly saved?: Record<string, unknown>;
  readonly width?: number;
  readonly height?: number;
  readonly steps: readonly Step[];
}

/** Runs in order: click, then scroll, then hover, then wait, then shoot. `shot` names the PNG. */
export interface Step {
  readonly click?: string;
  readonly hover?: string;
  readonly scroll?: number;
  readonly scrollTo?: string;
  readonly wait?: number;
  readonly shot?: string;
  readonly full?: boolean;
}

const now = Date.now();
const ago = (minutes: number): string => new Date(now - minutes * 60_000).toISOString();

const lines = (from: number, count: number, kind: DiffLine['kind'], text: (line: number) => string): DiffLine[] =>
  Array.from({ length: count }, (_, index) => ({
    kind, html: text(from + index),
    ...kind !== 'add' ? { oldLine: from + index } : {},
    ...kind !== 'del' ? { newLine: from + index } : {},
  }));

const file = (path: string): FileDiff => ({
  path, change: 'modified', binary: false, additions: 6, deletions: 2,
  hunks: [{ header: '@@ -1,20 +1,24 @@', lines: [
    ...lines(1, 4, 'context', (n) => `  <span class="hljs-keyword">const</span> value${n} = compute(${n});`),
    ...lines(5, 2, 'del', (n) => `  <span class="hljs-keyword">return</span> legacy(${n});`),
    ...lines(5, 6, 'add', (n) => `  <span class="hljs-keyword">if</span> (!user) <span class="hljs-keyword">return</span> <span class="hljs-literal">null</span>; <span class="hljs-comment">// ${n}</span>`),
    ...lines(11, 14, 'context', (n) => `  <span class="hljs-keyword">const</span> value${n} = compute(${n});`),
  ] }],
});

const files = [file('src/auth/user.ts'), file('src/auth/token.ts'), file('src/api/client.ts'), file('README.md')];

const thread = (id: string, path: string, line: number, title: string, minutes: number, resolved = false): OverviewState['threads'][number] => ({
  id, location: `${path}:${line}`, text: 'Is this null check needed here?', status: resolved ? 'Resolved' : 'Answered',
  path, side: 'new', startLine: line, endLine: line, resolved, title,
  messages: [
    { author: 'human', html: '<p>Is this null check needed here?</p>', createdAt: ago(minutes + 2), intent: 'ask' },
    { author: 'claude', html: '<p>Yes. <code>parse</code> returns <code>undefined</code> for empty input, so the caller would throw.</p>', createdAt: ago(minutes) },
  ],
  ...resolved ? {} : { newAnswer: ago(minutes) },
});

/** A PR with GitHub details, two reviewers, failing and passing checks, three Local threads and an unpushed commit. */
export const pullRequest: OverviewState = {
  title: '#42 Fix parser', number: 42, heading: 'Fix parser', author: 'octo', headBranch: 'fix/parser', baseBranch: 'main',
  url: 'https://github.com/acme/app/pull/42', createdAt: ago(600), updatedAt: ago(5),
  changes: { additions: 24, deletions: 8, files: files.length }, reviewed: { done: 1, total: files.length },
  viewed: ['README.md'], read: [],
  claude: { text: 'Idle', running: false, retry: false },
  threads: [
    thread('11111111-1111-1111-1111-111111111111', 'src/auth/user.ts', 7, 'Null check in parseUser', 2),
    thread('22222222-2222-2222-2222-222222222222', 'src/auth/user.ts', 12, 'Rename legacy helper', 30, true),
    thread('33333333-3333-3333-3333-333333333333', 'src/api/client.ts', 8, 'Retry on timeout', 5),
  ],
  github: [],
  details: {
    bodyHtml: '<p>Handles empty input in <code>parseUser</code> and retries the API client on timeout.</p>', title: 'Fix parser',
    body: 'Handles empty input in `parseUser` and retries the API client on timeout.', open: true, merged: false, draft: false,
    canEdit: true, branchDeletable: true, labels: [{ name: 'bug', color: 'd73a4a' }], assignees: ['octo'], mergeable: 'yes',
    viewerIsAuthor: true, viewerAvatarUrl: '', mergeMethods: ['squash', 'merge'],
    reviewers: [{ name: 'alice', state: 'approved' }, { name: 'bob', state: 'requested' }],
    checks: [{ name: 'Check', state: 'success' }, { name: 'Pre-commit', state: 'failure' }],
  },
  conversation: {
    timeline: [
      { kind: 'commit', id: 'c1', oid: 'a'.repeat(40), headline: 'fix(parser): handle empty input', message: '', author: 'octo', avatarUrl: '', createdAt: ago(300), checks: 'success' },
      { kind: 'comment', id: 'k1', author: 'alice', avatarUrl: '', createdAt: ago(120), bodyHtml: '<p>Looks good once the retry has a cap.</p>', body: 'Looks good once the retry has a cap.',
        canEdit: false, canDelete: false, canHide: false, canReact: true, edited: false, reactions: [] },
    ],
    description: { id: 'd1', reactions: [], canReact: true }, viewerLogin: 'octo', permission: 'admin',
    merge: { state: 'clean', reviewDecision: 'approved', canUpdateBranch: false, canBypass: false, canEnableAutoMerge: false, canDisableAutoMerge: false,
      autoMergeAllowed: false, mergeQueue: false, headOid: 'a'.repeat(40), headDeleted: false },
    checks: [], linkedIssues: [{ number: 7, title: 'Parser throws on empty input', url: 'https://github.com/acme/app/issues/7', open: true }],
    reviewIds: {}, commitDefaults: { squashTitle: 'PR_TITLE', squashBody: 'PR_BODY', mergeTitle: 'PR_TITLE', mergeBody: 'PR_BODY' }, awaitingApproval: [],
  },
  analysis: {
    running: false, stale: false,
    result: {
      head: 'a'.repeat(40), createdAt: ago(60), overview: 'Adds null handling to user parsing and a retry to the API client. Risk sits in the token refresh path.',
      files: [{ path: 'src/auth/user.ts', note: 'Holds the behavior change.' }],
      groups: [{ severity: 'critical', title: 'Token refresh', steps: [{ blocks: [{ path: 'src/auth/token.ts', signature: 'deadbeef' }], title: 'Refresh before expiry', note: 'Refreshes the token one minute early.' }] }],
    },
  },
  unpushed: [{ oid: 'f'.repeat(40), subject: 'Use the configured limit', author: 'claude', createdAt: ago(10), files: 1, additions: 2, deletions: 1 }],
  local: { 'src/api/client.ts': 'unpushed' },
};

/** The same PR while Claude works on a thread. */
export const working: OverviewState = {
  ...pullRequest,
  claude: { text: 'Reading src/api/client.ts', running: true, retry: false, progress: { startedAt: now - 20_000, steps: [
    { verb: 'Read', target: 'src/api/client.ts', detail: 'Read 120 lines', done: true },
    { verb: 'Edit', target: 'src/api/client.ts', done: false },
  ] } },
};

/** The local review page: uncommitted changes, no GitHub. */
export const local: OverviewState = {
  localMode: true, title: 'Local changes', author: '', headBranch: 'feat/parser', baseBranch: 'HEAD', url: '',
  viewed: [], read: [], claude: { text: 'Idle', running: false, retry: false },
  threads: [thread('44444444-4444-4444-4444-444444444444', 'src/auth/user.ts', 7, 'Null check in parseUser', 3)],
  analysis: { running: false, stale: false },
};

const filesMessage: ExtensionMessage = { files, selection: { range: { kind: 'all' }, whitespace: false }, atHead: true };
const scene = (state: OverviewState, steps: readonly Step[], extra: Partial<Scene> = {}): Scene => ({ state, messages: [{ state }, filesMessage], steps, ...extra });

/** Scenes by name; `npm run render -- <name>` renders one, no name renders all. */
export const scenes: Readonly<Record<string, Scene>> = {
  overview: scene(pullRequest, [{ shot: 'overview.png', full: true }], { saved: { view: 'overview' } }),
  files: scene(pullRequest, [{ scrollTo: '#files', shot: 'files.png' }], { saved: { view: 'files' } }),
  guide: scene(pullRequest, [{ shot: 'guide.png', full: true }], { saved: { view: 'guide' } }),
  working: scene(working, [{ shot: 'working.png' }], { saved: { view: 'files' } }),
  narrow: scene(pullRequest, [{ shot: 'narrow.png' }], { saved: { view: 'files' }, width: 420, height: 800 }),
  local: scene(local, [{ shot: 'local.png' }]),
  hover: scene(pullRequest, [
    { scrollTo: '#files', hover: '.nav-thread', wait: 600, shot: 'hover-nav.png' },
    { hover: '#files', wait: 100, shot: 'hover-gone.png' },
    { hover: '.margin-mark', wait: 600, shot: 'hover-mark.png' },
  ], { saved: { view: 'files', marginThreads: true } }),
  hoverCard: scene(pullRequest, [{ hover: '.card-thread', wait: 600, shot: 'hover-card.png' }], { saved: { view: 'overview' } }),
  get pending() { return reviewingScenes['pending']!; },
  get since() { return reviewingScenes['since']!; },
  get submitted() { return reviewingScenes['submitted']!; },
};

const pendingMessage = (id: string, body: string): GitHubMessage => ({
  id, author: 'octo', avatarUrl: '', pending: true, html: `<p>${body}</p>`, body, canDelete: true, canEdit: true, canHide: false, canReact: false, edited: false, reactions: [], createdAt: ago(4),
});
type GitHubMessage = NonNullable<OverviewState['github']>[number]['messages'][number];

const finding = thread('55555555-5555-5555-5555-555555555555', 'src/auth/token.ts', 9, 'Refresh skips expired tokens', 40);

/** A reviewer's PR with a pending review, new commits since their last review and an open code review finding. */
export const reviewing: OverviewState = {
  ...pullRequest,
  threads: [...pullRequest.threads, { ...finding, origin: 'review', finding: { reviewers: ['correctness'], severity: 'high', evidence: 'tested' } }],
  github: [
    { id: 'g1', location: 'src/auth/user.ts:6', text: 'Return early here?', status: 'Pending', url: '', path: 'src/auth/user.ts', side: 'new', startLine: 6, endLine: 6, outdated: false, resolved: false, pending: true,
      messages: [pendingMessage('m1', 'Return early here instead of nesting?')] },
    { id: 'g2', location: 'src/api/client.ts:9', text: 'Cap the retries', status: 'Pending', url: '', path: 'src/api/client.ts', side: 'new', startLine: 9, endLine: 9, outdated: false, resolved: false, pending: true,
      messages: [pendingMessage('m2', 'Cap the retries at three so a dead server does not hang the client.')] },
  ],
  details: { ...pullRequest.details!, viewerIsAuthor: false, pendingComments: 2 },
  conversation: {
    ...pullRequest.conversation!,
    viewerLogin: 'alice',
    lastReviewedCommit: 'a'.repeat(40),
    timeline: [
      ...pullRequest.conversation!.timeline,
      { kind: 'commit', id: 'c2', oid: 'b'.repeat(40), headline: 'fix(api): retry on timeout', message: '', author: 'octo', avatarUrl: '', createdAt: ago(90), checks: 'success' },
      { kind: 'commit', id: 'c3', oid: 'c'.repeat(40), headline: 'test(api): cover the retry cap', message: '', author: 'octo', avatarUrl: '', createdAt: ago(30), checks: 'success' },
    ],
  },
  review: {
    running: false, picked: ['correctness'],
    result: { createdAt: ago(40), ran: ['correctness'], skipped: [], candidates: 3, dropped: [],
      findings: [{ threadId: finding.id, title: 'Refresh skips expired tokens', severity: 'high', evidence: 'tested', reviewers: ['correctness'], path: 'src/auth/token.ts', startLine: 9 }] },
  },
  unpushed: [],
};

/** The same PR right after the reviewer submitted its two comments as a review without a summary. */
const submitted: OverviewState = {
  ...reviewing,
  github: reviewing.github!.map((thread) => ({ ...thread, status: 'Open', pending: false, messages: thread.messages.map((entry) => ({ ...entry, pending: false })) })),
  details: { ...reviewing.details!, pendingComments: 0 },
  conversation: {
    ...reviewing.conversation!,
    timeline: [...reviewing.conversation!.timeline, { kind: 'review', id: 'r1', author: 'alice', avatarUrl: '', createdAt: ago(1), bodyHtml: '', body: '', state: 'commented', comments: ['m1', 'm2'],
      canEdit: true, canDelete: false, canHide: false, canReact: true, edited: false, reactions: [] }],
  },
};

export const reviewingScenes: Readonly<Record<string, Scene>> = {
  submitted: { state: submitted, messages: [{ state: submitted }, filesMessage], steps: [{ scrollTo: '#conversation', shot: 'submitted.png' }], saved: { view: 'overview' } },
  pending: { state: reviewing, messages: [{ state: reviewing }, filesMessage], steps: [{ shot: 'pending.png', full: true }], saved: { view: 'overview' } },
  since: { state: reviewing, messages: [{ state: reviewing }, { ...filesMessage, selection: { range: { kind: 'since' }, whitespace: false } }], steps: [{ shot: 'since.png' }], saved: { view: 'files' } },
};
