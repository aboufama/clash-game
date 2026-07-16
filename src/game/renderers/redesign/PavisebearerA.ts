import type Phaser from 'phaser';

type G = Phaser.GameObjects.Graphics;

/**
 * PAVISE BEARER — design A: "The Walking Wall".
 *
 * A hulking porter almost fully hidden behind a body-length painted pavise:
 * slate-blue field (0x2e6e8e) bearing a white double chevron, iron rim,
 * central boss, kite-point base. Steel helmet dome and gauntlet knuckles
 * peek over/around the rim; broad boots trudge below. The design consumes
 * `facingAngle` (8 baked dirs) with three view regimes:
 *   - FACE  (sin fa >=  0.35): the painted shield toward the viewer, bearer
 *     hidden except dome / knuckles / boots.
 *   - BACK  (sin fa <= -0.35): the bearer's broad back over the shield's
 *     planked rear (battens + strap).
 *   - SIDE  (otherwise): edge-on slab + the porter in profile leaning in.
 *
 * MOTION (all deterministic in `time` — iron rule 3):
 *   - walk   : shield-first trudge, STRIDE = 500 ms exact (time % 500).
 *   - idle   : ONE declared period IDLE_P = 2000 ms (250 ms multiple).
 *     Terms: weight-shift sway (harmonic 1, ±0.9 px), breath (harmonic 2),
 *     and a shield hitch-and-settle "thunk" (piecewise on the same period,
 *     1.7 px displacement of the whole shield — quantization-visible).
 *   - attack : attackDelay 1300; short mace jab AROUND the +across shield
 *     edge — windup 340 ms cocks the head at the rim, the jab peaks exactly
 *     on the damage tick and decays over 170 ms. The shield NEVER leaves
 *     guard (only a 0.7 px brace push on the strike).
 *
 * Levels: L1 humble (wood rim, dull boss) -> L2 iron (steel rim, studs) ->
 * L3 refined (gold pinline, gilt boss ring, finial, point chape — warm
 * sandstone chevrons; accents only, never masses). Enemy palette is the
 * darker red-shifted precedent (wine-slate field, dirtied linen chevrons).
 * Redirected-shot sparks are engine FX — the face stays clean: rim,
 * two chevrons, one boss, nothing else.
 */

const easeOut = (t: number): number => 1 - (1 - t) * (1 - t);
const easeIn = (t: number): number => t * t;

/** Multiply a 0xRRGGBB colour toward dark (m<1) or light (m>1). */
function shade(c: number, m: number): number {
    const r = Math.max(0, Math.min(255, Math.round(((c >> 16) & 0xff) * m)));
    const g = Math.max(0, Math.min(255, Math.round(((c >> 8) & 0xff) * m)));
    const b = Math.max(0, Math.min(255, Math.round((c & 0xff) * m)));
    return (r << 16) | (g << 8) | b;
}

/** One closed filled polygon (uniform alpha — never stacked sub-shapes). */
function poly(g: G, pts: ReadonlyArray<readonly [number, number]>, color: number, alpha = 1): void {
    g.fillStyle(color, alpha);
    g.beginPath();
    g.moveTo(pts[0][0], pts[0][1]);
    for (let i = 1; i < pts.length; i++) g.lineTo(pts[i][0], pts[i][1]);
    g.closePath();
    g.fillPath();
}

/** Thick limb quad from (x0,y0) to (x1,y1) — the TroopRenderer grammar. */
function limb(g: G, color: number, x0: number, y0: number, x1: number, y1: number, w = 1.9): void {
    const dx = x1 - x0, dy = y1 - y0;
    const len = Math.hypot(dx, dy) || 1;
    const nx = (-dy / len) * (w / 2), ny = (dx / len) * (w / 2);
    poly(g, [[x0 + nx, y0 + ny], [x1 + nx, y1 + ny], [x1 - nx, y1 - ny], [x0 - nx, y0 - ny]], color);
}

