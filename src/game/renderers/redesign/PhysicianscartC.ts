import type Phaser from 'phaser';

type G = Phaser.GameObjects.Graphics;

/**
 * PHYSICIAN'S CART — design C: "the pump-bar apothecary".
 *
 * The cart is the hero: a pale-green medicine chest (0x8fd98f) with red-cross
 * panels riding one big spoked wheel per side, corked vials racked on the lid,
 * herb bundles swinging from the front posts, and a glass elixir dome amidships.
 * The plague doctor behind it is the motor — and his push-bar doubles as the
 * medicine engine's bellows lever: during the 6 s heal buildup he pumps the
 * bar in five accelerating swings (the under-lid bellows wheezes in sync and
 * the dome fills with rising green), then snaps a glowing flask overhead at
 * the exact strike moment while the engine fires the heal ring.
 *
 * Clocks (bake TROOP_PARAMS must mirror these):
 *   walk stride  = 500 ms  (ONE period: gait, cart pitch/bob, wheel roll —
 *                           the 8-spoke wheels advance exactly 3 spoke-gaps
 *                           (3π/4) per stride, so the loop closes seamlessly)
 *   idle period  = 2000 ms (exact harmonics only: herb sway + beak-mask
 *                           glance at 1×, breath + dome shimmer at 1×/2×)
 *   attack       = delay 6000 ms, windup 1400 ms (pump ramp), strike 450 ms
 *                  (flask lift decays through ~950 ms after the tick)
 *
 * All motion is a deterministic f(time/attackAge). No translucency in the
 * body — glow is opaque inner-light shapes; only the contact shadows carry
 * alpha (the hShadow convention every troop uses).
 */

// ---------------------------------------------------------------- helpers --
const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);
const easeOut = (t: number): number => 1 - (1 - t) * (1 - t);
const easeIn = (t: number): number => t * t;

/** Multiply a 0xRRGGBB colour toward dark (m<1) or light (m>1). */
function shade(c: number, m: number): number {
    const r = Math.max(0, Math.min(255, Math.round(((c >> 16) & 0xff) * m)));
    const g = Math.max(0, Math.min(255, Math.round(((c >> 8) & 0xff) * m)));
    const b = Math.max(0, Math.min(255, Math.round((c & 0xff) * m)));
    return (r << 16) | (g << 8) | b;
}

// The design's clocks — see the header comment.
const STRIDE_MS = 500;
const IDLE_MS = 2000;
const WINDUP_MS = 1400;
const STRIKE_MS = 450;

// Cart geometry (world-plane units before iso projection).
const GROUND_Y = 9.5;      // the villager-scale ground line
const WHEEL_R = 5.6;       // wheel radius (axle height = wheel radius)
const TRACK_W = 6.4;       // wheel offset across the travel axis
const CH_D0 = -5.0;        // chest rear (toward the doctor)
const CH_D1 = 9.5;         // chest front
const CH_W = 5.2;          // chest half-width
const CH_H0 = 5.0;         // chest floor height
const CH_H1 = 13.6;        // chest lid height
const DOC_D = -14.5;       // the doctor's ground anchor along -travel

/** Per-slot bake-param overrides (DesignRegistry.designBakeParams): authored
 *  periods that differ from the TROOP_PARAMS row (800/400, no idleMs) —
 *  WINDUP_MS 1400 / STRIKE_MS 450, idle closes on IDLE_MS = 2000. */
export const PARAMS: import('./DesignRegistry').DesignParamsExport = {
    physicianscart: { windup: 1400, strike: 450, idleMs: 2000 },
};

