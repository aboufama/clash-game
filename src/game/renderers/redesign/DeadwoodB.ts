import type { WildernessPlotCtx, WildernessPut } from '../WildernessRenderer';
import { WildernessVocabulary } from '../WildernessRenderer';

/**
 * DEADWOOD — design B: "The Blowdown Corridor".
 *
 * One catastrophic storm crossed this country from the west, and every plot
 * tells the same directional story: a swath of windthrow runs across the
 * middle band of the parcel, every giant felled toward the east. Three-four
 * HUGE broken trees carry the composition —
 *   1. an uprooted fallen giant lying full length, torn root plate raised at
 *      its west end over the crater it ripped out of the ground;
 *   2. a base-snapped trunk lying parallel, its splintered stump still
 *      standing where it broke;
 *   3. a towering half-height snag whose crown was torn off and lies just
 *      downwind of it, both break faces showing the same pale heartwood;
 *   4. (some plots) a half-uprooted leaner caught mid-fall.
 * Dead wood is weathered SILVER-GREY (not the old red-brown), so the wrecks
 * read against both lawn and soil at postcard zoom; every break face is warm
 * splintered heartwood; bright young regrowth conifers colonize the sunlit
 * gap between the fallen giants; the unbroken edge of the wood survives
 * along the NW rim. Debris (limbs, bark plates, splinters) lies combed in
 * the wind direction, so even the litter is directional, never noise.
 *
 * Determinism: featureRng(ctx, 'dwB:*') everywhere — same seed, same storm.
 * Fallen trunks run near the grid (1,-1) diagonal (screen-horizontal), which
 * keeps tx+ty nearly constant along their whole length: painter sorting by a
 * mid-trunk anchor is then exact against everything placed off the line.
 */

const V = WildernessVocabulary;

type P = { x: number; y: number };

// ---- weathered-wood palette (silver dead wood + warm heartwood) ----
const WOOD_DARK = 0x655a4c;    // shaded flank of dead trunks
const WOOD_MID = 0x8a7f6d;     // silvered body
const WOOD_LIT = 0xaaa08b;     // NW-lit top strip
const BARK_REMNANT = 0x5c4230; // clinging bark patches
const HEART_LIT = 0xdcc89c;    // fresh splintered heartwood
const HEART_MID = 0xc0a878;    // heartwood half-tone
const HEART_DARK = 0x93744f;   // heartwood shadow
const EARTH_DARK = 0x4a392a;   // torn root-plate earth
const EARTH_MID = 0x6b5844;    // dry crumb around the crater
const SHADOW = 0x172015;       // the file's contact-shadow green-black
const MOSS = 0x6f8049;         // moss saddle accents on dead wood

function lerpP(a: P, b: P, t: number): P {
    return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
}

/** A lying trunk between two grid anchors: tapered silhouette with a lit top
 * strip, shaded belly, bark remnants, cracks, and broken branch stubs. */
