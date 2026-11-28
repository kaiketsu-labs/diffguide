import { createWriteStream } from 'node:fs';
import { once } from 'node:events';
import type { Note } from '../notes/format.js';

export interface ExportOptions {
  /** Keep only notes that carry this tag. */
  readonly tag?: string;
  /** Notes written per batch before the stream waits for the disk. */
  readonly batchSize?: number;
}

const defaultBatchSize = 500;

/** Notes as newline-delimited JSON, one note per line. */
export function toLines(notes: readonly Note[], options: ExportOptions = {}): string[] {
  const wanted = options.tag === undefined ? notes : notes.filter((note) => note.tags.includes(options.tag as string));
  return wanted.map((note) => JSON.stringify(note));
}

/** Write notes to `file` in batches, waiting for the disk between them so memory stays flat. */
export async function exportNotes(notes: readonly Note[], file: string, options: ExportOptions = {}): Promise<number> {
  const lines = toLines(notes, options);
  const batchSize = options.batchSize ?? defaultBatchSize;
  const output = createWriteStream(file);
  for (let start = 0; start < lines.length; start += batchSize) {
    const batch = lines.slice(start, start + batchSize).join('\n') + '\n';
    if (!output.write(batch)) await once(output, 'drain');
  }
  output.end();
  await once(output, 'finish');
  return lines.length;
}
