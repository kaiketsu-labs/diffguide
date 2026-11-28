# field-notes

Plain-text notes with tags, kept in one JSON file.

## Usage

```ts
import { openStore } from './src/index.js';

const store = await openStore('notes.json');
await store.add({ title: 'Standup', body: 'Ship the sidebar.', tags: ['work'] });
console.log(await store.list());
```

## Storage

Notes live in a single JSON file. Every write rewrites the whole file, so keep
the note count in the low thousands.