const STRIDE = 500;   // ms — exact walk period (TROOP_PARAMS stride)
const IDLE_P = 2000;  // ms — the ONE declared idle period (250 ms multiple)
const WINDUP = 340;   // ms of mace cock before the damage tick
const STRIKE = 170;   // ms of jab decay after the tick

/** Per-slot bake-param overrides (DesignRegistry.designBakeParams): authored
 *  periods that differ from the TROOP_PARAMS row (1200/350/180, no idleMs).
 *  delay 1300 = the runtime TroopDefinitions attackDelay; windup/strike per
 *  WINDUP/STRIKE (340/170); idle closes on IDLE_P = 2000. stride 500 matches
 *  the table. */
export const PARAMS: import('./DesignRegistry').DesignParamsExport = {
    pavisebearer: { delay: 1300, windup: 340, strike: 170, idleMs: 2000 },
};

export function drawPavisebearerA(
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
    const lvl = troopLevel >= 3 ? 3 : troopLevel >= 2 ? 2 : 1;
    const fa = facingAngle || 0;
    const c = Math.cos(fa), s = Math.sin(fa);
    // Screen-space iso basis (vertical squash 0.5): along-facing + across.
    const fx = c, fy = s * 0.5;
    const ux = -s, uy = c * 0.5;
    const ulen = Math.hypot(ux, uy) || 1;
    const nux = ux / ulen, nuy = uy / ulen; // normalized lateral (body spread)

    // ---------------- palette ----------------
    const eM = isPlayer ? 1 : 0.85; // enemy metals sit a touch duller
    const steelDk = shade(0x565b64, eM);
    const steelMd = shade(0x8a8f99, eM);
    const steelLt = shade(0xbfc5cf, eM);
    const gold = isPlayer ? 0xdaa520 : 0xb8860b;
    const field = isPlayer ? 0x2e6e8e : 0x74323c;   // slate blue | wine slate
    const fieldDk = isPlayer ? 0x224f66 : 0x561f29;
    const chev = lvl >= 3
        ? (isPlayer ? 0xd9cfb4 : 0xc4b49a)           // warm sandstone at max
        : (isPlayer ? 0xe8e3d4 : 0xcfc4ad);          // linen white below
    const rimWood = isPlayer ? 0x6a4520 : 0x54371c;
    const rimWoodLt = isPlayer ? 0x8a5c30 : 0x6e4a26;
    const woodBack = isPlayer ? 0x7a5a34 : 0x64462a;
    const woodDk = isPlayer ? 0x4a3018 : 0x3c2714;
    const leather = isPlayer ? 0x5d4037 : 0x4c342c;
    const cloth = isPlayer ? 0x46545f : 0x553a40;    // quilted gambeson
    const clothDk = shade(cloth, 0.68);
    const boot = 0x241c15;
    const rim = lvl >= 2 ? steelDk : rimWood;
    const rimLt = lvl >= 2 ? steelMd : rimWoodLt;
    const gauntlet = lvl >= 2 ? steelMd : leather;

    // ---------------- attack cycle (locked to the damage tick) ----------------
    const D = attackDelay > 0 ? attackDelay : 1300;
    const inCombat = attackAge >= 0 && !isMoving;
    let windup = 0, strike = 0;
    if (inCombat) {
        let age = attackAge;
        if (age > D + 600) age = ((time % D) + D) % D; // replay free-run
        const rem = D - age;
        windup = rem <= 0 ? 1 : rem <= WINDUP ? 1 - rem / WINDUP : 0;
        strike = age <= STRIKE ? 1 - age / STRIKE : 0;
    }

    // ---------------- gait / idle rig ----------------
    let swing = 0, lift = 0, shieldRaise = 0, sway = 0, plant = 0, breathe = 0;
    if (isMoving) {
        const ph = (((time % STRIDE) + STRIDE) % STRIDE) / STRIDE;
        const sn = Math.sin(ph * Math.PI * 2);
        swing = sn * 2.1;                                        // leg alternation
        lift = Math.abs(sn) * 1.0;                               // heavy hop
        plant = Math.max(0, Math.sin(ph * Math.PI * 2 + 0.9));   // shield eases fwd on the plant beat
        shieldRaise = Math.abs(Math.sin(ph * Math.PI * 2 + 0.7)) * 0.8; // lagged trudge bob
    } else {
        // ONE 2000 ms loop; every term an exact harmonic / piecewise of it.
        const u01 = (((time % IDLE_P) + IDLE_P) % IDLE_P) / IDLE_P;
        sway = Math.sin(u01 * Math.PI * 2) * 0.9;                // weight shift
        breathe = (Math.sin(u01 * Math.PI * 4) + 1) * 0.22;      // harmonic 2
        // Shield settle "thunk": hitch up 1.7 px, drop hard, tiny rebound.
        if (u01 > 0.60 && u01 <= 0.72) shieldRaise = easeOut((u01 - 0.60) / 0.12) * 1.7;
        else if (u01 > 0.72 && u01 <= 0.78) shieldRaise = 1.7 * (1 - easeIn((u01 - 0.72) / 0.06));
        else if (u01 > 0.78 && u01 <= 0.86) shieldRaise = Math.sin(((u01 - 0.78) / 0.08) * Math.PI) * 0.35;
    }

    const lean = isMoving ? 1.5 : 0.6; // body tucked in behind the pavise
    const bodyOx = sway + fx * lean * 0.6;
    const bodyOy = fy * lean * 0.6;

    // Shield anchor — planted slightly AHEAD along facing; braces on strike.
    const dA = 5.2 + plant + strike * 0.7;
    const shX = fx * dA + sway * 0.35;
    const shY = fy * dA - shieldRaise;

    // Shield extents (local: w along across, h vertical). The kite point
    // hovers ~2.5 px above its local ground line — carried, not dragged —
    // so the boots stay readable below the taper (the brief's silhouette).
    const HW = 7.0, TOP = -12.2, BOT = 2.6, PT = 6.8;
    const fp = (w: number, h: number): [number, number] => [shX + ux * w, shY + uy * w + h];

    // ---------------- contact shadow (one shape, no plates) ----------------
    g.fillStyle(0x000000, 0.22);
    g.fillEllipse(fx * 2.4, 9.7 + fy * 2.4, 15, 5.2);

    const front = s >= 0.35;
    const backV = s <= -0.35;
    // The mace works the LEADING edge (the rim on the side the facing's
    // screen-x points toward) so the jab clears the painted face instead of
    // sweeping across it; the grip knuckles curl around the trailing edge.
    const maceSide = Math.sign(fx * ux) || -1;

    // ================= shared body pieces =================
    const drawLegs = (): void => {
        // Trouser columns + broad boots, feet alternating ALONG the facing.
        const f1x = fx * swing, f1y = fy * swing;
        for (const [sgn, ox, oy] of [[-1, -f1x, -f1y], [1, f1x, f1y]] as Array<[number, number, number]>) {
            // Raw across vector — lateral spread foreshortens with the view.
            const bx = bodyOx * 0.5 + ux * 2.55 * sgn + ox;
            const by = uy * 2.55 * sgn + oy;
            g.fillStyle(clothDk, 1);
            g.fillRect(bx - 1.15, 3.4 - lift + by, 2.3, 5.4 + lift);
            g.fillStyle(boot, 1);
            g.fillEllipse(bx, 9.1 + by, 3.7, 2.0);
            g.fillStyle(shade(boot, 1.5), 1);
            g.fillEllipse(bx - 0.6 + fx * 0.8, 8.6 + by, 1.7, 0.9); // toe light
        }
    };

    const drawTorsoBack = (): void => {
        // Broad quilted back + steel backplate, belt, pauldrons, helm dome.
        g.fillStyle(cloth, 1);
        g.fillCircle(bodyOx, -1.8 - breathe + bodyOy, 5.0);
        g.fillStyle(steelDk, 1);
        g.beginPath();
        g.arc(bodyOx, -3.0 - breathe + bodyOy, 4.3, Math.PI, 0, false);
        g.closePath();
        g.fillPath();
        g.fillStyle(steelMd, 1);
        g.beginPath();
        g.arc(bodyOx - 0.7, -3.4 - breathe + bodyOy, 3.2, Math.PI, 0, false);
        g.closePath();
        g.fillPath();
        g.fillStyle(leather, 1);
        g.fillRect(bodyOx - 4.6, 1.4 - breathe + bodyOy, 9.2, 1.7); // belt
        if (lvl >= 3) {
            g.fillStyle(gold, 1);
            g.fillRect(bodyOx - 0.9, 1.5 - breathe + bodyOy, 1.8, 1.5); // buckle
        }
        // Pauldrons (raw across vector — foreshortens with the view)
        g.fillStyle(lvl >= 2 ? steelMd : leather, 1);
        g.fillCircle(bodyOx - ux * 4.5, -4.4 - breathe + bodyOy - uy * 4.5, 2.1);
        g.fillCircle(bodyOx + ux * 4.5, -4.4 - breathe + bodyOy + uy * 4.5, 2.1);
        // Helmet from behind: full dome + neck guard.
        const hy = -9.4 - breathe + bodyOy;
        g.fillStyle(steelMd, 1);
        g.fillCircle(bodyOx, hy, 3.1);
        g.fillStyle(steelLt, 1);
        g.beginPath();
        g.arc(bodyOx - 0.8, hy - 0.8, 2.1, Math.PI * 0.9, Math.PI * 1.9, false);
        g.closePath();
        g.fillPath();
        g.fillStyle(steelDk, 1);
        g.fillRect(bodyOx - 2.6, hy + 1.6, 5.2, 1.3); // neck guard
        if (lvl >= 3) {
            g.fillStyle(gold, 1);
            g.fillRect(bodyOx - 2.4, hy + 0.6, 4.8, 0.9); // gilt band
        }
    };

    // ================= shield faces =================
    const outline = (e: number): Array<[number, number]> => [
        fp(-HW - e, TOP - e), fp(HW + e, TOP - e),
        fp(HW + e, BOT + e * 0.5), fp(0, PT + e * 1.15), fp(-HW - e, BOT + e * 0.5)
    ];

    const drawShieldFace = (): void => {
        poly(g, outline(1.2), rim);                       // iron/wood rim ring
        poly(g, outline(0), field);                       // painted field
        if (lvl === 1) {
            // Humble: weathered darker wash toward the kite point.
            poly(g, [fp(-HW * 0.86, 1.4), fp(HW * 0.86, 1.4), fp(0, 6.0)], fieldDk);
        }
        // Double chevron (points up — heraldic), clean and central.
        const cw = 4.6, rise = 3.1, th = 2.1;
        for (const y0 of [-4.6, -0.4]) {
            poly(g, [
                fp(-cw, y0), fp(0, y0 - rise), fp(cw, y0),
                fp(cw, y0 + th), fp(0, y0 - rise + th), fp(-cw, y0 + th)
            ], chev);
        }
        // Central boss, upper field.
        const [bX, bY] = fp(0, -8.3);
        if (lvl >= 3) {
            g.lineStyle(1, gold, 1);
            g.strokeCircle(bX, bY, 2.6);
        }
        g.fillStyle(steelDk, 1);
        g.fillCircle(bX, bY, 2.1);
        g.fillStyle(steelMd, 1);
        g.fillCircle(bX - 0.45, bY - 0.45, 1.25);
        g.fillStyle(steelLt, 1);
        g.fillCircle(bX - 0.7, bY - 0.7, 0.5);
        // Rim studs (iron tier up).
        if (lvl >= 2) {
            g.fillStyle(steelLt, 1);
            for (const h of [-8.2, -2.6, 1.6]) {
                const [lx, ly] = fp(-HW - 0.55, h);
                const [rx, ry] = fp(HW + 0.55, h);
                g.fillCircle(lx, ly, 0.6);
                g.fillCircle(rx, ry, 0.6);
            }
        }
        // Refined tier: gold pinline + finial + point chape (accents only).
        if (lvl >= 3) {
            const inn: Array<[number, number]> = [
                fp(-HW + 1.1, TOP + 1.1), fp(HW - 1.1, TOP + 1.1),
                fp(HW - 1.1, BOT - 0.1), fp(0, PT - 1.4), fp(-HW + 1.1, BOT - 0.1)
            ];
            g.lineStyle(0.7, gold, 0.95);
            g.beginPath();
            g.moveTo(inn[0][0], inn[0][1]);
            for (let i = 1; i < inn.length; i++) g.lineTo(inn[i][0], inn[i][1]);
            g.closePath();
            g.strokePath();
            const [fX, fY] = fp(0, TOP - 1.6);
            g.fillStyle(gold, 1);
            g.fillCircle(fX, fY, 0.85);
            poly(g, [fp(-1.15, PT - 1.6), fp(1.15, PT - 1.6), fp(0, PT + 0.9)], gold);
        }
        // NW light: lit top edge + lit screen-left edge; dark on the SE run.
        const leftW = ux >= 0 ? -HW : HW;
        const [tlx, tly] = fp(-HW - 1.2, TOP - 1.2);
        const [trx, tryy] = fp(HW + 1.2, TOP - 1.2);
        g.lineStyle(1, rimLt, 0.95);
        g.lineBetween(tlx, tly, trx, tryy);
        const [e0x, e0y] = fp(leftW * 1.16, TOP - 0.6);
        const [e1x, e1y] = fp(leftW * 1.16, BOT + 0.3);
        g.lineBetween(e0x, e0y, e1x, e1y);
        const [d0x, d0y] = fp(-leftW * 1.17, BOT + 0.4);
        const [d1x, d1y] = fp(0, PT + 1.25);
        g.lineStyle(1, shade(rim, 0.6), 0.9);
        g.lineBetween(d0x, d0y, d1x, d1y);
    };

    const drawShieldBack = (): void => {
        poly(g, outline(1.2), rim);                        // rim ring shows around the back
        poly(g, outline(0), woodBack);                     // planked rear
        g.lineStyle(0.8, woodDk, 0.9);
        for (const w of [-2.3, 0, 2.3]) {
            const [p0x, p0y] = fp(w, TOP + 1.2);
            const [p1x, p1y] = fp(w, BOT + (1 - Math.abs(w) / HW) * 3.4);
            g.lineBetween(p0x, p0y, p1x, p1y);             // plank seams
        }
        for (const h of [-6.8, -0.8]) {                    // carrying battens
            poly(g, [fp(-HW + 0.9, h), fp(HW - 0.9, h), fp(HW - 0.9, h + 1.8), fp(-HW + 0.9, h + 1.8)],
                shade(woodBack, 1.22));
            if (lvl >= 2) {
                g.fillStyle(lvl >= 3 ? gold : steelMd, 1);
                const [r0x, r0y] = fp(-HW + 1.7, h + 0.9);
                const [r1x, r1y] = fp(HW - 1.7, h + 0.9);
                g.fillCircle(r0x, r0y, 0.55);
                g.fillCircle(r1x, r1y, 0.55);
            }
        }
        // Diagonal guige strap.
        const [s0x, s0y] = fp(-3.6, -8.6);
        const [s1x, s1y] = fp(2.9, 0.9);
        limb(g, leather, s0x, s0y, s1x, s1y, 1.6);
        // NW light along the top rim.
        const [tlx, tly] = fp(-HW - 1.2, TOP - 1.2);
        const [trx, tryy] = fp(HW + 1.2, TOP - 1.2);
        g.lineStyle(1, rimLt, 0.95);
        g.lineBetween(tlx, tly, trx, tryy);
    };

    // ================= the mace jab (around the shield edge) =================
    // slideAcross: windup cocks the head ACROSS the +u edge (face/back views);
    // otherwise it cocks back along the facing (side view).
    const drawMace = (eX: number, eY: number, armFromX: number | null, armFromY: number, slideAcross: boolean): void => {
        if (!inCombat || (windup <= 0.05 && strike <= 0)) return;
        if (strike > 0) {
            const ext = 7.2 * easeOut(strike);
            const hx = eX + fx * ext, hy = eY + fy * ext;
            const bx = eX + fx * (ext - 5.0), by = eY + fy * (ext - 5.0);
            if (armFromX !== null) limb(g, cloth, armFromX, armFromY, bx, by, 2.0);
            limb(g, 0x4a341f, bx, by, hx, hy, 1.3);            // haft
            g.fillStyle(gauntlet, 1);
            g.fillCircle(bx, by, 1.3);                          // fist
            g.fillStyle(steelDk, 1);
            g.fillCircle(hx, hy, 2.0);                          // head
            g.fillStyle(steelMd, 1);
            g.fillCircle(hx - 0.5, hy - 0.5, 1.2);
            g.fillStyle(lvl >= 3 ? gold : steelMd, 1);          // flange nubs
            g.fillCircle(hx + fx * 2.0, hy + fy * 2.0, 0.72);
            g.fillCircle(hx - fx * 2.0, hy - fy * 2.0, 0.72);
            g.fillCircle(hx + nux * 1.8, hy + nuy * 1.8, 0.72);
            g.fillCircle(hx - nux * 1.8, hy - nuy * 1.8, 0.72);
            if (strike > 0.5) {                                 // jab streak
                g.lineStyle(1.2, 0xf5f2e8, (strike - 0.5) * 0.8);
                g.lineBetween(eX + fx * 1.4, eY + fy * 1.4, hx, hy);
            }
        } else {
            // Cock: the head creeps into view at the rim — no haft clutter.
            const k = easeOut(windup);
            const hx = eX + (slideAcross ? maceSide * nux * (0.4 + k * 1.2) : -fx * (1.6 - k * 1.3));
            const hy = eY + (slideAcross ? maceSide * nuy * (0.4 + k * 1.2) : -fy * (1.6 - k * 1.3)) - k * 0.6;
            g.fillStyle(steelDk, 1);
            g.fillCircle(hx, hy, 2.0);
            g.fillStyle(steelMd, 1);
            g.fillCircle(hx - 0.5, hy - 0.5, 1.1);
        }
    };

    // ============================ view branches ============================
    if (front) {
        // Bearer flanks show at the diagonals, then the wall of a shield.
        drawLegs();
        g.fillStyle(cloth, 1);
        g.fillCircle(bodyOx, -1.8 - breathe + bodyOy, 4.9);
        g.fillStyle(lvl >= 2 ? steelMd : leather, 1);
        g.fillCircle(bodyOx - ux * 4.5, -4.2 - breathe + bodyOy - uy * 4.5, 2.0);
        g.fillCircle(bodyOx + ux * 4.5, -4.2 - breathe + bodyOy + uy * 4.5, 2.0);
        drawShieldFace();
        // Helmet dome peeking over the rim (slides with the weight shift).
        const dX = shX + sway * 0.55, dY = shY + TOP - 0.3;
        g.fillStyle(steelMd, 1);
        g.beginPath();
        g.arc(dX, dY, 2.7, Math.PI, 0, false);
        g.closePath();
        g.fillPath();
        g.fillStyle(steelLt, 1);
        g.beginPath();
        g.arc(dX - 0.7, dY - 0.3, 1.7, Math.PI, 0, false);
        g.closePath();
        g.fillPath();
        if (lvl >= 2) g.fillRect(dX - 0.4, dY - 3.4, 0.8, 1.4);   // helm ridge
        if (lvl >= 3) {
            g.fillStyle(gold, 1);
            g.fillRect(dX - 2.2, dY - 1.0, 4.4, 0.8);             // gilt brow band
        }
        // Gauntlet knuckles curling around the trailing rim.
        g.fillStyle(gauntlet, 1);
        for (const h of [-4.4, -3.0, -1.6]) {
            const [kx, ky] = fp(-maceSide * (HW + 0.45), h);
            g.fillCircle(kx, ky, 0.9);
        }
        // Mace around the leading edge.
        const [eX, eY] = fp(maceSide * (HW + 0.8), -3.4);
        drawMace(eX, eY, null, 0, true);
    } else if (backV) {
        // Shield beyond the bearer; we read his broad back.
        drawShieldBack();
        const [eX, eY] = fp(maceSide * (HW + 0.8), -3.4);
        drawMace(eX, eY, bodyOx + maceSide * nux * 3.8, -3.2 - breathe + bodyOy + maceSide * nuy * 3.8, true);
        drawLegs();
        drawTorsoBack();
    } else {
        // SIDE profile: the porter leaning behind an edge-on slab.
        const lc = c >= 0 ? 1 : -1; // screen-side of travel
        drawLegs();
        // Torso leaning into the shield + backplate hint on the rear side.
        g.fillStyle(cloth, 1);
        g.fillCircle(bodyOx + lc * 0.6, -1.9 - breathe + bodyOy, 5.0);
        g.fillStyle(steelDk, 1);
        g.beginPath();
        g.arc(bodyOx - lc * 1.7, -2.6 - breathe, 3.1, Math.PI * 0.75, Math.PI * 1.75, lc < 0);
        g.closePath();
        g.fillPath();
        g.fillStyle(leather, 1);
        g.fillRect(bodyOx - 4.0, 1.3 - breathe, 8.0, 1.6);
        // Helmet in profile with a nasal bar.
        const hX = bodyOx + lc * (lean * 0.9 + 0.6), hY = -9.2 - breathe + bodyOy;
        g.fillStyle(steelMd, 1);
        g.fillCircle(hX, hY, 3.0);
        g.fillStyle(steelLt, 1);
        g.beginPath();
        g.arc(hX - 0.7, hY - 0.8, 2.0, Math.PI * 0.9, Math.PI * 1.9, false);
        g.closePath();
        g.fillPath();
        g.fillStyle(steelDk, 1);
        g.fillRect(hX + lc * 2.2 - 0.55, hY - 0.4, 1.1, 2.2);      // nasal
        g.fillStyle(0x140e08, 1);
        g.fillCircle(hX + lc * 1.3, hY + 0.2, 0.5);                 // eye slit
        if (lvl >= 3) {
            g.fillStyle(gold, 1);
            g.fillRect(hX - 2.4, hY - 1.2, 4.8, 0.8);
        }
        // Edge-on slab: rim bar + kite point, boss bump proud of the face.
        const sTop = shY + TOP, sBot = shY + BOT, sPt = shY + PT;
        poly(g, [
            [shX - 1.5, sTop], [shX + 1.5, sTop],
            [shX + 1.5, sBot], [shX, sPt], [shX - 1.5, sBot]
        ], rim);
        g.fillStyle(rimLt, 1);
        g.fillRect(shX - 1.5, sTop, 1.1, sBot - sTop);              // NW-lit long edge
        g.fillStyle(field, 1);
        g.fillRect(shX + lc * 0.6 - 0.45, sTop + 1.2, 0.9, sBot - sTop - 2.2); // paint sliver
        g.fillStyle(steelDk, 1);
        g.fillCircle(shX + lc * 1.5, shY - 5.6, 1.5);               // boss bump in profile
        if (lvl >= 3) {
            g.fillStyle(gold, 1);
            g.fillCircle(shX, sTop - 0.9, 0.8);                     // finial
        }
        // Near arm bracing the slab.
        limb(g, cloth, bodyOx + lc * 2.2, -3.0 - breathe, shX - lc * 0.7, -3.6 + shY, 2.0);
        g.fillStyle(gauntlet, 1);
        g.fillCircle(shX - lc * 0.7, -3.6 + shY, 1.25);
        // Mace jabs past the slab at mid height.
        drawMace(shX + fx * 0.6, shY - 3.6, bodyOx - lc * 1.6, -2.6 - breathe, false);
    }
}
