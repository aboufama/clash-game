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

    if (originX < 0 || originX > 1) {
        throw new RangeError(`${label}.originX must be between 0 and 1`);
    }
    if (originY < 0 || originY > 1) {
        throw new RangeError(`${label}.originY must be between 0 and 1`);
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
    applyTextureSampling(target.texture, TextureSampling.PIXEL_ART);
    target.setOrigin(placement.originX, placement.originY);
    target.setScale(placement.cellWorldPx);
    return target;
}
