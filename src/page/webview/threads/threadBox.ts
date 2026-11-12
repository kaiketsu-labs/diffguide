/** A comment thread under its code: messages and thread actions. */
import type { ReviewIntent } from '../../../core/contracts.js';
import type { FileDiff } from '../../../core/unifiedDiff.js';
import { icons } from '../../icons.js';
import type { ExtensionMessage, PageMessage } from '../../protocol.js';
import { watchAnswer } from '../answers.js';
import { commentBody, commentTools } from '../conversation/comment.js';
import { githubField } from '../conversation/mentions.js';
import { $, agentButton, button, chevronMark, el, icon, iconButton, keepInView, personAvatar, setTip, timeLabel, titled } from '../dom.js';
import { renderFiles } from '../files/render.js';
import { range } from '../files/selection.js';
import { previewTabs } from '../messages.js';
import { orbCanvas, stepMotion } from '../orb.js';
import { isUnpushed, showCommits } from '../range.js';
import { agentTags, findingMarks, threadKind } from '../review/review.js';
import { collapsed, prefs, publishing, received, replies, save, ui } from '../state.js';
import { runMotion, stepLog, workingSince } from '../status.js';
import { post } from '../transport.js';
import type { CommentPlace, Intent, StepPick, Thread, ThreadKind } from '../types.js';
import { textarea } from './composer.js';
import { isArchived, nestedIn, redrawThread, setArchived, started } from './model.js';
import { suggestionCard, suggestionRow } from './suggestions.js';

type Message = Thread['messages'][number];
export const sending = new Set<string>();
export const threadOpen = new Map<string, boolean>();
/** Threads whose earlier messages the user showed. */
const threadUnfolded = new Set<string>();
/** Threads longer than this show only their latest `unfoldedMessages` until unfolded. */
const foldThreadsAbove = 4;
const unfoldedMessages = 3;

/** The orb for a thread that waits for Claude: it dozes off while nothing will pick the comment up, and nods once Claude does. */
const waitMotion = (id: string): StepPick => ({ verb }) => {
  const since = workingSince.get(id)?.since;
  if (verb === 'Picked up') return ['nod', since];
  if (verb === 'Waiting for Claude' && !(received.current?.claude.link?.delivering ?? received.current?.claude.running)) return ['doze', since];
  return [stepMotion(verb)];
};

export function avatar(entry: Message, author: string): HTMLElement {
  if (!('avatarUrl' in entry) && entry.author === 'claude') {
    const node = el('span', 'avatar orb-avatar');
    node.title = author;
    node.append(orbCanvas('avatar'));
    return node;
  }
  const url = 'avatarUrl' in entry ? entry.avatarUrl : received.current?.details?.viewerAvatarUrl ?? '';
  const name = 'avatarUrl' in entry ? entry.authorName ?? entry.author : entry.author === 'human' ? received.current?.details?.viewerName : undefined;
  return personAvatar(url, name, author);
}

/** Avatar on the left, text beside it. GitHub messages name their author; local ones are You or Claude, which the avatar already says. */
function message(entry: Message, thread?: Thread): HTMLElement {
  const author = 'avatarUrl' in entry ? entry.author : entry.author === 'claude' ? 'Claude' : 'You';
  const item = el('div', 'msg');
  const main = el('div', 'msg-main');
  item.append(avatar(entry, author), main);
  if ('avatarUrl' in entry && thread?.source === 'github') {
    const place: CommentPlace = {
      kind: 'reviewComment',
      redraw: () => { renderFiles([thread.path]); },
      quote: (text) => {
        const reply = replies.get(thread.id) ?? '';
        replies.set(thread.id, (reply.trim() ? reply.replace(/\s*$/u, '\n\n') : '') + text);
        ui.focusNext = 'reply:' + thread.id;
        save();
        renderFiles([thread.path]);
      },
    };
    const comment = { ...entry, bodyHtml: entry.html };
    const head = el('div', 'msg-head');
    head.append(el('b', '', author), ...timeLabel(entry.createdAt), ...entry.edited ? [el('span', 'edited', '· edited')] : []);
    const meta = el('span', 'msg-meta');
    if (entry.pending) meta.append(el('span', 'chip pending', 'Pending'));
    meta.append(commentTools(comment, place));
    head.append(meta);
    main.append(head, ...commentBody(comment, place));
    const suggest = suggestionRow(thread, entry);
    if (suggest) main.append(suggest);
    return item;
  }
  if (!('avatarUrl' in entry)) {
    const meta = el('span', 'msg-meta');
    if ('intent' in entry && entry.intent !== undefined) meta.append(intentChip(entry.intent));
    meta.append(...timeLabel(entry.createdAt));
    if (meta.childElementCount > 0) main.append(meta);
  }
  const body = el('div', 'msg-text');
  body.innerHTML = entry.html;
  main.append(body);
  return item;
}

