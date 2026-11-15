/** Draws file boxes and keeps the scroll position across redraws. */
import { type FileFolder, fileTree } from '../../../core/fileTree.js';
import type { FileDiff } from '../../../core/unifiedDiff.js';
import { icons } from '../../icons.js';
import { toolButton } from '../conversation/comment.js';
import { $, button, chevronMark, el, icon, setTip } from '../dom.js';
import { guideIntro } from '../guide/model.js';
import { railItem, railNode, renderGuide } from '../guide/render.js';
import { rangeLabel, renderRangeControls } from '../range.js';
import { showCodeTab } from '../render.js';
import { collapsed, guided, prefs, previewing, received, save, ui } from '../state.js';
import { fileComposerBox, openFileComposer } from '../threads/composer.js';
import { allThreads, inFiles, standalone } from '../threads/model.js';
import { threadBox } from '../threads/threadBox.js';
import { post } from '../transport.js';
import type { Thread } from '../types.js';
import { allFolded, filteredFiles } from './filters.js';
import { fileKey, fullFile, loadContext, markViewed } from './marks.js';
import { changeLetters, closeFiles, folderOf, iconNode, localMark, localMarkOf, markCurrentNavFile, openedFiles, renderFileNav, updateFolderProgress } from './nav.js';
import { frameMessage, frameTops, layoutMargin, mediaNode, previewKind, previewNode, previewOnly } from './preview.js';
import { expanded, table } from './table.js';

const fileKeys = new Map<string, string>();

/** File boxes whose diff is still to draw, in page order; a full redraw of a large PR draws them over the next frames instead of in one long task. */
const undrawn = new Map<HTMLElement, () => void>();
let drawing = false;
/** A full redraw draws diffs at once for this long, which covers a typical PR, and leaves the rest to later frames. */
const firstDrawMs = 8;
/** Work per later frame. */
const frameDrawMs = 10;

function drawDiff(box: HTMLElement): void {
  const draw = undrawn.get(box);
  undrawn.delete(box);
  if (draw && box.isConnected) draw();
}

/** Draw every diff still waiting, for code that looks up a thread, a draft or a line right away. */
export function drawPendingDiffs(): void {
  for (const box of [...undrawn.keys()]) drawDiff(box);
}

function drawOverFrames(): void {
  if (drawing || !undrawn.size) return;
  drawing = true;
  requestAnimationFrame(() => {
    drawing = false;
    const start = performance.now();
    // The reader may have scrolled or jumped to a file that still waits.
    drawDiffsOnScreen();
    for (const box of undrawn.keys()) {
      if (performance.now() - start >= frameDrawMs) break;
      drawDiff(box);
    }
    drawOverFrames();
  });
}

/** Draw the waiting diffs that are on screen now, so the reader never sees an empty box. */
function drawDiffsOnScreen(): void {
  // All positions are read before any diff is drawn, since each draw would make the next read lay out the page again.
  const onScreen: HTMLElement[] = [];
  for (const box of undrawn.keys()) {
    const rect = box.getBoundingClientRect();
    if (rect.top >= window.innerHeight) break;
    if (rect.bottom > 0) onScreen.push(box);
  }
  for (const box of onScreen) drawDiff(box);
}

