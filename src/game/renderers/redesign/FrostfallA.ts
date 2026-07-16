import type Phaser from 'phaser';

/**
 * FROSTFALL — CLEAN-ROOM DESIGN A: "THE WINTERSPRING"
 *
 * Concept: the frostfall is not a machine — it is a captive glacial spring.
 * A round stone cistern holds luminous melt-water, ringed by a henge of
 * standing stones that charge the pool. Over the 4200 ms preparation the
 * water vortexes and a great ice shard crystallises out of the spring,
 * growing from a floating seed chip to the full payload; at the launch
 * instant the spring's geyser bursts and hurls the shard skyward. The AoE
 * chill/knockback identity is literal: an erupting winter spring.
 *
 * Silhouette: low, wide, radially symmetric (single-angle bake safe) —
 * glowing pool + menhir ring, periodically crowned by a tall crystal.
 *
 * Ambient contract: ONE declared idle period P = 2000 ms (a 250 ms multiple);
 * every idle term below is an exact harmonic of P (k=1, k=2, or a function of
 * frac(time/P)), so the 36-frame ~18 fps bake loop closes with 0.00% residual:
 *   - orbiting ripple dashes on the water (large px motion)
 *   - two counter-phased surface glints (orbit r = Ri·0.55)
 *   - core glow colour pulse (k=2, ~80/255 RGB swing) + size breath (k=1)
 *   - floating seed crystal bob (±1.5 px, k=1) with a k=2 glint blink
 *   - rising mist wisps (sawtooth in frac(time/P), size → 0 at both seam ends)
 *   - L3+: rune glow pulse (k=1) and an icicle tip-glint chase (index hop, k=1)
 *   - L4: a gold glint orbiting the rim inlay (k=1)
 *
 * Fire timeline (age = time - lastFireTime; launch instant 4200 ms is
 * contract-locked, spawn point = (center.x, center.y - 10)):
 *   0..800    AWAKEN — runes ignite in sequence, pool brightens, vortex spins up
 *   500..3800 GROWTH — the shard crystallises, symmetric about (cx, cy-10),
 *             reaching the exact embedded-payload envelope (35/40/45 tall ×
 *             18/20/22 wide for L1/L2/L3+); frost arcs flicker from the
 *             menhir tips to the crystal; a charge-light races the rim
 *   3800..4200 ARMING — pool drains dark (energy pulled into the shard),
 *             crystal shivers (x-only; damps to zero in the last 50 ms so the
 *             payload is positionally continuous with the spawn point)
 *   4200..4900 (projectileActive) LAUNCH — the shard is ABSENT; geyser column,
 *             ballistic spray droplets, an expanding mist ring, runes fade
 *   4200..4800 (!projectileActive) ABORT — the grown shard sinks back into the
 *             spring (also renders the harmless 0.4 s battle-start blip at L4)
 *   ≥4900     pure idle again (the prep's vortex term adds exactly 3 whole
 *             revolutions by 4200 ms, so the hand-off back to idle is seamless)
 *
 * Level language (per the art guide):
 *   L1 field materials — rough fieldstone basin, two mossy-frost menhirs
 *   L2 dressed grey stone — full henge of four, first icicles
 *   L3 dark stone + iron band — tall rune-lit menhirs, icicle glint chase
 *   L4 warm sandstone with gold ACCENTS only — thin gold rim inlay, gold
 *      menhir caps, a single orbiting gold glint (no white masses)
 */

type G = Phaser.GameObjects.Graphics;
type V2 = Phaser.Math.Vector2;

// ── contract-locked timeline ─────────────────────────────────────────────
const PREP_MS = 4200;   // fire tick → launch instant (MainScene scheduleBattleCall)
const IMPACT_MS = 4800; // launch + 600 ms flight
const SETTLE_MS = 4900; // fully back on the idle loop

// ── THE ambient period (250 ms multiple; all idle terms are harmonics) ──
const P = 2000;
const TAU = Math.PI * 2;

// ─────────────────────────── small pure helpers ──────────────────────────

function clamp01(t: number): number { return t < 0 ? 0 : t > 1 ? 1 : t; }
function smooth(t: number): number { const c = clamp01(t); return c * c * (3 - 2 * c); }
function frac(t: number): number { return t - Math.floor(t); }

function mix(a: number, b: number, t: number): number {
    const k = clamp01(t);
    const ar = (a >> 16) & 255, ag = (a >> 8) & 255, ab = a & 255;
    const br = (b >> 16) & 255, bg = (b >> 8) & 255, bb = b & 255;
    return (Math.round(ar + (br - ar) * k) << 16)
        | (Math.round(ag + (bg - ag) * k) << 8)
        | Math.round(ab + (bb - ab) * k);
}

function poly(g: G, pts: number[][], color: number, alpha: number): void {
    if (alpha <= 0) return;
    g.fillStyle(color, alpha);
    g.beginPath();
    g.moveTo(pts[0][0], pts[0][1]);
    for (let i = 1; i < pts.length; i++) g.lineTo(pts[i][0], pts[i][1]);
    g.closePath();
    g.fillPath();
}

function ell(g: G, x: number, y: number, rx: number, ry: number, color: number, alpha: number): void {
    if (alpha <= 0) return;
    g.fillStyle(color, alpha);
    g.fillEllipse(x, y, rx * 2, ry * 2);
}

