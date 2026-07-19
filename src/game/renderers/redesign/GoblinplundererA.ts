import type Phaser from 'phaser';

type G = Phaser.GameObjects.Graphics;

/**
 * GOBLIN PLUNDERER — design A: "the pack-rat sprinter".
 *
 * A scrawny, hunched goblin (skin 0x7ec850) whose silhouette is dominated by
 * one OVERSIZED brown loot sack slung over a shoulder — a lumpy carried bag
 * hanging down his back from a fist clenched at the shoulder. All sack, no
 * muscle: bare ribby torso, rope strap, ragged shorts. Manic, greedy, fast,
 * and a terrible fighter:
 *
 *  - WALK  = manic sprint on ONE exact 240 ms stride: big leg scissor, deep
 *    forward hunch, the bag bouncing on a lagged stride harmonic, and loose
 *    coins spraying from the bag mouth (each coin completes its fall in
 *    exactly one stride so the 6-frame bake sheet loops seamlessly).
 *  - ATTACK (delay 700) = a frantic one-hand sack-swat: coil the bag back
 *    through a 260 ms windup, hurl the whole thing over the shoulder and
 *    through the target on the damage tick (140 ms strike, coins bursting
 *    out), then teeter off-balance through the recovery. Weak + comic.
 *  - IDLE  = shifty look-around + sack hitch on ONE declared 2000 ms period
 *    (all idle terms are exact harmonics / exact-period pulses of it): eyes
 *    + head dart left then right, and once per period he shrugs the bag
 *    back up his shoulder (~2.2 px displacement on the biggest shape — well
 *    over the 1.5 world-px bake-probe floor). Greedy finger-drumming rides
 *    harmonic 8 (250 ms) and coin glints are exact-period pulses.
 *
 * Levels are MATERIAL progression: L1 ragged hood + patched sack, L2 leather
 * cap + rope-lashed sack with an iron buckle, L3 refined dark-leather hood
 * with a gold clasp, gold earring and a gold-corded sack — accents only.
 *
 * Direction-aware: the bag rides his BACK, so it draws in front of the body
 * when he heads up-screen (sin < 0) and behind it when he faces the camera;
 * the face (eyes/nose/grin) hides entirely when he runs away up-screen and
 * the ears sweep away from the heading. All motion is a deterministic
 * f(time) — bake-safe (iron rule 3).
 */

// ---- the three clocks (the bake's TROOP_PARAMS must mirror these) --------
const STRIDE_MS = 240;   // exact sprint gait period
const IDLE_P_MS = 2000;  // declared idle period (250 ms multiple)
const WINDUP_MS = 260;   // attack anticipation before the damage tick
const STRIKE_MS = 140;   // sack-swat follow-through after the tick

