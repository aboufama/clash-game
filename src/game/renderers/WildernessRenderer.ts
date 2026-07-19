import Phaser from 'phaser';
import { IsoUtils } from '../utils/IsoUtils';
import { hashString, mulberry32 } from '../config/Economy';
import {
    fbmNoise2D,
    generateLakeTerrain,
    type LakeTerrain,
    type TerrainPoint
} from './WildernessTerrain';
import {
    normalizeWorldNatureSeedVersion,
    wildernessEcologyPresentationSeed,
    wildernessPlotPresentationSeed
} from './WorldNatureSeed';
// Design-tournament coupling. Value imports are only CALLED at
// draw/revision time, never during module evaluation, so the
// WildernessRenderer <-> DesignRegistry <-> design-file cycle is safe (the
// registry's exports are hoisted function declarations).
import { activeSlot, listVariantUnits } from './redesign/DesignRegistry';
// Canonical Stormbreak Wood: tournament winner A, called directly.
import { deadwoodDesignA } from './redesign/DeadwoodA';

/**
 * The unclaimed wilds: every empty plot is a PLACE — a lake, a crag field,
 * a pine stand, a ring of ancient stones — generated from its coordinates
 * so every traveller sees the same country. Twelve archetypes, each with
 * seeded counts/positions/sizes/mixins: the combinations run into the
 * hundreds. Sized to read at POSTCARD zoom — these are landscapes, not
 * lawn ornaments.
 *
 * Drawn into postcard RenderTextures exactly like village snapshots
 * (static, painter-sorted far-to-near), on top of the plot's seeded grass.
 */

const TILES = 25;

interface Ctx {
    g: Phaser.GameObjects.Graphics;
    offX: number;
    offY: number;
    seed: number;
    plotX: number;
    plotY: number;
    rng: () => number;
    waters: LakeTerrain[];
    streams: WildernessStream[];
    avoid: Array<(x: number, y: number) => boolean>;
    life: WildernessLifeAnchor[];
}

function at(ctx: Ctx, tx: number, ty: number): { x: number; y: number } {
    return IsoUtils.cartToIso(ctx.offX + tx, ctx.offY + ty);
}

function featureRng(ctx: Ctx, tag: string): () => number {
    return mulberry32(hashString(`wild-feature:${ctx.seed}:${tag}`));
}

function fillPolygon(
    g: Phaser.GameObjects.Graphics,
    points: Array<{ x: number; y: number }>,
    color: number,
    alpha = 1
) {
    if (points.length < 3) return;
    g.fillStyle(color, alpha);
    g.beginPath();
    g.moveTo(points[0].x, points[0].y);
    for (let i = 1; i < points.length; i++) g.lineTo(points[i].x, points[i].y);
    g.closePath();
    g.fillPath();
}

function strokePolygon(
    g: Phaser.GameObjects.Graphics,
    points: Array<{ x: number; y: number }>,
    width: number,
    color: number,
    alpha = 1
) {
    if (points.length < 3) return;
    g.lineStyle(width, color, alpha);
    g.beginPath();
    g.moveTo(points[0].x, points[0].y);
    for (let i = 1; i < points.length; i++) g.lineTo(points[i].x, points[i].y);
    g.closePath();
    g.strokePath();
}

/** Broad, low-frequency ground color — duff, moss, scree, or wet earth.
 * The shape is generated in grid space and only then projected isometrically. */
function groundPatch(ctx: Ctx, tx: number, ty: number, rx: number, ry: number, color: number, alpha: number, tag: string) {
    const rng = featureRng(ctx, `ground:${tag}`);
    const phase2 = rng() * Math.PI * 2;
    const phase3 = rng() * Math.PI * 2;
    const phase5 = rng() * Math.PI * 2;
    const points: Array<{ x: number; y: number }> = [];
    const count = 22;
    for (let i = 0; i < count; i++) {
        const a = (i / count) * Math.PI * 2;
        const wobble = 1
            + Math.sin(a * 2 + phase2) * 0.17
            + Math.sin(a * 3 + phase3) * 0.11
            + Math.sin(a * 5 + phase5) * 0.065;
        points.push(at(ctx, tx + Math.cos(a) * rx * wobble, ty + Math.sin(a) * ry * wobble));
    }
    fillPolygon(ctx.g, points, color, alpha);
}

/** A small tuft of tall grass — the village-lawn language carried into the
 * wilds. A fan of leaning blades in two greens, an occasional seed head. */
function grassTuft(ctx: Ctx, tx: number, ty: number, s: number) {
    const p = at(ctx, tx, ty);
    const g = ctx.g;
    const rng = featureRng(ctx, `tuft:${tx.toFixed(2)}:${ty.toFixed(2)}`);
    // Postcards rasterize at 0.25-0.5 scale: blades must be drawn heavy
    // enough to survive the downsample, or the wilds read as bare lawn.
    const blades = 3 + Math.floor(rng() * 3);
    for (let i = 0; i < blades; i++) {
        const offset = (i - (blades - 1) / 2) * 2.1 * s;
        const height = (6 + rng() * 4.5) * s;
        const lean = (rng() - 0.5) * 3.6 * s + offset * 0.45;
        g.lineStyle(Math.max(1.6, 2.4 * s), i % 2 ? 0x466f36 : 0x578544, 0.95);
        g.lineBetween(p.x + offset, p.y + 0.5, p.x + offset + lean, p.y - height);
    }
    if (rng() < 0.28) {
        g.fillStyle(0x8fae62, 0.9);
        g.fillEllipse(p.x + (rng() - 0.5) * 3 * s, p.y - (7 + rng() * 2) * s, 2.2 * s, 3.2 * s);
    }
}

// ---- element vocabulary (each draws at one anchor, painter-safe) ----

function conifer(ctx: Ctx, tx: number, ty: number, s: number) {
    const p = at(ctx, tx, ty);
    const g = ctx.g;
    const rng = featureRng(ctx, `pine:${tx.toFixed(2)}:${ty.toFixed(2)}`);
    const palettes = [
        [0x173f2d, 0x23553a, 0x347049, 0x4a8457],
        [0x203f25, 0x2c5730, 0x3d6d39, 0x58844b],
        [0x193b36, 0x255247, 0x376c58, 0x4b8066]
    ];
    const tones = palettes[Math.floor(rng() * palettes.length)];
    g.fillStyle(0x172215, 0.2);
    g.fillEllipse(p.x + 5 * s, p.y + 4 * s, 32 * s, 10 * s);

    // Tapered trunk and two visible roots: these keep large pines grounded.
    fillPolygon(g, [
        { x: p.x - 3.4 * s, y: p.y + 1.5 * s },
        { x: p.x - 1.9 * s, y: p.y - 27 * s },
        { x: p.x + 2.2 * s, y: p.y - 27 * s },
        { x: p.x + 4.2 * s, y: p.y + 1.5 * s }
    ], 0x573820);
    g.lineStyle(1.2 * s, 0x7a5230, 0.7);
    g.lineBetween(p.x - 1.2 * s, p.y - 25 * s, p.x - 1.8 * s, p.y - 1 * s);
    g.lineBetween(p.x - 1.5 * s, p.y, p.x - 8 * s, p.y + 3 * s);
    g.lineBetween(p.x + 1.5 * s, p.y, p.x + 8 * s, p.y + 2.2 * s);

    // Four asymmetric branch shelves. Splitting each crown into lit NW and
    // shaded SE faces gives a tree mass, not a stack of flat triangles.
    const tiers = [
        { y: -10, w: 36, h: 20 },
        { y: -22, w: 31, h: 21 },
        { y: -35, w: 24, h: 21 },
        { y: -48, w: 15, h: 19 }
    ];
    for (let i = 0; i < tiers.length; i++) {
        const tier = tiers[i];
        const lean = (rng() - 0.5) * 2.8 * s;
        const baseY = p.y + tier.y * s;
        const apexX = p.x + lean;
        const apexY = baseY - tier.h * s;
        const leftX = p.x - tier.w * 0.56 * s;
        const rightX = p.x + tier.w * 0.5 * s;
        g.fillStyle(tones[Math.min(i, tones.length - 1)], 1);
        g.fillTriangle(leftX, baseY, rightX, baseY + 1.4 * s, apexX, apexY);
        g.fillStyle(0x0f2e24, 0.22);
        g.fillTriangle(apexX, apexY, rightX, baseY + 1.4 * s, p.x + 1.5 * s, baseY - 2 * s);
        g.fillStyle(0x82a86f, 0.16);
        g.fillTriangle(leftX + 3 * s, baseY - 1 * s, apexX, apexY + 2 * s, p.x - 1 * s, baseY - 3 * s);
    }
}

function broadleaf(ctx: Ctx, tx: number, ty: number, s: number) {
    const p = at(ctx, tx, ty);
    const g = ctx.g;
    const rng = featureRng(ctx, `oak:${tx.toFixed(2)}:${ty.toFixed(2)}`);
    const palettes = [
        [0x28552f, 0x376c38, 0x4b8247, 0x66955a],
        [0x315027, 0x456632, 0x5c7d3d, 0x799352],
        [0x24533d, 0x336b4a, 0x48815a, 0x63966c]
    ];
    const tones = palettes[Math.floor(rng() * palettes.length)];
    g.fillStyle(0x172215, 0.2);
    g.fillEllipse(p.x + 6 * s, p.y + 5 * s, 39 * s, 13 * s);

    // Wide, root-flared trunk with visible branching under the crown.
    fillPolygon(g, [
        { x: p.x - 6 * s, y: p.y + 2 * s },
        { x: p.x - 2.8 * s, y: p.y - 27 * s },
        { x: p.x + 2.8 * s, y: p.y - 27 * s },
        { x: p.x + 6.5 * s, y: p.y + 2 * s }
    ], 0x624127);
    g.lineStyle(2.2 * s, 0x624127, 1);
    g.lineBetween(p.x - 1.5 * s, p.y - 20 * s, p.x - 11 * s, p.y - 34 * s);
    g.lineBetween(p.x + 1.5 * s, p.y - 18 * s, p.x + 12 * s, p.y - 31 * s);
    g.lineStyle(1.2 * s, 0x8a6038, 0.65);
    g.lineBetween(p.x - 1.5 * s, p.y - 24 * s, p.x - 3.5 * s, p.y - 1 * s);

    // One dark silhouette first; clustered crowns then carve age and species
    // variation into it without turning the canopy into one perfect circle.
    const lobes = [
        [-15, -27, 16, 12], [-5, -37, 19, 14], [8, -39, 18, 14],
        [17, -27, 16, 12], [4, -24, 22, 15], [-12, -18, 15, 10]
    ];
    g.fillStyle(tones[0], 1);
    for (const [ox, oy, w, h] of lobes) {
        g.fillEllipse(p.x + (ox + (rng() - 0.5) * 3) * s, p.y + oy * s, w * s, h * s);
    }
    g.fillStyle(tones[2], 0.95);
    g.fillEllipse(p.x - 8 * s, p.y - 39 * s, 20 * s, 13 * s);
    g.fillEllipse(p.x + 5 * s, p.y - 43 * s, 17 * s, 11 * s);
    g.fillStyle(tones[3], 0.72);
    g.fillEllipse(p.x - 13 * s, p.y - 42 * s, 9 * s, 6 * s);
    g.fillEllipse(p.x + 1 * s, p.y - 47 * s, 8 * s, 5 * s);
}

