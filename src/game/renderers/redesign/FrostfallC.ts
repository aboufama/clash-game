import type Phaser from 'phaser';

/**
 * FROSTFALL — clean-room design C: "THE DEEPFROST WELL"
 *
 * Concept: the village drilled into an ancient glacier vein. A squat stone
 * wellhead caps the bore; raw deepfrost pressure grows a levitating ice shard
 * over the mouth, and four free-standing rime-stone pylons around the well
 * focus the charge. Firing is a geyser breach: the shard is drawn DOWN into
 * the bore (tension), the pylons ignite one by one, the core blazes, and at
 * exactly launch time the shard breaches the mouth and is hurled away.
 *
 * Omnidirectional by construction (a well is radially symmetric) — no barrel,
 * no aim; bakes at 1 angle.
 *
 * SIM CONTRACT (pure function of its inputs — no internal state):
 *   - building.level (1..4), building.lastFireTime, building.frostfallProjectileActive
 *   - projectile spawns at (center.x, center.y - 10) exactly 4200 ms after
 *     lastFireTime; the on-building shard eases to that exact point at 4200
 *     and is ABSENT whenever frostfallProjectileActive === true.
 *   - time === 0 (postcards/static captures) renders the deterministic
 *     ready/loaded hover pose.
 *
 * AMBIENT: ONE period P_AMB = 2000 ms; every idle term is an exact harmonic
 * (h1 = 2000 ms, h2 = 1000 ms): shard hover bob ±2 px, core/mouth-glow pulse,
 * pylon-cap pulse, three orbiting frost motes (full orbit per period).
 * All survive quantization (>=1.5 world px motion / >=16/255 RGB swing).
 *
 * FIRE TIMELINE (fireAge = time - lastFireTime):
 *   [0, 900)      dock     — shard descends from hover into the bore (bob damps out)
 *   [900, 3300)   charge   — pylons ignite at 650/1300/1950/2600 ms, energy arcs
 *                            feed the shard, runes + mouth glow ramp
 *   [3300, 3900)  tremble  — overpressure: shard vibrates, core blazes
 *   [3900, 4200)  breach   — quadratic ease-in rise to EXACTLY (cx, cy-10) at 4200
 *   [4200, ~4650) launch FX — expanding frost ring + vertical streak (shard gone)
 *   [4200, 5200)  residual — mouth glow decays; a fresh shard hovers once the
 *                            flight flag clears (impact ~4800).
 */

type Gfx = Phaser.GameObjects.Graphics;
type V2 = Phaser.Math.Vector2;

// ---------------- timeline constants ----------------
const P_AMB = 2000;      // the ONE ambient period (ms) — 250 ms multiple
const TAU = Math.PI * 2;
const LAUNCH_MS = 4200;  // HARD: MainScene spawns the projectile here
const DOCK_MS = 900;
const TREMBLE_MS = 3300;
const RISE_MS = 3900;

// ---------------- per-level dimensions ----------------
const SHARD_H = [35, 40, 45, 45];   // matches MainScene's embedded payload envelope
const SHARD_W = [18, 20, 22, 22];
const DRUM_H = [13, 15, 17, 17];
const DRUM_RX = [24, 26, 28, 28];
const PYLON_H = [14, 17, 20, 21];
const PYLON_IGNITE = [650, 1300, 1950, 2600]; // N, E, W, S

// ---------------- ice palette (shared by all levels) ----------------
const ICE_EDGE = 0x4f93bf;
const ICE_LIT = 0xd9f2ff;
const ICE_MID = 0x8ec7ea;
const CORE_COLD = 0x2fa8d8;
const CORE_HOT = 0xecfdff;
const GLOW = 0x9fe8ff;
const LINING = 0xbfe8ff;
const MOUTH_DARK = 0x141d29;
const SHADOW = 0x18220f;

