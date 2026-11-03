import { readFile, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { git } from './worktrees.js';

/** Which Claude run the instructions are for: the guided-review analysis, or answers to review comments. */
export type InstructionKind = 'analysis' | 'ask';

/** Where to look for a user's own instructions. */
export interface InstructionSources {
  /** The project folder; parent folders and Claude's per-project folder are found from it. */
  readonly projectRoot: string;
  /** Where the repository's own file is read: its working copy, or a revision when the checkout holds someone else's code. */
  readonly repository: { readonly cwd: string; readonly revision?: string };
  readonly configRoot?: string;
  readonly home?: string;
}

const folder = join('.claude', 'local-review');

/**
 * The user's instructions for a run, from the most general file to the most specific:
 * Claude's config folder, parent folders of the project, the repository, then Claude's per-project folder.
 * Returns an empty string when no file exists.
 */
export async function readCustomInstructions(kind: InstructionKind, sources: InstructionSources): Promise<string> {
  const home = resolve(sources.home ?? homedir());
  const configRoot = resolve(sources.configRoot ?? process.env['CLAUDE_CONFIG_DIR'] ?? join(home, '.claude'));
  const projectRoot = resolve(sources.projectRoot);
  const name = `${kind}.md`;
  const fromFile = (path: string): Promise<{ path: string; text: string | undefined }> =>
    readFile(path, 'utf8').then((text) => ({ path, text }), () => ({ path, text: undefined }));

  const parents: string[] = [];
  for (let current = dirname(projectRoot); current !== home && current !== dirname(current); current = dirname(current)) {
    parents.unshift(join(current, folder, name));
  }
  const { cwd, revision } = sources.repository;
  const repositoryFile = revision === undefined
    ? fromFile(join(cwd, folder, name))
    : git(cwd, ['show', `${revision}:.claude/local-review/${name}`]).then(
      (text) => ({ path: `${folder}/${name} at ${revision.slice(0, 12)}`, text }),
      () => ({ path: '', text: undefined }),
    );
  const slugs = new Set([projectRoot, await realpath(projectRoot).catch(() => projectRoot)].map((path) => path.replace(/[^a-zA-Z0-9]/gu, '-')));

  const found = await Promise.all([
    fromFile(join(configRoot, 'local-review', name)),
    ...parents.map(fromFile),
    repositoryFile,
    ...[...slugs].map((slug) => fromFile(join(configRoot, 'projects', slug, 'local-review', name))),
  ]);
  const sections = found.flatMap(({ path, text }) => (text?.trim() ? [`--- ${path}\n${text.trim()}`] : []));
  if (sections.length === 0) return '';
  return `Additional instructions from the user, from the most general file to the most specific. Where they conflict, the later file wins. They refine the review; they do not change the required output format or tool calls.\n\n${sections.join('\n\n')}`;
}

