/** Tracks agent answers the user has not seen yet. */
import { icons } from '../icons.js';
import { $, button, el, icon, relativeTime } from './dom.js';
import { jump } from './files/table.js';
import { received } from './state.js';
import { post } from './transport.js';

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
export function watchAnswer(item: HTMLElement, thread: { readonly id: string; readonly newAnswer?: string }): void {
  if (seenAnswers.has(answerKey(thread))) return;
  item.dataset.answer = thread.id;
  item.dataset.answerKey = answerKey(thread);
  answerWatch.observe(item);
}

/** The floating list of Claude's new answers that are off screen; a row jumps to its thread. */
export function renderAnswers(): void {
  const box = $('answers');
  const fresh = (received.current?.threads ?? []).filter((thread) => thread.newAnswer !== undefined && !seenAnswers.has(answerKey(thread)))
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
