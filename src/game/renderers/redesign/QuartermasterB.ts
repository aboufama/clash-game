import type Phaser from 'phaser';

type G = Phaser.GameObjects.Graphics;

/**
 * QUARTERMASTER — design B: "the grizzled veteran sergeant".
 *
 * A lean, weathered drill sergeant rather than a barrel-chested drummer boy:
 * narrow campaign coat, grey beard, brow scar, worn forage cap. His field
 * drum is slung HIGH on one shoulder strap (over the right shoulder, drum at
 * the left chest); the right hand carries the single stick and crosses over
 * to strike, the left fist hangs free and clenches up on every hit. A
 * tattered campaign banner rides a back-pole — stripe honors on the cloth
 * mark the tier — and his medals glint on the beat.
 *
 * MOTION CONTRACT (bake-safe, iron rule 3 — everything deterministic f(time)):
 *  - IDLE (the hero, bakes as the aura heartbeat): WAR-DRUM BEAT on an EXACT
 *    2000 ms period — two strikes per bar (raise → poise → snap → contact
 *    flash with skin flex + impact ring → rebound). Every term is a pure
 *    function of the 2000 ms phase (250 ms-multiple period; the arm swings
 *    ~6 world px, far past the ≥1.5 px probe threshold).
 *  - WALK: march-in-place on an EXACT 450 ms stride — alternating knee
 *    lifts, body bob, the drum bouncing on its strap, banner swaying on the
 *    same 450 ms period so the 6-frame walk bake closes seamlessly.
 *  - NO attack (damage 0): attackAge/attackDelay/driver are ignored.
 *  - SYMMETRIC (dirs: 1): facingAngle is ignored; the read is front-on.
 *
 * Tiers (gold 0xd4a017 as ACCENTS only): L1 rope-tension field wood, one
 * medal, one campaign stripe · L2 iron hoops + rods, chevrons, two medals,
 * two stripes · L3 gold hoops/rods, gold cap band + finial, three medals,
 * three stripes (top one gold). No baked translucency — every flash/ring is
 * opaque geometry that simply stops being drawn.
 */

/** Multiply a 0xRRGGBB colour toward dark (m<1) or light (m>1). */
function shade(c: number, m: number): number {
    const r = Math.max(0, Math.min(255, Math.round(((c >> 16) & 0xff) * m)));
    const g = Math.max(0, Math.min(255, Math.round(((c >> 8) & 0xff) * m)));
    const b = Math.max(0, Math.min(255, Math.round((c & 0xff) * m)));
    return (r << 16) | (g << 8) | b;
}

/** Per-channel lerp between two 0xRRGGBB colours. */
function mixc(a: number, b: number, t: number): number {
    const k = t < 0 ? 0 : t > 1 ? 1 : t;
    const r = Math.round(((a >> 16) & 0xff) + (((b >> 16) & 0xff) - ((a >> 16) & 0xff)) * k);
    const g = Math.round(((a >> 8) & 0xff) + (((b >> 8) & 0xff) - ((a >> 8) & 0xff)) * k);
    const bl = Math.round((a & 0xff) + ((b & 0xff) - (a & 0xff)) * k);
    return (r << 16) | (g << 8) | bl;
}

/** Smoothstep 0..1. */
function ss(t: number): number {
    const k = t < 0 ? 0 : t > 1 ? 1 : t;
    return k * k * (3 - 2 * k);
}

/** Filled quad (painter's order building block). */
function quad(g: G, x1: number, y1: number, x2: number, y2: number, x3: number, y3: number, x4: number, y4: number, color: number): void {
    g.fillStyle(color, 1);
    g.beginPath();
    g.moveTo(x1, y1);
    g.lineTo(x2, y2);
    g.lineTo(x3, y3);
    g.lineTo(x4, y4);
    g.closePath();
    g.fillPath();
}

/** One limb segment drawn as a thick quad from (x0,y0) to (x1,y1). */
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

const IDLE_P = 2000; // exact idle bar (250 ms multiple — the declared bake period)
const STRIDE = 450;  // exact march cadence

