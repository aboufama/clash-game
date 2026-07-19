import type Phaser from 'phaser';
import type { WildernessPlotCtx, WildernessPut } from '../WildernessRenderer';
import { WildernessVocabulary } from '../WildernessRenderer';

/**
 * DEADWOOD — design A: "The Wind Road".
 *
 * One regional downburst tore a single storm track through this country. The
 * track's grid heading is CONSTANT across plots, so neighbouring Stormbreak
 * parcels read as one weather event; only the lane's offset, the giant's
 * length, and the survivors vary per seed. Each plot carries:
 *
 *  - ONE monumental windthrown giant lying full length along the track:
 *    upturned root plate over a torn-earth crater, a silvered tapering trunk,
 *    a splintered pale-heartwood break, and the snapped-off crown lying
 *    beyond a visible gap, knocked slightly askew where it bounced.
 *  - Three (sometimes four) standing trunks broken mid-height, tops ending in
 *    jagged splinter crowns of cream heartwood — all combed to the same lean.
 *  - Storm-aligned windthrow debris (branches, bark slabs, shards) inside a
 *    bleached blowdown lane, plus knee-high sheared stumps at its edge.
 *  - Young regrowth conifers reclaiming the ground between the wrecks, and a
 *    pair of surviving edge trees that say the wood continues.
 *
 * Palette: silvered gray-brown weathered bark + cream/amber heartwood at
 * every break — deliberately far from the old red-brown scraggle.
 *
 * Determinism: featureRng only, unique 'dwA:*' tags. The fallen giant and its
 * debris are GROUND-layer art (drawn straight on ctx.g — they lie flat); an
 * avoid band over the lane keeps the framework's grass tufts from sprouting
 * through the trunk. Standing elements queue through put() with anchors kept
 * ≥2.5 tiles off the lane centerline, so painter order can never draw a
 * background tree across the foreground trunk.
 */

// ---- palette: silvered storm-killed wood ----
const BARK_DARK = 0x4e4437;
const BARK_MID = 0x7a6c56;
const BARK_LIT = 0xa29176;
const BARK_SILVER = 0xbcae90;
const HEART_LIT = 0xe4cd97;
const HEART_MID = 0xc2a46c;
const HEART_DK = 0x8f7448;
const EARTH_FACE = 0x4c3f30;
const EARTH_DK = 0x3a3126;
const ROOT_TONE = 0x827054;
const SHADOW_GREEN = 0x172015;

// Regional storm heading (grid space) and its left normal — shared by every
// plot so the archetype tiles as one storm system.
const STORM_UX = 0.882;
const STORM_UY = -0.471;
const NORM_X = 0.471;
const NORM_Y = 0.882;

type Pt = { x: number; y: number };

function segDist(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
    const dx = bx - ax;
    const dy = by - ay;
    const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy || 1)));
    return Math.hypot(px - (ax + dx * t), py - (ay + dy * t));
}

/** One closed contact-shadow polygon under a lying trunk (never stacked). */
function logShadow(
    g: Phaser.GameObjects.Graphics,
    pts: Pt[],
    radAt: (t: number) => number,
    ex: number,
    ey: number
): void {
    const n = pts.length - 1;
    const shadow: Pt[] = [{ x: pts[0].x - ex * 16, y: pts[0].y + 3 }];
    for (let i = 0; i <= n; i++) shadow.push({ x: pts[i].x, y: pts[i].y - radAt(i / n) * 0.12 });
    shadow.push({ x: pts[n].x + ex * 13, y: pts[n].y + ey * 13 + 3.5 });
    for (let i = n; i >= 0; i--) shadow.push({ x: pts[i].x + 5, y: pts[i].y + radAt(i / n) * 0.95 + 6 });
    WildernessVocabulary.fillPolygon(g, shadow, SHADOW_GREEN, 0.2);
}

/** Banded body of a lying trunk: mid barrel, lit top, dark belly, silver sheen. */
function logBody(
    g: Phaser.GameObjects.Graphics,
    pts: Pt[],
    radAt: (t: number) => number,
    sheen: boolean
): void {
    const V = WildernessVocabulary;
    const n = pts.length - 1;
    const top = pts.map((p, i) => ({ x: p.x, y: p.y - radAt(i / n) * 1.42 }));
    const lit = pts.map((p, i) => ({ x: p.x, y: p.y - radAt(i / n) * 0.42 }));
    const bellyTop = pts.map((p, i) => ({ x: p.x, y: p.y + radAt(i / n) * 0.12 }));
    const bot = pts.map((p, i) => ({ x: p.x, y: p.y + radAt(i / n) * 0.7 }));
    V.fillPolygon(g, [...top, ...[...bot].reverse()], BARK_MID);
    V.fillPolygon(g, [...top, ...[...lit].reverse()], BARK_LIT);
    V.fillPolygon(g, [...bellyTop, ...[...bot].reverse()], BARK_DARK);
    if (sheen) {
        const end = Math.max(2, Math.floor(n * 0.8));
        const sheenTop = top.slice(0, end + 1);
        const sheenBot = pts.slice(0, end + 1).map((p, i) => ({ x: p.x, y: p.y - radAt(i / n) * 1.02 }));
        V.fillPolygon(g, [...sheenTop, ...sheenBot.reverse()], BARK_SILVER, 0.55);
    }
}

