/** The Finish review form: a dropdown under Finish review with its own submit button that names the verdict. */
import type { ReviewEvent } from '../../../core/forge.js';
import { icons } from '../../icons.js';
import { $, button, detailsLoading, el, icon } from '../dom.js';
import { received, ui } from '../state.js';
import { changePullRequest, setBusy } from '../status.js';
import { post } from '../transport.js';

const confirmLabels: Record<ReviewEvent, string> = { comment: 'Submit comment', requestChanges: 'Request changes', approve: 'Submit approval' };

/** Picked in the form; every open starts at Comment so a stray submit can't approve. */
let verdict: ReviewEvent = 'comment';
let discarding = false;

const isOpen = (): boolean => !$('review-box').hidden;

/** Comments in your pending review, or undefined without one. */
export function pendingCount(): number | undefined {
  // The details' count comes from a separate read that can lag the threads the pending list shows, so count what the list shows.
  return received.current?.details?.pendingComments === undefined ? undefined
    : (received.current.github ?? []).reduce((sum, thread) => sum + thread.messages.filter((message) => message.pending).length, 0);
}

export function toggleReviewForm(): void {
  if (isOpen()) closeReviewForm();
  else openReviewForm();
}

function submitReview(): void {
  $('error').textContent = '';
  setBusy(true);
  post({ action: 'review', event: ui.author ? 'comment' : verdict, body: $<HTMLTextAreaElement>('review').value });
}

function openReviewForm(): void {
  verdict = 'comment';
  discarding = false;
  $('review-box').hidden = false;
  $('finish-review').setAttribute('aria-expanded', 'true');
  showReviewForm();
  $<HTMLTextAreaElement>('review').focus();
}

/** Close the form; the typed summary stays for next time. */
export function closeReviewForm(): void {
  if (!isOpen()) return;
  discarding = false;
  $('review-box').hidden = true;
  $('finish-review').setAttribute('aria-expanded', 'false');
  showReviewForm();
}

export function pickVerdict(next: ReviewEvent): void {
  verdict = next;
  showReviewForm();
}

/** The button's label and count, and the form's contents, from the verdict and the pending review. */
export function showReviewForm(): void {
  const count = pendingCount();
  const picked = ui.author ? 'comment' : verdict;
  $('finish-count').hidden = !count;
  $('finish-count').textContent = String(count ?? '');
  $('pending-note').hidden = !count;
  $('pending-note').textContent = count + ' pending, only you see them';
  $('verdicts').hidden = ui.author;
  $('author-note').hidden = !ui.author;
  for (const choice of $('verdicts').querySelectorAll<HTMLButtonElement>('[data-verdict]')) choice.setAttribute('aria-pressed', String(choice.dataset.verdict === picked));
  $<HTMLTextAreaElement>('review').placeholder = picked === 'approve' ? 'Leave a summary (optional for approval)' : 'Leave a summary';
  const foot = $('review-foot');
  if (discarding) {
    const confirm = button('Discard', () => { discarding = false; changePullRequest({ action: 'discard-review' }); }, 'primary');
    confirm.dataset.prAction = '';
    confirm.disabled = ui.busy;
    const question = count ? 'Discard ' + count + ' pending comment' + (count === 1 ? '' : 's') + '? Nobody saw them yet.' : 'Discard your pending review? Nobody saw it yet.';
    foot.replaceChildren(el('span', 'muted gap', question), button('Cancel', () => { discarding = false; showReviewForm(); }, 'quiet'), confirm);
  } else {
    const discard = button('Discard pending', () => { discarding = true; showReviewForm(); }, 'quiet');
    discard.dataset.prAction = '';
    discard.disabled = ui.busy;
    const submit = button('', submitReview, 'primary');
    submit.id = 'submit-review';
    submit.replaceChildren(icon(picked === 'requestChanges' ? icons.requestChanges : icons.check), confirmLabels[picked]);
    submit.disabled = ui.busy || detailsLoading(received.current);
    foot.replaceChildren(...count === undefined ? [] : [discard], el('span', 'gap'), button('Cancel', closeReviewForm, 'quiet'), submit);
  }
}
