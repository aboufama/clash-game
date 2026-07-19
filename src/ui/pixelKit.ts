/**
 * The pixel UI kit — hand-built pixel-art frames for the DOM layer.
 *
 * Pixel styling is deliberately local to authored assets and UI; the world
 * canvas itself stays antialiased. These DOM frames are drawn pixel-by-pixel.
 * This module generates the frame bitmaps (as crisp SVG data URIs) on a
 * logical pixel grid — stepped corners, 1px outline, bevelled wood border,
 * dark seam, flat face — and installs them as CSS custom properties that
 * the `.pxf-*` classes in App.css consume via border-image.
 *
 * One grid, many palettes: every variant is a colour swap, so the whole UI
 * shares identical geometry (the "borders and stuff" finally line up).
 */

interface FramePalette {
    /** 1px outline (the darkest ring). */
    outline: string;
    /** Border body — top/left rows. */
    light: string;
    /** Border body — bottom/right rows. */
    shade: string;
    /** 1px seam between border and face. */
    seam: string;
    /** The face the content sits on. */
    face: string;
}

const WOOD: FramePalette = {
    outline: '#1c1410',
    light: '#8b6f47',
    shade: '#4a3524',
    seam: '#14100c',
    face: '#2b1f15'
};

const WOOD_RAISED: FramePalette = { ...WOOD, face: '#3f2f1f' };
const WOOD_PRESSED: FramePalette = { ...WOOD, light: '#4a3524', shade: '#8b6f47', face: '#241a11' };
const GOLD: FramePalette = { outline: '#1c1410', light: '#f7dc6f', shade: '#8a6a1e', seam: '#14100c', face: '#3f2f1f' };
const PARCHMENT: FramePalette = { outline: '#1c1410', light: '#c9b380', shade: '#8a744e', seam: '#5c4a30', face: '#efe3bb' };
const DANGER: FramePalette = { outline: '#1c1410', light: '#e77c6a', shade: '#7c1f14', seam: '#14100c', face: '#3a1511' };
// Troop-path accents for the training/raid cards — same grid, faction hues
// (mystic arcane purple, mechanica workshop copper).
const MYSTIC: FramePalette = { outline: '#1c1410', light: '#a27bb8', shade: '#4d3a5e', seam: '#14100c', face: '#241b2e' };
const MECHANICA: FramePalette = { outline: '#1c1410', light: '#c18745', shade: '#5f3c1a', seam: '#14100c', face: '#2a1e10' };

/**
 * Draw one frame cell. Ring 0 is the outline, rings 1-2 the bevelled body,
 * ring 3 the seam, everything deeper the face. Corners are cut two pixels
 * deep on the diagonal — the signature pixel-art step.
 */
function frameCell(x: number, y: number, n: number, pal: FramePalette): string | null {
    const diag = Math.min(x + y, (n - 1 - x) + y, x + (n - 1 - y), (n - 1 - x) + (n - 1 - y));
    if (diag < 2) return null;              // stepped corner cut
    if (diag === 2) return pal.outline;     // diagonal outline across the step
    const ring = Math.min(x, y, n - 1 - x, n - 1 - y);
    if (ring === 0) return pal.outline;
    if (ring <= 2) {
        // Bevel: lit from the top-left, shaded toward the bottom-right.
        const towardTopLeft = Math.min(x, y) <= Math.min(n - 1 - x, n - 1 - y);
        return towardTopLeft ? pal.light : pal.shade;
    }
    if (ring === 3) return pal.seam;
    return pal.face;
}

function frameSvg(pal: FramePalette, n = 12): string {
    let rects = '';
    for (let y = 0; y < n; y++) {
        for (let x = 0; x < n; x++) {
            const color = frameCell(x, y, n, pal);
            if (color) rects += `<rect x="${x}" y="${y}" width="1" height="1" fill="${color}"/>`;
        }
    }
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${n}" height="${n}" shape-rendering="crispEdges">${rects}</svg>`;
    return `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;
}

/** The thin bar frame (health/progress): outline, grey rim, maroon track. */
function barSvg(outline: string, rim: string, track: string): string {
    const n = 8;
    let rects = '';
    for (let y = 0; y < n; y++) {
        for (let x = 0; x < n; x++) {
            const diag = Math.min(x + y, (n - 1 - x) + y, x + (n - 1 - y), (n - 1 - x) + (n - 1 - y));
            if (diag < 1) continue; // single-step corner
            const ring = Math.min(x, y, n - 1 - x, n - 1 - y);
            const color = diag === 1 ? outline : ring === 0 ? outline : ring === 1 ? rim : track;
            rects += `<rect x="${x}" y="${y}" width="1" height="1" fill="${color}"/>`;
        }
    }
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${n}" height="${n}" shape-rendering="crispEdges">${rects}</svg>`;
    return `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;
}

/**
 * The speech-bubble tail: a true comic tail, not a floating wedge. The top
 * four rows OVERLAP the card's bottom border (the .px-tail CSS lifts it by
 * exactly that much): the face colour punches a channel through seam, bevel
 * and outline — connecting the card's interior to the tail — while the dark
 * outline turns and runs down the channel walls, around the protruding
 * wedge, and closes at the tip. The border visibly wraps the bump.
 */
function tailSvg(pal: FramePalette): string {
    // One row per line: [leftOutlineX, faceStart, faceEnd, rightOutlineX].
    // Rows 0-3 cross the border (seam, bevel, bevel, outline); rows 4-8 hang
    // below the card, tapering 45° to a closed two-pixel tip.
    const rows: Array<[number, number, number, number]> = [
        [1, 2, 9, 10],
        [1, 2, 9, 10],
        [1, 2, 9, 10],
        [1, 2, 9, 10],
        [1, 2, 9, 10],
        [2, 3, 8, 9],
        [3, 4, 7, 8],
        [4, 5, 6, 7],
        [5, 6, 5, 6]
    ];
    let rects = '';
    rows.forEach(([lo, f0, f1, ro], y) => {
        rects += `<rect x="${lo}" y="${y}" width="1" height="1" fill="${pal.outline}"/>`;
        rects += `<rect x="${ro}" y="${y}" width="1" height="1" fill="${pal.outline}"/>`;
        for (let x = f0; x <= f1; x++) {
            rects += `<rect x="${x}" y="${y}" width="1" height="1" fill="${pal.face}"/>`;
        }
    });
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="12" height="9" shape-rendering="crispEdges">${rects}</svg>`;
    return `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;
}

/** Install every frame as a CSS custom property on :root. Call once at boot. */
export function installPixelKit() {
    const root = document.documentElement.style;
    root.setProperty('--pxf-panel', frameSvg(WOOD));
    root.setProperty('--pxf-btn', frameSvg(WOOD_RAISED));
    root.setProperty('--pxf-btn-down', frameSvg(WOOD_PRESSED));
    root.setProperty('--pxf-gold', frameSvg(GOLD));
    root.setProperty('--pxf-bubble', frameSvg(PARCHMENT));
    root.setProperty('--pxf-danger', frameSvg(DANGER));
    root.setProperty('--pxf-mystic', frameSvg(MYSTIC));
    root.setProperty('--pxf-mechanica', frameSvg(MECHANICA));
    root.setProperty('--pxf-bar', barSvg('#1a1a1a', '#333333', '#4a1a1a'));
    root.setProperty('--pxf-tail', tailSvg(PARCHMENT));
    root.setProperty('--pxf-tail-danger', tailSvg(DANGER));
}
