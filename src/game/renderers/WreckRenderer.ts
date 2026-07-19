import Phaser from 'phaser';
import { RubbleRenderer } from './RubbleRenderer';

/**
 * Per-building WRECKS: when a building falls in battle, it leaves ITS OWN
 * ruin — the cannon tips off its mount, the mine caves in, the town hall
 * keeps a chimney standing in the ash — instead of the old size-generic
 * rubble pile. Deterministic (seeded by grid position), time-driven embers
 * only; `fireIntensity` fades the burn exactly like the legacy rubble.
 *
 * Every wreck reuses ITS building's palette (see BuildingRenderer), darkened
 * for char, and lies LOW — rubble height, below neighbouring intact walls.
 * Fallback: any type without a bespoke wreck falls back to the generic
 * rubble art, so an unknown or future building can never break a battle.
 */

/** Types whose wreck has an animated (time-driven) element. */
export const ANIMATED_WRECKS = new Set<string>(['tesla']);

/** Redraw only while a wreck still has a time-driven effect to show. */
export function wreckNeedsAnimation(type: string, width: number, height: number, fireIntensity: number): boolean {
    return fireIntensity > 0.01 && (width >= 3 || height >= 3 || ANIMATED_WRECKS.has(type));
}

type G = Phaser.GameObjects.Graphics;

/** Deterministic 0..1 from a location seed + stream constants (RubbleRenderer's idiom). */
const R = (seed: number, i: number, k: number) => Math.sin(seed + i * k) * 0.5 + 0.5;

/** Darken (f < 1) a 0xRRGGBB colour — char/desaturate a building's own palette. */
const dk = (c: number, f: number): number => {
    const r = Math.min(255, Math.round(((c >> 16) & 255) * f));
    const g = Math.min(255, Math.round(((c >> 8) & 255) * f));
    const b = Math.min(255, Math.round((c & 255) * f));
    return (r << 16) | (g << 8) | b;
};

/** Blend two 0xRRGGBB colours. Used to keep wreck materials in step with L1-L9. */
const mx = (a: number, b: number, t: number): number => {
    const q = Math.max(0, Math.min(1, t));
    const ch = (shift: number) => Math.round(((a >> shift) & 255) * (1 - q) + ((b >> shift) & 255) * q);
    return (ch(16) << 16) | (ch(8) << 8) | ch(0);
};

const poly = (g: G, pts: number[][], color: number, a = 1) => {
    g.fillStyle(color, a);
    g.beginPath();
    g.moveTo(pts[0][0], pts[0][1]);
    for (let i = 1; i < pts.length; i++) g.lineTo(pts[i][0], pts[i][1]);
    g.closePath();
    g.fillPath();
};

/**
 * Scorched-ground field: ONE irregular closed polygon at uniform alpha
 * (art guide §8 — stacked flats double-darken). Compact, never a full-tile slab.
 */
const charField = (g: G, cx: number, cy: number, rx: number, seed: number, alpha = 0.38, color = 0x241d13) => {
    const pts: number[][] = [];
    const N = 9;
    for (let i = 0; i < N; i++) {
        const th = (i / N) * Math.PI * 2;
        const r = rx * (0.66 + 0.42 * R(seed, i, 4.77));
        pts.push([cx + Math.cos(th) * r, cy + Math.sin(th) * r * 0.5]);
    }
    poly(g, pts, color, alpha);
};

/** Irregular debris chunk (RubbleRenderer's stone shape). */
const chunk = (g: G, x: number, y: number, s: number, color: number, a = 0.92) => {
    g.fillStyle(color, a);
    g.beginPath();
    g.moveTo(x, y - s * 0.6);
    g.lineTo(x + s * 0.5, y - s * 0.2);
    g.lineTo(x + s * 0.4, y + s * 0.4);
    g.lineTo(x - s * 0.3, y + s * 0.5);
    g.lineTo(x - s * 0.5, y);
    g.closePath();
    g.fillPath();
};

/** Flat plank/shingle/cloth strip lying on the lawn (iso 0.5 squash on the angle). */
const chip = (g: G, x: number, y: number, ang: number, len: number, wid: number, color: number, a = 0.95) => {
    const dx = Math.cos(ang) * len * 0.5, dy = Math.sin(ang) * 0.5 * len * 0.5;
    const px = -Math.sin(ang) * wid * 0.5, py = Math.cos(ang) * 0.5 * wid * 0.5;
    poly(g, [
        [x - dx - px, y - dy - py], [x + dx - px, y + dy - py],
        [x + dx + px, y + dy + py], [x - dx + px, y - dy + py]
    ], color, a);
};

/** Wood beam on/over the ground; `lift` raises the far end (propped rafter). */
const beam = (g: G, x: number, y: number, ang: number, len: number, thick: number, color: number, a = 0.92, lift = 0) => {
    g.lineStyle(thick, color, a);
    g.lineBetween(
        x - Math.cos(ang) * len * 0.5, y - Math.sin(ang) * 0.5 * len * 0.5,
        x + Math.cos(ang) * len * 0.5, y + Math.sin(ang) * 0.5 * len * 0.5 - lift
    );
};

/** A barrel/keg lying on its side: body along `ang`, hoops, dark open end. */
const barrel = (g: G, x: number, y: number, ang: number, len: number, rad: number, wood: number, hoop: number, a = 0.97) => {
    const dx = Math.cos(ang), dy = Math.sin(ang) * 0.5;
    const nx = -Math.sin(ang), ny = Math.cos(ang) * 0.5;
    const p = (d: number, o: number): number[] => [x + dx * d + nx * o, y + dy * d + ny * o];
    poly(g, [p(-len / 2, rad), p(len / 2, rad * 0.92), p(len / 2, -rad * 0.92), p(-len / 2, -rad)], wood, a);
    poly(g, [p(-len / 2, rad), p(len / 2, rad * 0.92), p(len / 2, rad * 0.25), p(-len / 2, rad * 0.3)], dk(wood, 0.72), a); // belly shadow
    g.lineStyle(1.1, hoop, a * 0.9);
    g.lineBetween(p(-len * 0.22, rad)[0], p(-len * 0.22, rad)[1], p(-len * 0.22, -rad)[0], p(-len * 0.22, -rad)[1]);
    g.lineBetween(p(len * 0.22, rad * 0.95)[0], p(len * 0.22, rad * 0.95)[1], p(len * 0.22, -rad * 0.95)[0], p(len * 0.22, -rad * 0.95)[1]);
    g.fillStyle(0x2a1d12, a); // open end
    g.fillEllipse(p(-len / 2, 0)[0], p(-len / 2, 0)[1], rad * 0.9, rad * 1.6);
};

type PFn = (u: number, v: number, up?: number) => [number, number];

/**
 * Low standing box remnant, grid-aligned (chimneys, wall corners). Painter's
 * order per the guide: SE dark → SW lit → top. `topJag` breaks the top edge.
 */
const isoBox = (
    g: G, P: PFn, u: number, v: number, du: number, dv: number, hgt: number,
    top: number, litSW: number, darkSE: number, a = 1, topJag = 0, seed = 0
) => {
    const N = P(u - du / 2, v - dv / 2), E = P(u + du / 2, v - dv / 2);
    const S = P(u + du / 2, v + dv / 2), W = P(u - du / 2, v + dv / 2);
    const hN = hgt - topJag * R(seed, 1, 3.3), hE = hgt - topJag * R(seed, 2, 3.3);
    const hS = hgt - topJag * R(seed, 3, 3.3), hW = hgt - topJag * R(seed, 4, 3.3);
    poly(g, [[E[0], E[1]], [S[0], S[1]], [S[0], S[1] - hS], [E[0], E[1] - hE]], darkSE, a);
    poly(g, [[W[0], W[1]], [S[0], S[1]], [S[0], S[1] - hS], [W[0], W[1] - hW]], litSW, a);
    poly(g, [[N[0], N[1] - hN], [E[0], E[1] - hE], [S[0], S[1] - hS], [W[0], W[1] - hW]], top, a);
};

/** Fire spots + rising embers + smoke — RubbleRenderer's exact burn language, resized per wreck. */
const burnFx = (
    g: G, seed: number, cx: number, cy: number, sx: number, sy: number,
    time: number, fire: number, spots = 3, embers = 5, smokes = 3
) => {
    if (time <= 0) return;
    if (fire > 0.05) {
        for (let i = 0; i < spots; i++) {
            const r1 = R(seed, i, 30.3), r2 = R(seed, i, 31.4);
            const fx = cx + (r1 - 0.5) * sx, fy = cy + (r2 - 0.5) * sy;
            const flicker = Math.sin(time / 100 + i * 2) * 0.3 + 0.7;
            const fs = Math.floor((5 + Math.sin(time / 150 + i) * 2.5) * fire);
            const gs = fs + 6;
            g.fillStyle(0xff6600, 0.4 * flicker * fire);
            g.fillRect(fx - gs / 2, fy - gs / 2, gs, gs);
            g.fillStyle(0xff4400, 0.7 * flicker * fire);
            g.fillRect(fx - fs / 2, fy - 2 - fs / 2, fs, fs);
            const ts = Math.max(2, fs * 0.5);
            const ty = fy - 5 - Math.sin(time / 80 + i) * 2;
            g.fillStyle(0xffaa00, 0.8 * flicker * fire);
            g.fillRect(fx - ts / 2, ty - ts / 2, ts, ts);
        }
        for (let i = 0; i < embers; i++) {
            const r1 = R(seed, i, 40.4), r2 = R(seed, i, 41.5);
            const cyc = ((time / 2000) + r1) % 1;
            const ex = cx + (r1 - 0.5) * sx * 0.7 + Math.sin(time / 300 + i) * 5;
            const ey = cy + (r2 - 0.5) * sy * 0.7 - cyc * 30;
            g.fillStyle(0xff6600, (1 - cyc) * 0.8 * fire);
            g.fillRect(ex - 1, ey - 1, 3, 3);
        }
    }
    // Smoke lingers as the fire dies (smoldering) — same law as legacy rubble.
    // Smoke trails the dying fire, but it must die with it. The old inverse
    // formula reached maximum opacity at fire=0 and smouldered forever.
    const smokeIntensity = Math.min(1, Math.max(0, fire * 1.4));
    if (smokeIntensity <= 0.01) return;
    const n = fire > 0.3 ? smokes : smokes + 2;
    for (let i = 0; i < n; i++) {
        const r1 = R(seed, i, 50.5), r2 = R(seed, i, 51.6);
        const cyc = ((time / 3000) + r1) % 1;
        const sxp = cx + (r1 - 0.5) * sx * 0.5 + Math.sin(time / 500 + i) * 8;
        const syp = cy + (r2 - 0.5) * sy * 0.5 - cyc * 50;
        const ss = Math.floor(4 + cyc * 10);
        g.fillStyle(0x555555, (1 - cyc) * 0.3 * smokeIntensity);
        g.fillRect(sxp - ss / 2, syp - ss / 2, ss, ss);
    }
};

/** Everything a wreck function needs. P(u, v, up) maps footprint tile coords → screen. */
interface W {
    g: G;
    /** Ground-plane contact/scorch pass, supplied by MainScene when available. */
    base?: G;
    P: PFn;
    cx: number;
    cy: number;
    w: number;
    h: number;
    seed: number;
    level: number;
    time: number;
    fire: number;
}

type BarracksWreckTheme = 'mechanica' | 'mystic';

interface BarracksWreckPalette {
    wallLit: number;
    wallDark: number;
    roofLit: number;
    roofDark: number;
    trim: number;
    accent: number;
    fracture: number;
    scorch: number;
}

/** Match the two authored barracks' material ladders without coupling wrecks to their renderer. */
const barracksWreckPalette = (theme: BarracksWreckTheme, level: number): BarracksWreckPalette => {
    const t = (Math.max(1, Math.min(9, level)) - 1) / 8;
    if (theme === 'mechanica') return {
        wallLit: mx(0xa48156, 0xbfb49a, t), wallDark: mx(0x75563f, 0x9d9078, t),
        roofLit: mx(0x76583a, 0x50545b, t), roofDark: mx(0x553f2c, 0x34383e, t),
        trim: mx(0x4d4036, 0x74684f, t), accent: mx(0xb16a35, 0xdaa520, t),
        fracture: mx(0xd68b4a, 0xf0bd55, t), scorch: 0x241d18,
    };
    return {
        wallLit: mx(0x8b806f, 0xbfb49a, t), wallDark: mx(0x665d51, 0x9d9078, t),
        roofLit: mx(0x655082, 0x463f74, t), roofDark: mx(0x46365f, 0x2d2850, t),
        trim: mx(0x51415f, 0x756a57, t), accent: mx(0x8f79cf, 0xb8abef, t),
        fracture: mx(0x83ddff, 0xb5f5ff, t), scorch: 0x211d2c,
    };
};

