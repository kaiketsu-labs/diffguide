import assert from 'node:assert/strict';
import test from 'node:test';

import { orbLoader, orbLoaderStyles } from '../src/orbLoader.js';

test('every orb frame fits inside its animation canvas', () => {
  const { width, height, frames } = orbLoader;
  for (const { art, y } of frames) {
    assert.ok(y >= 0 && y + art.length <= height);
    assert.ok(art.every(row => row.length === width));
  }
});

test('steps the orb sprite once per frame on the working chip', () => {
  const styles = orbLoaderStyles();
  const total = orbLoader.frames.reduce((sum, frame) => sum + frame.ms, 0);
  assert.match(styles, /^\.chip\.working::before\{width:10px;height:11px;/);
  assert.match(styles, new RegExp(`animation:orb ${total}ms step-end infinite`));
  assert.match(styles, /orb\{0%\{mask-position:0% 0\}.*\{mask-position:100% 0\}\}/);
  assert.match(styles, /prefers-reduced-motion:reduce\)\{[^}]*\{animation:none\}/);
});
