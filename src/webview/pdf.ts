import * as pdfjs from 'pdfjs-dist';
// @ts-expect-error pdf.js ships no types for its worker build.
import { WorkerMessageHandler } from 'pdfjs-dist/build/pdf.worker.mjs';

/**
 * pdf.js for the review page, loaded only when a PR changes a PDF.
 * The worker code runs on the page itself: a webview cannot start a module worker from its resource origin.
 */
Object.assign(globalThis, { pdfjsWorker: { WorkerMessageHandler }, pdfjsLib: pdfjs });
