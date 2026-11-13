/** Renders the whole page from the extension's state, and switches tabs. */
import { buildGuide } from '../../core/prAnalysis.js';
import { icons } from '../icons.js';
import type { OverviewState } from '../protocol.js';
import { renderAnswers } from './answers.js';
import { isWriter, reactionsRow, toolButton } from './conversation/comment.js';
import { renderConversation } from './conversation/timeline.js';
import { $, el, icon, setLabel, stateIcon } from './dom.js';
import { showListToggle } from './files/filters.js';
import { renderFiles } from './files/render.js';
import { guideState } from './guide/model.js';
import { renderConnectButton, renderContextButton } from './header/connect.js';
import { branchRef, copyRef, pullRequestChip, pullRequestFacts, renderLinked, renderState, verdict } from './header/pullRequest.js';
import { baseButton, renderReviewers } from './header/reviewers.js';
import { closeToolbarMenu } from './menus.js';
import { renderRangeControls, requestFiles, sameRange } from './range.js';
import { showReview } from './review/review.js';
import { collapsed, prefs, received, save, ui } from './state.js';
import { changePullRequest, noteWorking, runMotion, setBusy, showNotice, status, stepLog } from './status.js';
import { renderNavThreads, renderPendingList, renderThreadList } from './threads/list.js';
import { archiving } from './threads/model.js';
import { renderBatch } from './threads/suggestions.js';
import type { View } from './types.js';

let guideStamp = '';

const shortcuts = 'j / k next or previous file · n / p next or previous comment · v toggle Viewed · t filter files · ? this list';

/** j/k move between files, n/p between comments, v ticks Viewed on the file at the top, t filters files. */
export function onShortcut(event: KeyboardEvent): void {
  if (event.metaKey || event.ctrlKey || event.altKey) return;
  const target = event.target;
  if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement || (target instanceof HTMLElement && target.isContentEditable)) return;
  const top = $('files-bar').getBoundingClientRect().bottom + 4;
  const step = (selector: string, forward: boolean): void => {
    const nodes = [...document.querySelectorAll<HTMLElement>(selector)];
    const index = nodes.findIndex((node) => node.getBoundingClientRect().top > top + 1);
    const next = forward ? nodes[index < 0 ? nodes.length : index] : nodes[(index < 0 ? nodes.length : index) - 2];
    const fallback = forward ? undefined : nodes[0];
    (next ?? fallback)?.scrollIntoView({ block: 'start' });
  };
  if (event.key === 'j' || event.key === 'k') step('#files .file', event.key === 'j');
  else if (event.key === 'n' || event.key === 'p') {
    const nodes = [...document.querySelectorAll<HTMLElement>('#files details.thread')];
    const middle = window.innerHeight / 2;
    const index = nodes.findIndex((node) => node.getBoundingClientRect().top > middle + 1);
    const next = event.key === 'n' ? nodes[index < 0 ? nodes.length : index] : nodes[(index < 0 ? nodes.length : index) - 2] ?? nodes[0];
    next?.scrollIntoView({ block: 'center' });
  } else if (event.key === 'v') {
    const box = [...document.querySelectorAll<HTMLElement>('#files .file')].find((node) => node.getBoundingClientRect().bottom > top);
    box?.querySelector<HTMLInputElement>('label.viewed input')?.click();
  } else if (event.key === 't') { event.preventDefault(); $('file-filter').focus(); }
  else if (event.key === '?') showNotice({ text: shortcuts });
  else return;
}