/** Redraw the file list; given paths, or 'state' for files whose state changed, redraw only those boxes when the rest are on the page. */
export function renderFiles(only?: readonly (string | undefined)[] | 'state'): void {
  for (const name of ['unified', 'split'] as const) $(name).setAttribute('aria-pressed', String(prefs.layout === name));
  for (const name of ['overview', 'code'] as const) $('view-' + name).setAttribute('aria-selected', String(prefs.view === name));
  $('panel-overview').hidden = prefs.view !== 'overview';
  $('panel-files').hidden = prefs.view === 'overview';
  $('files-bar').classList.toggle('on-overview', prefs.view === 'overview');
  showCodeTab();
  renderRangeControls();
  setTip($('fold-all'), allFolded() ? 'Expand all files' : 'Collapse all files');
  $('fold-all').innerHTML = allFolded() ? icons.expandAll : icons.collapseAll;
  if (!received.files || prefs.view === 'overview') return;
  if (ui.focusThread !== undefined) {
    const id = ui.focusThread;
    ui.focusThread = undefined;
    requestAnimationFrame(() => { drawPendingDiffs(); document.getElementById('thread-' + id)?.querySelector('summary')?.focus({ preventScroll: true }); });
  }
  if (guided() && received.current?.analysis.result) { keepView(() => renderGuide(only)); return; }
  const opened = filteredFiles(openedFiles());
  const changes = received.files.filter((file) => file.change !== 'unchanged');
  const shownChanges = filteredFiles(changes);
  const shownFiles = [...shownChanges, ...opened];
  const container = $('files');
  const threadsByFile = new Map<string, Thread[]>();
  for (const thread of allThreads().filter(inFiles)) {
    const list = threadsByFile.get(thread.path) ?? [];
    threadsByFile.set(thread.path, list);
    list.push(thread);
  }
  const tree = fileTree(shownChanges);
  renderFileNav(shownChanges, opened, threadsByFile);
  const visible = !prefs.folders ? shownFiles : shownFiles.filter((file) => !folderOf(file.path).some((folder) => collapsed.get('folder:' + folder) === true));
  const boxes = new Map([...container.querySelectorAll<HTMLElement>('.file[data-path]')].map((node) => [node.dataset.path, node]));
  const threadsOf = (path: string): Thread[] => threadsByFile.get(path) ?? [];
  const changed = only === 'state' ? visible.map((file) => file.path).filter((path) => fileKeys.get(path) !== fileKey(path, threadsOf(path))) : only;
  const targets = changed && boxes.size === visible.length ? [...new Set(changed.filter((path): path is string => path !== undefined))] : undefined;
  const started = performance.now();
  const draw = (file: FileDiff, wait = false): HTMLElement => {
    fileKeys.set(file.path, fileKey(file.path, threadsOf(file.path)));
    return fileBox(file, threadsOf(file.path), wait && performance.now() - started >= firstDrawMs);
  };
  const redrawn = targets?.every((path) => boxes.has(path)) ? targets.flatMap((path) => boxes.get(path) ?? []) : undefined;
  keepView(() => {
    if (redrawn && targets) {
      for (const path of targets) {
        const file = shownFiles.find((item) => item.path === path);
        if (file) boxes.get(path)?.replaceWith(draw(file));
      }
    } else {
      container.replaceChildren(...guided() ? [guideIntro()] : []);
      fileKeys.clear();
      undrawn.clear();
      if (!shownFiles.length) container.append(el('p', 'muted', changes.length || openedFiles().length ? 'No files match the filter.' : received.current?.localMode ? 'No uncommitted changes. Pick a file in the Local view to review it.' : received.diffRange.kind === 'all' ? 'No changes against the base branch.' : 'No changes in ' + rangeLabel(received.diffRange) + '.'));
      const append = (parent: HTMLElement, folder: FileFolder<FileDiff>, depth: number): void => {
        for (const child of folder.folders) {
          const isCollapsed = collapsed.get('folder:' + child.path) === true;
          const head = el('div', 'folder-head');
          head.dataset.folder = child.path;
          const holdsLocal = Object.keys(received.current?.local ?? {}).some((path) => path.startsWith(child.path + '/'));
          head.append(el('span', 'name', child.name), ...(holdsLocal ? [localMarkOf('unpushed', 'Holds files with work GitHub does not have yet')] : []), el('span', 'muted progress'));
          const { node, rail } = railNode(head, depth, isCollapsed, () => { collapsed.set('folder:' + child.path, !isCollapsed); save(); renderFiles(); });
          put(parent, depth, node);
          if (!isCollapsed) append(rail, child, depth + 1);
        }
        for (const file of folder.files) put(parent, depth, draw(file, true));
      };
      const put = (parent: HTMLElement, depth: number, child: HTMLElement): void => { parent.append(depth === 0 ? child : railItem(child)); };
      if (prefs.folders) append(container, tree, 0);
      else for (const file of shownChanges) container.append(draw(file, true));
      for (const file of opened) container.append(draw(file, true));
    }
    if (prefs.folders) updateFolderProgress(tree);
    for (const frame of container.querySelectorAll<HTMLIFrameElement>('iframe.html-preview')) layoutMargin(frame, frameTops.get(frame.dataset.path ?? '') ?? {});
  }, container, redrawn);
  drawDiffsOnScreen();
  drawOverFrames();
  markCurrentNavFile();
}

/** Holds live HTML preview frames while their file box is rebuilt; `moveBefore` keeps a frame's page loaded where `append` would reload it. */
export const frameParking = el('div');

function parkFrames(scopes: readonly HTMLElement[]): HTMLIFrameElement[] {
  if (typeof frameParking.moveBefore !== 'function') return [];
  const frames = scopes.flatMap((scope) => [...scope.querySelectorAll<HTMLIFrameElement>('iframe.html-preview')]);
  for (const frame of frames) frameParking.moveBefore(frame, null);
  return frames;
}

/** Put each parked frame in place of the new frame for the same file and source, then drop the frames nothing took back. */
function restoreFrames(container: HTMLElement, parked: readonly HTMLIFrameElement[]): void {
  for (const fresh of container.querySelectorAll<HTMLIFrameElement>('iframe.html-preview')) {
    const live = parked.find((frame) => frame.parentElement === frameParking && frame.dataset.path === fresh.dataset.path && frame.srcdoc === fresh.srcdoc);
    if (!live || !fresh.parentElement) continue;
    fresh.parentElement.moveBefore(live, fresh);
    fresh.remove();
    frameMessage(live, { lrReady: true });
  }
  frameParking.replaceChildren();
}

