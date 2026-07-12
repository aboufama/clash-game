/**
 * Pure seed plumbing for generated, non-player world presentation.
 *
 * The server's mutable presentation epoch regenerates non-player land use,
 * wilderness archetypes, grass patterning, terrain, Great Lakes and rivers,
 * props, and ambient wildlife anchors. Player villages remain authoritative
 * overlays. Epoch zero deliberately reproduces the pre-reseed world exactly
 * so old saves do not change until a developer asks them to.
 */

const MAX_PRESENTATION_SEED_VERSION = 0xffff_ffff;
const PRESENTATION_STEP = 0x9e37_79b9;
const CHANNEL_STEP = 0x85eb_ca6b;

function mix32(value: number): number {
    let h = value >>> 0;
    h = Math.imul(h ^ (h >>> 16), 0x7feb352d);
    h = Math.imul(h ^ (h >>> 15), 0x846ca68b);
    return (h ^ (h >>> 16)) >>> 0;
}

function hashText(value: string): number {
    let h = 2166136261;
    for (let index = 0; index < value.length; index++) {
        h ^= value.charCodeAt(index);
        h = Math.imul(h, 16777619);
    }
    return h >>> 0;
}

function integerCoordinate(value: number): number {
    return Number.isFinite(value) ? Math.trunc(value) : 0;
}

function positiveModulo(value: number, modulus: number): number {
    return ((value % modulus) + modulus) % modulus;
}

export function normalizeWorldNatureSeedVersion(value: unknown): number {
    const numeric = Number(value);
    if (!Number.isSafeInteger(numeric) || numeric < 0) return 0;
    return Math.min(MAX_PRESENTATION_SEED_VERSION, numeric);
}

/**
 * Mix a presentation epoch into an existing deterministic seed. Keeping the
 * epoch-zero fast path is the compatibility contract for the shipped world.
 */
export function mixWorldNatureSeed(baseSeed: number, seedVersion: unknown, channel = 0): number {
    const base = baseSeed >>> 0;
    const version = normalizeWorldNatureSeedVersion(seedVersion);
    if (version === 0) return base;
    return mix32(
        base
        + Math.imul(version, PRESENTATION_STEP)
        + Math.imul(channel | 0, CHANNEL_STEP)
    );
}

/** One plot-local seed for rocks, trees, terrain depressions, and life. */
export function wildernessPlotPresentationSeed(plotX: number, plotY: number, seedVersion: unknown): number {
    const x = integerCoordinate(plotX);
    const y = integerCoordinate(plotY);
    const legacySeed = hashText(`wildplot:${x},${y}`);
    return mixWorldNatureSeed(legacySeed, seedVersion, 0x504c4f54); // "PLOT"
}

/** Spatial ecology keeps its low-frequency field, but gets a new world phase. */
export function wildernessEcologyPresentationSeed(
    legacySeed: number,
    seedVersion: unknown,
    channel: number
): number {
    return mixWorldNatureSeed(legacySeed, seedVersion, 0x45434f00 ^ channel); // "ECO"
}

/** Namespace the surface details of an already epoch-seeded water feature. */
export function worldHydrologyDecorationSeed(featureSeed: number, seedVersion: unknown): number {
    return mixWorldNatureSeed(featureSeed, seedVersion, 0x4c414b45); // "LAKE"
}

/** Shared seed for the continuous wilderness meadow pattern. */
export function wildernessGrassPresentationSeed(seedVersion: unknown): number {
    const version = normalizeWorldNatureSeedVersion(seedVersion);
    return version === 0 ? 0 : mixWorldNatureSeed(0x47524153, version, 0x47524153); // "GRAS"
}

export interface WildernessGrassPatternSample {
    readonly colorIndex: number;
    readonly bright: boolean;
    readonly detail: boolean;
    readonly detailOffsetX: number;
    readonly detailOffsetY: number;
}

/**
 * Sample one absolute wilderness tile. Because only absolute coordinates and
 * the shared epoch are inputs, adjoining plots and reclaimed road gaps remain
 * seamless even after their entire grass pattern changes.
 */
export function wildernessGrassPatternSample(
    worldTileX: number,
    worldTileY: number,
    seedVersion: unknown,
    paletteLength: number
): WildernessGrassPatternSample {
    const x = integerCoordinate(worldTileX);
    const y = integerCoordinate(worldTileY);
    const size = Math.max(1, Math.trunc(paletteLength) || 1);
    const seed = wildernessGrassPresentationSeed(seedVersion);
    if (seed === 0) {
        const phase = x * y;
        return {
            colorIndex: positiveModulo(x * 7 + y * 13, size),
            bright: positiveModulo(x + y, 2) === 0,
            detail: positiveModulo(x * 3 + y * 5, 7) === 0,
            detailOffsetX: Math.sin(phase) * 5,
            detailOffsetY: Math.cos(phase) * 3
        };
    }

    // Whole-world offsets preserve continuity while making consecutive
    // generations obviously different at the same camera coordinates.
    const offsetX = (seed & 0xff) - 128;
    const offsetY = ((seed >>> 8) & 0xff) - 128;
    const colorPhase = (seed >>> 16) & 0xff;
    const checkerPhase = (seed >>> 30) & 1;
    const detailPhase = (seed >>> 24) % 7;
    const wavePhase = (seed / 4294967296) * Math.PI * 2;
    return {
        colorIndex: positiveModulo((x + offsetX) * 7 + (y + offsetY) * 13 + colorPhase, size),
        bright: positiveModulo(x + y + checkerPhase, 2) === 0,
        detail: positiveModulo(x * 3 + y * 5 + detailPhase, 7) === 0,
        detailOffsetX: Math.sin((x + offsetX) * (y + offsetY) + wavePhase) * 5,
        detailOffsetY: Math.cos((x + offsetX) * (y + offsetY) + wavePhase) * 3
    };
}