export class WreckRenderer {
    /**
     * Draw the wreck for `type` at level `level`. Unknown types get the
     * generic rubble so a battle can never render nothing.
     */
    static drawWreck(
        graphics: Phaser.GameObjects.Graphics,
        gridX: number,
        gridY: number,
        width: number,
        height: number,
        type: string,
        level: number,
        time: number = 0,
        fireIntensity: number = 1,
        baseGraphics?: Phaser.GameObjects.Graphics
    ): void {
        const P: PFn = (u, v, up = 0) => [
            (gridX + u - gridY - v) * 32,
            (gridX + u + gridY + v) * 16 - up
        ];
        const [cx, cy] = P(width / 2, height / 2);
        const ctx: W = {
            g: graphics, base: baseGraphics, P, cx, cy, w: width, h: height,
            seed: gridX * 1000 + gridY, level, time, fire: fireIntensity
        };
        switch (type) {
            case 'town_hall': this.townHall(ctx); break;
            case 'mine': this.mine(ctx); break;
            case 'farm': this.farm(ctx); break;
            case 'storage': this.storage(ctx); break;
            case 'barracks': this.barracks(ctx, 'mechanica'); break;
            case 'mystic_barracks': this.barracks(ctx, 'mystic'); break;
            case 'lab': this.lab(ctx); break;
            case 'army_camp': this.armyCamp(ctx); break;
            case 'cannon': this.cannon(ctx); break;
            case 'ballista': this.ballista(ctx); break;
            case 'xbow': this.xbow(ctx); break;
            case 'mortar': this.mortar(ctx); break;
            case 'tesla': this.tesla(ctx); break;
            case 'wall': this.wall(ctx); break;
            case 'prism': this.prism(ctx); break;
            case 'dragons_breath': this.dragonsBreath(ctx); break;
            case 'spike_launcher': this.spikeLauncher(ctx); break;
            case 'watchtower': this.watchtower(ctx); break;
            case 'jukebox': this.jukebox(ctx); break;
            default:
                RubbleRenderer.drawRubble(graphics, gridX, gridY, width, height, time, fireIntensity);
        }
    }

    // ── TOWN HALL 3x3 — collapsed terracotta roof, rafters, one standing chimney ──
    private static townHall(c: W) {
        const { g, P, cx, cy, seed, time, fire } = c;
        charField(c.base ?? g, cx, cy, 62, seed, 0.42);

        // Low broken stone wall runs (two stumps of the ground story)
        isoBox(g, P, 0.9, 0.75, 1.1, 0.24, 7, dk(0xbcac96, 0.8), dk(0xa89884, 0.8), dk(0x8a7a66, 0.8), 1, 4, seed);
        isoBox(g, P, 2.2, 1.9, 0.24, 0.9, 6, dk(0xbcac96, 0.75), dk(0xa89884, 0.75), dk(0x8a7a66, 0.75), 1, 4, seed + 3);

        // Two big fallen roof slabs — terracotta, one edge propped
        const slab = (x: number, y: number, ang: number, len: number, wid: number, lit: number, dark: number) => {
            const dx = Math.cos(ang) * len * 0.5, dy = Math.sin(ang) * 0.5 * len * 0.5;
            const px = -Math.sin(ang) * wid * 0.5, py = Math.cos(ang) * 0.5 * wid * 0.5;
            // dark under-edge (the lifted side)
            poly(g, [[x - dx - px, y - dy - py], [x + dx - px, y + dy - py], [x + dx - px, y + dy - py - 4], [x - dx - px, y - dy - py - 4]], dark, 0.95);
            // tilted slab top
            poly(g, [[x - dx - px, y - dy - py - 4], [x + dx - px, y + dy - py - 4], [x + dx + px, y + dy + py], [x - dx + px, y - dy + py]], lit, 0.97);
            // tile seams
            g.lineStyle(1, dk(dark, 0.8), 0.5);
            for (let i = 1; i < 3; i++) {
                const t = i / 3;
                g.lineBetween(x - dx - px + 2 * px * t, y - dy - py - 4 + (2 * py + 4) * t, x + dx - px + 2 * px * t, y + dy - py - 4 + (2 * py + 4) * t);
            }
        };
        const s1 = P(1.15, 1.9), s2 = P(2.05, 1.05);
        slab(s1[0], s1[1], 0.42, 46, 22, dk(0xc0563c, 0.82), dk(0x94402c, 0.7));
        slab(s2[0], s2[1], -0.5 + R(seed, 1, 2.2) * 0.3, 38, 18, dk(0xb04f36, 0.82), dk(0x7a3222, 0.75));

        // Rafters poking from the ash — charred timber, one surviving A-frame
        const a1 = P(1.5, 1.2);
        beam(g, a1[0] - 6, a1[1], 0.9, 26, 3.5, 0x33241a, 0.95, 17);
        beam(g, a1[0] + 7, a1[1] + 2, 2.3, 26, 3.5, 0x2a1c12, 0.95, 15);
        const b2 = P(0.8, 2.2);
        beam(g, b2[0], b2[1], 0.35, 24, 3, 0x4a3527, 0.9, 8);
        const b3 = P(2.35, 2.3);
        beam(g, b3[0], b3[1], 2.6, 20, 3, 0x3d2b1e, 0.9, 5);

        // Scattered red shingles
        for (let i = 0; i < 9; i++) {
            const r1 = R(seed, i, 7.31), r2 = R(seed, i, 8.42), r3 = R(seed, i, 9.53);
            const [x, y] = P(0.35 + r1 * 2.3, 0.35 + r2 * 2.3);
            chip(g, x, y, r3 * Math.PI, 7 + r1 * 4, 4, i % 2 ? dk(0xc0563c, 0.78) : dk(0x94402c, 0.72), 0.9);
        }
        // Stone debris
        for (let i = 0; i < 7; i++) {
            const r1 = R(seed, i, 12.7), r2 = R(seed, i, 13.9);
            const [x, y] = P(0.4 + r1 * 2.2, 0.5 + r2 * 2);
            chunk(g, x, y, 4 + r2 * 4, i % 2 ? dk(0xa89884, 0.7) : dk(0x8a7a66, 0.7));
        }

        // THE standing chimney — NE quarter, cracked rim, soot-streaked
        isoBox(g, P, 2.25, 0.65, 0.34, 0.34, 21, dk(0xbcac96, 0.9), dk(0xa89884, 0.88), dk(0x8a7a66, 0.85), 1, 5, seed + 7);
        const ch = P(2.25, 0.65);
        g.fillStyle(0x241d13, 0.55); // soot streak down the SW face
        g.fillRect(ch[0] - 4, ch[1] - 14, 3, 11);
        g.fillStyle(0x141414, 0.85); // dark flue mouth
        g.fillEllipse(ch[0], ch[1] - 19.5, 7, 3.5);

        // Fallen gold finial + half-buried red banner (subtle max-hall accents)
        const fin = P(1.7, 2.45);
        g.fillStyle(0xdaa520, 0.95);
        g.fillCircle(fin[0], fin[1], 2.2);
        const bn = P(0.6, 1.5);
        chip(g, bn[0], bn[1], 0.7, 12, 6, dk(0xc0392b, 0.75), 0.9);
        beam(g, bn[0] + 6, bn[1] + 1, 0.7, 18, 2, dk(0x5d4037, 0.8), 0.9);

        burnFx(g, seed, cx, cy, 74, 38, time, fire, 3, 6, 3);
    }

    // ── MINE 2x2 — caved-in shaft: sunken pit, snapped head-frame, spilled ore ──
    private static mine(c: W) {
        const { g, P, cx, cy, seed, time, fire } = c;
        void time; void fire;
        charField(c.base ?? g, cx, cy, 36, seed, 0.3, 0x2b241a);

        // Caved pit mouth — dirt slump spilling into the dark
        g.fillStyle(0x4c463c, 0.95);
        g.fillEllipse(cx - 2, cy + 1, 34, 17);
        g.fillStyle(0x14100c, 1);
        g.fillEllipse(cx - 2, cy + 0.5, 27, 13);
        poly(g, [[cx - 12, cy - 3], [cx + 3, cy - 5], [cx + 7, cy + 1], [cx - 5, cy + 4]], 0x3a332a, 1); // collapse slump
        // rim stones
        for (let i = 0; i < 6; i++) {
            const th = (i / 6) * Math.PI * 2 + R(seed, i, 3.1);
            chunk(g, cx - 2 + Math.cos(th) * 17, cy + 1 + Math.sin(th) * 8.5, 3.5 + R(seed, i, 5.5) * 2.5, dk(0x6b655a, 0.9));
        }

        // Snapped head-frame: one leg still standing, its mate broken across the pit
        const legB = P(0.55, 1.25);
        beam(g, legB[0], legB[1], -1.15, 16, 3, 0x5c4326, 0.95, 10); // standing stub, leaning
        const fall = P(1.15, 0.9);
        beam(g, fall[0], fall[1], 0.5, 34, 3, dk(0x5c4326, 0.85), 0.95, 3); // lintel fallen across pit
        // splintered break — pale torn wood at the snap
        const br = P(0.62, 1.1);
        g.fillStyle(0x9b7b5a, 0.9);
        poly(g, [[br[0] - 2, br[1] - 9], [br[0] + 2, br[1] - 11], [br[0] + 1, br[1] - 6]], 0x9b7b5a, 0.9);

        // Pulley wheel off its mount + slack rope coil
        const pw = P(1.55, 1.5);
        g.lineStyle(2.4, 0x3a2e1c, 1);
        g.strokeEllipse(pw[0], pw[1], 9, 5);
        g.lineStyle(1.2, 0x8a6a3a, 0.9);
        g.strokeEllipse(pw[0], pw[1], 4.5, 2.4);
        g.lineStyle(1.3, 0xb8a888, 0.85);
        g.strokeEllipse(pw[0] - 6, pw[1] + 2.6, 5, 2.4);
        g.lineBetween(pw[0] - 4, pw[1] + 2, pw[0] + 2, pw[1] - 1);

        // Tipped bucket
        const bk = P(0.5, 0.55);
        poly(g, [[bk[0] - 5, bk[1]], [bk[0] + 2, bk[1] - 3], [bk[0] + 5, bk[1] + 1], [bk[0] - 2, bk[1] + 4]], 0x4a3a24, 0.95);
        g.fillStyle(0x241d13, 0.8);
        g.fillEllipse(bk[0] - 3.5, bk[1] + 0.5, 5, 2.6);

        // Spilled ore — grey chunks with gold glints
        for (let i = 0; i < 8; i++) {
            const r1 = R(seed, i, 6.17), r2 = R(seed, i, 7.29);
            const [x, y] = P(1.15 + r1 * 0.75, 0.85 + r2 * 0.9);
            chunk(g, x, y, 3.5 + r2 * 3, dk(0x6b6e78, 0.8));
            if (i % 2 === 0) {
                g.fillStyle(0xffd84a, 0.95);
                g.fillRect(x - 1, y - 1.5, 2, 2);
            }
        }
    }

    // ── FARM 3x2 — scorched crop rows, broken fence, toppled scarecrow pole ──
    private static farm(c: W) {
        const { g, P, cx, cy, seed, time, fire } = c;
        const ground = c.base ?? g;
        // Charred soil bed (single flat polygon, uniform alpha)
        const b0 = P(0.25, 0.25), b1 = P(2.75, 0.25), b2 = P(2.75, 1.75), b3 = P(0.25, 1.75);
        poly(ground, [b0, b1, b2, b3], 0x33261a, 0.5);

        // Scorched furrow rows along grid-x, stubble burnt to stumps
        for (let r = 0; r < 3; r++) {
            const v = 0.5 + r * 0.5;
            const rowA = P(0.35, v), rowB = P(2.65, v);
            poly(ground, [
                [rowA[0], rowA[1] - 2.4], [rowB[0], rowB[1] - 2.4],
                [rowB[0], rowB[1] + 2.4], [rowA[0], rowA[1] + 2.4]
            ], 0x1f1710, 0.72);
            // burnt stubble ticks + a few unburnt gold survivors at the row ends
            for (let i = 0; i < 8; i++) {
                const t = (i + 0.5) / 8;
                const x = rowA[0] + (rowB[0] - rowA[0]) * t;
                const y = rowA[1] + (rowB[1] - rowA[1]) * t;
                const surv = (t < 0.12 || t > 0.88) && R(seed, i + r * 8, 2.9) > 0.45;
                g.lineStyle(1.4, surv ? 0xb8912e : 0x0f0b07, 0.9);
                g.lineBetween(x, y, x + (R(seed, i + r * 8, 4.4) - 0.5) * 2, y - (surv ? 5 : 2.5));
                if (surv) {
                    g.fillStyle(0xe8c04a, 0.9);
                    g.fillRect(x - 1, y - 6.5, 2, 2);
                }
            }
        }

        // Broken fence bits — two leaning posts, one snapped rail
        const f1 = P(0.25, 1.85);
        beam(g, f1[0], f1[1], -1.2, 9, 2.2, 0x5c4326, 0.95, 5);
        const f2 = P(0.75, 1.9);
        beam(g, f2[0], f2[1], -1.5, 8, 2.2, dk(0x5c4326, 0.85), 0.95, 4);
        chip(g, (f1[0] + f2[0]) / 2, (f1[1] + f2[1]) / 2 + 2, 0.46, 16, 2.4, dk(0x6d5230, 0.8), 0.9);

        // Toppled scarecrow pole — fallen ACROSS the rows so it reads at a glance
        const sc = P(2.05, 0.55);
        beam(g, sc[0], sc[1], 1.35, 30, 2.6, 0x7d5f38, 0.95, 2);
        beam(g, sc[0] - 1, sc[1] + 1, 2.85, 13, 2.2, 0x7d5f38, 0.9); // crossbar askew
        g.fillStyle(0xc9a86a, 0.95);
        g.fillCircle(sc[0] + 4.6, sc[1] + 8.6, 3.4); // straw head at the fallen top
        chip(g, sc[0] + 8.5, sc[1] + 10, 0.3, 6, 3.5, dk(0x8a3b2e, 0.9), 0.92);

        // Half-charred hay bale in the south corner
        const hb = P(2.55, 1.6);
        g.fillStyle(0x1f1710, 0.95);
        g.fillEllipse(hb[0] - 2, hb[1] - 2, 10, 7);
        g.fillStyle(dk(0xd0a848, 0.85), 0.95);
        g.fillEllipse(hb[0] + 2, hb[1] - 2.5, 9, 6.5);
        g.lineStyle(1, dk(0xb8912e, 0.8), 0.7);
        g.strokeEllipse(hb[0] + 2, hb[1] - 2.5, 6, 4);

        // Smouldering rows — low flames early, drifting smoke after (farm is 3-wide → live redraw)
        burnFx(g, seed, cx, cy + 2, 66, 26, time, fire * 0.7, 2, 4, 3);
    }

