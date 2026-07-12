import Phaser from 'phaser';

/**
 * Sampling is an asset-level decision. The world renderer stays smooth by
 * default; authored pixel art opts into nearest-neighbour filtering here.
 */
export const TextureSampling = {
    PIXEL_ART: 'pixel-art',
    SMOOTH: 'smooth'
} as const;

export type TextureSampling = (typeof TextureSampling)[keyof typeof TextureSampling];

const FILTER_FOR_SAMPLING: Record<TextureSampling, Phaser.Textures.FilterMode> = {
    [TextureSampling.PIXEL_ART]: Phaser.Textures.FilterMode.NEAREST,
    [TextureSampling.SMOOTH]: Phaser.Textures.FilterMode.LINEAR
};

export function applyTextureSampling<T extends Phaser.Textures.Texture>(
    texture: T,
    sampling: TextureSampling
): T {
    texture.setFilter(FILTER_FOR_SAMPLING[sampling]);
    return texture;
}

export interface ManifestFramePlacement {
    originX: number;
    originY: number;
    cellWorldPx: number;
}

function finiteField(frame: Record<string, unknown>, field: keyof ManifestFramePlacement, label: string): number {
    const value = frame[field];
    if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw new TypeError(`${label}.${field} must be a finite number`);
    }
    return value;
}

/** Validate the geometry contract emitted for each baked sprite frame. */
export function validateManifestFramePlacement(
    frame: unknown,
    label = 'sprite manifest frame'
): ManifestFramePlacement {
    if (typeof frame !== 'object' || frame === null || Array.isArray(frame)) {
        throw new TypeError(`${label} must be an object`);
    }

    const record = frame as Record<string, unknown>;
    const originX = finiteField(record, 'originX', label);
    const originY = finiteField(record, 'originY', label);
    const cellWorldPx = finiteField(record, 'cellWorldPx', label);

    // Anchors may legitimately sit outside the cropped frame (obstacle and
    // troop anchor points) — the regression gate enforces the same window.
    if (originX < -0.5 || originX > 1.5) {
        throw new RangeError(`${label}.originX must be between -0.5 and 1.5`);
    }
    if (originY < -0.5 || originY > 1.5) {
        throw new RangeError(`${label}.originY must be between -0.5 and 1.5`);
    }
    if (cellWorldPx <= 0) {
        throw new RangeError(`${label}.cellWorldPx must be greater than 0`);
    }

    return { originX, originY, cellWorldPx };
}

/**
 * Apply a baked frame's anchor and world-pixel scale to a Phaser image or
 * sprite. Baked manifest frames are authored pixel art, so their texture also
 * opts into nearest-neighbour sampling at this single transition boundary.
 */
export function applyPixelArtManifestFrame<
    T extends Phaser.GameObjects.Image | Phaser.GameObjects.Sprite
>(target: T, frame: unknown, label?: string): T {
    const placement = validateManifestFramePlacement(frame, label);
    // Route through the PixelMode boundary so the texture honors the active
    // mode (LINEAR in the legacy baseline) and re-filters on live switches.
    registerPixelSurface(target.texture);
    target.setOrigin(placement.originX, placement.originY);
    target.setScale(placement.cellWorldPx);
    return target;
}

// --------------------------------------------------------------- PixelMode --

/** The bake grid: world pixels per baked texel (tools/art-preview CELL). */
export const BAKE_CELL_WORLD_PX = 1.35;

/**
 * PixelMode — how baked pixel surfaces (bank atlases, the ground RT, village
 * postcards, particle textures) are sampled at draw time. Switchable so the
 * candidate treatments can be compared in the live game:
 *
 *  - 'legacy'  — LINEAR sampling on all registered surfaces, the pre-fix
 *                look (wilderness postcard RTs stay NEAREST by design).
 *                Baked texels blur at the fractional texel→device scale.
 *                Baseline only.
 *  - 'nearest' — every registered pixel surface samples NEAREST. Hard texels
 *                at any zoom; texel columns may alternate width while the
 *                texel→device ratio is fractional.
 *  - 'snap'    — 'nearest' plus post-gesture zoom settling to the closest
 *                zoom where one baked texel maps to a whole number of backing
 *                pixels (see settleLogicalZoom), removing uneven columns.
 *
 * Selection: ?pixelMode= query param (persisted) > localStorage
 * 'clash.pixelmode' > default 'nearest'. Runtime handle:
 * window.__pixelMode('legacy'|'nearest'|'snap') re-filters live textures
 * without a reload.
 */
export type PixelMode = 'legacy' | 'nearest' | 'snap';

