import { open, realpath, unlink } from 'node:fs/promises';
import { readDescriptor, record } from './connection.js';
import { readPrivateJson, writePrivateJson } from './privateFiles.js';
import { isSessionId, readSessionBinding } from './sessionBinding.js';

/** Serialize explicit selection changes so a stale launch cannot clear a new owner. */
async function withSelectionLock(path: string, action: () => Promise<void>): Promise<void> {
  const lockPath = `${path}.lock`;
  const lock = await open(lockPath, 'wx', 0o600).catch(() => { throw new Error('A connection is being set up. Try again in a moment.'); });
  try { await action(); }
  finally {
    await lock.close();
    await unlink(lockPath);
  }
}

/** Bind the session selected by an explicit, locally invoked Claude skill. */
async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args[0] === '--release') {
    const [, connectionPath, bindingPath, expected] = args;
    if (args.length !== 4 || connectionPath === undefined || bindingPath === undefined || !isSessionId(expected)) {
      throw new Error('Invalid DiffGuide launch handoff.');
    }
    const descriptor = await readDescriptor(connectionPath);
    if (await realpath(process.cwd()) !== await realpath(descriptor.workspaceRoot)) throw new Error('The chosen project has changed.');
    await withSelectionLock(bindingPath, async () => {
      const binding = await readSessionBinding(bindingPath, descriptor.workspaceRoot);
      if (binding !== undefined && binding.sessionId !== expected) throw new Error('Another conversation was chosen in the meantime. Copy the connect command again.');
      if (binding !== undefined) await unlink(bindingPath);
    });
    return;
  }
  const fields = ['--connection', '--binding', '--ticket', '--session'];
  if (args.length !== 8 || fields.some((field, index) => args[index * 2] !== field)) throw new Error('Invalid DiffGuide connect command.');
  const [connectionPath, bindingPath, ticketPath, sessionId] = [args[1], args[3], args[5], args[7]];
  if (connectionPath === undefined || bindingPath === undefined || ticketPath === undefined || !isSessionId(sessionId)) {
    throw new Error('Claude did not supply a valid session identity.');
  }
  if (process.env['CLAUDE_CODE_SESSION_ID'] !== sessionId) {
    throw new Error('This Claude version gives no matching session ID. Update Claude, then connect again.');
  }
  const descriptor = await readDescriptor(connectionPath);
  if (await realpath(process.cwd()) !== await realpath(descriptor.workspaceRoot)) {
    throw new Error('DiffGuide belongs to another project. Connect from the matching VS Code project.');
  }
  await withSelectionLock(bindingPath, async () => {
    const existing = await readSessionBinding(bindingPath, descriptor.workspaceRoot);
    if (existing?.sessionId === sessionId) {
      process.stdout.write('DiffGuide is already connected to this conversation.\n');
      return;
    }
    const ticket = record(await readPrivateJson(ticketPath));
    if (ticket?.version !== 1 || ticket.workspaceRoot !== descriptor.workspaceRoot
      || typeof ticket.expiresAt !== 'number' || !Number.isFinite(ticket.expiresAt) || ticket.expiresAt < Date.now()) {
      throw new Error('Choose "Connect running Claude" in VS Code, then run this command again.');
    }
    if (existing !== undefined) throw new Error('Another conversation is chosen. Switch the connection in VS Code first.');
    await writePrivateJson(bindingPath, { version: 1, workspaceRoot: descriptor.workspaceRoot, sessionId });
    await unlink(ticketPath);
    process.stdout.write('DiffGuide is connected to this conversation. Feedback arrives automatically; only the human resolves threads.\n');
  });
}

void main().catch((error: unknown) => {
  process.stderr.write(`DiffGuide: ${error instanceof Error ? error.message : 'Connection failed.'}\n`);
  process.exitCode = 1;
});