    // ── STORAGE 2x2 — burst storehouse: one wall corner stands, sacks + planks spill ──
    private static storage(c: W) {
        const { g, P, cx, cy, seed, time, fire } = c;
        void time; void fire;
        charField(c.base ?? g, cx, cy, 40, seed, 0.34);

        // Standing wall corner (east) — two low plank stubs meeting
        isoBox(g, P, 1.32, 0.42, 0.7, 0.16, 12, dk(0xa8875a, 0.85), dk(0xa8875a, 0.82), dk(0x86653c, 0.8), 1, 5, seed);
        isoBox(g, P, 1.62, 0.78, 0.16, 0.62, 10, dk(0xa8875a, 0.8), dk(0x9a7448, 0.8), dk(0x7a5836, 0.78), 1, 5, seed + 2);
        // plank seams on the SW face of the bigger stub
        const wc = P(1.32, 0.5);
        g.lineStyle(1, dk(0x6d5230, 0.7), 0.6);
        for (let i = -1; i <= 1; i++) g.lineBetween(wc[0] + i * 5 - 2, wc[1] - 1 + i * 2.5, wc[0] + i * 5 - 2, wc[1] - 9 + i * 2.5);

        // Split planks radiating from the burst
        for (let i = 0; i < 7; i++) {
            const r1 = R(seed, i, 5.83), r2 = R(seed, i, 6.94), r3 = R(seed, i, 8.05);
            const [x, y] = P(0.4 + r1 * 1.3, 0.5 + r2 * 1.2);
            chip(g, x, y, r3 * Math.PI, 10 + r1 * 7, 2.8, i % 2 ? dk(0x9a7448, 0.8) : dk(0x7a5836, 0.75), 0.92);
        }
        // A hipped-roof fragment
        const rf = P(0.62, 1.5);
        chip(g, rf[0], rf[1], 2.6, 15, 9, dk(0x8a5a30, 0.8), 0.95);
        g.lineStyle(1, dk(0x6b4423, 0.75), 0.6);
        g.lineBetween(rf[0] - 5, rf[1] - 2, rf[0] + 5, rf[1] + 2);

        // Spilled grain sacks — one torn, grain fanning out
        const sacks = [P(0.85, 1.35), P(1.1, 1.55), P(1.5, 1.3)];
        sacks.forEach(([x, y], i) => {
            g.fillStyle(dk(0xc9ae86, i === 1 ? 0.85 : 0.95), 0.97);
            g.fillEllipse(x, y - 2, 10, 6.5);
            g.fillStyle(dk(0xb0966e, 0.9), 0.9);
            g.fillEllipse(x + 2.5, y - 4.2, 3, 2);
        });
        const sp = P(1.72, 1.42);
        poly(g, [[sp[0] - 4, sp[1] - 2], [sp[0] + 6, sp[1] - 1], [sp[0] + 3, sp[1] + 3.5], [sp[0] - 5, sp[1] + 2]], 0xe0c060, 0.9);
        g.fillStyle(0xc9a227, 0.9);
        for (let i = 0; i < 4; i++) g.fillRect(sp[0] - 2 + R(seed, i, 3.7) * 8, sp[1] - 1 + R(seed, i, 4.8) * 3, 1.6, 1.6);

        // Broken barrel — lying open, one stave sprung loose beside it
        const bl = P(0.5, 0.78);
        barrel(g, bl[0], bl[1] - 2, 2.85, 14, 4.2, dk(0x7a5230, 0.95), dk(0x8f6238, 0.9));
        beam(g, bl[0] + 9, bl[1] + 2, 0.5, 8, 2, dk(0x8f6238, 0.8), 0.9);

        // debris chunks in wall tones
        for (let i = 0; i < 4; i++) {
            const r1 = R(seed, i, 11.3), r2 = R(seed, i, 12.5);
            const [x, y] = P(0.4 + r1 * 1.4, 0.4 + r2 * 1.3);
            chunk(g, x, y, 3 + r2 * 2.5, dk(0x86653c, 0.75));
        }
    }

    // ── FACTION BARRACKS 2x2 — collapsed shell plus one unmistakable dead machine ──
    private static barracks(c: W, theme: BarracksWreckTheme) {
        const { g, P, cx, cy, seed, level, time, fire } = c;
        void time; void fire;
        const L = Math.max(1, Math.min(9, level));
        const p = barracksWreckPalette(theme, L);
        charField(c.base ?? g, cx, cy, 38 + L * 0.6, seed, 0.34, p.scorch);

        // Two low wall corners retain the upgraded material tier without
        // becoming a standing building silhouette.
        const stump = 5.5 + Math.floor((L - 1) / 2);
        isoBox(g, P, 0.68, 0.55, 0.76, 0.2, stump, dk(p.wallLit, 0.78), dk(p.wallLit, 0.72), dk(p.wallDark, 0.72), 1, 4, seed);
        isoBox(g, P, 1.48, 1.12, 0.2, 0.66, Math.max(5, stump - 1.5), dk(p.wallLit, 0.72), dk(p.wallDark, 0.78), dk(p.wallDark, 0.65), 1, 4, seed + 7);

        // Hipped-roof fragments: same faction roof language at every level,
        // more courses and trim survive in higher-tier ruins.
        const rf = P(0.72, 1.42);
        chip(g, rf[0], rf[1] - 1, 2.63, 21 + L * 0.45, 10 + L * 0.24, dk(p.roofLit, 0.82), 0.97);
        g.lineStyle(1, dk(p.roofDark, 0.82), 0.84);
        const courses = 1 + Math.floor((L - 1) / 3);
        for (let i = 0; i < courses; i++) {
            g.lineBetween(rf[0] - 8 + i * 4, rf[1] - 4 + i, rf[0] + 4 + i * 4, rf[1] + 1 + i);
        }
        const rf2 = P(1.47, 0.48);
        chip(g, rf2[0], rf2[1], 0.42, 13 + L * 0.3, 6.5, dk(p.roofDark, 0.88), 0.95);
        if (L === 9) {
            // Mastery gold remains an accent: a snapped ridge-cap, never a slab.
            beam(g, rf[0] - 1, rf[1] - 5, 2.63, 12, 1.7, 0xdaa520, 0.95);
        }

        if (theme === 'mechanica') {
            // A cold, flattened forge gear is the Mechanica read. The open
            // furnace eye is black: destruction switches the orange glow off.
            const gear = P(1.48, 1.48), rad = 5.2 + Math.floor((L - 1) / 3);
            g.lineStyle(2.2, dk(p.accent, 0.82), 1);
            g.strokeEllipse(gear[0], gear[1] - 1, rad * 2, rad);
            for (let i = 0; i < 8; i++) {
                const a = (i / 8) * Math.PI * 2;
                g.lineBetween(gear[0], gear[1] - 1, gear[0] + Math.cos(a) * rad, gear[1] - 1 + Math.sin(a) * rad * 0.5);
                const tx = gear[0] + Math.cos(a) * (rad + 1.5), ty = gear[1] - 1 + Math.sin(a) * (rad + 1.5) * 0.5;
                chip(g, tx, ty, a, 3.4, 2.1, dk(p.trim, 0.9), 0.95);
            }
            g.fillStyle(0x191715, 1);
            g.fillEllipse(gear[0], gear[1] - 1, 4.2, 2.4);

            const pipe = P(0.45, 0.82);
            beam(g, pipe[0], pipe[1], 0.34, 19, 3.2, dk(p.accent, 0.72), 0.98, 3);
            g.fillStyle(0x1b1917, 1);
            g.fillEllipse(pipe[0] + 9, pipe[1] + 1.4, 5.2, 2.8);
            if (L >= 5) {
                const stack = P(1.73, 0.62);
                isoBox(g, P, 1.73, 0.62, 0.22, 0.22, 7 + (L - 5) * 0.7, dk(p.trim, 0.78), dk(p.trim, 0.66), dk(p.roofDark, 0.72), 1, 3, seed + 11);
                g.fillStyle(0x171719, 1);
                g.fillEllipse(stack[0], stack[1] - 7 - (L - 5) * 0.7, 5.5, 2.5);
            }
        } else {
            // Mystic power has fallen inert: shattered violet crystal and
            // separated rune-tablet pieces replace the former hovering core.
            const cr = P(1.45, 1.34);
            poly(g, [[cr[0] - 7, cr[1]], [cr[0] - 3, cr[1] - 10 - L * 0.25], [cr[0] + 1, cr[1] - 5], [cr[0] + 5, cr[1] + 1]], dk(p.accent, 0.78), 0.98);
            poly(g, [[cr[0] - 3, cr[1] - 10 - L * 0.25], [cr[0] - 1, cr[1] - 5], [cr[0] - 5, cr[1] - 1]], dk(p.fracture, 0.76), 0.94);
            const shard = P(1.72, 1.53);
            poly(g, [[shard[0] - 8, shard[1] - 1], [shard[0] + 4, shard[1] - 5], [shard[0] + 9, shard[1] - 1], [shard[0] - 3, shard[1] + 2]], dk(p.accent, 0.7), 0.97);
            g.lineStyle(1.2, dk(p.fracture, 0.72), 0.9);
            g.lineBetween(shard[0] - 4, shard[1] - 2, shard[0] + 4, shard[1] - 3.4);

            const tablet = P(0.48, 0.88);
            chip(g, tablet[0], tablet[1], 0.58, 14 + L * 0.25, 8, dk(p.roofLit, 0.8), 0.98);
            g.lineStyle(1.3, dk(p.fracture, 0.7), 0.94);
            g.beginPath();
            g.moveTo(tablet[0] - 3.5, tablet[1] + 0.5);
            g.lineTo(tablet[0], tablet[1] - 3);
            g.lineTo(tablet[0] + 3.5, tablet[1] + 1.5);
            g.strokePath();
            if (L >= 5) {
                // A broken ritual ring lies flat; its gap makes the loss of
                // the former floating halo clear even in the small bake.
                g.lineStyle(1.8, dk(p.accent, 0.72), 0.96);
                g.beginPath();
                g.arc(cr[0] - 8, cr[1] + 2, 8 + (L - 5) * 0.5, 0.3, Math.PI * 1.42);
                g.strokePath();
            }
        }
    }