const intentLabels: Readonly<Record<ReviewIntent, readonly [string, string]>> = {
  ask: ['Ask', icons.agentAsk], implement: ['Implement', icons.agentImplement], summarize: ['Summarize', icons.agentAsk],
};

/** Which button sent a human message: Ask or Implement. */
function intentChip(intent: ReviewIntent): HTMLElement {
  const [label, svg] = intentLabels[intent];
  const chip = el('span', 'chip intent');
  chip.append(icon(svg), label);
  return chip;
}

/** Who can see a thread: Local stays with you and Claude, On GitHub is on the PR, Guide is Claude's note from its guide. */
export const kindMarks: Record<ThreadKind, string> = { github: icons.github, local: icons.local, analysis: icons.agentGuide, review: icons.agentReview };
export const kindLabels: Record<ThreadKind, string> = { github: 'On GitHub', local: 'Local', analysis: 'Guide', review: 'Review' };

export function kindLabel(kind: ThreadKind): HTMLElement {
  const label = el('span', 'source');
  label.append(icon(kindMarks[kind]), kindLabels[kind]);
  return label;
}

export function strip<K extends keyof HTMLElementTagNameMap>(tag: K, kind: ThreadKind, note: string, status: readonly string[], right: string, title?: string): HTMLElementTagNameMap[K] {
  const node = el(tag, 'strip');
  const name = kindLabel(kind);
  name.title = note;
  node.append(name, ...(title === undefined ? [] : [el('span', 'title', title)]), el('span', 'gap'), ...(status.length ? [el('span', 'pill state', status.join(' · '))] : []), el('span', 'muted', right));
  return node;
}

