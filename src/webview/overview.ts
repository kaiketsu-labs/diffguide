import type { DefinitionPeek } from '../definitions.js';
import type { DefinitionTarget, DiffSide, ExtensionMessage, FilePreview, GitHubThreadView, OverviewState, PageMessage } from '../pullRequestOverview.js';
import type { MergeMethod, PullRequestDetails, ReviewEvent } from '../pullRequests.js';
import type { LineRange } from '../reviewedFiles.js';
import type { DiffHunk, DiffLine, FileDiff } from '../unifiedDiff.js';

declare function acquireVsCodeApi(): { postMessage(message: PageMessage): void; getState(): unknown; setState(state: Saved): void };

type Layout = 'unified' | 'split';
type Intent = 'ask' | 'implement';
interface Composer { path: string; side: DiffSide; start: number; end: number; text: string; intent: Intent; target?: 'claude' | 'github' }
interface Saved {
  readonly layout?: Layout;
  readonly collapsed?: Record<string, boolean>;
  readonly previewing?: readonly string[];
  readonly composer?: Composer | undefined;
  readonly replies?: Record<string, string>;
}
type Thread = (OverviewState['threads'][number] & { readonly source: 'local'; readonly pending?: never; readonly outdated?: never })
  | (GitHubThreadView & { readonly source: 'github' });
