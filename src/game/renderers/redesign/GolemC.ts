import type Phaser from 'phaser';

type G = Phaser.GameObjects.Graphics;

/**
 * GOLEM — DESIGN C — "THE RUNEBOUND CAIRN"
 *
 * A walking dolmen: five hewn megaliths (pelvis boulder, torso slab, capstone
 * shoulders, jutting head-stone, monolith maul fist) held together by nothing
 * but a glowing rune-bond — the seams between the stones burn faction-colored
 * (player azure / enemy ember) and three rune-charged gravel motes orbit the
 * body inside the bond's field. The right arm ends in a squared monolith
 * block (a pile-driver fist), the left in a round grip boulder — an
 * asymmetric, heading-readable silhouette.
 *
 * DIRECTION-AWARE: every part lives in golem-local 3D (x = forward along
 * `facingAngle`, y = lateral, z = up) and is projected per frame with the iso
 * squash (sy = (sin·x + cos·y)/2 − z), painter-sorted far→near by projected
 * depth. Torso, capstone and maul are true extruded slabs whose side faces
 * appear/vanish with the heading (rotation-proof box rule), and the metal /
 * gold bands are outline-hugging 3D rings, so all 16 headings produce
 * genuinely different silhouettes — eyes show on front hemispheres, a dorsal
 * rune-spine shows from behind. facingAngle is carrier-level context (not a
 * param), resolved read-only from the owning troop via the carrier's scene;
 * `__designFacing` on the Graphics is a harness override.
 *
 * MOTION (all deterministic in `time`):
 *  - idle: ONE 2000 ms period; breath 1× (stack rises ~±1.9 px), rune-bond
 *    pulse 2× (±0.28 alpha), mote orbit 1× rev, mote bob 2×, eye flicker 4× —
 *    exact harmonics of a 250 ms multiple, quantization-proof.
 *  - walk: 1000 ms stride; legs swing fore-aft ±4.6, double body-bob, lateral
 *    sway, counter-swinging arms; the mote orbit retimes to 1× rev per
 *    stride (state-aware period) so the baked 1000 ms walk loop closes.
 *  - slam: driven ONLY by slamOffset (0→12 in 200 ms Quad.easeIn, damage at
 *    12, then 12→0 over 400 ms). Upper stack drops by slamOffset px and
 *    lunges along the facing; both fists arc up then plunge, meeting the
 *    ground exactly at slamOffset = 12; the rune-bond flares. Planted
 *    legs/feet never drop.
 *
 * LEVELS: L1 mossy granite · L2 iron-clamped basalt with capstone horns ·
 * L3 warm sandstone with gold bond-rings, gilded corner caps and a gold brow
 * roundel (gold as accents only — no white masses).
 */

const TAU = Math.PI * 2;
const IDLE_P = 2000; // ms — every idle term is an exact harmonic of this
const STRIDE = 1000; // ms — walk cycle
const GROUND_Y = 11; // screen px below carrier origin where the feet stand
const DEFAULT_FACING = Math.PI * 0.32; // pleasant 3/4 view for camp/preview draws

// Deterministic silhouette jitter for hewn stone edges.
const JIT = [1.0, 0.88, 1.07, 0.9, 1.04, 0.86, 0.99, 1.06, 0.92, 1.03, 0.87, 1.05];

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

// ---------------------------------------------------------------- palettes
interface Pal {
    base: number;   // lit stone (viewer-facing planes)
    dark: number;   // SE shade faces
    lite: number;   // top faces (NW light)
    glow: number;   // rune-bond faction glow
    core: number;   // hot center of the glow
    moss: number;   // L1 weathering accent
}

