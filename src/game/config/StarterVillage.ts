import type { BuildingType } from './definitions/BuildingTypes';

/**
 * Phaser-free tuning for every newly-created player village.
 *
 * Keep the complete initial layout and wallet together so the legacy JSON
 * runtime and the normalized persistence runtime cannot drift apart.
 */
export interface StarterBuildingPlacement {
    readonly type: BuildingType;
    readonly gridX: number;
    readonly gridY: number;
    readonly level: number;
}

export interface StarterVillageConfig {
    readonly buildings: readonly StarterBuildingPlacement[];
    readonly resources: Readonly<{
        gold: number;
        ore: number;
        food: number;
    }>;
    readonly wallLevel: number;
}

export const STARTER_VILLAGE: StarterVillageConfig = {
    buildings: [
        { type: 'town_hall', gridX: 11, gridY: 11, level: 1 },
        { type: 'army_camp', gridX: 11, gridY: 15, level: 1 },
        { type: 'mine', gridX: 8, gridY: 11, level: 1 }
    ],
    resources: {
        gold: 2_000,
        ore: 100,
        food: 100
    },
    wallLevel: 1
};

/** Materialize mutable per-player state from the shared tuning template. */
export function createStarterVillage(buildingId: () => string) {
    return {
        buildings: STARTER_VILLAGE.buildings.map(building => ({
            id: buildingId(),
            ...building
        })),
        obstacles: [],
        army: {} as Record<string, number>,
        wallLevel: STARTER_VILLAGE.wallLevel,
        resources: { ...STARTER_VILLAGE.resources }
    };
}
