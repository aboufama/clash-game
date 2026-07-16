import type Phaser from 'phaser';

/**
 * NECROMANCER — design C: "The Gravedigger".
 *
 * Concept: not a floaty lich — an earthy sexton-priest who DIGS his dead out
 * of the lawn. A hunched, bell-silhouetted figure in grave-violet wool, both
 * hands on a long SHOVEL-STAFF: iron spade blade resting in the soil at his
 * side, and at the crown a small caged SOUL-LANTERN (centered near local
 * y≈−16, where MainScene's summon flourish flashes). The attack cycle is the
 * summoning ritual itself: over the windup he wrenches the spade free and
 * hoists it two-handed overhead while grave-light gathers and ground runes
 * circle him; on the damage tick he SLAMS the blade into the earth — an
 * expanding burst ring, soil shards, and a light surge up the shaft.
 *
 * SKELETON — design C: "The Exhumed" (same file — the summon must read as
 * this necromancer's creation). A small, slight, dirt-crusted scrapper,
 * fresh out of the ground: grave-soil on the skull and shoulders, a rusted
 * spade-shard for a blade (the gravedigger's broken tools), violet ember
 * eyes and a soul-flame guttering inside the ribcage — the exact hue of the
 * summoner's lantern (0xb08aff family, matching the game's grave-light FX).
 *
 * AUTHORED PERIODS (the bake must use these):
 *   necromancer — stride 480 ms · windup 700 ms · strike 400 ms ·
 *                 idle EXACT 2000 ms loop (all idle terms are 2000-harmonics)
 *                 attack ages should be sampled against the RUNTIME
 *                 attackDelay (1600 ms base) — the pose reads windup/strike
 *                 relative to whatever delay is passed in.
 *   skeleton    — stride 300 ms · windup 260 ms · strike 150 ms ·
 *                 idle EXACT 2000 ms loop
 *
 * Contract notes: deterministic f(time) throughout (no Math.random); the
 * necromancer ignores facingAngle (dirs:1), the skeleton aims arm/blade/
 * skull/eyes along facingAngle with the iso 0.5 y-squash (dirs:8, aim-aware
 * layering: the weapon arm draws behind the body when pointing up-screen).
 * Glows that must survive the bake's binary alpha snap are drawn at
 * alpha ≥ 0.55; the 0.2-alpha contact shadows are vector-only niceties,
 * consistent with the rest of the troop roster.
 */

type G = Phaser.GameObjects.Graphics;
type P = [number, number];

const TAU = Math.PI * 2;

// Shared grave-light palette (matches MainScene.showSummonFlourish hues).
const FLAME_CORE = 0xefe4ff;
const FLAME_MID = 0xb08aff;
const FLAME_OUT = 0x8a63cc;
const GOLD = 0xdaa520;
const GOLD_LT = 0xffd700;
const IRON = 0x6a707a;
const IRON_DK = 0x474c55;
const RUST = 0x8a5a3a;
const DIRT = 0x554634;

const smooth = (t: number): number => t * t * (3 - 2 * t);

/** Multiply a 0xRRGGBB colour toward dark (m<1) or light (m>1). */
function tone(c: number, m: number): number {
    const r = Math.max(0, Math.min(255, Math.round(((c >> 16) & 0xff) * m)));
    const g = Math.max(0, Math.min(255, Math.round(((c >> 8) & 0xff) * m)));
    const b = Math.max(0, Math.min(255, Math.round((c & 0xff) * m)));
    return (r << 16) | (g << 8) | b;
}

const mix = (a: P, b: P, t: number): P => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];

/** Tapered thick segment (limb/shaft/blade) — thickness along the screen normal. */
function strip(g: G, a: P, b: P, w0: number, w1: number, color: number, alpha = 1): void {
    const dx = b[0] - a[0], dy = b[1] - a[1];
    const len = Math.hypot(dx, dy) || 1;
    const nx = -dy / len, ny = dx / len;
    g.fillStyle(color, alpha);
    g.beginPath();
    g.moveTo(a[0] + nx * w0 * 0.5, a[1] + ny * w0 * 0.5);
    g.lineTo(b[0] + nx * w1 * 0.5, b[1] + ny * w1 * 0.5);
    g.lineTo(b[0] - nx * w1 * 0.5, b[1] - ny * w1 * 0.5);
    g.lineTo(a[0] - nx * w0 * 0.5, a[1] - ny * w0 * 0.5);
    g.closePath();
    g.fillPath();
}

