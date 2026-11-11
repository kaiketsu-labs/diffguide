import type { ClaudeProgress, ClaudeStep } from '../claudeRunner.js';
import type { ClaudeConversation } from '../claudeSessions.js';
import { reviewers, type Finding, type Reviewer, type ReviewIntent } from '../contracts.js';
import { reviewerInfo, reviewStages, type DropReason, type ReviewLane, type ReviewLaneItem, type ReviewLive, type ReviewStage, type ReviewUsage } from '../review.js';
import type { DefinitionPeek } from '../definitions.js';
import { buildGuide, groupReadMarks, stepViewed as isStepViewed, type Analysis, type GuideGroup, type GuideStep, type Severity } from '../prAnalysis.js';
import type { DefinitionTarget, DiffRange, DiffSide, ExtensionMessage, FilePreview, GitHubMessageView, GitHubThreadView, OverviewState, PageMessage, PickedSuggestion, PickTarget } from '../pullRequestOverview.js';
import type { LocalChange } from '../conflicts.js';
import type { Annotation, CommentKind, GitHubComment, HideReason, MergeMethod, PickerOptions, PullRequestConversation, PullRequestDetails, ReactionContent, ReactionCount, ReviewEvent, TimelineItem } from '../pullRequests.js';
import { fileTree, type FileFolder } from '../fileTree.js';
import { fullyRead, rangeReadIds, readLines, type MarkedRange } from '../readLines.js';
import type { LineRange } from '../reviewedFiles.js';
import type { DiffHunk, DiffLine, FileDiff } from '../unifiedDiff.js';
import { blockBrowserShortcuts } from '../browserShortcuts.js';
import { icons } from '../icons.js';
import type { FileIcon, FileIcons } from '../fileIcons.js';
import { mediaType, type MediaPreview, type MediaSide } from '../media.js';
import type * as PdfJs from 'pdfjs-dist';
import { orbCanvas, stepMotion, type OrbMotion } from './orb.js';

declare function acquireVsCodeApi(): { postMessage(message: PageMessage): void; getState(): unknown; setState(state: Saved): void };

type Layout = 'unified' | 'split';
/** What the file list shows: every file, the PR's commits, or Claude's guide in reading order. */
type View = 'overview' | 'files' | 'guide';
type Intent = 'ask' | 'implement';
interface Composer { path: string; side: DiffSide; start: number; end: number; text: string; target?: 'claude' | 'github' }
/** A new comment on a whole file, written above its diff. */
interface FileComposer { path: string; text: string; target?: 'claude' | 'github' }
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
  readonly fileComposer?: FileComposer | undefined;
  readonly showArchived?: boolean;
  /** The Files tab shows Claude's guide notes too, not only the Guide tab. */
  readonly guideInFiles?: boolean;
  readonly replies?: Record<string, string>;
  readonly publishing?: Record<string, string>;
  readonly range?: DiffRange;
  readonly whitespace?: boolean;
  readonly filter?: string;
  readonly hideViewed?: boolean;
  readonly hiddenTypes?: readonly string[];
  /** Opened files the user closed; they stay off the page until reopened or a comment shown on the page lands on them. */
  readonly closedFiles?: readonly string[];
  readonly conversationDraft?: string;
  readonly conversationFolded?: boolean;
  /** Collapsed threads leave the diff and show as marks beside their last line. */
  readonly marginThreads?: boolean;
  /** The file list shows every repository file, not only the changes. */
  readonly allFiles?: boolean;
  readonly listHidden?: boolean;
  /** Width of the file list in pixels, when the user resized it. */
  readonly navWidth?: number | undefined;
  /** Height of the comments panel under the file list in pixels, when the user resized it. */
  readonly navThreadsHeight?: number | undefined;
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
const initial = JSON.parse($('initial').textContent ?? '') as { readonly state: OverviewState; readonly pdfScript?: string };
const saved = (api.getState() ?? {}) as Saved;
const nonce = document.currentScript?.nonce ?? '';
let layout: Layout = saved.layout === 'split' ? 'split' : 'unified';
let view: View = saved.view === 'guide' || (saved.view === undefined && saved.layout === 'guided') ? 'guide' : saved.view === 'files' ? 'files' : 'overview';
/** Local pages list every repository file by default; PR pages list the changes. */
let allFiles = saved.allFiles ?? initial.state.localMode === true;
let listHidden = saved.listHidden === true;
let navWidth = saved.navWidth;
let navThreadsHeight = saved.navThreadsHeight;
/** Every file in the repository, for the All files list. */
let repositoryFiles: readonly string[] = [];
let fileIcons: FileIcons | undefined;
/** CSS font families of the icon theme's fonts already added to the page, by font id. */
const iconFonts = new Map<string, string>();
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
/** HTML files whose preview runs the file's own scripts, until the page reloads. */
const scriptedFrames = new Set<string>();
let files: readonly FileDiff[] | undefined;
let viewed = new Set<string>();
let current: OverviewState | undefined;
let readRanges: readonly MarkedRange[] = [];
const openReads = new Set<string>();
const fileKeys = new Map<string, string>();
let composer = saved.composer;
let fileComposer = saved.fileComposer;
let showArchived = saved.showArchived === true;
let guideInFiles = saved.guideInFiles === true;
let marginThreads = saved.marginThreads === true;
/** Archive toggles the page shows before the extension's next state confirms them, by thread id. */
const archiving = new Map<string, boolean>();
const replies = new Map(Object.entries(saved.replies ?? {}));
/** Local threads being posted on GitHub, with the text the user is editing. */
const publishing = new Map(Object.entries(saved.publishing ?? {}));
/** The commits the Files tab shows, as the extension last confirmed them; `wanted` waits for the PR's commits to arrive. */
let diffRange: DiffRange = { kind: 'all' };
let wantedRange: DiffRange | undefined = saved.range?.kind === 'all' ? undefined : saved.range;
let whitespace = saved.whitespace === true;
/** The diff's new side is the PR's latest version, so lines can take comments and show context. */
let atHead = true;
let fileFilter = saved.filter ?? '';
let hideViewed = saved.hideViewed === true;
const hiddenTypes = new Set(saved.hiddenTypes ?? []);
const closedFiles = new Set(saved.closedFiles ?? []);
/** The open menu under a Files toolbar button: the range or the file filter. */
let toolbarMenu: { readonly anchor: string; readonly node: HTMLElement } | undefined;
let conversationDraft = saved.conversationDraft ?? '';
let conversationFolded = saved.conversationFolded === true;
/** Whether the Conversation card shows its older entries; it shows only the latest ones on long PRs. */
let conversationAll = false;
const recentEntries = 6;
/** Comment edits in progress, by comment id. */
const edits = new Map<string, string>();
/** Notes for the agent being written under a conversation comment, by comment id. */
const commentAsks = new Map<string, string>();
/** Hidden comments the viewer chose to read anyway. */
const revealed = new Set<string>();
/** Forms showing their Preview tab, and GitHub's rendering of the text each last previewed. */
const previewTabs = new Set<string>();
const renderedPreviews = new Map<string, { readonly text: string; readonly html?: string }>();
/** GitHub suggestions picked to commit together, by comment id. */
const batch = new Map<string, PickedSuggestion>();
/** The commit a Shift-click range starts from in the Commits tab. */
let rangeAnchor: string | undefined;
let emojiFor: string | undefined;
/** The open merge form; its button confirms on the next click, after `openedAt` plus a double-click's time. */
let mergeForm: { readonly auto: boolean; readonly openedAt: number } | undefined;
let mergeMethod: MergeMethod = 'squash';
/** A question that waits for its confirm button in place of what asked it; `redraw` draws that place. */
interface Ask { readonly key: string; readonly question: string; readonly label: string; send(): void; redraw(): void }
let asking: Ask | undefined;
/** The reviewer whose review the dismiss form is open for, and the reason typed so far. */
let dismissing: { readonly login: string; text: string } | undefined;
let reviewersStamp = '';
const sending = new Set<string>();
const threadOpen = new Map<string, boolean>();
/** A thread opened from its margin mark, to take focus once its file is redrawn. */
let focusThread: string | undefined;
/** Threads whose earlier messages the user showed. */
const threadUnfolded = new Set<string>();
/** Threads longer than this show only their latest `unfoldedMessages` until unfolded. */
const foldThreadsAbove = 4;
const unfoldedMessages = 3;
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
const stateShapes = { done: icons.check, failed: icons.close, active: icons.dot, idle: icons.circle } as const;
type StateShape = keyof typeof stateShapes;
const labels: Record<ReviewerState | CheckState, readonly [StateShape, string, string]> = {
  approved: ['done', 'ok', 'Approved'], changes: ['failed', 'bad', 'Requested changes'], commented: ['active', 'muted', 'Commented'],
  dismissed: ['idle', 'muted', 'Dismissed'], requested: ['idle', 'wait', 'Review requested'],
  success: ['done', 'ok', 'Passed'], failure: ['failed', 'bad', 'Failed'], pending: ['active', 'wait', 'Running'], neutral: ['idle', 'muted', 'Skipped'],
};
/** Checks show their state by icon alone; reviewers keep the word, since requested and dismissed share an icon. */
const checkStates: ReadonlySet<string> = new Set<CheckState>(['success', 'failure', 'pending', 'neutral']);
const methodLabels: Record<MergeMethod, string> = { squash: 'Squash and merge', merge: 'Create a merge commit', rebase: 'Rebase and merge' };
const hideReasons: readonly (readonly [HideReason, string])[] = [['OUTDATED', 'Outdated'], ['RESOLVED', 'Resolved'], ['DUPLICATE', 'Duplicate'], ['OFF_TOPIC', 'Off-topic'],
  ['LOW_QUALITY', 'Low quality'], ['SPAM', 'Spam'], ['ABUSE', 'Abuse']];
const changeLetters: Record<FileDiff['change'], string> = { added: 'A', modified: 'M', deleted: 'D', renamed: 'R', unchanged: '' };
const severityLabels: Record<Severity | 'unclassified', string> = { critical: 'Critical', significant: 'Significant', routine: 'Routine', trivial: 'Trivial', unclassified: 'Unclassified' };
let guide: GuideGroup[] | undefined;
let guideStamp = '';
const stepKeys = new Map<string, string>();
const verdictText = { changes: ['bad', 'Changes requested by '], approved: ['ok', 'Approved by '], commented: ['muted', 'Commented: '] } as const;

/**
 * Runs inside the HTML preview frame: reports clicks as source lines, and where commented elements sit.
 * The page injects its source text, so it must not use anything from outside its own body.
 * With `scripts` the file's own scripts run too, and clicks on its controls go to them instead of commenting.
 */
