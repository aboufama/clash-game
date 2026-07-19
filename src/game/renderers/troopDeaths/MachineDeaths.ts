import type Phaser from 'phaser';
import { drawSiegetowerC } from '../redesign/SiegetowerC';
import { DAVINCI_GEOM, davinciTankPalette, drawDaVinciTank } from '../redesign/DaVinciTank';

/** Large machines whose death silhouettes are authored here for sprite baking. */
export type MachineDeathType = 'davincitank' | 'siegetower';

type G = Phaser.GameObjects.Graphics;
type V2 = readonly [number, number];
type V3 = readonly [number, number, number];

const TAU = Math.PI * 2;
const GROUND_Y = 9;

const clamp01 = (value: number): number => {
    if (!Number.isFinite(value)) return 0;
    return value <= 0 ? 0 : value >= 1 ? 1 : value;
};
const smooth = (value: number): number => {
    const t = clamp01(value);
    return t * t * (3 - 2 * t);
};
const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
const lerp3 = (a: V3, b: V3, t: number): V3 => [
    lerp(a[0], b[0], t),
    lerp(a[1], b[1], t),
    lerp(a[2], b[2], t),
];

function shade(color: number, amount: number): number {
    const r = Math.max(0, Math.min(255, Math.round(((color >> 16) & 0xff) * amount)));
    const g = Math.max(0, Math.min(255, Math.round(((color >> 8) & 0xff) * amount)));
    const b = Math.max(0, Math.min(255, Math.round((color & 0xff) * amount)));
    return (r << 16) | (g << 8) | b;
}

function polygon(g: G, points: readonly V2[], color: number, alpha = 1): void {
    if (points.length < 3) return;
    g.fillStyle(color, alpha);
    g.beginPath();
    g.moveTo(points[0][0], points[0][1]);
    for (let i = 1; i < points.length; i++) g.lineTo(points[i][0], points[i][1]);
    g.closePath();
    g.fillPath();
}

interface View {
    readonly ca: number;
    readonly sa: number;
    point(value: V3): V2;
    dot(normal: V3): number;
    light(normal: V3): number;
}

function makeView(facingAngle: number, groundY = GROUND_Y): View {
    const angle = Number.isFinite(facingAngle) ? facingAngle : 0;
    const ca = Math.cos(angle);
    const sa = Math.sin(angle);
    return {
        ca,
        sa,
        point: ([d, w, h]) => [d * ca - w * sa, (d * sa + w * ca) * 0.5 - h + groundY],
        dot: ([d, w, h]) => d * sa + w * ca + h * 0.5,
        light: ([d, w, h]) => {
            const screenNormalX = d * ca - w * sa;
            return Math.max(0.52, Math.min(1.16, 0.78 + h * 0.3 - screenNormalX * 0.13));
        },
    };
}

interface Transform {
    point(value: V3): V3;
    vector(value: V3): V3;
}

function transformAround(
    pivotH: number,
    pitch: number,
    roll: number,
    drop: number,
    shiftD: number,
    shiftW: number,
    heightScale = 1,
): Transform {
    const cp = Math.cos(pitch), sp = Math.sin(pitch);
    const cr = Math.cos(roll), sr = Math.sin(roll);
    const apply = (value: V3, isPoint: boolean): V3 => {
        let d = value[0];
        const w = value[1];
        let h = isPoint ? (value[2] - pivotH) * heightScale : value[2] * heightScale;
        const pd = d * cp + h * sp;
        const ph = -d * sp + h * cp;
        d = pd;
        h = ph;
        const rw = w * cr - h * sr;
        const rh = w * sr + h * cr;
        return [
            d + (isPoint ? shiftD : 0),
            rw + (isPoint ? shiftW : 0),
            rh + (isPoint ? pivotH - drop : 0),
        ];
    };
    return {
        point: value => apply(value, true),
        vector: value => apply(value, false),
    };
}

interface Face {
    points: readonly V3[];
    normal: V3;
    kind: 'side' | 'top' | 'bottom';
}

function drawBox(
    g: G,
    view: View,
    transform: Transform,
    d0: number,
    d1: number,
    w0: number,
    w1: number,
    h0: number,
    h1: number,
    sideColor: number,
    topColor = shade(sideColor, 1.12),
): void {
    const faces: Face[] = [
        { points: [[d1, w0, h0], [d1, w1, h0], [d1, w1, h1], [d1, w0, h1]], normal: [1, 0, 0], kind: 'side' },
        { points: [[d0, w1, h0], [d0, w0, h0], [d0, w0, h1], [d0, w1, h1]], normal: [-1, 0, 0], kind: 'side' },
        { points: [[d0, w1, h0], [d1, w1, h0], [d1, w1, h1], [d0, w1, h1]], normal: [0, 1, 0], kind: 'side' },
        { points: [[d1, w0, h0], [d0, w0, h0], [d0, w0, h1], [d1, w0, h1]], normal: [0, -1, 0], kind: 'side' },
        { points: [[d0, w0, h1], [d1, w0, h1], [d1, w1, h1], [d0, w1, h1]], normal: [0, 0, 1], kind: 'top' },
        { points: [[d0, w1, h0], [d1, w1, h0], [d1, w0, h0], [d0, w0, h0]], normal: [0, 0, -1], kind: 'bottom' },
    ];
    const visible = faces.flatMap(face => {
        const normal = transform.vector(face.normal);
        if (view.dot(normal) <= 0.015) return [];
        const points = face.points.map(point => view.point(transform.point(point)));
        const y = points.reduce((sum, point) => sum + point[1], 0) / points.length;
        const color = face.kind === 'top'
            ? shade(topColor, view.light(normal))
            : face.kind === 'bottom'
                ? shade(sideColor, 0.45)
                : shade(sideColor, view.light(normal));
        return [{ points, color, y }];
    });
    visible.sort((a, b) => a.y - b.y);
    for (const face of visible) polygon(g, face.points, face.color);
}

