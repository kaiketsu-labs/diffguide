/**
 * The DiffGuide orb in pixels: inner light, glow, motes and a ground shadow, on small canvases.
 * `docs/design/orb-character.html` is the reference for its look and motion.
 */

/** What the orb is doing: resting as an avatar, working on a step, waiting asleep, or reacting once to a change. */
export type OrbMotion = 'rest' | 'think' | 'search' | 'write' | 'lead' | 'sleep' | 'doze' | 'wake' | 'nod';

const W = 30, H = 20, X = 15, Y = 10, R = 6;
const TAU = Math.PI * 2;
const frac = (v: number): number => v - Math.floor(v);
const lerp = (a: number, b: number, k: number): number => a + (b - a) * k;
const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v));
const phase = (t: number, period: number): number => frac(t / period);
const sign = (v: number, dead = .3): number => v > dead ? 1 : v < -dead ? -1 : 0;
const ease = (k: number): number => k < .5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2;
const blinking = (p: number, at: number): boolean => p >= at && p < at + .035;

interface Spot { readonly x: number; readonly y: number; readonly a: number }
interface Pose {
  x: number; y: number; sq: number; alpha: number; eyes: 'open' | 'closed' | 'wide'; look: readonly [number, number];
  sparks: Spot[]; trail: (Spot & { readonly r: number })[]; lines: (Spot & { readonly w: number })[]; glyphs: (Spot & { readonly ch: keyof typeof glyphs })[];
}
const pose = (extra: Partial<Pose> = {}): Pose => ({ x: X, y: Y, sq: 1, alpha: 1, eyes: 'open', look: [0, 0], sparks: [], trail: [], lines: [], glyphs: [], ...extra });
const glyphs = { z: ['##.', '.#.', '.##'], Z: ['####', '..#.', '.#..', '####'], '?': ['##.', '..#', '.#.', '...', '.#.'] } as const;

function sleeping(t: number): Pose {
  const p = phase(t, 3200), b = Math.sin(TAU * p);
  const zs = [0, 1, 2].map((k) => { const q = frac(p + k / 3); return { ch: q > .5 ? 'Z' as const : 'z' as const, x: lerp(X + R * .5, X + R + 6, q), y: lerp(Y - R * .4, 0, q), a: q < .15 ? q / .15 : 1 - (q - .15) / .85 }; });
  return pose({ y: Y + 1 + b * .4, sq: 1 - (b + 1) * .03, alpha: .78 + .11 * (b + 1), eyes: 'closed', glyphs: zs });
}

function searching(t: number): Pose {
  const at = (time: number): Pose => { const p = phase(time, 3400); return pose({ x: X + Math.sin(TAU * p) * (X - R - 2), y: Y + Math.sin(2 * TAU * p) * 1.5 }); };
  const now = at(t), p = phase(t, 3400);
  now.trail = [1, 2].map((n) => ({ ...at(t - n * 90), r: R * (.62 - (n - 1) * .14), a: .38 - (n - 1) * .1 })).filter((s) => Math.hypot(s.x - now.x, s.y - now.y) > .6);
  now.look = [sign(Math.cos(TAU * p)), sign(Math.cos(2 * TAU * p), .6)];
  return now;
}

