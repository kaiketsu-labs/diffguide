/** The Files tab's commit range: commit rows and the range menu. */
import { icons } from '../icons.js';
import type { DiffRange } from '../pullRequestOverview.js';
import type { TimelineItem } from '../pullRequests.js';
import { checkMark, commitStats, commitTitle } from './conversation/timeline.js';
import { $, button, el, icon, timeLabel } from './dom.js';
import { copyRef } from './header/pullRequest.js';
import { closeToolbarMenu, openToolbarMenu } from './menus.js';
import { setView } from './render.js';
import { prefs, received } from './state.js';
import { post } from './transport.js';

/** The commit a Shift-click range starts from in the Commits tab. */
let rangeAnchor: string | undefined;

export function commitsOf(state = received.current): Extract<TimelineItem, { kind: 'commit' }>[] {
  return (state?.conversation?.timeline ?? []).filter((item): item is Extract<TimelineItem, { kind: 'commit' }> => item.kind === 'commit');
}

/** The PR's commits on GitHub, then the worktree's commits GitHub does not have yet, for the range menu and the Files tab. */
function rangeCommits(): Extract<TimelineItem, { kind: 'commit' }>[] {
  const local = (received.current?.unpushed ?? []).map(({ oid, subject, author, createdAt, files, additions, deletions }) =>
    ({ kind: 'commit' as const, id: oid, oid, headline: subject, message: '', author, avatarUrl: '', createdAt, files, additions, deletions }));
  return [...commitsOf(), ...local];
}

/** Commits after the one you last reviewed, oldest first; empty when that commit is no longer in the PR. */
function sinceCommits(): Extract<TimelineItem, { kind: 'commit' }>[] {
  const commits = rangeCommits();
  const at = commits.findIndex((commit) => commit.oid === received.current?.conversation?.lastReviewedCommit);
  return at < 0 ? [] : commits.slice(at + 1);
}

export function isUnpushed(oid: string): boolean {
  return received.current?.unpushed?.some((commit) => commit.oid === oid) === true;
}

/** Show every commit GitHub does not have yet in the Files tab. */
export function showUnpushed(): void {
  const first = received.current?.unpushed?.[0];
  const last = received.current?.unpushed?.at(-1);
  if (first && last) showCommits(first.oid, last.oid);
}

/** Show the changes of commits `from` to `to` in the Files tab. */
export function showCommits(from: string, to: string): void {
  if (from === to) rangeAnchor = from;
  requestFiles({ kind: 'commits', from, to }, prefs.whitespace);
  setView('files');
  $('files-bar').scrollIntoView({ block: 'start' });
}

export function requestFiles(next: DiffRange, hideWhitespace: boolean): void {
  prefs.wantedRange = undefined;
  $('error').textContent = '';
  if ((next.kind !== 'all' || hideWhitespace) && prefs.view === 'guide') setView('files');
  post({ action: 'files', range: next, whitespace: hideWhitespace });
}

export function sameRange(a: DiffRange, b: DiffRange): boolean {
  return a.kind === b.kind && (a.kind !== 'commits' || (b.kind === 'commits' && a.from === b.from && a.to === b.to));
}

/** What the Files tab shows, for the range button. */
export function rangeLabel(shown: DiffRange): string {
  if (shown.kind === 'all') return 'All changes';
  if (shown.kind === 'since') return 'Since your last review';
  if (shown.from !== shown.to) return rangeCount(shown) + ' commits';
  return shown.from.slice(0, 7) + ' ' + (commitHeadline(shown.from) ?? '');
}

/** A commit's title from the PR's commits, or from Claude's local commits before they are pushed. */
function commitHeadline(oid: string): string | undefined {
  return rangeCommits().find((commit) => commit.oid === oid)?.headline
    ?? received.current?.threads.flatMap((thread) => thread.commits ?? []).find((commit) => commit.oid === oid)?.subject;
}

