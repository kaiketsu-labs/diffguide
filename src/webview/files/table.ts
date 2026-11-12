/** The diff table: hunks, gaps, context expansion and inline rows. */
import type { DiffSide } from '../../pullRequestOverview.js';
import type { Annotation } from '../../pullRequests.js';
import { readLines } from '../../readLines.js';
import type { DiffHunk, DiffLine, FileDiff } from '../../unifiedDiff.js';
import { renderConversation } from '../conversation/timeline.js';
import { button, chevronMark, el, stateIcon } from '../dom.js';
import { setView } from '../render.js';
import { collapsed, prefs, received, save, ui } from '../state.js';
import { composerBox } from '../threads/composer.js';
import { marginMark } from '../threads/list.js';
import { inFiles } from '../threads/model.js';
import { threadBox, threadOpen } from '../threads/threadBox.js';
import { post } from '../transport.js';
import type { Composer, Thread } from '../types.js';
import { linesFit } from './filters.js';
import { annotationBox, annotationsOf, loadContext, unmarkRead } from './marks.js';
import { folderOf, openFolders } from './nav.js';
import { renderFiles } from './render.js';
import { code, num } from './selection.js';

/** Unchanged new-side lines between hunks; `offset` maps them to old-side lines. */
interface Gap { readonly from: number; readonly to: number; readonly offset: number; readonly last?: true }
interface Shown { readonly top: number; readonly bottom: number }
type Row = readonly (DiffLine | undefined)[];
const openReads = new Set<string>();
export const contextLines = new Map<string, readonly string[]>();
export const expanded = new Map<string, Map<number, Shown>>();
const step = 20;

function inline(content: HTMLElement, width: number): HTMLTableRowElement {
  const row = el('tr', 'inline');
  const cell = el('td');
  cell.colSpan = width;
  cell.append(content);
  row.append(cell);
  return row;
}

export function jump(thread: Thread): void {
  if (thread.scope === 'pullRequest') {
    if (prefs.view !== 'overview') setView('overview');
    ui.conversationAll = true;
    if (prefs.conversationFolded) { prefs.conversationFolded = false; save(); }
    threadOpen.set(thread.id, true);
    if (received.current) renderConversation(received.current, true);
    document.getElementById('thread-' + thread.id)?.scrollIntoView({ block: 'center' });
    return;
  }
  if (!received.files?.some((file) => file.path === thread.path)) {
    post({ action: thread.source === 'github' ? 'github' : 'thread', id: thread.id });
    return;
  }
  if (!inFiles(thread)) { if (prefs.view !== 'guide') setView('guide'); } else if (prefs.view === 'overview' || (prefs.view === 'guide' && !document.getElementById('thread-' + thread.id))) setView('files');
  if (collapsed.get(thread.path) || folderOf(thread.path).some((folder) => collapsed.get('folder:' + folder))) {
    collapsed.set(thread.path, false);
    openFolders(thread.path);
    save();
    renderFiles();
  }
  const target = document.getElementById('thread-' + thread.id) as HTMLDetailsElement | null;
  if (!target) return;
  const outer = target.parentElement?.closest<HTMLDetailsElement>('details.thread');
  if (outer) { outer.open = true; threadOpen.set(outer.id.slice('thread-'.length), true); }
  target.open = true;
  threadOpen.set(thread.id, true);
  target.scrollIntoView({ block: 'center' });
}

/** Hunk lines side by side: removed lines next to the added lines that replace them. */
function pairs(hunk: DiffHunk): Row[] {
  const out: Row[] = [];
  let dels: DiffLine[] = [];
  let adds: DiffLine[] = [];
  const flush = (): void => {
    for (let index = 0; index < Math.max(dels.length, adds.length); index++) out.push([dels[index], adds[index]]);
    dels = [];
    adds = [];
  };
  for (const line of hunk.lines) {
    if (line.kind === 'del') dels.push(line);
    else if (line.kind === 'add') adds.push(line);
    else { flush(); out.push([line, line]); }
  }
  flush();
  return out;
}

export function hunkRange(hunk: DiffHunk): { oldBefore: number; newBefore: number; oldEnd: number; newEnd: number } | undefined {
  const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/u.exec(hunk.header);
  if (!match) return undefined;
  const oldStart = Number(match[1]);
  const oldCount = match[2] === undefined ? 1 : Number(match[2]);
  const newStart = Number(match[3]);
  const newCount = match[4] === undefined ? 1 : Number(match[4]);
  return {
    oldBefore: oldCount ? oldStart - 1 : oldStart, newBefore: newCount ? newStart - 1 : newStart,
    oldEnd: oldCount ? oldStart + oldCount - 1 : oldStart, newEnd: newCount ? newStart + newCount - 1 : newStart,
  };
}