export function drawPhysicianscartC(
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
    const g: G = graphics;
    const L2 = troopLevel >= 2;
    const L3 = troopLevel >= 3;

    // ------------------------------------------------------- iso toolkit --
    const a = Number.isFinite(facingAngle) ? facingAngle : 0;
    const cosA = Math.cos(a);
    const sinA = Math.sin(a);
    // World-plane point (d along travel, w across, h up) -> screen offset.
    const px = (d: number, w: number): number => cosA * d - sinA * w;
    const py = (d: number, w: number, h: number): number =>
        GROUND_Y + (sinA * d + cosA * w) * 0.5 - h;

    // ---------------------------------------------------------- palettes --
    const chest = isPlayer ? 0x8fd98f : 0x79bd81;
    const wood = 0x7c5c34;
    const woodDark = 0x574023;
    const robe = isPlayer ? 0x3d3547 : 0x442e2a;
    const robeDark = shade(robe, 0.7);
    const hat = isPlayer ? 0x27222e : 0x2b201b;
    const bone = 0xe8ddc2;
    const boneDark = 0xb5a887;
    const glove = 0x4a3a28;
    const cream = 0xefe7d2;
    const crossRed = 0xc0392b;
    const strap = L3 ? 0xdaa520 : L2 ? 0xa8873f : 0x9c8a62; // gold / brass / rope
    const rimCol = L2 ? 0x41454d : 0x6b5230;                 // iron tire vs wood
    const spokeCol = 0x8a6a42;
    const glassRim = 0x76907e;
    const greenDim = 0x1e3a28;
    const greenMid = 0x58d68d;
    const greenHot = 0xbef7cf;

    // ------------------------------------------------------------ clocks --
    const tt = time > 0 ? time : 0;
    const walkPh = (tt % STRIDE_MS) / STRIDE_MS;
    const walkS = isMoving ? Math.sin(walkPh * Math.PI * 2) : 0;
    const walkL = isMoving ? Math.abs(Math.sin(walkPh * Math.PI * 2)) : 0;
    const idPh = (tt % IDLE_MS) / IDLE_MS;
    const id1 = Math.sin(idPh * Math.PI * 2);  // 1x idle harmonic
    const id2 = Math.sin(idPh * Math.PI * 4);  // 2x idle harmonic

    // Attack cycle locked to the damage tick (the shared attackAnim grammar).
    const delay = attackDelay > 0 ? attackDelay : 6000;
    const inCombat = attackAge >= 0;
    let age = attackAge;
    if (inCombat && age > delay + 600) age = ((tt % delay) + delay) % delay; // replay free-run
    let windup = 0;
    if (inCombat) {
        const remaining = delay - age;
        if (remaining <= 0) windup = 1;
        else if (remaining <= WINDUP_MS) windup = 1 - remaining / WINDUP_MS;
    }
    const strike = inCombat && age >= 0 && age <= STRIKE_MS ? 1 - age / STRIKE_MS : 0;
    const combatStill = inCombat && !isMoving;

    // The bar pump: five half-swings, growing with the ramp, landing at rest
    // exactly on the tick (sin(5π)=0), so the flask snap takes over cleanly.
    const pump = combatStill ? Math.sin(windup * Math.PI * 5) * windup : 0;
    // Flask lift: snaps up in ~130 ms on the tick, holds, settles by ~950 ms.
    let flask = 0;
    if (combatStill && age >= 0 && age <= 950) {
        flask = easeOut(clamp01(age / 130)) * (1 - easeIn(clamp01((age - 520) / 430)));
    }

    // Cart body motion: gentle pitch about the axle + a hop, both on stride.
    const pitch = isMoving ? walkS * 0.05 : 0;
    const bob = isMoving ? walkL * 0.8 : 0;
    const hEff = (d: number, h: number): number => h + bob + pitch * d;
    // Herb/pennant sway and the doctor's breath — stride when moving, the
    // declared idle harmonic when standing.
    const sway = isMoving ? Math.sin(walkPh * Math.PI * 2 + 1.1) * 1.3 : id1 * 1.8;
    const lift = isMoving ? walkL * 1.2 : Math.max(0, id1) * 0.5;
    const glance = !isMoving && !inCombat ? id1 * 0.55 : isMoving ? walkS * 0.1 : 0;

    // ------------------------------------------------------ fill helpers --
    const quad = (pts: number[][], color: number, alpha: number = 1): void => {
        g.fillStyle(color, alpha);
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

    // ================================================== ground shadows ====
    g.fillStyle(0x000000, 0.28);
    g.fillEllipse(px(2.2, 0), py(2.2, 0, 0) + 0.4, 26, 10.5);
    g.fillStyle(0x000000, 0.2);
    g.fillEllipse(px(DOC_D, 0), py(DOC_D, 0, 0) + 0.3, 9.5, 3.6);

    // ================================================== wheel renderer ====
    // A wheel is a vertical disc in the travel plane: rim(θ) = C + U·cosθ +
    // V·sinθ with U along travel (min-width cheat so it never knife-edges)
    // and V vertical. Rolling forward = θ decreasing (top moves forward);
    // 3 spoke-gaps (3π/4) per stride keeps the 8-spoke pattern loop-exact.
    const spin = isMoving ? -walkPh * (3 * Math.PI / 4) : 0;
    const drawWheel = (side: number): void => {
        const cx = px(0, side * TRACK_W);
        const cy = py(0, side * TRACK_W, WHEEL_R);
        let ux = cosA;
        if (Math.abs(ux) < 0.3) ux = ux >= 0 ? 0.3 : -0.3; // keep some face
        const uX = ux * WHEEL_R, uY = sinA * 0.5 * WHEEL_R;
        const vX = 0, vY = -WHEEL_R * 0.94;
        const rim = (th: number, s: number): [number, number] =>
            [cx + (uX * Math.cos(th) + vX * Math.sin(th)) * s,
             cy + (uY * Math.cos(th) + vY * Math.sin(th)) * s];
        // wheel contact shadow
        g.fillStyle(0x000000, 0.18);
        g.fillEllipse(cx, cy + WHEEL_R * 0.94 + 0.4, WHEEL_R * 1.15, 2.6);
        // tire
        g.lineStyle(2.1, rimCol, 1);
        g.beginPath();
        const p0 = rim(0, 1);
        g.moveTo(p0[0], p0[1]);
        for (let i = 1; i <= 20; i++) {
            const p = rim((i / 20) * Math.PI * 2, 1);
            g.lineTo(p[0], p[1]);
        }
        g.closePath();
        g.strokePath();
        // inner rim highlight
        g.lineStyle(0.8, shade(rimCol, 1.35), 1);
        g.beginPath();
        const q0 = rim(0, 0.82);
        g.moveTo(q0[0], q0[1]);
        for (let i = 1; i <= 16; i++) {
            const p = rim((i / 16) * Math.PI * 2, 0.82);
            g.lineTo(p[0], p[1]);
        }
        g.closePath();
        g.strokePath();
        if (L3) { // gold pinstripe — subtle accent, not a mass
            g.lineStyle(0.6, 0xdaa520, 1);
            g.beginPath();
            const s0 = rim(0, 0.92);
            g.moveTo(s0[0], s0[1]);
            for (let i = 1; i <= 16; i++) {
                const p = rim((i / 16) * Math.PI * 2, 0.92);
                g.lineTo(p[0], p[1]);
            }
            g.closePath();
            g.strokePath();
        }
        // spokes
        g.lineStyle(1.1, spokeCol, 1);
        for (let k = 0; k < 8; k++) {
            const th = spin + (k * Math.PI) / 4;
            const i0 = rim(th, 0.2);
            const i1 = rim(th, 0.84);
            g.lineBetween(i0[0], i0[1], i1[0], i1[1]);
        }
        // hub
        g.fillStyle(woodDark, 1);
        g.fillCircle(cx, cy, 1.7);
        g.fillStyle(L2 ? 0x8a8f99 : shade(wood, 1.2), 1);
        g.fillCircle(cx, cy, 0.9);
    };

    // Which wheel is nearer the viewer (larger screen y offset across-axis).
    const nearSide = cosA >= 0 ? 1 : -1;

    // ================================================== the bellows =======
    // Leather accordion under the rear lid overhang; squashes with the pump.
    const drawBellows = (): void => {
        const bh = 2.6 * (1 - Math.abs(pump) * 0.45);
        const bd = CH_D0 - 2.4;
        const top = [px(bd, 0), py(bd, 0, hEff(bd, CH_H0 + 2.2 + bh))];
        const bl = [px(bd, -2.1), py(bd, -2.1, hEff(bd, CH_H0 + 1.2))];
        const br = [px(bd, 2.1), py(bd, 2.1, hEff(bd, CH_H0 + 1.2))];
        const rl = [px(CH_D0, -2.4), py(CH_D0, -2.4, hEff(CH_D0, CH_H0 + 1.0))];
        const rr = [px(CH_D0, 2.4), py(CH_D0, 2.4, hEff(CH_D0, CH_H0 + 1.0))];
        const rt = [px(CH_D0, 0), py(CH_D0, 0, hEff(CH_D0, CH_H0 + 2.8 + bh))];
        quad([bl, br, rr, rt, rl], 0x99744a);
        g.lineStyle(0.7, 0x6a4d2e, 1);
        g.lineBetween(top[0], top[1], bl[0], bl[1]);
        g.lineBetween(top[0], top[1], br[0], br[1]);
        g.lineBetween((bl[0] + rl[0]) / 2, (bl[1] + rl[1]) / 2, (br[0] + rr[0]) / 2, (br[1] + rr[1]) / 2);
    };

    // ================================================== the chest =========
    const drawChest = (): void => {
        const ws = cosA >= 0 ? 1 : -1;  // visible side face
        const es = sinA >= 0 ? 1 : -1;  // visible end face
        const de = es > 0 ? CH_D1 : CH_D0;

        // Face brightness: lit when the outward normal points toward the NW
        // light (screen-left), shadowed otherwise.
        const sideMul = -sinA * ws < 0 ? 1.0 : 0.8;
        const endMul = cosA * es < 0 ? 1.0 : 0.8;

        // side face
        quad([
            [px(CH_D0, ws * CH_W), py(CH_D0, ws * CH_W, hEff(CH_D0, CH_H0))],
            [px(CH_D1, ws * CH_W), py(CH_D1, ws * CH_W, hEff(CH_D1, CH_H0))],
            [px(CH_D1, ws * CH_W), py(CH_D1, ws * CH_W, hEff(CH_D1, CH_H1))],
            [px(CH_D0, ws * CH_W), py(CH_D0, ws * CH_W, hEff(CH_D0, CH_H1))]
        ], shade(chest, sideMul));
        // end face
        quad([
            [px(de, CH_W), py(de, CH_W, hEff(de, CH_H0))],
            [px(de, -CH_W), py(de, -CH_W, hEff(de, CH_H0))],
            [px(de, -CH_W), py(de, -CH_W, hEff(de, CH_H1))],
            [px(de, CH_W), py(de, CH_W, hEff(de, CH_H1))]
        ], shade(chest, endMul * 0.94));

        // plank seams on the side face
        g.lineStyle(0.7, shade(chest, sideMul * 0.72), 1);
        for (const hk of [CH_H0 + 2.7, CH_H0 + 5.4]) {
            g.lineBetween(
                px(CH_D0 + 0.4, ws * CH_W), py(CH_D0 + 0.4, ws * CH_W, hEff(CH_D0 + 0.4, hk)),
                px(CH_D1 - 0.4, ws * CH_W), py(CH_D1 - 0.4, ws * CH_W, hEff(CH_D1 - 0.4, hk))
            );
        }
        // corner straps (rope / brass / gold by level)
        for (const dk of [CH_D0 + 1.4, CH_D1 - 1.4]) {
            quad([
                [px(dk - 0.55, ws * CH_W), py(dk - 0.55, ws * CH_W, hEff(dk, CH_H0))],
                [px(dk + 0.55, ws * CH_W), py(dk + 0.55, ws * CH_W, hEff(dk, CH_H0))],
                [px(dk + 0.55, ws * CH_W), py(dk + 0.55, ws * CH_W, hEff(dk, CH_H1))],
                [px(dk - 0.55, ws * CH_W), py(dk - 0.55, ws * CH_W, hEff(dk, CH_H1))]
            ], shade(strap, sideMul));
        }

        // red-cross panel — the medic signature. Side face (front half, clear
        // of the wheel) and end face, each gated on real face area.
        const panel = (
            cD: number, cW: number, cH: number,
            eDx: number, eDy: number, pw: number, ph: number
        ): void => {
            const cx = px(cD, cW), cy = py(cD, cW, hEff(cD, cH));
            quad([
                [cx - eDx * pw, cy - eDy * pw + ph], [cx + eDx * pw, cy + eDy * pw + ph],
                [cx + eDx * pw, cy + eDy * pw - ph], [cx - eDx * pw, cy - eDy * pw - ph]
            ], cream);
            quad([
                [cx - eDx * pw * 0.72, cy - eDy * pw * 0.72 + ph * 0.3],
                [cx + eDx * pw * 0.72, cy + eDy * pw * 0.72 + ph * 0.3],
                [cx + eDx * pw * 0.72, cy + eDy * pw * 0.72 - ph * 0.3],
                [cx - eDx * pw * 0.72, cy - eDy * pw * 0.72 - ph * 0.3]
            ], crossRed);
            quad([
                [cx - eDx * pw * 0.26, cy - eDy * pw * 0.26 + ph * 0.78],
                [cx + eDx * pw * 0.26, cy + eDy * pw * 0.26 + ph * 0.78],
                [cx + eDx * pw * 0.26, cy + eDy * pw * 0.26 - ph * 0.78],
                [cx - eDx * pw * 0.26, cy - eDy * pw * 0.26 - ph * 0.78]
            ], crossRed);
        };
        if (Math.abs(cosA) > 0.35) panel(5.4, ws * CH_W, 9.7, cosA, sinA * 0.5, 2.6, 2.1);
        if (Math.abs(sinA) > 0.35) panel(de, 0, 9.7, -sinA, cosA * 0.5, 2.5, 2.1);

        // lid (lightest) + rim
        const lidPts = [
            [px(CH_D0 - 0.5, CH_W + 0.5), py(CH_D0 - 0.5, CH_W + 0.5, hEff(CH_D0, CH_H1))],
            [px(CH_D1 + 0.5, CH_W + 0.5), py(CH_D1 + 0.5, CH_W + 0.5, hEff(CH_D1, CH_H1))],
            [px(CH_D1 + 0.5, -CH_W - 0.5), py(CH_D1 + 0.5, -CH_W - 0.5, hEff(CH_D1, CH_H1))],
            [px(CH_D0 - 0.5, -CH_W - 0.5), py(CH_D0 - 0.5, -CH_W - 0.5, hEff(CH_D0, CH_H1))]
        ];
        quad(lidPts, shade(chest, 1.22));
        g.lineStyle(0.9, shade(chest, 0.62), 1);
        g.beginPath();
        g.moveTo(lidPts[0][0], lidPts[0][1]);
        for (let i = 1; i < 4; i++) g.lineTo(lidPts[i][0], lidPts[i][1]);
        g.closePath();
        g.strokePath();
        if (L3) { // gold pinstripe inside the lid rim
            g.lineStyle(0.6, 0xdaa520, 1);
            g.beginPath();
            g.moveTo(px(CH_D0 + 0.4, CH_W - 0.4), py(CH_D0 + 0.4, CH_W - 0.4, hEff(CH_D0 + 0.4, CH_H1)));
            g.lineTo(px(CH_D1 - 0.4, CH_W - 0.4), py(CH_D1 - 0.4, CH_W - 0.4, hEff(CH_D1 - 0.4, CH_H1)));
            g.lineTo(px(CH_D1 - 0.4, -CH_W + 0.4), py(CH_D1 - 0.4, -CH_W + 0.4, hEff(CH_D1 - 0.4, CH_H1)));
            g.lineTo(px(CH_D0 + 0.4, -CH_W + 0.4), py(CH_D0 + 0.4, -CH_W + 0.4, hEff(CH_D0 + 0.4, CH_H1)));
            g.closePath();
            g.strokePath();
        }
    };

    // ============================================= lid kit: dome + vials ==
    const drawLidKit = (): void => {
        // --- the elixir dome (the buildup telegraph), amidships-rear.
        const domeD = -0.8;
        const dx = px(domeD, 0), dy = py(domeD, 0, hEff(domeD, CH_H1));
        g.fillStyle(L2 ? 0xa8873f : woodDark, 1); // mount collar
        g.fillEllipse(dx, dy, 6.2, 3.1);
        const domeCY = dy - 3.1;
        g.fillStyle(greenDim, 1);
        g.fillCircle(dx, domeCY, 2.7);
        // rising green: fills with the pump ramp, flashes on the strike,
        // shimmers on the idle harmonic between pulses.
        const fillLvl = combatStill ? Math.max(windup, strike) : 0;
        const shimmer = !isMoving && !combatStill ? 0.18 + 0.14 * id2 : 0.18;
        const rIn = 0.9 + 1.6 * Math.max(fillLvl, shimmer);
        g.fillStyle(fillLvl > 0.05 ? greenMid : shade(greenMid, 0.82), 1);
        g.fillCircle(dx, domeCY + (1 - Math.max(fillLvl, shimmer)) * 0.9, rIn);
        if (strike > 0) {
            g.fillStyle(greenHot, 1);
            g.fillCircle(dx, domeCY, 1.1 + strike * 1.2);
        }
        g.lineStyle(0.8, glassRim, 1);
        g.strokeCircle(dx, domeCY, 2.8);
        g.fillStyle(0xffffff, 1); // fixed glass glint
        g.fillCircle(dx - 1.0, domeCY - 1.1, 0.5);

        // --- corked vials racked along the lid front (rattle on stride).
        const vials = L2 ? [-3.9, -1.3, 1.3, 3.9] : [-2.6, 0, 2.6];
        for (let i = 0; i < vials.length; i++) {
            const rat = isMoving ? Math.abs(Math.sin(walkPh * Math.PI * 4 + i * 2.1)) * 0.55 : 0;
            const vx = px(6.6, vials[i]);
            const vy = py(6.6, vials[i], hEff(6.6, CH_H1)) - rat;
            g.fillStyle(0xd7e8dc, 1);
            g.fillRect(vx - 1.0, vy - 3.4, 2.0, 3.4);
            g.fillStyle(0x58c878, 1);
            g.fillRect(vx - 1.0, vy - 1.9, 2.0, 1.9);
            g.fillStyle(0xb08a58, 1);
            g.fillRect(vx - 0.6, vy - 4.3, 1.2, 1.0);
            // idle glint: swings well past 16/255 on the declared period
            g.fillStyle(shade(0xd7e8dc, 1.06 + 0.14 * id1), 1);
            g.fillRect(vx - 0.7, vy - 3.2, 0.6, 1.5);
        }
        // rack rail
        g.lineStyle(0.9, woodDark, 1);
        g.lineBetween(
            px(6.6, -CH_W + 0.6), py(6.6, -CH_W + 0.6, hEff(6.6, CH_H1 + 1.4)),
            px(6.6, CH_W - 0.6), py(6.6, CH_W - 0.6, hEff(6.6, CH_H1 + 1.4))
        );

        if (L3) { // gold finial on the lid front edge — accent only
            g.fillStyle(0xdaa520, 1);
            g.fillCircle(px(CH_D1 - 0.6, 0), py(CH_D1 - 0.6, 0, hEff(CH_D1 - 0.6, CH_H1 + 0.9)), 0.9);
        }
    };

    // ==================================== herb bundles + the L3 pennant ===
    const drawFrontHangings = (): void => {
        const sides = L2 ? [-1, 1] : [1];
        for (const s of sides) {
            const hx = px(CH_D1 + 0.6, s * (CH_W - 0.8));
            const hy = py(CH_D1 + 0.6, s * (CH_W - 0.8), hEff(CH_D1, CH_H1 - 0.4));
            const bx = hx + sway * 0.9;
            const by = hy + 4.6;
            g.lineStyle(0.7, 0x9c8a62, 1);
            g.lineBetween(hx, hy, bx, by - 1.8);
            g.fillStyle(0x3a5c2a, 1);
            g.fillCircle(bx - 0.9, by - 0.4, 1.5);
            g.fillCircle(bx + 0.8, by - 0.6, 1.4);
            g.fillStyle(0x4f7a3a, 1);
            g.fillCircle(bx, by + 0.6, 1.7);
            g.fillStyle(0x9c8a62, 1);
            g.fillRect(bx - 0.7, by - 2.2, 1.4, 0.9); // twine tie
        }
        if (L3) {
            // small cream pennant with a red cross on a front staff
            const bx = px(CH_D1 - 1.0, -(CH_W - 1.0));
            const by = py(CH_D1 - 1.0, -(CH_W - 1.0), hEff(CH_D1 - 1.0, CH_H1));
            const topY = by - 6.4;
            g.lineStyle(0.9, woodDark, 1);
            g.lineBetween(bx, by, bx, topY);
            g.fillStyle(0xdaa520, 1);
            g.fillCircle(bx, topY - 0.5, 0.7);
            const wave = (isMoving ? Math.sin(walkPh * Math.PI * 2 + 0.7) : id1) * 1.2;
            quad([[bx, topY], [bx + 6.2, topY + 1.1 + wave * 0.5], [bx, topY + 3.4]], cream);
            g.fillStyle(crossRed, 1);
            g.fillRect(bx + 1.3, topY + 1.0, 1.9, 0.7);
            g.fillRect(bx + 1.9, topY + 0.4, 0.7, 1.9);
        }
    };

    // =========================================== shafts + the pump bar ====
    const pumpLift = pump * 2.4;
    const barD = DOC_D + 3.4;
    const barH = 4.8 + pumpLift;
    const drawShafts = (): void => {
        for (const s of [-1, 1]) {
            limb(
                wood,
                px(CH_D0 + 0.4, s * (CH_W - 1.0)), py(CH_D0 + 0.4, s * (CH_W - 1.0), hEff(CH_D0 + 0.4, CH_H0 + 1.6)),
                px(barD, s * 2.6), py(barD, s * 2.6, barH),
                1.5
            );
        }
        limb(woodDark, px(barD, -2.6), py(barD, -2.6, barH), px(barD, 2.6), py(barD, 2.6, barH), 1.8);
        if (L3) {
            g.fillStyle(0xdaa520, 1);
            g.fillCircle(px(barD, -2.6), py(barD, -2.6, barH), 0.8);
            g.fillCircle(px(barD, 2.6), py(barD, 2.6, barH), 0.8);
        }
    };

    // ================================================== the doctor ========
    // Plague doctor at villager scale: full robe (no skin shows), wide-brim
    // hat, pale beak mask. He leans into the push when walking and bows into
    // the bar when pumping.
    const dgx = px(DOC_D, 0);
    const dgy = py(DOC_D, 0, 0); // his ground line
    const leanX = (isMoving ? 2.0 : 0) * cosA;
    const leanY = (isMoving ? 2.0 : 0) * sinA * 0.5;
    const bow = Math.abs(pump) * 0.9;

    const drawDoctorBody = (): void => {
        // boots stride along the travel axis
        const swing = isMoving ? walkS * 2.1 : 0;
        g.fillStyle(0x241d16, 1);
        g.fillEllipse(dgx + cosA * swing - sinA * 1.7, dgy - 0.3 + (sinA * swing + cosA * 1.7) * 0.5, 2.8, 1.5);
        g.fillEllipse(dgx - cosA * swing + sinA * 1.7, dgy - 0.3 + (-sinA * swing - cosA * 1.7) * 0.5, 2.8, 1.5);
        // robe skirt (hem sways against the stride)
        const hemSway = isMoving ? -walkS * 0.8 : id1 * 0.4;
        quad([
            [dgx - 4.3 + hemSway, dgy - 1.2],
            [dgx + 4.3 + hemSway, dgy - 1.2],
            [dgx + 3.1 + leanX, dgy - 10.4 - lift + bow + leanY],
            [dgx - 3.1 + leanX, dgy - 10.4 - lift + bow + leanY]
        ], robe);
        g.lineStyle(0.8, robeDark, 1);
        g.lineBetween(dgx + hemSway * 0.6, dgy - 1.6, dgx + leanX * 0.8, dgy - 9.6 - lift + bow);
        if (L3) { // gold hem thread
            g.lineStyle(0.6, 0xdaa520, 1);
            g.lineBetween(dgx - 4.0 + hemSway, dgy - 1.6, dgx + 4.0 + hemSway, dgy - 1.6);
        }
        // torso + belt
        const tx = dgx + leanX, ty = dgy - 11.6 - lift + bow + leanY;
        g.fillStyle(robe, 1);
        g.fillCircle(tx, ty, 4.1);
        g.fillStyle(robeDark, 1);
        g.fillRect(tx - 3.5, ty + 1.9, 7.0, 1.5);
        // hip satchel with a mini cross
        const sx = dgx - sinA * 3.4 + leanX * 0.5;
        const sy = dgy - 8.9 - lift * 0.5 + (cosA * 3.4) * 0.5;
        g.fillStyle(0x6b4d2e, 1);
        g.fillRect(sx - 1.6, sy - 1.2, 3.2, 2.5);
        g.fillStyle(cream, 1);
        g.fillRect(sx - 0.8, sy - 0.2, 1.6, 0.5);
        g.fillRect(sx - 0.25, sy - 0.75, 0.5, 1.6);

        // ---- head: hood, beak, goggle, wide-brim hat
        const hcx = tx + leanX * 0.25;
        const hcy = ty - 6.1;
        const ga = a + glance;
        const gc = Math.cos(ga), gs = Math.sin(ga);
        const beak = (): void => {
            const tipX = hcx + gc * 6.0;
            const tipY = hcy + gs * 0.5 * 6.0 + 1.4;
            const b1x = hcx - gs * 1.4, b1y = hcy + gc * 0.7 - 0.9;
            const b2x = hcx + gs * 1.4, b2y = hcy - gc * 0.7 + 0.9;
            g.fillStyle(bone, 1);
            g.fillTriangle(b1x, b1y, b2x, b2y, tipX, tipY);
            g.lineStyle(0.6, boneDark, 1);
            g.lineBetween(hcx + gc * 1.2, hcy + gs * 0.6 + 0.3, tipX, tipY);
        };
        if (gs < -0.25) beak(); // pointing up-screen: mostly hidden by the head
        g.fillStyle(robeDark, 1); // hood ball
        g.fillCircle(hcx, hcy, 3.0);
        if (gs >= -0.25) beak();
        if (gs > -0.1) { // single round goggle, only when it faces the viewer
            const ox = hcx + gc * 1.6, oy = hcy + gs * 0.8 - 0.6;
            g.fillStyle(L2 ? 0xa8873f : 0x8f8877, 1);
            g.fillCircle(ox, oy, 1.25);
            g.fillStyle(0x1b1e24, 1);
            g.fillCircle(ox, oy, 0.8);
        }
        // hat: brim ellipse + crown dome + band
        g.fillStyle(shade(hat, 0.8), 1);
        g.fillEllipse(hcx, hcy - 1.7, 10.0, 3.6);
        g.fillStyle(hat, 1);
        g.fillEllipse(hcx, hcy - 2.1, 9.2, 3.0);
        g.fillCircle(hcx, hcy - 3.9, 2.6);
        g.fillStyle(L3 ? 0xdaa520 : L2 ? 0xa8873f : 0x4a3a28, 1);
        g.fillRect(hcx - 2.6, hcy - 3.5, 5.2, 1.0);
    };

    const drawDoctorArms = (): void => {
        const tx = dgx + leanX, ty = dgy - 11.6 - lift + bow + leanY;
        const ws = cosA >= 0 ? 1 : -1; // viewer-side arm carries the flask
        for (const s of [-1, 1]) {
            const shX = tx - sinA * s * 2.7, shY = ty + cosA * s * 1.35 + 0.6;
            if (s === ws && flask > 0.05) continue; // that arm is hoisting
            limb(robe, shX, shY, px(barD, s * 2.3), py(barD, s * 2.3, barH), 1.9);
            g.fillStyle(glove, 1);
            g.fillCircle(px(barD, s * 2.3), py(barD, s * 2.3, barH), 1.25);
        }
        if (flask > 0.05) {
            // the release: flask thrust overhead, glowing green
            const shX = tx - sinA * ws * 2.7, shY = ty + cosA * ws * 1.35 + 0.6;
            const fhX = tx - sinA * ws * 3.4;
            const fhY = ty - 7.5 - flask * 5.0;
            limb(robe, shX, shY, fhX, fhY, 1.9);
            g.fillStyle(glove, 1);
            g.fillCircle(fhX, fhY, 1.25);
            g.fillStyle(0xd7e8dc, 1);
            g.fillRect(fhX - 1.3, fhY - 5.0, 2.6, 3.8);
            g.fillStyle(flask > 0.6 ? greenHot : greenMid, 1);
            g.fillRect(fhX - 1.3, fhY - 4.2, 2.6, 3.0);
            g.fillStyle(0xb08a58, 1);
            g.fillRect(fhX - 0.7, fhY - 6.0, 1.4, 1.1);
            if (flask > 0.7) { // opaque light-rays at the peak
                g.lineStyle(1.0, greenHot, 1);
                const rr = 3.0 + (1 - flask) * 2.0;
                const fcy = fhY - 2.7;
                g.lineBetween(fhX - rr, fcy, fhX - rr + 1.6, fcy);
                g.lineBetween(fhX + rr - 1.6, fcy, fhX + rr, fcy);
                g.lineBetween(fhX, fcy - rr * 0.8, fhX, fcy - rr * 0.8 + 1.4);
                g.lineBetween(fhX, fcy + rr * 0.8 - 1.4, fhX, fcy + rr * 0.8);
            }
        }
    };

    // ================================================== paint order =======
    const drawCart = (): void => {
        drawWheel(-nearSide);
        if (sinA >= 0) drawBellows(); // rear points up-screen: tuck it behind
        // axle bar
        limb(woodDark, px(0, -TRACK_W + 0.8), py(0, -TRACK_W + 0.8, WHEEL_R), px(0, TRACK_W - 0.8), py(0, TRACK_W - 0.8, WHEEL_R), 2.0);
        if (sinA < 0) { // front hangings on the far side go under the chest
            drawFrontHangings();
            drawChest();
            drawBellows();
        } else {
            drawChest();
            drawFrontHangings();
        }
        drawLidKit();
        drawWheel(nearSide);
    };

    if (sinA >= 0) {
        // facing down-screen: doctor is the far figure
        drawDoctorBody();
        drawShafts();
        drawDoctorArms();
        drawCart();
    } else {
        drawCart();
        drawShafts();
        drawDoctorBody();
        drawDoctorArms();
    }
}
