/** Handles messages from the extension. */
import type { ExtensionMessage } from '../pullRequestOverview.js';
import type { FileDiff } from '../unifiedDiff.js';
import { edits } from './conversation/comment.js';
import { renderedPreviews } from './conversation/mentions.js';
import { commentAsks, renderConversation } from './conversation/timeline.js';
import { $, el } from './dom.js';
import { openFolders } from './files/nav.js';
import { medias, previews } from './files/preview.js';
import { isLarge, renderFiles } from './files/render.js';
import { contextLines, jump } from './files/table.js';
import { renderConnectMenu } from './header/connect.js';
import { closeMergeForm } from './header/merge.js';
import { closeTitleForm, renderLinked } from './header/pullRequest.js';
import { renderBaseMenu, renderReviewers } from './header/reviewers.js';
import { closeToolbarMenu, renderPicker } from './menus.js';
import { peeks, probes, renderPeek, showLink } from './peek.js';
import { render, revealGroup, revealStep } from './render.js';
import { closedFiles, collapsed, prefs, publishing, received, replies, save, ui } from './state.js';
import { hopIntoAvatar, setBusy, showNotice } from './status.js';
import { renderNavThreads } from './threads/list.js';
import { allThreads, redrawThread } from './threads/model.js';
import { batch, renderBatch } from './threads/suggestions.js';
import { commitDiffs, renderCommitThreads, restoreComment, sending } from './threads/threadBox.js';
import type { LiveLog } from './types.js';

/** Forms showing their Preview tab, and GitHub's rendering of the text each last previewed. */
export const previewTabs = new Set<string>();
export const loading = new Set<string>();

/** Paths whose diff differs from the one shown, or undefined when the file list or what it shows changed and every file needs drawing. */
function changedFiles(next: readonly FileDiff[], shownAs: string): string[] | undefined {
  const shown = received.files;
  if (prefs.view !== 'files' || shown === undefined || shownAs !== JSON.stringify([received.diffRange, prefs.whitespace, received.atHead])
    || shown.length !== next.length || next.some((file, index) => shown[index]?.path !== file.path)) return undefined;
  return next.filter((file, index) => JSON.stringify(file) !== JSON.stringify(shown[index])).map((file) => file.path);
}

function liveLogs(): LiveLog[] {
  return [...document.querySelectorAll<HTMLElement>('.claude-live[data-thread]')].flatMap((log) => {
    const orb = log.querySelector('.orb');
    const thread = received.current?.threads.find((candidate) => candidate.id === log.dataset.thread);
    return orb && thread ? [{ threadId: thread.id, messages: thread.messages.length, log, at: log.getBoundingClientRect(), orb: orb.getBoundingClientRect() }] : [];
  });
}

