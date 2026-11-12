/** Review cards: findings, live progress, lanes and usage. */
import type { AgentStep } from '../../../core/agent.js';
import { type Finding, type Reviewer, reviewers } from '../../../core/contracts.js';
import { type DropReason, reviewerInfo, type ReviewLane, type ReviewLaneItem, type ReviewLive, type ReviewStage, reviewStages, type ReviewUsage } from '../../../core/review.js';
import { icons } from '../../icons.js';
import { $, agentButton, button, el, icon, setTip, stateIcon, timeLabel, titled } from '../dom.js';
import { jump } from '../files/table.js';
import { tokenCount } from '../header/connect.js';
import { menuRow, openToolbarMenu } from '../menus.js';
import { collapsed, received, save, ui } from '../state.js';
import { elapsed, stepLog } from '../status.js';
import { allThreads, localThreads } from '../threads/model.js';
import { strip } from '../threads/threadBox.js';
import { post } from '../transport.js';
import type { Thread, ThreadKind } from '../types.js';

export function threadKind(thread: Thread): ThreadKind {
  return thread.source === 'github' ? 'github' : thread.origin ?? 'local';
}

/** A tag per code review agent that raised a finding. */
export function agentTags(names: readonly Reviewer[]): HTMLElement[] {
  return names.map((name) => {
    const tag = el('span', 'agent-tag');
    tag.append(icon(icons[name]), reviewerInfo[name].label);
    return tag;
  });
}

const findingSeverityLabels: Record<Finding['severity'], string> = { high: 'High', medium: 'Medium', low: 'Low' };
const evidenceLabels: Record<Finding['evidence'], [string, string]> = {
  tested: ['Tested', 'A test the reviewer ran shows it.'],
  rewritten: ['Rewritten', 'A simpler version the reviewer wrote passes the tests.'],
  traced: ['Traced', 'The reviewer traced it through the code.'],
  cited: ['Cited', 'A rule or existing code the reviewer quotes backs it.'],
};

/** A finding's severity and how it was proven. */
export function findingMarks({ severity, evidence }: Pick<Finding, 'severity' | 'evidence'>): HTMLElement[] {
  const [label, tip] = evidenceLabels[evidence];
  return [el('span', 'sev ' + severity, findingSeverityLabels[severity]), titled(el('span', 'ev ' + evidence, label), tip)];
}

/** A finding's place; a narrow card moves it to its own line, where the folders give way first. */
function findingWhere(path: string, line: number): HTMLElement {
  const node = titled(el('span', 'finding-where'), path + ':' + line);
  const cut = path.lastIndexOf('/') + 1;
  const folder = el('span', 'finding-folder');
  folder.append(el('bdi', '', path.slice(0, cut)));
  node.append(folder, el('span', 'finding-file', path.slice(cut) + ':' + line));
  return node;
}

const dropLabels: Record<DropReason, [string, string]> = {
  'over-cap': ['Over cap', 'Proven, ranked below the top 10'],
  refuted: ['Refuted', 'Verification disproved it'],
  unconfirmed: ['Unconfirmed', 'Verification could not prove or disprove it'],
  duplicate: ['Duplicate', 'Merged into another finding'],
  'out-of-scope': ['Out of scope', 'Style, speculation or preference'],
  unplaced: ['Not placed', 'Its lines are not in the diff'],
};

