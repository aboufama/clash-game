import type Phaser from 'phaser';

/** Canonical faction barracks art. Each faction keeps one recognizable
 * silhouette family while its material language advances through L1-L9. */
export type FactionBarracksTheme = 'mechanica' | 'mystic';

type G = Phaser.GameObjects.Graphics;
type V = Phaser.Math.Vector2;
type Pt = readonly [number, number];

interface BarracksState {
    level?: number;
    doorOpen?: number;
}

interface Palette {
    wallLit: number;
    wallDark: number;
    roofLit: number;
    roofDark: number;
    trim: number;
    accent: number;
    accentDark: number;
    glow: number;
    ground: number;
}

const TAU = Math.PI * 2;

const LEVEL_INSET = [0.48, 0.51, 0.54, 0.57, 0.60, 0.63, 0.66, 0.68, 0.70] as const;
const LEVEL_WALL_H = [11, 13, 15, 17, 19, 21, 23, 25, 27] as const;
const LEVEL_ROOF_H = [8, 9, 10, 11, 12, 13, 14, 15, 17] as const;

const PALETTES: Record<FactionBarracksTheme, readonly Palette[]> = {
    mechanica: [
        { wallLit: 0xa48156, wallDark: 0x7a5d3f, roofLit: 0x82613d, roofDark: 0x60462e, trim: 0x55412d, accent: 0xa95f32, accentDark: 0x744025, glow: 0xffa33a, ground: 0x6e5a3b },
        { wallLit: 0xa17c4e, wallDark: 0x75563a, roofLit: 0x76583a, roofDark: 0x553f2c, trim: 0x4d4036, accent: 0xb16a35, accentDark: 0x754522, glow: 0xffa43e, ground: 0x6d5838 },
        { wallLit: 0x9a7954, wallDark: 0x6e5742, roofLit: 0x6d6157, roofDark: 0x4c4540, trim: 0x45474a, accent: 0xb87333, accentDark: 0x7b4a22, glow: 0xffa43e, ground: 0x66563d },
        { wallLit: 0x8d8172, wallDark: 0x696057, roofLit: 0x62636a, roofDark: 0x44464d, trim: 0x3f4248, accent: 0xba793c, accentDark: 0x7e5229, glow: 0xffa642, ground: 0x625745 },
        { wallLit: 0x867d72, wallDark: 0x625d58, roofLit: 0x585b63, roofDark: 0x3c3f46, trim: 0x3a3d42, accent: 0xc18143, accentDark: 0x80552d, glow: 0xffaa48, ground: 0x5f5645 },
        { wallLit: 0x827c73, wallDark: 0x5f5b58, roofLit: 0x50545c, roofDark: 0x373a41, trim: 0x34373d, accent: 0xc58b49, accentDark: 0x846036, glow: 0xffae4d, ground: 0x5c5548 },
        { wallLit: 0x7f7b74, wallDark: 0x5b5957, roofLit: 0x484c54, roofDark: 0x30343a, trim: 0x303238, accent: 0xcb934f, accentDark: 0x896438, glow: 0xffb253, ground: 0x5b5549 },
        { wallLit: 0x918878, wallDark: 0x6b6459, roofLit: 0x4b5058, roofDark: 0x31353b, trim: 0x34363b, accent: 0xd0a052, accentDark: 0x8e6a35, glow: 0xffb75a, ground: 0x655d4d },
        { wallLit: 0xbfb49a, wallDark: 0x9d9078, roofLit: 0x50545b, roofDark: 0x34383e, trim: 0x74684f, accent: 0xdaa520, accentDark: 0x9b7413, glow: 0xffc060, ground: 0x756a54 },
    ],
    mystic: [
        { wallLit: 0x8b806f, wallDark: 0x665d51, roofLit: 0x655082, roofDark: 0x46365f, trim: 0x51415f, accent: 0x8f79cf, accentDark: 0x59478f, glow: 0x83ddff, ground: 0x525067 },
        { wallLit: 0x918778, wallDark: 0x6b6258, roofLit: 0x65518b, roofDark: 0x443566, trim: 0x504165, accent: 0x9783d8, accentDark: 0x5c4c96, glow: 0x87e1ff, ground: 0x53516c },
        { wallLit: 0x92909a, wallDark: 0x6d6a76, roofLit: 0x5d518e, roofDark: 0x3d356a, trim: 0x4a4566, accent: 0x9d8bdd, accentDark: 0x60519b, glow: 0x8de4ff, ground: 0x55536f },
        { wallLit: 0x9997a2, wallDark: 0x716f7c, roofLit: 0x58518e, roofDark: 0x393568, trim: 0x4a4768, accent: 0xa594e2, accentDark: 0x6656a1, glow: 0x93e7ff, ground: 0x575674 },
        { wallLit: 0x9d9ca8, wallDark: 0x74737f, roofLit: 0x514c89, roofDark: 0x343260, trim: 0x484667, accent: 0xab9ce7, accentDark: 0x6b5ba8, glow: 0x99eaff, ground: 0x595877 },
        { wallLit: 0xa29faa, wallDark: 0x77737f, roofLit: 0x4b4782, roofDark: 0x302e5b, trim: 0x464461, accent: 0xb1a3eb, accentDark: 0x705fac, glow: 0x9fecff, ground: 0x5b5a78 },
        { wallLit: 0xa9a7b0, wallDark: 0x7c7983, roofLit: 0x46427b, roofDark: 0x2c2955, trim: 0x44425c, accent: 0xb8abef, accentDark: 0x7564b1, glow: 0xa6efff, ground: 0x5d5d7a },
        { wallLit: 0xb2adad, wallDark: 0x857e80, roofLit: 0x443f75, roofDark: 0x2b2750, trim: 0x514b60, accent: 0xc2b5f2, accentDark: 0x7b69b5, glow: 0xacf2ff, ground: 0x65627b },
        { wallLit: 0xbfb49a, wallDark: 0x9d9078, roofLit: 0x463f74, roofDark: 0x2d2850, trim: 0x756a57, accent: 0xb8abef, accentDark: 0x7564b1, glow: 0xb5f5ff, ground: 0x746d68 },
    ],
};

