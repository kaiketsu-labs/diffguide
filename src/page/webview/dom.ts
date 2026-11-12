/** DOM helpers: elements, buttons, icons, times and avatars. */
import { icons } from '../icons.js';
import type { CheckState, ReviewerState } from './types.js';

export const $ = <T extends HTMLElement = HTMLElement>(id: string): T => document.getElementById(id) as T;
const stateShapes = { done: icons.check, failed: icons.close, active: icons.dot, idle: icons.circle } as const;
export type StateShape = keyof typeof stateShapes;
export const labels: Record<ReviewerState | CheckState, readonly [StateShape, string, string]> = {
  approved: ['done', 'ok', 'Approved'], changes: ['failed', 'bad', 'Requested changes'], commented: ['active', 'muted', 'Commented'],
  dismissed: ['idle', 'muted', 'Dismissed'], requested: ['idle', 'wait', 'Review requested'],
  success: ['done', 'ok', 'Passed'], failure: ['failed', 'bad', 'Failed'], pending: ['active', 'wait', 'Running'], neutral: ['idle', 'muted', 'Skipped'],
};
/** Checks show their state by icon alone; reviewers keep the word, since requested and dismissed share an icon. */
export const checkStates: ReadonlySet<string> = new Set<CheckState>(['success', 'failure', 'pending', 'neutral']);

export function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

export function button(label: string, onClick: () => void, className?: string): HTMLButtonElement {
  const node = el('button', className ?? '');
  setLabel(node, label);
  node.addEventListener('click', onClick);
  return node;
}

/** A button that sends to the agent: filled slate for the row's main action, outlined slate otherwise. */
export function agentButton(intent: 'ask' | 'implement' | 'draft', label: string, onClick: () => void, filled = intent === 'ask'): HTMLButtonElement {
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
export function setLabel(node: HTMLElement, label: string): void {
  const words = label.split(' ');
  const svg = labelIcons[words.slice(0, 2).join(' ')] ?? labelIcons[words[0] ?? ''];
  node.replaceChildren(...svg === undefined ? [] : [icon(svg)], label);
}

/** Sets a node's tooltip and returns the node. */
export function titled<T extends HTMLElement>(node: T, tip: string): T {
  node.title = tip;
  return node;
}

/** A text button led by `svg` instead of its label's icon. */
export function iconButton(svg: string, label: string, onClick: () => void, className?: string): HTMLButtonElement {
  const node = button(label, onClick, className);
  node.replaceChildren(icon(svg), label);
  return node;
}

export function icon(svg: string): Element {
  const template = document.createElement('template');
  template.innerHTML = svg;
  return template.content.firstElementChild as Element;
}

/** A state icon colored by `tone`; `label` names the state for screen readers and on hover. */
export function stateIcon(shape: StateShape, tone: string, label?: string): HTMLElement {
  const node = el('span', 'state-icon ' + tone);
  node.append(icon(stateShapes[shape]));
  if (label !== undefined) {
    node.title = label;
    node.setAttribute('role', 'img');
    node.setAttribute('aria-label', label);
  }
  return node;
}

export function closestTo<T extends Element = HTMLElement>(event: Event, selector: string): T | null {
  return event.target instanceof Element ? event.target.closest<T>(selector) : null;
}

/** Avatars that loaded, held so redraws reuse the decoded picture instead of fetching and blinking. */
const loadedAvatars = new Map<string, HTMLImageElement>();
const failedAvatars = new Set<string>();

/** An avatar image, or initials when the picture is missing or does not load. */
export function personAvatar(url: string, name: string | undefined, title: string): HTMLElement {
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

/** "just now", "5m ago", "3h ago", "2d ago", then the date. */
export function relativeTime(iso: string): string {
  const minutes = Math.floor((Date.now() - Date.parse(iso)) / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return minutes + 'm ago';
  if (minutes < 24 * 60) return Math.floor(minutes / 60) + 'h ago';
  if (minutes < 30 * 24 * 60) return Math.floor(minutes / (24 * 60)) + 'd ago';
  return new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

export function timeLabel(iso: string): HTMLElement[] {
  if (Number.isNaN(Date.parse(iso))) return [];
  const node = el('time', 'when', relativeTime(iso));
  node.dateTime = iso;
  node.title = new Date(iso).toLocaleString();
  return [node];
}

/** Up to two letters for a person without a picture: first and last word of a name, or the start of a single-word login. */
function initials(name: string): string {
  const words = name.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  const first = words[0];
  if (first === undefined) return '';
  const last = words.length > 1 ? words.at(-1) : undefined;
  return ((first[0] ?? '') + (last?.[0] ?? '')).toUpperCase();
}

/** Collapsing a thread from its stuck header would leave the page far below it; keep the header where it was on screen. */
export function keepInView(box: HTMLElement, summary: HTMLElement): void {
  const before = summary.getBoundingClientRect().top;
  if (box.getBoundingClientRect().top >= before) return;
  box.addEventListener('toggle', () => { window.scrollBy(0, box.getBoundingClientRect().top - before); }, { once: true });
}

/** The fold arrow: points down when open, right when collapsed. */
export function chevronMark(collapsed: boolean): HTMLElement {
  return el('span', collapsed ? 'chevron closed' : 'chevron');
}

/** Sets a button's hover tip and its accessible name together. */
export function setTip(button: HTMLElement, tip: string): void {
  button.dataset.tip = tip;
  button.setAttribute('aria-label', tip);
}