/** A standing trunk snapped mid-height: splinter crown, bark flap, stubs. */
function stormSnag(ctx: WildernessPlotCtx, tx: number, ty: number, s: number, tag: string): void {
    const V = WildernessVocabulary;
    const g = ctx.g;
    const rng = V.featureRng(ctx, `dwA:snag:${tag}`);
    const p = V.at(ctx, tx, ty);
    const h = (64 + rng() * 18) * s;
    const lean = 0.13 + rng() * 0.09; // every top combed toward +x by the storm
    const wB = 10 * s;
    const wT = 4.6 * s;
    const topX = p.x + lean * h;
    const topY = p.y - h;

    g.fillStyle(SHADOW_GREEN, 0.22);
    g.fillEllipse(p.x + 7 * s, p.y + 3.5 * s, 46 * s, 13 * s);

    // root flare
    V.fillPolygon(g, [
        { x: p.x - wB - 8 * s, y: p.y + 3.4 * s },
        { x: p.x - wB * 0.5, y: p.y - 7 * s },
        { x: p.x + wB * 0.5, y: p.y - 7 * s },
        { x: p.x + wB + 8.5 * s, y: p.y + 4.2 * s }
    ], BARK_DARK);

    // trunk: mid barrel, lit west face, dark east face (NW light)
    const bl = { x: p.x - wB, y: p.y + 2 * s };
    const br = { x: p.x + wB, y: p.y + 3 * s };
    const tl = { x: topX - wT, y: topY };
    const tr = { x: topX + wT, y: topY };
    V.fillPolygon(g, [bl, tl, tr, br], BARK_MID);
    V.fillPolygon(g, [bl, tl,
        { x: topX - wT * 0.05, y: topY },
        { x: p.x - wB * 0.02, y: p.y + 2.2 * s }], BARK_LIT);
    V.fillPolygon(g, [
        { x: p.x + wB * 0.42, y: p.y + 2.7 * s },
        { x: topX + wT * 0.42, y: topY }, tr, br], BARK_DARK);

    // peeled silver streak up the lit face
    g.lineStyle(Math.max(1.6, 2.6 * s), BARK_SILVER, 0.75);
    g.lineBetween(p.x - wB * 0.55, p.y - h * 0.16, topX - wT * 0.7, topY + h * 0.2);

    // splinter crown — cream heartwood spears, lit side palest
    const spearN = 4 + (rng() < 0.5 ? 1 : 0);
    // The splinter fan spans EXACTLY the tapered trunk's top width — spears
    // erupt from the break face, never overhang the sides (owner note).
    const crownHalf = wT * 0.9;
    for (let i = 0; i < spearN; i++) {
        const f = i / (spearN - 1);
        const sx = topX + (f - 0.5) * 2 * crownHalf + (rng() - 0.5) * 2.2 * s;
        const tallest = i === Math.floor(spearN / 2);
        const hs = (tallest ? 24 + rng() * 9 : 10 + rng() * 10) * s;
        // Narrow spears: wide bases read as fat wedges at the owner's zoom
        const w2 = (1.2 + rng() * 0.7) * s;
        const color = f < 0.34 ? HEART_LIT : f < 0.72 ? HEART_MID : HEART_DK;
        g.fillStyle(color, 1);
        g.fillTriangle(sx - w2, topY + 3.5 * s, sx + w2, topY + 3.5 * s, sx + lean * hs * 1.4, topY - hs);
    }
    // bark spikes framing the crown
    g.fillStyle(BARK_LIT, 1);
    g.fillTriangle(topX - wT - 2 * s, topY + 4.2 * s, topX - wT + 2.4 * s, topY + 3 * s,
        topX - wT + 0.6 * s, topY - (9 + rng() * 5) * s);
    g.fillStyle(BARK_DARK, 1);
    g.fillTriangle(topX + wT - 2.6 * s, topY + 3 * s, topX + wT + 2 * s, topY + 4.2 * s,
        topX + wT + 0.3 * s, topY - (8 + rng() * 5) * s);
    // (no dark crown notch — the owner read the identical dark triangle at
    // every crown top as a repeated artifact rather than torn wood)

    // hanging bark flap peeled below the break
    V.fillPolygon(g, [
        { x: topX + wT * 0.55, y: topY + 4.4 * s },
        { x: topX + wT * 1.35, y: topY + 5.6 * s },
        { x: topX + wT * 1.05, y: topY + (18 + rng() * 7) * s }
    ], BARK_DARK);

    // broken branch stubs
    const stubN = 1 + (rng() < 0.65 ? 1 : 0);
    for (let i = 0; i < stubN; i++) {
        const hf = 0.42 + i * 0.2 + rng() * 0.08;
        const side = i % 2 === 0 ? 1 : -1;
        const sx0 = p.x + (topX - p.x) * hf + side * (wB + (wT - wB) * hf) * 0.85;
        const sy0 = p.y - h * hf;
        const len = (14 + rng() * 10) * s;
        const rise = (5 + rng() * 3.5) * s;
        g.lineStyle(Math.max(1.8, 4.4 * s), BARK_DARK, 1);
        g.lineBetween(sx0, sy0, sx0 + side * len, sy0 - rise);
        // (no pale tip cap — the owner reads bright dots at branch ends as
        // artifacts; the dark stub line carries the read, like the root fingers)
    }

    // bark striations; woodpecker holes on the biggest hulks
    g.lineStyle(Math.max(1.6, 2.2 * s), 0x584e42, 0.5);
    g.lineBetween(p.x - wB * 0.28, p.y, topX - wT * 0.4, topY + h * 0.12);
    g.lineBetween(p.x + wB * 0.5, p.y + 2 * s, topX + wT * 0.55, topY + h * 0.18);
    if (s >= 1.05) {
        g.fillStyle(0x2f271e, 1);
        g.fillCircle(p.x + (topX - p.x) * 0.55 + wB * 0.1, p.y - h * 0.55, 2.6);
        g.fillCircle(p.x + (topX - p.x) * 0.63 - wB * 0.12, p.y - h * 0.63, 2.1);
    }
}

