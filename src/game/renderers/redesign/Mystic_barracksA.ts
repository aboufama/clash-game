import type Phaser from 'phaser';

/**
 * MYSTIC BARRACKS — DESIGN A: "ATHENAEUM OF WAR"
 * ----------------------------------------------
 * A TALL, compact white-marble war-academy tower (2x2, deliberately vertical)
 * wrapped in fluted Greek columns, crowned by a LEVITATING broken-pediment
 * capstone. In the open air gap between the tower crown and the floating
 * capstone a rune-ring slowly rotates — the "training pulse", the building's
 * signature ambient. Arcane blue-flame braziers flank a tall bronze door
 * beneath a Greek-key meander frieze; a compact marble muster apron runs from
 * the door onto the lawn (sibling DNA with the Mechanica barracks: tall-keep
 * proportions, door-apron muster strip, west-corner banner mount).
 *
 * LEVEL LANGUAGE (9 distinct steps). THE SIZE CAP: L5 is the LARGEST the
 * building ever gets — every mass term clamps at its L5 value (sz below) and
 * L6-9 evolve through material, palette and finish quality only:
 *   L1  plastered limestone shell, corner pilasters, low-floating capstone
 *   L2  fluted tetrastyle columns on the door face + meander frieze
 *   L3  second tier (the scriptorium drum) w/ glowing spell-slits + oculus
 *   L4  flames & runes turn VIOLET; full broken pediment + floating gem
 *   L5  colonnade wraps the SE face — MAX MASS
 *   L6  polished veined marble (brighter toned palette), burnished bronze door
 *   L7  flames, runes & gem burn WHITE-GOLD
 *   L8  Mastery: warm sandstone toning + gold meander line
 *   L9  Mastery max: sandstone + gold/white ACCENTS only — gilded rakes,
 *       gold orb + roundel, gilded capitals. Marble stays toned.
 *
 * AMBIENT CONTRACT — ONE exact period P = 2000 ms (250 ms multiple):
 *   - rune-ring advances exactly 2π/8 per P (8 identical runes → the frame
 *     at t+P is pixel-identical to t: a hard-closed loop)
 *   - capstone bob: sin(2π·t/P), ±(1.7..2.2) px  (≥1.5 px everywhere)
 *   - brazier flames: k=2 and k=3 harmonics, lick amplitude ≥1.6 px
 *   - rune/band/window glows: k=2 harmonic, ≥16/255 RGB swing
 *   - rising "training pulse" glint: sawtooth over P whose alpha is 0 at
 *     both ends (sin(π·u)) — closes exactly at P
 *   All motion is a deterministic function of `time`; time=0 is a sane rest
 *   pose (bob 0, ring at slot 0, mid flames, glint invisible).
 *
 * DOOR CONTRACT: building.doorOpen (0..1, continuous) — twin bronze leaves
 * retract toward the jambs monotonically; at 0.5 the doorway is visibly
 * half-open, at 1.0 fully open with a cool arcane light spill.
 *
 * GROUNDING: chamfered contact shadow + compact muster apron only — no
 * ground plates; the lawn breathes on every side and nothing spills past
 * the 2x2 plot.
 */

type G = Phaser.GameObjects.Graphics;
type V = Phaser.Math.Vector2;
type Pt = [number, number];

/** THE one ambient clock — every animated term is an exact harmonic of it. */
const PULSE_MS = 2000;