function lyingTrunk(
    ctx: WildernessPlotCtx,
    from: { x: number; y: number },
    to: { x: number; y: number },
    buttR: number,
    tipR: number,
    tag: string
) {
    const g = ctx.g;
    const rng = V.featureRng(ctx, `dwB:trunk:${tag}`);
    const a = V.at(ctx, from.x, from.y);
    const b = V.at(ctx, to.x, to.y);
    const steps = 8;
    const spine: P[] = [];
    const radii: number[] = [];
    for (let i = 0; i <= steps; i++) {
        const t = i / steps;
        spine.push(lerpP(a, b, t));
        radii.push(buttR + (tipR - buttR) * t);
    }
    // Ground contact shadow first — one soft strip pooled under the length.
    g.fillStyle(SHADOW, 0.2);
    for (let i = 0; i < steps; i++) {
        const m = lerpP(spine[i], spine[i + 1], 0.5);
        const r = (radii[i] + radii[i + 1]) * 0.5;
        g.fillEllipse(m.x + r * 0.4, m.y + r * 0.72, Math.abs(spine[i + 1].x - spine[i].x) * 1.75, r * 1.5);
    }
    // Body silhouette: top edge raised ~1.7r (a lying cylinder in iso), belly
    // wrapping just below the contact line. Small deterministic wobble keeps
    // the log organic without breaking the straight storm-felled read.
    const top: P[] = [];
    const bottom: P[] = [];
    for (let i = 0; i <= steps; i++) {
        const wob = (rng() - 0.5) * 1.6;
        top.push({ x: spine[i].x, y: spine[i].y - radii[i] * 1.7 + wob });
        bottom.push({ x: spine[i].x, y: spine[i].y + radii[i] * 0.55 + wob * 0.4 });
    }
    V.fillPolygon(g, [...top, ...[...bottom].reverse()], WOOD_MID);
    // Shaded belly band (SE face of the cylinder), darker than the flank so
    // the log reads round at postcard zoom.
    const bellyTop: P[] = spine.map((p, i) => ({ x: p.x, y: p.y - radii[i] * 0.3 }));
    V.fillPolygon(g, [...bellyTop, ...[...bottom].reverse()], 0x584e40);
    // NW-lit top strip, generous.
    const litLow: P[] = spine.map((p, i) => ({ x: p.x, y: p.y - radii[i] * 0.95 }));
    V.fillPolygon(g, [...top, ...[...litLow].reverse()], WOOD_LIT, 0.92);
    // Ground-seat line pins the log to the lawn.
    g.lineStyle(1.8, 0x39402b, 0.55);
    for (let i = 0; i < steps; i++) {
        g.lineBetween(bottom[i].x, bottom[i].y + 1, bottom[i + 1].x, bottom[i + 1].y + 1);
    }
    // One clinging bark remnant — a ragged mid-band patch, never a full ring
    // (full-height patches read as breaks that segment the log).
    {
        const t0 = 0.3 + rng() * 0.3;
        const t1 = t0 + 0.14 + rng() * 0.1;
        const p0 = lerpP(a, b, t0);
        const p1 = lerpP(a, b, t1);
        const r0 = buttR + (tipR - buttR) * t0;
        V.fillPolygon(g, [
            { x: p0.x, y: p0.y - r0 * 1.3 },
            { x: p1.x, y: p1.y - r0 * 1.1 },
            { x: p1.x + 2, y: p1.y - r0 * 0.35 },
            { x: p0.x - 2, y: p0.y - r0 * 0.15 }
        ], BARK_REMNANT, 0.6);
    }
    // Long weathering cracks along the grain.
    g.lineStyle(1.7, WOOD_DARK, 0.85);
    g.lineBetween(
        lerpP(a, b, 0.08).x, lerpP(a, b, 0.08).y - buttR * 0.85,
        lerpP(a, b, 0.9).x, lerpP(a, b, 0.9).y - tipR * 0.8
    );
    g.lineStyle(1.6, 0x574e42, 0.6);
    g.lineBetween(
        lerpP(a, b, 0.2).x, lerpP(a, b, 0.2).y - buttR * 1.35,
        lerpP(a, b, 0.82).x, lerpP(a, b, 0.82).y - tipR * 1.3
    );
    // Broken branch stubs — short splintered spikes off the top and far side.
    const stubs = 3 + Math.floor(rng() * 2);
    for (let k = 0; k < stubs; k++) {
        const t = 0.2 + (k + rng() * 0.5) * (0.68 / stubs);
        const p = lerpP(a, b, t);
        const r = buttR + (tipR - buttR) * t;
        const up = rng() < 0.62;
        const hx = (rng() - 0.5) * 8;
        const hy = up ? -(r * 1.7 + 6 + rng() * 7) : -r * 0.4;
        const sx = up ? p.x + hx : p.x + (rng() < 0.5 ? -1 : 1) * (7 + rng() * 5);
        g.lineStyle(3.2, WOOD_DARK, 1);
        g.lineBetween(p.x, p.y - r * (up ? 1.3 : 0.6), sx, p.y + hy);
        g.lineStyle(1.7, HEART_MID, 0.9);
        g.lineBetween(sx - 1, p.y + hy + 1, sx + 1, p.y + hy - 1);
    }
    // A moss saddle on the shaded side keeps the wreck tied to the lawn.
    const mossAt = lerpP(a, b, 0.3 + rng() * 0.3);
    const mossR = buttR * 0.9;
    g.fillStyle(MOSS, 0.85);
    g.fillEllipse(mossAt.x, mossAt.y - mossR * 1.05, mossR * 2.4, mossR * 0.8);
}

/** The splintered break face of a snapped trunk: a jagged crown of heartwood
 * spikes rising from the break line, drawn around screen point p. */
function splinterCrown(
    ctx: WildernessPlotCtx,
    p: P,
    r: number,
    height: number,
    tag: string
) {
    const g = ctx.g;
    const rng = V.featureRng(ctx, `dwB:splinter:${tag}`);
    const spikes = 4 + Math.floor(rng() * 2);
    for (let i = 0; i < spikes; i++) {
        const t = spikes === 1 ? 0.5 : i / (spikes - 1);
        const bx = p.x - r + t * 2 * r;
        const h = height * (0.45 + rng() * 0.55) * (i === Math.floor(spikes / 2) ? 1.25 : 1);
        const w = r * (0.34 + rng() * 0.2);
        const lean = (rng() - 0.5) * r * 0.5;
        g.fillStyle(HEART_LIT, 1);
        g.fillTriangle(bx - w, p.y + 1, bx + w, p.y + 2, bx + lean, p.y - h);
        g.fillStyle(HEART_DARK, 0.9);
        g.fillTriangle(bx + w * 0.1, p.y + 2, bx + w, p.y + 2, bx + lean + w * 0.2, p.y - h * 0.72);
    }
    // One splinter slab folded down the flank — the storm's violence.
    const side = rng() < 0.5 ? -1 : 1;
    g.fillStyle(HEART_MID, 0.95);
    g.fillTriangle(
        p.x + side * r * 0.75, p.y + 1,
        p.x + side * (r * 0.75 + 4), p.y + 3,
        p.x + side * (r + 5 + rng() * 3), p.y + height * 0.6
    );
}

