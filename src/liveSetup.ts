import { execFile } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import * as vscode from 'vscode';
import { record } from './connection.js';
import type { ReviewBridge } from './contracts.js';
import { readPrivateJson, writePrivateJson } from './privateFiles.js';
import { quotePosix } from './shell.js';
import { webviewStyles } from './webviewStyles.js';

/** Invoke only Claude's local plugin manager, with bounded output and no shell. */
async function pluginCommand(executable: string, args: readonly string[], cwd: string): Promise<void> {
  await new Promise<void>((done, reject) => {
    execFile(executable, ['plugin', ...args], { cwd, timeout: 45_000, maxBuffer: 128 * 1024, encoding: 'utf8' }, (error) => {
      if (error === null) done();
      else reject(new Error('Could not set up the local Claude plugin. Check the Claude version and local plugin policies.', { cause: error }));
    });
  });
}

/** Install a workspace-local plugin that can be reloaded by the original running process. */
export async function installLivePlugin(
  context: vscode.ExtensionContext, bridge: ReviewBridge, storagePath: string,
  claudePath: string, nodePath: string,
): Promise<void> {
  const version = await new Promise<string>((done, reject) => {
    execFile(claudePath, ['--version'], { encoding: 'utf8', timeout: 5_000, maxBuffer: 4096 }, (error, stdout) => {
      if (error === null) done(stdout.trim());
      else reject(new Error('Could not check the Claude version.', { cause: error }));
    });
  });
  const match = /\b(\d+)\.(\d+)\.(\d+)\s+\(Claude Code\)/u.exec(version);
  if (match === null || Number(match[1]) < 2 || (Number(match[1]) === 2 && (Number(match[2]) < 1 || (Number(match[2]) === 1 && Number(match[3]) < 280)))) {
    const found = match === null ? 'unbekannt' : `${match[1]}.${match[2]}.${match[3]}`;
    throw new Error(`Connecting a running conversation needs Claude Code 2.1.280 or newer (found: ${found}). Point "diffGuide.claudePath" at the current install.`);
  }
  const livePath = join(storagePath, 'live');
  const marketplacePath = join(livePath, 'marketplace');
  const pluginPath = join(marketplacePath, 'plugins', 'diffguide');
  const bindingPath = join(storagePath, 'selected-session.json');
  const ticketPath = join(livePath, 'connect-ticket.json');
  const connectionPath = join(livePath, 'connection.json');
  const hash = createHash('sha256').update(bridge.descriptor.workspaceRoot).digest('hex').slice(0, 12);
  const marketplace = `diffguide-${hash}`;
  await Promise.all(['.claude-plugin', 'hooks', 'skills/connect'].map(directory => mkdir(join(pluginPath, directory), { recursive: true, mode: 0o700 })));
  await mkdir(join(marketplacePath, '.claude-plugin'), { recursive: true, mode: 0o700 });
  await writePrivateJson(connectionPath, bridge.descriptor);
  await writePrivateJson(join(pluginPath, '.claude-plugin', 'plugin.json'), { name: 'diffguide', version: '0.4.12', description: 'Feedback from VS Code in this Claude conversation.' });
  await writePrivateJson(join(marketplacePath, '.claude-plugin', 'marketplace.json'), {
    name: marketplace, owner: { name: 'DiffGuide' }, plugins: [{ name: 'diffguide', source: './plugins/diffguide', description: 'Lokale VS-Code-Reviews.' }],
  });
  await writePrivateJson(join(pluginPath, '.mcp.json'), {
    mcpServers: { 'diffguide': { command: nodePath,
      args: [join(context.extensionPath, 'dist', 'channel.cjs'), '--connection', connectionPath, '--no-push'],
      env: { DIFFGUIDE_SESSION_BINDING: bindingPath },
    } },
  });
  const waiter = [nodePath, join(context.extensionPath, 'dist', 'hook-waiter.cjs'), '--connection', connectionPath].map(quotePosix).join(' ');
  await writePrivateJson(join(pluginPath, 'hooks', 'hooks.json'), {
    hooks: Object.fromEntries(['SessionStart', 'UserPromptSubmit', 'PostToolUse', 'Stop'].map(event => [event, [{ hooks: [{
      type: 'command', command: `DIFFGUIDE_SESSION_BINDING=${quotePosix(bindingPath)} ${waiter}`,
      asyncRewake: true, timeout: 86_400, statusMessage: 'Waiting for review feedback',
    }] }]])),
  });
  const connect = [nodePath, join(context.extensionPath, 'dist', 'live-connect.cjs'), '--connection', connectionPath,
    '--binding', bindingPath, '--ticket', ticketPath, '--session', '${CLAUDE_SESSION_ID}'].map(quotePosix).join(' ');
  await writeFile(join(pluginPath, 'skills', 'connect', 'SKILL.md'), `---\nname: connect\ndescription: Connect this running conversation to DiffGuide in VS Code.\ndisable-model-invocation: true\n---\n\n!\`${connect}\`\n\nIf the connection succeeded, reply briefly that DiffGuide is connected. Do not edit files. Review feedback arrives separately through the DiffGuide hooks and tools. If the command failed, report its error; never claim success.\n`, { mode: 0o600 });
  const installedPath = join(livePath, 'installed.json');
  const installed = record(await readPrivateJson(installedPath));
  // Remove the old Pair Review plugin so its hooks and tools do not run beside this one.
  await pluginCommand(claudePath, ['uninstall', `pair-review@pair-review-${hash}`, '--scope', 'local'], bridge.descriptor.workspaceRoot).catch(() => undefined);
  await pluginCommand(claudePath, ['marketplace', 'remove', `pair-review-${hash}`, '--scope', 'local'], bridge.descriptor.workspaceRoot).catch(() => undefined);
  await pluginCommand(claudePath, ['marketplace', 'add', marketplacePath, '--scope', 'local'], bridge.descriptor.workspaceRoot);
  if (installed?.version === '0.4.12') {
    await pluginCommand(claudePath, ['update', `diffguide@${marketplace}`, '--scope', 'local'], bridge.descriptor.workspaceRoot);
  } else {
    await pluginCommand(claudePath, ['install', `diffguide@${marketplace}`, '--scope', 'local'], bridge.descriptor.workspaceRoot);
  }
  await writePrivateJson(installedPath, { version: '0.4.12' });
  await writePrivateJson(ticketPath, { version: 1, workspaceRoot: bridge.descriptor.workspaceRoot, expiresAt: Date.now() + 15 * 60_000 });
}

