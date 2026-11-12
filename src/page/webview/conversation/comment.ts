/** A conversation comment: reactions, tools, body and hide menu. */
import type { ChangeRequestConversation, ConversationComment, HideReason, ReactionContent, ReactionCount } from '../../../core/forge.js';
import { icons } from '../../icons.js';
import { $, button, el, icon } from '../dom.js';
import { askInline, askRow, closeToolbarMenu, menuRow, openToolbarMenu } from '../menus.js';
import { previewTabs } from '../messages.js';
import { ui } from '../state.js';
import { sending } from '../threads/threadBox.js';
import { post } from '../transport.js';
import type { CommentPlace } from '../types.js';
import { githubField } from './mentions.js';
import { commentAsks, hiddenComment } from './timeline.js';

/** Comment edits in progress, by comment id. */
export const edits = new Map<string, string>();
/** Hidden comments the viewer chose to read anyway. */
export const revealed = new Set<string>();
const hideReasons: readonly (readonly [HideReason, string])[] = [['OUTDATED', 'Outdated'], ['RESOLVED', 'Resolved'], ['DUPLICATE', 'Duplicate'], ['OFF_TOPIC', 'Off-topic'],
  ['LOW_QUALITY', 'Low quality'], ['SPAM', 'Spam'], ['ABUSE', 'Abuse']];

const reactionEmoji: Record<ReactionContent, string> = { THUMBS_UP: '👍', THUMBS_DOWN: '👎', LAUGH: '😄', HOORAY: '🎉', CONFUSED: '😕', HEART: '❤️', ROCKET: '🚀', EYES: '👀' };
const reactionNames: Record<ReactionContent, string> = { THUMBS_UP: '+1', THUMBS_DOWN: '-1', LAUGH: 'Laugh', HOORAY: 'Hooray', CONFUSED: 'Confused', HEART: 'Heart', ROCKET: 'Rocket', EYES: 'Eyes' };
export const isWriter = (conversation: ChangeRequestConversation | undefined): boolean => conversation !== undefined && ['admin', 'maintain', 'write'].includes(conversation.permission);

/** Reaction chips that toggle the viewer's own reaction, and a button that opens the eight GitHub reactions. */
export function reactionsRow(subject: string, reactions: readonly ReactionCount[], canReact: boolean, redraw: () => void): HTMLElement {
  const row = el('div', 'reactions');
  for (const reaction of reactions) {
    const chip = button(reactionEmoji[reaction.content] + ' ' + reaction.count, () => react(subject, reaction.content, !reaction.viewerReacted), 'reaction');
    chip.setAttribute('aria-pressed', String(reaction.viewerReacted));
    chip.title = reactionNames[reaction.content];
    chip.disabled = !canReact;
    row.append(chip);
  }
  if (!canReact) return row;
  if (ui.emojiFor === subject) {
    const pop = el('span', 'emoji-pop');
    for (const content of Object.keys(reactionEmoji) as ReactionContent[]) {
      const on = reactions.some((reaction) => reaction.content === content && reaction.viewerReacted);
      const option = button(reactionEmoji[content], () => react(subject, content, !on));
      option.title = reactionNames[content];
      option.setAttribute('aria-pressed', String(on));
      pop.append(option);
    }
    row.append(pop);
  } else {
    const add = button('', () => { ui.emojiFor = subject; redraw(); }, 'reaction add');
    add.append(icon(icons.reaction));
    add.title = 'Add reaction';
    add.setAttribute('aria-label', 'Add reaction');
    row.append(add);
  }
  return row;
}

function react(subject: string, content: ReactionContent, on: boolean): void {
  ui.emojiFor = undefined;
  $('error').textContent = '';
  post({ action: 'react', id: subject, content, on });
}

function quoted(body: string): string {
  return body.trim().split('\n').map((line) => '> ' + line).join('\n') + '\n\n';
}

export function toolButton(svg: string, tip: string, onClick: () => void): HTMLButtonElement {
  const node = button('', onClick);
  node.append(icon(svg));
  node.title = tip;
  node.setAttribute('aria-label', tip);
  return node;
}

