import type Phaser from 'phaser';

/**
 * FROSTFALL — CLEAN-ROOM DESIGN B: "THE FROSTWELL"
 *
 * Concept: not a machine — a breached glacial wellspring. A low ring of
 * quarried stone caps a natural cold vent; inside it a pool of glacial melt
 * glows pale blue, crowned by outward-leaning rime teeth grown from the rim.
 * The 4200 ms preparation IS the weapon: the pool churns awake, a hex shard
 * crystallises up out of the water, trembles at full charge, and the geyser
 * bursts and hurls it skyward. Radially symmetric — reads omnidirectional at
 * a glance (single-angle bake, no barrel, nothing to aim).
 *
 * Levels: L1 rough fieldstone spring (4 teeth) → L2 dressed stone + iron
 * bands (6 teeth) → L3 dark basalt glacier-mouth with glowing rim runnels
 * (8 teeth) → L4 warm sandstone crown, gold compass caps + tooth ferrules
 * (8 tall teeth; gold/white strictly as accents).
 *
 * MainScene couplings honoured (shootFrostfallShard):
 *  - the projectile spawns at (center.x, center.y - 10) exactly 4200 ms after
 *    lastFireTime. At that instant the drawn shard's visible body spans
 *    waterline → (center.y - 10 - H/2): exactly the above-water part of the
 *    spawned projectile (H = 35/40/45 for min(level,3)), so launch is
 *    positionally and dimensionally continuous.
 *  - whenever building.frostfallProjectileActive (or fireAge >= 4200 ms) the
 *    payload is absent from the building.
 *
 * Ambient contract: ONE idle period IDLE_MS = 2000 ms (a 250 ms multiple);
 * every idle term is an exact harmonic (k = 1 or 2 sines, or a phase-locked
 * chase/ripple that completes one life per period and lands invisible at the
 * seam). Quantization survival: the pool breath swings > 16/255 on the
 * green/blue channels across the whole pool (~10% of texels), seed crystals
 * bob ±1.8 px, two ice motes orbit at ~Ri·0.45 px, the ripple ring sweeps
 * ~14–19 px of radius — all far above the probe thresholds.
 *
 * Pure function of (time, level, lastFireTime, frostfallProjectileActive):
 * no internal state, no Math.random, no Date.now. time === 0 renders the
 * deterministic ready pose (postcards / static captures).
 */

type G = Phaser.GameObjects.Graphics;
type V2 = Phaser.Math.Vector2;

const TAU = Math.PI * 2;
/** The single ambient period — every idle term is an exact harmonic of it. */
const IDLE_MS = 2000;
/** Immovable MainScene constant: projectile spawn at lastFireTime + 4200. */
const LAUNCH_MS = 4200;
/** End of the on-building settle; >= this is the idle/ready pose. */
const FIRE_END_MS = 4700;
/** Waterline sits this far below the rim-top plane. */
const POOL_DROP = 3;

// ------------------------------------------------------------- tiny helpers

function clamp01(v: number): number {
    return v < 0 ? 0 : v > 1 ? 1 : v;
}

function mixc(a: number, b: number, t: number): number {
    const u = clamp01(t);
    const ar = (a >> 16) & 0xff, ag = (a >> 8) & 0xff, ab = a & 0xff;
    const br = (b >> 16) & 0xff, bg = (b >> 8) & 0xff, bb = b & 0xff;
    return (
        (Math.round(ar + (br - ar) * u) << 16) |
        (Math.round(ag + (bg - ag) * u) << 8) |
        Math.round(ab + (bb - ab) * u)
    );
}

function fillPoly(g: G, pts: number[][], color: number, a: number): void {
    if (a <= 0.004 || pts.length < 3) return;
    g.fillStyle(color, a);
    g.beginPath();
    g.moveTo(pts[0][0], pts[0][1]);
    for (let i = 1; i < pts.length; i++) g.lineTo(pts[i][0], pts[i][1]);
    g.closePath();
    g.fillPath();
}

function strokePts(g: G, pts: number[][], w: number, color: number, a: number): void {
    if (a <= 0.004 || pts.length < 2) return;
    g.lineStyle(w, color, a);
    g.beginPath();
    g.moveTo(pts[0][0], pts[0][1]);
    for (let i = 1; i < pts.length; i++) g.lineTo(pts[i][0], pts[i][1]);
    g.strokePath();
}

/** Sampled elliptical arc, screen coords (y down; θ∈(0,π) is the near arc). */
function arcPts(cx: number, cy: number, rx: number, ry: number, t0: number, t1: number, n: number): number[][] {
    const pts: number[][] = [];
    for (let i = 0; i <= n; i++) {
        const t = t0 + ((t1 - t0) * i) / n;
        pts.push([cx + Math.cos(t) * rx, cy + Math.sin(t) * ry]);
    }
    return pts;
}

