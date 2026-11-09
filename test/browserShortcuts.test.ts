import assert from 'node:assert/strict';
import test from 'node:test';
import { blockBrowserShortcutsScript } from '../src/browserShortcuts.js';

type Key = { key: string; ctrlKey?: boolean; metaKey?: boolean; shiftKey?: boolean; altKey?: boolean };

/** Run the embedded page script against a fake window and report whether a keydown was blocked. */
function blocked(key: Key): boolean {
  let listener: ((event: unknown) => void) | undefined;
  const fakeWindow = { addEventListener: (_type: string, handler: (event: unknown) => void) => { listener = handler; } };
  new Function('window', blockBrowserShortcutsScript)(fakeWindow);
  let prevented = false;
  listener?.({ ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, ...key, preventDefault: () => { prevented = true; } });
  return prevented;
}

test('blocks the browser defaults for Ctrl/Cmd+J and Ctrl/Cmd+Shift+J', () => {
  assert.equal(blocked({ key: 'j', ctrlKey: true }), true);
  assert.equal(blocked({ key: 'J', ctrlKey: true, shiftKey: true }), true);
  assert.equal(blocked({ key: 'j', metaKey: true }), true);
  assert.equal(blocked({ key: 'J', metaKey: true, shiftKey: true }), true);
});

test('leaves typing and other shortcuts to the browser', () => {
  assert.equal(blocked({ key: 'j' }), false);
  assert.equal(blocked({ key: 'J', shiftKey: true }), false);
  assert.equal(blocked({ key: 'j', ctrlKey: true, altKey: true }), false);
  assert.equal(blocked({ key: 'c', ctrlKey: true }), false);
});
