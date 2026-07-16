import { useEffect, useRef } from 'react';

interface CloudOverlayProps {
  show: boolean;
  opening: boolean;
  loading?: boolean;
  loadingProgress?: number;
}

/**
 * The battle-transition clouds, drawn procedurally on a low-res canvas
 * (CSS `image-rendering: pixelated` upscales it into chunky game pixels).
 *
 * The Clash-of-Clans grammar: the bank is made OF clouds, not of bands.
 * One shape family — the plump flat-bottomed cumulus (a chain of grounded
 * dome lobes over a level base, drawn as three stacked opaque silhouettes:
 * belly shadow, sunlit body lifted off it, crown light on the NW
 * shoulders) — a flat white interior with a mid rank and the big front
 * rank at the seam, whose lobes make the silhouette ragged. Everything
 * breathes and bobs on its own slow clock. Two banks roll in to swallow
 * the view, idle alive while the raid loads, then part to reveal the
 * battlefield.
 */

const PX = 4.5;           // CSS pixels per cloud pixel (1.5× chunkier, owner call)
const CLOSE_MS = 700;     // bank roll-in
const OPEN_MS = 800;      // bank part (base duration; rows ride ±18% of it)
const FRONT = 0.62;       // each bank's seam position as a fraction of width

/**
 * When the part is actually FINISHED: the slowest layer is the haze floor
 * (openRate 1.2 in drawBank), so the overlay must stay mounted for
 * OPEN_MS × 1.2. App's unmount timers key off this — hiding at a bare
 * OPEN_MS left a full-height haze band on windows wider than ~1570px
 * (the ease tail still had ~20% of the sweep to travel) that then
 * vanished in a single frame.
 */
export const CLOUD_OPEN_TOTAL_MS = Math.ceil(OPEN_MS * 1.2);

interface PuffPalette { shadow: string; body: string; crown: string }

// The fog rampart's own palettes, back to front: flat near-white interior,
// two packed rows, then the big sunlit rampart at the seam. Kept in step
// with WorldMapSystem's rampart: shadow tones sit near the neighbour
// layer's body tone so overlap rims blend as creases, not outlines.
const HAZE = '#eaf0f6';
const ROW_B: PuffPalette = { shadow: '#c0cddb', body: '#d8e2ec', crown: '#e9eff5' };
const ROW_A: PuffPalette = { shadow: '#c3d1e0', body: '#e5ecf3', crown: '#f3f7fb' };
const CREST: PuffPalette = { shadow: '#c2cfdd', body: '#dbe4ee', crown: '#edf2f7' };
const FORE: PuffPalette = { shadow: '#c9d6e3', body: '#e9eff5', crown: '#f9fbfd' };

const hash = (i: number) => (Math.imul(i | 0, 2654435761) >>> 0) % 100000;
const easeOutCubic = (t: number) => 1 - Math.pow(1 - t, 3);
const easeInCubic = (t: number) => t * t * t;

/**
 * One plump cumulus. `w` is the body width; the base sits level at `y`.
 * Three opaque passes: shadow silhouette, the same silhouette lifted for
 * the sunlit body (the sliver of shadow left showing traces every lobe's
 * underside), then crown light on the two tallest domes.
 */
function puff(ctx: CanvasRenderingContext2D, x: number, y: number, w: number,
  seed: number, pal: PuffPalette, breath: number) {
  const s = w * (0.92 + breath * 0.16);
  const lift = s * 0.085;
  const lobeN = 3 + (seed % 3);
  const lobes: Array<[number, number, number]> = [];
  for (let i = 0; i < lobeN; i++) {
    const t = (i / (lobeN - 1)) * 2 - 1;
    const rj = ((seed >> (i * 3)) % 7) / 7;
    const r = s * (0.30 - 0.105 * t * t + rj * 0.055);
    lobes.push([x + t * s * 0.36, y - r * 0.94, r]);
  }
  const pass = (fill: string, dy: number) => {
    ctx.fillStyle = fill;
    ctx.beginPath();
    for (const [cx, cy, r] of lobes) {
      ctx.moveTo(cx + r, cy + dy);
      ctx.arc(cx, cy + dy, r, 0, Math.PI * 2);
    }
    ctx.rect(x - s * 0.42, y - s * 0.13 + dy, s * 0.84, s * 0.13);
    ctx.fill();
  };
  pass(pal.shadow, 0);
  pass(pal.body, -lift);
  ctx.fillStyle = pal.crown;
  ctx.beginPath();
  const tall = [...lobes].sort((a, b) => b[2] - a[2]).slice(0, 2);
  for (const [cx, cy, r] of tall) {
    ctx.moveTo(cx - r * 0.22 + r * 0.52, cy - r * 0.26 - lift);
    ctx.arc(cx - r * 0.22, cy - r * 0.26 - lift, r * 0.52, 0, Math.PI * 2);
  }
  ctx.fill();
}

/** The rampart's compressed, slow swell — the bank rolls, it never pops. */
function rampartBreath(T: number, h: number): number {
  return 0.32 + 0.36 * (0.5 + 0.5 * Math.sin(T * (0.1 + (h % 5) * 0.035) + h));
}

/**
 * One bank, built EXACTLY like the world's fog rampart, stood on its side:
 * a flat near-white floor, two packed puff rows, and one continuous
 * rampart of big masses at the seam — packed at a third of their own
 * width so every lobe belongs to the same bank — with taller crests
 * merged behind. dir -1 = left (seam at FRONT*W), +1 = right.
 * `off` pulls the bank out toward its screen edge; layers ride at
 * 0.9 / 0.96 / 1.0 of it for parallax.
 */
