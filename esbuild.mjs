import { copyFile } from 'node:fs/promises';
import { build } from 'esbuild';

await build({
  entryPoints: { extension: 'src/hosts/vscode/extension.ts', channel: 'src/agents/claude/channel.ts', 'hook-waiter': 'src/agents/claude/hookWaiter.ts', 'edit-guard': 'src/agents/claude/editGuardHook.ts', 'live-connect': 'src/agents/claude/liveConnect.ts', 'highlight-worker': 'src/hosts/vscode/highlightWorker.ts' },
  outdir: 'dist',
  outExtension: { '.js': '.cjs' },
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  external: ['vscode'],
  loader: { '.md': 'text' },
  sourcemap: true,
  logLevel: 'info'
});

await build({
  entryPoints: { overview: 'src/page/webview/main.ts' },
  outdir: 'dist',
  bundle: true,
  platform: 'browser',
  target: 'chrome120',
  format: 'iife',
  loader: { '.md': 'text' },
  sourcemap: true,
  logLevel: 'info'
});

await build({
  entryPoints: { pdf: 'src/page/webview/pdf.ts' },
  outdir: 'dist',
  bundle: true,
  minify: true,
  loader: { '.md': 'text' },
  platform: 'browser',
  target: 'chrome120',
  format: 'iife',
  logLevel: 'warning'
});

await copyFile('node_modules/vscode-oniguruma/release/onig.wasm', 'dist/onig.wasm');