function ancientTree(ctx: Ctx, tx: number, ty: number, s: number, tag: string) {
    broadleaf(ctx, tx, ty, s);
    const p = at(ctx, tx, ty);
    const g = ctx.g;
    // Old roots buckle visibly over the lawn and a small hollow gives this
    // one tree a story readable from the map overview.
    g.lineStyle(4 * s, 0x5b3a23, 1);
    g.lineBetween(p.x - 2 * s, p.y - 1 * s, p.x - 15 * s, p.y + 6 * s);
    g.lineBetween(p.x + 2 * s, p.y - 1 * s, p.x + 16 * s, p.y + 5 * s);
    g.lineStyle(1.5 * s, 0x89603a, 0.75);
    g.lineBetween(p.x - 2 * s, p.y - 4 * s, p.x - 13 * s, p.y + 4 * s);
    g.fillStyle(0x241a13, 0.9);
    g.fillEllipse(p.x + 1.5 * s, p.y - 10 * s, 5 * s, 8 * s);
    const rng = featureRng(ctx, `ancient:${tag}`);
    if (rng() < 0.65) {
        g.fillStyle(0x8f9b63, 0.8);
        g.fillEllipse(p.x - 5 * s, p.y - 16 * s, 8 * s, 3 * s);
    }
}

function deadSnag(ctx: Ctx, tx: number, ty: number, s: number) {
    const p = at(ctx, tx, ty);
    const g = ctx.g;
    g.fillStyle(0x000000, 0.12);
    g.fillEllipse(p.x, p.y + 2, 14 * s, 5 * s);
    g.lineStyle(3.2 * s, 0x6b5a48, 1);
    g.lineBetween(p.x, p.y, p.x, p.y - 24 * s);
    g.lineStyle(2 * s, 0x6b5a48, 1);
    g.lineBetween(p.x, p.y - 13 * s, p.x + 9 * s, p.y - 20 * s);
    g.lineBetween(p.x, p.y - 18 * s, p.x - 7 * s, p.y - 25 * s);
    g.lineStyle(1.2 * s, 0x5c4a3a, 1);
    g.lineBetween(p.x + 9 * s, p.y - 20 * s, p.x + 12 * s, p.y - 25 * s);
}

function boulder(ctx: Ctx, tx: number, ty: number, s: number) {
    const p = at(ctx, tx, ty);
    const g = ctx.g;
    const rng = featureRng(ctx, `boulder:${tx.toFixed(2)}:${ty.toFixed(2)}`);
    const w = (15 + rng() * 4) * s;
    const h = (17 + rng() * 7) * s;
    const peakX = p.x - (2 + rng() * 5) * s;
    const peakY = p.y - h;
    const shoulderY = p.y - h * (0.52 + rng() * 0.1);
    g.fillStyle(0x172015, 0.2);
    g.fillEllipse(p.x + 4 * s, p.y + 4 * s, w * 2.25, 11 * s);
    const left = { x: p.x - w, y: p.y - 1 * s };
    const right = { x: p.x + w * 0.92, y: p.y };
    const bottom = { x: p.x + 3 * s, y: p.y + 4 * s };
    const crownL = { x: p.x - w * 0.62, y: shoulderY };
    const crownR = { x: p.x + w * 0.55, y: shoulderY + 3 * s };
    fillPolygon(g, [left, crownL, { x: peakX, y: peakY }, crownR, right, bottom], 0x60676b);
    fillPolygon(g, [left, crownL, { x: peakX, y: peakY }, { x: p.x - 1 * s, y: p.y - 2 * s }, bottom], 0x858d8b);
    fillPolygon(g, [crownL, { x: peakX, y: peakY }, crownR, { x: p.x - 1 * s, y: p.y - 2 * s }], 0xabb2ad);
    fillPolygon(g, [{ x: peakX, y: peakY }, crownR, right, bottom, { x: p.x - 1 * s, y: p.y - 2 * s }], 0x4d565b);
    g.lineStyle(Math.max(1, 1.2 * s), 0x3f484b, 0.7);
    g.lineBetween(peakX + 2 * s, peakY + 5 * s, p.x + 3 * s, p.y - 6 * s);
    if (rng() < 0.72) {
        g.fillStyle(0x4f6b3c, 0.82);
        g.fillEllipse(p.x - w * 0.45, p.y - 1.5 * s, w * 0.72, 5 * s);
        g.fillStyle(0x71804e, 0.65);
        g.fillEllipse(p.x - w * 0.55, p.y - 3 * s, w * 0.34, 2.4 * s);
    }
}

/** A terrain-scale rock landmark: bold enough to survive mobile map zoom. */
function cragOutcrop(ctx: Ctx, tx: number, ty: number, s: number, tag: string) {
    const rng = featureRng(ctx, `crag:${tag}`);
    const p = at(ctx, tx, ty);
    const g = ctx.g;
    const w = 30 * s;
    const h = (31 + rng() * 12) * s;
    const peakA = { x: p.x - (9 + rng() * 5) * s, y: p.y - h };
    const peakB = { x: p.x + (8 + rng() * 5) * s, y: p.y - h * (0.68 + rng() * 0.12) };
    const notch = { x: p.x - 1 * s, y: p.y - h * (0.46 + rng() * 0.08) };
    const left = { x: p.x - w, y: p.y - 1 * s };
    const right = { x: p.x + w * 0.9, y: p.y + 1 * s };
    const foot = { x: p.x + 3 * s, y: p.y + 10 * s };
    const saddleL = { x: p.x - 19 * s, y: p.y - h * 0.52 };
    const saddleR = { x: p.x + 17 * s, y: p.y - h * 0.46 };
    const core = { x: p.x - 2 * s, y: p.y + 1 * s };
    g.fillStyle(0x152015, 0.24);
    g.fillEllipse(p.x + 8 * s, p.y + 10 * s, w * 2.35, 24 * s);
    fillPolygon(g, [left, saddleL, peakA, notch, peakB, saddleR, right, foot], 0x525b5e);
    fillPolygon(g, [left, saddleL, peakA, notch, core, foot], 0x7e8782);
    fillPolygon(g, [saddleL, peakA, notch, core], 0xadb2a8);
    fillPolygon(g, [notch, peakB, saddleR, core], 0x8f9690);
    fillPolygon(g, [peakB, saddleR, right, foot, core], 0x414b51);
    // A lower fractured apron breaks the mountain/crystal symmetry.
    fillPolygon(g, [
        { x: p.x - 27 * s, y: p.y - 2 * s },
        { x: p.x - 17 * s, y: p.y - 14 * s },
        { x: p.x - 7 * s, y: p.y - 5 * s },
        { x: p.x - 10 * s, y: p.y + 5 * s }
    ], 0x68716f);
    // Broad strata and a split make the formation geological, not a giant pebble.
    g.lineStyle(Math.max(1.8, 2.1 * s), 0x424b4d, 0.68);
    g.lineBetween(p.x - 20 * s, p.y - h * 0.34, p.x + 14 * s, p.y - h * 0.27);
    g.lineBetween(peakA.x + 4 * s, peakA.y + 9 * s, p.x - 1 * s, p.y - 8 * s);
    g.lineBetween(peakB.x - 2 * s, peakB.y + 7 * s, p.x + 7 * s, p.y - 3 * s);
    g.lineStyle(Math.max(1.2, 1.35 * s), 0xc4c8bc, 0.38);
    g.lineBetween(p.x - 17 * s, p.y - h * 0.51, peakA.x - 1 * s, peakA.y + 4 * s);
    g.fillStyle(0x4d683c, 0.88);
    g.fillEllipse(p.x - 16 * s, p.y - 1 * s, 28 * s, 8 * s);
    g.fillEllipse(p.x + 10 * s, p.y + 3 * s, 18 * s, 6 * s);
}

function fallenLog(ctx: Ctx, tx: number, ty: number, s: number, tag: string) {
    const rng = featureRng(ctx, `log:${tag}`);
    const p = at(ctx, tx, ty);
    const g = ctx.g;
    const dir = rng() < 0.5 ? 1 : -1;
    const dx = 21 * s * dir;
    const dy = 8 * s;
    g.fillStyle(0x172015, 0.18);
    g.fillEllipse(p.x + dx * 0.1, p.y + 4 * s, 46 * s, 10 * s);
    g.lineStyle(8 * s, 0x54361f, 1);
    g.lineBetween(p.x - dx, p.y - dy, p.x + dx, p.y + dy);
    g.lineStyle(3 * s, 0x815634, 0.9);
    g.lineBetween(p.x - dx * 0.9, p.y - dy - 1.5 * s, p.x + dx * 0.85, p.y + dy - 1.5 * s);
    g.fillStyle(0xb28a5d, 1);
    g.fillEllipse(p.x + dx, p.y + dy, 9 * s, 6 * s);
    g.lineStyle(1.2 * s, 0x6c4b2f, 0.8);
    g.strokeEllipse(p.x + dx, p.y + dy, 5 * s, 3 * s);
    g.fillStyle(0x54703e, 0.9);
    g.fillEllipse(p.x - dx * 0.15, p.y - 1 * s, 18 * s, 5 * s);
}

function stoneMonolith(ctx: Ctx, tx: number, ty: number, s: number, tall: number) {
    const p = at(ctx, tx, ty);
    const g = ctx.g;
    const rng = featureRng(ctx, `monolith:${tx.toFixed(2)}:${ty.toFixed(2)}`);
    const h = (34 + tall * 24) * s;
    const w = (8.5 + rng() * 3.2) * s;
    const lean = (rng() - 0.5) * 8 * s;
    const tip = { x: p.x + lean - w * 0.18, y: p.y - h };
    const left = { x: p.x - w, y: p.y };
    const right = { x: p.x + w * 0.84, y: p.y + 1.5 * s };
    const shoulderL = { x: p.x + lean - w * 0.74, y: p.y - h * 0.72 };
    const shoulderR = { x: p.x + lean + w * 0.58, y: p.y - h * 0.67 };
    const foot = { x: p.x + 1.8 * s, y: p.y + 4 * s };

    g.fillStyle(0x172015, 0.21);
    g.fillEllipse(p.x + 4 * s, p.y + 4 * s, w * 2.7, 10 * s);
    fillPolygon(g, [left, shoulderL, tip, shoulderR, right, foot], 0x5c6464);
    fillPolygon(g, [left, shoulderL, tip, { x: p.x + lean - 1 * s, y: p.y - h * 0.16 }, foot], 0x929a92);
    fillPolygon(g, [tip, shoulderR, right, foot, { x: p.x + lean - 1 * s, y: p.y - h * 0.16 }], 0x495256);
    fillPolygon(g, [shoulderL, tip, shoulderR, { x: p.x + lean - 1 * s, y: p.y - h * 0.16 }], 0xaeb3a7);
    g.lineStyle(Math.max(1.2, 1.35 * s), 0x3e4748, 0.72);
    g.lineBetween(tip.x + 1.5 * s, tip.y + 6 * s, p.x + lean + 1 * s, p.y - h * 0.28);
    g.lineBetween(p.x + lean - w * 0.45, p.y - h * 0.55, p.x + lean - w * 0.12, p.y - h * 0.45);
    g.fillStyle(0x536d43, 0.88);
    g.fillEllipse(p.x - w * 0.38, p.y - 1.5 * s, w * 0.95, 5.5 * s);
    if (rng() < 0.72) {
        g.fillStyle(0x718151, 0.72);
        g.fillEllipse(p.x + lean - w * 0.36, p.y - h * 0.64, w * 0.56, 4 * s);
    }
}

