import { cp, mkdir, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { git } from '../../core/git/worktrees.js';

interface Step {
  /** Folder under the recipe's source folder whose files are copied over the tree. */
  readonly files: string;
  readonly remove?: readonly string[];
  readonly author: string;
  readonly date: string;
  readonly message: string;
}

const maya = 'Maya Chen';
const sam = 'Sam Ortiz';

/** The demo PR's branch, and the target it merges into. */
export const demoBranch = 'feature/streaming-export';
export const demoBase = 'main';

const baseStep: Step = { files: '01-main', author: sam, date: '2025-03-03T09:00:00+00:00', message: 'chore: import field-notes 2.3.0' };
const pushedSteps: readonly Step[] = [
  { files: '02-streaming', author: maya, date: '2025-03-04T10:15:00+00:00', message: 'feat(export): stream notes as newline-delimited JSON' },
  { files: '03-migrate', remove: ['src/notes/legacy.ts'], author: maya, date: '2025-03-04T14:40:00+00:00', message: 'refactor(notes): rename the legacy importer to migrate' },
  { files: '04-docs', remove: ['docs/legacy.md'], author: maya, date: '2025-03-05T09:20:00+00:00', message: 'docs: add the export guide and release notes' },
  { files: '05-trim', author: maya, date: '2025-03-05T16:05:00+00:00', message: 'fix(format): drop the space before a title ellipsis' },
];
const unpushedStep: Step = { files: '06-unpushed', author: maya, date: '2025-03-06T08:30:00+00:00', message: 'test(export): cover empty and tagged exports' };
const uncommittedFiles = '07-uncommitted';

/** Commit ids of the sample repository; the same on every machine because names, dates and files are fixed. */
export interface SampleRepository {
  readonly base: string;
  /** The PR's commits on the remote, oldest first; the last one is the PR's head. */
  readonly pushed: readonly string[];
  /** The commit only the local checkout has, on top of the PR's head. */
  readonly unpushed: string;
}

/** Git settings that would change a commit's id or run the user's hooks. */
const isolated: NodeJS.ProcessEnv = { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
const quietly = ['-c', 'commit.gpgsign=false', '-c', 'core.autocrlf=false', '-c', 'core.hooksPath=/dev/null'];

/** Copy a step's files over the working tree and delete what the step removes. */
async function apply(source: string, root: string, files: string, remove: readonly string[] = []): Promise<void> {
  for (const path of remove) await rm(join(root, path));
  await cp(join(source, files), root, { recursive: true });
}

async function commit(source: string, root: string, step: Step): Promise<string> {
  await apply(source, root, step.files, step.remove);
  const env = { ...isolated, GIT_AUTHOR_NAME: step.author, GIT_AUTHOR_EMAIL: `${step.author.split(' ')[0]?.toLowerCase()}@example.com`, GIT_AUTHOR_DATE: step.date, GIT_COMMITTER_NAME: step.author, GIT_COMMITTER_EMAIL: `${step.author.split(' ')[0]?.toLowerCase()}@example.com`, GIT_COMMITTER_DATE: step.date };
  await git(root, ['add', '--all'], env);
  await git(root, [...quietly, 'commit', '--quiet', '--no-verify', '-m', step.message], env);
  return (await git(root, ['rev-parse', 'HEAD'], env)).trim();
}

/**
 * Build the sample repository from the recipe in `source` (`demo/sample-repo`): a bare `origin` beside `root` holding `main` and the PR branch,
 * and in `root` the PR branch with one unpushed commit and one uncommitted edit. `root` and its `origin.git` must not exist.
 */
export async function buildSampleRepository(source: string, root: string): Promise<SampleRepository> {
  const origin = join(dirname(root), 'origin.git');
  await mkdir(root, { recursive: true });
  await git(root, ['init', '--quiet', '--initial-branch', demoBase], isolated);
  const base = await commit(source, root, baseStep);
  await git(root, ['init', '--quiet', '--bare', '--initial-branch', demoBase, origin], isolated);
  await git(root, ['remote', 'add', 'origin', origin], isolated);
  await git(root, ['push', '--quiet', 'origin', demoBase], isolated);
  await git(root, ['switch', '--quiet', '--create', demoBranch], isolated);
  const pushed: string[] = [];
  for (const step of pushedSteps) pushed.push(await commit(source, root, step));
  await git(root, ['push', '--quiet', '--set-upstream', 'origin', demoBranch], isolated);
  const unpushed = await commit(source, root, unpushedStep);
  await apply(source, root, uncommittedFiles);
  return { base, pushed, unpushed };
}
