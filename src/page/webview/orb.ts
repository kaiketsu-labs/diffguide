/**
 * The Diff pair, DiffGuide's companion: an added line over a removed line, a little out of step, drawn smooth on small canvases.
 * `docs/design/diff-pair-character.html` is the reference for its look and motion.
 */

/** What the pair is doing: resting as an avatar, working on a step, waiting asleep, or reacting once to a change. */
export type OrbMotion = 'rest' | 'aligned' | 'thinking' | 'reading' | 'editing' | 'guiding' | 'starting' | 'waiting' | 'sleeping' | 'pickedUp' | 'done';

const W = 30, H = 20, X = 15, BASE = 18;
const TAU = Math.PI * 2;
const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v));
const ease = (k: number): number => k < .5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2;
const blink = (t: number, every = 3400): boolean => t % every < 120;

interface Spot { readonly x: number; readonly y: number; readonly a: number; readonly r?: number }
interface Pose {
  /** Centers of the top (added) and bottom (removed) bars; rest keeps them a pixel either side of the middle. */
  xt: number; xb: number; y: number; topDy: number; eyes: 'open' | 'closed' | 'wide'; look: readonly [number, number]; alpha: number;
  fill: number; fillA: number; sweep: number | undefined; dots: Spot[]; zs: Spot[]; shadow: boolean;
}
const pose = (extra: Partial<Pose> = {}): Pose => ({ xt: X - 1, xb: X + 1, y: 0, topDy: 0, eyes: 'open', look: [0, 0], alpha: 1, fill: 0, fillA: 1, sweep: undefined, dots: [], zs: [], shadow: true, ...extra });

/** Inchworm walk: the bottom bar steps first, then the top bar catches up and hops a little. */
function walk(from: number, to: number, k: number): Partial<Pose> {
  const steps = Math.max(1, Math.round(Math.abs(to - from) / 2.4)), s = clamp(k, 0, .9999) * steps, i = Math.floor(s), f = s - i, d = (to - from) / steps, base = from + i * d;
  const kb = ease(clamp(f * 2, 0, 1)), kt = ease(clamp(f * 2 - 1, 0, 1));
  return { xb: base + 1 + d * kb, xt: base - 1 + d * kt, topDy: -Math.sin(clamp(f * 2 - 1, 0, 1) * Math.PI) * .9 };
}

