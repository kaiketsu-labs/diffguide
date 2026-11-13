/** Reviewers, review dismissal and the base branch menu. */
import { icons } from '../../icons.js';
import type { OverviewState } from '../../protocol.js';
import { isWriter, toolButton } from '../conversation/comment.js';
import { $, button, detailsLoading, el, placeholders } from '../dom.js';
import { askInMenu, menuRow, openToolbarMenu } from '../menus.js';
import { received, ui } from '../state.js';
import { changePullRequest, status } from '../status.js';
import { textarea } from '../threads/composer.js';
import { post } from '../transport.js';

let reviewersStamp = '';

export function baseButton(): HTMLElement {
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
export function renderReviewers(state: OverviewState, force = false): void {
  const { details, conversation } = state;
  const stamp = JSON.stringify([details?.reviewers, details?.canEdit, details?.open, conversation?.reviewIds, conversation?.viewerLogin, conversation?.permission, ui.dismissing?.login, detailsLoading(state)]);
  if (!force && stamp === reviewersStamp) return;
  reviewersStamp = stamp;
  const reviewers = $('reviewers');
  reviewers.replaceChildren();
  if (!details) {
    if (detailsLoading(state)) {
      const row = el('li');
      row.append(...placeholders(55));
      reviewers.append(row);
    }
    return;
  }
  for (const reviewer of details.reviewers) {
    const tools: HTMLElement[] = [];
    if (details.canEdit && details.open && reviewer.team === undefined && reviewer.state !== 'requested' && reviewer.rerequested !== true && reviewer.name !== conversation?.viewerLogin) {
      const again = toolButton(icons.sync, 'Re-request review', () => changePullRequest({ action: 'rerequest', login: reviewer.name }));
      again.dataset.prAction = '';
      tools.push(again);
    }
    if (isWriter(conversation) && details.open && (reviewer.state === 'approved' || reviewer.state === 'changes') && conversation?.reviewIds[reviewer.name] !== undefined) {
      const dismiss = toolButton(icons.close, 'Dismiss review', () => {
        ui.dismissing = { login: reviewer.name, text: '' };
        renderReviewers(state, true);
        $('reviewers').querySelector('textarea')?.focus();
      });
      dismiss.dataset.prAction = '';
      tools.push(dismiss);
    }
    const row = status(reviewer.state, reviewer.name, undefined, tools);
    if (reviewer.rerequested === true) row.querySelector('.muted')?.append(' · Re-requested');
    reviewers.append(row);
    if (ui.dismissing?.login === reviewer.name) reviewers.append(dismissForm(ui.dismissing));
  }
  if (!details.reviewers.length) reviewers.append(el('li', 'muted', 'No reviewers yet.'));
}

function dismissForm(form: { readonly login: string; text: string }): HTMLElement {
  const close = (): void => { ui.dismissing = undefined; if (received.current) renderReviewers(received.current, true); };
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

/** The base branch menu: a filter over the branches the PR could merge into; GitHub's list arrives after it opens. */
function openBaseMenu(): void {
  if (ui.busy) return;
  const search = el('input');
  search.type = 'text';
  search.placeholder = 'Filter branches';
  search.setAttribute('aria-label', 'Filter branches');
  search.addEventListener('input', () => renderBaseMenu());
  openToolbarMenu('change-base', [search, el('div', 'muted picker-note', 'Loading…')], 'base-menu');
  if (ui.toolbarMenu?.anchor !== 'change-base') return;
  search.focus();
  ui.baseBranches = undefined;
  post({ action: 'branches' });
}

export function renderBaseMenu(): void {
  const list = ui.toolbarMenu?.anchor === 'change-base' ? ui.toolbarMenu.node.querySelector('.picker-list') : null;
  const search = list?.querySelector('input');
  if (!list || !search) return;
  const query = search.value.trim().toLowerCase();
  const names = typeof ui.baseBranches === 'string' || ui.baseBranches === undefined ? [] : ui.baseBranches.filter((name) => name.toLowerCase().includes(query));
  const rows = names.slice(0, 200).map((name) => menuRow([name], false, (on) => {
    if (on) askInMenu('change-base', 'Change the base branch to ' + name + '? The diff and checks follow.', 'Change base', () => changePullRequest({ action: 'change-base', branch: name }));
  }, true));
  const note = typeof ui.baseBranches === 'string' ? 'Could not load branches: ' + ui.baseBranches : ui.baseBranches === undefined ? 'Loading…' : names.length ? '' : query ? 'No matches.' : 'No other branches.';
  list.replaceChildren(search, ...rows, ...note ? [el('div', 'muted picker-note', note)] : []);
}