/** Attack-cycle state per the TroopRenderer contract: windup ramps 0→1 over
 *  the last windupMs BEFORE the damage tick, strike decays 1→0 over the
 *  first strikeMs after it; stale ages free-run on time so replays live. */
function atkAnim(time: number, attackAge: number, attackDelay: number, windupMs: number, strikeMs: number):
    { windup: number; strike: number; inCombat: boolean } {
    if (attackAge < 0 || attackDelay <= 0) return { windup: 0, strike: 0, inCombat: false };
    let age = attackAge;
    if (age > attackDelay + 600) age = time % attackDelay;
    const remaining = attackDelay - age;
    let windup = 0;
    if (remaining <= 0) windup = 1;
    else if (remaining <= windupMs) windup = 1 - remaining / windupMs;
    const strike = strikeMs > 0 && age <= strikeMs ? 1 - age / strikeMs : 0;
    return { windup, strike, inCombat: true };
}

// ============================ NECROMANCER ============================

/** Per-slot bake-param overrides (DesignRegistry.designBakeParams). delay
 *  1600 = the runtime TroopDefinitions attackDelay (NOT the table's pinned
 *  5000): SpriteBank matches baked attackAge by nearest value, and with
 *  delay 1600 the baked ages land at 901/1180/1390/1565 + 60/240, aligning
 *  with runtime windup/strike ages. windup 700 / strike 400 match the table;
 *  both idles close exactly on 2000 ms. Skeleton delay 900 already matches. */
export const PARAMS: import('./DesignRegistry').DesignParamsExport = {
    necromancer: { delay: 1600, idleMs: 2000 },
    skeleton: { idleMs: 2000 },
};