export function onExtensionMessage(data: ExtensionMessage): void {
  const live = data.state ? liveLogs() : [];
  if (data.state) render(data.state);
  for (const log of live) void hopIntoAvatar(log);
  const shownAs = JSON.stringify([received.diffRange, prefs.whitespace, received.atHead]);
  if (data.selection) { received.diffRange = data.selection.range; prefs.whitespace = data.selection.whitespace; received.atHead = data.atHead !== false; save(); }
  if (data.icons) received.fileIcons = data.icons;
  if (data.repositoryFiles) received.repositoryFiles = data.repositoryFiles;
  if (data.files) {
    const changed = changedFiles(data.files, shownAs);
    received.files = data.files;
    for (const file of received.files) if (!collapsed.has(file.path) && (file.generated || isLarge(file))) collapsed.set(file.path, true);
    if (changed === undefined) { received.guide = undefined; contextLines.clear(); loading.clear(); renderFiles(); }
    else {
      if (changed.length) received.guide = undefined;
      for (const path of changed) { contextLines.delete(path); loading.delete(path); }
      renderFiles(changed);
    }
    renderNavThreads();
  }
  if (data.markdown) {
    const entry = renderedPreviews.get(data.markdown.form);
    if (entry) renderedPreviews.set(data.markdown.form, { text: entry.text, html: data.markdown.html });
    const box = document.querySelector<HTMLElement>('[data-preview="' + CSS.escape(data.markdown.form) + '"]');
    if (box && entry) box.innerHTML = data.markdown.html || '<span class="muted">Nothing to preview.</span>';
  }
  if (data.commitDiff) {
    const { oid } = data.commitDiff;
    commitDiffs.set(oid, 'files' in data.commitDiff ? data.commitDiff.files : { error: data.commitDiff.error });
    renderCommitThreads(oid);
  }
  if (data.preview) { previews.set(data.preview.path, data.preview); loading.delete('preview:' + data.preview.path); renderFiles([data.preview.path]); }
  if (data.media) { medias.set(data.media.path, data.media); loading.delete('media:' + data.media.path); renderFiles([data.media.path]); }
  if (data.context) { contextLines.set(data.context.path, data.context.lines); loading.delete(data.context.path); renderFiles([data.context.path]); }
  if (data.definition) { peeks.length = ui.peekAt + 1; peeks.push(data.definition); ui.peekAt = peeks.length - 1; renderPeek(); }
  if (data.probe) { probes.set(data.probe.id, data.probe.found); showLink(); }
  if (data.revealStep) revealStep(data.revealStep);
  if (data.revealGroup) revealGroup(data.revealGroup);
  if (data.revealThread) {
    const thread = allThreads().find((each) => each.id === data.revealThread);
    if (thread) jump(thread);
  }
  if (data.reveal && received.files) {
    prefs.view = 'files';
    closedFiles.delete(data.reveal);
    collapsed.set(data.reveal, false);
    openFolders(data.reveal);
    save();
    renderFiles();
    document.querySelector('[data-path="' + CSS.escape(data.reveal) + '"]')?.scrollIntoView({ block: 'start' });
  }
  if (data.filesError) $('files').replaceChildren(el('p', 'bad', 'Could not read the changes: ' + data.filesError));
  if (data.restored) restoreComment(data.restored);
  if (data.notice) showNotice(data.notice);
  if (data.error) {
    loading.clear();
    $('error').textContent = data.error;
    if (data.form && sending.delete(data.form)) { renderFiles(); if (received.current) renderConversation(received.current, true); }
  }
  if (data.drafted) {
    const { thread: id, text, github } = data.drafted;
    sending.delete('draft:' + id);
    if (github) {
      replies.set(id, text);
      previewTabs.delete('reply:' + id);
      ui.focusNext = 'reply:' + id;
    } else {
      replies.delete(id);
      publishing.set(id, text);
      ui.focusNext = 'publish:' + id;
    }
    save();
    const thread = allThreads().find((each) => each.id === id);
    if (thread) redrawThread(thread);
  }
  if (data.done === 'review') $<HTMLTextAreaElement>('review').value = '';
  if (data.done === 'merge') closeMergeForm();
  if (data.done === 'title') closeTitleForm();
  if (data.done === 'dismiss') { ui.dismissing = undefined; if (received.current) renderReviewers(received.current, true); }
  if (data.done === 'suggestions') { batch.clear(); renderBatch(); }
  if (data.done === 'conversation') {
    sending.delete('conversation');
    prefs.conversationDraft = '';
    previewTabs.delete('conversation');
    save();
    if (received.current) renderConversation(received.current, true);
  }
  if (data.done?.startsWith('edit:')) {
    const id = data.done.slice(5);
    sending.delete(data.done);
    edits.delete(id);
    previewTabs.delete(data.done);
    if (received.current) renderConversation(received.current, true);
    renderFiles([allThreads().find((thread) => thread.messages.some((entry) => 'id' in entry && entry.id === id))?.path]);
  }
  if (data.done === 'link') { ui.linking = false; if (received.current) renderLinked(received.current); }
  if (data.done === 'body') { ui.editingBody = false; if (received.current) render(received.current); }
  if (data.done === 'file-composer') {
    sending.delete('file-composer');
    const path = prefs.fileComposer?.path;
    prefs.fileComposer = undefined;
    save();
    renderFiles([path]);
  }
  if (data.done === 'composer') {
    sending.delete('composer');
    const path = prefs.composer?.path;
    prefs.composer = undefined;
    save();
    renderFiles([path]);
  }
  if (data.done?.startsWith('publish:')) {
    const id = data.done.slice(8);
    sending.delete(data.done);
    publishing.delete(id);
    previewTabs.delete(data.done);
    save();
    redrawThread(allThreads().find((thread) => thread.id === id));
  }
  if (data.done?.startsWith('reply:')) {
    const id = data.done.slice(6);
    sending.delete(data.done);
    replies.delete(id);
    save();
    redrawThread(allThreads().find((thread) => thread.id === id));
  }
  if (data.done?.startsWith('comment-ask:')) {
    sending.delete(data.done);
    commentAsks.delete(data.done.slice('comment-ask:'.length));
    if (received.current) renderConversation(received.current, true);
  }
  if (data.branches) { ui.baseBranches = data.branches; renderBaseMenu(); }
  if (data.conversations || data.conversationsError !== undefined) { received.conversations = data.conversations ?? data.conversationsError; renderConnectMenu(); }
  if (data.runningReady && received.connectView === 'preparing') { received.connectView = 'running'; renderConnectMenu(); }
  if (data.error !== undefined && received.connectView === 'preparing' && ui.toolbarMenu?.anchor === 'connect') closeToolbarMenu();
  if (data.branchesError !== undefined) { ui.baseBranches = data.branchesError; renderBaseMenu(); }
  if (data.pickerOptions) { ui.pickerOptions = data.pickerOptions; ui.pickerError = undefined; renderPicker(); }
  if (data.pickerError !== undefined) { ui.pickerError = data.pickerError; renderPicker(); }
  if (data.idle) setBusy(false);
}
