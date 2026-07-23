import Phaser from 'phaser';
import { hashString, mulberry32 } from '../config/Economy';
import { sanitizeVillageBanner, type VillageBanner } from '../data/Models';
import { PIXEL_CELL, pixelEllipse, pixelLine, pixelRect } from '../render/PixelDraw';

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

/** The heraldry field palette exposed to the banner picker (index = `palette`). */
export const BANNER_FIELDS: readonly number[] = FIELDS;

/** The bounded axes a design occupies — seeds the picker with the current flag. */
export function bannerAxesOf(design: FlagDesign): VillageBanner {
    return {
        palette: Math.max(0, FIELDS.indexOf(design.field)),
        emblem: design.emblem,
        pattern: design.pattern
    };
}

/**
 * The ONE banner→design mapping, shared by the town hall, the war camp, the
 * picker preview and neighbour postcards. The identity-derived design is only
 * a rendering fallback for bots and explicit preview samples. Real player
 * call sites suppress the flag entirely until onboarding stores a choice.
 * With a banner, the chosen axes override the default while the metal, the
 * swallowtail cut and wave phase stay identity-derived, so two villages
 * picking the same heraldry still retain distinct cloth motion and cuts.
 */
export function bannerDesignFor(identity: string, banner?: VillageBanner | null): FlagDesign {
    const base = villageFlagFor(identity);
    const safe = sanitizeVillageBanner(banner ?? null);
    if (!safe) return base;
    const fieldIx = safe.palette % FIELDS.length;
    // The second field keeps the default when it contrasts; otherwise the
    // same +3 rotation the default generator uses for collisions.
    const field2 = base.field2 === FIELDS[fieldIx] || base.field === FIELDS[fieldIx]
        ? FIELDS[(fieldIx + 3) % FIELDS.length]
        : base.field2;
    return {
        ...base,
        field: FIELDS[fieldIx],
        field2,
        pattern: safe.pattern,
        emblem: safe.emblem % 6
    };
}

/**
 * A filled triangle as a few stacked pixel-cell rows (PixelDraw has no
 * triangle on purpose): rows interpolate from the base corners to the apex.
 */
