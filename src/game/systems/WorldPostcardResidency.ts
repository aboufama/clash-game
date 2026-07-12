/**
 * GPU residency policy for exact, full-resolution village postcards.
 *
 * A village snapshot is 1,600 x 890 RGBA pixels. The authoritative world
 * metadata is cheap enough to retain for the whole earned map window; the
 * expensive part is keeping every snapshot's GPU texture resident while it
 * is many screens away. This module deliberately knows nothing about Phaser
 * so the lifecycle policy and its memory budget stay regression-testable.
 */

export const PLAYER_POSTCARD_WIDTH = 1_600;
export const PLAYER_POSTCARD_HEIGHT = 890;
export const PLAYER_POSTCARD_SCALE = 1;
export const RGBA_BYTES_PER_PIXEL = 4;
export const PLAYER_POSTCARD_RGBA_BYTES =
    PLAYER_POSTCARD_WIDTH * PLAYER_POSTCARD_HEIGHT * RGBA_BYTES_PER_PIXEL;

/** Ring one is the active 3x3 neighborhood and is never evicted. */
export const ALWAYS_RESIDENT_RING = 1;
/** Start materializing before the postcard reaches the camera. */
export const POSTCARD_PREFETCH_PX = 256;
/** Avoid texture churn when the camera rocks around a residency boundary. */
export const POSTCARD_EVICTION_GRACE_MS = 3_000;

export interface ScreenRect {
    x: number;
    y: number;
    width: number;
    height: number;
}

export interface PostcardResidencyInput {
    dx: number;
    dy: number;
    camera: ScreenRect;
    now: number;
    lastInterestedAt: number;
    resident: boolean;
}

export interface PostcardResidencyDecision {
    required: boolean;
    visible: boolean;
    prefetched: boolean;
    interested: boolean;
    nextLastInterestedAt: number;
    materialize: boolean;
    evict: boolean;
}

/** Exact full-resolution capture rectangle used by WorldMapSystem. */
export function playerPostcardBounds(dx: number, dy: number): ScreenRect {
    const plotOffsetX = dx * 27;
    const plotOffsetY = dy * 27;
    const topX = (plotOffsetX - plotOffsetY) * 32;
    const topY = (plotOffsetX + plotOffsetY) * 16;
    return {
        x: topX - PLAYER_POSTCARD_WIDTH / 2,
        y: topY - 90,
        width: PLAYER_POSTCARD_WIDTH,
        height: PLAYER_POSTCARD_HEIGHT
    };
}

export function expandRect(rect: ScreenRect, padding: number): ScreenRect {
    const p = Math.max(0, padding);
    return {
        x: rect.x - p,
        y: rect.y - p,
        width: rect.width + p * 2,
        height: rect.height + p * 2
    };
}

export function rectsIntersect(a: ScreenRect, b: ScreenRect): boolean {
    return a.x < b.x + b.width
        && a.x + a.width > b.x
        && a.y < b.y + b.height
        && a.y + a.height > b.y;
}

export function decidePostcardResidency(input: PostcardResidencyInput): PostcardResidencyDecision {
    const ring = Math.max(Math.abs(input.dx), Math.abs(input.dy));
    const bounds = playerPostcardBounds(input.dx, input.dy);
    const visible = rectsIntersect(bounds, input.camera);
    const prefetched = visible || rectsIntersect(bounds, expandRect(input.camera, POSTCARD_PREFETCH_PX));
    const required = ring <= ALWAYS_RESIDENT_RING;
    const interested = required || prefetched;
    const nextLastInterestedAt = interested ? input.now : input.lastInterestedAt;
    const materialize = !input.resident && interested;
    const evict = input.resident
        && !required
        && !prefetched
        && input.now - input.lastInterestedAt >= POSTCARD_EVICTION_GRACE_MS;
    return { required, visible, prefetched, interested, nextLastInterestedAt, materialize, evict };
}

export function estimateVillageTextureBytes(residentCount: number): number {
    return Math.max(0, Math.floor(residentCount)) * PLAYER_POSTCARD_RGBA_BYTES;
}
