/** Draws the Guide tab and its navigation. */
import { buildGuide, groupReadMarks, type GuideGroup, type GuideStep, type Severity } from '../../../core/prAnalysis.js';
import { fullyRead } from '../../../core/readLines.js';
import type { FileDiff } from '../../../core/unifiedDiff.js';
import { icons } from '../../icons.js';
import { toolButton } from '../conversation/comment.js';
import { $, chevronMark, el, icon } from '../dom.js';
import { markViewed, selectedReadIds, unmarkRead } from '../files/marks.js';
import { changeLetters, localMark, markCurrentNavFile } from '../files/nav.js';
import { mediaNode, previewKind, previewNode, previewOnly } from '../files/preview.js';
import { headTools, previewSwitch, renderFiles, wholeFileBlock } from '../files/render.js';
import { table } from '../files/table.js';
import { revealGroup, revealStep } from '../render.js';
import { collapsed, prefs, previewing, received, save, ui } from '../state.js';
import { threadBox } from '../threads/threadBox.js';
import { post } from '../transport.js';
import type { Thread } from '../types.js';
import { groupCollapsed, guideIntro, guideOwners, guideState, guideSummary, sliceOf, stepCollapsed, stepViewed } from './model.js';

const severityLabels: Record<Severity | 'unclassified', string> = { critical: 'Critical', significant: 'Significant', routine: 'Routine', trivial: 'Trivial', unclassified: 'Unclassified' };
const stepKeys = new Map<string, string>();

function groupHead(group: GuideGroup): HTMLElement {
  const head = el('div', 'guide-group sev-' + group.severity);
  head.dataset.group = group.key;
  const label = el('label', 'viewed');
  label.title = 'Mark every step in this section read.';
  label.addEventListener('click', (event) => { event.stopPropagation(); });
  const check = el('input');
  check.type = 'checkbox';
  check.checked = group.steps.every(stepViewed);
  check.addEventListener('change', () => { setGroupViewed(group, check.checked); });
  label.append(check, 'Viewed');
  head.append(el('span', 'sev', severityLabels[group.severity]), el('span', 'title', group.title), el('span', 'muted progress'), label);
  return head;
}

/** Tick or untick every step of a guide section, showing it right away; the extension's next state confirms it. */
function setGroupViewed(group: GuideGroup, on: boolean): void {
  if (!received.files) return;
  const paths = [...new Set(group.steps.map((step) => step.path))];
  if (on) {
    const marks = groupReadMarks(group, received.files, received.readRanges, received.viewed);
    received.readRanges = [...received.readRanges, ...marks.read.map((marked) => ({ id: 'pending', ...marked }))];
    marks.read.forEach((marked) => post({ action: 'read', ...marked, viewed: false }));
    for (const path of marks.viewed) { markViewed(path, true); post({ action: 'viewed', path, viewed: true }); }
  } else {
    const ids = group.steps.flatMap((step) => {
      const file = received.files?.find((item) => item.path === step.path);
      return file ? step.blocks.flatMap((block) => selectedReadIds(file, block.range) ?? []) : [];
    });
    if (ids.length) unmarkRead([...new Set(ids)]);
    for (const path of paths) if (received.viewed.has(path)) { markViewed(path, false); post({ action: 'viewed', path, viewed: false }); }
  }
  for (const step of group.steps) collapsed.delete(guideState('step', step.key));
  save();
  renderFiles();
}

/** A foldable level of the file list: its head, then its children beside a rail that folds them when clicked, like a threaded discussion. */
export function railNode(head: HTMLElement, depth: number, isCollapsed: boolean, toggle: () => void): { node: HTMLElement; rail: HTMLElement } {
  const node = el('section', 'tree-node');
  node.style.setProperty('--depth', String(depth));
  head.classList.add('node-head');
  head.prepend(foldToggle(isCollapsed));
  head.addEventListener('click', toggle);
  const rail = el('div', 'fold-rail');
  rail.style.setProperty('--depth', String(depth + 1));
  const line = el('div', 'fold-line');
  line.title = 'Fold';
  line.addEventListener('click', toggle);
  rail.append(line);
  node.append(head);
  if (!isCollapsed) node.append(rail);
  return { node, rail };
}

/** A child hanging off a rail, joined to it by a curved elbow. */
export function railItem(child: HTMLElement): HTMLElement {
  const item = el('div', 'rail-item');
  item.append(child);
  return item;
}

function foldToggle(isCollapsed: boolean): HTMLElement {
  const button = el('span', 'fold-toggle');
  button.title = isCollapsed ? 'Unfold' : 'Fold';
  button.innerHTML = isCollapsed ? icons.unfold : icons.fold;
  return button;
}

function updateGuideProgress(groups: readonly GuideGroup[]): void {
  for (const group of groups) {
    const head = document.querySelector('[data-group="' + CSS.escape(group.key) + '"]');
    const progress = head?.querySelector('.progress');
    if (progress) progress.textContent = group.steps.filter(stepViewed).length + '/' + group.steps.length + ' viewed';
    const check = head?.querySelector<HTMLInputElement>('label.viewed input');
    if (check) check.checked = group.steps.every(stepViewed);
  }
}

