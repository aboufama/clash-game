import type Phaser from 'phaser';

/**
 * CANONICAL WINNER — SKELETON C: "The Exhumed".
 *
 * A small, slight, dirt-crusted scrapper fresh out of the ground: grave-soil
 * on the skull and shoulders, a rusted spade-shard for a blade, violet ember
 * eyes, and a soul-flame guttering inside the ribcage.
 *
 * Motion is deterministic: stride 300 ms, windup 260 ms, strike 150 ms, and
 * an exact 2000 ms idle loop. The skeleton aims its arm, blade, skull, and
 * eyes along facingAngle with iso 0.5 y-squash and aim-aware layering.
 */

type G = Phaser.GameObjects.Graphics;
type P = [number, number];

const TAU = Math.PI * 2;

// Shared grave-light palette (matches MainScene.showSummonFlourish hues).
const FLAME_CORE = 0xefe4ff;
const FLAME_MID = 0xb08aff;
const FLAME_OUT = 0x8a63cc;
const GOLD = 0xdaa520;
const GOLD_LT = 0xffd700;
const IRON = 0x6a707a;
const IRON_DK = 0x474c55;
const RUST = 0x8a5a3a;
const DIRT = 0x554634;

const smooth = (t: number): number => t * t * (3 - 2 * t);

/** Multiply a 0xRRGGBB colour toward dark (m<1) or light (m>1). */
function tone(c: number, m: number): number {
    const r = Math.max(0, Math.min(255, Math.round(((c >> 16) & 0xff) * m)));
    const g = Math.max(0, Math.min(255, Math.round(((c >> 8) & 0xff) * m)));
    const b = Math.max(0, Math.min(255, Math.round((c & 0xff) * m)));
    return (r << 16) | (g << 8) | b;
}
const mix = (a: P, b: P, t: number): P => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];

/** Tapered thick segment (limb/shaft/blade) — thickness along the screen normal. */
function strip(g: G, a: P, b: P, w0: number, w1: number, color: number, alpha = 1): void {
    const dx = b[0] - a[0], dy = b[1] - a[1];
    const len = Math.hypot(dx, dy) || 1;
    const nx = -dy / len, ny = dx / len;
    g.fillStyle(color, alpha);
    g.beginPath();
    g.moveTo(a[0] + nx * w0 * 0.5, a[1] + ny * w0 * 0.5);
    g.lineTo(b[0] + nx * w1 * 0.5, b[1] + ny * w1 * 0.5);
    g.lineTo(b[0] - nx * w1 * 0.5, b[1] - ny * w1 * 0.5);
    g.lineTo(a[0] - nx * w0 * 0.5, a[1] - ny * w0 * 0.5);
    g.closePath();
    g.fillPath();
}

/** Attack-cycle state per the TroopRenderer contract: windup ramps 0→1 over
 *  the last windupMs BEFORE the damage tick, strike decays 1→0 over the
 *  first strikeMs after it; stale ages free-run on time so replays live. */
function atkAnim(time: number, attackAge: number, attackDelay: number, windupMs: number, strikeMs: number):
    { windup: number; strike: number; inCombat: boolean } {
    if (attackAge < 0 || attackDelay <= 0) return { windup: 0, strike: 0, inCombat: false };
    let age = attackAge;
    if (age > attackDelay + 600) age = time % attackDelay;
    const remaining = attackDelay - age;
    let windup = 0;
    if (remaining <= 0) windup = 1;
    else if (remaining <= windupMs) windup = 1 - remaining / windupMs;
    const strike = strikeMs > 0 && age <= strikeMs ? 1 - age / strikeMs : 0;
    return { windup, strike, inCombat: true };
}