function frameMain(scripts: boolean): void {
  interface FrameAnchor { readonly key: string; readonly start: number; readonly end: number; readonly source: string; node?: Element }
  const lines = (node: Element): [number, number] => {
    const [start = Number.NaN, end = Number.NaN] = ((node as HTMLElement).dataset.lrLines ?? '').split('-').map(Number);
    return [start, end];
  };
  const control = (event: Event): boolean => scripts && event.target instanceof Element && event.target.closest('a[href],button,input,select,textarea,label,summary,[role=button],[role=link],[role=tab]') !== null;
  const target = (event: Event): Element | null => (event.target instanceof Element && !control(event) ? event.target.closest('[data-lr-lines]') : null);
  const style = document.createElement('style');
  style.textContent = '[data-lr-hover]{outline:2px dashed #0078d4!important;outline-offset:1px;cursor:pointer!important}'
    + '[data-lr-sel]{outline:2px solid #0078d4!important;outline-offset:1px;background-color:rgba(0,120,215,.12)!important}'
    + '[data-lr-anchor=local]{outline:2px solid rgba(209,134,22,.75)!important;outline-offset:1px}[data-lr-anchor=github]{outline:2px solid rgba(55,148,255,.75)!important;outline-offset:1px}'
    + '[data-lr-focus]{outline-width:3px!important;background-color:rgba(128,128,128,.15)!important}';
  document.head.append(style);
  if (scripts) {
    // A sandboxed srcdoc frame has an opaque origin, where Chromium throws on any history URL change.
    for (const name of ['pushState', 'replaceState'] as const) {
      const original = History.prototype[name];
      History.prototype[name] = function (this: History, ...args: Parameters<History['pushState']>): void {
        try { original.apply(this, args); } catch { /* the frame keeps its URL */ }
      };
    }
  }
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
    if (control(event)) return;
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
    if ('select' in data) for (const node of document.querySelectorAll('[data-lr-sel]')) node.removeAttribute('data-lr-sel');
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
  api.setState({ layout, view, peekWidth, folders, collapsed: Object.fromEntries(collapsed), previewing: [...previewing], composer, fileComposer, showArchived, guideInFiles, replies: Object.fromEntries(replies), publishing: Object.fromEntries(publishing),
    range: wantedRange ?? diffRange, whitespace, filter: fileFilter, hideViewed, hiddenTypes: [...hiddenTypes], closedFiles: [...closedFiles], conversationDraft, conversationFolded, marginThreads, allFiles, listHidden, navWidth, navThreadsHeight });
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

const elapsed = (since: number, until = Date.now()): string => {
  const seconds = Math.max(0, Math.floor((until - since) / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
};

type StepPick = (step: ClaudeStep) => readonly [OrbMotion, (number | undefined)?];

/** A run's orb motion per step: it wakes as the run starts, then follows the step's verb. */
const runMotion = (progress: ClaudeProgress): StepPick => (step) =>
  progress.steps.length === 0 ? ['wake', performance.now() - (Date.now() - progress.startedAt)] : [stepMotion(step.verb)];

/** When each thread's current waiting or pickup state began, so its orb plays the change once; threads already in that state when the page opened skip it. */
const workingSince = new Map<string, { readonly working: string; readonly since: number }>();
function noteWorking(before: OverviewState | undefined, state: OverviewState): void {
  const live = new Set<string>();
  for (const { id, working } of state.threads) {
    if (working === undefined) continue;
    live.add(id);
    if (workingSince.get(id)?.working !== working) workingSince.set(id, { working, since: before === undefined ? -Infinity : performance.now() });
  }
  for (const id of workingSince.keys()) if (!live.has(id)) workingSince.delete(id);
}

/** The orb for a thread that waits for Claude: it dozes off while nothing will pick the comment up, and nods once Claude does. */
const waitMotion = (id: string): StepPick => ({ verb }) => {
  const since = workingSince.get(id)?.since;
  if (verb === 'Picked up') return ['nod', since];
  if (verb === 'Waiting for Claude' && !(current?.claude.link?.delivering ?? current?.claude.running)) return ['doze', since];
  return [stepMotion(verb)];
};

/** Claude's latest steps like a Claude Code transcript, oldest first: a check on finished ones, the orb, the run's time and `stop` on the current one. */
function stepLog(steps: readonly ClaudeStep[], startedAt?: number, stop?: HTMLElement, pick: StepPick = ({ verb }) => [stepMotion(verb)], orb = true, phase = 0): HTMLElement {
  const log = el('div', 'step-log');
  const shown = steps.length > 0 ? steps : [{ verb: 'Starting', done: false }];
  shown.forEach((step, index) => {
    const row = el('div', 'step' + (step.done ? ' done' : '') + (step.failed ? ' failed' : ''));
    const [motion, since] = pick(step);
    row.append(step.done ? stateIcon(step.failed ? 'failed' : 'done', 'mark') : orb ? orbCanvas('step', motion, since, phase) : stateIcon('active', 'agent'));
    const title = el('span', 'step-call');
    title.append(el('b', '', step.verb), step.target === undefined ? '' : `(${step.target})`);
    row.append(title);
    if (startedAt !== undefined && index === shown.length - 1) {
      const time = el('span', 'time', elapsed(startedAt));
      time.dataset.since = String(startedAt);
      row.append(time);
    }
    if (stop !== undefined && index === shown.length - 1) row.append(stop);
    if (step.detail) row.append(el('span', 'detail', step.detail));
    log.append(row);
  });
  return log;
}

function button(label: string, onClick: () => void, className?: string): HTMLButtonElement {
  const node = el('button', className ?? '');
  setLabel(node, label);
  node.addEventListener('click', onClick);
  return node;
}

/** A button that sends to the agent: filled slate for the row's main action, outlined slate otherwise. */
function agentButton(intent: 'ask' | 'implement' | 'draft', label: string, onClick: () => void, filled = intent === 'ask'): HTMLButtonElement {
  const node = button(label, onClick, filled ? 'agent' : 'agent-outline');
  node.replaceChildren(icon(intent === 'ask' ? icons.agentAsk : intent === 'draft' ? icons.agentDraft : icons.agentImplement), label);
  return node;
}

/** The icon for a text button, by the first two words of its label or else the first. */
const labelIcons: Readonly<Record<string, string>> = {
  Cancel: icons.close, Save: icons.check, Comment: icons.comment, Update: icons.check, Post: icons.send, Add: icons.send, Approve: icons.check, Request: icons.requestChanges,
  Discard: icons.trash, Delete: icons.trash, Dismiss: icons.close, Show: icons.show, Hide: icons.hidden, Merge: icons.merge, Confirm: icons.check, Enable: icons.merge, Disable: icons.close,
  Remove: icons.close, 'Update branch': icons.sync, Push: icons.push, Link: icons.link, Unlink: icons.unlink, Open: icons.openExternal, Commit: icons.commit, Apply: icons.check,
  Suggest: icons.suggest, Clear: icons.close, Unmark: icons.close, Retry: icons.sync, Ready: icons.ready, Close: icons.closePullRequest, Reopen: icons.reopen, Build: icons.agentGuide, Rebuild: icons.agentGuide,
  Stop: icons.stop, Fix: icons.agentFix, Convert: icons.edit, Restore: icons.reopen, Revert: icons.reopen, Publish: icons.github, Full: icons.fullFile, Diff: icons.file, Find: icons.search, Mark: icons.ready, 'Show all': icons.show,
};

/** Sets a button's label, led by its icon from `labelIcons`. */
function setLabel(node: HTMLElement, label: string): void {
  const words = label.split(' ');
  const svg = labelIcons[words.slice(0, 2).join(' ')] ?? labelIcons[words[0] ?? ''];
  node.replaceChildren(...svg === undefined ? [] : [icon(svg)], label);
}

/** Sets a node's tooltip and returns the node. */
function titled<T extends HTMLElement>(node: T, tip: string): T {
  node.title = tip;
  return node;
}

/** A text button led by `svg` instead of its label's icon. */
function iconButton(svg: string, label: string, onClick: () => void, className?: string): HTMLButtonElement {
  const node = button(label, onClick, className);
  node.replaceChildren(icon(svg), label);
  return node;
}

function icon(svg: string): Element {
  const template = document.createElement('template');
  template.innerHTML = svg;
  return template.content.firstElementChild as Element;
}

/** A state icon colored by `tone`; `label` names the state for screen readers and on hover. */
function stateIcon(shape: StateShape, tone: string, label?: string): HTMLElement {
  const node = el('span', 'state-icon ' + tone);
  node.append(icon(stateShapes[shape]));
  if (label !== undefined) {
    node.title = label;
    node.setAttribute('role', 'img');
    node.setAttribute('aria-label', label);
  }
  return node;
}

/** Your open PR from the local page's branch; clicking turns this tab into its review page. */
function pullRequestChip({ number, title }: NonNullable<OverviewState['branchPullRequest']>): HTMLButtonElement {
  const chip = button('', () => post({ action: 'open-pr' }), 'small pr-chip');
  chip.append(icon(icons.github), 'PR #' + number);
  chip.dataset.tip = 'Review #' + number + ' ' + title + ' in this tab';
  return chip;
}

/** A branch name that copies itself, like GitHub's. */
function branchRef(name: string): HTMLButtonElement {
  return copyRef(name, name, 'branch name');
}

/** A chip showing `text` that copies `value`; `what` names the value in its tooltip and error. */
function copyRef(text: string, value: string, what: string): HTMLButtonElement {
  const ref = el('button', 'ref');
  ref.title = 'Copy ' + what;
  const copy = icon(icons.copy);
  copy.classList.add('copy');
  const done = icon(icons.check);
  done.classList.add('done');
  ref.append(text, copy, done);
  ref.addEventListener('click', () => {
    void navigator.clipboard.writeText(value).then(() => {
      ref.classList.add('copied');
      setTimeout(() => ref.classList.remove('copied'), 1500);
    }, () => { $('error').textContent = 'Could not copy the ' + what + '.'; });
  });
  return ref;
}

function closestTo<T extends Element = HTMLElement>(event: Event, selector: string): T | null {
  return event.target instanceof Element ? event.target.closest<T>(selector) : null;
}

function status(key: ReviewerState | CheckState, name: string, url?: string, tools: readonly HTMLElement[] = []): HTMLLIElement {
  const item = el('li', 'row');
  const [shape, tone, label] = labels[key];
  item.append(stateIcon(shape, tone, label));
  if (url) {
    const link = el('a', '', name);
    link.href = url;
    item.append(link);
  } else item.append(el('span', '', name));
  if (!checkStates.has(key)) item.append(el('span', 'muted', label));
  if (tools.length) {
    const box = el('span', 'reviewer-tools');
    box.append(...tools);
    item.append(box);
  }
  return item;
}

function setBusy(value: boolean): void {
  busy = value;
  for (const review of reviewButtons) review.disabled = value || (author && review.hasAttribute('data-reviewer'));
  const merge = current?.conversation?.merge;
  $<HTMLButtonElement>('merge').disabled = value || current?.details?.mergeable === 'no' || (merge?.state === 'blocked' && !merge.canBypass && !merge.mergeQueue);
  for (const action of document.querySelectorAll<HTMLButtonElement>('[data-pr-action]')) action.disabled = value;
}

/** Send a change to the PR on GitHub; the page stays busy until the extension answers. */
function changePullRequest(message: PageMessage): void {
  $('error').textContent = '';
  setBusy(true);
  post(message);
}

/** One row of a picker; `key` keeps a user and a team with the same name apart. */
interface PickerItem { readonly key: string; readonly text: string; readonly note?: string; readonly color?: string; readonly description?: string }
/** The open reviewer, assignee or label picker; it saves on close when `selected` differs from `initial`. */
interface Picker { readonly what: PickTarget; readonly initial: ReadonlySet<string>; readonly selected: Set<string>; readonly node: HTMLElement; readonly list: HTMLElement }
let picker: Picker | undefined;
let pickerOptions: PickerOptions | undefined;
let pickerError: string | undefined;
const pickerPlaceholders: Record<PickTarget, string> = { reviewers: 'Filter people and teams', assignees: 'Filter people', labels: 'Filter labels', milestone: 'Filter milestones' };

function pickedKeys(what: PickTarget, details: PullRequestDetails): Set<string> {
  if (what === 'milestone') return new Set(details.milestone === undefined ? [] : [String(details.milestone.number)]);
  if (what === 'labels') return new Set(details.labels.map((label) => label.name));
  if (what === 'assignees') return new Set(details.assignees);
  return new Set(details.reviewers.filter((reviewer) => reviewer.state === 'requested' || reviewer.rerequested === true).map((reviewer) => reviewer.team === undefined ? 'user:' + reviewer.name : 'team:' + reviewer.team));
}

/** The repository's choices plus whatever the PR already has, so current values stay removable. */
function pickerItems(what: PickTarget, details: PullRequestDetails, options: PickerOptions): PickerItem[] {
  if (what === 'milestone') {
    const all = new Map([...details.milestone === undefined ? [] : [details.milestone], ...options.milestones].map((milestone) => [milestone.number, milestone]));
    return [...all.values()].map((milestone) => ({ key: String(milestone.number), text: milestone.title }));
  }
  if (what === 'labels') {
    const byName = new Map([...details.labels, ...options.labels].map((label) => [label.name, label]));
    return [...byName.values()].map((label) => ({ key: label.name, text: label.name, color: label.color, ...(label.description === undefined ? {} : { description: label.description }) }));
  }
  if (what === 'assignees') return [...new Set([...details.assignees, ...options.users])].map((login) => ({ key: login, text: login }));
  const users = details.reviewers.filter((reviewer) => reviewer.team === undefined);
  const teams = details.reviewers.flatMap((reviewer) => reviewer.team === undefined ? [] : [{ name: reviewer.name, slug: reviewer.team }]);
  const userItems = [...new Set([...users.map((reviewer) => reviewer.name), ...options.users])].map((login): PickerItem => {
    const state = users.find((reviewer) => reviewer.name === login)?.state;
    return { key: 'user:' + login, text: login, ...(state === undefined || state === 'requested' ? {} : { note: labels[state][2] }) };
  });
  const teamItems = [...teams, ...options.teams.filter((team) => !teams.some((entry) => entry.slug === team.slug))]
    .map((team): PickerItem => ({ key: 'team:' + team.slug, text: team.name, note: 'Team' }));
  return [...userItems, ...teamItems];
}

function openPicker(what: PickTarget): void {
  const reopen = picker?.what !== what;
  closePicker(true);
  const details = current?.details;
  if (!reopen || !details?.canEdit || busy) return;
  const search = el('input');
  search.type = 'text';
  search.placeholder = pickerPlaceholders[what];
  search.setAttribute('aria-label', pickerPlaceholders[what]);
  const list = el('div', 'picker-list');
  const node = el('div', 'picker');
  node.append(search, list);
  $('pick-' + what).closest('section')?.append(node);
  $('pick-' + what).setAttribute('aria-pressed', 'true');
  const initial = pickedKeys(what, details);
  picker = { what, initial, selected: new Set(initial), node, list };
  search.addEventListener('input', () => renderPicker(search.value));
  renderPicker('');
  search.focus();
  post({ action: 'picker-options' });
}

function renderPicker(filter = picker?.node.querySelector('input')?.value ?? ''): void {
  const details = current?.details;
  if (!picker || !details) return;
  const { what, initial, selected, list } = picker;
  const query = filter.trim().toLowerCase();
  const items = pickerItems(what, details, pickerOptions ?? { users: [], teams: [], labels: [], milestones: [] })
    .filter((item) => !query || [item.text, item.key.replace(/^(?:user|team):/u, '')].some((text) => text.toLowerCase().includes(query)))
    .sort((a, b) => Number(initial.has(b.key)) - Number(initial.has(a.key)));
  const rows = items.map((item) => {
    const row = el('label', 'picker-row');
    const box = el('input');
    box.type = 'checkbox';
    box.checked = selected.has(item.key);
    box.addEventListener('change', () => {
      if (what === 'milestone') {
        selected.clear();
        if (box.checked) selected.add(item.key);
        renderPicker();
      } else if (box.checked) selected.add(item.key);
      else selected.delete(item.key);
    });
    const mark = icon(icons.check);
    mark.classList.add('check');
    row.append(box);
    if (item.color === undefined) row.append(mark, el('span', 'text', item.text));
    else {
      const label = el('span', 'picker-label');
      label.style.setProperty('--label', '#' + item.color);
      label.append(mark, el('span', 'dot'), el('span', 'text', item.text));
      if (item.description) {
        label.append(el('span', 'muted picker-description', item.description));
        row.title = item.description;
      }
      row.append(label);
    }
    if (item.note) row.append(el('span', 'muted', item.note));
    return row;
  });
  const note = pickerError ? 'Could not load choices: ' + pickerError : pickerOptions === undefined ? 'Loading…' : items.length ? '' : query ? 'No matches.' : 'Nothing to pick.';
  list.replaceChildren(...rows, ...note ? [el('div', 'muted picker-note', note)] : []);
}

/** Close the open picker and save its selection unless `save` is false or nothing changed. */
function closePicker(save: boolean): void {
  if (!picker) return;
  const { what, initial, selected, node } = picker;
  picker = undefined;
  node.remove();
  $('pick-' + what).removeAttribute('aria-pressed');
  if (!save || (selected.size === initial.size && [...selected].every((key) => initial.has(key)))) return;
  const keys = [...selected];
  const prefixed = (prefix: string): string[] => keys.filter((key) => key.startsWith(prefix)).map((key) => key.slice(prefix.length));
  changePullRequest(what === 'reviewers' ? { action: 'pick', what, values: prefixed('user:'), teams: prefixed('team:') } : { action: 'pick', what, values: keys, teams: [] });
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
  const conversation = current?.conversation;
  const merge = conversation?.merge;
  const queued = merge?.queuePosition !== undefined;
  $('merge-row').hidden = !details.open || draft || !details.mergeMethods.length || queued;
  $('merge-status').replaceChildren(...details.open && !draft && conversation ? mergeChecklist(details, conversation) : []);
  $('update-row').hidden = !details.open || draft || merge?.state !== 'behind' || !merge.canUpdateBranch;
  $('merge').title = merge?.mergeQueue ? 'Adds the PR to the merge queue.' : '';
  $('auto-row').hidden = merge?.autoMerge === undefined || !details.open;
  if (merge?.autoMerge) {
    $('auto-note').textContent = 'Auto-merge is on: ' + methodLabels[merge.autoMerge.method].toLowerCase() + ' when all requirements are met. Enabled by ' + merge.autoMerge.enabledBy + '.';
    $('auto-merge-off').hidden = !merge.canDisableAutoMerge;
  }
  $('queue-row').hidden = !queued || !details.open;
  $('queue-note').textContent = queued ? 'Queued to merge, position ' + merge.queuePosition + '.' : '';
  if (!details.mergeMethods.includes(mergeMethod)) mergeMethod = details.mergeMethods[0] ?? 'squash';
  if (!details.open || draft || queued) closeMergeForm();
  else drawMergeButtons();
  $('mergeable').textContent = draft ? 'Mark it ready for review before merging.'
    : !details.open ? (details.merged ? '' : 'Closed without merging.')
    : '';
  // On your own checkout, the agent fixes conflicts in the conversation you connected, so the page has no Fix conflicts button.
  const conflicted = details.open && details.mergeable === 'no' && details.canEdit && current?.claude.link === undefined;
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
  note.className = fixing === undefined ? 'muted' : 'chip agent working';
  note.replaceChildren(...fixing === undefined ? [] : [el('span', '', fixing)]);
  note.title = fixing ?? '';
  const actions: HTMLButtonElement[] = [];
  const add = (label: string, message: PageMessage, className = 'quiet', question?: string): void => {
    const send = (): void => changePullRequest(message);
    const node = button(label, question === undefined ? send : () => askInline({ key: 'state', question, label, send, redraw: () => { if (current?.details) renderState(current.details); } }), className);
    node.dataset.prAction = '';
    actions.push(node);
  };
  const number = current?.number === undefined ? 'this PR' : '#' + current.number;
  if (details.canEdit && details.open && !draft) add('Convert to draft', { action: 'draft', draft: true });
  if (details.canEdit && details.open) add('Close pull request', { action: 'close' }, 'quiet', 'Close ' + number + ' without merging? You can reopen it later.');
  if (details.canEdit && draft) add('Ready for review', { action: 'draft', draft: false }, 'primary');
  if (details.canEdit && !details.open && !details.merged) add('Reopen', { action: 'reopen' });
  if (details.merged && details.branchDeletable && merge?.headDeleted !== true) add('Delete branch', { action: 'delete-branch' }, '', 'Delete the branch ' + (current?.headBranch ?? '') + ' on GitHub?');
  if (!details.open && details.canEdit && merge?.headDeleted === true) add('Restore branch', { action: 'restore-branch' }, '');
  if (details.merged && details.canEdit) add('Revert', { action: 'revert' }, '', 'Open a PR that reverts ' + number + '? GitHub creates a branch with a revert commit.');
  $('state-actions').replaceChildren(...asking?.key === 'state' ? [askRow(asking)] : actions);
}

function verdict(reviewers: PullRequestDetails['reviewers']): readonly [string, string] {
  for (const key of ['changes', 'approved', 'commented'] as const) {
    const names = reviewers.filter((reviewer) => reviewer.state === key).map((reviewer) => reviewer.name);
    if (names.length) return [verdictText[key][0], verdictText[key][1] + names.join(', ')];
  }
  const waiting = reviewers.filter((reviewer) => reviewer.state === 'requested').map((reviewer) => reviewer.name);
  return waiting.length ? ['wait', 'Waiting for ' + waiting.join(', ')] : ['muted', 'No reviews yet'];
}

function isArchived(thread: { readonly id: string; readonly archived?: true }): boolean {
  return archiving.get(thread.id) ?? thread.archived === true;
}

/** Local threads the page shows: archived ones only while Show archived threads is on. */
function localThreads(): Thread[] {
  return (current?.threads ?? []).filter((thread) => showArchived || !isArchived(thread)).map((thread) => ({ ...thread, source: 'local' as const }));
}

function allThreads(): Thread[] {
  if (!current) return [];
  return [...localThreads(), ...(current.github ?? []).map((thread) => ({ ...thread, source: 'github' as const }))];
}

/** Whether the Files tab shows a thread: never one about the whole PR, guide notes only while Show guide comments is on. */
function inFiles(thread: Thread): boolean {
  return thread.scope !== 'pullRequest' && (guideInFiles || thread.source !== 'local' || thread.origin !== 'analysis');
}

/** Local threads about the whole PR that quote the conversation comment `id`, oldest first. */
function commentThreads(id: string): Thread[] {
  return localThreads().filter((thread) => thread.scope === 'pullRequest' && thread.linkedTo === id).sort((left, right) => started(left) - started(right));
}

/** Redraw where a thread shows: the Conversation for a thread about the whole PR, else its file. */
function redrawThread(thread: Thread | undefined): void {
  if (thread?.scope === 'pullRequest') { if (current) renderConversation(current, true); } else renderFiles([thread?.path]);
}

/** Local threads Claude opened from this GitHub thread; the page shows them inside it. */
function nestedIn(githubId: string): Thread[] {
  return localThreads().filter((thread) => thread.source === 'local' && thread.linkedTo === githubId).sort((left, right) => started(left) - started(right));
}

/** Archive or unarchive a local thread on the page right away; the extension's next state confirms it. */
function setArchived(thread: Thread, archived: boolean): void {
  archiving.set(thread.id, archived);
  replies.delete(thread.id);
  save();
  post({ action: 'archive', id: thread.id, archived });
  redrawThread(thread);
  renderThreadList();
}

function started(thread: Thread): number {
  return Date.parse(thread.messages[0]?.createdAt ?? '');
}

/** False for a local thread shown inside its GitHub thread. */
function standalone(thread: Thread): boolean {
  return thread.source !== 'local' || thread.linkedTo === undefined || !current?.github?.some((github) => github.id === thread.linkedTo);
}

const reactionEmoji: Record<ReactionContent, string> = { THUMBS_UP: '👍', THUMBS_DOWN: '👎', LAUGH: '😄', HOORAY: '🎉', CONFUSED: '😕', HEART: '❤️', ROCKET: '🚀', EYES: '👀' };
const reactionNames: Record<ReactionContent, string> = { THUMBS_UP: '+1', THUMBS_DOWN: '-1', LAUGH: 'Laugh', HOORAY: 'Hooray', CONFUSED: 'Confused', HEART: 'Heart', ROCKET: 'Rocket', EYES: 'Eyes' };
const reviewVerbs: Record<Extract<TimelineItem, { kind: 'review' }>['state'], string> = {
  approved: 'approved these changes', changes: 'requested changes', commented: 'reviewed', dismissed: 'reviewed, since dismissed', pending: 'started a review',
};
const isWriter = (conversation: PullRequestConversation | undefined): boolean => conversation !== undefined && ['admin', 'maintain', 'write'].includes(conversation.permission);
let mentionsAsked = false;

/** Reaction chips that toggle the viewer's own reaction, and a button that opens the eight GitHub reactions. */
function reactionsRow(subject: string, reactions: readonly ReactionCount[], canReact: boolean, redraw: () => void): HTMLElement {
  const row = el('div', 'reactions');
  for (const reaction of reactions) {
    const chip = button(reactionEmoji[reaction.content] + ' ' + reaction.count, () => react(subject, reaction.content, !reaction.viewerReacted), 'reaction');
    chip.setAttribute('aria-pressed', String(reaction.viewerReacted));
    chip.title = reactionNames[reaction.content];
    chip.disabled = !canReact;
    row.append(chip);
  }
  if (!canReact) return row;
  if (emojiFor === subject) {
    const pop = el('span', 'emoji-pop');
    for (const content of Object.keys(reactionEmoji) as ReactionContent[]) {
      const on = reactions.some((reaction) => reaction.content === content && reaction.viewerReacted);
      const option = button(reactionEmoji[content], () => react(subject, content, !on));
      option.title = reactionNames[content];
      option.setAttribute('aria-pressed', String(on));
      pop.append(option);
    }
    row.append(pop);
  } else {
    const add = button('', () => { emojiFor = subject; redraw(); }, 'reaction add');
    add.append(icon(icons.reaction));
    add.title = 'Add reaction';
    add.setAttribute('aria-label', 'Add reaction');
    row.append(add);
  }
  return row;
}

function react(subject: string, content: ReactionContent, on: boolean): void {
  emojiFor = undefined;
  $('error').textContent = '';
  post({ action: 'react', id: subject, content, on });
}

/** Where a GitHub comment sits: what kind GitHub calls it, how to redraw it, and where a quote goes. */
interface CommentPlace { readonly kind: CommentKind; redraw(): void; quote(text: string): void }

function quoted(body: string): string {
  return body.trim().split('\n').map((line) => '> ' + line).join('\n') + '\n\n';
}

function toolButton(svg: string, tip: string, onClick: () => void): HTMLButtonElement {
  const node = button('', onClick);
  node.append(icon(svg));
  node.title = tip;
  node.setAttribute('aria-label', tip);
  return node;
}

/** Quote, edit, hide and delete, as far as the viewer may. */
function commentTools(comment: GitHubComment, place: CommentPlace): HTMLElement {
  const tools = el('span', 'msg-tools');
  if (place.kind !== 'reviewComment' && comment.body.trim() && !hiddenComment(comment) && !commentAsks.has(comment.id)) {
    tools.append(toolButton(icons.agentAsk, 'Ask the agent about this comment', () => { commentAsks.set(comment.id, ''); focusNext = 'comment-ask:' + comment.id; place.redraw(); }));
  }
  if (comment.body.trim() && !hiddenComment(comment)) tools.append(toolButton(icons.quote, 'Quote reply', () => place.quote(quoted(comment.body))));
  if (comment.canEdit && !edits.has(comment.id)) tools.append(toolButton(icons.edit, 'Edit', () => { edits.set(comment.id, comment.body); focusNext = 'edit:' + comment.id; place.redraw(); }));
  if (comment.canHide && comment.hidden !== undefined) tools.append(toolButton(icons.hidden, 'Unhide', () => post({ action: 'hide-comment', id: comment.id, hide: false })));
  else if (comment.canHide) {
    const anchor = 'hide-' + place.kind + '-' + comment.id;
    const hide = toolButton(icons.hidden, 'Hide', () => openHideMenu(anchor, comment.id));
    hide.id = anchor;
    hide.setAttribute('aria-haspopup', 'true');
    const wrap = el('span', 'menu-anchor');
    wrap.append(hide);
    tools.append(wrap);
  }
  if (comment.canDelete) {
    const send = (): void => post(place.kind === 'reviewComment' ? { action: 'github-delete', id: comment.id } : { action: 'delete-issue-comment', id: comment.id });
    const remove = toolButton(icons.trash, 'Delete on GitHub', () => askInline({ key: 'delete:' + comment.id, question: 'Delete this comment on GitHub? Everyone on the PR loses it.', label: 'Delete', send, redraw: place.redraw }));
    remove.classList.add('delete');
    tools.append(remove);
  }
  return tools;
}

/** The comment's body: folded when hidden, a form while edited, else GitHub's HTML with its reactions. */
function commentBody(comment: GitHubComment, place: CommentPlace): HTMLElement[] {
  if (comment.hidden !== undefined && !revealed.has(comment.id)) {
    const note = el('div', 'hidden-note', 'Hidden as ' + comment.hidden + '.');
    note.append(button('Show', () => { revealed.add(comment.id); place.redraw(); }, 'quiet'));
    return [note];
  }
  const draft = edits.get(comment.id);
  if (draft !== undefined) {
    const key = 'edit:' + comment.id;
    const cancel = (): void => { edits.delete(comment.id); previewTabs.delete(key); place.redraw(); };
    const submit = (): void => {
      const text = edits.get(comment.id) ?? '';
      if (!text.trim() || sending.has(key)) return;
      sending.add(key);
      place.redraw();
      post({ action: 'edit-comment', form: key, kind: place.kind, id: comment.id, text });
    };
    const field = githubField(key, draft, 'Edit comment', (value) => { edits.set(comment.id, value); }, submit, cancel);
    const row = el('div', 'row actions composer-actions');
    const saveButton = button(sending.has(key) ? 'Saving…' : 'Update comment', submit, 'primary');
    saveButton.disabled = sending.has(key);
    row.append(el('span', 'gap'), button('Cancel', cancel, 'quiet'), saveButton);
    return [field, row];
  }
  const nodes: HTMLElement[] = [];
  if (comment.bodyHtml.trim()) {
    const body = el('div', 'msg-text');
    body.innerHTML = comment.bodyHtml;
    nodes.push(body);
  }
  nodes.push(reactionsRow(comment.id, comment.reactions, comment.canReact, place.redraw));
  if (asking?.key === 'delete:' + comment.id) nodes.push(askRow(asking));
  return nodes;
}

/** GitHub's reasons to hide a comment, under its Hide button; picking one hides it. */
function openHideMenu(anchor: string, id: string): void {
  const rows = hideReasons.map(([reason, label]) => menuRow([label], false, (on) => {
    if (!on) return;
    closeToolbarMenu();
    post({ action: 'hide-comment', id, hide: true, reason });
  }, true));
  openToolbarMenu(anchor, [el('div', 'muted picker-note', 'Why hide it?'), ...rows], 'hide-menu');
}

/** Show `next` in place of what asked it, until its confirm button or Cancel. */
function askInline(next: Ask): void {
  const before = asking;
  asking = next;
  before?.redraw();
  next.redraw();
  document.querySelector<HTMLElement>('.ask-row button')?.focus();
}

function stopAsking(): void {
  const before = asking;
  asking = undefined;
  before?.redraw();
}

/** The question on the left, Cancel and the confirm button on the right. */
function askRow(ask: Ask): HTMLElement {
  const row = el('div', 'row ask-row');
  const confirm = button(ask.label, () => { stopAsking(); ask.send(); }, 'primary');
  confirm.dataset.prAction = '';
  confirm.disabled = busy;
  const buttons = el('span', 'ask-buttons');
  buttons.append(button('Cancel', stopAsking, 'quiet'), confirm);
  row.append(el('span', 'muted gap', ask.question), buttons);
  return row;
}

/** A question in a menu under the button `anchor`, for buttons with no row to show it in. */
function askInMenu(anchor: string, question: string, label: string, send: () => void): void {
  closeToolbarMenu();
  const confirm = button(label, () => { closeToolbarMenu(); send(); }, 'primary');
  confirm.disabled = busy;
  const row = el('div', 'row ask-actions');
  row.append(button('Cancel', closeToolbarMenu, 'quiet'), confirm);
  openToolbarMenu(anchor, [el('p', 'ask-text', question), row], 'ask-menu');
}

/** A text box for GitHub with Write and Preview tabs, and @mention completion. */
function githubField(key: string, value: string, placeholder: string, onInput: (value: string) => void, onSubmit: () => void, onCancel: () => void): HTMLElement {
  let text = value;
  const wrap = el('div', 'field');
  const draw = (): void => {
    const showing = previewTabs.has(key);
    const tabs = el('div', 'seg field-tabs');
    for (const [label, on] of [['Write', false], ['Preview', true]] as const) {
      const tab = button(label, () => {
        if (on) previewTabs.add(key);
        else previewTabs.delete(key);
        if (on && text.trim() && renderedPreviews.get(key)?.text !== text) {
          renderedPreviews.set(key, { text });
          post({ action: 'markdown', form: key, text });
        }
        draw();
        if (!on) wrap.querySelector('textarea')?.focus();
      });
      tab.setAttribute('aria-pressed', String(showing === on));
      tabs.append(tab);
    }
    if (showing) {
      const box = el('div', 'md-preview msg-text');
      box.dataset.preview = key;
      const shown = renderedPreviews.get(key);
      if (!text.trim()) box.append(el('span', 'muted', 'Nothing to preview.'));
      else if (shown?.html === undefined) box.append(el('span', 'muted', 'Loading preview…'));
      else box.innerHTML = shown.html;
      wrap.replaceChildren(tabs, box);
    } else {
      const area = textarea(key, text, placeholder, (next) => { text = next; onInput(next); }, onSubmit, onCancel);
      attachMentions(area, wrap);
      wrap.replaceChildren(tabs, area);
    }
  };
  draw();
  return wrap;
}

/** People to @mention: who can be assigned, plus everyone on this PR. */
function mentionCandidates(): string[] {
  const names = new Set(pickerOptions?.users ?? []);
  const state = current;
  for (const item of state?.conversation?.timeline ?? []) if (item.kind !== 'event') names.add(item.author);
  for (const thread of state?.github ?? []) for (const entry of thread.messages) names.add(entry.author);
  for (const reviewer of state?.details?.reviewers ?? []) if (reviewer.team === undefined) names.add(reviewer.name);
  if (state) names.add(state.author);
  names.delete('ghost');
  names.delete(state?.conversation?.viewerLogin ?? '');
  return [...names].sort((a, b) => a.localeCompare(b));
}

/** Complete `@name` from `mentionCandidates` while typing; arrows pick, Enter or Tab inserts, Escape closes. */
function attachMentions(area: HTMLTextAreaElement, wrap: HTMLElement): void {
  let list: HTMLElement | undefined;
  let matches: string[] = [];
  let at = 0;
  const close = (): void => { list?.remove(); list = undefined; };
  const query = (): { start: number; text: string } | undefined => {
    const match = /(?:^|[\s(])@([\w-]*)$/u.exec(area.value.slice(0, area.selectionStart));
    const typed = match?.[1];
    return typed === undefined ? undefined : { start: area.selectionStart - typed.length, text: typed.toLowerCase() };
  };
  const choose = (login: string): void => {
    const typed = query();
    if (!typed) return;
    area.setRangeText(login + ' ', typed.start, area.selectionStart, 'end');
    area.dispatchEvent(new Event('input'));
    close();
    area.focus();
  };
  const show = (): void => {
    const typed = query();
    if (!pickerOptions && !mentionsAsked) { mentionsAsked = true; post({ action: 'picker-options' }); }
    matches = typed === undefined ? [] : mentionCandidates().filter((login) => login.toLowerCase().startsWith(typed.text)).slice(0, 8);
    if (!matches.length) { close(); return; }
    at = Math.min(at, matches.length - 1);
    list ??= el('div', 'mentions');
    list.style.top = area.offsetTop + area.offsetHeight + 2 + 'px';
    list.replaceChildren(...matches.map((login, index) => {
      const option = button('@' + login, () => choose(login));
      option.setAttribute('aria-selected', String(index === at));
      option.addEventListener('mousedown', (event) => event.preventDefault());
      return option;
    }));
    wrap.append(list);
  };
  area.addEventListener('input', (event) => { if (event.isTrusted) { at = 0; show(); } });
  area.addEventListener('keydown', (event) => {
    if (!list) return;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      at = (at + (event.key === 'ArrowDown' ? 1 : matches.length - 1)) % matches.length;
      show();
    } else if ((event.key === 'Enter' && !event.metaKey && !event.ctrlKey) || event.key === 'Tab') {
      const login = matches[at];
      if (login === undefined) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      choose(login);
    } else if (event.key === 'Escape') {
      event.stopImmediatePropagation();
      close();
    }
  }, { capture: true });
  area.addEventListener('blur', () => { setTimeout(close, 150); });
}

/** Avatars that loaded, held so redraws reuse the decoded picture instead of fetching and blinking. */
const loadedAvatars = new Map<string, HTMLImageElement>();
const failedAvatars = new Set<string>();

/** An avatar image, or initials when the picture is missing or does not load. */
function personAvatar(url: string, name: string | undefined, title: string): HTMLElement {
  const fallback = (): HTMLElement => {
    const letters = name === undefined ? '' : initials(name);
    const node = el('span', 'avatar' + (letters ? ' initials' : ''), letters);
    if (!letters) node.append(icon(icons.account));
    node.title = title;
    return node;
  };
  if (!url || failedAvatars.has(url)) return fallback();
  const loaded = loadedAvatars.get(url);
  const image = loaded ? loaded.cloneNode() as HTMLImageElement : el('img', 'avatar');
  if (!loaded) {
    image.addEventListener('load', () => { loadedAvatars.set(url, image); }, { once: true });
    image.addEventListener('error', () => { failedAvatars.add(url); image.replaceWith(fallback()); }, { once: true });
    image.src = url;
  }
  image.alt = title;
  image.title = title;
  return image;
}

let conversationStamp = '';

/** The Conversation card: comments, reviews, pushes and events, oldest first, and a box for a new comment. */
function renderConversation(state: OverviewState, force = false): void {
  const pullRequestThreads = state.threads.filter((thread) => thread.scope === 'pullRequest');
  const stamp = JSON.stringify([asking?.key, conversationFolded, conversationAll, state.conversation, state.conversationError, !!state.details, [...edits], [...revealed], emojiFor, [...previewTabs], [...sending].filter((key) => key === 'conversation' || key.startsWith('edit:') || key.startsWith('comment-ask:')),
    pullRequestThreads, showArchived, [...commentAsks.keys()], pullRequestThreads.map((thread) => [replies.get(thread.id), publishing.get(thread.id), archiving.get(thread.id)]), state.claude.running]);
  if (!force && stamp === conversationStamp) return;
  conversationStamp = stamp;
  const timeline = $('timeline');
  const data = state.conversation;
  const place = (item: Extract<TimelineItem, { kind: 'comment' | 'review' }>): CommentPlace => ({
    kind: item.kind === 'review' ? 'review' : 'issue',
    redraw: () => { if (current) renderConversation(current, true); },
    quote: (text) => {
      conversationDraft = (conversationDraft.trim() ? conversationDraft.replace(/\s*$/u, '\n\n') : '') + text;
      previewTabs.delete('conversation');
      focusNext = 'conversation';
      save();
      if (current) renderConversation(current, true);
    },
  });
  keepView(() => {
    if (!data) {
      timeline.replaceChildren(el('div', 'muted', state.conversationError ? 'Could not load the conversation: ' + state.conversationError : 'Loading conversation…'));
      $('conversation-form').replaceChildren();
      return;
    }
    const nodes: HTMLElement[] = [];
    let commits: Extract<TimelineItem, { kind: 'commit' }>[] = [];
    const flush = (): void => { if (commits.length) nodes.push(commitGroup(commits)); commits = []; };
    for (const item of data.timeline) {
      if (item.kind === 'commit') { commits.push(item); continue; }
      if (item.kind === 'review' && (item.state === 'pending' || (!item.bodyHtml.trim() && item.state === 'commented'))) continue;
      flush();
      if (item.kind === 'event') nodes.push(eventItem(item));
      else nodes.push(commentItem(item, place(item)));
    }
    flush();
    $('conversation').classList.toggle('folded', conversationFolded);
    $('fold-conversation').setAttribute('aria-expanded', String(!conversationFolded));
    $('conversation-count').textContent = nodes.length ? String(nodes.length) : '';
    const hidden = conversationAll ? 0 : Math.max(0, nodes.length - recentEntries - 1);
    const more = button('Show ' + hidden + ' earlier entries', () => { conversationAll = true; if (current) renderConversation(current, true); }, 'quiet');
    more.classList.add('timeline-more');
    timeline.replaceChildren(...nodes.length ? hidden ? [more, ...nodes.slice(hidden)] : nodes : [el('div', 'muted', 'No comments yet.')]);
    renderConversationForm();
  }, $('conversation'));
}

function renderConversationForm(): void {
  const key = 'conversation';
  const submit = (): void => {
    if (!conversationDraft.trim() || sending.has(key)) return;
    sending.add(key);
    $('error').textContent = '';
    if (current) renderConversation(current, true);
    post({ action: 'conversation-comment', form: key, text: conversationDraft });
  };
  const field = githubField(key, conversationDraft, 'Add a comment', (value) => { conversationDraft = value; save(); }, submit, () => undefined);
  const row = el('div', 'row composer-actions');
  const send = button(sending.has(key) ? 'Sending…' : 'Comment', submit, 'primary');
  send.disabled = sending.has(key);
  row.append(el('span', 'gap'), send);
  $('conversation-form').replaceChildren(field, row);
}

function commentItem(item: Extract<TimelineItem, { kind: 'comment' | 'review' }>, place: CommentPlace): HTMLElement {
  const node = el('div', 'timeline-item comment');
  node.id = 'comment-' + item.id;
  const main = el('div', 'msg-main');
  const head = el('div', 'msg-head');
  const verb = item.kind === 'review' ? reviewVerbs[item.state] : 'commented';
  head.append(el('b', '', item.author), el('span', 'verb', verb), ...timeLabel(item.createdAt), ...item.edited ? [el('span', 'edited', '· edited')] : [], commentTools(item, place));
  main.append(head, ...commentBody(item, place));
  if (commentAsks.has(item.id)) main.append(commentAskBox(item, place));
  main.append(...commentThreads(item.id).map(threadBox));
  node.append(personAvatar(item.avatarUrl, item.authorName ?? item.author, item.author), main);
  return node;
}

/** A note for the agent under a conversation comment; Ask or Implement opens a local thread about the whole PR that quotes the comment. */
function commentAskBox(comment: GitHubComment, place: CommentPlace): HTMLElement {
  const key = 'comment-ask:' + comment.id;
  const box = el('div', 'thread draft');
  const head = el('div', 'strip');
  head.append(el('span', 'source', 'New comment'), el('span', 'gap'), el('span', 'muted', 'Whole PR'));
  const cancel = (): void => { commentAsks.delete(comment.id); place.redraw(); };
  const busySending = sending.has(key);
  const send = (intent: Intent): void => {
    if (sending.has(key)) return;
    sending.add(key);
    $('error').textContent = '';
    place.redraw();
    post({ action: 'comment-ask', form: key, id: comment.id, text: commentAsks.get(comment.id) ?? '', intent });
  };
  const area = textarea(key, commentAsks.get(comment.id) ?? '', 'Tell the agent what to do, or leave empty', (value) => { commentAsks.set(comment.id, value); }, () => send('ask'), cancel);
  const implement = agentButton('implement', 'Implement', () => send('implement'));
  implement.title = 'Only the agent sees it. Agent changes the code';
  const ask = agentButton('ask', busySending ? 'Sending…' : 'Ask', () => send('ask'));
  ask.title = 'Only the agent sees it. Agent answers in a local thread without editing';
  implement.disabled = busySending;
  ask.disabled = busySending;
  const row = el('div', 'row actions composer-actions');
  row.append(el('span', 'gap'), button('Cancel', cancel, 'quiet'), implement, ask);
  box.append(head, area, row);
  return box;
}

function eventItem(item: Extract<TimelineItem, { kind: 'event' }>): HTMLElement {
  const node = el('div', 'timeline-item event');
  const line = el('div');
  line.append(el('b', '', item.actor), ' ' + item.text + ' · ', ...timeLabel(item.createdAt));
  node.append(personAvatar(item.avatarUrl, item.actor, item.actor), line);
  return node;
}

/** Consecutive pushes as one entry, with a button per commit that shows only its changes. */
function commitGroup(commits: readonly Extract<TimelineItem, { kind: 'commit' }>[]): HTMLElement {
  const node = el('div', 'timeline-item commits');
  const mark = el('span', 'avatar');
  mark.append(icon(icons.commit));
  const authors = [...new Set(commits.map((commit) => commit.author))];
  const main = el('div');
  const last = commits.at(-1);
  main.append(el('b', '', authors.join(', ')), ' added ' + commits.length + (commits.length === 1 ? ' commit · ' : ' commits · '), ...last ? timeLabel(last.createdAt) : []);
  const list = el('div', 'commit-list');
  for (const commit of commits) list.append(commitRow(commit));
  main.append(list);
  node.append(mark, main);
  return node;
}

const checkMarks: Record<NonNullable<Extract<TimelineItem, { kind: 'commit' }>['checks']>, readonly [StateShape, string, string]> = {
  success: ['done', 'ok', 'Checks passed'], failure: ['failed', 'bad', 'Checks failed'], pending: ['active', 'wait', 'Checks running'],
};

function commitRow(commit: Extract<TimelineItem, { kind: 'commit' }>): HTMLElement {
  const row = el('div', 'commit-row');
  row.title = commitTitle(commit);
  const hash = button(commit.oid.slice(0, 7), () => { showCommits(commit.oid, commit.oid); }, 'ref');
  hash.title = 'Show this commit\'s changes';
  row.append(hash, el('span', 'text', commit.headline), ...checkMark(commit));
  return row;
}

function commitTitle(commit: Extract<TimelineItem, { kind: 'commit' }>): string {
  return commit.message ? commit.headline + '\n\n' + commit.message : commit.headline;
}

function checkMark(commit: Extract<TimelineItem, { kind: 'commit' }>): HTMLElement[] {
  if (!commit.checks) return [];
  const [shape, tone, label] = checkMarks[commit.checks];
  return [stateIcon(shape, tone, label)];
}

/** Files, added and removed lines: always three cells, empty when GitHub could not count them. */
function commitStats(commit: Extract<TimelineItem, { kind: 'commit' }>): HTMLElement[] {
  const lines = commit.additions !== undefined && commit.deletions !== undefined;
  return [
    el('span', 'muted num', commit.files === undefined ? '' : commit.files + (commit.files === 1 ? ' file' : ' files')),
    el('span', 'ok num', lines ? '+' + commit.additions : ''),
    el('span', 'bad num', lines ? '−' + commit.deletions : ''),
  ];
}

function commitsOf(state = current): Extract<TimelineItem, { kind: 'commit' }>[] {
  return (state?.conversation?.timeline ?? []).filter((item): item is Extract<TimelineItem, { kind: 'commit' }> => item.kind === 'commit');
}

/** The PR's commits on GitHub, then the worktree's commits GitHub does not have yet, for the range menu and the Files tab. */
function rangeCommits(): Extract<TimelineItem, { kind: 'commit' }>[] {
  const local = (current?.unpushed ?? []).map(({ oid, subject, author, createdAt, files, additions, deletions }) =>
    ({ kind: 'commit' as const, id: oid, oid, headline: subject, message: '', author, avatarUrl: '', createdAt, files, additions, deletions }));
  return [...commitsOf(), ...local];
}

/** Commits after the one you last reviewed, oldest first; empty when that commit is no longer in the PR. */
function sinceCommits(): Extract<TimelineItem, { kind: 'commit' }>[] {
  const commits = rangeCommits();
  const at = commits.findIndex((commit) => commit.oid === current?.conversation?.lastReviewedCommit);
  return at < 0 ? [] : commits.slice(at + 1);
}

function isUnpushed(oid: string): boolean {
  return current?.unpushed?.some((commit) => commit.oid === oid) === true;
}

/** Show every commit GitHub does not have yet in the Files tab. */
function showUnpushed(): void {
  const first = current?.unpushed?.[0];
  const last = current?.unpushed?.at(-1);
  if (first && last) showCommits(first.oid, last.oid);
}

/** Show the changes of commits `from` to `to` in the Files tab. */
function showCommits(from: string, to: string): void {
  if (from === to) rangeAnchor = from;
  requestFiles({ kind: 'commits', from, to }, whitespace);
  setView('files');
  $('files-bar').scrollIntoView({ block: 'start' });
}

function requestFiles(next: DiffRange, hideWhitespace: boolean): void {
  wantedRange = undefined;
  $('error').textContent = '';
  if ((next.kind !== 'all' || hideWhitespace) && view === 'guide') setView('files');
  post({ action: 'files', range: next, whitespace: hideWhitespace });
}

function sameRange(a: DiffRange, b: DiffRange): boolean {
  return a.kind === b.kind && (a.kind !== 'commits' || (b.kind === 'commits' && a.from === b.from && a.to === b.to));
}

/** What the Files tab shows, for the range button. */
function rangeLabel(shown: DiffRange): string {
  if (shown.kind === 'all') return 'All changes';
  if (shown.kind === 'since') return 'Since your last review';
  if (shown.from !== shown.to) return rangeCount(shown) + ' commits';
  return shown.from.slice(0, 7) + ' ' + (commitHeadline(shown.from) ?? '');
}

/** A commit's title from the PR's commits, or from Claude's local commits before they are pushed. */
function commitHeadline(oid: string): string | undefined {
  return rangeCommits().find((commit) => commit.oid === oid)?.headline
    ?? current?.threads.flatMap((thread) => thread.commits ?? []).find((commit) => commit.oid === oid)?.subject;
}

function rangeCount(shown: Extract<DiffRange, { kind: 'commits' }>): number {
  const commits = rangeCommits();
  return commits.findIndex((commit) => commit.oid === shown.to) - commits.findIndex((commit) => commit.oid === shown.from) + 1;
}

/** What the Files tab shows, for the note above the files: hashes as code, the headline in bold. */
/** The note's first line: the commit's copyable hash and full title, or what the range covers. */
function rangeTitle(shown: DiffRange): (Node | string)[] {
  if (shown.kind === 'all') return ['All changes'];
  if (shown.kind === 'since') {
    const since = sinceCommits();
    const first = since[0];
    if (!first) return ['Changes since your last review'];
    if (since.length > 1) return ['Changes since your last review · ' + since.length + ' commits'];
    return ['Changes since your last review · 1 commit', commitRef(first.oid), el('span', 'headline', first.headline)];
  }
  if (shown.from !== shown.to) return [rangeCount(shown) + ' commits,', commitRef(shown.from), 'to', commitRef(shown.to)];
  const commit = rangeCommits().find((each) => each.oid === shown.from);
  const headline = commitHeadline(shown.from);
  return [commitRef(shown.from), ...headline === undefined ? [] : [el('span', 'headline', headline)], ...commit ? checkMark(commit) : []];
}

function commitRef(oid: string): HTMLButtonElement {
  return copyRef(oid.slice(0, 7), oid, 'commit SHA');
}

/** The note's second line: who made the shown commits and when, and what they change as shown. */
function rangeFacts(shown: DiffRange): (Node | string)[] {
  const commits = rangeCommits();
  const index = (oid: string): number => commits.findIndex((commit) => commit.oid === oid);
  const picked = shown.kind === 'commits' ? commits.slice(index(shown.from), index(shown.to) + 1) : shown.kind === 'since' ? sinceCommits() : [];
  const facts: (Node | string)[] = [];
  const authors = [...new Set(picked.map((commit) => commit.author))];
  if (authors.length) facts.push(el('b', '', authors.join(', ')), picked.length === 1 ? ' committed ' : ' committed these ');
  const last = picked.at(-1);
  if (last) facts.push(...timeLabel(last.createdAt), ' · ');
  if (files) {
    const added = files.reduce((sum, file) => sum + file.additions, 0);
    const removed = files.reduce((sum, file) => sum + file.deletions, 0);
    facts.push(el('span', 'stat-add', '+' + added), ' ', el('span', 'stat-del', '−' + removed), ' in ' + files.length + (files.length === 1 ? ' file' : ' files'));
  }
  if (facts.at(-1) === ' · ') facts.pop();
  return facts;
}

function hashChip(oid: string): HTMLElement {
  return el('span', 'ref', oid.slice(0, 7));
}

/** The range button, whitespace toggle and the note above the files while they show part of the PR. */
function renderRangeControls(): void {
  const label = rangeLabel(diffRange);
  const range = $('range');
  range.title = label;
  range.querySelector('.range-text')?.replaceChildren(...diffRange.kind === 'commits' && diffRange.from === diffRange.to ? [hashChip(diffRange.from)] : [label]);
  range.classList.toggle('on', diffRange.kind !== 'all');
  const note = $('range-note');
  note.hidden = diffRange.kind === 'all';
  if (!note.hidden) {
    const why = atHead ? 'Read marks and comments on the base need all changes.' : 'Comments and read marks need all changes.';
    const title = el('div', 'range-title');
    title.append(...rangeTitle(diffRange));
    const facts = el('div', 'muted range-facts');
    facts.append(...rangeFacts(diffRange));
    const text = el('div', 'gap');
    text.append(title, facts);
    const since = diffRange.kind === 'since' ? sinceCommits() : [];
    if (since.length > 1) {
      const list = el('ul', 'range-commits');
      for (const commit of since) {
        const row = el('li');
        row.append(commitRef(commit.oid), el('span', 'headline', commit.headline), el('span', 'muted', commit.author));
        list.append(row);
      }
      text.append(list);
    }
    const all = button('Show all changes', () => requestFiles({ kind: 'all' }, whitespace), 'small');
    all.title = why;
    note.replaceChildren(icon(icons.commit), text, all);
  }
}

/** A checkable row of a toolbar menu; `radio` rows close the menu when picked. */
function menuRow(content: (Node | string)[], checked: boolean, change: (on: boolean) => void, radio = false, svg?: string): HTMLElement {
  const label = el('label', 'picker-row');
  const box = el('input');
  box.type = radio ? 'radio' : 'checkbox';
  box.name = radio ? 'menu' : '';
  box.checked = checked;
  box.addEventListener('change', () => { change(box.checked); });
  const mark = icon(icons.check);
  mark.classList.add('check');
  const text = el('span', 'text');
  text.append(...content);
  label.append(box, mark, ...svg === undefined ? [] : [icon(svg)], text);
  return label;
}

/** Open a menu under the toolbar button `anchor`, or close it when it is already open. */
function openToolbarMenu(anchor: string, rows: HTMLElement[], className = ''): void {
  const again = toolbarMenu?.anchor === anchor;
  closeToolbarMenu();
  if (again) return;
  const node = el('div', ('picker toolbar-menu ' + className).trim());
  const list = el('div', 'picker-list');
  list.append(...rows);
  node.append(list);
  $(anchor).after(node);
  $(anchor).setAttribute('aria-expanded', 'true');
  toolbarMenu = { anchor, node };
  (node.querySelector<HTMLElement>('input:checked, [aria-checked=true]') ?? node.querySelector<HTMLElement>('input, button'))?.focus();
}

function closeToolbarMenu(): void {
  if (!toolbarMenu) return;
  toolbarMenu.node.remove();
  $(toolbarMenu.anchor).setAttribute('aria-expanded', 'false');
  toolbarMenu = undefined;
}

/** The range menu: all changes, since your last review, or commits; click a commit for its changes, Shift-click another for the commits between. */
function openRangeMenu(): void {
  const commits = rangeCommits();
  const index = (oid: string): number => commits.findIndex((commit) => commit.oid === oid);
  const [low, high] = diffRange.kind === 'commits' ? [index(diffRange.from), index(diffRange.to)] : [-1, -1];
  const pick = (next: DiffRange): void => { closeToolbarMenu(); requestFiles(next, whitespace); };
  const rows = [rangeRow([el('span', 'text', 'All changes'), el('span', 'muted', commits.length === 1 ? '1 commit' : commits.length + ' commits')], diffRange.kind === 'all', () => pick({ kind: 'all' }))];
  if (current?.conversation?.lastReviewedCommit) {
    const since = sinceCommits().length;
    rows.push(rangeRow([el('span', 'text', 'Since your last review'), ...since ? [el('span', 'muted', since === 1 ? '1 commit' : since + ' commits')] : []], diffRange.kind === 'since', () => pick({ kind: 'since' })));
  }
  const unpushed = current?.unpushed ?? [];
  const [firstLocal, lastLocal] = [unpushed[0], unpushed.at(-1)];
  if (firstLocal && lastLocal) {
    const range: DiffRange = { kind: 'commits', from: firstLocal.oid, to: lastLocal.oid };
    rows.push(rangeRow([el('span', 'text', 'Not pushed'), el('span', 'muted', unpushed.length === 1 ? '1 commit' : unpushed.length + ' commits')], sameRange(diffRange, range), () => pick(range)));
  }
  // Newest first; `at` stays the oldest-first index the Shift-click range uses.
  commits.map((commit, at) => [commit, at] as const).reverse().forEach(([commit, at]) => {
    const local = isUnpushed(commit.oid);
    const row = rangeRow([hashChip(commit.oid), el('span', 'text', commit.headline), ...cell(local ? [el('span', 'chip', 'Not pushed')] : checkMark(commit)), ...commitStats(commit), el('span', 'muted', commit.author), ...cell(timeLabel(commit.createdAt))],
      low >= 0 && at >= low && at <= high, (shift) => {
        const anchor = shift && rangeAnchor !== undefined ? index(rangeAnchor) : -1;
        if (anchor < 0) { rangeAnchor = commit.oid; pick({ kind: 'commits', from: commit.oid, to: commit.oid }); return; }
        const [from, to] = anchor <= at ? [commits[anchor], commit] : [commit, commits[anchor]];
        if (from && to) pick({ kind: 'commits', from: from.oid, to: to.oid });
      });
    row.title = commitTitle(commit);
    row.classList.add('commit');
    if (local) row.classList.add('unpushed');
    rows.push(row);
  });
  const hint = el('div', 'muted menu-hint', commits.length > 1 ? 'Shift-click a second commit to see the commits between.' : current?.conversation ? '' : 'Loading commits…');
  openToolbarMenu('range', hint.textContent ? [...rows, hint] : rows, 'range-menu');
}

/** One grid cell: the node, or an empty one so the columns stay in place. */
function cell(nodes: HTMLElement[]): HTMLElement[] {
  return nodes.length ? nodes : [el('span')];
}

function rangeRow(content: Node[], checked: boolean, choose: (shift: boolean) => void): HTMLElement {
  const row = el('button', 'picker-row range-row');
  row.setAttribute('role', 'menuitemcheckbox');
  row.setAttribute('aria-checked', String(checked));
  const mark = icon(icons.check);
  mark.classList.add('check');
  row.append(mark, ...content);
  row.addEventListener('click', (event) => { choose(event.shiftKey); });
  return row;
}

/** Whether lines on `side` can take comments, read marks and threads in the shown range. */
function linesFit(side: DiffSide): boolean {
  return atHead && (side === 'new' || diffRange.kind === 'all');
}

function fileType(path: string): string {
  const name = path.split('/').at(-1) ?? path;
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot) : 'No extension';
}

/** Files the filter box, the type menu and Hide viewed leave on the page. */
function filteredFiles(list: readonly FileDiff[]): readonly FileDiff[] {
  const query = fileFilter.trim().toLowerCase();
  return list.filter((file) => (!query || file.path.toLowerCase().includes(query) || (file.oldPath?.toLowerCase().includes(query) ?? false))
    && !hiddenTypes.has(fileType(file.path)) && !(hideViewed && viewed.has(file.path)));
}

function filtersOn(): boolean {
  return fileFilter.trim() !== '' || hiddenTypes.size > 0 || hideViewed;
}

function applyFilters(): void {
  save();
  renderFiles();
  renderNavThreads();
  $('filter-menu').setAttribute('aria-pressed', String(filtersOn()));
  $('filter-clear').hidden = fileFilter === '';
  showListToggle();
}

/** The file list's collapse icon, with a dot while a hidden list still filters the files. */
function showListToggle(): void {
  $('files').parentElement?.classList.toggle('list-hidden', listHidden);
  const toggle = $('nav-toggle');
  setTip(toggle, listHidden ? 'Expand file list' : 'Collapse file list');
  toggle.setAttribute('aria-expanded', String(!listHidden));
  toggle.classList.toggle('filtered', listHidden && view === 'files' && filtersOn());
}

function openFilterMenu(): void {
  const types = [...new Set((files ?? []).map((file) => fileType(file.path)))].sort();
  const rows = types.map((type) => menuRow([type, el('span', 'muted', String((files ?? []).filter((file) => fileType(file.path) === type).length))], !hiddenTypes.has(type),
    (on) => { if (on) hiddenTypes.delete(type); else hiddenTypes.add(type); applyFilters(); }));
  rows.push(menuRow(['Hide viewed files'], hideViewed, (on) => { hideViewed = on; applyFilters(); }));
  const archived = (current?.threads ?? []).filter(isArchived).length;
  rows.push(menuRow(['Show archived threads', el('span', 'muted', String(archived))], showArchived, (on) => { showArchived = on; save(); renderFiles(); renderThreadList(); }));
  const reset = button('Clear filters', () => { clearFilters(); closeToolbarMenu(); }, 'small');
  reset.disabled = !filtersOn();
  const foot = el('div', 'menu-foot');
  foot.append(reset);
  openToolbarMenu('filter-menu', [...rows, foot]);
}

/** Whether every file, or every guide step, is collapsed, so the fold button expands them. */
function allFolded(): boolean {
  const keys = view === 'guide' ? (guide ?? []).flatMap((group) => group.steps.map((step) => guideState('step', step.key))) : (files ?? []).map((file) => file.path);
  return keys.length > 0 && keys.every((key) => collapsed.get(key) === true);
}

/** Display settings you set once: whitespace, folders and where comments show. */
function openViewMenu(): void {
  const commentsOpen = document.querySelector('details.thread[open]') !== null;
  const notes = (current?.threads ?? []).filter((thread) => thread.origin === 'analysis' && (showArchived || !isArchived(thread))).length;
  const rows = [
    ...view === 'files' ? [menuRow(['Hide whitespace changes'], whitespace, (on) => { closeToolbarMenu(); requestFiles(diffRange, on); }, false, icons.whitespace)] : [],
    ...view === 'files' ? [menuRow(['Group files by folder'], folders, (on) => { folders = on; save(); renderFiles(); }, false, icons.tree)] : [],
    ...view === 'files' ? [menuRow(['All files', el('span', 'muted', 'Show unchanged files too')], allFiles, (on) => { allFiles = on; save(); renderFiles(); }, false, icons.file)] : [],
    ...view === 'files' ? [menuRow(['Show guide comments', el('span', 'muted', String(notes))], guideInFiles, (on) => { guideInFiles = on; save(); renderFiles(); renderNavThreads(); }, false, icons.agentGuide)] : [],
    menuRow(['Collapse all comments'], !commentsOpen, (on) => { for (const thread of allThreads()) threadOpen.set(thread.id, !on); renderFiles(); }, false, icons.comment),
    menuRow(['Collapsed comments in the margin'], marginThreads, (on) => {
      marginThreads = on;
      if (on) for (const [id, open] of threadOpen) if (open) threadOpen.delete(id);
      save();
      renderFiles();
    }, false, icons.margin),
  ];
  openToolbarMenu('view-menu', rows);
}

function clearFilters(): void {
  fileFilter = '';
  $<HTMLInputElement>('file-filter').value = '';
  hiddenTypes.clear();
  hideViewed = false;
  applyFilters();
}

/** Default merge commit wording, as the repository's settings tell GitHub to fill it in. */
function mergeDefaults(method: MergeMethod): { readonly headline: string; readonly body: string } {
  const state = current;
  const details = state?.details;
  const defaults = state?.conversation?.commitDefaults;
  if (!state || !details || !defaults) return { headline: '', body: '' };
  const suffix = state.number === undefined ? '' : ' (#' + state.number + ')';
  const commits = commitsOf(state);
  if (method === 'squash') {
    const [only] = commits.length === 1 ? commits : [];
    const headline = (defaults.squashTitle === 'COMMIT_OR_PR_TITLE' && only ? only.headline : details.title) + suffix;
    const body = defaults.squashBody === 'PR_BODY' ? details.body : defaults.squashBody === 'BLANK' ? ''
      : commits.map((commit) => '* ' + commit.headline + (commit.message.trim() ? '\n\n' + commit.message.trim() : '')).join('\n\n');
    return { headline, body };
  }
  const owner = details.headRepository?.split('/')[0] ?? new URL(state.url).pathname.split('/')[1] ?? '';
  const headline = defaults.mergeTitle === 'PR_TITLE' ? details.title + suffix : 'Merge pull request #' + (state.number ?? '') + ' from ' + owner + ':' + state.headBranch;
  const body = defaults.mergeBody === 'PR_TITLE' ? details.title : defaults.mergeBody === 'PR_BODY' ? details.body : '';
  return { headline, body };
}

/** Open the commit fields above the merge row; the clicked button turns into its own confirm button. */
function openMergeForm(auto: boolean): void {
  mergeForm = { auto, openedAt: Date.now() };
  const { headline, body } = mergeDefaults(mergeMethod);
  const title = $<HTMLInputElement>('merge-headline');
  $<HTMLTextAreaElement>('merge-body').value = body;
  title.value = headline;
  $('merge-form').hidden = mergeMethod === 'rebase';
  $<HTMLInputElement>('merge-delete').checked = false;
  drawMergeButtons();
  (mergeMethod === 'rebase' ? $(auto ? 'auto-merge' : 'merge') : title).focus();
}

function closeMergeForm(): void {
  mergeForm = undefined;
  $('merge-form').hidden = true;
  drawMergeButtons();
}

/** The merge row's buttons, as the open form and GitHub's merge state allow. */
function drawMergeButtons(): void {
  const merge = current?.conversation?.merge;
  const form = mergeForm;
  const mergeButton = $('merge');
  setLabel(mergeButton, form?.auto === false ? 'Confirm ' + methodLabels[mergeMethod].toLowerCase() : merge?.mergeQueue ? 'Merge when ready' : 'Merge');
  mergeButton.classList.toggle('primary', form?.auto === false);
  mergeButton.hidden = form?.auto === true;
  const auto = $('auto-merge');
  setLabel(auto, form?.auto ? 'Confirm auto-merge' : 'Enable auto-merge');
  auto.className = form?.auto ? 'primary' : 'quiet';
  auto.hidden = form ? !form.auto : !merge?.canEnableAutoMerge || merge.autoMerge !== undefined || merge.state === 'clean' || merge.mergeQueue;
  $('merge-cancel').hidden = !form;
  $('merge-delete-label').hidden = form?.auto !== false || current?.details?.branchDeletable !== true;
  $('method-text').textContent = methodLabels[mergeMethod];
}

/** Open the merge form on the first click and merge on the second; a double-click's second click does nothing. */
function clickMerge(auto: boolean): void {
  if (mergeForm?.auto !== auto) { openMergeForm(auto); return; }
  if (Date.now() - mergeForm.openedAt < 400) return;
  const message = mergeMethod === 'rebase' ? {} : { headline: $<HTMLInputElement>('merge-headline').value, body: $<HTMLTextAreaElement>('merge-body').value };
  if (auto) changePullRequest({ action: 'auto-merge', method: mergeMethod, ...message });
  else changePullRequest({ action: 'merge', method: mergeMethod, ...message, deleteBranch: $<HTMLInputElement>('merge-delete').checked && current?.details?.branchDeletable === true });
}

function openMethodMenu(): void {
  const methods = current?.details?.mergeMethods ?? [];
  openToolbarMenu('method', methods.map((method) => menuRow([methodLabels[method]], method === mergeMethod, (on) => {
    if (!on) return;
    mergeMethod = method;
    closeToolbarMenu();
    if (mergeForm) openMergeForm(mergeForm.auto);
    else drawMergeButtons();
  }, true)), 'method-menu');
}

function openUpdateMenu(): void {
  const update = (method: 'merge' | 'rebase'): void => { closeToolbarMenu(); changePullRequest({ action: 'update-branch', method }); };
  openToolbarMenu('update-branch', [
    menuRow(['Update with merge commit'], false, (on) => { if (on) update('merge'); }, true),
    menuRow([el('span', '', 'Update with rebase'), el('span', 'muted', 'Rewrites commits')], false, (on) => { if (on) update('rebase'); }, true),
  ], 'update-menu');
}

/** Shown while the link field is open, so redraws keep it. */
let linking = false;

/** The Linked changes card: each other repository's PR and its state, or the branch Claude made there, with their actions. */
function renderLinked(state: OverviewState): void {
  const rows = state.linked ?? [];
  const card = $('linked');
  card.hidden = state.linked === undefined;
  const stamp = JSON.stringify([rows, linking]);
  if (card.dataset.stamp === stamp) return;
  card.dataset.stamp = stamp;
  const sourceLabels = { mention: 'Mentioned', pin: 'Pinned in the diff', claude: 'Claude worked here', manual: 'Linked by you' } as const;
  const send = (action: 'linked-open' | 'linked-push' | 'linked-draft' | 'unlink', key: string): void => { post({ action, key }); };
  $('linked-rows').replaceChildren(...rows.length === 0 ? [el('li', 'muted', 'No PRs in other repositories go with this one.')] : [], ...rows.map((row) => {
    const item = el('li', 'linked-row');
    const what = el('div', 'what');
    const name = el('div', 'name');
    name.append(el('span', 'repo', row.repository));
    const pr = row.pullRequest;
    if (pr) {
      const link = el('a', '', '#' + pr.number + ' ' + pr.title);
      link.href = pr.url;
      name.append(link);
    } else name.append(el('span', 'title muted', 'No PR'));
    const facts = el('div', 'facts');
    const fact = (text: string, tone = ''): void => { facts.append(el('span', tone, text)); };
    if (pr) {
      fact(pr.state === 'merged' ? 'Merged' : pr.state === 'closed' ? 'Closed' : pr.draft ? 'Draft' : 'Open', pr.state === 'closed' ? 'bad' : '');
      if (pr.checks) fact(pr.checks === 'success' ? 'Checks passed' : pr.checks === 'failure' ? 'Checks failed' : 'Checks running', pr.checks === 'success' ? 'ok' : pr.checks === 'failure' ? 'bad' : 'wait');
      if (pr.review) fact(pr.review === 'approved' ? 'Approved' : pr.review === 'changes' ? 'Changes requested' : 'Review required', pr.review === 'approved' ? 'ok' : pr.review === 'changes' ? 'bad' : '');
    }
    if (row.branch && (!pr || pr.headBranch !== row.branch)) fact('Branch ' + row.branch);
    if (row.unpushed) fact(row.unpushed === 1 ? '1 not pushed' : row.unpushed + ' not pushed', 'wait');
    if (row.problem) fact(row.problem, 'bad');
    facts.title = row.sources.map((source) => sourceLabels[source]).join(', ');
    what.append(name, facts);
    const actions = el('div', 'row');
    const unlink = button('Unlink', () => send('unlink', row.key), 'quiet');
    unlink.title = 'Hide this link until you link it again';
    actions.append(unlink);
    if (pr && row.local) actions.append(button('Open review', () => send('linked-open', row.key)));
    if (row.unpushed && pr) {
      const push = button('Push ' + row.unpushed + (row.unpushed === 1 ? ' commit' : ' commits'), () => send('linked-push', row.key), 'primary');
      push.disabled = !pr.canPush || state.claude.running;
      push.title = !pr.canPush ? 'You cannot push to this PR.' : state.claude.running ? 'Agent is working. Push when it is done.' : 'Push the agent\'s commits to ' + pr.headBranch;
      actions.append(push);
    } else if (row.unpushed && !pr) {
      const draft = button('Push and open draft PR', () => send('linked-draft', row.key), 'primary');
      draft.disabled = state.claude.running;
      draft.title = 'Push ' + (row.branch ?? 'the branch') + ' and open a draft PR that mentions this one';
      actions.append(draft);
    }
    item.append(what, actions);
    return item;
  }));
  document.querySelector('.link-form')?.remove();
  $('link-pr').hidden = linking;
  if (!linking) return;
  const form = el('div', 'link-form');
  const input = el('input');
  input.type = 'text';
  input.placeholder = 'https://github.com/owner/repo/pull/12 or owner/repo#12';
  input.setAttribute('aria-label', 'PR to link');
  const close = (): void => { linking = false; if (current) renderLinked(current); };
  const submit = (): void => { if (input.value.trim()) post({ action: 'link', link: input.value.trim() }); };
  input.addEventListener('keydown', (event) => { if (event.key === 'Enter') { event.preventDefault(); submit(); } else if (event.key === 'Escape') close(); });
  form.append(input, button('Cancel', close, 'quiet'), button('Link', submit, 'primary'));
  $('linked-rows').after(form);
  input.focus();
}

/** Swap the title for a text field with Cancel and Save. */
function editTitle(): void {
  const input = el('input');
  input.type = 'text';
  input.maxLength = 256;
  input.value = current?.details?.title ?? current?.title ?? '';
  input.setAttribute('aria-label', 'Title');
  const submit = (): void => {
    if (!input.value.trim()) { input.focus(); return; }
    changePullRequest({ action: 'edit-title', title: input.value });
  };
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') { event.preventDefault(); submit(); } else if (event.key === 'Escape') closeTitleForm();
  });
  const saveButton = button('Save', submit, 'primary');
  saveButton.dataset.prAction = '';
  const form = el('span', 'title-form');
  form.id = 'title-form';
  form.append(input, button('Cancel', closeTitleForm, 'quiet'), saveButton);
  $('title').hidden = true;
  $('edit-title').hidden = true;
  $('title').after(form);
  input.focus();
  input.select();
}