function segment(g: G, view: View, a: V3, b: V3, width: number, color: number, alpha = 1): void {
    const pa = view.point(a), pb = view.point(b);
    g.lineStyle(width, color, alpha);
    g.lineBetween(pa[0], pa[1], pb[0], pb[1]);
}

function drawSheddingWheel(
    g: G,
    view: View,
    body: Transform,
    center: V3,
    radius: number,
    target: V3,
    detach: number,
    rim: number,
    face: number,
    spoke: number,
    turn: number,
): void {
    const k = smooth(detach);
    const hop = Math.sin(k * Math.PI) * (3.5 + radius * 0.25);
    const pose = (theta: number, r: number): V3 => {
        const attached = body.point([
            center[0] + Math.cos(theta + turn) * r,
            center[1],
            center[2] + Math.sin(theta + turn) * r,
        ]);
        const groundAngle = theta + turn * 0.7;
        const landed: V3 = [
            target[0] + Math.cos(groundAngle) * r,
            target[1] + Math.sin(groundAngle) * r,
            target[2] + hop,
        ];
        return lerp3(attached, landed, k);
    };
    const outer: V2[] = [];
    const inner: V2[] = [];
    for (let i = 0; i < 14; i++) {
        const theta = i / 14 * TAU;
        outer.push(view.point(pose(theta, radius)));
        inner.push(view.point(pose(theta, radius * 0.72)));
    }
    polygon(g, outer, rim);
    polygon(g, inner, face);
    for (let i = 0; i < 4; i++) {
        const theta = turn + i * Math.PI / 2;
        segment(g, view, pose(theta, radius * 0.18), pose(theta, radius * 0.68), 1.2, spoke);
    }
    const hub = view.point(pose(0, 0));
    g.fillStyle(shade(rim, 0.65), 1);
    g.fillCircle(hub[0], hub[1], 1.35);
}

/**
 * DA VINCI TANK death — Testudo rebuild (2026-07-19): the revolver-tank dies
 * by its own magazine. Beats (all deterministic in phase alone):
 *   0.13-0.34 RUPTURE  — hull shudder, port flash, two lids blown off, the
 *                        whole cupola pod launched tumbling off the crown;
 *   0.30-0.62 SHEAR    — the roof cone slides backward off the waist as one
 *                        piece, near bombards sag out of their ports;
 *   0.55-0.90 COLLAPSE — the shell pancakes, rim spreads, rollers splay,
 *                        dust ring, embers die;
 *   1.00 REMNANT       — static wreck: crushed skirt, grounded roof cone,
 *                        cupola pod on its side, spilled bombards, soot fan
 *                        thrown toward its final firing line, the crown
 *                        banner draped dead over the roof piece.
 * The dispatcher keeps p <= 0.13 on the literal live renderer so the first
 * two bake samples cannot pop into an approximation.
 */
