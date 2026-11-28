// Opens an isolated VS Code window on this worktree's build with the demo pull request. Usage: make demo
import { spawn, spawnSync } from 'node:child_process';
import { copyFile, cp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { applyEdits, modify, parse } from 'jsonc-parser';
import { bundleSampleRepository, buildSampleRepository, cleanEnvironment, quietSettings, userSettingsFolder } from './demoProfile.mjs';

const worktree = resolve('.');
const demo = join(worktree, '.demo');
// VS Code puts its IPC socket in the profile folder, and macOS caps socket paths at 103 characters, so the profile lives in a short temp path.
const userData = join(tmpdir(), `diffguide-demo-${createHash('sha256').update(worktree).digest('hex').slice(0, 8)}`);
const repo = join(demo, 'repo');
// The seeded PR in src/forges/demo/fixture.ts, which the window opens on start.
const demoPullRequest = 'https://github.com/acme/field-notes/pull/142';

const built = spawnSync('npm', ['run', 'build'], { stdio: 'inherit', shell: process.platform === 'win32' });
if (built.status !== 0) process.exit(built.status ?? 1);

// An open demo window loads the new build on reload; wiping its profile under it would break it.
const running = process.platform !== 'win32' && spawnSync('pgrep', ['-f', userData]).status === 0;
if (running) {
  console.log(`A demo window for ${basename(worktree)} is open. Reload it (Developer: Reload Window) to load the new build.`);
  process.exit(0);
}

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

// Themes come from extensions, and the demo starts with none, so copy only the ones the user's theme settings name.
const themeKinds = { 'workbench.colorTheme': 'themes', 'workbench.iconTheme': 'iconThemes', 'workbench.productIconTheme': 'productIconThemes' };
const chosen = parse(settings) ?? {};
const ownExtensions = join(homedir(), '.vscode/extensions');
for (const name of existsSync(ownExtensions) ? await readdir(ownExtensions) : []) {
  const manifest = join(ownExtensions, name, 'package.json');
  if (!existsSync(manifest)) continue;
  const contributes = JSON.parse(await readFile(manifest, 'utf8')).contributes ?? {};
  const provides = Object.entries(themeKinds).some(([setting, kind]) => (contributes[kind] ?? []).some((theme) => [theme.id, theme.label].includes(chosen[setting])));
  if (provides) await cp(join(ownExtensions, name), join(demo, 'extensions', name), { recursive: true });
}
if (existsSync(join(own, 'keybindings.json'))) await copyFile(join(own, 'keybindings.json'), join(userData, 'User/keybindings.json'));

const codeArguments = [
  '--user-data-dir', userData, '--extensions-dir', join(demo, 'extensions'), `--extensionDevelopmentPath=${worktree}`,
  '--new-window', '--disable-workspace-trust', '--skip-welcome', repo,
];
const frontProcess = () => /pid\s*=\s*(\d+)/u.exec(spawnSync('lsappinfo', ['info', '-only', 'pid', spawnSync('lsappinfo', ['front']).stdout.toString().trim()]).stdout.toString())?.[1];
const demoProcesses = () => new Set(spawnSync('pgrep', ['-f', userData]).stdout.toString().split('\n').filter(Boolean));
const activate = (pid) => spawnSync('osascript', ['-l', 'JavaScript', '-e', `ObjC.import('AppKit'); $.NSRunningApplication.runningApplicationWithProcessIdentifier(${pid}).activateWithOptions(0)`]);
const previous = process.platform === 'darwin' ? frontProcess() : undefined;
// VS Code brings a new window to the front even when started with `open -g`, so focus goes back to the app the user was in.
const child = process.platform === 'darwin'
  ? spawn('open', ['-g', '-n', '-a', 'Visual Studio Code', '--env', `DIFFGUIDE_DEMO_PR=${demoPullRequest}`, '--args', ...codeArguments], { stdio: 'ignore', detached: true })
  : spawn('code', codeArguments, { stdio: 'ignore', detached: true, env: { ...cleanEnvironment(), DIFFGUIDE_DEMO_PR: demoPullRequest }, shell: process.platform === 'win32' });
child.on('error', (error) => { console.error(`Could not run the code command (${error.message}). In VS Code, run "Shell Command: Install 'code' command in PATH".`); process.exitCode = 1; });
child.unref();
if (previous !== undefined) {
  const started = Date.now();
  let givenBack;
  while (Date.now() - started < 45_000 && (givenBack === undefined || Date.now() - givenBack < 5_000)) {
    await new Promise((done) => { setTimeout(done, 250); });
    const front = frontProcess();
    if (front !== undefined && front !== previous && demoProcesses().has(front)) { activate(previous); givenBack = Date.now(); }
  }
}
console.log(`Demo window opening in the background for ${basename(worktree)}. Repository: ${repo}. Profile: ${userData}`);
