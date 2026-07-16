import type Phaser from 'phaser';

/**
 * HAWK-EYE ASSASSIN — design A ("The Long Barrel").
 *
 * Concept: a low, patient stalker whose whole silhouette is organized around
 * ONE dominant line — a da Vinci wheellock rifle longer than he is tall.
 * Slate blue-grey cloak (0x394b59) over a crouched teardrop body, deep hood
 * void with a SINGLE gold eye-glint, brass wheel-lock disc hanging under the
 * breech, cyan-lensed scope riding the barrel. High-contrast paint (dark
 * rims under every mass, bright metal + NW-lit slate) so he still reads when
 * the engine fades the carrier to ~55% alpha during his untargetable cloak.
 * All paint is OPAQUE (alpha 1) except the standard 0.22 ground contact
 * shadow — translucency is carrier-level, never baked into the body.
 *
 * Motion contract (all deterministic f(time) — bake-safe):
 *  - WALK: low crouched stalk on an exact 340 ms stride; the rifle is
 *    carried level and takes only ~30% of the body bob (controlled carry).
 *  - IDLE: one declared 2000 ms period (250 ms multiple). Terms: breath lift
 *    (1st harmonic), hood scan — face void + gold eye sweep ~±1 px (1st
 *    harmonic), and a scope-lens glint pulse gated to phase [0.32, 0.52)
 *    of the same period (bright cyan + 4-point star — >16/255 RGB swing
 *    over several silhouette texels, probe-measurable).
 *  - ATTACK (delay 1300): brace + sink through a 520 ms windup (cheek weld,
 *    lens glint ramps with aim), opaque muzzle FLASH + wheel-spark shower
 *    exactly on the damage tick, 200 ms recoil shove that settles out.
 *
 * TROOP_PARAMS sync: stride 340 · idlePeriod 2000 · windup 520 · strike 200.
 * Levels: L1 plain wood/iron → L2 blued iron + pauldron → L3 polished steel
 * with gold ACCENTS only (wheel, two slim bands, butt cap, hem trim).
 * Owner palettes: player slate blue-grey; enemy darker red-shifted wine.
 * dirs: 8 (consumes facingAngle continuously); driver unused (always 0).
 */

type G = Phaser.GameObjects.Graphics;

const STRIDE_MS = 340; // exact walk period
const IDLE_MS = 2000; // exact 250 ms-multiple idle period
const WINDUP_MS = 520;
const STRIKE_MS = 200;

function clamp01(v: number): number {
    return v < 0 ? 0 : v > 1 ? 1 : v;
}

function easeOut(t: number): number {
    return 1 - (1 - t) * (1 - t);
}

/** One limb/strut drawn as a thick quad from (x0,y0) to (x1,y1). */
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

interface Atk {
    windup: number;
    strike: number;
    age: number;
    inCombat: boolean;
}

/** Attack-cycle state locked to the damage tick (the TroopRenderer contract:
 *  windup peaks exactly when damage fires; stale replay ages free-run). */
function atkAnim(time: number, attackAge: number, attackDelay: number): Atk {
    if (attackAge < 0 || attackDelay <= 0) return { windup: 0, strike: 0, age: Infinity, inCombat: false };
    let age = attackAge;
    if (age > attackDelay + 600) age = time % attackDelay;
    const remaining = attackDelay - age;
    let windup = 0;
    if (remaining <= 0) windup = 1;
    else if (remaining <= WINDUP_MS) windup = 1 - remaining / WINDUP_MS;
    const strike = age <= STRIKE_MS ? 1 - age / STRIKE_MS : 0;
    return { windup, strike, age, inCombat: true };
}

/** Per-slot bake-param overrides (DesignRegistry.designBakeParams): authored
 *  periods that differ from the TROOP_PARAMS row (420/0, no idleMs).
 *  WINDUP_MS 520 / STRIKE_MS 200 (this slot authors a real 200 ms release
 *  decay); idle closes on IDLE_MS = 2000. stride 340 and delay 1300 match. */
export const PARAMS: import('./DesignRegistry').DesignParamsExport = {
    hawkeyeassassin: { windup: 520, strike: 200, idleMs: 2000 },
};