function palette(isPlayer: boolean, level: number): Pal {
    if (level >= 3) {
        return isPlayer
            ? { base: 0xbfb49a, dark: 0x8d8164, lite: 0xd8cfb6, glow: 0x6fd0ff, core: 0xdff4ff, moss: 0x8a7f5e }
            : { base: 0xb1a286, dark: 0x80725a, lite: 0xc9bda3, glow: 0xff9440, core: 0xffe6c0, moss: 0x8a7150 };
    }
    if (level === 2) {
        return isPlayer
            ? { base: 0x83837d, dark: 0x585853, lite: 0xa2a29b, glow: 0x6fd0ff, core: 0xdff4ff, moss: 0x66714a }
            : { base: 0x7c7064, dark: 0x524940, lite: 0x998c80, glow: 0xff9440, core: 0xffe6c0, moss: 0x74653c };
    }
    return isPlayer
        ? { base: 0x94917f, dark: 0x655f4f, lite: 0xb4b1a1, glow: 0x6fd0ff, core: 0xdff4ff, moss: 0x7f915a }
        : { base: 0x8c7f70, dark: 0x5e5245, lite: 0xa89b8d, glow: 0xff9440, core: 0xffe6c0, moss: 0x8f7e4c };
}

// ------------------------------------------------- carrier facing resolution
interface TroopLike { gameObject?: unknown; facingAngle?: unknown }
const carrierTroop = new WeakMap<object, TroopLike>();

/** facingAngle is carrier-level context — resolve it read-only from the
 *  owning troop (cached per carrier). `__designFacing` is a harness hook;
 *  loose carriers (camp figures, bakes, previews) get a fixed 3/4 view. */
function resolveFacing(g: G): number {
    const forced = (g as unknown as { __designFacing?: unknown }).__designFacing;
    if (typeof forced === 'number' && Number.isFinite(forced)) return forced;
    const cached = carrierTroop.get(g);
    if (cached && cached.gameObject === g) {
        const fa = cached.facingAngle;
        return typeof fa === 'number' && Number.isFinite(fa) ? fa : DEFAULT_FACING;
    }
    const scene = (g as unknown as { scene?: { troops?: unknown } }).scene;
    const troops = scene?.troops;
    if (Array.isArray(troops)) {
        for (const t of troops as TroopLike[]) {
            if (t && t.gameObject === g) {
                carrierTroop.set(g, t);
                const fa = t.facingAngle;
                return typeof fa === 'number' && Number.isFinite(fa) ? fa : DEFAULT_FACING;
            }
        }
    }
    return DEFAULT_FACING;
}

// ----------------------------------------------------------- stone helpers

/** Irregular hewn boulder: jittered 7-gon, SE dark facet, NW light chip.
 *  Light is screen-space NW regardless of heading (art guide §3). */
function stone(g: G, cx: number, cy: number, rx: number, ry: number, seed: number, tilt: number,
    base: number, dark: number, lite: number, edge = false): void {
    const N = 7;
    const vx: number[] = [];
    const vy: number[] = [];
    for (let k = 0; k < N; k++) {
        const ang = tilt + (k / N) * TAU;
        const j = JIT[(k + seed) % JIT.length];
        vx.push(cx + Math.cos(ang) * rx * j);
        vy.push(cy + Math.sin(ang) * ry * j);
    }
    g.fillStyle(base, 1);
    g.beginPath();
    g.moveTo(vx[0], vy[0]);
    for (let k = 1; k < N; k++) g.lineTo(vx[k], vy[k]);
    g.closePath();
    g.fillPath();
    // SE facet — verts 0..2 sit right/down for the small tilts we pass.
    const inx = (k: number, t: number) => vx[k] + (cx - vx[k]) * t;
    const iny = (k: number, t: number) => vy[k] + (cy - vy[k]) * t;
    g.fillStyle(dark, 0.8);
    g.beginPath();
    g.moveTo(vx[0], vy[0]);
    g.lineTo(vx[1], vy[1]);
    g.lineTo(vx[2], vy[2]);
    g.lineTo(inx(2, 0.45), iny(2, 0.45));
    g.lineTo(inx(1, 0.6), iny(1, 0.6));
    g.lineTo(inx(0, 0.45), iny(0, 0.45));
    g.closePath();
    g.fillPath();
    // NW-top light rim between verts 5 and 6.
    g.fillStyle(lite, 0.85);
    g.beginPath();
    g.moveTo(vx[5], vy[5]);
    g.lineTo(vx[6], vy[6]);
    g.lineTo(inx(6, 0.3), iny(6, 0.3));
    g.lineTo(inx(5, 0.3), iny(5, 0.3));
    g.closePath();
    g.fillPath();
    if (edge) { // soft outline so small stones separate from the slab behind
        g.lineStyle(1, 0x2b271f, 0.32);
        g.beginPath();
        g.moveTo(vx[0], vy[0]);
        for (let k = 1; k < N; k++) g.lineTo(vx[k], vy[k]);
        g.closePath();
        g.strokePath();
    }
}

