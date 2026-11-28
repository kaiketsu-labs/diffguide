// Pieces shared by scripts/e2e.mjs and scripts/demo.mjs: a quiet VS Code profile and the demo sample repository.
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

/** Settings that keep a throwaway VS Code window free of prompts, updates, telemetry and AI features. */
export const quietSettings = {
  'security.workspace.trust.enabled': false, 'workbench.startupEditor': 'none', 'workbench.tips.enabled': false,
  'update.mode': 'none', 'extensions.autoUpdate': false, 'telemetry.telemetryLevel': 'off', 'window.restoreWindows': 'none',
  'chat.disableAIFeatures': true,
};

/** The user's own VS Code settings folder, per https://code.visualstudio.com/docs/editor/settings. */
export function userSettingsFolder() {
  if (process.platform === 'darwin') return join(homedir(), 'Library/Application Support/Code/User');
  if (process.platform === 'win32') return join(process.env.APPDATA ?? join(homedir(), 'AppData/Roaming'), 'Code/User');
  return join(homedir(), '.config/Code/User');
}

/** The environment for launching VS Code from inside another VS Code terminal or Electron app. */
export function cleanEnvironment() {
  const env = { ...process.env };
  delete env.VSCODE_CLI;
  delete env.ELECTRON_RUN_AS_NODE;
  return env;
}

export const sampleRecipe = resolve('demo/sample-repo');
export const sampleBundle = resolve('.render/demo-repo.cjs');

/** Bundle the TypeScript recipe that builds the sample repository, so plain Node (and Docker) can run it. */
export async function bundleSampleRepository() {
  const { build } = await import('esbuild');
  await build({ entryPoints: ['src/forges/demo/sampleRepo.ts'], outfile: sampleBundle, bundle: true, platform: 'node', format: 'cjs', logLevel: 'error' });
}

/** Build the sample repository at `root` (with `origin.git` beside it) and return its commit ids. */
export function buildSampleRepository(root) {
  return createRequire(import.meta.url)(sampleBundle).buildSampleRepository(sampleRecipe, root);
}