/** The code review's summary above the files: findings by rank, who ran, and every dropped candidate with its reason. */
function renderReviewCard(): void {
  const card = $('review-card');
  const review = received.current?.review;
  const result = review?.result;
  const live = review?.running || review?.error !== undefined ? review?.live : undefined;
  card.hidden = result === undefined && live === undefined;
  if (card.hidden) { card.replaceChildren(); return; }
  const cards = live === undefined || review === undefined ? [] : [reviewLiveCard(live, review.running, review.error)];
  if (result === undefined || review?.running) { card.replaceChildren(...cards); return; }
  const box = el('details', 'thread review review-card');
  box.open = collapsed.get('review-card') !== true;
  box.addEventListener('toggle', () => { collapsed.set('review-card', !box.open); save(); });
  const count = result.findings.length;
  box.append(strip('summary', 'review', 'Claude\'s code review of these changes.', [], `${result.candidates} candidates · ${result.dropped.length} dropped`,
    count === 0 ? 'No findings' : count + (count === 1 ? ' finding' : ' findings')));
  const usage = result.usage === undefined ? undefined : usageChip(result.usage);
  box.querySelector('summary')?.append(...timeLabel(result.createdAt), ...usage ? [usage.chip] : []);
  if (usage) box.append(usage.popover);
  const openFindings = localThreads().filter((thread) => thread.source === 'local' && thread.origin === 'review' && !thread.resolved && thread.archived !== true);
  if (openFindings.length > 0) {
    const recheck = agentButton('ask', 'Re-check findings', () => post({ action: 'review-recheck' }), false);
    recheck.classList.add('small');
    recheck.disabled = openFindings.some((thread) => thread.source === 'local' && thread.working !== undefined);
    recheck.title = 'Agent checks each open finding against the current code and answers in its thread, without editing. You resolve the fixed ones';
    const row = el('div', 'row review-recheck');
    row.append(el('span', 'gap muted', openFindings.length === 1 ? '1 open finding' : openFindings.length + ' open findings'), recheck);
    box.append(row);
  }
  const ran = el('div', 'review-ran muted', result.ran.length === 0 ? 'No reviewer ran.' : 'Ran ' + result.ran.map((name) => reviewerInfo[name].label).join(', '));
  for (const { reviewer, reason } of result.skipped) ran.append(el('span', '', ' · Skipped ' + reviewerInfo[reviewer].label + (reason ? ': ' + reason : '')));
  box.append(ran);
  if (count > 0) {
    const list = el('ol', 'finding-list');
    const threads = allThreads();
    for (const finding of result.findings) {
      const thread = threads.find((candidate) => candidate.id === finding.threadId);
      const title = el('button', 'finding-title', finding.title);
      title.disabled = thread === undefined;
      if (thread === undefined) title.title = 'The thread is resolved or gone.';
      title.addEventListener('click', () => { if (thread !== undefined) jump(thread); });
      const item = el('li', thread?.resolved ? 'resolved' : '');
      if (thread?.resolved) title.prepend(stateIcon('done', 'mark', 'Resolved'));
      item.append(el('span', 'sev ' + finding.severity, findingSeverityLabels[finding.severity]), title, el('span', 'finding-agents'), ...findingMarks(finding).slice(1), findingWhere(finding.path, finding.startLine));
      item.querySelector('.finding-agents')?.append(...agentTags(finding.reviewers));
      list.append(item);
    }
    box.append(list);
  }
  if (result.dropped.length > 0) {
    const dropped = el('details', 'review-dropped');
    dropped.open = collapsed.get('review-dropped') === false;
    dropped.addEventListener('toggle', () => { collapsed.set('review-dropped', !dropped.open); save(); });
    const head = el('summary');
    head.append(icon(icons.chevronDown), 'Dropped (' + result.dropped.length + ')');
    dropped.append(head);
    for (const reason of Object.keys(dropLabels) as DropReason[]) {
      const members = result.dropped.filter((item) => item.reason === reason);
      if (members.length === 0) continue;
      const [label, note] = dropLabels[reason];
      const group = el('div', 'drop-group', label);
      group.append(el('span', 'muted', note));
      dropped.append(group);
      for (const item of members) {
        const row = el('div', 'drop');
        const tags = el('span', 'finding-agents');
        tags.append(...agentTags(item.reviewers));
        row.append(el('span', 'drop-claim', item.claim), tags, ...item.why ? [el('span', 'drop-why muted', item.why)] : []);
        dropped.append(row);
      }
    }
    box.append(dropped);
  }
  card.replaceChildren(...cards, box);
}

