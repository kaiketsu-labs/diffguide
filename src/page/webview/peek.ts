/** Definition peek: hover links and the definition panel. */
import type { DefinitionPeek, DefinitionTarget } from '../protocol.js';
import { $, closestTo, el } from './dom.js';
import { prefs, ui } from './state.js';
import { post } from './transport.js';

export const peeks: DefinitionPeek[] = [];

export function columnAt(cell: HTMLElement, event: MouseEvent): number | undefined {
  const caret = document.caretRangeFromPoint(event.clientX, event.clientY);
  if (!caret || !cell.contains(caret.startContainer)) return undefined;
  const walker = document.createTreeWalker(cell, NodeFilter.SHOW_TEXT);
  let offset = 0;
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (node === caret.startContainer) return offset + caret.startOffset;
    offset += node.textContent?.length ?? 0;
  }
  return undefined;
}

function textRange(cell: HTMLElement, start: number, end: number): Range | undefined {
  const span = document.createRange();
  const walker = document.createTreeWalker(cell, NodeFilter.SHOW_TEXT);
  let offset = 0;
  let begun = false;
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const length = node.textContent?.length ?? 0;
    if (!begun && start <= offset + length) { span.setStart(node, start - offset); begun = true; }
    if (begun && end <= offset + length) { span.setEnd(node, end - offset); return span; }
    offset += length;
  }
  return undefined;
}

function wordAt(cell: HTMLElement, column: number): { start: number; end: number } | undefined {
  const text = cell.textContent ?? '';
  const word = /[\p{L}\p{N}_$]/u;
  if (column >= text.length || !word.test(text[column] ?? '')) return undefined;
  let start = column;
  let end = column;
  while (start > 0 && word.test(text[start - 1] ?? '')) start -= 1;
  while (end < text.length && word.test(text[end] ?? '')) end += 1;
  return { start, end };
}

export function lookupTarget(cell: HTMLElement): DefinitionTarget | undefined {
  const peekId = cell.closest('#peek') ? peeks[ui.peekAt]?.id : undefined;
  const path = cell.closest<HTMLElement>('.file')?.dataset.path;
  return peekId ? { peek: peekId } : path !== undefined ? { path } : undefined;
}

export const probes = new Map<string, boolean | 'pending'>();

function setHighlight(name: string, span?: Range): void {
  if (!window.CSS?.highlights) return;
  if (span) CSS.highlights.set(name, new Highlight(span));
  else CSS.highlights.delete(name);
}

export function showLink(): void {
  document.querySelectorAll('td.code.linked').forEach((cell) => cell.classList.remove('linked'));
  if (!ui.hovered || probes.get(ui.hovered.id) !== true) { setHighlight('lr-link'); return; }
  ui.hovered.cell.classList.add('linked');
  setHighlight('lr-link', textRange(ui.hovered.cell, ui.hovered.start, ui.hovered.end));
}

export function probeAt(event: MouseEvent): void {
  clearTimeout(ui.probeTimer);
  ui.hovered = undefined;
  const cell = closestTo(event, 'td.code[data-line]');
  const target = cell ? lookupTarget(cell) : undefined;
  const column = cell ? columnAt(cell, event) : undefined;
  const word = cell && column !== undefined ? wordAt(cell, column) : undefined;
  if (!cell || !target || !word) { showLink(); return; }
  const id = JSON.stringify(['peek' in target ? target.peek : target.path, cell.dataset.line, word.start]);
  ui.hovered = { id, cell, start: word.start, end: word.end };
  showLink();
  if (probes.has(id)) return;
  ui.probeTimer = setTimeout(() => {
    probes.set(id, 'pending');
    post({ action: 'probe', id, ...target, line: Number(cell.dataset.line), column: word.start });
  }, 60);
}

export function closePeek(): void {
  peeks.length = 0;
  ui.peekAt = -1;
  renderPeek();
}

export function renderPeek(): void {
  $('peek').hidden = ui.peekAt < 0;
  setHighlight('lr-name');
  const peek = peeks[ui.peekAt];
  if (!peek) return;
  $('peek-title').textContent = peek.guessed ? peek.location + ' · same name in this file' : peek.location;
  $<HTMLButtonElement>('peek-back').disabled = ui.peekAt < 1;
  $<HTMLButtonElement>('peek-forward').disabled = ui.peekAt >= peeks.length - 1;
  const body = el('table');
  const columns = el('colgroup');
  columns.append(el('col', 'num'), el('col'));
  body.append(columns);
  let nameCell: HTMLElement | undefined;
  peek.lines.forEach((html, index) => {
    const line = peek.startLine + index;
    const row = el('tr', line >= peek.focus.start && line <= peek.focus.end ? 'focus' : '');
    const cell = el('td', 'code');
    cell.innerHTML = html;
    cell.dataset.line = String(line);
    row.append(el('td', 'num', String(line)), cell);
    body.append(row);
    if (peek.name?.line === line) nameCell = cell;
  });
  const codeBox = $('peek-code');
  codeBox.replaceChildren(body);
  if (nameCell && peek.name) setHighlight('lr-name', textRange(nameCell, peek.name.start, peek.name.end));
  const first = body.querySelector<HTMLElement>('tr.focus');
  if (first) codeBox.scrollTop = Math.max(0, first.getBoundingClientRect().top - codeBox.getBoundingClientRect().top - 3 * first.offsetHeight);
}
/** Drag the definition panel's left edge to resize it; double-click restores the default width. */
export function showPeekWidth(): void {
  if (prefs.peekWidth === undefined) document.body.style.removeProperty('--peek-width');
  else document.body.style.setProperty('--peek-width', prefs.peekWidth + 'px');
}
