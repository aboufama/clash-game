import type Phaser from 'phaser';

type G = Phaser.GameObjects.Graphics;

/**
 * WAR ELEPHANT — design B: "The Siege Bull".
 *
 * Identity: MASS and MOMENTUM. A low-slung slate-grey bull elephant on a
 * ponderous 1000 ms amble (lateral-sequence gait, body roll to the support
 * side), carrying an armored howdah whose sway LAGS the body by a beat —
 * the top-heavy read that sells weight in motion. A mahout rides the neck
 * and leans into the charge.
 *
 * The trample (the unit's mechanical identity — one-strike wall kills that
 * never stop the walk cycle): MainScene keeps isMoving=true on a wall
 * strike, so the moving-strike branch here plays a HEAD TOSS — head, tusks
 * and trunk fling upward through the debris while the legs keep walking.
 * Standing attacks (buildings) are the opposite: rear back on the windup
 * (trunk coils, near front leg paws), then a downward tusk gore.
 *
 * Levels: L1 rope-rigged timber howdah → L2 iron chanfron, tusk caps and
 * flank skirt plates → L3 crimson caparison with gold TRIM (accents only,
 * per the art guide), gilded chanfron, pennant on the howdah finial.
 *
 * AUTHORED PERIODS (the bake must sample these):
 *   stride 1000 ms · windup 700 ms · strike 450 ms · idle 2000 ms
 * All motion is deterministic f(time); every idle term is an exact 1× or 2×
 * harmonic of the 2000 ms master period (a 250 ms multiple) and displaces
 * ≥1.5 world px (ear flap, trunk sway, tail swish), so it survives the
 * 1.35 px quantizer. The pennant flutters on the 1000 ms harmonic.
 *
 * Facing: full 360° parametric rig using the turret projection toolkit
 * (along-aim d, across-aim w, height h; iso squash 0.5). Parts are ordered
 * by their screen-depth key k(d,w) = d·sinA + w·cosA so all 8 baked
 * headings layer correctly (head group swaps to behind the body when the
 * bull walks up-screen).
 */

const TAU = Math.PI * 2;

const STRIDE_MS = 1000;
const WINDUP_MS = 700;
const STRIKE_MS = 450;
const IDLE_MS = 2000;

/** Multiply a 0xRRGGBB colour toward dark (m<1) or light (m>1). */
function shade(c: number, m: number): number {
    const r = Math.max(0, Math.min(255, Math.round(((c >> 16) & 0xff) * m)));
    const g = Math.max(0, Math.min(255, Math.round(((c >> 8) & 0xff) * m)));
    const b = Math.max(0, Math.min(255, Math.round((c & 0xff) * m)));
    return (r << 16) | (g << 8) | b;
}

/** Tapered thick segment: thickness along the screen-space normal (never a
 *  vertical offset — the art-guide strip rule). */
function strip(g: G, x1: number, y1: number, x2: number, y2: number,
    w1: number, w2: number, color: number, alpha = 1): void {
    const dx = x2 - x1, dy = y2 - y1;
    const len = Math.hypot(dx, dy) || 1;
    const nx = -dy / len, ny = dx / len;
    g.fillStyle(color, alpha);
    g.beginPath();
    g.moveTo(x1 + nx * w1, y1 + ny * w1);
    g.lineTo(x2 + nx * w2, y2 + ny * w2);
    g.lineTo(x2 - nx * w2, y2 - ny * w2);
    g.lineTo(x1 - nx * w1, y1 - ny * w1);
    g.closePath();
    g.fillPath();
}

/** Per-slot bake-param overrides (DesignRegistry.designBakeParams): authored
 *  periods that differ from the TROOP_PARAMS row (1200/3000/900/500, no
 *  idleMs). STRIDE_MS 1000 / WINDUP_MS 700 / STRIKE_MS 450; delay 2000 = the
 *  runtime TroopDefinitions attackDelay the bake must sample against; idle
 *  closes on IDLE_MS = 2000 (harmonics at 2000/1000, pennant 1000). */