/** A knee-high stump sheared into spears — storm-torn, never saw-cut. */
function shatteredStump(ctx: WildernessPlotCtx, tx: number, ty: number, s: number, tag: string): void {
    const V = WildernessVocabulary;
    const g = ctx.g;
    const rng = V.featureRng(ctx, `dwA:stump:${tag}`);
    const p = V.at(ctx, tx, ty);
    const h = (17 + rng() * 8) * s;
    const w = 7 * s;
    g.fillStyle(SHADOW_GREEN, 0.18);
    g.fillEllipse(p.x + 3 * s, p.y + 2 * s, 24 * s, 8 * s);
    const bl = { x: p.x - w, y: p.y + 1.4 * s };
    const br = { x: p.x + w, y: p.y + 2.2 * s };
    V.fillPolygon(g, [bl, { x: p.x - w * 0.85, y: p.y - h }, { x: p.x + w * 0.85, y: p.y - h }, br], BARK_MID);
    V.fillPolygon(g, [bl, { x: p.x - w * 0.85, y: p.y - h }, { x: p.x, y: p.y - h }, { x: p.x, y: p.y + 1.7 * s }], BARK_LIT);
    V.fillPolygon(g, [{ x: p.x + w * 0.4, y: p.y + 2 * s }, { x: p.x + w * 0.4, y: p.y - h }, { x: p.x + w * 0.85, y: p.y - h }, br], BARK_DARK);
    const spears = [
        { f: -0.6, color: HEART_LIT },
        { f: 0.05, color: HEART_MID },
        { f: 0.62, color: HEART_DK }
    ];
    for (const spear of spears) {
        const sx = p.x + spear.f * w;
        const hs = (7 + rng() * 7) * s;
        g.fillStyle(spear.color, 1);
        g.fillTriangle(sx - 2.4 * s, p.y - h + 1, sx + 2.4 * s, p.y - h + 1, sx + 1.7 * s, p.y - h - hs);
    }
    // (no dark top notch — same repeated-artifact read as the snag crowns)
}

