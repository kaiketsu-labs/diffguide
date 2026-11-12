/** The file list beside the diff, and its resizing. */
import type { LocalChange } from '../../../core/conflicts.js';
import { type FileFolder, fileTree } from '../../../core/fileTree.js';
import type { FileDiff } from '../../../core/unifiedDiff.js';
import { icons } from '../../icons.js';
import type { FileIcon } from '../../protocol.js';
import { $, button, chevronMark, el, icon, setTip, titled } from '../dom.js';
import { closedFiles, collapsed, hiddenTypes, prefs, received, save, ui } from '../state.js';
import { allThreads, inFiles } from '../threads/model.js';
import { post } from '../transport.js';
import type { Thread } from '../types.js';
import { fileType } from './filters.js';
import { renderFiles } from './render.js';

/** CSS font families of the icon theme's fonts already added to the page, by font id. */
const iconFonts = new Map<string, string>();
export const changeLetters: Record<FileDiff['change'], string> = { added: 'A', modified: 'M', deleted: 'D', renamed: 'R', unchanged: '' };

/** Folders opened or folded in the file navigator by hand, apart from the file list's own folders. */
const navFolders = new Map<string, boolean>();

/** A navigator entry: a file on the page, or with All files on, a repository file the page does not show yet. */
interface NavEntry { readonly path: string; readonly file?: FileDiff }

/**
 * The file navigator beside the diffs: icon, name, open comments, Git letter and a Viewed tick per file.
 * Opened unchanged files lead in their own group; with All files on, the whole repository follows as one tree.
 */
export function renderFileNav(changes: readonly FileDiff[], opened: readonly FileDiff[], threadsByFile: ReadonlyMap<string, readonly Thread[]>): void {
  const nav = $('file-nav');
  nav.classList.toggle('folded', ui.navFolded);
  const head = el('button', 'nav-head');
  head.setAttribute('aria-expanded', String(!ui.navFolded));
  const total = (received.files ?? []).filter((file) => file.change !== 'unchanged').length;
  const done = changes.filter((file) => received.viewed.has(file.path)).length;
  const query = prefs.fileFilter.trim().toLowerCase();
  const entries: NavEntry[] = prefs.allFiles ? repositoryEntries().filter((entry) => entry.file ? changes.includes(entry.file) || opened.includes(entry.file)
    : (!query || entry.path.toLowerCase().includes(query)) && !hiddenTypes.has(fileType(entry.path))) : [];
  if (prefs.allFiles) head.append(chevronMark(ui.navFolded), (changes.length < total ? changes.length + ' of ' + total : total) + ' changed', el('span', 'muted', done + ' viewed · ' + entries.length + (entries.length === 1 ? ' file' : ' files')));
  else head.append(chevronMark(ui.navFolded), (changes.length < total ? changes.length + ' of ' + total : changes.length) + (total === 1 ? ' file' : ' files'), el('span', 'muted', done + ' viewed'));
  head.addEventListener('click', () => { ui.navFolded = !ui.navFolded; renderFileNav(changes, opened, threadsByFile); });
  const list = el('ul', 'nav-list');
  const redraw = (): void => { renderFileNav(changes, opened, threadsByFile); };
  const holdsShown = (folder: FileFolder<NavEntry>): boolean => folder.files.some((entry) => entry.file !== undefined) || folder.folders.some(holdsShown);
  const holdsChange = (folder: FileFolder<NavEntry>): boolean => folder.files.some((entry) => entry.file !== undefined && entry.file.change !== 'unchanged') || folder.folders.some(holdsChange);
  const add = (folder: FileFolder<NavEntry>, depth: number): void => {
    for (const child of folder.folders) {
      const isCollapsed = navFolders.get(child.path) ?? (prefs.allFiles && !holdsShown(child));
      const row = el('li', 'nav-folder');
      row.style.setProperty('--depth', String(depth));
      row.title = child.path;
      row.append(chevronMark(isCollapsed), el('span', 'nav-name', child.name));
      if (prefs.allFiles && holdsChange(child)) row.append(titled(el('span', 'nav-dot'), 'Holds changed files'));
      row.addEventListener('click', () => { navFolders.set(child.path, !isCollapsed); redraw(); });
      list.append(row);
      if (!isCollapsed) add(child, depth + 1);
    }
    for (const entry of folder.files) list.append(navFile(entry, depth, threadsByFile.get(entry.path) ?? []));
  };
  if (opened.length) {
    const group = el('li', 'nav-group');
    group.append('Opened', el('span', 'muted', String(opened.length)));
    const closable = opened.filter((file) => !threadsByFile.get(file.path)?.length).map((file) => file.path);
    if (closable.length) {
      const closeAll = button('', () => { closeFiles(closable); }, 'quiet small nav-close-all');
      closeAll.textContent = 'Close all';
      group.append(closeAll);
    }
    list.append(group);
    for (const file of opened) list.append(navFile({ path: file.path, file }, 0, threadsByFile.get(file.path) ?? [], true));
    if (changes.length || prefs.allFiles) list.append(el('li', 'nav-sep'));
  }
  add(prefs.allFiles ? fileTree(entries) : fileTree(changes.map((file): NavEntry => ({ path: file.path, file }))), 0);
  nav.replaceChildren(head, list);
  markCurrentNavFile();
}