/** Quote, edit, hide and delete, as far as the viewer may. */
export function commentTools(comment: ConversationComment, place: CommentPlace): HTMLElement {
  const tools = el('span', 'msg-tools');
  if (place.kind !== 'reviewComment' && comment.body.trim() && !hiddenComment(comment) && !commentAsks.has(comment.id)) {
    tools.append(toolButton(icons.agentAsk, 'Ask the agent about this comment', () => { commentAsks.set(comment.id, ''); ui.focusNext = 'comment-ask:' + comment.id; place.redraw(); }));
  }
  if (comment.body.trim() && !hiddenComment(comment)) tools.append(toolButton(icons.quote, 'Quote reply', () => place.quote(quoted(comment.body))));
  if (comment.canEdit && !edits.has(comment.id)) tools.append(toolButton(icons.edit, 'Edit', () => { edits.set(comment.id, comment.body); ui.focusNext = 'edit:' + comment.id; place.redraw(); }));
  if (comment.canHide && comment.hidden !== undefined) tools.append(toolButton(icons.hidden, 'Unhide', () => post({ action: 'hide-comment', id: comment.id, hide: false })));
  else if (comment.canHide) {
    const anchor = 'hide-' + place.kind + '-' + comment.id;
    const hide = toolButton(icons.hidden, 'Hide', () => openHideMenu(anchor, comment.id));
    hide.id = anchor;
    hide.setAttribute('aria-haspopup', 'true');
    const wrap = el('span', 'menu-anchor');
    wrap.append(hide);
    tools.append(wrap);
  }
  if (comment.canDelete) {
    const send = (): void => post(place.kind === 'reviewComment' ? { action: 'github-delete', id: comment.id } : { action: 'delete-issue-comment', id: comment.id });
    const remove = toolButton(icons.trash, 'Delete on GitHub', () => askInline({ key: 'delete:' + comment.id, question: 'Delete this comment on GitHub? Everyone on the PR loses it.', label: 'Delete', send, redraw: place.redraw }));
    remove.classList.add('delete');
    tools.append(remove);
  }
  return tools;
}

/** The comment's body: folded when hidden, a form while edited, else GitHub's HTML with its reactions. */
export function commentBody(comment: ConversationComment, place: CommentPlace): HTMLElement[] {
  if (comment.hidden !== undefined && !revealed.has(comment.id)) {
    const note = el('div', 'hidden-note', 'Hidden as ' + comment.hidden + '.');
    note.append(button('Show', () => { revealed.add(comment.id); place.redraw(); }, 'quiet'));
    return [note];
  }
  const draft = edits.get(comment.id);
  if (draft !== undefined) {
    const key = 'edit:' + comment.id;
    const cancel = (): void => { edits.delete(comment.id); previewTabs.delete(key); place.redraw(); };
    const submit = (): void => {
      const text = edits.get(comment.id) ?? '';
      if (!text.trim() || sending.has(key)) return;
      sending.add(key);
      place.redraw();
      post({ action: 'edit-comment', form: key, kind: place.kind, id: comment.id, text });
    };
    const field = githubField(key, draft, 'Edit comment', (value) => { edits.set(comment.id, value); }, submit, cancel);
    const row = el('div', 'row actions composer-actions');
    const saveButton = button(sending.has(key) ? 'Saving…' : 'Update comment', submit, 'primary');
    saveButton.disabled = sending.has(key);
    row.append(el('span', 'gap'), button('Cancel', cancel, 'quiet'), saveButton);
    return [field, row];
  }
  const nodes: HTMLElement[] = [];
  if (comment.bodyHtml.trim()) {
    const body = el('div', 'msg-text');
    body.innerHTML = comment.bodyHtml;
    nodes.push(body);
  }
  nodes.push(reactionsRow(comment.id, comment.reactions, comment.canReact, place.redraw));
  if (ui.asking?.key === 'delete:' + comment.id) nodes.push(askRow(ui.asking));
  return nodes;
}

/** GitHub's reasons to hide a comment, under its Hide button; picking one hides it. */
function openHideMenu(anchor: string, id: string): void {
  const rows = hideReasons.map(([reason, label]) => menuRow([label], false, (on) => {
    if (!on) return;
    closeToolbarMenu();
    post({ action: 'hide-comment', id, hide: true, reason });
  }, true));
  openToolbarMenu(anchor, [el('div', 'muted picker-note', 'Why hide it?'), ...rows], 'hide-menu');
}
