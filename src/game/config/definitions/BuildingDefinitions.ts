import type { BuildingDef, BuildingType } from './BuildingTypes';
import { DEFENSE_BUILDING_DEFINITIONS } from './buildings/DefenseBuildings';
import { MILITARY_BUILDING_DEFINITIONS } from './buildings/MilitaryBuildings';
import { RESOURCE_BUILDING_DEFINITIONS } from './buildings/ResourceBuildings';
import { UTILITY_BUILDING_DEFINITIONS } from './buildings/UtilityBuildings';

/**
 * Complete building catalog. The explicit composition preserves the historic
 * insertion order used by shop and debug views while keeping domain data in
 * focused modules.
 */
export const BUILDING_DEFINITIONS: Record<BuildingType, BuildingDef> = {
    town_hall: UTILITY_BUILDING_DEFINITIONS.town_hall,
    mine: RESOURCE_BUILDING_DEFINITIONS.mine,
    farm: RESOURCE_BUILDING_DEFINITIONS.farm,
    jukebox: UTILITY_BUILDING_DEFINITIONS.jukebox,
    storage: RESOURCE_BUILDING_DEFINITIONS.storage,
    barracks: MILITARY_BUILDING_DEFINITIONS.barracks,
    mystic_barracks: MILITARY_BUILDING_DEFINITIONS.mystic_barracks,
    lab: MILITARY_BUILDING_DEFINITIONS.lab,
    cannon: DEFENSE_BUILDING_DEFINITIONS.cannon,
    ballista: DEFENSE_BUILDING_DEFINITIONS.ballista,
    xbow: DEFENSE_BUILDING_DEFINITIONS.xbow,
    mortar: DEFENSE_BUILDING_DEFINITIONS.mortar,
    tesla: DEFENSE_BUILDING_DEFINITIONS.tesla,
    wall: DEFENSE_BUILDING_DEFINITIONS.wall,
    army_camp: MILITARY_BUILDING_DEFINITIONS.army_camp,
    prism: DEFENSE_BUILDING_DEFINITIONS.prism,
    dragons_breath: DEFENSE_BUILDING_DEFINITIONS.dragons_breath,
    spike_launcher: DEFENSE_BUILDING_DEFINITIONS.spike_launcher,
    watchtower: UTILITY_BUILDING_DEFINITIONS.watchtower
};

// Stats are pure functions of (type, level) and are requested per entity per
// frame in combat loops. Callers must treat cached results as read-only.
const buildingStatsCache = new Map<string, BuildingDef>();

export function getBuildingStats(type: BuildingType, level: number = 1): BuildingDef {
    const cacheKey = `${type}:${level}`;
    const cached = buildingStatsCache.get(cacheKey);
    if (cached) return cached;

    const base = BUILDING_DEFINITIONS[type];
    if (!base) {
        // Legacy save data or version skew should render a harmless block
        // instead of crashing the client during a rolling deployment.
        const fallback = {
            id: type,
            name: String(type),
            cost: 0,
            desc: '',
            width: 1,
            height: 1,
            maxHealth: 100,
            category: 'other',
            maxCount: 0,
            color: 0x888888,
            maxLevel: 1
        } as unknown as BuildingDef;
        buildingStatsCache.set(cacheKey, fallback);
        return fallback;
    }

    const levelStats = base.levels ? base.levels[level - 1] : null;
    const stats = !levelStats ? { ...base } : {
        ...base,
        maxHealth: levelStats.hp,
        damage: levelStats.damage ?? base.damage,
        fireRate: levelStats.fireRate ?? base.fireRate,
        productionRate: levelStats.productionRate ?? base.productionRate,
        capacity: levelStats.capacity ?? base.capacity,
        range: levelStats.range ?? base.range,
        cost: levelStats.cost
    };
    buildingStatsCache.set(cacheKey, stats);
    return stats;
}