/** Sampled elliptical arc stroke (Phaser's arc() is circular-only). */
function ringArc(
    g: G, cx: number, cy: number, rx: number, ry: number,
    a0: number, a1: number, width: number, color: number, alpha: number, segs = 16
): void {
    if (alpha <= 0) return;
    g.lineStyle(width, color, alpha);
    g.beginPath();
    for (let i = 0; i <= segs; i++) {
        const a = a0 + ((a1 - a0) * i) / segs;
        const x = cx + Math.cos(a) * rx;
        const y = cy + Math.sin(a) * ry;
        if (i === 0) g.moveTo(x, y); else g.lineTo(x, y);
    }
    g.strokePath();
}

// ───────────────────────────── level specs ───────────────────────────────

interface PylonSpec { k: 'N' | 'E' | 'S' | 'W'; h: number; w: number }
interface Spec {
    Ro: number; H: number; rimW: number;
    stone: { lit: number; mid: number; dark: number; top: number; joint: number };
    water: { deep: number; mid: number; core: number; glow: number };
    pad: { top: number; side: number; fleck: number };
    pylons: PylonSpec[];
    runes: boolean;
    icicles: number;
    gold: boolean;
    rough: boolean;
    payH: number; payW: number;
}

const SPECS: Spec[] = [
    { // L1 — fieldstone spring, two rough menhirs
        Ro: 31, H: 9, rimW: 5.5,
        stone: { lit: 0x9a9280, mid: 0x827a6a, dark: 0x625b4e, top: 0xa89f8c, joint: 0x544e43 },
        water: { deep: 0x173f52, mid: 0x225c72, core: 0x3a8ba2, glow: 0x77cede },
        pad: { top: 0x7d7860, side: 0x655f4c, fleck: 0xd9e6e2 },
        pylons: [{ k: 'E', h: 16, w: 4.5 }, { k: 'W', h: 16, w: 4.5 }],
        runes: false, icicles: 0, gold: false, rough: true,
        payH: 35, payW: 18,
    },
    { // L2 — dressed grey stone, the full henge, first icicles
        Ro: 33, H: 11, rimW: 6,
        stone: { lit: 0x9aa1ab, mid: 0x81888f, dark: 0x5d636d, top: 0xaab1ba, joint: 0x4d525b },
        water: { deep: 0x184a60, mid: 0x25687f, core: 0x429ab2, glow: 0x82dcea },
        pad: { top: 0x8b929b, side: 0x6e747d, fleck: 0xdfeaf0 },
        pylons: [{ k: 'N', h: 24, w: 5.5 }, { k: 'E', h: 19, w: 5 }, { k: 'W', h: 19, w: 5 }, { k: 'S', h: 12, w: 4.5 }],
        runes: false, icicles: 3, gold: false, rough: false,
        payH: 40, payW: 20,
    },
    { // L3 — dark stone + iron band, rune-lit menhirs, glint chase
        Ro: 35, H: 12, rimW: 6.5,
        stone: { lit: 0x767e8c, mid: 0x596070, dark: 0x3e4450, top: 0x828a99, joint: 0x30343d },
        water: { deep: 0x175070, mid: 0x257492, core: 0x47aac4, glow: 0x8ceaf6 },
        pad: { top: 0x5d646e, side: 0x474d56, fleck: 0xe2eef4 },
        pylons: [{ k: 'N', h: 30, w: 6 }, { k: 'E', h: 23, w: 5.5 }, { k: 'W', h: 23, w: 5.5 }, { k: 'S', h: 14, w: 5 }],
        runes: true, icicles: 6, gold: false, rough: false,
        payH: 45, payW: 22,
    },
    { // L4 — warm sandstone, gold ACCENTS only (inlay ring, menhir caps)
        Ro: 36, H: 13, rimW: 7,
        stone: { lit: 0xcdc4a9, mid: 0xbfb49a, dark: 0x9a8f78, top: 0xdcd3ba, joint: 0x86795f },
        water: { deep: 0x185878, mid: 0x2a80a0, core: 0x52b8d0, glow: 0x9ff2fa },
        pad: { top: 0xbfb49a, side: 0x9a8f78, fleck: 0xe9f2ee },
        pylons: [{ k: 'N', h: 32, w: 6 }, { k: 'E', h: 25, w: 5.5 }, { k: 'W', h: 25, w: 5.5 }, { k: 'S', h: 15, w: 5 }],
        runes: true, icicles: 5, gold: true, rough: false,
        payH: 45, payW: 22,
    },
];

// ─────────────────────────── shared sub-draws ─────────────────────────────

/**
 * The ice crystal — one visual language for the seed chip, the grown payload
 * and the flying projectile. Centered on (x, y); hw/hh are half extents.
 */