/** Every repository file with the page's file for it, plus page files the repository no longer lists, such as deleted ones. */
function repositoryEntries(): NavEntry[] {
  const byPath = new Map((received.files ?? []).map((file) => [file.path, file]));
  const entries = received.repositoryFiles.map((path): NavEntry => { const file = byPath.get(path); return file ? { path, file } : { path }; });
  const listed = new Set(received.repositoryFiles);
  for (const file of received.files ?? []) if (!listed.has(file.path)) entries.push({ path: file.path, file });
  return entries;
}

/** One navigator row; `closable` adds × to an opened file that has no comments. */
function navFile(entry: NavEntry, depth: number, threads: readonly Thread[], closable = false): HTMLElement {
  const { path, file } = entry;
  const item = el('li');
  const isViewed = file !== undefined && received.viewed.has(path);
  const row = el('button', 'nav-file' + (isViewed ? ' done' : '') + (file === undefined || file.change === 'unchanged' ? ' unchanged' : ''));
  row.style.setProperty('--depth', String(depth));
  row.dataset.navPath = path;
  row.title = path;
  const themeIcon = received.fileIcons?.byPath[path];
  row.append(themeIcon ? iconNode(themeIcon) : el('span', 'file-icon'), el('span', 'nav-name', path.split('/').at(-1) ?? path));
  const open = threads.filter((thread) => !thread.resolved).length;
  if (open) {
    const count = el('span', 'nav-count', String(open));
    count.title = open + (open === 1 ? ' open comment' : ' open comments');
    row.append(count);
  }
  if (file && file.change !== 'unchanged') {
    const badge = el('span', 'badge ' + file.change, changeLetters[file.change]);
    badge.title = file.change;
    row.append(badge);
  }
  const done = el('span', 'nav-done');
  if (isViewed) {
    done.title = 'Viewed';
    done.append(icon(icons.check));
  }
  row.append(done);
  row.addEventListener('click', () => { if (file) showFile(path); else post({ action: 'open-file', path }); });
  item.append(row);
  if (closable && !threads.length) {
    const close = button('', () => { closeFiles([path]); }, 'icon-button nav-close');
    close.append(icon(icons.close));
    setTip(close, 'Close');
    item.classList.add('closable');
    item.append(close);
  }
  return item;
}

/** Scroll the file list to a file, opening its box and folders first when they are closed. */
function showFile(path: string): void {
  const box = (): HTMLElement | null => $('files').querySelector<HTMLElement>('.file[data-path="' + CSS.escape(path) + '"]');
  const present = box();
  if (!present || collapsed.get(path) === true) {
    collapsed.set(path, false);
    openFolders(path);
    save();
    renderFiles(present ? [path] : undefined);
  }
  box()?.scrollIntoView({ block: 'start' });
}

/** Round a pinned file header into a closed card once its file's end reaches it, so no box edge peeks out below. */
export function markEndingFiles(): void {
  for (const box of $('files').querySelectorAll<HTMLElement>('.file')) {
    const head = box.querySelector<HTMLElement>(':scope > .file-head');
    const rect = box.getBoundingClientRect();
    if (rect.top > window.innerHeight) break;
    box.classList.toggle('ending', head !== null && rect.top < 0 && rect.bottom - head.getBoundingClientRect().bottom < 2);
  }
}

/** The file or guide step the navigator last highlighted. */
let navTop: string | undefined;

/** Highlight the navigator row of the file or guide step at the top of the view, the first one until any reaches it, and scroll the navigator to it when that changes; `rebuilt` after the rows were redrawn. */
export function markCurrentNavFile(rebuilt = true): void {
  const line = (Number.parseFloat(document.body.style.getPropertyValue('--bar-height')) || 46) + 36;
  const guided = prefs.view === 'guide';
  let top: string | undefined;
  for (const box of $('files').querySelectorAll<HTMLElement>(guided ? '.step-wrap[data-key]' : '.file[data-path]')) {
    if (top !== undefined && box.getBoundingClientRect().top > line) break;
    top = guided ? box.dataset.key : box.dataset.path;
  }
  const moved = top !== navTop;
  if (!moved && !rebuilt) return;
  navTop = top;
  const nav = $('file-nav');
  let currentRow: HTMLElement | undefined;
  for (const row of nav.querySelectorAll<HTMLElement>('.nav-file')) {
    const isTop = top !== undefined && (guided ? row.dataset.navStep : row.dataset.navPath) === top;
    row.setAttribute('aria-current', String(isTop));
    if (isTop) currentRow = row;
  }
  if (!moved || !currentRow) return;
  const list = nav.getBoundingClientRect();
  const rect = currentRow.getBoundingClientRect();
  if (rect.top < list.top) nav.scrollTop -= list.top - rect.top + rect.height;
  else if (rect.bottom > list.bottom) nav.scrollTop += rect.bottom - list.bottom + rect.height;
}