/** A collapsed-age trilithon gives the stone circle one landmark silhouette. */
function stoneGate(ctx: Ctx, tx: number, ty: number, s: number, tag: string) {
    const p = at(ctx, tx, ty);
    const g = ctx.g;
    const rng = featureRng(ctx, `stone-gate:${tag}`);
    const hL = (62 + rng() * 8) * s;
    const hR = (55 + rng() * 8) * s;
    const halfGap = 24 * s;
    const upright = (cx: number, baseY: number, h: number, lean: number) => {
        const w = 11 * s;
        const topX = cx + lean;
        const core = { x: cx + lean * 0.35, y: baseY - h * 0.12 };
        const outline = [
            { x: cx - w, y: baseY },
            { x: topX - w * 0.7, y: baseY - h },
            { x: topX + w * 0.55, y: baseY - h - 2 * s },
            { x: cx + w * 0.85, y: baseY + 2 * s },
            { x: cx + 1.5 * s, y: baseY + 5 * s }
        ];
        fillPolygon(g, outline, 0x596162);
        fillPolygon(g, [outline[0], outline[1], core, outline[4]], 0x90988f);
        fillPolygon(g, [outline[1], outline[2], outline[3], outline[4], core], 0x465055);
        g.lineStyle(1.5 * s, 0x394345, 0.68);
        g.lineBetween(topX + 1 * s, baseY - h + 7 * s, cx + 2 * s, baseY - 8 * s);
    };

    g.fillStyle(0x172015, 0.23);
    g.fillEllipse(p.x + 7 * s, p.y + 7 * s, 88 * s, 22 * s);
    upright(p.x - halfGap, p.y, hL, -3.5 * s);
    upright(p.x + halfGap, p.y + 3 * s, hR, 2.5 * s);
    const capY = p.y - Math.min(hL, hR) - 2 * s;
    const cap = [
        { x: p.x - 43 * s, y: capY + 2 * s },
        { x: p.x - 32 * s, y: capY - 13 * s },
        { x: p.x + 38 * s, y: capY - 9 * s },
        { x: p.x + 45 * s, y: capY + 4 * s },
        { x: p.x + 31 * s, y: capY + 13 * s },
        { x: p.x - 35 * s, y: capY + 10 * s }
    ];
    fillPolygon(g, cap, 0x68706f);
    fillPolygon(g, [cap[0], cap[1], cap[2], cap[3], { x: p.x + 18 * s, y: capY + 3 * s }], 0xa4aaa0);
    fillPolygon(g, [cap[3], cap[4], cap[5], cap[0], { x: p.x + 18 * s, y: capY + 3 * s }], 0x4c5659);
    g.fillStyle(0x566f43, 0.9);
    g.fillEllipse(p.x - 15 * s, capY - 7 * s, 30 * s, 7 * s);
}

function stoneAltar(ctx: Ctx, tx: number, ty: number, s: number) {
    const p = at(ctx, tx, ty);
    const g = ctx.g;
    g.fillStyle(0x172015, 0.19);
    g.fillEllipse(p.x + 4 * s, p.y + 7 * s, 62 * s, 20 * s);
    const top = [
        { x: p.x, y: p.y - 15 * s },
        { x: p.x + 34 * s, y: p.y - 1 * s },
        { x: p.x, y: p.y + 14 * s },
        { x: p.x - 34 * s, y: p.y }
    ];
    fillPolygon(g, [top[1], top[2], { x: top[2].x, y: top[2].y + 7 * s }, { x: top[1].x, y: top[1].y + 7 * s }], 0x51595a);
    fillPolygon(g, [top[2], top[3], { x: top[3].x, y: top[3].y + 7 * s }, { x: top[2].x, y: top[2].y + 7 * s }], 0x737b76);
    fillPolygon(g, top, 0x9da298);
    g.lineStyle(1.2 * s, 0x59615d, 0.75);
    g.lineBetween(p.x - 12 * s, p.y - 4 * s, p.x + 10 * s, p.y + 4 * s);
    g.fillStyle(0x526b42, 0.82);
    g.fillEllipse(p.x - 17 * s, p.y + 2 * s, 20 * s, 5 * s);
}

/** One interlocked bramble colony, not a scatter of lawn-sized bushes. */
function brambleMass(ctx: Ctx, tx: number, ty: number, s: number, tag: string) {
    const p = at(ctx, tx, ty);
    const g = ctx.g;
    const rng = featureRng(ctx, `bramble:${tag}`);
    g.fillStyle(0x142318, 0.2);
    g.fillEllipse(p.x + 5 * s, p.y + 6 * s, 58 * s, 18 * s);
    const lobes = [
        [-20, -6, 28, 17], [-8, -15, 31, 22], [8, -17, 34, 24],
        [22, -7, 27, 18], [4, -4, 40, 20], [-23, 3, 24, 13]
    ];
    g.fillStyle(0x23472d, 1);
    for (const [ox, oy, w, h] of lobes) {
        g.fillEllipse(p.x + (ox + (rng() - 0.5) * 3) * s, p.y + oy * s, w * s, h * s);
    }
    g.fillStyle(0x3c6a3c, 0.96);
    g.fillEllipse(p.x - 8 * s, p.y - 18 * s, 28 * s, 13 * s);
    g.fillEllipse(p.x + 13 * s, p.y - 13 * s, 25 * s, 12 * s);
    g.fillStyle(0x64824b, 0.7);
    g.fillEllipse(p.x - 13 * s, p.y - 21 * s, 12 * s, 6 * s);
    g.lineStyle(Math.max(1, 1.25 * s), 0x60452c, 0.86);
    g.lineBetween(p.x - 25 * s, p.y - 2 * s, p.x + 21 * s, p.y - 18 * s);
    g.lineBetween(p.x - 14 * s, p.y - 20 * s, p.x + 26 * s, p.y - 3 * s);
    g.fillStyle(0x9f3650, 1);
    for (let i = 0; i < 7; i++) {
        const ox = -18 + rng() * 36;
        const oy = -20 + rng() * 13;
        g.fillCircle(p.x + ox * s, p.y + oy * s, Math.max(1.5, 1.8 * s));
    }
}

// (The deadwood archetype's former exclusive hero elements were removed with
// its composition for the clean-room redesign round — see the stubbed
// 'deadwood' entry in ARCHETYPES. Revert path: git HEAD.)

/**
 * A real flooded terrain depression. `generateLakeTerrain` synthesizes a
 * multi-lobed noisy DEM, finds its lowest spill level with Priority-Flood,
 * and returns connected depth contours. Geometry is authored in grid space
 * then projected once, so coves and peninsulas obey the isometric ground.
 */