function drawDaVinciTankDeath(g: G, view: View, isPlayer: boolean, level: number, phase: number): void {
    const pal = davinciTankPalette(level, isPlayer);
    const GG = DAVINCI_GEOM;
    const p = clamp01(phase);
    const dp = (rel: number, r: number, h: number): V2 => view.point([Math.cos(rel) * r, Math.sin(rel) * r, h]);

    const rupture = smooth((p - 0.13) / 0.2);
    const shear = smooth((p - 0.3) / 0.32);
    const crush = smooth((p - 0.55) / 0.35);
    const jitter = p > 0.13 && p < 0.42 ? Math.sin(p * 113) * 1.4 * (1 - smooth((p - 0.3) / 0.12)) : 0;
    const emberA = p < 0.18 ? 0 : 0.85 * (1 - smooth((p - 0.45) / 0.45));
    const drop = crush * 2.5;
    const spread = crush * 5;
    const hCrush = (h: number): number => (h <= GG.RIM_H ? h : h - (h - GG.RIM_H) * 0.42 * crush) - drop;
    const rSpread = (r: number, h: number): number => r + spread * Math.max(0, 1 - h / GG.WAIST_H);
    const P = (rel: number, r: number, h: number): V2 => {
        const q = dp(rel, rSpread(r, h), hCrush(h));
        return [q[0] + jitter, q[1]];
    };
    const BAY = Math.PI / 4;

    // ---- ground statements first: soot fan + grounded debris shadows ----
    const sootA = 0.42 * smooth((p - 0.28) / 0.5);
    if (sootA > 0.01) {
        const fan = (spanRel: number, len: number, a: number): void => {
            polygon(g, [
                dp(spanRel - 0.5, GG.RIM_R - 4, 0), dp(spanRel + 0.5, GG.RIM_R - 4, 0),
                dp(spanRel + 0.24, GG.RIM_R + len, 0), dp(spanRel - 0.28, GG.RIM_R + len * 0.82, 0)
            ], pal.soot, a);
        };
        fan(0, 15, sootA);
        fan(0.42, 8, sootA * 0.7);
        fan(-0.36, 6, sootA * 0.6);
    }

    // ---- the roof cone, sheared off backward as one piece ----
    if (shear > 0.01) {
        const slide = shear;
        const cd = -6 - 20 * slide;
        const baseH = Math.max(1.6, GG.WAIST_H * (1 - slide) - drop * 0.6);
        const coneH = (GG.CROWN_H - GG.WAIST_H) * (1 - 0.25 * crush);
        const R = GG.WAIST_R * (1 - 0.12 * crush);
        const base = view.point([cd, 0, baseH]);
        const apex = view.point([cd - 6 - 4 * slide, 0, baseH + coneH * (1 - 0.45 * slide)]);
        g.fillStyle(shade(pal.wood, 0.8), 1);
        g.fillEllipse(base[0], base[1], R * 2, R);
        polygon(g, [[base[0] - R, base[1]], [base[0] + R, base[1]], apex], shade(pal.wood, 0.92));
        g.lineStyle(1, shade(pal.wood, 0.5), 0.85);
        g.lineBetween(base[0] - R, base[1], apex[0], apex[1]);
        g.lineBetween(base[0] + R, base[1], apex[0], apex[1]);
        g.lineBetween(base[0] - R * 0.35, base[1] + R * 0.32, apex[0], apex[1]);
        // the dead crown banner drapes over the piece once everything lands
        const drape = smooth((p - 0.8) / 0.14);
        if (drape > 0.01) {
            polygon(g, [
                [apex[0] - 1, apex[1]], [apex[0] + 2.4, apex[1] + 0.6],
                [apex[0] + 3.2, apex[1] + 6.4 * drape], [apex[0] - 2.2, apex[1] + 5.6 * drape]
            ], pal.clothDk, 0.95);
        }
    }

    // ---- far bombards sink, near bombards sag and spill ----
    for (let k = 0; k < 8; k++) {
        const rel = k * BAY;
        const sr = Math.sin(rel) * view.ca + Math.cos(rel) * view.sa; // screen-depth sign of the bay
        const near = sr > -0.1;
        const isFront = k === 0 || k === 1 || k === 7;
        let out = GG.BARREL_OUT;
        if (!isFront) out *= 1 - 0.7 * crush;
        const sag = isFront ? crush : crush * 0.3;
        const spill = isFront && k !== 7 && crush > 0.55;
        if (spill) continue; // detached — drawn as grounded spills below
        if (!near && shear < 0.6) continue; // hidden behind the intact shell
        const b0 = P(rel, 23, GG.HUB_H - sag * 1.5);
        const b1 = P(rel, GG.RING_R + out, GG.HUB_H - sag * 4.5);
        g.lineStyle(3.4, shade(pal.barrel, near ? 1 : 0.85), 1);
        g.lineBetween(b0[0], b0[1], b1[0], b1[1]);
        g.lineStyle(1.4, 0x252220, 1);
        g.lineBetween(b1[0], b1[1], b1[0] - (b1[0] - b0[0]) * 0.08, b1[1] - (b1[1] - b0[1]) * 0.08);
    }

    // ---- skirt shell with one blown-open facet ----
    const order = Array.from({ length: 8 }, (_, k) => k).sort((a, b) => {
        const da = Math.sin(a * BAY) * view.ca + Math.cos(a * BAY) * view.sa;
        const db = Math.sin(b * BAY) * view.ca + Math.cos(b * BAY) * view.sa;
        return da - db;
    });
    for (const k of order) {
        const mid = k * BAY;
        const a0 = mid - BAY / 2, a1 = mid + BAY / 2;
        const blown = k === 2 && rupture > 0.4;
        const gapW = blown ? 0.16 * shear + 0.06 : 0;
        const light = view.light([Math.cos(mid), Math.sin(mid), 0.35]);
        if (blown && gapW > 0.02) {
            polygon(g, [
                P(a0, GG.RIM_R, GG.RIM_H), P(a1, GG.RIM_R, GG.RIM_H),
                P(a1, GG.WAIST_R, GG.WAIST_H), P(a0, GG.WAIST_R, GG.WAIST_H)
            ], 0x17130f, 0.96);
            if (emberA > 0.02) {
                polygon(g, [
                    P(mid - 0.1, GG.RIM_R - 3, GG.RIM_H + 1.5), P(mid + 0.12, GG.RIM_R - 3.4, GG.RIM_H + 1.2),
                    P(mid + 0.05, GG.WAIST_R + 1, GG.WAIST_H - 2.5), P(mid - 0.07, GG.WAIST_R + 1.4, GG.WAIST_H - 2.2)
                ], 0xd96a2a, emberA);
            } else if (p >= 0.9) {
                // dead-warm coal pocket in the split — static, never bright
                const c = P(mid, GG.RING_R - 2, GG.HUB_H - 1);
                g.fillStyle(0x6a2f1d, 0.9);
                g.fillEllipse(c[0], c[1], 3.4, 1.9);
            }
            polygon(g, [
                P(a1 - gapW, GG.RIM_R + 2.5, GG.RIM_H - 0.6), P(a1 + 0.34, GG.RIM_R + 3.5, GG.RIM_H - 1),
                P(a1 + 0.3, GG.WAIST_R + 3, GG.WAIST_H - 4), P(a1 - gapW, GG.WAIST_R + 1, GG.WAIST_H - 3)
            ], shade(pal.wood, light * 0.9));
            continue;
        }
        polygon(g, [
            P(a0, GG.RIM_R, GG.RIM_H), P(mid, GG.RIM_R + 0.7, GG.RIM_H - 0.2), P(a1, GG.RIM_R, GG.RIM_H),
            P(a1, GG.WAIST_R, GG.WAIST_H), P(mid, GG.WAIST_R + 0.5, GG.WAIST_H - 0.1), P(a0, GG.WAIST_R, GG.WAIST_H)
        ], shade(pal.wood, light * (1 - 0.14 * crush)));
        g.lineStyle(0.9, pal.line, 0.8);
        const s0 = P(a0, GG.RIM_R, GG.RIM_H), s1 = P(a0, GG.WAIST_R, GG.WAIST_H);
        g.lineBetween(s0[0], s0[1], s1[0], s1[1]);
    }
    // waist scar where the roof tore away
    if (shear > 0.05) {
        g.lineStyle(1.6, 0x1c1712, 0.9);
        const w0 = P(Math.PI * 0.85, GG.WAIST_R, GG.WAIST_H), w1 = P(Math.PI * 0.15, GG.WAIST_R, GG.WAIST_H);
        g.lineBetween(w0[0], w0[1], w1[0], w1[1]);
    } else {
        // roof still seated: draw it (pre-shear) so the machine reads whole
        for (const k of order) {
            const mid = k * BAY;
            const a0 = mid - BAY / 2, a1 = mid + BAY / 2;
            const light = view.light([Math.cos(mid), Math.sin(mid), 0.7]);
            polygon(g, [
                P(a0, GG.WAIST_R, GG.WAIST_H), P(a1, GG.WAIST_R, GG.WAIST_H),
                P(a1, GG.CROWN_R, GG.CROWN_H), P(a0, GG.CROWN_R, GG.CROWN_H)
            ], shade(pal.wood, light));
        }
    }

    // ---- splayed rollers at the crushed rim ----
    if (crush > 0.2) {
        for (const rel of [0.55, -0.5, 2.4]) {
            const c = P(rel, GG.RIM_R - 1, 1.2);
            g.fillStyle(pal.ironDk, 1);
            g.fillEllipse(c[0], c[1], 7, 5.2);
            g.fillStyle(shade(pal.iron, 0.9), 1);
            g.fillEllipse(c[0], c[1], 5, 3.6);
        }
    }

    // ---- spilled bombards on the ground (front pair, after detach) ----
    if (crush > 0.55) {
        const lay = (rel: number, ang: number, len: number): void => {
            const c = dp(rel, GG.RING_R + 7, 0.8);
            const dx = Math.cos(ang) * len, dy = Math.sin(ang) * len * 0.5;
            g.lineStyle(3.2, pal.barrel, 1);
            g.lineBetween(c[0] - dx, c[1] - dy, c[0] + dx, c[1] + dy);
            g.fillStyle(0x26262b, 1);
            g.fillEllipse(c[0] + dx, c[1] + dy, 2.6, 1.9);
        };
        lay(0.18, 0.5, 6.5);
        lay(BAY + 0.1, -0.35, 6);
    }

    // ---- port flashes + flying lids during the rupture ----
    if (rupture > 0.02 && p < 0.34) {
        const flashA = Math.max(0, 1 - Math.abs(p - 0.2) / 0.12);
        for (const rel of [0, BAY, -BAY]) {
            const c = P(rel, GG.RING_R + 3, GG.HUB_H);
            g.fillStyle(0xfff3c8, flashA * 0.95);
            g.fillEllipse(c[0], c[1], 7 + 9 * rupture, 4 + 5 * rupture);
            g.fillStyle(0xffb347, flashA * 0.8);
            g.fillEllipse(c[0], c[1], 12 + 12 * rupture, 6.5 + 6 * rupture);
        }
    }
    if (rupture > 0.05) {
        const fly = Math.min(1, (p - 0.16) / 0.32);
        for (const s of [-1, 1] as const) {
            const rel = s * BAY;
            const c = dp(rel, GG.RING_R + 4 + fly * 14, GG.HUB_H + 10 * Math.sin(Math.PI * Math.min(1, fly)) + (fly >= 1 ? -GG.HUB_H + 0.8 : 0));
            const spin = fly * 5 * s;
            const lx = Math.cos(spin) * 2.2, ly = Math.sin(spin) * 1.4;
            polygon(g, [
                [c[0] - lx, c[1] - ly], [c[0] + ly, c[1] - lx * 0.5],
                [c[0] + lx, c[1] + ly], [c[0] - ly, c[1] + lx * 0.5]
            ], pal.woodDk, 0.95);
        }
    }

    // ---- the launched cupola pod (drum + cap + finial), tumbling ----
    const q = smooth((p - 0.16) / 0.5);
    if (p > 0.16) {
        const cd = -3 - 11 * q, cw = 4 + 6 * q;
        const ch = q >= 1 ? 2.2 : GG.CROWN_H + 26 * Math.sin(Math.PI * q) * (1 - 0.35 * q) + (GG.CROWN_H - 2) * (1 - q) * 0 - (GG.CROWN_H - 2.2) * q;
        const c = view.point([cd, cw, Math.max(2.2, ch)]);
        const th = q >= 1 ? 1.15 : q * 2.6;
        const ux = Math.cos(th), uy = Math.sin(th);
        const drumW = 4.6, drumH = 6.5;
        polygon(g, [
            [c[0] - ux * drumW + uy * drumH * 0.5, c[1] - uy * drumW * 0.6 - ux * drumH * 0.5],
            [c[0] + ux * drumW + uy * drumH * 0.5, c[1] + uy * drumW * 0.6 - ux * drumH * 0.5],
            [c[0] + ux * drumW - uy * drumH * 0.5, c[1] + uy * drumW * 0.6 + ux * drumH * 0.5],
            [c[0] - ux * drumW - uy * drumH * 0.5, c[1] - uy * drumW * 0.6 + ux * drumH * 0.5]
        ], pal.wood, 1);
        const capC: V2 = [c[0] + uy * drumH * 0.72, c[1] - ux * drumH * 0.72];
        polygon(g, [
            [capC[0] - ux * 5.4, capC[1] - uy * 3],
            [capC[0] + ux * 5.4, capC[1] + uy * 3],
            [capC[0] + uy * 4.6, capC[1] - ux * 4.6]
        ], shade(pal.wood, 0.92));
        g.fillStyle(pal.gold !== null ? pal.gold : pal.iron, 1);
        g.fillCircle(capC[0] + uy * 5.4, capC[1] - ux * 5.4, 1.3);
        g.fillStyle(0x1f1c18, 0.9);
        g.fillRect(c[0] - 1.8, c[1] - 1.2, 1.3, 2.6);
    }

    // ---- collapse dust ring ----
    if (p > 0.5 && p < 0.97) {
        for (let i = 0; i < 5; i++) {
            const t0 = 0.52 + i * 0.055;
            const a = Math.max(0, 1 - Math.abs((p - t0) / 0.16)) * 0.4;
            if (a <= 0.01) continue;
            const rel = i * 1.26 + 0.4;
            const c = dp(rel, GG.RIM_R + 4 + 7 * smooth((p - t0) / 0.2), 1.5 + 2.5 * smooth((p - t0) / 0.25));
            const s = 6 + 7 * smooth((p - t0) / 0.2);
            g.fillStyle(0xcdbfa5, a);
            g.fillEllipse(c[0], c[1], s * 1.6, s);
        }
    }
}

