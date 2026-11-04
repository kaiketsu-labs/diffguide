import type { DefinitionPeek } from '../definitions.js';
import { buildGuide, stepViewed as isStepViewed, type GuideGroup, type GuideStep, type Severity } from '../prAnalysis.js';
import type { DefinitionTarget, DiffSide, ExtensionMessage, FilePreview, GitHubThreadView, OverviewState, PageMessage } from '../pullRequestOverview.js';
import type { MergeMethod, PullRequestDetails, ReviewEvent } from '../pullRequests.js';
import { fileTree, type FileFolder } from '../fileTree.js';
import { fullyRead, rangeReadIds, readLines, type MarkedRange } from '../readLines.js';
import type { LineRange } from '../reviewedFiles.js';
import type { DiffHunk, DiffLine, FileDiff } from '../unifiedDiff.js';
import { codicons } from '../codicons.js';
import { mediaType, type MediaPreview, type MediaSide } from '../media.js';
import type * as PdfJs from 'pdfjs-dist';

declare function acquireVsCodeApi(): { postMessage(message: PageMessage): void; getState(): unknown; setState(state: Saved): void };

type Layout = 'unified' | 'split';
/** What the file list shows: every file, or Claude's guide in reading order. */
type View = 'files' | 'guide';
type Intent = 'ask' | 'implement';
interface Composer { path: string; side: DiffSide; start: number; end: number; text: string; target?: 'claude' | 'github' }
interface Saved {
  /** 'guided' is how pages saved before Files and Guide became tabs remember the guide. */
  readonly layout?: Layout | 'guided';
  readonly view?: View;
  /** Width of the definition panel in pixels, when the user resized it. */
  readonly peekWidth?: number | undefined;
  readonly folders?: boolean;
  readonly collapsed?: Record<string, boolean>;
  readonly previewing?: readonly string[];
  readonly composer?: Composer | undefined;
  readonly replies?: Record<string, string>;
}
type Thread = (OverviewState['threads'][number] & { readonly source: 'local'; readonly pending?: never; readonly outdated?: never })
  | (GitHubThreadView & { readonly source: 'github' });
type Message = Thread['messages'][number];
type Preview = FilePreview & { readonly path: string };
interface Anchor { readonly key: string; readonly start: number; readonly end: number; readonly source: 'local' | 'github' | 'draft' }
/** Unchanged new-side lines between hunks; `offset` maps them to old-side lines. */
interface Gap { readonly from: number; readonly to: number; readonly offset: number; readonly last?: true }
interface Shown { readonly top: number; readonly bottom: number }
type Row = readonly (DiffLine | undefined)[];
type ReviewerState = PullRequestDetails['reviewers'][number]['state'];
type CheckState = PullRequestDetails['checks'][number]['state'];

const api = acquireVsCodeApi();
const post = (message: PageMessage): void => api.postMessage(message);
const $ = <T extends HTMLElement = HTMLElement>(id: string): T => document.getElementById(id) as T;
const initial = JSON.parse($('initial').textContent ?? '') as { readonly state: OverviewState; readonly claudeIcon: string; readonly pdfScript?: string };
const { claudeIcon } = initial;
const saved = (api.getState() ?? {}) as Saved;
const nonce = document.currentScript?.nonce ?? '';
let layout: Layout = saved.layout === 'split' ? 'split' : 'unified';
let view: View = saved.view ?? (saved.layout === 'guided' ? 'guide' : 'files');
let peekWidth = saved.peekWidth;
let folders = saved.folders === true;
const collapsed = new Map(Object.entries(saved.collapsed ?? {}));
const previewing = new Set(saved.previewing ?? []);
const previews = new Map<string, Preview>();
const medias = new Map<string, MediaPreview>();
/** Rendered PDF pages per file side, kept so redrawing a file box does not render them again. */
const pdfViews = new Map<string, HTMLElement>();
let pdfLibrary: Promise<typeof PdfJs> | undefined;
const frameHeight = new Map<string, number>();
const frameTops = new Map<string, Record<string, number>>();
const frameAnchors = new Map<string, Anchor[]>();
let files: readonly FileDiff[] | undefined;
let viewed = new Set<string>();
let current: OverviewState | undefined;
let readRanges: readonly MarkedRange[] = [];
const openReads = new Set<string>();
const fileKeys = new Map<string, string>();
let composer = saved.composer;
const replies = new Map(Object.entries(saved.replies ?? {}));
const sending = new Set<string>();
const threadOpen = new Map<string, boolean>();
let focusNext: string | undefined;
let sentPending = true;
const contextLines = new Map<string, readonly string[]>();
const expanded = new Map<string, Map<number, Shown>>();
const loading = new Set<string>();
const step = 20;
const peeks: DefinitionPeek[] = [];
let peekAt = -1;
let drag: { path: string; side: DiffSide; from: number; to: number } | undefined;
let busy = false;
let author = true;
/** The description is open for editing, so redraws leave it alone. */
let editingBody = false;
const reviewButtons = [...document.querySelectorAll<HTMLButtonElement>('[data-event]')];
const labels: Record<ReviewerState | CheckState, readonly [string, string, string]> = {
  approved: ['✓', 'ok', 'Approved'], changes: ['✗', 'bad', 'Requested changes'], commented: ['●', 'muted', 'Commented'],
  dismissed: ['○', 'muted', 'Dismissed'], requested: ['○', 'wait', 'Review requested'],
  success: ['✓', 'ok', 'Passed'], failure: ['✗', 'bad', 'Failed'], pending: ['●', 'wait', 'Running'], neutral: ['○', 'muted', 'Skipped'],
};
const methodLabels: Record<MergeMethod, string> = { squash: 'Squash and merge', merge: 'Create a merge commit', rebase: 'Rebase and merge' };
const changeLetters: Record<FileDiff['change'], string> = { added: 'A', modified: 'M', deleted: 'D', renamed: 'R' };
const severityLabels: Record<Severity | 'unclassified', string> = { critical: 'Critical', significant: 'Significant', routine: 'Routine', trivial: 'Trivial', unclassified: 'Unclassified' };
let guide: GuideGroup[] | undefined;
let guideStamp = '';
const stepKeys = new Map<string, string>();
const verdictText = { changes: ['bad', 'Changes requested by '], approved: ['ok', 'Approved by '], commented: ['muted', 'Commented: '] } as const;

/**
 * Runs inside the HTML preview frame: reports clicks as source lines, and where commented elements sit.
 * The page injects its source text, so it must not use anything from outside its own body.
 */
function frameMain(): void {
  interface FrameAnchor { readonly key: string; readonly start: number; readonly end: number; readonly source: string; node?: Element }
  const lines = (node: Element): [number, number] => {
    const [start = Number.NaN, end = Number.NaN] = ((node as HTMLElement).dataset.lrLines ?? '').split('-').map(Number);
    return [start, end];
  };
  const target = (event: Event): Element | null => (event.target instanceof Element ? event.target.closest('[data-lr-lines]') : null);
  const style = document.createElement('style');
  style.textContent = '[data-lr-hover]{outline:2px dashed #0078d4!important;outline-offset:1px;cursor:pointer!important}'
    + '[data-lr-sel]{outline:2px solid #0078d4!important;outline-offset:1px;background-color:rgba(0,120,215,.12)!important}'
    + '[data-lr-anchor=local]{outline:2px solid rgba(209,134,22,.75)!important;outline-offset:1px}[data-lr-anchor=github]{outline:2px solid rgba(55,148,255,.75)!important;outline-offset:1px}'
    + '[data-lr-focus]{outline-width:3px!important;background-color:rgba(128,128,128,.15)!important}';
  document.head.append(style);
  let hover: Element | null = null;
  let anchors: FrameAnchor[] = [];
  let pending = false;
  const closest = (anchor: FrameAnchor): Element | undefined => {
    let exact: Element | undefined;
    let inner: Element | undefined;
    let size = Infinity;
    let after: Element | undefined;
    let afterStart = Infinity;
    for (const node of document.querySelectorAll('[data-lr-lines]')) {
      const [start, end] = lines(node);
      if (!exact && start === anchor.start && end === anchor.end) exact = node;
      if (start <= anchor.end && anchor.end <= end && end - start <= size) { inner = node; size = end - start; }
      if (start >= anchor.end && start < afterStart) { after = node; afterStart = start; }
    }
    return exact ?? inner ?? after;
  };
  const report = (): void => {
    pending = false;
    const tops: Record<string, number> = {};
    for (const node of document.querySelectorAll('[data-lr-anchor]')) node.removeAttribute('data-lr-anchor');
    for (const anchor of anchors) {
      const node = closest(anchor);
      if (!node) continue;
      anchor.node = node;
      if (anchor.source !== 'draft') node.setAttribute('data-lr-anchor', anchor.source);
      tops[anchor.key] = node.getBoundingClientRect().top + scrollY;
    }
    parent.postMessage({ lrHeight: document.documentElement.scrollHeight, lrAnchors: tops }, '*');
  };
  const schedule = (): void => { if (!pending) { pending = true; setTimeout(report, 30); } };
  new ResizeObserver(schedule).observe(document.documentElement);
  addEventListener('load', schedule);
  addEventListener('mouseover', (event) => {
    const at = target(event);
    hover?.removeAttribute('data-lr-hover');
    hover = at;
    at?.setAttribute('data-lr-hover', '');
  });
  addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    const at = target(event);
    if (!at) return;
    const [start, end] = lines(at);
    parent.postMessage({ lrPick: { start, end, extend: event.shiftKey, top: at.getBoundingClientRect().top + scrollY } }, '*');
  }, true);
  addEventListener('submit', (event) => event.preventDefault(), true);
  addEventListener('message', (event) => {
    if (event.source !== parent) return;
    const data = (event.data ?? {}) as { anchors?: unknown; focus?: unknown; select?: unknown };
    if (Array.isArray(data.anchors)) { anchors = data.anchors as FrameAnchor[]; schedule(); }
    if ('focus' in data) {
      for (const node of document.querySelectorAll('[data-lr-focus]')) node.removeAttribute('data-lr-focus');
      anchors.find((item) => item.key === data.focus)?.node?.setAttribute('data-lr-focus', '');
    }
    if (Array.isArray(data.select)) {
      const [from, to] = data.select as number[];
      for (const node of document.querySelectorAll('[data-lr-lines]')) {
        const [start, end] = lines(node);
        if (from !== undefined && to !== undefined && start >= from && end <= to && !node.parentElement?.closest('[data-lr-sel]')) node.setAttribute('data-lr-sel', '');
      }
    }
  });
  parent.postMessage({ lrReady: true }, '*');
}

