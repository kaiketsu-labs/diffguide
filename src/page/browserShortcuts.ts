/**
 * Keeps the browser from acting on Ctrl/Cmd+J (Downloads) and Ctrl/Cmd+Shift+J (DevTools console) while a
 * DiffGuide page has focus in VS Code for the Web. VS Code still receives the key and runs its own binding.
 * Self-contained, so inline page scripts can embed it from its source text.
 */
export function blockBrowserShortcuts(): void {
  window.addEventListener('keydown', (event) => {
    if ((event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === 'j') event.preventDefault();
  });
}

/** `blockBrowserShortcuts` as a statement for pages whose script is an inline string. */
export const blockBrowserShortcutsScript = `(${blockBrowserShortcuts.toString()})();`;