/** Torn root MASS + crater for the uprooted giant (west end, facing the
 * viewer three-quarters on). Radius values are screen px.
 *
 * NOT a disc: the silhouette is built from 7 gnarled root fingers — tapered,
 * kinked polygons of varying length/thickness erupting from a small ragged
 * earthen heart — with dark clods wedged between their bases, fine rootlets,
 * pale snapped tips, and the torn crater at its foot. The heart polygon is
 * deliberately small (max ~0.7 of the footprint) so the fingers own the
 * outline and nothing reads elliptical at postcard zoom. */
function rootPlate(ctx: WildernessPlotCtx, p: P, rx: number, ry: number, tag: string) {
    const g = ctx.g;
    const rng = V.featureRng(ctx, `dwB:rootplate:${tag}`);
    const cy = p.y - ry * 0.12; // raised centre of the root mass
    // Helper: a point at unit-radius u, angle a on the plate's screen ellipse.
    const pt = (u: number, a: number): P => ({
        x: p.x + Math.cos(a) * rx * 1.05 * u,
        y: cy + Math.sin(a) * ry * u
    });
    // --- the crater the mass ripped out of the lawn, just west: a torn-edge
    // polygon (never an oval) with a darker pit and a dry crumb lip.
    {
        const cx0 = p.x - rx * 1.2;
        const cy0 = p.y + ry * 0.44;
        const rim: P[] = [];
        const n = 12;
        for (let i = 0; i < n; i++) {
            const ang = (i / n) * Math.PI * 2;
            const wob = 1 + (rng() - 0.5) * 0.55;
            rim.push({
                x: cx0 + Math.cos(ang) * rx * 1.28 * wob,
                y: cy0 + Math.sin(ang) * ry * 0.46 * wob
            });
        }
        V.fillPolygon(g, rim, EARTH_DARK, 0.9);
        const pit: P[] = rim.map(q => ({
            x: cx0 + (q.x - cx0) * 0.58 - rx * 0.14,
            y: cy0 + (q.y - cy0) * 0.55 + 1
        }));
        V.fillPolygon(g, pit, 0x33271c, 0.88);
        g.fillStyle(EARTH_MID, 0.75);
        g.fillEllipse(cx0 - rx * 0.95, cy0 + ry * 0.16, rx * 1.05, ry * 0.38);
    }
    // Contact shadow under the raised mass.
    g.fillStyle(SHADOW, 0.24);
    g.fillEllipse(p.x + rx * 0.2, p.y + ry * 0.5, rx * 2.6, ry * 0.7);
    // --- pick the fingers first so the heart can bite in between them.
    type Finger = { ang: number; tipU: number; w: number; kink: number };
    const fingers: Finger[] = [];
    const nF = 7;
    for (let i = 0; i < nF; i++) {
        // Sweep skips the bottom sector (ground contact); the trunk butt
        // (drawn after) covers the east side anyway.
        const ang = Math.PI * (0.68 + (i / (nF - 1)) * 1.64) + (rng() - 0.5) * 0.22;
        fingers.push({
            ang,
            tipU: 0.92 + rng() * 0.42,
            w: 4.2 + rng() * 4.2,
            kink: (rng() - 0.5) * 0.85
        });
    }
    // One dominant snapped leader up top — the mast root.
    fingers[Math.floor(nF / 2)].tipU = 1.34;
    fingers[Math.floor(nF / 2)].w = 8;
    // --- the ragged earthen heart: small, heavily wobbled, swelling slightly
    // toward each finger base and biting deep between them.
    const heart: P[] = [];
    const hn = 20;
    for (let i = 0; i < hn; i++) {
        const ang = (i / hn) * Math.PI * 2;
        let u = 0.5 + (rng() - 0.5) * 0.24;
        for (const f of fingers) {
            const d = Math.abs(Math.atan2(Math.sin(ang - f.ang), Math.cos(ang - f.ang)));
            if (d < 0.34) u += 0.16 * (1 - d / 0.34);
        }
        heart.push(pt(u, ang));
    }
    V.fillPolygon(g, heart, EARTH_MID);
    const core: P[] = heart.map(d => ({
        x: p.x + (d.x - p.x) * 0.66,
        y: cy + (d.y - cy) * 0.66
    }));
    V.fillPolygon(g, core, 0x3d2e20);
    // --- clods of earth wedged between finger bases (and two shaken loose
    // below, falling toward the crater).
    for (let i = 0; i < nF - 1; i++) {
        if (rng() < 0.3) continue;
        const midA = (fingers[i].ang + fingers[i + 1].ang) / 2 + (rng() - 0.5) * 0.1;
        const c = pt(0.6 + rng() * 0.18, midA);
        const s = 3.5 + rng() * 3.5;
        V.fillPolygon(g, [
            { x: c.x - s, y: c.y + (rng() - 0.5) * 2 },
            { x: c.x - s * 0.3, y: c.y - s * 0.8 },
            { x: c.x + s * 0.9, y: c.y - s * 0.25 },
            { x: c.x + s * 0.5, y: c.y + s * 0.7 }
        ], rng() < 0.5 ? EARTH_DARK : 0x54402e, 0.95);
    }
    g.fillStyle(EARTH_DARK, 0.9);
    g.fillEllipse(p.x - rx * 0.7, p.y + ry * 0.34, 4.5, 3.4);
    g.fillEllipse(p.x - rx * 0.2, p.y + ry * 0.52, 3.4, 2.6);
    // --- fine hair rootlets between the majors, drooping under gravity.
    g.lineStyle(1.5, 0x6b4f36, 0.9);
    for (let i = 0; i < 6; i++) {
        const a = Math.PI * (0.7 + rng() * 1.6);
        const q0 = pt(0.5, a);
        const q1 = pt(0.72 + rng() * 0.16, a + (rng() - 0.5) * 0.3);
        g.lineBetween(q0.x, q0.y, q1.x, q1.y + 2 + rng() * 3);
    }
    // --- the root fingers themselves: tapered, kinked polygons over the
    // heart, bases buried inside it. These own the silhouette.
    for (const f of fingers) {
        const base = pt(0.26, f.ang);
        const mid = pt(0.66, f.ang + f.kink * 0.45);
        const tip = pt(f.tipU, f.ang + f.kink);
        const norm = (a: P, b: P) => {
            const dx = b.x - a.x, dy = b.y - a.y;
            const L = Math.hypot(dx, dy) || 1;
            return { x: -dy / L, y: dx / L };
        };
        const n1 = norm(base, mid);
        const n2 = norm(mid, tip);
        const wb = f.w, wm = f.w * 0.55, wt = 1.4;
        // Body a notch lighter than the earth so the fingers separate from
        // the heart at postcard zoom.
        V.fillPolygon(g, [
            { x: base.x + n1.x * wb, y: base.y + n1.y * wb },
            { x: mid.x + n2.x * wm, y: mid.y + n2.y * wm },
            { x: tip.x + n2.x * wt, y: tip.y + n2.y * wt },
            { x: tip.x - n2.x * wt, y: tip.y - n2.y * wt },
            { x: mid.x - n2.x * wm, y: mid.y - n2.y * wm },
            { x: base.x - n1.x * wb, y: base.y - n1.y * wb }
        ], 0x6a4f37);
        // Shaded underside keeps the finger round.
        g.lineStyle(1.6, 0x46331f, 0.9);
        g.lineBetween(
            mid.x - n2.x * wm * 0.75, mid.y - n2.y * wm * 0.75,
            tip.x - n2.x * wt, tip.y - n2.y * wt
        );
        // A short fork on strongly kinked fingers — gnarl, not a spoke.
        if (Math.abs(f.kink) > 0.28) {
            const fa = f.ang - f.kink * 1.3;
            const fTip = pt(f.tipU * 0.72, fa);
            const n3 = norm(mid, fTip);
            const wf = wm * 0.6;
            V.fillPolygon(g, [
                { x: mid.x + n3.x * wf, y: mid.y + n3.y * wf },
                { x: fTip.x, y: fTip.y },
                { x: mid.x - n3.x * wf, y: mid.y - n3.y * wf }
            ], 0x5e4632);
        }
        // NW light along the upper edge of up/left-facing fingers.
        if (Math.sin(f.ang) < 0.25) {
            g.lineStyle(2.1, 0x9b8668, 0.85);
            g.lineBetween(
                mid.x + n2.x * wm * 0.7, mid.y + n2.y * wm * 0.7,
                tip.x + n2.x * wt, tip.y + n2.y * wt
            );
        }
        // Pale snapped tip on most fingers — torn live wood.
        if (rng() < 0.8) {
            g.fillStyle(HEART_LIT, 1);
            g.fillTriangle(
                tip.x + n2.x * (wt + 1.4), tip.y + n2.y * (wt + 1.4),
                tip.x - n2.x * (wt + 1.4), tip.y - n2.y * (wt + 1.4),
                tip.x + (tip.x - mid.x) * 0.18, tip.y + (tip.y - mid.y) * 0.18
            );
        }
    }
    // --- short torn stubs on the heart's face + clinging stones.
    g.lineStyle(2, 0x7d6248, 0.85);
    for (let i = 0; i < 4; i++) {
        const a = rng() * Math.PI * 2;
        const q = pt(0.2 + rng() * 0.24, a);
        g.lineBetween(q.x, q.y, q.x + (rng() - 0.5) * 7, q.y + 4 + rng() * 5);
    }
    g.fillStyle(0x8d9198, 0.95);
    g.fillEllipse(p.x - rx * 0.3, p.y - ry * 0.05, 4.6, 3.2);
    g.fillEllipse(p.x + rx * 0.34, p.y + ry * 0.3, 3.6, 2.6);
}