export function render(state: OverviewState): void {
  noteWorking(received.current, state);
  received.current = state;
  queueMicrotask(renderAnswers);
  for (const thread of state.threads) if (archiving.get(thread.id) === (thread.archived === true)) archiving.delete(thread.id);
  $('number').replaceChildren(...state.number === undefined ? [] : [copyRef('#' + state.number, state.url, 'link to the pull request')]);
  $('title').textContent = state.heading ?? state.title;
  const canChangeBase = state.details?.canEdit === true && state.details.open;
  const byline = JSON.stringify([state.author, state.headBranch, state.baseBranch, canChangeBase, state.branchPullRequest]);
  if ($('byline').dataset.stamp !== byline) {
    $('byline').dataset.stamp = byline;
    if (ui.toolbarMenu?.anchor === 'change-base') closeToolbarMenu();
    if (state.localMode) $('byline').replaceChildren('Uncommitted changes on', branchRef(state.headBranch), ...state.branchPullRequest ? [pullRequestChip(state.branchPullRequest)] : []);
    else $('byline').replaceChildren(state.author + ' wants to merge', branchRef(state.headBranch), 'into', branchRef(state.baseBranch), ...canChangeBase ? [baseButton()] : []);
  }
  $('facts').replaceChildren(...pullRequestFacts(state));
  const { details } = state;
  const body = $('body');
  if (!details) body.replaceChildren(el('span', 'muted', state.detailsError ? 'Could not load from GitHub: ' + state.detailsError : 'Loading from GitHub…'));
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
  }
  for (const id of ['pick-reviewers', 'pick-assignees', 'pick-labels', 'pick-milestone']) $(id).hidden = !details?.canEdit;
  $('edit-title').hidden = !details?.canEdit || document.getElementById('title-form') !== null;
  $('milestone').replaceChildren(...details ? [details.milestone ? el('span', '', details.milestone.title) : el('span', 'muted', 'No milestone.')] : []);
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
  $('assignees').replaceChildren(...details?.assignees.length ? details.assignees.map((name) => el('li', '', name)) : details ? [el('li', 'muted', 'Nobody assigned.')] : []);
  $('labels').replaceChildren(...details?.labels.length ? details.labels.map((label) => {
    const chip = el('span', 'label', label.name);
    chip.style.setProperty('--label', '#' + label.color);
    return chip;
  }) : details ? [el('span', 'muted', 'No labels.')] : []);
  const reviewed = $('reviewed');
  reviewed.replaceChildren();
  if (state.reviewed) {
    const wrap = el('div', 'bar');
    const fill = el('span');
    fill.style.width = (state.reviewed.total ? 100 * state.reviewed.done / state.reviewed.total : 0) + '%';
    wrap.append(fill);
    reviewed.append(wrap, el('span', '', state.reviewed.done + '/' + state.reviewed.total + ' viewed'));
  }
  const claude = $('claude');
  const terminal = $('terminal');
  const stop = $<HTMLButtonElement>('stop-claude');
  const progress = state.claude.running ? state.claude.progress : undefined;
  claude.after(...$('context').parentElement ? [$('context').parentElement as HTMLElement] : [], stop, terminal);
  if (progress === undefined) claude.replaceChildren(...state.claude.running ? [] : [icon(icons.orb)], state.claude.text);
  else claude.replaceChildren(stepLog(progress.steps, progress.startedAt, stop, runMotion(progress)), terminal);
  stop.hidden = !state.claude.running;
  if (!state.claude.running) { ui.stoppingClaude = false; stop.disabled = false; }
  claude.className = progress !== undefined ? 'claude-box' : state.claude.running ? 'chip agent working' : 'chip orb-chip';
  $('retry').hidden = !state.claude.retry;
  terminal.className = state.claude.running ? 'small' : 'quiet';
  terminal.replaceChildren(icon(icons.terminal), state.claude.running ? 'Stop and open in terminal' : 'Open in terminal');
  terminal.dataset.tip = state.claude.running ? 'Stops the agent\'s background run, then continues its conversation in a terminal' : 'Continue this PR\'s agent conversation in a terminal';
  renderConnectButton(state.claude.link);
  renderContextButton(state.claude);
  const unpushed = state.unpushed?.length ?? 0;
  const push = $('push');
  push.hidden = !unpushed || !details?.canEdit;
  setLabel(push, 'Push ' + unpushed + (unpushed === 1 ? ' commit' : ' commits'));
  $('show-unpushed').hidden = !unpushed;
  renderThreadList();
  renderLinked(state);
  ui.author = !details || details.viewerIsAuthor;
  setBusy(ui.busy);
  for (const review of document.querySelectorAll<HTMLButtonElement>('[data-reviewer]')) review.hidden = ui.author;
  document.querySelector<HTMLButtonElement>('[data-event="comment"]')?.classList.toggle('primary', ui.author);
  $('review-box').querySelector<HTMLButtonElement>('[data-event="comment"]')!.title = ui.author ? 'This is your PR, so you can only comment.' : '';
  // The details' count comes from a separate read that can lag the threads the pending list shows, so count what the list shows.
  const pendingCount = details?.pendingComments === undefined ? undefined
    : (state.github ?? []).reduce((sum, thread) => sum + thread.messages.filter((message) => message.pending).length, 0);
  $('discard-review').hidden = pendingCount === undefined;
  $('pending-note').hidden = pendingCount === undefined;
  $('pending-note').textContent = pendingCount + ' pending comment' + (pendingCount === 1 ? '' : 's');
  renderPendingList(pendingCount !== undefined);
  const badge = $('verdict');
  badge.hidden = !details;
  if (details) {
    const [tone, label] = verdict(details.reviewers);
    badge.className = 'verdict ' + tone;
    badge.textContent = label;
  }
  const prState = $('pr-state');
  const ended = details && !details.open ? (details.merged ? 'merged' : 'closed') : undefined;
  prState.hidden = ended === undefined;
  if (ended && !prState.classList.contains(ended)) {
    prState.className = 'verdict pr-state pr-only ' + ended;
    prState.replaceChildren(icon(ended === 'merged' ? icons.merge : icons.closePullRequest), ended === 'merged' ? 'Merged' : 'Closed');
  }
  $('review-box').hidden = !details?.open;
  $('bar-review').hidden = !details?.open;
  $('bar-pending').hidden = pendingCount === undefined;
  $('bar-pending').textContent = pendingCount + ' pending';
  $('merge-box').hidden = !details;
  if (details) {
    renderState(details);
  }
  const next = new Set(state.viewed);
  for (const path of next) if (!received.viewed.has(path)) collapsed.set(path, true);
  for (const path of received.viewed) if (!next.has(path)) collapsed.set(path, false);
  received.viewed = next;
  save();
  received.readRanges = state.read;
  const { analysis } = state;
  const analyze = $<HTMLButtonElement>('analyze');
  setLabel(analyze, analysis.running ? 'Stop' : analysis.result ? 'Rebuild guide' : 'Build guide');
  const analysisStatus = $('analysis-status');
  analysisStatus.textContent = analysis.running ? 'Guide · ' + (analysis.step ?? 'Working') : analysis.error ? 'Guide failed' : '';
  analysisStatus.title = analysis.error ?? '';
  analysisStatus.className = analysis.running ? 'chip agent working' : analysis.error ? 'chip bad' : '';
  analysisStatus.hidden = !analysis.running && !analysis.error;
  showReview();
  const stamp = JSON.stringify([analysis.result?.createdAt, analysis.stale, analysis.behind, analysis.result ? analysis.stale && analysis.running : [analysis.running, analysis.error]]);
  if (stamp !== guideStamp) {
    guideStamp = stamp;
    received.guide = undefined;
    if (prefs.view === 'guide') { renderFiles(); return; }
  }
  const localPaths = Object.keys(state.local ?? {}).sort().join('\0');
  if (localPaths !== shownLocalPaths) {
    shownLocalPaths = localPaths;
    if (prefs.folders && prefs.view === 'files') { renderFiles(); return; }
  }
  renderFiles('state');
}

