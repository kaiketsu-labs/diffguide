// Runs on a worker thread: colors code with its own highlighter and posts the markup back.
import { parentPort, workerData } from 'node:worker_threads';
import type { HighlightJob, HighlightResult, HighlightWorkerData } from './highlightPool.js';
import { TextMateHighlighter } from './textMateHighlighter.js';

const { contributions, theme, wasmPath } = workerData as HighlightWorkerData;
const highlighter = new TextMateHighlighter(contributions, theme, wasmPath);

parentPort?.on('message', ({ id, sources }: HighlightJob) => {
  void highlighter.prepare(sources.map((source) => source.filePath)).then(() => {
    const html = sources.map(({ code, filePath }) => {
      try { return highlighter.highlight(code, filePath); } catch { return undefined; }
    });
    parentPort?.postMessage({ id, html } satisfies HighlightResult);
  });
});