// ---------------- per-level materials ----------------
interface Pal {
    wall: number; wallLit: number; wallDark: number; rim: number; joint: number;
    padTop: number; padEdge: number; padTrim: number | null;
    pyLit: number; pyDark: number;
    band: number | null;   // iron/gold band around the drum
    runes: boolean; icicles: boolean; gold: boolean;
}
const PAL: Pal[] = [
    { // L1 — timber + fieldstone
        wall: 0x8a8171, wallLit: 0x9f9480, wallDark: 0x6b6355, rim: 0xa79c88, joint: 0x584f40,
        padTop: 0x8f7f5c, padEdge: 0x6a5d43, padTrim: null,
        pyLit: 0x8b5e34, pyDark: 0x63411f, band: null, runes: false, icicles: false, gold: false
    },
    { // L2 — cut stone + iron
        wall: 0x87888f, wallLit: 0x9c9da4, wallDark: 0x64656c, rim: 0xa2a3aa, joint: 0x4c4d54,
        padTop: 0x8e8e86, padEdge: 0x64645c, padTrim: null,
        pyLit: 0x8f9097, pyDark: 0x606167, band: 0x3d4148, runes: true, icicles: false, gold: false
    },
    { // L3 — dark stone + deep ice
        wall: 0x5e6470, wallLit: 0x737a87, wallDark: 0x444955, rim: 0x767d8a, joint: 0x343943,
        padTop: 0x6d7078, padEdge: 0x494c54, padTrim: null,
        pyLit: 0x646a76, pyDark: 0x40454f, band: 0x2e3742, runes: true, icicles: true, gold: false
    },
    { // L4 — warm sandstone, gold ACCENTS only (iron rule 5)
        wall: 0xb0a68c, wallLit: 0xc4baa0, wallDark: 0x8d8168, rim: 0xc9c2ae, joint: 0x776a50,
        padTop: 0xbfb49a, padEdge: 0x8d8168, padTrim: 0xdaa520,
        pyLit: 0xbfb49a, pyDark: 0x8d8168, band: 0xdaa520, runes: true, icicles: true, gold: true
    },
];

// ---------------- tiny pure helpers ----------------
function clamp01(t: number): number { return t < 0 ? 0 : t > 1 ? 1 : t; }
function sstep(t: number): number { const x = clamp01(t); return x * x * (3 - 2 * x); }
function rgbMix(a: number, b: number, t: number): number {
    const k = clamp01(t);
    const ar = (a >> 16) & 255, ag = (a >> 8) & 255, ab = a & 255;
    const br = (b >> 16) & 255, bg = (b >> 8) & 255, bb = b & 255;
    return (Math.round(ar + (br - ar) * k) << 16) | (Math.round(ag + (bg - ag) * k) << 8) | Math.round(ab + (bb - ab) * k);
}
function poly(g: Gfx, pts: number[][], color: number, a: number): void {
    if (a <= 0.004 || pts.length < 3) return;
    g.fillStyle(color, Math.min(1, a));
    g.beginPath();
    g.moveTo(pts[0][0], pts[0][1]);
    for (let i = 1; i < pts.length; i++) g.lineTo(pts[i][0], pts[i][1]);
    g.closePath();
    g.fillPath();
}
function arcPts(cx: number, cy: number, rx: number, ry: number, a0: number, a1: number, n: number): number[][] {
    const out: number[][] = [];
    for (let i = 0; i <= n; i++) {
        const t = a0 + (a1 - a0) * (i / n);
        out.push([cx + Math.cos(t) * rx, cy + Math.sin(t) * ry]);
    }
    return out;
}
function strokePolyline(g: Gfx, pts: number[][], width: number, color: number, a: number): void {
    if (a <= 0.004 || pts.length < 2) return;
    g.lineStyle(width, color, Math.min(1, a));
    g.beginPath();
    g.moveTo(pts[0][0], pts[0][1]);
    for (let i = 1; i < pts.length; i++) g.lineTo(pts[i][0], pts[i][1]);
    g.strokePath();
}

