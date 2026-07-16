import type Phaser from 'phaser';

type G = Phaser.GameObjects.Graphics;

/**
 * TREBUCHET — DESIGN C ("The Notched Windlass")
 *
 * Counterweight trebuchet on a wheeled timber sled, crewed by two tiny siege
 * engineers. The whole machine is one physical linkage: a single arm angle
 * (phi, measured in the vertical aim-plane above horizontal-back) drives the
 * long throwing arm AND the short end the iron counterweight box hangs from —
 * cocking hauls the arm down-back and lifts the box high into the A-frame;
 * release drops the box and whips the arm over with an overshoot wobble.
 *
 *  - WALK (one exact 600 ms stride): both engineers haul tow ropes at the
 *    front, wheels turn 2π per stride, the sled bobs, the arm rides stowed
 *    low over the tail.
 *  - ATTACK (attackAge 0..attackDelay 4000): the rear windlass cranks the arm
 *    back in SIX ratchet notches through the 2600 ms windup (crank rope runs
 *    drum → arm tip, crank handle spins in bursts), the loader kneels and
 *    seats the stone in the ground pouch late in the windup, and the arm
 *    RELEASES exactly on the damage tick — 170 ms whip-over, sling trailing
 *    EMPTY (the engine spawns the projectile), then a damped settle wobble.
 *  - IDLE (exact 2000 ms period, 250 ms multiple): the counterweight box
 *    pendulums opposite a small arm sway (harmonic 1x), the empty sling and
 *    the frame pennant flutter (harmonic 2x), the crew shift their weight.
 *
 * Levels are MATERIAL: L1 raw timber + rope lashings + wooden disc wheels;
 * L2 iron-shod (riveted counterweight straps, iron wheel rims, pivot strap,
 * arm bands); L3 refined dark timber with brass/gold ACCENTS only (pivot
 * boss, counterweight band, tip ferrule, gilt pennant fringe).
 *
 * Owner read: pennant + crew tunics (player steel-blue / green pennant,
 * enemy rust-red / crimson pennant); enemy timber darkens slightly.
 *
 * All heading math is trigonometric off facingAngle (along-aim = (cos a,
 * sin a * 0.5), across-aim = (-sin a, cos a * 0.5)) so the design reads at
 * every one of the 8 baked directions; near/far layering picks sides from
 * the across-axis screen-y sign. Every motion term is a deterministic
 * function of time / attackAge (iron rule 3). No translucent body paint.
 */

// ------------------------- tiny self-contained toolkit -------------------------

function clamp01(v: number): number { return v < 0 ? 0 : v > 1 ? 1 : v; }
function easeOutQ(t: number): number { return 1 - (1 - t) * (1 - t); }
function shade(c: number, m: number): number {
    const r = Math.max(0, Math.min(255, Math.round(((c >> 16) & 0xff) * m)));
    const g = Math.max(0, Math.min(255, Math.round(((c >> 8) & 0xff) * m)));
    const b = Math.max(0, Math.min(255, Math.round((c & 0xff) * m)));
    return (r << 16) | (g << 8) | b;
}
function quadF(g: G, pts: number[][], color: number): void {
    g.fillStyle(color, 1);
    g.beginPath();
    g.moveTo(pts[0][0], pts[0][1]);
    for (let i = 1; i < pts.length; i++) g.lineTo(pts[i][0], pts[i][1]);
    g.closePath();
    g.fillPath();
}
/** Tapered screen-space beam from (x0,y0) to (x1,y1), widths w0 → w1. */
function beamQ(g: G, x0: number, y0: number, x1: number, y1: number, w0: number, w1: number, color: number): void {
    const dx = x1 - x0, dy = y1 - y0;
    const len = Math.hypot(dx, dy) || 1;
    const nx = -dy / len, ny = dx / len;
    quadF(g, [
        [x0 + nx * w0 / 2, y0 + ny * w0 / 2],
        [x1 + nx * w1 / 2, y1 + ny * w1 / 2],
        [x1 - nx * w1 / 2, y1 - ny * w1 / 2],
        [x0 - nx * w0 / 2, y0 - ny * w0 / 2]
    ], color);
}

interface CrewPose {
    x: number; y: number;               // feet (ground) point
    swing: number; lift: number;        // gait
    leanX: number; crouch: number;
    handL: [number, number] | null;     // hand targets (null = arm hangs)
    handR: [number, number] | null;
    stone?: [number, number] | null;    // a stone carried at the hands
}

