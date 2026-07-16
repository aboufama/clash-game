import type Phaser from 'phaser';

type G = Phaser.GameObjects.Graphics;

/**
 * CLOCKWORK BEETLE — design A: "The Overwound Scarab".
 *
 * A knee-high da Vinci wind-up bomb: a dark-brass domed shell built from
 * stacked elytra plates with a riveted center seam, a steel wind-up key
 * turning on its back, a tiny gear band peeking out at the shell edge,
 * ember-orange eye slits, and six articulated legs. Cute, ticking, sinister.
 *
 * MOTION CONTRACT (all deterministic in `time` — iron rule 3):
 *  - WALK: one exact stride period of 240 ms. Tripod gait (legs alternate in
 *    two sets of three), body bob |sin| at 120 ms (exact harmonic), the key
 *    turns CONTINUOUSLY at one half-turn per stride — the bow is 2-fold
 *    symmetric, so the key's appearance loops exactly once per 240 ms stride
 *    and the baked walk sheet seams.
 *  - IDLE: ONE declared period of 1000 ms (a 250 ms multiple). Terms, all
 *    exact harmonics: the key ESCAPEMENT-TICKS pi/4 every 250 ms (4 ticks =
 *    half a turn = a closed loop for the 2-fold bow; tip travel ~2.6 world px
 *    per tick, well over the 1.5 px probe floor), the ember eyes pulse on a
 *    1000 ms sine (~50/255 RGB swing over the eye texels), and the gear-band
 *    glint steps one tooth every 250 ms through 4 teeth.
 *  - ATTACK (delay 500, detonateOnAttack — the blast FX is engine-side; this
 *    is only the pre-blast read): windup = the last 450 ms before the tick.
 *    The key OVERWINDS (+3.5pi, ease-in), the shell crouches and shivers,
 *    the riveted seam splits into a widening ember slit, cracks spread down
 *    the dome, the gear band heats, and the eyes flare toward white. The
 *    first 120 ms after the tick is a white-hot flash frame.
 *
 * LEVELS (material progression, gold/white only as subtle accents):
 *  L1 dull dark brass, iron key, punched dark rivets.
 *  L2 richer brass over a copper skirt, polished steel key + steel rivets.
 *  L3 burnished brass, bright steel stem with GOLD bow lobes, gold rivets,
 *     a thin gold rim line on the near shell edge, one white stem glint.
 *
 * Direction-aware: everything is projected through the iso toolkit
 * (along-aim x = cos a, y = sin a * 0.5; across-aim x = -sin a,
 * y = cos a * 0.5), so the design reads at all 8 baked headings; far-side
 * legs and the head layer by the sign of the projection.
 */

const TAU = Math.PI * 2;
const GROUND = 9.5;
const STRIDE_MS = 240; // walk gait period — bake TROOP_PARAMS must match
const IDLE_P_MS = 1000; // declared idle period (250 ms multiple)
const WINDUP_MS = 450; // arming overwind, inside the 500 ms attack delay
const STRIKE_MS = 120; // post-tick flash (engine detonates on the tick)

// Shell geometry (world px, at troop scale 1 — knee-high vs the ~20 px human)
const HL = 6.2; // shell half length (forward)
const HW = 4.6; // shell half width
const RIM_H = 3.2; // rim height above ground (belly clearance)
const DOME_H = 5.0; // dome rise above the rim

// L1..L3 materials
const BRASS_L = [0x74561e, 0x7f6124, 0x8a6b28];
const KEY_L = [0x8f959e, 0xb2b8c2, 0xc9cfd8];
const RIVET_L = [0x4a3814, 0x9aa1ac, 0xdaa520];
const SKIRT_L = [0x453310, 0x6b432a, 0x51400f];

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

/** Multiply a 0xRRGGBB colour toward dark (m<1) or light (m>1). */
function shade(c: number, m: number): number {
    const r = Math.max(0, Math.min(255, Math.round(((c >> 16) & 0xff) * m)));
    const g = Math.max(0, Math.min(255, Math.round(((c >> 8) & 0xff) * m)));
    const b = Math.max(0, Math.min(255, Math.round((c & 0xff) * m)));
    return (r << 16) | (g << 8) | b;
}

/** Linear blend between two 0xRRGGBB colours. */
function lerpC(c1: number, c2: number, t: number): number {
    const k = clamp01(t);
    const r = Math.round(((c1 >> 16) & 0xff) + (((c2 >> 16) & 0xff) - ((c1 >> 16) & 0xff)) * k);
    const g = Math.round(((c1 >> 8) & 0xff) + (((c2 >> 8) & 0xff) - ((c1 >> 8) & 0xff)) * k);
    const b = Math.round((c1 & 0xff) + ((c2 & 0xff) - (c1 & 0xff)) * k);
    return (r << 16) | (g << 8) | b;
}

