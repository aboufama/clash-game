import type { BuildingType } from '../config/definitions/BuildingTypes';

/**
 * Renderer routes are deliberately independent from building ids. A future
 * catalog entry may opt into the generic renderer with an explicit reason,
 * or several building types may share one dedicated visual implementation.
 */
export const DEDICATED_BUILDING_VISUAL_ROUTES = [
    'townHall',
    'barracks',
    'cannon',
    'ballista',
    'mortar',
    'tesla',
    'wall',
    'armyCamp',
    'xbow',
    'prism',
    'frostfall',
    'dragonsBreath',
    'spikeLauncher',
    'jukebox',
    'mine',
    'farm',
    'storage',
    'lab',
    'watchtower'
] as const;

export type DedicatedBuildingVisualRoute = typeof DEDICATED_BUILDING_VISUAL_ROUTES[number];

export type BuildingVisualDescriptor =
    | { route: DedicatedBuildingVisualRoute }
    | { route: 'generic'; reason: string };

/**
 * Exhaustive visual policy for the building definition catalog. Keeping this
 * pure (no Phaser import) makes catalog drift cheap to test in Node.
 */
export const BUILDING_VISUAL_CATALOG = {
    town_hall: { route: 'townHall' },
    mine: { route: 'mine' },
    farm: { route: 'farm' },
    jukebox: { route: 'jukebox' },
    storage: { route: 'storage' },
    barracks: { route: 'barracks' },
    lab: { route: 'lab' },
    cannon: { route: 'cannon' },
    ballista: { route: 'ballista' },
    xbow: { route: 'xbow' },
    mortar: { route: 'mortar' },
    tesla: { route: 'tesla' },
    wall: { route: 'wall' },
    army_camp: { route: 'armyCamp' },
    prism: { route: 'prism' },
    dragons_breath: { route: 'dragonsBreath' },
    spike_launcher: { route: 'spikeLauncher' },
    watchtower: { route: 'watchtower' },
    frostfall: { route: 'frostfall' }
} as const satisfies Record<BuildingType, BuildingVisualDescriptor>;

export function buildingVisualDescriptor(type: BuildingType): BuildingVisualDescriptor {
    return BUILDING_VISUAL_CATALOG[type];
}