    // ── LAB 2x2 — shattered glassware, spilled reagent, purple roof shards ──
    private static lab(c: W) {
        const { g, P, cx, cy, seed, level, time, fire } = c;
        void time; void fire;
        charField(c.base ?? g, cx, cy, 38, seed, 0.36);
        const L = Math.max(1, Math.min(3, level));
        const liquid = [0x59e08f, 0xb37cff, 0xffd76a][L - 1];
        const liquidHi = [0xa8f0c8, 0xd9bcff, 0xfff2c0][L - 1];
        const roofLit = [0x5c4a86, 0x6644aa, 0x7a55c8][L - 1];
        const roofDark = [0x463868, 0x4e3384, 0x5c3f9a][L - 1];

        // Broken stone wall stubs (two heights — the box torn open)
        isoBox(g, P, 0.75, 0.55, 0.75, 0.2, 10, dk(0xd8ccab, 0.8), dk(0xd8ccab, 0.76), dk(0xb3a684, 0.72), 1, 5, seed);
        isoBox(g, P, 1.45, 1.1, 0.2, 0.7, 7, dk(0xd8ccab, 0.72), dk(0xc4b795, 0.72), dk(0xb3a684, 0.68), 1, 4, seed + 5);

        // Spilled reagent — ONE glowing pool running from the broken bulb
        const st = P(1.08, 1.32);
        const stain: number[][] = [];
        for (let i = 0; i < 8; i++) {
            const th = (i / 8) * Math.PI * 2;
            const r = 13 * (0.6 + 0.5 * R(seed, i, 6.13));
            stain.push([st[0] + Math.cos(th) * r, st[1] + Math.sin(th) * r * 0.5]);
        }
        poly(g, stain, liquid, 0.42);
        g.fillStyle(liquidHi, 0.55);
        g.fillEllipse(st[0] - 2, st[1] - 1, 7, 3.5);
        g.fillStyle(liquid, 0.5); // stray splashes
        g.fillRect(st[0] + 9, st[1] + 3, 2.4, 1.6);
        g.fillRect(st[0] - 11, st[1] + 1, 2, 1.4);

        // The broken retort ON the pool's edge — burst glass fan + bent copper cradle
        const ap = P(1.3, 1.12);
        beam(g, ap[0] + 2, ap[1] - 1, -1.05, 11, 2.2, dk(0xb06a3a, 0.9), 0.95, 4); // cradle arm rearing
        beam(g, ap[0] - 2, ap[1] + 2, 0.55, 9, 2, dk(0x7e4826, 0.9), 0.95); // fallen pipe run
        // bulb base: a glass half-shell tipped over, mouth toward the spill
        poly(g, [[ap[0] - 5, ap[1] - 1], [ap[0] - 1.5, ap[1] - 4.6], [ap[0] + 3, ap[1] - 3.4], [ap[0] + 3.6, ap[1] + 0.6], [ap[0] - 1, ap[1] + 1.8]], 0xcfe8dc, 0.5);
        g.lineStyle(1.2, 0xe8f4ee, 0.7);
        g.beginPath();
        g.arc(ap[0] - 1, ap[1] - 1.6, 4.4, Math.PI * 0.7, Math.PI * 1.75);
        g.strokePath();
        // glass shards fanning toward the stain
        for (let i = 0; i < 5; i++) {
            const r1 = R(seed, i, 9.41), r2 = R(seed, i, 10.6);
            const x = ap[0] - 10 + r1 * 12, y = ap[1] + 2 + r2 * 5;
            poly(g, [[x, y - 2.4], [x + 2.2, y + 0.8], [x - 1.8, y + 1.2]], 0xe8f4ee, 0.7);
        }
        g.fillStyle(0xffffff, 0.9);
        g.fillRect(ap[0] - 3, ap[1] + 3, 1.4, 1.4);

        // Purple roof shards, kept inside the ruin
        for (let i = 0; i < 6; i++) {
            const r1 = R(seed, i, 4.27), r2 = R(seed, i, 5.38), r3 = R(seed, i, 6.49);
            const [x, y] = P(0.5 + r1 * 1.15, 0.45 + r2 * 1.1);
            chip(g, x, y, r3 * Math.PI, 8 + r1 * 5, 4.5, i % 2 ? dk(roofLit, 0.85) : dk(roofDark, 0.85), 0.93);
        }

        // Tipped condenser keg + stone rubble
        const kg = P(0.55, 1.35);
        barrel(g, kg[0], kg[1] - 2, 2.95, 13, 4, dk(0x5d4037, 0.95), dk(0xb06a3a, 0.9));
        for (let i = 0; i < 4; i++) {
            const r1 = R(seed, i, 14.2), r2 = R(seed, i, 15.8);
            const [x, y] = P(0.55 + r1 * 1.1, 0.5 + r2 * 1);
            chunk(g, x, y, 3 + r2 * 2.5, dk(0xb3a684, 0.7));
        }
    }

    // ── ARMY CAMP 3x3 — flattened camp: cold fire ring, torn dummy, spilled rack ──
    private static armyCamp(c: W) {
        const { g, P, cx, cy, seed, time, fire } = c;
        // Trampled dirt remnant — irregular, torn up at the edges (the camp's identity)
        const dirt: number[][] = [];
        for (let i = 0; i < 10; i++) {
            const th = (i / 10) * Math.PI * 2;
            const r = 58 * (0.7 + 0.35 * R(seed, i, 3.91));
            dirt.push([cx + Math.cos(th) * r, cy + Math.sin(th) * r * 0.5]);
        }
        poly(g, dirt, dk(0xb8a080, 0.78), 0.55);
        charField(c.base ?? g, cx, cy, 40, seed, 0.26);

        // COLD fire ring — scattered stones, deep ash, charred log ends
        g.fillStyle(0x2a2020, 0.95);
        g.fillEllipse(cx, cy, 17, 8.5);
        g.fillStyle(0x171310, 0.9);
        g.fillEllipse(cx - 1, cy, 10, 5);
        for (let i = 0; i < 7; i++) {
            const th = (i / 7) * Math.PI * 2 + R(seed, i, 2.3) * 0.8;
            const rr = 10 + R(seed, i, 3.4) * 5; // ring burst outward
            chunk(g, cx + Math.cos(th) * rr, cy + Math.sin(th) * rr * 0.5, 3 + R(seed, i, 4.5) * 2, 0x555555);
        }
        beam(g, cx - 3, cy + 1, 0.7, 12, 2.4, 0x1c1410, 0.95);
        beam(g, cx + 4, cy - 1, 2.5, 11, 2.4, 0x241a12, 0.95);

        // Torn training dummy — post snapped, straw body burst open
        const dm = P(0.85, 1.9);
        beam(g, dm[0], dm[1], -1.25, 10, 3, 0x3d2e17, 0.95, 6); // snapped post stub
        beam(g, dm[0] + 5, dm[1] + 3, 0.4, 16, 2.6, 0x5d4e37, 0.95); // fallen crossbar
        g.fillStyle(dk(0xc4a060, 0.9), 0.97); // straw sack on the ground, torn
        g.fillEllipse(dm[0] + 10, dm[1] + 5, 9, 5.5);
        g.fillStyle(0xa48040, 0.9);
        for (let i = 0; i < 5; i++) {
            g.fillRect(dm[0] + 6 + R(seed, i, 5.9) * 12, dm[1] + 3 + R(seed, i, 7.1) * 5, 2.2, 1.2);
        }

        // Collapsed weapon rack — A-frame down, blades scattered
        const rk = P(2.1, 1.1);
        beam(g, rk[0], rk[1], 0.55, 20, 2.6, 0x5d4e37, 0.95, 3);
        beam(g, rk[0] + 2, rk[1] + 2, 0.9, 16, 2.2, dk(0x5d4e37, 0.8), 0.95);
        g.lineStyle(1.7, 0x888888, 0.95);
        g.lineBetween(rk[0] - 6, rk[1] + 6, rk[0] + 4, rk[1] + 1);
        g.lineBetween(rk[0] + 1, rk[1] + 8, rk[0] + 10, rk[1] + 4);
        g.fillStyle(0xccaa00, 0.95);
        g.fillRect(rk[0] - 7, rk[1] + 5.4, 1.8, 1.8); // gold pommel
        // axe head sunk in the dirt
        poly(g, [[rk[0] + 13, rk[1] - 2], [rk[0] + 17, rk[1] - 0.5], [rk[0] + 15.5, rk[1] + 2.8], [rk[0] + 12, rk[1] + 1]], 0x666666, 0.95);

        // Flattened canvas bedroll heap + fallen banner
        const cv = P(1.9, 2.15);
        poly(g, [
            [cv[0] - 12, cv[1] - 1], [cv[0] - 2, cv[1] - 5.5], [cv[0] + 11, cv[1] - 1.5],
            [cv[0] + 6, cv[1] + 4], [cv[0] - 6, cv[1] + 4.5]
        ], dk(0xc9b892, 0.85), 0.95);
        g.lineStyle(1, dk(0xa8977a, 0.8), 0.6);
        g.lineBetween(cv[0] - 7, cv[1] + 1, cv[0] + 3, cv[1] - 3.5);
        const bn = P(0.85, 0.8);
        beam(g, bn[0], bn[1], 0.2, 18, 1.8, dk(0x5d4e37, 0.9), 0.9);
        chip(g, bn[0] + 4, bn[1] + 4, 0.2, 9, 5.5, dk(0xc0392b, 0.8), 0.9);

        // Wisps only — the camp burns quiet, mostly smoke (3x3 → live redraw)
        burnFx(g, seed, cx, cy, 52, 26, time, fire * 0.45, 1, 3, 3);
    }

    // ── CANNON 1x1 — barrel tipped off its mount, broken carriage wheel ──
    private static cannon(c: W) {
        const { g, P, cx, cy, seed, level, time, fire } = c;
        void time; void fire;
        const L4 = level >= 4;
        const bDark = L4 ? 0x9c7208 : 0x1c1c1c;
        const bMid = L4 ? 0xc9992a : 0x323232;
        const bLight = L4 ? 0xe8c25a : 0x515151;
        charField(c.base ?? g, cx, cy, 21, seed, 0.34);

        // Splintered carriage cheek + spilled cannonballs
        const ck = P(0.32, 0.42);
        poly(g, [[ck[0] - 5, ck[1]], [ck[0] + 4, ck[1] - 3.5], [ck[0] + 6, ck[1] + 0.5], [ck[0] - 2, ck[1] + 3.5]], dk(0x5d4037, 0.9), 0.95);
        beam(g, ck[0] + 3, ck[1] - 2, -0.9, 6, 2, 0x795548, 0.9, 2);
        g.fillStyle(L4 ? 0xf3f3e6 : 0x22222a, 0.97);
        g.fillCircle(cx - 9, cy + 6.5, 2.6);
        g.fillCircle(cx - 4.5, cy + 8, 2.6);

        // THE BARREL — tipped off, lying diagonally, muzzle propped on debris
        const a = 0.48 + (R(seed, 1, 2.7) - 0.5) * 0.2; // lie angle
        const bx = cx + 2, by = cy + 1;
        const dx = Math.cos(a), dy = Math.sin(a) * 0.5;
        const nxp = -Math.sin(a), nyp = Math.cos(a) * 0.5;
        const lift = 3; // muzzle end propped up
        const bl = 26, wB = 4.6, wM = 3.6;
        const p = (d: number, wgt: number, up: number): number[] => [bx + dx * d + nxp * wgt, by + dy * d + nyp * wgt - up];
        // shadow slug under the barrel
        poly(g, [p(-bl / 2, wB + 1.5, -1), p(bl / 2, wM + 1.5, -1), p(bl / 2, -wM - 1.5, -1), p(-bl / 2, -wB - 1.5, -1)], 0x141414, 0.3);
        // body: dark belly, mid, light top stripe
        poly(g, [p(-bl / 2, wB, 0), p(bl / 2, wM, lift), p(bl / 2, -wM, lift), p(-bl / 2, -wB, 0)], bMid, 1);
        poly(g, [p(-bl / 2, wB, 0), p(bl / 2, wM, lift), p(bl / 2, wM * 0.2, lift), p(-bl / 2, wB * 0.2, 0)], dk(bDark, 0.9), 1);
        poly(g, [p(-bl / 2, -wB * 0.25, 0), p(bl / 2, -wM * 0.25, lift), p(bl / 2, -wM * 0.8, lift), p(-bl / 2, -wB * 0.8, 0)], bLight, 0.95);
        // breech cap + cascabel knob
        g.fillStyle(bMid, 1);
        g.fillCircle(bx - dx * (bl / 2), by - dy * (bl / 2), wB * 1.05);
        g.fillStyle(bLight, 0.9);
        g.fillCircle(bx - dx * (bl / 2 + 4), by - dy * (bl / 2 + 4), 1.7);
        // muzzle collar + dark bore staring sideways
        g.lineStyle(2, L4 ? 0xffd700 : 0x101010, 1);
        g.lineBetween(p(bl / 2 - 2.5, wM + 0.7, lift)[0], p(bl / 2 - 2.5, wM + 0.7, lift)[1], p(bl / 2 - 2.5, -wM - 0.7, lift)[0], p(bl / 2 - 2.5, -wM - 0.7, lift)[1]);
        g.fillStyle(0x0a0a0a, 1);
        g.fillEllipse(bx + dx * (bl / 2), by + dy * (bl / 2) - lift, 3.4, wM * 1.7);

        // Broken carriage wheel leaning against the breech
        const wx = bx - dx * (bl / 2) - 6, wy = by - dy * (bl / 2) + 1;
        g.lineStyle(2, dk(0x3f2a18, 0.95), 1);
        g.strokeEllipse(wx, wy - 3, 8.5, 9.5);
        g.lineStyle(1.2, 0x795548, 0.95);
        g.lineBetween(wx, wy - 7.5, wx, wy + 1.2);
        g.lineBetween(wx - 4, wy - 3.4, wx + 4, wy - 2.6);
        // a snapped-off rim chunk on the ground
        g.lineStyle(2, dk(0x3f2a18, 0.8), 0.9);
        g.beginPath();
        g.arc(wx + 7, wy + 4, 4, Math.PI * 0.1, Math.PI * 0.75);
        g.strokePath();
    }

