import type Phaser from 'phaser';

type G = Phaser.GameObjects.Graphics;
type GolemDeathType = 'golem' | 'icegolem';

interface Pt {
    x: number;
    y: number;
}

interface V3 {
    f: number;
    r: number;
    h: number;
}

type Footprint = Array<[number, number]>;

interface Tones {
    top: number;
    lit: number;
    mid: number;
    dark: number;
}

interface Projection {
    ca: number;
    sa: number;
    p: (f: number, r: number, h: number) => Pt;
    sx: (f: number, r: number) => number;
    depth: (f: number, r: number) => number;
}

interface Part {
    d: number;
    draw: () => void;
}

const ROCK_JITTER = [1, 0.88, 1.07, 0.91, 1.04, 0.86, 0.99, 1.06, 0.92, 1.03, 0.87, 1.05];

const clamp01 = (v: number): number => (v <= 0 ? 0 : v >= 1 ? 1 : v);
const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

/** Smooth, deterministic stage gate. Its result is pinned by `phase` only. */
function stage(phase: number, start: number, end: number): number {
    const t = clamp01((phase - start) / Math.max(0.0001, end - start));
    return t * t * (3 - 2 * t);
}

function projection(angle: number, groundY: number): Projection {
    const a = Number.isFinite(angle) ? angle : 0.6;
    const ca = Math.cos(a);
    const sa = Math.sin(a);
    return {
        ca,
        sa,
        p: (f, r, h) => ({
            x: ca * f - sa * r,
            y: groundY + (sa * f + ca * r) * 0.5 - h,
        }),
        sx: (f, r) => ca * f - sa * r,
        depth: (f, r) => sa * f + ca * r,
    };
}

function quad(g: G, a: Pt, b: Pt, c: Pt, d: Pt, color: number, alpha = 1): void {
    if (alpha <= 0.001) return;
    g.fillStyle(color, alpha);
    g.beginPath();
    g.moveTo(a.x, a.y);
    g.lineTo(b.x, b.y);
    g.lineTo(c.x, c.y);
    g.lineTo(d.x, d.y);
    g.closePath();
    g.fillPath();
}

function rotateFootprint(points: Footprint, angle: number): Footprint {
    if (Math.abs(angle) < 0.0001) return points.map(([f, r]) => [f, r]);
    const c = Math.cos(angle);
    const s = Math.sin(angle);
    return points.map(([f, r]) => [f * c - r * s, f * s + r * c]);
}

function rect8(hf: number, hr: number): Footprint {
    return [
        [hf, -hr], [hf, 0], [hf, hr], [0, hr],
        [-hf, hr], [-hf, 0], [-hf, -hr], [0, -hr],
    ];
}

function berg8(hf: number, hr: number, spin: number, seed: number): Footprint {
    const j = (n: number): number => ROCK_JITTER[(seed + n) % ROCK_JITTER.length];
    const raw: Footprint = [
        [hf * j(0), -hr * 0.72 * j(1)],
        [hf * 0.9 * j(2), hr * 0.28 * j(3)],
        [hf * 0.48 * j(4), hr * j(5)],
        [-hf * 0.22 * j(6), hr * 0.92 * j(7)],
        [-hf * j(8), hr * 0.38 * j(9)],
        [-hf * 0.88 * j(10), -hr * 0.46 * j(11)],
        [-hf * 0.28 * j(1), -hr * j(3)],
        [hf * 0.48 * j(5), -hr * 0.94 * j(7)],
    ];
    return rotateFootprint(raw, spin);
}

function morphFootprint(a: Footprint, b: Footprint, t: number): Footprint {
    return a.map(([af, ar], i) => [lerp(af, b[i][0], t), lerp(ar, b[i][1], t)]);
}

/** Heading-aware extruded stone/ice block. Visible faces are selected from
 *  their outward normals, so the volume survives all sixteen headings. */
function prism(
    g: G,
    rig: Projection,
    center: V3,
    thickness: number,
    footprint: Footprint,
    tones: Tones,
    alpha = 1,
): void {
    if (thickness <= 0.05 || alpha <= 0.001) return;
    const h0 = center.h - thickness * 0.5;
    const h1 = center.h + thickness * 0.5;
    const top = footprint.map(([f, r]) => rig.p(center.f + f, center.r + r, h1));
    const bottom = footprint.map(([f, r]) => rig.p(center.f + f, center.r + r, h0));

    for (let i = 0; i < footprint.length; i++) {
        const j = (i + 1) % footprint.length;
        const ef = footprint[j][0] - footprint[i][0];
        const er = footprint[j][1] - footprint[i][1];
        const nf = er;
        const nr = -ef;
        const toward = rig.depth(nf, nr);
        if (toward <= 0.02) continue;
        const nx = rig.sx(nf, nr);
        const nLen = Math.hypot(nx, toward * 0.5) || 1;
        const lightSide = nx / nLen;
        const color = lightSide < -0.34 ? tones.lit : lightSide > 0.34 ? tones.dark : tones.mid;
        quad(g, top[i], top[j], bottom[j], bottom[i], color, alpha);
    }

    g.fillStyle(tones.top, alpha);
    g.beginPath();
    g.moveTo(top[0].x, top[0].y);
    for (let i = 1; i < top.length; i++) g.lineTo(top[i].x, top[i].y);
    g.closePath();
    g.fillPath();
}