/** Unchanged lines around each hunk, as new-side line ranges; the last one runs to the end of the file. */
export function gapsOf(file: FileDiff): Gap[] {
  const lines = contextLines.get(file.path);
  const out: Gap[] = [];
  let newEnd = 0;
  let oldEnd = 0;
  for (const hunk of file.hunks) {
    const span = hunkRange(hunk);
    if (!span) return [];
    out.push({ from: newEnd + 1, to: span.newBefore, offset: span.oldBefore - span.newBefore });
    newEnd = span.newEnd;
    oldEnd = span.oldEnd;
  }
  out.push({ from: newEnd + 1, to: lines ? lines.length : Infinity, offset: oldEnd - newEnd, last: true });
  return out;
}

export function expansion(path: string, index: number): Shown {
  return expanded.get(path)?.get(index) ?? { top: 0, bottom: 0 };
}

function expand(file: FileDiff, key: string, index: number, top: number, bottom: number): void {
  const shown = expansion(key, index);
  const byFile = expanded.get(key) ?? new Map<number, Shown>();
  expanded.set(key, byFile);
  byFile.set(index, { top: shown.top + top, bottom: shown.bottom + bottom });
  loadContext(file);
  renderFiles([file.path]);
}

/** `expandKey` names where shown context lines are kept; a guide step passes its own so its slice does not share the file's. */
export function table(file: FileDiff, threads: readonly Thread[], placed: Set<string>, draft: Composer | null | undefined = prefs.composer?.path === file.path ? prefs.composer : undefined, expandKey = file.path): HTMLTableElement {
  const node = el('table');
  const columns = el('colgroup');
  // An unchanged file has the same lines on both sides, so it shows them once with one line number.
  const single = file.change === 'unchanged';
  const split = prefs.layout === 'split' && !single;
  const widths = split ? ['num', '', 'num', ''] : single ? ['num', ''] : ['num', 'num', ''];
  for (const name of widths) columns.append(el('col', name));
  node.append(columns);
  const notes = annotationsOf(file.path);
  const shownNotes = new Set<Annotation>();
  const add = (row: HTMLTableRowElement, covers: readonly (readonly [DiffSide, number | undefined])[], hidden = false): void => {
    if (!hidden) node.append(row);
    for (const [side, line] of covers) {
      if (line === undefined) continue;
      if (draft?.side === side && draft.start <= line && line <= draft.end) {
        const cells = [...row.children].slice(split && side === 'new' ? 2 : 0, split && side === 'old' ? 2 : undefined);
        for (const cell of cells) cell.classList.add('sel');
        cells[0]?.classList.add('sel-start');
      }
      for (const thread of threads) {
        if (placed.has(thread.id) || thread.outdated || thread.side !== side || thread.endLine !== line || !linesFit(side)) continue;
        placed.add(thread.id);
        if (prefs.marginThreads && !hidden && threadOpen.get(thread.id) !== true) marginMark(row, side, thread);
        else node.append(inline(threadBox(thread), widths.length));
      }
      if (side === 'new' && !hidden) {
        for (const note of notes) {
          if (note.endLine !== line || shownNotes.has(note)) continue;
          shownNotes.add(note);
          const row = inline(annotationBox(note), widths.length);
          row.classList.add('annotation');
          node.append(row);
        }
      }
      if (draft?.side === side && draft.end === line) node.append(inline(composerBox(draft), widths.length));
    }
  };
  const lineRow = (line: DiffLine, hidden = false): void => {
    const row = el('tr', line.kind);
    row.append(...single ? [] : [num(line.oldLine, file.path, 'old')], num(line.newLine, file.path, 'new'), code(line, ''));
    add(row, [['old', line.oldLine], ['new', line.newLine]], hidden);
  };
  const pairRow = (left: DiffLine | undefined, right: DiffLine | undefined, hidden = false): void => {
    const row = el('tr');
    const same = left === right;
    if (left) row.append(num(left.oldLine, file.path, 'old'), code(left, same ? '' : 'del'));
    else row.append(el('td', 'num empty'), el('td', 'code empty'));
    if (right) row.append(num(right.newLine, file.path, 'new'), code(right, same ? '' : 'add'));
    else row.append(el('td', 'num empty'), el('td', 'code empty'));
    add(row, [['old', left?.oldLine], ['new', right?.newLine]], hidden);
  };
  const contextRow = (newLine: number, offset: number): void => {
    const html = contextLines.get(file.path)?.[newLine - 1];
    if (html === undefined) return;
    const line: DiffLine = { kind: 'context', oldLine: newLine + offset, newLine, html };
    if (split) pairRow(line, line);
    else lineRow(line);
  };
  const gaps = gapsOf(file);
  const read = readLines(file, received.readRanges);
  const readRow = (lines: readonly DiffLine[], key: string, open: boolean): HTMLTableRowElement => {
    const row = el('tr', 'read-run');
    const cell = el('td');
    cell.colSpan = widths.length;
    row.append(cell);
    const label = el('span', 'read-label');
    label.append(chevronMark(!open), stateIcon('done', ''), lines.length + (lines.length === 1 ? ' line read' : ' lines read'));
    label.title = open ? 'Hide these lines' : 'Show these lines';
    label.addEventListener('click', () => {
      if (open) openReads.delete(key);
      else openReads.add(key);
      renderFiles([file.path]);
    });
    const ids = [...new Set(lines.flatMap((line) => read.get(line) ?? []))];
    cell.append(label, button('Unmark', () => { unmarkRead(ids); renderFiles([file.path]); }));
    return row;
  };
  const expander = (gap: Gap, index: number, header?: string): void => {
    const size = gap.to - gap.from + 1;
    const shown = expansion(expandKey, index);
    const hidden = size - shown.top - shown.bottom;
    const row = el('tr', 'hunk');
    const cell = el('td');
    cell.colSpan = widths.length;
    row.append(cell);
    if (hidden > 0 && received.atHead) {
      const tools = el('span', 'expand');
      const tool = (label: string, title: string, onClick: () => void): void => {
        const node = button(label, onClick);
        node.title = title;
        tools.append(node);
      };
      if (hidden <= step && !gap.last) tool('↕', 'Show ' + hidden + ' hidden lines', () => expand(file, expandKey, index, hidden, 0));
      else {
        if (index > 0) tool('↓', 'Show ' + step + ' more lines below', () => expand(file, expandKey, index, step, 0));
        if (!gap.last) tool('↑', 'Show ' + step + ' more lines above', () => expand(file, expandKey, index, 0, step));
      }
      cell.append(tools);
    }
    if (header && shown.bottom === 0) cell.append(el('span', '', header));
    else if (hidden > 0) cell.append(el('span', '', Number.isFinite(hidden) ? hidden + ' more lines' : 'Rest of the file'));
    if (hidden > 0 || (header && size <= 0)) node.append(row);
  };
  const gapRows = (gap: Gap, index: number, header?: string): void => {
    const size = gap.to - gap.from + 1;
    const shown = expansion(expandKey, index);
    if (size <= 0) {
      if (header) expander({ from: 1, to: 0, offset: 0 }, index, header);
      return;
    }
    if (!contextLines.has(file.path) || !received.atHead) { expander(gap, index, header); return; }
    const top = Math.min(shown.top, size);
    const bottom = Math.min(shown.bottom, size - top);
    for (let line = gap.from; line < gap.from + top; line++) contextRow(line, gap.offset);
    expander(gap, index, header);
    for (let line = gap.to - bottom + 1; line <= gap.to; line++) contextRow(line, gap.offset);
  };
  const draw = (row: Row, hidden: boolean): void => {
    if (split) pairRow(row[0], row[1], hidden);
    else if (row[0]) lineRow(row[0], hidden);
  };
  const isRead = (row: Row): boolean => row.every((line) => !line || read.has(line));
  file.hunks.forEach((hunk, index) => {
    const gap = gaps[index];
    // An unchanged file is one hunk of every line, so it has no header or gaps to show.
    if (file.change !== 'unchanged' && gap) gapRows(gap, index, hunk.header);
    else if (file.change !== 'unchanged') {
      const header = el('tr', 'hunk');
      const cell = el('td', '', hunk.header);
      cell.colSpan = widths.length;
      header.append(cell);
      node.append(header);
    }
    const rows: Row[] = split ? pairs(hunk) : hunk.lines.map((line) => [line]);
    for (let at = 0; at < rows.length;) {
      const row = rows[at];
      if (row && !isRead(row)) { draw(row, false); at += 1; continue; }
      let end = at;
      while (end < rows.length && isRead(rows[end] ?? [])) end += 1;
      const run = rows.slice(at, end);
      const lines = [...new Set(run.flat().filter((line): line is DiffLine => line !== undefined))];
      const key = file.path + ':' + (lines[0]?.oldLine ?? '') + ':' + (lines[0]?.newLine ?? '');
      const open = openReads.has(key);
      node.append(readRow(lines, key, open));
      for (const hiddenRow of run) draw(hiddenRow, !open);
      at = end;
    }
  });
  const last = gaps[file.hunks.length];
  if (last && file.change !== 'added' && file.change !== 'deleted' && file.change !== 'unchanged') gapRows(last, file.hunks.length);
  return node;
}
