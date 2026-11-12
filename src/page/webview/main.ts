/** Entry of the review page script: wires the page controls and starts the page. */
import { reviewers } from '../../core/contracts.js';
import type { ReviewEvent } from '../../core/forge.js';
import { blockBrowserShortcuts } from '../browserShortcuts.js';
import type { ExtensionMessage } from '../protocol.js';
import { attachMentions } from './conversation/mentions.js';
import { renderConversation } from './conversation/timeline.js';
import { $, closestTo, relativeTime } from './dom.js';
import { allFolded, applyFilters, filtersOn, openFilterMenu, openViewMenu, showListToggle } from './files/filters.js';
import { markCurrentNavFile, markEndingFiles, openFolders, showNavThreadsHeight, showNavWidth } from './files/nav.js';
import { frameMessage } from './files/preview.js';
import { frameParking, renderFiles } from './files/render.js';
import { paintDrag, pick } from './files/selection.js';
import { guideState } from './guide/model.js';
import { openConnectMenu, openContextMenu } from './header/connect.js';
import { clickMerge, closeMergeForm, openMethodMenu, openUpdateMenu } from './header/merge.js';
import { editBody, editTitle, renderLinked } from './header/pullRequest.js';
import { askInMenu, closePicker, closeToolbarMenu, openPicker, stopAsking } from './menus.js';
import { onExtensionMessage } from './messages.js';
import { closePeek, columnAt, lookupTarget, peeks, probeAt, renderPeek, showLink, showPeekWidth } from './peek.js';
import { openRangeMenu, showUnpushed } from './range.js';
import { finishReview, onShortcut, render, setView } from './render.js';
import { openReviewMenu } from './review/review.js';
import { collapsed, initial, prefs, received, save, ui } from './state.js';
import { changePullRequest, clearNotice, elapsed, reviewButtons, setBusy } from './status.js';
import { sendThemeColors } from './theme.js';
import { hideThreadHover, threadHover } from './threads/list.js';
import { batch } from './threads/suggestions.js';
import { stopClaude } from './threads/threadBox.js';
import { post } from './transport.js';

document.addEventListener('mouseup', (event) => {
  if (!ui.drag) return;
  const { path, side, from, to } = ui.drag;
  ui.drag = undefined;
  paintDrag();
  if (from === to) pick(path, side, from, event.shiftKey);
  else {
    pick(path, side, Math.min(from, to), false).end = Math.max(from, to);
    save();
    renderFiles([path]);
  }
});

setInterval(() => { for (const node of document.querySelectorAll<HTMLTimeElement>('time.when')) node.textContent = relativeTime(node.dateTime); }, 60_000);
frameParking.hidden = true;
document.body.append(frameParking);
threadHover.popover = 'manual';
document.body.append(threadHover);

// A redraw can remove the hovered item without a mouseleave, so the preview also closes when the pointer moves off it.
document.addEventListener('mouseover', (event) => {
  if (ui.threadHoverAnchor !== undefined && (!ui.threadHoverAnchor.isConnected || !(event.target instanceof Node) || !ui.threadHoverAnchor.contains(event.target))) hideThreadHover();
}, { passive: true });
document.addEventListener('scroll', hideThreadHover, { capture: true, passive: true });

$('show-unpushed').addEventListener('click', showUnpushed);
for (const [id, action] of [['pr', 'pr'], ['push', 'push'], ['terminal', 'terminal'], ['retry', 'retry'], ['refresh', 'refresh']] as const) $(id).addEventListener('click', () => post({ action }));
$('stop-claude').addEventListener('click', stopClaude);
$('connect').addEventListener('click', openConnectMenu);
$('context').addEventListener('click', openContextMenu);
$('remove-worktree').addEventListener('click', () => askInMenu('remove-worktree',
  'Remove the worktree for ' + (received.current?.number === undefined ? 'this PR' : '#' + received.current.number) + '? Its local comments are deleted too. Git refuses if it has uncommitted changes.',
  'Remove worktree', () => post({ action: 'remove-worktree' })));
