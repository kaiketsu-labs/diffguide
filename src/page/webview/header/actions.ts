/** Header menus for the PR and its unpushed commits. */
import { icons } from '../../icons.js';
import { removeWorktreeQuestion } from '../../removeWorktree.js';
import { $, button, el, icon } from '../dom.js';
import { askInMenu, closeToolbarMenu, menuRow, openToolbarMenu } from '../menus.js';
import { showCommits, showUnpushed } from '../range.js';
import { received, ui } from '../state.js';
import { refreshPage } from '../status.js';
import { post } from '../transport.js';

function action(id: string, label: string, svg: string, pick: () => void): HTMLElement {
  const row = menuRow([label], false, () => { closeToolbarMenu(); pick(); }, true, svg);
  row.id = id;
  return row;
}

/** PR actions with labels, then Refresh; the connected conversation stays in Claude's menu. Local pages only have Refresh. */
export function openPageMenu(): void {
  const state = received.current;
  if (!state) return;
  const rows: HTMLElement[] = [];
  if (state.localMode !== true) {
    rows.push(action('pr', 'Open on GitHub', icons.github, () => post({ action: 'pr' })));
    if (state.claude.link === undefined) rows.push(
      action('remove-worktree', 'Remove worktree', icons.trash, () => askInMenu('page-menu-button', removeWorktreeQuestion(state.number, state.unpushed?.length ?? 0), 'Remove worktree', () => post({ action: 'remove-worktree' }))),
      action('terminal', 'Open in terminal', icons.terminal, () => post({ action: 'terminal' })),
    );
    rows.push(action('link-pr', 'Link a PR…', icons.link, openLinkForm), el('div', 'menu-divider'));
  }
  rows.push(action('refresh', 'Refresh', icons.refresh, refreshPage));
  openToolbarMenu('page-menu-button', rows);
  if (ui.toolbarMenu) ui.toolbarMenu.node.id = 'page-menu';
}

function openLinkForm(): void {
  const form = el('div', 'link-form');
  const input = el('input');
  input.type = 'text';
  input.placeholder = 'owner/repo#12 or GitHub URL';
  input.setAttribute('aria-label', 'PR to link');
  const submit = (): void => { if (input.value.trim()) post({ action: 'link', link: input.value.trim() }); };
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') { event.preventDefault(); submit(); }
    else if (event.key === 'Escape') closeToolbarMenu();
  });
  form.append(input, button('Cancel', closeToolbarMenu, 'quiet'), button('Link', submit, 'primary'));
  openToolbarMenu('page-menu-button', [el('b', '', 'Link a PR'), form]);
  if (ui.toolbarMenu) ui.toolbarMenu.node.id = 'page-menu';
  input.focus();
}

/** The commits GitHub does not have yet, each opening its own changes, and all of them together. */
export function openUnpushedMenu(): void {
  const commits = received.current?.unpushed ?? [];
  openToolbarMenu('push-menu', [
    action('show-unpushed', 'Show changes', icons.show, showUnpushed),
    el('div', 'menu-divider'),
    ...commits.map((commit) => {
      const row = menuRow([commit.subject, el('span', 'muted', commit.oid.slice(0, 7))], false, () => { closeToolbarMenu(); showCommits(commit.oid, commit.oid); }, true, icons.commit);
      row.title = commit.subject;
      return row;
    }),
  ]);
  if (ui.toolbarMenu) ui.toolbarMenu.node.id = 'unpushed-menu';
}

/** Push, with its menu of the unpushed commits, beside Claude's chip while the branch has any; only editors can push, so others get the menu alone. */
export function renderPush(): void {
  const unpushed = received.current?.unpushed?.length ?? 0;
  const push = $<HTMLButtonElement>('push');
  $('push-split').hidden = !ui.pushing && unpushed === 0;
  push.hidden = !ui.pushing && received.current?.details?.canEdit !== true;
  push.disabled = ui.pushing;
  const menu = $<HTMLButtonElement>('push-menu');
  menu.disabled = ui.pushing;
  menu.replaceChildren(...push.hidden ? [unpushed + ' unpushed', icon(icons.chevronDown)] : [icon(icons.chevronDown)]);
  push.classList.toggle('busy', ui.pushing);
  push.replaceChildren(icon(ui.pushing ? icons.sync : icons.push), el('span', 'push-label', ui.pushing ? 'Pushing…' : 'Push'), ui.pushing ? '' : ' ' + unpushed);
  push.setAttribute('aria-label', ui.pushing ? 'Pushing' : `Push ${unpushed} unpushed commits`);
  fitPush();
}

/** Drop Push's label when the toolbar runs out of room, before Claude's chip shrinks under Finish review. */
export function fitPush(): void {
  const push = $('push');
  const split = $('push-split');
  const toolbar = split.parentElement as HTMLElement;
  push.classList.remove('icon-only');
  // The toolbar is end-aligned, so it overflows to the left, which scrollWidth does not count.
  if (!split.hidden && split.getBoundingClientRect().left < toolbar.getBoundingClientRect().left) push.classList.add('icon-only');
}

export function pushCommits(): void {
  ui.pushing = true;
  renderPush();
  post({ action: 'push' });
}

/** The push finished or failed; on success the button stays hidden until the next state recounts the commits. */
export function pushEnded(pushed: boolean): void {
  if (!ui.pushing) return;
  ui.pushing = false;
  renderPush();
  if (pushed) $('push-split').hidden = true;
}
