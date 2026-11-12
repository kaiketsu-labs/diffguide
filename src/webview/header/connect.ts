/** Agent context size and the connect menu. */
import { icons } from '../../icons.js';
import type { OverviewState } from '../../pullRequestOverview.js';
import { $, button, el, icon, relativeTime } from '../dom.js';
import { askInMenu, closeToolbarMenu, openToolbarMenu } from '../menus.js';
import { received, ui } from '../state.js';
import { showNotice } from '../status.js';
import { post } from '../transport.js';

/** Tokens in a few digits, such as 62k or 1.2M. */
export function tokenCount(tokens: number): string {
  return tokens >= 1_000_000 ? (tokens / 1_000_000).toFixed(1).replace(/\.0$/u, '') + 'M' : tokens >= 1000 ? Math.round(tokens / 1000) + 'k' : String(tokens);
}

/** Share of the window from which the meter warns that every run re-reads a large conversation. */
const largeContext = 0.5;

/** How full the PR's Claude conversation is, as a meter that opens the menu to start fresh or compact. */
export function renderContextButton(claude: OverviewState['claude']): void {
  const context = claude.link === undefined ? claude.context : undefined;
  const button = $('context');
  button.parentElement?.toggleAttribute('hidden', context === undefined);
  if (context === undefined) { if (ui.toolbarMenu?.anchor === 'context') closeToolbarMenu(); return; }
  const share = context.window ? Math.min(1, context.tokens / context.window) : undefined;
  const bar = el('span', 'bar');
  const fill = el('span');
  fill.style.width = (share ?? 0) * 100 + '%';
  bar.append(fill);
  button.replaceChildren(...share === undefined ? [] : [bar], tokenCount(context.tokens) + ' tokens');
  button.classList.toggle('large', share !== undefined && share >= largeContext);
  button.setAttribute('aria-label', 'Claude\'s context: ' + context.tokens + ' tokens' + (context.window ? ' of ' + context.window : ''));
  button.dataset.tip = 'Claude\'s context after its last run' + (context.window ? ', of ' + tokenCount(context.window) + ' tokens' : '') + '. Every run re-reads it';
}

export function openContextMenu(): void {
  const context = received.current?.claude.context;
  if (!context) return;
  const running = received.current?.claude.running === true;
  const rows = [
    el('div', 'muted picker-note', tokenCount(context.tokens) + (context.window ? ' of ' + tokenCount(context.window) : '') + ' tokens after the last run'),
    connectRow(icons.reopen, 'New conversation', 'Claude forgets this PR\'s earlier runs. Each comment still sends its thread', () => {
      askInMenu('context', 'Start a new conversation on the next comment? Claude forgets what it learned in earlier runs.', 'Start new', () => post({ action: 'new-conversation' }));
    }),
    connectRow(icons.summarize, 'Compact', 'Claude summarizes the conversation and keeps going', () => { closeToolbarMenu(); post({ action: 'compact' }); }),
  ];
  for (const row of rows.slice(1)) if (row instanceof HTMLButtonElement) { row.disabled = running; if (running) row.title = 'Claude is working on this PR'; }
  openToolbarMenu('context', rows, 'context-menu');
}

/** The Claude button where you connect a conversation yourself; the terminal button is for a PR's own Claude. */
export function renderConnectButton(link: OverviewState['claude']['link']): void {
  const connect = $('connect');
  $('terminal').hidden = link !== undefined;
  $('remove-worktree').closest('.menu-anchor')?.toggleAttribute('hidden', link !== undefined);
  connect.parentElement?.toggleAttribute('hidden', link === undefined);
  if (link === undefined) return;
  const label = link.terminal ? 'Open in terminal' : link.delivering ? 'Switch conversation' : 'Connect Claude';
  if (connect.dataset.label !== label) {
    connect.dataset.label = label;
    connect.replaceChildren(el('span', 'range-text', label), icon(icons.chevronDown));
  }
  if (received.connectView === 'running' && link.delivering) {
    received.connectView = 'choices';
    if (ui.toolbarMenu?.anchor === 'connect') closeToolbarMenu();
    showNotice({ text: 'Claude connected.' });
  } else if (received.connectView === 'choices') renderConnectMenu();
}

export function openConnectMenu(): void {
  received.connectView = 'choices';
  openToolbarMenu('connect', [], 'connect-menu');
  renderConnectMenu();
  ui.toolbarMenu?.node.querySelector<HTMLElement>('button, input')?.focus();
}