/**
 * Redraw the file list, or `container`, without losing the scroll position, a preview's own scroll position, the draft being typed or a loaded HTML preview.
 * `redrawn` names the boxes `draw` replaces; frames elsewhere stay where they are.
 */
export function keepView(draw: () => void, container = $('files'), redrawn: readonly HTMLElement[] = [container]): void {
  const scroll = window.scrollY;
  const active = document.activeElement;
  const focus = active instanceof HTMLTextAreaElement && active.dataset.draft ? { key: active.dataset.draft, start: active.selectionStart, end: active.selectionEnd } : undefined;
  const frames = parkFrames(redrawn);
  const scrolls = new Map([...container.querySelectorAll<HTMLElement>('[data-scroll-key]')].map((node) => [node.dataset.scrollKey, node.scrollTop]));
  draw();
  restoreFrames(container, frames);
  for (const node of container.querySelectorAll<HTMLElement>('[data-scroll-key]')) node.scrollTop = scrolls.get(node.dataset.scrollKey) ?? 0;
  // The draft may sit in a diff that is not drawn yet.
  const draft = (key: string): HTMLTextAreaElement | null => {
    const selector = '[data-draft="' + CSS.escape(key) + '"]';
    const found = container.querySelector<HTMLTextAreaElement>(selector);
    if (found || !undrawn.size) return found;
    drawPendingDiffs();
    return container.querySelector<HTMLTextAreaElement>(selector);
  };
  if (focus) {
    const area = draft(focus.key);
    if (area) { area.focus({ preventScroll: true }); area.setSelectionRange(focus.start, focus.end); }
  }
  window.scrollTo(0, scroll);
  if (ui.focusNext) {
    const area = draft(ui.focusNext);
    ui.focusNext = undefined;
    area?.focus();
  }
}

/** A file header's icon buttons, kept together before Viewed. */
export function headTools(...buttons: HTMLButtonElement[]): HTMLElement {
  const tools = el('span', 'head-tools');
  for (const each of buttons) each.classList.add('icon-button');
  tools.append(...buttons);
  return tools;
}

/** Diff and Preview buttons for a file that can be previewed and still has a readable diff. */
export function previewSwitch(file: FileDiff, showPreview: boolean): HTMLElement {
  const mode = el('span', 'seg');
  mode.hidden = previewKind(file) === undefined || previewOnly(file);
  for (const [text, on] of [['Diff', false], ['Preview', true]] as const) {
    const option = button(text, () => {
      if (on) previewing.add(file.path);
      else previewing.delete(file.path);
      save();
      renderFiles([file.path]);
    });
    option.setAttribute('aria-pressed', String(showPreview === on));
    mode.append(option);
  }
  return mode;
}

/** Diffs GitHub does not render until asked. */
export function isLarge(file: FileDiff): boolean {
  return file.additions + file.deletions > 1500;
}

