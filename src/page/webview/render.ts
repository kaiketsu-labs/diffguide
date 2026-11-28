/** Renders the whole page from the extension's state, and switches tabs. */
import { buildGuide } from '../../core/prAnalysis.js';
import { icons } from '../icons.js';
import type { OverviewState } from '../protocol.js';
import { renderAnswers } from './answers.js';
import { renderClaude } from './claude/panel.js';
import { isWriter, reactionsRow, toolButton } from './conversation/comment.js';
import { renderConversation } from './conversation/timeline.js';
import { $, detailsLoading, el, icon, placeholders, stateIcon } from './dom.js';
import { openSearch, showListToggle } from './files/filters.js';
import { drawPendingDiffs, renderFiles } from './files/render.js';
import { guideState } from './guide/model.js';
import { renderPush } from './header/actions.js';
import { branchRef, copyRef, failingCheck, openedLine, pullRequestChip, pullRequestFacts, renderLinked, renderState, reviewVerdict, showHeadStatus } from './header/pullRequest.js';
import { baseButton, renderReviewers } from './header/reviewers.js';
import { renderSync } from './header/sync.js';
import { closeToolbarMenu } from './menus.js';
import { renderRangeControls, requestFiles, sameRange } from './range.js';
import { showReview } from './review/review.js';
import { collapsed, guided, prefs, received, save, ui } from './state.js';
import { changePullRequest, noteWorking, setBusy, showNotice, status } from './status.js';
import { closeReviewForm, pendingCount, showReviewForm } from './review/finish.js';
import { renderNavThreads, renderPendingList, renderThreadList } from './threads/list.js';
import { archiving } from './threads/model.js';
import { renderBatch } from './threads/suggestions.js';
import type { Order, View } from './types.js';

let guideStamp = '';

const shortcuts = 'j / k next or previous file · n / p next or previous comment · v toggle Viewed · t filter files · ? this list';

/** j/k move between files, n/p between comments, v ticks Viewed on the file at the top, t filters files. */
export function onShortcut(event: KeyboardEvent): void {
  if (event.metaKey || event.ctrlKey || event.altKey) return;
  const target = event.target;
  if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement || (target instanceof HTMLElement && target.isContentEditable)) return;
  const top = (prefs.view === 'code' ? $('code-bar') : $('files-bar')).getBoundingClientRect().bottom + 4;
  const step = (selector: string, forward: boolean): void => {
    const nodes = [...document.querySelectorAll<HTMLElement>(selector)];
    const index = nodes.findIndex((node) => node.getBoundingClientRect().top > top + 1);
    const next = forward ? nodes[index < 0 ? nodes.length : index] : nodes[(index < 0 ? nodes.length : index) - 2];
    const fallback = forward ? undefined : nodes[0];
    (next ?? fallback)?.scrollIntoView({ block: 'start' });
  };
  if (event.key === 'j' || event.key === 'k') step('#files .file', event.key === 'j');
  else if (event.key === 'n' || event.key === 'p') {
    drawPendingDiffs();
    const nodes = [...document.querySelectorAll<HTMLElement>('#files details.thread')];
    const middle = window.innerHeight / 2;
    const index = nodes.findIndex((node) => node.getBoundingClientRect().top > middle + 1);
    const next = event.key === 'n' ? nodes[index < 0 ? nodes.length : index] : nodes[(index < 0 ? nodes.length : index) - 2] ?? nodes[0];
    next?.scrollIntoView({ block: 'center' });
  } else if (event.key === 'v') {
    const box = [...document.querySelectorAll<HTMLElement>('#files .file')].find((node) => node.getBoundingClientRect().bottom > top);
    box?.querySelector<HTMLInputElement>('label.viewed input')?.click();
  } else if (event.key === 't') { event.preventDefault(); openSearch(); }
  else if (event.key === '?') showNotice({ text: shortcuts });
  else return;
}

/** A list row holding one placeholder bar. */
function placeholderRow(width: number): HTMLElement {
  const row = el('li');
  row.append(...placeholders(width));
  return row;
}

