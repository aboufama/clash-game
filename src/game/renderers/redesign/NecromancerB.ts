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
 * DESIGN B — SKELETON: the FENCER-DUELIST (same file so the pair always
 * matches). Elegant upright fencing posture, off-arm folded behind the back,
 * a rusty swept-hilt rapier, grave-green eye points + pommel gem. dirs: 8 —
 * the rapier, the stance and the lunge all aim along `facingAngle`
 * (iso-squashed ground plane; blade draws BEFORE the body when aiming
 * up-screen). Walk = rattle-march, stride EXACTLY 300 ms (jaw jitters on h2
 * of the stride). Idle = ONE declared period 1000 ms: rib micro-shimmy = h1
 * (±0.8 px → 1.6 px travel), jaw rattle = h2 (drops 1.6 px), eye ember = h1.
 * Attack — delay 900: coil back on the wind-up (260 ms), full-extension
 * lunge on the tick (strike 150 ms) with a thin green streak off the tip.
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
const SKEL_STRIDE = 300;    // ms — rattle-march
const SKEL_IDLE_P = 1000;   // ms — rib shimmy h1, jaw h2, eye ember h1

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

// ============================ NECROMANCER B ============================

/** Per-slot bake-param overrides (DesignRegistry.designBakeParams). delay
 *  1600 = the runtime TroopDefinitions attackDelay (the table's pinned 5000
 *  would bake windup ages runtime windup never reaches — nearest-value
 *  matching would display strike frames through the windup). This slot's
 *  attackState call authors windup 620 / strike 300 (table pins 700/400);
 *  idles close on NECRO_IDLE_P = 2000 / SKEL_IDLE_P = 1000. */
export const PARAMS: import('./DesignRegistry').DesignParamsExport = {
    necromancer: { delay: 1600, windup: 620, strike: 300, idleMs: 2000 },
    skeleton: { idleMs: 1000 },
};

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

// ============================= SKELETON B =============================