/** Keep first-time live connection instructions small, copyable, and tied to actual readiness. */
export function showLiveConnection(bridge: ReviewBridge): vscode.WebviewPanel {
  const nonce = randomBytes(24).toString('base64');
  const panel = vscode.window.createWebviewPanel('diffGuide.liveConnection', 'Connect Claude', vscode.ViewColumn.Active, { enableScripts: true, localResourceRoots: [] });
  panel.webview.html = `<!DOCTYPE html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';"><style nonce="${nonce}">${webviewStyles}
body{padding:var(--space-24) var(--space-16)}main{max-width:460px;margin:auto}h1{font-size:18px;line-height:26px;font-weight:600;margin:0 0 var(--space-4)}p{color:var(--ink-muted);margin:0 0 var(--space-16)}.command{display:flex;align-items:center;gap:var(--space-12);margin:var(--space-8) 0;padding:var(--space-12);border:1px solid var(--line);border-radius:var(--radius-md);background:var(--surface-raised)}code{flex:1;font:12px var(--font-code);color:var(--ink)}#status{margin-top:var(--space-16);font-size:12px}</style></head><body><main><h1>Connect running Claude</h1><p>Run these in order in the Claude terminal you want.</p><div class="command"><code>/reload-plugins --force</code><button class="small" data-copy="reload">Copy</button></div><div class="command"><code>/diffguide:connect</code><button class="small" data-copy="connect">Copy</button></div><p id="status" role="status" aria-live="polite">Waiting for connection…</p><p>Connecting reloads the conversation context once.</p></main><script nonce="${nonce}">const vscode=acquireVsCodeApi();document.querySelectorAll('[data-copy]').forEach(button=>button.addEventListener('click',()=>vscode.postMessage({type:'copy',command:button.dataset.copy})));window.addEventListener('message',event=>{if(event.data.type==='state')document.getElementById('status').textContent=event.data.ready?'✓ Feedback on':'Waiting for connection…';if(event.data.type==='copied')document.querySelector('[data-copy="'+event.data.command+'"]').textContent='Copied';});vscode.postMessage({type:'ready'});</script></body></html>`;
  const state = (): void => { void panel.webview.postMessage({ type: 'state', ready: bridge.state.deliveryReady === true }); };
  const messages = panel.webview.onDidReceiveMessage((value: unknown) => {
    const message = record(value);
    if (message?.type === 'ready') state();
    if (message?.type === 'copy' && (message.command === 'reload' || message.command === 'connect')) {
      const command = message.command;
      void vscode.env.clipboard.writeText(command === 'reload' ? '/reload-plugins --force' : '/diffguide:connect')
        .then(() => panel.webview.postMessage({ type: 'copied', command }));
    }
  });
  const changed = bridge.onChange(state);
  const closed = panel.onDidDispose(() => { changed.dispose(); messages.dispose(); closed.dispose(); });
  return panel;
}
