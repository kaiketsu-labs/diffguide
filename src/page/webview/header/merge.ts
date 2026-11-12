/** Merge form, merge checklist and branch update menus. */
import type { ChangeRequestConversation, ChangeRequestDetails, MergeMethod } from '../../../core/forge.js';
import { isWriter } from '../conversation/comment.js';
import { $, el, setLabel, stateIcon, type StateShape } from '../dom.js';
import { closeToolbarMenu, menuRow, openToolbarMenu } from '../menus.js';
import { commitsOf } from '../range.js';
import { received, ui } from '../state.js';
import { changePullRequest } from '../status.js';

/** The open merge form; its button confirms on the next click, after `openedAt` plus a double-click's time. */
let mergeForm: { readonly auto: boolean; readonly openedAt: number } | undefined;
export const methodLabels: Record<MergeMethod, string> = { squash: 'Squash and merge', merge: 'Create a merge commit', rebase: 'Rebase and merge' };

/** Default merge commit wording, as the repository's settings tell GitHub to fill it in. */
function mergeDefaults(method: MergeMethod): { readonly headline: string; readonly body: string } {
  const state = received.current;
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
  const { headline, body } = mergeDefaults(ui.mergeMethod);
  const title = $<HTMLInputElement>('merge-headline');
  $<HTMLTextAreaElement>('merge-body').value = body;
  title.value = headline;
  $('merge-form').hidden = ui.mergeMethod === 'rebase';
  $<HTMLInputElement>('merge-delete').checked = false;
  drawMergeButtons();
  (ui.mergeMethod === 'rebase' ? $(auto ? 'auto-merge' : 'merge') : title).focus();
}

export function closeMergeForm(): void {
  mergeForm = undefined;
  $('merge-form').hidden = true;
  drawMergeButtons();
}

/** The merge row's buttons, as the open form and GitHub's merge state allow. */
export function drawMergeButtons(): void {
  const merge = received.current?.conversation?.merge;
  const form = mergeForm;
  const mergeButton = $('merge');
  setLabel(mergeButton, form?.auto === false ? 'Confirm ' + methodLabels[ui.mergeMethod].toLowerCase() : merge?.mergeQueue ? 'Merge when ready' : 'Merge');
  mergeButton.classList.toggle('primary', form?.auto === false);
  mergeButton.hidden = form?.auto === true;
  const auto = $('auto-merge');
  setLabel(auto, form?.auto ? 'Confirm auto-merge' : 'Enable auto-merge');
  auto.className = form?.auto ? 'primary' : 'quiet';
  auto.hidden = form ? !form.auto : !merge?.canEnableAutoMerge || merge.autoMerge !== undefined || merge.state === 'clean' || merge.mergeQueue;
  $('merge-cancel').hidden = !form;
  $('merge-delete-label').hidden = form?.auto !== false || received.current?.details?.branchDeletable !== true;
  $('method-text').textContent = methodLabels[ui.mergeMethod];
}

/** Open the merge form on the first click and merge on the second; a double-click's second click does nothing. */
export function clickMerge(auto: boolean): void {
  if (mergeForm?.auto !== auto) { openMergeForm(auto); return; }
  if (Date.now() - mergeForm.openedAt < 400) return;
  const message = ui.mergeMethod === 'rebase' ? {} : { headline: $<HTMLInputElement>('merge-headline').value, body: $<HTMLTextAreaElement>('merge-body').value };
  if (auto) changePullRequest({ action: 'auto-merge', method: ui.mergeMethod, ...message });
  else changePullRequest({ action: 'merge', method: ui.mergeMethod, ...message, deleteBranch: $<HTMLInputElement>('merge-delete').checked && received.current?.details?.branchDeletable === true });
}

export function openMethodMenu(): void {
  const methods = received.current?.details?.mergeMethods ?? [];
  openToolbarMenu('method', methods.map((method) => menuRow([methodLabels[method]], method === ui.mergeMethod, (on) => {
    if (!on) return;
    ui.mergeMethod = method;
    closeToolbarMenu();
    if (mergeForm) openMergeForm(mergeForm.auto);
    else drawMergeButtons();
  }, true)), 'method-menu');
}

export function openUpdateMenu(): void {
  const update = (method: 'merge' | 'rebase'): void => { closeToolbarMenu(); changePullRequest({ action: 'update-branch', method }); };
  openToolbarMenu('update-branch', [
    menuRow(['Update with merge commit'], false, (on) => { if (on) update('merge'); }, true),
    menuRow([el('span', '', 'Update with rebase'), el('span', 'muted', 'Rewrites commits')], false, (on) => { if (on) update('rebase'); }, true),
  ], 'update-menu');
}

/** GitHub's merge box checklist: reviews, checks and branch protection. */
export function mergeChecklist(details: ChangeRequestDetails, conversation: ChangeRequestConversation): HTMLLIElement[] {
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