export function threadBox(thread: Thread): HTMLElement {
  const github = thread.source === 'github';
  const fromAnalysis = thread.source === 'local' && thread.origin === 'analysis';
  const finding = thread.source === 'local' && thread.origin === 'review' ? thread.finding : undefined;
  const fromClaude = fromAnalysis || (thread.source === 'local' && thread.origin === 'review');
  const box = el('details', 'thread ' + thread.source + (thread.pending ? ' pending' : '') + (fromAnalysis ? ' analysis' : '') + (thread.source === 'local' && thread.origin === 'review' ? ' review' : ''));
  box.id = 'thread-' + thread.id;
  box.open = threadOpen.get(thread.id) ?? !thread.resolved;
  box.addEventListener('toggle', () => {
    // With comments in the margin a diff thread starts as a mark, so its open state is always kept.
    const inMargin = prefs.marginThreads && box.parentElement?.closest('details.thread') === null && box.closest('tr.inline') !== null;
    if (!inMargin && box.open === !thread.resolved) threadOpen.delete(thread.id); else threadOpen.set(thread.id, box.open);
    if (inMargin && !box.open) renderFiles([thread.path]);
  });
  const status = github ? thread.status.split(' · ').filter((part) => part !== 'Open' && part !== 'Pending')
    : thread.status.split(' · ').filter((part) => !fromClaude || part !== 'Answered');
  const summary = strip('summary', threadKind(thread),
    github ? (thread.pending ? 'Only you see it until you submit your review.' : 'Everyone on the PR sees it.') : fromAnalysis ? 'From Claude\'s guide. Reply to ask about it.' : fromClaude ? 'From Claude\'s code review. Reply to ask about it.' : 'Only you and Claude see it.',
    status, thread.scope === 'pullRequest' ? 'Whole PR' : thread.scope === 'file' ? 'Whole file' : (thread.side === 'old' ? 'Base · ' : '') + range(thread.startLine, thread.endLine), thread.source === 'local' ? thread.title : undefined);
  summary.addEventListener('click', () => { if (box.open) keepInView(box, summary); });
  if (finding !== undefined) {
    summary.querySelector('.source')?.after(...agentTags(finding.reviewers));
    summary.querySelector('.gap')?.after(...findingMarks(finding));
  }
  if (thread.url) {
    const open = el('button', 'icon-button');
    open.append(icon(icons.github));
    open.setAttribute('aria-label', 'Open on GitHub');
    open.dataset.tip = 'Open on GitHub';
    open.addEventListener('click', (event) => { event.preventDefault(); event.stopPropagation(); post({ action: 'github', id: thread.id }); });
    summary.append(open);
  }
  box.append(summary);
  const folded = thread.messages.length > foldThreadsAbove ? thread.messages.length - unfoldedMessages : 0;
  const foldedItems: HTMLElement[] = [];
  const nested = github ? nestedIn(thread.id) : [];
  const startedBy = (time: string): Thread[] => nested.splice(0, nested.filter((local) => started(local) <= Date.parse(time)).length);
  thread.messages.forEach((entry, index) => {
    box.append(...startedBy(entry.createdAt).map(threadBox));
    const item = message(entry, thread);
    if (thread.source === 'local' && thread.newAnswer !== undefined && index === thread.messages.length - 1) watchAnswer(item, thread);
    if (index < folded) {
      item.hidden = !threadUnfolded.has(thread.id);
      foldedItems.push(item);
    }
    if (index === 0 && folded > 0) {
      const label = (): string => `${threadUnfolded.has(thread.id) ? 'Hide' : 'Show'} ${folded} earlier ${folded === 1 ? 'message' : 'messages'}`;
      const toggle = iconButton(icons.earlier, label(), () => {
        if (!threadUnfolded.delete(thread.id)) threadUnfolded.add(thread.id);
        for (const each of foldedItems) each.hidden = !threadUnfolded.has(thread.id);
        toggle.replaceChildren(icon(icons.earlier), label());
        toggle.classList.toggle('shown', threadUnfolded.has(thread.id));
      }, 'quiet unfold');
      toggle.classList.toggle('shown', threadUnfolded.has(thread.id));
      box.append(toggle);
    }
    const suggestions = 'suggestions' in entry ? entry.suggestions : undefined;
    if (thread.source === 'local' && thread.side === 'new' && suggestions?.length) {
      const main = item.querySelector('.msg-main');
      main?.append(suggestionCard(thread, index, suggestions));
      // A finding's evidence comes after its fix.
      const evidence = main?.querySelector('.msg-text > details.md-details:last-child');
      if (evidence) { const tail = el('div', 'msg-text'); tail.append(evidence); main?.append(tail); }
    }
    box.append(item);
    const made = thread.source === 'local' ? thread.commits?.filter((commit) => commit.after === index) : undefined;
    if (made?.length) {
      const list = claudeCommits(made);
      list.hidden = item.hidden;
      if (index < folded) foldedItems.push(list);
      box.append(list);
    }
  });
  const unplaced = thread.source === 'local' ? thread.commits?.filter((commit) => commit.after === undefined || commit.after >= thread.messages.length) : undefined;
  if (unplaced?.length) box.append(claudeCommits(unplaced));
  box.append(...nested.map(threadBox));
  const working = thread.source === 'local' ? thread.working : undefined;
  if (working) {
    const live = el('div', 'claude-live');
    live.dataset.thread = thread.id;
    const progress = thread.source === 'local' ? thread.progress : undefined;
    const controls = el('span', 'step-actions');
    const takeBack = thread.source === 'local' && thread.linkedTo === undefined && thread.scope !== 'pullRequest' && thread.messages.at(-1)?.author === 'human';
    // Local mode has no run of its own to stop, so its Stop only takes the comment back.
    if (takeBack) controls.append(withdrawButton(thread));
    else if (!received.current?.localMode) controls.append(stopButton());
    live.append(progress === undefined ? stepLog([{ verb: working, done: false }], undefined, controls, waitMotion(thread.id)) : stepLog(progress.steps, progress.startedAt, controls, runMotion(progress)));
    box.append(live);
  }
  const key = 'reply:' + thread.id;
  const actions = el('div', 'row actions composer-actions');
  const reply = replies.get(thread.id);
  if (reply !== undefined && !thread.resolved) {
    const cancel = (): void => { replies.delete(thread.id); save(); redrawThread(thread); };
    const send = (message: PageMessage): void => {
      sending.add(key);
      $('error').textContent = '';
      redrawThread(thread);
      post(message);
    };
    const submit = (intent: Intent = 'ask'): void => {
      const text = replies.get(thread.id) ?? '';
      // A local thread already holds the request, so Implement may go without a note.
      if ((!text.trim() && (github || intent !== 'implement')) || sending.has(key)) return;
      send(github ? { action: 'github-reply', form: key, id: thread.id, text } : { action: 'reply', form: key, id: thread.id, text, intent });
    };
    const askClaude = (intent: Intent): void => {
      if (sending.has(key)) return;
      send({ action: 'github-ask', form: key, id: thread.id, text: replies.get(thread.id) ?? '', intent });
    };
    const needText: HTMLButtonElement[] = [];
    const onReply = (value: string): void => { replies.set(thread.id, value); save(); for (const each of needText) each.disabled = sending.has(key) || !value.trim(); };
    box.append(github ? githubField(key, reply, 'Reply on GitHub, or tell the agent what to do', onReply, () => submit(), cancel)
      : textarea(key, reply, 'Reply', onReply, () => submit(), cancel));
    const busySending = sending.has(key);
    const primaryLabel = busySending ? 'Sending…' : !github ? 'Ask' : thread.pending ? 'Add to pending review' : 'Post on GitHub';
    const primary = github ? button(primaryLabel, () => submit(), 'primary') : agentButton('ask', primaryLabel, () => submit());
    primary.disabled = busySending;
    actions.append(el('span', 'gap'), button('Cancel', cancel, 'quiet'));
    if (github || (thread.draft !== undefined && !thread.url && !received.current?.localMode)) actions.append(draftReplyButton(thread, () => replies.get(thread.id) ?? ''));
    if (github) {
      const implement = agentButton('implement', 'Implement', () => askClaude('implement'));
      implement.title = 'Only the agent sees it. Agent changes the code';
      const ask = agentButton('ask', 'Ask', () => askClaude('ask'), false);
      ask.title = 'Only the agent sees it. Agent answers in a local thread without editing';
      for (const each of [implement, ask]) { each.disabled = busySending; actions.append(each); }
    } else {
      primary.title = 'Agent answers without editing';
      const implement = agentButton('implement', 'Implement', () => submit('implement'));
      implement.title = 'Agent changes the code. Without a note, it implements what the thread discussed';
      implement.disabled = busySending;
      needText.push(primary);
      onReply(reply);
      actions.append(implement);
    }
    actions.append(primary);
    box.append(actions);
    return box;
  }
  if (thread.source === 'local' && isArchived(thread)) {
    actions.append(el('span', 'gap'), iconButton(icons.unarchive, 'Unarchive', () => setArchived(thread, false)));
    box.append(actions);
    return box;
  }
  const draft = thread.source === 'local' ? publishing.get(thread.id) : undefined;
  if (thread.source === 'local' && draft !== undefined && !thread.url) {
    box.append(publishBox(thread, draft));
    return box;
  }
  actions.append(el('span', 'gap'), ...thread.url || received.current?.localMode ? [] : [thread.source === 'local' ? toGitHubButton(thread) : titled(iconButton(icons.github, 'Publish', () => post({ action: 'publish', id: thread.id }), 'quiet'), 'Publish to GitHub')]);
  if (thread.source === 'local') {
    const archive = iconButton(icons.archive, 'Archive', () => setArchived(thread, true), 'quiet');
    archive.title = 'Hide this thread. Show archived threads in the filter menu brings it back';
    actions.append(archive);
  }
  actions.append(iconButton(thread.resolved ? icons.reopen : icons.check, thread.resolved ? 'Reopen' : 'Resolve', () => post({ action: github ? 'github-resolve' : 'resolve', id: thread.id, resolved: !thread.resolved })));
  if (!thread.resolved) actions.append(iconButton(icons.reply, 'Reply', () => { replies.set(thread.id, ''); ui.focusNext = key; save(); redrawThread(thread); }));
  box.append(actions);
  return box;
}