const usageDuration = (ms: number): string => {
  const seconds = Math.round(ms / 1000);
  return seconds >= 3600 ? `${Math.floor(seconds / 3600)}h ${Math.floor(seconds % 3600 / 60)}m` : seconds >= 60 ? `${Math.floor(seconds / 60)}m ${seconds % 60}s` : `${seconds}s`;
};
const usageCost = (cost: number): string => cost > 0 && cost < 0.01 ? '<$0.01' : '$' + cost.toFixed(2);

/** A review's duration and cost as a chip that opens a popover with turns, list-price cost and tokens per model. */
function usageChip(usage: ReviewUsage): { chip: HTMLButtonElement; popover: HTMLElement } {
  const popover = el('div', 'usage-popover');
  popover.popover = 'auto';
  const summary = el('dl', 'usage-summary');
  for (const [label, value, tip] of [['Duration', usageDuration(usage.durationMs), ''], ['Turns', String(usage.turns), ''], ['Cost', usageCost(usage.cost), 'API list price, not what a subscription bills']] as const) {
    summary.append(el('dt', '', label), titled(el('dd', '', value), tip));
  }
  popover.append(summary, el('div', 'usage-note muted', 'Cost is the API list price.'));
  if (usage.models.length > 0) {
    const table = el('table', 'usage-table');
    const head = el('tr');
    for (const label of ['Model', 'Input', 'Output', 'Cache read', 'Cache write', 'Cost']) head.append(el('th', '', label));
    table.append(head);
    for (const row of usage.models) {
      const line = el('tr');
      line.append(el('td', 'usage-model', row.model));
      for (const tokens of [row.input, row.output, row.cacheRead, row.cacheWrite]) line.append(titled(el('td', '', tokenCount(tokens)), tokens.toLocaleString()));
      line.append(el('td', '', usageCost(row.cost)));
      table.append(line);
    }
    popover.append(table);
  }
  if (usage.agents.length > 0) {
    const table = el('table', 'usage-table');
    const head = el('tr');
    head.append(el('th', '', 'Agent'), titled(el('th', '', 'Cost'), 'Each model\'s cost split by the agents\' share of its tokens, weighted by token price'));
    table.append(head);
    for (const row of usage.agents) {
      const line = el('tr');
      line.append(el('td', '', row.agent === 'orchestrator' ? 'Orchestrator' : reviewerInfo[row.agent].label), el('td', '', usageCost(row.cost)));
      table.append(line);
    }
    popover.append(table);
  }
  const chip = el('button', 'usage-chip', `${usageDuration(usage.durationMs)} · ${usageCost(usage.cost)}`);
  chip.type = 'button';
  titled(chip, 'Time and cost of this review');
  chip.addEventListener('click', (event) => {
    // Inside a card's summary a click would also fold the card.
    event.preventDefault();
    event.stopPropagation();
    if (popover.matches(':popover-open')) { popover.hidePopover(); return; }
    const box = chip.getBoundingClientRect();
    popover.style.top = box.bottom + 4 + 'px';
    popover.style.right = Math.max(8, window.innerWidth - box.right) + 'px';
    popover.showPopover();
  });
  return { chip, popover };
}

const stageLabels: Record<ReviewStage, [string, string]> = {
  triage: ['Triage', 'Claude reads the changes and briefs the reviewers.'],
  candidates: ['Candidates', 'Each reviewer looks for defects.'],
  select: ['Select', 'Claude merges and ranks the candidates.'],
  verify: ['Verify', 'Reviewers prove or refute the top candidates in their own worktrees.'],
  report: ['Report', 'Claude writes up the proven findings.'],
};
const verdictLabels: Record<NonNullable<ReviewLaneItem['verdict']>, string> = { confirmed: 'Confirmed', refuted: 'Refuted', unconfirmed: 'Unconfirmed' };