// Re-rendered working chips join the page clock instead of restarting their animation.
document.addEventListener('animationstart', (event) => {
  if (event.animationName !== 'orb' || !(event.target instanceof Element)) return;
  for (const animation of event.target.getAnimations({ subtree: true })) if (animation instanceof CSSAnimation && animation.animationName === 'orb') animation.startTime = 0;
});
setInterval(() => {
  for (const time of document.querySelectorAll<HTMLElement>('[data-since]')) time.textContent = elapsed(Number(time.dataset.since));
}, 1000);
$('error').addEventListener('click', () => { $('error').textContent = ''; });
document.addEventListener('pointerdown', (event) => { if (!(event.target instanceof Node && $('notice').contains(event.target))) clearNotice(); });
window.addEventListener('keydown', (event) => { if (event.key === 'Escape') clearNotice(); });
blockBrowserShortcuts();
document.addEventListener('mousemove', (event) => {
  ui.pointer = event;
  if (event.metaKey || event.ctrlKey) probeAt(event);
  else if (ui.hovered) { ui.hovered = undefined; showLink(); }
});
document.addEventListener('click', (event) => {
  if (!(event.metaKey || event.ctrlKey)) return;
  const cell = closestTo(event, 'td.code[data-line]');
  if (!cell) return;
  const column = columnAt(cell, event);
  const target = lookupTarget(cell);
  if (column === undefined || !target) return;
  event.preventDefault();
  $('error').textContent = '';
  post({ action: 'definition', ...target, line: Number(cell.dataset.line), column });
});
for (const type of ['keydown', 'keyup'] as const) {
  window.addEventListener(type, (event) => {
    const held = event.metaKey || event.ctrlKey;
    document.body.classList.toggle('peeking', held);
    if (held && ui.pointer) probeAt(ui.pointer);
    else if (!held) { clearTimeout(ui.probeTimer); ui.hovered = undefined; showLink(); }
  });
}
window.addEventListener('blur', () => { ui.hovered = undefined; showLink(); });
window.addEventListener('keydown', (event) => { if (event.key === 'Escape' && peeks.length && !(event.target instanceof HTMLTextAreaElement)) closePeek(); });
$('peek-close').addEventListener('click', closePeek);
showPeekWidth();
$('peek-resize').addEventListener('pointerdown', (event) => {
  if (event.button !== 0) return;
  event.preventDefault();
  const handle = $('peek-resize');
  handle.setPointerCapture(event.pointerId);
  document.body.classList.add('resizing');
  const move = (moved: PointerEvent): void => {
    prefs.peekWidth = Math.round(Math.min(window.innerWidth - 16, Math.max(320, window.innerWidth - moved.clientX - 8)));
    showPeekWidth();
  };
  const stop = (): void => {
    handle.removeEventListener('pointermove', move);
    document.body.classList.remove('resizing');
    save();
  };
  handle.addEventListener('pointermove', move);
  handle.addEventListener('pointerup', stop, { once: true });
  handle.addEventListener('pointercancel', stop, { once: true });
});
$('peek-resize').addEventListener('dblclick', () => { prefs.peekWidth = undefined; showPeekWidth(); save(); });
$('peek-back').addEventListener('click', () => { if (ui.peekAt > 0) { ui.peekAt -= 1; renderPeek(); } });
$('peek-forward').addEventListener('click', () => { if (ui.peekAt < peeks.length - 1) { ui.peekAt += 1; renderPeek(); } });
$('peek-open').addEventListener('click', () => {
  const peek = peeks[ui.peekAt];
  if (peek) post({ action: 'open-definition', peek: peek.id });
});
$('unified').addEventListener('click', () => { prefs.layout = 'unified'; save(); renderFiles(); });
$('split').addEventListener('click', () => { prefs.layout = 'split'; save(); renderFiles(); });
for (const name of ['overview', 'files', 'guide'] as const) $('view-' + name).addEventListener('click', () => { setView(name); });
$('finish-review').addEventListener('click', finishReview);
$('range').addEventListener('click', openRangeMenu);
$<HTMLInputElement>('file-filter').value = prefs.fileFilter;
$('file-filter').addEventListener('input', () => { prefs.fileFilter = $<HTMLInputElement>('file-filter').value; applyFilters(); });
$('file-filter').addEventListener('keydown', (event) => { if (event.key === 'Escape') { $<HTMLInputElement>('file-filter').value = ''; prefs.fileFilter = ''; applyFilters(); $('file-filter').blur(); } });
$('filter-clear').addEventListener('click', () => { $<HTMLInputElement>('file-filter').value = ''; prefs.fileFilter = ''; applyFilters(); $('file-filter').focus(); });
$('filter-clear').hidden = prefs.fileFilter === '';
$('filter-menu').addEventListener('click', openFilterMenu);
$('nav-toggle').addEventListener('click', () => { prefs.listHidden = !prefs.listHidden; save(); showListToggle(); });
showNavWidth();
$('nav-resize').addEventListener('pointerdown', (event) => {
  if (event.button !== 0) return;
  event.preventDefault();
  const handle = $('nav-resize');
  const left = $('nav-col').getBoundingClientRect().left;
  handle.setPointerCapture(event.pointerId);
  handle.classList.add('dragging');
  document.body.classList.add('resizing');
  const move = (moved: PointerEvent): void => {
    prefs.navWidth = Math.round(Math.min(window.innerWidth / 2, Math.max(160, moved.clientX - left)));
    showNavWidth();
  };
  const stop = (): void => {
    handle.removeEventListener('pointermove', move);
    handle.classList.remove('dragging');
    document.body.classList.remove('resizing');
    save();
  };
  handle.addEventListener('pointermove', move);
  handle.addEventListener('pointerup', stop, { once: true });
  handle.addEventListener('pointercancel', stop, { once: true });
});
$('nav-resize').addEventListener('dblclick', () => { prefs.navWidth = undefined; showNavWidth(); save(); });
showNavThreadsHeight();
$('nav-split').addEventListener('pointerdown', (event) => {
  if (event.button !== 0) return;
  event.preventDefault();
  const handle = $('nav-split');
  const column = $('nav-col').getBoundingClientRect();
  handle.setPointerCapture(event.pointerId);
  handle.classList.add('dragging');
  document.body.classList.add('resizing-rows');
  const move = (moved: PointerEvent): void => {
    prefs.navThreadsHeight = Math.round(Math.min(column.height - 80, Math.max(48, column.bottom - moved.clientY)));
    showNavThreadsHeight();
  };
  const stop = (): void => {
    handle.removeEventListener('pointermove', move);
    handle.classList.remove('dragging');
    document.body.classList.remove('resizing-rows');
    save();
  };
  handle.addEventListener('pointermove', move);
  handle.addEventListener('pointerup', stop, { once: true });
  handle.addEventListener('pointercancel', stop, { once: true });
});
$('nav-split').addEventListener('dblclick', () => { prefs.navThreadsHeight = undefined; showNavThreadsHeight(); save(); });
showListToggle();
$('fold-conversation').addEventListener('click', () => { prefs.conversationFolded = !prefs.conversationFolded; save(); if (received.current) renderConversation(received.current, true); });
$('filter-menu').setAttribute('aria-pressed', String(filtersOn()));
document.addEventListener('pointerdown', (event) => {
  if (ui.toolbarMenu && event.target instanceof Node && !ui.toolbarMenu.node.contains(event.target) && !$(ui.toolbarMenu.anchor).contains(event.target)) closeToolbarMenu();
  if (ui.emojiFor !== undefined && event.target instanceof Element && !event.target.closest('.reactions')) {
    ui.emojiFor = undefined;
    renderFiles();
    if (received.current) renderConversation(received.current, true);
  }
});
window.addEventListener('keydown', onShortcut);
$('commit-batch').addEventListener('click', () => { if (batch.size) changePullRequest({ action: 'commit-suggestions', picked: [...batch.values()] }); });
$('discard-review').addEventListener('click', () => askInMenu('discard-review', 'Discard your pending review? Its comments are deleted. Nobody saw them yet.', 'Discard review',
  () => changePullRequest({ action: 'discard-review' })));
