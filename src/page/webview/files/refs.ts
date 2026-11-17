/** Claude's `path:line` references: linked only to files the page shows, they jump to the line and preview it on hover. */
import type { DiffLine, FileDiff } from '../../../core/unifiedDiff.js';
import { el } from '../dom.js';
import { setView } from '../render.js';
import { collapsed, guided, prefs, received, save } from '../state.js';
import { openFolders } from './nav.js';
import { drawPendingDiffs, renderFiles } from './render.js';
import { contextLines } from './table.js';

interface CodeRef { readonly file: FileDiff; readonly start?: number; readonly end?: number }

/** Lines around the reference the preview shows. */
const previewMargin = 3;
const previewMost = 12;

/** The shown file a reference names, by its whole path or a unique ending such as `auth/user.ts`; undefined for anything else. */
export function resolveRef(text: string): CodeRef | undefined {
  const match = /^(?:\.\/)?(.+?)(?::(\d+)(?:-(\d+))?)?$/u.exec(text);
  const path = match?.[1];
  if (path === undefined || !received.files) return undefined;
  const shown = received.files.filter((file) => file.change !== 'deleted');
  const exact = shown.find((file) => file.path === path);
  const ending = shown.filter((file) => file.path.endsWith('/' + path));
  const file = exact ?? (ending.length === 1 ? ending[0] : undefined);
  if (file === undefined) return undefined;
  const start = match?.[2] === undefined ? undefined : Number(match[2]);
  const end = match?.[3] === undefined ? start : Math.max(start ?? 0, Number(match[3]));
  return { file, ...start === undefined ? {} : { start }, ...end === undefined ? {} : { end } };
}

/** Mark the references in rendered Markdown that name a shown file, so they look like links before the pointer reaches them. */
export function linkCodeRefs(root: HTMLElement): void {
  for (const node of root.querySelectorAll<HTMLElement>('code.code-ref')) node.classList.toggle('linked', resolveRef(node.dataset.ref ?? '') !== undefined);
}

/** Show the referenced file on the Code tab, scrolled to its line when the diff draws it. */
function jumpToRef({ file, start }: CodeRef): void {
  if (prefs.view !== 'code' || guided()) setView('code', 'files');
  const box = (): HTMLElement | null => document.querySelector<HTMLElement>('#files .file[data-path="' + CSS.escape(file.path) + '"]');
  if (!box() || collapsed.get(file.path) === true) {
    collapsed.set(file.path, false);
    openFolders(file.path);
    save();
    renderFiles();
  }
  drawPendingDiffs();
  const line = start === undefined ? null : box()?.querySelector<HTMLElement>('td.code[data-line="' + start + '"]') ?? null;
  if (line === null) { box()?.scrollIntoView({ block: 'start' }); return; }
  line.scrollIntoView({ block: 'center' });
  const row = line.parentElement;
  row?.classList.remove('ref-flash');
  void row?.offsetWidth;
  row?.classList.add('ref-flash');
}

/** The new-side lines from `from` to `to` the page has: from the diff, else from the whole file once read. */
function previewLines(file: FileDiff, from: number, to: number): { readonly line: number; readonly html: string; readonly kind: DiffLine['kind'] }[] {
  const fromDiff = file.hunks.flatMap((hunk) => hunk.lines).filter((line) => line.newLine !== undefined && line.newLine >= from && line.newLine <= to && line.kind !== 'del');
  if (fromDiff.length > 0) return fromDiff.map((line) => ({ line: line.newLine ?? 0, html: line.html, kind: line.kind }));
  const whole = contextLines.get(file.path);
  if (whole === undefined) return [];
  const out = [];
  for (let line = Math.max(1, from); line <= Math.min(to, whole.length); line++) out.push({ line, html: whole[line - 1] ?? '', kind: 'context' as const });
  return out;
}

function showPreview(preview: HTMLElement, anchor: HTMLElement, ref: CodeRef): void {
  const head = el('div', 'ref-preview-head', ref.file.path + (ref.start === undefined ? '' : ':' + ref.start + (ref.end !== undefined && ref.end !== ref.start ? '-' + ref.end : '')));
  const rows: HTMLElement[] = [];
  if (ref.start !== undefined) {
    const from = ref.start - previewMargin;
    const to = Math.min((ref.end ?? ref.start) + previewMargin, from + previewMost - 1);
    const lines = previewLines(ref.file, from, to);
    const table = el('table');
    for (const { line, html, kind } of lines) {
      const row = el('tr', (kind === 'add' ? 'ref-add' : '') + (line >= ref.start && line <= (ref.end ?? ref.start) ? ' picked' : ''));
      const code = el('td', 'ref-code');
      code.innerHTML = html;
      row.append(el('td', 'ref-num', String(line)), code);
      table.append(row);
    }
    rows.push(lines.length ? table : el('div', 'muted', 'This line is outside the changes. Click to open the file.'));
  }
  preview.replaceChildren(head, ...rows);
  preview.showPopover();
  const box = anchor.getBoundingClientRect();
  const below = box.bottom + 4 + preview.offsetHeight <= window.innerHeight;
  preview.style.top = (below ? box.bottom + 4 : Math.max(8, box.top - 4 - preview.offsetHeight)) + 'px';
  preview.style.left = Math.max(8, Math.min(box.left, window.innerWidth - preview.offsetWidth - 8)) + 'px';
}

export function setupCodeRefs(): void {
  const preview = el('div', 'ref-preview');
  preview.popover = 'manual';
  document.body.append(preview);
  let shownFor: HTMLElement | undefined;
  const refAt = (target: EventTarget | null): { node: HTMLElement; ref: CodeRef } | undefined => {
    const node = target instanceof Element ? target.closest<HTMLElement>('code.code-ref') : null;
    const ref = node === null ? undefined : resolveRef(node.dataset.ref ?? '');
    node?.classList.toggle('linked', ref !== undefined);
    return node === null || ref === undefined ? undefined : { node, ref };
  };
  document.addEventListener('mouseover', (event) => {
    const found = refAt(event.target);
    if (found?.node === shownFor) return;
    shownFor = found?.node;
    if (found === undefined) { if (preview.matches(':popover-open')) preview.hidePopover(); return; }
    showPreview(preview, found.node, found.ref);
  });
  window.addEventListener('scroll', () => { shownFor = undefined; if (preview.matches(':popover-open')) preview.hidePopover(); }, { passive: true });
  document.addEventListener('click', (event) => {
    const found = refAt(event.target);
    if (found === undefined) return;
    event.preventDefault();
    shownFor = undefined;
    if (preview.matches(':popover-open')) preview.hidePopover();
    jumpToRef(found.ref);
  });
}
