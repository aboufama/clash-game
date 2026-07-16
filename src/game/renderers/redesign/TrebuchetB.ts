import type Phaser from 'phaser';

/**
 * TREBUCHET — clean-room design B: "the Ratchet-and-Drop".
 *
 * A tall twin-trestle counterweight trebuchet on a wheeled timber sled.
 * The silhouette is the ARM and the WEIGHT: cocked, the long arm points
 * low-back with the leather sling pouch resting near the ground behind the
 * sled while the iron counterweight box rides HIGH over the bow; on release
 * the box drops through the frame's open centre channel and the arm whips
 * the sling under, back, up and over the top (the real under-slung path).
 * Re-cocking is a visible 14-notch RATCHET — the arm jerks down click by
 * click while the windlass crank spins — so the whole cycle reads as
 * machinery. Two villager-scale engineers crew it: a windlass man at the
 * drum and a sling-loader at the rear who bends and loads the stone.
 *
 * TIMING CONTRACT (keep the bake TROOP_PARAMS in sync):
 *  - walk stride  = 600 ms (ONE period: wheels, crew gait, sled bob, sway)
 *  - idle period  = 2000 ms (exact 250 ms multiple; all idle terms are
 *    harmonics: weight sway 1×, crew fidget 1×/2×, pennant 4×)
 *  - attack cycle = attackDelay (4000 ms): follow-through 0–430 ms after
 *    the tick, ratchet crank 430 → delay−650, cocked hold → delay−170,
 *    release WHIP in the last 170 ms so the sling empties exactly on the
 *    damage tick (windupMs ≈ 170, strikeMs ≈ 430). The projectile itself
 *    is engine-spawned: the pouch carries the stone only through crank-end,
 *    hold and whip, and reads EMPTY from age 0.
 *
 * All motion is deterministic in `time`/`attackAge`; no per-frame random.
 * No translucency in the body — only the contact shadow and the brief
 * release dust use alpha (both ground FX, mostly-opaque so the 50% alpha
 * snap keeps their early frames).
 */

type G = Phaser.GameObjects.Graphics;

interface PtB { x: number; y: number }

const TAU_B = Math.PI * 2;

/** Arm angles (radians, local frame: +x = facing, +y = up). */
const A_COCK_B = 3.62;   // ≈207° — long arm low-back, weight high over the bow
const A_REL_B = 1.02;    // ≈58°  — arm whipped up-and-over toward the target
const A_STOW_B = 3.70;   // ≈212° — travel: arm lashed a notch past cocked

const ARM_LONG_B = 30;   // pivot → sling tip
const ARM_SHORT_B = 11;  // pivot → counterweight yoke
const PIVOT_H_B = 25;    // axle height above ground
const SLING_B = 9.5;     // sling rope length
const CHAIN_B = 4.0;     // yoke → box top
const BOX_HF_B = 4.1;    // box half-extent along facing
const BOX_HL_B = 3.4;    // box half-extent lateral
const BOX_H_B = 6.2;     // box height

const WHIP_MS_B = 170;   // release whip (the last ms before the tick)
const FT_MS_B = 430;     // follow-through wobble after the tick
const HOLD_MS_B = 480;   // cocked-and-aimed hold before the whip

function clamp01B(v: number): number { return v < 0 ? 0 : v > 1 ? 1 : v; }

function lerpB(a: number, b: number, t: number): number { return a + (b - a) * t; }

/** Multiply a 0xRRGGBB colour toward dark (m<1) or light (m>1). */
function shadeB(c: number, m: number): number {
    const r = Math.max(0, Math.min(255, Math.round(((c >> 16) & 0xff) * m)));
    const g = Math.max(0, Math.min(255, Math.round(((c >> 8) & 0xff) * m)));
    const b = Math.max(0, Math.min(255, Math.round((c & 0xff) * m)));
    return (r << 16) | (g << 8) | b;
}

/** 14-notch ratchet: k (0..1) advances in quick eased clicks. */
function ratchetB(k: number): number {
    const n = 14;
    const s = clamp01B(k) * n;
    const i = Math.floor(s);
    const f = Math.min(1, (s - i) * 1.55); // each notch lands fast, then rests
    const e = 1 - (1 - f) * (1 - f);
    return Math.min(1, (i + e) / n);
}

