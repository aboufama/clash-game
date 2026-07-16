import type Phaser from 'phaser';

type G = Phaser.GameObjects.Graphics;
type Pt = [number, number];

/**
 * WAR ELEPHANT — design A: "Bastion Tusker".
 *
 * A ponderous grey-hide titan (0x8d8d99) built like a walking gatehouse:
 * plated forehead with a gold boss, four segmented armor bands wrapped over
 * the flanks, creased fan ears, thick ivory tusks curving up-and-out, a
 * banded trunk, and a small crimson-canopied howdah cinched to its back by
 * a two-strap crimson girth. NW light: lit crown/top-left, dark belly rim.
 *
 * MOTION CONTRACT (all deterministic f(time), bake-safe):
 *  - walk: EXACT 1200 ms stride — diagonal leg pairs, body roll + bob, head
 *    counter-sway, trunk swing (lagged), crest bob; every term closes on
 *    1200 ms.
 *  - idle: ONE 2000 ms period (250 ms multiple) — ear fan (k=1, ±2.6 wpx),
 *    trunk curl (k=1, ~2.8 wpx at the tip) + lateral flick (k=2), weight
 *    shift (k=1), breath lift, tail sway. Tip displacement clears the
 *    1.5 world-px probe threshold.
 *  - attack (delay 2000): head + trunk REAR back through the 620 ms windup
 *    (ears flare), then DRIVE forward-down over the first 90 ms after the
 *    damage tick — the battering blow that fells walls — with a dust burst
 *    + shock lines decaying over ~340 ms and a 480 ms settle.
 *
 * FACING: full 8-direction consumer. All geometry is built on along-aim /
 * across-aim iso axes (0.5 vertical squash); near/far ordering (legs, ears,
 * tusks, head-vs-body, tail, howdah faces) flips with cos/sin signs.
 *
 * LEVELS: L1 hardened leather + bronze boss; L2 riveted iron; L3 dark steel
 * with gold seams, gold boss/ferrules and a sandstone-and-gold howdah
 * (accents only — no white masses). Enemy palette: darker, red-shifted.
 */

const STRIDE_MS = 1200; // exact walk period (TROOP_PARAMS stride)
const IDLE_MS = 2000;   // exact idle period (250 ms multiple)
const WINDUP_MS = 620;  // rear-back before the damage tick
const STRIKE_MS = 240;  // drive/impact window after the tick
const TAU = Math.PI * 2;
const GROUND_Y = 10;

// Body ellipsoid (world units): center along-aim/height + semi-axes
// (along, across, up). The projected silhouette is computed exactly.
const BODY_D = -1.5;
const BODY_H = 13.4;
const BODY_LD = 11.6;
const BODY_LW = 6.6;
const BODY_LH = 6.9;

function clamp01(v: number): number {
    return v < 0 ? 0 : v > 1 ? 1 : v;
}

function easeOut(t: number): number {
    return 1 - (1 - t) * (1 - t);
}

/** Per-channel colour multiply (owner red-shift + shading). */
function chan(c: number, mr: number, mg: number, mb: number): number {
    const r = Math.max(0, Math.min(255, Math.round(((c >> 16) & 0xff) * mr)));
    const g = Math.max(0, Math.min(255, Math.round(((c >> 8) & 0xff) * mg)));
    const b = Math.max(0, Math.min(255, Math.round((c & 0xff) * mb)));
    return (r << 16) | (g << 8) | b;
}

function shade(c: number, m: number): number {
    return chan(c, m, m, m);
}

/** One thick limb segment as a screen-space quad (the hLimb idiom). */
function limbQuad(g: G, color: number, x0: number, y0: number, x1: number, y1: number, w: number): void {
    const dx = x1 - x0, dy = y1 - y0;
    const len = Math.hypot(dx, dy) || 1;
    const nx = (-dy / len) * (w / 2), ny = (dx / len) * (w / 2);
    g.fillStyle(color, 1);
    g.beginPath();
    g.moveTo(x0 + nx, y0 + ny);
    g.lineTo(x1 + nx, y1 + ny);
    g.lineTo(x1 - nx, y1 - ny);
    g.lineTo(x0 - nx, y0 - ny);
    g.closePath();
    g.fillPath();
}