/** A Connect menu row: an icon, the action and a one-line hint under it. */
function connectRow(svg: string | undefined, label: string, hint: string, pick: () => void): HTMLElement {
  const row = el('button', 'picker-row connect-row');
  const text = el('span', 'connect-text');
  text.append(el('span', 'connect-name', label), ...hint ? [el('span', 'muted', hint)] : []);
  row.append(...svg === undefined ? [] : [icon(svg)], text);
  row.addEventListener('click', pick);
  return row;
}

export function renderConnectMenu(): void {
  const list = ui.toolbarMenu?.anchor === 'connect' ? ui.toolbarMenu.node.querySelector('.picker-list') : null;
  if (!list) return;
  const link = received.current?.claude.link;
  const choose = (how: 'show' | 'new' | 'copy' | 'resume', session?: string): void => {
    closeToolbarMenu();
    post(session === undefined ? { action: 'connect-claude', how } : { action: 'connect-claude', how: 'resume', session });
  };
  const choice = (label: string, note: string, pick: () => void): HTMLElement => connectRow(undefined, label, note, pick);
  if (received.connectView === 'choices') {
    const switching = link?.terminal === true || link?.delivering === true;
    list.replaceChildren(
      ...link?.terminal ? [connectRow(icons.terminal, 'Show terminal', 'The terminal of the connected conversation', () => choose('show')), el('div', 'menu-divider'), el('div', 'muted picker-note', 'Switch conversation')] : [],
      connectRow(icons.terminal, 'New conversation', 'Starts Claude in a VS Code terminal', () => choose('new')),
      connectRow(icons.earlier, 'Resume a conversation…', "Pick one of this folder's conversations", () => {
        received.connectView = 'resume';
        received.conversations = undefined;
        renderConnectMenu();
        list.querySelector('input')?.focus();
        post({ action: 'claude-conversations' });
      }),
      connectRow(icons.copy, 'Copy command', switching ? 'Start a new conversation in another terminal app' : 'Start Claude in another terminal app', () => choose('copy')),
      el('div', 'menu-divider'),
      el('div', 'muted picker-note', 'Claude already running'),
      connectRow(icons.link, 'Connect running Claude', 'Two commands to run in its terminal', () => {
        received.connectView = 'preparing';
        renderConnectMenu();
        post({ action: 'connect-claude', how: 'running' });
      }),
    );
  } else if (received.connectView === 'resume') {
    let search = list.querySelector<HTMLInputElement>('input[type=text]');
    if (!search) {
      search = el('input');
      search.type = 'text';
      search.placeholder = 'Filter conversations';
      search.setAttribute('aria-label', 'Filter conversations');
      search.addEventListener('input', () => renderConnectMenu());
    }
    const query = search.value.trim().toLowerCase();
    const found = typeof received.conversations === 'string' || received.conversations === undefined ? [] : received.conversations
      .filter((conversation) => !query || (conversation.title + ' ' + conversation.branch).toLowerCase().includes(query));
    const rows = found.map((conversation) => choice(conversation.title,
      [conversation.running ? 'Running' : '', relativeTime(new Date(conversation.modifiedAt).toISOString()), conversation.branch].filter(Boolean).join(' · '),
      () => choose('resume', conversation.id)));
    const note = typeof received.conversations === 'string' ? 'Could not list conversations: ' + received.conversations : received.conversations === undefined ? 'Loading…' : found.length ? '' : query ? 'No matches.' : 'No conversations in this folder yet.';
    list.replaceChildren(search, ...rows, ...note ? [el('div', 'muted picker-note', note)] : [], choice('All conversations in Claude…', '', () => choose('resume')));
  } else if (received.connectView === 'preparing') {
    list.replaceChildren(el('div', 'muted picker-note', 'Preparing Claude…'));
  } else {
    const command = (text: string, which: 'reload' | 'connect'): HTMLElement => {
      const row = el('div', 'row connect-command');
      const copy = button('Copy', () => { post({ action: 'copy-connect', command: which }); copy.textContent = 'Copied'; }, 'small');
      row.append(el('code', 'gap', text), copy);
      return row;
    };
    list.replaceChildren(el('p', 'ask-text', 'In the Claude terminal, run:'), command('/reload-plugins --force', 'reload'), command('/diffguide:connect', 'connect'),
      el('div', 'muted picker-note', 'Waiting for connection…'));
  }
}
