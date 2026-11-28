import { ago, day } from '../util/dates.js';

export interface Note {
  readonly id: string;
  readonly title: string;
  readonly body: string;
  readonly tags: readonly string[];
  readonly createdAt: string;
}

const maximumTitle = 80;
const maximumPreview = 160;

/** Collapse runs of whitespace so a note fits one line. */
function singleLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** The title as shown in lists: one line, shortened with an ellipsis. */
export function shortTitle(note: Note): string {
  const title = singleLine(note.title);
  return title.length > maximumTitle ? `${title.slice(0, maximumTitle - 1)}…` : title;
}

/** The first part of the body, for list previews. */
export function preview(note: Note): string {
  const body = singleLine(note.body);
  return body.length > maximumPreview ? `${body.slice(0, maximumPreview - 1)}…` : body;
}

/** Tags as "#work #ideas", sorted so the output is stable. */
export function tagLine(note: Note): string {
  return [...note.tags].sort().map((tag) => `#${tag}`).join(' ');
}

/** The age of a note, such as "2 hours ago". */
export function age(note: Note, now: Date = new Date()): string {
  return ago(new Date(note.createdAt), now);
}

/** Group notes by the day they were written, newest day first. */
export function byDay(notes: readonly Note[]): Map<string, Note[]> {
  const groups = new Map<string, Note[]>();
  const newestFirst = [...notes].sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id));
  for (const note of newestFirst) {
    const key = day(new Date(note.createdAt));
    groups.set(key, [...(groups.get(key) ?? []), note]);
  }
  return groups;
}

/** One note as plain text: title, tags, then the body. */
export function formatNote(note: Note): string {
  const lines = [shortTitle(note)];
  const tags = tagLine(note);
  if (tags !== '') lines.push(tags);
  lines.push('', note.body);
  return lines.join('\n');
}