/** Sutherland-Hodgman clip of a polygon against the half-plane y <= clipY. */
function clipBelow(pts: number[][], clipY: number): number[][] {
    if (!Number.isFinite(clipY)) return pts;
    const out: number[][] = [];
    for (let i = 0; i < pts.length; i++) {
        const a = pts[i], b = pts[(i + 1) % pts.length];
        const aIn = a[1] <= clipY, bIn = b[1] <= clipY;
        if (aIn) out.push(a);
        if (aIn !== bIn) {
            const t = (clipY - a[1]) / (b[1] - a[1]);
            out.push([a[0] + (b[0] - a[0]) * t, clipY]);
        }
    }
    return out;
}

/** The frost shard gem — shared by the on-building payload and the projectile.
 *  `clipY` truncates everything below the well's mouth plane (the rest of the
 *  gem is inside the bore); the projectile passes Infinity. */
function paintIceShard(g: Gfx, x: number, y: number, hs: number, ws: number, coreT: number, a: number, clipY: number = Number.POSITIVE_INFINITY): void {
    const hh = hs / 2, hw = ws / 2;
    const P = (pts: number[][], color: number, pa: number) => poly(g, clipBelow(pts, clipY), color, pa);
    // silhouette / edge
    P([[x, y - hh], [x + hw, y], [x, y + hh], [x - hw, y]], ICE_EDGE, a);
    // facets — NW light: left facet lit, right facet mid-dark
    P([[x, y - hh + 1.6], [x, y + hh - 1.6], [x - hw + 1.6, y]], ICE_LIT, a);
    P([[x, y - hh + 1.6], [x + hw - 1.6, y], [x, y + hh - 1.6]], ICE_MID, a);
    // inner core — the charge gauge
    const ch = hh * 0.52, cw = hw * 0.5;
    P([[x, y - ch], [x + cw, y], [x, y + ch], [x - cw, y]], rgbMix(CORE_COLD, CORE_HOT, coreT), a * 0.95);
    const ih = ch * 0.45, iw = cw * 0.45;
    P([[x, y - ih], [x + iw, y], [x, y + ih], [x - iw, y]], rgbMix(GLOW, 0xffffff, coreT), a * 0.9);
    // upper-left facet glint
    P([[x - hw * 0.34, y - hh * 0.36], [x - hw * 0.16, y - hh * 0.44], [x - hw * 0.22, y - hh * 0.18]], 0xffffff, a * 0.8);
}

/**
 * FROSTFALL design C — "The Deepfrost Well".
 * Signature matches BuildingDesignFn (DesignRegistry.ts).
 */
