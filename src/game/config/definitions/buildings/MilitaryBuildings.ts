import type { BuildingDefinitionMap, BuildingLevelStats, MilitaryBuildingType } from '../BuildingTypes';

const barracksLevels = (): BuildingLevelStats[] => [
    { hp: 850, cost: 200 },
    { hp: 900, cost: 320 },
    { hp: 950, cost: 460 },
    { hp: 1000, cost: 620 },
    { hp: 1060, cost: 800 },
    { hp: 1120, cost: 1000 },
    { hp: 1200, cost: 1250 },
    { hp: 1280, cost: 1550 },
    // Both faction paths finish their seven troop unlocks at L7. L8-L9 are
    // shared structural Mastery tiers: stronger architecture, no more troops.
    { hp: 1380, cost: 1900 }
];

export const MILITARY_BUILDING_DEFINITIONS: BuildingDefinitionMap<MilitaryBuildingType> = {
    barracks: {
        id: 'barracks',
        name: 'Mechanica Barracks',
        cost: 200,
        desc: 'Unlocks the Mechanica and Steampunk troop tree as it levels up.',
        width: 2,
        height: 2,
        maxHealth: 850,
        category: 'military',
        maxCount: 1,
        color: 0xb66b32,
        // The troop path ends at L7; L8-L9 remain structural Mastery tiers.
        // Older over-level saves are explicitly normalized to this authored
        // cap during server hydration so runtime state and baked art agree.
        maxLevel: 9,
        levels: barracksLevels()
    },
    mystic_barracks: {
        id: 'mystic_barracks',
        name: 'Mystic Barracks',
        cost: 200,
        desc: 'Unlocks the Magic and Mystic troop tree as it levels up.',
        width: 2,
        height: 2,
        maxHealth: 850,
        category: 'military',
        maxCount: 1,
        color: 0x7859ad,
        maxLevel: 9,
        levels: barracksLevels()
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
        desc: 'Houses your army and unlocks Barbarian, Archer, Healer, and Phalanx across levels 1-4.',
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
