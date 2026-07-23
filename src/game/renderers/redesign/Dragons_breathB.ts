import type Phaser from 'phaser';
import type { DragonsBreathDesignFn } from './DesignRegistry';

/**
 * DRAGON'S BREATH — design B: "THE EMBER-WYRM RELIQUARY".
 *
 * CONCEPT. The village keeps a buried war-relic: the SHUT MOUTH of a bronze
 * dragon idol, flush with its basalt shrine collar. The whole cover is the
 * beast's face looking south — a low faceted skull-lid (verdigris-bitten
 * bronze, ember eye slits, swept horns, spine fins) biting down on a
 * charred-oak lower jaw, gilt fangs interlocked over a seam that leaks
 * furnace light. At battle entry the mouth OPENS: the lower jaw drops and
 * slides out into a flat fanged apron, the skull-lid rears back into a
 * glaring crest for the drama of the rise, and the battery screws up out of
 * the throat on a bronze turntable column — a big tilted launch crate whose
 * muzzle face is itself a fanged maw packed with a 4×4 grid of 16 red-nosed
 * festival rockets. As the box takes the stage the crest FOLDS BACK DOWN
 * (owner note 2026-07-22): over deploy 0.80→1 the skull sinks flush behind /
 * below the turntable rim — a low silhouette hugging the base, mostly
 * swallowed by the shaft collar — so the rotating battery never overlaps or
 * z-fights the head at ANY of the 16 bearings. The dragon's breath erupts
 * from inside its own opened mouth.
 *
 * SIM STATE (read-only, MainScene/DefenseSystem own every write):
 *  - building.deploy01 — 0 shut mouth … 1 risen battery (value arrives eased).
 *    Choreography: jaw opens over 0→0.45, skull rears 0.05→0.55, box rises
 *    0.28→1 with a settle clunk, skull folds/sinks flush behind the turntable
 *    over 0.80→1; the box holds a fixed south rise-bearing and performs its
 *    first mechanical slew onto the live aim over 0.90→1.
 *  - building.ballistaAngle — screen-space aim; box, trunnions and turntable
 *    ticks slew from it every draw (hard pod-ratchets included), never
 *    self-animated.
 *  - el = time − building.lastFireTime — volley clock: 16 tubes empty in
 *    serpentine order at the 50 ms launch cadence with a 95 ms muzzle flare
 *    and a recoil shudder per pod; bores cool to 1100; staggered refill
 *    1150→1550 so the el = 1600 bake sample equals the recovered idle.
 *    Stale/absent/negative clocks render fully recovered.
 *  - level — maxLevel 2, but THIS ROUND AUTHORS L1 ONLY; level 2 renders
 *    identical by design (tournament scope, noted in the report).
 *
 * AMBIENT: ONE period P = 2000 ms; every idle term is harmonic 1 of
 * ω = 2π/P — skull breath bob ±1.2 px, ember color swings (eyes, nostrils,
 * seam leak, maw tinge, portholes, furnace) at fixed alpha, crest-fin glint
 * chases (same frequency, spatial phase). No other frequencies exist.
 *
 * LAUNCH MOUTH: the muzzle-face center sits exactly at footprint-center
 * +12 px along aim (iso 0.5 y-factor) and 30 px up — matching MainScene's
 * DRAGONS_BREATH_MOUTH_FORWARD_PX / RISE_PX as shipped. No retune needed.
 *
 * Iron rules: base/elevated split (shadow + compact pad only on the base
 * pass), no ground plates, deterministic f(time), tint ignored (dedicated
 * route precedent), alpha multiplies every fill/stroke.
 */

type G = Phaser.GameObjects.Graphics;
type V2 = Phaser.Math.Vector2;

// ------------------------------------------------------------------ palette
const OAK = 0x38291c, OAK_LIT = 0x46331f, SEAM = 0x160e08;
const BRONZE = 0x7a6234, BRONZE_LIT = 0x9c7f45, BRONZE_DK = 0x51401f, BRONZE_EDGE = 0xc9a24b;
const VERD = 0x51796a, VERD_DK = 0x40614f;
const MAW = 0x180f0a;
const EMBER_DIM = 0x571806, EMBER_DEEP = 0x8a2408, EMBER = 0xe06818, EMBER_HI = 0xffa040;
const FLASH_CORE = 0xffe9b0;
const RED = 0xb0342a, RED_LIT = 0xd8564a;
const GILT = 0xd8b25a;
const PAD_TOP = 0x575046;
const COLLAR = 0x4a443d;
const SHADOW = 0x18220f;

// ------------------------------------------------------------------- timing
/** ONE ambient period (ms) — every idle term is harmonic 1 of this. */
const P = 2000;
const W = (Math.PI * 2) / P;

/** deploy01 choreography anchors (deploy01 arrives ALREADY eased). */
const JAW_DONE = 0.45;    // lower jaw fully dropped open
const SKULL_START = 0.05, SKULL_DONE = 0.55; // skull-lid rear-back window
const RISE_START = 0.28;  // box mouth crests the shaft rim
const SINK_START = 0.80;  // reared crest folds/sinks flush behind the drum
const AIM_BLEND = 0.90;   // box slews rise-bearing → live aim at the end
const RISE_BEARING = Math.PI / 2; // maw toward camera during the rise
const RISE_DEPTH = 36;

// ------------------------------------------------------- box geometry (px)
// Axis pinned so the muzzle-face CENTER is (d = +12, h = −30) — MainScene's
// launch mouth. Rear-face center (d = −28, h = −21.75). Half-width 22.
const HALF_W = 22;
const FACE_D_LO = 8.5, FACE_D_HI = 15.5;      // sheared (tilted-up) muzzle face
const FACE_H_LO = -18.5, FACE_H_HI = -41.5;
const REAR_D_LO = -26, REAR_D_HI = -30;
const REAR_H_LO = -10.5, REAR_H_HI = -33;

