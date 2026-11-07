import { readFile } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { editedPaths, editRefusal } from './editGuard.js';

/** PreToolUse hook: `node edit-guard.cjs <folders.json>` denies edits in read-only repositories outside their worktrees. */
async function main(): Promise<void> {
  const foldersFile = process.argv[2];
  if (foldersFile === undefined) throw new Error('Usage: node edit-guard.cjs /path/to/read-only-folders.json');
  const readOnly = JSON.parse(await readFile(foldersFile, 'utf8')) as unknown;
  const folders = Array.isArray(readOnly) ? readOnly.filter((folder): folder is string => typeof folder === 'string' && isAbsolute(folder)) : [];
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  const event = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { tool_name?: unknown; tool_input?: unknown; cwd?: unknown };
  const cwd = typeof event.cwd === 'string' ? event.cwd : process.cwd();
  const reason = editedPaths(event.tool_name, event.tool_input).map((path) => editRefusal(path, cwd, folders)).find((each) => each !== undefined);
  if (reason !== undefined) process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } }));
}

main().catch((error: unknown) => {
  process.stderr.write(`DiffGuide edit guard: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(2);
});