    // ── BALLISTA 2x2 — snapped bow arms, slack sinew, scattered bolts ──
    private static ballista(c: W) {
        const { g, P, cx, cy, seed, level, time, fire } = c;
        void time; void fire;
        const L3 = level >= 3;
        const limbMid = L3 ? 0xe8e8da : 0x5d4037;
        const limbDark = L3 ? 0xcfcfc2 : 0x3f2a18;
        const rope = L3 ? 0xd8b96a : 0xb8a07a;
        const sinew = L3 ? 0xffe9a0 : 0xe8e0d0;
        charField(c.base ?? g, cx, cy, 36, seed, 0.32);

        // Broken planked turntable — a wedge torn out
        g.fillStyle(dk(0x5d4037, 0.85), 0.95);
        g.fillEllipse(cx, cy + 1, 40, 20);
        g.fillStyle(dk(0x795548, 0.85), 0.9);
        g.fillEllipse(cx, cy, 36, 17);
        poly(g, [[cx + 4, cy - 1], [cx + 20, cy - 6], [cx + 16, cy + 5]], 0x241d13, 0.85); // missing wedge
        g.lineStyle(1, dk(0x3f2a18, 0.9), 0.55); // plank seams
        for (let i = -2; i <= 2; i++) g.lineBetween(cx - 15 + i * 2, cy - 7 + i * 4, cx + 14 + i * 2, cy - 8.5 + i * 4);

        // King-post stub, splintered
        const kp = P(1, 0.95);
        beam(g, kp[0], kp[1], -1.35, 11, 4, dk(0x5d4037, 0.95), 1, 6);
        g.fillStyle(0x9b7b5a, 0.9);
        poly(g, [[kp[0] + 1, kp[1] - 9], [kp[0] + 3.5, kp[1] - 12], [kp[0] + 4, kp[1] - 7.5]], 0x9b7b5a, 0.9);

        // Torsion housings still bolted to the deck; the snapped limbs rear off them
        const arm = (rx: number, ry: number, dir: number) => {
            // housing stub — a squat cylinder with its windings sprung loose
            g.fillStyle(dk(0x3f2a18, 0.95), 1);
            g.fillEllipse(rx, ry + 1, 7, 3.6);
            g.fillStyle(dk(0x5d4037, 0.95), 1);
            g.fillRect(rx - 3.5, ry - 4, 7, 5);
            g.fillEllipse(rx, ry - 4, 7, 3.4);
            g.lineStyle(1.1, rope, 0.9);
            g.strokeEllipse(rx, ry - 2.5, 6.4, 3);
            g.strokeEllipse(rx + dir * 2, ry + 3, 4.4, 2.2);
            // limb: rears up from the housing, folds at a bright torn break
            const ex = rx + dir * 8, ey = ry - 9;
            g.lineStyle(3.2, limbMid, 1);
            g.lineBetween(rx + dir * 1.5, ry - 3, ex, ey);
            g.lineStyle(2.6, limbDark, 1);
            g.lineBetween(ex, ey, ex + dir * 8, ey + 6.5);
            g.fillStyle(L3 ? 0xf6f2e4 : 0x9b7b5a, 0.95);
            g.fillRect(ex - 1.5, ey - 1.5, 3, 3);
            // slack sinew from the broken tip, coiling onto the deck
            g.lineStyle(1.2, sinew, 0.85);
            g.beginPath();
            g.moveTo(ex + dir * 8, ey + 6.5);
            g.lineTo(ex + dir * 4, ey + 11);
            g.lineTo(ex + dir * 7, ey + 13);
            g.strokePath();
        };
        arm(cx - 13, cy - 3, -1);
        arm(cx + 13, cy - 5, 1);

        // Scattered bolts — two flat, one stuck quivering in the earth
        const bolt = (x: number, y: number, ang: number, stuck: boolean) => {
            if (stuck) {
                g.lineStyle(1.8, 0x5d4037, 1);
                g.lineBetween(x, y, x + 3, y - 9);
                poly(g, [[x + 3, y - 9], [x + 5.2, y - 12.5], [x + 5.8, y - 8.5]], 0x9a9aa2, 0.95);
                g.fillStyle(0x141414, 0.4);
                g.fillEllipse(x, y + 0.6, 5, 2.2);
            } else {
                beam(g, x, y, ang, 15, 1.8, 0x5d4037, 0.95);
                const hx = x + Math.cos(ang) * 7.5, hy = y + Math.sin(ang) * 0.5 * 7.5;
                poly(g, [[hx, hy - 2], [hx + 3.5, hy], [hx, hy + 2]], 0x9a9aa2, 0.95);
                g.lineStyle(1, dk(0xc0392b, 0.9), 0.9);
                g.lineBetween(x - Math.cos(ang) * 6, y - Math.sin(ang) * 0.5 * 6 - 1.5, x - Math.cos(ang) * 7.5, y - Math.sin(ang) * 0.5 * 7.5 + 1);
            }
        };
        const b1 = P(1.55, 1.55), b2 = P(0.5, 0.62), b3 = P(1.15, 1.75);
        bolt(b1[0], b1[1], 0.35, false);
        bolt(b2[0], b2[1], 2.6, false);
        bolt(b3[0], b3[1], 0, true);

        // wood debris
        for (let i = 0; i < 4; i++) {
            const r1 = R(seed, i, 8.9), r2 = R(seed, i, 9.7);
            const [x, y] = P(0.45 + r1 * 1.3, 0.45 + r2 * 1.2);
            chip(g, x, y, r1 * Math.PI, 7 + r2 * 4, 2.4, dk(0x795548, 0.7), 0.9);
        }
    }

    // ── XBOW 2x2 — drum caved in, prod snapped into a V, spilled magazine ──
    private static xbow(c: W) {
        const { g, P, cx, cy, seed, level, time, fire } = c;
        void time; void fire;
        const L3 = level >= 3;
        const wallLit = [0x6d5334, 0x4a4a56, 0x7d5c3a][Math.min(2, level - 1)];
        const wallDark = [0x53401f, 0x35353f, 0x5f4526][Math.min(2, level - 1)];
        const prodA = L3 ? 0xe8e4d4 : 0x42424c;
        const prodB = L3 ? 0xcfc9b8 : 0x26262e;
        charField(c.base ?? g, cx, cy, 36, seed, 0.34);

        // Collapsed drum — far rim first (inner face), then the void, then the near rim
        for (let i = 0; i < 7; i++) {
            const t0 = 1.08 + (i / 7) * 0.84, t1 = 1.08 + ((i + 1) / 7) * 0.84;
            const hgt = 3.5 + R(seed, i + 20, 4.7) * 2;
            const x0 = cx + Math.cos(t0 * Math.PI) * 21, y0 = cy - 2 + Math.sin(t0 * Math.PI) * 10.5;
            const x1 = cx + Math.cos(t1 * Math.PI) * 21, y1 = cy - 2 + Math.sin(t1 * Math.PI) * 10.5;
            poly(g, [[x0, y0], [x1, y1], [x1, y1 - hgt], [x0, y0 - hgt]], dk(wallDark, 0.7), 1);
        }
        g.fillStyle(0x23232b, 0.95); // interior void
        g.fillEllipse(cx, cy - 2, 42, 21);
        // broken rim wall (front arc only, jagged height)
        for (let i = 0; i < 9; i++) {
            const t0 = -0.15 + (i / 9) * 1.3, t1 = -0.15 + ((i + 1) / 9) * 1.3;
            if (i === 5 || i === 6) continue; // the caved breach
            const hgt = 6 + R(seed, i, 5.2) * 4;
            const x0 = cx + Math.cos(t0 * Math.PI) * 23, y0 = cy - 2 + Math.sin(t0 * Math.PI) * 11.5;
            const x1 = cx + Math.cos(t1 * Math.PI) * 23, y1 = cy - 2 + Math.sin(t1 * Math.PI) * 11.5;
            poly(g, [[x0, y0], [x1, y1], [x1, y1 - hgt], [x0, y0 - hgt * 0.85]], i < 3 ? dk(wallDark, 0.9) : dk(wallLit, 0.9), 1);
            g.lineStyle(1, dk(wallDark, 0.7), 0.8);
            g.lineBetween(x0, y0 - hgt * 0.85, x1, y1 - hgt);
        }
        // rubble spilling out of the breach
        for (let i = 0; i < 5; i++) {
            const r1 = R(seed, i, 6.6), r2 = R(seed, i, 7.7);
            chunk(g, cx + 14 + r1 * 12, cy + 4 + r2 * 6, 3 + r1 * 3, dk(wallLit, 0.75));
        }

        // The prod broken in a V — two limbs rearing from the fallen receiver
        const rc = P(0.95, 1.0);
        beam(g, rc[0], rc[1], 0.3, 18, 3.4, dk(L3 ? 0xc9992a : 0x5d4037, 0.9), 1); // fallen receiver rail
        g.lineStyle(3, prodA, 1);
        g.lineBetween(rc[0] - 2, rc[1] - 1, rc[0] - 11, rc[1] - 11);
        g.lineStyle(3, prodB, 1);
        g.lineBetween(rc[0] + 2, rc[1], rc[0] + 12, rc[1] - 9);
        g.fillStyle(L3 ? 0xf6f2e4 : 0x6a6a76, 0.95); // torn metal at the break
        g.fillRect(rc[0] - 1.8, rc[1] - 2.4, 3.6, 3);
        // slack string sagging between the V tips
        g.lineStyle(1.2, L3 ? 0xffe9a0 : 0xe8e0d0, 0.85);
        g.beginPath();
        g.moveTo(rc[0] - 11, rc[1] - 11);
        g.lineTo(rc[0] + 0.5, rc[1] + 3.5);
        g.lineTo(rc[0] + 12, rc[1] - 9);
        g.strokePath();

        // Tipped magazine hopper, bolts fanned out
        const mg = P(1.45, 1.5);
        poly(g, [[mg[0] - 6, mg[1] - 1], [mg[0] + 3, mg[1] - 4.5], [mg[0] + 7, mg[1] - 0.5], [mg[0] - 2, mg[1] + 3]], dk(wallLit, 0.95), 1);
        poly(g, [[mg[0] - 6, mg[1] - 1], [mg[0] - 2, mg[1] + 3], [mg[0] - 2.5, mg[1] + 5.5], [mg[0] - 6.5, mg[1] + 1.5]], dk(wallDark, 0.95), 1);
        for (let i = 0; i < 3; i++) {
            beam(g, mg[0] + 4 + i * 3, mg[1] + 3 + i * 1.4, 0.2 + i * 0.16, 10, 1.6, 0x5d4037, 0.95);
        }
    }