function rangeCount(shown: Extract<DiffRange, { kind: 'commits' }>): number {
  const commits = rangeCommits();
  return commits.findIndex((commit) => commit.oid === shown.to) - commits.findIndex((commit) => commit.oid === shown.from) + 1;
}

/** What the Files tab shows, for the note above the files: hashes as code, the headline in bold. */
/** The note's first line: the commit's copyable hash and full title, or what the range covers. */
function rangeTitle(shown: DiffRange): (Node | string)[] {
  if (shown.kind === 'all') return ['All changes'];
  if (shown.kind === 'since') {
    const since = sinceCommits();
    const first = since[0];
    if (!first) return ['Changes since your last review'];
    if (since.length > 1) return ['Changes since your last review · ' + since.length + ' commits'];
    return ['Changes since your last review · 1 commit', commitRef(first.oid), el('span', 'headline', first.headline)];
  }
  if (shown.from !== shown.to) return [rangeCount(shown) + ' commits,', commitRef(shown.from), 'to', commitRef(shown.to)];
  const commit = rangeCommits().find((each) => each.oid === shown.from);
  const headline = commitHeadline(shown.from);
  return [commitRef(shown.from), ...headline === undefined ? [] : [el('span', 'headline', headline)], ...commit ? checkMark(commit) : []];
}

function commitRef(oid: string): HTMLButtonElement {
  return copyRef(oid.slice(0, 7), oid, 'commit SHA');
}

/** The note's second line: who made the shown commits and when, and what they change as shown. */
function rangeFacts(shown: DiffRange): (Node | string)[] {
  const commits = rangeCommits();
  const index = (oid: string): number => commits.findIndex((commit) => commit.oid === oid);
  const picked = shown.kind === 'commits' ? commits.slice(index(shown.from), index(shown.to) + 1) : shown.kind === 'since' ? sinceCommits() : [];
  const facts: (Node | string)[] = [];
  const authors = [...new Set(picked.map((commit) => commit.author))];
  if (authors.length) facts.push(el('b', '', authors.join(', ')), picked.length === 1 ? ' committed ' : ' committed these ');
  const last = picked.at(-1);
  if (last) facts.push(...timeLabel(last.createdAt), ' · ');
  if (received.files) {
    const added = received.files.reduce((sum, file) => sum + file.additions, 0);
    const removed = received.files.reduce((sum, file) => sum + file.deletions, 0);
    facts.push(el('span', 'stat-add', '+' + added), ' ', el('span', 'stat-del', '−' + removed), ' in ' + received.files.length + (received.files.length === 1 ? ' file' : ' files'));
  }
  if (facts.at(-1) === ' · ') facts.pop();
  return facts;
}

function hashChip(oid: string): HTMLElement {
  return el('span', 'ref', oid.slice(0, 7));
}

/** The range button, whitespace toggle and the note above the files while they show part of the PR. */
export function renderRangeControls(): void {
  const label = rangeLabel(received.diffRange);
  const range = $('range');
  range.title = label;
  range.querySelector('.range-text')?.replaceChildren(...received.diffRange.kind === 'commits' && received.diffRange.from === received.diffRange.to ? [hashChip(received.diffRange.from)] : [label]);
  range.classList.toggle('on', received.diffRange.kind !== 'all');
  const note = $('range-note');
  note.hidden = received.diffRange.kind === 'all';
  if (!note.hidden) {
    const why = received.atHead ? 'Read marks and comments on the base need all changes.' : 'Comments and read marks need all changes.';
    const title = el('div', 'range-title');
    title.append(...rangeTitle(received.diffRange));
    const facts = el('div', 'muted range-facts');
    facts.append(...rangeFacts(received.diffRange));
    const text = el('div', 'gap');
    text.append(title, facts);
    const since = received.diffRange.kind === 'since' ? sinceCommits() : [];
    if (since.length > 1) {
      const list = el('ul', 'range-commits');
      for (const commit of since) {
        const row = el('li');
        row.append(commitRef(commit.oid), el('span', 'headline', commit.headline), el('span', 'muted', commit.author));
        list.append(row);
      }
      text.append(list);
    }
    const all = button('Show all changes', () => requestFiles({ kind: 'all' }, prefs.whitespace), 'small');
    all.title = why;
    note.replaceChildren(icon(icons.commit), text, all);
  }
}

