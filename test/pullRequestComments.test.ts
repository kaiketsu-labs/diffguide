import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { diffRanges, githubFeedbackRequest, readGitHubLinks, writeGitHubLinks } from '../src/pullRequestComments.js';
import { buildOverviewState, overviewHtml } from '../src/pullRequestOverview.js';
import type { PullRequestSession } from '../src/pullRequestSessions.js';

test('reads the lines each side of a diff shows, so comments outside it go on the whole file', () => {
  const diff = '@@ -1,3 +1,4 @@\n a\n+b\n@@ -20 +21,0 @@\n-c\n@@ -40,2 +41,6 @@\n';
  assert.deepEqual(diffRanges(diff, 'RIGHT'), [{ start: 1, end: 4 }, { start: 41, end: 46 }]);
  assert.deepEqual(diffRanges(diff, 'LEFT'), [{ start: 1, end: 3 }, { start: 20, end: 20 }, { start: 40, end: 41 }]);
});

test('summarizes a PR for its overview and keeps model text out of the page markup', () => {
  const thread = {
    id: 't1', intent: 'ask', status: 'answered', resolved: false, outdated: false, latestEventId: 'e1',
    anchor: { path: 'src/a.ts', startLine: 12, endLine: 14, side: 'working', selectedText: 'retry();' }, messages: [{ id: 'm1', author: 'human', text: 'Why\n</script><b>?', createdAt: '' }],
  };
  const opened = {
    session: {
      store: { threads: [thread] },
      activity: () => undefined,
      publication: () => ({ url: 'https://github.com/acme/app/pull/3#r1', pending: true }),
    },
    runner: { activity: { running: true, step: 'Reading src/a.ts', threads: new Set(), skipped: 0 } },
  } as unknown as PullRequestSession;
  const state = buildOverviewState({
    number: 3, title: 'Mock data', url: 'https://github.com/acme/app/pull/3', author: 'alice', draft: false, headBranch: 'feature', baseBranch: 'main',
  }, opened, ['src/a.ts'], [], 3, undefined, [{
    id: 'PRRT_1', path: 'src/b.ts', side: 'LEFT', startLine: 4, endLine: 5, outdated: true, resolved: false, url: 'https://github.com/acme/app/pull/3#discussion_r9',
    pending: true, comments: [{ id: 'C1', author: 'bob', avatarUrl: 'https://avatars.githubusercontent.com/bob', pending: true, bodyHtml: '<p>Rename &amp; </p><script>x</script><u>', canDelete: true, createdAt: '2026-01-01T00:00:00Z',
      body: 'Rename\n```suggestion\nconst renamed = 1;\n```', canEdit: true, canHide: false, canReact: true, edited: false, reactions: [{ content: 'HEART', count: 2, viewerReacted: true }] }],
  }]);
  assert.deepEqual(state.github, [{ id: 'PRRT_1', location: 'src/b.ts:4', text: 'Rename & x', status: 'Pending · Outdated', url: 'https://github.com/acme/app/pull/3#discussion_r9',
    path: 'src/b.ts', side: 'old', startLine: 4, endLine: 5, outdated: true, resolved: false, pending: true, messages: [{ id: 'C1', author: 'bob', avatarUrl: 'https://avatars.githubusercontent.com/bob', pending: true, html: '<p>Rename &amp; </p><script>x</script><u>', canDelete: true, createdAt: '2026-01-01T00:00:00Z',
      body: 'Rename\n```suggestion\nconst renamed = 1;\n```', canEdit: true, canHide: false, canReact: true, edited: false, reactions: [{ content: 'HEART', count: 2, viewerReacted: true }], suggestion: true }] }]);
  assert.deepEqual([state.author, state.headBranch, state.baseBranch], ['alice', 'feature', 'main']);
  assert.deepEqual(state.claude, { text: 'Claude · Reading src/a.ts', running: true, retry: false });
  assert.deepEqual(state.threads, [{ id: 't1', location: 'src/a.ts:12', text: 'Why </script><b>?', status: 'Answered · On GitHub (pending)', url: 'https://github.com/acme/app/pull/3#r1',
    path: 'src/a.ts', side: 'new', startLine: 12, endLine: 14, resolved: false, messages: [{ author: 'human', html: '<p>Why<br>&lt;/script&gt;&lt;b&gt;?</p>', createdAt: '' }],
  }]);
  const html = overviewHtml(state, 'overview.js', 'https://example.test/</script><i>.svg');
  assert.ok(!html.includes('</script><b>') && !html.includes('</script><i>') );
});

test('quotes a GitHub thread for Claude after the user\'s note, or a default for the intent', () => {
  const comments = [{ author: 'bob', body: 'Rename x\n\nto userId.' }, { author: 'alice', body: 'Agreed ' }];
  assert.equal(githubFeedbackRequest(' Also the tests ', 'implement', comments),
    'Also the tests\n\nGitHub thread:\n\n> **@bob:**\n> Rename x\n>\n> to userId.\n>\n> **@alice:**\n> Agreed');
  assert.match(githubFeedbackRequest('', 'implement', comments), /^Address this feedback from GitHub\./u);
  assert.match(githubFeedbackRequest('  ', 'ask', comments), /^What do you think of this feedback from GitHub\?/u);
});

test('keeps links from local threads to GitHub threads across restarts and drops malformed ones', async () => {
  const dataPath = await mkdtemp(join(tmpdir(), 'links-'));
  assert.equal((await readGitHubLinks(dataPath)).size, 0);
  await writeGitHubLinks(dataPath, new Map([['local-1', { id: 'PRRT_1', url: 'https://github.com/acme/app/pull/7#discussion_r1' }], ['bad', { id: 'x', url: 'http://evil' }]]));
  assert.deepEqual([...await readGitHubLinks(dataPath)], [['local-1', { id: 'PRRT_1', url: 'https://github.com/acme/app/pull/7#discussion_r1' }]]);
});