function quad(g: G, points: readonly Pt[], color: number, alpha: number): void {
    if (points.length < 3) return;
    g.fillStyle(color, alpha);
    g.beginPath();
    g.moveTo(points[0][0], points[0][1]);
    for (let i = 1; i < points.length; i++) g.lineTo(points[i][0], points[i][1]);
    g.closePath();
    g.fillPath();
}

const up = (point: Pt, height: number): Pt => [point[0], point[1] - height];
const mix = (a: Pt, b: Pt, t: number): Pt => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];

function isoBox(g: G, center: Pt, halfW: number, halfD: number, height: number, lit: number, dark: number, top: number, alpha: number): void {
    const n: Pt = [center[0], center[1] - halfD];
    const e: Pt = [center[0] + halfW, center[1]];
    const s: Pt = [center[0], center[1] + halfD];
    const w: Pt = [center[0] - halfW, center[1]];
    quad(g, [e, s, up(s, height), up(e, height)], dark, alpha);
    quad(g, [s, w, up(w, height), up(s, height)], lit, alpha);
    quad(g, [up(n, height), up(e, height), up(s, height), up(w, height)], top, alpha);
}

function drawDoor(g: G, p3: Pt, p4: Pt, wallH: number, palette: Palette, alpha: number, doorOpen: number): void {
    const dx = (p3[0] + p4[0]) * 0.5;
    const dy = (p3[1] + p4[1]) * 0.5;
    const slope = (p3[1] - p4[1]) / Math.max(1, p3[0] - p4[0]);
    const width = Math.min(6.2, 4.5 + wallH * 0.055);
    const height = Math.min(15, 8.5 + wallH * 0.22);
    const point = (ox: number, h: number): Pt => [dx + ox, dy + ox * slope - h];
    const frame = [point(-width, -0.4), point(width, -0.4), point(width, height), point(-width, height)] as const;
    quad(g, frame, palette.trim, alpha);
    const inner = [point(-width + 1.5, 0), point(width - 1.5, 0), point(width - 1.5, height - 1.7), point(-width + 1.5, height - 1.7)] as const;
    quad(g, inner, 0x17120f, alpha);
    if (doorOpen > 0.02) {
        g.fillStyle(palette.glow, alpha * 0.18 * doorOpen);
        g.fillEllipse(dx, dy - 3, 8 + doorOpen * 4, 4 + doorOpen * 2);
        const leaf = Math.max(1.2, (width * 2 - 3) * (1 - doorOpen * 0.86));
        quad(g, [inner[0], point(-width + 1.5 + leaf, 0.6), point(-width + 1.5 + leaf, height - 2.2), inner[3]], palette.accentDark, alpha);
    } else {
        quad(g, inner, palette.accentDark, alpha);
        g.lineStyle(1, palette.accent, alpha * 0.8);
        g.lineBetween(dx, dy - 1.5, dx, dy - height + 2.5);
    }
}