/** A running or failed review: its stage, the orchestrator's steps and a lane per review agent. */
function reviewLiveCard(live: ReviewLive, running: boolean, error: string | undefined): HTMLElement {
  const box = el('section', 'thread review review-card review-live');
  const head = strip('div', 'review', 'Claude\'s code review of these changes.', [], '', running ? 'Reviewing' : error === 'Stopped.' ? 'Review stopped' : 'Review failed');
  const time = el('span', 'time', elapsed(live.startedAt, live.endedAt));
  if (running) time.dataset.since = String(live.startedAt);
  head.append(time);
  const usage = live.usage === undefined ? undefined : usageChip(live.usage);
  if (usage) head.append(usage.chip);
  if (running) {
    const stop = button('', () => post({ action: 'review-stop' }), 'icon-button');
    stop.append(icon(icons.stop));
    setTip(stop, 'Stop the review');
    head.append(stop);
  }
  box.append(head, ...usage ? [usage.popover] : [], reviewStageBar(live.stage, running));
  if (!running && error !== undefined && error !== 'Stopped.') box.append(el('div', 'review-error', error));
  const lanes = el('div', 'review-lanes');
  const working = live.lanes.filter((lane) => lane.endedAt === undefined).length;
  // Agent calls already show as lanes, and while agents work the orchestrator only waits for them.
  const orchestratorSteps = live.orchestrator.filter((step) => step.verb !== 'Agent' && step.verb !== 'Task');
  const orchestrator = reviewLane(el('span', 'lane-name', 'Orchestrator'), !running ? 'Stopped' : working > 0 ? `Waiting on ${working} ${working === 1 ? 'reviewer' : 'reviewers'}` : '', running && working === 0, orchestratorSteps, running ? live.startedAt : undefined, running ? 'active' : error === undefined || error === 'Stopped.' ? 'idle' : 'failed');
  orchestrator.classList.add('orchestrator');
  lanes.append(orchestrator);
  for (const [index, reviewer] of live.reviewers.entries()) {
    const lane = live.lanes.find((candidate) => candidate.reviewer === reviewer);
    const [tag] = agentTags([reviewer]);
    if (tag === undefined) continue;
    if (lane === undefined) {
      const later = reviewStages.indexOf(live.stage) > reviewStages.indexOf('candidates');
      lanes.append(reviewLane(tag, later || !running ? 'Did not run' : 'Waiting', false, [], undefined, 'idle'));
      continue;
    }
    const busy = running && lane.endedAt === undefined;
    const node = reviewLane(tag, laneStatus(lane, busy), busy, lane.steps, busy ? lane.startedAt : undefined, busy ? 'active' : lane.failed ? 'failed' : lane.endedAt === undefined ? 'idle' : 'done', lane, (index + 1) * orbPhaseMs);
    lanes.append(node);
  }
  box.append(lanes);
  return box;
}

const stageIcons: Record<ReviewStage, string> = { triage: icons.triage, candidates: icons.candidates, select: icons.rank, verify: icons.verify, report: icons.report };

function reviewStageBar(stage: ReviewStage, running: boolean): HTMLElement {
  const bar = el('ol', 'review-stages');
  const at = reviewStages.indexOf(stage);
  reviewStages.forEach((name, index) => {
    const [label, tip] = stageLabels[name];
    const state = index < at ? 'done' : index === at ? (running ? 'now' : 'stopped') : 'next';
    const item = titled(el('li', state), tip);
    const mark = el('span', 'stage-icon');
    mark.append(icon(stageIcons[name]));
    item.append(mark, label);
    bar.append(item);
  });
  return bar;
}

