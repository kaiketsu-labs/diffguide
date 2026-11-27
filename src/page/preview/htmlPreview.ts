import { randomUUID } from 'node:crypto';
import { type DefaultTreeAdapterTypes, parse, serialize } from 'parse5';
import { localImageData } from './markdown.js';

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

/** Tag every element with `data-lr-lines="start-end"`, drop inline event handlers, drop scripts unless `keepScripts`, and swap image sources `image` can read for its data URL. */
async function tagged(source: string, marker: string, keepScripts: boolean, image: (source: string) => Promise<string | undefined>): Promise<{ html: string; scripts: number }> {
  const document = parse(source, { sourceCodeLocationInfo: true });
  const imageSources: Element['attrs'][number][] = [];
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
      const imageSource = element.tagName === 'img' ? element.attrs.find((attribute) => attribute.name === 'src') : undefined;
      if (imageSource) imageSources.push(imageSource);
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
  await Promise.all(imageSources.map(async (attribute) => { attribute.value = await image(attribute.value) ?? attribute.value; }));
  return { html: serialize(document), scripts };
}

/**
 * The file at `documentPath` for the preview frame without scripts, and with them for a frame the user lets run them.
 * The frame has no address to resolve relative links against, so images in the repository are inlined.
 */
export async function htmlPreview(source: string, documentPath: string, readImage: (path: string) => Promise<Buffer | undefined>): Promise<HtmlPreview> {
  const marker = `lr-frame-${randomUUID()}`;
  const read = new Map<string, Promise<string | undefined>>();
  const image = (link: string): Promise<string | undefined> => {
    const known = read.get(link) ?? localImageData(link, documentPath, readImage);
    read.set(link, known);
    return known;
  };
  const { html, scripts } = await tagged(source, marker, false, image);
  return scripts === 0 ? { html, marker } : { html, marker, scripted: (await tagged(source, marker, true, image)).html };
}