export function render(state: OverviewState): void {
  noteWorking(received.current, state);
  if (ui.toolbarMenu?.anchor === 'push-menu' && (received.current?.details?.canEdit !== state.details?.canEdit || received.current?.unpushed?.length !== state.unpushed?.length)) closeToolbarMenu();
  if (ui.toolbarMenu?.anchor === 'page-menu-button' && (received.current?.claude.link === undefined) !== (state.claude.link === undefined)) closeToolbarMenu();
  received.current = state;
  queueMicrotask(renderAnswers);
  renderSync(state);
  for (const thread of state.threads) if (archiving.get(thread.id) === (thread.archived === true)) archiving.delete(thread.id);
  $('number').replaceChildren(...state.number === undefined ? [] : [copyRef('#' + state.number, state.url, 'link to the pull request')]);
  $('title').textContent = state.heading ?? state.title;
  const canChangeBase = state.details?.canEdit === true && state.details.open;
  const byline = JSON.stringify([state.headBranch, state.baseBranch, canChangeBase, state.branchPullRequest]);
  if ($('byline').dataset.stamp !== byline) {
    $('byline').dataset.stamp = byline;
    if (ui.toolbarMenu?.anchor === 'change-base') closeToolbarMenu();
    if (state.localMode && !state.headBranch) $('byline').replaceChildren('Files in this folder, outside Git');
    else if (state.localMode) $('byline').replaceChildren('on ', branchRef(state.headBranch), ...state.branchPullRequest ? [pullRequestChip(state.branchPullRequest)] : []);
    else $('byline').replaceChildren(branchRef(state.headBranch), '→', branchRef(state.baseBranch), ...canChangeBase ? [baseButton()] : []);
  }
  if (!state.localMode) $('facts').replaceChildren(...pullRequestFacts(state));
  $('opened').replaceChildren(...openedLine(state));
  const { details } = state;
  const loading = detailsLoading(state);
  const body = $('body');
  if (!details) body.replaceChildren(...state.detailsError ? [el('span', 'muted', 'Could not load from GitHub: ' + state.detailsError)] : placeholders(70, 55));
  else if (!ui.editingBody && details.bodyHtml.trim()) body.innerHTML = details.bodyHtml;
  else if (!ui.editingBody) body.replaceChildren(el('span', 'muted', 'No description.'));
  renderReviewers(state);
  const checks = $('checks');
  checks.replaceChildren();
  if (details) {
    const extras = new Map((state.conversation?.checks ?? []).map((check) => [check.name, check]));
    for (const check of details.checks) {
      const extra = extras.get(check.name);
      const tools: HTMLElement[] = [];
      if (extra?.required) tools.push(el('span', 'file-chip', 'Required'));
      const runId = extra?.runId;
      if (check.state === 'failure' && runId !== undefined && isWriter(state.conversation)) {
        const rerun = toolButton(icons.sync, 'Re-run failed jobs', () => changePullRequest({ action: 'rerun', run: runId }));
        rerun.dataset.prAction = '';
        tools.push(rerun);
      }
      checks.append(status(check.state, check.name, check.url, tools));
    }
    if (!details.checks.length) checks.append(el('li', 'muted', 'No checks.'));
  } else if (loading) checks.append(placeholderRow(60));
  for (const id of ['pick-reviewers', 'pick-assignees', 'pick-labels', 'pick-milestone']) $(id).hidden = !details?.canEdit;
  $('edit-title').hidden = !details?.canEdit || document.getElementById('title-form') !== null;
  $('title').classList.toggle('editable', details?.canEdit === true);
  $('milestone').replaceChildren(...details ? [details.milestone ? el('span', '', details.milestone.title) : el('span', 'muted', 'No milestone.')] : loading ? placeholders(40) : []);
  const linked = state.conversation?.linkedIssues ?? [];
  $('development').hidden = linked.length === 0;
  $('linked-issues').replaceChildren(...linked.map((issue) => {
    const item = el('li', 'row');
    const link = el('a', '', '#' + issue.number + ' ' + issue.title);
    link.href = issue.url;
    item.append(stateIcon(issue.open ? 'idle' : 'done', issue.open ? 'ok' : 'muted'), link);
    item.title = issue.open ? 'Open; merging this PR closes it' : 'Closed';
    return item;
  }));
  const awaiting = state.conversation?.awaitingApproval.length ?? 0;
  $('awaiting').hidden = awaiting === 0;
  $('awaiting-note').textContent = awaiting + (awaiting === 1 ? ' workflow waits' : ' workflows wait') + ' for approval to run.';
  const descriptionReactions = $('description-reactions');
  const description = state.conversation?.description;
  const drawReactions = (): void => {
    if (description) descriptionReactions.replaceChildren(reactionsRow(description.id, description.reactions, description.canReact, drawReactions));
    else descriptionReactions.replaceChildren();
  };
  drawReactions();
  renderConversation(state);
  renderRangeControls();
  renderBatch();
  if (prefs.wantedRange !== undefined && (state.conversation || state.conversationError)) {
    const next = prefs.wantedRange;
    prefs.wantedRange = undefined;
    if (state.conversation && !sameRange(next, received.diffRange)) requestFiles(next, prefs.whitespace);
  }
  $('edit-body').hidden = !details?.canEdit || ui.editingBody;
  $('assignees').replaceChildren(...details?.assignees.length ? details.assignees.map((name) => el('li', '', name)) : details ? [el('li', 'muted', 'Nobody assigned.')] : loading ? [placeholderRow(50)] : []);
  $('labels').replaceChildren(...details?.labels.length ? details.labels.map((label) => {
    const chip = el('span', 'label', label.name);
    chip.style.setProperty('--label', '#' + label.color);
    return chip;
  }) : details ? [el('span', 'muted', 'No labels.')] : loading ? placeholders(45) : []);
  $('details-summary').textContent = details ? [details.assignees.join(', ') || 'Unassigned', details.labels.map((label) => label.name).join(', ') || 'No labels', details.milestone?.title ?? 'No milestone', ...linked.map((issue) => '#' + issue.number)].join(' · ') : '';
  const reviewed = $('reviewed');
  reviewed.replaceChildren();
  if (state.reviewed) {
    const wrap = el('div', 'bar');
    const fill = el('span');
    fill.style.width = (state.reviewed.total ? 100 * state.reviewed.done / state.reviewed.total : 0) + '%';
    wrap.append(fill);
    reviewed.append(wrap, el('span', '', state.reviewed.done + ' of ' + state.reviewed.total + ' viewed'));
  } else if (state.reviewedPending) {
    const bar = el('span', 'skeleton');
    bar.style.width = '160px';
    reviewed.append(bar);
  }
  renderClaude(state);
  const unpushed = state.unpushed?.length ?? 0;
  if (!unpushed && ui.toolbarMenu?.anchor === 'push-menu') closeToolbarMenu();
  renderPush();
  renderThreadList();
  renderLinked(state);
  ui.author = !details || details.viewerIsAuthor;
  setBusy(ui.busy);
  renderPendingList(pendingCount() !== undefined);
  showReviewForm();
  showHeadStatus($('verdict'), details?.open ? reviewVerdict(details.reviewers) : undefined);
  showHeadStatus($('check-status'), details?.open ? failingCheck(details) : undefined);
  const prState = $('pr-state');
  const ended = details && !details.open ? (details.merged ? 'merged' : 'closed') : undefined;
  prState.hidden = ended === undefined;
  if (ended && !prState.classList.contains(ended)) {
    prState.className = 'verdict pr-state pr-only ' + ended;
    prState.replaceChildren(icon(ended === 'merged' ? icons.merge : icons.closePullRequest), ended === 'merged' ? 'Merged' : 'Closed');
  }
  $<HTMLTextAreaElement>('review').disabled = loading;
  $('bar-review').hidden = !details?.open;
  if (!details?.open) closeReviewForm();
  $('merge-box').hidden = !details && !loading;
  $('method').parentElement!.hidden = loading;
  if (details) {
    renderState(details);
  } else if (loading) $('merge-status').replaceChildren(placeholderRow(55), placeholderRow(40));
  const next = new Set(state.viewed);
  for (const path of next) if (!received.viewed.has(path)) collapsed.set(path, true);
  for (const path of received.viewed) if (!next.has(path)) collapsed.set(path, false);
  received.viewed = next;
  save();
  received.readRanges = state.read;
  const { analysis } = state;
  showReview();
  const stamp = JSON.stringify([analysis.result?.createdAt, analysis.stale, analysis.behind, analysis.result ? analysis.stale && analysis.running : [analysis.running, analysis.error]]);
  if (stamp !== guideStamp) {
    guideStamp = stamp;
    received.guide = undefined;
    if (guided()) { renderFiles(); return; }
  }
  const localPaths = Object.keys(state.local ?? {}).sort().join('\0');
  if (localPaths !== shownLocalPaths) {
    shownLocalPaths = localPaths;
    if (prefs.folders && prefs.view === 'code' && !guided()) { renderFiles(); return; }
  }
  renderFiles('state');
}

