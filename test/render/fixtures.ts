import type { AgentStep } from '../../src/core/agent.js';
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

/** Runs in order: send, click, fill, press, scroll, hover, wait, then the checks, then shoot. `shot` names the PNG. */
export interface Step {
  /** A host message to deliver, such as the state after an action the page posted. */
  readonly send?: ExtensionMessage;
  /** A selector whose text to select and let go of, as a drag over it would. */
  readonly select?: string;
  /** Two selectors: press the mouse in the first's text, drag to the second's and let go. */
  readonly drag?: readonly [string, string];
  readonly click?: string;
  /** A selector and the text to type into it, replacing what it holds. */
  readonly fill?: readonly [string, string];
  /** A key or chord for the focused element, in Playwright's names, such as `ControlOrMeta+F`. */
  readonly press?: string;
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
  /** An input's selector and the value it must hold. */
  readonly value?: readonly [string, string];
  /** A CSS highlight's name and the text its ranges on the page mark, joined by `|`. */
  readonly highlight?: readonly [string, string];
  /** A selector whose top must not move through this step's send, click and scroll. */
  readonly stay?: string;
  /** Two selectors: the first must start at or below the bottom of the second, so it does not draw over it. */
  readonly below?: readonly [string, string];
  /** Two selectors: the first must start at or right of the end of the second, so they do not overlap on a row. */
  readonly after?: readonly [string, string];
  /** Two selectors and a gap in pixels: the first must start right of the second's end, at most that far from it. */
  readonly next?: readonly [string, string, number];
  /** A selector and the most pixels tall it may be, such as a row that must not wrap. */
  readonly tallest?: readonly [string, number];
  /** A selector, pseudo-element, CSS property and expected computed value. */
  readonly css?: readonly [string, string, string, string];
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
    { author: 'claude', html: '<p>Yes. <code>parse</code> returns <code>undefined</code> for empty input, so the caller would throw.</p>', createdAt: ago(minutes), model: 'claude-opus-5-5' },
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

/** Claude's Diff pair on a reading, an editing and a thinking step, beside a comment that waits with nothing to pick it up. */
const companionThread = (id: string, line: number, title: string, working: string, steps?: AgentStep[]): OverviewState['threads'][number] => ({
  id, location: `src/retry.ts:${line}`, text: title, status: working, path: 'src/retry.ts', side: 'new', startLine: line, endLine: line, resolved: false, title, working,
  ...steps === undefined ? {} : { progress: { startedAt: now - 12_000, steps } },
  messages: [{ author: 'human', html: `<p>${title}</p>`, createdAt: ago(1), intent: 'implement' }],
});
// A PR page, not the local one: render.mjs only sets the theme's body class on a body without a class.
const companion: OverviewState = {
  ...pullRequest, claude: { text: 'Claude idle', running: false, retry: false },
  threads: [
    companionThread('a1111111-1111-1111-1111-111111111111', 9, 'Read the timeout from settings.', 'Working', [{ verb: 'Read', target: 'src/settings.ts', done: false }]),
    companionThread('a2222222-2222-2222-2222-222222222222', 12, 'Wrap the call in withTimeout.', 'Editing', [{ verb: 'Read', target: 'src/retry.ts', done: true }, { verb: 'Edit', target: 'src/retry.ts', done: false }]),
    companionThread('a3333333-3333-3333-3333-333333333333', 14, 'Rethrow anything but a timeout.', 'Working', [{ verb: 'Bash', target: 'npm test -- retry', done: false }]),
    companionThread('a4444444-4444-4444-4444-444444444444', 16, 'Keep the fixed delay.', 'Waiting for Claude'),
  ],
};

const statusHtml = '<!doctype html>\n<html><head><title>Status</title></head>\n<body>\n<h1>Retry status</h1>\n<p>The client retries failed requests.</p>\n<h2>Settings</h2>\n<p>Four attempts.</p>\n</body></html>\n';
// What htmlPreview makes of statusHtml; it is async and this bundle cannot await at load.
const statusPreview = '<!DOCTYPE html><html><head><!--lr-frame-fixture--><title data-lr-lines="2-2">Status</title></head>\n<body>\n<h1 data-lr-lines="4-4">Retry status</h1>\n<p data-lr-lines="5-5">The client retries failed requests.</p>\n<h2 data-lr-lines="6-6">Settings</h2>\n<p data-lr-lines="7-7">Four attempts.</p>\n\n</body></html>';
const statusFile: FileDiff = { path: 'docs/status.html', change: 'added', binary: false, additions: 8, deletions: 0,
  hunks: [{ header: '@@ -0,0 +1,8 @@', lines: lines(1, 8, 'add', (n) => statusHtml.split('\n')[n - 1] ?? '') }] };
const htmlThread = (id: string, line: number, title: string): OverviewState['threads'][number] => ({
  id, location: `docs/status.html:${line}`, text: title, status: 'Answered', path: statusFile.path, side: 'new', startLine: line, endLine: line, resolved: false, title,
  messages: [{ author: 'human', html: `<p>${title}</p>`, createdAt: ago(2), intent: 'ask' }],
});
const answer = (minutes: number): OverviewState['threads'][number]['messages'][number] => ({ author: 'claude', createdAt: ago(minutes),
  html: '<p>It waits 200 ms, then doubles the wait each time.</p><ul><li>Four attempts take about 3.2 s before throwing.</li><li>Line 17 omits the jitter that <code>README.md</code> mentions.</li></ul>' });
const longThread = htmlThread('h1111111-1111-1111-1111-111111111111', 5, 'Explain the retries');
const htmlThreads: OverviewState = { ...local, threads: [{ ...longThread, messages: [...longThread.messages, answer(8), answer(6), answer(4), answer(2)] },
  htmlThread('h2222222-2222-2222-2222-222222222222', 6, 'Rename the heading')] };
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
    { expect: '#files-bar #push:visible', text: 'Push 1' }, { next: ['#claude-anchor', '#push', 12] }, { absent: '#files-bar #show-unpushed' }, { expect: '.byline #unpushed-chip', text: '1 unpushed' },
    { click: '#page-menu-button', expect: '#page-menu #pr', text: 'Open on GitHub' },
    { expect: '#page-menu #terminal', text: 'Open in terminal' }, { absent: '#claude-menu #terminal' }, { expect: '#page-menu #link-pr', text: 'Link a PR' }, { shot: 'header-menu.png' },
    { click: '#remove-worktree', expect: '.ask-menu .ask-text', text: '1 commit GitHub does not have', shot: 'header-remove.png' },
    { click: '.ask-menu button:has-text("Cancel")', absent: '.ask-menu' },
    { click: '#page-menu-button' }, { click: '#link-pr', expect: '#page-menu .link-form input:focus', shot: 'header-link.png' },
    { click: '#title' }, { click: '#unpushed-chip', expect: '#unpushed-menu #show-unpushed', text: 'Show changes' },
    { absent: '#unpushed-menu #push', shot: 'header-unpushed.png' },
    { click: '#show-unpushed', expect: '#view-code[aria-selected=true]' },
  ], { saved: { view: 'code' } }),
  'header-readonly': scene({ ...pullRequest, details: { ...pullRequest.details!, canEdit: false } }, [
    { expect: '#unpushed-chip' }, { absent: '#push:visible' },
  ], { saved: { view: 'code', order: 'guide' } }),
  'header-permission-change': scene(pullRequest, [
    { expect: '#push:visible' },
    { send: { state: { ...pullRequest, details: { ...pullRequest.details!, canEdit: false } } }, absent: '#push:visible' },
  ], { saved: { view: 'code' } }),
  // Push shows it is working until the extension answers, then hides until the next state recounts.
  'header-pushing': scene(pullRequest, [
    { click: '#push', expect: '#push.busy', text: 'Pushing…' }, { expect: '#push[disabled]', shot: 'header-pushing.png' },
    { send: { error: 'GitHub refused the push.' }, expect: '#push:visible', text: 'Push 1' }, { absent: '#push.busy' },
    { click: '#push', expect: '#push.busy' }, { send: { done: 'push', notice: { text: 'Pushed to GitHub.' } }, absent: '#push:visible' }, { expect: '#notice', text: 'Pushed to GitHub.' },
  ], { saved: { view: 'overview' } }),
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
  find: scene(pullRequest, [
    { absent: '#find-box:visible' },
    { send: { find: true }, stay: '#view-code', expect: '#files-bar #find-box:visible #find-input:focus' }, { after: ['#find-box', '#view-code'] }, { after: ['#claude-anchor', '#find-box'] },
    { tallest: ['#find-box', 28] },
    // The first match sits in folded lines, which open for it.
    { fill: ['#find-input', 'compute(1);'], wait: 400, expect: '#find-count', text: '1 of ' }, { expect: '.folded-body[hidden]', count: 5, shot: 'find.png' },
    { css: ['body', '::highlight(find-current)', 'text-decoration-line', 'underline'] },
    { css: ['body', '::highlight(find-match)', 'text-decoration-line', 'underline'] },
    { press: 'Shift+Enter', expect: '#find-count', text: ' of ' }, { absent: '#find-count:has-text("1 of ")' },
    { fill: ['#find-input', 'no such text'], wait: 400, expect: '#find-box.missing #find-count', text: 'No results' },
    { press: 'Escape', absent: '#find-box:visible' },
  ], { saved: { view: 'guide' } }),
  'find-options': scene(pullRequest, [
    { select: '#files td.code', press: 'ControlOrMeta+F', expect: '#find-input:focus', value: ['#find-input', '  const value1 = compute(1);'] },
    { fill: ['#find-input', 'CONST'], wait: 400, expect: '#find-count', text: ' of ' },
    { click: '#find-case', expect: '#find-case[aria-pressed=true]' }, { expect: '#find-box.missing #find-count', text: 'No results' },
    { press: 'Alt+C', expect: '#find-case[aria-pressed=false]' }, { expect: '#find-count', text: ' of ' },
    { fill: ['#find-input', 'valu'], wait: 400, expect: '#find-count', text: ' of ' },
    { click: '#find-word', expect: '#find-box.missing #find-count', text: 'No results' }, { click: '#find-word' },
    { fill: ['#find-input', 'compute\\(\\d+\\)'], wait: 400, expect: '#find-box.missing #find-count', text: 'No results' },
    { press: 'Alt+R', expect: '#find-regex[aria-pressed=true]' }, { expect: '#find-count', text: ' of ', shot: 'find-options.png' },
    { fill: ['#find-input', 'compute('], wait: 400, expect: '#find-box.missing #find-count', text: 'Invalid pattern' },
  ], { saved: { view: 'code' } }),
  // Selected code offers Comment, which opens the form on exactly the selected lines.
  'selection-comment': scene(pullRequest, [
    // One word: the form opens on its line and the word stays marked.
    { select: '.file[data-path="src/auth/user.ts"] td.code[data-line="2"] .hljs-keyword', expect: '#selection-comment:visible', shot: 'selection-word.png' },
    { press: 'Escape', absent: '#selection-comment:visible' },
    { select: '.file[data-path="src/auth/user.ts"] td.code[data-line="2"] .hljs-keyword', expect: '#selection-comment:visible' },
    { click: '#selection-comment', expect: '.file[data-path="src/auth/user.ts"] .thread.draft', text: 'Line 2' }, { highlight: ['comment-span', 'const'], expect: '.thread.draft textarea[placeholder="Ask about the marked text"]', shot: 'selection-marked.png' },
    { fill: ['.thread.draft textarea', 'Why const?'] }, { click: '.thread.draft button:has-text("Ask")' },
    { click: '.file[data-path="src/auth/user.ts"] .thread.draft button:has-text("Cancel")', highlight: ['comment-span', ''] },
    // A saved comment marks its text, and marks nothing once the lines hold other text.
    { send: { state: { ...pullRequest, threads: pullRequest.threads.map((each) => each.startLine === 7 ? { ...each, columns: { start: 2, end: 4 }, marked: 'if' } : each) } }, highlight: ['comment-span', 'if'] },
    { expect: '#thread-11111111-1111-1111-1111-111111111111 > summary', text: 'Line 7 · 3-4', hover: '#thread-11111111-1111-1111-1111-111111111111 > summary', highlight: ['comment-span-hovered', 'if'], shot: 'selection-hovered.png' },
    { send: { state: { ...pullRequest, threads: pullRequest.threads.map((each) => each.startLine === 7 ? { ...each, columns: { start: 2, end: 4 }, marked: 'xx' } : each) } }, highlight: ['comment-span', ''] },
    { send: { state: pullRequest } },
    { drag: ['.file[data-path="src/auth/user.ts"] td.code[data-line="2"]', '.file[data-path="src/auth/user.ts"] td.code[data-line="4"]'], expect: '#selection-comment:visible', shot: 'selection-comment.png' },
    { click: '#selection-comment', absent: '#selection-comment:visible' }, { expect: '.file[data-path="src/auth/user.ts"] .thread.draft', text: 'Lines 2–4' },
    { expect: '.file[data-path="src/auth/user.ts"] td.code.sel[data-line="2"]' }, { expect: '.file[data-path="src/auth/user.ts"] td.code.sel[data-line="4"]' }, { absent: '.file[data-path="src/auth/user.ts"] td.code.sel[data-line="5"]' },
    // A selection across a removed and an added line spans both sides, so it offers nothing.
    { click: '.file[data-path="src/auth/user.ts"] .thread.draft button:has-text("Cancel")' },
    { drag: ['.file[data-path="src/auth/user.ts"] tr.del td.code', '.file[data-path="src/auth/user.ts"] td.code[data-line="5"]'], absent: '#selection-comment:visible' },
  ], { saved: { view: 'code' } }),
  'find-typing': scene(pullRequest, [
    { press: 'ControlOrMeta+F' },
    { fill: ['#find-input', 'comp'], wait: 400, expect: '#find-count', text: ' of ' },
    { scroll: 100 },
    { fill: ['#find-input', 'compu'], stay: '#files', wait: 400 },
    { fill: ['#find-input', 'comput'], stay: '#files', wait: 400 },
    { fill: ['#find-input', 'compute'], stay: '#files', wait: 400, shot: 'find-typing.png' },
  ], { saved: { view: 'code' } }),
  'find-scroll': scene(pullRequest, [
    { scroll: 900 },
    { press: 'ControlOrMeta+F', stay: '#files', expect: '#find-input:focus' },
    { fill: ['#find-input', 'compute(1);'], wait: 400, expect: '#find-count', text: ' of ' },
    { scroll: 900 },
    { press: 'ControlOrMeta+F', stay: '#files', expect: '#find-input:focus' },
    { press: 'Escape' },
    { press: 'ControlOrMeta+F', stay: '#files', expect: '#find-input:focus', shot: 'find-scroll.png' },
  ], { saved: { view: 'code' } }),
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
  // A long step shortens the chip, which stays beside Finish review.
  'working-long-step': scene({ ...working, claude: { ...working.claude, text: 'Running sed -n 225,236p src/service/classification/classifier.py' } }, [{ next: ['#bar-review', '#claude-chip', 12], shot: 'working-long-step.png' }], { saved: { view: 'files' }, width: 1200 }),
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
    // A lane names its phase once, in its status; a bare "candidates" read like a count.
    { expect: '.review-lane:not(.orchestrator) .lane-status', text: 'Finding candidates' }, { absent: '.review-lane .lane-phase' }, { shot: 'claude-reviewing.png' },
    { send: { state: claudeIdle }, stay: '#files-bar', absent: '#stop-claude:visible' },
    { click: '#review-pick', expect: '.review-menu .picker-row:has-text("Docs")' }, { fill: ['#review-focus', 'the retry loop'], shot: 'review-focus.png' },
    { click: '#agent-review', absent: '#review-focus' },
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
  'find-narrow': scene(pullRequest, [
    { send: { find: true }, expect: '#find-box:visible' }, { fill: ['#find-input', 'compute(1);'], wait: 400 },
    { after: ['#find-box', '#view-code'] }, { after: ['#claude-anchor', '#find-box'] }, { after: ['#bar-review', '#claude-anchor'] }, { inside: ['#find-box', '#find-box'] }, { tallest: ['#files-bar', 60], shot: 'find-narrow.png' },
  ], { saved: { view: 'code' }, width: 600 }),
  'local-find': scene(local, [{ press: 'ControlOrMeta+F', stay: '#view-menu', expect: '#code-bar #find-box:visible #find-input:focus' }, { tallest: ['#find-box', 28], shot: 'local-find.png' }, { absent: '#files-bar #find-box' }]),
  // A folder outside Git names no branch and offers no code review.
  'local-plain': scene({ ...local, headBranch: '' }, [
    { expect: '#byline', text: 'Files in this folder, outside Git' }, { absent: '#byline .branch-ref' }, { click: '#claude-chip', expect: '#claude-menu:visible' }, { absent: '#review-tools:visible', shot: 'local-plain.png' },
  ]),
  local: scene(local, [
    { absent: '.tabs:visible' }, { absent: '#files-bar:visible' }, { absent: '#finish-review:visible' }, { absent: '#panel-overview:visible' },
    { expect: '#panel-files:visible .file', count: 4 }, { expect: '.head #claude-chip:visible' }, { expect: '#nav-threads .nav-name', text: 'Null check in parseUser' },
    { shot: 'local.png' }, { click: '#claude-chip', expect: '#claude-menu:visible' },
  ]),
  'local-saved-overview': scene(local, [{ expect: '#panel-files:visible .file', count: 4 }, { absent: '#panel-overview:visible' }, { absent: '.tabs:visible' }], { saved: { view: 'overview' }, width: 700 }),
  // The connect menu inside Claude's menu opens leftward when it would run past the window's right edge.
  'local-connect-menu': scene({ ...local, claude: { ...local.claude, link: { delivering: true, terminal: true } } }, [
    { click: '#claude-chip', expect: '#claude-menu:visible' }, { click: '#connect', expect: '.connect-menu:visible' },
    { inside: ['.connect-menu', 'body'], shot: 'local-connect-menu.png' },
  ], { width: 800 }),
  // An HTML preview sits on a white page like a browser's, with no help line, and its comment cards stay stacked when one grows in place.
  'html-margin': { state: htmlThreads, messages: [{ state: htmlThreads }, { files: [statusFile], selection: { range: { kind: 'all' }, whitespace: false }, atHead: true },
    { preview: { path: statusFile.path, kind: 'html', html: statusPreview, marker: 'lr-frame-fixture' } }],
  saved: { view: 'files', previewing: [statusFile.path] }, width: 1100, height: 900, steps: [
    { scrollTo: '.html-split', expect: '.html-margin > .thread', count: 2, wait: 600, css: ['.html-preview', '', 'background-color', 'rgb(255, 255, 255)'], absent: '.preview-note' },
    // The preview scrolls on its own, so a card's title sticks to the preview's top, not below the page's bars.
    { css: ['.html-margin > .thread > summary.strip', '', 'top', '0px'] },
    { click: '.html-margin .unfold', below: ['.html-margin > [data-anchor="h2222222-2222-2222-2222-222222222222"]', '.html-margin > [data-anchor="h1111111-1111-1111-1111-111111111111"]'], shot: 'html-margin.png' },
  ] },
  // A thread Claude works on offers its terminal when the conversation runs in one.
  'thread-terminal': { state: readme, messages: [{ state: readme }, { files: [retryFile], selection: { range: { kind: 'all' }, whitespace: false }, atHead: true }],
    saved: { view: 'files' }, width: 1100, height: 900, steps: [
      { scrollTo: '.claude-live', expect: '.claude-live .show-terminal' }, { level: ['.claude-live .show-terminal', '.claude-live .step:last-child .time'], shot: 'thread-terminal.png' },
      { send: { state: { ...readme, claude: { ...readme.claude, link: { delivering: true, terminal: false } } } }, absent: '.claude-live .show-terminal' },
    ] },
  // A connected conversation shows its context size; starting fresh or compacting stays in its terminal.
  'local-context': scene({ ...local, claude: { ...local.claude, context: { tokens: 48_200 }, link: { delivering: true, terminal: true } } }, [
    { click: '#claude-chip', expect: '#claude-menu #context:visible', text: '48k tokens' },
    { click: '#context', expect: '.context-menu', text: 'tokens after the last run', shot: 'local-context.png' }, { absent: '.context-menu .connect-row' },
  ], { width: 1000 }),
  // Hovering a code block in an answer shows Copy at its top right; it copies the code only.
  'code-copy': scene({ ...local, threads: local.threads.map((each) => ({ ...each, messages: [...each.messages, { author: 'claude' as const, createdAt: ago(1),
    html: '<p>Guard it:</p><pre><code><span class="hljs-keyword">if</span> (!input) <span class="hljs-keyword">return</span> undefined;\nreturn parse(input);</code></pre>' }] })) }, [
    { scroll: 200 }, { hover: '.msg-text pre', expect: '.code-copy:visible' }, { inside: ['.code-copy', '.msg-text pre'], shot: 'code-copy.png' },
    { click: '.code-copy', expect: '.code-copy.copied' }, { expect: 'body[data-copied="if (!input) return undefined;\\a return parse(input);"]' },
    { hover: '.file-head', absent: '.code-copy:visible' },
  ], { width: 1000 }),
  // Claude's file references link to files on the page: hover previews the lines, a click jumps there; other files stay plain code.
  'code-refs': scene({ ...local, threads: local.threads.map((each) => ({ ...each, messages: [...each.messages, { author: 'claude' as const, createdAt: ago(1),
    html: '<p>See <code class="code-ref" data-ref="src/api/client.ts:6">src/api/client.ts:6</code>, <code class="code-ref" data-ref="token.ts:5-6">token.ts:5-6</code> and <code class="code-ref" data-ref="src/other.ts:3">src/other.ts:3</code>.</p>' }] })) }, [
    { scroll: 200 }, { expect: '.msg-text code.code-ref.linked', count: 2 }, { absent: '.msg-text code.code-ref.linked[data-ref="src/other.ts:3"]' },
    { hover: '.msg-text code[data-ref="token.ts:5-6"]', expect: '.ref-preview:popover-open', text: 'src/auth/token.ts:5-6' },
    { expect: '.ref-preview tr.picked', count: 2 }, { tallest: ['.ref-preview td.ref-num', 20], shot: 'code-refs.png' },
    { click: '.msg-text code[data-ref="src/api/client.ts:6"]', absent: '.ref-preview:popover-open' },
    { expect: '.file[data-path="src/api/client.ts"] tr.ref-flash td.code[data-line="6"]', shot: 'code-refs-jump.png' },
  ], { width: 1000 }),
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
  // Split view swaps the colors into both sides.
  colorsLaterSplit: { state: pullRequest, messages: [{ state: pullRequest }, { ...filesMessage, files: uncolored }], saved: { view: 'files', layout: 'split' }, steps: [
    { scrollTo: '#files', absent: '#files td.code span' },
    { send: { colors: files }, expect: '.file[data-path="src/auth/user.ts"] td.code.del .hljs-keyword' },
    { expect: '.file[data-path="src/auth/user.ts"] td.code.add .hljs-keyword', shot: 'colors-split.png' },
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
  companion: { state: companion, messages: [{ state: companion }, { files: [retryFile], selection: { range: { kind: 'all' }, whitespace: false }, atHead: true }],
    saved: { view: 'files' }, width: 1100, height: 1100, steps: [
      { expect: 'canvas.orb.step[data-motion="reading"]' }, { expect: 'canvas.orb.step[data-motion="editing"]' }, { expect: 'canvas.orb.step[data-motion="thinking"]' },
      { expect: 'canvas.orb.step[data-motion="waiting"]' }, { scrollTo: '#files', wait: 600, shot: 'companion.png' },
    ] },
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
  get drafting() { return reviewingScenes['drafting']!; },
  get 'message-model'() { return reviewingScenes['message-model']!; },
  get 'ui-font-size'() { return reviewingScenes['ui-font-size']!; },
  get 'ui-font-size-guide'() { return reviewingScenes['ui-font-size-guide']!; },
  get submitted() { return reviewingScenes['submitted']!; },
  get githubMarkup() { return reviewingScenes['githubMarkup']!; },
  get stale() { return reviewingScenes['stale']!; },
  get 'review-clear'() { return reviewingScenes['review-clear']!; },
  get 'review-recheck'() { return reviewingScenes['review-recheck']!; },
  get previewRefresh() { return reviewingScenes['previewRefresh']!; },
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
  // Clear asks under its button, then the card goes once the extension sends the cleared state.
  'review-clear': { state: reviewing, messages: [{ state: reviewing }, filesMessage], saved: { view: 'files' }, width: 1100, steps: [
    { scrollTo: '#review-card', expect: '#review-card summary #review-clear' },
    { click: '#review-clear', expect: '.ask-menu .ask-text', text: 'Findings nobody answered are archived', shot: 'review-clear.png' },
    { click: '.ask-menu button:has-text("Cancel")', absent: '.ask-menu' }, { expect: '#review-card details[open]' },
    { click: '#review-clear', expect: '.ask-menu' }, { click: '.ask-menu button:has-text("Clear")', absent: '.ask-menu' }, { expect: '#review-card details[open]' },
    { send: { state: { ...reviewing, review: { running: false, picked: ['correctness'] } } }, absent: '#review-card:visible' },
  ] },
  // Re-check findings stays once every finding is resolved, to confirm they are fixed.
  'review-recheck': { state: reviewing, messages: [{ state: reviewing }, filesMessage], saved: { view: 'files' }, width: 1100, steps: [
    { scrollTo: '#review-card', expect: '.review-recheck', text: '1 open finding' },
    { send: { state: { ...reviewing, threads: reviewing.threads.map((each) => each.origin === 'review' ? { ...each, resolved: true } : each) } }, expect: '.review-recheck', text: 'All findings resolved' },
    { click: '.review-recheck button:has-text("Re-check findings")', shot: 'review-recheck.png' },
  ] },
  // Hovering Claude's Diff pair names the model that wrote the message, in a tip that stays on screen.
  'message-model': scene(pullRequest, [
    { hover: '.file[data-path="src/auth/user.ts"] .msg .orb-avatar', wait: 600, shot: 'message-model.png' },
    { css: ['.file[data-path="src/auth/user.ts"] .msg .orb-avatar', '::after', 'content', '"Claude · claude-opus-5-5"'] },
    { css: ['.file[data-path="src/auth/user.ts"] .msg .orb-avatar', '::after', 'left', '0px'] },
  ], { saved: { view: 'code' } }),
  // diffGuide.fontSize sizes the page's text and the boxes holding it, and the code keeps the editor's size.
  'ui-font-size': scene(pullRequest, [
    { css: ['.file[data-path="src/auth/user.ts"] .thread', '', 'font-size', '13px'], expect: '.file[data-path="src/auth/user.ts"] td.code' },
    { send: { fontSize: 16 }, css: ['.file[data-path="src/auth/user.ts"] .thread', '', 'font-size', '17.3333px'] },
    { css: ['.file[data-path="src/auth/user.ts"] .thread', '', 'line-height', '26.6667px'] },
    { css: ['.claude-chip', '', 'min-height', '29.3333px'] }, { css: ['#files-bar .tabs button', '', 'font-size', '18.6667px'] },
    { inside: ['.claude-chip', '.claude-chip'] }, { inside: ['.tabs .count', '.tabs .count'] }, { inside: ['label.viewed', 'label.viewed'] },
    { css: ['.file[data-path="src/auth/user.ts"] tr.hunk td', '', 'font-size', '11px'], shot: 'ui-font-size.png' },
  ], { saved: { view: 'code' } }),
  'ui-font-size-guide': scene(pullRequest, [{ send: { fontSize: 16 }, wait: 300, shot: 'ui-font-size-guide.png' }], { saved: { view: 'code', order: 'guide' } }),
  // Draft reply shows Claude at work under the form, with Stop, until the draft or an error arrives.
  drafting: scene(submitted, [
    { click: '.file[data-path="src/auth/user.ts"] button:has-text("Draft reply")', expect: '.claude-live.drafting .step-call', text: 'Drafting' },
    { expect: '.claude-live.drafting .stop-claude:enabled', shot: 'drafting.png' },
    { click: '.claude-live.drafting .stop-claude', expect: '.claude-live.drafting .stop-claude:disabled' },
    { send: { error: 'Drafting stopped.', form: 'draft:g1' }, absent: '.claude-live.drafting' },
  ], { saved: { view: 'code', replies: { g1: 'say it is fixed' } } }),
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
  // A previewed file that changes on disk reads its preview again.
  previewRefresh: { state: pullRequest, messages: [{ state: pullRequest }, filesMessage], saved: { view: 'files', previewing: ['README.md'] }, steps: [
    { send: { preview: { path: 'README.md', kind: 'markdown', blocks: [{ startLine: 1, endLine: 1, html: '<p>Old text</p>' }] } }, expect: '#files', text: 'Old text' },
    { send: { ...filesMessage, files: files.map((each) => each.path === 'README.md' ? { ...each, additions: 7 } : each) }, expect: '#files', text: 'Loading preview' },
    { send: { preview: { path: 'README.md', kind: 'markdown', blocks: [{ startLine: 1, endLine: 1, html: '<p>New text</p>' }] } }, expect: '#files', text: 'New text', shot: 'preview-refresh.png' },
  ] },
};
