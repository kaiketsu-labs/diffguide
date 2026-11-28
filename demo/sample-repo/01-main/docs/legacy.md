# Importing v1 notes

Version 1 stored notes as `{ id, name, text, saved }` in `notes.dat`.

1. Export the file with the v1 app (Settings, then Export).
2. Pass the parsed JSON to `importLegacy`.
3. Add each result with `store.add`.

Version 1 is no longer supported. This page stays until 3.0.