/** A file's box; with `wait`, a diff table is left for `drawOverFrames`. */
function fileBox(file: FileDiff, threads: readonly Thread[], wait = false): HTMLElement {
  const isCollapsed = collapsed.get(file.path) === true;
  const box = el('div', 'file' + (isCollapsed ? ' collapsed' : ''));
  box.dataset.path = file.path;
  const head = el('div', 'file-head');
  const chevron = chevronMark(isCollapsed);
  const base = file.path.split('/').at(-1) ?? file.path;
  const shown = prefs.folders ? base : file.path;
  const name = el('span', 'name', file.oldPath ? file.oldPath + ' → ' + shown : shown);
  name.title = file.path;
  const toggle = (): void => { collapsed.set(file.path, !isCollapsed); save(); renderFiles([file.path]); };
  chevron.addEventListener('click', toggle);
  name.addEventListener('click', toggle);
  const badge = el('span', 'badge ' + file.change, changeLetters[file.change]);
  badge.title = file.change;
  const stats = el('span', 'stats');
  if (file.saved) {
    const chip = el('span', 'file-chip', 'Saved code');
    chip.title = 'This file no longer exists. Showing the code saved with its comments.';
    stats.append(chip);
  }
  else if (file.change === 'unchanged') stats.append(el('span', 'file-chip', 'Not changed'));
  else stats.append(el('span', 'stat-add', '+' + file.additions), ' ', el('span', 'stat-del', '−' + file.deletions));
  const label = el('label', 'viewed');
  const check = el('input');
  check.type = 'checkbox';
  check.checked = received.viewed.has(file.path);
  check.addEventListener('change', () => {
    markViewed(file.path, check.checked);
    post({ action: 'viewed', path: file.path, viewed: check.checked });
    renderFiles([file.path]);
  });
  label.append(check, 'Viewed');
  const open = toolButton(icons.openExternal, 'Open in editor', () => post({ action: 'editor', path: file.path }));
  open.hidden = file.saved === true;
  const whole = fullFile(file);
  const full = toolButton(whole ? icons.file : icons.fullFile, whole ? 'Diff only' : 'Full file', () => {
    expanded.set(file.path, whole ? new Map() : new Map(Array.from({ length: file.hunks.length + 1 }, (_, index) => [index, { top: Infinity, bottom: 0 }])));
    loadContext(file);
    renderFiles([file.path]);
  });
  const kind = previewKind(file);
  const showPreview = kind !== undefined && (previewing.has(file.path) || previewOnly(file));
  full.hidden = showPreview || file.binary || file.change === 'added' || file.change === 'deleted' || file.change === 'unchanged' || !file.hunks.length || !received.atHead;
  const mode = previewSwitch(file, showPreview);
  const unresolved = threads.filter((thread) => !thread.resolved).length;
  const comments = el('span', 'muted comments');
  if (threads.length) {
    comments.append(icon(icons.comment), String(threads.length));
    comments.title = threads.length + (threads.length === 1 ? ' comment' : ' comments') + (unresolved === threads.length ? '' : ', ' + unresolved + ' open');
  }
  const chips = file.generated ? [el('span', 'file-chip', 'Generated')] : isLarge(file) ? [el('span', 'file-chip', 'Large diff')] : [];
  for (const chip of chips) chip.title = file.generated ? 'Generated file. GitHub folds these by default.' : 'Large diff, folded by default.';
  const commentFile = toolButton(icons.comment, 'Comment on the whole file', () => openFileComposer(file.path));
  commentFile.hidden = !received.atHead || file.change === 'deleted';
  const themeIcon = received.fileIcons?.byPath[file.path];
  const close = toolButton(icons.close, 'Close', () => { closeFiles([file.path]); });
  close.hidden = file.change !== 'unchanged' || threads.length > 0;
  head.append(chevron, ...themeIcon ? [iconNode(themeIcon)] : [], name, badge, ...localMark(file.path), stats, ...chips, comments, mode, headTools(full, commentFile, open), label, headTools(close));
  box.append(head);
  const diff = el('div', 'diff');
  // Off-screen diffs skip layout and paint; their row count sizes them until first drawn.
  diff.style.setProperty('--diff-rows', String(file.hunks.reduce((rows, hunk) => rows + hunk.lines.length + 1, 0)));
  const placed = new Set(threads.filter((thread) => !standalone(thread)).map((thread) => thread.id));
  const fileThreads = wholeFileBlock(file.path, threads, placed, true);
  if (fileThreads) diff.append(fileThreads);
  const outsideThreads = (): void => {
    const outside = threads.filter((thread) => !placed.has(thread.id));
    if (!outside.length) return;
    const block = el('div', 'outside');
    block.append(el('div', 'muted', 'Comments on lines this diff does not show'), ...outside.map(threadBox));
    diff.insertBefore(block, fileThreads?.nextSibling ?? diff.firstChild);
  };
  if (showPreview && kind === 'media') diff.append(mediaNode(file));
  else if (file.binary) diff.append(el('div', 'note muted', 'Binary file not shown.'));
  else if (showPreview) diff.append(previewNode(file, threads, placed));
  else if (!file.hunks.length) diff.append(el('div', 'note muted', file.change === 'renamed' ? 'Renamed without changes.' : 'No content changes.'));
  else if (!isCollapsed) {
    // The table reads the file as it is when drawn, since its syntax colors may arrive in between.
    const drawTable = (): void => {
      diff.append(table(received.files?.find((each) => each.path === file.path) ?? file, threads, placed));
      outsideThreads();
    };
    if (wait) undrawn.set(box, drawTable);
    else drawTable();
  }
  // A folded file draws no table of lines; unfolding redraws its box.
  if (showPreview || file.binary || !file.hunks.length) outsideThreads();
  box.append(diff);
  return box;
}

/** Threads about the whole file, and its new-comment box when `withComposer`, above the diff; marks those threads placed. */
export function wholeFileBlock(path: string, threads: readonly Thread[], placed: Set<string>, withComposer: boolean): HTMLElement | undefined {
  const own = threads.filter((thread) => thread.scope === 'file' && standalone(thread) && !placed.has(thread.id));
  const draft = withComposer && prefs.fileComposer?.path === path ? prefs.fileComposer : undefined;
  if (!own.length && !draft) return undefined;
  for (const thread of own) placed.add(thread.id);
  const block = el('div', 'file-threads');
  block.append(...own.map(threadBox), ...draft ? [fileComposerBox(draft)] : []);
  return block;
}
