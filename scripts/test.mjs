import { build } from 'esbuild';
import { readdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';

const filters = process.argv.slice(2);
const tests = (await readdir('test'))
  .filter(name => name.endsWith('.test.ts'))
  .filter(name => filters.length === 0 || filters.some(filter => name.includes(filter)));
if (tests.length === 0) {
  console.error(`No test file matches: ${filters.join(', ')}`);
  process.exit(1);
}
await build({
  entryPoints: tests.map(name => `test/${name}`),
  alias: { vscode: resolve('test/fakes/vscode.ts') },
  loader: { '.md': 'text' },
  outdir: '.test-dist', bundle: true, platform: 'node', target: 'node20', format: 'cjs', logLevel: 'warning'
});
const child = spawn(process.execPath, ['--test', ...tests.map(name => `.test-dist/${name.replace(/\.ts$/, '.js')}`)], { stdio: 'inherit' });
child.on('error', error => { console.error(error); process.exitCode = 1; });
child.on('exit', code => { process.exitCode = code ?? 1; });
