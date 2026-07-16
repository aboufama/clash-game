import type Phaser from 'phaser';

type G = Phaser.GameObjects.Graphics;

/**
 * GOBLIN PLUNDERER — DESIGN C — "The Overloaded Sprinter"
 *
 * The SACK is the silhouette. A huge lumpy loot sack slung over one shoulder,
 * nearly the goblin's own size; under it a scrawny hunched pipe-cleaner of a
 * goblin — spindly legs, oversized bare feet, huge ears, long pointy nose,
 * manic grin. All sack, no muscle: the loot looks like it's winning.
 *
 * MOTION (all deterministic f(time) — iron rule 3):
 *  - WALK  = manic sprint on ONE exact 240 ms stride. Legs/arms swing at the
 *    stride, the sack bounces on a lagged stride harmonic, ears flap, and
 *    coins spill from a loose seam in 3 looping lanes (per-lane phase offsets,
 *    each lane closes exactly once per stride so the baked walk loop closes).
 *  - IDLE  = declared period P = 2000 ms (250 ms multiple). Every term is a
 *    function of (time % P): a shifty two-way glance (harmonics 1+2, head
 *    displaces ~±1.7 px — over the 1.5 px probe floor) and one sharp sack
 *    hitch per period (smooth pulse, sack hoists 2.6 px).
 *  - ATTACK (delay 700) = frantic one-hand sack-swat: wind-up coils the sack
 *    back-and-up behind him (last 260 ms before the damage tick), the swat
 *    whips it forward-down through the tick (~90 ms sweep), coins burst on
 *    impact, and he lunges after it comically. The free hand GRABS toward the
 *    target the whole time — greed over technique.
 *
 * LEVELS (material progression, gold only as accents):
 *  L1 rag hood + rope belt + patched burlap sack
 *  L2 stitched leather cap + iron-buckle belt + leather strap on the sack
 *  L3 dark leather hood with a thin gold band + brass buckle + gold
 *     drawstring; one gold tooth in the grin. No white masses.
 *
 * Direction: facingAngle is a screen-space heading. The body leans into it,
 * the nose/face shift toward it, the sack hangs OPPOSITE it, and layering
 * (sack in front of / behind the body) is decided from the sack's actual
 * screen position, so all 8 baked headings read correctly.
 *
 * No translucency in the body — the only sub-1 alpha is the contact shadow
 * (the shared troop convention). Coin glints are opaque brighter shapes.
 */

const PI2 = Math.PI * 2;

/** ONE exact stride period (ms) — the bake TROOP_PARAMS entry must match. */
const STRIDE_MS = 240;
/** Declared idle period (ms) — exact 250 ms multiple, all idle terms close on it. */
const IDLE_MS = 2000;

/** Coin-spill lanes: per-lane phase offset (fraction of stride) + side spread. */
const COIN_LANE_OFF = [0.0, 0.37, 0.71];
const COIN_LANE_SIDE = [-1.1, 0.4, 1.2];

function clamp01(v: number): number {
    return v < 0 ? 0 : v > 1 ? 1 : v;
}

function easeOut(t: number): number {
    return 1 - (1 - t) * (1 - t);
}

