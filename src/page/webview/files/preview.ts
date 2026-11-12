/** Previews of media, PDF and HTML files. */
import type * as PdfJs from 'pdfjs-dist';
import type { FileDiff } from '../../../core/unifiedDiff.js';
import { type MediaPreview, type MediaSide, mediaType } from '../../media.js';
import type { FilePreview } from '../../protocol.js';
import { button, closestTo, el, titled } from '../dom.js';
import { frameMain } from '../frame.js';
import { loading } from '../messages.js';
import { initial, nonce, prefs, save, ui } from '../state.js';
import { composerBox } from '../threads/composer.js';
import { threadBox } from '../threads/threadBox.js';
import { post } from '../transport.js';
import type { Thread } from '../types.js';
import { renderFiles } from './render.js';
import { pick, range } from './selection.js';

type Preview = FilePreview & { readonly path: string };
interface Anchor { readonly key: string; readonly start: number; readonly end: number; readonly source: 'local' | 'github' | 'draft' }
export const previews = new Map<string, Preview>();
export const medias = new Map<string, MediaPreview>();
/** Rendered PDF pages per file side, kept so redrawing a file box does not render them again. */
const pdfViews = new Map<string, HTMLElement>();
let pdfLibrary: Promise<typeof PdfJs> | undefined;
const frameHeight = new Map<string, number>();
export const frameTops = new Map<string, Record<string, number>>();
const frameAnchors = new Map<string, Anchor[]>();
/** HTML files whose preview runs the file's own scripts, until the page reloads. */
const scriptedFrames = new Set<string>();

export function previewKind(file: FileDiff): 'markdown' | 'html' | 'media' | undefined {
  if (mediaType(file.path) !== undefined) return 'media';
  if (file.binary || file.change === 'deleted') return undefined;
  return /\.(md|markdown)$/iu.test(file.path) ? 'markdown' : /\.html?$/iu.test(file.path) ? 'html' : undefined;
}

/** Images and PDFs have no readable diff, so they always show as a preview; SVG keeps its Diff and Preview switch. */
export function previewOnly(file: FileDiff): boolean {
  return previewKind(file) === 'media' && (file.binary || mediaType(file.path) === 'application/pdf');
}

function loadMedia(file: FileDiff): void {
  const key = 'media:' + file.path;
  if (!medias.has(file.path) && !loading.has(key)) {
    loading.add(key);
    post({ action: 'media', path: file.path });
  }
}

/** The file before and after the PR, side by side: images as pictures, PDFs as pages. */
export function mediaNode(file: FileDiff): HTMLElement {
  const data = medias.get(file.path);
  if (!data) { loadMedia(file); return el('div', 'note muted', 'Loading preview…'); }
  const wrap = el('div', 'media');
  for (const [label, side] of [['Before', data.old], ['After', data.new]] as const) {
    if (!side) continue;
    const pane = el('figure', 'media-side');
    const caption = el('figcaption', 'muted', label);
    pane.append(caption);
    if ('tooBig' in side) pane.append(el('div', 'note muted', 'Too large to preview.'));
    else if (side.mime === 'application/pdf') pane.append(pdfView(file.path + '\0' + label, side));
    else {
      const image = el('img');
      image.alt = label + ': ' + file.path;
      image.addEventListener('load', () => { caption.textContent = label + ' · ' + image.naturalWidth + ' × ' + image.naturalHeight; }, { once: true });
      image.src = 'data:' + side.mime + ';base64,' + side.data;
      pane.append(image);
    }
    wrap.append(pane);
  }
  return wrap;
}

/** Load pdf.js once, on the first PDF the page shows. */
function loadPdfLibrary(): Promise<typeof PdfJs> {
  const source = initial.pdfScript;
  if (!source) return Promise.reject(new Error('PDF preview is not available here.'));
  pdfLibrary ??= new Promise((resolve, reject) => {
    const tag = el('script');
    tag.nonce = nonce;
    tag.src = source;
    tag.addEventListener('load', () => { resolve((window as unknown as { pdfjsLib: typeof PdfJs }).pdfjsLib); });
    tag.addEventListener('error', () => { reject(new Error('Could not load the PDF viewer.')); });
    document.head.append(tag);
  });
  return pdfLibrary;
}

/** Pages shown per PDF; longer files say how many more there are. */
const maxPdfPages = 10;