// -------------------------------------------------------------- pure helpers
function clamp01(v: number): number { return v < 0 ? 0 : v > 1 ? 1 : v; }
function mix(a: number, b: number, t: number): number { return a + (b - a) * t; }
function smooth01(t: number): number { const u = clamp01(t); return u * u * (3 - 2 * u); }
function lerpColor(a: number, b: number, t: number): number {
    const k = clamp01(t);
    const ar = (a >> 16) & 0xff, ag = (a >> 8) & 0xff, ab = a & 0xff;
    const br = (b >> 16) & 0xff, bg = (b >> 8) & 0xff, bb = b & 0xff;
    return (Math.round(ar + (br - ar) * k) << 16)
        | (Math.round(ag + (bg - ag) * k) << 8)
        | Math.round(ab + (bb - ab) * k);
}
function shade(c: number, f: number): number {
    const r = Math.min(255, Math.round(((c >> 16) & 0xff) * f));
    const g = Math.min(255, Math.round(((c >> 8) & 0xff) * f));
    const b = Math.min(255, Math.round((c & 0xff) * f));
    return (r << 16) | (g << 8) | b;
}
function fillPoly(g: G, pts: number[][], color: number, a: number): void {
    g.fillStyle(color, a);
    g.beginPath();
    g.moveTo(pts[0][0], pts[0][1]);
    for (let i = 1; i < pts.length; i++) g.lineTo(pts[i][0], pts[i][1]);
    g.closePath();
    g.fillPath();
}
function strokePoly(g: G, pts: number[][], w: number, color: number, a: number, close = true): void {
    g.lineStyle(w, color, a);
    g.beginPath();
    g.moveTo(pts[0][0], pts[0][1]);
    for (let i = 1; i < pts.length; i++) g.lineTo(pts[i][0], pts[i][1]);
    if (close) g.closePath();
    g.strokePath();
}
/** Serpentine tube order (launch index k → face row/col), bottom row first. */
function tubeCell(k: number): { row: number; col: number } {
    const row = k >> 2;
    const c = k & 3;
    return { row, col: row % 2 === 0 ? c : 3 - c };
}
/** Height of the box's top edge at axis distance d. */
function topH(d: number): number {
    return mix(FACE_H_HI, REAR_H_HI, (FACE_D_HI - d) / (FACE_D_HI - REAR_D_HI));
}
/** Height of the box's underside edge at axis distance d. */
function bottomH(d: number): number {
    return mix(FACE_H_LO, REAR_H_LO, (FACE_D_LO - d) / (FACE_D_LO - REAR_D_LO));
}

/**
 * Screen-space launch origin of serpentine tube `podIndex` (0-15) at display
 * bearing `ballistaAngle`, as an OFFSET from the footprint center — the
 * sim-side mirror of drawBattery's own maw-face math (fsq edge-on squash,
 * FD/FH shear, PT projection), so MainScene's pods depart from the exact
 * red noses the fire frames empty, at every one of the 16 bearings. Sampled
 * at full deploy (drop = 0) on the REST-geometry box — every baked frame
 * is rest geometry now; the launch recoil is a RUNTIME translate of the
 * box sprite surface (SpriteBank.dragonsBoxKick), which displaces the maw
 * a few px for a beat around each launch (accepted sliver: the flare and
 * boost separation hide it). The +2 / −1 nudge is drawBattery's
 * muzzle-flare anchor — the tube's exit rather than the recessed nose
 * disc. `behind` mirrors the draw's breech-visibility pick (sinA < 0.05):
 * the maw faces up-screen, so the departing rocket should depth-sort
 * BEHIND the battery until clear.
 */
export function dragonsBreathTubeOrigin(
    podIndex: number,
    ballistaAngle: number
): { x: number; y: number; behind: boolean } {
    const cosA = Math.cos(ballistaAngle), sinA = Math.sin(ballistaAngle);
    const fsq = mix(0.45, 1, smooth01((sinA + 0.5) / 0.65));
    const { row, col } = tubeCell(podIndex & 15);
    const d = 12 + (mix(9.5, 14.5, row / 3) - 12) * fsq + 2;
    const h = -30 + (mix(-21.8, -38.2, row / 3) + 30) * fsq - 1;
    const w = (col - 1.5) * 9.6;
    return {
        x: cosA * d - sinA * w,
        y: h + sinA * 0.5 * d + cosA * 0.5 * w,
        behind: sinA < 0.05
    };
}

