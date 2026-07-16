import type Phaser from 'phaser';

type G = Phaser.GameObjects.Graphics;

/**
 * PAVISE BEARER — design C: "The Walking Wall".
 *
 * A hulking porter (space 7 ≈ 1.7× villager bulk) hauling a pavise half a
 * head taller than himself: an arch-topped slab with a protruding central
 * keel, a bordered rim, and the owner's heraldry painted on the face. The
 * shield IS the unit:
 *  - MARCH — he leans into the load, shield carried a hand off the ground,
 *    bobbing with his heavy 750 ms stride; the free arm swings.
 *  - PLANT — the moment he stands still the pavise bottoms out in the dirt.
 *    Out of combat he props it on its folding stake, steps half a pace to
 *    the side and curls a hand round the rim (relaxed idle, 2000 ms breath
 *    + L3 gold keel glint). In combat he crouches braced behind it, both
 *    hands on the back handles, helmet ducked to the rim — the blocking
 *    stance the redirect mechanic reads as.
 *  - SHOVE — his attack: the planted shield tips back through the windup,
 *    then rams forward on the damage tick with dust chipping off the lawn.
 *
 * True two-sided shield: when the aim points up-screen the viewer sees the
 * BACK of the pavise (plain wood backing, carrying battens, grip spine and
 * the folded prop stake) — the heraldic face only ever shows to the enemy.
 * Circular fittings (boss/roundel/rivets) foreshorten with the face plane
 * so edge-on headings stay honest.
 *
 * Level language (art guide §3 — the SHIELD is the weapon, so it carries
 * the progression): L1 nailed timber planks + painted chevron; L2
 * steel-rimmed with riveted straps around an owner-colour field; L3
 * parchment face, gold keel/boss and a gold-ringed roundel — accents only,
 * no white masses.
 *
 * All motion is deterministic f(time): stride 750 ms, idle breath/glint on
 * an exact 2000 ms period (250 ms harmonics), windup 400 ms / strike 200 ms
 * locked to the damage tick via attackAge. facingAngle is a screen-space
 * angle (turret math, iso 0.5 squash); the whole figure orients — 8 baked
 * directions.
 */

const GROUND = 9.5;
const STRIDE_MS = 750;
const IDLE_MS = 2000;
const WINDUP_MS = 400;
const STRIKE_MS = 200;

// Shield plate (world units; screen height = world height, width squashes).
const SH_W = 8.2; // half width across-aim
const SH_H = 26; // rim-to-rim height
const SH_ARCH = 2.6; // extra rise of the arch peak at the keel line
const SH_T = 2.3; // slab thickness along the aim

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);
const easeOut = (t: number): number => 1 - (1 - t) * (1 - t);

/** Multiply a 0xRRGGBB colour toward dark (m<1) or light (m>1). */
function shade(c: number, m: number): number {
    const r = Math.max(0, Math.min(255, Math.round(((c >> 16) & 0xff) * m)));
    const g = Math.max(0, Math.min(255, Math.round(((c >> 8) & 0xff) * m)));
    const b = Math.max(0, Math.min(255, Math.round((c & 0xff) * m)));
    return (r << 16) | (g << 8) | b;
}

/** Filled closed polygon from screen-space points. */
function poly(g: G, color: number, alpha: number, pts: number[][]): void {
    g.fillStyle(color, alpha);
    g.beginPath();
    g.moveTo(pts[0][0], pts[0][1]);
    for (let i = 1; i < pts.length; i++) g.lineTo(pts[i][0], pts[i][1]);
    g.closePath();
    g.fillPath();
}

/** Thick segment as a quad (screen space) — never a stroked line. */
function limb(g: G, color: number, alpha: number, x0: number, y0: number, x1: number, y1: number, w: number): void {
    const dx = x1 - x0, dy = y1 - y0;
    const len = Math.hypot(dx, dy) || 1;
    const nx = (-dy / len) * (w / 2), ny = (dx / len) * (w / 2);
    poly(g, color, alpha, [
        [x0 + nx, y0 + ny], [x1 + nx, y1 + ny], [x1 - nx, y1 - ny], [x0 - nx, y0 - ny]
    ]);
}