/** The guided layout: Claude's steps by severity, each a slice of the diff with its note and a Viewed checkbox. */
export function renderGuide(only?: readonly (string | undefined)[] | 'state'): void {
  const container = $('files');
  const result = received.current?.analysis.result;
  if (!received.files || !result) {
    $('files').parentElement?.classList.add('no-nav');
    container.replaceChildren(guideIntro());
    return;
  }
  const shownFiles = received.files;
  received.guide ??= buildGuide(result, shownFiles);
  const groups = received.guide;
  const slices = new Map(groups.flatMap((group) => group.steps).flatMap((step) => {
    const slice = sliceOf(step);
    return slice ? [[step.key, slice] as const] : [];
  }));
  const owners = guideOwners(groups, slices);
  const visible = groups.filter((group) => !groupCollapsed(group)).flatMap((group) => group.steps);
  const keyOf = (step: GuideStep): string => JSON.stringify([stepViewed(step), stepCollapsed(step), received.readRanges.filter((marked) => marked.path === step.path), received.current?.local?.[step.path] ?? null,
    owners.threads.get(step.key) ?? [], owners.notes.get(step.key) ?? null, owners.draft === step.key ? [ui.author, received.current?.details?.pendingComments] : null]);
  const numbers = new Map(groups.flatMap((group) => group.steps.map((step, index) => [step.key, index + 1] as const)));
  const draw = (step: GuideStep): HTMLElement => {
    stepKeys.set(step.key, keyOf(step));
    return stepBox(step, numbers.get(step.key) ?? 0, slices.get(step.key), owners.threads.get(step.key) ?? [], owners.notes.get(step.key), owners.draft === step.key);
  };
  const boxes = new Map([...container.querySelectorAll<HTMLElement>('.step-wrap')].map((node) => [node.dataset.key, node]));
  const targets = only === 'state' ? visible.filter((step) => stepKeys.get(step.key) !== keyOf(step))
    : only ? visible.filter((step) => only.includes(step.path)) : undefined;
  if (targets && boxes.size === visible.length && targets.every((step) => boxes.has(step.key))) {
    for (const step of targets) boxes.get(step.key)?.replaceWith(draw(step));
  } else {
    stepKeys.clear();
    container.replaceChildren(guideSummary(result, groups));
    for (const group of groups) {
      const isCollapsed = groupCollapsed(group);
      const { node, rail } = railNode(groupHead(group), 0, isCollapsed, () => { collapsed.set(guideState('group', group.key), !isCollapsed); save(); renderFiles(); });
      container.append(node);
      if (!isCollapsed) for (const step of group.steps) rail.append(railItem(draw(step)));
    }
  }
  updateGuideProgress(groups);
  renderGuideNav(groups);
}

/** The guide's sections and numbered steps beside the steps, each with its Viewed state; a click scrolls to it. */
function renderGuideNav(groups: readonly GuideGroup[]): void {
  $('files').parentElement?.classList.remove('no-nav');
  const nav = $('file-nav');
  nav.classList.toggle('folded', ui.navFolded);
  const steps = groups.flatMap((group) => group.steps);
  const head = el('button', 'nav-head');
  head.setAttribute('aria-expanded', String(!ui.navFolded));
  head.append(chevronMark(ui.navFolded), steps.length + (steps.length === 1 ? ' step' : ' steps'), el('span', 'muted', steps.filter(stepViewed).length + ' viewed'));
  head.addEventListener('click', () => { ui.navFolded = !ui.navFolded; renderGuideNav(groups); });
  const list = el('ul', 'nav-list');
  for (const group of groups) {
    const isCollapsed = groupCollapsed(group);
    const fold = chevronMark(isCollapsed);
    fold.title = isCollapsed ? 'Unfold section' : 'Fold section';
    fold.addEventListener('click', (event) => { event.stopPropagation(); collapsed.set(guideState('group', group.key), !isCollapsed); save(); renderFiles(); });
    const row = el('button', 'nav-section sev-' + group.severity);
    row.title = severityLabels[group.severity] + ': ' + group.title;
    row.append(fold, el('span', 'nav-sev'), el('span', 'nav-name', group.title), el('span', 'nav-progress', group.steps.filter(stepViewed).length + '/' + group.steps.length));
    row.addEventListener('click', () => revealGroup(group.key));
    const item = el('li');
    item.append(row);
    list.append(item);
    if (isCollapsed) continue;
    group.steps.forEach((step, index) => {
      const done = stepViewed(step);
      const stepRow = el('button', 'nav-file nav-step' + (done ? ' done' : ''));
      stepRow.dataset.navStep = step.key;
      stepRow.title = step.path + (step.note === undefined ? '' : '\n\n' + step.note);
      const mark = el('span', 'nav-done');
      if (done) mark.append(icon(icons.check));
      stepRow.append(el('span', 'nav-number', String(index + 1)), el('span', 'nav-name', step.title ?? step.path.split('/').at(-1) ?? step.path), mark);
      stepRow.addEventListener('click', () => revealStep(step.key));
      const stepItem = el('li');
      stepItem.append(stepRow);
      list.append(stepItem);
    });
  }
  nav.replaceChildren(head, list);
  markCurrentNavFile();
}

