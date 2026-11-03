import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { readCustomInstructions } from '../src/customInstructions.js';

async function put(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, text);
}

async function layout(): Promise<{ home: string; config: string; project: string }> {
  const home = await realpath(await mkdtemp(join(tmpdir(), 'instructions-')));
  const config = join(home, '.claude-personal');
  const project = join(home, 'work', 'app');
  await mkdir(project, { recursive: true });
  return { home, config, project };
}

test('instructions join from the most general file to the most specific', async () => {
  const { home, config, project } = await layout();
  const slug = project.replace(/[^a-zA-Z0-9]/gu, '-');
  await put(join(config, 'local-review', 'analysis.md'), 'global');
  await put(join(home, 'work', '.claude', 'local-review', 'analysis.md'), 'parent');
  await put(join(project, '.claude', 'local-review', 'analysis.md'), 'repository');
  await put(join(config, 'projects', slug, 'local-review', 'analysis.md'), 'personal project');
  await put(join(home, '.claude', 'local-review', 'analysis.md'), 'home folder is not a parent layer');
  await put(join(project, '.claude', 'local-review', 'ask.md'), 'other kind');

  const text = await readCustomInstructions('analysis', { projectRoot: project, repository: { cwd: project }, configRoot: config, home });
  const order = ['global', 'parent', 'repository', 'personal project'].map((value) => text.indexOf(`\n${value}`));
  assert.ok(order.every((position, index) => position > 0 && (index === 0 || position > (order[index - 1] ?? 0))), text);
  assert.ok(!text.includes('home folder') && !text.includes('other kind'));
});

test('no files give no instructions', async () => {
  const { home, config, project } = await layout();
  const text = await readCustomInstructions('ask', { projectRoot: project, repository: { cwd: project }, configRoot: config, home });
  assert.equal(text, '');
});

test('a revision reads the repository file from that commit, not from the checkout', async () => {
  const { home, config, project } = await layout();
  const run = (...args: string[]): string => execFileSync('git', ['-C', project, ...args], { encoding: 'utf8' }).trim();
  run('init', '-q');
  await put(join(project, '.claude', 'local-review', 'ask.md'), 'from base');
  run('add', '.');
  run('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'base');
  const base = run('rev-parse', 'HEAD');
  await put(join(project, '.claude', 'local-review', 'ask.md'), 'from the pull request');

  const sources = { projectRoot: project, configRoot: config, home };
  const trusted = await readCustomInstructions('ask', { ...sources, repository: { cwd: project, revision: base } });
  assert.ok(trusted.includes('from base') && !trusted.includes('from the pull request'));
  const missing = await readCustomInstructions('analysis', { ...sources, repository: { cwd: project, revision: base } });
  assert.equal(missing, '');
});
