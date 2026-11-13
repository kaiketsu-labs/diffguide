/** Busy state, the page notice, and the agent's working motion. */
import type { AgentProgress, AgentStep } from '../../core/agent.js';
import type { ExtensionMessage, OverviewState, PageMessage } from '../protocol.js';
import { $, button, checkStates, el, labels, stateIcon } from './dom.js';
import { orbCanvas, stepMotion } from './orb.js';
import { received, ui } from './state.js';
import { post } from './transport.js';
import type { CheckState, LiveLog, ReviewerState, StepPick } from './types.js';

export const reviewButtons = [...document.querySelectorAll<HTMLButtonElement>('[data-event]')];

export const elapsed = (since: number, until = Date.now()): string => {
  const seconds = Math.max(0, Math.floor((until - since) / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
};

/** A run's orb motion per step: it wakes as the run starts, then follows the step's verb. */
export const runMotion = (progress: AgentProgress): StepPick => (step) =>
  progress.steps.length === 0 ? ['wake', performance.now() - (Date.now() - progress.startedAt)] : [stepMotion(step.verb)];

/** When each thread's current waiting or pickup state began, so its orb plays the change once; threads already in that state when the page opened skip it. */
export const workingSince = new Map<string, { readonly working: string; readonly since: number }>();
export function noteWorking(before: OverviewState | undefined, state: OverviewState): void {
  const live = new Set<string>();
  for (const { id, working } of state.threads) {
    if (working === undefined) continue;
    live.add(id);
    if (workingSince.get(id)?.working !== working) workingSince.set(id, { working, since: before === undefined ? -Infinity : performance.now() });
  }
  for (const id of workingSince.keys()) if (!live.has(id)) workingSince.delete(id);
}

/** Claude's latest steps like a Claude Code transcript, oldest first: a check on finished ones, the orb, the run's time and `stop` on the current one. */
export function stepLog(steps: readonly AgentStep[], startedAt?: number, stop?: HTMLElement, pick: StepPick = ({ verb }) => [stepMotion(verb)], orb = true, phase = 0): HTMLElement {
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

export function status(key: ReviewerState | CheckState, name: string, url?: string, tools: readonly HTMLElement[] = []): HTMLLIElement {
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

export function setBusy(value: boolean): void {
  ui.busy = value;
  for (const review of reviewButtons) review.disabled = value || (ui.author && review.hasAttribute('data-reviewer'));
  const merge = received.current?.conversation?.merge;
  const mergeLoading = merge === undefined && received.current?.conversationError === undefined;
  $<HTMLButtonElement>('merge').disabled = value || mergeLoading || received.current?.details?.mergeable === 'no' || (merge?.state === 'blocked' && !merge.canBypass && !merge.mergeQueue);
  for (const action of document.querySelectorAll<HTMLButtonElement>('[data-pr-action]')) action.disabled = value;
}

/** Send a change to the PR on GitHub; the page stays busy until the extension answers. */
export function changePullRequest(message: PageMessage): void {
  $('error').textContent = '';
  setBusy(true);
  post(message);
}

let noticeTimer: ReturnType<typeof setTimeout> | undefined;

/** Show a hint that clears itself after a few seconds, on the next click, or on Escape. */
export function showNotice(notice: NonNullable<ExtensionMessage['notice']>): void {
  const box = $('notice');
  const { extension } = notice;
  const link = el('a', '', 'Open on GitHub');
  if (notice.url !== undefined) link.href = notice.url;
  box.replaceChildren(el('span', '', notice.text), ...extension === undefined ? [] : [button('Find extension', () => { post({ action: 'find-extension', extension }); clearNotice(); }, 'small')],
    ...notice.url === undefined ? [] : [link]);
  clearTimeout(noticeTimer);
  noticeTimer = setTimeout(clearNotice, extension === undefined && notice.url === undefined ? 4000 : 8000);
}

/** The shown files are out of date; a notice with Refresh stays, under any other notice, until they reload. */
let stale = false;

export function setStale(on: boolean): void {
  if (stale === on) return;
  stale = on;
  if (noticeTimer === undefined) clearNotice();
}

export function clearNotice(): void {
  clearTimeout(noticeTimer);
  noticeTimer = undefined;
  $('notice').replaceChildren(...stale ? [el('span', '', 'The base branch moved on GitHub. Refresh to see the current changes.'), button('Refresh', () => { $('refresh').click(); }, 'primary small')] : []);
}

const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Once Claude's reply replaces its live log, the old log fades where it was and the orb flies from it up into the reply's avatar. */
export async function hopIntoAvatar(live: LiveLog): Promise<void> {
  const thread = received.current?.threads.find((candidate) => candidate.id === live.threadId);
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
