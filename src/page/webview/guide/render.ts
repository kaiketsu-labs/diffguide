/** Draws the Guide tab and its navigation. */
import { buildGuide, groupReadMarks, type GuideGroup, type GuideStep, noteSegments, type StepSpan, stepSpans } from '../../../core/prAnalysis.js';
import { fullyRead, rangeReadIds } from '../../../core/readLines.js';
import type { FileDiff } from '../../../core/unifiedDiff.js';
import type { DiffSide } from '../../protocol.js';
import { icons } from '../../icons.js';
import { toolButton } from '../conversation/comment.js';
import { $, button, chevronMark, el, icon } from '../dom.js';
import { markViewed, selectedReadIds, unmarkRead } from '../files/marks.js';
import { changeLetters, iconNode, localMark } from '../files/nav.js';
import { mediaNode, previewKind, previewNode, previewOnly } from '../files/preview.js';
import { headTools, previewSwitch, renderFiles, wholeFileBlock } from '../files/render.js';
import { table } from '../files/table.js';
import { collapsed, prefs, previewing, received, save, ui } from '../state.js';
import { chapterThread } from '../threads/threadBox.js';
import { post } from '../transport.js';
import { openFileComposer } from '../threads/composer.js';
import type { Composer, Thread } from '../types.js';
import { guideOwners, guideState, guideSummary, spanDiff, stepCollapsed, stepViewed } from './model.js';

const stepKeys = new Map<string, string>();

/** A slim band above a group's chapters: its theme, how far it is viewed, and one Viewed for all of them. */
function groupHead(group: GuideGroup): HTMLElement {
  const head = el('div', 'guide-group');
  head.dataset.group = group.key;
  const label = el('label', 'viewed');
  label.title = 'Mark every chapter in this section read.';
  const check = el('input');
  check.type = 'checkbox';
  check.checked = group.steps.every(stepViewed);
  check.addEventListener('change', () => { setGroupViewed(group, check.checked); });
  label.append(check, 'Viewed');
  head.append(el('span', 'title', group.title), el('span', 'muted progress'), label);
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
    const done = group.steps.filter(stepViewed).length;
    const head = document.querySelector('[data-group="' + CSS.escape(group.key) + '"]');
    const progress = head?.querySelector('.progress');
    if (progress) progress.textContent = done + '/' + group.steps.length + ' viewed';
    const check = head?.querySelector<HTMLInputElement>('label.viewed input');
    if (check) check.checked = group.steps.every(stepViewed);
    const section = document.querySelector('.chapter-side[data-group="' + CSS.escape(group.key) + '"] .chapter-progress');
    if (section) section.textContent = done + ' of ' + group.steps.length + ' viewed';
  }
}

/** The guided layout: Claude's steps by severity, each a chapter with its note beside the diff and a Viewed checkbox. */
export function renderGuide(only?: readonly (string | undefined)[] | 'state'): void {
  const container = $('files');
  const result = received.current?.analysis.result;
  if (!received.files || !result) return;
  const shownFiles = received.files;
  received.guide ??= buildGuide(result, shownFiles);
  const groups = received.guide;
  const steps = groups.flatMap((group) => group.steps);
  const spans = stepSpans(groups, shownFiles);
  const parts = new Map(steps.flatMap((step) => {
    const file = shownFiles.find((item) => item.path === step.path);
    return file ? [[step.key, spanDiff(file, spans.get(step.key) ?? [])] as const] : [];
  }));
  const owners = guideOwners(groups, parts);
  const chapters = groups.filter((group) => group.severity !== 'unclassified').flatMap((group) => group.steps);
  const trivial = new Set(groups.filter((group) => group.severity === 'trivial').flatMap((group) => group.steps.map((step) => step.key)));
  const keyOf = (step: GuideStep): string => JSON.stringify([stepViewed(step), stepCollapsed(step, trivial.has(step.key)), received.readRanges.filter((marked) => marked.path === step.path), received.current?.local?.[step.path] ?? null,
    owners.threads.get(step.key) ?? [], owners.notes.get(step.key) ?? null, owners.draft === step.key ? [ui.author, received.current?.details?.pendingComments] : null]);
  const draw = (step: GuideStep): HTMLElement => {
    stepKeys.set(step.key, keyOf(step));
    const number = chapters.indexOf(step) + 1;
    return stepBox(step, number > 0 ? { number, total: chapters.length } : undefined, parts.get(step.key), spans.get(step.key) ?? [], owners.threads.get(step.key) ?? [], owners.notes.get(step.key), owners.draft === step.key, trivial.has(step.key));
  };
  const boxes = new Map([...container.querySelectorAll<HTMLElement>('.step-wrap')].map((node) => [node.dataset.key, node]));
  const targets = only === 'state' ? steps.filter((step) => stepKeys.get(step.key) !== keyOf(step))
    : only ? steps.filter((step) => only.includes(step.path)) : undefined;
  if (targets && boxes.size === steps.length && targets.every((step) => boxes.has(step.key))) {
    for (const step of targets) boxes.get(step.key)?.replaceWith(draw(step));
  } else {
    stepKeys.clear();
    container.replaceChildren(guideSummary(result, groups));
    for (const group of groups) {
      if (group.severity === 'unclassified') { container.append(unplacedSection(group, draw)); continue; }
      container.append(groupHead(group));
      for (const step of group.steps) container.append(draw(step));
    }
  }
  updateGuideProgress(groups);
  $('file-nav').replaceChildren();
}

