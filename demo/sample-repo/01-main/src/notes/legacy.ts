import type { Note } from './format.js';

/** Notes saved by v1 had no tags and kept the title in `name`. */
interface LegacyNote {
  readonly id: number;
  readonly name: string;
  readonly text: string;
  readonly saved: number;
}

/** Convert a v1 export into the current note shape. */
export function importLegacy(raw: readonly LegacyNote[]): Note[] {
  return raw.map((entry) => ({
    id: `n${entry.id}`,
    title: entry.name,
    body: entry.text,
    tags: [],
    createdAt: new Date(entry.saved * 1000).toISOString(),
  }));
}

/** True when the value looks like a v1 export: an array of `{ id, name, text, saved }`. */
export function looksLegacy(value: unknown): value is readonly LegacyNote[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'object' && entry !== null && typeof entry.id === 'number' && typeof entry.saved === 'number');
}

/** How many notes an export holds, without converting them. */
export function countLegacy(value: unknown): number {
  return looksLegacy(value) ? value.length : 0;
}

/** The oldest save time in an export, or undefined for an empty one. */
export function firstSaved(raw: readonly LegacyNote[]): Date | undefined {
  const oldest = Math.min(...raw.map((entry) => entry.saved));
  return Number.isFinite(oldest) ? new Date(oldest * 1000) : undefined;
}