export function drawGoblinplundererA(
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
    const ax = Math.cos(fa);
    const ay = Math.sin(fa);
    const ss = ax >= 0 ? 1 : -1;   // screen-x travel sign
    const faceAway = ay < -0.35;   // heading mostly up-screen: back of head shows
    const sackInFront = ay < 0;    // bag rides the back -> viewer side up-screen

    // ---- palettes (enemy = darker skin, maroon rags; sack stays burlap) ---
    const skin = isPlayer ? 0x7ec850 : shade(0x7ec850, 0.82);
    const skinDark = shade(skin, 0.68);
    const cloth = isPlayer ? 0x8a6134 : 0x7a3128;
    const clothDark = shade(cloth, 0.64);
    const sackC = isPlayer ? 0xa3814e : 0x93744a;
    const sackDark = shade(sackC, 0.56);
    const sackLight = shade(sackC, 1.16);
    const rope = 0x5a4526;
    const gold = 0xdaa520;
    const goldHi = 0xffd700;

    // ---- rig: ONE stride clock, ONE idle clock ----------------------------
    let swing = 0, hop = 0, ph = 0;
    if (isMoving) {
        ph = (time % STRIDE_MS) / STRIDE_MS;
        const s = Math.sin(ph * Math.PI * 2);
        swing = s * 3.0;
        hop = Math.abs(s) * 1.5;
    }
    const u = (time % IDLE_P_MS) / IDLE_P_MS; // idle phase 0..1
    // Idle terms — exact harmonics / exact-period pulses of IDLE_P_MS only.
    const breath = Math.sin(u * Math.PI * 2);                    // k = 1
    const hitch = pulse(u, 0.52, 0.10);                          // sack shrug
    const look = pulse(u, 0.16, 0.12) - pulse(u, 0.72, 0.12);    // shifty eyes
    const drum = Math.sin(u * Math.PI * 2 * 8);                  // k = 8 (250 ms)
    const glint = Math.max(pulse(u, 0.35, 0.045), pulse(u, 0.88, 0.045));

    const lift = isMoving ? hop : Math.max(0, breath) * 0.55 + hitch * 0.9;

    // ---- attack state (frantic swat keyed to the damage tick) -------------
    const atk = atkState(time, attackAge, attackDelay || 700, WINDUP_MS, STRIKE_MS);
    const inAtk = !isMoving && atk.inCombat;
    const wu = inAtk ? atk.windup : 0;
    let sweep = 0;       // 0..1 swat travel (saturates 70 ms after the tick)
    let arcAlpha = 0;    // comic swoosh
    let settle = 0;      // recovery wobble
    if (inAtk && atk.age <= STRIKE_MS + 380) {
        if (atk.age <= STRIKE_MS) {
            sweep = clamp01(atk.age / 70);
            arcAlpha = sweep < 1 ? 0.7 : 0.7 * clamp01(1 - (atk.age - 70) / 90);
            settle = 1;
        } else if (wu === 0) {
            const t = clamp01((atk.age - STRIKE_MS) / 380);
            sweep = 1 - easeOut(t);
            settle = (1 - t) * Math.sin(atk.age / 42); // overbalanced teeter
        }
    }
    const swx = easeOut(sweep); // eased swat travel

    // ---- skeleton anchors --------------------------------------------------
    const lean = ss * ((isMoving ? 2.3 : 0.7) - 1.5 * wu + 2.4 * swx);
    const headBob = isMoving ? Math.abs(Math.sin(ph * Math.PI * 2 + 0.5)) * 0.5 : 0;
    const lookX = isMoving || inAtk ? 0 : look * 1.35;
    const tx = lean * 0.5;                      // torso center x
    const ty = -1.9 - lift;                     // torso center y
    const hx = lean * 0.7 + ss * 1.2 + ax * 0.5 + lookX + settle * 0.5;  // head juts forward
    const hy = -6.0 - lift - headBob + wu * 0.7;                         // cowers on windup

    // The bag: hangs down the back from a fist at the shoulder. Bounce lags
    // the stride by ~0.7 rad; windup coils it back, the strike hurls it in
    // an over-the-shoulder arc through the front.
    const sackBob = isMoving ? Math.abs(Math.sin(ph * Math.PI * 2 - 0.7)) * 1.7 : hitch * 2.2;
    const sackAtkX = ss * (-2.6 * wu + 9.5 * swx);
    const sackAtkY = -1.6 * wu - 4.4 * Math.sin(swx * Math.PI) + 3.4 * swx;
    const bagX = tx - ss * 4.0 + sackAtkX;
    const bagY = -3.2 - lift - sackBob + sackAtkY;
    const gx = tx - ss * 1.0 + sackAtkX * 0.45;   // fist on the bag neck
    const gy = -4.6 - lift - sackBob * 0.4 + sackAtkY * 0.35;

    // ======================= 1. contact shadow ============================
    g.fillStyle(0x000000, 0.22);
    g.fillEllipse(0, 9.6, 9.5, 3.6);

    // ======================= 2. bag behind the body =======================
    if (!sackInFront) drawSack();

    // ======================= 3. the scrawny body ==========================
    // Legs — bare, skinny, manic scissor (foreshortened toward up/down runs).
    const sswing = swing * (0.35 + 0.65 * Math.abs(ax)) * ss;
    const dsw = swing * ay * 0.4; // depth scissor
    const hipY = 3.3 - lift;
    const f1x = tx - 1.3 + sswing, f1y = 9.2 + dsw - Math.max(0, Math.sin(ph * Math.PI * 2)) * 1.4 * (isMoving ? 1 : 0);
    const f2x = tx + 1.3 - sswing, f2y = 9.2 - dsw - Math.max(0, -Math.sin(ph * Math.PI * 2)) * 1.4 * (isMoving ? 1 : 0);
    limb(g, skinDark, tx - 0.9, hipY, f1x, f1y - 0.6, 1.4);
    limb(g, skin, tx + 0.9, hipY, f2x, f2y - 0.6, 1.4);
    g.fillStyle(skinDark, 1);
    g.fillEllipse(f1x + ss * 0.5, f1y, 2.6, 1.3);
    g.fillStyle(skin, 1);
    g.fillEllipse(f2x + ss * 0.5, f2y, 2.6, 1.3);

    // Ragged shorts (level cloth) with a torn hem.
    g.fillStyle(clothDark, 1);
    g.fillRect(tx - 2.2, 1.6 - lift, 4.4, 2.2);
    g.fillTriangle(tx - 1.6, 3.8 - lift, tx - 0.4, 3.8 - lift, tx - 1.0, 4.9 - lift);
    g.fillTriangle(tx + 0.5, 3.8 - lift, tx + 1.7, 3.8 - lift, tx + 1.1, 4.7 - lift);

    // Bare hunched torso: bean chest + the hunch hump the bag rests on.
    g.fillStyle(skin, 1);
    g.fillCircle(tx - ss * 1.3, ty - 1.6, 2.2);   // hump
    g.fillCircle(tx, ty, 2.8);                    // chest
    // Ribby shading on the front — scrawny, not muscled.
    g.lineStyle(0.6, skinDark, 1);
    g.lineBetween(tx + ss * 0.6, ty + 0.1, tx + ss * 2.1, ty + 0.5);
    g.lineBetween(tx + ss * 0.5, ty + 1.1, tx + ss * 1.9, ty + 1.4);
    // Rope strap: shoulder (bag side) across the chest to the far hip.
    g.lineStyle(1.1, rope, 1);
    g.lineBetween(tx - ss * 1.8, ty - 2.4, tx + ss * 1.9, 1.4 - lift);

    // ======================= 4. head ======================================
    const twitch = hitch * 1.2;
    // Blade ears swept UP-BACK, away from the heading (bases hide under the
    // skull + cap). Far ear first, darker.
    const tipY = hy - 4.3 - twitch;
    g.fillStyle(skinDark, 1);
    g.fillTriangle(hx + 0.4, hy - 1.9, hx + 1.6, hy - 0.4, hx + (3.6 - ax * 1.7), tipY + 0.5);
    g.fillStyle(skin, 1);
    g.fillTriangle(hx - 0.4, hy - 1.7, hx - 1.7, hy - 0.2, hx - (3.6 + ax * 1.7), tipY);
    // Skull.
    g.fillStyle(skin, 1);
    g.fillCircle(hx, hy, 2.7);
    if (!faceAway) {
        // Long droopy nose, manic yellow eyes, snaggle-tooth grin. The base
        // keeps width at every heading (a zero-width base collapses the
        // wedge on front/back views).
        const noseL = 1.8 + Math.abs(ax) * 2.0;
        g.fillStyle(skin, 1);
        g.fillTriangle(
            hx + ax * 1.5 - 0.6, hy + 0.1,
            hx + ax * 1.5 + 0.6, hy + 0.3,
            hx + ax * (1.5 + noseL), hy + 0.9 + ay * 1.1 + (1 - Math.abs(ax)) * 0.9
        );
        const eyeR = wu > 0 ? 0.95 : 0.8;
        const eyY = hy - 0.8;
        const eSpread = 1.1 * (1 - Math.abs(ax) * 0.35);
        g.fillStyle(0xf3e27a, 1);
        g.fillCircle(hx + ax * 1.0 - eSpread, eyY, eyeR);
        g.fillCircle(hx + ax * 1.0 + eSpread, eyY, eyeR);
        g.fillStyle(0x1c1408, 1);
        const pupX = ax * 0.4 + lookX * 0.35;
        g.fillCircle(hx + ax * 1.0 - eSpread + pupX, eyY, wu > 0 ? 0.34 : 0.44);
        g.fillCircle(hx + ax * 1.0 + eSpread + pupX, eyY, wu > 0 ? 0.34 : 0.44);
        // Grin + one crooked tooth.
        g.fillStyle(0x2a3510, 1);
        g.fillRect(hx + ax * 1.1 - 0.9, hy + 1.6, 1.9, 0.5);
        g.fillStyle(0xf5f0e0, 1);
        g.fillRect(hx + ax * 1.1 + 0.3, hy + 1.6, 0.55, 0.85);
    }

    // ======================= 5. headgear by level =========================
    // All headgear sits HIGH on the dome — the eye line stays clear.
    if (troopLevel >= 3) {
        // Refined dark-leather hood, cream-trimmed, gold clasp + earring.
        g.fillStyle(0x53381e, 1);
        g.beginPath();
        g.arc(hx, hy - 1.2, 2.75, Math.PI, 0, false);
        g.closePath();
        g.fillPath();
        g.fillTriangle(hx - ss * 1.0, hy - 3.2, hx - ss * 2.7, hy - 1.6, hx - ss * 5.0, hy - 0.4);
        g.lineStyle(0.7, 0xc9c2ae, 1);
        g.lineBetween(hx - 2.6, hy - 1.2, hx + 2.6, hy - 1.2);
        g.fillStyle(gold, 1);
        g.fillCircle(hx + ax * 0.9, hy - 2.4, 0.7);
        // Earring seated 70% up the near ear (at the tip it floats).
        g.fillCircle(hx - 0.4 - (3.2 + ax * 1.7) * 0.7, hy - 1.7 + (tipY - hy + 1.7) * 0.7, 0.5);
    } else if (troopLevel === 2) {
        // Fitted leather cap with a stitched band and a floppy point.
        g.fillStyle(0x6e4a26, 1);
        g.beginPath();
        g.arc(hx, hy - 1.1, 2.8, Math.PI, 0, false);
        g.closePath();
        g.fillPath();
        g.fillStyle(0x4f351b, 1);
        g.fillRect(hx - 2.7, hy - 2.1, 5.4, 0.85);
        g.fillStyle(0x6e4a26, 1);
        g.fillTriangle(hx - 1.0, hy - 3.6, hx + 1.2, hy - 3.4, hx - ss * 2.7, hy - 5.1);
        g.fillStyle(0x8a6134, 1);
        g.fillRect(hx - 1.3, hy - 1.85, 0.55, 0.55);
        g.fillRect(hx + 0.85, hy - 1.85, 0.55, 0.55);
    } else {
        // Ragged sackcloth hood with a torn drooping tail.
        g.fillStyle(cloth, 1);
        g.beginPath();
        g.arc(hx, hy - 1.0, 2.9, Math.PI, 0, false);
        g.closePath();
        g.fillPath();
        g.fillTriangle(hx - ss * 0.7, hy - 3.4, hx - ss * 2.5, hy - 2.2, hx - ss * 4.7, hy + 0.4);
        g.fillStyle(clothDark, 1);
        g.fillTriangle(hx - ss * 3.3, hy - 1.2, hx - ss * 4.7, hy + 0.4, hx - ss * 2.9, hy - 0.2);
        // Torn notch in the hood edge.
        g.fillStyle(skin, 1);
        g.fillTriangle(hx + ss * 1.5, hy - 3.0, hx + ss * 2.3, hy - 2.3, hx + ss * 2.4, hy - 3.2);
    }

    // ======================= 6. bag toward the viewer =====================
    if (sackInFront) drawSack();

    // ======================= 7. arms ======================================
    // Bag arm: short forearm from the shoulder to the fist on the bag neck.
    limb(g, skin, tx - ss * 0.4, ty - 1.7, gx, gy, 1.5);
    g.fillStyle(skin, 1);
    g.fillCircle(gx, gy, 1.15);
    g.fillStyle(skinDark, 1);
    g.fillCircle(gx + ss * 0.35, gy + 0.3, 0.45); // knuckle shading
    // Free arm: pumps while sprinting, drums greedy fingers at idle, flails
    // overhead through the swat.
    let fhX: number, fhY: number;
    if (isMoving) {
        fhX = tx + ss * 1.2 - sswing * 0.9;
        fhY = -0.4 - lift - Math.abs(swing) * 0.12;
    } else if (inAtk && sweep > 0) {
        fhX = tx - ss * (1.6 + 2.4 * swx);
        fhY = -6.2 - lift - 2.4 * swx;
    } else if (inAtk && wu > 0) {
        fhX = tx + ss * (2.6 + 0.8 * wu);
        fhY = -0.8 - lift + 1.4 * wu;
    } else {
        fhX = tx + ss * 2.3;
        fhY = 0.2 - lift + drum * 0.4;
    }
    limb(g, skin, tx + ss * 1.4, ty - 1.0, fhX, fhY, 1.4);
    g.fillStyle(skin, 1);
    g.fillCircle(fhX, fhY, 1.05);

    // ======================= 8. swat FX ====================================
    if (arcAlpha > 0) {
        const a0 = ss > 0 ? Math.PI * 1.25 : Math.PI * 1.75;
        const a1 = a0 + ss * Math.PI * 0.75 * swx;
        g.lineStyle(1.8, 0xf5edd8, Math.max(0.6, arcAlpha));
        g.beginPath();
        g.arc(tx, -2.5 - lift, 8.8, a0, a1, ss < 0);
        g.strokePath();
    }
    if (inAtk && atk.strike > 0) {
        // Coins knocked loose by the impact.
        const rr = 2.5 + 7 * clamp01(atk.age / STRIKE_MS);
        for (let j = 0; j < 3; j++) {
            const ca = fa + (j - 1) * 0.65;
            const cx = bagX + ss * 3 + Math.cos(ca) * rr;
            const cy = bagY - 1 + Math.sin(ca) * rr * 0.5 + clamp01(atk.age / STRIKE_MS) * 3;
            coin(g, cx, cy, 0.95, gold, goldHi);
        }
    }

    // ======================================================================
    // The loot bag: a lumpy burlap teardrop hanging from the fist at the
    // shoulder down across his back. Drawn behind or in front of the body
    // depending on heading. All opaque.
    function drawSack(): void {
        // Dark under-rim of the whole bag union first, then the body.
        g.fillStyle(sackDark, 1);
        g.fillEllipse(bagX, bagY, 10.4, 8.8);
        g.fillEllipse(bagX - ss * 0.8, bagY + 2.6, 8.2, 6.2);
        // Cinched neck reaching up to the fist.
        limb(g, sackDark, bagX + ss * 1.6, bagY - 2.8, gx, gy + 0.2, 3.0);
        limb(g, sackC, bagX + ss * 1.4, bagY - 2.6, gx, gy + 0.4, 2.0);
        g.fillStyle(sackC, 1);
        g.fillEllipse(bagX, bagY + 0.1, 9.2, 7.6);
        g.fillEllipse(bagX - ss * 0.8, bagY + 2.6, 7.0, 5.0);
        // NW top light + crease fold.
        g.fillStyle(sackLight, 1);
        g.fillEllipse(bagX - 1.6, bagY - 1.9, 4.6, 2.9);
        g.lineStyle(0.8, sackDark, 1);
        g.beginPath();
        g.arc(bagX - ss * 0.4, bagY + 1.1, 3.4, Math.PI * 0.15, Math.PI * 0.7, false);
        g.strokePath();
        // Lumpy loot pressing through the cloth.
        g.fillStyle(sackDark, 1);
        g.fillCircle(bagX + ss * 2.0, bagY + 1.8, 1.0);
        g.fillCircle(bagX - ss * 1.4, bagY + 3.6, 0.8);
        // Rope tie under the fist + coins peeking from the mouth.
        g.lineStyle(1.0, rope, 1);
        g.lineBetween(gx - ss * 1.4, gy + 1.4, gx + ss * 1.0, gy + 0.8);
        coin(g, gx - ss * 0.3, gy - 1.25, 0.75, gold, goldHi);
        coin(g, gx + ss * 0.95, gy - 0.8, 0.62, gold, goldHi);

        // Level dressing on the bag itself.
        if (troopLevel === 1) {
            // Crude patch + stitches.
            g.fillStyle(shade(sackC, 0.78), 1);
            g.fillRect(bagX + 0.4, bagY + 1.2, 2.6, 2.2);
            g.lineStyle(0.6, sackDark, 1);
            g.lineBetween(bagX + 0.4, bagY + 1.8, bagX + 3.0, bagY + 1.8);
            g.lineBetween(bagX + 1.7, bagY + 1.2, bagX + 1.7, bagY + 3.4);
        } else if (troopLevel === 2) {
            // One rope lashing girdling the bag + an iron buckle (off-center
            // so it reads as strapping, not a shield boss).
            g.lineStyle(0.9, rope, 1);
            g.beginPath();
            g.arc(bagX, bagY + 0.4, 4.3, Math.PI * 0.55, Math.PI * 1.5, false);
            g.strokePath();
            g.fillStyle(0x8a8f99, 1);
            g.fillRect(bagX - ss * 3.4, bagY + 1.6, 1.3, 1.3);
        } else {
            // Gold cord along the lower seam + a stamped coin roundel.
            g.lineStyle(0.9, gold, 1);
            g.beginPath();
            g.arc(bagX - ss * 0.4, bagY + 1.4, 4.2, Math.PI * 0.2, Math.PI * 0.8, false);
            g.strokePath();
            coin(g, bagX + ss * 1.2, bagY + 0.4, 1.1, gold, goldHi);
        }
        // Deterministic jingle sparkle: 2 glints per stride on the run, and
        // two exact-period glint pulses at idle. Opaque light shapes.
        const gs = isMoving ? Math.max(0, Math.sin(ph * Math.PI * 4)) : glint;
        if (gs > 0.55) {
            const sgx = bagX + (isMoving ? (ph < 0.5 ? -1.8 : 2.2) : -1.4);
            const sgy = bagY - (isMoving ? 2.0 : 2.4);
            g.fillStyle(0xfff6d8, 1);
            g.fillTriangle(sgx - 1.2, sgy, sgx + 1.2, sgy, sgx, sgy - 0.5);
            g.fillTriangle(sgx - 1.2, sgy, sgx + 1.2, sgy, sgx, sgy + 0.5);
            g.fillRect(sgx - 0.3, sgy - 1.3, 0.6, 2.6);
        }
        // Coins jingling loose while he sprints — drawn OVER the bag so they
        // read bouncing off it before dropping behind his heels. Each coin's
        // arc completes in EXACTLY one stride (240 ms) so the baked walk
        // sheet loops seamlessly.
        if (isMoving) {
            for (let j = 0; j < 3; j++) {
                const cph = (ph + j / 3) % 1;
                const back = 1.6 + cph * 8.6;
                const bx = gx - ax * back - ss * 0.6;
                const by = gy - 1.2 - ay * 0.5 * back - 3.0 * cph + 13.5 * cph * cph;
                if (by < 8.8) coin(g, bx, by, 0.85, gold, goldHi);
            }
        }
    }
}

