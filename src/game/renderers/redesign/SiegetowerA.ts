import type Phaser from 'phaser';

/**
 * SIEGE TOWER — DESIGN A: "The Ox of the Line".
 *
 * A foursquare military-engineer's belfry: four SOLID oak disc wheels
 * (nail-ring bosses, no spokes), a heavy timber chassis, a stitched-hide
 * armored middle tier (arrow-scarred, scalloped panels that sway), and an
 * OPEN crenellated fighting top whose front face is a gate: the drop-ramp
 * hinges there and is lowered on two chains from the gate posts.
 *
 * DRIVER = parked01 (0 rolling → 1 parked at a wall):
 *   d 0.00–0.22  the hull settles 1.6 px onto its axles (wheels stay put)
 *   d 0.04–0.26  chocks slide in against the front wheels
 *   d 0.18–0.92  the ramp swings from stowed-vertical through a ~138° arc,
 *                chains paying out; a small overshoot wobble passes through
 *                and returns to 0 exactly at d = 1
 *   d 1.00       the ramp reads as a solid plank bridge, deck at ~18 px —
 *                wall height (walls are 15–20 px) — with landing teeth down.
 *
 * PERIOD CONTRACT (bake TROOP_PARAMS must match):
 *   walk stride = 700 ms  — ONE exact gait period. Wheels turn 90° per
 *     stride (the nail ring has 90° symmetry, so the wheel loop closes),
 *     hull bob |sin| at 350 ms, lurch/lean at 700 ms, hide sway at 700 ms,
 *     pennant stream at 350/700 ms. All exact harmonics of 700.
 *   idle period = 2000 ms — rolling-idle AND parked idle: pennant wave at
 *     1000/2000 ms, hide sway at 2000 ms (bottom edges displace ≥1.5 px).
 *   No attack. All motion is deterministic f(time) — no Math.random.
 *
 * Levels: L1 raw pale timber + rope lashings · L2 seasoned wood, iron-shod
 * wheels/rails, studded hides · L3 dark polished oak, oxblood hides, brass
 * studs and SUBTLE gold accents (merlon caps, pole finial, ramp lip).
 */

type G = Phaser.GameObjects.Graphics;
type Pt = { x: number; y: number };

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);
const smooth = (t: number): number => t * t * (3 - 2 * t);
const easeOutQ = (t: number): number => 1 - (1 - t) * (1 - t);

/** Multiply a 0xRRGGBB colour per channel (clamped). */
function mulC(c: number, mr: number, mg: number = mr, mb: number = mr): number {
    const r = Math.max(0, Math.min(255, Math.round(((c >> 16) & 0xff) * mr)));
    const g = Math.max(0, Math.min(255, Math.round(((c >> 8) & 0xff) * mg)));
    const b = Math.max(0, Math.min(255, Math.round((c & 0xff) * mb)));
    return (r << 16) | (g << 8) | b;
}

function mixC(a: number, b: number, t: number): number {
    const k = clamp01(t);
    const r = Math.round(((a >> 16) & 0xff) + ((((b >> 16) & 0xff) - ((a >> 16) & 0xff)) * k));
    const g = Math.round(((a >> 8) & 0xff) + ((((b >> 8) & 0xff) - ((a >> 8) & 0xff)) * k));
    const bl = Math.round((a & 0xff) + (((b & 0xff) - (a & 0xff)) * k));
    return (r << 16) | (g << 8) | bl;
}

/** Per-slot bake-param overrides (DesignRegistry.designBakeParams): stride
 *  700 matches the TROOP_PARAMS row, but the idle loop closes on the exact
 *  IDLE_P = 2000 ms period — not the default 4021 ms breath window. */
export const PARAMS: import('./DesignRegistry').DesignParamsExport = {
    siegetower: { idleMs: 2000 },
};