export type MachineTerminalPose = 'rolling' | 'parked';

interface GatecrasherPalette {
    body: number;
    dark: number;
    line: number;
    deckTop: number;
    tread: number;
    cabin: number;
    roof: number;
    wheelFace: number;
    wheelRim: number;
    spoke: number;
    metal: number;
    cloth: number;
    clothDark: number;
    sand: number | null;
    gold: number | null;
    goldHigh: number | null;
}

function gatecrasherPalette(level: number, isPlayer: boolean): GatecrasherPalette {
    const lv = Math.max(1, Math.min(3, Math.round(level || 1)));
    let body = [0x9a7b4f, 0x876741, 0x6f5136][lv - 1];
    let roof = [0x7d5f3c, 0x64492e, 0x53402b][lv - 1];
    let cabin = [0x8a6d45, 0x775a38, 0x604631][lv - 1];
    const metal = lv === 1 ? 0x6b5233 : [0, 0x474c55, 0x3f444d][lv - 1];
    if (!isPlayer) {
        body = shade(body, 0.87);
        roof = shade(roof, 0.87);
        cabin = shade(cabin, 0.87);
    }
    return {
        body,
        dark: shade(body, 0.72),
        line: shade(body, 0.55),
        deckTop: shade(body, 1.16),
        tread: shade(body, 1.05),
        cabin,
        roof,
        wheelFace: shade(body, 0.8),
        wheelRim: lv === 1 ? shade(body, 0.6) : metal,
        spoke: shade(body, 0.92),
        metal,
        cloth: isPlayer ? 0x3e6db5 : 0xb0413a,
        clothDark: isPlayer ? 0x2a4f86 : 0x7e2e29,
        sand: lv === 3 ? 0xbfb49a : null,
        gold: lv === 3 ? 0xdaa520 : null,
        goldHigh: lv === 3 ? 0xffd700 : null,
    };
}