function pool(
    ctx: Ctx,
    tx: number,
    ty: number,
    rx: number,
    ry: number,
    dress = true,
    featureTag?: string
): LakeTerrain {
    const g = ctx.g;
    const tag = featureTag ?? `${tx.toFixed(2)}:${ty.toFixed(2)}:${rx.toFixed(2)}:${ry.toFixed(2)}`;
    let lake: LakeTerrain | null = null;
    let lastError: unknown = null;
    // A rare DEM can find a spill saddle too close to its center. Retry with
    // two deterministic child seeds; never substitute an ellipse.
    for (let attempt = 0; attempt < 3 && !lake; attempt++) {
        try {
            lake = generateLakeTerrain({
                seed: hashString(`lake:${ctx.seed}:${tag}:${attempt}`),
                centerX: tx,
                centerY: ty,
                radiusX: rx,
                radiusY: ry,
                bounds: { minX: 1.35, minY: 1.35, maxX: TILES - 1.35, maxY: TILES - 1.35 },
                sampleStep: Math.min(rx, ry) < 2.7 ? 0.28 : 0.35,
                lobeCount: Math.min(rx, ry) < 2.7 ? 4 : 6,
                bankWidth: Math.min(0.5, Math.max(0.34, Math.min(rx, ry) * 0.07)),
                smoothingPasses: 1
            });
        } catch (error) {
            lastError = error;
        }
    }
    if (!lake) throw lastError instanceof Error ? lastError : new Error('Procedural lake basin failed');
    ctx.waters.push(lake);
    ctx.avoid.push((x, y) => lake!.contains(x, y));

    const project = (points: readonly TerrainPoint[]) => points.map(point => at(ctx, point.x, point.y));
    const bank = project(lake.contours.bank);
    const water = project(lake.contours.water);
    const mid = project(lake.contours.mid);
    const deep = project(lake.contours.deep);

    // Bathymetry comes from fill depth, not scaled copies of one oval.
    fillPolygon(g, bank, 0x5c684d, 0.93);      // damp soil / mossed shelf
    fillPolygon(g, water, 0x3a7c8c, 1);        // mineral shallows
    fillPolygon(g, mid, 0x2d6b81, 0.98);       // open water
    fillPolygon(g, deep, 0x22566d, 0.94);      // drowned basin
    strokePolygon(g, water, 1.2, 0x203f51, 0.46);
    // Broken NW shoreline sheen instead of a luminous outline around the
    // entire basin. Light catches only the shore facing the sky.
    const waterCenter = at(ctx, tx, ty);
    for (let i = 0; i < water.length; i += 3) {
        const a = water[i];
        const b = water[(i + 1) % water.length];
        if ((a.y + b.y) * 0.5 > waterCenter.y + 5) continue;
        g.lineStyle(1.7, 0x91c5c5, 0.46);
        g.lineBetween(a.x, a.y, b.x, b.y);
    }

    if (!dress) return lake;
    const rng = featureRng(ctx, `lake-dress:${tag}`);
    const randomWaterPoint = (minDepth: number, maxDepth = 1): TerrainPoint | null => {
        for (let attempt = 0; attempt < 72; attempt++) {
            const x = lake!.bounds.minX + rng() * (lake!.bounds.maxX - lake!.bounds.minX);
            const y = lake!.bounds.minY + rng() * (lake!.bounds.maxY - lake!.bounds.minY);
            const depth = lake!.sampleDepth(x, y);
            if (depth >= minDepth && depth <= maxDepth) return { x, y };
        }
        return null;
    };

    // Wind-aligned sky streaks: a few bold reflection masses survive the
    // postcard downsample; dozens of tiny white flecks would read as noise.
    const reflections = Math.max(7, Math.round((rx + ry) * 0.72));
    for (let i = 0; i < reflections; i++) {
        const point = randomWaterPoint(0.25);
        if (!point) continue;
        const p = at(ctx, point.x, point.y);
        const width = 5 + rng() * 12;
        g.lineStyle(i % 4 === 0 ? 2.4 : 1.5, i % 4 === 0 ? 0xd7eef0 : 0x93c9cf, 0.42 + rng() * 0.34);
        g.lineBetween(p.x - width * 0.62, p.y, p.x + width * 0.38, p.y);
    }

    if (rx > 5.5 && ry > 4.5 && rng() < 0.7) {
        const island = randomWaterPoint(0.42, 0.78);
        if (island) {
            groundPatch(ctx, island.x, island.y, 1.05 + rng() * 0.45, 0.8 + rng() * 0.3, 0x647052, 1, `lake-islet:${tag}`);
            boulder(ctx, island.x, island.y, 0.42 + rng() * 0.22);
        }
    }

    const fishCount = Math.max(3, Math.round((rx + ry) * 0.38));
    for (let i = 0; i < fishCount; i++) {
        const point = randomWaterPoint(0.22, 0.74);
        if (!point) continue;
        const p = at(ctx, point.x, point.y);
        // rng() call order is the plot's determinism contract — angle/length
        // are consumed even for the anchored fish that no longer bake.
        const angle = rng() * Math.PI * 2;
        const length = 4 + rng() * 3.5;
        if (i < 3) {
            // The first three fish are LIFE: the postcard life layer swims
            // them (WorldFigureRenderer.drawFish). Baking their silhouette
            // too left a frozen ghost under every animated fish.
            ctx.life.push({
                kind: 'fish',
                gx: ctx.offX + point.x,
                gy: ctx.offY + point.y,
                phase: rng() * Math.PI * 2,
                scale: 0.8 + rng() * 0.6
            });
            continue;
        }
        const vx = Math.cos(angle) * length;
        const vy = Math.sin(angle) * length * 0.48;
        const nx = -Math.sin(angle) * 1.8;
        const ny = Math.cos(angle) * 0.9;
        fillPolygon(g, [
            { x: p.x + vx, y: p.y + vy },
            { x: p.x + nx, y: p.y + ny },
            { x: p.x - vx * 0.7, y: p.y - vy * 0.7 },
            { x: p.x - nx, y: p.y - ny }
        ], 0x173d4a, 0.52);
        fillPolygon(g, [
            { x: p.x - vx * 0.68, y: p.y - vy * 0.68 },
            { x: p.x - vx - nx * 1.6, y: p.y - vy - ny * 1.6 },
            { x: p.x - vx + nx * 1.6, y: p.y - vy + ny * 1.6 }
        ], 0x214b56, 0.5);
    }

    if (rx > 5 && rng() < 0.7) {
        const duck = randomWaterPoint(0.14, 0.52);
        if (duck) {
            const p = at(ctx, duck.x, duck.y);
            g.lineStyle(1.1, 0xc4e1df, 0.42);
            g.lineBetween(p.x - 13, p.y - 1, p.x - 5, p.y);
            g.lineBetween(p.x - 12, p.y + 2, p.x - 4, p.y + 1);
            g.fillStyle(0x6d5132, 1);
            g.fillEllipse(p.x, p.y, 10, 5.5);
            g.fillStyle(0x2f5a43, 1);
            g.fillCircle(p.x + 4, p.y - 3.5, 2.6);
            g.fillStyle(0xd49a3a, 1);
            g.fillTriangle(p.x + 6, p.y - 3.5, p.x + 9, p.y - 2.4, p.x + 6, p.y - 1.9);
        }
    }

    // A handful of calm rings, lily pads, and submerged stones communicate
    // scale without turning the lake into a decorated plate.
    for (let i = 0; i < 3 + Math.floor(rng() * 3); i++) {
        const point = randomWaterPoint(0.16, 0.52);
        if (!point) continue;
        const p = at(ctx, point.x, point.y);
        g.lineStyle(1.1, 0xb8dfe0, 0.38);
        g.strokeEllipse(p.x, p.y, 8 + rng() * 9, 3 + rng() * 3.5);
    }
    for (let i = 0; i < 3 + Math.floor(rng() * 5); i++) {
        const point = randomWaterPoint(0.08, 0.4);
        if (!point) continue;
        const p = at(ctx, point.x, point.y);
        const size = 4 + rng() * 4;
        g.fillStyle(rng() < 0.5 ? 0x527d48 : 0x669452, 0.95);
        g.fillEllipse(p.x, p.y, size * 2, size);
        g.lineStyle(1, 0x315d3a, 0.8);
        g.lineBetween(p.x, p.y, p.x + size * 0.85, p.y - size * 0.15);
    }
    for (let i = 0; i < 3; i++) {
        const point = randomWaterPoint(0.025, 0.18);
        if (!point) continue;
        const p = at(ctx, point.x, point.y);
        const size = 4 + rng() * 6;
        g.fillStyle(0x687779, 0.82);
        g.fillEllipse(p.x, p.y, size * 2.2, size);
        g.fillStyle(0xa2aaa2, 0.52);
        g.fillEllipse(p.x - size * 0.3, p.y - size * 0.24, size, size * 0.38);
    }

    // Reeds grow in two sheltered shoreline colonies, never as a uniform
    // picket fence around the entire lake.
    const shore = lake.contours.water;
    const colonies = Math.min(3, 1 + Math.floor((rx + ry) / 6));
    for (let colony = 0; colony < colonies; colony++) {
        const start = Math.floor(rng() * shore.length);
        const stems = 5 + Math.floor(rng() * 5);
        for (let i = 0; i < stems; i++) {
            const point = shore[(start + i * 2) % shore.length];
            const p = at(ctx, point.x + (rng() - 0.5) * 0.2, point.y + (rng() - 0.5) * 0.2);
            const height = 9 + rng() * 11;
            const lean = -1.5 + rng() * 4;
            g.lineStyle(1.7, 0x4f7a42, 1);
            g.lineBetween(p.x, p.y + 1, p.x + lean, p.y - height);
            if (i % 2 === 0) {
                g.fillStyle(0x795739, 1);
                g.fillEllipse(p.x + lean, p.y - height + 1.5, 2.6, 6);
            }
        }
    }

    const frogPoint = randomWaterPoint(0.025, 0.17);
    if (frogPoint) {
        ctx.life.push({
            kind: 'frog',
            gx: ctx.offX + frogPoint.x,
            gy: ctx.offY + frogPoint.y,
            phase: rng() * Math.PI * 2,
            scale: 0.8 + rng() * 0.45
        });
    }

    // Rare driftwood/beaver-work gives some lakes a tiny history.
    if (rng() < 0.44) {
        const point = randomWaterPoint(0.05, 0.24);
        if (point) {
            const p = at(ctx, point.x, point.y);
            const lean = rng() < 0.5 ? -1 : 1;
            g.lineStyle(4.2, 0x5d422c, 1);
            g.lineBetween(p.x - 13 * lean, p.y - 3, p.x + 13 * lean, p.y + 3);
            g.lineStyle(1.2, 0xa07b50, 0.8);
            g.lineBetween(p.x - 11 * lean, p.y - 4, p.x + 9 * lean, p.y + 1.5);
        }
    }
    return lake;
}

function flowerDrift(ctx: Ctx, tx: number, ty: number, count: number) {
    const g = ctx.g;
    const tones = [0xd8748c, 0xe3c14e, 0xe4e4f0, 0xb684c9];
    const tone = tones[Math.floor(ctx.rng() * tones.length)];
    for (let i = 0; i < count; i++) {
        const p = at(ctx, tx + (ctx.rng() - 0.5) * 5, ty + (ctx.rng() - 0.5) * 5);
        g.fillStyle(tone, 0.95);
        g.fillRect(p.x - 1.5, p.y - 3, 3.2, 3.2);
        g.fillStyle(0xe9d75e, 1);
        g.fillRect(p.x - 0.4, p.y - 2, 1.4, 1.4);
        g.lineStyle(1, 0x4d7f42, 0.9);
        g.lineBetween(p.x, p.y, p.x, p.y + 2.4);
    }
}

function bush(ctx: Ctx, tx: number, ty: number, s: number, berries: boolean) {
    const p = at(ctx, tx, ty);
    const g = ctx.g;
    g.fillStyle(0x000000, 0.13);
    g.fillEllipse(p.x, p.y + 2, 18 * s, 6.5 * s);
    g.fillStyle(0x3a6b35, 1);
    g.fillEllipse(p.x, p.y - 4.5 * s, 18 * s, 12 * s);
    g.fillStyle(0x4d7f42, 1);
    g.fillEllipse(p.x - 3 * s, p.y - 6.5 * s, 12 * s, 7.5 * s);
    if (berries) {
        g.fillStyle(0x9c2f4a, 1);
        for (let i = 0; i < 6; i++) {
            g.fillRect(p.x - 6 * s + ctx.rng() * 12 * s, p.y - 9 * s + ctx.rng() * 6 * s, 2.2, 2.2);
        }
    }
}

function stump(ctx: Ctx, tx: number, ty: number) {
    const p = at(ctx, tx, ty);
    const g = ctx.g;
    g.fillStyle(0x000000, 0.11);
    g.fillEllipse(p.x, p.y + 1.5, 13, 5);
    g.fillStyle(0x6b4a30, 1);
    g.fillRect(p.x - 5, p.y - 6, 10, 7);
    g.fillStyle(0xa88a62, 1);
    g.fillEllipse(p.x, p.y - 6, 10, 4.6);
    g.lineStyle(1.2, 0x8a6a42, 0.9);
    g.strokeEllipse(p.x, p.y - 6, 6, 2.6);
}

function scatterRocks(ctx: Ctx, cx: number, cy: number, spread: number, n: number) {
    const g = ctx.g;
    for (let i = 0; i < n; i++) {
        const gx = cx + (ctx.rng() - 0.5) * spread;
        const gy = cy + (ctx.rng() - 0.5) * spread;
        if (ctx.avoid.some(blocked => blocked(gx, gy))) continue;
        const p = at(ctx, gx, gy);
        const s = 3.8 + ctx.rng() * 5.2;
        g.fillStyle(ctx.rng() < 0.5 ? 0x8a8d94 : 0x74777d, 0.95);
        g.fillEllipse(p.x, p.y, s * 2.8, s * 1.35);
        g.fillStyle(0xa7abb3, 0.6);
        g.fillEllipse(p.x - s * 0.55, p.y - s * 0.28, s * 1.25, s * 0.56);
    }
}

/** One continuous meandering ribbon, built in grid space from centerline
 * tangents. No overlapping ellipse/capsule stamps and no dark seams. */
