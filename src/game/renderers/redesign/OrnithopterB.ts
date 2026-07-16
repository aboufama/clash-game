import type Phaser from 'phaser';

type G = Phaser.GameObjects.Graphics;

/**
 * ORNITHOPTER — design B: "Codice del Volo".
 *
 * A da-Vinci codex study made real: a slim walnut skiff hull with a prone
 * pilot at the cranks, two great scalloped parchment bat-wings on jointed
 * spars (the outer segment lags the inner — the codex figure-8), a fan tail
 * that flutters on the beat's second harmonic, a spinning crank flywheel,
 * and iron bombs slung in rope cradles under the keel. Altitude reads three
 * ways: the hull floats ~46 px above the anchor, a detached machine-shaped
 * ground shadow breathes with the wing beat, and the body bobs on the lift
 * stroke.
 *
 * Motion contract (bake TROOP_PARAMS ornithopter: stride 500 / idleMs 500 /
 * dirs 8 / attack:false): ONE 500 ms clock drives everything — wing flap,
 * body bob, tail flutter (2nd harmonic), flywheel spin, fuse spark (4th
 * harmonic). Moving = deep attack-run beat + nose-down pitch; idle = hover
 * with a shallower, higher-held beat. All terms are sin(k·phi + c) with
 * integer k, so both loops close EXACTLY on 500 ms (a 250 ms multiple) and
 * survive quantization (wing-tip swing well over ±5 px even at idle).
 *
 * Levels: L1 raw linen + timber · L2 waxed-leather membrane + iron fittings
 * + a second bomb · L3 parchment-cream membrane with a gilded leading spar,
 * small gold wing roundels, gold bomb bands and a tail pennant (gold as
 * accent only, per the max-level rule). Enemy palette = whole kit shaded
 * ×0.72 (the roster convention).
 *
 * facingAngle is a screen-space radian heading; all geometry runs through
 * the §6 iso toolkit (w projects with the 0.5 squash, h is unsquashed), so
 * every one of the 8 baked headings is the same continuous math. Aim-aware
 * layering: far wing by sign of cos(a), tail fan by sign of sin(a). Bombs
 * are MainScene projectiles (released at anchor −34 ≈ this hull's belly),
 * so attackAge/attackDelay are deliberately unused — vector and bake can
 * never disagree.
 */

const FLAP_MS = 500;
const K = 1.4; // machine-space scale — a 15-space flying bomber has presence

/** Multiply a 0xRRGGBB colour toward dark (m<1) or light (m>1). */
function shade(c: number, m: number): number {
    const r = Math.max(0, Math.min(255, Math.round(((c >> 16) & 0xff) * m)));
    const g = Math.max(0, Math.min(255, Math.round(((c >> 8) & 0xff) * m)));
    const b = Math.max(0, Math.min(255, Math.round((c & 0xff) * m)));
    return (r << 16) | (g << 8) | b;
}

/** One closed filled polygon (screen points). */
function poly(g: G, pts: number[][], color: number, alpha: number): void {
    g.fillStyle(color, alpha);
    g.beginPath();
    g.moveTo(pts[0][0], pts[0][1]);
    for (let i = 1; i < pts.length; i++) g.lineTo(pts[i][0], pts[i][1]);
    g.closePath();
    g.fillPath();
}

/** Spar/rope segment — thickness along the screen-space normal (guide §6). */
function spar(g: G, color: number, x0: number, y0: number, x1: number, y1: number, w: number, alpha = 1): void {
    const dx = x1 - x0, dy = y1 - y0;
    const len = Math.hypot(dx, dy) || 1;
    const nx = (-dy / len) * (w / 2), ny = (dx / len) * (w / 2);
    g.fillStyle(color, alpha);
    g.beginPath();
    g.moveTo(x0 + nx, y0 + ny);
    g.lineTo(x1 + nx, y1 + ny);
    g.lineTo(x1 - nx, y1 - ny);
    g.lineTo(x0 - nx, y0 - ny);
    g.closePath();
    g.fillPath();
}