function closeTitleForm(): void {
  document.getElementById('title-form')?.remove();
  $('title').hidden = false;
  $('edit-title').hidden = current?.details?.canEdit !== true;
}

/** GitHub's merge box checklist: reviews, checks and branch protection. */
function mergeChecklist(details: PullRequestDetails, conversation: PullRequestConversation): HTMLLIElement[] {
  const rows: HTMLLIElement[] = [];
  const add = (tone: string, shape: StateShape, text: string): void => {
    const row = el('li');
    row.append(stateIcon(shape, tone), el('span', '', text));
    rows.push(row);
  };
  const { merge } = conversation;
  if (merge.reviewDecision === 'approved') add('ok', 'done', 'Approved');
  else if (merge.reviewDecision === 'changes') add('bad', 'failed', 'Changes requested');
  else if (merge.reviewDecision === 'required') add('wait', 'active', 'Review required');
  const required = new Set(conversation.checks.filter((check) => check.required).map((check) => check.name));
  const failing = details.checks.filter((check) => check.state === 'failure');
  const running = details.checks.filter((check) => check.state === 'pending');
  if (failing.length) add('bad', 'failed', failing.length + (failing.length === 1 ? ' failing check' : ' failing checks') + (failing.some((check) => required.has(check.name)) ? ', some required' : ''));
  else if (running.length) add('wait', 'active', running.length + (running.length === 1 ? ' check running' : ' checks running'));
  else if (details.checks.length) add('ok', 'done', 'All checks passed');
  if (details.mergeable === 'no') add('bad', 'failed', 'Conflicts with the base branch');
  else if (details.mergeable === 'unknown') add('wait', 'active', 'Checking for conflicts');
  if (merge.state === 'blocked') add('bad', 'failed', 'Merging is blocked' + (merge.canBypass ? '. You may merge anyway, bypassing the rules.' : '.'));
  if (merge.state !== 'clean' && !merge.autoMergeAllowed && merge.autoMerge === undefined && !merge.mergeQueue && isWriter(conversation)) add('muted', 'idle', 'Auto-merge is off in this repository\'s settings.');
  return rows;
}

/** Commit and Add to batch for a GitHub suggestion the viewer can push. */
function suggestionRow(thread: Extract<Thread, { source: 'github' }>, entry: GitHubMessageView): HTMLElement | undefined {
  const details = current?.details;
  if (!entry.suggestion || thread.outdated || thread.side !== 'new' || !details?.canEdit || !details.open || hiddenComment(entry)) return undefined;
  const row = el('div', 'row suggest-row');
  const picked = batch.has(entry.id);
  const toggle = button(picked ? 'Remove from batch' : 'Add to batch', () => {
    if (picked) batch.delete(entry.id);
    else batch.set(entry.id, { thread: thread.id, comment: entry.id });
    renderBatch();
    renderFiles([thread.path]);
  });
  const commit = button('Commit suggestion', () => changePullRequest({ action: 'commit-suggestions', picked: [{ thread: thread.id, comment: entry.id }] }), 'primary');
  commit.dataset.prAction = '';
  commit.disabled = busy;
  commit.title = 'Commits the change to the PR branch and pushes it.';
  row.append(el('span', 'gap'), toggle, commit);
  return row;
}

function hiddenComment(entry: { readonly id: string; readonly hidden?: string }): boolean {
  return entry.hidden !== undefined && !revealed.has(entry.id);
}

function renderBatch(): void {
  const node = $<HTMLButtonElement>('commit-batch');
  node.hidden = batch.size === 0;
  setLabel(node, 'Commit ' + batch.size + (batch.size === 1 ? ' suggestion' : ' suggestions'));
}

