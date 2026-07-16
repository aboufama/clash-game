import type Phaser from 'phaser';

/**
 * GOLEM — CLEAN-ROOM DESIGN B: "THE CROMLECH WARDEN"
 *
 * A walking megalith. Not a pile of boulders — dressed monument masonry:
 * two pillar legs, a stele torso, capstone-lintel shoulders, a keystone
 * head jutting forward under a brow slab, column arms ending in lintel
 * fists that hang to the ground. The blocks are bound by a molten rune
 * core whose light leaks through the mortar seams and the chest sigil.
 *
 * DIRECTION AWARENESS: every block is a true iso box in golem body space
 * (f = forward, r = right, h = up) projected through the troop's live
 * facingAngle (read from the owning troop via the carrier — the draw
 * signature does not carry it; camera-facing fallback when the carrier is
 * loose, e.g. army-camp figures). Rotation-proof face selection (the two
 * vertical faces whose outward normals point down-screen) + NW lighting
 * from the face normal, and painter's order re-sorted per heading — the
 * silhouette genuinely differs across all 16 headings: frontal shows the
 * sigil + eyes, profile shows the head jut and stacked arms, rear shows a
 * stone spine ridge and the moss cape. No mirrored-sprite shortcut.
 *
 * ANIMATION (all deterministic in `time`):
 *  - idle breath: ONE 2000 ms loop (exact 250 ms multiple) — torso heave
 *    ±1 px (harmonic 1), seam/rune glow pulse + eye flicker (harmonic 2),
 *    knuckle drag (harmonic 1). Displacement and RGB terms both clear the
 *    bake-probe quantization thresholds.
 *  - walk: ONE 1500 ms stride (exact 250 ms multiple) — alternating pillar
 *    steps with lift, 2x-frequency stomp bob (body lowest at each plant),
 *    weight roll, counter-swinging fists, deterministic plant-dust pulses.
 *  - slam: driven ONLY by slamOffset (0→12 Quad.easeIn 200 ms — damage,
 *    shake and the scene-owned crack FX fire exactly at 12 — then 12→0
 *    easeOut 400 ms). Contract honored literally: torso/shoulders/head/arms
 *    drop by slamOffset px, planted legs/feet do not. s = slamOffset/12
 *    additionally raises the fists early (bump peaks s≈0.33) then drives
 *    them into the ground exactly at s = 1, with a seam flash + fist dust.
 *
 * LEVELS: L1 fieldstone warden (mossy, dim core, chipped) → L2 granite
 * bulwark (iron cramp staples, iron fist bands + brow plate, brighter
 * core) → L3 reliquary monolith (warm sandstone, gold staples/brow/ring +
 * rising gold mote — gold as subtle accents, never large white masses).
 * PALETTES: player = cool blue-slate stone + amber core (matches the
 * scene-owned death-rubble constants), enemy = rust-umber stone + blood
 * ember core. No whole-body tint of our own (chill tint stays free).
 *
 * Grounding: soft contact shadow only, at the giant's ground line (+12.5).
 * Envelope: ground +12.5 to brow top ≈ −46 (health bar offset is 70).
 */

type G = Phaser.GameObjects.Graphics;

interface Pt { x: number; y: number }

const TAU = Math.PI * 2;
const IDLE_MS = 2000;    // idle loop period — exact 250 ms multiple
const STRIDE_MS = 1500;  // walk loop period — exact 250 ms multiple
const GROUND_Y = 12.5;   // carrier-local ground line (giant convention)
const DEFAULT_FACING = 0.6; // camera-facing 3/4 when no troop owns the carrier

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);
const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

/** Live facing from the troop that owns this carrier (carrier-level
 *  context — the golem draw signature does not include facingAngle). */