type Message = Thread['messages'][number];
type Preview = FilePreview & { readonly path: string };
/** A read range, or a selection about to become one. */
type MarkedRange = LineRange & { readonly id?: string };
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
const initial = JSON.parse($('initial').textContent ?? '') as { readonly state: OverviewState; readonly claudeIcon: string };
const { claudeIcon } = initial;
const saved = (api.getState() ?? {}) as Saved;
const nonce = document.currentScript?.nonce ?? '';
let layout: Layout = saved.layout ?? 'unified';
const collapsed = new Map(Object.entries(saved.collapsed ?? {}));
const previewing = new Set(saved.previewing ?? []);
const previews = new Map<string, Preview>();
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
const reviewButtons = [...document.querySelectorAll<HTMLButtonElement>('[data-event]')];
const labels: Record<ReviewerState | CheckState, readonly [string, string, string]> = {
  approved: ['✓', 'ok', 'Approved'], changes: ['✗', 'bad', 'Requested changes'], commented: ['●', 'muted', 'Commented'],
  dismissed: ['○', 'muted', 'Dismissed'], requested: ['○', 'wait', 'Review requested'],
  success: ['✓', 'ok', 'Passed'], failure: ['✗', 'bad', 'Failed'], pending: ['●', 'wait', 'Running'], neutral: ['○', 'muted', 'Skipped'],
};
const methodLabels: Record<MergeMethod, string> = { squash: 'Squash and merge', merge: 'Create a merge commit', rebase: 'Rebase and merge' };
const changeLetters: Record<FileDiff['change'], string> = { added: 'A', modified: 'M', deleted: 'D', renamed: 'R' };
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
  api.setState({ layout, collapsed: Object.fromEntries(collapsed), previewing: [...previewing], composer, replies: Object.fromEntries(replies) });
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
  $('subtitle').textContent = state.subtitle;
  const { details } = state;
  const body = $('body');
  if (!details) body.replaceChildren(el('span', 'muted', state.detailsError ? 'Could not load from GitHub: ' + state.detailsError : 'Loading from GitHub…'));
  else if (details.bodyHtml.trim()) body.innerHTML = details.bodyHtml;
  else body.replaceChildren(el('span', 'muted', 'No description.'));
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
  const reviewed = $('reviewed');
  reviewed.replaceChildren();
  if (state.reviewed) {
    const wrap = el('div', 'bar-wrap');
    const fill = el('span');
    fill.style.width = (state.reviewed.total ? 100 * state.reviewed.done / state.reviewed.total : 0) + '%';
    wrap.append(fill);
    reviewed.append(wrap, el('span', '', state.reviewed.done + '/' + state.reviewed.total + ' viewed'));
  }
  const claude = $('claude');
  claude.textContent = state.claude.text;
  claude.className = state.claude.running ? 'spin muted' : 'muted';
  $('retry').hidden = !state.claude.retry;
  const threads = allThreads();
  $('threads-title').textContent = 'Threads (' + threads.length + ')';
  const list = $('threads');
  list.replaceChildren();
  if (threads.length === 0) list.append(el('li', 'muted', state.github || state.githubError ? 'No comments yet.' : 'No local comments yet. Loading GitHub comments…'));
  if (state.githubError) list.append(el('li', 'bad', 'Could not load GitHub comments: ' + state.githubError));
  for (const thread of threads) {
    const item = el('li', 'card-thread ' + thread.source);
    const head = el('div', 'row');
    const where = el('a', 'where', thread.location);
    where.addEventListener('click', () => jump(thread));
    head.append(el('span', 'tag', thread.source === 'github' ? 'GitHub' : 'Local'), where, el('span', 'text', thread.text));
    const line = el('div', 'muted', thread.status);
    if (thread.url) {
      const link = el('a', '', ' ↗');
      link.title = 'Open on GitHub';
      link.addEventListener('click', () => post({ action: 'github', id: thread.id }));
      line.append(link);
    }
    item.append(head, line);
    list.append(item);
  }
  author = !details || details.viewerIsAuthor;
  setBusy(busy);
  for (const review of document.querySelectorAll<HTMLButtonElement>('[data-reviewer]')) review.title = author ? 'GitHub does not let you approve or request changes on your own PR.' : '';
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
  $('merge-box').hidden = !details?.open || !details.mergeMethods.length;
  if (details) {
    const select = $<HTMLSelectElement>('method');
    const chosen = select.value;
    select.replaceChildren(...details.mergeMethods.map((method) => {
      const option = el('option', '', methodLabels[method]);
      option.value = method;
      return option;
    }));
    if (details.mergeMethods.some((method) => method === chosen)) select.value = chosen;
    $('mergeable').textContent = details.mergeable === 'no' ? 'Has conflicts with the base branch.' : details.mergeable === 'unknown' ? 'GitHub is still checking for conflicts.' : '';
  }
  const next = new Set(state.viewed);
  for (const path of next) if (!viewed.has(path)) collapsed.set(path, true);
  for (const path of viewed) if (!next.has(path)) collapsed.set(path, false);
  viewed = next;
  save();
  readRanges = state.read;
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
    composer = { path, side, start: line, end: line, text: composer?.text ?? '', intent: composer?.intent ?? 'ask', target: composer?.target ?? 'claude' };
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
  const toggle = el('span', 'switch');
  for (const [value, label] of [['claude', 'Claude'], ['github', 'GitHub']] as const) {
    const on = draft.target === value || (!draft.target && value === 'claude');
    const option = button(label, () => { draft.target = value; focusNext = 'composer'; save(); renderFiles([draft.path]); }, on ? 'on' : '');
    option.setAttribute('aria-pressed', String(on));
    toggle.append(option);
  }
  head.append(el('span', 'tag', 'New comment'), toggle, el('span', 'muted', github ? 'everyone on the PR sees it' : 'only you and Claude see it'),
    el('span', 'muted', (draft.side === 'old' ? 'Base · ' : '') + range(draft.start, draft.end)));
  box.append(head);
  const cancel = (): void => { composer = undefined; save(); renderFiles([draft.path]); };
  const send = (pending: boolean): void => {
    if (!draft.text.trim() || sending.has('composer')) return;
    sending.add('composer');
    sentPending = pending;
    $('error').textContent = '';
    renderFiles([draft.path]);
    const where = { form: 'composer', path: draft.path, side: draft.side, startLine: draft.start, endLine: draft.end, text: draft.text } as const;
    post(github ? { action: 'github-comment', pending, ...where } : { action: 'comment', intent: draft.intent, ...where });
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
    row.append(review, now, reviewing ? el('span', 'hint', 'Your review is in progress, so comments go into it.') : hint('adds to review'), el('span', 'gap'), cancelLink);
  } else {
    const intent = el('select');
    intent.setAttribute('aria-label', 'What Claude should do');
    for (const [value, label] of [['ask', 'Ask a question'], ['implement', 'Ask for a change']] as const) {
      const option = el('option', '', label);
      option.value = value;
      intent.append(option);
    }
    intent.value = draft.intent;
    intent.addEventListener('change', () => { draft.intent = intent.value as Intent; save(); });
    const ask = button(busySending ? 'Sending…' : 'Ask Claude', submit, 'primary');
    ask.disabled = busySending;
    row.append(intent, ask, hint('sends'), el('span', 'gap'), cancelLink);
  }
  head.append(read);
  box.append(area, row);
  return box;
}