// ======================== CANONICAL SKELETON C ========================
export function drawSkeletonC(
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
    const bone = tone(0xd6d2bd, isPlayer ? 1 : 0.82);
    const boneDk = tone(bone, 0.72);
    const crack = tone(bone, 0.5);

    const atk = atkAnim(time, attackAge, attackDelay || 900, 260, 150);

    // Aim toolkit (screen-space angle, iso 0.5 y-squash).
    const a = facingAngle || 0;
    const ca = Math.cos(a), sa = Math.sin(a);
    const ax = (d: number): number => ca * d;
    const ay = (d: number): number => sa * 0.5 * d;
    const px = (v: number): number => -sa * v;
    const py = (v: number): number => ca * 0.5 * v;

    // Gait (exact 300 ms loop) / idle (exact 2000 ms loop).
    let hop = 0, swing = 0, rattle = 0;
    let sway = 0, flick = 0, jaw = 0;
    if (isMoving) {
        const ph = (time % 300) / 300;
        const s = Math.sin(ph * TAU);
        swing = s * 2.3;
        hop = Math.abs(s) * 1.5;
        rattle = Math.sin(ph * TAU * 2 + 0.9) * 0.5;
    } else {
        const t2 = (time % 2000) / 2000;
        sway = Math.sin(t2 * TAU) * 0.8;
        flick = (Math.sin(t2 * TAU * 2 + 0.6) + 1) * 0.5;
        jaw = Math.max(0, Math.sin(t2 * TAU * 2)) * 1.1;
    }

    // Whole-body lunge: coil back through the windup, spring along the aim on the tick.
    const lungeD = atk.strike > 0 ? 2.3 * atk.strike : -1.3 * smooth(atk.windup);
    const bx = ax(lungeD) + sway + rattle;
    const by = ay(lungeD) - hop;

    // contact shadow (vector nicety)
    g.fillStyle(0x000000, 0.2);
    g.fillEllipse(0, 9.6, 7.5, 2.9);
    // grave-soil specks at its feet — it just climbed out
    g.fillStyle(DIRT, 1);
    g.fillCircle(-2.7, 9.4, 0.6);
    g.fillCircle(3.0, 9.7, 0.5);

    const C: P = [bx, -0.6 + by]; // ribcage center
    const S_w: P = [C[0] + px(2.2), C[1] + py(2.2) - 1.2]; // weapon shoulder
    const S_o: P = [C[0] - px(2.2), C[1] - py(2.2) - 1.2]; // off shoulder
    const armBehind = sa < -0.15; // aiming up-screen → weapon behind the body

    // ---- weapon arm + spade-shard blade (closure so layering can flip) ----
    const drawWeaponArm = (): void => {
        const rest: P = [S_w[0] + ax(2.1) + px(0.7), S_w[1] + ay(2.1) + py(0.7) + 1.0];
        const back: P = [S_w[0] + ax(-1.7) + px(1.7), S_w[1] + ay(-1.7) + py(1.7) - 1.9];
        const swept: P = [S_w[0] + ax(3.7) - px(0.5), S_w[1] + ay(3.7) - py(0.5) + 0.3];
        let hand: P;
        if (atk.strike > 0) hand = mix(rest, swept, atk.strike * atk.strike * (3 - 2 * atk.strike) * 0.9 + 0.1);
        else if (atk.windup > 0) hand = mix(rest, back, smooth(atk.windup));
        else {
            hand = rest;
            if (isMoving) { hand = [rest[0] + ax(-swing * 0.5), rest[1] + ay(-swing * 0.5)]; }
        }
        strip(g, S_w, hand, 1.45, 1.2, bone);
        g.fillStyle(boneDk, 1);
        g.fillCircle(hand[0], hand[1], 0.7);
        if (lvl >= 2) { g.fillStyle(IRON, 1); g.fillRect(mix(S_w, hand, 0.5)[0] - 0.9, mix(S_w, hand, 0.5)[1] - 0.8, 1.8, 1.6); }
        // rusted spade-shard: tip raised through the windup, driven flat on the strike
        const tipLift = atk.strike > 0 ? -0.8 * atk.strike : 2.4 * smooth(atk.windup);
        const tip: P = [hand[0] + ax(3.1), hand[1] + ay(3.1) - tipLift];
        strip(g, hand, tip, 2.3, 0.7, RUST);
        strip(g, mix(hand, tip, 0.2), tip, 1.0, 0.35, IRON_DK);
        if (lvl >= 3) strip(g, mix(hand, tip, 0.15), tip, 0.45, 0.25, GOLD_LT, 0.9);
        // slash arc on the tick
        if (atk.strike > 0.4) {
            g.fillStyle(FLAME_MID, 0.85);
            for (let k = -1; k <= 1; k++) {
                const oa = a + k * 0.45;
                g.fillRect(C[0] + Math.cos(oa) * 4.6 - 0.5, C[1] + Math.sin(oa) * 2.3 + 0.4 - 0.45, 1.0, 0.9);
            }
        }
    };

    if (armBehind) drawWeaponArm();

    // ---- legs (thin bone, feet swing along the aim when scuttling) ----
    const liftA = isMoving ? Math.max(0, Math.sin((time % 300) / 300 * TAU)) * 1.3 : 0;
    const liftB = isMoving ? Math.max(0, -Math.sin((time % 300) / 300 * TAU)) * 1.3 : 0;
    const footA: P = [-1.7 + ax(swing * 0.8), 9.2 - liftA];
    const footB: P = [1.7 - ax(swing * 0.8), 9.2 - liftB];
    strip(g, [bx * 0.5 - 1.3, 3.9 + by * 0.5], footA, 1.45, 1.15, bone);
    strip(g, [bx * 0.5 + 1.3, 3.9 + by * 0.5], footB, 1.45, 1.15, boneDk);
    g.fillStyle(boneDk, 1);
    g.fillEllipse(footA[0] + 0.4, footA[1] + 0.2, 2.3, 1.4);
    g.fillEllipse(footB[0] + 0.4, footB[1] + 0.2, 2.3, 1.4);

    // ---- pelvis + spine ----
    g.fillStyle(bone, 1);
    g.fillEllipse(bx * 0.6, 3.6 + by * 0.6, 3.7, 2.3);
    g.fillStyle(boneDk, 1);
    g.fillRect(bx * 0.6 - 0.45, 2.9 + by * 0.6, 0.9, 1.2);
    strip(g, [bx * 0.75, 2.6 + by * 0.75], [C[0], C[1] + 1.6], 1.35, 1.2, boneDk);

    // ---- off arm (counter-swing) ----
    const offHand: P = [
        S_o[0] + ax(1.1 + (isMoving ? swing * 0.5 : 0)) - px(1.0),
        S_o[1] + ay(1.1 + (isMoving ? swing * 0.5 : 0)) - py(1.0) + 1.3 - smooth(atk.windup) * 0.8
    ];
    strip(g, S_o, offHand, 1.35, 1.1, boneDk);
    g.fillStyle(boneDk, 1);
    g.fillCircle(offHand[0], offHand[1], 0.6);

    // ---- ribcage with the soul-flame guttering inside ----
    g.fillStyle(bone, 1);
    g.fillEllipse(C[0], C[1], 4.8, 5.3);
    g.fillStyle(0x241c30, 1);
    g.fillEllipse(C[0] + 0.2, C[1] + 0.1, 2.6, 3.2);
    // the summoner's grave-light, alive in its chest
    const fl = atk.inCombat ? 0.55 + 0.45 * Math.max(atk.windup, atk.strike) : 0.35 + 0.65 * flick;
    g.fillStyle(FLAME_OUT, 0.62);
    g.fillCircle(C[0] + 0.2, C[1] + 0.1, 1.05 + fl * 0.45);
    g.fillStyle(FLAME_CORE, 1);
    g.fillCircle(C[0] + 0.2, C[1] - 0.1 - fl * 0.25, 0.55 + fl * 0.18);
    // rib bars across the hollow
    g.fillStyle(bone, 1);
    g.fillRect(C[0] - 1.6, C[1] - 1.1, 3.4, 0.62);
    g.fillRect(C[0] - 1.6, C[1] + 0.3, 3.4, 0.62);
    // shoulder knobs + grave dirt on one shoulder
    g.fillStyle(bone, 1);
    g.fillCircle(S_w[0], S_w[1], 0.85);
    g.fillCircle(S_o[0], S_o[1], 0.85);
    g.fillStyle(DIRT, 1);
    g.fillCircle(S_o[0] - 0.3, S_o[1] - 0.6, 0.72);

    // ---- skull: turned along the aim, ember eyes, chattering jaw ----
    const H: P = [C[0] + ax(0.9), C[1] - 3.7 + ay(0.9) - (isMoving ? Math.sin((time % 300) / 300 * TAU * 2) * 0.4 : 0)];
    g.fillStyle(bone, 1);
    g.fillCircle(H[0], H[1], 2.15);
    strip(g, [H[0] - 0.9, H[1] - 0.7], [H[0] + 0.2, H[1] + 0.3], 0.35, 0.35, crack); // hairline crack
    // jaw
    g.fillStyle(boneDk, 1);
    g.fillRect(H[0] + ax(0.7) - 0.95, H[1] + 1.5 + jaw * 0.55, 1.9, 0.9);
    // grave dirt cap smudge / L2 iron cap / L3 gold circlet
    if (lvl >= 2) {
        g.fillStyle(lvl >= 3 ? IRON : tone(IRON, 0.85), 1);
        g.fillEllipse(H[0], H[1] - 1.25, 4.1, 2.0);
        if (lvl >= 3) { g.fillStyle(GOLD, 1); g.fillRect(H[0] - 1.9, H[1] - 1.05, 3.8, 0.62); }
    } else {
        g.fillStyle(DIRT, 1);
        g.fillEllipse(H[0] - 0.5, H[1] - 1.6, 1.9, 1.0);
    }
    // ember eyes track the aim (brighten with the flame) — kept small and
    // separated so they don't merge into one violet blob on the tiny skull
    const eb = 0.42 + fl * 0.16;
    g.fillStyle(FLAME_MID, 1);
    g.fillCircle(H[0] + ax(1.0) + px(0.95), H[1] + ay(1.0) + py(0.95) - 0.25, eb);
    g.fillCircle(H[0] + ax(1.0) - px(0.95), H[1] + ay(1.0) - py(0.95) - 0.25, eb);

    if (!armBehind) drawWeaponArm();
}
