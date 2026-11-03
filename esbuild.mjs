import { copyFile } from 'node:fs/promises';
import { build } from 'esbuild';

await build({
  entryPoints: { extension: 'src/extension.ts', channel: 'src/channel.ts', 'hook-waiter': 'src/hookWaiter.ts', 'live-connect': 'src/liveConnect.ts' },
  outdir: 'dist',
  outExtension: { '.js': '.cjs' },
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  external: ['vscode'],
  sourcemap: true,
  logLevel: 'info'
});

await build({
  entryPoints: { overview: 'src/webview/overview.ts' },
  outdir: 'dist',
  bundle: true,
  platform: 'browser',
  target: 'chrome120',
  format: 'iife',
  sourcemap: true,
  logLevel: 'info'
});

await build({
  entryPoints: { pdf: 'src/webview/pdf.ts' },
  outdir: 'dist',
  bundle: true,
  minify: true,
  platform: 'browser',
  target: 'chrome120',
  format: 'iife',
  logLevel: 'warning'
});

await copyFile('node_modules/vscode-oniguruma/release/onig.wasm', 'dist/onig.wasm');