function crystal(g: G, x: number, y: number, hw: number, hh: number, alpha: number, glow: number): void {
    const t: number[] = [x, y - hh];
    const sR: number[] = [x + hw * 0.78, y - hh * 0.38];
    const wR: number[] = [x + hw, y + hh * 0.1];
    const bR: number[] = [x + hw * 0.42, y + hh * 0.78];
    const b: number[] = [x, y + hh];
    const bL: number[] = [x - hw * 0.42, y + hh * 0.78];
    const wL: number[] = [x - hw, y + hh * 0.1];
    const sL: number[] = [x - hw * 0.78, y - hh * 0.38];
    // silhouette (mid tone), then facets: NW light → left lit, right shaded
    poly(g, [t, sR, wR, bR, b, bL, wL, sL], 0x8fd0e6, alpha);
    poly(g, [t, sL, wL, bL, b], 0xbfe9f5, alpha);
    poly(g, [t, sR, wR, bR, b], 0x5fa8c6, alpha * 0.85);
    // bright central ridge
    poly(g, [t, [x + 1.2, y - hh * 0.3], [x + 0.8, y + hh * 0.72], b, [x - 0.8, y + hh * 0.72], [x - 1.2, y - hh * 0.3]],
        0xe9fbff, alpha * 0.95);
    // inner glow (over the opaque body — survives the bake's alpha snap)
    ell(g, x, y - hh * 0.05, hw * 0.5, hh * 0.34, 0x9ff2ff, (0.3 + 0.5 * glow) * alpha);
    // upper-left rim light
    g.lineStyle(1.3, 0xf2fdff, 0.9 * alpha);
    g.beginPath(); g.moveTo(t[0], t[1]); g.lineTo(sL[0], sL[1]); g.strokePath();
    if (glow > 0.55) ell(g, x, y - hh, 1.1, 1.1, 0xffffff, alpha * glow);
}

/** Side spurs for the big (L3+) payload — two small satellite diamonds. */
function crystalSpurs(g: G, x: number, y: number, hw: number, hh: number, alpha: number): void {
    for (const s of [-1, 1]) {
        const px = x + s * hw * 0.92, py = y + hh * 0.3, r = hw * 0.32;
        poly(g, [[px, py - r * 1.5], [px + r * 0.7, py], [px, py + r * 1.2], [px - r * 0.7, py]],
            s < 0 ? 0xbfe9f5 : 0x6fb4cf, alpha);
        ell(g, px, py - r * 0.3, r * 0.35, r * 0.5, 0xdff7ff, alpha * 0.9);
    }
}

/** A standing stone (menhir): tapered iso obelisk, two visible faces + tip. */
function menhir(
    g: G, x: number, y: number, h: number, w: number,
    stone: Spec['stone'], alpha: number, frost: number,
    rune: boolean, runeGlow: number, gold: boolean
): void {
    const wy = w * 0.5, s = 0.55, apexH = h + w * 1.2;
    const bf = [x, y], br = [x + w, y - wy], bl = [x - w, y - wy];
    const tf = [x, y - h], tr = [x + w * s, y - wy * s - h], tl = [x - w * s, y - wy * s - h];
    const apex = [x, y - apexH];
    const lit = mix(stone.lit, 0xdfeef2, frost * 0.3);
    const dark = mix(stone.dark, 0xb9cdd3, frost * 0.22);
    poly(g, [bf, br, tr, tf], dark, alpha);              // SE face (shaded)
    poly(g, [bl, bf, tf, tl], lit, alpha);               // SW face (lit)
    if (gold) {                                          // L4: small gold cap only
        poly(g, [tf, tr, apex], 0xb8860b, alpha);
        poly(g, [tl, tf, apex], 0xdaa520, alpha);
        ell(g, x, y - apexH + 1, 0.9, 0.9, 0xffd700, alpha * 0.95);
    } else {
        poly(g, [tf, tr, apex], mix(dark, stone.mid, 0.4), alpha);
        poly(g, [tl, tf, apex], mix(lit, 0xffffff, 0.12), alpha);
    }
    // one chipped notch on the lit face (static character)
    poly(g, [[x - w * 0.55, y - h * 0.45], [x - w * 0.2, y - h * 0.52], [x - w * 0.38, y - h * 0.32]],
        stone.mid, alpha * 0.9);
    // frost cap creeping down the crown
    poly(g, [tl, tf, [x, y - h - w * 0.5], [x - w * s * 0.7, y - wy * s - h + 1]],
        0xe4f2f6, alpha * (0.35 + frost * 0.5));
    if (rune) {                                          // vertical rune bar with a diamond eye mid-bar
        const rx = x - w * 0.42, ry = y - h * 0.66;
        const bh = h * 0.36, my = ry + bh * 0.45;
        const rc = mix(0x2b4854, 0x9ff2ff, runeGlow);
        g.fillStyle(rc, alpha);
        g.fillRect(rx - 0.8, ry, 1.6, bh);
        poly(g, [[rx, my - 2.6], [rx + 2, my], [rx, my + 2.6], [rx - 2, my]], rc, alpha);
        if (runeGlow > 0.4) ell(g, rx, my, 2.8, 3.1, 0x9ff2ff, alpha * (runeGlow - 0.28) * 0.55);
    }
}

/** Basin rim annulus. front=false paints the whole top; front=true repaints
 *  only the front half (drawn again over the payload for correct occlusion). */
