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
        { type: 'mine', gridX: 8, gridY: 11, level: 1 },
        { type: 'farm', gridX: 15, gridY: 10, level: 1 },
        { type: 'barracks', gridX: 7, gridY: 15, level: 1 },
        { type: 'mystic_barracks', gridX: 16, gridY: 15, level: 1 },
        { type: 'army_camp', gridX: 11, gridY: 16, level: 1 }
    ],
    resources: {
        gold: 100_000,
        ore: 100_000,
        food: 100_000
    },
    wallLevel: 1
};

/** Return a detached configuration snapshot safe to persist or hand to editors. */
export function copyStarterVillageConfig(config: StarterVillageConfig = STARTER_VILLAGE): StarterVillageConfig {
    return {
        buildings: config.buildings.map(building => ({ ...building })),
        resources: { ...config.resources },
        wallLevel: config.wallLevel
    };
}

/** Materialize mutable per-player state from the shared tuning template. */
export function createStarterVillage(
    buildingId: () => string,
    config: StarterVillageConfig = STARTER_VILLAGE
) {
    return {
        buildings: config.buildings.map(building => ({
            id: buildingId(),
            ...building
        })),
        obstacles: [],
        army: {} as Record<string, number>,
        wallLevel: config.wallLevel,
        resources: { ...config.resources }
    };
}