function drawHippedRoof(
    g: G,
    c1: V,
    c2: V,
    c3: V,
    c4: V,
    center: V,
    inset: number,
    wallH: number,
    roofH: number,
    palette: Palette,
    alpha: number,
    level: number,
): { peak: Pt; ridgeA: Pt; ridgeB: Pt } {
    const lerpCorner = (corner: V, amount: number): Pt => [
        center.x + (corner.x - center.x) * amount,
        center.y + (corner.y - center.y) * amount,
    ];
    const overhang = 1.17;
    const r1 = up(lerpCorner(c1, inset * overhang), wallH);
    const r2 = up(lerpCorner(c2, inset * overhang), wallH);
    const r3 = up(lerpCorner(c3, inset * overhang), wallH);
    const r4 = up(lerpCorner(c4, inset * overhang), wallH);
    const q = inset * (0.16 + level * 0.006);
    const ridgeA: Pt = [center.x - (c2.x - c1.x) * q, center.y - (c2.y - c1.y) * q - wallH - roofH];
    const ridgeB: Pt = [center.x + (c2.x - c1.x) * q, center.y + (c2.y - c1.y) * q - wallH - roofH];
    quad(g, [r1, r2, ridgeB, ridgeA], palette.roofDark, alpha * 0.94);
    quad(g, [r4, r1, ridgeA], palette.roofLit, alpha * 0.94);
    quad(g, [r4, r3, ridgeB, ridgeA], palette.roofLit, alpha);
    quad(g, [r3, r2, ridgeB], palette.roofDark, alpha);
    g.lineStyle(1, palette.roofDark, alpha * 0.58);
    const courses = 1 + Math.floor((level - 1) / 2);
    for (let i = 1; i <= courses; i++) {
        const t = i / (courses + 1);
        const a = mix(r4, ridgeA, t);
        const b = mix(r3, ridgeB, t);
        g.lineBetween(a[0], a[1], b[0], b[1]);
    }
    g.lineStyle(level === 9 ? 2.2 : 1.6, level === 9 ? 0xdaa520 : palette.trim, alpha);
    g.lineBetween(ridgeA[0], ridgeA[1], ridgeB[0], ridgeB[1]);
    return {
        peak: [(ridgeA[0] + ridgeB[0]) * 0.5, (ridgeA[1] + ridgeB[1]) * 0.5],
        ridgeA,
        ridgeB,
    };
}

