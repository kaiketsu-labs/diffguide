import { readFile, writeFile } from 'node:fs/promises';

/** Moves the notes under `## Unreleased` into the newest release section as `### Notes`. */
const file = process.argv[2] ?? 'CHANGELOG.md';
const text = await readFile(file, 'utf8');
const unreleased = text.match(/^## Unreleased\n([\s\S]*?)(?=^## \[)/m);
if (!unreleased || unreleased.index === undefined) throw new Error('No "## Unreleased" section above a release.');
const notes = unreleased[1].trim();
if (!notes) process.exit(0);
const start = unreleased.index + unreleased[0].length;
const header = text.slice(start).match(/^## \[[^\n]*\n/);
if (!header) throw new Error('No release section after "## Unreleased".');
const at = start + header[0].length;
await writeFile(file, text.slice(0, unreleased.index) + '## Unreleased\n\n'
  + text.slice(start, at) + '\n\n### Notes\n\n' + notes + '\n\n' + text.slice(at).replace(/^\n+/, ''));
