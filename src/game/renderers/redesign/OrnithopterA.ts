import type Phaser from 'phaser';

type G = Phaser.GameObjects.Graphics;
/** Craft-frame point: [d (along heading, +fwd), w (across, +starboard), h (screen-vertical, −up)]. */
type V3 = readonly [number, number, number];

/**
 * ORNITHOPTER — design A, "Codex Wing".
 *
 * Da Vinci's flapping-wing machine as drawn in the codices: two bat-form
 * wings of pale linen stretched over dark spruce arm-spars with four
 * radiating finger-ribs and a scalloped trailing edge; a tiny wicker gondola
 * with a leaning, goggled pilot gripping the shoulder cross-spar; a small
 * linen tail rudder trailing on its boom; an under-slung bomb rack (bombs are
 * engine projectiles — the rack only has to READ, there is no attack pose).
 *
 * FIRST AIR UNIT: the craft is rendered at ALT authoring-px above its tile with a
 * small detached ground-shadow ellipse on the ground line — the two never
 * fuse (lowest bomb tip stays > 20 px above the shadow at full bob).
 *
 * MOTION (all deterministic in `time` — iron rule 3; no attack frames):
 *  - FLIGHT (isMoving): one full flap loop per EXACTLY 500 ms (the bake
 *    stride). The hull surges upward mid-downstroke (peak lift), pitches
 *    nose-up with the surge, and the rudder trails the stroke on a phase lag
 *    of the same period.
 *  - HOVER (idle): declared period 2000 ms (a 250 ms multiple). Terms are
 *    exact harmonics: whole-body bob ±1.6 px on the 2000 ms fundamental
 *    (≥1.5 world px — survives the ambient probe's quantize threshold),
 *    sustaining flap + rudder sway on the exact 1000 ms second harmonic.
 *
 * PAINT: every body texel is OPAQUE (alpha 1) — baked frames must not carry
 * translucency. The only translucent paint is the detached ground-shadow
 * ellipse, a ground effect per the committed air-placeholder precedent.
 *
 * LIGHT: NW — lit linen band along each wing's leading edge, lighter wash on
 * the gondola's up-left flank, NW glint flecks on iron/bomb rounds.
 *
 * LEVELS: L1 humble (raw linen, lashed wood, 2 round bombs) → L2 iron
 * (riveted wrist brackets, iron rim/rack, finned bombs ×3) → L3 refined
 * (warm parchment linen, brass rim, small gold spar-tip beads, wing
 * roundels, gold bomb bands — accents only, never white masses).
 */

const SPAN = 24; // half wingspan, world px
// Runtime presents this deliberately fine-lined machine at 1.2x on every
// world surface (live, replay, camp, and vector fallback). 21 * 1.2 = 25.2,
// so its hull sits 0.8 world px LOWER than the former ALT=26 silhouette while
// the enlarged pilot/rig remains clear of an ordinary max-level wall run.
const ALT = 21;
// The runtime multiplier must not drag the detached shadow off its tile:
// 7.9167 * 1.2 = the shared 9.5 px troop ground line.
const GROUND_Y = 7.9167;
const DIHEDRAL = 1.4; // resting upward wing angle (h px at the tip)
const FLAP_AMP = 6.5; // wing-tip vertical throw at full flap
const STRIDE_MS = 500; // flight flap period — TROOP_PARAMS stride
const IDLE_MS = 2000; // declared hover period (250 ms multiple)

/** Multiply a 0xRRGGBB colour toward dark (m<1) or light (m>1). */
function shade(c: number, m: number): number {
    const r = Math.max(0, Math.min(255, Math.round(((c >> 16) & 0xff) * m)));
    const g = Math.max(0, Math.min(255, Math.round(((c >> 8) & 0xff) * m)));
    const b = Math.max(0, Math.min(255, Math.round((c & 0xff) * m)));
    return (r << 16) | (g << 8) | b;
}