function drawMechanicaDetails(g: G, center: V, level: number, palette: Palette, alpha: number, phase: number, peak: Pt, ridgeB: Pt): void {
    const gearX = center.x + 25;
    const gearY = center.y + 10;
    const gearR = 5 + Math.min(4, level) * 0.45;
    g.fillStyle(0x191919, alpha * 0.26);
    g.fillEllipse(gearX, gearY + 3.5, gearR * 2.4, gearR * 0.8);
    g.lineStyle(level === 9 ? 2.2 : 1.8, palette.accentDark, alpha);
    for (let i = 0; i < 8; i++) {
        const a = phase + i * TAU / 8;
        const x0 = gearX + Math.cos(a) * gearR * 0.35;
        const y0 = gearY + Math.sin(a) * gearR * 0.35;
        const x1 = gearX + Math.cos(a) * gearR;
        const y1 = gearY + Math.sin(a) * gearR;
        g.lineBetween(x0, y0, x1, y1);
    }
    g.fillStyle(palette.accent, alpha);
    g.fillCircle(gearX, gearY, gearR * 0.52);
    g.fillStyle(palette.glow, alpha * (0.82 + Math.sin(phase * 3) * 0.12));
    g.fillCircle(gearX, gearY, gearR * 0.22);

    if (level >= 2) {
        const sx = ridgeB[0] - 2;
        const sy = ridgeB[1] + 3;
        isoBox(g, [sx, sy], 3.5 + level * 0.12, 1.8, 8 + level * 0.7, palette.wallLit, palette.wallDark, palette.trim, alpha);
        g.fillStyle(0x222126, alpha);
        g.fillEllipse(sx, sy - 8 - level * 0.7, 6.5 + level * 0.2, 2.4);
        if (level >= 4) {
            g.lineStyle(1.7, palette.accent, alpha);
            g.beginPath();
            g.arc(sx, sy - 5.5, 5, Math.PI, TAU, false);
            g.strokePath();
        }
    }
    if (level >= 5) {
        const piston = (Math.sin(phase * 2) + 1) * 1.7;
        g.lineStyle(2.4, palette.trim, alpha);
        g.lineBetween(center.x - 27, center.y + 11, center.x - 27, center.y - 1 - piston);
        g.fillStyle(palette.accent, alpha);
        g.fillRect(center.x - 30.5, center.y - 4 - piston, 7, 5);
    }
    if (level >= 7) {
        isoBox(g, [peak[0], peak[1] + 1], 7.5, 3.8, 8, palette.wallLit, palette.wallDark, palette.trim, alpha);
        g.fillStyle(palette.glow, alpha * 0.88);
        g.fillRect(peak[0] - 1.5, peak[1] - 5.5, 3, 4);
        g.lineStyle(1.6, palette.accent, alpha);
        g.lineBetween(peak[0] - 8, peak[1] - 8, peak[0] + 8, peak[1] - 8);
    }
    if (level === 9) {
        g.lineStyle(2, palette.accent, alpha);
        g.lineBetween(peak[0], peak[1] - 8, peak[0], peak[1] - 19);
        g.fillStyle(palette.accent, alpha);
        g.fillTriangle(peak[0] - 5, peak[1] - 18, peak[0] + 5, peak[1] - 18, peak[0], peak[1] - 24);
        g.fillCircle(peak[0], peak[1] - 25, 1.8);
    }
}