export const PIXEL_MODES: readonly PixelMode[] = ['legacy', 'nearest', 'snap'];

const PIXEL_MODE_STORAGE_KEY = 'clash.pixelmode';
const DEFAULT_PIXEL_MODE: PixelMode = 'nearest';

const isPixelMode = (value: unknown): value is PixelMode =>
    typeof value === 'string' && (PIXEL_MODES as readonly string[]).includes(value);

let activePixelMode: PixelMode | null = null;
const pixelSurfaces = new Set<Phaser.Textures.Texture>();
const pixelModeListeners = new Set<(mode: PixelMode) => void>();

function resolveInitialPixelMode(): PixelMode {
    try {
        if (typeof window !== 'undefined') {
            const fromQuery = new URLSearchParams(window.location.search).get('pixelMode');
            if (isPixelMode(fromQuery)) {
                try { localStorage.setItem(PIXEL_MODE_STORAGE_KEY, fromQuery); } catch { /* storage unavailable */ }
                return fromQuery;
            }
            const stored = localStorage.getItem(PIXEL_MODE_STORAGE_KEY);
            if (isPixelMode(stored)) return stored;
        }
    } catch { /* non-browser context → default */ }
    return DEFAULT_PIXEL_MODE;
}

export function currentPixelMode(): PixelMode {
    if (activePixelMode === null) activePixelMode = resolveInitialPixelMode();
    return activePixelMode;
}

/** Baked surfaces sample NEAREST in every mode except the legacy baseline. */
export function pixelSamplingEnabled(): boolean {
    return currentPixelMode() !== 'legacy';
}

/** Post-gesture zoom settling is exclusive to 'snap'. */
export function zoomSettleEnabled(): boolean {
    return currentPixelMode() === 'snap';
}

function samplingForMode(mode: PixelMode): TextureSampling {
    return mode === 'legacy' ? TextureSampling.SMOOTH : TextureSampling.PIXEL_ART;
}

const surfaceAlive = (texture: Phaser.Textures.Texture): boolean =>
    Boolean((texture as unknown as { manager?: unknown }).manager);

/**
 * Register a baked pixel surface (bank atlas, ground RT texture, postcard RT
 * texture, chunky particle texture). Applies the active mode's sampling now
 * and re-applies it on every mode switch. Safe to call more than once.
 */
export function registerPixelSurface<T extends Phaser.Textures.Texture>(texture: T): T {
    // Registered surfaces churn (postcard residency, ground-bake swaps) and
    // mode switches are rare, so evict dead entries here, not just on switch.
    for (const registered of pixelSurfaces) {
        if (!surfaceAlive(registered)) pixelSurfaces.delete(registered);
    }
    pixelSurfaces.add(texture);
    applyTextureSampling(texture, samplingForMode(currentPixelMode()));
    return texture;
}

export function setPixelMode(next: PixelMode): PixelMode {
    if (!isPixelMode(next)) return currentPixelMode();
    activePixelMode = next;
    try { localStorage.setItem(PIXEL_MODE_STORAGE_KEY, next); } catch { /* storage unavailable */ }
    const sampling = samplingForMode(next);
    for (const texture of pixelSurfaces) {
        if (!surfaceAlive(texture)) { pixelSurfaces.delete(texture); continue; }
        applyTextureSampling(texture, sampling);
    }
    for (const listener of pixelModeListeners) listener(next);
    return next;
}

export function onPixelModeChange(listener: (mode: PixelMode) => void): () => void {
    pixelModeListeners.add(listener);
    return () => pixelModeListeners.delete(listener);
}

/**
 * The closest logical zoom at which one baked texel spans a whole number of
 * backing pixels (texel scale = BAKE_CELL_WORLD_PX × zoom × renderScale).
 * 'snap' mode eases the camera here after each wheel/pinch gesture so texel
 * columns stay even instead of alternating widths.
 */
export function settleLogicalZoom(logicalZoom: number, renderScale: number): number {
    const perTexel = BAKE_CELL_WORLD_PX * Math.max(0.0001, renderScale);
    const wholeBackingPx = Math.max(1, Math.round(logicalZoom * perTexel));
    return wholeBackingPx / perTexel;
}

/** Same debug-handle culture as __clashGame: window.__pixelMode() reads the
 * mode, window.__pixelMode('snap') switches it live. */
export function installPixelModeHandle(): void {
    if (typeof window === 'undefined') return;
    (window as unknown as Record<string, unknown>).__pixelMode = (next?: unknown): PixelMode =>
        (next === undefined ? currentPixelMode() : setPixelMode(next as PixelMode));
}
