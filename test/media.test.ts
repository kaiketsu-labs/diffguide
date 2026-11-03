import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

import { readGitBaseBytes } from '../src/git.js';
import { mediaType } from '../src/media.js';

test('previews images, SVG and PDF by extension, and nothing else', () => {
  assert.equal(mediaType('docs/Logo.PNG'), 'image/png');
  assert.equal(mediaType('a/b.svg'), 'image/svg+xml');
  assert.equal(mediaType('spec.pdf'), 'application/pdf');
  assert.equal(mediaType('src/app.ts'), undefined);
  assert.equal(mediaType('Makefile'), undefined);
});

test('reads binary bytes at a commit unchanged and refuses oversized files and moving revisions', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'pair-review-media-'));
  t.after(async () => { await rm(root, { recursive: true, force: true }); });
  const git = (...args: string[]) => promisify(execFile)('git', ['-C', root, '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'commit.gpgSign=false', ...args]);
  await git('init', '--quiet');
  const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff, 0x0a, 0x00]);
  await writeFile(path.join(root, 'logo.png'), bytes);
  await git('add', '.');
  await git('commit', '--quiet', '-m', 'logo');
  const revision = (await git('rev-parse', 'HEAD')).stdout.trim();

  assert.deepEqual(await readGitBaseBytes(root, 'logo.png', revision, 1024), bytes);
  await assert.rejects(readGitBaseBytes(root, 'logo.png', revision, 4));
  await assert.rejects(readGitBaseBytes(root, 'logo.png', 'HEAD', 1024));
  await assert.rejects(readGitBaseBytes(root, '../logo.png', revision, 1024));
});
