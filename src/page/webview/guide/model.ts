/** Claude's guide: steps, slices and their read state. */
import { type Analysis, type GuideGroup, type GuideStep, stepViewed as isStepViewed } from '../../../core/prAnalysis.js';
import type { DiffHunk, FileDiff } from '../../../core/unifiedDiff.js';
import { icons } from '../../icons.js';
import type { DiffSide } from '../../protocol.js';
import { $, button, el, icon, setTip } from '../dom.js';
import { range } from '../files/selection.js';
import { hunkRange } from '../files/table.js';
import { collapsed, prefs, received } from '../state.js';
import { stepLog } from '../status.js';
import { allThreads, standalone } from '../threads/model.js';
import { post } from '../transport.js';
import type { Thread } from '../types.js';

/** Where a step's or group's open state is saved; tied to the analysis so a new one starts fresh. */
export function guideState(kind: 'step' | 'group', key: string): string {
  return kind + ':' + (received.current?.analysis.result?.createdAt ?? '') + ':' + key;
}

/** A step's change blocks with up to three unchanged lines around each, without reaching into other changes. */
export function sliceOf(step: GuideStep): FileDiff | undefined {
  const file = received.files?.find((item) => item.path === step.path);
  if (!file) return undefined;
  const spans: { hunk: number; from: number; to: number }[] = [];
  for (const block of step.blocks) {
    const lines = file.hunks[block.hunk]?.lines ?? [];
    let from = block.first;
    let to = block.last;
    while (from > 0 && block.first - from < 3 && lines[from - 1]?.kind === 'context') from -= 1;
    while (to < lines.length - 1 && to - block.last < 3 && lines[to + 1]?.kind === 'context') to += 1;
    const previous = spans.at(-1);
    if (previous && previous.hunk === block.hunk && from <= previous.to + 1) previous.to = Math.max(previous.to, to);
    else spans.push({ hunk: block.hunk, from, to });
  }
  return { ...file, hunks: spans.flatMap(({ hunk, from, to }) => { const source = file.hunks[hunk]; return source ? [subHunk(source, from, to)] : []; }) };
}

/** Lines `from` to `to` of a hunk, with a header that numbers them as git would. */
function subHunk(source: DiffHunk, from: number, to: number): DiffHunk {
  const lines = source.lines.slice(from, to + 1);
  const span = hunkRange(source);
  if (!span) {
    const numbers = lines.map((line) => line.newLine ?? line.oldLine).filter((value): value is number => value !== undefined);
    return { header: range(numbers[0] ?? 0, numbers.at(-1) ?? 0), lines };
  }
  const before = source.lines.slice(0, from);
  const oldBefore = span.oldBefore + before.filter((line) => line.kind !== 'add').length;
  const newBefore = span.newBefore + before.filter((line) => line.kind !== 'del').length;
  const oldCount = lines.filter((line) => line.kind !== 'add').length;
  const newCount = lines.filter((line) => line.kind !== 'del').length;
  return { header: '@@ -' + (oldCount ? oldBefore + 1 : oldBefore) + ',' + oldCount + ' +' + (newCount ? newBefore + 1 : newBefore) + ',' + newCount + ' @@', lines };
}

function hasLine(slice: FileDiff, side: DiffSide, line: number): boolean {
  const key = side === 'old' ? 'oldLine' : 'newLine';
  return slice.hunks.some((hunk) => hunk.lines.some((item) => item[key] === line));
}

export function stepViewed(step: GuideStep): boolean {
  return isStepViewed(step, received.files?.find((item) => item.path === step.path), received.readRanges, received.viewed.has(step.path));
}

export function stepCollapsed(step: GuideStep): boolean {
  return collapsed.get(guideState('step', step.key)) ?? stepViewed(step);
}

export function groupCollapsed(group: GuideGroup): boolean {
  return collapsed.get(guideState('group', group.key)) ?? group.severity === 'trivial';
}

