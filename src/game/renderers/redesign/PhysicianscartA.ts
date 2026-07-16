import type Phaser from 'phaser';

type G = Phaser.GameObjects.Graphics;

/**
 * PHYSICIAN'S CART — tournament design A: "the apothecary barrow".
 *
 * The CART is the hero: a low-slung pale-green medicine chest (0x8fd98f)
 * hung between two tall cross-spoked wheels (the wheels stand taller than
 * the chest — that pairing IS the silhouette), a bowed herb-hoop arcing
 * over the lid with hanging bundles that sway, a rear rack of corked vials
 * poking above the lid line, and a red cross on a small cream panel painted
 * ON THE LID so the medic read survives every one of the 8 bake headings.
 * The plague doctor is the motor: wide-brim hat, pale beak mask, dark robe,
 * leaning into the twin handles behind the chest.
 *
 * TIMING CONTRACT (must stay in sync with bake-sprites.mjs TROOP_PARAMS):
 *  - walk stride: ONE exact 500 ms period (legs, cart bob, vial rattle,
 *    herb jolts are all sin(2π·k·ph) harmonics of it; the 4-spoke wheel
 *    pattern advances exactly one spoke pitch (π/2) per stride so the
 *    6-frame walk sheet loops seamlessly);
 *  - idle: ONE declared 2000 ms period (250 ms multiple) — beak-mask glance
 *    (tip swings ~2.6 world px), herb-bundle sway (~1.9 world px) and a
 *    small breath, all exact harmonics of 2000 ms;
 *  - heal pulse: attackDelay 6000 ms, windup 800 ms (mortar-and-pestle stir:
 *    the doctor reaches over the lid, the brew glows green, sparks orbit,
 *    vial glints chase), strike 400 ms (RELEASE: a green flask thrust
 *    overhead with an opaque ray burst + rising green crosses), then a
 *    500 ms recovery easing the arm back to the handle.
 *
 * All motion is deterministic f(time/attackAge); glow is painted as opaque
 * inner-light shapes (alpha-snap safe). Direction comes from facingAngle
 * trigonometrically (iso 0.5 y-squash); layering flips with the heading
 * (doctor behind ⇒ up-screen ⇒ drawn first; near wheel drawn after chest).
 * Levels: L1 humble pine + rope straps, L2 iron tyres/straps + brass, L3
 * gold hub caps, gold hat band, gold lens ring, gold hoop finial — accents
 * only, never masses.
 */

function clamp01(v: number): number {
    return v < 0 ? 0 : v > 1 ? 1 : v;
}

function easeOutA(t: number): number {
    return 1 - (1 - t) * (1 - t);
}

/** Multiply a 0xRRGGBB colour toward dark (m<1) or light (m>1). */
function shadeA(c: number, m: number): number {
    const r = Math.max(0, Math.min(255, Math.round(((c >> 16) & 0xff) * m)));
    const gg = Math.max(0, Math.min(255, Math.round(((c >> 8) & 0xff) * m)));
    const b = Math.max(0, Math.min(255, Math.round((c & 0xff) * m)));
    return (r << 16) | (gg << 8) | b;
}

/** Per-channel colour mix a→b by t (clamped). */
function mixA(a: number, b: number, t: number): number {
    const k = clamp01(t);
    const r = Math.round(((a >> 16) & 0xff) + (((b >> 16) & 0xff) - ((a >> 16) & 0xff)) * k);
    const gg = Math.round(((a >> 8) & 0xff) + (((b >> 8) & 0xff) - ((a >> 8) & 0xff)) * k);
    const bb = Math.round((a & 0xff) + ((b & 0xff) - (a & 0xff)) * k);
    return (r << 16) | (gg << 8) | bb;
}

/** Filled polygon from screen-space points. */
function polyA(g: G, pts: Array<[number, number]>, color: number, alpha: number = 1): void {
    g.fillStyle(color, alpha);
    g.beginPath();
    g.moveTo(pts[0][0], pts[0][1]);
    for (let i = 1; i < pts.length; i++) g.lineTo(pts[i][0], pts[i][1]);
    g.closePath();
    g.fillPath();
}

