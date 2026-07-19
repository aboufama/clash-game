import type Phaser from 'phaser';

/**
 * CLOCKWORK BEETLE — design B: "The Ironback Scarab".
 *
 * A squat, wide SCARAB-TANK in dark da Vinci brass (0x7a5c20): a stepped
 * fortress dome over two tiers of segmented plate skirts, six iron strut
 * legs splayed under the hem, a low armored visor with ember slit-eyes and
 * twin prow blades — and a MASSIVE two-arm winding key rising off the shell
 * like a siege crank. Menace over cuteness: knee-high, fortress-low, and
 * always ticking.
 *
 * MOTION (all deterministic f(time)/f(attackAge) — iron rule 3):
 *  - WALK  — fast scuttle on an exact 240 ms stride (TROOP_PARAMS sync):
 *    tripod gait (alternating leg triples), body bob at 2 bounces/stride,
 *    ember pulse closes per stride, and the key whirrs at exactly PI rad
 *    per stride — the 2-fold-symmetric key repeats every 180°, so the walk
 *    loop closes seamlessly over one stride.
 *  - IDLE  — ONE declared 2000 ms period (idleMs: 2000; every term an exact
 *    250 ms-multiple harmonic): the key RATCHETS 4 × 90° ticks per period
 *    (eased snap, then hold — wing tips sweep >> 1.5 world px) and the
 *    embers (eyes, side vents, tail boiler) pulse on a 1000 ms harmonic
 *    (>> 16/255 RGB swing). Loop closes exactly: 4 × 90° = 360°.
 *  - ATTACK (delay 500, detonateOnAttack) — the ARMING OVERWIND: windup is
 *    the FULL 500 ms cycle (windup: 500, strike: 0 — the engine detonates
 *    on the tick; MainScene owns the boom). The key spins up quadratically
 *    to ~2.5 turns, the shell hunkers down, a high-frequency tremble keyed
 *    on attackAge builds, and every ember + the elytra seam ramps from
 *    ember-orange to white-hot by COLOR AND SIZE at alpha 1 (no baked
 *    translucency — glow never rides an alpha ramp).
 *
 * LEVELS: L1 rough dark brass + iron · L2 steel-trimmed plate (hem band,
 * skirt rivets, heavier prow) · L3 gold ACCENTS only (seam rivets, hem
 * trim, prow tips, paddle edges, cap roundel) on the same dark-brass body.
 * PALETTES: player = warm brass with amber embers; enemy = colder, darker
 * bronze with red embers.
 */

type G = Phaser.GameObjects.Graphics;

const GY = 9.5;              // ground line (the villager rule)
const STRIDE_MS = 240;       // exact scuttle period — TROOP_PARAMS.stride
const IDLE_MS = 2000;        // declared idle period (250 ms multiple)
const WINDUP_MS = 500;       // arming covers the whole 500 ms attack cycle

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

/** Multiply a 0xRRGGBB colour toward dark (m<1) or light (m>1). */
function shade(c: number, m: number): number {
    const r = Math.max(0, Math.min(255, Math.round(((c >> 16) & 0xff) * m)));
    const g = Math.max(0, Math.min(255, Math.round(((c >> 8) & 0xff) * m)));
    const b = Math.max(0, Math.min(255, Math.round((c & 0xff) * m)));
    return (r << 16) | (g << 8) | b;
}

/** Per-channel colour mix c1→c2 by t (0..1). */
function mix(c1: number, c2: number, t: number): number {
    const k = clamp01(t);
    const r = Math.round(((c1 >> 16) & 0xff) + (((c2 >> 16) & 0xff) - ((c1 >> 16) & 0xff)) * k);
    const g = Math.round(((c1 >> 8) & 0xff) + (((c2 >> 8) & 0xff) - ((c1 >> 8) & 0xff)) * k);
    const b = Math.round((c1 & 0xff) + ((c2 & 0xff) - (c1 & 0xff)) * k);
    return (r << 16) | (g << 8) | b;
}

