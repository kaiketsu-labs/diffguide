import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { prepareHighlighting } from '../../core/codePreview.js';
import { isWorkspaceRelativePath } from '../../core/git/git.js';
import { highlightSource } from '../../core/unifiedDiff.js';
import { mediaType } from '../media.js';
import { readFilePreview, readMediaSides } from '../preview/fileContent.js';
import type { OverviewActions } from '../protocol.js';
import type { PageParts } from './context.js';

export type FileActions = Pick<OverviewActions, 'readFiles' | 'readContext' | 'readPreview' | 'readMedia' | 'setViewed' | 'markRead' | 'unmarkRead'
  | 'openFile' | 'closeFiles' | 'openInEditor'>;

/** The page's actions on the Files tab: read the diff and files around it, and mark files viewed or lines read. */
export function fileActions({ page, diff }: PageParts): FileActions {
  const { provider, repository, pullRequest, folder, fileReviews, revealed, host } = page;
  const { number } = pullRequest;
  return {
    readFiles: (select) => diff.read(select),
    readContext: async (path) => {
      diff.requireInDiff(path);
      const text = await readFile(join(folder, path), 'utf8');
      await prepareHighlighting([path]);
      return highlightSource(text, path);
    },
    readPreview: async (path) => {
      diff.requireInDiff(path);
      return readFilePreview(folder, path);
    },
    readMedia: async (path) => {
      const file = diff.files.find((each) => each.path === path);
      if (file === undefined || mediaType(path) === undefined) throw new Error(`${path} is not an image or PDF in this PR's changes.`);
      return readMediaSides(folder, file, await diff.readBase());
    },
    setViewed: (path, viewed) => fileReviews.set(provider, repository, number, path, viewed),
    markRead: async (range, fileDone) => {
      diff.requireInDiff(range.path);
      if (diff.selection.range.kind !== 'all') throw new Error('Show all changes to mark lines read.');
      await fileReviews.markRead(repository, number, await diff.readBase(), range);
      if (fileDone) await fileReviews.set(provider, repository, number, range.path, true);
    },
    unmarkRead: (ids) => fileReviews.unmarkRead(repository, number, ids),
    openInEditor: (path) => host.openInEditor(diff.current(), path),
    openFile: async (path) => {
      if (!isWorkspaceRelativePath(path)) throw new Error(`Unsupported file path: ${path}`);
      if (diff.selection.range.kind !== 'all') { await host.openInEditor(diff.current(), path); return; }
      revealed.add(path);
      host.reveal({ path, reload: true });
    },
    closeFiles: async (paths) => { for (const path of paths) revealed.delete(path); },
  };
}
