import type Phaser from 'phaser';

type G = Phaser.GameObjects.Graphics;

/**
 * ORNITHOPTER — design C: "The Rowing Gull", a da Vinci sky-skiff.
 *
 * A slender wooden skiff hull hangs in the air under two great bat-membrane
 * wings that ROW — a quick snapping downstroke and a slow feathered recovery
 * (the asymmetry is a phase warp, still EXACTLY periodic). A pilot amidships
 * works a windlass crank that drives the wing spars through control cables
 * from an A-frame pylon; a fan tail steers; iron bombs hang from an
 * under-keel rack (1/2/3 by level). Altitude reads through the detached
 * ground shadow ~34 px below the keel — drawn as a texel-grid-aligned 50%
 * checker dither at FULL alpha so the bake's alpha-snap (<50% -> erased)
 * cannot delete it.
 *
 * ANIMATION CONTRACT (bake samples these exact windows — TROOP_PARAMS
 * ornithopter: stride 500, idleMs 500, dirs 8, attack:false):
 *  - FLAP/stride loop:  500 ms (one wingbeat; walk = full row stroke)
 *  - IDLE hover loop:   500 ms (same rig, shallower stroke + 1 px bob)
 *  - Crank + pennant:   250 ms (exact 2nd harmonic — two turns per beat)
 * All motion is a deterministic f(time); attackAge only gates the
 * vector-fallback bomb-release choreography (bombs are projectiles — the
 * bake never captures attack frames, so baked frames are attackAge -1).
 *
 * ENVELOPE (non-`big` troop capture box x [-32,32], y [-38,20]):
 * hull center y=-24 (MainScene releases the bomb at -34 = the pylon line),
 * wing planar half-span 20 -> worst tip top ~-36.2 (heading east, wings up,
 * crest of the bob); shadow bottom ~+18. Everything stays inside the box.
 */

const FLAP_MS = 500;   // wingbeat — must equal TROOP_PARAMS.ornithopter.stride
                       // (the 500 ms idle hover loop rides the same clock,
                       //  matching TROOP_PARAMS.ornithopter.idleMs = 500)
const CRANK_MS = 250;  // windlass + pennant, exact harmonic of the beat

const TAU = Math.PI * 2;
const GROUND_Y = 9.5;       // troop-local ground line (the villager rule)
const ALTITUDE = 33;        // keel height above the ground line
const CELL = 1.35;          // bake texel size (world px)
const BOX_MIN_X = -32;      // non-big troop capture box (bake-sprites.mjs)
const BOX_MIN_Y = -38;

/** Multiply a 0xRRGGBB colour toward dark (m<1) or light (m>1). */
function shade(c: number, m: number): number {
    const r = Math.max(0, Math.min(255, Math.round(((c >> 16) & 0xff) * m)));
    const g = Math.max(0, Math.min(255, Math.round(((c >> 8) & 0xff) * m)));
    const b = Math.max(0, Math.min(255, Math.round((c & 0xff) * m)));
    return (r << 16) | (g << 8) | b;
}

