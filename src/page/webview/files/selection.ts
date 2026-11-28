/** Line selection in the diff: drag, pick and selected text. */
import type { DiffLine } from '../../../core/unifiedDiff.js';
import type { DiffSide, TextColumns } from '../../protocol.js';
import { el, setTip } from '../dom.js';
import { prefs, received, save, ui } from '../state.js';
import type { Composer } from '../types.js';
import { linesFit } from './filters.js';
import { renderFiles } from './render.js';
import { contextLines } from './table.js';

/** The diff line each drawn code cell shows. */
export const cellLines = new WeakMap<HTMLElement, DiffLine>();

export function code(line: DiffLine, side: '' | 'add' | 'del'): HTMLTableCellElement {
  const cell = el('td', 'code' + (side ? ' ' + side : ''));
  cell.innerHTML = line.html;
  cellLines.set(cell, line);
  if (line.kind !== 'del' && line.newLine !== undefined) cell.dataset.line = String(line.newLine);
  return cell;
}

export function num(value: number | undefined, path: string, side: DiffSide): HTMLTableCellElement {
  const cell = el('td', 'num', value === undefined ? '' : String(value));
  if (value !== undefined && linesFit(side)) {
    cell.classList.add('pick');
    cell.dataset.path = path;
    cell.dataset.side = side;
    cell.title = 'Comment on this line. Drag or Shift-click to select a range.';
    cell.addEventListener('mousedown', (event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      ui.drag = { path, side, from: value, to: value };
      paintDrag();
    });
    cell.addEventListener('mouseenter', () => {
      if (ui.drag && ui.drag.path === path && ui.drag.side === side && ui.drag.to !== value) { ui.drag.to = value; paintDrag(); }
    });
  }
  return cell;
}

export function paintDrag(): void {
  for (const cell of document.querySelectorAll('.drag-sel')) cell.classList.remove('drag-sel');
  if (!ui.drag) return;
  const low = Math.min(ui.drag.from, ui.drag.to);
  const high = Math.max(ui.drag.from, ui.drag.to);
  for (const cell of document.querySelectorAll<HTMLElement>('td.num.pick')) {
    const line = Number(cell.textContent);
    if (cell.dataset.path !== ui.drag.path || cell.dataset.side !== ui.drag.side || line < low || line > high) continue;
    cell.classList.add('drag-sel');
    const codeCell = prefs.layout === 'split' ? cell.nextElementSibling : cell.parentElement?.lastElementChild;
    codeCell?.classList.add('drag-sel');
  }
}

export function pick(path: string, side: DiffSide, line: number, extend: boolean): Composer {
  const before = prefs.composer?.path;
  if (extend && prefs.composer?.path === path && prefs.composer.side === side) {
    prefs.composer.start = Math.min(prefs.composer.start, line);
    prefs.composer.end = Math.max(prefs.composer.end, line);
    // Lines picked in the gutter cover whole lines, so text marked earlier no longer says what the comment is about.
    delete prefs.composer.columns;
  } else {
    prefs.composer = { path, side, start: line, end: line, text: prefs.composer?.text ?? '', target: prefs.composer?.target ?? 'claude' };
  }
  ui.focusNext = 'composer';
  save();
  renderFiles([before, path]);
  return prefs.composer;
}

export function range(start: number, end: number, columns?: TextColumns): string {
  const lines = start === end ? 'Line ' + start : 'Lines ' + start + '–' + end;
  if (columns === undefined) return lines;
  // Columns are counted from 0 with the end left out; people count characters from 1.
  return lines + ' · ' + (columns.start + 1 === columns.end ? String(columns.end) : columns.start + 1 + '-' + columns.end);
}

/** The selected lines as plain text, for a suggestion to start from. */
export function selectedText(path: string, start: number, end: number): string | undefined {
  const full = contextLines.get(path);
  const fromDiff = new Map((received.files?.find((file) => file.path === path)?.hunks ?? []).flatMap((hunk) => hunk.lines)
    .flatMap((line) => line.kind !== 'del' && line.newLine !== undefined ? [[line.newLine, line.html] as const] : []));
  const lines: string[] = [];
  for (let number = start; number <= end; number += 1) {
    const html = full?.[number - 1] ?? fromDiff.get(number);
    if (html === undefined) return undefined;
    const holder = el('div');
    holder.innerHTML = html;
    lines.push(holder.textContent ?? '');
  }
  return lines.join('\n');
}

