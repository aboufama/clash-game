import type Phaser from 'phaser';

/**
 * SIEGE TOWER — clean-room design C: "GATECRASHER BELFRY".
 *
 * A tall plank war-belfry on four spoked wheels, crowned by a roofed cabin.
 * Its two conversion pieces double as rolling-state armor, so the transform
 * reads as one machine, not bolted-on props:
 *   - the FRONT MANTLET: a crenellated screen raised in front of the cabin
 *     while rolling — on park it slams forward-down and becomes the gangplank
 *     tongue thrust over the wall (teeth become the far lip, claws hook on);
 *   - the REAR STAIR: a two-segment jackknife sandwiched flat against the
 *     hull's back while rolling — on park it unfolds to the ground behind,
 *     a cleated ladder of treads that clearly invites troops up.
 * Deployed, the silhouette is one continuous climb line: ground → stair →
 * deck → through the cabin door (lantern lit) → tongue → wall.
 *
 * ANIMATION CONTRACT (all deterministic f(time), iron rule 3):
 *   - walk stride 700 ms (TROOP_PARAMS.siegetower.stride): wheel spokes turn
 *     90°/stride, body bounce at 350 ms, lateral sway at 700 ms — every term
 *     closes exactly over one stride window.
 *   - idle loop 2000 ms (exact 250 ms-multiple): pennant wave (2000/1000 ms
 *     harmonics, ~2.2 px tip travel — the quantization carrier), helmet bob
 *     (1000 ms), hull breath (2000 ms).
 *   - deploy is driven by `driver` = parked01 (0 rolling → 1 parked, scene
 *     tweens it over 700 ms): mantlet slams by p≈0.5 (+6° landing bounce,
 *     zero again by p=0.7), stair unfolds p 0.35→0.9, pennant droops, chocks
 *     and the door lantern appear late. ALL time-based terms are gated to
 *     zero by p=0.35, so the parked pose — including the single baked
 *     'deactivated' frame — is fully static.
 *
 * Levels: L1 raw pale timber + rope lashings · L2 oak + iron corner armor,
 * iron wheel rims and tip claws · L3 dark walnut + sandstone band with gold
 * strictly as accents (finial ball, tongue teeth, stair stringer edges).
 * Owner tells: pennant/plume/shield cloth (player blue, enemy crimson) and a
 * slightly darker wood for the enemy palette.
 */

type G = Phaser.GameObjects.Graphics;
type V3 = readonly [number, number, number];

const TAU = Math.PI * 2;
const DEG = Math.PI / 180;

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);
const easeIn = (t: number): number => t * t;
const easeOut = (t: number): number => 1 - (1 - t) * (1 - t);

function shade(c: number, m: number): number {
    const r = Math.max(0, Math.min(255, Math.round(((c >> 16) & 0xff) * m)));
    const gg = Math.max(0, Math.min(255, Math.round(((c >> 8) & 0xff) * m)));
    const b = Math.max(0, Math.min(255, Math.round((c & 0xff) * m)));
    return (r << 16) | (gg << 8) | b;
}

interface SiegePal {
    body: number; dark: number; line: number; deckTop: number; tread: number;
    cabin: number; roof: number; wheelFace: number; wheelRim: number; spoke: number;
    metal: number; cloth: number; clothDk: number;
    sand: number | null; gold: number | null; goldHi: number | null;
}

function palFor(level: number, isPlayer: boolean): SiegePal {
    const lv = Math.max(1, Math.min(3, Math.round(level || 1)));
    let body = [0x9a7b4f, 0x876741, 0x6f5136][lv - 1];
    let roof = [0x7d5f3c, 0x64492e, 0x53402b][lv - 1];
    let cabin = [0x8a6d45, 0x775a38, 0x604631][lv - 1];
    const metal = lv === 1 ? 0x6b5233 : [0x0, 0x474c55, 0x3f444d][lv - 1];
    if (!isPlayer) { // enemy: cooler, darker wood — metal/gold stay honest
        body = shade(body, 0.87); roof = shade(roof, 0.87); cabin = shade(cabin, 0.87);
    }
    return {
        body,
        dark: shade(body, 0.72),
        line: shade(body, 0.55),
        deckTop: shade(body, 1.16),
        tread: shade(body, 1.05),
        cabin,
        roof,
        wheelFace: shade(body, 0.8),
        wheelRim: lv === 1 ? shade(body, 0.6) : metal,
        spoke: shade(body, 0.92),
        metal,
        cloth: isPlayer ? 0x3e6db5 : 0xb0413a,
        clothDk: isPlayer ? 0x2a4f86 : 0x7e2e29,
        sand: lv === 3 ? 0xbfb49a : null,
        gold: lv === 3 ? 0xdaa520 : null,
        goldHi: lv === 3 ? 0xffd700 : null
    };
}