/** Multiply a 0xRRGGBB colour toward dark (m<1) or light (m>1). */
function shade(c: number, m: number): number {
    const r = Math.max(0, Math.min(255, Math.round(((c >> 16) & 0xff) * m)));
    const g = Math.max(0, Math.min(255, Math.round(((c >> 8) & 0xff) * m)));
    const b = Math.max(0, Math.min(255, Math.round((c & 0xff) * m)));
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

/** Attack-cycle state locked to the damage tick (the TroopRenderer contract):
 *  wind-up ramps over the last `windupMs` BEFORE the tick, strike decays over
 *  the first `strikeMs` after it; stale ages free-run on time % delay. */
function atkState(time: number, attackAge: number, attackDelay: number, windupMs: number, strikeMs: number):
    { windup: number; strike: number; age: number; inCombat: boolean } {
    if (attackAge < 0 || attackDelay <= 0) return { windup: 0, strike: 0, age: Infinity, inCombat: false };
    let age = attackAge;
    if (age > attackDelay + 600) age = ((time % attackDelay) + attackDelay) % attackDelay;
    const remaining = attackDelay - age;
    let windup = 0;
    if (remaining <= 0) windup = 1;
    else if (remaining <= windupMs) windup = 1 - remaining / windupMs;
    const strike = strikeMs > 0 && age <= strikeMs ? 1 - age / strikeMs : 0;
    return { windup, strike, age, inCombat: true };
}

/** Per-slot bake-param overrides (DesignRegistry.designBakeParams): authored
 *  periods that differ from the TROOP_PARAMS row (600/200/120, no idleMs).
 *  delay 700 = the runtime TroopDefinitions attackDelay; windup/strike per
 *  the atkState(…, 260, 160) call; idle closes on IDLE_MS = 2000. */
export const PARAMS: import('./DesignRegistry').DesignParamsExport = {
    goblinplunderer: { delay: 700, windup: 260, strike: 160, idleMs: 2000 },
};

export function drawGoblinplundererC(
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
    const fa = facingAngle || 0;
    const ax = Math.cos(fa);
    const ay = Math.sin(fa);
    const L2 = troopLevel >= 2;
    const L3 = troopLevel >= 3;

    // ------------------------------ palette ------------------------------
    const skin = isPlayer ? 0x7ec850 : 0x69a542;
    const skinDark = shade(skin, 0.68);
    const skinLite = shade(skin, 1.18);
    const rag = isPlayer ? 0x7a5f38 : 0x7a452e;      // loincloth / sash / L1 hood
    const ragDark = shade(rag, 0.66);
    const hoodCol = L3 ? 0x54381f : L2 ? 0x7a4f28 : rag;
    const hoodDark = shade(hoodCol, 0.66);
    const sackCol = L3 ? 0x9c7748 : L2 ? 0x92703f : 0x886539;
    const sackDark = shade(sackCol, 0.66);
    const sackLite = shade(sackCol, 1.22);
    const sackRim = shade(sackCol, 0.46);
    const gold = 0xdaa520;
    const goldLite = 0xffd700;

    // ------------------------------ the rig ------------------------------
    let swing = 0;      // leg/arm scissor (walk)
    let lift = 0;       // body hop / breath rise
    let ph = 0;         // 0..1 walk phase
    let headDart = 0;   // idle shifty glance (px)
    let hitch = 0;      // idle sack hoist pulse (px)
    let shiftX = 0;     // idle weight shuffle (px)
    if (isMoving) {
        ph = (((time % STRIDE_MS) + STRIDE_MS) % STRIDE_MS) / STRIDE_MS;
        const s = Math.sin(ph * PI2);
        swing = s * 2.6;
        lift = Math.abs(s) * 1.6;
    } else {
        const t01 = (((time % IDLE_MS) + IDLE_MS) % IDLE_MS) / IDLE_MS;
        // Two-way shifty glance: harmonics 1 + 2 of P make an asymmetric dart
        // (peak head displacement ≈ ±1.7 px — over the 1.5 px probe floor).
        headDart = (Math.sin(t01 * PI2) + 0.5 * Math.sin(t01 * PI2 * 2)) * 1.15;
        // One sharp sack hoist per period (P-periodic smooth pulse, 2.6 px).
        const hp = Math.max(0, Math.sin(t01 * PI2 - 2.4));
        hitch = hp * hp * hp * hp * hp * 2.6;
        lift = Math.max(0, Math.sin(t01 * PI2 * 2)) * 0.5 + hitch * 0.3;
        shiftX = Math.sin(t01 * PI2) * 0.5;
    }

    const atk = atkState(time, attackAge, attackDelay || 700, 260, 160);

    // Attack drivers: sw = sack pendulum (-1 wound back … 0 rest … 1 slammed
    // forward), lunge = body pitch after the swat, grab = free-hand greed,
    // squash = sack impact deform, burstAge = ms since impact (coin burst).
    let sw = 0, lunge = 0, grab = 0, squash = 0, burstAge = -1;
    if (!isMoving && atk.inCombat) {
        if (atk.strike > 0) {
            const t = clamp01(atk.age / 90);
            sw = -1 + 2 * easeOut(t);
            lunge = 2.2 * easeOut(t);
            grab = 1 - clamp01(atk.age / 160);
            squash = 1 - clamp01(atk.age / 130);
            // Coin burst waits for the sack to LAND (~55 ms into the sweep).
            burstAge = atk.age - 55;
        } else if (atk.windup > 0) {
            sw = -easeOut(atk.windup);
            lunge = -1.4 * atk.windup;
            grab = easeOut(atk.windup);
        } else if (atk.age <= 560) {
            const t = clamp01((atk.age - 160) / 400);
            sw = 1 - easeOut(t);
            lunge = 2.2 * (1 - easeOut(t));
            burstAge = atk.age - 55;
        }
    }

    // ------------------------- anchor geometry ---------------------------
    const leanAmt = (isMoving ? 1.9 : 0.5) + lunge;   // hunched, more when sprinting
    const lean = ax * leanAmt + shiftX;
    const leanY = ay * leanAmt * 0.4;

    const tx = lean * 0.8;                 // hip/torso centre x
    const ty = -1.6 - lift + leanY;        // hip/torso centre y
    const chestX = tx + ax * 1.5;
    const chestY = ty - 1.9;
    const hx = tx + ax * 2.5 + headDart + (isMoving ? Math.sin(ph * PI2 * 2 + 0.7) * 0.4 : 0);
    const hy = -6.2 - lift + ay * 0.9;     // head centre (hunched: low, thrust)
    const shX = tx - ax * 0.9;             // sack shoulder pivot
    const shY = -4.4 - lift + leanY;

    // Sack pendulum position: rest hangs BEHIND the heading; the swat swings
    // it through to the front. Blend three poses by the sw driver. (The rest
    // hang sits LOW when facing the viewer so the sack never halos the head.)
    const restOX = -ax * 4.0, restOY = -ay * 1.2 + 2.1;
    const backOX = -ax * 6.4, backOY = -ay * 3.2 - 2.4;
    const frontOX = ax * 6.8, frontOY = ay * 3.4 + 2.8;
    let sackOX: number, sackOY: number;
    if (sw < 0) {
        sackOX = restOX + (backOX - restOX) * -sw;
        sackOY = restOY + (backOY - restOY) * -sw;
    } else {
        sackOX = restOX + (frontOX - restOX) * sw;
        sackOY = restOY + (frontOY - restOY) * sw;
    }
    const sackBounce = isMoving ? Math.sin(ph * PI2 - 1.1) * 1.5 : hitch;
    const scx = shX + sackOX;
    const scy = shY + sackOY - sackBounce;
    const srx = 4.8 * (1 + 0.28 * squash);   // sack radii (impact squash)
    const sry = 5.4 * (1 - 0.24 * squash);
    // Neck of the sack reaches back toward the gripping fist at the shoulder.
    const nkx = scx + (shX - scx) * 0.72;
    const nky = scy + (shY - scy) * 0.72;

    // Painter's order for the sack: lower on screen than the torso => in front.
    const sackFront = scy > ty;

    const drawSack = (): void => {
        // Rim (dark silhouette ring) -> body -> lumps -> NW highlight.
        g.fillStyle(sackRim, 1);
        g.fillEllipse(scx, scy, srx * 2 + 1.6, sry * 2 + 1.6);
        g.fillStyle(sackDark, 1);
        g.fillEllipse(scx + 0.5, scy + 0.7, srx * 2, sry * 2);
        g.fillStyle(sackCol, 1);
        g.fillEllipse(scx - 0.5, scy - 0.4, srx * 1.8, sry * 1.8);
        // Coin-shaped lumps straining the cloth near the bottom.
        g.fillStyle(sackCol, 1);
        g.fillCircle(scx - srx * 0.42, scy + sry * 0.42, 1.8);
        g.fillCircle(scx + srx * 0.44, scy + sry * 0.5, 1.6);
        g.fillStyle(sackLite, 1);
        g.fillEllipse(scx - srx * 0.3, scy - sry * 0.42, 3.6, 2.4);
        if (!L2) {
            // L1: big square patch, crude stitches.
            g.fillStyle(shade(sackCol, 0.8), 1);
            g.fillRect(scx + 0.4, scy + 0.6, 2.8, 2.5);
            g.fillStyle(sackDark, 1);
            g.fillRect(scx + 0.2, scy + 1.5, 0.7, 0.5);
            g.fillRect(scx + 3.0, scy + 2.0, 0.7, 0.5);
        } else {
            // L2+: leather strap girdling the bulge (+ buckle; brass at L3).
            limb(g, 0x5b3a1c, scx - srx * 0.82, scy + 1.6, scx + srx * 0.82, scy - 0.2, 1.5);
            g.fillStyle(L3 ? gold : 0x8a8f99, 1);
            g.fillRect(scx - 0.8, scy + 0.1, 1.7, 1.7);
            g.fillStyle(sackDark, 1);
            g.fillRect(scx - 0.3, scy + 0.6, 0.7, 0.7);
        }
        // Tied neck reaching to the fist: tapered throat + cord + tuft.
        limb(g, sackDark, scx, scy - sry * 0.3, nkx, nky, 3.4);
        limb(g, sackCol, scx, scy - sry * 0.32, nkx + (scx - nkx) * 0.12, nky + (scy - nky) * 0.12, 2.4);
        const cordPX = -(scy - nky), cordPY = (scx - nkx); // perp to the throat
        const cpl = Math.hypot(cordPX, cordPY) || 1;
        g.fillStyle(L3 ? gold : 0x9c8a5a, 1);
        limb(g, L3 ? gold : 0x9c8a5a,
            nkx - (cordPX / cpl) * 1.7, nky - (cordPY / cpl) * 1.7,
            nkx + (cordPX / cpl) * 1.7, nky + (cordPY / cpl) * 1.7, 1.0);
        // Cloth tuft above the tie.
        g.fillStyle(sackCol, 1);
        g.fillTriangle(nkx - 1.2, nky - 0.6, nkx + 1.2, nky - 0.6, nkx + (nkx - scx) * 0.35, nky + (nky - scy) * 0.35 - 1.4);
        if (L3) {
            // Gold drawstring tassel — a small accent, not a mass.
            g.fillStyle(goldLite, 1);
            g.fillCircle(nkx + (cordPX / cpl) * 1.9, nky + (cordPY / cpl) * 1.9 + 0.8, 0.6);
        }
        // A coin edge or two peeking from the throat.
        g.fillStyle(gold, 1);
        g.fillEllipse(nkx + (scx - nkx) * 0.35, nky + (scy - nky) * 0.35, 1.6, 1.0);
        if (L2) {
            g.fillStyle(goldLite, 1);
            g.fillEllipse(nkx + (scx - nkx) * 0.5 + 0.9, nky + (scy - nky) * 0.5 + 0.3, 1.3, 0.9);
        }
        // Jingle sparkle while sprinting: an opaque glint that pops twice per
        // stride (draw gated on a stride harmonic — loops exactly).
        if (isMoving) {
            const tw = Math.sin(ph * PI2 * 2 + 1.7);
            if (tw > 0.2) {
                g.fillStyle(tw > 0.75 ? 0xfff3c4 : goldLite, 1);
                g.fillCircle(scx + srx * 0.34, scy - sry * 0.18, 0.6);
            }
        }
    };

    // ---------------------------- 1. shadow ------------------------------
    g.fillStyle(0x000000, 0.22);
    g.fillEllipse(lean * 0.4, 9.6, 10.5, 4);

    // ------------------- 2. sack behind the body -------------------------
    if (!sackFront) drawSack();

    // ---------------------------- 3. legs --------------------------------
    // Spindly shins, oversized bare feet slapping the ground.
    const spread = 1.5 + (!isMoving && atk.windup > 0 ? 0.5 * atk.windup : 0);
    const legLX = -spread - 0.8 - swing, legRX = spread - 0.8 + swing;
    g.fillStyle(skinDark, 1);
    g.fillRect(legLX, 3.6 - lift, 1.6, 5.6 + lift);
    g.fillRect(legRX, 3.6 - lift, 1.6, 5.6 + lift);
    g.fillStyle(skin, 1);
    g.fillEllipse(legLX + 0.8 + ax * 0.9, 9.2, 3.6, 1.8);
    g.fillEllipse(legRX + 0.8 + ax * 0.9, 9.2, 3.6, 1.8);

    // ----------------------- 4. loincloth + torso ------------------------
    // Skinny hunched trunk FIRST: hip ball + chest ball thrust toward the
    // heading — the scrawny green body must read, so clothing stays minimal.
    g.fillStyle(skin, 1);
    g.fillCircle(tx, ty, 2.9);
    g.fillCircle(chestX, chestY, 2.7);
    g.fillStyle(skinLite, 1);
    g.fillEllipse(chestX - 0.9, chestY - 1.0, 2.6, 1.8);   // NW light on the shoulders
    g.fillStyle(skinDark, 1);
    g.fillEllipse(tx + 1.0, ty + 1.2, 2.6, 1.6);           // pot-belly shade
    // Two rib ticks — all sack, no muscle.
    g.fillStyle(skinDark, 1);
    g.fillRect(chestX + ax * 1.2 - 0.8, chestY + 0.6, 1.6, 0.45);
    g.fillRect(chestX + ax * 1.0 - 0.7, chestY + 1.5, 1.4, 0.45);
    // Small ragged loincloth at the hip.
    g.fillStyle(ragDark, 1);
    g.fillRect(tx - 2.2, 2.6 - lift, 4.4, 1.9);
    g.fillStyle(rag, 1);
    g.fillTriangle(tx - 1.3, 4.4 - lift, tx + 1.3, 4.4 - lift, tx + shiftX * 0.6, 6.1 - lift);
    // Belt: rope L1, leather + iron buckle L2, brass at L3.
    g.fillStyle(L2 ? 0x5b3a1c : 0x9c8a5a, 1);
    g.fillRect(tx - 2.4, 1.9 - lift, 4.8, 0.9);
    if (L2) {
        g.fillStyle(L3 ? gold : 0x8a8f99, 1);
        g.fillRect(tx - 0.6, 1.75 - lift, 1.2, 1.3);
    }

    // ------------------------------ 5. head ------------------------------
    // Ears first (they sprout under the hood), then skull, hood, face.
    const earFlap = isMoving ? Math.sin(ph * PI2 - 0.9) * 1.0 : hitch * 0.4 + headDart * 0.25;
    g.fillStyle(skin, 1);
    g.fillTriangle(hx - 2.0, hy - 0.5, hx - 1.5, hy + 1.0, hx - 5.2 - ax * 0.9, hy - 2.2 - earFlap);
    g.fillTriangle(hx + 2.0, hy - 0.5, hx + 1.5, hy + 1.0, hx + 5.2 - ax * 0.9, hy - 2.2 + earFlap * 0.6);
    g.fillStyle(skinDark, 1);
    g.fillTriangle(hx - 2.0, hy - 0.3, hx - 1.7, hy + 0.6, hx - 3.9 - ax * 0.7, hy - 1.5 - earFlap * 0.8);
    g.fillTriangle(hx + 2.0, hy - 0.3, hx + 1.7, hy + 0.6, hx + 3.9 - ax * 0.7, hy - 1.5 + earFlap * 0.5);
    // Skull.
    g.fillStyle(skin, 1);
    g.fillCircle(hx, hy, 2.7);
    // Hood/cap.
    g.fillStyle(hoodDark, 1);
    g.beginPath();
    g.arc(hx, hy - 0.6, 3.1, Math.PI, 0, false);
    g.closePath();
    g.fillPath();
    g.fillStyle(hoodCol, 1);
    g.beginPath();
    g.arc(hx, hy - 0.9, 2.7, Math.PI, 0, false);
    g.closePath();
    g.fillPath();
    // Brim band; stitches at L2; a thin gold line at L3 (accent only).
    g.fillStyle(hoodDark, 1);
    g.fillRect(hx - 2.9, hy - 1.2, 5.8, 0.9);
    if (L3) {
        g.fillStyle(gold, 1);
        g.fillRect(hx - 2.7, hy - 1.05, 5.4, 0.5);
    } else if (L2) {
        g.fillStyle(0xc9b48a, 1);
        g.fillRect(hx - 2.1, hy - 1.0, 0.6, 0.5);
        g.fillRect(hx - 0.3, hy - 1.0, 0.6, 0.5);
        g.fillRect(hx + 1.5, hy - 1.0, 0.6, 0.5);
    }
    // Hood tail flopping behind the heading (rag: long + ragged; L2 folded
    // point; L3 neat point with a gold tip bead).
    const tailSway = isMoving ? Math.sin(ph * PI2 - 1.4) * 1.3 : headDart * 0.45;
    const tailLen = L2 ? 3.4 : 4.6;
    const tipX = hx - ax * tailLen - 0.4 + tailSway;
    const tipY = hy - 3.4 - (isMoving ? lift * 0.3 : hitch * 0.25) + ay * 0.8;
    g.fillStyle(hoodCol, 1);
    g.fillTriangle(hx - ax * 1.0 - 1.1, hy - 2.6, hx - ax * 1.0 + 1.1, hy - 2.6, tipX, tipY);
    if (!L2) {
        // Ragged notch bitten out of the rag tail.
        g.fillStyle(hoodDark, 1);
        g.fillTriangle(tipX + ax * 1.4, tipY + 0.7, tipX + ax * 2.4, tipY + 1.3, tipX + ax * 2.2, tipY - 0.1);
    } else if (L3) {
        g.fillStyle(goldLite, 1);
        g.fillCircle(tipX, tipY, 0.55);
    }
    // Face — only when the heading shows it (hidden facing up-screen).
    if (ay > -0.55) {
        const ex = hx + ax * 0.8;
        const ey = hy - 0.1;
        const pdx = Math.max(-1, Math.min(1, headDart)) * 0.45 + ax * 0.28;
        g.fillStyle(0xfff3c4, 1);
        g.fillCircle(ex - 1.05, ey, 0.85);
        g.fillCircle(ex + 1.05, ey, 0.85);
        g.fillStyle(0x22300e, 1);
        g.fillCircle(ex - 1.05 + pdx, ey + 0.1, 0.42);
        g.fillCircle(ex + 1.05 + pdx, ey + 0.1, 0.42);
        // Manic grin FIRST: dark gash + snaggle teeth (one gold at L3)...
        g.fillStyle(0x2c1c10, 1);
        g.fillRect(ex - 1.3 + ax * 0.5, ey + 1.6, 2.6, 0.8);
        g.fillStyle(0xf2ead6, 1);
        g.fillRect(ex - 0.8 + ax * 0.5, ey + 1.65, 0.6, 1.0);
        g.fillStyle(L3 ? goldLite : 0xf2ead6, 1);
        g.fillRect(ex + 0.5 + ax * 0.5, ey + 1.65, 0.6, 1.0);
        // ...then the long pointy snout OVERHANGS it toward the heading.
        g.fillStyle(skin, 1);
        g.fillTriangle(ex - 0.5, ey + 0.6, ex + 0.5, ey + 1.5, ex + ax * 3.7, ey + 1.4 + ay * 1.1);
        g.fillStyle(skinDark, 1);
        g.fillTriangle(ex + 0.0, ey + 1.3, ex + 0.5, ey + 1.5, ex + ax * 3.7, ey + 1.4 + ay * 1.1);
    }

    // ------------------- 6. sack in front of the body --------------------
    if (sackFront) drawSack();

    // ------------------------- 7. the two arms ---------------------------
    // Grip arm: shoulder to the sack throat, fist clenched on the tie.
    limb(g, skin, chestX - ax * 0.6, chestY - 0.6, nkx, nky, 1.6);
    g.fillStyle(skin, 1);
    g.fillCircle(nkx, nky, 1.25);
    g.fillStyle(skinDark, 1);
    g.fillCircle(nkx + 0.35, nky + 0.35, 0.55);
    // Free arm: greedy grab in combat, flail on the sprint, coin-fondling idle.
    if (grab > 0.02) {
        const gx = chestX + ax * (2.6 + 3.6 * grab);
        const gy = chestY + 0.6 + ay * (1.4 + 2.0 * grab);
        limb(g, skin, chestX + ax * 0.8, chestY + 0.4, gx, gy, 1.5);
        g.fillStyle(skin, 1);
        g.fillCircle(gx, gy, 1.15);
        // Grasping finger nubs.
        g.fillCircle(gx + ax * 1.0 - 0.5, gy + ay * 0.6 - 0.3, 0.5);
        g.fillCircle(gx + ax * 1.0 + 0.5, gy + ay * 0.6 + 0.3, 0.5);
    } else if (isMoving) {
        const fx = chestX + ax * (0.6 - swing * 0.9);
        const fy = chestY + 1.6 + ay * (-swing * 0.5) - Math.abs(swing) * 0.3;
        limb(g, skin, chestX + ax * 0.8, chestY + 0.4, fx, fy, 1.5);
        g.fillStyle(skin, 1);
        g.fillCircle(fx, fy, 1.1);
    } else {
        // Idle: the free hand hangs low, fingers drumming on the thigh
        // (sway rides the same declared idle period via shiftX/hitch).
        const fx = chestX + ax * 1.8 + 1.2 + shiftX * 0.5;
        const fy = ty + 2.6 - hitch * 0.25;
        limb(g, skin, chestX + ax * 0.8, chestY + 0.8, fx, fy, 1.5);
        g.fillStyle(skin, 1);
        g.fillCircle(fx, fy, 1.05);
    }

    // ---------------- 8. coins — spill lanes + impact burst ---------------
    if (isMoving) {
        // Three lanes from the loose seam; each closes exactly once per stride.
        const spillX = scx - ax * 1.0;
        const spillY = scy + sry * 0.62;
        const tt = time / STRIDE_MS;
        for (let i = 0; i < 3; i++) {
            const p = (((tt + COIN_LANE_OFF[i]) % 1) + 1) % 1;
            if (p >= 0.8) continue; // gap before the lane re-loops
            const t = p / 0.8;
            const side = COIN_LANE_SIDE[i];
            const pxo = -ay * side, pyo = ax * side * 0.5;
            const cxp = spillX - ax * 6.5 * t + pxo * (0.3 + 0.5 * t);
            const cyp = spillY - 2.0 * t + 7.5 * t * t + pyo * (0.3 + 0.5 * t);
            const w = 0.6 + 1.4 * Math.abs(Math.cos(t * 6.0 + i * 2.1)); // tumble
            g.fillStyle(0x7a5a14, 1);
            g.fillEllipse(cxp, cyp + 0.2, w + 0.5, 1.5);
            g.fillStyle(t < 0.5 ? goldLite : gold, 1);
            g.fillEllipse(cxp, cyp, w, 1.2);
        }
    }
    if (burstAge >= 0 && burstAge <= 240) {
        // Impact burst at the swat's landing point.
        const bt = burstAge / 240;
        const ix = shX + ax * 7.6;
        const iy = shY + ay * 3.8 + 2.6;
        for (let i = 0; i < 5; i++) {
            const bang = i * (PI2 / 5) + 0.5;
            const br = 1.5 + easeOut(bt) * 5.5;
            const cxp = ix + Math.cos(bang) * br;
            const cyp = iy + Math.sin(bang) * br * 0.55 + bt * bt * 4.5;
            g.fillStyle(i % 2 ? goldLite : gold, 1);
            g.fillEllipse(cxp, cyp, 1.8 - bt * 0.7, 1.3 - bt * 0.5);
        }
        if (burstAge < 80) {
            // Comic "clonk" star (opaque — no translucency).
            g.fillStyle(0xfff3c4, 1);
            g.fillTriangle(ix - 1.8, iy, ix + 1.8, iy, ix, iy - 2.2);
            g.fillTriangle(ix - 1.8, iy - 1.4, ix + 1.8, iy - 1.4, ix, iy + 1.0);
        }
    }
    // Whoosh dashes trailing the swat (opaque pale streaks, strike only).
    if (sw > 0.2 && atk.strike > 0) {
        g.fillStyle(0xefe4c0, 1);
        for (let i = 1; i <= 2; i++) {
            const k = sw - i * 0.3;
            if (k <= -1) continue;
            let dox: number, doy: number;
            if (k < 0) {
                dox = restOX + (backOX - restOX) * -k;
                doy = restOY + (backOY - restOY) * -k;
            } else {
                dox = restOX + (frontOX - restOX) * k;
                doy = restOY + (frontOY - restOY) * k;
            }
            g.fillEllipse(shX + dox, shY + doy - sackBounce, 2.0, 0.9);
        }
    }
}