/** Files the guide does not place: one section with a note, then their diffs one under another. */
function unplacedSection(group: GuideGroup, draw: (step: GuideStep) => HTMLElement): HTMLElement {
  const section = el('section', 'chapter unplaced');
  const side = el('div', 'chapter-side');
  side.dataset.group = group.key;
  const meta = el('div', 'chapter-meta');
  meta.append(el('span', 'chapter-progress'));
  side.append(meta, el('h2', 'chapter-title', 'Not in a chapter'), el('p', 'chapter-prose', 'Changes the guide does not cover, such as files added since it was built.'));
  const code = el('div', 'chapter-code');
  code.append(...group.steps.map(draw));
  section.append(side, code);
  return section;
}

/** Changed blocks of a chapter that are read, and all of them; a file with no line changes counts as one. */
function chapterBlocks(step: GuideStep): { done: number; all: number } {
  const file = received.files?.find((item) => item.path === step.path);
  if (step.blocks.length === 0 || file === undefined) return { done: stepViewed(step) ? 1 : 0, all: 1 };
  if (stepViewed(step)) return { done: step.blocks.length, all: step.blocks.length };
  return { done: step.blocks.filter((block) => rangeReadIds(file, received.readRanges, block.range) !== undefined).length, all: step.blocks.length };
}

/** `L86-88`, or `L86` for one line. */
function lineLabel(from: number, to: number): string {
  return 'L' + from + (to > from ? '-' + to : '');
}