function drawBank(
  ctx: CanvasRenderingContext2D, W: number, H: number, T: number, dir: -1 | 1,
  closeT: number, openT: number | null, holding: boolean
) {
  const seed = dir === -1 ? 977 : 5417;
  const bankW = FRONT * W + 30;
  const front = dir === -1 ? FRONT * W : (1 - FRONT) * W;
  const edge = dir === -1 ? front - bankW : front + bankW;
  const REACH = FRONT * W + 90;

  // The CoC trick: every row runs its own clock. A rate scales the row's
  // close/open duration by ±15%, so rows arrive and part slightly out of
  // step — the seam stays ragged and alive instead of sliding as a slab.
  const coverAt = (closeRate: number, openRate: number) => {
    let c = holding ? 1 : easeOutCubic(Math.min(1, closeT / (CLOSE_MS * closeRate)));
    if (openT !== null) c *= 1 - easeInCubic(Math.min(1, openT / (OPEN_MS * openRate)));
    return c;
  };
  const rowOff = (h: number) => {
    const closeRate = 0.88 + ((h >> 4) % 100) * 0.003; // 0.88..1.18
    const openRate = 0.88 + ((h >> 6) % 100) * 0.003;
    return (1 - coverAt(closeRate, openRate)) * REACH;
  };

  // --- the deep bank: one flat near-white fill (parallax 0.9). It rides
  // the FASTEST close and the SLOWEST part, so no ragged row ever outruns
  // its cover and flashes the world between lobes. ---
  const floorOff = (1 - coverAt(0.84, 1.2)) * REACH;
  ctx.save();
  ctx.translate(dir * floorOff * 0.9, 0);
  ctx.fillStyle = HAZE;
  if (dir === -1) ctx.fillRect(edge - 44, -1, bankW + 40, H + 2);
  else ctx.fillRect(front - 4, -1, bankW + 48, H + 2);
  ctx.restore();

  // --- two packed rows shouldering up behind the rampart (parallax 0.96) ---
  const rows: Array<{ d: number; w: number; step: number; pal: PuffPalette }> = [
    { d: 96, w: 104, step: 40, pal: ROW_B },
    { d: 52, w: 92, step: 32, pal: ROW_A }
  ];
  for (const row of rows) {
    for (let y = -30; y <= H + 30; y += row.step) {
      const h = hash(seed * 131 + y * 13 + row.d);
      const x = front + dir * (row.d + (h % 18)) + dir * rowOff(h) * 0.96;
      const bob = Math.sin(T * 0.12 + h) * 2;
      puff(ctx, x, y + bob + row.step * 0.5, row.w + (h % 22), h, row.pal, rampartBreath(T, h));
    }
  }

  // --- the rampart: one continuous billowing front (parallax 1.0) ---
  const step = 30;
  for (let y = -32; y <= H + 32; y += step) {
    const h = hash(seed * 7919 + y * 7);
    const breath = rampartBreath(T, h);
    const bob = Math.sin(T * 0.14 + h * 1.1) * 2.6;
    const w = 92 + (h % 36);
    const x = front + dir * ((h >> 3) % 14) - dir * w * 0.12 + dir * rowOff(h);

    // Taller crests swelling behind every third mass, merged into the bank.
    if (h % 3 === 0) {
      const pPhase = T * 0.07 + h * 1.7;
      const rise = (0.5 + 0.5 * Math.sin(pPhase)) * 4;
      puff(ctx, x + dir * w * 0.38, y + bob - w * 0.16 - rise, w * 0.82, h >> 2,
        CREST, rampartBreath(T, h >> 2));
    }

    puff(ctx, x, y + bob, w, h, FORE, breath);
  }
}

export function CloudOverlay({
  show,
  opening,
  loading = false,
  loadingProgress = 0,
}: CloudOverlayProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const mountedAtRef = useRef(0);
  const openingAtRef = useRef<number | null>(null);
  const loadingRef = useRef(loading);
  loadingRef.current = loading;

  useEffect(() => {
    openingAtRef.current = opening ? performance.now() : null;
  }, [opening]);

  useEffect(() => {
    if (!show) return;
    mountedAtRef.current = performance.now();
    let raf = 0;
    const draw = (now: number) => {
      raf = requestAnimationFrame(draw);
      const cvs = canvasRef.current;
      const ctx = cvs?.getContext('2d');
      if (!cvs || !ctx) return;
      const W = Math.ceil(window.innerWidth / PX);
      const H = Math.ceil(window.innerHeight / PX);
      if (cvs.width !== W || cvs.height !== H) {
        cvs.width = W;
        cvs.height = H;
      }
      // Raw clocks; each cloud row eases its own cover from these (the
      // CoC-style uneven roll — see drawBank).
      const closeT = now - mountedAtRef.current;
      const oAt = openingAtRef.current;
      const openT = oAt !== null ? now - oAt : null;
      ctx.clearRect(0, 0, W, H);
      const T = now * 0.001;
      drawBank(ctx, W, H, T, -1, closeT, openT, loadingRef.current);
      drawBank(ctx, W, H, T, 1, closeT, openT, loadingRef.current);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [show]);

  if (!show) return null;

  const clampedProgress = Math.max(0, Math.min(100, Math.round(loadingProgress)));
  const classes = ['cloud-overlay'];
  if (opening) classes.push('opening');
  if (loading) classes.push('loading');

  return (
    <div className={classes.join(' ')}>
      <canvas ref={canvasRef} className="cloud-canvas" />
      {loading && (
        <div className="cloud-loading-panel">
          <div className="cloud-loading-track">
            <div className="cloud-loading-fill" style={{ width: `${clampedProgress}%` }} />
          </div>
          <div className="cloud-loading-percent">{clampedProgress}%</div>
        </div>
      )}
    </div>
  );
}