function pdfView(key: string, side: Extract<MediaSide, { data: string }>): HTMLElement {
  const known = pdfViews.get(key);
  if (known) return known;
  const pages = el('div', 'pdf-pages');
  pages.dataset.scrollKey = key;
  pages.append(el('div', 'note muted', 'Rendering PDF…'));
  pdfViews.set(key, pages);
  void (async () => {
    const library = await loadPdfLibrary();
    const bytes = Uint8Array.from(atob(side.data), (char) => char.charCodeAt(0));
    const pdf = await library.getDocument({ data: bytes }).promise;
    const shown: HTMLElement[] = [];
    for (let number = 1; number <= Math.min(pdf.numPages, maxPdfPages); number += 1) {
      const page = await pdf.getPage(number);
      const viewport = page.getViewport({ scale: 1.5 });
      const canvas = el('canvas');
      canvas.width = viewport.width;
      canvas.height = viewport.height;
      await page.render({ canvas, viewport }).promise;
      shown.push(canvas);
    }
    if (pdf.numPages > maxPdfPages) shown.push(el('div', 'note muted', (pdf.numPages - maxPdfPages) + ' more pages. Open the file to see them.'));
    pages.replaceChildren(...shown);
  })().catch((error: unknown) => {
    pages.replaceChildren(el('div', 'note bad', 'Could not show this PDF: ' + (error instanceof Error ? error.message : String(error))));
  });
  return pages;
}

function loadPreview(file: FileDiff): void {
  const key = 'preview:' + file.path;
  if (!previews.has(file.path) && !loading.has(key)) {
    loading.add(key);
    post({ action: 'preview', path: file.path });
  }
}

export function previewNode(file: FileDiff, threads: readonly Thread[], placed: Set<string>): HTMLElement {
  const data = previews.get(file.path);
  if (!data) { loadPreview(file); return el('div', 'note muted', 'Loading preview…'); }
  const draft = prefs.composer?.path === file.path && prefs.composer.side === 'new' ? prefs.composer : undefined;
  if (data.kind === 'html') {
    const wrap = el('div', 'preview');
    const frame = el('iframe', 'html-preview');
    frame.setAttribute('sandbox', 'allow-scripts');
    frame.title = 'Preview of ' + file.path;
    frame.dataset.path = file.path;
    const scripted = data.scripted !== undefined && scriptedFrames.has(file.path);
    const frameScript = '<script nonce="' + nonce + '">(' + frameMain.toString() + ')(' + String(scripted) + ');</' + 'script>';
    frame.srcdoc = scripted && data.scripted !== undefined
      ? data.scripted.replace('<!--' + data.marker + '-->', frameScript).replaceAll(data.marker, nonce)
      : data.html.replace('<!--' + data.marker + '-->', frameScript);
    frame.style.height = (frameHeight.get(file.path) ?? 600) + 'px';
    const margin = el('div', 'html-margin');
    margin.dataset.path = file.path;
    const anchors: Anchor[] = [];
    const attach = (card: HTMLElement, anchor: Anchor): void => {
      card.dataset.anchor = anchor.key;
      anchors.push(anchor);
      margin.append(card);
      card.addEventListener('mouseenter', () => frame.contentWindow?.postMessage({ focus: anchor.key }, '*'));
      card.addEventListener('mouseleave', () => frame.contentWindow?.postMessage({ focus: null }, '*'));
    };
    for (const thread of threads) {
      if (placed.has(thread.id) || thread.outdated || thread.side !== 'new') continue;
      placed.add(thread.id);
      attach(threadBox(thread), { key: thread.id, start: thread.startLine, end: thread.endLine, source: thread.source });
    }
    if (draft) attach(composerBox(draft), { key: 'composer', start: draft.start, end: draft.end, source: 'draft' });
    frameAnchors.set(file.path, anchors);
    const split = el('div', 'html-split');
    split.dataset.scrollKey = file.path;
    split.append(frame, margin);
    const note = el('div', 'row note muted preview-note');
    note.append(el('span', '', scripted
      ? 'Scripts are running. The page\'s buttons and links work, click anything else to comment. Comments on drawn content attach to its nearest source element.'
      : 'Click an element to comment on its source lines, Shift-click to extend. ' + (data.scripted === undefined ? '' : 'Scripts in the file are off. ') + 'Linked stylesheets and relative images do not load.'));
    if (data.scripted !== undefined) {
      note.append(titled(button(scripted ? 'Stop scripts' : 'Run scripts', () => {
        if (scripted) scriptedFrames.delete(file.path);
        else scriptedFrames.add(file.path);
        renderFiles([file.path]);
      }, 'small'), scripted ? 'Show the file without its scripts' : 'Run the file\'s scripts in the sandboxed preview. They can load code from the internet.'));
    }
    wrap.append(note, split);
    return wrap;
  }
  const wrap = el('div', 'preview md');
  for (const block of data.blocks) {
    const node = el('div', 'md-block');
    node.innerHTML = block.html;
    node.title = range(block.startLine, block.endLine) + '. Click to comment, Shift-click to extend.';
    if (draft && draft.start <= block.endLine && draft.end >= block.startLine) node.classList.add('sel');
    node.addEventListener('click', (event) => {
      if (closestTo(event, 'a')) return;
      if (event.shiftKey && draft) {
        draft.start = Math.min(draft.start, block.startLine);
        draft.end = Math.max(draft.end, block.endLine);
        ui.focusNext = 'composer';
      } else pick(file.path, 'new', block.startLine, false).end = block.endLine;
      save();
      renderFiles([file.path]);
    });
    wrap.append(node);
    for (const thread of threads) {
      if (placed.has(thread.id) || thread.outdated || thread.side !== 'new' || block.startLine > thread.endLine || thread.endLine > block.endLine) continue;
      placed.add(thread.id);
      wrap.append(threadBox(thread));
    }
    if (draft && block.startLine <= draft.end && draft.end <= block.endLine) wrap.append(composerBox(draft));
  }
  return wrap;
}

