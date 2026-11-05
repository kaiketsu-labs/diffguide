import assert from 'node:assert/strict';
import test from 'node:test';

import { clawdLoaders, clawdLoaderStyles, clawdPoseStyles } from '../src/clawdLoader.js';

test('every Clawd frame fits inside its animation canvas', () => {
  for (const { width, height, frames } of clawdLoaders) {
    for (const { art, x = 0, y } of frames) {
      assert.ok(y >= 0 && y + art.length <= height);
      assert.ok(art.every(row => x >= 0 && x + row.length <= width));
    }
  }
});

test('picks one Clawd animation at random and steps its sprite once per frame', () => {
  const styles = clawdLoaderStyles(() => 0.99);
  const typing = clawdLoaders.at(-1)!;
  assert.match(styles, new RegExp(`width:${typing.width}px;height:${typing.height}px`));
  assert.match(styles, new RegExp(`animation:clawd ${typing.frames.reduce((sum, frame) => sum + frame.ms, 0)}ms step-end`));
  assert.equal(styles.match(/mask-position/g)?.length, typing.frames.length);
  assert.match(styles, /clawd\{0%\{mask-position:0% 0\}.*\{mask-position:100% 0\}\}/);
});

test('draws Claude\'s avatar Clawd standing, with crouch and air frames for its hop', () => {
  const styles = clawdPoseStyles();
  assert.match(styles, /\.clawd-pose\{width:12px;height:10px;.*0 0\/300% 100% no-repeat\}/);
  assert.match(styles, /\[data-pose=crouch\]\{mask-position:50% 0\}.*\[data-pose=air\]\{mask-position:100% 0\}/);
});
