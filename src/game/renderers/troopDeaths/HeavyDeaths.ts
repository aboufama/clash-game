import type Phaser from 'phaser';
import { drawWarelephantA } from '../redesign/WarelephantA';

type G = Phaser.GameObjects.Graphics;

export type HeavyDeathType = 'trebuchet' | 'warelephant';

interface Pt {
    x: number;
    y: number;
}

interface LocalPt {
    d: number;
    w: number;
    h: number;
}

interface IsoBasis {
    ca: number;
    sa: number;
    fx: number;
    fy: number;
    px: number;
    py: number;
    ground: number;
    point: (d: number, w: number, h: number) => Pt;
    groundY: (d: number, w: number) => number;
}

const TAU = Math.PI * 2;

function clamp01(v: number): number {
    if (Number.isNaN(v)) return 0;
    return Math.max(0, Math.min(1, v));
}

function lerp(a: number, b: number, t: number): number {
    return a + (b - a) * t;
}

function smooth(t: number): number {
    const k = clamp01(t);
    return k * k * (3 - 2 * k);
}

function easeIn(t: number): number {
    const k = clamp01(t);
    return k * k;
}

function easeOut(t: number): number {
    const k = clamp01(t);
    return 1 - (1 - k) * (1 - k) * (1 - k);
}

function span(phase: number, start: number, end: number): number {
    return clamp01((phase - start) / Math.max(0.0001, end - start));
}

function shade(color: number, amount: number): number {
    const r = Math.max(0, Math.min(255, Math.round(((color >> 16) & 0xff) * amount)));
    const gg = Math.max(0, Math.min(255, Math.round(((color >> 8) & 0xff) * amount)));
    const b = Math.max(0, Math.min(255, Math.round((color & 0xff) * amount)));
    return (r << 16) | (gg << 8) | b;
}

function basis(facingAngle: number, ground: number): IsoBasis {
    const a = Number.isFinite(facingAngle) ? facingAngle : 0;
    const ca = Math.cos(a);
    const sa = Math.sin(a);
    const fx = ca;
    const fy = sa * 0.5;
    const px = -sa;
    const py = ca * 0.5;
    return {
        ca,
        sa,
        fx,
        fy,
        px,
        py,
        ground,
        point: (d: number, w: number, h: number): Pt => ({
            x: fx * d + px * w,
            y: ground + fy * d + py * w - h,
        }),
        groundY: (d: number, w: number): number => fy * d + py * w,
    };
}

function mixLocal(a: LocalPt, b: LocalPt, t: number): LocalPt {
    return {
        d: lerp(a.d, b.d, t),
        w: lerp(a.w, b.w, t),
        h: lerp(a.h, b.h, t),
    };
}

function fillPolygon(g: G, points: Pt[], color: number, alpha = 1): void {
    if (points.length < 3 || alpha <= 0) return;
    g.fillStyle(color, clamp01(alpha));
    g.beginPath();
    g.moveTo(points[0].x, points[0].y);
    for (let i = 1; i < points.length; i++) g.lineTo(points[i].x, points[i].y);
    g.closePath();
    g.fillPath();
}

function strip(g: G, a: Pt, b: Pt, widthA: number, widthB: number, color: number, alpha = 1): void {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const length = Math.hypot(dx, dy) || 1;
    const nx = -dy / length;
    const ny = dx / length;
    fillPolygon(g, [
        { x: a.x + nx * widthA * 0.5, y: a.y + ny * widthA * 0.5 },
        { x: b.x + nx * widthB * 0.5, y: b.y + ny * widthB * 0.5 },
        { x: b.x - nx * widthB * 0.5, y: b.y - ny * widthB * 0.5 },
        { x: a.x - nx * widthA * 0.5, y: a.y - ny * widthA * 0.5 },
    ], color, alpha);
}

function line(g: G, a: Pt, b: Pt, width: number, color: number, alpha = 1): void {
    if (alpha <= 0) return;
    g.lineStyle(width, color, clamp01(alpha));
    g.lineBetween(a.x, a.y, b.x, b.y);
}

/** One uniform-alpha, ground-plane contact silhouette. */
function contactShadow(
    g: G,
    iso: IsoBasis,
    centerD: number,
    centerW: number,
    radiusD: number,
    radiusW: number,
    alpha: number
): void {
    const points: Pt[] = [];
    for (let i = 0; i < 20; i++) {
        const a = (i / 20) * TAU;
        points.push(iso.point(
            centerD + Math.cos(a) * radiusD,
            centerW + Math.sin(a) * radiusW,
            -0.15
        ));
    }
    fillPolygon(g, points, 0x12170e, alpha);
}

function drawCuboid(
    g: G,
    iso: IsoBasis,
    d: number,
    w: number,
    bottomH: number,
    topH: number,
    halfD: number,
    halfW: number,
    sideColor: number,
    topColor: number,
    alpha = 1
): void {
    const local = [
        { d: d - halfD, w: w - halfW },
        { d: d + halfD, w: w - halfW },
        { d: d + halfD, w: w + halfW },
        { d: d - halfD, w: w + halfW },
    ];
    const top = local.map((p) => iso.point(p.d, p.w, topH));
    const bottom = local.map((p) => iso.point(p.d, p.w, bottomH));
    const faces = [
        { a: 0, b: 1, ny: -iso.py, nx: -iso.px },
        { a: 1, b: 2, ny: iso.fy, nx: iso.fx },
        { a: 2, b: 3, ny: iso.py, nx: iso.px },
        { a: 3, b: 0, ny: -iso.fy, nx: -iso.fx },
    ];
    for (const face of faces) {
        if (face.ny <= 0.001) continue;
        const lit = face.nx < 0;
        fillPolygon(g, [
            top[face.a], top[face.b], bottom[face.b], bottom[face.a],
        ], shade(sideColor, lit ? 1.08 : 0.78), alpha);
    }
    fillPolygon(g, top, topColor, alpha);
}