function riverRun(ctx: Ctx, points: Array<{ x: number; y: number }>, rx: number, ry: number) {
    const g = ctx.g;
    const rng = featureRng(ctx, 'river-ribbon');
    const baseWidth = (rx + ry) * 0.52;
    ctx.streams.push({ points: points.map(point => ({ ...point })), halfWidth: baseWidth });
    ctx.avoid.push((x, y) => {
        for (let i = 1; i < points.length; i++) {
            const a = points[i - 1];
            const b = points[i];
            const dx = b.x - a.x;
            const dy = b.y - a.y;
            const t = Math.max(0, Math.min(1, ((x - a.x) * dx + (y - a.y) * dy) / (dx * dx + dy * dy || 1)));
            if (Math.hypot(x - (a.x + dx * t), y - (a.y + dy * t)) <= baseWidth * 1.18) return true;
        }
        return false;
    });
    const ribbon = (scale: number, wobble: number): TerrainPoint[] => {
        const left: TerrainPoint[] = [];
        const right: TerrainPoint[] = [];
        for (let i = 0; i < points.length; i++) {
            const prev = points[Math.max(0, i - 1)];
            const next = points[Math.min(points.length - 1, i + 1)];
            const dx = next.x - prev.x;
            const dy = next.y - prev.y;
            const len = Math.hypot(dx, dy) || 1;
            const widthNoise = 1 + Math.sin(i * 0.72 + ctx.seed * 0.001) * wobble
                + Math.sin(i * 0.29 + ctx.seed * 0.003) * wobble * 0.55;
            const width = baseWidth * scale * widthNoise;
            const nx = -dy / len;
            const ny = dx / len;
            left.push({ x: points[i].x + nx * width, y: points[i].y + ny * width });
            right.push({ x: points[i].x - nx * width, y: points[i].y - ny * width });
        }
        return [...left, ...right.reverse()];
    };
    const bank = ribbon(1.32, 0.12).map(point => at(ctx, point.x, point.y));
    const water = ribbon(1, 0.1).map(point => at(ctx, point.x, point.y));
    const channel = ribbon(0.48, 0.08).map(point => at(ctx, point.x, point.y));
    fillPolygon(g, bank, 0x6d694c, 0.95);
    fillPolygon(g, water, 0x347b8d, 1);
    fillPolygon(g, channel, 0x1e5875, 0.92);
    strokePolygon(g, water, 1.5, 0x91c5c5, 0.38);

    for (let i = 2; i < points.length - 2; i += 3) {
        const c = at(ctx, points[i].x, points[i].y);
        const width = 5 + rng() * 8;
        g.lineStyle(1.4, i % 2 === 0 ? 0xb9dfe2 : 0x7fb7c1, 0.48 + rng() * 0.22);
        g.lineBetween(c.x - width * 0.6, c.y, c.x + width * 0.4, c.y);
    }
}

/** A short, emphatic rapid spanning the brook rather than evenly spaced dots. */
function brookRapids(
    ctx: Ctx,
    points: Array<{ x: number; y: number }>,
    centerIndex: number,
    halfWidth: number,
    tag: string
) {
    const g = ctx.g;
    const rng = featureRng(ctx, `brook-rapids:${tag}`);
    const index = Math.max(3, Math.min(points.length - 4, Math.trunc(centerIndex)));
    // ONE flow direction for the whole rapid, smoothed across its span. The
    // meander's dense samples can hairpin inside those five steps; per-point
    // normals then swivel ~90-120° around the bend apex and the five crest
    // bars smear into a white "starburst" fan radiating over the banks
    // (worst at plot-boundary bends). Rapids read as parallel bars marching
    // downstream, so they share the crossing axis.
    const flowFrom = points[index - 3] ?? points[index - 1];
    const flowTo = points[index + 3] ?? points[index + 1];
    const flowDx = flowTo.x - flowFrom.x;
    const flowDy = flowTo.y - flowFrom.y;
    const flowLen = Math.hypot(flowDx, flowDy) || 1;
    const nx = -flowDy / flowLen;
    const ny = flowDx / flowLen;
    for (let step = -2; step <= 2; step++) {
        const i = index + step;
        const point = points[i];
        // Where the channel turns away from the rapid's shared axis, the bar
        // shrinks with the alignment (and vanishes past ~70°): a full-width
        // crest at a hairpin point would overhang the banks. rng() draws stay
        // unconditional so the sequence (and every seeded look) is stable.
        const ldx = points[i + 1].x - points[i - 1].x;
        const ldy = points[i + 1].y - points[i - 1].y;
        const llen = Math.hypot(ldx, ldy) || 1;
        const align = Math.abs((ldx * flowDx + ldy * flowDy) / (llen * flowLen));
        const width = halfWidth * (0.72 + rng() * 0.26) * align;
        const crestAlpha = 0.7 + rng() * 0.2;
        if (align >= 0.35) {
            const left = at(ctx, point.x + nx * width, point.y + ny * width);
            const right = at(ctx, point.x - nx * width, point.y - ny * width);
            g.lineStyle(step === 0 ? 3.2 : 2.2, 0xd8eff0, crestAlpha);
            g.lineBetween(left.x, left.y, right.x, right.y);
        }
        if (step % 2 === 0) {
            const rock = at(ctx,
                point.x + nx * (rng() - 0.5) * width,
                point.y + ny * (rng() - 0.5) * width);
            const size = 5 + rng() * 4;
            g.fillStyle(0x566363, 0.96);
            g.fillEllipse(rock.x, rock.y + 1, size * 2.2, size);
            g.fillStyle(0xa2aaa2, 0.72);
            g.fillEllipse(rock.x - size * 0.35, rock.y - size * 0.2, size, size * 0.4);
        }
    }
    const crest = at(ctx, points[index].x, points[index].y);
    for (let i = 0; i < 4; i++) {
        const drift = (i - 1.5) * 8;
        g.lineStyle(1.5, 0xb8dcdf, 0.5);
        g.lineBetween(crest.x + drift - 5, crest.y + 5 + i, crest.x + drift + 4, crest.y + 6 + i);
    }
}

function paintSorted(items: Array<{ tx: number; ty: number; draw: () => void }>) {
    items.sort((a, b) => (a.tx + a.ty) - (b.tx + b.ty));
    for (const item of items) item.draw();
}

type Put = (tx: number, ty: number, draw: (tx: number, ty: number) => void) => void;
type Placer = (ctx: Ctx, put: Put) => void;

// Public aliases for the clean-room design-tournament files
// (redesign/<Unit><Slot>.ts) and the DesignRegistry's WildernessDesignFn.
// A design fn receives exactly what an archetype `place` fn receives.
export type { Ctx as WildernessPlotCtx, Put as WildernessPut };

/**
 * The shared element vocabulary, exported for clean-room wilderness design
 * files. These are the same seeded, painter-safe pieces the live archetypes
 * compose (each draws at one anchor; determinism comes from featureRng /
 * ctx.rng — never Math.random). Designers may use them, or draw bespoke art
 * directly on ctx.g with `at(...)` projection; `pool(...)` is the ONLY way to
 * make water (it registers ctx.waters/avoid/life for surface queries).
 */
export const WildernessVocabulary = {
    at,
    featureRng,
    fillPolygon,
    strokePolygon,
    groundPatch,
    grassTuft,
    conifer,
    broadleaf,
    ancientTree,
    deadSnag,
    boulder,
    cragOutcrop,
    fallenLog,
    stoneMonolith,
    stoneGate,
    stoneAltar,
    brambleMass,
    pool,
    flowerDrift,
    bush,
    stump,
    scatterRocks
} as const;

// ---- the twelve archetypes ----