const motions: Readonly<Record<OrbMotion, (t: number) => Pose>> = {
  rest: () => pose(),
  aligned: () => pose({ xt: X, xb: X }),
  thinking: (t) => {
    const o = 1 + Math.sin(TAU * t / 2600) * 1.6;
    return pose({ xt: X - o, xb: X + o, look: [clamp(o / 2, -1, 1), .8], eyes: blink(t) ? 'closed' : 'open' });
  },
  reading: (t) => {
    const p = (t % 1500) / 1500, k = clamp(p / .75, 0, 1), reading = p < .75;
    return pose({ sweep: reading ? k : undefined, look: [reading ? (k - .5) * 2 : -.6, 1], topDy: p > .78 && p < .9 ? .6 : 0 });
  },
  editing: (t) => {
    const p = (t % 2600) / 2600;
    if (p < .55) { const k = ease(p / .55); return pose({ fill: k, look: [k * 2 - 1, 1], topDy: Math.sin(t / 45) * .25 }); }
    if (p < .8) return pose({ fill: 1, y: p < .68 ? -Math.sin((p - .55) / .13 * Math.PI) * 1.4 : 0 });
    return pose({ fill: 1, fillA: 1 - (p - .8) / .2 });
  },
  guiding: (t) => {
    const p = (t % 5200) / 5200, xl = 8, xr = 22;
    let o: Partial<Pose>, look: Pose['look'] = [1, 0], eyes: Pose['eyes'] = 'open', alpha = Math.min(1, p / .05);
    if (p < .4) o = walk(xl, X, p / .4);
    else if (p < .55) { o = {}; look = [-1, 0]; eyes = p > .47 && p < .49 ? 'closed' : 'open'; }
    else if (p < .9) o = walk(X, xr, (p - .55) / .35);
    else { o = { xb: xr + 1, xt: xr - 1 }; alpha = 1 - (p - .9) / .1; }
    const dots: Spot[] = [];
    for (let c = 2; c < (o.xb ?? X + 1) - 7.5; c += 2.4) dots.push({ x: c, y: H - 1.1, a: .45, r: .45 });
    return pose({ ...o, look, eyes, alpha, dots });
  },
  starting: (t) => {
    if (t < 500) return pose({ xt: X, xb: X, topDy: 1, eyes: 'closed' });
    if (t < 850) {
      const k = (t - 500) / 350;
      return pose({ xt: X, xb: X, topDy: 1 - k - Math.sin(k * Math.PI) * 3.2, eyes: 'wide', dots: k > .3 ? [-3, 0, 3].map((dx) => ({ x: X + dx, y: 4.5 - k * 2, a: 1 - k, r: .55 })) : [] });
    }
    if (t < 1300) { const k = ease((t - 850) / 450); return pose({ xt: X - k, xb: X + k }); }
    return pose();
  },
  waiting: (t) => {
    const p = t / 3200;
    if (p < .5) return pose({ look: [p < .25 ? -1 : 1, 0], eyes: p > .2 && p < .22 ? 'closed' : 'open' });
    const k = ease((p - .5) / .5);
    return pose({ xt: X - 1 + k, xb: X + 1 - k, topDy: .75 * k, eyes: k > .65 || (k > .3 && k < .4) ? 'closed' : 'open' });
  },
  sleeping: (t) => {
    const b = Math.sin(TAU * t / 3600), q = (t % 3600) / 3600;
    return pose({ xt: X, xb: X, topDy: .75 + b * .25, eyes: 'closed', zs: [{ x: X + 6 + q * 3, y: 8.5 - q * 3, a: q < .2 ? q / .2 : 1 - (q - .2) / .8 }] });
  },
  pickedUp: (t) => {
    if (t < 150) return pose({ xt: X, xb: X, topDy: .75, eyes: 'closed' });
    if (t < 400) return pose({ xt: X, xb: X, topDy: .75 - (t - 150) / 250 * 2.2, eyes: 'wide' });
    if (t < 1000) {
      const q = (t - 400) / 600;
      return pose({ xt: X - ease(q), xb: X + ease(q), topDy: -1.45 + 1.45 * ease(clamp(q * 2, 0, 1)) + Math.sin(clamp((q - .4) / .6, 0, 1) * Math.PI) * 1.1, look: [0, q > .4 ? 1 : 0] });
    }
    return pose();
  },
  done: (t) => {
    const o = 1 - ease(clamp(t / 400, 0, 1));
    return pose({ xt: X - o, xb: X + o, y: t > 400 && t < 800 ? -Math.sin((t - 400) / 400 * Math.PI) * 2.5 : 0 });
  },
};

/** How long a one-shot motion plays from its start before it hands over to the motion that follows it. */
const once: Partial<Readonly<Record<OrbMotion, { readonly ms: number; readonly then: OrbMotion }>>> = {
  starting: { ms: 1300, then: 'thinking' }, waiting: { ms: 3200, then: 'sleeping' }, pickedUp: { ms: 1000, then: 'thinking' }, done: { ms: 1300, then: 'aligned' },
};

/** The animation for a step Claude is on, by the step's verb. */
export function stepMotion(verb: string): OrbMotion {
  if (/^(Read|Search|Find|Web)$/u.test(verb)) return 'reading';
  if (/^(Edit|Write|Update|Writing)$/u.test(verb)) return 'editing';
  return 'thinking';
}

interface Tones { top: string; topHi: string; edge: string; eye: string; bot: string; botEdge: string; add: string; sweep: string; ground: string }
const light: Tones = { top: '#1E8463', topHi: '#2A9D78', edge: '#125540', eye: '#FFFFFF', bot: '#A6ACA9', botEdge: '#767C79', add: '#7FCBAA', sweep: 'rgba(255,255,255,.75)', ground: 'rgba(10,30,25,.22)' };
const dark: Tones = { top: '#3DB88C', topHi: '#4FC79A', edge: '#237A5C', eye: '#0B2A20', bot: '#6B7270', botEdge: '#4A504E', add: '#3F9677', sweep: 'rgba(255,255,255,.4)', ground: 'rgba(0,0,0,.35)' };

/** Light and high contrast light themes get the light pair; dark and high contrast dark get the dark one. */
function currentTones(): Tones {
  const theme = document.body.classList;
  return theme.contains('vscode-light') || theme.contains('vscode-high-contrast-light') ? light : dark;
}
new MutationObserver(() => { for (const canvas of document.querySelectorAll<HTMLCanvasElement>('canvas.orb')) delete canvas.dataset.painted; })
  .observe(document.body, { attributes: true, attributeFilter: ['class'] });

function rounded(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, r);
}