export function drawDragonsBreathB(
    graphics: Phaser.GameObjects.Graphics,
    c1: Phaser.Math.Vector2,
    c2: Phaser.Math.Vector2,
    c3: Phaser.Math.Vector2,
    c4: Phaser.Math.Vector2,
    center: Phaser.Math.Vector2,
    alpha: number,
    tint: number | null,
    building: { level?: number; lastFireTime?: number; ballistaAngle?: number; deploy01?: number } | undefined,
    baseGraphics: Phaser.GameObjects.Graphics | undefined,
    gridX: number,
    gridY: number,
    time: number,
    skipBase: boolean,
    onlyBase: boolean
): void {
    void tint;              // dedicated route — base-color override ignored (precedent)
    void gridX; void gridY; // all geometry is corner/center-relative
    const level = building?.level ?? 1;
    void level;             // L2 renders identical to L1 this round (see header)

    const cx = center.x, cy = center.y;
    const deploy = clamp01(building?.deploy01 ?? 0);

    // Volley clock — stale/absent/negative means FULLY RECOVERED.
    const lastFire = building?.lastFireTime;
    const elRaw = lastFire !== undefined ? time - lastFire : Number.POSITIVE_INFINITY;
    const el = elRaw >= 0 ? elRaw : Number.POSITIVE_INFINITY;

    // Shared harmonic-1 ember breaths (one period, feature phases).
    const b = (ph: number) => 0.5 + 0.5 * Math.sin(W * time - ph);
    const eyeB = b(0.6), noseB = b(1.5), mawB = b(0.3), furnB = b(-0.9), seamB = b(1.0);
    const bob = Math.sin(W * time) * 1.2; // skull breath, ±1.2 px

    // Volley theatrics only exist once the battery is up.
    const volleyGlow = deploy > 0.5
        ? (el < 950 ? 1 : el < 1400 ? 1 - (el - 950) / 450 : 0)
        : 0;

    // ================= GROUND PASS — shrine pad + contact shadow ==========
    const g = baseGraphics ?? graphics;
    if (!skipBase) {
        const chamfered = (spread: number): number[][] => {
            const corners = [c1, c2, c3, c4].map((p: V2) => [
                cx + (p.x - cx) * spread, cy + 1 + (p.y - cy) * spread
            ]);
            const cut = 0.26;
            const poly: number[][] = [];
            for (let i = 0; i < 4; i++) {
                const prev = corners[(i + 3) % 4], curr = corners[i], next = corners[(i + 1) % 4];
                poly.push([curr[0] + (prev[0] - curr[0]) * cut, curr[1] + (prev[1] - curr[1]) * cut]);
                poly.push([curr[0] + (next[0] - curr[0]) * cut, curr[1] + (next[1] - curr[1]) * cut]);
            }
            return poly;
        };
        fillPoly(g, chamfered(0.82), SHADOW, alpha * 0.16 * 0.9);
        fillPoly(g, chamfered(0.6), SHADOW, alpha * 0.15 * 0.9);

        // Compact chamfered stone pad (~0.56 of the plot — the lawn breathes).
        const cut = 0.22, sc = 0.56;
        const ring: number[][] = [];
        const pc = [c1, c2, c3, c4].map((p: V2) => [cx + (p.x - cx) * sc, cy + (p.y - cy) * sc]);
        for (let i = 0; i < 4; i++) {
            const a2 = pc[i], b2 = pc[(i + 1) % 4];
            ring.push([a2[0] + (b2[0] - a2[0]) * cut, a2[1] + (b2[1] - a2[1]) * cut]);
            ring.push([a2[0] + (b2[0] - a2[0]) * (1 - cut), a2[1] + (b2[1] - a2[1]) * (1 - cut)]);
        }
        fillPoly(g, ring.map(p => [p[0], p[1] + 3]), 0x2c2823, alpha);
        fillPoly(g, ring, PAD_TOP, alpha);
        strokePoly(g, ring, 2.2, 0x8a6a30, alpha * 0.8);
        // Corner studs on the pad ring (survive the 1.35px cell).
        g.fillStyle(0x6d5526, alpha);
        for (let i = 0; i < ring.length; i += 2) {
            g.fillCircle((ring[i][0] + ring[i + 1][0]) / 2, (ring[i][1] + ring[i + 1][1]) / 2, 1.9);
        }
        // Ash scorch on the lawn just off the pad — old volleys remembered.
        g.fillStyle(0x353024, alpha * 0.9);
        g.fillEllipse(cx - 52, cy + 14, 10, 4.4);
        g.fillEllipse(cx + 48, cy + 20, 9, 4);
        g.fillEllipse(cx + 62, cy - 2, 7, 3.2);
        g.fillEllipse(cx - 62, cy - 6, 7.5, 3.4);
        g.fillEllipse(cx - 10, cy + 42, 9, 3.8);
    }
    if (onlyBase) return;

    // ======================= ELEVATED PASS ================================
    // Painter order: far collar → shaft hole → skull-lid (north) → jaw apron
    // (south) → riser drum → box + trunnions → near collar → flare (in box).

    // LAYERED SURFACES (2026-07-22): the RISEN battery bakes as three sprite
    // surfaces so the runtime can kick/scale-pop the crate INSIDE its planted
    // mount — `building.bakeSurface` ('holderBack' | 'box' | 'holderFront',
    // a bake-only state field like doorOpen/deploy01) filters the elevated
    // pass; undefined draws today's full composite (runtime vector fallback,
    // dormant/deploy states and the ground pass are always composite).
    //   holderBack  = far collar, shaft + furnace, skull lid, jaw apron,
    //                 riser drum, FAR trunnion arm
    //   box         = the crate: faces, crest, roundels, maw, tubes, flares
    //   holderFront = NEAR trunnion arm + near collar half (draws OVER the
    //                 box so it visibly sits inside the mount)
    const surface = (building as { bakeSurface?: 'holderBack' | 'box' | 'holderFront' } | undefined)?.bakeSurface;
    const wantBack = surface === undefined || surface === 'holderBack';
    const wantBox = surface === undefined || surface === 'box';
    const wantFront = surface === undefined || surface === 'holderFront';

    const jawT = smooth01(deploy / JAW_DONE);
    const skullT = smooth01((deploy - SKULL_START) / (SKULL_DONE - SKULL_START));
    const sinkT = smooth01((deploy - SINK_START) / (1 - SINK_START));
    const riseProg = clamp01((deploy - RISE_START) / (1 - RISE_START));
    const settle = riseProg > 0.86 ? Math.sin(clamp01((riseProg - 0.86) / 0.14) * Math.PI) * 1.6 : 0;
    const drop = (1 - riseProg) * RISE_DEPTH + settle;
    const rising = riseProg < 1;
    const CLAMP_Y = cy - 4;

    // ---- shrine collar (split far/near around the shaft mouth) ----------
    const collarPts = (rx: number, ry: number, a0: number, a1: number, n: number): number[][] => {
        const pts: number[][] = [];
        for (let i = 0; i <= n; i++) {
            const t = a0 + ((a1 - a0) * i) / n;
            pts.push([cx + Math.cos(t) * rx, cy - 6 + Math.sin(t) * ry]);
        }
        return pts;
    };
    const collarHalf = (a0: number, a1: number) => {
        const outer = collarPts(25, 13, a0, a1, 10);
        const inner = collarPts(20, 10.4, a1, a0, 10);
        fillPoly(graphics, [...outer, ...inner], COLLAR, alpha);
        graphics.lineStyle(1.3, 0x8a6a30, alpha * 0.85);
        for (let i = 1; i < 8; i++) {
            const t = a0 + ((a1 - a0) * i) / 8;
            graphics.lineBetween(
                cx + Math.cos(t) * 20, cy - 6 + Math.sin(t) * 10.4,
                cx + Math.cos(t) * 25, cy - 6 + Math.sin(t) * 13
            );
        }
    };
    if (wantBack) collarHalf(Math.PI, Math.PI * 2); // far (north) half — behind everything

    // ---- shaft mouth + furnace glow (hidden under the shut mouth) --------
    if (wantBack && deploy > 0.02) {
        graphics.fillStyle(0x100b07, alpha);
        graphics.fillEllipse(cx, cy - 6, 40, 20.8);
        graphics.fillStyle(0x070503, alpha);
        graphics.fillEllipse(cx, cy - 4.5, 33, 16.6);
        const furnT = clamp01(furnB * 0.55 + volleyGlow * 0.6 + 0.15);
        graphics.fillStyle(lerpColor(EMBER_DIM, EMBER, furnT), alpha * 0.9);
        graphics.fillEllipse(cx, cy - 2, 25, 9.4);
    }

    // ---- THE COVER — skull-lid + fanged jaw apron ------------------------
    if (wantBack) {
        drawSkullLid(graphics, cx, cy, alpha, skullT, sinkT, bob, eyeB, noseB, volleyGlow, time);
        drawJawApron(graphics, cx, cy, alpha, jawT, seamB, volleyGlow);
    }

    // ---- riser drum (bronze turntable column, rises with the box) --------
    const aimRaw = building?.ballistaAngle ?? 0;
    let A = RISE_BEARING;
    if (deploy >= 1) A = aimRaw;
    else if (deploy > AIM_BLEND) {
        let d = aimRaw - RISE_BEARING;
        while (d > Math.PI) d -= Math.PI * 2;
        while (d < -Math.PI) d += Math.PI * 2;
        A = RISE_BEARING + d * smooth01((deploy - AIM_BLEND) / (1 - AIM_BLEND));
    }
    if (wantBack && riseProg > 0.04) {
        drawRiserDrum(graphics, cx, cy, alpha, drop, rising ? CLAMP_Y : null, A);
    }
    if (riseProg > 0.02) {
        drawBattery(graphics, cx, cy, alpha, A, drop, rising ? CLAMP_Y : null,
            el, time, mawB, b, volleyGlow, wantBack, wantBox, wantFront);
    }

    if (wantFront) collarHalf(0, Math.PI); // near (south) half — masks the rise seam
}

