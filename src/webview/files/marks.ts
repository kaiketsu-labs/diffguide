/** Viewed and read marks, and annotations on files. */
import { icons } from '../../icons.js';
import type { Annotation } from '../../pullRequests.js';
import { rangeReadIds } from '../../readLines.js';
import type { LineRange } from '../../reviewedFiles.js';
import type { FileDiff } from '../../unifiedDiff.js';
import { el, icon } from '../dom.js';
import { loading } from '../messages.js';
import { collapsed, prefs, publishing, received, replies, save, ui } from '../state.js';
import { post } from '../transport.js';
import type { Thread } from '../types.js';
import { contextLines, expansion, gapsOf } from './table.js';

/** One GitHub annotation from a check, under the line it points at. */
export function annotationBox(note: Annotation & { readonly check: string }): HTMLElement {
  const box = el('div', 'annotation-box ' + note.level);
  box.append(icon(note.level === 'failure' ? icons.error : note.level === 'warning' ? icons.warning : icons.info));
  const text = el('div');
  text.append(el('b', '', (note.title || note.check) + ' '), el('span', 'muted', note.title ? note.check : ''), el('div', '', note.message));
  box.append(text);
  return box;
}

export function annotationsOf(path: string): (Annotation & { readonly check: string })[] {
  if (!received.atHead) return [];
  return (received.current?.conversation?.checks ?? []).flatMap((check) => check.annotations.filter((note) => note.path === path).map((note) => ({ ...note, check: check.name })));
}

export function loadContext(file: FileDiff): void {
  if (!contextLines.has(file.path) && !loading.has(file.path)) {
    loading.add(file.path);
    post({ action: 'context', path: file.path });
  }
}

export function fullFile(file: FileDiff): boolean {
  return contextLines.has(file.path) && gapsOf(file).every((gap, index) => {
    const shown = expansion(file.path, index);
    return shown.top + shown.bottom >= gap.to - gap.from + 1;
  });
}

/** Show a file as viewed right away; the extension's next state confirms it. */
export function markViewed(path: string, on: boolean): void {
  if (on) received.viewed.add(path);
  else received.viewed.delete(path);
  collapsed.set(path, on);
  save();
}

export function unmarkRead(ids: readonly string[]): void {
  received.readRanges = received.readRanges.filter((marked) => marked.id === undefined || !ids.includes(marked.id));
  post({ action: 'unread', ids });
}

/** What a file's box shows from extension state, so a state update redraws only the files it changed. */
export function fileKey(path: string, threads: readonly Thread[]): string {
  return JSON.stringify([received.viewed.has(path), collapsed.get(path) === true, received.readRanges.filter((marked) => marked.path === path), threads, received.current?.local?.[path] ?? null,
    prefs.composer?.path === path ? [ui.author, received.current?.details?.pendingComments] : null,
    // Draft reply disables itself while Claude runs, so an open form redraws when the run ends.
    threads.some((thread) => replies.has(thread.id) || publishing.has(thread.id)) ? received.current?.claude.running === true : null]);
}

/** Ids of the read ranges covering every selected diff line, or undefined when some selected line is unread. */
export function selectedReadIds(file: FileDiff, selection: LineRange): string[] | undefined {
  return rangeReadIds(file, received.readRanges, selection);
}
