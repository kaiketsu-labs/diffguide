/** Page state shared between modules: `prefs` persists with the page, `received` mirrors what the extension sent, `ui` is transient. */
import type { AgentConversation } from '../../core/agent.js';
import type { Reviewer } from '../../core/contracts.js';
import type { MergeMethod, PickerOptions } from '../../core/forge.js';
import type { GuideGroup } from '../../core/prAnalysis.js';
import type { MarkedRange } from '../../core/readLines.js';
import type { FileDiff } from '../../core/unifiedDiff.js';
import type { DiffRange, DiffSide, FileIcons, OverviewState, PickTarget } from '../protocol.js';
import { $ } from './dom.js';
import { api } from './transport.js';
import type { Ask, Composer, FileComposer, View } from './types.js';

type Layout = 'unified' | 'split';
export interface Saved {
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
export const initial = JSON.parse($('initial').textContent ?? '') as { readonly state: OverviewState; readonly pdfScript?: string };
const saved = (api.getState() ?? {}) as Saved;
export const nonce = document.currentScript?.nonce ?? '';
export const collapsed = new Map(Object.entries(saved.collapsed ?? {}));
export const previewing = new Set(saved.previewing ?? []);
export const replies = new Map(Object.entries(saved.replies ?? {}));
/** Local threads being posted on GitHub, with the text the user is editing. */
export const publishing = new Map(Object.entries(saved.publishing ?? {}));
export const hiddenTypes = new Set(saved.hiddenTypes ?? []);
export const closedFiles = new Set(saved.closedFiles ?? []);

export function save(): void {
  api.setState({ layout: prefs.layout, view: prefs.view, peekWidth: prefs.peekWidth, folders: prefs.folders, collapsed: Object.fromEntries(collapsed), previewing: [...previewing], composer: prefs.composer, fileComposer: prefs.fileComposer, showArchived: prefs.showArchived, guideInFiles: prefs.guideInFiles, replies: Object.fromEntries(replies), publishing: Object.fromEntries(publishing),
    range: prefs.wantedRange ?? received.diffRange, whitespace: prefs.whitespace, filter: prefs.fileFilter, hideViewed: prefs.hideViewed, hiddenTypes: [...hiddenTypes], closedFiles: [...closedFiles], conversationDraft: prefs.conversationDraft, conversationFolded: prefs.conversationFolded, marginThreads: prefs.marginThreads, allFiles: prefs.allFiles, listHidden: prefs.listHidden, navWidth: prefs.navWidth, navThreadsHeight: prefs.navThreadsHeight });
}
/** The open reviewer, assignee or label picker; it saves on close when `selected` differs from `initial`. */
interface Picker { readonly what: PickTarget; readonly initial: ReadonlySet<string>; readonly selected: Set<string>; readonly node: HTMLElement; readonly list: HTMLElement }

export interface Prefs {
  layout: Layout;
  view: View;
  /** Local pages list every repository file by default; PR pages list the changes. */
  allFiles: boolean;
  listHidden: boolean;
  navWidth: number | undefined;
  navThreadsHeight: number | undefined;
  peekWidth: number | undefined;
  folders: boolean;
  composer: Composer | undefined;
  fileComposer: FileComposer | undefined;
  showArchived: boolean;
  guideInFiles: boolean;
  marginThreads: boolean;
  wantedRange: DiffRange | undefined;
  whitespace: boolean;
  fileFilter: string;
  hideViewed: boolean;
  conversationDraft: string;
  conversationFolded: boolean;
}
export const prefs: Prefs = {
  layout: saved.layout === 'split' ? 'split' : 'unified',
  view: saved.view === 'guide' || (saved.view === undefined && saved.layout === 'guided') ? 'guide' : saved.view === 'files' ? 'files' : 'overview',
  allFiles: saved.allFiles ?? initial.state.localMode === true,
  listHidden: saved.listHidden === true,
  navWidth: saved.navWidth,
  navThreadsHeight: saved.navThreadsHeight,
  peekWidth: saved.peekWidth,
  folders: saved.folders === true,
  composer: saved.composer,
  fileComposer: saved.fileComposer,
  showArchived: saved.showArchived === true,
  guideInFiles: saved.guideInFiles === true,
  marginThreads: saved.marginThreads === true,
  wantedRange: saved.range?.kind === 'all' ? undefined : saved.range,
  whitespace: saved.whitespace === true,
  fileFilter: saved.filter ?? '',
  hideViewed: saved.hideViewed === true,
  conversationDraft: saved.conversationDraft ?? '',
  conversationFolded: saved.conversationFolded === true,
};

export interface Received {
  /** Every file in the repository, for the All files list. */
  repositoryFiles: readonly string[];
  fileIcons: FileIcons | undefined;
  files: readonly FileDiff[] | undefined;
  viewed: Set<string>;
  current: OverviewState | undefined;
  readRanges: readonly MarkedRange[];
  /** The commits the Files tab shows, as the extension last confirmed them; `wanted` waits for the PR's commits to arrive. */
  diffRange: DiffRange;
  /** The diff's new side is the PR's latest version, so lines can take comments and show context. */
  atHead: boolean;
  guide: GuideGroup[] | undefined;
  /** Which part of the Claude menu shows: the choices, conversations to resume, or the steps that connect a running Claude. */
  connectView: 'choices' | 'resume' | 'preparing' | 'running';
  conversations: readonly AgentConversation[] | string | undefined;
}
export const received: Received = {
  repositoryFiles: [],
  fileIcons: undefined,
  files: undefined,
  viewed: new Set<string>(),
  current: undefined,
  readRanges: [],
  diffRange: { kind: 'all' },
  atHead: true,
  guide: undefined,
  connectView: 'choices',
  conversations: undefined,
};

export interface Ui {
  /** The open menu under a Files toolbar button: the range or the file filter. */
  toolbarMenu: { readonly anchor: string; readonly node: HTMLElement } | undefined;
  /** Whether the Conversation card shows its older entries; it shows only the latest ones on long PRs. */
  conversationAll: boolean;
  emojiFor: string | undefined;
  mergeMethod: MergeMethod;
  asking: Ask | undefined;
  /** The reviewer whose review the dismiss form is open for, and the reason typed so far. */
  dismissing: { readonly login: string; text: string } | undefined;
  /** A thread opened from its margin mark, to take focus once its file is redrawn. */
  focusThread: string | undefined;
  focusNext: string | undefined;
  sentPending: boolean;
  peekAt: number;
  drag: { path: string; side: DiffSide; from: number; to: number } | undefined;
  busy: boolean;
  author: boolean;
  /** The description is open for editing, so redraws leave it alone. */
  editingBody: boolean;
  picker: Picker | undefined;
  pickerOptions: PickerOptions | undefined;
  pickerError: string | undefined;
  /** Shown while the link field is open, so redraws keep it. */
  linking: boolean;
  baseBranches: readonly string[] | string | undefined;
  /** Set from a Stop click until the state reports Claude idle, so redrawn Stop buttons stay disabled. */
  stoppingClaude: boolean;
  /** Whether the navigator is folded to its heading in a narrow window. */
  navFolded: boolean;
  /** Reviewers picked for the next review; the page updates them before the extension confirms. */
  reviewPicks: readonly Reviewer[] | undefined;
  threadHoverAnchor: HTMLElement | undefined;
  hovered: { id: string; cell: HTMLElement; start: number; end: number } | undefined;
  pointer: MouseEvent | undefined;
  probeTimer: ReturnType<typeof setTimeout> | undefined;
  navFrame: number;
}
export const ui: Ui = {
  toolbarMenu: undefined,
  conversationAll: false,
  emojiFor: undefined,
  mergeMethod: 'squash',
  asking: undefined,
  dismissing: undefined,
  focusThread: undefined,
  focusNext: undefined,
  sentPending: true,
  peekAt: -1,
  drag: undefined,
  busy: false,
  author: true,
  editingBody: false,
  picker: undefined,
  pickerOptions: undefined,
  pickerError: undefined,
  linking: false,
  baseBranches: undefined,
  stoppingClaude: false,
  navFolded: true,
  reviewPicks: undefined,
  threadHoverAnchor: undefined,
  hovered: undefined,
  pointer: undefined,
  probeTimer: undefined,
  navFrame: 0,
};