function drawMysticDetails(g: G, center: V, level: number, palette: Palette, alpha: number, phase: number, peak: Pt, ridgeA: Pt, ridgeB: Pt): void {
    const hover = Math.sin(phase) * 2;
    const crystalY = peak[1] - 8 - Math.min(5, level * 0.4) + hover;
    const crystalH = 7 + Math.min(5, level * 0.65);
    quad(g, [
        [peak[0], crystalY - crystalH],
        [peak[0] + 4 + level * 0.12, crystalY - crystalH * 0.42],
        [peak[0] + 2.2, crystalY + 1.5],
        [peak[0] - 3.5, crystalY - crystalH * 0.35],
    ], palette.accent, alpha);
    quad(g, [
        [peak[0], crystalY - crystalH],
        [peak[0] + 1, crystalY - crystalH * 0.35],
        [peak[0] - 2.5, crystalY + 0.5],
        [peak[0] - 3.5, crystalY - crystalH * 0.35],
    ], palette.glow, alpha * 0.72);
    g.fillStyle(palette.glow, alpha * (0.18 + Math.sin(phase) * 0.04));
    g.fillEllipse(peak[0], crystalY - crystalH * 0.35, 13 + level, 7 + level * 0.35);

    // Rune tablets on the training-yard edge, gaining one discipline per
    // architecture milestone rather than becoming visual confetti.
    const tabletCount = 1 + Math.floor((level - 1) / 3);
    for (let i = 0; i < tabletCount; i++) {
        const x = center.x + 24 - i * 8;
        const y = center.y + 11 + i * 3;
        isoBox(g, [x, y], 3.3, 1.5, 8 + i, palette.wallLit, palette.wallDark, palette.trim, alpha);
        g.lineStyle(1.1, palette.glow, alpha * (0.72 + Math.sin(phase * 2 + i) * 0.18));
        g.lineBetween(x - 1.2, y - 3 - i, x + 1.2, y - 6 - i);
        g.lineBetween(x + 1.2, y - 6 - i, x - 0.6, y - 7.5 - i);
    }
    if (level >= 4) {
        for (const ridge of [ridgeA, ridgeB]) {
            g.lineStyle(1.8, palette.trim, alpha);
            g.lineBetween(ridge[0], ridge[1], ridge[0], ridge[1] - 7 - level * 0.35);
            g.fillStyle(palette.accent, alpha);
            g.fillCircle(ridge[0], ridge[1] - 8 - level * 0.35, 1.8);
        }
    }
    if (level >= 7) {
        isoBox(g, [peak[0], peak[1] + 2], 7.2, 3.6, 7, palette.wallLit, palette.wallDark, palette.roofDark, alpha);
        g.fillStyle(palette.glow, alpha * 0.9);
        g.fillRect(peak[0] - 1.4, peak[1] - 4, 2.8, 4.5);
    }
    if (level === 9) {
        // A slim crescent crown; gold stays an accent around the faction's
        // dominant violet roof and cyan crystal.
        g.lineStyle(2.2, 0xdaa520, alpha);
        g.beginPath();
        g.arc(peak[0], crystalY - crystalH - 5, 6, -Math.PI * 0.62, Math.PI * 0.62, false);
        g.strokePath();
        g.fillStyle(0xdaa520, alpha);
        g.fillCircle(peak[0] + 5, crystalY - crystalH - 8, 1.5);
    }
}

