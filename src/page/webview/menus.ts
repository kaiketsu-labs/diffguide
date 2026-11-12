/** Page menus: the picker, toolbar menus, and confirm-in-place questions. */
import type { ChangeRequestDetails, PickerOptions } from '../../core/forge.js';
import { icons } from '../icons.js';
import type { PickTarget } from '../protocol.js';
import { $, button, el, icon, labels } from './dom.js';
import { received, ui } from './state.js';
import { changePullRequest } from './status.js';
import { post } from './transport.js';
import type { Ask } from './types.js';

/** One row of a picker; `key` keeps a user and a team with the same name apart. */
interface PickerItem { readonly key: string; readonly text: string; readonly note?: string; readonly color?: string; readonly description?: string }
const pickerPlaceholders: Record<PickTarget, string> = { reviewers: 'Filter people and teams', assignees: 'Filter people', labels: 'Filter labels', milestone: 'Filter milestones' };

function pickedKeys(what: PickTarget, details: ChangeRequestDetails): Set<string> {
  if (what === 'milestone') return new Set(details.milestone === undefined ? [] : [String(details.milestone.number)]);
  if (what === 'labels') return new Set(details.labels.map((label) => label.name));
  if (what === 'assignees') return new Set(details.assignees);
  return new Set(details.reviewers.filter((reviewer) => reviewer.state === 'requested' || reviewer.rerequested === true).map((reviewer) => reviewer.team === undefined ? 'user:' + reviewer.name : 'team:' + reviewer.team));
}

/** The repository's choices plus whatever the PR already has, so current values stay removable. */
function pickerItems(what: PickTarget, details: ChangeRequestDetails, options: PickerOptions): PickerItem[] {
  if (what === 'milestone') {
    const all = new Map([...details.milestone === undefined ? [] : [details.milestone], ...options.milestones].map((milestone) => [milestone.number, milestone]));
    return [...all.values()].map((milestone) => ({ key: String(milestone.number), text: milestone.title }));
  }
  if (what === 'labels') {
    const byName = new Map([...details.labels, ...options.labels].map((label) => [label.name, label]));
    return [...byName.values()].map((label) => ({ key: label.name, text: label.name, color: label.color, ...(label.description === undefined ? {} : { description: label.description }) }));
  }
  if (what === 'assignees') return [...new Set([...details.assignees, ...options.users])].map((login) => ({ key: login, text: login }));
  const users = details.reviewers.filter((reviewer) => reviewer.team === undefined);
  const teams = details.reviewers.flatMap((reviewer) => reviewer.team === undefined ? [] : [{ name: reviewer.name, slug: reviewer.team }]);
  const userItems = [...new Set([...users.map((reviewer) => reviewer.name), ...options.users])].map((login): PickerItem => {
    const state = users.find((reviewer) => reviewer.name === login)?.state;
    return { key: 'user:' + login, text: login, ...(state === undefined || state === 'requested' ? {} : { note: labels[state][2] }) };
  });
  const teamItems = [...teams, ...options.teams.filter((team) => !teams.some((entry) => entry.slug === team.slug))]
    .map((team): PickerItem => ({ key: 'team:' + team.slug, text: team.name, note: 'Team' }));
  return [...userItems, ...teamItems];
}

export function openPicker(what: PickTarget): void {
  const reopen = ui.picker?.what !== what;
  closePicker(true);
  const details = received.current?.details;
  if (!reopen || !details?.canEdit || ui.busy) return;
  const search = el('input');
  search.type = 'text';
  search.placeholder = pickerPlaceholders[what];
  search.setAttribute('aria-label', pickerPlaceholders[what]);
  const list = el('div', 'picker-list');
  const node = el('div', 'picker');
  node.append(search, list);
  $('pick-' + what).closest('section')?.append(node);
  $('pick-' + what).setAttribute('aria-pressed', 'true');
  const initial = pickedKeys(what, details);
  ui.picker = { what, initial, selected: new Set(initial), node, list };
  search.addEventListener('input', () => renderPicker(search.value));
  renderPicker('');
  search.focus();
  post({ action: 'picker-options' });
}

