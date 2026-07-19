import Phaser from 'phaser';
import { BUILDING_DEFINITIONS } from '../config/definitions/BuildingDefinitions';
import type { BuildingDef, BuildingType } from '../config/definitions/BuildingTypes';
import { IsoUtils } from '../utils/IsoUtils';
import { BuildingRenderer } from './BuildingRenderer';
import {
    buildingVisualDescriptor,
    type DedicatedBuildingVisualRoute
} from './BuildingVisualCatalog';

export interface BuildingVisualState {
    id?: string;
    type: string;
    gridX: number;
    gridY: number;
    level?: number;
    owner?: string;
    doorOpen?: number;
}

export interface WallNeighborTopology {
    nN: boolean;
    nS: boolean;
    nE: boolean;
    nW: boolean;
    owner: string;
}

export interface BuildingVisualRequest {
    graphics: Phaser.GameObjects.Graphics;
    gridX: number;
    gridY: number;
    type: string;
    alpha?: number;
    tint?: number | null;
    building?: BuildingVisualState;
    baseGraphics?: Phaser.GameObjects.Graphics;
    skipBase?: boolean;
    onlyBase?: boolean;
    /** Scene clock. Cached world postcards intentionally pass zero. */
    time?: number;
    /** MainScene supplies live sound state; cached postcards keep it false. */
    jukeboxPlaying?: boolean;
    wallNeighbors?: WallNeighborTopology;
    /** Postcards recover from one malformed record without losing the atlas. */
    recoverFromRendererError?: boolean;
}

export interface BuildingVisualResult {
    type: BuildingType;
    definition: BuildingDef;
    c1: Phaser.Math.Vector2;
    c2: Phaser.Math.Vector2;
    c3: Phaser.Math.Vector2;
    c4: Phaser.Math.Vector2;
    center: Phaser.Math.Vector2;
}

interface BuildingVisualContext extends BuildingVisualResult {
    graphics: Phaser.GameObjects.Graphics;
    gridX: number;
    gridY: number;
    alpha: number;
    tint: number | null;
    building?: BuildingVisualState;
    baseGraphics?: Phaser.GameObjects.Graphics;
    skipBase: boolean;
    onlyBase: boolean;
    time: number;
    jukeboxPlaying: boolean;
    wallNeighbors: WallNeighborTopology;
}

type DedicatedBuildingVisualHandler = (context: BuildingVisualContext) => void;

