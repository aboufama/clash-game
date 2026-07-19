import type Phaser from 'phaser';
import { BuildingRenderer } from '../BuildingRenderer';
import { windLoopAtScreen } from '../../systems/Wind';

/**
 * MECHANICA BARRACKS — clean-room design A: "FOUNDRY BASTION"
 *
 * A tall, compact 2x2 riveted factory-keep: a broad armored ground block with
 * a HUGE chain-driven rolling shutter door (the muster gate), a set-back upper
 * tier carrying one giant clockwork gear half-embedded in the facade (the
 * "training pulse" — it ratchets exactly one tooth per second), and a working
 * deck above: piston-driven chimney with deterministic steam, riveted boiler,
 * and a gantry crane arm at high levels. Palette walks brass (L1-3) → steel
 * (L4-6) → blackened iron (L7-8) → warm sandstone with gold/white ACCENTS
 * only (L9, Mastery).
 *
 * REFINEMENT PASS (owner notes, 2026-07-19): fewer, bolder shapes — secondary
 * clutter (redundant seam/rivet courses, pipe elbows/valves, door rack teeth,
 * hoist-chain dashes, armor straps, cornice rivets, boiler gauge/rivets, twin
 * stack, crane tie-back, yard drum, L8 buttresses) was cut; every SIGNATURE
 * element stays. SIZE CAP: L5 is the largest envelope — every level-driven
 * geometry term clamps at `sz = min(level, 5)`, so L6-9 keep the exact L5
 * footprint inset and silhouette height and evolve only via material shifts,
 * palette, richer signature detail, and finish (merlons, dome, gold accents).
 *
 * AMBIENT CONTRACT — one master idle period of PERIOD = 2000 ms; every
 * animated term is an exact integer harmonic (0.00% residual at the loop):
 *  - Signature gear: 12 teeth, 6 spokes; advances exactly one tooth pitch
 *    (30°) per BEAT = 1000 ms (eased snap in the beat's last 30%). Teeth
 *    align every beat, the 6-fold spokes only every second beat, so the drawn
 *    pattern repeats exactly at 2000 ms. Tooth/spoke chord over a snap is
 *    ~4-7 world px (>= 1.5 px quantization floor).
 *  - Drive chains on the facade crawl (theta * rG) px with a dash pitch of
 *    exactly one tooth-arc, so the dash pattern maps onto itself each beat.
 *  - Piston crosshead bobs on cos(2*pi*t/1000) (k=2), 2.2 px travel.
 *  - Furnace + door-lamp glow flicker at k=2 and k=4 (peaks on the snap).
 *  - Tier windows / porthole breathe at k=1.
 *  - Pennant cloth uses windLoopAtScreen(...) with periodMs = 2000 (the
 *    closed-loop bakeable wind helper).
 *  - Crane hook sways on sin(2*pi*t/2000), ~3.6 px travel (L7+).
 *  - Chimney steam is gated behind BuildingRenderer.AMBIENT_VAPOR (runtime
 *    effect only — never body art, so the bake stays clean).
 * doorOpen is a STATE driver, not an ambient: the shutter's raised height is
 * strictly monotonic in doorOpen (0 closed, 0.5 visibly half-open, 1 open).
 * time = 0 is a sane resting pose (gear on pitch, shutter as driven, piston
 * mid-stroke).
 */

const TAU = Math.PI * 2;
/** Master ambient loop (ms) — a 250 ms multiple; the bake probe measures it. */
const PERIOD = 2000;
/** Gear ratchet beat (ms) — the 2nd harmonic of PERIOD. */
const BEAT = 1000;

/** Era palettes: 0 brass (L1-3), 1 steel (L4-6), 2 blackened iron (L7-8),
 *  3 sandstone mastery (L9). */
const WALL_LIT = [0x9a7245, 0xa1794b, 0xa88152, 0x90949c, 0x878b93, 0x7c8088, 0x5d616a, 0x53565e, 0xbfb49a];
const WALL_DARK = [0x785634, 0x7e5c39, 0x84633e, 0x6d7179, 0x646870, 0x5a5e66, 0x44484f, 0x3b3f45, 0x9d9078];
const SEAM = [0x5f452a, 0x64492c, 0x694e30, 0x53575e, 0x4d5158, 0x45494f, 0x32363c, 0x2c3036, 0x8a8068];
const TRIM_METAL = [0xb87333, 0xb87333, 0xc08a3e, 0xa87f42, 0xa87f42, 0xa87f42, 0x8f6f3a, 0x8f6f3a, 0xdaa520];
const RIVET = [0xc79a62, 0xc79a62, 0xc79a62, 0xa9adb5, 0xa9adb5, 0xa9adb5, 0x7d8189, 0x7d8189, 0xcfc39f];
const DECK_TOP = [0x5d564a, 0x5d564a, 0x5d564a, 0x4e525a, 0x4e525a, 0x484c53, 0x33363c, 0x2f3238, 0xa89e86];
const DECK_SIDE = [0x48423a, 0x48423a, 0x48423a, 0x3c4047, 0x3c4047, 0x373b41, 0x26292e, 0x232529, 0x89806b];
const SHUT_LIT = [0x7c5c38, 0x7c5c38, 0x82603b, 0x6e727b, 0x6e727b, 0x666a73, 0x4c5058, 0x484c54, 0x6e5638];
const SHUT_DARK = [0x644a2d, 0x644a2d, 0x694e30, 0x5a5e66, 0x5a5e66, 0x53575f, 0x3b3f46, 0x373b42, 0x5a4630];
const CASING = [0x3a2f21, 0x3a2f21, 0x3a2f21, 0x33373e, 0x33373e, 0x2f333a, 0x22252a, 0x1f2226, 0x4a4234];
const PAD_TOP = [0x87795c, 0x87795c, 0x8a7c5f, 0x8a8779, 0x8a8779, 0x848173, 0x67645d, 0x625f58, 0xb5aa8f];
const PAD_EDGE = [0x695d45, 0x695d45, 0x6b5f47, 0x6b685e, 0x6b685e, 0x666357, 0x4b4943, 0x474540, 0x93876c];
const BOILER = [0x9a6b42, 0x9a6b42, 0x9a6b42, 0x7d818a, 0x7d818a, 0x767a83, 0x4e525a, 0x4a4e56, 0xb08048];
const STACK = [0x5a5148, 0x5a5148, 0x5a5148, 0x4a4e55, 0x4a4e55, 0x45494f, 0x33363c, 0x2f3238, 0x6e6656];