function drawTrebuchetDeath(g: G, isPlayer: boolean, level: number, facingAngle: number, phase: number): void {
    const iso = basis(facingAngle, 8.2);
    const p = phase;
    const wood = level >= 3 ? 0x6e553a : level === 2 ? 0x7d6142 : 0x8a6d4a;
    const woodDk = shade(wood, 0.62);
    const woodLt = shade(wood, 1.2);
    const frame = shade(wood, 0.84);
    const iron = 0x484d55;
    const ironDk = 0x30343a;
    const ironLt = 0x5f6672;
    const gold = 0xdaa520;
    const stone = 0x8f8a80;
    const stoneDk = 0x6f6a62;
    const cloth = isPlayer ? 0x2f6f9f : 0xa03028;
    const clothDk = shade(cloth, 0.7);
    const skin = isPlayer ? 0xdeb887 : 0xc9a66b;
    const tunic = isPlayer ? 0x7d5a35 : 0x5f4630;
    const tunicDk = shade(tunic, 0.68);

    // Camera-down expressed in the local ground basis. It keeps the rack and
    // loose pieces readable at all eight baked headings.
    const downD = iso.sa;
    const downW = iso.ca;
    const drop = easeIn(span(p, 0.04, 0.42));
    const snap = easeOut(span(p, 0.08, 0.34));
    const rack = smooth(span(p, 0.18, 0.78));
    const settle = smooth(span(p, 0.55, 0.96));
    const crush = smooth(span(p, 0.42, 0.9));

    contactShadow(
        g,
        iso,
        lerp(0, downD * 2.5, settle),
        lerp(0, downW * 2.5, settle),
        lerp(22, 19, settle),
        lerp(9.2, 8.2, settle),
        lerp(0.29, 0.24, settle)
    );

    const farSide = iso.py >= 0 ? -1 : 1;
    const wheelTilt = smooth(span(p, 0.34, 0.94));
    const drawWheel = (d: number, w: number, sideBias: number): void => {
        const tilt = clamp01(wheelTilt * (0.72 + sideBias * 0.18));
        const centerH = lerp(3.8, 1.05, tilt);
        const radius = 4.4;
        const ring = (scale: number): Pt[] => {
            const points: Pt[] = [];
            for (let i = 0; i < 14; i++) {
                const a = (i / 14) * TAU;
                points.push(iso.point(
                    d + Math.cos(a) * radius * scale,
                    w + Math.sin(a) * radius * scale * tilt,
                    centerH + Math.sin(a) * radius * scale * (1 - tilt)
                ));
            }
            return points;
        };
        fillPolygon(g, ring(1), level >= 2 ? ironDk : woodDk);
        fillPolygon(g, ring(0.67), wood);
        const center = iso.point(d, w, centerH);
        g.lineStyle(1.05, woodDk, 1);
        for (let i = 0; i < 4; i++) {
            const a = i * Math.PI * 0.5 + 0.35;
            const end = iso.point(
                d + Math.cos(a) * radius * 0.61,
                w + Math.sin(a) * radius * 0.61 * tilt,
                centerH + Math.sin(a) * radius * 0.61 * (1 - tilt)
            );
            g.lineBetween(center.x, center.y, end.x, end.y);
        }
        g.fillStyle(level >= 3 ? gold : iron, 1);
        g.fillCircle(center.x, center.y, 1.15);
    };

    // The engineers abandon the machine during the first third of the fall;
    // they are present at phase zero so the just-killed outline matches B.
    const crewAlpha = 1 - smooth(span(p, 0.03, 0.38));
    const drawEngineer = (d: number, w: number, direction: number): void => {
        if (crewAlpha <= 0) return;
        const run = smooth(span(p, 0.02, 0.35));
        const foot = iso.point(d - downD * run * 4 + direction * iso.ca * run * 2,
            w - downW * run * 4 - direction * iso.sa * run * 2, 0);
        const crouch = run * 3.5;
        g.fillStyle(tunicDk, crewAlpha);
        g.fillRect(foot.x - 2.1, foot.y - 5.4 + crouch, 1.7, 5.4 - crouch * 0.3);
        g.fillRect(foot.x + 0.4, foot.y - 5.4 + crouch, 1.7, 5.4 - crouch * 0.3);
        g.fillStyle(tunic, crewAlpha);
        g.fillCircle(foot.x + direction * run, foot.y - 8.2 + crouch, 3.5);
        const headY = foot.y - 13.0 + crouch;
        g.fillStyle(skin, crewAlpha);
        g.fillCircle(foot.x + direction * run * 1.3, headY, 2.5);
        g.fillStyle(clothDk, crewAlpha);
        g.fillEllipse(foot.x + direction * run * 1.3, headY - 1.6, 5.2, 2.3);
        g.fillStyle(cloth, crewAlpha);
        g.fillEllipse(foot.x + direction * run * 1.3, headY - 2, 3.8, 1.8);
    };

    const crew = [
        { d: -15.5, w: 10.8, direction: 1 },
        { d: -24, w: -5.5, direction: -1 },
    ].sort((a, b) => iso.groundY(a.d, a.w) - iso.groundY(b.d, b.w));
    for (const c of crew) {
        if (iso.groundY(c.d, c.w) < -1.5) drawEngineer(c.d, c.w, c.direction);
    }

    drawWheel(13.5, farSide * 8, 0.2);
    drawWheel(-13.5, farSide * 8, 0.45);

    const sledH = lerp(5.5, 3.15, crush);
    for (const side of [-1, 1]) {
        const w = side * 6.6;
        strip(g, iso.point(-19, w, sledH), iso.point(19, w, sledH), 3.2, 3.2,
            side === farSide ? woodDk : wood);
        line(g, iso.point(-18, w, sledH - 0.7), iso.point(18, w, sledH - 0.7), 0.9,
            side === farSide ? shade(woodDk, 0.75) : woodLt);
    }
    fillPolygon(g, [
        iso.point(-18, -5.4, sledH + 0.25),
        iso.point(-7, -5.4, sledH + 0.25),
        iso.point(-7, 5.4, sledH + 0.25),
        iso.point(-18, 5.4, sledH + 0.25),
    ], shade(wood, 1.06));
    for (const dd of [-15.5, -12.5, -9.5]) {
        line(g, iso.point(dd, -5.2, sledH + 0.35), iso.point(dd, 5.2, sledH + 0.35), 0.8, woodDk);
    }

    // Spare shot stays with the persistent wreck instead of becoming FX.
    for (const [d, w, r] of [[-9.5, -3.5, 2.2], [-11.4, -2.6, 1.8]] as const) {
        const c = iso.point(d + downD * settle * 1.2, w + downW * settle * 1.2, sledH + 1.1 - crush * 0.8);
        g.fillStyle(stoneDk, 1);
        g.fillCircle(c.x, c.y, r);
        g.fillStyle(stone, 1);
        g.fillCircle(c.x - 0.45, c.y - 0.5, r * 0.68);
    }

    const footH = lerp(5.5, 2.35, crush);
    const apexOf = (side: number): LocalPt => ({
        d: lerp(2, 2 + downD * (9.5 + side * 1.2), rack),
        w: lerp(side * 2.6, side * 2.6 + downW * (9.5 + side * 1.2), rack),
        h: lerp(24.4, 4.3 + side * 0.35, rack),
    });
    const drawTruss = (side: number): void => {
        const apex = apexOf(side);
        const a = { d: 9.5, w: side * 5.6, h: footH };
        const b = { d: -5.5, w: side * 5.6, h: footH };
        const color = shade(frame, side === farSide ? 0.83 : 1);
        strip(g, iso.point(a.d, a.w, a.h), iso.point(apex.d, apex.w, apex.h), 3.3, 2.5, color);
        strip(g, iso.point(b.d, b.w, b.h), iso.point(apex.d, apex.w, apex.h), 3.3, 2.5, shade(color, 0.88));
        const braceA = mixLocal(a, apex, 0.47);
        const braceB = mixLocal(b, apex, 0.47);
        strip(g, iso.point(braceA.d, braceA.w, braceA.h), iso.point(braceB.d, braceB.w, braceB.h),
            2, 2, shade(color, 0.93));
        g.fillStyle(ironDk, 1);
        const footA = iso.point(a.d, a.w, a.h);
        const footB = iso.point(b.d, b.w, b.h);
        g.fillEllipse(footA.x, footA.y, 3.5, 1.7);
        g.fillEllipse(footB.x, footB.y, 3.5, 1.7);
    };

    drawTruss(farSide);

    // Throwing arm: a visible break opens near the middle; the tip drops as
    // a separate timber while the short arm follows the racking axle.
    const armAngle = 3.62;
    const ux = Math.cos(armAngle);
    const uh = Math.sin(armAngle);
    const originalPivot: LocalPt = { d: 2, w: 0, h: 25 };
    const originalBreak: LocalPt = { d: 2 + ux * 13.2, w: 0, h: 25 + uh * 13.2 };
    const originalTip: LocalPt = { d: 2 + ux * 30, w: 0, h: 25 + uh * 30 };
    const fallenPivot: LocalPt = { d: 2 + downD * 9, w: downW * 9, h: 4.8 };
    const fallenInnerEnd: LocalPt = { d: -6 + downD * 5, w: downW * 5, h: 3.4 };
    const fallenOuterStart: LocalPt = { d: -8 + downD * 1.5, w: downW * 1.5, h: 2.5 };
    const fallenTip: LocalPt = { d: -25 - downD * 2, w: -downW * 2, h: 1.35 };
    const pivot = mixLocal(originalPivot, fallenPivot, rack);
    const innerEnd = mixLocal(originalBreak, fallenInnerEnd, snap * rack);
    const outerFall = smooth(span(p, 0.1, 0.72));
    const outerStart = mixLocal(originalBreak, fallenOuterStart, outerFall);
    const outerTip = mixLocal(originalTip, fallenTip, outerFall);

    strip(g, iso.point(pivot.d, pivot.w, pivot.h), iso.point(innerEnd.d, innerEnd.w, innerEnd.h),
        5, 3.1, wood);
    strip(g, iso.point(outerStart.d, outerStart.w, outerStart.h), iso.point(outerTip.d, outerTip.w, outerTip.h),
        3.2, 2.1, wood);
    line(g, iso.point(pivot.d, pivot.w, pivot.h + 0.25), iso.point(innerEnd.d, innerEnd.w, innerEnd.h + 0.25),
        0.95, woodLt);
    line(g, iso.point(outerStart.d, outerStart.w, outerStart.h + 0.2), iso.point(outerTip.d, outerTip.w, outerTip.h + 0.2),
        0.85, woodLt);

    if (snap > 0.04) {
        // Deterministic splinters follow fixed arcs and become low rubble.
        for (let i = 0; i < 5; i++) {
            const flight = smooth(span(p, 0.08 + i * 0.012, 0.52 + i * 0.025));
            const endD = originalBreak.d + (i - 2) * 2.1 + downD * (2 + i * 0.7);
            const endW = (i - 2) * 1.25 + downW * (2 + i * 0.45);
            const arcH = Math.sin(flight * Math.PI) * (2.4 + (i % 2) * 1.3);
            const chip: LocalPt = {
                d: lerp(originalBreak.d, endD, flight),
                w: lerp(0, endW, flight),
                h: lerp(originalBreak.h, 0.9 + (i % 2) * 0.35, flight) + arcH,
            };
            const c = iso.point(chip.d, chip.w, chip.h);
            const dx = iso.fx * (1.1 + (i % 3) * 0.35);
            const dy = iso.fy * (1.1 + (i % 3) * 0.35) - 0.5;
            strip(g, { x: c.x - dx, y: c.y - dy }, { x: c.x + dx, y: c.y + dy },
                0.7, 0.35, i % 2 ? woodDk : woodLt);
        }
    }

    const originalYoke: LocalPt = { d: 2 - ux * 11, w: 0, h: 25 - uh * 11 };
    const fallenYoke: LocalPt = { d: 9 + downD * 7, w: downW * 7, h: 3.65 };
    const yoke = mixLocal(originalYoke, fallenYoke, Math.max(drop, rack));
    strip(g, iso.point(pivot.d, pivot.w, pivot.h), iso.point(yoke.d, yoke.w, yoke.h),
        4.8, 4, shade(wood, 0.9));
    strip(g, iso.point(yoke.d, yoke.w - 2.8, yoke.h), iso.point(yoke.d, yoke.w + 2.8, yoke.h),
        2, 2, woodDk);

    const boxD = lerp(12.0, 12 + downD * 3.4, drop);
    const boxW = lerp(0, downW * 3.4, drop);
    const boxTop = lerp(26, 7.0, drop);
    drawCuboid(g, iso, boxD, boxW, Math.max(0.75, boxTop - 6.2), boxTop,
        4.1, 3.4, iron, iron, 1);
    if (level >= 3) {
        const c = iso.point(boxD, boxW, boxTop + 0.08);
        g.lineStyle(0.9, gold, 1);
        g.strokeEllipse(c.x, c.y, 6.2, 2.8);
    }

    const chainBreak = smooth(span(p, 0.12, 0.3));
    const yokeScreen = iso.point(yoke.d, yoke.w, yoke.h);
    const boxTopScreen = iso.point(boxD, boxW, boxTop);
    if (chainBreak < 0.98) {
        line(g, yokeScreen, boxTopScreen, 1.15, ironDk, 1 - chainBreak * 0.35);
    } else {
        const dangling = iso.point(yoke.d + downD * 1.4, yoke.w + downW * 1.4, Math.max(1.4, yoke.h - 3.1));
        line(g, yokeScreen, dangling, 1.15, ironDk);
        line(g, boxTopScreen, iso.point(boxD - downD * 1.8, boxW - downW * 1.8, boxTop + 1.15), 1.1, ironDk);
    }

    const pivotScreen = iso.point(pivot.d, pivot.w, pivot.h);
    g.fillStyle(iron, 1);
    g.fillCircle(pivotScreen.x, pivotScreen.y, 2.2);
    g.fillStyle(level >= 3 ? gold : ironLt, 1);
    g.fillCircle(pivotScreen.x - 0.4, pivotScreen.y - 0.4, 1.05);

    drawTruss(-farSide);

    // The owner shield and pennant ride down with the near trestle and remain
    // recognizable in the final, low wreck.
    const shieldStart: LocalPt = { d: 1.6, w: -farSide * 6.2, h: 13.5 };
    const shieldEnd: LocalPt = { d: 3 + downD * 8, w: -farSide * 4 + downW * 8, h: 1.2 };
    const shield = mixLocal(shieldStart, shieldEnd, rack);
    const shieldPt = iso.point(shield.d, shield.w, shield.h);
    g.fillStyle(woodDk, 1);
    g.fillEllipse(shieldPt.x, shieldPt.y, lerp(6, 7, rack), lerp(6, 2.8, rack));
    g.fillStyle(cloth, 1);
    g.fillEllipse(shieldPt.x, shieldPt.y - 0.15, lerp(4.4, 5.3, rack), lerp(4.4, 2.0, rack));
    g.fillStyle(level >= 3 ? gold : ironLt, 1);
    g.fillCircle(shieldPt.x, shieldPt.y - 0.15, 0.8);

    if (level >= 2) {
        const apex = apexOf(-farSide);
        const mastBase = iso.point(apex.d, apex.w, apex.h + 0.4);
        const mastTop = iso.point(
            lerp(2, apex.d + downD * 3.2, rack),
            lerp(0, apex.w + downW * 3.2, rack),
            lerp(30, 3.2, rack)
        );
        line(g, mastBase, mastTop, 1, woodDk);
        const flagTip = iso.point(
            lerp(-3.2, apex.d - iso.ca * 4 + downD * 2.4, rack),
            lerp(0, apex.w + iso.sa * 4 + downW * 2.4, rack),
            lerp(28.6, 1.45, rack)
        );
        fillPolygon(g, [
            mastTop,
            flagTip,
            { x: lerp(mastTop.x, flagTip.x, 0.22), y: lerp(mastTop.y, flagTip.y, 0.22) + lerp(2.5, 1.0, rack) },
        ], cloth);
        if (level >= 3) line(g, mastTop, flagTip, 0.8, gold);
    }

    drawWheel(13.5, -farSide * 8, 0.65);
    drawWheel(-13.5, -farSide * 8, 0.9);
    for (const c of crew) {
        if (iso.groundY(c.d, c.w) >= -1.5) drawEngineer(c.d, c.w, c.direction);
    }

    // Broken windlass: its drum drops onto the rear deck but stays attached.
    const drumH = lerp(6.3, 2.4, crush);
    const drumA = iso.point(-16 + downD * settle * 1.5, -3.6 + downW * settle * 1.5, drumH);
    const drumB = iso.point(-16 + downD * settle * 1.5, 3.6 + downW * settle * 1.5, drumH);
    strip(g, drumA, drumB, 3.4, 3.4, woodDk);
    strip(g, drumA, drumB, 1.7, 1.7, wood);
    g.fillStyle(ironDk, 1);
    g.fillCircle(drumA.x, drumA.y, 1.5);
    g.fillCircle(drumB.x, drumB.y, 1.5);
}