function gatePanelPose(
    attached: readonly V3[],
    target: readonly V3[],
    amount: number,
    hopHeight: number,
): V3[] {
    const k = smooth(amount);
    const hop = Math.sin(k * Math.PI) * hopHeight;
    return attached.map((point, index) => {
        const moved = lerp3(point, target[index], k);
        return [moved[0], moved[1], moved[2] + hop];
    });
}

function drawGateBoard(g: G, view: View, points: readonly V3[], color: number, lineColor: number): void {
    const screen = points.map(point => view.point(point));
    polygon(g, screen, color);
    g.lineStyle(1.1, lineColor, 0.82);
    g.beginPath();
    g.moveTo(screen[0][0], screen[0][1]);
    for (let index = 1; index < screen.length; index++) g.lineTo(screen[index][0], screen[index][1]);
    g.closePath();
    g.strokePath();
}

interface GateFace {
    d: -1 | 0 | 1;
    w: -1 | 0 | 1;
}

const GATE_FACES: readonly GateFace[] = [
    { d: 1, w: 0 }, { d: -1, w: 0 }, { d: 0, w: 1 }, { d: 0, w: -1 },
];

function gateHullPoint(face: GateFace, across: number, height: number): V3 {
    return face.d !== 0
        ? [face.d * 11, across * 9, height]
        : [across * 11, face.w * 9, height];
}

function drawGateHull(
    g: G,
    view: View,
    body: Transform,
    palette: GatecrasherPalette,
    level: number,
): void {
    drawBox(g, view, body, -11, 11, -9, 9, 10, 34, palette.body, palette.deckTop);
    for (const face of GATE_FACES) {
        const normal = body.vector([face.d, face.w, 0]);
        if (view.dot(normal) <= 0.01) continue;
        const at = (u: number, h: number): V3 => body.point(gateHullPoint(face, u, h));
        segment(g, view, at(-0.96, 22), at(0.96, 22), 1, palette.line, 0.48);
        segment(g, view, at(-0.33, 10.8), at(-0.33, 33.2), 1, palette.line, 0.34);
        segment(g, view, at(0.33, 10.8), at(0.33, 33.2), 1, palette.line, 0.34);
        if (level === 1) {
            segment(g, view, at(-0.84, 13), at(0.84, 31), 1.2, 0x5c462d, 0.62);
            segment(g, view, at(-0.84, 31), at(0.84, 13), 1.2, 0x5c462d, 0.62);
        }
        if (palette.sand) {
            polygon(g, [at(-0.95, 30.5), at(0.95, 30.5), at(0.95, 32.5), at(-0.95, 32.5)].map(point => view.point(point)), shade(palette.sand, view.light(normal)));
        }
        if (level === 3 && face.d === 0) {
            for (const d of [-4.5, 4.5]) {
                const point = view.point(body.point([face.w > 0 ? d : -d, face.w * 9.05, 25]));
                g.fillStyle(palette.clothDark, 1);
                g.fillCircle(point[0], point[1], 3);
                g.fillStyle(palette.cloth, 1);
                g.fillCircle(point[0] - 0.4, point[1] - 0.4, 2.2);
                g.fillStyle(palette.gold ?? 0xdaa520, 1);
                g.fillCircle(point[0], point[1], 0.9);
            }
        }
    }
    for (const d of [-1, 1] as const) for (const w of [-1, 1] as const) {
        const cd = d * 11, cw = w * 9;
        drawBox(
            g, view, body,
            cd - 0.9, cd + 0.9, cw - 0.9, cw + 0.9, 10, 34.6,
            level === 1 ? palette.line : palette.metal,
            palette.goldHigh ?? (level === 1 ? palette.line : shade(palette.metal, 1.15)),
        );
    }
}