function fillPoly(g: G, pts: Pt[], color: number, alpha: number = 1): void {
    g.fillStyle(color, alpha);
    g.beginPath();
    g.moveTo(pts[0][0], pts[0][1]);
    for (let i = 1; i < pts.length; i++) g.lineTo(pts[i][0], pts[i][1]);
    g.closePath();
    g.fillPath();
}

function strokePts(g: G, pts: Pt[], width: number, color: number, alpha: number = 1): void {
    g.lineStyle(width, color, alpha);
    g.beginPath();
    g.moveTo(pts[0][0], pts[0][1]);
    for (let i = 1; i < pts.length; i++) g.lineTo(pts[i][0], pts[i][1]);
    g.strokePath();
}

interface AtkState {
    windup: number;
    strike: number;
    age: number;
    inCombat: boolean;
}

/** Attack cycle locked to the damage tick (the TroopRenderer contract):
 *  windup ramps 0→1 through the last WINDUP_MS before the tick, strike
 *  decays 1→0 through the first STRIKE_MS after it; stale ages (replays)
 *  free-run on time % delay. attackAge < 0 = not in combat. */
function atkState(time: number, attackAge: number, attackDelay: number, windupMs: number, strikeMs: number): AtkState {
    if (attackAge < 0 || attackDelay <= 0) return { windup: 0, strike: 0, age: Infinity, inCombat: false };
    let age = attackAge;
    if (age > attackDelay + 600) age = time % attackDelay;
    const remaining = attackDelay - age;
    let windup = 0;
    if (remaining <= 0) windup = 1;
    else if (remaining <= windupMs) windup = 1 - remaining / windupMs;
    const strike = strikeMs > 0 && age <= strikeMs ? 1 - age / strikeMs : 0;
    return { windup, strike, age, inCombat: true };
}

