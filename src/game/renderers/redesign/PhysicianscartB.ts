import type Phaser from 'phaser';

type G = Phaser.GameObjects.Graphics;

/**
 * PHYSICIAN'S CART — design B: "The Apothecary Tall-Chest".
 *
 * The cart is the hero: a tall pale-green medicine chest (0x8fd98f) riding
 * two heroic spoked cartwheels, red-cross panels on the flank, the end AND
 * the lid, a corked vial rack across the back of the lid, one great round
 * green flask up front in a holder ring, and herb bundles swinging from the
 * lid overhang. The doctor is the motor: a long-robed plague doctor (no
 * visible legs — a swaying hem with boot tips peeking on the stride, wide
 * brim hat, pale bone beak, glass lens, medic satchel) leaning into two
 * push-handles behind the chest.
 *
 * TIMING CONTRACT (bake-synced):
 *  - Walk stride  = 500 ms exactly. Wheels advance 2 spoke-steps (2π/3 of a
 *    6-spoke wheel) per stride — an exact harmonic, so the 6-frame walk
 *    loop closes seamlessly. Vials rattle at 2 cycles/stride (250 ms).
 *  - Idle period  = 2000 ms exactly (250 ms multiple). Terms: herb-bundle
 *    sway ±1.8 px @ 1 cycle/P, beak-mask glance ±0.55 rad (tip ≈ ±2.6 px)
 *    @ 1 cycle/P, breath lift @ 2 cycles/P, vial-glint chase stepping every
 *    P/4 (≥16/255 RGB swing). All exact harmonics of the declared period.
 *  - Heal pulse: attackAge sequence with delay = attackDelay (6000 ms at
 *    L1). WINDUP = last 1400 ms before the tick — the doctor's near arm
 *    leaves the handle and stirs the mortar bowl on the rear shelf
 *    (accelerating stir, green motes rising, vial/flask liquid brightening).
 *    STRIKE = first 420 ms after the tick — the arm snaps skyward lifting a
 *    small green drachm while the big lid flask hops and flashes (opaque
 *    star + expanding ring; hard age gates, no translucency).
 *  - Stale ages free-run on time % delay (replay contract); attackAge < 0
 *    = camp idle, no pulse choreography.
 *
 * LEVELS: L1 humble (all wood, rope-lashed corners, 3 vials, stone bowl) →
 * L2 iron rim bands + brass bowl/lens rims, 4 vials, cream panel frame →
 * L3 refined: gold hubs, gold rim pinstripe, gold cross border + lid
 * finial, white hat band — accents only, never masses.
 *
 * All motion is a deterministic f(time/attackAge); facingAngle is consumed
 * trigonometrically (screen-space angle, iso 0.5 vertical squash), so the
 * design reads at all 8 baked headings. `driver` is unused (always 0).
 */

const TAU = Math.PI * 2;

function pcbClamp01(v: number): number {
    return v < 0 ? 0 : v > 1 ? 1 : v;
}

function pcbEaseOut(t: number): number {
    return 1 - (1 - t) * (1 - t);
}

/** Multiply a 0xRRGGBB colour toward dark (m<1) or light (m>1). */
function pcbShade(c: number, m: number): number {
    const r = Math.max(0, Math.min(255, Math.round(((c >> 16) & 0xff) * m)));
    const g = Math.max(0, Math.min(255, Math.round(((c >> 8) & 0xff) * m)));
    const b = Math.max(0, Math.min(255, Math.round((c & 0xff) * m)));
    return (r << 16) | (g << 8) | b;
}

/** Per-channel lerp between two 0xRRGGBB colours. */
function pcbLerpColor(a: number, b: number, t: number): number {
    const k = pcbClamp01(t);
    const r = Math.round(((a >> 16) & 0xff) + (((b >> 16) & 0xff) - ((a >> 16) & 0xff)) * k);
    const gg = Math.round(((a >> 8) & 0xff) + (((b >> 8) & 0xff) - ((a >> 8) & 0xff)) * k);
    const bb = Math.round((a & 0xff) + ((b & 0xff) - (a & 0xff)) * k);
    return (r << 16) | (gg << 8) | bb;
}

/** Per-slot bake-param overrides (DesignRegistry.designBakeParams): authored
 *  periods that differ from the TROOP_PARAMS row (800/400, no idleMs). The
 *  heal choreography winds up over WINDUP = 1400 ms and snaps skyward for
 *  STRIKE = 420 ms; idle closes on IDLE_P = 2000. */
export const PARAMS: import('./DesignRegistry').DesignParamsExport = {
    physicianscart: { windup: 1400, strike: 420, idleMs: 2000 },
};