/** Per-slot bake-param overrides (DesignRegistry.designBakeParams): authored
 *  periods that differ from the TROOP_PARAMS row (500/1200/350/180, no
 *  idleMs). STRIDE_MS 750 / WINDUP_MS 400 / STRIKE_MS 200; delay 1300 = the
 *  runtime TroopDefinitions attackDelay the windup/strike lock to; idle
 *  closes on IDLE_MS = 2000 (breath + L3 keel glint). */
export const PARAMS: import('./DesignRegistry').DesignParamsExport = {
    pavisebearer: { stride: 750, delay: 1300, windup: 400, strike: 200, idleMs: 2000 },
};

export function drawPavisebearerC(
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
    const lvl = Math.max(1, Math.min(3, Math.round(troopLevel || 1)));

    // ---- attack-cycle state (the shared windup/strike contract) ----------
    const D = attackDelay || 1300;
    let age = attackAge;
    const inCombat = age >= 0 && D > 0;
    if (inCombat && age > D + 600) age = time % D; // stale tick: free-run (replays)
    let windup = 0, strike = 0;
    if (inCombat) {
        const remaining = D - age;
        if (remaining <= 0) windup = 1;
        else if (remaining <= WINDUP_MS) windup = 1 - remaining / WINDUP_MS;
        if (age <= STRIKE_MS) strike = 1 - age / STRIKE_MS;
    }

    // ---- facing basis (screen-space aim, iso 0.5 vertical squash) --------
    const cosA = Math.cos(facingAngle), sinA = Math.sin(facingAngle);
    // d = along aim, w = across aim, h = height above the ground line.
    const PX = (d: number, w: number): number => cosA * d - sinA * w;
    const PY = (d: number, w: number, h: number): number => (sinA * d + cosA * w) * 0.5 + GROUND - h;
    const P = (d: number, w: number, h: number): number[] => [PX(d, w), PY(d, w, h)];

    // ---- gait / idle rig --------------------------------------------------
    let swing = 0, lift = 0, walkS = 0;
    if (isMoving) {
        const ph = ((time % STRIDE_MS) + STRIDE_MS) % STRIDE_MS / STRIDE_MS;
        walkS = Math.sin(ph * Math.PI * 2);
        swing = walkS * 3.6;
        lift = Math.abs(walkS) * 1.4;
    } else {
        const b = Math.sin(((time % IDLE_MS) / IDLE_MS) * Math.PI * 2);
        lift = Math.max(0, b) * 1.6; // must survive quantization (≥1.5 px)
    }

    // ---- pose: where the shield and the body sit --------------------------
    const braced = inCombat && !isMoving; // blocking stance (the redirect read)
    const relaxed = !inCombat && !isMoving; // resting on the prop stake

    let shieldD: number, bottomH: number, leanTop: number;
    let bodyLean = 0, crouch = 0, duck = 0;
    let shove = 0;
    if (isMoving) {
        shieldD = 5.0;
        bottomH = 2.6 + lift * 0.8; // carried a hand off the ground, bobbing
        leanTop = 2.0 + walkS * 0.6; // top tipped back onto the shoulder yoke
        bodyLean = 1.8; // leaning into the load
    } else if (braced) {
        shieldD = 5.6;
        bottomH = strike * 1.6; // the shove hops the rim off the ground
        crouch = 2.2;
        duck = 1.8;
        bodyLean = 1.6 - windup * 2.6 + strike * 3.2; // coil back, lunge in
        leanTop = -0.8 + windup * 5.2 - strike * 1.6; // braced INTO the enemy; tip back, slam
        shove = easeOut(strike) * 4.6;
    } else {
        shieldD = 5.6;
        bottomH = 0; // PLANTED — bottom edge in the dirt
        leanTop = 1.6; // rested back onto the prop stake
        bodyLean = 1.2; // stands close, an arm over the rim
    }
    const bw = relaxed ? 2.4 : 0; // at rest he steps half a pace to the side
    const d0 = shieldD + shove; // shield bottom, along aim
    const topD = d0 - leanTop; // shield top leans toward (+) or away from him

    // ---- palettes ----------------------------------------------------------
    const her = isPlayer
        ? { deep: 0x2b5f7e, mid: 0x3d7fa3, lite: 0x5fa3c4 }
        : { deep: 0x7e2b26, mid: 0xa03a30, lite: 0xc05b4b };
    const face = lvl === 3 ? 0xdcd3ba : lvl === 2 ? 0x82613a : 0x8a6a42;
    const rim = lvl === 3 ? 0xbfb49a : lvl === 2 ? 0x8d97a0 : 0x5d4327;
    const keelC = lvl === 3 ? 0xdaa520 : lvl === 2 ? 0x9aa3ad : 0xa07c4e;
    const steel = 0x8d97a0;
    const wood = 0x6b4a2f;
    const backWood = 0x8a6a42; // every pavise is timber behind the paint
    const skin = 0xd9a066;
    const trouser = lvl === 3 ? 0x5a4f3c : lvl === 2 ? 0x4e4a44 : 0x5d4c38;
    const tunic = lvl === 3 ? 0x8c7f68 : lvl === 2 ? 0x6e6a62 : 0x8d7f66;
    const boot = 0x2a211a;
    const leather = 0x4a3320;

    // ---- 1. contact shadow (ONE closed shape, uniform alpha) --------------
    g.fillStyle(0x000000, 0.2);
    g.fillEllipse(PX(1.2, 0), GROUND + 0.4, 21 + Math.abs(cosA) * 3, 7.4);

    const shieldInFront = sinA >= -0.05; // else the pavise is behind the man
    const backView = sinA < -0.02; // viewer sees the porter's side of the slab
    const fw = Math.max(0.18, Math.abs(sinA)); // face-plane foreshortening

    // Height→along-aim interpolator for anything mounted on the leaning slab.
    const dAt = (h: number): number => d0 + (topD - d0) * clamp01((h - bottomH) / SH_H);

    // =========================== the PAVISE =================================
    const drawShield = (): void => {
        const BL = P(d0, -SH_W, bottomH), BR = P(d0, SH_W, bottomH);
        const TL = P(topD, -SH_W, bottomH + SH_H), TR = P(topD, SH_W, bottomH + SH_H);
        const PK = P(topD, 0, bottomH + SH_H + SH_ARCH);
        const BL2 = P(d0 - SH_T, -SH_W, bottomH), BR2 = P(d0 - SH_T, SH_W, bottomH);
        const TL2 = P(topD - SH_T, -SH_W, bottomH + SH_H), TR2 = P(topD - SH_T, SH_W, bottomH + SH_H);
        const PK2 = P(topD - SH_T, 0, bottomH + SH_H + SH_ARCH);

        if (!backView) {
            // Far slab + bottom edge, then the heraldic face toward the enemy.
            poly(g, shade(rim, 0.62), 1, [BL2, BR2, TR2, PK2, TL2]);
            poly(g, shade(rim, 0.5), 1, [BL2, BR2, BR, BL]);
            poly(g, face, 1, [BL, BR, TR, PK, TL]);
            // Convex keel curve: the screen-left half catches the NW light.
            const litW = sinA > 0 ? 1 : -1;
            const MB = P(d0, 0, bottomH);
            poly(g, shade(face, 1.1), 1, [P(d0, litW * SH_W, bottomH), MB, PK, P(topD, litW * SH_W, bottomH + SH_H)]);
            poly(g, shade(face, 0.88), 1, [P(d0, -litW * SH_W, bottomH), MB, PK, P(topD, -litW * SH_W, bottomH + SH_H)]);
            // Rim border — thick strips along every face edge (bold silhouette).
            for (const [e0, e1] of [[BL, TL], [TL, PK], [PK, TR], [TR, BR], [BR, BL]]) {
                limb(g, shade(rim, 0.92), 1, e0[0], e0[1], e1[0], e1[1], 1.7);
            }

            const faceP = (w: number, h: number): number[] => P(dAt(h), w, h);

            // Central keel FIRST — bosses/roundels sit on top of it.
            poly(g, keelC, 1, [
                P(d0 + 0.9, -1.0, bottomH + 0.6), P(d0 + 0.9, 1.0, bottomH + 0.6),
                P(topD + 0.9, 1.0, bottomH + SH_H - 0.4), P(topD + 0.9, 0, bottomH + SH_H + SH_ARCH - 0.6),
                P(topD + 0.9, -1.0, bottomH + SH_H - 0.4)
            ]);
            poly(g, shade(keelC, 1.22), 1, [
                P(d0 + 0.9, -1.0, bottomH + 0.6), P(d0 + 0.9, 0, bottomH + 0.6),
                P(topD + 0.9, 0, bottomH + SH_H + SH_ARCH - 0.6), P(topD + 0.9, -1.0, bottomH + SH_H - 0.4)
            ]);
            // L3 relaxed-idle ambient: a gold glint walking down the keel on
            // the exact 2000 ms loop (survives the bake probe: ~19 px travel).
            if (lvl === 3 && relaxed) {
                const gp = ((time % IDLE_MS) + IDLE_MS) % IDLE_MS / IDLE_MS;
                const gh = bottomH + 3.5 + gp * (SH_H - 7.5);
                const sp = P(dAt(gh) + 1, 0, gh);
                const gw = Math.max(fw, 0.4);
                g.fillStyle(0xffe789, 0.95);
                g.fillRect(sp[0] - 0.8 * gw, sp[1] - 1.3, 1.6 * gw, 2.6);
            }

            if (lvl === 1) {
                // Timber planks: two dark seams.
                for (const w of [-4.6, 3.4]) {
                    const b0 = faceP(w, bottomH + 2), t0 = faceP(w, bottomH + SH_H - 2.4);
                    limb(g, shade(face, 0.72), 0.85, b0[0], b0[1], t0[0], t0[1], 0.9);
                }
                // Bold painted chevron — the company mark, owner colour.
                const hm = bottomH + SH_H * 0.64;
                const cL = faceP(-5.2, hm - 3.4), cM = faceP(0, hm + 1.8), cR = faceP(5.2, hm - 3.4);
                limb(g, her.mid, 1, cL[0], cL[1], cM[0], cM[1], 3.2);
                limb(g, her.mid, 1, cM[0], cM[1], cR[0], cR[1], 3.2);
                // Small iron boss under the chevron (foreshortens with the face).
                const bp = faceP(0, bottomH + SH_H * 0.34);
                g.fillStyle(0x6f7a83, 1);
                g.fillEllipse(bp[0], bp[1], 4.2 * fw, 4.2);
            } else if (lvl === 2) {
                // Owner-colour field between two riveted steel straps.
                const h1 = bottomH + 5.4, h2 = bottomH + SH_H - 7;
                poly(g, her.deep, 0.95, [
                    faceP(-SH_W + 2, h1 + 1.2), faceP(SH_W - 2, h1 + 1.2),
                    faceP(SH_W - 2, h2 - 1.2), faceP(-SH_W + 2, h2 - 1.2)
                ]);
                for (const hs of [h1, h2]) {
                    const s0 = faceP(-SH_W + 1.2, hs), s1 = faceP(SH_W - 1.2, hs);
                    limb(g, steel, 1, s0[0], s0[1], s1[0], s1[1], 1.8);
                    for (const rw of [-SH_W + 2.2, SH_W - 2.2]) {
                        const rp = faceP(rw, hs);
                        g.fillStyle(shade(steel, 1.3), 1);
                        g.fillRect(rp[0] - 0.7 * fw, rp[1] - 0.7, 1.4 * fw, 1.4);
                    }
                }
                const bp = faceP(0, (h1 + h2) / 2);
                g.fillStyle(steel, 1);
                g.fillEllipse(bp[0], bp[1], 5.2 * fw, 5.2);
                g.fillStyle(shade(steel, 1.35), 1);
                g.fillEllipse(bp[0] - 0.7 * fw, bp[1] - 0.7, 2 * fw, 2);
            } else {
                // L3: parchment field, gold-ringed owner roundel (accents only).
                const rp = faceP(0, bottomH + SH_H * 0.58);
                g.fillStyle(0xdaa520, 1);
                g.fillEllipse(rp[0], rp[1], 7.4 * fw, 7.4);
                g.fillStyle(her.mid, 1);
                g.fillEllipse(rp[0], rp[1], 5.4 * fw, 5.4);
                poly(g, 0xdcd3ba, 1, [
                    [rp[0], rp[1] - 1.4], [rp[0] + 1.1 * fw, rp[1]], [rp[0], rp[1] + 1.4], [rp[0] - 1.1 * fw, rp[1]]
                ]);
            }
        } else {
            // BACK VIEW — the heraldic side is the far silhouette; the viewer
            // sees plain timber backing, battens, the grip spine and (while
            // carried/braced) the folded prop stake.
            poly(g, shade(rim, 0.62), 1, [BL, BR, TR, PK, TL]);
            poly(g, shade(rim, 0.5), 1, [BL2, BR2, BR, BL]);
            poly(g, backWood, 1, [BL2, BR2, TR2, PK2, TL2]);
            // Concave from behind: the screen-left half falls into shadow.
            const MB2 = P(d0 - SH_T, 0, bottomH);
            poly(g, shade(backWood, 0.82), 1, [P(d0 - SH_T, -SH_W, bottomH), MB2, PK2, P(topD - SH_T, -SH_W, bottomH + SH_H)]);
            poly(g, shade(backWood, 1.05), 1, [P(d0 - SH_T, SH_W, bottomH), MB2, PK2, P(topD - SH_T, SH_W, bottomH + SH_H)]);
            for (const [e0, e1] of [[BL2, TL2], [TL2, PK2], [PK2, TR2], [TR2, BR2], [BR2, BL2]]) {
                limb(g, shade(rim, 0.8), 1, e0[0], e0[1], e1[0], e1[1], 1.5);
            }
            const backP = (w: number, h: number): number[] => P(dAt(h) - SH_T, w, h);
            // Carrying battens.
            for (const hb of [bottomH + 5, bottomH + SH_H - 7]) {
                const b0 = backP(-SH_W + 1.2, hb), b1 = backP(SH_W - 1.2, hb);
                limb(g, shade(wood, 1.2), 1, b0[0], b0[1], b1[0], b1[1], 2);
            }
            // Grip spine + handle.
            const s0 = backP(0, bottomH + 1), s1 = backP(0, bottomH + SH_H - 1);
            limb(g, shade(wood, 0.85), 1, s0[0], s0[1], s1[0], s1[1], 1.8);
            const hm = bottomH + SH_H * 0.45;
            const g0 = backP(0, hm - 2), g1 = backP(0, hm + 2);
            limb(g, leather, 1, g0[0], g0[1], g1[0], g1[1], 2.6);
            // Folded prop stake laid diagonally across the backing.
            if (!relaxed) {
                const p0 = backP(-2.6, bottomH + SH_H - 6), p1 = backP(3.2, bottomH + 4.5);
                limb(g, shade(wood, 0.95), 1, p0[0], p0[1], p1[0], p1[1], 1.4);
            }
        }

        // Planted: dark contact line where the rim bites the lawn (extends
        // toward the viewer from the visible bottom edge — view-independent).
        if (!isMoving && bottomH < 0.5) {
            const eL = backView ? BL2 : BL, eR = backView ? BR2 : BR;
            poly(g, 0x2c3318, 0.5, [
                [eL[0] + 0.6, eL[1]], [eR[0] - 0.6, eR[1]],
                [eR[0] - 0.6, eR[1] + 1.3], [eL[0] + 0.6, eL[1] + 1.3]
            ]);
        }
    };

    // Folding prop stake — deployed only when he RESTS the shield.
    const drawProp = (): void => {
        if (!relaxed) return;
        const a0 = P(topD - 1.2, 4.2, bottomH + SH_H - 5);
        const a1 = P(d0 - 7.2, 4.8, 0.2);
        limb(g, wood, 1, a0[0], a0[1], a1[0], a1[1], 1.6);
        g.fillStyle(shade(wood, 0.7), 1);
        g.fillRect(a1[0] - 1.5, a1[1] - 0.8, 3, 1.6);
    };

    // ============================ the BEARER ================================
    const bd = -3.4 + bodyLean;
    const hipH = 8.5 - crouch * 0.5;
    const shoW = 4.8;
    const shoulderP = (side: number): number[] =>
        P(bd + 0.6, bw + side * shoW, hipH + 7.4 - crouch * 0.4 + lift * 0.6);
    const armTo = (side: number, tx: number, ty: number): void => {
        const sF = shoulderP(side);
        limb(g, shade(tunic, 0.92), 1, sF[0], sF[1], tx, ty, 2.5);
        g.fillStyle(skin, 1);
        g.fillCircle(tx, ty, 1.8);
    };

    const drawBody = (): void => {
        const legSpread = braced ? 4.6 : 3.4;
        // Legs (far one first by screen y), heavy boots.
        const legs = [-1, 1].map(side => ({
            hip: P(bd, bw + side * legSpread, hipH),
            foot: P(bd + (braced ? side * 2.2 : side * swing), bw + side * legSpread * 1.08, 0.6)
        })).sort((a, b) => a.foot[1] - b.foot[1]);
        for (const L of legs) {
            limb(g, trouser, 1, L.hip[0], L.hip[1], L.foot[0], L.foot[1], 2.8);
            g.fillStyle(boot, 1);
            g.fillEllipse(L.foot[0], L.foot[1] + 0.6, 4, 1.9);
        }
        // Barrel torso + belt + breath-lifted shoulders.
        const tC = P(bd, bw, hipH + 4.6 - crouch * 0.5 + lift * 0.6);
        g.fillStyle(shade(tunic, 0.82), 1);
        g.fillEllipse(tC[0] + 0.6, tC[1] + 0.6, 13, 11);
        g.fillStyle(tunic, 1);
        g.fillEllipse(tC[0], tC[1], 13, 11);
        poly(g, leather, 1, [
            P(bd, bw - 5.4, hipH + 1.9), P(bd, bw + 5.4, hipH + 1.9),
            P(bd, bw + 5.4, hipH + 0.4), P(bd, bw - 5.4, hipH + 0.4)
        ]);
        // Diagonal yoke strap across the chest.
        const s0 = P(bd, bw - 4.4, hipH + 8 + lift * 0.6), s1 = P(bd, bw + 4.4, hipH + 1.6);
        limb(g, leather, 1, s0[0], s0[1], s1[0], s1[1], 1.7);

        // Porter's bundle rides high on his back — visible when the viewer
        // is on his back side (shield in front of him).
        if (sinA >= 0.05) {
            const pC = P(bd - 3.4, bw, hipH + 7.6 + lift * 0.7);
            g.fillStyle(0x9c8b6a, 1);
            g.fillEllipse(pC[0], pC[1], 9.5, 5);
            limb(g, leather, 1, pC[0] - 2.6, pC[1] - 2.4, pC[0] - 2.6, pC[1] + 2.4, 1.1);
            limb(g, leather, 1, pC[0] + 2.6, pC[1] - 2.4, pC[0] + 2.6, pC[1] + 2.4, 1.1);
        }

        // Shoulder caps (steel from L2 up).
        for (const side of [-1, 1]) {
            const sh = P(bd, bw + side * 5.2, hipH + 8.2 - crouch * 0.4 + lift * 0.7);
            g.fillStyle(lvl >= 2 ? steel : shade(tunic, 1.12), 1);
            g.fillEllipse(sh[0], sh[1], 5.4, 3.6);
        }

        // Arms — grip the shield back while marching/bracing; the rest-pose
        // rim arm draws AFTER the shield so the hand shows round the edge.
        if (isMoving) {
            const grip = P(d0 - 1.4, -2.2, bottomH + 8.5);
            armTo(-1, grip[0], grip[1]);
            const free = P(bd - swing, bw + shoW + 0.8, 6.2);
            armTo(1, free[0], free[1]);
        } else if (braced) {
            const g1 = P(d0 - 1.4, -2.6, bottomH + 8.8);
            const g2 = P(d0 - 1.4, 2.8, bottomH + 6.6);
            armTo(-1, g1[0], g1[1]);
            armTo(1, g2[0], g2[1]);
        } else {
            // The hanging off-arm; the rim arm is drawn after the shield.
            const hang = P(bd - 0.6, bw - shoW - 0.8, 4.4 + lift * 0.4);
            armTo(-1, hang[0], hang[1]);
        }

        // Head — small against the bulk; ducks behind the rim when braced.
        const hC = P(bd + 0.8, bw, hipH + 11.4 - crouch * 0.6 - duck + lift);
        g.fillStyle(skin, 1);
        g.fillCircle(hC[0], hC[1], 3.6);
        if (lvl === 1) {
            // Padded arming hood.
            g.fillStyle(0x584a38, 1);
            g.beginPath();
            g.arc(hC[0], hC[1] - 0.7, 3.7, Math.PI, 0, false);
            g.closePath();
            g.fillPath();
            g.fillRect(hC[0] - 3.7, hC[1] - 0.9, 7.4, 1.6);
        } else {
            // Kettle helm: broad brim + dome (gold band at L3).
            g.fillStyle(shade(steel, 0.9), 1);
            g.fillEllipse(hC[0], hC[1] - 1.3, 8.6, 2.8);
            g.fillStyle(steel, 1);
            g.beginPath();
            g.arc(hC[0], hC[1] - 1.6, 3.1, Math.PI, 0, false);
            g.closePath();
            g.fillPath();
            if (lvl === 3) {
                g.fillStyle(0xdaa520, 1);
                g.fillRect(hC[0] - 3.1, hC[1] - 2.2, 6.2, 1);
            }
        }
    };

    // Rest pose: hand curled over the top rim corner — drawn LAST so it
    // stays visible whichever side of the slab the viewer is on, and high
    // enough that the forearm only clips the face's upper corner.
    const drawRestArm = (): void => {
        if (!relaxed) return;
        const hand = P(topD - SH_T * 0.5, 5.0, bottomH + SH_H + 0.4);
        const sF = shoulderP(1);
        limb(g, shade(tunic, 0.92), 1, sF[0], sF[1], hand[0], hand[1], 2.3);
        g.fillStyle(skin, 1);
        g.fillCircle(hand[0], hand[1], 1.8);
    };

    // ---- paint order: aim decides who stands in front ----------------------
    if (shieldInFront) {
        drawBody();
        drawProp();
        drawShield();
    } else {
        drawShield();
        drawProp();
        drawBody();
    }
    drawRestArm();

    // ---- strike dust: chips kicked off the lawn by the shove ---------------
    if (strike > 0 && !isMoving) {
        const t = 1 - strike; // 0 → 1 across the strike
        for (let i = 0; i < 3; i++) {
            const fp = P(d0 + 2.4 + t * 5, (i - 1) * 4.4, 0.4 + t * (1.6 + i * 0.9));
            g.fillStyle(0xcfc4a6, (1 - t) * 0.85);
            g.fillRect(fp[0] - 0.8, fp[1] - 0.8, 1.6, 1.6);
        }
    }
}