/** Ways the orb thinks, taken in turn so a long step doesn't loop one motion. */
const thoughts: readonly ((t: number) => Pose)[] = [
  (t) => {
    const p = phase(t, 1900);
    const sparks = [0, 1, 2].map((k) => { const a = TAU * p + k * TAU / 3; return { x: X + Math.cos(a) * (R + 3.5), y: Y + Math.sin(a) * (R * .5 + 1.5), a: .55 + .45 * Math.sin(a) }; });
    return pose({ y: Y + Math.sin(TAU * p) * .5, look: [1, -1], sparks });
  },
  (t) => {
    const p = phase(t, 4200), q = clamp((p - .55) / .4, 0, 1);
    const mark: Pose['glyphs'] = p > .55 ? [{ ch: '?', x: X + R - 1, y: Y - R - 3 - q * 1.5, a: q < .2 ? q / .2 : 1 - Math.max(0, q - .7) / .3 }] : [];
    return pose({ x: X + Math.sin(TAU * p) * 1.2, y: Y + .5, look: p < .4 ? [-1, -1] : p < .45 ? [0, -1] : [1, -1], eyes: blinking(p, .2) ? 'closed' : 'open', glyphs: mark });
  },
  (t) => {
    const p = phase(t, 1500);
    const sparks = [0, 1, 2].map((k) => { const q = frac(p + k / 3); return { x: lerp(X - 5, X + 5, q), y: Y - R - 1 - Math.sin(Math.PI * q) * 3, a: .9 }; });
    const top = sparks.reduce((a, b) => b.y < a.y ? b : a);
    return pose({ y: Y + 1 + Math.abs(Math.sin(TAU * p * 1.5)) * .6, look: [sign(top.x - X, 1.5), -1], sparks });
  },
  (t) => {
    const p = phase(t, 1350);
    const sparks = [0, 1, 2].map((k) => { const on = clamp(1 - Math.abs(p * 4 - k - .5) / 1.2, 0, 1); return { x: X + R + 3 + k * 2, y: Y - 1 - on, a: .3 + .7 * on }; });
    return pose({ x: X - 4, look: [1, 0], sparks });
  },
  (t) => {
    const p = phase(t, 2200), b = Math.sin(TAU * p), k = frac(p * 2), r = R + 1 + k * 7;
    const sparks = Array.from({ length: 12 }, (_, i) => ({ x: X + Math.cos(i * TAU / 12) * r, y: Y + Math.sin(i * TAU / 12) * r * .6, a: (1 - k) * .8 }));
    return pose({ sq: 1 - (b + 1) * .03, eyes: b > .6 ? 'closed' : 'open', sparks });
  },
  (t) => {
    const a = TAU * phase(t, 1800);
    return pose({ x: X + Math.cos(a) * 1.5, y: Y + Math.sin(a) * .6, look: [Math.round(Math.cos(a) * 1.2), Math.round(Math.sin(a) * 1.2)] });
  },
  (t) => {
    const h = Math.max(0, Math.sin(TAU * phase(t, 950)));
    return pose({ y: Y + 1 - h * 3, sq: h < .15 ? .9 : 1 + h * .03, eyes: h < .15 ? 'closed' : 'open', look: [0, -1] });
  },
];
const thoughtMs = 6000;

