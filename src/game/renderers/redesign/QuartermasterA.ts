import type Phaser from 'phaser';

type G = Phaser.GameObjects.Graphics;

/**
 * QUARTERMASTER — design A: "The Regiment's Heart".
 *
 * A barrel-chested grand drum-major, front-on (symmetric unit, 1 baked
 * direction). Crimson greatcoat, tall crimson shako, walrus mustache; two
 * gold cross-belts (0xd4a017) meet in a brass ring at the sternum, and the
 * big rope-tensioned war drum hangs from it at the belly. Two drumsticks
 * beat the drumhead TOP — every hit flashes the whole skin bright and jolts
 * the drum — while a short banner pole over his right shoulder flies a gold
 * swallowtail pennant.
 *
 * MOTION CONTRACT (iron rule 3 — every term is a deterministic f(time)):
 *  - IDLE (the hero: the army's heartbeat), declared period = 2000 ms
 *    (250 ms multiple). 4 beats per period: LEFT stick strikes at 0/1000 ms,
 *    RIGHT at 500/1500 ms (each stick = exact 1000 ms harmonic, right side
 *    offset 500 ms and slightly softer — the drum-major accent). Skin flash
 *    + hoop glint + drum jolt decay over ~130 ms after each hit (500 ms
 *    envelope = 4th harmonic). Chest breath and the pennant's full wave
 *    cycle run at the 2000 ms FUNDAMENTAL, so the probe autocorrelation
 *    locks the loop to exactly 2000 ms. Stick tips travel ~8 px and the
 *    flash swings the whole drumhead's RGB — far past the ≥1.5 px /
 *    ≥16/255-over-1%-of-texels quantization thresholds.
 *  - WALK, one exact stride period = 450 ms (full two-footfall march
 *    cycle). High-knee march in place, drum bouncing on the harness, one
 *    stick strike per footfall (left at phase 0, right at 0.5), pennant
 *    waves once per stride. Every walking term is f(time mod 450) so the
 *    6-frame bake loop closes seamlessly.
 *  - NO attack (damage 0): attackAge/attackDelay/driver are ignored.
 *  - facingAngle: a subtle trigonometric march lean (cos component) while
 *    moving — the front-on design reads at every heading.
 *
 * LEVELS (material progression, gold/white as subtle accents only):
 *  L1 humble  — waxed-wood drum shell, dark rope tension, wooden knobs,
 *               leather shako band, plain triangular pennant.
 *  L2 fielded — crimson-painted shell, brass hoops/buckles/badge, brass
 *               stick knobs, swallowtail pennant.
 *  L3 refined — warm sandstone shell with GOLD hoops and cream cords, gold
 *               roundel on the skin, gold-knobbed sticks with a white
 *               glint, gold shako band + small cream plume, gilded hem.
 *
 * NO body translucency: all body paint is alpha 1 (the beat "glow" is an
 * opaque inner-light skin recolor); only the standard contact shadow uses
 * the shared troop shadow alpha.
 */

const PI2 = Math.PI * 2;
/** Declared idle loop period (ms) — every idle term is an exact harmonic. */
const IDLE_PERIOD = 2000;
/** Full march cycle (ms) — two footfalls; every walk term closes on it. */
const STRIDE = 450;

function clamp01(v: number): number {
    return v < 0 ? 0 : v > 1 ? 1 : v;
}
function easeOut(t: number): number {
    return 1 - (1 - t) * (1 - t);
}
function easeIn(t: number): number {
    return t * t;
}
function smooth(t: number): number {
    return t * t * (3 - 2 * t);
}

/** Multiply a 0xRRGGBB colour toward dark (m<1) or light (m>1). */
function shade(c: number, m: number): number {
    const r = Math.max(0, Math.min(255, Math.round(((c >> 16) & 0xff) * m)));
    const g = Math.max(0, Math.min(255, Math.round(((c >> 8) & 0xff) * m)));
    const b = Math.max(0, Math.min(255, Math.round((c & 0xff) * m)));
    return (r << 16) | (g << 8) | b;
}

