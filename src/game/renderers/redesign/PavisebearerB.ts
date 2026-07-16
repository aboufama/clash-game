import type Phaser from 'phaser';

/**
 * PAVISE BEARER — design B: "THE WALKING WALL"
 *
 * A hulking baggage-porter almost hidden behind a man-tall keeled pavise —
 * the shield IS the silhouette. Facing the enemy you see a painted heraldic
 * wall with a helm crown and a pennant peeking over the rim; facing away you
 * see the honest working side: batten frame, iron carry-handle, the porter's
 * pack-frame with bedroll and his company pennant on a pole.
 *
 * Stance language:
 *  - WALK (600 ms stride): slow deliberate stomp, shield carried a palm off
 *    the ground, swaying with the steps, body leaning into the load.
 *  - IDLE / GUARD (planted): the pavise is grounded like a deployed wall and
 *    the porter crouches behind it — the blocking stance while he soaks
 *    redirected shots. Breath + pennant-wave on an exact 2000 ms loop.
 *  - ATTACK (shield shove, delay 1300): 420 ms windup drags the wall back and
 *    coils the body; the 200 ms strike rams the whole slab forward.
 *
 * Level language (body stays wood-and-iron, per the art guide):
 *  L1 planked wood pavise, iron straps, painted owner roundel.
 *  L2 steel-faced slab, riveted, owner chevron band.
 *  L3 parchment-cream field with GOLD rim/boss as subtle accents (never a
 *     white mass), gold-trimmed kettle helm with a small plume.
 *
 * AUTHORED PERIODS (the bake must use these): stride 600 ms · windup 420 ms ·
 * strike 200 ms · idle period 2000 ms (all idle terms are exact harmonics of
 * 2000 — a 250 ms multiple; helm/pennant displacement >= 1.5 px so the loop
 * survives quantization). All motion is a deterministic f(time).
 */

type G = Phaser.GameObjects.Graphics;
type Pt = [number, number];

const TAU = Math.PI * 2;

/** Multiply a 0xRRGGBB colour toward dark (m<1) or light (m>1). */
function pvbShade(c: number, m: number): number {
    const r = Math.min(255, Math.max(0, Math.round(((c >> 16) & 0xff) * m)));
    const g = Math.min(255, Math.max(0, Math.round(((c >> 8) & 0xff) * m)));
    const b = Math.min(255, Math.max(0, Math.round((c & 0xff) * m)));
    return (r << 16) | (g << 8) | b;
}

/** One closed polygon at uniform alpha (never stacked sub-shapes). */
function pvbPoly(g: G, pts: Pt[], color: number, alpha = 1): void {
    g.fillStyle(color, alpha);
    g.beginPath();
    g.moveTo(pts[0][0], pts[0][1]);
    for (let i = 1; i < pts.length; i++) g.lineTo(pts[i][0], pts[i][1]);
    g.closePath();
    g.fillPath();
}

/** Thick limb segment from (x0,y0) to (x1,y1). */
function pvbLimb(g: G, color: number, x0: number, y0: number, x1: number, y1: number, w: number): void {
    const dx = x1 - x0, dy = y1 - y0;
    const len = Math.hypot(dx, dy) || 1;
    const nx = (-dy / len) * (w / 2), ny = (dx / len) * (w / 2);
    pvbPoly(g, [[x0 + nx, y0 + ny], [x1 + nx, y1 + ny], [x1 - nx, y1 - ny], [x0 - nx, y0 - ny]], color);
}

const pvbEaseIn = (t: number): number => t * t;
const pvbEaseOut = (t: number): number => 1 - (1 - t) * (1 - t);

/** Per-slot bake-param overrides (DesignRegistry.designBakeParams): authored
 *  periods that differ from the TROOP_PARAMS row (500/1200/350/180, no
 *  idleMs). Walk closes exactly on the 600 ms stride; windup 420 / strike
 *  200 lock to the damage tick at delay 1300 (= runtime TroopDefinitions
 *  attackDelay); idle closes on the exact 2000 ms period. */