// ==========================================================================
// SKULL-LID — the upper jaw and skull of the idol, hinged at its north edge.
// T = 0 biting shut over the shaft; T = 1 reared back into a glaring crest
// (the drama of the rise). S = the FOLD-DOWN (owner note 2026-07-22): over
// deploy 0.80→1 the reared crest retracts fully clear of the battery —
// vertical relief crushes to 12%, the lid sinks 21 px onto the collar and
// narrows 18%, ending as a low silhouette hugging the base behind the
// turntable, so no bearing of the rotating box can overlap the head.
// ==========================================================================
function drawSkullLid(
    graphics: G, cx: number, cy: number, alpha: number,
    T: number, S: number, bob: number, eyeB: number, noseB: number,
    volleyGlow: number, time: number
): void {
    const HY = -27;                        // hinge line (north lid edge)
    const cosT = 1 - 0.45 * T;             // depth compression 1 → 0.55
    const sinT = Math.sin(1.1 * T) * 0.3;  // lift 0 → ~0.27 (a LOW leaned lid)
    const slide = -13 * T;
    const crush = 1 - 0.88 * S;            // fold-down: relief 1 → 0.12
    const sink = 21 * S;                   // settles flush behind the drum
    /** local (lx, ly south of center, lh up-negative) → screen. Pieces far
     *  from the hinge foreshorten laterally as they tip away (no egg). */
    const hp = (lx: number, ly: number, lh: number, wBob = 0): number[] => {
        const dy = ly - HY;
        const xs = (1 - T * clamp01(dy / 34) * 0.25) * (1 - 0.18 * S);
        return [cx + lx * xs, cy + slide + sink + HY + dy * cosT + lh * crush + wBob - dy * sinT];
    };
    const xsAt = (ly: number): number =>
        (1 - T * clamp01((ly - HY) / 34) * 0.25) * (1 - 0.18 * S);
    const ell = (lx: number, ly: number, lh: number, rx: number, ry: number,
        color: number, a: number, wBob = 0) => {
        const p = hp(lx, ly, lh, wBob);
        graphics.fillStyle(color, a);
        graphics.fillEllipse(p[0], p[1], rx * 2 * xsAt(ly), ry * 2 * (cosT + 0.55 * sinT) * (1 - 0.55 * S));
    };

    // Horns — thick bull sweep: out of the brow, OUT and DOWN around the
    // skull, tips hooking forward (farthest, drawn first).
    for (const s of [-1, 1]) {
        fillPoly(graphics, [
            hp(s * 12, -14, -17, bob), hp(s * 21, -17, -19.5, bob),
            hp(s * 30, -16.5, -25, bob), hp(s * 35.5, -12, -30.5, bob),
            hp(s * 33, -11, -26, bob), hp(s * 26.5, -14, -18.5, bob),
            hp(s * 17, -15.5, -13, bob), hp(s * 13, -15.5, -12, bob)
        ], shade(BRONZE_DK, 0.96), alpha);
        strokePoly(graphics, [
            hp(s * 14, -15.5, -16.5, bob), hp(s * 25, -17, -22, bob), hp(s * 34.5, -12.5, -29.5, bob)
        ], 1.8, BRONZE_EDGE, alpha * 0.85, false);
    }

    // Skull — wide flat mound with a carved crown plate (wide > tall).
    ell(0, -10, -4, 30, 15.8, shade(BRONZE, 0.8), alpha, bob);
    ell(0, -10.5, -11, 27.5, 14, BRONZE, alpha, bob);
    ell(0, -11, -17, 23.5, 11.6, shade(BRONZE_LIT, 0.92), alpha, bob);
    // Crown plate — flat hex facet (carved, not blobby).
    fillPoly(graphics, [
        hp(-13, -21, -22, bob), hp(13, -21, -22, bob), hp(19.5, -12, -23, bob),
        hp(13, -3.5, -22.5, bob), hp(-13, -3.5, -22.5, bob), hp(-19.5, -12, -23, bob)
    ], BRONZE_LIT, alpha);
    strokePoly(graphics, [
        hp(-13, -21, -22, bob), hp(13, -21, -22, bob), hp(19.5, -12, -23, bob),
        hp(13, -3.5, -22.5, bob), hp(-13, -3.5, -22.5, bob), hp(-19.5, -12, -23, bob)
    ], 1.2, shade(BRONZE_DK, 0.85), alpha * 0.8);
    // Verdigris bite — asymmetric weathering, kept small at texel scale.
    ell(13.5, -14, -14, 6.2, 3.3, VERD, alpha, bob);
    ell(17, -8, -8.5, 4, 2.2, VERD_DK, alpha, bob);
    ell(-14.5, -17.5, -13, 3.4, 1.9, VERD_DK, alpha, bob);
    // Scale-lap courses on the south slope (fold away as the lid rears).
    if (T < 0.5) {
        graphics.lineStyle(1.6, shade(BRONZE_DK, 0.92), alpha * (1 - T / 0.5));
        for (let r = 0; r < 2; r++) {
            const p = hp(0, -8, -6 - r * 5, bob);
            graphics.beginPath();
            graphics.arc(p[0], p[1], (24 - r * 5.5) * xsAt(-8), Math.PI * 0.14, Math.PI * 0.86);
            graphics.strokePath();
        }
    }

    // Spine crest — three bronze sail fins, glint chase (harmonic 1).
    for (let k = 0; k < 3; k++) {
        const ly = -5.5 - k * 7;
        const hs = -20 - k * 1.6;
        const glint = 0.5 + 0.5 * Math.sin(W * time - k * 1.1);
        const finCol = lerpColor(BRONZE, BRONZE_EDGE, glint);
        fillPoly(graphics, [
            hp(-3.4, ly, hs, bob), hp(3.4, ly, hs, bob),
            hp(1.2, ly - 3.2, hs - (11.5 - k * 1.4), bob)
        ], finCol, alpha);
        strokePoly(graphics, [hp(-3.4, ly, hs, bob), hp(1.2, ly - 3.2, hs - (11.5 - k * 1.4), bob)],
            1.1, shade(BRONZE_DK, 0.8), alpha * 0.85, false);
    }

    // Brow ridges — deep angular overhangs; ember eye SLITS flanking the
    // snout root (kept clear of the muzzle plate drawn later).
    for (const s of [-1, 1]) {
        fillPoly(graphics, [
            hp(s * 6, -7, -19.5, bob), hp(s * 20.5, -4, -16.5, bob),
            hp(s * 21.5, -8, -21.5, bob), hp(s * 7.5, -11, -23.5, bob)
        ], shade(BRONZE_DK, 1.05), alpha);
        const eye = hp(s * 13.5, -4.5, -16.8, bob);
        graphics.fillStyle(lerpColor(EMBER_DEEP, EMBER_HI, clamp01(0.25 + 0.75 * Math.max(eyeB, volleyGlow))), alpha * 0.95);
        graphics.fillEllipse(eye[0], eye[1], 10.4 * xsAt(-4.5), 3.2);
        graphics.fillStyle(shade(BRONZE_DK, 0.92), alpha);   // heavy lid → crescent slit
        graphics.fillEllipse(eye[0], eye[1] - 1.7, 11.6 * xsAt(-4.5), 2.4);
    }

    // Cheek fins — small, tucked low and swept back.
    for (const s of [-1, 1]) {
        fillPoly(graphics, [
            hp(s * 20, 0.5, -10.5, bob), hp(s * 27.5, -2.5, -12, bob), hp(s * 21.5, 4, -6, bob)
        ], VERD_DK, alpha);
        fillPoly(graphics, [
            hp(s * 20.5, 3.5, -6.5, bob), hp(s * 26, 0.5, -7.6, bob), hp(s * 21, 6.5, -3.2, bob)
        ], shade(BRONZE, 0.9), alpha);
    }

    // SNOUT — a proper tapered iso box thrust south (carved, boxy, LIT).
    // Side bevels first (under the plate).
    fillPoly(graphics, [
        hp(17, -3, -15.5, bob), hp(13, 8, -12.5, bob), hp(13, 9, -4.5, bob), hp(18.5, -1, -6.5, bob)
    ], shade(BRONZE_DK, 1.04), alpha);
    fillPoly(graphics, [
        hp(-17, -3, -15.5, bob), hp(-13, 8, -12.5, bob), hp(-13, 9, -4.5, bob), hp(-18.5, -1, -6.5, bob)
    ], shade(BRONZE, 1.06), alpha);
    // South (front) face.
    fillPoly(graphics, [
        hp(-13, 8, -12.5, bob), hp(13, 8, -12.5, bob),
        hp(13, 9, -4.5, bob), hp(-13, 9, -4.5, bob)
    ], shade(BRONZE, 0.86), alpha);
    // Top plate — the lit carved muzzle.
    fillPoly(graphics, [
        hp(-17, -3, -15.5, bob), hp(17, -3, -15.5, bob),
        hp(13, 8, -12.5, bob), hp(-13, 8, -12.5, bob)
    ], shade(BRONZE_LIT, 1.06), alpha);
    graphics.lineStyle(1.2, shade(BRONZE_DK, 0.9), alpha * 0.8);
    {
        const r0 = hp(0, -3, -15.5, bob), r1 = hp(0, 8, -12.5, bob);
        graphics.lineBetween(r0[0], r0[1], r1[0], r1[1]); // center ridge
    }
    // Smoldering nostril slits — small, near the muzzle tip (clearly below
    // the wide eyes; embers dim as the lid tips open).
    for (const s of [-1, 1]) {
        const n = hp(s * 4.8, 5.8, -13.4, bob);
        graphics.fillStyle(0x0d0806, alpha);
        graphics.fillEllipse(n[0], n[1], 4 * xsAt(5.8), 2.4);
        graphics.fillStyle(lerpColor(EMBER_DIM, EMBER, Math.max(noseB, volleyGlow * 0.8)), alpha * 0.95);
        graphics.fillEllipse(n[0], n[1] + 0.2, 2.2 * (1 - 0.45 * T), 1.3 * (1 - 0.45 * T));
    }
    // Upper fangs — hang from the snout lip over the seam (dark-edged gilt).
    for (let i = 0; i < 5; i++) {
        const lx = (i - 2) * 6.0;
        const fang = [
            hp(lx - 2, 9, -4.8, bob), hp(lx + 2, 9, -4.8, bob), hp(lx, 10.2, 0.8, bob)
        ];
        fillPoly(graphics, fang, shade(GILT, 0.95), alpha);
        strokePoly(graphics, fang, 1, SEAM, alpha * 0.6);
    }
}