/** The half-height standing snag: a huge silvered tower snapped mid-height,
 * splintered crown, one surviving dead branch, root flare. */
function brokenSnagTower(ctx: WildernessPlotCtx, tx: number, ty: number, h: number, r: number, tag: string) {
    const g = ctx.g;
    const p = V.at(ctx, tx, ty);
    const rng = V.featureRng(ctx, `dwB:snag:${tag}`);
    g.fillStyle(SHADOW, 0.22);
    g.fillEllipse(p.x + r * 0.5, p.y + 4, r * 4.6, r * 1.6);
    // Root flare.
    g.lineStyle(4.4, WOOD_DARK, 1);
    g.lineBetween(p.x - r * 0.5, p.y - 2, p.x - r * 1.7, p.y + 4);
    g.lineBetween(p.x + r * 0.5, p.y - 2, p.x + r * 1.8, p.y + 3.4);
    // Tapered shaft: lit west face / shaded east face.
    const topR = r * 0.62;
    const breakY = p.y - h;
    const lean = (rng() - 0.5) * r * 0.5;
    V.fillPolygon(g, [
        { x: p.x - r, y: p.y + 1.5 },
        { x: p.x + lean - topR, y: breakY },
        { x: p.x + lean + topR, y: breakY + 2 },
        { x: p.x + r, y: p.y + 2.5 }
    ], WOOD_MID);
    V.fillPolygon(g, [
        { x: p.x + lean + topR * 0.1, y: breakY + 1 },
        { x: p.x + lean + topR, y: breakY + 2 },
        { x: p.x + r, y: p.y + 2.5 },
        { x: p.x + r * 0.15, y: p.y + 2 }
    ], WOOD_DARK);
    V.fillPolygon(g, [
        { x: p.x - r, y: p.y + 1.5 },
        { x: p.x + lean - topR, y: breakY },
        { x: p.x + lean - topR * 0.45, y: breakY + 1 },
        { x: p.x - r * 0.55, y: p.y + 1.5 }
    ], WOOD_LIT, 0.85);
    // Bark remnant plates and weathering checks on the shaft.
    V.fillPolygon(g, [
        { x: p.x - r * 0.35, y: p.y - h * 0.18 },
        { x: p.x + r * 0.25, y: p.y - h * 0.26 },
        { x: p.x + r * 0.3, y: p.y - h * 0.6 },
        { x: p.x - r * 0.2, y: p.y - h * 0.52 }
    ], BARK_REMNANT, 0.85);
    g.lineStyle(1.7, WOOD_DARK, 0.8);
    g.lineBetween(p.x + lean * 0.5 - r * 0.1, breakY + 4, p.x - r * 0.28, p.y - 2);
    g.lineBetween(p.x + lean * 0.5 + r * 0.42, breakY + h * 0.3, p.x + r * 0.5, p.y - 1);
    // A woodpecker hollow — dead standing wood is habitat.
    g.fillStyle(0x2c231a, 0.95);
    g.fillEllipse(p.x - r * 0.12, p.y - h * 0.68, 4.4, 6);
    // One surviving dead branch reaching downwind (east).
    g.lineStyle(3.6, WOOD_DARK, 1);
    g.lineBetween(p.x + lean + topR * 0.3, breakY + h * 0.2, p.x + r * 2.6, breakY + h * 0.06);
    g.lineStyle(2, WOOD_MID, 1);
    g.lineBetween(p.x + r * 2.6, breakY + h * 0.06, p.x + r * 3.4, breakY + h * 0.14);
    // The splintered break crown.
    splinterCrown(ctx, { x: p.x + lean, y: breakY }, topR, r * 2.4, tag);
    // Moss on the shaded north foot.
    g.fillStyle(MOSS, 0.8);
    g.fillEllipse(p.x - r * 0.55, p.y - 2.5, r * 1.15, 4);
}

