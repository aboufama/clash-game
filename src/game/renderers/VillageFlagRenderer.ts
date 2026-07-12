import Phaser from 'phaser';
import { hashString, mulberry32 } from '../config/Economy';

/**
 * The village flag — every village's heraldry, generated once from its
 * identity and identical on every client that ever draws it (the "asset" is
 * the design, not a bitmap). Carried huge by a small flag bearer when the
 * army marches, planted at the enemy gate for the whole battle.
 */

export interface FlagDesign {
    /** Main field colour. */
    field: number;
    /** Second field colour (patterns) / border colour (solid). */
    field2: number;
    /** Charge (emblem) colour — always a metal, for contrast. */
    metal: number;
    /** 0 solid+border · 1 per-fess · 2 per-pale · 3 per-bend · 4 chevron */
    pattern: number;
    /** 0 tower · 1 blade · 2 oak leaf · 3 star · 4 crescent · 5 hammer */
    emblem: number;
    /** Swallowtail fly edge (roughly half of all banners). */
    swallowtail: boolean;
    /** Per-village wave phase so two flags never ripple in lockstep. */
    phase: number;
}

// Deep dyed-cloth fields and two metals — heraldry, not neon.
const FIELDS = [0x8a3d2f, 0x2f4a7a, 0x3d6b35, 0x6b3d7a, 0x9a6b2f, 0x2f6b6b, 0x4a4258, 0xa64a38];
const METALS = [0xe8d9a0, 0xd9b348];

export function villageFlagFor(key: string): FlagDesign {
    const rng = mulberry32(hashString(`${key}:flag`));
    const fieldIx = Math.floor(rng() * FIELDS.length);
    let field2Ix = Math.floor(rng() * FIELDS.length);
    if (field2Ix === fieldIx) field2Ix = (field2Ix + 3) % FIELDS.length;
    return {
        field: FIELDS[fieldIx],
        field2: FIELDS[field2Ix],
        metal: METALS[Math.floor(rng() * METALS.length)],
        pattern: Math.floor(rng() * 5),
        emblem: Math.floor(rng() * 6),
        swallowtail: rng() < 0.5,
        phase: rng() * Math.PI * 2
    };
}

/** Which field colour a point (u toward fly, v downward, both 0..1) wears. */
function fieldAt(design: FlagDesign, u: number, v: number): number {
    switch (design.pattern) {
        case 1: return v < 0.5 ? design.field : design.field2;            // per-fess
        case 2: return u < 0.5 ? design.field : design.field2;            // per-pale
        case 3: return u + v < 1 ? design.field : design.field2;          // per-bend
        case 4: return v > 0.32 + Math.abs(u - 0.5) * 0.7 ? design.field2 : design.field; // chevron
        default: return design.field;                                     // solid (border drawn after)
    }
}

