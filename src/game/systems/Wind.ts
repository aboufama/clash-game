/**
 * One wind for the whole village.
 *
 * Everything that sways — flags, banners, crops, chimney smoke, drifting
 * clouds — samples this single traveling wave instead of free-running its own
 * phase. The payoff is CORRELATED motion: a gust visibly rolls across the map
 * from the north-west, flags snap one after another, the wheat bows in
 * sequence and the smoke bends with it, so the whole scene reads as one
 * weather system instead of a collection of independent loops.
 *
 * Deterministic in (position, time): no state, no per-frame random (house
 * rule — random flickers strobe). Gusts travel along the prevailing wind
 * direction at a stately walking pace.
 */

/** Prevailing wind direction in grid space (unit vector, roughly W→E, N→S). */
export const WIND_DIR = { x: 0.83, y: 0.55 };

/**
 * Weather multiplier on the oscillating part of the wind (storms lean on it).
 * The base level stays put so smoke/flags keep their resting pose; only the
 * gust amplitude grows — flags snap harder, crops whip, smoke tears sideways.
 */
let gustBoost = 1;

export function setWindBoost(multiplier: number) {
    gustBoost = Math.max(0.5, Math.min(2.5, multiplier));
}

/**
 * Wind strength at a grid point, ~[-0.1 .. 1.0].
 * A slow rolling gust front, a secondary ripple and a fine flutter.
 */
export function windAt(gridX: number, gridY: number, time: number): number {
    const along = gridX * WIND_DIR.x + gridY * WIND_DIR.y;
    const t = time * 0.001;
    const gust = Math.sin(along * 0.55 - t * 1.15);
    const ripple = Math.sin(along * 1.7 - t * 2.3 + 1.3);
    const flutter = Math.sin(along * 3.1 - t * 4.7 + 2.1);
    return 0.45 + (0.35 * gust + 0.14 * ripple + 0.06 * flutter) * gustBoost;
}

/** Signed sway (-1..1) for oscillating things (flags, crops, wings). */
export function windSway(gridX: number, gridY: number, time: number): number {
    return (windAt(gridX, gridY, time) - 0.45) / 0.55;
}

/** Same, addressed by isometric screen coordinates (renderers have those). */
export function windSwayAtScreen(screenX: number, screenY: number, time: number): number {
    const gx = screenX / 64 + screenY / 32;
    const gy = screenY / 32 - screenX / 64;
    return windSway(gx, gy, time);
}

/** Wind strength (~0..1) by screen coordinates — smoke lean, particle drift. */
export function windAtScreen(screenX: number, screenY: number, time: number): number {
    const gx = screenX / 64 + screenY / 32;
    const gy = screenY / 32 - screenX / 64;
    return windAt(gx, gy, time);
}

/**
 * Closed-loop analog of windAt for BAKEABLE ambient art (building draw fns
 * whose idle pose gets baked into sprite frames).
 *
 * The live wind's three time rates (1.15 / 2.3 / 4.7 rad·s⁻¹) never
 * co-repeat, so a baked idle loop sampling windAt can never close — the
 * sprite pops at the loop seam. This variant keeps the same traveling-wave
 * structure and spatial phases but retimes the rates to exact 1×/2×/4×
 * harmonics of `periodMs` (the caller's declared idle period, a 250 ms
 * multiple): every sample repeats exactly once per loop, so the bake probe
 * measures a true period. gustBoost is deliberately NOT applied — bakeable
 * art captures calm weather (the bake harness pins boost anyway).
 */
export function windLoop(gridX: number, gridY: number, time: number, periodMs: number): number {
    const along = gridX * WIND_DIR.x + gridY * WIND_DIR.y;
    const w = (Math.PI * 2) / periodMs;
    const gust = Math.sin(along * 0.55 - time * w);
    const ripple = Math.sin(along * 1.7 - time * w * 2 + 1.3);
    const flutter = Math.sin(along * 3.1 - time * w * 4 + 2.1);
    return 0.45 + 0.35 * gust + 0.14 * ripple + 0.06 * flutter;
}

/** Signed closed-loop sway (-1..1) — bakeable flags, banners, crops. */
export function windSwayLoop(gridX: number, gridY: number, time: number, periodMs: number): number {
    return (windLoop(gridX, gridY, time, periodMs) - 0.45) / 0.55;
}

/** windSwayLoop addressed by isometric screen coordinates. */
export function windSwayLoopAtScreen(screenX: number, screenY: number, time: number, periodMs: number): number {
    const gx = screenX / 64 + screenY / 32;
    const gy = screenY / 32 - screenX / 64;
    return windSwayLoop(gx, gy, time, periodMs);
}

/** windLoop addressed by isometric screen coordinates. */
export function windLoopAtScreen(screenX: number, screenY: number, time: number, periodMs: number): number {
    const gx = screenX / 64 + screenY / 32;
    const gy = screenY / 32 - screenX / 64;
    return windLoop(gx, gy, time, periodMs);
}
