/** Line selection in the diff: drag, pick and selected text. */
import type { DiffLine } from '../../../core/unifiedDiff.js';
import type { DiffSide } from '../../protocol.js';
import { el } from '../dom.js';
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
  } else {
    prefs.composer = { path, side, start: line, end: line, text: prefs.composer?.text ?? '', target: prefs.composer?.target ?? 'claude' };
  }
  ui.focusNext = 'composer';
  save();
  renderFiles([before, path]);
  return prefs.composer;
}

export function range(start: number, end: number): string {
  return start === end ? 'Line ' + start : 'Lines ' + start + '–' + end;
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

/** The lines a text selection in one diff covers, on one side, or undefined when it spans files, sides or lines that take no comment. */
export function selectedLines(selection: Selection | null, split = prefs.layout === 'split'): { path: string; side: DiffSide; start: number; end: number } | undefined {
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
  const place = (cell: HTMLTableCellElement | null): { path: string; side: DiffSide; line: number } | undefined => {
    const line = cell ? cellLines.get(cell) : undefined;
    const path = cell?.closest<HTMLElement>('[data-path]')?.dataset.path;
    if (!cell || !line || path === undefined) return undefined;
    const side: DiffSide = split ? (cell.cellIndex <= 1 ? 'old' : 'new') : line.kind === 'del' ? 'old' : 'new';
    const number = side === 'old' ? line.oldLine : line.newLine;
    return number === undefined || !linesFit(side) ? undefined : { path, side, line: number };
  };
  const from = place(first);
  const to = place(last);
  if (!from || !to || from.path !== to.path || from.side !== to.side) return undefined;
  return { path: from.path, side: from.side, start: Math.min(from.line, to.line), end: Math.max(from.line, to.line) };
}

/** Comment beside a text selection in a diff, which opens the comment form on exactly the selected lines. */
export function setupSelectionComment(): void {
  const comment = el('button', 'small selection-comment');
  comment.id = 'selection-comment';
  comment.textContent = 'Comment';
  comment.hidden = true;
  document.body.append(comment);
  let lines: ReturnType<typeof selectedLines>;
  const hide = (): void => { comment.hidden = true; lines = undefined; };
  // Pressing the button would otherwise clear the selection before its click.
  comment.addEventListener('mousedown', (event) => { event.preventDefault(); });
  comment.addEventListener('click', () => {
    if (!lines) return;
    const { path, side, start, end } = lines;
    hide();
    window.getSelection()?.removeAllRanges();
    pick(path, side, start, false).end = end;
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
  document.addEventListener('selectionchange', () => { if (window.getSelection()?.isCollapsed !== false) hide(); });
  document.addEventListener('scroll', hide, { capture: true, passive: true });
}
