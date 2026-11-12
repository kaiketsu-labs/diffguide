import { mkdir, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import * as vscode from 'vscode';
import { listClaudeConversations } from '../../agents/claude/claudeSessions.js';
import type { ClaudeChoice, ClaudeConversation } from '../../core/agent.js';
import type { ReviewBridge } from '../../core/contracts.js';
import { requireNodeRuntime, resolveExecutable } from '../../core/executables.js';
import { readPrivateJson, writePrivateJson } from '../../core/privateFiles.js';
import { readSessionBinding } from '../../core/sessionBinding.js';
import { quotePosix } from '../../core/shell.js';
import { installLivePlugin, showLiveConnection } from './liveSetup.js';

export { quotePosix } from '../../core/shell.js';

const reviewTerminalName = 'Claude · DiffGuide';

/** Quote terminal arguments without interpreting user-configured executable paths. */
function terminalCommand(executable: string, args: readonly string[]): string {
  return [executable, ...args].map(quotePosix).join(' ');
}

/** Reuse this project's managed terminal when VS Code reloads the extension host. */
function existingReviewTerminal(
  workspaceRoot: string, inactiveTerminals: WeakSet<vscode.Terminal>, name: string,
): vscode.Terminal | undefined {
  return vscode.window.terminals.findLast((candidate) => {
    const options = candidate.creationOptions;
    if (options.name !== name || candidate.exitStatus !== undefined || inactiveTerminals.has(candidate)) return false;
    const cwd = 'cwd' in options ? options.cwd : undefined;
    const path = typeof cwd === 'string' ? cwd : cwd?.scheme === 'file' ? cwd.fsPath : undefined;
    return path !== undefined && resolve(path) === resolve(workspaceRoot);
  });
}

/** Generate session-scoped integration files without changing Claude user settings. */
export async function prepareConnection(
  context: vscode.ExtensionContext,
  bridge: ReviewBridge,
  storagePath: string,
  runtimeNodePath?: string,
): Promise<{ readonly mcpPath: string; readonly hooksPath: string; readonly transport: 'hooks' | 'channels' }> {
  await mkdir(storagePath, { recursive: true, mode: 0o700 });
  const configuration = vscode.workspace.getConfiguration('diffGuide');
  const nodePath = runtimeNodePath ?? configuration.get<string>('nodePath', 'node');
  const transport = configuration.get<string>('transport', 'hooks') === 'channels' ? 'channels' : 'hooks';
  const connectionPath = join(storagePath, 'connection.json');
  const mcpPath = join(storagePath, 'mcp.json');
  const hooksPath = join(storagePath, 'hooks.json');
  const channelPath = join(context.extensionPath, 'dist', 'channel.cjs');
  const waiterPath = join(context.extensionPath, 'dist', 'hook-waiter.cjs');
  await writePrivateJson(connectionPath, bridge.descriptor);
  const liveConnection = join(storagePath, 'live', 'connection.json');
  if (await readPrivateJson(liveConnection) !== undefined) await writePrivateJson(liveConnection, bridge.descriptor);
  await writePrivateJson(mcpPath, {
    mcpServers: {
      'diffguide': {
        command: nodePath,
        args: [channelPath, '--connection', connectionPath, ...(transport === 'hooks' ? ['--no-push'] : [])],
      },
    },
  });
  const waiterCommand = [nodePath, waiterPath, '--connection', connectionPath].map(quotePosix).join(' ');
  const waiter = { type: 'command', command: waiterCommand, asyncRewake: true, timeout: 86_400, statusMessage: 'Waiting for review feedback' };
  await writePrivateJson(hooksPath, {
    hooks: Object.fromEntries(['SessionStart', 'UserPromptSubmit', 'PostToolUse', 'Stop'].map(event => [event, [{ hooks: [waiter] }]])),
  });
  return { mcpPath, hooksPath, transport };
}

/** Select a conversation without guessing which recent session created the code. */
async function selectConversation(workspaceRoot: string, includeRunning = true): Promise<boolean | string | undefined> {
  const choices = [
    {
      label: 'Resume a conversation', description: 'Continue an earlier conversation', resume: true as boolean | 'running',
      detail: 'Search by name or branch; running conversations are detected.',
    },
    { label: 'New conversation', description: 'Start with an empty conversation', resume: false },
  ];
  if (includeRunning) choices.push({ label: 'Connect running Claude', description: 'Stay in your open Claude',
    detail: '/diffguide:connect connects the conversation you run it in.', resume: 'running' });
  const selection = await vscode.window.showQuickPick(choices, {
    title: 'Connect Claude Code', placeHolder: 'Connect running Claude, resume a conversation or start a new one', matchOnDescription: true,
  });
  if (selection?.resume !== true) return selection?.resume;
  const sessions = await listClaudeConversations(workspaceRoot).catch(() => []);
  if (sessions.length === 0) return true;
  const rows = sessions.map(session => ({ label: session.title,
    description: `${session.running ? 'Running · ' : ''}${new Date(session.modifiedAt).toLocaleString()}${session.branch ? ` · ${session.branch}` : ''}`,
    detail: session.running ? 'Connect in its original process.' : `Keeps context · ${session.id.slice(0, 8)}`,
    value: session.running ? 'running' : session.id,
  }));
  const chosen = await vscode.window.showQuickPick([...rows, { label: 'All conversations…', description: 'Open the Claude picker', detail: '', value: 'picker' }], {
    title: 'Resume a conversation', placeHolder: 'Search by name or branch', matchOnDescription: true,
  });
  return chosen?.value === 'picker' ? true : chosen?.value;
}

/** Prepare the same private review connection for either terminal location. */
async function prepareClaudeCommand(
  context: vscode.ExtensionContext, bridge: ReviewBridge, storagePath: string, resume: boolean | string,
): Promise<string> {
  const configuration = vscode.workspace.getConfiguration('diffGuide');
  const [executable, nodePath] = await Promise.all([
    resolveExecutable(configuration.get<string>('claudePath', 'claude'), bridge.descriptor.workspaceRoot),
    resolveExecutable(configuration.get<string>('nodePath', 'node'), bridge.descriptor.workspaceRoot),
  ]);
  await requireNodeRuntime(nodePath);
  const prepared = await prepareConnection(context, bridge, storagePath, nodePath);
  const args = ['--mcp-config', prepared.mcpPath];
  if (prepared.transport === 'hooks') args.push('--settings', prepared.hooksPath);
  else args.push('--dangerously-load-development-channels', 'server:diffguide');
  if (resume) args.push('--resume');
  if (typeof resume === 'string') args.push(resume);
  const launch = terminalCommand(executable, args);
  const bindingPath = join(storagePath, 'selected-session.json');
  const binding = await readSessionBinding(bindingPath, bridge.descriptor.workspaceRoot);
  if (binding === undefined) return launch;
  const release = terminalCommand(nodePath, [join(context.extensionPath, 'dist', 'live-connect.cjs'), '--release',
    join(storagePath, 'connection.json'), bindingPath, binding.sessionId]);
  return `${release} && ${launch}`;
}

/** Claude connection actions for one review session. */
export interface ClaudeLauncher extends vscode.Disposable {
  start(): Promise<void>;
  copyCommand(): Promise<void>;
  connectRunning(): Promise<void>;
  /** Whether this session's review terminal is open. */
  readonly hasTerminal: boolean;
  /** Fires when the review terminal opens or closes. */
  readonly onDidChange: vscode.Event<void>;
  /** Recent conversations of this session's folder, for the page's Resume list. */
  conversations(): Promise<readonly ClaudeConversation[]>;
  /** Act on a choice from the review page; returns a notice for the page, and throws instead of showing VS Code messages. */
  connect(choice: ClaudeChoice): Promise<string | undefined>;
}

/** Another conversation still receives comments, so a new one must wait; commands report it as information, not as a failure. */
class ReceiverConflict extends Error {}

const copiedNotice = 'Command copied. Run it in a terminal; exit a running Claude there first.';

/** Connect a chosen or new conversation for one session, or copy its command for a separate terminal. */
export function createClaudeLauncher(
  context: vscode.ExtensionContext,
  bridge: ReviewBridge,
  storagePath: string,
  terminalName = reviewTerminalName,
): ClaudeLauncher {
  const inactiveTerminals = new WeakSet<vscode.Terminal>();
  const changed = new vscode.EventEmitter<void>();
  let terminal: vscode.Terminal | undefined = existingReviewTerminal(bridge.descriptor.workspaceRoot, inactiveTerminals, terminalName);
  let launching = false;
  const closed = vscode.window.onDidCloseTerminal(closedTerminal => {
    inactiveTerminals.add(closedTerminal);
    if (terminal === closedTerminal) { terminal = undefined; changed.fire(); }
  });
  const ended = vscode.window.onDidEndTerminalShellExecution(event => {
    inactiveTerminals.add(event.terminal);
    if (event.terminal === terminal) { terminal = undefined; changed.fire(); }
  });
  const isLive = (candidate: vscode.Terminal | undefined): candidate is vscode.Terminal => candidate !== undefined
    && !inactiveTerminals.has(candidate) && candidate.exitStatus === undefined && vscode.window.terminals.includes(candidate);
  const liveTerminal = (): vscode.Terminal | undefined => {
    if (!isLive(terminal)) terminal = existingReviewTerminal(bridge.descriptor.workspaceRoot, inactiveTerminals, terminalName);
    return terminal;
  };
  /** Why a new receiver must wait: another conversation outside the review terminal still receives comments. */
  const receiverConflict = (ownedTerminal: vscode.Terminal | undefined): string | undefined => {
    if (bridge.state.deliveryReady !== true || isLive(ownedTerminal)) return undefined;
    return 'The review connection is still active or closing. If Claude is still running, type /exit. The status updates within 45 seconds.';
  };
  const requireNoConflict = (ownedTerminal: vscode.Terminal | undefined): void => {
    const conflict = receiverConflict(ownedTerminal);
    if (conflict !== undefined) throw new ReceiverConflict(conflict);
  };
  /** Run one connection action at a time; a second one while it runs is dropped. */
  const exclusive = async (action: () => Promise<string | undefined>): Promise<string | undefined> => {
    if (launching) return undefined;
    launching = true;
    try {
      if (process.platform === 'win32') {
        throw new Error('Connecting Claude works on macOS and Linux for now. Windows support needs its own testing first.');
      }
      return await action();
    } finally {
      launching = false;
    }
  };
  /** For commands without a page: problems become VS Code messages. */
  const guarded = (action: () => Promise<void>) => async (): Promise<void> => {
    try {
      await exclusive(async () => { await action(); return undefined; });
    } catch (error: unknown) {
      if (error instanceof ReceiverConflict) void vscode.window.showInformationMessage(error.message);
      else void vscode.window.showErrorMessage(`DiffGuide: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
  const forgetSelectedSession = async (): Promise<void> => {
    await unlink(join(storagePath, 'selected-session.json')).catch((error: unknown) => {
      if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error;
    });
  };
  /** Install the plugin a running Claude loads to connect itself; that conversation then runs `/diffguide:connect`. */
  const prepareRunning = async (): Promise<void> => {
    requireNoConflict(undefined);
    const configuration = vscode.workspace.getConfiguration('diffGuide');
    const [executable, nodePath] = await Promise.all([
      resolveExecutable(configuration.get<string>('claudePath', 'claude'), bridge.descriptor.workspaceRoot),
      resolveExecutable(configuration.get<string>('nodePath', 'node'), bridge.descriptor.workspaceRoot),
    ]);
    await requireNodeRuntime(nodePath);
    await installLivePlugin(context, bridge, storagePath, executable, nodePath);
    if (receiverConflict(undefined) !== undefined) {
      await unlink(join(storagePath, 'live', 'connect-ticket.json')).catch(() => undefined);
      requireNoConflict(undefined);
    }
    await forgetSelectedSession();
  };
  const connectRunning = async (): Promise<void> => {
    await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Connecting running Claude' }, prepareRunning);
    context.subscriptions.push(showLiveConnection(bridge));
  };
  /** Start Claude in the review terminal, replacing the conversation that runs there. */
  const launch = async (resume: boolean | string): Promise<void> => {
    const replaceTerminal = liveTerminal();
    requireNoConflict(replaceTerminal);
    const command = await prepareClaudeCommand(context, bridge, storagePath, resume);
    requireNoConflict(replaceTerminal);
    await forgetSelectedSession();
    if (isLive(replaceTerminal)) {
      inactiveTerminals.add(replaceTerminal);
      replaceTerminal.dispose();
    }
    terminal = vscode.window.createTerminal({ name: terminalName, cwd: bridge.descriptor.workspaceRoot });
    terminal.show();
    terminal.sendText(command);
    changed.fire();
  };
  const copy = async (resume: boolean | string): Promise<void> => {
    const command = await prepareClaudeCommand(context, bridge, storagePath, resume);
    await vscode.env.clipboard.writeText(`cd ${quotePosix(bridge.descriptor.workspaceRoot)} && ${command}`);
  };
  const start = guarded(async () => {
    const currentTerminal = liveTerminal();
    const conflict = receiverConflict(currentTerminal);
    if (conflict !== undefined) {
      void vscode.window.showInformationMessage(conflict);
      return;
    }
    if (currentTerminal !== undefined) {
      const show = { label: 'Show terminal', description: 'Open the current conversation', restart: false };
      const restart = {
        label: bridge.state.deliveryReady === true ? 'Switch conversation' : 'Restart connection',
        description: 'Close the current review terminal',
        detail: 'Then resume a conversation or start a new one.', restart: true,
      };
      const action = await vscode.window.showQuickPick(bridge.state.deliveryReady === true ? [show, restart] : [restart, show], {
        title: bridge.state.deliveryReady === true ? 'Claude Code is connected' : 'Restore delivery',
      });
      if (action === undefined) return;
      if (!action.restart) {
        if (isLive(currentTerminal)) currentTerminal.show();
        return;
      }
    }
    const resume = await selectConversation(bridge.descriptor.workspaceRoot);
    if (resume === undefined) return;
    if (resume === 'running') await connectRunning();
    else await launch(resume);
  });
  const copyCommand = guarded(async () => {
    const resume = await selectConversation(bridge.descriptor.workspaceRoot, false);
    if (resume === undefined) return;
    if (resume === 'running') {
      await connectRunning();
      return;
    }
    await copy(resume);
    void vscode.window.showInformationMessage('Command copied. Run it at a shell prompt; exit any running Claude with /exit first.');
  });
  const connect = (choice: ClaudeChoice): Promise<string | undefined> => exclusive(async () => {
    switch (choice.how) {
      case 'show': {
        const current = liveTerminal();
        if (current === undefined) throw new Error('The review terminal is closed. Start or resume a conversation.');
        current.show();
        return undefined;
      }
      case 'new': await launch(false); return undefined;
      case 'resume': await launch(choice.session ?? true); return undefined;
      case 'running': await prepareRunning(); return undefined;
      case 'copy': await copy(false); return copiedNotice;
    }
  });
  return {
    start, copyCommand, connectRunning: guarded(connectRunning), connect,
    get hasTerminal() { return liveTerminal() !== undefined; },
    onDidChange: changed.event,
    conversations: () => listClaudeConversations(bridge.descriptor.workspaceRoot),
    dispose: () => { closed.dispose(); ended.dispose(); changed.dispose(); },
  };
}

/** Register the Claude commands; they act on the session `pick` names, or this window's local changes. */
export function registerClaudeLauncher(
  context: vscode.ExtensionContext,
  bridge: ReviewBridge,
  storagePath: string,
  pick: () => ClaudeLauncher | undefined = () => undefined,
): vscode.Disposable & { readonly local: ClaudeLauncher } {
  const local = createClaudeLauncher(context, bridge, storagePath);
  const target = (): ClaudeLauncher => pick() ?? local;
  const registrations = vscode.Disposable.from(
    local,
    vscode.commands.registerCommand('diffGuide.startClaude', () => target().start()),
    vscode.commands.registerCommand('diffGuide.copyClaudeCommand', () => target().copyCommand()),
    vscode.commands.registerCommand('diffGuide.connectRunningClaude', () => target().connectRunning()),
  );
  return { local, dispose: () => { registrations.dispose(); } };
}