/** One GitHub annotation from a check, under the line it points at. */
function annotationBox(note: Annotation & { readonly check: string }): HTMLElement {
  const box = el('div', 'annotation-box ' + note.level);
  box.append(icon(note.level === 'failure' ? icons.error : note.level === 'warning' ? icons.warning : icons.info));
  const text = el('div');
  text.append(el('b', '', (note.title || note.check) + ' '), el('span', 'muted', note.title ? note.check : ''), el('div', '', note.message));
  box.append(text);
  return box;
}

function annotationsOf(path: string): (Annotation & { readonly check: string })[] {
  if (!atHead) return [];
  return (current?.conversation?.checks ?? []).flatMap((check) => check.annotations.filter((note) => note.path === path).map((note) => ({ ...note, check: check.name })));
}

const shortcuts = 'j / k next or previous file · n / p next or previous comment · v toggle Viewed · t filter files · ? this list';

/** j/k move between files, n/p between comments, v ticks Viewed on the file at the top, t filters files. */
function onShortcut(event: KeyboardEvent): void {
  if (event.metaKey || event.ctrlKey || event.altKey) return;
  const target = event.target;
  if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement || (target instanceof HTMLElement && target.isContentEditable)) return;
  const top = $('files-bar').getBoundingClientRect().bottom + 4;
  const step = (selector: string, forward: boolean): void => {
    const nodes = [...document.querySelectorAll<HTMLElement>(selector)];
    const index = nodes.findIndex((node) => node.getBoundingClientRect().top > top + 1);
    const next = forward ? nodes[index < 0 ? nodes.length : index] : nodes[(index < 0 ? nodes.length : index) - 2];
    const fallback = forward ? undefined : nodes[0];
    (next ?? fallback)?.scrollIntoView({ block: 'start' });
  };
  if (event.key === 'j' || event.key === 'k') step('#files .file', event.key === 'j');
  else if (event.key === 'n' || event.key === 'p') {
    const nodes = [...document.querySelectorAll<HTMLElement>('#files details.thread')];
    const middle = window.innerHeight / 2;
    const index = nodes.findIndex((node) => node.getBoundingClientRect().top > middle + 1);
    const next = event.key === 'n' ? nodes[index < 0 ? nodes.length : index] : nodes[(index < 0 ? nodes.length : index) - 2] ?? nodes[0];
    next?.scrollIntoView({ block: 'center' });
  } else if (event.key === 'v') {
    const box = [...document.querySelectorAll<HTMLElement>('#files .file')].find((node) => node.getBoundingClientRect().bottom > top);
    box?.querySelector<HTMLInputElement>('label.viewed input')?.click();
  } else if (event.key === 't') { event.preventDefault(); $('file-filter').focus(); }
  else if (event.key === '?') showNotice({ text: shortcuts });
  else return;
}

function baseButton(): HTMLElement {
  const edit = toolButton(icons.edit, 'Change base branch', openBaseMenu);
  edit.id = 'change-base';
  edit.classList.add('icon-button');
  edit.dataset.prAction = '';
  edit.setAttribute('aria-haspopup', 'true');
  const anchor = el('span', 'menu-anchor');
  anchor.append(edit);
  return anchor;
}

/** The reviewers and their tools, with the dismiss form under the reviewer it is open for; redrawn only when they change, so the form keeps its focus. */
function renderReviewers(state: OverviewState, force = false): void {
  const { details, conversation } = state;
  const stamp = JSON.stringify([details?.reviewers, details?.canEdit, details?.open, conversation?.reviewIds, conversation?.viewerLogin, conversation?.permission, dismissing?.login]);
  if (!force && stamp === reviewersStamp) return;
  reviewersStamp = stamp;
  const reviewers = $('reviewers');
  reviewers.replaceChildren();
  if (!details) return;
  for (const reviewer of details.reviewers) {
    const tools: HTMLElement[] = [];
    if (details.canEdit && details.open && reviewer.team === undefined && reviewer.state !== 'requested' && reviewer.rerequested !== true && reviewer.name !== conversation?.viewerLogin) {
      const again = toolButton(icons.sync, 'Re-request review', () => changePullRequest({ action: 'rerequest', login: reviewer.name }));
      again.dataset.prAction = '';
      tools.push(again);
    }
    if (isWriter(conversation) && details.open && (reviewer.state === 'approved' || reviewer.state === 'changes') && conversation?.reviewIds[reviewer.name] !== undefined) {
      const dismiss = toolButton(icons.close, 'Dismiss review', () => {
        dismissing = { login: reviewer.name, text: '' };
        renderReviewers(state, true);
        $('reviewers').querySelector('textarea')?.focus();
      });
      dismiss.dataset.prAction = '';
      tools.push(dismiss);
    }
    const row = status(reviewer.state, reviewer.name, undefined, tools);
    if (reviewer.rerequested === true) row.querySelector('.muted')?.append(' · Re-requested');
    reviewers.append(row);
    if (dismissing?.login === reviewer.name) reviewers.append(dismissForm(dismissing));
  }
  if (!details.reviewers.length) reviewers.append(el('li', 'muted', 'No reviewers yet.'));
}

function dismissForm(form: { readonly login: string; text: string }): HTMLElement {
  const close = (): void => { dismissing = undefined; if (current) renderReviewers(current, true); };
  const submit = (): void => {
    if (!form.text.trim()) { area.focus(); return; }
    changePullRequest({ action: 'dismiss-review', login: form.login, text: form.text });
  };
  const area = textarea('dismiss', form.text, 'Why dismiss it? Everyone on the PR sees this.', (value) => { form.text = value; }, submit, close);
  const send = button('Dismiss review', submit, 'primary');
  send.dataset.prAction = '';
  const row = el('div', 'row ask-row');
  row.append(el('span', 'gap'), button('Cancel', close, 'quiet'), send);
  const item = el('li', 'dismiss-form');
  item.append(area, row);
  return item;
}

/** Tokens in a few digits, such as 62k or 1.2M. */
function tokenCount(tokens: number): string {
  return tokens >= 1_000_000 ? (tokens / 1_000_000).toFixed(1).replace(/\.0$/u, '') + 'M' : tokens >= 1000 ? Math.round(tokens / 1000) + 'k' : String(tokens);
}

/** Share of the window from which the meter warns that every run re-reads a large conversation. */
const largeContext = 0.5;

/** How full the PR's Claude conversation is, as a meter that opens the menu to start fresh or compact. */
function renderContextButton(claude: OverviewState['claude']): void {
  const context = claude.link === undefined ? claude.context : undefined;
  const button = $('context');
  button.parentElement?.toggleAttribute('hidden', context === undefined);
  if (context === undefined) { if (toolbarMenu?.anchor === 'context') closeToolbarMenu(); return; }
  const share = context.window ? Math.min(1, context.tokens / context.window) : undefined;
  const bar = el('span', 'bar');
  const fill = el('span');
  fill.style.width = (share ?? 0) * 100 + '%';
  bar.append(fill);
  button.replaceChildren(...share === undefined ? [] : [bar], tokenCount(context.tokens) + ' tokens');
  button.classList.toggle('large', share !== undefined && share >= largeContext);
  button.setAttribute('aria-label', 'Claude\'s context: ' + context.tokens + ' tokens' + (context.window ? ' of ' + context.window : ''));
  button.dataset.tip = 'Claude\'s context after its last run' + (context.window ? ', of ' + tokenCount(context.window) + ' tokens' : '') + '. Every run re-reads it';
}

function openContextMenu(): void {
  const context = current?.claude.context;
  if (!context) return;
  const running = current?.claude.running === true;
  const rows = [
    el('div', 'muted picker-note', tokenCount(context.tokens) + (context.window ? ' of ' + tokenCount(context.window) : '') + ' tokens after the last run'),
    connectRow(icons.reopen, 'New conversation', 'Claude forgets this PR\'s earlier runs. Each comment still sends its thread', () => {
      askInMenu('context', 'Start a new conversation on the next comment? Claude forgets what it learned in earlier runs.', 'Start new', () => post({ action: 'new-conversation' }));
    }),
    connectRow(icons.summarize, 'Compact', 'Claude summarizes the conversation and keeps going', () => { closeToolbarMenu(); post({ action: 'compact' }); }),
  ];
  for (const row of rows.slice(1)) if (row instanceof HTMLButtonElement) { row.disabled = running; if (running) row.title = 'Claude is working on this PR'; }
  openToolbarMenu('context', rows, 'context-menu');
}

/** Which part of the Claude menu shows: the choices, conversations to resume, or the steps that connect a running Claude. */
let connectView: 'choices' | 'resume' | 'preparing' | 'running' = 'choices';
let conversations: readonly ClaudeConversation[] | string | undefined;

/** The Claude button where you connect a conversation yourself; the terminal button is for a PR's own Claude. */
function renderConnectButton(link: OverviewState['claude']['link']): void {
  const connect = $('connect');
  $('terminal').hidden = link !== undefined;
  $('remove-worktree').closest('.menu-anchor')?.toggleAttribute('hidden', link !== undefined);
  connect.parentElement?.toggleAttribute('hidden', link === undefined);
  if (link === undefined) return;
  const label = link.terminal ? 'Open in terminal' : link.delivering ? 'Switch conversation' : 'Connect Claude';
  if (connect.dataset.label !== label) {
    connect.dataset.label = label;
    connect.replaceChildren(el('span', 'range-text', label), icon(icons.chevronDown));
  }
  if (connectView === 'running' && link.delivering) {
    connectView = 'choices';
    if (toolbarMenu?.anchor === 'connect') closeToolbarMenu();
    showNotice({ text: 'Claude connected.' });
  } else if (connectView === 'choices') renderConnectMenu();
}

function openConnectMenu(): void {
  connectView = 'choices';
  openToolbarMenu('connect', [], 'connect-menu');
  renderConnectMenu();
  toolbarMenu?.node.querySelector<HTMLElement>('button, input')?.focus();
}

/** A Connect menu row: an icon, the action and a one-line hint under it. */
function connectRow(svg: string | undefined, label: string, hint: string, pick: () => void): HTMLElement {
  const row = el('button', 'picker-row connect-row');
  const text = el('span', 'connect-text');
  text.append(el('span', 'connect-name', label), ...hint ? [el('span', 'muted', hint)] : []);
  row.append(...svg === undefined ? [] : [icon(svg)], text);
  row.addEventListener('click', pick);
  return row;
}

function renderConnectMenu(): void {
  const list = toolbarMenu?.anchor === 'connect' ? toolbarMenu.node.querySelector('.picker-list') : null;
  if (!list) return;
  const link = current?.claude.link;
  const choose = (how: 'show' | 'new' | 'copy' | 'resume', session?: string): void => {
    closeToolbarMenu();
    post(session === undefined ? { action: 'connect-claude', how } : { action: 'connect-claude', how: 'resume', session });
  };
  const choice = (label: string, note: string, pick: () => void): HTMLElement => connectRow(undefined, label, note, pick);
  if (connectView === 'choices') {
    const switching = link?.terminal === true || link?.delivering === true;
    list.replaceChildren(
      ...link?.terminal ? [connectRow(icons.terminal, 'Show terminal', 'The terminal of the connected conversation', () => choose('show')), el('div', 'menu-divider'), el('div', 'muted picker-note', 'Switch conversation')] : [],
      connectRow(icons.terminal, 'New conversation', 'Starts Claude in a VS Code terminal', () => choose('new')),
      connectRow(icons.earlier, 'Resume a conversation…', "Pick one of this folder's conversations", () => {
        connectView = 'resume';
        conversations = undefined;
        renderConnectMenu();
        list.querySelector('input')?.focus();
        post({ action: 'claude-conversations' });
      }),
      connectRow(icons.copy, 'Copy command', switching ? 'Start a new conversation in another terminal app' : 'Start Claude in another terminal app', () => choose('copy')),
      el('div', 'menu-divider'),
      el('div', 'muted picker-note', 'Claude already running'),
      connectRow(icons.link, 'Connect running Claude', 'Two commands to run in its terminal', () => {
        connectView = 'preparing';
        renderConnectMenu();
        post({ action: 'connect-claude', how: 'running' });
      }),
    );
  } else if (connectView === 'resume') {
    let search = list.querySelector<HTMLInputElement>('input[type=text]');
    if (!search) {
      search = el('input');
      search.type = 'text';
      search.placeholder = 'Filter conversations';
      search.setAttribute('aria-label', 'Filter conversations');
      search.addEventListener('input', () => renderConnectMenu());
    }
    const query = search.value.trim().toLowerCase();
    const found = typeof conversations === 'string' || conversations === undefined ? [] : conversations
      .filter((conversation) => !query || (conversation.title + ' ' + conversation.branch).toLowerCase().includes(query));
    const rows = found.map((conversation) => choice(conversation.title,
      [conversation.running ? 'Running' : '', relativeTime(new Date(conversation.modifiedAt).toISOString()), conversation.branch].filter(Boolean).join(' · '),
      () => choose('resume', conversation.id)));
    const note = typeof conversations === 'string' ? 'Could not list conversations: ' + conversations : conversations === undefined ? 'Loading…' : found.length ? '' : query ? 'No matches.' : 'No conversations in this folder yet.';
    list.replaceChildren(search, ...rows, ...note ? [el('div', 'muted picker-note', note)] : [], choice('All conversations in Claude…', '', () => choose('resume')));
  } else if (connectView === 'preparing') {
    list.replaceChildren(el('div', 'muted picker-note', 'Preparing Claude…'));
  } else {
    const command = (text: string, which: 'reload' | 'connect'): HTMLElement => {
      const row = el('div', 'row connect-command');
      const copy = button('Copy', () => { post({ action: 'copy-connect', command: which }); copy.textContent = 'Copied'; }, 'small');
      row.append(el('code', 'gap', text), copy);
      return row;
    };
    list.replaceChildren(el('p', 'ask-text', 'In the Claude terminal, run:'), command('/reload-plugins --force', 'reload'), command('/diffguide:connect', 'connect'),
      el('div', 'muted picker-note', 'Waiting for connection…'));
  }
}

/** The base branch menu: a filter over the branches the PR could merge into; GitHub's list arrives after it opens. */
function openBaseMenu(): void {
  if (busy) return;
  const search = el('input');
  search.type = 'text';
  search.placeholder = 'Filter branches';
  search.setAttribute('aria-label', 'Filter branches');
  search.addEventListener('input', () => renderBaseMenu());
  openToolbarMenu('change-base', [search, el('div', 'muted picker-note', 'Loading…')], 'base-menu');
  if (toolbarMenu?.anchor !== 'change-base') return;
  search.focus();
  baseBranches = undefined;
  post({ action: 'branches' });
}

let baseBranches: readonly string[] | string | undefined;

function renderBaseMenu(): void {
  const list = toolbarMenu?.anchor === 'change-base' ? toolbarMenu.node.querySelector('.picker-list') : null;
  const search = list?.querySelector('input');
  if (!list || !search) return;
  const query = search.value.trim().toLowerCase();
  const names = typeof baseBranches === 'string' || baseBranches === undefined ? [] : baseBranches.filter((name) => name.toLowerCase().includes(query));
  const rows = names.slice(0, 200).map((name) => menuRow([name], false, (on) => {
    if (on) askInMenu('change-base', 'Change the base branch to ' + name + '? The diff and checks follow.', 'Change base', () => changePullRequest({ action: 'change-base', branch: name }));
  }, true));
  const note = typeof baseBranches === 'string' ? 'Could not load branches: ' + baseBranches : baseBranches === undefined ? 'Loading…' : names.length ? '' : query ? 'No matches.' : 'No other branches.';
  list.replaceChildren(search, ...rows, ...note ? [el('div', 'muted picker-note', note)] : []);
}

function render(state: OverviewState): void {
  noteWorking(current, state);
  current = state;
  queueMicrotask(renderAnswers);
  for (const thread of state.threads) if (archiving.get(thread.id) === (thread.archived === true)) archiving.delete(thread.id);
  $('number').replaceChildren(...state.number === undefined ? [] : [copyRef('#' + state.number, state.url, 'link to the pull request')]);
  $('title').textContent = state.heading ?? state.title;
  const canChangeBase = state.details?.canEdit === true && state.details.open;
  const byline = JSON.stringify([state.author, state.headBranch, state.baseBranch, canChangeBase, state.branchPullRequest]);
  if ($('byline').dataset.stamp !== byline) {
    $('byline').dataset.stamp = byline;
    if (toolbarMenu?.anchor === 'change-base') closeToolbarMenu();
    if (state.localMode) $('byline').replaceChildren('Uncommitted changes on', branchRef(state.headBranch), ...state.branchPullRequest ? [pullRequestChip(state.branchPullRequest)] : []);
    else $('byline').replaceChildren(state.author + ' wants to merge', branchRef(state.headBranch), 'into', branchRef(state.baseBranch), ...canChangeBase ? [baseButton()] : []);
  }
  $('facts').replaceChildren(...pullRequestFacts(state));
  const { details } = state;
  const body = $('body');
  if (!details) body.replaceChildren(el('span', 'muted', state.detailsError ? 'Could not load from GitHub: ' + state.detailsError : 'Loading from GitHub…'));
  else if (!editingBody && details.bodyHtml.trim()) body.innerHTML = details.bodyHtml;
  else if (!editingBody) body.replaceChildren(el('span', 'muted', 'No description.'));
  renderReviewers(state);
  const checks = $('checks');
  checks.replaceChildren();
  if (details) {
    const extras = new Map((state.conversation?.checks ?? []).map((check) => [check.name, check]));
    for (const check of details.checks) {
      const extra = extras.get(check.name);
      const tools: HTMLElement[] = [];
      if (extra?.required) tools.push(el('span', 'file-chip', 'Required'));
      const runId = extra?.runId;
      if (check.state === 'failure' && runId !== undefined && isWriter(state.conversation)) {
        const rerun = toolButton(icons.sync, 'Re-run failed jobs', () => changePullRequest({ action: 'rerun', run: runId }));
        rerun.dataset.prAction = '';
        tools.push(rerun);
      }
      checks.append(status(check.state, check.name, check.url, tools));
    }
    if (!details.checks.length) checks.append(el('li', 'muted', 'No checks.'));
  }
  for (const id of ['pick-reviewers', 'pick-assignees', 'pick-labels', 'pick-milestone']) $(id).hidden = !details?.canEdit;
  $('edit-title').hidden = !details?.canEdit || document.getElementById('title-form') !== null;
  $('milestone').replaceChildren(...details ? [details.milestone ? el('span', '', details.milestone.title) : el('span', 'muted', 'No milestone.')] : []);
  const linked = state.conversation?.linkedIssues ?? [];
  $('development').hidden = linked.length === 0;
  $('linked-issues').replaceChildren(...linked.map((issue) => {
    const item = el('li', 'row');
    const link = el('a', '', '#' + issue.number + ' ' + issue.title);
    link.href = issue.url;
    item.append(stateIcon(issue.open ? 'idle' : 'done', issue.open ? 'ok' : 'muted'), link);
    item.title = issue.open ? 'Open; merging this PR closes it' : 'Closed';
    return item;
  }));
  const awaiting = state.conversation?.awaitingApproval.length ?? 0;
  $('awaiting').hidden = awaiting === 0;
  $('awaiting-note').textContent = awaiting + (awaiting === 1 ? ' workflow waits' : ' workflows wait') + ' for approval to run.';
  const descriptionReactions = $('description-reactions');
  const description = state.conversation?.description;
  const drawReactions = (): void => {
    if (description) descriptionReactions.replaceChildren(reactionsRow(description.id, description.reactions, description.canReact, drawReactions));
    else descriptionReactions.replaceChildren();
  };
  drawReactions();
  renderConversation(state);
  renderRangeControls();
  renderBatch();
  if (wantedRange !== undefined && (state.conversation || state.conversationError)) {
    const next = wantedRange;
    wantedRange = undefined;
    if (state.conversation && !sameRange(next, diffRange)) requestFiles(next, whitespace);
  }
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
  const terminal = $('terminal');
  const stop = $<HTMLButtonElement>('stop-claude');
  const progress = state.claude.running ? state.claude.progress : undefined;
  claude.after(...$('context').parentElement ? [$('context').parentElement as HTMLElement] : [], stop, terminal);
  if (progress === undefined) claude.replaceChildren(...state.claude.running ? [] : [icon(icons.orb)], state.claude.text);
  else claude.replaceChildren(stepLog(progress.steps, progress.startedAt, stop, runMotion(progress)), terminal);
  stop.hidden = !state.claude.running;
  if (!state.claude.running) { stoppingClaude = false; stop.disabled = false; }
  claude.className = progress !== undefined ? 'claude-box' : state.claude.running ? 'chip agent working' : 'chip orb-chip';
  $('retry').hidden = !state.claude.retry;
  terminal.className = state.claude.running ? 'small' : 'quiet';
  terminal.replaceChildren(icon(icons.terminal), state.claude.running ? 'Stop and open in terminal' : 'Open in terminal');
  terminal.dataset.tip = state.claude.running ? 'Stops the agent\'s background run, then continues its conversation in a terminal' : 'Continue this PR\'s agent conversation in a terminal';
  renderConnectButton(state.claude.link);
  renderContextButton(state.claude);
  const unpushed = state.unpushed?.length ?? 0;
  const push = $('push');
  push.hidden = !unpushed || !details?.canEdit;
  setLabel(push, 'Push ' + unpushed + (unpushed === 1 ? ' commit' : ' commits'));
  $('show-unpushed').hidden = !unpushed;
  renderThreadList();
  renderLinked(state);
  author = !details || details.viewerIsAuthor;
  setBusy(busy);
  for (const review of document.querySelectorAll<HTMLButtonElement>('[data-reviewer]')) review.hidden = author;
  document.querySelector<HTMLButtonElement>('[data-event="comment"]')?.classList.toggle('primary', author);
  $('review-box').querySelector<HTMLButtonElement>('[data-event="comment"]')!.title = author ? 'This is your PR, so you can only comment.' : '';
  const pendingCount = details?.pendingComments;
  $('discard-review').hidden = pendingCount === undefined;
  $('pending-note').hidden = pendingCount === undefined;
  $('pending-note').textContent = pendingCount + ' pending comment' + (pendingCount === 1 ? '' : 's');
  renderPendingList(pendingCount !== undefined);
  const badge = $('verdict');
  badge.hidden = !details;
  if (details) {
    const [tone, label] = verdict(details.reviewers);
    badge.className = 'verdict ' + tone;
    badge.textContent = label;
  }
  const prState = $('pr-state');
  const ended = details && !details.open ? (details.merged ? 'merged' : 'closed') : undefined;
  prState.hidden = ended === undefined;
  if (ended && !prState.classList.contains(ended)) {
    prState.className = 'verdict pr-state pr-only ' + ended;
    prState.replaceChildren(icon(ended === 'merged' ? icons.merge : icons.closePullRequest), ended === 'merged' ? 'Merged' : 'Closed');
  }
  $('review-box').hidden = !details?.open;
  $('bar-review').hidden = !details?.open;
  $('bar-pending').hidden = pendingCount === undefined;
  $('bar-pending').textContent = pendingCount + ' pending';
  $('merge-box').hidden = !details;
  if (details) {
    renderState(details);
  }
  const next = new Set(state.viewed);
  for (const path of next) if (!viewed.has(path)) collapsed.set(path, true);
  for (const path of viewed) if (!next.has(path)) collapsed.set(path, false);
  viewed = next;
  save();
  readRanges = state.read;
  const { analysis } = state;
  const analyze = $<HTMLButtonElement>('analyze');
  setLabel(analyze, analysis.running ? 'Stop' : analysis.result ? 'Rebuild guide' : 'Build guide');
  const analysisStatus = $('analysis-status');
  analysisStatus.textContent = analysis.running ? 'Guide · ' + (analysis.step ?? 'Working') : analysis.error ? 'Guide failed' : '';
  analysisStatus.title = analysis.error ?? '';
  analysisStatus.className = analysis.running ? 'chip agent working' : analysis.error ? 'chip bad' : '';
  analysisStatus.hidden = !analysis.running && !analysis.error;
  showReview();
  const stamp = JSON.stringify([analysis.result?.createdAt, analysis.stale, analysis.behind, analysis.result ? analysis.stale && analysis.running : [analysis.running, analysis.error]]);
  if (stamp !== guideStamp) {
    guideStamp = stamp;
    guide = undefined;
    if (view === 'guide') { renderFiles(); return; }
  }
  const localPaths = Object.keys(state.local ?? {}).sort().join('\0');
  if (localPaths !== shownLocalPaths) {
    shownLocalPaths = localPaths;
    if (folders && view === 'files') { renderFiles(); return; }
  }
  renderFiles('state');
}

/** New answers already reported seen, as `thread@time`, so a redraw before the next state does not list them again. */
const seenAnswers = new Set<string>();
const answerKey = (thread: { readonly id: string; readonly newAnswer?: string }): string => thread.id + '@' + (thread.newAnswer ?? '');
/** Where each unseen answer is relative to the screen: above, below, or on it (seen). */
const answerPlaces = new Map<string, 'above' | 'below'>();
let answersFolded = false;
let seenBatch: string[] = [];
let seenTimer: ReturnType<typeof setTimeout> | undefined;
const answerWatch = new IntersectionObserver((entries) => {
  for (const entry of entries) {
    const { answer: id, answerKey: key } = (entry.target as HTMLElement).dataset;
    if (!entry.target.isConnected) { answerWatch.unobserve(entry.target); continue; }
    if (id === undefined || key === undefined) continue;
    if (entry.isIntersecting && entry.intersectionRatio > 0.5) {
      answerWatch.unobserve(entry.target);
      answerPlaces.delete(id);
      if (!seenAnswers.has(key)) { seenAnswers.add(key); seenBatch.push(id); }
    } else answerPlaces.set(id, entry.boundingClientRect.top < 0 ? 'above' : 'below');
  }
  if (seenBatch.length) {
    clearTimeout(seenTimer);
    seenTimer = setTimeout(() => { post({ action: 'seen-answers', ids: seenBatch }); seenBatch = []; }, 400);
  }
  renderAnswers();
}, { threshold: [0, 0.5] });

/** Report Claude's new answer seen once half of it is on screen. */
function watchAnswer(item: HTMLElement, thread: { readonly id: string; readonly newAnswer?: string }): void {
  if (seenAnswers.has(answerKey(thread))) return;
  item.dataset.answer = thread.id;
  item.dataset.answerKey = answerKey(thread);
  answerWatch.observe(item);
}

/** The floating list of Claude's new answers that are off screen; a row jumps to its thread. */
function renderAnswers(): void {
  const box = $('answers');
  const fresh = (current?.threads ?? []).filter((thread) => thread.newAnswer !== undefined && !seenAnswers.has(answerKey(thread)))
    .sort((a, b) => (b.newAnswer ?? '').localeCompare(a.newAnswer ?? ''));
  const away = fresh.filter((thread) => answerPlaces.get(thread.id) !== undefined || !document.querySelector('[data-answer="' + CSS.escape(thread.id) + '"]'));
  box.hidden = away.length === 0;
  if (!away.length) { box.replaceChildren(); return; }
  const head = el('div', 'answers-head');
  head.append(el('span', '', away.length === 1 ? 'Claude answered' : away.length + ' new Claude answers'), el('span', 'gap'));
  const fold = button(answersFolded ? 'Show' : 'Hide', () => { answersFolded = !answersFolded; renderAnswers(); }, 'quiet small');
  head.append(fold);
  box.replaceChildren(head);
  if (answersFolded) return;
  for (const thread of away.slice(0, 5)) {
    const row = el('button', 'answer');
    const place = answerPlaces.get(thread.id);
    row.append(place === 'above' ? icon(icons.arrowUp) : place === 'below' ? icon(icons.arrowDown) : el('span'), el('span', 'text', thread.title ?? thread.text), el('span', 'muted', relativeTime(thread.newAnswer ?? '')));
    row.title = thread.location;
    row.addEventListener('click', () => { jump({ ...thread, source: 'local' }); });
    box.append(row);
  }
  if (away.length > 5) box.append(el('div', 'answer muted', '+' + (away.length - 5) + ' more in the Claude answers view'));
}

/** Paths with local work at the last full draw, so folder marks redraw when the set changes. */
let shownLocalPaths = '';

function code(line: DiffLine, side: '' | 'add' | 'del'): HTMLTableCellElement {
  const cell = el('td', 'code' + (side ? ' ' + side : ''));
  cell.innerHTML = line.html;
  if (line.kind !== 'del' && line.newLine !== undefined) cell.dataset.line = String(line.newLine);
  return cell;
}

