/** Line selection in the diff: drag, pick and selected text. */
import type { DiffLine } from '../../../core/unifiedDiff.js';
import type { DiffSide } from '../../protocol.js';
import { el } from '../dom.js';
import { prefs, received, save, ui } from '../state.js';
import type { Composer } from '../types.js';
import { linesFit } from './filters.js';
import { renderFiles } from './render.js';
import { contextLines } from './table.js';

export function code(line: DiffLine, side: '' | 'add' | 'del'): HTMLTableCellElement {
  const cell = el('td', 'code' + (side ? ' ' + side : ''));
  cell.innerHTML = line.html;
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