const motions: Readonly<Record<OrbMotion, (t: number) => Pose>> = {
  rest: () => pose(),
  // Keyed to the page clock, so every thinking orb switches together and a redraw keeps its place.
  think: (t) => (thoughts[Math.floor(t / thoughtMs) % thoughts.length] ?? motions.rest)(t),
  search: searching,
  lead: (t) => {
    const p = phase(t, 4600), xl = R + 2, xm = X, xr = W - R - 2;
    let x = xl, look: Pose['look'] = [1, 0], alpha = 1, eyes: Pose['eyes'] = 'open';
    if (p < .25) x = lerp(xl, xm, ease(p / .25));
    else if (p < .45) { x = xm; look = [-1, 0]; eyes = blinking(p, .38) ? 'closed' : 'open'; }
    else if (p < .7) x = lerp(xm, xr, ease((p - .45) / .25));
    else if (p < .88) { x = xr; look = [-1, 0]; }
    else { x = xr; alpha = 1 - (p - .88) / .12; }
    const sparks: Spot[] = [];
    for (let c = xl; c < x - R - 1; c += 3) sparks.push({ x: c, y: Y + R + 2, a: .45 * alpha });
    return pose({ x, y: Y + Math.sin(p * 30) * .3, look, alpha, eyes, sparks });
  },
  sleep: sleeping,
  doze: (t) => {
    const p = t / 3712;
    if (p < .6) return pose({ y: Y + Math.sin(TAU * p * 5) * .8, look: [p < .3 ? -1 : 1, 0] });
    const k = (p - .6) / .4;
    return pose({ y: Y + k * 1.2 + Math.max(0, Math.sin(k * TAU * 2)) * .8, eyes: Math.sin(k * TAU * 2) > .2 ? 'closed' : 'open' });
  },
  wake: (t) => {
    if (t < 1520) return sleeping(t);
    const k = Math.min(1, (t - 1520) / 456);
    const sparks = Array.from({ length: 8 }, (_, i) => ({ x: X + Math.cos(i * TAU / 8) * (R + 1 + k * 4), y: Y - 2 + Math.sin(i * TAU / 8) * (R + 1 + k * 3), a: 1 - k }));
    return pose({ y: Y + 1 - Math.sin(Math.PI * k) * 3.5, eyes: 'wide', sparks });
  },
  nod: (t) => {
    const k = Math.abs(Math.sin(t / 880 * TAU));
    return pose({ y: Y + k * 1.4, sq: 1 - k * .07, look: [0, k > .3 ? 1 : 0] });
  },
  write: (t) => {
    const p = phase(t, 3200), row = H - 2, x = lerp(R + 1, W - R - 1, p), hop = Math.abs(Math.sin(p * Math.PI * 9));
    const lines: Pose['lines'] = [];
    for (let c = 1; c < x - R * .4; c++) if (c % 6 !== 5) lines.push({ x: c, y: row, w: 1, a: p > .92 ? (1 - p) / .08 * .7 : .7 });
    return pose({ x, y: row - R - 1.2 - hop * 2, sq: 1 - (1 - hop) * .08, look: [1, 1], lines });
  },
};

/** How long a one-shot motion plays from its start before it hands over to the motion that follows it. */
const once: Partial<Readonly<Record<OrbMotion, { readonly ms: number; readonly then: OrbMotion }>>> = {
  doze: { ms: 3712, then: 'sleep' }, wake: { ms: 1976, then: 'think' }, nod: { ms: 880, then: 'think' },
};

/** The animation for a step Claude is on, by the step's verb. */
export function stepMotion(verb: string): OrbMotion {
  if (/^(Read|Search|Find|Web)$/u.test(verb)) return 'search';
  if (/^(Edit|Write|Update|Writing)$/u.test(verb)) return 'write';
  return 'think';
}

interface Tones { base: string; hi: string; core: string; shade: string; deep: string; spark: string; ground: string; groundA: number }
const rgb = (hex: string): number[] => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
const mix = (a: string, b: string, k: number): string => '#' + rgb(a).map((v, i) => Math.round(v + ((rgb(b)[i] ?? 0) - v) * k).toString(16).padStart(2, '0')).join('');

let tones: Tones | undefined;
/** Tones derived from the theme's `--orb` color; recomputed when VS Code switches theme. */
function currentTones(): Tones {
  if (tones !== undefined) return tones;
  const raw = getComputedStyle(document.body).getPropertyValue('--orb').trim();
  const base = /^#[\da-f]{6}$/iu.test(raw) ? raw : '#7fc0de';
  const dark = !document.body.classList.contains('vscode-light') && !document.body.classList.contains('vscode-high-contrast-light');
  tones = {
    base, hi: mix(base, '#ffffff', .38), core: mix(base, '#ffffff', .72), shade: mix(base, '#000000', .24), deep: mix(base, '#08131c', .66),
    spark: dark ? mix(base, '#ffffff', .3) : base, ground: dark ? '#000000' : mix(base, '#08131c', .5), groundA: dark ? .55 : .22,
  };
  return tones;
}
new MutationObserver(() => { tones = undefined; for (const canvas of document.querySelectorAll<HTMLCanvasElement>('canvas.orb')) delete canvas.dataset.painted; })
  .observe(document.body, { attributes: true, attributeFilter: ['class'] });