export function drawOrnithopterB(
    graphics: Phaser.GameObjects.Graphics,
    isPlayer: boolean,
    isMoving: boolean,
    facingAngle: number,
    troopLevel: number,
    time: number,
    _attackAge: number,
    _attackDelay: number,
    _driver: number
): void {
    const g = graphics;
    const lv = Math.max(1, Math.min(3, Math.floor(troopLevel || 1)));
    const own = isPlayer ? 1 : 0.72; // enemy kits darken (roster convention)
    const sh = (c: number, m = 1) => shade(c, m * own);

    // ---- level palette -------------------------------------------------
    const mem = sh(lv === 1 ? 0xc9ae7e : lv === 2 ? 0xb2946a : 0xdcd3ba); // membrane
    const memRib = sh(lv === 1 ? 0x8a6f46 : lv === 2 ? 0x77603c : 0x9c9075);
    const wood = sh(lv === 1 ? 0x7a5531 : lv === 2 ? 0x64452a : 0x6b4a2e);
    const woodD = sh(lv === 1 ? 0x53381f : lv === 2 ? 0x452e19 : 0x4a3320);
    const deck = sh(lv === 1 ? 0xa8834f : lv === 2 ? 0x937048 : 0x9c7a4a);
    const rope = sh(lv === 2 ? 0x93794c : 0xa08454);
    const iron = sh(lv >= 2 ? 0x596069 : 0x4a4f57);
    const gold = sh(0xdaa520);
    const sparLead = lv === 3 ? gold : wood; // gilded leading spar at max

    // ---- the ONE 500 ms clock -------------------------------------------
    const ph = ((time % FLAP_MS) / FLAP_MS) * Math.PI * 2;
    // Jointed flap: outer wing segment lags the inner by a fixed phase, and
    // a 2nd harmonic snaps the downstroke — every term closes on 500 ms.
    // Mean angle stays LOW so the wing pair always reads laterally.
    const flapAt = (lag: number): number => isMoving
        ? 0.02 + 0.55 * Math.sin(ph - lag) + 0.18 * Math.sin(2 * (ph - lag) + 1.1)
        : 0.16 + 0.30 * Math.sin(ph - lag) + 0.08 * Math.sin(2 * (ph - lag) + 1.1);
    const thI = flapAt(0);      // inner segment (shoulder→elbow)
    const thO = flapAt(0.55);   // outer segment (elbow→tip), lagging
    const bob = (isMoving ? 2.2 : 1.4) * Math.sin(ph - 2.2); // lift-stroke bounce

    // ---- machine space → screen (guide §6 toolkit) ----------------------
    // d = forward along the aim, w = starboard, h = up (unsquashed);
    // everything scales by K once, right here.
    const ca = Math.cos(facingAngle), sa = Math.sin(facingAngle);
    const GY = 9.5;                       // ground plane (roster convention)
    const hullH = 46 + bob;               // hull centerline altitude
    const pitch = isMoving ? 0.09 : 0.02; // nose-down on the attack run
    const PT = (d: number, w: number, h: number): number[] => [
        (ca * d - sa * w) * K,
        GY + (sa * d + ca * w) * 0.5 * K - (hullH + (h - d * pitch) * K)
    ];

    // ---- wing rig --------------------------------------------------------
    const SP = 15;            // lateral span beyond the shoulder
    const EL = SP * 0.45;     // elbow joint distance
    const cI = Math.cos(thI), sI = Math.sin(thI);
    const cO = Math.cos(thO), sO = Math.sin(thO);
    const wingLat = (ll: number) => (ll <= EL ? ll * cI : EL * cI + (ll - EL) * cO);
    const wingH = (ll: number) => (ll <= EL ? ll * sI : EL * sI + (ll - EL) * sO);
    // Wing-space (dd = machine-forward, ll = lateral from shoulder) → screen.
    const WP = (dd: number, ll: number, s: number): number[] =>
        PT(dd, s * (3.0 + wingLat(ll)), 2.4 + wingH(ll));

    // Bat membrane outline (dd, ll): leading edge → tip → scalloped trail.
    const MEM: Array<[number, number]> = [
        [4.6, 0], [3.4, EL], [1.6, SP],           // leading edge out to the tip
        [-0.6, SP * 0.80], [-2.0, SP * 0.62],      // scallop 1
        [-2.8, SP * 0.44], [-3.8, SP * 0.27],      // scallop 2
        [-3.2, 0.8]                                // trailing root
    ];

    const drawWing = (s: number, far: boolean): void => {
        const fade = far ? 0.88 : 1;
        // Membrane brightness follows the stroke: flat wing catches the light.
        const lit = 0.84 + 0.20 * Math.max(cI, 0);
        const pts = MEM.map(([dd, ll]) => WP(dd, ll, s));
        poly(g, pts, shade(mem, lit * fade), 1);
        // L3: a small gold roundel on the membrane (subtle accent).
        if (lv === 3) {
            const r0 = WP(0.4, SP * 0.46, s);
            g.fillStyle(shade(gold, fade), 1);
            g.fillCircle(r0[0], r0[1], 2.2);
        }
        // Finger spars from the elbow along the scallop peaks.
        const elbow = WP(3.2, EL * 0.98, s);
        const f2 = WP(-2.0, SP * 0.62, s);
        const f3 = WP(-3.8, SP * 0.27, s);
        spar(g, shade(memRib, fade), elbow[0], elbow[1], f2[0], f2[1], 1.0);
        spar(g, shade(memRib, fade), elbow[0], elbow[1], f3[0], f3[1], 1.0);
        // Leading spar: shoulder → elbow → tip (gilded at L3).
        const root = WP(4.6, 0, s);
        const lead = WP(3.4, EL, s);
        const tip = WP(1.6, SP, s);
        spar(g, shade(sparLead, fade), root[0], root[1], lead[0], lead[1], 1.9);
        spar(g, shade(sparLead, fade), lead[0], lead[1], tip[0], tip[1], 1.5);
        // L2+: iron claw cap on the wing tip.
        if (lv >= 2) {
            g.fillStyle(shade(iron, fade), 1);
            g.fillCircle(tip[0], tip[1], 1.2);
        }
        // Shoulder pivot knuckle.
        const piv = WP(3.8, 0.5, s);
        g.fillStyle(shade(woodD, fade), 1);
        g.fillCircle(piv[0], piv[1], 1.5);
    };

    // ---- ground shadow: soft detached 2:1 ellipse (the CoC air-unit read).
    // It tracks the wing reach, contracting as the wings fold and the body
    // lifts on the beat — the altitude cue.
    {
        const reach = (3.0 + wingLat(SP)) * 2 * K * 0.72;
        const w = Math.max(24, reach) * (1 - bob * 0.012);
        g.fillStyle(0x000000, 0.14);
        g.fillEllipse(0, GY + 0.5, w, w * 0.5);
    }

    // ---- aim-aware layering ---------------------------------------------
    const nearSide = ca >= 0 ? 1 : -1; // wing whose across-aim y is down-screen
    drawWing(-nearSide, true);         // far wing behind everything

    // Tail fan (fan of slats behind the hull, 2nd-harmonic flutter).
    const drawTail = (): void => {
        const flut = 0.7 * Math.sin(2 * ph + 0.6);
        const tp = PT(-9.3, 0, 1.1);
        const tL = PT(-15.3, -4.6, 0.5 + flut);
        const tM = PT(-16.4, 0, 1.1 + flut * 1.3);
        const tR = PT(-15.3, 4.6, 0.5 + flut);
        poly(g, [tp, tL, tM, tR], shade(mem, 0.94), 1);
        spar(g, woodD, tp[0], tp[1], tL[0], tL[1], 1.0);
        spar(g, woodD, tp[0], tp[1], tM[0], tM[1], 1.0);
        spar(g, woodD, tp[0], tp[1], tR[0], tR[1], 1.0);
        // L3: a small gold pennant streaming off the tail post.
        if (lv === 3) {
            const p0 = PT(-9.5, 0, 2.8);
            const p1 = PT(-12.6, 0, 2.8 + 0.5 * Math.sin(2 * ph));
            poly(g, [p0, [p1[0], p1[1] - 1.2], [p1[0], p1[1] + 1.2]], gold, 1);
        }
    };
    if (sa > 0) drawTail(); // aim points down-screen → tail is up-screen (far)

    // ---- hull: walnut skiff silhouette (reads from every heading) --------
    {
        const N = PT(11.4, 0, 0.9);    // pointed prow
        const T = PT(-9.5, 0, 0.8);    // stern
        const hullPts = [
            N, PT(5, 0, 1.6), PT(-3, 0, 1.5), T,
            PT(-4.5, 0, -2.2), PT(0.5, 0, -3.6), PT(5.5, 0, -2.4)
        ];
        poly(g, hullPts, sh(0x6e4c2c), 1);
        // Deck line (light) + keel line (dark) for volume.
        spar(g, deck, N[0], N[1], T[0], T[1], 1.7);
        const k0 = PT(6.5, 0, -1.9), k1 = PT(-3.8, 0, -1.8);
        spar(g, woodD, k0[0], k0[1], k1[0], k1[1], 1.5);
        // Rib bands across the hull.
        for (const d of [4, 0, -4]) {
            const a0 = PT(d, 0, 1.3), a1 = PT(d, 0, -2.8);
            spar(g, woodD, a0[0], a0[1], a1[0], a1[1], 1.0);
        }
        // L2+: an iron strake riveted along the belly.
        if (lv >= 2) {
            const s0 = PT(5.8, 0, -2.6), s1 = PT(-4, 0, -2.3);
            spar(g, iron, s0[0], s0[1], s1[0], s1[1], 1.1);
        }
        // L3: gilded prow tip (subtle max-level accent).
        if (lv === 3) {
            g.fillStyle(gold, 1);
            g.fillCircle(N[0], N[1], 1.0);
        }
        // Wing pivot crossbar between the shoulders.
        const xL = PT(3.5, -3.0, 2.3), xR = PT(3.5, 3.0, 2.3);
        spar(g, woodD, xL[0], xL[1], xR[0], xR[1], 1.4);
        // Crank flywheel — one revolution per beat.
        const G0 = PT(-1.5, 0, -0.3);
        g.fillStyle(lv >= 2 ? iron : woodD, 1);
        g.fillCircle(G0[0], G0[1], 3.1);
        for (let k = 0; k < 2; k++) {
            const a = ph + k * Math.PI * 0.5;
            spar(
                g, sh(0xc9b083),
                G0[0] - Math.cos(a) * 2.7, G0[1] - Math.sin(a) * 1.35,
                G0[0] + Math.cos(a) * 2.7, G0[1] + Math.sin(a) * 1.35,
                0.9
            );
        }
        // Prone pilot: hips → shoulders capsule, capped head peering forward
        // (set clearly aft of the prow so the nose stays a clean point).
        const hips = PT(0.2, 0, 2.4), sho = PT(3.0, 0, 2.8);
        const tunic = sh(lv === 3 ? 0xbfb49a : 0x8d6f4a);
        spar(g, tunic, hips[0], hips[1], sho[0], sho[1], 4.0);
        g.fillStyle(tunic, 1);
        g.fillCircle(hips[0], hips[1], 2.1);
        g.fillCircle(sho[0], sho[1], 2.0);
        const hd = PT(4.6, 0, 3.4);
        g.fillStyle(sh(0xd9a877), 1);
        g.fillCircle(hd[0], hd[1], 1.9);
        g.fillStyle(sh(0x5b3d24), 1);
        g.beginPath();
        g.arc(hd[0], hd[1] - 0.4, 1.9, Math.PI, 0, false);
        g.closePath();
        g.fillPath();
    }

    if (sa <= 0) drawTail(); // aim points up-screen → tail hangs down-screen

    // ---- the payload: iron bombs in rope cradles under the keel ----------
    const drawBomb = (d: number, h: number, r: number): void => {
        const B = PT(d, 0, h);
        // Rope V from the hull belly to the shackle.
        const r0 = PT(d + 1.7, 1.6, -3.0), r1 = PT(d + 1.7, -1.6, -3.0);
        spar(g, rope, r0[0], r0[1], B[0], B[1] - r + 0.4, 0.85);
        spar(g, rope, r1[0], r1[1], B[0], B[1] - r + 0.4, 0.85);
        // Iron sphere: dark rim → body → NW glint → strap band.
        g.fillStyle(sh(0x23262b), 1);
        g.fillCircle(B[0], B[1], r + 0.8);
        g.fillStyle(sh(0x41464e), 1);
        g.fillCircle(B[0], B[1], r);
        g.fillStyle(sh(0x6a7078), 1);
        g.fillEllipse(B[0] - r * 0.35, B[1] - r * 0.4, r * 0.8, r * 0.55);
        g.fillStyle(sh(0x1c1f24), 1);
        g.fillRect(B[0] - r * 0.9, B[1] - 0.7, r * 1.8, 1.4);
        if (lv === 3) {
            g.fillStyle(gold, 1);
            g.fillRect(B[0] - r * 0.9, B[1] - 0.3, r * 1.8, 0.6);
        }
        // Fuse stub + spark winking on the 4th harmonic (still a 500 ms term).
        g.fillStyle(sh(0x2e2620), 1);
        g.fillRect(B[0] - 0.6, B[1] - r - 2.0, 1.2, 2.0);
        g.fillStyle(sh(0xffcf6f), 0.5 + 0.5 * Math.sin(4 * ph));
        g.fillCircle(B[0], B[1] - r - 2.4, 1.0);
    };
    if (lv >= 2) drawBomb(-5.0, -6.0, 3.0); // aft rack bomb first (behind)
    drawBomb(0.7, -7.4, lv === 1 ? 4.0 : 4.4);

    drawWing(nearSide, false); // near wing sweeps in front of everything
}