export function drawHawkeyeassassinA(
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
    // ---------------- palette ----------------
    const cloak = isPlayer ? 0x394b59 : 0x543538;
    const cloakLight = isPlayer ? 0x5d7689 : 0x7d5058;
    const cloakDark = isPlayer ? 0x253138 : 0x362124;
    const trouser = isPlayer ? 0x33424e : 0x492f33;
    const boot = isPlayer ? 0x1c232b : 0x241a1c;
    const glove = isPlayer ? 0x232c34 : 0x2d2022;
    const strap = isPlayer ? 0x27323b : 0x322124;
    const hoodVoid = isPlayer ? 0x0d1317 : 0x120d0e;
    const rim = isPlayer ? 0x151c22 : 0x1c1315; // silhouette-hardening under-rim

    // Material tiers: L1 humble wood/iron → L2 blued iron → L3 refined steel
    // with gold ACCENTS (never large gold masses — owner rule).
    const L = Math.max(1, Math.min(3, troopLevel));
    const stockWood = L >= 3 ? 0x7a5230 : L === 2 ? 0x684626 : 0x7d5530;
    const stockDark = L >= 3 ? 0x4c3119 : L === 2 ? 0x422c17 : 0x4f351d;
    const barrelC = L >= 3 ? 0xb9c1cd : L === 2 ? 0x69758a : 0x7c8592;
    const barrelLit = L >= 3 ? 0xdde3ec : L === 2 ? 0x8a94a2 : 0x9aa3ae;
    const wheelC = L >= 3 ? 0xdaa520 : L === 2 ? 0xb08d3e : 0x9a7b40;
    const wheelLit = L >= 3 ? 0xffd700 : L === 2 ? 0xd8b25f : 0xc9a25a;
    const buttCap = L >= 3 ? 0xdaa520 : L === 2 ? 0x9aa4b0 : 0;
    const scopeTube = L >= 3 ? 0x434e5a : 0x333e48;
    const lensCyan = 0x59d7ee;
    const lensHouse = 0x0d3a46;

    // ---------------- rig ----------------
    const fa = facingAngle || 0;
    const ax = Math.cos(fa);
    const sy = Math.sin(fa); // full screen-y aim component
    const ay = sy * 0.5; // iso-squashed along-aim y
    const alen = Math.hypot(ax, ay) || 1;
    const pnx = -ay / alen, pny = ax / alen; // unit perpendicular to the aim line

    const atk = atkAnim(time, attackAge, attackDelay || 1300);
    const wu = !isMoving && atk.inCombat ? easeOut(clamp01(atk.windup)) : 0;
    const st = !isMoving && atk.inCombat ? atk.strike : 0; // 1 at tick → 0

    let swing = 0, lift = 0, scan = 0, glint = 0;
    if (isMoving) {
        const ph = (time % STRIDE_MS) / STRIDE_MS;
        const s = Math.sin(ph * Math.PI * 2);
        swing = s * 2.0;
        lift = Math.abs(s) * 0.6;
    } else {
        const ph = (time % IDLE_MS) / IDLE_MS;
        const w = ph * Math.PI * 2;
        lift = Math.max(0, Math.sin(w)) * 0.5;
        scan = Math.sin(w) * 1.1; // hood scan — 1st harmonic of the 2000 ms period
        // Lens glint pulse gated to a fixed phase window of the SAME period.
        if (ph >= 0.32 && ph < 0.52) glint = Math.sin(((ph - 0.32) / 0.2) * Math.PI);
    }
    if (wu > 0) glint = Math.max(glint, wu); // scope glint ramps with the aim

    // Always slightly hunched; LOW while stalking; sinks deeper into the brace.
    const crouch = 0.8 + (isMoving ? 0.9 : 0) + wu * 1.0;
    const rec = st * st; // recoil shove, sharpest exactly on the tick
    const rx = -ax * rec * 1.9, ry = -ay * rec * 1.9; // rifle recoil offset
    const bodyRx = rx * 0.4; // body rocks less than the gun

    const lean = ax * (0.4 + wu * 0.9) + (isMoving ? ax * 0.7 : 0);
    const tx = lean + bodyRx;
    const torsoY = -1.6 - lift + crouch;

    // Head/hood anchor (cheek weld pulls it toward the scope during the aim).
    const hx = tx + ax * (0.5 + wu * 0.7);
    const hy = -6.6 - lift + crouch * 0.9 + wu * 0.5 - rec * 0.4;

    // Rifle hold point — carried LEVEL: only ~30% of the walk bob reaches it.
    // Held well FORWARD of the chest so the wheel-lock reads on the gun.
    const rifleDrop = !atk.inCombat && !isMoving ? 1.4 : 0; // rests low out of combat
    const Rx = tx + ax * 2.4 + rx;
    const Ry = -3.2 - (isMoving ? lift * 0.3 : lift * 0.7) + crouch * 0.8 - wu * 1.2 + rifleDrop + ry;
    const dButt = -5.4, dBreech = -1.6, dMuzzle = 12.2;
    const at = (d: number): [number, number] => [Rx + ax * d, Ry + ay * d];

    // ---------------- ground contact shadow ----------------
    g.fillStyle(0x000000, 0.22);
    g.fillEllipse(0, 9.6, 10, 3.8);

    // ================= rifle + arms group (aim-aware layering) =============
    const paintRifleGroup = (): void => {
        // Silhouette-hardening under-quad beneath the whole barrel line.
        const [ux0, uy0] = at(dBreech - 0.4);
        const [ux1, uy1] = at(dMuzzle + 0.2);
        limb(g, rim, ux0, uy0, ux1, uy1, 2.5);

        // Stock: wood, dropping to the shoulder at the butt.
        const [bx1, by1] = at(dBreech);
        const [bx0raw, by0raw] = at(dButt);
        const bx0 = bx0raw, by0 = by0raw + 1.6;
        limb(g, rim, bx0 + 0.2, by0 + 0.4, bx1, by1 + 0.4, 3.0);
        limb(g, stockDark, bx0, by0 + 0.3, bx1, by1 + 0.3, 2.4);
        limb(g, stockWood, bx0 + 0.2, by0 - 0.2, bx1, by1 - 0.2, 1.7);
        if (buttCap) limb(g, buttCap, bx0 - ax * 0.3, by0 - 1.3, bx0 - ax * 0.3, by0 + 1.3, 1.3);

        // Barrel: dark body + NW-lit top ridge.
        const [mx1, my1] = at(dMuzzle);
        limb(g, barrelC, bx1, by1, mx1, my1, 1.6);
        limb(g, barrelLit, bx1 + pnx * 0.35, by1 + pny * 0.35 - 0.15, mx1 + pnx * 0.35, my1 + pny * 0.35 - 0.15, 0.7);
        // Muzzle cap tick.
        limb(g, rim, mx1 - pnx * 1.2, my1 - pny * 1.2, mx1 + pnx * 1.2, my1 + pny * 1.2, 1.1);
        // Barrel bands by tier: L2 one iron, L3 two slim gold.
        const bands: Array<[number, number]> =
            L >= 3 ? [[8.2, 0xdaa520], [10.6, 0xdaa520]] : L === 2 ? [[8.2, 0xaab3bf]] : [];
        for (const [d, c] of bands) {
            const [cx, cy] = at(d);
            limb(g, c, cx - pnx * 1.0, cy - pny * 1.0, cx + pnx * 1.0, cy + pny * 1.0, 0.85);
        }

        // Brass wheel-lock disc hanging under the breech — ON the gun, clear
        // of the chest.
        const [wxa, wya] = at(0.3);
        const wx = wxa, wy = wya + 1.15;
        g.fillStyle(rim, 1);
        g.fillCircle(wx, wy, 1.75);
        g.fillStyle(wheelC, 1);
        g.fillCircle(wx, wy, 1.4);
        g.fillStyle(wheelLit, 1);
        g.fillCircle(wx - 0.4, wy - 0.4, 0.5); // NW glint
        g.fillStyle(rim, 1);
        g.fillCircle(wx, wy, 0.4); // axle
        // Dog/jaw arm biting down onto the wheel from the barrel.
        g.fillStyle(stockDark, 1);
        g.fillTriangle(wx - 0.8, wy - 1.3, wx + 0.8, wy - 1.3, wx + 0.2, wy - 2.6);

        // Scope tube riding above the barrel; objective lens faces the target.
        const [s0x, s0yb] = at(2.2);
        const [s1x, s1yb] = at(6.0);
        const s0y = s0yb - 2.1, s1y = s1yb - 2.1;
        // mounts
        limb(g, rim, s0x + ax * 0.5, s0y + 0.6, s0x + ax * 0.5, s0yb - 0.2, 0.8);
        limb(g, rim, s1x - ax * 0.5, s1y + 0.6, s1x - ax * 0.5, s1yb - 0.2, 0.8);
        limb(g, rim, s0x - ax * 0.3, s0y, s1x + ax * 0.3, s1y, 1.9);
        limb(g, scopeTube, s0x, s0y, s1x, s1y, 1.3);
        // Rear eyepiece (dark) + front cyan objective.
        g.fillStyle(rim, 1);
        g.fillCircle(s0x - ax * 0.3, s0y - ay * 0.2, 0.8);
        g.fillStyle(lensHouse, 1);
        g.fillCircle(s1x + ax * 0.3, s1y + ay * 0.2, 1.0);
        g.fillStyle(lensCyan, 1);
        g.fillCircle(s1x + ax * 0.3, s1y + ay * 0.2, 0.6);
        // The glint: idle sweep pulse / aim ramp. Opaque brights only.
        if (glint > 0.05) {
            const lx = s1x + ax * 0.3, ly = s1y + ay * 0.2;
            g.fillStyle(0xbdf3ff, 1);
            g.fillCircle(lx, ly, 0.5 + glint * 0.4);
            if (glint > 0.55) {
                const star = 1.0 + glint * 0.8;
                g.fillStyle(0xeafcff, 1);
                g.fillRect(lx - star, ly - 0.26, star * 2, 0.52);
                g.fillRect(lx - 0.26, ly - star, 0.52, star * 2);
            }
        }

        // Arms + gloved hands (sleeves in cloak colour).
        const [fhxa, fhya] = at(4.6);
        const fhx = fhxa, fhy = fhya + 0.6;
        const [rhxa, rhya] = at(-1.0);
        const rhx = rhxa, rhy = rhya + 0.8;
        limb(g, cloakDark, tx + ax * 1.6, torsoY - 1.8, fhx, fhy, 1.8);
        limb(g, cloakDark, tx - ax * 1.1, torsoY - 1.4, rhx, rhy, 1.7);
        g.fillStyle(glove, 1);
        g.fillCircle(fhx, fhy, 1.0);
        g.fillCircle(rhx, rhy, 0.95);
    };

    // Only steep up-screen aims duck the gun behind the body — shallow ones
    // keep the long-barrel silhouette in front (readability first).
    const rifleBehind = sy < -0.4;
    if (rifleBehind) paintRifleGroup();

    // ================= legs (crouched stance / stalk / brace) ==============
    const braced = atk.inCombat && !isMoving;
    const spread = braced ? 2.2 : 1.7;
    const cxF = braced ? ax * 0.9 : 0; // brace: front foot toward the aim
    const legTop = 3.8 + crouch * 0.4 - lift;
    g.fillStyle(trouser, 1);
    g.fillRect(-spread - 1 - swing - cxF + bodyRx, legTop, 2, 9.2 - legTop);
    g.fillRect(spread - 1 + swing + cxF + bodyRx, legTop, 2, 9.2 - legTop);
    g.fillStyle(boot, 1);
    g.fillEllipse(-spread - swing - cxF + bodyRx, 9.2, 3, 1.6);
    g.fillEllipse(spread + swing + cxF + bodyRx, 9.2, 3, 1.6);

    // ================= cloak hem (teardrop skirt) ===========================
    const hemTop = torsoY + 1.4;
    const hemBot = 5.9 - lift * 0.4;
    const trail = -ax * 1.1 - swing * 0.25; // hem trails away from the travel line
    const hem = (grow: number, color: number): void => {
        g.fillStyle(color, 1);
        g.beginPath();
        g.moveTo(tx - 3.0 - grow, hemTop);
        g.lineTo(tx + 3.0 + grow, hemTop);
        g.lineTo(tx + 3.8 + trail * 0.4 + grow, hemBot + grow * 0.8);
        g.lineTo(tx - 4.2 + trail - grow, hemBot + grow * 0.8);
        g.closePath();
        g.fillPath();
    };
    hem(0.5, rim);
    hem(0, cloak);
    // NW-lit left panel of the skirt.
    limb(g, cloakLight, tx - 2.4, hemTop + 0.4, tx - 3.4 + trail, hemBot - 0.4, 1.7);
    if (L >= 3) {
        // Gold hem trim — thin accent line only.
        limb(g, 0xdaa520, tx - 4.0 + trail, hemBot - 0.35, tx + 3.6 + trail * 0.4, hemBot - 0.35, 0.6);
    }

    // ================= torso =================
    g.fillStyle(rim, 1);
    g.fillCircle(tx, torsoY, 4.1);
    g.fillStyle(cloak, 1);
    g.fillCircle(tx, torsoY, 3.7);
    g.fillStyle(cloakLight, 1);
    g.fillEllipse(tx - 1.2, torsoY - 1.4, 3.6, 2.6); // NW light
    // Belt.
    g.fillStyle(cloakDark, 1);
    g.fillRect(tx - 3.2, torsoY + 1.4, 6.4, 1.2);
    if (L >= 2) {
        g.fillStyle(wheelLit, 1);
        g.fillRect(tx - 0.6, torsoY + 1.5, 1.2, 1.0); // buckle
    }
    // Bandolier strap + cartridge pips.
    limb(g, strap, tx - 2.5, torsoY - 2.1, tx + 2.8, torsoY + 2.1, 1.2);
    const pipC = L >= 2 ? 0xc9a25a : 0x8b8f96;
    g.fillStyle(pipC, 1);
    g.fillRect(tx - 1.0, torsoY - 1.0, 0.7, 1.3);
    g.fillRect(tx + 0.4, torsoY + 0.1, 0.7, 1.3);
    if (L >= 2) {
        // Iron pauldron on the rifle-side shoulder.
        const px0 = tx + ax * 2.0, py0 = torsoY - 2.3;
        g.fillStyle(rim, 1);
        g.fillEllipse(px0, py0, 3.2, 2.2);
        g.fillStyle(0x8d97a4, 1);
        g.fillEllipse(px0, py0, 2.7, 1.8);
    }

    // ================= hooded head =================
    g.fillStyle(rim, 1);
    g.fillCircle(hx, hy, 3.25);
    // Hood point swept back opposite the aim.
    g.fillStyle(cloakDark, 1);
    g.fillTriangle(hx + ax * 0.7, hy - 2.2, hx - ax * 0.8, hy - 2.8, hx - ax * 3.0, hy - 0.7 - ay * 1.4);
    g.fillStyle(cloak, 1);
    g.fillCircle(hx, hy, 2.9);
    g.fillStyle(cloakLight, 1);
    g.fillEllipse(hx - 1.0, hy - 1.5, 3.0, 1.9); // NW light on the cowl
    if (sy >= -0.4) {
        // Deep face void sliding with the idle scan.
        const vx = hx + ax * 0.95 + scan * 0.45;
        const vy = hy + 0.4;
        g.fillStyle(hoodVoid, 1);
        g.fillEllipse(vx, vy, 3.4, 2.6);
        // THE single gold eye-glint (brightens as the aim settles).
        const ex = vx + ax * 0.5, ey = vy - 0.1;
        g.fillStyle(0xffd700, 1);
        g.fillCircle(ex, ey, 0.6 + wu * 0.25);
        g.fillStyle(0xfff3b8, 1);
        g.fillCircle(ex - 0.2, ey - 0.25, 0.28);
    } else {
        // Facing away up-screen: show the shaded BACK of the cowl instead.
        g.fillStyle(cloakDark, 1);
        g.fillEllipse(hx - ax * 0.6, hy + 0.5, 3.2, 2.3);
    }

    if (!rifleBehind) paintRifleGroup();

    // ================= shot effects (always on top) =================
    if (st > 0) {
        // Wheel-spark shower — the wheellock's signature.
        if (st > 0.2 && st < 0.92) {
            const fall = 1 - st;
            const [wxa, wya] = at(0.3);
            g.fillStyle(0xffcf6a, 1);
            g.fillCircle(wxa + 0.8 + fall * 1.8, wya + 1.2 + fall * 2.6, 0.45);
            g.fillCircle(wxa - 0.4 + fall * 1.1, wya + 1.6 + fall * 3.2, 0.4);
            g.fillStyle(0xff9d3d, 1);
            g.fillCircle(wxa + 0.2 + fall * 2.4, wya + 1.4 + fall * 2.0, 0.35);
        }
        // Opaque muzzle FLASH starburst exactly on the tick.
        const [mxa, mya] = at(dMuzzle + 0.5);
        const Lf = 3.0 + 3.4 * st; // forward spike
        const Lp = 1.3 + 1.6 * st; // side spikes
        g.fillStyle(0xffb04a, 1);
        g.fillTriangle(mxa + ax * Lf, mya + ay * Lf, mxa + pnx * 1.1, mya + pny * 1.1, mxa - pnx * 1.1, mya - pny * 1.1);
        g.fillTriangle(mxa + pnx * Lp, mya + pny * Lp, mxa + ax * 0.9, mya + ay * 0.9, mxa - ax * 0.3, mya - ay * 0.3);
        g.fillTriangle(mxa - pnx * Lp, mya - pny * Lp, mxa + ax * 0.9, mya + ay * 0.9, mxa - ax * 0.3, mya - ay * 0.3);
        g.fillStyle(0xffe9b0, 1);
        g.fillTriangle(mxa + ax * Lf * 0.62, mya + ay * Lf * 0.62, mxa + pnx * 0.6, mya + pny * 0.6, mxa - pnx * 0.6, mya - pny * 0.6);
        g.fillCircle(mxa, mya, 0.9 + 1.0 * st);
        g.fillStyle(0xfffbe8, 1);
        g.fillCircle(mxa + ax * 0.4, mya + ay * 0.4, 0.5 + 0.6 * st);
    }
}