function save(): void {
  api.setState({ layout, view, peekWidth, folders, collapsed: Object.fromEntries(collapsed), previewing: [...previewing], composer, replies: Object.fromEntries(replies) });
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function button(label: string, onClick: () => void, className?: string): HTMLButtonElement {
  const node = el('button', className ?? '', label);
  node.addEventListener('click', onClick);
  return node;
}

function icon(svg: string): Element {
  const template = document.createElement('template');
  template.innerHTML = svg;
  return template.content.firstElementChild as Element;
}

/** A branch name that copies itself, like GitHub's. */
function branchRef(name: string): HTMLButtonElement {
  const ref = el('button', 'ref');
  ref.title = 'Copy branch name';
  const copy = icon(codicons.copy);
  copy.classList.add('copy');
  const done = icon(codicons.check);
  done.classList.add('done');
  ref.append(name, copy, done);
  ref.addEventListener('click', () => {
    void navigator.clipboard.writeText(name).then(() => {
      ref.classList.add('copied');
      setTimeout(() => ref.classList.remove('copied'), 1500);
    }, () => { $('error').textContent = 'Could not copy the branch name.'; });
  });
  return ref;
}

function closestTo<T extends Element = HTMLElement>(event: Event, selector: string): T | null {
  return event.target instanceof Element ? event.target.closest<T>(selector) : null;
}

function status(key: ReviewerState | CheckState, name: string, url?: string): HTMLLIElement {
  const item = el('li', 'row');
  const [icon, tone, label] = labels[key];
  const mark = el('span', tone, icon);
  mark.title = label;
  item.append(mark);
  if (url) {
    const link = el('a', '', name);
    link.href = url;
    item.append(link);
  } else item.append(el('span', '', name));
  item.append(el('span', 'muted', label));
  return item;
}

function setBusy(value: boolean): void {
  busy = value;
  for (const review of reviewButtons) review.disabled = value || (author && review.hasAttribute('data-reviewer'));
  $<HTMLButtonElement>('merge').disabled = value || current?.details?.mergeable === 'no';
  for (const action of document.querySelectorAll<HTMLButtonElement>('[data-pr-action]')) action.disabled = value;
}

/** Send a change to the PR on GitHub; the page stays busy until the extension answers. */
function changePullRequest(message: PageMessage): void {
  $('error').textContent = '';
  setBusy(true);
  post(message);
}

function editBody(): void {
  const details = current?.details;
  if (!details) return;
  editingBody = true;
  const area = el('textarea');
  area.value = details.body;
  area.setAttribute('aria-label', 'Description');
  const cancel = button('Cancel', () => { editingBody = false; if (current) render(current); }, 'quiet');
  const save = button('Save', () => changePullRequest({ action: 'edit-body', body: area.value }), 'primary');
  save.dataset.prAction = '';
  const row = el('div', 'row actions review-actions');
  row.append(cancel, save);
  $('body').replaceChildren(area, row);
  $('edit-body').hidden = true;
  area.focus();
}

/** The merge box: merge controls while open, then the PR's state and what you can still do with it. */
function renderState(details: PullRequestDetails): void {
  const draft = details.open && details.draft;
  $('merge-title').textContent = details.merged ? 'Merged' : !details.open ? 'Closed' : draft ? 'Draft' : 'Merge';
  $('merge-row').hidden = !details.open || draft || !details.mergeMethods.length;
  $('mergeable').textContent = draft ? 'Mark it ready for review before merging.'
    : !details.open ? (details.merged ? '' : 'Closed without merging.')
    : details.mergeable === 'no' ? 'Has conflicts with the base branch.' : details.mergeable === 'unknown' ? 'GitHub is still checking for conflicts.' : '';
  const conflicted = details.open && details.mergeable === 'no' && details.canEdit;
  const question = conflicted && current?.claude.running !== true ? current?.conflictQuestion : undefined;
  $('conflict-row').hidden = !conflicted || question !== undefined;
  $('conflict-ask').hidden = question === undefined;
  const reply = $('conflict-reply');
  if (question !== undefined && reply.dataset.html !== question) {
    reply.dataset.html = question;
    reply.innerHTML = question;
  }
  $<HTMLButtonElement>('fix-conflicts').disabled = current?.claude.running === true;
  const fixing = current?.claude.fixingConflicts;
  const note = $('conflict-note');
  note.className = fixing === undefined ? 'muted' : 'chip claude working';
  const text = fixing ?? 'Claude merges the base branch, resolves the conflicts and pushes.';
  note.replaceChildren(fixing === undefined ? text : el('span', '', text));
  note.title = fixing ?? '';
  const actions: HTMLButtonElement[] = [];
  const add = (label: string, message: PageMessage, className = 'quiet'): void => {
    const node = button(label, () => changePullRequest(message), className);
    node.dataset.prAction = '';
    actions.push(node);
  };
  if (details.canEdit && details.open && !draft) add('Convert to draft', { action: 'draft', draft: true });
  if (details.canEdit && details.open) add('Close pull request', { action: 'close' });
  if (details.canEdit && draft) add('Ready for review', { action: 'draft', draft: false }, 'primary');
  if (details.canEdit && !details.open && !details.merged) add('Reopen', { action: 'reopen' });
  if (details.merged && details.branchDeletable) add('Delete branch', { action: 'delete-branch' }, '');
  $('state-actions').replaceChildren(...actions);
}

function verdict(reviewers: PullRequestDetails['reviewers']): readonly [string, string] {
  for (const key of ['changes', 'approved', 'commented'] as const) {
    const names = reviewers.filter((reviewer) => reviewer.state === key).map((reviewer) => reviewer.name);
    if (names.length) return [verdictText[key][0], verdictText[key][1] + names.join(', ')];
  }
  const waiting = reviewers.filter((reviewer) => reviewer.state === 'requested').map((reviewer) => reviewer.name);
  return waiting.length ? ['wait', 'Waiting for ' + waiting.join(', ')] : ['muted', 'No reviews yet'];
}

function allThreads(): Thread[] {
  if (!current) return [];
  return [...current.threads.map((thread) => ({ ...thread, source: 'local' as const })), ...(current.github ?? []).map((thread) => ({ ...thread, source: 'github' as const }))];
}

function render(state: OverviewState): void {
  current = state;
  $('title').textContent = state.title;
  $('byline').replaceChildren(state.author + ' wants to merge', branchRef(state.headBranch), 'into', branchRef(state.baseBranch));
  $('facts').replaceChildren(...pullRequestFacts(state));
  const { details } = state;
  const body = $('body');
  if (!details) body.replaceChildren(el('span', 'muted', state.detailsError ? 'Could not load from GitHub: ' + state.detailsError : 'Loading from GitHub…'));
  else if (!editingBody && details.bodyHtml.trim()) body.innerHTML = details.bodyHtml;
  else if (!editingBody) body.replaceChildren(el('span', 'muted', 'No description.'));
  const reviewers = $('reviewers');
  reviewers.replaceChildren();
  if (details) {
    for (const reviewer of details.reviewers) reviewers.append(status(reviewer.state, reviewer.name));
    if (!details.reviewers.length) reviewers.append(el('li', 'muted', 'No reviewers yet.'));
  }
  const checks = $('checks');
  checks.replaceChildren();
  if (details) {
    for (const check of details.checks) checks.append(status(check.state, check.name, check.url));
    if (!details.checks.length) checks.append(el('li', 'muted', 'No checks.'));
  }
  for (const id of ['edit-title', 'pick-reviewers', 'pick-assignees', 'pick-labels']) $(id).hidden = !details?.canEdit;
  $('edit-body').hidden = !details?.canEdit || editingBody;
  $('assignees').replaceChildren(...details?.assignees.length ? details.assignees.map((name) => el('li', '', name)) : details ? [el('li', 'muted', 'Nobody assigned.')] : []);
  $('labels').replaceChildren(...details?.labels.length ? details.labels.map((label) => {
    const chip = el('span', 'label', label.name);
    chip.style.setProperty('--label', '#' + label.color);
    return chip;
  }) : details ? [el('span', 'muted', 'No labels.')] : []);
  const reviewed = $('reviewed');
  reviewed.replaceChildren();
  if (state.reviewed) {
    const wrap = el('div', 'bar');
    const fill = el('span');
    fill.style.width = (state.reviewed.total ? 100 * state.reviewed.done / state.reviewed.total : 0) + '%';
    wrap.append(fill);
    reviewed.append(wrap, el('span', '', state.reviewed.done + '/' + state.reviewed.total + ' viewed'));
  }
  const claude = $('claude');
  claude.textContent = state.claude.text;
  claude.className = state.claude.running ? 'chip claude working' : 'chip';
  $('retry').hidden = !state.claude.retry;
  renderThreadList();
  author = !details || details.viewerIsAuthor;
  setBusy(busy);
  for (const review of document.querySelectorAll<HTMLButtonElement>('[data-reviewer]')) review.hidden = author;
  document.querySelector<HTMLButtonElement>('[data-event="comment"]')?.classList.toggle('primary', author);
  $('review-note').textContent = author ? 'This is your PR, so you can only comment.' : '';
  const pendingCount = details?.pendingComments;
  $('pending-note').textContent = pendingCount !== undefined
    ? 'Your pending review has ' + pendingCount + ' comment' + (pendingCount === 1 ? '' : 's') + '. Only you see ' + (pendingCount === 1 ? 'it' : 'them') + ' until you submit.'
    : '';
  const badge = $('verdict');
  badge.hidden = !details;
  if (details) {
    const [tone, label] = verdict(details.reviewers);
    badge.className = 'verdict ' + tone;
    badge.textContent = label;
  }
  $('review-box').hidden = !details?.open;
  $('merge-box').hidden = !details;
  if (details) {
    renderState(details);
    const select = $<HTMLSelectElement>('method');
    const chosen = select.value;
    select.replaceChildren(...details.mergeMethods.map((method) => {
      const option = el('option', '', methodLabels[method]);
      option.value = method;
      return option;
    }));
    if (details.mergeMethods.some((method) => method === chosen)) select.value = chosen;
  }
  const next = new Set(state.viewed);
  for (const path of next) if (!viewed.has(path)) collapsed.set(path, true);
  for (const path of viewed) if (!next.has(path)) collapsed.set(path, false);
  viewed = next;
  save();
  readRanges = state.read;
  const { analysis } = state;
  const analyze = $<HTMLButtonElement>('analyze');
  analyze.textContent = analysis.running ? 'Stop' : analysis.result ? 'Rebuild guide' : 'Build guide';
  const analysisStatus = $('analysis-status');
  analysisStatus.textContent = analysis.running ? 'Guide · ' + (analysis.step ?? 'Working') : analysis.error ? 'Guide failed' : '';
  analysisStatus.title = analysis.error ?? '';
  analysisStatus.className = analysis.running ? 'chip claude working' : analysis.error ? 'chip bad' : '';
  analysisStatus.hidden = !analysis.running && !analysis.error;
  const stamp = JSON.stringify([analysis.result?.createdAt, analysis.stale, analysis.result ? null : [analysis.running, analysis.error]]);
  if (stamp !== guideStamp) {
    guideStamp = stamp;
    guide = undefined;
    if (view === 'guide') { renderFiles(); return; }
  }
  renderFiles('state');
}

function code(line: DiffLine, side: '' | 'add' | 'del'): HTMLTableCellElement {
  const cell = el('td', 'code' + (side ? ' ' + side : ''));
  cell.innerHTML = line.html;
  if (line.kind !== 'del' && line.newLine !== undefined) cell.dataset.line = String(line.newLine);
  return cell;
}

function num(value: number | undefined, path: string, side: DiffSide): HTMLTableCellElement {
  const cell = el('td', 'num', value === undefined ? '' : String(value));
  if (value !== undefined) {
    cell.classList.add('pick');
    cell.dataset.path = path;
    cell.dataset.side = side;
    cell.title = 'Comment on this line. Drag or Shift-click to select a range.';
    cell.addEventListener('mousedown', (event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      drag = { path, side, from: value, to: value };
      paintDrag();
    });
    cell.addEventListener('mouseenter', () => {
      if (drag && drag.path === path && drag.side === side && drag.to !== value) { drag.to = value; paintDrag(); }
    });
  }
  return cell;
}

function paintDrag(): void {
  for (const cell of document.querySelectorAll('.drag-sel')) cell.classList.remove('drag-sel');
  if (!drag) return;
  const low = Math.min(drag.from, drag.to);
  const high = Math.max(drag.from, drag.to);
  for (const cell of document.querySelectorAll<HTMLElement>('td.num.pick')) {
    const line = Number(cell.textContent);
    if (cell.dataset.path !== drag.path || cell.dataset.side !== drag.side || line < low || line > high) continue;
    cell.classList.add('drag-sel');
    const codeCell = layout === 'split' ? cell.nextElementSibling : cell.parentElement?.lastElementChild;
    codeCell?.classList.add('drag-sel');
  }
}

document.addEventListener('mouseup', (event) => {
  if (!drag) return;
  const { path, side, from, to } = drag;
  drag = undefined;
  paintDrag();
  if (from === to) pick(path, side, from, event.shiftKey);
  else {
    pick(path, side, Math.min(from, to), false).end = Math.max(from, to);
    save();
    renderFiles([path]);
  }
});

function pick(path: string, side: DiffSide, line: number, extend: boolean): Composer {
  const before = composer?.path;
  if (extend && composer?.path === path && composer.side === side) {
    composer.start = Math.min(composer.start, line);
    composer.end = Math.max(composer.end, line);
  } else {
    composer = { path, side, start: line, end: line, text: composer?.text ?? '', target: composer?.target ?? 'claude' };
  }
  focusNext = 'composer';
  save();
  renderFiles([before, path]);
  return composer;
}

function range(start: number, end: number): string {
  return start === end ? 'Line ' + start : 'Lines ' + start + '–' + end;
}

function textarea(key: string, value: string, placeholder: string, onInput: (value: string) => void, onSubmit: () => void, onCancel: () => void): HTMLTextAreaElement {
  const area = el('textarea');
  area.value = value;
  area.placeholder = placeholder;
  area.dataset.draft = key;
  area.setAttribute('aria-label', placeholder);
  area.addEventListener('input', () => onInput(area.value));
  area.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); onSubmit(); } else if (event.key === 'Escape') onCancel();
  });
  return area;
}