export const PARAMS: import('./DesignRegistry').DesignParamsExport = {
    pavisebearer: { stride: 600, delay: 1300, windup: 420, strike: 200, idleMs: 2000 },
};

export function drawPavisebearerB(
    g: G,
    isPlayer: boolean,
    isMoving: boolean,
    facingAngle: number,
    troopLevel: number,
    time: number,
    attackAge: number,
    attackDelay: number,
    _driver: number
): void {
    const lvl = Math.max(1, Math.min(3, Math.round(troopLevel || 1)));

    // ---------------- palette ----------------
    const FIELD = isPlayer ? 0x2e6e8e : 0x8e3230;   // owner heraldry hue
    const FIELD_DK = pvbShade(FIELD, 0.7);
    const CREAM = 0xd9d0b8;
    const GOLD = 0xb8912f, GOLD_LT = 0xdaa520;
    const WOOD = 0x7a5a3a, WOOD_DK = 0x54402a;
    const IRON = 0x4c5157, IRON_LT = 0x6a7078;
    const STEEL = 0x76808a;
    const SKIN = 0xd9a066;
    const GAMB = 0x8a7357, GAMB_DK = 0x6d5a44;      // padded gambeson
    const TROUSER = 0x4a3b2c;
    const BOOT = 0x2a211a;

    // ---------------- facing basis (iso squash 0.5) ----------------
    const a = facingAngle;
    const ca = Math.cos(a), sa = Math.sin(a);
    const fwx = (d: number): number => ca * d;               // along-aim
    const fwy = (d: number): number => sa * 0.5 * d;
    const acx = (w: number): number => -sa * w;              // across-aim
    const acy = (w: number): number => ca * 0.5 * w;
    const P = (d: number, w: number, y: number): Pt => [fwx(d) + acx(w), fwy(d) + acy(w) + y];

    // ---------------- gait: 600 ms stride ----------------
    const STRIDE = 600;
    const ph = (((time % STRIDE) + STRIDE) % STRIDE) / STRIDE;
    const swv = Math.sin(ph * TAU);
    const swing = isMoving ? swv * 2.7 : 0;
    const bob = isMoving ? Math.abs(swv) * 1.3 : 0;

    // ---------------- idle breath: exact harmonics of 2000 ms ----------------
    const ip = (((time % 2000) + 2000) % 2000) / 2000;
    const b1 = Math.sin(ip * TAU);              // 1st harmonic
    const b2 = Math.sin(ip * TAU * 2 + 1.1);    // 2nd harmonic
    const breathe = isMoving ? 0 : (b1 * 0.5 + 0.5) * 1.6;   // 0..1.6 px chest/helm rise
    const flutter = isMoving ? swv : b1;                     // pennant driver

    // ---------------- attack cycle locked to the damage tick ----------------
    const WINDUP = 420, STRIKE = 200;
    const delay = attackDelay || 1300;
    let windup = 0, strike = 0;
    if (attackAge >= 0 && delay > 0) {
        let age = attackAge;
        if (age > delay + 600) age = ((time % delay) + delay) % delay;
        const remaining = delay - age;
        if (remaining <= 0) windup = 1;
        else if (remaining <= WINDUP) windup = 1 - remaining / WINDUP;
        strike = age <= STRIKE ? 1 - age / STRIKE : 0;
    }

    // ---------------- stance ----------------
    const planted = !isMoving;                  // guard stance: pavise grounded
    const w = 8.5;                              // shield half-width
    const th = 3.2;                             // slab thickness
    const keel = 1.5;                           // central ridge protrusion
    const dBase = planted ? 8 : 7.5;
    const d = dBase - 3.5 * pvbEaseIn(windup) + 7 * pvbEaseOut(strike);
    const wOff = isMoving ? swv * 0.9 : 0;      // carried sway across the aim
    let sBot: number, sTop: number;
    if (planted) {
        const lift = 4.5 * pvbEaseIn(windup) + 1.5 * strike;
        sBot = 9.8 - lift;
        sTop = -18 - lift;
    } else {
        sBot = 6.4 - bob * 0.6;
        sTop = -20.6 - bob * 0.6;
    }
    const SP = (dd: number, ww: number, y: number): Pt => P(dd, ww + wOff, y);

    // body
    const lean = (isMoving ? 1.6 : 0.4) - 2.2 * pvbEaseIn(windup) + 2.6 * pvbEaseOut(strike);
    const bx = fwx(lean), by = fwy(lean);
    const crouch = planted ? 1.0 : 0;
    const bodyRise = bob + breathe * 0.7 - crouch * 0.9;
    const torsoY = -5.0 - bodyRise + by;
    const headRise = bob + breathe - crouch * 1.2;
    const headY = -15.5 - headRise + by;
    const shoulderY = -8.8 - bodyRise * 0.9 + by;
    const hipY = 2.6 - bodyRise * 0.5;

    // ---------------- contact shadow (ONE closed shape) ----------------
    g.fillStyle(0x000000, 0.2);
    g.fillEllipse(fwx(d * 0.38), 9.7 + fwy(d * 0.38), 19, 6.4);

    // ================= the pavise =================
    const drawShield = (): void => {
        const df = d + th / 2, db = d - th / 2, dk = df + keel;
        const FLb = SP(df, -w, sBot), FRb = SP(df, w, sBot);
        const FLt = SP(df, -w, sTop), FRt = SP(df, w, sTop);
        const BLb = SP(db, -w, sBot), BRb = SP(db, w, sBot);
        const BLt = SP(db, -w, sTop), BRt = SP(db, w, sTop);
        const Kb = SP(dk, 0, sBot), Kt = SP(dk, 0, sTop);

        const faceBase = lvl === 1 ? WOOD : lvl === 2 ? STEEL : CREAM;
        const rim = lvl === 1 ? IRON : lvl === 2 ? pvbShade(STEEL, 0.6) : GOLD;
        const rimLt = lvl === 1 ? IRON_LT : lvl === 2 ? pvbShade(STEEL, 0.85) : GOLD_LT;

        // side faces — draw exactly the ones whose outward normals point
        // down-screen (rotation-proof box rule).
        if (ca > 0.05) pvbPoly(g, [FRb, BRb, BRt, FRt], pvbShade(rim, 0.78));
        else if (ca < -0.05) pvbPoly(g, [FLb, BLb, BLt, FLt], pvbShade(rim, 0.78));

        if (sa < -0.03) {
            // BACK of the pavise: the working side — slim battens, a diagonal
            // brace and the iron carry-handle (frame, not a door).
            pvbPoly(g, [BLb, BRb, BRt, BLt], pvbShade(WOOD, 0.82));
            const bp = (u: number, v: number): Pt => SP(db - 0.6, u * w, sBot + (sTop - sBot) * v);
            pvbPoly(g, [bp(-0.9, 0.2), bp(0.9, 0.2), bp(0.9, 0.27), bp(-0.9, 0.27)], WOOD_DK);
            pvbPoly(g, [bp(-0.9, 0.72), bp(0.9, 0.72), bp(0.9, 0.79), bp(-0.9, 0.79)], WOOD_DK);
            pvbPoly(g, [bp(-0.82, 0.27), bp(-0.62, 0.27), bp(0.82, 0.72), bp(0.62, 0.72)], pvbShade(WOOD_DK, 0.9));
            pvbPoly(g, [bp(-0.3, 0.44), bp(0.3, 0.44), bp(0.3, 0.5), bp(-0.3, 0.5)], IRON);
        }
        if (sa > 0.03) {
            // FRONT: keeled painted face — two half-planes, NW-lit.
            const halfM = (side: -1 | 1): number => {
                const nx = ca - 0.45 * side * sa;
                const ny = sa * 0.5 + 0.225 * side * ca;
                const len = Math.hypot(nx, ny) || 1;
                return 0.98 + 0.22 * ((nx / len) * -0.707 + (ny / len) * -0.707);
            };
            pvbPoly(g, [FLb, Kb, Kt, FLt], pvbShade(faceBase, halfM(-1)));
            pvbPoly(g, [Kb, FRb, FRt, Kt], pvbShade(faceBase, halfM(1)));

            // face-plane mapper (u across -1..1 following the keel fold, v 0..1 up)
            const fp = (u: number, v: number): Pt =>
                SP(df + keel * (1 - Math.abs(u)), u * w, sBot + (sTop - sBot) * v);
            // keel highlight
            pvbPoly(g, [fp(-0.05, 0.02), fp(0.05, 0.02), fp(0.05, 0.98), fp(-0.05, 0.98)], pvbShade(faceBase, 1.14));
            // rim straps top/bottom + side rims (L3 gold stays a slim accent)
            const rimW = lvl === 3 ? 0.09 : 0.14;
            const bandH = lvl === 3 ? 0.06 : 0.09;
            const band = (v0: number, v1: number, col: number): void =>
                pvbPoly(g, [fp(-1, v0), fp(0, v0), fp(1, v0), fp(1, v1), fp(0, v1), fp(-1, v1)], col);
            band(1 - bandH, 1, rim);
            band(0, bandH, rim);
            pvbPoly(g, [fp(-1, 0), fp(-1 + rimW, 0), fp(-1 + rimW, 1), fp(-1, 1)], rim);
            pvbPoly(g, [fp(1 - rimW, 0), fp(1, 0), fp(1, 1), fp(1 - rimW, 1)], rim);

            const acrossLen = Math.hypot(sa, ca * 0.5); // screen length of 1 across-unit
            if (lvl === 1) {
                // plank seams + painted roundel
                pvbPoly(g, [fp(-0.53, 0.08), fp(-0.47, 0.08), fp(-0.47, 0.9), fp(-0.53, 0.9)], WOOD_DK);
                pvbPoly(g, [fp(0.47, 0.08), fp(0.53, 0.08), fp(0.53, 0.9), fp(0.47, 0.9)], WOOD_DK);
                const c = fp(0, 0.55);
                const ew = 9 * acrossLen, eh = (sBot - sTop) * 0.3;
                g.fillStyle(FIELD, 1);
                g.fillEllipse(c[0], c[1], ew, eh);
                g.fillStyle(CREAM, 1);
                g.fillEllipse(c[0], c[1], ew * 0.6, eh * 0.6);
                g.fillStyle(FIELD_DK, 1);
                g.fillEllipse(c[0], c[1], ew * 0.26, eh * 0.26);
            } else {
                // owner chevron band (one closed polygon)
                pvbPoly(g, [fp(-0.86, 0.5), fp(0, 0.66), fp(0.86, 0.5), fp(0.86, 0.36), fp(0, 0.52), fp(-0.86, 0.36)], FIELD);
                // rivets along the straps
                g.fillStyle(rimLt, 1);
                for (const u of [-0.68, -0.24, 0.24, 0.68]) {
                    const rTop = fp(u, 0.945), rBot = fp(u, 0.04);
                    g.fillRect(rTop[0] - 0.65, rTop[1] - 0.65, 1.3, 1.3);
                    g.fillRect(rBot[0] - 0.65, rBot[1] - 0.65, 1.3, 1.3);
                }
                if (lvl === 3) {
                    // gold boss — a subtle accent, not a mass
                    const c = fp(0, 0.56);
                    g.fillStyle(GOLD_LT, 1);
                    g.fillCircle(c[0], c[1], 2.3);
                    g.fillStyle(CREAM, 1);
                    g.fillCircle(c[0], c[1], 1.05);
                }
            }
        }
        // top cap (lightest — light from NW), keel wedge over it
        pvbPoly(g, [BLt, BRt, FRt, FLt], pvbShade(rim, 1.32));
        pvbPoly(g, [FLt, FRt, Kt], pvbShade(rim, 1.5));
    };

    // ================= the porter =================
    const drawPack = (): void => {
        // pack-frame on his back (opposite the facing): slim bedroll + pole
        const packY = -7.8 - bodyRise * 0.8 + by;
        const rl = P(-3.6, -3.2, packY), rr = P(-3.6, 3.2, packY);
        pvbLimb(g, 0x8a6a4a, rl[0] + bx, rl[1], rr[0] + bx, rr[1], 2.4);
        g.fillStyle(pvbShade(0x8a6a4a, 1.18), 1);
        g.fillCircle(rl[0] + bx, rl[1], 1.2);
        g.fillCircle(rr[0] + bx, rr[1], 1.2);
        // strap ticks on the roll
        g.fillStyle(0x5d4429, 1);
        const s1 = P(-3.6, -1.2, packY), s2 = P(-3.6, 1.2, packY);
        g.fillRect(s1[0] + bx - 0.5, s1[1] - 1.4, 1, 2.8);
        g.fillRect(s2[0] + bx - 0.5, s2[1] - 1.4, 1, 2.8);
        // pennant pole + owner pennant (always shows the team colour)
        const pb = P(-4.0, 2.0, -4.5 + by);
        const poleTopY = -27.2 - bodyRise * 0.5 + by;
        pvbLimb(g, IRON_LT, pb[0] + bx, pb[1], pb[0] + bx + 0.6, poleTopY, 1);
        const px0 = pb[0] + bx + 0.6, py0 = poleTopY;
        const tipX = px0 + 5.6 + flutter * 2.4;
        const tipY = py0 + 1.5 + (isMoving ? 0 : b2 * 0.7);
        pvbPoly(g, [[px0, py0 - 0.2], [tipX, tipY], [px0, py0 + 3.1]], FIELD);
        if (lvl === 3) {
            g.fillStyle(GOLD_LT, 1);
            g.fillRect(px0 - 0.7, py0 - 1.2, 1.4, 1.4); // gilt finial
        }
    };

    const packTowardViewer = sa < -0.03; // facing away -> pack faces the camera
    const shieldFirst = sa < 0;          // shield up-screen: draw it under the man

    if (shieldFirst) drawShield();

    // legs (draw the up-screen leg first)
    const legAcross = planted ? 3.3 : 2.7;
    const liftL = isMoving ? Math.max(0, swv) * 1.5 : 0;
    const liftR = isMoving ? Math.max(0, -swv) * 1.5 : 0;
    const hipL = P(0, -legAcross * 0.7, hipY);
    const hipR = P(0, legAcross * 0.7, hipY);
    const footL = P(swing, -legAcross, 9.2 - liftL);
    const footR = P(-swing, legAcross, 9.2 - liftR);
    const legs: Array<[Pt, Pt, number]> = [
        [hipL, footL, liftL],
        [hipR, footR, liftR],
    ];
    legs.sort((p, q) => p[1][1] - q[1][1]); // far (smaller screen y) first
    for (const [hip, foot] of legs) {
        pvbLimb(g, TROUSER, hip[0] + bx * 0.5, hip[1], foot[0], foot[1], 2.7);
        g.fillStyle(BOOT, 1);
        g.fillEllipse(foot[0], foot[1] + 0.4, 4.2, 2);
        if (lvl >= 2) { // greave plate
            pvbLimb(g, IRON_LT, foot[0] * 0.35 + (hip[0] + bx * 0.5) * 0.65, foot[1] * 0.35 + hip[1] * 0.65,
                foot[0] * 0.85 + (hip[0] + bx * 0.5) * 0.15, foot[1] * 0.85 + hip[1] * 0.15, 1.6);
        }
    }

    if (!packTowardViewer) drawPack(); // pack behind the torso

    // torso: broad padded jack with a dark rim for the silhouette
    g.fillStyle(pvbShade(GAMB, 0.52), 1);
    g.fillEllipse(bx, torsoY, 15.7, 13.7);
    g.fillStyle(GAMB, 1);
    g.fillEllipse(bx, torsoY, 14.2, 12.2);
    // NW light patch + belt + quilt seams
    g.fillStyle(pvbShade(GAMB, 1.18), 1);
    g.fillEllipse(bx - 2.6, torsoY - 2.8, 6.4, 4.4);
    g.fillStyle(GAMB_DK, 1);
    g.fillRect(bx - 6.4, torsoY + 3.6, 12.8, 2);
    g.fillRect(bx - 2.9, torsoY - 5.4, 1.2, 9);
    g.fillRect(bx + 1.7, torsoY - 5.4, 1.2, 9);

    // pauldrons
    for (const side of [-1, 1] as const) {
        const sx = bx + acx(side * 5.5), sy = shoulderY + acy(side * 5.5) + 0.4;
        if (lvl === 3) {
            g.fillStyle(GOLD_LT, 1);
            g.fillCircle(sx, sy, 3.1);
        }
        g.fillStyle(lvl === 1 ? 0x6a4f33 : IRON, 1);
        g.fillCircle(sx, sy, 2.7);
        g.fillStyle(lvl === 1 ? pvbShade(0x6a4f33, 1.25) : IRON_LT, 1);
        g.fillCircle(sx - 0.8, sy - 0.8, 1.2);
    }

    if (packTowardViewer) drawPack(); // pack faces the camera

    // head: kettle helm peeking over the rim
    g.fillStyle(SKIN, 1);
    g.fillEllipse(bx, headY + 2.6, 4.6, 3.4);          // jaw under the brim
    g.fillStyle(0x1c1712, 1);
    g.fillRect(bx - 2.3, headY + 1.7, 4.6, 1.2);       // eye-slit shadow
    if (lvl === 3) {
        g.fillStyle(GOLD_LT, 1);
        g.fillEllipse(bx, headY + 0.9, 10.6, 3.6);     // gilt brim edge
    }
    g.fillStyle(IRON, 1);
    g.fillEllipse(bx, headY + 0.7, 9.8, 3.1);          // kettle brim
    g.fillCircle(bx, headY - 1.4, 3.4);                // dome
    g.fillStyle(IRON_LT, 1);
    g.fillEllipse(bx - 1.1, headY - 2.3, 2.6, 1.7);    // NW glint
    if (lvl === 3) {                                   // small plume, breathes
        g.fillStyle(FIELD, 1);
        g.fillEllipse(bx + 0.4 + flutter * 0.8, headY - 5.2, 1.8, 3.2);
    }

    // arms: both hands on the carry frame at the shield's back
    const handY = sBot + (sTop - sBot) * 0.42;
    for (const side of [-1, 1] as const) {
        const sx = bx + acx(side * 5.5), sy = shoulderY + acy(side * 5.5) + 0.6;
        const h = SP(d - th / 2 - 0.4, side * w * 0.72, handY);
        pvbLimb(g, GAMB_DK, sx, sy, h[0], h[1], 2.4);
        g.fillStyle(IRON, 1);
        g.fillCircle(h[0], h[1], 1.7);
    }

    if (!shieldFirst) {
        drawShield();
        // knuckles wrapping the visible rim (sit ON the rim, never floating)
        if (sa > 0.05) {
            g.fillStyle(IRON_LT, 1);
            for (const side of [-1, 1] as const) {
                const k = SP(d + th / 2 + 0.2, side * (w - 0.1), handY);
                g.fillCircle(k[0], k[1], 1.05);
            }
        }
    }
}