/** Chunky screen-space diamond (sparkles, droplets, motes). */
function diamond(g: G, x: number, y: number, r: number, color: number, a: number): void {
    fillPoly(g, [[x, y - r], [x + r * 0.8, y], [x, y + r], [x - r * 0.8, y]], color, a);
}

/** Concentric iso ring on the pool plane (2:1 squash). */
function poolRing(g: G, cx: number, cy: number, r: number, w: number, color: number, a: number): void {
    if (a <= 0.01 || r <= 0.6) return;
    g.lineStyle(w, color, a);
    g.strokeEllipse(cx, cy, r * 2, r);
}

// -------------------------------------------------------------- level table

interface FrostLv {
    rx: number;      // outer rim radius (screen x; y is half)
    rim: number;     // rim ring thickness
    h: number;       // rim height above the lawn
    segs: number;    // stone segments around the ring
    teeth: number;   // rime teeth on the crown
    toothH: number;
    toothW: number;
    lean: number;    // outward lean of each tooth
    toothOff: number;
    stoneTop: number; stoneLit: number; stoneDark: number; seam: number;
    padTop: number; padEdge: number; padTrim: number | null;
    poolLo: number; poolHi: number;
    iceLit: number; iceDark: number; iceCore: number;
    iron: boolean; runnels: boolean; gold: boolean; rugged: boolean;
}

const LEVELS: FrostLv[] = [
    { // L1 — the cracked spring: rough fieldstone, four grown teeth
        rx: 34, rim: 11, h: 10, segs: 8, teeth: 4, toothH: 13, toothW: 6, lean: 7, toothOff: Math.PI / 4,
        stoneTop: 0x7f7668, stoneLit: 0x6b6355, stoneDark: 0x4f4941, seam: 0x39342c,
        padTop: 0x8a7a5e, padEdge: 0x6b5f49, padTrim: null,
        poolLo: 0x1b3d54, poolHi: 0x2e6a92,
        iceLit: 0xd7ecf7, iceDark: 0xa2cde3, iceCore: 0x74bede,
        iron: false, runnels: false, gold: false, rugged: true
    },
    { // L2 — the bound well: dressed stone, iron bands, six teeth
        rx: 36, rim: 11, h: 14, segs: 10, teeth: 6, toothH: 16, toothW: 6.5, lean: 8, toothOff: Math.PI / 6,
        stoneTop: 0x8b919a, stoneLit: 0x71777f, stoneDark: 0x51565e, seam: 0x3a3e45,
        padTop: 0x8d9198, padEdge: 0x63676d, padTrim: null,
        poolLo: 0x1d445f, poolHi: 0x30719a,
        iceLit: 0xd9eef8, iceDark: 0xa4cfe4, iceCore: 0x74bede,
        iron: true, runnels: false, gold: false, rugged: false
    },
    { // L3 — the glacier mouth: dark basalt, glowing runnels, eight teeth
        rx: 38, rim: 12, h: 16, segs: 10, teeth: 8, toothH: 20, toothW: 7, lean: 9, toothOff: Math.PI / 8,
        stoneTop: 0x5e666f, stoneLit: 0x4a515a, stoneDark: 0x343941, seam: 0x24282e,
        padTop: 0x565c66, padEdge: 0x3b4048, padTrim: null,
        poolLo: 0x1f4c6c, poolHi: 0x357daa,
        iceLit: 0xe0f3fb, iceDark: 0x9cd0e8, iceCore: 0x58a8d4,
        iron: false, runnels: true, gold: false, rugged: false
    },
    { // L4 — winter's crown: warm sandstone, gold compass caps + ferrules
        rx: 40, rim: 12, h: 18, segs: 12, teeth: 8, toothH: 24, toothW: 7.5, lean: 10, toothOff: Math.PI / 8,
        stoneTop: 0xc9c2ae, stoneLit: 0xbfb49a, stoneDark: 0x8f8672, seam: 0x776f5c,
        padTop: 0xbfb49a, padEdge: 0x8f8672, padTrim: 0xdaa520,
        poolLo: 0x215373, poolHi: 0x3d88b9,
        iceLit: 0xe6f6fd, iceDark: 0x93c9e6, iceCore: 0x5cb0dc,
        iron: false, runnels: true, gold: true, rugged: false
    }
];

/** Embedded-payload envelope MainScene stamps at impact (min(level,3)). */
const SHARD_H = [35, 40, 45, 45];
const SHARD_W = [18, 20, 22, 22];

// ---------------------------------------------------------------- the well

