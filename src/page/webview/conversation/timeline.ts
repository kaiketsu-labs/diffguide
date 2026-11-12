/** The Conversation card: timeline entries, commits and the comment form. */
import type { GitHubComment, TimelineItem } from '../../../core/forge.js';
import { icons } from '../../icons.js';
import type { GitHubMessageView, GitHubThreadView, OverviewState } from '../../protocol.js';
import { $, agentButton, button, el, icon, personAvatar, stateIcon, type StateShape, timeLabel } from '../dom.js';
import { keepView } from '../files/render.js';
import { previewTabs } from '../messages.js';
import { showCommits } from '../range.js';
import { prefs, publishing, received, replies, save, ui } from '../state.js';
import { textarea } from '../threads/composer.js';
import { threadRow } from '../threads/list.js';
import { archiving, commentThreads } from '../threads/model.js';
import { sending, threadBox } from '../threads/threadBox.js';
import { post } from '../transport.js';
import type { CommentPlace, Intent } from '../types.js';
import { commentBody, commentTools, edits, revealed } from './comment.js';
import { githubField } from './mentions.js';

const recentEntries = 6;
/** Notes for the agent being written under a conversation comment, by comment id. */
export const commentAsks = new Map<string, string>();
const reviewVerbs: Record<Extract<TimelineItem, { kind: 'review' }>['state'], string> = {
  approved: 'approved these changes', changes: 'requested changes', commented: 'reviewed', dismissed: 'reviewed, since dismissed', pending: 'started a review',
};

let conversationStamp = '';

/** The Conversation card: comments, reviews, pushes and events, oldest first, and a box for a new comment. */
export function renderConversation(state: OverviewState, force = false): void {
  const pullRequestThreads = state.threads.filter((thread) => thread.scope === 'pullRequest');
  const stamp = JSON.stringify([ui.asking?.key, prefs.conversationFolded, ui.conversationAll, state.conversation, state.conversationError, !!state.details, [...edits], [...revealed], ui.emojiFor, [...previewTabs], [...sending].filter((key) => key === 'conversation' || key.startsWith('edit:') || key.startsWith('comment-ask:')),
    pullRequestThreads, prefs.showArchived, [...commentAsks.keys()], pullRequestThreads.map((thread) => [replies.get(thread.id), publishing.get(thread.id), archiving.get(thread.id)]), state.claude.running,
    (state.github ?? []).map((thread) => [thread.id, thread.location, thread.messages.map((entry) => [entry.id, entry.body])])]);
  if (!force && stamp === conversationStamp) return;
  conversationStamp = stamp;
  const timeline = $('timeline');
  const data = state.conversation;
  const place = (item: Extract<TimelineItem, { kind: 'comment' | 'review' }>): CommentPlace => ({
    kind: item.kind === 'review' ? 'review' : 'issue',
    redraw: () => { if (received.current) renderConversation(received.current, true); },
    quote: (text) => {
      prefs.conversationDraft = (prefs.conversationDraft.trim() ? prefs.conversationDraft.replace(/\s*$/u, '\n\n') : '') + text;
      previewTabs.delete('conversation');
      ui.focusNext = 'conversation';
      save();
      if (received.current) renderConversation(received.current, true);
    },
  });
  keepView(() => {
    if (!data) {
      timeline.replaceChildren(el('div', 'muted', state.conversationError ? 'Could not load the conversation: ' + state.conversationError : 'Loading conversation…'));
      $('conversation-form').replaceChildren();
      return;
    }
    const nodes: HTMLElement[] = [];
    let commits: Extract<TimelineItem, { kind: 'commit' }>[] = [];
    const flush = (): void => { if (commits.length) nodes.push(commitGroup(commits)); commits = []; };
    for (const item of data.timeline) {
      if (item.kind === 'commit') { commits.push(item); continue; }
      if (item.kind === 'review' && (item.state === 'pending' || (!item.bodyHtml.trim() && item.state === 'commented' && !reviewComments(item).length))) continue;
      flush();
      if (item.kind === 'event') nodes.push(eventItem(item));
      else nodes.push(commentItem(item, place(item)));
    }
    flush();
    $('conversation').classList.toggle('folded', prefs.conversationFolded);
    $('fold-conversation').setAttribute('aria-expanded', String(!prefs.conversationFolded));
    $('conversation-count').textContent = nodes.length ? String(nodes.length) : '';
    const hidden = ui.conversationAll ? 0 : Math.max(0, nodes.length - recentEntries - 1);
    const more = button('Show ' + hidden + ' earlier entries', () => { ui.conversationAll = true; if (received.current) renderConversation(received.current, true); }, 'quiet');
    more.classList.add('timeline-more');
    timeline.replaceChildren(...nodes.length ? hidden ? [more, ...nodes.slice(hidden)] : nodes : [el('div', 'muted', 'No comments yet.')]);
    renderConversationForm();
  }, $('conversation'));
}