export function drawTrebuchetC(
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

    // ---------------- heading frame (iso: horizontals squash 0.5) ----------------
    const a = facingAngle || 0;
    const fx = Math.cos(a), fy = Math.sin(a) * 0.5;      // unit along-aim (screen)
    const pxu = -Math.sin(a), pyu = Math.cos(a) * 0.5;   // unit across-aim (screen)
    const GY = 8.6;                                      // ground line (villager rule)
    const nearW = pyu >= 0 ? 1 : -1;                     // across side closest to camera

    // ------------------------------- palette -------------------------------
    const own = isPlayer ? 1 : 0.9;
    const lvl = Math.max(1, Math.min(3, Math.round(troopLevel || 1)));
    const wood = shade(lvl >= 3 ? 0x8f6f4c : 0x8a6d4a, own);   // base timber 0x8a6d4a
    const woodDark = shade(wood, 0.62);
    const woodMid = shade(wood, 0.82);
    const woodLight = shade(wood, 1.2);
    const iron = shade(0x4a4e55, own);
    const ironDark = shade(0x30343a, own);
    const ironLight = shade(0x6d727b, own);
    const brass = 0xdaa520;
    const ropeC = 0x8b7355;
    const lashC = 0x8a7a5a;
    const stoneC = 0x8f8a80, stoneHi = 0xb0aa9e;
    const pouchC = 0x5a4228;
    const skin = isPlayer ? 0xdeb887 : 0xc9a66b;
    const tunic = isPlayer ? 0x455a64 : 0x7c3a2e;
    const tunicDark = isPlayer ? 0x37474f : 0x5c2b22;
    const cloth = isPlayer ? 0x2e7d32 : 0xa03028;        // pennant = loud owner read

    // ------------------------- attack cycle (damage-tick locked) -------------------------
    const D = attackDelay || 4000;
    const WINDUP = Math.min(2600, D * 0.65);
    let age = Infinity, windup = 0, inCombat = false;
    if (attackAge >= 0 && D > 0) {
        inCombat = true;
        age = attackAge;
        if (age > D + 600) age = ((time % D) + D) % D;   // stale (replay) → free-run
        const remaining = D - age;
        if (remaining <= 0) windup = 1;
        else if (remaining <= WINDUP) windup = 1 - remaining / WINDUP;
    }

    // ------------------------- motion clocks -------------------------
    const STRIDE = 600;                                  // THE one walk period
    const wph = (((time % STRIDE) + STRIDE) % STRIDE) / STRIDE;
    const IDLE_P = 2000;                                 // declared idle period
    const iph = (((time % IDLE_P) + IDLE_P) % IDLE_P) / IDLE_P;
    const iSin = Math.sin(iph * Math.PI * 2);            // harmonic 1x
    const iSin2 = Math.sin(iph * Math.PI * 4);           // harmonic 2x

    // ------------------------- the linkage state -------------------------
    const PHI_REST = 1.92;       // spent: arm up, slightly forward; box hangs low
    const PHI_COCK = -0.62;      // cocked: arm tip at the ground behind; box high
    const PHI_STOW = -0.30;      // walking: arm lashed low over the tail
    let phi = PHI_REST;
    let crank = 0.7;             // windlass crank handle angle
    let haulRope = false;        // crank rope drum → arm tip
    let loaded = false;          // stone seated in the pouch
    let sling: 'cocked' | 'whip' | 'dangle' | 'stowed' = 'dangle';
    let whipT = 0;
    let cwSway = 0;              // counterweight pendulum (screen px, along-aim)
    let slingSway = 0;
    let bob = 0, wheelRot = 0, lurch = 0;

    if (isMoving) {
        phi = PHI_STOW + Math.sin(wph * Math.PI * 2) * 0.015;
        sling = 'stowed';
        bob = Math.abs(Math.sin(wph * Math.PI * 2)) * 0.9;
        wheelRot = wph * Math.PI * 2;
        cwSway = Math.sin(wph * Math.PI * 2) * 1.1;
    } else if (inCombat) {
        if (age <= 170) {
            // RELEASE — the box drops, the arm whips over past rest.
            whipT = clamp01(age / 170);
            phi = PHI_COCK + (PHI_REST + 0.30 - PHI_COCK) * easeOutQ(whipT);
            sling = 'whip';
            cwSway = -2.5 * whipT;
            lurch = 1.4 * easeOutQ(whipT);
        } else if (age <= 1100) {
            // Damped settle about rest; chains and sling swing themselves out.
            const s = age - 170;
            phi = PHI_REST + 0.30 * Math.cos(s / 130) * Math.exp(-s / 300);
            sling = 'dangle';
            cwSway = 3.5 * Math.sin(s / 110) * Math.exp(-s / 350) - 2.5 * Math.exp(-s / 200);
            slingSway = 3 * Math.cos(s / 150) * Math.exp(-s / 400);
            lurch = 1.4 * Math.max(0, 1 - s / 500);
        } else if (windup > 0.001) {
            // RATCHETED COCKING — six notch-surges over the windup.
            const w2 = clamp01(windup / 0.9);            // full cock at 90% windup
            const N = 6;
            const k = w2 * N;
            const prog = Math.min(1, (Math.floor(k) + easeOutQ(clamp01((k - Math.floor(k)) * 1.35))) / N);
            phi = PHI_REST + (PHI_COCK - PHI_REST) * prog;
            crank = 0.7 + prog * Math.PI * 5;            // 2.5 turns, in bursts
            haulRope = true;
            loaded = windup >= 0.82;
            sling = phi < 0.25 ? 'cocked' : 'dangle';
            cwSway = Math.sin(prog * 19) * 0.8;          // load judder on the chains
        } else {
            phi = PHI_REST;
            sling = 'dangle';
        }
    } else {
        // Pure idle — EXACT harmonics of the 2000 ms period only.
        phi = PHI_REST + iSin * 0.04;
        sling = 'dangle';
        cwSway = -iSin * 2.2;                            // the box pendulums
        slingSway = iSin2 * 1.6;                         // empty sling flutters
    }

    // ------------------------- geometry -------------------------
    const HL = 16, HWs = 7.5;         // sled half-length / half-width
    const DECK = 5.4;                 // deck top height
    const PIV_D = -1.5, PIV_H = 21;   // arm axle (apex of the A-frame)
    const ARM_L = 24, ARM_S = 8;      // long / short arm

    const P = (d: number, w: number, h: number): [number, number] =>
        [d * fx + w * pxu, GY + d * fy + w * pyu - h];
    const PM = (d: number, w: number, h: number): [number, number] =>
        P(d + lurch, w, h + bob);                        // machine body (lurch + bob)
    const PW = (d: number, w: number, h: number): [number, number] =>
        P(d + lurch, w, h);                              // wheels (lurch, no bob)

    const tipD = PIV_D - ARM_L * Math.cos(phi);
    const tipH = PIV_H + ARM_L * Math.sin(phi);
    const shD = PIV_D + ARM_S * Math.cos(phi);
    const shH = PIV_H - ARM_S * Math.sin(phi);
    const tip = PM(tipD, 0, tipH);
    const sh = PM(shD, 0, shH);
    const piv = PM(PIV_D, 0, PIV_H);
    const pouchCocked = (): [number, number] => PM(tipD - 3.4, 0, Math.max(1.0, tipH - 6.5));

    // Counterweight box (hangs vertical from the short end on chains).
    const CHAIN = 2.6, CW_H = 5.6, CW_DB = 2.4, CW_WB = lvl >= 2 ? 3.3 : 3.0;
    const cwTop: [number, number] = [sh[0] + fx * cwSway, sh[1] + fy * cwSway + CHAIN];

    /** Iso box: top-face center, half-depth (along), half-width (across), height.
     *  Draws only the side faces whose outward normals point down-screen. */
    const isoBox = (top: [number, number], db: number, wb: number, hh: number, base: number, topMul = 1.22): void => {
        const c = (d: number, w: number, dy: number): [number, number] =>
            [top[0] + d * fx + w * pxu, top[1] + d * fy + w * pyu + dy];
        const face = (pts: number[][], nx2: number): void => quadF(g, pts, shade(base, nx2 > 0 ? 0.66 : 0.9));
        if (fy > 0.02) face([c(db, -wb, 0), c(db, wb, 0), c(db, wb, hh), c(db, -wb, hh)], fx);
        if (-fy > 0.02) face([c(-db, -wb, 0), c(-db, wb, 0), c(-db, wb, hh), c(-db, -wb, hh)], -fx);
        if (pyu > 0.02) face([c(-db, wb, 0), c(db, wb, 0), c(db, wb, hh), c(-db, wb, hh)], pxu);
        if (-pyu > 0.02) face([c(-db, -wb, 0), c(db, -wb, 0), c(db, -wb, hh), c(-db, -wb, hh)], -pxu);
        quadF(g, [c(-db, -wb, 0), c(db, -wb, 0), c(db, wb, 0), c(-db, wb, 0)], shade(base, topMul));
    };

    // ------------------------- crew stations & poses -------------------------
    const crews: CrewPose[] = [];
    const towHitches: Array<[[number, number], [number, number]]> = []; // [hitch, chest]

    if (isMoving) {
        // Both engineers haul at the front, half a stride out of phase.
        for (const [i, wSide] of [[0, nearW], [1, -nearW]] as Array<[number, number]>) {
            const ph2 = ((((time + i * 300) % STRIDE) + STRIDE) % STRIDE) / STRIDE;
            const s3 = Math.sin(ph2 * Math.PI * 2);
            const pos = P(HL + 6.5, wSide * 4.6, 0);
            const chest: [number, number] = [pos[0] - fx * 1.2, pos[1] - 11];
            crews.push({
                x: pos[0], y: pos[1],
                swing: s3 * 2.2, lift: Math.abs(s3) * 1.1,
                leanX: fx * 1.6, crouch: 0,
                handL: [chest[0] - 2, chest[1] + 1.6],
                handR: [chest[0] + 2, chest[1] + 1.6]
            });
            towHitches.push([PM(HL - 1, wSide * 3, 6.8), chest]);
        }
    } else {
        // FIXED stations across the whole combat cycle — no frame teleports.
        const e1p = P(-13.2, nearW * 8.6, 0);   // windlass engineer, near side
        const e2p = P(-18.8, -nearW * 5.2, 0);  // loader, far side of the tail
        const handle = PM(-13 + Math.cos(crank) * 4.2, nearW * 4.6, 7.6 + Math.sin(crank) * 4.2);
        const e1: CrewPose = { x: e1p[0], y: e1p[1], swing: 0, lift: 0, leanX: 0, crouch: 0, handL: null, handR: null };
        if (haulRope) {
            e1.handL = [handle[0] - 0.7, handle[1] + 0.4];
            e1.handR = [handle[0] + 0.7, handle[1] - 0.4];
            e1.leanX = Math.cos(crank) * 1.1;            // body works the crank
        } else if (!inCombat) {
            e1.handL = [PM(-13, nearW * 4.6, 10.4)[0], PM(-13, nearW * 4.6, 10.4)[1]];
            e1.leanX = iSin * 0.6;                       // idle weight shift (1x)
            e1.lift = Math.max(0, iSin) * 0.5;
        } else {
            e1.handL = [PM(-13, nearW * 4.6, 10.4)[0], PM(-13, nearW * 4.6, 10.4)[1]];
        }
        const e2: CrewPose = { x: e2p[0], y: e2p[1], swing: 0, lift: 0, leanX: 0, crouch: 0, handL: null, handR: null };
        if (inCombat && sling === 'cocked' && !loaded) {
            // Kneels and lowers the stone into the pouch.
            const pp = pouchCocked();
            e2.crouch = 2.4;
            e2.handL = [pp[0] - 1.5, pp[1] - 1.6];
            e2.handR = [pp[0] + 1.5, pp[1] - 1.6];
            e2.stone = [pp[0], pp[1] - 2.4];
        } else if (inCombat && age <= 600) {
            e2.handR = [e2p[0] + 2.6, e2p[1] - 14.6];    // shields eyes, watching it fly
        } else if (!inCombat) {
            e2.handL = [e2p[0] - 1.7, e2p[1] - 10.2];    // arms crossed
            e2.handR = [e2p[0] + 1.7, e2p[1] - 10.6];
            e2.leanX = iSin2 * 0.6;
            e2.lift = Math.max(0, -iSin) * 0.4;
        }
        crews.push(e1, e2);
    }

    const drawCrew = (c: CrewPose): void => {
        const { x, y } = c;
        const cr = c.crouch;
        g.fillStyle(0x000000, 0.18);
        g.fillEllipse(x, y + 0.2, 7.5, 2.8);
        // legs + boots
        g.fillStyle(tunicDark, 1);
        g.fillRect(x - 2.3 - c.swing, y - 5.4 - c.lift + cr, 1.8, 5.4 + c.lift - cr);
        g.fillRect(x + 0.5 + c.swing, y - 5.4 - c.lift + cr, 1.8, 5.4 + c.lift - cr);
        g.fillStyle(0x2a211a, 1);
        g.fillEllipse(x - 1.4 - c.swing, y - 0.2, 2.8, 1.5);
        g.fillEllipse(x + 1.4 + c.swing, y - 0.2, 2.8, 1.5);
        // torso + belt
        const tx = x + c.leanX, ty = y - 9.6 - c.lift + cr;
        g.fillStyle(tunic, 1);
        g.fillCircle(tx, ty, 4.0);
        g.fillStyle(tunicDark, 1);
        g.fillRect(tx - 3.4, ty + 1.8, 6.8, 1.5);
        // arms to hand targets (or hanging)
        const armTo = (sx: number, sy: number, h: [number, number] | null, side: number): void => {
            const hh: [number, number] = h ?? [tx + side * 3.4, ty + 4.6];
            const dx = hh[0] - sx, dy = hh[1] - sy;
            const len = Math.hypot(dx, dy) || 1;
            const nx = (-dy / len) * 0.85, ny = (dx / len) * 0.85;
            quadF(g, [[sx + nx, sy + ny], [hh[0] + nx, hh[1] + ny], [hh[0] - nx, hh[1] - ny], [sx - nx, sy - ny]], skin);
            g.fillStyle(skin, 1);
            g.fillCircle(hh[0], hh[1], 1.1);
        };
        armTo(tx - 2.5, ty - 1.2, c.handL, -1);
        armTo(tx + 2.5, ty - 1.2, c.handR, 1);
        // head + leather cap
        g.fillStyle(skin, 1);
        g.fillCircle(tx, ty - 5.6, 2.8);
        g.fillStyle(0x6b4a2b, 1);
        g.beginPath();
        g.arc(tx, ty - 6.2, 2.9, Math.PI, 0, false);
        g.closePath();
        g.fillPath();
        if (lvl >= 3) { g.fillStyle(brass, 1); g.fillCircle(tx, ty - 8.7, 0.7); }
        if (c.stone) {
            g.fillStyle(stoneC, 1); g.fillCircle(c.stone[0], c.stone[1], 2.2);
            g.fillStyle(stoneHi, 1); g.fillCircle(c.stone[0] - 0.7, c.stone[1] - 0.7, 0.8);
        }
    };

    // ================================ PAINT ================================

    // ---- ground shadow (axis-aligned approximation, ram precedent)
    g.fillStyle(0x000000, 0.32);
    g.fillEllipse(fx * -1.2, GY + 1.2, 30 + 16 * Math.abs(Math.cos(a)), 13 + 7 * Math.abs(Math.sin(a)));

    // ---- crew standing up-screen of the sled draw BEHIND the machine
    for (const c of crews) if (c.y - GY < -1) drawCrew(c);

    // ---- far-side wheels
    const wheel = (d: number, w: number): void => {
        const c = PW(d, w, 3.9);
        g.fillStyle(lvl >= 2 ? ironDark : shade(woodDark, 0.85), 1);
        g.fillCircle(c[0], c[1], 3.9);
        g.fillStyle(wood, 1);
        g.fillCircle(c[0], c[1], 3.0);
        g.lineStyle(1.0, woodDark, 1);
        for (let i = 0; i < 4; i++) {
            const sa = wheelRot + i * Math.PI / 2;
            g.lineBetween(c[0] + Math.cos(sa) * 0.9, c[1] + Math.sin(sa) * 0.9,
                c[0] + Math.cos(sa) * 2.9, c[1] + Math.sin(sa) * 2.9);
        }
        g.fillStyle(lvl >= 3 ? brass : woodDark, 1);
        g.fillCircle(c[0], c[1], 1.0);
    };
    wheel(10.5, -nearW * HWs);
    wheel(-10.5, -nearW * HWs);

    // ---- sled: two rails, deck slab, cross bumpers
    isoBox(PM(0, HWs - 0.4, 4.8), HL, 1.25, 3.4, wood);
    isoBox(PM(0, -(HWs - 0.4), 4.8), HL, 1.25, 3.4, wood);
    isoBox(PM(-1, 0, DECK + 0.5), 11.5, HWs - 1.8, 1.2, woodMid);
    g.lineStyle(0.8, woodDark, 1);
    for (let d = -9; d <= 9; d += 4.5) {
        const p1 = PM(d, -(HWs - 1.8), DECK + 0.5), p2 = PM(d, HWs - 1.8, DECK + 0.5);
        g.lineBetween(p1[0], p1[1], p2[0], p2[1]);
    }
    isoBox(PM(HL - 1.1, 0, 6.8), 1.15, HWs + 0.3, 4.4, wood);
    isoBox(PM(-(HL - 1.1), 0, 6.8), 1.15, HWs + 0.3, 4.4, wood);
    if (lvl === 1) {
        // rope lashings where the rails meet the bumpers
        g.lineStyle(1.1, lashC, 1);
        for (const dd of [HL - 2.6, -(HL - 2.6)]) for (const ww of [HWs - 0.4, -(HWs - 0.4)]) {
            const q1 = PM(dd - 1, ww, 7.4), q2 = PM(dd + 1, ww, 3.4);
            g.lineBetween(q1[0], q1[1], q2[0], q2[1]);
        }
    } else {
        // iron corner plates
        g.fillStyle(ironDark, 1);
        for (const dd of [HL - 2.4, -(HL - 2.4)]) for (const ww of [HWs - 0.4, -(HWs - 0.4)]) {
            const q = PM(dd, ww, 6.4);
            g.fillRect(q[0] - 1.3, q[1] - 1.1, 2.6, 2.2);
        }
    }

    // ---- deck cargo: spare stones (+ the lashed pouch while marching)
    const spare = isMoving ? 2 : (loaded ? 1 : 2);
    for (let i = 0; i < spare; i++) {
        const c = PM(-8.3, i === 0 ? 2.6 : -2.6, DECK + 2.4);
        g.fillStyle(stoneC, 1); g.fillCircle(c[0], c[1], 2.4);
        g.fillStyle(stoneHi, 1); g.fillCircle(c[0] - 0.8, c[1] - 0.8, 0.9);
        g.fillStyle(shade(stoneC, 0.7), 1); g.fillCircle(c[0] + 0.9, c[1] + 0.9, 0.7);
    }
    if (sling === 'stowed') {
        const c = PM(-5.5, 1.2, DECK + 1.6);
        g.fillStyle(pouchC, 1);
        g.fillEllipse(c[0], c[1], 5, 2.6);
        g.lineStyle(0.9, lashC, 1);
        g.lineBetween(c[0] - 2.4, c[1] - 1.2, c[0] + 2.4, c[1] + 1.2);
    }

    // ---- windlass drum (rear) + brackets + crank
    const drumA = PM(-13, -3.8, 7.6), drumB = PM(-13, 3.8, 7.6);
    g.fillStyle(woodDark, 1);
    for (const ww of [-3.2, 3.2]) {
        const b = PM(-13, ww, DECK);
        g.fillRect(b[0] - 1.1, b[1] - 3.2, 2.2, 3.4);
    }
    beamQ(g, drumA[0], drumA[1], drumB[0], drumB[1], 4.6, 4.6, woodMid);
    g.lineStyle(1.0, shade(ropeC, 0.75), 1);
    for (const t of [-0.35, 0, 0.35]) {
        const q1 = PM(-13.9, t * 7, 7.6), q2 = PM(-12.1, t * 7, 7.6);
        g.lineBetween(q1[0], q1[1], q2[0], q2[1]);
    }
    g.fillStyle(lvl >= 2 ? ironDark : woodDark, 1);
    g.fillCircle(drumA[0], drumA[1], 2.3);
    g.fillCircle(drumB[0], drumB[1], 2.3);
    g.fillStyle(lvl >= 2 ? iron : wood, 1);
    g.fillCircle(drumA[0], drumA[1], 1.3);
    g.fillCircle(drumB[0], drumB[1], 1.3);
    // crank arm + grip at the near drum end
    const crkBase = PM(-13, nearW * 4.6, 7.6);
    const crkHnd = PM(-13 + Math.cos(crank) * 4.2, nearW * 4.6, 7.6 + Math.sin(crank) * 4.2);
    beamQ(g, crkBase[0], crkBase[1], crkHnd[0], crkHnd[1], 1.4, 1.1, ironDark);
    g.fillStyle(wood, 1);
    g.fillCircle(crkHnd[0], crkHnd[1], 1.15);

    // ---- A-frame FAR cheek (open truss: two legs + tie strut)
    const cheek = (w: number, near: boolean): void => {
        const col = near ? wood : shade(wood, 0.78);
        const colD = near ? woodDark : shade(woodDark, 0.85);
        const legF0 = PM(6.5, w, DECK - 0.6), legR0 = PM(-8.5, w, DECK - 0.6);
        const apexF = PM(PIV_D + 0.9, w, PIV_H + 1.0), apexR = PM(PIV_D - 0.9, w, PIV_H + 1.0);
        beamQ(g, legR0[0], legR0[1], apexR[0], apexR[1], 3.0, 2.2, col);
        beamQ(g, legF0[0], legF0[1], apexF[0], apexF[1], 3.0, 2.2, col);
        const tieA = PM(2.9, w, 12.2), tieB = PM(-4.9, w, 12.2);
        beamQ(g, tieA[0], tieA[1], tieB[0], tieB[1], 1.8, 1.8, colD);
        if (lvl === 1) {
            g.lineStyle(1.0, lashC, 1);
            for (const q of [PM(5.4, w, 8.2), PM(-7.2, w, 8.2)]) g.lineBetween(q[0] - 1.6, q[1] - 1.2, q[0] + 1.6, q[1] + 1.2);
        }
        if (lvl >= 3) {
            // refined chamfer light along the front leg
            g.lineStyle(0.8, 0xc9c2ae, 1);
            g.lineBetween(legF0[0] + 0.6, legF0[1] - 1, apexF[0] + 0.4, apexF[1] + 1);
        }
    };
    cheek(-nearW * 4.2, false);
    g.fillStyle(ironDark, 1);
    g.fillCircle(PM(PIV_D, -nearW * 4.2, PIV_H)[0], PM(PIV_D, -nearW * 4.2, PIV_H)[1], 1.8);

    // ---- counterweight: chains then the iron box (hangs between the cheeks)
    g.lineStyle(1.0, ironDark, 1);
    g.lineBetween(sh[0] + pxu * 1.5, sh[1] + pyu * 1.5, cwTop[0] + pxu * 2.0, cwTop[1] + pyu * 2.0);
    g.lineBetween(sh[0] - pxu * 1.5, sh[1] - pyu * 1.5, cwTop[0] - pxu * 2.0, cwTop[1] - pyu * 2.0);
    isoBox(cwTop, CW_DB, CW_WB, CW_H, iron, 1.35);
    g.lineStyle(1.1, ironDark, 1);
    g.lineBetween(cwTop[0] - 3.3, cwTop[1] + 1.7, cwTop[0] + 3.3, cwTop[1] + 1.7);
    g.lineBetween(cwTop[0] - 3.3, cwTop[1] + 3.9, cwTop[0] + 3.3, cwTop[1] + 3.9);
    if (lvl >= 2) {
        g.fillStyle(ironLight, 1);
        for (const rx of [-2.4, 2.4]) { g.fillCircle(cwTop[0] + rx, cwTop[1] + 1.7, 0.55); g.fillCircle(cwTop[0] + rx, cwTop[1] + 3.9, 0.55); }
    }
    if (lvl >= 3) {
        g.lineStyle(1.2, brass, 1);
        g.lineBetween(cwTop[0] - 3.3, cwTop[1] + 2.8, cwTop[0] + 3.3, cwTop[1] + 2.8);
        g.lineStyle(0.8, 0xdcd3ba, 1);
        g.lineBetween(cwTop[0] - CW_WB * 0.8, cwTop[1] - 0.2, cwTop[0] + CW_WB * 0.8, cwTop[1] - 0.2);
    }

    // ---- the ARM (dark under-beam, lit top beam, hardware)
    beamQ(g, sh[0], sh[1] + 0.5, tip[0], tip[1] + 0.5, 4.0, 2.1, woodDark);
    beamQ(g, sh[0], sh[1] - 0.4, tip[0], tip[1] - 0.4, 3.0, 1.5, woodLight);
    if (lvl >= 2) {
        g.lineStyle(1.5, ironDark, 1);
        for (const t of [0.3, 0.6]) {
            const bx = piv[0] + (tip[0] - piv[0]) * t, by = piv[1] + (tip[1] - piv[1]) * t;
            const ddx = tip[0] - piv[0], ddy = tip[1] - piv[1];
            const ll = Math.hypot(ddx, ddy) || 1;
            g.lineBetween(bx - (-ddy / ll) * 2.2, by - (ddx / ll) * 2.2, bx + (-ddy / ll) * 2.2, by + (ddx / ll) * 2.2);
        }
    }
    // pivot boss over the arm, tip ferrule + release prong
    g.fillStyle(wood, 1);
    g.fillCircle(piv[0], piv[1], 2.7);
    g.fillStyle(lvl >= 3 ? brass : ironDark, 1);
    g.fillCircle(piv[0], piv[1], 1.5);
    g.fillStyle(lvl >= 3 ? brass : (lvl === 1 ? lashC : ironDark), 1);
    g.fillCircle(tip[0], tip[1], 1.3);
    const prongX = tip[0] + (tip[0] - piv[0]) / (Math.hypot(tip[0] - piv[0], tip[1] - piv[1]) || 1) * 2.6;
    const prongY = tip[1] + (tip[1] - piv[1]) / (Math.hypot(tip[0] - piv[0], tip[1] - piv[1]) || 1) * 2.6;
    g.lineStyle(1.1, lvl >= 3 ? brass : ironDark, 1);
    g.lineBetween(tip[0], tip[1], prongX, prongY);

    // ---- sling (ropes + leather pouch; empty the instant the whip starts)
    if (sling !== 'stowed') {
        let pouch: [number, number];
        if (sling === 'cocked') {
            pouch = pouchCocked();
        } else if (sling === 'whip') {
            const lagPhi = phi - 0.55 * (1 - whipT * 0.5);
            const lagTip = PM(PIV_D - ARM_L * Math.cos(lagPhi), 0, PIV_H + ARM_L * Math.sin(lagPhi));
            const vx = lagTip[0] - tip[0], vy = lagTip[1] - tip[1];
            const vl = Math.hypot(vx, vy) || 1;
            pouch = [tip[0] + vx / vl * 7, tip[1] + vy / vl * 7];
        } else {
            pouch = [tip[0] + fx * slingSway, tip[1] + 6.4 + fy * slingSway];
        }
        g.lineStyle(1.1, shade(ropeC, 0.9), 1);
        g.lineBetween(tip[0], tip[1], pouch[0] - 1.4, pouch[1]);
        g.lineBetween(tip[0], tip[1], pouch[0] + 1.4, pouch[1]);
        g.fillStyle(pouchC, 1);
        g.fillEllipse(pouch[0], pouch[1] + 0.4, 4.6, 2.4);
        if (loaded && sling === 'cocked') {
            g.fillStyle(stoneC, 1); g.fillCircle(pouch[0], pouch[1] - 1.2, 2.5);
            g.fillStyle(stoneHi, 1); g.fillCircle(pouch[0] - 0.8, pouch[1] - 1.9, 0.9);
        }
    }

    // ---- crank rope, drum → arm tip (only while cocking)
    if (haulRope) {
        const dr = PM(-13, 0, 9.2);
        const mx = (dr[0] + tip[0]) / 2, my = (dr[1] + tip[1]) / 2 + 1.2;
        g.lineStyle(1.1, ropeC, 1);
        g.beginPath();
        g.moveTo(dr[0], dr[1]);
        g.lineTo(mx, my);
        g.lineTo(tip[0], tip[1]);
        g.strokePath();
    }

    // ---- A-frame NEAR cheek + axle cap + owner pennant
    cheek(nearW * 4.2, true);
    const cap = PM(PIV_D, nearW * 4.2, PIV_H);
    g.fillStyle(lvl >= 3 ? brass : iron, 1);
    g.fillCircle(cap[0], cap[1], 2.0);
    g.fillStyle(lvl >= 3 ? 0xf0d878 : ironLight, 1);
    g.fillCircle(cap[0] - 0.5, cap[1] - 0.5, 0.7);
    const poleB = PM(PIV_D, nearW * 4.2, PIV_H + 1.2);
    const poleT = PM(PIV_D, nearW * 4.2, PIV_H + 6.6);
    g.lineStyle(1.0, woodDark, 1);
    g.lineBetween(poleB[0], poleB[1], poleT[0], poleT[1]);
    const flap = isMoving ? Math.sin(wph * Math.PI * 4) * 0.9
        : (inCombat ? Math.sin(age / 160) * 0.9 : iSin2 * 0.9);
    quadF(g, [
        [poleT[0], poleT[1]],
        [poleT[0] - fx * 6.4 - pxu * 0.4, poleT[1] - fy * 6.4 - 0.6 + flap],
        [poleT[0] - fx * 1.1, poleT[1] - fy * 1.1 + 2.6]
    ], cloth);
    if (lvl >= 3) {
        g.lineStyle(0.8, brass, 1);
        g.lineBetween(poleT[0] - fx * 1.1, poleT[1] - fy * 1.1 + 2.6, poleT[0] - fx * 6.0 - pxu * 0.4, poleT[1] - fy * 6.0 - 0.4 + flap);
    }

    // ---- near-side wheels
    wheel(10.5, nearW * HWs);
    wheel(-10.5, nearW * HWs);

    // ---- tow ropes + the down-screen crew
    if (towHitches.length) {
        g.lineStyle(1.2, ropeC, 1);
        for (const [hitch, chest] of towHitches) {
            const mx = (hitch[0] + chest[0]) / 2, my = (hitch[1] + chest[1]) / 2 + 1.4;
            g.beginPath();
            g.moveTo(hitch[0], hitch[1]);
            g.lineTo(mx, my);
            g.lineTo(chest[0], chest[1]);
            g.strokePath();
        }
    }
    for (const c of crews) if (c.y - GY >= -1) drawCrew(c);
}