function rimAnnulus(
    g: G, cx: number, yTop: number, Ro: number, Ri: number,
    S: Spec, alpha: number, frost: number, front: boolean
): void {
    const topC = mix(S.stone.top, 0xdfeef2, frost * 0.35);
    if (!front) {
        ell(g, cx, yTop, Ro, Ro * 0.5, topC, alpha);
    } else {
        g.fillStyle(topC, alpha);
        g.beginPath();
        const SEG = 18;
        for (let i = 0; i <= SEG; i++) {
            const a = (Math.PI * i) / SEG;
            g.lineTo(cx + Math.cos(a) * Ro, yTop + Math.sin(a) * Ro * 0.5);
            if (i === 0) g.moveTo(cx + Ro, yTop);
        }
        for (let i = SEG; i >= 0; i--) {
            const a = (Math.PI * i) / SEG;
            g.lineTo(cx + Math.cos(a) * Ri, yTop + Math.sin(a) * Ri * 0.5);
        }
        g.closePath();
        g.fillPath();
    }
    // mortar joints (stone-block read); front pass re-strokes only front ones
    const K = S.rough ? 9 : 12;
    g.lineStyle(S.rough ? 1.6 : 1.1, S.stone.joint, alpha * 0.85);
    for (let k = 0; k < K; k++) {
        const a = (TAU * k) / K + 0.26;
        const sn = Math.sin(a);
        if (front && sn < 0.12) continue;
        g.beginPath();
        g.moveTo(cx + Math.cos(a) * (Ri + 0.5), yTop + sn * (Ri + 0.5) * 0.5);
        g.lineTo(cx + Math.cos(a) * (Ro - 0.5), yTop + sn * (Ro - 0.5) * 0.5);
        g.strokePath();
    }
    if (S.rough) {
        // fieldstone: alternate darker stones between joints
        const Rm = (Ro + Ri) / 2, rw = (Ro - Ri) * 0.42;
        for (let k = 0; k < K; k += 2) {
            const a = (TAU * k) / K + 0.26 + TAU / (K * 2);
            const sn = Math.sin(a);
            if (front && sn < 0.12) continue;
            if (!front && sn >= 0.12) continue; // owned by the front pass
            ell(g, cx + Math.cos(a) * Rm, yTop + sn * Rm * 0.5, rw, rw * 0.5, mix(topC, S.stone.dark, 0.3), alpha);
        }
    }
    // NW back-edge highlight / dark inner lip
    if (!front) {
        ringArc(g, cx, yTop, Ro - 0.6, (Ro - 0.6) * 0.5, Math.PI * 1.05, Math.PI * 1.6, 1.3,
            mix(S.stone.lit, 0xffffff, 0.25), alpha * 0.8);
    }
    // frost flecks along the rim (static positions)
    if (S.icicles > 0 || frost > 0.05) {
        const n = 6;
        for (let k = 0; k < n; k++) {
            const a = 0.5 + k * (TAU / n);
            const sn = Math.sin(a);
            if (front !== sn >= 0.12) continue;
            const Rm = Ro - S.rimW * 0.5;
            g.fillStyle(S.pad.fleck, alpha * (0.55 + frost * 0.4));
            g.fillRect(cx + Math.cos(a) * Rm - 0.8, yTop + sn * Rm * 0.5 - 0.5, 1.7, 1.1);
        }
    }
    // L4 gold inlay ring (accent only)
    if (S.gold) {
        const Rg = Ri + 2.2;
        if (!front) ringArc(g, cx, yTop, Rg, Rg * 0.5, Math.PI, TAU, 1.5, 0xdaa520, alpha * 0.95);
        else ringArc(g, cx, yTop, Rg, Rg * 0.5, 0, Math.PI, 1.5, 0xdaa520, alpha * 0.95);
    }
}

// ───────────────────────────── the design ────────────────────────────────