/** Linear blend a→b by t. */
function mix(a: number, b: number, t: number): number {
    const r = Math.round(((a >> 16) & 0xff) * (1 - t) + ((b >> 16) & 0xff) * t);
    const g = Math.round(((a >> 8) & 0xff) * (1 - t) + ((b >> 8) & 0xff) * t);
    const bl = Math.round((a & 0xff) * (1 - t) + (b & 0xff) * t);
    return (r << 16) | (g << 8) | bl;
}

/** One spar/rib segment: a thick opaque quad from (x0,y0) to (x1,y1). */
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

/** Closed opaque polygon from projected screen points. */
function poly(g: G, color: number, pts: Array<readonly [number, number]>): void {
    g.fillStyle(color, 1);
    g.beginPath();
    g.moveTo(pts[0][0], pts[0][1]);
    for (let i = 1; i < pts.length; i++) g.lineTo(pts[i][0], pts[i][1]);
    g.closePath();
    g.fillPath();
}

export function drawOrnithopterA(
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
    const lvl = Math.max(1, Math.min(3, Math.round(troopLevel || 1)));

    // ---- owner palettes: enemy = darker, red-shifted (troop precedent) ----
    const pal = (c: number): number => (isPlayer ? c : shade(mix(c, 0x5a2822, 0.3), 0.84));
    const CANVAS = pal(lvl === 3 ? 0xdccfa8 : lvl === 2 ? 0xc3b28a : 0xd2c49e);
    const CANVAS_LT = shade(CANVAS, 1.14);
    const SPRUCE = pal(0x4a3826);
    const SPRUCE_LT = pal(0x64492e);
    const WICKER = pal(0x97764a);
    const WICKER_DK = pal(0x6f5530);
    const RIM = pal(lvl === 3 ? 0xc9992e : lvl === 2 ? 0x5b626b : 0x6b5133);
    const IRON = pal(0x4c525a);
    const IRON_LT = pal(0x8b929c);
    const GOLD = pal(0xdaa520);
    const BOMB = pal(0x33302c);
    const SKIN = pal(0xd9a877);
    const CAP = pal(0x54422e);
    const TUNIC = pal(0x6f5638);

    // ---- motion (deterministic f(time); exact harmonics per contract) ----
    let flapH: number; // +1 wings raised … −1 wings swept down
    let surge: number; // +1 at mid-DOWNstroke (peak lift) / idle bob driver
    let sway: number; // rudder-tip across-aim deflection, world px
    if (isMoving) {
        const ph = (((time % STRIDE_MS) + STRIDE_MS) % STRIDE_MS) / STRIDE_MS;
        const w0 = ph * Math.PI * 2;
        flapH = Math.sin(w0);
        surge = -Math.cos(w0);
        sway = Math.sin(w0 - 1.2) * 2.2;
    } else {
        const ph = (((time % IDLE_MS) + IDLE_MS) % IDLE_MS) / IDLE_MS;
        const w1 = ph * Math.PI * 2; // 2000 ms fundamental
        // A hover still has to generate lift. At 0.4 the wing tip moved only
        // ~2 baked texels and the 1.6 px hull bob visually swallowed it, so
        // the craft read as a rigid sprite floating in place. Keep the exact
        // 1000 ms harmonic, but give the sustaining flap an unmistakable
        // ±5.2 authoring-px tip throw (still gentler than flight's ±6.5).
        flapH = Math.sin(w1 * 2) * 0.8;
        surge = Math.sin(w1); // 2000 ms whole-body bob
        sway = Math.sin(w1 * 2 - 0.9) * 1.0;
    }
    const bob = -surge * (isMoving ? 1.8 : 1.6); // negative = higher
    const pitch = surge * (isMoving ? -0.1 : -0.04); // h per +d: nose up on lift

    // ---- craft-frame → screen projection (iso squash 0.5 on depth) ----
    const ca = Math.cos(facingAngle), sa = Math.sin(facingAngle);
    const BY = -ALT + bob; // hull datum, well above the ground line
    const SX = (d: number, w: number): number => ca * d - sa * w;
    const SY = (d: number, w: number, h: number): number =>
        BY + h + sa * d * 0.5 + ca * w * 0.34 + d * pitch;
    const pt = (p: V3): [number, number] => [SX(p[0], p[1]), SY(p[0], p[1], p[2])];
    /** Wing vertical lift at |w| from the root — dihedral + flap, linear out. */
    const lift = (aw: number): number => -(aw / SPAN) * (DIHEDRAL + flapH * FLAP_AMP);

    // ================= 1. detached ground shadow (never fused) =============
    // The one translucent paint: a soft dark-green ellipse on the ground far
    // below the craft (air-placeholder precedent). It stretches as the wings
    // spread horizontally (|sa|) and breathes faintly with the surge.
    const shW = 16 + 8 * Math.abs(sa) + surge * 0.7;
    g.fillStyle(0x101c0c, 0.18);
    g.fillEllipse(0, GROUND_Y, shW, shW * 0.36);

    // ================= 2. wings (far first — aim-aware layering) ===========
    const drawWing = (s: number, mul: number): void => {
        const L = (c: number): number => shade(c, mul);
        // NB: the wing is h-FLAT front-to-back (≤0.8 px slope). A tilted
        // surface cancels the projected chord at the cardinal headings and
        // the membrane collapses to a sliver — only the lift term (span-wise)
        // may bend the wing.
        const R: V3 = [1.8, 1.2 * s, -6.0]; // shoulder root
        const WRb: V3 = [3.4, 7.5 * s, -6.2 + lift(7.5)]; // leading-edge bow
        const WR: V3 = [4.0, 12.0 * s, -6.3 + lift(12.0)]; // wrist joint
        const F1: V3 = [7.4, 24.0 * s, -6.4 + lift(24.0)]; // longest finger
        const F2: V3 = [0.2, 21.5 * s, -6.1 + lift(21.5)];
        const F3: V3 = [-4.6, 16.0 * s, -5.8 + lift(16.0)];
        const F4: V3 = [-7.2, 9.0 * s, -5.5 + lift(9.0)];
        const RT: V3 = [-7.8, 1.2 * s, -5.2]; // trailing root, near the tail
        // Scalloped trailing edge: midpoints pulled toward the wrist.
        const scal = (a: V3, b: V3): V3 => [
            (a[0] + b[0]) / 2 + (WR[0] - (a[0] + b[0]) / 2) * 0.18,
            (a[1] + b[1]) / 2 + (WR[1] - (a[1] + b[1]) / 2) * 0.18,
            (a[2] + b[2]) / 2 + (WR[2] - (a[2] + b[2]) / 2) * 0.18,
        ];
        const m12 = scal(F1, F2), m23 = scal(F2, F3), m34 = scal(F3, F4), m4t = scal(F4, RT);
        // Membrane (opaque linen).
        poly(g, L(CANVAS), [R, WRb, WR, F1, m12, F2, m23, F3, m34, F4, m4t, RT].map(pt));
        // NW-lit band along the leading edge (opaque lighter linen).
        const ins = (p: V3): V3 => [p[0] - 2.2, p[1] - 1.5 * s, p[2] + 0.5];
        poly(g, L(CANVAS_LT), [R, WR, F1, ins(F1), ins(WR), ins(R)].map(pt));
        // L3: small gold roundel on the membrane (accent, not a mass).
        if (lvl === 3) {
            const roc: V3 = [0.2, 13.5 * s, -5.6 + lift(13.5)];
            const [rx, ry] = pt(roc);
            g.fillStyle(L(GOLD), 1);
            g.fillCircle(rx, ry, 1.8);
            g.fillStyle(L(shade(GOLD, 0.72)), 1);
            g.fillCircle(rx, ry, 0.9);
        }
        // Finger ribs radiating from the wrist (dark spruce over the linen).
        for (const [f, w] of [[F2, 0.95], [F3, 0.9], [F4, 0.85]] as Array<[V3, number]>) {
            const a = pt(WR), b = pt(f);
            limb(g, L(SPRUCE_LT), a[0], a[1], b[0], b[1], w);
        }
        // Arm spar: root → bow → wrist → longest finger (the leading edge).
        const pR = pt(R), pWRb = pt(WRb), pWR = pt(WR), pF1 = pt(F1);
        limb(g, L(SPRUCE), pR[0], pR[1], pWRb[0], pWRb[1], 1.6);
        limb(g, L(SPRUCE), pWRb[0], pWRb[1], pWR[0], pWR[1], 1.6);
        limb(g, L(SPRUCE), pWR[0], pWR[1], pF1[0], pF1[1], 1.3);
        // Wrist fitting: lashed wood → riveted iron → iron with a gold pin.
        if (lvl >= 2) {
            g.fillStyle(L(IRON), 1);
            g.fillCircle(pWR[0], pWR[1], 1.5);
            g.fillStyle(L(lvl === 3 ? GOLD : IRON_LT), 1);
            g.fillCircle(pWR[0] - 0.4, pWR[1] - 0.4, 0.6);
        } else {
            g.fillStyle(L(SPRUCE_LT), 1);
            g.fillCircle(pWR[0], pWR[1], 1.3);
        }
        // Spar-tip bead (L2 iron / L3 gold — tiny).
        if (lvl >= 2) {
            g.fillStyle(L(lvl === 3 ? GOLD : IRON_LT), 1);
            g.fillCircle(pF1[0], pF1[1], lvl === 3 ? 1.1 : 0.9);
        }
    };
    // Aim-aware layering: the wing on the up-screen side paints behind the
    // hull, the down-screen wing paints last, over it (turret precedent).
    const farS = ca < 0 ? 1 : -1;
    drawWing(farS, 0.9); // far wing, slightly shaded for depth

    // ================= 3. tail boom + linen rudder ==========================
    const drawTail = (): void => {
        const b0 = pt([-4.2, 0, -3.0]), b1 = pt([-10.6, 0, -4.0]);
        limb(g, SPRUCE, b0[0], b0[1], b1[0], b1[1], 1.2); // boom
        // Vertical linen fin, tip deflected across-aim by the trailing sway.
        const A: V3 = [-7.2, 0, -3.2];
        const B: V3 = [-11.2, sway, -7.2];
        const C: V3 = [-10.8, sway * 1.15, -1.4];
        const mBC: V3 = [
            (B[0] + C[0]) / 2 + (A[0] - (B[0] + C[0]) / 2) * 0.2,
            (B[1] + C[1]) / 2 + (A[1] - (B[1] + C[1]) / 2) * 0.2,
            (B[2] + C[2]) / 2 + (A[2] - (B[2] + C[2]) / 2) * 0.2,
        ];
        poly(g, CANVAS, [A, B, mBC, C].map(pt));
        const pA = pt(A), pB = pt(B);
        limb(g, SPRUCE, pA[0], pA[1], pB[0], pB[1], 1.0); // fin spar
        if (lvl === 3) {
            g.fillStyle(GOLD, 1);
            g.fillCircle(pB[0], pB[1], 1.0); // gold finial bead
        }
    };
    if (sa >= 0) drawTail(); // heading down-screen → tail is far: behind hull

    // ================= 4. keel + nose ======================================
    const k0 = pt([5.6, 0, -3.2]), k1 = pt([-4.4, 0, -2.8]);
    limb(g, SPRUCE_LT, k0[0], k0[1], k1[0], k1[1], 1.4);
    if (lvl >= 2) {
        g.fillStyle(lvl === 3 ? GOLD : IRON_LT, 1);
        g.fillCircle(k0[0], k0[1], 1.1); // nose cap
    }

    // ================= 5. bomb rack (under-slung; reads, never fires) ======
    // Underwing rails (aircraft hardpoints — never a centerline dangle, which
    // reads as legs). One bomb per rail at L1, two at L2+; gold bands at L3.
    const RACK = lvl >= 2 ? IRON : SPRUCE;
    for (const s of [1, -1]) {
        const ra = pt([1.8, 3.6 * s, 2.4]), rb = pt([-1.6, 3.6 * s, 2.4]);
        limb(g, RACK, ra[0], ra[1], rb[0], rb[1], 0.9);
        const spots: number[] = lvl === 1 ? [0.2] : [1.0, -0.9];
        for (const bd of spots) {
            const bx = SX(bd, 3.6 * s), by = SY(bd, 3.6 * s, 3.4);
            g.fillStyle(BOMB, 1);
            g.fillCircle(bx, by, 1.15);
            if (lvl === 3) {
                g.fillStyle(GOLD, 1);
                g.fillRect(bx - 1.0, by - 0.25, 2.0, 0.5); // gold band accent
            }
            g.fillStyle(pal(lvl >= 2 ? 0x8b929c : 0x6f767e), 1);
            g.fillCircle(bx - 0.35, by - 0.4, 0.4); // NW glint (opaque fleck)
        }
    }

    // ================= 6. wicker gondola ===================================
    // Volumetric basket: screen half-width blends the along/across extents so
    // it never collapses to a sliver at any of the 8 headings.
    const bHalf = Math.sqrt(7.3 * ca * ca + 4.4 * sa * sa);
    const bx = SX(0.2, 0), byC = SY(0.2, 0, 0.2), byT = SY(0.2, 0, -2.4);
    g.fillStyle(WICKER, 1);
    g.fillEllipse(bx, byC, bHalf * 2, 4.4); // belly
    g.fillStyle(shade(WICKER, 1.15), 1);
    g.fillEllipse(bx - bHalf * 0.35, byC - 1.2, bHalf * 0.9, 1.8); // NW light
    g.fillStyle(WICKER_DK, 1);
    g.fillRect(bx - bHalf * 0.86, byC + 0.2, bHalf * 1.72, 0.8); // weave bands
    g.fillRect(bx - bHalf * 0.66, byC + 1.3, bHalf * 1.32, 0.7);
    g.fillStyle(RIM, 1);
    g.fillEllipse(bx, byT, bHalf * 2 + 1.2, 2.2); // rim hoop
    g.fillStyle(pal(0x2c2117), 1);
    g.fillEllipse(bx, byT, bHalf * 2 - 1.4, 1.2); // open interior

    // ================= 7. pilot (leans into the stroke) ====================
    const lean = 0.5 + 0.35 * surge; // harmonic of the same period
    const shX = SX(0.9 + lean, 0), shY = SY(0.9 + lean, 0, -3.6);
    g.fillStyle(TUNIC, 1);
    g.fillEllipse(shX, shY, 3.8, 2.8); // hunched shoulders
    const hdX = SX(1.9 + lean, 0), hdY = SY(1.9 + lean, 0, -5.7);
    g.fillStyle(SKIN, 1);
    g.fillCircle(hdX, hdY, 1.9);
    g.fillStyle(CAP, 1);
    g.beginPath();
    g.arc(hdX, hdY - 0.45, 1.9, Math.PI, 0, false);
    g.closePath();
    g.fillPath(); // leather cap
    g.fillStyle(pal(0x2e2c28), 1);
    g.fillRect(hdX - 1.6, hdY - 0.55, 3.2, 0.8); // goggle band

    // ================= 8. shoulder cross-spar + gripping arm ===============
    const x0 = pt([1.8, -2.4, -6.1]), x1 = pt([1.8, 2.4, -6.1]);
    limb(g, SPRUCE, x0[0], x0[1], x1[0], x1[1], 1.3);
    const grip = pt([1.8, 1.0, -6.0]);
    limb(g, shade(TUNIC, 0.85), shX + 0.6, shY - 0.6, grip[0], grip[1], 1.2);
    g.fillStyle(SKIN, 1);
    g.fillCircle(grip[0], grip[1], 0.75); // hand on the spar

    // ================= 9. near tail + near wing (over the hull) ============
    if (sa < 0) drawTail(); // heading up-screen → tail swings toward camera
    drawWing(-farS, 1.0); // near wing, full light
}
