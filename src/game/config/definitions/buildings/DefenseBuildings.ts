import type { BuildingDefinitionMap, DefenseBuildingType } from '../BuildingTypes';

export const DEFENSE_BUILDING_DEFINITIONS: BuildingDefinitionMap<DefenseBuildingType> = {
    cannon: {
        id: 'cannon',
        name: 'Cannon',
        cost: 220,
        desc: 'Point defense against ground.',
        width: 1,
        height: 1,
        maxHealth: 820,
        range: 7,
        category: 'defense',
        maxCount: 5,
        color: 0x333333,
        fireRate: 2400,
        damage: 58,
        maxLevel: 4,
        levels: [
            { hp: 820, damage: 58, fireRate: 2400, cost: 220 },
            { hp: 940, damage: 70, fireRate: 2200, cost: 360 },
            { hp: 1040, damage: 82, fireRate: 2050, cost: 520 },
            { hp: 1150, damage: 95, fireRate: 1900, cost: 700 }
        ]
    },
    ballista: {
        id: 'ballista',
        name: 'Ballista',
        cost: 360,
        desc: 'Heavy single-target damage.',
        width: 2,
        height: 2,
        maxHealth: 950,
        range: 9,
        category: 'defense',
        maxCount: 2,
        color: 0x8b4513,
        fireRate: 1900,
        damage: 185,
        maxLevel: 3,
        levels: [
            { hp: 950, damage: 185, fireRate: 1900, cost: 360 },
            { hp: 1150, damage: 230, fireRate: 1700, cost: 620 },
            { hp: 1400, damage: 280, fireRate: 1550, cost: 950 }
        ]
    },
    xbow: {
        id: 'xbow',
        name: 'X-Bow',
        cost: 900,
        desc: 'Rapid fire long-range turret.',
        width: 2,
        height: 2,
        maxHealth: 1550,
        range: 11,
        category: 'defense',
        maxCount: 3,
        color: 0x8b008b,
        fireRate: 220,
        damage: 20,
        maxLevel: 3,
        levels: [
            { hp: 1550, damage: 20, fireRate: 220, cost: 900 },
            { hp: 1850, damage: 26, fireRate: 190, cost: 1350 },
            { hp: 2200, damage: 32, fireRate: 165, cost: 1900 }
        ]
    },
    mortar: {
        id: 'mortar',
        name: 'Mortar',
        cost: 500,
        desc: 'Splash damage area shell.',
        width: 2,
        height: 2,
        maxHealth: 760,
        range: 10,
        minRange: 3,
        category: 'defense',
        maxCount: 3,
        color: 0x555555,
        fireRate: 3900,
        damage: 62,
        maxLevel: 4,
        levels: [
            { hp: 760, damage: 62, fireRate: 3900, cost: 500 },
            { hp: 930, damage: 78, fireRate: 3500, cost: 780 },
            { hp: 1150, damage: 95, fireRate: 3150, cost: 1100 },
            { hp: 1400, damage: 115, fireRate: 2850, cost: 1550 }
        ]
    },
    tesla: {
        id: 'tesla',
        name: 'Tesla Coil',
        cost: 650,
        desc: 'Hidden zapping trap.',
        width: 1,
        height: 1,
        maxHealth: 700,
        range: 6,
        category: 'defense',
        maxCount: 3,
        color: 0x00ccff,
        fireRate: 2400,
        damage: 52,
        maxLevel: 3,
        levels: [
            { hp: 700, damage: 52, fireRate: 2400, cost: 650 },
            { hp: 900, damage: 68, fireRate: 2100, cost: 980 },
            { hp: 1150, damage: 85, fireRate: 1850, cost: 1400 }
        ]
    },
    wall: {
        id: 'wall',
        name: 'Wall',
        cost: 50,
        desc: 'Stops enemies cold.',
        width: 1,
        height: 1,
        maxHealth: 500,
        category: 'defense',
        maxCount: 100,
        color: 0xcccccc,
        maxLevel: 4,
        levels: [
            { hp: 500, cost: 50 },
            { hp: 800, cost: 150 },
            { hp: 1200, cost: 350 },
            { hp: 1700, cost: 600 }
        ]
    },
    prism: {
        id: 'prism',
        name: 'Prism Tower',
        cost: 1050,
        desc: 'Continuous beam that melts clustered enemies.',
        width: 1,
        height: 1,
        maxHealth: 1200,
        range: 8.5,
        category: 'defense',
        maxCount: 1,
        color: 0xff00ff,
        fireRate: 100,
        damage: 156,
        maxLevel: 4,
        levels: [
            { hp: 1200, damage: 156, fireRate: 100, cost: 1050, range: 8.5 },
            { hp: 1450, damage: 204, fireRate: 90, cost: 1450, range: 9.0 },
            { hp: 1750, damage: 264, fireRate: 75, cost: 2100, range: 9.5 },
            { hp: 2100, damage: 330, fireRate: 65, cost: 3000, range: 10.0 }
        ]
    },
    dragons_breath: {
        id: 'dragons_breath',
        name: "Dragon's Breath",
        cost: 2200,
        desc: '16 firecracker pods rain destruction on foes.',
        width: 4,
        height: 4,
        maxHealth: 2800,
        range: 13.5,
        category: 'defense',
        maxCount: 1,
        color: 0xcc0000,
        fireRate: 2800,
        damage: 34,
        maxLevel: 2,
        levels: [
            { hp: 2800, damage: 34, fireRate: 2800, cost: 2200, range: 13.5 },
            { hp: 3500, damage: 45, fireRate: 2400, cost: 3200, range: 14.0 }
        ]
    },
    spike_launcher: {
        id: 'spike_launcher',
        name: 'Spike Launcher',
        cost: 1450,
        desc: 'Trebuchet hurls spike bags that damage areas.',
        width: 2,
        height: 2,
        maxHealth: 1200,
        range: 9.5,
        minRange: 3,
        category: 'defense',
        maxCount: 2,
        color: 0x8b6914,
        fireRate: 4200,
        damage: 38,
        maxLevel: 4,
        levels: [
            { hp: 1200, damage: 38, fireRate: 4200, cost: 1450, range: 9.5 },
            { hp: 1450, damage: 52, fireRate: 3800, cost: 1950, range: 10.0 },
            { hp: 1800, damage: 70, fireRate: 3400, cost: 2800, range: 10.5 },
            { hp: 2200, damage: 90, fireRate: 3000, cost: 3800, range: 11.0 }
        ]
    },
    frostfall: {
        id: 'frostfall',
        name: 'Frostfall Monolith',
        cost: 1200,
        desc: 'An ancient ice well tended by a Frost Keeper who cranks up devastating ice crystals from the frozen depths.',
        width: 2,
        height: 2,
        maxHealth: 1050,
        range: 6.0,
        category: 'defense',
        maxCount: 2,
        color: 0x88ccff,
        fireRate: 5000,
        damage: 15,
        maxLevel: 4,
        levels: [
            { hp: 1050, damage: 15, fireRate: 5000, cost: 1200, range: 6.0 },
            { hp: 1300, damage: 25, fireRate: 4800, cost: 1800, range: 6.5 },
            { hp: 1650, damage: 38, fireRate: 4600, cost: 2600, range: 7.0 },
            { hp: 2050, damage: 52, fireRate: 4400, cost: 3800, range: 7.5 }
        ]
    }
};
