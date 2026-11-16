import { changeBlocks } from '../../src/core/prAnalysis.js';
import type { DiffLine, FileDiff } from '../../src/core/unifiedDiff.js';
import { openingOverviewState } from '../../src/page/overviewState.js';
import type { ExtensionMessage, OverviewState } from '../../src/page/protocol.js';
import { githubCodeHtml } from '../../src/page/preview/githubCode.js';

/** One render: the page's state and messages, the saved page state, and the steps that take screenshots. */
export interface Scene {
  readonly state: OverviewState;
  readonly messages: readonly ExtensionMessage[];
  /** What `acquireVsCodeApi().getState()` returns, such as `{ view: 'code', order: 'guide' }`. */
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
  /** A selector that must match; with `text`, its text must contain that; with `count`, it must match that many. */
  readonly expect?: string;
  readonly count?: number;
  readonly text?: string;
  /** A selector that must not match. */
  readonly absent?: string;
  /** A selector whose top must not move through this step's send, click and scroll. */
  readonly stay?: string;
  /** Two selectors: the first must start at or below the bottom of the second, so it does not draw over it. */
  readonly below?: readonly [string, string];
  /** Two selectors: the first must start at or right of the end of the second, so they do not overlap on a row. */
  readonly after?: readonly [string, string];
  /** A selector and the most pixels tall it may be, such as a row that must not wrap. */
  readonly tallest?: readonly [string, number];
  /** Two selectors whose vertical centers must line up, as on one row. */
  readonly level?: readonly [string, string];
  /** Two selectors: the first one's contents must lie within the second's box horizontally; the same selector twice catches text spilling out of its box. */
  readonly inside?: readonly [string, string];
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

/** A PR too large to draw in one frame: its diffs below the first screen are drawn over the next frames. */
const manyFiles: FileDiff[] = Array.from({ length: 300 }, (_, index) => ({
  ...file(`src/many/file${String(index).padStart(3, '0')}.ts`), ...index === 1 ? { generated: true as const } : {},
  hunks: [{ header: '@@ -1,400 +1,400 @@', lines: lines(1, 400, 'context', (n) => `  <span class="hljs-keyword">const</span> value${n} = compute(${n});`) }],
}));

const files = [file('src/auth/user.ts'), file('src/auth/token.ts'), file('src/api/client.ts'), file('README.md')];

/** The signature Claude's guide uses to find a file's one change block. */
const signatureOf = (path: string): string => changeBlocks(files).find((block) => block.path === path)?.signature ?? '';

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
      groups: [{ severity: 'significant', title: 'Parsing and retries', steps: [
        { blocks: [{ path: 'src/auth/user.ts', signature: signatureOf('src/auth/user.ts') }], title: 'user.ts null check', note: 'Returns null for empty input instead of throwing.' },
        { blocks: [{ path: 'src/api/client.ts', signature: signatureOf('src/api/client.ts') }], title: 'client.ts retry', note: 'Retries a request once on timeout.' },
      ] }],
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

/** Claude answering the thread in `path` with `count` steps so far. */
function threadWorking(count: number, path = 'src/auth/user.ts'): OverviewState {
  const steps = [{ verb: 'Read', target: 'src/auth/user.ts', done: true }, { verb: 'Search', target: 'parseUser', done: true }, { verb: 'Read', target: 'src/core/parse.ts', done: false }].slice(0, count);
  return { ...claudeIdle, claude: { text: 'Claude · Answering', running: true, retry: false }, threads: claudeIdle.threads.map((thread) => thread.path === path && !thread.resolved ? { ...thread, working: 'Answering', progress: { startedAt: now - 5_000, steps } } : thread) };
}

/** Claude idle with a code review to start, then working on a thread, then running the review. */
// The extension's own status texts, which start with "Claude".
const claudeIdle: OverviewState = { ...pullRequest, claude: { text: 'Claude idle', running: false, retry: false }, review: { running: false, picked: ['correctness'] } };
const claudeWorking: OverviewState = { ...working, claude: { ...working.claude, text: 'Claude · Reading src/api/client.ts' }, review: { running: false, picked: ['correctness'] } };
const claudeReviewing: OverviewState = { ...pullRequest, review: { running: true, picked: ['correctness'], live: {
  reviewers: ['correctness'], stage: 'candidates', startedAt: now - 40_000, orchestrator: [{ verb: 'Read', target: 'src/auth/user.ts', done: true }],
  lanes: [{ reviewer: 'correctness', phase: 'candidates', startedAt: now - 30_000, steps: [{ verb: 'Grep', target: 'parseUser', done: false }] }],
} } };

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
const withoutGuide: OverviewState = { ...pullRequest, analysis: { running: false, stale: false } };
const opening = openingOverviewState({
  number: pullRequest.number ?? 1, title: pullRequest.heading ?? '', url: pullRequest.url, author: pullRequest.author, draft: false,
  headBranch: pullRequest.headBranch, baseBranch: pullRequest.baseBranch, ...pullRequest.changes === undefined ? {} : { changes: pullRequest.changes },
});
const syncUndoText = 'Claude merged your edits to src/api/client.ts with GitHub\'s 2 new commits.';
const syncQuestionHtml = '<p>GitHub\'s new commit renames <code>retryDelay</code> to <code>backoff</code> in <code>src/api/client.ts</code>, and your edit changes the same line to <code>retryDelay * 2</code>. Should the doubled delay apply to <code>backoff</code>, or keep GitHub\'s value?</p>';
const scene = (state: OverviewState, steps: readonly Step[], extra: Partial<Scene> = {}): Scene => ({ state, messages: [{ state }, filesMessage], steps, ...extra });
const uncolored = files.map((each) => ({ ...each, hunks: each.hunks.map((hunk) => ({ ...hunk, lines: hunk.lines.map((line) => ({ ...line, html: line.html.replace(/<[^>]*>/gu, '') })) })) }));

/** Scenes by name; `npm run render -- <name>` renders one, no name renders all. */
export const scenes: Readonly<Record<string, Scene>> = {
  'header-actions': scene(pullRequest, [
    { expect: '.head #reviewed', text: '1/4 viewed' }, { absent: '#file-nav > .nav-head:has-text("viewed")' },
    { absent: '#files-bar #push' }, { absent: '#files-bar #show-unpushed' }, { expect: '.byline #unpushed-chip', text: '1 unpushed' },
    { click: '#page-menu-button', expect: '#page-menu #pr', text: 'Open on GitHub' },
    { expect: '#page-menu #terminal', text: 'Open in terminal' }, { absent: '#claude-menu #terminal' }, { expect: '#page-menu #link-pr', text: 'Link a PR' }, { shot: 'header-menu.png' },
    { click: '#remove-worktree', expect: '.ask-menu .ask-text', text: '1 commit GitHub does not have', shot: 'header-remove.png' },
    { click: '.ask-menu button:has-text("Cancel")', absent: '.ask-menu' },
    { click: '#page-menu-button' }, { click: '#link-pr', expect: '#page-menu .link-form input:focus', shot: 'header-link.png' },
    { click: '#title' }, { click: '#unpushed-chip', expect: '#unpushed-menu #show-unpushed', text: 'Show changes' },
    { expect: '#unpushed-menu #push', text: 'Push', shot: 'header-unpushed.png' },
    { click: '#show-unpushed', expect: '#view-code[aria-selected=true]' },
  ], { saved: { view: 'code' } }),
  'header-readonly': scene({ ...pullRequest, details: { ...pullRequest.details!, canEdit: false } }, [
    { click: '#unpushed-chip', expect: '#show-unpushed' }, { absent: '#push' },
  ], { saved: { view: 'code', order: 'guide' } }),
  'header-permission-change': scene(pullRequest, [
    { click: '#unpushed-chip', expect: '#push' },
    { send: { state: { ...pullRequest, details: { ...pullRequest.details!, canEdit: false } } }, absent: '#push' },
    { click: '#unpushed-chip', expect: '#show-unpushed' }, { absent: '#push' },
  ], { saved: { view: 'code' } }),
  'header-connection-change': scene(pullRequest, [
    { click: '#page-menu-button', expect: '#terminal' },
    { send: { state: { ...pullRequest, claude: { ...pullRequest.claude, link: { delivering: true, terminal: true } } } }, absent: '#terminal' },
    { absent: '#remove-worktree' }, { click: '#page-menu-button', absent: '#terminal' }, { absent: '#remove-worktree' },
  ], { saved: { view: 'code' } }),
  'header-placement': scene(pullRequest, [
    { expect: '.head:not(#files-bar) #page-menu-button:visible' }, { absent: '#files-bar #page-menu-button' },
    { expect: '.head:not(#files-bar) #reviewed', text: '1/4 viewed' }, { expect: '.byline #unpushed-chip:visible' },
    { absent: '#files-bar #unpushed-chip' },
  ], { saved: { view: 'code' } }),
  'header-terminal': scene(pullRequest, [
    { click: '#page-menu-button', expect: '#page-menu #terminal', text: 'Open in terminal' }, { absent: '#claude-menu #terminal' },
  ], { saved: { view: 'code' } }),
  'header-link-form': scene(pullRequest, [
    { click: '#page-menu-button' }, { click: '#link-pr', expect: '#page-menu .link-form input:focus' },
  ], { saved: { view: 'code' } }),
  'header-progress': scene(pullRequest, [
    { absent: '#file-nav > .nav-head:has-text("viewed")' },
    { click: '#order-guide', absent: '#file-nav > .nav-head:has-text("viewed")' },
  ], { saved: { view: 'code' } }),
  'overview-order': scene(pullRequest, [
    { expect: '#panel-overview .main-col > section:first-child #body' }, { below: ['#overview-guide', '#body'] },
    { expect: '#overview-guide:visible', text: 'Risk sits in the token refresh path.' },
  ], { saved: { view: 'overview' } }),
  'overview-linked': scene(pullRequest, [
    { absent: '#linked:visible' },
    { send: { state: { ...pullRequest, linked: [{ key: 'acme/api#7', repository: 'acme/api', sources: ['manual'], unpushed: 0, local: false,
      pullRequest: { number: 7, title: 'Handle empty responses', url: 'https://github.com/acme/api/pull/7', state: 'open', draft: false, headBranch: 'fix/empty', headOid: 'b'.repeat(40), canPush: false } }] } },
      expect: '#linked:visible #linked-rows', text: '#7 Handle empty responses', shot: 'overview-linked.png' },
    { send: { state: pullRequest }, absent: '#linked:visible' },
  ], { saved: { view: 'overview' } }),
  'overview-checks': scene(pullRequest, [
    { expect: '#merge-box #checks li', count: 2 }, { absent: '#merge-status :has-text("failing check")' },
    { absent: '#merge-status :has-text("All checks passed")' }, { expect: '#checks li:has-text("Pre-commit")', count: 1 },
  ], { saved: { view: 'overview' } }),
  'overview-details': scene(pullRequest, [
    { absent: '#pick-assignees:visible' }, { absent: '#pick-labels:visible' }, { absent: '#pick-milestone:visible' },
    { click: '#details-box > summary', expect: '#details-box #pick-assignees:visible' },
    { expect: '#details-box #pick-labels:visible' }, { expect: '#details-box #pick-milestone:visible' }, { expect: '#details-box #development:visible' },
  ], { saved: { view: 'overview' } }),
  'overview-pick-assignees': scene(pullRequest, [
    { click: '#details-box > summary' }, { click: '#pick-assignees', expect: '#details-box .picker input[placeholder="Filter people"]' },
  ], { saved: { view: 'overview' } }),
  'overview-pick-labels': scene(pullRequest, [
    { click: '#details-box > summary' }, { click: '#pick-labels', expect: '#details-box .picker input[placeholder="Filter labels"]' },
  ], { saved: { view: 'overview' } }),
  'overview-pick-milestone': scene(pullRequest, [
    { click: '#details-box > summary' }, { click: '#pick-milestone', expect: '#details-box .picker input[placeholder="Filter milestones"]' },
  ], { saved: { view: 'overview' } }),
  'overview-secondary-merge': scene(pullRequest, [
    { click: '#merge', expect: '#merge-form:visible', absent: '#merge.primary' },
  ], { saved: { view: 'overview' } }),
  'overview-layout': scene(pullRequest, [
    { expect: '#panel-overview .main-col > section:first-child #body' },
    { below: ['#overview-guide', '#body'] }, { expect: '#overview-guide', text: 'Risk sits in the token refresh path.' },
    { absent: '#linked:visible' }, { expect: '#merge-box #checks li', count: 2 },
    { absent: '#merge-status :has-text("failing check")' }, { absent: '#merge-status :has-text("All checks passed")' },
    { absent: '#pick-assignees:visible' }, { expect: '#details-summary', text: 'octo · bug · No milestone' }, { shot: 'overview-layout.png', full: true },
    { click: '#details-box > summary', expect: '#details-box #pick-assignees:visible' },
    { click: '#pick-assignees', expect: '#details-box .picker input[placeholder="Filter people"]' },
    { click: '#pick-assignees' }, { click: '#pick-labels', expect: '#details-box .picker input[placeholder="Filter labels"]' },
    { click: '#pick-labels' }, { click: '#pick-milestone', expect: '#details-box .picker input[placeholder="Filter milestones"]', shot: 'overview-details.png' },
    { click: '#pick-milestone' }, { click: '#merge', absent: '#merge.primary', expect: '#merge-form:visible' },
    { click: '#merge-cancel' }, { click: '#overview-guide button:has-text("Read in guide order")', expect: '#order-guide[aria-pressed=true]' },
  ], { saved: { view: 'overview' } }),
  overview: scene(pullRequest, [{ absent: '#nav-toggle:visible' }, { absent: '#code-bar:visible' }, { expect: '#finish-review:visible', shot: 'overview.png', full: true }], { saved: { view: 'overview' } }),
  // A page saved before the Code tab remembers 'files' or 'guide' as its view; both open Code in that order.
  'code-files': scene(pullRequest, [
    { expect: '#view-code[aria-selected=true]' }, { expect: '#order-files[aria-pressed=true]' }, { expect: '#nav-threads .nav-head', text: 'Threads' },
    { expect: '#nav-threads .nav-thread .nav-name', text: 'Null check in parseUser' },
    // Every line of the three unviewed files; README.md is Viewed and folded in both orders.
    { expect: '#files tr:is(.context,.add,.del)', count: 78 },
    { scrollTo: '#files', shot: 'code-files.png' },
    { scroll: 0, click: '#page-menu-button' }, { click: '#remove-worktree', expect: '.ask-text', text: 'It has 1 commit GitHub does not have', shot: 'remove-worktree.png' },
  ], { saved: { view: 'files' } }),
  'code-guide': scene(pullRequest, [
    { expect: '#view-code[aria-selected=true]' }, { expect: '#order-guide[aria-pressed=true]' }, { absent: '#view-guide' }, { absent: '#search-toggle:visible' },
    { expect: '#files tr:is(.context,.add,.del)', count: 78 }, { expect: '.folded-lines .folded-body[hidden=until-found] tr.context' },
    { expect: '.nav-step[data-nav-step="u:README.md"].done' }, { expect: '#file-nav .nav-step .nav-number', text: '1' },
    { expect: '.guide-intro .section-head button', text: 'Rebuild' }, { absent: '#analyze' },
    { shot: 'code-guide.png' },
    { expect: '.folded-body[hidden]', count: 6 },
    { click: '.folded-lines .fold-lines', expect: '.folded-body[hidden]', count: 5 },
  ], { saved: { view: 'guide' } }),
  search: scene(pullRequest, [
    { expect: '#search-toggle.filtered' }, { absent: '#filter-box:visible' }, { expect: '#order-files:visible' },
    { click: '#search-toggle', expect: '#nav-order.searching #file-filter:focus' }, { absent: '#order-files:visible', shot: 'search-open.png' },
    { click: '#title', absent: '#nav-order.searching' }, { expect: '#search-toggle.filtered:visible', shot: 'search-closed.png' },
  ], { saved: { view: 'code', order: 'files', filter: 'user' } }),
  toolbar: scene(pullRequest, [
    { expect: '#code-bar #nav-toggle:visible' }, { expect: '#code-bar #range:visible' }, { expect: '#code-bar #view-menu:visible' }, { absent: '#column-toggle' },
    { absent: '#files-bar #range' }, { absent: '#files-bar #view-menu' }, { absent: '.margin-mark' }, { expect: '#files tr.inline .thread' },
    { click: '#view-menu', absent: '.toolbar-menu .picker-row:has-text("margin")' },
    { click: '#view-menu', scroll: 900, expect: '#code-bar:visible', shot: 'code-scrolled.png' },
    // At the end of the page the sticky list stays under the tab row.
    { scroll: 100_000, below: ['#nav-order', '#files-bar'] },
    { scroll: 0, click: '#nav-toggle', expect: '#files-layout.list-hidden' }, { absent: '#nav-col:visible' }, { expect: '#nav-toggle:visible', shot: 'list-hidden.png' },
  ], { saved: { view: 'code', order: 'files' } }),
  'toolbar-guide': scene(pullRequest, [
    { expect: '#code-bar #nav-toggle:visible' }, { expect: '#code-bar #range:visible' }, { absent: '#code-bar #analyze' },
  ], { saved: { view: 'code', order: 'guide' } }),
  'order-switch': scene(pullRequest, [
    { click: '#order-guide', expect: '.step-wrap[data-key="g0.0"] .file-head', text: 'user.ts null check' },
    { expect: '#files tr:is(.context,.add,.del)', count: 78 },
    { click: '#order-files', absent: '.step-wrap' }, { expect: '#files tr:is(.context,.add,.del)', count: 78 },
  ], { saved: { view: 'code', order: 'files' } }),
  'guide-unbuilt': scene(withoutGuide, [
    { expect: '#order-guide[aria-pressed=true]' }, { expect: '#files .guide-intro button', text: 'Build guide' }, { expect: '#files .file', count: 4, shot: 'guide-unbuilt.png' },
  ], { saved: { view: 'code', order: 'guide' } }),
  working: scene(working, [{ shot: 'working.png' }], { saved: { view: 'files' } }),
  // Claude sits in one chip in the tab row, which stays in view while you scroll; its menu holds the live steps, Review, Stop, Open in terminal and new answers.
  claude: scene(claudeIdle, [
    { expect: '#files-bar #claude-chip .chip-text', text: 'Idle' }, { absent: '#claude-chip .chip-text:has-text("Claude")' }, { absent: '#claude:has-text("Claude")' }, { level: ['#claude-chip', '#finish-review'] }, { absent: '#claude-menu:visible' }, { absent: '#column-toggle' }, { absent: '#claude-col' },
    { expect: '#files tr.inline #thread-11111111-1111-1111-1111-111111111111' }, { absent: '.margin-mark' },
    // The answer on screen counts as seen; the one in client.ts, below, stays new.
    { expect: '#claude-chip .chip-new', text: '1 new' },
    { click: '#claude-chip', expect: '#claude-menu:visible #claude-body #claude-answers .answer-row', text: 'Retry on timeout' }, { expect: '#claude-menu #agent-review:visible', text: 'Review' },
    // Claude starting, working, reviewing and stopping moves neither the code nor the tab row.
    { send: { state: claudeWorking }, stay: '.file[data-path="src/auth/user.ts"] tr.add', expect: '#claude-chip.working', text: 'Reading src/api/client.ts' }, { absent: '#claude-chip .chip-text:has-text("Claude")' },
    { expect: '#claude-menu .step-log' }, { expect: '#claude-menu #stop-claude:visible', shot: 'claude-working.png' },
    { send: { state: claudeReviewing }, stay: '.file[data-path="src/auth/user.ts"] tr.add', expect: '#claude-review .review-live' }, { absent: '#review-card:visible' },
    { send: { state: claudeIdle }, stay: '#files-bar', absent: '#stop-claude:visible' },
    { click: '#claude-menu .answer-row', absent: '#claude-menu:visible' },
    { click: '#claude-chip', expect: '#claude-menu:visible' }, { click: '#title', absent: '#claude-menu:visible' },
    { scroll: 900, expect: '#claude-chip:visible', below: ['#code-bar', '#files-bar'] },
  ], { saved: { view: 'code', order: 'files' } }),
  // Claude working on a thread off screen, below or above, moves nothing on screen.
  claudeScrolled: scene(claudeIdle, [
    { scrollTo: '.file[data-path="src/api/client.ts"]', wait: 400 },
    { send: { state: threadWorking(1) }, stay: '.file[data-path="src/api/client.ts"]' },
    { send: { state: threadWorking(3) }, stay: '.file[data-path="src/api/client.ts"]' },
    { send: { state: threadWorking(2) }, stay: '.file[data-path="src/api/client.ts"]' },
    { send: { state: claudeIdle }, stay: '.file[data-path="src/api/client.ts"]' },
  ], { saved: { view: 'code', order: 'files' } }),
  claudeAbove: scene(claudeIdle, [
    { scrollTo: '.file[data-path="src/auth/user.ts"]', wait: 400 },
    { send: { state: threadWorking(1, 'src/api/client.ts') }, stay: '.file[data-path="src/auth/user.ts"]' },
    { send: { state: threadWorking(3, 'src/api/client.ts') }, stay: '.file[data-path="src/auth/user.ts"]' },
    { send: { state: threadWorking(2, 'src/api/client.ts') }, stay: '.file[data-path="src/auth/user.ts"]' },
    { send: { state: claudeIdle }, stay: '.file[data-path="src/auth/user.ts"]' },
  ], { saved: { view: 'code', order: 'files' } }),
  // The answer toast and the activity box above the tabs are gone; Overview shows Claude in the chip.
  overviewChip: scene(working, [{ absent: '#answers' }, { absent: '.claude-box' }, { expect: '#claude-chip.working:visible' }], { saved: { view: 'overview' } }),
  // Half of a 1440 px window, as with two pages side by side.
  narrow: scene(pullRequest, [{ level: ['#view-code', '#finish-review'], shot: 'narrow.png' },
    // A long step shortens the chip instead of breaking the row.
    { send: { state: working }, stay: '#code-bar', level: ['#view-code', '#claude-chip'] }, { level: ['#view-code', '#finish-review'] },
    { tallest: ['#finish-review', 26] }, { tallest: ['#claude-chip', 26] }, { after: ['#claude-chip', '#view-code'], shot: 'narrow-working.png' }], { saved: { view: 'files' }, width: 700, height: 900 }),
  local: scene(local, [
    { absent: '.tabs:visible' }, { absent: '#files-bar:visible' }, { absent: '#finish-review:visible' }, { absent: '#panel-overview:visible' },
    { expect: '#panel-files:visible .file', count: 4 }, { expect: '.head #claude-chip:visible' }, { expect: '#nav-threads .nav-name', text: 'Null check in parseUser' },
    { shot: 'local.png' }, { click: '#claude-chip', expect: '#claude-menu:visible' },
  ]),
  'local-saved-overview': scene(local, [{ expect: '#panel-files:visible .file', count: 4 }, { absent: '#panel-overview:visible' }, { absent: '.tabs:visible' }], { saved: { view: 'overview' }, width: 700 }),
  'local-header-chip': scene(local, [{ expect: '.head:not(#files-bar) #claude-chip:visible' }]),
  // Claude merged GitHub's new commits with local edits: Undo stays under other notices until clicked.
  syncUndo: scene({ ...pullRequest, syncUndo: syncUndoText }, [
    { expect: '#notice', text: syncUndoText, shot: 'sync-undo.png' },
    { send: { notice: { text: 'Refreshed.' } }, expect: '#notice', text: 'Refreshed.' },
    { wait: 4500, expect: '#notice', text: syncUndoText },
    { click: '#notice button:not(.icon-button)', absent: '#notice span' },
  ], { saved: { view: 'files' } }),
  // Claude could not merge on its own: its question shows above the tabs, and the notice's Show brings it into view.
  syncQuestion: scene({ ...pullRequest, syncQuestion: syncQuestionHtml }, [
    { send: { notice: { text: 'Claude needs your input to sync.', show: 'sync-question' } }, expect: '#notice', text: 'Claude needs your input to sync.' },
    { expect: '#sync-ask:not([hidden]) #sync-reply', text: 'Should the doubled delay apply to' },
    { click: '#notice button', absent: '#notice span', shot: 'sync-question.png' },
    { click: '#sync-cancel', absent: '#sync-ask:not([hidden])' },
  ], { saved: { view: 'overview' } }),
  // The page shows before GitHub sends the conversation; Merge waits for its merge state.
  conversationLoading: scene(withoutConversation, [
    { expect: '#merge[disabled]', shot: 'conversation-loading.png' },
    { send: { state: pullRequest }, absent: '#merge[disabled]' },
  ], { saved: { view: 'overview' } }),
  // The page shows before GitHub sends the details and threads; pulsing bars hold their places and review and merge wait.
  detailsLoading: scene(withoutDetails, [
    { expect: '#body .skeleton' }, { expect: '#reviewers .skeleton' }, { expect: '#merge-status .skeleton' }, { expect: '#threads .skeleton' },
    { expect: '#merge[disabled]' }, { expect: 'textarea#review[disabled]' }, { absent: '#finish-review:visible', shot: 'details-loading.png' },
    { send: { state: pullRequest }, absent: '.skeleton' }, { absent: 'textarea#review[disabled]' },
  ], { saved: { view: 'overview' } }),
  // The page shows before GitHub sends its file list; the viewed count pulses and the files wait for GitHub's Viewed marks.
  listLoading: { state: listPending, messages: [{ state: listPending }, filesMessage],
    saved: { view: 'files' }, steps: [
      { expect: '#reviewed .skeleton' }, { absent: '#files .file', shot: 'list-loading.png' },
      { send: { state: pullRequest }, expect: '#files .file' }, { absent: '#reviewed .skeleton' },
    ] },
  // Files show before their syntax colors; the colors come in batches and fill in the drawn lines.
  colorsLater: { state: pullRequest, messages: [{ state: pullRequest }, { ...filesMessage, files: uncolored }], saved: { view: 'files' }, steps: [
    { scrollTo: '#files', absent: '#files td.code span', shot: 'colors-later.png' },
    { send: { colors: files.slice(0, 2) }, expect: '.file[data-path="src/auth/token.ts"] td.code .hljs-keyword' }, { absent: '.file[data-path="src/api/client.ts"] td.code span' },
    { send: { colors: files.slice(2) }, expect: '.file[data-path="src/api/client.ts"] td.code .hljs-keyword', shot: 'colors-arrived.png' },
  ] },
  // A large PR shows its first screen at once and draws the other diffs over the next frames; a folded file draws none.
  drawnOverFrames: { state: pullRequest, messages: [{ state: pullRequest }], saved: { view: 'files' }, steps: [
    { send: { ...filesMessage, files: manyFiles }, wait: 60, expect: '.file[data-path="src/many/file000.ts"] table', absent: '.file[data-path="src/many/file299.ts"] table' },
    { expect: '.file[data-path="src/many/file299.ts"] .file-head' },
    // Jumping to a file that still waits draws it right away.
    { scrollTo: '.file[data-path="src/many/file250.ts"]', wait: 60, expect: '.file[data-path="src/many/file250.ts"] table', absent: '.file[data-path="src/many/file299.ts"] table', shot: 'drawn-over-frames.png' },
    { wait: 5000, expect: '.file[data-path="src/many/file299.ts"] table', absent: '.file[data-path="src/many/file001.ts"] table' },
  ] },
  // A PR without a worktree shows from its summary while the worktree is made, before the page loads in the same tab.
  opening: { state: opening, messages: [], saved: { view: 'overview' }, steps: [{ expect: '#reviewed .skeleton', shot: 'opening.png' }] },
  openingFiles: { state: opening, messages: [], saved: { view: 'files' }, steps: [{ expect: '#files', text: 'Loading changes…', shot: 'opening-files.png' }] },
  // Linked changes waits for an actual PR.
  linkedLoading: scene(withoutLinked, [
    { absent: '#linked:visible', shot: 'linked-loading.png' },
    { send: { state: { ...withoutLinked, linked: [] } }, absent: '#linked .skeleton' }, { absent: '#linked:visible' },
  ], { saved: { view: 'overview' } }),
  readme: { state: readme, messages: [{ state: readme }, { files: [retryFile], selection: { range: { kind: 'all' }, whitespace: false }, atHead: true }],
    saved: { view: 'files', composer: { path: 'src/retry.ts', side: 'new', start: 16, end: 16, text: 'Keep the fixed delay for now, the backend rate limits retries.' } },
    width: 1100, height: 900, steps: [{ scrollTo: '#files', shot: 'readme.png' }] },
  hover: scene(pullRequest, [
    { scrollTo: '#files', hover: '.nav-thread', wait: 600, shot: 'hover-nav.png' },
    { hover: '#files', wait: 100, shot: 'hover-gone.png' },
  ], { saved: { view: 'files' } }),
  hoverCard: scene(pullRequest, [{ hover: '.card-thread', wait: 600, shot: 'hover-card.png' }], { saved: { view: 'overview' } }),
  // An open thread folds when resolved.
  resolveFold: scene(pullRequest, [
    { expect: '#thread-11111111-1111-1111-1111-111111111111[open]' },
    { click: '#thread-11111111-1111-1111-1111-111111111111 button:has-text("Resolve")' },
    { send: { state: { ...pullRequest, threads: pullRequest.threads.map((each) => each.id.startsWith('1111') ? { ...each, resolved: true, status: 'Resolved' } : each) } },
      absent: '#thread-11111111-1111-1111-1111-111111111111[open]', shot: 'resolve-fold.png' },
  ], { saved: { view: 'files' } }),
  get pending() { return reviewingScenes['pending']!; },
  get finishReview() { return reviewingScenes['finishReview']!; },
  // Authors can only comment.
  finishAuthor: scene(pullRequest, [
    { click: '#finish-review', expect: '#author-note:visible', absent: '#verdicts:visible' },
    { expect: '#submit-review', text: 'Submit comment', shot: 'finish-author.png' },
  ], { saved: { view: 'code' } }),
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
    { expect: '#finish-count:visible', text: '2', absent: '#review-box:visible' },
    { click: '#finish-review', expect: '#pending-note', text: '2 pending, only you see them' },
    { expect: '#pending-list li', count: 2, absent: '.rail #review-box', shot: 'pending.png', full: true },
  ] },
  // Finish review toggles its form in place on Code; the form's own submit names the verdict.
  finishReview: { state: reviewing, messages: [{ state: reviewing }, filesMessage], saved: { view: 'code' }, steps: [
    { expect: '#finish-label', text: 'Finish review', absent: '#review-box:visible' },
    { click: '#finish-review', stay: '.file[data-path="src/auth/user.ts"]', expect: '#review-box:visible', absent: '#panel-overview:visible' },
    { expect: '[data-verdict="comment"][aria-pressed="true"]' }, { expect: '#submit-review', text: 'Submit comment' }, { expect: '#finish-label', text: 'Finish review' }, { expect: '#finish-count', text: '2' },
    { click: '[data-verdict="approve"]', expect: '#submit-review', text: 'Submit approval', shot: 'finish-review.png' },
    { click: '[data-verdict="requestChanges"]', expect: '#submit-review', text: 'Request changes' },
    { click: '#review-foot button:has-text("Discard pending")', expect: '#review-foot', text: 'Discard 2 pending comments? Nobody saw them yet.', level: ['#review-foot .muted', '#review-foot button.primary'], inside: ['#review-foot .muted', '#review-foot .muted'] }, { inside: ['#review-foot button.primary', '#review-box'], shot: 'finish-discard.png' },
    { click: '#review-foot button:has-text("Cancel")', expect: '#review-foot button', text: 'Discard pending' },
    { click: '#submit-review', expect: '#submit-review[disabled]' },
    { send: { done: 'review' }, absent: '#review-box:visible' }, { expect: '#finish-label', text: 'Finish review' },
    { click: '#finish-review', expect: '[data-verdict="comment"][aria-pressed="true"]' },
    { click: '#finish-review', absent: '#review-box:visible' }, { click: '#finish-review', expect: '#review-box:visible' },
    { click: '#view-code', absent: '#review-box:visible' },
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
