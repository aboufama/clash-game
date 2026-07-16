import type Phaser from 'phaser';

/**
 * CANNON — "THE BULLDOG BOMBARD" (tournament design B).
 *
 * THIS IS THE SHIPPED CANONICAL CANNON. It won the clean-room design
 * tournament (owner verdict 2026-07); designs A and C were purged and the
 * cannon entry left the DesignRegistry. BuildingRenderer.drawCannon* call
 * drawCannonB directly, and the baked atlas lives at
 * public/assets/sprites/buildings/cannon/.
 *
 * A stout, pot-bellied bombard — fat powder chamber, banded barrel, flared
 * muzzle — cradled between two timber trunnion cheeks on a rotating oak-plank
 * turntable over a compact chamfered pad. Crew-less mechanical life:
 *   - a LINSTOCK ARM (iron pendulum holding a glowing slow-match) hovers over
 *     the touch-hole; the ember pulses, the match sways fore-aft;
 *   - a specular GLINT slides up and down the barrel;
 *   - L3+ a 4-spoke elevation HANDWHEEL ratchets a quarter-turn per period.
 * All idle terms are exact harmonics of ONE period: IDLE_P = 1500 ms.
 *
 * Fire sequence (driven by time - lastFireTime + cannonRecoilOffset):
 *   blast    (0-130 ms)  bore/lip flash, ember flare;
 *   recoil   (0-200 ms)  barrel slams back ~6.5 px in its cradle (driver);
 *   vent     (0-420 ms)  touch-hole spark fountain;
 *   cooldown (0-650 ms)  bore glow cools orange -> black;
 *   anticipation: the match arm lifted off at the blast and descends back
 *   onto the vent over the last ~450 ms of the reload — "armed" reads as the
 *   match hovering right on the touch-hole.
 *
 * Contract: aim pivot at (center.x, center.y - 14); muzzle tip lands exactly
 * at pivot + (cos(a)*28, sin(a)*0.5*28) at every ballistaAngle (recoil 0).
 * Levels: L1 field bombard (cast iron pot, rope lashings, earth pad, powder
 * keg) -> L2 banded iron (stone pad, shot pile) -> L3 blued steel + brass
 * (dark stone, handwheel) -> L4 gilded bronze (sandstone pad, gold ring
 * accents + finial — gold stays on the weapon, base stays timber/stone).
 */

type G = Phaser.GameObjects.Graphics;
type Pt = { x: number; y: number };

const TAU = Math.PI * 2;
const IDLE_P = 1500; // ms — the ONE idle period (250 ms multiple)
const FIRE_RATE = [2400, 2200, 2050, 1900]; // registry fireRate per level

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);
const smooth01 = (x: number) => { const u = clamp(x, 0, 1); return u * u * (3 - 2 * u); };
const mixCol = (c0: number, c1: number, f: number) => {
    const u = clamp(f, 0, 1);
    const r = ((c0 >> 16) & 255) + (((c1 >> 16) & 255) - ((c0 >> 16) & 255)) * u;
    const gr = ((c0 >> 8) & 255) + (((c1 >> 8) & 255) - ((c0 >> 8) & 255)) * u;
    const b = (c0 & 255) + ((c1 & 255) - (c0 & 255)) * u;
    return ((r | 0) << 16) | ((gr | 0) << 8) | (b | 0);
};
const strokeRun = (gr: G, pts: Pt[]) => {
    gr.beginPath();
    gr.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) gr.lineTo(pts[i].x, pts[i].y);
    gr.strokePath();
};

interface CannonStyle {
    padTop: number; padLite: number; padDark: number; padTrim: number | null;
    discTop: number; discSide: number; discSeam: number; discStrap: number | null;
    cheekFace: number; cheekEdge: number; cheekCap: number | null;
    bBody: number; bBelly: number; bTop: number; bRing: number; bLip: number; bore: number;
    dB: number; wB: number; wMid: number; wTip: number;
    rings: number[]; ringIsRope: boolean; ringThick: number; ringOver: number;
    crankCol: number | null; pile: 'keg' | 'balls3' | 'balls4'; finial: boolean; goldTop: boolean;
}

