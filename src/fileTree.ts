/** A folder of changed files; `name` spans several path parts when folders hold only one folder each. */
export interface FileFolder<T extends { readonly path: string }> {
  readonly name: string;
  readonly path: string;
  readonly folders: readonly FileFolder<T>[];
  readonly files: readonly T[];
}

/** Group changed files by folder like Source Control's tree view, folding single-folder chains into one row. */
export function fileTree<T extends { readonly path: string }>(files: readonly T[]): FileFolder<T> {
  type Building = { folders: Map<string, Building>; files: T[] };
  const root: Building = { folders: new Map(), files: [] };
  for (const file of files) {
    let folder = root;
    for (const part of file.path.split('/').slice(0, -1)) {
      let next = folder.folders.get(part);
      if (next === undefined) folder.folders.set(part, next = { folders: new Map(), files: [] });
      folder = next;
    }
    folder.files.push(file);
  }
  const finish = (name: string, path: string, folder: Building): FileFolder<T> => {
    if (folder.files.length === 0 && folder.folders.size === 1) {
      const [[child, only]] = [...folder.folders] as [[string, Building]];
      return finish(`${name}/${child}`, `${path}/${child}`, only);
    }
    return {
      name, path,
      folders: [...folder.folders].sort(([a], [b]) => a.localeCompare(b)).map(([child, next]) => finish(child, path === '' ? child : `${path}/${child}`, next)),
      files: [...folder.files].sort((a, b) => a.path.localeCompare(b.path)),
    };
  };
  return {
    name: '', path: '',
    folders: [...root.folders].sort(([a], [b]) => a.localeCompare(b)).map(([name, folder]) => finish(name, name, folder)),
    files: [...root.files].sort((a, b) => a.path.localeCompare(b.path)),
  };
}
