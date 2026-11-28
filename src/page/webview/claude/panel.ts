/** Claude's chip in the header and its menu: state, live steps, review and new answers. */
import type { OverviewState } from '../../protocol.js';
import { $, el } from '../dom.js';
import { renderConnectButton, renderContextButton } from '../header/connect.js';
import { reviewStatus } from '../review/review.js';
import { ui } from '../state.js';
import { elapsed, runMotion, stepLog } from '../status.js';

export function toggleClaudeMenu(): void {
  const menu = $('claude-menu');
  menu.hidden = !menu.hidden;
  $('claude-chip').setAttribute('aria-expanded', String(!menu.hidden));
}

export function closeClaudeMenu(): void {
  $('claude-menu').hidden = true;
  $('claude-chip').setAttribute('aria-expanded', 'false');
}

/** The extension's status text without its leading "Claude", which the chip and the menu already name: "Claude idle" reads "Idle". */
function statusText(text: string): string {
  const bare = text.replace(/^Claude(?: · |\s+)/u, '');
  return bare.charAt(0).toUpperCase() + bare.slice(1);
}

/** Claude's status, its live steps, Stop, Retry and Open in terminal, and the chip that sums them up. */
export function renderClaude(state: OverviewState): void {
  const { claude } = state;
  const progress = claude.running ? claude.progress : undefined;
  const status = statusText(claude.text);
  $('claude').textContent = status;
  $('claude-log').replaceChildren(...progress === undefined ? [] : [stepLog(progress.steps, progress.startedAt, undefined, runMotion(progress))]);
  const stop = $<HTMLButtonElement>('stop-claude');
  stop.hidden = !claude.running;
  if (!claude.running) { ui.stoppingClaude = false; stop.disabled = false; }
  $('retry').hidden = !claude.retry;
  renderConnectButton(claude.link);
  renderContextButton(claude);
  const review = reviewStatus();
  const chip = $('claude-chip');
  chip.classList.toggle('working', claude.running || state.review?.running === true);
  const text = chip.querySelector('.chip-text');
  if (progress !== undefined) {
    const time = el('span', 'time', elapsed(progress.startedAt));
    time.dataset.since = String(progress.startedAt);
    text?.replaceChildren(status + ' · ', time);
  } else text?.replaceChildren(claude.running ? status : review ?? (status === 'Idle' ? 'Claude' : status));
}
