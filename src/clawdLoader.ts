/** Clawd, Claude's pixel mascot, as stepped sprite animations for the "Claude is working" indicators. */

interface Frame { readonly art: readonly string[]; readonly x?: number; readonly y: number; readonly ms: number }
export interface ClawdLoader { readonly width: number; readonly height: number; readonly frames: readonly Frame[] }

/** `#` is body, `o` an eye; eyes stay holes in the mask so the chip shows through. */
const CLAWD = [
  '..########..',
  '..#o####o#..',
  '############',
  '############',
  '..########..',
  '..########..',
  '..#.#..#.#..',
  '..#.#..#.#..',
];
const tucked = (art: readonly string[]): string[] => art.filter((_, row) => row !== art.length - 2);
const withLegs = (legs: readonly string[]): string[] => [...CLAWD.slice(0, -legs.length), ...legs];
const mirrored = (art: readonly string[]): string[] => art.map(row => [...row].reverse().join(''));

const hop: ClawdLoader = {
  width: 12, height: 10, frames: [
    { art: CLAWD, y: 2, ms: 200 },
    { art: tucked(CLAWD), y: 1, ms: 100 },
    { art: tucked(CLAWD), y: 0, ms: 200 },
    { art: tucked(CLAWD), y: 1, ms: 100 },
    { art: CLAWD, y: 2, ms: 400 },
  ],
};

const squashHop: ClawdLoader = {
  width: 12, height: 10, frames: [
    { art: CLAWD, y: 2, ms: 380 },
    { art: tucked(CLAWD), y: 3, ms: 110 },
    { art: tucked(CLAWD), y: 1, ms: 90 },
    { art: tucked(CLAWD), y: 0, ms: 170 },
    { art: tucked(CLAWD), y: 1, ms: 90 },
    { art: tucked(CLAWD), y: 3, ms: 110 },
  ],
};

const stepLeft = withLegs(['..#.#..#.#..', '.#.#..#.#...']);
const stepRight = withLegs(['..#.#..#.#..', '...#.#..#.#.']);
const walk = (from: number, to: number): Frame[] => Array.from({ length: Math.abs(to - from) + 1 }, (_, step) => {
  const x = from + Math.sign(to - from) * step;
  return { art: x % 2 ? stepRight : stepLeft, x, y: 0, ms: 90 };
});
const scuttle: ClawdLoader = {
  width: 18, height: 8,
  frames: [...walk(0, 6), { art: CLAWD, x: 6, y: 0, ms: 300 }, ...walk(6, 0), { art: CLAWD, x: 0, y: 0, ms: 300 }],
};

const leftClawDown = ['..########..', '..#o####o#..', '..##########', '############', '##########..', ...CLAWD.slice(5)];
const rightClawDown = mirrored(leftClawDown);
const blink = CLAWD.map(row => row.replaceAll('o', '#'));
const typing: ClawdLoader = {
  width: 12, height: 8, frames: [
    { art: leftClawDown, y: 0, ms: 120 }, { art: rightClawDown, y: 0, ms: 120 },
    { art: leftClawDown, y: 0, ms: 120 }, { art: rightClawDown, y: 0, ms: 120 },
    { art: leftClawDown, y: 0, ms: 120 }, { art: CLAWD, y: 0, ms: 360 },
    { art: blink, y: 0, ms: 90 }, { art: CLAWD, y: 0, ms: 200 },
  ],
};

export const clawdLoaders: readonly ClawdLoader[] = [hop, squashHop, scuttle, typing];

/** Clawd as Claude's avatar: standing, crouched and in the air, for the hop from the live log into a reply. */
const poses: ClawdLoader = {
  width: 12, height: 10, frames: [{ art: CLAWD, y: 2, ms: 0 }, { art: tucked(CLAWD), y: 3, ms: 0 }, { art: tucked(CLAWD), y: 1, ms: 0 }],
};

/** All frames side by side in one SVG, one run of body pixels per path segment. */
function spriteStrip({ width, height, frames }: ClawdLoader): string {
  let path = '';
  frames.forEach(({ art, x = 0, y }, index) => art.forEach((line, row) => {
    for (const run of line.matchAll(/#+/g)) path += `M${index * width + x + run.index} ${y + row}h${run[0].length}v1h-${run[0].length}z`;
  }));
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width * frames.length} ${height}" shape-rendering="crispEdges"><path d="${path}"/></svg>`;
}

const percent = (value: number): string => `${+value.toFixed(3)}%`;

/** Styles that animate the working chip's dot, the Guide tab's count and every `.clawd` as one Clawd animation, picked at random. */
export function clawdLoaderStyles(random: () => number = Math.random): string {
  const loader = clawdLoaders[Math.floor(random() * clawdLoaders.length)] ?? hop;
  const { width, height, frames } = loader;
  const total = frames.reduce((sum, frame) => sum + frame.ms, 0);
  let elapsed = 0;
  const keyframes = frames.map((frame, index) => {
    const at = percent((elapsed / total) * 100);
    elapsed += frame.ms;
    return `${at}{mask-position:${frames.length > 1 ? percent((index / (frames.length - 1)) * 100) : '0%'} 0}`;
  }).join('');
  const targets = '.chip.working::before,.tabs .count.working,.clawd';
  return `${targets}{width:${width}px;height:${height}px;border-radius:0;mask:url("data:image/svg+xml,${encodeURIComponent(spriteStrip(loader))}") 0 0/${frames.length * 100}% 100% no-repeat;animation:clawd ${total}ms step-end infinite}
@keyframes clawd{${keyframes}}
@media (prefers-reduced-motion:reduce){${targets}{animation:none}}`;
}

/** `.clawd-pose` shows Clawd standing still; `data-pose="crouch"` or `"air"` shows the hop's other frames. */
export function clawdPoseStyles(): string {
  return `.clawd-pose{width:${poses.width}px;height:${poses.height}px;background:var(--claude);mask:url("data:image/svg+xml,${encodeURIComponent(spriteStrip(poses))}") 0 0/${poses.frames.length * 100}% 100% no-repeat}
.clawd-pose[data-pose=crouch]{mask-position:50% 0}.clawd-pose[data-pose=air]{mask-position:100% 0}`;
}