/** Small faction rune chip: halo, glow body, hot core. */
function runeChip(g: G, x: number, y: number, r: number, a: number, glow: number, core: number): void {
    g.fillStyle(glow, 0.25 * a);
    g.fillCircle(x, y, r * 1.9);
    g.fillStyle(glow, Math.min(1, a));
    g.fillCircle(x, y, r);
    g.fillStyle(core, Math.min(1, a));
    g.fillCircle(x, y, r * 0.45);
}

// ============================================================== THE DRAW FN
export function drawGolemC(
    graphics: G,
    isPlayer: boolean,
    isMoving: boolean,
    slamOffset: number,
    troopLevel: number = 1,
    time: number = 0
): void {
    const g = graphics;
    const level = Math.max(1, Math.min(3, Math.floor(troopLevel || 1)));
    const pal = palette(isPlayer, level);

    // ---- heading projection rig: local 3D (x fwd, y right, z up) → screen
    const a = resolveFacing(g);
    const ca = Math.cos(a), sa = Math.sin(a);
    const PX = (x: number, y: number): number => ca * x - sa * y;
    const PY = (x: number, y: number, z: number): number => GROUND_Y + (sa * x + ca * y) * 0.5 - z;
    const DP = (x: number, y: number): number => sa * x + ca * y; // painter depth (bigger = nearer)

    // ---- motion drivers (pure f(time) + the slamOffset contract)
    const s = clamp01(slamOffset / 12); // 0 idle → 1 exactly on the damage tick
    let legSw = 0, liftL = 0, liftR = 0, bob = 0, swayY = 0, armSw = 0, breathe = 0;
    if (isMoving) {
        const ph = (((time % STRIDE) + STRIDE) % STRIDE) / STRIDE;
        const sw = Math.sin(ph * TAU);
        legSw = sw * 4.6;                 // left leg fore-aft; right is −legSw
        liftL = Math.max(0, sw) * 2.4;
        liftR = Math.max(0, -sw) * 2.4;
        bob = Math.abs(sw) * 1.7;         // two heavy bobs per stride
        swayY = sw * 1.4;
        armSw = sw * 3.4;                 // right arm counter-swings the right leg
    } else {
        breathe = Math.sin((time * TAU) / IDLE_P); // 1× harmonic of 2000 ms
    }
    const glowA = Math.min(1, 0.6 + 0.28 * Math.sin((time * TAU) / (IDLE_P / 2) + 1.1) + s * 0.4);
    const eyeA = 0.85 + 0.15 * Math.sin((time * TAU) / (IDLE_P / 4) + 2.0);

    // ---- part positions (local 3D) — a hunched, knuckle-dragging brute
    const dropP = s * 7, dropT = s * 10, dropC = s * 12, dropH = s * 12; // body/head ride slamOffset down
    const lungeP = s * 2, lungeT = s * 4, lungeC = s * 5.5, lungeH = s * 7;

    const pelvis = { x: lungeP, y: swayY * 0.5, z: 17 + breathe * 0.5 + bob * 0.7 - dropP };
    const torso = { x: 1 + lungeT, y: swayY, z: 31 + breathe * 0.9 + bob - dropT };
    const cap = { x: 4.5 + lungeC, y: swayY * 1.3, z: 45 + breathe * 1.7 + bob - dropC };
    const head = { x: 13 + lungeH, y: swayY * 1.3, z: 42 + breathe * 1.9 + bob - dropH };
    const shZ = 39 + breathe * 1.5 + bob - dropC * 0.95;
    const shR = { x: 2 + lungeC * 0.8, y: 18.5 + swayY, z: shZ };
    const shL = { x: 2 + lungeC * 0.8, y: -18 + swayY, z: shZ };

    // fists: rest ape-stance → slam target in front of the facing; the arc
    // peaks mid-drive and lands exactly at s = 1 (slamOffset = 12).
    const arcZ = Math.sin(Math.PI * s) * 15;
    const fistR = {
        x: 8.5 + (16 - 8.5) * s + armSw,
        y: 20 + (9 - 20) * s + swayY * 0.6,
        z: 7 + (5 - 7) * s + arcZ + breathe * 0.8 + liftR * 0.4,
    };
    const fistL = {
        x: 7 + (14.5 - 7) * s - armSw,
        y: -19 + (-8.5 - -19) * s + swayY * 0.6,
        z: 7.5 + (4.2 - 7.5) * s + arcZ * 0.92 + breathe * 0.8 + liftL * 0.4,
    };
    const mix = (p: { x: number; y: number; z: number }, q: { x: number; y: number; z: number }, t: number, outY: number) => ({
        x: p.x + (q.x - p.x) * t,
        y: p.y + (q.y - p.y) * t + outY,
        z: p.z + (q.z - p.z) * t,
    });
    const bicR = mix(shR, fistR, 0.4, 2.4);
    const foreR = mix(shR, fistR, 0.72, 1.4);
    const bicL = mix(shL, fistL, 0.4, -2.2);
    const foreL = mix(shL, fistL, 0.72, -1.2);

    // ---------------------------------------------------------- contact shadow
    g.fillStyle(0x000000, 0.27);
    g.fillEllipse(0, GROUND_Y + 1, 46 + s * 5, 16);

    // ------------------------------------------------------------- part list
    const parts: Array<{ d: number; f: () => void }> = [];

    // approximate projected half-width of a slab footprint (for seam glows/AO)
    const projW = (hx: number, hy: number): number => Math.abs(ca) * hx + Math.abs(sa) * hy;

    // soft ambient-occlusion pool a stone casts on whatever is under it
    const ao = (x: number, y: number, z: number, w: number, h: number, al: number) => {
        g.fillStyle(0x000000, al);
        g.fillEllipse(PX(x, y), PY(x, y, z), w, h);
    };

    // -- an extruded, jittered slab: top face + heading-visible side faces.
    // outlinePts are CCW in local ground coords around (cx, cy).
    const slab = (cx: number, cy: number, zc: number, th: number,
        outline: Array<[number, number]>, topC: number, sideC: number, darkC: number,
        after?: () => void): void => {
        const n = outline.length;
        const top: Array<[number, number]> = [];
        const bot: Array<[number, number]> = [];
        for (const [ox, oy] of outline) {
            top.push([PX(cx + ox, cy + oy), PY(cx + ox, cy + oy, zc + th / 2)]);
            bot.push([PX(cx + ox, cy + oy), PY(cx + ox, cy + oy, zc - th / 2)]);
        }
        // side faces whose outward normal points down-screen (visible);
        // 3-tone: right-facing = dark, viewer-facing = base, left-facing = base
        // with a light rim along its top edge.
        for (let k = 0; k < n; k++) {
            const k2 = (k + 1) % n;
            const ex = outline[k2][0] - outline[k][0];
            const ey = outline[k2][1] - outline[k][1];
            const nx = ey, ny = -ex; // outward for CCW
            const nd = DP(nx, ny);
            if (nd <= 0.02) continue;
            const nlen = Math.hypot(PX(nx, ny), nd * 0.5) || 1;
            const snx = PX(nx, ny) / nlen; // screen-x of the normal
            g.fillStyle(snx > 0.4 ? darkC : sideC, 1);
            g.beginPath();
            g.moveTo(top[k][0], top[k][1]);
            g.lineTo(top[k2][0], top[k2][1]);
            g.lineTo(bot[k2][0], bot[k2][1]);
            g.lineTo(bot[k][0], bot[k][1]);
            g.closePath();
            g.fillPath();
            if (snx < -0.35) { // NW-lit face: light rim under the top edge
                g.lineStyle(1.1, pal.lite, 0.7);
                g.lineBetween(top[k][0], top[k][1] + 0.6, top[k2][0], top[k2][1] + 0.6);
            }
        }
        // top face
        g.fillStyle(topC, 1);
        g.beginPath();
        g.moveTo(top[0][0], top[0][1]);
        for (let k = 1; k < n; k++) g.lineTo(top[k][0], top[k][1]);
        g.closePath();
        g.fillPath();
        if (after) after();
    };

    // an outline-hugging 3D band (iron clamp / gold ring) at height z
    const ring = (cx: number, cy: number, z: number, outline: Array<[number, number]>,
        width: number, color: number, alpha: number, stud: number | null) => {
        const n = outline.length;
        for (let k = 0; k < n; k++) {
            const k2 = (k + 1) % n;
            const ex = outline[k2][0] - outline[k][0];
            const ey = outline[k2][1] - outline[k][1];
            if (DP(ey, -ex) <= 0.02) continue; // hidden side
            const x1 = PX(cx + outline[k][0], cy + outline[k][1]);
            const y1 = PY(cx + outline[k][0], cy + outline[k][1], z);
            const x2 = PX(cx + outline[k2][0], cy + outline[k2][1]);
            const y2 = PY(cx + outline[k2][0], cy + outline[k2][1], z);
            g.lineStyle(width, color, alpha);
            g.lineBetween(x1, y1, x2, y2);
            if (stud !== null) {
                g.fillStyle(stud, 0.95);
                g.fillCircle((x1 + x2) / 2, (y1 + y2) / 2, width * 0.38);
            }
        }
    };

    // -- legs (planted: they NEVER take the slam drop)
    for (const side of [-1, 1] as const) {
        const sw = side < 0 ? legSw : -legSw;
        const lift = side < 0 ? liftL : liftR;
        const ly = side * 9.5;
        parts.push({
            d: DP(sw, ly),
            f: () => {
                // foot slab
                const fx = PX(sw * 1.15, ly * 1.05);
                const fy = PY(sw * 1.15, ly * 1.05, 1.8 + lift * 0.75);
                g.fillStyle(0x3a342c, 1);
                g.fillEllipse(fx, fy, 14, 5.4);
                g.fillStyle(pal.dark, 0.9);
                g.fillEllipse(fx - 0.8, fy - 0.9, 11.5, 3.8);
                // shin boulder
                stone(g, PX(sw, ly), PY(sw, ly, 6.5 + lift), 6, 5.2, side < 0 ? 2 : 7, 0.22, pal.base, pal.dark, pal.lite, true);
            }
        });
    }

    // -- pelvis boulder + bond seam onto the legs
    parts.push({
        d: DP(pelvis.x, pelvis.y),
        f: () => {
            const x = PX(pelvis.x, pelvis.y), y = PY(pelvis.x, pelvis.y, pelvis.z);
            ao(pelvis.x, pelvis.y, pelvis.z - 7, 20, 6, 0.18);
            stone(g, x, y, 11, 8, 3, 0.15, pal.base, pal.dark, pal.lite);
            if (level === 1) {
                g.fillStyle(pal.moss, 0.8);
                g.fillEllipse(x - 3.5, y + 3.5, 6.5, 2.6);
            }
        }
    });

    // -- torso megalith (hx fore-aft 9 × hy lateral 15, hewn corners)
    const torsoOutline: Array<[number, number]> = [
        [9 * 1.06, -15 * 0.94], [9.7, 0], [9 * 0.98, 15 * 1.03], [-9 * 0.92, 15 * 0.97],
        [-9.9, 0], [-9 * 1.02, -15 * 1.01],
    ];
    parts.push({
        d: DP(torso.x, torso.y),
        f: () => {
            // bond seam glow pelvis↔torso (in the gap under the slab)
            const wLo = projW(9, 15) * 1.5;
            g.fillStyle(pal.glow, 0.32 * glowA);
            g.fillEllipse(PX(torso.x, torso.y), PY(torso.x, torso.y, torso.z - 8.2), wLo * 0.62, 3.6);
            slab(torso.x, torso.y, torso.z, 15, torsoOutline, pal.lite, pal.base, pal.dark, () => {
                const tx = PX(torso.x, torso.y);
                const ty = PY(torso.x, torso.y, torso.z);
                if (level === 1) {
                    // weathering crack + moss on the top face
                    g.lineStyle(1, pal.dark, 0.55);
                    g.lineBetween(tx - 4, ty + 1, tx - 1, ty + 5);
                    g.lineBetween(tx - 1, ty + 5, tx - 4, ty + 9);
                    g.fillStyle(pal.moss, 0.75);
                    g.fillEllipse(tx + 3, ty - 6.2, 6, 2.2);
                } else if (level === 2) {
                    // iron clamp ring hugging the slab + studs
                    ring(torso.x, torso.y, torso.z - 1.5, torsoOutline, 2.4, 0x474b52, 0.95, 0x8b95a2);
                } else {
                    // gilded bond ring + gold vein on the top face
                    ring(torso.x, torso.y, torso.z - 1.5, torsoOutline, 1.5, 0xdaa520, 0.95, 0xffd700);
                    g.lineStyle(1.1, 0xdaa520, 0.85);
                    g.lineBetween(tx - 5, ty - 6.5, tx - 1.5, ty - 3);
                    g.lineBetween(tx - 1.5, ty - 3, tx - 5.5, ty + 1);
                    g.fillStyle(0xffd700, 0.9);
                    g.fillCircle(tx - 1.5, ty - 3, 0.8);
                }
                // dorsal rune-spine — the back view's identity
                if (sa < -0.12) {
                    g.lineStyle(1.6, pal.glow, 0.5 * glowA);
                    g.lineBetween(PX(torso.x - 10.2, torso.y), PY(torso.x - 10.2, torso.y, torso.z - 6),
                        PX(torso.x - 10.2, torso.y), PY(torso.x - 10.2, torso.y, torso.z + 7));
                    for (const dz of [-4.5, 0.5, 5.5]) {
                        runeChip(g, PX(torso.x - 10.2, torso.y), PY(torso.x - 10.2, torso.y, torso.z + dz), 1.3,
                            glowA * 0.95, pal.glow, pal.core);
                    }
                }
            });
        }
    });

    // -- capstone shoulder slab (wide lateral: hx 8 × hy 19.5), hunched forward
    const capOutline: Array<[number, number]> = [
        [8 * 1.04, -19.5 * 0.92], [8.7, 0], [8 * 0.95, 19.5 * 1.04], [0, 20.3], [-8 * 1.02, 19.5 * 0.95],
        [-8.5, 0], [-8 * 0.94, -19.5 * 1.02], [0, -20],
    ];
    parts.push({
        d: DP(cap.x, cap.y),
        f: () => {
            // THE RUNE-BOND: the glowing seam holding capstone above torso
            const wSeam = projW(8, 19.5) * 1.55;
            g.fillStyle(pal.glow, 0.42 * glowA);
            g.fillEllipse(PX(cap.x - 1, cap.y), PY(cap.x - 1, cap.y, cap.z - 4.6), wSeam * 0.66, 4.2);
            g.fillStyle(pal.core, 0.5 * glowA);
            g.fillEllipse(PX(cap.x - 1, cap.y), PY(cap.x - 1, cap.y, cap.z - 4.6), wSeam * 0.4, 2);
            ao(cap.x, cap.y, cap.z - 3.8, projW(8, 19.5) * 1.4, 3.4, 0.16);
            slab(cap.x, cap.y, cap.z, 7, capOutline, pal.lite, pal.base, pal.dark, () => {
                if (level === 1) {
                    g.fillStyle(pal.moss, 0.9);
                    g.fillEllipse(PX(cap.x - 2, cap.y - 9), PY(cap.x - 2, cap.y - 9, cap.z + 3.5), 5, 2);
                    g.fillEllipse(PX(cap.x + 1, cap.y - 5), PY(cap.x + 1, cap.y - 5, cap.z + 3.5), 3.4, 1.5);
                } else if (level === 2) {
                    // basalt horn spikes at the shoulder corners
                    for (const hy of [-14, 14]) {
                        const hx0 = PX(cap.x + 1, cap.y + hy);
                        const hy0 = PY(cap.x + 1, cap.y + hy, cap.z + 3.2);
                        g.fillStyle(0x55504a, 1);
                        g.fillTriangle(hx0 - 3.1, hy0, hx0 + 3.1, hy0, hx0, hy0 - 6);
                        g.fillStyle(0x6d6862, 0.9);
                        g.fillTriangle(hx0 - 3.1, hy0, hx0, hy0, hx0 - 0.8, hy0 - 4.4);
                    }
                } else {
                    // gilded corner caps + a front brow roundel
                    for (const hy of [-15, 15]) {
                        const hx0 = PX(cap.x + 1.5, cap.y + hy);
                        const hy0 = PY(cap.x + 1.5, cap.y + hy, cap.z + 3.6);
                        g.fillStyle(0xdaa520, 0.95);
                        g.fillTriangle(hx0 - 2.2, hy0 + 0.7, hx0 + 2.2, hy0 + 0.7, hx0, hy0 - 3);
                        g.fillStyle(0xffd700, 0.9);
                        g.fillCircle(hx0, hy0 - 0.7, 0.75);
                    }
                    if (sa > 0.05) {
                        const bx = PX(cap.x + 7.6, cap.y), by = PY(cap.x + 7.6, cap.y, cap.z - 0.8);
                        g.fillStyle(0xdaa520, 0.95);
                        g.fillCircle(bx, by, 2);
                        g.fillStyle(pal.core, 0.85 * glowA);
                        g.fillCircle(bx, by, 0.9);
                    }
                }
            });
            // rune chips crawling the bond seam (near hemisphere only)
            const chips = level === 1 ? 3 : level === 2 ? 4 : 6;
            for (let k = 0; k < chips; k++) {
                const gk = 0.4 + (k / chips) * TAU;
                const rx = Math.cos(gk) * 9.5, ry = Math.sin(gk) * 15.5;
                if (DP(torso.x + rx, torso.y + ry) < DP(torso.x, torso.y) - 1.2) continue;
                runeChip(g, PX(torso.x + rx, torso.y + ry), PY(torso.x + rx, torso.y + ry, cap.z - 4.6),
                    1.5, glowA, pal.glow, pal.core);
            }
        }
    });

    // -- head-stone hanging under the brow, jutting forward
    parts.push({
        d: DP(head.x, head.y),
        f: () => {
            const hx = PX(head.x, head.y), hy = PY(head.x, head.y, head.z);
            stone(g, hx, hy, 6.4, 5.6, 9, 0.1, pal.base, pal.dark, pal.lite, true);
            // brow shade cast by the capstone lip
            g.fillStyle(0x000000, 0.22);
            g.fillEllipse(hx + 0.5, hy - 3.6, 9.5, 3);
            const drawEye = (ox: number, oy: number, r: number) => {
                const ex = PX(head.x + ox, head.y + oy);
                const ey = PY(head.x + ox, head.y + oy, head.z + 0.6);
                g.fillStyle(0x1c1a16, 0.9);
                g.fillEllipse(ex, ey, r * 2.7, r * 2);
                g.fillStyle(pal.glow, eyeA);
                g.fillCircle(ex, ey, r);
                g.fillStyle(pal.core, eyeA);
                g.fillCircle(ex, ey, r * 0.45);
            };
            if (sa > 0.12) {
                drawEye(4.8, -2.5, 1.55);
                drawEye(4.8, 2.5, 1.55);
            } else if (sa >= -0.12) {
                drawEye(4.2, 0, 1.45); // profile: one eye edge-on
            }
        }
    });

    // -- arms: boulder-chain bicep/forearm + fists (left round, right monolith)
    parts.push({
        d: DP(bicL.x, bicL.y),
        f: () => stone(g, PX(bicL.x, bicL.y), PY(bicL.x, bicL.y, bicL.z), 5.4, 4.8, 5, -0.1, pal.base, pal.dark, pal.lite, true)
    });
    parts.push({
        d: DP(foreL.x, foreL.y),
        f: () => stone(g, PX(foreL.x, foreL.y), PY(foreL.x, foreL.y, foreL.z), 4.7, 4.2, 8, 0.2, pal.base, pal.dark, pal.lite, true)
    });
    parts.push({
        d: DP(fistL.x, fistL.y),
        f: () => {
            ao(fistL.x, fistL.y, 0.8, 12, 4, 0.18 * (1 - s * 0.4));
            stone(g, PX(fistL.x, fistL.y), PY(fistL.x, fistL.y, fistL.z), 6.6, 6, 4, 0.05, pal.base, pal.dark, pal.lite, true);
        }
    });
    parts.push({
        d: DP(bicR.x, bicR.y),
        f: () => stone(g, PX(bicR.x, bicR.y), PY(bicR.x, bicR.y, bicR.z), 6.6, 5.8, 1, 0.12, pal.base, pal.dark, pal.lite, true)
    });
    parts.push({
        d: DP(foreR.x, foreR.y),
        f: () => stone(g, PX(foreR.x, foreR.y), PY(foreR.x, foreR.y, foreR.z), 5.7, 5, 6, -0.15, pal.base, pal.dark, pal.lite, true)
    });
    // the MAUL: a squared monolith block fist (pile-driver)
    const maulOutline: Array<[number, number]> = [
        [6 * 1.05, -5.4 * 0.93], [6 * 0.97, 5.4 * 1.04], [-6 * 0.94, 5.4 * 0.98], [-6 * 1.03, -5.4 * 1.02],
    ];
    parts.push({
        d: DP(fistR.x, fistR.y),
        f: () => {
            ao(fistR.x, fistR.y, 0.8, 14, 4.6, 0.18 * (1 - s * 0.4));
            slab(fistR.x, fistR.y, fistR.z, 11, maulOutline, pal.lite, pal.base, pal.dark, () => {
                if (level === 2) ring(fistR.x, fistR.y, fistR.z - 1, maulOutline, 2, 0x474b52, 0.95, 0x8b95a2);
                if (level === 3) ring(fistR.x, fistR.y, fistR.z - 1, maulOutline, 1.3, 0xdaa520, 0.95, 0xffd700);
                // knuckle rune — flares with the slam
                runeChip(g, PX(fistR.x, fistR.y), PY(fistR.x, fistR.y, fistR.z + 3.4), 1.2, glowA, pal.glow, pal.core);
            });
        }
    });

    // -- rune-charged gravel motes orbiting the bond (occlusion-sorted!)
    // The orbit period is STATE-AWARE so every baked loop closes on a whole
    // revolution: 1 rev per 1000 ms stride while walking, 1 rev per 2000 ms
    // idle period at rest (attack frames bake at a pinned time, so they
    // inherit the rest spacing). Both periods are exact 250 ms multiples and
    // exact harmonics of their loop — no mid-orbit pop at the wrap.
    const moteP = isMoving ? STRIDE : IDLE_P;
    for (let k = 0; k < 3; k++) {
        const mAng = (time * TAU) / moteP + k * (TAU / 3);
        const mR = 17.5 + s * 5;
        const mx = Math.cos(mAng) * mR;
        const my = Math.sin(mAng) * mR;
        const mz = 30 + Math.sin((time * TAU) / (IDLE_P / 2) + k * (TAU / 3)) * 3.5 - s * 9;
        const mr = [1.8, 1.4, 2.1][k];
        parts.push({
            d: DP(mx, my),
            f: () => {
                const x = PX(mx, my), y = PY(mx, my, mz);
                g.fillStyle(pal.glow, 0.28 * glowA);
                g.fillCircle(x, y + 0.4, mr * 2);
                g.fillStyle(pal.base, 1);
                g.fillCircle(x, y, mr);
                g.fillStyle(pal.dark, 0.85);
                g.fillCircle(x + mr * 0.35, y + mr * 0.35, mr * 0.55);
            }
        });
    }

    // -- impact gravel at the very bottom of the slam
    if (s > 0.85) {
        const t = (s - 0.85) / 0.15;
        parts.push({
            d: DP(16, 0) + 0.3,
            f: () => {
                // ground flash right at the tick (2:1 ellipse — grounded light)
                g.fillStyle(pal.glow, 0.38 * t);
                g.fillEllipse(PX(16, 0), PY(16, 0, 0.4), 27, 9.5);
                g.fillStyle(pal.core, 0.3 * t);
                g.fillEllipse(PX(16, 0), PY(16, 0, 0.4), 15, 5);
                for (const [ga, gr] of [[0.4, 2.0], [1.6, 1.5], [2.9, 2.2], [4.4, 1.6], [5.6, 1.9]] as const) {
                    const cxp = 16 + Math.cos(ga) * (3.5 + t * 8.5);
                    const cyp = Math.sin(ga) * (3.5 + t * 8.5) * 0.85;
                    g.fillStyle(pal.dark, t);
                    g.fillCircle(PX(cxp, cyp), PY(cxp, cyp, 1.2 + t * 5), gr);
                }
            }
        });
    }

    // painter's order: far → near
    parts.sort((p, q) => p.d - q.d);
    for (const p of parts) p.f();
}