/** The charge, drawn small in the metal colour at cloth centre. */
function drawEmblem(g: Phaser.GameObjects.Graphics, design: FlagDesign, x: number, y: number, s: number) {
    g.fillStyle(design.metal, 1);
    switch (design.emblem) {
        case 0: // tower
            g.fillRect(x - s * 0.42, y - s * 0.5, s * 0.84, s);
            g.fillRect(x - s * 0.58, y - s * 0.66, s * 0.34, s * 0.3);
            g.fillRect(x + s * 0.24, y - s * 0.66, s * 0.34, s * 0.3);
            break;
        case 1: // blade, point up
            g.fillTriangle(x, y - s * 0.72, x - s * 0.2, y + s * 0.28, x + s * 0.2, y + s * 0.28);
            g.fillRect(x - s * 0.42, y + s * 0.28, s * 0.84, s * 0.16);
            break;
        case 2: // oak leaf
            g.fillEllipse(x, y - s * 0.14, s * 0.7, s * 0.9);
            g.fillTriangle(x - s * 0.1, y + s * 0.3, x + s * 0.1, y + s * 0.3, x, y + s * 0.62);
            break;
        case 3: { // star
            for (let i = 0; i < 5; i++) {
                const a = -Math.PI / 2 + (i * Math.PI * 2) / 5;
                g.fillTriangle(
                    x + Math.cos(a) * s * 0.66, y + Math.sin(a) * s * 0.66,
                    x + Math.cos(a + 2.2) * s * 0.26, y + Math.sin(a + 2.2) * s * 0.26,
                    x + Math.cos(a - 2.2) * s * 0.26, y + Math.sin(a - 2.2) * s * 0.26
                );
            }
            break;
        }
        case 4: // crescent
            g.fillCircle(x, y, s * 0.52);
            g.fillStyle(fieldAt(design, 0.5, 0.5), 1);
            g.fillCircle(x + s * 0.24, y - s * 0.1, s * 0.42);
            break;
        default: // hammer
            g.fillRect(x - s * 0.09, y - s * 0.3, s * 0.18, s * 0.92);
            g.fillRect(x - s * 0.5, y - s * 0.62, s, s * 0.4);
            break;
    }
}

/**
 * The waving banner on its pole. `(x, groundY)` is the pole foot; the cloth
 * flies toward `facing` (+1 right / -1 left). Big cloth, small pole shadow —
 * the whole point is a HUGE flag over a small bearer. All motion is a pure
 * function of `time`.
 */