export function renderPicker(filter = ui.picker?.node.querySelector('input')?.value ?? ''): void {
  const details = received.current?.details;
  if (!ui.picker || !details) return;
  const { what, initial, selected, list } = ui.picker;
  const query = filter.trim().toLowerCase();
  const items = pickerItems(what, details, ui.pickerOptions ?? { users: [], teams: [], labels: [], milestones: [] })
    .filter((item) => !query || [item.text, item.key.replace(/^(?:user|team):/u, '')].some((text) => text.toLowerCase().includes(query)))
    .sort((a, b) => Number(initial.has(b.key)) - Number(initial.has(a.key)));
  const rows = items.map((item) => {
    const row = el('label', 'picker-row');
    const box = el('input');
    box.type = 'checkbox';
    box.checked = selected.has(item.key);
    box.addEventListener('change', () => {
      if (what === 'milestone') {
        selected.clear();
        if (box.checked) selected.add(item.key);
        renderPicker();
      } else if (box.checked) selected.add(item.key);
      else selected.delete(item.key);
    });
    const mark = icon(icons.check);
    mark.classList.add('check');
    row.append(box);
    if (item.color === undefined) row.append(mark, el('span', 'text', item.text));
    else {
      const label = el('span', 'picker-label');
      label.style.setProperty('--label', '#' + item.color);
      label.append(mark, el('span', 'dot'), el('span', 'text', item.text));
      if (item.description) {
        label.append(el('span', 'muted picker-description', item.description));
        row.title = item.description;
      }
      row.append(label);
    }
    if (item.note) row.append(el('span', 'muted', item.note));
    return row;
  });
  const note = ui.pickerError ? 'Could not load choices: ' + ui.pickerError : ui.pickerOptions === undefined ? 'Loading…' : items.length ? '' : query ? 'No matches.' : 'Nothing to pick.';
  list.replaceChildren(...rows, ...note ? [el('div', 'muted picker-note', note)] : []);
}

/** Close the open picker and save its selection unless `save` is false or nothing changed. */
export function closePicker(save: boolean): void {
  if (!ui.picker) return;
  const { what, initial, selected, node } = ui.picker;
  ui.picker = undefined;
  node.remove();
  $('pick-' + what).removeAttribute('aria-pressed');
  if (!save || (selected.size === initial.size && [...selected].every((key) => initial.has(key)))) return;
  const keys = [...selected];
  const prefixed = (prefix: string): string[] => keys.filter((key) => key.startsWith(prefix)).map((key) => key.slice(prefix.length));
  changePullRequest(what === 'reviewers' ? { action: 'pick', what, values: prefixed('user:'), teams: prefixed('team:') } : { action: 'pick', what, values: keys, teams: [] });
}

/** Show `next` in place of what asked it, until its confirm button or Cancel. */
export function askInline(next: Ask): void {
  const before = ui.asking;
  ui.asking = next;
  before?.redraw();
  next.redraw();
  document.querySelector<HTMLElement>('.ask-row button')?.focus();
}

export function stopAsking(): void {
  const before = ui.asking;
  ui.asking = undefined;
  before?.redraw();
}

/** The question on the left, Cancel and the confirm button on the right. */
export function askRow(ask: Ask): HTMLElement {
  const row = el('div', 'row ask-row');
  const confirm = button(ask.label, () => { stopAsking(); ask.send(); }, 'primary');
  confirm.dataset.prAction = '';
  confirm.disabled = ui.busy;
  const buttons = el('span', 'ask-buttons');
  buttons.append(button('Cancel', stopAsking, 'quiet'), confirm);
  row.append(el('span', 'muted gap', ask.question), buttons);
  return row;
}

/** A question in a menu under the button `anchor`, for buttons with no row to show it in. */
export function askInMenu(anchor: string, question: string, label: string, send: () => void): void {
  closeToolbarMenu();
  const confirm = button(label, () => { closeToolbarMenu(); send(); }, 'primary');
  confirm.disabled = ui.busy;
  const row = el('div', 'row ask-actions');
  row.append(button('Cancel', closeToolbarMenu, 'quiet'), confirm);
  openToolbarMenu(anchor, [el('p', 'ask-text', question), row], 'ask-menu');
}

/** A checkable row of a toolbar menu; `radio` rows close the menu when picked. */
export function menuRow(content: (Node | string)[], checked: boolean, change: (on: boolean) => void, radio = false, svg?: string): HTMLElement {
  const label = el('label', 'picker-row');
  const box = el('input');
  box.type = radio ? 'radio' : 'checkbox';
  box.name = radio ? 'menu' : '';
  box.checked = checked;
  box.addEventListener('change', () => { change(box.checked); });
  const mark = icon(icons.check);
  mark.classList.add('check');
  const text = el('span', 'text');
  text.append(...content);
  label.append(box, mark, ...svg === undefined ? [] : [icon(svg)], text);
  return label;
}

/** Open a menu under the toolbar button `anchor`, or close it when it is already open. */
export function openToolbarMenu(anchor: string, rows: HTMLElement[], className = ''): void {
  const again = ui.toolbarMenu?.anchor === anchor;
  closeToolbarMenu();
  if (again) return;
  const node = el('div', ('picker toolbar-menu ' + className).trim());
  const list = el('div', 'picker-list');
  list.append(...rows);
  node.append(list);
  $(anchor).after(node);
  $(anchor).setAttribute('aria-expanded', 'true');
  ui.toolbarMenu = { anchor, node };
  (node.querySelector<HTMLElement>('input:checked, [aria-checked=true]') ?? node.querySelector<HTMLElement>('input, button'))?.focus();
}

export function closeToolbarMenu(): void {
  if (!ui.toolbarMenu) return;
  ui.toolbarMenu.node.remove();
  $(ui.toolbarMenu.anchor).setAttribute('aria-expanded', 'false');
  ui.toolbarMenu = undefined;
}
