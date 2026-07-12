import type { BuildingDefinitionMap, ResourceBuildingType } from '../BuildingTypes';

export const RESOURCE_BUILDING_DEFINITIONS: BuildingDefinitionMap<ResourceBuildingType> = {
    mine: {
        id: 'mine',
        name: 'Ore Mine',
        cost: 350,
        desc: 'Miners dig ore here around the clock. Ore pays for upgrades.',
        width: 2,
        height: 2,
        maxHealth: 700,
        category: 'resource',
        maxCount: 3,
        color: 0x8a8d94,
        maxLevel: 3,
        produces: 'ore',
        levels: [
            { hp: 700, cost: 350, productionRate: 0.05 },
            { hp: 850, cost: 900, productionRate: 0.09 },
            { hp: 1000, cost: 1800, productionRate: 0.14 }
        ]
    },
    farm: {
        id: 'farm',
        name: 'Farm',
        cost: 300,
        desc: 'Grows food to feed your growing population.',
        width: 3,
        height: 2,
        maxHealth: 650,
        category: 'resource',
        maxCount: 3,
        color: 0xd8a83e,
        maxLevel: 3,
        produces: 'food',
        levels: [
            { hp: 650, cost: 300, productionRate: 0.07 },
            { hp: 800, cost: 800, productionRate: 0.12 },
            { hp: 950, cost: 1600, productionRate: 0.18 }
        ]
    },
    storage: {
        id: 'storage',
        name: 'Storehouse',
        cost: 400,
        desc: 'Raises how much ore AND food your village can keep.',
        width: 2,
        height: 2,
        maxHealth: 1100,
        category: 'resource',
        maxCount: 4,
        color: 0xa07444,
        maxLevel: 3,
        levels: [
            { hp: 1100, cost: 400, storageCapacity: 250 },
            { hp: 1400, cost: 1000, storageCapacity: 550 },
            { hp: 1700, cost: 2000, storageCapacity: 1000 }
        ]
    }
};
