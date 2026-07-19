import type Phaser from 'phaser';

/**
 * DESIGN B — NECROMANCER: the LICH-SCHOLAR.
 *
 * Read: tall, slender, aristocratic. A straight-backed scholar in a narrow
 * violet robe (0x6a4c93) with a high collar, a tome CHAINED at the hip, and
 * a tall crescent-topped staff cradling a grave-green ember. Grave green
 * (0x63e0a0) appears ONLY as thin clean lines: hem rune-line, chest seam,
 * eye points, the ember, the cast orb.
 *
 * Motion contract (all deterministic f(time), bake-safe):
 *  - WALK  — measured glide, stride EXACTLY 480 ms: low bounce, hem sway,
 *    staff planted (it pole-walks with him).
 *  - IDLE  — ONE declared period 2000 ms (250 ms multiple). Terms are exact
 *    harmonics: breath = h1 (2000 ms), staff ember pulse = h2 (1000 ms),
 *    tome page-flutter = h4 (500 ms, tip lifts ~2.2 px — survives the
 *    1.35 px quantize).
 *  - ATTACK — delay 1600: precise two-finger cast. Wind-up 620 ms (free hand
 *    rises, two fingers extend, orb charges at the fingertips, thin summon
 *    ring under the hem); strike 300 ms (ring flash + the orb visibly
 *    RELEASES along a green streak). The summon flourish reuses this
 *    silhouette.
 *
 * Levels: L1 iron crescent / rope belt; L2 silver crescent + silver trim +
 * silver circlet; L3 gold ACCENTS only (crescent, one hem thread, circlet,
 * tome clasp) — the robe stays violet.
 *
 * NW light everywhere: highlights ride the upper-left of every mass, shade
 * on the lower-right. No baked translucency: bodies are opaque; the only
 * sub-50%-alpha marks are glows whose blink IS the animation term.
 */

type G = Phaser.GameObjects.Graphics;

const TAU = Math.PI * 2;

// ---- exact declared periods (250 ms multiples / exact strides) ----
const NECRO_STRIDE = 480;   // ms — measured glide
const NECRO_IDLE_P = 2000;  // ms — breath h1, ember h2, page-flutter h4

const GREEN = 0x63e0a0;       // grave green — thin clean lines only
const GREEN_DEEP = 0x2f8f62;

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);
const easeOut = (t: number): number => 1 - (1 - t) * (1 - t);