function drawGateCabin(g: G, view: View, cabin: Transform, palette: GatecrasherPalette): void {
    drawBox(g, view, cabin, -9, 9, -6.5, 6.5, 36, 47, palette.cabin);
    for (const d of [-1, 1] as const) {
        const normal = cabin.vector([d, 0, 0]);
        if (view.dot(normal) <= 0.01) continue;
        const faceD = d * 9.02;
        const door: V3[] = [
            [faceD, -2.6, 36.4], [faceD, 2.6, 36.4], [faceD, 2.6, 43],
            [faceD, 0, 45], [faceD, -2.6, 43],
        ];
        polygon(g, door.map(point => view.point(cabin.point(point))), 0x1c130c);
        segment(g, view, cabin.point([faceD, -3.1, 44.2]), cabin.point([faceD, 0, 46.2]), 1.2, palette.line, 0.8);
        segment(g, view, cabin.point([faceD, 3.1, 44.2]), cabin.point([faceD, 0, 46.2]), 1.2, palette.line, 0.8);
    }
    for (const w of [-1, 1] as const) {
        const normal = cabin.vector([0, w, 0]);
        if (view.dot(normal) <= 0.01) continue;
        for (const d of [-3, 3]) {
            const slit: V3[] = [
                [d - 0.6, w * 6.52, 39], [d + 0.6, w * 6.52, 39],
                [d + 0.6, w * 6.52, 43.2], [d - 0.6, w * 6.52, 43.2],
            ];
            polygon(g, slit.map(point => view.point(cabin.point(point))), 0x1c130c);
        }
    }
}

function drawGateRoof(g: G, view: View, roof: Transform, palette: GatecrasherPalette): void {
    const eave: readonly V3[] = [
        [-11, -8.5, 46.5], [11, -8.5, 46.5], [11, 8.5, 46.5], [-11, 8.5, 46.5],
    ];
    const apex: V3 = [0, 0, 55];
    const reference: V3 = [0, 0, 44];
    const faces: { points: V2[]; color: number; y: number }[] = [];
    for (let index = 0; index < 4; index++) {
        const a = eave[index], b = eave[(index + 1) % 4];
        const ab: V3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
        const ac: V3 = [apex[0] - a[0], apex[1] - a[1], apex[2] - a[2]];
        let normal: V3 = [
            ab[1] * ac[2] - ab[2] * ac[1],
            ab[2] * ac[0] - ab[0] * ac[2],
            ab[0] * ac[1] - ab[1] * ac[0],
        ];
        const center: V3 = [(a[0] + b[0] + apex[0]) / 3, (a[1] + b[1] + apex[1]) / 3, (a[2] + b[2] + apex[2]) / 3];
        if (normal[0] * (center[0] - reference[0]) + normal[1] * (center[1] - reference[1]) + normal[2] * (center[2] - reference[2]) < 0) {
            normal = [-normal[0], -normal[1], -normal[2]];
        }
        const transformedNormal = roof.vector(normal);
        if (view.dot(transformedNormal) <= 0.01) continue;
        const points = [a, b, apex].map(point => view.point(roof.point(point)));
        faces.push({
            points,
            color: shade(palette.roof, view.light(transformedNormal)),
            y: points.reduce((sum, point) => sum + point[1], 0) / points.length,
        });
    }
    faces.sort((a, b) => a.y - b.y);
    for (const face of faces) polygon(g, face.points, face.color);
}

function drawGatePennant(
    g: G,
    view: View,
    roof: Transform,
    palette: GatecrasherPalette,
    phase: number,
): void {
    const fall = smooth((phase - 0.15) / 0.58);
    const hop = Math.sin(fall * Math.PI) * 5;
    const attachedBase = roof.point([0, 0, 55]);
    const attachedTop = roof.point([0, 0, 61]);
    const targetBase: V3 = [18, -14, 0.9];
    const targetTop: V3 = [31, -17, 0.9];
    const base = lerp3(attachedBase, targetBase, fall);
    const topMixed = lerp3(attachedTop, targetTop, fall);
    const top: V3 = [topMixed[0], topMixed[1], topMixed[2] + hop];
    segment(g, view, base, top, 1.2, palette.line);
    const tip = view.point(top);
    if (palette.gold) {
        g.fillStyle(palette.gold, 1);
        g.fillCircle(tip[0], tip[1] - 0.5, 1.35);
    }
    let fx = -view.ca;
    let fy = -view.sa * 0.5;
    const length = Math.hypot(fx, fy) || 1;
    fx /= length;
    fy /= length;
    const qx = -fy, qy = fx;
    const clothLength = lerp(11, 7.5, fall);
    const sag = fall * 3.5;
    const tailX = tip[0] + fx * clothLength;
    const tailY = tip[1] + fy * clothLength + sag;
    polygon(g, [
        [tip[0], tip[1]], [tailX - qx, tailY - qy],
        [tailX + qx * 1.3, tailY + qy * 1.3], [tip[0] + qx * 3.2, tip[1] + qy * 3.2],
    ], palette.cloth);
    polygon(g, [
        [tip[0], tip[1] + 1], [tailX - qx, tailY - qy], [tip[0] + qx * 1.8, tip[1] + qy * 1.8],
    ], palette.clothDark, 0.92);
}

