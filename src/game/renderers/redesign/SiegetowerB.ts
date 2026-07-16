import type Phaser from 'phaser';

/**
 * SIEGE TOWER — clean-room design B: "The Belfry".
 *
 * A tall three-tier timber belfry on four solid oak wheels:
 *   - a heavy wheeled chassis (axles, strapping, wedge chocks),
 *   - a stitched-hide-armored middle tier (draped skirts, patched, with old
 *     arrow stubs still buried in the leather),
 *   - a crenellated fighting crown with a red pennant and the raised
 *     drop-ramp standing over the front bay like a drawbridge.
 *
 * MOTION CONTRACT (all deterministic f(time) — iron rule 3):
 *   - WALK: one exact 700 ms stride (STRIDE_MS — must equal
 *     TROOP_PARAMS.siegetower.stride in bake-sprites.mjs). Wheels turn one
 *     full revolution per stride (bolt ring), the hull judders twice and
 *     rocks once per stride, hides and pennant stream on stride harmonics —
 *     the loop closes seamlessly at 700 ms.
 *   - IDLE (rolling paused or parked): pennant wave + hide sway on an exact
 *     2000 ms period (IDLE_MS, a 250 ms multiple); tip swings ±2.6 px and
 *     hems ±1.5 px, past the bake probe's quantization thresholds.
 *   - NO attack. THE DRIVER IS THE HERO — `driver` = parked01 (0 rolling →
 *     1 parked): the hull settles onto its axles and nods (0→0.55), the
 *     wheel chocks drop (0.12→0.47), and the crown ramp unlatches and falls
 *     in a gravity arc (slow release, accelerating drop) toward the facing
 *     direction, landing with a small rebound as a solid plank bridge whose
 *     tip rests at wall height (~h16 — game walls cap at h15–20).
 *
 * LEVELS: L1 humble raw timber + rope strapping; L2 iron — tyres, straps,
 * merlon caps, hem studs, iron ramp lip; L3 refined — warm sandstone parapet
 * caps, gold finial/hubs/studs and a gold ramp lip, white hairline + gold
 * tail on the pennant (accents only, never masses).
 *
 * Direction-aware: every shape is built from the facing angle via the iso
 * toolkit (along = cos/sin·0.5, across = -sin/cos·0.5), so all 8 bake
 * headings read true; box faces are chosen/lit per heading (rotation-proof).
 */

type G = Phaser.GameObjects.Graphics;
type Pt = [number, number];

/** Walk gait — ONE exact stride period. Keep TROOP_PARAMS in sync. */
const STRIDE_MS = 700;
/** Idle loop — exact 250 ms multiple; all idle terms are harmonics of it. */
const IDLE_MS = 2000;

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);
const smooth01 = (t: number): number => {
    const c = clamp01(t);
    return c * c * (3 - 2 * c);
};

function shade(c: number, m: number): number {
    const r = Math.max(0, Math.min(255, Math.round(((c >> 16) & 0xff) * m)));
    const g = Math.max(0, Math.min(255, Math.round(((c >> 8) & 0xff) * m)));
    const b = Math.max(0, Math.min(255, Math.round((c & 0xff) * m)));
    return (r << 16) | (g << 8) | b;
}

/** One vertical face of a facing-oriented box: screen normal + the unit
 *  (d, w) corner multipliers of its two bottom corners. */
interface TowerFace {
    nsx: number;
    nsy: number;
    u0: [number, number];
    u1: [number, number];
}