export function drawSiegetowerA(
    graphics: G,
    isPlayer: boolean,
    isMoving: boolean,
    facingAngle: number,
    troopLevel: number,
    time: number,
    _attackAge: number,
    _attackDelay: number,
    driver: number
): void {
    const g = graphics;
    const L = Math.max(1, Math.min(3, Math.round(troopLevel) || 1));
    const d = clamp01(driver);

    // ---- iso direction frame -------------------------------------------
    const cos = Math.cos(facingAngle);
    const sin = Math.sin(facingAngle);
    const axx = cos, axy = sin * 0.5;   // screen unit: along facing
    const pxx = -sin, pxy = cos * 0.5;  // screen unit: across facing
    const GY = 12;                      // ground line below the troop origin

    // ---- palette (owner tint via isPlayer, material tier via level) ----
    const own = (c: number): number => (isPlayer ? c : mulC(c, 0.8, 0.83, 0.9));
    const woodBase = own(L >= 3 ? 0x7e5f3a : L >= 2 ? 0x8d6f46 : 0x9a7b4f);
    const woodDk = mulC(woodBase, 0.6);
    const woodLt = mulC(woodBase, 1.24);
    const plankLn = mulC(woodBase, 0.46);
    const hideA = own(L >= 3 ? 0x84503a : L >= 2 ? 0xa8875a : 0xb2955f);
    const hideB = mulC(hideA, 0.8);
    const hideSeam = mulC(hideA, 0.42);
    const iron = 0x4e525b;
    const ironLt = 0x7a7f8a;
    const gold = 0xdaa520;
    const rope = own(0x8a7a5a);
    const interior = own(0x4a392a);
    const penn = isPlayer ? 0xc23b2e : 0x8f2f2c;
    const pennDk = mulC(penn, 0.7);
    const ironwork = L >= 2;
    const gilt = L >= 3;
    const stud = gilt ? 0xc9a227 : iron;

    // ---- motion (period contract in the header) ------------------------
    const STRIDE = 700, IDLE_P = 2000;
    const TAU = Math.PI * 2;
    const mv = isMoving && d < 0.5;
    const ph = (((time % STRIDE) + STRIDE) % STRIDE) / STRIDE;
    const bob = mv ? Math.abs(Math.sin(ph * Math.PI * 2)) * 0.9 : 0;
    const lurch = mv ? Math.sin(ph * TAU) * 0.6 : 0;
    const lean = mv ? Math.sin(ph * TAU + Math.PI / 3) * 0.02 : 0;
    const settle = easeOutQ(clamp01(d / 0.22)) * 1.6;
    // Quarter turn per stride: the 4-boss nail ring has 90° symmetry, so
    // the rolling wheel pose loops EXACTLY every stride.
    const wheelA = mv ? ph * (Math.PI / 2) : 0.35;
    const ambW = TAU / (mv ? STRIDE : IDLE_P); // ambient terms: harmonics of the live loop
    const swayAmp = mv ? 1.8 : 1.6;            // hide bottoms displace ≥1.5 px

    // ---- geometry helpers ----------------------------------------------
    /** World-ish point: dd along facing, ww across, hh above ground. */
    const P = (dd: number, ww: number, hh: number): Pt => ({
        x: dd * axx + ww * pxx,
        y: GY + dd * axy + ww * pxy - hh
    });
    /** Hull point: rides the settle drop, walk bob and gait lean. */
    const B = (dd: number, ww: number, hh: number): Pt =>
        P(dd + lurch, ww + hh * lean, hh - settle + bob);
    const poly = (pts: Pt[], color: number, alpha: number = 1): void => {
        g.fillStyle(color, alpha);
        g.beginPath();
        g.moveTo(pts[0].x, pts[0].y);
        for (let i = 1; i < pts.length; i++) g.lineTo(pts[i].x, pts[i].y);
        g.closePath();
        g.fillPath();
    };
    const lerpPt = (a: Pt, b: Pt, t: number): Pt => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });

    // Box faces: outward normal (fd·along + fp·across). Visible iff its
    // screen-y component is positive (points down-screen) — the
    // rotation-proof face rule from the art guide.
    const FACES: ReadonlyArray<{ fd: number; fp: number }> = [
        { fd: 1, fp: 0 }, { fd: -1, fp: 0 }, { fd: 0, fp: 1 }, { fd: 0, fp: -1 }
    ];
    const faceNy = (f: { fd: number; fp: number }): number => f.fd * axy + f.fp * pxy;
    const faceNx = (f: { fd: number; fp: number }): number => f.fd * axx + f.fp * pxx;
    /** NW light: SW-pointing faces lit, SE-pointing dark — continuous. */
    const faceShade = (f: { fd: number; fp: number }): number => {
        const nx = faceNx(f), ny = faceNy(f);
        const n = Math.hypot(nx, ny) || 1;
        return 0.97 - 0.34 * (nx / n);
    };

    // ---- proportions (slim belfry: ~2:1 tall vs wide, under the hall) --
    const h0 = 9.5, h1 = 28.5;      // hide-armored mid tier
    const S0 = 8.8, S1 = 7.6;       // mid tier taper (bottom → top half-size)
    const CS = 9.4;                 // crown half-size (overhangs the taper)
    const lipB = 28.5, lipT = 31;   // machicolation lip band
    const parT = 36, merT = 39;     // parapet top / merlon top
    const WB = 10.2, WLB = 8.2, WR = 6.6; // wheel track, wheelbase, wheel radius

    /** Mid-tier face point: u across [-1,1], v height (taper applied). */
    const midPt = (f: { fd: number; fp: number }, u: number, v: number): Pt => {
        const s = S0 + (S1 - S0) * clamp01((v - h0) / (h1 - h0));
        return f.fd !== 0 ? B(f.fd * s, u * s, v) : B(u * s, f.fp * s, v);
    };
    /** Crown face point (constant half-size CS). */
    const crownPt = (f: { fd: number; fp: number }, u: number, v: number): Pt =>
        f.fd !== 0 ? B(f.fd * CS, u * CS, v) : B(u * CS, f.fp * CS, v);

    // ============================ SHADOW ================================
    g.fillStyle(0x000000, 0.3);
    g.fillEllipse(cos * 1.5, GY + 0.6 + sin * 0.8, 46, 19);

    // ============================ WHEELS ================================
    interface Wheel { dd: number; ss: number; ny: number; front: boolean }
    const wheels: Wheel[] = [];
    for (const dd of [WLB, -WLB]) for (const ss of [1, -1]) {
        wheels.push({ dd, ss, ny: dd * axy + ss * WB * pxy, front: dd > 0 });
    }
    wheels.sort((a, b) => a.ny - b.ny);

    const drawWheel = (wh: Wheel): void => {
        const C = P(wh.dd, wh.ss * WB, WR);
        // Tread disc: a vertical disc in the facing plane — trace it so it
        // stays correct at every heading (never an axis-aligned ellipse).
        const rim = (r: number, ox: number, oy: number): Pt[] => {
            const pts: Pt[] = [];
            for (let i = 0; i < 16; i++) {
                const t = (i / 16) * TAU;
                pts.push({ x: C.x + ox + axx * r * Math.cos(t), y: C.y + oy + axy * r * Math.cos(t) - r * Math.sin(t) });
            }
            return pts;
        };
        poly(rim(WR, 0, 0), mulC(woodDk, 0.78));
        // Axle-width tread slab: keeps the wheel a solid block when the disc
        // goes edge-on (facing straight up/down screen the ellipse collapses).
        const twx = pxx * 1.7, twy = pxy * 1.7;
        poly([
            { x: C.x - twx, y: C.y - twy - WR }, { x: C.x + twx, y: C.y + twy - WR },
            { x: C.x + twx, y: C.y + twy + WR }, { x: C.x - twx, y: C.y - twy + WR }
        ], mulC(woodDk, 0.78));
        // Outer face plate, offset outward along the axle.
        const fx = pxx * wh.ss * 1.7, fy = pxy * wh.ss * 1.7;
        const fShade = 0.95 - 0.27 * ((pxx * wh.ss) / (Math.hypot(pxx * wh.ss, pxy * wh.ss) || 1));
        poly(rim(WR - 0.55, fx, fy), mulC(woodBase, fShade * 0.94));
        if (ironwork) {
            g.lineStyle(1.4, iron, 1);
            const rp = rim(WR - 0.55, fx, fy);
            g.beginPath();
            g.moveTo(rp[0].x, rp[0].y);
            for (let i = 1; i < rp.length; i++) g.lineTo(rp[i].x, rp[i].y);
            g.closePath();
            g.strokePath();
        }
        // Hub + four nail bosses at 90° spacing (rotates with wheelA).
        g.fillStyle(ironwork ? iron : woodDk, 1);
        g.fillCircle(C.x + fx, C.y + fy, 1.9);
        if (gilt) {
            g.fillStyle(gold, 1);
            g.fillCircle(C.x + fx, C.y + fy, 0.9);
        }
        for (let k = 0; k < 4; k++) {
            const t = wheelA + (k * Math.PI) / 2;
            const bxp = C.x + fx + axx * 3.6 * Math.cos(t);
            const byp = C.y + fy + axy * 3.6 * Math.cos(t) - 3.6 * Math.sin(t);
            g.fillStyle(ironwork ? ironLt : mulC(woodDk, 0.8), 1);
            g.fillCircle(bxp, byp, 1.05);
        }
    };
    const drawChock = (wh: Wheel): void => {
        if (!wh.front || d < 0.04) return;
        const chT = easeOutQ(clamp01((d - 0.04) / 0.22));
        const d0 = WLB + 1.6 + 2.4 * chT, d1 = d0 + 3.4;
        const w = wh.ss * WB;
        poly([P(d1, w, 0.2), P(d0, w - 2.2, 0.2), P(d0 + 0.5, w, 3.8), P(d0, w + 2.2, 0.2)], own(0x4d3a28));
        g.lineStyle(1.3, mulC(own(0x4d3a28), 1.6), 1);
        g.lineBetween(P(d0 + 0.5, w, 3.8).x, P(d0 + 0.5, w, 3.8).y, P(d1, w, 0.2).x, P(d1, w, 0.2).y);
    };

    // Far pair first (painter's order); near pair after the hull.
    for (const wh of wheels.slice(0, 2)) { drawWheel(wh); drawChock(wh); }

    // ======================= THE DROP-RAMP ==============================
    // Hinged at the crown-floor front lip; lowered on two chains from the
    // gate posts. phi: 0 = stowed vertical crest, phiMax = bridge slightly
    // below horizontal so the deck lands at ~18 px — wall height.
    const phiMax = 2.48;
    const tR = clamp01((d - 0.18) / 0.74);
    // Overshoot wobble passes through and returns to 0 exactly at t=1.
    const wobble = tR > 0.62 ? Math.sin(((tR - 0.62) / 0.38) * Math.PI) * 0.09 : 0;
    const phi = smooth(tR) * phiMax + wobble;
    const RL = 16.5, RW = 6.2;
    const hingeD = CS + 0.4, hingeH = lipT;

    const drawRamp = (): void => {
        const tipD = hingeD + RL * Math.sin(phi);
        const tipH = hingeH + RL * Math.cos(phi);
        const hL = B(hingeD, -RW, hingeH), hR = B(hingeD, RW, hingeH);
        const tL = B(tipD, -RW * 0.92, tipH), tRp = B(tipD, RW * 0.92, tipH);
        // Deck: dark stowed underside → lit plank surface as it comes down.
        const upK = clamp01((phi - 0.8) / 1.1);
        const deck = mixC(mulC(woodBase, 0.8), mulC(woodLt, 1.02), upK);
        // Plank thickness first: side skirts hang under both long edges so
        // the bridge stays a solid slab even when the deck goes edge-on
        // (facing pure screen-left/right) — the deck then paints over the
        // far skirt.
        const skirt = mulC(deck, 0.62);
        poly([hL, tL, { x: tL.x, y: tL.y + 2.3 }, { x: hL.x, y: hL.y + 2.3 }], skirt);
        poly([hR, tRp, { x: tRp.x, y: tRp.y + 2.3 }, { x: hR.x, y: hR.y + 2.3 }], skirt);
        poly([hL, hR, tRp, tL], deck);
        // Cross planks.
        g.lineStyle(1.2, plankLn, 0.45);
        for (const f of [0.22, 0.42, 0.62, 0.82]) {
            const a = lerpPt(hL, tL, f), b = lerpPt(hR, tRp, f);
            g.lineBetween(a.x, a.y, b.x, b.y);
        }
        // Side rails (wood-toned + inset: iron would drown the deck when the
        // bridge goes edge-on at screen-left/right headings) + iron tip bar.
        g.lineStyle(1.4, mulC(deck, 0.7), 1);
        const rA0 = lerpPt(hL, hR, 0.07), rA1 = lerpPt(tL, tRp, 0.07);
        const rB0 = lerpPt(hL, hR, 0.93), rB1 = lerpPt(tL, tRp, 0.93);
        g.lineBetween(rA0.x, rA0.y, rA1.x, rA1.y);
        g.lineBetween(rB0.x, rB0.y, rB1.x, rB1.y);
        g.lineStyle(2, ironwork ? iron : woodDk, 1);
        g.lineBetween(tL.x, tL.y, tRp.x, tRp.y);
        if (gilt) {
            g.lineStyle(1.1, gold, 1);
            const gA = lerpPt(tL, hL, 0.06), gB = lerpPt(tRp, hR, 0.06);
            g.lineBetween(gA.x, gA.y, gB.x, gB.y);
        }
        // Brace straps on the stowed crest (read as the tower's front shield).
        if (phi < 1.2) {
            g.lineStyle(1.5, mulC(deck, 0.62), 1);
            const s1a = lerpPt(hL, tL, 0.1), s1b = lerpPt(hR, tRp, 0.82);
            const s2a = lerpPt(hR, tRp, 0.1), s2b = lerpPt(hL, tL, 0.82);
            g.lineBetween(s1a.x, s1a.y, s1b.x, s1b.y);
            g.lineBetween(s2a.x, s2a.y, s2b.x, s2b.y);
        }
        // Landing teeth bite down once the bridge is nearly flat.
        if (phi > 2.0) {
            g.fillStyle(iron, 1);
            for (const sd of [-1, 1]) {
                const c = lerpPt(sd < 0 ? tL : tRp, sd < 0 ? hL : hR, 0.04);
                poly([{ x: c.x - 1.2, y: c.y }, { x: c.x + 1.2, y: c.y }, { x: c.x, y: c.y + 3 }], iron);
            }
        }
        // The two chains, gate posts → ramp rails (sag while stowed, taut
        // when deployed).
        const sag = (1 - phi / phiMax) * 2.6 + 0.4;
        g.lineStyle(1.2, own(0x565f6a), 1);
        for (const sd of [-1, 1]) {
            const post = crownPt({ fd: 1, fp: 0 }, sd * 0.86, 36.2);
            const att = lerpPt(sd < 0 ? hL : hR, sd < 0 ? tL : tRp, 0.9);
            const mid = { x: (post.x + att.x) / 2, y: (post.y + att.y) / 2 + sag };
            g.lineBetween(post.x, post.y, mid.x, mid.y);
            g.lineBetween(mid.x, mid.y, att.x, att.y);
        }
    };
    const rampFar = axy < -0.02;
    if (rampFar) drawRamp();

    // ============================ CHASSIS ===============================
    for (const f of FACES) {
        if (faceNy(f) <= 0.02) continue;
        const s = faceShade(f);
        const cPt = (u: number, v: number): Pt =>
            f.fd !== 0 ? B(f.fd * 9.6, u * 9.2, v) : B(u * 9.6, f.fp * 9.2, v);
        poly([cPt(-1, 5.2), cPt(1, 5.2), cPt(1, 9.5), cPt(-1, 9.5)], mulC(woodDk, s * 1.12));
        g.lineStyle(1.2, plankLn, 0.7);
        const a = cPt(-1, 7.4), b = cPt(1, 7.4);
        g.lineBetween(a.x, a.y, b.x, b.y);
    }

    // ===================== MID TIER — HIDE ARMOR ========================
    for (const f of FACES) {
        if (faceNy(f) <= 0.02) continue;
        const s = faceShade(f);
        // Timber wall; the zone below the hides stays darker so the hanging
        // panels read against it.
        poly([midPt(f, -1, h0), midPt(f, 1, h0), midPt(f, 1, h1), midPt(f, -1, h1)], mulC(woodBase, s));
        poly([midPt(f, -1, h0), midPt(f, 1, h0), midPt(f, 1, 15.5), midPt(f, -1, 15.5)], mulC(woodBase, s * 0.78));
        // Plank courses.
        g.lineStyle(1.2, plankLn, 0.5);
        for (const v of [13, 21.5, 25]) {
            const a = midPt(f, -0.97, v), b = midPt(f, 0.97, v);
            g.lineBetween(a.x, a.y, b.x, b.y);
        }
        // Sill beam above the chassis.
        g.lineStyle(1.6, mulC(woodDk, s), 0.9);
        const sa = midPt(f, -1, 10.6), sb = midPt(f, 1, 10.6);
        g.lineBetween(sa.x, sa.y, sb.x, sb.y);

        // Stitched hide panels — pinned at the rail, bottoms sway.
        const faceSeed = f.fd * 1.9 + f.fp * 4.3;
        const hTop = 26.4;
        const panels: Array<[number, number, number]> = [
            [-0.99, -0.32, 14.4], [-0.4, 0.34, 13.2], [0.26, 0.99, 14.9]
        ];
        for (let pi = 0; pi < panels.length; pi++) {
            const [u0, u1, vb] = panels[pi];
            const sw = Math.sin(time * ambW + faceSeed + pi * 2.1) * swayAmp;
            const swU = (sw / 9) * 1; // ≈ swayAmp px along the face plane
            const um = (u0 + u1) / 2;
            const col = mulC(pi % 2 === 0 ? hideA : hideB, s);
            const bot = [
                midPt(f, u1 + swU, vb), midPt(f, um + 0.26 + swU, vb - 2.6),
                midPt(f, um + swU, vb - 0.5), midPt(f, um - 0.28 + swU, vb - 2.7),
                midPt(f, u0 + swU, vb)
            ];
            poly([midPt(f, u0, hTop), midPt(f, u1, hTop), ...bot], col);
            // Shadowed hem so the scalloped bottom pops off the timber.
            g.lineStyle(1.4, mulC(col, 0.55), 1);
            g.beginPath();
            g.moveTo(bot[0].x, bot[0].y);
            for (let bi = 1; bi < bot.length; bi++) g.lineTo(bot[bi].x, bot[bi].y);
            g.strokePath();
            // Seam stitching along the panel edge.
            g.lineStyle(1.3, hideSeam, 1);
            const t0 = midPt(f, u1 - 0.03, hTop - 0.4), t1 = midPt(f, u1 - 0.03 + swU * 0.8, vb + 0.6);
            g.lineBetween(t0.x, t0.y, t1.x, t1.y);
            // Lacing ticks where the panel hangs from the batten.
            g.lineStyle(1.3, hideSeam, 1);
            for (const lu of [u0 + 0.14, um, u1 - 0.14]) {
                const l0 = midPt(f, lu, hTop + 0.6), l1 = midPt(f, lu, hTop - 1.4);
                g.lineBetween(l0.x, l0.y, l1.x, l1.y);
            }
            if (ironwork) {
                g.fillStyle(stud, 1);
                const s0 = midPt(f, u0 + 0.12, hTop - 2.2);
                const s1 = midPt(f, u1 - 0.12, hTop - 2.2);
                g.fillCircle(s0.x, s0.y, 0.9);
                g.fillCircle(s1.x, s1.y, 0.9);
            }
        }
        // Hide rail (the batten the panels hang from).
        g.lineStyle(1.5, mulC(woodDk, s), 1);
        const ra = midPt(f, -1, hTop + 0.4), rb = midPt(f, 1, hTop + 0.4);
        g.lineBetween(ra.x, ra.y, rb.x, rb.y);

        // Arrow scars: stubs shot into the hides (front + right faces).
        if (f.fd === 1 || f.fp === 1) {
            const nx = faceNx(f), ny = faceNy(f);
            const nn = Math.hypot(nx, ny) || 1;
            const stubs: Array<[number, number]> = f.fd === 1 ? [[0.38, 20], [-0.48, 16.8]] : [[0.14, 21.5]];
            for (const [su, sv] of stubs) {
                const base = midPt(f, su, sv);
                const ex = base.x + (nx / nn) * 3.6, ey = base.y + (ny / nn) * 3.6 + 1.2;
                g.lineStyle(1.5, own(0x2f2418), 1);
                g.lineBetween(base.x, base.y, ex, ey);
                g.fillStyle(own(0xa8433a), 1);
                g.fillRect(ex - 1.2, ey - 1.1, 2.4, 2.2);
            }
            // A pale nick where a shaft glanced off.
            g.lineStyle(1.2, mulC(woodLt, 1.05), 0.8);
            const n0 = midPt(f, -0.15, 23.4), n1 = midPt(f, 0.05, 22.6);
            g.lineBetween(n0.x, n0.y, n1.x, n1.y);
        }
        // Rear hatch (the crew door) on the back face.
        if (f.fd === -1) {
            poly([midPt(f, -0.26, h0 + 0.4), midPt(f, 0.26, h0 + 0.4), midPt(f, 0.26, 16.2), midPt(f, -0.26, 16.2)], mulC(own(0x2c2117), s));
            g.lineStyle(1.2, mulC(woodDk, s), 1);
            const da = midPt(f, -0.26, 16.2), db = midPt(f, 0.26, 16.2);
            g.lineBetween(da.x, da.y, db.x, db.y);
        }
    }

    // ====================== CROWN — FIGHTING TOP ========================
    // Machicolation lip band (slight overhang).
    for (const f of FACES) {
        if (faceNy(f) <= 0.02) continue;
        const s = faceShade(f);
        const lp = (u: number, v: number): Pt =>
            f.fd !== 0 ? B(f.fd * (CS + 0.6), u * (CS + 0.6), v) : B(u * (CS + 0.6), f.fp * (CS + 0.6), v);
        poly([lp(-1, lipB), lp(1, lipB), lp(1, lipT), lp(-1, lipT)], mulC(woodBase, s * 0.82));
        g.lineStyle(1.1, plankLn, 0.8);
        const a = lp(-1, lipB), b = lp(1, lipB);
        g.lineBetween(a.x, a.y, b.x, b.y);
        if (!ironwork) {
            // L1 rope lashings at the lip corners.
            g.lineStyle(1.3, rope, 0.95);
            for (const uu of [-0.88, 0.88]) {
                const r0 = lp(uu, lipB + 0.3), r1 = lp(uu, lipT - 0.3);
                g.lineBetween(r0.x, r0.y, r1.x, r1.y);
            }
        }
    }

    // Crenel profile: 3 merlons; the FRONT face is the gate — two posts only.
    const crenelPts = (f: { fd: number; fp: number }, base: number): Pt[] => [
        crownPt(f, -1, base), crownPt(f, -1, merT), crownPt(f, -0.6, merT), crownPt(f, -0.6, parT),
        crownPt(f, -0.28, parT), crownPt(f, -0.28, merT), crownPt(f, 0.16, merT), crownPt(f, 0.16, parT),
        crownPt(f, 0.48, parT), crownPt(f, 0.48, merT), crownPt(f, 1, merT), crownPt(f, 1, base)
    ];
    const gatePts = (f: { fd: number; fp: number }, base: number, sd: number): Pt[] => [
        crownPt(f, sd * 1, base), crownPt(f, sd * 1, merT),
        crownPt(f, sd * 0.72, merT), crownPt(f, sd * 0.72, base)
    ];
    // Far walls seen from INSIDE (open top), then the floor, then near walls.
    for (const f of FACES) {
        if (faceNy(f) > 0.02) continue;
        if (f.fd === 1) { poly(gatePts(f, lipT, -1), interior); poly(gatePts(f, lipT, 1), interior); }
        else poly(crenelPts(f, lipT), interior);
    }
    poly([B(CS - 1.3, 0, lipT), B(0, CS - 1.3, lipT), B(-(CS - 1.3), 0, lipT), B(0, -(CS - 1.3), lipT)], mulC(interior, 1.25));
    for (const f of FACES) {
        if (faceNy(f) <= 0.02) continue;
        const s = faceShade(f);
        if (f.fd === 1) {
            poly(gatePts(f, lipT, -1), mulC(woodBase, s));
            poly(gatePts(f, lipT, 1), mulC(woodBase, s));
            if (gilt) {
                g.fillStyle(gold, 1);
                for (const sd of [-1, 1]) {
                    const c = crownPt(f, sd * 0.86, merT);
                    g.fillCircle(c.x, c.y - 0.6, 1.2);
                }
            }
        } else {
            poly(crenelPts(f, lipT), mulC(woodBase, s));
            g.lineStyle(1.1, plankLn, 0.45);
            const a = crownPt(f, -0.97, lipT + 2.4), b = crownPt(f, 0.97, lipT + 2.4);
            g.lineBetween(a.x, a.y, b.x, b.y);
            if (gilt) {
                // Gold caps: thin lines on the merlon tops — accents only.
                g.lineStyle(1.2, gold, 1);
                for (const [mu0, mu1] of [[-1, -0.6], [-0.28, 0.16], [0.48, 1]]) {
                    const m0 = crownPt(f, mu0 + 0.06, merT), m1 = crownPt(f, mu1 - 0.06, merT);
                    g.lineBetween(m0.x, m0.y, m1.x, m1.y);
                }
            }
        }
        // Corner edge for definition.
        g.lineStyle(1.2, mulC(woodDk, s), 0.9);
        const e0 = crownPt(f, 1, lipT), e1 = crownPt(f, 1, f.fd === 1 ? merT : merT);
        g.lineBetween(e0.x, e0.y, e1.x, e1.y);
    }

    // ===================== PENNANT (the red streamer) ===================
    {
        const poleBase = B(-CS * 0.8, 0, parT - 1.5);
        const poleTop = B(-CS * 0.8, 0, 46.5);
        g.lineStyle(1.6, own(0x4a3a28), 1);
        g.lineBetween(poleBase.x, poleBase.y, poleTop.x, poleTop.y);
        g.fillStyle(gilt ? gold : iron, 1);
        g.fillCircle(poleTop.x, poleTop.y - 0.8, 1.4);
        // Cloth streams to trailing (−along) with a constant leftward drape
        // bias (the shared prevailing-wind feel) — the bias also keeps the
        // cloth off the crown when the trail points straight down-screen.
        let fx = -axx - 0.45, fy = -axy;
        const fn = Math.hypot(fx, fy) || 1;
        fx /= fn; fy /= fn;
        // Cloth height axis runs PERPENDICULAR to the stream direction, so
        // the pennant never collapses when it streams up/down-screen.
        const qx = -fy, qy = fx;
        const segs = 6, segL = 2.7;
        let px0 = poleTop.x, py0 = poleTop.y + 1.2;
        let h0f = 4.6;
        for (let i = 0; i < segs; i++) {
            const w0 = Math.sin(time * ambW * 2 - i * 0.95) * (0.55 + i * 0.4)
                + Math.sin(time * ambW - i * 0.5) * 0.3;
            const w1 = Math.sin(time * ambW * 2 - (i + 1) * 0.95) * (0.55 + (i + 1) * 0.4)
                + Math.sin(time * ambW - (i + 1) * 0.5) * 0.3;
            const x1 = poleTop.x + fx * segL * (i + 1);
            const y1 = poleTop.y + 1.2 + fy * segL * (i + 1) * 0.5;
            const h1f = 4.6 - (i + 1) * 0.62;
            poly([
                { x: px0 + qx * (w0 - h0f / 2), y: py0 + qy * (w0 - h0f / 2) },
                { x: x1 + qx * (w1 - h1f / 2), y: y1 + qy * (w1 - h1f / 2) },
                { x: x1 + qx * (w1 + h1f / 2), y: y1 + qy * (w1 + h1f / 2) },
                { x: px0 + qx * (w0 + h0f / 2), y: py0 + qy * (w0 + h0f / 2) }
            ], i % 2 === 0 ? penn : pennDk);
            px0 = x1; py0 = y1; h0f = h1f;
        }
    }

    // Near wheels over the hull skirt, then the near-side ramp on top.
    for (const wh of wheels.slice(2)) { drawWheel(wh); drawChock(wh); }
    if (!rampFar) drawRamp();
}