/** The diff side and line a code cell shows, or undefined when that line takes no comment. */
function cellPlace(cell: HTMLTableCellElement, split: boolean): { side: DiffSide; line: number } | undefined {
  const line = cellLines.get(cell);
  if (!line) return undefined;
  const side: DiffSide = split ? (cell.cellIndex <= 1 ? 'old' : 'new') : line.kind === 'del' ? 'old' : 'new';
  const number = side === 'old' ? line.oldLine : line.newLine;
  return number === undefined || !linesFit(side) ? undefined : { side, line: number };
}

/** Characters of `cell`'s text before a point in it. */
function offsetIn(cell: HTMLElement, node: Node, offset: number): number {
  const before = document.createRange();
  before.setStart(cell, 0);
  before.setEnd(node, offset);
  return before.toString().length;
}

/** The lines a text selection in one diff covers on one side, with the selected text's columns in the first and last line; undefined when it spans files, sides or lines that take no comment. */
export function selectedLines(selection: Selection | null, split = prefs.layout === 'split'): { path: string; side: DiffSide; start: number; end: number; columns: TextColumns } | undefined {
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return undefined;
  const range = selection.getRangeAt(0);
  const cellOf = (node: Node): HTMLTableCellElement | null => (node instanceof Element ? node : node.parentElement)?.closest<HTMLTableCellElement>('td.code') ?? null;
  const first = cellOf(range.startContainer);
  let last = cellOf(range.endContainer);
  // A drag or triple-click that ends at the very start of a row means the row above it, in the same column.
  if (first && range.endOffset === 0 && range.endContainer !== range.startContainer) {
    let row = (range.endContainer instanceof Element ? range.endContainer : range.endContainer.parentElement)?.closest('tr')?.previousElementSibling;
    while (row && !row.querySelector('td.code')) row = row.previousElementSibling;
    const cell = row?.children[first.cellIndex];
    last = cell instanceof HTMLTableCellElement && cell.matches('td.code') ? cell : null;
  }
  const path = first?.closest<HTMLElement>('[data-path]')?.dataset.path;
  const from = first ? cellPlace(first, split) : undefined;
  const to = last ? cellPlace(last, split) : undefined;
  if (!first || !last || !from || !to || path === undefined || last.closest<HTMLElement>('[data-path]')?.dataset.path !== path || from.side !== to.side || to.line < from.line) return undefined;
  // A selection that starts or ends outside the code text, such as in the line numbers, takes its line from the start or to the end.
  const startColumn = first.contains(range.startContainer) ? offsetIn(first, range.startContainer, range.startOffset) : 0;
  const endColumn = last.contains(range.endContainer) ? offsetIn(last, range.endContainer, range.endOffset) : (last.textContent ?? '').length;
  return { path, side: from.side, start: from.line, end: to.line, columns: { start: startColumn, end: endColumn } };
}

/** Each diff table's marked comment text, with the thread each range belongs to, so a redrawn table's ranges leave the highlights. */
const markedSpans = new Map<HTMLTableElement, { range: Range; thread: string | undefined }[]>();
const spanHighlight = new Highlight();
CSS.highlights.set('comment-span', spanHighlight);
const hoveredSpan = new Highlight();
hoveredSpan.priority = 1;
CSS.highlights.set('comment-span-hovered', hoveredSpan);

/** Mark one thread's text more strongly, or none. */
export function hoverSpan(thread: string | undefined): void {
  hoveredSpan.clear();
  if (thread === undefined) return;
  for (const marks of markedSpans.values()) for (const mark of marks) if (mark.thread === thread) hoveredSpan.add(mark.range);
}

/** A range over characters `from` to `to` of a cell's text. */
function cellRange(cell: HTMLElement, from: number, to: number): Range | undefined {
  const range = document.createRange();
  let seen = 0;
  let started = false;
  const walker = document.createTreeWalker(cell, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode() as Text | null; node; node = walker.nextNode() as Text | null) {
    const length = node.data.length;
    if (!started && from <= seen + length) { range.setStart(node, from - seen); started = true; }
    if (started && to <= seen + length) { range.setEnd(node, to - seen); return range.collapsed ? undefined : range; }
    seen += length;
  }
  return undefined;
}