/** Opaque inset face color: the ice renderer's fake-translucency language. */
function insetFaceGlow(
    g: G,
    rig: Projection,
    center: V3,
    thickness: number,
    footprint: Footprint,
    color: number,
    hot: number,
    alpha: number,
): void {
    if (alpha <= 0.02) return;
    const h0 = center.h - thickness * 0.28;
    const h1 = center.h + thickness * 0.28;
    for (let i = 0; i < footprint.length; i++) {
        const j = (i + 1) % footprint.length;
        const ef = footprint[j][0] - footprint[i][0];
        const er = footprint[j][1] - footprint[i][1];
        if (rig.depth(er, -ef) <= 0.02) continue;
        const a: [number, number] = [lerp(footprint[i][0], footprint[j][0], 0.3), lerp(footprint[i][1], footprint[j][1], 0.3)];
        const b: [number, number] = [lerp(footprint[j][0], footprint[i][0], 0.3), lerp(footprint[j][1], footprint[i][1], 0.3)];
        quad(
            g,
            rig.p(center.f + a[0], center.r + a[1], h0),
            rig.p(center.f + b[0], center.r + b[1], h0),
            rig.p(center.f + b[0], center.r + b[1], h1),
            rig.p(center.f + a[0], center.r + a[1], h1),
            color,
            alpha,
        );
        const c: [number, number] = [lerp(a[0], b[0], 0.4), lerp(a[1], b[1], 0.4)];
        const d: [number, number] = [lerp(b[0], a[0], 0.4), lerp(b[1], a[1], 0.4)];
        quad(
            g,
            rig.p(center.f + c[0], center.r + c[1], center.h - thickness * 0.14),
            rig.p(center.f + d[0], center.r + d[1], center.h - thickness * 0.14),
            rig.p(center.f + d[0], center.r + d[1], center.h + thickness * 0.14),
            rig.p(center.f + c[0], center.r + c[1], center.h + thickness * 0.14),
            hot,
            alpha * 0.62,
        );
    }
}

function visibleBand(
    g: G,
    rig: Projection,
    center: V3,
    footprint: Footprint,
    height: number,
    width: number,
    color: number,
    alpha = 1,
): void {
    if (alpha <= 0.001) return;
    for (let i = 0; i < footprint.length; i++) {
        const j = (i + 1) % footprint.length;
        const ef = footprint[j][0] - footprint[i][0];
        const er = footprint[j][1] - footprint[i][1];
        if (rig.depth(er, -ef) <= 0.02) continue;
        quad(
            g,
            rig.p(center.f + footprint[i][0], center.r + footprint[i][1], height - width * 0.5),
            rig.p(center.f + footprint[j][0], center.r + footprint[j][1], height - width * 0.5),
            rig.p(center.f + footprint[j][0], center.r + footprint[j][1], height + width * 0.5),
            rig.p(center.f + footprint[i][0], center.r + footprint[i][1], height + width * 0.5),
            color,
            alpha,
        );
    }
}

function taperedLink(g: G, a: Pt, b: Pt, wa: number, wb: number, color: number, alpha: number): void {
    if (alpha <= 0.01) return;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len = Math.hypot(dx, dy) || 1;
    const nx = -dy / len;
    const ny = dx / len;
    quad(
        g,
        { x: a.x + nx * wa, y: a.y + ny * wa },
        { x: b.x + nx * wb, y: b.y + ny * wb },
        { x: b.x - nx * wb, y: b.y - ny * wb },
        { x: a.x - nx * wa, y: a.y - ny * wa },
        color,
        alpha,
    );
}

/** Fixed-seed hewn boulder. No runtime random source participates. */
function rock(
    g: G,
    center: Pt,
    rx: number,
    ry: number,
    seed: number,
    tilt: number,
    tones: Tones,
): void {
    const count = 7;
    const points: Pt[] = [];
    for (let i = 0; i < count; i++) {
        const a = tilt + (i / count) * Math.PI * 2;
        const j = ROCK_JITTER[(i + seed) % ROCK_JITTER.length];
        points.push({ x: center.x + Math.cos(a) * rx * j, y: center.y + Math.sin(a) * ry * j });
    }
    g.fillStyle(tones.mid, 1);
    g.beginPath();
    g.moveTo(points[0].x, points[0].y);
    for (let i = 1; i < points.length; i++) g.lineTo(points[i].x, points[i].y);
    g.closePath();
    g.fillPath();

    const inward = (p: Pt, t: number): Pt => ({ x: lerp(p.x, center.x, t), y: lerp(p.y, center.y, t) });
    quad(g, points[0], points[1], inward(points[1], 0.55), inward(points[0], 0.4), tones.dark, 0.84);
    quad(g, points[4], points[5], inward(points[5], 0.34), inward(points[4], 0.34), tones.lit, 0.82);
}

function glowChip(g: G, p: Pt, radius: number, glow: number, hot: number, alpha: number): void {
    if (alpha <= 0.01) return;
    g.fillStyle(glow, alpha * 0.24);
    g.fillCircle(p.x, p.y, radius * 1.9);
    g.fillStyle(glow, alpha);
    g.fillCircle(p.x, p.y, radius);
    g.fillStyle(hot, alpha);
    g.fillCircle(p.x, p.y, radius * 0.42);
}

function move(start: V3, end: V3, t: number, arc = 0): V3 {
    return {
        f: lerp(start.f, end.f, t),
        r: lerp(start.r, end.r, t),
        h: lerp(start.h, end.h, t) + Math.sin(Math.PI * t) * arc,
    };
}

function middle(a: V3, b: V3, t: number): V3 {
    return { f: lerp(a.f, b.f, t), r: lerp(a.r, b.r, t), h: lerp(a.h, b.h, t) };
}

function progressiveStroke(g: G, points: Pt[], progress: number, width: number, color: number, alpha: number): void {
    if (points.length < 2 || progress <= 0.001 || alpha <= 0.001) return;
    const lengths: number[] = [];
    let total = 0;
    for (let i = 1; i < points.length; i++) {
        const len = Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y);
        lengths.push(len);
        total += len;
    }
    let remaining = total * clamp01(progress);
    g.lineStyle(width, color, alpha);
    g.beginPath();
    g.moveTo(points[0].x, points[0].y);
    for (let i = 1; i < points.length && remaining > 0; i++) {
        const len = lengths[i - 1];
        const t = len > 0 ? Math.min(1, remaining / len) : 1;
        g.lineTo(lerp(points[i - 1].x, points[i].x, t), lerp(points[i - 1].y, points[i].y, t));
        remaining -= len;
    }
    g.strokePath();
}

// ---------------------------------------------------------------- stone golem

interface StonePalette extends Tones {
    glow: number;
    hot: number;
    moss: number;
    metal: number;
    metalHi: number;
}