    // ── MORTAR 2x2 — cracked bowl half-buried, base ring shattered ──
    private static mortar(c: W) {
        // THE BURST EMPLACEMENT (one-shot redesign 2026-07-19): the magazine
        // cooked off. The bowl lies SPLIT in two half-shells, the heavy base
        // ring is tilted half-buried, an asymmetric scorch fan blows out the
        // east side, and dud shells spill from the shattered rack.
        const { g, cx, cy, seed, level } = c;
        const L4 = level >= 4;
        const iron = L4 ? 0xb8860b : 0x3a3a3a;
        const ironLit = L4 ? 0xe6c352 : 0x565656;
        const ironDk = dk(iron, 0.62);

        // ground pass: char + the blown-out scorch fan (east), never a plate
        const base = c.base ?? g;
        charField(base, cx, cy, 30, seed, 0.4);
        const fan: number[][] = [[cx + 4, cy + 1]];
        const FN = 6;
        for (let i = 0; i <= FN; i++) {
            const th = -0.62 + (1.24 * i) / FN;
            const r = 24 + R(seed, i, 7.7) * 14;
            fan.push([cx + 4 + Math.cos(th) * r, cy + 1 + Math.sin(th) * r * 0.5]);
        }
        poly(base, fan, 0x1c1712, 0.5);
        poly(base, fan.map(p => [cx + 4 + (p[0] - cx - 4) * 0.62, cy + 1 + (p[1] - cy - 1) * 0.62]), 0x120e0a, 0.55);

        // the base ring, tilted and half-sunk (a fat open ellipse ring)
        g.lineStyle(4, ironDk, 1);
        g.strokeEllipse(cx - 3, cy + 3, 24, 9.5);
        g.lineStyle(2, iron, 1);
        g.strokeEllipse(cx - 3.5, cy + 2, 24, 9.5);
        g.fillStyle(0x14100b, 0.9); // the pit it guarded
        g.fillEllipse(cx - 3, cy + 3.5, 17, 6.2);

        // WEST half-shell: resting mouth-down like a turtle shell
        const wx = cx - 14, wy = cy - 3;
        g.fillStyle(iron, 1);
        g.beginPath();
        g.arc(wx, wy + 2, 9.5, Math.PI, Math.PI * 2);
        g.closePath();
        g.fillPath();
        g.fillStyle(ironLit, 1);
        g.beginPath();
        g.arc(wx - 1.5, wy + 1.2, 6.4, Math.PI * 1.05, Math.PI * 1.75);
        g.lineTo(wx - 1.5, wy + 1.8);
        g.closePath();
        g.fillPath();
        g.lineStyle(1.4, ironDk, 1); // ragged split edge
        g.beginPath();
        g.moveTo(wx - 9.5, wy + 2);
        g.lineTo(wx - 5, wy + 2.8);
        g.lineTo(wx - 1, wy + 1.6);
        g.lineTo(wx + 4, wy + 2.9);
        g.lineTo(wx + 9.5, wy + 2);
        g.strokePath();

        // EAST half-shell: blown further, mouth up, cupping shadow
        const ex = cx + 13, ey = cy - 1;
        g.fillStyle(ironDk, 1);
        g.beginPath();
        g.arc(ex, ey, 8.6, Math.PI * 0.94, Math.PI * 2.06);
        g.closePath();
        g.fillPath();
        g.fillStyle(0x0c0a08, 0.95); // the cupped hollow
        g.fillEllipse(ex, ey - 1.2, 12.6, 4.6);
        g.fillStyle(iron, 1); // near rim lip catches light
        g.fillEllipse(ex, ey + 0.6, 13.5, 2.2);

        // shattered shell rack: two splintered timbers crossing
        g.lineStyle(2.6, 0x4a3520, 1);
        g.lineBetween(cx - 6, cy + 10, cx + 6, cy + 6.5);
        g.lineStyle(2.2, 0x5f472c, 1);
        g.lineBetween(cx + 1, cy + 11.5, cx + 9, cy + 8);

        // dud shells spilled along the fan (deterministic scatter)
        for (let i = 0; i < 4; i++) {
            const sx = cx + 8 + R(seed, i, 9.3) * 16;
            const sy = cy + 4 + R(seed, i, 5.9) * 7 - i * 1.2;
            g.fillStyle(0x23201c, 1);
            g.fillEllipse(sx, sy, 5.4, 3.4);
            g.fillStyle(0x39352f, 1);
            g.fillEllipse(sx - 0.8, sy - 0.7, 2.8, 1.5);
            if (L4) { g.fillStyle(0xffd700, 0.8); g.fillRect(sx + 1.2, sy - 1.4, 1.4, 1.4); }
        }

        // one ember pocket still glowing in the pit (static — wrecks bake 1 frame)
        g.fillStyle(0x7a2c12, 0.85);
        g.fillEllipse(cx - 5, cy + 3.2, 3.2, 1.7);
        g.fillStyle(0xd96a2b, 0.7);
        g.fillEllipse(cx - 5.4, cy + 2.9, 1.6, 0.9);
    }

    private static tesla(c: W) {
        const { g, cx, cy, seed, level, time, fire } = c;
        const L3 = level >= 3;
        const post = L3 ? 0xddddcc : 0x4a3a2a;
        const ring = L3 ? 0xdaa520 : 0x7a7a7a;
        const ringStroke = L3 ? 0xb8860b : 0x3a3a3a;
        charField(c.base ?? g, cx, cy, 20, seed, 0.36, 0x1c1812);

        // Scorched base plate + snapped anchor bolts
        g.fillStyle(0x2a2a2a, 0.85);
        g.fillEllipse(cx, cy + 2, 15, 7);
        g.fillStyle(0x141414, 0.9);
        g.fillRect(cx - 6, cy + 0.5, 2, 2);
        g.fillRect(cx + 5, cy + 2.5, 2, 2);

        // The mast — a standing stub kinked hard east. Slid coil rings draw FIRST,
        // then the mast line OVER them, so the bent silhouette stays readable.
        const bendX = cx - 2, bendY = cy - 10;
        const tipX = bendX + 15, tipY = bendY + 4.5;
        for (let i = 0; i < 3; i++) {
            const t = 0.3 + i * 0.26;
            const rx = bendX + (tipX - bendX) * t;
            const ry = bendY + (tipY - bendY) * t;
            g.lineStyle(1.8, ringStroke, 1);
            g.strokeEllipse(rx, ry + 0.6, 9 - i, 3.2);
            g.lineStyle(1, ring, 0.95);
            g.strokeEllipse(rx, ry, 9 - i, 3.2);
        }
        g.lineStyle(3.6, dk(post, 0.85), 1);
        g.lineBetween(cx - 2, cy + 1, bendX, bendY); // standing stub
        g.lineStyle(3, dk(post, 0.68), 1);
        g.lineBetween(bendX, bendY, tipX, tipY); // the kinked top
        g.fillStyle(L3 ? 0xf6f2e4 : 0x9b7b5a, 0.92); // torn kink
        g.fillRect(bendX - 1.6, bendY - 1.6, 3.2, 3.2);
        // one ring rolled off, lying flat
        g.lineStyle(1.6, ringStroke, 0.95);
        g.strokeEllipse(cx - 9, cy + 5, 8, 3.6);

        // The conductor orb — drooped to the ground at the mast tip, cracked
        const ox = tipX + 4, oy = tipY + 4;
        g.fillStyle(0x556677, 1);
        g.fillCircle(ox, oy, 4.6);
        g.fillStyle(0x778899, 0.9);
        g.fillCircle(ox - 1.4, oy - 1.6, 1.7);
        g.lineStyle(1, 0x223344, 0.95);
        g.beginPath();
        g.moveTo(ox - 3, oy - 2);
        g.lineTo(ox + 0.5, oy + 0.5);
        g.lineTo(ox - 1, oy + 3);
        g.strokePath();

        // DYING SPARKS — deterministic in time, thinning out as `fire` fades
        if (time > 0 && fire > 0.04) {
            const sites = [
                [bendX, bendY], [tipX, tipY], [ox, oy - 1], [cx - 2, cy - 4]
            ];
            for (let i = 0; i < 4; i++) {
                const rate = 0.9 + R(seed, i, 3.7) * 0.7;
                const phase = R(seed, i, 8.3);
                const cycle = ((time / 1000) * rate + phase) % 1;
                if (cycle < 0.28 * (0.35 + fire * 0.65)) {
                    const [sx, sy] = sites[i];
                    const jx = Math.sin(time / 31 + i * 2.1) * 2.5;
                    const jy = Math.cos(time / 27 + i * 1.3) * 1.5;
                    const a = (0.45 + 0.55 * Math.sin(time / 23 + i)) * (0.35 + fire * 0.65);
                    g.fillStyle(0x88ffff, Math.max(0, a));
                    g.fillRect(sx + jx - 1, sy + jy - 1, 2, 2);
                    g.fillStyle(0x00ccff, Math.max(0, a * 0.7));
                    g.fillRect(sx - jx * 0.6 - 1, sy - jy - 1, 2, 2);
                    // a micro arc crawling to the ground
                    if (i === 2) {
                        g.lineStyle(1, 0x44ddff, Math.max(0, a * 0.8));
                        g.beginPath();
                        g.moveTo(sx + jx, sy + jy);
                        g.lineTo(sx + jx * 0.4 - 2, sy + 3.5);
                        g.lineTo(sx - 1, sy + 5.5);
                        g.strokePath();
                    }
                }
            }
            // faint residual halo at the orb, breathing out
            const halo = (0.1 + 0.06 * Math.sin(time / 260)) * fire;
            g.fillStyle(0x66aacc, Math.max(0, halo));
            g.fillCircle(ox, oy, 8);
        }
    }

    // ── WALL 1x1 — a small quiet stub of the wall's own material, by level ──
    private static wall(c: W) {
        const { g, P, cx, cy, seed, level } = c;
        const L = Math.max(1, Math.min(4, level));
        const cfg = L >= 4
            ? { top: 0xd8d2c0, front: 0xb3ac98, side: 0x968f7c, h: 7 }
            : L >= 3
                ? { top: 0x4f4f60, front: 0x3c3c4c, side: 0x2d2d3a, h: 7 }
                : L >= 2
                    ? { top: 0xd4c4a8, front: 0xa89878, side: 0x8a7a68, h: 6 }
                    : { top: 0x8b6b4a, front: 0x6b4a30, side: 0x5a3a20, h: 6 };

        // faint dust, no char — walls break by the dozen and must stay quiet
        const ground = c.base ?? g;
        ground.fillStyle(0x4a4438, 0.18);
        ground.fillEllipse(cx, cy + 1, 26, 11);

        // The broken stub — jagged top remnant of the post
        isoBox(g, P, 0.5, 0.5, 0.24, 0.24, cfg.h, cfg.top, cfg.front, cfg.side, 1, 3.5, seed);

        // A snapped length of the connector bar running east — the wall's rhythm
        {
            const dxr = 0.894, dyr = 0.447; // grid +x on screen
            const ax2 = -3.4, ay2 = 1.7;    // half-across (toward grid +y)
            const bx0 = cx + 5.5, by0 = cy + 2.8;
            const ex2 = bx0 + dxr * 11, ey2 = by0 + dyr * 11;
            const hB = cfg.h - 2;
            poly(g, [[bx0 + ax2, by0 + ay2], [ex2 + ax2, ey2 + ay2], [ex2 + ax2, ey2 + ay2 - hB * 0.55], [bx0 + ax2, by0 + ay2 - hB]], cfg.front, 1);
            poly(g, [[bx0 - ax2, by0 - ay2 - hB], [ex2 - ax2, ey2 - ay2 - hB * 0.55], [ex2 + ax2, ey2 + ay2 - hB * 0.55], [bx0 + ax2, by0 + ay2 - hB]], cfg.top, 1);
            poly(g, [[ex2 - ax2, ey2 - ay2 - hB * 0.55], [ex2 + ax2, ey2 + ay2 - hB * 0.55], [ex2 + ax2 + 1.6, ey2 + ay2 + 0.4], [ex2 - ax2 + 1, ey2 - ay2]], cfg.side, 1); // torn end
        }

        if (L === 1) {
            // splintered stake fallen forward + a stub splinter
            beam(g, cx + 7, cy + 3.5, 0.42, 11, 2.4, dk(0x6b4a30, 0.95), 0.95);
            g.fillStyle(0x9b7b5a, 0.9);
            poly(g, [[cx + 1.5, cy - cfg.h + 1], [cx + 3.5, cy - cfg.h - 3], [cx + 4.5, cy - cfg.h + 1.5]], 0x9b7b5a, 0.9);
        } else if (L === 2) {
            chunk(g, cx - 8, cy + 4, 4, dk(0xa89878, 0.95));
            chunk(g, cx + 8, cy + 3, 3, dk(0xd4c4a8, 0.85));
            chip(g, cx + 3, cy + 6, 0.4, 7, 3, dk(0xe2d4b8, 0.8), 0.9); // fallen coping slab
        } else if (L === 3) {
            chunk(g, cx - 8, cy + 4, 4, dk(0x3c3c4c, 0.95));
            // sprung iron cap band
            g.lineStyle(1.8, 0x62626e, 0.95);
            g.beginPath();
            g.arc(cx + 7, cy + 4, 3.4, Math.PI * 0.2, Math.PI * 1.3);
            g.strokePath();
            g.fillStyle(0x7a7a88, 0.9);
            g.fillRect(cx + 4.5, cy + 2.5, 1.4, 1.4); // a shed rivet
        } else {
            chunk(g, cx - 8, cy + 4, 4, dk(0xb3ac98, 0.95));
            // the little gold pyramid cap, fallen on its side — the L4 signature
            poly(g, [[cx + 6, cy + 3.5], [cx + 10.5, cy + 2.6], [cx + 8.5, cy + 5.6]], 0xffd700, 0.95);
            poly(g, [[cx + 6, cy + 3.5], [cx + 8.5, cy + 5.6], [cx + 5.8, cy + 5.4]], 0xb8860b, 0.95);
        }
    }