export function drawNecromancerC(
    g: G,
    isPlayer: boolean,
    isMoving: boolean,
    _facingAngle: number,
    troopLevel: number,
    time: number,
    attackAge: number,
    attackDelay: number,
    _driver: number
): void {
    const lvl = Math.max(1, Math.min(3, Math.round(troopLevel || 1)));
    const own = isPlayer ? 1 : 0.72; // enemy robes darken; grave-light hue is identity

    const robe = tone(0x5a4682, own);
    const robeDk = tone(0x3e2f5c, own);
    const robeHem = tone(0x2f2347, own);
    const hoodIn = 0x1c152e;
    const bone = tone(0xcfc9ae, isPlayer ? 1 : 0.88);
    const skin = tone(0x9a8fa6, own);
    const wood = lvl >= 2 ? 0x574334 : 0x4c3a29;
    const parch = 0xc9c2ae;

    const atk = atkAnim(time, attackAge, attackDelay || 1600, 700, 400);
    const w = atk.strike > 0 ? 1 : atk.windup; // hold the slam pose through the strike
    const hoist = smooth(w);

    // Gait / idle (idle terms are EXACT 2000 ms harmonics; walk terms close on the 480 ms stride).
    let bob = 0, hemSway = 0, ph = 0;
    let t2 = 0, breathe = 0;
    if (isMoving) {
        ph = (time % 480) / 480;
        const s = Math.sin(ph * TAU);
        bob = Math.abs(s) * 1.4;
        hemSway = s * 1.8;
    } else {
        t2 = (time % 2000) / 2000;
        breathe = Math.sin(t2 * TAU);
        bob = Math.max(0, breathe) * 0.45;
    }
    const rise = w * 1.3; // he un-hunches as the ritual peaks
    const oy = -bob - rise;

    // ---- contact shadow (vector nicety — binary alpha snap drops it, like the roster) ----
    g.fillStyle(0x000000, 0.22);
    g.fillEllipse(0, 9.6, 11, 4.1);

    // ---- staff pose: B = heel (spade), T = crown (lantern) ----
    const restB: P = [5.0, 9.3];
    const restT: P = [5.0 + hemSway * 0.4 + (isMoving ? Math.sin(ph * TAU) * 1.4 : 0), -15.8 - bob * 0.5];
    const apexB: P = [-4.6, 0.4];
    const apexT: P = [1.4, -19.6];
    const slamB: P = [-0.6, 9.6];
    const slamT: P = [7.0, -12.6];
    let B: P, T: P;
    if (atk.strike > 0) { B = slamB; T = slamT; }
    else if (atk.inCombat && w > 0) { B = mix(restB, apexB, hoist); T = mix(restT, apexT, hoist); }
    else { B = restB; T = restT; }

    // ---- windup ground runes: violet ticks circling his feet as light gathers ----
    if (atk.inCombat && w > 0.3 && atk.strike <= 0) {
        g.fillStyle(FLAME_OUT, 0.75);
        for (let k = 0; k < 3; k++) {
            const ra = 0.9 + k * (TAU / 3) + w * 1.1;
            g.fillRect(Math.cos(ra) * 7 - 0.7, 9.1 + Math.sin(ra) * 2.7 - 0.5, 1.4, 1.0);
        }
    }

    // ---- robe: bell gown, hem, chest — NW light: left edge lit, right edge dark ----
    g.fillStyle(robe, 1);
    g.beginPath();
    g.moveTo(-5.6 + hemSway * 0.3, 8.7);
    g.lineTo(-2.7, -4.6 + oy);
    g.lineTo(2.9, -4.6 + oy);
    g.lineTo(5.6 + hemSway * 0.3, 8.7);
    g.closePath();
    g.fillPath();
    g.fillStyle(robeHem, 1);
    g.fillEllipse(hemSway * 0.35, 8.7, 11.2 + w * 1.4, 3.9);
    // walking boot tips peeking under the hem
    if (isMoving) {
        const step = Math.sin(ph * TAU) * 2.6;
        g.fillStyle(0x241c17, 1);
        g.fillEllipse(-1.7 + step, 9.6, 2.7, 1.4);
        g.fillEllipse(1.7 - step, 9.6, 2.7, 1.4);
    }
    g.fillStyle(robe, 1);
    g.fillCircle(0.3, -3.4 + oy, 3.6);
    strip(g, [-5.0, 8.2], [-2.5 + hemSway * 0.2, -3.4 + oy], 2.0, 1.3, tone(robe, 1.22));
    strip(g, [5.1, 8.2], [2.9 + hemSway * 0.2, -3.0 + oy], 2.1, 1.4, tone(robe, 0.68));

    // sash + level dressing on the torso
    g.fillStyle(robeDk, 1);
    g.fillRect(-3.3, 0.6 + oy * 0.5, 6.6, 1.3);
    if (lvl >= 2) {
        g.fillStyle(bone, 1);
        g.fillCircle(-1.8, 2.1 + oy * 0.5, 0.62);
        g.fillCircle(0, 2.3 + oy * 0.5, 0.62);
        g.fillCircle(1.8, 2.1 + oy * 0.5, 0.62);
    }
    if (lvl >= 3) {
        // slim parchment stole strips + a small gold skull pendant — accents
        // only (never a cream mass; the robe stays grave-violet)
        g.fillStyle(tone(parch, 0.96), 1);
        g.fillRect(-2.1, -3.0 + oy, 1.05, 6.0);
        g.fillRect(1.15, -3.0 + oy, 1.05, 6.0);
        g.fillStyle(GOLD, 1);
        g.fillRect(-2.1, 2.4 + oy, 1.05, 0.8);
        g.fillRect(1.15, 2.4 + oy, 1.05, 0.8);
        g.fillCircle(0.2, -0.9 + oy, 0.8);
        g.fillStyle(GOLD_LT, 1);
        g.fillCircle(0.0, -1.1 + oy, 0.38);
    }

    // ---- shoulder mantle (L2+) ----
    if (lvl >= 2) {
        // shoulder mantle stays robe-dark at every level; L3 gilds its studs
        g.fillStyle(tone(robe, 0.8), 1);
        g.fillEllipse(0.2, -4.3 + oy, 8.2, 3.6);
        g.fillStyle(lvl >= 3 ? GOLD : bone, 1);
        g.fillCircle(-3.1, -3.9 + oy, 0.5);
        g.fillCircle(3.5, -3.9 + oy, 0.5);
    }

    // ---- hood + face void + ember eyes ----
    g.fillStyle(robe, 1);
    g.fillCircle(0.2, -7.3 + oy, 3.35);
    g.fillStyle(tone(robe, 1.25), 1);
    g.fillEllipse(-0.9, -8.5 + oy, 3.3, 2.1);
    // droopy hood peak
    g.fillStyle(robe, 1);
    g.beginPath();
    g.moveTo(-1.0, -9.9 + oy);
    g.lineTo(1.4, -9.6 + oy);
    g.lineTo(-1.8, -12.0 + oy);
    g.closePath();
    g.fillPath();
    if (lvl >= 3) { g.fillStyle(GOLD, 1); g.fillCircle(-1.5, -11.5 + oy, 0.45); }
    g.fillStyle(hoodIn, 1);
    g.fillEllipse(0.7, -6.9 + oy, 3.4, 2.9);
    // eyes: gutter in idle (2000-harmonic), flare hard while the ritual charges
    const eyeGlow = atk.inCombat ? 0.75 + 0.25 * w : 0.62 + 0.38 * Math.max(0, Math.sin(t2 * TAU * 2));
    g.fillStyle(FLAME_MID, 1);
    g.fillCircle(-0.2, -7.0 + oy, 0.72 + eyeGlow * 0.14);
    g.fillCircle(1.7, -6.9 + oy, 0.72 + eyeGlow * 0.14);
    g.fillStyle(FLAME_CORE, 0.9);
    g.fillCircle(-0.2, -7.1 + oy, 0.34);
    g.fillCircle(1.7, -7.0 + oy, 0.34);

    // ---- the shovel-staff ----
    const u: P = [(B[0] - T[0]), (B[1] - T[1])];
    const ul = Math.hypot(u[0], u[1]) || 1;
    const ud: P = [u[0] / ul, u[1] / ul]; // crown → heel direction
    // shaft
    strip(g, T, B, 1.15, 1.3, wood);
    strip(g, T, mix(T, B, 0.85), 0.45, 0.45, tone(wood, 1.3)); // lit edge
    if (lvl >= 2) {
        // iron collar bands
        const b1 = mix(T, B, 0.32), b2 = mix(T, B, 0.68);
        g.fillStyle(IRON, 1);
        g.fillRect(b1[0] - 1.0, b1[1] - 0.5, 2.0, 1.0);
        g.fillRect(b2[0] - 1.0, b2[1] - 0.5, 2.0, 1.0);
    }
    if (lvl >= 3) {
        const f1 = mix(T, B, 0.12);
        g.fillStyle(GOLD, 1);
        g.fillRect(f1[0] - 1.0, f1[1] - 0.6, 2.0, 1.2);
    }
    // spade blade at the heel (buried tip)
    const bTop: P = [B[0] - ud[0] * 2.6, B[1] - ud[1] * 2.6];
    const bTip: P = [B[0] + ud[0] * 1.5, B[1] + ud[1] * 1.5];
    strip(g, bTop, bTip, 3.4, 1.3, IRON);
    strip(g, mix(bTop, bTip, 0.15), bTip, 1.2, 0.5, IRON_DK);
    g.fillStyle(IRON_DK, 1);
    g.fillCircle(bTop[0], bTop[1], 0.85);
    if (lvl >= 3) strip(g, bTop, bTip, 0.5, 0.3, GOLD_LT, 0.9);

    // ---- arms: two-handed grip, sleeves from the shoulders to the shaft ----
    const grip1 = mix(B, T, 0.44); // lower hand (left arm crosses the body)
    const grip2 = mix(B, T, 0.62); // upper hand
    strip(g, [-2.3, -3.7 + oy], grip1, 2.2, 1.5, tone(robe, 0.9));
    strip(g, [2.6, -3.8 + oy], grip2, 2.2, 1.5, tone(robe, 1.05));
    g.fillStyle(skin, 1);
    g.fillCircle(grip1[0], grip1[1], 1.0);
    g.fillCircle(grip2[0], grip2[1], 1.0);

    // ---- soul-lantern at the crown ----
    const cage = lvl >= 3 ? tone(GOLD, 0.85) : IRON_DK;
    const flare = atk.strike > 0 ? atk.strike : (atk.inCombat ? w : 0);
    const idlePulse = atk.inCombat ? 0 : (Math.sin(t2 * TAU) + 1) * 0.5;
    g.fillStyle(cage, 1);
    g.fillCircle(T[0], T[1], 2.05);
    g.fillStyle(0x141020, 1);
    g.fillCircle(T[0], T[1], 1.55);
    // flame: halo committed at ≥0.55 alpha so the bake keeps it; the flare
    // grows RESTRAINED (a swollen flat ball read terribly) — the surge is
    // carried by the converge-wisps, runes and the strike flash instead
    g.fillStyle(FLAME_OUT, 0.62);
    g.fillCircle(T[0], T[1], 1.85 + idlePulse * 0.45 + flare * 0.9);
    g.fillStyle(FLAME_MID, 1);
    g.fillCircle(T[0], T[1], 1.15 + idlePulse * 0.25 + flare * 0.45);
    g.fillStyle(FLAME_CORE, 1);
    g.fillCircle(T[0], T[1] - 0.15, 0.55 + idlePulse * 0.15 + flare * 0.3);
    // cage bars + finial
    g.fillStyle(cage, 1);
    g.fillRect(T[0] - 1.8, T[1] - 0.35, 3.6, 0.7);
    g.fillRect(T[0] - 0.3, T[1] - 1.9, 0.6, 3.8);
    g.fillCircle(T[0] - ud[0] * 2.6, T[1] - ud[1] * 2.6, lvl >= 3 ? 0.7 : 0.55);
    if (lvl >= 3) { g.fillStyle(GOLD_LT, 1); g.fillCircle(T[0] - ud[0] * 2.6, T[1] - ud[1] * 2.6 - 0.2, 0.3); }

    // ---- wisps ----
    if (!atk.inCombat) {
        if (isMoving) {
            // trailing pair, bobbing on the stride period (exact 480 ms loop)
            const wob = Math.sin(ph * TAU) * 1.1;
            wisp(g, T[0] - 4.6, T[1] + 2.2 + wob, 0.95);
            wisp(g, T[0] - 7.2, T[1] + 4.6 - wob * 0.8, 0.7);
        } else {
            // two orbiters on the exact 2000 ms idle loop (~9 px sweep — quantization-proof)
            const th = t2 * TAU;
            wisp(g, T[0] + Math.cos(th) * 4.5, T[1] + 0.7 + Math.sin(th) * 2.1, 1.0);
            wisp(g, T[0] + Math.cos(th + Math.PI) * 3.3, T[1] + 2.1 + Math.sin(th + Math.PI) * 1.5, 0.72);
        }
    } else if (atk.strike <= 0 && w > 0.12) {
        // the gathering: three souls converge on the lantern as the ritual charges
        for (let k = 0; k < 3; k++) {
            const aa = 0.5 + k * 2.1;
            const d = (1 - w) * 8.5 + 1.7;
            wisp(g, T[0] + Math.cos(aa) * d, T[1] + Math.sin(aa) * d * 0.55, 0.62 + w * 0.38);
        }
    }

    // ---- the slam: burst ring, soil shards, light surge up the shaft ----
    if (atk.strike > 0) {
        const s = atk.strike;
        if (s > 0.5) strip(g, B, mix(B, T, 0.55), 1.9 * s, 0.8, FLAME_MID, 0.9);
        if (s > 0.55) {
            g.fillStyle(FLAME_OUT, 0.6);
            g.fillEllipse(B[0], 9.3, 12 * (1.25 - s * 0.35), 4.6 * (1.25 - s * 0.35));
        }
        if (s > 0.35) {
            const re = 3.2 + (1 - s) * 7.5;
            g.fillStyle(FLAME_MID, 0.9);
            for (let k = 0; k < 10; k++) {
                const ra = (k / 10) * TAU;
                g.fillRect(B[0] + Math.cos(ra) * re - 0.55, 9.2 + Math.sin(ra) * re * 0.42 - 0.45, 1.1, 0.9);
            }
            // soil clods kicked loose
            g.fillStyle(DIRT, 1);
            const fly = 1 - s;
            const dxs = [-1.6, -0.5, 0.7, 1.5];
            for (let k = 0; k < 4; k++) {
                g.fillCircle(B[0] + dxs[k] * fly * 6, 8.6 - fly * 8.5 + fly * fly * 7 + k * 0.4, 0.65);
            }
        }
    }
}