/** One limb segment drawn as a thick quad from (x0,y0) to (x1,y1). */
function limbA(g: G, color: number, x0: number, y0: number, x1: number, y1: number, w: number = 1.9): void {
    const dx = x1 - x0, dy = y1 - y0;
    const len = Math.hypot(dx, dy) || 1;
    const nx = (-dy / len) * (w / 2), ny = (dx / len) * (w / 2);
    polyA(g, [
        [x0 + nx, y0 + ny],
        [x1 + nx, y1 + ny],
        [x1 - nx, y1 - ny],
        [x0 - nx, y0 - ny]
    ], color);
}

/** Per-slot bake-param overrides (DesignRegistry.designBakeParams): stride/
 *  windup/strike match the TROOP_PARAMS row (500/800/400), but the idle loop
 *  closes on the declared 2000 ms period — not the default 4021 ms breath
 *  window. */
export const PARAMS: import('./DesignRegistry').DesignParamsExport = {
    physicianscart: { idleMs: 2000 },
};

export function drawPhysicianscartA(
    g: Phaser.GameObjects.Graphics,
    isPlayer: boolean,
    isMoving: boolean,
    facingAngle: number,
    troopLevel: number,
    time: number,
    attackAge: number,
    attackDelay: number,
    _driver: number
): void {
    const lvl = troopLevel >= 3 ? 3 : troopLevel >= 2 ? 2 : 1;
    const cosA = Math.cos(facingAngle);
    const sinA = Math.sin(facingAngle);
    const GY = 9.5; // shared humanoid ground line

    // World-axis helpers: d = along travel, w = across, h = up (iso 0.5 squash).
    const X = (d: number, w: number): number => cosA * d - sinA * w;
    const Y = (d: number, w: number, h: number): number => GY + (sinA * d + cosA * w) * 0.5 - h;

    // ---------------- clocks (iron rule: deterministic f(time)) ----------------
    const STRIDE = 500;  // ONE exact stride period
    const IDLE_P = 2000; // ONE declared idle period (250 ms multiple)
    const ph = (((time % STRIDE) + STRIDE) % STRIDE) / STRIDE;
    const gait = Math.sin(ph * Math.PI * 2);
    const hop = isMoving ? Math.abs(gait) : 0;
    const swing = isMoving ? gait * 2.3 : 0;
    const idT = (((time % IDLE_P) + IDLE_P) % IDLE_P) / IDLE_P;
    const br = Math.sin(idT * Math.PI * 2);

    // ------------- heal-pulse cycle (engine fires the burst on the tick) -------
    const D = attackDelay > 0 ? attackDelay : 6000;
    const WINDUP_MS = 800, STRIKE_MS = 400, RECOVER_MS = 500;
    let windup = 0, strike = 0, recover = 0;
    if (attackAge >= 0) {
        let age = attackAge;
        if (age > D + 600) age = ((time % D) + D) % D; // replay free-run
        const remaining = D - age;
        if (remaining <= 0) windup = 1;
        else if (remaining <= WINDUP_MS) windup = 1 - remaining / WINDUP_MS;
        if (age <= STRIKE_MS) strike = 1 - age / STRIKE_MS;
        else if (age <= STRIKE_MS + RECOVER_MS) recover = 1 - (age - STRIKE_MS) / RECOVER_MS;
    }

    // ---------------- palette (owner variants like the bespoke troops) ---------
    const chest = isPlayer ? 0x8fd98f : shadeA(0x8fd98f, 0.82);
    const robe = isPlayer ? 0x3e4554 : 0x4c3c2c;
    const robeDk = shadeA(robe, 0.7);
    const bone = isPlayer ? 0xf1e8d0 : 0xe0d3b2;
    const hatC = 0x2c2620;
    const wood = isPlayer ? 0x8a5a30 : 0x7c5330;
    const woodDk = shadeA(wood, 0.6);
    const iron = 0x4e545e;
    const gold = 0xdaa520;
    const cream = 0xe9e2cb;
    const red = isPlayer ? 0xc23428 : 0xa93227;
    const glove = 0x54422e;

    // ---------------- cart geometry --------------------------------------------
    const wheelR = 7.2;
    const axleH = wheelR;            // axle height = radius → rims kiss the ground
    const wheelW = 8.6;              // half-track (w offset of each wheel)
    const d0 = -9, d1 = 12, W2 = 6;  // chest bounds (along, across)
    const h0 = 4, h1 = 13;           // chest slung low between the wheels
    const bob = isMoving ? hop * 0.8 : Math.max(0, br) * 0.3;
    const C = (d: number, w: number, h: number): [number, number] => [X(d, w), Y(d, w, h + bob)];

    // NW light: brightness of a face from its screen-space outward normal.
    const faceB = (nx: number, ny: number): number => {
        const len = Math.hypot(nx, ny) || 1;
        // floor keeps SE-facing walls readable green, never near-black
        return Math.max(0.7, 0.82 + 0.26 * ((-nx - ny) / (len * 1.4142)));
    };

    // ---------------- doctor rig anchors ---------------------------------------
    const dD = -14.4; // doctor stands behind the barrow, hands on the shafts
    const lean = isMoving ? 2.2 + gait * 0.25 : (windup > 0 ? 1.6 : 0.7 + Math.max(0, br) * 0.3);
    const hopD = isMoving ? hop * 1.1 : Math.max(0, br) * 0.4;
    const plen = Math.hypot(sinA, cosA * 0.5) || 1;
    const pX = -sinA / plen, pY = (cosA * 0.5) / plen; // unit across-travel (screen)

    // ============================ ground shadows ================================
    g.fillStyle(0x000000, 0.26);
    g.fillEllipse(X(0.5, 0), Y(0.5, 0, 0) + 0.4, 26 + Math.abs(cosA) * 8, 10 + Math.abs(sinA) * 4);
    g.fillStyle(0x000000, 0.16);
    g.fillEllipse(X(dD + 0.6, 0), Y(dD + 0.6, 0, 0) + 0.3, 8.5, 3.2);

    // ============================ wheel painter =================================
    const nearSide: 1 | -1 = cosA >= 0 ? 1 : -1;
    // Wheels keep a minimum projected width so front/back headings show a
    // believable wheel instead of a 1px sliver with a floating hub.
    const fc = (cosA >= 0 ? 1 : -1) * Math.max(Math.abs(cosA), 0.32);
    const wheel = (side: 1 | -1): void => {
        const w = wheelW * side;
        const dim = side === nearSide ? 1 : 0.74;
        const WX = (rc: number): number => fc * rc - sinA * w;
        const WY = (rc: number, h: number): number => GY + (sinA * rc + cosA * w) * 0.5 - h;
        const ring = (r: number): Array<[number, number]> => {
            const pts: Array<[number, number]> = [];
            for (let k = 0; k < 16; k++) {
                const th = (k / 16) * Math.PI * 2;
                pts.push([WX(r * Math.cos(th)), WY(r * Math.cos(th), axleH + r * Math.sin(th))]);
            }
            return pts;
        };
        // tyre (L1 dark wood, L2+ iron), then the wooden wheel body
        polyA(g, ring(wheelR), shadeA(lvl >= 2 ? iron : woodDk, dim));
        const rIn = wheelR - 1.6;
        polyA(g, ring(rIn), shadeA(wood, dim));
        // 4 spokes as two rotating diameters — pattern period π/2, advanced
        // exactly one pitch per stride so the walk loop closes.
        const spokeA = isMoving ? -ph * (Math.PI / 2) : 0;
        g.lineStyle(1.5, shadeA(woodDk, dim), 1);
        for (let k = 0; k < 2; k++) {
            const th = spokeA + k * (Math.PI / 2);
            const rc = (rIn - 0.4) * Math.cos(th), rs = (rIn - 0.4) * Math.sin(th);
            g.lineBetween(
                WX(rc), WY(rc, axleH + rs),
                WX(-rc), WY(-rc, axleH - rs)
            );
        }
        // hub (wood → iron → gold cap, the level ladder in one dot)
        g.fillStyle(lvl >= 3 ? gold : shadeA(lvl >= 2 ? 0x6a6f78 : woodDk, dim), 1);
        g.fillCircle(X(0, w), Y(0, w, axleH), 1.7);
    };

    // ============================ the doctor ====================================
    const doctor = (): void => {
        // feet flicking under the robe hem
        g.fillStyle(0x241d16, 1);
        g.fillEllipse(X(dD + 1.2 + swing, 1.7), Y(dD + 1.2 + swing, 1.7, 0) - 0.4, 3, 1.6);
        g.fillEllipse(X(dD + 1.2 - swing, -1.7), Y(dD + 1.2 - swing, -1.7, 0) - 0.4, 3, 1.6);

        // long robe skirt, leaning into the push
        const wx = X(dD + lean * 0.55, 0), wy = Y(dD + lean * 0.55, 0, 7.6 + hopD);
        const hx0 = X(dD + 0.4, 0), hy0 = Y(dD + 0.4, 0, 0.8);
        const hw = 4.3 + hop * 0.5, ww = 2.7;
        polyA(g, [
            [wx - pX * ww, wy - pY * ww],
            [wx + pX * ww, wy + pY * ww],
            [hx0 + pX * hw, hy0 + pY * hw],
            [hx0 - pX * hw, hy0 - pY * hw]
        ], robe);
        polyA(g, [ // hem band
            [hx0 + pX * hw, hy0 + pY * hw],
            [hx0 - pX * hw, hy0 - pY * hw],
            [hx0 - pX * (hw - 0.4), hy0 - pY * (hw - 0.4) + 1.3],
            [hx0 + pX * (hw - 0.4), hy0 + pY * (hw - 0.4) + 1.3]
        ], robeDk);

        // torso + shoulder mantle
        const tx = X(dD + lean * 0.8, 0), ty = Y(dD + lean * 0.8, 0, 10.6 + hopD);
        g.fillStyle(robe, 1);
        g.fillCircle(tx, ty, 3.5);
        g.fillStyle(robeDk, 1);
        g.beginPath();
        g.arc(tx, ty - 0.6, 3.5, Math.PI, 0, false);
        g.closePath();
        g.fillPath();
        // satchel strap + hip satchel
        g.lineStyle(1.1, 0x7a5c34, 1);
        g.lineBetween(tx - pX * 2.4, ty - pY * 2.4 - 1.2, tx + pX * 2.2, ty + pY * 2.2 + 2.2);
        g.fillStyle(0x6d4e2c, 1);
        g.fillRect(tx + pX * 3 - 1.4, ty + pY * 3 + 1.6, 2.8, 2.4);
        if (lvl >= 2) {
            g.fillStyle(0xb08d46, 1); // brass clasp
            g.fillCircle(tx + pX * 3, ty + pY * 3 + 2.7, 0.8);
        }
        if (lvl >= 3) {
            g.fillStyle(gold, 1); // collar clasp
            g.fillCircle(tx, ty - 2.7, 0.9);
        }

        // left arm to the left shaft grip
        const gripL = C(-12.4, -4.6, 7.3);
        limbA(g, robe, tx - pX * 2.9, ty - pY * 2.9, gripL[0], gripL[1], 2.0);
        g.fillStyle(glove, 1);
        g.fillCircle(gripL[0], gripL[1], 1.25);

        // head: beak mask + wide-brim hat.
        const hd = dD + lean * 1.05;
        const hxc = X(hd, 0), hyc = Y(hd, 0, 15.4 + hopD);
        // beak-mask glance: idle scans on the exact 2000 ms period
        let gl = 0, droop = 0.8;
        if (strike > 0 || recover > 0) {
            droop = -1.4; // beak up, watching the raised flask
        } else if (windup > 0) {
            droop = 1.6;  // beak down toward the mortar
        } else if (isMoving) {
            gl = Math.sin(ph * Math.PI * 2) * 0.14;
        } else {
            gl = Math.sin(idT * Math.PI * 2) * 0.62;
            droop = 0.7;
        }
        const tipX = X(hd + 5.6 * Math.cos(gl), 5.6 * Math.sin(gl));
        const tipY = Y(hd + 5.6 * Math.cos(gl), 5.6 * Math.sin(gl), 15.4 + hopD - droop);
        const bdx = tipX - hxc, bdy = tipY - hyc;
        const bl = Math.hypot(bdx, bdy) || 1;
        const bnx = -bdy / bl, bny = bdx / bl;
        g.fillStyle(bone, 1);
        g.fillCircle(hxc, hyc, 2.85);
        polyA(g, [
            [hxc + bnx * 1.15, hyc + bny * 1.15],
            [tipX, tipY],
            [hxc - bnx * 1.15, hyc - bny * 1.15]
        ], shadeA(bone, 0.9));
        g.fillStyle(shadeA(bone, 0.62), 1);
        g.fillCircle(hxc + bdx * 0.55, hyc + bdy * 0.55, 0.6); // nostril vent
        if (lvl >= 3) {
            g.fillStyle(gold, 1); // gold lens ring
            g.fillCircle(hxc + bdx * 0.18, hyc + bdy * 0.18 - 1.0, 1.3);
        }
        g.fillStyle(0x1d232b, 1); // glass lens
        g.fillCircle(hxc + bdx * 0.18, hyc + bdy * 0.18 - 1.0, 0.9);
        // hat: brim over the mask, crown above
        g.fillStyle(hatC, 1);
        g.fillEllipse(hxc + bdx * 0.06, hyc - 1.9, 9.4, 3.0);
        g.fillEllipse(hxc, hyc - 3.4, 4.8, 3.4);
        if (lvl >= 2) {
            g.fillStyle(lvl >= 3 ? gold : 0x6b4a28, 1); // hat band
            g.fillRect(hxc - 2.3, hyc - 3.2, 4.6, 1.0);
        }
        g.fillStyle(shadeA(hatC, 1.55), 1);
        g.fillEllipse(hxc - 0.9, hyc - 4.5, 2.6, 1.0); // crown sheen
    };

    // ============================ the cart body =================================
    const cart = (): void => {
        // visible end face (front when heading down-screen, else back)
        const sgnE: 1 | -1 = sinA >= 0 ? 1 : -1;
        const de = sgnE > 0 ? d1 : d0;
        const endBr = faceB(cosA * sgnE, sinA * 0.5 * sgnE);
        polyA(g, [C(de, -W2, h0), C(de, W2, h0), C(de, W2, h1), C(de, -W2, h1)], shadeA(chest, endBr));
        // small red cross painted on the end face too (front/back read)
        {
            // the cross is a painted signal — keep it bright at any shading
            const cw = 1.1, cl = 2.6, ch = (h0 + h1) / 2 + 0.4;
            const crossC = shadeA(red, Math.max(0.9, endBr));
            polyA(g, [C(de, -cl, ch - cw), C(de, cl, ch - cw), C(de, cl, ch + cw), C(de, -cl, ch + cw)], crossC);
            polyA(g, [C(de, -cw, ch - cl), C(de, cw, ch - cl), C(de, cw, ch + cl), C(de, -cw, ch + cl)], crossC);
        }

        // visible side face
        const sgnS: 1 | -1 = cosA >= 0 ? 1 : -1;
        const ws = W2 * sgnS;
        const sideBr = faceB(-sinA * sgnS, cosA * 0.5 * sgnS);
        polyA(g, [C(d0, ws, h0), C(d1, ws, h0), C(d1, ws, h1), C(d0, ws, h1)], shadeA(chest, sideBr));
        // plank seams
        g.lineStyle(1, shadeA(chest, sideBr * 0.76), 1);
        const s1 = C(d0 + 0.8, ws, 7), s2 = C(d1 - 0.8, ws, 7);
        g.lineBetween(s1[0], s1[1], s2[0], s2[1]);
        const s3 = C(d0 + 0.8, ws, 10), s4 = C(d1 - 0.8, ws, 10);
        g.lineBetween(s3[0], s3[1], s4[0], s4[1]);
        // straps on the side face (rope at L1, riveted iron at L2+)
        const strapC = lvl >= 2 ? iron : 0x9a8a5e;
        for (const ds of [-5, 8]) {
            polyA(g, [C(ds - 0.9, ws, h0), C(ds + 0.9, ws, h0), C(ds + 0.9, ws, h1), C(ds - 0.9, ws, h1)], shadeA(strapC, sideBr));
            if (lvl >= 2) {
                g.fillStyle(shadeA(0x8a919c, sideBr), 1);
                const r1 = C(ds, ws, h0 + 1.6), r2 = C(ds, ws, h1 - 1.6);
                g.fillCircle(r1[0], r1[1], 0.8);
                g.fillCircle(r2[0], r2[1], 0.8);
            }
        }

        // lid (top face, slight overhang) + straps wrapping over it
        polyA(g, [C(d0 - 0.7, -W2 - 0.7, h1), C(d1 + 0.7, -W2 - 0.7, h1), C(d1 + 0.7, W2 + 0.7, h1), C(d0 - 0.7, W2 + 0.7, h1)], shadeA(chest, 1.14));
        for (const ds of [-5, 8]) {
            polyA(g, [C(ds - 0.9, -W2 - 0.7, h1), C(ds + 0.9, -W2 - 0.7, h1), C(ds + 0.9, W2 + 0.7, h1), C(ds - 0.9, W2 + 0.7, h1)], shadeA(strapC, 1.05));
        }
        if (lvl >= 3) {
            // gold lid trim — two edge lines, an accent not a mass
            g.lineStyle(1.1, gold, 1);
            const e1 = C(d0 - 0.7, -W2 - 0.7, h1), e2 = C(d1 + 0.7, -W2 - 0.7, h1);
            const e3 = C(d1 + 0.7, W2 + 0.7, h1), e4 = C(d0 - 0.7, W2 + 0.7, h1);
            g.lineBetween(e1[0], e1[1], e2[0], e2[1]);
            g.lineBetween(e4[0], e4[1], e3[0], e3[1]);
        }

        // THE red-cross panel on the lid front half — reads at all headings
        const cd = 3.9;
        polyA(g, [C(cd - 4.2, -3.8, h1), C(cd + 4.2, -3.8, h1), C(cd + 4.2, 3.8, h1), C(cd - 4.2, 3.8, h1)], cream);
        polyA(g, [C(cd - 3.3, -1.25, h1), C(cd + 3.3, -1.25, h1), C(cd + 3.3, 1.25, h1), C(cd - 3.3, 1.25, h1)], red);
        polyA(g, [C(cd - 1.25, -3.4, h1), C(cd + 1.25, -3.4, h1), C(cd + 1.25, 3.4, h1), C(cd - 1.25, 3.4, h1)], red);

        // corked vials on a bench along the LID's front edge — beyond the
        // wheel arc (d > 7.2), so they read at profile headings as a bottle
        // row on the cart's nose and spread across the lid when heading up/
        // down-screen. Rattle = 2× stride harmonic.
        const nV = lvl === 1 ? 3 : lvl === 2 ? 4 : 5;
        const glass = [0xa9dba4, 0xcf9d43, 0x86aecd, 0xbfe3c2, 0x98c4e0];
        const vD = 10.2;
        for (let i = 0; i < nV; i++) {
            const wv = -4.6 + (9.2 * i) / (nV - 1);
            const rat = isMoving ? Math.sin(ph * Math.PI * 4 + i * 1.9) * 0.55 : 0;
            const [vx, vy] = C(vD, wv, h1 + 0.2);
            const gc = glass[i % 5];
            g.fillStyle(gc, 1);
            g.fillRect(vx - 1.05, vy - 3.5 - rat, 2.1, 3.6);
            g.fillStyle(shadeA(gc, 1.4), 1);
            g.fillRect(vx - 1.05, vy - 3.5 - rat, 0.8, 3.6);
            g.fillStyle(0xc9a36a, 1);
            g.fillRect(vx - 0.7, vy - 4.6 - rat, 1.4, 1.1); // cork
        }
        if (windup > 0.35) {
            // glint chase across the vials while the brew builds
            const gi = Math.floor(windup * 5) % nV;
            const [gx, gy] = C(vD, -4.6 + (9.2 * gi) / (nV - 1), h1 + 6.2);
            g.fillStyle(0xd9ffd2, 1);
            g.fillCircle(gx, gy, 0.9);
        }

        // mortar & pestle bowl on the lid rear (the windup prop)
        const [mx, my] = C(-3.8, 0.4, h1 + 1.1);
        g.fillStyle(0x716c64, 1);
        g.fillEllipse(mx, my, 6.6, 3.6);
        g.fillStyle(0x57534c, 1);
        g.fillEllipse(mx, my - 0.5, 4.8, 2.3);
        g.fillStyle(mixA(0x4a463f, 0x7dff96, windup), 1); // the brew glows as the stir builds
        g.fillEllipse(mx, my - 0.4, 4.0, 2.0);
        if (windup > 0.15) {
            const sA = windup * Math.PI * 4; // two stirred orbits across the windup
            g.fillStyle(0xd9ffd2, 1);
            g.fillCircle(mx + Math.cos(sA) * 3.2, my - 0.7 + Math.sin(sA) * 1.5, 0.9);
            g.fillCircle(mx - Math.cos(sA) * 3.2, my - 0.7 - Math.sin(sA) * 1.5, 0.75);
        }

        // herb hoop bowing over the lid rear (framing the mortar) + two
        // bundles hanging at its shoulders — clear of the lid contents and
        // of the doctor's head at every heading.
        const dH = -0.8;
        g.lineStyle(1.6, shadeA(wood, 0.85), 1);
        g.beginPath();
        for (let k = 0; k <= 8; k++) {
            const t = k / 8;
            const [hx, hy] = C(dH, -7.4 + 14.8 * t, h1 + Math.sin(t * Math.PI) * 6.8);
            if (k === 0) g.moveTo(hx, hy);
            else g.lineTo(hx, hy);
        }
        g.strokePath();
        if (lvl >= 3) {
            const [fx, fy] = C(dH, 0, h1 + 7.9);
            g.fillStyle(gold, 1);
            g.fillCircle(fx, fy, 1.1); // hoop finial
        }
        const herbs: Array<[number, number, number, number]> = [
            [0.26, 3.0, 0x74994e, 0],
            [0.74, 3.4, lvl >= 2 ? 0x8a7ab0 : 0x74994e, 2.4]
        ];
        for (const [t, drop, hc, phs] of herbs) {
            const hwv = -7.4 + 14.8 * t;
            const hh = h1 + Math.sin(t * Math.PI) * 6.8;
            const sway = isMoving
                ? Math.sin(ph * Math.PI * 2 + phs) * 2.0   // stride harmonic jolt
                : Math.sin(idT * Math.PI * 2 + phs) * 1.9; // idle-period breeze (≥1.5 wpx)
            const [ax0, ay0] = C(dH, hwv, hh);
            const [bx1, by1] = C(dH + sway, hwv, hh - drop);
            g.lineStyle(0.9, 0x4c3b22, 1);
            g.lineBetween(ax0, ay0, bx1, by1);
            g.fillStyle(hc, 1);
            g.fillCircle(bx1, by1 + 0.4, 1.8);
            g.fillStyle(shadeA(hc, 0.72), 1);
            g.fillCircle(bx1 + sway * 0.12, by1 + 1.8, 1.35);
            g.fillStyle(shadeA(hc, 0.55), 1);
            g.fillTriangle(bx1 - 0.9, by1 + 2.6, bx1 + 0.9, by1 + 2.6, bx1 + sway * 0.2, by1 + 4.2);
        }

        // twin shafts back to the doctor's hands
        g.lineStyle(1.7, woodDk, 1);
        for (const s of [-1, 1]) {
            const [sx0, sy0] = C(d0 + 0.5, 4.9 * s, 5.4);
            const [sx1, sy1] = C(-13.2, 4.3 * s, 7.6);
            g.lineBetween(sx0, sy0, sx1, sy1);
        }
    };

    // ================= action layer: right arm + heal props ====================
    // Drawn LAST so the stir over the lid and the flask lift never sink into
    // the chest, whichever side the doctor's body layer landed on.
    const action = (): void => {
        const tx = X(dD + lean * 0.8, 0), ty = Y(dD + lean * 0.8, 0, 10.6 + hopD);
        const shX = tx + pX * 2.9, shY = ty + pY * 2.9;
        const gripR = C(-12.4, 4.6, 7.3);
        let hx = gripR[0], hy = gripR[1];
        let flask = 0;
        const raised: [number, number] = [
            X(dD + lean * 0.8 + 2.6, 1.6),
            Y(dD + lean * 0.8 + 2.6, 1.6, 21.6 + hopD + strike * 0.8)
        ];
        if (strike > 0) {
            hx = raised[0];
            hy = raised[1];
            flask = 1;
        } else if (recover > 0) {
            const t = easeOutA(1 - recover);
            hx = raised[0] + (gripR[0] - raised[0]) * t;
            hy = raised[1] + (gripR[1] - raised[1]) * t;
            flask = recover;
        } else if (windup > 0) {
            const sA = windup * Math.PI * 4;
            const [mx, my] = C(-3.8, 0.4, h1 + 1.1);
            hx = mx + Math.cos(sA) * 2.4;
            hy = my - 3.8 + Math.sin(sA) * 1.1;
            // pestle from the circling hand down into the bowl
            g.lineStyle(1.7, 0xd8c8a2, 1);
            g.lineBetween(hx, hy, mx + (hx - mx) * 0.12, my - 0.5);
        }
        limbA(g, robe, shX, shY, hx, hy, 2.0);
        g.fillStyle(glove, 1);
        g.fillCircle(hx, hy, 1.25);
        if (flask > 0) {
            // the green flask, thrust overhead at the release
            const fy = hy - 2.6;
            g.fillStyle(0xc9a36a, 1);
            g.fillRect(hx - 0.7, fy - 4.1, 1.4, 1.3);   // cork
            g.fillStyle(0x86e88a, 1);
            g.fillRect(hx - 0.55, fy - 3.0, 1.1, 1.4);  // neck
            g.fillCircle(hx, fy, 2.0);                  // bulb
            g.fillStyle(0xd6ffd4, 1);
            g.fillCircle(hx - 0.6, fy - 0.6, 0.8);
            if (strike > 0) {
                // opaque ray burst — inner light, no translucency
                g.lineStyle(1.4, 0xbfffc4, 1);
                for (let k = 0; k < 8; k++) {
                    const a = (k / 8) * Math.PI * 2 + 0.39;
                    const r0 = 3.2 + (1 - strike) * 2.4;
                    const r1 = r0 + 1.6 + strike * 4.6;
                    g.lineBetween(
                        hx + Math.cos(a) * r0, fy + Math.sin(a) * r0 * 0.8,
                        hx + Math.cos(a) * r1, fy + Math.sin(a) * r1 * 0.8
                    );
                }
                // little green crosses rising over the cart
                g.fillStyle(0x9ff2a0, 1);
                const crosses: Array<[number, number, number]> = [[1.5, -3.2, 0], [3.5, 2.6, 0.35]];
                for (const [cdx, cwx, p] of crosses) {
                    const rise = (1 - strike) * 6 + p * 3;
                    const sz = 1.1 + strike * 1.1;
                    const [cx, cy] = C(cdx, cwx, h1 + 5 + rise);
                    g.fillRect(cx - sz, cy - sz * 0.36, sz * 2, sz * 0.72);
                    g.fillRect(cx - sz * 0.36, cy - sz, sz * 0.72, sz * 2);
                }
            }
        }
    };

    // ============================ assembly (painter order) =====================
    wheel(-nearSide as 1 | -1);   // far wheel
    const doctorUp = sinA > 0;    // heading down-screen ⇒ doctor is up-screen
    if (doctorUp) doctor();
    cart();
    wheel(nearSide);              // near wheel
    if (!doctorUp) doctor();
    action();
}