interface Cell { readonly i: number; readonly j: number; readonly c: string; readonly a: number }
type Layer = Map<string, Cell>;
const put = (layer: Layer, i: number, j: number, c: string, a = 1): void => { layer.set(i + ',' + j, { i, j, c, a }); };
function disc(layer: Layer, cx: number, cy: number, r: number, c: string, a: number): void {
  for (let i = Math.floor(cx - r - 1); i <= cx + r + 1; i++) for (let j = Math.floor(cy - r - 1); j <= cy + r + 1; j++) {
    if ((i + .5 - cx) ** 2 + (j + .5 - cy) ** 2 <= r * r) put(layer, i, j, c, a);
  }
}

/** Every cell of one frame: what sits behind the body, then the body with its face. */
function compose(f: Pose, t: number, T: Tones): readonly Layer[] {
  const rx = R * (1 + (1 - f.sq) * .6), ry = R * f.sq;
  const cx = Math.round(f.x), cy = Math.round(f.y + (R - ry));
  const inside = (i: number, j: number): boolean => ((i + .5 - cx) / rx) ** 2 + ((j + .5 - cy) / ry) ** 2 <= 1;
  const under: Layer = new Map(), body: Layer = new Map();

  const lift = (H - 1) - (cy + ry);
  if (lift > -.5) {
    const half = clamp(R * (1.05 - lift * .07), 2, R + 1), a = T.groundA * (.55 + .45 * (1 - clamp(lift / 8, 0, 1)));
    for (let i = Math.floor(cx - half - 1); i <= cx + half; i++) if (Math.abs(i + .5 - cx) <= half) put(under, i, H - 1, T.ground, Math.abs(i + .5 - cx) <= half - 2 ? a : a * .6);
  }
  for (let i = cx - R - 4; i <= cx + R + 4; i++) for (let j = cy - R - 4; j <= cy + R + 4; j++) {
    const e = Math.sqrt(((i + .5 - cx) / rx) ** 2 + ((j + .5 - cy) / ry) ** 2) * R;
    if (e > R && e <= R + 1.3) put(under, i, j, T.base, .22 + .06 * Math.sin(t / 400));
    else if (e > R + 1.3 && e <= R + 2.6) put(under, i, j, T.base, .08);
  }
  for (const l of f.lines) for (let c = 0; c < Math.round(l.w); c++) put(under, Math.round(l.x) + c, Math.round(l.y), T.base, l.a * .8);
  for (const s of f.trail) disc(under, s.x, s.y, s.r, T.base, s.a);
  for (const s of f.sparks) put(under, Math.round(s.x), Math.round(s.y), T.spark, clamp(s.a, 0, 1));
  for (const g of f.glyphs) glyphs[g.ch].forEach((row, j) => [...row].forEach((ch, i) => { if (ch === '#') put(under, Math.round(g.x) + i, Math.round(g.y) + j, T.spark, clamp(g.a, 0, 1)); }));
  for (let n = 0; n < 3; n++) {
    const a = t / 900 + n * 2.1;
    put(under, Math.round(cx + Math.cos(a) * (R + 3.4)), Math.round(cy + Math.sin(a) * (R * .55 + 1.6)), T.spark, .35 + .45 * (.5 + .5 * Math.sin(t / 260 + n * 2)));
  }

  const pulse = Math.sin(t / 520) * .05;
  for (let i = cx - Math.ceil(rx) - 1; i <= cx + Math.ceil(rx) + 1; i++) for (let j = cy - Math.ceil(ry) - 1; j <= cy + Math.ceil(ry) + 1; j++) {
    if (!inside(i, j)) continue;
    const dist = Math.hypot((i + .5 - cx) / rx, (j + .5 - cy) / ry);
    put(body, i, j, dist < .36 + pulse ? T.core : dist < .66 + pulse ? T.hi : dist < .9 ? T.base : T.shade, f.alpha);
  }
  const [lx, ly] = [clamp(f.look[0], -1, 1), clamp(f.look[1], -1, 1)];
  const ey = cy - 2 + ly;
  const eye = (i: number, j: number): void => { if (body.has(i + ',' + j)) put(body, i, j, T.deep, f.alpha); };
  for (const ex of [cx - 3 + lx, cx + 1 + lx]) {
    if (f.eyes === 'closed') { eye(ex, ey + 1); eye(ex + 1, ey + 1); continue; }
    for (let j = f.eyes === 'wide' ? ey - 1 : ey; j <= ey + 1; j++) { eye(ex, j); eye(ex + 1, j); }
  }
  for (const key of body.keys()) under.delete(key);
  return [under, body];
}

