import Phaser from 'phaser';

/**
 * PixelDraw — hand-authored pixel-art primitives on the bake grid.
 *
 * For live vector layers that can't become RenderTextures (world-spanning
 * roads, the living cloud rampart) or tiny overlays (speech bubbles, emotes),
 * the crisp look is drawn DIRECTLY: every shape is composed of whole
 * 1.35-world-px cells, so it reads exactly like the baked sprites with zero
 * texture memory and no post pass. Two anchoring modes:
 *
 *  - WORLD shapes (roads, clouds): cells snap to the absolute world grid —
 *    pan-rigid, exactly like the old shader's world-anchored quantize.
 *  - LOCAL art (bubbles, emotes on a moving carrier): cells are relative to
 *    the carrier, like a baked sprite's texels — the art moves smoothly and
 *    stays internally chunky.
 *
 * No AA ever escapes these helpers: they only emit axis-aligned rects on
 * cell boundaries. Iron rule 3 applies — animate with time-derived phases.
 */

export const PIXEL_CELL = 1.35;

/**
 * One figure-animation clock for the whole world: the home village and every
 * neighbor village step their figures at this rate (2× the old neighbor LOD
 * rate — the owner's sweet spot). Figures deliberately do NOT glide at
 * render-frequency: stepping at the shared tick (plus cell-snapped stamps)
 * keeps their motion a touch jagged, matching the baked world.
 */
export const FIGURE_ANIM_HZ = 24;
export const FIGURE_TICK_MS = 1000 / FIGURE_ANIM_HZ;

/** The tick index for a timestamp; visuals redraw when this changes. */
export function figureTick(timeMs: number): number {
    return Math.floor(timeMs / FIGURE_TICK_MS);
}

type G = Phaser.GameObjects.Graphics;

const floorTo = (v: number, cell: number) => Math.floor(v / cell) * cell;

/** Axis-aligned rect snapped OUT to the world cell grid. */
export function pixelRect(g: G, x: number, y: number, w: number, h: number, color: number, alpha = 1, cell = PIXEL_CELL) {
    const x0 = floorTo(x, cell);
    const y0 = floorTo(y, cell);
    const x1 = floorTo(x + w - 1e-6, cell) + cell;
    const y1 = floorTo(y + h - 1e-6, cell) + cell;
    g.fillStyle(color, alpha);
    g.fillRect(x0, y0, x1 - x0, y1 - y0);
}

/**
 * Ellipse as one merged rect per cell row — the pixel-art circle every
 * cobble, rock and cloud puff is built from. World-anchored by default.
 */
export function pixelEllipse(g: G, cx: number, cy: number, rx: number, ry: number, color: number, alpha = 1, cell = PIXEL_CELL) {
    if (rx <= 0 || ry <= 0) return;
    g.fillStyle(color, alpha);
    const top = floorTo(cy - ry, cell);
    const bottom = floorTo(cy + ry, cell) + cell;
    for (let y = top; y < bottom; y += cell) {
        const my = y + cell / 2;
        const t = (my - cy) / ry;
        const k = 1 - t * t;
        if (k <= 0) continue;
        const span = rx * Math.sqrt(k);
        const x0 = floorTo(cx - span, cell);
        const x1 = floorTo(cx + span - 1e-6, cell) + cell;
        if (x1 > x0) g.fillRect(x0, y, x1 - x0, cell);
    }
}

/** Line walked cell-by-cell (grid DDA), `thick` cells wide. */
export function pixelLine(g: G, x0: number, y0: number, x1: number, y1: number, thick: number, color: number, alpha = 1, cell = PIXEL_CELL) {
    const dx = x1 - x0;
    const dy = y1 - y0;
    const steps = Math.max(1, Math.ceil(Math.max(Math.abs(dx), Math.abs(dy)) / cell));
    const half = ((thick - 1) / 2) * cell;
    g.fillStyle(color, alpha);
    let px = NaN, py = NaN;
    for (let i = 0; i <= steps; i++) {
        const cx = floorTo(x0 + (dx * i) / steps - half, cell);
        const cy = floorTo(y0 + (dy * i) / steps - half, cell);
        if (cx === px && cy === py) continue;
        px = cx; py = cy;
        g.fillRect(cx, cy, thick * cell, thick * cell);
    }
}

/**
 * Wobbled ellipse (organic blob — puddles, stains): pixelEllipse whose
 * per-row span breathes with a deterministic sine, so the rim stays
 * irregular but every edge is still whole cells.
 */
export function pixelBlob(g: G, cx: number, cy: number, rx: number, ry: number, wobble: number, seed: number, color: number, alpha = 1, cell = PIXEL_CELL) {
    if (rx <= 0 || ry <= 0) return;
    g.fillStyle(color, alpha);
    const top = floorTo(cy - ry, cell);
    const bottom = floorTo(cy + ry, cell) + cell;
    let row = 0;
    for (let y = top; y < bottom; y += cell, row++) {
        const my = y + cell / 2;
        const t = (my - cy) / ry;
        const k = 1 - t * t;
        if (k <= 0) continue;
        const wob = 1 + wobble * Math.sin(row * 2.4 + seed * 7.31);
        const span = rx * Math.sqrt(k) * wob;
        const shift = wobble * rx * 0.35 * Math.sin(row * 1.7 + seed * 3.9);
        const x0 = floorTo(cx + shift - span, cell);
        const x1 = floorTo(cx + shift + span - 1e-6, cell) + cell;
        if (x1 > x0) g.fillRect(x0, y, x1 - x0, cell);
    }
}

/**
 * Hand-authored pixel art: rows of palette characters ('.' or ' ' = skip).
 * Draws with the art's own cell grid anchored at (x, y) — LOCAL mode, the
 * right anchoring for speech bubbles and emotes on moving carriers.
 */
export function pixelBitmap(g: G, x: number, y: number, rows: readonly string[], palette: Record<string, number>, alpha = 1, cell = PIXEL_CELL) {
    for (let r = 0; r < rows.length; r++) {
        const row = rows[r];
        let c = 0;
        while (c < row.length) {
            const ch = row[c];
            if (ch === '.' || ch === ' ') { c++; continue; }
            let end = c + 1;
            while (end < row.length && row[end] === ch) end++;
            const color = palette[ch];
            if (color !== undefined) {
                g.fillStyle(color, alpha);
                g.fillRect(x + c * cell, y + r * cell, (end - c) * cell, cell);
            }
            c = end;
        }
    }
}
