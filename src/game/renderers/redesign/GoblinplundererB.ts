import type Phaser from 'phaser';

/**
 * GOBLIN PLUNDERER — design B: "The Overloaded Purse-Rat".
 *
 * Concept: the sack IS the silhouette. A scrawny, hunched goblin (skin
 * 0x7ec850) is dwarfed by one enormous burlap loot sack humped over his back
 * shoulder — a lumpy coin-stuffed moon that bounces out of phase with his
 * manic 240 ms sprint while gold coins jingle loose in a deterministic arc
 * behind him. He is visibly a terrible fighter: his attack is a frantic
 * one-hand sack-swat — the whole sack cartwheels overhead, flattens on
 * impact, coughs out a burst of coins, and he flails his free arm for
 * balance while it drags itself back onto his shoulder.
 *
 * Motion contract (bake-safe, iron rule 3 — every term is f(time)):
 *  - WALK: ONE exact stride period, STRIDE_MS = 240 (the fastest gait in the
 *    roster). All walk terms are harmonics of it (leg scissor, hop, sack
 *    jounce at +0.18 phase lag, the 2-coin spill cycle, 3rd-harmonic ground
 *    twinkles), so a 6-frame bake loops seamlessly.
 *  - IDLE: declared period IDLE_MS = 2000 (250 ms multiple). Terms: breath
 *    (H1), ear droop-sway (H1), shifty two-stop head dart (piecewise-smooth,
 *    exactly 2000-periodic, ±1.6 px), grabby finger twitch (H4 = 500 ms),
 *    mouth-coin glint gate (H2), and ONE sack hitch per loop (2.3 px pop at
 *    phase 0.84-0.98) — comfortably past the probe's 1.5 px / 1% thresholds.
 *  - ATTACK: delay 700 (TROOP_DEFINITIONS), WINDUP_MS = 200 hauls the sack
 *    back-and-up, the swat sweeps a quadratic arc overhead in the first
 *    ~70 ms after the tick, STRIKE_MS = 120 owns the impact squash + coin
 *    burst, then a 350 ms recovery drags the sack back along the same arc.
 *
 * Direction: fully facing-aware via the iso toolkit (F(d,w,h): along-aim,
 * across-aim, vertical — sin×0.5 squash). The sack rides opposite the
 * facing and layer-flips in front of the body when he runs up-screen
 * (sin(fa) < 0); ears sweep back at fa±2.05; face features gate out on
 * hard away-facings. Levels: L1 patched rag hood + rope-tied sack →
 * L2 leather cap + strap and brass buckle + owner bandana → L3 oiled
 * leather, gold hat-band, earring, drawstring and seam-stitch ACCENTS only.
 *
 * NO translucency in the body: every fill is alpha 1 (the 0.22 contact
 * shadow is the roster-wide grounding convention); coins/glints are opaque.
 */

type G = Phaser.GameObjects.Graphics;

const STRIDE_MS = 240; // exact sprint period — TROOP_PARAMS.stride must match
const IDLE_MS = 2000; // declared idle period (250 ms multiple)
const WINDUP_MS = 200; // sack haul-back before the damage tick
const STRIKE_MS = 120; // impact squash + coin burst after the tick
const SWAT_MS = 70; // the swat itself sweeps the arc in the first 70 ms
const RECOVER_MS = 350; // sack drags back onto the shoulder

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);
const easeOut = (t: number): number => 1 - (1 - t) * (1 - t);
const smooth = (t: number): number => t * t * (3 - 2 * t);
const mod = (v: number, m: number): number => ((v % m) + m) % m;

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

/** Attack-cycle state locked to the damage tick (the TroopRenderer contract:
 *  wind-up peaks exactly when damage fires; stale replay ages free-run). */
function attackState(time: number, attackAge: number, attackDelay: number): { windup: number; strike: number; age: number; inCombat: boolean } {
    if (attackAge < 0 || attackDelay <= 0) return { windup: 0, strike: 0, age: Infinity, inCombat: false };
    let age = attackAge;
    if (age > attackDelay + 600) age = mod(time, attackDelay);
    const remaining = attackDelay - age;
    let windup = 0;
    if (remaining <= 0) windup = 1;
    else if (remaining <= WINDUP_MS) windup = 1 - remaining / WINDUP_MS;
    const strike = age <= STRIKE_MS ? 1 - age / STRIKE_MS : 0;
    return { windup, strike, age, inCombat: true };
}