/** Linear mix of two 0xRRGGBB colours. */
function mix(a: number, b: number, t: number): number {
    const k = clamp01(t);
    const r = Math.round(((a >> 16) & 0xff) + (((b >> 16) & 0xff) - ((a >> 16) & 0xff)) * k);
    const g = Math.round(((a >> 8) & 0xff) + (((b >> 8) & 0xff) - ((a >> 8) & 0xff)) * k);
    const bb = Math.round((a & 0xff) + ((b & 0xff) - (a & 0xff)) * k);
    return (r << 16) | (g << 8) | bb;
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

/**
 * Stick raise profile over one beat cycle: 0 at the strike (u = 0), a quick
 * rebound, a slow raise to the poised peak, then the fast whip down so the
 * tip lands exactly on the next strike (u -> 1). Continuous at the loop seam.
 */
function beatLift(u: number): number {
    if (u < 0.10) return easeOut(u / 0.10) * 0.30;
    if (u < 0.60) return 0.30 + 0.70 * smooth((u - 0.10) / 0.50);
    if (u < 0.82) return 1;
    return 1 - easeIn((u - 0.82) / 0.18);
}

/** Impact flash right after a strike (u = phase since this stick's hit). */
function beatFlash(u: number): number {
    return Math.max(0, 1 - u / 0.13);
}

export function drawQuartermasterA(
    g: G,
    isPlayer: boolean,
    isMoving: boolean,
    facingAngle: number,
    troopLevel: number,
    time: number,
    _attackAge: number,
    _attackDelay: number,
    _driver: number
): void {
    const lvl = Math.max(1, Math.min(3, Math.floor(troopLevel || 1)));

    // ---------------- palettes (enemy darkens — the troop convention) ----
    const coat = isPlayer ? 0xb02a30 : 0x7d2430;
    const coatDk = shade(coat, 0.62);
    const coatHi = shade(coat, 1.28);
    const gold = isPlayer ? 0xd4a017 : 0xb08a1e;
    const goldDk = shade(gold, 0.66);
    const skinTone = isPlayer ? 0xdeb887 : 0xc9a66b;
    const leather = 0x4a3222;
    const cream = 0xefe6cc;

    // Level materials — humble wood -> fielded brass -> refined sandstone+gold.
    const shellCol = lvl === 1 ? 0x8a5a2e : lvl === 2 ? shade(coat, 0.85) : 0xd6cbb0;
    const hoopCol = lvl === 1 ? 0x5b3d20 : lvl === 2 ? 0xc0902c : gold;
    const ropeCol = lvl === 1 ? 0x46351f : lvl === 2 ? 0x8a6a30 : cream;
    const headBase = lvl === 1 ? 0xd9c9a3 : lvl === 2 ? 0xe1d4b2 : 0xece2c8;
    const knobCol = lvl === 1 ? 0x6b4522 : lvl === 2 ? 0xc0902c : (isPlayer ? 0xffd700 : 0xd8b83a);
    const stickCol = 0x8a6a42;
    const bandCol = lvl === 1 ? leather : lvl === 2 ? 0xc0902c : gold;
    const penCol = lvl === 3 ? (isPlayer ? 0xf0c33c : 0xcfa62f) : gold;
    const penDk = shade(penCol, 0.72);

    // ---------------- motion state (ONE clock per state) -----------------
    // uL/uR = per-stick beat phase (0 = the strike). clothPh = pennant clock.
    let swing = 0;      // leg scissor (walk)
    let lift = 0;       // footfall hop (walk)
    let ph = 0;         // stride phase (walk)
    let breathe = 0;    // -1..1 chest breath (idle, 2000 ms fundamental)
    let uL: number, uR: number, clothPh: number;
    if (isMoving) {
        ph = (((time % STRIDE) + STRIDE) % STRIDE) / STRIDE;
        const s = Math.sin(ph * PI2);
        swing = s * 1.7;
        lift = Math.abs(s) * 1.3;
        uL = ph;                    // left stick lands on the left footfall
        uR = (ph + 0.5) % 1;        // right stick on the right footfall
        clothPh = ph * PI2;         // one pennant wave per stride
    } else {
        const tt = ((time % IDLE_PERIOD) + IDLE_PERIOD) % IDLE_PERIOD;
        uL = (tt % 1000) / 1000;            // strikes at 0 / 1000 ms
        uR = ((tt + 500) % 1000) / 1000;    // strikes at 500 / 1500 ms
        breathe = Math.sin((tt / IDLE_PERIOD) * PI2);
        clothPh = (tt / IDLE_PERIOD) * PI2; // full wave = the 2000 ms fundamental
    }
    const fL = beatFlash(uL);
    const fR = beatFlash(uR);
    const F = Math.max(fL, fR * 0.9);   // combined hit envelope (500 ms harmonic)
    const hL = beatLift(uL);
    const hR = beatLift(uR) * 0.88;     // the off-beat hand sits a touch lower

    // Torso group offset: footfall hop while marching; breath rise + a small
    // dip into every drum hit at rest.
    const dy = isMoving ? -lift : -(breathe * 0.5 + 0.5) * 0.7 + F * 0.55;
    // March lean into the direction of travel (trigonometric facing use —
    // subtle, so the single baked heading reads everywhere).
    const lean = isMoving ? Math.cos(facingAngle || 0) * 0.8 : 0;

    // Drum anchor: hangs at the belly, bounces with the harness.
    const skinY = -1.5 + (isMoving ? -lift * 0.55 : 0) + F * 1.0;
    const DRX = 7.4;   // drumhead half-width
    const DRY = 3.1;   // drumhead half-height (iso-ish top ellipse)
    const SHELL = 4.4; // shell depth

    // ---------------- 1. contact shadow ---------------------------------
    g.fillStyle(0x000000, 0.22);
    g.fillEllipse(0, 9.6, 16.5, 6.3);

    // ---------------- 2. banner pole + pennant (behind the body) --------
    const poleTopX = 5.8 + lean * 0.6 + (isMoving ? swing * 0.15 : breathe * 0.3);
    const poleTopY = -20.6 + dy * 0.4;
    g.lineStyle(1.2, 0x6b4a2a, 1);
    g.lineBetween(2.8, 0.5 + dy * 0.3, poleTopX, poleTopY);
    if (lvl === 2) {
        g.fillStyle(0xc0902c, 1);
        g.fillTriangle(poleTopX - 1, poleTopY, poleTopX + 1, poleTopY, poleTopX, poleTopY - 2.2);
    } else if (lvl === 3) {
        g.fillStyle(gold, 1);
        g.fillCircle(poleTopX, poleTopY - 1, 1.2);
    }
    // Pennant cloth: columns down the fly, wave = ONE cycle per idle period
    // (or per stride), plus a crack on every drum hit.
    {
        const hx0 = poleTopX, hy0 = poleTopY + 0.4;
        const colX = [0, 3.0, 5.8, 8.3];
        const amp = [0, 0.7, 1.4, 2.1];
        const snap = [0, 0.3, 0.6, 1.0];
        const topY: number[] = [];
        const botY: number[] = [];
        for (let i = 0; i < 4; i++) {
            const w = Math.sin(clothPh - i * 0.9) * amp[i] - F * snap[i];
            topY[i] = hy0 + i * 0.25 + w;
            botY[i] = topY[i] + (3.4 - i * 0.55);
        }
        g.fillStyle(penCol, 1);
        if (lvl === 1) {
            // Humble triangular pennant (shorter fly).
            g.beginPath();
            g.moveTo(hx0 + colX[0], topY[0]);
            g.lineTo(hx0 + colX[2], (topY[2] + botY[2]) / 2);
            g.lineTo(hx0 + colX[0], botY[0]);
            g.closePath();
            g.fillPath();
        } else {
            // Swallowtail: out along the top edge, notch, back along the bottom.
            g.beginPath();
            g.moveTo(hx0 + colX[0], topY[0]);
            g.lineTo(hx0 + colX[1], topY[1]);
            g.lineTo(hx0 + colX[2], topY[2]);
            g.lineTo(hx0 + colX[3], topY[3]);
            g.lineTo(hx0 + colX[3] - 2.2, (topY[3] + botY[3]) / 2);
            g.lineTo(hx0 + colX[3], botY[3]);
            g.lineTo(hx0 + colX[2], botY[2]);
            g.lineTo(hx0 + colX[1], botY[1]);
            g.lineTo(hx0 + colX[0], botY[0]);
            g.closePath();
            g.fillPath();
            if (lvl === 3) {
                // Cream tail tips — accents, not masses.
                g.fillStyle(cream, 1);
                g.fillTriangle(hx0 + colX[3], topY[3], hx0 + colX[3] - 1.7, topY[3] + 0.5, hx0 + colX[3], topY[3] + 1.1);
                g.fillTriangle(hx0 + colX[3], botY[3], hx0 + colX[3] - 1.7, botY[3] - 0.5, hx0 + colX[3], botY[3] - 1.1);
            }
        }
        // Hoist stripe seats the cloth on the pole.
        g.fillStyle(penDk, 1);
        g.fillRect(hx0 - 0.4, topY[0], 1.1, botY[0] - topY[0]);
    }

    // ---------------- 3. legs + boots (high-knee march) ------------------
    const trouser = 0x3f3229;
    const bootCol = 0x241b14;
    const spread = 2.6;
    const sN = isMoving ? Math.sin(ph * PI2) : 0;
    const bootLy = 9.1 - Math.max(0, sN) * 2.0;
    const bootRy = 9.1 - Math.max(0, -sN) * 2.0;
    g.fillStyle(trouser, 1);
    g.fillRect(-spread - 1.2 - swing, 3.6 - lift, 2.4, Math.max(1, bootLy - (3.6 - lift)));
    g.fillRect(spread - 1.2 + swing, 3.6 - lift, 2.4, Math.max(1, bootRy - (3.6 - lift)));
    g.fillStyle(bootCol, 1);
    g.fillEllipse(-spread - swing, bootLy, 3.6, 1.9);
    g.fillEllipse(spread + swing, bootRy, 3.6, 1.9);

    // ---------------- 4. coat skirt --------------------------------------
    const hem = isMoving ? swing * 0.4 : 0;
    g.fillStyle(coatDk, 1);
    g.beginPath();
    g.moveTo(-5.6, 1.5 + dy);
    g.lineTo(5.6, 1.5 + dy);
    g.lineTo(6.9 + hem, 7.4);
    g.lineTo(-6.9 + hem, 7.4);
    g.closePath();
    g.fillPath();
    g.fillStyle(coat, 1);
    g.beginPath();
    g.moveTo(-4.9, 1.5 + dy);
    g.lineTo(4.9, 1.5 + dy);
    g.lineTo(6.0 + hem, 6.8);
    g.lineTo(-6.0 + hem, 6.8);
    g.closePath();
    g.fillPath();
    if (lvl >= 2) {
        g.lineStyle(0.9, lvl === 3 ? gold : goldDk, 1);
        g.lineBetween(-6.5 + hem, 7.0, 6.5 + hem, 7.0);
    }

    // ---------------- 5. barrel torso + cross-belts ----------------------
    const chest = isMoving ? 0 : (breathe * 0.5 + 0.5) * 0.8; // swells on the 2000 ms breath
    g.fillStyle(coatDk, 1);
    g.fillEllipse(0, -3.2 + dy, 13.4 + chest, 13.0);
    g.fillStyle(coat, 1);
    g.fillEllipse(-0.4, -3.5 + dy, 12.4 + chest, 12.2);
    g.fillStyle(coatHi, 1); // NW light
    g.fillEllipse(-2.2, -6.2 + dy, 5.4, 4.6);
    // Collar
    g.fillStyle(coatDk, 1);
    g.fillRect(-2.2, -10.2 + dy, 4.4, 1.6);
    // Gold cross-belts meeting in the sternum ring the drum hangs from.
    limb(g, goldDk, -5.2, -8.4 + dy, 4.8, -1.2 + dy, 2.4);
    limb(g, goldDk, 5.2, -8.4 + dy, -4.8, -1.2 + dy, 2.4);
    limb(g, gold, -5.2, -8.4 + dy, 4.8, -1.2 + dy, 1.7);
    limb(g, gold, 5.2, -8.4 + dy, -4.8, -1.2 + dy, 1.7);
    g.fillStyle(goldDk, 1);
    g.fillCircle(0, -4.9 + dy, 1.7);
    g.fillStyle(gold, 1);
    g.fillCircle(0, -4.9 + dy, 1.1);
    if (lvl === 3) {
        g.fillStyle(cream, 1);
        g.fillCircle(-0.35, -5.25 + dy, 0.45);
    }
    // Epaulettes
    if (lvl === 1) {
        g.fillStyle(coatDk, 1);
        g.fillEllipse(-5.3, -7.6 + dy, 3.0, 1.7);
        g.fillEllipse(5.3, -7.6 + dy, 3.0, 1.7);
    } else {
        const ep = lvl === 2 ? 0xc0902c : gold;
        g.fillStyle(ep, 1);
        g.fillEllipse(-5.3, -7.7 + dy, 3.3, 1.9);
        g.fillEllipse(5.3, -7.7 + dy, 3.3, 1.9);
        if (lvl === 3) {
            g.lineStyle(0.7, goldDk, 1);
            for (const sSide of [-1, 1]) {
                g.lineBetween(sSide * 6.3, -7.4 + dy, sSide * 6.6, -5.9 + dy);
                g.lineBetween(sSide * 5.5, -7.2 + dy, sSide * 5.7, -5.7 + dy);
            }
        }
    }

    // ---------------- 6. head + mustache + shako -------------------------
    const hx = lean;
    const hy = -11.4 + dy * 0.9;
    g.fillStyle(skinTone, 1);
    g.fillCircle(hx, hy, 2.9);
    g.fillStyle(0x2a1c12, 1);
    g.fillCircle(hx - 1.0, hy - 0.3, 0.42);
    g.fillCircle(hx + 1.0, hy - 0.3, 0.42);
    // Walrus mustache
    g.fillStyle(lvl === 3 ? 0x8a8378 : 0x5a4630, 1);
    g.fillEllipse(hx, hy + 1.4, 3.8, 1.4);
    // Tall crimson shako
    g.fillStyle(coatDk, 1);
    g.fillRect(hx - 3.3, hy - 7.3, 6.6, 4.6);
    g.fillStyle(shade(coatDk, 1.18), 1);
    g.fillEllipse(hx, hy - 7.3, 6.6, 2.2);
    g.fillStyle(bandCol, 1);
    g.fillRect(hx - 3.3, hy - 3.5, 6.6, 1.3);
    if (lvl >= 2) {
        g.fillStyle(lvl === 2 ? 0xc0902c : gold, 1);
        g.fillCircle(hx, hy - 5.2, 0.95);
    }
    if (lvl === 3) {
        // Small cream plume in a gold socket — a subtle accent.
        g.fillStyle(cream, 1);
        g.fillEllipse(hx - 2.9, hy - 8.9, 1.7, 3.4);
        g.fillStyle(gold, 1);
        g.fillCircle(hx - 2.9, hy - 7.1, 0.6);
    }

    // ---------------- 7. the war drum ------------------------------------
    const byC = skinY + SHELL; // bottom cap center
    // Bottom hoop crescent, then the shell over it.
    g.fillStyle(hoopCol, 1);
    g.fillEllipse(0, byC, DRX * 2, DRY * 2);
    g.fillStyle(shade(shellCol, 0.9), 1);
    g.fillEllipse(0, byC - 1.2, DRX * 2, DRY * 2);
    g.fillStyle(shade(shellCol, 0.9), 1);
    g.fillRect(-DRX, skinY, DRX * 2, SHELL);
    // NW-lit left panel, darker right edge.
    g.fillStyle(shade(shellCol, 1.12), 1);
    g.fillRect(-DRX + 0.8, skinY + 0.2, 6.0, SHELL - 0.2);
    g.fillStyle(shade(shellCol, 0.72), 1);
    g.fillRect(DRX - 3.0, skinY + 0.2, 3.0, SHELL + 0.6);
    // Rope tension zig-zags.
    g.lineStyle(1.0, ropeCol, 1);
    for (const cx of [-4.95, -1.65, 1.65, 4.95]) {
        g.lineBetween(cx - 1.65, skinY + 0.7, cx, skinY + SHELL - 0.3);
        g.lineBetween(cx, skinY + SHELL - 0.3, cx + 1.65, skinY + 0.7);
    }
    // Rim tassels swing on the same clocks (L2+).
    if (lvl >= 2) {
        const tSway = Math.sin(clothPh - 1.2) * 0.7 - F * 0.9;
        g.lineStyle(0.8, goldDk, 1);
        g.lineBetween(-5.6, byC + 1.6, -5.6 + tSway, byC + 3.6);
        g.lineBetween(5.6, byC + 1.9, 5.6 + tSway, byC + 3.9);
        g.fillStyle(gold, 1);
        g.fillCircle(-5.6 + tSway, byC + 3.9, 0.75);
        g.fillCircle(5.6 + tSway, byC + 4.2, 0.75);
    }
    // Drumhead: the whole skin flashes bright on every hit (opaque recolor —
    // the beat must read from the sky).
    const skinLo = mix(shade(headBase, 0.84), 0xf3e2b8, F * 0.8);
    const skinHi = mix(headBase, 0xfff3d0, F * 0.8);
    g.fillStyle(skinLo, 1);
    g.fillEllipse(0, skinY, DRX * 2, DRY * 2);
    g.fillStyle(skinHi, 1);
    g.fillEllipse(-0.3, skinY - 0.35, DRX * 2 - 1.4, DRY * 2 - 0.9);
    // Counter-hoop ring (glints toward white on the hit).
    g.lineStyle(1.4, mix(hoopCol, 0xffffff, F * 0.55), 1);
    g.strokeEllipse(0, skinY, DRX * 2, DRY * 2);
    if (lvl === 2) {
        g.lineStyle(0.9, shade(coat, 0.8), 1);
        g.strokeEllipse(0, skinY + 0.2, 4.4, 1.9);
    } else if (lvl === 3) {
        g.lineStyle(0.9, gold, 1);
        g.strokeEllipse(0, skinY + 0.2, 4.6, 2.0);
        g.fillStyle(gold, 1);
        g.fillCircle(0, skinY + 0.2, 0.7);
    }

    // ---------------- 8. impact bursts ------------------------------------
    for (const [sSide, f] of [[-1, fL], [1, fR]] as const) {
        if (f <= 0.02) continue;
        const ix = sSide * 3.3, iy = skinY + 0.8;
        g.fillStyle(0xfff6d8, 1);
        g.fillEllipse(ix, iy, 3.4 * f + 1.2, 1.6 * f + 0.6);
        g.lineStyle(0.9, 0xfff6d8, 1);
        g.lineBetween(ix + sSide * (1.6 + 1.2 * f), iy - 0.6 - 0.8 * f, ix + sSide * (2.6 + 2.0 * f), iy - 1.2 - 1.6 * f);
        g.lineBetween(ix - sSide * 1.2, iy - 1.0 - 1.4 * f, ix - sSide * 1.8, iy - 1.6 - 2.4 * f);
    }

    // ---------------- 9. arms + drumsticks --------------------------------
    for (const [sSide, h] of [[-1, hL], [1, hR]] as const) {
        // Tip swings from the skin (h=0) up past the shoulder (h=1) with a
        // slight outward bow; the hand follows a shorter arc.
        const bow = Math.sin(Math.PI * h) * 1.4;
        const tipX = sSide * (3.3 + 3.1 * h + bow);
        const tipY = (skinY + 0.7) + (-9.3) * h;
        const handX = sSide * (7.3 + 0.8 * h);
        const handY = (skinY - 1.6) + (-3.3) * h;
        limb(g, coat, sSide * 5.6, -6.6 + dy, handX, handY, 2.4);
        // Cuff
        g.lineStyle(0.9, lvl >= 2 ? gold : coatDk, 1);
        g.lineBetween(handX - sSide * 1.2, handY - 1.0, handX - sSide * 0.2, handY + 1.0);
        // Stick shaft + butt behind the fist
        const dxs = tipX - handX, dys = tipY - handY;
        const dl = Math.hypot(dxs, dys) || 1;
        g.lineStyle(1.2, stickCol, 1);
        g.lineBetween(handX - (dxs / dl) * 1.4, handY - (dys / dl) * 1.4, tipX, tipY);
        // Fist
        g.fillStyle(skinTone, 1);
        g.fillCircle(handX, handY, 1.4);
        // Knob head
        g.fillStyle(knobCol, 1);
        g.fillCircle(tipX, tipY, 1.2);
        if (lvl === 3) {
            g.fillStyle(cream, 1);
            g.fillCircle(tipX - 0.4, tipY - 0.4, 0.4);
        }
    }
}
