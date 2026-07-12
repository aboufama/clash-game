export type UtilityBuildingType = 'town_hall' | 'jukebox' | 'watchtower';

export type ResourceBuildingType = 'mine' | 'farm' | 'storage';

export type MilitaryBuildingType = 'barracks' | 'lab' | 'army_camp';

export type DefenseBuildingType =
    | 'cannon'
    | 'ballista'
    | 'xbow'
    | 'mortar'
    | 'tesla'
    | 'wall'
    | 'prism'
    | 'dragons_breath'
    | 'spike_launcher'
    | 'frostfall';

export type BuildingType =
    | UtilityBuildingType
    | ResourceBuildingType
    | MilitaryBuildingType
    | DefenseBuildingType;

export interface BuildingLevelStats {
    hp: number;
    damage?: number;
    fireRate?: number;
    productionRate?: number;
    capacity?: number;
    range?: number;
    cost: number;
    /** Extra ore AND food cap this level of a storage provides. */
    storageCapacity?: number;
}

export interface BuildingDef {
    id: BuildingType;
    name: string;
    cost: number;
    desc: string;
    width: number;
    height: number;
    maxHealth: number;
    range?: number;
    minRange?: number;
    category?: 'defense' | 'resource' | 'army' | 'other' | 'military';
    maxCount: number;
    color?: number;
    fireRate?: number;
    damage?: number;
    productionRate?: number;
    /** Which stock productionRate feeds (mine -> ore, farm -> food). */
    produces?: 'ore' | 'food';
    capacity?: number;
    /** Extra ore AND food cap a storage provides (per level via levels[]). */
    storageCapacity?: number;
    maxLevel?: number;
    /** Level 1 is stored at index 0. */
    levels?: BuildingLevelStats[];
}

export type BuildingDefinitionMap<T extends BuildingType> = Record<T, BuildingDef>;