/** Which step shows each thread and the draft: a note's own step, otherwise the first step whose lines include it. */
export function guideOwners(groups: readonly GuideGroup[], slices: ReadonlyMap<string, FileDiff>): { threads: Map<string, Thread[]>; notes: Map<string, Thread>; draft?: string } {
  const threads = new Map<string, Thread[]>();
  const notes = new Map<string, Thread>();
  const all = allThreads().filter((thread) => standalone(thread) && thread.scope !== 'pullRequest');
  const steps = groups.flatMap((group) => group.steps);
  for (const step of steps) {
    const note = step.threadId === undefined ? undefined : all.find((thread) => thread.source === 'local' && thread.id === step.threadId);
    if (note) notes.set(step.key, note);
  }
  const noted = new Set([...notes.values()].map((thread) => thread.id));
  const owner = (path: string, side: DiffSide, line: number): string | undefined => steps.find((step) => {
    const slice = slices.get(step.key);
    return step.path === path && slice !== undefined && hasLine(slice, side, line);
  })?.key;
  for (const thread of all) {
    if (noted.has(thread.id) || thread.outdated) continue;
    const key = thread.scope === 'file' ? steps.find((step) => step.path === thread.path && slices.has(step.key))?.key : owner(thread.path, thread.side, thread.endLine);
    if (key !== undefined) threads.set(key, [...threads.get(key) ?? [], thread]);
  }
  const draft = prefs.composer ? owner(prefs.composer.path, prefs.composer.side, prefs.composer.end) : undefined;
  return draft === undefined ? { threads, notes } : { threads, notes, draft };
}

export function guideIntro(): HTMLElement {
  const analysis = received.current?.analysis;
  const card = el('section', 'card guide-intro');
  card.append(el('h3', '', 'Guide'), el('p', '', 'Claude reads the changes, groups them by severity, puts them in reading order and explains each step. '
    + 'Each note is a thread you can reply to. Every change lands in exactly one step, so once every step is Viewed, the whole PR is.'));
  if (analysis?.running && analysis.progress !== undefined) {
    const controls = el('span', 'step-actions');
    const stop = button('', () => post({ action: 'analysis-stop' }), 'icon-button');
    stop.append(icon(icons.stop));
    setTip(stop, 'Stop building the guide');
    controls.append(stop);
    card.append(stepLog(analysis.progress.steps, analysis.progress.startedAt, controls, () => ['lead']));
    return card;
  }
  const row = el('div', 'row');
  const start = button(analysis?.running ? 'Stop' : 'Build guide', () => post({ action: analysis?.running ? 'analysis-stop' : 'analyze' }), analysis?.running ? '' : 'primary');
  row.append(start);
  if (analysis?.running) row.append(el('span', 'chip agent working', 'Guide · ' + (analysis.step ?? 'Working')));
  else if (analysis?.error) row.append(el('span', 'bad', 'Guide failed: ' + analysis.error));
  else row.append(el('span', 'muted', 'Runs Claude read-only on this PR. Large PRs take a few minutes.'));
  card.append(row);
  return card;
}

export function guideSummary(result: Analysis, groups: readonly GuideGroup[]): HTMLElement {
  const card = el('section', 'card guide-intro');
  card.append(el('h3', '', 'Guide'));
  if (received.current?.analysis.stale) card.append(staleGuideRow(result, groups));
  if (result.overview) card.append(el('p', 'text', result.overview));
  card.append(el('p', 'muted', 'Every change is in exactly one step. Viewed on every step marks the whole PR viewed.'));
  return card;
}

/** Warns that the guide was built for an older head, says what that cost, and offers to rebuild it. */
function staleGuideRow(result: Analysis, groups: readonly GuideGroup[]): HTMLElement {
  const behind = received.current?.analysis.behind;
  const placed = groups.filter((group) => group.severity !== 'unclassified').reduce((sum, group) => sum + group.steps.length, 0);
  const lost = result.groups.reduce((sum, group) => sum + group.steps.length, 0) - placed;
  const unplaced = groups.find((group) => group.severity === 'unclassified')?.steps.length ?? 0;
  const facts = [
    'Built for ' + result.head.slice(0, 7) + (behind === undefined ? ', which is no longer in the branch' : ', ' + behind + (behind === 1 ? ' commit' : ' commits') + ' behind'),
    lost > 0 ? lost + (lost === 1 ? ' step no longer matches' : ' steps no longer match') : undefined,
    unplaced > 0 ? unplaced + (unplaced === 1 ? ' change is' : ' changes are') + ' in Not placed by the guide' : undefined,
  ].filter(Boolean).join('. ') + '.';
  const row = el('div', 'row range-note stale-guide');
  row.append(icon(icons.warning), el('span', 'gap wait', facts));
  const rebuild = button(received.current?.analysis.running ? 'Rebuilding…' : 'Rebuild guide', () => { $('error').textContent = ''; post({ action: 'analyze' }); }, 'agent small');
  rebuild.disabled = received.current?.analysis.running === true;
  row.append(rebuild);
  return row;
}