function message(entry: Message): HTMLElement {
  const item = el('div', 'msg');
  const who = el('div', 'who');
  const github = 'avatarUrl' in entry;
  if (!github && entry.author === 'claude' && claudeIcon) {
    const icon = el('img');
    icon.src = claudeIcon;
    icon.alt = '';
    who.append(icon);
  }
  if (github && entry.avatarUrl) {
    const avatar = el('img', 'avatar');
    avatar.src = entry.avatarUrl;
    avatar.alt = '';
    who.append(avatar);
  }
  who.append(github ? entry.author : entry.author === 'claude' ? 'Claude' : 'You');
  if (github && entry.pending) who.append(el('span', 'pill', 'Pending'));
  const body = el('div', 'msg-text');
  body.innerHTML = entry.html;
  item.append(who, body);
  return item;
}

function strip<K extends keyof HTMLElementTagNameMap>(tag: K, label: string, note: string, right: string): HTMLElementTagNameMap[K] {
  const node = el(tag, 'strip');
  node.append(el('span', 'tag', label), el('span', 'muted', note), el('span', 'muted', right));
  return node;
}

function threadBox(thread: Thread): HTMLElement {
  const github = thread.source === 'github';
  const box = el('details', 'thread ' + thread.source + (thread.pending ? ' pending' : ''));
  box.id = 'thread-' + thread.id;
  box.open = threadOpen.get(thread.id) ?? !thread.resolved;
  box.addEventListener('toggle', () => threadOpen.set(thread.id, box.open));
  const suffix = thread.pending ? (thread.outdated ? ' · Outdated' : '') : ' · ' + thread.status;
  box.append(strip('summary', github ? 'GitHub' : 'Local',
    github ? (thread.pending ? 'only you see it until you submit your review' : 'everyone on the PR sees it') : 'only you and Claude see it',
    (thread.side === 'old' ? 'Base · ' : '') + range(thread.startLine, thread.endLine) + suffix));
  for (const entry of thread.messages) box.append(message(entry));
  const key = 'reply:' + thread.id;
  const actions = el('div', 'row actions');
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
    const send = button(sending.has(key) ? 'Sending…' : github ? 'Post on GitHub' : 'Reply', submit, 'primary');
    send.disabled = sending.has(key);
    actions.append(send, button('Cancel', cancel));
  } else if (!thread.resolved) actions.append(button('Reply', () => { replies.set(thread.id, ''); focusNext = key; save(); renderFiles([thread.path]); }));
  actions.append(button(thread.resolved ? 'Reopen' : 'Resolve', () => post({ action: github ? 'github-resolve' : 'resolve', id: thread.id, resolved: !thread.resolved })));
  actions.append(thread.url
    ? button('Open on GitHub ↗', () => post({ action: 'github', id: thread.id }))
    : button('Publish to GitHub…', () => post({ action: 'publish', id: thread.id })));
  box.append(actions);
  return box;
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
  if (collapsed.get(thread.path)) { collapsed.set(thread.path, false); save(); renderFiles([thread.path]); }
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