function renderConversationForm(): void {
  const key = 'conversation';
  const submit = (): void => {
    if (!prefs.conversationDraft.trim() || sending.has(key)) return;
    sending.add(key);
    $('error').textContent = '';
    if (received.current) renderConversation(received.current, true);
    post({ action: 'conversation-comment', form: key, text: prefs.conversationDraft });
  };
  const field = githubField(key, prefs.conversationDraft, 'Add a comment', (value) => { prefs.conversationDraft = value; save(); }, submit, () => undefined);
  const row = el('div', 'row composer-actions');
  const send = button(sending.has(key) ? 'Sending…' : 'Comment', submit, 'primary');
  send.disabled = sending.has(key);
  row.append(el('span', 'gap'), send);
  $('conversation-form').replaceChildren(field, row);
}

/** A review's diff comments, found in the page's GitHub threads and in page order. */
function reviewComments(review: Extract<TimelineItem, { kind: 'review' }>): { thread: GitHubThreadView; message: GitHubMessageView }[] {
  const ids = new Set(review.comments);
  return (received.current?.github ?? []).flatMap((thread) => thread.messages.filter((entry) => ids.has(entry.id)).map((entry) => ({ thread, message: entry })));
}

function commentItem(item: Extract<TimelineItem, { kind: 'comment' | 'review' }>, place: CommentPlace): HTMLElement {
  const node = el('div', 'timeline-item comment');
  node.id = 'comment-' + item.id;
  const main = el('div', 'msg-main');
  const head = el('div', 'msg-head');
  const verb = item.kind === 'review' ? reviewVerbs[item.state] : 'commented';
  head.append(el('b', '', item.author), el('span', 'verb', verb), ...timeLabel(item.createdAt), ...item.edited ? [el('span', 'edited', '· edited')] : [], commentTools(item, place));
  main.append(head);
  if (item.bodyHtml.trim() || item.kind !== 'review') main.append(...commentBody(item, place));
  if (item.kind === 'review') {
    const comments = reviewComments(item);
    if (comments.length) {
      const list = el('ul', 'review-comments');
      list.append(...comments.map(({ thread, message: entry }) => threadRow({ ...thread, source: 'github', text: entry.body, messages: [entry] }, 'github')));
      main.append(list);
    }
  }
  if (commentAsks.has(item.id)) main.append(commentAskBox(item, place));
  main.append(...commentThreads(item.id).map(threadBox));
  node.append(personAvatar(item.avatarUrl, item.authorName ?? item.author, item.author), main);
  return node;
}