export function drawFrostfallC(
    graphics: Gfx,
    c1: V2, c2: V2, c3: V2, c4: V2,
    center: V2,
    alpha: number,
    _tint: number | null,
    building: any,
    baseGraphics: Gfx | undefined,
    skipBase: boolean,
    onlyBase: boolean,
    time: number
): void {
    const level = Math.max(1, Math.min(4, Math.round(Number(building?.level) || 1)));
    const li = level - 1;
    const pal = PAL[li];
    const cx = center.x, cy = center.y;

    // ---------------- sim state ----------------
    const lastFire = typeof building?.lastFireTime === 'number' ? building.lastFireTime : null;
    const fireAge = lastFire === null ? Number.POSITIVE_INFINITY : time - lastFire;
    const prep = fireAge >= 0 && fireAge < LAUNCH_MS;
    const projActive = building?.frostfallProjectileActive === true;

    // ---------------- ambient waves (exact harmonics of P_AMB) ----------------
    const ph = (((time % P_AMB) + P_AMB) % P_AMB) / P_AMB; // 0..1, loops seamlessly
    const w1 = Math.sin(ph * TAU);        // harmonic 1 — 2000 ms
    const w2 = Math.sin(ph * TAU * 2);    // harmonic 2 — 1000 ms

    // ---------------- geometry ----------------
    const H = DRUM_H[li], rx = DRUM_RX[li], ry = rx * 0.5;
    const topY = cy - H;
    const mrx = rx * 0.60, mry = ry * 0.60;                 // mouth opening
    // four rime-stone pylons at the plot's DIAGONAL edge midpoints (NW, NE,
    // SE, SW) — all four stay visible around the drum; none hides behind the
    // levitating shard. Ignition runs clockwise from the back-left.
    const mid = (a: V2, b: V2): number[] => [
        cx + ((a.x + b.x) / 2 - cx) * 0.94,
        cy + ((a.y + b.y) / 2 - cy) * 0.94
    ];
    const pylons: number[][] = [mid(c4, c1), mid(c1, c2), mid(c2, c3), mid(c3, c4)];

    // ================= BASE PASS (ground paint only — static) =================
    const g = baseGraphics || graphics;
    if (!skipBase) {
        // contact shadow — ONE chamfered polygon at uniform alpha
        const spread = 0.80, cut = 0.26;
        const sc = [c1, c2, c3, c4].map(p => [cx + (p.x - cx) * spread, cy + 1 + (p.y - cy) * spread]);
        const sh: number[][] = [];
        for (let i = 0; i < 4; i++) {
            const prev = sc[(i + 3) % 4], curr = sc[i], next = sc[(i + 1) % 4];
            sh.push([curr[0] + (prev[0] - curr[0]) * cut, curr[1] + (prev[1] - curr[1]) * cut]);
            sh.push([curr[0] + (next[0] - curr[0]) * cut, curr[1] + (next[1] - curr[1]) * cut]);
        }
        poly(g, sh, SHADOW, alpha * 0.17);

        // compact chamfered pad (~0.62 footprint), level-materialed
        const ps = 0.62, pcut = 0.22;
        const pc = [c1, c2, c3, c4].map(p => [cx + (p.x - cx) * ps, cy + (p.y - cy) * ps]);
        const ring: number[][] = [];
        for (let i = 0; i < 4; i++) {
            const a2 = pc[i], b2 = pc[(i + 1) % 4];
            ring.push([a2[0] + (b2[0] - a2[0]) * pcut, a2[1] + (b2[1] - a2[1]) * pcut]);
            ring.push([a2[0] + (b2[0] - a2[0]) * (1 - pcut), a2[1] + (b2[1] - a2[1]) * (1 - pcut)]);
        }
        poly(g, ring.map(p => [p[0], p[1] + 2.5]), pal.padEdge, alpha); // drop edge
        poly(g, ring, pal.padTop, alpha);
        if (pal.padTrim !== null) strokePolyline(g, [...ring, ring[0]], 1.4, pal.padTrim, alpha * 0.85);

        // rime crust chips hugging the pad's N corner (cold spills off the well)
        g.fillStyle(LINING, alpha * 0.8);
        g.fillEllipse(cx - ps * (cx - c4.x) * 0.42, cy - 6.5, 7, 3);
        g.fillEllipse(cx + 10, cy - ps * (cy - c1.y) * 0.55, 6, 2.6);

        // each pylon stands on the lawn with its own small contact shadow
        for (const p of pylons) {
            g.fillStyle(SHADOW, alpha * 0.18);
            g.fillEllipse(p[0], p[1] + 1, 9, 4);
        }
    }
    if (onlyBase) return;

    // ================= FIRE-SEQUENCE DRIVERS =================
    // core charge 0..1 (also drives mouth glow + pylon sympathy)
    let coreT = 0.30 + 0.14 * w1;                                  // ambient idle pulse
    if (prep) {
        coreT = 0.30 + 0.70 * sstep(fireAge / 3400);
        if (fireAge > 2600) coreT = clamp01(coreT + 0.06 * Math.sin(fireAge * 0.02));
    }
    let glowT = clamp01(coreT + 0.08 * w2);                        // mouth glow, shimmer on h2
    if (Number.isFinite(fireAge) && fireAge >= LAUNCH_MS) {
        glowT = Math.max(glowT, 0.85 * clamp01(1 - (fireAge - LAUNCH_MS) / 1000)); // residual
    }

    // shard pose — MUST pass exactly (cx, cy-10) at fireAge = 4200
    const hs = SHARD_H[li], ws = SHARD_W[li];
    const hoverY = topY - hs * 0.5 + 5;   // ready hover (tip dips ~5px into the mouth ring)
    const dockY = topY - 6 + hs * 0.5;    // docked deep — only the tip peeks above the rim
    const launchY = cy - 10;              // HARD spawn point height
    let shardX = cx;
    let shardY = hoverY + 2.0 * w1;       // ambient bob ±2 px (harmonic 1)
    if (prep) {
        if (fireAge < DOCK_MS) {
            const damp = clamp01(1 - fireAge / 600);
            shardY = hoverY + (dockY - hoverY) * sstep(fireAge / DOCK_MS) + 2.0 * w1 * damp;
        } else if (fireAge < RISE_MS) {
            shardY = dockY;
            if (fireAge >= TREMBLE_MS) {
                shardX = cx + 1.3 * Math.sin(fireAge * 0.055) * clamp01((fireAge - TREMBLE_MS) / 250);
            }
        } else {
            const u = (fireAge - RISE_MS) / (LAUNCH_MS - RISE_MS);
            shardY = dockY + (launchY - dockY) * u * u; // ease-in: hits launchY EXACTLY at 4200
        }
    }
    const shardVisible = !projActive;

    // pylon lighting (sequential ignition during charge; ambient pulse otherwise)
    const capAmbient = 0.30 + 0.20 * (0.5 + 0.5 * w1);
    const capT: number[] = [0, 0, 0, 0];
    const flashT: number[] = [0, 0, 0, 0];
    for (let k = 0; k < 4; k++) {
        const lit = prep ? sstep((fireAge - PYLON_IGNITE[k]) / 180) : 0;
        capT[k] = Math.max(capAmbient, lit * (0.9 + 0.1 * w2));
        flashT[k] = prep ? clamp01(1 - Math.abs(fireAge - PYLON_IGNITE[k]) / 220) : 0;
    }

    // frost motes: 3 orbiting the rim — full orbit per P_AMB (harmonic 1)
    let pull = 1;
    if (prep) pull = 1 - 0.55 * sstep(fireAge / 2600);
    else if (Number.isFinite(fireAge)) pull = 0.45 + 0.55 * clamp01((fireAge - LAUNCH_MS) / 900);
    const motes: number[][] = [];
    for (let k = 0; k < 3; k++) {
        const th = ph * TAU + (k * TAU) / 3;
        motes.push([
            cx + Math.cos(th) * (rx + 8) * pull,
            topY - 3 + Math.sin(th) * (ry + 5) * pull + 1.3 * Math.sin(ph * TAU * 2 + k * 2.1),
            Math.sin(th) // depth key: <0 behind the drum
        ]);
    }
    const drawMote = (m: number[]) => {
        graphics.fillStyle(0xbfe6ff, alpha * 0.85);
        graphics.fillEllipse(m[0], m[1], 3.6, 2.6);
        graphics.fillStyle(0xe8fbff, alpha * 0.65);
        graphics.fillEllipse(m[0] - 0.5, m[1] - 0.5, 1.6, 1.2);
    };

    // ================= ELEVATED PASS (painter's order) =================

    // --- pylon painter (obelisk leaning toward the well, glowing ice cap) ---
    const drawPylon = (p: number[], k: number) => {
        const bx = p[0], by = p[1];
        const h = PYLON_H[li];
        const wHalf = 3.3 + level * 0.3;
        const tx = bx + (cx - bx) * 0.10, ty = by - h;
        const L = [bx - wHalf, by], F = [bx, by + wHalf * 0.55], R = [bx + wHalf, by];
        const Lt = [tx - wHalf * 0.55, ty], Ft = [tx, ty + wHalf * 0.3], Rt = [tx + wHalf * 0.55, ty];
        poly(graphics, [L, F, Ft, Lt], pal.pyLit, alpha);            // SW face (lit)
        poly(graphics, [F, R, Rt, Ft], pal.pyDark, alpha);           // SE face (dark)
        poly(graphics, [Lt, Ft, Rt, [tx, ty - wHalf * 0.3]], rgbMix(pal.pyLit, 0xffffff, 0.14), alpha);
        if (pal.gold) { // L4: one thin gold collar under the tip — an accent, nothing more
            graphics.lineStyle(1.5, 0xdaa520, alpha * 0.95);
            graphics.lineBetween(tx - wHalf * 0.55, ty + 2.2, tx + wHalf * 0.55, ty + 2.2);
        }
        // ice cap crystal
        const t = capT[k];
        const capH = 3.5 + level * 0.9, capW = 2.2 + level * 0.45;
        const cyy = ty - capH - 1;
        if (t > 0.5) { // halo only when meaningfully lit (survives alpha snap at >0.5)
            poly(graphics, [[tx, cyy - capH - 2.5], [tx + capW + 2.2, cyy], [tx, cyy + capH + 2], [tx - capW - 2.2, cyy]], GLOW, alpha * 0.55 * t);
        }
        poly(graphics, [[tx, cyy - capH], [tx + capW, cyy], [tx, cyy + capH], [tx - capW, cyy]], ICE_EDGE, alpha);
        poly(graphics, [[tx, cyy - capH + 1], [tx + capW - 1, cyy], [tx, cyy + capH - 1], [tx - capW + 1, cyy]],
            rgbMix(0x7fc4e8, 0xeaffff, t), alpha);
        if (flashT[k] > 0.04) { // ignition flash ring
            graphics.lineStyle(1.8, 0xffffff, alpha * 0.8 * flashT[k]);
            graphics.strokeEllipse(tx, cyy, (capW + 5) * 2 * (1 + 0.6 * (1 - flashT[k])), (capH + 4) * (1 + 0.6 * (1 - flashT[k])));
        }
    };

    // --- drum painters (front pieces repaint AFTER the shard = bore occlusion) ---
    const NARC = 16;
    const drawWallFront = () => {
        const wall = [...arcPts(cx, topY, rx, ry, 0, Math.PI, NARC), ...arcPts(cx, cy, rx, ry, Math.PI, 0, NARC)];
        poly(graphics, wall, pal.wall, alpha);
        const dark = [...arcPts(cx, topY, rx, ry, 0, 0.40 * Math.PI, 8), ...arcPts(cx, cy, rx, ry, 0.40 * Math.PI, 0, 8)];
        poly(graphics, dark, pal.wallDark, alpha);
        const lit = [...arcPts(cx, topY, rx, ry, 0.62 * Math.PI, 0.97 * Math.PI, 8), ...arcPts(cx, cy, rx, ry, 0.97 * Math.PI, 0.62 * Math.PI, 8)];
        poly(graphics, lit, pal.wallLit, alpha);
        // masonry joints
        graphics.lineStyle(1.4, pal.joint, alpha * 0.7);
        for (const th of [0.22 * Math.PI, 0.5 * Math.PI, 0.78 * Math.PI]) {
            const jx = cx + Math.cos(th) * rx, jy0 = topY + Math.sin(th) * ry + 1.5, jy1 = cy + Math.sin(th) * ry - 1;
            graphics.lineBetween(jx, jy0, jx, jy1);
        }
        // iron / gold band around the drum waist
        if (pal.band !== null) {
            strokePolyline(graphics, arcPts(cx, cy - H * 0.45, rx + 0.5, ry + 0.3, 0.06 * Math.PI, 0.94 * Math.PI, 14), 2, pal.band, alpha);
        }
        // rune chips on the front wall (light with the pylons)
        if (pal.runes) {
            const runeTh = [0.2 * Math.PI, 0.42 * Math.PI, 0.60 * Math.PI, 0.82 * Math.PI];
            for (let k = 0; k < 4; k++) {
                const th = runeTh[k];
                const rxp = cx + Math.cos(th) * rx * 0.97, ryp = cy - H * 0.5 + Math.sin(th) * ry * 0.97;
                const litK = prep ? sstep((fireAge - PYLON_IGNITE[k]) / 180) : 0.18 + 0.14 * (0.5 + 0.5 * w1);
                graphics.fillStyle(rgbMix(0x27414f, 0x9ff0ff, litK), alpha);
                graphics.fillRect(rxp - 1.4, ryp - 2.4, 2.8, 4.8);
            }
        }
        // L3+: frost tongues crawling down the lit flank
        if (pal.icicles) {
            poly(graphics, [[cx - rx * 0.78, topY + ry * 0.55], [cx - rx * 0.58, topY + ry * 0.83], [cx - rx * 0.62, cy + ry * 0.5], [cx - rx * 0.82, cy + ry * 0.2]], LINING, alpha * 0.85);
        }
    };
    const drawRimFrontBand = () => {
        // the near rim ring — occludes the docked shard's body inside the bore
        const band = [...arcPts(cx, topY, rx + 3, ry + 1.7, 0, Math.PI, NARC), ...arcPts(cx, topY, mrx, mry, Math.PI, 0, NARC)];
        poly(graphics, band, pal.rim, alpha);
        strokePolyline(graphics, arcPts(cx, topY, mrx + 0.8, mry + 0.5, 0, Math.PI, 12), 1.7, LINING, alpha * 0.95);
        if (pal.gold) strokePolyline(graphics, arcPts(cx, topY, rx + 2.6, ry + 1.5, 0.05 * Math.PI, 0.95 * Math.PI, 14), 1.6, 0xdaa520, alpha * 0.9);
        if (pal.icicles) { // icicles hanging off the near rim
            for (const [th, len] of [[0.3 * Math.PI, 6], [0.52 * Math.PI, 8], [0.74 * Math.PI, 5]] as number[][]) {
                const ix = cx + Math.cos(th) * (rx + 2.5), iy = topY + Math.sin(th) * (ry + 1.5) + 1;
                poly(graphics, [[ix - 1.6, iy], [ix + 1.6, iy], [ix, iy + len]], LINING, alpha * 0.95);
            }
        }
    };

    // 1) back pylons (NW, NE) — tucked behind the drum's shoulders
    drawPylon(pylons[0], 0);
    drawPylon(pylons[1], 1);

    // 2) full drum: back rim edge, wall, rim top, mouth, lining, glow
    strokePolyline(graphics, arcPts(cx, topY, rx + 2.8, ry + 1.6, Math.PI, TAU, 14), 1.6, rgbMix(pal.rim, 0xffffff, 0.18), alpha * 0.9);
    drawWallFront();
    graphics.fillStyle(pal.rim, alpha);
    graphics.fillEllipse(cx, topY, (rx + 3) * 2, (ry + 1.7) * 2);
    if (pal.gold) { graphics.lineStyle(1.6, 0xdaa520, alpha * 0.9); graphics.strokeEllipse(cx, topY, (rx + 2.6) * 2, (ry + 1.5) * 2); }
    if (pal.icicles) { // pale ice sheet on the NW rim
        poly(graphics, arcPts(cx, topY, rx + 2.2, ry + 1.2, 1.05 * Math.PI, 1.75 * Math.PI, 10).concat(arcPts(cx, topY, mrx + 2, mry + 1, 1.75 * Math.PI, 1.05 * Math.PI, 10)), LINING, alpha * 0.9);
    }
    graphics.fillStyle(MOUTH_DARK, alpha);
    graphics.fillEllipse(cx, topY, mrx * 2, mry * 2);
    graphics.lineStyle(1.7, LINING, alpha * 0.95);
    graphics.strokeEllipse(cx, topY, (mrx + 0.8) * 2, (mry + 0.5) * 2);
    // mouth glow — the bore is lit from below (over opaque interior: snap-safe).
    // Stays SATURATED cyan even at full charge; only the small inner eye whitens.
    graphics.fillStyle(rgbMix(CORE_COLD, 0x8fd9f2, glowT), alpha * Math.min(0.9, 0.45 + 0.45 * glowT));
    graphics.fillEllipse(cx, topY, mrx * 1.45, mry * 1.45);
    graphics.fillStyle(rgbMix(0x7fd8f0, 0xeafcff, glowT), alpha * (0.35 + 0.5 * glowT));
    graphics.fillEllipse(cx, topY, mrx * 0.62, mry * 0.62);

    // 3) back motes, then the shard, then the bore's front occluders
    for (const m of motes) if (m[2] < 0) drawMote(m);
    // clip the gem at the mouth plane — its lower body is inside the bore
    if (shardVisible) paintIceShard(graphics, shardX, shardY, hs, ws, coreT, alpha, topY + mry + 1.5);
    drawWallFront();      // repaint: anything below the rim reads as inside the bore
    drawRimFrontBand();

    // 4) front pylons (SE, SW) + front motes
    drawPylon(pylons[2], 2);
    drawPylon(pylons[3], 3);
    for (const m of motes) if (m[2] >= 0) drawMote(m);

    // 5) charge arcs — lit pylons feed the shard
    if (prep && fireAge > PYLON_IGNITE[0]) {
        const tgtX = shardVisible ? shardX : cx;
        const tgtY = shardVisible ? shardY - hs * 0.5 + 2 : topY;
        for (let k = 0; k < 4; k++) {
            const lit = sstep((fireAge - PYLON_IGNITE[k]) / 180);
            if (lit < 0.6) continue;
            const p = pylons[k];
            const sx = p[0] + (cx - p[0]) * 0.10, sy = p[1] - PYLON_H[li] - (3.5 + level * 0.9) - 1;
            const mx = (sx + tgtX) / 2, my = (sy + tgtY) / 2;
            const dx = tgtX - sx, dy = tgtY - sy;
            const len = Math.max(1, Math.hypot(dx, dy));
            const nX = -dy / len, nY = dx / len;
            const off = 3 * Math.sin(fireAge * 0.03 + k * 1.7);
            const flick = 0.65 + 0.3 * Math.sin(fireAge * 0.045 + k);
            strokePolyline(graphics, [[sx, sy], [mx + nX * off, my + nY * off], [tgtX, tgtY]], 1.7, GLOW, alpha * 0.7 * lit * flick);
        }
    }

    // 6) launch flare: expanding frost ring + vertical streak (fireAge 4200..4650)
    if (Number.isFinite(fireAge) && fireAge >= LAUNCH_MS && fireAge < LAUNCH_MS + 450) {
        const u = (fireAge - LAUNCH_MS) / 450;
        const rr = 6 + 30 * u;
        graphics.lineStyle(2.2, GLOW, alpha * 0.85 * (1 - u));
        graphics.strokeEllipse(cx, topY, rr * 2, rr);
        graphics.lineStyle(1.4, 0xffffff, alpha * 0.7 * (1 - u));
        graphics.strokeEllipse(cx, topY, rr * 1.3, rr * 0.65);
        poly(graphics, [[cx - 1.6, topY], [cx + 1.6, topY], [cx + 0.9, topY - 26 - 10 * u], [cx - 0.9, topY - 26 - 10 * u]], ICE_LIT, alpha * 0.8 * (1 - u));
    }
}

/**
 * The matching ICE SHARD PROJECTILE — same mechanical envelope as the stock
 * shard (35/40/45 px tall × 18/20/22 px wide for L1/L2/L3+), drawn at the
 * local origin; restyled to the Deepfrost Well's gem language so the payload
 * that leaves the building is the payload in flight.
 */
export function drawFrostfallShardC(g: Gfx, level: number): void {
    const lv = Math.max(1, Math.min(3, Math.round(Number(level) || 1)));
    const hs = [35, 40, 45][lv - 1];
    const ws = [18, 20, 22][lv - 1];
    paintIceShard(g, 0, 0, hs, ws, 0.85, 1);
    // two frozen chips riding the waist (inside the envelope — the bake rotates this rigidly)
    poly(g, [[-ws * 0.32, hs * 0.18], [-ws * 0.20, hs * 0.26], [-ws * 0.30, hs * 0.34]], LINING, 0.95);
    poly(g, [[ws * 0.28, -hs * 0.20], [ws * 0.38, -hs * 0.12], [ws * 0.26, -hs * 0.08]], LINING, 0.95);
}