/** A young regrowth conifer — brighter and simpler than the mature vocabulary
 * pine, so the new generation reads as NEW at postcard zoom. */
function sapling(ctx: WildernessPlotCtx, tx: number, ty: number, s: number, tag: string) {
    const g = ctx.g;
    const p = V.at(ctx, tx, ty);
    const rng = V.featureRng(ctx, `dwB:sapling:${tag}`);
    const h = (26 + rng() * 10) * s;
    g.fillStyle(SHADOW, 0.18);
    g.fillEllipse(p.x + 2 * s, p.y + 2 * s, 18 * s, 6 * s);
    g.lineStyle(2.8 * s, 0x6b4f33, 1);
    g.lineBetween(p.x, p.y + 1, p.x, p.y - h * 0.4);
    const tiers = [
        { y: -h * 0.24, w: 13 * s, hh: h * 0.46, c: 0x2f5b2c },
        { y: -h * 0.6, w: 9.5 * s, hh: h * 0.44, c: 0x4a8a3e },
        { y: -h * 0.94, w: 6 * s, hh: h * 0.38, c: 0x6fb254 }
    ];
    for (const tier of tiers) {
        const leanT = (rng() - 0.5) * 2.4 * s;
        g.fillStyle(tier.c, 1);
        g.fillTriangle(
            p.x - tier.w, p.y + tier.y,
            p.x + tier.w * 0.92, p.y + tier.y + 1.2 * s,
            p.x + leanT, p.y + tier.y - tier.hh
        );
        g.fillStyle(0x11301c, 0.2);
        g.fillTriangle(
            p.x + leanT, p.y + tier.y - tier.hh,
            p.x + tier.w * 0.92, p.y + tier.y + 1.2 * s,
            p.x + 1 * s, p.y + tier.y - 1.5 * s
        );
    }
    // Fresh leader tip.
    g.fillStyle(0xa8e884, 1);
    g.fillTriangle(p.x - 2.6 * s, p.y - h * 1.18, p.x + 2.6 * s, p.y - h * 1.18, p.x, p.y - h * 1.42);
}