// ==========================================================================
// JAW APRON — the lower jaw: a charred-oak ramp with upturned gilt fangs.
// T = 0 biting shut (tilted up to the seam, ember light leaking through the
// teeth); T = 1 dropped flat and slid south — a fanged drawbridge apron.
// ==========================================================================
function drawJawApron(
    graphics: G, cx: number, cy: number, alpha: number,
    T: number, seamB: number, volleyGlow: number
): void {
    const slide = 10 * T;                 // pulls south out of the mouth
    const flat = 1 - 0.9 * T;             // raised bite settles flat
    const sink = 2 * T;                   // and seats onto the pad
    const jp = (lx: number, ly: number, lh: number): number[] =>
        [cx + lx, cy + ly + slide + lh * flat + sink];

    // Jaw plate — compact bronze-rimmed oak sled (stays on the pad).
    fillPoly(graphics, [
        jp(-18, 6.5, -8.5), jp(18, 6.5, -8.5),
        jp(20.5, 12.5, -4.5), jp(13, 19.5, -1), jp(-13, 19.5, -1), jp(-20.5, 12.5, -4.5)
    ], shade(OAK_LIT, 1.05), alpha);
    // Front lip drop edge.
    fillPoly(graphics, [
        jp(-13, 19.5, -1), jp(13, 19.5, -1), jp(11.8, 20.8, 1.4), jp(-11.8, 20.8, 1.4)
    ], OAK, alpha);
    // Bronze rim along the bite edge.
    fillPoly(graphics, [
        jp(-18, 6.5, -8.5), jp(18, 6.5, -8.5), jp(17.4, 8, -6.8), jp(-17.4, 8, -6.8)
    ], shade(BRONZE, 0.98), alpha);
    // Ember seam leak — furnace light between the shut teeth (breathing
    // color at fixed alpha; fades out as the mouth opens).
    if (T < 0.55) {
        fillPoly(graphics, [
            jp(-15.5, 8.2, -6.2), jp(15.5, 8.2, -6.2), jp(15, 9.4, -4.6), jp(-15, 9.4, -4.6)
        ], lerpColor(EMBER_DIM, EMBER, seamB * 0.8 + volleyGlow * 0.2), alpha * 0.92 * (1 - T / 0.55));
    }
    // Lower fangs — upturned, interlocking with the hanging upper fangs.
    for (let i = 0; i < 4; i++) {
        const lx = (i - 1.5) * 6.0;
        const fang = [
            jp(lx - 1.8, 9.2, -6), jp(lx + 1.8, 9.2, -6), jp(lx, 7.6, -12)
        ];
        fillPoly(graphics, fang, shade(GILT, 0.88), alpha);
        strokePoly(graphics, fang, 1, SEAM, alpha * 0.6);
    }
    // Jaw hinge bolts.
    for (const s of [-1, 1]) {
        const p = jp(s * 19, 10.5, -5.6);
        graphics.fillStyle(BRONZE_DK, alpha);
        graphics.fillCircle(p[0], p[1], 2.2);
        graphics.fillStyle(BRONZE_EDGE, alpha);
        graphics.fillCircle(p[0] - 0.5, p[1] - 0.5, 0.9);
    }
}