export function drawFrostfallA(
    graphics: G,
    c1: V2, c2: V2, c3: V2, c4: V2,
    center: V2,
    alpha: number,
    _tint: number | null,
    building: any,
    baseGraphics: G | undefined,
    skipBase: boolean,
    onlyBase: boolean,
    time: number
): void {
    const level = Math.max(1, Math.min(4, Number(building?.level) || 1));
    const S = SPECS[level - 1];
    const cx = center.x, cy = center.y;
    const Ro = S.Ro, Ri = Ro - S.rimW, H = S.H;
    const yTop = cy - H;
    const yW = yTop + 2.5;              // water surface
    const baseR = Ro - 2.5;             // basin flares slightly outward at the lip

    // henge anchor points (corner-lerped so the geometry follows the plot)
    const T = 0.8;
    const anchor = (k: PylonSpec['k']): number[] => {
        const c = k === 'N' ? c1 : k === 'E' ? c2 : k === 'S' ? c3 : c4;
        return [cx + (c.x - cx) * T, cy + (c.y - cy) * T];
    };
    const pylons = S.pylons.map(p => ({ ...p, x: anchor(p.k)[0], y: anchor(p.k)[1] }));

    // ── BASE (ground paint — STATIC, baked once into the ground texture) ──
    if (!skipBase) {
        const g = baseGraphics || graphics;
        // ONE soft contact shadow, biased SE (light from NW)
        ell(g, cx, cy + 2, 44, 21, 0x1c2a14, 0.3 * alpha);
        // compact chamfered pad (octagon ≈ 0.66 of footprint), level material
        const padRx = 42, padRy = 21;
        const oct = (rx: number, ry: number, dy: number): number[][] => {
            const pts: number[][] = [];
            for (let k = 0; k < 8; k++) {
                const a = (TAU * k) / 8 + TAU / 16;
                pts.push([cx + Math.cos(a) * rx, cy + dy + Math.sin(a) * ry]);
            }
            return pts;
        };
        poly(g, oct(padRx, padRy, 1.8), S.pad.side, alpha);
        poly(g, oct(padRx, padRy, 0), S.pad.top, alpha);
        if (!S.rough) {
            // paving joints toward the flats (static)
            g.lineStyle(1.1, S.pad.side, alpha * 0.8);
            for (let k = 0; k < 8; k++) {
                const a = (TAU * k) / 8 + TAU / 16;
                g.beginPath();
                g.moveTo(cx + Math.cos(a) * padRx * 0.5, cy + Math.sin(a) * padRy * 0.5);
                g.lineTo(cx + Math.cos(a) * padRx * 0.96, cy + Math.sin(a) * padRy * 0.96);
                g.strokePath();
            }
        }
        // frost dusting on the pad (static flecks, hugging the basin)
        for (let k = 0; k < 7; k++) {
            const a = 0.35 + k * (TAU / 7);
            const r = 0.82 + 0.1 * ((k * 5) % 3) / 2;
            g.fillStyle(S.pad.fleck, alpha * 0.6);
            g.fillRect(cx + Math.cos(a) * padRx * r * 0.88 - 0.9, cy + Math.sin(a) * padRy * r * 0.88 - 0.6, 1.8, 1.2);
        }
        // L4: gold edging along the two front pad edges only (accent)
        if (S.gold) {
            const p = oct(padRx, padRy, 0);
            g.lineStyle(1.4, 0xdaa520, alpha * 0.9);
            g.beginPath(); g.moveTo(p[0][0], p[0][1]); g.lineTo(p[1][0], p[1][1]); g.lineTo(p[2][0], p[2][1]); g.strokePath();
        }
        // menhir contact shadows (outside the pad, clear of the main ellipse)
        for (const p of pylons) {
            ell(g, p.x, p.y + 1, p.w + 1.5, (p.w + 1.5) * 0.5, 0x1c2a14, 0.25 * alpha);
        }
    }
    if (onlyBase) return;

    // ── sim state (pure inputs; missing lastFireTime ⇒ ready/idle) ──
    const lastFire = Number(building?.lastFireTime);
    const hasFired = Number.isFinite(lastFire);
    const age = hasFired ? time - lastFire : Infinity;
    const active = building?.frostfallProjectileActive === true;

    const inPrep = age >= 0 && age < PREP_MS;
    const prepT = inPrep ? age / PREP_MS : 0;
    const charge = inPrep ? smooth(age / 800) : 0;                       // awaken ramp
    const grow = inPrep ? smooth((age - 500) / 3300) : 0;                // shard growth
    const arm = inPrep ? clamp01((age - 3800) / 400) : 0;                // arming flare
    const burst = active && age >= PREP_MS && age < SETTLE_MS ? clamp01((age - PREP_MS) / 700) : -1;
    const sink = !active && age >= PREP_MS && age < IMPACT_MS ? (age - PREP_MS) / 600 : -1;
    // prep vortex adds EXACTLY 3 revolutions by 4200 ms → seamless idle hand-off
    const extraAng = inPrep ? TAU * 3 * prepT * prepT : 0;
    const runeGlowFire = inPrep ? Math.max(charge * 0.9, arm) : burst >= 0 ? (1 - burst) : 0;

    // ── 1. back henge (N behind the basin, E/W beside it) ──
    for (const p of pylons) {
        if (p.k === 'S') continue;
        const idleRune = 0.35 + 0.35 * (0.5 + 0.5 * Math.sin((TAU * time) / P + (p.k === 'E' ? 1.4 : p.k === 'W' ? 3.1 : 0)));
        menhir(graphics, p.x, p.y, p.h, p.w, S.stone, alpha,
            level >= 2 ? 0.35 + grow * 0.5 : 0.15 + grow * 0.5,
            S.runes, Math.max(idleRune * (S.runes ? 1 : 0), runeGlowFire), S.gold);
    }

    // ── 2. basin wall (shaded cylinder segments) + iron band (L3) ──
    const frost = grow * 0.9;
    const SEG = 10;
    for (let i = 0; i < SEG; i++) {
        const a0 = (Math.PI * i) / SEG, a1 = (Math.PI * (i + 1)) / SEG;
        const tt = 0.5 - 0.5 * Math.cos((a0 + a1) / 2);
        const col = tt > 0.72 ? S.stone.lit : tt > 0.34 ? S.stone.mid : S.stone.dark;
        poly(graphics, [
            [cx + Math.cos(a0) * baseR, cy + Math.sin(a0) * baseR * 0.5],
            [cx + Math.cos(a1) * baseR, cy + Math.sin(a1) * baseR * 0.5],
            [cx + Math.cos(a1) * Ro, yTop + Math.sin(a1) * Ro * 0.5],
            [cx + Math.cos(a0) * Ro, yTop + Math.sin(a0) * Ro * 0.5],
        ], mix(col, 0xdfeef2, frost * 0.2), alpha);
    }
    // sparse vertical masonry joints on the wall
    graphics.lineStyle(1.1, S.stone.joint, alpha * 0.7);
    for (const k of [2, 5, 8]) {
        const a = (Math.PI * k) / SEG;
        graphics.beginPath();
        graphics.moveTo(cx + Math.cos(a) * baseR, cy + Math.sin(a) * baseR * 0.5);
        graphics.lineTo(cx + Math.cos(a) * Ro, yTop + Math.sin(a) * Ro * 0.5);
        graphics.strokePath();
    }
    if (level === 3) { // iron band under the lip
        ringArc(graphics, cx, yTop + 1.6, Ro - 0.4, (Ro - 0.4) * 0.5, 0.06, Math.PI - 0.06, 1.7, 0x2e323a, alpha * 0.95);
    }

    // ── 3. rim (full) + interior + water ──
    rimAnnulus(graphics, cx, yTop, Ro, Ri, S, alpha, frost, false);
    ell(graphics, cx, yTop, Ri, Ri * 0.5, 0x0d2531, alpha);              // inner void (back crescent stays)

    // water body — dips during the geyser, drains dark while arming
    const dip = burst >= 0 ? 1.5 * (1 - burst) : 0;
    const drain = arm * 0.5 + (burst >= 0 ? (1 - burst) * 0.35 : 0);
    const Wr = Ri - 1.5;
    ell(graphics, cx, yW + dip, Wr, Wr * 0.5, mix(mix(S.water.deep, 0x9fdcec, charge * 0.12), 0x0d2531, drain), alpha);
    ell(graphics, cx, yW + dip + 0.5, Wr * 0.72, Wr * 0.36, mix(mix(S.water.mid, 0xbfeef8, charge * 0.15), 0x123340, drain), alpha);
    // breathing core (k=1 size, k=2 colour — both exact harmonics of P)
    const coreCol = mix(mix(S.water.core, S.water.glow, 0.5 + 0.5 * Math.sin((TAU * 2 * time) / P)), 0xc9f9ff, charge * 0.5);
    const coreR = (Wr * 0.34 + 0.8 * Math.sin((TAU * time) / P + 1.3)) * (1 - arm * 0.45) * (burst >= 0 ? 0.55 + 0.45 * burst : 1);
    ell(graphics, cx, yW + dip, coreR, coreR * 0.5, mix(coreCol, 0x123340, drain * 0.8), alpha);

    // orbiting ripple dashes (the vortex — accelerates through prep)
    for (let i = 0; i < 6; i++) {
        const rr = Wr * (0.38 + 0.17 * (i % 3)) * (1 - grow * 0.32);
        const a = i * 2.62 + TAU * frac(time / P) + extraAng;
        const dx = Math.cos(a) * rr, dy = Math.sin(a) * rr * 0.5;
        ell(graphics, cx + dx, yW + dip + dy, 2.6, 1.1,
            mix(0x6fc4d8, 0xd9f6ff, charge * 0.8 + 0.15 * (i % 2)), alpha * (0.72 + charge * 0.2));
    }
    // two counter-phased surface glints
    for (const s of [0, Math.PI]) {
        const a = TAU * frac(time / P) + s + 0.9 + extraAng;
        ell(graphics, cx + Math.cos(a) * Wr * 0.55, yW + dip + Math.sin(a) * Wr * 0.275, 1.7, 0.9,
            0xd8f8ff, alpha * 0.9);
    }

    // ── 4. the payload — seed chip ⇄ grown shard ⇄ absent/sunk ──
    const payHw = S.payW / 2, payHh = S.payH / 2;
    const seedHw = 3.2, seedHh = 5;
    const bob = 1.5 * Math.sin((TAU * time) / P);                        // ±1.5 px (k=1)
    if (burst < 0 && !active) {
        if (sink >= 0) {
            // abort: the grown shard sinks back into the spring
            const s = clamp01(sink);
            const sc = 1 - 0.55 * s;
            crystal(graphics, cx, cy - 10 + s * 16, payHw * sc, payHh * sc, alpha, 0.6 * (1 - s));
        } else if (inPrep) {
            // growth: seed → full payload, symmetric about the spawn point
            // (cx, cy-10); at age 4200 the crystal is EXACTLY the embedded-
            // payload envelope, centred on the MainScene spawn constant.
            const hw = seedHw + (payHw - seedHw) * grow;
            const hh = seedHh + (payHh - seedHh) * grow;
            const yC = (yW - 2 + bob) * (1 - grow) + (cy - 10) * grow;
            const vib = Math.sin((TAU * age) / 125) * 1.1 * arm * (1 - clamp01((age - 4150) / 50));
            // arming halo behind the crystal (over opaque water — bake-safe)
            if (arm > 0.02) ell(graphics, cx, cy - 12, 15 + 7 * arm, (15 + 7 * arm) * 0.55, 0x9ff2ff, alpha * (0.2 + 0.3 * arm));
            crystal(graphics, cx + vib, yC, hw, hh, alpha, 0.35 + charge * 0.3 + arm * 0.35);
            if (level >= 3 && grow > 0.85) crystalSpurs(graphics, cx + vib, yC, hw, hh, alpha * clamp01((grow - 0.85) / 0.15));
        } else {
            // ready idle: the floating seed chip, bobbing on the spring
            const re = age >= IMPACT_MS && age < IMPACT_MS + 150 ? (age - IMPACT_MS) / 150 : 1;
            crystal(graphics, cx, yW - 2 + bob, seedHw * re, seedHh * re, alpha,
                0.3 + 0.3 * (0.5 + 0.5 * Math.sin((TAU * 2 * time) / P + 0.7)));
        }
    }

    // frost arcs: menhir tips feed the growing crystal
    if (inPrep && grow > 0.05) {
        for (let i = 0; i < pylons.length; i++) {
            const p = pylons[i];
            if (Math.sin((TAU * age) / 450 + i * 2.4) <= 0.15) continue;
            const x1 = p.x, y1 = p.y - p.h - p.w * 1.2 + 2;
            const yC = (yW - 2) * (1 - grow) + (cy - 10) * grow;
            const x2 = cx, y2 = yC - (seedHh + (payHh - seedHh) * grow) + 2;
            graphics.lineStyle(1.4, 0xa8ecff, alpha * 0.85);
            graphics.beginPath();
            graphics.moveTo(x1, y1);
            for (let s = 1; s <= 3; s++) {
                const t2 = s / 4;
                const jx = Math.sin((TAU * age) / 250 + i * 1.7 + s * 2.3) * 3.4;
                const jy = Math.cos((TAU * age) / 320 + i + s) * 2.2 + 1.5;
                graphics.lineTo(x1 + (x2 - x1) * t2 + jx, y1 + (y2 - y1) * t2 + jy);
            }
            graphics.lineTo(x2, y2);
            graphics.strokePath();
            ell(graphics, x1, y1, 1.5, 1.2, 0xd9f6ff, alpha * 0.9);
        }
    }

    // ── 5. geyser burst (payload absent — the spring hurls it) ──
    if (burst >= 0) {
        const b = burst;
        // the geyser column — violent while the shard rides it out, collapsing after
        if (b < 0.55) {
            const k = b / 0.55;
            const colH = (34 + level * 3) * (1 - k * k);
            const colW = 12.5 * (1 - 0.45 * k);
            poly(graphics, [[cx - colW * 0.5, yW + 1], [cx + colW * 0.5, yW + 1],
                [cx + colW * 0.34, yW - colH], [cx - colW * 0.34, yW - colH]], 0x9fdcec, alpha * 0.92);
            poly(graphics, [[cx - colW * 0.26, yW + 1], [cx + colW * 0.26, yW + 1],
                [cx + colW * 0.15, yW - colH * 0.92], [cx - colW * 0.15, yW - colH * 0.92]], 0xe4f9ff, alpha * 0.95);
            // bulged plume head
            ell(graphics, cx, yW - colH, colW * 0.75, colW * 0.42, 0xf0fcff, alpha * 0.92);
            ell(graphics, cx - colW * 0.35, yW - colH + 1.5, colW * 0.32, colW * 0.2, 0xd9f2fa, alpha * 0.9);
            ell(graphics, cx + colW * 0.38, yW - colH + 2, colW * 0.28, colW * 0.18, 0xd9f2fa, alpha * 0.9);
        }
        // radial ice needles kicked out at the instant of launch
        if (b < 0.3) {
            const nb = b / 0.3;
            for (let i = 0; i < 6; i++) {
                const a = (i * TAU) / 6 + 0.26;
                const d = 8 + 24 * nb;
                const nx = cx + Math.cos(a) * d, ny = yW - 6 - 14 * nb * (1 - nb * 0.5) + Math.sin(a) * d * 0.5;
                const ex = Math.cos(a) * 4.5, ey = Math.sin(a) * 2.2 - 2.5 * (1 - nb);
                graphics.lineStyle(1.5, 0xcff2fc, alpha * (0.95 - 0.5 * nb));
                graphics.beginPath(); graphics.moveTo(nx, ny); graphics.lineTo(nx + ex, ny + ey); graphics.strokePath();
            }
        }
        // ballistic spray droplets
        const bb = clamp01(b * 1.25);
        for (let i = 0; i < 8; i++) {
            const h = (66 + 8 * (i % 2)) * bb - 84 * bb * bb;
            if (h < -3) continue;
            const dirx = Math.cos((i * TAU) / 8 + 0.5);
            const spread = 14 + 5 * ((i * 2) % 3);
            ell(graphics, cx + dirx * spread * bb, yW - h - 4, 2.1, 1.4, 0xdff5fc, alpha * 0.92);
        }
        // expanding chill ring — the AoE/knockback telegraph, racing past the rim
        if (b < 0.55) {
            const rr = Ri + (Ro - Ri + 26) * (b / 0.55);
            ringArc(graphics, cx, yTop + 1.5, rr, rr * 0.5, 0, TAU, 3, 0xe8fbff, alpha * (0.95 - 0.7 * (b / 0.55)), 26);
        }
    }

    // ── 6. front rim repaint (occludes the payload base correctly) ──
    rimAnnulus(graphics, cx, yTop, Ro, Ri, S, alpha, frost, true);
    ringArc(graphics, cx, yTop, Ro - 0.5, (Ro - 0.5) * 0.5, 0.12, Math.PI - 0.12, 1.2,
        mix(S.stone.lit, 0xffffff, 0.15), alpha * 0.7);

    // charge-light racing the rim during prep (the visible telegraph)
    if (inPrep && charge > 0.05) {
        const Rm = Ro - S.rimW * 0.5;
        for (const off of [0, Math.PI]) {
            for (let tr = 0; tr < 3; tr++) {
                const a = TAU * (age / 650) * (0.8 + 0.9 * prepT) + off - tr * 0.2;
                ell(graphics, cx + Math.cos(a) * Rm, yTop + Math.sin(a) * Rm * 0.5,
                    1.7 - tr * 0.3, 1.1 - tr * 0.2,
                    mix(0x9fe8f6, 0xffffff, prepT), alpha * charge * (1 - tr * 0.22));
            }
        }
    }

    // ── 7. icicles on the front rim (+ tip-glint chase at L3+) ──
    if (S.icicles > 0) {
        const chase = Math.floor(frac(time / P) * S.icicles);            // discrete hop, period P
        for (let k = 0; k < S.icicles; k++) {
            const a = Math.PI * (0.2 + (0.6 * k) / Math.max(1, S.icicles - 1));
            const ix = cx + Math.cos(a) * (Ro - 0.5);
            const iy = yTop + Math.sin(a) * (Ro - 0.5) * 0.5 + 1;
            const len = 4 + ((k * 2.7) % 3.5) + (level >= 3 ? 1.5 : 0);
            poly(graphics, [[ix - 1.4, iy], [ix + 1.4, iy], [ix + 0.1, iy + len]], 0xd6eef8, alpha);
            graphics.lineStyle(1, 0xeffaff, alpha * 0.9);
            graphics.beginPath(); graphics.moveTo(ix - 1, iy + 0.5); graphics.lineTo(ix - 0.2, iy + len - 1); graphics.strokePath();
            if (level >= 3 && k === chase) ell(graphics, ix + 0.1, iy + len, 1.2, 1.2, 0xffffff, alpha * 0.95);
        }
    }

    // ── 8. L4 gold glint orbiting the inlay (k=1 harmonic accent) ──
    if (S.gold) {
        const Rg = Ri + 2.2;
        const a = TAU * frac(time / P) + 2.0;
        const gx = cx + Math.cos(a) * Rg, gy = yTop + Math.sin(a) * Rg * 0.5;
        ell(graphics, gx, gy, 1.5, 0.9, 0xffd700, alpha * 0.95);
        const a2 = a - 0.3;
        ell(graphics, cx + Math.cos(a2) * Rg, yTop + Math.sin(a2) * Rg * 0.5, 1, 0.6, 0xdaa520, alpha * 0.8);
    }

    // ── 9. mist wisps rising off the spring (sawtooth in frac(time/P)) ──
    const wisps = level === 1 ? 2 : 3;
    for (let i = 0; i < wisps; i++) {
        const u = frac(time / P + i / wisps);
        const a = i * (TAU / wisps) + 0.7 + u * 0.8;
        const r = (Ro + 2) * (1 - arm * 0.25);
        const wx = cx + Math.cos(a) * r;
        const wy = yTop + 2 + Math.sin(a) * r * 0.5 - u * 13;
        const sz = 3 * Math.sin(Math.PI * u) * (1 + charge * 0.4);
        if (sz > 0.6) {
            ell(graphics, wx, wy, sz * 1.15, sz * 0.55, 0xe6f3f8, alpha * 0.6);
            ell(graphics, wx + sz * 0.6, wy - sz * 0.35, sz * 0.65, sz * 0.38, 0xf0f8fb, alpha * 0.6);
        }
    }

    // ── 10. the south menhir last (in front of the basin lip) ──
    for (const p of pylons) {
        if (p.k !== 'S') continue;
        const idleRune = 0.35 + 0.35 * (0.5 + 0.5 * Math.sin((TAU * time) / P + 4.4));
        menhir(graphics, p.x, p.y, p.h, p.w, S.stone, alpha, 0.35 + grow * 0.5,
            S.runes, Math.max(idleRune * (S.runes ? 1 : 0), runeGlowFire), S.gold);
    }
}

/**
 * THE ICE SHARD — matching-kit projectile (vector fallback / bake source).
 * Same mechanical envelope as the incumbent: drawn centred on (0,0), upright
 * at rotation 0, sized to the embedded-payload constants 35/40/45 px tall ×
 * 18/20/22 px wide for level 1/2/3+ (callers pass min(buildingLevel, 3)).
 * Styled as the Winterspring's grown crystal — identical facet language, so
 * launch/flight/impact read as one object.
 */
export function drawFrostfallShardA(g: Phaser.GameObjects.Graphics, level: number): void {
    const l = Math.max(1, Math.min(3, Number(level) || 1));
    const hh = [17.5, 20, 22.5][l - 1];
    const hw = [9, 10, 11][l - 1];
    crystal(g, 0, 0, hw, hh, 1, 0.75);
    if (l >= 3) crystalSpurs(g, 0, 0, hw, hh, 1);
    // trailing frost chips off the tail (part of the rigid silhouette)
    ell(g, -hw * 0.5, hh * 0.95, 1.4, 1, 0xbfe9f5, 0.95);
    ell(g, hw * 0.42, hh * 1.1, 1.1, 0.8, 0x9fdcec, 0.9);
}
