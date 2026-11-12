/** Thread lists, margin marks and the thread hover card. */
import type { DiffSide } from '../../pullRequestOverview.js';
import { $, chevronMark, el, icon, timeLabel, titled } from '../dom.js';
import { filteredFiles, filtersOn } from '../files/filters.js';
import { iconNode } from '../files/nav.js';
import { renderFiles } from '../files/render.js';
import { jump } from '../files/table.js';
import { threadKind } from '../review/review.js';
import { collapsed, prefs, received, save, ui } from '../state.js';
import { post } from '../transport.js';
import type { Thread, ThreadKind } from '../types.js';
import { allThreads, inFiles, nestedIn, standalone } from './model.js';
import { avatar, kindLabel, kindLabels, kindMarks, threadOpen } from './threadBox.js';

/** A collapsed thread as a dot in its line's number cell; clicking it opens the thread in the diff. */
export function marginMark(row: HTMLTableRowElement, side: DiffSide, thread: Thread): void {
  const cell = row.querySelectorAll<HTMLTableCellElement>('td.num')[side === 'new' ? 1 : 0];
  if (cell === undefined) return;
  let marks = cell.querySelector<HTMLElement>('.margin-marks');
  if (marks === null) {
    marks = el('span', 'margin-marks');
    cell.classList.add('has-marks');
    cell.prepend(marks);
  }
  const kind = threadKind(thread);
  const mark = el('button', 'margin-mark ' + kind);
  const title = (thread.source === 'local' ? thread.title : undefined) ?? thread.text;
  hoverPreview(mark, thread);
  mark.setAttribute('aria-label', 'Open comment: ' + title);
  mark.addEventListener('mousedown', (event) => { event.stopPropagation(); });
  mark.addEventListener('click', (event) => {
    event.stopPropagation();
    threadOpen.set(thread.id, true);
    ui.focusThread = thread.id;
    renderFiles([thread.path]);
  });
  marks.append(mark);
}
const threadKinds: readonly ThreadKind[] = ['github', 'local', 'review', 'analysis'];

/** The Threads card: one foldable group per kind, one line per thread. Guide starts folded because its notes already sit in the diff. */
export function renderThreadList(): void {
  const threads = allThreads();
  $('threads-title').textContent = 'Threads (' + threads.length + ')';
  const list = $('threads');
  list.replaceChildren();
  if (threads.length === 0) list.append(el('li', 'muted', received.current?.localMode || received.current?.github || received.current?.githubError ? 'No comments yet.' : 'No local comments yet. Loading GitHub comments…'));
  if (received.current?.githubError) list.append(el('li', 'bad', 'Could not load GitHub comments: ' + received.current.githubError));
  for (const kind of threadKinds) {
    const members = threads.filter((thread) => threadKind(thread) === kind && standalone(thread));
    if (!members.length) continue;
    const key = 'threads:' + kind;
    const isCollapsed = collapsed.get(key) ?? kind === 'analysis';
    const group = el('li', 'thread-group ' + kind);
    const head = el('div', 'thread-group-head');
    head.append(chevronMark(isCollapsed), kindLabel(kind), el('span', 'muted', String(members.length)));
    head.addEventListener('click', () => { collapsed.set(key, !isCollapsed); save(); renderThreadList(); });
    group.append(head);
    if (!isCollapsed) {
      const rows = el('ul');
      for (const thread of members) {
        rows.append(threadRow(thread, kind));
        if (thread.source === 'github') for (const local of nestedIn(thread.id)) rows.append(threadRow(local, threadKind(local), true));
      }
      group.append(rows);
    }
    list.append(group);
  }
  renderNavThreads();
}

/** The comments panel under the file list: open threads on files the filters leave, grouped by file in page order; a click jumps to the thread. */
export function renderNavThreads(): void {
  const pageFiles = received.files ?? [];
  const order = new Map(pageFiles.map((file, index) => [file.path, index]));
  const shown = new Set(filteredFiles(pageFiles).map((file) => file.path));
  const threads = allThreads().filter((thread) => !thread.resolved && standalone(thread) && (prefs.view !== 'files' || inFiles(thread)) && (shown.has(thread.path) || (!order.has(thread.path) && !filtersOn())));
  const byFile = new Map<string, Thread[]>();
  for (const thread of threads) byFile.set(thread.path, [...byFile.get(thread.path) ?? [], thread]);
  const paths = [...byFile.keys()].sort((left, right) => (order.get(left) ?? Infinity) - (order.get(right) ?? Infinity) || left.localeCompare(right));
  const panel = $('nav-threads');
  panel.hidden = threads.length === 0;
  $('nav-split').hidden = panel.hidden;
  const head = el('div', 'nav-head');
  head.append('Comments', el('span', 'muted', String(threads.length)));
  const list = el('ul', 'nav-list');
  const wholeFile = (thread: Thread): boolean => thread.source === 'local' && thread.scope === 'file';
  for (const path of paths) {
    const fileRow = el('li', 'nav-thread-file');
    fileRow.title = path;
    const themeIcon = received.fileIcons?.byPath[path];
    fileRow.append(themeIcon ? iconNode(themeIcon) : el('span', 'file-icon'), el('span', 'nav-name', path.split('/').at(-1) ?? path));
    list.append(fileRow);
    const members = (byFile.get(path) ?? []).sort((left, right) => (wholeFile(left) ? 0 : left.startLine) - (wholeFile(right) ? 0 : right.startLine));
    for (const thread of members) {
      const kind = threadKind(thread);
      const row = el('button', 'nav-file nav-thread ' + kind);
      row.style.setProperty('--depth', '1');
      hoverPreview(row, thread);
      const mark = titled(el('span', 'nav-kind'), kindLabels[kind]);
      mark.append(icon(kindMarks[kind]));
      const lines = wholeFile(thread) ? 'File' : 'L' + thread.startLine + (thread.endLine > thread.startLine ? '–' + thread.endLine : '');
      row.append(mark, el('span', 'nav-lines', lines), el('span', 'nav-name', thread.text.split('\n')[0] ?? ''));
      row.addEventListener('click', () => { jump(thread); });
      const item = el('li');
      item.append(row);
      list.append(item);
    }
  }
  panel.replaceChildren(head, list);
}