/** Stop Claude's run on this PR; every Stop button on the page turns disabled until it ends. */
export function stopClaude(): void {
  ui.stoppingClaude = true;
  for (const stop of document.querySelectorAll<HTMLButtonElement>('#stop-claude, .stop-claude')) stop.disabled = true;
  $('error').textContent = '';
  post({ action: 'stop-claude' });
}

/** Stop beside a thread's live log, for the run that is answering it. */
function stopButton(): HTMLButtonElement {
  const stop = button('', stopClaude, 'icon-button stop-claude');
  stop.append(icon(icons.stop));
  setTip(stop, 'Stop. The comments it was answering wait for Retry.');
  stop.disabled = ui.stoppingClaude;
  return stop;
}

/** Stop beside a thread's live log that stops the run answering the thread's latest comment and puts the comment back in a box to edit. */
function withdrawButton(thread: Thread): HTMLButtonElement {
  const key = 'withdraw:' + thread.id;
  const stop = button('', () => {
    sending.add(key);
    $('error').textContent = '';
    renderFiles([thread.path]);
    post({ action: 'withdraw', form: key, id: thread.id });
  }, 'icon-button');
  stop.append(icon(icons.stop));
  setTip(stop, received.current?.localMode ? 'Take this comment back to edit it' : 'Stop and take this comment back to edit it');
  stop.disabled = sending.has(key);
  return stop;
}

