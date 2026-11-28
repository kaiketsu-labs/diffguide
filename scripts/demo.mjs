// Opens an isolated VS Code window on this worktree's build with the demo pull request. Usage: make demo
import { spawn, spawnSync } from 'node:child_process';
import { copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { applyEdits, modify } from 'jsonc-parser';
import { bundleSampleRepository, buildSampleRepository, cleanEnvironment, quietSettings, userSettingsFolder } from './demoProfile.mjs';

const worktree = resolve('.');
const demo = join(worktree, '.demo');
// VS Code puts its IPC socket in the profile folder, and macOS caps socket paths at 103 characters, so the profile lives in a short temp path.
const userData = join(tmpdir(), `diffguide-demo-${createHash('sha256').update(worktree).digest('hex').slice(0, 8)}`);
const repo = join(demo, 'repo');

const built = spawnSync('npm', ['run', 'build'], { stdio: 'inherit', shell: process.platform === 'win32' });
if (built.status !== 0) process.exit(built.status ?? 1);

await rm(demo, { recursive: true, force: true });
await rm(userData, { recursive: true, force: true });
await mkdir(join(userData, 'User'), { recursive: true });
await mkdir(join(demo, 'extensions'), { recursive: true });
await bundleSampleRepository();
await buildSampleRepository(repo);

// The user's own settings and keybindings, so the demo looks and behaves like their editor.
const own = userSettingsFolder();
const overrides = {
  ...quietSettings,
  'diffGuide.mockPullRequests': true,
  'window.title': `DiffGuide demo · ${basename(worktree)} · \${rootName}`,
};
let settings = existsSync(join(own, 'settings.json')) ? await readFile(join(own, 'settings.json'), 'utf8') : '{}\n';
for (const [key, value] of Object.entries(overrides)) settings = applyEdits(settings, modify(settings, [key], value, { formattingOptions: { insertSpaces: true, tabSize: 2 } }));
await writeFile(join(userData, 'User/settings.json'), settings);
if (existsSync(join(own, 'keybindings.json'))) await copyFile(join(own, 'keybindings.json'), join(userData, 'User/keybindings.json'));

const child = spawn('code', [
  '--user-data-dir', userData, '--extensions-dir', join(demo, 'extensions'), `--extensionDevelopmentPath=${worktree}`,
  '--new-window', '--disable-workspace-trust', '--skip-welcome', repo,
], { stdio: 'ignore', detached: true, env: cleanEnvironment(), shell: process.platform === 'win32' });
child.on('error', (error) => { console.error(`Could not run the code command (${error.message}). In VS Code, run "Shell Command: Install 'code' command in PATH".`); process.exitCode = 1; });
child.unref();
console.log(`Demo window opening for ${basename(worktree)}. Repository: ${repo}. Profile: ${userData}`);