export function drawSiegetowerB(
    graphics: Phaser.GameObjects.Graphics,
    isPlayer: boolean,
    isMoving: boolean,
    facingAngle: number,
    troopLevel: number,
    time: number,
    _attackAge: number,
    _attackDelay: number,
    driver: number
): void {
    const g: G = graphics;
    const lvl = Math.max(1, Math.min(3, Math.floor(troopLevel) || 1));
    const a = facingAngle || 0;
    const ca = Math.cos(a);
    const sn = Math.sin(a);
    const GY = 9.5; // troop ground line (villager convention)

    // ---------------- iso projection (along/across the facing) ----------------
    const P = (d: number, w: number, h: number): Pt =>
        [ca * d - sn * w, GY + (sn * d + ca * w) * 0.5 - h];

    // ---------------- motion drivers ----------------
    const park = clamp01(driver);
    const rolling = isMoving && park < 0.35;
    const walkPh = ((time % STRIDE_MS) / STRIDE_MS) * Math.PI * 2;
    const idlePh = ((time % IDLE_MS) / IDLE_MS) * Math.PI * 2;
    const bob = rolling ? Math.sin(walkPh * 2) * 0.7 : 0;        // cobble judder, 2/stride
    const rockPitch = rolling ? Math.sin(walkPh) * 0.075 : 0;    // ponderous nose rock, 1/stride
    const settle = smooth01(park / 0.4) * 1.7;                   // hull sits onto its axles
    const dip = Math.sin(Math.PI * clamp01(park / 0.55)) * 1.0;  // parking nod, recovers by park≈0.55
    const chock01 = smooth01((park - 0.12) / 0.35);              // wedge chocks drop
    const bodyH = (d: number, h: number): number =>
        h - settle - dip * 0.3 + bob - (rockPitch + dip * 0.075) * d;
    const PB = (d: number, w: number, h: number): Pt => P(d, w, bodyH(d, h));
    /** Cloth sway (screen px): stride-locked when rolling, IDLE_MS otherwise. */
    const sway = (k: number): number =>
        rolling ? Math.sin(walkPh + k * 1.9) * 1.6 : Math.sin(idlePh + k * 1.9) * 1.5;

    // ---------------- palette ----------------
    const own = isPlayer ? 1 : 0.84;               // enemy timber darkens (troop convention)
    const WOOD = shade(0x9a7b4f, own);
    const HIDE = shade(isPlayer ? 0x75533a : 0x6a4c38, 1); // saddle leather — reads apart from the timber
    const stitchCol = 0xd9c9a8;
    const iron = 0x5a5f66;
    const ironLit = 0x7d838c;
    const gold = 0xdaa520;
    const sand = 0xbfb49a;
    const redLit = isPlayer ? 0xc0392b : 0x9a2b22; // the red pennant (enemy: deep crimson)
    const redDark = shade(redLit, 0.7);

    // ---------------- draw helpers ----------------
    const poly = (pts: Pt[], color: number, alpha = 1): void => {
        g.fillStyle(color, alpha);
        g.beginPath();
        g.moveTo(pts[0][0], pts[0][1]);
        for (let i = 1; i < pts.length; i++) g.lineTo(pts[i][0], pts[i][1]);
        g.closePath();
        g.fillPath();
    };
    const seg = (p0: Pt, p1: Pt, w: number, color: number): void => {
        g.lineStyle(w, color, 1);
        g.lineBetween(p0[0], p0[1], p1[0], p1[1]);
    };

    // The four vertical faces of any facing-oriented box (rotation-proof:
    // painter-sorted by down-screen normal, lit by west-facing component).
    const FACES: TowerFace[] = [
        { nsx: ca, nsy: sn * 0.5, u0: [1, 1], u1: [1, -1] },      // front (+d, toward facing)
        { nsx: -ca, nsy: -sn * 0.5, u0: [-1, -1], u1: [-1, 1] },  // back
        { nsx: -sn, nsy: ca * 0.5, u0: [-1, 1], u1: [1, 1] },     // +w side
        { nsx: sn, nsy: -ca * 0.5, u0: [1, -1], u1: [-1, -1] }    // -w side
    ];
    const faceShade = (f: TowerFace): number => 0.87 - 0.27 * f.nsx;
    const drawBox = (
        dB: number, wB: number, dT: number, wT: number, hB: number, hT: number,
        base: number, T: (d: number, w: number, h: number) => Pt, top: boolean, topShade = 1.28
    ): void => {
        const fs = [...FACES].sort((x, y) => x.nsy - y.nsy);
        for (const f of fs) {
            poly([
                T(dB * f.u0[0], wB * f.u0[1], hB),
                T(dB * f.u1[0], wB * f.u1[1], hB),
                T(dT * f.u1[0], wT * f.u1[1], hT),
                T(dT * f.u0[0], wT * f.u0[1], hT)
            ], shade(base, faceShade(f)));
        }
        if (top) {
            poly([T(dT, wT, hT), T(dT, -wT, hT), T(-dT, -wT, hT), T(-dT, wT, hT)], shade(base, topShade));
        }
    };

    // ---------------- wheels + chocks ----------------
    const wheelR = 6;
    const wheelHub = 6;
    const wheelW = 10.8;
    const nearSgn = ca >= 0 ? 1 : -1;               // which w side faces the camera
    const wheelPhase = rolling ? -walkPh : -0.4;     // one revolution per stride; parked = still
    const ring = (d0: number, w0: number, r: number): Pt[] => {
        const pts: Pt[] = [];
        for (let i = 0; i < 12; i++) {
            const th = (i / 12) * Math.PI * 2;
            pts.push(P(d0 + Math.cos(th) * r, w0, wheelHub + Math.sin(th) * r));
        }
        return pts;
    };
    const drawWheel = (d0: number, w0: number, lit: boolean): void => {
        poly(ring(d0, w0, wheelR), shade(0x4a3826, own * (lit ? 1 : 0.8)));
        poly(ring(d0, w0, wheelR * 0.72), shade(WOOD, lit ? 0.95 : 0.72));
        if (lvl >= 2) { // iron tyre
            const rp = ring(d0, w0, wheelR * 0.97);
            g.lineStyle(1.1, lit ? ironLit : iron, 1);
            g.beginPath();
            g.moveTo(rp[0][0], rp[0][1]);
            for (let i = 1; i < rp.length; i++) g.lineTo(rp[i][0], rp[i][1]);
            g.closePath();
            g.strokePath();
        }
        g.fillStyle(lvl >= 3 ? shade(gold, lit ? 1 : 0.75) : shade(0x352818, own), 1);
        for (let k = 0; k < 5; k++) { // rotating bolt ring = the rolling read
            const th = wheelPhase + (k / 5) * Math.PI * 2;
            const bp = P(d0 + Math.cos(th) * wheelR * 0.45, w0, wheelHub + Math.sin(th) * wheelR * 0.45);
            g.fillRect(bp[0] - 0.7, bp[1] - 0.7, 1.4, 1.4);
        }
        const hb = P(d0, w0, wheelHub);
        g.fillStyle(lvl >= 3 ? 0xb08d57 : shade(0x2a2014, own), 1);
        g.fillCircle(hb[0], hb[1], 1.5);
    };
    const drawChock = (d0: number, w0: number, sgnD: number): void => {
        if (chock01 <= 0.02) return;
        const lift = (1 - chock01) * 7; // slides down from the chassis to the ground
        const dC = d0 + sgnD * (wheelR + 0.3);
        poly([
            P(dC, w0, lift),
            P(dC + sgnD * 2.5, w0, lift),
            P(dC, w0, lift + 2.9)
        ], shade(0x5c4832, own));
    };

    // ---------------- the drop-ramp (the hero) ----------------
    const rampL = 26;
    const rampHalfW = 6.2;
    const RAISED = 1.6;      // ~vertical drawbridge over the front bay
    const DEPLOYED = -0.72;  // tip lands at h≈16.7 — wall height
    const deploy = smooth01((park - 0.22) / 0.7);
    let rampAng = RAISED + (DEPLOYED - RAISED) * Math.pow(deploy, 1.45); // gravity: slow release, fast fall
    rampAng += Math.sin(clamp01((park - 0.9) / 0.1) * Math.PI) * 0.06;  // landing rebound
    const hingeD = 10.8;
    const hingeH = 33.8;
    const tipD = hingeD + Math.cos(rampAng) * rampL;
    const tipH = hingeH + Math.sin(rampAng) * rampL;
    const drawRamp = (): void => {
        const e0 = PB(hingeD, rampHalfW, hingeH);
        const e1 = PB(hingeD, -rampHalfW, hingeH);
        const t1 = PB(tipD, -rampHalfW * 0.94, tipH);
        const t0 = PB(tipD, rampHalfW * 0.94, tipH);
        const litT = 0.62 + 0.5 * clamp01((Math.sin(-rampAng) + 1) / 2); // deck lightens as it lies flat
        const at = (p: Pt, q: Pt, t: number): Pt => [p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t];
        // plank thickness: a dark skirt under the down-screen long edge
        const nearEdge: [Pt, Pt] = ca >= 0 ? [e0, t0] : [e1, t1];
        poly([
            nearEdge[0], nearEdge[1],
            [nearEdge[1][0], nearEdge[1][1] + 1.7], [nearEdge[0][0], nearEdge[0][1] + 1.7]
        ], shade(WOOD, litT * 0.42));
        poly([e0, e1, t1, t0], shade(WOOD, litT * 1.06));
        // lengthwise plank seams — the deck reads as a solid plank surface
        seg(at(e0, e1, 0.34), at(t0, t1, 0.34), 0.7, shade(WOOD, litT * 0.88));
        seg(at(e0, e1, 0.67), at(t0, t1, 0.67), 0.7, shade(WOOD, litT * 0.88));
        for (const t of [0.24, 0.44, 0.64, 0.84]) { // cross cleats (footing)
            seg(at(e0, t0, t), at(e1, t1, t), 1.1, shade(WOOD, litT * 0.72));
        }
        seg(e0, t0, 1.3, shade(WOOD, litT * 0.55)); // edge rails (keep the plank
        seg(e1, t1, 1.3, shade(WOOD, litT * 0.55)); // readable even edge-on)
        const lipCol = lvl >= 3 ? gold : lvl >= 2 ? ironLit : shade(WOOD, 0.5);
        poly([at(e0, t0, 0.93), at(e1, t1, 0.93), t1, t0], lipCol); // tip lip
        if (rampAng > 0.15) { // hoist ropes while raised
            seg(PB(10.4, 8.4, 41.2), at(e0, t0, 0.8), 0.9, 0x6b5b43);
            seg(PB(10.4, -8.4, 41.2), at(e1, t1, 0.8), 0.9, 0x6b5b43);
        }
    };

    // ---------------- mid tier taper + hide skirts ----------------
    const midB = { d: 11.5, w: 9.2, h: 13.5 };
    const midT = { d: 9.8, w: 8.0, h: 34 };
    const midExt = (h: number, flare: number): { d: number; w: number } => {
        const f = clamp01((h - midB.h) / (midT.h - midB.h));
        return {
            d: midB.d + (midT.d - midB.d) * f + flare,
            w: midB.w + (midT.w - midB.w) * f + flare
        };
    };
    const midPt = (u: [number, number], h: number, flare: number): Pt => {
        const e = midExt(h, flare);
        return PB(e.d * u[0], e.w * u[1], h);
    };
    const hideTopH = 30.2;
    const hemH = 15.6;
    const drawHides = (): void => {
        let nearIdx = 0;
        for (let i = 0; i < FACES.length; i++) {
            const f = FACES[i];
            if (f.nsy <= 0.04) continue; // hides only paint on camera-facing faces
            const k = nearIdx++;
            const sx = sway(i);
            const T0 = midPt(f.u0, hideTopH, 0.35);
            const T1 = midPt(f.u1, hideTopH, 0.35);
            const H0 = midPt(f.u0, hemH, 1.0);
            const H1 = midPt(f.u1, hemH, 1.0);
            H0[0] += sx;
            H1[0] += sx;
            const hm = (t: number, dh: number): Pt => { // hem scallop point
                const e = midExt(hemH - dh, 1.0);
                const p = PB(
                    (f.u0[0] + (f.u1[0] - f.u0[0]) * t) * e.d,
                    (f.u0[1] + (f.u1[1] - f.u0[1]) * t) * e.w,
                    hemH - dh
                );
                p[0] += sx;
                return p;
            };
            const m = 0.9 - 0.24 * f.nsx;
            poly([T0, T1, H1, hm(0.66, 1.4), hm(0.33, 0.7), H0], shade(HIDE, m));
            // face-local bilinear (top edge static, hem inherits the sway)
            const fp = (t: number, v: number): Pt => {
                const tx = T0[0] + (T1[0] - T0[0]) * t;
                const ty = T0[1] + (T1[1] - T0[1]) * t;
                const bx = H0[0] + (H1[0] - H0[0]) * t;
                const by = H0[1] + (H1[1] - H0[1]) * t;
                return [tx + (bx - tx) * v, ty + (by - ty) * v];
            };
            // drape folds (the cloth hangs in soft vertical shadows)
            seg(fp(0.3, 0.06), fp(0.3, 0.94), 1.0, shade(HIDE, m * 0.78));
            seg(fp(0.68, 0.06), fp(0.68, 0.94), 1.0, shade(HIDE, m * 0.78));
            // lashing dashes along the top seam — pale leather, not white
            g.fillStyle(shade(HIDE, 1.55), 1);
            for (const t of [0.15, 0.5, 0.85]) {
                const p = fp(t, 0.02);
                g.fillRect(p[0] - 0.5, p[1] - 1.1, 1.0, 2.2);
            }
            if (k === 0) { // one big stitched patch on the first near face
                poly([fp(0.18, 0.22), fp(0.5, 0.18), fp(0.55, 0.62), fp(0.22, 0.66)], shade(HIDE, m * 0.72));
                for (const t of [0.27, 0.42]) {
                    seg(fp(t, 0.16), fp(t, 0.24), 0.9, stitchCol);
                    seg(fp(t + 0.04, 0.6), fp(t + 0.04, 0.68), 0.9, stitchCol);
                }
            }
            // old arrow stubs buried in the leather (scars, every level)
            const nl = Math.hypot(f.nsx, f.nsy) || 1;
            const nx = f.nsx / nl;
            const ny = f.nsy / nl;
            const stubs: Array<[number, number]> = k === 0 ? [[0.72, 0.35], [0.32, 0.5]] : [[0.55, 0.28]];
            for (const [su, sv] of stubs) {
                const sp = fp(su, sv);
                g.fillStyle(shade(HIDE, m * 0.55), 1); // impact pucker
                g.fillCircle(sp[0], sp[1], 0.9);
                const ex = sp[0] + nx * 5.0;
                const ey = sp[1] + ny * 5.0 - 0.5; // arrows arrived on an arc — stubs tilt up
                seg(sp, [ex, ey], 1.0, 0x4c3c28);
                g.fillStyle(0xcfc6b0, 1); // pale fletching
                g.fillRect(ex - 1.0, ey - 1.0, 2.0, 2.0);
            }
            if (lvl >= 2) { // hem studs: iron → gold
                g.fillStyle(lvl >= 3 ? gold : ironLit, 1);
                for (const t of [0.2, 0.5, 0.8]) {
                    const p = fp(t, 0.97);
                    g.fillRect(p[0] - 0.6, p[1] - 0.6, 1.2, 1.2);
                }
            }
        }
    };

    // ==================== PAINT (back-to-front) ====================

    // 1. contact shadow — ONE closed polygon at uniform alpha (iron rule)
    const shPts: Pt[] = [];
    for (let i = 0; i < 14; i++) {
        const th = (i / 14) * Math.PI * 2;
        shPts.push(P(Math.cos(th) * 17.5, Math.sin(th) * 13.5, -0.2));
    }
    poly(shPts, 0x000000, 0.3);

    // 2. far-side wheels + chocks
    drawWheel(8.5, -wheelW * nearSgn, false);
    drawWheel(-8.5, -wheelW * nearSgn, false);
    drawChock(8.5, -wheelW * nearSgn, 1);
    drawChock(-8.5, -wheelW * nearSgn, -1);

    // 3. axles under the chassis
    seg(P(8.5, wheelW, 6), P(8.5, -wheelW, 6), 2.0, shade(0x3c2e1e, own));
    seg(P(-8.5, wheelW, 6), P(-8.5, -wheelW, 6), 2.0, shade(0x3c2e1e, own));

    // 4. ramp behind the hull when the tower faces up-screen
    if (sn < 0) drawRamp();

    // 5. chassis (weathered, a shade darker than the tower)
    drawBox(14, 9.8, 13.4, 9.4, 8, 13.5, shade(WOOD, 0.92), PB, true, 1.22);
    for (const f of FACES) { // strapping: rope (L1) → iron (L2+)
        if (f.nsy <= 0.04) continue;
        seg(
            PB(14 * f.u0[0], 9.8 * f.u0[1], 12.6),
            PB(14 * f.u1[0], 9.8 * f.u1[1], 12.6),
            1.15,
            lvl >= 2 ? iron : 0x8a7452
        );
    }

    // 6. armored mid tier
    drawBox(midB.d, midB.w, midT.d, midT.w, midB.h, midT.h, WOOD, PB, false);
    drawHides();

    // 7. crenellated crown (fresh-sawn, a shade lighter — the tiers layer)
    drawBox(10.8, 8.8, 10.8, 8.8, 34, 41.5, shade(WOOD, 1.06), PB, true, 1.2);
    seg(PB(-3.5, 8.8, 41.5), PB(-3.5, -8.8, 41.5), 0.8, shade(WOOD, 0.95)); // deck planks
    seg(PB(3.5, 8.8, 41.5), PB(3.5, -8.8, 41.5), 0.8, shade(WOOD, 0.95));
    if (sn > 0.04) { // dark exit bay behind the ramp (only when the front face shows)
        poly([PB(10.85, 5, 34.3), PB(10.85, -5, 34.3), PB(10.85, -5, 40.4), PB(10.85, 5, 40.4)], 0x241a10);
    }
    for (const f of FACES) { // parapet cap line (sandstone at L3)
        if (f.nsy <= 0.04) continue;
        seg(
            PB(10.8 * f.u0[0], 8.8 * f.u0[1], 41.5),
            PB(10.8 * f.u1[0], 8.8 * f.u1[1], 41.5),
            1.2,
            lvl >= 3 ? sand : shade(WOOD, 1.3)
        );
    }
    // merlons — front rim keeps a gap for the ramp bay
    const merlons: Array<{ d: number; w: number; alongD: boolean }> = [
        { d: 9.9, w: 6.6, alongD: false }, { d: 9.9, w: -6.6, alongD: false },
        { d: -9.9, w: 6.4, alongD: false }, { d: -9.9, w: 0, alongD: false }, { d: -9.9, w: -6.4, alongD: false },
        { d: 6.2, w: 7.9, alongD: true }, { d: 0, w: 7.9, alongD: true }, { d: -6.2, w: 7.9, alongD: true },
        { d: 6.2, w: -7.9, alongD: true }, { d: 0, w: -7.9, alongD: true }, { d: -6.2, w: -7.9, alongD: true }
    ];
    merlons.sort((m1, m2) => P(m1.d, m1.w, 0)[1] - P(m2.d, m2.w, 0)[1]);
    for (const m of merlons) {
        const hd = m.alongD ? 1.7 : 1.1;
        const hw = m.alongD ? 1.1 : 1.7;
        const T = (dd: number, ww: number, hh: number): Pt => PB(m.d + dd, m.w + ww, hh);
        drawBox(hd, hw, hd, hw, 41.5, 46.3, WOOD, T, lvl < 2, 1.26);
        if (lvl >= 2) { // capped merlons: iron → sandstone
            poly([T(hd, hw, 46.3), T(hd, -hw, 46.3), T(-hd, -hw, 46.3), T(-hd, hw, 46.3)], lvl >= 3 ? sand : ironLit);
        }
    }

    // 8. flag pole + the red pennant
    const pb = PB(-3, 0, 41.5);
    const pt2 = PB(-3, 0, 61.5);
    seg(pb, pt2, 1.3, shade(0x6b5334, own));
    g.fillStyle(lvl >= 3 ? gold : shade(WOOD, 1.25), 1);
    g.fillCircle(pt2[0], pt2[1] - 1.2, lvl >= 3 ? 1.6 : 1.2);
    {
        const ph = rolling ? walkPh : idlePh; // stride-locked stream / IDLE_MS wave
        let ux: number, uy: number;
        if (rolling) { // streams back along the line of travel
            const l = Math.hypot(ca, sn * 0.5) || 1;
            ux = -ca / l;
            uy = (-sn * 0.5) / l;
        } else { // parked/idle: a steady easterly breeze
            ux = 0.97;
            uy = 0.24;
        }
        const w1 = Math.sin(ph) * 2.6;
        const w2 = Math.sin(ph * 2 + 1.1) * 1.3;
        const A0 = PB(-3, 0, 60.8);
        const A1 = PB(-3, 0, 56.6);
        const tipPt: Pt = [A0[0] + ux * 13.5, (A0[1] + A1[1]) / 2 + uy * 13.5 + w1];
        const mTop: Pt = [A0[0] + ux * 6.8, A0[1] + uy * 6.8 + w2];
        const mBot: Pt = [A1[0] + ux * 6.8, A1[1] + uy * 6.8 - 1.1 + w2];
        poly([A0, mTop, tipPt, mBot, A1], redLit);
        poly([A1, mBot, tipPt], redDark); // shadowed lower fold
        if (lvl >= 3) {
            seg(A0, mTop, 0.8, 0xf2ead8); // white hairline — an accent, not a mass
            g.fillStyle(gold, 1);
            g.fillCircle(tipPt[0], tipPt[1], 1.1); // gold tail tip
        }
    }

    // 9. near-side wheels + chocks
    drawWheel(8.5, wheelW * nearSgn, true);
    drawWheel(-8.5, wheelW * nearSgn, true);
    drawChock(8.5, wheelW * nearSgn, 1);
    drawChock(-8.5, wheelW * nearSgn, -1);

    // 10. ramp in front of the hull when the tower faces down-screen
    if (sn >= 0) drawRamp();
}