export function drawFactionBarracks(
    graphics: G,
    c1: V,
    c2: V,
    c3: V,
    c4: V,
    center: V,
    alpha: number,
    building: BarracksState | undefined,
    baseGraphics: G | undefined,
    skipBase: boolean,
    onlyBase: boolean,
    time: number,
    theme: FactionBarracksTheme,
): void {
    const level = Math.max(1, Math.min(9, Math.floor(Number(building?.level) || 1)));
    const doorOpen = Math.max(0, Math.min(1, Number(building?.doorOpen) || 0));
    const palette = PALETTES[theme][level - 1];
    const ground = baseGraphics ?? graphics;

    if (!skipBase) {
        // Soft contact plus a compact, irregularly layered work patch. The
        // lawn remains visible around every edge; this is never a footprint plate.
        ground.fillStyle(0x18220f, alpha * 0.19);
        ground.fillEllipse(center.x, center.y + 3, 58, 25);
        ground.fillStyle(palette.ground, alpha * 0.34);
        ground.fillEllipse(center.x + 1, center.y + 5, 45 + level, 17 + level * 0.35);
        ground.fillStyle(palette.ground, alpha * 0.19);
        ground.fillEllipse(center.x - 14, center.y + 10, 18, 7);
    }
    if (onlyBase) return;

    const inset = LEVEL_INSET[level - 1];
    const wallH = LEVEL_WALL_H[level - 1];
    const roofH = LEVEL_ROOF_H[level - 1];
    const corner = (value: V): Pt => [
        center.x + (value.x - center.x) * inset,
        center.y + (value.y - center.y) * inset,
    ];
    const p2 = corner(c2);
    const p3 = corner(c3);
    const p4 = corner(c4);
    const phase = ((time % 3000) / 3000) * TAU;

    // A low side annex appears at L4 and grows once at L6/L8. It gives each
    // milestone a visible footprint change without filling the 2x2 plot.
    if (level >= 4) {
        const annexH = 7 + Math.floor((level - 4) / 2) * 2;
        isoBox(graphics, [center.x + 23, center.y + 3], 10, 5, annexH,
            palette.wallLit, palette.wallDark, palette.roofDark, alpha);
    }

    // Main walls: SE dark first, SW lit second (fixed NW light contract).
    quad(graphics, [p2, p3, up(p3, wallH), up(p2, wallH)], palette.wallDark, alpha);
    quad(graphics, [p3, p4, up(p4, wallH), up(p3, wallH)], palette.wallLit, alpha);

    // Material coursing and structural braces become richer every two levels.
    const courses = Math.min(4, 1 + Math.floor((level - 1) / 2));
    graphics.lineStyle(level === 9 ? 1.5 : 1.1, level === 9 ? palette.accent : palette.trim, alpha * 0.58);
    for (let i = 1; i <= courses; i++) {
        const h = wallH * i / (courses + 1);
        graphics.lineBetween(p4[0], p4[1] - h, p3[0], p3[1] - h);
        graphics.lineBetween(p3[0], p3[1] - h, p2[0], p2[1] - h);
    }
    if (level >= 2) {
        graphics.lineStyle(1.4, palette.trim, alpha * 0.75);
        graphics.lineBetween(p4[0] + 3, p4[1] - 2, p3[0] - 3, p3[1] - wallH + 3);
        if (level >= 6) graphics.lineBetween(p3[0] - 3, p3[1] - 2, p2[0] + 3, p2[1] - wallH + 3);
    }
    if (level === 9) {
        const bandH = wallH * 0.72;
        graphics.lineStyle(2.4, 0xdaa520, alpha);
        graphics.lineBetween(p4[0], p4[1] - bandH, p3[0], p3[1] - bandH);
        graphics.lineBetween(p3[0], p3[1] - bandH, p2[0], p2[1] - bandH);
    }

    drawDoor(graphics, p3, p4, wallH, palette, alpha, doorOpen);
    const roof = drawHippedRoof(graphics, c1, c2, c3, c4, center, inset, wallH, roofH, palette, alpha, level);

    if (theme === 'mechanica') {
        drawMechanicaDetails(graphics, center, level, palette, alpha, phase, roof.peak, roof.ridgeB);
    } else {
        drawMysticDetails(graphics, center, level, palette, alpha, phase, roof.peak, roof.ridgeA, roof.ridgeB);
    }

    // Three small faction marks on the lit facade communicate the sub-step
    // inside each L1–3 / L4–6 / L7–9 rebuild without literal UI numerals.
    const subStep = ((level - 1) % 3) + 1;
    for (let i = 0; i < subStep; i++) {
        const t = 0.16 + i * 0.13;
        const x = p4[0] + (p3[0] - p4[0]) * t;
        const y = p4[1] + (p3[1] - p4[1]) * t - wallH * 0.53;
        graphics.fillStyle(level === 9 ? 0xdaa520 : palette.accentDark, alpha);
        graphics.fillCircle(x, y, 1.6 + (level >= 7 ? 0.4 : 0));
        graphics.fillStyle(palette.glow, alpha * 0.8);
        graphics.fillCircle(x - 0.35, y - 0.35, 0.65);
    }
}
