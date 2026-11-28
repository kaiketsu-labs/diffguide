/** File filters and the view menu. */
import type { FileDiff } from '../../../core/unifiedDiff.js';
import { icons } from '../../icons.js';
import type { DiffSide } from '../../protocol.js';
import { $, button, el, setTip } from '../dom.js';
import { guideState } from '../guide/model.js';
import { closeToolbarMenu, menuRow, openToolbarMenu } from '../menus.js';
import { requestFiles } from '../range.js';
import { collapsed, guided, hiddenTypes, prefs, received, save } from '../state.js';
import { renderNavThreads, renderThreadList } from '../threads/list.js';
import { allThreads, isArchived } from '../threads/model.js';
import { threadOpen } from '../threads/threadBox.js';
import { drawPendingDiffs, renderFiles } from './render.js';

/** Whether lines on `side` can take comments, read marks and threads in the shown range. */
export function linesFit(side: DiffSide): boolean {
  return received.atHead && (side === 'new' || received.diffRange.kind === 'all');
}

export function fileType(path: string): string {
  const name = path.split('/').at(-1) ?? path;
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot) : 'No extension';
}

/** Files the filter box, the type menu and Hide viewed leave on the page. */
export function filteredFiles(list: readonly FileDiff[]): readonly FileDiff[] {
  const query = prefs.fileFilter.trim().toLowerCase();
  return list.filter((file) => (!query || file.path.toLowerCase().includes(query) || (file.oldPath?.toLowerCase().includes(query) ?? false))
    && !hiddenTypes.has(fileType(file.path)) && !(prefs.hideViewed && received.viewed.has(file.path)));
}

export function filtersOn(): boolean {
  return prefs.fileFilter.trim() !== '' || hiddenTypes.size > 0 || prefs.hideViewed;
}

export function applyFilters(): void {
  save();
  renderFiles();
  renderNavThreads();
  $('filter-menu').setAttribute('aria-pressed', String(filtersOn()));
  $('filter-clear').hidden = prefs.fileFilter === '';
  showListToggle();
}

/** Expand the file filter over the order switch and focus it. */
export function openSearch(): void {
  $('nav-order').classList.add('searching');
  $('file-filter').focus();
}

/** Shrink the file filter back to its icon, which shows a dot while the filter text still narrows the list. */
export function closeSearch(): void {
  $('nav-order').classList.remove('searching');
  $('search-toggle').classList.toggle('filtered', prefs.fileFilter.trim() !== '');
}

/** The file list's collapse icon, with a dot while a hidden list still filters the files. */
export function showListToggle(): void {
  const chapters = guided() && received.current?.analysis.result !== undefined;
  $('files-layout').classList.toggle('list-hidden', prefs.listHidden || chapters);
  const toggle = $('nav-toggle');
  toggle.hidden = chapters;
  setTip(toggle, prefs.listHidden ? 'Expand file list' : 'Collapse file list');
  toggle.setAttribute('aria-expanded', String(!prefs.listHidden));
  toggle.classList.toggle('filtered', prefs.listHidden && prefs.view === 'code' && !guided() && filtersOn());
}

export function openFilterMenu(): void {
  const types = [...new Set((received.files ?? []).map((file) => fileType(file.path)))].sort();
  const rows = types.map((type) => menuRow([type, el('span', 'muted', String((received.files ?? []).filter((file) => fileType(file.path) === type).length))], !hiddenTypes.has(type),
    (on) => { if (on) hiddenTypes.delete(type); else hiddenTypes.add(type); applyFilters(); }));
  rows.push(menuRow(['Hide viewed files'], prefs.hideViewed, (on) => { prefs.hideViewed = on; applyFilters(); }));
  const archived = (received.current?.threads ?? []).filter(isArchived).length;
  rows.push(menuRow(['Show archived threads', el('span', 'muted', String(archived))], prefs.showArchived, (on) => { prefs.showArchived = on; save(); renderFiles(); renderThreadList(); }));
  const reset = button('Clear filters', () => { clearFilters(); closeToolbarMenu(); }, 'small');
  reset.disabled = !filtersOn();
  const foot = el('div', 'menu-foot');
  foot.append(reset);
  openToolbarMenu('filter-menu', [...rows, foot]);
}

/** Whether every file, or every guide step, is collapsed, so the fold button expands them. */
export function allFolded(): boolean {
  const keys = guided() ? (received.guide ?? []).flatMap((group) => group.steps.map((step) => guideState('step', step.key))) : (received.files ?? []).map((file) => file.path);
  return keys.length > 0 && keys.every((key) => collapsed.get(key) === true);
}

/** Display settings you set once: whitespace, folders and where comments show. */
export function openViewMenu(): void {
  drawPendingDiffs();
  const commentsOpen = document.querySelector('details.thread[open]') !== null;
  const notes = (received.current?.threads ?? []).filter((thread) => thread.origin === 'analysis' && (prefs.showArchived || !isArchived(thread))).length;
  const rows = [
    ...!guided() ? [menuRow(['Hide whitespace changes'], prefs.whitespace, (on) => { closeToolbarMenu(); requestFiles(received.diffRange, on); }, false, icons.whitespace)] : [],
    ...!guided() ? [menuRow(['Group files by folder'], prefs.folders, (on) => { prefs.folders = on; save(); renderFiles(); }, false, icons.tree)] : [],
    ...!guided() ? [menuRow(['All files', el('span', 'muted', 'Show unchanged files too')], prefs.allFiles, (on) => { prefs.allFiles = on; save(); renderFiles(); }, false, icons.file)] : [],
    ...!guided() ? [menuRow(['Show guide comments', el('span', 'muted', String(notes))], prefs.guideInFiles, (on) => { prefs.guideInFiles = on; save(); renderFiles(); renderNavThreads(); }, false, icons.agentGuide)] : [],
    menuRow(['Collapse all comments'], !commentsOpen, (on) => { for (const thread of allThreads()) threadOpen.set(thread.id, !on); renderFiles(); }, false, icons.comment),
  ];
  openToolbarMenu('view-menu', rows);
}

function clearFilters(): void {
  prefs.fileFilter = '';
  $<HTMLInputElement>('file-filter').value = '';
  hiddenTypes.clear();
  prefs.hideViewed = false;
  applyFilters();
}