/** Put a comment taken back into its thread's reply box, or into a new comment box where it was. */
export function restoreComment(restored: NonNullable<ExtensionMessage['restored']>): void {
  sending.delete('withdraw:' + restored.thread);
  const before = restored.scope === 'file' ? prefs.fileComposer?.path : prefs.composer?.path;
  if (!restored.threadRemoved) {
    replies.set(restored.thread, restored.text);
    ui.focusNext = 'reply:' + restored.thread;
  } else if (restored.scope === 'file') {
    prefs.fileComposer = { path: restored.path, text: restored.text };
    ui.focusNext = 'file-composer';
  } else {
    prefs.composer = { path: restored.path, side: restored.side, start: restored.startLine, end: restored.endLine, text: restored.text, target: 'claude' };
    ui.focusNext = 'composer';
  }
  collapsed.set(restored.path, false);
  save();
  renderFiles([before, restored.path]);
}

/** Reply in the GitHub thread this local thread sits in, else open the box that posts it on the diff. */
function toGitHubButton(thread: Thread & { readonly source: 'local' }): HTMLButtonElement {
  const parent = received.current?.github?.find((github) => github.id === thread.linkedTo);
  if (thread.linkedTo !== undefined && thread.scope !== 'pullRequest') {
    return titled(iconButton(icons.github, 'Reply', () => {
      if (parent === undefined || parent.resolved) {
        if (parent) threadOpen.set(parent.id, true);
        post({ action: 'publish', id: thread.id });
        return;
      }
      if (!replies.get(parent.id)?.trim()) replies.set(parent.id, thread.draft ?? '');
      ui.focusNext = 'reply:' + parent.id;
      save();
      renderFiles([parent.path]);
    }, 'quiet'), 'Reply on GitHub');
  }
  return titled(iconButton(icons.github, 'Publish', () => { publishing.set(thread.id, thread.draft ?? ''); ui.focusNext = 'publish:' + thread.id; save(); redrawThread(thread); }, 'quiet'), 'Publish to GitHub');
}

