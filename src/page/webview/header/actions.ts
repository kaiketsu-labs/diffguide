/** Header menus for the PR and its unpushed commits. */
import { icons } from '../../icons.js';
import { removeWorktreeQuestion } from '../../removeWorktree.js';
import { button, el } from '../dom.js';
import { askInMenu, closeToolbarMenu, menuRow, openToolbarMenu } from '../menus.js';
import { showUnpushed } from '../range.js';
import { received, ui } from '../state.js';
import { post } from '../transport.js';

function action(id: string, label: string, svg: string, pick: () => void): HTMLElement {
  const row = menuRow([label], false, () => { closeToolbarMenu(); pick(); }, true, svg);
  row.id = id;
  return row;
}

/** PR actions with labels; the connected conversation stays in Claude's menu. */
export function openPageMenu(): void {
  const state = received.current;
  if (!state) return;
  const rows = [action('pr', 'Open on GitHub', icons.github, () => post({ action: 'pr' }))];
  if (state.claude.link === undefined) rows.push(
    action('remove-worktree', 'Remove worktree', icons.trash, () => askInMenu('page-menu-button', removeWorktreeQuestion(state.number, state.unpushed?.length ?? 0), 'Remove worktree', () => post({ action: 'remove-worktree' }))),
    action('terminal', 'Open in terminal', icons.terminal, () => post({ action: 'terminal' })),
  );
  rows.push(action('link-pr', 'Link a PR…', icons.link, openLinkForm));
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

/** Show changes and Push belong to the branch; only editors can push. */
export function openUnpushedMenu(): void {
  const rows = [action('show-unpushed', 'Show changes', icons.show, showUnpushed)];
  if (received.current?.details?.canEdit) rows.push(action('push', 'Push', icons.push, () => post({ action: 'push' })));
  openToolbarMenu('unpushed-chip', rows);
  if (ui.toolbarMenu) ui.toolbarMenu.node.id = 'unpushed-menu';
}
