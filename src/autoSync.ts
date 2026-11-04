import * as vscode from 'vscode';

export interface Poller extends vscode.Disposable {
  /** Check now, unless VS Code is in the background, `active` is false or a check is still running. */
  readonly now: () => void;
}

/** Run `check` every `intervalMs` and when VS Code gains focus, only while it has focus and `active` holds, one at a time. */
export function pollWhileFocused(intervalMs: number, active: () => boolean, check: () => Promise<void>): Poller {
  let running = false;
  const now = (): void => {
    if (running || !vscode.window.state.focused || !active()) return;
    running = true;
    void check().catch(() => undefined).finally(() => { running = false; });
  };
  const timer = setInterval(now, intervalMs);
  timer.unref();
  const focus = vscode.window.onDidChangeWindowState((state) => { if (state.focused) now(); });
  return { now, dispose: () => { clearInterval(timer); focus.dispose(); } };
}

/** Calls of the returned function in one event-loop turn share one `load`; requests sent at the same moment read the same state. */
export function sharedPerTurn<T>(load: () => T): () => T {
  let shared: { readonly value: T } | undefined;
  return () => {
    if (shared === undefined) {
      shared = { value: load() };
      setImmediate(() => { shared = undefined; });
    }
    return shared.value;
  };
}