function drawGateMantlet(
    g: G,
    view: View,
    palette: GatecrasherPalette,
    level: number,
    phase: number,
    terminalPose: MachineTerminalPose,
): void {
    const angle = (terminalPose === 'parked' ? -24 : 88) * Math.PI / 180;
    const hingeD = 11.5, hingeH = 36, width = 7, length = 16;
    const point = (distance: number, w: number): V3 => [
        hingeD + Math.cos(angle) * distance,
        w,
        hingeH + Math.sin(angle) * distance,
    ];
    const attached: readonly V3[] = [point(0, -width), point(0, width), point(length, width), point(length, -width)];
    const target: readonly V3[] = [[13, -7, 0.9], [13, 7, 0.9], [38, 7.8, 0.9], [39, -6.2, 0.9]];
    const start = terminalPose === 'parked' ? 0.08 : 0.13;
    const fall = smooth((phase - start) / (0.7 - start));
    const board = gatePanelPose(attached, target, fall, terminalPose === 'parked' ? 4 : 8);
    drawGateBoard(g, view, board, palette.body, palette.line);
    for (const amount of [0.3, 0.55, 0.8]) {
        segment(g, view, lerp3(board[0], board[3], amount), lerp3(board[1], board[2], amount), 1.25, palette.line, 0.84);
    }
    for (const w of [-4.6, 0, 4.6]) {
        const toothAttached: readonly V3[] = [point(16, w - 1.3), point(16, w + 1.3), point(19, w + 1.3), point(19, w - 1.3)];
        const toothTarget: readonly V3[] = [[38, w - 1.3, 0.9], [38, w + 1.3, 0.9], [43, w + 1.3, 0.9], [43, w - 1.3, 0.9]];
        const tooth = gatePanelPose(toothAttached, toothTarget, fall, terminalPose === 'parked' ? 4 : 8);
        polygon(g, tooth.map(value => view.point(value)), palette.gold ?? palette.body);
    }
    if (level >= 2) {
        for (const side of [-1, 1] as const) {
            const corner = side < 0 ? board[3] : board[2];
            const screen = view.point(corner);
            g.fillStyle(shade(palette.metal, 0.85), 1);
            g.fillTriangle(screen[0] - 1.6, screen[1], screen[0] + 1.6, screen[1], screen[0], screen[1] + 3.4);
        }
    }
    const chainBreak = smooth((phase - 0.12) / 0.34);
    if (chainBreak < 0.98) {
        for (const side of [-1, 1] as const) {
            const post: V3 = [11, side * 8.5, 34];
            const corner = side < 0 ? board[0] : board[1];
            const middle: V3 = [(post[0] + corner[0]) * 0.5, (post[1] + corner[1]) * 0.5, (post[2] + corner[2]) * 0.5 - 2];
            segment(g, view, post, middle, 1.1, 0x565f6a, 1 - chainBreak * 0.5);
            segment(g, view, middle, corner, 1.1, 0x565f6a, 1 - chainBreak * 0.5);
        }
    } else {
        segment(g, view, [27, -9, 1], [34, -11, 1], 1.1, 0x565f6a);
        segment(g, view, [27, 9, 1], [34, 12, 1], 1.1, 0x565f6a);
    }
}

function drawGateStairPiece(
    g: G,
    view: View,
    attached: readonly V3[],
    target: readonly V3[],
    amount: number,
    palette: GatecrasherPalette,
    hop: number,
): V3[] {
    const board = gatePanelPose(attached, target, amount, hop);
    drawGateBoard(g, view, board, palette.tread, palette.line);
    segment(g, view, board[0], board[3], palette.gold ? 1.35 : 1.7, palette.gold ?? palette.line);
    segment(g, view, board[1], board[2], palette.gold ? 1.35 : 1.7, palette.gold ?? palette.line);
    for (const fraction of [0.12, 0.37, 0.62, 0.87]) {
        segment(g, view, lerp3(board[0], board[3], fraction), lerp3(board[1], board[2], fraction), 1.25, palette.line, 0.78);
    }
    return board;
}

function drawGateRearStair(
    g: G,
    view: View,
    palette: GatecrasherPalette,
    phase: number,
    terminalPose: MachineTerminalPose,
): void {
    const upperAngle = (terminalPose === 'parked' ? 52 : 90) * Math.PI / 180;
    const lowerAngle = (terminalPose === 'parked' ? 54 : -90) * Math.PI / 180;
    const hinge: V3 = [-11.5, 0, 34];
    const upperEnd: V3 = [hinge[0] - Math.cos(upperAngle) * 20, 0, hinge[2] - Math.sin(upperAngle) * 20];
    const lowerStart: V3 = terminalPose === 'parked' ? upperEnd : [upperEnd[0] - 1.8, 0, upperEnd[2]];
    const lowerEnd: V3 = [lowerStart[0] - Math.cos(lowerAngle) * 20, 0, lowerStart[2] - Math.sin(lowerAngle) * 20];
    const quad = (a: V3, b: V3): readonly V3[] => [[a[0], -6.5, a[2]], [a[0], 6.5, a[2]], [b[0], 6.5, b[2]], [b[0], -6.5, b[2]]];
    const upperTarget: readonly V3[] = [[-12, -6.5, 0.9], [-12, 6.5, 0.9], [-31, 8, 0.9], [-31, -5, 0.9]];
    const lowerTarget: readonly V3[] = [[-32, -5.2, 0.9], [-31, 8, 0.9], [-50, 5, 0.9], [-52, -8, 0.9]];
    const start = terminalPose === 'parked' ? 0.09 : 0.14;
    const upperFall = smooth((phase - start) / (0.72 - start));
    const lowerFall = smooth((phase - start - 0.035) / (0.78 - start));
    drawGateStairPiece(g, view, quad(hinge, upperEnd), upperTarget, upperFall, palette, terminalPose === 'parked' ? 3 : 7);
    drawGateStairPiece(g, view, quad(lowerStart, lowerEnd), lowerTarget, lowerFall, palette, terminalPose === 'parked' ? 4 : 9);
}