/** The range menu: all changes, since your last review, or commits; click a commit for its changes, Shift-click another for the commits between. */
export function openRangeMenu(): void {
  const commits = rangeCommits();
  const index = (oid: string): number => commits.findIndex((commit) => commit.oid === oid);
  const [low, high] = received.diffRange.kind === 'commits' ? [index(received.diffRange.from), index(received.diffRange.to)] : [-1, -1];
  const pick = (next: DiffRange): void => { closeToolbarMenu(); requestFiles(next, prefs.whitespace); };
  const rows = [rangeRow([el('span', 'text', 'All changes'), el('span', 'muted', commits.length === 1 ? '1 commit' : commits.length + ' commits')], received.diffRange.kind === 'all', () => pick({ kind: 'all' }))];
  if (received.current?.conversation?.lastReviewedCommit) {
    const since = sinceCommits().length;
    rows.push(rangeRow([el('span', 'text', 'Since your last review'), ...since ? [el('span', 'muted', since === 1 ? '1 commit' : since + ' commits')] : []], received.diffRange.kind === 'since', () => pick({ kind: 'since' })));
  }
  const unpushed = received.current?.unpushed ?? [];
  const [firstLocal, lastLocal] = [unpushed[0], unpushed.at(-1)];
  if (firstLocal && lastLocal) {
    const range: DiffRange = { kind: 'commits', from: firstLocal.oid, to: lastLocal.oid };
    rows.push(rangeRow([el('span', 'text', 'Not pushed'), el('span', 'muted', unpushed.length === 1 ? '1 commit' : unpushed.length + ' commits')], sameRange(received.diffRange, range), () => pick(range)));
  }
  // Newest first; `at` stays the oldest-first index the Shift-click range uses.
  commits.map((commit, at) => [commit, at] as const).reverse().forEach(([commit, at]) => {
    const local = isUnpushed(commit.oid);
    const row = rangeRow([hashChip(commit.oid), el('span', 'text', commit.headline), ...cell(local ? [el('span', 'chip', 'Not pushed')] : checkMark(commit)), ...commitStats(commit), el('span', 'muted', commit.author), ...cell(timeLabel(commit.createdAt))],
      low >= 0 && at >= low && at <= high, (shift) => {
        const anchor = shift && rangeAnchor !== undefined ? index(rangeAnchor) : -1;
        if (anchor < 0) { rangeAnchor = commit.oid; pick({ kind: 'commits', from: commit.oid, to: commit.oid }); return; }
        const [from, to] = anchor <= at ? [commits[anchor], commit] : [commit, commits[anchor]];
        if (from && to) pick({ kind: 'commits', from: from.oid, to: to.oid });
      });
    row.title = commitTitle(commit);
    row.classList.add('commit');
    if (local) row.classList.add('unpushed');
    rows.push(row);
  });
  const hint = el('div', 'muted menu-hint', commits.length > 1 ? 'Shift-click a second commit to see the commits between.' : received.current?.conversation ? '' : 'Loading commits…');
  openToolbarMenu('range', hint.textContent ? [...rows, hint] : rows, 'range-menu');
}

/** One grid cell: the node, or an empty one so the columns stay in place. */
function cell(nodes: HTMLElement[]): HTMLElement[] {
  return nodes.length ? nodes : [el('span')];
}

function rangeRow(content: Node[], checked: boolean, choose: (shift: boolean) => void): HTMLElement {
  const row = el('button', 'picker-row range-row');
  row.setAttribute('role', 'menuitemcheckbox');
  row.setAttribute('aria-checked', String(checked));
  const mark = icon(icons.check);
  mark.classList.add('check');
  row.append(mark, ...content);
  row.addEventListener('click', (event) => { choose(event.shiftKey); });
  return row;
}