export function drawWarelephantA(
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
    const fa = facingAngle || 0;
    const cf = Math.cos(fa), sf = Math.sin(fa);

    // ------------------------------ palette ------------------------------
    const own = (c: number): number => (isPlayer ? c : chan(c, 0.93, 0.8, 0.82));
    const ownM = (c: number): number => (isPlayer ? c : chan(c, 0.95, 0.87, 0.87));
    const hide = own(0x8d8d99);
    const hideLit = own(0xa4a4b0);
    const hideDark = own(0x73737e);
    const hideDeep = own(0x5b5b65);
    const ivory = ownM(0xe9e3d2);
    const ivoryDk = ownM(0xc8c0aa);
    const crimson = own(0xa8322a);
    const crimsonLit = own(0xc04a3c);
    const crimsonDk = own(0x7c231d);
    const eyeC = 0x1c1a20;

    let plate: number, plateLit: number, plateEdge: number, boss: number, bossRim: number;
    let wood: number, woodDk: number, trim: number, rivet: number;
    if (troopLevel >= 3) {
        // Refined: dark steel, warm sandstone howdah, gold ACCENTS only.
        plate = own(0x4a505a); plateLit = own(0x6d7480); plateEdge = own(0x2f333b);
        boss = ownM(0xffd700); bossRim = ownM(0xb8860b);
        wood = own(0xbfb49a); woodDk = own(0x8f866c);
        trim = ownM(0xdaa520); rivet = ownM(0xdaa520);
    } else if (troopLevel >= 2) {
        // Iron: riveted plate over the same hide.
        plate = own(0x565b64); plateLit = own(0x7c828d); plateEdge = own(0x373b42);
        boss = ownM(0xc9a227); bossRim = ownM(0x8a6f1a);
        wood = own(0x77572f); woodDk = own(0x50391e);
        trim = own(0x8f959f); rivet = own(0x2e3138);
    } else {
        // Humble: hardened leather straps, bronze boss, plain timber howdah.
        plate = own(0x6b4a32); plateLit = own(0x82593c); plateEdge = own(0x46301f);
        boss = ownM(0xb08d57); bossRim = ownM(0x7d6138);
        wood = own(0x7a5a34); woodDk = own(0x523c22);
        trim = own(0x8b6b40); rivet = own(0x3c2a1a);
    }

    // --------------------------- gait / idle rig --------------------------
    let bob = 0, roll = 0, headSwayW = 0, trunkSwayW = 0, crestBobH = 0, tailSwayW = 0;
    let earFanW = 0, trunkCurlH = 0, phase = 0;
    if (isMoving) {
        phase = (((time % STRIDE_MS) + STRIDE_MS) % STRIDE_MS) / STRIDE_MS;
        const s = Math.sin(phase * TAU);
        bob = Math.abs(s) * 1.15;                              // ponderous heave
        roll = s * 0.9;                                        // lateral lumber
        headSwayW = -s * 1.5;                                  // counter-sway
        trunkSwayW = Math.sin(phase * TAU - 1.1) * 2.6;        // trunk trails the gait
        crestBobH = Math.sin(phase * TAU - 0.7) * 1.2;         // crest bobs late
        tailSwayW = Math.sin(phase * TAU + 1.6) * 1.4;
        earFanW = Math.abs(Math.sin(phase * TAU - 0.6)) * 1.1; // ears jog
    } else {
        const it = (((time % IDLE_MS) + IDLE_MS) % IDLE_MS) / IDLE_MS;
        const k1 = Math.sin(it * TAU);
        const k2 = Math.sin(it * TAU * 2 + 1.3);
        roll = k1 * 1.0;                                       // weight shift
        bob = Math.max(0, k1) * 0.5;                           // breath lift
        earFanW = Math.sin(it * TAU + 0.9) * 2.6;              // ear fan (k=1)
        trunkCurlH = Math.max(0, Math.sin(it * TAU - 0.5)) * 2.8; // trunk curl (k=1)
        trunkSwayW = k2 * 1.6;                                 // lateral flick (k=2)
        crestBobH = k2 * 0.8;
        headSwayW = k1 * 0.6;
        tailSwayW = Math.sin(it * TAU + 2.2) * 1.2;
    }

    // ------------------------------ attack -------------------------------
    const atk = atkState(time, attackAge, attackDelay || 2000, WINDUP_MS, STRIKE_MS);
    let rear = 0, slam = 0, dust = 0;
    if (!isMoving && atk.inCombat) {
        if (atk.strike > 0) {
            slam = easeOut(clamp01(atk.age / 90)); // the battering drive
            rear = 1 - slam;
        } else if (atk.windup > 0) {
            rear = easeOut(atk.windup);
        } else if (atk.age <= 720) {
            slam = 1 - easeOut(clamp01((atk.age - STRIKE_MS) / (720 - STRIKE_MS)));
        }
        if (atk.age >= 0 && atk.age <= 340) {
            dust = atk.age < 90 ? atk.age / 90 : clamp01(1 - (atk.age - 90) / 250);
        }
        earFanW += 2.4 * rear - 1.4 * slam; // ears flare on the rear, pin on the drive
    }
    const leanD = -1.8 * rear + 2.6 * slam;     // whole-body lunge
    const headD = -3.4 * rear + 4.8 * slam;     // head rears back / drives forward
    const headH = 4.5 * rear - 3.8 * slam;      // ...and up / down

    // -------------------------- iso point helpers ------------------------
    // d = along facing (forward +), w = across, h = height above ground.
    const pt = (d: number, w: number, h: number): Pt =>
        [cf * d - sf * w, (sf * d + cf * w) * 0.5 + GROUND_Y - h];
    const bp = (d: number, w: number, h: number): Pt => pt(d + leanD, w + roll, h + bob);
    const hp = (d: number, w: number, h: number): Pt =>
        pt(d + leanD + headD, w + roll + headSwayW, h + bob + headH);

    const headBehind = sf < -0.05;      // facing up-screen: head draws behind body
    const nearS = cf >= 0 ? 1 : -1;     // which lateral side is nearer the camera

    // ---------------------------- contact shadow -------------------------
    const [shx, shy] = pt(BODY_D + leanD * 0.4, 0, 0);
    g.fillStyle(0x000000, 0.3);
    g.fillEllipse(shx, shy + 0.2,
        Math.abs(cf) * 27 + Math.abs(sf) * 15,
        Math.abs(sf) * 13.5 + Math.abs(cf) * 7.5);

    // -------------------------------- legs -------------------------------
    // Diagonal pairs; far pair darkest. Feet stay planted while the body
    // (hips) carries the roll/weight shift.
    const legs = [
        { d: 6.2, w: 4.3, po: 0 },
        { d: -8.6, w: -4.3, po: 0 },
        { d: 6.2, w: -4.3, po: Math.PI },
        { d: -8.6, w: 4.3, po: Math.PI }
    ].sort((a, b) => (sf * a.d + cf * a.w) - (sf * b.d + cf * b.w));
    legs.forEach((leg, idx) => {
        const near = idx >= 2;
        const swing = isMoving ? Math.sin(phase * TAU + leg.po) * 2.5 : 0;
        const lift = isMoving ? Math.max(0, Math.sin(phase * TAU + leg.po + 0.5)) * 1.8 : 0;
        const tone = near ? hideDark : hideDeep;
        const [hx0, hy0] = bp(leg.d + swing * 0.35, leg.w * 0.92, 10.5);
        const [ax0, ay0] = pt(leg.d + swing, leg.w, lift + 2.0);
        limbQuad(g, tone, hx0, hy0, ax0, ay0, 3.6);
        const [fx, fy] = pt(leg.d + swing, leg.w, lift + 0.9);
        g.fillStyle(shade(tone, 0.85), 1);
        g.fillEllipse(fx, fy, 4.8, 2.4);
        if (near) {
            g.fillStyle(ivoryDk, 1);
            for (const tw of [-0.9, 0.9]) {
                const [tx, ty] = pt(leg.d + swing + 1.9, leg.w + tw, lift + 0.8);
                g.fillEllipse(tx, ty, 1.3, 0.9);
            }
        }
    });

    // --------------------------- head assembly ---------------------------
    const drawEar = (s: number, far: boolean): void => {
        const fan = earFanW;
        const tone = far ? hideDeep : hideDark;
        const a1 = hp(11.3, s * 3.6, 17.8);
        const a2 = hp(12.2, s * 3.4, 11.8);
        const t1 = hp(9.4, s * (8.6 + fan), 19.6 + fan * 0.3);
        const t2 = hp(8.2, s * (9.9 + fan * 1.2), 14.6);
        const t3 = hp(9.9, s * (7.7 + fan * 0.7), 10.6);
        fillPoly(g, [a1, t1, t2, t3, a2], tone, 1);
        // lit outer rim + the two creases of the fan
        strokePts(g, [a1, t1, t2], 0.9, far ? hideDark : hide, 1);
        const c0 = hp(11.6, s * 3.9, 15.2);
        const c1 = hp(9.2, s * (7.9 + fan), 17.4);
        const c2 = hp(8.9, s * (8.7 + fan), 13.6);
        g.lineStyle(0.7, hideDeep, 1);
        g.lineBetween(c0[0], c0[1], c1[0], c1[1]);
        g.lineBetween(c0[0], c0[1], c2[0], c2[1]);
    };

    const drawTusk = (s: number, far: boolean): void => {
        const tone = far ? ivoryDk : ivory;
        const t1 = hp(15.4, s * 2.7, 9.6);
        const t2 = hp(18.2, s * 4.1, 10.4);
        const t3 = hp(19.9, s * 5.1, 14.0);
        limbQuad(g, tone, t1[0], t1[1], t2[0], t2[1], 2.5);
        limbQuad(g, tone, t2[0], t2[1], t3[0], t3[1], 1.9);
        g.fillStyle(tone, 1);
        g.fillCircle(t2[0], t2[1], 1.2);
        g.fillCircle(t3[0], t3[1], 0.95);
        // root ferrule: leather/iron collar, gold at L3
        g.fillStyle(troopLevel >= 3 ? trim : ivoryDk, 1);
        g.fillCircle(t1[0], t1[1], 1.45);
    };

    const drawTrunk = (): void => {
        const tipDrive = 4.4 * slam - 3.8 * rear;
        const tipLift = 8.2 * rear - 1.6 * slam + trunkCurlH;
        for (let i = 0; i <= 6; i++) {
            const t = i / 6, t2 = t * t;
            const d = 16.2 + t * 2.6 + t2 * tipDrive;
            const h = Math.max(0.9, 12.4 - t * 10.6 + t2 * tipLift);
            const w = trunkSwayW * t2;
            const [x, y] = hp(d, w, h);
            g.fillStyle(i % 2 ? hideDark : hide, 1); // banded trunk
            g.fillCircle(x, y, 2.55 - t * 1.25);
            if (i === 6) {
                g.fillStyle(hideDeep, 1);
                g.fillCircle(x, y + 0.3, 0.55); // nostril
            }
        }
    };

    const drawPlate = (): void => {
        const pTL = hp(11.6, -4.3, 18.9), pTR = hp(11.6, 4.3, 18.9);
        const pML = hp(14.6, -4.7, 15.6), pMR = hp(14.6, 4.7, 15.6);
        const pBL = hp(16.4, -2.4, 12.3), pBR = hp(16.4, 2.4, 12.3);
        fillPoly(g, [pTL, pTR, pMR, pBR, pBL, pML], plate, 1);
        fillPoly(g, [pTL, pTR, pMR, pML], plateLit, 1); // NW-lit brow facet
        strokePts(g, [pTL, pTR, pMR, pBR, pBL, pML, pTL], 0.8, plateEdge, 1);
        if (troopLevel >= 3) {
            g.lineStyle(0.8, trim, 1); // gold mid-seam
            g.lineBetween(pML[0], pML[1], pMR[0], pMR[1]);
        }
        if (troopLevel >= 2) {
            g.fillStyle(rivet, 1);
            for (const [rd, rw, rh] of [[12.1, -3.6, 18.3], [12.1, 3.6, 18.3], [14.7, -3.9, 15.2], [14.7, 3.9, 15.2]]) {
                const [rx, ry] = hp(rd, rw, rh);
                g.fillCircle(rx, ry, 0.5);
            }
        }
        const [bx, by] = hp(13.5, 0, 16.3); // the gold boss
        g.fillStyle(bossRim, 1);
        g.fillCircle(bx, by, 1.9);
        g.fillStyle(boss, 1);
        g.fillCircle(bx, by, 1.35);
        g.fillStyle(0xffffff, 0.9);
        g.fillCircle(bx - 0.45, by - 0.45, 0.45);
    };

    const drawEyes = (): void => {
        if (sf < -0.35) return; // facing away
        for (const s of [-1, 1]) {
            if (s * cf < -0.15 && Math.abs(sf) < 0.75) continue; // far side hidden
            const [ex, ey] = hp(12.3, s * 4.6, 13.6);
            g.fillStyle(eyeC, 1);
            g.fillCircle(ex, ey, 0.7);
        }
    };

    const drawNeck = (): void => {
        // Thick wedge keeping head and body one mass through the rear/drive
        // extremes (and from behind).
        const [n0x, n0y] = bp(8.2, 0, 14.6);
        const [n1x, n1y] = hp(12.0, 0, 14.4);
        limbQuad(g, hide, n0x, n0y, n1x, n1y, 8.6);
    };

    const drawHeadBall = (): void => {
        const [hx, hy] = hp(13.0, 0, 14.2);
        g.fillStyle(hideDark, 1);
        g.fillEllipse(hx, hy, 10.8, 11.6);
        g.fillStyle(hide, 1);
        g.fillEllipse(hx - 0.5, hy - 0.8, 9.9, 10.6);
        g.fillStyle(hideLit, 1);
        g.fillEllipse(hx - 1.6, hy - 2.6, 5.6, 4.6);
    };

    const drawHeadAssembly = (): void => {
        if (headBehind) {
            drawTrunk();
            drawTusk(-nearS, true);
            drawTusk(nearS, false);
            drawPlate();
            drawHeadBall();
            drawEar(-nearS, true);
            drawEar(nearS, false);
        } else {
            drawNeck();
            drawEar(-nearS, true);
            drawHeadBall();
            drawEar(nearS, false);
            drawPlate();
            drawEyes();
            drawTusk(-nearS, true);
            drawTusk(nearS, false);
            drawTrunk();
        }
    };

    const drawTail = (): void => {
        const r0 = bp(-12.6, 0, 16.2);
        const r1 = bp(-14.4, tailSwayW, 11.0);
        const r2 = bp(-15.1, tailSwayW * 1.5, 7.4);
        limbQuad(g, hideDark, r0[0], r0[1], r1[0], r1[1], 1.3);
        limbQuad(g, hideDark, r1[0], r1[1], r2[0], r2[1], 1.0);
        g.fillStyle(hideDeep, 1);
        g.fillCircle(r2[0], r2[1], 1.15);
    };

    if (headBehind) drawHeadAssembly();
    if (sf >= -0.05) drawTail();

    // ------------------------------- body --------------------------------
    // Exact projected silhouette of the body ellipsoid (Cholesky of the
    // projected covariance), three passes: deep rim, hide, NW-lit crown.
    const a11 = cf * cf * BODY_LD * BODY_LD + sf * sf * BODY_LW * BODY_LW;
    const a12 = 0.5 * cf * sf * (BODY_LD * BODY_LD - BODY_LW * BODY_LW);
    const a22 = 0.25 * (sf * sf * BODY_LD * BODY_LD + cf * cf * BODY_LW * BODY_LW) + BODY_LH * BODY_LH;
    const b11 = Math.sqrt(a11);
    const b21 = a12 / b11;
    const b22 = Math.sqrt(Math.max(0.01, a22 - b21 * b21));
    const [bcx, bcy] = bp(BODY_D, 0, BODY_H);
    const bodyRing = (k: number, ox: number, oy: number): Pt[] => {
        const pts: Pt[] = [];
        for (let i = 0; i < 20; i++) {
            const th = (i / 20) * TAU;
            const c = Math.cos(th), s = Math.sin(th);
            pts.push([bcx + ox + b11 * c * k, bcy + oy + (b21 * c + b22 * s) * k]);
        }
        return pts;
    };
    fillPoly(g, bodyRing(1, 0, 0), hideDeep, 1);
    fillPoly(g, bodyRing(0.93, -0.4, -1.1), hide, 1);
    fillPoly(g, bodyRing(0.58, -2.0, -2.9), hideLit, 1);

    // ------------------- segmented flank armor + girth --------------------
    // Bands wrap the body cross-section, so they read at every heading.
    const bandArc = (d0: number, grow: number, phiMax: number): Pt[] => {
        const sc = Math.sqrt(Math.max(0.05, 1 - ((d0 - BODY_D) / BODY_LD) ** 2));
        const rw = BODY_LW * sc + grow, rh = BODY_LH * sc + grow;
        const pts: Pt[] = [];
        for (let i = 0; i <= 10; i++) {
            const phi = -phiMax + (i / 10) * 2 * phiMax;
            pts.push(bp(d0, rw * Math.sin(phi), BODY_H + rh * Math.cos(phi)));
        }
        return pts;
    };
    for (const d0 of [-9.1, -6.2, 2.6, 5.4]) {
        const arc = bandArc(d0, 0.4, 1.32);
        strokePts(g, arc, 3.4, plateEdge, 1);
        strokePts(g, arc, 2.2, plate, 1);
        strokePts(g, arc.slice(3, 7), 1.0, plateLit, 1); // lit top run
        g.fillStyle(rivet, 1);
        for (const iR of [1, 3, 5, 7, 9]) g.fillCircle(arc[iR][0], arc[iR][1], 0.5);
    }
    // crimson girth straps that cinch the howdah
    for (const d0 of [-5.2, -2.8]) {
        const arc = bandArc(d0, 0.5, 1.18);
        strokePts(g, arc, 4.8, crimsonDk, 1);
        strokePts(g, arc, 3.2, crimson, 1);
        if (troopLevel >= 3) {
            g.fillStyle(trim, 1);
            g.fillCircle(arc[0][0], arc[0][1], 0.7);
            g.fillCircle(arc[10][0], arc[10][1], 0.7);
        }
    }

    if (sf < -0.05) drawTail();

    // ------------------------------ howdah -------------------------------
    {
        const HD = -4, HA = 3.3, HB = 3.0, H0 = 19.6, H1 = 24.8;
        // Rotation-proof box: draw exactly the faces whose outward normals
        // point down-screen; lit when the normal points screen-left (NW sun).
        const face = (d1: number, w1: number, d2: number, w2: number, normalX: number): void => {
            const tone = normalX < -0.05 ? wood : woodDk;
            const q1 = bp(d1, w1, H0), q2 = bp(d2, w2, H0);
            const q3 = bp(d2, w2, H1), q4 = bp(d1, w1, H1);
            fillPoly(g, [q1, q2, q3, q4], tone, 1);
            g.lineStyle(1, troopLevel >= 3 ? trim : woodDk, 1); // top rail
            g.lineBetween(q4[0], q4[1], q3[0], q3[1]);
        };
        if (sf > 0.05) face(HD + HA, -HB, HD + HA, HB, cf);   // front
        if (sf < -0.05) face(HD - HA, HB, HD - HA, -HB, -cf); // back
        if (cf > 0.05) face(HD + HA, HB, HD - HA, HB, -sf);   // +w side
        if (cf < -0.05) face(HD - HA, -HB, HD + HA, -HB, sf); // -w side
        // crimson canopy: base sheet + puffed dome
        const c1 = bp(HD + HA, HB, H1), c2 = bp(HD + HA, -HB, H1);
        const c3 = bp(HD - HA, -HB, H1), c4 = bp(HD - HA, HB, H1);
        fillPoly(g, [c1, c2, c3, c4], crimsonDk, 1);
        const [rx, ry] = bp(HD, 0, H1 + 0.9);
        g.fillStyle(crimson, 1);
        g.fillEllipse(rx, ry, 7.2, 4.0);
        g.fillStyle(crimsonLit, 1);
        g.fillEllipse(rx - 0.9, ry - 0.9, 4.6, 2.3);
        if (troopLevel >= 3) {
            const [fx, fy] = bp(HD, 0, H1 + 2.7); // gold finial
            g.fillStyle(trim, 1);
            g.fillCircle(fx, fy, 0.9);
        }
        // the crest: pole + crimson plume, bobbing with the gait
        const crestLeanD = -2.0 * rear + 2.6 * slam;
        const pb = bp(HD + HA * 0.7, 0, H1 + 0.6);
        const tip = bp(HD + HA * 0.7 + crestLeanD * 0.6, 0, H1 + 5.4 + crestBobH);
        g.lineStyle(1, woodDk, 1);
        g.lineBetween(pb[0], pb[1], tip[0], tip[1]);
        const tp = bp(HD + HA * 0.7 - 2.9 + crestLeanD, 0, H1 + 4.4 + crestBobH * 0.7);
        g.fillStyle(crimson, 1);
        g.fillTriangle(tip[0], tip[1] - 1.2, tip[0], tip[1] + 1.2, tp[0], tp[1]);
        g.fillCircle(tip[0], tip[1], 1.4);
        g.fillStyle(crimsonLit, 1);
        g.fillCircle(tip[0] - 0.5, tip[1] - 0.5, 0.7);
    }

    if (!headBehind) drawHeadAssembly();

    // ------------------------ battering-blow impact -----------------------
    if (dust > 0.03) {
        const e = clamp01(atk.age / 340);
        g.fillStyle(ownM(0xcfc8b6), Math.min(1, dust * 0.85));
        for (let i = 0; i < 4; i++) {
            const aa = i * 1.9 + 0.7;
            const dd = 19.5 + Math.cos(aa) * (2 + e * 3.5);
            const ww = Math.sin(aa) * (2.5 + e * 3.5);
            const [dx, dy] = pt(dd, ww, 1.2 + Math.abs(Math.sin(aa * 2)) * (1 + e * 2));
            g.fillCircle(dx, dy, 1.1 + e * 1.1);
        }
        g.lineStyle(1.2, ownM(0xf2ead8), dust * 0.9);
        for (const s of [-1, 1]) {
            const p1 = pt(18.6, s * 2.4, 3.2);
            const p2 = pt(23.2, s * 5.2, 6.4);
            g.lineBetween(p1[0], p1[1], p2[0], p2[1]);
        }
    }
}