/** The monumental windthrown giant: crater, root plate, trunk, break, crown. */
function fallenGiant(
    ctx: WildernessPlotCtx,
    ax: number, ay: number, bx: number, by: number,
    c0x: number, c0y: number, c1x: number, c1y: number,
    plateX: number, plateY: number
): void {
    const V = WildernessVocabulary;
    const g = ctx.g;
    const rng = V.featureRng(ctx, 'dwA:giant');

    // ---- centerline (screen) with a slight lying sag ----
    const N = 8;
    const pts: Pt[] = [];
    for (let i = 0; i <= N; i++) {
        const t = i / N;
        const p = V.at(ctx, ax + (bx - ax) * t, ay + (by - ay) * t);
        pts.push({ x: p.x, y: p.y + Math.sin(t * Math.PI) * 3.5 });
    }
    const rad = (t: number) => 20 - 7.5 * t;
    const eLen = Math.hypot(pts[N].x - pts[0].x, pts[N].y - pts[0].y) || 1;
    const ex = (pts[N].x - pts[0].x) / eLen;
    const ey = (pts[N].y - pts[0].y) / eLen;
    const perpX = -ey;
    const perpY = ex;

    logShadow(g, pts, rad, ex, ey);

    // ---- torn-earth crater where the roots pulled out ----
    // Deep-brown DIRT, not a green-tinted smudge: the hole the roots tore out
    // of the ground reads as exposed earth (owner note).
    V.groundPatch(ctx, plateX - STORM_UX * 0.95, plateY - STORM_UY * 0.95, 1.5, 1.05, 0x5a4632, 0.6, 'dwA-crater-rim');
    V.groundPatch(ctx, plateX - STORM_UX * 0.95, plateY - STORM_UY * 0.95, 0.95, 0.7, 0x33281c, 0.85, 'dwA-crater-pit');
    const craterP = V.at(ctx, plateX - STORM_UX * 0.95, plateY - STORM_UY * 0.95);
    for (let i = 0; i < 3; i++) {
        const a = rng() * Math.PI * 2;
        g.fillStyle(0x5c4c39, 0.95);
        g.fillEllipse(craterP.x + Math.cos(a) * 26, craterP.y + Math.sin(a) * 13 + 2, 6 + rng() * 3, 4);
    }

    // ---- the upturned root plate: a gnarled torn root mass, never a disc ----
    const pc = V.at(ctx, plateX, plateY);
    // Sits down-and-right of the raw anchor so the root crown visually welds
    // onto the trunk's butt instead of floating beside it (owner note, twice:
    // the first +6/-17 nudge still read detached at close zoom).
    const plate = { x: pc.x + 10, y: pc.y - 9 };
    const prx = 25 + rng() * 3;
    const pry = 31 + rng() * 3;
    const trunkA = Math.atan2(pts[1].y - plate.y, pts[1].x - plate.x);
    const fx = (a: number, r: number) => plate.x + Math.cos(a) * prx * r;
    const fy = (a: number, r: number) => plate.y + Math.sin(a) * pry * r;

    // Seven kinked root fingers radiate from the collar — thick at the base,
    // tapering dark to their tips. They own the outline; the sector facing
    // the trunk stays clear (that's where the bole attaches). The `snapped`
    // roll stays in the rng sequence to keep the owner-approved layout stable.
    const fingers: Array<{ a: number; kink: number; reach: number; w: number; snapped: boolean }> = [];
    const fingerN = 7;
    for (let i = 0; i < fingerN; i++) {
        fingers.push({
            a: trunkA + Math.PI + (i / (fingerN - 1) - 0.5) * 4.6 + (rng() - 0.5) * 0.34,
            kink: (rng() - 0.5) * 0.95,
            reach: 1.32 + rng() * 0.55,
            w: 4.6 + rng() * 3.4,
            snapped: rng() < 0.65
        });
    }
    for (const fg of fingers) {
        const a2 = fg.a + fg.kink;
        const bX = fx(fg.a, 0.5);
        const bY = fy(fg.a, 0.5);
        const eX = fx(fg.a, fg.reach * 0.68);
        const eY = fy(fg.a, fg.reach * 0.68);
        const tX = eX + Math.cos(a2) * prx * fg.reach * 0.42;
        const tY = eY + Math.sin(a2) * pry * fg.reach * 0.42;
        const n1x = -Math.sin(fg.a);
        const n1y = Math.cos(fg.a);
        const n2x = -Math.sin(a2);
        const n2y = Math.cos(a2);
        // dark body of the kinked finger, then a lit upper face so it reads round
        V.fillPolygon(g, [
            { x: bX + n1x * fg.w, y: bY + n1y * fg.w },
            { x: eX + n2x * fg.w * 0.55, y: eY + n2y * fg.w * 0.55 },
            { x: tX, y: tY },
            { x: eX - n2x * fg.w * 0.55, y: eY - n2y * fg.w * 0.55 },
            { x: bX - n1x * fg.w, y: bY - n1y * fg.w }
        ], BARK_DARK);
        V.fillPolygon(g, [
            { x: bX + n1x * fg.w * 0.5 - 1, y: bY + n1y * fg.w * 0.5 - 1.4 },
            { x: eX + n2x * fg.w * 0.28 - 0.8, y: eY + n2y * fg.w * 0.28 - 1.3 },
            { x: tX - 0.5, y: tY - 1 },
            { x: eX - n2x * fg.w * 0.28 - 0.4, y: eY - n2y * fg.w * 0.28 - 0.3 },
            { x: bX - n1x * fg.w * 0.4 - 0.5, y: bY - n1y * fg.w * 0.4 - 0.2 }
        ], ROOT_TONE);
        // (no pale tip caps — the owner read them as odd bright circles;
        // the fingers' tapered dark silhouette carries the read on its own)
        // one fine rootlet whipping off the elbow
        g.lineStyle(2.4, BARK_DARK, 0.9);
        const ra = a2 + (rng() < 0.5 ? 0.85 : -0.85);
        g.lineBetween(eX, eY, eX + Math.cos(ra) * (7 + rng() * 5), eY + Math.sin(ra) * (7 + rng() * 5) + 2);
    }

    // ragged earth mass: the rim bulges out along each finger base and tears
    // into notches between them — deliberately NOT an ellipse
    const angDist = (a: number, b: number) =>
        Math.abs((((a - b) % (Math.PI * 2)) + Math.PI * 3) % (Math.PI * 2) - Math.PI);
    const rim: Pt[] = [];
    const rimN = 18;
    for (let i = 0; i < rimN; i++) {
        const a = (i / rimN) * Math.PI * 2;
        let near = 9;
        for (const fg of fingers) near = Math.min(near, angDist(a, fg.a));
        let r = 0.84 + rng() * 0.18;
        if (near < 0.24) r += 0.18;
        else if (near > 0.52) r -= 0.16 + rng() * 0.1;
        // The trunk-facing sector never tears: a notch there reads as a green
        // hole punched between crown and trunk instead of torn earth.
        if (angDist(a, trunkA) < 0.8) r = Math.max(r, 0.95);
        rim.push({ x: fx(a, r), y: fy(a, r) });
    }
    V.fillPolygon(g, rim, 0x41372a);
    V.fillPolygon(g, rim.map(p => ({
        x: plate.x + (p.x - plate.x) * 0.85 - 1.6,
        y: plate.y + (p.y - plate.y) * 0.83 - 2.2
    })), 0x5a4a37);
    V.fillPolygon(g, rim.map(p => ({
        x: plate.x + (p.x - plate.x) * 0.64 + 0.8,
        y: plate.y + (p.y - plate.y) * 0.62 + 1.4
    })), EARTH_FACE);

    // roots crossing the earth face — bent, varied lengths, never even spokes
    const collarX = plate.x + Math.cos(trunkA) * prx * 0.16;
    const collarY = plate.y + Math.sin(trunkA) * pry * 0.16;
    for (const fg of fingers) {
        const endR = 0.36 + rng() * 0.26;
        const bendA = fg.a + (rng() - 0.5) * 0.5;
        const mX = fx(bendA, endR * 0.55);
        const mY = fy(bendA, endR * 0.55);
        g.lineStyle(2 + fg.w * 0.35, ROOT_TONE, 0.95);
        g.lineBetween(collarX, collarY, mX, mY);
        g.lineBetween(mX, mY, fx(fg.a, endR + 0.2), fy(fg.a, endR + 0.2));
    }
    // the torn collar: ragged splinters where the bole ripped away — kept
    // DARK (the owner reads any bright fleck on the crown as an odd tip)
    for (let i = 0; i < 4; i++) {
        const a = trunkA + (i / 3 - 0.5) * 2.6 + (rng() - 0.5) * 0.4;
        const len = 6 + rng() * 5;
        g.fillStyle(i % 2 ? HEART_DK : 0x6b5a41, 1);
        g.fillTriangle(
            collarX - Math.sin(a) * 3, collarY + Math.cos(a) * 3,
            collarX + Math.sin(a) * 3, collarY - Math.cos(a) * 3,
            collarX + Math.cos(a) * len, collarY + Math.sin(a) * len
        );
    }

    // earth clods clinging in the notches between fingers…
    const sortedFg = [...fingers].sort((q, w2) => q.a - w2.a);
    for (let i = 0; i < sortedFg.length - 1; i++) {
        if (rng() < 0.3) continue;
        const mid = (sortedFg[i].a + sortedFg[i + 1].a) / 2;
        const rr2 = 0.78 + rng() * 0.3;
        const cxq = fx(mid, rr2);
        const cyq = fy(mid, rr2);
        const cw = 3.5 + rng() * 3;
        V.fillPolygon(g, [
            { x: cxq - cw, y: cyq + cw * 0.35 },
            { x: cxq - cw * 0.3, y: cyq - cw * 0.7 },
            { x: cxq + cw * 0.8, y: cyq - cw * 0.25 },
            { x: cxq + cw * 0.55, y: cyq + cw * 0.6 }
        ], rng() < 0.5 ? EARTH_DK : 0x5c4c39);
    }
    // …and two shaken loose, dropping toward the crater on hair roots
    for (const side of [-0.45, 0.3]) {
        const dx0 = plate.x + prx * side;
        g.lineStyle(1.4, ROOT_TONE, 0.85);
        g.lineBetween(dx0, plate.y + pry * 0.82, dx0 + 2, plate.y + pry * 1.14);
        g.fillStyle(EARTH_DK, 1);
        g.fillEllipse(dx0 + 2, plate.y + pry * (1.14 + rng() * 0.08), 5.5, 3.6);
    }
    // one stone still gripped in the mass
    g.fillStyle(0x7e8286, 1);
    g.fillEllipse(plate.x + prx * 0.34, plate.y + pry * 0.42, 6.5, 4.4);

    // ---- the trunk ----
    logBody(g, pts, rad, true);

    // The butt terminates as a CYLINDER end, not a plane: a convex cap
    // curving back toward the crown, shaded like the body strips it wraps.
    const rad0 = rad(0);
    const capC = { x: pts[0].x, y: pts[0].y - rad0 * 0.36 };
    const capH = rad0 * 1.06;
    const capB = rad0 * 0.52;
    // The cap's shading bands CONTINUE the trunk strips exactly (band
    // fractions derived from logBody's -0.42r / +0.12r strip boundaries and
    // the -1.02r sheen line, re-expressed in cap space), the trunk sheen is
    // carried onto the cap, and every inner handoff edge is jittered by an
    // index hash (never the shared rng - layout stream must stay stable).
    // Straight vertical seams at the butt were owner-reported twice: first as
    // AA gaps showing grass, then as band/sheen value steps on a straight
    // handoff line.
    const capJit = (i: number) => (Math.sin(i * 12.9898 + 4.1414) * 43758.5453 % 1) * 3 - 1.5;
    const capEdge = (from: number, to: number, tone: number, innerPush: number, alpha = 1) => {
        const poly: Pt[] = [];
        const steps = 8;
        for (let i = 0; i <= steps; i++) {
            const s = from + ((to - from) * i) / steps;
            const w = Math.sqrt(Math.max(0, 1 - s * s)) * capB;
            poly.push({ x: capC.x - ex * w, y: capC.y + s * capH - ey * w });
        }
        for (let i = steps; i >= 0; i--) {
            const s = from + ((to - from) * i) / steps;
            const push = innerPush + capJit(i + Math.round(from * 7));
            poly.push({ x: capC.x + ex * push, y: capC.y + s * capH + ey * push });
        }
        V.fillPolygon(g, poly, tone, alpha);
    };
    // trunk strip boundaries in cap space: lit ends (-0.42r+0.36r)/1.06r,
    // dark starts (+0.12r+0.36r)/1.06r, sheen ends (-1.02r+0.36r)/1.06r
    capEdge(-1, 1, BARK_MID, capB * 0.55);
    capEdge(-1, -0.057, BARK_LIT, capB * 0.3);
    capEdge(0.453, 1, BARK_DARK, capB * 0.3);
    capEdge(-1, -0.623, BARK_SILVER, capB * 0.25, 0.55);

    // (No moss saddle: the flat green quad sat so close to the grass tones
    // that the owner read it as a hole punched in the trunk at every zoom.
    // The silvered bark + seams carry the weathering on their own.)

    // two continuous wavy bark seams
    for (const level of [-0.6, -0.05]) {
        const jitter: number[] = [];
        for (let i = 0; i <= N; i++) jitter.push((rng() - 0.5) * 3.2);
        g.lineStyle(2.2, 0x5b5045, 0.5);
        for (let i = 1; i <= N; i++) {
            g.lineBetween(
                pts[i - 1].x, pts[i - 1].y + rad((i - 1) / N) * level + jitter[i - 1],
                pts[i].x, pts[i].y + rad(i / N) * level + jitter[i]
            );
        }
    }

    // bark-loss lens: sapwood showing through mid-trunk
    const lc = pts[Math.floor(N * 0.5)];
    const rr = rad(0.5);
    V.fillPolygon(g, [
        { x: lc.x - 38, y: lc.y - rr * 0.55 },
        { x: lc.x - 15, y: lc.y - rr * 0.8 },
        { x: lc.x + 20, y: lc.y - rr * 0.7 },
        { x: lc.x + 40, y: lc.y - rr * 0.3 },
        { x: lc.x + 24, y: lc.y + rr * 0.05 },
        { x: lc.x - 18, y: lc.y - rr * 0.05 }
    ], HEART_MID);
    V.fillPolygon(g, [
        { x: lc.x - 38, y: lc.y - rr * 0.55 },
        { x: lc.x - 15, y: lc.y - rr * 0.8 },
        { x: lc.x + 20, y: lc.y - rr * 0.7 },
        { x: lc.x + 17, y: lc.y - rr * 0.38 },
        { x: lc.x - 27, y: lc.y - rr * 0.32 }
    ], HEART_LIT, 0.9);
    g.lineStyle(1.8, BARK_DARK, 0.55);
    g.lineBetween(lc.x - 38, lc.y - rr * 0.55, lc.x - 15, lc.y - rr * 0.8);
    g.lineBetween(lc.x - 15, lc.y - rr * 0.8, lc.x + 20, lc.y - rr * 0.7);

    // broken branch stubs still reaching up
    const stubs = [
        { t: 0.3, a: -1.75, len: 24 },
        { t: 0.52, a: -0.95, len: 30 },
        { t: 0.7, a: -1.45, len: 19 }
    ];
    for (const stub of stubs) {
        const i0 = stub.t * N;
        const lo = Math.floor(i0);
        const f = i0 - lo;
        const bxp = pts[lo].x + (pts[Math.min(N, lo + 1)].x - pts[lo].x) * f;
        const byp = pts[lo].y + (pts[Math.min(N, lo + 1)].y - pts[lo].y) * f - rad(stub.t) * 1.3;
        const len = stub.len + rng() * 6;
        const tx2 = bxp + Math.cos(stub.a) * len;
        const ty2 = byp + Math.sin(stub.a) * len;
        g.lineStyle(6, BARK_DARK, 1);
        g.lineBetween(bxp, byp, tx2, ty2);
        g.lineStyle(3.6, BARK_MID, 1);
        g.lineBetween(bxp, byp, bxp + (tx2 - bxp) * 0.92, byp + (ty2 - byp) * 0.92);
        g.fillStyle(HEART_MID, 1);
        g.fillTriangle(tx2 - 3, ty2 + 2, tx2 + 3, ty2 + 2, tx2 + 0.8, ty2 - 4.6);
    }

    // ---- the splintered break ----
    const eb = pts[N];
    const re = rad(1);
    g.fillStyle(0x33291f, 1);
    g.fillTriangle(eb.x - ex * 5, eb.y - re * 1.3, eb.x + ex * 8, eb.y - re * 0.2, eb.x - ex * 5, eb.y + re * 0.62);
    // bark lips carried past the break
    g.fillStyle(BARK_LIT, 1);
    g.fillTriangle(eb.x - ex * 11, eb.y - re * 1.42, eb.x + ex * 14, eb.y - re * 1.05, eb.x - ex * 8, eb.y - re * 0.9);
    g.fillStyle(BARK_DARK, 1);
    g.fillTriangle(eb.x - ex * 10, eb.y + re * 0.7, eb.x + ex * 11, eb.y + re * 0.45, eb.x - ex * 7, eb.y + re * 0.2);
    // heartwood spears flung along the storm line
    const spears = [
        { off: -1.2, len: 36, w: 5, color: HEART_LIT },
        { off: -0.7, len: 50, w: 6, color: HEART_LIT },
        { off: -0.2, len: 27, w: 5.2, color: HEART_MID },
        { off: 0.25, len: 39, w: 4.6, color: HEART_MID },
        { off: 0.6, len: 18, w: 4.2, color: HEART_DK }
    ];
    for (const spear of spears) {
        const cx2 = eb.x + perpX * spear.off * re - ex * 4;
        const cy2 = eb.y + perpY * spear.off * re - ey * 4;
        const apex = spear.len + rng() * 8;
        g.fillStyle(spear.color, 1);
        g.fillTriangle(
            cx2 + perpX * spear.w, cy2 + perpY * spear.w,
            cx2 - perpX * spear.w, cy2 - perpY * spear.w,
            cx2 + ex * apex + perpX * (rng() - 0.5) * 7, cy2 + ey * apex + perpY * (rng() - 0.5) * 7
        );
    }
    // shards scattered on the ground beyond the break
    for (let i = 0; i < 4; i++) {
        const d = 46 + rng() * 40;
        const side = (rng() - 0.5) * 34;
        const sx2 = eb.x + ex * d + perpX * side;
        const sy2 = eb.y + ey * d + perpY * side * 0.5 + 5;
        const len2 = 8 + rng() * 7;
        g.fillStyle(i % 2 ? HEART_MID : HEART_LIT, 1);
        g.fillTriangle(sx2 - len2, sy2 + 2.6, sx2 + len2 * 0.6, sy2 + 2, sx2 + len2 * 0.2, sy2 - len2 * (i === 1 ? 1.5 : 0.55));
    }

    // ---- the snapped-off crown, lying beyond the gap ----
    const M = 5;
    const cpts: Pt[] = [];
    for (let i = 0; i <= M; i++) {
        const t = i / M;
        const p = V.at(ctx, c0x + (c1x - c0x) * t, c0y + (c1y - c0y) * t);
        cpts.push({ x: p.x, y: p.y + Math.sin(t * Math.PI) * 1.8 });
    }
    const crad = (t: number) => 10.5 - 6.5 * t;
    const e2Len = Math.hypot(cpts[M].x - cpts[0].x, cpts[M].y - cpts[0].y) || 1;
    const e2x = (cpts[M].x - cpts[0].x) / e2Len;
    const e2y = (cpts[M].y - cpts[0].y) / e2Len;
    logShadow(g, cpts, crad, e2x, e2y);
    logBody(g, cpts, crad, false);
    // its broken end faces BACK toward the trunk it left
    const cb = cpts[0];
    const cre = crad(0);
    g.fillStyle(0x33291f, 1);
    g.fillTriangle(cb.x + e2x * 4, cb.y - cre * 1.2, cb.x - e2x * 7, cb.y - cre * 0.1, cb.x + e2x * 4, cb.y + cre * 0.55);
    const backSpears = [
        { off: -0.9, len: 22, color: HEART_LIT },
        { off: -0.1, len: 28, color: HEART_MID },
        { off: 0.5, len: 16, color: HEART_DK }
    ];
    for (const spear of backSpears) {
        const cx2 = cb.x - e2y * spear.off * cre;
        const cy2 = cb.y + e2x * spear.off * cre;
        const apex = spear.len + rng() * 5;
        g.fillStyle(spear.color, 1);
        g.fillTriangle(
            cx2 - e2y * 4, cy2 + e2x * 4,
            cx2 + e2y * 4, cy2 - e2x * 4,
            cx2 - e2x * apex, cy2 - e2y * apex
        );
    }
    // one stub, then bare dead branches fanning from the crown tip
    const midC = cpts[3];
    g.lineStyle(4, BARK_DARK, 1);
    g.lineBetween(midC.x, midC.y - crad(0.6) * 1.2, midC.x + 9, midC.y - crad(0.6) * 1.2 - 13);
    const tip = cpts[M];
    const branches = [
        { a: -0.72, len: 24 },
        { a: -0.2, len: 32 },
        { a: 0.55, len: 20 }
    ];
    for (const branch of branches) {
        const ca = Math.cos(branch.a);
        const sa = Math.sin(branch.a);
        const dx2 = e2x * ca - e2y * sa;
        const dy2 = (e2x * sa + e2y * ca) * 0.62;
        const kinkX = tip.x + dx2 * branch.len * 0.6;
        const kinkY = tip.y + dy2 * branch.len * 0.6;
        g.lineStyle(3.8, BARK_DARK, 1);
        g.lineBetween(tip.x, tip.y, kinkX, kinkY);
        g.lineStyle(2.4, BARK_DARK, 1);
        g.lineBetween(kinkX, kinkY, kinkX + dx2 * branch.len * 0.4 - dy2 * 7, kinkY + dy2 * branch.len * 0.4 - 4);
    }
}

