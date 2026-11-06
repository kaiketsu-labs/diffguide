/** Quote an argument literally for Claude's POSIX terminal and command hooks. */
export function quotePosix(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

/** How long a stopped Claude gets to exit before it is killed. */
const stopGraceMs = 5000;

/**
 * Stop a process with SIGTERM, then SIGKILL if it still runs; an interactive login shell ignores SIGTERM while it starts.
 * A child spawned `detached` leads its own process group, which is signalled whole: a `claude` shell function keeps
 * the shell as Claude's parent, and signalling only the shell would leave Claude running.
 */
export function stopProcess(child: { readonly pid?: number | undefined; readonly exitCode: number | null; readonly signalCode: string | null; kill(signal: NodeJS.Signals): boolean }): void {
  const signal = (name: NodeJS.Signals): void => {
    if (child.pid === undefined) { child.kill(name); return; }
    try { process.kill(-child.pid, name); } catch { child.kill(name); }
  };
  signal('SIGTERM');
  setTimeout(() => { if (child.pid !== undefined || (child.exitCode === null && child.signalCode === null)) signal('SIGKILL'); }, stopGraceMs).unref();
}
