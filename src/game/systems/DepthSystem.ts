import { BUILDING_DEFINITIONS, TROOP_DEFINITIONS, type BuildingType, type TroopType } from '../config/GameDefinitions';

const DEPTH_BASE = 1000;
const DEPTH_STEP = 100;
const DEPTH_TIE = 1;
const MAX_BIAS = Math.floor(DEPTH_STEP * 0.4);
const GROUND_PLANE_DEPTH = 0;

const BUILDING_BIAS_SCALE = 2;
const TROOP_BIAS_SCALE = 1;
const OBSTACLE_BIAS_SCALE = 1;
// Keep the tall roof lifted without crossing an entire isometric row: a wall
// one row in front must still win the painter's-order comparison.
const BARRACKS_DEPTH_OFFSET = DEPTH_STEP - 1;

const LAYER_OFFSETS = {
    obstacle: 2,
    rubble: 3,
    building: 6,
    wall: 10,  // Walls slightly above buildings for tie-breaking
    troop: 15  // Troops above walls
};

const baseDepth = (anchorX: number, anchorY: number) =>
    DEPTH_BASE + (anchorX + anchorY) * DEPTH_STEP + (anchorX - anchorY) * DEPTH_TIE;

const clampBias = (bias: number) => Math.max(-MAX_BIAS, Math.min(MAX_BIAS, bias));

/**
 * Calculate depth for a footprint.
 * For proper isometric sorting, we use the BACK corner (top-left in grid coords)
 * plus a small forward offset. This ensures:
 * - Objects render behind things at their front edge
 * - Walls at a building's front correctly render above the building
 */
export const depthForFootprint = (
    gridX: number,
    gridY: number,
    width: number,
    height: number,
    layerOffset: number,
    bias: number = 0
) => {
    // Use back corner (gridX, gridY) plus half the footprint for center-ish anchor
    // This prevents large buildings from "reaching forward" in depth
    const anchorX = gridX + Math.floor((width - 1) / 2);
    const anchorY = gridY + Math.floor((height - 1) / 2);
    return baseDepth(anchorX, anchorY) + layerOffset + clampBias(bias);
};

export const depthForGroundPlane = () => GROUND_PLANE_DEPTH;

const buildingBias = (type: BuildingType) => {
    const def = BUILDING_DEFINITIONS[type];
    if (!def) return 0; // unknown type: neutral bias, never a crash
    // Larger buildings get positive bias to push them slightly forward
    // This helps their front edges not get clipped by things behind
    return clampBias(Math.max(def.width, def.height) * BUILDING_BIAS_SCALE);
};

const troopBias = (type: TroopType) => {
    const def = TROOP_DEFINITIONS[type];
    if (!def) return 0;
    return clampBias(Math.max(1, def.space) * TROOP_BIAS_SCALE);
};

const obstacleBias = (width: number, height: number) =>
    clampBias(Math.max(width, height) * OBSTACLE_BIAS_SCALE);

export const depthForBuilding = (gridX: number, gridY: number, type: BuildingType) => {
    const def = BUILDING_DEFINITIONS[type];
    const layerOffset = type === 'wall' ? LAYER_OFFSETS.wall : LAYER_OFFSETS.building;
    if (!def) return baseDepth(gridX, gridY) + layerOffset; // unknown type: sane depth, no crash
    const depth = depthForFootprint(gridX, gridY, def.width, def.height, layerOffset, buildingBias(type));
    // Barracks roofs are tall and can be incorrectly occluded by top-right walls without extra lift.
    if (type === 'barracks') return depth + BARRACKS_DEPTH_OFFSET;
    return depth;
};

export const depthForObstacle = (gridX: number, gridY: number, width: number, height: number) =>
    depthForFootprint(gridX, gridY, width, height, LAYER_OFFSETS.obstacle, obstacleBias(width, height));

export const depthForRubble = (gridX: number, gridY: number, width: number, height: number) =>
    depthForFootprint(gridX, gridY, width, height, LAYER_OFFSETS.rubble);

export const depthForTroop = (gridX: number, gridY: number, type: TroopType) =>
    baseDepth(gridX, gridY) + LAYER_OFFSETS.troop + troopBias(type);
