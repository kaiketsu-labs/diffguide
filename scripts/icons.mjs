import { createHash } from 'node:crypto';
import { mkdtemp, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { build } from 'esbuild';

/** Icons VS Code draws itself, as `$(diffguide-<name>)`. Each keeps its code point once shipped, so add new ones at the end. */
const native = ['orb', 'orbAsleep', 'orbAway', 'mark', 'inbox', 'outbox', 'stack', 'repository', 'bookmark', 'bookmarkFilled', 'search', 'filter', 'filterActive', 'refresh'];

const bundle = await build({ entryPoints: ['src/icons.ts'], bundle: true, format: 'cjs', platform: 'node', write: false, logLevel: 'warning' });
const module = { exports: {} };
new Function('module', 'exports', bundle.outputFiles[0].text)(module, module.exports);
const { icons } = module.exports;

// VS Code caches an icon font by path, so a changed font needs a new name.
const hash = createHash('sha256').update(JSON.stringify(native.map((name) => icons[name]))).digest('hex').slice(0, 8);
const fontPath = `resources/diffguide-icons-${hash}.woff`;
const dir = await mkdtemp(join(tmpdir(), 'diffguide-icons-'));
try {
  for (const name of native) {
    const svg = icons[name];
    if (svg === undefined) throw new Error(`src/icons.ts has no icon "${name}"`);
    await writeFile(join(dir, `${name}.svg`), svg.replace('<svg ', '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" ').replace(/ (aria-hidden|shape-rendering)="[^"]*"/g, ''));
  }
  const python = spawnSync('uv', ['run', '-q', '--with', 'fonttools==4.68.0', '--with', 'picosvg==0.23.0', 'python', '-I', 'scripts/iconFont.py', dir, join(dir, 'font.woff'), ...native], { stdio: 'inherit' });
  if (python.status !== 0) throw new Error('scripts/iconFont.py failed');
  for (const old of (await readdir('resources')).filter((name) => /^diffguide-icons.*\.woff$/.test(name))) await rm(join('resources', old));
  await rename(join(dir, 'font.woff'), fontPath);
} finally {
  await rm(dir, { recursive: true, force: true });
}

const toId = (name) => 'diffguide-' + name.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase());
const manifest = JSON.parse(await readFile('package.json', 'utf8'));
manifest.contributes.icons = Object.fromEntries(native.map((name, index) => [toId(name), {
  description: `DiffGuide ${name.replace(/[A-Z]/g, (c) => ' ' + c.toLowerCase())}`,
  default: { fontPath: './' + fontPath, fontCharacter: '\\' + (0xe000 + index).toString(16).toUpperCase() },
}]));
await writeFile('package.json', JSON.stringify(manifest, null, 2) + '\n');
console.log(`Built ${native.length} icons: ${native.map(toId).join(', ')}`);
