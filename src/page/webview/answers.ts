/** Tracks agent answers the user has not seen yet and lists them in Claude's menu. */
import type { OverviewState } from '../protocol.js';
import { closeClaudeMenu } from './claude/panel.js';
import { $, el, relativeTime } from './dom.js';
import { jump } from './files/table.js';
import { received } from './state.js';
import { post } from './transport.js';
import type { Thread } from './types.js';

/** New answers already reported seen, as `thread@time`, so a redraw before the next state does not list them again. */
const seenAnswers = new Set<string>();
const answerKey = (thread: { readonly id: string; readonly newAnswer?: string }): string => thread.id + '@' + (thread.newAnswer ?? '');
type OverviewThread = OverviewState['threads'][number];
let seenBatch: string[] = [];
let seenTimer: ReturnType<typeof setTimeout> | undefined;
const answerWatch = new IntersectionObserver((entries) => {
  for (const entry of entries) {
    const { answer: id, answerKey: key } = (entry.target as HTMLElement).dataset;
    if (!entry.target.isConnected) { answerWatch.unobserve(entry.target); continue; }
    if (id === undefined || key === undefined || !entry.isIntersecting || entry.intersectionRatio <= 0.5) continue;
    answerWatch.unobserve(entry.target);
    if (!seenAnswers.has(key)) { seenAnswers.add(key); seenBatch.push(id); }
  }
  if (seenBatch.length) {
    clearTimeout(seenTimer);
    seenTimer = setTimeout(() => { post({ action: 'seen-answers', ids: seenBatch }); seenBatch = []; }, 400);
  }
  renderAnswers();
}, { threshold: [0.5] });

/** Report Claude's new answer seen once half of it is on screen. */
export function watchAnswer(item: HTMLElement, thread: { readonly id: string; readonly newAnswer?: string }): void {
  if (seenAnswers.has(answerKey(thread))) return;
  item.dataset.answer = thread.id;
  item.dataset.answerKey = answerKey(thread);
  answerWatch.observe(item);
}

/** Whether a thread holds an answer from Claude the user has not seen. */
const isFresh = (thread: { readonly id: string; readonly newAnswer?: string }): boolean => thread.newAnswer !== undefined && !seenAnswers.has(answerKey(thread));

/** Claude's unseen answers, newest first. */
export function freshAnswers(): readonly OverviewThread[] {
  return (received.current?.threads ?? []).filter(isFresh).sort((a, b) => (b.newAnswer ?? '').localeCompare(a.newAnswer ?? ''));
}

/** Jump to a thread with an unseen answer. */
export function showAnswer(thread: OverviewThread): void {
  closeClaudeMenu();
  jump({ ...thread, source: 'local' } satisfies Thread);
}

/** The count of new answers on the chip and their list in its menu. */
export function renderAnswers(): void {
  const fresh = freshAnswers();
  const count = fresh.length;
  const chipCount = $('claude-chip').querySelector('.chip-new');
  if (chipCount) chipCount.textContent = count ? '· ' + count + ' new' : '';
  const list = $('claude-answers');
  list.hidden = count === 0;
  list.replaceChildren(...count ? [el('div', 'answers-head', 'New answers')] : [], ...fresh.slice(0, 5).map((thread) => {
    const row = el('button', 'answer-row');
    row.append(el('span', 'text', thread.title ?? thread.text), el('span', 'muted', relativeTime(thread.newAnswer ?? '')));
    row.title = thread.location;
    row.addEventListener('click', () => { showAnswer(thread); });
    return row;
  }), ...count > 5 ? [el('div', 'muted picker-note', '+' + (count - 5) + ' more in the Claude answers view')] : []);
}