$('approve-runs').addEventListener('click', () => {
  const count = received.current?.conversation?.awaitingApproval.length ?? 0;
  askInMenu('approve-runs', 'Run ' + (count === 1 ? 'the workflow' : count + ' workflows') + ' from this fork? It runs code the fork\'s author wrote. Review changes to workflow files first.',
    'Approve and run', () => changePullRequest({ action: 'approve-runs' }));
});
$('update-branch').addEventListener('click', openUpdateMenu);
$('method').addEventListener('click', openMethodMenu);
$('auto-merge').addEventListener('click', () => clickMerge(true));
$('auto-merge-off').addEventListener('click', () => changePullRequest({ action: 'auto-merge-off' }));
$('dequeue').addEventListener('click', () => changePullRequest({ action: 'dequeue' }));
$('merge-cancel').addEventListener('click', closeMergeForm);
attachMentions($<HTMLTextAreaElement>('review'), $('review-box'));
$('view-menu').addEventListener('click', openViewMenu);
$('analyze').addEventListener('click', () => { $('error').textContent = ''; post({ action: received.current?.analysis.running ? 'analysis-stop' : 'analyze' }); });
$('review').addEventListener('click', () => {
  $('error').textContent = '';
  if (received.current?.review?.running) post({ action: 'review-stop' });
  else post({ action: 'review', reviewers: ui.reviewPicks ?? reviewers });
});
$('review-pick').addEventListener('click', openReviewMenu);
$('fold-all').addEventListener('click', () => {
  const value = !allFolded();
  if (prefs.view === 'guide') {
    for (const group of received.guide ?? []) {
      if (!value) collapsed.set(guideState('group', group.key), false);
      for (const step of group.steps) collapsed.set(guideState('step', step.key), value);
    }
  } else {
    for (const file of received.files ?? []) {
      collapsed.set(file.path, value);
      if (!value) openFolders(file.path);
    }
  }
  save();
  renderFiles();
});
for (const review of reviewButtons) {
  review.addEventListener('click', () => {
    $('error').textContent = '';
    setBusy(true);
    post({ action: 'review', event: review.dataset.event as ReviewEvent, body: $<HTMLTextAreaElement>('review').value });
  });
}
$('conflict-send').addEventListener('click', () => {
  const answer = $<HTMLTextAreaElement>('conflict-answer');
  if (!answer.value.trim()) { answer.focus(); return; }
  $('error').textContent = '';
  post({ action: 'fix-conflicts', text: answer.value });
  answer.value = '';
});
$('conflict-cancel').addEventListener('click', () => post({ action: 'dismiss-conflict-question' }));
$('fix-conflicts').addEventListener('click', () => {
  $('error').textContent = '';
  $<HTMLButtonElement>('fix-conflicts').disabled = true;
  post({ action: 'fix-conflicts' });
});
$('edit-title').addEventListener('click', editTitle);
$('link-pr').addEventListener('click', () => { ui.linking = true; if (received.current) renderLinked(received.current); });
$('edit-body').addEventListener('click', editBody);
for (const what of ['reviewers', 'assignees', 'labels', 'milestone'] as const) $('pick-' + what).addEventListener('click', () => openPicker(what));
document.addEventListener('pointerdown', (event) => {
  if (ui.picker && event.target instanceof Node && !ui.picker.node.contains(event.target) && !$('pick-' + ui.picker.what).contains(event.target)) closePicker(true);
});
window.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && ui.picker) closePicker(false);
  if (event.key === 'Escape' && ui.toolbarMenu) closeToolbarMenu();
  if (event.key === 'Escape' && ui.asking) stopAsking();
});
$('merge').addEventListener('click', () => {
  if (received.current?.conversation?.merge.mergeQueue) changePullRequest({ action: 'enqueue' });
  else clickMerge(false);
});
window.addEventListener('message', (event: MessageEvent) => {
  const frame = event.source ? [...document.querySelectorAll<HTMLIFrameElement>('iframe.html-preview')].find((node) => node.contentWindow === event.source) : undefined;
  if (frame) frameMessage(frame, event.data);
  else onExtensionMessage(event.data as ExtensionMessage);
});
render(initial.state);
window.addEventListener('scroll', () => {
  if (ui.navFrame || prefs.view === 'overview') return;
  ui.navFrame = requestAnimationFrame(() => { ui.navFrame = 0; markCurrentNavFile(false); markEndingFiles(); });
}, { passive: true });
new ResizeObserver(([entry]) => {
  if (entry) document.body.style.setProperty('--bar-height', (entry.target as HTMLElement).offsetHeight + 'px');
}).observe($('files-bar'));
post({ action: 'ready' });
sendThemeColors();
// VS Code rewrites the page's theme variables and body class when the theme changes.
const themeWatch = new MutationObserver(sendThemeColors);
themeWatch.observe(document.documentElement, { attributes: true, attributeFilter: ['style'] });
themeWatch.observe(document.body, { attributes: true, attributeFilter: ['class'] });