const localMarks: Record<LocalChange, readonly [string, string]> = {
  unpushed: ['↑', 'Changed in commits not pushed yet'], edited: ['✎', 'Uncommitted edits in the worktree'], both: ['↑✎', 'Unpushed commits and uncommitted edits'],
};

export function localMarkOf(change: LocalChange, tip = localMarks[change][1]): HTMLElement {
  const mark = el('span', 'local-mark', localMarks[change][0]);
  mark.title = tip;
  return mark;
}

/** A file's mark for worktree work that GitHub does not have, or nothing. */
export function localMark(path: string): HTMLElement[] {
  const change = received.current?.local?.[path];
  return change === undefined ? [] : [localMarkOf(change)];
}

/** Take opened unchanged files off the page; files with comments stay. */
export function closeFiles(paths: readonly string[]): void {
  for (const path of paths) closedFiles.add(path);
  save();
  renderFiles();
  post({ action: 'close-files', paths });
}

/** Files outside the changes opened on the page, shown whole after the changes. A closed file stays off even when the extension keeps it for a hidden thread, such as a guide note. */
export function openedFiles(): readonly FileDiff[] {
  const commented = new Set(allThreads().filter(inFiles).map((thread) => thread.path));
  return (received.files ?? []).filter((file) => file.change === 'unchanged' && (!closedFiles.has(file.path) || commented.has(file.path)));
}

/** A theme file icon: a glyph of an icon font, added to the page on first use, or an image. */
export function iconNode(icon: FileIcon): HTMLElement {
  if ('image' in icon) {
    const image = el('img', 'file-icon');
    image.src = received.fileIcons?.images[icon.image] ?? '';
    image.alt = '';
    return image;
  }
  let family = iconFonts.get(icon.font);
  const data = received.fileIcons?.fonts[icon.font];
  if (family === undefined && data !== undefined) {
    family = 'file-icons-' + iconFonts.size;
    iconFonts.set(icon.font, family);
    document.head.append(el('style', '', '@font-face{font-family:"' + family + '";src:url("' + data + '")}'));
  }
  const glyph = el('span', 'file-icon', icon.char);
  glyph.setAttribute('aria-hidden', 'true');
  if (family) glyph.style.fontFamily = '"' + family + '"';
  if (icon.color) glyph.style.color = icon.color;
  return glyph;
}

/** Folders a path sits in, outermost first: every prefix, so compacted folder rows match too. */
export function folderOf(path: string): string[] {
  const parts = path.split('/').slice(0, -1);
  return parts.map((_part, index) => parts.slice(0, index + 1).join('/'));
}

export function updateFolderProgress(tree: FileFolder<FileDiff>): void {
  const count = (folder: FileFolder<FileDiff>): { done: number; total: number } => folder.folders.map(count).reduce(
    (sum, next) => ({ done: sum.done + next.done, total: sum.total + next.total }),
    { done: folder.files.filter((file) => received.viewed.has(file.path)).length, total: folder.files.length },
  );
  const walk = (folder: FileFolder<FileDiff>): void => {
    for (const child of folder.folders) {
      const { done, total } = count(child);
      const progress = document.querySelector('[data-folder="' + CSS.escape(child.path) + '"] .progress');
      if (progress) progress.textContent = done + '/' + total + ' viewed';
      walk(child);
    }
  };
  walk(tree);
}

/** Open the folders around a file so its box is on the page. */
export function openFolders(path: string): void {
  for (const folder of folderOf(path)) collapsed.delete('folder:' + folder);
}
/** Drag the file list's right edge to resize it; double-click restores the default width. */
export function showNavWidth(): void {
  if (prefs.navWidth === undefined) document.body.style.removeProperty('--nav-width');
  else document.body.style.setProperty('--nav-width', prefs.navWidth + 'px');
}
/** Drag the line between the file list and the comments panel to share their height; double-click restores the default. */
export function showNavThreadsHeight(): void {
  if (prefs.navThreadsHeight === undefined) document.body.style.removeProperty('--nav-threads-height');
  else document.body.style.setProperty('--nav-threads-height', prefs.navThreadsHeight + 'px');
}
