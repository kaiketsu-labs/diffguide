import type { ChangeRequestConversation, ChangeRequestDetails, ChangeRequestFile, ChangeRequestSummary, ConversationComment, Label, Milestone, RemoteThread, TimelineItem } from '../../core/forge.js';
import type { Severity } from '../../core/prAnalysis.js';

/*
 * The seed data of the demo pull request. Its commit ids come from the sample repository
 * recipe (`sampleRepo.ts`); `test/demoForge.test.ts` fails when the recipe and these ids drift apart.
 */

export const demoRepository = { name: 'acme/field-notes', url: 'https://github.com/acme/field-notes' } as const;
export const demoNumber = 142;
export const viewerLogin = 'you';

/** Commit ids the sample repository recipe produces. */
export const demoCommits = {
  base: 'f39c21760d6aaf22acfd74240cc662c57bad898e',
  pushed: [
    '0c6deb1984df5c05f88cbba666ee7a0eabcc0aed',
    'f4d5ba0a1c2ca3f7c8067b09851f09db0855095f',
    'bd304861928dcef9ba2aff1aebd2942ee1e73929',
    'a8a122ecd4f1528130d87c3227878a69a43a0b74',
  ],
} as const;
const head = demoCommits.pushed[3];

const paragraphs = (text: string): string => text.split('\n\n').map((part) => `<p>${part.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll(/`([^`]+)`/g, '<code>$1</code>')}</p>`).join('');

/** A comment by `author` with the bits the page needs to show and edit it. */
function comment(id: string, author: string, createdAt: string, body: string): ConversationComment {
  const own = author === viewerLogin;
  return { id, author, avatarUrl: '', createdAt, bodyHtml: paragraphs(body), body, canEdit: own, canDelete: own, canHide: false, canReact: true, edited: false, reactions: [] };
}

const summary: ChangeRequestSummary = {
  number: demoNumber, title: 'feat(export): stream notes as newline-delimited JSON', url: `${demoRepository.url}/pull/${demoNumber}`, author: viewerLogin, draft: false,
  headBranch: 'feature/streaming-export', baseBranch: 'main', headOid: head, review: 'approved',
  createdAt: '2025-03-04T10:30:00Z', updatedAt: '2025-03-05T16:20:00Z',
  changes: { additions: 125, deletions: 20, files: 11 },
  requestedReviewers: [{ name: 'carol', team: false }, { name: 'Core', team: true }],
};

const files: readonly ChangeRequestFile[] = [
  { path: 'README.md', additions: 8, deletions: 0, change: 'modified' },
  { path: 'docs/export.md', additions: 27, deletions: 0, change: 'added' },
  { path: 'docs/guide.md', additions: 6, deletions: 1, change: 'modified' },
  { path: 'docs/legacy.md', additions: 0, deletions: 9, change: 'deleted' },
  { path: 'docs/release-notes.html', additions: 32, deletions: 0, change: 'added' },
  { path: 'src/export/stream.ts', additions: 32, deletions: 0, change: 'added' },
  { path: 'src/index.ts', additions: 1, deletions: 0, change: 'modified' },
  { path: 'src/notes/format.ts', additions: 3, deletions: 3, change: 'modified' },
  { path: 'src/notes/migrate.ts', additions: 7, deletions: 7, change: 'renamed' },
  { path: 'src/notes/store.ts', additions: 4, deletions: 0, change: 'modified' },
  { path: 'test/format.test.ts', additions: 5, deletions: 0, change: 'modified' },
];

const labels: readonly Label[] = [
  { name: 'enhancement', color: 'a2eeef', description: 'New feature or request' },
  { name: 'docs', color: '0075ca', description: 'Documentation only' },
  { name: 'needs-review', color: 'fbca04' },
];
const milestones: readonly Milestone[] = [{ number: 7, title: '2.4' }, { number: 8, title: '2.5' }];

const description = `Notes can now be exported as newline-delimited JSON without loading the whole file into memory.

- \`store.exportTo(file)\` streams notes in batches and waits for the disk between them.
- The v1 importer is now \`migrateNotes\` and tags what it imports.
- Docs and release notes cover the new export.

Closes #118.`;

const details: ChangeRequestDetails = {
  bodyHtml: paragraphs(description.split('\n\n').filter((part) => !part.startsWith('- ')).join('\n\n')) + '<ul><li><code>store.exportTo(file)</code> streams notes in batches and waits for the disk between them.</li><li>The v1 importer is now <code>migrateNotes</code> and tags what it imports.</li><li>Docs and release notes cover the new export.</li></ul>',
  title: summary.title, body: description, open: true, merged: false, draft: false, canEdit: true, branchDeletable: false,
  labels: [labels[0] as Label, labels[1] as Label], assignees: [viewerLogin], mergeable: 'yes',
  viewerIsAuthor: true, viewerAvatarUrl: '', viewerName: 'You', mergeMethods: ['squash', 'merge', 'rebase'],
  reviewers: [
    { name: 'alice', state: 'approved' },
    { name: 'bob', state: 'commented' },
    { name: 'carol', state: 'requested' },
    { name: 'Core', state: 'requested', team: 'core' },
  ],
  checks: [
    { name: 'build', state: 'success' },
    { name: 'lint', state: 'pending' },
    { name: 'e2e', state: 'failure' },
    { name: 'docs preview', state: 'neutral' },
  ],
  milestone: milestones[0] as Milestone,
};

const thread = (id: string, path: string, line: number, state: Partial<Pick<RemoteThread, 'resolved' | 'outdated' | 'diffHunk'>>, comments: readonly ConversationComment[]): RemoteThread => ({
  id, path, side: 'RIGHT', startLine: line, endLine: line, outdated: false, resolved: false, url: `${demoRepository.url}/pull/${demoNumber}#discussion_${id}`, pending: false,
  comments: comments.map((each) => ({ ...each, pending: false })), ...state,
});

/** Review threads in every state: open, answered, resolved and outdated. */
const threads: readonly RemoteThread[] = [
  thread('t-open', 'src/export/stream.ts', 16, {}, [
    comment('c-open', 'alice', '2025-03-04T11:02:00Z', 'This cast hides a real case: `options.tag` is read again inside the callback. Copy it to a `const` first and the cast goes away.'),
  ]),
  thread('t-answered', 'src/export/stream.ts', 27, {}, [
    comment('c-answered-1', 'bob', '2025-03-04T11:20:00Z', 'What happens when `drain` never fires, for example when the file is deleted mid-export?'),
    comment('c-answered-2', viewerLogin, '2025-03-04T12:05:00Z', 'The stream emits `error` in that case and `once` rejects, so the export fails loudly. I added a test for it.'),
    comment('c-answered-3', 'bob', '2025-03-04T12:40:00Z', 'Makes sense. Thanks for covering it.'),
  ]),
  thread('t-resolved', 'src/notes/format.ts', 12, { resolved: true }, [
    comment('c-resolved-1', 'alice', '2025-03-04T15:10:00Z', 'Why raise the preview length to 160?'),
    comment('c-resolved-2', viewerLogin, '2025-03-04T15:30:00Z', 'Two lines of the list view fit about 160 characters at the default width.'),
  ]),
  thread('t-outdated', 'src/export/stream.ts', 24, { outdated: true, diffHunk: '@@ -0,0 +21,4 @@\n+export async function exportNotes(notes: readonly Note[], file: string): Promise<number> {\n+  const lines = toLines(notes);\n+  const output = createWriteStream(file);' }, [
    comment('c-outdated', 'carol', '2025-03-04T10:50:00Z', 'Should `file` be opened with the `wx` flag so an export never overwrites a backup by accident?'),
  ]),
];

/** Conversation, oldest first: commits, an opening comment, and the reviews that carry the diff comments above. */
const timeline: readonly TimelineItem[] = [
  { kind: 'event', id: 'e-opened', actor: viewerLogin, avatarUrl: '', createdAt: '2025-03-04T10:30:00Z', text: 'opened this pull request' },
  { kind: 'commit', id: 'k-1', oid: demoCommits.pushed[0], headline: 'feat(export): stream notes as newline-delimited JSON', message: 'feat(export): stream notes as newline-delimited JSON', author: 'Maya Chen', avatarUrl: '', createdAt: '2025-03-04T10:15:00Z', checks: 'success', additions: 37, deletions: 0, files: 3 },
  { kind: 'comment', ...comment('i-1', 'carol', '2025-03-04T10:45:00Z', 'Nice. Could you add a note to the docs about reading a large export without loading it whole?') },
  { kind: 'review', ...comment('r-1', 'carol', '2025-03-04T10:50:00Z', 'One question on opening the file.'), state: 'commented', commit: demoCommits.pushed[0], comments: ['c-outdated'] },
  { kind: 'review', ...comment('r-2', 'alice', '2025-03-04T11:02:00Z', 'Looks good overall, two small things.'), state: 'commented', commit: demoCommits.pushed[0], comments: ['c-open', 'c-resolved-1'] },
  { kind: 'review', ...comment('r-3', 'bob', '2025-03-04T11:20:00Z', 'Checking the failure path.'), state: 'commented', commit: demoCommits.pushed[0], comments: ['c-answered-1'] },
  { kind: 'commit', id: 'k-2', oid: demoCommits.pushed[1], headline: 'refactor(notes): rename the legacy importer to migrate', message: 'refactor(notes): rename the legacy importer to migrate', author: 'Maya Chen', avatarUrl: '', createdAt: '2025-03-04T14:40:00Z', checks: 'success', additions: 25, deletions: 9, files: 2 },
  { kind: 'commit', id: 'k-3', oid: demoCommits.pushed[2], headline: 'docs: add the export guide and release notes', message: 'docs: add the export guide and release notes', author: 'Maya Chen', avatarUrl: '', createdAt: '2025-03-05T09:20:00Z', checks: 'pending', additions: 73, deletions: 10, files: 5 },
  { kind: 'event', id: 'e-label', actor: viewerLogin, avatarUrl: '', createdAt: '2025-03-05T09:25:00Z', text: 'added the docs label' },
  { kind: 'commit', id: 'k-4', oid: demoCommits.pushed[3], headline: 'fix(format): drop the space before a title ellipsis', message: 'fix(format): drop the space before a title ellipsis', author: 'Maya Chen', avatarUrl: '', createdAt: '2025-03-05T16:05:00Z', checks: 'failure', additions: 8, deletions: 1, files: 2 },
  { kind: 'review', ...comment('r-4', 'alice', '2025-03-05T16:30:00Z', 'Approved. The rename and the docs read well.'), state: 'approved', commit: head, comments: [] },
];

const conversation: ChangeRequestConversation = {
  timeline,
  description: { id: 'pr-142', reactions: [{ content: 'ROCKET', count: 2, viewerReacted: false }], canReact: true },
  viewerLogin, permission: 'write',
  merge: { state: 'unstable', reviewDecision: 'required', canUpdateBranch: false, canBypass: false, canEnableAutoMerge: false, canDisableAutoMerge: false, autoMergeAllowed: true, mergeQueue: false, headOid: head, headDeleted: false },
  checks: [
    { name: 'build', required: true, annotations: [] },
    { name: 'lint', required: true, annotations: [] },
    { name: 'e2e', required: false, runId: 9001, annotations: [{ path: 'src/export/stream.ts', startLine: 26, endLine: 26, level: 'failure', title: 'Export test timed out', message: 'The batch loop did not finish within 5000 ms.' }] },
  ],
  linkedIssues: [{ number: 118, title: 'Export notes without loading them all into memory', url: `${demoRepository.url}/issues/118`, open: true }],
  reviewIds: { alice: 'r-4' },
  commitDefaults: { squashTitle: 'COMMIT_OR_PR_TITLE', squashBody: 'COMMIT_MESSAGES', mergeTitle: 'MERGE_MESSAGE', mergeBody: 'PR_TITLE' },
  lastReviewedCommit: demoCommits.pushed[2],
  awaitingApproval: [],
};

export interface DemoGuideStep { readonly title: string; readonly note: string; readonly transition?: string; readonly path: string }
export interface DemoGuideChapter { readonly severity: Severity; readonly title: string; readonly steps: readonly DemoGuideStep[] }
export interface DemoGuide { readonly overview: string; readonly files: readonly { readonly path: string; readonly note: string }[]; readonly chapters: readonly DemoGuideChapter[] }
/** A thread of the review that only this machine keeps; `answer` is what Claude replied. */
export interface DemoLocalThread { readonly path: string; readonly startLine: number; readonly endLine: number; readonly question: string; readonly answer: { readonly title: string; readonly text: string }; readonly resolved: boolean }

/** Claude's guide for the demo PR: four chapters that cover every file. */
const guide: DemoGuide = {
  overview: 'Adds streaming export of notes and renames the v1 importer. The risk is in the export loop: it must wait for the disk and fail loudly when the file goes away.',
  files: [{ path: 'src/export/stream.ts', note: 'New. Writes notes in batches and applies backpressure.' }],
  chapters: [
    { severity: 'critical', title: 'Streaming export', steps: [
      { path: 'src/export/stream.ts', title: 'Batch and wait for the disk', note: 'Writes notes in batches and awaits `drain` between them. Check that an `error` event on the stream rejects the export instead of hanging.' },
      { path: 'src/notes/store.ts', title: 'Expose export on the store', note: 'Adds `exportTo` to the store, delegating to the stream. The store keeps its notes in memory, so only the file side is streamed.', transition: 'The stream is useless until the store can call it.' },
    ] },
    { severity: 'significant', title: 'Importer rename', steps: [
      { path: 'src/notes/migrate.ts', title: 'Rename and tag imports', note: 'The importer becomes `migrateNotes`, accepts notes without a name or text, and tags imports. Check that old callers of `importLegacy` are gone.' },
    ] },
    { severity: 'routine', title: 'Format tweaks', steps: [
      { path: 'src/notes/format.ts', title: 'Preview length and stable order', note: 'A longer preview, a tie-break by id so grouping is stable, and no space before the ellipsis.' },
      { path: 'src/index.ts', title: 'Export the new function', note: 'One line that re-exports `exportNotes` from the package entry.' },
    ] },
    { severity: 'trivial', title: 'Docs and release notes', steps: [
      { path: 'docs/export.md', title: 'Export guide', note: 'New page: options and reading an export line by line.' },
      { path: 'docs/release-notes.html', title: 'Release notes page', note: 'A static page for the 2.4 release; open the preview to see it.' },
      { path: 'README.md', title: 'Mention export', note: 'A short export example and a link to the guide.' },
    ] },
  ],
};

const localThreads: readonly DemoLocalThread[] = [
  { path: 'src/export/stream.ts', startLine: 25, endLine: 28, question: 'Does this loop keep memory flat for a million notes?', resolved: false,
    answer: { title: 'Memory stays flat', text: 'Yes for the file side: each batch is joined and written, then `drain` pauses the loop. The notes themselves are still in memory in the store, so the peak is the store plus one batch of text.' } },
  { path: 'src/notes/migrate.ts', startLine: 15, endLine: 15, question: 'Why six words for the fallback title?', resolved: true,
    answer: { title: 'Fallback title length', text: 'It is a convention, not a rule: six words fit the list view without the ellipsis. `shortTitle` still cuts at 80 characters if the words are long.' } },
];

const other = (number: number, title: string, author: string, draft: boolean, headBranch: string, review?: ChangeRequestSummary['review']): ChangeRequestSummary => ({
  number, title, url: `${demoRepository.url}/pull/${number}`, author, draft, headBranch, baseBranch: 'main', ...review === undefined ? {} : { review },
  createdAt: new Date(Date.UTC(2025, 2, 6) - number * 3_600_000).toISOString(), updatedAt: new Date(Date.UTC(2025, 2, 6) - number * 60_000).toISOString(),
  changes: { additions: 60, deletions: 15, files: 3 },
});

/** The demo pull request, the sidebar's other sample rows, and the review data seeded into its worktree. */
export const demoFixture = {
  summary, files, details, threads, conversation, guide, localThreads, labels, milestones, users: ['alice', 'bob', 'carol', viewerLogin],
  mine: [summary, other(101, 'Add pull request sidebar', viewerLogin, false, 'feature/pr-sidebar', 'approved'), other(102, 'Track reviewed files per PR', viewerLogin, true, 'feature/reviewed-files')],
  reviewRequested: [
    other(201, 'Migrate auth to OAuth device flow', 'alice', false, 'refactor/auth-migration', 'changes'),
    other(202, 'Cache diff results per commit', 'bob', false, 'perf/diff-cache', 'commented'),
    other(203, 'Draft: new settings page', 'carol', true, 'ui/settings-page'),
  ],
} as const;