const STYLE: CannonStyle[] = [
    { // L1 — field bombard: cast-iron pot, hemp lashings, raw timber, packed earth
        padTop: 0x7d6a49, padLite: 0x93805c, padDark: 0x5e4d34, padTrim: null,
        discTop: 0x8a663c, discSide: 0x5e4325, discSeam: 0x6d5130, discStrap: null,
        cheekFace: 0x6f5433, cheekEdge: 0x46341d, cheekCap: null,
        bBody: 0x524d47, bBelly: 0x39352f, bTop: 0x716a5f, bRing: 0x8a7350, bLip: 0x5a544d, bore: 0x15110d,
        dB: -9, wB: 6.1, wMid: 5.0, wTip: 6.6,
        rings: [2, 10], ringIsRope: true, ringThick: 1.3, ringOver: 0.8,
        crankCol: null, pile: 'keg', finial: false, goldTop: false,
    },
    { // L2 — banded iron: longer tube, iron hoops, iron-strapped turntable, stone pad
        padTop: 0x8b8b83, padLite: 0xa3a39b, padDark: 0x6c6c64, padTrim: null,
        discTop: 0x7d5c36, discSide: 0x543d20, discSeam: 0x624828, discStrap: 0x3d4046,
        cheekFace: 0x67512f, cheekEdge: 0x42311b, cheekCap: null,
        bBody: 0x585d66, bBelly: 0x3f434b, bTop: 0x767c88, bRing: 0x33373e, bLip: 0x4a4e56, bore: 0x14110e,
        dB: -11, wB: 6.2, wMid: 5.1, wTip: 6.8,
        rings: [-4, 6, 16], ringIsRope: false, ringThick: 1.0, ringOver: 0.5,
        crankCol: null, pile: 'balls3', finial: false, goldTop: false,
    },
    { // L3 — blued steel + brass rings, iron-capped cheeks, dark stone, handwheel
        padTop: 0x686a72, padLite: 0x7e8089, padDark: 0x515359, padTrim: null,
        discTop: 0x6b4c2c, discSide: 0x47331c, discSeam: 0x543c22, discStrap: 0x2e3138,
        cheekFace: 0x5d482a, cheekEdge: 0x3b2c17, cheekCap: 0x3a3e46,
        bBody: 0x475064, bBelly: 0x323a4b, bTop: 0x5f6a85, bRing: 0x9a7b33, bLip: 0x3e4658, bore: 0x121017,
        dB: -12.5, wB: 6.0, wMid: 4.9, wTip: 6.6,
        rings: [-5, 4, 13, 21], ringIsRope: false, ringThick: 1.0, ringOver: 0.45,
        crankCol: 0x9a7b33, pile: 'balls4', finial: false, goldTop: false,
    },
    { // L4 — gilded bronze: gold ring/lip ACCENTS on a bronze tube, sandstone pad
        padTop: 0xbfb49a, padLite: 0xdcd3ba, padDark: 0x9a8f74, padTrim: 0xdaa520,
        discTop: 0x7d5a34, discSide: 0x553d20, discSeam: 0x634827, discStrap: 0xb8860b,
        cheekFace: 0x7a5a34, cheekEdge: 0x4e3a20, cheekCap: 0xb8860b,
        bBody: 0x815729, bBelly: 0x5d401c, bTop: 0x9c7136, bRing: 0xdaa520, bLip: 0xdaa520, bore: 0x161009,
        dB: -14, wB: 6.1, wMid: 4.95, wTip: 6.8,
        rings: [-6, 3, 12, 20], ringIsRope: false, ringThick: 0.9, ringOver: 0.35,
        crankCol: 0xb8860b, pile: 'balls4', finial: true, goldTop: true,
    },
];

const BALLS3: Array<[number, number]> = [[10.8, 5.4], [15.4, 6.6], [13.0, 2.9]];
const BALLS4: Array<[number, number]> = [[9.8, 5.2], [14.2, 6.6], [17.8, 4.4], [12.4, 2.6]];

