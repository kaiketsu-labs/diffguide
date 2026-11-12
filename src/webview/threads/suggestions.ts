/** Suggested changes and the batch that commits them. */
import type { GitHubMessageView, PickedSuggestion } from '../../pullRequestOverview.js';
import { hiddenComment } from '../conversation/timeline.js';
import { $, button, el, setLabel } from '../dom.js';
import { renderFiles } from '../files/render.js';
import { received, ui } from '../state.js';
import { changePullRequest } from '../status.js';
import { post } from '../transport.js';
import type { Thread } from '../types.js';

/** GitHub suggestions picked to commit together, by comment id. */
export const batch = new Map<string, PickedSuggestion>();

/** Commit and Add to batch for a GitHub suggestion the viewer can push. */
export function suggestionRow(thread: Extract<Thread, { source: 'github' }>, entry: GitHubMessageView): HTMLElement | undefined {
  const details = received.current?.details;
  if (!entry.suggestion || thread.outdated || thread.side !== 'new' || !details?.canEdit || !details.open || hiddenComment(entry)) return undefined;
  const row = el('div', 'row suggest-row');
  const picked = batch.has(entry.id);
  const toggle = button(picked ? 'Remove from batch' : 'Add to batch', () => {
    if (picked) batch.delete(entry.id);
    else batch.set(entry.id, { thread: thread.id, comment: entry.id });
    renderBatch();
    renderFiles([thread.path]);
  });
  const commit = button('Commit suggestion', () => changePullRequest({ action: 'commit-suggestions', picked: [{ thread: thread.id, comment: entry.id }] }), 'primary');
  commit.dataset.prAction = '';
  commit.disabled = ui.busy;
  commit.title = 'Commits the change to the PR branch and pushes it.';
  row.append(el('span', 'gap'), toggle, commit);
  return row;
}

export function renderBatch(): void {
  const node = $<HTMLButtonElement>('commit-batch');
  node.hidden = batch.size === 0;
  setLabel(node, 'Commit ' + batch.size + (batch.size === 1 ? ' suggestion' : ' suggestions'));
}

/** Option picked on each message's suggestions, by thread id and message index. */
const pickedOptions = new Map<string, number>();

/** A message's suggestions as a small diff against the commented lines; several suggestions are options to switch between. */
export function suggestionCard(thread: Extract<Thread, { source: 'local' }>, index: number, suggestions: readonly (readonly string[])[]): HTMLElement {
  const key = thread.id + ':' + index;
  const picked = Math.min(pickedOptions.get(key) ?? (thread.applied?.message === index ? thread.applied.option : 0), suggestions.length - 1);
  const card = el('div', 'suggestion');
  const head = el('div', 'row suggestion-head');
  head.append(el('span', 'muted', suggestions.length > 1 ? suggestions.length + ' suggested options' : 'Suggested change'));
  if (suggestions.length > 1) {
    const tabs = el('span', 'seg');
    suggestions.forEach((_, option) => {
      const tab = button('Option ' + (option + 1), () => { pickedOptions.set(key, option); renderFiles([thread.path]); });
      tab.setAttribute('aria-pressed', String(option === picked));
      tabs.append(tab);
    });
    head.append(tabs);
  }
  const lines = el('pre', 'suggestion-diff');
  const line = (kind: 'add' | 'del', html: string): HTMLElement => {
    const row = el('div', kind);
    row.innerHTML = html;
    row.prepend(el('span', 'sign', kind === 'add' ? '+' : '-'));
    return row;
  };
  for (const html of thread.original ?? []) lines.append(line('del', html));
  for (const html of suggestions[picked] ?? []) lines.append(line('add', html));
  const actions = el('div', 'row actions');
  const where = { id: thread.id, message: index, option: picked };
  const publish = button('Publish suggestion', () => post({ action: 'publish-suggestion', ...where }));
  publish.title = 'Adds it to your pending review as a GitHub suggestion the author can commit.';
  const canPush = received.current?.details?.canEdit === true;
  const apply = button(canPush ? 'Commit suggestion' : 'Apply', () => post({ action: 'apply-suggestion', ...where }), 'primary');
  apply.title = received.current?.localMode ? 'Changes the file. Nothing is committed.' : !canPush ? 'Changes the file in the PR worktree. Nothing is committed, since you cannot push to this PR.'
    : received.current?.unpushed?.length ? 'Commits the change after the unpushed commits. Push them together.' : 'Commits the change to the PR branch and pushes it.';
  publish.hidden = received.current?.localMode === true;
  const done = thread.applied?.message === index ? thread.applied : undefined;
  if (done === undefined) actions.append(el('span', 'gap'), publish, apply);
  else if (done.done === 'pushed') actions.append(el('span', 'muted gap', 'Option ' + (done.option + 1) + ' committed and pushed.'));
  else if (done.done === 'committed') actions.append(el('span', 'muted gap', 'Option ' + (done.option + 1) + ' committed, not pushed yet.'));
  else actions.append(el('span', 'muted gap', 'Option ' + (done.option + 1) + (received.current?.localMode ? ' applied, not committed.' : ' applied to the worktree, not committed.')), button('Discard', () => post({ action: 'discard-suggestion', id: thread.id })), publish);
  card.append(head, lines, actions);
  return card;
}