function stonePalette(isPlayer: boolean, level: number): StonePalette {
    if (level >= 3) {
        return isPlayer
            ? { top: 0xd8cfb6, lit: 0xbfb49a, mid: 0xbfb49a, dark: 0x8d8164, glow: 0x6fd0ff, hot: 0xdff4ff, moss: 0x8a7f5e, metal: 0xdaa520, metalHi: 0xffd700 }
            : { top: 0xc9bda3, lit: 0xb1a286, mid: 0xb1a286, dark: 0x80725a, glow: 0xff9440, hot: 0xffe6c0, moss: 0x8a7150, metal: 0xdaa520, metalHi: 0xffd700 };
    }
    if (level === 2) {
        return isPlayer
            ? { top: 0xa2a29b, lit: 0x83837d, mid: 0x83837d, dark: 0x585853, glow: 0x6fd0ff, hot: 0xdff4ff, moss: 0x66714a, metal: 0x474b52, metalHi: 0x8b95a2 }
            : { top: 0x998c80, lit: 0x7c7064, mid: 0x7c7064, dark: 0x524940, glow: 0xff9440, hot: 0xffe6c0, moss: 0x74653c, metal: 0x474b52, metalHi: 0x8b95a2 };
    }
    return isPlayer
        ? { top: 0xb4b1a1, lit: 0x94917f, mid: 0x94917f, dark: 0x655f4f, glow: 0x6fd0ff, hot: 0xdff4ff, moss: 0x7f915a, metal: 0, metalHi: 0 }
        : { top: 0xa89b8d, lit: 0x8c7f70, mid: 0x8c7f70, dark: 0x5e5245, glow: 0xff9440, hot: 0xffe6c0, moss: 0x8f7e4c, metal: 0, metalHi: 0 };
}

const STONE_TORSO: Footprint = [
    [9.5, -14.1], [9.7, 0], [8.8, 15.5], [-8.3, 14.6], [-9.9, 0], [-9.2, -15.2],
];
const STONE_CAP: Footprint = [
    [8.3, -18], [8.7, 0], [7.6, 20.2], [0, 20.4], [-8.2, 18.5], [-8.5, 0], [-7.5, -19.9], [0, -20],
];
const STONE_MAUL: Footprint = [[6.3, -5], [5.8, 5.6], [-5.6, 5.3], [-6.2, -5.5]];

