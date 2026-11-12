/** Page header: PR state, title, description, branch chips and linked changes. */
import type { ChangeRequestDetails } from '../../../core/forge.js';
import { icons } from '../../icons.js';
import type { OverviewState, PageMessage } from '../../protocol.js';
import { $, button, el, icon, timeLabel } from '../dom.js';
import { askInline, askRow } from '../menus.js';
import { render } from '../render.js';
import { received, ui } from '../state.js';
import { changePullRequest } from '../status.js';
import { post } from '../transport.js';
import { closeMergeForm, drawMergeButtons, mergeChecklist, methodLabels } from './merge.js';

const verdictText = { changes: ['bad', 'Changes requested by '], approved: ['ok', 'Approved by '], commented: ['muted', 'Commented: '] } as const;

/** Your open PR from the local page's branch; clicking turns this tab into its review page. */
export function pullRequestChip({ number, title }: NonNullable<OverviewState['branchPullRequest']>): HTMLButtonElement {
  const chip = button('', () => post({ action: 'open-pr' }), 'small pr-chip');
  chip.append(icon(icons.github), 'PR #' + number);
  chip.dataset.tip = 'Review #' + number + ' ' + title + ' in this tab';
  return chip;
}

/** A branch name that copies itself, like GitHub's. */
export function branchRef(name: string): HTMLButtonElement {
  return copyRef(name, name, 'branch name');
}