function drawGateDebris(g: G, view: View, palette: GatecrasherPalette, phase: number): void {
    const settle = smooth((phase - 0.38) / 0.46);
    if (settle <= 0) return;
    const pieces: readonly [V3, V3, number, number][] = [
        [[-28, -14, 0.9], [-12, -8, 1], 2.2, palette.dark],
        [[8, 17, 0.9], [29, 13, 1], 2.2, palette.line],
        [[-7, -20, 0.8], [4, -29, 0.9], 1.8, palette.body],
        [[23, -8, 0.8], [35, -15, 0.9], 1.7, palette.dark],
        [[-13, -4, 1], [14, 8, 1], 2, palette.metal],
    ];
    for (const [a, b, width, color] of pieces) segment(g, view, a, b, width, color, settle);
    if (palette.sand) segment(g, view, [-24, 15, 1], [-8, 18, 1], 1.8, palette.sand, settle);
    if (palette.gold) segment(g, view, [38, -6, 1.1], [43, -5, 1.1], 1.1, palette.gold, settle);
}

function drawSiegeTowerDeath(
    g: G,
    view: View,
    isPlayer: boolean,
    level: number,
    phase: number,
    terminalPose: MachineTerminalPose,
): void {
    const palette = gatecrasherPalette(level, isPlayer);
    const collapse = smooth((phase - 0.14) / 0.72);
    const body = transformAround(
        9,
        -0.08 * collapse,
        0.95 * collapse,
        7 * collapse,
        -4 * collapse,
        4 * collapse,
        1 - 0.72 * collapse,
    );
    const cabinFall = smooth((phase - 0.17) / 0.58);
    const cabin = transformAround(35, 0.15 * cabinFall, -1.26 * cabinFall, 31 * cabinFall, 18 * cabinFall, -11 * cabinFall, 1 - 0.45 * cabinFall);
    const roofFall = smooth((phase - 0.2) / 0.55);
    const roof = transformAround(46.5, -0.12 * roofFall, 1.38 * roofFall, 43 * roofFall, 25 * roofFall, 11 * roofFall);

    const groundY = view.point([0, 0, 0])[1];
    g.fillStyle(0x101a0a, 0.25);
    g.fillEllipse(view.ca * 1.2, groundY + 1.5, lerp(46, 78, collapse), lerp(17, 23, collapse));

    const stairFar = view.sa >= 0;
    if (stairFar) drawGateRearStair(g, view, palette, phase, terminalPose);
    else drawGateMantlet(g, view, palette, level, phase, terminalPose);

    const wheels = [
        { center: [-8.5, -10.5, 6] as V3, target: [-20, -23, 0.8] as V3, start: 0.14 },
        { center: [8.5, -10.5, 6] as V3, target: [20, -22, 0.8] as V3, start: 0.2 },
        { center: [-8.5, 10.5, 6] as V3, target: [-22, 23, 0.8] as V3, start: 0.12 },
        { center: [8.5, 10.5, 6] as V3, target: [23, 21, 0.8] as V3, start: 0.18 },
    ];
    const centerScreenY = view.point([0, 0, 6])[1];
    const drawWheels = (near: boolean) => {
        wheels.forEach((wheel, index) => {
            const isNear = view.point(wheel.center)[1] >= centerScreenY;
            if (isNear !== near) return;
            drawSheddingWheel(
                g, view, body, wheel.center, 6, wheel.target,
                (phase - wheel.start) / (0.78 - wheel.start),
                palette.wheelRim, palette.wheelFace, palette.spoke,
                phase * 3.1 + index * 0.45,
            );
        });
    };

    drawWheels(false);
    drawBox(g, view, body, -13, 13, -9.5, 9.5, 7, 10, palette.dark, shade(palette.dark, 1.1));
    for (const d of [-8.5, 8.5]) {
        drawBox(g, view, body, d - 1, d + 1, -10.5, 10.5, 5, 7, 0x3a3026);
    }
    drawGateHull(g, view, body, palette, level);
    drawBox(g, view, body, -11.5, 11.5, -8.5, 8.5, 34, 36, palette.dark, palette.deckTop);
    drawGateCabin(g, view, cabin, palette);
    drawGateRoof(g, view, roof, palette);
    drawGatePennant(g, view, roof, palette, phase);
    drawWheels(true);

    if (stairFar) drawGateMantlet(g, view, palette, level, phase, terminalPose);
    else drawGateRearStair(g, view, palette, phase, terminalPose);
    drawGateDebris(g, view, palette, phase);
}

/**
 * Draws one deterministic baked-death pose. Phase zero is the intact,
 * just-killed silhouette; phase one is the low persistent wreck frame.
 */
export function drawMachineDeath(
    g: G,
    type: MachineDeathType,
    isPlayer: boolean,
    troopLevel: number,
    facingAngle: number,
    phase: number,
    terminalPose: MachineTerminalPose = 'rolling',
): void {
    const level = Math.max(1, Math.min(3, Math.round(Number.isFinite(troopLevel) ? troopLevel : 1)));
    const p = clamp01(phase);
    const facing = Number.isFinite(facingAngle) ? facingAngle : 0;
    if (type === 'davincitank') {
        // First two bake samples stay on the literal live renderer (static
        // pose at the bake clock) so the death never pops into an
        // approximation before the destructive motion begins.
        if (p <= 0.13) {
            drawDaVinciTank(g, isPlayer, false, false, facing, level, 1000, 0);
            return;
        }
        drawDaVinciTankDeath(g, makeView(facing), isPlayer, level, p);
        return;
    }
    // The first two bake samples remain the literal selected body renderer,
    // so neither the rolling nor the deployed terminal pose pops into an
    // approximation before the destructive motion has begun.
    if (p <= 0.13) {
        drawSiegetowerC(g, isPlayer, false, facing, level, 0, 0, 0, terminalPose === 'parked' ? 1 : 0);
        return;
    }
    drawSiegeTowerDeath(g, makeView(facing, 8), isPlayer, level, p, terminalPose);
}