const DEDICATED_BUILDING_VISUALS = {
    townHall: c => BuildingRenderer.drawTownHall(
        c.graphics, c.gridX, c.gridY, c.time, c.alpha, c.tint,
        c.baseGraphics, c.skipBase, c.onlyBase, c.building?.doorOpen ?? 0
    ),
    barracks: c => BuildingRenderer.drawMechanicaBarracks(
        c.graphics, c.c1, c.c2, c.c3, c.c4, c.center, c.alpha, c.tint,
        c.building, c.baseGraphics, c.skipBase, c.onlyBase, c.time
    ),
    mysticBarracks: c => BuildingRenderer.drawMysticBarracks(
        c.graphics, c.c1, c.c2, c.c3, c.c4, c.center, c.alpha, c.tint,
        c.building, c.baseGraphics, c.skipBase, c.onlyBase, c.time
    ),
    cannon: c => {
        const level = c.building?.level ?? 1;
        if (level >= 4) {
            BuildingRenderer.drawCannonLevel4(c.graphics, c.c1, c.c2, c.c3, c.c4, c.center, c.alpha, c.tint, c.building, c.baseGraphics, c.skipBase, c.onlyBase, c.time);
        } else if (level === 3) {
            BuildingRenderer.drawCannonLevel3(c.graphics, c.c1, c.c2, c.c3, c.c4, c.center, c.alpha, c.tint, c.building, c.baseGraphics, c.skipBase, c.onlyBase, c.time);
        } else if (level === 2) {
            BuildingRenderer.drawCannonLevel2(c.graphics, c.c1, c.c2, c.c3, c.c4, c.center, c.alpha, c.tint, c.building, c.baseGraphics, c.skipBase, c.onlyBase, c.time);
        } else {
            BuildingRenderer.drawCannon(c.graphics, c.c1, c.c2, c.c3, c.c4, c.center, c.alpha, c.tint, c.building, c.baseGraphics, c.skipBase, c.onlyBase, c.time);
        }
    },
    ballista: c => {
        const level = c.building?.level ?? 1;
        if (level >= 3) {
            BuildingRenderer.drawBallistaLevel3(c.graphics, c.c1, c.c2, c.c3, c.c4, c.center, c.alpha, c.tint, c.building, c.baseGraphics, c.skipBase, c.onlyBase, c.time);
        } else if (level >= 2) {
            BuildingRenderer.drawBallistaLevel2(c.graphics, c.c1, c.c2, c.c3, c.c4, c.center, c.alpha, c.tint, c.building, c.baseGraphics, c.skipBase, c.onlyBase, c.time);
        } else {
            BuildingRenderer.drawBallista(c.graphics, c.c1, c.c2, c.c3, c.c4, c.center, c.alpha, c.tint, c.building, c.baseGraphics, c.skipBase, c.onlyBase, c.time);
        }
    },
    mortar: c => BuildingRenderer.drawMortar(
        c.graphics, c.c1, c.c2, c.c3, c.c4, c.center, c.alpha, c.tint,
        c.building, c.time, c.baseGraphics, c.skipBase, c.onlyBase
    ),
    tesla: c => BuildingRenderer.drawTeslaCoil(
        c.graphics, c.c1, c.c2, c.c3, c.c4, c.center, c.alpha, c.tint,
        c.building, c.time, c.baseGraphics, c.skipBase, c.onlyBase
    ),
    wall: c => {
        // Walls never bake into the ground RT (fully dynamic), but they DO
        // have a ground pass now: the contact shadow. The bake captures it as
        // the per-topology ground decal (onlyBase job) that SpriteBank stamps
        // under the body; a full vector draw paints it first, under the post.
        // The bake's body job (skipBase) must stay shadow-free. S/E connector
        // ownership is supplied by the caller (it depends on the world).
        if (!c.skipBase) {
            BuildingRenderer.drawWallShadow(
                c.graphics, c.gridX, c.gridY, c.alpha, c.wallNeighbors
            );
        }
        if (!c.onlyBase) {
            BuildingRenderer.drawWall(
                c.graphics, c.center, c.gridX, c.gridY, c.alpha, c.tint,
                c.building, c.wallNeighbors
            );
        }
    },
    armyCamp: c => BuildingRenderer.drawArmyCamp(
        c.graphics, c.c1, c.c2, c.c3, c.c4, c.center, c.alpha, c.tint,
        c.baseGraphics, c.building, c.skipBase, c.onlyBase, c.time
    ),
    xbow: c => {
        const level = c.building?.level ?? 1;
        if (level >= 3) {
            BuildingRenderer.drawXBowLevel3(c.graphics, c.c1, c.c2, c.c3, c.c4, c.center, c.alpha, c.tint, c.building, c.time, c.baseGraphics, c.skipBase, c.onlyBase);
        } else if (level >= 2) {
            BuildingRenderer.drawXBowLevel2(c.graphics, c.c1, c.c2, c.c3, c.c4, c.center, c.alpha, c.tint, c.building, c.time, c.baseGraphics, c.skipBase, c.onlyBase);
        } else {
            BuildingRenderer.drawXBow(c.graphics, c.c1, c.c2, c.c3, c.c4, c.center, c.alpha, c.tint, c.building, c.time, c.baseGraphics, c.skipBase, c.onlyBase);
        }
    },
    prism: c => BuildingRenderer.drawPrismTower(
        c.graphics, c.c1, c.c2, c.c3, c.c4, c.center, c.alpha, c.tint,
        c.building, c.baseGraphics, c.skipBase, c.onlyBase, c.time
    ),
    dragonsBreath: c => BuildingRenderer.drawDragonsBreath(
        c.graphics, c.c1, c.c2, c.c3, c.c4, c.center, c.alpha, c.tint,
        c.building, c.baseGraphics, c.gridX, c.gridY, c.time, c.skipBase, c.onlyBase
    ),
    spikeLauncher: c => BuildingRenderer.drawSpikeLauncher(
        c.graphics, c.c1, c.c2, c.c3, c.c4, c.center, c.alpha, c.tint,
        c.building, c.time, c.baseGraphics, c.skipBase, c.onlyBase
    ),
    jukebox: c => BuildingRenderer.drawJukebox(
        c.graphics, c.c1, c.c2, c.c3, c.c4, c.center, c.alpha, c.tint,
        c.building, c.baseGraphics, c.skipBase, c.onlyBase, c.time, c.jukeboxPlaying
    ),
    mine: c => BuildingRenderer.drawMine(
        c.graphics, c.c1, c.c2, c.c3, c.c4, c.center, c.alpha, c.tint,
        c.building, c.baseGraphics, c.skipBase, c.onlyBase, c.time
    ),
    farm: c => BuildingRenderer.drawFarm(
        c.graphics, c.c1, c.c2, c.c3, c.c4, c.center, c.alpha, c.tint,
        c.building, c.baseGraphics, c.skipBase, c.onlyBase, c.time
    ),
    storage: c => BuildingRenderer.drawStorage(
        c.graphics, c.c1, c.c2, c.c3, c.c4, c.center, c.alpha, c.tint,
        c.building, c.baseGraphics, c.skipBase, c.onlyBase, c.time
    ),
    lab: c => BuildingRenderer.drawLab(
        c.graphics, c.c1, c.c2, c.c3, c.c4, c.center, c.alpha, c.tint,
        c.building, c.time, c.baseGraphics, c.skipBase, c.onlyBase
    ),
    watchtower: c => BuildingRenderer.drawWatchtower(
        c.graphics, c.c1, c.c2, c.c3, c.c4, c.center, c.alpha, c.tint,
        c.building, c.baseGraphics, c.skipBase, c.onlyBase, c.time
    )
} satisfies Record<DedicatedBuildingVisualRoute, DedicatedBuildingVisualHandler>;

