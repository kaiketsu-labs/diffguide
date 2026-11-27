import assert from 'node:assert/strict';
import test from 'node:test';
import { htmlPreview } from '../src/page/preview/htmlPreview.js';

const noImages = async (): Promise<undefined> => undefined;

test('an HTML file gets source lines on each element, a frame marker, and no scripts or inline handlers', async () => {
  const { html, marker } = await htmlPreview('<!doctype html>\n<html><head><title>T</title></head>\n<body>\n<p onclick="steal()">a\nb</p>\n<script>bad()</script>\n<template><b>x</b></template>\n</body></html>\n', 'page.html', noImages);
  assert.match(html, /<p data-lr-lines="4-5">a\nb<\/p>/u);
  assert.match(html, /<title data-lr-lines="2-2">/u);
  assert.match(html, new RegExp(`<head><!--${marker}--><title`, 'u'));
  assert.match(html, /<b data-lr-lines="7-7">x<\/b>/u);
  assert.doesNotMatch(html, /<script|onclick|<body data-lr/u);
});

test('an HTML file with scripts also comes with them kept and marked for the page nonce', async () => {
  const { html, marker, scripted } = await htmlPreview('<html><head><script nonce="theirs" src="https://cdn.test/a.js"></script></head>\n<body><script type="text/markdown"># A</script><p onclick="x()">p</p></body></html>', 'page.html', noImages);
  assert.doesNotMatch(html, /<script/u);
  assert.ok(scripted);
  assert.equal(scripted.match(new RegExp(`<script[^>]* nonce="${marker}"`, 'gu'))?.length, 2);
  assert.doesNotMatch(scripted, /theirs|onclick/u);
  assert.match(scripted, /<p data-lr-lines="2-2">p<\/p>/u);
});

test('an HTML file without scripts has no scripted variant', async () => {
  assert.equal((await htmlPreview('<p>a</p>', 'page.html', noImages)).scripted, undefined);
});

test('an HTML file shows images from the repository, read once, and leaves other links alone', async () => {
  const read: string[] = [];
  const readImage = async (path: string): Promise<Buffer | undefined> => { read.push(path); return path === 'assets/logo.svg' ? Buffer.from('<svg/>') : undefined; };
  const { html, scripted } = await htmlPreview('<h1><img alt="" src="../assets/logo.svg"></h1><img src="../assets/missing.png"><img src="https://cdn.test/x.png"><script>x()</script>', 'docs/status.html', readImage);
  assert.match(html, /<img alt="" src="data:image\/svg\+xml;base64,PHN2Zy8\+"/u);
  assert.match(scripted ?? '', /src="data:image\/svg\+xml;base64,PHN2Zy8\+"/u);
  assert.match(html, /src="\.\.\/assets\/missing\.png"/u);
  assert.match(html, /src="https:\/\/cdn\.test\/x\.png"/u);
  assert.deepEqual(read.sort(), ['assets/logo.svg', 'assets/missing.png']);
});