const GLOW_WINDOW = 0xffb84d;
const GLOW_FURNACE = 0xff8c3a;
const GLOW_INTERIOR = 0xe8a050;
const GOLD = 0xdaa520;
const GOLD_HI = 0xffd700;
const CREAM = 0xdcd3ba;

export function drawBarracksA(
    graphics: Phaser.GameObjects.Graphics,
    c1: Phaser.Math.Vector2,
    c2: Phaser.Math.Vector2,
    c3: Phaser.Math.Vector2,
    c4: Phaser.Math.Vector2,
    center: Phaser.Math.Vector2,
    alpha: number,
    _tint: number | null,
    building: { level?: number; doorOpen?: number } | undefined,
    baseGraphics: Phaser.GameObjects.Graphics | undefined,
    skipBase: boolean,
    onlyBase: boolean,
    time: number
): void {
    const level = Math.max(1, Math.min(9, Math.round(Number(building?.level) || 1)));
    const open = Math.max(0, Math.min(1, Number(building?.doorOpen) || 0));
    const li = level - 1;
    const cx = center.x;
    const cy = center.y;

    // ---- shared geometry ------------------------------------------------
    // Axis vectors: at(fe, fn) walks fe of the center->E half-diagonal and
    // fn of the center->N half-diagonal (fe, fn in -1..1 cover the plot).
    const exx = (c2.x - c4.x) / 2, exy = (c2.y - c4.y) / 2;
    const nxx = (c1.x - c3.x) / 2, nxy = (c1.y - c3.y) / 2;
    const at = (fe: number, fn: number, h = 0): number[] =>
        [cx + exx * fe + nxx * fn, cy + exy * fe + nxy * fn - h];
    const S1 = 0.62;             // main-block inset of the plot
    const S2 = 0.40;             // upper-tier inset
    /** SIZE CAP: L5 is the largest mass — L6-9 reuse the L5 envelope. */
    const sz = Math.min(level, 5);
    const H1 = 30 + sz * 2;      // main wall height
    const CT = 3;                // cornice band height
    const TH = 12 + sz;          // upper-tier height
    const H2 = H1 + CT + TH;     // deck height

    const lp = (v: Phaser.Math.Vector2, t: number): number[] =>
        [cx + (v.x - cx) * t, cy + (v.y - cy) * t];
    const b2 = lp(c2, S1), b3 = lp(c3, S1), b4 = lp(c4, S1);
    const t1 = lp(c1, S2), t2 = lp(c2, S2), t3 = lp(c3, S2), t4 = lp(c4, S2);

    const poly = (gr: Phaser.GameObjects.Graphics, pts: number[][], color: number, a: number): void => {
        gr.fillStyle(color, a);
        gr.beginPath();
        gr.moveTo(pts[0][0], pts[0][1]);
        for (let i = 1; i < pts.length; i++) gr.lineTo(pts[i][0], pts[i][1]);
        gr.closePath();
        gr.fillPath();
    };
    const strokePoly = (gr: Phaser.GameObjects.Graphics, pts: number[][], w: number, color: number, a: number): void => {
        gr.lineStyle(w, color, a);
        gr.beginPath();
        gr.moveTo(pts[0][0], pts[0][1]);
        for (let i = 1; i < pts.length; i++) gr.lineTo(pts[i][0], pts[i][1]);
        gr.closePath();
        gr.strokePath();
    };
    const up = (pt: number[], h: number): number[] => [pt[0], pt[1] - h];

    // ---- GROUND (contact shadow + compact pad + muster strip) -----------
    const g = baseGraphics ?? graphics;
    if (!skipBase) {
        // Chamfered contact shadow hugging the base — no plates, lawn breathes.
        const chamfer = (spread: number, lift: number): number[][] => {
            const corners = [c1, c2, c3, c4].map(p =>
                [cx + (p.x - cx) * spread, cy + lift + (p.y - cy) * spread]);
            const cut = 0.26;
            const ring: number[][] = [];
            for (let i = 0; i < 4; i++) {
                const prev = corners[(i + 3) % 4];
                const curr = corners[i];
                const next = corners[(i + 1) % 4];
                ring.push([curr[0] + (prev[0] - curr[0]) * cut, curr[1] + (prev[1] - curr[1]) * cut]);
                ring.push([curr[0] + (next[0] - curr[0]) * cut, curr[1] + (next[1] - curr[1]) * cut]);
            }
            return ring;
        };
        poly(g, chamfer(0.86, 1), 0x18220f, alpha * 0.16);
        poly(g, chamfer(0.62, 1), 0x18220f, alpha * 0.15);

        // Compact foundry apron — a chamfered work ring just proud of the walls.
        poly(g, chamfer(0.70, 2.2), PAD_EDGE[li], alpha);
        poly(g, chamfer(0.70, 0), PAD_TOP[li], alpha);
        if (level >= 9) strokePoly(g, chamfer(0.70, 0), 1.2, GOLD, alpha * 0.8);
        // Grease stains near the gate (static).
        g.fillStyle(0x2a241c, alpha * 0.12);
        const st1 = at(-0.28, -0.30);
        g.fillEllipse(st1[0], st1[1], 10, 4.5);

        // Muster strip (shared sibling DNA): ONE compact tread strip from the
        // gate toward the SW plot edge — the troops' exit runway. Warm,
        // level-materialed (planks → cobble → iron plate → sandstone), crisp
        // edges, grass showing on both sides.
        const swMidG = [(b3[0] + b4[0]) / 2, (b3[1] + b4[1]) / 2];
        const edgeMid = [(c3.x + c4.x) / 2, (c3.y + c4.y) / 2];
        let nx = edgeMid[0] - cx, ny2 = edgeMid[1] - cy;
        const nl = Math.hypot(nx, ny2) || 1; nx /= nl; ny2 /= nl;
        let ux0 = b3[0] - b4[0], uy0 = b3[1] - b4[1];
        const ul = Math.hypot(ux0, uy0) || 1; ux0 /= ul; uy0 /= ul;
        const MUST_TOP = li < 2 ? 0x7d6440 : li < 5 ? 0x847d6a : li < 8 ? 0x6e6a60 : 0xa89a78;
        const MUST_SEAM = li < 2 ? 0x5f4b2e : li < 5 ? 0x645e4e : li < 8 ? 0x524e46 : 0x8a7d5e;
        const stripHalf = 7.2, d0 = 2.2, d1 = 15.5;
        const strip = (w: number, a0: number, a1: number): number[][] => [
            [swMidG[0] - ux0 * w + nx * a0, swMidG[1] - uy0 * w + ny2 * a0],
            [swMidG[0] + ux0 * w + nx * a0, swMidG[1] + uy0 * w + ny2 * a0],
            [swMidG[0] + ux0 * (w - 1.1) + nx * a1, swMidG[1] + uy0 * (w - 1.1) + ny2 * a1],
            [swMidG[0] - ux0 * (w - 1.1) + nx * a1, swMidG[1] - uy0 * (w - 1.1) + ny2 * a1],
        ];
        poly(g, strip(stripHalf, d0, d1), MUST_SEAM, alpha * 0.95);
        poly(g, strip(stripHalf - 1, d0 + 1, d1 - 1), MUST_TOP, alpha * 0.95);
        // Tread seams across the strip.
        for (const dd of [6.6, 11]) {
            const wSeam = stripHalf - 1.4;
            poly(g, [
                [swMidG[0] - ux0 * wSeam + nx * dd, swMidG[1] - uy0 * wSeam + ny2 * dd],
                [swMidG[0] + ux0 * wSeam + nx * dd, swMidG[1] + uy0 * wSeam + ny2 * dd],
                [swMidG[0] + ux0 * wSeam + nx * (dd + 1), swMidG[1] + uy0 * wSeam + ny2 * (dd + 1)],
                [swMidG[0] - ux0 * wSeam + nx * (dd + 1), swMidG[1] - uy0 * wSeam + ny2 * (dd + 1)],
            ], MUST_SEAM, alpha * 0.8);
        }
    }
    if (onlyBase) return;

    // ---- ambient drivers ------------------------------------------------
    const beatIdx = Math.floor(time / BEAT);
    const u = (time % BEAT) / BEAT;
    const snapT = u < 0.7 ? 0 : (u - 0.7) / 0.3;
    const snap = 1 - (1 - snapT) * (1 - snapT) * (1 - snapT); // easeOutCubic
    const gearTheta = (beatIdx + snap) * (TAU / 12);
    const bob = 1.1 + 1.1 * Math.cos(TAU * time / BEAT);
    const flicker = 0.58 + 0.20 * Math.cos(TAU * time / BEAT) + 0.12 * Math.sin(TAU * time / 500 + 1.9);

    const wallLit = WALL_LIT[li], wallDark = WALL_DARK[li], seam = SEAM[li];
    const trim = TRIM_METAL[li], rivet = RIVET[li];

    // ---- MAIN BLOCK faces ----------------------------------------------
    poly(graphics, [b2, b3, up(b3, H1), up(b2, H1)], wallDark, alpha); // SE (dark)
    poly(graphics, [b3, b4, up(b4, H1), up(b3, H1)], wallLit, alpha);  // SW (lit)

    // Plate seams + rivet courses.
    const swMid = [(b3[0] + b4[0]) / 2, (b3[1] + b4[1]) / 2];
    const skSW = (b3[1] - b4[1]) / (b3[0] - b4[0]);
    const dp = (ox: number, h: number): number[] => [swMid[0] + ox, swMid[1] + ox * skSW - h];
    const seMid = [(b2[0] + b3[0]) / 2, (b2[1] + b3[1]) / 2];
    const skSE = (b2[1] - b3[1]) / (b2[0] - b3[0]);
    const sp = (ox: number, h: number): number[] => [seMid[0] + ox, seMid[1] + ox * skSE - h];
    const halfFace = (b3[0] - b4[0]) / 2;

    // ONE horizontal plate seam per face + one vertical on the SE (the gate
    // owns the SW face) — redundant seam courses were cut in the refinement.
    graphics.lineStyle(1, seam, alpha * 0.5);
    {
        const a2 = sp(-halfFace * 0.5, 1), bb = sp(-halfFace * 0.5, H1 - 2);
        graphics.lineBetween(a2[0], a2[1], bb[0], bb[1]);
    }
    const hSeam = H1 * 0.54;
    const s1 = dp(-halfFace + 1.5, hSeam), s2e = dp(halfFace - 1.5, hSeam);
    graphics.lineBetween(s1[0], s1[1], s2e[0], s2e[1]);
    const s3 = sp(-halfFace + 1.5, hSeam), s4 = sp(halfFace - 1.5, hSeam);
    graphics.lineBetween(s3[0], s3[1], s4[0], s4[1]);
    if (level >= 2) {
        graphics.fillStyle(rivet, alpha * 0.9);
        for (let ox = -halfFace + 4.5; ox <= halfFace - 4.5; ox += 9) {
            const p = dp(ox, hSeam + 1.4);
            graphics.fillCircle(p[0], p[1], 0.9);
            const q = sp(ox, hSeam + 1.4);
            graphics.fillCircle(q[0], q[1], 0.9);
        }
    }
    // Front corner edge.
    graphics.lineStyle(1.2, seam, alpha * 0.6);
    graphics.lineBetween(b3[0], b3[1], b3[0], b3[1] - H1);

    // ---- SE face dressing: furnace grate (the night 'fire' anchor), ----
    // porthole, copper pipework.
    // Furnace sits ~ center + (24, 8) so the DayNight barracks lamp (ox +24,
    // oy +10) lands on drawn fire.
    const fOx = halfFace * 0.2; // toward b2 from face mid -> t = 0.4 of face
    const furnace = (ox: number, h: number): number[] => sp(fOx + ox, h);
    poly(graphics, [furnace(-4.6, 0), furnace(4.6, 0), furnace(4.6, 6.2), furnace(3, 8), furnace(-3, 8), furnace(-4.6, 6.2)], 0x2c2620, alpha);
    poly(graphics, [furnace(-3.4, 0.6), furnace(3.4, 0.6), furnace(3.4, 5.4), furnace(2.2, 6.6), furnace(-2.2, 6.6), furnace(-3.4, 5.4)], GLOW_FURNACE, alpha * flicker);
    graphics.fillStyle(0xfff0b0, alpha * (flicker - 0.25) * 0.8);
    const emb = furnace(0, 1.6);
    graphics.fillEllipse(emb[0], emb[1], 3.4, 2);
    graphics.lineStyle(1.3, 0x1c1712, alpha);
    for (const ox of [-1.9, 0, 1.9]) {
        const a2 = furnace(ox, 0.4), bb = furnace(ox, 6.6);
        graphics.lineBetween(a2[0], a2[1], bb[0], bb[1]);
    }
    if (level >= 9) strokePoly(graphics, [furnace(-4.6, 0), furnace(4.6, 0), furnace(4.6, 6.2), furnace(3, 8), furnace(-3, 8), furnace(-4.6, 6.2)], 1, GOLD, alpha * 0.7);
    // Soot streak above the grate.
    graphics.fillStyle(0x1c1712, alpha * 0.18);
    const soot = furnace(0, 10);
    graphics.fillEllipse(soot[0], soot[1], 6, 3);

    if (level >= 3) {
        // Porthole, upper right of the SE face.
        const pOx = halfFace * 0.56, pH = H1 * 0.66, rP = 3.3;
        const useLen = Math.hypot(1, skSE);
        const pux = 1 / useLen, puy = skSE / useLen;
        const pc = sp(pOx, pH);
        const port = (r: number): number[][] => {
            const pts: number[][] = [];
            for (let i = 0; i < 14; i++) {
                const a2 = (i / 14) * TAU;
                pts.push([pc[0] + pux * r * Math.cos(a2), pc[1] + puy * r * Math.cos(a2) - r * Math.sin(a2)]);
            }
            return pts;
        };
        poly(graphics, port(rP), level >= 9 ? GOLD : trim, alpha);
        poly(graphics, port(rP - 1.2), GLOW_WINDOW, alpha * (0.5 + 0.18 * Math.sin(TAU * time / PERIOD + 0.8)));
    }
    if (level >= 5) {
        // ONE straight copper riser: furnace top -> under the cornice
        // (the elbowed run + valve handwheel read as clutter — cut).
        graphics.lineStyle(2.2, 0xb87333, alpha);
        const e0 = furnace(3.6, 8), e1 = furnace(3.6, H1 - 2);
        graphics.lineBetween(e0[0], e0[1], e1[0], e1[1]);
        graphics.fillStyle(0x8a5a28, alpha);
        const fl = furnace(3.6, H1 * 0.5);
        graphics.fillCircle(fl[0], fl[1], 1.5);
    }

    // ---- THE MUSTER GATE (SW face): huge chain-driven rolling door ------
    const doorHalf = halfFace * 0.56;
    const doorH = H1 * 0.62;
    const drumR = 3.1 + sz * 0.08 + open * 1.2;
    const hDrum = doorH + drumR + 0.5;

    // Casing recess.
    poly(graphics, [dp(-doorHalf - 3, -0.4), dp(doorHalf + 3, -0.4), dp(doorHalf + 3, hDrum + drumR + 2.5), dp(-doorHalf - 3, hDrum + drumR + 2.5)], CASING[li], alpha);
    // Interior (revealed as the shutter rises).
    poly(graphics, [dp(-doorHalf + 0.8, 0), dp(doorHalf - 0.8, 0), dp(doorHalf - 0.8, doorH - 1), dp(-doorHalf + 0.8, doorH - 1)], 0x120e0a, alpha);
    if (open > 0.02) {
        // Low fire-light wash across the interior floor (a tall ellipse here
        // read as a brown dome — keep the light flat and near the ground).
        const gm = dp(0, 1.6);
        graphics.fillStyle(GLOW_INTERIOR, alpha * 0.36 * open);
        graphics.fillEllipse(gm[0], gm[1], doorHalf * 1.7, doorH * 0.26);
        graphics.fillStyle(GLOW_FURNACE, alpha * 0.24 * open * flicker);
        graphics.fillEllipse(gm[0], gm[1], doorHalf * 1.05, doorH * 0.16);
        // Warm spill onto the muster plates (2:1 ground ellipse).
        const spill = dp(0, -2);
        graphics.fillStyle(0xd8a648, alpha * 0.16 * open);
        graphics.fillEllipse(spill[0] - 2.5, spill[1] + 3.5, 19 * open, 8.5 * open);
    }
    // Rolling shutter: bottom edge rises monotonically with doorOpen.
    const hB = open * 0.9 * (doorH - 2);
    if (doorH - 1 - hB > 0.6) {
        poly(graphics, [dp(-doorHalf + 0.6, hB), dp(doorHalf - 0.6, hB), dp(doorHalf - 0.6, doorH - 1), dp(-doorHalf + 0.6, doorH - 1)], SHUT_LIT[li], alpha);
        graphics.lineStyle(1, SHUT_DARK[li], alpha * 0.9);
        for (let hh = hB + 2.8; hh < doorH - 1.4; hh += 3.6) {
            const a2 = dp(-doorHalf + 0.9, hh), bb = dp(doorHalf - 0.9, hh);
            graphics.lineBetween(a2[0], a2[1], bb[0], bb[1]);
        }
        // Reinforced bottom rail.
        poly(graphics, [dp(-doorHalf + 0.6, hB), dp(doorHalf - 0.6, hB), dp(doorHalf - 0.6, hB + 1.6), dp(-doorHalf + 0.6, hB + 1.6)], CASING[li], alpha);
    }
    // Bold guide rails flanking the shutter (the toothed racks + hoist-chain
    // dashes were cut — the drive chain and sprocket carry the mechanism read).
    graphics.lineStyle(2, trim, alpha);
    for (const sgn of [-1, 1]) {
        const rx = sgn * (doorHalf + 1.7);
        const a2 = dp(rx, 0), bb = dp(rx, doorH + 1);
        graphics.lineBetween(a2[0], a2[1], bb[0], bb[1]);
    }
    // The take-up drum, its end caps and the center sprocket.
    const d0 = dp(-doorHalf - 1.2, hDrum), d1 = dp(doorHalf + 1.2, hDrum);
    graphics.lineStyle(drumR * 2, SHUT_DARK[li], alpha);
    graphics.lineBetween(d0[0], d0[1], d1[0], d1[1]);
    graphics.lineStyle(1.1, level >= 9 ? GOLD : trim, alpha * 0.9);
    const dTop0 = dp(-doorHalf - 1.2, hDrum + drumR - 0.8), dTop1 = dp(doorHalf + 1.2, hDrum + drumR - 0.8);
    graphics.lineBetween(dTop0[0], dTop0[1], dTop1[0], dTop1[1]);
    graphics.fillStyle(CASING[li], alpha);
    graphics.fillEllipse(d0[0], d0[1], 3.4, drumR * 2 + 1);
    graphics.fillEllipse(d1[0], d1[1], 3.4, drumR * 2 + 1);
    const sprk = dp(0, hDrum);
    graphics.fillStyle(0x2e2a24, alpha);
    graphics.fillCircle(sprk[0], sprk[1], drumR * 0.85);
    graphics.fillStyle(trim, alpha);
    for (let i = 0; i < 6; i++) {
        const a2 = TAU * i / 6 + gearTheta; // spins with the drive
        graphics.fillCircle(sprk[0] + Math.cos(a2) * drumR * 0.62, sprk[1] + Math.sin(a2) * drumR * 0.62 * 0.9, 0.75);
    }
    // Door lamps — pulse on the training beat.
    for (const sgn of [-1, 1]) {
        const lampP = dp(sgn * (doorHalf + 3.6), doorH * 0.86);
        graphics.fillStyle(0x2a2a2a, alpha);
        graphics.fillRect(lampP[0] - 1.3, lampP[1] - 2, 2.6, 3.4);
        graphics.fillStyle(0xffc36a, alpha * (0.45 + 0.3 * flicker));
        graphics.fillRect(lampP[0] - 0.8, lampP[1] - 1.4, 1.6, 2.2);
    }

    // ---- CORNICE + LEDGE ------------------------------------------------
    const co = S1 * 1.05;
    const cb2 = lp(c2, co), cb3 = lp(c3, co), cb4 = lp(c4, co), cb1 = lp(c1, co);
    poly(graphics, [up(cb2, H1), up(cb3, H1), up(cb3, H1 + CT), up(cb2, H1 + CT)], DECK_SIDE[li], alpha);
    poly(graphics, [up(cb3, H1), up(cb4, H1), up(cb4, H1 + CT), up(cb3, H1 + CT)], DECK_TOP[li], alpha);
    graphics.lineStyle(1, 0x151310, alpha * 0.35);
    graphics.lineBetween(cb4[0], cb4[1] - H1, cb3[0], cb3[1] - H1);
    graphics.lineBetween(cb3[0], cb3[1] - H1, cb2[0], cb2[1] - H1);
    if (level >= 9) {
        graphics.lineStyle(1.3, GOLD, alpha * 0.9);
        graphics.lineBetween(cb4[0], cb4[1] - H1 - CT, cb3[0], cb3[1] - H1 - CT);
        graphics.lineBetween(cb3[0], cb3[1] - H1 - CT, cb2[0], cb2[1] - H1 - CT);
    }
    // Ledge: the main block's top surface the tier stands on.
    poly(graphics, [up(cb1, H1 + CT), up(cb2, H1 + CT), up(cb3, H1 + CT), up(cb4, H1 + CT)], DECK_TOP[li], alpha * 0.98);

    // ---- UPPER TIER -----------------------------------------------------
    const tierBase = H1 + CT;
    poly(graphics, [up(t2, tierBase), up(t3, tierBase), up(t3, H2), up(t2, H2)], wallDark, alpha);
    poly(graphics, [up(t3, tierBase), up(t4, tierBase), up(t4, H2), up(t3, H2)], wallLit, alpha);
    graphics.lineStyle(1.2, seam, alpha * 0.5);
    graphics.lineBetween(t3[0], t3[1] - tierBase, t3[0], t3[1] - H2);

    // Tier SE slit windows (L2+) — forge light breathing.
    if (level >= 2) {
        const tseMid = [(t2[0] + t3[0]) / 2, (t2[1] + t3[1]) / 2];
        const tsp = (ox: number, h: number): number[] => [tseMid[0] + ox, tseMid[1] + ox * skSE - tierBase - h];
        let wi = 0;
        for (const ox of [-4.5, 3.5]) {
            poly(graphics, [tsp(ox - 1.5, 2.5), tsp(ox + 1.5, 2.5), tsp(ox + 1.5, TH - 3.5), tsp(ox - 1.5, TH - 3.5)], CASING[li], alpha);
            poly(graphics, [tsp(ox - 0.9, 3.1), tsp(ox + 0.9, 3.1), tsp(ox + 0.9, TH - 4.1), tsp(ox - 0.9, TH - 4.1)], GLOW_WINDOW,
                alpha * (0.5 + 0.2 * Math.sin(TAU * time / PERIOD + wi * 2.1)));
            wi++;
        }
    }

    // ---- DECK + PARAPET -------------------------------------------------
    poly(graphics, [up(t1, H2), up(t2, H2), up(t3, H2), up(t4, H2)], DECK_TOP[li], alpha);
    graphics.lineStyle(1, DECK_SIDE[li], alpha * 0.8);
    graphics.lineBetween(t4[0], t4[1] - H2, t3[0], t3[1] - H2);
    graphics.lineBetween(t3[0], t3[1] - H2, t2[0], t2[1] - H2);
    const parH = 2.6;
    poly(graphics, [up(t4, H2), up(t3, H2), up(t3, H2 + parH), up(t4, H2 + parH)], DECK_SIDE[li], alpha);
    poly(graphics, [up(t3, H2), up(t2, H2), up(t2, H2 + parH), up(t3, H2 + parH)], DECK_SIDE[li], alpha * 0.88);
    graphics.lineStyle(1, DECK_TOP[li], alpha * 0.9);
    graphics.lineBetween(t4[0], t4[1] - H2 - parH, t3[0], t3[1] - H2 - parH);
    graphics.lineBetween(t3[0], t3[1] - H2 - parH, t2[0], t2[1] - H2 - parH);
    if (level >= 8) {
        // Crenellated merlons (Mastery); gold caps at L9.
        for (const [ea, eb] of [[t4, t3], [t3, t2]] as const) {
            for (const tt of [0.14, 0.38, 0.62, 0.86]) {
                const mx = ea[0] + (eb[0] - ea[0]) * tt, my = ea[1] + (eb[1] - ea[1]) * tt;
                poly(graphics, [[mx - 1.8, my - H2 - parH], [mx + 1.8, my - H2 - parH], [mx + 1.8, my - H2 - parH - 2.4], [mx - 1.8, my - H2 - parH - 2.4]], DECK_SIDE[li], alpha);
                if (level >= 9) {
                    graphics.fillStyle(GOLD, alpha);
                    graphics.fillRect(mx - 1.4, my - H2 - parH - 3.1, 2.8, 0.9);
                }
            }
        }
    }

    // ---- THE SIGNATURE GEAR (training pulse) ---------------------------
    const tswMid = [(t3[0] + t4[0]) / 2, (t3[1] + t4[1]) / 2];
    const Mx = tswMid[0], My = tswMid[1] - tierBase - TH * 0.52;
    let gux = b3[0] - b4[0], guy = b3[1] - b4[1];
    const gul = Math.hypot(gux, guy) || 1; gux /= gul; guy /= gul;
    const rG = 8.2 + sz * 0.35;
    const gp = (a2: number, r: number): number[] =>
        [Mx + gux * r * Math.cos(a2), My + guy * r * Math.cos(a2) - r * Math.sin(a2)];
    const planeCircle = (r: number, n: number): number[][] => {
        const pts: number[][] = [];
        for (let i = 0; i < n; i++) pts.push(gp((i / n) * TAU, r));
        return pts;
    };
    // Recess socket + housing ring (the "half-embedded" read).
    poly(graphics, planeCircle(rG + 3.4, 22), 0x1f1a14, alpha * 0.92);
    strokePoly(graphics, planeCircle(rG + 3.0, 22), 1.8, level >= 9 ? GOLD : trim, alpha * 0.85);
    // Gear disc.
    const gearBody = level >= 9 ? 0xc9a24e : 0xb08048;
    const toothCol = level >= 9 ? GOLD : 0xcf9c58;
    poly(graphics, planeCircle(rG, 24), gearBody, alpha);
    strokePoly(graphics, planeCircle(rG - 0.6, 24), 1, 0x7d5a30, alpha * 0.7);
    // Teeth (12) — they carry the ratchet snap.
    for (let i = 0; i < 12; i++) {
        const a2 = gearTheta + (i / 12) * TAU;
        poly(graphics, [gp(a2 - 0.10, rG - 0.3), gp(a2 - 0.055, rG + 2.7), gp(a2 + 0.055, rG + 2.7), gp(a2 + 0.10, rG - 0.3)], toothCol, alpha);
    }
    // Spokes (6) — 6-fold symmetry closes the loop at exactly 2 beats.
    graphics.lineStyle(1.9, 0x7d5a30, alpha);
    for (let i = 0; i < 6; i++) {
        const a2 = gearTheta + (i / 6) * TAU + TAU / 24;
        const p0 = gp(a2, 2.3), p1 = gp(a2, rG - 1.1);
        graphics.lineBetween(p0[0], p0[1], p1[0], p1[1]);
    }
    // Hub.
    graphics.fillStyle(0x6a4b28, alpha);
    const hub = gp(0, 0);
    graphics.fillCircle(hub[0], hub[1], 2.6);
    graphics.fillStyle(level >= 9 ? GOLD_HI : 0xcf9c58, alpha);
    graphics.fillCircle(hub[0], hub[1], 1.1);
    // Top-left glint arc on the rim.
    graphics.lineStyle(1.1, 0xe8c88a, alpha * 0.7);
    graphics.beginPath();
    const glintPts: number[][] = [];
    for (let i = 0; i <= 6; i++) glintPts.push(gp(Math.PI * 0.55 + (i / 6) * Math.PI * 0.35, rG - 0.4));
    graphics.moveTo(glintPts[0][0], glintPts[0][1]);
    for (let i = 1; i < glintPts.length; i++) graphics.lineTo(glintPts[i][0], glintPts[i][1]);
    graphics.strokePath();

    // Companion pinion gear (L4+), meshed, counter-rotating.
    if (level >= 4) {
        const rS = rG * 0.62;
        const D = rG + rS + 1.6;
        const M2x = Mx + gux * D * 0.878, M2y = My + guy * D * 0.878 + D * 0.479;
        const thS = -(beatIdx + snap) * (TAU / 8) + TAU / 16;
        const gp2 = (a2: number, r: number): number[] =>
            [M2x + gux * r * Math.cos(a2), M2y + guy * r * Math.cos(a2) - r * Math.sin(a2)];
        const circ2 = (r: number, n: number): number[][] => {
            const pts: number[][] = [];
            for (let i = 0; i < n; i++) pts.push(gp2((i / n) * TAU, r));
            return pts;
        };
        poly(graphics, circ2(rS + 2.4, 18), 0x1f1a14, alpha * 0.9);
        poly(graphics, circ2(rS, 18), gearBody, alpha);
        for (let i = 0; i < 8; i++) {
            const a2 = thS + (i / 8) * TAU;
            poly(graphics, [gp2(a2 - 0.13, rS - 0.3), gp2(a2 - 0.07, rS + 2.2), gp2(a2 + 0.07, rS + 2.2), gp2(a2 + 0.13, rS - 0.3)], toothCol, alpha);
        }
        graphics.fillStyle(0x6a4b28, alpha);
        for (let i = 0; i < 4; i++) {
            const a2 = thS + (i / 4) * TAU + TAU / 8;
            const hole = gp2(a2, rS * 0.5);
            graphics.fillCircle(hole[0], hole[1], 1.0);
        }
        graphics.fillCircle(M2x, M2y, 1.6);
    }

    // Drive chains: gear -> door drum, dash pitch = exactly one tooth-arc so
    // the crawl maps onto itself every beat.
    const chasePitch = (TAU / 12) * rG;
    const travel = gearTheta * rG;
    const chainTopH = tierBase + TH * 0.52 - rG - 2.5;
    const chainBotH = hDrum + drumR + 1;
    if (chainTopH > chainBotH + 2) {
        poly(graphics, [dp(-3.1, chainBotH), dp(3.1, chainBotH), dp(3.1, chainTopH), dp(-3.1, chainTopH)], 0x241f18, alpha * 0.85);
        // ONE bold centered chain (the twin run read as noise).
        graphics.lineStyle(2.2, 0x9a8a6a, alpha * 0.9);
        const off = (travel % chasePitch + chasePitch) % chasePitch;
        for (let hh = chainBotH - off; hh < chainTopH; hh += chasePitch) {
            const h0 = Math.max(hh, chainBotH), h1 = Math.min(hh + chasePitch * 0.52, chainTopH);
            if (h1 > h0) {
                const p0 = dp(0, h0), p1 = dp(0, h1);
                graphics.lineBetween(p0[0], p0[1], p1[0], p1[1]);
            }
        }
    }

    // ---- DECK MACHINERY -------------------------------------------------
    // Boiler (L3+): upright riveted drum, rear-right of the deck.
    if (level >= 3) {
        const q = at(0.15, 0.16, H2);
        const rB = 5.2, bh = 11;
        graphics.fillStyle(0x241f18, alpha * 0.5);
        graphics.fillEllipse(q[0], q[1] + 0.8, rB * 2.2, rB * 0.95);
        graphics.fillStyle(BOILER[li], alpha);
        graphics.fillRect(q[0] - rB, q[1] - bh, rB * 2, bh);
        graphics.fillStyle(0x241f18, alpha * 0.25);
        graphics.fillRect(q[0] + rB * 0.25, q[1] - bh, rB * 0.75, bh);
        graphics.fillStyle(BOILER[li], alpha);
        graphics.fillEllipse(q[0], q[1] - bh, rB * 2, rB * 0.9);
        graphics.fillStyle(0xffffff, alpha * 0.10);
        graphics.fillEllipse(q[0] - rB * 0.3, q[1] - bh, rB * 0.9, rB * 0.4);
        // ONE bold band (gauge/rivets/second band were deck clutter — cut).
        graphics.lineStyle(1.1, level >= 9 ? GOLD : trim, alpha * 0.9);
        graphics.lineBetween(q[0] - rB, q[1] - bh * 0.5, q[0] + rB, q[1] - bh * 0.5);
        if (level >= 8) {
            // Steam dome (finish richness inside the L5 silhouette).
            graphics.fillStyle(BOILER[li], alpha);
            graphics.fillEllipse(q[0], q[1] - bh - 2.2, rB * 1.1, rB * 0.8);
            graphics.lineStyle(1, level >= 9 ? GOLD : trim, alpha);
            graphics.strokeEllipse(q[0], q[1] - bh - 2.2, rB * 1.1, rB * 0.8);
        }
    }

    // Chimney stack — the ONE piston chimney (the L6+ twin stack was bulk).
    const chim = at(-0.10, 0.24, H2);
    const stackH = 14 + sz * 0.6;
    const drawStack = (px: number, py: number, r: number, hgt: number): void => {
        graphics.fillStyle(0x241f18, alpha * 0.5);
        graphics.fillEllipse(px, py + 0.6, r * 2.6, r * 1.1);
        graphics.fillStyle(STACK[li], alpha);
        graphics.fillRect(px - r, py - hgt, r * 2, hgt);
        graphics.fillStyle(0x000000, alpha * 0.22);
        graphics.fillRect(px + r * 0.3, py - hgt, r * 0.7, hgt);
        graphics.lineStyle(1.1, level >= 9 ? GOLD : trim, alpha);
        graphics.lineBetween(px - r - 0.4, py - hgt + 1.6, px + r + 0.4, py - hgt + 1.6);
        graphics.fillStyle(0x1c1814, alpha);
        graphics.fillEllipse(px, py - hgt, r * 2, r * 0.9);
    };
    drawStack(chim[0], chim[1], 3.1, stackH);

    // Piston head beside the stack (L2+) — the steam-driver of the pulse.
    if (level >= 2) {
        const pB = at(0.02, 0.30, H2);
        graphics.fillStyle(CASING[li], alpha);
        graphics.fillRect(pB[0] - 2.6, pB[1] - 3.6, 5.2, 3.6);
        graphics.lineStyle(1.8, 0x8a8e96, alpha);
        graphics.lineBetween(pB[0], pB[1] - 3.4, pB[0], pB[1] - 6.6 - bob);
        graphics.fillStyle(level >= 9 ? GOLD : trim, alpha);
        graphics.fillCircle(pB[0], pB[1] - 7 - bob, 1.7);
    }

    // Gantry crane arm (L7+): post + jib + swaying crate — rigging detail
    // (tie-back cable, hub, crate strap) was cut in the refinement.
    if (level >= 7) {
        const post = at(0.30, 0.0, H2);
        const topY = post[1] - 9;
        graphics.lineStyle(2.4, CASING[li], alpha);
        graphics.lineBetween(post[0], post[1], post[0], topY);
        const tipX = post[0] + 13, tipY = topY - 4;
        graphics.lineStyle(2, CASING[li], alpha);
        graphics.lineBetween(post[0], topY, tipX, tipY);
        const sway = 1.8 * Math.sin(TAU * time / PERIOD + 0.7);
        const hookX = tipX + sway, hookY = tipY + 11;
        graphics.lineStyle(1, 0x2e2a24, alpha);
        graphics.lineBetween(tipX, tipY, hookX, hookY);
        // Hoisted munitions crate.
        graphics.fillStyle(0x6b4e2e, alpha);
        graphics.fillRect(hookX - 3, hookY, 6, 4.6);
        graphics.fillStyle(0x54391f, alpha);
        graphics.fillRect(hookX - 3, hookY, 6, 1.4);
    }

    // Deterministic chimney steam — RUNTIME ONLY (vapor is never body art).
    if (BuildingRenderer.AMBIENT_VAPOR) {
        for (let k = 0; k < 3; k++) {
            const ph = ((time + k * (PERIOD / 3)) % PERIOD) / PERIOD;
            const size = (2.6 + 5.5 * ph) * (k === 1 ? 0.72 : 1);
            const rise = ph * 16 + 2;
            const drift = ph * 2.6 * (k === 1 ? -1 : 1);
            graphics.fillStyle(0xd8d8d4, alpha * 0.38 * (1 - ph));
            graphics.fillEllipse(chim[0] + drift, chim[1] - stackH - rise, size * 1.5, size);
        }
    }

    // ---- PENNANT (banner mount: parapet front corner) -------------------
    const poleX = t3[0], poleBaseY = t3[1] - H2 - parH, poleTopY = poleBaseY - 12;
    graphics.lineStyle(1.4, 0x3a332a, alpha);
    graphics.lineBetween(poleX, poleBaseY, poleX, poleTopY);
    graphics.fillStyle(level >= 9 ? GOLD_HI : trim, alpha);
    graphics.fillCircle(poleX, poleTopY - 0.8, 1.2);
    const w0 = windLoopAtScreen(poleX, poleTopY, time, PERIOD);
    const w1 = windLoopAtScreen(poleX + 8, poleTopY, time, PERIOD);
    const clothCol = level >= 9 ? CREAM : 0xb66b32;
    const tipX2 = poleX + 10.5 + w1 * 2.2, tipY2 = poleTopY + 2.2 + (w1 - 0.5) * 3.2;
    const midY = poleTopY + 1.2 + (w0 - 0.5) * 1.8;
    poly(graphics, [
        [poleX, poleTopY + 0.4],
        [poleX + 5.5, midY],
        [tipX2, tipY2],
        [poleX + 6.5, midY + 2.6],
        [poleX, poleTopY + 4.6],
    ], clothCol, alpha);
    if (level >= 9) {
        graphics.lineStyle(1, GOLD, alpha);
        graphics.lineBetween(poleX, poleTopY + 4.6, poleX + 6.5, midY + 2.6);
        graphics.fillStyle(GOLD, alpha);
        graphics.fillCircle(poleX + 3.6, poleTopY + 2.4, 1.1);
    } else {
        graphics.fillStyle(0x3a332a, alpha * 0.8);
        graphics.fillCircle(poleX + 3.6, poleTopY + 2.4, 1.0);
    }

    // ---- Yard prop (L2+): ONE munitions crate by the gate (drum cut) ----
    if (level >= 2) {
        const cr = at(0.28, -0.55);
        graphics.fillStyle(0x6b4e2e, alpha);
        graphics.fillRect(cr[0] - 3.4, cr[1] - 4.6, 6.8, 4.6);
        graphics.fillStyle(0x82603b, alpha);
        graphics.fillRect(cr[0] - 3.4, cr[1] - 4.6, 6.8, 1.5);
        graphics.lineStyle(0.9, 0x54391f, alpha);
        graphics.lineBetween(cr[0] - 3.4, cr[1] - 2.3, cr[0] + 3.4, cr[1] - 2.3);
    }
}