/** Small two-tone soul wisp (halo committed at bake-surviving alpha). */
function wisp(g: G, x: number, y: number, k: number): void {
    g.fillStyle(FLAME_OUT, 0.62);
    g.fillCircle(x, y, 1.35 * k);
    g.fillStyle(FLAME_CORE, 1);
    g.fillCircle(x, y - 0.2 * k, 0.55 * k);
}

// ============================ SKELETON ============================

export function drawSkeletonC(
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
    const bone = tone(0xd6d2bd, isPlayer ? 1 : 0.82);
    const boneDk = tone(bone, 0.72);
    const crack = tone(bone, 0.5);

    const atk = atkAnim(time, attackAge, attackDelay || 900, 260, 150);

    // Aim toolkit (screen-space angle, iso 0.5 y-squash).
    const a = facingAngle || 0;
    const ca = Math.cos(a), sa = Math.sin(a);
    const ax = (d: number): number => ca * d;
    const ay = (d: number): number => sa * 0.5 * d;
    const px = (v: number): number => -sa * v;
    const py = (v: number): number => ca * 0.5 * v;

    // Gait (exact 300 ms loop) / idle (exact 2000 ms loop).
    let hop = 0, swing = 0, rattle = 0;
    let sway = 0, flick = 0, jaw = 0;
    if (isMoving) {
        const ph = (time % 300) / 300;
        const s = Math.sin(ph * TAU);
        swing = s * 2.3;
        hop = Math.abs(s) * 1.5;
        rattle = Math.sin(ph * TAU * 2 + 0.9) * 0.5;
    } else {
        const t2 = (time % 2000) / 2000;
        sway = Math.sin(t2 * TAU) * 0.8;
        flick = (Math.sin(t2 * TAU * 2 + 0.6) + 1) * 0.5;
        jaw = Math.max(0, Math.sin(t2 * TAU * 2)) * 1.1;
    }

    // Whole-body lunge: coil back through the windup, spring along the aim on the tick.
    const lungeD = atk.strike > 0 ? 2.3 * atk.strike : -1.3 * smooth(atk.windup);
    const bx = ax(lungeD) + sway + rattle;
    const by = ay(lungeD) - hop;

    // contact shadow (vector nicety)
    g.fillStyle(0x000000, 0.2);
    g.fillEllipse(0, 9.6, 7.5, 2.9);
    // grave-soil specks at its feet — it just climbed out
    g.fillStyle(DIRT, 1);
    g.fillCircle(-2.7, 9.4, 0.6);
    g.fillCircle(3.0, 9.7, 0.5);

    const C: P = [bx, -0.6 + by]; // ribcage center
    const S_w: P = [C[0] + px(2.2), C[1] + py(2.2) - 1.2]; // weapon shoulder
    const S_o: P = [C[0] - px(2.2), C[1] - py(2.2) - 1.2]; // off shoulder
    const armBehind = sa < -0.15; // aiming up-screen → weapon behind the body

    // ---- weapon arm + spade-shard blade (closure so layering can flip) ----
    const drawWeaponArm = (): void => {
        const rest: P = [S_w[0] + ax(2.1) + px(0.7), S_w[1] + ay(2.1) + py(0.7) + 1.0];
        const back: P = [S_w[0] + ax(-1.7) + px(1.7), S_w[1] + ay(-1.7) + py(1.7) - 1.9];
        const swept: P = [S_w[0] + ax(3.7) - px(0.5), S_w[1] + ay(3.7) - py(0.5) + 0.3];
        let hand: P;
        if (atk.strike > 0) hand = mix(rest, swept, atk.strike * atk.strike * (3 - 2 * atk.strike) * 0.9 + 0.1);
        else if (atk.windup > 0) hand = mix(rest, back, smooth(atk.windup));
        else {
            hand = rest;
            if (isMoving) { hand = [rest[0] + ax(-swing * 0.5), rest[1] + ay(-swing * 0.5)]; }
        }
        strip(g, S_w, hand, 1.45, 1.2, bone);
        g.fillStyle(boneDk, 1);
        g.fillCircle(hand[0], hand[1], 0.7);
        if (lvl >= 2) { g.fillStyle(IRON, 1); g.fillRect(mix(S_w, hand, 0.5)[0] - 0.9, mix(S_w, hand, 0.5)[1] - 0.8, 1.8, 1.6); }
        // rusted spade-shard: tip raised through the windup, driven flat on the strike
        const tipLift = atk.strike > 0 ? -0.8 * atk.strike : 2.4 * smooth(atk.windup);
        const tip: P = [hand[0] + ax(3.1), hand[1] + ay(3.1) - tipLift];
        strip(g, hand, tip, 2.3, 0.7, RUST);
        strip(g, mix(hand, tip, 0.2), tip, 1.0, 0.35, IRON_DK);
        if (lvl >= 3) strip(g, mix(hand, tip, 0.15), tip, 0.45, 0.25, GOLD_LT, 0.9);
        // slash arc on the tick
        if (atk.strike > 0.4) {
            g.fillStyle(FLAME_MID, 0.85);
            for (let k = -1; k <= 1; k++) {
                const oa = a + k * 0.45;
                g.fillRect(C[0] + Math.cos(oa) * 4.6 - 0.5, C[1] + Math.sin(oa) * 2.3 + 0.4 - 0.45, 1.0, 0.9);
            }
        }
    };

    if (armBehind) drawWeaponArm();

    // ---- legs (thin bone, feet swing along the aim when scuttling) ----
    const liftA = isMoving ? Math.max(0, Math.sin((time % 300) / 300 * TAU)) * 1.3 : 0;
    const liftB = isMoving ? Math.max(0, -Math.sin((time % 300) / 300 * TAU)) * 1.3 : 0;
    const footA: P = [-1.7 + ax(swing * 0.8), 9.2 - liftA];
    const footB: P = [1.7 - ax(swing * 0.8), 9.2 - liftB];
    strip(g, [bx * 0.5 - 1.3, 3.9 + by * 0.5], footA, 1.45, 1.15, bone);
    strip(g, [bx * 0.5 + 1.3, 3.9 + by * 0.5], footB, 1.45, 1.15, boneDk);
    g.fillStyle(boneDk, 1);
    g.fillEllipse(footA[0] + 0.4, footA[1] + 0.2, 2.3, 1.4);
    g.fillEllipse(footB[0] + 0.4, footB[1] + 0.2, 2.3, 1.4);

    // ---- pelvis + spine ----
    g.fillStyle(bone, 1);
    g.fillEllipse(bx * 0.6, 3.6 + by * 0.6, 3.7, 2.3);
    g.fillStyle(boneDk, 1);
    g.fillRect(bx * 0.6 - 0.45, 2.9 + by * 0.6, 0.9, 1.2);
    strip(g, [bx * 0.75, 2.6 + by * 0.75], [C[0], C[1] + 1.6], 1.35, 1.2, boneDk);

    // ---- off arm (counter-swing) ----
    const offHand: P = [
        S_o[0] + ax(1.1 + (isMoving ? swing * 0.5 : 0)) - px(1.0),
        S_o[1] + ay(1.1 + (isMoving ? swing * 0.5 : 0)) - py(1.0) + 1.3 - smooth(atk.windup) * 0.8
    ];
    strip(g, S_o, offHand, 1.35, 1.1, boneDk);
    g.fillStyle(boneDk, 1);
    g.fillCircle(offHand[0], offHand[1], 0.6);

    // ---- ribcage with the soul-flame guttering inside ----
    g.fillStyle(bone, 1);
    g.fillEllipse(C[0], C[1], 4.8, 5.3);
    g.fillStyle(0x241c30, 1);
    g.fillEllipse(C[0] + 0.2, C[1] + 0.1, 2.6, 3.2);
    // the summoner's grave-light, alive in its chest
    const fl = atk.inCombat ? 0.55 + 0.45 * Math.max(atk.windup, atk.strike) : 0.35 + 0.65 * flick;
    g.fillStyle(FLAME_OUT, 0.62);
    g.fillCircle(C[0] + 0.2, C[1] + 0.1, 1.05 + fl * 0.45);
    g.fillStyle(FLAME_CORE, 1);
    g.fillCircle(C[0] + 0.2, C[1] - 0.1 - fl * 0.25, 0.55 + fl * 0.18);
    // rib bars across the hollow
    g.fillStyle(bone, 1);
    g.fillRect(C[0] - 1.6, C[1] - 1.1, 3.4, 0.62);
    g.fillRect(C[0] - 1.6, C[1] + 0.3, 3.4, 0.62);
    // shoulder knobs + grave dirt on one shoulder
    g.fillStyle(bone, 1);
    g.fillCircle(S_w[0], S_w[1], 0.85);
    g.fillCircle(S_o[0], S_o[1], 0.85);
    g.fillStyle(DIRT, 1);
    g.fillCircle(S_o[0] - 0.3, S_o[1] - 0.6, 0.72);

    // ---- skull: turned along the aim, ember eyes, chattering jaw ----
    const H: P = [C[0] + ax(0.9), C[1] - 3.7 + ay(0.9) - (isMoving ? Math.sin((time % 300) / 300 * TAU * 2) * 0.4 : 0)];
    g.fillStyle(bone, 1);
    g.fillCircle(H[0], H[1], 2.15);
    strip(g, [H[0] - 0.9, H[1] - 0.7], [H[0] + 0.2, H[1] + 0.3], 0.35, 0.35, crack); // hairline crack
    // jaw
    g.fillStyle(boneDk, 1);
    g.fillRect(H[0] + ax(0.7) - 0.95, H[1] + 1.5 + jaw * 0.55, 1.9, 0.9);
    // grave dirt cap smudge / L2 iron cap / L3 gold circlet
    if (lvl >= 2) {
        g.fillStyle(lvl >= 3 ? IRON : tone(IRON, 0.85), 1);
        g.fillEllipse(H[0], H[1] - 1.25, 4.1, 2.0);
        if (lvl >= 3) { g.fillStyle(GOLD, 1); g.fillRect(H[0] - 1.9, H[1] - 1.05, 3.8, 0.62); }
    } else {
        g.fillStyle(DIRT, 1);
        g.fillEllipse(H[0] - 0.5, H[1] - 1.6, 1.9, 1.0);
    }
    // ember eyes track the aim (brighten with the flame) — kept small and
    // separated so they don't merge into one violet blob on the tiny skull
    const eb = 0.42 + fl * 0.16;
    g.fillStyle(FLAME_MID, 1);
    g.fillCircle(H[0] + ax(1.0) + px(0.95), H[1] + ay(1.0) + py(0.95) - 0.25, eb);
    g.fillCircle(H[0] + ax(1.0) - px(0.95), H[1] + ay(1.0) - py(0.95) - 0.25, eb);

    if (!armBehind) drawWeaponArm();
}
