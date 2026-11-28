import { readFile, writeFile } from 'node:fs/promises';
import { exportNotes, type ExportOptions } from '../export/stream.js';
import type { Note } from './format.js';

export interface NoteStore {
  list(): Promise<readonly Note[]>;
  /** Write every note to `file` as newline-delimited JSON; resolves with the count. */
  exportTo(file: string, options?: ExportOptions): Promise<number>;
  add(note: Pick<Note, 'title' | 'body' | 'tags'>): Promise<Note>;
  remove(id: string): Promise<boolean>;
}

async function readAll(file: string): Promise<Note[]> {
  try {
    return JSON.parse(await readFile(file, 'utf8')) as Note[];
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

/** Open the notes file, creating it on the first write. */
export async function openStore(file: string): Promise<NoteStore> {
  let notes = await readAll(file);
  const save = async (): Promise<void> => {
    await writeFile(file, `${JSON.stringify(notes, null, 2)}\n`);
  };
  return {
    list: async () => notes,
    exportTo: (target, options) => exportNotes(notes, target, options),
    async add(input) {
      const note: Note = { id: `n${notes.length + 1}`, createdAt: new Date().toISOString(), ...input };
      notes = [...notes, note];
      await save();
      return note;
    },
    async remove(id) {
      const before = notes.length;
      notes = notes.filter((note) => note.id !== id);
      await save();
      return notes.length < before;
    },
  };
}
