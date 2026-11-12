/** Which threads exist and where they show. */
import { renderConversation } from '../conversation/timeline.js';
import { renderFiles } from '../files/render.js';
import { prefs, received, replies, save } from '../state.js';
import { post } from '../transport.js';
import type { Thread } from '../types.js';
import { renderThreadList } from './list.js';

/** Archive toggles the page shows before the extension's next state confirms them, by thread id. */
export const archiving = new Map<string, boolean>();

export function isArchived(thread: { readonly id: string; readonly archived?: true }): boolean {
  return archiving.get(thread.id) ?? thread.archived === true;
}

/** Local threads the page shows: archived ones only while Show archived threads is on. */
export function localThreads(): Thread[] {
  return (received.current?.threads ?? []).filter((thread) => prefs.showArchived || !isArchived(thread)).map((thread) => ({ ...thread, source: 'local' as const }));
}

export function allThreads(): Thread[] {
  if (!received.current) return [];
  return [...localThreads(), ...(received.current.github ?? []).map((thread) => ({ ...thread, source: 'github' as const }))];
}

/** Whether the Files tab shows a thread: never one about the whole PR, guide notes only while Show guide comments is on. */
export function inFiles(thread: Thread): boolean {
  return thread.scope !== 'pullRequest' && (prefs.guideInFiles || thread.source !== 'local' || thread.origin !== 'analysis');
}

/** Local threads about the whole PR that quote the conversation comment `id`, oldest first. */
export function commentThreads(id: string): Thread[] {
  return localThreads().filter((thread) => thread.scope === 'pullRequest' && thread.linkedTo === id).sort((left, right) => started(left) - started(right));
}

/** Redraw where a thread shows: the Conversation for a thread about the whole PR, else its file. */
export function redrawThread(thread: Thread | undefined): void {
  if (thread?.scope === 'pullRequest') { if (received.current) renderConversation(received.current, true); } else renderFiles([thread?.path]);
}

/** Local threads Claude opened from this GitHub thread; the page shows them inside it. */
export function nestedIn(githubId: string): Thread[] {
  return localThreads().filter((thread) => thread.source === 'local' && thread.linkedTo === githubId).sort((left, right) => started(left) - started(right));
}

/** Archive or unarchive a local thread on the page right away; the extension's next state confirms it. */
export function setArchived(thread: Thread, archived: boolean): void {
  archiving.set(thread.id, archived);
  replies.delete(thread.id);
  save();
  post({ action: 'archive', id: thread.id, archived });
  redrawThread(thread);
  renderThreadList();
}

export function started(thread: Thread): number {
  return Date.parse(thread.messages[0]?.createdAt ?? '');
}

/** False for a local thread shown inside its GitHub thread. */
export function standalone(thread: Thread): boolean {
  return thread.source !== 'local' || thread.linkedTo === undefined || !received.current?.github?.some((github) => github.id === thread.linkedTo);
}