/** Storm-aligned litter inside the blowdown lane: branches, slabs, shards. */
function windthrowLitter(
    ctx: WildernessPlotCtx,
    ax: number, ay: number, bx: number, by: number,
    ex: number, ey: number
): void {
    const V = WildernessVocabulary;
    const g = ctx.g;
    const rng = V.featureRng(ctx, 'dwA:debris');
    const pieces = 7 + Math.floor(rng() * 3);
    for (let i = 0; i < pieces; i++) {
        const t = 0.1 + ((i + rng() * 0.6) / pieces) * 0.85;
        const side = rng() < 0.45 ? -1 : 1;
        const off = side < 0 ? -(1.5 + rng() * 0.55) : 1 + rng() * 0.75;
        const gx = ax + (bx - ax) * t + NORM_X * off;
        const gy = ay + (by - ay) * t + NORM_Y * off;
        const p = V.at(ctx, gx, gy);
        const aJit = (rng() - 0.5) * 0.9;
        const ca = Math.cos(aJit);
        const sa = Math.sin(aJit);
        const dx = ex * ca - ey * sa;
        const dy = (ex * sa + ey * ca) * 0.55;
        const kind = i % 3;
        if (kind === 0) {
            // a snapped branch with one fork, lying with the storm
            const len = 13 + rng() * 8;
            g.lineStyle(4.4, BARK_DARK, 1);
            g.lineBetween(p.x - dx * len, p.y - dy * len, p.x + dx * len, p.y + dy * len);
            g.lineStyle(2.8, BARK_MID, 1);
            g.lineBetween(p.x - dx * len * 0.9, p.y - dy * len * 0.9 - 1.4, p.x + dx * len * 0.85, p.y + dy * len * 0.85 - 1.4);
            g.lineStyle(2.4, BARK_DARK, 1);
            g.lineBetween(p.x, p.y, p.x + dy * 12 + dx * 6, p.y - dx * 6.5 + dy * 6);
        } else if (kind === 1) {
            // a curl of shed bark
            V.fillPolygon(g, [
                { x: p.x - dx * 8.5 - dy * 3, y: p.y - dy * 8.5 - 3.2 },
                { x: p.x + dx * 8.5, y: p.y + dy * 8.5 - 3.8 },
                { x: p.x + dx * 6.8, y: p.y + dy * 6.8 + 3 },
                { x: p.x - dx * 7.7, y: p.y - dy * 7.7 + 2.6 }
            ], BARK_DARK);
            g.lineStyle(2, BARK_LIT, 0.8);
            g.lineBetween(p.x - dx * 7.7, p.y - dy * 7.7 - 3, p.x + dx * 7.7, p.y + dy * 7.7 - 3.6);
        } else {
            // a heartwood shard — pale only away from the root end: bright
            // flecks landing beside the crown read as odd tips on it
            const len = 9 + rng() * 6;
            const paleRoll = rng() < 0.5;
            g.fillStyle(t < 0.32 ? BARK_DARK : (paleRoll ? HEART_MID : HEART_LIT), 1);
            g.fillTriangle(p.x - dx * len, p.y - dy * len + 2.2, p.x + dx * len, p.y + dy * len + 1.6,
                p.x + dx * len * 0.3, p.y + dy * len * 0.3 - len * 0.5);
        }
    }
}

