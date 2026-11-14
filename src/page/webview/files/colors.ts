/** Syntax colors that come after the files: swapped into the drawn code cells instead of redrawing the file boxes. */
import type { DiffLine, FileDiff } from '../../../core/unifiedDiff.js';
import { $ } from '../dom.js';
import { prefs, received } from '../state.js';
import { renderFiles } from './render.js';
import { cellLines } from './selection.js';

/** Colored files waiting to be swapped in, with the lines they replace. */
const queue: { readonly file: FileDiff; readonly shown: ReadonlySet<DiffLine> }[] = [];
let scheduled = false;
/** Whether files joined the queue since it was put in screen order; sorting reads the layout, so it runs only then. */
let unsorted = false;
/** Work per frame, so swapping in a large PR's colors never blocks input for long. */
const frameBudgetMs = 12;

const lineKey = (line: DiffLine): string => line.kind + ':' + (line.oldLine ?? '') + ':' + (line.newLine ?? '');

/** Take the colored versions of shown files; the Files tab gets them over the next frames, the files on screen first. */
export function applyColors(files: readonly FileDiff[]): void {
  if (!received.files) return;
  const byPath = new Map(files.map((file) => [file.path, file]));
  const previous = new Map(received.files.map((file) => [file.path, file]));
  received.files = received.files.map((file) => byPath.get(file.path) ?? file);
  received.guide = undefined;
  if (prefs.view !== 'files') { renderFiles([...byPath.keys()]); return; }
  for (const file of files) {
    const before = previous.get(file.path);
    if (before) queue.push({ file, shown: new Set(before.hunks.flatMap((hunk) => hunk.lines)) });
  }
  unsorted = true;
  schedule();
}

/** Forget colors not yet swapped in, since new files replaced the ones they were for. */
export function dropColors(): void {
  queue.length = 0;
}

function schedule(): void {
  if (scheduled || !queue.length) return;
  scheduled = true;
  requestAnimationFrame(() => { scheduled = false; swap(); });
}

function onScreen(box: HTMLElement | undefined): boolean {
  const rect = box?.getBoundingClientRect();
  return rect !== undefined && rect.bottom > 0 && rect.top < window.innerHeight;
}

function swap(): void {
  const start = performance.now();
  // Boxes are looked up each frame, since a redraw in between replaces them.
  const boxes = new Map([...$('files').querySelectorAll<HTMLElement>('.file[data-path]')].map((box) => [box.dataset.path, box]));
  if (unsorted) {
    const first = new Set(queue.filter(({ file }) => onScreen(boxes.get(file.path))));
    queue.sort((a, b) => Number(first.has(b)) - Number(first.has(a)));
    unsorted = false;
  }
  while (queue.length && performance.now() - start < frameBudgetMs) {
    const next = queue.shift();
    const box = next && boxes.get(next.file.path);
    if (next && box) swapFile(box, next.file, next.shown);
  }
  schedule();
}

function swapFile(box: HTMLElement, file: FileDiff, shown: ReadonlySet<DiffLine>): void {
  const colored = new Map(file.hunks.flatMap((hunk) => hunk.lines.map((line) => [lineKey(line), line] as const)));
  for (const cell of box.querySelectorAll<HTMLElement>('td.code')) {
    const line = cellLines.get(cell);
    if (line === undefined || !shown.has(line)) continue;
    const next = colored.get(lineKey(line));
    if (next === undefined) continue;
    if (next.html !== line.html) cell.innerHTML = next.html;
    cellLines.set(cell, next);
  }
}