function num(value: number | undefined, path: string, side: DiffSide): HTMLTableCellElement {
  const cell = el('td', 'num', value === undefined ? '' : String(value));
  if (value !== undefined && linesFit(side)) {
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
  const github = draft.target === 'github' && !current?.localMode;
  const box = el('div', 'thread draft' + (github ? ' github' : ''));
  const head = el('div', 'strip');
  const toggle = el('span', 'seg');
  toggle.hidden = current?.localMode === true;
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
  const cancelLink = button('Cancel', cancel, 'quiet');
  const needText: HTMLButtonElement[] = [];
  const onDraft = (value: string): void => { draft.text = value; save(); for (const each of needText) each.disabled = sending.has('composer') || !value.trim(); };
  const area = github ? githubField('composer', draft.text, 'Comment on GitHub', onDraft, submit, cancel) : textarea('composer', draft.text, 'Ask about these lines', onDraft, submit, cancel);
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
    row.append(...reviewing ? [titled(el('span', 'chip pending', 'Review in progress'), 'New comments go into your pending review.')] : [], el('span', 'gap'), cancelLink, now, review);
  } else {
    const implement = agentButton('implement', 'Implement', () => send(true, 'implement'));
    implement.title = 'Agent changes the code';
    const ask = agentButton('ask', busySending ? 'Sending…' : 'Ask', submit);
    ask.title = 'Agent answers without editing';
    needText.push(implement, ask);
    onDraft(draft.text);
    row.append(el('span', 'gap'), cancelLink, implement, ask);
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
  if (diffRange.kind === 'all') head.append(read);
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
  if (!('avatarUrl' in entry) && entry.author === 'claude') {
    const node = el('span', 'avatar orb-avatar');
    node.title = author;
    node.append(orbCanvas('avatar'));
    return node;
  }
  const url = 'avatarUrl' in entry ? entry.avatarUrl : current?.details?.viewerAvatarUrl ?? '';
  const name = 'avatarUrl' in entry ? entry.authorName ?? entry.author : entry.author === 'human' ? current?.details?.viewerName : undefined;
  return personAvatar(url, name, author);
}

/** Up to two letters for a person without a picture: first and last word of a name, or the start of a single-word login. */
function initials(name: string): string {
  const words = name.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  const first = words[0];
  if (first === undefined) return '';
  const last = words.length > 1 ? words.at(-1) : undefined;
  return ((first[0] ?? '') + (last?.[0] ?? '')).toUpperCase();
}

/** Avatar on the left, text beside it. GitHub messages name their author; local ones are You or Claude, which the avatar already says. */
function message(entry: Message, thread?: Thread): HTMLElement {
  const author = 'avatarUrl' in entry ? entry.author : entry.author === 'claude' ? 'Claude' : 'You';
  const item = el('div', 'msg');
  const main = el('div', 'msg-main');
  item.append(avatar(entry, author), main);
  if ('avatarUrl' in entry && thread?.source === 'github') {
    const place: CommentPlace = {
      kind: 'reviewComment',
      redraw: () => { renderFiles([thread.path]); },
      quote: (text) => {
        const reply = replies.get(thread.id) ?? '';
        replies.set(thread.id, (reply.trim() ? reply.replace(/\s*$/u, '\n\n') : '') + text);
        focusNext = 'reply:' + thread.id;
        save();
        renderFiles([thread.path]);
      },
    };
    const comment = { ...entry, bodyHtml: entry.html };
    const head = el('div', 'msg-head');
    head.append(el('b', '', author), ...timeLabel(entry.createdAt), ...entry.edited ? [el('span', 'edited', '· edited')] : []);
    const meta = el('span', 'msg-meta');
    if (entry.pending) meta.append(el('span', 'chip pending', 'Pending'));
    meta.append(commentTools(comment, place));
    head.append(meta);
    main.append(head, ...commentBody(comment, place));
    const suggest = suggestionRow(thread, entry);
    if (suggest) main.append(suggest);
    return item;
  }
  if (!('avatarUrl' in entry)) {
    const meta = el('span', 'msg-meta');
    if ('intent' in entry && entry.intent !== undefined) meta.append(intentChip(entry.intent));
    meta.append(...timeLabel(entry.createdAt));
    if (meta.childElementCount > 0) main.append(meta);
  }
  const body = el('div', 'msg-text');
  body.innerHTML = entry.html;
  main.append(body);
  return item;
}

const intentLabels: Readonly<Record<ReviewIntent, readonly [string, string]>> = {
  ask: ['Ask', icons.agentAsk], implement: ['Implement', icons.agentImplement], summarize: ['Summarize', icons.agentAsk],
};

/** Which button sent a human message: Ask or Implement. */
function intentChip(intent: ReviewIntent): HTMLElement {
  const [label, svg] = intentLabels[intent];
  const chip = el('span', 'chip intent');
  chip.append(icon(svg), label);
  return chip;
}

/** Who can see a thread: Local stays with you and Claude, On GitHub is on the PR, Guide is Claude's note from its guide. */
const kindMarks: Record<ThreadKind, string> = { github: icons.github, local: icons.local, analysis: icons.agentGuide, review: icons.agentReview };
const kindLabels: Record<ThreadKind, string> = { github: 'On GitHub', local: 'Local', analysis: 'Guide', review: 'Review' };

function kindLabel(kind: ThreadKind): HTMLElement {
  const label = el('span', 'source');
  label.append(icon(kindMarks[kind]), kindLabels[kind]);
  return label;
}

/** Collapsing a thread from its stuck header would leave the page far below it; keep the header where it was on screen. */
function keepInView(box: HTMLElement, summary: HTMLElement): void {
  const before = summary.getBoundingClientRect().top;
  if (box.getBoundingClientRect().top >= before) return;
  box.addEventListener('toggle', () => { window.scrollBy(0, box.getBoundingClientRect().top - before); }, { once: true });
}

function strip<K extends keyof HTMLElementTagNameMap>(tag: K, kind: ThreadKind, note: string, status: readonly string[], right: string, title?: string): HTMLElementTagNameMap[K] {
  const node = el(tag, 'strip');
  const name = kindLabel(kind);
  name.title = note;
  node.append(name, ...(title === undefined ? [] : [el('span', 'title', title)]), el('span', 'gap'), ...(status.length ? [el('span', 'pill state', status.join(' · '))] : []), el('span', 'muted', right));
  return node;
}

function threadBox(thread: Thread): HTMLElement {
  const github = thread.source === 'github';
  const fromAnalysis = thread.source === 'local' && thread.origin === 'analysis';
  const finding = thread.source === 'local' && thread.origin === 'review' ? thread.finding : undefined;
  const fromClaude = fromAnalysis || (thread.source === 'local' && thread.origin === 'review');
  const box = el('details', 'thread ' + thread.source + (thread.pending ? ' pending' : '') + (fromAnalysis ? ' analysis' : '') + (thread.source === 'local' && thread.origin === 'review' ? ' review' : ''));
  box.id = 'thread-' + thread.id;
  box.open = threadOpen.get(thread.id) ?? !thread.resolved;
  box.addEventListener('toggle', () => {
    // With comments in the margin a diff thread starts as a mark, so its open state is always kept.
    const inMargin = marginThreads && box.parentElement?.closest('details.thread') === null && box.closest('tr.inline') !== null;
    if (!inMargin && box.open === !thread.resolved) threadOpen.delete(thread.id); else threadOpen.set(thread.id, box.open);
    if (inMargin && !box.open) renderFiles([thread.path]);
  });
  const status = github ? thread.status.split(' · ').filter((part) => part !== 'Open' && part !== 'Pending')
    : thread.status.split(' · ').filter((part) => !fromClaude || part !== 'Answered');
  const summary = strip('summary', threadKind(thread),
    github ? (thread.pending ? 'Only you see it until you submit your review.' : 'Everyone on the PR sees it.') : fromAnalysis ? 'From Claude\'s guide. Reply to ask about it.' : fromClaude ? 'From Claude\'s code review. Reply to ask about it.' : 'Only you and Claude see it.',
    status, thread.scope === 'pullRequest' ? 'Whole PR' : thread.scope === 'file' ? 'Whole file' : (thread.side === 'old' ? 'Base · ' : '') + range(thread.startLine, thread.endLine), thread.source === 'local' ? thread.title : undefined);
  summary.addEventListener('click', () => { if (box.open) keepInView(box, summary); });
  if (finding !== undefined) {
    summary.querySelector('.source')?.after(...agentTags(finding.reviewers));
    summary.querySelector('.gap')?.after(...findingMarks(finding));
  }
  if (thread.url) {
    const open = el('button', 'icon-button');
    open.append(icon(icons.github));
    open.setAttribute('aria-label', 'Open on GitHub');
    open.dataset.tip = 'Open on GitHub';
    open.addEventListener('click', (event) => { event.preventDefault(); event.stopPropagation(); post({ action: 'github', id: thread.id }); });
    summary.append(open);
  }
  box.append(summary);
  const folded = thread.messages.length > foldThreadsAbove ? thread.messages.length - unfoldedMessages : 0;
  const foldedItems: HTMLElement[] = [];
  const nested = github ? nestedIn(thread.id) : [];
  const startedBy = (time: string): Thread[] => nested.splice(0, nested.filter((local) => started(local) <= Date.parse(time)).length);
  thread.messages.forEach((entry, index) => {
    box.append(...startedBy(entry.createdAt).map(threadBox));
    const item = message(entry, thread);
    if (thread.source === 'local' && thread.newAnswer !== undefined && index === thread.messages.length - 1) watchAnswer(item, thread);
    if (index < folded) {
      item.hidden = !threadUnfolded.has(thread.id);
      foldedItems.push(item);
    }
    if (index === 0 && folded > 0) {
      const label = (): string => `${threadUnfolded.has(thread.id) ? 'Hide' : 'Show'} ${folded} earlier ${folded === 1 ? 'message' : 'messages'}`;
      const toggle = iconButton(icons.earlier, label(), () => {
        if (!threadUnfolded.delete(thread.id)) threadUnfolded.add(thread.id);
        for (const each of foldedItems) each.hidden = !threadUnfolded.has(thread.id);
        toggle.replaceChildren(icon(icons.earlier), label());
        toggle.classList.toggle('shown', threadUnfolded.has(thread.id));
      }, 'quiet unfold');
      toggle.classList.toggle('shown', threadUnfolded.has(thread.id));
      box.append(toggle);
    }
    const suggestions = 'suggestions' in entry ? entry.suggestions : undefined;
    if (thread.source === 'local' && thread.side === 'new' && suggestions?.length) {
      const main = item.querySelector('.msg-main');
      main?.append(suggestionCard(thread, index, suggestions));
      // A finding's evidence comes after its fix.
      const evidence = main?.querySelector('.msg-text > details.md-details:last-child');
      if (evidence) { const tail = el('div', 'msg-text'); tail.append(evidence); main?.append(tail); }
    }
    box.append(item);
    const made = thread.source === 'local' ? thread.commits?.filter((commit) => commit.after === index) : undefined;
    if (made?.length) {
      const list = claudeCommits(made);
      list.hidden = item.hidden;
      if (index < folded) foldedItems.push(list);
      box.append(list);
    }
  });
  const unplaced = thread.source === 'local' ? thread.commits?.filter((commit) => commit.after === undefined || commit.after >= thread.messages.length) : undefined;
  if (unplaced?.length) box.append(claudeCommits(unplaced));
  box.append(...nested.map(threadBox));
  const working = thread.source === 'local' ? thread.working : undefined;
  if (working) {
    const live = el('div', 'claude-live');
    live.dataset.thread = thread.id;
    const progress = thread.source === 'local' ? thread.progress : undefined;
    const controls = el('span', 'step-actions');
    const takeBack = thread.source === 'local' && thread.linkedTo === undefined && thread.scope !== 'pullRequest' && thread.messages.at(-1)?.author === 'human';
    // Local mode has no run of its own to stop, so its Stop only takes the comment back.
    if (takeBack) controls.append(withdrawButton(thread));
    else if (!current?.localMode) controls.append(stopButton());
    live.append(progress === undefined ? stepLog([{ verb: working, done: false }], undefined, controls, waitMotion(thread.id)) : stepLog(progress.steps, progress.startedAt, controls, runMotion(progress)));
    box.append(live);
  }
  const key = 'reply:' + thread.id;
  const actions = el('div', 'row actions composer-actions');
  const reply = replies.get(thread.id);
  if (reply !== undefined && !thread.resolved) {
    const cancel = (): void => { replies.delete(thread.id); save(); redrawThread(thread); };
    const send = (message: PageMessage): void => {
      sending.add(key);
      $('error').textContent = '';
      redrawThread(thread);
      post(message);
    };
    const submit = (intent: Intent = 'ask'): void => {
      const text = replies.get(thread.id) ?? '';
      // A local thread already holds the request, so Implement may go without a note.
      if ((!text.trim() && (github || intent !== 'implement')) || sending.has(key)) return;
      send(github ? { action: 'github-reply', form: key, id: thread.id, text } : { action: 'reply', form: key, id: thread.id, text, intent });
    };
    const askClaude = (intent: Intent): void => {
      if (sending.has(key)) return;
      send({ action: 'github-ask', form: key, id: thread.id, text: replies.get(thread.id) ?? '', intent });
    };
    const needText: HTMLButtonElement[] = [];
    const onReply = (value: string): void => { replies.set(thread.id, value); save(); for (const each of needText) each.disabled = sending.has(key) || !value.trim(); };
    box.append(github ? githubField(key, reply, 'Reply on GitHub, or tell the agent what to do', onReply, () => submit(), cancel)
      : textarea(key, reply, 'Reply', onReply, () => submit(), cancel));
    const busySending = sending.has(key);
    const primaryLabel = busySending ? 'Sending…' : !github ? 'Ask' : thread.pending ? 'Add to pending review' : 'Post on GitHub';
    const primary = github ? button(primaryLabel, () => submit(), 'primary') : agentButton('ask', primaryLabel, () => submit());
    primary.disabled = busySending;
    actions.append(el('span', 'gap'), button('Cancel', cancel, 'quiet'));
    if (github || (thread.draft !== undefined && !thread.url && !current?.localMode)) actions.append(draftReplyButton(thread, () => replies.get(thread.id) ?? ''));
    if (github) {
      const implement = agentButton('implement', 'Implement', () => askClaude('implement'));
      implement.title = 'Only the agent sees it. Agent changes the code';
      const ask = agentButton('ask', 'Ask', () => askClaude('ask'), false);
      ask.title = 'Only the agent sees it. Agent answers in a local thread without editing';
      for (const each of [implement, ask]) { each.disabled = busySending; actions.append(each); }
    } else {
      primary.title = 'Agent answers without editing';
      const implement = agentButton('implement', 'Implement', () => submit('implement'));
      implement.title = 'Agent changes the code. Without a note, it implements what the thread discussed';
      implement.disabled = busySending;
      needText.push(primary);
      onReply(reply);
      actions.append(implement);
    }
    actions.append(primary);
    box.append(actions);
    return box;
  }
  if (thread.source === 'local' && isArchived(thread)) {
    actions.append(el('span', 'gap'), iconButton(icons.unarchive, 'Unarchive', () => setArchived(thread, false)));
    box.append(actions);
    return box;
  }
  const draft = thread.source === 'local' ? publishing.get(thread.id) : undefined;
  if (thread.source === 'local' && draft !== undefined && !thread.url) {
    box.append(publishBox(thread, draft));
    return box;
  }
  actions.append(el('span', 'gap'), ...thread.url || current?.localMode ? [] : [thread.source === 'local' ? toGitHubButton(thread) : titled(iconButton(icons.github, 'Publish', () => post({ action: 'publish', id: thread.id }), 'quiet'), 'Publish to GitHub')]);
  if (thread.source === 'local') {
    const archive = iconButton(icons.archive, 'Archive', () => setArchived(thread, true), 'quiet');
    archive.title = 'Hide this thread. Show archived threads in the filter menu brings it back';
    actions.append(archive);
  }
  actions.append(iconButton(thread.resolved ? icons.reopen : icons.check, thread.resolved ? 'Reopen' : 'Resolve', () => post({ action: github ? 'github-resolve' : 'resolve', id: thread.id, resolved: !thread.resolved })));
  if (!thread.resolved) actions.append(iconButton(icons.reply, 'Reply', () => { replies.set(thread.id, ''); focusNext = key; save(); redrawThread(thread); }));
  box.append(actions);
  return box;
}

/** Set from a Stop click until the state reports Claude idle, so redrawn Stop buttons stay disabled. */
let stoppingClaude = false;

/** Stop Claude's run on this PR; every Stop button on the page turns disabled until it ends. */
function stopClaude(): void {
  stoppingClaude = true;
  for (const stop of document.querySelectorAll<HTMLButtonElement>('#stop-claude, .stop-claude')) stop.disabled = true;
  $('error').textContent = '';
  post({ action: 'stop-claude' });
}

/** Stop beside a thread's live log, for the run that is answering it. */
function stopButton(): HTMLButtonElement {
  const stop = button('', stopClaude, 'icon-button stop-claude');
  stop.append(icon(icons.stop));
  setTip(stop, 'Stop. The comments it was answering wait for Retry.');
  stop.disabled = stoppingClaude;
  return stop;
}

/** Stop beside a thread's live log that stops the run answering the thread's latest comment and puts the comment back in a box to edit. */
function withdrawButton(thread: Thread): HTMLButtonElement {
  const key = 'withdraw:' + thread.id;
  const stop = button('', () => {
    sending.add(key);
    $('error').textContent = '';
    renderFiles([thread.path]);
    post({ action: 'withdraw', form: key, id: thread.id });
  }, 'icon-button');
  stop.append(icon(icons.stop));
  setTip(stop, current?.localMode ? 'Take this comment back to edit it' : 'Stop and take this comment back to edit it');
  stop.disabled = sending.has(key);
  return stop;
}

/** Put a comment taken back into its thread's reply box, or into a new comment box where it was. */
function restoreComment(restored: NonNullable<ExtensionMessage['restored']>): void {
  sending.delete('withdraw:' + restored.thread);
  const before = restored.scope === 'file' ? fileComposer?.path : composer?.path;
  if (!restored.threadRemoved) {
    replies.set(restored.thread, restored.text);
    focusNext = 'reply:' + restored.thread;
  } else if (restored.scope === 'file') {
    fileComposer = { path: restored.path, text: restored.text };
    focusNext = 'file-composer';
  } else {
    composer = { path: restored.path, side: restored.side, start: restored.startLine, end: restored.endLine, text: restored.text, target: 'claude' };
    focusNext = 'composer';
  }
  collapsed.set(restored.path, false);
  save();
  renderFiles([before, restored.path]);
}

/** Reply in the GitHub thread this local thread sits in, else open the box that posts it on the diff. */
function toGitHubButton(thread: Thread & { readonly source: 'local' }): HTMLButtonElement {
  const parent = current?.github?.find((github) => github.id === thread.linkedTo);
  if (thread.linkedTo !== undefined && thread.scope !== 'pullRequest') {
    return titled(iconButton(icons.github, 'Reply', () => {
      if (parent === undefined || parent.resolved) {
        if (parent) threadOpen.set(parent.id, true);
        post({ action: 'publish', id: thread.id });
        return;
      }
      if (!replies.get(parent.id)?.trim()) replies.set(parent.id, thread.draft ?? '');
      focusNext = 'reply:' + parent.id;
      save();
      renderFiles([parent.path]);
    }, 'quiet'), 'Reply on GitHub');
  }
  return titled(iconButton(icons.github, 'Publish', () => { publishing.set(thread.id, thread.draft ?? ''); focusNext = 'publish:' + thread.id; save(); redrawThread(thread); }, 'quiet'), 'Publish to GitHub');
}

/**
 * Ask Claude to write the thread's GitHub comment from `notes`, the form's text: a local thread's Publish form opens with it,
 * a GitHub thread's Reply form gets it in place of the notes.
 */
function draftReply(thread: Thread, notes: string): void {
  const key = 'draft:' + thread.id;
  if (sending.has(key)) return;
  sending.add(key);
  $('error').textContent = '';
  redrawThread(thread);
  post({ action: thread.source === 'github' ? 'github-draft-reply' : 'draft-reply', form: key, id: thread.id, text: notes });
}

/** Draft reply in a Reply or Publish form; `notes` reads the form's text when clicked. */
function draftReplyButton(thread: Thread, notes: () => string): HTMLButtonElement {
  const drafting = sending.has('draft:' + thread.id);
  const draft = agentButton('draft', drafting ? 'Drafting…' : 'Draft reply', () => draftReply(thread, notes()), false);
  draft.disabled = drafting || current?.claude.running === true;
  draft.title = current?.claude.running ? 'Claude is working on this PR. Draft when it is done'
    : 'Agent writes the GitHub comment from this text: your notes, or a draft to revise. You edit it before posting';
  return draft;
}

/** Edit a local thread's comment and post it on the PR diff, now or into the pending review. */
function publishBox(thread: Thread & { readonly source: 'local' }, draft: string): DocumentFragment {
  const key = 'publish:' + thread.id;
  const cancel = (): void => { publishing.delete(thread.id); previewTabs.delete(key); save(); redrawThread(thread); };
  const send = (pending: boolean): void => {
    const text = publishing.get(thread.id) ?? '';
    if (!text.trim() || sending.has(key)) return;
    sending.add(key);
    sentPending = pending;
    $('error').textContent = '';
    redrawThread(thread);
    post({ action: 'github-publish', form: key, id: thread.id, text, pending });
  };
  const onPullRequest = thread.scope === 'pullRequest';
  const field = githubField(key, draft, 'Comment on GitHub', (value) => { publishing.set(thread.id, value); save(); }, () => send(!onPullRequest), cancel);
  const busySending = sending.has(key);
  if (onPullRequest) {
    const comment = button(busySending ? 'Sending…' : 'Comment', () => send(false), 'primary');
    comment.disabled = busySending;
    comment.title = 'Posts in the PR conversation right away. Everyone on the PR sees it.';
    const row = el('div', 'row actions composer-actions');
    row.append(el('span', 'gap'), button('Cancel', cancel, 'quiet'), draftReplyButton(thread, () => publishing.get(thread.id) ?? ''), comment);
    const fragment = document.createDocumentFragment();
    fragment.append(field, row);
    return fragment;
  }
  const review = button(busySending && sentPending ? 'Sending…' : 'Add to pending review', () => send(true), 'primary');
  review.disabled = busySending;
  review.title = 'Goes into your pending review. Nobody sees it until you submit the review.';
  const reviewing = current?.details?.pendingComments !== undefined;
  const now = button(busySending && !sentPending ? 'Sending…' : 'Post now', () => send(false));
  now.disabled = busySending || reviewing;
  now.title = reviewing ? 'You have a review in progress, so GitHub adds new comments to it. Submit the review to publish them.' : 'Posts on GitHub right away.';
  const row = el('div', 'row actions composer-actions');
  row.append(...reviewing ? [titled(el('span', 'chip pending', 'Review in progress'), 'New comments go into your pending review.')] : [], el('span', 'gap'), button('Cancel', cancel, 'quiet'), draftReplyButton(thread, () => publishing.get(thread.id) ?? ''), now, review);
  const fragment = document.createDocumentFragment();
  fragment.append(field, row);
  return fragment;
}

/** Commits whose changes are unfolded in their Local thread. */
const openCommits = new Set<string>();
/** Each unfolded commit's changes, `loading` while the extension reads them, or why it could not. */
const commitDiffs = new Map<string, readonly FileDiff[] | 'loading' | { readonly error: string }>();

/** Redraw the files whose Local threads list a commit. */
function renderCommitThreads(oid: string): void {
  renderFiles((current?.threads ?? []).filter((thread) => thread.commits?.some((commit) => commit.oid === oid)).map((thread) => thread.path));
}

/** The commits Claude made in a local thread; each folds open to its changes, and its hash shows them in the Files tab. Commits GitHub does not list yet are marked as not pushed. */
function claudeCommits(commits: readonly { readonly oid: string; readonly subject: string }[]): HTMLElement {
  const list = el('div', 'commit-list thread-commits');
  for (const commit of commits) {
    const open = openCommits.has(commit.oid);
    const row = el('div', 'commit-row');
    const chevron = chevronMark(!open);
    chevron.title = open ? 'Hide the changes' : 'Show the changes here';
    chevron.addEventListener('click', () => {
      if (open) openCommits.delete(commit.oid);
      else {
        openCommits.add(commit.oid);
        if (!Array.isArray(commitDiffs.get(commit.oid))) { commitDiffs.set(commit.oid, 'loading'); post({ action: 'commit-diff', oid: commit.oid }); }
      }
      renderCommitThreads(commit.oid);
    });
    const hash = button(commit.oid.slice(0, 7), () => { showCommits(commit.oid, commit.oid); }, 'ref');
    hash.title = 'Show this commit in the Files tab';
    row.append(chevron, hash, el('span', 'text', commit.subject), ...isUnpushed(commit.oid) ? [el('span', 'chip', 'Not pushed')] : []);
    list.append(row);
    if (open) list.append(commitPreview(commitDiffs.get(commit.oid)));
  }
  return list;
}

/** A commit's changes as a read-only unified diff, file by file. */
function commitPreview(diff: readonly FileDiff[] | 'loading' | { readonly error: string } | undefined): HTMLElement {
  const box = el('div', 'commit-preview');
  if (diff === undefined || diff === 'loading') { box.append(el('div', 'note muted', 'Loading changes…')); return box; }
  if (!Array.isArray(diff)) { box.append(el('div', 'note bad', 'Could not read the changes: ' + (diff as { readonly error: string }).error)); return box; }
  for (const file of diff as readonly FileDiff[]) {
    const card = el('div');
    const head = el('div', 'preview-file');
    head.append(el('span', 'name', file.oldPath ? file.oldPath + ' → ' + file.path : file.path), el('span', 'stat-add', '+' + file.additions), el('span', 'stat-del', '−' + file.deletions));
    card.append(head);
    box.append(card);
    if (file.binary || !file.hunks.length) { card.append(el('div', 'note muted', file.binary ? 'Binary file not shown.' : 'No content changes.')); continue; }
    const table = el('table');
    const columns = el('colgroup');
    for (const name of ['num', 'num', '']) columns.append(el('col', name));
    table.append(columns);
    for (const hunk of file.hunks) {
      const header = el('tr', 'hunk');
      const cell = el('td', 'muted', hunk.header);
      cell.colSpan = 3;
      header.append(cell);
      table.append(header);
      for (const line of hunk.lines) {
        const row = el('tr', line.kind === 'context' ? '' : line.kind);
        const code = el('td', 'code');
        code.innerHTML = line.html;
        row.append(el('td', 'num', line.oldLine === undefined ? '' : String(line.oldLine)), el('td', 'num', line.newLine === undefined ? '' : String(line.newLine)), code);
        table.append(row);
      }
    }
    card.append(table);
  }
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
  apply.title = current?.localMode ? 'Changes the file. Nothing is committed.' : !canPush ? 'Changes the file in the PR worktree. Nothing is committed, since you cannot push to this PR.'
    : current?.unpushed?.length ? 'Commits the change after the unpushed commits. Push them together.' : 'Commits the change to the PR branch and pushes it.';
  publish.hidden = current?.localMode === true;
  const done = thread.applied?.message === index ? thread.applied : undefined;
  if (done === undefined) actions.append(el('span', 'gap'), publish, apply);
  else if (done.done === 'pushed') actions.append(el('span', 'muted gap', 'Option ' + (done.option + 1) + ' committed and pushed.'));
  else if (done.done === 'committed') actions.append(el('span', 'muted gap', 'Option ' + (done.option + 1) + ' committed, not pushed yet.'));
  else actions.append(el('span', 'muted gap', 'Option ' + (done.option + 1) + (current?.localMode ? ' applied, not committed.' : ' applied to the worktree, not committed.')), button('Discard', () => post({ action: 'discard-suggestion', id: thread.id })), publish);
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

/** A collapsed thread as a dot in its line's number cell; clicking it opens the thread in the diff. */
function marginMark(row: HTMLTableRowElement, side: DiffSide, thread: Thread): void {
  const cell = row.querySelectorAll<HTMLTableCellElement>('td.num')[side === 'new' ? 1 : 0];
  if (cell === undefined) return;
  let marks = cell.querySelector<HTMLElement>('.margin-marks');
  if (marks === null) {
    marks = el('span', 'margin-marks');
    cell.classList.add('has-marks');
    cell.prepend(marks);
  }
  const kind = threadKind(thread);
  const mark = el('button', 'margin-mark ' + kind);
  const title = (thread.source === 'local' ? thread.title : undefined) ?? thread.text;
  hoverPreview(mark, thread);
  mark.setAttribute('aria-label', 'Open comment: ' + title);
  mark.addEventListener('mousedown', (event) => { event.stopPropagation(); });
  mark.addEventListener('click', (event) => {
    event.stopPropagation();
    threadOpen.set(thread.id, true);
    focusThread = thread.id;
    renderFiles([thread.path]);
  });
  marks.append(mark);
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
  if (thread.scope === 'pullRequest') {
    if (view !== 'overview') setView('overview');
    conversationAll = true;
    if (conversationFolded) { conversationFolded = false; save(); }
    threadOpen.set(thread.id, true);
    if (current) renderConversation(current, true);
    document.getElementById('thread-' + thread.id)?.scrollIntoView({ block: 'center' });
    return;
  }
  if (!files?.some((file) => file.path === thread.path)) {
    post({ action: thread.source === 'github' ? 'github' : 'thread', id: thread.id });
    return;
  }
  if (!inFiles(thread)) { if (view !== 'guide') setView('guide'); } else if (view === 'overview' || (view === 'guide' && !document.getElementById('thread-' + thread.id))) setView('files');
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
  return JSON.stringify([viewed.has(path), collapsed.get(path) === true, readRanges.filter((marked) => marked.path === path), threads, current?.local?.[path] ?? null,
    composer?.path === path ? [author, current?.details?.pendingComments] : null,
    // Draft reply disables itself while Claude runs, so an open form redraws when the run ends.
    threads.some((thread) => replies.has(thread.id) || publishing.has(thread.id)) ? current?.claude.running === true : null]);
}

/** Ids of the read ranges covering every selected diff line, or undefined when some selected line is unread. */
function selectedReadIds(file: FileDiff, selection: LineRange): string[] | undefined {
  return rangeReadIds(file, readRanges, selection);
}

/** `expandKey` names where shown context lines are kept; a guide step passes its own so its slice does not share the file's. */
function table(file: FileDiff, threads: readonly Thread[], placed: Set<string>, draft: Composer | null | undefined = composer?.path === file.path ? composer : undefined, expandKey = file.path): HTMLTableElement {
  const node = el('table');
  const columns = el('colgroup');
  // An unchanged file has the same lines on both sides, so it shows them once with one line number.
  const single = file.change === 'unchanged';
  const split = layout === 'split' && !single;
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
        if (marginThreads && !hidden && threadOpen.get(thread.id) !== true) marginMark(row, side, thread);
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
  const read = readLines(file, readRanges);
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
    if (hidden > 0 && atHead) {
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
    if (!contextLines.has(file.path) || !atHead) { expander(gap, index, header); return; }
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
  for (const name of ['overview', 'files', 'guide'] as const) $('view-' + name).setAttribute('aria-selected', String(view === name));
  $('panel-overview').hidden = view !== 'overview';
  $('panel-files').hidden = view === 'overview';
  $('files-bar').classList.toggle('on-overview', view === 'overview');
  showGuideTab();
  renderRangeControls();
  setTip($('fold-all'), allFolded() ? 'Expand all files' : 'Collapse all files');
  $('fold-all').innerHTML = allFolded() ? icons.expandAll : icons.collapseAll;
  if (!files || view === 'overview') return;
  if (focusThread !== undefined) {
    const id = focusThread;
    focusThread = undefined;
    requestAnimationFrame(() => { document.getElementById('thread-' + id)?.querySelector('summary')?.focus({ preventScroll: true }); });
  }
  if (view === 'guide') { keepView(() => renderGuide(only)); return; }
  const opened = filteredFiles(openedFiles());
  const changes = files.filter((file) => file.change !== 'unchanged');
  const shownChanges = filteredFiles(changes);
  const shownFiles = [...shownChanges, ...opened];
  const container = $('files');
  const threadsByFile = new Map<string, Thread[]>();
  for (const thread of allThreads().filter(inFiles)) {
    const list = threadsByFile.get(thread.path) ?? [];
    threadsByFile.set(thread.path, list);
    list.push(thread);
  }
  const tree = fileTree(shownChanges);
  $('files').parentElement?.classList.remove('no-nav');
  renderFileNav(shownChanges, opened, threadsByFile);
  const visible = !folders ? shownFiles : shownFiles.filter((file) => !folderOf(file.path).some((folder) => collapsed.get('folder:' + folder) === true));
  const boxes = new Map([...container.querySelectorAll<HTMLElement>('.file[data-path]')].map((node) => [node.dataset.path, node]));
  const threadsOf = (path: string): Thread[] => threadsByFile.get(path) ?? [];
  const changed = only === 'state' ? visible.map((file) => file.path).filter((path) => fileKeys.get(path) !== fileKey(path, threadsOf(path))) : only;
  const targets = changed && boxes.size === visible.length ? [...new Set(changed.filter((path): path is string => path !== undefined))] : undefined;
  const draw = (file: FileDiff): HTMLElement => {
    fileKeys.set(file.path, fileKey(file.path, threadsOf(file.path)));
    return fileBox(file, threadsOf(file.path));
  };
  const redrawn = targets?.every((path) => boxes.has(path)) ? targets.flatMap((path) => boxes.get(path) ?? []) : undefined;
  keepView(() => {
    if (redrawn && targets) {
      for (const path of targets) {
        const file = shownFiles.find((item) => item.path === path);
        if (file) boxes.get(path)?.replaceWith(draw(file));
      }
    } else {
      container.replaceChildren();
      fileKeys.clear();
      if (!shownFiles.length) container.append(el('p', 'muted', changes.length || openedFiles().length ? 'No files match the filter.' : current?.localMode ? 'No uncommitted changes. Pick a file in the Local view to review it.' : diffRange.kind === 'all' ? 'No changes against the base branch.' : 'No changes in ' + rangeLabel(diffRange) + '.'));
      const append = (parent: HTMLElement, folder: FileFolder<FileDiff>, depth: number): void => {
        for (const child of folder.folders) {
          const isCollapsed = collapsed.get('folder:' + child.path) === true;
          const head = el('div', 'folder-head');
          head.dataset.folder = child.path;
          const holdsLocal = Object.keys(current?.local ?? {}).some((path) => path.startsWith(child.path + '/'));
          head.append(el('span', 'name', child.name), ...(holdsLocal ? [localMarkOf('unpushed', 'Holds files with work GitHub does not have yet')] : []), el('span', 'muted progress'));
          const { node, rail } = railNode(head, depth, isCollapsed, () => { collapsed.set('folder:' + child.path, !isCollapsed); save(); renderFiles(); });
          put(parent, depth, node);
          if (!isCollapsed) append(rail, child, depth + 1);
        }
        for (const file of folder.files) put(parent, depth, draw(file));
      };
      const put = (parent: HTMLElement, depth: number, child: HTMLElement): void => { parent.append(depth === 0 ? child : railItem(child)); };
      if (folders) append(container, tree, 0);
      else for (const file of shownChanges) container.append(draw(file));
      for (const file of opened) container.append(draw(file));
    }
    if (folders) updateFolderProgress(tree);
    for (const frame of container.querySelectorAll<HTMLIFrameElement>('iframe.html-preview')) layoutMargin(frame, frameTops.get(frame.dataset.path ?? '') ?? {});
  }, container, redrawn);
  markCurrentNavFile();
}

/** Folders opened or folded in the file navigator by hand, apart from the file list's own folders. */
const navFolders = new Map<string, boolean>();
/** Whether the navigator is folded to its heading in a narrow window. */
let navFolded = true;

/** A navigator entry: a file on the page, or with All files on, a repository file the page does not show yet. */
interface NavEntry { readonly path: string; readonly file?: FileDiff }

/**
 * The file navigator beside the diffs: icon, name, open comments, Git letter and a Viewed tick per file.
 * Opened unchanged files lead in their own group; with All files on, the whole repository follows as one tree.
 */
function renderFileNav(changes: readonly FileDiff[], opened: readonly FileDiff[], threadsByFile: ReadonlyMap<string, readonly Thread[]>): void {
  const nav = $('file-nav');
  nav.classList.toggle('folded', navFolded);
  const head = el('button', 'nav-head');
  head.setAttribute('aria-expanded', String(!navFolded));
  const total = (files ?? []).filter((file) => file.change !== 'unchanged').length;
  const done = changes.filter((file) => viewed.has(file.path)).length;
  const query = fileFilter.trim().toLowerCase();
  const entries: NavEntry[] = allFiles ? repositoryEntries().filter((entry) => entry.file ? changes.includes(entry.file) || opened.includes(entry.file)
    : (!query || entry.path.toLowerCase().includes(query)) && !hiddenTypes.has(fileType(entry.path))) : [];
  if (allFiles) head.append(chevronMark(navFolded), (changes.length < total ? changes.length + ' of ' + total : total) + ' changed', el('span', 'muted', done + ' viewed · ' + entries.length + (entries.length === 1 ? ' file' : ' files')));
  else head.append(chevronMark(navFolded), (changes.length < total ? changes.length + ' of ' + total : changes.length) + (total === 1 ? ' file' : ' files'), el('span', 'muted', done + ' viewed'));
  head.addEventListener('click', () => { navFolded = !navFolded; renderFileNav(changes, opened, threadsByFile); });
  const list = el('ul', 'nav-list');
  const redraw = (): void => { renderFileNav(changes, opened, threadsByFile); };
  const holdsShown = (folder: FileFolder<NavEntry>): boolean => folder.files.some((entry) => entry.file !== undefined) || folder.folders.some(holdsShown);
  const holdsChange = (folder: FileFolder<NavEntry>): boolean => folder.files.some((entry) => entry.file !== undefined && entry.file.change !== 'unchanged') || folder.folders.some(holdsChange);
  const add = (folder: FileFolder<NavEntry>, depth: number): void => {
    for (const child of folder.folders) {
      const isCollapsed = navFolders.get(child.path) ?? (allFiles && !holdsShown(child));
      const row = el('li', 'nav-folder');
      row.style.setProperty('--depth', String(depth));
      row.title = child.path;
      row.append(chevronMark(isCollapsed), el('span', 'nav-name', child.name));
      if (allFiles && holdsChange(child)) row.append(titled(el('span', 'nav-dot'), 'Holds changed files'));
      row.addEventListener('click', () => { navFolders.set(child.path, !isCollapsed); redraw(); });
      list.append(row);
      if (!isCollapsed) add(child, depth + 1);
    }
    for (const entry of folder.files) list.append(navFile(entry, depth, threadsByFile.get(entry.path) ?? []));
  };
  if (opened.length) {
    const group = el('li', 'nav-group');
    group.append('Opened', el('span', 'muted', String(opened.length)));
    const closable = opened.filter((file) => !threadsByFile.get(file.path)?.length).map((file) => file.path);
    if (closable.length) {
      const closeAll = button('', () => { closeFiles(closable); }, 'quiet small nav-close-all');
      closeAll.textContent = 'Close all';
      group.append(closeAll);
    }
    list.append(group);
    for (const file of opened) list.append(navFile({ path: file.path, file }, 0, threadsByFile.get(file.path) ?? [], true));
    if (changes.length || allFiles) list.append(el('li', 'nav-sep'));
  }
  add(allFiles ? fileTree(entries) : fileTree(changes.map((file): NavEntry => ({ path: file.path, file }))), 0);
  nav.replaceChildren(head, list);
  markCurrentNavFile();
}

/** Every repository file with the page's file for it, plus page files the repository no longer lists, such as deleted ones. */
function repositoryEntries(): NavEntry[] {
  const byPath = new Map((files ?? []).map((file) => [file.path, file]));
  const entries = repositoryFiles.map((path): NavEntry => { const file = byPath.get(path); return file ? { path, file } : { path }; });
  const listed = new Set(repositoryFiles);
  for (const file of files ?? []) if (!listed.has(file.path)) entries.push({ path: file.path, file });
  return entries;
}

/** One navigator row; `closable` adds × to an opened file that has no comments. */
function navFile(entry: NavEntry, depth: number, threads: readonly Thread[], closable = false): HTMLElement {
  const { path, file } = entry;
  const item = el('li');
  const isViewed = file !== undefined && viewed.has(path);
  const row = el('button', 'nav-file' + (isViewed ? ' done' : '') + (file === undefined || file.change === 'unchanged' ? ' unchanged' : ''));
  row.style.setProperty('--depth', String(depth));
  row.dataset.navPath = path;
  row.title = path;
  const themeIcon = fileIcons?.byPath[path];
  row.append(themeIcon ? iconNode(themeIcon) : el('span', 'file-icon'), el('span', 'nav-name', path.split('/').at(-1) ?? path));
  const open = threads.filter((thread) => !thread.resolved).length;
  if (open) {
    const count = el('span', 'nav-count', String(open));
    count.title = open + (open === 1 ? ' open comment' : ' open comments');
    row.append(count);
  }
  if (file && file.change !== 'unchanged') {
    const badge = el('span', 'badge ' + file.change, changeLetters[file.change]);
    badge.title = file.change;
    row.append(badge);
  }
  const done = el('span', 'nav-done');
  if (isViewed) {
    done.title = 'Viewed';
    done.append(icon(icons.check));
  }
  row.append(done);
  row.addEventListener('click', () => { if (file) showFile(path); else post({ action: 'open-file', path }); });
  item.append(row);
  if (closable && !threads.length) {
    const close = button('', () => { closeFiles([path]); }, 'icon-button nav-close');
    close.append(icon(icons.close));
    setTip(close, 'Close');
    item.classList.add('closable');
    item.append(close);
  }
  return item;
}

/** Scroll the file list to a file, opening its box and folders first when they are closed. */
function showFile(path: string): void {
  const box = (): HTMLElement | null => $('files').querySelector<HTMLElement>('.file[data-path="' + CSS.escape(path) + '"]');
  const present = box();
  if (!present || collapsed.get(path) === true) {
    collapsed.set(path, false);
    openFolders(path);
    save();
    renderFiles(present ? [path] : undefined);
  }
  box()?.scrollIntoView({ block: 'start' });
}

/** Round a pinned file header into a closed card once its file's end reaches it, so no box edge peeks out below. */
function markEndingFiles(): void {
  for (const box of $('files').querySelectorAll<HTMLElement>('.file')) {
    const head = box.querySelector<HTMLElement>(':scope > .file-head');
    const rect = box.getBoundingClientRect();
    if (rect.top > window.innerHeight) break;
    box.classList.toggle('ending', head !== null && rect.top < 0 && rect.bottom - head.getBoundingClientRect().bottom < 2);
  }
}

/** The file or guide step the navigator last highlighted. */
let navTop: string | undefined;

/** Highlight the navigator row of the file or guide step at the top of the view, the first one until any reaches it, and scroll the navigator to it when that changes; `rebuilt` after the rows were redrawn. */
function markCurrentNavFile(rebuilt = true): void {
  const line = (Number.parseFloat(document.body.style.getPropertyValue('--bar-height')) || 46) + 36;
  const guided = view === 'guide';
  let top: string | undefined;
  for (const box of $('files').querySelectorAll<HTMLElement>(guided ? '.step-wrap[data-key]' : '.file[data-path]')) {
    if (top !== undefined && box.getBoundingClientRect().top > line) break;
    top = guided ? box.dataset.key : box.dataset.path;
  }
  const moved = top !== navTop;
  if (!moved && !rebuilt) return;
  navTop = top;
  const nav = $('file-nav');
  let currentRow: HTMLElement | undefined;
  for (const row of nav.querySelectorAll<HTMLElement>('.nav-file')) {
    const isTop = top !== undefined && (guided ? row.dataset.navStep : row.dataset.navPath) === top;
    row.setAttribute('aria-current', String(isTop));
    if (isTop) currentRow = row;
  }
  if (!moved || !currentRow) return;
  const list = nav.getBoundingClientRect();
  const rect = currentRow.getBoundingClientRect();
  if (rect.top < list.top) nav.scrollTop -= list.top - rect.top + rect.height;
  else if (rect.bottom > list.bottom) nav.scrollTop += rect.bottom - list.bottom + rect.height;
}

const localMarks: Record<LocalChange, readonly [string, string]> = {
  unpushed: ['↑', 'Changed in commits not pushed yet'], edited: ['✎', 'Uncommitted edits in the worktree'], both: ['↑✎', 'Unpushed commits and uncommitted edits'],
};

function localMarkOf(change: LocalChange, tip = localMarks[change][1]): HTMLElement {
  const mark = el('span', 'local-mark', localMarks[change][0]);
  mark.title = tip;
  return mark;
}

/** A file's mark for worktree work that GitHub does not have, or nothing. */
function localMark(path: string): HTMLElement[] {
  const change = current?.local?.[path];
  return change === undefined ? [] : [localMarkOf(change)];
}

/** Take opened unchanged files off the page; files with comments stay. */
function closeFiles(paths: readonly string[]): void {
  for (const path of paths) closedFiles.add(path);
  save();
  renderFiles();
  post({ action: 'close-files', paths });
}

/** Files outside the changes opened on the page, shown whole after the changes. A closed file stays off even when the extension keeps it for a hidden thread, such as a guide note. */
function openedFiles(): readonly FileDiff[] {
  const commented = new Set(allThreads().filter(inFiles).map((thread) => thread.path));
  return (files ?? []).filter((file) => file.change === 'unchanged' && (!closedFiles.has(file.path) || commented.has(file.path)));
}

/** A theme file icon: a glyph of an icon font, added to the page on first use, or an image. */
function iconNode(icon: FileIcon): HTMLElement {
  if ('image' in icon) {
    const image = el('img', 'file-icon');
    image.src = fileIcons?.images[icon.image] ?? '';
    image.alt = '';
    return image;
  }
  let family = iconFonts.get(icon.font);
  const data = fileIcons?.fonts[icon.font];
  if (family === undefined && data !== undefined) {
    family = 'file-icons-' + iconFonts.size;
    iconFonts.set(icon.font, family);
    document.head.append(el('style', '', '@font-face{font-family:"' + family + '";src:url("' + data + '")}'));
  }
  const glyph = el('span', 'file-icon', icon.char);
  glyph.setAttribute('aria-hidden', 'true');
  if (family) glyph.style.fontFamily = '"' + family + '"';
  if (icon.color) glyph.style.color = icon.color;
  return glyph;
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

/** Holds live HTML preview frames while their file box is rebuilt; `moveBefore` keeps a frame's page loaded where `append` would reload it. */
const frameParking = el('div');
frameParking.hidden = true;
document.body.append(frameParking);

function parkFrames(scopes: readonly HTMLElement[]): HTMLIFrameElement[] {
  if (typeof frameParking.moveBefore !== 'function') return [];
  const frames = scopes.flatMap((scope) => [...scope.querySelectorAll<HTMLIFrameElement>('iframe.html-preview')]);
  for (const frame of frames) frameParking.moveBefore(frame, null);
  return frames;
}

/** Put each parked frame in place of the new frame for the same file and source, then drop the frames nothing took back. */
function restoreFrames(container: HTMLElement, parked: readonly HTMLIFrameElement[]): void {
  for (const fresh of container.querySelectorAll<HTMLIFrameElement>('iframe.html-preview')) {
    const live = parked.find((frame) => frame.parentElement === frameParking && frame.dataset.path === fresh.dataset.path && frame.srcdoc === fresh.srcdoc);
    if (!live || !fresh.parentElement) continue;
    fresh.parentElement.moveBefore(live, fresh);
    fresh.remove();
    frameMessage(live, { lrReady: true });
  }
  frameParking.replaceChildren();
}

/**
 * Redraw the file list, or `container`, without losing the scroll position, a preview's own scroll position, the draft being typed or a loaded HTML preview.
 * `redrawn` names the boxes `draw` replaces; frames elsewhere stay where they are.
 */
function keepView(draw: () => void, container = $('files'), redrawn: readonly HTMLElement[] = [container]): void {
  const scroll = window.scrollY;
  const active = document.activeElement;
  const focus = active instanceof HTMLTextAreaElement && active.dataset.draft ? { key: active.dataset.draft, start: active.selectionStart, end: active.selectionEnd } : undefined;
  const frames = parkFrames(redrawn);
  const scrolls = new Map([...container.querySelectorAll<HTMLElement>('[data-scroll-key]')].map((node) => [node.dataset.scrollKey, node.scrollTop]));
  draw();
  restoreFrames(container, frames);
  for (const node of container.querySelectorAll<HTMLElement>('[data-scroll-key]')) node.scrollTop = scrolls.get(node.dataset.scrollKey) ?? 0;
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
  const all = allThreads().filter((thread) => standalone(thread) && thread.scope !== 'pullRequest');
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
    const key = thread.scope === 'file' ? steps.find((step) => step.path === thread.path && slices.has(step.key))?.key : owner(thread.path, thread.side, thread.endLine);
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
  if (analysis?.running && analysis.progress !== undefined) {
    const controls = el('span', 'step-actions');
    const stop = button('', () => post({ action: 'analysis-stop' }), 'icon-button');
    stop.append(icon(icons.stop));
    setTip(stop, 'Stop building the guide');
    controls.append(stop);
    card.append(stepLog(analysis.progress.steps, analysis.progress.startedAt, controls, () => ['lead']));
    return card;
  }
  const row = el('div', 'row');
  const start = button(analysis?.running ? 'Stop' : 'Build guide', () => post({ action: analysis?.running ? 'analysis-stop' : 'analyze' }), analysis?.running ? '' : 'primary');
  row.append(start);
  if (analysis?.running) row.append(el('span', 'chip agent working', 'Guide · ' + (analysis.step ?? 'Working')));
  else if (analysis?.error) row.append(el('span', 'bad', 'Guide failed: ' + analysis.error));
  else row.append(el('span', 'muted', 'Runs Claude read-only on this PR. Large PRs take a few minutes.'));
  card.append(row);
  return card;
}

function guideSummary(result: Analysis, groups: readonly GuideGroup[]): HTMLElement {
  const card = el('section', 'card guide-intro');
  card.append(el('h3', '', 'Guide'));
  if (current?.analysis.stale) card.append(staleGuideRow(result, groups));
  if (result.overview) card.append(el('p', 'text', result.overview));
  card.append(el('p', 'muted', 'Every change is in exactly one step. Viewed on every step marks the whole PR viewed.'));
  return card;
}

/** Warns that the guide was built for an older head, says what that cost, and offers to rebuild it. */
function staleGuideRow(result: Analysis, groups: readonly GuideGroup[]): HTMLElement {
  const behind = current?.analysis.behind;
  const placed = groups.filter((group) => group.severity !== 'unclassified').reduce((sum, group) => sum + group.steps.length, 0);
  const lost = result.groups.reduce((sum, group) => sum + group.steps.length, 0) - placed;
  const unplaced = groups.find((group) => group.severity === 'unclassified')?.steps.length ?? 0;
  const facts = [
    'Built for ' + result.head.slice(0, 7) + (behind === undefined ? ', which is no longer in the branch' : ', ' + behind + (behind === 1 ? ' commit' : ' commits') + ' behind'),
    lost > 0 ? lost + (lost === 1 ? ' step no longer matches' : ' steps no longer match') : undefined,
    unplaced > 0 ? unplaced + (unplaced === 1 ? ' change is' : ' changes are') + ' in Not placed by the guide' : undefined,
  ].filter(Boolean).join('. ') + '.';
  const row = el('div', 'row range-note stale-guide');
  row.append(icon(icons.warning), el('span', 'gap wait', facts));
  const rebuild = button(current?.analysis.running ? 'Rebuilding…' : 'Rebuild guide', () => { $('error').textContent = ''; post({ action: 'analyze' }); }, 'agent small');
  rebuild.disabled = current?.analysis.running === true;
  row.append(rebuild);
  return row;
}

type ThreadKind = 'github' | 'local' | 'analysis' | 'review';
const threadKinds: readonly ThreadKind[] = ['github', 'local', 'review', 'analysis'];

function threadKind(thread: Thread): ThreadKind {
  return thread.source === 'github' ? 'github' : thread.origin ?? 'local';
}

/** A tag per code review agent that raised a finding. */
function agentTags(names: readonly Reviewer[]): HTMLElement[] {
  return names.map((name) => {
    const tag = el('span', 'agent-tag');
    tag.append(icon(icons[name]), reviewerInfo[name].label);
    return tag;
  });
}

const findingSeverityLabels: Record<Finding['severity'], string> = { high: 'High', medium: 'Medium', low: 'Low' };
const evidenceLabels: Record<Finding['evidence'], [string, string]> = {
  tested: ['Tested', 'A test the reviewer ran shows it.'],
  rewritten: ['Rewritten', 'A simpler version the reviewer wrote passes the tests.'],
  traced: ['Traced', 'The reviewer traced it through the code.'],
  cited: ['Cited', 'A rule or existing code the reviewer quotes backs it.'],
};

/** A finding's severity and how it was proven. */
function findingMarks({ severity, evidence }: Pick<Finding, 'severity' | 'evidence'>): HTMLElement[] {
  const [label, tip] = evidenceLabels[evidence];
  return [el('span', 'sev ' + severity, findingSeverityLabels[severity]), titled(el('span', 'ev ' + evidence, label), tip)];
}

/** A finding's place; a narrow card moves it to its own line, where the folders give way first. */
function findingWhere(path: string, line: number): HTMLElement {
  const node = titled(el('span', 'finding-where'), path + ':' + line);
  const cut = path.lastIndexOf('/') + 1;
  const folder = el('span', 'finding-folder');
  folder.append(el('bdi', '', path.slice(0, cut)));
  node.append(folder, el('span', 'finding-file', path.slice(cut) + ':' + line));
  return node;
}

const dropLabels: Record<DropReason, [string, string]> = {
  'over-cap': ['Over cap', 'Proven, ranked below the top 10'],
  refuted: ['Refuted', 'Verification disproved it'],
  unconfirmed: ['Unconfirmed', 'Verification could not prove or disprove it'],
  duplicate: ['Duplicate', 'Merged into another finding'],
  'out-of-scope': ['Out of scope', 'Style, speculation or preference'],
  unplaced: ['Not placed', 'Its lines are not in the diff'],
};

/** The code review's summary above the files: findings by rank, who ran, and every dropped candidate with its reason. */
function renderReviewCard(): void {
  const card = $('review-card');
  const review = current?.review;
  const result = review?.result;
  const live = review?.running || review?.error !== undefined ? review?.live : undefined;
  card.hidden = result === undefined && live === undefined;
  if (card.hidden) { card.replaceChildren(); return; }
  const cards = live === undefined || review === undefined ? [] : [reviewLiveCard(live, review.running, review.error)];
  if (result === undefined || review?.running) { card.replaceChildren(...cards); return; }
  const box = el('details', 'thread review review-card');
  box.open = collapsed.get('review-card') !== true;
  box.addEventListener('toggle', () => { collapsed.set('review-card', !box.open); save(); });
  const count = result.findings.length;
  box.append(strip('summary', 'review', 'Claude\'s code review of these changes.', [], `${result.candidates} candidates · ${result.dropped.length} dropped`,
    count === 0 ? 'No findings' : count + (count === 1 ? ' finding' : ' findings')));
  const usage = result.usage === undefined ? undefined : usageChip(result.usage);
  box.querySelector('summary')?.append(...timeLabel(result.createdAt), ...usage ? [usage.chip] : []);
  if (usage) box.append(usage.popover);
  const openFindings = localThreads().filter((thread) => thread.source === 'local' && thread.origin === 'review' && !thread.resolved && thread.archived !== true);
  if (openFindings.length > 0) {
    const recheck = agentButton('ask', 'Re-check findings', () => post({ action: 'review-recheck' }), false);
    recheck.classList.add('small');
    recheck.disabled = openFindings.some((thread) => thread.source === 'local' && thread.working !== undefined);
    recheck.title = 'Agent checks each open finding against the current code and answers in its thread, without editing. You resolve the fixed ones';
    const row = el('div', 'row review-recheck');
    row.append(el('span', 'gap muted', openFindings.length === 1 ? '1 open finding' : openFindings.length + ' open findings'), recheck);
    box.append(row);
  }
  const ran = el('div', 'review-ran muted', result.ran.length === 0 ? 'No reviewer ran.' : 'Ran ' + result.ran.map((name) => reviewerInfo[name].label).join(', '));
  for (const { reviewer, reason } of result.skipped) ran.append(el('span', '', ' · Skipped ' + reviewerInfo[reviewer].label + (reason ? ': ' + reason : '')));
  box.append(ran);
  if (count > 0) {
    const list = el('ol', 'finding-list');
    const threads = allThreads();
    for (const finding of result.findings) {
      const thread = threads.find((candidate) => candidate.id === finding.threadId);
      const title = el('button', 'finding-title', finding.title);
      title.disabled = thread === undefined;
      if (thread === undefined) title.title = 'The thread is resolved or gone.';
      title.addEventListener('click', () => { if (thread !== undefined) jump(thread); });
      const item = el('li', thread?.resolved ? 'resolved' : '');
      if (thread?.resolved) title.prepend(stateIcon('done', 'mark', 'Resolved'));
      item.append(el('span', 'sev ' + finding.severity, findingSeverityLabels[finding.severity]), title, el('span', 'finding-agents'), ...findingMarks(finding).slice(1), findingWhere(finding.path, finding.startLine));
      item.querySelector('.finding-agents')?.append(...agentTags(finding.reviewers));
      list.append(item);
    }
    box.append(list);
  }
  if (result.dropped.length > 0) {
    const dropped = el('details', 'review-dropped');
    dropped.open = collapsed.get('review-dropped') === false;
    dropped.addEventListener('toggle', () => { collapsed.set('review-dropped', !dropped.open); save(); });
    const head = el('summary');
    head.append(icon(icons.chevronDown), 'Dropped (' + result.dropped.length + ')');
    dropped.append(head);
    for (const reason of Object.keys(dropLabels) as DropReason[]) {
      const members = result.dropped.filter((item) => item.reason === reason);
      if (members.length === 0) continue;
      const [label, note] = dropLabels[reason];
      const group = el('div', 'drop-group', label);
      group.append(el('span', 'muted', note));
      dropped.append(group);
      for (const item of members) {
        const row = el('div', 'drop');
        const tags = el('span', 'finding-agents');
        tags.append(...agentTags(item.reviewers));
        row.append(el('span', 'drop-claim', item.claim), tags, ...item.why ? [el('span', 'drop-why muted', item.why)] : []);
        dropped.append(row);
      }
    }
    box.append(dropped);
  }
  card.replaceChildren(...cards, box);
}

const usageDuration = (ms: number): string => {
  const seconds = Math.round(ms / 1000);
  return seconds >= 3600 ? `${Math.floor(seconds / 3600)}h ${Math.floor(seconds % 3600 / 60)}m` : seconds >= 60 ? `${Math.floor(seconds / 60)}m ${seconds % 60}s` : `${seconds}s`;
};
const usageCost = (cost: number): string => cost > 0 && cost < 0.01 ? '<$0.01' : '$' + cost.toFixed(2);

/** A review's duration and cost as a chip that opens a popover with turns, list-price cost and tokens per model. */
function usageChip(usage: ReviewUsage): { chip: HTMLButtonElement; popover: HTMLElement } {
  const popover = el('div', 'usage-popover');
  popover.popover = 'auto';
  const summary = el('dl', 'usage-summary');
  for (const [label, value, tip] of [['Duration', usageDuration(usage.durationMs), ''], ['Turns', String(usage.turns), ''], ['Cost', usageCost(usage.cost), 'API list price, not what a subscription bills']] as const) {
    summary.append(el('dt', '', label), titled(el('dd', '', value), tip));
  }
  popover.append(summary, el('div', 'usage-note muted', 'Cost is the API list price.'));
  if (usage.models.length > 0) {
    const table = el('table', 'usage-table');
    const head = el('tr');
    for (const label of ['Model', 'Input', 'Output', 'Cache read', 'Cache write', 'Cost']) head.append(el('th', '', label));
    table.append(head);
    for (const row of usage.models) {
      const line = el('tr');
      line.append(el('td', 'usage-model', row.model));
      for (const tokens of [row.input, row.output, row.cacheRead, row.cacheWrite]) line.append(titled(el('td', '', tokenCount(tokens)), tokens.toLocaleString()));
      line.append(el('td', '', usageCost(row.cost)));
      table.append(line);
    }
    popover.append(table);
  }
  if (usage.agents.length > 0) {
    const table = el('table', 'usage-table');
    const head = el('tr');
    head.append(el('th', '', 'Agent'), titled(el('th', '', 'Cost'), 'Each model\'s cost split by the agents\' share of its tokens, weighted by token price'));
    table.append(head);
    for (const row of usage.agents) {
      const line = el('tr');
      line.append(el('td', '', row.agent === 'orchestrator' ? 'Orchestrator' : reviewerInfo[row.agent].label), el('td', '', usageCost(row.cost)));
      table.append(line);
    }
    popover.append(table);
  }
  const chip = el('button', 'usage-chip', `${usageDuration(usage.durationMs)} · ${usageCost(usage.cost)}`);
  chip.type = 'button';
  titled(chip, 'Time and cost of this review');
  chip.addEventListener('click', (event) => {
    // Inside a card's summary a click would also fold the card.
    event.preventDefault();
    event.stopPropagation();
    if (popover.matches(':popover-open')) { popover.hidePopover(); return; }
    const box = chip.getBoundingClientRect();
    popover.style.top = box.bottom + 4 + 'px';
    popover.style.right = Math.max(8, window.innerWidth - box.right) + 'px';
    popover.showPopover();
  });
  return { chip, popover };
}

const stageLabels: Record<ReviewStage, [string, string]> = {
  triage: ['Triage', 'Claude reads the changes and briefs the reviewers.'],
  candidates: ['Candidates', 'Each reviewer looks for defects.'],
  select: ['Select', 'Claude merges and ranks the candidates.'],
  verify: ['Verify', 'Reviewers prove or refute the top candidates in their own worktrees.'],
  report: ['Report', 'Claude writes up the proven findings.'],
};
const verdictLabels: Record<NonNullable<ReviewLaneItem['verdict']>, string> = { confirmed: 'Confirmed', refuted: 'Refuted', unconfirmed: 'Unconfirmed' };

/** A running or failed review: its stage, the orchestrator's steps and a lane per review agent. */
function reviewLiveCard(live: ReviewLive, running: boolean, error: string | undefined): HTMLElement {
  const box = el('section', 'thread review review-card review-live');
  const head = strip('div', 'review', 'Claude\'s code review of these changes.', [], '', running ? 'Reviewing' : error === 'Stopped.' ? 'Review stopped' : 'Review failed');
  const time = el('span', 'time', elapsed(live.startedAt, live.endedAt));
  if (running) time.dataset.since = String(live.startedAt);
  head.append(time);
  const usage = live.usage === undefined ? undefined : usageChip(live.usage);
  if (usage) head.append(usage.chip);
  if (running) {
    const stop = button('', () => post({ action: 'review-stop' }), 'icon-button');
    stop.append(icon(icons.stop));
    setTip(stop, 'Stop the review');
    head.append(stop);
  }
  box.append(head, ...usage ? [usage.popover] : [], reviewStageBar(live.stage, running));
  if (!running && error !== undefined && error !== 'Stopped.') box.append(el('div', 'review-error', error));
  const lanes = el('div', 'review-lanes');
  const working = live.lanes.filter((lane) => lane.endedAt === undefined).length;
  // Agent calls already show as lanes, and while agents work the orchestrator only waits for them.
  const orchestratorSteps = live.orchestrator.filter((step) => step.verb !== 'Agent' && step.verb !== 'Task');
  const orchestrator = reviewLane(el('span', 'lane-name', 'Orchestrator'), !running ? 'Stopped' : working > 0 ? `Waiting on ${working} ${working === 1 ? 'reviewer' : 'reviewers'}` : '', running && working === 0, orchestratorSteps, running ? live.startedAt : undefined, running ? 'active' : error === undefined || error === 'Stopped.' ? 'idle' : 'failed');
  orchestrator.classList.add('orchestrator');
  lanes.append(orchestrator);
  for (const [index, reviewer] of live.reviewers.entries()) {
    const lane = live.lanes.find((candidate) => candidate.reviewer === reviewer);
    const [tag] = agentTags([reviewer]);
    if (tag === undefined) continue;
    if (lane === undefined) {
      const later = reviewStages.indexOf(live.stage) > reviewStages.indexOf('candidates');
      lanes.append(reviewLane(tag, later || !running ? 'Did not run' : 'Waiting', false, [], undefined, 'idle'));
      continue;
    }
    const busy = running && lane.endedAt === undefined;
    const node = reviewLane(tag, laneStatus(lane, busy), busy, lane.steps, busy ? lane.startedAt : undefined, busy ? 'active' : lane.failed ? 'failed' : lane.endedAt === undefined ? 'idle' : 'done', lane, (index + 1) * orbPhaseMs);
    lanes.append(node);
  }
  box.append(lanes);
  return box;
}

const stageIcons: Record<ReviewStage, string> = { triage: icons.triage, candidates: icons.candidates, select: icons.rank, verify: icons.verify, report: icons.report };

function reviewStageBar(stage: ReviewStage, running: boolean): HTMLElement {
  const bar = el('ol', 'review-stages');
  const at = reviewStages.indexOf(stage);
  reviewStages.forEach((name, index) => {
    const [label, tip] = stageLabels[name];
    const state = index < at ? 'done' : index === at ? (running ? 'now' : 'stopped') : 'next';
    const item = titled(el('li', state), tip);
    const mark = el('span', 'stage-icon');
    mark.append(icon(stageIcons[name]));
    item.append(mark, label);
    bar.append(item);
  });
  return bar;
}

function laneStatus(lane: ReviewLane, busy: boolean): string {
  const items = lane.items ?? [];
  if (busy) return lane.phase === 'verification' ? 'Verifying' : 'Finding candidates';
  if (lane.failed) return 'Failed';
  if (lane.phase === 'candidates') return items.length === 0 ? 'No candidates' : items.length + (items.length === 1 ? ' candidate' : ' candidates');
  const count = (verdict: NonNullable<ReviewLaneItem['verdict']>): number => items.filter((item) => item.verdict === verdict).length;
  return `${count('confirmed')} confirmed · ${count('refuted')} refuted` + (count('unconfirmed') ? ` · ${count('unconfirmed')} unconfirmed` : '');
}

/** One lane: who, what it is doing, its latest steps while it works, and what it handed back once done. */
/** Offsets each lane's orb so side-by-side orbs don't move in lockstep. */
const orbPhaseMs = 1370;

function reviewLane(name: HTMLElement, status: string, busy: boolean, steps: readonly ClaudeStep[], since: number | undefined, state: 'active' | 'done' | 'failed' | 'idle', lane?: ReviewLane, phase = 0): HTMLElement {
  const node = el('div', 'review-lane ' + state);
  const head = el('div', 'lane-head');
  // The running step below carries the orb; the empty icon keeps the lane names aligned.
  const mark = state === 'active' ? el('span', 'state-icon') : stateIcon(state === 'done' ? 'done' : state === 'failed' ? 'failed' : 'idle', state === 'done' ? 'ok' : state === 'failed' ? 'bad' : 'muted');
  head.append(mark, name);
  if (lane !== undefined) head.append(el('span', 'lane-phase muted', lane.phase === 'verification' ? 'verification' : 'candidates'));
  head.append(el('span', 'gap'), el('span', 'lane-status muted', status));
  if (lane?.endedAt !== undefined) head.append(el('span', 'time', elapsed(lane.startedAt, lane.endedAt)));
  node.append(head);
  if (busy || (state === 'failed' && steps.length > 0)) node.append(stepLog(steps, since, undefined, undefined, true, phase));
  if (lane?.items?.length) {
    const items = el('ul', 'lane-items');
    for (const item of lane.items) {
      const row = el('li');
      if (item.verdict !== undefined) row.append(el('span', 'verdict ' + item.verdict, verdictLabels[item.verdict]));
      if (item.severity !== undefined) row.append(el('span', 'sev ' + item.severity, findingSeverityLabels[item.severity]));
      row.append(el('span', 'lane-item', item.title));
      items.append(row);
    }
    node.append(items);
  }
  return node;
}

/** Reviewers picked for the next review; the page updates them before the extension confirms. */
let reviewPicks: readonly Reviewer[] | undefined;

/** The Review button, its reviewer menu and its status chip. */
function showReview(): void {
  const review = current?.review;
  $('review-tools').hidden = review === undefined;
  if (review === undefined) return;
  reviewPicks = review.picked;
  const start = $<HTMLButtonElement>('review');
  start.replaceChildren(icon(review.running ? icons.stop : icons.agentReview), review.running ? 'Stop review' : review.result ? 'Rerun review' : 'Review');
  const status = $('review-status');
  status.textContent = review.running ? 'Review · ' + stageLabels[review.live?.stage ?? 'triage'][0] : review.error ? 'Review failed' : '';
  status.title = review.error ?? '';
  status.className = review.running ? 'chip agent working' : review.error ? 'chip bad' : '';
  status.hidden = !review.running && !review.error;
  renderReviewCard();
}

function openReviewMenu(): void {
  const rows = reviewers.map((name) => menuRow([reviewerInfo[name].label, el('span', 'muted', reviewerInfo[name].description)], reviewPicks?.includes(name) === true, (on) => {
    reviewPicks = reviewers.filter((other) => other === name ? on : reviewPicks?.includes(other) === true);
    post({ action: 'review-pick', reviewers: reviewPicks });
  }));
  openToolbarMenu('review-pick', [el('div', 'muted picker-note', 'Reviewers'), ...rows, el('div', 'muted picker-note', 'Remembered for this repository.')], 'review-menu');
}

/** The Threads card: one foldable group per kind, one line per thread. Guide starts folded because its notes already sit in the diff. */
function renderThreadList(): void {
  const threads = allThreads();
  $('threads-title').textContent = 'Threads (' + threads.length + ')';
  const list = $('threads');
  list.replaceChildren();
  if (threads.length === 0) list.append(el('li', 'muted', current?.localMode || current?.github || current?.githubError ? 'No comments yet.' : 'No local comments yet. Loading GitHub comments…'));
  if (current?.githubError) list.append(el('li', 'bad', 'Could not load GitHub comments: ' + current.githubError));
  for (const kind of threadKinds) {
    const members = threads.filter((thread) => threadKind(thread) === kind && standalone(thread));
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
      for (const thread of members) {
        rows.append(threadRow(thread, kind));
        if (thread.source === 'github') for (const local of nestedIn(thread.id)) rows.append(threadRow(local, threadKind(local), true));
      }
      group.append(rows);
    }
    list.append(group);
  }
  renderNavThreads();
}

/** The comments panel under the file list: open threads on files the filters leave, grouped by file in page order; a click jumps to the thread. */
function renderNavThreads(): void {
  const pageFiles = files ?? [];
  const order = new Map(pageFiles.map((file, index) => [file.path, index]));
  const shown = new Set(filteredFiles(pageFiles).map((file) => file.path));
  const threads = allThreads().filter((thread) => !thread.resolved && standalone(thread) && (view !== 'files' || inFiles(thread)) && (shown.has(thread.path) || (!order.has(thread.path) && !filtersOn())));
  const byFile = new Map<string, Thread[]>();
  for (const thread of threads) byFile.set(thread.path, [...byFile.get(thread.path) ?? [], thread]);
  const paths = [...byFile.keys()].sort((left, right) => (order.get(left) ?? Infinity) - (order.get(right) ?? Infinity) || left.localeCompare(right));
  const panel = $('nav-threads');
  panel.hidden = threads.length === 0;
  $('nav-split').hidden = panel.hidden;
  const head = el('div', 'nav-head');
  head.append('Comments', el('span', 'muted', String(threads.length)));
  const list = el('ul', 'nav-list');
  const wholeFile = (thread: Thread): boolean => thread.source === 'local' && thread.scope === 'file';
  for (const path of paths) {
    const fileRow = el('li', 'nav-thread-file');
    fileRow.title = path;
    const themeIcon = fileIcons?.byPath[path];
    fileRow.append(themeIcon ? iconNode(themeIcon) : el('span', 'file-icon'), el('span', 'nav-name', path.split('/').at(-1) ?? path));
    list.append(fileRow);
    const members = (byFile.get(path) ?? []).sort((left, right) => (wholeFile(left) ? 0 : left.startLine) - (wholeFile(right) ? 0 : right.startLine));
    for (const thread of members) {
      const kind = threadKind(thread);
      const row = el('button', 'nav-file nav-thread ' + kind);
      row.style.setProperty('--depth', '1');
      hoverPreview(row, thread);
      const mark = titled(el('span', 'nav-kind'), kindLabels[kind]);
      mark.append(icon(kindMarks[kind]));
      const lines = wholeFile(thread) ? 'File' : 'L' + thread.startLine + (thread.endLine > thread.startLine ? '–' + thread.endLine : '');
      row.append(mark, el('span', 'nav-lines', lines), el('span', 'nav-name', thread.text.split('\n')[0] ?? ''));
      row.addEventListener('click', () => { jump(thread); });
      const item = el('li');
      item.append(row);
      list.append(item);
    }
  }
  panel.replaceChildren(head, list);
}

/** Plain text with `backtick` spans shown as code. */
function inlineCode(text: string): Node[] {
  return text.split('`').map((part, index) => index % 2 === 1 ? el('code', '', part) : document.createTextNode(part));
}

/** One thread as a row: where on the left, the text in a column that lines up, status on the right only when it adds something. */
/** Your pending review's comments under Finish your review, in page order; a click jumps to the thread. */
function renderPendingList(reviewing: boolean): void {
  const list = $('pending-list');
  const order = new Map((files ?? []).map((file, index) => [file.path, index]));
  const threads = (current?.github ?? []).filter((thread) => thread.messages.some((message) => message.pending))
    .sort((left, right) => (order.get(left.path) ?? Infinity) - (order.get(right.path) ?? Infinity) || left.path.localeCompare(right.path) || left.startLine - right.startLine);
  list.hidden = !reviewing || threads.length === 0;
  list.replaceChildren(...list.hidden ? [] : threads.flatMap((thread) => thread.messages.filter((message) => message.pending).map((message) => {
    const row = threadRow({ ...thread, source: 'github', text: message.body, messages: [message] }, 'github');
    row.querySelector('.state')?.replaceChildren();
    return row;
  })));
}

function threadRow(thread: Thread, kind: ThreadKind, nested = false): HTMLElement {
  const item = el('li', 'card-thread ' + kind + (nested ? ' nested' : ''));
  hoverPreview(item, thread);
  item.addEventListener('click', () => jump(thread));
  const text = el('span', 'text');
  text.append(...inlineCode((thread.source === 'local' ? thread.title : undefined) ?? thread.text));
  const status = kind === 'analysis' || kind === 'review' ? '' : thread.status;
  const working = thread.source === 'local' ? thread.working : undefined;
  const [name = '', line = ''] = (thread.location.split('/').pop() ?? '').split(/(?=:\d+$)/u);
  const where = el('span', 'where');
  where.append(el('span', 'name', name), line);
  const state = el('span', 'state', working ? '' : status);
  if (working) state.append(el('span', 'chip agent working', working));
  item.append(where, text, state);
  if (thread.url) {
    const link = el('a', 'open', '↗');
    link.title = 'Open on GitHub';
    link.addEventListener('click', (event) => { event.stopPropagation(); post({ action: 'github', id: thread.id }); });
    item.append(link);
  }
  return item;
}

/** The one hover preview of a thread, shared by every item that shows it. */
const threadHover = el('div', 'thread-hover');
threadHover.popover = 'manual';
document.body.append(threadHover);
let threadHoverTimer = 0;
let threadHoverAnchor: HTMLElement | undefined;

/** Shows `thread`'s kind, status, place and latest message when the pointer rests on `node`. */
function hoverPreview(node: HTMLElement, thread: Thread): void {
  node.addEventListener('mouseenter', () => {
    clearTimeout(threadHoverTimer);
    threadHoverTimer = window.setTimeout(() => { if (node.isConnected) showThreadHover(node, thread); }, 400);
  });
  node.addEventListener('mouseleave', hideThreadHover);
  node.addEventListener('mousedown', hideThreadHover);
}

function hideThreadHover(): void {
  clearTimeout(threadHoverTimer);
  threadHoverAnchor = undefined;
  if (threadHover.matches(':popover-open')) threadHover.hidePopover();
}

function showThreadHover(anchor: HTMLElement, thread: Thread): void {
  const kind = threadKind(thread);
  const head = el('div', 'thread-hover-head');
  const title = thread.source === 'local' ? thread.title : undefined;
  const working = thread.source === 'local' ? thread.working : undefined;
  head.append(kindLabel(kind), ...title === undefined ? [] : [el('span', 'title', title)], el('span', 'gap'));
  if (working) head.append(el('span', 'chip agent working', working));
  else if (thread.status) head.append(el('span', 'chip', thread.status));
  threadHover.className = 'thread-hover ' + kind;
  threadHover.replaceChildren(head, el('div', 'where', thread.location));
  const latest = thread.messages.at(-1);
  if (latest !== undefined) {
    const author = 'avatarUrl' in latest ? latest.author : latest.author === 'claude' ? 'Claude' : 'You';
    const item = el('div', 'thread-hover-msg');
    const body = el('div', 'msg-text');
    body.innerHTML = latest.html;
    item.append(avatar(latest, author), body, ...timeLabel(latest.createdAt));
    threadHover.append(item);
  }
  if (thread.messages.length > 1) threadHover.append(el('div', 'muted thread-hover-count', thread.messages.length + ' messages'));
  threadHoverAnchor = anchor;
  threadHover.showPopover();
  const box = anchor.getBoundingClientRect();
  const height = threadHover.offsetHeight;
  const width = threadHover.offsetWidth;
  const below = box.bottom + 4 + height <= window.innerHeight - 8;
  threadHover.style.top = Math.max(8, below ? box.bottom + 4 : box.top - 4 - height) + 'px';
  threadHover.style.left = Math.max(8, Math.min(box.left, window.innerWidth - 8 - width)) + 'px';
}

// A redraw can remove the hovered item without a mouseleave, so the preview also closes when the pointer moves off it.
document.addEventListener('mouseover', (event) => {
  if (threadHoverAnchor !== undefined && (!threadHoverAnchor.isConnected || !(event.target instanceof Node) || !threadHoverAnchor.contains(event.target))) hideThreadHover();
}, { passive: true });
document.addEventListener('scroll', hideThreadHover, { capture: true, passive: true });

function groupHead(group: GuideGroup): HTMLElement {
  const head = el('div', 'guide-group sev-' + group.severity);
  head.dataset.group = group.key;
  const label = el('label', 'viewed');
  label.title = 'Mark every step in this section read.';
  label.addEventListener('click', (event) => { event.stopPropagation(); });
  const check = el('input');
  check.type = 'checkbox';
  check.checked = group.steps.every(stepViewed);
  check.addEventListener('change', () => { setGroupViewed(group, check.checked); });
  label.append(check, 'Viewed');
  head.append(el('span', 'sev', severityLabels[group.severity]), el('span', 'title', group.title), el('span', 'muted progress'), label);
  return head;
}

/** Tick or untick every step of a guide section, showing it right away; the extension's next state confirms it. */
function setGroupViewed(group: GuideGroup, on: boolean): void {
  if (!files) return;
  const paths = [...new Set(group.steps.map((step) => step.path))];
  if (on) {
    const marks = groupReadMarks(group, files, readRanges, viewed);
    readRanges = [...readRanges, ...marks.read.map((marked) => ({ id: 'pending', ...marked }))];
    marks.read.forEach((marked) => post({ action: 'read', ...marked, viewed: false }));
    for (const path of marks.viewed) { markViewed(path, true); post({ action: 'viewed', path, viewed: true }); }
  } else {
    const ids = group.steps.flatMap((step) => {
      const file = files?.find((item) => item.path === step.path);
      return file ? step.blocks.flatMap((block) => selectedReadIds(file, block.range) ?? []) : [];
    });
    if (ids.length) unmarkRead([...new Set(ids)]);
    for (const path of paths) if (viewed.has(path)) { markViewed(path, false); post({ action: 'viewed', path, viewed: false }); }
  }
  for (const step of group.steps) collapsed.delete(guideState('step', step.key));
  save();
  renderFiles();
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
  button.innerHTML = isCollapsed ? icons.unfold : icons.fold;
  return button;
}

function updateGuideProgress(groups: readonly GuideGroup[]): void {
  for (const group of groups) {
    const head = document.querySelector('[data-group="' + CSS.escape(group.key) + '"]');
    const progress = head?.querySelector('.progress');
    if (progress) progress.textContent = group.steps.filter(stepViewed).length + '/' + group.steps.length + ' viewed';
    const check = head?.querySelector<HTMLInputElement>('label.viewed input');
    if (check) check.checked = group.steps.every(stepViewed);
  }
}

/** The guided layout: Claude's steps by severity, each a slice of the diff with its note and a Viewed checkbox. */
function renderGuide(only?: readonly (string | undefined)[] | 'state'): void {
  const container = $('files');
  const result = current?.analysis.result;
  if (!files || !result) {
    $('files').parentElement?.classList.add('no-nav');
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
  const keyOf = (step: GuideStep): string => JSON.stringify([stepViewed(step), stepCollapsed(step), readRanges.filter((marked) => marked.path === step.path), current?.local?.[step.path] ?? null,
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
    container.replaceChildren(guideSummary(result, groups));
    for (const group of groups) {
      const isCollapsed = groupCollapsed(group);
      const { node, rail } = railNode(groupHead(group), 0, isCollapsed, () => { collapsed.set(guideState('group', group.key), !isCollapsed); save(); renderFiles(); });
      container.append(node);
      if (!isCollapsed) for (const step of group.steps) rail.append(railItem(draw(step)));
    }
  }
  updateGuideProgress(groups);
  renderGuideNav(groups);
}

/** The guide's sections and numbered steps beside the steps, each with its Viewed state; a click scrolls to it. */
function renderGuideNav(groups: readonly GuideGroup[]): void {
  $('files').parentElement?.classList.remove('no-nav');
  const nav = $('file-nav');
  nav.classList.toggle('folded', navFolded);
  const steps = groups.flatMap((group) => group.steps);
  const head = el('button', 'nav-head');
  head.setAttribute('aria-expanded', String(!navFolded));
  head.append(chevronMark(navFolded), steps.length + (steps.length === 1 ? ' step' : ' steps'), el('span', 'muted', steps.filter(stepViewed).length + ' viewed'));
  head.addEventListener('click', () => { navFolded = !navFolded; renderGuideNav(groups); });
  const list = el('ul', 'nav-list');
  for (const group of groups) {
    const isCollapsed = groupCollapsed(group);
    const fold = chevronMark(isCollapsed);
    fold.title = isCollapsed ? 'Unfold section' : 'Fold section';
    fold.addEventListener('click', (event) => { event.stopPropagation(); collapsed.set(guideState('group', group.key), !isCollapsed); save(); renderFiles(); });
    const row = el('button', 'nav-section sev-' + group.severity);
    row.title = severityLabels[group.severity] + ': ' + group.title;
    row.append(fold, el('span', 'nav-sev'), el('span', 'nav-name', group.title), el('span', 'nav-progress', group.steps.filter(stepViewed).length + '/' + group.steps.length));
    row.addEventListener('click', () => revealGroup(group.key));
    const item = el('li');
    item.append(row);
    list.append(item);
    if (isCollapsed) continue;
    group.steps.forEach((step, index) => {
      const done = stepViewed(step);
      const stepRow = el('button', 'nav-file nav-step' + (done ? ' done' : ''));
      stepRow.dataset.navStep = step.key;
      stepRow.title = step.path + (step.note === undefined ? '' : '\n\n' + step.note);
      const mark = el('span', 'nav-done');
      if (done) mark.append(icon(icons.check));
      stepRow.append(el('span', 'nav-number', String(index + 1)), el('span', 'nav-name', step.title ?? step.path.split('/').at(-1) ?? step.path), mark);
      stepRow.addEventListener('click', () => revealStep(step.key));
      const stepItem = el('li');
      stepItem.append(stepRow);
      list.append(stepItem);
    });
  }
  nav.replaceChildren(head, list);
  markCurrentNavFile();
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
  head.append(chevron, name, badge, ...localMark(step.path), stats, previewSwitch(file, showPreview), headTools(toolButton(icons.openExternal, 'Open in editor', () => post({ action: 'editor', path: step.path }))), label);
  box.append(head);
  const diff = el('div', 'diff');
  if (step.fileNote) {
    const about = el('div', 'file-note');
    about.append(el('span', 'tag', 'About this file'), ' ', step.fileNote);
    diff.append(about);
  }
  if (note) diff.append(threadBox(note));
  else if (step.note) diff.append(el('div', 'step-note', step.note));
  const placed = new Set<string>();
  const whole = wholeFileBlock(file.path, threads, placed, false);
  if (whole) diff.append(whole);
  if (showPreview && kind === 'media') diff.append(mediaNode(file));
  else if (file.binary) diff.append(el('div', 'note muted', 'Binary file not shown.'));
  else if (showPreview) diff.append(previewNode(file, threads, placed));
  else if (!slice.hunks.length) diff.append(el('div', 'note muted', file.change === 'renamed' ? 'Renamed without changes.' : 'No content changes.'));
  else diff.append(table(slice, threads, placed, hasDraft ? composer : null, 'step:' + step.key));
  box.append(diff);
  wrap.append(box);
  return wrap;
}

/** A file header's icon buttons, kept together before Viewed. */
function headTools(...buttons: HTMLButtonElement[]): HTMLElement {
  const tools = el('span', 'head-tools');
  for (const each of buttons) each.classList.add('icon-button');
  tools.append(...buttons);
  return tools;
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

/** Diffs GitHub does not render until asked. */
function isLarge(file: FileDiff): boolean {
  return file.additions + file.deletions > 1500;
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
  if (file.saved) {
    const chip = el('span', 'file-chip', 'Saved code');
    chip.title = 'This file no longer exists. Showing the code saved with its comments.';
    stats.append(chip);
  }
  else if (file.change === 'unchanged') stats.append(el('span', 'file-chip', 'Not changed'));
  else stats.append(el('span', 'stat-add', '+' + file.additions), ' ', el('span', 'stat-del', '−' + file.deletions));
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
  const open = toolButton(icons.openExternal, 'Open in editor', () => post({ action: 'editor', path: file.path }));
  open.hidden = file.saved === true;
  const whole = fullFile(file);
  const full = toolButton(whole ? icons.file : icons.fullFile, whole ? 'Diff only' : 'Full file', () => {
    expanded.set(file.path, whole ? new Map() : new Map(Array.from({ length: file.hunks.length + 1 }, (_, index) => [index, { top: Infinity, bottom: 0 }])));
    loadContext(file);
    renderFiles([file.path]);
  });
  const kind = previewKind(file);
  const showPreview = kind !== undefined && (previewing.has(file.path) || previewOnly(file));
  full.hidden = showPreview || file.binary || file.change === 'added' || file.change === 'deleted' || file.change === 'unchanged' || !file.hunks.length || !atHead;
  const mode = previewSwitch(file, showPreview);
  const unresolved = threads.filter((thread) => !thread.resolved).length;
  const comments = el('span', 'muted comments');
  if (threads.length) {
    comments.append(icon(icons.comment), String(threads.length));
    comments.title = threads.length + (threads.length === 1 ? ' comment' : ' comments') + (unresolved === threads.length ? '' : ', ' + unresolved + ' open');
  }
  const chips = file.generated ? [el('span', 'file-chip', 'Generated')] : isLarge(file) ? [el('span', 'file-chip', 'Large diff')] : [];
  for (const chip of chips) chip.title = file.generated ? 'Generated file. GitHub folds these by default.' : 'Large diff, folded by default.';
  const commentFile = toolButton(icons.comment, 'Comment on the whole file', () => openFileComposer(file.path));
  commentFile.hidden = !atHead || file.change === 'deleted';
  const themeIcon = fileIcons?.byPath[file.path];
  const close = toolButton(icons.close, 'Close', () => { closeFiles([file.path]); });
  close.hidden = file.change !== 'unchanged' || threads.length > 0;
  head.append(chevron, ...themeIcon ? [iconNode(themeIcon)] : [], name, badge, ...localMark(file.path), stats, ...chips, comments, mode, headTools(full, commentFile, open), label, headTools(close));
  box.append(head);
  const diff = el('div', 'diff');
  const placed = new Set(threads.filter((thread) => !standalone(thread)).map((thread) => thread.id));
  const fileThreads = wholeFileBlock(file.path, threads, placed, true);
  if (fileThreads) diff.append(fileThreads);
  if (showPreview && kind === 'media') diff.append(mediaNode(file));
  else if (file.binary) diff.append(el('div', 'note muted', 'Binary file not shown.'));
  else if (showPreview) diff.append(previewNode(file, threads, placed));
  else if (!file.hunks.length) diff.append(el('div', 'note muted', file.change === 'renamed' ? 'Renamed without changes.' : 'No content changes.'));
  else diff.append(table(file, threads, placed));
  const outside = threads.filter((thread) => !placed.has(thread.id));
  if (outside.length) {
    const block = el('div', 'outside');
    block.append(el('div', 'muted', 'Comments on lines this diff does not show'), ...outside.map(threadBox));
    diff.insertBefore(block, fileThreads?.nextSibling ?? diff.firstChild);
  }
  box.append(diff);
  return box;
}

/** Threads about the whole file, and its new-comment box when `withComposer`, above the diff; marks those threads placed. */
function wholeFileBlock(path: string, threads: readonly Thread[], placed: Set<string>, withComposer: boolean): HTMLElement | undefined {
  const own = threads.filter((thread) => thread.scope === 'file' && standalone(thread) && !placed.has(thread.id));
  const draft = withComposer && fileComposer?.path === path ? fileComposer : undefined;
  if (!own.length && !draft) return undefined;
  for (const thread of own) placed.add(thread.id);
  const block = el('div', 'file-threads');
  block.append(...own.map(threadBox), ...draft ? [fileComposerBox(draft)] : []);
  return block;
}

function openFileComposer(path: string): void {
  const before = fileComposer?.path;
  if (before !== path) fileComposer = { path, text: '' };
  collapsed.set(path, false);
  focusNext = 'file-composer';
  save();
  renderFiles([before, path]);
}

/** A new comment about a whole file: Local, where Claude answers it or changes the code, or On GitHub, like a comment on lines. */
function fileComposerBox(draft: FileComposer): HTMLElement {
  const github = draft.target === 'github' && !current?.localMode;
  const box = el('div', 'thread draft' + (github ? ' github' : ''));
  const head = el('div', 'strip');
  const toggle = el('span', 'seg');
  toggle.hidden = current?.localMode === true;
  toggle.setAttribute('role', 'group');
  toggle.setAttribute('aria-label', 'Who sees this comment');
  for (const [value, label] of [['claude', 'Local'], ['github', 'On GitHub']] as const) {
    const option = button(label, () => { draft.target = value; focusNext = 'file-composer'; save(); renderFiles([draft.path]); });
    option.setAttribute('aria-pressed', String(draft.target === value || (!draft.target && value === 'claude')));
    toggle.append(option);
  }
  head.append(el('span', 'source', 'New comment'), toggle, el('span', 'gap'), el('span', 'muted', 'Whole file'));
  const cancel = (): void => { fileComposer = undefined; save(); renderFiles([draft.path]); };
  const busySending = sending.has('file-composer');
  const send = (intent: Intent, pending = true): void => {
    if (!draft.text.trim() || sending.has('file-composer')) return;
    sending.add('file-composer');
    sentPending = pending;
    $('error').textContent = '';
    renderFiles([draft.path]);
    post(github ? { action: 'github-file-comment', form: 'file-composer', path: draft.path, text: draft.text, pending }
      : { action: 'file-comment', form: 'file-composer', path: draft.path, text: draft.text, intent });
  };
  const row = el('div', 'row actions composer-actions');
  const needText: HTMLButtonElement[] = [];
  const onDraft = (value: string): void => { draft.text = value; save(); for (const each of needText) each.disabled = sending.has('file-composer') || !value.trim(); };
  const area = github ? githubField('file-composer', draft.text, 'Comment on GitHub', onDraft, () => send('ask'), cancel)
    : textarea('file-composer', draft.text, 'Ask about this file', onDraft, () => send('ask'), cancel);
  if (github) {
    const review = button(busySending && sentPending ? 'Sending…' : 'Add to review', () => send('ask', true), 'primary');
    review.disabled = busySending;
    review.title = 'Goes into your pending review. Nobody sees it until you submit the review.';
    const reviewing = current?.details?.pendingComments !== undefined;
    const now = button(busySending && !sentPending ? 'Sending…' : 'Post now', () => send('ask', false));
    now.disabled = busySending || reviewing;
    now.title = reviewing ? 'You have a review in progress, so GitHub adds new comments to it. Submit the review to publish them.' : 'Posts on GitHub right away.';
    row.append(...reviewing ? [titled(el('span', 'chip pending', 'Review in progress'), 'New comments go into your pending review.')] : [], el('span', 'gap'), button('Cancel', cancel, 'quiet'), now, review);
  } else {
    const implement = agentButton('implement', 'Implement', () => send('implement'));
    implement.title = 'Agent changes the code';
    const ask = agentButton('ask', busySending ? 'Sending…' : 'Ask', () => send('ask'));
    ask.title = 'Agent answers without editing';
    needText.push(implement, ask);
    onDraft(draft.text);
    row.append(el('span', 'gap'), button('Cancel', cancel, 'quiet'), implement, ask);
  }
  box.append(head, area, row);
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

/** Switch tabs, keeping the tab bar where it is when the page is scrolled past the header. */
function setView(next: View): void {
  view = next;
  closeToolbarMenu();
  if (next === 'guide' && (diffRange.kind !== 'all' || whitespace)) requestFiles({ kind: 'all' }, false);
  save();
  renderFiles();
  renderNavThreads();
  const bar = $('files-bar');
  const panelTop = (next === 'overview' ? $('panel-overview') : $('panel-files')).getBoundingClientRect().top + window.scrollY - bar.offsetHeight;
  if (window.scrollY > panelTop) window.scrollTo(0, panelTop);
}

/** Open the Overview tab at the review box with its summary focused. */
function finishReview(): void {
  if (view !== 'overview') setView('overview');
  const box = $('review-box');
  box.scrollIntoView({ block: 'nearest' });
  $<HTMLTextAreaElement>('review').focus({ preventScroll: true });
}

/** The Guide tab's count of steps once a guide exists; its icon moves while Claude builds it. Build guide shows only in the guide. */
function showGuideTab(): void {
  const analysis = current?.analysis;
  const count = $('guide-count');
  const steps = analysis?.result?.groups.reduce((sum, group) => sum + group.steps.length, 0);
  $('view-guide').classList.toggle('busy', analysis?.running === true);
  $('guide-stale').hidden = analysis?.running === true || analysis?.result === undefined || !analysis.stale;
  count.textContent = analysis?.running || steps === undefined ? '' : String(steps);
  count.hidden = analysis?.running === true || steps === undefined;
  $('files-count').textContent = files ? String(files.filter((file) => file.change !== 'unchanged').length) : '';
  for (const id of ['analyze', 'analysis-status', 'analyze-divider']) $(id).classList.toggle('off-view', view !== 'guide');
  for (const id of ['range', 'nav-tools']) $(id).classList.toggle('off-view', view !== 'files');
  showListToggle();
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

/** Show the guided layout with a section unfolded, scrolled to its head. */
function revealGroup(key: string): void {
  view = 'guide';
  collapsed.set(guideState('group', key), false);
  save();
  renderFiles();
  document.querySelector('[data-group="' + CSS.escape(key) + '"]')?.closest('.tree-node')?.scrollIntoView({ block: 'start' });
}

let noticeTimer: ReturnType<typeof setTimeout> | undefined;

/** Show a hint that clears itself after a few seconds, on the next click, or on Escape. */
function showNotice(notice: NonNullable<ExtensionMessage['notice']>): void {
  const box = $('notice');
  const { extension } = notice;
  const link = el('a', '', 'Open on GitHub');
  if (notice.url !== undefined) link.href = notice.url;
  box.replaceChildren(el('span', '', notice.text), ...extension === undefined ? [] : [button('Find extension', () => { post({ action: 'find-extension', extension }); clearNotice(); }, 'small')],
    ...notice.url === undefined ? [] : [link]);
  clearTimeout(noticeTimer);
  noticeTimer = setTimeout(clearNotice, extension === undefined && notice.url === undefined ? 4000 : 8000);
}

function clearNotice(): void {
  clearTimeout(noticeTimer);
  $('notice').replaceChildren();
}

/** Paths whose diff differs from the one shown, or undefined when the file list or what it shows changed and every file needs drawing. */
function changedFiles(next: readonly FileDiff[], shownAs: string): string[] | undefined {
  const shown = files;
  if (view !== 'files' || shown === undefined || shownAs !== JSON.stringify([diffRange, whitespace, atHead])
    || shown.length !== next.length || next.some((file, index) => shown[index]?.path !== file.path)) return undefined;
  return next.filter((file, index) => JSON.stringify(file) !== JSON.stringify(shown[index])).map((file) => file.path);
}

/** A thread's live log on screen before a redraw, so the orb can fly from it into Claude's new reply. */
interface LiveLog { readonly threadId: string; readonly messages: number; readonly log: HTMLElement; readonly at: DOMRect; readonly orb: DOMRect }

function liveLogs(): LiveLog[] {
  return [...document.querySelectorAll<HTMLElement>('.claude-live[data-thread]')].flatMap((log) => {
    const orb = log.querySelector('.orb');
    const thread = current?.threads.find((candidate) => candidate.id === log.dataset.thread);
    return orb && thread ? [{ threadId: thread.id, messages: thread.messages.length, log, at: log.getBoundingClientRect(), orb: orb.getBoundingClientRect() }] : [];
  });
}

const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Once Claude's reply replaces its live log, the old log fades where it was and the orb flies from it up into the reply's avatar. */
async function hopIntoAvatar(live: LiveLog): Promise<void> {
  const thread = current?.threads.find((candidate) => candidate.id === live.threadId);
  const box = document.getElementById('thread-' + live.threadId);
  if (reducedMotion.matches || !thread || !box || box.querySelector('.claude-live') || thread.messages.length <= live.messages || thread.messages.at(-1)?.author !== 'claude') return;
  const avatar = [...box.querySelectorAll<HTMLElement>('.orb-avatar')].at(-1);
  const pose = avatar?.querySelector<HTMLElement>('.orb');
  const text = avatar?.nextElementSibling;
  if (!avatar || !pose || !(text instanceof HTMLElement)) return;
  Object.assign(live.log.style, { position: 'fixed', left: live.at.left + 'px', top: live.at.top + 'px', width: live.at.width + 'px', margin: '0', pointerEvents: 'none' });
  live.log.querySelector<HTMLElement>('.orb')?.style.setProperty('visibility', 'hidden');
  document.body.append(live.log);
  live.log.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 160, fill: 'forwards' }).finished.then(() => { live.log.remove(); }, () => { live.log.remove(); });
  // The avatar's own orb makes the flight: it starts offset onto the log row's orb, center to center, and ends at offset zero, its resting place.
  const to = pose.getBoundingClientRect();
  const dx = Math.round(live.orb.left + live.orb.width / 2 - (to.left + to.width / 2)), dy = Math.round(live.orb.top + live.orb.height / 2 - (to.top + to.height / 2));
  const height = text.offsetHeight, from = Math.max(0, Math.round(live.at.bottom - text.getBoundingClientRect().top));
  Object.assign(text.style, { overflow: 'clip', boxSizing: 'border-box' });
  text.animate([{ height: from + 'px' }, { height: height + 'px' }], { duration: 260, easing: 'cubic-bezier(.2, .8, .2, 1)' }).finished
    .finally(() => { Object.assign(text.style, { overflow: '', boxSizing: '' }); }).catch(() => undefined);
  text.animate([{ opacity: 0, transform: 'translateY(2px)' }, { opacity: 1, transform: 'none' }], { duration: 200, delay: 180, easing: 'ease-out', fill: 'backwards' });
  avatar.animate([{ transform: 'scale(0)' }, { transform: 'scale(1.12)' }, { transform: 'scale(1)' }], { duration: 180, delay: 300, easing: 'ease-out', fill: 'backwards', pseudoElement: '::before' });
  pose.style.transform = `translate(${dx}px, ${dy}px)`;
  pose.dataset.pose = 'air';
  const flight = pose.animate(Array.from({ length: 13 }, (_, step) => {
    const done = step / 12, left = 1 - done, eased = done < .5 ? 2 * done * done : 1 - (-2 * done + 2) ** 2 / 2;
    return { transform: `translate(${Math.round(dx * (1 - eased))}px, ${Math.round(dy * (1 - eased) - 6 * Math.sin(Math.PI * done) * left)}px)` };
  }), { duration: 320 });
  pose.style.transform = '';
  await flight.finished.catch(() => undefined);
  pose.dataset.pose = 'crouch';
  await wait(80);
  delete pose.dataset.pose;
}

function onExtensionMessage(data: ExtensionMessage): void {
  const live = data.state ? liveLogs() : [];
  if (data.state) render(data.state);
  for (const log of live) void hopIntoAvatar(log);
  const shownAs = JSON.stringify([diffRange, whitespace, atHead]);
  if (data.selection) { diffRange = data.selection.range; whitespace = data.selection.whitespace; atHead = data.atHead !== false; save(); }
  if (data.icons) fileIcons = data.icons;
  if (data.repositoryFiles) repositoryFiles = data.repositoryFiles;
  if (data.files) {
    const changed = changedFiles(data.files, shownAs);
    files = data.files;
    for (const file of files) if (!collapsed.has(file.path) && (file.generated || isLarge(file))) collapsed.set(file.path, true);
    if (changed === undefined) { guide = undefined; contextLines.clear(); loading.clear(); renderFiles(); }
    else {
      if (changed.length) guide = undefined;
      for (const path of changed) { contextLines.delete(path); loading.delete(path); }
      renderFiles(changed);
    }
    renderNavThreads();
  }
  if (data.markdown) {
    const entry = renderedPreviews.get(data.markdown.form);
    if (entry) renderedPreviews.set(data.markdown.form, { text: entry.text, html: data.markdown.html });
    const box = document.querySelector<HTMLElement>('[data-preview="' + CSS.escape(data.markdown.form) + '"]');
    if (box && entry) box.innerHTML = data.markdown.html || '<span class="muted">Nothing to preview.</span>';
  }
  if (data.commitDiff) {
    const { oid } = data.commitDiff;
    commitDiffs.set(oid, 'files' in data.commitDiff ? data.commitDiff.files : { error: data.commitDiff.error });
    renderCommitThreads(oid);
  }
  if (data.preview) { previews.set(data.preview.path, data.preview); loading.delete('preview:' + data.preview.path); renderFiles([data.preview.path]); }
  if (data.media) { medias.set(data.media.path, data.media); loading.delete('media:' + data.media.path); renderFiles([data.media.path]); }
  if (data.context) { contextLines.set(data.context.path, data.context.lines); loading.delete(data.context.path); renderFiles([data.context.path]); }
  if (data.definition) { peeks.length = peekAt + 1; peeks.push(data.definition); peekAt = peeks.length - 1; renderPeek(); }
  if (data.probe) { probes.set(data.probe.id, data.probe.found); showLink(); }
  if (data.revealStep) revealStep(data.revealStep);
  if (data.revealGroup) revealGroup(data.revealGroup);
  if (data.revealThread) {
    const thread = allThreads().find((each) => each.id === data.revealThread);
    if (thread) jump(thread);
  }
  if (data.reveal && files) {
    view = 'files';
    closedFiles.delete(data.reveal);
    collapsed.set(data.reveal, false);
    openFolders(data.reveal);
    save();
    renderFiles();
    document.querySelector('[data-path="' + CSS.escape(data.reveal) + '"]')?.scrollIntoView({ block: 'start' });
  }
  if (data.filesError) $('files').replaceChildren(el('p', 'bad', 'Could not read the changes: ' + data.filesError));
  if (data.restored) restoreComment(data.restored);
  if (data.notice) showNotice(data.notice);
  if (data.error) {
    loading.clear();
    $('error').textContent = data.error;
    if (data.form && sending.delete(data.form)) { renderFiles(); if (current) renderConversation(current, true); }
  }
  if (data.drafted) {
    const { thread: id, text, github } = data.drafted;
    sending.delete('draft:' + id);
    if (github) {
      replies.set(id, text);
      previewTabs.delete('reply:' + id);
      focusNext = 'reply:' + id;
    } else {
      replies.delete(id);
      publishing.set(id, text);
      focusNext = 'publish:' + id;
    }
    save();
    const thread = allThreads().find((each) => each.id === id);
    if (thread) redrawThread(thread);
  }
  if (data.done === 'review') $<HTMLTextAreaElement>('review').value = '';
  if (data.done === 'merge') closeMergeForm();
  if (data.done === 'title') closeTitleForm();
  if (data.done === 'dismiss') { dismissing = undefined; if (current) renderReviewers(current, true); }
  if (data.done === 'suggestions') { batch.clear(); renderBatch(); }
  if (data.done === 'conversation') {
    sending.delete('conversation');
    conversationDraft = '';
    previewTabs.delete('conversation');
    save();
    if (current) renderConversation(current, true);
  }
  if (data.done?.startsWith('edit:')) {
    const id = data.done.slice(5);
    sending.delete(data.done);
    edits.delete(id);
    previewTabs.delete(data.done);
    if (current) renderConversation(current, true);
    renderFiles([allThreads().find((thread) => thread.messages.some((entry) => 'id' in entry && entry.id === id))?.path]);
  }
  if (data.done === 'link') { linking = false; if (current) renderLinked(current); }
  if (data.done === 'body') { editingBody = false; if (current) render(current); }
  if (data.done === 'file-composer') {
    sending.delete('file-composer');
    const path = fileComposer?.path;
    fileComposer = undefined;
    save();
    renderFiles([path]);
  }
  if (data.done === 'composer') {
    sending.delete('composer');
    const path = composer?.path;
    composer = undefined;
    save();
    renderFiles([path]);
  }
  if (data.done?.startsWith('publish:')) {
    const id = data.done.slice(8);
    sending.delete(data.done);
    publishing.delete(id);
    previewTabs.delete(data.done);
    save();
    redrawThread(allThreads().find((thread) => thread.id === id));
  }
  if (data.done?.startsWith('reply:')) {
    const id = data.done.slice(6);
    sending.delete(data.done);
    replies.delete(id);
    save();
    redrawThread(allThreads().find((thread) => thread.id === id));
  }
  if (data.done?.startsWith('comment-ask:')) {
    sending.delete(data.done);
    commentAsks.delete(data.done.slice('comment-ask:'.length));
    if (current) renderConversation(current, true);
  }
  if (data.branches) { baseBranches = data.branches; renderBaseMenu(); }
  if (data.conversations || data.conversationsError !== undefined) { conversations = data.conversations ?? data.conversationsError; renderConnectMenu(); }
  if (data.runningReady && connectView === 'preparing') { connectView = 'running'; renderConnectMenu(); }
  if (data.error !== undefined && connectView === 'preparing' && toolbarMenu?.anchor === 'connect') closeToolbarMenu();
  if (data.branchesError !== undefined) { baseBranches = data.branchesError; renderBaseMenu(); }
  if (data.pickerOptions) { pickerOptions = data.pickerOptions; pickerError = undefined; renderPicker(); }
  if (data.pickerError !== undefined) { pickerError = data.pickerError; renderPicker(); }
  if (data.idle) setBusy(false);
}

$('show-unpushed').addEventListener('click', showUnpushed);
for (const [id, action] of [['pr', 'pr'], ['push', 'push'], ['terminal', 'terminal'], ['retry', 'retry'], ['refresh', 'refresh']] as const) $(id).addEventListener('click', () => post({ action }));
$('stop-claude').addEventListener('click', stopClaude);
$('connect').addEventListener('click', openConnectMenu);
$('context').addEventListener('click', openContextMenu);
$('remove-worktree').addEventListener('click', () => askInMenu('remove-worktree',
  'Remove the worktree for ' + (current?.number === undefined ? 'this PR' : '#' + current.number) + '? Its local comments are deleted too. Git refuses if it has uncommitted changes.',
  'Remove worktree', () => post({ action: 'remove-worktree' })));
// Re-rendered working chips join the page clock instead of restarting their animation.
document.addEventListener('animationstart', (event) => {
  if (event.animationName !== 'orb' || !(event.target instanceof Element)) return;
  for (const animation of event.target.getAnimations({ subtree: true })) if (animation instanceof CSSAnimation && animation.animationName === 'orb') animation.startTime = 0;
});
setInterval(() => {
  for (const time of document.querySelectorAll<HTMLElement>('[data-since]')) time.textContent = elapsed(Number(time.dataset.since));
}, 1000);
$('error').addEventListener('click', () => { $('error').textContent = ''; });
document.addEventListener('pointerdown', (event) => { if (!(event.target instanceof Node && $('notice').contains(event.target))) clearNotice(); });
window.addEventListener('keydown', (event) => { if (event.key === 'Escape') clearNotice(); });
blockBrowserShortcuts();
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
for (const name of ['overview', 'files', 'guide'] as const) $('view-' + name).addEventListener('click', () => { setView(name); });
$('finish-review').addEventListener('click', finishReview);
$('range').addEventListener('click', openRangeMenu);
$<HTMLInputElement>('file-filter').value = fileFilter;
$('file-filter').addEventListener('input', () => { fileFilter = $<HTMLInputElement>('file-filter').value; applyFilters(); });
$('file-filter').addEventListener('keydown', (event) => { if (event.key === 'Escape') { $<HTMLInputElement>('file-filter').value = ''; fileFilter = ''; applyFilters(); $('file-filter').blur(); } });
$('filter-clear').addEventListener('click', () => { $<HTMLInputElement>('file-filter').value = ''; fileFilter = ''; applyFilters(); $('file-filter').focus(); });
$('filter-clear').hidden = fileFilter === '';
$('filter-menu').addEventListener('click', openFilterMenu);
$('nav-toggle').addEventListener('click', () => { listHidden = !listHidden; save(); showListToggle(); });
/** Drag the file list's right edge to resize it; double-click restores the default width. */
function showNavWidth(): void {
  if (navWidth === undefined) document.body.style.removeProperty('--nav-width');
  else document.body.style.setProperty('--nav-width', navWidth + 'px');
}
showNavWidth();
$('nav-resize').addEventListener('pointerdown', (event) => {
  if (event.button !== 0) return;
  event.preventDefault();
  const handle = $('nav-resize');
  const left = $('nav-col').getBoundingClientRect().left;
  handle.setPointerCapture(event.pointerId);
  handle.classList.add('dragging');
  document.body.classList.add('resizing');
  const move = (moved: PointerEvent): void => {
    navWidth = Math.round(Math.min(window.innerWidth / 2, Math.max(160, moved.clientX - left)));
    showNavWidth();
  };
  const stop = (): void => {
    handle.removeEventListener('pointermove', move);
    handle.classList.remove('dragging');
    document.body.classList.remove('resizing');
    save();
  };
  handle.addEventListener('pointermove', move);
  handle.addEventListener('pointerup', stop, { once: true });
  handle.addEventListener('pointercancel', stop, { once: true });
});
$('nav-resize').addEventListener('dblclick', () => { navWidth = undefined; showNavWidth(); save(); });
/** Drag the line between the file list and the comments panel to share their height; double-click restores the default. */
function showNavThreadsHeight(): void {
  if (navThreadsHeight === undefined) document.body.style.removeProperty('--nav-threads-height');
  else document.body.style.setProperty('--nav-threads-height', navThreadsHeight + 'px');
}
showNavThreadsHeight();
$('nav-split').addEventListener('pointerdown', (event) => {
  if (event.button !== 0) return;
  event.preventDefault();
  const handle = $('nav-split');
  const column = $('nav-col').getBoundingClientRect();
  handle.setPointerCapture(event.pointerId);
  handle.classList.add('dragging');
  document.body.classList.add('resizing-rows');
  const move = (moved: PointerEvent): void => {
    navThreadsHeight = Math.round(Math.min(column.height - 80, Math.max(48, column.bottom - moved.clientY)));
    showNavThreadsHeight();
  };
  const stop = (): void => {
    handle.removeEventListener('pointermove', move);
    handle.classList.remove('dragging');
    document.body.classList.remove('resizing-rows');
    save();
  };
  handle.addEventListener('pointermove', move);
  handle.addEventListener('pointerup', stop, { once: true });
  handle.addEventListener('pointercancel', stop, { once: true });
});
$('nav-split').addEventListener('dblclick', () => { navThreadsHeight = undefined; showNavThreadsHeight(); save(); });
showListToggle();
$('fold-conversation').addEventListener('click', () => { conversationFolded = !conversationFolded; save(); if (current) renderConversation(current, true); });
$('filter-menu').setAttribute('aria-pressed', String(filtersOn()));
document.addEventListener('pointerdown', (event) => {
  if (toolbarMenu && event.target instanceof Node && !toolbarMenu.node.contains(event.target) && !$(toolbarMenu.anchor).contains(event.target)) closeToolbarMenu();
  if (emojiFor !== undefined && event.target instanceof Element && !event.target.closest('.reactions')) {
    emojiFor = undefined;
    renderFiles();
    if (current) renderConversation(current, true);
  }
});
window.addEventListener('keydown', onShortcut);
$('commit-batch').addEventListener('click', () => { if (batch.size) changePullRequest({ action: 'commit-suggestions', picked: [...batch.values()] }); });
$('discard-review').addEventListener('click', () => askInMenu('discard-review', 'Discard your pending review? Its comments are deleted. Nobody saw them yet.', 'Discard review',
  () => changePullRequest({ action: 'discard-review' })));
$('approve-runs').addEventListener('click', () => {
  const count = current?.conversation?.awaitingApproval.length ?? 0;
  askInMenu('approve-runs', 'Run ' + (count === 1 ? 'the workflow' : count + ' workflows') + ' from this fork? It runs code the fork\'s author wrote. Review changes to workflow files first.',
    'Approve and run', () => changePullRequest({ action: 'approve-runs' }));
});
$('update-branch').addEventListener('click', openUpdateMenu);
$('method').addEventListener('click', openMethodMenu);
$('auto-merge').addEventListener('click', () => clickMerge(true));
$('auto-merge-off').addEventListener('click', () => changePullRequest({ action: 'auto-merge-off' }));
$('dequeue').addEventListener('click', () => changePullRequest({ action: 'dequeue' }));
$('merge-cancel').addEventListener('click', closeMergeForm);
attachMentions($<HTMLTextAreaElement>('review'), $('review-box'));
$('view-menu').addEventListener('click', openViewMenu);
$('analyze').addEventListener('click', () => { $('error').textContent = ''; post({ action: current?.analysis.running ? 'analysis-stop' : 'analyze' }); });
$('review').addEventListener('click', () => {
  $('error').textContent = '';
  if (current?.review?.running) post({ action: 'review-stop' });
  else post({ action: 'review', reviewers: reviewPicks ?? reviewers });
});
$('review-pick').addEventListener('click', openReviewMenu);
$('fold-all').addEventListener('click', () => {
  const value = !allFolded();
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
$('edit-title').addEventListener('click', editTitle);
$('link-pr').addEventListener('click', () => { linking = true; if (current) renderLinked(current); });
$('edit-body').addEventListener('click', editBody);
for (const what of ['reviewers', 'assignees', 'labels', 'milestone'] as const) $('pick-' + what).addEventListener('click', () => openPicker(what));
document.addEventListener('pointerdown', (event) => {
  if (picker && event.target instanceof Node && !picker.node.contains(event.target) && !$('pick-' + picker.what).contains(event.target)) closePicker(true);
});
window.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && picker) closePicker(false);
  if (event.key === 'Escape' && toolbarMenu) closeToolbarMenu();
  if (event.key === 'Escape' && asking) stopAsking();
});
$('merge').addEventListener('click', () => {
  if (current?.conversation?.merge.mergeQueue) changePullRequest({ action: 'enqueue' });
  else clickMerge(false);
});
window.addEventListener('message', (event: MessageEvent) => {
  const frame = event.source ? [...document.querySelectorAll<HTMLIFrameElement>('iframe.html-preview')].find((node) => node.contentWindow === event.source) : undefined;
  if (frame) frameMessage(frame, event.data);
  else onExtensionMessage(event.data as ExtensionMessage);
});
render(initial.state);
let navFrame = 0;
window.addEventListener('scroll', () => {
  if (navFrame || view === 'overview') return;
  navFrame = requestAnimationFrame(() => { navFrame = 0; markCurrentNavFile(false); markEndingFiles(); });
}, { passive: true });
new ResizeObserver(([entry]) => {
  if (entry) document.body.style.setProperty('--bar-height', (entry.target as HTMLElement).offsetHeight + 'px');
}).observe($('files-bar'));
post({ action: 'ready' });

/** Colors of the PR icons in the sidebar; the extension draws the tab icon in the theme's values, since tabs drop a theme icon's color. */
const tabIconColors = ['diffGuide.agent', 'charts.green', 'charts.purple', 'charts.red', 'charts.yellow', 'testing.iconPassed', 'testing.iconFailed', 'descriptionForeground'];
let sentColors = '';
function sendThemeColors(): void {
  const style = getComputedStyle(document.documentElement);
  const colors = Object.fromEntries(tabIconColors.map((id) => [id, style.getPropertyValue('--vscode-' + id.replaceAll('.', '-')).trim()]).filter(([, value]) => value));
  const key = JSON.stringify(colors);
  if (key === sentColors) return;
  sentColors = key;
  post({ action: 'theme-colors', colors });
}
sendThemeColors();
// VS Code rewrites the page's theme variables and body class when the theme changes.
const themeWatch = new MutationObserver(sendThemeColors);
themeWatch.observe(document.documentElement, { attributes: true, attributeFilter: ['style'] });
themeWatch.observe(document.body, { attributes: true, attributeFilter: ['class'] });