export function drawFrostfallB(
    graphics: Phaser.GameObjects.Graphics,
    c1: V2,
    c2: V2,
    c3: V2,
    c4: V2,
    center: V2,
    alpha: number,
    _tint: number | null,
    building: any,
    baseGraphics: Phaser.GameObjects.Graphics | undefined,
    skipBase: boolean,
    onlyBase: boolean,
    time: number
): void {
    const lvl = Math.max(1, Math.min(4, Math.round(Number(building && building.level) || 1)));
    const P = LEVELS[lvl - 1];
    const cx = center.x, cy = center.y;

    // ---------------------------------------------------------- ground pass
    {
        const g = baseGraphics || graphics;
        if (!skipBase) {
            // Soft chamfered contact shadow hugging the 2x2 base (no plate).
            const cham = (spread: number): number[][] => {
                const corners = [c1, c2, c3, c4].map(p => [
                    cx + (p.x - cx) * spread,
                    cy + 1 + (p.y - cy) * spread
                ]);
                const cut = 0.26;
                const poly: number[][] = [];
                for (let i = 0; i < 4; i++) {
                    const prev = corners[(i + 3) % 4];
                    const curr = corners[i];
                    const next = corners[(i + 1) % 4];
                    poly.push([curr[0] + (prev[0] - curr[0]) * cut, curr[1] + (prev[1] - curr[1]) * cut]);
                    poly.push([curr[0] + (next[0] - curr[0]) * cut, curr[1] + (next[1] - curr[1]) * cut]);
                }
                return poly;
            };
            fillPoly(g, cham(0.8), 0x18220f, alpha * 0.16);
            fillPoly(g, cham(0.58), 0x18220f, alpha * 0.13);

            // Compact chamfered pad (~0.7 of the plot), level-materialed.
            const padScale = 0.7, cut = 0.22;
            const pc = [c1, c2, c3, c4].map(p => [
                cx + (p.x - cx) * padScale,
                cy + (p.y - cy) * padScale
            ]);
            const ringPts: number[][] = [];
            for (let i = 0; i < 4; i++) {
                const a2 = pc[i], b2 = pc[(i + 1) % 4];
                ringPts.push([a2[0] + (b2[0] - a2[0]) * cut, a2[1] + (b2[1] - a2[1]) * cut]);
                ringPts.push([a2[0] + (b2[0] - a2[0]) * (1 - cut), a2[1] + (b2[1] - a2[1]) * (1 - cut)]);
            }
            fillPoly(g, ringPts.map(p => [p[0], p[1] + 2.5]), P.padEdge, alpha);
            fillPoly(g, ringPts, P.padTop, alpha);
            if (P.padTrim !== null) {
                strokePts(g, ringPts.concat([ringPts[0]]), 1.4, P.padTrim, alpha * 0.85);
            }
            // Rime creeping off the well onto the pad edge (static frost).
            for (let i = 0; i < 6; i++) {
                const a2 = i * 2.39996 + 0.7;
                const rr = 0.5 + 0.12 * (((i * 53) % 5) / 5);
                const sx = cx + Math.cos(a2) * 58 * rr;
                const sy = cy + Math.sin(a2) * 29 * rr;
                const sz = 1.6 + ((i * 29) % 3) * 0.5;
                g.fillStyle(0xd8ecf4, alpha * 0.5);
                g.fillRect(sx - sz / 2, sy - sz / 4, sz, sz / 2);
            }
        }
        if (onlyBase) return;
    }

    // ---------------------------------------------------- derived geometry
    const rx = P.rx, ry = rx * 0.5;
    const Ri = rx - P.rim;                 // rim inner (mouth) radius
    const ty = cy - P.h;                   // rim-top plane
    const wy = ty + POOL_DROP;             // waterline plane
    const Rw = Ri * 0.98;                  // water ellipse radius
    const ringMax = Ri * 0.94 - POOL_DROP * 2 - 1;
    const emergedMax = SHARD_H[lvl - 1] / 2 + 10 - P.h + POOL_DROP;

    // ------------------------------------------------------ ambient clock
    const tm = ((time % IDLE_MS) + IDLE_MS) % IDLE_MS;
    const ph = tm / IDLE_MS;               // 0..1, one exact 2000 ms cycle
    const phT = ph * TAU;
    const s1 = Math.sin(phT);              // k = 1 harmonic
    const s2 = Math.sin(phT * 2);          // k = 2 harmonic
    const breath = 0.5 + 0.5 * s1;

    // ---------------------------------------------------- fire-state model
    const lfRaw = Number(building ? building.lastFireTime : NaN);
    const fireAge = Number.isFinite(lfRaw) && time - lfRaw >= 0 ? time - lfRaw : Infinity;
    const projActive = !!(building && building.frostfallProjectileActive);

    let churn = 0;      // 0..1 awaken churn (0..800)
    let growU = 0;      // 0..1 crystallisation progress (800..4200)
    let grow = 0;       // emerged shard height in px
    let prime = 0;      // 0..1 final surge (3500..4200)
    let boost = 0;      // pool glow boost
    let toothB = 0;     // crown flare
    let sprayU = -1;    // geyser burst position (4200..4640)
    let settleU = -1;   // settle position (4200..4700)
    let seedShow = 1;   // dormant seed-cluster visibility
    let tremX = 0;      // pre-launch tremble

    if (fireAge < FIRE_END_MS) {
        if (fireAge < 800) {
            churn = fireAge / 800;
            boost = 0.35 * churn;
            toothB = 0.2 * churn;
            seedShow = 1 - churn;                 // the seed melts back in
        } else if (fireAge < LAUNCH_MS) {
            const u = (fireAge - 800) / 3400;
            growU = u;
            grow = emergedMax * Math.pow(u, 0.85);
            boost = 0.35 + 0.45 * u;
            toothB = 0.2 + 0.5 * u;
            seedShow = 0;
            if (fireAge > 3500) {
                prime = (fireAge - 3500) / 700;
                tremX = Math.sin(fireAge * 0.045) * 1.4 * prime;
                boost += 0.2 * prime;
                toothB = Math.max(toothB, 0.7 + 0.3 * prime);
            }
        } else {
            settleU = (fireAge - LAUNCH_MS) / 500;
            const su = clamp01(settleU);
            sprayU = fireAge < 4640 ? (fireAge - LAUNCH_MS) / 440 : -1;
            boost = 0.9 * (1 - su);
            toothB = 0.9 * (1 - su);
            seedShow = clamp01((fireAge - 4350) / 350); // re-crystallise for ready
        }
    }
    // The launched payload is ABSENT from the building (hard contract).
    if (projActive || fireAge >= LAUNCH_MS) grow = 0;

    const glowMix = clamp01(0.22 + 0.5 * breath + 0.55 * boost);
    const poolCol = mixc(P.poolLo, P.poolHi, glowMix);

    // ------------------------------------------------------- crown teeth
    interface Tooth { th: number; bx: number; by: number; idx: number }
    const Rm = (Ri + rx) * 0.5;
    const teeth: Tooth[] = [];
    for (let i = 0; i < P.teeth; i++) {
        const th = P.toothOff + (i * TAU) / P.teeth;
        teeth.push({ th, bx: cx + Math.cos(th) * Rm, by: ty + Math.sin(th) * Rm * 0.5, idx: i });
    }
    const drawTooth = (t: Tooth, withMound: boolean): void => {
        // glint chase: one full sweep of the crown per 2000 ms period
        const gi = Math.pow(Math.max(0, Math.cos(phT - (t.idx / P.teeth) * TAU)), 3);
        const flare = Math.min(1, 0.55 * gi + toothB);
        // near teeth foreshorten a touch and barely droop — the crown always
        // points UP; only the outward x-lean survives in full
        const near = Math.max(0, Math.sin(t.th));
        const hEff = P.toothH * (1 - 0.18 * near);
        const tipX = t.bx + Math.cos(t.th) * P.lean;
        const tipY = t.by + Math.sin(t.th) * 0.5 * P.lean * 0.35 - hEff;
        let wxv = -Math.sin(t.th), wyv = Math.cos(t.th) * 0.5;
        const wl = Math.hypot(wxv, wyv) || 1;
        wxv = (wxv / wl) * P.toothW * 0.5;
        wyv = (wyv / wl) * P.toothW * 0.5;
        if (withMound) {
            graphics.fillStyle(mixc(P.stoneTop, 0xdbeef5, 0.4), alpha * 0.75);
            graphics.fillEllipse(t.bx, t.by + 1, P.toothW * 1.7, P.toothW * 0.7);
        }
        // secondary spur — clustered-crystal read instead of a smooth cone
        const spx = t.bx + wxv * 1.7, spy = t.by + wyv * 1.7 + 0.6;
        fillPoly(graphics, [
            [spx - wxv * 0.45, spy - wyv * 0.45],
            [spx + (tipX - t.bx) * 0.1, spy - hEff * 0.42],
            [spx + wxv * 0.45, spy + wyv * 0.45]
        ], mixc(P.iceDark, 0xe8f8ff, flare * 0.3), alpha);
        const mb = [t.bx, t.by + 1.4];
        fillPoly(graphics, [[t.bx - wxv, t.by - wyv], [tipX, tipY], mb], mixc(P.iceLit, 0xf2fbff, flare * 0.45), alpha);
        fillPoly(graphics, [mb, [tipX, tipY], [t.bx + wxv, t.by + wyv]], mixc(P.iceDark, 0xe8f8ff, flare * 0.4), alpha);
        strokePts(graphics, [mb, [tipX, tipY]], 1.1, P.iceCore, alpha * 0.7);
        if (P.gold) { // L4: a slim gold ferrule where the tooth meets the stone
            fillPoly(graphics, [
                [t.bx - wxv * 0.85, t.by - wyv * 0.85 - 1],
                [t.bx + wxv * 0.85, t.by + wyv * 0.85 - 1],
                [t.bx + wxv * 0.7, t.by + wyv * 0.7 - 3],
                [t.bx - wxv * 0.7, t.by - wyv * 0.7 - 3]
            ], 0xdaa520, alpha * 0.95);
        }
        if (gi > 0.72 || toothB > 0.8) {
            diamond(graphics, tipX, tipY + 1.5, 0.9 + 0.8 * flare, 0xf6feff, alpha * 0.95);
        }
    };

    // 1 — far teeth rise from behind the rim
    teeth.filter(t => Math.sin(t.th) < -0.001)
        .sort((a, b) => a.by - b.by)
        .forEach(t => drawTooth(t, false));

    // 2 — outer wall (visible lower half), segmented stone
    const litF = (thm: number): number =>
        clamp01(0.5 - (0.5 * (Math.cos(thm) + Math.sin(thm))) / 1.4142);
    for (let k = 0; k < P.segs; k++) {
        const a0 = (k * TAU) / P.segs;
        const a1 = ((k + 1) * TAU) / P.segs;
        const lo = Math.max(a0, 0.045);
        const hi = Math.min(a1, Math.PI - 0.045);
        if (lo >= hi) continue;
        const topArc = arcPts(cx, ty, rx, ry, lo, hi, 3);
        const botArc = arcPts(cx, cy, rx, ry, hi, lo, 3);
        const thm = (lo + hi) / 2;
        let tone = mixc(P.stoneDark, P.stoneLit, litF(thm));
        if (k % 2 === 1) tone = mixc(tone, P.seam, 0.18);
        fillPoly(graphics, topArc.concat(botArc), tone, alpha);
    }
    // ground contact line
    strokePts(graphics, arcPts(cx, cy + 0.5, rx, ry, 0.08, Math.PI - 0.08, 10), 1.5, 0x232a20, alpha * 0.5);
    if (P.iron) { // L2: two forged bands binding the drum
        for (const bh of [P.h * 0.32, P.h * 0.68]) {
            const band = arcPts(cx, cy - bh, rx, ry, 0.07, Math.PI - 0.07, 10);
            strokePts(graphics, band, 1.6, 0x33383e, alpha * 0.95);
        }
    }
    if (P.rugged) { // L1: chipped notches in the old ring
        for (const th of [0.35 * Math.PI, 0.78 * Math.PI]) {
            const nx = cx + Math.cos(th) * rx;
            const ny = ty + Math.sin(th) * ry;
            fillPoly(graphics, [[nx - 2.4, ny], [nx + 2.4, ny], [nx, ny + 3.2]], P.seam, alpha * 0.9);
        }
    }

    // 3 — rim top, segmented, light from the NW
    for (let k = 0; k < P.segs; k++) {
        const a0 = (k * TAU) / P.segs;
        const a1 = ((k + 1) * TAU) / P.segs;
        const outer = arcPts(cx, ty, rx, ry, a0, a1, 3);
        const inner = arcPts(cx, ty, Ri, Ri * 0.5, a1, a0, 3);
        const thm = (a0 + a1) / 2;
        let tone = mixc(P.stoneTop, 0xffffff, 0.13 * litF(thm));
        if (k % 2 === 1) tone = mixc(tone, P.stoneLit, 0.22);
        fillPoly(graphics, outer.concat(inner), tone, alpha);
    }
    for (let k = 0; k < P.segs; k++) { // masonry seams
        const th = (k * TAU) / P.segs;
        strokePts(graphics, [
            [cx + Math.cos(th) * Ri, ty + Math.sin(th) * Ri * 0.5],
            [cx + Math.cos(th) * rx, ty + Math.sin(th) * ry]
        ], P.rugged ? 1.5 : 1.1, P.seam, alpha * (P.rugged ? 0.65 : 0.5));
    }
    // frost clinging to the outer lip on the shadow side
    strokePts(graphics, arcPts(cx, ty, rx - 0.5, ry - 0.25, 0.15, Math.PI - 0.15, 10), 1.2, 0xcfe4ee, alpha * 0.6);
    // small icicles hanging off the lip (static, shadow side)
    for (let i = 0; i < 3; i++) {
        const th = 0.42 + i * 0.5;
        const x0 = cx + Math.cos(th) * (rx - 1.5);
        const y0 = ty + Math.sin(th) * (ry - 0.75) + 1.5;
        const hd = 3.5 + ((i * 31) % 3) * 1.3;
        fillPoly(graphics, [[x0 - 1.2, y0], [x0 + 1.2, y0], [x0, y0 + hd]], P.iceDark, alpha * 0.9);
    }

    if (P.runnels) { // L3/L4: carved runnels seeping cold light (k=2 pulse)
        for (let i = 0; i < P.teeth; i++) {
            const th = P.toothOff + ((i + 0.5) * TAU) / P.teeth;
            const r0 = Ri + 1.5, r1 = Ri + P.rim * 0.55;
            const p0 = [cx + Math.cos(th) * r0, ty + Math.sin(th) * r0 * 0.5];
            const p1 = [cx + Math.cos(th) * r1, ty + Math.sin(th) * r1 * 0.5];
            let wxv = -Math.sin(th), wyv = Math.cos(th) * 0.5;
            const wl = Math.hypot(wxv, wyv) || 1;
            wxv = (wxv / wl) * 1.1; wyv = (wyv / wl) * 1.1;
            fillPoly(graphics, [
                [p0[0] - wxv, p0[1] - wyv], [p0[0] + wxv, p0[1] + wyv],
                [p1[0] + wxv, p1[1] + wyv], [p1[0] - wxv, p1[1] - wyv]
            ], mixc(0x2c5b78, 0x6fc4e8, 0.5 + 0.5 * s2 * (1 - 0.3 * boost) + 0.5 * boost), alpha * 0.95);
        }
    }
    if (P.gold) { // L4: four gold compass caps (accents, never masses)
        const caps = [Math.PI * 1.5, 0, Math.PI, Math.PI * 0.5]; // N, E, W, S
        for (const thc of caps) {
            const bx2 = cx + Math.cos(thc) * Rm;
            const by2 = ty + Math.sin(thc) * Rm * 0.5;
            fillPoly(graphics, [[bx2, by2 - 2.1], [bx2 + 3.4, by2], [bx2, by2 + 2.1], [bx2 - 3.4, by2]], 0x8a6a12, alpha);
            fillPoly(graphics, [[bx2 - 3.4, by2], [bx2, by2 + 2.1], [bx2, by2 - 5.2]], 0xe0b93e, alpha);
            fillPoly(graphics, [[bx2, by2 + 2.1], [bx2 + 3.4, by2], [bx2, by2 - 5.2]], 0xa87d18, alpha);
            if (s2 > 0.7) diamond(graphics, bx2, by2 - 5.2, 1.3, 0xffd700, alpha * 0.95);
        }
    }

    // 4 — the mouth: shaft, far inner wall, then the visible water
    graphics.fillStyle(0x142835, alpha);
    graphics.fillEllipse(cx, ty, Ri * 2, Ri);
    graphics.lineStyle(1.2, 0x0e1c26, alpha * 0.85);
    graphics.strokeEllipse(cx, ty, Ri * 2, Ri);

    const openNear = arcPts(cx, ty, Ri, Ri * 0.5, 0, Math.PI, 14);       // near lip
    const waterFar = arcPts(cx, wy, Rw, Rw * 0.5, Math.PI, TAU, 14);     // far waterline
    fillPoly(graphics, openNear.concat(waterFar), poolCol, alpha);
    strokePts(graphics, arcPts(cx, wy, Rw, Rw * 0.5, Math.PI + 0.08, TAU - 0.08, 12), 1.3,
        mixc(0x3d708e, 0x9fdcf2, clamp01(0.25 + 0.5 * breath + boost)), alpha * 0.9);

    // 5 — living water: hotspot breath, ripple, churn, motes
    const rh = Ri * 0.33 * (1 + 0.16 * s1) + 3 * boost;
    graphics.fillStyle(mixc(poolCol, 0x7fd0ec, clamp01(0.26 + 0.16 * s1 + 0.4 * boost)), alpha * 0.95);
    graphics.fillEllipse(cx, wy + 0.6, rh * 2, rh);

    // one ripple born per period, fading into the pool exactly at the seam
    const rippleR = 3 + (ringMax - 3) * ph;
    poolRing(graphics, cx, wy + 0.5, rippleR, 1.5, mixc(0xa8dcf0, poolCol, ph * ph), alpha * 0.88);

    if (Number.isFinite(fireAge)) { // churn rings while the vent is working
        const churnAmp = Math.max(churn, growU > 0 ? 0.45 + 0.4 * prime : 0);
        if (churnAmp > 0.05) {
            for (let kk = 0; kk < 2; kk++) {
                const uu = ((fireAge / 450) + kk * 0.5) % 1;
                poolRing(graphics, cx, wy + 0.5, 3 + (ringMax - 3) * uu, 1.4,
                    mixc(0xbfe6f4, poolCol, uu), alpha * 0.9 * churnAmp);
            }
        }
    }

    // two ice motes riding the current (one orbit per period)
    const orbR = Ri * 0.45 * (1 - 0.55 * clamp01(growU * 1.3));
    for (let i = 0; i < 2; i++) {
        const aa = phT + i * Math.PI;
        diamond(graphics, cx + Math.cos(aa) * orbR, wy + Math.sin(aa) * orbR * 0.5 - 1, 2.1, 0xcfeaf6, alpha * 0.92);
    }

    // 6 — the dormant seed cluster (ready pose) / its melt + regrowth
    if (seedShow > 0.05 && grow <= 0.8) {
        const bob = s1 * 1.8;
        const sink = (1 - seedShow) * 3.5;
        graphics.fillStyle(mixc(poolCol, 0x7fd0ec, 0.4 + 0.2 * s1), alpha * 0.9);
        graphics.fillEllipse(cx, wy + 1.6 + sink * 0.5, 13, 5);
        const seedC: number[][] = [[-1.2, 0.4, 8, 4.2, 1], [4.6, 1.6, 5.5, 3.1, 0.6], [-5.2, 2.2, 4.2, 2.7, 0.75]];
        for (const [sox, soy, sh, sw2, bm] of seedC) {
            const hx = cx + sox;
            const hy = wy + soy + bob * bm + sink;
            const hh = sh * seedShow;
            if (hh < 1) continue;
            fillPoly(graphics, [[hx - sw2 / 2, hy], [hx, hy - hh], [hx, hy + 0.8]], P.iceLit, alpha);
            fillPoly(graphics, [[hx, hy + 0.8], [hx, hy - hh], [hx + sw2 / 2, hy]], P.iceDark, alpha);
        }
        if (s2 > 0.65) diamond(graphics, cx - 1.2, wy + 0.4 + bob - 8 * seedShow, 1.4, 0xf4fdff, alpha * 0.9);
    }

    // 7 — THE PAYLOAD: a shard crystallising out of the pool. At fireAge
    // 4200 its visible body spans waterline → (cy - 10 - H/2): exactly the
    // above-water part of the projectile MainScene spawns at (cx, cy - 10).
    if (grow > 0.8) {
        const sx2 = cx + tremX;
        const wEff = SHARD_W[lvl - 1] * clamp01(0.3 + 0.8 * growU);
        graphics.fillStyle(mixc(poolCol, 0x8fd6ee, 0.7), alpha * 0.95);
        graphics.fillEllipse(sx2, wy + 1, wEff * 2.0, wEff * 0.8);
        graphics.lineStyle(1.4, mixc(0xbfe6f4, poolCol, 0.15), alpha * 0.95);
        graphics.strokeEllipse(sx2, wy + 1, wEff * 1.5, wEff * 0.6);

        const tipY = wy - grow;
        const wl = Math.max(2.5, wEff * 0.5);
        const litC = mixc(P.iceLit, 0xffffff, 0.25 * prime);
        const darkC = mixc(P.iceDark, 0xdff4fd, 0.4 * prime);
        const mb = [sx2, wy + 1.8];
        fillPoly(graphics, [[sx2 - wl, wy + 0.4], [sx2, tipY], mb], litC, alpha);
        fillPoly(graphics, [mb, [sx2, tipY], [sx2 + wl, wy + 0.4]], darkC, alpha);
        fillPoly(graphics, [
            [sx2, tipY + 1.5], [sx2 - wEff * 0.09, wy - grow * 0.45],
            [sx2, wy + 1.6], [sx2 + wEff * 0.09, wy - grow * 0.45]
        ], P.iceCore, alpha * 0.9);
        if (grow > 9) { // frost barbs — the projectile's collar, already grown
            const yb = wy - grow * 0.48;
            fillPoly(graphics, [[sx2 - wl * 0.5, yb], [sx2 - wl * 1.45, yb - 3.2], [sx2 - wl * 0.28, yb - 4.4]], litC, alpha * 0.95);
            fillPoly(graphics, [[sx2 + wl * 0.5, yb + 1], [sx2 + wl * 1.45, yb - 2.2], [sx2 + wl * 0.28, yb - 3.6]], darkC, alpha * 0.95);
        }
        if (prime > 0.12) {
            diamond(graphics, sx2, tipY - 1, 1.8 + 1.8 * prime, 0xf4fdff, alpha * Math.min(1, 0.5 + prime));
        }
    }

    // 8 — the geyser burst that threw the shard (launch + settle window)
    if (sprayU >= 0) {
        const su = clamp01(sprayU);
        const e = Math.sin((0.25 + 0.75 * su) * Math.PI);
        const hs = 8 + 26 * e;
        const jet = mixc(0xbfe6f4, 0xf4fdff, 0.4);
        const jets: number[][] = [[0, 1], [-4.5, 0.66], [4.5, 0.5]];
        for (const [oxJ, fh] of jets) {
            fillPoly(graphics, [
                [cx + oxJ - 2, wy], [cx + oxJ + 2, wy],
                [cx + oxJ + 0.6, wy - hs * fh], [cx + oxJ - 0.6, wy - hs * fh]
            ], jet, alpha * 0.95);
        }
        for (let i = 0; i < 6; i++) {
            const aa = (i / 6) * TAU + 0.9;
            const rr2 = 5 + 13 * su + ((i * 37) % 4);
            const dyp = -hs * (0.5 + (((i * 29) % 5) / 10)) + su * su * 16;
            diamond(graphics, cx + Math.cos(aa) * rr2, wy + dyp, 1.5, 0xdff2fb, alpha * 0.95);
        }
        const urr = clamp01(su * 1.25);
        poolRing(graphics, cx, wy + 0.5, 3 + (ringMax - 3) * urr, 1.6, mixc(0xbfe6f4, poolCol, urr), alpha * 0.92);
    }
    if (settleU >= 0) { // a late settle ripple chasing the splash out
        const u2 = clamp01(settleU * 1.1 - 0.18);
        if (u2 > 0 && u2 < 1) {
            poolRing(graphics, cx, wy + 0.5, 3 + (ringMax - 3) * u2, 1.3, mixc(0x9fdcf2, poolCol, u2), alpha * 0.85);
        }
    }

    // 9 — near teeth crown the front rim last
    teeth.filter(t => Math.sin(t.th) >= -0.001)
        .sort((a, b) => a.by - b.by)
        .forEach(t => drawTooth(t, true));
}