const ARCHETYPES: Array<{ key: string; place: Placer }> = [
    {
        key: 'lake',
        place: (ctx, put) => {
            const rng = featureRng(ctx, 'biome:lake');
            const twin = rng() < 0.34;
            const basins = twin
                ? [
                    { cx: 7 + rng() * 1.5, cy: 7.5 + rng() * 2, rx: 3.6 + rng() * 1.1, ry: 2.8 + rng() * 0.9, tag: 'twin-north' },
                    { cx: 16.5 + rng() * 1.8, cy: 15.5 + rng() * 2, rx: 4.4 + rng() * 1.1, ry: 3.3 + rng() * 1, tag: 'twin-south' }
                ]
                : [{
                    cx: 11.2 + rng() * 2.5,
                    cy: 11.2 + rng() * 2.5,
                    rx: 5.5 + rng() * 3.9,
                    ry: 4.5 + rng() * 3,
                    tag: 'wild-lake'
                }];
            for (const basin of basins) pool(ctx, basin.cx, basin.cy, basin.rx, basin.ry, true, basin.tag);
            const cx = basins.reduce((sum, basin) => sum + basin.cx, 0) / basins.length;
            const cy = basins.reduce((sum, basin) => sum + basin.cy, 0) / basins.length;
            const trees = 10 + Math.floor(rng() * 6);
            for (let i = 0; i < trees; i++) {
                const scale = 1.2 + rng() * 0.8;
                const tree = rng() < 0.32 ? conifer : broadleaf;
                put(2.2 + rng() * 20.6, 2.2 + rng() * 20.6, (tx, ty) => tree(ctx, tx, ty, scale));
            }
            const rocks = 5 + Math.floor(rng() * 4);
            for (let i = 0; i < rocks; i++) {
                const scale = 0.72 + rng() * 0.62;
                put(2.5 + rng() * 20, 2.5 + rng() * 20, (tx, ty) => boulder(ctx, tx, ty, scale));
            }
            scatterRocks(ctx, cx + 7, cy + 6, 7, 7);
            if (rng() < 0.55) {
                const logScale = 0.72 + rng() * 0.25;
                put(4 + rng() * 17, 4 + rng() * 17, (tx, ty) => fallenLog(ctx, tx, ty, logScale, 'lake-drift-bank'));
            }
        }
    },
    {
        key: 'crags',
        place: (ctx, put) => {
            const rng = featureRng(ctx, 'biome:crags');
            groundPatch(ctx, 12.5, 12.5, 10.2, 8.6, 0x73745f, 0.22, 'crag-shelf');
            groundPatch(ctx, 9.5, 15.5, 6.2, 4.8, 0x596343, 0.18, 'crag-moss');

            // Two or three terrain-scale silhouettes replace the old gravel
            // field; smaller talus exists to support them, not compete.
            const heroes = 2 + Math.floor(rng() * 2);
            for (let i = 0; i < heroes; i++) {
                const tx = 6.5 + rng() * 12;
                const ty = 6.5 + rng() * 12;
                const scale = 1.35 + rng() * 0.75;
                put(tx, ty, (ax, ay) => cragOutcrop(ctx, ax, ay, scale, `hero-${i}`));
            }
            const boulders = 5 + Math.floor(rng() * 4);
            for (let i = 0; i < boulders; i++) {
                const scale = 0.85 + rng() * 0.65;
                put(3.5 + rng() * 18, 3.5 + rng() * 18, (tx, ty) => boulder(ctx, tx, ty, scale));
            }
            scatterRocks(ctx, 12.5, 14.5, 17, 12);

            // Wind-pruned trees and scrub colonize cracks: rocky is a biome,
            // not a lifeless quarry.
            const trees = 4 + Math.floor(rng() * 4);
            for (let i = 0; i < trees; i++) {
                const scale = 1.05 + rng() * 0.68;
                const pine = rng() < 0.72;
                put(3 + rng() * 19, 3 + rng() * 19, (tx, ty) => (pine ? conifer : broadleaf)(ctx, tx, ty, scale));
            }
            put(5 + rng() * 15, 5 + rng() * 15, (tx, ty) => deadSnag(ctx, tx, ty, 1.15));
        }
    },
    {
        key: 'pines',
        place: (ctx, put) => {
            const rng = featureRng(ctx, 'biome:pines');
            groundPatch(ctx, 12, 12.5, 10.5, 9.2, 0x384d31, 0.22, 'pine-duff');
            groundPatch(ctx, 17, 8, 4.8, 4.2, 0x6a6246, 0.15, 'pine-needles');
            const n = 22 + Math.floor(rng() * 10);
            for (let i = 0; i < n; i++) {
                const scale = 0.95 + rng() * 0.85;
                put(2.5 + rng() * 20, 2.5 + rng() * 20, (tx, ty) => conifer(ctx, tx, ty, scale));
            }
            // Forest geology stays visible: a hero boulder, companions, and
            // a fallen trunk create depth breaks among the vertical crowns.
            const rockCount = 3 + Math.floor(rng() * 3);
            for (let i = 0; i < rockCount; i++) {
                const scale = i === 0 ? 1.45 + rng() * 0.4 : 0.75 + rng() * 0.55;
                put(4 + rng() * 17, 4 + rng() * 17, (tx, ty) => boulder(ctx, tx, ty, scale));
            }
            const logScale = 0.9 + rng() * 0.35;
            put(5 + rng() * 15, 5 + rng() * 15, (tx, ty) => fallenLog(ctx, tx, ty, logScale, 'pine-fall'));
            if (rng() < 0.65) put(6 + rng() * 12, 6 + rng() * 12, (tx, ty) => stump(ctx, tx, ty));
            scatterRocks(ctx, 6 + rng() * 13, 6 + rng() * 13, 8, 6);
        }
    },
    {
        key: 'grove',
        place: (ctx, put) => {
            const rng = featureRng(ctx, 'biome:grove');
            groundPatch(ctx, 12.5, 12.5, 9.5, 8.2, 0x31533a, 0.2, 'grove-moss');
            groundPatch(ctx, 12.5, 12.5, 5.2, 4.2, 0x70804f, 0.18, 'grove-light');
            const n = 14 + Math.floor(rng() * 6);
            for (let i = 0; i < n; i++) {
                const a = (i / n) * Math.PI * 2 + rng() * 0.7;
                const d = 6.2 + rng() * 4.2;
                const scale = 1.15 + rng() * 0.82;
                put(12.5 + Math.cos(a) * d, 12.5 + Math.sin(a) * d,
                    (tx, ty) => broadleaf(ctx, tx, ty, scale));
            }
            const elderScale = 2 + rng() * 0.42;
            put(8 + rng() * 9, 8 + rng() * 9, (tx, ty) => ancientTree(ctx, tx, ty, elderScale, 'grove-elder'));
            const rocks = 3 + Math.floor(rng() * 3);
            for (let i = 0; i < rocks; i++) {
                const scale = 0.75 + rng() * 0.65;
                put(5 + rng() * 15, 5 + rng() * 15, (tx, ty) => boulder(ctx, tx, ty, scale));
            }
            flowerDrift(ctx, 12.5, 12.5, 18 + Math.floor(rng() * 9));
            if (rng() < 0.55) {
                const logScale = 0.75 + rng() * 0.3;
                put(7 + rng() * 11, 7 + rng() * 11, (tx, ty) => fallenLog(ctx, tx, ty, logScale, 'grove-log'));
            }
        }
    },
    {
        key: 'meadow',
        place: (ctx, put) => {
            const rng = featureRng(ctx, 'biome:meadow');
            groundPatch(ctx, 9, 11, 8, 4.4, 0x6e8b4c, 0.22, 'meadow-sweep-a');
            groundPatch(ctx, 17, 15, 7, 4.6, 0x3f743e, 0.18, 'meadow-sweep-b');
            const drifts = 7 + Math.floor(rng() * 5);
            for (let i = 0; i < drifts; i++) {
                flowerDrift(ctx, 4 + rng() * 17, 4 + rng() * 17, 12 + Math.floor(rng() * 12));
            }
            const bushes = 4 + Math.floor(rng() * 3);
            for (let i = 0; i < bushes; i++) {
                const scale = 0.9 + rng() * 0.55;
                put(4 + rng() * 17, 4 + rng() * 17, (tx, ty) => bush(ctx, tx, ty, scale, false));
            }
            const loneTreeScale = 2.05 + rng() * 0.4;
            put(6 + rng() * 13, 6 + rng() * 13, (tx, ty) => ancientTree(ctx, tx, ty, loneTreeScale, 'meadow-oak'));
            for (let i = 0; i < 2; i++) {
                const scale = 1.05 + rng() * 0.45;
                put(3 + rng() * 19, 3 + rng() * 19, (tx, ty) => broadleaf(ctx, tx, ty, scale));
            }
            const rocks = 2 + Math.floor(rng() * 3);
            for (let i = 0; i < rocks; i++) {
                const scale = 0.7 + rng() * 0.5;
                put(4 + rng() * 17, 4 + rng() * 17, (tx, ty) => boulder(ctx, tx, ty, scale));
            }
            if (rng() < 0.6) {
                const shelfScale = 0.62 + rng() * 0.18;
                put(4 + rng() * 17, 4 + rng() * 17, (tx, ty) => cragOutcrop(ctx, tx, ty, shelfScale, 'meadow-shelf'));
            }
            if (rng() < 0.48) pool(ctx, 7 + rng() * 11, 7 + rng() * 11, 2.8, 2.1);
        }
    },
    {
        key: 'marsh',
        place: (ctx, put) => {
            const rng = featureRng(ctx, 'biome:marsh');
            groundPatch(ctx, 12.5, 12.5, 10.5, 9.5, 0x4c6545, 0.22, 'marsh-wetland');
            groundPatch(ctx, 16, 8, 5.5, 4.2, 0x786f4c, 0.18, 'marsh-silt');
            const basinCenters = [[7.2, 7.4], [17.1, 12.4], [9.4, 18.1]] as const;
            for (let i = 0; i < basinCenters.length; i++) {
                const [bx, by] = basinCenters[i];
                pool(ctx, bx + (rng() - 0.5) * 1.4, by + (rng() - 0.5) * 1.4,
                    2.6 + rng() * 1.2, 2.05 + rng() * 0.9, true, `marsh-pool-${i}`);
            }
            const wetlandEdge = [[3.2, 4], [20.8, 4.5], [3.8, 20.5], [20.5, 20], [13, 3.2]] as const;
            for (let i = 0; i < wetlandEdge.length; i++) {
                const [tx, ty] = wetlandEdge[i];
                const scale = 1.12 + rng() * 0.5;
                const tree = i % 2 === 0 ? broadleaf : conifer;
                put(tx + (rng() - 0.5), ty + (rng() - 0.5), (ax, ay) => tree(ctx, ax, ay, scale));
            }
            for (let i = 0; i < 4; i++) {
                const scale = 0.85 + rng() * 0.5;
                put(3 + rng() * 19, 3 + rng() * 19, (tx, ty) => deadSnag(ctx, tx, ty, scale));
            }
            for (let i = 0; i < 6; i++) {
                const scale = 0.72 + rng() * 0.45;
                put(3 + rng() * 19, 3 + rng() * 19, (tx, ty) => bush(ctx, tx, ty, scale, false));
            }
            for (let i = 0; i < 3; i++) {
                const scale = 0.68 + rng() * 0.5;
                put(4 + rng() * 17, 4 + rng() * 17, (tx, ty) => boulder(ctx, tx, ty, scale));
            }
            for (let i = 0; i < 2; i++) {
                const scale = 0.9 + rng() * 0.38;
                const tree = rng() < 0.5 ? conifer : broadleaf;
                put(3 + rng() * 19, 3 + rng() * 19, (tx, ty) => tree(ctx, tx, ty, scale));
            }
        }
    },
    {
        key: 'standing-stones',
        place: (ctx, put) => {
            const rng = featureRng(ctx, 'biome:standing-stones');
            groundPatch(ctx, 12.5, 12.5, 9.8, 8.2, 0x506044, 0.26, 'stone-circle-moss');
            groundPatch(ctx, 12.5, 12.8, 6.7, 5.3, 0x81765b, 0.24, 'stone-circle-earth');
            groundPatch(ctx, 8, 17, 4.6, 3.2, 0x3f593b, 0.18, 'stone-circle-ferns');

            // A ruined gate anchors the far side; the remaining stones circle
            // it at varied heights, making a ritual place rather than fenceposts.
            put(12.5, 7.7, (tx, ty) => stoneGate(ctx, tx, ty, 1.3 + rng() * 0.18, 'north-gate'));
            const n = 7;
            for (let i = 0; i < n; i++) {
                const a = (i / n) * Math.PI * 2 + 0.2 + (rng() - 0.5) * 0.16;
                const scale = 1.28 + rng() * 0.58;
                const tall = 0.25 + rng() * 0.75;
                put(12.5 + Math.cos(a) * (6.4 + rng() * 0.7), 12.5 + Math.sin(a) * (5.7 + rng() * 0.8),
                    (tx, ty) => stoneMonolith(ctx, tx, ty, scale, tall));
            }
            put(12.5, 12.8, (tx, ty) => stoneAltar(ctx, tx, ty, 1.18));

            // A wind-bent copse and clustered rubble keep the clearing tied to
            // the surrounding country without diluting the stone silhouette.
            const copse = [[4.2, 16.8, 1.65], [5.8, 18.1, 1.35], [4.9, 20.2, 1.2]] as const;
            for (const [tx, ty, scale] of copse) {
                put(tx + (rng() - 0.5) * 0.6, ty + (rng() - 0.5) * 0.6,
                    (ax, ay) => conifer(ctx, ax, ay, scale + rng() * 0.18));
            }
            const rubble = [[18.5, 17.2], [19.5, 16.5], [18.9, 18.5]] as const;
            for (let i = 0; i < rubble.length; i++) {
                const [tx, ty] = rubble[i];
                put(tx, ty, (ax, ay) => boulder(ctx, ax, ay, 0.8 + i * 0.14 + rng() * 0.18));
            }
            flowerDrift(ctx, 9.5, 18.2, 16);
        }
    },
    {
        key: 'river',
        place: (ctx, put) => {
            const rng = featureRng(ctx, 'biome:river');
            // A contained spring-fed brook with a real sequence of outer bends:
            // spring -> riffles -> two rapids -> receiving pool. World rivers
            // belong to the shared hydrology layer; this parcel owns one reach.
            const flip = (hashString(`brook:${ctx.plotX},${ctx.plotY}`) & 1) === 1;
            const run: Array<{ x: number; y: number }> = [];
            const phase = (rng() - 0.5) * 0.7;
            const direction = flip ? -1 : 1;
            // The base reach crosses one diagonal of the iso ground. Offsetting
            // along its grid-space normal produces broad screen-space oxbows
            // without doubling back or self-intersecting like sharp waypoints.
            for (let i = 0; i <= 56; i++) {
                const t = i / 56;
                const envelope = Math.pow(Math.sin(t * Math.PI), 0.78);
                const wave = Math.sin(t * Math.PI * 3.6 + phase) * 3.15
                    + Math.sin(t * Math.PI * 7.2 + phase * 0.65) * 0.55;
                const meander = direction * wave * envelope;
                run.push({
                    x: 4.7 + 15.5 * t + meander * 0.7,
                    y: 19.2 - 14.1 * t + meander * 0.7
                });
            }
            const source = run[0];
            const mouth = run[run.length - 1];
            groundPatch(ctx, 12.5, 12.5, 10.8, 9.2, 0x496743, 0.18, 'river-valley');
            groundPatch(ctx, source.x + (flip ? -1 : 1), source.y + 1.2, 4.8, 3.5, 0x3d6040, 0.2, 'brook-head-moss');
            groundPatch(ctx, mouth.x + (flip ? 1 : -1), mouth.y - 1, 5.2, 3.8, 0x6e6a4b, 0.18, 'brook-mouth-silt');
            riverRun(ctx, run, 0.74, 0.52);
            brookRapids(ctx, run, Math.floor(run.length * 0.34), 0.76, 'upper');
            brookRapids(ctx, run, Math.floor(run.length * 0.69), 0.82, 'lower');
            pool(ctx, source.x, source.y, 2.25, 1.7, true, 'brook-spring');
            pool(ctx, mouth.x, mouth.y, 3.1, 2.3, true, 'brook-mouth');

            // Banks follow the sampled curve's normals. The old straight-line
            // interpolation left trees floating far from the actual bends.
            const banks = 13 + Math.floor(rng() * 4);
            for (let i = 0; i < banks; i++) {
                const side = rng() < 0.5 ? -1 : 1;
                const index = 3 + Math.floor(rng() * (run.length - 6));
                const point = run[index];
                const prev = run[index - 1];
                const next = run[index + 1];
                const dx = next.x - prev.x;
                const dy = next.y - prev.y;
                const len = Math.hypot(dx, dy) || 1;
                const distance = 2.3 + rng() * 3.6;
                const tx = point.x + (-dy / len) * side * distance;
                const ty = point.y + (dx / len) * side * distance;
                const kind = rng() < 0.56 ? broadleaf : conifer;
                const scale = 1.12 + rng() * 0.78;
                put(tx, ty, (ax, ay) => kind(ctx, ax, ay, scale));
            }
            const headTreeScale = 2.05 + rng() * 0.3;
            put(source.x + (flip ? -3.4 : 3.4), source.y + 2.1,
                (tx, ty) => ancientTree(ctx, tx, ty, headTreeScale, 'brook-head-tree'));
            const rapidRocks = [run[Math.floor(run.length * 0.31)], run[Math.floor(run.length * 0.72)]];
            for (let i = 0; i < rapidRocks.length; i++) {
                const point = rapidRocks[i];
                put(point.x + (flip ? -2.2 : 2.2), point.y + 1.8,
                    (tx, ty) => boulder(ctx, tx, ty, 1.05 + rng() * 0.35));
            }
            const quiet = run[Math.floor(run.length * 0.52)];
            put(quiet.x + (flip ? 3.1 : -3.1), quiet.y + 2.7,
                (tx, ty) => fallenLog(ctx, tx, ty, 0.9 + rng() * 0.2, 'brook-bank-fall'));
            scatterRocks(ctx, 12.5, 12.5, 18, 10);
        }
    },
    {
        key: 'thicket',
        place: (ctx, put) => {
            const rng = featureRng(ctx, 'biome:thicket');
            groundPatch(ctx, 9, 10.5, 8.2, 6.5, 0x284d31, 0.3, 'thicket-west-shadow');
            groundPatch(ctx, 16.5, 14.5, 7.5, 6.2, 0x315a36, 0.28, 'thicket-east-shadow');
            groundPatch(ctx, 12.5, 13.5, 5.2, 3.2, 0x6a6446, 0.17, 'thicket-animal-run');

            // Two interlocked colonies make one readable briar country. Radial
            // falloff packs their cores while leaving a narrow animal run.
            const colonies = [
                { x: 8.2, y: 9.1, rx: 4.7, ry: 3.8, count: 9 },
                { x: 16.4, y: 15.2, rx: 5.1, ry: 3.9, count: 10 }
            ];
            for (let colony = 0; colony < colonies.length; colony++) {
                const spec = colonies[colony];
                for (let i = 0; i < spec.count; i++) {
                    const a = rng() * Math.PI * 2;
                    const d = Math.sqrt(rng());
                    const tx = spec.x + Math.cos(a) * spec.rx * d;
                    const ty = spec.y + Math.sin(a) * spec.ry * d;
                    const scale = 0.9 + (1 - d) * 0.65 + rng() * 0.3;
                    put(tx, ty, (ax, ay) => brambleMass(ctx, ax, ay, scale, `${colony}:${i}`));
                }
            }

            const thicketElderScale = 2.55 + rng() * 0.28;
            put(12.6, 10.8, (tx, ty) => ancientTree(ctx, tx, ty, thicketElderScale, 'thicket-elder'));
            const canopy = [[4.8, 6.2], [8.8, 4.8], [16.2, 6.2], [20.1, 10.1], [19.5, 18.7], [7.2, 18.8]] as const;
            for (let i = 0; i < canopy.length; i++) {
                const [tx, ty] = canopy[i];
                const scale = 1.35 + rng() * 0.62;
                const tree = i % 3 === 0 ? conifer : broadleaf;
                put(tx + (rng() - 0.5) * 0.7, ty + (rng() - 0.5) * 0.7,
                    (ax, ay) => tree(ctx, ax, ay, scale));
            }

            put(18.6, 8.7, (tx, ty) => cragOutcrop(ctx, tx, ty, 1.02 + rng() * 0.16, 'thicket-crag'));
            put(17.2, 9.4, (tx, ty) => boulder(ctx, tx, ty, 1.05 + rng() * 0.2));
            put(7.4, 16.8, (tx, ty) => fallenLog(ctx, tx, ty, 1.05 + rng() * 0.2, 'thicket-log'));
        }
    },
    {
        key: 'deadwood',
        // TOURNAMENT RESOLVED (2026-07-18): design A "The Wind Road" won the
        // 2-variant round and is the canonical Stormbreak Wood — called
        // directly (the cannon-B / golem-C promotion pattern), no registry
        // routing. See ./redesign/DeadwoodA.ts.
        place: (ctx, put) => deadwoodDesignA(ctx, put)
    },
    {
        key: 'boulder-lone-tree',
        place: (ctx, put) => {
            const rng = featureRng(ctx, 'biome:sentinel-rock');
            groundPatch(ctx, 12.8, 13.1, 10.1, 8.1, 0x6e7054, 0.28, 'sentinel-shelf');
            groundPatch(ctx, 13.7, 15.2, 6.8, 4.7, 0x77705a, 0.22, 'sentinel-scree');
            groundPatch(ctx, 8.9, 10.2, 5.1, 4, 0x405b3b, 0.2, 'sentinel-tree-moss');
            const rockX = 13 + (rng() - 0.5) * 0.7;
            const rockY = 13.4 + (rng() - 0.5) * 0.5;
            const sentinelScale = 3.55 + rng() * 0.42;
            put(rockX, rockY, (tx, ty) => cragOutcrop(ctx, tx, ty, sentinelScale, 'sentinel'));
            const treeScale = 2.75 + rng() * 0.32;
            put(rockX - 3.5, rockY - 3.1, (tx, ty) => ancientTree(ctx, tx, ty, treeScale, 'sentinel-tree'));

            // Companion stones collapse toward the landmark's foot, creating a
            // geological apron instead of an evenly spaced decorative ring.
            const apron = [[-4.3, 2.2, 1.45], [-2.4, 3.8, 1.1], [2.8, 3.1, 1.3], [4.2, 1.4, 0.95], [1.2, 5, 0.82]] as const;
            for (const [ox, oy, scale] of apron) {
                put(rockX + ox + (rng() - 0.5) * 0.4, rockY + oy + (rng() - 0.5) * 0.4,
                    (tx, ty) => boulder(ctx, tx, ty, scale + rng() * 0.16));
            }
            const leePines = [[18.2, 14.8, 1.4], [20, 16.2, 1.13], [18.8, 18.3, 1], [20.8, 19.4, 0.82]] as const;
            for (const [tx, ty, scale] of leePines) {
                put(tx, ty, (ax, ay) => conifer(ctx, ax, ay, scale + rng() * 0.15));
            }
            flowerDrift(ctx, 7.2, 17.5, 22);
            scatterRocks(ctx, 13.5, 16, 9, 12);
        }
    },
    {
        key: 'glade',
        place: (ctx, put) => {
            const rng = featureRng(ctx, 'biome:glade');
            // Shade first, then the warm clearing: the earlier order laid one
            // dark wash over the sun patch and flattened the composition.
            groundPatch(ctx, 12.2, 11.8, 11.2, 9.8, 0x2f5237, 0.24, 'glade-edge');
            groundPatch(ctx, 12.7, 13.5, 8.1, 6.2, 0x7b9655, 0.26, 'glade-sun');
            groundPatch(ctx, 8.2, 16.2, 5.4, 3.3, 0x73904f, 0.2, 'glade-flower-slope');

            const springX = 14.5 + (rng() - 0.5) * 0.8;
            const springY = 13.2 + (rng() - 0.5) * 0.7;
            pool(ctx, springX, springY, 2.75, 2.05, true, 'glade-spring');

            // The forest wall occupies the far and side edges, deliberately
            // leaving the near meadow open. Clusters overlap like woodland,
            // rather than tracing all four borders at equal spacing.
            const forestWall = [
                [3.2, 4.5], [5.1, 3.6], [7.5, 4.6], [10.2, 3.7], [13, 4.2], [15.8, 3.6], [18.3, 4.5], [21.2, 5.3],
                [3.6, 7.2], [4.8, 9.8], [3.8, 12.7], [5, 15.4], [20.8, 8.2], [19.6, 10.8], [21, 13.6], [19.5, 16.2]
            ] as const;
            for (let i = 0; i < forestWall.length; i++) {
                const [tx, ty] = forestWall[i];
                const kind = i % 4 === 0 || i % 7 === 0 ? conifer : broadleaf;
                const scale = 1.28 + rng() * 0.7;
                put(tx + (rng() - 0.5) * 0.75, ty + (rng() - 0.5) * 0.65,
                    (ax, ay) => kind(ctx, ax, ay, scale));
            }
            put(6.5, 7.1, (tx, ty) => ancientTree(ctx, tx, ty, 2.45 + rng() * 0.25, 'glade-keeper'));

            const underbrush = [[5.4, 12.8], [6.3, 14.1], [18.3, 12.6], [18.7, 14.1], [9, 5.8], [16.6, 5.6]] as const;
            for (let i = 0; i < underbrush.length; i++) {
                const [tx, ty] = underbrush[i];
                put(tx, ty, (ax, ay) => bush(ctx, ax, ay, 1.05 + rng() * 0.42, i % 3 === 0));
            }
            const stones = [[8, 9.1, 1.15], [18, 9.2, 0.95], [7.2, 18.2, 0.82]] as const;
            for (const [tx, ty, scale] of stones) put(tx, ty, (ax, ay) => boulder(ctx, ax, ay, scale + rng() * 0.16));
            flowerDrift(ctx, 8.3, 14.7, 28);
            flowerDrift(ctx, 11.2, 18.2, 20);
            put(7, 16.7, (tx, ty) => fallenLog(ctx, tx, ty, 1 + rng() * 0.18, 'glade-log'));
            put(17.7, 17.2, (tx, ty) => stump(ctx, tx, ty));
        }
    }
];