export function drawCannonB(
    graphics: Phaser.GameObjects.Graphics,
    c1: Phaser.Math.Vector2,
    c2: Phaser.Math.Vector2,
    c3: Phaser.Math.Vector2,
    c4: Phaser.Math.Vector2,
    center: Phaser.Math.Vector2,
    alpha: number,
    _tint: number | null,
    building: any,
    baseGraphics: Phaser.GameObjects.Graphics | undefined,
    skipBase: boolean = false,
    onlyBase: boolean = false,
    time: number = 0
): void {
    const level = clamp(Math.round(building?.level ?? 1), 1, 4);
    const S = STYLE[level - 1];
    const cx = center.x, cy = center.y;

    // ---------------- BASE PASS (ground paint only) ----------------
    const g = baseGraphics || graphics;
    if (!skipBase) {
        // soft dark-green contact shadow (2:1, inside the plot)
        g.fillStyle(0x1e2a12, 0.20 * alpha);
        g.fillEllipse(cx, cy + 1, 46, 23);
        // compact chamfered pad (~0.62 of footprint), level-materialed
        const K = [c1, c2, c3, c4].map(c => ({ x: cx + (c.x - cx) * 0.62, y: cy + (c.y - cy) * 0.62 }));
        const oct: Pt[] = [];
        for (let i = 0; i < 4; i++) {
            const p = K[i], q = K[(i + 1) % 4];
            oct.push({ x: p.x + (q.x - p.x) * 0.17, y: p.y + (q.y - p.y) * 0.17 });
            oct.push({ x: p.x + (q.x - p.x) * 0.83, y: p.y + (q.y - p.y) * 0.83 });
        }
        g.fillStyle(S.padTop, alpha);
        g.fillPoints(oct, true);
        g.lineStyle(1.5, S.padLite, 0.85 * alpha);
        strokeRun(g, [oct[6], oct[7], oct[0], oct[1]]); // NW/N/NE rims lit
        g.lineStyle(1.5, S.padDark, 0.9 * alpha);
        strokeRun(g, [oct[2], oct[3], oct[4], oct[5]]); // SE/S/SW rims shaded
        // deterministic grain
        g.fillStyle(S.padDark, 0.5 * alpha);
        const SPECK = [[0.30, -0.18], [-0.34, 0.16], [0.10, 0.30], [-0.12, -0.30], [0.40, 0.12], [-0.42, -0.06]];
        for (const [u, v] of SPECK) g.fillRect(cx + u * 19 - 0.7, cy + v * 9.5 - 0.7, 1.5, 1.5);
        if (S.padTrim !== null) {
            g.lineStyle(1, S.padTrim, 0.55 * alpha);
            const inner = oct.map(p => ({ x: cx + (p.x - cx) * 0.8, y: cy + (p.y - cy) * 0.8 }));
            strokeRun(g, [...inner, inner[0]]);
        }
        // contact shadow for the fixed accessory (keg SW / shot pile SE)
        g.fillStyle(0x1e2a12, 0.18 * alpha);
        if (S.pile === 'keg') g.fillEllipse(cx - 13.5, cy + 6.8, 11, 5);
        else g.fillEllipse(cx + 13, cy + 6.5, 13, 6);
    }
    if (onlyBase) return;

    // ---------------- STATE ----------------
    const t = time;
    const a = (typeof building?.ballistaAngle === 'number') ? building.ballistaAngle : Math.PI / 4;
    const cosA = Math.cos(a), sinA = Math.sin(a);
    const rec = clamp(building?.cannonRecoilOffset ?? 0, -0.15, 1);
    const lf = building?.lastFireTime;
    const since = (typeof lf === 'number') ? Math.max(0, t - lf) : Number.POSITIVE_INFINITY;
    const FR = FIRE_RATE[level - 1];
    const flash = since < 130 ? 1 - since / 130 : 0;
    const vent = since < 420 ? 1 - since / 420 : 0;
    const heat = since < 650 ? 1 - since / 650 : 0;
    const dip = Number.isFinite(since) ? smooth01((since - (FR - 450)) / 400) : 1;

    // aim-space toolkit (iso squash 0.5)
    const AX = (d: number) => cosA * d, AY = (d: number) => sinA * 0.5 * d;
    const PXa = (w: number) => -sinA * w, PYa = (w: number) => cosA * 0.5 * w;
    const pt3 = (d: number, w: number, h: number): Pt => ({ x: cx + AX(d) + PXa(w), y: cy + h + AY(d) + PYa(w) });

    // barrel axis: pivot 14 px above ground center; muzzle at +28 (projectile contract)
    const H = -14;
    const shift = -6.5 * rec; // recoil slide in the cradle
    const axis = (d: number): Pt => ({ x: cx + AX(d + shift), y: cy + H + AY(d + shift) });
    const axis0 = (d: number): Pt => ({ x: cx + AX(d), y: cy + H + AY(d) });
    const vLen = Math.hypot(cosA, 0.5 * sinA);
    let nx = -(0.5 * sinA) / vLen, ny = cosA / vLen; // screen normal of the barrel line
    if (ny > 0) { nx = -nx; ny = -ny; }              // keep it pointing screen-up

    // up-screen aims foreshorten hard at 0.5 squash — stretch the breech back
    // and fatten slightly so the tube keeps its presence (muzzle stays pinned)
    const upBoost = Math.max(0, -sinA);
    const dBv = S.dB * (1 + 0.4 * upBoost);
    const wBoost = 1 + 0.12 * upBoost;
    const ST: Array<[number, number]> = [
        [dBv, S.wB * 0.88], [dBv + 4.5, S.wB], [dBv + 10, (S.wB + S.wMid) / 2],
        [16, S.wMid], [24.6, S.wMid * 0.93], [26.2, S.wTip * 0.88], [28, S.wTip],
    ];
    const widthAt = (d: number) => {
        if (d <= ST[0][0]) return ST[0][1] * wBoost;
        for (let i = 1; i < ST.length; i++) {
            if (d <= ST[i][0]) {
                const [d0, w0] = ST[i - 1], [d1, w1] = ST[i];
                return (w0 + (w1 - w0) * ((d - d0) / (d1 - d0))) * wBoost;
            }
        }
        return ST[ST.length - 1][1] * wBoost;
    };
    const edge = (f: number): Pt[] => ST.map(([d]) => {
        const p = axis(d); const w = widthAt(d) * f;
        return { x: p.x + nx * w, y: p.y + ny * w };
    });
    const poly = (top: Pt[], bot: Pt[]): Pt[] => [...top, ...bot.slice().reverse()];
    const ringQuad = (d: number, ht: number): Pt[] => {
        const w1 = widthAt(d) + S.ringOver;
        const p0 = axis(d - ht), p1 = axis(d + ht);
        return [
            { x: p0.x + nx * w1, y: p0.y + ny * w1 }, { x: p1.x + nx * w1, y: p1.y + ny * w1 },
            { x: p1.x - nx * w1, y: p1.y - ny * w1 }, { x: p0.x - nx * w1, y: p0.y - ny * w1 },
        ];
    };

    // ---------------- 1. TURNTABLE (rotates with aim via plank seams) ----------------
    graphics.fillStyle(S.discSide, alpha);
    graphics.fillEllipse(cx, cy - 2.5, 27, 13.5);
    graphics.fillStyle(S.discTop, alpha);
    graphics.fillEllipse(cx, cy - 6.5, 27, 13.5);
    graphics.lineStyle(1.1, S.discSeam, 0.85 * alpha);
    for (const w of [-6.6, 0, 6.6]) {
        const sq = Math.sqrt(13.5 * 13.5 - w * w) - 0.8;
        const p1 = pt3(-sq, w, -6.5), p2 = pt3(sq, w, -6.5);
        graphics.lineBetween(p1.x, p1.y, p2.x, p2.y);
    }
    if (S.discStrap !== null) {
        graphics.lineStyle(1.2, S.discStrap, (S.goldTop ? 0.55 : 0.8) * alpha);
        graphics.strokeEllipse(cx, cy - 6.5, 25.2, 12.6);
    }
    graphics.fillStyle(0x2b2624, alpha);
    graphics.fillCircle(cx, cy - 6.5, 2.1); // pivot hub peeking under the breech

    // ---------------- 2. FIXED ACCESSORY (does not rotate with aim) ----------------
    if (S.pile === 'keg') {
        const kx = cx - 13.5, kyT = cy + 0.4, kyB = cy + 6.4;
        graphics.fillStyle(0x6a4c2b, alpha);
        graphics.fillRect(kx - 4.4, kyT, 8.8, kyB - kyT);
        graphics.fillEllipse(kx, kyB, 8.8, 4.4);
        graphics.fillStyle(0x8a6a3e, alpha);
        graphics.fillEllipse(kx, kyT, 8.8, 4.4);
        graphics.fillStyle(0x54381f, 0.9 * alpha);
        graphics.fillEllipse(kx, kyT, 5.6, 2.8); // open powder mouth
        graphics.lineStyle(1, 0x3a3430, 0.9 * alpha);
        graphics.lineBetween(kx - 4.4, kyT + 2.4, kx + 4.4, kyT + 2.4);
        graphics.lineBetween(kx - 4.4, kyB - 1.6, kx + 4.4, kyB - 1.6);
    } else {
        const balls = S.pile === 'balls3' ? BALLS3 : BALLS4;
        for (let i = 0; i < balls.length; i++) {
            const [bx, by] = balls[i];
            const gold = S.goldTop && i === balls.length - 1;
            graphics.fillStyle(gold ? 0x9a7c2c : 0x363a40, alpha);
            graphics.fillCircle(cx + bx, cy + by, 2.7);
            graphics.fillStyle(gold ? 0xd9b64a : 0x596069, alpha);
            graphics.fillCircle(cx + bx - 0.9, cy + by - 0.9, 0.9);
        }
    }

    // ---------------- 3. TRUNNION CHEEKS (rotation-proof far/near split) ----------------
    const sN = cosA >= 0 ? 1 : -1; // near (screen-down) side sign across the aim
    const cheek = (s: number, near: boolean) => {
        const b1 = pt3(-4.6, s * 8.4, -4.5), b2 = pt3(6.6, s * 8.4, -4.5);
        const t2 = pt3(4.8, s * 6.6, -17.5), t1 = pt3(-3.0, s * 6.6, -17.5);
        graphics.fillStyle(S.cheekFace, alpha);
        graphics.fillPoints([b1, b2, t2, t1], true);
        if (!near) {
            graphics.fillStyle(0x000000, 0.20 * alpha);
            graphics.fillPoints([b1, b2, t2, t1], true);
        }
        graphics.lineStyle(1.2, S.cheekEdge, 0.9 * alpha);
        strokeRun(graphics, [b1, b2, t2, t1, b1]);
        if (S.cheekCap !== null) {
            graphics.lineStyle(1.8, S.cheekCap, 0.9 * alpha);
            graphics.lineBetween(t1.x, t1.y, t2.x, t2.y);
        }
        const pin = pt3(1.5, s * 7.0, -14); // trunnion pin holds the tube
        graphics.fillStyle(0x2f2b28, alpha);
        graphics.fillCircle(pin.x, pin.y, 1.9);
        graphics.fillStyle(0x57504a, alpha);
        graphics.fillCircle(pin.x - 0.5, pin.y - 0.5, 0.8);
    };

    // ---------------- 4. LINSTOCK ARM (idle sway + ember pulse + fire anticipation) ----------------
    const drawArm = () => {
        const dV0 = dBv + 2.5;
        const wV = widthAt(dV0);
        const ventT = axis0(dV0); // arm tracks the carriage, not the recoiling tube
        const ventTop = { x: ventT.x + nx * (wV + 0.6), y: ventT.y + ny * (wV + 0.6) };
        const sway = 2.3 * Math.sin(TAU * t / IDLE_P);          // harmonic k=1
        const hover = 1.0 + 3.6 * (1 - dip);                    // lifts at the blast, redips on reload
        const ux = cosA / vLen, uy = (0.5 * sinA) / vLen;       // along-aim screen unit
        const tip = { x: ventTop.x + nx * hover + ux * sway, y: ventTop.y + ny * hover + uy * sway };
        const base = pt3(Math.max(-11, dBv - 2.5), 3.2, -4.2);
        const post = { x: base.x + (tip.x - base.x) * 0.25, y: base.y - 11.5 };
        graphics.lineStyle(1.8, 0x35302b, alpha);
        strokeRun(graphics, [base, post]);
        graphics.lineStyle(1.4, 0x35302b, alpha);
        strokeRun(graphics, [post, tip]);
        graphics.fillStyle(0x5c4326, alpha);
        graphics.fillCircle(tip.x, tip.y, 1.5); // coiled slow-match head
        const e = 0.5 + 0.5 * Math.sin(TAU * 2 * t / IDLE_P);   // harmonic k=2 ember pulse
        const scale = 1 + 1.6 * flash + 0.5 * vent;
        const emb = { x: tip.x + (ventTop.x - tip.x) * 0.18, y: tip.y + (ventTop.y - tip.y) * 0.18 + 0.6 };
        graphics.fillStyle(0xff8a30, (0.20 + 0.16 * e) * alpha);
        graphics.fillCircle(emb.x, emb.y, 3.0 * scale);         // halo
        graphics.fillStyle(mixCol(0xff7222, 0xffc964, e), alpha);
        graphics.fillCircle(emb.x, emb.y, 1.5 * scale);         // core
    };

    // ---------------- 5. THE TUBE (volumetric capsule) ----------------
    const drawBarrel = () => {
        const topE = edge(1), botE = edge(-1);
        graphics.fillStyle(S.bBody, alpha);
        graphics.fillPoints(poly(topE, botE), true);
        // pot breech + cascabel knob
        const bc = axis(dBv);
        graphics.fillCircle(bc.x, bc.y, S.wB * 0.86 * wBoost);
        const knob = axis(dBv - S.wB * 0.75);
        graphics.fillCircle(knob.x, knob.y, 1.7);
        // belly shadow / top light
        graphics.fillStyle(S.bBelly, 0.95 * alpha);
        graphics.fillPoints(poly(edge(-0.22), botE), true);
        graphics.fillCircle(bc.x - nx * S.wB * 0.34, bc.y - ny * S.wB * 0.34, S.wB * 0.58 * wBoost);
        graphics.fillStyle(S.bTop, 0.9 * alpha);
        graphics.fillPoints(poly(edge(0.78), edge(0.36)), true);
        if (flash > 0) { // blast heat wash on the lit flank
            graphics.fillStyle(0xffb050, 0.30 * flash * alpha);
            graphics.fillPoints(poly(edge(0.78), edge(0.36)), true);
        }
        // bands (hemp rope at L1, metal hoops above)
        for (const rd of S.rings) {
            graphics.fillStyle(S.bRing, alpha);
            graphics.fillPoints(ringQuad(rd, S.ringThick), true);
            if (S.ringIsRope) {
                const m0 = axis(rd), w1 = widthAt(rd) + S.ringOver;
                graphics.lineStyle(0.9, 0x6b5230, 0.9 * alpha);
                graphics.lineBetween(m0.x + nx * w1, m0.y + ny * w1, m0.x - nx * w1, m0.y - ny * w1);
            }
        }
        graphics.fillStyle(S.bRing, alpha);
        graphics.fillPoints(ringQuad(26.4, 0.9), true); // muzzle flare band
        // idle glint sliding along the tube (harmonic k=1)
        const dG = 8 + 10 * Math.sin(TAU * t / IDLE_P);
        const wg = widthAt(dG);
        const g0 = axis(dG - 1.8), g1 = axis(dG + 1.8);
        graphics.fillStyle(0xfff0c2, 0.5 * alpha);
        graphics.fillPoints([
            { x: g0.x + nx * wg * 0.76, y: g0.y + ny * wg * 0.76 },
            { x: g1.x + nx * wg * 0.76, y: g1.y + ny * wg * 0.76 },
            { x: g1.x + nx * wg * 0.42, y: g1.y + ny * wg * 0.42 },
            { x: g0.x + nx * wg * 0.42, y: g0.y + ny * wg * 0.42 },
        ], true);
        // muzzle face — disc perpendicular to the aim (edge-on when sideways)
        const T = axis(28);
        const uxm = PXa(1), uym = PYa(1);
        const rL = S.wTip * wBoost, rV = S.wTip * 0.72 * wBoost;
        const lipPts: Pt[] = [];
        for (let i = 0; i < 12; i++) {
            const th = (i / 12) * TAU;
            lipPts.push({ x: T.x + uxm * rL * Math.cos(th), y: T.y + uym * rL * Math.cos(th) - rV * Math.sin(th) });
        }
        if (sinA > 0.05) {
            graphics.fillStyle(S.bLip, alpha);
            graphics.fillPoints(lipPts, true);
            const boreC = heat > 0 ? mixCol(S.bore, 0xff8a2a, heat) : S.bore;
            graphics.fillStyle(boreC, alpha);
            graphics.fillPoints(lipPts.map(p => ({ x: T.x + (p.x - T.x) * 0.55, y: T.y + (p.y - T.y) * 0.55 })), true);
            if (flash > 0) {
                graphics.fillStyle(0xfff3cf, 0.9 * flash * alpha);
                graphics.fillCircle(T.x, T.y, rL * 0.5 * flash + 1);
                graphics.lineStyle(1.8, 0xffe0a0, 0.85 * flash * alpha);
                strokeRun(graphics, [...lipPts, lipPts[0]]);
            }
        } else if (flash > 0) {
            graphics.fillStyle(0xffe0a0, 0.7 * flash * alpha);
            graphics.fillCircle(T.x, T.y, 1.8 + 1.4 * flash);
        }
        // touch-hole spark fountain right after the shot
        if (vent > 0) {
            const vp0 = axis(dBv + 2.5), wv = widthAt(dBv + 2.5);
            const vp = { x: vp0.x + nx * (wv + 0.4), y: vp0.y + ny * (wv + 0.4) };
            graphics.fillStyle(0xffd27a, 0.85 * vent * alpha);
            graphics.fillCircle(vp.x, vp.y, 1.5 + 1.6 * vent);
            graphics.lineStyle(1.1, 0xffb050, 0.7 * vent * alpha);
            for (const sa of [-0.9, 0.2, 1.2]) {
                graphics.lineBetween(vp.x, vp.y,
                    vp.x + Math.cos(sa - Math.PI / 2) * (3 + 3 * vent),
                    vp.y + Math.sin(sa - Math.PI / 2) * (3 + 3 * vent) * 0.7);
            }
        }
    };

    // ---------------- 6. ELEVATION HANDWHEEL (L3+, quarter-turn per period) ----------------
    const drawCrank = () => {
        const C = pt3(4.4, sN * 8.6, -11);
        const r = 3.9;
        graphics.lineStyle(1.1, S.crankCol!, 0.9 * alpha);
        graphics.strokeEllipse(C.x, C.y, r * 2, r * 1.6);
        const th0 = (Math.PI / 2) * (t / IDLE_P); // 4-fold wheel: loop-exact per IDLE_P
        graphics.lineStyle(1.4, S.crankCol!, alpha);
        for (let k = 0; k < 4; k++) {
            const th = th0 + k * Math.PI / 2;
            graphics.lineBetween(C.x, C.y, C.x + Math.cos(th) * r, C.y + Math.sin(th) * r * 0.8);
        }
        graphics.fillStyle(0x2f2b28, alpha);
        graphics.fillCircle(C.x, C.y, 1.3);
    };

    // ---------------- ASSEMBLY (aim-aware layering) ----------------
    cheek(-sN, false);                 // far cheek
    if (sinA >= 0) drawArm();          // breech far (up-screen) -> arm behind tube
    drawBarrel();
    if (sinA < 0) drawArm();           // breech near -> arm in front
    cheek(sN, true);                   // near cheek
    if (S.crankCol !== null) drawCrank();
    if (S.finial) {
        const f = pt3(0.9, sN * 6.6, -18.6);
        graphics.fillStyle(0xdaa520, alpha);
        graphics.fillCircle(f.x, f.y, 1.7);
        graphics.fillStyle(0xfff3c4, 0.9 * alpha);
        graphics.fillCircle(f.x - 0.6, f.y - 0.6, 0.6);
    }
}
