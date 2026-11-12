/** Forms for new comments on lines and on whole files. */
import { fullyRead } from '../../readLines.js';
import type { LineRange } from '../../reviewedFiles.js';
import { githubField } from '../conversation/mentions.js';
import { $, agentButton, button, el, titled } from '../dom.js';
import { markViewed, selectedReadIds, unmarkRead } from '../files/marks.js';
import { renderFiles } from '../files/render.js';
import { range, selectedText } from '../files/selection.js';
import { collapsed, prefs, received, save, ui } from '../state.js';
import { post } from '../transport.js';
import type { Composer, FileComposer, Intent } from '../types.js';
import { sending } from './threadBox.js';

export function textarea(key: string, value: string, placeholder: string, onInput: (value: string) => void, onSubmit: () => void, onCancel: () => void): HTMLTextAreaElement {
  const area = el('textarea');
  area.value = value;
  area.placeholder = placeholder;
  area.dataset.draft = key;
  area.setAttribute('aria-label', placeholder);
  area.addEventListener('input', () => onInput(area.value));
  area.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); onSubmit(); } else if (event.key === 'Escape') onCancel();
  });
  return area;
}

export function composerBox(draft: Composer): HTMLElement {
  const github = draft.target === 'github' && !received.current?.localMode;
  const box = el('div', 'thread draft' + (github ? ' github' : ''));
  const head = el('div', 'strip');
  const toggle = el('span', 'seg');
  toggle.hidden = received.current?.localMode === true;
  toggle.setAttribute('role', 'group');
  toggle.setAttribute('aria-label', 'Who sees this comment');
  for (const [value, label] of [['claude', 'Local'], ['github', 'On GitHub']] as const) {
    const on = draft.target === value || (!draft.target && value === 'claude');
    const option = button(label, () => { draft.target = value; ui.focusNext = 'composer'; save(); renderFiles([draft.path]); });
    option.setAttribute('aria-pressed', String(on));
    toggle.append(option);
  }
  const lines = el('span', 'muted', (draft.side === 'old' ? 'Base · ' : '') + range(draft.start, draft.end));
  head.append(el('span', 'source', 'New comment'), toggle, lines);
  box.append(head);
  const cancel = (): void => { prefs.composer = undefined; save(); renderFiles([draft.path]); };
  const send = (pending: boolean, intent: Intent = 'ask'): void => {
    if (!draft.text.trim() || sending.has('composer')) return;
    sending.add('composer');
    ui.sentPending = pending;
    $('error').textContent = '';
    renderFiles([draft.path]);
    const where = { form: 'composer', path: draft.path, side: draft.side, startLine: draft.start, endLine: draft.end, text: draft.text } as const;
    post(github ? { action: 'github-comment', pending, ...where } : { action: 'comment', intent, ...where });
  };
  const submit = (): void => send(true);
  const selection: LineRange = { path: draft.path, side: draft.side, startLine: draft.start, endLine: draft.end };
  const file = received.files?.find((item) => item.path === selection.path);
  const covered = file ? selectedReadIds(file, selection) : undefined;
  const read = el('label', 'check');
  const readBox = el('input');
  readBox.type = 'checkbox';
  readBox.checked = covered !== undefined;
  read.title = 'Collapse these lines. When every change in the file is read, the file is marked Viewed.';
  read.append(readBox, 'Viewed');
  readBox.addEventListener('change', () => {
    if (readBox.checked) {
      const done = !!file && !received.viewed.has(file.path) && fullyRead(file, [...received.readRanges, selection]);
      received.readRanges = [...received.readRanges, { id: 'pending', ...selection }];
      if (done) markViewed(selection.path, true);
      post({ action: 'read', ...selection, viewed: done });
    } else if (covered) unmarkRead(covered);
    if (readBox.checked && !draft.text.trim()) prefs.composer = undefined;
    save();
    renderFiles([selection.path]);
  });
  const cancelLink = button('Cancel', cancel, 'quiet');
  const needText: HTMLButtonElement[] = [];
  const onDraft = (value: string): void => { draft.text = value; save(); for (const each of needText) each.disabled = sending.has('composer') || !value.trim(); };
  const area = github ? githubField('composer', draft.text, 'Comment on GitHub', onDraft, submit, cancel) : textarea('composer', draft.text, 'Ask about these lines', onDraft, submit, cancel);
  const busySending = sending.has('composer');
  const row = el('div', 'row actions composer-actions');
  if (github) {
    const review = button(busySending && ui.sentPending ? 'Sending…' : 'Add to review', () => send(true), 'primary');
    review.disabled = busySending;
    review.title = 'Goes into your pending review. Nobody sees it until you submit the review.';
    const reviewing = received.current?.details?.pendingComments !== undefined;
    const now = button(busySending && !ui.sentPending ? 'Sending…' : 'Post now', () => send(false));
    now.disabled = busySending || reviewing;
    now.title = reviewing ? 'You have a review in progress, so GitHub adds new comments to it. Submit the review to publish them.' : 'Posts on GitHub right away.';
    row.append(...reviewing ? [titled(el('span', 'chip pending', 'Review in progress'), 'New comments go into your pending review.')] : [], el('span', 'gap'), cancelLink, now, review);
  } else {
    const implement = agentButton('implement', 'Implement', () => send(true, 'implement'));
    implement.title = 'Agent changes the code';
    const ask = agentButton('ask', busySending ? 'Sending…' : 'Ask', submit);
    ask.title = 'Agent answers without editing';
    needText.push(implement, ask);
    onDraft(draft.text);
    row.append(el('span', 'gap'), cancelLink, implement, ask);
  }
  const original = draft.side === 'new' ? selectedText(draft.path, draft.start, draft.end) : undefined;
  if (original !== undefined) {
    const suggest = button('Suggest change', () => {
      draft.text = (draft.text.trim() ? draft.text.replace(/\s*$/u, '\n\n') : '') + '```suggestion\n' + original + '\n```\n';
      ui.focusNext = 'composer';
      save();
      renderFiles([draft.path]);
    }, 'quiet small');
    suggest.title = 'Start a suggestion from these lines. On GitHub it becomes a change the author can commit.';
    lines.before(suggest);
  }
  if (received.diffRange.kind === 'all') head.append(read);
  box.append(area, row);
  return box;
}

