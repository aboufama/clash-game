import type { BuildingDefinitionMap, UtilityBuildingType } from '../BuildingTypes';

export const UTILITY_BUILDING_DEFINITIONS: BuildingDefinitionMap<UtilityBuildingType> = {
    town_hall: {
        id: 'town_hall',
        name: 'Town Hall',
        cost: 500,
        desc: 'The heart of your village.',
        width: 3,
        height: 3,
        maxHealth: 2000,
        category: 'other',
        maxCount: 1,
        color: 0x3366ff,
        maxLevel: 1,
        capacity: 30
    },
    jukebox: {
        id: 'jukebox',
        name: 'Jukebox',
        cost: 600,
        desc: 'Plays your collected tracks. Rare tunes are out there to find.',
        width: 1,
        height: 1,
        maxHealth: 450,
        category: 'other',
        maxCount: 1,
        color: 0x9a5abe,
        maxLevel: 1
    },
    watchtower: {
        id: 'watchtower',
        name: 'Watchtower',
        cost: 650,
        desc: 'The watch is your only eyes on the world: without it you see nothing past your own fences. Level 1 opens the neighbourhood (3x3), level 2 the whole horizon (5x5).',
        width: 2,
        height: 2,
        maxHealth: 900,
        category: 'other',
        maxCount: 1,
        color: 0x8a6a42,
        maxLevel: 2,
        levels: [
            { hp: 900, cost: 650 },
            { hp: 1200, cost: 1500 }
        ]
    }
};
