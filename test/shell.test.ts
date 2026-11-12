import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import test from 'node:test';
import { stopProcess } from '../src/core/shell.js';

const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch { return false; } };

test('stopping a run started through a shell function also stops the program the shell is waiting on', { skip: process.platform === 'win32' }, async () => {
  const child = spawn('/bin/sh', ['-c', 'run() { sleep "$@"; return; }; run 30 >/dev/null & echo $!; wait'], { stdio: ['ignore', 'pipe', 'ignore'], detached: true });
  const program = Number(await new Promise<string>((resolve) => { child.stdout.once('data', (chunk: Buffer) => { resolve(chunk.toString().trim()); }); }));
  assert.ok(alive(program));
  stopProcess(child);
  await new Promise((resolve) => setTimeout(resolve, 500));
  const stillRunning = alive(program);
  if (stillRunning) process.kill(program, 'SIGKILL');
  assert.equal(stillRunning, false);
});
