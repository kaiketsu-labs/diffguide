import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { git } from './worktrees.js';

/** Hooks stay off in a scratch worktree: on someone else's PR, the author controls the checkout's files. */
const noHooks = ['-c', 'core.hooksPath=/dev/null'];

/** A worktree of a checkout's repository for Claude to work in, away from the checkout you edit. */
export interface ScratchWorktree {
  readonly path: string;
  remove(): Promise<void>;
}

/** Add a scratch worktree detached at `commit`. */
export async function makeScratchWorktree(checkout: string, commit: string): Promise<ScratchWorktree> {
  const parent = await mkdtemp(join(tmpdir(), 'diffguide-scratch-'));
  const path = join(parent, 'checkout');
  const remove = async (): Promise<void> => {
    await git(checkout, ['worktree', 'remove', '--force', path]).catch(() => undefined);
    await rm(parent, { recursive: true, force: true });
    await git(checkout, ['worktree', 'prune']).catch(() => undefined);
  };
  try {
    await git(checkout, [...noHooks, 'worktree', 'add', '--quiet', '--detach', path, commit]);
  } catch (error: unknown) {
    await remove();
    throw error;
  }
  return { path, remove };
}

/** Run `body` in a scratch worktree detached at `commit`, and remove the worktree afterwards, whatever `body` did. */
export async function withScratchWorktree<T>(checkout: string, commit: string, body: (scratch: string) => Promise<T>): Promise<T> {
  const scratch = await makeScratchWorktree(checkout, commit);
  try {
    return await body(scratch.path);
  } finally {
    await scratch.remove();
  }
}

/** Put a scratch worktree at `commit` with `tree`'s files, and nothing else, in it. */
export async function showInScratch(scratch: string, commit: string, tree: string): Promise<void> {
  await git(scratch, [...noHooks, 'checkout', '--quiet', '--force', '--detach', commit]);
  await git(scratch, ['read-tree', '--reset', '-u', tree]);
  await git(scratch, ['clean', '--quiet', '-d', '--force']);
}