export const PARAMS: import('./DesignRegistry').DesignParamsExport = {
    warelephant: { stride: 1000, delay: 2000, windup: 700, strike: 450, idleMs: 2000 },
};

export function drawWarelephantB(
    graphics: G,
    isPlayer: boolean,
    isMoving: boolean,
    facingAngle: number,
    troopLevel: number,
    time: number,
    attackAge: number,
    attackDelay: number,
    _driver: number
): void {
    const g = graphics;
    const lvl = Math.max(1, Math.min(3, Math.round(troopLevel)));

    // ---------------- attack-cycle state (the TroopRenderer contract) ------
    const delay = attackDelay > 0 ? attackDelay : 2000;
    let age = attackAge;
    const inCombat = age >= 0;
    if (inCombat && age > delay + 600) age = ((time % delay) + delay) % delay; // replay free-run
    let windup = 0;   // 0→1 anticipation before the damage tick
    let strike = 0;   // 1→0 impact decay after the tick
    if (inCombat) {
        const remaining = delay - age;
        if (remaining >= 0 && remaining <= WINDUP_MS) {
            const t = 1 - remaining / WINDUP_MS;
            windup = t * t; // ease-in: the rear-back gathers late
        }
        if (age >= 0 && age <= STRIKE_MS) {
            const t = age / STRIKE_MS;
            strike = (1 - t) * (1 - t); // sharp impact, fast decay
        }
    }

    // ---------------- gait + ambient scalars (all deterministic f(time)) ---
    const wt = (((time % STRIDE_MS) + STRIDE_MS) % STRIDE_MS) / STRIDE_MS;
    const iu = (((time % IDLE_MS) + IDLE_MS) % IDLE_MS) / IDLE_MS;
    const walking = isMoving;

    let roll: number, bob: number, howdahRoll: number, headLift: number;
    let trunkSwing: number, trunkCurl: number, earFlap: number, tailSwish: number;
    if (walking) {
        roll = Math.sin(TAU * wt) * 1.7;                       // mass onto the support side
        bob = Math.sin(TAU * 2 * wt) * 0.7;                    // two heavy beats per stride
        howdahRoll = Math.sin(TAU * (wt - 0.09)) * 2.3;        // the top mass LAGS — momentum
        headLift = Math.sin(TAU * 2 * wt + 2.2) * 0.7;
        trunkSwing = Math.sin(TAU * wt + 0.7) * 2.0;
        trunkCurl = 0.14 + 0.06 * Math.sin(TAU * wt);
        earFlap = (Math.sin(TAU * 2 * wt) * 0.5 + 0.5) * 1.0;
        tailSwish = Math.sin(TAU * wt + 1.9) * 2.0;
    } else {
        // Idle: exact 1×/2× harmonics of the 2000 ms master period.
        roll = Math.sin(TAU * iu) * 1.3;
        bob = Math.sin(TAU * 2 * iu) * 0.5;
        howdahRoll = Math.sin(TAU * (iu - 0.06)) * 1.6;
        headLift = Math.sin(TAU * iu + 0.8) * 0.7;
        trunkSwing = Math.sin(TAU * iu + 1.1) * 2.2;
        trunkCurl = 0.10 + 0.05 * Math.sin(TAU * 2 * iu);
        earFlap = (Math.sin(TAU * 2 * iu) * 0.5 + 0.5) * 1.8;
        tailSwish = Math.sin(TAU * 2 * iu + 0.7) * 2.4;
    }

    // Combat choreography overlays.
    let lungeD = 0;        // whole-body shove along the facing axis (standing only)
    let tuskPitch = 0;     // + = tips toss up, − = gore down
    let trunkThrust = 0;   // trunk tip flung forward
    let pawLift = 0, pawSwing = 0; // near-front leg paws the ground in windup
    let frontSpread = 0;   // front legs brace wide on the standing slam
    if (inCombat) {
        if (walking) {
            // TRAMPLE — the legs never stop; the head does the talking.
            headLift += -1.2 * windup + 3.4 * strike;   // brace low, then TOSS
            tuskPitch = -1.0 * windup + 3.6 * strike;
            trunkCurl = Math.max(trunkCurl, 0.85 * strike);
            earFlap += 1.8 * strike;
            bob += -0.8 * windup + 1.2 * strike;        // surge through the wall
        } else {
            // Standing gore: rear back, coil, then slam down and forward.
            lungeD = -3.0 * windup + 4.2 * strike;
            headLift += 2.8 * windup - 2.4 * strike;
            tuskPitch = 2.0 * windup - 3.2 * strike;
            trunkCurl = Math.max(trunkCurl, 0.95 * windup - 0.6 * strike);
            trunkThrust = 3.2 * strike;
            earFlap += 1.4 * windup;
            pawLift = 2.8 * windup;
            pawSwing = 2.0 * windup;
            frontSpread = 1.2 * strike;
            bob += -1.3 * strike;                        // weight drops into the blow
        }
    }

    // ---------------- projection toolkit (iso squash 0.5) ------------------
    const ca = Math.cos(facingAngle), sa = Math.sin(facingAngle);
    const GY = 9.5; // ground line (the villager-rule anchor)
    const px = (d: number, w: number): number => d * ca - w * sa;
    const py = (d: number, w: number, h: number): number => GY + (d * sa + w * ca) * 0.5 - h;
    const k = (d: number, w: number): number => d * sa + w * ca; // screen-depth key

    // ---------------- palette ----------------------------------------------
    const own = isPlayer ? 1 : 0.78; // enemies darken (troop palette convention)
    const hide = shade(0x8f8d9a, own);
    const hideDk = shade(0x605e6d, own);
    const hideLt = shade(0xa8a6b3, own);
    const ivory = shade(0xeae0c6, isPlayer ? 1 : 0.88);
    const cloth = shade(0xa93732, own);
    const clothDk = shade(0x7c2723, own);
    const gold = shade(0xd9a625, isPlayer ? 1 : 0.85);
    const iron = shade(0x70737f, own);
    const ironDk = shade(0x4d505b, own);
    const timber = shade(0x8a683f, own);
    const timberDk = shade(0x64492a, own);
    const rope = shade(0x7c6038, own);
    const skin = shade(0xd9a877, own);

    const bodyD = walking ? 0 : lungeD; // carrier moves the trampler; standing bulls lunge

    // ---------------- 1. contact shadow (ONE uniform-alpha ellipse) --------
    {
        const shW = Math.abs(ca) * 15 + Math.abs(sa) * 9.5;
        const shH = (Math.abs(sa) * 15 + Math.abs(ca) * 9.5) * 0.5;
        g.fillStyle(0x000000, 0.22);
        g.fillEllipse(px(bodyD * 0.5, 0), GY + 0.4 + (bodyD * 0.5 * sa) * 0.5, shW * 2, shH * 2);
    }

    // ---------------- 2. legs (columns; far pair before the body) ----------
    interface Leg { d: number; w: number; ph: number; front: boolean; }
    const legs: Leg[] = [
        { d: 8.2, w: 4.6, ph: 0.0, front: true },
        { d: 8.2, w: -4.6, ph: 0.5, front: true },
        { d: -8.6, w: 4.6, ph: 0.25, front: false },
        { d: -8.6, w: -4.6, ph: 0.75, front: false }
    ];
    const nearFrontW = ca >= 0 ? 4.6 : -4.6; // which front leg paws in the windup
    const drawLeg = (leg: Leg, near: boolean): void => {
        let sw = walking ? Math.sin(TAU * (wt + leg.ph)) * 3.2 : 0;
        let lf = walking ? Math.max(0, Math.sin(TAU * (wt + leg.ph) + 0.9)) * 2.6 : 0;
        let w = leg.w;
        if (!walking && leg.front) {
            if (leg.w === nearFrontW) { lf += pawLift; sw += pawSwing; }
            w += Math.sign(leg.w) * frontSpread;
        }
        const hipD = bodyD + leg.d * 0.8 + sw * 0.35;
        const footD = bodyD + leg.d + sw;
        const hx = px(hipD, w * 0.8 + roll * 0.6);
        const hy = py(hipD, w * 0.8 + roll * 0.6, 8.5 + bob * 0.5);
        const fx = px(footD, w);
        const fy = py(footD, w, lf);
        strip(g, hx, hy, fx, fy, 2.1, 1.75, near ? shade(hide, 0.9) : shade(hide, 0.74));
        // foot pad + ivory toenail band toward the facing direction
        g.fillStyle(near ? shade(hideDk, 1.05) : shade(hideDk, 0.85), 1);
        g.fillEllipse(fx, fy - 0.4, 4.4, 2.1);
        g.fillStyle(shade(ivory, near ? 0.95 : 0.8), 1);
        g.fillEllipse(px(footD + 1.7, w), py(footD + 1.7, w, lf + 0.3), 2.1, 1.0);
    };
    const farLegs = legs.filter(l => k(l.d, l.w) < 0);
    const nearLegs = legs.filter(l => k(l.d, l.w) >= 0);
    for (const leg of farLegs) drawLeg(leg, false);

    // ---------------- 3. tail (behind the body when walking down-screen) ---
    const drawTail = (): void => {
        const bx = px(bodyD - 10.6, roll * 0.8);
        const by = py(bodyD - 10.6, roll * 0.8, 15.6 + bob * 0.6);
        const tx = px(bodyD - 13.6, tailSwish);
        const ty = py(bodyD - 13.6, tailSwish, 6.8);
        strip(g, bx, by, tx, ty, 1.4, 0.8, hideDk);
        g.fillStyle(shade(0x3f3d49, own), 1);
        g.fillCircle(tx, ty + 0.4, 1.4);
    };
    if (sa > 0) drawTail();

    // ---------------- 4. head group (behind the body when walking up-screen)
    const headD = bodyD + 12.6 + (walking ? 0 : 1.5 * strike);
    const headW = roll * 0.7;
    const headH = 15.2 + headLift + bob * 0.7;
    const earSideK = (s: number): number => k(headD - 1, s * 6);
    const drawEar = (s: number): void => {
        const flare = 4.0 + earFlap;
        const pts: Array<[number, number, number]> = [
            [headD + 0.8, s * 4.6, headH + 3.8],            // top attach
            [headD - 0.8, s * 4.8, headH - 2.2],            // bottom attach
            [headD - 5.0, s * (4.8 + flare), headH - 3.2],  // bottom outer (swept back)
            [headD - 4.4, s * (5.4 + flare), headH + 4.4]   // top outer
        ];
        g.fillStyle(shade(hide, 0.86), 1);
        g.beginPath();
        g.moveTo(px(pts[0][0], pts[0][1]), py(pts[0][0], pts[0][1], pts[0][2]));
        for (let i = 1; i < 4; i++) g.lineTo(px(pts[i][0], pts[i][1]), py(pts[i][0], pts[i][1], pts[i][2]));
        g.closePath();
        g.fillPath();
        // inner shade wedge (opaque — no alpha stacking)
        g.fillStyle(shade(hide, 0.72), 1);
        g.beginPath();
        g.moveTo(px(pts[1][0], pts[1][1]), py(pts[1][0], pts[1][1], pts[1][2]));
        g.lineTo(px(pts[2][0], pts[2][1]), py(pts[2][0], pts[2][1], pts[2][2]));
        g.lineTo(px(headD - 4.0, s * (4.1 + flare * 0.6)), py(headD - 4.0, s * (4.1 + flare * 0.6), headH - 0.4));
        g.closePath();
        g.fillPath();
    };
    const drawTusk = (s: number): void => {
        // Crescent: drops from the jaw, sweeps forward, tip curls back UP.
        const b: [number, number, number] = [headD + 3.4, headW + s * 3.6, headH - 4.8];
        const m: [number, number, number] = [headD + 7.0, headW + s * 5.4, headH - 6.6 + tuskPitch * 0.8];
        const t: [number, number, number] = [headD + 10.2, headW + s * 5.0, headH - 4.4 + tuskPitch * 1.9];
        strip(g, px(b[0], b[1]), py(b[0], b[1], b[2]), px(m[0], m[1]), py(m[0], m[1], m[2]), 1.9, 1.45, ivory);
        strip(g, px(m[0], m[1]), py(m[0], m[1], m[2]), px(t[0], t[1]), py(t[0], t[1], t[2]), 1.45, 0.85, ivory);
        if (lvl >= 2) { // tusk cap: iron at L2, gold ACCENT at L3
            g.fillStyle(lvl >= 3 ? gold : iron, 1);
            g.fillCircle(px(t[0], t[1]), py(t[0], t[1], t[2]), 1.2);
        }
    };
    const drawTrunk = (): void => {
        const b: [number, number, number] = [headD + 3.2, headW, headH - 2.4];
        const c: [number, number, number] = [
            headD + 6.6, headW + trunkSwing * 0.5,
            6.0 + trunkCurl * 7.5
        ];
        const t: [number, number, number] = [
            headD + 8.0 + trunkThrust + trunkCurl * 1.2, headW + trunkSwing,
            2.2 + trunkCurl * 11.0
        ];
        for (let i = 0; i <= 5; i++) {
            const u = i / 5;
            const d = (1 - u) * (1 - u) * b[0] + 2 * (1 - u) * u * c[0] + u * u * t[0];
            const w = (1 - u) * (1 - u) * b[1] + 2 * (1 - u) * u * c[1] + u * u * t[1];
            const h = (1 - u) * (1 - u) * b[2] + 2 * (1 - u) * u * c[2] + u * u * t[2];
            const r = 2.9 - u * 1.5;
            g.fillStyle(i % 2 === 0 ? shade(hide, 0.96) : shade(hide, 0.86), 1);
            g.fillCircle(px(d, w), py(d, w, h), r);
        }
        // nostril tip
        const tipX = px(t[0], t[1]), tipY = py(t[0], t[1], t[2]);
        g.fillStyle(shade(hideDk, 0.8), 1);
        g.fillCircle(tipX, tipY, 0.55);
    };
    const drawHeadGroup = (behind: boolean): void => {
        const farS = earSideK(-1) < earSideK(1) ? -1 : 1;
        if (behind) {
            // Viewed from the rear: trunk + tusks hide behind the dome; ears face camera.
            drawTrunk();
            drawTusk(farS);
            drawTusk(-farS);
            g.fillStyle(hide, 1);
            g.fillCircle(px(headD, headW), py(headD, headW, headH), 5.3);
            drawEar(farS);
            drawEar(-farS);
            return;
        }
        drawEar(farS);
        // dome + NW forehead highlight
        g.fillStyle(hide, 1);
        g.fillCircle(px(headD, headW), py(headD, headW, headH), 6.2);
        g.fillStyle(hideLt, 1);
        g.fillEllipse(px(headD, headW) - 1.8, py(headD, headW, headH) - 2.2, 6.0, 3.8);
        drawEar(-farS);
        // chanfron (head armor): a face-plate STRIP down the forehead onto
        // the trunk base + a browband — projected geometry, so it hugs the
        // dome at every heading (a flat disc floated at diagonals).
        if (lvl >= 2) {
            const b1x = px(headD + 0.6, headW), b1y = py(headD + 0.6, headW, headH + 5.0);
            const b2x = px(headD + 4.6, headW), b2y = py(headD + 4.6, headW, headH - 2.2);
            strip(g, b1x, b1y, b2x, b2y, 2.4, 1.9, iron);
            // browband across, ear to ear
            strip(g,
                px(headD + 1.2, headW - 4.4), py(headD + 1.2, headW - 4.4, headH + 2.6),
                px(headD + 1.2, headW + 4.4), py(headD + 1.2, headW + 4.4, headH + 2.6),
                1.1, 1.1, ironDk);
            if (lvl >= 3) {
                strip(g, b1x, b1y, b2x, b2y, 0.55, 0.4, gold); // gilded center line
                // crest plume — a small accent, never a mass
                g.fillStyle(gold, 1);
                g.fillCircle(px(headD + 0.6, headW), py(headD + 0.6, headW, headH + 6.2), 0.9);
                g.fillStyle(cloth, 1);
                g.fillEllipse(px(headD + 0.3, headW), py(headD + 0.3, headW, headH + 7.8), 1.8, 2.6);
            }
        }
        // eyes on camera-facing sides only
        for (const s of [-1, 1]) {
            if (s * ca > -0.05 && sa > -0.35) {
                g.fillStyle(shade(0x2a2830, own), 1);
                g.fillCircle(px(headD + 4.0, headW + s * 4.6), py(headD + 4.0, headW + s * 4.6, headH + 1.2), 0.95);
            }
        }
        drawTusk(farS);
        drawTrunk();
        drawTusk(-farS);
    };
    const headBehind = sa < -0.08;
    if (headBehind) drawHeadGroup(true);

    // ---------------- 5. body mass -----------------------------------------
    const BW = 18 + 9 * Math.abs(ca);          // screen extent morphs with heading
    const BH = 11.5 + 6 * Math.abs(sa);
    const bcx = px(bodyD + 0.4, roll);
    const bcy = py(bodyD + 0.4, roll, 13.6 + bob);
    g.fillStyle(hide, 1);
    g.fillEllipse(bcx, bcy, BW, BH);
    g.fillStyle(hideDk, 1);                    // belly shadow (opaque, no stacking)
    g.fillEllipse(bcx, bcy + BH * 0.26, BW * 0.8, BH * 0.42);
    g.fillStyle(shade(hide, 1.1), 1);          // NW back highlight (soft tone)
    g.fillEllipse(bcx - BW * 0.1, bcy - BH * 0.26, BW * 0.6, BH * 0.34);

    // Caparison / girth rigging by level.
    if (lvl >= 3) {
        g.fillStyle(cloth, 1);
        g.fillEllipse(bcx, bcy - BH * 0.16, BW * 0.86, BH * 0.6);
        g.fillStyle(clothDk, 1);
        g.fillEllipse(bcx, bcy - BH * 0.16 + BH * 0.18, BW * 0.78, BH * 0.24);
        g.lineStyle(1.1, gold, 1);             // gold TRIM — accent line only
        g.strokeEllipse(bcx, bcy - BH * 0.16, BW * 0.86, BH * 0.6);
    }
    {   // girth straps: flat bands following the back's curve (rope L1,
        // iron bands L2, dark crimson bands L3) — never a floating ring
        const strapC = lvl >= 3 ? clothDk : lvl >= 2 ? ironDk : rope;
        for (const d0 of [-5.5, 4]) {
            const arc: Array<[number, number]> = [
                [-6.0, 12.2], [-3.4, 16.2], [0, 17.4], [3.4, 16.2], [6.0, 12.2]
            ];
            for (let i = 0; i < arc.length - 1; i++) {
                const [w1, h1] = arc[i], [w2, h2] = arc[i + 1];
                strip(g,
                    px(bodyD + d0, roll + w1), py(bodyD + d0, roll + w1, h1 + bob),
                    px(bodyD + d0, roll + w2), py(bodyD + d0, roll + w2, h2 + bob),
                    0.85, 0.85, strapC);
            }
        }
    }

    if (sa <= 0) drawTail();
    for (const leg of nearLegs) drawLeg(leg, true);

    // L2 iron skirt plates hang over the near flank (over the leg tops).
    if (lvl === 2 && Math.abs(ca) > 0.2) {
        const sN = ca >= 0 ? 1 : -1;
        for (const d0 of [-6.5, -1.5, 3.5]) {
            g.fillStyle(iron, 1);
            g.beginPath();
            g.moveTo(px(bodyD + d0 - 1.9, sN * 7.0), py(bodyD + d0 - 1.9, sN * 7.0, 13 + bob * 0.5));
            g.lineTo(px(bodyD + d0 + 1.9, sN * 7.0), py(bodyD + d0 + 1.9, sN * 7.0, 13 + bob * 0.5));
            g.lineTo(px(bodyD + d0 + 1.6, sN * 7.6), py(bodyD + d0 + 1.6, sN * 7.6, 7.6));
            g.lineTo(px(bodyD + d0 - 1.6, sN * 7.6), py(bodyD + d0 - 1.6, sN * 7.6, 7.6));
            g.closePath();
            g.fillPath();
            g.fillStyle(ironDk, 1);
            g.fillEllipse(px(bodyD + d0, sN * 7.5), py(bodyD + d0, sN * 7.5, 7.8), 3.0, 1.1);
        }
    }
    // L3: one gold roundel on the caparison flank (small accent).
    if (lvl >= 3 && Math.abs(ca) > 0.3) {
        const sN = ca >= 0 ? 1 : -1;
        g.fillStyle(gold, 1);
        g.fillCircle(px(bodyD - 1, sN * 6.6), py(bodyD - 1, sN * 6.6, 12.2 + bob * 0.5), 1.5);
    }

    // ---------------- 6. howdah (sways a beat behind the body) -------------
    {
        const hD = bodyD - 3.0;
        const hW = roll + howdahRoll;
        const hb = 19.4 + bob * 0.8;   // basket floor height
        const hh = 4.8;                // wall height
        const hd = 4.4, hw = 3.9;      // half extents

        // saddle pad under the basket
        g.fillStyle(lvl >= 3 ? clothDk : lvl >= 2 ? shade(0x545762, own) : shade(0x9c7f52, own), 1);
        g.fillEllipse(px(hD, hW * 0.8), py(hD, hW * 0.8, 18.4 + bob * 0.8), BW * 0.52, BH * 0.34);

        const corners: Array<[number, number]> = [
            [hD - hd, hW - hw], [hD + hd, hW - hw], [hD + hd, hW + hw], [hD - hd, hW + hw]
        ];
        const kc = k(hD, hW);
        const panel = lvl >= 3 ? cloth : lvl >= 2 ? iron : timber;
        const panelDk = lvl >= 3 ? clothDk : lvl >= 2 ? ironDk : timberDk;
        const rim = lvl >= 3 ? gold : lvl >= 2 ? shade(iron, 1.25) : shade(timber, 1.25);

        // far top rim bands (the basket's far wall peeking over the interior)
        for (let i = 0; i < 4; i++) {
            const A = corners[i], B = corners[(i + 1) % 4];
            const mk = k((A[0] + B[0]) / 2, (A[1] + B[1]) / 2);
            if (mk <= kc) {
                strip(g, px(A[0], A[1]), py(A[0], A[1], hb + hh), px(B[0], B[1]), py(B[0], B[1], hb + hh), 0.9, 0.9, panelDk);
            }
        }
        // interior
        g.fillStyle(shade(0x2e2b33, own), 1);
        g.beginPath();
        g.moveTo(px(corners[0][0], corners[0][1]), py(corners[0][0], corners[0][1], hb + hh - 0.6));
        for (let i = 1; i < 4; i++) g.lineTo(px(corners[i][0], corners[i][1]), py(corners[i][0], corners[i][1], hb + hh - 0.6));
        g.closePath();
        g.fillPath();
        // visible (down-screen) walls — rotation-proof face picking
        for (let i = 0; i < 4; i++) {
            const A = corners[i], B = corners[(i + 1) % 4];
            const mk = k((A[0] + B[0]) / 2, (A[1] + B[1]) / 2);
            if (mk > kc) {
                const ax = px(A[0], A[1]), bx2 = px(B[0], B[1]);
                const cx = px(hD, hW);
                const lit = (ax + bx2) / 2 < cx; // west-ish face catches the NW light
                g.fillStyle(shade(panel, lit ? 1.0 : 0.72), 1);
                g.beginPath();
                g.moveTo(ax, py(A[0], A[1], hb));
                g.lineTo(bx2, py(B[0], B[1], hb));
                g.lineTo(bx2, py(B[0], B[1], hb + hh));
                g.lineTo(ax, py(A[0], A[1], hb + hh));
                g.closePath();
                g.fillPath();
                // rim cap
                strip(g, ax, py(A[0], A[1], hb + hh), bx2, py(B[0], B[1], hb + hh), lvl >= 3 ? 0.7 : 1.0, lvl >= 3 ? 0.7 : 1.0, rim);
                // L2 wall reinforcement: horizontal band + rivet dots (a
                // centered boss circle read as a googly eye at 3/4 headings)
                if (lvl === 2) {
                    strip(g, ax, py(A[0], A[1], hb + hh * 0.38), bx2, py(B[0], B[1], hb + hh * 0.38), 0.55, 0.55, ironDk);
                    g.fillStyle(shade(iron, 1.35), 1);
                    for (const u of [0.28, 0.72]) {
                        const rd = A[0] + (B[0] - A[0]) * u, rw = A[1] + (B[1] - A[1]) * u;
                        g.fillCircle(px(rd, rw), py(rd, rw, hb + hh * 0.72), 0.5);
                    }
                }
            }
        }
        // L1 corner posts (timber rail crate)
        if (lvl === 1) {
            for (const c of corners) {
                if (k(c[0], c[1]) > kc - hd) {
                    strip(g, px(c[0], c[1]), py(c[0], c[1], hb - 0.4), px(c[0], c[1]), py(c[0], c[1], hb + hh + 1.2), 0.65, 0.65, timberDk);
                }
            }
        }
        // L3 finial + pennant (1000 ms flutter — exact harmonic of the idle master)
        if (lvl >= 3) {
            const poleTop = hb + hh + 3.4;
            strip(g, px(hD, hW), py(hD, hW, hb + hh - 0.5), px(hD, hW), py(hD, hW, poleTop), 0.5, 0.5, shade(0x5a4a30, own));
            g.fillStyle(gold, 1);
            g.fillCircle(px(hD, hW), py(hD, hW, poleTop), 0.8);
            const fl = Math.sin(TAU * (((time % 1000) + 1000) % 1000) / 1000) * 1.4;
            g.fillStyle(cloth, 1);
            g.beginPath();
            g.moveTo(px(hD, hW), py(hD, hW, poleTop - 0.2));
            g.lineTo(px(hD - 3.4, hW + fl), py(hD - 3.4, hW + fl, poleTop - 1.1));
            g.lineTo(px(hD - 0.2, hW), py(hD - 0.2, hW, poleTop - 2.1));
            g.closePath();
            g.fillPath();
        }
    }

    // ---------------- 7. mahout (leans into the charge) --------------------
    {
        const lean = inCombat && !walking ? 1.2 * windup - 0.8 * strike : (walking ? 0.6 : 0);
        const mD = bodyD + 6.4 + lean;
        const mW = roll * 0.85;
        const mH = 19.6 + bob * 0.8;
        const tunic = lvl >= 3 ? cloth : lvl >= 2 ? shade(0x5c6c80, own) : shade(0x8a6a45, own);
        // goad (the driver's hook) held toward the head
        g.lineStyle(0.9, shade(0x4d4234, own), 1);
        g.lineBetween(px(mD + 1.4, mW + 1.0), py(mD + 1.4, mW + 1.0, mH + 2.2), px(mD + 4.6, mW + 1.4), py(mD + 4.6, mW + 1.4, mH + 4.6));
        // hunched seated torso, slightly forward-leaning
        g.fillStyle(shade(tunic, 0.75), 1);
        g.fillEllipse(px(mD - 0.6, mW), py(mD - 0.6, mW, mH + 1.4), 3.6, 3.0);
        g.fillStyle(tunic, 1);
        g.fillEllipse(px(mD + 0.2, mW), py(mD + 0.2, mW, mH + 1.8), 3.2, 3.2);
        g.fillStyle(skin, 1);
        g.fillCircle(px(mD + 0.5, mW), py(mD + 0.5, mW, mH + 4.4), 1.5);
        // turban wrap (gold dot accent at L3)
        g.fillStyle(lvl >= 3 ? shade(0xefe6d2, own) : shade(0xcfc4a8, own), 1);
        g.fillEllipse(px(mD + 0.5, mW), py(mD + 0.5, mW, mH + 5.4), 2.4, 1.1);
        if (lvl >= 3) {
            g.fillStyle(gold, 1);
            g.fillCircle(px(mD + 0.5, mW), py(mD + 0.5, mW, mH + 5.8), 0.45);
        }
    }

    // ---------------- 8. head group in front -------------------------------
    if (!headBehind) drawHeadGroup(false);
}