function drawStoneDeath(g: G, isPlayer: boolean, level: number, angle: number, phase: number): void {
    const rig = projection(angle, 11);
    const pal = stonePalette(isPlayer, level);
    const bond = 1 - stage(phase, 0, 0.24); // eye and every rune are dead by the first quarter
    const crack = stage(phase, 0.03, 0.3);
    const parts: Part[] = [];

    // A single contact shadow widens as the monument becomes a low cairn.
    g.fillStyle(0x000000, 0.27);
    g.fillEllipse(0, 12, lerp(46, 56, stage(phase, 0.12, 0.82)), lerp(16, 13, stage(phase, 0.12, 0.82)));

    const legT = stage(phase, 0.2, 0.8);
    for (const side of [-1, 1] as const) {
        const leg = move({ f: 0, r: side * 9.5, h: 6.5 }, { f: -5 + side * 1.5, r: side * 10.5, h: 3.5 }, legT, 0.8);
        parts.push({
            d: rig.depth(leg.f, leg.r) - 0.04,
            draw: () => {
                const foot = rig.p(lerp(0, -4, legT), side * lerp(10, 12, legT), 1.2);
                g.fillStyle(0x3a342c, 0.9);
                g.fillEllipse(foot.x, foot.y, 13, 4.8);
                rock(g, rig.p(leg.f, leg.r, leg.h), 6, 5.2, side < 0 ? 2 : 7, 0.22 + side * legT * 0.25, pal);
            },
        });
    }

    const pelvisT = stage(phase, 0.1, 0.72);
    const torsoT = stage(phase, 0.1, 0.74);
    const capT = stage(phase, 0.17, 0.77);
    const headT = stage(phase, 0.18, 0.63);
    const pelvis = move({ f: 0, r: 0, h: 17 }, { f: 0, r: 1, h: 5.7 }, pelvisT);
    const torso = move({ f: 1, r: 0, h: 31 }, { f: -1.5, r: -0.5, h: 9.4 }, torsoT, 1.2);
    const cap = move({ f: 4.5, r: 0, h: 45 }, { f: -5, r: 1.5, h: 13.2 }, capT, 2.2);
    const head = move({ f: 13, r: 0, h: 42 }, { f: 11.5, r: -3.5, h: 8.2 }, headT, 2.8);
    const torsoThickness = lerp(15, 7, torsoT);
    const capThickness = lerp(7, 5.2, capT);

    parts.push({
        d: rig.depth(pelvis.f, pelvis.r),
        draw: () => {
            rock(g, rig.p(pelvis.f, pelvis.r, pelvis.h), lerp(11, 9.5, pelvisT), lerp(8, 6.2, pelvisT), 3, 0.15 + pelvisT * 0.4, pal);
            if (level === 1) {
                const m = rig.p(pelvis.f - 2, pelvis.r - 2, pelvis.h - 1);
                g.fillStyle(pal.moss, 0.78);
                g.fillEllipse(m.x, m.y, 6.4, 2.4);
            }
        },
    });

    parts.push({
        d: rig.depth(torso.f, torso.r) + 0.01,
        draw: () => {
            if (bond > 0.01) {
                const seam = rig.p(torso.f, torso.r, torso.h - torsoThickness * 0.55);
                g.fillStyle(pal.glow, bond * 0.34);
                g.fillEllipse(seam.x, seam.y, 25, 3.8);
                g.fillStyle(pal.hot, bond * 0.38);
                g.fillEllipse(seam.x, seam.y, 14, 1.8);
            }
            prism(g, rig, torso, torsoThickness, STONE_TORSO, pal);
            if (level === 1) {
                const m = rig.p(torso.f - 2, torso.r - 7, torso.h + torsoThickness * 0.5 + 0.2);
                g.fillStyle(pal.moss, 0.74);
                g.fillEllipse(m.x, m.y, 6, 2.2);
            } else {
                visibleBand(g, rig, torso, STONE_TORSO, torso.h - torsoThickness * 0.12, level >= 3 ? 1.4 : 2.3, pal.metal, 0.95);
            }
            const faceF = torso.f + (rig.sa >= 0 ? 9.7 : -9.7);
            if (Math.abs(rig.sa) > 0.06) {
                progressiveStroke(g, [
                    rig.p(faceF, torso.r - 4, torso.h + torsoThickness * 0.25),
                    rig.p(faceF, torso.r - 1, torso.h),
                    rig.p(faceF, torso.r - 3, torso.h - torsoThickness * 0.24),
                    rig.p(faceF, torso.r + 2, torso.h - torsoThickness * 0.42),
                ], crack, 1.25, pal.dark, 0.82);
            }
            if (rig.sa < -0.1 && bond > 0.01) {
                const bf = torso.f - 10;
                progressiveStroke(g, [rig.p(bf, torso.r, torso.h - 5), rig.p(bf, torso.r, torso.h + 6)], 1, 1.6, pal.glow, bond * 0.65);
            }
        },
    });

    parts.push({
        d: rig.depth(cap.f, cap.r) + 0.02,
        draw: () => {
            if (bond > 0.01) {
                const seam = rig.p(cap.f - 1, cap.r, cap.h - capThickness * 0.62);
                g.fillStyle(pal.glow, bond * 0.42);
                g.fillEllipse(seam.x, seam.y, 32, 4.2);
                g.fillStyle(pal.hot, bond * 0.44);
                g.fillEllipse(seam.x, seam.y, 18, 1.8);
            }
            prism(g, rig, cap, capThickness, STONE_CAP, pal);
            if (level === 1) {
                const m = rig.p(cap.f - 2, cap.r - 9, cap.h + capThickness * 0.5 + 0.2);
                g.fillStyle(pal.moss, 0.86);
                g.fillEllipse(m.x, m.y, 5.5, 2);
            } else if (level === 2) {
                for (const r of [-14, 14]) {
                    const b = rig.p(cap.f + 1, cap.r + r, cap.h + capThickness * 0.5);
                    const tip = rig.p(cap.f + 1, cap.r + r, cap.h + capThickness * 0.5 + 6);
                    g.fillStyle(pal.dark, 1);
                    g.fillTriangle(b.x - 3, b.y, b.x + 3, b.y, tip.x, tip.y);
                }
            } else {
                visibleBand(g, rig, cap, STONE_CAP, cap.h, 1.25, pal.metal, 0.92);
                for (const r of [-15, 15]) {
                    const stud = rig.p(cap.f + 1.5, cap.r + r, cap.h + capThickness * 0.5 + 0.4);
                    g.fillStyle(pal.metalHi, 0.92);
                    g.fillCircle(stud.x, stud.y, 1.2);
                }
            }
            const crackFace = cap.f + (rig.sa >= 0 ? 8.5 : -8.5);
            if (Math.abs(rig.sa) > 0.06) {
                progressiveStroke(g, [
                    rig.p(crackFace, cap.r - 7, cap.h + 1.5),
                    rig.p(crackFace, cap.r - 2, cap.h - 0.5),
                    rig.p(crackFace, cap.r + 3, cap.h + 1),
                ], crack, 1.15, pal.dark, 0.72);
            }
        },
    });

    parts.push({
        d: rig.depth(head.f, head.r) + 0.035,
        draw: () => {
            const hp = rig.p(head.f, head.r, head.h);
            rock(g, hp, 6.4, 5.6, 9, 0.1 + headT * 0.75, pal);
            if (rig.sa > 0.1) {
                for (const r of [-2.4, 2.4]) {
                    const eye = rig.p(head.f + 4.8, head.r + r, head.h + 0.5);
                    g.fillStyle(0x1c1a16, 0.9);
                    g.fillEllipse(eye.x, eye.y, 4.2, 3.1);
                    glowChip(g, eye, 1.35, pal.glow, pal.hot, bond);
                }
            } else if (rig.sa >= -0.1) {
                const eye = rig.p(head.f + 4.2, head.r, head.h + 0.5);
                g.fillStyle(0x1c1a16, 0.9);
                g.fillEllipse(eye.x, eye.y, 3.8, 3);
                glowChip(g, eye, 1.25, pal.glow, pal.hot, bond);
            }
        },
    });

    // The bond fails first; unsupported arm-stones then peel away and fall
    // independently, reading as a ruined monument instead of a ragdoll.
    const armT = stage(phase, 0.07, 0.67);
    for (const side of [-1, 1] as const) {
        const shoulderStart: V3 = { f: 2, r: side > 0 ? 18.5 : -18, h: 39 };
        const fistStart: V3 = side > 0 ? { f: 8.5, r: 20, h: 7 } : { f: 7, r: -19, h: 7.5 };
        const bicepStart = middle(shoulderStart, fistStart, 0.4);
        const foreStart = middle(shoulderStart, fistStart, 0.72);
        const shoulderEnd: V3 = { f: -7 + side * 1.5, r: side * 20.5, h: 5.2 };
        const bicepEnd: V3 = { f: -1 + side, r: side * 24, h: 4.1 };
        const foreEnd: V3 = { f: 6 + side, r: side * 27, h: 3.6 };
        const fistEnd: V3 = { f: 13 + side, r: side * 24.5, h: side > 0 ? 5.1 : 4.4 };
        const shoulder = move(shoulderStart, shoulderEnd, armT, 2.8);
        const bicep = move(bicepStart, bicepEnd, armT, 2.2);
        const fore = move(foreStart, foreEnd, armT, 1.7);
        const fist = move(fistStart, fistEnd, armT, 1.1);

        if (armT < 0.7) {
            const joints: V3[] = [shoulder, bicep, fore, fist];
            for (let i = 1; i < joints.length; i++) {
                const a = rig.p(joints[i - 1].f, joints[i - 1].r, joints[i - 1].h);
                const b = rig.p(joints[i].f, joints[i].r, joints[i].h);
                parts.push({
                    d: (rig.depth(joints[i - 1].f, joints[i - 1].r) + rig.depth(joints[i].f, joints[i].r)) * 0.5 - 0.03,
                    draw: () => {
                        taperedLink(g, a, b, 2.8, 2.4, pal.dark, 1 - stage(phase, 0.08, 0.42));
                        if (bond > 0.01) glowChip(g, { x: (a.x + b.x) * 0.5, y: (a.y + b.y) * 0.5 }, 1.25, pal.glow, pal.hot, bond * 0.8);
                    },
                });
            }
        }

        const stones: Array<[V3, number, number, number]> = [
            [shoulder, 6.3, 5.4, side > 0 ? 1 : 5],
            [bicep, side > 0 ? 6.4 : 5.3, side > 0 ? 5.6 : 4.8, side > 0 ? 1 : 5],
            [fore, side > 0 ? 5.5 : 4.7, side > 0 ? 4.9 : 4.2, side > 0 ? 6 : 8],
        ];
        for (const [pos, rx, ry, seed] of stones) {
            parts.push({
                d: rig.depth(pos.f, pos.r),
                draw: () => rock(g, rig.p(pos.f, pos.r, pos.h), rx, ry, seed, side * 0.12 + armT * side * 0.55, pal),
            });
        }

        if (side > 0) {
            const spunMaul = rotateFootprint(STONE_MAUL, armT * 0.62);
            parts.push({
                d: rig.depth(fist.f, fist.r) + 0.01,
                draw: () => {
                    prism(g, rig, fist, lerp(11, 9, armT), spunMaul, pal);
                    if (level >= 2) visibleBand(g, rig, fist, spunMaul, fist.h, level >= 3 ? 1.3 : 2, pal.metal, 0.95);
                    if (bond > 0.01) glowChip(g, rig.p(fist.f, fist.r, fist.h + 4), 1.2, pal.glow, pal.hot, bond);
                },
            });
        } else {
            parts.push({
                d: rig.depth(fist.f, fist.r) + 0.01,
                draw: () => rock(g, rig.p(fist.f, fist.r, fist.h), 6.6, 6, 4, 0.05 - armT * 0.7, pal),
            });
        }
    }

    // Three fixed rune-gravel motes sink with the failing field, then vanish.
    if (bond > 0.01) {
        const moteAngles = [0.4, 2.5, 4.6];
        for (let i = 0; i < moteAngles.length; i++) {
            const a = moteAngles[i];
            const sink = stage(phase, 0, 0.24);
            const pos: V3 = {
                f: Math.cos(a) * lerp(17.5, 11, sink),
                r: Math.sin(a) * lerp(17.5, 11, sink),
                h: lerp(30 + (i - 1) * 2.5, 15, sink),
            };
            parts.push({
                d: rig.depth(pos.f, pos.r) + 0.015,
                draw: () => {
                    const pp = rig.p(pos.f, pos.r, pos.h);
                    glowChip(g, pp, 2.4, pal.glow, pal.hot, bond * 0.35);
                    rock(g, pp, 1.7 + i * 0.18, 1.5 + i * 0.15, i + 2, 0.2, pal);
                },
            });
        }
    }

    parts.sort((a, b) => a.d - b.d);
    for (const part of parts) part.draw();
}