function stepBox(step: GuideStep, number: number, slice: FileDiff | undefined, threads: readonly Thread[], note: Thread | undefined, hasDraft: boolean): HTMLElement {
  const wrap = el('div', 'step-wrap');
  wrap.dataset.key = step.key;
  if (step.transition) wrap.append(el('div', 'transition', '↓ ' + step.transition));
  const file = received.files?.find((item) => item.path === step.path);
  if (!file || !slice) return wrap;
  const isCollapsed = stepCollapsed(step);
  const box = el('div', 'file step' + (isCollapsed ? ' collapsed' : ''));
  box.dataset.path = step.path;
  const head = el('div', 'file-head');
  const chevron = chevronMark(isCollapsed);
  const name = el('span', 'name');
  name.append(el('span', 'step-title', number + '.' + (step.title ? ' ' + step.title : '')), el('span', 'step-path', file.oldPath ? file.oldPath + ' → ' + file.path : file.path));
  const toggle = (): void => { collapsed.set(guideState('step', step.key), !isCollapsed); save(); renderFiles([step.path]); };
  chevron.addEventListener('click', toggle);
  name.addEventListener('click', toggle);
  const badge = el('span', 'badge ' + file.change, changeLetters[file.change]);
  badge.title = file.change;
  const lines = step.blocks.flatMap((block) => file.hunks[block.hunk]?.lines.slice(block.first, block.last + 1) ?? []);
  const stats = el('span', 'stats');
  stats.append(el('span', 'stat-add', '+' + lines.filter((line) => line.kind === 'add').length), ' ', el('span', 'stat-del', '−' + lines.filter((line) => line.kind === 'del').length));
  const label = el('label', 'viewed');
  const check = el('input');
  check.type = 'checkbox';
  check.checked = stepViewed(step);
  label.title = 'Mark this step\'s changes read. When every change in the file is read, the file is marked Viewed.';
  check.addEventListener('change', () => {
    collapsed.delete(guideState('step', step.key));
    if (!step.blocks.length) {
      markViewed(step.path, check.checked);
      post({ action: 'viewed', path: step.path, viewed: check.checked });
    } else if (check.checked) {
      const unread = step.blocks.map((block) => block.range).filter((marked) => selectedReadIds(file, marked) === undefined);
      const done = !received.viewed.has(step.path) && fullyRead(file, [...received.readRanges, ...unread]);
      received.readRanges = [...received.readRanges, ...unread.map((marked) => ({ id: 'pending', ...marked }))];
      if (done) markViewed(step.path, true);
      unread.forEach((marked, index) => post({ action: 'read', ...marked, viewed: done && index === unread.length - 1 }));
    } else {
      unmarkRead([...new Set(step.blocks.flatMap((block) => selectedReadIds(file, block.range) ?? []))]);
      if (received.viewed.has(step.path)) { markViewed(step.path, false); post({ action: 'viewed', path: step.path, viewed: false }); }
    }
    save();
    renderFiles([step.path]);
  });
  label.append(check, 'Viewed');
  const kind = previewKind(file);
  const showPreview = kind !== undefined && (previewing.has(file.path) || previewOnly(file));
  head.append(chevron, name, badge, ...localMark(step.path), stats, previewSwitch(file, showPreview), headTools(toolButton(icons.openExternal, 'Open in editor', () => post({ action: 'editor', path: step.path }))), label);
  box.append(head);
  const diff = el('div', 'diff');
  if (step.fileNote) {
    const about = el('div', 'file-note');
    about.append(el('span', 'tag', 'About this file'), ' ', step.fileNote);
    diff.append(about);
  }
  if (note) diff.append(threadBox(note));
  else if (step.note) diff.append(el('div', 'step-note', step.note));
  const placed = new Set<string>();
  const whole = wholeFileBlock(file.path, threads, placed, false);
  if (whole) diff.append(whole);
  if (showPreview && kind === 'media') diff.append(mediaNode(file));
  else if (file.binary) diff.append(el('div', 'note muted', 'Binary file not shown.'));
  else if (showPreview) diff.append(previewNode(file, threads, placed));
  else if (!slice.hunks.length) diff.append(el('div', 'note muted', file.change === 'renamed' ? 'Renamed without changes.' : 'No content changes.'));
  else diff.append(table(slice, threads, placed, hasDraft ? prefs.composer : null, 'step:' + step.key));
  box.append(diff);
  wrap.append(box);
  return wrap;
}