// ==========================================================================
// RISER DRUM — bronze turntable column; the tick ring slews with the aim.
// ==========================================================================
function drawRiserDrum(
    graphics: G, cx: number, cy: number, alpha: number,
    drop: number, clampY: number | null, A: number
): void {
    const topY = cy - 13 + drop;
    const cp = (x: number, y: number): number[] =>
        clampY !== null ? [x, Math.min(y, clampY)] : [x, y];
    const wall: number[][] = [];
    for (let i = 0; i <= 6; i++) {
        const t = (i / 6) * Math.PI;
        wall.push(cp(cx + Math.cos(t) * 16.5, topY + Math.sin(t) * 8.4));
    }
    for (let i = 6; i >= 0; i--) {
        const t = (i / 6) * Math.PI;
        wall.push(cp(cx + Math.cos(t) * 16.5, topY + 12 + Math.sin(t) * 8.4));
    }
    fillPoly(graphics, wall, OAK, alpha);
    graphics.lineStyle(1.6, 0x8a6a30, alpha);
    graphics.beginPath();
    graphics.arc(cx, Math.min(topY + 8, clampY ?? Number.POSITIVE_INFINITY), 16.5, 0, Math.PI);
    graphics.strokePath();
    graphics.fillStyle(shade(BRONZE, 0.9), alpha);
    graphics.fillEllipse(cx, topY, 33, 16.8);
    graphics.fillStyle(BRONZE_DK, alpha);
    graphics.fillEllipse(cx, topY, 25, 12.6);
    graphics.lineStyle(1.6, BRONZE_EDGE, alpha * 0.9);
    for (let k = 0; k < 8; k++) {
        const t = A + (k * Math.PI) / 4;
        graphics.lineBetween(
            cx + Math.cos(t) * 5, topY + Math.sin(t) * 2.5,
            cx + Math.cos(t) * 11, topY + Math.sin(t) * 5.5
        );
    }
}

