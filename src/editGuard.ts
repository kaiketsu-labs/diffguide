import { isAbsolute, relative, resolve, sep } from 'node:path';

/** The folder inside a repository where Pair Review keeps its worktrees; Claude may edit only below it. */
export const worktreeFolder = ['.claude', 'worktrees', 'pair-review'].join(sep);

function inside(folder: string, path: string): boolean {
  const rest = relative(folder, path);
  return rest === '' || (!rest.startsWith('..') && !isAbsolute(rest));
}

/**
 * Why Claude may not edit `path`, or undefined when it may: inside a read-only repository only its Pair Review worktrees are editable.
 * `path` is resolved against `cwd`, as Claude's file tools do.
 */
export function editRefusal(path: string, cwd: string, readOnly: readonly string[]): string | undefined {
  const target = resolve(cwd, path);
  const repository = readOnly.find((folder) => inside(folder, target));
  if (repository === undefined || inside(resolve(repository, worktreeFolder), target)) return undefined;
  return `${repository} is open for reading only. To change code there, call use_linked_repository and edit inside the worktree path it returns.`;
}

/** The file paths a tool call writes, for the tools that edit files. */
export function editedPaths(tool: unknown, input: unknown): readonly string[] {
  if (typeof input !== 'object' || input === null) return [];
  const fields = input as Record<string, unknown>;
  const key = tool === 'NotebookEdit' ? 'notebook_path' : tool === 'Edit' || tool === 'MultiEdit' || tool === 'Write' ? 'file_path' : undefined;
  const value = key === undefined ? undefined : fields[key];
  return typeof value === 'string' ? [value] : [];
}