/** Multiply a 0xRRGGBB colour toward dark (m<1) or light (m>1). */
function shade(c: number, m: number): number {
    const r = Math.max(0, Math.min(255, Math.round(((c >> 16) & 0xff) * m)));
    const g = Math.max(0, Math.min(255, Math.round(((c >> 8) & 0xff) * m)));
    const b = Math.max(0, Math.min(255, Math.round((c & 0xff) * m)));
    return (r << 16) | (g << 8) | b;
}
/** One limb segment as a thick quad from (x0,y0) to (x1,y1). */
function limb(g: G, color: number, x0: number, y0: number, x1: number, y1: number, w: number = 1.9): void {
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

/** Attack-cycle state locked to the damage tick (TroopRenderer semantics:
 *  wind-up ramps 0→1 over the last windupMs BEFORE the tick, strike decays
 *  1→0 over the first strikeMs AFTER it; stale ages free-run for replays). */
function attackState(time: number, attackAge: number, attackDelay: number, windupMs: number, strikeMs: number): { windup: number; strike: number; age: number; inCombat: boolean } {
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

// ======================= CANONICAL NECROMANCER B =======================


export function drawNecromancerB(
    g: G,
    isPlayer: boolean,
    isMoving: boolean,
    _facingAngle: number, // dirs: 1 — front-on
    troopLevel: number,
    time: number,
    attackAge: number,
    attackDelay: number,
    _driver: number
): void {
    const atk = attackState(time, attackAge, attackDelay || 1600, 620, 300);
    const wu = (!isMoving && atk.inCombat) ? easeOut(atk.windup) : 0;
    const st = (!isMoving && atk.inCombat) ? atk.strike : 0;

    // ---- the two clocks (walk closes on 480 ms, idle on 2000 ms) ----
    let swing = 0, lift = 0, hem = 0;
    let flutter = 0;   // tome page tip, h4 of the idle period
    let ember = 0;     // staff ember pulse, h2 idle / h1 stride
    if (isMoving) {
        const ph = (time % NECRO_STRIDE) / NECRO_STRIDE;
        const s = Math.sin(ph * TAU);
        swing = s * 1.7;
        lift = Math.abs(s) * 0.7;          // low bounce — a glide
        hem = s * 1.0;                      // hem sways with the stride
        ember = Math.sin(ph * TAU);         // h1 of the stride — loops
    } else {
        const breathe = Math.sin(((time % NECRO_IDLE_P) / NECRO_IDLE_P) * TAU);         // h1
        ember = Math.sin(((time % (NECRO_IDLE_P / 2)) / (NECRO_IDLE_P / 2)) * TAU);      // h2
        flutter = Math.max(0, Math.sin(((time % (NECRO_IDLE_P / 4)) / (NECRO_IDLE_P / 4)) * TAU)); // h4
        lift = Math.max(0, breathe) * 0.5;
    }

    // ---- palette (enemy = the darkened convention; green is identity) ----
    const robe = isPlayer ? 0x6a4c93 : shade(0x6a4c93, 0.72);
    const robeDark = shade(robe, 0.6);
    const robeLight = shade(robe, 1.3);
    const skin = isPlayer ? 0xd6dcc9 : 0xc2c8b4; // lich pallor
    const hair = isPlayer ? 0x241d31 : 0x1b1626;
    const iron = 0x9aa0a8;
    const silver = 0xd7dce4;
    const crescentMetal = troopLevel >= 3 ? 0xdaa520 : (troopLevel >= 2 ? silver : iron);

    // ---- contact shadow ----
    g.fillStyle(0x000000, 0.22);
    g.fillEllipse(0, 9.6, 10, 3.8);

    // Summon/cast ring under the hem during the wind-up (thin 2:1 ellipse).
    if (wu > 0.08) {
        g.lineStyle(0.9, GREEN, 0.4 * wu);
        g.strokeEllipse(0, 9.3, 8.5 + 3 * wu, (8.5 + 3 * wu) / 2 * 0.42);
    }

    // ---- robe: slender A-line skirt, hem swaying on the march ----
    const waistY = 0.6 - lift * 0.5;
    g.fillStyle(robeDark, 1);
    g.beginPath();
    g.moveTo(-2.7, waistY); g.lineTo(2.7, waistY);
    g.lineTo(4.5 + hem, 9.3); g.lineTo(-4.5 + hem, 9.3);
    g.closePath(); g.fillPath();
    g.fillStyle(robe, 1);
    g.beginPath();
    g.moveTo(-2.3, waistY); g.lineTo(2.3, waistY);
    g.lineTo(3.8 + hem, 8.7); g.lineTo(-3.8 + hem, 8.7);
    g.closePath(); g.fillPath();
    // NW light: one clean panel down the left edge of the skirt.
    limb(g, robeLight, -2.0, waistY + 0.4, -3.2 + hem, 8.4, 1.2);
    // Grave-green hem rune-line (the signature thin line).
    g.lineStyle(0.8, GREEN, 0.9);
    g.lineBetween(-3.9 + hem, 8.95, 3.9 + hem, 8.95);
    if (troopLevel >= 2) {
        g.lineStyle(0.7, troopLevel >= 3 ? 0xdaa520 : silver, 0.9);
        g.lineBetween(-3.4 + hem * 0.9, 7.8, 3.4 + hem * 0.9, 7.8);
    }

    // ---- torso: slim, high-waisted; belt anchors the tome chain ----
    g.fillStyle(robe, 1);
    g.fillEllipse(0, -2.6 - lift, 5.4, 7.0);
    g.fillStyle(robeLight, 1);
    g.fillEllipse(-1.2, -4.2 - lift, 1.8, 3.0); // NW sheen
    g.fillStyle(robeDark, 1);
    g.fillRect(-2.4, 0.2 - lift, 4.8, 1.2);     // belt
    if (troopLevel === 1) {                      // rope belt knot
        g.fillStyle(0x8a7a5a, 1);
        g.fillCircle(0.6, 0.8 - lift, 0.7);
    }
    // Thin green chest seam — scholar's binding thread.
    g.lineStyle(0.7, GREEN, 0.8);
    g.lineBetween(0, -5.4 - lift, 0, -0.2 - lift);

    // ---- high collar (behind the head) + narrow mantle ----
    g.fillStyle(robeDark, 1);
    g.fillTriangle(-2.8, -5.0 - lift, -1.0, -9.8 - lift, -0.2, -5.4 - lift);
    g.fillTriangle(2.8, -5.0 - lift, 1.0, -9.8 - lift, 0.2, -5.4 - lift);
    g.fillEllipse(0, -5.0 - lift, 6.2, 2.6);

    // ---- head: gaunt, pale, swept-back hair, green eye points ----
    const headY = -8.2 - lift - 0.4 * wu; // lifts his chin as the cast charges
    g.fillStyle(skin, 1);
    g.fillCircle(0, headY, 2.5);
    g.fillStyle(shade(skin, 0.8), 1);
    g.fillEllipse(1.1, headY + 0.5, 1.3, 1.9); // gaunt SE cheek shade
    g.fillStyle(hair, 1);
    g.beginPath();
    g.arc(0, headY - 0.7, 2.5, Math.PI, 0, false);
    g.closePath(); g.fillPath();
    g.fillTriangle(-0.7, headY - 1.6, 0.7, headY - 1.6, 0, headY - 0.2); // widow's peak
    g.fillStyle(GREEN, 0.95);
    g.fillCircle(-0.9, headY + 0.1, 0.5);
    g.fillCircle(0.9, headY + 0.1, 0.5);
    if (troopLevel >= 2) { // circlet: silver, then gold at max — accent only
        g.lineStyle(0.7, troopLevel >= 3 ? 0xffd700 : silver, 0.95);
        g.beginPath();
        g.arc(0, headY - 0.4, 2.6, Math.PI * 1.15, Math.PI * 1.85, false);
        g.strokePath();
    }

    // ---- tome chained at the right hip ----
    const tomeSway = isMoving ? swing * 0.45 : 0;
    const tx = 2.4 + tomeSway, ty = 2.6;
    g.fillStyle(iron, 1); // chain: three links from belt to tome
    for (let i = 1; i <= 3; i++) {
        const cxp = 1.8 + (tx + 1.0 - 1.8) * (i / 3.5);
        const cyp = 0.9 - lift + (ty - (0.9 - lift)) * (i / 3.5);
        g.fillCircle(cxp, cyp, 0.35);
    }
    g.fillStyle(0x3a3145, 1);                 // cover
    g.fillRect(tx, ty, 2.7, 3.4);
    g.fillStyle(0xe6dfc6, 1);                 // page block edge (NW side)
    g.fillRect(tx + 0.3, ty + 0.4, 0.7, 2.6);
    g.lineStyle(0.6, GREEN, 0.85);            // thin green cover line
    g.lineBetween(tx + 1.6, ty + 0.5, tx + 1.6, ty + 2.9);
    if (troopLevel >= 2) {
        g.fillStyle(troopLevel >= 3 ? 0xdaa520 : silver, 1);
        g.fillRect(tx + 2.1, ty + 1.3, 0.8, 0.8); // clasp
    }
    // Idle page-flutter: a loose page tip lifting on h4 (≈2.2 px travel).
    if (!isMoving) {
        g.fillStyle(0xf2ecd6, 0.95);
        g.fillTriangle(tx + 0.2, ty + 0.4, tx + 1.7, ty + 0.6, tx + 0.9, ty - 0.7 - 1.5 * flutter);
    }

    // ---- staff: tall, planted, crescent-topped, green ember cradled ----
    const stfX = -4.4 + (isMoving ? swing * 0.35 : 0);
    const stfBot = 9.0 - (isMoving ? lift * 0.4 : 0);
    const stfTopY = -14.6;
    g.lineStyle(1.5, 0x4a3826, 1);
    g.lineBetween(stfX, stfTopY, stfX, stfBot);
    g.lineStyle(1.5, shade(0x4a3826, 1.35), 1); // NW-lit sliver
    g.lineBetween(stfX - 0.4, stfTopY + 2, stfX - 0.4, stfTopY + 7);
    g.lineStyle(0.6, GREEN_DEEP, 0.9);          // thin green grip-wrap
    g.lineBetween(stfX - 0.9, -4.0, stfX + 0.9, -4.6);
    g.lineBetween(stfX - 0.9, -3.2, stfX + 0.9, -3.8);

    // Crescent (an upward-open cradle) in the level metal.
    const ccx = stfX, ccy = stfTopY - 1.0;
    g.lineStyle(1.6, crescentMetal, 1);
    g.beginPath();
    g.arc(ccx, ccy, 2.6, Math.PI * 0.12, Math.PI * 0.88, false);
    g.strokePath();
    g.fillStyle(troopLevel >= 3 ? 0xffd700 : crescentMetal, 1);
    g.fillCircle(ccx + Math.cos(Math.PI * 0.12) * 2.6, ccy + Math.sin(Math.PI * 0.12) * 2.6, 0.55);
    g.fillCircle(ccx + Math.cos(Math.PI * 0.88) * 2.6, ccy + Math.sin(Math.PI * 0.88) * 2.6, 0.55);

    // Ember: pulse on h2 idle / h1 stride; flares with the cast wind-up.
    const emA = 0.3 + 0.26 * ember + 0.4 * wu;      // glow blinks across the snap line
    const emR = 1.15 + 0.35 * (0.5 + 0.5 * ember) + 0.7 * wu;
    g.fillStyle(GREEN, clamp01(emA));
    g.fillCircle(ccx, ccy + 0.6, emR + 1.1);
    g.fillStyle(GREEN, 0.95);
    g.fillCircle(ccx, ccy + 0.6, emR);
    g.fillStyle(0xeafff2, 0.9);
    g.fillCircle(ccx - 0.3, ccy + 0.3, 0.5);

    // ---- arms ----
    // Staff arm: stays planted on the staff (the signature).
    limb(g, robe, -1.9, -3.0 - lift, stfX + 0.3, -4.6 - lift * 0.4, 1.9);
    g.fillStyle(skin, 1);
    g.fillCircle(stfX + 0.3, -4.6 - lift * 0.4, 1.0);

    // Free arm: rests by the tome; rises into the precise two-finger cast.
    const ext = Math.max(wu, st);              // holds extension through the release
    const hx = 2.2 + 2.5 * ext;
    const hy = (-1.6 - lift) + (isMoving ? swing * 0.3 : 0) - 5.2 * ext;
    limb(g, robe, 1.9, -3.0 - lift, hx, hy, 1.9);
    g.fillStyle(skin, 1);
    g.fillCircle(hx, hy, 0.95);
    if (ext > 0.15) {
        // Two extended fingers — thin, exact.
        g.lineStyle(0.7, skin, 1);
        g.lineBetween(hx + 0.5, hy - 0.3, hx + 2.1, hy - 0.85);
        g.lineBetween(hx + 0.5, hy + 0.35, hx + 2.0, hy + 0.05);
    }

    // ---- the cast: orb charges at the fingertips, releases on the tick ----
    const fx = hx + 2.5, fy = hy - 0.4;         // fingertip focus
    if (wu > 0.05 && st === 0) {
        g.fillStyle(GREEN, clamp01(0.22 + 0.4 * wu));
        g.fillCircle(fx, fy, 1.2 + 2.2 * wu);
        g.fillStyle(GREEN, 0.95);
        g.fillCircle(fx, fy, 0.6 + 1.0 * wu);
        g.fillStyle(0xeafff2, 0.9 * wu);
        g.fillCircle(fx - 0.3, fy - 0.3, 0.5);
        // A thread of power up from the tome to the fingers.
        g.lineStyle(0.6, GREEN, 0.35 * wu);
        g.lineBetween(tx + 1.6, ty + 0.5, fx - 0.6, fy + 0.6);
    }
    if (st > 0) {
        // Release: ring flash at the fingers, orb streaks away — readable.
        const t = 1 - st;                        // 0 at tick → 1 end of strike
        const ox = fx + 9.5 * t * 0.97, oy = fy - 9.5 * t * 0.24;
        g.lineStyle(0.9, GREEN, 0.75 * st);
        g.strokeCircle(fx, fy, 1.5 + 3.0 * t);
        g.lineStyle(0.8, GREEN, 0.55 * st);
        g.lineBetween(fx, fy, ox, oy);
        g.fillStyle(GREEN, 0.95);
        g.fillCircle(ox, oy, 1.6 - 0.5 * t);
        g.fillStyle(0xeafff2, 0.85 * st);
        g.fillCircle(ox - 0.3, oy - 0.3, 0.55);
    }
}