function expand(file: FileDiff, index: number, top: number, bottom: number): void {
  const shown = expansion(file.path, index);
  const byFile = expanded.get(file.path) ?? new Map<number, Shown>();
  expanded.set(file.path, byFile);
  byFile.set(index, { top: shown.top + top, bottom: shown.bottom + bottom });
  loadContext(file);
  renderFiles([file.path]);
}

function previewKind(file: FileDiff): 'markdown' | 'html' | undefined {
  if (file.binary || file.change === 'deleted') return undefined;
  return /\.(md|markdown)$/iu.test(file.path) ? 'markdown' : /\.html?$/iu.test(file.path) ? 'html' : undefined;
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

/** Diff lines inside read ranges, with the ids of the ranges covering each; marking added lines also covers the lines they replace, and the reverse. */
function readLines(file: FileDiff, ranges: readonly MarkedRange[]): Map<DiffLine, string[]> {
  const lines = file.hunks.flatMap((hunk) => hunk.lines);
  const read = new Map<DiffLine, string[]>();
  for (const marked of ranges) {
    if (marked.path !== file.path) continue;
    const key = marked.side === 'old' ? 'oldLine' : 'newLine';
    let first = -1;
    let last = -1;
    lines.forEach((line, index) => {
      const number = line[key];
      if (number !== undefined && number >= marked.startLine && number <= marked.endLine) {
        if (first < 0) first = index;
        last = index;
      }
    });
    if (first < 0) continue;
    if (marked.side === 'new' && lines[first]?.kind === 'add') while (first > 0 && lines[first - 1]?.kind === 'del') first--;
    if (marked.side === 'old' && lines[last]?.kind === 'del') while (last < lines.length - 1 && lines[last + 1]?.kind === 'add') last++;
    for (const line of lines.slice(first, last + 1)) {
      const ids = read.get(line) ?? [];
      read.set(line, ids);
      if (marked.id) ids.push(marked.id);
    }
  }
  return read;
}

/** Ids of the read ranges covering every selected diff line, or undefined when some selected line is unread. */
function selectedReadIds(file: FileDiff, selection: LineRange): string[] | undefined {
  const read = readLines(file, readRanges);
  const key = selection.side === 'old' ? 'oldLine' : 'newLine';
  const lines = file.hunks.flatMap((hunk) => hunk.lines).filter((line) => {
    const number = line[key];
    return number !== undefined && number >= selection.startLine && number <= selection.endLine;
  });
  return lines.length > 0 && lines.every((line) => read.has(line)) ? [...new Set(lines.flatMap((line) => read.get(line) ?? []))] : undefined;
}

function fullyRead(file: FileDiff, ranges: readonly MarkedRange[]): boolean {
  const read = readLines(file, ranges);
  return file.hunks.every((hunk) => hunk.lines.every((line) => line.kind === 'context' || read.has(line)));
}

function table(file: FileDiff, threads: readonly Thread[], placed: Set<string>): HTMLTableElement {
  const node = el('table');
  const columns = el('colgroup');
  const widths = layout === 'split' ? ['num', '', 'num', ''] : ['num', 'num', ''];
  for (const name of widths) columns.append(el('col', name));
  node.append(columns);
  const draft = composer?.path === file.path ? composer : undefined;
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
    const label = el('span', 'read-label', (open ? '▾ ' : '▸ ') + '✓ ' + lines.length + (lines.length === 1 ? ' line read' : ' lines read'));
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
    const shown = expansion(file.path, index);
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
      if (hidden <= step && !gap.last) tool('↕', 'Show ' + hidden + ' hidden lines', () => expand(file, index, hidden, 0));
      else {
        if (index > 0) tool('↓', 'Show ' + step + ' more lines below', () => expand(file, index, step, 0));
        if (!gap.last) tool('↑', 'Show ' + step + ' more lines above', () => expand(file, index, 0, step));
      }
      cell.append(tools);
    }
    if (header) cell.append(el('span', '', header));
    else if (hidden > 0) cell.append(el('span', '', Number.isFinite(hidden) ? hidden + ' more lines' : 'Rest of the file'));
    if (hidden > 0 || (header && size <= 0)) node.append(row);
  };
  const gapRows = (gap: Gap, index: number, header?: string): void => {
    const size = gap.to - gap.from + 1;
    const shown = expansion(file.path, index);
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

/** Redraw the file list; given paths, or 'state' for files whose state changed, redraw only those boxes when the rest are on the page. */
function renderFiles(only?: readonly (string | undefined)[] | 'state'): void {
  $('unified').className = layout === 'unified' ? 'on' : '';
  $('split').className = layout === 'split' ? 'on' : '';
  if (!files) return;
  const shownFiles = files;
  const container = $('files');
  const scroll = window.scrollY;
  const active = document.activeElement;
  const focus = active instanceof HTMLTextAreaElement && active.dataset.draft ? { key: active.dataset.draft, start: active.selectionStart, end: active.selectionEnd } : undefined;
  const threadsByFile = new Map<string, Thread[]>();
  for (const thread of allThreads()) {
    const list = threadsByFile.get(thread.path) ?? [];
    threadsByFile.set(thread.path, list);
    list.push(thread);
  }
  $('files-title').textContent = 'Files (' + shownFiles.length + ') · ' + shownFiles.filter((file) => viewed.has(file.path)).length + ' viewed';
  const boxes = new Map([...container.querySelectorAll<HTMLElement>(':scope > .file')].map((node) => [node.dataset.path, node]));
  const threadsOf = (path: string): Thread[] => threadsByFile.get(path) ?? [];
  const changed = only === 'state' ? shownFiles.map((file) => file.path).filter((path) => fileKeys.get(path) !== fileKey(path, threadsOf(path))) : only;
  const targets = changed && boxes.size === shownFiles.length ? [...new Set(changed.filter((path): path is string => path !== undefined))] : undefined;
  const draw = (file: FileDiff): HTMLElement => {
    fileKeys.set(file.path, fileKey(file.path, threadsOf(file.path)));
    return fileBox(file, threadsOf(file.path));
  };
  if (targets?.every((path) => boxes.has(path))) {
    for (const path of targets) {
      const file = shownFiles.find((item) => item.path === path);
      if (file) boxes.get(path)?.replaceWith(draw(file));
    }
  } else {
    container.replaceChildren();
    fileKeys.clear();
    if (!shownFiles.length) container.append(el('p', 'muted', 'No changes against the base branch.'));
    for (const file of shownFiles) container.append(draw(file));
  }
  for (const frame of container.querySelectorAll<HTMLIFrameElement>('iframe.html-preview')) layoutMargin(frame, frameTops.get(frame.dataset.path ?? '') ?? {});
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

function fileBox(file: FileDiff, threads: readonly Thread[]): HTMLElement {
  const isCollapsed = collapsed.get(file.path) === true;
  const box = el('div', 'file' + (isCollapsed ? ' collapsed' : ''));
  box.dataset.path = file.path;
  const head = el('div', 'file-head');
  const chevron = el('span', 'chevron', isCollapsed ? '▸' : '▾');
  const name = el('span', 'name', file.oldPath ? file.oldPath + ' → ' + file.path : file.path);
  const toggle = (): void => { collapsed.set(file.path, !isCollapsed); save(); renderFiles([file.path]); };
  chevron.addEventListener('click', toggle);
  name.addEventListener('click', toggle);
  const badge = el('span', 'badge ' + file.change, changeLetters[file.change]);
  badge.title = file.change;
  const stats = el('span', '');
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
  const showPreview = kind !== undefined && previewing.has(file.path);
  full.hidden = showPreview || file.binary || file.change === 'added' || file.change === 'deleted' || !file.hunks.length;
  const mode = el('span', 'seg');
  mode.hidden = kind === undefined;
  for (const [text, on] of [['Diff', false], ['Preview', true]] as const) {
    const option = button(text, () => {
      if (on) previewing.add(file.path);
      else previewing.delete(file.path);
      save();
      renderFiles([file.path]);
    });
    option.className = showPreview === on ? 'on' : '';
    mode.append(option);
  }
  const unresolved = threads.filter((thread) => !thread.resolved).length;
  const comments = el('span', 'muted comments', !threads.length ? '' : threads.length + (threads.length === 1 ? ' comment' : ' comments') + (unresolved === threads.length ? '' : ', ' + unresolved + ' open'));
  head.append(chevron, name, badge, stats, comments, mode, label, full, open);
  box.append(head);
  const diff = el('div', 'diff');
  const placed = new Set<string>();
  if (file.binary) diff.append(el('div', 'note muted', 'Binary file not shown.'));
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
  $('peek-title').textContent = peek.location;
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

function onExtensionMessage(data: ExtensionMessage): void {
  if (data.state) render(data.state);
  if (data.files) { files = data.files; contextLines.clear(); loading.clear(); renderFiles(); }
  if (data.preview) { previews.set(data.preview.path, data.preview); loading.delete('preview:' + data.preview.path); renderFiles([data.preview.path]); }
  if (data.context) { contextLines.set(data.context.path, data.context.lines); loading.delete(data.context.path); renderFiles([data.context.path]); }
  if (data.definition) { peeks.length = peekAt + 1; peeks.push(data.definition); peekAt = peeks.length - 1; renderPeek(); }
  if (data.probe) { probes.set(data.probe.id, data.probe.found); showLink(); }
  if (data.reveal && files) {
    collapsed.set(data.reveal, false);
    save();
    renderFiles();
    document.querySelector('[data-path="' + CSS.escape(data.reveal) + '"]')?.scrollIntoView({ block: 'start' });
  }
  if (data.filesError) $('files').replaceChildren(el('p', 'bad', 'Could not read the changes: ' + data.filesError));
  if (data.error) {
    loading.clear();
    $('error').textContent = data.error;
    if (data.form && sending.delete(data.form)) renderFiles();
  }
  if (data.done === 'review') $<HTMLTextAreaElement>('review').value = '';
  if (data.done === 'composer') {
    sending.delete('composer');
    const path = composer?.path;
    composer = undefined;
    save();
    renderFiles([path]);
  }
  if (data.done?.startsWith('reply:')) {
    sending.delete(data.done);
    replies.delete(data.done.slice(6));
    save();
    renderFiles();
  }
  if (data.idle) setBusy(false);
}

for (const [id, action] of [['pr', 'pr'], ['log', 'log'], ['retry', 'retry'], ['refresh', 'refresh']] as const) $(id).addEventListener('click', () => post({ action }));
$('error').addEventListener('click', () => { $('error').textContent = ''; });
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
$('peek-back').addEventListener('click', () => { if (peekAt > 0) { peekAt -= 1; renderPeek(); } });
$('peek-forward').addEventListener('click', () => { if (peekAt < peeks.length - 1) { peekAt += 1; renderPeek(); } });
$('peek-open').addEventListener('click', () => {
  const peek = peeks[peekAt];
  if (peek) post({ action: 'open-definition', peek: peek.id });
});
$('unified').addEventListener('click', () => { layout = 'unified'; save(); renderFiles(); });
$('split').addEventListener('click', () => { layout = 'split'; save(); renderFiles(); });
$('collapse').addEventListener('click', () => { for (const file of files ?? []) collapsed.set(file.path, true); save(); renderFiles(); });
$('expand').addEventListener('click', () => { for (const file of files ?? []) collapsed.set(file.path, false); save(); renderFiles(); });
for (const [id, open] of [['collapse-comments', false], ['expand-comments', true]] as const) {
  $(id).addEventListener('click', () => { for (const thread of allThreads()) threadOpen.set(thread.id, open); renderFiles(); });
}
for (const review of reviewButtons) {
  review.addEventListener('click', () => {
    $('error').textContent = '';
    setBusy(true);
    post({ action: 'review', event: review.dataset.event as ReviewEvent, body: $<HTMLTextAreaElement>('review').value });
  });
}
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