/** A chip showing `text` that copies `value`; `what` names the value in its tooltip and error. */
export function copyRef(text: string, value: string, what: string): HTMLButtonElement {
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

export function editBody(): void {
  const details = received.current?.details;
  if (!details) return;
  ui.editingBody = true;
  const area = el('textarea');
  area.value = details.body;
  area.setAttribute('aria-label', 'Description');
  const cancel = button('Cancel', () => { ui.editingBody = false; if (received.current) render(received.current); }, 'quiet');
  const save = button('Save', () => changePullRequest({ action: 'edit-body', body: area.value }), 'primary');
  save.dataset.prAction = '';
  const row = el('div', 'row actions review-actions');
  row.append(cancel, save);
  $('body').replaceChildren(area, row);
  $('edit-body').hidden = true;
  area.focus();
}

/** The merge box: merge controls while open, then the PR's state and what you can still do with it. */
export function renderState(details: ChangeRequestDetails): void {
  const draft = details.open && details.draft;
  $('merge-title').textContent = details.merged ? 'Merged' : !details.open ? 'Closed' : draft ? 'Draft' : 'Merge';
  const conversation = received.current?.conversation;
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
  if (!details.mergeMethods.includes(ui.mergeMethod)) ui.mergeMethod = details.mergeMethods[0] ?? 'squash';
  if (!details.open || draft || queued) closeMergeForm();
  else drawMergeButtons();
  $('mergeable').textContent = draft ? 'Mark it ready for review before merging.'
    : !details.open ? (details.merged ? '' : 'Closed without merging.')
    : '';
  // On your own checkout, the agent fixes conflicts in the conversation you connected, so the page has no Fix conflicts button.
  const conflicted = details.open && details.mergeable === 'no' && details.canEdit && received.current?.claude.link === undefined;
  const question = conflicted && received.current?.claude.running !== true ? received.current?.conflictQuestion : undefined;
  $('conflict-row').hidden = !conflicted || question !== undefined;
  $('conflict-ask').hidden = question === undefined;
  const reply = $('conflict-reply');
  if (question !== undefined && reply.dataset.html !== question) {
    reply.dataset.html = question;
    reply.innerHTML = question;
  }
  $<HTMLButtonElement>('fix-conflicts').disabled = received.current?.claude.running === true;
  const fixing = received.current?.claude.fixingConflicts;
  const note = $('conflict-note');
  note.className = fixing === undefined ? 'muted' : 'chip agent working';
  note.replaceChildren(...fixing === undefined ? [] : [el('span', '', fixing)]);
  note.title = fixing ?? '';
  const actions: HTMLButtonElement[] = [];
  const add = (label: string, message: PageMessage, className = 'quiet', question?: string): void => {
    const send = (): void => changePullRequest(message);
    const node = button(label, question === undefined ? send : () => askInline({ key: 'state', question, label, send, redraw: () => { if (received.current?.details) renderState(received.current.details); } }), className);
    node.dataset.prAction = '';
    actions.push(node);
  };
  const number = received.current?.number === undefined ? 'this PR' : '#' + received.current.number;
  if (details.canEdit && details.open && !draft) add('Convert to draft', { action: 'draft', draft: true });
  if (details.canEdit && details.open) add('Close pull request', { action: 'close' }, 'quiet', 'Close ' + number + ' without merging? You can reopen it later.');
  if (details.canEdit && draft) add('Ready for review', { action: 'draft', draft: false }, 'primary');
  if (details.canEdit && !details.open && !details.merged) add('Reopen', { action: 'reopen' });
  if (details.merged && details.branchDeletable && merge?.headDeleted !== true) add('Delete branch', { action: 'delete-branch' }, '', 'Delete the branch ' + (received.current?.headBranch ?? '') + ' on GitHub?');
  if (!details.open && details.canEdit && merge?.headDeleted === true) add('Restore branch', { action: 'restore-branch' }, '');
  if (details.merged && details.canEdit) add('Revert', { action: 'revert' }, '', 'Open a PR that reverts ' + number + '? GitHub creates a branch with a revert commit.');
  $('state-actions').replaceChildren(...ui.asking?.key === 'state' ? [askRow(ui.asking)] : actions);
}

export function verdict(reviewers: ChangeRequestDetails['reviewers']): readonly [string, string] {
  for (const key of ['changes', 'approved', 'commented'] as const) {
    const names = reviewers.filter((reviewer) => reviewer.state === key).map((reviewer) => reviewer.name);
    if (names.length) return [verdictText[key][0], verdictText[key][1] + names.join(', ')];
  }
  const waiting = reviewers.filter((reviewer) => reviewer.state === 'requested').map((reviewer) => reviewer.name);
  return waiting.length ? ['wait', 'Waiting for ' + waiting.join(', ')] : ['muted', 'No reviews yet'];
}

/** The Linked changes card: each other repository's PR and its state, or the branch Claude made there, with their actions. */
export function renderLinked(state: OverviewState): void {
  const rows = state.linked ?? [];
  const card = $('linked');
  card.hidden = state.linked === undefined;
  const stamp = JSON.stringify([rows, ui.linking]);
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
  $('link-pr').hidden = ui.linking;
  if (!ui.linking) return;
  const form = el('div', 'link-form');
  const input = el('input');
  input.type = 'text';
  input.placeholder = 'https://github.com/owner/repo/pull/12 or owner/repo#12';
  input.setAttribute('aria-label', 'PR to link');
  const close = (): void => { ui.linking = false; if (received.current) renderLinked(received.current); };
  const submit = (): void => { if (input.value.trim()) post({ action: 'link', link: input.value.trim() }); };
  input.addEventListener('keydown', (event) => { if (event.key === 'Enter') { event.preventDefault(); submit(); } else if (event.key === 'Escape') close(); });
  form.append(input, button('Cancel', close, 'quiet'), button('Link', submit, 'primary'));
  $('linked-rows').after(form);
  input.focus();
}

/** Swap the title for a text field with Cancel and Save. */
export function editTitle(): void {
  const input = el('input');
  input.type = 'text';
  input.maxLength = 256;
  input.value = received.current?.details?.title ?? received.current?.title ?? '';
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

export function closeTitleForm(): void {
  document.getElementById('title-form')?.remove();
  $('title').hidden = false;
  $('edit-title').hidden = received.current?.details?.canEdit !== true;
}

/** "Opened 3d ago · Updated 2h ago · +312 −48 in 14 files", leaving out what GitHub did not send. */
export function pullRequestFacts(state: OverviewState): (string | Node)[] {
  const parts: (string | Node)[][] = [];
  if (state.createdAt) parts.push(['Opened ', ...timeLabel(state.createdAt)]);
  if (state.updatedAt) parts.push(['Updated ', ...timeLabel(state.updatedAt)]);
  if (state.changes) {
    const { additions, deletions, files } = state.changes;
    parts.push([el('span', 'stat-add', '+' + additions), ' ', el('span', 'stat-del', '−' + deletions), ' in ' + files + (files === 1 ? ' file' : ' files')]);
  }
  return parts.flatMap((part, index) => index === 0 ? part : [' · ', ...part]);
}
