import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { useGitHubHost } from '../src/forges/github/githubApi.js';
import { GitHubApiProvider } from '../src/forges/github/provider.js';

test('reads GitHub\'s viewed files from the file list already on its way, not with a second request', async (t) => {
  const repo = mkdtempSync(join(tmpdir(), 'diffguide-files-'));
  execFileSync('git', ['init', '--quiet', repo]);
  execFileSync('git', ['-C', repo, 'remote', 'add', 'origin', 'https://github.com/acme/app.git']);
  useGitHubHost({ token: async () => 'token', enterpriseUri: () => undefined, onDidChangeSessions: () => ({ dispose: () => undefined }) });
  const realFetch = globalThis.fetch;
  let fileLists = 0;
  globalThis.fetch = (async (_url: string, init: { body?: string }) => {
    const { query } = JSON.parse(init.body ?? '{}') as { query: string };
    if (query.includes('files(')) fileLists++;
    await new Promise((resolve) => setTimeout(resolve, 20));
    const nodes = [{ path: 'a.ts', additions: 1, deletions: 0, changeType: 'MODIFIED', viewerViewedState: 'VIEWED' }, { path: 'b.ts', additions: 1, deletions: 0, changeType: 'ADDED', viewerViewedState: 'UNVIEWED' }];
    return new Response(JSON.stringify({ data: { repository: { nameWithOwner: 'acme/app', pullRequest: { files: { nodes, pageInfo: { hasNextPage: false, endCursor: null } } } } } }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  t.after(() => { globalThis.fetch = realFetch; rmSync(repo, { recursive: true, force: true }); });

  const provider = await GitHubApiProvider.connect(repo);
  const [files, viewed] = await Promise.all([provider.listFiles(7), provider.viewedFiles(7)]);
  assert.deepEqual(files.map((file) => file.path), ['a.ts', 'b.ts']);
  assert.deepEqual([...viewed], ['a.ts']);
  assert.equal(fileLists, 1);
});
