/** Files the review page shows as pictures or pages, by extension. */
const mediaTypes: Readonly<Record<string, string>> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp',
  ico: 'image/x-icon', avif: 'image/avif', svg: 'image/svg+xml', pdf: 'application/pdf',
};

/** Largest file the review page previews, in bytes. */
export const maxMediaBytes = 20 * 1024 * 1024;

/** The media type of a previewable image, SVG or PDF, or undefined for any other file. */
export function mediaType(path: string): string | undefined {
  const extension = /\.([a-z0-9]+)$/iu.exec(path)?.[1]?.toLowerCase();
  return extension === undefined ? undefined : mediaTypes[extension];
}

/** One side of a media file: its type and base64 bytes, or `tooBig` past `maxMediaBytes`. */
export type MediaSide = { readonly mime: string; readonly data: string } | { readonly mime: string; readonly tooBig: true };

/** A changed image or PDF before and after the PR; a side is missing when the file was added or deleted. */
export interface MediaPreview {
  readonly old?: MediaSide;
  readonly new?: MediaSide;
}