/** Messages from an HTML preview frame; the frame runs the previewed file, so nothing it sends is trusted. */
export function frameMessage(frame: HTMLIFrameElement, raw: unknown): void {
  if (typeof raw !== 'object' || raw === null) return;
  const path = frame.dataset.path ?? '';
  const data = raw as { lrReady?: unknown; lrHeight?: unknown; lrAnchors?: unknown; lrPick?: { start?: unknown; end?: unknown; extend?: unknown; top?: unknown } };
  const { start, end, extend, top } = typeof data.lrPick === 'object' && data.lrPick !== null ? data.lrPick : {};
  const draft = prefs.composer?.path === path && prefs.composer.side === 'new' ? prefs.composer : undefined;
  if (data.lrReady) {
    const anchors = (frameAnchors.get(path) ?? []).map(({ key, start: from, end: to, source }) => ({ key, start: from, end: to, source }));
    frame.contentWindow?.postMessage({ anchors, select: draft ? [draft.start, draft.end] : null }, '*');
  } else if (typeof data.lrHeight === 'number' && Number.isFinite(data.lrHeight)) {
    const height = Math.min(Math.max(data.lrHeight, 100), 20000);
    frameHeight.set(path, height);
    frame.style.height = height + 'px';
    if (data.lrAnchors && typeof data.lrAnchors === 'object') {
      const tops = data.lrAnchors as Record<string, number>;
      frameTops.set(path, tops);
      layoutMargin(frame, tops);
    }
  } else if (typeof start === 'number' && typeof end === 'number' && Number.isSafeInteger(start) && Number.isSafeInteger(end) && start > 0 && start <= end) {
    const tops = { ...frameTops.get(path) };
    if (typeof top === 'number' && Number.isFinite(top)) {
      const previous = tops['composer'];
      tops['composer'] = extend && previous !== undefined && Number.isFinite(previous) ? Math.min(previous, top) : top;
    }
    frameTops.set(path, tops);
    if (extend && draft) {
      draft.start = Math.min(draft.start, start);
      draft.end = Math.max(draft.end, end);
      ui.focusNext = 'composer';
    } else pick(path, 'new', start, false).end = end;
    save();
    renderFiles([path]);
  }
}

/** Line each margin card up with its element, pushing cards down so they never overlap. */
export function layoutMargin(frame: HTMLIFrameElement, tops: Record<string, number>): void {
  const margin = frame.nextElementSibling;
  if (!(margin instanceof HTMLElement) || !margin.classList.contains('html-margin')) return;
  const wanted = (card: HTMLElement): number | undefined => {
    const top = tops[card.dataset.anchor ?? ''];
    return top !== undefined && Number.isFinite(top) ? top : undefined;
  };
  const cards = ([...margin.children] as HTMLElement[]).sort((a, b) => (wanted(a) ?? Infinity) - (wanted(b) ?? Infinity));
  let next = 0;
  for (const card of cards) {
    const top = Math.max(wanted(card) ?? next, next);
    card.style.top = top + 'px';
    next = top + card.offsetHeight + 8;
  }
  margin.style.minHeight = next + 'px';
}