export function drawClockworkbeetleB(
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
    const lvl = Math.max(1, Math.min(3, troopLevel || 1));
    const cs = Math.cos(facingAngle);
    const sn = Math.sin(facingAngle);

    // ---- aim-space mappers (d = along aim, w = across, h = up; iso 0.5) ----
    const SX = (d: number, w: number): number => cs * d - sn * w;
    const SY = (d: number, w: number): number => (sn * d + cs * w) * 0.5;

    // ------------------- attack: the arming overwind -------------------
    let arming = 0;
    if (!isMoving && attackAge >= 0 && attackDelay > 0) {
        let age = attackAge;
        if (age > attackDelay + 600) age = time % attackDelay; // stale/replay: free-run
        const windup = Math.min(WINDUP_MS, attackDelay);
        const remaining = attackDelay - age;
        arming = remaining <= 0 ? 1 : remaining >= windup ? 0 : 1 - remaining / windup;
    }
    // High-frequency tremble keyed on attackAge (bake pins `time`, sweeps age).
    const trembleX = arming > 0 ? Math.sin(attackAge * 0.13) * 0.8 * arming : 0;
    const hSquash = 1 - 0.12 * arming; // the shell hunkers before the blast

    // ------------------------- gait / body bob -------------------------
    const walkPh = (time % STRIDE_MS) / STRIDE_MS;
    const bodyBob = isMoving ? Math.abs(Math.sin(walkPh * Math.PI * 2)) * 0.6 : 0;

    // Body-space point (bob + hunker + tremble); leg-space point (planted).
    const bp = (d: number, w: number, h: number): [number, number] =>
        [SX(d, w) + trembleX, GY + SY(d, w) - h * hSquash - bodyBob];
    const lp = (d: number, w: number, h: number): [number, number] =>
        [SX(d, w), GY + SY(d, w) - h];

    const poly = (pts: number[][], color: number, a: number = 1): void => {
        g.fillStyle(color, a);
        g.beginPath();
        g.moveTo(pts[0][0], pts[0][1]);
        for (let i = 1; i < pts.length; i++) g.lineTo(pts[i][0], pts[i][1]);
        g.closePath();
        g.fillPath();
    };
    /** Aim-space ellipse ring (half-length L along aim, half-width W across) at height h. */
    const ring = (L: number, W: number, h: number, n: number = 18, dc: number = 0): number[][] => {
        const pts: number[][] = [];
        for (let i = 0; i < n; i++) {
            const th = (i / n) * Math.PI * 2;
            pts.push(bp(dc + Math.cos(th) * L, Math.sin(th) * W, h));
        }
        return pts;
    };

    // ----------------------------- palette -----------------------------
    const brassBase = isPlayer ? 0x7a5c20 : 0x63481f;
    const body = shade(brassBase, [0.92, 1.0, 1.06][lvl - 1]);
    const bodyLight = shade(body, 1.32);
    const bodyLighter = shade(body, 1.6);
    const bodyDark = shade(body, 0.66);
    const bodyDeep = shade(body, 0.42);
    const iron = isPlayer ? 0x4a463e : 0x403c38;
    const ironDark = shade(iron, 0.58);
    const ironLight = shade(iron, 1.55);
    const steel = 0x6e7884;
    const gold = 0xdaa520;
    const goldLight = 0xffd700;

    const emberDim = isPlayer ? 0x93340d : 0x7d1d14;
    const emberHot = isPlayer ? 0xff9c2a : 0xff5526;
    const emberWhite = isPlayer ? 0xffe9a8 : 0xffd090;
    // Ember pulse: 240 ms harmonic while scuttling (walk loop closes on one
    // stride), 1000 ms harmonic at rest (idle loop closes on 2000 ms).
    const pulse = 0.5 + 0.5 * Math.sin(((time % (isMoving ? STRIDE_MS : 1000)) / (isMoving ? STRIDE_MS : 1000)) * Math.PI * 2);
    // The RIM stays saturated ember-orange even at full arming (a white-out
    // reads as paint, not heat); only the CORE runs to white at the brink.
    const ember = mix(mix(emberDim, emberHot, 0.45 + 0.55 * pulse), emberHot, arming * 0.45);
    const emberCore = mix(mix(emberHot, emberWhite, 0.25 * pulse), emberWhite, arming);

    // -------------------------- the key's angle --------------------------
    // Walk: PI rad per exact stride (2-fold-symmetric key → loop closes).
    // Idle: 4 ratchet ticks of 90° per 2000 ms period (snap 30%, hold 70%).
    // Arming: quadratic spin-up, ~2.5 turns by the damage tick.
    let keyA: number;
    if (arming > 0) {
        keyA = arming * arming * Math.PI * 5;
    } else if (isMoving) {
        keyA = (time / STRIDE_MS) * Math.PI;
    } else {
        const ph = (time % IDLE_MS) / IDLE_MS;
        const stepN = Math.floor(ph * 4);
        const local = ph * 4 - stepN;
        const snap = local < 0.3 ? 1 - (1 - local / 0.3) * (1 - local / 0.3) : 1;
        keyA = (stepN + snap) * (Math.PI / 2);
    }

    // =========================== 1. shadow ===========================
    poly(Array.from({ length: 16 }, (_, i) => {
        const th = (i / 16) * Math.PI * 2;
        return lp(Math.cos(th) * 11.6, Math.sin(th) * 9.8, 0);
    }), 0x000000, 0.25);

    // ================= 2. head + prow (behind when aiming up) =================
    const headFirst = sn < -0.02;
    const drawHeadProw = (): void => {
        // Visor block: sloped top, side faces, blunt front.
        const t1 = bp(8.4, -3.8, 3.4), t2 = bp(8.4, 3.8, 3.4);
        const t3 = bp(12.4, 2.7, 2.7), t4 = bp(12.4, -2.7, 2.7);
        const b3 = bp(12.4, 2.7, 0.9), b4 = bp(12.4, -2.7, 0.9);
        // side faces (only the down-screen one shows; NW light picks the tone)
        for (const s of [1, -1]) {
            if (cs * 0.5 * s <= 0.02) continue;
            const top1 = bp(8.4, s * 3.8, 3.4), top2 = bp(12.4, s * 2.7, 2.7);
            const bot2 = bp(12.4, s * 2.7, 0.9), bot1 = bp(8.4, s * 3.8, 0.9);
            poly([top1, top2, bot2, bot1], SX(0, s) < 0 ? bodyDark : bodyDeep);
        }
        // front face
        if (sn > 0.02) poly([t4, t3, b3, b4], cs < 0 ? bodyDark : bodyDeep);
        // sloped visor top + brow band
        poly([t1, t2, t3, t4], bodyLight);
        poly([bp(10.9, -3.3, 3.15), bp(10.9, 3.3, 3.15), bp(12.4, 2.7, 2.75), bp(12.4, -2.7, 2.75)], lvl >= 2 ? steel : ironDark);
        // ember slit-eyes on the visor slope — read from every heading
        for (const s of [1, -1]) {
            const [ex, ey] = bp(11.7, s * 1.7, 3.05);
            g.fillStyle(0x1c1410, 1);
            g.fillEllipse(ex, ey, 2.6, 1.4);
            g.fillStyle(ember, 1);
            g.fillEllipse(ex, ey, 1.9, 1.0);
            g.fillStyle(emberCore, 1);
            g.fillEllipse(ex, ey, 0.8 + arming * 0.6, 0.45 + arming * 0.35);
        }
        // twin prow blades — a battering prow, not mandibles
        const prowS = lvl >= 2 ? 1.18 : 1;
        for (const s of [1, -1]) {
            const base1 = bp(9.9, s * 3.6, 2.3);
            const base2 = bp(11.3, s * 4.3 * prowS, 1.4);
            const tip = bp(16.2, s * 1.0, 3.0);
            poly([base1, base2, tip], iron);
            poly([bp(10.2, s * 3.3, 2.5), bp(11.0, s * 3.7, 2.2), tip], ironLight);
            if (lvl >= 3) poly([bp(14.2, s * 1.85, 2.7), bp(14.7, s * 2.15, 2.5), tip], gold);
        }
    };
    if (headFirst) drawHeadProw();

    // ====================== 3. six strut legs ======================
    // Tripod gait: triples (FL,MR,RL) vs (FR,ML,RR) half a stride apart.
    g.lineStyle(1.7, ironDark, 1);
    const legRows = [6.2, 0, -6.2];
    for (let r = 0; r < 3; r++) {
        for (const s of [1, -1]) {
            const off = (r % 2 === 0) === (s > 0) ? 0 : 0.5;
            const a = (walkPh + off) * Math.PI * 2;
            const sw = isMoving ? Math.sin(a) * 2.7 : 0;
            const lift = isMoving ? Math.max(0, Math.sin(a)) * 1.7 : 0;
            const splay = arming * 0.8; // braced stance before the blast
            const hip = lp(legRows[r], s * 6.6, 3.0 + bodyBob * 0.5);
            const knee = lp(legRows[r] + sw * 0.55, s * (9.2 + splay * 0.5), 2.6 + lift * 0.7);
            const foot = lp(legRows[r] + sw, s * (11.0 + splay), lift * 0.9);
            g.lineStyle(1.7, ironDark, 1);
            g.lineBetween(hip[0], hip[1], knee[0], knee[1]);
            g.lineStyle(1.4, iron, 1);
            g.lineBetween(knee[0], knee[1], foot[0], foot[1]);
            g.fillStyle(0x241d14, 1);
            g.fillEllipse(foot[0], foot[1] + 0.3, 2.1, 1.1);
        }
    }

    // ================== 4. belly slab + plate skirts ==================
    poly(ring(10.4, 8.7, 1.1), bodyDeep);

    // Two shingled tiers of segmented plates around the near (down-screen) arc.
    const skirtTier = (
        Ltop: number, Wtop: number, hTop: number,
        Lbot: number, Wbot: number, hBot: number,
        nSeg: number, phase: number, tone: number
    ): void => {
        for (let i = 0; i < nSeg; i++) {
            const a0 = ((i + phase) / nSeg) * Math.PI * 2;
            const a1 = ((i + phase + 0.92) / nSeg) * Math.PI * 2; // 8% seam gap
            const am = (a0 + a1) / 2;
            // Cull plates on the far side (outward screen-y up-screen).
            if (SY(Math.cos(am), Math.sin(am)) <= 0.04) continue;
            // NW light: outward normals pointing screen-left get lit.
            const nx = SX(Math.cos(am), Math.sin(am));
            const lit = 0.78 + 0.36 * (0.5 - 0.5 * Math.max(-1, Math.min(1, nx * 1.4)));
            poly([
                bp(Math.cos(a0) * Ltop, Math.sin(a0) * Wtop, hTop),
                bp(Math.cos(a1) * Ltop, Math.sin(a1) * Wtop, hTop),
                bp(Math.cos(a1) * Lbot, Math.sin(a1) * Wbot, hBot),
                bp(Math.cos(a0) * Lbot, Math.sin(a0) * Wbot, hBot)
            ], shade(tone, lit));
            if (lvl >= 2) {
                // plate rivet
                const [rx, ry] = bp(Math.cos(am) * Ltop, Math.sin(am) * Wtop, hTop - 0.35);
                g.fillStyle(lvl >= 3 ? gold : ironLight, 1);
                g.fillCircle(rx, ry, 0.55);
            }
        }
    };
    skirtTier(9.9, 8.3, 4.7, 10.7, 9.0, 2.5, 9, 0, body);
    skirtTier(10.2, 8.6, 2.9, 11.2, 9.4, 1.0, 9, 0.5, bodyDark);
    // Hem trim band (steel at L2, gold at L3) along the near hem edge.
    if (lvl >= 2) {
        g.lineStyle(1, lvl >= 3 ? gold : steel, 1);
        let prev: number[] | null = null;
        for (let i = 0; i <= 26; i++) {
            const th = (i / 26) * Math.PI * 2;
            if (SY(Math.cos(th), Math.sin(th)) <= 0.06) { prev = null; continue; }
            const cur = bp(Math.cos(th) * 11.2, Math.sin(th) * 9.4, 1.0);
            if (prev) g.lineBetween(prev[0], prev[1], cur[0], cur[1]);
            prev = cur;
        }
    }

    // ================= 5. the stepped fortress dome =================
    // Narrow, soft step shadows — wide dark bands read as a muddy target.
    poly(ring(10.1, 8.45, 3.3), body);                       // base tier
    poly(ring(8.45, 6.95, 4.5), shade(body, 0.56));          // step shadow
    poly(ring(8.3, 6.85, 5.1), shade(body, 1.12));           // mid tier
    poly(ring(5.85, 4.65, 6.1), shade(body, 0.56));          // step shadow
    poly(ring(5.7, 4.55, 6.5), bodyLight);                   // cap
    // radial plate seams on the near base tier
    g.lineStyle(0.8, bodyDeep, 1);
    for (let i = 0; i < 8; i++) {
        const th = (i / 8) * Math.PI * 2 + Math.PI / 8;
        if (SY(Math.cos(th), Math.sin(th)) <= 0.1) continue;
        const p1 = bp(Math.cos(th) * 8.3, Math.sin(th) * 6.85, 4.4);
        const p2 = bp(Math.cos(th) * 10.0, Math.sin(th) * 8.35, 3.35);
        g.lineBetween(p1[0], p1[1], p2[0], p2[1]);
    }
    // NW-light highlight patch on the cap (solid lighter brass, no alpha)
    const [cx0, cy0] = bp(0.8, 0, 6.5);
    g.fillStyle(bodyLighter, 1);
    g.fillEllipse(cx0 - 1.7, cy0 - 0.5, 4.4, 1.9);
    // rear mainspring drum peeking over the tail
    poly(ring(2.4, 1.9, 3.9, 12, -7.4), bodyDark);
    poly(ring(1.8, 1.4, 4.5, 12, -7.4), bodyDeep);

    // Elytra seam arcing over the dome along the aim axis, riveted.
    const hSeam = (d: number): number => Math.max(3.0, 6.7 * Math.sqrt(Math.max(0, 1 - (d / 10.4) * (d / 10.4))));
    const seamGlow = arming > 0.15;
    const seamPath = (width: number, color: number): void => {
        g.lineStyle(width, color, 1);
        g.beginPath();
        const s0 = bp(-9.8, 0, hSeam(-9.8));
        g.moveTo(s0[0], s0[1]);
        for (let d = -8; d <= 9.9; d += 1.8) {
            const [px2, py2] = bp(d, 0, hSeam(d));
            g.lineTo(px2, py2);
        }
        g.strokePath();
    };
    if (seamGlow) {
        // saturated hot rim under a white-hot core — heat, not white paint
        seamPath(1.4 + arming * 1.6, mix(emberDim, emberHot, 0.4 + 0.6 * arming));
        seamPath(0.7 + arming * 0.7, mix(emberHot, emberWhite, arming * 0.9));
    } else {
        seamPath(1.1, bodyDeep);
    }
    for (const d of [-7.5, -5, 2, 4.5, 7]) { // seam rivets (key boss sits at -3..0)
        const [rx, ry] = bp(d, 0, hSeam(d) + 0.25);
        g.fillStyle(seamGlow ? emberWhite : (lvl >= 3 ? gold : ironLight), 1);
        g.fillCircle(rx, ry, 0.6);
    }
    if (lvl >= 3) { // max-level roundel: a small gilded medallion, accent only
        const [gx2, gy2] = bp(2.8, 0, 6.6);
        g.fillStyle(gold, 1);
        g.fillCircle(gx2, gy2, 1.5);
        g.fillStyle(bodyDeep, 1);
        g.fillCircle(gx2, gy2, 0.9);
        g.fillStyle(goldLight, 1);
        g.fillCircle(gx2 - 0.3, gy2 - 0.3, 0.4);
    }

    // ============ 6. embers: side vents + tail boiler window ============
    const vents: Array<[number, number, number, number]> = [
        [0.4, 8.1, 0, 1],   // right flank  (outward w = +1)
        [0.4, -8.1, 0, -1], // left flank   (outward w = -1)
        [-10.0, 0, -1, 0]   // tail boiler  (outward d = -1)
    ];
    for (const [vd, vw, od, ow] of vents) {
        if (SY(od, ow) <= 0.05) continue; // hidden on the far side
        const [vx, vy] = bp(vd, vw, 2.7);
        g.fillStyle(0x1c1410, 1);
        g.fillEllipse(vx, vy, 3.4, 1.7);
        g.fillStyle(ember, 1);
        g.fillEllipse(vx, vy, 2.5 + arming * 0.9, 1.15 + arming * 0.45);
        g.fillStyle(emberCore, 1);
        g.fillEllipse(vx, vy, 1.15 + arming * 1.0, 0.5 + arming * 0.45);
    }

    if (!headFirst) drawHeadProw();

    // ================== 7. THE KEY — the siege crank ==================
    const keyBrass = shade(body, 1.18);
    const keyDark = shade(body, 0.7);
    // mount boss + ratchet collar on the cap
    const [mx, my] = bp(-3, 0, 6.55);
    g.fillStyle(ironDark, 1);
    g.fillEllipse(mx, my, 4.0, 2.0);
    g.fillStyle(iron, 1);
    g.fillEllipse(mx, my - 0.3, 2.9, 1.45);
    if (lvl >= 2) { g.fillStyle(steel, 1); g.fillEllipse(mx, my - 0.5, 1.9, 0.95); }
    // shaft
    const hub = bp(-3, 0, 11.3);
    g.lineStyle(1.9, ironDark, 1);
    g.lineBetween(mx, my - 0.4, hub[0], hub[1]);
    g.lineStyle(0.8, ironLight, 1);
    g.lineBetween(mx - 0.45, my - 0.5, hub[0] - 0.45, hub[1] - 0.1);

    // two identical crank arms + paddles (2-fold symmetric — walk-loop safe)
    const ux = Math.cos(keyA), uy = Math.sin(keyA) * 0.5;
    const ul = Math.hypot(ux, uy);
    const nx = -uy / ul, ny = ux / ul;
    const ARM = 7.4, PAD = 1.9;
    const drawWing = (s: number): void => {
        const tipX = hub[0] + s * ux * ARM, tipY = hub[1] + s * uy * ARM;
        // tapered arm
        poly([
            [hub[0] + nx * 1.0, hub[1] + ny * 1.0],
            [tipX + nx * 1.35, tipY + ny * 1.35],
            [tipX - nx * 1.35, tipY - ny * 1.35],
            [hub[0] - nx * 1.0, hub[1] - ny * 1.0]
        ], s * ux < 0 ? keyBrass : keyDark);
        // heavy paddle (the key bow), widening outward, with a dark slot
        const pcx = tipX + s * ux * PAD, pcy = tipY + s * uy * PAD;
        const pc = (a: number, b: number): number[] => [pcx + s * ux * a + nx * b, pcy + s * uy * a + ny * b];
        poly([pc(-2.0, 1.5), pc(2.1, 2.1), pc(2.1, -2.1), pc(-2.0, -1.5)], keyBrass);
        poly([pc(-0.8, 0.75), pc(1.0, 0.95), pc(1.0, -0.95), pc(-0.8, -0.75)], bodyDeep);
        // lit top edge (NW light) + max-level gilded outer rim
        const upS = ny < 0 ? 1 : -1;
        g.lineStyle(0.8, shade(keyBrass, 1.4), 1);
        g.lineBetween(hub[0] + nx * upS * 0.7, hub[1] + ny * upS * 0.7, tipX + nx * upS * 1.05, tipY + ny * upS * 1.05);
        if (lvl >= 3) {
            g.lineStyle(0.9, gold, 1);
            const e1 = pc(2.1, 2.1), e2 = pc(2.1, -2.1);
            g.lineBetween(e1[0], e1[1], e2[0], e2[1]);
        }
        // tip stud
        const st = pc(2.1, 0);
        g.fillStyle(ironLight, 1);
        g.fillCircle(st[0], st[1], 0.7);
    };
    // far wing (up-screen) behind the hub nut, near wing in front
    const farS = uy < 0 ? 1 : -1;
    drawWing(farS);
    g.fillStyle(iron, 1);
    g.fillCircle(hub[0], hub[1], 1.35);
    g.fillStyle(ironDark, 1);
    g.fillCircle(hub[0], hub[1], 0.6);
    drawWing(-farS);
}