function drawWarelephantDeath(g: G, isPlayer: boolean, level: number, facingAngle: number, phase: number): void {
    // Hold the promoted Bastion Tusker for the opening beat. Besides making
    // frame zero an exact hand-off from the living sprite, this keeps its
    // distinctive armor rhythm readable before gravity takes over.
    if (phase <= 0.08) {
        drawWarelephantA(g, isPlayer, false, facingAngle, level, 0, -1, 2000, 0);
        return;
    }

    const iso = basis(facingAngle, 9.5);
    const p = span(phase, 0.08, 1);
    const own = (color: number): number => {
        if (isPlayer) return color;
        const r = Math.round(((color >> 16) & 0xff) * 0.93);
        const gg = Math.round(((color >> 8) & 0xff) * 0.8);
        const b = Math.round((color & 0xff) * 0.82);
        return (r << 16) | (gg << 8) | b;
    };
    const ownMetal = (color: number): number => {
        if (isPlayer) return color;
        const r = Math.round(((color >> 16) & 0xff) * 0.95);
        const gg = Math.round(((color >> 8) & 0xff) * 0.87);
        const b = Math.round((color & 0xff) * 0.87);
        return (r << 16) | (gg << 8) | b;
    };
    const hideMid = own(0x8d8d99);
    const hideHi = own(0xa4a4b0);
    const hideLo = own(0x73737e);
    const hideDeep = own(0x5b5b65);
    const tusk = ownMetal(0xe9e3d2);
    const tuskLo = ownMetal(0xc8c0aa);
    const cloth = own(0xa8322a);
    const clothHi = own(0xc04a3c);
    const clothLo = own(0x7c231d);
    let plate: number;
    let plateHi: number;
    let plateLo: number;
    let timber: number;
    let timberLo: number;
    let trim: number;
    let rivet: number;
    if (level >= 3) {
        plate = own(0x4a505a);
        plateHi = own(0x6d7480);
        plateLo = own(0x2f333b);
        timber = own(0xbfb49a);
        timberLo = own(0x8f866c);
        trim = ownMetal(0xdaa520);
        rivet = ownMetal(0xdaa520);
    } else if (level >= 2) {
        plate = own(0x565b64);
        plateHi = own(0x7c828d);
        plateLo = own(0x373b42);
        timber = own(0x77572f);
        timberLo = own(0x50391e);
        trim = own(0x8f959f);
        rivet = own(0x2e3138);
    } else {
        plate = own(0x6b4a32);
        plateHi = own(0x82593c);
        plateLo = own(0x46301f);
        timber = own(0x7a5a34);
        timberLo = own(0x523c22);
        trim = own(0x8b6b40);
        rivet = own(0x3c2a1a);
    }
    const leather = clothLo;
    const gold = trim;
    const goldHi = level >= 3 ? ownMetal(0xffd700) : plateHi;

    const downD = iso.sa;
    const downW = iso.ca;
    const kneel = smooth(span(p, 0.02, 0.38));
    const collapse = smooth(span(p, 0.22, 0.7));
    const gearFall = smooth(span(p, 0.16, 0.72));
    const animalFade = smooth(span(p, 0.52, 0.9));
    const animalAlpha = 1 - animalFade;
    const shiftD = downD * collapse * 2.6;
    const shiftW = downW * collapse * 2.6;
    const bodyDrop = kneel * 3.6 + collapse * 2.6;

    contactShadow(
        g,
        iso,
        lerp(1.8, downD * 4, gearFall),
        lerp(0, downW * 4, gearFall),
        lerp(14.2, 10.2, animalFade),
        lerp(7.3, 6.1, animalFade),
        lerp(0.25, 0.21, animalFade)
    );

    interface Leg {
        d: number;
        side: number;
        front: boolean;
    }
    const legs: Leg[] = [
        { d: 6.2, side: -1, front: true },
        { d: 6.2, side: 1, front: true },
        { d: -8.6, side: -1, front: false },
        { d: -8.6, side: 1, front: false },
    ].sort((a, b) => iso.groundY(a.d, a.side * 4.3) - iso.groundY(b.d, b.side * 4.3));

    const drawLeg = (leg: Leg, near: boolean): void => {
        if (animalAlpha <= 0) return;
        const fold = leg.front ? kneel : collapse;
        const w = leg.side * 4.3;
        const hipH = 10.5 - (leg.front ? kneel * 3.8 : collapse * 3.2) - collapse * 1.1;
        const hip = iso.point(leg.d + shiftD * 0.8, w + shiftW * 0.8, hipH);
        const knee = iso.point(
            leg.d + (leg.front ? -2.4 : 1.8) * fold + shiftD * 0.35,
            w + leg.side * fold * 0.45 + shiftW * 0.35,
            lerp(4.5, 1.8, fold)
        );
        const foot = iso.point(
            leg.d + (leg.front ? 1.2 : -0.7) * fold,
            w + leg.side * fold * 0.65,
            0.25
        );
        const color = near ? hideMid : hideLo;
        strip(g, hip, knee, 3.6, 3.2, color, animalAlpha);
        strip(g, knee, foot, 3.2, 3.6, shade(color, 0.9), animalAlpha);
        g.fillStyle(shade(color, 0.78), animalAlpha);
        g.fillEllipse(foot.x, foot.y - 0.35, 4.8, 2.0);
        if (near) {
            g.fillStyle(0xcac3ae, animalAlpha * 0.86);
            g.fillEllipse(foot.x + iso.fx * 0.8, foot.y - 0.3, 2.0, 0.75);
        }
    };

    const farCount = 2;
    for (let i = 0; i < farCount; i++) drawLeg(legs[i], false);

    if (animalAlpha > 0) {
        // The knees fold first, then the barrel settles sideways into the
        // contact shadow. It is deliberately gone before the persistent frame.
        const bodyCenter = iso.point(-1.5 + shiftD, shiftW, 13.4 - bodyDrop);
        const bodyLD = 11.6 * (1 + collapse * 0.08);
        const bodyLW = 6.6 * (1 + collapse * 0.06);
        const bodyLH = lerp(6.9, 5.2, collapse);
        const a11 = iso.ca * iso.ca * bodyLD * bodyLD + iso.sa * iso.sa * bodyLW * bodyLW;
        const a12 = 0.5 * iso.ca * iso.sa * (bodyLD * bodyLD - bodyLW * bodyLW);
        const a22 = 0.25 * (iso.sa * iso.sa * bodyLD * bodyLD + iso.ca * iso.ca * bodyLW * bodyLW)
            + bodyLH * bodyLH;
        const b11 = Math.sqrt(a11);
        const b21 = a12 / b11;
        const b22 = Math.sqrt(Math.max(0.01, a22 - b21 * b21));
        const bodyRing = (scale: number, ox: number, oy: number): Pt[] => {
            const points: Pt[] = [];
            for (let i = 0; i < 20; i++) {
                const angle = (i / 20) * TAU;
                const c = Math.cos(angle);
                const s = Math.sin(angle);
                points.push({
                    x: bodyCenter.x + ox + b11 * c * scale,
                    y: bodyCenter.y + oy + (b21 * c + b22 * s) * scale,
                });
            }
            return points;
        };
        fillPolygon(g, bodyRing(1, 0, 0), hideDeep, animalAlpha);
        fillPolygon(g, bodyRing(0.93, -0.4, -1.1), hideMid, animalAlpha);
        fillPolygon(g, bodyRing(0.58, -2.0, -2.9), hideHi, animalAlpha);

        // Tail follows the collapsing hips; its tuft disappears with the bull.
        const tailA = iso.point(-12.6 + shiftD, shiftW, Math.max(3.1, 16.2 - bodyDrop));
        const tailB = iso.point(-15.1 + shiftD + downD * collapse, shiftW - iso.sa * 1.8, Math.max(0.9, 7.4 - bodyDrop * 0.55));
        strip(g, tailA, tailB, 2.0, 1.2, hideLo, animalAlpha);
        g.fillStyle(hideDeep, animalAlpha);
        g.fillEllipse(tailB.x, tailB.y, 2.6, 3.0);
    }

    for (let i = farCount; i < legs.length; i++) drawLeg(legs[i], true);

    // The Bastion Tusker's four flank bands and twin crimson girths are its
    // strongest mid-distance identifiers. Each arc starts wrapped around the
    // living barrel, then uncoils into a low strip of salvage beside the
    // fallen howdah instead of vanishing with the animal.
    const gearArc = (d0: number, grow: number, phiMax: number, arcIndex: number): LocalPt[] => {
        const scale = Math.sqrt(Math.max(0.05, 1 - ((d0 + 1.5) / 11.6) ** 2));
        const radiusW = 6.6 * scale + grow;
        const radiusH = 6.9 * scale + grow;
        const points: LocalPt[] = [];
        for (let i = 0; i <= 10; i++) {
            const t = i / 10;
            const phi = -phiMax + t * phiMax * 2;
            const start: LocalPt = {
                d: d0 + shiftD,
                w: radiusW * Math.sin(phi) + shiftW,
                h: 13.4 - bodyDrop + radiusH * Math.cos(phi),
            };
            const end: LocalPt = {
                d: d0 + downD * (2.6 + arcIndex * 0.55) + (t - 0.5) * 2.2,
                w: (t - 0.5) * 8.2 + downW * (2.6 + arcIndex * 0.55),
                h: 0.58 + Math.sin(t * Math.PI) * (0.5 + (arcIndex % 2) * 0.18),
            };
            points.push(mixLocal(start, end, gearFall));
        }
        return points;
    };
    const drawGearArc = (points: LocalPt[], outer: number, inner: number, innerColor: number): void => {
        const screen = points.map((point) => iso.point(point.d, point.w, point.h));
        for (let i = 0; i < screen.length - 1; i++) line(g, screen[i], screen[i + 1], outer, plateLo);
        for (let i = 0; i < screen.length - 1; i++) line(g, screen[i], screen[i + 1], inner, innerColor);
        return;
    };
    [-9.1, -6.2, 2.6, 5.4].forEach((d0, index) => {
        const arc = gearArc(d0, 0.4, 1.32, index);
        drawGearArc(arc, 3.4, 2.2, plate);
        g.fillStyle(rivet, 1);
        for (const i of [1, 3, 5, 7, 9]) {
            const q = iso.point(arc[i].d, arc[i].w, arc[i].h);
            g.fillCircle(q.x, q.y, 0.5);
        }
        const litA = iso.point(arc[3].d, arc[3].w, arc[3].h + 0.1);
        const litB = iso.point(arc[6].d, arc[6].w, arc[6].h + 0.1);
        line(g, litA, litB, 0.85, plateHi);
    });
    [-5.2, -2.8].forEach((d0, index) => {
        const arc = gearArc(d0, 0.5, 1.18, 4 + index);
        const screen = arc.map((point) => iso.point(point.d, point.w, point.h));
        for (let i = 0; i < screen.length - 1; i++) line(g, screen[i], screen[i + 1], 4.8, clothLo);
        for (let i = 0; i < screen.length - 1; i++) line(g, screen[i], screen[i + 1], 3.2, cloth);
        if (level >= 3) {
            g.fillStyle(trim, 1);
            g.fillCircle(screen[0].x, screen[0].y, 0.7);
            g.fillCircle(screen[screen.length - 1].x, screen[screen.length - 1].y, 0.7);
        }
    });

    if (animalAlpha > 0) {
        const headD = 13.0 + shiftD + collapse * 1.8;
        const headH = Math.max(3.4, 14.2 - bodyDrop * 1.25);
        const headW = shiftW;
        const farEarSide = iso.ca >= 0 ? -1 : 1;
        const drawEar = (side: number): void => {
            const c = iso.point(headD - 1.7, headW + side * (5.6 + kneel * 0.8), headH + 1.5);
            g.fillStyle(hideLo, animalAlpha);
            g.fillEllipse(c.x + 0.4, c.y + 0.5, 6.1, 7.2);
            g.fillStyle(hideHi, animalAlpha);
            g.fillEllipse(c.x - 0.3, c.y - 0.3, 5.2, 6.3);
            g.fillStyle(hideMid, animalAlpha);
            g.fillEllipse(c.x + 0.7, c.y + 0.8, 3.1, 3.8);
        };
        drawEar(farEarSide);
        const dome = iso.point(headD, headW, headH);
        g.fillStyle(hideLo, animalAlpha);
        g.fillEllipse(dome.x, dome.y, 10.8, 11.6);
        g.fillStyle(hideMid, animalAlpha);
        g.fillEllipse(dome.x - 0.5, dome.y - 0.8, 9.9, 10.6);
        g.fillStyle(hideHi, animalAlpha);
        g.fillEllipse(dome.x - 1.6, dome.y - 2.6, 5.6, 4.6);
        drawEar(-farEarSide);

        if (Math.abs(iso.ca) >= 0.25) {
            const eye = iso.point(headD + 0.7, headW + (iso.ca > 0 ? 1 : -1) * 4.0, headH + 0.1);
            g.fillStyle(0x26262c, animalAlpha);
            g.fillEllipse(eye.x, eye.y, 1.3, 1.5);
        }

        // Tusks and trunk sink with the head, then fade completely. Nothing
        // anatomical survives in the persistent remnant.
        for (const side of [-1, 1]) {
            const keys = [
                { d: headD + 1.0, w: headW + side * 2.5, h: headH - 3.5, r: 1.25 },
                { d: headD + 3.2, w: headW + side * 3.1, h: headH - 5.2, r: 1.0 },
                { d: headD + 5.1, w: headW + side * 3.0, h: headH - 4.4, r: 0.7 },
            ];
            g.fillStyle(tuskLo, animalAlpha);
            for (const key of keys) {
                const q = iso.point(key.d, key.w, Math.max(0.55, key.h));
                g.fillEllipse(q.x + 0.3, q.y + 0.35, key.r * 2.2, key.r * 2.2);
            }
            g.fillStyle(tusk, animalAlpha);
            for (const key of keys) {
                const q = iso.point(key.d, key.w, Math.max(0.65, key.h + 0.2));
                g.fillEllipse(q.x - 0.15, q.y - 0.2, key.r * 1.8, key.r * 1.8);
            }
        }
        const trunkSegments: Array<{ point: Pt; radius: number }> = [];
        for (let i = 0; i < 7; i++) {
            const t = i / 6;
            trunkSegments.push({
                point: iso.point(
                    headD + 1.5 + t * (3.5 + collapse * 2.4),
                    headW + Math.sin(t * Math.PI) * downW * collapse * 1.3,
                    Math.max(0.5, headH - 1.5 - t * (7.2 - collapse * 1.6))
                ),
                radius: 1.55 - t * 0.78,
            });
        }
        g.fillStyle(hideLo, animalAlpha);
        for (const segment of trunkSegments) {
            g.fillEllipse(segment.point.x + 0.4, segment.point.y + 0.4,
                segment.radius * 2, segment.radius * 2.2);
        }
        g.fillStyle(hideMid, animalAlpha);
        for (const segment of trunkSegments) {
            g.fillEllipse(segment.point.x - 0.15, segment.point.y - 0.22,
                segment.radius * 2, segment.radius * 2.2);
        }
    }

    // A folded piece of canopy cloth reveals only as the howdah tears free;
    // design A has crimson girths, not a full living caparison. In the final
    // artifact this becomes a compact textile bed, never a footprint plate.
    const blanketStart: LocalPt[] = [
        { d: -7.2, w: -4.7, h: 12.8 },
        { d: -2.4, w: -5.3, h: 14.2 },
        { d: 4.0, w: -4.5, h: 14.4 },
        { d: 5.0, w: 0, h: 15.0 },
        { d: 4.0, w: 4.5, h: 14.4 },
        { d: -2.4, w: 5.3, h: 14.2 },
        { d: -7.2, w: 4.7, h: 12.8 },
        { d: -8.0, w: 0, h: 12.2 },
    ];
    const blanketEnd: LocalPt[] = [
        { d: -6.8 + downD * 4, w: -4.7 + downW * 4, h: 0.7 },
        { d: -1.8 + downD * 4, w: -5.2 + downW * 4, h: 1.0 },
        { d: 4.8 + downD * 4, w: -3.7 + downW * 4, h: 0.8 },
        { d: 5.6 + downD * 4, w: 0.4 + downW * 4, h: 1.2 },
        { d: 3.4 + downD * 4, w: 4.8 + downW * 4, h: 0.75 },
        { d: -1.0 + downD * 4, w: 5.5 + downW * 4, h: 1.35 },
        { d: -6.1 + downD * 4, w: 3.8 + downW * 4, h: 0.75 },
        { d: -7.5 + downD * 4, w: -0.4 + downW * 4, h: 1.15 },
    ];
    const blanket = blanketStart.map((point, i) => mixLocal(point, blanketEnd[i], gearFall));
    const blanketScreen = blanket.map((point) => iso.point(point.d, point.w, point.h));
    const fallenClothAlpha = smooth(span(p, 0.18, 0.48));
    fillPolygon(g, blanketScreen.map((point) => ({ x: point.x + 0.65, y: point.y + 0.85 })), clothLo, fallenClothAlpha);
    fillPolygon(g, blanketScreen, cloth, fallenClothAlpha);
    const stripeA = mixLocal({ d: -6.2, w: 0, h: 13.5 }, { d: -5.5 + downD * 4, w: downW * 4, h: 1.35 }, gearFall);
    const stripeB = mixLocal({ d: 4.0, w: 0, h: 15.1 }, { d: 4.3 + downD * 4, w: downW * 4, h: 1.3 }, gearFall);
    line(g, iso.point(stripeA.d, stripeA.w, stripeA.h), iso.point(stripeB.d, stripeB.w, stripeB.h),
        1.1, level >= 3 ? trim : clothHi, fallenClothAlpha);
    if (level >= 3) {
        for (const index of [1, 3, 5]) {
            const q = blanket[index];
            const point = iso.point(q.d, q.w, q.h - 0.25);
            g.fillStyle(gold, fallenClothAlpha);
            g.fillEllipse(point.x, point.y, 1.35, lerp(1.8, 1.2, gearFall));
        }
    }

    // Bastion Tusker's high, crimson-canopied howdah: exact living height at
    // the opening, then fallen and bent over the cloth at phase one. This —
    // not anatomy — is the lasting remnant read.
    const howdahStart: LocalPt[] = [
        { d: -7.3, w: -3.0, h: 19.6 },
        { d: -0.7, w: -3.0, h: 19.6 },
        { d: -0.7, w: 3.0, h: 19.6 },
        { d: -7.3, w: 3.0, h: 19.6 },
    ];
    const howdahEnd: LocalPt[] = [
        { d: -4 + downD * 5, w: -3.1 + downW * 5, h: 1.2 },
        { d: 4 + downD * 5, w: -2.2 + downW * 5, h: 1.0 },
        { d: 3 + downD * 5, w: 4.0 + downW * 5, h: 1.4 },
        { d: -3 + downD * 5, w: 3.1 + downW * 5, h: 1.8 },
    ];
    const railBases = howdahStart.map((point, i) => mixLocal(point, howdahEnd[i], gearFall));
    for (let i = 0; i < 4; i++) {
        const next = (i + 1) % 4;
        strip(g,
            iso.point(railBases[i].d, railBases[i].w, railBases[i].h),
            iso.point(railBases[next].d, railBases[next].w, railBases[next].h),
            1.45, 1.45, i % 2 === 0 ? timber : timberLo);
    }
    const finalTopHeights = [4.6, 2.8, 3.8, 2.4];
    const railTops = howdahStart.map((point, i) => mixLocal(
        { d: point.d, w: point.w, h: point.h + 5.2 },
        { d: howdahEnd[i].d + (i < 2 ? -downD * 0.8 : downD * 0.5),
            w: howdahEnd[i].w + (i < 2 ? -downW * 0.8 : downW * 0.5), h: finalTopHeights[i] },
        gearFall
    ));
    for (let i = 0; i < 4; i++) {
        strip(g,
            iso.point(railBases[i].d, railBases[i].w, railBases[i].h),
            iso.point(railTops[i].d, railTops[i].w, railTops[i].h),
            1.25, 1.0, timber);
    }
    for (const [a, b] of [[0, 1], [3, 2]] as const) {
        strip(g,
            iso.point(railTops[a].d, railTops[a].w, railTops[a].h),
            iso.point(railTops[b].d, railTops[b].w, railTops[b].h),
            1.0, 1.0, level >= 3 ? gold : timber);
    }
    const canopy = railTops.map(point => iso.point(point.d, point.w, point.h));
    fillPolygon(g, canopy.map(point => ({ x: point.x + 0.45, y: point.y + 0.65 })), clothLo);
    fillPolygon(g, canopy, cloth);
    const canopyCenter = canopy.reduce((center, point) => ({
        x: center.x + point.x / canopy.length,
        y: center.y + point.y / canopy.length,
    }), { x: 0, y: 0 });
    g.fillStyle(cloth, 1);
    g.fillEllipse(canopyCenter.x, canopyCenter.y - lerp(0.9, 0.15, gearFall),
        lerp(7.2, 6.0, gearFall), lerp(4.0, 2.2, gearFall));
    g.fillStyle(clothHi, 1);
    g.fillEllipse(canopyCenter.x - 0.8, canopyCenter.y - lerp(1.7, 0.35, gearFall),
        lerp(4.6, 3.4, gearFall), lerp(2.3, 1.2, gearFall));
    if (level >= 3) {
        g.fillStyle(trim, 1);
        g.fillCircle(canopyCenter.x, canopyCenter.y - lerp(3.1, 0.55, gearFall), 0.9);
    }

    // Harness straps peel off the barrel with the saddle and lie across the
    // final blanket. Their warm leather keeps L1's material language intact.
    const strapPairs: Array<[LocalPt, LocalPt, LocalPt, LocalPt]> = [
        [
            { d: -3.2, w: -5.0, h: 11.7 }, { d: -3.2, w: 5.0, h: 11.7 },
            { d: -4 + downD * 4, w: -4.2 + downW * 4, h: 1.4 },
            { d: -2 + downD * 4, w: 4.6 + downW * 4, h: 1.5 },
        ],
        [
            { d: 2.4, w: -5.0, h: 12.4 }, { d: 2.4, w: 5.0, h: 12.4 },
            { d: 1 + downD * 4, w: -4.6 + downW * 4, h: 1.45 },
            { d: 3.7 + downD * 4, w: 4.1 + downW * 4, h: 1.35 },
        ],
    ];
    for (const pair of strapPairs) {
        const a = mixLocal(pair[0], pair[2], gearFall);
        const b = mixLocal(pair[1], pair[3], gearFall);
        line(g, iso.point(a.d, a.w, a.h), iso.point(b.d, b.w, b.h), 1.2, leather);
    }

    // The chanfron detaches from the fading head and lands face-up as the
    // clearest level marker in the persistent remnant.
    const plateStart: LocalPt[] = [
        { d: 10.7, w: 0, h: 14.5 },
        { d: 13.2, w: 3.0, h: 11.3 },
        { d: 16.0, w: 0, h: 8.5 },
        { d: 13.2, w: -3.0, h: 11.3 },
    ];
    const plateEnd: LocalPt[] = [
        { d: 8.5 + downD * 5.5, w: downW * 5.5, h: 2.9 },
        { d: 11.5 + downD * 5.5, w: 2.7 + downW * 5.5, h: 0.8 },
        { d: 14.7 + downD * 5.5, w: downW * 5.5, h: 0.65 },
        { d: 11.5 + downD * 5.5, w: -2.7 + downW * 5.5, h: 0.8 },
    ];
    const plateFall = smooth(span(p, 0.24, 0.76));
    const platePoints = plateStart.map((point, i) => mixLocal(point, plateEnd[i], plateFall))
        .map((point) => iso.point(point.d, point.w, point.h));
    fillPolygon(g, platePoints, plateLo);
    const cx = platePoints.reduce((sum, point) => sum + point.x, 0) / platePoints.length;
    const cy = platePoints.reduce((sum, point) => sum + point.y, 0) / platePoints.length;
    fillPolygon(g, platePoints.map((point) => ({
        x: cx + (point.x - cx) * 0.78,
        y: cy + (point.y - cy) * 0.78,
    })), plate);
    line(g, platePoints[0], platePoints[2], 1.15, plateHi);
    const boss = {
        x: lerp(platePoints[0].x, platePoints[2].x, 0.58),
        y: lerp(platePoints[0].y, platePoints[2].y, 0.58),
    };
    g.fillStyle(level === 3 ? gold : level === 2 ? 0x3c4046 : plateLo, 1);
    g.fillCircle(boss.x, boss.y, 1.15);
    if (level === 3) {
        g.fillStyle(goldHi, 1);
        g.fillCircle(boss.x - 0.35, boss.y - 0.35, 0.5);
    }

    if (level === 3) {
        const poleBase = mixLocal(
            { d: -5.8, w: 0, h: 16.0 },
            { d: -5.5 + downD * 5, w: downW * 5, h: 1.2 },
            gearFall
        );
        const poleTop = mixLocal(
            { d: -5.8, w: 0, h: 25.0 },
            { d: -0.5 + downD * 5, w: downW * 5, h: 1.6 },
            gearFall
        );
        const a = iso.point(poleBase.d, poleBase.w, poleBase.h);
        const b = iso.point(poleTop.d, poleTop.w, poleTop.h);
        strip(g, a, b, 1.15, 0.9, timber);
        const flagTip = iso.point(
            lerp(-0.2, -0.6 + downD * 5, gearFall),
            lerp(0, 2.8 + downW * 5, gearFall),
            lerp(23.3, 1.0, gearFall)
        );
        fillPolygon(g, [b, flagTip, { x: lerp(b.x, flagTip.x, 0.18), y: lerp(b.y, flagTip.y, 0.18) + 2.2 }], cloth);
        g.fillStyle(goldHi, 1);
        g.fillCircle(b.x, b.y - 0.45, 0.9);
    }
}

/**
 * Deterministic vector source for the baked death frames of the two largest
 * promoted troops. `phase` is clamped to 0..1: zero preserves the living
 * silhouette, while one is a low, static remnant suitable for depth sorting.
 */
export function drawHeavyDeath(
    g: G,
    type: HeavyDeathType,
    isPlayer: boolean,
    troopLevel: number,
    facingAngle: number,
    phase: number
): void {
    const p = clamp01(phase);
    const level = Math.max(1, Math.min(3, Math.floor(Number.isFinite(troopLevel) ? troopLevel : 1)));
    if (type === 'trebuchet') {
        drawTrebuchetDeath(g, isPlayer, level, facingAngle, p);
        return;
    }
    drawWarelephantDeath(g, isPlayer, level, facingAngle, p);
}