    // ── PRISM 1x1 — shattered crystal shards, snapped obsidian pylons ──
    private static prism(c: W) {
        const { g, P, cx, cy, seed, level } = c;
        void P;
        const L = Math.max(1, Math.min(4, level));
        const glow = [0x6ee8ff, 0xb37cff, 0xff5ce1, 0xffe9a0][L - 1];
        const deep = [0x2fa8c8, 0x7e4fd0, 0xc02fa8, 0xdaa520][L - 1];
        const pylonLit = L >= 4 ? 0xdcd3ba : 0x3c3c4a;
        const pylonDark = L >= 4 ? 0xb3a98d : 0x26262f;
        charField(c.base ?? g, cx, cy, 20, seed, 0.3, 0x1a1a20);

        // Residual glow stain where the crystal died — ONE soft polygon
        const stain: number[][] = [];
        for (let i = 0; i < 7; i++) {
            const th = (i / 7) * Math.PI * 2;
            const r = 10 * (0.6 + 0.5 * R(seed, i, 5.9));
            stain.push([cx + Math.cos(th) * r, cy + Math.sin(th) * r * 0.5]);
        }
        poly(g, stain, glow, 0.14);

        // Snapped pylons — one stub still leaning, one lying full-length
        const st = [cx - 10, cy - 2];
        poly(g, [[st[0] - 2.2, st[1] + 2], [st[0] + 2.2, st[1] + 2.4], [st[0] + 3.4, st[1] - 6.5], [st[0] + 0.6, st[1] - 7.5]], pylonLit, 1);
        poly(g, [[st[0] + 2.2, st[1] + 2.4], [st[0] + 3.4, st[1] - 6.5], [st[0] + 4.6, st[1] - 5.4], [st[0] + 3.8, st[1] + 2.6]], pylonDark, 1);
        const ly = [cx + 3, cy + 6];
        poly(g, [[ly[0] - 8, ly[1] - 1.2], [ly[0] + 9, ly[1] - 3.6], [ly[0] + 10.5, ly[1] - 2.2], [ly[0] - 8, ly[1] + 1.2]], pylonDark, 1);
        poly(g, [[ly[0] + 9, ly[1] - 3.6], [ly[0] + 12.5, ly[1] - 3.2], [ly[0] + 10.5, ly[1] - 2.2]], deep, 0.95);

        // The crystal — burst into shards; the big half lies dark-cored
        const bigX = cx + 1, bigY = cy - 1;
        poly(g, [[bigX - 4.5, bigY], [bigX, bigY - 6.5], [bigX + 4.5, bigY - 1], [bigX + 0.5, bigY + 3]], glow, 0.92);
        poly(g, [[bigX - 4.5, bigY], [bigX, bigY - 6.5], [bigX + 0.2, bigY - 0.8]], 0xffffff, 0.5); // facet
        poly(g, [[bigX + 0.2, bigY - 0.8], [bigX + 4.5, bigY - 1], [bigX + 0.5, bigY + 3]], deep, 0.75);
        for (let i = 0; i < 5; i++) {
            const r1 = R(seed, i, 4.83), r2 = R(seed, i, 6.07), r3 = R(seed, i, 7.19);
            const x = cx - 12 + r1 * 24, y = cy - 3 + r2 * 10;
            poly(g, [[x, y - 2 - r3 * 2], [x + 2 + r3 * 1.5, y + 1], [x - 1.6, y + 1.4]], i % 2 ? glow : deep, 0.85);
        }
        // white glints on two shards
        g.fillStyle(0xffffff, 0.9);
        g.fillRect(bigX - 1, bigY - 4.5, 1.5, 1.5);
        g.fillRect(cx + 7, cy + 1.5, 1.3, 1.3);

        // cracked housing ring chunks
        chunk(g, cx - 4, cy + 7, 3.4, dk(pylonLit, 0.8));
        chunk(g, cx + 10, cy - 4, 3, dk(pylonDark, 0.9));
    }

    // ── DRAGONS BREATH 4x4 — burst battery: split tubes, silo pits, one dud shell ──
    private static dragonsBreath(c: W) {
        const { g, P, cx, cy, seed, level, time, fire } = c;
        const L2 = level >= 2;
        const tube = L2 ? 0x9c1f1f : 0xa03028;
        const tubeLit = L2 ? 0xc22e2e : 0xb84438;
        const band = L2 ? 0xe6dcc2 : 0xd8c49a;
        const nose = L2 ? 0xdaa520 : 0x8a6a2a;
        charField(c.base ?? g, cx, cy, 84, seed, 0.44);
        // ash drifts break the char field's edge
        for (let i = 0; i < 6; i++) {
            const r1 = R(seed, i, 21.3), r2 = R(seed, i, 22.7);
            const [ax, ay] = P(0.35 + r1 * 3.3, 0.3 + r2 * 3.4);
            g.fillStyle(0x4a4a4a, 0.28);
            g.fillRect(ax - 3, ay - 2, 6 + r1 * 5, 4);
        }

        // Shattered lacquer deck — three rim fragments with their gold edging
        const deckBits: [number, number, number, number][] = [
            [0.75, 0.7, 1.1, 0.35], [3.1, 2.1, 0.35, 1.2], [1.6, 3.3, 1.25, 0.35]
        ];
        deckBits.forEach(([u, v, du, dv], i) => {
            const A = P(u - du / 2, v - dv / 2), B = P(u + du / 2, v - dv / 2), C = P(u + du / 2, v + dv / 2), D = P(u - du / 2, v + dv / 2);
            poly(g, [A, B, C, D], dk(L2 ? 0x241418 : 0x3a2a2a, 1.25), 0.95);
            g.lineStyle(1.4, dk(L2 ? 0xdaa520 : 0xb8860b, 0.85), 0.9);
            g.lineBetween(D[0], D[1], C[0], C[1]);
            if (i === 0) { // a surviving jade stud
                g.fillStyle(0x3f8f5f, 0.9);
                g.fillCircle((A[0] + C[0]) / 2, (A[1] + C[1]) / 2, 1.6);
            }
        });

        // Open silo pits staring out of the char
        for (const [u, v] of [[1.35, 1.3], [2.4, 1.05], [2.7, 2.5]] as [number, number][]) {
            const [x, y] = P(u, v);
            g.lineStyle(2, dk(0x6a4a2a, 0.8), 0.9);
            g.strokeEllipse(x, y, 13, 6.5);
            g.fillStyle(0x140808, 0.95);
            g.fillEllipse(x, y, 11, 5.5);
        }

        // Split rocket tubes — burst open, peeled ends
        const splitTube = (x: number, y: number, ang: number, len: number, wgt: number) => {
            const dx = Math.cos(ang), dy = Math.sin(ang) * 0.5;
            const nx = -Math.sin(ang), ny = Math.cos(ang) * 0.5;
            const p = (d: number, o: number): number[] => [x + dx * d + nx * o, y + dy * d + ny * o];
            poly(g, [p(-len / 2, wgt), p(len / 2, wgt * 0.8), p(len / 2, -wgt * 0.8), p(-len / 2, -wgt)], tube, 1);
            poly(g, [p(-len / 2, -wgt * 0.1), p(len / 2, -wgt * 0.1), p(len / 2, -wgt * 0.8), p(-len / 2, -wgt)], tubeLit, 0.95);
            g.lineStyle(1.4, band, 0.9);
            g.lineBetween(p(-len * 0.2, wgt * 0.95)[0], p(-len * 0.2, wgt * 0.95)[1], p(-len * 0.2, -wgt * 0.95)[0], p(-len * 0.2, -wgt * 0.95)[1]);
            // burst end — dark torn interior with peeled petals
            poly(g, [p(len / 2 - 1, wgt * 0.8), p(len / 2 + 4, wgt * 1.7), p(len / 2 + 1.5, wgt * 0.2)], dk(tube, 0.7), 1);
            poly(g, [p(len / 2 - 1, -wgt * 0.8), p(len / 2 + 4.5, -wgt * 1.6), p(len / 2 + 1.5, -wgt * 0.2)], dk(tubeLit, 0.7), 1);
            g.fillStyle(0x140808, 1);
            g.fillEllipse(p(len / 2, 0)[0], p(len / 2, 0)[1], 3.5, wgt * 1.5);
        };
        const t1 = P(1.05, 2.3), t2 = P(2.15, 1.75), t3 = P(1.9, 0.85);
        splitTube(t1[0], t1[1], 0.55 + (R(seed, 1, 3.3) - 0.5) * 0.3, 24, 4.4);
        splitTube(t2[0], t2[1], 2.5, 21, 4);
        splitTube(t3[0], t3[1], -0.35, 18, 3.6);
        // one tube still upright in its silo, scorched hollow
        const up = P(3.15, 3.05);
        poly(g, [[up[0] - 4, up[1]], [up[0] - 3.4, up[1] - 12], [up[0] + 3.4, up[1] - 12], [up[0] + 4, up[1]]], dk(tube, 0.65), 1);
        g.fillStyle(0x140808, 1);
        g.fillEllipse(up[0], up[1] - 12, 6.8, 3);

        // THE DUD — one intact shell lying unexploded, nose cone and all
        const dd = P(0.85, 1.7);
        const da = 0.25;
        const ddx = Math.cos(da), ddy = Math.sin(da) * 0.5, dnx = -Math.sin(da), dny = Math.cos(da) * 0.5;
        const dp = (d: number, o: number): number[] => [dd[0] + ddx * d + dnx * o, dd[1] + ddy * d + dny * o];
        poly(g, [dp(-8, 3), dp(6, 3), dp(6, -3), dp(-8, -3)], tubeLit, 1);
        poly(g, [dp(-8, -0.4), dp(6, -0.4), dp(6, -3), dp(-8, -3)], tube, 0.9);
        g.lineStyle(1.3, band, 0.95);
        g.lineBetween(dp(-2, 3.2)[0], dp(-2, 3.2)[1], dp(-2, -3.2)[0], dp(-2, -3.2)[1]);
        poly(g, [dp(6, 3), dp(12, 0), dp(6, -3)], nose, 1);
        g.lineStyle(1, 0x8a7a5a, 0.9); // limp fuse
        g.beginPath();
        g.moveTo(dp(-8, 0)[0], dp(-8, 0)[1]);
        g.lineTo(dp(-11, 1.5)[0], dp(-11, 1.5)[1] + 1);
        g.lineTo(dp(-12.5, 0.5)[0], dp(-12.5, 0.5)[1] + 2);
        g.strokePath();

        // gilded dragon-altar scraps at L2 — a horn and a scale plate in the ash
        if (L2) {
            const hn = P(2.05, 2.85);
            poly(g, [[hn[0], hn[1]], [hn[0] + 6, hn[1] - 4], [hn[0] + 2.5, hn[1] + 1]], 0xffd700, 0.92);
            chip(g, hn[0] - 9, hn[1] + 2, 0.4, 7, 4, dk(0xf0c24a, 0.8), 0.9);
        }

        // debris + heavy burn (4x4 → live redraw): the battery burns hot
        for (let i = 0; i < 9; i++) {
            const r1 = R(seed, i, 12.9), r2 = R(seed, i, 14.1);
            const [x, y] = P(0.5 + r1 * 3, 0.55 + r2 * 2.9);
            chunk(g, x, y, 3.5 + r2 * 4, i % 3 === 0 ? dk(tube, 0.6) : dk(0x3a2a2a, 1.1));
        }
        burnFx(g, seed, cx, cy, 96, 48, time, fire, 4, 7, 4);
    }