// ------------------------------------------------------------ the shard

/**
 * ICE SHARD PROJECTILE — Frostwell styling. Same mechanical envelope as the
 * incumbent (H 35/40/45 × W 18/20/22 for level = min(buildingLevel, 3),
 * drawn tip-up centred on the origin; the bake provides 16 rotation
 * variants, runtime never rotates). A bipyramidal hex shard with the same
 * facet palette and frost collar the well grows, so flight is visually
 * continuous with the preparation.
 */
export function drawFrostfallShardB(g: Phaser.GameObjects.Graphics, level: number): void {
    const lv = Math.max(1, Math.min(3, Math.round(Number(level) || 1)));
    const H = [35, 40, 45][lv - 1];
    const W = [18, 20, 22][lv - 1];
    const tip = -H / 2, base = H / 2;
    const belly = -H * 0.1;
    const lit = 0xe8f7fd, dark = 0x9fd2e8, core = 0x63b4dc, deep = 0x4c88a8;

    // body halves (lit left / shaded right), tapering to a rooted point
    fillPoly(g, [[0, tip], [-W / 2, belly], [-W * 0.22, H * 0.3], [0, base]], lit, 1);
    fillPoly(g, [[0, tip], [0, base], [W * 0.22, H * 0.3], [W / 2, belly]], dark, 1);
    // deep facet along the right edge near the tip — hard crystal read
    fillPoly(g, [[0, tip], [W / 2, belly], [W * 0.4, belly + 2.5], [W * 0.1, tip + 4]], mixc(dark, deep, 0.55), 1);
    // inner core stripe
    fillPoly(g, [[0, tip + 3], [-W * 0.1, belly + 2], [0, base - 3], [W * 0.1, belly + 2]], core, 0.95);
    // frost collar (the barbs grown at the well)
    const yc = belly + 1.5;
    fillPoly(g, [[-W * 0.42, yc], [-W * 0.78, yc - 3.5], [-W * 0.26, yc - 5]], lit, 1);
    fillPoly(g, [[W * 0.42, yc + 1], [W * 0.78, yc - 2.5], [W * 0.26, yc - 4]], dark, 1);
    if (lv >= 2) { // second, lower collar
        const y2 = H * 0.16;
        fillPoly(g, [[-W * 0.3, y2], [-W * 0.58, y2 - 2.8], [-W * 0.16, y2 - 4]], lit, 1);
        fillPoly(g, [[W * 0.3, y2 + 0.8], [W * 0.58, y2 - 2], [W * 0.16, y2 - 3.2]], dark, 1);
    }
    if (lv >= 3) { // rime nubs trailing at the root
        diamond(g, -W * 0.16, base - 3.5, 1.7, dark, 1);
        diamond(g, W * 0.14, base - 5.5, 1.4, mixc(dark, deep, 0.4), 1);
    }
    // tip highlight sliver
    fillPoly(g, [[0, tip], [-W * 0.16, tip + 5], [-W * 0.05, tip + 6.5]], 0xf6feff, 0.95);
}