export function drawQuartermasterB(
    g: G,
    isPlayer: boolean,
    isMoving: boolean,
    _facingAngle: number,
    troopLevel: number,
    time: number,
    _attackAge: number,
    _attackDelay: number,
    _driver: number
): void {
    const lvl = Math.max(1, Math.min(3, Math.round(troopLevel) || 1));

    // ================= motion state (deterministic f(time)) =================
    let lift = 0;        // body rise from the march
    let kneeL = 0, kneeR = 0;
    let h = 0.5;         // stick height: 0 = contact on the head, 1 = raised
    let flash = 0;       // 1→0 impact window right after the contact
    let beatHalf = 0;    // which strike of the bar (alternates the medal glint)
    let fistPump = 0;    // free fist jerks up on the hit
    let fistSway = 0;    // fist swings with the stride
    let drumBob = 0;     // drum bouncing on its strap
    let by = 0;          // upper-body y offset (dip/breath/bob)
    let wp = 0;          // banner wave phase 0..1 (period matches the state)
    let glint = 0;       // medal glint intensity

    if (isMoving) {
        const ph = ((time % STRIDE) + STRIDE) % STRIDE / STRIDE;
        const s = Math.sin(ph * Math.PI * 2);
        kneeL = Math.max(0, s) * 2.8;
        kneeR = Math.max(0, -s) * 2.8;
        lift = Math.abs(s) * 1.1;
        by = -lift;
        drumBob = Math.sin(ph * Math.PI * 2 - 1.1) * 0.8;
        h = 0.5 + s * 0.08;          // stick held at the carry, ticking along
        fistPump = Math.max(0, -s) * 0.7;
        fistSway = s * 0.6;
        wp = ph;                      // banner sways on the 450 ms stride
        glint = ph > 0.2 && ph < 0.34 ? 1 : 0;
    } else {
        const p = ((time % IDLE_P) + IDLE_P) % IDLE_P / IDLE_P;
        wp = p;                       // banner wave on the same 2000 ms bar
        beatHalf = Math.floor(p * 2) % 2;
        const q = (p * 2) % 1;        // two strikes per bar (exact harmonic)
        if (q < 0.34) h = 0.12 + 0.88 * ss(q / 0.34);          // raise
        else if (q < 0.52) h = 1;                               // poised
        else if (q < 0.56) h = 1 - (q - 0.52) / 0.04;           // snap down
        else if (q < 0.72) h = 0.3 * Math.sin(Math.PI * (q - 0.56) / 0.16); // rebound
        else h = 0.12 * ss((q - 0.72) / 0.28);                  // settle
        flash = q >= 0.56 && q < 0.72 ? 1 - (q - 0.56) / 0.16 : 0;
        by = flash * 0.8 - 0.3 * Math.sin(p * Math.PI * 2);     // dip + breath
        drumBob = flash * 0.7;
        fistPump = flash * 1.2 + 0.2 * Math.sin(p * Math.PI * 2);
        glint = flash > 0.15 && flash < 0.85 ? 1 : 0;
    }

    // ============================== palette ==============================
    const gold = 0xd4a017;
    const skin = isPlayer ? 0xd9b184 : 0xc59f6d;      // weathered leather-tan
    const coat = isPlayer ? 0x5a6a41 : 0x74392f;      // faded campaign coat
    const coatD = isPlayer ? 0x3d4a2c : 0x4e2620;
    const coatL = shade(coat, 1.22);
    const trouser = isPlayer ? 0x4c4239 : 0x413229;
    const boot = 0x2a211a;
    const grey = isPlayer ? 0xb5ad9e : 0xa89f92;      // grizzled beard/brows
    const strapCol = 0x4a3722;
    const cloth = isPlayer ? 0x3f5a35 : 0x6e3129;     // banner field
    const clothD = shade(cloth, 0.72);
    const parch = 0xe3d5b4;
    const hoop = lvl >= 3 ? gold : lvl === 2 ? 0x565b64 : 0x6a4520;
    const shellC = lvl >= 3 ? 0xa87c44 : lvl === 2 ? 0x8a5f34 : 0x9c6a30;
    const headBase = lvl >= 3 ? 0xefe3c4 : 0xe8dcc0;
    const headCol = mixc(headBase, 0xfff3d6, flash); // skin flex brightens
    const metal = lvl >= 3 ? gold : lvl === 2 ? 0x8b9098 : 0x6f6353;

    // ========================== 1. contact shadow ==========================
    g.fillStyle(0x000000, 0.22);
    g.fillEllipse(0, 9.6, 10.5 + flash * 0.6, 3.9);

    // ================= 2. campaign banner on the back-pole =================
    // ONE waving cloth polygon (fewer, bolder shapes): the top edge rides the
    // crossbar, the sheet shears progressively with depth on the state's
    // exact period, and the bottom edge carries a fixed tatter zigzag.
    // Stripe honors run as continuous bands that follow the same wave.
    const poleTopX = 3.9, poleTopY = -20.2 + by;
    limb(g, 0x50391f, 2.8, 2.5 + by, poleTopX, poleTopY, 1.15);
    limb(g, 0x5d4426, 0.9, -19.4 + by, 7.0, -19.0 + by, 1.0); // crossbar
    const bx0 = 1.15, bw = 5.9;
    const topYat = (x: number) => -19.3 + (x - 0.9) * 0.08 + by;
    // Wave shear at depth f (0 = attached top edge, 1 = free bottom edge) —
    // both terms exact harmonics of the state's period; the f factor pins
    // the attached edge and lets the free edge swing ~1.8 world px.
    const wav = (f: number) => f * (1.35 * Math.sin(wp * Math.PI * 2 - f * 1.9)
        + 0.45 * Math.sin(wp * Math.PI * 4 - f * 2.6));
    // Bottom tatter [widthFrac, drop] pairs, right → left (worn cloth at L1).
    const tatter: Array<[number, number]> = lvl >= 2
        ? [[1, 7.3], [0.84, 6.1], [0.66, 7.9], [0.47, 6.3], [0.30, 7.7], [0.13, 5.9], [0, 6.6]]
        : [[1, 7.5], [0.84, 5.7], [0.66, 8.2], [0.47, 5.9], [0.30, 7.9], [0.13, 5.5], [0, 6.6]];
    g.fillStyle(cloth, 1);
    g.beginPath();
    g.moveTo(bx0, topYat(bx0));
    g.lineTo(bx0 + bw, topYat(bx0 + bw));
    g.lineTo(bx0 + bw + wav(0.55), topYat(bx0 + bw) + 7.3 * 0.55); // right edge bow
    for (const [wf, drop] of tatter) {
        const x = bx0 + wf * bw;
        g.lineTo(x + wav(drop / 8), topYat(x) + drop);
    }
    g.lineTo(bx0 + wav(0.55), topYat(bx0) + 6.6 * 0.55); // left edge bow
    g.closePath();
    g.fillPath();
    // Pole-side shading strip (depth cue, follows the wave).
    quad(g, bx0, topYat(bx0), bx0 + 0.9, topYat(bx0 + 0.9),
        bx0 + 0.9 + wav(0.8), topYat(bx0 + 0.9) + 6.2, bx0 + wav(0.8), topYat(bx0) + 6.2, clothD);
    // Campaign stripe honors — count = tier, top stripe gold at max.
    const stripeFracs = lvl === 1 ? [0.42] : lvl === 2 ? [0.30, 0.52] : [0.24, 0.44, 0.64];
    for (let s = 0; s < stripeFracs.length; s++) {
        const f = stripeFracs[s];
        const yL = topYat(bx0) + 6.9 * f, yR = topYat(bx0 + bw) + 6.9 * f;
        const o = wav(f), o2 = wav(f + 0.18);
        const sCol = lvl >= 3 && s === 0 ? gold : parch;
        quad(g, bx0 + o, yL, bx0 + bw + o, yR, bx0 + bw + o2, yR + 1.35, bx0 + o2, yL + 1.35, sCol);
    }
    if (lvl >= 3) { // gold finial — accent, not a mass
        g.fillStyle(gold, 1);
        g.fillCircle(poleTopX, poleTopY - 0.7, 1.0);
    }

    // ====================== 3. legs (march in place) ======================
    g.fillStyle(trouser, 1);
    g.fillRect(-2.7, 3.5 - lift, 2, 5.8 + lift - kneeL);
    g.fillRect(0.7, 3.5 - lift, 2, 5.8 + lift - kneeR);
    g.fillStyle(boot, 1);
    g.fillEllipse(-1.7, 9.3 - kneeL, 3.1, 1.7);
    g.fillEllipse(1.7, 9.3 - kneeR, 3.1, 1.7);

    // ====================== 4. lean campaign-coat torso ======================
    g.fillStyle(coatD, 1);
    g.fillRoundedRect(-3.2, -6.3 + by, 6.4, 9.8, 2.4);
    g.fillStyle(coat, 1);
    g.fillRoundedRect(-2.8, -6.0 + by, 5.6, 9.2, 2.1);
    g.fillStyle(coatL, 1); // NW light on the left flank
    g.fillRect(-2.6, -5.4 + by, 1.2, 7.0);
    g.fillStyle(coatD, 1); // coat placket
    g.fillRect(0.1, -5.6 + by, 0.9, 8.0);
    g.fillStyle(0x33291d, 1); // belt
    g.fillRect(-2.8, 1.5 + by, 5.6, 1.7);
    g.fillStyle(metal, 1);
    g.fillRect(-0.6, 1.65 + by, 1.5, 1.4);
    if (lvl >= 2) { // epaulette on the strap shoulder
        g.fillStyle(coatD, 1);
        g.fillRect(1.3, -6.2 + by, 2.3, 1.3);
        if (lvl >= 3) {
            g.fillStyle(gold, 1);
            g.fillRect(1.3, -5.15 + by, 2.3, 0.5);
        }
    }

    // ================= 5. free-fist arm (hangs past the drum) =================
    limb(g, coat, -2.6, -4.9 + by, -6.5, -1.6 + by, 2.0);          // upper sleeve
    limb(g, coat, -6.5, -1.6 + by, -7.3 + fistSway, 1.3 + by - fistPump, 1.8); // forearm
    if (lvl >= 2) { // sergeant chevrons on the free sleeve (worn braid)
        g.lineStyle(0.8, 0xc9b06a, 1);
        for (let k = 0; k < lvl - 1; k++) {
            const cy = -3.3 + by + k * 1.25;
            g.lineBetween(-5.6, cy, -4.7, cy + 0.7);
            g.lineBetween(-4.7, cy + 0.7, -3.8, cy);
        }
    }

    // =================== 6. the field drum, slung high ===================
    const drumY = by + drumBob;
    const rx = 2.9;
    const Tx = -4.2, Ty = -3.0 + drumY;   // playing-head centre
    const Bx = -3.5, By2 = 1.7 + drumY;   // slight forward tilt at the base
    g.fillStyle(shade(hoop, 0.85), 1);    // bottom hoop peeks under the shell
    g.fillEllipse(Bx, By2, rx * 2 + 0.6, 2.9);
    quad(g, Tx - rx, Ty, Tx + rx, Ty, Bx + rx, By2, Bx - rx, By2, shellC);
    quad(g, Tx - rx, Ty, Tx - rx + 1.3, Ty, Bx - rx + 1.3, By2, Bx - rx, By2, shade(shellC, 1.25));
    quad(g, Tx + rx - 1.2, Ty, Tx + rx, Ty, Bx + rx, By2, Bx + rx - 1.2, By2, shade(shellC, 0.7));
    if (lvl === 1) { // hemp rope tension, zig-zag
        g.lineStyle(0.85, 0xb59a6a, 1);
        for (let i = 0; i < 4; i++) {
            const tx = Tx - rx + 0.9 + i * 1.45;
            g.lineBetween(tx, Ty + 0.6, tx + 0.75, By2 - 0.5);
            g.lineBetween(tx + 0.75, By2 - 0.5, tx + 1.5, Ty + 0.6);
        }
    } else { // iron / gold tension rods
        g.lineStyle(0.9, lvl >= 3 ? gold : 0x565b64, 1);
        for (let i = 0; i < 4; i++) {
            const tx = Tx - rx + 0.75 + i * 1.5;
            g.lineBetween(tx, Ty + 0.5, tx + 0.7, By2 - 0.4);
        }
    }
    g.fillStyle(hoop, 1); // top hoop
    g.fillEllipse(Tx, Ty, rx * 2 + 0.7, 3.1);
    g.fillStyle(shade(hoop, 0.68), 1);
    g.fillEllipse(Tx, Ty, rx * 2 - 0.5, 2.4);
    // The skin: flexes (squashes) and brightens inside the contact window.
    g.fillStyle(headCol, 1);
    g.fillEllipse(Tx, Ty - 0.1, rx * 2 - 1.1, 2.0 * (1 - flash * 0.16));
    if (flash > 0) { // opaque impact ring rolling out from the strike
        g.lineStyle(0.9, 0xf7ecd2, 1);
        g.strokeEllipse(Tx, Ty - 0.1, (1.5 + (1 - flash) * 2.4) * 2, (0.62 + (1 - flash) * 1.0) * 2);
        g.fillStyle(shade(headCol, 0.8), 1); // dent right under the stick tip
        g.fillCircle(Tx + 0.3, Ty - 0.4, 0.7);
    }

    // ============ 7. the one shoulder strap (over the drum rim) ============
    limb(g, strapCol, 2.4, -5.1 + by, -1.4, -2.9 + drumY, 1.35);
    g.fillStyle(metal, 1);
    g.fillRect(0.2, -4.35 + by, 1.1, 1.1); // strap buckle

    // re-pop the free fist over the drum's lower-left edge
    g.fillStyle(skin, 1);
    g.fillCircle(-7.3 + fistSway, 1.3 + by - fistPump, 1.3);
    g.fillStyle(shade(skin, 0.8), 1);
    g.fillRect(-7.9 + fistSway, 1.0 + by - fistPump, 1.2, 0.6); // knuckle line

    // ================== 8. medals (glint on the beat) ==================
    const ribbons = [0x8a3226, 0x2f4a68, 0x3f5a35];
    for (let m = 0; m < lvl; m++) {
        const mx = 0.9 + m * 0.95;
        const myy = -3.1 + by;
        g.fillStyle(ribbons[m], 1);
        g.fillRect(mx - 0.45, myy - 1.0, 0.9, 1.1);
        g.fillStyle(gold, 1);
        g.fillCircle(mx, myy + 0.6, 0.85);
    }
    if (glint > 0) { // small gold sparkle on the beat, alternating per strike
        const gi = beatHalf % lvl;
        const gx = 0.9 + gi * 0.95 - 0.25;
        const gy = -2.75 + by;
        g.fillStyle(0xffe9ad, 1);
        g.fillCircle(gx, gy, 0.5);
        g.lineStyle(0.55, 0xffdf8f, 1);
        g.lineBetween(gx - 0.8, gy, gx + 0.8, gy);
        g.lineBetween(gx, gy - 0.8, gx, gy + 0.8);
    }

    // ==================== 9. the grizzled head + cap ====================
    const hx = 0.5, hy = -7.6 + by + flash * 0.4; // nods into the hit
    g.fillStyle(skin, 1);
    g.fillRect(hx - 1.0, hy + 2.0, 2.0, 1.5); // neck
    g.fillCircle(hx, hy, 2.85);
    g.fillStyle(grey, 1); // full grey beard
    g.beginPath();
    g.arc(hx, hy + 0.55, 2.6, 0, Math.PI, false);
    g.closePath();
    g.fillPath();
    g.fillStyle(shade(grey, 0.82), 1);
    g.fillRect(hx - 0.5, hy + 1.1, 1.0, 0.5); // beard shadow under the lip
    g.fillStyle(grey, 1); // heavy asymmetric brows (the veteran squint)
    g.fillRect(hx - 2.1, hy - 1.7, 1.7, 0.8);
    g.fillRect(hx + 0.45, hy - 1.35, 1.7, 0.8);
    g.fillStyle(0x241812, 1);
    g.fillCircle(hx - 1.15, hy - 0.6, 0.5);
    g.fillCircle(hx + 1.15, hy - 0.45, 0.5);
    g.lineStyle(0.7, 0x9c6b52, 1); // old scar over the right brow
    g.lineBetween(hx + 1.5, hy - 2.3, hx + 2.0, hy - 0.6);
    // Worn forage cap: band + soft crown + short brim.
    g.fillStyle(coatD, 1);
    g.fillRect(hx - 2.9, hy - 3.1, 5.8, 1.6);
    g.fillStyle(coat, 1);
    g.fillEllipse(hx - 0.15, hy - 3.5, 5.4, 2.5);
    g.fillStyle(coatL, 1);
    g.fillEllipse(hx - 0.9, hy - 3.9, 2.3, 1.0);
    if (lvl >= 3) { // gold cap band — a thin accent line
        g.fillStyle(gold, 1);
        g.fillRect(hx - 2.9, hy - 2.15, 5.8, 0.6);
    }
    if (lvl >= 2) {
        g.fillStyle(metal, 1);
        g.fillCircle(hx, hy - 2.35, 0.55); // cap badge
    }
    g.fillStyle(shade(coatD, 0.8), 1); // brim
    g.fillEllipse(hx + 0.2, hy - 1.5, 4.6, 1.0);

    // ============== 10. stick arm — crosses over to strike ==============
    const e = ss(h);
    const c0x = Tx + 0.3, c0y = Ty - 0.5;            // contact point on the head
    const h0x = Tx + 3.6, h0y = Ty - 2.2;            // hand at contact
    const h1x = 4.3, h1y = -8.9 + by;                // hand raised
    const t1x = 7.2, t1y = -11.8 + by;               // tip raised (clears the flag)
    const hxp = h0x + (h1x - h0x) * e;
    const hyp = h0y + (h1y - h0y) * e;
    const txp = c0x + (t1x - c0x) * e;
    const typ = c0y + (t1y - c0y) * e;
    limb(g, coat, 2.6, -4.7 + by, hxp, hyp, 2.0);    // sleeve
    g.fillStyle(coatD, 1);
    g.fillCircle(hxp, hyp, 1.05);                     // cuff
    // Light ash stick — bright enough to read over the dark banner cloth.
    limb(g, 0x96774a, hxp, hyp, txp, typ, 1.3);
    g.fillStyle(lvl >= 3 ? gold : 0xa88a58, 1);
    g.fillCircle(txp, typ, 1.05);                     // stick bead
    g.fillStyle(skin, 1);
    g.fillCircle(hxp, hyp, 1.2);                      // fist over the grip
}
