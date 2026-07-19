import type Phaser from 'phaser';
import { drawBuildingVisual } from '../renderers/BuildingVisualDispatcher';
import { BUILDING_VISUAL_CATALOG } from '../renderers/BuildingVisualCatalog';
import { BuildingRenderer } from '../renderers/BuildingRenderer';
import { TroopRenderer } from '../renderers/TroopRenderer';
import { TroopDeathRenderer } from '../renderers/TroopDeathRenderer';
import { WreckRenderer } from '../renderers/WreckRenderer';
import { ObstacleRenderer } from '../renderers/ObstacleRenderer';
import { BUILDING_DEFINITIONS, OBSTACLE_DEFINITIONS, TROOP_DEFINITIONS, getBuildingStats, getTroopStats } from '../config/GameDefinitions';
import { TILE_HEIGHT, TILE_WIDTH } from '../utils/IsoUtils';
import { VillageLifeSystem, VILLAGER_PALETTES, DOG_PALETTES } from '../systems/VillageLifeSystem';
import { WorldFigureRenderer } from '../renderers/WorldFigureRenderer';
import { ProjectileRenderer } from '../renderers/ProjectileRenderer';
import { setWindBoost } from '../systems/Wind';
import { SpriteBank } from '../render/SpriteBank';
import { designBakeParams } from '../renderers/redesign/DesignRegistry';

/**
 * Asset-pipeline entry point (see tools/art-preview/AGENTS_SPRITE_PIPELINE.md).
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
        TroopDeathRenderer,
        WreckRenderer,
        ObstacleRenderer,
        BUILDING_VISUAL_CATALOG,
        BUILDING_DEFINITIONS,
        OBSTACLE_DEFINITIONS,
        TROOP_DEFINITIONS,
        getBuildingStats,
        getTroopStats,
        TILE_WIDTH,
        TILE_HEIGHT,
        // Figure bake surface: villagers/animals/merchant/stall/thief/owl statics.
        VillageLifeSystem,
        VILLAGER_PALETTES,
        DOG_PALETTES,
        // World-map figures + rigid projectiles (extracted statics).
        WorldFigureRenderer,
        ProjectileRenderer,
        // Wind pin: windAt() reads the mutable gustBoost module global, so
        // without pinning, baked banner/crop poses would depend on whatever
        // weather happened to be live at bake time. The harness calls
        // setWindBoost(1) once at setup to capture at calm.
        setWindBoost,
        // Bank introspection for variant tooling: which atlases loaded, and
        // how a plain unit name resolves to its '@slot' design-variant bake.
        SpriteBank,
        // Per-slot bake-param overrides: a design file's hoisted PARAMS export
        // (authored stride/delay/windup/strike/idleMs/dirs), overlaid by
        // DESIGN=<slot> bakes on the unit's TROOP_PARAMS row so the bake
        // samples the slot's exact authored periods.
        designBakeParams
    };
}