/** One limb segment as a thick quad from (x0,y0) to (x1,y1). */
function limb(g: G, color: number, x0: number, y0: number, x1: number, y1: number, w: number): void {
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

/** Fill a closed polygon from a flat point list. */
function fillPoly(g: G, pts: number[][], color: number): void {
    g.fillStyle(color, 1);
    g.beginPath();
    g.moveTo(pts[0][0], pts[0][1]);
    for (let i = 1; i < pts.length; i++) g.lineTo(pts[i][0], pts[i][1]);
    g.closePath();
    g.fillPath();
}

export function drawClockworkbeetleA(
    graphics: Phaser.GameObjects.Graphics,
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
    const lvl = Math.max(1, Math.min(3, Math.round(troopLevel || 1)));
    const a = facingAngle || 0;
    const cosA = Math.cos(a), sinA = Math.sin(a);

    // ---- iso projection: d along the facing, w across it, h up.
    const project = (d: number, w: number, h: number): number[] => [
        cosA * d - sinA * w,
        GROUND + (sinA * d + cosA * w) * 0.5 - h
    ];

    // ---- attack cycle (the shared windup/strike contract, local copy).
    const delay = attackDelay > 0 ? attackDelay : 500;
    let age = attackAge;
    const inCombat = age >= 0;
    if (inCombat && age > delay + 600) age = ((time % delay) + delay) % delay; // replay free-run
    let windup = 0, strike = 0;
    if (inCombat) {
        const remaining = delay - age;
        if (remaining <= 0) windup = 1;
        else if (remaining <= WINDUP_MS) windup = 1 - remaining / WINDUP_MS;
        strike = age >= 0 && age <= STRIKE_MS ? 1 - age / STRIKE_MS : 0;
    }
    const armed = !isMoving && inCombat && windup > 0 && strike <= 0;
    const wind = armed ? windup : 0;
    const flashing = !isMoving && inCombat && strike > 0;

    // ---- palettes (enemy machines run darker — the owner convention).
    const ownerM = isPlayer ? 1 : 0.82;
    const brass = shade(BRASS_L[lvl - 1], ownerM);
    const keySteel = shade(KEY_L[lvl - 1], isPlayer ? 1 : 0.9);
    const rivetC = RIVET_L[lvl - 1];
    const spotC = isPlayer ? 0x2e7d32 : 0xa03028; // heraldic shell spots

    // ---- motion rig.
    const wPh = (((time % STRIDE_MS) + STRIDE_MS) % STRIDE_MS) / STRIDE_MS;
    const bob = isMoving ? Math.abs(Math.sin(wPh * TAU)) * 0.55 : 0; // 120 ms — exact stride harmonic
    const windE = 1 - (1 - wind) * (1 - wind); // ease-out
    const crouch = (armed || flashing ? (flashing ? 1 : windE) : 0) * 1.1;
    const lift = bob - crouch; // body height delta (feet stay planted)
    const jx = armed ? Math.sin(wind * 46) * wind * 0.9 : 0; // pre-blast shiver

    // Body-part projector: rides the bob/crouch and the shiver.
    const PB = (d: number, w: number, h: number): number[] => {
        const p = project(d, w, h + lift);
        return [p[0] + jx, p[1]];
    };

    const seg = ((time % IDLE_P_MS) + IDLE_P_MS) % IDLE_P_MS;

    // ---- the key's rotation.
    let keyRot: number;
    if (isMoving) {
        // Continuous: one half-turn per stride; the 2-fold bow makes the
        // appearance period exactly one 240 ms stride.
        keyRot = (((time % (STRIDE_MS * 2)) + STRIDE_MS * 2) % (STRIDE_MS * 2)) / (STRIDE_MS * 2) * TAU;
    } else {
        // Escapement tick: pi/4 every 250 ms with a quick snap, 4 ticks per
        // declared 1000 ms period -> half a turn -> the loop closes.
        const stepI = Math.floor(seg / 250);
        const tickT = (seg % 250) / 250;
        const snap = Math.min(1, tickT / 0.16);
        keyRot = (stepI + (1 - (1 - snap) * (1 - snap))) * (Math.PI / 4);
    }
    if (armed) keyRot += windE * wind * Math.PI * 3.5; // the OVERWIND
    if (flashing) keyRot += Math.PI * 3.5;

    // ---- ember pulse (idle: exact 1000 ms sine; walk: steady — keeps the
    // stride loop exact; armed: flare toward white).
    const pulse = isMoving ? 0.85 : 0.5 + 0.5 * Math.sin((seg / IDLE_P_MS) * TAU);
    const flare = flashing ? 1 : wind;

    // ================= 1. contact shadow =================
    g.fillStyle(0x000000, 0.22);
    g.fillEllipse(0, GROUND + 0.1, 14.5, 5.4);

    // ================= 2. six articulated legs =================
    const legRootD = [3.3, 0.1, -3.1];
    const stanceSw = [0.9, -0.7, 0.5];
    interface Leg { root: number[]; knee: number[]; foot: number[]; far: boolean }
    const legs: Leg[] = [];
    for (let side = -1; side <= 1; side += 2) {
        for (let j = 0; j < 3; j++) {
            let sw = stanceSw[j];
            let liftF = 0;
            if (isMoving) {
                const tri = (j + (side === 1 ? 0 : 1)) % 2; // tripod split
                const ph = wPh * TAU + tri * Math.PI;
                sw = Math.sin(ph) * 2.2;
                liftF = Math.max(0, Math.cos(ph)) * 1.7;
            }
            const splay = (armed || flashing ? windE : 0) * 1.3;
            const root = PB(legRootD[j], side * (HW - 1.0), RIM_H + 0.8);
            const knee = project(legRootD[j] + sw * 0.55, side * (HW + 2.0 + splay * 0.7), 4.3 + liftF * 0.5 + Math.max(0, lift) * 0.5);
            knee[0] += jx * 0.5;
            const foot = project(legRootD[j] + sw, side * (HW + 3.2 + splay), liftF);
            legs.push({ root, knee, foot, far: foot[1] < GROUND - 0.3 });
        }
    }
    const drawLeg = (leg: Leg): void => {
        limb(g, 0x3a2c10, leg.root[0], leg.root[1], leg.knee[0], leg.knee[1], 1.5);
        limb(g, 0x33260d, leg.knee[0], leg.knee[1], leg.foot[0], leg.foot[1], 1.05);
        g.fillStyle(shade(brass, 0.5), 1); // articulation pin
        g.fillCircle(leg.knee[0], leg.knee[1], 0.55);
        g.fillStyle(0x241a08, 1); // foot claw
        g.fillCircle(leg.foot[0], leg.foot[1], 0.6);
    };
    for (const leg of legs) if (leg.far) drawLeg(leg);

    // ================= 3. head (behind the dome when facing up-screen) =====
    const drawHead = (): void => {
        const hc = PB(6.9, 0, RIM_H + 0.4);
        g.fillStyle(shade(brass, 0.52), 1);
        g.fillEllipse(hc[0], hc[1], 4.6, 3.0);
        g.fillStyle(shade(brass, 0.78), 1);
        g.fillEllipse(hc[0] - 0.4, hc[1] - 0.6, 3.2, 1.7);
        // mandible plate
        const m1 = PB(8.7, 1.0, RIM_H);
        const m2 = PB(8.7, -1.0, RIM_H);
        const mt = PB(9.9, 0, RIM_H + 0.2);
        g.fillStyle(0x2c2210, 1);
        g.fillTriangle(m1[0], m1[1], m2[0], m2[1], mt[0], mt[1]);
        // ember eye slits — opaque inner-light, never alpha glow
        const em = 1 + flare * 0.9 + (pulse - 0.5) * 0.5;
        const outerC = flashing ? 0xffd9a0 : lerpC(lerpC(0xb84e12, 0xe86f1e, pulse), 0xffb040, flare);
        const innerC = flashing ? 0xfff6da : lerpC(lerpC(0xff9a2e, 0xffc26a, pulse), 0xfff3cc, flare);
        for (let side = -1; side <= 1; side += 2) {
            const e = PB(8.0, side * 1.35, RIM_H + 1.15);
            g.fillStyle(outerC, 1);
            g.fillEllipse(e[0], e[1], 2.0 * em, 1.25 * em);
            g.fillStyle(innerC, 1);
            g.fillEllipse(e[0], e[1], 1.05 * em, 0.6 * em);
        }
    };
    if (sinA < -0.15) drawHead();

    // ================= 4. shell: skirt, gear band, elytra dome =============
    const ellipsePts = (scale: number, h: number, nwShift: number): number[][] => {
        const pts: number[][] = [];
        for (let k = 0; k < 14; k++) {
            const th = (k / 14) * TAU;
            const p = PB(Math.cos(th) * HL * scale, Math.sin(th) * HW * scale, h);
            pts.push([p[0] - 0.42 * nwShift, p[1] - 0.26 * nwShift]);
        }
        return pts;
    };

    // skirt (the shell's lower edge)
    const skirtC = lerpC(shade(SKIRT_L[lvl - 1], ownerM), 0xa04812, (wind + (flashing ? 1 : 0)) * 0.7);
    fillPoly(g, ellipsePts(1.03, RIM_H - 0.9, 0), skirtC);

    // dome layer 0 (rim plate)
    const heat = flashing ? 0.45 : wind * 0.3;
    fillPoly(g, ellipsePts(1.0, RIM_H, 0), lerpC(shade(brass, 0.62), 0x8a4a16, heat));

    // gear band: teeth peeking out between the rim plate and the dome
    const toothPos: number[][] = [];
    for (let k = 0; k < 10; k++) {
        const th = (k / 10) * TAU + 0.31;
        const bd = Math.cos(th) * HL * 0.97;
        const bw = Math.sin(th) * HW * 0.97;
        if (sinA * bd + cosA * bw > -0.8) toothPos.push(PB(bd, bw, RIM_H + 0.85)); // near-half only
    }
    const toothC = lerpC(shade(0x5c4416, ownerM), 0xd96a1e, flashing ? 1 : wind);
    for (const p of toothPos) {
        g.fillStyle(toothC, 1);
        g.fillRect(p[0] - 0.5, p[1] - 0.5, 1.0, 1.0);
    }
    if (toothPos.length > 0 && !flashing && wind < 0.6) {
        // the glint chase: one bright tooth stepping every 250 ms (idle) or
        // 60 ms (walk — 4 steps per stride, exact harmonic)
        const gi = isMoving ? Math.floor(wPh * 4) % 4 : Math.floor(seg / 250) % 4;
        const p = toothPos[gi % toothPos.length];
        g.fillStyle(lvl >= 3 ? 0xffe9a8 : 0xdfe5ee, 1);
        g.fillRect(p[0] - 0.65, p[1] - 0.65, 1.3, 1.3);
    }
    if (lvl >= 3) {
        // L3: a thin gold line along the near rim — an accent, not a mass.
        // The down-screen-most rim point sits at body angle phi; a ~140°
        // arc around it is the contiguous near edge at every heading.
        const phi = Math.atan2(cosA * HW, sinA * HL);
        g.lineStyle(0.8, 0xc99b2e, 1);
        g.beginPath();
        for (let k = 0; k <= 8; k++) {
            const th = phi - 1.2 + (k / 8) * 2.4;
            const p = PB(Math.cos(th) * HL, Math.sin(th) * HW, RIM_H + 0.35);
            if (k === 0) g.moveTo(p[0], p[1]);
            else g.lineTo(p[0], p[1]);
        }
        g.strokePath();
    }

    // dome layers 1..4 (stacked elytra plates, offset toward the NW light)
    const layerScale = [0.94, 0.85, 0.72, 0.55];
    const layerH = [1.25, 2.5, 3.7, 4.7];
    const layerM = [0.78, 0.94, 1.12, 1.28];
    for (let i = 0; i < 4; i++) {
        fillPoly(g, ellipsePts(layerScale[i], RIM_H + layerH[i], i + 1), lerpC(shade(brass, layerM[i]), 0x8a4a16, heat));
    }
    // crown highlight (NW)
    const hi = PB(-0.6, 0, RIM_H + DOME_H - 0.3);
    g.fillStyle(shade(brass, lvl >= 3 ? 1.55 : 1.45), 1);
    g.fillEllipse(hi[0] - 1.9, hi[1] - 1.2, 3.6, 1.8);

    if (sinA >= -0.15) drawHead();

    // ================= 5. riveted seam (the arming slit) ====================
    const seamH = (d: number): number => RIM_H + DOME_H * Math.sqrt(Math.max(0, 1 - (d / 6.5) * (d / 6.5))) * 0.97;
    const seamPt = (d: number): number[] => {
        const h = seamH(d);
        const p = PB(d, 0, h);
        return [p[0] - (h - RIM_H) * 0.35, p[1] - (h - RIM_H) * 0.22];
    };
    const seamDs = [5.2, 4.2, 3.0, 1.6, 0.0, -1.6, -3.2, -4.6, -5.6];
    const seamPts = seamDs.map(seamPt);
    const strokeSeam = (width: number, color: number): void => {
        g.lineStyle(width, color, 1);
        g.beginPath();
        g.moveTo(seamPts[0][0], seamPts[0][1]);
        for (let i = 1; i < seamPts.length; i++) g.lineTo(seamPts[i][0], seamPts[i][1]);
        g.strokePath();
    };
    strokeSeam(1.1, shade(brass, 0.38));
    if (wind > 0.04 || flashing) {
        // the seam splits: an opaque ember slit widening toward the blast
        strokeSeam(flashing ? 3.0 : 0.7 + 2.3 * wind, flashing ? 0xfff1c8 : lerpC(0xd96a1e, 0xffd27a, wind));
    }
    if (wind > 0.35 || flashing) {
        // glow cracks spreading down the dome
        const cw = flashing ? 1 : clamp01((wind - 0.35) / 0.65);
        g.lineStyle(1.05, flashing ? 0xffd9a0 : lerpC(0xc0500f, 0xffb45a, cw), 1);
        const cracks = [[2.4, 1], [-0.6, -1], [-2.8, 1]];
        for (const [cd, cs] of cracks) {
            const h0 = seamH(cd);
            const p0 = seamPt(cd);
            const p1 = PB(cd - 0.5, cs * (1.1 + 1.6 * cw), h0 - 1.1);
            const p2 = PB(cd - 1.0, cs * (1.9 + 2.6 * cw), h0 - 2.4);
            g.beginPath();
            g.moveTo(p0[0], p0[1]);
            g.lineTo(p1[0] - (h0 - 1.1 - RIM_H) * 0.3, p1[1] - (h0 - 1.1 - RIM_H) * 0.18);
            g.lineTo(p2[0] - (h0 - 2.4 - RIM_H) * 0.3, p2[1] - (h0 - 2.4 - RIM_H) * 0.18);
            g.strokePath();
        }
    }
    // seam rivets
    for (const rd of [3.6, 1.8, -0.2, -2.2, -4.0]) {
        const p = seamPt(rd);
        g.fillStyle(rivetC, 1);
        g.fillCircle(p[0], p[1], 0.55);
    }

    // ================= 6. heraldic owner spots ==============================
    for (let side = -1; side <= 1; side += 2) {
        const p = PB(-2.2, side * 2.3, RIM_H + 3.1);
        const sx = p[0] - 1.0, sy = p[1] - 0.62; // match the dome layer shift
        g.fillStyle(shade(spotC, 0.55), 1);
        g.fillCircle(sx, sy, 1.25);
        g.fillStyle(shade(spotC, ownerM), 1);
        g.fillCircle(sx, sy, 0.95);
    }

    // ================= 7. near legs (in front of the shell) ================
    for (const leg of legs) if (!leg.far) drawLeg(leg);

    // ================= 8. the wind-up KEY ===================================
    const kb = PB(-1.0, 0, RIM_H + DOME_H - 0.5);
    kb[0] -= 1.45;
    kb[1] -= 0.9; // sit the mount on the NW-shifted crown
    const kt = [kb[0], kb[1] - 3.0];
    // winding collar
    g.fillStyle(shade(keySteel, 0.6), 1);
    g.fillEllipse(kb[0], kb[1], 2.8, 1.5);
    g.fillStyle(shade(keySteel, 0.95), 1);
    g.fillEllipse(kb[0], kb[1] - 0.3, 2.0, 1.0);
    // stem
    limb(g, shade(keySteel, 0.82), kb[0], kb[1] - 0.4, kt[0], kt[1], 1.15);
    // bow: spins about the vertical axis -> tips trace a 2:1 screen ellipse
    const KR = 3.3;
    const td = Math.cos(keyRot) * KR, tw = Math.sin(keyRot) * KR;
    const ox = cosA * td - sinA * tw;
    const oy = (sinA * td + cosA * tw) * 0.5;
    const t1 = [kt[0] + ox, kt[1] + oy];
    const t2 = [kt[0] - ox, kt[1] - oy];
    const lobeC = lvl >= 3 ? shade(0xdaa520, isPlayer ? 1 : 0.9) : keySteel;
    const drawLobe = (p: number[]): void => {
        g.fillStyle(lobeC, 1);
        g.fillCircle(p[0], p[1], 1.35);
        g.fillStyle(0x23262c, 1);
        g.fillCircle(p[0], p[1], 0.55);
    };
    if (t1[1] <= t2[1]) {
        drawLobe(t1);
        limb(g, shade(keySteel, 1.05), t1[0], t1[1], t2[0], t2[1], 1.15);
        drawLobe(t2);
    } else {
        drawLobe(t2);
        limb(g, shade(keySteel, 1.05), t2[0], t2[1], t1[0], t1[1], 1.15);
        drawLobe(t1);
    }
    if (lvl >= 3) {
        // one white glint on the stem head — subtle, per the max-level rule
        g.fillStyle(0xf6f2e4, 1);
        g.fillCircle(kt[0] + 0.5, kt[1] - 0.2, 0.4);
    }
}