/** Plain text with `backtick` spans shown as code. */
function inlineCode(text: string): Node[] {
  return text.split('`').map((part, index) => index % 2 === 1 ? el('code', '', part) : document.createTextNode(part));
}

/** One thread as a row: where on the left, the text in a column that lines up, status on the right only when it adds something. */
/** Your pending review's comments under Finish your review, in page order; a click jumps to the thread. */
export function renderPendingList(reviewing: boolean): void {
  const list = $('pending-list');
  const order = new Map((received.files ?? []).map((file, index) => [file.path, index]));
  const threads = (received.current?.github ?? []).filter((thread) => thread.messages.some((message) => message.pending))
    .sort((left, right) => (order.get(left.path) ?? Infinity) - (order.get(right.path) ?? Infinity) || left.path.localeCompare(right.path) || left.startLine - right.startLine);
  list.hidden = !reviewing || threads.length === 0;
  list.replaceChildren(...list.hidden ? [] : threads.flatMap((thread) => thread.messages.filter((message) => message.pending).map((message) => {
    const row = threadRow({ ...thread, source: 'github', text: message.body, messages: [message] }, 'github');
    row.querySelector('.state')?.replaceChildren();
    return row;
  })));
}

export function threadRow(thread: Thread, kind: ThreadKind, nested = false): HTMLElement {
  const item = el('li', 'card-thread ' + kind + (nested ? ' nested' : ''));
  hoverPreview(item, thread);
  item.addEventListener('click', () => jump(thread));
  const text = el('span', 'text');
  text.append(...inlineCode((thread.source === 'local' ? thread.title : undefined) ?? thread.text));
  const status = kind === 'analysis' || kind === 'review' ? '' : thread.status;
  const working = thread.source === 'local' ? thread.working : undefined;
  const [name = '', line = ''] = (thread.location.split('/').pop() ?? '').split(/(?=:\d+$)/u);
  const where = el('span', 'where');
  where.append(el('span', 'name', name), line);
  const state = el('span', 'state', working ? '' : status);
  if (working) state.append(el('span', 'chip agent working', working));
  item.append(where, text, state);
  if (thread.url) {
    const link = el('a', 'open', '↗');
    link.title = 'Open on GitHub';
    link.addEventListener('click', (event) => { event.stopPropagation(); post({ action: 'github', id: thread.id }); });
    item.append(link);
  }
  return item;
}

/** The one hover preview of a thread, shared by every item that shows it. */
export const threadHover = el('div', 'thread-hover');
let threadHoverTimer = 0;

/** Shows `thread`'s kind, status, place and latest message when the pointer rests on `node`. */
function hoverPreview(node: HTMLElement, thread: Thread): void {
  node.addEventListener('mouseenter', () => {
    clearTimeout(threadHoverTimer);
    threadHoverTimer = window.setTimeout(() => { if (node.isConnected) showThreadHover(node, thread); }, 400);
  });
  node.addEventListener('mouseleave', hideThreadHover);
  node.addEventListener('mousedown', hideThreadHover);
}

export function hideThreadHover(): void {
  clearTimeout(threadHoverTimer);
  ui.threadHoverAnchor = undefined;
  if (threadHover.matches(':popover-open')) threadHover.hidePopover();
}

function showThreadHover(anchor: HTMLElement, thread: Thread): void {
  const kind = threadKind(thread);
  const head = el('div', 'thread-hover-head');
  const title = thread.source === 'local' ? thread.title : undefined;
  const working = thread.source === 'local' ? thread.working : undefined;
  head.append(kindLabel(kind), ...title === undefined ? [] : [el('span', 'title', title)], el('span', 'gap'));
  if (working) head.append(el('span', 'chip agent working', working));
  else if (thread.status) head.append(el('span', 'chip', thread.status));
  threadHover.className = 'thread-hover ' + kind;
  threadHover.replaceChildren(head, el('div', 'where', thread.location));
  const latest = thread.messages.at(-1);
  if (latest !== undefined) {
    const author = 'avatarUrl' in latest ? latest.author : latest.author === 'claude' ? 'Claude' : 'You';
    const item = el('div', 'thread-hover-msg');
    const body = el('div', 'msg-text');
    body.innerHTML = latest.html;
    item.append(avatar(latest, author), body, ...timeLabel(latest.createdAt));
    threadHover.append(item);
  }
  if (thread.messages.length > 1) threadHover.append(el('div', 'muted thread-hover-count', thread.messages.length + ' messages'));
  ui.threadHoverAnchor = anchor;
  threadHover.showPopover();
  const box = anchor.getBoundingClientRect();
  const height = threadHover.offsetHeight;
  const width = threadHover.offsetWidth;
  const below = box.bottom + 4 + height <= window.innerHeight - 8;
  threadHover.style.top = Math.max(8, below ? box.bottom + 4 : box.top - 4 - height) + 'px';
  threadHover.style.left = Math.max(8, Math.min(box.left, window.innerWidth - 8 - width)) + 'px';
}
