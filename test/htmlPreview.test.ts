import assert from 'node:assert/strict';
import test from 'node:test';

import { htmlPreview } from '../src/htmlPreview.js';

test('an HTML file gets source lines on each element, a frame marker, and no scripts or inline handlers', () => {
  const { html, marker } = htmlPreview('<!doctype html>\n<html><head><title>T</title></head>\n<body>\n<p onclick="steal()">a\nb</p>\n<script>bad()</script>\n<template><b>x</b></template>\n</body></html>\n');
  assert.match(html, /<p data-lr-lines="4-5">a\nb<\/p>/u);
  assert.match(html, /<title data-lr-lines="2-2">/u);
  assert.match(html, new RegExp(`<head><!--${marker}--><title`, 'u'));
  assert.match(html, /<b data-lr-lines="7-7">x<\/b>/u);
  assert.doesNotMatch(html, /<script|onclick|<body data-lr/u);
});

test('an HTML file with scripts also comes with them kept and marked for the page nonce', () => {
  const { html, marker, scripted } = htmlPreview('<html><head><script nonce="theirs" src="https://cdn.test/a.js"></script></head>\n<body><script type="text/markdown"># A</script><p onclick="x()">p</p></body></html>');
  assert.doesNotMatch(html, /<script/u);
  assert.ok(scripted);
  assert.equal(scripted.match(new RegExp(`<script[^>]* nonce="${marker}"`, 'gu'))?.length, 2);
  assert.doesNotMatch(scripted, /theirs|onclick/u);
  assert.match(scripted, /<p data-lr-lines="2-2">p<\/p>/u);
});

test('an HTML file without scripts has no scripted variant', () => {
  assert.equal(htmlPreview('<p>a</p>').scripted, undefined);
});