function laneStatus(lane: ReviewLane, busy: boolean): string {
  const items = lane.items ?? [];
  if (busy) return lane.phase === 'verification' ? 'Verifying' : 'Finding candidates';
  if (lane.failed) return 'Failed';
  if (lane.phase === 'candidates') return items.length === 0 ? 'No candidates' : items.length + (items.length === 1 ? ' candidate' : ' candidates');
  const count = (verdict: NonNullable<ReviewLaneItem['verdict']>): number => items.filter((item) => item.verdict === verdict).length;
  return `${count('confirmed')} confirmed · ${count('refuted')} refuted` + (count('unconfirmed') ? ` · ${count('unconfirmed')} unconfirmed` : '');
}

/** One lane: who, what it is doing, its latest steps while it works, and what it handed back once done. */
/** Offsets each lane's orb so side-by-side orbs don't move in lockstep. */
const orbPhaseMs = 1370;

function reviewLane(name: HTMLElement, status: string, busy: boolean, steps: readonly AgentStep[], since: number | undefined, state: 'active' | 'done' | 'failed' | 'idle', lane?: ReviewLane, phase = 0): HTMLElement {
  const node = el('div', 'review-lane ' + state);
  const head = el('div', 'lane-head');
  // The running step below carries the orb; the empty icon keeps the lane names aligned.
  const mark = state === 'active' ? el('span', 'state-icon') : stateIcon(state === 'done' ? 'done' : state === 'failed' ? 'failed' : 'idle', state === 'done' ? 'ok' : state === 'failed' ? 'bad' : 'muted');
  head.append(mark, name);
  if (lane !== undefined) head.append(el('span', 'lane-phase muted', lane.phase === 'verification' ? 'verification' : 'candidates'));
  head.append(el('span', 'gap'), el('span', 'lane-status muted', status));
  if (lane?.endedAt !== undefined) head.append(el('span', 'time', elapsed(lane.startedAt, lane.endedAt)));
  node.append(head);
  if (busy || (state === 'failed' && steps.length > 0)) node.append(stepLog(steps, since, undefined, undefined, true, phase));
  if (lane?.items?.length) {
    const items = el('ul', 'lane-items');
    for (const item of lane.items) {
      const row = el('li');
      if (item.verdict !== undefined) row.append(el('span', 'verdict ' + item.verdict, verdictLabels[item.verdict]));
      if (item.severity !== undefined) row.append(el('span', 'sev ' + item.severity, findingSeverityLabels[item.severity]));
      row.append(el('span', 'lane-item', item.title));
      items.append(row);
    }
    node.append(items);
  }
  return node;
}

/** The Review button, its reviewer menu and its status chip. */
export function showReview(): void {
  const review = received.current?.review;
  $('review-tools').hidden = review === undefined;
  if (review === undefined) return;
  ui.reviewPicks = review.picked;
  const start = $<HTMLButtonElement>('review');
  start.replaceChildren(icon(review.running ? icons.stop : icons.agentReview), review.running ? 'Stop review' : review.result ? 'Rerun review' : 'Review');
  const status = $('review-status');
  status.textContent = review.running ? 'Review · ' + stageLabels[review.live?.stage ?? 'triage'][0] : review.error ? 'Review failed' : '';
  status.title = review.error ?? '';
  status.className = review.running ? 'chip agent working' : review.error ? 'chip bad' : '';
  status.hidden = !review.running && !review.error;
  renderReviewCard();
}

export function openReviewMenu(): void {
  const rows = reviewers.map((name) => menuRow([reviewerInfo[name].label, el('span', 'muted', reviewerInfo[name].description)], ui.reviewPicks?.includes(name) === true, (on) => {
    ui.reviewPicks = reviewers.filter((other) => other === name ? on : ui.reviewPicks?.includes(other) === true);
    post({ action: 'review-pick', reviewers: ui.reviewPicks });
  }));
  openToolbarMenu('review-pick', [el('div', 'muted picker-note', 'Reviewers'), ...rows, el('div', 'muted picker-note', 'Remembered for this repository.')], 'review-menu');
}