/** Text with `identifier` spans as code. */
function inlineText(text: string): (string | HTMLElement)[] {
  return text.split(/(`[^`]+`)/u).filter(Boolean).map((part) => part.length > 2 && part.startsWith('`') && part.endsWith('`') ? el('code', '', part.slice(1, -1)) : part);
}

/** A chapter's note, with the phrases that cite lines of the diff beside it linked to them. */
function prose(step: GuideStep, part: FileDiff | undefined): HTMLElement {
  const node = el('p', 'chapter-prose');
  for (const segment of noteSegments(step.note ?? '', step.refs, part)) {
    if (segment.ref === undefined) { node.append(...inlineText(segment.text)); continue; }
    const phrase = el('span', 'ref');
    phrase.dataset.from = String(segment.ref.from);
    phrase.dataset.to = String(segment.ref.to);
    phrase.append(...inlineText(segment.text), el('sup', '', lineLabel(segment.ref.from, segment.ref.to)));
    node.append(phrase);
  }
  return node;
}

/** The chapter's left column: where it sits, its title, its note and Claude's conversation about it. */
function chapterSide(step: GuideStep, where: { number: number; total: number }, part: FileDiff | undefined, note: Thread | undefined): HTMLElement {
  const side = el('div', 'chapter-side');
  const { done, all } = chapterBlocks(step);
  const meta = el('div', 'chapter-meta');
  meta.append(el('span', '', String(where.number).padStart(2, '0') + ' / ' + String(where.total).padStart(2, '0')), el('span', '', '·'), el('span', 'chapter-progress', done + ' of ' + all + ' viewed'));
  side.append(meta, el('h2', 'chapter-title', step.title ?? step.path.split('/').at(-1) ?? step.path));
  if (step.transition) side.append(el('p', 'chapter-transition', step.transition));
  if (step.note) side.append(prose(step, part));
  if (note) {
    const talk = el('div', 'chapter-talk');
    talk.append(chapterThread(note));
    side.append(talk);
  }
  return side;
}

/** A step's file box; with `where` it is a chapter, the note and conversation in a column beside it, otherwise just the box. */
function stepBox(step: GuideStep, where: { number: number; total: number } | undefined, part: FileDiff | undefined, spans: readonly StepSpan[], threads: readonly Thread[], note: Thread | undefined, hasDraft: boolean, trivial: boolean): HTMLElement {
  const wrap = el('div', 'step-wrap' + (where ? ' chapter' : ''));
  wrap.dataset.key = step.key;
  const file = received.files?.find((item) => item.path === step.path);
  if (!file) return wrap;
  const column = where ? el('div', 'chapter-code') : wrap;
  if (where) wrap.append(chapterSide(step, where, part, note), column);
  const isCollapsed = stepCollapsed(step, trivial);
  const box = el('div', 'file step' + (isCollapsed ? ' collapsed' : ''));
  box.dataset.path = step.path;
  const head = el('div', 'file-head');
  const chevron = chevronMark(isCollapsed);
  const name = el('span', 'name');
  name.append(file.oldPath ? file.oldPath + ' → ' + file.path : file.path);
  name.title = file.path;
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
  const themeIcon = received.fileIcons?.byPath[file.path];
  const commentFile = toolButton(icons.comment, 'Comment on the whole file', () => openFileComposer(file.path));
  commentFile.hidden = !received.atHead || file.change === 'deleted';
  head.append(chevron, ...themeIcon ? [iconNode(themeIcon)] : [], name, badge, ...localMark(step.path), stats, previewSwitch(file, showPreview),
    headTools(commentFile, toolButton(icons.openExternal, 'Open in editor', () => post({ action: 'editor', path: step.path }))), label);
  box.append(head);
  const diff = el('div', 'diff');
  if (step.fileNote && !(step.note ?? '').includes(step.fileNote)) diff.append(el('div', 'file-note', step.fileNote));
  const placed = new Set<string>();
  const whole = wholeFileBlock(file.path, threads, placed, false);
  if (whole) diff.append(whole);
  if (showPreview && kind === 'media') diff.append(mediaNode(file));
  else if (file.binary) diff.append(el('div', 'note muted', 'Binary file not shown.'));
  else if (showPreview) diff.append(previewNode(file, threads, placed));
  else if (!spans.length) diff.append(el('div', 'note muted', file.change === 'renamed' ? 'Renamed without changes.' : 'No content changes.'));
  else if (!isCollapsed) diff.append(...stepTables(step, file, spans, threads, placed, hasDraft ? prefs.composer : null));
  box.append(diff);
  column.append(box);
  return wrap;
}

/** Folded runs of lines opened by hand or by find-in-page, by step and first line; they stay open across redraws. */
const unfolded = new Set<string>();

/** A step's lines: runs near its changes as tables, the rest folded but in the page, unless a thread or the draft sits on them. */
function stepTables(step: GuideStep, file: FileDiff, spans: readonly StepSpan[], threads: readonly Thread[], placed: Set<string>, draft: Composer | null | undefined): HTMLElement[] {
  const nodes: HTMLElement[] = [];
  let run: StepSpan[] = [];
  const lines = (spanList: readonly StepSpan[], key: string): HTMLElement => table(spanDiff(file, spanList), threads, placed, draft, 'step:' + key, false);
  const flush = (): void => {
    if (run.length) nodes.push(lines(run, step.key + ':' + nodes.length));
    run = [];
  };
  for (const span of spans) {
    const key = step.key + ':' + span.hunk + ':' + span.from;
    if (!span.folded || unfolded.has(key) || holdsComment(file, span, threads, draft)) { run.push(span); continue; }
    flush();
    nodes.push(foldedLines(key, lines([span], key), span.to - span.from + 1));
  }
  flush();
  return nodes;
}

function holdsComment(file: FileDiff, span: StepSpan, threads: readonly Thread[], draft: Composer | null | undefined): boolean {
  const lines = file.hunks[span.hunk]?.lines.slice(span.from, span.to + 1) ?? [];
  const at = (side: DiffSide, line: number): boolean => lines.some((item) => (side === 'new' ? item.newLine : item.oldLine) === line);
  return threads.some((thread) => !thread.outdated && thread.scope !== 'file' && at(thread.side, thread.endLine)) || (draft !== null && draft !== undefined && draft.path === file.path && at(draft.side, draft.end));
}

/** Unchanged lines far from the step's changes: folded with hidden=until-found, so find-in-page still finds and opens them. */
function foldedLines(key: string, lines: HTMLElement, count: number): HTMLElement {
  const wrap = el('div', 'folded-lines');
  const body = el('div', 'folded-body');
  body.setAttribute('hidden', 'until-found');
  body.append(lines);
  const show = button(count + (count === 1 ? ' unchanged line' : ' unchanged lines'), () => { unfolded.add(key); body.removeAttribute('hidden'); show.remove(); }, 'fold-lines');
  show.prepend(icon(icons.unfold));
  body.addEventListener('beforematch', () => { unfolded.add(key); show.remove(); });
  wrap.append(show, body);
  return wrap;
}
