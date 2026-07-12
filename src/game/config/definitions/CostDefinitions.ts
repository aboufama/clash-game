import type { BuildingType } from './BuildingTypes';
import { TROOP_DEFINITIONS, type TroopType } from './TroopDefinitions';

/** Ore due when placing a building. Walls are bought in bulk and are exempt. */
export function buildOreCostOf(type: BuildingType, goldCost: number): number {
    if (type === 'wall') return 0;
    return Math.round(goldCost * 0.1);
}

/** Ore due when upgrading a building. */
export function upgradeOreCostOf(goldCost: number): number {
    return Math.round(goldCost * 0.2);
}

/** Food due to train a troop. */
export function troopFoodCostOf(type: TroopType): number {
    const def = TROOP_DEFINITIONS[type];
    return (def?.space ?? 1) * 2;
}