/** Paths with local work at the last full draw, so folder marks redraw when the set changes. */
let shownLocalPaths = '';

/** Switch tabs, keeping the tab bar where it is when the page is scrolled past the header. */
export function setView(next: View): void {
  prefs.view = next;
  closeToolbarMenu();
  if (next === 'guide' && (received.diffRange.kind !== 'all' || prefs.whitespace)) requestFiles({ kind: 'all' }, false);
  save();
  renderFiles();
  renderNavThreads();
  const bar = $('files-bar');
  const panelTop = (next === 'overview' ? $('panel-overview') : $('panel-files')).getBoundingClientRect().top + window.scrollY - bar.offsetHeight;
  if (window.scrollY > panelTop) window.scrollTo(0, panelTop);
}

/** Open the Overview tab at the review box with its summary focused. */
export function finishReview(): void {
  if (prefs.view !== 'overview') setView('overview');
  const box = $('review-box');
  box.scrollIntoView({ block: 'nearest' });
  $<HTMLTextAreaElement>('review').focus({ preventScroll: true });
}

/** The Guide tab's count of steps once a guide exists; its icon moves while Claude builds it. Build guide shows only in the guide. */
export function showGuideTab(): void {
  const analysis = received.current?.analysis;
  const count = $('guide-count');
  const steps = analysis?.result?.groups.reduce((sum, group) => sum + group.steps.length, 0);
  $('view-guide').classList.toggle('busy', analysis?.running === true);
  $('guide-stale').hidden = analysis?.running === true || analysis?.result === undefined || !analysis.stale;
  count.textContent = analysis?.running || steps === undefined ? '' : String(steps);
  count.hidden = analysis?.running === true || steps === undefined;
  $('files-count').textContent = received.files ? String(received.files.filter((file) => file.change !== 'unchanged').length) : '';
  for (const id of ['analyze', 'analysis-status', 'analyze-divider']) $(id).classList.toggle('off-view', prefs.view !== 'guide');
  for (const id of ['range', 'nav-tools']) $(id).classList.toggle('off-view', prefs.view !== 'files');
  showListToggle();
}

/** Show the guided layout with a step's group and the step open, scrolled to it. */
export function revealStep(key: string): void {
  prefs.view = 'guide';
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
  prefs.view = 'guide';
  collapsed.set(guideState('group', key), false);
  save();
  renderFiles();
  document.querySelector('[data-group="' + CSS.escape(key) + '"]')?.closest('.tree-node')?.scrollIntoView({ block: 'start' });
}
