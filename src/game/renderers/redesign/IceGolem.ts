import type Phaser from 'phaser';

/**
 * ICE GOLEM — "THE GLACIAL WARDEN"
 *
 * Promoted tournament body: design B, the Cromlech Warden — dressed monument
 * masonry (pillar legs, stele torso, capstone-lintel shoulders, keystone head
 * under a brow slab, column arms with lintel fists) — RESKINNED as glacial
 * ice. The blocks are hewn bergs: frost-dusted top faces, pale lit faces and
 * deep blue shadow faces fake translucency in color space (the bake's alpha
 * snap forbids real translucency, so every fill is opaque and the "glow
 * through the ice" is painted as inner-light quads + cold seam light).
 * Icicles hang where the masonry allows: shoulder capstones, the brow slab,
 * the pelvis skirt and the lintel fists.
 *
 * SILHOUETTE + RIG: geometry, projection, painter's sort, and every motion
 * term are the Warden's, unchanged — the baked frames must keep its reads.
 *  - idle: ONE 2000 ms loop (torso heave ±1 px, seam-light pulse + eye
 *    flicker on harmonic 2, knuckle drag). Exact 250 ms multiple.
 *  - walk: ONE 1500 ms stride (alternating pillar steps, 2x stomp bob,
 *    weight roll, counter-swinging fists, deterministic plant mist).
 *  - slam: driven ONLY by slamOffset (0→12 Quad.easeIn 200 ms, damage at 12,
 *    then a 12→24 easeOut 400 ms SETTLE sweep — the recovery is its own
 *    authored choreography, never a 12→0 retrace: the sprite bank picks
 *    attack frames by nearest slamOffset VALUE, so retracing would re-show
 *    the overhead hoist after the crash. pose(24) ≡ pose(0); the scene
 *    snaps the driver back to 0 when the settle completes).
 *    TWO-HANDED OVERHEAD GLACIER CRUSH — distinct
 *    from the stone golem's forward body-slam: the torso rears BACK while
 *    both fists converge to the centerline and hoist above the brow slab,
 *    then the upper body pitches hard forward as the joined fists plunge to
 *    a single contact point on the facing, landing exactly at s = 1 with a
 *    cold flash. Planted legs never move.
 *  - 16-direction awareness: true iso boxes in body space projected through
 *    the live facingAngle (read carrier-level), rotation-proof face
 *    selection + NW light, per-heading painter's re-sort.
 *
 * LEVELS (escalation reinterpreted in ice):
 *  L1 pack-ice warden — cloudy milky ice, snow drift cape + snow tufts,
 *     chipped, few stubby icicles, dim inner light.
 *  L2 glacier bulwark — clear saturated blue ice, rime-silver cramp staples,
 *     rime bands on fists + brow, longer icicle rows, brighter core.
 *  L3 reliquary of deep ice — ancient dense blue, gold staples/brow/sigil
 *     ring/knuckle studs (gold as subtle ACCENTS per the owner's rule),
 *     longest icicles, brightest core + rising gold mote.
 * PALETTES: player = glacial cyan ice + cold cyan inner light; enemy =
 * amethyst ice + violet inner light. No whole-body tint of our own (the
 * chill/status tint channel stays free).
 *
 * Grounding: soft contact shadow only, giant ground line (+12.5). Envelope
 * matches the Warden (health bar offset 70).
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
    snow: number;                 // drift/tuft white (the moss slot, frozen)
    core: number; coreHot: number; eye: number;
    trimA: number; trimB: number; // L2 rime-silver / L3 gold (unused at L1)
    glowK: number;                // inner-light strength by level
}

function palette(isPlayer: boolean, L: number): Pal {
    if (L >= 3) {
        // Reliquary of deep ice — ancient dense blue + gold ACCENTS only.
        return isPlayer
            ? { top: 0xd6f0fa, lit: 0x8cc6e6, mid: 0x5694c8, dark: 0x2f62a0, snow: 0xeefaff, core: 0x6ef0ff, coreHot: 0xe6ffff, eye: 0xbdf6ff, trimA: 0xdaa520, trimB: 0xffd700, glowK: 0.95 }
            : { top: 0xe6dcf6, lit: 0xb094d8, mid: 0x8060b8, dark: 0x543a8c, snow: 0xf2eefa, core: 0xd67aff, coreHot: 0xf8e6ff, eye: 0xe6b0ff, trimA: 0xdaa520, trimB: 0xffd700, glowK: 0.95 };
    }
    if (L === 2) {
        // Glacier bulwark — clear saturated ice, rime-silver cramps.
        return isPlayer
            ? { top: 0xcaeaf6, lit: 0x84bede, mid: 0x5a9ac8, dark: 0x3a70a4, snow: 0xe8f6fc, core: 0x66e4ff, coreHot: 0xdcfaff, eye: 0xaaeeff, trimA: 0x8fb8cc, trimB: 0xeafaff, glowK: 0.75 }
            : { top: 0xdcd2f0, lit: 0xa48cce, mid: 0x7c60b0, dark: 0x564288, snow: 0xece6f6, core: 0xce70f6, coreHot: 0xf2dcff, eye: 0xdca6ff, trimA: 0x9c8cb4, trimB: 0xf0e8fc, glowK: 0.75 };
    }
    // Pack-ice warden — cloudy milky ice, snow-bound.
    return isPlayer
        ? { top: 0xd2e6ee, lit: 0x9cc2d6, mid: 0x74a0bc, dark: 0x527c9c, snow: 0xecf6fa, core: 0x5cd2f0, coreHot: 0xcef2fc, eye: 0x9ce6f8, trimA: 0, trimB: 0, glowK: 0.55 }
        : { top: 0xe0d8e8, lit: 0xac9cc2, mid: 0x8676a4, dark: 0x625682, snow: 0xf0eaf4, core: 0xc266e8, coreHot: 0xecd6f8, eye: 0xd49af2, trimA: 0, trimB: 0, glowK: 0.55 };
}

export function drawIceGolem(
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
    const raw = slamOffset || 0;
    const s = clamp01(raw / 12); // 1 exactly on the damage tick
    // Post-crash SETTLE: the scene sweeps slamOffset onward 12→24 after the
    // damage tick (never back down 12→0 — the runtime picks attack frames by
    // nearest slamOffset VALUE, so a downward retrace would re-display the
    // overhead hoist right after the crash). settleP maps that second half
    // to an authored recovery: the body pushes back up, the joined fists
    // drag LOW from the contact point back out to the hang — never
    // re-hoisted. pose(24) ≡ pose(0) so the scene can snap the driver to 0
    // seamlessly when the settle completes.
    const settleP = clamp01((raw - 12) / 12);
    const su = Math.sin((Math.PI / 2) * settleP); // ease-out settle 0→1
    const sw = s * (1 - su); // slam weight for ground/eye accents (fades in settle)

    // Idle loop — ONE 2000 ms period; harmonics 1 & 2 only.
    const iw = (TAU / IDLE_MS) * time;
    const heave = isMoving ? 0 : Math.sin(iw) * 1.0;                 // ±1 px torso rise
    const glowPulse = 0.5 + 0.5 * Math.sin(iw * 2 - 0.9);            // inner-light pulse
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
        plantL = clamp01((sn - 0.85) / 0.15);   // frost-mist pulse: left plant
        plantR = clamp01((-sn - 0.85) / 0.15);  // frost-mist pulse: right plant
    }

    // Slam — TWO-HANDED OVERHEAD GLACIER CRUSH (deliberately distinct from
    // the stone golem's forward body-slam): the torso REARS BACK and rises
    // while both fists converge toward the centerline and hoist together
    // ABOVE the brow slab, then the whole upper body pitches hard forward
    // as the joined fists plunge to a SINGLE contact point on the facing.
    // Damage still reads at s = 1 exactly. Pure f(slamOffset) — attack
    // frames bake at pinned time, so NO time terms may enter these terms.
    const REAR_END = 0.55;   // torso: rear-back window ends here
    const APEX_END = 0.62;   // fists: overhead-rise window ends here
    const riseP = clamp01(s / APEX_END);                       // hoisting 0→1
    const plungeP = clamp01((s - APEX_END) / (1 - APEX_END));  // crashing 0→1
    const flash = clamp01((s - 0.8) / 0.2) * (1 - clamp01(settleP * 3));   // seam/eye flare near impact, out early in the settle
    // torso lean: back first (negative), then pitched hard into the blow;
    // the settle unwinds it back upright
    const leanF = (s < REAR_END
        ? -3.5 * Math.sin((Math.PI / 2) * (s / REAR_END))
        : lerp(-3.5, 5, (s - REAR_END) / (1 - REAR_END))) * (1 - su);
    // body height: a small rise while rearing (windowed — returns to 0 by
    // REAR_END), then the full 12 px drop lands only through the pitch phase
    // and lifts back out through the settle
    const rearUp = Math.sin(Math.PI * clamp01(s / REAR_END)) * 2.5;
    const drop = Math.min(raw, 12) * clamp01((s - REAR_END) / (1 - REAR_END)) * (1 - su);

    // Upper-body offsets (torso/shoulders/head/arm roots).
    const uF = leanF;
    const uR = roll;
    const uH = heave + bob - drop + rearUp;   // h-space: drop lowers height

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

    /** Inner light showing through the ice: an inset pale quad on each
     *  visible vertical face — opaque-composite fake translucency (the bake's
     *  alpha snap erases real sub-50% texel alpha, so the "glow" must be a
     *  color shift over opaque body texels). */
    const innerGlow = (
        f0: number, r0: number, hf: number, hr: number, h0: number, h1: number, alpha: number
    ): void => {
        if (alpha <= 0.03) return;
        const ins = 0.3; // inset margin fraction
        const edges: Array<{ e0: [number, number]; e1: [number, number]; vis: boolean }> = [
            { e0: [f0 + hf, r0 - hr], e1: [f0 + hf, r0 + hr], vis: sa > 0.02 },
            { e0: [f0 - hf, r0 + hr], e1: [f0 - hf, r0 - hr], vis: sa < -0.02 },
            { e0: [f0 + hf, r0 + hr], e1: [f0 - hf, r0 + hr], vis: ca > 0.02 },
            { e0: [f0 - hf, r0 - hr], e1: [f0 + hf, r0 - hr], vis: ca < -0.02 },
        ];
        const hMid0 = lerp(h0, h1, ins), hMid1 = lerp(h1, h0, ins);
        for (const e of edges) {
            if (!e.vis) continue;
            const m0: [number, number] = [lerp(e.e0[0], e.e1[0], ins), lerp(e.e0[1], e.e1[1], ins)];
            const m1: [number, number] = [lerp(e.e1[0], e.e0[0], ins), lerp(e.e1[1], e.e0[1], ins)];
            quad(P(m0[0], m0[1], hMid0), P(m1[0], m1[1], hMid0),
                P(m1[0], m1[1], hMid1), P(m0[0], m0[1], hMid1), pal.core, alpha);
            const c0: [number, number] = [lerp(e.e0[0], e.e1[0], 0.42), lerp(e.e0[1], e.e1[1], 0.42)];
            const c1: [number, number] = [lerp(e.e1[0], e.e0[0], 0.42), lerp(e.e1[1], e.e0[1], 0.42)];
            quad(P(c0[0], c0[1], lerp(h0, h1, 0.42)), P(c1[0], c1[1], lerp(h0, h1, 0.42)),
                P(c1[0], c1[1], lerp(h1, h0, 0.42)), P(c0[0], c0[1], lerp(h1, h0, 0.42)), pal.coreHot, alpha * 0.6);
        }
    };

    /** Cold light leaking through a mortar seam: strip along each visible
     *  vertical face at height h. */
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

    /** Dark fracture joint line across the visible faces at height h. */
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

    /** Icicle row hanging from a box's bottom edge on every visible face.
     *  Deterministic spacing; length scales with level. Triangles are drawn
     *  as degenerate quads ≥1.6px wide so they survive the 1.35px quantize. */
    const icicles = (
        f0: number, r0: number, hf: number, hr: number, hTop: number,
        count: number, len: number
    ): void => {
        const edges: Array<{ e0: [number, number]; e1: [number, number]; vis: boolean }> = [
            { e0: [f0 + hf, r0 - hr], e1: [f0 + hf, r0 + hr], vis: sa > 0.02 },
            { e0: [f0 - hf, r0 + hr], e1: [f0 - hf, r0 - hr], vis: sa < -0.02 },
            { e0: [f0 + hf, r0 + hr], e1: [f0 - hf, r0 + hr], vis: ca > 0.02 },
            { e0: [f0 - hf, r0 - hr], e1: [f0 + hf, r0 - hr], vis: ca < -0.02 },
        ];
        for (const e of edges) {
            if (!e.vis) continue;
            for (let i = 0; i < count; i++) {
                const t = (i + 0.5) / count;
                const fx = lerp(e.e0[0], e.e1[0], t);
                const fr = lerp(e.e0[1], e.e1[1], t);
                // alternate lengths so the row reads jagged, not combed
                const dl = len * (i % 2 === 0 ? 1 : 0.6);
                const w = 1.0;
                const top0 = P(fx - w, fr - w * 0.4, hTop);
                const top1 = P(fx + w, fr + w * 0.4, hTop);
                const tip = P(fx, fr, hTop - dl);
                quad(top0, top1, tip, tip, pal.lit, 1);
                // bright catch-light down the icicle core
                const tipHi = P(fx, fr, hTop - dl * 0.75);
                quad(P(fx - 0.35, fr - 0.15, hTop), P(fx + 0.35, fr + 0.15, hTop), tipHi, tipHi, pal.coreHot, 0.8);
            }
        }
    };

    const seamA = pal.glowK * (0.42 + 0.3 * glowPulse) + flash * 0.35;

    // ---------------- ground: contact shadow + stomp frost-mist ----------------
    g.fillStyle(0x000000, 0.3);
    g.fillEllipse(0, GROUND_Y + 0.2, 42 + sw * 4, 16 + sw * 1.5);

    const frostMist = (cx: number, cy: number, k: number): void => {
        if (k <= 0.02) return;
        g.fillStyle(0xdaf2fc, 0.55 * k);
        const spread = 3 + (1 - k) * 4;
        g.fillRect(cx - spread - 1.5, cy - 1, 3, 2);
        g.fillRect(cx + spread - 1.5, cy - 1.5, 3, 2);
        g.fillRect(cx - 1.5, cy - 2 - (1 - k) * 2, 3, 2);
    };
    if (isMoving) {
        const fl = P(stepL, -9.5, 0), fr = P(stepR, 9.5, 0);
        frostMist(fl.x, fl.y, plantL);
        frostMist(fr.x, fr.y, plantR);
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
                box(step, rr, 7, 6.2, lift, lift + 4.5, pal);              // foot berg
                box(step * 0.85, rr, 5.5, 5.2, lift + 3.5, 16.5, pal);     // pillar
                jointLine(step * 0.85, rr, 5.5, 5.2, 9, 0.3);
                innerGlow(step * 0.85, rr, 5.5, 5.2, 4.5, 15, seamA * 0.25);
            },
        });
    }

    // --- pelvis block (icicle skirt) ---
    parts.push({
        d: depthKey(0.5 + uF, uR, 0.012),
        draw: () => {
            box(0.5 + uF, uR, 7.5, 13, 15 + uH * 0.5, 24.6 + uH, pal);
            glowSeam(0.5 + uF, uR, 7.5, 13, 15.4 + uH * 0.5, 1.2, seamA * 0.7);
            if (L >= 2) icicles(0.5 + uF, uR, 7.5, 13, 15 + uH * 0.5, L >= 3 ? 4 : 3, L >= 3 ? 4.5 : 3.5);
        },
    });

    // --- spine ridge bergs (the rear silhouette) ---
    parts.push({
        d: depthKey(-8 + uF, uR, 0.02),
        draw: () => {
            const spineTones = { top: pal.top, lit: pal.mid, mid: pal.dark, dark: pal.dark };
            box(-9 + uF, uR + 1, 2, 3.6, 24 + uH, 30 + uH, spineTones);
            box(-9.3 + uF, uR - 0.8, 2, 3.4, 31 + uH, 37 + uH, spineTones);
            box(-9 + uF, uR + 0.5, 1.9, 3, 38 + uH, 43.5 + uH, spineTones);
        },
    });

    // --- torso stele (front sigil / back snow-drift cape) ---
    parts.push({
        d: depthKey(1 + uF, uR, 0.024),
        draw: () => {
            const tf = 1 + uF, tr = uR;
            box(tf, tr, 8.5, 15, 24 + uH, 44 + uH, pal);
            jointLine(tf, tr, 8.5, 15, 30.5 + uH, 0.32);
            jointLine(tf, tr, 8.5, 15, 37.5 + uH, 0.32);
            glowSeam(tf, tr, 8.5, 15, 24.4 + uH, 1.8, seamA);
            innerGlow(tf, tr, 8.5, 15, 25 + uH, 43 + uH, seamA * 0.3);

            // internal fracture planes catching the light (one per visible face)
            const fracture = (fFix: number, rA: number, rB: number, h0: number, h1: number): void => {
                quad(P(fFix, rA - 0.45, h0), P(fFix, rA + 0.45, h0),
                    P(fFix, rB + 0.45, h1), P(fFix, rB - 0.45, h1), pal.coreHot, seamA * 0.55);
            };
            if (sa > 0.05) fracture(tf + 8.5, tr - 6.5, tr - 5, 26.5 + uH, 33 + uH);
            if (ca > 0.05) {
                // fracture on the +R face runs along f
                quad(P(tf + 3.4, tr + 15, 28 + uH), P(tf + 4.3, tr + 15, 28 + uH),
                    P(tf + 3, tr + 15, 35 + uH), P(tf + 2.1, tr + 15, 35 + uH), pal.coreHot, seamA * 0.5);
            }

            // FRONT: frozen heart sigil (skews with the face plane)
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
                    // gold ring around the frozen heart — accent only
                    g.lineStyle(1.1, pal.trimB, 0.85);
                    g.beginPath();
                    const p0 = P(ff, tr, 39.4 + uH), p1 = P(ff, tr + 3.9, 34.3 + uH);
                    const p2 = P(ff, tr, 29.2 + uH), p3 = P(ff, tr - 3.9, 34.3 + uH);
                    g.moveTo(p0.x, p0.y); g.lineTo(p1.x, p1.y); g.lineTo(p2.x, p2.y); g.lineTo(p3.x, p3.y);
                    g.closePath();
                    g.strokePath();
                    g.lineStyle(0, 0, 0);
                }
                // L2 rime-silver cramp staples across the mid joint
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

            // BACK: snow drift cape (L1/L2) banked on the -F face
            if (sa < -0.05 && L <= 2) {
                const bf = tf - 8.5;
                const snowA = L === 1 ? 0.95 : 0.6;
                quad(P(bf, tr - 10, 44 + uH), P(bf, tr + 10.5, 44 + uH),
                    P(bf, tr + 7, 36.5 + uH), P(bf, tr - 6, 38 + uH), pal.snow, snowA);
                quad(P(bf, tr - 2.5, 38.5 + uH), P(bf, tr + 3.5, 39 + uH),
                    P(bf, tr + 1.5, 32.5 + uH), P(bf, tr - 1, 33.5 + uH), pal.snow, snowA * 0.8);
            }
            // L1 calved notch on the front-top corner
            if (L === 1 && sa > 0.05) {
                quad(P(tf + 8.5, tr - 15, 42.2 + uH), P(tf + 8.5, tr - 12, 44 + uH),
                    P(tf + 8.5, tr - 15, 44 + uH), P(tf + 8.5, tr - 15, 44 + uH), pal.dark, 0.85);
            }
        },
    });

    // --- capstone shoulders (icicle fringe) ---
    for (const side of [-1, 1]) {
        const rr = side * 14.5 + uR;
        parts.push({
            d: depthKey(0.5 + uF, rr, 0.03),
            draw: () => {
                box(0.5 + uF, rr, 6.5, 5.5, 38 + uH, 48.5 + uH, pal);
                icicles(0.5 + uF, rr, 6.5, 5.5, 38 + uH, L >= 3 ? 3 : 2, L === 1 ? 3 : L === 2 ? 4.5 : 6);
                if (L >= 2) {
                    // band under the capstone lip — L2 bright rime, L3 gold;
                    // wraps every visible face so levels read from all 16
                    // headings.
                    metalBand(0.5 + uF, rr, 6.5, 5.5, 47.4 + uH, L >= 3 ? pal.trimA : pal.trimB, 1.1);
                }
                if (L === 1) {
                    // snow tufts on the capstone top
                    const mt = P(0.5 + uF, rr + side * 1.5, 48.5 + uH);
                    g.fillStyle(pal.snow, 0.95);
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
            // icicle fringe under the brow's leading edge
            if (sa > 0.02) icicles(hfc + 0.5, hr0, 5.2, 5.6, 52.5 + uH, 2, L === 1 ? 2.5 : L === 2 ? 3.5 : 4.5);
            if (L >= 2 && sa > 0.02) {
                // brow plate: L2 rime-silver / L3 gilded strip under the brow
                quad(P(hfc + 5.7, hr0 - 5.6, 51.6 + uH), P(hfc + 5.7, hr0 + 5.6, 51.6 + uH),
                    P(hfc + 5.7, hr0 + 5.6, 52.7 + uH), P(hfc + 5.7, hr0 - 5.6, 52.7 + uH),
                    L >= 3 ? pal.trimB : pal.trimA, 0.95);
            }
            // eyes on the front face — dark sockets + cold glowing centers;
            // width collapses toward profile so they never read painted-on
            // edge-on.
            if (sa > 0.06) {
                const k = Math.min(1, sa * 1.6);
                const eyeA = Math.min(1, 0.85 + 0.15 * eyePulse + sw * 0.3);
                for (const er of [-2.1, 2.1]) {
                    const ep = P(hfc + 4.4, hr0 + er, 47 + uH);
                    const sw = 3.8 * k;
                    g.fillStyle(0x101a26, 0.85);                    // socket recess
                    g.fillRect(ep.x - sw / 2, ep.y - 1.7, sw, 3.4);
                    g.fillStyle(pal.eye, eyeA);                     // cold iris
                    g.fillRect(ep.x - (2.6 * k) / 2, ep.y - 1.1, 2.6 * k, 2.2);
                    g.fillStyle(pal.coreHot, eyeA);                 // freezing core
                    g.fillRect(ep.x - (1.2 * k) / 2, ep.y - 0.5, 1.2 * k, 1);
                }
            } else if (sa < -0.06) {
                // carved fracture notch on the back of the head
                const np = P(hfc - 4.4, hr0, 47 + uH);
                g.fillStyle(pal.dark, 0.8);
                g.fillRect(np.x - 1, np.y - 2.4, 2, 4.8);
            }
        },
    });

    // --- column arms + lintel fists ---
    for (const side of [-1, 1]) {
        // fist position: idle hang → walk counter-swing → two-handed
        // overhead crush: both fists converge toward the centerline while
        // hoisting ABOVE the brow slab (apex ~58 h-units), then plunge to a
        // SINGLE joined contact point ~16 forward on the facing at s = 1.
        const nF = 4.5 - side * armSwing;
        const nR = side * 19 + uR * 0.6;
        const nH = 8.5 + knuckle;
        const hoist = Math.sin((Math.PI / 2) * riseP); // ease-out rise 0→1
        // settle: the joined fists drag LOW from the contact point back out
        // to the hang (fH 2→8.5, below hang height the whole way — never
        // re-hoisted)
        const fF = lerp(plungeP > 0 ? lerp(3 + uF, 16, plungeP) : lerp(nF, 3 + uF, hoist), nF, su);
        const fR = lerp(lerp(nR, side * 4 + uR * 0.6, hoist), nR, su);
        const fH = lerp(plungeP > 0 ? lerp(58, 2, plungeP) : lerp(nH, 58, hoist), nH, su);
        parts.push({
            d: depthKey(fF * 0.5 + 0.5, side * lerp(lerp(17.5, 6, hoist), 17.5, su) + uR * 0.6, 0.05),
            draw: () => {
                const S = P(1 + uF, side * 16.5 + uR, 43 + uH); // shoulder root (rides the body)
                const F = P(fF, fR, fH + 4);                    // wrist (fist-box top)
                // shoulder joint cold glow, tucked under the arm root
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
                // pale ice edge on the upper side, dark on the underside
                quad({ x: S.x + nx * wS, y: S.y + ny * wS }, { x: F.x + nx * wF, y: F.y + ny * wF },
                    { x: F.x + nx * (wF - 1.5), y: F.y + ny * (wF - 1.5) }, { x: S.x + nx * (wS - 1.2), y: S.y + ny * (wS - 1.2) }, pal.dark, 0.55);
                quad({ x: S.x - nx * wS, y: S.y - ny * wS }, { x: F.x - nx * wF, y: F.y - ny * wF },
                    { x: F.x - nx * (wF - 1.3), y: F.y - ny * (wF - 1.3) }, { x: S.x - nx * (wS - 1), y: S.y - ny * (wS - 1) }, pal.top, 0.45);
                // lintel fist
                box(fF, fR, 6, 5.5, Math.max(0, fH - 5), fH + 4, pal);
                // knuckle icicles (short — they ride the swing and the slam)
                icicles(fF, fR, 6, 5.5, Math.max(0, fH - 5) + 0.2, 2, L === 1 ? 2.2 : L === 2 ? 3 : 3.6);
                if (L >= 2) {
                    // fist band: L2 rime-silver / L3 gold (trimA is the level metal)
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
                // slam impact frost — ONE burst at the joined contact point
                // (both fists land together; emit from the +1 side only)
                const impact = clamp01((s - 0.82) / 0.18) * (1 - clamp01(settleP * 3));
                if (impact > 0.02 && side === 1) {
                    const ip = P(16, uR * 0.6, 0);
                    g.fillStyle(0xdaf2fc, 0.8 * impact);
                    g.fillRect(ip.x - 8 - (1 - impact) * 4, ip.y - 1.5, 3.5, 2.4);
                    g.fillRect(ip.x + 5 + (1 - impact) * 4, ip.y - 2, 3.5, 2.4);
                    g.fillRect(ip.x - 1.8, ip.y - 4.5 - (1 - impact) * 3, 3.5, 2.4);
                    g.fillRect(ip.x - 5, ip.y - 3 - (1 - impact) * 2, 2.6, 2);
                }
            },
        });
    }

    /** Metal/rime band strip around a box's visible faces at height h. */
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
    // --- drifting breath-frost mote (all levels, harmonic of the idle loop) ---
    if (!isMoving) {
        const frac2 = ((time + IDLE_MS / 2) % IDLE_MS) / IDLE_MS;
        const bp = P(9 + uF, uR - 3 + 4 * frac2, 45 + uH + 5 * frac2);
        g.fillStyle(pal.coreHot, (1 - frac2) * 0.5);
        g.fillRect(bp.x - 0.8, bp.y - 0.8, 1.6, 1.6);
    }
}