function composerBox(draft: Composer): HTMLElement {
  const github = draft.target === 'github';
  const box = el('div', 'thread draft' + (github ? ' github' : ''));
  const head = el('div', 'strip');
  const toggle = el('span', 'seg');
  toggle.setAttribute('role', 'group');
  toggle.setAttribute('aria-label', 'Who sees this comment');
  for (const [value, label] of [['claude', 'Local'], ['github', 'On GitHub']] as const) {
    const on = draft.target === value || (!draft.target && value === 'claude');
    const option = button(label, () => { draft.target = value; focusNext = 'composer'; save(); renderFiles([draft.path]); });
    option.setAttribute('aria-pressed', String(on));
    toggle.append(option);
  }
  const lines = el('span', 'muted', (draft.side === 'old' ? 'Base · ' : '') + range(draft.start, draft.end));
  head.append(el('span', 'source', 'New comment'), toggle, lines);
  box.append(head);
  const cancel = (): void => { composer = undefined; save(); renderFiles([draft.path]); };
  const send = (pending: boolean, intent: Intent = 'ask'): void => {
    if (!draft.text.trim() || sending.has('composer')) return;
    sending.add('composer');
    sentPending = pending;
    $('error').textContent = '';
    renderFiles([draft.path]);
    const where = { form: 'composer', path: draft.path, side: draft.side, startLine: draft.start, endLine: draft.end, text: draft.text } as const;
    post(github ? { action: 'github-comment', pending, ...where } : { action: 'comment', intent, ...where });
  };
  const submit = (): void => send(true);
  const selection: LineRange = { path: draft.path, side: draft.side, startLine: draft.start, endLine: draft.end };
  const file = files?.find((item) => item.path === selection.path);
  const covered = file ? selectedReadIds(file, selection) : undefined;
  const read = el('label', 'check');
  const readBox = el('input');
  readBox.type = 'checkbox';
  readBox.checked = covered !== undefined;
  read.title = 'Collapse these lines. When every change in the file is read, the file is marked Viewed.';
  read.append(readBox, 'Viewed');
  readBox.addEventListener('change', () => {
    if (readBox.checked) {
      const done = !!file && !viewed.has(file.path) && fullyRead(file, [...readRanges, selection]);
      readRanges = [...readRanges, { id: 'pending', ...selection }];
      if (done) markViewed(selection.path, true);
      post({ action: 'read', ...selection, viewed: done });
    } else if (covered) unmarkRead(covered);
    if (readBox.checked && !draft.text.trim()) composer = undefined;
    save();
    renderFiles([selection.path]);
  });
  const hint = (label: string): HTMLElement => {
    const node = el('span', 'hint');
    node.append(el('kbd', '', '⌘/Ctrl'), '+', el('kbd', '', 'Enter'), ' ' + label);
    return node;
  };
  const cancelLink = button('Cancel', cancel, 'quiet');
  const area = textarea('composer', draft.text, github ? 'Comment on GitHub' : 'Ask Claude about these lines', (value) => { draft.text = value; save(); }, submit, cancel);
  const busySending = sending.has('composer');
  const row = el('div', 'row actions composer-actions');
  if (github) {
    const review = button(busySending && sentPending ? 'Sending…' : 'Add to review', () => send(true), 'primary');
    review.disabled = busySending;
    review.title = 'Goes into your pending review. Nobody sees it until you submit the review.';
    const reviewing = current?.details?.pendingComments !== undefined;
    const now = button(busySending && !sentPending ? 'Sending…' : 'Post now', () => send(false));
    now.disabled = busySending || reviewing;
    now.title = reviewing ? 'You have a review in progress, so GitHub adds new comments to it. Submit the review to publish them.' : 'Posts on GitHub right away.';
    row.append(reviewing ? el('span', 'hint', 'Your review is in progress, so comments go into it.') : hint('adds to review'), el('span', 'gap'), cancelLink, now, review);
  } else {
    const implement = button('Implement', () => send(true, 'implement'));
    implement.disabled = busySending;
    implement.title = 'Claude changes the code';
    const ask = button(busySending ? 'Sending…' : 'Ask Claude', submit, 'claude');
    ask.disabled = busySending;
    ask.title = 'Claude answers without editing';
    row.append(hint('asks'), el('span', 'gap'), cancelLink, implement, ask);
  }
  const original = draft.side === 'new' ? selectedText(draft.path, draft.start, draft.end) : undefined;
  if (original !== undefined) {
    const suggest = button('Suggest change', () => {
      draft.text = (draft.text.trim() ? draft.text.replace(/\s*$/u, '\n\n') : '') + '```suggestion\n' + original + '\n```\n';
      focusNext = 'composer';
      save();
      renderFiles([draft.path]);
    }, 'quiet small');
    suggest.title = 'Start a suggestion from these lines. On GitHub it becomes a change the author can commit.';
    lines.before(suggest);
  }
  head.append(read);
  box.append(area, row);
  return box;
}