/** Per-slot bake-param overrides (DesignRegistry.designBakeParams): stride
 *  700 matches the TROOP_PARAMS row, but the idle loop closes on the exact
 *  2000 ms period (pennant 2000/1000, wheel-glint 1000, hull breath 2000) —
 *  not the default 4021 ms breath window. */
export const PARAMS: import('./DesignRegistry').DesignParamsExport = {
    siegetower: { idleMs: 2000 },
};

export function drawSiegetowerC(
    g: G,
    isPlayer: boolean,
    isMoving: boolean,
    facingAngle: number,
    troopLevel: number,
    time: number,
    _attackAge: number,
    _attackDelay: number,
    driver: number
): void {
    const lv = Math.max(1, Math.min(3, Math.round(troopLevel || 1)));
    const P = palFor(lv, isPlayer);
    const p = clamp01(driver);
    const a = facingAngle;
    const ca = Math.cos(a), sa = Math.sin(a);
    const GY = 8; // screen y of ground level (h = 0) at the carrier origin

    // ---------------- animation drivers (all deterministic in time / p) ----
    const rolling = isMoving && p < 0.02;
    const idleK = 1 - clamp01(p / 0.35);          // time-terms die as it parks
    const wPh = (time % 700) / 700;               // one walk stride
    const i2 = ((time % 2000) / 2000) * TAU;      // idle fundamental (2000 ms)
    const i1 = ((time % 1000) / 1000) * TAU;      // idle 2nd harmonic
    const bounce = Math.abs(Math.sin(wPh * Math.PI * 2)); // 350 ms hop
    const breath = Math.sin(i2) * 0.5;
    const settle = 1.2 * easeOut(clamp01(p / 0.3));        // parks 1.2 px lower
    const lift = rolling ? bounce * 0.9 : breath * 0.4 * idleK - settle;
    const sway = rolling ? Math.sin(wPh * TAU) * 1.3 : 0;
    const wheelRot = rolling ? -wPh * (Math.PI / 2) : 0;   // 90° per stride, 4 spokes
    const helmBob = (rolling ? 0 : Math.sin(i1) * 0.8 * idleK);

    // Deploy sub-timings on the (already eased) parked01 driver.
    const rattle = rolling ? Math.sin(((time % 350) / 350) * TAU) * 1.2 * DEG : 0;
    const thT = (88 - 112 * easeIn(clamp01((p - 0.05) / 0.45))) * DEG // mantlet 88° → −24°
        + Math.sin(Math.PI * clamp01((p - 0.5) / 0.2)) * 6 * DEG      // landing bounce → 0
        + rattle;
    const tU = easeOut(clamp01((p - 0.35) / 0.4));
    const tL = easeOut(clamp01((p - 0.5) / 0.4));
    const thU = (90 - 38 * tU) * DEG;             // upper stair: hangs 90° → 52°
    const thL = (-90 + 144 * tL) * DEG;           // lower stair: folded −90° → 54°
    const drape = clamp01((p - 0.3) / 0.4);       // pennant flying → limp

    // ---------------- oblique projection (iso squash 0.5 on d & w) ---------
    // d = along facing, w = across (right of travel), h = up from ground.
    let liftNow = 0, swayNow = 0;
    const pt = (d: number, w: number, h: number): [number, number] => {
        const wl = w + swayNow * (h > 10 ? (h - 10) * 0.038 : 0); // top-heavy rock
        return [d * ca - wl * sa, (d * sa + wl * ca) * 0.5 - (h + liftNow) + GY];
    };
    const body = () => { liftNow = lift; swayNow = sway; };
    const ground = () => { liftNow = 0; swayNow = 0; };

    const poly = (ps: [number, number][], color: number, alpha = 1) => {
        g.fillStyle(color, alpha);
        g.beginPath();
        g.moveTo(ps[0][0], ps[0][1]);
        for (let i = 1; i < ps.length; i++) g.lineTo(ps[i][0], ps[i][1]);
        g.closePath();
        g.fillPath();
    };
    // Face visibility: the view ray of this projection is (sa, ca, 0.5) in
    // (d,w,h) — a face shows iff its outward normal has a positive component
    // along it (rotation-proof by construction, art guide §6).
    const vis = (n: V3): boolean => n[0] * sa + n[1] * ca + n[2] * 0.5 > 0.02;
    // NW light: tops brightest, SW-facing lit, SE-facing dark (art guide §3).
    const bright = (n: V3): number => {
        const nsx = n[0] * ca - n[1] * sa;
        return Math.max(0.5, Math.min(1.16, 0.74 + 0.34 * n[2] - 0.16 * nsx));
    };
    const fface = (cs: V3[], n: V3, color: number, alpha = 1) =>
        poly(cs.map(c => pt(c[0], c[1], c[2])), shade(color, bright(n)), alpha);
    const flat = (cs: V3[], color: number, alpha = 1) =>
        poly(cs.map(c => pt(c[0], c[1], c[2])), color, alpha);
    const seg = (a3: V3, b3: V3, width: number, color: number, alpha = 1) => {
        const pa = pt(a3[0], a3[1], a3[2]), pb = pt(b3[0], b3[1], b3[2]);
        g.lineStyle(width, color, alpha);
        g.lineBetween(pa[0], pa[1], pb[0], pb[1]);
    };
    // Axis-aligned (in d/w/h) box: 4 auto-culled sides + top.
    const box = (d0: number, d1: number, w0: number, w1: number, h0: number, h1: number,
        c: number, ct?: number) => {
        if (vis([1, 0, 0])) fface([[d1, w0, h0], [d1, w1, h0], [d1, w1, h1], [d1, w0, h1]], [1, 0, 0], c);
        if (vis([-1, 0, 0])) fface([[d0, w0, h0], [d0, w1, h0], [d0, w1, h1], [d0, w0, h1]], [-1, 0, 0], c);
        if (vis([0, 1, 0])) fface([[d0, w1, h0], [d1, w1, h0], [d1, w1, h1], [d0, w1, h1]], [0, 1, 0], c);
        if (vis([0, -1, 0])) fface([[d0, w0, h0], [d1, w0, h0], [d1, w0, h1], [d0, w0, h1]], [0, -1, 0], c);
        fface([[d0, w0, h1], [d1, w0, h1], [d1, w1, h1], [d0, w1, h1]], [0, 0, 1], ct ?? c);
    };
    // Triangle with outward normal resolved against an interior reference.
    const tri = (c0: V3, c1: V3, c2: V3, ref: V3, color: number) => {
        const e1: V3 = [c1[0] - c0[0], c1[1] - c0[1], c1[2] - c0[2]];
        const e2: V3 = [c2[0] - c0[0], c2[1] - c0[1], c2[2] - c0[2]];
        let n: V3 = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
        const len = Math.hypot(n[0], n[1], n[2]) || 1;
        n = [n[0] / len, n[1] / len, n[2] / len];
        const cx = (c0[0] + c1[0] + c2[0]) / 3 - ref[0];
        const cy = (c0[1] + c1[1] + c2[1]) / 3 - ref[1];
        const cz = (c0[2] + c1[2] + c2[2]) / 3 - ref[2];
        if (n[0] * cx + n[1] * cy + n[2] * cz < 0) n = [-n[0], -n[1], -n[2]];
        if (!vis(n)) return;
        fface([c0, c1, c2], n, color);
    };

    // ---------------- geometry constants -----------------------------------
    const HULL_D = 11, HULL_W = 9, HULL_B = 10, HULL_T = 34; // main plank box
    const DECK_T = 36;
    const stairFar = sa >= 0; // facing down-screen → the rear stair is far

    // ========================================================== 1. shadow ==
    ground();
    g.fillStyle(0x101a0a, 0.24);
    g.fillEllipse(0, GY + 1.5, 46, 17);
    if (p > 0.55) { // ramp foot + tongue tip contact shade
        const sTail = pt(-30, 0, 0), sTip = pt(24, 0, 0);
        g.fillStyle(0x101a0a, 0.16 * clamp01((p - 0.55) / 0.3));
        g.fillEllipse(sTail[0], GY + 1.2 + (sTail[1] - GY) * 0.9, 20, 7);
        g.fillEllipse(sTip[0], GY + 1.2 + (sTip[1] - GY) * 0.9, 14, 5);
    }

    // ==================================================== 2. running gear ==
    const axle = (dc: number) => box(dc - 1, dc + 1, -10.5, 10.5, 5, 7, 0x3a3026);
    const chock = (w: number) => {
        if (!vis([0, Math.sign(w), 0])) return;
        flat([[15, w, 0.2], [18.2, w, 0.2], [17.6, w, 3]], shade(P.metal, 0.8));
    };
    const wheel = (dc: number, wc: number) => {
        box(dc - 1.6, dc + 1.6, wc - 1.3, wc + 1.3, 0.2, 3.6, shade(P.wheelRim, 0.9)); // tread bulk (edge-on views)
        const rim: [number, number][] = [];
        for (let k = 0; k < 12; k++) {
            const t = (k / 12) * TAU;
            rim.push(pt(dc + Math.cos(t) * 6, wc, 6 + Math.sin(t) * 6));
        }
        poly(rim, P.wheelRim);
        const face: [number, number][] = [];
        for (let k = 0; k < 12; k++) {
            const t = (k / 12) * TAU;
            face.push(pt(dc + Math.cos(t) * 4.4, wc, 6 + Math.sin(t) * 4.4));
        }
        poly(face, P.wheelFace);
        for (let k = 0; k < 4; k++) {
            const t = wheelRot + (k * Math.PI) / 2;
            seg([dc + Math.cos(t) * 1.2, wc, 6 + Math.sin(t) * 1.2],
                [dc + Math.cos(t) * 4.2, wc, 6 + Math.sin(t) * 4.2], 1.5, P.spoke);
        }
        const hb = pt(dc, wc, 6);
        g.fillStyle(0x352c22, 1);
        g.fillCircle(hb[0], hb[1], 1.5);
    };
    axle(-8.5); axle(8.5);
    const farW = ca >= 0 ? -10.5 : 10.5;
    wheel(-8.5, farW); wheel(8.5, farW);

    // ============================== 3. the mantlet tongue (front gangway) ==
    const drawTongue = () => {
        body();
        const TLen = 16, hD = 11.5, hH = DECK_T;
        const u: V3 = [Math.cos(thT), 0, Math.sin(thT)];
        const nT: V3 = [-Math.sin(thT), 0, Math.cos(thT)];
        const tip: V3 = [hD + TLen * u[0], 0, hH + TLen * u[2]];
        const c4 = (dd0: number, dd1: number, w0: number, w1: number): V3[] => [
            [hD + dd0 * u[0], w0, hH + dd0 * u[2]], [hD + dd0 * u[0], w1, hH + dd0 * u[2]],
            [hD + dd1 * u[0], w1, hH + dd1 * u[2]], [hD + dd1 * u[0], w0, hH + dd1 * u[2]]];
        const topSide = vis(nT);
        // slab (double-sided: deck side = planks, outer side = braced back)
        fface(c4(0, TLen, -7, 7), topSide ? nT : [-nT[0], -nT[1], -nT[2]],
            topSide ? P.body : P.dark);
        // side thickness strips
        for (const s of [-1, 1] as const) {
            const n: V3 = [0, s, 0];
            if (!vis(n)) continue;
            fface([[hD, s * 7, hH], [tip[0], s * 7, tip[2]],
                [tip[0] - nT[0] * 1.8, s * 7, tip[2] - nT[2] * 1.8],
                [hD - nT[0] * 1.8, s * 7, hH - nT[2] * 1.8]], n, P.dark);
        }
        if (topSide) { // cleat battens across the walking surface
            for (const f of [0.3, 0.55, 0.8]) {
                const d0 = f * TLen, d1 = f * TLen + 1.3;
                flat(c4(d0, d1, -6.3, 6.3), P.line, 0.85);
            }
        } else { // outer face X-brace
            seg([hD, -6, hH], [tip[0], 5.4, tip[2]], 1.2, P.line, 0.7);
            seg([hD, 6, hH], [tip[0], -5.4, tip[2]], 1.2, P.line, 0.7);
        }
        // crenel teeth on the free edge (gold-tipped at L3)
        for (const wc of [-4.6, 0, 4.6]) {
            fface([[tip[0], wc - 1.3, tip[2]], [tip[0], wc + 1.3, tip[2]],
                [tip[0] + u[0] * 3, wc + 1.3, tip[2] + u[2] * 3],
                [tip[0] + u[0] * 3, wc - 1.3, tip[2] + u[2] * 3]],
            topSide ? nT : [-nT[0], -nT[1], -nT[2]], P.gold ?? P.body);
        }
        if (lv >= 2) { // iron grapple claws at the tip corners
            for (const s of [-1, 1] as const) {
                if (!vis([0, s, 0])) continue;
                flat([[tip[0] - u[0] * 2, s * 6.5, tip[2] - u[2] * 2], [tip[0], s * 6.5, tip[2]],
                    [tip[0] - nT[0] * 3, s * 6.5, tip[2] - nT[2] * 3]], shade(P.metal, 0.85));
            }
        }
    };

    // ======================================= 4. the jackknife rear stair ==
    const stairPiece = (A: V3, B: V3, n: V3, treads: boolean) => {
        const topSide = vis(n);
        const nn: V3 = topSide ? n : [-n[0], -n[1], -n[2]];
        fface([[A[0], -6.5, A[2]], [A[0], 6.5, A[2]], [B[0], 6.5, B[2]], [B[0], -6.5, B[2]]],
            nn, topSide ? P.tread : P.dark);
        for (const s of [-1, 1] as const) { // stringers
            const ns: V3 = [0, s, 0];
            if (!vis(ns)) continue;
            fface([[A[0], s * 6.5, A[2]], [B[0], s * 6.5, B[2]],
                [B[0] - n[0] * 1.8, s * 6.5, B[2] - n[2] * 1.8],
                [A[0] - n[0] * 1.8, s * 6.5, A[2] - n[2] * 1.8]], ns, P.line);
        }
        // treads read as slats stowed and as ladder rungs deployed
        const bands = 4;
        for (let k = 0; k < bands; k++) {
            const f0 = k / bands, f1 = f0 + 0.5 / bands;
            const q: V3[] = [
                [A[0] + (B[0] - A[0]) * f0, -6.1, A[2] + (B[2] - A[2]) * f0],
                [A[0] + (B[0] - A[0]) * f0, 6.1, A[2] + (B[2] - A[2]) * f0],
                [A[0] + (B[0] - A[0]) * f1, 6.1, A[2] + (B[2] - A[2]) * f1],
                [A[0] + (B[0] - A[0]) * f1, -6.1, A[2] + (B[2] - A[2]) * f1]];
            flat(q, topSide ? P.line : shade(P.dark, 0.85), topSide ? 0.5 : 0.4);
        }
        if (treads && topSide && P.gold) { // L3 brass stringer edges
            seg(A, B, 1, P.gold, 0.9);
        }
    };
    const drawStair = () => {
        body();
        const H1: V3 = [-11.5, 0, HULL_T];
        const uU: V3 = [-Math.cos(thU), 0, -Math.sin(thU)];
        const nU: V3 = [uU[2], 0, -uU[0]];
        const endU: V3 = [H1[0] + uU[0] * 20, 0, H1[2] + uU[2] * 20];
        const off = 1.8 * (1 - tL);
        const SL: V3 = [endU[0] + nU[0] * off, 0, endU[2] + nU[2] * off];
        const uL: V3 = [-Math.cos(thL), 0, -Math.sin(thL)];
        const nL: V3 = [uL[2], 0, -uL[0]];
        const endL: V3 = [SL[0] + uL[0] * 20, 0, SL[2] + uL[2] * 20];
        if (stairFar) { // painter's order flips with the heading
            stairPiece(H1, endU, nU, true);
            stairPiece(SL, endL, nL, true);
        } else {
            stairPiece(SL, endL, nL, true);
            stairPiece(H1, endU, nU, true);
        }
        if (tL > 0.92) { // ground foot pad
            fface([[endL[0] - 2.5, -6.8, 0.9], [endL[0] - 2.5, 6.8, 0.9],
                [endL[0] + 2, 6.8, 0.9], [endL[0] + 2, -6.8, 0.9]], [0, 0, 1], P.dark);
        }
    };

    if (stairFar) drawStair(); else drawTongue();

    // ================================================ 5. chassis + hull ====
    ground();
    box(-13, 13, -9.5, 9.5, 7, 10, P.dark, shade(P.dark, 1.1));
    body();
    box(-HULL_D, HULL_D, -HULL_W, HULL_W, HULL_B, HULL_T, P.body);
    // plank seams + per-level dressing on whichever faces are visible
    const hullFaces: { n: V3; c: (w: number, h: number) => V3 }[] = [
        { n: [1, 0, 0], c: (w, h) => [HULL_D, w, h] },
        { n: [-1, 0, 0], c: (w, h) => [-HULL_D, -w, h] },
        { n: [0, 1, 0], c: (w, h) => [w, HULL_W, h] },
        { n: [0, -1, 0], c: (w, h) => [-w, -HULL_W, h] }
    ];
    for (const f of hullFaces) {
        if (!vis(f.n)) continue;
        const lim = (f.n[0] !== 0 ? HULL_W : HULL_D) - 0.4;
        seg(f.c(-lim, 22), f.c(lim, 22), 1, P.line, 0.45); // plank course
        seg(f.c(-lim / 3, HULL_B + 1), f.c(-lim / 3, HULL_T - 1), 1, P.line, 0.3);
        seg(f.c(lim / 3, HULL_B + 1), f.c(lim / 3, HULL_T - 1), 1, P.line, 0.3);
        if (lv === 1) { // rope lashing X
            seg(f.c(-lim + 1, 13), f.c(lim - 1, 31), 1.2, 0x5c462d, 0.6);
            seg(f.c(-lim + 1, 31), f.c(lim - 1, 13), 1.2, 0x5c462d, 0.6);
        }
        if (P.sand) { // L3 sandstone band under the deck
            fface([f.c(-lim, 30.5), f.c(lim, 30.5), f.c(lim, 32.5), f.c(-lim, 32.5)], f.n, P.sand);
        }
        if (lv === 3 && f.n[0] === 0) { // L3 flank shields (owner cloth + gold boss)
            for (const dd of [-4.5, 4.5]) {
                const c = pt(f.n[1] > 0 ? dd : -dd, f.n[1] * HULL_W, 25);
                g.fillStyle(P.clothDk, 1); g.fillCircle(c[0], c[1], 3);
                g.fillStyle(P.cloth, 1); g.fillCircle(c[0] - 0.4, c[1] - 0.4, 2.2);
                g.fillStyle(P.gold ?? 0xdaa520, 1); g.fillCircle(c[0], c[1], 0.9);
            }
        }
    }
    // corner armor posts (wood L1, iron L2+, gold caps L3)
    for (const sd of [-1, 1] as const) for (const sw of [-1, 1] as const) {
        const cd = sd * HULL_D, cw = sw * HULL_W;
        box(cd - 0.9, cd + 0.9, cw - 0.9, cw + 0.9, HULL_B, HULL_T + 0.6,
            lv === 1 ? P.line : P.metal,
            P.goldHi ?? (lv === 1 ? P.line : shade(P.metal, 1.15)));
    }

    // ======================================== 6. deck, cabin, roof, flag ===
    box(-11.5, 11.5, -8.5, 8.5, HULL_T, DECK_T, P.dark, P.deckTop);
    box(-9, 9, -6.5, 6.5, DECK_T, 47, P.cabin);
    // doors: front (onto the tongue) and rear (onto the stair) — the lantern
    // warms the openings once the ramp is down, the "come on up" cue.
    const doorCol = p > 0.7 ? 0x2e1d0e : 0x1c130c;
    const door = (dFace: number) => {
        const n: V3 = [Math.sign(dFace), 0, 0];
        if (!vis(n)) return false;
        flat([[dFace, -2.6, 36.4], [dFace, 2.6, 36.4], [dFace, 2.6, 43],
            [dFace, 0, 45], [dFace, -2.6, 43]], doorCol);
        seg([dFace, -3.1, 44.2], [dFace, 0, 46.2], 1.2, P.line, 0.8);
        seg([dFace, 3.1, 44.2], [dFace, 0, 46.2], 1.2, P.line, 0.8);
        return true;
    };
    const helm = (d: number, w: number, h: number) => {
        const c = pt(d, w, h);
        g.fillStyle(P.cloth, 1); g.fillRect(c[0] - 0.7, c[1] - 4.6, 1.4, 1.8); // plume
        g.fillStyle(0x8d939d, 1); g.fillCircle(c[0], c[1] - 1, 2);
        g.fillStyle(0x666c76, 1); g.fillRect(c[0] - 2, c[1] - 0.4, 4, 1.1);
    };
    const frontDoor = door(9);
    const rearDoor = door(-9);
    if (p < 0.6) { // a lookout mans whichever doorway faces the player
        if (frontDoor) helm(9.4, 0, 39.6 + helmBob);
        else if (rearDoor) helm(-9.4, 0, 39.6 - helmBob);
    }
    // arrow slits on the cabin flanks
    for (const s of [-1, 1] as const) {
        if (!vis([0, s, 0])) continue;
        for (const dd of [-3, 3]) {
            flat([[dd - 0.6, s * 6.5, 39], [dd + 0.6, s * 6.5, 39],
                [dd + 0.6, s * 6.5, 43.2], [dd - 0.6, s * 6.5, 43.2]], 0x1c130c);
        }
    }
    // hipped pyramid roof + finial
    const eave: V3[] = [[-11, -8.5, 46.5], [11, -8.5, 46.5], [11, 8.5, 46.5], [-11, 8.5, 46.5]];
    const apex: V3 = [0, 0, 55];
    const roofRef: V3 = [0, 0, 44];
    tri(eave[0], eave[1], apex, roofRef, P.roof);
    tri(eave[1], eave[2], apex, roofRef, P.roof);
    tri(eave[2], eave[3], apex, roofRef, P.roof);
    tri(eave[3], eave[0], apex, roofRef, P.roof);
    seg([0, 0, 55], [0, 0, 61], 1.2, P.line);
    if (P.gold) {
        const fb = pt(0, 0, 55.6);
        g.fillStyle(P.gold, 1); g.fillCircle(fb[0], fb[1], 1.4);
    }
    // pennant: streams + flutters while alive, lerps to a limp drape as it
    // parks (wave terms: 2000/1000 ms idle, 700 ms stride — all exact loops)
    {
        const P0 = pt(0, 0, 61);
        const blen = Math.hypot(ca, sa * 0.5) || 0.5;
        const L = 11 * (1 - drape * 0.65);
        const bx = (-ca / blen) * L, by = ((-sa * 0.5) / blen) * L;
        const wPhT = wPh * TAU;
        const wv = (rolling ? Math.sin(wPhT - 0.8) * 2.6 : Math.sin(i2) * 2.2 * idleK);
        const wm = (rolling ? Math.sin(wPhT + 2) * 1.4 : Math.sin(i1 + 1.1) * 1.1 * idleK);
        const sag = drape * 8, msag = drape * 4;
        poly([
            [P0[0], P0[1]],
            [P0[0] + bx * 0.55, P0[1] + by * 0.55 - 0.6 + wm + msag],
            [P0[0] + bx, P0[1] + by + 0.6 + wv + sag],
            [P0[0] + bx * 0.55, P0[1] + by * 0.55 + 2.2 + wm + msag],
            [P0[0], P0[1] + 3.2]
        ], P.cloth);
        poly([
            [P0[0], P0[1] + 1.4],
            [P0[0] + bx * 0.55, P0[1] + by * 0.55 + 1 + wm + msag],
            [P0[0] + bx * 0.55, P0[1] + by * 0.55 + 2.2 + wm + msag],
            [P0[0], P0[1] + 3.2]
        ], P.clothDk);
    }
    // door lantern swings out once parked — the night-time invitation
    if (p > 0.72) {
        const sc = clamp01((p - 0.72) / 0.2);
        const lp = pt(-11.6, 0, 44.6);
        seg([-9.6, 0, 46.4], [-11.6, 0, 45.2], 1, 0x2f2a22);
        g.fillStyle(0xffb84d, 0.16 * sc);
        g.fillCircle(lp[0], lp[1], 4.5 * sc);
        g.fillStyle(0x2f2a22, 1);
        g.fillRect(lp[0] - 1.3, lp[1] - 1.6, 2.6, 3.2);
        g.fillStyle(0xffd27a, 0.95 * sc);
        g.fillRect(lp[0] - 0.7, lp[1] - 0.9, 1.4, 1.8);
    }

    // ================================================= 7. near-side piece ==
    if (stairFar) drawTongue(); else drawStair();

    // ================================================== 8. near wheels =====
    ground();
    const nearW = -farW;
    wheel(-8.5, nearW); wheel(8.5, nearW);
    if (p > 0.55) { chock(-10.5); chock(10.5); }

    // ============================== 9. deployed crew showing the way up ====
    if (p > 0.6) {
        body();
        helm(10, -3, 39.4);   // beckoning at the tongue
        helm(-10.8, 3, 38.6); // at the stair-top landing
    }
}