export function deadwoodDesignA(ctx: WildernessPlotCtx, put: WildernessPut): void {
    const V = WildernessVocabulary;
    const layout = V.featureRng(ctx, 'dwA:layout');

    // ---- the storm track: regional heading, per-plot offset and length ----
    const shift = (layout() - 0.5) * 3.8;
    const cx = 12.5 + NORM_X * shift;
    const cy = 12.5 + NORM_Y * shift;
    const gap = 1.35 + layout() * 0.5;
    const crownLen = 3 + layout() * 0.9;
    const delta = (layout() - 0.5) * 0.5; // the crown bounced slightly askew
    const half = Math.min(5.4 + layout(), (22.8 - cx) / STORM_UX - (gap + crownLen));
    const ax = cx - STORM_UX * half;
    const ay = cy - STORM_UY * half;
    const bx = cx + STORM_UX * half;
    const by = cy + STORM_UY * half;
    const cosD = Math.cos(delta);
    const sinD = Math.sin(delta);
    const cux = STORM_UX * cosD - STORM_UY * sinD;
    const cuy = STORM_UX * sinD + STORM_UY * cosD;
    const c0x = bx + STORM_UX * gap;
    const c0y = by + STORM_UY * gap;
    const c1x = c0x + cux * crownLen;
    const c1y = c0y + cuy * crownLen;
    const plateX = ax - STORM_UX * 0.18;
    const plateY = ay - STORM_UY * 0.18;

    const laneDist = (gx: number, gy: number) => Math.min(
        segDist(gx, gy, ax, ay, bx, by),
        segDist(gx, gy, c0x, c0y, c1x, c1y),
        Math.hypot(gx - plateX, gy - plateY)
    );
    // No grass through the giant; put() anchors inside the band are dropped.
    ctx.avoid.push((gx, gy) => laneDist(gx, gy) < 1.75);

    // ---- ground: dry wood floor, a bleached blowdown lane, mossed edges ----
    V.groundPatch(ctx, 12.5, 12.5, 10.8, 9, 0x6d6650, 0.14, 'dwA-floor');
    const laneP = (t: number): Pt => ({ x: ax + (bx - ax) * t, y: ay + (by - ay) * t });
    for (const [t, rx, alpha] of [[0.18, 3.8, 0.24], [0.5, 4.3, 0.28], [0.85, 3.6, 0.22]] as const) {
        const c = laneP(t);
        V.groundPatch(ctx, c.x, c.y, rx, 2.9, 0x8a7f5c, alpha, `dwA-lane-${t}`);
    }
    V.groundPatch(ctx,
        Math.max(4.8, Math.min(20.2, cx - NORM_X * 5)),
        Math.max(4.8, Math.min(20.2, cy - NORM_Y * 5)),
        4.4, 3.3, 0x4b5e3c, 0.17, 'dwA-moss-n');
    V.groundPatch(ctx,
        Math.max(4.8, Math.min(20.2, cx + NORM_X * 5.2)),
        Math.max(4.8, Math.min(20.2, cy + NORM_Y * 5.2)),
        4.6, 3.4, 0x516440, 0.15, 'dwA-moss-s');

    // ---- the fallen giant + its litter (ground layer: they lie flat) ----
    fallenGiant(ctx, ax, ay, bx, by, c0x, c0y, c1x, c1y, plateX, plateY);
    const pA = V.at(ctx, ax, ay);
    const pB = V.at(ctx, bx, by);
    const eLen = Math.hypot(pB.x - pA.x, pB.y - pA.y) || 1;
    windthrowLitter(ctx, ax, ay, bx, by, (pB.x - pA.x) / eLen, (pB.y - pA.y) / eLen);
    // stones the roots tore up, ringing the crater
    V.scatterRocks(ctx, plateX - STORM_UX * 2.9, plateY - STORM_UY * 2.9, 2, 3);

    // ---- standing wrecks: broken snags combed to one lean ----
    const placeOffLane = (t: number, side: number, d: number, minD: number): Pt => {
        let gx = ax + (bx - ax) * t + NORM_X * side * d;
        let gy = ay + (by - ay) * t + NORM_Y * side * d;
        gx = Math.max(3, Math.min(22, gx));
        gy = Math.max(3, Math.min(22, gy));
        for (let k = 0; k < 5 && laneDist(gx, gy) < minD; k++) {
            gx = Math.max(3, Math.min(22, gx + NORM_X * side * 0.6));
            gy = Math.max(3, Math.min(22, gy + NORM_Y * side * 0.6));
        }
        return { x: gx, y: gy };
    };
    const snagSpots: Array<Pt & { s: number }> = [
        { ...placeOffLane(0.52 + layout() * 0.1, 1, 3.9 + layout() * 1.2, 2.7), s: 1.6 + layout() * 0.2 },
        { ...placeOffLane(0.18 + layout() * 0.12, -1, 3.6 + layout() * 1.4, 2.7), s: 1.15 + layout() * 0.2 },
        { ...placeOffLane(0.8 + layout() * 0.15, 1, 3.8 + layout() * 1.2, 2.7), s: 0.9 + layout() * 0.15 }
    ];
    if (layout() < 0.45) {
        snagSpots.push({ ...placeOffLane(0.38 + layout() * 0.08, -1, 3.2 + layout(), 2.7), s: 0.7 + layout() * 0.14 });
    }
    snagSpots.forEach((spot, i) => {
        put(spot.x, spot.y, (qx, qy) => stormSnag(ctx, qx, qy, spot.s, `s${i}`));
    });

    // knee-high sheared stumps at the lane's edge
    const stumpSpots = [
        placeOffLane(0.3, -1, 2 + layout() * 0.35, 1.9),
        placeOffLane(0.74, 1, 1.95 + layout() * 0.4, 1.9)
    ];
    stumpSpots.forEach((spot, i) => {
        put(spot.x, spot.y, (qx, qy) => shatteredStump(ctx, qx, qy, 1.05 + layout() * 0.35, `t${i}`));
    });

    // ---- young regrowth conifers between the wrecks ----
    const regrow = V.featureRng(ctx, 'dwA:regrow');
    const want = 12 + Math.floor(regrow() * 5);
    const claimed: Pt[] = [...snagSpots, ...stumpSpots];
    let made = 0;
    for (let attempt = 0; attempt < 90 && made < want; attempt++) {
        const gx = 2.8 + regrow() * 19.4;
        const gy = 2.8 + regrow() * 19.4;
        if (laneDist(gx, gy) < 2.5) continue;
        if (claimed.some(a2 => Math.hypot(gx - a2.x, gy - a2.y) < 1.75)) continue;
        claimed.push({ x: gx, y: gy });
        const cs = 0.62 + regrow() * 0.34;
        put(gx, gy, (qx, qy) => V.conifer(ctx, qx, qy, cs));
        made++;
    }

    // ---- two surviving edge trees: the wood continues past the wound ----
    const corners = [[3.7, 4.3], [20.9, 4.9], [3.9, 20.9], [21.1, 20.3]] as const;
    let kept = 0;
    for (const [gx0, gy0] of corners) {
        if (kept >= 2) break;
        const gx = gx0 + (regrow() - 0.5);
        const gy = gy0 + (regrow() - 0.5);
        if (laneDist(gx, gy) < 3.4) continue;
        const cs = 1.3 + regrow() * 0.25;
        put(gx, gy, (qx, qy) => V.conifer(ctx, qx, qy, cs));
        claimed.push({ x: gx, y: gy });
        kept++;
    }
}
