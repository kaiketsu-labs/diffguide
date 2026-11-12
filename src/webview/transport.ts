/** The channel to the host: VS Code's webview API today. */
import type { PageMessage } from '../pullRequestOverview.js';
import type { Saved } from './state.js';

declare function acquireVsCodeApi(): { postMessage(message: PageMessage): void; getState(): unknown; setState(state: Saved): void };

export const api = acquireVsCodeApi();
export const post = (message: PageMessage): void => api.postMessage(message);