/** Paths with local work at the last full draw, so folder marks redraw when the set changes. */
let shownLocalPaths = '';

/** Switch to Conversation, or to the Guide or Files tab (`order`), keeping the tab bar where it is when the page is scrolled past the header. */
export function setView(next: View, order: Order = prefs.order): void {
  prefs.view = next;
  prefs.order = order;
  closeToolbarMenu();
  if (guided() && (received.diffRange.kind !== 'all' || prefs.whitespace)) requestFiles({ kind: 'all' }, false);
  save();
  renderFiles();
  renderNavThreads();
  const bar = $('files-bar');
  const panelTop = (next === 'overview' ? $('panel-overview') : $('panel-files')).getBoundingClientRect().top + window.scrollY - bar.offsetHeight;
  if (window.scrollY > panelTop) window.scrollTo(0, panelTop);
}

/** The Files tab's count of changed files (and the local header's), and the Guide tab, which moves while Claude builds the guide and warns when it is out of date. */
export function showCodeTab(): void {
  const analysis = received.current?.analysis;
  $('tab-guide').classList.toggle('busy', analysis?.running === true);
  $('guide-stale').hidden = analysis?.running === true || analysis?.result === undefined || !analysis.stale;
  const changed = received.files?.filter((file) => file.change !== 'unchanged').length;
  $('files-count').textContent = changed === undefined ? '' : String(changed);
  if (received.current?.localMode) $('facts').textContent = changed === undefined ? '' : changed + (changed === 1 ? ' file' : ' files');
  $('nav-tools').classList.toggle('off-view', guided() && analysis?.result !== undefined);
  showListToggle();
}

/** Show the guided layout with a step's group and the step open, scrolled to it. */
export function revealStep(key: string): void {
  prefs.view = 'code';
  prefs.order = 'guide';
  const result = received.current?.analysis.result;
  if (received.files && result) {
    received.guide ??= buildGuide(result, received.files);
    const group = received.guide.find((item) => item.steps.some((step) => step.key === key));
    if (group) {
      collapsed.set(guideState('group', group.key), false);
      collapsed.set(guideState('step', key), false);
    }
  }
  save();
  renderFiles();
  document.querySelector('.step-wrap[data-key="' + CSS.escape(key) + '"]')?.scrollIntoView({ block: 'start' });
}

/** Show the guided layout with a section unfolded, scrolled to its head. */
export function revealGroup(key: string): void {
  prefs.view = 'code';
  prefs.order = 'guide';
  collapsed.set(guideState('group', key), false);
  save();
  renderFiles();
  document.querySelector('[data-group="' + CSS.escape(key) + '"]')?.closest('.tree-node')?.scrollIntoView({ block: 'start' });
}
