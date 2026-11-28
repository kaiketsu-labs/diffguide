import { createDemoForge } from './demo/fakeForge.js';

/** The demo forge behind the `diffGuide.mockPullRequests` setting; its writes live in memory until the window closes. */
export const mockPullRequestProvider = createDemoForge();
