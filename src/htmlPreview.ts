import { randomUUID } from 'node:crypto';
import { parse, serialize } from 'parse5';
import type { DefaultTreeAdapterTypes } from 'parse5';

type ParentNode = DefaultTreeAdapterTypes.ParentNode;
type Element = DefaultTreeAdapterTypes.Element;

/** An HTML file ready for the preview frame: its scripts removed and each element tagged with its source lines. */
export interface HtmlPreview {
  readonly html: string;
  /** Comment placed first in `<head>`, where the page inserts its click script. */
  readonly marker: string;
  /** `html` with the file's scripts kept, each with `nonce="<marker>"` for the page to fill in; absent when the file has none. */
  readonly scripted?: string;
}

const untagged = new Set(['html', 'head', 'body']);

/** Tag every element with `data-lr-lines="start-end"`, drop inline event handlers, and drop scripts unless `keepScripts`. */
function tagged(source: string, marker: string, keepScripts: boolean): { html: string; scripts: number } {
  const document = parse(source, { sourceCodeLocationInfo: true });
  let scripts = 0;
  const visit = (node: ParentNode): void => {
    node.childNodes = node.childNodes.filter((child) => {
      if (!('tagName' in child) || child.tagName !== 'script') return true;
      scripts += 1;
      return keepScripts;
    });
    for (const child of node.childNodes) {
      if (!('tagName' in child)) continue;
      const element = child as Element;
      element.attrs = element.attrs.filter((attribute) => !attribute.name.toLowerCase().startsWith('on') && !(element.tagName === 'script' && attribute.name === 'nonce'));
      if (element.tagName === 'script') element.attrs.push({ name: 'nonce', value: marker });
      const location = element.sourceCodeLocation;
      if (location && !untagged.has(element.tagName)) {
        element.attrs.push({ name: 'data-lr-lines', value: `${location.startLine}-${location.endLine}` });
      }
      if (element.tagName === 'head') {
        element.childNodes.unshift({ nodeName: '#comment', data: marker, parentNode: element });
      }
      visit(element.tagName === 'template' ? (element as DefaultTreeAdapterTypes.Template).content : element);
    }
  };
  visit(document);
  return { html: serialize(document), scripts };
}

/** The file for the preview frame without scripts, and with them for a frame the user lets run them. */
export function htmlPreview(source: string): HtmlPreview {
  const marker = `lr-frame-${randomUUID()}`;
  const { html, scripts } = tagged(source, marker, false);
  return scripts === 0 ? { html, marker } : { html, marker, scripted: tagged(source, marker, true).html };
}