const size = { step: [W, H], avatar: [16, 16] } as const;

/** A canvas showing the orb; `step` runs a working animation, `avatar` shows it resting in Claude's avatar. A one-shot motion plays from `since` on the page clock; `phase` shifts a looping motion by that many ms. */
export function orbCanvas(kind: keyof typeof size, motion: OrbMotion = 'rest', since = performance.now(), phase = 0): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  const [width, height] = size[kind];
  const dpr = Math.max(1, Math.round(devicePixelRatio || 1));
  canvas.className = 'orb ' + kind;
  canvas.width = width * dpr;
  canvas.height = height * dpr;
  canvas.style.width = width + 'px';
  canvas.style.height = height + 'px';
  canvas.dataset.motion = motion;
  if (once[motion] !== undefined) canvas.dataset.from = String(since);
  if (phase !== 0) canvas.dataset.phase = String(phase);
  canvas.setAttribute('aria-hidden', 'true');
  return canvas;
}

const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
const squash = { crouch: .86, air: 1.06 } as const;

/** Draw one orb canvas at time `t`. An avatar's `data-pose` squashes it for the hop into a reply. */
function paintOrb(canvas: HTMLCanvasElement, t: number): void {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const avatar = canvas.classList.contains('avatar');
  let name = (canvas.dataset.motion ?? 'rest') as OrbMotion;
  const shifted = t + Number(canvas.dataset.phase ?? 0);
  let local = shifted;
  const shot = once[name];
  if (shot !== undefined) {
    local = t - Number(canvas.dataset.from ?? 0);
    // Reduced motion skips straight to the pose the one-shot ends in.
    if (local >= shot.ms || reducedMotion.matches) name = shot.then;
  }
  const frame = (motions[name] ?? motions.rest)(name === canvas.dataset.motion ? local : shifted);
  const squashed = canvas.dataset.pose === 'crouch' || canvas.dataset.pose === 'air' ? squash[canvas.dataset.pose] : undefined;
  if (squashed !== undefined) frame.sq = squashed;
  const scale = canvas.width / (avatar ? 16 : W);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.setTransform(scale, 0, 0, scale, avatar ? -(X - 8) * scale : 0, avatar ? -(Y - 8) * scale : 0);
  for (const layer of compose(frame, avatar ? 0 : shifted, currentTones())) {
    for (const cell of layer.values()) { ctx.globalAlpha = clamp(cell.a, 0, 1); ctx.fillStyle = cell.c; ctx.fillRect(cell.i, cell.j, 1, 1); }
  }
  ctx.globalAlpha = 1;
}

let last = 0;
/** One clock for every orb on the page, at 24 frames a second, so redrawn orbs keep their place in the motion. */
function tick(now: number): void {
  if (now - last >= 1000 / 24) {
    last = now;
    for (const canvas of document.querySelectorAll<HTMLCanvasElement>('canvas.orb')) {
      const still = canvas.dataset.motion === 'rest' || reducedMotion.matches;
      if (still && canvas.dataset.painted === (canvas.dataset.pose ?? '')) continue;
      paintOrb(canvas, still ? 1200 : now);
      if (still) canvas.dataset.painted = canvas.dataset.pose ?? '';
    }
  }
  requestAnimationFrame(tick);
}
requestAnimationFrame(tick);