export function drawOrnithopterC(
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
    const L = Math.max(1, Math.min(3, Math.floor(troopLevel || 1)));

    // ---------------- palette (wood body; owner colour on canvas/pennant;
    // L3 gold stays a subtle accent per the max-level rule) ----------------
    const wmul = isPlayer ? 1 : 0.88; // enemy craft: weathered darker timber
    const deckCol = shade([0xb9945f, 0xa8834f, 0xb28c58][L - 1], wmul);
    const sideCol = shade([0x83643c, 0x6e5233, 0x7a5a36][L - 1], wmul);
    const keelCol = shade(0x4e3a22, wmul);
    const sparCol = shade([0x6a4e2c, 0x59422a, 0x64512e][L - 1], wmul);
    const membCol = shade([0xe8dcbc, 0xdccfae, 0xece2c6][L - 1], isPlayer ? 1 : 0.92);
    const ownCol = isPlayer ? 0x4c76b2 : 0xa93c34;           // dyed outer wing bay
    const ownBright = isPlayer ? 0x6c94cc : 0xc25046;        // pennant / trim
    const ropeCol = shade(0xb09a6e, wmul);
    const ironCol = 0x4a505a;
    const bombCol = 0x3e434c;
    const goldCol = 0xdaa520;
    const skinCol = 0xd8a878;
    const shadowCol = 0x2f4224; // dark lawn-green contact-shadow tone

    // ---------------- the rig: heading + iso projection ----------------
    // facing is the ground-plane azimuth; planar (along a, across c) offsets
    // project with the 0.5 iso vertical squash, height v subtracts straight
    // from screen y.
    const axX = Math.cos(facingAngle), axY = Math.sin(facingAngle) * 0.5;
    const qxX = -Math.sin(facingAngle), qxY = Math.cos(facingAngle) * 0.5;

    // ---------------- wingbeat (exact 500 ms) ----------------
    const phi = ((((time % FLAP_MS) + FLAP_MS) % FLAP_MS) / FLAP_MS) * TAU;
    const phiC = ((((time % CRANK_MS) + CRANK_MS) % CRANK_MS) / CRANK_MS) * TAU;
    // Stroke warp: fast leaving the top (the snap-down), slow recovery.
    // phi + k*sin(phi) is still exactly 2*pi periodic -> 500 ms loop closes.
    const warp = (x: number): number => x + 0.55 * Math.sin(x);
    // The stroke NEVER rises above the root plane: the top of the beat is a
    // flat full-span glide (the strongest silhouette), the bottom a deep
    // row — and the flat ceiling is what lets the span reach 25 planar px
    // inside the capture box.
    const mid = isMoving ? -0.27 : -0.16;   // hover keeps a shallow paddle
    const amp = isMoving ? 0.27 : 0.16;
    const th1 = mid + amp * Math.cos(warp(phi));          // inner spar
    const th2 = mid + amp * Math.cos(warp(phi - 0.9));    // outer spar lags
    // Vertical gain eases the DOWN reach so the deep stroke never wraps
    // under the hull (pure reshaping — same period, no randomness).
    const vs = (t: number): number => Math.sin(t) * (t < 0 ? 0.5 : 1);
    const bob = (isMoving ? 1.5 : 1.0) * Math.sin(phi - 2.2); // lift chases the downbeat
    const hullY = GROUND_Y - ALTITUDE + bob;

    /** Planar (a=along heading, c=across) + height v -> screen point. */
    const P = (a: number, c: number, v: number): [number, number] =>
        [a * axX + c * qxX, hullY + a * axY + c * qxY - v];

    const poly = (pts: number[][], color: number, alpha = 1): void => {
        g.fillStyle(color, alpha);
        g.beginPath();
        g.moveTo(pts[0][0], pts[0][1]);
        for (let i = 1; i < pts.length; i++) g.lineTo(pts[i][0], pts[i][1]);
        g.closePath();
        g.fillPath();
    };
    const seg = (p1: number[], p2: number[], w: number, color: number, alpha = 1): void => {
        g.lineStyle(w, color, alpha);
        g.beginPath();
        g.moveTo(p1[0], p1[1]);
        g.lineTo(p2[0], p2[1]);
        g.strokePath();
    };

    // ================= 1. detached ground shadow (altitude read) =========
    // Texel-grid-aligned checker dither at alpha 1: every second bake texel
    // is solid shadow, the rest stay grass — reads as a soft 50% shadow but
    // survives the alpha-snap. The ellipse tracks wing extension so the
    // shadow breathes with the beat.
    const ext01 = (3.2 + 13 * Math.cos(th1) + 11 * Math.cos(th2)) / 27.2; // ~0.8..1
    const shA = 13;                    // planar radius along heading
    const shB = 3 + 15 * ext01;        // planar radius across (the wings)
    const cosF = Math.cos(facingAngle), sinF = Math.sin(facingAngle);
    g.fillStyle(shadowCol, 1);
    const iLo = Math.floor((-(shA + shB) - BOX_MIN_X) / CELL);
    const iHi = Math.ceil(((shA + shB) - BOX_MIN_X) / CELL);
    const jLo = Math.floor((GROUND_Y - (shA + shB) * 0.5 - BOX_MIN_Y) / CELL);
    const jHi = Math.ceil((GROUND_Y + (shA + shB) * 0.5 - BOX_MIN_Y) / CELL);
    for (let j = jLo; j <= jHi; j++) {
        if ((BOX_MIN_Y + (j + 0.5) * CELL) > 19) continue; // stay inside the box
        for (let i = iLo; i <= iHi; i++) {
            if (((i + j) & 1) !== 0) continue; // 50% checker
            const cx = BOX_MIN_X + (i + 0.5) * CELL;
            const cy = BOX_MIN_Y + (j + 0.5) * CELL;
            const dx = cx, dy = (cy - GROUND_Y) * 2; // un-squash to the plane
            const u = dx * cosF + dy * sinF;
            const w = -dx * sinF + dy * cosF;
            if ((u * u) / (shA * shA) + (w * w) / (shB * shB) > 1) continue;
            g.fillRect(cx - CELL / 2, cy - CELL / 2, CELL, CELL);
        }
    }

    // ================= wing builder =================
    // ONE bold membrane plane per wing (fewer, bolder shapes): the spar is
    // the leading edge, the trailing edge sweeps aft nearly IN the wing
    // plane (shallow sag only — deep sag read as draped laundry), with two
    // scallop notches tucked toward the spar for the bat-wing signature.
    const drawWing = (s: number, far: boolean): void => {
        const mC = shade(membCol, far ? 0.84 : 1);
        const oC = shade(ownCol, far ? 0.86 : 1);
        const billow01 = 0.5 + 0.5 * Math.sin(phi - 1.1); // 0..1 sag chase
        const sag = 0.5 + 0.9 * billow01;
        // Wing-plane projection cheat: the wings' across-axis uses a FLATTER
        // squash (0.72 * the iso 0.5) so the wing plane reads as a soaring
        // surface at diagonal headings instead of a banking curtain.
        const PW = (a: number, c: number, v: number): [number, number] =>
            [a * axX + c * qxX, hullY + a * axY + c * qxY * 0.72 - v];
        // spar joints (planar across c grows outward; v is height).
        // Roots sit ON the deck line at the gunwale (parasol wing) so the
        // membrane never drapes over the deck.
        const rV = 1;
        const eC = s * (3.2 + 13 * Math.cos(th1)), eV = rV + 13 * vs(th1), eA = 4.5;
        const tC = s * (3.2 + 13 * Math.cos(th1) + 11 * Math.cos(th2)), tV = eV + 11 * vs(th2), tA = 2.0;
        const leadRoot = PW(4.2, s * 3.2, rV + 0.4);
        const elbow = PW(eA, eC, eV);
        const tip = PW(tA, tC, tV);
        // trailing edge, tip -> root: shallow sag + scallop tucks
        const tTip = PW(tA - 5, tC * 0.99, tV - sag * 0.6);
        const scal1 = PW(tA - 4.4, eC + (tC - eC) * 0.52, (eV + tV) / 2 - sag * 0.4);
        const tMid = PW(eA - 9, eC * 0.92, eV - sag);
        const scal2 = PW(-3, s * 3.1 + (eC - s * 3.1) * 0.5, (rV + eV) / 2 - sag * 0.7);
        const tRoot = PW(-4.2, s * 3.0, rV - 0.4);
        poly([leadRoot, elbow, tip, tTip, scal1, tMid, scal2, tRoot], mC);
        // outer bay dyed in the owner colour — the in-flight allegiance read
        poly([elbow, tip, tTip, scal1, tMid], oC);
        // batten along the inner scallop tuck
        seg(elbow, tMid, 1.0, shade(sparCol, 0.85));
        // main spar: bold leading edge
        seg(leadRoot, elbow, 1.7, sparCol);
        seg(elbow, tip, 1.5, shade(sparCol, 0.9));
        if (L === 3) { // one gold joint cap per wing — accents stay subtle
            g.fillStyle(goldCol, 1);
            g.fillCircle(elbow[0], elbow[1], 1.0);
        }
        // control cable from the pylon crown down to the elbow (the crank rig)
        seg(P(5, 0, 6.6), elbow, 0.9, ropeCol);
    };

    // ================= tail builder (fan + rudder nub + L3 pennant) ======
    const drawTail = (): void => {
        const slats = L >= 2 ? 4 : 3;
        for (let k = 0; k < slats; k++) {
            const off = (k - (slats - 1) / 2) / Math.max(1, (slats - 1) / 2); // -1..1
            const flut = 0.5 * Math.sin(phiC + k * 1.7);
            poly([
                P(-10.2, off * 1.1, 1.0),
                P(-17, off * 5 + flut * 0.4, 0.5 + flut * 0.3),
                P(-15.8, off * 2.9 + flut * 0.3, 0.0)
            ], shade(membCol, 0.96 - 0.08 * Math.abs(off)));
        }
        // rudder nub
        poly([P(-9.8, 0, 1.2), P(-13.2, 0, 3.4), P(-13.6, 0, 0.9)], sideCol);
        if (L === 3) { // owner pennant streaming off the rudder (250 ms flutter)
            const f1 = 0.8 * Math.sin(phiC + 0.4);
            const f2 = 0.8 * Math.sin(phiC + 1.7);
            seg(P(-13.2, 0, 3.2), P(-15.8, f1, 2.4 + f1 * 0.4), 1.2, ownBright);
            seg(P(-15.8, f1, 2.4 + f1 * 0.4), P(-18.3, f2, 1.6 + f2 * 0.5), 1.0, ownBright);
        }
    };

    // ================= painter's order by heading =================
    // Far wing = the up-screen side; tail is far when the craft flies
    // down-screen (axY > 0).
    const farSide = qxY < 0 ? 1 : -1;
    drawWing(farSide, true);
    const tailIsFar = axY > 0;
    if (tailIsFar) drawTail();

    // ================= hull: skiff band + deck + cockpit =================
    const dn = qxY >= 0 ? 1 : -1; // down-screen side shows its flank
    // visible flank (deck edge down to the keel)
    poly([
        P(11, 0, 1), P(7.5, dn * 2.9, 1), P(0, dn * 3.4, 1), P(-6.5, dn * 2.9, 1), P(-10.5, 0, 1),
        P(-10.5, 0, -3.2), P(-6.5, dn * 2, -2.8), P(0, dn * 2.4, -2.8), P(7.5, dn * 2, -2.8), P(11, 0, -3.2)
    ], sideCol);
    // keel shadow line
    seg(P(10.5, 0, -3), P(-10, 0, -3), 1.1, keelCol);
    // deck (top face, lightest — NW light)
    poly([
        P(11, 0, 2), P(7.5, 2.9, 2), P(0, 3.4, 2), P(-6.5, 2.9, 2), P(-10.5, 0, 2),
        P(-6.5, -2.9, 2), P(0, -3.4, 2), P(7.5, -2.9, 2)
    ], deckCol);
    // plank seams
    seg(P(9, 1.5, 2.05), P(-8, 1.3, 2.05), 0.8, shade(deckCol, 0.82));
    seg(P(9, -1.5, 2.05), P(-8, -1.3, 2.05), 0.8, shade(deckCol, 0.82));
    // bowsprit — the unmistakable "this end forward" spar
    seg(P(9, 0, 1.8), P(14.8, 0, 2.6), 1.2, sparCol);
    if (L >= 2) { // iron strap frames on the hull
        seg(P(6, 2.8, 2.1), P(6, -2.8, 2.1), 1.2, ironCol);
        seg(P(-4.5, 2.8, 2.1), P(-4.5, -2.8, 2.1), 1.2, ironCol);
    }
    if (L === 3) { // gilded prow curl + ridge sliver (subtle)
        seg(P(10.5, 0, 2.1), P(4, 0, 2.1), 0.9, goldCol);
        g.fillStyle(goldCol, 1);
        const prow = P(11.6, 0, 2.8);
        g.fillCircle(prow[0], prow[1], 1.2);
    }
    // cockpit well
    poly([P(3, 1.5, 2.1), P(3, -1.5, 2.1), P(-2.5, -1.5, 2.1), P(-2.5, 1.5, 2.1)], shade(sideCol, 0.45));

    // ================= pilot + windlass crank (250 ms) =================
    const lean = 0.7 * Math.sin(phi + 0.6);
    const chest = P(0.2 + lean * 0.3, 0, 4.2);
    g.fillStyle(shade(0x7a5c3a, wmul), 1);
    g.fillEllipse(chest[0], chest[1], 4.6, 5.2);
    const head = P(0.8 + lean * 0.4, 0, 6.9);
    g.fillStyle(skinCol, 1);
    g.fillCircle(head[0], head[1], 1.7);
    const cap = P(0.8 + lean * 0.4, 0, 7.6);
    g.fillStyle(ownCol, 1);
    g.fillEllipse(cap[0], cap[1], 2.6, 1.2);
    // windlass crank behind the pilot; the handle spins two turns per beat
    const hub = P(-3.2, 0, 3.6);
    const hx = hub[0] + Math.cos(phiC) * 1.6, hy = hub[1] + Math.sin(phiC) * 0.9;
    seg([hub[0] - (hx - hub[0]) * 0.5, hub[1] - (hy - hub[1]) * 0.5], [hx, hy], 1.1, ironCol);
    g.fillStyle(shade(skinCol, 0.95), 1);
    g.fillCircle(hx, hy, 0.9);
    seg([chest[0], chest[1] + 0.6], [hx, hy], 1.1, shade(0x7a5c3a, wmul * 0.9)); // working arm
    // A-frame pylon carrying the wing cables
    seg(P(6.2, 2.2, 2), P(5, 0, 7), 1.3, sparCol);
    seg(P(6.2, -2.2, 2), P(5, 0, 7), 1.3, sparCol);
    if (L >= 2) { g.fillStyle(L === 3 ? goldCol : ironCol, 1); const crown = P(5, 0, 7.2); g.fillCircle(crown[0], crown[1], 1.0); }

    // ================= bomb rack under the keel =================
    // Vector-fallback choreography: the next bomb swings aft through the
    // windup and vanishes for 220 ms after the release tick (the projectile
    // takes over). Baked frames sample attackAge = -1 -> full rack, static.
    const inCombat = attackAge >= 0 && attackDelay > 0;
    const rem = inCombat ? Math.max(0, attackDelay - attackAge) : Infinity;
    const swing = inCombat && rem <= 350 ? 1 - rem / 350 : 0;
    const dropped = inCombat && attackAge < 220;
    seg(P(3.5, 0, -4.8), P(-2.5, 0, -4.8), 1.1, ironCol); // rack bar
    const bombsA = L === 1 ? [0.5] : L === 2 ? [-1, 2] : [-1.8, 0.5, 2.8];
    for (let bi = 0; bi < bombsA.length; bi++) {
        const isNext = bi === bombsA.length - 1;
        if (isNext && dropped) { // empty sling swinging free
            seg(P(bombsA[bi], 0, -4.8), P(bombsA[bi] - 1.2, 0, -6.4), 0.9, ropeCol);
            continue;
        }
        const sw = isNext ? swing : 0;
        const ba = bombsA[bi] - 1.8 * sw, bv = -8.2 + 0.6 * sw;
        seg(P(bombsA[bi], 0, -4.8), P(ba, 0, bv + 1.4), 0.9, ropeCol);
        const bp = P(ba, 0, bv);
        g.fillStyle(bombCol, 1);
        g.fillCircle(bp[0], bp[1], 1.7);
        g.fillStyle(shade(bombCol, 1.7), 1);
        g.fillCircle(bp[0] - 0.6, bp[1] - 0.6, 0.55); // NW glint
        // (no per-bomb gold at L3 — the max-level accents stay on the frame)
    }

    if (!tailIsFar) drawTail();
    drawWing(-farSide, false);
}
