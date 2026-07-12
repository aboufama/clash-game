import type Phaser from 'phaser';
import { drawBuildingVisual } from '../renderers/BuildingVisualDispatcher';
import { BUILDING_VISUAL_CATALOG } from '../renderers/BuildingVisualCatalog';
import { BuildingRenderer } from '../renderers/BuildingRenderer';
import { TroopRenderer } from '../renderers/TroopRenderer';
import { WreckRenderer } from '../renderers/WreckRenderer';
import { ObstacleRenderer } from '../renderers/ObstacleRenderer';
import { BUILDING_DEFINITIONS, OBSTACLE_DEFINITIONS, TROOP_DEFINITIONS, getBuildingStats, getTroopStats } from '../config/GameDefinitions';
import { TILE_HEIGHT, TILE_WIDTH } from '../utils/IsoUtils';

/**
 * Asset-pipeline entry point (see docs/AGENTS_SPRITE_PIPELINE.md).
 *
 * The bake harness (tools/art-preview/bake-sprites.mjs) drives the EXACT same
 * renderers the game uses — this bridge exposes them on window so a headless
 * page can render any building's ground/body pass (at each aim angle) and any
 * troop's direction/state/frame into a transparent RenderTexture, quantize it
 * into pixel-art texels, and save the result as the unit's baked sprites.
 * Pure vector authoring stays the source of truth; the runtime ships the
 * baked frames.
 *
 * Same debug-handle culture as __clashGame/__clashGM: tiny, side-effect-free
 * until called, and deterministic (pose + time are pinned by the caller).
 */
export function installBakeBridge(scene: Phaser.Scene) {
    (window as unknown as Record<string, unknown>).__clashBake = {
        scene,
        drawBuildingVisual,
        BuildingRenderer,
        TroopRenderer,
        WreckRenderer,
        ObstacleRenderer,
        BUILDING_VISUAL_CATALOG,
        BUILDING_DEFINITIONS,
        OBSTACLE_DEFINITIONS,
        TROOP_DEFINITIONS,
        getBuildingStats,
        getTroopStats,
        TILE_WIDTH,
        TILE_HEIGHT
    };
}