export function openFileComposer(path: string): void {
  const before = prefs.fileComposer?.path;
  if (before !== path) prefs.fileComposer = { path, text: '' };
  collapsed.set(path, false);
  ui.focusNext = 'file-composer';
  save();
  renderFiles([before, path]);
}

/** A new comment about a whole file: Local, where Claude answers it or changes the code, or On GitHub, like a comment on lines. */
export function fileComposerBox(draft: FileComposer): HTMLElement {
  const github = draft.target === 'github' && !received.current?.localMode;
  const box = el('div', 'thread draft' + (github ? ' github' : ''));
  const head = el('div', 'strip');
  const toggle = el('span', 'seg');
  toggle.hidden = received.current?.localMode === true;
  toggle.setAttribute('role', 'group');
  toggle.setAttribute('aria-label', 'Who sees this comment');
  for (const [value, label] of [['claude', 'Local'], ['github', 'On GitHub']] as const) {
    const option = button(label, () => { draft.target = value; ui.focusNext = 'file-composer'; save(); renderFiles([draft.path]); });
    option.setAttribute('aria-pressed', String(draft.target === value || (!draft.target && value === 'claude')));
    toggle.append(option);
  }
  head.append(el('span', 'source', 'New comment'), toggle, el('span', 'gap'), el('span', 'muted', 'Whole file'));
  const cancel = (): void => { prefs.fileComposer = undefined; save(); renderFiles([draft.path]); };
  const busySending = sending.has('file-composer');
  const send = (intent: Intent, pending = true): void => {
    if (!draft.text.trim() || sending.has('file-composer')) return;
    sending.add('file-composer');
    ui.sentPending = pending;
    $('error').textContent = '';
    renderFiles([draft.path]);
    post(github ? { action: 'github-file-comment', form: 'file-composer', path: draft.path, text: draft.text, pending }
      : { action: 'file-comment', form: 'file-composer', path: draft.path, text: draft.text, intent });
  };
  const row = el('div', 'row actions composer-actions');
  const needText: HTMLButtonElement[] = [];
  const onDraft = (value: string): void => { draft.text = value; save(); for (const each of needText) each.disabled = sending.has('file-composer') || !value.trim(); };
  const area = github ? githubField('file-composer', draft.text, 'Comment on GitHub', onDraft, () => send('ask'), cancel)
    : textarea('file-composer', draft.text, 'Ask about this file', onDraft, () => send('ask'), cancel);
  if (github) {
    const review = button(busySending && ui.sentPending ? 'Sending…' : 'Add to review', () => send('ask', true), 'primary');
    review.disabled = busySending;
    review.title = 'Goes into your pending review. Nobody sees it until you submit the review.';
    const reviewing = received.current?.details?.pendingComments !== undefined;
    const now = button(busySending && !ui.sentPending ? 'Sending…' : 'Post now', () => send('ask', false));
    now.disabled = busySending || reviewing;
    now.title = reviewing ? 'You have a review in progress, so GitHub adds new comments to it. Submit the review to publish them.' : 'Posts on GitHub right away.';
    row.append(...reviewing ? [titled(el('span', 'chip pending', 'Review in progress'), 'New comments go into your pending review.')] : [], el('span', 'gap'), button('Cancel', cancel, 'quiet'), now, review);
  } else {
    const implement = agentButton('implement', 'Implement', () => send('implement'));
    implement.title = 'Agent changes the code';
    const ask = agentButton('ask', busySending ? 'Sending…' : 'Ask', () => send('ask'));
    ask.title = 'Agent answers without editing';
    needText.push(implement, ask);
    onDraft(draft.text);
    row.append(el('span', 'gap'), button('Cancel', cancel, 'quiet'), implement, ask);
  }
  box.append(head, area, row);
  return box;
}
