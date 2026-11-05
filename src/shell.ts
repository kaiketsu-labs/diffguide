/** Quote an argument literally for Claude's POSIX terminal and command hooks. */
export function quotePosix(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

/** How long a stopped Claude gets to exit before it is killed. */
const stopGraceMs = 5000;

/** Stop a process with SIGTERM, then SIGKILL if it still runs; an interactive login shell ignores SIGTERM while it starts. */
export function stopProcess(child: { readonly exitCode: number | null; readonly signalCode: string | null; kill(signal: NodeJS.Signals): boolean }): void {
  child.kill('SIGTERM');
  setTimeout(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); }, stopGraceMs).unref();
}