/** A surviving edge conifer with its top snapped out — storm-bitten but alive. */
function toppedConifer(ctx: WildernessPlotCtx, tx: number, ty: number, s: number, tag: string) {
    const g = ctx.g;
    const p = V.at(ctx, tx, ty);
    const rng = V.featureRng(ctx, `dwB:topped:${tag}`);
    g.fillStyle(SHADOW, 0.2);
    g.fillEllipse(p.x + 5 * s, p.y + 4 * s, 32 * s, 10 * s);
    V.fillPolygon(g, [
        { x: p.x - 3.4 * s, y: p.y + 1.5 * s },
        { x: p.x - 2 * s, y: p.y - 30 * s },
        { x: p.x + 2.2 * s, y: p.y - 30 * s },
        { x: p.x + 4.2 * s, y: p.y + 1.5 * s }
    ], 0x573820);
    const tiers = [
        { y: -10, w: 34, h: 19 },
        { y: -21, w: 27, h: 19 }
    ];
    const tones = [0x203f25, 0x2c5730];
    for (let i = 0; i < tiers.length; i++) {
        const tier = tiers[i];
        const baseY = p.y + tier.y * s;
        const apexX = p.x + (rng() - 0.5) * 2.6 * s;
        g.fillStyle(tones[i], 1);
        g.fillTriangle(p.x - tier.w * 0.56 * s, baseY, p.x + tier.w * 0.5 * s, baseY + 1.4 * s, apexX, baseY - tier.h * s);
        g.fillStyle(0x0f2e24, 0.22);
        g.fillTriangle(apexX, baseY - tier.h * s, p.x + tier.w * 0.5 * s, baseY + 1.4 * s, p.x + 1.5 * s, baseY - 2 * s);
    }
    // Where the leader snapped out: a bare spike of pale wood above the crown.
    g.lineStyle(3 * s, WOOD_MID, 1);
    g.lineBetween(p.x, p.y - 28 * s, p.x + 1.5 * s, p.y - 40 * s);
    g.fillStyle(HEART_LIT, 1);
    g.fillTriangle(p.x - 1.6 * s, p.y - 39 * s, p.x + 4 * s, p.y - 39 * s, p.x + 1.5 * s, p.y - 45 * s);
    // The dropped top lies at the foot, downwind.
    g.lineStyle(3.4 * s, 0x3a5a33, 0.95);
    g.lineBetween(p.x + 8 * s, p.y + 3 * s, p.x + 20 * s, p.y + 5.5 * s);
    g.fillStyle(0x2c5730, 0.95);
    g.fillTriangle(p.x + 18 * s, p.y + 1 * s, p.x + 24 * s, p.y + 6 * s, p.x + 14 * s, p.y + 7 * s);
}

/** Ground litter combed in the wind direction: limbs, bark plates, splinter
 * shards. Drawn on the ground layer (flat), concentrated along the corridor. */
function windLitter(ctx: WildernessPlotCtx, cx: number, cy: number, spread: number, n: number, tag: string) {
    const g = ctx.g;
    const rng = V.featureRng(ctx, `dwB:litter:${tag}`);
    for (let i = 0; i < n; i++) {
        const gx = cx + (rng() - 0.5) * spread;
        const gy = cy + (rng() - 0.5) * spread * 0.7;
        const p = V.at(ctx, gx, gy);
        const kind = rng();
        // Wind axis ≈ screen-horizontal (grid 1,-1), jittered ±20°.
        const ang = (rng() - 0.5) * 0.7;
        const len = 7 + rng() * 9;
        const dx = Math.cos(ang) * len;
        const dy = Math.sin(ang) * len * 0.5;
        if (kind < 0.55) {
            // A downed limb.
            g.lineStyle(2.4 + rng() * 1.2, rng() < 0.5 ? WOOD_DARK : 0x74695a, 0.95);
            g.lineBetween(p.x - dx, p.y - dy, p.x + dx, p.y + dy);
        } else if (kind < 0.8) {
            // A bark plate.
            V.fillPolygon(g, [
                { x: p.x - dx * 0.6, y: p.y - dy * 0.6 - 2 },
                { x: p.x + dx * 0.5, y: p.y + dy * 0.5 - 1.5 },
                { x: p.x + dx * 0.6, y: p.y + dy * 0.6 + 2 },
                { x: p.x - dx * 0.5, y: p.y - dy * 0.5 + 2 }
            ], BARK_REMNANT, 0.8);
        } else {
            // A pale splinter shard.
            g.fillStyle(HEART_MID, 0.9);
            g.fillTriangle(p.x - dx * 0.5, p.y - dy * 0.5, p.x + dx * 0.5, p.y + dy * 0.5, p.x + dy, p.y - dx * 0.28);
        }
    }
}