/** One frame in step units (30 × 20): ground shadow, the removed bar with its fill and sweep, then the added bar and its eyes. */
function draw(ctx: CanvasRenderingContext2D, f: Pose, T: Tones): void {
  const BW = 13, TH = 6, BH = 4, GAP = 1, EX = 1;
  const by = BASE - EX - BH + f.y, ty = by - GAP - TH + f.topDy;
  const bx = f.xb - BW / 2, tx = f.xt - BW / 2;
  ctx.fillStyle = T.top;
  for (const d of f.dots) { ctx.globalAlpha = clamp(d.a, 0, 1) * f.alpha; ctx.beginPath(); ctx.arc(d.x, d.y, d.r ?? .6, 0, TAU); ctx.fill(); }
  ctx.font = '700 5px ui-monospace, Menlo, monospace';
  for (const z of f.zs) { ctx.globalAlpha = clamp(z.a, 0, 1) * f.alpha; ctx.fillText('z', z.x, z.y); }
  if (f.shadow) { ctx.globalAlpha = f.alpha * clamp(1 + f.y / 6, .3, 1); ctx.fillStyle = T.ground; rounded(ctx, bx + 1, BASE + .2, BW - 2, 1.2, .6); ctx.fill(); }
  ctx.globalAlpha = f.alpha;
  ctx.fillStyle = T.botEdge; rounded(ctx, bx, by + EX, BW, BH, 1.6); ctx.fill();
  ctx.fillStyle = T.bot; rounded(ctx, bx, by, BW, BH, 1.6); ctx.fill();
  if (f.fill > 0 || f.sweep !== undefined) {
    ctx.save();
    rounded(ctx, bx, by, BW, BH, 1.6);
    ctx.clip();
    if (f.fill > 0) { ctx.globalAlpha = f.alpha * f.fillA; ctx.fillStyle = T.add; ctx.fillRect(bx, by, BW * f.fill, BH); }
    if (f.sweep !== undefined) { ctx.globalAlpha = f.alpha; ctx.fillStyle = T.sweep; rounded(ctx, bx + f.sweep * BW - 1.5, by + .6, 3, BH - 1.2, .8); ctx.fill(); }
    ctx.restore();
  }
  ctx.fillStyle = T.edge; rounded(ctx, tx, ty + EX, BW, TH, 2); ctx.fill();
  const shine = ctx.createLinearGradient(0, ty, 0, ty + TH);
  shine.addColorStop(0, T.topHi);
  shine.addColorStop(1, T.top);
  ctx.fillStyle = shine; rounded(ctx, tx, ty, BW, TH, 2); ctx.fill();
  const [lx, ly] = f.look, ecx = f.xt + lx * .9, ecy = ty + TH / 2 + ly * .6;
  ctx.fillStyle = T.eye;
  for (const side of [-1, 1]) {
    const x = ecx + side * 2.3;
    if (f.eyes === 'closed') rounded(ctx, x - .9, ecy - .1, 1.8, .9, .45);
    else { const h = f.eyes === 'wide' ? 3.4 : 2.6; rounded(ctx, x - .8, ecy - h / 2, 1.6, h, .8); }
    ctx.fill();
  }
  ctx.globalAlpha = 1;
}

const size = { step: [W, H], avatar: [16, 16] } as const;

/** A canvas showing the pair; `step` runs a working animation, `avatar` shows it resting in Claude's avatar. A one-shot motion plays from `since` on the page clock; `phase` shifts a looping motion by that many ms. */
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

/** Draw one pair canvas at time `t`. An avatar's `data-pose` squashes it onto its base for the hop into a reply. */
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
  const scale = canvas.width / (avatar ? 16 : W);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  if (avatar) {
    // The avatar frames the pair on its own: scaled to leave a pixel of air, centered on the body, no ground shadow.
    const s = .82;
    frame.shadow = false;
    ctx.setTransform(s * scale, 0, 0, s * scale, (8 - s * X) * scale, (8 - s * 12) * scale);
    const sq = canvas.dataset.pose === 'crouch' || canvas.dataset.pose === 'air' ? squash[canvas.dataset.pose] : undefined;
    if (sq !== undefined) { const wide = 1 + (1 - sq) * .6; ctx.transform(wide, 0, 0, sq, X * (1 - wide), BASE * (1 - sq)); }
  } else ctx.setTransform(scale, 0, 0, scale, 0, 0);
  draw(ctx, frame, currentTones());
}

let last = 0;
/** One clock for every pair on the page, at 24 frames a second, so redrawn canvases keep their place in the motion. */
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
