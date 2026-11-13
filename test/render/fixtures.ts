import type { DiffLine, FileDiff } from '../../src/core/unifiedDiff.js';
import type { ExtensionMessage, OverviewState } from '../../src/page/protocol.js';
import { githubCodeHtml } from '../../src/page/preview/githubCode.js';

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

/** Runs in order: send, click, scroll, hover, wait, then the checks, then shoot. `shot` names the PNG. */
export interface Step {
  /** A host message to deliver, such as the state after an action the page posted. */
  readonly send?: ExtensionMessage;
  readonly click?: string;
  readonly hover?: string;
  readonly scroll?: number;
  readonly scrollTo?: string;
  readonly wait?: number;
  readonly shot?: string;
  readonly full?: boolean;
  /** A selector that must match; with `text`, its text must contain that. */
  readonly expect?: string;
  readonly text?: string;
  /** A selector that must not match. */
  readonly absent?: string;
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
  linked: [],
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

const kw = (text: string): string => `<span class="hljs-keyword">${text}</span>`;
const fn = (text: string): string => `<span class="hljs-title function_">${text}</span>`;
const num = (text: string): string => `<span class="hljs-number">${text}</span>`;
const retryFile: FileDiff = {
  path: 'src/retry.ts', change: 'modified', binary: false, additions: 6, deletions: 1,
  hunks: [{ header: '@@ -8,8 +8,13 @@', lines: [
    { kind: 'context', oldLine: 8, newLine: 8, html: `${kw('export')} ${kw('async')} ${kw('function')} ${fn('withRetry')}(operation, attempts) {` },
    { kind: 'add', newLine: 9, html: `  ${kw('const')} timeout = ${num('5000')};` },
    { kind: 'context', oldLine: 9, newLine: 10, html: `  ${kw('for')} (${kw('let')} i = ${num('0')}; i &lt; attempts; i++) {` },
    { kind: 'del', oldLine: 10, html: `    ${kw('return')} ${kw('await')} ${fn('operation')}();` },
    { kind: 'add', newLine: 11, html: `    ${kw('try')} {` },
    { kind: 'add', newLine: 12, html: `      ${kw('return')} ${kw('await')} ${fn('withTimeout')}(${fn('operation')}(), timeout);` },
    { kind: 'add', newLine: 13, html: `    } ${kw('catch')} (error) {` },
    { kind: 'add', newLine: 14, html: `      ${kw('if')} (!(error ${kw('instanceof')} TimeoutError)) ${kw('throw')} error;` },
    { kind: 'add', newLine: 15, html: '    }' },
    { kind: 'context', oldLine: 11, newLine: 16, html: `    ${kw('await')} ${fn('sleep')}(${num('1000')});` },
    { kind: 'context', oldLine: 12, newLine: 17, html: '  }' },
    { kind: 'context', oldLine: 13, newLine: 18, html: `  ${kw('throw')} ${kw('new')} ${fn('RetryError')}(attempts);` },
    { kind: 'context', oldLine: 14, newLine: 19, html: '}' },
  ] }],
};

/** The README's "How it works" picture: an answered Ask, an Implement in progress and a new comment, on one local file. */
export const readme: OverviewState = {
  ...local, headBranch: 'feat/retry-timeout',
  claude: { text: 'Feedback on', running: true, retry: false, link: { delivering: true, terminal: true } },
  threads: [
    { id: '66666666-6666-6666-6666-666666666666', location: 'src/retry.ts:9', text: 'Read the timeout from settings, not a constant.', status: 'Working',
      path: 'src/retry.ts', side: 'new', startLine: 9, endLine: 9, resolved: false, title: 'Timeout from settings', working: 'Editing',
      progress: { startedAt: now - 48_000, steps: [
        { verb: 'Read', target: 'src/settings.ts', detail: 'Read 64 lines', done: true },
        { verb: 'Edit', target: 'src/retry.ts', done: true },
        { verb: 'Bash', target: 'npm test -- retry', done: false },
      ] },
      messages: [{ author: 'human', html: '<p>Read the timeout from settings, not a constant.</p>', createdAt: ago(1), intent: 'implement' }] },
    { id: '77777777-7777-7777-7777-777777777777', location: 'src/retry.ts:12-14', text: 'Does a timeout use up an attempt?', status: 'Answered',
      path: 'src/retry.ts', side: 'new', startLine: 12, endLine: 14, resolved: false, title: 'Timeout per attempt',
      messages: [
        { author: 'human', html: '<p>Does a timeout use up an attempt?</p>', createdAt: ago(4), intent: 'ask' },
        { author: 'claude', html: '<p>Yes. The <code>catch</code> swallows a <code>TimeoutError</code>, so the loop counts it as a failed attempt. <code>npm test -- retry</code> passes, 12 tests.</p>', createdAt: ago(3) },
      ] },
  ],
};

const filesMessage: ExtensionMessage = { files, selection: { range: { kind: 'all' }, whitespace: false }, atHead: true };
const { conversation: _conversation, ...withoutConversation } = pullRequest;
const { details: _details, github: _github, ...withoutDetails } = withoutConversation;
const { reviewed: _reviewed, ...withoutReviewed } = pullRequest;
const listPending: OverviewState = { ...withoutReviewed, reviewedPending: true };
const { linked: _linked, ...withoutLinked } = pullRequest;
const scene = (state: OverviewState, steps: readonly Step[], extra: Partial<Scene> = {}): Scene => ({ state, messages: [{ state }, filesMessage], steps, ...extra });

/** Scenes by name; `npm run render -- <name>` renders one, no name renders all. */
export const scenes: Readonly<Record<string, Scene>> = {
  overview: scene(pullRequest, [{ shot: 'overview.png', full: true }], { saved: { view: 'overview' } }),
  files: scene(pullRequest, [{ scrollTo: '#files', shot: 'files.png' }], { saved: { view: 'files' } }),
  guide: scene(pullRequest, [{ shot: 'guide.png', full: true }], { saved: { view: 'guide' } }),
  working: scene(working, [{ shot: 'working.png' }], { saved: { view: 'files' } }),
  narrow: scene(pullRequest, [{ shot: 'narrow.png' }], { saved: { view: 'files' }, width: 420, height: 800 }),
  local: scene(local, [{ shot: 'local.png' }]),
  // The page shows before GitHub sends the conversation; Merge waits for its merge state.
  conversationLoading: scene(withoutConversation, [
    { expect: '#merge[disabled]', shot: 'conversation-loading.png' },
    { send: { state: pullRequest }, absent: '#merge[disabled]' },
  ], { saved: { view: 'overview' } }),
  // The page shows before GitHub sends the details and threads; pulsing bars hold their places and review and merge wait.
  detailsLoading: scene(withoutDetails, [
    { expect: '#body .skeleton' }, { expect: '#reviewers .skeleton' }, { expect: '#merge-status .skeleton' }, { expect: '#threads .skeleton' },
    { expect: '#merge[disabled]' }, { expect: '#review[disabled]' }, { expect: '[data-event="comment"][disabled]', shot: 'details-loading.png' },
    { send: { state: pullRequest }, absent: '.skeleton' }, { absent: '#review[disabled]' },
  ], { saved: { view: 'overview' } }),
  // The page shows before GitHub sends its file list; the viewed count pulses and the files wait for GitHub's Viewed marks.
  listLoading: { state: listPending, messages: [{ state: listPending }, filesMessage],
    saved: { view: 'files' }, steps: [
      { expect: '#reviewed .skeleton' }, { absent: '#files .file', shot: 'list-loading.png' },
      { send: { state: pullRequest }, expect: '#files .file' }, { absent: '#reviewed .skeleton' },
    ] },
  // The page shows before GitHub sends the linked changes; pulsing bars hold the card's place.
  linkedLoading: scene(withoutLinked, [
    { expect: '#linked:not([hidden]) .skeleton', shot: 'linked-loading.png' },
    { send: { state: { ...withoutLinked, linked: [] } }, absent: '#linked .skeleton' }, { expect: '#linked-rows', text: 'No PRs in other repositories go with this one.' },
  ], { saved: { view: 'overview' } }),
  readme: { state: readme, messages: [{ state: readme }, { files: [retryFile], selection: { range: { kind: 'all' }, whitespace: false }, atHead: true }],
    saved: { view: 'files', composer: { path: 'src/retry.ts', side: 'new', start: 16, end: 16, text: 'Keep the fixed delay for now, the backend rate limits retries.' } },
    width: 1100, height: 900, steps: [{ scrollTo: '#files', shot: 'readme.png' }] },
  hover: scene(pullRequest, [
    { scrollTo: '#files', hover: '.nav-thread', wait: 600, shot: 'hover-nav.png' },
    { hover: '#files', wait: 100, shot: 'hover-gone.png' },
    { hover: '.margin-mark', wait: 600, shot: 'hover-mark.png' },
  ], { saved: { view: 'files', marginThreads: true } }),
  hoverCard: scene(pullRequest, [{ hover: '.card-thread', wait: 600, shot: 'hover-card.png' }], { saved: { view: 'overview' } }),
  // A thread opened from its margin mark still folds when resolved.
  resolveFold: scene(pullRequest, [
    { click: '.margin-mark[aria-label="Open comment: Null check in parseUser"]', expect: '#thread-11111111-1111-1111-1111-111111111111[open]' },
    { click: '#thread-11111111-1111-1111-1111-111111111111 button:has-text("Resolve")' },
    { send: { state: { ...pullRequest, threads: pullRequest.threads.map((each) => each.id.startsWith('1111') ? { ...each, resolved: true, status: 'Resolved' } : each) } },
      absent: '#thread-11111111-1111-1111-1111-111111111111[open]', shot: 'resolve-fold.png' },
  ], { saved: { view: 'files', marginThreads: true } }),
  get pending() { return reviewingScenes['pending']!; },
  get since() { return reviewingScenes['since']!; },
  get submitted() { return reviewingScenes['submitted']!; },
  get githubMarkup() { return reviewingScenes['githubMarkup']!; },
  get stale() { return reviewingScenes['stale']!; },
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

/** A GitHub comment as GitHub renders it: a highlighted Python block and a suggested change. */
const pendingLag: OverviewState = { ...reviewing, details: { ...reviewing.details!, pendingComments: 5 } };

const githubMarkup: OverviewState = {
  ...submitted,
  conversation: {
    ...submitted.conversation!,
    timeline: [...submitted.conversation!.timeline, { kind: 'comment', id: 'k2', author: 'alice', avatarUrl: '', createdAt: ago(1), body: '',
      bodyHtml: githubCodeHtml('<div class="highlight highlight-source-python notranslate position-relative overflow-auto" dir="auto"><pre class="notranslate"><span class="pl-k">def</span> <span class="pl-en">read</span>(<span class="pl-s1">ctx</span>):\n    <span class="pl-k">return</span> <span class="pl-s1">ctx</span>.<span class="pl-c1">read_result</span>(<span class="pl-s">"request"</span>)  <span class="pl-c"># cached</span></pre></div>'
        + '<div class="my-2 border rounded-2 js-suggested-changes-blob diff-view js-check-hidden-unicode"><div class="f6 p-2 lh-condensed border-bottom d-flex"><div class="flex-auto flex-items-center color-fg-muted">Suggested change</div></div>'
        + '<div itemprop="text" class="blob-wrapper data file"><table class="d-table tab-size mb-0 width-full"><tbody>'
        + '<tr class="border-0"><td class="blob-num blob-num-deletion blob-num-hidden" data-line-number="·"></td><td class="border-0 px-2 py-1 blob-code-inner blob-code-deletion js-blob-code-deletion blob-code-marker-deletion">    ``inputs`` are readable by name like a stage result.</td></tr>'
        + '<tr class="border-0"><td class="blob-num blob-num-addition blob-num-hidden" data-line-number="·"></td><td class="border-0 px-2 py-1 blob-code-inner blob-code-addition js-blob-code-addition blob-code-marker-addition">    ``inputs`` are objects the caller passes to the rules besides the values.</td></tr>'
        + '</tbody></table></div></div>', 'src/rules.py'),
      canEdit: false, canDelete: false, canHide: false, canReact: true, edited: false, reactions: [] }],
  },
};

export const reviewingScenes: Readonly<Record<string, Scene>> = {
  submitted: { state: submitted, messages: [{ state: submitted }, filesMessage], steps: [{ scrollTo: '#conversation', shot: 'submitted.png' }], saved: { view: 'overview' } },
  // The details' count lags at 5; the page counts the 2 pending comments its list shows.
  pending: { state: pendingLag, messages: [{ state: pendingLag }, filesMessage], saved: { view: 'overview' }, steps: [
    { expect: '#pending-note', text: '2 pending comments' }, { expect: '#bar-pending', text: '2 pending', shot: 'pending.png', full: true },
  ] },
  stale: { state: reviewing, messages: [{ state: reviewing }, filesMessage, { stale: true }], saved: { view: 'files' }, steps: [
    { expect: '#notice', text: 'The base branch moved on GitHub' },
    { send: { notice: { text: 'Refreshed.' } }, expect: '#notice', text: 'Refreshed.' },
    { send: filesMessage, wait: 4500, absent: '#notice span', shot: 'stale.png' },
  ] },
  githubMarkup: { state: githubMarkup, messages: [{ state: githubMarkup }, filesMessage], saved: { view: 'overview' }, steps: [
    { expect: '#conversation pre code .hljs-keyword', text: 'def', absent: '#conversation .pl-k' },
    // GitHub's suggestion table shows as removed and added lines, its line number cells hidden.
    { expect: '#conversation .js-suggested-changes-blob .blob-code-addition', text: 'objects the caller passes', absent: '#conversation .js-suggested-changes-blob .blob-num:visible', scrollTo: '#conversation', shot: 'github-markup.png' },
  ] },
  since: { state: reviewing, messages: [{ state: reviewing }, { ...filesMessage, selection: { range: { kind: 'since' }, whitespace: false } }], steps: [{ shot: 'since.png' }], saved: { view: 'files' } },
};