/**
 * The place() fn — deadwood design B.
 */
export function drawDeadwoodB(ctx: WildernessPlotCtx, put: WildernessPut): void {
    const layout = V.featureRng(ctx, 'dwB:layout');
    const jx = (layout() - 0.5) * 1.6; // whole-composition jitter, tiles
    const jy = (layout() - 0.5) * 1.4;
    const hasSecondLog = layout() < 0.82;
    const fringeCount = 5 + Math.floor(layout() * 3);

    // ---- ground story (paints first) ----
    // The corridor: dry duff and sun-bleach where the canopy came down.
    V.groundPatch(ctx, 8.4 + jx, 13.6 + jy, 4.6, 3.2, 0x8a7a55, 0.26, 'dwB-duff-west');
    V.groundPatch(ctx, 17.3 + jx, 9.2 + jy, 4, 2.8, 0x84744f, 0.24, 'dwB-duff-east');
    V.groundPatch(ctx, 13.4 + jx, 16.9 + jy, 3.4, 2.4, 0x9a9a58, 0.24, 'dwB-bleach-gap');
    // The surviving wood's cool shade along the NW rim.
    V.groundPatch(ctx, 7, 4.2, 5.6, 3.2, 0x39512f, 0.24, 'dwB-fringe-shade');
    // Combed litter along the swath.
    windLitter(ctx, 10 + jx, 13.5 + jy, 8, 10, 'west');
    windLitter(ctx, 16 + jx, 10 + jy, 7, 8, 'east');
    windLitter(ctx, 14 + jx, 17 + jy, 7, 6, 'south');

    // ---- hero 1: the uprooted fallen giant (root plate west, tip east) ----
    // Runs along grid (1,-1): screen-horizontal, constant tx+ty → exact sort.
    // Length ≈ 2.5× the tallest standing conifer — a felled GIANT, not a rail.
    const g1root = { x: 6.6 + jx, y: 15.4 + jy };
    const g1tip = { x: 10.3 + jx, y: 11.7 + jy };
    put((g1root.x + g1tip.x) / 2, (g1root.y + g1tip.y) / 2, () => {
        rootPlate(ctx, V.at(ctx, g1root.x - 0.42, g1root.y + 0.42), 23, 34, 'hero');
        lyingTrunk(ctx, g1root, g1tip, 18, 10.5, 'hero');
        // Splintered crown break at the tip — the giant lost its head downwind.
        const tip = V.at(ctx, g1tip.x, g1tip.y);
        ctx.g.fillStyle(HEART_LIT, 1);
        ctx.g.fillEllipse(tip.x + 2, tip.y - 8, 10, 17);
        ctx.g.fillStyle(HEART_DARK, 0.8);
        ctx.g.fillEllipse(tip.x + 3, tip.y - 7, 5.5, 10);
        splinterCrown(ctx, { x: tip.x + 3, y: tip.y - 8 }, 8, 16, 'hero-tip');
    });

    // ---- hero 3: the standing snapped snag + its torn-off crown ----
    const snagX = 16.6 + jx * 0.5;
    const snagY = 8.6 + jy * 0.5;
    put(snagX, snagY, (ax, ay) => brokenSnagTower(ctx, ax, ay, 78, 14.5, 'tower'));
    // The crown lies just downwind: a trunk section whose butt shows the
    // matching heartwood face turned back toward the snag.
    const crownButt = { x: snagX + 1.3, y: snagY - 1.1 };
    const crownTip = { x: snagX + 4.3, y: snagY - 4.1 };
    put(crownButt.x + 0.6, crownButt.y + 0.2, () => {
        lyingTrunk(ctx, crownButt, crownTip, 9.5, 5.5, 'crown');
        const butt = V.at(ctx, crownButt.x, crownButt.y);
        // Break face disc, pale, facing west back toward its stump.
        ctx.g.fillStyle(HEART_LIT, 1);
        ctx.g.fillEllipse(butt.x - 3, butt.y - 8, 11, 16);
        ctx.g.fillStyle(HEART_DARK, 0.85);
        ctx.g.fillEllipse(butt.x - 2, butt.y - 7.2, 6, 9.5);
        // Dead branch tangle at the crown end — chunky silhouette masses with
        // a few heavy limbs, never a fan of threads.
        const tip = V.at(ctx, crownTip.x, crownTip.y);
        const tangleRng = V.featureRng(ctx, 'dwB:tangle');
        for (let i = 0; i < 3; i++) {
            const ang = -1.1 + i * 0.75 + (tangleRng() - 0.5) * 0.3;
            ctx.g.lineStyle(3.4, WOOD_DARK, 1);
            ctx.g.lineBetween(tip.x, tip.y - 5,
                tip.x + Math.cos(ang) * (15 + tangleRng() * 8),
                tip.y - 5 + Math.sin(ang) * (11 + tangleRng() * 5));
        }
        ctx.g.fillStyle(0x6d6553, 1);
        ctx.g.fillTriangle(tip.x + 2, tip.y - 14, tip.x + 20, tip.y - 9, tip.x + 8, tip.y + 1);
        ctx.g.fillStyle(0x7d7460, 0.9);
        ctx.g.fillTriangle(tip.x - 3, tip.y - 9, tip.x + 12, tip.y - 18, tip.x + 10, tip.y - 4);
    });

    // ---- hero 2: the base-snapped parallel trunk (some plots skip it) ----
    if (hasSecondLog) {
        const stumpAt = { x: 11.6 + jx, y: 19.6 + jy };
        const g2root = { x: 12.7 + jx, y: 18.5 + jy };
        const g2tip = { x: 16.2 + jx, y: 15 + jy };
        put(stumpAt.x + 0.4, stumpAt.y - 0.4, () => {
            // The standing splinter stump where it broke.
            const sp = V.at(ctx, stumpAt.x, stumpAt.y);
            ctx.g.fillStyle(SHADOW, 0.2);
            ctx.g.fillEllipse(sp.x + 3, sp.y + 4, 38, 13);
            V.fillPolygon(ctx.g, [
                { x: sp.x - 11, y: sp.y + 3 },
                { x: sp.x - 9, y: sp.y - 23 },
                { x: sp.x + 8, y: sp.y - 22 },
                { x: sp.x + 11.5, y: sp.y + 3.5 }
            ], WOOD_MID);
            V.fillPolygon(ctx.g, [
                { x: sp.x + 0.5, y: sp.y + 3 },
                { x: sp.x + 8, y: sp.y - 22 },
                { x: sp.x + 11.5, y: sp.y + 3.5 }
            ], WOOD_DARK);
            splinterCrown(ctx, { x: sp.x - 0.5, y: sp.y - 22 }, 9, 20, 'stump');
            // The felled shaft beyond, butt splinters facing its stump.
            lyingTrunk(ctx, g2root, g2tip, 13.5, 8, 'second');
            const butt = V.at(ctx, g2root.x, g2root.y);
            splinterCrown(ctx, { x: butt.x - 4, y: butt.y - 7 }, 7, 14, 'second-butt');
        });
    }


    // ---- the surviving NW fringe: the wood that still stands ----
    const fringe = V.featureRng(ctx, 'dwB:fringe');
    const fringeSpots: Array<[number, number]> = [
        [3.8, 3.4], [6.6, 2.6], [9.4, 3.9], [12.6, 3], [4.6, 6.6],
        [18.6, 4.1], [21.2, 6.4], [2.8, 12.4]
    ];
    for (let i = 0; i < fringeCount; i++) {
        const [fx, fy] = fringeSpots[i % fringeSpots.length];
        const tx = fx + (fringe() - 0.5) * 0.8;
        const ty = fy + (fringe() - 0.5) * 0.8;
        const scale = 1.25 + fringe() * 0.45;
        put(tx, ty, (ax, ay) => V.conifer(ctx, ax, ay, scale));
    }
    // One storm-bitten survivor with its top snapped out, at the fringe's edge.
    put(14.9, 4.6, (ax, ay) => toppedConifer(ctx, ax, ay, 1.3, 'edge'));

    // ---- regrowth: bright young conifers colonizing the sunlit gap ----
    const grow = V.featureRng(ctx, 'dwB:regrowth');
    const gapCluster: Array<[number, number]> = [
        [10.4, 16.2], [12.3, 15.1], [13.6, 16.9], [11.5, 17.8], [14.8, 15.6]
    ];
    const gapCount = 3 + Math.floor(grow() * 3);
    for (let i = 0; i < gapCount; i++) {
        const [sx, sy] = gapCluster[i % gapCluster.length];
        const tx = sx + jx + (grow() - 0.5) * 1.1;
        const ty = sy + jy + (grow() - 0.5) * 1.1;
        put(tx, ty, (ax, ay) => sapling(ctx, ax, ay, 1.05 + grow() * 0.5, `gap-${i}`));
    }
    const eastCluster: Array<[number, number]> = [[19.6, 13.4], [21.2, 12.1], [20.4, 15.2]];
    const eastCount = 2 + Math.floor(grow() * 2);
    for (let i = 0; i < eastCount; i++) {
        const [sx, sy] = eastCluster[i % eastCluster.length];
        put(sx + (grow() - 0.5), sy + (grow() - 0.5),
            (ax, ay) => sapling(ctx, ax, ay, 0.9 + grow() * 0.45, `east-${i}`));
    }
    // Two lone pioneers by the crater — life returning right at the wound.
    put(3.9 + jx, 13.9 + jy, (ax, ay) => sapling(ctx, ax, ay, 1, 'pioneer-a'));
    put(5.4 + jx, 18.4 + jy, (ax, ay) => sapling(ctx, ax, ay, 1.2, 'pioneer-b'));

    // ---- supporting geology + vocabulary furniture ----
    put(20.6, 17.6, (ax, ay) => V.boulder(ctx, ax, ay, 0.95));
    put(4.9, 11.3, (ax, ay) => V.boulder(ctx, ax, ay, 0.7));
    put(17.2 + jx, 19.9, (ax, ay) => V.stump(ctx, ax, ay));
    V.scatterRocks(ctx, 15.5, 13.5, 12, 7);
}