/**
 * Ask Claude to write the thread's GitHub comment from `notes`, the form's text: a local thread's Publish form opens with it,
 * a GitHub thread's Reply form gets it in place of the notes.
 */
function draftReply(thread: Thread, notes: string): void {
  const key = 'draft:' + thread.id;
  if (sending.has(key)) return;
  sending.add(key);
  $('error').textContent = '';
  redrawThread(thread);
  post({ action: thread.source === 'github' ? 'github-draft-reply' : 'draft-reply', form: key, id: thread.id, text: notes });
}

/** Draft reply in a Reply or Publish form; `notes` reads the form's text when clicked. */
function draftReplyButton(thread: Thread, notes: () => string): HTMLButtonElement {
  const drafting = sending.has('draft:' + thread.id);
  const draft = agentButton('draft', drafting ? 'Drafting…' : 'Draft reply', () => draftReply(thread, notes()), false);
  draft.disabled = drafting || received.current?.claude.running === true;
  draft.title = received.current?.claude.running ? 'Claude is working on this PR. Draft when it is done'
    : 'Agent writes the GitHub comment from this text: your notes, or a draft to revise. You edit it before posting';
  return draft;
}

/** Edit a local thread's comment and post it on the PR diff, now or into the pending review. */
function publishBox(thread: Thread & { readonly source: 'local' }, draft: string): DocumentFragment {
  const key = 'publish:' + thread.id;
  const cancel = (): void => { publishing.delete(thread.id); previewTabs.delete(key); save(); redrawThread(thread); };
  const send = (pending: boolean): void => {
    const text = publishing.get(thread.id) ?? '';
    if (!text.trim() || sending.has(key)) return;
    sending.add(key);
    ui.sentPending = pending;
    $('error').textContent = '';
    redrawThread(thread);
    post({ action: 'github-publish', form: key, id: thread.id, text, pending });
  };
  const onPullRequest = thread.scope === 'pullRequest';
  const field = githubField(key, draft, 'Comment on GitHub', (value) => { publishing.set(thread.id, value); save(); }, () => send(!onPullRequest), cancel);
  const busySending = sending.has(key);
  if (onPullRequest) {
    const comment = button(busySending ? 'Sending…' : 'Comment', () => send(false), 'primary');
    comment.disabled = busySending;
    comment.title = 'Posts in the PR conversation right away. Everyone on the PR sees it.';
    const row = el('div', 'row actions composer-actions');
    row.append(el('span', 'gap'), button('Cancel', cancel, 'quiet'), draftReplyButton(thread, () => publishing.get(thread.id) ?? ''), comment);
    const fragment = document.createDocumentFragment();
    fragment.append(field, row);
    return fragment;
  }
  const review = button(busySending && ui.sentPending ? 'Sending…' : 'Add to pending review', () => send(true), 'primary');
  review.disabled = busySending;
  review.title = 'Goes into your pending review. Nobody sees it until you submit the review.';
  const reviewing = received.current?.details?.pendingComments !== undefined;
  const now = button(busySending && !ui.sentPending ? 'Sending…' : 'Post now', () => send(false));
  now.disabled = busySending || reviewing;
  now.title = reviewing ? 'You have a review in progress, so GitHub adds new comments to it. Submit the review to publish them.' : 'Posts on GitHub right away.';
  const row = el('div', 'row actions composer-actions');
  row.append(...reviewing ? [titled(el('span', 'chip pending', 'Review in progress'), 'New comments go into your pending review.')] : [], el('span', 'gap'), button('Cancel', cancel, 'quiet'), draftReplyButton(thread, () => publishing.get(thread.id) ?? ''), now, review);
  const fragment = document.createDocumentFragment();
  fragment.append(field, row);
  return fragment;
}