function drawGeneric(context: BuildingVisualContext): void {
    BuildingRenderer.drawGenericBuilding(
        context.graphics,
        context.c1,
        context.c2,
        context.c3,
        context.c4,
        context.center,
        context.definition,
        context.alpha,
        context.tint,
        context.baseGraphics,
        context.skipBase,
        context.onlyBase
    );
}

/**
 * Single routing authority for live buildings, previews, and world postcards.
 * It owns only renderer selection; renderer geometry and paint remain intact.
 */
export function drawBuildingVisual(request: BuildingVisualRequest): BuildingVisualResult | null {
    const type = request.type as BuildingType;
    const definition = BUILDING_DEFINITIONS[type];
    if (!definition) return null;

    const c1 = IsoUtils.cartToIso(request.gridX, request.gridY);
    const c2 = IsoUtils.cartToIso(request.gridX + definition.width, request.gridY);
    const c3 = IsoUtils.cartToIso(request.gridX + definition.width, request.gridY + definition.height);
    const c4 = IsoUtils.cartToIso(request.gridX, request.gridY + definition.height);
    const center = IsoUtils.cartToIso(
        request.gridX + definition.width / 2,
        request.gridY + definition.height / 2
    );
    const result: BuildingVisualResult = { type, definition, c1, c2, c3, c4, center };
    const context: BuildingVisualContext = {
        ...result,
        graphics: request.graphics,
        gridX: request.gridX,
        gridY: request.gridY,
        alpha: request.alpha ?? 1,
        tint: request.tint ?? null,
        building: request.building,
        baseGraphics: request.baseGraphics,
        skipBase: request.skipBase ?? false,
        onlyBase: request.onlyBase ?? false,
        time: request.time ?? 0,
        jukeboxPlaying: request.jukeboxPlaying ?? false,
        wallNeighbors: request.wallNeighbors ?? {
            nN: false,
            nS: false,
            nE: false,
            nW: false,
            owner: request.building?.owner ?? 'PLAYER'
        }
    };
    const descriptor = buildingVisualDescriptor(type);
    const draw = () => {
        if (descriptor.route === 'generic') drawGeneric(context);
        else DEDICATED_BUILDING_VISUALS[descriptor.route](context);
    };

    if (!request.recoverFromRendererError) {
        draw();
    } else {
        try {
            draw();
        } catch {
            try {
                drawGeneric(context);
            } catch {
                // A malformed postcard record cannot invalidate the atlas.
            }
        }
    }
    return result;
}