export function drawTrebuchetB(
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
    // ================= palette (level = material refinement) =================
    const wood = troopLevel >= 3 ? 0x6e553a : troopLevel === 2 ? 0x7d6142 : 0x8a6d4a;
    const woodDk = shadeB(wood, 0.62);
    const woodLt = shadeB(wood, 1.2);
    const frame = shadeB(wood, 0.84); // trestles a shade darker than the sled
    const iron = 0x484d55;
    const ironDk = 0x30343a;
    const ironLt = 0x5f6672;
    const rope = 0x8b7355;
    const gold = 0xdaa520;
    const stoneC = 0x8f8a80;
    const stoneDk = 0x6f6a62;
    const pouchC = 0x4d3821;
    const pouchDk = 0x33240e;
    const skin = isPlayer ? 0xdeb887 : 0xc9a66b;
    const tunic = isPlayer ? 0x7d5a35 : 0x5f4630;
    const tunicDk = shadeB(tunic, 0.68);
    const cloth = isPlayer ? 0x2f6f9f : 0xa03028; // caps / pennant / shield
    const clothDk = shadeB(cloth, 0.7);

    // ================= basis (iso projection of the facing) =================
    const fa = facingAngle || 0;
    const fx = Math.cos(fa), fy = Math.sin(fa) * 0.5;   // along facing
    const px = -Math.sin(fa), py = Math.cos(fa) * 0.5;  // across facing
    const BASE = 8.2;
    const S = (d: number, w: number, h: number): PtB =>
        ({ x: fx * d + px * w, y: BASE + fy * d + py * w - h });
    const SY = (d: number, w: number): number => fy * d + py * w; // depth key

    const quad = (a: PtB, b: PtB, c: PtB, d: PtB, color: number): void => {
        g.fillStyle(color, 1);
        g.beginPath();
        g.moveTo(a.x, a.y); g.lineTo(b.x, b.y); g.lineTo(c.x, c.y); g.lineTo(d.x, d.y);
        g.closePath();
        g.fillPath();
    };
    /** Screen-space tapered strip (thickness along the projected normal). */
    const strip = (a: PtB, b: PtB, w0: number, w1: number, color: number): void => {
        const dx = b.x - a.x, dy = b.y - a.y;
        const len = Math.hypot(dx, dy) || 1;
        const nx = -dy / len, ny = dx / len;
        quad(
            { x: a.x + nx * w0 / 2, y: a.y + ny * w0 / 2 },
            { x: b.x + nx * w1 / 2, y: b.y + ny * w1 / 2 },
            { x: b.x - nx * w1 / 2, y: b.y - ny * w1 / 2 },
            { x: a.x - nx * w0 / 2, y: a.y - ny * w0 / 2 },
            color
        );
    };
    const line = (a: PtB, b: PtB, w: number, color: number): void => {
        g.lineStyle(w, color, 1);
        g.lineBetween(a.x, a.y, b.x, b.y);
    };

    // ======================= pose state for this frame =======================
    const D = attackDelay > 0 ? attackDelay : 4000;
    const inCombat = !isMoving && attackAge >= 0;
    let age = attackAge;
    if (inCombat && age > D + 600) age = ((time % D) + D) % D; // stale → free-run
    const crankEnd = D - HOLD_MS_B - WHIP_MS_B;

    let armA = A_COCK_B;
    let bob = 0;            // rigid body bounce (walk)
    let wheelA = 0;         // wheel rotation
    let swayD = 0;          // counterweight pendulum along facing (px)
    let loaded = false;     // stone sits in the pouch
    let ropeTaut = false;   // windlass rope holds the cocked arm
    let lashed = false;     // travel lashings on the weight box
    let crankVis = -0.6;    // crank handle angle
    let dust = 0;           // weight-drop ground dust (0..1)
    let kCrank = -1;        // crank progress (for crew choreography)
    let holdT = -1;         // hold progress (loading happens early in it)
    let ftT = -1;           // follow-through progress
    let whipT = -1;         // whip progress

    const walkPh = (((time % 600) + 600) % 600) / 600;
    const walkS = Math.sin(walkPh * TAU_B);
    const idlePh = (((time % 2000) + 2000) % 2000) / 2000;
    const iw = idlePh * TAU_B; // idle base angular phase (P = 2000 ms)

    if (isMoving) {
        bob = Math.abs(walkS) * 0.7;
        wheelA = walkPh * TAU_B;
        armA = A_STOW_B + walkS * 0.02;
        swayD = Math.sin(walkPh * TAU_B - 0.9) * 1.6;
        lashed = true;
    } else if (!inCombat) {
        // Idle: cocked, loaded and spanned — weight sways on the chains.
        armA = A_COCK_B;
        swayD = Math.sin(iw) * 2.2;
        loaded = true;
        ropeTaut = true;
    } else {
        const rem = D - age;
        if (rem <= WHIP_MS_B) {
            // RELEASE WHIP — accelerating; the tick lands exactly at t=1.
            whipT = clamp01B(1 - rem / WHIP_MS_B);
            const e = whipT * whipT;
            armA = A_COCK_B + (A_REL_B - A_COCK_B) * e;
            loaded = true;
        } else if (age <= FT_MS_B) {
            // FOLLOW-THROUGH — arm overshoots and shivers, weight swings out.
            ftT = age / FT_MS_B;
            const dec = (1 - ftT) * (1 - ftT);
            armA = A_REL_B + Math.sin(age / 62) * 0.3 * dec;
            swayD = Math.sin(age / 80) * 2.8 * (1 - ftT);
            dust = age < 220 ? 1 - age / 220 : 0;
        } else if (age <= crankEnd) {
            // RATCHET CRANK — arm jerks back notch by notch, weight rises.
            // The sling stays EMPTY: the stone is loaded during the hold,
            // once the pouch has settled onto the ground.
            kCrank = clamp01B((age - FT_MS_B) / Math.max(1, crankEnd - FT_MS_B));
            const kn = ratchetB(kCrank);
            armA = A_REL_B + (A_COCK_B - A_REL_B) * kn;
            ropeTaut = true;
            crankVis = kn * TAU_B * 7;
        } else {
            // COCKED HOLD — the loader bends and rolls the stone into the
            // grounded pouch early in the hold, then signals ready.
            holdT = clamp01B((age - crankEnd) / (HOLD_MS_B));
            armA = A_COCK_B;
            loaded = holdT > 0.3;
            ropeTaut = true;
            crankVis = TAU_B * 7;
        }
    }

    // ======================== rig geometry (local) ==========================
    const ux = Math.cos(armA), uy = Math.sin(armA);
    const pivD = 2, pivH = PIVOT_H_B + bob;
    const tipD = pivD + ux * ARM_LONG_B;
    const tipH = pivH + uy * ARM_LONG_B;
    const yokeD = pivD - ux * ARM_SHORT_B;
    const yokeH = pivH - uy * ARM_SHORT_B;
    let boxTopH = yokeH - CHAIN_B;
    boxTopH = Math.max(boxTopH, 1.0 + BOX_H_B); // the box never digs in
    const boxD = yokeD + swayD;

    // Sling pouch (local d/h in the facing plane, w = 0).
    let pd: number, ph: number;
    if (whipT >= 0) {
        // Under-slung whip: hanging → under → back → up-and-over.
        const beta = lerpB(-Math.PI / 2, -Math.PI / 2 - 3.49, whipT * whipT);
        pd = tipD + Math.cos(beta) * SLING_B;
        ph = tipH + Math.sin(beta) * SLING_B;
    } else if (ftT >= 0) {
        // Empty sling snaps around and settles to a hang.
        const dec = Math.pow(1 - ftT, 1.15);
        const beta = -Math.PI / 2 + 2.793 * Math.cos(age / 75) * dec;
        pd = tipD + Math.cos(beta) * SLING_B;
        ph = tipH + Math.sin(beta) * SLING_B;
    } else {
        // Hanging from the tip; rests on the ground once the tip is low.
        pd = tipD + (isMoving ? walkS * 1.6 : 0);
        ph = tipH - SLING_B;
        if (ph < 1.4) {
            // Resting on the ground: the slack lays out away from the pivot.
            const dh = tipH - 1.4;
            const reach = Math.sqrt(Math.max(0, SLING_B * SLING_B - dh * dh));
            ph = 1.4;
            pd = tipD + reach * (tipD >= pivD ? 1 : -1);
        }
    }

    // ====================== ground shadow + release dust =====================
    g.fillStyle(0x000000, 0.3);
    g.fillEllipse(fx * 2, BASE + 1.8 + fy * 2, 34 + 12 * Math.abs(fx), 13 + 5 * Math.abs(Math.sin(fa)));
    // (release dust draws late — in front of the sled — see below)

    // ========================= crew choreography ============================
    // Villager-scale engineers (the scale contract): ~19 px head-to-toe.
    interface CrewPose {
        d: number; w: number;       // feet (local)
        swing: number; lift: number; lean: number; crouch: number;
        lHand: PtB | null; rHand: PtB | null; // absolute screen targets
        headX: number; shadow: boolean;
    }
    const engineer = (p: CrewPose): void => {
        const f = S(p.d, p.w, 0);
        const x = f.x, y = f.y;
        if (p.shadow) {
            g.fillStyle(0x000000, 0.2);
            g.fillEllipse(x, y + 0.3, 8.5, 3.1);
        }
        const ty = y - 7.6 - p.lift + p.crouch * 1.9; // torso centre
        // legs + boots
        g.fillStyle(tunicDk, 1);
        g.fillRect(x - 2.3 - p.swing, y - 5.6, 1.9, 5.6);
        g.fillRect(x + 0.4 + p.swing, y - 5.6, 1.9, 5.6);
        g.fillStyle(0x2a211a, 1);
        g.fillEllipse(x - 1.4 - p.swing, y - 0.3, 2.9, 1.5);
        g.fillEllipse(x + 1.4 + p.swing, y - 0.3, 2.9, 1.5);
        // torso + belt
        g.fillStyle(tunic, 1);
        g.fillCircle(x + p.lean, ty, 3.9);
        g.fillStyle(tunicDk, 1);
        g.fillRect(x + p.lean - 3.4, ty + 1.9, 6.8, 1.5);
        // arms → hand targets
        const shL = { x: x + p.lean - 2.4, y: ty - 0.6 };
        const shR = { x: x + p.lean + 2.4, y: ty - 0.6 };
        const hl = p.lHand ?? { x: x - 3.1, y: y - 3.4 };
        const hr = p.rHand ?? { x: x + 3.1, y: y - 3.4 };
        strip(shL, hl, 1.8, 1.5, tunic);
        strip(shR, hr, 1.8, 1.5, tunic);
        g.fillStyle(skin, 1);
        g.fillCircle(hl.x, hl.y, 1.15);
        g.fillCircle(hr.x, hr.y, 1.15);
        // head + owner cap
        const hx = x + p.lean * 1.25 + p.headX;
        const hy = ty - 4.9;
        g.fillStyle(skin, 1);
        g.fillCircle(hx, hy, 2.75);
        g.fillStyle(0x140e08, 0.9);
        g.fillCircle(hx - 0.9, hy - 0.2, 0.5);
        g.fillCircle(hx + 0.9, hy - 0.2, 0.5);
        g.fillStyle(clothDk, 1);
        g.beginPath();
        g.arc(hx, hy - 0.7, 2.85, Math.PI, 0, false);
        g.closePath();
        g.fillPath();
        g.fillStyle(cloth, 1);
        g.beginPath();
        g.arc(hx, hy - 1.1, 2.3, Math.PI, 0, false);
        g.closePath();
        g.fillPath();
    };

    const crew: CrewPose[] = [];
    if (isMoving) {
        // Both engineers haul at the bow, tow ropes over the shoulder.
        for (const side of [-1, 1]) {
            const phase = side < 0 ? walkPh : (walkPh + 0.5) % 1;
            const s = Math.sin(phase * TAU_B);
            const f = S(23.5, side * 5, 0);
            crew.push({
                d: 23.5, w: side * 5,
                swing: s * 2.1, lift: Math.abs(s) * 0.9, lean: fx * 1.7, crouch: 0,
                lHand: { x: f.x - fx * 3.4, y: f.y - 9.4 },
                rHand: { x: f.x - fx * 1.8, y: f.y - 8 },
                headX: 0, shadow: true
            });
        }
    } else if (!inCombat) {
        // Idle fidget — harmonics of the ONE 2000 ms period.
        const drum = S(-14, 3.6, 6.8);
        crew.push({ // windlass man rests a hand on the drum, shifts his weight
            d: -15.5, w: 10.8,
            swing: 0, lift: Math.max(0, Math.sin(iw * 2)) * 0.5,
            lean: Math.sin(iw) * 1.2, crouch: 0,
            lHand: { x: drum.x, y: drum.y - 1 }, rHand: null,
            headX: Math.sin(iw + 1.0) * 1.1, shadow: true
        });
        const pouchPt = S(pd, 0, ph + 1.6);
        crew.push({ // loader keeps a hand on the sling rope, looks about
            d: -24, w: -5.5,
            swing: 0, lift: 0,
            lean: Math.sin(iw + 2.1) * 1.3, crouch: 0,
            lHand: null, rHand: { x: pouchPt.x, y: pouchPt.y - 1 },
            headX: Math.sin(iw * 2 + 0.5) * 0.8, shadow: true
        });
    } else if (kCrank >= 0) {
        // Cranking: hands ride the near handle; loader bends to load late.
        const hd = Math.cos(crankVis) * 3.0, hh = Math.sin(crankVis) * 3.0;
        const handle = S(-16 + hd, 3.6, 5.2 + bob + hh);
        crew.push({
            d: -15.5, w: 10.8,
            swing: 0, lift: 0, lean: Math.cos(crankVis) * 1.4, crouch: 0.25,
            lHand: { x: handle.x - 0.7, y: handle.y }, rHand: { x: handle.x + 0.7, y: handle.y },
            headX: 0, shadow: true
        });
        crew.push({ // loader waits by the stern with the next stone staged
            d: -24, w: -5.5,
            swing: 0, lift: 0, lean: Math.sin(age / 300) * 0.8, crouch: 0,
            lHand: null, rHand: null,
            headX: 0, shadow: true
        });
    } else if (whipT >= 0 || ftT >= 0) {
        // Loose! Both flinch back; the loader pumps a fist after the tick.
        const cheer = ftT >= 0 ? Math.sin(age / 90) * 1.2 : 0;
        const lf = S(-15.5, 10.8, 0);
        crew.push({
            d: -15.5, w: 10.8,
            swing: 0, lift: 0, lean: -fx * 1.2, crouch: 0.4,
            lHand: { x: lf.x - 3.6, y: lf.y - 12.5 }, rHand: null,
            headX: 0, shadow: true
        });
        const gf = S(-24, -5.5, 0);
        crew.push({
            d: -24, w: -5.5,
            swing: 0, lift: 0, lean: -fx * 0.8, crouch: whipT >= 0 ? 0.35 : 0,
            lHand: null,
            rHand: ftT >= 0 ? { x: gf.x + 2.6, y: gf.y - 16.5 - cheer } : null,
            headX: 0, shadow: true
        });
    } else {
        // Cocked hold: the loader bends and loads the grounded pouch during
        // the first half, then signals ready; windlass man shades his eyes.
        const lf = S(-15.5, 10.8, 0);
        const gf = S(-24, -5.5, 0);
        crew.push({
            d: -15.5, w: 10.8, swing: 0, lift: 0, lean: fx * 0.6, crouch: 0,
            lHand: { x: lf.x - 1.2, y: lf.y - 14.6 }, rHand: null, headX: fx * 0.8, shadow: true
        });
        const loadT = holdT < 0.55 ? Math.sin(Math.PI * clamp01B(holdT / 0.55)) : 0;
        const pouchPt = S(pd, 0, ph + 1.2);
        crew.push({
            d: -24, w: -5.5,
            swing: 0, lift: 0, lean: loadT * 1.8, crouch: loadT,
            lHand: loadT > 0.05 ? { x: pouchPt.x - 1.3, y: pouchPt.y } : null,
            rHand: loadT > 0.05 ? { x: pouchPt.x + 1.3, y: pouchPt.y }
                : { x: gf.x + 2.8, y: gf.y - 16.8 },
            headX: 0, shadow: true
        });
    }

    const crewBack = crew.filter(c => SY(c.d, c.w) < -1.5);
    const crewFront = crew.filter(c => SY(c.d, c.w) >= -1.5);
    for (const c of crewBack) engineer(c);

    // ============================ wheels (far pair) ==========================
    const farSide = py >= 0 ? -1 : 1;
    const wheel = (d: number, w: number): void => {
        const r = 4.4;
        const c = S(d, w, 3.8);
        // Wheel plane = facing ⊗ up; extrude a touch so edge-on wheels read.
        const v1x = fx * r + (fx >= 0 ? 1 : -1), v1y = fy * r;
        const v2y = -r;
        const ring = (sc: number, color: number): void => {
            g.fillStyle(color, 1);
            g.beginPath();
            for (let i = 0; i <= 11; i++) {
                const a = (i / 12) * TAU_B;
                const xx = c.x + v1x * Math.cos(a) * sc;
                const yy = c.y + v1y * Math.cos(a) * sc + v2y * Math.sin(a) * sc;
                if (i === 0) g.moveTo(xx, yy); else g.lineTo(xx, yy);
            }
            g.closePath();
            g.fillPath();
        };
        ring(1, troopLevel >= 2 ? ironDk : woodDk);
        ring(0.68, wood);
        // spokes lock to the ONE stride period
        g.lineStyle(1.1, woodDk, 1);
        for (let i = 0; i < 4; i++) {
            const a = wheelA + i * Math.PI / 2;
            g.lineBetween(
                c.x, c.y,
                c.x + v1x * Math.cos(a) * 0.62, c.y + v1y * Math.cos(a) * 0.62 + v2y * Math.sin(a) * 0.62
            );
        }
        g.fillStyle(troopLevel >= 3 ? gold : iron, 1);
        g.fillCircle(c.x, c.y, 1.1);
    };
    wheel(13.5, farSide * 8);
    wheel(-13.5, farSide * 8);

    // ===================== arm assembly (depth-bucketed) =====================
    const drawSling = (): void => {
        const tp = S(tipD, 0, tipH);
        const pp = S(pd, 0, ph);
        const ddx = pp.x - tp.x, ddy = pp.y - tp.y;
        const dl = Math.hypot(ddx, ddy) || 1;
        const nx = -ddy / dl, ny = ddx / dl;
        g.lineStyle(1, rope, 1);
        g.lineBetween(tp.x + nx * 0.4, tp.y + ny * 0.4, pp.x + nx * 1.4, pp.y + ny * 1.4);
        g.lineBetween(tp.x - nx * 0.4, tp.y - ny * 0.4, pp.x - nx * 1.4, pp.y - ny * 1.4);
        // pouch: taut cradle when carrying, slack flap when empty
        g.fillStyle(pouchDk, 1);
        g.fillEllipse(pp.x, pp.y, loaded ? 5.8 : 4.6, loaded ? 3.3 : 2.2);
        g.fillStyle(pouchC, 1);
        g.fillEllipse(pp.x, pp.y - 0.4, loaded ? 4.6 : 3.4, loaded ? 2.4 : 1.5);
        if (troopLevel >= 3) {
            g.lineStyle(0.9, 0xcfc6ae, 1);
            g.lineBetween(pp.x - 2.2, pp.y + 0.9, pp.x + 2.2, pp.y + 0.9);
        }
        if (loaded) {
            const sp = S(pd, 0, ph + 1.4);
            g.fillStyle(stoneDk, 1);
            g.fillCircle(sp.x, sp.y, 2.5);
            g.fillStyle(stoneC, 1);
            g.fillCircle(sp.x - 0.6, sp.y - 0.6, 1.8);
        }
    };
    const drawLongArm = (): void => {
        const pv = S(pivD, 0, pivH);
        const tp = S(tipD, 0, tipH);
        strip(pv, tp, 5.0, 2.2, wood);
        // lit ridge along the beam
        const mid1 = S(lerpB(pivD, tipD, 0.1), 0, lerpB(pivH, tipH, 0.1));
        line(mid1, tp, 1.1, woodLt);
        if (troopLevel >= 2) { // iron strap bands
            for (const t of [0.34, 0.6]) {
                const bd = lerpB(pivD, tipD, t), bh = lerpB(pivH, tipH, t);
                strip(S(bd, -2.4, bh), S(bd, 2.4, bh), 1.7, 1.7, ironDk);
            }
        }
        if (troopLevel >= 3) { // gilded tip band
            const bd = lerpB(pivD, tipD, 0.93), bh = lerpB(pivH, tipH, 0.93);
            strip(S(bd, -1.6, bh), S(bd, 1.6, bh), 1.9, 1.9, gold);
        }
    };
    const drawWeight = (): void => {
        const pv = S(pivD, 0, pivH);
        const yk = S(yokeD, 0, yokeH);
        strip(pv, yk, 5.0, 4.2, shadeB(wood, 0.9)); // short arm butt
        // yoke crossbar the chains hang from
        strip(S(yokeD, -2.8, yokeH), S(yokeD, 2.8, yokeH), 2, 2, woodDk);
        // chains from the yoke crossbar to the box top corners
        g.lineStyle(1.1, ironDk, 1);
        const tA = S(boxD - 2.6, 0, boxTopH);
        const tB = S(boxD + 2.6, 0, boxTopH);
        g.lineBetween(yk.x, yk.y, tA.x, tA.y);
        g.lineBetween(yk.x, yk.y, tB.x, tB.y);
        // iron box: the two down-screen faces + the top (rotation-proof)
        const hTop = boxTopH, hBot = boxTopH - BOX_H_B;
        const corners = (h: number): PtB[] => [
            S(boxD - BOX_HF_B, -BOX_HL_B, h), S(boxD + BOX_HF_B, -BOX_HL_B, h),
            S(boxD + BOX_HF_B, BOX_HL_B, h), S(boxD - BOX_HF_B, BOX_HL_B, h)
        ];
        const T = corners(hTop), Bt = corners(hBot);
        // Vertical faces by corner edge: 0-1 → -w (n = -p), 1-2 → +d (n = +f),
        // 2-3 → +w (n = +p), 3-0 → -d (n = -f). Draw only the faces whose
        // outward normal points down-screen (rotation-proof box, art guide §6).
        const edges: Array<[number, number, number, number]> = [
            [0, 1, -py, -px], [1, 2, fy, fx], [2, 3, py, px], [3, 0, -fy, -fx]
        ];
        for (let i = 0; i < 4; i++) {
            const [a, b, nY, nX] = edges[i];
            if (nY <= 0.02) continue; // faces turned up-screen are hidden
            const lit = nX < 0; // NW light: leftward faces catch it
            quad(T[a], T[b], Bt[b], Bt[a], lit ? ironLt : ironDk);
            // riveted straps
            const mA = { x: (T[a].x + Bt[a].x) / 2, y: (T[a].y + Bt[a].y) / 2 };
            const mB = { x: (T[b].x + Bt[b].x) / 2, y: (T[b].y + Bt[b].y) / 2 };
            g.lineStyle(1, lit ? iron : 0x22252a, 1);
            g.lineBetween(
                lerpB(mA.x, mB.x, 0.28), lerpB(mA.y, mB.y, 0.28) - BOX_H_B * 0.34,
                lerpB(mA.x, mB.x, 0.28), lerpB(mA.y, mB.y, 0.28) + BOX_H_B * 0.34
            );
            g.lineBetween(
                lerpB(mA.x, mB.x, 0.72), lerpB(mA.y, mB.y, 0.72) - BOX_H_B * 0.34,
                lerpB(mA.x, mB.x, 0.72), lerpB(mA.y, mB.y, 0.72) + BOX_H_B * 0.34
            );
        }
        quad(T[0], T[1], T[2], T[3], iron); // top
        if (troopLevel >= 3) {
            g.lineStyle(1, gold, 1);
            g.lineBetween(T[0].x, T[0].y, T[1].x, T[1].y);
            g.lineBetween(T[1].x, T[1].y, T[2].x, T[2].y);
            g.lineBetween(T[2].x, T[2].y, T[3].x, T[3].y);
            g.lineBetween(T[3].x, T[3].y, T[0].x, T[0].y);
        }
        if (lashed) { // travel lashings: box tied down to the bow
            g.lineStyle(1, rope, 1);
            const bA = S(boxD - 2, 0, hBot);
            const bB = S(boxD + 2, 0, hBot);
            const nose = S(18.5, 3.4, 5.6 + bob);
            const nose2 = S(18.5, -3.4, 5.6 + bob);
            g.lineBetween(bA.x, bA.y, nose2.x, nose2.y);
            g.lineBetween(bB.x, bB.y, nose.x, nose.y);
        }
    };

    interface PieceB { sy: number; draw: () => void }
    const pieces: PieceB[] = [
        { sy: SY(pd, 0), draw: drawSling },
        { sy: SY(lerpB(pivD, tipD, 0.75), 0), draw: drawLongArm },
        { sy: SY(boxD, 0), draw: drawWeight }
    ];
    pieces.sort((a, b) => a.sy - b.sy);
    for (const p of pieces) if (p.sy < -3) p.draw(); // far pieces behind the sled

    // ============================== the sled ================================
    for (const side of [-1, 1] as const) {
        const w0 = side * 6.6;
        // the down-screen lateral face of this rail (rotation-proof pick)
        const wOut = w0 + (py >= 0 ? 1.2 : -1.2);
        quad(
            S(-19, wOut, 5.6 + bob), S(19, wOut, 5.6 + bob),
            S(19, wOut, 3.0 + bob), S(-19, wOut, 3.0 + bob),
            (px * (wOut - w0) < 0) ? shadeB(wood, 0.95) : woodDk
        );
        // end face (bow or stern, whichever faces down-screen)
        const dEnd = fy >= 0 ? 19 : -19;
        quad(
            S(dEnd, w0 - 1.2, 5.6 + bob), S(dEnd, w0 + 1.2, 5.6 + bob),
            S(dEnd, w0 + 1.2, 3.0 + bob), S(dEnd, w0 - 1.2, 3.0 + bob),
            shadeB(wood, 0.72)
        );
        // top face
        quad(
            S(-19, w0 - 1.2, 5.6 + bob), S(19, w0 - 1.2, 5.6 + bob),
            S(19, w0 + 1.2, 5.6 + bob), S(-19, w0 + 1.2, 5.6 + bob),
            woodLt
        );
    }
    // rear work platform (windlass deck)
    quad(
        S(-18, -5.4, 5.8 + bob), S(-7, -5.4, 5.8 + bob),
        S(-7, 5.4, 5.8 + bob), S(-18, 5.4, 5.8 + bob),
        shadeB(wood, 1.06)
    );
    g.lineStyle(0.9, woodDk, 1);
    for (const dd of [-15.5, -12.5, -9.5]) {
        const a = S(dd, -5.4, 5.8 + bob), b = S(dd, 5.4, 5.8 + bob);
        g.lineBetween(a.x, a.y, b.x, b.y);
    }
    // bow cross-beam
    quad(
        S(11, -6.2, 5.8 + bob), S(13.5, -6.2, 5.8 + bob),
        S(13.5, 6.2, 5.8 + bob), S(11, 6.2, 5.8 + bob),
        shadeB(wood, 1.1)
    );
    quad(
        S(11, py >= 0 ? 6.2 : -6.2, 5.8 + bob), S(13.5, py >= 0 ? 6.2 : -6.2, 5.8 + bob),
        S(13.5, py >= 0 ? 6.2 : -6.2, 4.4 + bob), S(11, py >= 0 ? 6.2 : -6.2, 4.4 + bob),
        woodDk
    );
    // spare stones on the platform
    {
        const s1 = S(-9.5, -3.5, 7 + bob);
        const s2 = S(-11.4, -2.6, 6.8 + bob);
        g.fillStyle(stoneDk, 1);
        g.fillCircle(s1.x, s1.y, 2.2);
        g.fillCircle(s2.x, s2.y, 1.8);
        g.fillStyle(stoneC, 1);
        g.fillCircle(s1.x - 0.5, s1.y - 0.5, 1.6);
        g.fillCircle(s2.x - 0.4, s2.y - 0.4, 1.2);
    }
    // windlass drum + crank handles (both ends share the axle angle)
    {
        const a = S(-16, -3.6, 5.2 + bob);
        const b = S(-16, 3.6, 5.2 + bob);
        strip(a, b, 3.4, 3.4, woodDk);
        strip(a, b, 1.8, 1.8, wood);
        g.fillStyle(ironDk, 1);
        g.fillCircle(a.x, a.y, 1.7);
        g.fillCircle(b.x, b.y, 1.7);
        const hd = Math.cos(crankVis) * 3.0, hh = Math.sin(crankVis) * 3.0;
        for (const side of [-1, 1] as const) {
            const e = S(-16, side * 3.6, 5.2 + bob);
            const t = S(-16 + hd, side * 3.6, 5.2 + bob + hh);
            line(e, t, 1.3, ironDk);
            g.fillStyle(wood, 1);
            g.fillCircle(t.x, t.y, 1);
        }
    }

    // ===================== far truss → arm → near truss ======================
    const truss = (side: number): void => {
        const foot1 = S(9.5, side * 5.6, 5.6 + bob);
        const foot2 = S(-5.5, side * 5.6, 5.6 + bob);
        const apex = S(2, side * 2.6, 24.4 + bob);
        const legShade = side === farSide ? 0.82 : 1;
        strip(foot1, apex, 3.2, 2.4, shadeB(frame, legShade));
        strip(foot2, apex, 3.2, 2.4, shadeB(frame, legShade * 0.88));
        const b1 = S(6.8, side * 4.6, 13.5 + bob);
        const b2 = S(-3.2, side * 4.6, 13.5 + bob);
        strip(b1, b2, 2, 2, shadeB(frame, legShade * 0.94));
        // iron shoe plates
        g.fillStyle(ironDk, 1);
        g.fillEllipse(foot1.x, foot1.y, 3.4, 1.8);
        g.fillEllipse(foot2.x, foot2.y, 3.4, 1.8);
        if (troopLevel >= 2) {
            g.fillStyle(iron, 1);
            g.fillCircle(apex.x, apex.y, 2);
        }
    };
    truss(farSide);
    // the axle beam behind the arm
    {
        const aA = S(2, -2.6, 24.7 + bob);
        const aB = S(2, 2.6, 24.7 + bob);
        strip(aA, aB, 2.6, 2.6, ironDk);
    }

    for (const p of pieces) if (p.sy >= -3) p.draw();

    // axle boss pin over the arm
    {
        const pv = S(pivD, 0, pivH);
        g.fillStyle(iron, 1);
        g.fillCircle(pv.x, pv.y, 2.2);
        g.fillStyle(troopLevel >= 3 ? gold : ironLt, 1);
        g.fillCircle(pv.x - 0.4, pv.y - 0.4, 1.1);
    }
    // windlass rope holds the cocked arm (spanned states only)
    if (ropeTaut) {
        const a = S(-16, 0, 6.6 + bob);
        const b = S(tipD, 0, tipH);
        g.lineStyle(1, rope, 1);
        const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2 + 1.2;
        g.beginPath();
        g.moveTo(a.x, a.y);
        g.lineTo(mx, my);
        g.lineTo(b.x, b.y);
        g.strokePath();
    }

    truss(-farSide);
    // owner shield hung on the near brace
    {
        const sc = S(1.6, -farSide * 6.2, 13.5 + bob);
        g.fillStyle(woodDk, 1);
        g.fillCircle(sc.x, sc.y, 3);
        g.fillStyle(cloth, 1);
        g.fillCircle(sc.x, sc.y, 2.2);
        g.fillStyle(troopLevel >= 3 ? gold : ironLt, 1);
        g.fillCircle(sc.x, sc.y, 0.8);
    }
    // pennant at the apex (L2+): closes on whichever loop is playing
    if (troopLevel >= 2) {
        const mast0 = S(2, 0, 26.2 + bob);
        const mast1 = S(2, 0, 30 + bob);
        line(mast0, mast1, 1, woodDk);
        const wavePh = isMoving ? walkPh * TAU_B : inCombat ? age / 95 : iw * 4;
        const wv = Math.sin(wavePh) * 1.7;
        const tip = S(2 - 5.2, wv * 0.9, 28.6 + bob + Math.sin(wavePh + 1.2) * 0.8);
        g.fillStyle(cloth, 1);
        g.beginPath();
        g.moveTo(mast1.x, mast1.y);
        g.lineTo(tip.x, tip.y);
        g.lineTo(mast1.x + (tip.x - mast1.x) * 0.22, mast1.y + 2.6);
        g.closePath();
        g.fillPath();
        if (troopLevel >= 3) {
            g.lineStyle(0.9, gold, 1);
            g.lineBetween(mast1.x, mast1.y, tip.x, tip.y);
        }
    }

    // release dust: the counterweight slams through the centre channel
    if (dust > 0) {
        const spread = (1 - dust) * 7;
        g.fillStyle(0x8f8264, dust > 0.45 ? 0.85 : 0.55);
        const dc = S(boxD, 0, 1);
        g.fillEllipse(dc.x - 4 - spread, dc.y + 0.6, 4.2 + spread, 2.2);
        g.fillEllipse(dc.x + 4 + spread, dc.y + 1.2, 4.6 + spread, 2.4);
        g.fillEllipse(dc.x, dc.y - 0.6, 3.4 + spread * 0.7, 1.9);
    }

    // near wheels + front crew
    wheel(13.5, -farSide * 8);
    wheel(-13.5, -farSide * 8);
    // tow ropes: sled nose → the haulers' shoulders (sag in the middle)
    if (isMoving) {
        g.lineStyle(1, rope, 1);
        for (const side of [-1, 1] as const) {
            const nose = S(19, side * 4, 4.6 + bob);
            const hauler = S(23.5, side * 5, 0);
            const shx = hauler.x - fx * 1.2, shy = hauler.y - 8.6;
            g.beginPath();
            g.moveTo(nose.x, nose.y);
            g.lineTo((nose.x + shx) / 2, (nose.y + shy) / 2 + 1.3);
            g.lineTo(shx, shy);
            g.strokePath();
        }
    }
    for (const c of crewFront) engineer(c);
}
