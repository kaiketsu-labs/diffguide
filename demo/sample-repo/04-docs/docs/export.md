# Exporting notes

`store.exportTo(file)` writes every note to `file` as newline-delimited JSON:
one note per line, oldest first.

```ts
const count = await store.exportTo('backup.ndjson');
console.log(`Exported ${count} notes`);
```

## Options

| Option      | Default | Meaning                                         |
| ----------- | ------- | ----------------------------------------------- |
| `tag`       | none    | Export only notes that carry this tag.          |
| `batchSize` | 200     | Notes written before the stream waits for disk. |

## Reading an export

Each line is a complete JSON document, so you can process a large export
without loading it whole:

```sh
head -n 3 backup.ndjson | jq .title
```

> Exports are plain text. Keep them out of shared folders if your notes are private.