function readFacing(g: G): number {
    const scene = g.scene as unknown as {
        troops?: Array<{ gameObject?: unknown; facingAngle?: number }>;
    };
    const troops = scene ? scene.troops : undefined;
    if (Array.isArray(troops)) {
        for (let i = 0; i < troops.length; i++) {
            const t = troops[i];
            if (t && t.gameObject === g) {
                const fa = t.facingAngle;
                return typeof fa === 'number' && Number.isFinite(fa) ? fa : DEFAULT_FACING;
            }
        }
    }
    return DEFAULT_FACING;
}

interface Pal {
    top: number; lit: number; mid: number; dark: number;
    moss: number;
    core: number; coreHot: number; eye: number;
    trimA: number; trimB: number; // L2 iron / L3 gold (unused at L1)
    glowK: number;                // seam-glow strength by level
}

function palette(isPlayer: boolean, L: number): Pal {
    if (L >= 3) {
        // Reliquary monolith — warm sandstone + gold ACCENTS (owner's rule).
        return isPlayer
            ? { top: 0xdcd3ba, lit: 0xbfb49a, mid: 0xa39678, dark: 0x7e7256, moss: 0x4a6a3a, core: 0xffb347, coreHot: 0xffe9a8, eye: 0xffd98a, trimA: 0xdaa520, trimB: 0xffd700, glowK: 0.95 }
            : { top: 0xc9b49a, lit: 0xa8927a, mid: 0x8a7460, dark: 0x685648, moss: 0x5a4a3a, core: 0xff5040, coreHot: 0xffb09a, eye: 0xff6a52, trimA: 0xdaa520, trimB: 0xffd700, glowK: 0.95 };
    }
    if (L === 2) {
        // Granite bulwark — dressed dark stone, iron cramps.
        return isPlayer
            ? { top: 0x76838e, lit: 0x596673, mid: 0x475462, dark: 0x333f4c, moss: 0x4a6a3a, core: 0xffb347, coreHot: 0xffe9a8, eye: 0xffd98a, trimA: 0x353b46, trimB: 0x7d8798, glowK: 0.75 }
            : { top: 0x82706e, lit: 0x63534f, mid: 0x50423e, dark: 0x3c302c, moss: 0x5a4a3a, core: 0xff5040, coreHot: 0xffb09a, eye: 0xff6a52, trimA: 0x353b46, trimB: 0x7d8798, glowK: 0.75 };
    }
    // Fieldstone warden — the death-rubble stone family exactly.
    return isPlayer
        ? { top: 0x7e8e9e, lit: 0x5f7080, mid: 0x4e5e6e, dark: 0x3a4a5a, moss: 0x4a6a3a, core: 0xffb347, coreHot: 0xffe9a8, eye: 0xffd98a, trimA: 0, trimB: 0, glowK: 0.55 }
        : { top: 0x8a7a7a, lit: 0x6a5a5a, mid: 0x584a4a, dark: 0x4a3a3a, moss: 0x5a4a3a, core: 0xff5040, coreHot: 0xffb09a, eye: 0xff6a52, trimA: 0, trimB: 0, glowK: 0.55 };
}

