import type { TroopType } from '../config/GameDefinitions';

/**
 * Presentation-only world scale for troops whose authored silhouette needs
 * more presence than its gameplay footprint. This must never feed combat,
 * pathing, targeting, range, or collision math.
 *
 * The vector authoring/bake surface stays at scale 1. Runtime vector wrappers
 * and SpriteBank shadow stamps both consume this table, so a future re-bake
 * cannot accidentally apply the multiplier twice.
 */
export const TROOP_WORLD_VISUAL_SCALE = {
    warelephant: 1.5,
    ornithopter: 1.2,
} as const satisfies Readonly<Partial<Record<TroopType, number>>>;

/** Exact runtime multiplier; unlisted troops retain their authored size. */
export function troopWorldVisualScale(type: string): number {
    return (TROOP_WORLD_VISUAL_SCALE as Readonly<Record<string, number>>)[type] ?? 1;
}
