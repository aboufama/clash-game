export type ObstacleType =
    | 'rock_small'
    | 'rock_large'
    | 'tree_oak'
    | 'tree_pine'
    | 'grass_patch';

export interface ObstacleDef {
    id: ObstacleType;
    name: string;
    clearCost: number;
    clearTime: number;
    width: number;
    height: number;
    goldReward: number;
}

export const OBSTACLE_DEFINITIONS: Record<ObstacleType, ObstacleDef> = {
    rock_small: { id: 'rock_small', name: 'Small Rock', clearCost: 50, clearTime: 5, width: 1, height: 1, goldReward: 10 },
    rock_large: { id: 'rock_large', name: 'Large Rock', clearCost: 150, clearTime: 15, width: 2, height: 2, goldReward: 50 },
    tree_oak: { id: 'tree_oak', name: 'Oak Tree', clearCost: 100, clearTime: 10, width: 2, height: 2, goldReward: 30 },
    tree_pine: { id: 'tree_pine', name: 'Pine Tree', clearCost: 75, clearTime: 8, width: 1, height: 1, goldReward: 20 },
    grass_patch: { id: 'grass_patch', name: 'Tall Grass', clearCost: 25, clearTime: 3, width: 1, height: 1, goldReward: 5 }
};