/** Mark the text each comment in `spans` highlights in a diff table; a span with `text` is marked only where the lines still hold that text. */
export function markSpans(table: HTMLTableElement, spans: readonly { readonly side: DiffSide; readonly start: number; readonly end: number; readonly columns: TextColumns; readonly text?: string; readonly thread?: string }[], split = prefs.layout === 'split'): void {
  for (const [other, marks] of markedSpans) {
    if (other !== table && other.isConnected) continue;
    for (const { range } of marks) { spanHighlight.delete(range); hoveredSpan.delete(range); }
    markedSpans.delete(other);
  }
  if (spans.length === 0) return;
  const marks: { range: Range; thread: string | undefined }[] = [];
  const cells = [...table.querySelectorAll<HTMLTableCellElement>('td.code')].flatMap((cell) => {
    const place = cellPlace(cell, split);
    return place ? [{ cell, ...place }] : [];
  });
  for (const span of spans) {
    const covered = cells.filter(({ side, line }) => side === span.side && line >= span.start && line <= span.end);
    const pieces = covered.map(({ cell, line }) => {
      const length = (cell.textContent ?? '').length;
      return { cell, from: line === span.start ? span.columns.start : 0, to: line === span.end ? Math.min(span.columns.end, length) : length };
    });
    // Code that changed since the comment would mark other text, so the span then shows nowhere.
    if (span.text !== undefined && pieces.map(({ cell, from, to }) => (cell.textContent ?? '').slice(from, to)).join('\n') !== span.text) continue;
    for (const { cell, from, to } of pieces) {
      const range = cellRange(cell, from, to);
      if (range) marks.push({ range, thread: span.thread });
    }
  }
  markedSpans.set(table, marks);
  for (const { range } of marks) spanHighlight.add(range);
}

/** Comment beside a text selection in a diff, which opens the comment form on exactly the selected lines. */
export function setupSelectionComment(): void {
  const comment = el('button', 'selection-comment');
  comment.id = 'selection-comment';
  setTip(comment, 'Comment on the selected text');
  comment.hidden = true;
  document.body.append(comment);
  let lines: ReturnType<typeof selectedLines>;
  const hide = (): void => { comment.hidden = true; lines = undefined; };
  // Pressing the button would otherwise clear the selection before its click.
  comment.addEventListener('mousedown', (event) => { event.preventDefault(); });
  comment.addEventListener('click', () => {
    if (!lines) return;
    const { path, side, start, end, columns } = lines;
    hide();
    window.getSelection()?.removeAllRanges();
    const draft = pick(path, side, start, false);
    draft.end = end;
    draft.columns = columns;
    save();
    renderFiles([path]);
  });
  document.addEventListener('mouseup', (event) => {
    if (comment.contains(event.target as Node)) return;
    // The selection settles after mouseup.
    setTimeout(() => {
      const selection = window.getSelection();
      lines = selectedLines(selection);
      if (!lines || !selection) { hide(); return; }
      // Just below where the selection ends, where the pointer let go; a selection ending between elements has no caret box, so its last line's box stands in.
      const range = selection.getRangeAt(0);
      const end = range.cloneRange();
      end.collapse(false);
      const caret = end.getBoundingClientRect();
      const at = caret.height > 0 ? caret : [...range.getClientRects()].at(-1) ?? range.getBoundingClientRect();
      comment.hidden = false;
      comment.style.top = Math.max(4, Math.min(window.innerHeight - comment.offsetHeight - 4, at.bottom + 4)) + 'px';
      comment.style.left = Math.max(4, Math.min(window.innerWidth - comment.offsetWidth - 4, at.right - comment.offsetWidth / 2)) + 'px';
    }, 0);
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && lines) { window.getSelection()?.removeAllRanges(); hide(); }
  });
  document.addEventListener('selectionchange', () => { if (window.getSelection()?.isCollapsed !== false) hide(); });
  document.addEventListener('scroll', hide, { capture: true, passive: true });
}
