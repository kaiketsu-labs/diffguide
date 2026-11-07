/** The DiffGuide orb as a stepped one-color sprite, for "Claude is working" chips and the Guide tab's count. */

interface Frame { readonly art: readonly string[]; readonly y: number; readonly ms: number }
export interface OrbLoader { readonly width: number; readonly height: number; readonly frames: readonly Frame[] }

/** `#` is body, `.` empty; the eyes stay holes in the mask so the chip shows through. */
const ORB = [
  '...####...',
  '.########.',
  '.########.',
  '##.####.##',
  '##.####.##',
  '##########',
  '.########.',
  '.########.',
  '...####...',
];
const blink = ORB.map((row, index) => index === 3 ? '##########' : row);
const lookLeft = ORB.map((row, index) => index === 3 || index === 4 ? '#.####.###' : row);
const lookRight = ORB.map((row, index) => index === 3 || index === 4 ? '###.####.#' : row);

/** Floats up and down, looks around and blinks: the orb's Thinking motion at chip size. */
export const orbLoader: OrbLoader = {
  width: 10, height: 11, frames: [
    { art: ORB, y: 1, ms: 260 }, { art: ORB, y: 0, ms: 360 }, { art: lookLeft, y: 0, ms: 300 }, { art: lookLeft, y: 1, ms: 260 },
    { art: ORB, y: 2, ms: 360 }, { art: lookRight, y: 2, ms: 300 }, { art: lookRight, y: 1, ms: 260 }, { art: blink, y: 1, ms: 90 },
  ],
};

/** All frames side by side in one SVG, one run of body pixels per path segment. */
export function spriteStrip({ width, height, frames }: OrbLoader): string {
  let path = '';
  frames.forEach(({ art, y }, index) => art.forEach((line, row) => {
    for (const run of line.matchAll(/#+/g)) path += `M${index * width + run.index} ${y + row}h${run[0].length}v1h-${run[0].length}z`;
  }));
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width * frames.length} ${height}" shape-rendering="crispEdges"><path d="${path}"/></svg>`;
}

const percent = (value: number): string => `${+value.toFixed(3)}%`;

/** Styles that animate the working chip's dot and the Guide tab's count as the orb. */
export function orbLoaderStyles(): string {
  const { width, height, frames } = orbLoader;
  const total = frames.reduce((sum, frame) => sum + frame.ms, 0);
  let elapsed = 0;
  const keyframes = frames.map((frame, index) => {
    const at = percent((elapsed / total) * 100);
    elapsed += frame.ms;
    return `${at}{mask-position:${percent((index / (frames.length - 1)) * 100)} 0}`;
  }).join('');
  const targets = '.chip.working::before,.tabs .count.working';
  return `${targets}{width:${width}px;height:${height}px;border-radius:0;background:var(--orb);mask:url("data:image/svg+xml,${encodeURIComponent(spriteStrip(orbLoader))}") 0 0/${frames.length * 100}% 100% no-repeat;animation:orb ${total}ms step-end infinite}
@keyframes orb{${keyframes}}
@media (prefers-reduced-motion:reduce){${targets}{animation:none}}`;
}
