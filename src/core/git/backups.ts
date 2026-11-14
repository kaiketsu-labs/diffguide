import { createHash } from 'node:crypto';
import { copyFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { git } from './worktrees.js';

/** How long a checkout's backups stay before the next backup prunes them. */
export const backupDays = 14;

const identity = { GIT_AUTHOR_NAME: 'DiffGuide', GIT_AUTHOR_EMAIL: 'diffguide@localhost', GIT_COMMITTER_NAME: 'DiffGuide', GIT_COMMITTER_EMAIL: 'diffguide@localhost' };

/** Ref folder for one checkout's backups; worktrees share refs, so the checkout's path tells them apart. */
async function backupPrefix(checkout: string): Promise<string> {
  const root = (await git(checkout, ['rev-parse', '--show-toplevel'])).trim();
  return `refs/diffguide/backup/${createHash('sha1').update(root).digest('hex').slice(0, 12)}/`;
}

/** A checkout's backup refs, newest first. */
export async function listBackups(checkout: string): Promise<readonly { readonly ref: string; readonly at: number }[]> {
  const prefix = await backupPrefix(checkout);
  const refs = (await git(checkout, ['for-each-ref', '--format=%(refname)', prefix])).split('\n').filter(Boolean);
  return refs.map((ref) => ({ ref, at: Number(ref.slice(prefix.length)) })).filter(({ at }) => Number.isSafeInteger(at)).sort((a, b) => b.at - a.at);
}

/** Trees of a checkout's working files (tracked edits and untracked files, not ignored ones) and of its index; `staged` is undefined while the index has conflicts. */
export async function snapshot(checkout: string): Promise<{ readonly files: string; readonly staged: string | undefined }> {
  const index = (await git(checkout, ['rev-parse', '--path-format=absolute', '--git-path', 'index'])).trim();
  const scratch = await mkdtemp(join(tmpdir(), 'diffguide-backup-'));
  try {
    const copy = join(scratch, 'index');
    await copyFile(index, copy).catch(() => undefined);
    await git(checkout, ['add', '--all'], { GIT_INDEX_FILE: copy });
    const files = (await git(checkout, ['write-tree'], { GIT_INDEX_FILE: copy })).trim();
    const conflicted = (await git(checkout, ['ls-files', '--unmerged'])).trim() !== '';
    return { files, staged: conflicted ? undefined : (await git(checkout, ['write-tree'])).trim() };
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

/**
 * Save HEAD, the index, tracked edits and untracked files under a backup ref without changing the checkout, and prune backups older than `backupDays`.
 * The backup commit's first parent is HEAD, so unpushed commits stay reachable; its second parent holds the index when it has no conflicts.
 * Ignored files are left out. Returns the ref, or undefined in a repository without a first commit.
 */
export async function backUp(checkout: string, reason: string, now = Date.now()): Promise<string | undefined> {
  const head = (await git(checkout, ['rev-parse', '--verify', '--quiet', 'HEAD']).catch(() => '')).trim();
  if (head === '') return undefined;
  const { files, staged } = await snapshot(checkout);
  const indexCommit = staged === undefined ? undefined : (await git(checkout, ['commit-tree', '-p', head, '-m', 'index', staged], identity)).trim();
  const backup = (await git(checkout, ['commit-tree', '-p', head, ...indexCommit === undefined ? [] : ['-p', indexCommit], '-m', `DiffGuide backup before ${reason}`, files], identity)).trim();
  const ref = `${await backupPrefix(checkout)}${now}`;
  await git(checkout, ['update-ref', ref, backup]);
  for (const old of await listBackups(checkout)) {
    if (now - old.at > backupDays * 86_400_000) await git(checkout, ['update-ref', '-d', old.ref]);
  }
  return ref;
}

/** Put a checkout back to a backup: its HEAD, its index (or HEAD's files when it had conflicts), and its working files, which win over later edits. */
export async function restoreBackup(checkout: string, ref: string): Promise<void> {
  const [head, index] = (await git(checkout, ['rev-list', '--parents', '--no-walk', ref])).trim().split(' ').slice(1);
  if (head === undefined) throw new Error(`${ref} is not a DiffGuide backup.`);
  await git(checkout, ['update-ref', '-m', 'DiffGuide: restore a backup', 'HEAD', head]);
  await git(checkout, ['read-tree', '--reset', '-u', `${ref}^{tree}`]);
  await git(checkout, ['read-tree', `${index ?? head}^{tree}`]);
}

/** Delete every backup of a checkout, for a worktree removed with nothing left to lose. */
export async function dropBackups(checkout: string): Promise<void> {
  for (const { ref } of await listBackups(checkout)) await git(checkout, ['update-ref', '-d', ref]);
}