function pixelTriangleRows(
    g: Phaser.GameObjects.Graphics,
    apexX: number,
    apexY: number,
    baseLeftX: number,
    baseRightX: number,
    baseY: number,
    color: number,
    alpha = 1,
    rows = 3
) {
    for (let row = 0; row < rows; row++) {
        const mid = (row + 0.5) / rows;
        const y0 = baseY + (apexY - baseY) * (row / rows);
        const y1 = baseY + (apexY - baseY) * ((row + 1) / rows);
        const x0 = baseLeftX + (apexX - baseLeftX) * mid;
        const x1 = baseRightX + (apexX - baseRightX) * mid;
        pixelRect(g, Math.min(x0, x1), Math.min(y0, y1),
            Math.max(0.5, Math.abs(x1 - x0)), Math.max(0.5, Math.abs(y1 - y0)), color, alpha);
    }
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

/** The charge, drawn small in the metal colour at cloth centre — every shape
 *  now lands as whole pixel cells (heraldry colours untouched). */
function drawEmblem(g: Phaser.GameObjects.Graphics, design: FlagDesign, x: number, y: number, s: number) {
    const metal = design.metal;
    switch (design.emblem) {
        case 0: // tower
            pixelRect(g, x - s * 0.42, y - s * 0.5, s * 0.84, s, metal);
            pixelRect(g, x - s * 0.58, y - s * 0.66, s * 0.34, s * 0.3, metal);
            pixelRect(g, x + s * 0.24, y - s * 0.66, s * 0.34, s * 0.3, metal);
            break;
        case 1: // blade, point up: a stacked-cell wedge over a cell guard
            pixelTriangleRows(g, x, y - s * 0.72, x - s * 0.2, x + s * 0.2, y + s * 0.28, metal);
            pixelRect(g, x - s * 0.42, y + s * 0.28, s * 0.84, s * 0.16, metal);
            break;
        case 2: // oak leaf
            pixelEllipse(g, x, y - s * 0.14, s * 0.35, s * 0.45, metal);
            pixelTriangleRows(g, x, y + s * 0.62, x - s * 0.1, x + s * 0.1, y + s * 0.3, metal, 1, 2);
            break;
        case 3: { // star: a cell core with five cell-walked rays
            pixelEllipse(g, x, y, s * 0.26, s * 0.26, metal);
            for (let i = 0; i < 5; i++) {
                const a = -Math.PI / 2 + (i * Math.PI * 2) / 5;
                pixelLine(g, x, y, x + Math.cos(a) * s * 0.66, y + Math.sin(a) * s * 0.66, 1, metal);
            }
            break;
        }
        case 4: // crescent: metal disc bitten by a field-coloured disc
            pixelEllipse(g, x, y, s * 0.52, s * 0.52, metal);
            pixelEllipse(g, x + s * 0.24, y - s * 0.1, s * 0.42, s * 0.42, fieldAt(design, 0.5, 0.5));
            break;
        default: // hammer
            pixelRect(g, x - s * 0.09, y - s * 0.3, s * 0.18, s * 0.92, metal);
            pixelRect(g, x - s * 0.5, y - s * 0.62, s, s * 0.4, metal);
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
        /** Ripple-amplitude multiplier — a banner scaled Nx passes N so the
         *  wave depth scales with the cloth while the deterministic ripple
         *  PERIOD stays untouched (default 1). */
        amp?: number;
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
    const amp = opts.amp ?? 1;
    const stream = opts.stream;
    // Which way the cloth flies: physics (opposite the travel) when moving,
    // the bearer's facing otherwise.
    const flyDir = stream ? Math.max(-1, Math.min(1, stream.dir)) : facing;
    const wave = stream ? 0.7 + Math.min(1, stream.speed) * 0.9 : opts.marching ? 1 : 0.62;
    // Air drag tilts the streaming cloth against the climb.
    const slant = stream ? -stream.climb * 4.6 * Math.min(1, Math.abs(flyDir) + 0.25) : 0;
    const topY = groundY - poleH;

    // Pole (dark ash, gold finial) — cell lines and a cell disc, no AA strokes.
    pixelLine(g, x, groundY, x, topY - 2, 2, 0x4a3a26, 1);
    pixelLine(g, x - 0.7, groundY, x - 0.7, topY - 1, 1, 0x6e5136, 1);
    pixelEllipse(g, x, topY - 3.2, 2.2, 2.2, 0xd9b348, 1);

    // Cloth as one-cell-wide vertical column strips; ripple grows toward the
    // fly edge. The SAME slice wave as the old quad mesh (SLICES anchors its
    // spatial frequency), sampled continuously at each column's centre, so
    // the cloth waves as chunky pixel columns.
    const SLICES = 6;
    const t = time * 0.0072 + design.phase;
    const lift = (f: number) =>
        Math.sin(t + f * 0.92) * 3.4 * amp * (f / SLICES) * wave +
        Math.sin(t * 1.7 + f * 1.6) * 1.3 * amp * (f / SLICES) * wave;
    const cols = Math.max(2, Math.round(clothW / PIXEL_CELL));
    const rows = Math.max(2, Math.round(clothH / PIXEL_CELL));
    const tailStartU = (SLICES - 1) / SLICES;
    for (let col = 0; col < cols; col++) {
        const u = (col + 0.5) / cols;
        const f = u * SLICES;
        const dy = lift(f) + slant * u;
        const colXa = x + flyDir * (col / cols) * clothW;
        const colXb = x + flyDir * ((col + 1) / cols) * clothW;
        const colX = Math.min(colXa, colXb);
        const colW = Math.max(0.5, Math.abs(colXb - colXa));
        // Swallowtail: the fly edge of the last slice is V-cut into tongues —
        // the notch deepens linearly across it, exactly like the old quads.
        const tail = design.swallowtail && u > tailStartU
            ? (u - tailStartU) * SLICES * 0.2
            : 0;
        // Column cells merge into runs of one field colour (heraldry intact:
        // the run colours come straight from fieldAt).
        let runStart = 0;
        let runColor: number | null = null;
        const flush = (endRow: number) => {
            if (runColor === null || endRow <= runStart) return;
            pixelRect(g, colX, topY + dy + (runStart / rows) * clothH, colW,
                ((endRow - runStart) / rows) * clothH, runColor, 1);
        };
        for (let row = 0; row < rows; row++) {
            const v = (row + 0.5) / rows;
            const color = tail > 0 && Math.abs(v - 0.5) < tail
                ? null // inside the swallowtail notch
                : fieldAt(design, u, v);
            if (color !== runColor) {
                flush(row);
                runStart = row;
                runColor = color;
            }
        }
        flush(rows);
        // Ripple shading: columns angled away from the light read darker —
        // the same one-slice slope the quad mesh shaded by.
        if (!(design.swallowtail && u > tailStartU)) {
            const slope = lift(f + 1) - lift(f) + slant / SLICES;
            const shade = Math.max(0, Math.min(0.22, slope * 0.09 + 0.06));
            if (shade > 0) pixelRect(g, colX, topY + dy, colW, clothH, 0x000000, shade);
        }
    }
    // Hoist edge band + top light.
    const spanW = Math.max(1.5, Math.abs(flyDir) * clothW);
    pixelRect(g, Math.min(x, x + flyDir * clothW), topY + lift(0) - 0.4, spanW, 1.4, 0xffffff, 0.14);
    if (design.pattern === 0 && Math.abs(flyDir) > 0.3) {
        // Solid banners wear a field2 border: four cell lines, not a stroke.
        const bx0 = Math.min(x, x + flyDir * clothW) + 0.6;
        const bx1 = bx0 + spanW - 1.2;
        const by0 = topY + 0.6;
        const by1 = topY + clothH - 0.6;
        pixelLine(g, bx0, by0, bx1, by0, 1, design.field2, 1);
        pixelLine(g, bx1, by0, bx1, by1, 1, design.field2, 1);
        pixelLine(g, bx1, by1, bx0, by1, 1, design.field2, 1);
        pixelLine(g, bx0, by1, bx0, by0, 1, design.field2, 1);
    }
    // The charge rides the middle slices' wave (hidden when near edge-on).
    if (Math.abs(flyDir) > 0.25) {
        const midLift = (lift(2) + lift(3)) / 2 + slant * 0.42;
        drawEmblem(g, design, x + flyDir * clothW * 0.46, topY + midLift + clothH * 0.5, clothH * 0.62 * Math.min(1, Math.abs(flyDir) + 0.35));
    }
}

/** Deaden a dye toward soot — the fallen standard's whole palette. */
function dulled(color: number, k: number): number {
    const r = Math.round(((color >> 16) & 0xff) * k);
    const gr = Math.round(((color >> 8) & 0xff) * k);
    const b = Math.round((color & 0xff) * k);
    return (r << 16) | (gr << 8) | b;
}

/**
 * The dropped standard. When the hall it flew from is torn down, the pole
 * falls from the roof and stabs into the lawn at a hard lean — still
 * standing, only just. The cloth hangs dead along the upper pole, dyes
 * deadened, the fly edge torn to rags; the gold finial lies thrown clear in
 * the grass. Every tear and every sway is deterministic (`design` + `time`),
 * and the heraldry still reads through the soot — same field/emblem code
 * path as the flying banner.
 */
export function drawFallenVillageFlag(
    g: Phaser.GameObjects.Graphics,
    x: number,
    groundY: number,
    time: number,
    design: FlagDesign,
    facing = 1,
    opts: { poleH?: number; clothW?: number; clothH?: number } = {}
) {
    const poleH = opts.poleH ?? 30;
    const clothW = opts.clothW ?? 22;
    const clothH = opts.clothH ?? 14;
    const worn: FlagDesign = {
        ...design,
        field: dulled(design.field, 0.72),
        field2: dulled(design.field2, 0.72),
        metal: dulled(design.metal, 0.82)
    };

    // The lean: ~41 degrees off vertical, tip toward the fly side — felled
    // hard, standing only just.
    const lean = { x: facing * 0.66, y: -0.75 };
    const at = (d: number): [number, number] => [x + lean.x * d, groundY + lean.y * d];
    const [tipX, tipY] = at(poleH);

    // Stab scar where it hit, and the finial ball thrown clear, gone dull.
    pixelEllipse(g, x, groundY + 1, 5.2, 2.3, 0x241c10, 0.3);
    pixelRect(g, x - 2.4, groundY - 0.5, 1.4, 1.1, 0x4a3a22, 0.9);
    pixelRect(g, x + 1.1, groundY + 0.7, 1.6, 1, 0x3c2f1c, 0.9);
    pixelEllipse(g, x - facing * 6.6, groundY + 1.6, 2, 1.4, 0x8a7430, 1);
    pixelEllipse(g, x - facing * 7.1, groundY + 1.1, 0.7, 0.6, 0xb59a54, 1);

    // The cloth: slid down the leaning pole and hung dead along it. Columns
    // are one pixel cell wide, marching from the tip back toward the foot;
    // each hangs straight down from the pole line. Tears deepen toward the
    // loose end — torn once per design, never per frame.
    const spanX = Math.min(clothW, Math.abs(tipX - x) * 0.85);
    const cols = Math.max(4, Math.round(spanX / PIXEL_CELL));
    const rows = Math.max(3, Math.round(clothH / PIXEL_CELL));
    const rag = mulberry32(hashString(`${design.phase.toFixed(4)}:rags`));
    for (let col = 0; col < cols; col++) {
        const u = cols > 1 ? col / (cols - 1) : 0;
        const xc = tipX - facing * (col + 0.5) * PIXEL_CELL;
        const t = (xc - x) / (tipX - x || 1);
        const topY = groundY + (tipY - groundY) * t;
        const sway = Math.sin(time * 0.0016 + design.phase + u * 1.7) * (0.35 + u * 0.55);
        const torn = rag() * 0.62 * u + (rag() < 0.16 ? 0.3 : 0);
        const len = clothH * (0.94 - 0.22 * u) * (1 - torn);
        const colX = Math.min(xc, xc - facing * PIXEL_CELL) + (facing > 0 ? 0 : PIXEL_CELL);
        let runStart = 0;
        let runColor: number | null = null;
        const flush = (endRow: number) => {
            if (runColor === null || endRow <= runStart) return;
            pixelRect(g, colX, topY + sway + (runStart / rows) * clothH, PIXEL_CELL,
                ((endRow - runStart) / rows) * clothH, runColor, 1);
        };
        for (let row = 0; row < rows; row++) {
            const v = (row + 0.5) / rows;
            const within = (row / rows) * clothH <= len;
            const hole = within && row > 0 && rag() < 0.06;
            const color = within && !hole ? fieldAt(worn, u, v) : null;
            if (color !== runColor) {
                flush(row);
                runStart = row;
                runColor = color;
            }
        }
        flush(rows);
    }

    // The charge, dulled but legible, where the cloth still holds together.
    const emblemX = tipX - facing * spanX * 0.3;
    const emblemT = (emblemX - x) / (tipX - x || 1);
    drawEmblem(g, worn, emblemX, groundY + (tipY - groundY) * emblemT + clothH * 0.52, clothH * 0.58);

    // The pole over the cloth: ash gone grey, tip splintered where the
    // finial tore away.
    pixelLine(g, x, groundY, tipX, tipY, 2, 0x3a2e1e, 1);
    pixelLine(g, x - 0.7, groundY, tipX - 0.7, tipY, 1, 0x55422b, 1);
    const [splinterX, splinterY] = at(poleH + 2);
    pixelRect(g, splinterX - 0.7, splinterY - 0.6, 1.3, 1.3, 0x55422b, 1);
}

/**
 * Minimal Graphics stand-in for DOM canvas previews. The PixelDraw
 * primitives the flag is built from only ever call `fillStyle` + `fillRect`,
 * so the REAL renderer paints the banner-picker swatches — one heraldry code
 * path everywhere, the preview can never drift from the world.
 */
class CanvasGraphicsShim {
    private readonly ctx: CanvasRenderingContext2D;
    constructor(ctx: CanvasRenderingContext2D) {
        this.ctx = ctx;
    }
    fillStyle(color: number, alpha = 1) {
        this.ctx.fillStyle = `rgba(${(color >> 16) & 0xff},${(color >> 8) & 0xff},${color & 0xff},${alpha})`;
    }
    fillRect(x: number, y: number, w: number, h: number) {
        this.ctx.fillRect(x, y, w, h);
    }
}

/**
 * Paint one banner (pole + cloth + charge) onto a DOM canvas for the picker.
 * Pose is a fixed deterministic instant of the same wave the world plays.
 */
export function drawBannerPreview(
    canvas: HTMLCanvasElement,
    design: FlagDesign,
    opts: { scale?: number; time?: number } = {}
) {
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const scale = opts.scale ?? 2;
    ctx.save();
    ctx.scale(scale, scale);
    const g = new CanvasGraphicsShim(ctx) as unknown as Phaser.GameObjects.Graphics;
    const w = canvas.width / scale;
    const h = canvas.height / scale;
    const poleH = h - 7;
    const clothW = w - 10;
    const clothH = Math.min(poleH - 4, Math.round(clothW * 0.56));
    drawVillageFlag(g, 3, h - 2, opts.time ?? 460, design, 1, { poleH, clothW, clothH });
    ctx.restore();
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
    pixelEllipse(g, x, y + 3, 4.5, 1.7, 0x000000, 0.16);
    // The pole he grips (the flag itself is drawn by drawVillageFlag at this
    // x). Cloak: a wedge of stacked pixel-cell rows in the village's field.
    pixelTriangleRows(g, x, y - 8.5 - bob, x - 3.6, x + 3.6, y + 2, design.field);
    pixelEllipse(g, x, y - 9.6 - bob, 2.1, 2.1, 0xd9b38c, 1);
    // Both fists on the pole.
    pixelEllipse(g, x + facing * 1.4, y - 6.4 - bob, 1.1, 1.1, 0xd9b38c, 1);
    pixelEllipse(g, x + facing * 1.1, y - 3.6 - bob, 1.1, 1.1, 0xd9b38c, 1);
    drawVillageFlag(g, x + facing * 1.3, y + 2 - bob, time, design, facing, { marching, stream });
}