// ==========================================================================
// THE BATTERY — big tilted charred-oak crate; the muzzle face is a gilt-
// fanged maw with a 4×4 rocket grid. A = display bearing; el = volley clock.
// ==========================================================================
function drawBattery(
    graphics: G, cx: number, cy: number, alpha: number,
    A: number, drop: number, clampY: number | null,
    el: number, time: number, mawB: number,
    b: (ph: number) => number, volleyGlow: number,
    wantBack: boolean, wantBox: boolean, wantFront: boolean
): void {
    const cosA = Math.cos(A), sinA = Math.sin(A);
    // No authored recoil: every frame bakes the box at its REST geometry.
    // The launch kick is a RUNTIME translate of the baked BOX surface
    // (SpriteBank.dragonsBoxKick) between the planted holder surfaces —
    // in-frame motion here would double-kick the crate and shake the
    // trunnions that must stay planted.
    const PT = (d: number, w: number, h: number): number[] => {
        const x = cx + cosA * d - sinA * w;
        const y = cy + drop + h + sinA * 0.5 * d + cosA * 0.5 * w;
        return clampY !== null ? [x, Math.min(y, clampY)] : [x, y];
    };
    // Muzzle face squashes toward edge-on when aiming up-screen.
    const fsq = mix(0.45, 1, smooth01((sinA + 0.5) / 0.65));
    const FD = (d: number): number => 12 + (d - 12) * fsq;
    const FH = (h: number): number => -30 + (h + 30) * fsq;
    // Brightness from a face's screen normal (light from the NW).
    const lit = (nx: number, ny: number): number =>
        Math.min(1.18, Math.max(0.68, 0.9 + 0.4 * (-nx * 0.75 - ny * 0.66)));

    // Trunnion arm (drum → flank pivot boss). Far arm BEFORE the box.
    const drawArm = (s: number, bright: number) => {
        fillPoly(graphics, [
            PT(-4.4, s * 12, -3.5), PT(4.4, s * 12, -3.5),
            PT(-2.8, s * (HALF_W + 1), -25.5), PT(-9.2, s * (HALF_W + 1), -23)
        ], shade(BRONZE, bright), alpha);
        const boss = PT(-6, s * (HALF_W + 0.5), -24.5);
        graphics.fillStyle(BRONZE_EDGE, alpha);
        graphics.fillCircle(boss[0], boss[1], 3.4);
        graphics.fillStyle(BRONZE_DK, alpha);
        graphics.fillCircle(boss[0], boss[1], 1.6);
    };
    const nearSide: 1 | -1 = cosA >= 0 ? 1 : -1;
    if (wantBack) drawArm(-nearSide as 1 | -1, 0.8);

    if (wantBox) {
    // --- top face ----------------------------------------------------------
    fillPoly(graphics, [
        PT(FACE_D_HI, -HALF_W, FACE_H_HI), PT(FACE_D_HI, HALF_W, FACE_H_HI),
        PT(REAR_D_HI, HALF_W, REAR_H_HI), PT(REAR_D_HI, -HALF_W, REAR_H_HI)
    ], shade(OAK_LIT, 1.04), alpha);
    graphics.lineStyle(1.2, SEAM, alpha * 0.8);
    for (const w of [-HALF_W / 3, HALF_W / 3]) {
        const a0 = PT(FACE_D_HI - 1, w, FACE_H_HI + 0.4);
        const a1 = PT(REAR_D_HI + 1, w, REAR_H_HI - 0.4);
        graphics.lineBetween(a0[0], a0[1], a1[0], a1[1]);
    }
    fillPoly(graphics, [
        PT(-16, -HALF_W, topH(-16)), PT(-16, HALF_W, topH(-16)),
        PT(-20, HALF_W, topH(-20)), PT(-20, -HALF_W, topH(-20))
    ], shade(BRONZE, 0.96), alpha);

    // --- visible flank (rotation-proof: outward normal (−sinA·s, cosA·0.5·s))
    const flank = (s: number) => {
        const shadeF = lit(-sinA * s, cosA * 0.5 * s);
        fillPoly(graphics, [
            PT(FACE_D_LO, s * HALF_W, FACE_H_LO), PT(FACE_D_HI, s * HALF_W, FACE_H_HI),
            PT(REAR_D_HI, s * HALF_W, REAR_H_HI), PT(REAR_D_LO, s * HALF_W, REAR_H_LO)
        ], shade(OAK, shadeF), alpha);
        graphics.lineStyle(1.2, SEAM, alpha * 0.75);
        for (const t of [0.36, 0.68]) {
            const m0 = PT(mix(FACE_D_LO, FACE_D_HI, t), s * HALF_W, mix(FACE_H_LO, FACE_H_HI, t));
            const m1 = PT(mix(REAR_D_LO, REAR_D_HI, t), s * HALF_W, mix(REAR_H_LO, REAR_H_HI, t));
            graphics.lineBetween(m0[0], m0[1], m1[0], m1[1]);
        }
        // Bronze strap wrapping down from the top band.
        fillPoly(graphics, [
            PT(-16, s * HALF_W, bottomH(-16)), PT(-20, s * HALF_W, bottomH(-20)),
            PT(-20, s * HALF_W, topH(-20)), PT(-16, s * HALF_W, topH(-16))
        ], shade(BRONZE, shadeF * 0.98), alpha);
        // Ember porthole — the fire inside shows through the flank.
        const ph = PT(-2, s * HALF_W, (topH(-2) + bottomH(-2)) / 2);
        graphics.fillStyle(shade(BRONZE_DK, shadeF), alpha);
        graphics.fillCircle(ph[0], ph[1], 3.6);
        graphics.fillStyle(lerpColor(EMBER_DEEP, EMBER_HI, Math.max(b(0.6), volleyGlow)), alpha * 0.95);
        graphics.fillCircle(ph[0], ph[1], 1.9);
    };
    if (cosA > 0.04) flank(1);
    else if (cosA < -0.04) flank(-1);

    // --- breech face (visible aiming up-screen) ----------------------------
    if (sinA < 0.05) {
        fillPoly(graphics, [
            PT(REAR_D_LO, -HALF_W, REAR_H_LO), PT(REAR_D_LO, HALF_W, REAR_H_LO),
            PT(REAR_D_HI, HALF_W, REAR_H_HI), PT(REAR_D_HI, -HALF_W, REAR_H_HI)
        ], shade(OAK, lit(cosA * 0.9, -sinA * 0.5) * 0.82), alpha);
        graphics.lineStyle(2.2, shade(BRONZE, 0.9), alpha);
        const xa = PT(REAR_D_LO, -HALF_W + 3, REAR_H_LO - 2), xb = PT(REAR_D_HI, HALF_W - 3, REAR_H_HI + 2);
        const xc = PT(REAR_D_LO, HALF_W - 3, REAR_H_LO - 2), xd = PT(REAR_D_HI, -HALF_W + 3, REAR_H_HI + 2);
        graphics.lineBetween(xa[0], xa[1], xb[0], xb[1]);
        graphics.lineBetween(xc[0], xc[1], xd[0], xd[1]);
        for (const s of [-1, 1]) {
            fillPoly(graphics, [
                PT(-27.2, s * 8 - 2.5, -19), PT(-27.2, s * 8 + 2.5, -19),
                PT(-28.6, s * 8 + 2.5, -25), PT(-28.6, s * 8 - 2.5, -25)
            ], lerpColor(EMBER_DIM, EMBER, Math.max(mawB, volleyGlow)), alpha * 0.95);
        }
    }

    // --- spine crest + rear-watch roundels ---------------------------------
    for (let k = 0; k < 4; k++) {
        const d = 6 - k * 9.6;
        const hs = topH(d);
        const glint = 0.5 + 0.5 * Math.sin(W * time - k * 1.1 - 0.4);
        fillPoly(graphics, [
            PT(d + 3.8, 0, hs), PT(d - 3.8, 0, hs), PT(d - 0.8, 0, hs - (10.5 - k * 1.1))
        ], lerpColor(BRONZE, BRONZE_EDGE, glint), alpha);
        strokePoly(graphics, [PT(d + 3.8, 0, hs), PT(d - 0.8, 0, hs - (10.5 - k * 1.1))],
            1.1, shade(BRONZE_DK, 0.8), alpha * 0.85, false);
    }
    for (const s of [-1, 1]) {
        const rp = PT(-21, s * 9.5, topH(-21) - 0.5);
        graphics.fillStyle(BRONZE_DK, alpha);
        graphics.fillCircle(rp[0], rp[1], 3.6);
        graphics.fillStyle(lerpColor(EMBER_DEEP, EMBER_HI, b(0.6)), alpha * 0.95);
        graphics.fillCircle(rp[0], rp[1], 1.9);
    }
    } // end wantBox (crate body)

    // Near trunnion arm over the flank.
    if (wantFront) drawArm(nearSide, 1);

    // --- THE MAW FACE — gilt-fanged frame + 4×4 rocket grid ---------------
    if (wantBox && sinA > -0.38) {
        const FB1 = PT(FD(FACE_D_LO), -HALF_W, FH(FACE_H_LO));
        const FB2 = PT(FD(FACE_D_LO), HALF_W, FH(FACE_H_LO));
        const FT2 = PT(FD(FACE_D_HI), HALF_W, FH(FACE_H_HI));
        const FT1 = PT(FD(FACE_D_HI), -HALF_W, FH(FACE_H_HI));
        const glow = clamp01(volleyGlow * 0.85 + mawB * 0.22);
        fillPoly(graphics, [FB1, FB2, FT2, FT1], lerpColor(MAW, 0x5c2410, glow), alpha);

        // 16 tubes — serpentine launch/refill mirroring MainScene's stagger.
        for (let k = 0; k < 16; k++) {
            const { row, col } = tubeCell(k);
            const d = FD(mix(9.5, 14.5, row / 3));
            const h = FH(mix(-21.8, -38.2, row / 3));
            const w = (col - 1.5) * 9.6;
            const p = PT(d, w, h);
            const launchT = k * 50;
            const refillT = 1150 + k * 25;
            const emptied = el >= launchT && el < refillT;
            graphics.fillStyle(0x0c0805, alpha);
            graphics.fillCircle(p[0], p[1], 3.3);
            if (!emptied) {
                graphics.fillStyle(RED, alpha);
                graphics.fillCircle(p[0], p[1], 2.25);
                graphics.fillStyle(RED_LIT, alpha);
                graphics.fillCircle(p[0] - 0.8, p[1] - 0.8, 0.9);
            } else if (el < launchT + 420) {
                graphics.fillStyle(lerpColor(EMBER, 0x140a06, (el - launchT) / 420), alpha * 0.95);
                graphics.fillCircle(p[0], p[1], 1.7);
            } else {
                graphics.lineStyle(1, 0x3a2c1c, alpha * 0.9);
                graphics.strokeCircle(p[0], p[1], 2.3);
            }
        }

        // Gilt fangs biting the maw + bronze frame.
        for (let i = 0; i < 5; i++) {
            const w = (i - 2) * 8.8;
            fillPoly(graphics, [
                PT(FD(FACE_D_HI), w - 2.6, FH(FACE_H_HI)), PT(FD(FACE_D_HI), w + 2.6, FH(FACE_H_HI)),
                PT(FD(FACE_D_HI - 1.4), w, FH(FACE_H_HI + 6.5))
            ], shade(GILT, 0.95), alpha);
        }
        for (let i = 0; i < 4; i++) {
            const w = (i - 1.5) * 8.8;
            fillPoly(graphics, [
                PT(FD(FACE_D_LO), w - 2.3, FH(FACE_H_LO)), PT(FD(FACE_D_LO), w + 2.3, FH(FACE_H_LO)),
                PT(FD(FACE_D_LO + 1.2), w, FH(FACE_H_LO - 5.2))
            ], shade(GILT, 0.85), alpha);
        }
        strokePoly(graphics, [FB1, FB2, FT2, FT1], 2.2, shade(BRONZE_EDGE, 0.96), alpha);

        // Muzzle flares — up to two overlapping 95 ms pod flashes.
        if (el < 800 + 95) {
            const fi = Math.floor(el / 50);
            for (const k of [fi - 1, fi]) {
                if (k < 0 || k > 15) continue;
                const age = el - k * 50;
                if (age < 0 || age >= 95) continue;
                const t = age / 95;
                const { row, col } = tubeCell(k);
                const d = FD(mix(9.5, 14.5, row / 3));
                const h = FH(mix(-21.8, -38.2, row / 3));
                const w = (col - 1.5) * 9.6;
                const p = PT(d + 2, w, h - 1);
                fillPoly(graphics, [
                    PT(d + 1, w - 3, h), PT(d + 1, w + 3, h),
                    PT(d + 4 + 11 * (1 - t), w, h - 8 * (1 - t))
                ], EMBER_HI, alpha * 0.92);
                graphics.fillStyle(FLASH_CORE, alpha * 0.95);
                graphics.fillCircle(p[0], p[1], 4 * (1 - t * 0.45));
            }
        }
    }
}

// Compile-time contract check (pure binding, no runtime side effects).
const _contractCheck: DragonsBreathDesignFn = drawDragonsBreathB;
void _contractCheck;