/** Commits whose changes are unfolded in their Local thread. */
const openCommits = new Set<string>();
/** Each unfolded commit's changes, `loading` while the extension reads them, or why it could not. */
export const commitDiffs = new Map<string, readonly FileDiff[] | 'loading' | { readonly error: string }>();

/** Redraw the files whose Local threads list a commit. */
export function renderCommitThreads(oid: string): void {
  renderFiles((received.current?.threads ?? []).filter((thread) => thread.commits?.some((commit) => commit.oid === oid)).map((thread) => thread.path));
}

/** The commits Claude made in a local thread; each folds open to its changes, and its hash shows them in the Files tab. Commits GitHub does not list yet are marked as not pushed. */
function claudeCommits(commits: readonly { readonly oid: string; readonly subject: string }[]): HTMLElement {
  const list = el('div', 'commit-list thread-commits');
  for (const commit of commits) {
    const open = openCommits.has(commit.oid);
    const row = el('div', 'commit-row');
    const chevron = chevronMark(!open);
    chevron.title = open ? 'Hide the changes' : 'Show the changes here';
    chevron.addEventListener('click', () => {
      if (open) openCommits.delete(commit.oid);
      else {
        openCommits.add(commit.oid);
        if (!Array.isArray(commitDiffs.get(commit.oid))) { commitDiffs.set(commit.oid, 'loading'); post({ action: 'commit-diff', oid: commit.oid }); }
      }
      renderCommitThreads(commit.oid);
    });
    const hash = button(commit.oid.slice(0, 7), () => { showCommits(commit.oid, commit.oid); }, 'ref');
    hash.title = 'Show this commit in the Files tab';
    row.append(chevron, hash, el('span', 'text', commit.subject), ...isUnpushed(commit.oid) ? [el('span', 'chip', 'Not pushed')] : []);
    list.append(row);
    if (open) list.append(commitPreview(commitDiffs.get(commit.oid)));
  }
  return list;
}

/** A commit's changes as a read-only unified diff, file by file. */
function commitPreview(diff: readonly FileDiff[] | 'loading' | { readonly error: string } | undefined): HTMLElement {
  const box = el('div', 'commit-preview');
  if (diff === undefined || diff === 'loading') { box.append(el('div', 'note muted', 'Loading changes…')); return box; }
  if (!Array.isArray(diff)) { box.append(el('div', 'note bad', 'Could not read the changes: ' + (diff as { readonly error: string }).error)); return box; }
  for (const file of diff as readonly FileDiff[]) {
    const card = el('div');
    const head = el('div', 'preview-file');
    head.append(el('span', 'name', file.oldPath ? file.oldPath + ' → ' + file.path : file.path), el('span', 'stat-add', '+' + file.additions), el('span', 'stat-del', '−' + file.deletions));
    card.append(head);
    box.append(card);
    if (file.binary || !file.hunks.length) { card.append(el('div', 'note muted', file.binary ? 'Binary file not shown.' : 'No content changes.')); continue; }
    const table = el('table');
    const columns = el('colgroup');
    for (const name of ['num', 'num', '']) columns.append(el('col', name));
    table.append(columns);
    for (const hunk of file.hunks) {
      const header = el('tr', 'hunk');
      const cell = el('td', 'muted', hunk.header);
      cell.colSpan = 3;
      header.append(cell);
      table.append(header);
      for (const line of hunk.lines) {
        const row = el('tr', line.kind === 'context' ? '' : line.kind);
        const code = el('td', 'code');
        code.innerHTML = line.html;
        row.append(el('td', 'num', line.oldLine === undefined ? '' : String(line.oldLine)), el('td', 'num', line.newLine === undefined ? '' : String(line.newLine)), code);
        table.append(row);
      }
    }
    card.append(table);
  }
  return box;
}
