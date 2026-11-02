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
}

const untagged = new Set(['html', 'head', 'body']);

/** Tag every element with `data-lr-lines="start-end"`, drop scripts and inline event handlers. */
export function htmlPreview(source: string): HtmlPreview {
  const document = parse(source, { sourceCodeLocationInfo: true });
  const marker = `lr-frame-${randomUUID()}`;
  const visit = (node: ParentNode): void => {
    node.childNodes = node.childNodes.filter((child) => !('tagName' in child && child.tagName === 'script'));
    for (const child of node.childNodes) {
      if (!('tagName' in child)) continue;
      const element = child as Element;
      element.attrs = element.attrs.filter((attribute) => !attribute.name.toLowerCase().startsWith('on'));
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
  return { html: serialize(document), marker };
}
