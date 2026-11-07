import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

import { readGitBaseBytes } from '../src/git.js';
import { inlineLocalImages } from '../src/markdown.js';
import { mediaType } from '../src/media.js';

test('previews images, SVG and PDF by extension, and nothing else', () => {
  assert.equal(mediaType('docs/Logo.PNG'), 'image/png');
  assert.equal(mediaType('a/b.svg'), 'image/svg+xml');
  assert.equal(mediaType('spec.pdf'), 'application/pdf');
  assert.equal(mediaType('src/app.ts'), undefined);
  assert.equal(mediaType('Makefile'), undefined);
});

test('reads binary bytes at a commit unchanged and refuses oversized files and moving revisions', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'diffguide-media-'));
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

test('embeds Markdown images from the repository and leaves remote, outside and unreadable ones alone', async () => {
  const read: string[] = [];
  const readImage = async (image: string) => { read.push(image); return image === 'docs/missing.png' ? undefined : Buffer.from(image); };
  const html = '<p><img src="assets/chart.png" alt="a"><img src="/logo%20big.svg" alt="b"><img src="https://x.test/c.png" alt="c">'
    + '<img src="../../etc/d.png" alt="d"><img src="missing.png" alt="e"><img src="notes.txt" alt="f"><img src="assets/chart.png?raw=1" alt="g"></p>';
  const out = await inlineLocalImages(html, 'docs/README.md', readImage);
  assert.ok(out.includes(`<img src="data:image/png;base64,${Buffer.from('docs/assets/chart.png').toString('base64')}" alt="a">`));
  assert.ok(out.includes(`<img src="data:image/svg+xml;base64,${Buffer.from('logo big.svg').toString('base64')}" alt="b">`));
  for (const kept of ['https://x.test/c.png', '../../etc/d.png', 'missing.png', 'notes.txt']) assert.ok(out.includes(`<img src="${kept}"`), kept);
  assert.ok(!out.includes('chart.png?raw=1'));
  assert.deepEqual(read.sort(), ['docs/assets/chart.png', 'docs/assets/chart.png', 'docs/missing.png', 'logo big.svg']);
});