// ------------------------------------------------------------------ ice golem

interface IcePalette extends Tones {
    snow: number;
    core: number;
    hot: number;
    eye: number;
    trim: number;
    trimHi: number;
    glowK: number;
}

function icePalette(isPlayer: boolean, level: number): IcePalette {
    if (level >= 3) {
        return isPlayer
            ? { top: 0xd6f0fa, lit: 0x8cc6e6, mid: 0x5694c8, dark: 0x2f62a0, snow: 0xeefaff, core: 0x6ef0ff, hot: 0xe6ffff, eye: 0xbdf6ff, trim: 0xdaa520, trimHi: 0xffd700, glowK: 0.95 }
            : { top: 0xe6dcf6, lit: 0xb094d8, mid: 0x8060b8, dark: 0x543a8c, snow: 0xf2eefa, core: 0xd67aff, hot: 0xf8e6ff, eye: 0xe6b0ff, trim: 0xdaa520, trimHi: 0xffd700, glowK: 0.95 };
    }
    if (level === 2) {
        return isPlayer
            ? { top: 0xcaeaf6, lit: 0x84bede, mid: 0x5a9ac8, dark: 0x3a70a4, snow: 0xe8f6fc, core: 0x66e4ff, hot: 0xdcfaff, eye: 0xaaeeff, trim: 0x8fb8cc, trimHi: 0xeafaff, glowK: 0.75 }
            : { top: 0xdcd2f0, lit: 0xa48cce, mid: 0x7c60b0, dark: 0x564288, snow: 0xece6f6, core: 0xce70f6, hot: 0xf2dcff, eye: 0xdca6ff, trim: 0x9c8cb4, trimHi: 0xf0e8fc, glowK: 0.75 };
    }
    return isPlayer
        ? { top: 0xd2e6ee, lit: 0x9cc2d6, mid: 0x74a0bc, dark: 0x527c9c, snow: 0xecf6fa, core: 0x5cd2f0, hot: 0xcef2fc, eye: 0x9ce6f8, trim: 0, trimHi: 0, glowK: 0.55 }
        : { top: 0xe0d8e8, lit: 0xac9cc2, mid: 0x8676a4, dark: 0x625682, snow: 0xf0eaf4, core: 0xc266e8, hot: 0xecd6f8, eye: 0xd49af2, trim: 0, trimHi: 0, glowK: 0.55 };
}