/** "just now", "5m ago", "3h ago", "2d ago", then the date. */
function relativeTime(iso: string): string {
  const minutes = Math.floor((Date.now() - Date.parse(iso)) / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return minutes + 'm ago';
  if (minutes < 24 * 60) return Math.floor(minutes / 60) + 'h ago';
  if (minutes < 30 * 24 * 60) return Math.floor(minutes / (24 * 60)) + 'd ago';
  return new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

/** "Opened 3d ago · Updated 2h ago · +312 −48 in 14 files", leaving out what GitHub did not send. */
function pullRequestFacts(state: OverviewState): (string | Node)[] {
  const parts: (string | Node)[][] = [];
  if (state.createdAt) parts.push(['Opened ', ...timeLabel(state.createdAt)]);
  if (state.updatedAt) parts.push(['Updated ', ...timeLabel(state.updatedAt)]);
  if (state.changes) {
    const { additions, deletions, files } = state.changes;
    parts.push([el('span', 'stat-add', '+' + additions), ' ', el('span', 'stat-del', '−' + deletions), ' in ' + files + (files === 1 ? ' file' : ' files')]);
  }
  return parts.flatMap((part, index) => index === 0 ? part : [' · ', ...part]);
}

function timeLabel(iso: string): HTMLElement[] {
  if (Number.isNaN(Date.parse(iso))) return [];
  const node = el('time', 'when', relativeTime(iso));
  node.dateTime = iso;
  node.title = new Date(iso).toLocaleString();
  return [node];
}

setInterval(() => { for (const node of document.querySelectorAll<HTMLTimeElement>('time.when')) node.textContent = relativeTime(node.dateTime); }, 60_000);

function avatar(entry: Message, author: string): HTMLElement {
  const url = 'avatarUrl' in entry ? entry.avatarUrl : entry.author === 'claude' ? claudeIcon : current?.details?.viewerAvatarUrl ?? '';
  if (!url) {
    const fallback = el('span', 'avatar');
    fallback.append(icon(codicons.account));
    fallback.title = author;
    return fallback;
  }
  const image = el('img', 'avatar' + (url === claudeIcon ? ' claude' : ''));
  image.src = url;
  image.alt = author;
  image.title = author;
  return image;
}

/** Avatar on the left, text beside it. GitHub messages name their author; local ones are You or Claude, which the avatar already says. */
function message(entry: Message): HTMLElement {
  const github = 'avatarUrl' in entry;
  const author = github ? entry.author : entry.author === 'claude' ? 'Claude' : 'You';
  const meta = el('span', 'msg-meta');
  if (github && entry.pending) meta.append(el('span', 'chip warning', 'Pending'));
  if (!github) meta.append(...timeLabel(entry.createdAt));
  if (github && entry.canDelete) {
    const remove = button('', () => post({ action: 'github-delete', id: entry.id }), 'quiet delete');
    remove.append(icon(codicons.trash));
    remove.title = 'Delete on GitHub';
    remove.setAttribute('aria-label', 'Delete on GitHub');
    meta.append(remove);
  }
  const main = el('div', 'msg-main');
  if (github) {
    const head = el('div', 'msg-head');
    head.append(el('b', '', author), ...timeLabel(entry.createdAt), meta);
    main.append(head);
  } else if (meta.childElementCount > 0) main.append(meta);
  const body = el('div', 'msg-text');
  body.innerHTML = entry.html;
  main.append(body);
  const item = el('div', 'msg');
  item.append(avatar(entry, author), main);
  return item;
}

/** Who can see a thread: Local stays with you and Claude, On GitHub is on the PR, Guide is Claude's note from its guide. */
const kindMarks: Record<'github' | 'local' | 'analysis', string> = { github: codicons.github, local: codicons.vm, analysis: codicons.map };
const kindLabels: Record<'github' | 'local' | 'analysis', string> = { github: 'On GitHub', local: 'Local', analysis: 'Guide' };

function kindLabel(kind: 'github' | 'local' | 'analysis'): HTMLElement {
  const label = el('span', 'source');
  label.append(icon(kindMarks[kind]), kindLabels[kind]);
  return label;
}

function strip<K extends keyof HTMLElementTagNameMap>(tag: K, kind: 'github' | 'local' | 'analysis', note: string, status: readonly string[], right: string): HTMLElementTagNameMap[K] {
  const node = el(tag, 'strip');
  const name = kindLabel(kind);
  name.title = note;
  node.append(name, el('span', 'gap'), ...(status.length ? [el('span', 'pill state', status.join(' · '))] : []), el('span', 'muted', right));
  return node;
}

function threadBox(thread: Thread): HTMLElement {
  const github = thread.source === 'github';
  const fromAnalysis = thread.source === 'local' && thread.origin === 'analysis';
  const box = el('details', 'thread ' + thread.source + (thread.pending ? ' pending' : '') + (fromAnalysis ? ' analysis' : ''));
  box.id = 'thread-' + thread.id;
  box.open = threadOpen.get(thread.id) ?? !thread.resolved;
  box.addEventListener('toggle', () => { if (box.open === !thread.resolved) threadOpen.delete(thread.id); else threadOpen.set(thread.id, box.open); });
  const status = github ? thread.status.split(' · ').filter((part) => part !== 'Open' && part !== 'Pending')
    : thread.status.split(' · ').filter((part) => !fromAnalysis || part !== 'Answered');
  box.append(strip('summary', github ? 'github' : fromAnalysis ? 'analysis' : 'local',
    github ? (thread.pending ? 'Only you see it until you submit your review.' : 'Everyone on the PR sees it.') : fromAnalysis ? 'From Claude\'s guide. Reply to ask about it.' : 'Only you and Claude see it.',
    status, (thread.side === 'old' ? 'Base · ' : '') + range(thread.startLine, thread.endLine)));
  thread.messages.forEach((entry, index) => {
    const item = message(entry);
    const suggestions = 'suggestions' in entry ? entry.suggestions : undefined;
    if (thread.source === 'local' && thread.side === 'new' && suggestions?.length) item.querySelector('.msg-main')?.append(suggestionCard(thread, index, suggestions));
    box.append(item);
  });
  const working = thread.source === 'local' ? thread.working : undefined;
  if (working) {
    const live = el('div', 'claude-live');
    live.append(el('span', 'chip claude working', working));
    box.append(live);
  }
  const key = 'reply:' + thread.id;
  const actions = el('div', 'row actions composer-actions');
  const reply = replies.get(thread.id);
  if (reply !== undefined && !thread.resolved) {
    const cancel = (): void => { replies.delete(thread.id); save(); renderFiles([thread.path]); };
    const submit = (): void => {
      const text = replies.get(thread.id) ?? '';
      if (!text.trim() || sending.has(key)) return;
      sending.add(key);
      $('error').textContent = '';
      renderFiles([thread.path]);
      post({ action: github ? 'github-reply' : 'reply', form: key, id: thread.id, text });
    };
    box.append(textarea(key, reply, github ? 'Reply on GitHub, visible to everyone' : 'Reply to Claude', (value) => { replies.set(thread.id, value); save(); }, submit, cancel));
    const send = button(sending.has(key) ? 'Sending…' : github ? 'Post on GitHub' : 'Reply', submit, github ? 'primary' : 'claude');
    send.disabled = sending.has(key);
    actions.append(el('span', 'gap'), button('Cancel', cancel, 'quiet'), send);
    box.append(actions);
    return box;
  }
  actions.append(el('span', 'gap'), thread.url
    ? button('Open on GitHub ↗', () => post({ action: 'github', id: thread.id }), 'quiet')
    : button('Publish to GitHub…', () => post({ action: 'publish', id: thread.id }), 'quiet'));
  actions.append(button(thread.resolved ? 'Reopen' : 'Resolve', () => post({ action: github ? 'github-resolve' : 'resolve', id: thread.id, resolved: !thread.resolved })));
  if (!thread.resolved) actions.append(button('Reply', () => { replies.set(thread.id, ''); focusNext = key; save(); renderFiles([thread.path]); }));
  box.append(actions);
  return box;
}

/** Option picked on each message's suggestions, by thread id and message index. */
const pickedOptions = new Map<string, number>();

/** A message's suggestions as a small diff against the commented lines; several suggestions are options to switch between. */
function suggestionCard(thread: Extract<Thread, { source: 'local' }>, index: number, suggestions: readonly (readonly string[])[]): HTMLElement {
  const key = thread.id + ':' + index;
  const picked = Math.min(pickedOptions.get(key) ?? (thread.applied?.message === index ? thread.applied.option : 0), suggestions.length - 1);
  const card = el('div', 'suggestion');
  const head = el('div', 'row suggestion-head');
  head.append(el('span', 'muted', suggestions.length > 1 ? suggestions.length + ' suggested options' : 'Suggested change'));
  if (suggestions.length > 1) {
    const tabs = el('span', 'seg');
    suggestions.forEach((_, option) => {
      const tab = button('Option ' + (option + 1), () => { pickedOptions.set(key, option); renderFiles([thread.path]); });
      tab.setAttribute('aria-pressed', String(option === picked));
      tabs.append(tab);
    });
    head.append(tabs);
  }
  const lines = el('pre', 'suggestion-diff');
  const line = (kind: 'add' | 'del', html: string): HTMLElement => {
    const row = el('div', kind);
    row.innerHTML = html;
    row.prepend(el('span', 'sign', kind === 'add' ? '+' : '-'));
    return row;
  };
  for (const html of thread.original ?? []) lines.append(line('del', html));
  for (const html of suggestions[picked] ?? []) lines.append(line('add', html));
  const actions = el('div', 'row actions');
  const where = { id: thread.id, message: index, option: picked };
  const publish = button('Publish suggestion', () => post({ action: 'publish-suggestion', ...where }));
  publish.title = 'Adds it to your pending review as a GitHub suggestion the author can commit.';
  const canPush = current?.details?.canEdit === true;
  const apply = button(canPush ? 'Commit suggestion' : 'Apply', () => post({ action: 'apply-suggestion', ...where }), 'primary');
  apply.title = canPush ? 'Commits the change to the PR branch and pushes it.' : 'Changes the file in the PR worktree. Nothing is committed, since you cannot push to this PR.';
  const done = thread.applied?.message === index ? thread.applied : undefined;
  if (done === undefined) actions.append(el('span', 'gap'), publish, apply);
  else if (done.pushed) actions.append(el('span', 'muted gap', 'Option ' + (done.option + 1) + ' committed and pushed.'));
  else actions.append(el('span', 'muted gap', 'Option ' + (done.option + 1) + ' applied to the worktree, not committed.'), button('Discard', () => post({ action: 'discard-suggestion', id: thread.id })), publish);
  card.append(head, lines, actions);
  return card;
}

/** The selected lines as plain text, for a suggestion to start from. */
function selectedText(path: string, start: number, end: number): string | undefined {
  const full = contextLines.get(path);
  const fromDiff = new Map((files?.find((file) => file.path === path)?.hunks ?? []).flatMap((hunk) => hunk.lines)
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

function inline(content: HTMLElement, width: number): HTMLTableRowElement {
  const row = el('tr', 'inline');
  const cell = el('td');
  cell.colSpan = width;
  cell.append(content);
  row.append(cell);
  return row;
}

function jump(thread: Thread): void {
  if (!files?.some((file) => file.path === thread.path)) {
    post({ action: thread.source === 'github' ? 'github' : 'thread', id: thread.id });
    return;
  }
  if (view === 'guide' && !document.getElementById('thread-' + thread.id)) { setView('files'); }
  if (collapsed.get(thread.path) || folderOf(thread.path).some((folder) => collapsed.get('folder:' + folder))) {
    collapsed.set(thread.path, false);
    openFolders(thread.path);
    save();
    renderFiles();
  }
  const target = document.getElementById('thread-' + thread.id) as HTMLDetailsElement | null;
  if (!target) return;
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

function hunkRange(hunk: DiffHunk): { oldBefore: number; newBefore: number; oldEnd: number; newEnd: number } | undefined {
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
function gapsOf(file: FileDiff): Gap[] {
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

function expansion(path: string, index: number): Shown {
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

function previewKind(file: FileDiff): 'markdown' | 'html' | 'media' | undefined {
  if (mediaType(file.path) !== undefined) return 'media';
  if (file.binary || file.change === 'deleted') return undefined;
  return /\.(md|markdown)$/iu.test(file.path) ? 'markdown' : /\.html?$/iu.test(file.path) ? 'html' : undefined;
}

/** Images and PDFs have no readable diff, so they always show as a preview; SVG keeps its Diff and Preview switch. */
function previewOnly(file: FileDiff): boolean {
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
function mediaNode(file: FileDiff): HTMLElement {
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
  pages.append(el('div', 'note muted', 'Rendering PDF…'));
  pdfViews.set(key, pages);
  void (async () => {
    const library = await loadPdfLibrary();
    const bytes = Uint8Array.from(atob(side.data), (char) => char.charCodeAt(0));
    const pdf = await library.getDocument({ data: bytes, isEvalSupported: false }).promise;
    const shown: HTMLElement[] = [];
    for (let number = 1; number <= Math.min(pdf.numPages, maxPdfPages); number += 1) {
      const page = await pdf.getPage(number);
      const viewport = page.getViewport({ scale: 1.5 });
      const canvas = el('canvas');
      canvas.width = viewport.width;
      canvas.height = viewport.height;
      const context = canvas.getContext('2d');
      if (!context) continue;
      await page.render({ canvasContext: context, viewport }).promise;
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

function previewNode(file: FileDiff, threads: readonly Thread[], placed: Set<string>): HTMLElement {
  const data = previews.get(file.path);
  if (!data) { loadPreview(file); return el('div', 'note muted', 'Loading preview…'); }
  const draft = composer?.path === file.path && composer.side === 'new' ? composer : undefined;
  if (data.kind === 'html') {
    const wrap = el('div', 'preview');
    const frame = el('iframe', 'html-preview');
    frame.setAttribute('sandbox', 'allow-scripts');
    frame.title = 'Preview of ' + file.path;
    frame.dataset.path = file.path;
    frame.srcdoc = data.html.replace('<!--' + data.marker + '-->', '<script nonce="' + nonce + '">(' + frameMain.toString() + ')();</' + 'script>');
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
    split.append(frame, margin);
    wrap.append(el('div', 'note muted', 'Click an element to comment on its source lines, Shift-click to extend. Scripts in the file are off, and linked stylesheets and relative images do not load.'), split);
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
        focusNext = 'composer';
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
function frameMessage(frame: HTMLIFrameElement, raw: unknown): void {
  if (typeof raw !== 'object' || raw === null) return;
  const path = frame.dataset.path ?? '';
  const data = raw as { lrReady?: unknown; lrHeight?: unknown; lrAnchors?: unknown; lrPick?: { start?: unknown; end?: unknown; extend?: unknown; top?: unknown } };
  const { start, end, extend, top } = typeof data.lrPick === 'object' && data.lrPick !== null ? data.lrPick : {};
  const draft = composer?.path === path && composer.side === 'new' ? composer : undefined;
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
      focusNext = 'composer';
    } else pick(path, 'new', start, false).end = end;
    save();
    renderFiles([path]);
  }
}

/** Line each margin card up with its element, pushing cards down so they never overlap. */
function layoutMargin(frame: HTMLIFrameElement, tops: Record<string, number>): void {
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

function loadContext(file: FileDiff): void {
  if (!contextLines.has(file.path) && !loading.has(file.path)) {
    loading.add(file.path);
    post({ action: 'context', path: file.path });
  }
}

function fullFile(file: FileDiff): boolean {
  return contextLines.has(file.path) && gapsOf(file).every((gap, index) => {
    const shown = expansion(file.path, index);
    return shown.top + shown.bottom >= gap.to - gap.from + 1;
  });
}

/** Show a file as viewed right away; the extension's next state confirms it. */
function markViewed(path: string, on: boolean): void {
  if (on) viewed.add(path);
  else viewed.delete(path);
  collapsed.set(path, on);
  save();
}

function unmarkRead(ids: readonly string[]): void {
  readRanges = readRanges.filter((marked) => marked.id === undefined || !ids.includes(marked.id));
  post({ action: 'unread', ids });
}

/** What a file's box shows from extension state, so a state update redraws only the files it changed. */
function fileKey(path: string, threads: readonly Thread[]): string {
  return JSON.stringify([viewed.has(path), collapsed.get(path) === true, readRanges.filter((marked) => marked.path === path), threads,
    composer?.path === path ? [author, current?.details?.pendingComments] : null]);
}

/** Ids of the read ranges covering every selected diff line, or undefined when some selected line is unread. */
function selectedReadIds(file: FileDiff, selection: LineRange): string[] | undefined {
  return rangeReadIds(file, readRanges, selection);
}

/** `expandKey` names where shown context lines are kept; a guide step passes its own so its slice does not share the file's. */
function table(file: FileDiff, threads: readonly Thread[], placed: Set<string>, draft: Composer | null | undefined = composer?.path === file.path ? composer : undefined, expandKey = file.path): HTMLTableElement {
  const node = el('table');
  const columns = el('colgroup');
  const widths = layout === 'split' ? ['num', '', 'num', ''] : ['num', 'num', ''];
  for (const name of widths) columns.append(el('col', name));
  node.append(columns);
  const add = (row: HTMLTableRowElement, covers: readonly (readonly [DiffSide, number | undefined])[], hidden = false): void => {
    if (!hidden) node.append(row);
    for (const [side, line] of covers) {
      if (line === undefined) continue;
      if (draft?.side === side && draft.start <= line && line <= draft.end) {
        const cells = [...row.children].slice(layout === 'split' && side === 'new' ? 2 : 0, layout === 'split' && side === 'old' ? 2 : undefined);
        for (const cell of cells) cell.classList.add('sel');
        cells[0]?.classList.add('sel-start');
      }
      for (const thread of threads) {
        if (placed.has(thread.id) || thread.outdated || thread.side !== side || thread.endLine !== line) continue;
        placed.add(thread.id);
        node.append(inline(threadBox(thread), widths.length));
      }
      if (draft?.side === side && draft.end === line) node.append(inline(composerBox(draft), widths.length));
    }
  };
  const lineRow = (line: DiffLine, hidden = false): void => {
    const row = el('tr', line.kind);
    row.append(num(line.oldLine, file.path, 'old'), num(line.newLine, file.path, 'new'), code(line, ''));
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
    if (layout === 'split') pairRow(line, line);
    else lineRow(line);
  };
  const gaps = gapsOf(file);
  const read = readLines(file, readRanges);
  const readRow = (lines: readonly DiffLine[], key: string, open: boolean): HTMLTableRowElement => {
    const row = el('tr', 'read-run');
    const cell = el('td');
    cell.colSpan = widths.length;
    row.append(cell);
    const label = el('span', 'read-label', '✓ ' + lines.length + (lines.length === 1 ? ' line read' : ' lines read'));
    label.prepend(chevronMark(!open));
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
    if (hidden > 0) {
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
    if (!contextLines.has(file.path)) { expander(gap, index, header); return; }
    const top = Math.min(shown.top, size);
    const bottom = Math.min(shown.bottom, size - top);
    for (let line = gap.from; line < gap.from + top; line++) contextRow(line, gap.offset);
    expander(gap, index, header);
    for (let line = gap.to - bottom + 1; line <= gap.to; line++) contextRow(line, gap.offset);
  };
  const draw = (row: Row, hidden: boolean): void => {
    if (layout === 'split') pairRow(row[0], row[1], hidden);
    else if (row[0]) lineRow(row[0], hidden);
  };
  const isRead = (row: Row): boolean => row.every((line) => !line || read.has(line));
  file.hunks.forEach((hunk, index) => {
    const gap = gaps[index];
    if (gap) gapRows(gap, index, hunk.header);
    else {
      const header = el('tr', 'hunk');
      const cell = el('td', '', hunk.header);
      cell.colSpan = widths.length;
      header.append(cell);
      node.append(header);
    }
    const rows: Row[] = layout === 'split' ? pairs(hunk) : hunk.lines.map((line) => [line]);
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
  if (last && file.change !== 'added' && file.change !== 'deleted') gapRows(last, file.hunks.length);
  return node;
}

/** The fold arrow: points down when open, right when collapsed. */
function chevronMark(collapsed: boolean): HTMLElement {
  return el('span', collapsed ? 'chevron closed' : 'chevron');
}

/** Sets a button's hover tip and its accessible name together. */
function setTip(button: HTMLElement, tip: string): void {
  button.dataset.tip = tip;
  button.setAttribute('aria-label', tip);
}

/** Redraw the file list; given paths, or 'state' for files whose state changed, redraw only those boxes when the rest are on the page. */
function renderFiles(only?: readonly (string | undefined)[] | 'state'): void {
  for (const name of ['unified', 'split'] as const) $(name).setAttribute('aria-pressed', String(layout === name));
  for (const name of ['files', 'guide'] as const) $('view-' + name).setAttribute('aria-selected', String(view === name));
  showGuideTab();
  const folderButton = $('folders');
  folderButton.toggleAttribute('disabled', view === 'guide');
  setTip(folderButton, view === 'guide' ? 'Folders are off in the guide' : 'Group files by folder');
  folderButton.setAttribute('aria-pressed', String(folders));
  folderButton.setAttribute('aria-pressed', String(folders));
  if (!files) return;
  if (view === 'guide') { keepView(() => renderGuide(only)); return; }
  const shownFiles = files;
  const container = $('files');
  const threadsByFile = new Map<string, Thread[]>();
  for (const thread of allThreads()) {
    const list = threadsByFile.get(thread.path) ?? [];
    threadsByFile.set(thread.path, list);
    list.push(thread);
  }
  $('files-title').textContent = shownFiles.filter((file) => viewed.has(file.path)).length + '/' + shownFiles.length + ' viewed';
  const tree = fileTree(shownFiles);
  const visible = !folders ? shownFiles : shownFiles.filter((file) => !folderOf(file.path).some((folder) => collapsed.get('folder:' + folder) === true));
  const boxes = new Map([...container.querySelectorAll<HTMLElement>('.file[data-path]')].map((node) => [node.dataset.path, node]));
  const threadsOf = (path: string): Thread[] => threadsByFile.get(path) ?? [];
  const changed = only === 'state' ? visible.map((file) => file.path).filter((path) => fileKeys.get(path) !== fileKey(path, threadsOf(path))) : only;
  const targets = changed && boxes.size === visible.length ? [...new Set(changed.filter((path): path is string => path !== undefined))] : undefined;
  const draw = (file: FileDiff): HTMLElement => {
    fileKeys.set(file.path, fileKey(file.path, threadsOf(file.path)));
    return fileBox(file, threadsOf(file.path));
  };
  keepView(() => {
    if (targets?.every((path) => boxes.has(path))) {
      for (const path of targets) {
        const file = shownFiles.find((item) => item.path === path);
        if (file) boxes.get(path)?.replaceWith(draw(file));
      }
    } else {
      container.replaceChildren();
      fileKeys.clear();
      if (!shownFiles.length) container.append(el('p', 'muted', 'No changes against the base branch.'));
      const append = (parent: HTMLElement, folder: FileFolder<FileDiff>, depth: number): void => {
        for (const child of folder.folders) {
          const isCollapsed = collapsed.get('folder:' + child.path) === true;
          const head = el('div', 'folder-head');
          head.dataset.folder = child.path;
          head.append(el('span', 'name', child.name), el('span', 'muted progress'));
          const { node, rail } = railNode(head, depth, isCollapsed, () => { collapsed.set('folder:' + child.path, !isCollapsed); save(); renderFiles(); });
          put(parent, depth, node);
          if (!isCollapsed) append(rail, child, depth + 1);
        }
        for (const file of folder.files) put(parent, depth, draw(file));
      };
      const put = (parent: HTMLElement, depth: number, child: HTMLElement): void => { parent.append(depth === 0 ? child : railItem(child)); };
      if (folders) append(container, tree, 0);
      else for (const file of shownFiles) container.append(draw(file));
    }
    if (folders) updateFolderProgress(tree);
    for (const frame of container.querySelectorAll<HTMLIFrameElement>('iframe.html-preview')) layoutMargin(frame, frameTops.get(frame.dataset.path ?? '') ?? {});
  });
}

/** Folders a path sits in, outermost first: every prefix, so compacted folder rows match too. */
function folderOf(path: string): string[] {
  const parts = path.split('/').slice(0, -1);
  return parts.map((_part, index) => parts.slice(0, index + 1).join('/'));
}

function updateFolderProgress(tree: FileFolder<FileDiff>): void {
  const count = (folder: FileFolder<FileDiff>): { done: number; total: number } => folder.folders.map(count).reduce(
    (sum, next) => ({ done: sum.done + next.done, total: sum.total + next.total }),
    { done: folder.files.filter((file) => viewed.has(file.path)).length, total: folder.files.length },
  );
  const walk = (folder: FileFolder<FileDiff>): void => {
    for (const child of folder.folders) {
      const { done, total } = count(child);
      const progress = document.querySelector('[data-folder="' + CSS.escape(child.path) + '"] .progress');
      if (progress) progress.textContent = done + '/' + total + ' viewed';
      walk(child);
    }
  };
  walk(tree);
}

/** Open the folders around a file so its box is on the page. */
function openFolders(path: string): void {
  for (const folder of folderOf(path)) collapsed.delete('folder:' + folder);
}

/** Redraw the file list without losing the scroll position or the draft being typed. */
function keepView(draw: () => void): void {
  const container = $('files');
  const scroll = window.scrollY;
  const active = document.activeElement;
  const focus = active instanceof HTMLTextAreaElement && active.dataset.draft ? { key: active.dataset.draft, start: active.selectionStart, end: active.selectionEnd } : undefined;
  draw();
  if (focus) {
    const area = container.querySelector<HTMLTextAreaElement>('[data-draft="' + CSS.escape(focus.key) + '"]');
    if (area) { area.focus({ preventScroll: true }); area.setSelectionRange(focus.start, focus.end); }
  }
  window.scrollTo(0, scroll);
  if (focusNext) {
    const area = container.querySelector<HTMLTextAreaElement>('[data-draft="' + CSS.escape(focusNext) + '"]');
    focusNext = undefined;
    area?.focus();
  }
}

/** Where a step's or group's open state is saved; tied to the analysis so a new one starts fresh. */
function guideState(kind: 'step' | 'group', key: string): string {
  return kind + ':' + (current?.analysis.result?.createdAt ?? '') + ':' + key;
}

/** A step's change blocks with up to three unchanged lines around each, without reaching into other changes. */
function sliceOf(step: GuideStep): FileDiff | undefined {
  const file = files?.find((item) => item.path === step.path);
  if (!file) return undefined;
  const spans: { hunk: number; from: number; to: number }[] = [];
  for (const block of step.blocks) {
    const lines = file.hunks[block.hunk]?.lines ?? [];
    let from = block.first;
    let to = block.last;
    while (from > 0 && block.first - from < 3 && lines[from - 1]?.kind === 'context') from -= 1;
    while (to < lines.length - 1 && to - block.last < 3 && lines[to + 1]?.kind === 'context') to += 1;
    const previous = spans.at(-1);
    if (previous && previous.hunk === block.hunk && from <= previous.to + 1) previous.to = Math.max(previous.to, to);
    else spans.push({ hunk: block.hunk, from, to });
  }
  return { ...file, hunks: spans.flatMap(({ hunk, from, to }) => { const source = file.hunks[hunk]; return source ? [subHunk(source, from, to)] : []; }) };
}

/** Lines `from` to `to` of a hunk, with a header that numbers them as git would. */
function subHunk(source: DiffHunk, from: number, to: number): DiffHunk {
  const lines = source.lines.slice(from, to + 1);
  const span = hunkRange(source);
  if (!span) {
    const numbers = lines.map((line) => line.newLine ?? line.oldLine).filter((value): value is number => value !== undefined);
    return { header: range(numbers[0] ?? 0, numbers.at(-1) ?? 0), lines };
  }
  const before = source.lines.slice(0, from);
  const oldBefore = span.oldBefore + before.filter((line) => line.kind !== 'add').length;
  const newBefore = span.newBefore + before.filter((line) => line.kind !== 'del').length;
  const oldCount = lines.filter((line) => line.kind !== 'add').length;
  const newCount = lines.filter((line) => line.kind !== 'del').length;
  return { header: '@@ -' + (oldCount ? oldBefore + 1 : oldBefore) + ',' + oldCount + ' +' + (newCount ? newBefore + 1 : newBefore) + ',' + newCount + ' @@', lines };
}

function hasLine(slice: FileDiff, side: DiffSide, line: number): boolean {
  const key = side === 'old' ? 'oldLine' : 'newLine';
  return slice.hunks.some((hunk) => hunk.lines.some((item) => item[key] === line));
}

function stepViewed(step: GuideStep): boolean {
  return isStepViewed(step, files?.find((item) => item.path === step.path), readRanges, viewed.has(step.path));
}

function stepCollapsed(step: GuideStep): boolean {
  return collapsed.get(guideState('step', step.key)) ?? stepViewed(step);
}

function groupCollapsed(group: GuideGroup): boolean {
  return collapsed.get(guideState('group', group.key)) ?? group.severity === 'trivial';
}

/** Which step shows each thread and the draft: a note's own step, otherwise the first step whose lines include it. */
function guideOwners(groups: readonly GuideGroup[], slices: ReadonlyMap<string, FileDiff>): { threads: Map<string, Thread[]>; notes: Map<string, Thread>; draft?: string } {
  const threads = new Map<string, Thread[]>();
  const notes = new Map<string, Thread>();
  const all = allThreads();
  const steps = groups.flatMap((group) => group.steps);
  for (const step of steps) {
    const note = step.threadId === undefined ? undefined : all.find((thread) => thread.source === 'local' && thread.id === step.threadId);
    if (note) notes.set(step.key, note);
  }
  const noted = new Set([...notes.values()].map((thread) => thread.id));
  const owner = (path: string, side: DiffSide, line: number): string | undefined => steps.find((step) => {
    const slice = slices.get(step.key);
    return step.path === path && slice !== undefined && hasLine(slice, side, line);
  })?.key;
  for (const thread of all) {
    if (noted.has(thread.id) || thread.outdated) continue;
    const key = owner(thread.path, thread.side, thread.endLine);
    if (key !== undefined) threads.set(key, [...threads.get(key) ?? [], thread]);
  }
  const draft = composer ? owner(composer.path, composer.side, composer.end) : undefined;
  return draft === undefined ? { threads, notes } : { threads, notes, draft };
}

function guideIntro(): HTMLElement {
  const analysis = current?.analysis;
  const card = el('section', 'card guide-intro');
  card.append(el('h3', '', 'Guide'), el('p', '', 'Claude reads the changes, groups them by severity, puts them in reading order and explains each step. '
    + 'Each note is a thread you can reply to. Every change lands in exactly one step, so once every step is Viewed, the whole PR is.'));
  const row = el('div', 'row');
  const start = button(analysis?.running ? 'Stop' : 'Build guide', () => post({ action: analysis?.running ? 'analysis-stop' : 'analyze' }), analysis?.running ? '' : 'primary');
  row.append(start);
  if (analysis?.running) row.append(el('span', 'chip claude working', 'Guide · ' + (analysis.step ?? 'Working')));
  else if (analysis?.error) row.append(el('span', 'bad', 'Guide failed: ' + analysis.error));
  else row.append(el('span', 'muted', 'Runs Claude read-only on this PR. Large PRs take a few minutes.'));
  card.append(row);
  return card;
}

function guideSummary(overview: string, stale: boolean): HTMLElement {
  const card = el('section', 'card guide-intro');
  card.append(el('h3', '', 'Guide'));
  if (overview) card.append(el('p', 'text', overview));
  if (stale) card.append(el('p', 'wait', 'Made for an older commit. Steps whose code changed since then moved to Unclassified. Rebuild the guide to update.'));
  card.append(el('p', 'muted', 'Every change is in exactly one step. Viewed on every step marks the whole PR viewed.'));
  return card;
}

type ThreadKind = 'github' | 'local' | 'analysis';
const threadKinds: readonly ThreadKind[] = ['github', 'local', 'analysis'];

function threadKind(thread: Thread): ThreadKind {
  return thread.source === 'github' ? 'github' : thread.origin === 'analysis' ? 'analysis' : 'local';
}

/** The Threads card: one foldable group per kind, one line per thread. Guide starts folded because its notes already sit in the diff. */
function renderThreadList(): void {
  const threads = allThreads();
  $('threads-title').textContent = 'Threads (' + threads.length + ')';
  const list = $('threads');
  list.replaceChildren();
  if (threads.length === 0) list.append(el('li', 'muted', current?.github || current?.githubError ? 'No comments yet.' : 'No local comments yet. Loading GitHub comments…'));
  if (current?.githubError) list.append(el('li', 'bad', 'Could not load GitHub comments: ' + current.githubError));
  for (const kind of threadKinds) {
    const members = threads.filter((thread) => threadKind(thread) === kind);
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
      for (const thread of members) rows.append(threadRow(thread, kind));
      group.append(rows);
    }
    list.append(group);
  }
}

/** Plain text with `backtick` spans shown as code. */
function inlineCode(text: string): Node[] {
  return text.split('`').map((part, index) => index % 2 === 1 ? el('code', '', part) : document.createTextNode(part));
}

/** One thread as a row: where on the left, the text in a column that lines up, status on the right only when it adds something. */
function threadRow(thread: Thread, kind: ThreadKind): HTMLElement {
  const item = el('li', 'card-thread ' + kind);
  item.title = thread.location + '\n' + thread.text;
  item.addEventListener('click', () => jump(thread));
  const text = el('span', 'text');
  text.append(...inlineCode(thread.text));
  const status = kind === 'analysis' ? '' : thread.status;
  const working = thread.source === 'local' ? thread.working : undefined;
  const [name = '', line = ''] = (thread.location.split('/').pop() ?? '').split(/(?=:\d+$)/u);
  const where = el('span', 'where');
  where.append(el('span', 'name', name), line);
  const state = el('span', 'state', working ? '' : status);
  if (working) state.append(el('span', 'chip claude working', working));
  item.append(where, text, state);
  if (thread.url) {
    const link = el('a', 'open', '↗');
    link.title = 'Open on GitHub';
    link.addEventListener('click', (event) => { event.stopPropagation(); post({ action: 'github', id: thread.id }); });
    item.append(link);
  }
  return item;
}

function groupHead(group: GuideGroup): HTMLElement {
  const head = el('div', 'guide-group sev-' + group.severity);
  head.dataset.group = group.key;
  head.append(el('span', 'sev', severityLabels[group.severity]), el('span', 'title', group.title), el('span', 'muted progress'));
  return head;
}

/** A foldable level of the file list: its head, then its children beside a rail that folds them when clicked, like a threaded discussion. */
function railNode(head: HTMLElement, depth: number, isCollapsed: boolean, toggle: () => void): { node: HTMLElement; rail: HTMLElement } {
  const node = el('section', 'tree-node');
  node.style.setProperty('--depth', String(depth));
  head.classList.add('node-head');
  head.prepend(foldToggle(isCollapsed));
  head.addEventListener('click', toggle);
  const rail = el('div', 'fold-rail');
  rail.style.setProperty('--depth', String(depth + 1));
  const line = el('div', 'fold-line');
  line.title = 'Fold';
  line.addEventListener('click', toggle);
  rail.append(line);
  node.append(head);
  if (!isCollapsed) node.append(rail);
  return { node, rail };
}

/** A child hanging off a rail, joined to it by a curved elbow. */
function railItem(child: HTMLElement): HTMLElement {
  const item = el('div', 'rail-item');
  item.append(child);
  return item;
}

function foldToggle(isCollapsed: boolean): HTMLElement {
  const button = el('span', 'fold-toggle');
  button.title = isCollapsed ? 'Unfold' : 'Fold';
  button.innerHTML = '<svg viewBox="0 0 16 16"><circle cx="8" cy="8" r="6.5"/><path d="M5 8h6' + (isCollapsed ? 'M8 5v6' : '') + '"/></svg>';
  return button;
}

function updateGuideProgress(groups: readonly GuideGroup[]): void {
  const steps = groups.flatMap((group) => group.steps);
  $('files-title').textContent = steps.filter(stepViewed).length + '/' + steps.length + ' steps viewed';
  for (const group of groups) {
    const progress = document.querySelector('[data-group="' + CSS.escape(group.key) + '"] .progress');
    if (progress) progress.textContent = group.steps.filter(stepViewed).length + '/' + group.steps.length + ' viewed';
  }
}

/** The guided layout: Claude's steps by severity, each a slice of the diff with its note and a Viewed checkbox. */
function renderGuide(only?: readonly (string | undefined)[] | 'state'): void {
  const container = $('files');
  const result = current?.analysis.result;
  if (!files || !result) {
    $('files-title').textContent = '';
    container.replaceChildren(guideIntro());
    return;
  }
  const shownFiles = files;
  guide ??= buildGuide(result, shownFiles);
  const groups = guide;
  const slices = new Map(groups.flatMap((group) => group.steps).flatMap((step) => {
    const slice = sliceOf(step);
    return slice ? [[step.key, slice] as const] : [];
  }));
  const owners = guideOwners(groups, slices);
  const visible = groups.filter((group) => !groupCollapsed(group)).flatMap((group) => group.steps);
  const keyOf = (step: GuideStep): string => JSON.stringify([stepViewed(step), stepCollapsed(step), readRanges.filter((marked) => marked.path === step.path),
    owners.threads.get(step.key) ?? [], owners.notes.get(step.key) ?? null, owners.draft === step.key ? [author, current?.details?.pendingComments] : null]);
  const numbers = new Map(groups.flatMap((group) => group.steps.map((step, index) => [step.key, index + 1] as const)));
  const draw = (step: GuideStep): HTMLElement => {
    stepKeys.set(step.key, keyOf(step));
    return stepBox(step, numbers.get(step.key) ?? 0, slices.get(step.key), owners.threads.get(step.key) ?? [], owners.notes.get(step.key), owners.draft === step.key);
  };
  const boxes = new Map([...container.querySelectorAll<HTMLElement>('.step-wrap')].map((node) => [node.dataset.key, node]));
  const targets = only === 'state' ? visible.filter((step) => stepKeys.get(step.key) !== keyOf(step))
    : only ? visible.filter((step) => only.includes(step.path)) : undefined;
  if (targets && boxes.size === visible.length && targets.every((step) => boxes.has(step.key))) {
    for (const step of targets) boxes.get(step.key)?.replaceWith(draw(step));
  } else {
    stepKeys.clear();
    container.replaceChildren(guideSummary(result.overview, current?.analysis.stale === true));
    for (const group of groups) {
      const isCollapsed = groupCollapsed(group);
      const { node, rail } = railNode(groupHead(group), 0, isCollapsed, () => { collapsed.set(guideState('group', group.key), !isCollapsed); save(); renderFiles(); });
      container.append(node);
      if (!isCollapsed) for (const step of group.steps) rail.append(railItem(draw(step)));
    }
  }
  updateGuideProgress(groups);
}

function stepBox(step: GuideStep, number: number, slice: FileDiff | undefined, threads: readonly Thread[], note: Thread | undefined, hasDraft: boolean): HTMLElement {
  const wrap = el('div', 'step-wrap');
  wrap.dataset.key = step.key;
  if (step.transition) wrap.append(el('div', 'transition', '↓ ' + step.transition));
  const file = files?.find((item) => item.path === step.path);
  if (!file || !slice) return wrap;
  const isCollapsed = stepCollapsed(step);
  const box = el('div', 'file step' + (isCollapsed ? ' collapsed' : ''));
  box.dataset.path = step.path;
  const head = el('div', 'file-head');
  const chevron = chevronMark(isCollapsed);
  const name = el('span', 'name');
  name.append(el('span', 'step-title', number + '.' + (step.title ? ' ' + step.title : '')), el('span', 'step-path', file.oldPath ? file.oldPath + ' → ' + file.path : file.path));
  const toggle = (): void => { collapsed.set(guideState('step', step.key), !isCollapsed); save(); renderFiles([step.path]); };
  chevron.addEventListener('click', toggle);
  name.addEventListener('click', toggle);
  const badge = el('span', 'badge ' + file.change, changeLetters[file.change]);
  badge.title = file.change;
  const lines = step.blocks.flatMap((block) => file.hunks[block.hunk]?.lines.slice(block.first, block.last + 1) ?? []);
  const stats = el('span', 'stats');
  stats.append(el('span', 'stat-add', '+' + lines.filter((line) => line.kind === 'add').length), ' ', el('span', 'stat-del', '−' + lines.filter((line) => line.kind === 'del').length));
  const label = el('label', 'viewed');
  const check = el('input');
  check.type = 'checkbox';
  check.checked = stepViewed(step);
  label.title = 'Mark this step\'s changes read. When every change in the file is read, the file is marked Viewed.';
  check.addEventListener('change', () => {
    collapsed.delete(guideState('step', step.key));
    if (!step.blocks.length) {
      markViewed(step.path, check.checked);
      post({ action: 'viewed', path: step.path, viewed: check.checked });
    } else if (check.checked) {
      const unread = step.blocks.map((block) => block.range).filter((marked) => selectedReadIds(file, marked) === undefined);
      const done = !viewed.has(step.path) && fullyRead(file, [...readRanges, ...unread]);
      readRanges = [...readRanges, ...unread.map((marked) => ({ id: 'pending', ...marked }))];
      if (done) markViewed(step.path, true);
      unread.forEach((marked, index) => post({ action: 'read', ...marked, viewed: done && index === unread.length - 1 }));
    } else {
      unmarkRead([...new Set(step.blocks.flatMap((block) => selectedReadIds(file, block.range) ?? []))]);
      if (viewed.has(step.path)) { markViewed(step.path, false); post({ action: 'viewed', path: step.path, viewed: false }); }
    }
    save();
    renderFiles([step.path]);
  });
  label.append(check, 'Viewed');
  const kind = previewKind(file);
  const showPreview = kind !== undefined && (previewing.has(file.path) || previewOnly(file));
  head.append(chevron, name, badge, stats, previewSwitch(file, showPreview), label, button('Open in editor', () => post({ action: 'editor', path: step.path })));
  box.append(head);
  const diff = el('div', 'diff');
  if (step.fileNote) {
    const about = el('div', 'file-note');
    about.append(el('span', 'tag', 'About this file'), ' ', step.fileNote);
    diff.append(about);
  }
  if (note) diff.append(threadBox(note));
  else if (step.note) diff.append(el('div', 'step-note', step.note));
  if (showPreview && kind === 'media') diff.append(mediaNode(file));
  else if (file.binary) diff.append(el('div', 'note muted', 'Binary file not shown.'));
  else if (showPreview) diff.append(previewNode(file, threads, new Set()));
  else if (!slice.hunks.length) diff.append(el('div', 'note muted', file.change === 'renamed' ? 'Renamed without changes.' : 'No content changes.'));
  else diff.append(table(slice, threads, new Set(), hasDraft ? composer : null, 'step:' + step.key));
  box.append(diff);
  wrap.append(box);
  return wrap;
}

/** Diff and Preview buttons for a file that can be previewed and still has a readable diff. */
function previewSwitch(file: FileDiff, showPreview: boolean): HTMLElement {
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

function fileBox(file: FileDiff, threads: readonly Thread[]): HTMLElement {
  const isCollapsed = collapsed.get(file.path) === true;
  const box = el('div', 'file' + (isCollapsed ? ' collapsed' : ''));
  box.dataset.path = file.path;
  const head = el('div', 'file-head');
  const chevron = chevronMark(isCollapsed);
  const base = file.path.split('/').at(-1) ?? file.path;
  const shown = folders ? base : file.path;
  const name = el('span', 'name', file.oldPath ? file.oldPath + ' → ' + shown : shown);
  name.title = file.path;
  const toggle = (): void => { collapsed.set(file.path, !isCollapsed); save(); renderFiles([file.path]); };
  chevron.addEventListener('click', toggle);
  name.addEventListener('click', toggle);
  const badge = el('span', 'badge ' + file.change, changeLetters[file.change]);
  badge.title = file.change;
  const stats = el('span', 'stats');
  stats.append(el('span', 'stat-add', '+' + file.additions), ' ', el('span', 'stat-del', '−' + file.deletions));
  const label = el('label', 'viewed');
  const check = el('input');
  check.type = 'checkbox';
  check.checked = viewed.has(file.path);
  check.addEventListener('change', () => {
    markViewed(file.path, check.checked);
    post({ action: 'viewed', path: file.path, viewed: check.checked });
    renderFiles([file.path]);
  });
  label.append(check, 'Viewed');
  const open = button('Open in editor', () => post({ action: 'editor', path: file.path }));
  const whole = fullFile(file);
  const full = button(whole ? 'Diff only' : 'Full file', () => {
    expanded.set(file.path, whole ? new Map() : new Map(Array.from({ length: file.hunks.length + 1 }, (_, index) => [index, { top: Infinity, bottom: 0 }])));
    loadContext(file);
    renderFiles([file.path]);
  });
  const kind = previewKind(file);
  const showPreview = kind !== undefined && (previewing.has(file.path) || previewOnly(file));
  full.hidden = showPreview || file.binary || file.change === 'added' || file.change === 'deleted' || !file.hunks.length;
  const mode = previewSwitch(file, showPreview);
  const unresolved = threads.filter((thread) => !thread.resolved).length;
  const comments = el('span', 'muted comments', !threads.length ? '' : threads.length + (threads.length === 1 ? ' comment' : ' comments') + (unresolved === threads.length ? '' : ', ' + unresolved + ' open'));
  head.append(chevron, name, badge, stats, comments, mode, label, full, open);
  box.append(head);
  const diff = el('div', 'diff');
  const placed = new Set<string>();
  if (showPreview && kind === 'media') diff.append(mediaNode(file));
  else if (file.binary) diff.append(el('div', 'note muted', 'Binary file not shown.'));
  else if (showPreview) diff.append(previewNode(file, threads, placed));
  else if (!file.hunks.length) diff.append(el('div', 'note muted', file.change === 'renamed' ? 'Renamed without changes.' : 'No content changes.'));
  else diff.append(table(file, threads, placed));
  const outside = threads.filter((thread) => !placed.has(thread.id));
  if (outside.length) {
    const block = el('div', 'outside');
    block.append(el('div', 'muted', 'Comments on lines this diff does not show'), ...outside.map(threadBox));
    diff.prepend(block);
  }
  box.append(diff);
  return box;
}

function columnAt(cell: HTMLElement, event: MouseEvent): number | undefined {
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

function lookupTarget(cell: HTMLElement): DefinitionTarget | undefined {
  const peekId = cell.closest('#peek') ? peeks[peekAt]?.id : undefined;
  const path = cell.closest<HTMLElement>('.file')?.dataset.path;
  return peekId ? { peek: peekId } : path !== undefined ? { path } : undefined;
}

const probes = new Map<string, boolean | 'pending'>();
let hovered: { id: string; cell: HTMLElement; start: number; end: number } | undefined;
let pointer: MouseEvent | undefined;
let probeTimer: ReturnType<typeof setTimeout> | undefined;

function setHighlight(name: string, span?: Range): void {
  if (!window.CSS?.highlights) return;
  if (span) CSS.highlights.set(name, new Highlight(span));
  else CSS.highlights.delete(name);
}

function showLink(): void {
  document.querySelectorAll('td.code.linked').forEach((cell) => cell.classList.remove('linked'));
  if (!hovered || probes.get(hovered.id) !== true) { setHighlight('lr-link'); return; }
  hovered.cell.classList.add('linked');
  setHighlight('lr-link', textRange(hovered.cell, hovered.start, hovered.end));
}

function probeAt(event: MouseEvent): void {
  clearTimeout(probeTimer);
  hovered = undefined;
  const cell = closestTo(event, 'td.code[data-line]');
  const target = cell ? lookupTarget(cell) : undefined;
  const column = cell ? columnAt(cell, event) : undefined;
  const word = cell && column !== undefined ? wordAt(cell, column) : undefined;
  if (!cell || !target || !word) { showLink(); return; }
  const id = JSON.stringify(['peek' in target ? target.peek : target.path, cell.dataset.line, word.start]);
  hovered = { id, cell, start: word.start, end: word.end };
  showLink();
  if (probes.has(id)) return;
  probeTimer = setTimeout(() => {
    probes.set(id, 'pending');
    post({ action: 'probe', id, ...target, line: Number(cell.dataset.line), column: word.start });
  }, 60);
}

function closePeek(): void {
  peeks.length = 0;
  peekAt = -1;
  renderPeek();
}

function renderPeek(): void {
  $('peek').hidden = peekAt < 0;
  setHighlight('lr-name');
  const peek = peeks[peekAt];
  if (!peek) return;
  $('peek-title').textContent = peek.guessed ? peek.location + ' · same name in this file' : peek.location;
  $<HTMLButtonElement>('peek-back').disabled = peekAt < 1;
  $<HTMLButtonElement>('peek-forward').disabled = peekAt >= peeks.length - 1;
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

/** Switch between the file list and the guide; the sidebar follows. */
function setView(next: View): void {
  view = next;
  save();
  renderFiles();
  post({ action: 'view', view: next });
}

/** The Guide tab's count: steps once a guide exists, a pulse while Claude builds it. Build guide shows only in the guide. */
function showGuideTab(): void {
  const analysis = current?.analysis;
  const count = $('guide-count');
  const steps = analysis?.result?.groups.reduce((sum, group) => sum + group.steps.length, 0);
  count.className = analysis?.running ? 'count working' : 'count';
  count.textContent = analysis?.running || steps === undefined ? '' : String(steps);
  count.hidden = !analysis?.running && steps === undefined;
  $('files-count').textContent = files ? String(files.length) : '';
  for (const id of ['analyze', 'analysis-status', 'analyze-divider']) $(id).classList.toggle('off-view', view !== 'guide');
}

/** Show the guided layout with a step's group and the step open, scrolled to it. */
function revealStep(key: string): void {
  view = 'guide';
  const result = current?.analysis.result;
  if (files && result) {
    guide ??= buildGuide(result, files);
    const group = guide.find((item) => item.steps.some((step) => step.key === key));
    if (group) {
      collapsed.set(guideState('group', group.key), false);
      collapsed.set(guideState('step', key), false);
    }
  }
  save();
  renderFiles();
  document.querySelector('.step-wrap[data-key="' + CSS.escape(key) + '"]')?.scrollIntoView({ block: 'start' });
}

let noticeTimer: ReturnType<typeof setTimeout> | undefined;

/** Show a hint that clears itself after a few seconds, on the next click, or on Escape. */
function showNotice(notice: NonNullable<ExtensionMessage['notice']>): void {
  const box = $('notice');
  const { extension } = notice;
  box.replaceChildren(el('span', '', notice.text), ...extension === undefined ? [] : [button('Find extension', () => { post({ action: 'find-extension', extension }); clearNotice(); }, 'small')]);
  clearTimeout(noticeTimer);
  noticeTimer = setTimeout(clearNotice, extension === undefined ? 4000 : 8000);
}

function clearNotice(): void {
  clearTimeout(noticeTimer);
  $('notice').replaceChildren();
}

function onExtensionMessage(data: ExtensionMessage): void {
  if (data.state) render(data.state);
  if (data.files) { files = data.files; guide = undefined; contextLines.clear(); loading.clear(); renderFiles(); }
  if (data.preview) { previews.set(data.preview.path, data.preview); loading.delete('preview:' + data.preview.path); renderFiles([data.preview.path]); }
  if (data.media) { medias.set(data.media.path, data.media); loading.delete('media:' + data.media.path); renderFiles([data.media.path]); }
  if (data.context) { contextLines.set(data.context.path, data.context.lines); loading.delete(data.context.path); renderFiles([data.context.path]); }
  if (data.definition) { peeks.length = peekAt + 1; peeks.push(data.definition); peekAt = peeks.length - 1; renderPeek(); }
  if (data.probe) { probes.set(data.probe.id, data.probe.found); showLink(); }
  if (data.revealStep) revealStep(data.revealStep);
  if (data.reveal && files) {
    collapsed.set(data.reveal, false);
    openFolders(data.reveal);
    save();
    renderFiles();
    document.querySelector('[data-path="' + CSS.escape(data.reveal) + '"]')?.scrollIntoView({ block: 'start' });
  }
  if (data.filesError) $('files').replaceChildren(el('p', 'bad', 'Could not read the changes: ' + data.filesError));
  if (data.notice) showNotice(data.notice);
  if (data.error) {
    loading.clear();
    $('error').textContent = data.error;
    if (data.form && sending.delete(data.form)) renderFiles();
  }
  if (data.done === 'review') $<HTMLTextAreaElement>('review').value = '';
  if (data.done === 'body') { editingBody = false; if (current) render(current); }
  if (data.done === 'composer') {
    sending.delete('composer');
    const path = composer?.path;
    composer = undefined;
    save();
    renderFiles([path]);
  }
  if (data.done?.startsWith('reply:')) {
    const id = data.done.slice(6);
    sending.delete(data.done);
    replies.delete(id);
    save();
    renderFiles([allThreads().find((thread) => thread.id === id)?.path]);
  }
  if (data.idle) setBusy(false);
}

for (const [id, action] of [['pr', 'pr'], ['log', 'log'], ['retry', 'retry'], ['refresh', 'refresh'], ['remove-worktree', 'remove-worktree']] as const) $(id).addEventListener('click', () => post({ action }));
$('error').addEventListener('click', () => { $('error').textContent = ''; });
document.addEventListener('pointerdown', (event) => { if (!(event.target instanceof Node && $('notice').contains(event.target))) clearNotice(); });
window.addEventListener('keydown', (event) => { if (event.key === 'Escape') clearNotice(); });
document.addEventListener('mousemove', (event) => {
  pointer = event;
  if (event.metaKey || event.ctrlKey) probeAt(event);
  else if (hovered) { hovered = undefined; showLink(); }
});
document.addEventListener('click', (event) => {
  if (!(event.metaKey || event.ctrlKey)) return;
  const cell = closestTo(event, 'td.code[data-line]');
  if (!cell) return;
  const column = columnAt(cell, event);
  const target = lookupTarget(cell);
  if (column === undefined || !target) return;
  event.preventDefault();
  $('error').textContent = '';
  post({ action: 'definition', ...target, line: Number(cell.dataset.line), column });
});
for (const type of ['keydown', 'keyup'] as const) {
  window.addEventListener(type, (event) => {
    const held = event.metaKey || event.ctrlKey;
    document.body.classList.toggle('peeking', held);
    if (held && pointer) probeAt(pointer);
    else if (!held) { clearTimeout(probeTimer); hovered = undefined; showLink(); }
  });
}
window.addEventListener('blur', () => { hovered = undefined; showLink(); });
window.addEventListener('keydown', (event) => { if (event.key === 'Escape' && peeks.length && !(event.target instanceof HTMLTextAreaElement)) closePeek(); });
$('peek-close').addEventListener('click', closePeek);
/** Drag the definition panel's left edge to resize it; double-click restores the default width. */
function showPeekWidth(): void {
  if (peekWidth === undefined) document.body.style.removeProperty('--peek-width');
  else document.body.style.setProperty('--peek-width', peekWidth + 'px');
}
showPeekWidth();
$('peek-resize').addEventListener('pointerdown', (event) => {
  if (event.button !== 0) return;
  event.preventDefault();
  const handle = $('peek-resize');
  handle.setPointerCapture(event.pointerId);
  document.body.classList.add('resizing');
  const move = (moved: PointerEvent): void => {
    peekWidth = Math.round(Math.min(window.innerWidth - 16, Math.max(320, window.innerWidth - moved.clientX - 8)));
    showPeekWidth();
  };
  const stop = (): void => {
    handle.removeEventListener('pointermove', move);
    document.body.classList.remove('resizing');
    save();
  };
  handle.addEventListener('pointermove', move);
  handle.addEventListener('pointerup', stop, { once: true });
  handle.addEventListener('pointercancel', stop, { once: true });
});
$('peek-resize').addEventListener('dblclick', () => { peekWidth = undefined; showPeekWidth(); save(); });
$('peek-back').addEventListener('click', () => { if (peekAt > 0) { peekAt -= 1; renderPeek(); } });
$('peek-forward').addEventListener('click', () => { if (peekAt < peeks.length - 1) { peekAt += 1; renderPeek(); } });
$('peek-open').addEventListener('click', () => {
  const peek = peeks[peekAt];
  if (peek) post({ action: 'open-definition', peek: peek.id });
});
$('unified').addEventListener('click', () => { layout = 'unified'; save(); renderFiles(); });
$('split').addEventListener('click', () => { layout = 'split'; save(); renderFiles(); });
for (const name of ['files', 'guide'] as const) $('view-' + name).addEventListener('click', () => { setView(name); });
$('folders').addEventListener('click', () => { folders = !folders; save(); renderFiles(); });
$('analyze').addEventListener('click', () => { $('error').textContent = ''; post({ action: current?.analysis.running ? 'analysis-stop' : 'analyze' }); });
for (const [id, value] of [['collapse', true], ['expand', false]] as const) {
  $(id).addEventListener('click', () => {
    if (view === 'guide') {
      for (const group of guide ?? []) {
        if (!value) collapsed.set(guideState('group', group.key), false);
        for (const step of group.steps) collapsed.set(guideState('step', step.key), value);
      }
    } else {
      for (const file of files ?? []) {
        collapsed.set(file.path, value);
        if (!value) openFolders(file.path);
      }
    }
    save();
    renderFiles();
  });
}
$('toggle-comments').addEventListener('click', () => {
  const open = !document.querySelector('details.thread[open]');
  for (const thread of allThreads()) threadOpen.set(thread.id, open);
  renderFiles();
  showCommentsTip();
});
$('toggle-comments').addEventListener('pointerenter', showCommentsTip);
function showCommentsTip(): void {
  setTip($('toggle-comments'), document.querySelector('details.thread[open]') ? 'Collapse all comments' : 'Expand all comments');
}
for (const review of reviewButtons) {
  review.addEventListener('click', () => {
    $('error').textContent = '';
    setBusy(true);
    post({ action: 'review', event: review.dataset.event as ReviewEvent, body: $<HTMLTextAreaElement>('review').value });
  });
}
$('conflict-send').addEventListener('click', () => {
  const answer = $<HTMLTextAreaElement>('conflict-answer');
  if (!answer.value.trim()) { answer.focus(); return; }
  $('error').textContent = '';
  post({ action: 'fix-conflicts', text: answer.value });
  answer.value = '';
});
$('conflict-cancel').addEventListener('click', () => post({ action: 'dismiss-conflict-question' }));
$('fix-conflicts').addEventListener('click', () => {
  $('error').textContent = '';
  $<HTMLButtonElement>('fix-conflicts').disabled = true;
  post({ action: 'fix-conflicts' });
});
$('edit-title').addEventListener('click', () => changePullRequest({ action: 'edit-title' }));
$('edit-body').addEventListener('click', editBody);
for (const what of ['reviewers', 'assignees', 'labels'] as const) $('pick-' + what).addEventListener('click', () => changePullRequest({ action: 'pick', what }));
$('merge').addEventListener('click', () => {
  $('error').textContent = '';
  setBusy(true);
  post({ action: 'merge', method: $<HTMLSelectElement>('method').value as MergeMethod });
});
window.addEventListener('message', (event: MessageEvent) => {
  const frame = event.source ? [...document.querySelectorAll<HTMLIFrameElement>('iframe.html-preview')].find((node) => node.contentWindow === event.source) : undefined;
  if (frame) frameMessage(frame, event.data);
  else onExtensionMessage(event.data as ExtensionMessage);
});
render(initial.state);
new ResizeObserver(([entry]) => {
  if (entry) document.body.style.setProperty('--bar-height', (entry.target as HTMLElement).offsetHeight + 'px');
}).observe($('files-bar'));
post({ action: 'ready' });