export function drawVillageFlag(
    g: Phaser.GameObjects.Graphics,
    x: number,
    groundY: number,
    time: number,
    design: FlagDesign,
    facing: number,
    opts: {
        poleH?: number;
        clothW?: number;
        clothH?: number;
        marching?: boolean;
        /** Travel physics: the cloth STREAMS from the pole. `dir` is the
         *  continuous screen-x fly direction (-1..1 — near 0 the cloth turns
         *  edge-on mid-turn), `speed` scales the ripple, `climb` is the
         *  screen-y motion component: climbing up-screen drags the fly edge
         *  down, descending lifts it. */
        stream?: { dir: number; speed: number; climb: number };
    } = {}
) {
    const poleH = opts.poleH ?? 54;
    const clothW = opts.clothW ?? 34;
    const clothH = opts.clothH ?? 19;
    const stream = opts.stream;
    // Which way the cloth flies: physics (opposite the travel) when moving,
    // the bearer's facing otherwise.
    const flyDir = stream ? Math.max(-1, Math.min(1, stream.dir)) : facing;
    const wave = stream ? 0.7 + Math.min(1, stream.speed) * 0.9 : opts.marching ? 1 : 0.62;
    // Air drag tilts the streaming cloth against the climb.
    const slant = stream ? -stream.climb * 4.6 * Math.min(1, Math.abs(flyDir) + 0.25) : 0;
    const topY = groundY - poleH;

    // Pole (dark ash, gold finial).
    g.lineStyle(2.2, 0x4a3a26, 1);
    g.lineBetween(x, groundY, x, topY - 2);
    g.lineStyle(1, 0x6e5136, 1);
    g.lineBetween(x - 0.7, groundY, x - 0.7, topY - 1);
    g.fillStyle(0xd9b348, 1);
    g.fillCircle(x, topY - 3.2, 2.2);

    // Cloth in vertical slices; ripple grows toward the fly edge.
    const SLICES = 6;
    const t = time * 0.0072 + design.phase;
    const lift = (i: number) =>
        Math.sin(t + i * 0.92) * 3.4 * (i / SLICES) * wave +
        Math.sin(t * 1.7 + i * 1.6) * 1.3 * (i / SLICES) * wave;
    for (let i = 0; i < SLICES; i++) {
        const u0 = i / SLICES;
        const u1 = (i + 1) / SLICES;
        const x0 = x + flyDir * u0 * clothW;
        const x1 = x + flyDir * u1 * clothW;
        const dy0 = lift(i) + slant * u0;
        const dy1 = lift(i + 1) + slant * u1;
        // Swallowtail: the fly edge of the last slice is V-cut into tongues.
        const isTail = design.swallowtail && i === SLICES - 1;
        for (const half of [0, 1] as const) {
            const vTop = half * 0.5;
            const vBot = vTop + 0.5;
            const color = fieldAt(design, (u0 + u1) / 2, (vTop + vBot) / 2);
            const yTop0 = topY + dy0 + vTop * clothH;
            const yBot0 = topY + dy0 + vBot * clothH;
            let yTop1 = topY + dy1 + vTop * clothH;
            let yBot1 = topY + dy1 + vBot * clothH;
            if (isTail) {
                if (half === 0) yBot1 = topY + dy1 + clothH * 0.3;
                else yTop1 = topY + dy1 + clothH * 0.7;
            }
            g.fillStyle(color, 1);
            g.beginPath();
            g.moveTo(x0, yTop0);
            g.lineTo(x1, yTop1);
            g.lineTo(x1, yBot1);
            g.lineTo(x0, yBot0);
            g.closePath();
            g.fillPath();
        }
        // Ripple shading: slices angled away from the light read darker.
        if (!isTail) {
            const shade = Math.max(0, Math.min(0.22, (dy1 - dy0) * 0.09 + 0.06));
            g.fillStyle(0x000000, shade);
            g.fillRect(Math.min(x0, x1), topY + Math.min(dy0, dy1), Math.abs(x1 - x0), clothH);
        }
    }
    // Hoist edge band + top light.
    const spanW = Math.max(1.5, Math.abs(flyDir) * clothW);
    g.fillStyle(0xffffff, 0.14);
    g.fillRect(Math.min(x, x + flyDir * clothW), topY + lift(0) - 0.4, spanW, 1.4);
    if (design.pattern === 0 && Math.abs(flyDir) > 0.3) {
        g.lineStyle(1.2, design.field2, 1);
        g.strokeRect(Math.min(x, x + flyDir * clothW) + 0.6, topY + 0.6, spanW - 1.2, clothH - 1.2);
    }
    // The charge rides the middle slices' wave (hidden when near edge-on).
    if (Math.abs(flyDir) > 0.25) {
        const midLift = (lift(2) + lift(3)) / 2 + slant * 0.42;
        drawEmblem(g, design, x + flyDir * clothW * 0.46, topY + midLift + clothH * 0.5, clothH * 0.62 * Math.min(1, Math.abs(flyDir) + 0.35));
    }
}

/**
 * The small figure under the big flag. Cloaked in the village's own field
 * colour, both hands on the pole.
 */
export function drawFlagBearer(
    g: Phaser.GameObjects.Graphics,
    x: number,
    y: number,
    time: number,
    design: FlagDesign,
    facing: number,
    marching: boolean,
    stream?: { dir: number; speed: number; climb: number }
) {
    const bob = marching ? Math.abs(Math.sin(time * 0.009 + design.phase)) * 1.3 : 0;
    g.fillStyle(0x000000, 0.16);
    g.fillEllipse(x, y + 3, 9, 3.4);
    // The pole he grips (the flag itself is drawn by drawVillageFlag at this x).
    g.fillStyle(design.field, 1);
    g.fillTriangle(x - 3.6, y + 2, x + 3.6, y + 2, x, y - 8.5 - bob);
    g.fillStyle(0xd9b38c, 1);
    g.fillCircle(x, y - 9.6 - bob, 2.1);
    // Both fists on the pole.
    g.fillStyle(0xd9b38c, 1);
    g.fillCircle(x + facing * 1.4, y - 6.4 - bob, 1.1);
    g.fillCircle(x + facing * 1.1, y - 3.6 - bob, 1.1);
    drawVillageFlag(g, x + facing * 1.3, y + 2 - bob, time, design, facing, { marching, stream });
}