function icicleRow(
    g: G,
    rig: Projection,
    center: V3,
    footprint: Footprint,
    bottom: number,
    length: number,
    color: number,
    maxCount: number,
): void {
    if (length <= 0.4) return;
    for (let edge = 0; edge < footprint.length; edge++) {
        const next = (edge + 1) % footprint.length;
        const ef = footprint[next][0] - footprint[edge][0];
        const er = footprint[next][1] - footprint[edge][1];
        if (rig.depth(er, -ef) <= 0.02) continue;
        for (let i = 0; i < maxCount; i++) {
            const t = (i + 0.5) / maxCount;
            const f = center.f + lerp(footprint[edge][0], footprint[next][0], t);
            const r = center.r + lerp(footprint[edge][1], footprint[next][1], t);
            const width = 0.9;
            const len = length * (i % 2 === 0 ? 1 : 0.62);
            const a = rig.p(f - width, r - width * 0.35, bottom);
            const b = rig.p(f + width, r + width * 0.35, bottom);
            const tip = rig.p(f, r, bottom - len);
            g.fillStyle(color, 0.95);
            g.fillTriangle(a.x, a.y, b.x, b.y, tip.x, tip.y);
        }
    }
}

function drawIceDeath(g: G, isPlayer: boolean, level: number, angle: number, phase: number): void {
    const rig = projection(angle, 12.5);
    const pal = icePalette(isPlayer, level);
    const fracture = stage(phase, 0.02, 0.27);
    const coreLife = 1 - stage(phase, 0.08, 0.5);
    const settle = stage(phase, 0.2, 0.87);
    const parts: Part[] = [];

    g.fillStyle(0x000000, 0.3);
    g.fillEllipse(0, 12.7, lerp(42, 58, settle), lerp(16, 13, settle));

    // Pillar legs shear at their lower joints and become the two outer bergs.
    for (const side of [-1, 1] as const) {
        const t = stage(phase, 0.24 + (side > 0 ? 0.025 : 0), 0.78 + (side > 0 ? 0.025 : 0));
        const foot = move({ f: 0, r: side * 11, h: 2.25 }, { f: -4 + side, r: side * 15, h: 2.4 }, t, 0.4);
        const pillar = move({ f: 0, r: side * 11, h: 10 }, { f: -2 + side * 2, r: side * 14.5, h: 4.5 }, t, 1.2);
        const footOutline = morphFootprint(rect8(7, 6.2), berg8(6.8, 5.5, side * t * 0.28, 3 + side), t);
        const pillarOutline = morphFootprint(rect8(5.5, 5.2), berg8(5.8, 5.8, -side * t * 0.4, 6 + side), t);
        parts.push({
            d: rig.depth(foot.f, foot.r) - 0.04,
            draw: () => prism(g, rig, foot, lerp(4.5, 4, t), footOutline, pal),
        });
        parts.push({
            d: rig.depth(pillar.f, pillar.r) - 0.025,
            draw: () => {
                prism(g, rig, pillar, lerp(13, 7, t), pillarOutline, pal);
                insetFaceGlow(g, rig, pillar, lerp(13, 7, t), pillarOutline, pal.core, pal.hot, coreLife * pal.glowK * 0.2);
            },
        });
    }

    const pelvisT = stage(phase, 0.23, 0.76);
    const pelvis = move({ f: 0.5, r: 0, h: 19.8 }, { f: -4, r: 0, h: 6.5 }, pelvisT, 1.2);
    const pelvisOutline = morphFootprint(rect8(7.5, 13), berg8(8, 10, -pelvisT * 0.25, 2), pelvisT);
    const pelvisThickness = lerp(9.6, 8, pelvisT);
    parts.push({
        d: rig.depth(pelvis.f, pelvis.r),
        draw: () => {
            if (coreLife > 0.01) visibleBand(g, rig, pelvis, pelvisOutline, pelvis.h - pelvisThickness * 0.45, 1.25, pal.core, coreLife * 0.72);
            prism(g, rig, pelvis, pelvisThickness, pelvisOutline, pal);
            insetFaceGlow(g, rig, pelvis, pelvisThickness, pelvisOutline, pal.core, pal.hot, coreLife * pal.glowK * 0.28);
            if (level >= 2) icicleRow(g, rig, pelvis, pelvisOutline, pelvis.h - pelvisThickness * 0.5, lerp(level >= 3 ? 4.5 : 3.5, 1.2, pelvisT), pal.lit, 3);
        },
    });

    // The stele is built as three fitted courses. Cracks traverse them first;
    // the courses then calve on staggered beats into separate berg remnants.
    const torsoStarts: V3[] = [
        { f: 1, r: 0, h: 27.25 },
        { f: 1, r: 0, h: 34 },
        { f: 1, r: 0, h: 40.75 },
    ];
    const torsoEnds: V3[] = [
        { f: -2.5, r: -7, h: 6.2 },
        { f: 5.5, r: 7, h: 5.5 },
        { f: 0.5, r: 0.5, h: 10.2 },
    ];
    const torsoThicknesses = [6.5, 7, 6.5];
    const torsoTargetSizes: Array<[number, number]> = [[7.8, 9.5], [7, 8.2], [6.6, 8.5]];
    for (let i = 0; i < 3; i++) {
        const t = stage(phase, 0.2 + i * 0.045, 0.75 + i * 0.045);
        const pos = move(torsoStarts[i], torsoEnds[i], t, 1.5 + i * 0.5);
        const target = berg8(torsoTargetSizes[i][0], torsoTargetSizes[i][1], (i - 1) * 0.28 * t, 5 + i * 2);
        const outline = morphFootprint(rect8(8.5, 15), target, t);
        const thickness = lerp(torsoThicknesses[i], i === 2 ? 7.5 : 7, t);
        parts.push({
            d: rig.depth(pos.f, pos.r) + 0.006 * i,
            draw: () => {
                prism(g, rig, pos, thickness, outline, pal);
                insetFaceGlow(g, rig, pos, thickness, outline, pal.core, pal.hot, coreLife * pal.glowK * 0.34);
                if (level === 1) {
                    const snow = rig.p(pos.f - 1, pos.r - 3, pos.h + thickness * 0.5 + 0.15);
                    g.fillStyle(pal.snow, 0.78);
                    g.fillRect(snow.x - 2.4, snow.y - 0.8, 4.8, 1.6);
                }
            },
        });
    }

    // Capstones calve outward before the central stele finishes sinking.
    for (const side of [-1, 1] as const) {
        const t = stage(phase, 0.17 + (side > 0 ? 0.03 : 0), 0.68 + (side > 0 ? 0.03 : 0));
        const cap = move({ f: 0.5, r: side * 14.5, h: 43.25 }, { f: -2, r: side * 22, h: 5.6 }, t, 4.5);
        const outline = morphFootprint(rect8(6.5, 5.5), berg8(7.2, 6.3, side * t * 0.48, 9 + side), t);
        const thickness = lerp(10.5, 8, t);
        parts.push({
            d: rig.depth(cap.f, cap.r) + 0.025,
            draw: () => {
                prism(g, rig, cap, thickness, outline, pal);
                insetFaceGlow(g, rig, cap, thickness, outline, pal.core, pal.hot, coreLife * pal.glowK * 0.28);
                if (level >= 2) visibleBand(g, rig, cap, outline, cap.h + thickness * 0.35, level >= 3 ? 1.1 : 1.4, pal.trim, 0.96);
                if (level === 1) {
                    const snow = rig.p(cap.f, cap.r + side, cap.h + thickness * 0.5 + 0.2);
                    g.fillStyle(pal.snow, 0.92);
                    g.fillRect(snow.x - 2.2, snow.y - 1, 4.4, 2);
                }
                icicleRow(g, rig, cap, outline, cap.h - thickness * 0.5, lerp(level === 1 ? 3 : level === 2 ? 4.5 : 6, 0.8, t), pal.lit, level >= 3 ? 3 : 2);
            },
        });
    }

    const headT = stage(phase, 0.26, 0.73);
    const head = move({ f: 6.5, r: 0, h: 46.25 }, { f: 11.5, r: -2.5, h: 7.4 }, headT, 3.8);
    const headOutline = morphFootprint(rect8(4.4, 4.8), berg8(5.5, 5.6, -headT * 0.55, 11), headT);
    const headThickness = lerp(12.5, 8.5, headT);
    parts.push({
        d: rig.depth(head.f, head.r) + 0.04,
        draw: () => {
            prism(g, rig, head, headThickness, headOutline, pal);
            insetFaceGlow(g, rig, head, headThickness, headOutline, pal.core, pal.hot, coreLife * pal.glowK * 0.32);
            if (rig.sa > 0.06) {
                const hf = lerp(4.4, 5.2, headT);
                for (const r of [-2.1, 2.1]) {
                    const eye = rig.p(head.f + hf, head.r + r, head.h + 0.6);
                    g.fillStyle(0x101a26, 0.88);
                    g.fillRect(eye.x - 1.9, eye.y - 1.6, 3.8, 3.2);
                    if (coreLife > 0.01) {
                        g.fillStyle(pal.eye, coreLife);
                        g.fillRect(eye.x - 1.25, eye.y - 1, 2.5, 2);
                        g.fillStyle(pal.hot, coreLife);
                        g.fillRect(eye.x - 0.55, eye.y - 0.45, 1.1, 0.9);
                    }
                }
            }
        },
    });

    // The brow is a separate early calving slab; it lands ahead of the head.
    const browT = stage(phase, 0.14, 0.58);
    const brow = move({ f: 7, r: 0, h: 53.95 }, { f: 15.5, r: 4.5, h: 3.2 }, browT, 5.5);
    const browOutline = morphFootprint(rect8(5.2, 5.6), berg8(5.8, 5, browT * 0.7, 13), browT);
    const browThickness = lerp(2.9, 4.2, browT);
    parts.push({
        d: rig.depth(brow.f, brow.r) + 0.05,
        draw: () => {
            prism(g, rig, brow, browThickness, browOutline, pal);
            if (level >= 2) visibleBand(g, rig, brow, browOutline, brow.h, 1.05, level >= 3 ? pal.trimHi : pal.trim, 0.94);
            icicleRow(g, rig, brow, browOutline, brow.h - browThickness * 0.5, lerp(level === 1 ? 2.5 : level === 2 ? 3.5 : 4.5, 0.6, browT), pal.lit, 2);
        },
    });

    // Column arms fracture into two short bergs each. Unlike the stone
    // monument's boulder-chain fall, these pieces shear cleanly and calve.
    for (const side of [-1, 1] as const) {
        const t = stage(phase, 0.15 + (side < 0 ? 0.025 : 0), 0.64 + (side < 0 ? 0.025 : 0));
        const shoulder: V3 = { f: 1, r: side * 16.5, h: 43 };
        const fistStart: V3 = { f: 4.5, r: side * 19, h: 8.5 };
        const upperStart = middle(shoulder, fistStart, 0.38);
        const lowerStart = middle(shoulder, fistStart, 0.7);
        const upper = move(upperStart, { f: 0, r: side * 26, h: 5.2 }, t, 3.2);
        const lower = move(lowerStart, { f: 7, r: side * 27.5, h: 4.1 }, t, 2.2);
        const fist = move(fistStart, { f: 13, r: side * 23.5, h: 5 }, t, 1.6);

        if (t < 0.86) {
            const a = rig.p(shoulder.f, shoulder.r, shoulder.h);
            const b = rig.p(fist.f, fist.r, fist.h + 4);
            parts.push({
                d: (rig.depth(shoulder.f, shoulder.r) + rig.depth(fist.f, fist.r)) * 0.5 - 0.035,
                draw: () => taperedLink(g, a, b, 5, 6.2, pal.mid, 1 - stage(phase, 0.18, 0.52)),
            });
        }

        const armPieces: Array<[V3, number, number, number]> = [
            [upper, 5.4, 4.4, 15 + side],
            [lower, 5, 4.2, 18 + side],
        ];
        for (let i = 0; i < armPieces.length; i++) {
            const [pos, hf, hr, seed] = armPieces[i];
            const show = stage(phase, 0.16, 0.34);
            const outline = berg8(hf, hr, side * t * (i ? -0.5 : 0.4), seed);
            parts.push({
                d: rig.depth(pos.f, pos.r) + 0.005 * i,
                draw: () => prism(g, rig, pos, lerp(8, 6.5, t), outline, pal, show),
            });
        }

        const fistOutline = morphFootprint(rect8(6, 5.5), berg8(6.5, 5.8, side * t * 0.55, 21 + side), t);
        const fistThickness = lerp(9, 7.5, t);
        parts.push({
            d: rig.depth(fist.f, fist.r) + 0.015,
            draw: () => {
                prism(g, rig, fist, fistThickness, fistOutline, pal);
                insetFaceGlow(g, rig, fist, fistThickness, fistOutline, pal.core, pal.hot, coreLife * pal.glowK * 0.25);
                if (level >= 2) visibleBand(g, rig, fist, fistOutline, fist.h, level >= 3 ? 1.1 : 1.4, pal.trim, 0.95);
                if (level >= 3 && rig.sa > 0.03) {
                    for (const rr of [-2.3, 2.3]) {
                        const stud = rig.p(fist.f + 6, fist.r + rr, fist.h + 1.8);
                        g.fillStyle(pal.trimHi, 0.94);
                        g.fillRect(stud.x - 0.8, stud.y - 0.8, 1.6, 1.6);
                    }
                }
                icicleRow(g, rig, fist, fistOutline, fist.h - fistThickness * 0.5, lerp(level === 1 ? 2.2 : level === 2 ? 3 : 3.6, 0.5, t), pal.lit, 2);
            },
        });
    }

    // Deterministic chips calve from known fracture sites and remain as inert
    // ice teeth around the final berg field.
    const shardStarts: V3[] = [
        { f: 8, r: -12, h: 40 }, { f: 8, r: 12, h: 36 },
        { f: 1, r: -19, h: 44 }, { f: 1, r: 19, h: 42 },
        { f: -7, r: -8, h: 31 }, { f: 6, r: 7, h: 48 },
    ];
    const shardEnds: V3[] = [
        { f: 10, r: -17, h: 2.7 }, { f: 9, r: 17, h: 2.4 },
        { f: -8, r: -25, h: 3 }, { f: -5, r: 25, h: 2.6 },
        { f: -12, r: -10, h: 2.2 }, { f: 17, r: 10, h: 2.8 },
    ];
    for (let i = 0; i < shardStarts.length; i++) {
        const t = stage(phase, 0.14 + i * 0.018, 0.58 + i * 0.035);
        if (t <= 0.001) continue;
        const pos = move(shardStarts[i], shardEnds[i], t, 5 + (i % 3) * 1.5);
        const outline = berg8(2.1 + (i % 2) * 0.4, 1.7 + (i % 3) * 0.25, t * (i % 2 ? -0.7 : 0.7), 24 + i);
        parts.push({
            d: rig.depth(pos.f, pos.r) + 0.02,
            draw: () => prism(g, rig, pos, 4.2 + (i % 2), outline, pal),
        });
    }

    // Crack paths are rendered on the still-standing near faces before the
    // pieces separate. They extinguish with the core but leave dark scars.
    // These paths belong to the standing stele faces. Once the courses have
    // calved away, their local block facets carry the breakup; a world-fixed
    // crack must not linger above the low remnant.
    const crackAlpha = lerp(0.85, 0.55, settle) * (1 - stage(phase, 0.34, 0.64));
    if (Math.abs(rig.sa) > 0.05) {
        const ff = 1 + (rig.sa >= 0 ? 8.6 : -8.6);
        parts.push({
            d: rig.depth(ff, 0) + 0.08,
            draw: () => {
                progressiveStroke(g, [
                    rig.p(ff, -5, 43), rig.p(ff, -1.5, 38), rig.p(ff, -4, 34), rig.p(ff, 1, 29), rig.p(ff, 4, 25),
                ], fracture, 1.35, pal.dark, crackAlpha);
                progressiveStroke(g, [
                    rig.p(ff, -1.5, 38), rig.p(ff, 4.5, 39.5), rig.p(ff, 7, 36),
                ], stage(phase, 0.07, 0.28), 1.1, pal.dark, crackAlpha * 0.9);
            },
        });
    }

    // Frozen-heart mark: bright at phase zero, then drains through the same
    // fracture that starts the calving sequence. It is fully inert at rest.
    if (rig.sa > 0.05 && coreLife > 0.01) {
        const sigilF = 9.6;
        parts.push({
            d: rig.depth(sigilF, 0) + 0.09,
            draw: () => {
                quad(g, rig.p(sigilF, -1, 30.5), rig.p(sigilF, 1, 30.5), rig.p(sigilF, 1, 38), rig.p(sigilF, -1, 38), pal.core, coreLife * pal.glowK);
                quad(g, rig.p(sigilF, -3, 32.2), rig.p(sigilF, 3, 32.2), rig.p(sigilF, 3, 33.3), rig.p(sigilF, -3, 33.3), pal.hot, coreLife * 0.78);
                if (level >= 3) {
                    g.lineStyle(1.1, pal.trimHi, 0.84);
                    const pts = [rig.p(sigilF, 0, 39.2), rig.p(sigilF, 3.8, 34.2), rig.p(sigilF, 0, 29.2), rig.p(sigilF, -3.8, 34.2)];
                    g.beginPath();
                    g.moveTo(pts[0].x, pts[0].y);
                    for (let i = 1; i < pts.length; i++) g.lineTo(pts[i].x, pts[i].y);
                    g.closePath();
                    g.strokePath();
                }
            },
        });
    }

    parts.sort((a, b) => a.d - b.d);
    for (const part of parts) part.draw();
}

/**
 * Deterministic golem death authoring source.
 *
 * `phase` is clamped to 0..1. Phase 0 is the standing post-killing-blow pose;
 * phase 1 is a low, static remnant suitable for persistent battlefield art.
 */
export function drawGolemDeath(
    g: G,
    type: GolemDeathType,
    isPlayer: boolean,
    troopLevel: number,
    facingAngle: number,
    phase: number,
): void {
    const p = clamp01(Number.isFinite(phase) ? phase : 0);
    const levelValue = Number.isFinite(troopLevel) ? troopLevel : 1;
    const level = Math.max(1, Math.min(3, Math.round(levelValue || 1)));
    const angle = Number.isFinite(facingAngle) ? facingAngle : 0.6;
    if (type === 'icegolem') drawIceDeath(g, isPlayer, level, angle, p);
    else drawStoneDeath(g, isPlayer, level, angle, p);
}