export function drawPhysicianscartB(
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
    // ---------------- axes (screen-space heading, iso squash 0.5) ----------
    const fa = facingAngle || 0;
    const cosF = Math.cos(fa);
    const sinF = Math.sin(fa);
    const ax = (d: number): number => cosF * d;
    const ay = (d: number): number => sinF * 0.5 * d;
    const px = (w: number): number => -sinF * w;
    const py = (w: number): number => cosF * 0.5 * w;
    const GROUND = 9;
    /** Ground offset d along travel, w across, h up → screen point. */
    const P = (d: number, w: number, h: number): [number, number] =>
        [ax(d) + px(w), GROUND + ay(d) + py(w) - h];

    // ---------------- palette ----------------------------------------------
    const own = isPlayer ? 1 : 0.8;
    const CHEST = pcbShade(0x8fd98f, own);           // the pale-green hero
    const RED = isPlayer ? 0xd0403a : 0xb03530;      // cross red
    const WOOD = pcbShade(0x8a5a2e, isPlayer ? 1 : 0.85);
    const WOOD_DK = pcbShade(0x543518, isPlayer ? 1 : 0.85);
    const IRON = 0x565b64;
    const GOLD = 0xdaa520;
    const BONE = 0xe6ddc6;
    const BONE_DK = 0xbfb298;
    const ROBE = isPlayer ? 0x322a40 : 0x33261c;
    const ROBE_DK = isPlayer ? 0x231d2e : 0x241a12;
    const HAT = isPlayer ? 0x1e1926 : 0x1d1510;
    const GLOVE = 0x3a2e22;
    const LEATHER = 0x6a4a26;

    // ---------------- clocks ------------------------------------------------
    const STRIDE = 500;                              // ms — the ONE gait period
    const IDLE_P = 2000;                             // ms — declared idle period
    const walkPh = (time % STRIDE) / STRIDE;
    const sWalk = Math.sin(walkPh * TAU);
    const idPh = ((time % IDLE_P) / IDLE_P) * TAU;
    const breath = Math.sin(idPh * 2) * 0.5 + 0.5;   // 2 cycles / idle period
    const cartBob = isMoving ? Math.abs(sWalk) * 0.9 : 0;
    // 6 spokes; +2 spoke-steps per stride keeps the walk loop seamless.
    const wheelRot = isMoving ? walkPh * (TAU / 3) : 0.35;

    // ---------------- heal-pulse state (the attackAnim contract) -----------
    const delay = attackDelay > 0 ? attackDelay : 6000;
    const inCombat = attackAge >= 0;
    let age = inCombat ? attackAge : Infinity;
    if (inCombat && age > delay + 600) age = time % delay; // replay free-run
    const WINDUP = 1400;
    const STRIKE = 420;
    let windup = 0;
    if (inCombat) {
        const remaining = delay - age;
        if (remaining <= 0) windup = 1;
        else if (remaining <= WINDUP) windup = 1 - remaining / WINDUP;
    }
    const strike = inCombat && age <= STRIKE ? 1 - age / STRIKE : 0;
    const glow = Math.max(windup, strike);
    const stirring = !isMoving && inCombat && windup > 0 && strike <= 0;
    const lifting = inCombat && strike > 0;

    // ---------------- layout constants -------------------------------------
    const D_CART = 5;                                // chest centre, along travel
    const D_DOC = -10;                               // doctor ground offset
    const CH_B = D_CART - 7;                         // chest back  (-2)
    const CH_F = D_CART + 7;                         // chest front (+12)
    const CH_W = 5;                                  // chest half width
    const FLOOR = 8.6;
    const TOP = 19.6;
    const LID_T = 21.0;
    const OVR = 0.7;                                 // lid overhang
    const WHEEL_R = 5.9;
    const WHEEL_W = 7.2;                             // hub offset across

    const nearSide = cosF >= 0 ? 1 : -1;             // ±w side facing down-screen
    const frontVis = sinF >= 0;                      // travel-facing end visible?
    const docFirst = sinF > 0;                       // doctor up-screen → paint first

    // ---------------- tiny geometry helpers --------------------------------
    const quad = (pts: number[][], color: number): void => {
        g.fillStyle(color, 1);
        g.beginPath();
        g.moveTo(pts[0][0], pts[0][1]);
        for (let i = 1; i < pts.length; i++) g.lineTo(pts[i][0], pts[i][1]);
        g.closePath();
        g.fillPath();
    };
    const limb = (color: number, x0: number, y0: number, x1: number, y1: number, w: number): void => {
        const dx = x1 - x0, dy = y1 - y0;
        const len = Math.hypot(dx, dy) || 1;
        const nx = (-dy / len) * (w / 2), ny = (dx / len) * (w / 2);
        quad([[x0 + nx, y0 + ny], [x1 + nx, y1 + ny], [x1 - nx, y1 - ny], [x0 - nx, y0 - ny]], color);
    };
    /** NW-light face brightness from a screen-space outward normal. */
    const faceShade = (nx: number, ny: number): number => {
        const len = Math.hypot(nx, ny) || 1;
        return 0.8 + 0.28 * pcbClamp01(-nx / len);
    };

    // ---------------- the doctor (positions shared by several passes) ------
    const [dxg, dyg] = P(D_DOC, 0, 0);
    const lift = isMoving ? Math.abs(sWalk) * 1.1 : breath * 0.55;
    const leanAmt = isMoving ? 1.7 : (stirring ? 2.2 * pcbClamp01(windup * 2.5) : 0.25 * (breath - 0.5) * 2);
    const sox = cosF * leanAmt;                      // shoulder lean, screen x
    const shY = dyg - 10.8 - lift;                   // shoulder line
    const hx = dxg + sox * 1.25;
    const hy = dyg - 13.6 - lift;
    const glance = isMoving ? Math.sin(walkPh * TAU) * 0.05 : Math.sin(idPh + 1.1) * 0.55;
    const gz = fa + glance;                          // gaze angle (beak)

    // Handle bars: chest back → doctor's hands.
    const hbF: [number, number][] = [P(CH_B, -3.6, 8.1 + cartBob), P(CH_B, 3.6, 8.1 + cartBob)];
    const hbB: [number, number][] = [P(-8.3, -2.8, 5.6 + lift * 0.4), P(-8.3, 2.8, 5.6 + lift * 0.4)];

    // Rear shelf bowl (stir target).
    const [bx, by] = P(CH_B - 1.6, 0, 10.6 + cartBob);
    // Lid flask (release hero).
    const [fxB, fyB] = P(9.3, 0, LID_T + cartBob);
    const hop = 3.2 * pcbEaseOut(strike);
    const fx = fxB;
    const fy = fyB - 2.9 - hop;
    const liquidCol = pcbLerpColor(pcbShade(0x58b558, own), 0xc4ffbc, glow);

    const drawDoctorBody = (): void => {
        // Boot tips peeking on the stride (robe hides the legs).
        if (isMoving) {
            const step = sWalk * 1.6;
            g.fillStyle(0x241c14, 1);
            g.fillEllipse(dxg + ax(step) + px(0.9), dyg + ay(step) + py(0.9) + 0.3, 2.6, 1.4);
            g.fillEllipse(dxg + ax(-step) + px(-0.9), dyg + ay(-step) + py(-0.9) + 0.3, 2.6, 1.4);
        }
        // Long robe: swaying hem → leaning shoulders.
        const hemK = isMoving ? sWalk * 0.8 : Math.sin(idPh) * 0.35;
        quad([
            [dxg - 3.3 - hemK, dyg + 0.3],
            [dxg + 3.3 - hemK, dyg + 0.3],
            [dxg + 2.05 + sox, shY],
            [dxg - 2.05 + sox, shY]
        ], ROBE);
        g.fillStyle(ROBE, 1);
        g.fillEllipse(dxg + sox, shY + 0.2, 4.4, 3.1);
        // Front seam + buttons.
        g.lineStyle(0.8, ROBE_DK, 1);
        g.lineBetween(dxg + sox * 0.9, shY + 1, dxg - hemK * 0.6, dyg + 0.1);
        g.fillStyle(ROBE_DK, 1);
        for (let i = 0; i < 3; i++) {
            const t = 0.22 + i * 0.26;
            g.fillCircle(dxg + (sox * 0.9) * (1 - t) - hemK * 0.6 * t, (shY + 1) * (1 - t) + (dyg + 0.1) * t, 0.55);
        }
        // Medic satchel + strap (red cross keepsake on the doctor himself).
        g.lineStyle(1, LEATHER, 1);
        g.lineBetween(dxg + sox + 1.8, shY + 0.4, dxg - 2.9, dyg - 3.6);
        g.fillStyle(LEATHER, 1);
        g.fillRoundedRect(dxg - 4.4, dyg - 4.6, 3.4, 3, 0.8);
        g.fillStyle(pcbShade(LEATHER, 0.7), 1);
        g.fillRect(dxg - 4.4, dyg - 4.6, 3.4, 1.1);
        g.fillStyle(RED, 1);
        g.fillRect(dxg - 3.05, dyg - 3.3, 0.7, 1.6);
        g.fillRect(dxg - 3.5, dyg - 2.85, 1.6, 0.7);
        // Hood collar, then the masked head: a dark hood ball with a bone
        // face plate + beak along the gaze. When the gaze points up-screen
        // the mask paints FIRST so the hood occludes it (seen from behind,
        // only the beak tip peeks past the head — the correct read).
        g.fillStyle(ROBE_DK, 1);
        g.fillCircle(dxg + sox, dyg - 11.2 - lift, 2.3);
        const drawMask = (): void => {
            const mfx = hx + Math.cos(gz) * 1.4;
            const mfy = hy + Math.sin(gz) * 0.5 * 1.4 + 0.15;
            g.fillStyle(BONE, 1);
            g.fillCircle(mfx, mfy, 2.35);
            const tipX = hx + Math.cos(gz) * 5.6;
            const tipY = hy + Math.sin(gz) * 0.5 * 5.6 + 1.0;
            const bpx = -Math.sin(gz) * 1.6, bpy = Math.cos(gz) * 0.5 * 1.6;
            quad([[mfx + bpx, mfy + bpy], [mfx - bpx, mfy - bpy], [tipX, tipY]], BONE);
            g.lineStyle(0.7, BONE_DK, 1);
            g.lineBetween(mfx + Math.cos(gz) * 1.2, mfy + Math.sin(gz) * 0.5 * 1.2 + 0.3, tipX, tipY);
            const rimCol = troopLevel >= 3 ? GOLD : (troopLevel >= 2 ? 0x8a7a5a : 0x4a4438);
            const lensAt = (lx: number, ly: number): void => {
                g.fillStyle(rimCol, 1);
                g.fillCircle(lx, ly, 1.3);
                g.fillStyle(0x1c1a17, 1);
                g.fillCircle(lx, ly, 0.85);
                g.fillStyle(0xbfd9c9, 1);
                g.fillCircle(lx - 0.3, ly - 0.3, 0.35);
            };
            const lcx = hx + Math.cos(gz) * 2.1, lcy = hy + Math.sin(gz) * 0.5 * 2.1 - 0.85;
            if (Math.sin(gz) > 0.25) {
                lensAt(lcx - Math.sin(gz) * 1.35, lcy + Math.cos(gz) * 0.5 * 1.35);
                lensAt(lcx + Math.sin(gz) * 1.35, lcy - Math.cos(gz) * 0.5 * 1.35);
            } else {
                lensAt(lcx, lcy);
            }
        };
        const faceAway = Math.sin(gz) < -0.35;
        if (faceAway) drawMask();
        g.fillStyle(ROBE_DK, 1);
        g.fillCircle(hx, hy, 2.9);
        if (!faceAway) drawMask();
        // Wide-brim hat over everything.
        g.fillStyle(HAT, 1);
        g.fillEllipse(hx, hy - 2.5, 10.8, 3.3);
        g.fillStyle(pcbShade(HAT, 1.35), 1);
        g.fillEllipse(hx - 0.5, hy - 2.9, 8, 1.9);
        g.fillStyle(HAT, 1);
        g.fillRoundedRect(hx - 2.9, hy - 7.3, 5.8, 5.1, 2);
        const bandCol = troopLevel >= 3 ? 0xe9e2cf : (troopLevel >= 2 ? 0x6b5a3a : pcbShade(HAT, 1.5));
        g.fillStyle(bandCol, 1);
        g.fillRect(hx - 2.9, hy - 3.8, 5.8, 1);
        if (troopLevel >= 3) {
            g.fillStyle(GOLD, 1);
            g.fillRect(hx + 1.7, hy - 3.9, 1.2, 1.2);
        }
    };

    const drawHandles = (): void => {
        for (const s of [0, 1]) {
            limb(WOOD, hbF[s][0], hbF[s][1], hbB[s][0], hbB[s][1], 1.4);
            g.fillStyle(WOOD_DK, 1);
            g.fillCircle(hbB[s][0], hbB[s][1], 0.8);
        }
    };

    const drawArms = (): void => {
        const shL: [number, number] = [dxg + sox + px(-2.2), shY + 1.2 + py(-2.2)];
        const shR: [number, number] = [dxg + sox + px(2.2), shY + 1.2 + py(2.2)];
        // The near-side arm performs the pulse; the far arm keeps the handle.
        const nearIdx = nearSide > 0 ? 1 : 0;
        const farSh = nearIdx === 1 ? shL : shR;
        const nearSh = nearIdx === 1 ? shR : shL;
        const farHand = hbB[1 - nearIdx];
        limb(ROBE, farSh[0], farSh[1], farHand[0], farHand[1], 2);
        g.fillStyle(GLOVE, 1);
        g.fillCircle(farHand[0], farHand[1], 1.15);

        let nearHand: [number, number] = [hbB[nearIdx][0], hbB[nearIdx][1]];
        if (lifting) {
            // RELEASE — the drachm snaps skyward, peaking on the damage tick.
            const raise = pcbEaseOut(strike);
            nearHand = [dxg + sox + cosF * 3.2, dyg - 16 - lift - 4.5 * raise];
        } else if (stirring) {
            // WIND-UP — reach to the mortar bowl and stir, accelerating.
            const reach = pcbClamp01(windup * 3);
            const stirAng = TAU * (3.5 * windup * windup) + 0.6;
            const sx2 = bx + Math.cos(stirAng) * 1.5;
            const sy2 = by - 4.2 + Math.sin(stirAng) * 0.7;
            nearHand = [
                hbB[nearIdx][0] + (sx2 - hbB[nearIdx][0]) * reach,
                hbB[nearIdx][1] + (sy2 - hbB[nearIdx][1]) * reach
            ];
            if (reach > 0.85) {
                // The pestle, hand → bowl.
                g.lineStyle(1.4, pcbShade(WOOD, 1.15), 1);
                g.lineBetween(nearHand[0], nearHand[1], bx + Math.cos(stirAng) * 1.2, by - 0.6 + Math.sin(stirAng) * 0.5);
            }
        }
        limb(ROBE, nearSh[0], nearSh[1], nearHand[0], nearHand[1], 2);
        g.fillStyle(GLOVE, 1);
        g.fillCircle(nearHand[0], nearHand[1], 1.15);
        if (lifting) {
            // The lifted drachm: cork, neck, glowing bulb.
            g.fillStyle(0xb98d4f, 1);
            g.fillRect(nearHand[0] - 0.7, nearHand[1] - 6.1, 1.4, 1.2);
            g.fillStyle(0xcfe8d4, 1);
            g.fillRect(nearHand[0] - 0.85, nearHand[1] - 5, 1.7, 2);
            g.fillStyle(liquidCol, 1);
            g.fillCircle(nearHand[0], nearHand[1] - 2, 1.9);
            g.fillStyle(0xf2fff0, 1);
            g.fillCircle(nearHand[0] - 0.6, nearHand[1] - 2.6, 0.55);
        }
    };

    const drawWheel = (w: number): void => {
        const [cx, cy] = P(D_CART, w, WHEEL_R);
        const rim = (r: number, th: number): [number, number] =>
            [cx + cosF * r * Math.cos(th), cy + sinF * 0.5 * r * Math.cos(th) - r * Math.sin(th)];
        // Tire: filled disc + a thick outline so the wheel keeps a presence
        // even edge-on (heading straight up/down-screen).
        const pts: number[][] = [];
        for (let i = 0; i < 16; i++) pts.push(rim(WHEEL_R, (i / 16) * TAU));
        quad(pts, WOOD_DK);
        g.lineStyle(1.7, pcbShade(WOOD_DK, 0.72), 1);
        g.beginPath();
        g.moveTo(pts[0][0], pts[0][1]);
        for (let i = 1; i < 16; i++) g.lineTo(pts[i][0], pts[i][1]);
        g.closePath();
        g.strokePath();
        const inner: number[][] = [];
        for (let i = 0; i < 16; i++) inner.push(rim(WHEEL_R - 1.9, (i / 16) * TAU));
        quad(inner, pcbShade(WOOD, 0.92));
        if (troopLevel >= 2) {
            // Iron band; L3 adds a gold pinstripe inside it.
            g.lineStyle(1.1, IRON, 1);
            g.beginPath();
            g.moveTo(pts[0][0], pts[0][1]);
            for (let i = 1; i < 16; i++) g.lineTo(pts[i][0], pts[i][1]);
            g.closePath();
            g.strokePath();
            if (troopLevel >= 3) {
                const gp: number[][] = [];
                for (let i = 0; i < 16; i++) gp.push(rim(WHEEL_R - 1.1, (i / 16) * TAU));
                g.lineStyle(0.7, GOLD, 1);
                g.beginPath();
                g.moveTo(gp[0][0], gp[0][1]);
                for (let i = 1; i < 16; i++) g.lineTo(gp[i][0], gp[i][1]);
                g.closePath();
                g.strokePath();
            }
        }
        // Six spokes, rolling with the stride.
        g.lineStyle(1.2, pcbShade(WOOD_DK, 1.35), 1);
        for (let i = 0; i < 6; i++) {
            const th = wheelRot + (i * Math.PI) / 3;
            const [ex, ey] = rim(WHEEL_R - 1.6, th);
            g.lineBetween(cx, cy, ex, ey);
        }
        const hubCol = troopLevel >= 3 ? GOLD : (troopLevel >= 2 ? IRON : WOOD_DK);
        g.fillStyle(hubCol, 1);
        g.fillCircle(cx, cy, 1.9);
        g.fillStyle(pcbShade(hubCol, 0.6), 1);
        g.fillCircle(cx, cy, 0.7);
    };

    const drawHerb = (d: number, w: number, seed: number): void => {
        const [axp, ayp] = P(d, w, TOP + cartBob + 0.8);
        const sway = isMoving
            ? -1.2 + Math.sin(walkPh * TAU + seed) * 0.7
            : Math.sin(idPh + seed) * 1.8;
        const sx2 = axp + cosF * sway;
        const sy2 = ayp + sinF * 0.5 * sway + 4.4;
        g.lineStyle(0.9, 0x6b5a35, 1);
        g.lineBetween(axp, ayp, sx2, sy2 - 1.6);
        g.fillStyle(pcbShade(0x4d7a3a, own), 1);
        g.fillEllipse(sx2, sy2, 2.7, 3.6);
        g.fillStyle(pcbShade(0x3c6130, own), 1);
        g.fillEllipse(sx2 + 0.8, sy2 + 0.7, 1.8, 2.6);
        g.fillStyle(pcbShade(0x71a04c, own), 1);
        g.fillEllipse(sx2 - 0.8, sy2 - 0.8, 1.5, 2.1);
        g.fillStyle(0xb9a06a, 1);
        g.fillRect(axp + cosF * sway * 0.3 - 0.8, ayp + 1.2, 1.6, 0.9);
    };

    const drawChest = (): void => {
        const hb = cartBob;
        // Axle + visible face selection happen around this box.
        const sSign = nearSide;                       // visible side (w = sSign·CH_W)
        const eD = frontVis ? CH_F : CH_B;            // visible end
        const eSign = frontVis ? 1 : -1;
        const sideCol = pcbShade(CHEST, faceShade(-sinF * sSign, 0.5 * cosF * sSign));
        const endCol = pcbShade(CHEST, faceShade(cosF * eSign, 0.5 * sinF * eSign));
        const lidCol = pcbShade(CHEST, 1.16);

        // Side face.
        quad([
            P(CH_B, sSign * CH_W, FLOOR + hb), P(CH_F, sSign * CH_W, FLOOR + hb),
            P(CH_F, sSign * CH_W, TOP + hb), P(CH_B, sSign * CH_W, TOP + hb)
        ], sideCol);
        // Plank lines + dark skirt.
        g.lineStyle(0.8, pcbShade(sideCol, 0.8), 1);
        for (const lh of [12.2, 15.8]) {
            const a = P(CH_B + 0.3, sSign * CH_W, lh + hb);
            const b = P(CH_F - 0.3, sSign * CH_W, lh + hb);
            g.lineBetween(a[0], a[1], b[0], b[1]);
        }
        quad([
            P(CH_B, sSign * CH_W, FLOOR + hb), P(CH_F, sSign * CH_W, FLOOR + hb),
            P(CH_F, sSign * CH_W, FLOOR + 1.4 + hb), P(CH_B, sSign * CH_W, FLOOR + 1.4 + hb)
        ], pcbShade(sideCol, 0.68));
        // End face.
        quad([
            P(eD, -CH_W, FLOOR + hb), P(eD, CH_W, FLOOR + hb),
            P(eD, CH_W, TOP + hb), P(eD, -CH_W, TOP + hb)
        ], endCol);
        quad([
            P(eD, -CH_W, FLOOR + hb), P(eD, CH_W, FLOOR + hb),
            P(eD, CH_W, FLOOR + 1.4 + hb), P(eD, -CH_W, FLOOR + 1.4 + hb)
        ], pcbShade(endCol, 0.68));
        // Corner definition at the shared vertical edge.
        {
            const a = P(eD, sSign * CH_W, FLOOR + hb);
            const b = P(eD, sSign * CH_W, TOP + hb);
            g.lineStyle(1, pcbShade(CHEST, 0.58), 1);
            g.lineBetween(a[0], a[1], b[0], b[1]);
        }
        // Corner trim by level: rope (L1) / iron (L2) / gold (L3).
        if (troopLevel >= 2) {
            const a = P(eD, sSign * CH_W, FLOOR + 1.6 + hb);
            const b = P(eD, sSign * CH_W, TOP - 1.2 + hb);
            g.lineStyle(0.9, troopLevel >= 3 ? GOLD : IRON, 1);
            g.lineBetween(a[0], a[1], b[0], b[1]);
        } else {
            const a = P(eD, sSign * CH_W, FLOOR + 1.8 + hb);
            g.fillStyle(0xb9a06a, 1);
            g.fillRect(a[0] - 1, a[1] - 0.5, 2, 1);
        }

        // ---- red cross panel on the side face (the hero read) ----
        const fdS = (d: number, h: number): [number, number] => P(d, sSign * CH_W, h + hb);
        if (troopLevel >= 3) quad([fdS(1.3, 10.5), fdS(8.7, 10.5), fdS(8.7, 17.9), fdS(1.3, 17.9)], GOLD);
        else if (troopLevel >= 2) quad([fdS(1.4, 10.6), fdS(8.6, 10.6), fdS(8.6, 17.8), fdS(1.4, 17.8)], 0xded8c2);
        quad([fdS(1.6, 10.8), fdS(8.4, 10.8), fdS(8.4, 17.6), fdS(1.6, 17.6)], pcbShade(CHEST, 1.22));
        quad([fdS(4.3, 11.5), fdS(5.7, 11.5), fdS(5.7, 16.9), fdS(4.3, 16.9)], RED);
        quad([fdS(2.4, 13.5), fdS(7.6, 13.5), fdS(7.6, 14.9), fdS(2.4, 14.9)], RED);
        // ---- small cross straight on the end face ----
        const fdE = (w: number, h: number): [number, number] => P(eD, w, h + hb);
        quad([fdE(-0.8, 11.5), fdE(0.8, 11.5), fdE(0.8, 16.7), fdE(-0.8, 16.7)], RED);
        quad([fdE(-2.7, 13.4), fdE(2.7, 13.4), fdE(2.7, 14.8), fdE(-2.7, 14.8)], RED);

        // ---- lid slab: rim strip on the visible faces, then the top ----
        quad([
            P(CH_B - OVR, sSign * (CH_W + OVR), TOP + hb), P(CH_F + OVR, sSign * (CH_W + OVR), TOP + hb),
            P(CH_F + OVR, sSign * (CH_W + OVR), LID_T + hb), P(CH_B - OVR, sSign * (CH_W + OVR), LID_T + hb)
        ], pcbShade(sideCol, 0.9));
        const eDo = frontVis ? CH_F + OVR : CH_B - OVR;
        quad([
            P(eDo, -(CH_W + OVR), TOP + hb), P(eDo, CH_W + OVR, TOP + hb),
            P(eDo, CH_W + OVR, LID_T + hb), P(eDo, -(CH_W + OVR), LID_T + hb)
        ], pcbShade(endCol, 0.9));
        quad([
            P(CH_B - OVR, -(CH_W + OVR), LID_T + hb), P(CH_F + OVR, -(CH_W + OVR), LID_T + hb),
            P(CH_F + OVR, CH_W + OVR, LID_T + hb), P(CH_B - OVR, CH_W + OVR, LID_T + hb)
        ], lidCol);
        // Lid cross (reads at every heading).
        const fdL = (d: number, w: number): [number, number] => P(d, w, LID_T + hb + 0.05);
        quad([fdL(1.8, -0.9), fdL(6.6, -0.9), fdL(6.6, 0.9), fdL(1.8, 0.9)], pcbShade(RED, 1.06));
        quad([fdL(3.5, -2.8), fdL(4.9, -2.8), fdL(4.9, 2.8), fdL(3.5, 2.8)], pcbShade(RED, 1.06));
        if (troopLevel >= 3) {
            // Gold finial dot at the lid front — a subtle crown accent.
            const [gx2, gy2] = P(CH_F - 0.6, 0, LID_T + hb);
            g.fillStyle(GOLD, 1);
            g.fillCircle(gx2, gy2 - 0.7, 1.05);
        }

        // ---- vial rack across the back of the lid ----
        quad([fdL(-1.7, -4.1), fdL(0.3, -4.1), fdL(0.3, 4.1), fdL(-1.7, 4.1)], pcbShade(CHEST, 0.84));
        const nV = troopLevel >= 2 ? 4 : 3;
        const glintIdx = Math.floor((time % IDLE_P) / (IDLE_P / 4)) % nV;
        const drawVial = (i: number): void => {
            const w = (i - (nV - 1) / 2) * 2.15;
            const [vx, vyRaw] = P(-0.7, w, LID_T + hb);
            const vy = vyRaw + (isMoving ? Math.sin(TAU * ((time % 250) / 250) + i * 1.9) * 0.55 : 0);
            let liq = pcbLerpColor(pcbShade(0x4f9e4f, own), 0xc4ffbc, glow);
            if (!isMoving && glow <= 0 && i === glintIdx) liq = pcbShade(liq, 1.45); // idle glint chase
            g.fillStyle(0xd6e8d8, 1);
            g.fillRect(vx - 1.1, vy - 3.6, 2.2, 3.6);
            g.fillStyle(liq, 1);
            g.fillRect(vx - 1.1, vy - 2, 2.2, 2);
            g.fillStyle(0xa87c42, 1);
            g.fillRect(vx - 0.75, vy - 4.6, 1.5, 1.1);
        };
        // Paint far vials first so overlaps stack correctly at steep angles.
        if (sinF >= 0) for (let i = 0; i < nV; i++) drawVial(i);
        else for (let i = nV - 1; i >= 0; i--) drawVial(i);

        // ---- rear shelf: mortar bowl (the wind-up station) ----
        quad([
            P(CH_B - 2.9, -2.6, 10.0 + hb), P(CH_B - 0.1, -2.6, 10.0 + hb),
            P(CH_B - 0.1, 2.6, 10.0 + hb), P(CH_B - 2.9, 2.6, 10.0 + hb)
        ], pcbShade(WOOD, 0.95));
        const bowlCol = troopLevel >= 2 ? 0x9a7c3a : 0x7c7f86;
        g.fillStyle(bowlCol, 1);
        g.fillEllipse(bx, by - 0.7, 5.2, 3);
        g.fillStyle(pcbShade(bowlCol, 0.5), 1);
        g.fillEllipse(bx, by - 1.3, 3.7, 1.7);
        if (stirring) {
            // The brew glows brighter and DOMES up as the stir builds.
            g.fillStyle(pcbLerpColor(0x58b558, 0xc4ffbc, windup), 1);
            g.fillEllipse(bx, by - 1.3, 1.8 + 2 * windup, 0.9 + 1 * windup);
            g.fillEllipse(bx, by - 1.6 - windup * 1.2, 1.2 + 1.4 * windup, 0.8 + 0.8 * windup);
        } else {
            // Pestle resting in the bowl.
            g.lineStyle(1.3, pcbShade(WOOD, 1.15), 1);
            g.lineBetween(bx + 1.4, by - 3.6, bx - 0.5, by - 0.8);
        }
        // Rising motes while the brew builds.
        if (stirring && windup > 0.18) {
            for (let i = 0; i < 4; i++) {
                if (windup < 0.18 + i * 0.21) continue;
                const yr = ((age % 700) / 700 + i / 4) % 1;
                const mx = bx + Math.sin(age / 140 + i * 2.1) * 1.7;
                g.fillStyle(pcbLerpColor(0x7fcf7f, 0xd6ffd0, yr), 1);
                g.fillCircle(mx, by - 2.6 - yr * 7.5, 1.25 * (1 - yr) + 0.4);
            }
        }

        // ---- the great flask, up front in its holder ring ----
        const holdCol = troopLevel >= 3 ? GOLD : (troopLevel >= 2 ? IRON : WOOD_DK);
        g.lineStyle(1, holdCol, 1);
        g.strokeEllipse(fxB, fyB - 1.1, 4.6, 2);
        g.fillStyle(0x6e937b, 1);                    // glass edge (dark, not a halo)
        g.fillCircle(fx, fy, 3.35);
        g.fillStyle(0xd9ecdc, 1);
        g.fillCircle(fx, fy, 2.85);
        g.fillStyle(liquidCol, 1);
        g.fillCircle(fx, fy + 0.5, 2.05 + 0.5 * windup);
        g.fillStyle(0x6e937b, 1);
        g.fillRect(fx - 1.25, fy - 5.8, 2.5, 3.2);
        g.fillStyle(0xd9ecdc, 1);
        g.fillRect(fx - 0.85, fy - 5.7, 1.7, 3);
        g.fillStyle(0xb98d4f, 1);
        g.fillRect(fx - 0.9, fy - 7, 1.8, 1.5);
        g.fillStyle(0xf2fff0, 1);
        g.fillCircle(fx - 1, fy - 1, 0.6);
    };

    const drawStrikeFx = (): void => {
        if (strike <= 0) return;
        // Star pop at the flask cork on the tick itself.
        if (age <= 110) {
            const sp = age / 110;
            g.lineStyle(1.3, 0xeaffdd, 1);
            for (let i = 0; i < 5; i++) {
                const th = i * (TAU / 5) - 0.5;
                const r0 = 1.6 + sp * 2;
                const r1 = r0 + 2.4 + sp * 3.5;
                g.lineBetween(
                    fx + Math.cos(th) * r0, fy - 6 + Math.sin(th) * r0 * 0.8,
                    fx + Math.cos(th) * r1, fy - 6 + Math.sin(th) * r1 * 0.8
                );
            }
            g.fillStyle(0xd8ffd0, 1);
            g.fillCircle(fx, fy - 6, 1.3 + sp * 1);
        }
        // The heal pulse itself: expanding 2:1 ground rings under the cart.
        const [scx2, scy2] = P(D_CART, 0, 0);
        const rr = 8 + (age / STRIKE) * 20;
        g.lineStyle(1.6, 0x8fe88f, 1);
        g.strokeEllipse(scx2, scy2 + 0.2, rr * 2, rr);
        if (age <= 250) {
            const r2 = 5 + (age / 250) * 14;
            g.lineStyle(1.1, 0xc9ffc0, 1);
            g.strokeEllipse(scx2, scy2 + 0.2, r2 * 2, r2);
        }
    };

    // ======================= paint, back to front =========================
    // Ground shadows (soft contact — never a plate).
    const [scx, scy] = P(D_CART, 0, 0);
    g.fillStyle(0x000000, 0.26);
    g.fillEllipse(scx, scy + 0.2, 22 * Math.abs(cosF) + 14, 11 * Math.abs(sinF) + 7);
    g.fillStyle(0x000000, 0.2);
    g.fillEllipse(dxg, dyg + 0.3, 8.5, 3.2);

    if (docFirst) {
        drawDoctorBody();
        drawHandles();
        drawArms();
    }
    drawWheel(-nearSide * WHEEL_W);                  // far wheel
    limb(pcbShade(WOOD_DK, 0.85),                    // axle beam
        P(D_CART, -WHEEL_W, WHEEL_R)[0], P(D_CART, -WHEEL_W, WHEEL_R)[1],
        P(D_CART, WHEEL_W, WHEEL_R)[0], P(D_CART, WHEEL_W, WHEEL_R)[1], 2.1);
    // Far-side herb bundles peek over the lid edge.
    drawHerb(1.2, -nearSide * (CH_W + OVR), 0.9);
    if (troopLevel >= 2) drawHerb(7.4, -nearSide * (CH_W + OVR), 3.7);
    drawChest();
    // Near-side herbs swing in front of the flank cross.
    drawHerb(7.4, nearSide * (CH_W + OVR), 2.3);
    if (troopLevel >= 2) drawHerb(1.2, nearSide * (CH_W + OVR), 5.1);
    drawWheel(nearSide * WHEEL_W);                   // near wheel
    if (!docFirst) {
        drawHandles();
        drawDoctorBody();
        drawArms();
    }
    drawStrikeFx();
}