const ARCHETYPE_LABELS: Record<string, string> = {
    lake: 'Mirrorwater Lake',
    crags: 'Moss-Crowned Crags',
    pines: 'Whisperpine Forest',
    grove: 'Elderwood Grove',
    meadow: 'Sunweave Meadow',
    marsh: 'Silverreed Fen',
    'standing-stones': 'Old Stone Circle',
    river: 'Wandering Brook',
    thicket: 'Briarwild',
    deadwood: 'Stormbreak Wood',
    'boulder-lone-tree': 'Sentinel Rock',
    glade: 'Greenveil Glade'
};

export interface WildernessNature {
    key: string;
    label: string;
    index: number;
}

export interface WildernessLifeAnchor {
    kind: 'fish' | 'forest' | 'frog';
    /** Scene-grid coordinates, already offset to this postcard. */
    gx: number;
    gy: number;
    phase: number;
    scale: number;
}

/** A brook ribbon: plot-local centerline plus its water half-width in tiles. */
export interface WildernessStream {
    points: TerrainPoint[];
    halfWidth: number;
}

export interface WildernessRenderResult extends WildernessNature {
    life: WildernessLifeAnchor[];
    /** Plot-LOCAL water geometry (tile coords 0..25), for surface queries
     * (rain splashes, footfalls) after the art is baked into a postcard RT. */
    waters: LakeTerrain[];
    streams: WildernessStream[];
}

