import type { BuildingDefinitionMap, MilitaryBuildingType } from '../BuildingTypes';

export const MILITARY_BUILDING_DEFINITIONS: BuildingDefinitionMap<MilitaryBuildingType> = {
    barracks: {
        id: 'barracks',
        name: 'Barracks',
        cost: 200,
        desc: 'Unlocks new troop types as it levels up.',
        width: 2,
        height: 2,
        maxHealth: 850,
        category: 'military',
        maxCount: 1,
        color: 0xff3333,
        maxLevel: 14,
        levels: [
            { hp: 850, cost: 200 },
            { hp: 900, cost: 320 },
            { hp: 950, cost: 460 },
            { hp: 1000, cost: 620 },
            { hp: 1060, cost: 800 },
            { hp: 1120, cost: 1000 },
            { hp: 1200, cost: 1250 },
            { hp: 1280, cost: 1550 },
            { hp: 1380, cost: 1900 },
            { hp: 1480, cost: 2300 },
            { hp: 1600, cost: 2800 },
            { hp: 1750, cost: 3400 },
            { hp: 1900, cost: 4000 },
            // L14 added with the icegolem unlock (slotted after golem, pushing
            // davincitank to 14). Art reuses the max L13 bake/vector tier —
            // both SpriteBank and drawBarracks clamp to the nearest baked level.
            { hp: 2050, cost: 4700 }
        ]
    },
    lab: {
        id: 'lab',
        name: 'Lab',
        cost: 500,
        desc: 'Researches troop upgrades. Higher levels boost all troop stats.',
        width: 2,
        height: 2,
        maxHealth: 900,
        category: 'military',
        maxCount: 1,
        color: 0x6644aa,
        maxLevel: 3,
        levels: [
            { hp: 900, cost: 500 },
            { hp: 1200, cost: 1200 },
            { hp: 1500, cost: 2400 }
        ]
    },
    army_camp: {
        id: 'army_camp',
        name: 'Army Camp',
        cost: 300,
        desc: 'Houses your army.',
        width: 3,
        height: 3,
        maxHealth: 1000,
        category: 'military',
        maxCount: 4,
        color: 0x884422,
        maxLevel: 4,
        capacity: 20,
        levels: [
            { hp: 1000, capacity: 20, cost: 300 },
            { hp: 1200, capacity: 25, cost: 500 },
            { hp: 1400, capacity: 30, cost: 700 },
            { hp: 1600, capacity: 35, cost: 1000 }
        ]
    }
};