export function drawMysticBarracksA(
    graphics: G,
    c1: V,
    c2: V,
    c3: V,
    c4: V,
    center: V,
    alpha: number,
    _tint: number | null,
    building: { level?: number; doorOpen?: number } | undefined,
    baseGraphics: G | undefined,
    skipBase: boolean,
    onlyBase: boolean,
    time: number
): void {
    const level = Math.max(1, Math.min(9, Math.round(Number(building?.level) || 1)));
    const doorOpen = Math.max(0, Math.min(1, Number(building?.doorOpen) || 0));
    // THE SIZE CAP — L5 is the largest envelope; L6-9 clamp every mass term.
    const sz = Math.min(level, 5);

    // ---- the pulse clock -------------------------------------------------
    const P = PULSE_MS;
    /** sin harmonic k of the pulse (k integer), with a constant phase. */
    const ph = (k: number, off = 0): number => Math.sin((time * k * Math.PI * 2) / P + off);
    /** sawtooth 0..1 over one pulse. */
    const u01 = (((time % P) + P) % P) / P;

    // ---- geometry helpers ------------------------------------------------
    const quad = (gr: G, pts: ReadonlyArray<Pt>, color: number, a: number): void => {
        gr.fillStyle(color, a);
        gr.beginPath();
        gr.moveTo(pts[0][0], pts[0][1]);
        for (let i = 1; i < pts.length; i++) gr.lineTo(pts[i][0], pts[i][1]);
        gr.closePath();
        gr.fillPath();
    };
    const lerp = (v: V, t: number): Pt => [
        center.x + (v.x - center.x) * t,
        center.y + (v.y - center.y) * t,
    ];
    const up = (pt: Pt, h: number): Pt => [pt[0], pt[1] - h];
    const mixPt = (a: Pt, b: Pt, t: number): Pt => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];

    // Ground-outward direction across the SW (c4→c3) face, in screen space
    // (grid (0,+1) → screen (−32,16) normalized — exact for 2:1 iso).
    const OUTX = -0.894;
    const OUTY = 0.447;

    // ---- palettes --------------------------------------------------------
    // Marble is always TONED — never a large pure-white mass (iron rule).
    const sandstone = level >= 8;
    const M = sandstone
        ? { lit: 0xc9c2ae, dark: 0xa2977c, top: 0xdcd3ba, colLit: 0xd4cbb4, colDark: 0xb0a488, seam: 0x8a8068, frieze: 0xb5aa8e }
        : level >= 6
            // L6-7 finish step: polished veined marble — brighter but TONED.
            ? { lit: 0xcfc8b6, dark: 0xa7a08e, top: 0xe1dbcb, colLit: 0xdad4c2, colDark: 0xb5ad99, seam: 0x8b8475, frieze: 0xb8af99 }
            : level >= 3
                ? { lit: 0xc2b9a4, dark: 0x9a9280, top: 0xd4ccb8, colLit: 0xcdc5b0, colDark: 0xa79f8c, seam: 0x807868, frieze: 0xaba28e }
                : { lit: 0xb3ab99, dark: 0x8f8778, top: 0xc4bcab, colLit: 0xbeb6a4, colDark: 0x9a9280, seam: 0x767061, frieze: 0xa0977f };
    // Bronze door: burnished (brighter) finish from L6.
    const BR = level >= 6
        ? { face: 0x8d6a34, lit: 0xb18a46, band: 0x5c4622, shade: 0x785a2c }
        : { face: 0x7c5a2c, lit: 0x9a7438, band: 0x54401e, shade: 0x6a4c24 };
    const gold = 0xdaa520;
    const goldLite = 0xffd700;
    // Flame tier: blue → violet → white-gold.
    const F = level >= 7
        ? { core: 0xffffff, body: 0xffdf8f, deep: 0xdca432, glow: 0xffe9b0 }
        : level >= 4
            ? { core: 0xf1e9ff, body: 0x9f7dff, deep: 0x6644cc, glow: 0xb79bff }
            : { core: 0xe2f6ff, body: 0x59c2ff, deep: 0x2a6fd6, glow: 0x7fd4ff };

    // ---- massing (TALL and compact; every term clamps at its L5 value) ----
    const S = 0.52;                                   // tier-1 inset (narrow!)
    const b3 = lerp(c3, S);
    const b4 = lerp(c4, S);
    const baseH = 3.2;                                // two-step stylobate
    const t1H = 38 + sz * 1.3;                        // the tall shaft
    const hasT2 = level >= 3;
    const t2s = 0.38;
    const t2H = hasT2 ? 7 + (sz - 3) * 1.5 : 0;
    const t1top = baseH + t1H;
    const t2top = t1top + t2H;
    const topSc = hasT2 ? t2s : S;
    const crownH = 1.8;                               // small pad under the gap
    const stackTop = (hasT2 ? t2top : t1top) + crownH;
    const gap = 6.5 + sz * 0.9;                       // levitation air gap
    const bob = (1.6 + sz * 0.12) * ph(1);            // ±1.7 .. ±2.2 px
    const capS = hasT2 ? 0.32 : 0.36;                 // capstone slab inset
    const capW = 64 * capS;                           // capstone half-width px
    const Rr = capW + 4.5;                            // rune-ring radius

    // Door metrics (used by base apron too). A TALL bronze portal.
    const doorHw = 5.2 + sz * 0.1;
    const doorH = 15.5 + sz * 0.7;
    const dX = (b3[0] + b4[0]) / 2;
    const dY = (b3[1] + b4[1]) / 2;
    const sk = (b3[1] - b4[1]) / (b3[0] - b4[0]);     // SW face slope (~0.5)
    const dp = (ox: number, h: number): Pt => [dX + ox, dY + ox * sk - h];
    const dpOut = (ox: number, h: number, push: number): Pt => {
        const p = dp(ox, h);
        return [p[0] + OUTX * push, p[1] + OUTY * push];
    };

    // =====================================================================
    // BASE — contact shadow + compact muster apron (NO plates)
    // =====================================================================
    const g = baseGraphics ?? graphics;
    if (!skipBase) {
        // Chamfered contact shadow hugging the footprint (2x2 idiom).
        const chamfered = (spread: number): Pt[] => {
            const corners: Pt[] = [c1, c2, c3, c4].map(p => [
                center.x + (p.x - center.x) * spread,
                center.y + 1 + (p.y - center.y) * spread,
            ]);
            const cut = 0.26;
            const poly: Pt[] = [];
            for (let i = 0; i < 4; i++) {
                const prev = corners[(i + 3) % 4];
                const curr = corners[i];
                const next = corners[(i + 1) % 4];
                poly.push([curr[0] + (prev[0] - curr[0]) * cut, curr[1] + (prev[1] - curr[1]) * cut]);
                poly.push([curr[0] + (next[0] - curr[0]) * cut, curr[1] + (next[1] - curr[1]) * cut]);
            }
            return poly;
        };
        quad(g, chamfered(0.80), 0x18220f, alpha * 0.14);
        quad(g, chamfered(0.58), 0x18220f, alpha * 0.13);

        // Muster apron: a compact worn-marble strip from the door onto the
        // lawn — where recruits form up. Stays INSIDE the plot; grass shows
        // all around it.
        quad(g, [
            dpOut(-11.5, 0, 2), dpOut(11.5, 0, 2),
            dpOut(9.5, 0, 12.5), dpOut(-9.5, 0, 12.5),
        ], 0xa39a86, alpha * 0.92);
        g.lineStyle(1, 0x847c6a, alpha * 0.7);
        g.beginPath();
        const ap1 = dpOut(-9.5, 0, 12.5);
        const ap2 = dpOut(9.5, 0, 12.5);
        g.moveTo(ap1[0], ap1[1]);
        g.lineTo(ap2[0], ap2[1]);
        g.strokePath();
    }
    if (onlyBase) return;

    // =====================================================================
    // ELEVATED — the tower
    // =====================================================================

    // ---- stylobate (two shallow marble steps) ----------------------------
    const step = (sc: number, y0: number, h: number): void => {
        const e2 = lerp(c2, sc);
        const e3 = lerp(c3, sc);
        const e4 = lerp(c4, sc);
        quad(graphics, [up(e2, y0), up(e3, y0), up(e3, y0 + h), up(e2, y0 + h)], M.dark, alpha);
        quad(graphics, [up(e3, y0), up(e4, y0), up(e4, y0 + h), up(e3, y0 + h)], M.lit, alpha);
        quad(graphics, [up(lerp(c1, sc), y0 + h), up(e2, y0 + h), up(e3, y0 + h), up(e4, y0 + h)], M.top, alpha);
    };
    step(0.62, 0, 1.6);
    step(0.57, 1.6, 1.6);

    // ---- tier walls ------------------------------------------------------
    const tierWalls = (sc: number, y0: number, h: number): void => {
        const e2 = lerp(c2, sc);
        const e3 = lerp(c3, sc);
        const e4 = lerp(c4, sc);
        quad(graphics, [up(e2, y0), up(e3, y0), up(e3, y0 + h), up(e2, y0 + h)], M.dark, alpha);
        quad(graphics, [up(e3, y0), up(e4, y0), up(e4, y0 + h), up(e3, y0 + h)], M.lit, alpha);
        // Marble coursing seams (kept sparse — two courses read as scale
        // without turning the shaft noisy).
        graphics.lineStyle(1, M.seam, alpha * 0.28);
        for (const f of [0.36, 0.68]) {
            const hh = y0 + h * f;
            graphics.lineBetween(e4[0], e4[1] - hh, e3[0], e3[1] - hh);
            graphics.lineBetween(e3[0], e3[1] - hh, e2[0], e2[1] - hh);
        }
        // Base course shadow line.
        graphics.lineStyle(1.2, M.seam, alpha * 0.5);
        graphics.lineBetween(e4[0], e4[1] - y0, e3[0], e3[1] - y0);
        graphics.lineBetween(e3[0], e3[1] - y0, e2[0], e2[1] - y0);
    };
    const tierTop = (sc: number, y: number): void => {
        quad(graphics, [up(lerp(c1, sc), y), up(lerp(c2, sc), y), up(lerp(c3, sc), y), up(lerp(c4, sc), y)], M.top, alpha);
    };

    // Column on a wall face: A→B are the face's ground corners.
    const column = (A: Pt, B: Pt, t: number, halfPx: number, y0: number, h: number, lit: boolean): void => {
        const len = Math.hypot(B[0] - A[0], B[1] - A[1]);
        const dw = halfPx / len;
        const qa = mixPt(A, B, t - dw);
        const qb = mixPt(A, B, t + dw);
        const body = lit ? M.colLit : M.colDark;
        quad(graphics, [up(qa, y0), up(qb, y0), up(qb, y0 + h), up(qa, y0 + h)], body, alpha);
        // Flute shadow down the middle.
        const qm = mixPt(A, B, t);
        graphics.lineStyle(1, M.seam, alpha * (lit ? 0.45 : 0.6));
        graphics.lineBetween(qm[0], qm[1] - y0 - 1, qm[0], qm[1] - y0 - h + 1);
        // Capital + plinth (slightly wider).
        const qa2 = mixPt(A, B, t - dw * 1.5);
        const qb2 = mixPt(A, B, t + dw * 1.5);
        const capCol = level >= 9 ? gold : lit ? M.top : M.colLit;
        quad(graphics, [up(qa2, y0 + h - 1.8), up(qb2, y0 + h - 1.8), up(qb2, y0 + h), up(qa2, y0 + h)], capCol, alpha);
        quad(graphics, [up(qa2, y0), up(qb2, y0), up(qb2, y0 + 1.8), up(qa2, y0 + 1.8)], lit ? M.top : M.colLit, alpha);
    };

    // Greek-key meander frieze across a face top.
    const frieze = (A: Pt, B: Pt, yTop: number): void => {
        const hBand = 4.2;
        quad(graphics, [up(A, yTop - hBand), up(B, yTop - hBand), up(B, yTop), up(A, yTop)], M.frieze, alpha);
        const n = 7;
        for (let i = 0; i < n; i++) {
            const t = (i + 0.5) / n;
            const q = mixPt(A, B, t);
            const y = yTop - hBand * 0.5;
            graphics.fillStyle(i % 2 === 0 ? M.seam : M.top, alpha * 0.85);
            graphics.fillRect(q[0] - 0.9, q[1] - y - 0.9, 1.8, 1.8);
        }
        // Accent line under the band — the finish ladder: none → burnished
        // bronze (L6-7) → gold (Mastery).
        if (sandstone || level >= 6) {
            graphics.lineStyle(1, sandstone ? gold : BR.lit, alpha * 0.9);
            graphics.lineBetween(A[0], A[1] - yTop + 0.7, B[0], B[1] - yTop + 0.7);
        }
    };

    // ---- TIER 1 — the tall shaft -----------------------------------------
    tierWalls(S, baseH, t1H);
    const b2 = lerp(c2, S);
    const colH = t1H - 8;
    const colY = baseH + 1.2;
    // SW face columns: L1 gets flat corner pilasters; L2+ a fluted tetrastyle
    // front whose inner pair flanks the door portal.
    if (level >= 2) {
        column(b4, b3, 0.115, 1.7, colY, colH, true);
        column(b4, b3, 0.275, 1.7, colY, colH, true);
        column(b4, b3, 0.725, 1.7, colY, colH, true);
        column(b4, b3, 0.885, 1.7, colY, colH, true);
    } else {
        column(b4, b3, 0.10, 1.6, colY, colH, true);
        column(b4, b3, 0.90, 1.6, colY, colH, true);
    }
    // SE face columns from L5 (the colonnade wraps).
    if (level >= 5) {
        column(b2, b3, 0.22, 1.6, colY, colH, false);
        column(b2, b3, 0.52, 1.6, colY, colH, false);
        column(b2, b3, 0.82, 1.6, colY, colH, false);
    }
    // Meander frieze above the columns (from L2) — THE signature band; the
    // tower's glow-slits live on tier 2 only, keeping the shaft calm.
    if (level >= 2) {
        frieze(b4, b3, baseH + t1H - 0.8);
        frieze(b3, b2, baseH + t1H - 0.8);
    }
    tierTop(S, t1top);

    // ---- DOOR — tall bronze twin-leaf portal on the SW face --------------
    const doorB = baseH;                        // sits on the stylobate
    const doorT = doorB + doorH;
    // Marble surround + architrave.
    quad(graphics, [dp(-(doorHw + 1.6), doorB - 0.4), dp(doorHw + 1.6, doorB - 0.4), dp(doorHw + 1.6, doorT + 1.0), dp(-(doorHw + 1.6), doorT + 1.0)], M.colLit, alpha);
    quad(graphics, [dp(-(doorHw + 2.6), doorT + 1.0), dp(doorHw + 2.6, doorT + 1.0), dp(doorHw + 2.6, doorT + 3.4), dp(-(doorHw + 2.6), doorT + 3.4)], M.frieze, alpha);
    // (The architrave stays plain — the big meander frieze above owns the
    // Greek-key motif; duplicating it here read as noise.)
    if (sandstone) {
        graphics.lineStyle(1, gold, alpha * 0.9);
        const ga = dp(-(doorHw + 2.6), doorT + 3.2);
        const gb = dp(doorHw + 2.6, doorT + 3.2);
        graphics.lineBetween(ga[0], ga[1], gb[0], gb[1]);
    }
    // Oculus above the architrave: stone ring + arcane glow from L3; at L9 a
    // gold laurel roundel — the same feature, gilded.
    if (level >= 3) {
        const ro = dp(0, doorT + 7.2);
        graphics.lineStyle(1.2, level >= 9 ? gold : M.seam, alpha);
        graphics.strokeCircle(ro[0], ro[1], 2.4);
        if (level >= 9) {
            graphics.fillStyle(goldLite, alpha);
            graphics.fillCircle(ro[0], ro[1], 0.9);
        } else {
            graphics.fillStyle(F.glow, alpha * (0.45 + 0.14 * ph(2, 1.1)));
            graphics.fillCircle(ro[0], ro[1], 1.3);
        }
    }
    // Doorway interior + twin bronze leaves (monotonic in doorOpen).
    quad(graphics, [dp(-doorHw, doorB), dp(doorHw, doorB), dp(doorHw, doorT), dp(-doorHw, doorT)], 0x0d0a14, alpha);
    if (doorOpen > 0.02) {
        // Cool arcane light within, brightening as the door opens.
        graphics.fillStyle(F.glow, alpha * 0.25 * doorOpen);
        graphics.fillEllipse(dX, dY - doorB - doorH * 0.42, doorHw * 1.5, doorH * 0.8);
        graphics.fillStyle(F.core, alpha * 0.5 * doorOpen);
        graphics.fillCircle(dp(0, doorB + doorH * 0.55)[0], dp(0, doorB + doorH * 0.55)[1], 1.3);
        // Light spill onto the muster apron.
        graphics.fillStyle(F.glow, alpha * 0.2 * doorOpen);
        graphics.fillEllipse(dX + OUTX * 5, dY + OUTY * 5, 15, 7);
    }
    const leafW = doorHw * (1 - 0.88 * doorOpen);
    if (leafW > 0.4) {
        // Left leaf.
        quad(graphics, [dp(-doorHw, doorB), dp(-doorHw + leafW, doorB), dp(-doorHw + leafW, doorT), dp(-doorHw, doorT)], BR.face, alpha);
        // Right leaf (a touch shaded).
        quad(graphics, [dp(doorHw - leafW, doorB), dp(doorHw, doorB), dp(doorHw, doorT), dp(doorHw - leafW, doorT)], BR.shade, alpha);
        // Strap bands across both leaves.
        graphics.lineStyle(1.1, BR.band, alpha);
        for (const f of [0.28, 0.58]) {
            const la = dp(-doorHw, doorB + doorH * f);
            const lb = dp(-doorHw + leafW, doorB + doorH * f);
            graphics.lineBetween(la[0], la[1], lb[0], lb[1]);
            const ra = dp(doorHw - leafW, doorB + doorH * f);
            const rb = dp(doorHw, doorB + doorH * f);
            graphics.lineBetween(ra[0], ra[1], rb[0], rb[1]);
        }
        // Bright bronze inner-edge stiles: they track the leaves as they
        // retract, so the half-open pose reads unambiguously against the
        // dark interior (the bake samples doorOpen at exactly 0.5 and 1.0).
        graphics.lineStyle(1.2, BR.lit, alpha * 0.95);
        const el = dp(-doorHw + leafW, doorB + 0.5);
        const el2 = dp(-doorHw + leafW, doorT - 0.5);
        graphics.lineBetween(el[0], el[1], el2[0], el2[1]);
        const er = dp(doorHw - leafW, doorB + 0.5);
        const er2 = dp(doorHw - leafW, doorT - 0.5);
        graphics.lineBetween(er[0], er[1], er2[0], er2[1]);
        // Bronze sheen on the closed leaves.
        if (doorOpen < 0.05) {
            graphics.lineStyle(1, BR.lit, alpha * 0.8);
            const sa = dp(-doorHw + 1.2, doorB + 1);
            const sb = dp(-doorHw + 1.2, doorT - 1.5);
            graphics.lineBetween(sa[0], sa[1], sb[0], sb[1]);
        }
    }
    // Steps down to the apron.
    quad(graphics, [dpOut(-8, 1.6, 1.2), dpOut(8, 1.6, 1.2), dpOut(8, 0, 1.2), dpOut(-8, 0, 1.2)], M.lit, alpha);
    quad(graphics, [dpOut(-9, 0, 3.0), dpOut(9, 0, 3.0), dpOut(9, -1.4, 3.0), dpOut(-9, -1.4, 3.0)], M.dark, alpha);

    // ---- BANNER — west-corner mount (sibling DNA) ------------------------
    {
        const mount = up(b4, baseH + t1H - 4);
        const pex = mount[0] - 6.5;
        const pey = mount[1] - 2.5;
        graphics.lineStyle(1.2, 0x4a3a28, alpha);
        graphics.lineBetween(mount[0], mount[1], pex, pey);
        graphics.fillStyle(0x4a3a28, alpha);
        graphics.fillCircle(pex, pey, 0.8);
        const sway = ph(1, 0.9) * 2.0;
        const cloth: Pt[] = [
            [pex, pey + 0.6],
            [pex + 3.4, pey + 1.6],
            [pex + 1.6 + sway, pey + 10.5],
        ];
        quad(graphics, cloth, 0x7859ad, alpha);
        graphics.lineStyle(1, level >= 9 ? gold : 0x9d8bdd, alpha * 0.9);
        graphics.lineBetween(cloth[0][0], cloth[0][1], cloth[1][0], cloth[1][1]);
        graphics.fillStyle(0xd8ccf0, alpha * 0.9);
        graphics.fillCircle(pex + 1.6 + sway * 0.35, pey + 4.6, 0.8);
    }

    // ---- TIER 2 — the scriptorium drum (L3+; growth frozen at L5) --------
    if (hasT2) {
        tierWalls(t2s, t1top, t2H);
        const q3 = lerp(c3, t2s);
        const q4 = lerp(c4, t2s);
        // Corner pilasters.
        column(q4, q3, 0.09, 1.3, t1top + 0.8, t2H - 2.2, true);
        column(q4, q3, 0.91, 1.3, t1top + 0.8, t2H - 2.2, true);
        // TWO spell-slit windows, glowing with the pulse — the drum's only
        // ornament (the SE slit and the L6 third slit were noise).
        const slits = [0.34, 0.66];
        for (let i = 0; i < slits.length; i++) {
            const q = mixPt(q4, q3, slits[i]);
            const wy = t1top + 2.2;
            const wh = Math.max(3.5, t2H - 4.8);
            quad(graphics, [up([q[0] - 1, q[1]], wy), up([q[0] + 1, q[1]], wy), up([q[0] + 1, q[1]], wy + wh), up([q[0] - 1, q[1]], wy + wh)], 0x1a1626, alpha);
            graphics.fillStyle(F.glow, alpha * (0.4 + 0.13 * ph(2, 0.6 + i)));
            graphics.fillRect(q[0] - 0.5, q[1] - wy - wh + 0.5, 1, wh - 1);
        }
        tierTop(t2s, t2top);
    }

    // ---- crown pad + levitation shadow -----------------------------------
    const crownSc = topSc * 0.85;
    step(crownSc, stackTop - crownH, crownH);
    // The capstone's soft shadow on the crown deck: fades as the stone rises.
    graphics.fillStyle(0x1a2210, alpha * (0.13 - 0.045 * ph(1)));
    graphics.fillEllipse(center.x, center.y - stackTop + 0.6, capW * 1.5, capW * 0.62);

    // ---- THE TRAINING PULSE — rising glint + rotating rune-ring ----------
    // Rising glint: a ring of light climbs the gap once per pulse; its alpha
    // is zero at both ends of the cycle so the loop closes exactly at P.
    {
        const ga = Math.sin(Math.PI * u01) * 0.34;
        const gy = stackTop - crownH + u01 * (gap + crownH);
        graphics.lineStyle(1.6, F.glow, alpha * ga);
        const sqz = 1.05 - 0.35 * u01;
        graphics.strokeEllipse(center.x, center.y - gy, Rr * 2 * sqz, Rr * sqz);
    }
    const ringY = center.y - (stackTop + gap * 0.55);
    // ONE band — the rune-ring itself (the L6 outer halo was clutter).
    graphics.lineStyle(2.2, F.body, alpha * (0.6 + 0.15 * ph(2, 0.3)));
    graphics.strokeEllipse(center.x, ringY, Rr * 2, Rr);
    // Eight identical runes advancing exactly one slot (2π/8) per pulse —
    // the frame at t+P is identical to t, so the loop is hard-closed.
    const rot = u01 * (Math.PI / 4);
    for (let pass = 0; pass < 2; pass++) {
        for (let i = 0; i < 8; i++) {
            const th = rot + (i * Math.PI) / 4;
            const sy = Math.sin(th);
            const front = sy >= 0;
            if ((pass === 0) === front) continue;     // back runes first
            const rx = center.x + Math.cos(th) * Rr;
            const ry = ringY + sy * Rr * 0.5;
            const sc = front ? 1.15 : 0.8;
            // Brightness locked to the CURRENT angle (rotation-invariant) on
            // a k=2 harmonic — closes with the ring.
            const bri = 0.62 + 0.28 * Math.sin((time * 4 * Math.PI) / P + th * 2);
            graphics.fillStyle(F.glow, alpha * bri * (front ? 0.45 : 0.28));
            graphics.fillCircle(rx, ry, 3.4 * sc);
            graphics.fillStyle(F.body, alpha * Math.min(1, bri + 0.3));
            graphics.fillCircle(rx, ry, 2.0 * sc);
            graphics.fillStyle(F.core, alpha * Math.min(1, bri + 0.1));
            graphics.fillCircle(rx, ry, 1.0 * sc);
        }
    }

    // ---- THE LEVITATING BROKEN-PEDIMENT CAPSTONE -------------------------
    // Drawn AFTER the ring so the ring's back arc reads as passing behind
    // the floating stone.
    {
        const slabH = 2.4;
        const capBase = stackTop + gap + bob;
        const capTop = capBase + slabH;
        const k1 = lerp(c1, capS);
        const k2 = lerp(c2, capS);
        const k3 = lerp(c3, capS);
        const k4 = lerp(c4, capS);
        // Underside energy seam — the levitation glow.
        graphics.lineStyle(1.5, F.glow, alpha * (0.35 + 0.1 * ph(2, 1.7)));
        graphics.lineBetween(k4[0], k4[1] - capBase + 0.8, k3[0], k3[1] - capBase + 0.8);
        graphics.lineBetween(k3[0], k3[1] - capBase + 0.8, k2[0], k2[1] - capBase + 0.8);
        // The floating base slab.
        quad(graphics, [up(k2, capBase), up(k3, capBase), up(k3, capTop), up(k2, capTop)], M.dark, alpha);
        quad(graphics, [up(k3, capBase), up(k4, capBase), up(k4, capTop), up(k3, capTop)], M.lit, alpha);
        quad(graphics, [up(k1, capTop), up(k2, capTop), up(k3, capTop), up(k4, capTop)], M.top, alpha);
        if (level >= 9) {
            graphics.lineStyle(1, gold, alpha * 0.9);
            graphics.lineBetween(k4[0], k4[1] - capTop, k3[0], k3[1] - capTop);
            graphics.lineBetween(k3[0], k3[1] - capTop, k2[0], k2[1] - capTop);
        }
        // BROKEN PEDIMENT — two big mirrored wedge prisms spanning the full
        // slab depth, rising toward twin peaks that flank a central slot of
        // open sky (the split-pediment "M" silhouette). Bold shapes only —
        // small horn triangles read as cracks at this scale (rejected look).
        // Pre-L4 the slot is a narrow notch; the FULL wide break + floating
        // gem arrive at L4.
        const aFrac = level >= 4 ? 0.38 : 0.44;       // prism share of the edge
        const lowH = 2.2;                             // outer-corner height
        const pedH = level >= 4 ? 6.5 + (sz - 4) * 0.6 : 4.2 + level * 0.4;
        const hiH = lowH + pedH;                      // peak height at the slot
        const m1 = mixPt(k4, k3, aFrac);              // left prism inner edge
        const m1n = mixPt(k1, k2, aFrac);
        const m2 = mixPt(k4, k3, 1 - aFrac);          // right prism inner edge
        const m2n = mixPt(k1, k2, 1 - aFrac);
        const PT = (pt: Pt, h: number): Pt => [pt[0], pt[1] - capTop - h];
        // LEFT prism (west): SW face, top slope, inner cut facing the slot.
        quad(graphics, [PT(m1, 0), PT(m1n, 0), PT(m1n, hiH), PT(m1, hiH)], M.colDark, alpha);
        quad(graphics, [PT(k4, lowH), PT(m1, hiH), PT(m1n, hiH), PT(k1, lowH)], M.top, alpha);
        quad(graphics, [PT(k4, 0), PT(m1, 0), PT(m1, hiH), PT(k4, lowH)], M.lit, alpha);
        // RIGHT prism (south): SE end face, top slope, SW face.
        quad(graphics, [PT(k3, 0), PT(k2, 0), PT(k2, lowH), PT(k3, lowH)], M.dark, alpha);
        quad(graphics, [PT(m2, hiH), PT(k3, lowH), PT(k2, lowH), PT(m2n, hiH)], M.top, alpha);
        quad(graphics, [PT(m2, 0), PT(k3, 0), PT(k3, lowH), PT(m2, hiH)], M.lit, alpha);
        // Raking cornices up the SW faces — the crown's material ladder:
        // stone → burnished bronze (L6-7) → gold (Mastery).
        graphics.lineStyle(1.1, sandstone ? gold : level >= 6 ? BR.lit : M.seam, alpha * 0.95);
        graphics.lineBetween(k4[0], k4[1] - capTop - lowH, m1[0], m1[1] - capTop - hiH);
        graphics.lineBetween(m2[0], m2[1] - capTop - hiH, k3[0], k3[1] - capTop - lowH);
        // Inner cut edges of the slot.
        graphics.lineStyle(1, M.seam, alpha * 0.7);
        graphics.lineBetween(m1[0], m1[1] - capTop, m1[0], m1[1] - capTop - hiH);
        graphics.lineBetween(m2[0], m2[1] - capTop, m2[0], m2[1] - capTop - hiH);
        // The gem floating in the slot (gold orb at the top tiers).
        const gm = mixPt(m1, m2, 0.5);
        if (level >= 4) {
            const gemY = gm[1] - capTop - hiH * 0.62;
            // Soft halo so the gem carries against the slot's dark cut face.
            graphics.fillStyle(F.glow, alpha * (0.3 + 0.1 * ph(2, 2.6)));
            graphics.fillCircle(gm[0], gemY, 3.6);
            if (level >= 7) {
                graphics.fillStyle(gold, alpha);
                graphics.fillCircle(gm[0], gemY, 2.2);
                graphics.fillStyle(0xffffff, alpha * 0.95);
                graphics.fillCircle(gm[0] - 0.6, gemY - 0.6, 0.8);
            } else {
                graphics.fillStyle(F.body, alpha * (0.8 + 0.15 * ph(2, 2.6)));
                graphics.fillCircle(gm[0], gemY, 2.0);
                graphics.fillStyle(F.core, alpha);
                graphics.fillCircle(gm[0], gemY, 0.9);
            }
        }
    }

    // ---- BRAZIERS — arcane flames flanking the door ----------------------
    const brazier = (side: number, phase: number): void => {
        const s = 0.82 + sz * 0.045;
        const base = dpOut(side * (doorHw + 8), 0, 8);
        const bx = base[0];
        const by = base[1];
        // Plinth + fluted stem + bowl.
        quad(graphics, [[bx - 2.6 * s, by], [bx + 2.6 * s, by], [bx + 2.2 * s, by - 1.5], [bx - 2.2 * s, by - 1.5]], M.dark, alpha);
        quad(graphics, [[bx - 1.2 * s, by - 1.5], [bx + 1.2 * s, by - 1.5], [bx + 1.2 * s, by - 1.5 - 4.6 * s], [bx - 1.2 * s, by - 1.5 - 4.6 * s]], M.colDark, alpha);
        const bowlY = by - 1.5 - 4.6 * s;
        graphics.fillStyle(BR.shade, alpha);
        graphics.fillEllipse(bx, bowlY - 1.2 * s, 7.4 * s, 3.4 * s);
        graphics.fillStyle(BR.lit, alpha);
        graphics.fillEllipse(bx, bowlY - 2.0 * s, 6.6 * s, 1.8 * s);
        // Flame: k=2 / k=3 harmonic licks (amplitudes survive quantization).
        const fy = bowlY - 2.2 * s;
        const h1 = s * (5.0 + 1.4 * ph(2, phase));
        const h2 = s * (7.2 + 1.8 * ph(2, phase + 0.7) + 1.0 * ph(3, phase + 1.9));
        const h3 = s * (3.6 + 1.1 * ph(3, phase + 0.5));
        graphics.fillStyle(F.glow, alpha * (0.15 + 0.05 * ph(2, phase + 0.3)));
        graphics.fillEllipse(bx, fy - h1 * 0.4, s * 11, s * 7);
        graphics.fillStyle(F.deep, alpha * 0.9);
        graphics.fillEllipse(bx, fy - h1 * 0.5, s * 4.6, h1);
        graphics.fillStyle(F.body, alpha * 0.95);
        graphics.fillEllipse(bx + 0.5 * ph(1, phase + 1.2), fy - h2 * 0.5, s * 3.2, h2);
        graphics.fillStyle(F.core, alpha * 0.95);
        graphics.fillEllipse(bx + 0.35 * ph(2, phase + 2.1), fy - h3 * 0.55, s * 1.6, h3);
    };
    brazier(-1, 0);
    brazier(1, 2.4);
}