export class WildernessRenderer {
    static readonly GROUND_PALETTE_KEY = 'wild-continuum-v1';

    /** Increment whenever wilderness postcard art changes. WorldMapSystem
     * includes this in its cache key so an old village/nature RenderTexture
     * can never survive behind a current empty-plot classification.
     * v7: plot corners round off like village lawns (junction-aware cuts).
     * v9: deadwood stubbed for its clean-room design round (delegator). */
    static readonly RENDER_VERSION = 10;

    static renderRevision(plotX: number, plotY: number, seedVersion: unknown = 0): string {
        const version = normalizeWorldNatureSeedVersion(seedVersion);
        const seed = wildernessPlotPresentationSeed(plotX, plotY, version);
        const base = `wilds_v${this.RENDER_VERSION}_s${version}_${seed}`;
        // Design-tournament coupling: while this plot's archetype has at least
        // one registered variant design, the ACTIVE slot joins the cache key,
        // so a Design Lab switch repaints exactly the affected postcards on
        // the next revision check (WorldMapSystem polls + fingerprint watch).
        const nature = this.natureAt(plotX, plotY, version);
        const inRound = listVariantUnits().some(info => info.unit === nature.key);
        return inRound ? `${base}_d${activeSlot(nature.key)}` : base;
    }

    /** A stable human-ish name for the plot's nature (for plates/logs). */
    static natureOf(seed: number): string {
        return ARCHETYPES[seed % ARCHETYPES.length].key;
    }

    static archetypeKeys(): string[] {
        return ARCHETYPES.map(archetype => archetype.key);
    }

    /**
     * Spatially correlated ecology. Elevation, moisture, and canopy are low
     * frequency world fields, so neighboring parcels usually belong to the
     * same country; the coordinate hash chooses a landmark within that
     * ecology without reverting to unrelated `seed % 12` dioramas.
     */
    static natureAt(plotX: number, plotY: number, seedVersion: unknown = 0): WildernessNature {
        const x = Number.isFinite(plotX) ? Math.trunc(plotX) : 0;
        const y = Number.isFinite(plotY) ? Math.trunc(plotY) : 0;
        const version = normalizeWorldNatureSeedVersion(seedVersion);
        const elevationSeed = wildernessEcologyPresentationSeed(0x41c6ce57, version, 1);
        const moistureSeed = wildernessEcologyPresentationSeed(0x9e3779b9, version, 2);
        const canopySeed = wildernessEcologyPresentationSeed(0x7f4a7c15, version, 3);
        const elevation = 0.5 + fbmNoise2D(x * 0.16, y * 0.16, elevationSeed, 4) * 0.5;
        const moisture = 0.5 + fbmNoise2D(x * 0.145 + 31.7, y * 0.145 - 12.3, moistureSeed, 4) * 0.5;
        const canopy = 0.5 + fbmNoise2D(x * 0.18 - 9.4, y * 0.18 + 23.8, canopySeed, 3) * 0.5;
        const detail = wildernessEcologyPresentationSeed(
            hashString(`wild-ecology:${x},${y}`),
            version,
            4
        );
        let key: string;

        if (moisture > 0.69 && elevation < 0.53) {
            key = moisture > 0.79 ? 'marsh' : (detail % 4 === 0 ? 'river' : 'lake');
        } else if (moisture > 0.61 && elevation < 0.61 && detail % 5 === 0) {
            key = 'river';
        } else if (elevation > 0.68) {
            key = detail % 7 === 0 ? 'standing-stones' : (detail % 3 === 0 ? 'boulder-lone-tree' : 'crags');
        } else if (canopy > 0.64) {
            key = elevation > 0.55 ? 'pines' : (detail % 3 === 0 ? 'thicket' : 'grove');
        } else if (canopy > 0.53) {
            key = detail % 4 === 0 ? 'glade' : (elevation > 0.55 ? 'pines' : 'grove');
        } else if (moisture < 0.34 && canopy < 0.46) {
            key = detail % 4 === 0 ? 'standing-stones' : 'deadwood';
        } else if (elevation > 0.58 && detail % 3 === 0) {
            key = 'boulder-lone-tree';
        } else {
            key = detail % 5 === 0 ? 'glade' : 'meadow';
        }
        const index = Math.max(0, ARCHETYPES.findIndex(archetype => archetype.key === key));
        return { key, label: ARCHETYPE_LABELS[key] ?? key, index };
    }

    /** Deterministic coordinates for the mandatory visual contact sheet. */
    static findShowcasePlots(
        searchRadius = 96,
        seedVersion: unknown = 0
    ): Array<{ key: string; label: string; x: number; y: number }> {
        const radius = Math.max(1, Math.min(512, Math.trunc(searchRadius)));
        const version = normalizeWorldNatureSeedVersion(seedVersion);
        const found = new Map<string, { key: string; label: string; x: number; y: number }>();
        for (let ring = 1; ring <= radius && found.size < ARCHETYPES.length; ring++) {
            for (let y = -ring; y <= ring; y++) {
                for (let x = -ring; x <= ring; x++) {
                    if (Math.max(Math.abs(x), Math.abs(y)) !== ring) continue;
                    const nature = this.natureAt(x, y, version);
                    if (!found.has(nature.key)) found.set(nature.key, { key: nature.key, label: nature.label, x, y });
                }
            }
        }
        return ARCHETYPES.flatMap(archetype => {
            const plot = found.get(archetype.key);
            return plot ? [plot] : [];
        });
    }

    /**
     * Draw the whole nature vignette for a plot into `g`, offset in TILE
     * coordinates (offX/offY = plot origin in world tiles). Deterministic:
     * same seed, same wilds, on every client.
     */
    static drawWildPlot(
        g: Phaser.GameObjects.Graphics,
        offX: number,
        offY: number,
        seed: number,
        plotX = 0,
        plotY = 0,
        seedVersion: unknown = 0
    ): WildernessRenderResult {
        const rng = mulberry32(hashString(`wild:${seed}`));
        const ctx: Ctx = { g, offX, offY, seed, plotX, plotY, rng, waters: [], streams: [], avoid: [], life: [] };
        const nature = this.natureAt(plotX, plotY, seedVersion);
        const archetype = ARCHETYPES[nature.index];
        const items: Array<{ tx: number; ty: number; draw: () => void }> = [];
        const put: Put = (tx, ty, draw) => {
            const cx = Math.max(1.5, Math.min(TILES - 1.5, tx));
            const cy = Math.max(1.5, Math.min(TILES - 1.5, ty));
            items.push({ tx: cx, ty: cy, draw: () => draw(cx, cy) });
        };
        archetype.place(ctx, put);
        // A pinch of shared seasoning so no two plots of one archetype match.
        if (rng() < 0.35) scatterRocks(ctx, 4 + rng() * 17, 4 + rng() * 17, 8, 5);
        if (rng() < 0.3) flowerDrift(ctx, 4 + rng() * 17, 4 + rng() * 17, 8);
        // The wilds grow the same tall grass as the village lawns: a
        // deterministic scatter over whatever ground the archetype left open,
        // painted before the standing pieces so it reads as ground cover.
        const tuftRng = featureRng(ctx, 'ground-tufts');
        const tuftTarget = 24 + Math.floor(tuftRng() * 14);
        let tufts = 0;
        for (let attempt = 0; attempt < tuftTarget * 3 && tufts < tuftTarget; attempt++) {
            const tuftX = 1.6 + tuftRng() * (TILES - 3.2);
            const tuftY = 1.6 + tuftRng() * (TILES - 3.2);
            if (ctx.waters.some(water => water.contains(tuftX, tuftY, 'bank'))) continue;
            if (ctx.avoid.some(blocked => blocked(tuftX, tuftY))) continue;
            grassTuft(ctx, tuftX, tuftY, 0.75 + tuftRng() * 0.5);
            tufts++;
        }
        paintSorted(items.filter(item => !ctx.avoid.some(blocked => blocked(item.tx, item.ty))));
        if (['pines', 'grove', 'thicket', 'deadwood', 'glade', 'crags'].includes(nature.key)) {
            const lifeRng = featureRng(ctx, `forest-life:${nature.key}`);
            const count = nature.key === 'pines' || nature.key === 'grove' ? 4 : 3;
            for (let i = 0; i < count; i++) {
                ctx.life.push({
                    kind: 'forest',
                    gx: offX + 3 + lifeRng() * 19,
                    gy: offY + 3 + lifeRng() * 19,
                    phase: lifeRng() * Math.PI * 2,
                    scale: 0.75 + lifeRng() * 0.75
                });
            }
        }
        return { ...nature, life: ctx.life, waters: ctx.waters, streams: ctx.streams };
    }
}