export function drawSkeletonB(
    g: G,
    isPlayer: boolean,
    isMoving: boolean,
    facingAngle: number, // dirs: 8 — stance, rapier and lunge all aim here
    troopLevel: number,
    time: number,
    attackAge: number,
    attackDelay: number,
    _driver: number
): void {
    const atk = attackState(time, attackAge, attackDelay || 900, 260, 150);
    const wu = (!isMoving && atk.inCombat) ? easeOut(atk.windup) : 0;
    const st = (!isMoving && atk.inCombat) ? atk.strike : 0;

    const fa = facingAngle || 0;
    const ax = Math.cos(fa);
    const ay = Math.sin(fa) * 0.5;              // iso-squashed ground plane
    const upScreen = Math.sin(fa) < 0;          // blade behind the body then

    // ---- clocks: 300 ms rattle-march / 1000 ms idle micro-rattle ----
    let swing = 0, lift = 0, jaw = 0, ribShift = 0, eyeA = 0.9;
    if (isMoving) {
        const ph = (time % SKEL_STRIDE) / SKEL_STRIDE;
        const s = Math.sin(ph * TAU);
        swing = s * 1.9;
        lift = Math.abs(s) * 1.1;               // steppy — a rattle-march
        jaw = Math.abs(Math.sin(ph * TAU * 2)) * 0.8;  // h2 of the stride
        ribShift = Math.sin(ph * TAU * 2) * 0.4;
    } else {
        const em = Math.sin(((time % SKEL_IDLE_P) / SKEL_IDLE_P) * TAU);                  // h1
        jaw = Math.max(0, Math.sin(((time % (SKEL_IDLE_P / 2)) / (SKEL_IDLE_P / 2)) * TAU)) * 1.6; // h2, 1.6 px
        ribShift = em * 0.8;                    // ±0.8 px → 1.6 px travel
        eyeA = 0.55 + 0.4 * em;                 // ember eyes breathe with it
    }

    // ---- palette ----
    let bone = isPlayer ? 0xd8d8c8 : shade(0xd8d8c8, 0.8);
    if (troopLevel >= 3) bone = shade(bone, 1.06);
    const boneDark = shade(bone, 0.55);
    const boneLight = shade(bone, 1.15);
    const blade = troopLevel >= 3 ? 0xd9dee6 : (troopLevel >= 2 ? 0xc4cad2 : 0xa87b58);
    const guardMetal = troopLevel >= 3 ? 0xdaa520 : (troopLevel >= 2 ? 0xb9bfc8 : 0x8a6a4c);
    const rustDots = troopLevel >= 3 ? 0 : (troopLevel >= 2 ? 1 : 3);

    // Lunge kinematics: coil back on wind-up, full extension on the tick.
    const lean = st * 2.2 - wu * 1.1;           // body travel along the facing
    const bx = ax * lean;                        // body offset x
    const by = ay * lean;                        // body offset y

    // ---- contact shadow ----
    g.fillStyle(0x000000, 0.22);
    g.fillEllipse(bx * 0.6, 9.6, 8, 3);

    // ---- rapier (composed so it can draw behind the body up-screen) ----
    const cx = bx + (isMoving ? 0 : ribShift);   // ribcage center x
    const drawRapier = () => {
        // The sword hand sits a touch OFF the facing axis (a right-handed
        // fencer's blade side) so the rapier never collapses behind the body
        // when aiming straight up/down-screen (ax → 0).
        const pxo = -Math.sin(fa) * 1.6;
        const pyo = Math.cos(fa) * 0.5 * 1.6;
        // The BLADE draws along the normalized screen direction (constant
        // screen length at every aim — the archer-bow readability convention);
        // only stance/lean stay on the iso-squashed ground plane. A strictly
        // projected rapier vanishes to 3.5 px pointing up/down-screen.
        const n = Math.hypot(ax, ay) || 1;
        const ux = ax / n, uy = ay / n;
        const sx = cx + ax * 2.2, sy = -4.3 - lift * 0.3 + by;      // shoulder
        const reach = 2.6 - 2.0 * wu + 5.0 * st;                    // coil → lunge
        const hxp = sx + ax * reach + pxo;
        const hyp = sy + ay * reach + pyo + 1.8 - 1.2 * wu - 0.6 * st; // guard height
        limb(g, bone, sx, sy, hxp, hyp, 1.2);
        g.fillStyle(boneLight, 1);
        g.fillCircle(hxp, hyp, 0.8);                                // hand
        // Swept bell guard + pommel (green gem from L2 — thin accent).
        g.lineStyle(0.8, guardMetal, 1);
        g.strokeCircle(hxp + ux * 0.7, hyp + uy * 0.7, 1.1);
        g.fillStyle(guardMetal, 1);
        g.fillCircle(hxp - ux * 1.1, hyp - uy * 1.1, 0.55);
        if (troopLevel >= 2) {
            g.fillStyle(GREEN, 0.95);
            g.fillCircle(hxp - ux * 1.1, hyp - uy * 1.1, 0.35);
        }
        // Blade: angled up at guard, level at full lunge.
        const upTilt = 2.4 + 1.2 * wu - (2.2 + 1.2 * wu) * st;
        const len = 7.0 + 1.5 * st;
        const bx0 = hxp + ux * 1.2, by0 = hyp + uy * 1.2;
        const tx1 = bx0 + ux * len, ty1 = by0 + uy * len - upTilt;
        g.lineStyle(0.9, blade, 1);
        g.lineBetween(bx0, by0, tx1, ty1);
        g.fillStyle(boneLight, 1);
        g.fillCircle(tx1, ty1, 0.4);                                // tip glint
        for (let i = 0; i < rustDots; i++) {                        // rust patches
            const f = 0.3 + i * 0.22;
            g.fillStyle(0x8a5a38, 1);
            g.fillCircle(bx0 + (tx1 - bx0) * f, by0 + (ty1 - by0) * f, 0.45);
        }
        if (st > 0.35) {                                            // green streak
            g.lineStyle(0.8, GREEN, 0.7 * st);
            g.lineBetween(tx1, ty1, tx1 - ux * 3.2, ty1 - uy * 3.2 + upTilt * 0.4);
        }
    };
    if (upScreen) drawRapier();

    // ---- legs: fencing stance along the facing ----
    const pelX = bx * 0.6, pelY = 3.2;
    const dfF = 2.3 + st * 2.6;                  // front foot slides with the lunge
    const dfB = -2.0 - wu * 1.2;                 // back foot digs in on the coil
    const fFx = ax * dfF + (isMoving ? swing : 0), fFy = 9.2 + ay * dfF;
    const fBx = ax * dfB - (isMoving ? swing : 0), fBy = 9.2 + ay * dfB;
    limb(g, bone, pelX + ax * 0.6, pelY + 0.4, fFx, fFy - lift * 0.4, 1.2);
    limb(g, boneDark, pelX - ax * 0.6, pelY + 0.4, fBx, fBy - lift * 0.4, 1.2);
    g.fillStyle(bone, 1);
    g.fillEllipse(fFx, fFy, 2.2, 1.1);
    g.fillStyle(boneDark, 1);
    g.fillEllipse(fBx, fBy, 2.2, 1.1);

    // ---- pelvis + spine ----
    g.fillStyle(bone, 1);
    g.fillEllipse(pelX, pelY, 3.0, 1.7);
    limb(g, bone, pelX, pelY - 0.3, cx, -0.8 + by * 0.5, 1.0);

    // ---- ribcage: bone mass with dark rib gaps, NW sheen ----
    const rcy = -2.6 - lift * 0.5 + by * 0.5;
    g.fillStyle(bone, 1);
    g.fillEllipse(cx, rcy, 5.0, 5.8);
    g.lineStyle(0.7, boneDark, 1);
    g.lineBetween(cx - 2.1, rcy - 1.4, cx + 2.1, rcy - 1.4);
    g.lineBetween(cx - 2.3, rcy, cx + 2.3, rcy);
    g.lineBetween(cx - 2.0, rcy + 1.4, cx + 2.0, rcy + 1.4);
    g.fillStyle(boneLight, 1);
    g.fillEllipse(cx - 1.3, rcy - 1.6, 1.6, 1.8); // NW light
    g.fillStyle(bone, 1);                          // shoulder knobs
    g.fillCircle(cx - 2.2, -4.4 - lift * 0.3 + by, 0.8);
    g.fillCircle(cx + 2.2, -4.4 - lift * 0.3 + by, 0.8);

    // ---- off-arm folded behind the back (the fencer's manner) ----
    limb(g, boneDark, cx - ax * 2.2, -4.2 - lift * 0.3 + by, cx - ax * 3.3, -0.6 + by * 0.5, 1.1);
    g.fillStyle(boneDark, 1);
    g.fillCircle(cx - ax * 3.3, -0.6 + by * 0.5, 0.7);

    // ---- skull: turned to the facing, jaw rattling on its harmonic ----
    const skx = cx + ax * 0.6, sky = -7.6 - lift * 0.4 + by;
    g.fillStyle(bone, 1);
    g.fillCircle(skx, sky, 2.4);
    g.lineStyle(0.8, boneLight, 1); // NW-lit rim of the cranium
    g.beginPath();
    g.arc(skx - 0.4, sky - 0.5, 2.1, Math.PI * 0.95, Math.PI * 1.7, false);
    g.strokePath();
    g.fillStyle(0x23211a, 1);                     // mouth gap opens with the jaw
    g.fillRect(skx - 1.3, sky + 1.6, 2.6, 0.7 + jaw * 0.6);
    g.fillStyle(bone, 1);                          // the jaw itself
    g.fillRoundedRect(skx - 1.5, sky + 1.9 + jaw, 3.0, 1.3, 0.6);
    g.fillStyle(0x23211a, 1);                     // eye sockets
    g.fillCircle(skx - 0.95 + ax * 0.35, sky - 0.3, 0.75);
    g.fillCircle(skx + 0.95 + ax * 0.35, sky - 0.3, 0.75);
    g.fillStyle(GREEN, clamp01(eyeA));            // grave-green points
    g.fillCircle(skx - 0.95 + ax * 0.35, sky - 0.3, 0.38);
    g.fillCircle(skx + 0.95 + ax * 0.35, sky - 0.3, 0.38);
    g.fillStyle(boneDark, 1);                     // nasal notch
    g.fillRect(skx + ax * 0.35 - 0.25, sky + 0.5, 0.5, 0.7);

    if (!upScreen) drawRapier();
}