export function drawGolemB(
    graphics: G,
    isPlayer: boolean,
    isMoving: boolean,
    slamOffset: number,
    troopLevel: number = 1,
    time: number = 0
): void {
    const g = graphics;
    const L = Math.max(1, Math.min(3, Math.round(troopLevel || 1)));
    const pal = palette(isPlayer, L);

    const a = readFacing(g);
    const ca = Math.cos(a);
    const sa = Math.sin(a);

    // ---------------- motion terms (all pure f(time)) ----------------
    const s = clamp01((slamOffset || 0) / 12); // 1 exactly on the damage tick

    // Idle loop — ONE 2000 ms period; harmonics 1 & 2 only.
    const iw = (TAU / IDLE_MS) * time;
    const heave = isMoving ? 0 : Math.sin(iw) * 1.0;                 // ±1 px torso rise
    const glowPulse = 0.5 + 0.5 * Math.sin(iw * 2 - 0.9);            // seam/rune pulse
    const eyePulse = 0.5 + 0.5 * Math.sin(iw * 2 + 1.2);             // eye flicker
    const knuckle = isMoving ? 0 : Math.max(0, Math.sin(iw + Math.PI)) * 0.8;

    // Walk loop — ONE 1500 ms stride.
    let stepL = 0, stepR = 0, liftL = 0, liftR = 0, bob = 0, roll = 0, armSwing = 0;
    let plantL = 0, plantR = 0;
    if (isMoving) {
        const th = TAU * ((time % STRIDE_MS) / STRIDE_MS);
        const sn = Math.sin(th), cs = Math.cos(th);
        stepL = 5.5 * sn; stepR = -stepL;
        liftL = Math.max(0, cs) * 3.6; liftR = Math.max(0, -cs) * 3.6;
        bob = 0.7 - 1.4 * Math.abs(sn);      // lowest exactly at each plant
        roll = cs * 1.6;                     // weight over the planted pillar
        armSwing = sn * 3.2;                 // fists counter-swing
        plantL = clamp01((sn - 0.85) / 0.15);   // dust pulse: left plant
        plantR = clamp01((-sn - 0.85) / 0.15);  // dust pulse: right plant
    }

    // Slam — body/head/arms drop by slamOffset px; planted legs do not.
    const drop = slamOffset || 0;
    const leanF = s * 3;                      // pitch into the blow
    const flash = clamp01((s - 0.8) / 0.2);   // seam/eye flare near impact
    const bump = Math.sin(Math.PI * clamp01(s / 0.65)) * 9; // early fist raise

    // Upper-body offsets (torso/shoulders/head/arm roots).
    const uF = leanF;
    const uR = roll;
    const uH = heave + bob - drop;            // h-space: drop lowers height

    // ---------------- projection ----------------
    const P = (f: number, r: number, h: number): Pt => ({
        x: ca * f - sa * r,
        y: GROUND_Y + 0.5 * (sa * f + ca * r) - h,
    });

    const quad = (p0: Pt, p1: Pt, p2: Pt, p3: Pt, color: number, alpha: number): void => {
        g.fillStyle(color, alpha);
        g.beginPath();
        g.moveTo(p0.x, p0.y);
        g.lineTo(p1.x, p1.y);
        g.lineTo(p2.x, p2.y);
        g.lineTo(p3.x, p3.y);
        g.closePath();
        g.fillPath();
    };

    /** Rotation-proof iso box: draws the (at most two) visible vertical
     *  faces shaded by their outward normal (NW light), then the top. */
    const box = (
        f0: number, r0: number, hf: number, hr: number, h0: number, h1: number,
        tones: { top: number; lit: number; mid: number; dark: number }
    ): void => {
        const A: [number, number] = [f0 + hf, r0 - hr];
        const B: [number, number] = [f0 + hf, r0 + hr];
        const C: [number, number] = [f0 - hf, r0 + hr];
        const D: [number, number] = [f0 - hf, r0 - hr];
        const faces: Array<{ e0: [number, number]; e1: [number, number]; nx: number; vis: boolean }> = [
            { e0: A, e1: B, nx: ca, vis: sa > 0.02 },    // +F
            { e0: C, e1: D, nx: -ca, vis: sa < -0.02 },  // -F
            { e0: B, e1: C, nx: -sa, vis: ca > 0.02 },   // +R
            { e0: D, e1: A, nx: sa, vis: ca < -0.02 },   // -R
        ];
        for (const fc of faces) {
            if (!fc.vis) continue;
            const tone = fc.nx < -0.35 ? tones.lit : fc.nx > 0.35 ? tones.dark : tones.mid;
            quad(P(fc.e0[0], fc.e0[1], h0), P(fc.e1[0], fc.e1[1], h0),
                P(fc.e1[0], fc.e1[1], h1), P(fc.e0[0], fc.e0[1], h1), tone, 1);
        }
        quad(P(A[0], A[1], h1), P(B[0], B[1], h1), P(C[0], C[1], h1), P(D[0], D[1], h1), tones.top, 1);
    };

    /** Glowing mortar seam: strip along each visible vertical face at height h. */
    const glowSeam = (
        f0: number, r0: number, hf: number, hr: number, h: number, thk: number, alpha: number
    ): void => {
        if (alpha <= 0.02) return;
        const edges: Array<{ e0: [number, number]; e1: [number, number]; vis: boolean }> = [
            { e0: [f0 + hf, r0 - hr], e1: [f0 + hf, r0 + hr], vis: sa > 0.02 },
            { e0: [f0 - hf, r0 + hr], e1: [f0 - hf, r0 - hr], vis: sa < -0.02 },
            { e0: [f0 + hf, r0 + hr], e1: [f0 - hf, r0 + hr], vis: ca > 0.02 },
            { e0: [f0 - hf, r0 - hr], e1: [f0 + hf, r0 - hr], vis: ca < -0.02 },
        ];
        for (const e of edges) {
            if (!e.vis) continue;
            quad(P(e.e0[0], e.e0[1], h), P(e.e1[0], e.e1[1], h),
                P(e.e1[0], e.e1[1], h + thk), P(e.e0[0], e.e0[1], h + thk), pal.core, alpha);
            quad(P(e.e0[0], e.e0[1], h + thk * 0.3), P(e.e1[0], e.e1[1], h + thk * 0.3),
                P(e.e1[0], e.e1[1], h + thk * 0.7), P(e.e0[0], e.e0[1], h + thk * 0.7),
                pal.coreHot, alpha * 0.8);
        }
    };

    /** Dark masonry joint line across the visible faces at height h. */
    const jointLine = (
        f0: number, r0: number, hf: number, hr: number, h: number, alpha: number
    ): void => {
        const edges: Array<{ e0: [number, number]; e1: [number, number]; vis: boolean }> = [
            { e0: [f0 + hf, r0 - hr], e1: [f0 + hf, r0 + hr], vis: sa > 0.02 },
            { e0: [f0 - hf, r0 + hr], e1: [f0 - hf, r0 - hr], vis: sa < -0.02 },
            { e0: [f0 + hf, r0 + hr], e1: [f0 - hf, r0 + hr], vis: ca > 0.02 },
            { e0: [f0 - hf, r0 - hr], e1: [f0 + hf, r0 - hr], vis: ca < -0.02 },
        ];
        for (const e of edges) {
            if (!e.vis) continue;
            quad(P(e.e0[0], e.e0[1], h), P(e.e1[0], e.e1[1], h),
                P(e.e1[0], e.e1[1], h + 0.7), P(e.e0[0], e.e0[1], h + 0.7), pal.dark, alpha);
        }
    };

    const seamA = pal.glowK * (0.42 + 0.3 * glowPulse) + flash * 0.35;

    // ---------------- ground: contact shadow + stomp dust ----------------
    g.fillStyle(0x000000, 0.3);
    g.fillEllipse(0, GROUND_Y + 0.2, 42 + s * 4, 16 + s * 1.5);

    const dust = (cx: number, cy: number, k: number): void => {
        if (k <= 0.02) return;
        g.fillStyle(0x8b7355, 0.5 * k);
        const spread = 3 + (1 - k) * 4;
        g.fillRect(cx - spread - 1.5, cy - 1, 3, 2);
        g.fillRect(cx + spread - 1.5, cy - 1.5, 3, 2);
        g.fillRect(cx - 1.5, cy - 2 - (1 - k) * 2, 3, 2);
    };
    if (isMoving) {
        const fl = P(stepL, -9.5, 0), fr = P(stepR, 9.5, 0);
        dust(fl.x, fl.y, plantL);
        dust(fr.x, fr.y, plantR);
    }

    // ---------------- body parts, depth-sorted per heading ----------------
    interface Part { d: number; draw: () => void }
    const parts: Part[] = [];
    const depthKey = (f: number, r: number, bias: number): number => sa * f + ca * r + bias;

    // --- pillar legs + feet (PLANTED: no roll, no drop, no heave) ---
    const legSides: Array<[number, number, number]> = [[-1, stepL, liftL], [1, stepR, liftR]];
    for (const [side, step, lift] of legSides) {
        const rr = side * 11;
        parts.push({
            d: depthKey(step, rr, 0),
            draw: () => {
                box(step, rr, 7, 6.2, lift, lift + 4.5, pal);              // foot slab
                box(step * 0.85, rr, 5.5, 5.2, lift + 3.5, 16.5, pal);     // pillar
                jointLine(step * 0.85, rr, 5.5, 5.2, 9, 0.3);
            },
        });
    }

    // --- pelvis block ---
    parts.push({
        d: depthKey(0.5 + uF, uR, 0.012),
        draw: () => {
            box(0.5 + uF, uR, 7.5, 13, 15 + uH * 0.5, 24.6 + uH, pal);
            glowSeam(0.5 + uF, uR, 7.5, 13, 15.4 + uH * 0.5, 1.2, seamA * 0.7);
        },
    });

    // --- spine ridge stones (the rear silhouette) ---
    parts.push({
        d: depthKey(-8 + uF, uR, 0.02),
        draw: () => {
            const spineTones = { top: pal.mid, lit: pal.mid, mid: pal.dark, dark: pal.dark };
            box(-9 + uF, uR + 1, 2, 3.6, 24 + uH, 30 + uH, spineTones);
            box(-9.3 + uF, uR - 0.8, 2, 3.4, 31 + uH, 37 + uH, spineTones);
            box(-9 + uF, uR + 0.5, 1.9, 3, 38 + uH, 43.5 + uH, spineTones);
        },
    });

    // --- torso stele (front sigil / back moss cape) ---
    parts.push({
        d: depthKey(1 + uF, uR, 0.024),
        draw: () => {
            const tf = 1 + uF, tr = uR;
            box(tf, tr, 8.5, 15, 24 + uH, 44 + uH, pal);
            jointLine(tf, tr, 8.5, 15, 30.5 + uH, 0.32);
            jointLine(tf, tr, 8.5, 15, 37.5 + uH, 0.32);
            glowSeam(tf, tr, 8.5, 15, 24.4 + uH, 1.8, seamA);

            // vertical crack glints (one per visible face)
            const crack = (fFix: number, rA: number, rB: number, h0: number, h1: number): void => {
                quad(P(fFix, rA - 0.45, h0), P(fFix, rA + 0.45, h0),
                    P(fFix, rB + 0.45, h1), P(fFix, rB - 0.45, h1), pal.coreHot, seamA * 0.55);
            };
            if (sa > 0.05) crack(tf + 8.5, tr - 6.5, tr - 5, 26.5 + uH, 33 + uH);
            if (ca > 0.05) {
                // crack on the +R face runs along f
                quad(P(tf + 3.4, tr + 15, 28 + uH), P(tf + 4.3, tr + 15, 28 + uH),
                    P(tf + 3, tr + 15, 35 + uH), P(tf + 2.1, tr + 15, 35 + uH), pal.coreHot, seamA * 0.5);
            }

            // FRONT: chest rune sigil (skews with the face plane)
            if (sa > 0.05) {
                const ff = tf + 8.5;
                const runeA = pal.glowK * (0.5 + 0.35 * glowPulse) + flash * 0.4;
                quad(P(ff, tr - 1, 30.5 + uH), P(ff, tr + 1, 30.5 + uH),
                    P(ff, tr + 1, 38 + uH), P(ff, tr - 1, 38 + uH), pal.core, runeA);
                quad(P(ff, tr - 3, 32.3 + uH), P(ff, tr + 3, 32.3 + uH),
                    P(ff, tr + 3, 33.4 + uH), P(ff, tr - 3, 33.4 + uH), pal.core, runeA * 0.9);
                quad(P(ff, tr - 2.1, 35.3 + uH), P(ff, tr + 2.1, 35.3 + uH),
                    P(ff, tr + 2.1, 36.4 + uH), P(ff, tr - 2.1, 36.4 + uH), pal.coreHot, runeA * 0.8);
                if (L >= 3) {
                    // gold ring around the sigil — accent only
                    g.lineStyle(1.1, pal.trimB, 0.85);
                    g.beginPath();
                    const p0 = P(ff, tr, 39.4 + uH), p1 = P(ff, tr + 3.9, 34.3 + uH);
                    const p2 = P(ff, tr, 29.2 + uH), p3 = P(ff, tr - 3.9, 34.3 + uH);
                    g.moveTo(p0.x, p0.y); g.lineTo(p1.x, p1.y); g.lineTo(p2.x, p2.y); g.lineTo(p3.x, p3.y);
                    g.closePath();
                    g.strokePath();
                    g.lineStyle(0, 0, 0);
                }
                // L2 iron cramp staples across the mid joint
                if (L === 2) {
                    for (const rOff of [-7, 7]) {
                        quad(P(ff, tr + rOff - 1.6, 29.4 + uH), P(ff, tr + rOff + 1.6, 29.4 + uH),
                            P(ff, tr + rOff + 1.6, 31.9 + uH), P(ff, tr + rOff - 1.6, 31.9 + uH), pal.trimA, 1);
                        quad(P(ff, tr + rOff - 1.6, 31.4 + uH), P(ff, tr + rOff + 1.6, 31.4 + uH),
                            P(ff, tr + rOff + 1.6, 31.9 + uH), P(ff, tr + rOff - 1.6, 31.9 + uH), pal.trimB, 0.9);
                    }
                }
                if (L >= 3) {
                    for (const rOff of [-9.5, 9.5]) {
                        quad(P(ff, tr + rOff - 1.3, 29.6 + uH), P(ff, tr + rOff + 1.3, 29.6 + uH),
                            P(ff, tr + rOff + 1.3, 31.7 + uH), P(ff, tr + rOff - 1.3, 31.7 + uH), pal.trimA, 1);
                    }
                }
            }

            // BACK: moss cape (L1/L2) draped on the -F face
            if (sa < -0.05 && L <= 2) {
                const bf = tf - 8.5;
                const mossA = L === 1 ? 0.9 : 0.55;
                quad(P(bf, tr - 10, 44 + uH), P(bf, tr + 10.5, 44 + uH),
                    P(bf, tr + 7, 36.5 + uH), P(bf, tr - 6, 38 + uH), pal.moss, mossA);
                quad(P(bf, tr - 2.5, 38.5 + uH), P(bf, tr + 3.5, 39 + uH),
                    P(bf, tr + 1.5, 32.5 + uH), P(bf, tr - 1, 33.5 + uH), pal.moss, mossA * 0.8);
            }
            // L1 chipped notch on the front-top corner
            if (L === 1 && sa > 0.05) {
                quad(P(tf + 8.5, tr - 15, 42.2 + uH), P(tf + 8.5, tr - 12, 44 + uH),
                    P(tf + 8.5, tr - 15, 44 + uH), P(tf + 8.5, tr - 15, 44 + uH), pal.dark, 0.85);
            }
        },
    });

    // --- capstone shoulders ---
    for (const side of [-1, 1]) {
        const rr = side * 14.5 + uR;
        parts.push({
            d: depthKey(0.5 + uF, rr, 0.03),
            draw: () => {
                box(0.5 + uF, rr, 6.5, 5.5, 38 + uH, 48.5 + uH, pal);
                if (L >= 2) {
                    // metal edging under the capstone lip — L2 lit iron,
                    // L3 gold; wraps every visible face so levels read
                    // apart from all 16 headings.
                    metalBand(0.5 + uF, rr, 6.5, 5.5, 47.4 + uH, L >= 3 ? pal.trimA : pal.trimB, 1.1);
                }
                if (L === 1) {
                    // moss tufts on the capstone top
                    const mt = P(0.5 + uF, rr + side * 1.5, 48.5 + uH);
                    g.fillStyle(pal.moss, 0.95);
                    g.fillRect(mt.x - 2.5, mt.y - 1, 4, 2);
                    g.fillRect(mt.x - 0.5, mt.y - 2.2, 3, 1.8);
                }
            },
        });
    }

    // --- keystone head + brow slab (juts FORWARD — front/back read differs) ---
    parts.push({
        d: depthKey(6.5 + uF, uR, 0.036),
        draw: () => {
            const hfc = 6.5 + uF, hr0 = uR;
            box(hfc, hr0, 4.4, 4.8, 40 + uH, 52.5 + uH, pal);
            box(hfc + 0.5, hr0, 5.2, 5.6, 52.5 + uH, 55.4 + uH, pal); // brow slab
            if (L >= 2 && sa > 0.02) {
                // brow plate: L2 iron / L3 gilded strip under the brow
                quad(P(hfc + 5.7, hr0 - 5.6, 51.6 + uH), P(hfc + 5.7, hr0 + 5.6, 51.6 + uH),
                    P(hfc + 5.7, hr0 + 5.6, 52.7 + uH), P(hfc + 5.7, hr0 - 5.6, 52.7 + uH),
                    L >= 3 ? pal.trimB : pal.trimA, 0.95);
            }
            // eyes on the front face — dark sockets + hot glowing centers
            // (pale gold alone vanishes on the L3 sandstone); width collapses
            // toward profile so they never read painted-on edge-on.
            if (sa > 0.06) {
                const k = Math.min(1, sa * 1.6);
                const eyeA = Math.min(1, 0.85 + 0.15 * eyePulse + s * 0.3);
                for (const er of [-2.1, 2.1]) {
                    const ep = P(hfc + 4.4, hr0 + er, 47 + uH);
                    const sw = 3.8 * k;
                    g.fillStyle(0x14181c, 0.85);                    // socket recess
                    g.fillRect(ep.x - sw / 2, ep.y - 1.7, sw, 3.4);
                    g.fillStyle(pal.eye, eyeA);                     // ember iris
                    g.fillRect(ep.x - (2.6 * k) / 2, ep.y - 1.1, 2.6 * k, 2.2);
                    g.fillStyle(pal.coreHot, eyeA);                 // white-hot core
                    g.fillRect(ep.x - (1.2 * k) / 2, ep.y - 0.5, 1.2 * k, 1);
                }
            } else if (sa < -0.06) {
                // carved mason's notch on the back of the head
                const np = P(hfc - 4.4, hr0, 47 + uH);
                g.fillStyle(pal.dark, 0.8);
                g.fillRect(np.x - 1, np.y - 2.4, 2, 4.8);
            }
        },
    });

    // --- column arms + lintel fists ---
    for (const side of [-1, 1]) {
        // fist position: idle hang → walk counter-swing → slam plant
        const nF = 4.5 - side * armSwing;
        const nR = side * 19 + uR * 0.6;
        const nH = 8.5 + knuckle;
        const fF = lerp(nF, 14, s);
        const fR = lerp(nR, side * 12.5 + uR * 0.6, s);
        const fH = lerp(nH, 4, s) + bump;
        parts.push({
            d: depthKey(fF * 0.5 + 0.5, side * 17.5 + uR * 0.6, 0.05),
            draw: () => {
                const S = P(1 + uF, side * 16.5 + uR, 43 + uH); // shoulder root (rides the body)
                const F = P(fF, fR, fH + 4);                    // wrist (fist-box top)
                // shoulder joint glow, tucked under the arm root
                g.fillStyle(pal.core, seamA * 0.6);
                g.fillCircle(S.x, S.y + 1.5, 2.4);
                // tapered column arm (screen-space thick quad)
                const dx = F.x - S.x, dy = F.y - S.y;
                const len = Math.hypot(dx, dy) || 1;
                const nx = -dy / len, ny = dx / len;
                const wS = 5, wF = 6.2;
                const armTone = depthKey(fF, side * 16, 0) > 0 ? pal.mid : pal.dark;
                quad({ x: S.x + nx * wS, y: S.y + ny * wS }, { x: F.x + nx * wF, y: F.y + ny * wF },
                    { x: F.x - nx * wF, y: F.y - ny * wF }, { x: S.x - nx * wS, y: S.y - ny * wS }, armTone, 1);
                // dark edge on the underside for volume
                quad({ x: S.x + nx * wS, y: S.y + ny * wS }, { x: F.x + nx * wF, y: F.y + ny * wF },
                    { x: F.x + nx * (wF - 1.5), y: F.y + ny * (wF - 1.5) }, { x: S.x + nx * (wS - 1.2), y: S.y + ny * (wS - 1.2) }, pal.dark, 0.55);
                // lintel fist
                box(fF, fR, 6, 5.5, Math.max(0, fH - 5), fH + 4, pal);
                if (L >= 2) {
                    // fist band: L2 iron / L3 gold (trimA is the level's metal)
                    metalBand(fF, fR, 6, 5.5, fH - 1, pal.trimA, L >= 3 ? 1.1 : 1.4);
                }
                if (L >= 3 && sa > 0.02) {
                    // gold knuckle studs on the fist front
                    for (const kr of [-2.4, 2.4]) {
                        const kp = P(fF + 6, fR + kr, fH + 2);
                        g.fillStyle(pal.trimB, 0.95);
                        g.fillRect(kp.x - 0.9, kp.y - 0.9, 1.8, 1.8);
                    }
                }
                // slam impact dust around the planted fist
                const impact = clamp01((s - 0.82) / 0.18);
                if (impact > 0.02) {
                    const ip = P(fF, fR, 0);
                    g.fillStyle(0x8b7355, 0.75 * impact);
                    g.fillRect(ip.x - 6 - (1 - impact) * 3, ip.y - 1.5, 3, 2.4);
                    g.fillRect(ip.x + 4 + (1 - impact) * 3, ip.y - 2, 3, 2.4);
                    g.fillRect(ip.x - 1.5, ip.y - 3.5 - (1 - impact) * 2, 3, 2.4);
                }
            },
        });
    }

    /** Metal band strip around a fist box's visible faces at height h. */
    function metalBand(f0: number, r0: number, hf: number, hr: number, h: number, color: number, thk: number): void {
        const edges: Array<{ e0: [number, number]; e1: [number, number]; vis: boolean }> = [
            { e0: [f0 + hf, r0 - hr], e1: [f0 + hf, r0 + hr], vis: sa > 0.02 },
            { e0: [f0 - hf, r0 + hr], e1: [f0 - hf, r0 - hr], vis: sa < -0.02 },
            { e0: [f0 + hf, r0 + hr], e1: [f0 - hf, r0 + hr], vis: ca > 0.02 },
            { e0: [f0 - hf, r0 - hr], e1: [f0 + hf, r0 - hr], vis: ca < -0.02 },
        ];
        for (const e of edges) {
            if (!e.vis) continue;
            quad(P(e.e0[0], e.e0[1], h), P(e.e1[0], e.e1[1], h),
                P(e.e1[0], e.e1[1], h + thk), P(e.e0[0], e.e0[1], h + thk), color, 1);
        }
    }

    // ---------------- paint back-to-front ----------------
    parts.sort((p, q) => p.d - q.d);
    for (const part of parts) part.draw();

    // --- L3 rising gold mote (2000 ms loop, subtle accent, over the body) ---
    if (L >= 3) {
        const frac = (time % IDLE_MS) / IDLE_MS;
        const mp = P(0.5 + uF, 12 + uR, 49 + uH + 8 * frac);
        g.fillStyle(pal.trimB, (1 - frac) * 0.55);
        g.fillRect(mp.x - 0.8, mp.y - 0.8, 1.6, 1.6);
    }
}
