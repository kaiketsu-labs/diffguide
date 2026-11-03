import type { LineRange } from './reviewedFiles.js';
import type { DiffLine, FileDiff } from './unifiedDiff.js';

/** A read range, or a selection about to become one. */
export type MarkedRange = LineRange & { readonly id?: string };

/** Diff lines inside read ranges, with the ids of the ranges covering each; marking added lines also covers the lines they replace, and the reverse. */
export function readLines(file: FileDiff, ranges: readonly MarkedRange[]): Map<DiffLine, string[]> {
  const lines = file.hunks.flatMap((hunk) => hunk.lines);
  const read = new Map<DiffLine, string[]>();
  for (const marked of ranges) {
    if (marked.path !== file.path) continue;
    const key = marked.side === 'old' ? 'oldLine' : 'newLine';
    let first = -1;
    let last = -1;
    lines.forEach((line, index) => {
      const number = line[key];
      if (number !== undefined && number >= marked.startLine && number <= marked.endLine) {
        if (first < 0) first = index;
        last = index;
      }
    });
    if (first < 0) continue;
    if (marked.side === 'new' && lines[first]?.kind === 'add') while (first > 0 && lines[first - 1]?.kind === 'del') first--;
    if (marked.side === 'old' && lines[last]?.kind === 'del') while (last < lines.length - 1 && lines[last + 1]?.kind === 'add') last++;
    for (const line of lines.slice(first, last + 1)) {
      const ids = read.get(line) ?? [];
      read.set(line, ids);
      if (marked.id) ids.push(marked.id);
    }
  }
  return read;
}

/** Ids of the ranges covering every diff line of `selection`, or undefined when one of them is unread. */
export function rangeReadIds(file: FileDiff, ranges: readonly MarkedRange[], selection: LineRange): string[] | undefined {
  const read = readLines(file, ranges);
  const key = selection.side === 'old' ? 'oldLine' : 'newLine';
  const lines = file.hunks.flatMap((hunk) => hunk.lines).filter((line) => {
    const number = line[key];
    return number !== undefined && number >= selection.startLine && number <= selection.endLine;
  });
  return lines.length > 0 && lines.every((line) => read.has(line)) ? [...new Set(lines.flatMap((line) => read.get(line) ?? []))] : undefined;
}

export function fullyRead(file: FileDiff, ranges: readonly MarkedRange[]): boolean {
  const read = readLines(file, ranges);
  return file.hunks.every((hunk) => hunk.lines.every((line) => line.kind === 'context' || read.has(line)));
}
