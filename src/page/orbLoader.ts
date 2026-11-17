/** The Diff pair as a stepped one-color sprite, for "Claude is working" chips. */

interface Frame { readonly art: readonly string[]; readonly ms: number }
export interface OrbLoader { readonly width: number; readonly height: number; readonly frames: readonly Frame[] }

const WIDTH = 12;

/**
 * One frame: `#` is body, `.` empty. The top (added) bar sits `shift` px left of the middle and the bottom (removed) bar as far right;
 * the eyes stay holes in the mask so the chip shows through, `look` moves them a pixel, and `blink` closes them.
 */
function pair(shift: number, look: -1 | 0 | 1 = 0, blink = false): readonly string[] {
  const at = (x: number, row: string): string => '.'.repeat(x) + row + '.'.repeat(WIDTH - x - row.length);
  const eyes = blink ? '########' : [...'##.##.##'].map((_, i) => i === 2 + look || i === 5 + look ? '.' : '#').join('');
  const top = ['.######.', '########', eyes, eyes, '.######.'], bottom = ['.######.', '########', '.######.'];
  return [...top.map((row) => at(2 - shift, row)), '.'.repeat(WIDTH), ...bottom.map((row) => at(2 + shift, row))];
}

/** The bars slide past each other while the eyes follow, then a blink: the pair's Thinking motion at chip size. */
export const orbLoader: OrbLoader = {
  width: WIDTH, height: 9, frames: [
    { art: pair(1), ms: 300 }, { art: pair(2, 1), ms: 600 }, { art: pair(1), ms: 300 },
    { art: pair(0), ms: 400 }, { art: pair(0, 0, true), ms: 100 }, { art: pair(0), ms: 300 },
  ],
};

/** All frames side by side in one SVG, one run of body pixels per path segment. */
function spriteStrip({ width, height, frames }: OrbLoader): string {
  let path = '';
  frames.forEach(({ art }, index) => art.forEach((line, row) => {
    for (const run of line.matchAll(/#+/g)) path += `M${index * width + run.index} ${row}h${run[0].length}v1h-${run[0].length}z`;
  }));
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width * frames.length} ${height}" shape-rendering="crispEdges"><path d="${path}"/></svg>`;
}

const percent = (value: number): string => `${+value.toFixed(3)}%`;

/** Styles that animate the working chip's dot as the Diff pair. */
export function orbLoaderStyles(): string {
  const { width, height, frames } = orbLoader;
  const total = frames.reduce((sum, frame) => sum + frame.ms, 0);
  let elapsed = 0;
  const keyframes = frames.map((frame, index) => {
    const at = percent((elapsed / total) * 100);
    elapsed += frame.ms;
    return `${at}{mask-position:${percent((index / (frames.length - 1)) * 100)} 0}`;
  }).join('');
  const targets = '.chip.working::before';
  return `${targets}{width:${width}px;height:${height}px;border-radius:0;background:var(--orb);mask:url("data:image/svg+xml,${encodeURIComponent(spriteStrip(orbLoader))}") 0 0/${frames.length * 100}% 100% no-repeat;animation:orb ${total}ms step-end infinite}
@keyframes orb{${keyframes}}
@media (prefers-reduced-motion:reduce){${targets}{animation:none}}`;
}