// ---------------------------- module helpers -------------------------------

function clamp01(v: number): number {
    return v < 0 ? 0 : v > 1 ? 1 : v;
}

function easeOut(t: number): number {
    return 1 - (1 - t) * (1 - t);
}

/** Multiply a 0xRRGGBB colour toward dark (m<1) or light (m>1). */
function shade(c: number, m: number): number {
    const r = Math.max(0, Math.min(255, Math.round(((c >> 16) & 0xff) * m)));
    const gg = Math.max(0, Math.min(255, Math.round(((c >> 8) & 0xff) * m)));
    const b = Math.max(0, Math.min(255, Math.round((c & 0xff) * m)));
    return (r << 16) | (gg << 8) | b;
}

/** Smooth exact-period bump: 1 at phase c, 0 outside |u-c| > w. */
function pulse(u: number, c: number, w: number): number {
    const d = Math.abs(u - c);
    if (d > w) return 0;
    const t = 1 - (d / w) * (d / w);
    return t * t;
}

/** One limb segment drawn as a thick quad from (x0,y0) to (x1,y1). */
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

/** A little gold coin: dark rim, gold face, bright lip. Fully opaque. */
function coin(g: G, x: number, y: number, r: number, body: number, hi: number): void {
    g.fillStyle(0x8a6d1c, 1);
    g.fillCircle(x, y, r);
    g.fillStyle(body, 1);
    g.fillCircle(x, y, r * 0.78);
    g.fillStyle(hi, 1);
    g.fillCircle(x - r * 0.25, y - r * 0.28, r * 0.34);
}

/** Attack-cycle state locked to the damage tick (the TroopRenderer contract). */
function atkState(time: number, attackAge: number, attackDelay: number, windupMs: number, strikeMs: number): { windup: number; strike: number; age: number; inCombat: boolean } {
    if (attackAge < 0 || attackDelay <= 0) return { windup: 0, strike: 0, age: Infinity, inCombat: false };
    let age = attackAge;
    if (age > attackDelay + 600) {
        // Stale tick (replay playback): free-run the cycle off the clock.
        age = time % attackDelay;
    }
    const remaining = attackDelay - age;
    let windup = 0;
    if (remaining <= 0) windup = 1;
    else if (remaining <= windupMs) windup = 1 - remaining / windupMs;
    const strike = strikeMs > 0 && age <= strikeMs ? 1 - age / strikeMs : 0;
    return { windup, strike, age, inCombat: true };
}