/** Shifty look-around: hold centre → snap LEFT (hold) → snap RIGHT (hold) →
 *  centre, exactly once per idle loop. Returns -1..1, exactly P-periodic. */
function dartCurve(p: number): number {
    const seg = (a: number, b: number): number => clamp01((p - a) / (b - a));
    let v = 0;
    v -= smooth(seg(0.10, 0.16)) - smooth(seg(0.38, 0.44)); // dart left, hold, back
    v += smooth(seg(0.52, 0.58)) - smooth(seg(0.78, 0.84)); // dart right, hold, back
    return v;
}

export function drawGoblinplundererB(
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
    const dxF = Math.cos(fa);
    const dyF = Math.sin(fa);
    /** Iso placement: d = along facing, w = across facing, h = vertical. */
    const F = (d: number, w: number, h: number): [number, number] =>
        [dxF * d - dyF * w, (dyF * d + dxF * w) * 0.5 + h];

    // ---------------- palette ----------------
    const skin = isPlayer ? 0x7ec850 : 0x69ad43;
    const skinDk = shade(skin, 0.66);
    const cloth = isPlayer ? 0x46647e : 0x94402e; // owner ID: rag tunic / hood / bandana
    const clothDk = isPlayer ? 0x30475c : 0x682c1f;
    const sackBody = shade(0x93714a, isPlayer ? 1 : 0.9);
    const sackDk = shade(0x6b4e2f, isPlayer ? 1 : 0.9);
    const sackLt = shade(0xa9895f, isPlayer ? 1 : 0.9);
    const gold = 0xffd700;
    const goldDk = 0xdaa520;
    const leather = troopLevel >= 3 ? 0x4a3320 : 0x6b4526;

    // ---------------- rigs ----------------
    const iph = mod(time, IDLE_MS) / IDLE_MS; // idle phase 0..1 (P = 2000 ms)
    let ph = 0, swing = 0, lift = 0;
    if (isMoving) {
        ph = mod(time, STRIDE_MS) / STRIDE_MS;
        const s = Math.sin(ph * Math.PI * 2);
        swing = s * 3.4; // manic scissor
        lift = Math.abs(s) * 1.5; // sprint hop
    } else {
        lift = Math.max(0, Math.sin(iph * Math.PI * 2)) * 0.5; // breath (H1)
    }

    const atk = attackState(time, attackAge, attackDelay > 0 ? attackDelay : 700);
    const fight = !isMoving && atk.inCombat;

    // Attack drivers: swat = 0..1 travel along the overhead arc.
    let swat = 0, squash = 0, haul = 0;
    let lean = isMoving ? 2.0 : 0; // sprint hunch, along facing
    if (fight) {
        if (atk.strike > 0) {
            swat = easeOut(clamp01(atk.age / SWAT_MS));
            squash = atk.strike * swat; // flattens right as it lands
            lean = 2.0 * swat;
        } else if (atk.windup > 0) {
            haul = atk.windup;
            lean = -1.6 * haul; // rocks back under the hauled sack
        } else if (atk.age <= STRIKE_MS + RECOVER_MS) {
            const t = clamp01((atk.age - STRIKE_MS) / RECOVER_MS);
            swat = 1 - easeOut(t); // sack drags back along the same arc
            lean = 1.8 * swat;
        }
    }
    // Shifty idle only when he isn't mid-anything.
    const shifty = !isMoving && haul === 0 && swat === 0 && atk.strike === 0;
    const dart = shifty ? dartCurve(iph) : 0;
    const hitch = shifty ? Math.sin(clamp01((iph - 0.84) / 0.14) * Math.PI) : 0; // one sack pop per loop

    // ---------------- anchor points ----------------
    const groundY = 9.5;
    const crouch = haul * 0.9; // knees buckle under the hauled sack
    const headP = F(1.9 + lean * 0.45, dart * 1.6, -5.8 - lift * 1.05 + crouch);
    const torsoP = F(lean * 0.35, 0, -0.8 - lift + crouch);
    const shoulderP = F(lean * 0.3 - 0.8, 1.6, -2.7 - lift + crouch - hitch * 0.9); // sack shoulder (shrugs on the hitch)

    // Sack position: shoulder-slung at rest, hauled back on wind-up, a
    // quadratic overhead arc during the swat/recovery.
    const sackBounce = isMoving
        ? -Math.abs(Math.sin((ph + 0.18) * Math.PI * 2)) * 1.9 // loose jounce, lags the hop
        : -hitch * 2.3;
    const sackRX = 7.6, sackRY = 6.6; // radii — deliberately bigger than the body
    let sackPos: [number, number];
    let sqX = 1, sqY = 1;
    if (swat > 0) {
        const b0 = F(-5.0, 1.8, -9.3);
        const bc = F(1.2, 1.6, -14.6);
        const b2 = F(6.8, 0.6, 2.2);
        const t = swat, u = 1 - swat;
        sackPos = [
            u * u * b0[0] + 2 * u * t * bc[0] + t * t * b2[0],
            u * u * b0[1] + 2 * u * t * bc[1] + t * t * b2[1],
        ];
        sqX = 1 + 0.30 * squash;
        sqY = 1 - 0.34 * squash;
    } else {
        // On up-screen facings (back view) the sack hangs lower on his back
        // so the scalp + ears still peek over the top of the load.
        const droop = Math.max(0, -dyF) * 2.8;
        sackPos = F(-3.4 - haul * 1.7, 1.8, -7.0 + droop - lift * 0.6 - haul * 2.4 + sackBounce);
    }
    // Sack draws over the body when it's nearer the viewer: any up-screen
    // facing (back view), or while it swings overhead.
    const sackFront = swat > 0 || dyF < -0.05;

    // ---------------- contact shadow (grounding convention) ----------------
    const shP = F(-0.9, 0.6, 0);
    g.fillStyle(0x000000, 0.22);
    g.fillEllipse(shP[0] * 0.5, groundY + 0.1, 10.5, 4.0);

    // ================= the sack assembly =================
    const drawSack = (): void => {
        const sx = sackPos[0], sy = sackPos[1];
        const w = sackRX * 2 * sqX, h = sackRY * 2 * sqY;
        // dark under-body, lit top (NW light), lumpy coin bulges
        g.fillStyle(sackDk, 1);
        g.fillEllipse(sx, sy, w, h);
        g.fillStyle(sackBody, 1);
        g.fillEllipse(sx - 0.5, sy - 0.8, w * 0.9, h * 0.88);
        g.fillStyle(sackLt, 1);
        g.fillEllipse(sx - w * 0.14, sy - h * 0.2, w * 0.52, h * 0.42);
        // coin lumps punching the lower silhouette
        g.fillStyle(sackBody, 1);
        g.fillCircle(sx - w * 0.32, sy + h * 0.3, 2.0 * sqX);
        g.fillCircle(sx + w * 0.24, sy + h * 0.34, 1.7 * sqX);
        g.fillStyle(sackDk, 1);
        g.fillEllipse(sx - w * 0.05, sy + h * 0.36, w * 0.4, h * 0.16);
        // ---- level ornament (material progression on the sack itself)
        if (troopLevel === 1) {
            // crude patch + stitches
            g.fillStyle(shade(sackDk, 0.85), 1);
            g.fillRect(sx + w * 0.08, sy - h * 0.02, 3.4, 2.8);
            g.lineStyle(0.7, 0x3d2c17, 1);
            g.lineBetween(sx + w * 0.08 - 0.7, sy + 0.6, sx + w * 0.08 + 0.9, sy - 0.9);
            g.lineBetween(sx + w * 0.08 + 2.2, sy + h * 0.02 + 2.6, sx + w * 0.08 + 3.8, sy + h * 0.02 + 1.2);
        } else {
            // leather strap around the belly (L3: gold-edged)
            g.lineStyle(1.7, 0x54381f, 1);
            g.beginPath();
            g.arc(sx, sy - h * 0.06, sackRY * sqY * 0.96, Math.PI * 0.22, Math.PI * 0.78, false);
            g.strokePath();
            if (troopLevel >= 3) {
                g.lineStyle(0.7, goldDk, 1);
                g.beginPath();
                g.arc(sx, sy + 0.7 - h * 0.06, sackRY * sqY * 0.96, Math.PI * 0.26, Math.PI * 0.74, false);
                g.strokePath();
                // gold seam stitches on the lit face — accents, never masses
                g.lineStyle(0.7, goldDk, 1);
                g.lineBetween(sx - w * 0.3, sy - h * 0.3, sx - w * 0.22, sy - h * 0.38);
                g.lineBetween(sx - w * 0.12, sy - h * 0.4, sx - w * 0.04, sy - h * 0.46);
            } else {
                g.fillStyle(0xb08d57, 1); // brass buckle
                g.fillRect(sx - 0.9, sy + h * 0.38 - 0.9, 1.9, 1.9);
            }
        }
        // ---- gathered neck toward the clutch hand + rope/drawstring + coins
        const nvx = shoulderP[0] - sx, nvy = shoulderP[1] - sy;
        const nl = Math.hypot(nvx, nvy) || 1;
        const nx = sx + (nvx / nl) * sackRX * sqX * 0.86;
        const ny = sy + (nvy / nl) * sackRY * sqY * 0.86;
        // neck folds
        g.fillStyle(sackDk, 1);
        g.fillTriangle(nx - 1.7, ny + 1.3, nx + 1.7, ny + 1.1, nx + (nvx / nl) * 2.2, ny + (nvy / nl) * 2.2 - 0.3);
        g.fillStyle(sackBody, 1);
        g.fillCircle(nx, ny, 1.6);
        // tie: rope at L1-2, gold drawstring at L3
        g.lineStyle(1.1, troopLevel >= 3 ? goldDk : 0xc9b385, 1);
        g.lineBetween(nx - 1.6, ny - 0.5, nx + 1.6, ny + 0.5);
        // coins peeking from the mouth (greed on display; L3 shows one more)
        const mCoins = troopLevel >= 3 ? 3 : 2;
        for (let i = 0; i < mCoins; i++) {
            const ca = (i - (mCoins - 1) / 2) * 1.1;
            const cx = nx + Math.cos(ca) * 1.5 + (nvx / nl) * 1.2;
            const cy = ny - 1.2 + Math.sin(ca) * 0.6 + (nvy / nl) * 1.2;
            g.fillStyle(gold, 1);
            g.fillCircle(cx, cy, 0.85);
            g.fillStyle(0x8a6508, 1);
            g.fillCircle(cx + 0.15, cy + 0.15, 0.45);
        }
        // idle greed-glint: an opaque white spark, gated on H2 of the loop
        if (shifty && Math.sin(iph * Math.PI * 4) > 0.6) {
            g.fillStyle(0xfff6c0, 1);
            g.fillCircle(nx + 0.4, ny - 2.2, 0.5);
        }
        // swat motion streaks while the sack sweeps
        if (swat > 0.1 && swat < 0.98 && atk.strike > 0) {
            g.lineStyle(1.1, 0xf0e6c8, 0.85);
            const tb = Math.max(0, swat - 0.28), ub = 1 - tb;
            const b0 = F(-5.0, 1.8, -9.3), bc = F(1.2, 1.6, -14.6), b2 = F(6.8, 0.6, 2.2);
            const trx = ub * ub * b0[0] + 2 * ub * tb * bc[0] + tb * tb * b2[0];
            const trY = ub * ub * b0[1] + 2 * ub * tb * bc[1] + tb * tb * b2[1];
            g.lineBetween(trx, trY, sx - (sx - trx) * 0.25, sy - (sy - trY) * 0.25);
        }
    };

    // ---- running coin spill: two coins per stride arcing out behind, plus
    // ground twinkles on the 3rd harmonic — all close over ONE stride.
    const drawSpill = (): void => {
        if (!isMoving) return;
        for (let i = 0; i < 2; i++) {
            const cph = mod(ph + i * 0.5, 1);
            if (cph > 0.66) continue;
            const t = cph / 0.66;
            const cp = F(-3.2 - t * 5.5, 1.8 + (i === 0 ? -0.6 : 1.7), -10.4 + t * t * 13.5 - t * 3.0);
            g.fillStyle(gold, 1);
            g.fillCircle(cp[0], cp[1], 0.85);
            g.fillStyle(0xfff6c0, 1);
            g.fillCircle(cp[0] - 0.3, cp[1] - 0.3, 0.35);
        }
        const tw = Math.sin(ph * Math.PI * 6);
        if (tw > 0.3) {
            const tp = F(-8.5, 2.4, -0.4);
            g.fillStyle(goldDk, 1);
            g.fillCircle(tp[0], tp[1] + groundY, 0.7);
        }
        if (tw < -0.3) {
            const tp = F(-6.3, -1.4, -0.2);
            g.fillStyle(goldDk, 1);
            g.fillCircle(tp[0], tp[1] + groundY, 0.6);
        }
    };

    if (!sackFront) {
        drawSpill();
        drawSack();
    }

    // ================= legs — scrawny, bare, big-footed =================
    const sSin = Math.sin(ph * Math.PI * 2);
    const legLiftA = isMoving ? Math.max(0, sSin) * 2.6 : 0;
    const legLiftB = isMoving ? Math.max(0, -sSin) * 2.6 : 0;
    const spr = F(0, 2.0, 0);
    const swf = F(swing, 0, 0);
    // Standing: a shifty, uneven stance (one foot staggered forward) so the
    // two scrawny legs never merge into one; weight sways on H1 of the loop.
    const stag = isMoving ? F(0, 0, 0) : F(0.9, 0, 0);
    const idleShift = shifty ? Math.sin(iph * Math.PI * 2) * 0.5 : 0; // weight sway (H1)
    const hipA: [number, number] = [torsoP[0] + spr[0] * 0.45 + idleShift, torsoP[1] + spr[1] * 0.45 + 4.4];
    const hipB: [number, number] = [torsoP[0] - spr[0] * 0.45 + idleShift, torsoP[1] - spr[1] * 0.45 + 4.4];
    const footA: [number, number] = [spr[0] + swf[0] + stag[0], groundY - 0.3 + spr[1] + swf[1] + stag[1] - legLiftA];
    const footB: [number, number] = [-spr[0] - swf[0] - stag[0] * 0.7, groundY - 0.3 - spr[1] - swf[1] - stag[1] * 0.7 - legLiftB];
    limb(g, skinDk, hipB[0], hipB[1], footB[0], footB[1] - 0.4, 1.3);
    limb(g, skin, hipA[0], hipA[1], footA[0], footA[1] - 0.4, 1.3);
    // big flappy bare feet, toes toward the facing
    const toeA = F(1.6, 0, 0), toeB = F(1.6, 0, 0);
    g.fillStyle(skinDk, 1);
    g.fillEllipse(footB[0] + toeB[0] * 0.5, footB[1], 3.6, 1.7);
    g.fillStyle(skin, 1);
    g.fillEllipse(footA[0] + toeA[0] * 0.5, footA[1], 3.6, 1.7);

    // ================= torso — a ragged wisp under the load =================
    g.fillStyle(clothDk, 1);
    // ragged hem triangles
    g.fillTriangle(torsoP[0] - 3.0, torsoP[1] + 1.6, torsoP[0] - 1.2, torsoP[1] + 1.6, torsoP[0] - 2.2, torsoP[1] + 3.6);
    g.fillTriangle(torsoP[0] - 0.4, torsoP[1] + 1.8, torsoP[0] + 1.6, torsoP[1] + 1.8, torsoP[0] + 0.6, torsoP[1] + 3.9);
    g.fillTriangle(torsoP[0] + 1.6, torsoP[1] + 1.5, torsoP[0] + 3.1, torsoP[1] + 1.5, torsoP[0] + 2.6, torsoP[1] + 3.3);
    g.fillStyle(cloth, 1);
    g.fillEllipse(torsoP[0], torsoP[1], 6.6, 6.0);
    // hunched spine ridge toward the sack (he bends under it)
    g.fillStyle(clothDk, 1);
    const spine = F(-1.6, 0.9, 0);
    g.fillEllipse(torsoP[0] + spine[0], torsoP[1] + spine[1] - 1.6, 3.4, 2.6);
    // rope belt
    g.lineStyle(0.9, 0x8a744f, 1);
    g.lineBetween(torsoP[0] - 2.9, torsoP[1] + 1.4, torsoP[0] + 2.9, torsoP[1] + 1.1);

    // ================= head — ears, hood/cap, manic face =================
    const hx = headP[0], hy = headP[1];
    const earJig = isMoving ? lift * 0.5 : Math.sin(iph * Math.PI * 2) * 0.4;
    for (const sgn of [1, -1]) {
        const ea = fa + sgn * 2.05; // swept back off the facing
        const bax = hx + Math.cos(ea - 0.5) * 2.3, bay = hy + Math.sin(ea - 0.5) * 0.5 * 2.3;
        const bbx = hx + Math.cos(ea + 0.5) * 2.3, bby = hy + Math.sin(ea + 0.5) * 0.5 * 2.3;
        const tx = hx + Math.cos(ea) * 6.2, ty = hy + Math.sin(ea) * 0.5 * 6.2 - 1.7 + earJig;
        g.fillStyle(skin, 1);
        g.fillTriangle(bax, bay, bbx, bby, tx, ty);
        g.fillStyle(skinDk, 1);
        g.fillTriangle(bax * 0.35 + bbx * 0.65, bay * 0.35 + bby * 0.65, bbx, bby, tx * 0.9 + hx * 0.1, ty * 0.9 + hy * 0.1);
    }
    // skull
    g.fillStyle(skin, 1);
    g.fillCircle(hx, hy, 2.7);
    // ---- headgear by level
    if (troopLevel === 1) {
        // patched rag hood, slumped back off the brow, tattered tail behind
        const hbx = hx - dxF * 0.9, hby = hy - dyF * 0.45 - 0.7;
        g.fillStyle(clothDk, 1);
        g.fillCircle(hbx, hby, 3.2);
        g.fillStyle(cloth, 1);
        g.fillCircle(hbx - 0.3, hby - 0.5, 2.7);
        const flut = isMoving ? Math.sin(ph * Math.PI * 4) * 0.9 : Math.sin(iph * Math.PI * 4) * 0.35;
        const t0 = F(-2.6, 0.6, 0), t1 = F(-5.6, 1.2, 2.0);
        g.fillStyle(clothDk, 1);
        g.fillTriangle(hx + t0[0], hy + t0[1] - 1.2, hx + t0[0] + 1.2, hy + t0[1] + 0.2, hx + t1[0] + flut, hy + t1[1] + flut * 0.4);
    } else {
        // leather cap: dome + band; L3 oiled dark + gold band + earring
        g.fillStyle(shade(leather, 0.8), 1);
        g.beginPath();
        g.arc(hx, hy - 0.8, 3.1, Math.PI, 0, false);
        g.closePath();
        g.fillPath();
        g.fillStyle(leather, 1);
        g.beginPath();
        g.arc(hx - 0.2, hy - 1.0, 2.6, Math.PI, 0, false);
        g.closePath();
        g.fillPath();
        g.fillStyle(shade(leather, 0.72), 1);
        g.fillEllipse(hx, hy - 0.9, 6.4, 1.7);
        if (troopLevel >= 3) {
            g.lineStyle(0.8, goldDk, 1);
            g.lineBetween(hx - 2.9, hy - 0.9, hx + 2.9, hy - 0.9);
            const erx = hx + Math.cos(fa + 2.05) * 3.1, ery = hy + Math.sin(fa + 2.05) * 0.5 * 3.1 + 0.4;
            g.fillStyle(gold, 1);
            g.fillCircle(erx, ery, 0.8);
            g.fillStyle(0xfff6c0, 1);
            g.fillCircle(erx - 0.25, ery - 0.25, 0.3);
        } else {
            g.fillStyle(0xb08d57, 1);
            g.fillCircle(hx, hy - 2.6, 0.7);
        }
        // owner bandana at the neck (keeps team ID once the hood is gone)
        const nb = F(0.6, 0, 0);
        g.fillStyle(cloth, 1);
        g.fillTriangle(hx + nb[0] - 1.9, hy + 2.4, hx + nb[0] + 1.9, hy + 2.3, hx + nb[0] - 0.3, hy + 4.3);
    }
    // ---- face (gated on facings that show it)
    if (dyF > -0.45) {
        const fxc = hx + dxF * 1.0, fyc = hy + dyF * 0.5 + 0.3;
        // manic eyes: pale saucers, pin pupils chasing the dart
        const ep = F(0, 1.15, 0);
        for (const sgn of [1, -1]) {
            const ex = fxc + ep[0] * sgn + dxF * 0.4, ey = fyc + ep[1] * sgn - 0.7;
            g.fillStyle(0xf6f0c2, 1);
            g.fillCircle(ex, ey, 0.72);
            g.fillStyle(0x1c2a10, 1);
            g.fillCircle(ex + dxF * 0.3 + dart * 0.35, ey + dyF * 0.15, 0.36);
        }
        // long droopy nose, toward the facing
        const nb0 = F(1.8, -0.5, 0), nb1 = F(1.8, 0.5, 0), nt = F(4.8, 0, 1.3);
        g.fillStyle(skin, 1);
        g.fillTriangle(hx + nb0[0], hy + nb0[1] + 0.3, hx + nb1[0], hy + nb1[1] + 0.3, hx + nt[0], hy + nt[1]);
        g.fillStyle(skinDk, 1);
        g.fillCircle(hx + nt[0], hy + nt[1], 0.5);
        // greedy grin: open when sprinting or swatting
        const mo = F(1.6, 0, 1.6);
        if (isMoving || swat > 0.3) {
            g.fillStyle(0x27340f, 1);
            g.fillEllipse(fxc + mo[0] * 0.4, fyc + mo[1] + 0.4, 2.0, 1.3);
            g.fillStyle(0xf2eede, 1);
            g.fillRect(fxc + mo[0] * 0.4 - 0.8, fyc + mo[1] - 0.1, 0.7, 0.6);
        } else {
            g.lineStyle(0.7, 0x27340f, 1);
            g.lineBetween(fxc + mo[0] * 0.4 - 0.9, fyc + mo[1] + 0.3, fxc + mo[0] * 0.4 + 0.9, fyc + mo[1] + 0.1);
        }
    }

    if (sackFront) drawSack();

    // ================= arms =================
    // Clutch arm: white-knuckled on the sack neck (recompute the neck point).
    {
        const nvx = shoulderP[0] - sackPos[0], nvy = shoulderP[1] - sackPos[1];
        const nl = Math.hypot(nvx, nvy) || 1;
        const nx = sackPos[0] + (nvx / nl) * sackRX * sqX * 0.86;
        const ny = sackPos[1] + (nvy / nl) * sackRY * sqY * 0.86;
        limb(g, skin, shoulderP[0], shoulderP[1], nx, ny, 1.5);
        g.fillStyle(skin, 1);
        g.fillCircle(nx, ny, 1.15);
    }
    // Free arm: pumps on the sprint, dangles-and-twitches at idle, flails
    // out for balance during the swat.
    {
        const sh2 = F(lean * 0.3 + 0.6, -1.7, -2.5 - lift);
        let hp2: [number, number];
        if (isMoving) {
            hp2 = F(0.6 + lean * 0.3 + 1.7 - swing * 0.85, -2.5, -1.2 - lift);
        } else if (haul > 0) {
            hp2 = F(0.6 - 2.2 * haul, -3.2, -2.5 - 1.8 * haul);
        } else if (swat > 0) {
            // comic balance flail: arm thrown out back-and-side, not skyward
            hp2 = F(0.6 - 3.6 * swat, -3.4, -2.5 - 2.2 * swat);
        } else {
            const twitch = Math.sin(iph * Math.PI * 8) * 0.5; // H4 = 500 ms fidget
            hp2 = F(1.0, -2.3, 1.6 + twitch * 0.3);
            // grabby fingers, counting invisible coins
            g.lineStyle(0.7, skinDk, 1);
            for (let i = -1; i <= 1; i++) {
                g.lineBetween(hp2[0] + i * 0.6, hp2[1] + 0.4, hp2[0] + i * 0.7 + twitch * 0.4, hp2[1] + 1.6 + (i === 0 ? twitch * 0.5 : 0));
            }
        }
        limb(g, skin, sh2[0], sh2[1], hp2[0], hp2[1], 1.4);
        g.fillStyle(skin, 1);
        g.fillCircle(hp2[0], hp2[1], 1.05);
    }

    // ================= impact coin burst (weak hit, rich spray) =============
    if (fight && atk.strike > 0 && atk.age > 20) {
        const bt = clamp01(atk.age / STRIKE_MS);
        const b2 = F(6.8, 0.6, 2.2);
        for (let k = 0; k < 3; k++) {
            const ba = fa + (k - 1) * 0.95;
            const rad = 3.2 + bt * 5.5;
            const bx = b2[0] + Math.cos(ba) * rad;
            const by = b2[1] + Math.sin(ba) * 0.5 * rad - (bt * 7 - bt * bt * 9);
            g.fillStyle(gold, 1);
            g.fillCircle(bx, by, 0.8);
            g.fillStyle(0xfff6c0, 1);
            g.fillCircle(bx - 0.25, by - 0.25, 0.3);
        }
    }

    if (sackFront) drawSpill();
}