/** A note for the agent under a conversation comment; Ask or Implement opens a local thread about the whole PR that quotes the comment. */
function commentAskBox(comment: GitHubComment, place: CommentPlace): HTMLElement {
  const key = 'comment-ask:' + comment.id;
  const box = el('div', 'thread draft');
  const head = el('div', 'strip');
  head.append(el('span', 'source', 'New comment'), el('span', 'gap'), el('span', 'muted', 'Whole PR'));
  const cancel = (): void => { commentAsks.delete(comment.id); place.redraw(); };
  const busySending = sending.has(key);
  const send = (intent: Intent): void => {
    if (sending.has(key)) return;
    sending.add(key);
    $('error').textContent = '';
    place.redraw();
    post({ action: 'comment-ask', form: key, id: comment.id, text: commentAsks.get(comment.id) ?? '', intent });
  };
  const area = textarea(key, commentAsks.get(comment.id) ?? '', 'Tell the agent what to do, or leave empty', (value) => { commentAsks.set(comment.id, value); }, () => send('ask'), cancel);
  const implement = agentButton('implement', 'Implement', () => send('implement'));
  implement.title = 'Only the agent sees it. Agent changes the code';
  const ask = agentButton('ask', busySending ? 'Sending…' : 'Ask', () => send('ask'));
  ask.title = 'Only the agent sees it. Agent answers in a local thread without editing';
  implement.disabled = busySending;
  ask.disabled = busySending;
  const row = el('div', 'row actions composer-actions');
  row.append(el('span', 'gap'), button('Cancel', cancel, 'quiet'), implement, ask);
  box.append(head, area, row);
  return box;
}

function eventItem(item: Extract<TimelineItem, { kind: 'event' }>): HTMLElement {
  const node = el('div', 'timeline-item event');
  const line = el('div');
  line.append(el('b', '', item.actor), ' ' + item.text + ' · ', ...timeLabel(item.createdAt));
  node.append(personAvatar(item.avatarUrl, item.actor, item.actor), line);
  return node;
}

/** Consecutive pushes as one entry, with a button per commit that shows only its changes. */
function commitGroup(commits: readonly Extract<TimelineItem, { kind: 'commit' }>[]): HTMLElement {
  const node = el('div', 'timeline-item commits');
  const mark = el('span', 'avatar');
  mark.append(icon(icons.commit));
  const authors = [...new Set(commits.map((commit) => commit.author))];
  const main = el('div');
  const last = commits.at(-1);
  main.append(el('b', '', authors.join(', ')), ' added ' + commits.length + (commits.length === 1 ? ' commit · ' : ' commits · '), ...last ? timeLabel(last.createdAt) : []);
  const list = el('div', 'commit-list');
  for (const commit of commits) list.append(commitRow(commit));
  main.append(list);
  node.append(mark, main);
  return node;
}

const checkMarks: Record<NonNullable<Extract<TimelineItem, { kind: 'commit' }>['checks']>, readonly [StateShape, string, string]> = {
  success: ['done', 'ok', 'Checks passed'], failure: ['failed', 'bad', 'Checks failed'], pending: ['active', 'wait', 'Checks running'],
};

function commitRow(commit: Extract<TimelineItem, { kind: 'commit' }>): HTMLElement {
  const row = el('div', 'commit-row');
  row.title = commitTitle(commit);
  const hash = button(commit.oid.slice(0, 7), () => { showCommits(commit.oid, commit.oid); }, 'ref');
  hash.title = 'Show this commit\'s changes';
  row.append(hash, el('span', 'text', commit.headline), ...checkMark(commit));
  return row;
}

export function commitTitle(commit: Extract<TimelineItem, { kind: 'commit' }>): string {
  return commit.message ? commit.headline + '\n\n' + commit.message : commit.headline;
}

export function checkMark(commit: Extract<TimelineItem, { kind: 'commit' }>): HTMLElement[] {
  if (!commit.checks) return [];
  const [shape, tone, label] = checkMarks[commit.checks];
  return [stateIcon(shape, tone, label)];
}

/** Files, added and removed lines: always three cells, empty when GitHub could not count them. */
export function commitStats(commit: Extract<TimelineItem, { kind: 'commit' }>): HTMLElement[] {
  const lines = commit.additions !== undefined && commit.deletions !== undefined;
  return [
    el('span', 'muted num', commit.files === undefined ? '' : commit.files + (commit.files === 1 ? ' file' : ' files')),
    el('span', 'ok num', lines ? '+' + commit.additions : ''),
    el('span', 'bad num', lines ? '−' + commit.deletions : ''),
  ];
}

export function hiddenComment(entry: { readonly id: string; readonly hidden?: string }): boolean {
  return entry.hidden !== undefined && !revealed.has(entry.id);
}