    // ── SPIKE LAUNCHER 2x2 — sprung trebuchet: dropped counterweight, quills everywhere ──
    private static spikeLauncher(c: W) {
        const { g, P, cx, cy, seed, level, time, fire } = c;
        void time; void fire;
        const L4 = level >= 4;
        const L3 = level >= 3;
        const woodMid = L4 ? 0x74553c : L3 ? 0x4a3830 : 0x795548;
        const woodLight = L4 ? 0x8f6d4c : L3 ? 0x5a4840 : 0x8d6e63;
        const cwStone = L4 ? 0xcfc5ae : L3 ? 0x606060 : 0x757575;
        const cwDark = L4 ? 0xafa58c : L3 ? 0x3a3a3a : 0x5a5a5a;
        const quill = L4 ? 0xdaa520 : L3 ? 0x888888 : 0xaaaaaa;
        const quillHi = L4 ? 0xffd700 : 0xcccccc;
        charField(c.base ?? g, cx, cy, 36, seed, 0.33);

        // The dropped counterweight — a cracked stone block sunk into the ground
        isoBox(g, P, 0.8, 1.15, 0.42, 0.34, 8, dk(cwStone, 0.95), dk(cwStone, 0.85), dk(cwDark, 0.9), 1, 3, seed);
        const cw = P(0.8, 1.15);
        g.lineStyle(1.2, dk(cwDark, 0.6), 0.95);
        g.beginPath();
        g.moveTo(cw[0] - 4, cw[1] - 7.5);
        g.lineTo(cw[0] - 1, cw[1] - 4);
        g.lineTo(cw[0] - 3, cw[1] - 1);
        g.strokePath();

        // Collapsed A-frame + the snapped throwing arm, sling limp
        const fr = P(1.25, 0.7);
        beam(g, fr[0], fr[1], 0.5, 24, 3, woodMid, 1, 4);
        beam(g, fr[0] - 2, fr[1] + 2, 0.85, 20, 2.6, dk(woodMid, 0.85), 0.95);
        const arm = P(1.1, 1.45);
        beam(g, arm[0] - 6, arm[1], 0.2, 20, 3, woodLight, 1, 5); // long arm half, kicked up
        beam(g, arm[0] + 10, arm[1] + 3, 0.75, 12, 2.6, dk(woodLight, 0.8), 0.95); // snapped tip half
        g.fillStyle(0x9b7b5a, 0.9);
        g.fillRect(arm[0] + 3.4, arm[1] - 3.4, 3, 3); // torn break
        g.lineStyle(1.1, L4 ? 0xdaa520 : 0xb8a07a, 0.85); // sling ropes trailing
        g.beginPath();
        g.moveTo(arm[0] + 15, arm[1] + 6);
        g.lineTo(arm[0] + 19, arm[1] + 9);
        g.lineTo(arm[0] + 16, arm[1] + 10.5);
        g.strokePath();
        // pivot hub gear rolled free
        const hub = P(1.7, 0.65);
        g.lineStyle(2.2, L3 ? 0x505050 : 0x616161, 1);
        g.strokeEllipse(hub[0], hub[1], 7.5, 7);
        g.lineStyle(1.2, dk(L3 ? 0x505050 : 0x616161, 0.8), 1);
        for (let i = 0; i < 6; i++) {
            const th = (i / 6) * Math.PI * 2 + 0.3;
            g.lineBetween(hub[0] + Math.cos(th) * 3.6, hub[1] + Math.sin(th) * 3.3, hub[0] + Math.cos(th) * 5.2, hub[1] + Math.sin(th) * 4.8);
        }

        // QUILLS — the half-launched volley, stuck in the earth all around
        for (let i = 0; i < 7; i++) {
            const r1 = R(seed, i, 5.51), r2 = R(seed, i, 6.62), r3 = R(seed, i, 7.73);
            const [x, y] = P(0.25 + r1 * 1.6, 0.3 + r2 * 1.5);
            if (i < 5) { // stuck upright at battle angles
                const lean = (r3 - 0.5) * 6;
                g.fillStyle(0x141414, 0.35);
                g.fillEllipse(x, y + 0.6, 4.5, 2);
                g.lineStyle(1.9, quill, 1);
                g.lineBetween(x, y, x + lean, y - 8 - r3 * 3);
                g.fillStyle(quillHi, 0.95);
                g.fillRect(x + lean - 0.8, y - 9.5 - r3 * 3, 1.6, 1.6);
            } else { // lying flat
                beam(g, x, y, r3 * Math.PI, 9, 1.8, quill, 0.95);
            }
        }
        // the spiky ammo ball rolled loose, still bristling
        const ball = P(1.68, 1.6);
        g.fillStyle(L4 ? 0xeeeedd : 0x555555, 1);
        g.fillCircle(ball[0], ball[1] - 2, 3.6);
        g.lineStyle(1.4, quill, 1);
        for (let i = 0; i < 6; i++) {
            const th = (i / 6) * Math.PI * 2 + 0.5;
            g.lineBetween(ball[0] + Math.cos(th) * 2.8, ball[1] - 2 + Math.sin(th) * 2.8, ball[0] + Math.cos(th) * 5.6, ball[1] - 2 + Math.sin(th) * 5.6);
        }
    }

    // ── WATCHTOWER 2x2 — the tower felled: shaft in segments, cap grounded, brazier cold ──
    private static watchtower(c: W) {
        const { g, P, cx, cy, seed, level, time, fire } = c;
        void time; void fire;
        const L2 = level >= 2;
        const shaftLit = L2 ? 0xdcd3ba : 0x94744c;
        const shaftDark = L2 ? 0xa3956f : 0x5f462b;
        const brace = L2 ? 0xb8860b : 0x5c4326;
        const roofLit = L2 ? 0x3a5f8a : 0x8a3d2f;
        const roofDark = L2 ? 0x2c4a70 : 0x6e2f24;
        charField(c.base ?? g, cx, cy, 36, seed, 0.32);

        // Stone footing still rooted, torn open at the top
        isoBox(g, P, 0.58, 0.58, 0.48, 0.48, 10, dk(0xb0a892, 0.9), dk(0xb0a892, 0.8), dk(0x8a8272, 0.85), 1, 5, seed);

        // The shaft — two felled segments in a diagonal line, breaks showing
        const seg = (x: number, y: number, ang: number, len: number, w0: number, w1: number) => {
            const dx = Math.cos(ang), dy = Math.sin(ang) * 0.5;
            const nx = -Math.sin(ang), ny = Math.cos(ang) * 0.5;
            const p = (d: number, o: number): number[] => [x + dx * d + nx * o, y + dy * d + ny * o];
            g.fillStyle(0x141414, 0.22); // contact shadow grounds the log
            g.fillEllipse(x + 1, y + 2.5, len * 0.95, len * 0.34);
            poly(g, [p(-len / 2, w0), p(len / 2, w1), p(len / 2, -w1), p(-len / 2, -w0)], shaftDark, 1);
            poly(g, [p(-len / 2, -w0 * 0.15), p(len / 2, -w1 * 0.15), p(len / 2, -w1), p(-len / 2, -w0)], shaftLit, 0.97);
            g.lineStyle(1.3, dk(shaftDark, 0.62), 0.95); // course bands around the shaft
            for (const tt of [-0.26, 0.3]) {
                g.lineBetween(p(len * tt, w0 * 0.95)[0], p(len * tt, w0 * 0.95)[1], p(len * tt, -w0 * 0.95)[0], p(len * tt, -w0 * 0.95)[1]);
            }
            // the shaft's signature X-brace, bold on the lit flank
            g.lineStyle(1.6, dk(brace, 0.8), 1);
            g.lineBetween(p(-len * 0.38, w0 * 0.85)[0], p(-len * 0.38, w0 * 0.85)[1], p(len * 0.28, -w1 * 0.85)[0], p(len * 0.28, -w1 * 0.85)[1]);
            g.lineBetween(p(-len * 0.38, -w0 * 0.85)[0], p(-len * 0.38, -w0 * 0.85)[1], p(len * 0.28, w1 * 0.85)[0], p(len * 0.28, w1 * 0.85)[1]);
            // silhouette edges keep the box crisp against the char
            g.lineStyle(1.1, dk(shaftDark, 0.55), 0.95);
            g.lineBetween(p(-len / 2, -w0)[0], p(-len / 2, -w0)[1], p(len / 2, -w1)[0], p(len / 2, -w1)[1]);
            g.lineBetween(p(-len / 2, w0)[0], p(-len / 2, w0)[1], p(len / 2, w1)[0], p(len / 2, w1)[1]);
            // the broken end gapes hollow toward the viewer — torn rim ticks around a void
            g.fillStyle(0x261e14, 1);
            g.fillEllipse(p(len / 2, 0)[0], p(len / 2, 0)[1], 4, w1 * 2.1);
            g.fillStyle(L2 ? 0xe5dcc2 : 0x9b7b5a, 0.95);
            g.fillRect(p(len / 2, w1 * 0.7)[0] - 1, p(len / 2, w1 * 0.7)[1] - 1, 2.2, 2.2);
            g.fillRect(p(len / 2, -w1 * 0.6)[0] - 1, p(len / 2, -w1 * 0.6)[1] - 1.4, 2, 2.4);
        };
        const s1 = P(1.12, 1.12), s2 = P(1.72, 1.42);
        seg(s1[0], s1[1], 0.4, 20, 4, 3.4);
        seg(s2[0], s2[1], 0.66, 13, 3.2, 2.7);

        // The little pyramid cap on the ground, tipped on its side
        const cap = P(1.78, 0.72);
        poly(g, [[cap[0] - 7, cap[1] + 1], [cap[0] + 1, cap[1] - 6.5], [cap[0] + 8, cap[1] + 0.5], [cap[0] + 1, cap[1] + 3.5]], roofLit, 1);
        poly(g, [[cap[0] - 7, cap[1] + 1], [cap[0] + 1, cap[1] + 3.5], [cap[0] + 0.5, cap[1] + 6], [cap[0] - 6.5, cap[1] + 3.4]], roofDark, 1);
        g.lineStyle(1.4, L2 ? 0xdaa520 : 0x5c4326, 0.9); // finial stub poking sideways
        g.lineBetween(cap[0] + 1, cap[1] - 6.5, cap[0] + 4.5, cap[1] - 9);

        // Brazier tipped off the deck — bowl on its side, coals spilled COLD
        const bz = P(0.55, 1.55);
        g.lineStyle(2.2, 0x4a4a4a, 1);
        g.beginPath();
        g.arc(bz[0], bz[1] - 2, 4.4, Math.PI * 0.75, Math.PI * 1.95);
        g.strokePath();
        g.fillStyle(0x2a2020, 0.95);
        for (let i = 0; i < 5; i++) {
            g.fillCircle(bz[0] + 3 + R(seed, i, 4.1) * 7, bz[1] + 1 + R(seed, i, 5.3) * 3, 1.5);
        }

        // Deck plank chips + a dropped pennant
        for (let i = 0; i < 4; i++) {
            const r1 = R(seed, i, 8.2), r2 = R(seed, i, 9.4);
            const [x, y] = P(0.4 + r1 * 1.3, 0.4 + r2 * 1.3);
            chip(g, x, y, r1 * Math.PI, 8 + r2 * 4, 3, dk(0xa08a64, 0.8), 0.9);
        }
        const pn = P(1.35, 1.78);
        chip(g, pn[0], pn[1], 0.3, 7, 4, dk(L2 ? 0xf4ecd8 : 0xd8563c, 0.85), 0.9);
    }

    // ── JUKEBOX 1x1 — split cabinet, spilled brass pipes and keys ──
    private static jukebox(c: W) {
        const { g, P, cx, cy, seed } = c;
        charField(c.base ?? g, cx, cy, 19, seed, 0.3);

        // Left cabinet half — still standing, leaning, gold trim hanging on
        isoBox(g, P, 0.42, 0.55, 0.3, 0.28, 9, dk(0x9c6c42, 0.9), dk(0x8a5c38, 0.9), dk(0x6b4226, 0.88), 1, 4, seed);
        const lh = P(0.42, 0.55);
        g.lineStyle(1.2, dk(0xc9a227, 0.9), 0.9);
        g.lineBetween(lh[0] - 6, lh[1] - 6.5, lh[0] + 1, lh[1] - 4);
        // Right half — torn off, lying face-up with the violet arch glass shattered
        const rh = P(0.72, 0.72);
        poly(g, [[rh[0] - 3, rh[1] - 2], [rh[0] + 8, rh[1] - 4.5], [rh[0] + 11, rh[1] - 0.5], [rh[0], rh[1] + 2.5]], dk(0x8a5c38, 0.85), 0.97);
        poly(g, [[rh[0] + 1, rh[1] - 1.4], [rh[0] + 7, rh[1] - 2.8], [rh[0] + 8.6, rh[1] - 0.8], [rh[0] + 2.4, rh[1] + 0.7]], 0x1a0f1e, 0.95);
        // violet glass shards
        for (let i = 0; i < 4; i++) {
            const r1 = R(seed, i, 4.9), r2 = R(seed, i, 6.1);
            const x = rh[0] + r1 * 12 - 2, y = rh[1] + 2 + r2 * 4;
            poly(g, [[x, y - 2], [x + 2, y + 0.6], [x - 1.6, y + 1]], 0xc98aff, 0.8);
        }
        g.fillStyle(0xffffff, 0.85);
        g.fillRect(rh[0] + 3, rh[1] + 3, 1.2, 1.2);

        // The brass horn — dented, lying with its bell to the sky
        const hn = P(0.35, 0.32);
        poly(g, [[hn[0], hn[1]], [hn[0] - 8, hn[1] - 4.5], [hn[0] - 9.5, hn[1] - 1], [hn[0] - 2, hn[1] + 2]], dk(0xd8b13a, 0.9), 0.97);
        g.lineStyle(1.6, dk(0xf2d268, 0.95), 0.95);
        g.strokeEllipse(hn[0] - 8.8, hn[1] - 2.6, 4.6, 5.6);
        g.fillStyle(0x4a3410, 0.95);
        g.fillEllipse(hn[0] - 8.8, hn[1] - 2.6, 2.6, 3.4);

        // Scattered pipes, keys and the crank
        for (let i = 0; i < 3; i++) {
            const r1 = R(seed, i, 7.7), r2 = R(seed, i, 8.9);
            beam(g, cx - 8 + r1 * 18, cy + 3 + r2 * 5, r1 * Math.PI, 6 + r2 * 3, 1.7, dk(0xb8922e, 0.95), 0.95);
        }
        for (let i = 0; i < 6; i++) {
            const r1 = R(seed, i, 10.3), r2 = R(seed, i, 11.5);
            g.fillStyle(i % 3 === 2 ? 0x241a10 : 0xf0ead8, 0.95);
            g.fillRect(cx - 10 + r1 * 20, cy + 1 + r2 * 7, 2, 1.4);
        }
        const ck = P(0.78, 0.35);
        g.lineStyle(1.4, dk(0x8a6a1e, 0.95), 0.95);
        g.beginPath();
        g.moveTo(ck[0], ck[1]);
        g.lineTo(ck[0] + 3, ck[1] - 1.8);
        g.lineTo(ck[0] + 4.5, ck[1] + 0.4);
        g.strokePath();
        g.fillStyle(0xc9a227, 0.95);
        g.fillCircle(ck[0], ck[1], 1.3);
    }
}
