import Phaser from 'phaser';
import { BUILDING_DEFINITIONS, OBSTACLE_DEFINITIONS, WORLD_COORD_LIMIT, type BuildingType } from '../config/GameDefinitions';
import { sanitizeVillageBanner, type SerializedWorld } from '../data/Models';
import {
    Backend,
    type KnownMapPlot,
    type WorldMapPlot,
    type WorldMapWindow,
    type WorldPostcard
} from '../backend/GameBackend';
import { drawBuildingVisual } from '../renderers/BuildingVisualDispatcher';
import { IsoUtils, TILE_WIDTH, TILE_HEIGHT } from '../utils/IsoUtils';
import { bannerDesignFor, drawFlagBearer, drawVillageFlag, type FlagDesign } from '../renderers/VillageFlagRenderer';
import { townHallApexLift } from '../renderers/BuildingRenderer';
import { gameManager, type PlotPanelAction } from '../GameManager';
import { soundSystem } from './SoundSystem';
import { musicSystem } from './MusicSystem';
import { DayNightSystem, type PostcardLightAnchor } from './DayNightSystem';
import { NeighborLifeSim } from './NeighborLifeSim';
import { computeStoneRoutes, drawStoneLane } from '../renderers/StonePathRenderer';
import {
    GRASS_CORNER_CUT_RADIUS,
    drawGrassTile,
    grassPaletteFor,
    grassTileColorAt,
    wildernessGrassPalette
} from '../renderers/GrassRenderer';
import { WildernessRenderer, type WildernessLifeAnchor, type WildernessStream } from '../renderers/WildernessRenderer';
import { activeSlot, listVariantUnits } from '../renderers/redesign/DesignRegistry';
import type { LakeTerrain } from '../renderers/WildernessTerrain';
import { WorldHydrologyRenderer } from '../renderers/WorldHydrologyRenderer';
import {
    normalizeWorldNatureSeedVersion,
    wildernessPlotPresentationSeed
} from '../renderers/WorldNatureSeed';
import { ObstacleRenderer } from '../renderers/ObstacleRenderer';
import { WorldFigureRenderer } from '../renderers/WorldFigureRenderer';
import { FIGURE_ANIM_HZ, PIXEL_CELL, figureTick, pixelBitmap, pixelEllipse, pixelLine, pixelRect } from '../render/PixelDraw';
import { applyTextureSampling, registerPixelSurface, TextureSampling } from '../renderers/TextureRenderPolicy';
import { toLogicalZoom } from '../utils/DisplayResolution';
import { MobileUtils } from '../utils/MobileUtils';
import { windSway } from './Wind';
import { hashString, isWildernessPreserveAt, watchtowerSightOf } from '../config/Economy';
import {
    classifyHydrologyPlot,
    featureContainsWorldPoint,
    hydrologyFeaturesForPlot,
    queryWorldHydrology
} from '../config/WorldHydrology';
import { depthForBuilding, depthForObstacle } from './DepthSystem';
import { SpriteBank } from '../render/SpriteBank';
import {
    buildWildernessTopology,
    classifyJoinedWildernessGapTap,
    roundedRoadBendFor,
    type WildernessJunctionQuadrant,
    type WildernessRoadArms,
    type WildernessTopology
} from './WildernessTopology';
import {
    PLAYER_POSTCARD_RGBA_BYTES,
    PLAYER_POSTCARD_SCALE,
    decidePostcardResidency,
    estimateVillageTextureBytes,
    isRevealPostcardReady,
    type ScreenRect
} from './WorldPostcardResidency';

/**
 * THE GLOBAL MAP — every village in the game tiles onto one shared,
 * persistent grid. Your village lives at its permanent plot; this system
 * renders the neighbourhood around it so other players' bases (and the
 * server-persisted bot clans between them) are physically THERE, one lawn over.
 *
 * Performance model (the whole trick):
 *   - YOUR village is the only fully interactive simulation.
 *   - Each neighbour's exact static base renders ONCE into a full-resolution
 *     RenderTexture, then costs one quad per frame. The active 3x3 stays GPU
 *     resident; ring-two textures are camera-prefetched and evicted after a
 *     grace period while their authoritative snapshots remain in memory.
 *     Rematerialization uses the same 1:1 vector bake—residency is the only
 *     LOD. Authoritative resident overlays are culled and sampled from shared
 *     server wall time at a redraw cadence; their art is never simplified.
 *   - Beyond the window: wilderness. Nothing is rendered.
 *
 * The map refreshes on a slow poll: bases redraw only when their owner's
 * revision changes, battle indicators pulse on plots that are under live
 * attack (tap to spectate through the existing replay stream), and empty
 * plots can be settled — relocation just swaps which neighbours surround
 * you, because everything renders relative to YOUR plot.
 */

const PLOT_TILES = 25;
const PLOT_GAP = 2;
export const PLOT_PITCH = PLOT_TILES + PLOT_GAP;

// Road surface palette — one source of truth for the static road atlas AND
// the junction corner pieces, so a bend can never drift off-colour from the
// straight lanes it joins. Every layer paints OPAQUE with a pre-blended
// colour: translucent layers would double-darken where the two axes cross.
const roadBlend = (base: number, over: number, t: number): number => {
    const br = (base >> 16) & 0xff, bg = (base >> 8) & 0xff, bb = base & 0xff;
    const or2 = (over >> 16) & 0xff, og = (over >> 8) & 0xff, ob = over & 0xff;
    return (Math.round(br + (or2 - br) * t) << 16) |
        (Math.round(bg + (og - bg) * t) << 8) |
        Math.round(bb + (ob - bb) * t);
};
const ROAD_EARTH = 0x8d7c5f;
const ROAD_CROWN = roadBlend(ROAD_EARTH, 0x9c8a6a, 0.55);
const ROAD_RUT = roadBlend(ROAD_CROWN, 0x7a6a50, 0.5);
const ROAD_SHOULDER = roadBlend(ROAD_EARTH, 0x6f6048, 0.75);
const ROAD_COBBLE = roadBlend(ROAD_CROWN, 0x7d6f56, 0.8);
/** The two junction faces (road arms) incident to each corner quadrant. A
 * quadrant's plot corner is flanked by exactly these faces; an absent arm
 * means that face is a JOINED grass band (both adjoining plots wild). */
const QUADRANT_FACES: Record<WildernessJunctionQuadrant, readonly [keyof WildernessRoadArms, keyof WildernessRoadArms]> = {
    nw: ['n', 'w'],
    ne: ['n', 'e'],
    se: ['s', 'e'],
    sw: ['s', 'w']
};
// The compact /home/sync heartbeat carries fast-changing home authority.
// Postcard snapshots only need a slower revision refresh while HOME is open.
const REFRESH_MS = 60_000;
const SNAPSHOT_SCALE = PLAYER_POSTCARD_SCALE; // player villages are never downsampled

/**
 * A filled triangle as three stacked pixel-cell rows (PixelDraw deliberately
 * has no triangle): rows interpolate from the base corners toward the apex.
 */
function pixelTriangleRows(
    g: Phaser.GameObjects.Graphics,
    apexX: number,
    apexY: number,
    baseLeftX: number,
    baseRightX: number,
    baseY: number,
    color: number,
    alpha = 1,
    rows = 3
) {
    for (let row = 0; row < rows; row++) {
        const mid = (row + 0.5) / rows;
        const y0 = baseY + (apexY - baseY) * (row / rows);
        const y1 = baseY + (apexY - baseY) * ((row + 1) / rows);
        const x0 = baseLeftX + (apexX - baseLeftX) * mid;
        const x1 = baseRightX + (apexX - baseRightX) * mid;
        pixelRect(g, Math.min(x0, x1), Math.min(y0, y1),
            Math.max(0.5, Math.abs(x1 - x0)), Math.max(0.5, Math.abs(y1 - y0)), color, alpha);
    }
}

/** A strokeEllipse replacement: the ring lands as one pixel cell per ~24 angle steps. */
function pixelRing(
    g: Phaser.GameObjects.Graphics,
    cx: number,
    cy: number,
    rx: number,
    ry: number,
    color: number,
    alpha = 1
) {
    // Cells are DEDUPED per ring: at small radii several perimeter samples
    // land in the same cell, and stamping one twice at alpha < 1 stacks into
    // dark blotches (the same guard PixelFx.stampRing keeps).
    const STEPS = 24;
    const seen = new Set<string>();
    for (let i = 0; i < STEPS; i++) {
        const a = (i / STEPS) * Math.PI * 2;
        const ix = Math.floor((cx + Math.cos(a) * rx) / PIXEL_CELL);
        const iy = Math.floor((cy + Math.sin(a) * ry) / PIXEL_CELL);
        const key = `${ix},${iy}`;
        if (seen.has(key)) continue;
        seen.add(key);
        pixelRect(g, ix * PIXEL_CELL, iy * PIXEL_CELL, PIXEL_CELL, PIXEL_CELL, color, alpha);
    }
}

interface NeighborView {
    key: string;
    plot: WorldMapPlot;
    rt: Phaser.GameObjects.RenderTexture | null;
    battle: Phaser.GameObjects.Graphics | null;
    battleTween: Phaser.Tweens.Tween | null;
    renderedRevision: number | string | null;
    /** What the RenderTexture actually contains. Kept separate from API plot
     * kind so tests and transitions cannot mistake a stale village for wilds. */
    contentKind: 'nature' | 'village' | null;
    /** Raw server revision used by conditional /map responses. */
    knownRevision: number | string | null;
    /** Chimney smoke + flag + night windows: the postcard breathes a little. */
    life: Phaser.GameObjects.Graphics | null;
    /** Additive night-glow layer for the postcard's lit buildings. */
    glow?: Phaser.GameObjects.Graphics | null;
    /** Emitter anchors captured at snapshot time. */
    lightAnchors?: PostcardLightAnchor[];
    /** Scene-grid position + level of the neighbour's town hall (their
     *  hearth) — the level picks the roof-apex height the mini banner
     *  plants on (townHallApexLift). */
    hearth: { gx: number; gy: number; level: number } | null;
    /** Cached hall-flag heraldry (explicit banner or bot fallback). */
    flag?: FlagDesign | null;
    flagKey?: string;
    /** Deterministic water/forest life anchors emitted by nature rendering. */
    natureLife: WildernessLifeAnchor[];
    /** Plot-local lake/brook geometry kept after the art bakes into the RT,
     * so weather can ask what a falling drop actually lands on. */
    natureWaters?: { lakes: LakeTerrain[]; streams: WildernessStream[] } | null;
    /** Retained authoritative data can rematerialize an evicted GPU texture
     * without another request or any loss of detail. */
    sourceWorld: PostcardWorld | null;
    sourceRevision: number | string | null;
    /** True while THIS view owns the shared per-key registries (villager sim
     * + postcard night lights). Hidden pending-focus views render under the
     * same absolute keys as the live ring; only the registered owner may
     * clear those registries on release, or a battle prepared over a shared
     * plot silently kills its living neighbours (and vice versa). */
    residentsRegistered: boolean;
    /** Plot offset in the currently anchored map frame. */
    dx: number;
    dy: number;
    /** Scene-clock timestamp used by the anti-thrash eviction grace. */
    lastTextureInterestAt: number;
}

type MapPlotWithSnapshot = WorldMapPlot & {
    /** Current servers include these so map refresh is one request, not N+1. */
    revision?: number | string;
    world?: WorldPostcard;
};

type PostcardWorld = SerializedWorld | WorldPostcard;

interface PendingFocus {
    target: { x: number; y: number };
    views: Map<string, NeighborView>;
    ready: boolean;
    epoch: number;
}

interface MapRequestTicket {
    sequence: number;
    authorityEpoch: number;
}

interface MapRefreshOptions {
    /** Explicit sight radius this request must cover. */
    requiredRadius?: number;
    /** Reveal preparation bypasses normal ring-two texture residency. */
    forceVillageTextures?: boolean;
}

interface MapRefreshResult {
    requestedRadius: number;
    accepted: boolean;
}

interface MapHost extends Phaser.Scene {
    mode: string;
    mapSize: number;
    userId: string;
    buildings: Array<{ id?: string; type: string; level?: number; health: number }>;
    attackBotPlot(seed: number, username: string, plotX?: number, plotY?: number): void;
    attackPlayerPlotByRoad(ownerId: string, username: string, plotX: number, plotY: number): void;
    villageLife?: {
        applyBattleScars(destructionPct: number): void;
        isPlacementUnderConstruction?(buildingId: string): boolean;
    };
    villageBubbles?: {
        raise(spec: { key: string; text: string; kind?: 'info' | 'danger'; buildingType?: string; anchor?: { x: number; y: number }; ttlMs?: number; action?: { label: string; run: () => void }; closable?: boolean; icon?: string; animate?: boolean; progress?: () => number }): void;
        clear(key: string): void;
    };
    dayNight?: {
        nightFactor(): number;
        addTransientLight(opts: { gx: number; gy: number; radius?: number; tint?: number; until: number }): number;
        removeTransientLight(id: number): void;
        moveTransientLight?(id: number, gx: number, gy: number): void;
        setSightBound?(bound: { min: number; max: number } | null): void;
        setPostcardLights?(key: string, buildings: ReadonlyArray<{ type?: string; level?: number; gridX?: number; gridY?: number }>, offX: number, offY: number, cap?: number): void;
        clearPostcardLights?(key: string): void;
    };
}

export class WorldMapSystem {
    private readonly scene: MapHost;
    private myPlot = { x: 0, y: 0 };
    private views = new Map<string, NeighborView>();
    private nextResidencyCheckAt = 0;
    private textureMaterializations = 0;
    private textureEvictions = 0;
    private wilderness: Phaser.GameObjects.Graphics | null = null;
    /** Grass bridges painted above the static road grid wherever two known
     * wilderness parcels touch. Kept separate so topology can swap atomically
     * after a map refresh without rebuilding every road ornament. */
    private wildernessLinks: Phaser.GameObjects.Graphics | null = null;
    /** Direct grass over known wild-wild gap bands, above postcard sampling
     * and below world hydrology. This removes the last anti-aliased road-rut
     * texels without covering any plot interior props. */
    private wildernessGapSurface: Phaser.GameObjects.Graphics | null = null;
    /** One direct-vector feature layer above postcard RTs. Multi-plot water
     * cannot be split among independently rasterized textures without tiny
     * filter boundaries, so Great Lakes are visually authoritative here. */
    private worldHydrologyLayer: Phaser.GameObjects.Graphics | null = null;
    /** Animated fish/frogs for water lying in the ROAD-GAP bands: plot
     * postcards animate their own anchors, but a river crossing a reclaimed
     * road lives between plots, so its life rides the overlay layer. */
    private worldHydrologyLifeLayer: Phaser.GameObjects.Graphics | null = null;
    private worldHydrologyGapLife: WildernessLifeAnchor[] = [];
    /** Inverted-alpha mask over the hydrology overlay (and its life layer):
     * every village postcard's roof-headroom band punches OUT of the water
     * overlay, so roofs leaning over an adjacent water plot win the painter
     * fight — the identical water baked in the postcard RTs shows instead. */
    private worldHydrologyMaskGfx: Phaser.GameObjects.Graphics | null = null;
    private worldHydrologyMask: Phaser.Display.Masks.GeometryMask | null = null;
    private wildernessTopology: WildernessTopology | null = null;
    /** Cache key for the painted links layer: topology PLUS every palette
     *  input (the owner id arrives from auth after the first paint). */
    private wildernessLinkSignature: string | null = null;
    /** Plot kinds from the freshest window/focus response, consulted while
     * postcards render BEFORE their sibling views exist — wilderness corner
     * rounding needs its neighbours' kinds on the very first pass. */
    private knownPlotKindHints = new Map<string, WorldMapPlot['kind']>();
    /** The unknown world: cloud cover past the watchtower's sight. */
    private fogStatic: Phaser.GameObjects.Graphics | null = null;
    private fogEdge: Phaser.GameObjects.Graphics | null = null;
    /** Real villagers for every neighbour postcard, LOD-ticked. */
    private neighborLifeSim: NeighborLifeSim | null = null;
    private get neighborLife(): NeighborLifeSim {
        if (!this.neighborLifeSim) this.neighborLifeSim = new NeighborLifeSim(this.scene);
        return this.neighborLifeSim;
    }
    private fogRadius = -1;
    /** Camera rect the culled fogStatic bank was built for; escaping it
     *  forces a repaint (the deep bank only generates lattice cells near
     *  the view — see paintFogBank). */
    private fogStaticCover: { x: number; y: number; right: number; bottom: number } | null = null;
    private nextFogEdgeAt = 0;
    // ---- watchtower reveal transition (the clouds pull back over ~3 s) ----
    private fogReveal: {
        fromBound: { min: number; max: number };
        toBound: { min: number; max: number };
        startTime: number;
        durationMs: number;
    } | null = null;
    /** A sight gain waits here, at the old cloud boundary, until the expanded
     *  authoritative window has a current RenderTexture for every plot. */
    private pendingFogReveal: {
        fromRadius: number;
        toRadius: number;
        epoch: number;
        ready: boolean;
    } | null = null;
    private fogRevealPreparationEpoch = 0;
    /** Animated inner square while a reveal runs; drawFogEdge mirrors it. */
    private fogRevealBoundary: { min: number; max: number } | null = null;
    private nextFogRevealRebuildAt = 0;
    private lastUpdateTime = 0;
    /** Structural reveal gates — no latency heuristics. `sightHydrated` arms
     *  once a steady HOME evaluation has seen MY real (non-empty) building
     *  set: gains observed before that baseline are boot/load hydration and
     *  snap instantly. `sightSwapPending` raises whenever the scene leaves
     *  the steady HOME frame (in-place battles, focus swaps, cloud
     *  transitions) — while it is up the scene may hold a FOREIGN (enemy)
     *  building set, so sight RE-BASELINES silently instead of diffing, and
     *  only an id overlap with `homeBuildingIds` (my roster from the last
     *  steady frame) or `serverHomeRosterIds` (below) proves my world is back
     *  and lowers it. */
    private sightHydrated = false;
    private sightSwapPending = false;
    private homeBuildingIds = new Set<string>();
    /** Server-authoritative ids of MY OWN roster: every accepted map window
     *  contains my plot's postcard (the own plot never becomes a view, so
     *  `knownPlots` can never revision-suppress it), and its building ids are
     *  the same save ids the scene instantiates. This is the OWNERSHIP-PROVEN
     *  bootstrap for the swap latch — a swap raised before `homeBuildingIds`
     *  ever populated (an instant replay opened on boot) resolves against
     *  this set instead of guessing that the first non-empty HOME frame is
     *  mine (those frames can still hold the ENEMY's roster). Null until the
     *  first window lands; while both sets are empty the latch DEFERS —
     *  sizing the fog silently, never adopting a baseline it cannot prove. */
    private serverHomeRosterIds: Set<string> | null = null;
    private nextRefreshAt = 0;
    private refreshing = false;
    private refreshInFlight: Promise<MapRefreshResult> | null = null;
    private refreshRadiusInFlight = -1;
    private refreshForcesTexturesInFlight = false;
    /** One relocation at a time: a double click can never issue two claims. */
    private settlementInFlight: Promise<boolean> | null = null;
    private homePlotKnown = false;
    /**
     * Map GETs and relocation POSTs can cross on the wire. Epoch fencing
     * prevents a response issued for the old home from re-anchoring the
     * neighbourhood after the move has already committed.
     */
    private mapAuthorityEpoch = 0;
    private mapRequestSequence = 0;
    private latestHomeServerNow = 0;
    private latestHomeResponseSequence = 0;
    /** Server-owned generated-world epoch: scenery plus generated land use. */
    private presentationSeedVersion = 0;
    private presentationSeedObservedAt = 0;
    /** True only while the visible ring is an unauthoritative first-load fallback. */
    private fallbackViewsActive = false;
    private focusEpoch = 0;
    // ---- home defence: siege detection, alarm banner, shields ----
    private homeAttackId: string | null = null;
    private dismissedSiegeId: string | null = null;
    private myShieldUntil = 0;
    /**
     * Battle-in-place: when set, the LOCAL grid hosts this plot's village
     * (the battlefield) and the neighbourhood renders around IT — including
     * the player's own home as a postcard. The world never cuts away.
     */
    private focusPlot: { x: number; y: number } | null = null;
    /**
     * The already-rendered HOME ring is parked while a raid is in focus. Keeping
     * these eight near postcards avoids a network fetch plus eight full-size RT
     * paints on the cloud-covered return path. Only one home ring is retained;
     * NEXT attacks replace the battle ring while this original set stays parked.
     */
    private parkedHomeViews: Map<string, NeighborView> | null = null;
    private parkedHomeKindHints: Map<string, WorldMapPlot['kind']> | null = null;
    /** The war caravan marching down the roads toward a neighbour. */
    private caravan: {
        points: Array<{ x: number; y: number }>;
        seg: number;
        x: number;
        y: number;
        gfx: Phaser.GameObjects.Graphics;
        onArrive: () => void;
        onCancel?: () => void;
        lastTime: number;
        arriving: boolean;
        /** Distance covered / total route length — drives the camera glide. */
        walked: number;
        totalLen: number;
        camStart: { x: number; y: number };
        camTarget: { x: number; y: number };
        /** 'march' = on the road; 'plant' = driving the standard into their
         *  soil; 'camp' = parked at their gate for the battle. */
        state: 'march' | 'plant' | 'camp';
        plantStartedAt?: number;
        /** Tiles/ms — scaled up on long marches so distance never drags. */
        speed: number;
        /** Smoothed cloth fly direction (screen-x, -1..1) and climb. */
        clothDir: number;
        clothClimb: number;
        lightId: number | null;
        /** Rolling HOME after the battle: the swap fires mid-glide, then the column disbands. */
        homecoming: boolean;
        swapFired: boolean;
        /** The army on the move, one entry per figure (actual composition). */
        escorts: string[];
        /** One sprite-carrier Graphics per escort index (baked caravan-soldier
         * frames); created on demand, destroyed with the caravan. A null slot
         * is a figure that slipped away in the yard. */
        escortCarriers: Array<Phaser.GameObjects.Graphics | null>;
        /** The village's own heraldry, carried huge by the bearer. */
        flag: FlagDesign | null;
    } | null = null;

    /** Point at arc-length `d` along the caravan's route (clamped). */
    private static routePoint(points: Array<{ x: number; y: number }>, d: number): { x: number; y: number; fx: number; fy: number } {
        let remaining = Math.max(0, d);
        for (let i = 1; i < points.length; i++) {
            const ax = points[i - 1].x;
            const ay = points[i - 1].y;
            const bx = points[i].x;
            const by = points[i].y;
            const len = Math.hypot(bx - ax, by - ay);
            if (remaining <= len || i === points.length - 1) {
                const t = len > 0 ? Math.min(1, remaining / len) : 0;
                const fx = len > 0 ? (bx - ax) / len : 1;
                const fy = len > 0 ? (by - ay) / len : 0;
                return { x: ax + (bx - ax) * t, y: ay + (by - ay) * t, fx, fy };
            }
            remaining -= len;
        }
        const last = points[points.length - 1];
        return { x: last.x, y: last.y, fx: 1, fy: 0 };
    }

    constructor(scene: MapHost) {
        this.scene = scene;
    }

    private createView(key: string, plot: WorldMapPlot, dx: number, dy: number): NeighborView {
        return {
            key,
            plot,
            rt: null,
            battle: null,
            battleTween: null,
            renderedRevision: null,
            contentKind: null,
            knownRevision: null,
            life: null,
            hearth: null,
            natureLife: [],
            sourceWorld: null,
            sourceRevision: null,
            residentsRegistered: false,
            dx,
            dy,
            lastTextureInterestAt: this.scene.time?.now ?? 0
        };
    }

    /** Runtime evidence for browser profiling and memory regressions. */
    postcardTextureStats() {
        const villages = [...this.views.values()].filter(view => view.plot.kind === 'player' || view.plot.kind === 'bot');
        const resident = villages.filter(view => view.contentKind === 'village' && view.rt !== null);
        const allocatedRgbaBytes = resident.reduce((sum, view) =>
            sum + Math.ceil(view.rt!.width) * Math.ceil(view.rt!.height) * 4, 0);
        const fullResidentBaselineBytes = estimateVillageTextureBytes(villages.length);
        return {
            playerSnapshotScale: SNAPSHOT_SCALE,
            villageViews: villages.length,
            residentVillageTextures: resident.length,
            deferredVillageTextures: villages.length - resident.length,
            allocatedRgbaBytes,
            fullResidentBaselineBytes,
            avoidedRgbaBytes: Math.max(0, fullResidentBaselineBytes - allocatedRgbaBytes),
            bytesPerFullVillageTexture: PLAYER_POSTCARD_RGBA_BYTES,
            materializations: this.textureMaterializations,
            evictions: this.textureEvictions
        };
    }

    /** Poll cadence + visibility gating; call from the scene's update. */
    update(time: number) {
        this.lastUpdateTime = time;
        const home = this.scene.mode === 'HOME';
        // Any frame away from the steady HOME scene may be (or precede) a
        // world swap — and the first HOME frames after a return can STILL
        // hold the enemy's buildings while the home world reloads. Sight must
        // re-baseline after this, never diff across it (computeViewRadius).
        if (!home || this.focusPlot) this.sightSwapPending = true;
        // Battles fought IN PLACE keep the whole world on screen; every other
        // non-HOME mode (replays, cloud-transition raids) clears the map.
        if (!home && !this.focusPlot) {
            if (this.views.size > 0 || this.wilderness) this.teardown();
            return;
        }
        if (home && !this.focusPlot) {
            // The ONLY trusted sight evaluation: it may START a reveal this
            // very frame; while one runs, the transition owns fogStatic
            // instead of the cached path (so ensureFog can never cancel a
            // reveal this same expression just began).
            const radius = this.computeViewRadius(true);
            this.startPreparedFogReveal();
            if (this.fogReveal) this.updateFogReveal(time);
            else this.ensureFog(this.pendingFogReveal?.fromRadius ?? radius);
            if (time >= this.nextRefreshAt && !this.refreshing) {
                const pending = this.pendingFogReveal;
                this.nextRefreshAt = time + (pending ? 750 : REFRESH_MS);
                if (pending) void this.preparePendingFogReveal(pending.epoch);
                else void this.refresh();
            }
        }
        this.checkDesignRepaint(time);
        // The deep bank is culled to the camera it was built for; a pan or
        // zoom that escapes that coverage repaints it (steady state only — a
        // live reveal rebuilds with fresh coverage every frame anyway).
        if (this.fogStatic && !this.fogReveal && this.fogStaticCover) {
            const wv = this.scene.cameras.main.worldView;
            const c = this.fogStaticCover;
            if (wv.x < c.x || wv.y < c.y || wv.right > c.right || wv.bottom > c.bottom) {
                this.fogRadius = -1;
                this.ensureFog(this.pendingFogReveal?.fromRadius ?? this.computeViewRadius());
            }
        }
        this.drawFogEdge(time);
        this.updateCaravan(time);
        this.reconcileVillageTextureResidency(time);
        this.updatePostcardLife(time);
        this.updateTravellers(time);
    }

    private lastDesignFingerprint: string | null = null;
    private nextDesignCheckAt = 0;

    /**
     * Design Lab switches must repaint wilderness postcards NOW, not on the
     * next 25 s map poll: archetype plots fold their active design slot into
     * the postcard revision (WildernessRenderer.renderRevision), so a cheap
     * throttled fingerprint watch spots the switch and re-runs the revision
     * check on the resident nature views. Deliberately listener-free —
     * WorldMapSystem has no terminal destructor to unhook a window listener,
     * and teardown() is a mid-life call, not a destructor.
     */
    private checkDesignRepaint(time: number) {
        if (time < this.nextDesignCheckAt) return;
        this.nextDesignCheckAt = time + 500;
        const fingerprint = listVariantUnits()
            .map(info => `${info.unit}=${activeSlot(info.unit)}`)
            .join('|');
        if (fingerprint === this.lastDesignFingerprint) return;
        const boot = this.lastDesignFingerprint === null;
        this.lastDesignFingerprint = fingerprint;
        if (boot) return; // first sample — nothing was rendered under an old slot
        for (const view of this.views.values()) {
            if (view.plot.kind !== 'empty' || !view.rt || view.contentKind !== 'nature') continue;
            // Pre-poll fallback views keep their sentinel revision: the real
            // map poll owns their first true render.
            if (view.renderedRevision === 'fallback_wilds') continue;
            const wildRevision = this.wildernessRevisionAt(view.plot.x, view.plot.y);
            if (view.renderedRevision === wildRevision) continue;
            this.renderNaturePostcard(view, view.dx, view.dy);
            view.renderedRevision = wildRevision;
        }
    }

    // ================= battle-in-place (focus mode) =================

    /** Offset of an absolute plot from home, if it is inside the rendered ring. */
    travelOffsetFor(plotX: number, plotY: number): { dx: number; dy: number } | null {
        if (this.views.size === 0) return null;
        const dx = plotX - this.myPlot.x;
        const dy = plotY - this.myPlot.y;
        if (dx === 0 && dy === 0) return null;
        // No distance cap: however far the target — past rendered views,
        // past the wilderness — the bearer walks the roads all the way.
        return { dx, dy };
    }

    /**
     * The invisible half of a seamless invasion: while the caravan is still
     * on the road, the ENTIRE post-swap world is rendered in advance —
     * every plot of the target's ring (the player's own home included) drawn
     * into HIDDEN RenderTextures at their new offsets. The battlefield plot
     * itself is skipped; the live battle will occupy the local grid.
     */
    private pendingFocus: PendingFocus | null = null;

    prepareFocus(target: { x: number; y: number }, prefetchedWindow: WorldMapWindow | null = null) {
        // A second march can supersede the first while its hidden postcards are
        // still being painted. Destroy the abandoned GPU textures immediately.
        this.dropPendingFocus();
        const epoch = ++this.focusEpoch;
        this.pendingFocus = { target: { ...target }, views: new Map(), ready: false, epoch };
        const pending = this.pendingFocus;
        // Attacks must read as battles at a real world address, including for
        // a fresh account whose home watchtower sight is still zero. The
        // server grants this one-ring exception only for the canonical active
        // player/bot target; ordinary exploration remains sight-gated.
        // Combat always needs the immediate local neighborhood, not the
        // attacker's entire exploration horizon. Letting a level-2 watchtower
        // expand this to 5x5 made one transition prepare 24 postcards and
        // could exceed the handoff deadline on slower GPUs. Home exploration
        // keeps its earned radius; a battle focuses one exact 3x3 context.
        const focusRadius = 1;
        void (async () => {
            let window: Awaited<ReturnType<typeof Backend.fetchMap>> = prefetchedWindow;
            if (!window) {
                try {
                    window = await Backend.fetchMap(target.x, target.y, focusRadius);
                } catch (error) {
                    // The live target world is already loaded by the attack
                    // start. A failed neighbour postcard request can safely fall
                    // back to deterministic wilderness without stalling the road.
                    console.warn('focus map request failed; using wilderness ring:', error);
                }
            }
            if (!this.focusIsLive(pending)) return;
            if (window) this.adoptPresentationSeedVersion(window.seedVersion, window.serverNow);

            // Build the expected square explicitly. A short/failed response is
            // filled with deterministic wilds, so the swap can never expose a
            // partially painted ring.
            const received = new Map((window?.plots ?? []).map(plot => [`${plot.x},${plot.y}`, plot]));
            const plots = this.fallbackFocusPlots(target, focusRadius).map(fallback => received.get(`${fallback.x},${fallback.y}`) ?? fallback);
            // The focus window's kinds join the corner-rounding hints so the
            // hidden ring's wilderness postcards see their neighbours' kinds
            // (merge, not replace: the home ring is still on screen).
            for (const plot of plots) this.knownPlotKindHints.set(`${plot.x},${plot.y}`, plot.kind);
            const expectedViews = plots.length - 1; // target itself stays live
            for (const plot of plots) {
                const dx = plot.x - target.x;
                const dy = plot.y - target.y;
                if (dx === 0 && dy === 0) continue; // the battlefield itself
                if (!this.focusIsLive(pending)) return;

                // Yield between paints so input/audio can breathe, but do not
                // impose the old 34 ms timer floor on every one of eight views.
                // The clouds already own this transition; a zero-delay task
                // boundary avoids a single monolithic frame without adding a
                // guaranteed 272 ms to every match.
                await new Promise(resolve => setTimeout(resolve, 0));
                if (!this.focusIsLive(pending)) return;
                const view = this.createView(`${plot.x},${plot.y}`, plot, dx, dy);
                try {
                    let world: PostcardWorld | null = null;
                    let revision: number | string = 0;
                    if ((plot.kind === 'bot' || plot.kind === 'player') && plot.ownerId) {
                        const enriched = plot as MapPlotWithSnapshot;
                        // An unconditioned focus request carries all snapshots.
                        // Do not fall back to one request per player.
                        world = enriched.world ?? null;
                        revision = `${plot.kind}_${plot.ownerId}_${enriched.revision ?? world?.revision ?? 0}`;
                    }

                    if (world) {
                        view.sourceWorld = world;
                        view.sourceRevision = revision;
                        view.knownRevision = (plot as MapPlotWithSnapshot).revision ?? world.revision ?? null;
                        // The post-swap active 3x3 is guaranteed ready. Ring-2
                        // metadata is retained but its full-size texture waits
                        // for camera prefetch instead of doubling transition
                        // memory with sixteen hidden 5.7 MB allocations.
                        if (Math.max(Math.abs(dx), Math.abs(dy)) <= 1) {
                            // Residents defer to commitFocus: this hidden view
                            // shares its key with a live one whenever the
                            // battle ring overlaps the home ring.
                            this.renderSnapshot(view, world, dx, dy, { deferResidents: true });
                            view.renderedRevision = revision;
                        }
                    } else {
                        this.renderNaturePostcard(view, dx, dy);
                        view.renderedRevision = plot.kind === 'empty'
                            ? this.wildernessRevisionAt(plot.x, plot.y)
                            : this.fallbackNatureRevision(plot, view.key);
                    }
                } catch (error) {
                    // Snapshot corruption is isolated to this plot. Discard any
                    // half-built resources and replace it with stable nature.
                    console.warn(`focus postcard failed for ${plot.x},${plot.y}:`, error);
                    this.destroyView(view);
                    view.rt = null;
                    view.battle = null;
                    view.life = null;
                    this.renderNaturePostcard(view, dx, dy);
                    view.renderedRevision = this.fallbackNatureRevision(plot, view.key);
                }
                view.rt?.setVisible(false); // waits in the wings
                pending.views.set(view.key, view);
            }
            if (this.focusIsLive(pending)) pending.ready = pending.views.size === expectedViews;
        })().catch(error => {
            // Leave `ready` false: commitFocus deliberately refuses an
            // incomplete frame. Lifecycle/transition cancellation tears it
            // down through the epoch guard.
            console.warn('focus preparation failed:', error);
        });
    }

    private focusIsLive(pending: PendingFocus | null): pending is PendingFocus {
        try {
            return pending !== null && this.pendingFocus === pending && pending.epoch === this.focusEpoch && this.scene.scene.isActive();
        } catch {
            // Phaser tears down ScenePlugin internals before every outstanding
            // map promise necessarily resumes.
            return false;
        }
    }

    /** Complete deterministic placeholders when an old/offline map response is unavailable. */
    private fallbackFocusPlots(target: { x: number; y: number }, radius: number): WorldMapPlot[] {
        const plots: WorldMapPlot[] = [];
        const minY = Math.max(-WORLD_COORD_LIMIT, target.y - radius);
        const maxY = Math.min(WORLD_COORD_LIMIT, target.y + radius);
        const minX = Math.max(-WORLD_COORD_LIMIT, target.x - radius);
        const maxX = Math.min(WORLD_COORD_LIMIT, target.x + radius);
        for (let y = minY; y <= maxY; y++) {
            for (let x = minX; x <= maxX; x++) {
                plots.push({
                    x,
                    y,
                    kind: 'empty',
                    settleable: !isWildernessPreserveAt(x, y, this.presentationSeedVersion)
                });
            }
        }
        return plots;
    }

    /** Resolve once the pre-render is done, or fail closed after the deadline. */
    async waitForFocusReady(timeoutMs = 8000): Promise<boolean> {
        const pending = this.pendingFocus;
        if (!pending) return false;
        const deadline = Date.now() + Math.max(0, timeoutMs);
        // Never commit a partially painted ring. Current map responses carry
        // snapshots in one request, so this normally resolves well under 1 s.
        while (this.focusIsLive(pending) && !pending.ready && Date.now() < deadline) {
            await new Promise(resolve => setTimeout(resolve, 40));
        }
        if (!this.focusIsLive(pending) || !pending.ready) {
            // Invalidating the exact pending object also makes its async
            // renderer stop at the next epoch/identity guard.
            if (this.pendingFocus === pending) this.dropPendingFocus();
            return false;
        }
        return true;
    }

    /**
     * The swap itself: pure synchronous mutation — old postcards out, the
     * prepared set in, all in the same frame the battle appears. Nothing to
     * see; that is the point.
     */
    commitFocus(): { dx: number; dy: number } | null {
        const pending = this.pendingFocus;
        if (!pending || !pending.ready) return null;
        this.pendingFocus = null;
        if (!this.focusPlot && !this.parkedHomeViews) {
            // First hop away from HOME: retain the exact rendered ring. Shared
            // resident registries must move to the battle views, so park their
            // owners while keeping the expensive RenderTextures alive.
            this.parkedHomeViews = this.views;
            this.parkedHomeKindHints = new Map(this.knownPlotKindHints);
            for (const view of this.parkedHomeViews.values()) {
                this.setViewParked(view, true);
                // Keep the immediately visible 3x3 exact. Far-ring metadata
                // remains reusable, but release its GPU surface while raiding.
                if (Math.max(Math.abs(view.dx), Math.abs(view.dy)) > 1) {
                    this.releaseViewVisuals(view, false);
                }
            }
        } else {
            // NEXT while already raiding: only the current battle ring is stale.
            for (const view of this.views.values()) this.destroyView(view);
        }
        this.views = pending.views;
        for (const view of this.views.values()) {
            view.rt?.setVisible(true);
            // The prepared ring is the visible world NOW. It takes ownership
            // of the shared per-key registries (villager sims + night
            // lights) the old ring released above — including plots the two
            // rings share, whose registrations the deferral kept alive on
            // the old ring right until this frame.
            if (!view.residentsRegistered) this.registerVillageResidents(view);
        }
        // The whole frame re-anchors on the target plot — everyone WALKING
        // the roads must re-anchor with it, or the fading column and every
        // traveller would jump by exactly one plot at the swap. The current
        // anchor is the focused plot when a battle frame is already up (the
        // homecoming swap), home otherwise (the invasion swap).
        const anchor = this.focusPlot ?? this.myPlot;
        const shiftPlotsX = pending.target.x - anchor.x;
        const shiftPlotsY = pending.target.y - anchor.y;
        const shiftX = shiftPlotsX * PLOT_PITCH;
        const shiftY = shiftPlotsY * PLOT_PITCH;
        for (const trav of this.travellers) {
            trav.x -= shiftX;
            trav.y -= shiftY;
            trav.tx -= shiftX;
            trav.ty -= shiftY;
            if (trav.lightId !== null) {
                const fire = this.campfireGrid(trav);
                this.scene.dayNight?.moveTransientLight?.(trav.lightId, fire.gx, fire.gy);
            }
        }
        if (this.caravan) {
            this.caravan.x -= shiftX;
            this.caravan.y -= shiftY;
            for (const pt of this.caravan.points) {
                pt.x -= shiftX;
                pt.y -= shiftY;
            }
            // A homecoming column is still mid-glide at its swap: its camera
            // plan must re-anchor with the world or the glide would jump.
            const isoShift = IsoUtils.cartToIso(shiftX, shiftY);
            this.caravan.camStart.x -= isoShift.x;
            this.caravan.camStart.y -= isoShift.y;
            this.caravan.camTarget.x -= isoShift.x;
            this.caravan.camTarget.y -= isoShift.y;
            if (this.caravan.lightId !== null) {
                this.scene.dayNight?.moveTransientLight?.(this.caravan.lightId, this.caravan.x + 0.6, this.caravan.y + 0.6);
            }
        }
        const homeAgain = pending.target.x === this.myPlot.x && pending.target.y === this.myPlot.y;
        this.focusPlot = homeAgain ? null : { ...pending.target };
        if (homeAgain && this.parkedHomeViews) {
            // The legacy prepared-homecoming path supplied a newer complete
            // home ring. It supersedes the parked invasion snapshot.
            for (const view of this.parkedHomeViews.values()) this.destroyView(view);
            this.parkedHomeViews.clear();
            this.parkedHomeViews = null;
            this.parkedHomeKindHints = null;
        }
        // Focused battles get at least one visible world ring even when the
        // player's home sight is zero. Rebuild the fog in the swap frame so
        // the prepared neighboring villages are not immediately covered by
        // the old one-plot cloud mask. This frame the scene may still hold
        // the ENEMY's buildings (the homecoming swap restores mine one call
        // later), so the evaluation is UNTRUSTED — it reads the last trusted
        // radius without mutating sight state — and the swap flag makes the
        // next steady HOME evaluation re-baseline instead of diffing.
        this.sightSwapPending = true;
        this.ensureFog(this.computeViewRadius());
        this.rebuildWildernessLinks(pending.target);
        // Home again: refresh immediately — with revisions recorded the pass
        // only recreates the nameplates; every postcard is reused as-is.
        if (homeAgain) this.nextRefreshAt = 0;
        return { dx: shiftPlotsX, dy: shiftPlotsY };
    }

    /**
     * Back home. Returns true when the retained home ring was restored and the
     * caller may skip a blocking map prime; a revision refresh is scheduled in
     * the background immediately afterward.
     */
    endFocus(): boolean {
        this.dropPendingFocus();
        if (!this.focusPlot) return false;
        this.focusPlot = null;
        if (!this.parkedHomeViews) {
            this.teardown();
            this.nextRefreshAt = 0;
            return false;
        }

        this.fenceMapRequests();
        for (const view of this.views.values()) this.destroyView(view);
        this.views = this.parkedHomeViews;
        this.parkedHomeViews = null;
        if (this.parkedHomeKindHints) this.knownPlotKindHints = this.parkedHomeKindHints;
        this.parkedHomeKindHints = null;
        for (const view of this.views.values()) this.setViewParked(view, false);
        this.sightSwapPending = true;
        this.ensureFog(this.computeViewRadius());
        this.rebuildWildernessLinks(this.myPlot);
        // Reveal can use the retained ring now. Authority catches up just after
        // the transition instead of extending the opaque cloud hold.
        const now = this.lastUpdateTime || this.scene.time?.now || 0;
        this.nextRefreshAt = now + 250;
        return true;
    }

    /** Hide/show a retained view without discarding its GPU texture or source. */
    private setViewParked(view: NeighborView, parked: boolean) {
        if (parked && view.residentsRegistered) {
            this.scene.dayNight?.clearPostcardLights?.(view.key);
            this.neighborLifeSim?.removeVillage(view.key);
            view.residentsRegistered = false;
        }
        view.rt?.setVisible(!parked);
        view.battle?.setVisible(!parked);
        view.life?.setVisible(!parked);
        view.glow?.setVisible(!parked);
        if (parked) view.battleTween?.pause();
        else {
            view.battleTween?.resume();
            if (!view.residentsRegistered) this.registerVillageResidents(view);
        }
    }

    private dropPendingFocus() {
        const pending = this.pendingFocus;
        if (!pending) return;
        this.pendingFocus = null;
        for (const view of pending.views.values()) this.destroyView(view);
    }

    /** The owner's explicit heraldry; no saved choice means no war standard. */
    private myWarBanner(): FlagDesign | null {
        const identity = this.scene.userId || 'village';
        const banner = sanitizeVillageBanner(Backend.getCachedWorld(identity)?.banner);
        return banner ? bannerDesignFor(identity, banner) : null;
    }

    /**
     * Send the army down the roads: a banner-carrier, the supply cart and a
     * column of troops march from the home gate along the border roads to the
     * neighbour's plot. The camera rides along; onArrive fires at their gate.
     */
    marchTo(
        targetAbs: { x: number; y: number },
        _figures: string[],
        onArrive: () => void,
        onCancel?: () => void
    ) {
        this.cancelMarch();
        const offset = this.travelOffsetFor(targetAbs.x, targetAbs.y);
        if (!offset) {
            onArrive();
            return;
        }
        const { dx, dy } = offset;
        const T = { x: dx * PLOT_PITCH + PLOT_TILES / 2, y: dy * PLOT_PITCH + PLOT_TILES / 2 };
        const points = WorldMapSystem.roadRouteToPlot(dx, dy);
        // Route length (for the camera's progress) and the camera plan: glide
        // from wherever the player is looking to EXACTLY the frame the battle
        // will open on — centred on the target village.
        let totalLen = 0;
        for (let i = 1; i < points.length; i++) {
            totalLen += Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y);
        }
        const cam = this.scene.cameras.main;
        const camStart = { x: cam.worldView.centerX, y: cam.worldView.centerY };
        const targetIso = IsoUtils.cartToIso(T.x, T.y);
        const gfx = this.scene.add.graphics();
        this.caravan = {
            points,
            seg: 1,
            x: points[0].x,
            y: points[0].y,
            gfx,
            onArrive,
            onCancel,
            lastTime: 0,
            arriving: false,
            walked: 0,
            totalLen: Math.max(0.001, totalLen),
            camStart,
            camTarget: { x: targetIso.x, y: targetIso.y },
            state: 'march',
            lightId: null,
            homecoming: false,
            swapFired: false,
            // A declaration of war travels light: ONE bearer under the huge
            // flag. The army musters at the gate once the standard is down.
            escorts: [],
            escortCarriers: [],
            speed: 0.0075 * Math.max(1, totalLen / 55),
            clothDir: 0,
            clothClimb: 0,
            flag: this.myWarBanner()
        };
        soundSystem.play('horn');
    }

    /**
     * The road route from the home village centre to a halt BESIDE the
     * neighbour's gate, in home-anchored tile coords. The column HALTS on
     * the road at the village gate — an army waits at the walls; it does
     * not stroll into the square. That road point is where the battle takes
     * over (and, reversed, where the journey home begins).
     */
    private static roadRouteToPlot(dx: number, dy: number): Array<{ x: number; y: number }> {
        const T = { x: dx * PLOT_PITCH + PLOT_TILES / 2, y: dy * PLOT_PITCH + PLOT_TILES / 2 };
        const points: Array<{ x: number; y: number }> = [{ x: PLOT_TILES / 2, y: PLOT_TILES / 2 }];
        // Step off the lawn onto the ring road around home (biased toward
        // the target), walk the horizontal lane the WHOLE way to the
        // vertical lane hugging the target's column — however many plots
        // that crosses — then down it to halt beside their gate. Every leg
        // stays on the road grid, so a ring-5 village is reached the same
        // way a neighbour is.
        const hy = dy > 0 ? PLOT_TILES + 1 : dy < 0 ? -1 : PLOT_TILES + 1;
        points.push({ x: PLOT_TILES / 2, y: hy });
        const vx = dx > 0
            ? dx * PLOT_PITCH - 1
            : dx < 0
                ? dx * PLOT_PITCH + PLOT_TILES + 1
                : PLOT_TILES + 1;
        if (Math.abs(vx - PLOT_TILES / 2) > 0.01) points.push({ x: vx, y: hy });
        points.push({ x: vx, y: T.y }); // halt beside their gate
        return points;
    }

    /**
     * Roll the column HOME after an in-place battle: the same roads in
     * reverse, expressed in the battle frame (the fought plot is the local
     * origin now). The world stays on the battle frame the whole way —
     * `onSwap` fires as the wagons near the home gate so the prepared home
     * frame commits mid-glide, then the column walks into the now-live
     * village and disbands. No camp, no clouds, no fade.
     */
    marchHome(escorts: string[], onSwap: () => void, onCancel?: () => void) {
        const focus = this.focusPlot;
        if (!focus) {
            onSwap();
            return;
        }
        this.cancelMarch(true); // the war camp strikes its tent
        soundSystem.setBattleMusic(false); // the drums fall silent
        const dx = focus.x - this.myPlot.x;
        const dy = focus.y - this.myPlot.y;
        const points = WorldMapSystem.roadRouteToPlot(dx, dy)
            .map(p => ({ x: p.x - dx * PLOT_PITCH, y: p.y - dy * PLOT_PITCH }))
            .reverse();
        // The column melts away in the yard, a few tiles shy of the town
        // square — nobody vanishes on the doorstep.
        {
            const last = points[points.length - 1];
            const prev = points[points.length - 2] ?? last;
            const legLen = Math.hypot(last.x - prev.x, last.y - prev.y) || 1;
            const inset = Math.max(3, legLen - 3.5);
            points[points.length - 1] = {
                x: prev.x + ((last.x - prev.x) / legLen) * inset,
                y: prev.y + ((last.y - prev.y) / legLen) * inset
            };
        }
        let totalLen = 0;
        for (let i = 1; i < points.length; i++) {
            totalLen += Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y);
        }
        const cam = this.scene.cameras.main;
        const homeCentre = IsoUtils.cartToIso(PLOT_TILES / 2 - dx * PLOT_PITCH, PLOT_TILES / 2 - dy * PLOT_PITCH);
        this.caravan = {
            points,
            seg: 1,
            x: points[0].x,
            y: points[0].y,
            gfx: this.scene.add.graphics(),
            onArrive: onSwap,
            onCancel,
            lastTime: 0,
            arriving: false,
            walked: 0,
            totalLen: Math.max(0.001, totalLen),
            camStart: { x: cam.worldView.centerX, y: cam.worldView.centerY },
            camTarget: { x: homeCentre.x, y: homeCentre.y },
            state: 'march',
            lightId: null,
            homecoming: true,
            swapFired: false,
            escorts: escorts.slice(0, 24),
            escortCarriers: [],
            speed: 0.0075 * Math.max(1, totalLen / 55),
            clothDir: 0,
            clothClimb: 0,
            flag: this.myWarBanner()
        };
        soundSystem.play('horn');
    }

    /**
     * The war camp WITHOUT the journey: the standard is already planted and
     * the bearer already stands at their gate. Cloud-transition attacks call
     * this right after `commitFocus`, in the same synchronous frame, so the
     * very first visible frame shows him in his final place — no march, no
     * movement, and no `onArrive` (the caller drives the battle itself).
     * `homeOffset` is the target's plot offset from home (its sign picks the
     * gate side and facing the column WOULD have arrived with).
     */
    plantWarCamp(homeOffset: { dx: number; dy: number } | null) {
        this.cancelMarch(true); // a NEXT raid replants at the new gate
        const dx = homeOffset?.dx ?? 1;
        const dy = homeOffset?.dy ?? 0;
        // The halt point of roadRouteToPlot, expressed in the battle frame
        // (the fought plot is the local origin after commitFocus): the
        // vertical road lane hugging the gate-side edge, at mid-height.
        const haltX = dx > 0 ? -1 : PLOT_TILES + 1;
        const haltY = PLOT_TILES / 2;
        // The final leg the column would have walked decides his facing.
        const legDir = dy > 0 ? 1 : -1;
        const haltIso = IsoUtils.cartToIso(haltX, haltY);
        this.caravan = {
            points: [{ x: haltX, y: haltY - legDir }, { x: haltX, y: haltY }],
            seg: 1,
            x: haltX,
            y: haltY,
            gfx: this.scene.add.graphics(),
            onArrive: () => undefined,
            lastTime: 0,
            arriving: true, // committed: mode changes must not cancel the camp
            walked: 1,
            totalLen: 1,
            camStart: { x: haltIso.x, y: haltIso.y },
            camTarget: { x: haltIso.x, y: haltIso.y },
            state: 'camp',
            lightId: null,
            homecoming: false,
            swapFired: false,
            escorts: [],
            escortCarriers: [],
            speed: 0,
            clothDir: 0,
            clothClimb: 0,
            flag: this.myWarBanner()
        };
        // The audio handover that used to fire when the planting finished.
        soundSystem.setBattleMusic(true);
        soundSystem.play('horn');
    }

    /** True while the local grid still hosts a neighbour's plot (battle or retreat). */
    inBattleFrame(): boolean {
        return this.focusPlot !== null;
    }

    /** My village's absolute plot (the homecoming march target). */
    homePlot(): { x: number; y: number } {
        return { ...this.myPlot };
    }

    /**
     * What a raindrop lands on at a SCENE-grid point outside the live plot:
     * open water, the damp bank ringing it, or default grass. Consults the
     * shared world hydrology (absolute geometry, no postcard needed) and the
     * plot-local lake/brook contours kept from wilderness postcard renders.
     */
    rainSurfaceAt(gx: number, gy: number): 'water' | 'bank' | 'grass' {
        const anchor = this.focusPlot ?? this.myPlot;
        const plotDx = Math.floor(gx / PLOT_PITCH);
        const plotDy = Math.floor(gy / PLOT_PITCH);
        const localX = gx - plotDx * PLOT_PITCH;
        const localY = gy - plotDy * PLOT_PITCH;
        const onRoadBand = localX >= PLOT_TILES || localY >= PLOT_TILES;
        const plotX = anchor.x + plotDx;
        const plotY = anchor.y + plotDy;

        const worldX = plotX * PLOT_PITCH + localX;
        const worldY = plotY * PLOT_PITCH + localY;
        // World hydrology first — it also flows THROUGH the border-road
        // bands (the road yields to water), so this runs before the road
        // early-out. Classification mirrors the renderer: lake body, then
        // everything drawFeature paints beyond it (variable-width ribbons
        // with their mouth flares, spring pools, wetland sink lobes).
        for (const feature of hydrologyFeaturesForPlot(plotX, plotY, this.presentationSeedVersion)) {
            if (featureContainsWorldPoint(feature, worldX, worldY)) return 'water';
            const drawn = WorldHydrologyRenderer.classifyDrawnSurfaceAt(feature, worldX, worldY);
            if (drawn === 'water') return 'water';
            if (drawn === 'bank' || featureContainsWorldPoint(feature, worldX, worldY, 'bank')) return 'bank';
        }
        // Off the water, the border roads shed rain like the lawn does.
        if (onRoadBand) return 'grass';

        const view = this.views.get(`${plotX},${plotY}`);
        if (view?.contentKind !== 'nature' || !view.natureWaters) return 'grass';
        for (const lake of view.natureWaters.lakes) {
            if (lake.contains(localX, localY)) return 'water';
            if (lake.contains(localX, localY, 'bank')) return 'bank';
        }
        for (const stream of view.natureWaters.streams) {
            const d = WorldMapSystem.distanceToPolyline(stream.points, localX, localY);
            if (d <= stream.halfWidth) return 'water';
            if (d <= stream.halfWidth * 1.35) return 'bank';
        }
        return 'grass';
    }

    private static distanceToPolyline(
        points: readonly { x: number; y: number }[],
        x: number,
        y: number
    ): number {
        let best = Number.POSITIVE_INFINITY;
        for (let i = 1; i < points.length; i++) {
            const a = points[i - 1];
            const b = points[i];
            const dx = b.x - a.x;
            const dy = b.y - a.y;
            const t = Math.max(0, Math.min(1, ((x - a.x) * dx + (y - a.y) * dy) / (dx * dx + dy * dy || 1)));
            best = Math.min(best, Math.hypot(x - (a.x + dx * t), y - (a.y + dy * t)));
        }
        return best;
    }

    /** Drop a homecoming column without firing its callbacks (interrupts). */
    abortHomecoming() {
        if (this.caravan?.homecoming) this.cancelMarch(true);
    }

    private cancelMarch(silent = false) {
        const c = this.caravan;
        if (!c) return;
        if (!c.homecoming && c.state !== 'camp') soundSystem.setBattleMusic(false);
        this.caravan = null;
        c.gfx.destroy();
        for (const carrier of c.escortCarriers) carrier?.destroy();
        c.escortCarriers.length = 0;
        if (c.lightId !== null) this.scene.dayNight?.removeTransientLight(c.lightId);
        if (!c.arriving && !silent) c.onCancel?.();
    }

    private updateCaravan(time: number) {
        const c = this.caravan;
        if (!c) return;
        // Marching column + camp are per-frame vector figures: smooth until
        // their sprite bake lands (tools/art-preview/AGENTS_SPRITE_PIPELINE.md step 5).
        // Any other transition (cloud raid, replay) cancels the march — but a
        // caravan that has ARRIVED is mid-handover to the battle: leave it be.
        if (this.scene.mode !== 'HOME' && !c.arriving) {
            this.cancelMarch();
            return;
        }
        const delta = c.lastTime === 0 ? 16.667 : Math.min(250, Math.max(0, time - c.lastTime));
        c.lastTime = time;
        if (!c.arriving) {
            const target = c.points[c.seg];
            const dx = target.x - c.x;
            const dy = target.y - c.y;
            const dist = Math.hypot(dx, dy);
            const step = c.speed * delta;
            // Cloth physics: the flag streams OPPOSITE the travel, eased so
            // a corner reads as the cloth swinging around the pole.
            if (dist > 0.001) {
                const sdx = (dx - dy) / dist; // screen-x of the heading
                const sdy = (dx + dy) * 0.5 / dist;
                const sm = Math.hypot(sdx, sdy) || 1;
                const wantDir = Math.abs(sdx) > 0.05 ? -Math.sign(sdx) : c.clothDir;
                const k = Math.min(1, delta * 0.004);
                c.clothDir += (wantDir - c.clothDir) * k;
                c.clothClimb += (sdy / sm - c.clothClimb) * k;
            }
            if (dist <= step) {
                c.x = target.x;
                c.y = target.y;
                c.walked += dist;
                if (c.seg >= c.points.length - 1) {
                    if (c.homecoming) {
                        // The bearer is home; the column keeps filing in
                        // behind him, each figure slipping away as it reaches
                        // the yard. The caravan ends when the last one has.
                        c.walked += step;
                        const maxBack = 2.6 + Math.floor(Math.max(0, c.escorts.length - 1) / 2) * 2.1;
                        if (c.walked - maxBack > c.totalLen + 1) {
                            this.cancelMarch(true);
                            return;
                        }
                    } else {
                        // At their gate: the bearer PLANTS the standard —
                        // hoist, drive it into the soil, step back — and only
                        // then does the battle take over. An arrived march is
                        // committed (no onCancel from here).
                        c.arriving = true;
                        c.state = 'plant';
                        c.plantStartedAt = time;
                        c.onCancel = undefined;
                        soundSystem.play('thud');
                    }
                } else {
                    c.seg += 1;
                }
            } else {
                c.x += (dx / dist) * step;
                c.y += (dy / dist) * step;
                c.walked += step;
            }
        }

        if (c.state === 'plant' && c.plantStartedAt !== undefined && time - c.plantStartedAt >= 1250) {
            c.state = 'camp';
            // The shift you can HEAR: the drums take over as the fight opens.
            soundSystem.setBattleMusic(true);
            soundSystem.play('horn');
            c.onArrive();
        }

        if (!c.arriving && c.homecoming && !c.swapFired && c.walked / c.totalLen >= 0.78) {
            // Nearing the home gate: the prepared home frame commits NOW,
            // mid-glide — world and camera re-anchor by the same delta, so
            // nothing under the lens moves. The column keeps walking.
            c.swapFired = true;
            c.onArrive();
        }

        if (!c.arriving) {
            // The camera doesn't chase the column — it GLIDES from where the
            // player was to exactly the frame the battle opens on, eased by
            // march progress. At the gate the two are pixel-identical, so the
            // handover cannot jump.
            const p = Math.min(1, c.walked / c.totalLen);
            const eased = p * p * (3 - 2 * p); // smoothstep
            const cam = this.scene.cameras.main;
            const cx = c.camStart.x + (c.camTarget.x - c.camStart.x) * eased;
            const cy = c.camStart.y + (c.camTarget.y - c.camStart.y) * eased;
            // Phaser's camera midpoint is scroll + size/2 REGARDLESS of zoom —
            // dividing by zoom here is what left the battle off-centre.
            cam.scrollX = cx - cam.width / 2;
            cam.scrollY = cy - cam.height / 2;
        }
        this.drawCaravan(c, time);
    }

    /**
     * Painter depth for anything walking the roads: which plot-band it is in
     * decides whether it draws over the NW postcards, with the home plot, or
     * under the SE ones — half-steps keep it clear of the postcards' own depths.
     */
    private roadDepthAt(x: number, y: number): number {
        // Plot bands are centred at 12.5 + n*PITCH, not n*PITCH. Without the
        // half-plot offset a column jumped to the SE postcard layer while it
        // was still crossing the middle of its own lawn.
        const dz = Math.round((x - PLOT_TILES / 2) / PLOT_PITCH)
            + Math.round((y - PLOT_TILES / 2) / PLOT_PITCH);
        if (dz === 0) {
            // Home band: sort WITH the live village by painter's order (the
            // DepthSystem row formula) instead of a flat sub-1000 constant.
            // A war camp planted at an east/south gate stands in FRONT of
            // most buildings (larger x+y) and now paints over them, while a
            // camp on the north/west side keeps a smaller row sum and stays
            // correctly behind — the flat 785 hid every camp behind the
            // whole village. Stays above the home postcard (780) and far
            // below the SE band (26 000+).
            return 1000 + (x + y) * 100 + (x - y);
        }
        return dz < 0 ? 420.5 + dz : 26_000.5 + dz;
    }

    private drawCaravan(
        c: {
            points: Array<{ x: number; y: number }>;
            seg: number;
            x: number;
            y: number;
            gfx: Phaser.GameObjects.Graphics;
            walked: number;
            totalLen: number;
            state: 'march' | 'plant' | 'camp';
            plantStartedAt?: number;
            speed: number;
            clothDir: number;
            clothClimb: number;
            homecoming: boolean;
            escorts: string[];
            escortCarriers: Array<Phaser.GameObjects.Graphics | null>;
            flag: FlagDesign | null;
        },
        time: number
    ) {
        const g = c.gfx;
        g.clear();
        if (!c.flag) return;
        g.setDepth(this.roadDepthAt(c.x, c.y));

        if (c.state !== 'march') {
            // The column only draws while marching (outbound escorts are
            // empty; homecoming never leaves 'march') — never let a stale
            // sprite carrier outlive the state the way a cleared vector
            // graphics never could.
            for (let i = 0; i < c.escortCarriers.length; i++) {
                c.escortCarriers[i]?.destroy();
                c.escortCarriers[i] = null;
            }
        }

        if (c.state === 'march') {
            // A small bearer under a HUGE flag leads; the actual troops
            // follow two abreast, snaking the same road behind him.
            const homebound = c.homecoming;
            if (!homebound || c.walked < c.totalLen - 0.05) {
                const lead = WorldMapSystem.routePoint(c.points, Math.min(c.walked, c.totalLen));
                const leadPos = IsoUtils.cartToIso(lead.x, lead.y);
                const leadFacing = lead.fx - lead.fy >= 0 ? 1 : -1;
                drawFlagBearer(g, leadPos.x, leadPos.y, time, c.flag, leadFacing, true,
                    { dir: c.clothDir, speed: 1, climb: c.clothClimb });
            }

            c.escorts.forEach((type, e) => {
                const back = 2.6 + Math.floor(e / 2) * 2.1;
                const along = c.walked - back;
                // Home: each figure slips away as it reaches the yard.
                if (homebound && along >= c.totalLen - 0.05) {
                    // Retire its sprite carrier for good — the walk is monotonic.
                    c.escortCarriers[e]?.destroy();
                    c.escortCarriers[e] = null;
                    return;
                }
                const at = WorldMapSystem.routePoint(c.points, Math.max(0, along));
                const side = (e % 2 === 0 ? 1 : -1) * 0.8;
                let px = at.x - at.fy * side;
                let py = at.y + at.fx * side;
                if (along < 0) {
                    // Not yet under way: a compressed queue trailing the start.
                    px -= at.fx * Math.min(4.5, -along * 0.4);
                    py -= at.fy * Math.min(4.5, -along * 0.4);
                }
                const pos = IsoUtils.cartToIso(px, py);
                // One troop on foot, cloaked in its type colour — the column
                // LOOKS like your army (wobble seed staggers each rank).
                // Baked-sprite path: each escort rides its own carrier so the
                // whole rank shows caravan_soldier walk frames. The march
                // wobble |sin(time*0.009 + e*1.31)| loops every π/0.009 ms
                // (~349); the rank seed folds in as its exact time offset.
                let carrier = c.escortCarriers[e];
                if (!carrier) {
                    carrier = this.scene.add.graphics();
                    c.escortCarriers[e] = carrier;
                }
                carrier.setDepth(g.depth); // same painter band as the column's shared g
                const phase = ((time + (e * 1.31) / 0.009) % (Math.PI / 0.009)) / (Math.PI / 0.009);
                if (!SpriteBank.syncFigure(this.scene, carrier, 'caravan_soldier', type, 'walk', phase,
                    false, { kind: 'figures', at: { x: pos.x, y: pos.y } })) {
                    // No bake (or sprites off): the old inline vector column.
                    SpriteBank.release(carrier);
                    WorldFigureRenderer.drawCaravanSoldier(g, pos.x, pos.y, type, time, e * 1.31);
                }
            });
            return;
        }

        if (c.state === 'plant') {
            // ---- THE PLANTING: hoist high, drive it home, step back ----
            const p = Math.min(1, (time - (c.plantStartedAt ?? time)) / 1250);
            const hoist = Math.min(1, p / 0.48);                       // pole climbs overhead
            const thrust = Math.min(1, Math.max(0, (p - 0.48) / 0.14)); // driven into the soil
            const settle = Math.max(0, (p - 0.62) / 0.38);              // he lets go, steps back
            const at = WorldMapSystem.routePoint(c.points, c.walked);
            const pos = IsoUtils.cartToIso(c.x, c.y);
            const facing = at.fx - at.fy >= 0 ? 1 : -1;
            const groundY = pos.y + 2;
            // The pole rises with the hoist, slams down with the thrust —
            // a hair of overshoot so the strike lands with weight.
            const lift = Math.sin(hoist * Math.PI * 0.5) * 9 * (1 - thrust)
                + (thrust >= 1 && settle < 0.15 ? -1.2 * (1 - settle / 0.15) : 0);
            drawVillageFlag(g, pos.x + facing * 1.3, groundY - lift, time, c.flag, facing, { marching: false });
            // The strike kicks up a ring of dust — perimeter pixel cells.
            if (thrust > 0 && settle < 0.6) {
                const dust = Math.min(1, thrust * 0.4 + settle);
                const ringW = 8 + dust * 22;
                pixelRing(g, pos.x + facing * 1.3, groundY, ringW / 2, ringW * 0.42 / 2,
                    0xbfae8e, 0.5 * (1 - dust));
            }
            // The bearer: gripping through the hoist, stepping back after.
            const bx = pos.x - facing * (2 + 6 * settle);
            const bob = thrust > 0 && thrust < 1 ? 1.4 : 0;
            pixelEllipse(g, bx, groundY + 1, 4.5, 1.7, 0x000000, 0.16);
            pixelTriangleRows(g, bx, groundY - 10.5 + bob, bx - 3.6, bx + 3.6, groundY, c.flag.field);
            pixelEllipse(g, bx, groundY - 11.6 + bob, 2.1, 2.1, 0xd9b38c, 1);
            if (settle < 0.4) {
                // Both fists still on the pole, high from the hoist.
                pixelEllipse(g, pos.x + facing * 0.4, groundY - 12 - lift * 0.6, 1.1, 1.1, 0xd9b38c, 1);
                pixelEllipse(g, pos.x + facing * 0.1, groundY - 8.5 - lift * 0.6, 1.1, 1.1, 0xd9b38c, 1);
            }
            return;
        }

        // ---- HALTED AT THEIR GATE: the flag is planted and he STAYS ----
        // The bearer stands ALONE beside the standard for the whole battle —
        // no honour guard, no rank of troops; the army exists only as what
        // you deploy onto the field itself.
        const halt = WorldMapSystem.routePoint(c.points, c.walked);
        const bearerAt = IsoUtils.cartToIso(c.x, c.y);
        const facing = halt.fx - halt.fy >= 0 ? 1 : -1;
        drawFlagBearer(g, bearerAt.x, bearerAt.y, time, c.flag, facing, false);
    }

    // ---- travellers on the border roads ----

    private travellers: Array<{
        kind: 'wanderer' | 'courier' | 'shepherd' | 'patrol' | 'monk' | 'hunter' | 'woodcutter' | 'marketgoer';
        x: number; y: number;
        tx: number; ty: number;
        speed: number;
        gfx: Phaser.GameObjects.Graphics;
        seed: number;
        state: 'walk' | 'camp';
        campUntil: number;
        camped: boolean;
        lightId: number | null;
        routeLength: number;
        campProgress: number;
        lastDrawTick?: number;
    }> = [];
    private nextTravellerAt = 0;
    private lastTravellerUpdateAt = 0;

    /** A road lane just outside the village plots (the 2-tile border gaps). */
    private randomRoadLane(): { x: number; y: number; tx: number; ty: number } {
        // Traffic stays on one of the four guaranteed roads touching the live
        // settlement. Farther segments can legitimately be reclaimed when
        // wilderness meets wilderness, so a wanderer must not walk an
        // invisible highway through the joined forest.
        const LO = 1;
        const HI = PLOT_TILES - 1;
        const lanePos = [-1.4, PLOT_TILES + 1.0][Math.floor(Math.random() * 2)];
        const forward = Math.random() < 0.5;
        if (Math.random() < 0.5) {
            return { x: forward ? LO : HI, y: lanePos, tx: forward ? HI : LO, ty: lanePos };
        }
        return { x: lanePos, y: forward ? LO : HI, tx: lanePos, ty: forward ? HI : LO };
    }

    /**
     * Where a camped traveller's bonfire actually burns, in grid coords.
     * The camp frame (WorldFigureRenderer's camp pose, baked or vector)
     * draws the fire ~9.5 screen px from the figure toward the walking
     * direction — the runtime flip-X mirrors it — sitting on the ground
     * line. The firelight pool must project THERE; the old fixed +0.7gx
     * offset parked the glow ~1.4 tiles ESE of the flames on empty road.
     * Screen→grid inverse: dgx = dsx/64 + dsy/32, dgy = dsy/32 − dsx/64.
     */
    private campfireGrid(trav: { x: number; y: number; tx: number }): { gx: number; gy: number } {
        const facing = trav.tx >= trav.x ? 1 : -1; // drawTraveller's flip rule
        const dsx = 9.5 * facing; // flame centre in the camp frame
        const dsy = 0.5;          // the fire sits on the figure's ground line
        return {
            gx: trav.x + dsx / TILE_WIDTH + dsy / TILE_HEIGHT,
            gy: trav.y + dsy / TILE_HEIGHT - dsx / TILE_WIDTH
        };
    }

    /**
     * Lone wanderers pass along the roads between villages — and at night
     * some stop, strike a bonfire on the shoulder and warm themselves until
     * the dark thins out. The world between the walls has lives of its own.
     */
    private updateTravellers(time: number) {
        const delta = this.lastTravellerUpdateAt === 0 ? 16.667 : Math.min(250, Math.max(0, time - this.lastTravellerUpdateAt));
        this.lastTravellerUpdateAt = time;
        if (this.views.size === 0) return; // no world map yet
        if (time >= this.nextTravellerAt && this.travellers.length < 8) {
            this.nextTravellerAt = time + 8_000 + Math.random() * 14_000;
            const lane = this.randomRoadLane();
            const gfx = this.scene.add.graphics();
            // The roads carry a whole cast of folk on foot.
            const kinds = ['wanderer', 'courier', 'shepherd', 'patrol', 'monk', 'hunter', 'woodcutter', 'marketgoer'] as const;
            const kind = kinds[Math.floor(Math.random() * kinds.length)];
            const speed =
                kind === 'courier' ? 0.0034 :
                kind === 'shepherd' ? 0.0009 :
                kind === 'patrol' ? 0.0015 :
                kind === 'monk' ? 0.001 :
                kind === 'hunter' ? 0.0017 :
                kind === 'woodcutter' ? 0.0012 :
                kind === 'marketgoer' ? 0.0014 :
                0.0013 + Math.random() * 0.0007;
            const seed = Math.floor(Math.random() * 1e6);
            this.travellers.push({
                kind,
                x: lane.x, y: lane.y, tx: lane.tx, ty: lane.ty,
                speed,
                gfx,
                seed,
                state: 'walk',
                campUntil: 0,
                camped: false,
                lightId: null,
                routeLength: Math.max(0.001, Math.hypot(lane.tx - lane.x, lane.ty - lane.y)),
                campProgress: 0.36 + ((seed % 1000) / 1000) * 0.28
            });
        }

        const nf = this.scene.dayNight?.nightFactor() ?? 0;
        for (let i = this.travellers.length - 1; i >= 0; i--) {
            const trav = this.travellers[i];
            const dx = trav.tx - trav.x;
            const dy = trav.ty - trav.y;
            const dist = Math.hypot(dx, dy);

            if (trav.state === 'walk') {
                if (dist < 0.3) {
                    this.removeTraveller(i);
                    continue;
                }
                const step = trav.speed * delta;
                trav.x += (dx / dist) * step;
                trav.y += (dy / dist) * step;
                // Nightfall on the road: foot travellers pitch camp once,
                // roughly mid-journey (couriers and the watch press on).
                const progress = 1 - dist / trav.routeLength;
                if ((trav.kind === 'wanderer' || trav.kind === 'shepherd' || trav.kind === 'monk' || trav.kind === 'woodcutter') && nf > 0.5 && !trav.camped && progress >= trav.campProgress) {
                    trav.camped = true;
                    trav.state = 'camp';
                    trav.campUntil = time + 90_000 + Math.random() * 120_000;
                    const fire = this.campfireGrid(trav);
                    trav.lightId = this.scene.dayNight?.addTransientLight({
                        gx: fire.gx,
                        gy: fire.gy,
                        radius: 46,
                        tint: 0xffa14a,
                        until: Date.now() + 6 * 60_000
                    }) ?? null;
                }
            } else if (time >= trav.campUntil || nf < 0.35) {
                // Dawn (or rested enough): douse the fire and walk on.
                if (trav.lightId !== null) this.scene.dayNight?.removeTransientLight(trav.lightId);
                trav.lightId = null;
                trav.state = 'walk';
            }

            this.drawTraveller(trav, time);
        }
    }

    private removeTraveller(index: number) {
        const trav = this.travellers[index];
        if (trav.lightId !== null) this.scene.dayNight?.removeTransientLight(trav.lightId);
        trav.gfx.destroy();
        this.travellers.splice(index, 1);
    }

    /**
     * Re-register the camped travellers' bonfire glows after
     * DayNightSystem.clearLights() wiped every transient light (scene
     * swap / home reload). The travellers survive those — their fires keep
     * burning on screen — so the glow must come back with them, not stay a
     * stale id pointing at a destroyed rig.
     */
    resyncTravellerLights() {
        for (const trav of this.travellers) {
            if (trav.state !== 'camp') continue;
            const fire = this.campfireGrid(trav);
            trav.lightId = this.scene.dayNight?.addTransientLight({
                gx: fire.gx,
                gy: fire.gy,
                radius: 46,
                tint: 0xffa14a,
                until: Date.now() + 6 * 60_000
            }) ?? null;
        }
    }

    private drawTraveller(trav: { kind: string; x: number; y: number; tx: number; ty: number; gfx: Phaser.GameObjects.Graphics; seed: number; state: 'walk' | 'camp'; lastDrawTick?: number }, time: number) {
        // Road walkers step on the shared figure clock, like every village.
        const tk = figureTick(time);
        if (trav.lastDrawTick === tk) return;
        trav.lastDrawTick = tk;
        const pos = IsoUtils.cartToIso(trav.x, trav.y);
        const wv = this.scene.cameras.main.worldView;
        const g = trav.gfx;
        g.clear();
        // The CARRIER owns position/depth even while culled: the baked shadow
        // sprite follows it per frame (SpriteBank.update), so a traveller that
        // walks on while off-view can't linger as a ghost at the cull edge.
        g.setPosition(pos.x, pos.y);
        g.setDepth(this.roadDepthAt(trav.x, trav.y));
        if (pos.x < wv.x - 60 || pos.x > wv.right + 60 || pos.y < wv.y - 60 || pos.y > wv.bottom + 60) return;

        const facing = trav.tx >= trav.x ? 1 : -1;
        // Baked-sprite path — gait loop π/0.008 (the |sin| bob), camp fire
        // loop 2π/0.02; the seed folds in as its exact time offset.
        const loop = trav.state === 'camp' ? (Math.PI * 2) / 0.02 : Math.PI / 0.008;
        const seedMs = trav.seed / (trav.state === 'camp' ? 0.02 : 0.008);
        const phase = ((((time + seedMs) % loop) + loop) % loop) / loop;
        if (SpriteBank.syncFigure(this.scene, g, `traveller_${trav.kind}`, 'c', trav.state, phase,
            facing === -1, { kind: 'figures' })) {
            return;
        }
        SpriteBank.release(g);
        // Carrier is positioned now — the vector figure draws at local origin.
        WorldFigureRenderer.drawTraveller(g, 0, 0, trav.kind, facing, time, trav.seed, trav.state);
    }


    // ================= neighbourhood refresh =================

    /** How far this player can see, in plots: 0 without a watchtower, then 1 or 2. */
    private viewRadiusValue = 1;
    /** The last sight radius confirmed on MY OWN roster. Foreign/mid-swap
     *  evaluations may clobber `viewRadiusValue` to size the fog, but they
     *  never touch this — so a gain earned while the player is away (a
     *  watchtower completing during a battle or replay) still diffs true on
     *  the frame their world returns, and plays its reveal exactly once. */
    private homeSightBaseline = 1;

    private computeViewRadius(trusted = false): number {
        // Only the HOME scene holds MY buildings; battles keep the last value.
        // ONE source of truth: the same shared sight function the server uses.
        // Only update()'s steady HOME tick passes `trusted`: every other call
        // site (focus swaps, async wilderness fallback, refresh, reveal
        // completion) can run while the scene holds a foreign world or
        // mid-swap state, so those evaluations never move the baseline, never
        // arm hydration and never begin (or cancel) a reveal — they just read
        // the last trusted value.
        if (trusted && this.scene.mode === 'HOME' && !this.focusPlot) {
            // Sight is EARNED AT COMPLETION: a freshly placed watchtower whose
            // scaffold is still up contributes nothing yet, so the clouds
            // retreat when the build finishes — together with the content the
            // completion-triggered refresh fetches — instead of exposing bare
            // meadow for the whole build. (Upgrades need no gate here: an
            // upgrading tower keeps its old `level` until the clock matures.)
            const underConstruction = (id: string | undefined) => Boolean(id
                && this.scene.villageLife?.isPlacementUnderConstruction?.(id));
            const all = this.scene.buildings ?? [];
            const standing = all.filter(b => b.health > 0
                && !(b.type === 'watchtower' && underConstruction(b.id)));
            const next = watchtowerSightOf(standing as never);
            // My world is on stage whenever no swap is pending. While one IS
            // pending the set may be the ENEMY's: only a roster overlap with
            // my last steady frame — or with the server's postcard of my own
            // plot (`serverHomeRosterIds`) — proves my world is back. A swap
            // raised before the local roster ever populated (an instant
            // replay opened on boot) therefore resolves against server truth,
            // never by adopting whatever roster happens to be on stage first:
            // an unproven set DEFERS (fog sized silently below) until the
            // next accepted map window supplies the proof.
            const mine = !this.sightSwapPending
                || (all.length > 0
                    && all.some(b => b.id && (this.homeBuildingIds.has(b.id)
                        || this.serverHomeRosterIds?.has(b.id))));
            if (!mine) {
                // Foreign (or possibly-foreign) building set: size the fog to
                // it silently and never move the HOME baseline — the reveal
                // diff survives the absence untouched.
                if (next !== this.viewRadiusValue) {
                    this.viewRadiusValue = next;
                    this.nextRefreshAt = 0;
                    this.cancelPendingFogReveal();
                    this.cancelFogReveal();
                }
            } else {
                const swapWasPending = this.sightSwapPending;
                this.sightSwapPending = false;
                const prev = this.homeSightBaseline;
                if (next !== prev) {
                    this.homeSightBaseline = next;
                    this.viewRadiusValue = next;
                    // Pulling the fog back without postcards underneath
                    // produces a blank meadow for the remainder of the normal
                    // 25 s cadence.
                    this.nextRefreshAt = 0;
                    // A real sight GAIN on my own roster earns the animated
                    // pull-back — including one that matured while the player
                    // was away in a battle or replay: the diff runs against
                    // the protected HOME baseline, so it plays exactly once,
                    // on the frame their world returns. Only after a PRIOR
                    // evaluation saw my hydrated (non-empty) set, though: the
                    // gain that IS boot/load hydration snaps instantly,
                    // however slow the load. Shrinks snap.
                    if (next > prev && this.sightHydrated) this.queueFogReveal(prev, next);
                    else {
                        this.cancelPendingFogReveal();
                        this.cancelFogReveal();
                    }
                } else if (next !== this.viewRadiusValue) {
                    // Foreign frames clobbered the sizing value while the true
                    // sight never changed: restore quietly — no gain, no
                    // reveal, and no cancel of anything. The clobber frame's
                    // refresh already fetched a window sized to the FOREIGN
                    // radius (performRefresh reads viewRadiusValue), so the
                    // restore must refetch at the restored radius too —
                    // otherwise the reopened fog ring sits over unfetched
                    // meadow for the remainder of the 25 s cadence.
                    this.viewRadiusValue = next;
                    this.nextRefreshAt = 0;
                }
                if (all.length > 0) {
                    // The baseline arms AFTER the diff: the evaluation that
                    // first sees the hydrated set never animates its own gain.
                    this.sightHydrated = true;
                    // The roster set refreshes on every accepted-mine
                    // evaluation that just closed a swap window (not only on
                    // a size change): an equal-count roster swap can never
                    // leave a stale id set behind as the overlap key.
                    if (swapWasPending || this.homeBuildingIds.size !== all.length) {
                        this.homeBuildingIds = new Set(
                            all.map(b => b.id).filter((id): id is string => Boolean(id)));
                    }
                }
            }
        }
        // A battle frame prepares EXACTLY the one-ring context (prepareFocus's
        // focusRadius) — never the home exploration horizon. Sizing the fog
        // to a level-2 watchtower's earned radius here uncovered a 16-plot
        // ring of barren meadow no postcard was ever prepared for.
        return this.focusPlot ? 1 : this.viewRadiusValue;
    }

    /** Re-anchor all plot-relative state when another device relocates home. */
    private applyHomePlot(next: { x: number; y: number }): boolean {
        const changed = this.homePlotKnown && (next.x !== this.myPlot.x || next.y !== this.myPlot.y);
        this.myPlot = { ...next };
        this.homePlotKnown = true;
        if (changed) {
            // This response is the authority that discovered the move, so it
            // remains allowed to build the replacement ring after cleanup.
            this.teardown(false);
            this.nextRefreshAt = 0;
        }
        return changed;
    }

    private beginMapRequest(): MapRequestTicket {
        return {
            sequence: ++this.mapRequestSequence,
            authorityEpoch: this.mapAuthorityEpoch
        };
    }

    /**
     * Adopt scenery epochs only from the newest server observation. A delayed
     * pre-reseed map response may still arrive after the new world, but it
     * must never repaint nature backwards. Timestamp fencing also permits the
     * server's uint32 epoch to wrap without treating the wrapped value as old.
     */
    private adoptPresentationSeedVersion(rawVersion: unknown, rawServerNow: unknown): boolean {
        if (rawVersion === undefined || rawVersion === null) return false;
        const next = normalizeWorldNatureSeedVersion(rawVersion);
        const observedAt = Number(rawServerNow);
        const timestamp = Number.isFinite(observedAt) ? observedAt : 0;
        if (timestamp < this.presentationSeedObservedAt) return false;
        this.presentationSeedObservedAt = timestamp;
        if (next === this.presentationSeedVersion) return false;
        this.presentationSeedVersion = next;
        this.wildernessLinkSignature = null;
        this.nextRefreshAt = 0;
        return true;
    }

    /**
     * Accept the newest server observation of home. An older full-window
     * response may still be useful when it agrees with the accepted home, but
     * it may never move the anchor backwards.
     */
    private acceptMapHome(window: WorldMapWindow, ticket: MapRequestTicket): boolean {
        if (ticket.authorityEpoch !== this.mapAuthorityEpoch) return false;
        const serverNow = Number(window.serverNow);
        const responseTime = Number.isFinite(serverNow) ? serverNow : 0;
        const isNewer = responseTime > this.latestHomeServerNow
            || (responseTime === this.latestHomeServerNow && ticket.sequence >= this.latestHomeResponseSequence);
        if (isNewer) {
            this.latestHomeServerNow = responseTime;
            this.latestHomeResponseSequence = ticket.sequence;
            this.adoptPresentationSeedVersion(window.seedVersion, window.serverNow);
            this.applyHomePlot({ x: window.me.x, y: window.me.y });
        }
        return window.me.x === this.myPlot.x && window.me.y === this.myPlot.y;
    }

    /**
     * Pull MY OWN roster's ids out of an accepted map window. The server
     * builds `me` and the center plot authoritatively (it windows around my
     * true plot whatever the client asked for), and my plot's postcard is
     * present in EVERY window: the own plot is skipped when building views,
     * so `knownPlots` never advertises its revision and the server never
     * omits its `world`. These ids are the ownership proof the sight-swap
     * latch overlaps against (computeViewRadius) — the ENEMY roster of a
     * replay/battle frame can never match them.
     */
    private adoptServerHomeRoster(window: WorldMapWindow) {
        const me = window.plots.find(p => p.x === window.me.x && p.y === window.me.y);
        if (!me || me.kind !== 'player' || !me.world) return;
        const ids = me.world.buildings
            .map(b => b.id)
            .filter((id): id is string => typeof id === 'string' && id.length > 0);
        if (ids.length > 0) this.serverHomeRosterIds = new Set(ids);
    }

    /** Commit a local relocation and release coalesced GETs so a fresh ring can start immediately. */
    private fenceMapRequests(serverNow?: number) {
        this.mapAuthorityEpoch += 1;
        this.latestHomeResponseSequence = this.mapRequestSequence;
        if (Number.isFinite(serverNow)) this.latestHomeServerNow = Math.max(this.latestHomeServerNow, Number(serverNow));
        this.refreshInFlight = null;
        this.refreshing = false;
        this.refreshRadiusInFlight = -1;
        this.refreshForcesTexturesInFlight = false;
    }

    private clearFallbackViews() {
        if (!this.fallbackViewsActive) return;
        for (const view of this.views.values()) this.destroyView(view);
        this.views.clear();
        this.fallbackViewsActive = false;
    }

    /**
     * If the first map request is unavailable, fill the earned ring with
     * deterministic, non-interactive nature instead of exposing blank roads.
     * A later authoritative response replaces the whole fallback atomically.
     */
    private ensureInitialWildernessFallback(visibleFogRadius = this.computeViewRadius()) {
        if (!this.sceneLive() || this.views.size > 0) return;
        const radius = this.computeViewRadius();
        this.ensureWilderness();
        // A failed reveal preload may paint deterministic placeholders beneath
        // the cloud bank, but it must never open that bank around placeholders.
        this.ensureFog(visibleFogRadius);
        if (radius <= 0) return;

        // Kind hints first, postcards second: the fallback ring is all wilds,
        // and its corner rounding must see that before the first plot paints
        // (or every joined crossing bakes stray shoulder arcs for one pass).
        this.knownPlotKindHints = new Map();
        for (let dy = -radius; dy <= radius; dy++) {
            for (let dx = -radius; dx <= radius; dx++) {
                const x = this.myPlot.x + dx;
                const y = this.myPlot.y + dy;
                this.knownPlotKindHints.set(`${x},${y}`, dx === 0 && dy === 0 ? 'player' : 'empty');
            }
        }
        for (let dy = -radius; dy <= radius; dy++) {
            for (let dx = -radius; dx <= radius; dx++) {
                if (dx === 0 && dy === 0) continue;
                const x = this.myPlot.x + dx;
                const y = this.myPlot.y + dy;
                if (x < -WORLD_COORD_LIMIT || x > WORLD_COORD_LIMIT || y < -WORLD_COORD_LIMIT || y > WORLD_COORD_LIMIT) continue;
                const plot: WorldMapPlot = { x, y, kind: 'empty', settleable: false };
                const view = this.createView(`${x},${y}`, plot, dx, dy);
                this.renderNaturePostcard(view, dx, dy);
                view.renderedRevision = 'fallback_wilds';
                this.views.set(view.key, view);
            }
        }
        this.rebuildWildernessLinks(this.myPlot);
        this.fallbackViewsActive = this.views.size > 0;
    }

    /** Load + render the whole neighbourhood once, so a reveal never pops in late. */
    async prime(now: number): Promise<void> {
        this.nextRefreshAt = now + REFRESH_MS;
        // Boot must have a deadline. The map request is transport-bounded and
        // degrades to wilderness; home authority arrives through App's compact
        // /home/sync loop instead of a duplicate r=0 map request.
        const results = await Promise.allSettled([this.refresh()]);
        for (const result of results) {
            if (result.status === 'rejected') console.warn('World map prime request failed:', result.reason);
        }
        if (this.sceneLive()) {
            this.ensureWilderness();
            if (this.views.size === 0 && !this.refreshing) this.ensureInitialWildernessFallback();
        }
    }

    /** The scene can switch modes (or die) while we await network/generation. */
    private sceneLive(): boolean {
        try {
            return this.scene.scene.isActive() && this.scene.mode === 'HOME' && this.focusPlot === null;
        } catch {
            // Phaser nulls ScenePlugin internals during Game.destroy(); an async
            // map continuation can observe that brief terminal state.
            return false;
        }
    }

    private refresh(options: MapRefreshOptions = {}): Promise<MapRefreshResult> {
        const requiredRadius = Math.max(0, Math.floor(
            options.requiredRadius ?? this.computeViewRadius()));
        const forceVillageTextures = options.forceVillageTextures === true;
        if (this.refreshInFlight) {
            const coversRadius = this.refreshRadiusInFlight >= requiredRadius;
            const coversTextures = !forceVillageTextures || this.refreshForcesTexturesInFlight;
            if (coversRadius && coversTextures) return this.refreshInFlight;
            // A Watchtower can finish while an old-radius poll is on the wire.
            // Await it, then issue the expanded/forced request; coalescing the
            // smaller promise must never arm a larger reveal.
            return this.refreshInFlight.then(() => this.refresh(options));
        }
        if (!this.sceneLive()) return Promise.resolve({ requestedRadius: requiredRadius, accepted: false });
        this.refreshing = true;
        this.refreshRadiusInFlight = requiredRadius;
        this.refreshForcesTexturesInFlight = forceVillageTextures;
        const ticket = this.beginMapRequest();
        const run = this.performRefresh(ticket, requiredRadius, forceVillageTextures)
            .then(accepted => ({ requestedRadius: requiredRadius, accepted }));
        const task = run.finally(() => {
            if (this.refreshInFlight === task) {
                this.refreshInFlight = null;
                this.refreshing = false;
                this.refreshRadiusInFlight = -1;
                this.refreshForcesTexturesInFlight = false;
            }
        });
        this.refreshInFlight = task;
        return task;
    }

    private async performRefresh(
        ticket: MapRequestTicket,
        radius: number,
        forceVillageTextures: boolean
    ): Promise<boolean> {
        const revealCriticalOnly = !forceVillageTextures
            && (this.views.size === 0 || this.fallbackViewsActive);
        const knownPlots: Record<string, KnownMapPlot> = {};
        for (const view of this.views.values()) {
            if ((view.plot.kind === 'player' || view.plot.kind === 'bot')
                && view.plot.ownerId && view.knownRevision !== null) {
                knownPlots[`${view.plot.x},${view.plot.y}`] = {
                    ownerId: view.plot.ownerId,
                    revision: view.knownRevision,
                };
            }
        }
        // null center = the server windows around OUR true plot; guessing
        // it client-side painted first-load neighbourhoods at wrong offsets.
        const window = await Backend.fetchMap(null, null, radius, knownPlots);
        if (!window || !this.sceneLive()) {
            if (!window) this.ensureInitialWildernessFallback(
                forceVillageTextures
                    ? this.pendingFogReveal?.fromRadius ?? radius
                    : radius);
            return false;
        }
        if (!this.acceptMapHome(window, ticket)) return false;
        this.adoptServerHomeRoster(window);
        DayNightSystem.serverOffsetMs = window.serverNow - Date.now();
        this.clearFallbackViews();
        this.ensureWilderness();
        // Every plot kind of the window is known BEFORE any postcard paints:
        // wilderness corner rounding consults the neighbours' kinds, and
        // views alone would lag one whole refresh behind on first load.
        this.knownPlotKindHints = new Map(window.plots.map(p => [`${p.x},${p.y}`, p.kind]));

        // Drop views that left the window (relocation, radius change).
        const present = new Set(window.plots.map(p => `${p.x},${p.y}`));
        for (const [key, view] of [...this.views]) {
            if (!present.has(key)) {
                this.destroyView(view);
                this.views.delete(key);
            }
        }

        const paintPlot = async (plot: WorldMapPlot) => {
            const dx = plot.x - this.myPlot.x;
            const dy = plot.y - this.myPlot.y;
            if (dx === 0 && dy === 0) return; // that's us, live on the local grid
            try {
                await this.ensureView(`${plot.x},${plot.y}`, plot, dx, dy, { forceVillageTexture: forceVillageTextures });
            } catch (error) {
                // A single corrupt/temporarily unavailable neighbour must
                // not blank the rest of the ring or reject the poll task.
                console.warn(`map postcard failed for ${plot.x},${plot.y}:`, error);
            }
        };
        const ordered = window.plots.slice().sort((a, b) => {
            const ar = Math.max(Math.abs(a.x - this.myPlot.x), Math.abs(a.y - this.myPlot.y));
            const br = Math.max(Math.abs(b.x - this.myPlot.x), Math.abs(b.y - this.myPlot.y));
            return ar - br;
        });
        const near = ordered.filter(plot => Math.max(
            Math.abs(plot.x - this.myPlot.x), Math.abs(plot.y - this.myPlot.y)) <= 1);
        const far = ordered.filter(plot => Math.max(
            Math.abs(plot.x - this.myPlot.x), Math.abs(plot.y - this.myPlot.y)) > 1);

        for (const plot of near) {
            await paintPlot(plot);
            if (!this.sceneLive()) return false;
        }

        if (revealCriticalOnly && far.length > 0) {
            // Ring one is the only context adjacent to the live lawn. Let boot
            // reveal it immediately; earned ring-two metadata is already known
            // and its cheaper postcards fill in cooperatively behind the clouds
            // opening instead of extending the critical path.
            this.rebuildWildernessLinks(this.myPlot);
            void (async () => {
                for (const plot of far) {
                    if (!this.sceneLive()
                        || ticket.authorityEpoch !== this.mapAuthorityEpoch
                        || ticket.sequence < this.latestHomeResponseSequence) return;
                    await new Promise(resolve => setTimeout(resolve, 0));
                    await paintPlot(plot);
                }
                if (this.sceneLive()) this.rebuildWildernessLinks(this.myPlot);
            })().catch(error => console.warn('Deferred map postcard paint failed:', error));
            return true;
        }
        for (const plot of far) {
            await paintPlot(plot);
            if (!this.sceneLive()) return false;
        }
        this.rebuildWildernessLinks(this.myPlot);
        return true;
    }

    private cameraWorldRect(): ScreenRect {
        const worldView = this.scene.cameras.main.worldView;
        return { x: worldView.x, y: worldView.y, width: worldView.width, height: worldView.height };
    }

    private villageTextureInterested(view: NeighborView, now: number): boolean {
        const decision = decidePostcardResidency({
            dx: view.dx,
            dy: view.dy,
            camera: this.cameraWorldRect(),
            now,
            lastInterestedAt: view.lastTextureInterestAt,
            resident: view.contentKind === 'village' && view.rt !== null
        });
        view.lastTextureInterestAt = decision.nextLastInterestedAt;
        return decision.interested;
    }

    private async ensureView(
        key: string,
        plot: WorldMapPlot,
        dx: number,
        dy: number,
        options: { forceVillageTexture?: boolean } = {}
    ) {
        if (!this.sceneLive()) return;
        let view = this.views.get(key);
        if (!view) {
            view = this.createView(key, plot, dx, dy);
            this.views.set(key, view);
        }
        view.dx = dx;
        view.dy = dy;
        const identityChanged = view.plot.kind !== plot.kind
            || view.plot.ownerId !== plot.ownerId
            || view.plot.seed !== plot.seed;
        if (identityChanged) {
            this.releaseViewVisuals(view, false);
            view.knownRevision = null;
            view.sourceWorld = null;
            view.sourceRevision = null;
            view.renderedRevision = null;
        }
        view.plot = plot;

        if (plot.kind === 'empty') {
            // A village may disappear in place after relocation/logout. Its
            // frozen lawn becomes nature, and every village-only overlay must
            // leave with it rather than smoking and waving over empty land.
            view.hearth = null;
            view.life?.destroy();
            view.life = null;
            // Remove incompatible art before drawing the replacement. If a
            // renderer ever throws, a wilderness plot may be briefly blank,
            // but it can never keep showing the departed village until the
            // next poll succeeds.
            view.sourceWorld = null;
            view.sourceRevision = null;
            if (view.contentKind === 'village') this.releaseViewVisuals(view, false);
            // Unclaimed ground is still a PLACE. Identity and renderer-version
            // changes both force a new RT, so a departed starter village can
            // never remain visible under empty-plot metadata.
            const wildRevision = this.wildernessRevisionAt(plot.x, plot.y);
            if (identityChanged || !view.rt || view.contentKind !== 'nature' || view.renderedRevision !== wildRevision) {
                this.renderNaturePostcard(view, dx, dy);
                view.renderedRevision = wildRevision;
            }
            this.ensureBattle(view, dx, dy, false);
            return;
        }

        // Cache authoritative source data independently from GPU residency.
        // A conditional map response can therefore omit an unchanged world
        // while an evicted texture still rematerializes locally at 1:1.
        let world: PostcardWorld | null = null;
        let revision: number | string = 0;
        if (plot.ownerId) {
            const enriched = plot as MapPlotWithSnapshot;
            revision = `${plot.kind}_${plot.ownerId}_${enriched.revision ?? enriched.world?.revision ?? 0}`;
            if (view.sourceRevision !== revision || !view.sourceWorld) world = enriched.world ?? null;
        }
        if (!this.sceneLive()) return; // mode switched (or scene died) mid-await
        if (!world && view.sourceRevision !== null && view.sourceRevision !== revision) {
            // A changed player should arrive with an inline public snapshot.
            // If an old/short server response omits it, never keep displaying
            // the prior owner's revision while asking the next poll to retry.
            view.sourceWorld = null;
            view.sourceRevision = null;
            view.knownRevision = null;
            this.releaseViewVisuals(view, false);
        }
        if (world) {
            view.sourceWorld = world;
            view.sourceRevision = revision;
            view.knownRevision = (plot as MapPlotWithSnapshot).revision ?? world.revision ?? null;
        }

        const interested = options.forceVillageTexture === true
            || this.villageTextureInterested(view, this.scene.time.now);
        if (options.forceVillageTexture) view.lastTextureInterestAt = this.scene.time.now;
        const staleTexture = view.contentKind === 'village' && view.renderedRevision !== view.sourceRevision;
        if (staleTexture && !interested) this.releaseViewVisuals(view, false);
        if (interested && view.sourceWorld &&
            (!view.rt || view.contentKind !== 'village' || view.renderedRevision !== view.sourceRevision)) {
            this.renderSnapshot(view, view.sourceWorld, dx, dy);
            view.renderedRevision = view.sourceRevision;
        } else if (interested && !view.sourceWorld && (
            !view.rt
            || identityChanged
            || view.renderedRevision !== this.fallbackNatureRevision(plot, view.key)
        )) {
            // Current servers always inline changed public snapshots. If a
            // response is short/old, show deterministic landscape rather than
            // a stale owner's village; leaving knownRevision null asks again
            // on the next poll without creating an N+1 request fan-out.
            this.renderNaturePostcard(view, dx, dy);
            view.renderedRevision = this.fallbackNatureRevision(plot, view.key);
            view.hearth = null;
        }

        this.ensureBattle(view, dx, dy, Boolean(plot.underAttack) && view.rt !== null);
    }

    /**
     * A postcard of unclaimed WILDS: the plot's seeded nature vignette
     * (lake, crag field, pine stand, stone ring...) rendered through the
     * exact same RT pipeline as village snapshots — same LOD, same bounds,
     * same painter seams. Same seed on every client: the world's geography
     * is a shared fact, not a client whim.
     */
    private wildernessRevisionAt(plotX: number, plotY: number): string {
        const raw = WildernessRenderer.renderRevision(plotX, plotY, this.presentationSeedVersion);
        // Corner rounding is topology-dependent (joined corners stay square),
        // so the cut flags join the cache key: a neighbour settling or
        // leaving re-renders exactly the postcards whose corners changed.
        const cuts = this.wildCornerCutFlags(plotX, plotY);
        const base = `${raw}_r${Number(cuts.nw)}${Number(cuts.ne)}${Number(cuts.se)}${Number(cuts.sw)}`;
        const featureIds = classifyHydrologyPlot(plotX, plotY, this.presentationSeedVersion)
            .features.map(feature => feature.id).join('|');
        return featureIds
            ? `${base}_hydroart_v${WorldHydrologyRenderer.RENDER_VERSION}_${hashString(featureIds).toString(16)}`
            : base;
    }

    /** The freshest known kind for an absolute plot: response hints first
     * (they arrive before sibling views exist), then the rendered views. */
    private plotKindAt(x: number, y: number): WorldMapPlot['kind'] | null {
        return this.knownPlotKindHints.get(`${x},${y}`)
            ?? this.views.get(`${x},${y}`)?.plot.kind
            ?? null;
    }

    /**
     * Which corners of a plot's postcard get the rounded lawn cut. A corner
     * stays SQUARE only where its junction is fully joined meadow (all four
     * parcels known wilderness — the crossing there is reclaimed grass and
     * the checker must run through unbroken). Unknown parcels fail closed
     * to roads, exactly like buildWildernessTopology, so every corner that
     * can face road earth is rounded like a village lawn's.
     */
    private wildCornerCutFlags(plotX: number, plotY: number): { nw: boolean; ne: boolean; se: boolean; sw: boolean } {
        const wild = (x: number, y: number): boolean => this.plotKindAt(x, y) === 'empty';
        const joined = (bx: number, by: number): boolean =>
            wild(bx - 1, by - 1) && wild(bx, by - 1) && wild(bx - 1, by) && wild(bx, by);
        return {
            nw: !joined(plotX, plotY),
            ne: !joined(plotX + 1, plotY),
            se: !joined(plotX + 1, plotY + 1),
            sw: !joined(plotX, plotY + 1)
        };
    }

    private fallbackNatureRevision(plot: WorldMapPlot, viewKey: string): string {
        return `fallback_${plot.ownerId ?? plot.seed ?? viewKey}_nature_s${this.presentationSeedVersion}`;
    }

    private renderNaturePostcard(view: NeighborView, dx: number, dy: number) {
        // A plot going nature-side drops its residents — but only if THIS
        // view registered them (a hidden focus view must not silence the
        // live ring's village rendered under the same key).
        if (view.residentsRegistered) {
            this.neighborLifeSim?.removeVillage(view.key);
            this.scene.dayNight?.clearPostcardLights?.(view.key);
            view.residentsRegistered = false;
        }
        const offX = dx * PLOT_PITCH;
        const offY = dy * PLOT_PITCH;
        const ringDist = Math.max(Math.abs(dx), Math.abs(dy));
        const hydrology = hydrologyFeaturesForPlot(
            view.plot.x,
            view.plot.y,
            this.presentationSeedVersion
        );
        // One world feature must rasterize at one resolution. A Great Lake can
        // straddle the ring-1/ring-2 LOD boundary; mixing full-size and 0.35x RTs
        // made their otherwise identical water meet in a faint diagonal X.
        //
        // Near wild parcels sample at the SHIPPED 1.35 world-px texel grid
        // (PIXEL_LOD = 1/1.35): rasterize full size, then the SNAP<1 branch
        // below point-samples one NEAREST texel per 1.35 px — exactly the
        // bake pipeline's cell. At full resolution the 1.35-cell RT quantize
        // is a near no-op (its cells collapse to 1-2 px), so the smooth AA
        // trees/tufts WildernessRenderer authors stayed visibly smooth on a
        // live-adjacent layer while everything around them was chunky — the
        // pixel-contract violation. Hydrology plots keep SNAPSHOT_SCALE: all
        // their details are PixelDraw cells already, and one shared feature
        // must keep one resolution across every ring it spans.
        const PIXEL_LOD = 1 / 1.35;
        const SNAP = hydrology.length > 0
            ? SNAPSHOT_SCALE
            : ringDist >= 3 ? 0.25 : ringDist >= 2 ? 0.35 : SNAPSHOT_SCALE * PIXEL_LOD;
        const seed = wildernessPlotPresentationSeed(
            view.plot.x,
            view.plot.y,
            this.presentationSeedVersion
        );
        const g = this.scene.make.graphics({ x: 0, y: 0 }, false);

        // Wilderness is one continuous country. A shared palette plus
        // absolute pattern coordinates lets two empty parcels meet without
        // exposing a square tint/checker seam when their road is reclaimed.
        const palette = wildernessGrassPalette(this.presentationSeedVersion);
        // Wild plots round their corners exactly like village lawns wherever
        // a road still runs past that corner; a corner whose whole junction
        // is joined meadow stays square so the checker runs through
        // uninterrupted. The junction's packed-earth bed (see
        // drawRoundedRoadJunctions) shows through the cut.
        const cuts = this.wildCornerCutFlags(view.plot.x, view.plot.y);
        const lastTile = PLOT_TILES - 1;
        for (let ty = 0; ty < PLOT_TILES; ty++) {
            for (let tx = 0; tx < PLOT_TILES; tx++) {
                const p = IsoUtils.cartToIso(offX + tx, offY + ty);
                const worldTileX = view.plot.x * PLOT_PITCH + tx;
                const worldTileY = view.plot.y * PLOT_PITCH + ty;
                const cut = tx === 0 && ty === 0 && cuts.nw ? 'nw'
                    : tx === lastTile && ty === 0 && cuts.ne ? 'ne'
                        : tx === lastTile && ty === lastTile && cuts.se ? 'se'
                            : tx === 0 && ty === lastTile && cuts.sw ? 'sw'
                                : undefined;
                drawGrassTile(g, p.x, p.y, 64, 32, worldTileX, worldTileY, palette, false, cut);
            }
        }
        if (hydrology.length > 0) {
            const worldX = view.plot.x * PLOT_PITCH;
            const worldY = view.plot.y * PLOT_PITCH;
            const results = WorldHydrologyRenderer.drawFeatures(g, hydrology, {
                clip: {
                    minX: worldX,
                    minY: worldY,
                    maxX: worldX + PLOT_TILES,
                    maxY: worldY + PLOT_TILES
                },
                localGridX: offX,
                localGridY: offY,
                includeDetails: true,
                presentationSeedVersion: this.presentationSeedVersion
            });
            const life: WildernessLifeAnchor[] = [];
            for (const result of results) {
                for (const anchor of result.life) {
                    if (anchor.kind !== 'fish' && anchor.kind !== 'frog') continue;
                    life.push({
                        kind: anchor.kind,
                        gx: anchor.localGridX,
                        gy: anchor.localGridY,
                        phase: anchor.phase,
                        scale: anchor.scale
                    });
                }
            }
            view.natureLife = life;
            // Great-lake/river water is world geometry, queried straight from
            // WorldHydrology — nothing plot-local to keep.
            view.natureWaters = null;
        } else {
            const nature = WildernessRenderer.drawWildPlot(
                g,
                offX,
                offY,
                seed,
                view.plot.x,
                view.plot.y,
                this.presentationSeedVersion
            );
            view.natureLife = nature.life;
            view.natureWaters = { lakes: nature.waters, streams: nature.streams };
        }

        const top = IsoUtils.cartToIso(offX, offY);
        const right = IsoUtils.cartToIso(offX + PLOT_TILES, offY);
        const bottom = IsoUtils.cartToIso(offX + PLOT_TILES, offY + PLOT_TILES);
        const left = IsoUtils.cartToIso(offX, offY + PLOT_TILES);
        const HEADROOM = 90;
        const bx = left.x;
        const by = top.y - HEADROOM;
        const bw = right.x - left.x;
        const bh = bottom.y - top.y + HEADROOM;

        view.rt?.destroy();
        const rt = this.scene.add.renderTexture(bx, by, Math.ceil(bw * SNAP), Math.ceil(bh * SNAP));
        // Wilderness parcels share exact vector edges. Linear sampling of
        // downsampled RTs still blended their transparent outer texels
        // into faint diagonal hairlines over large lakes; nearest filtering
        // keeps the pixel-art shoreline opaque through camera resampling.
        applyTextureSampling(rt.texture, TextureSampling.PIXEL_ART);
        rt.setOrigin(0, 0);
        rt.setScale(1 / SNAP);
        if (SNAP < 1) {
            // LOD parcels must stay pixel-art. Rasterizing the vector
            // directly at the reduced scale bakes anti-aliased gradients into
            // every texel, and the 1.35*SNAP quantize cell (<1 RT px) is a
            // no-op — the magnification then read as a smooth blur. Instead:
            // rasterize LARGE and write one PURE center sample per texel via
            // SpriteBank.pointSampleRenderTexture (the bake harness's exact
            // math). The renderer must not do the scaling itself — a NEAREST
            // filter request is not honored by the Canvas renderer's
            // RT-to-RT draw, which area-averages and hands the AA gradients
            // straight through (the ring-1 "smooth trees on a chunky lawn"
            // contract violation). Near parcels (the fine 1.35-px texel
            // grid) supersample 2x first so the vector's AA rim shrinks to
            // half a texel and most edge samples land on pure paint.
            const SS = SNAP > 0.5 ? 2 : 1;
            const full = this.scene.make.renderTexture(
                { x: 0, y: 0, width: Math.ceil(bw * SS), height: Math.ceil(bh * SS) },
                false
            );
            applyTextureSampling(full.texture, TextureSampling.PIXEL_ART);
            g.setScale(SS);
            full.draw(g, -bx * SS, -by * SS);
            // Same-frame placeholder while the capture is in flight; the
            // pure-sample write replaces it wholesale.
            full.setOrigin(0, 0);
            full.setScale(SNAP / SS);
            rt.draw(full, 0, 0);
            SpriteBank.pointSampleRenderTexture(this.scene, full, rt);
        } else {
            g.setScale(SNAP);
            rt.draw(g, -bx * SNAP, -by * SNAP);
        }
        g.destroy();
        // World-layer pixel treatment (full-resolution parcels only — the
        // hydrology plots pinned to SNAPSHOT_SCALE): quantize once into
        // 1.35 world-px cells, same math as the baked sprites. Downsampled
        // parcels own their texels via the point-sample above, which also
        // alpha-snaps; running the quantizer after it would capture the
        // in-flight placeholder and write the stale frame back over the
        // pure samples.
        if (SNAP >= 1) SpriteBank.quantizeRenderTexture(this.scene, rt, Math.max(1, 1.35 * SNAP));
        const dz = dx + dy;
        rt.setDepth(dz < 0 ? 420 + dz : dz === 0 ? 780 : 26_000 + dz);
        view.rt = rt;
        view.contentKind = 'nature';
    }

    /** One full-resolution cached postcard of a neighbour's exact base. */
    private renderSnapshot(
        view: NeighborView,
        world: PostcardWorld,
        dx: number,
        dy: number,
        opts?: { deferResidents?: boolean }
    ) {
        const offX = dx * PLOT_PITCH;
        const offY = dy * PLOT_PITCH;
        const SNAP = SNAPSHOT_SCALE;
        const g = this.scene.make.graphics({ x: 0, y: 0 }, false);

        // The plot's own lawn — drawn through the SAME grass renderer the
        // live battlefield bakes with, seeded by the village's identity, so
        // marching over there never changes the ground under your feet.
        const grassKey = view.plot.kind === 'bot' ? `bot_${view.plot.seed ?? 0}` : (view.plot.ownerId ?? view.key);
        const palette = grassPaletteFor(grassKey);
        const last = PLOT_TILES - 1;
        for (let ty = 0; ty < PLOT_TILES; ty++) {
            for (let tx = 0; tx < PLOT_TILES; tx++) {
                const p = IsoUtils.cartToIso(offX + tx, offY + ty);
                // Plot corners round off like the live lawn's (the junction's
                // packed-earth bed shows through the cut).
                const cut = tx === 0 && ty === 0 ? 'nw'
                    : tx === last && ty === 0 ? 'ne'
                        : tx === last && ty === last ? 'se'
                            : tx === 0 && ty === last ? 'sw'
                                : undefined;
                drawGrassTile(g, p.x, p.y, 64, 32, tx, ty, palette, true, cut);
            }
        }

        // The neighbour's stone lanes — SERVER-aged, so every viewer sees
        // the same paving at the same age. Bots are old settlements: fully
        // paved. Baked into the postcard between lawn and buildings, exactly
        // where the live village draws its own.
        const stoneBuildings = Array.isArray(world.buildings) ? world.buildings : [];
        const stoneMaturity = view.plot.kind === 'bot'
            ? 1
            : Math.min(1, Math.max(0, Number(view.plot.stoneMaturity ?? 1)));
        const stoneOccluded = (x: number, y: number): boolean => {
            const pad = 0.12;
            for (const b of stoneBuildings) {
                const info = BUILDING_DEFINITIONS[b.type as BuildingType];
                if (!info) continue;
                const bx = Number(b.gridX) || 0;
                const by = Number(b.gridY) || 0;
                if (x > bx - pad && x < bx + info.width + pad &&
                    y > by - pad && y < by + info.height + pad) return true;
            }
            return false;
        };
        for (const route of computeStoneRoutes(stoneBuildings)) {
            drawStoneLane(g, route.points, stoneMaturity, { offX, offY, occluded: stoneOccluded });
        }

        const elevatedLayers = this.drawWorldStatic(g, world, offX, offY);

        // Capture bounds in world px: the plot diamond plus roof headroom.
        const top = IsoUtils.cartToIso(offX, offY);
        const right = IsoUtils.cartToIso(offX + PLOT_TILES, offY);
        const bottom = IsoUtils.cartToIso(offX + PLOT_TILES, offY + PLOT_TILES);
        const left = IsoUtils.cartToIso(offX, offY + PLOT_TILES);
        const HEADROOM = 90;
        const bx = left.x;
        const by = top.y - HEADROOM;
        const bw = right.x - left.x;
        const bh = bottom.y - top.y + HEADROOM;

        view.rt?.destroy();
        const rt = this.scene.add.renderTexture(bx, by, Math.ceil(bw * SNAP), Math.ceil(bh * SNAP));
        // The postcard quantizes into 1.35-px cells below, so it joins the
        // shared PixelMode contract: NEAREST outside legacy mode, re-applied
        // live on mode switch.
        registerPixelSurface(rt.texture);
        rt.setOrigin(0, 0);
        rt.setScale(1 / SNAP);
        g.setScale(SNAP);
        rt.draw(g, -bx * SNAP, -by * SNAP);
        for (const layer of elevatedLayers) {
            // Graphics carriers sit at (0,0) with world-space content: scale
            // and draw at the capture offset. Baked-obstacle Images carry a
            // real anchor position AND an intrinsic cellWorldPx scale, so
            // they multiply (not overwrite) and draw at their own spot.
            layer.setScale(layer.scaleX * SNAP, layer.scaleY * SNAP);
            if (layer instanceof Phaser.GameObjects.Image) {
                rt.draw(layer, (layer.x - bx) * SNAP, (layer.y - by) * SNAP);
            } else {
                rt.draw(layer, -bx * SNAP, -by * SNAP);
            }
        }
        g.destroy();
        for (const layer of elevatedLayers) layer.destroy();
        // Same pixel treatment as the live world: one-time quantize of the
        // whole village postcard (lawn + buildings) at the shipped cell size.
        SpriteBank.quantizeRenderTexture(this.scene, rt, 1.35 * SNAP);

        // Painter seams: NW neighbours behind the live village, SE in front.
        const dz = dx + dy;
        rt.setDepth(dz < 0 ? 420 + dz : dz === 0 ? 780 : 26_000 + dz);
        view.rt = rt;
        view.contentKind = 'village';
        this.textureMaterializations += 1;
        const hall = world.buildings.find(b => b.type === 'town_hall');
        view.hearth = hall
            ? {
                gx: dx * PLOT_PITCH + hall.gridX + 1.5,
                gy: dy * PLOT_PITCH + hall.gridY + 1.5,
                level: Math.max(1, Number(hall.level) || 1)
            }
            : null;
        // Hidden pending-focus postcards render under the SAME absolute keys
        // as the live ring; registering their residents now would overwrite
        // (and their later release destroy) the living neighbours currently
        // on screen. commitFocus registers them in the frame they go live.
        if (!opts?.deferResidents) this.registerVillageResidents(view, world);
        view.natureLife = [];
    }

    /**
     * Register the shared per-key living registries — the villager sim and
     * the postcard night lights — for a rendered village postcard, and mark
     * this view their owner. Only the registered owner clears them on
     * release (see releaseViewVisuals), so a hidden battle ring prepared
     * over plots shared with the home ring can never silence the live one.
     */
    private registerVillageResidents(view: NeighborView, world?: PostcardWorld) {
        const source = world ?? view.sourceWorld;
        if (!source || view.contentKind !== 'village' || !view.rt) return;
        const offX = view.dx * PLOT_PITCH;
        const offY = view.dy * PLOT_PITCH;
        const buildings = Array.isArray(source.buildings) ? source.buildings : [];
        this.scene.dayNight?.setPostcardLights?.(view.key, buildings, offX, offY);
        const fallbackLifeIdentity = view.plot.kind === 'bot'
            ? `bot:${view.plot.seed ?? view.key}`
            : source.ownerId || view.plot.ownerId || view.key;
        this.neighborLife.setVillage(view.key, buildings, offX, offY, fallbackLifeIdentity,
            view.rt.depth + 1, (source as WorldPostcard).life,
            Array.isArray(source.obstacles) ? source.obstacles : []);
        view.residentsRegistered = true;
    }

    /**
     * Static painter's-order render of a whole postcard world at a grid
     * offset. time=0 for this cached layer; resident motion stays separate.
     * Mirrors MainScene.drawBuildingVisuals' dispatch exactly, one building at
     * a time inside a try/catch — a bad record falls back to a generic block
     * rather than killing the whole postcard.
     */
    private drawWorldStatic(
        ground: Phaser.GameObjects.Graphics,
        world: PostcardWorld,
        offX: number,
        offY: number
    ): Array<Phaser.GameObjects.Graphics | Phaser.GameObjects.Image> {
        const buildings = Array.isArray(world.buildings) ? world.buildings : [];
        const wallAt = new Set(buildings.filter(b => b.type === 'wall').map(b => `${b.gridX},${b.gridY}`));

        const drawBuilding = (
            g: Phaser.GameObjects.Graphics,
            b: (typeof buildings)[number],
            skipBase: boolean,
            onlyBase: boolean
        ) => {
            const info = BUILDING_DEFINITIONS[b.type as BuildingType];
            if (!info) return;
            const gx = offX + b.gridX;
            const gy = offY + b.gridY;
            const stub = {
                id: b.id,
                type: b.type,
                gridX: gx,
                gridY: gy,
                level: b.level ?? 1,
                health: 1,
                maxHealth: 1,
                owner: 'ENEMY'
            };
            drawBuildingVisual({
                graphics: g,
                gridX: gx,
                gridY: gy,
                type: b.type,
                building: stub,
                skipBase,
                onlyBase,
                time: 0,
                jukeboxPlaying: false,
                wallNeighbors: b.type === 'wall' ? {
                    nN: wallAt.has(`${b.gridX},${b.gridY - 1}`),
                    nS: wallAt.has(`${b.gridX},${b.gridY + 1}`),
                    nE: wallAt.has(`${b.gridX + 1},${b.gridY}`),
                    nW: wallAt.has(`${b.gridX - 1},${b.gridY}`),
                    owner: 'ENEMY'
                } : undefined,
                recoverFromRendererError: true
            });
        };

        // Ground-plane contract: every base is painted before any raised item.
        for (const b of buildings) drawBuilding(ground, b, false, true);

        const raised: Array<{ depth: number; g: Phaser.GameObjects.Graphics | Phaser.GameObjects.Image }> = [];
        for (const b of buildings) {
            if (!BUILDING_DEFINITIONS[b.type as BuildingType]) continue;
            const layer = this.scene.make.graphics({ x: 0, y: 0 }, false);
            drawBuilding(layer, b, true, false);
            raised.push({ depth: depthForBuilding(offX + b.gridX, offY + b.gridY, b.type as BuildingType), g: layer });
        }
        for (const obstacle of world.obstacles ?? []) {
            const info = OBSTACLE_DEFINITIONS[obstacle.type];
            if (!info) continue;
            const gx = offX + obstacle.gridX;
            const gy = offY + obstacle.gridY;
            const depth = depthForObstacle(gx, gy, info.width, info.height);
            // Pixel contract: postcard obstacles come from the SAME baked
            // atlases the live village stamps (SpriteBank), rasterized into
            // the postcard RT as a positioned transient Image. The old direct
            // ObstacleRenderer call painted smooth AA canopies/shadows into
            // an RT whose 1.35-cell quantize cannot chunk full-res AA art —
            // the one smooth thing on an otherwise chunky postcard.
            const pick = SpriteBank.pickObstacleFrame(obstacle.type, obstacle.id, gx, gy, 0);
            if (pick) {
                const img = this.scene.make.image({ key: pick.atlasKey, frame: pick.meta.file }, false);
                img.setOrigin(pick.meta.originX, pick.meta.originY);
                img.setScale(pick.meta.cellWorldPx);
                const iso = IsoUtils.cartToIso(gx + 0.5, gy + 0.5);
                img.setPosition(iso.x, iso.y);
                raised.push({ depth, g: img });
                continue;
            }
            const layer = this.scene.make.graphics({ x: 0, y: 0 }, false);
            ObstacleRenderer.drawObstacle(layer, {
                ...obstacle,
                gridX: gx,
                gridY: gy,
                animOffset: hashString(obstacle.id) % 10_000
            }, 0);
            raised.push({ depth, g: layer });
        }
        raised.sort((a, b) => a.depth - b.depth);
        return raised.map(item => item.g);
    }

    // ================= wilderness & roads =================

    /** Soft country-road corners: L-bends get a swept lane, and every known
     * village corner gets a packed-earth bed under its rounded lawn cut. */
    private drawRoundedRoadJunctions(
        g: Phaser.GameObjects.Graphics,
        topology: WildernessTopology,
        center: { x: number; y: number }
    ) {
        const cornerGeometry: Record<WildernessJunctionQuadrant, {
            corner: (x0: number, y0: number) => { x: number; y: number };
            sx: number;
            sy: number;
        }> = {
            nw: { corner: (x0, y0) => ({ x: x0, y: y0 }), sx: 1, sy: 1 },
            ne: { corner: (x0, y0) => ({ x: x0 + PLOT_GAP, y: y0 }), sx: -1, sy: 1 },
            se: { corner: (x0, y0) => ({ x: x0 + PLOT_GAP, y: y0 + PLOT_GAP }), sx: -1, sy: -1 },
            sw: { corner: (x0, y0) => ({ x: x0, y: y0 + PLOT_GAP }), sx: 1, sy: -1 }
        };
        const quadrants: WildernessJunctionQuadrant[] = ['nw', 'ne', 'se', 'sw'];
        const toIsoVector = (point: { x: number; y: number }) => {
            const iso = IsoUtils.cartToIso(point.x, point.y);
            return new Phaser.Math.Vector2(iso.x, iso.y);
        };

        for (const junction of topology.roadJunctions) {
            if (junction.shape === 'none') continue;
            const bend = roundedRoadBendFor(junction);
            const x0 = junction.boundaryX * PLOT_PITCH - PLOT_GAP;
            const y0 = junction.boundaryY * PLOT_PITCH - PLOT_GAP;

            // An L-bend is a TURN, not a crossing. Paint order matters:
            //   1. the crossing square in joined-meadow checker (absolute
            //      world tiles — seamless with the neighbouring grass
            //      bridges);
            //   2. the turned lane as a packed-earth quarter-DISC about the
            //      inner corner — everything beyond its radius-GAP outer arc
            //      stays meadow, so the OUTSIDE of the turn is as round as
            //      the inside (no sharp outer corner);
            //   3. the swept crown and cart ruts;
            //   4. the outer shoulder line along the radius-GAP arc, tangent
            //      to the straight shoulders it meets.
            if (bend) {
                const pivotGeometry = cornerGeometry[bend.innerCorner];
                const pivot = pivotGeometry.corner(x0, y0);
                const meadow = wildernessGrassPalette(this.presentationSeedVersion);
                for (let gy = 0; gy < PLOT_GAP; gy++) {
                    for (let gx = 0; gx < PLOT_GAP; gx++) {
                        const p = IsoUtils.cartToIso(x0 + gx, y0 + gy);
                        const worldTileX = center.x * PLOT_PITCH + x0 + gx;
                        const worldTileY = center.y * PLOT_PITCH + y0 + gy;
                        drawGrassTile(g, p.x, p.y, 64, 32, worldTileX, worldTileY, meadow, false);
                    }
                }
                const ARC_STEPS = 12;
                const arcAt = (t: number, radius: number) => {
                    const angle = t * Math.PI * 0.5;
                    return {
                        x: pivot.x + pivotGeometry.sx * Math.cos(angle) * radius,
                        y: pivot.y + pivotGeometry.sy * Math.sin(angle) * radius
                    };
                };
                const arcPoint = (step: number, radius: number) => arcAt(step / ARC_STEPS, radius);
                // A curved lane line as walked pixel cells: the arc sampled
                // fine enough that consecutive cells join without stair gaps.
                const pixelArc = (radius: number, thick: number, color: number) => {
                    const STEPS = 24;
                    let prev = toIsoVector(arcAt(0, radius));
                    for (let step = 1; step <= STEPS; step++) {
                        const next = toIsoVector(arcAt(step / STEPS, radius));
                        pixelLine(g, prev.x, prev.y, next.x, next.y, thick, color);
                        prev = next;
                    }
                };
                const outerArc: Array<{ x: number; y: number }> = [];
                for (let step = 0; step <= ARC_STEPS; step++) outerArc.push(arcPoint(step, PLOT_GAP));
                g.fillStyle(ROAD_EARTH, 1);
                g.fillPoints([toIsoVector(pivot), ...outerArc.map(toIsoVector)], true);
                // Crown: a quarter-annulus joining the two straight crowns
                // ([lane+0.45, lane+GAP-0.45]) edge-to-edge. The flat fills
                // stay (solid colors have nothing to quantize); their curved
                // edges are owned by the pixel-cell arc passes below, exactly
                // like the straight lanes' cell shoulders/ruts.
                const crown: Array<{ x: number; y: number }> = [];
                for (let step = 0; step <= ARC_STEPS; step++) crown.push(arcPoint(step, PLOT_GAP - 0.45));
                for (let step = ARC_STEPS; step >= 0; step--) crown.push(arcPoint(step, 0.45));
                g.fillStyle(ROAD_CROWN, 1);
                g.fillPoints(crown.map(toIsoVector), true);
                // Crown-to-earth arc edges re-drawn as crown cells so the
                // curved boundary is cell-stepped, not a smooth fill edge.
                pixelArc(0.45, 1, ROAD_CROWN);
                pixelArc(PLOT_GAP - 0.45, 1, ROAD_CROWN);
                // Ruts at the same offsets the straight lanes wear them.
                for (const radius of [0.55, PLOT_GAP - 0.55]) pixelArc(radius, 1, ROAD_RUT);
                // The outer shoulder cell-line also owns the quarter-disc's
                // earth-to-meadow silhouette.
                pixelArc(PLOT_GAP, 1, ROAD_SHOULDER);
            } else if (junction.shape === 't' || junction.shape === 'straight' || junction.shape === 'dead') {
                // Faces with no arm: the through-road's edge runs straight
                // across the crossing mouth — restore the shoulder line the
                // atlas's crossing cut removed there.
                const faces: Array<{ arm: keyof WildernessRoadArms; a: { x: number; y: number }; b: { x: number; y: number } }> = [
                    { arm: 'n', a: { x: x0, y: y0 }, b: { x: x0 + PLOT_GAP, y: y0 } },
                    { arm: 'e', a: { x: x0 + PLOT_GAP, y: y0 }, b: { x: x0 + PLOT_GAP, y: y0 + PLOT_GAP } },
                    { arm: 's', a: { x: x0, y: y0 + PLOT_GAP }, b: { x: x0 + PLOT_GAP, y: y0 + PLOT_GAP } },
                    { arm: 'w', a: { x: x0, y: y0 }, b: { x: x0, y: y0 + PLOT_GAP } }
                ];
                for (const face of faces) {
                    if (junction.arms[face.arm]) continue;
                    const a = toIsoVector(face.a);
                    const b = toIsoVector(face.b);
                    pixelLine(g, a.x, a.y, b.x, b.y, 1, ROAD_SHOULDER);
                }
            }

            // Under every KNOWN plot's lawn corner — village AND wilderness —
            // a packed-earth bed the size of the lawn's rounded cut: the lawn
            // above (drawn with its corner tile arc-cut, see drawGrassTile's
            // cornerCut) reveals clean road earth through the cut, and the
            // bed buries the static atlas's shoulder-line stubs that still
            // run to the old sharp corner. The cut's own arc stroke is the
            // shoulder around the bend — tangent to the straight shoulders
            // where the bed ends. The bed stays a flat quad: every visible
            // edge of it is either same-colour lane earth or the plot
            // postcard's QUANTIZED arc cut above, so no smooth boundary of
            // its own ever shows. Fully joined crossings (shape 'none',
            // skipped at the top of this loop) bake NO cuts
            // (wildCornerCutFlags) and need no bed; unknown corners have no
            // postcard rendered above them at all.
            for (const quadrant of quadrants) {
                if (junction.cornerStates[quadrant] === 'unknown') continue;
                // A corner flanked by TWO joined grass bands (the outer
                // corner of an L-bend wrapped in meadow) faces no road at
                // all: its rounded cut is covered from above by the gap
                // surface's corner cover, and an earth bed here would leak
                // its lane-edge bleed onto open meadow as a floating earth
                // diamond. Corners with at least one road face keep their
                // bed — the bleed lands on road earth or under a joined
                // band's own 27_400 cover.
                const faces = QUADRANT_FACES[quadrant];
                if (!junction.arms[faces[0]] && !junction.arms[faces[1]]) continue;
                const geometry = cornerGeometry[quadrant];
                const corner = geometry.corner(x0, y0);
                const D = GRASS_CORNER_CUT_RADIUS + 0.04; // to the cut's tangents
                const E = 0.08; // a hair over the lane edge (same earth colour)
                const intoX = -geometry.sx;
                const intoY = -geometry.sy;
                g.fillStyle(ROAD_EARTH, 1);
                g.fillPoints([
                    toIsoVector({ x: corner.x - intoX * E, y: corner.y - intoY * E }),
                    toIsoVector({ x: corner.x + intoX * D, y: corner.y - intoY * E }),
                    toIsoVector({ x: corner.x + intoX * D, y: corner.y + intoY * D }),
                    toIsoVector({ x: corner.x - intoX * E, y: corner.y + intoY * D })
                ], true);
            }
        }
    }

    /** Replace road strips only where both adjoining authoritative plots are
     * empty. The base road atlas remains cached underneath; these opaque grass
     * tiles remove its surface, ruts, cobbles, and furniture in one pass. */
    private rebuildWildernessLinks(
        center = this.focusPlot ?? this.myPlot,
        centerOccupied = true
    ) {
        const topology = buildWildernessTopology(
            center,
            // Same clamp as computeViewRadius: a battle frame owns exactly
            // the prepared one-ring context, whatever sight home has earned.
            this.focusPlot ? 1 : this.viewRadiusValue,
            [...this.views.values()].map(view => view.plot),
            { centerOccupied }
        );
        // cornercover: bump when the joined-seam cover geometry changes so
        // an already-built links/gap-surface graphic regenerates in place.
        const linkSignature = `${topology.signature}|owner=${this.scene.userId || 'village'}|nature=${this.presentationSeedVersion}|cornercover=v1`;
        if (linkSignature === this.wildernessLinkSignature) return;
        this.wildernessLinkSignature = linkSignature;
        this.wildernessTopology = topology;

        const g = this.wildernessLinks ?? this.scene.add.graphics();
        this.wildernessLinks = g;
        g.clear();
        g.setDepth(-440); // above roads (-450), below every postcard/live lawn
        const palette = wildernessGrassPalette(this.presentationSeedVersion);
        // Grass bridges reuse drawGrassTile — the SAME fn the ground-RT bake
        // and the postcard RTs paint with (both quantized sinks). On this LIVE
        // layer it is called with withDetail=false, so only the flat checker
        // quads draw: the blade-detail lineBetween/fillCircle path never runs
        // here, and every quad edge is grass-on-grass (absolute-tile checker)
        // or owned by the junctions' pixel-cell shoulder lines. Nothing
        // smooth escapes, so the shared fn needs no conversion.
        const tile = (gx: number, gy: number) => {
            const p = IsoUtils.cartToIso(gx, gy);
            const worldTileX = center.x * PLOT_PITCH + gx;
            const worldTileY = center.y * PLOT_PITCH + gy;
            drawGrassTile(g, p.x, p.y, 64, 32, worldTileX, worldTileY, palette, false);
        };

        for (const join of topology.verticalJoins) {
            const x0 = join.boundaryX * PLOT_PITCH - PLOT_GAP;
            const y0 = join.plotY * PLOT_PITCH;
            for (let gy = 0; gy < PLOT_TILES; gy++) {
                for (let gx = 0; gx < PLOT_GAP; gx++) tile(x0 + gx, y0 + gy);
            }
        }
        for (const join of topology.horizontalJoins) {
            const x0 = join.plotX * PLOT_PITCH;
            const y0 = join.boundaryY * PLOT_PITCH - PLOT_GAP;
            for (let gy = 0; gy < PLOT_GAP; gy++) {
                for (let gx = 0; gx < PLOT_TILES; gx++) tile(x0 + gx, y0 + gy);
            }
        }
        for (const join of topology.junctionJoins) {
            const x0 = join.boundaryX * PLOT_PITCH - PLOT_GAP;
            const y0 = join.boundaryY * PLOT_PITCH - PLOT_GAP;
            for (let gy = 0; gy < PLOT_GAP; gy++) {
                for (let gx = 0; gx < PLOT_GAP; gx++) tile(x0 + gx, y0 + gy);
            }
        }
        this.drawRoundedRoadJunctions(g, topology, center);

        // Reclaimed wilderness roads are part of the terrain, not seams in
        // it. Slice the SAME absolute Great Lake/river geometry into each
        // joined gap after its grass bridge is painted, so water, rapids, and
        // islands cross parcels without covering roads that still serve a
        // village or an unknown plot.
        const hydrology = queryWorldHydrology({
            minPlotX: center.x - topology.radius,
            minPlotY: center.y - topology.radius,
            maxPlotX: center.x + topology.radius,
            maxPlotY: center.y + topology.radius
        }, this.presentationSeedVersion);
        const worldOriginX = center.x * PLOT_PITCH;
        const worldOriginY = center.y * PLOT_PITCH;
        const drawHydrologyGap = (x0: number, y0: number, width: number, height: number) => {
            if (hydrology.length === 0) return;
            WorldHydrologyRenderer.drawFeatures(g, hydrology, {
                clip: {
                    minX: worldOriginX + x0,
                    minY: worldOriginY + y0,
                    maxX: worldOriginX + x0 + width,
                    maxY: worldOriginY + y0 + height
                },
                localGridX: x0,
                localGridY: y0,
                includeDetails: false,
                presentationSeedVersion: this.presentationSeedVersion
            });
        };
        for (const join of topology.verticalJoins) {
            drawHydrologyGap(
                join.boundaryX * PLOT_PITCH - PLOT_GAP,
                join.plotY * PLOT_PITCH,
                PLOT_GAP,
                PLOT_TILES
            );
        }
        for (const join of topology.horizontalJoins) {
            drawHydrologyGap(
                join.plotX * PLOT_PITCH,
                join.boundaryY * PLOT_PITCH - PLOT_GAP,
                PLOT_TILES,
                PLOT_GAP
            );
        }
        for (const join of topology.junctionJoins) {
            drawHydrologyGap(
                join.boundaryX * PLOT_PITCH - PLOT_GAP,
                join.boundaryY * PLOT_PITCH - PLOT_GAP,
                PLOT_GAP,
                PLOT_GAP
            );
        }

        // A road never dams the water. Wherever the Great Lake system
        // crosses a boundary band — village or wild on either side, joined
        // or not, INCLUDING the horizon roads at the edge of sight — the
        // road yields: the crossing span gets a grass bed and the water
        // flows through unbroken.
        if (hydrology.length > 0) {
            const r = topology.radius;
            const waterAt = (tx: number, ty: number) =>
                hydrology.some(f => f.terrain.contains(worldOriginX + tx + 0.5, worldOriginY + ty + 0.5));
            const paintRuns = (x0: number, y0: number, w: number, h: number, vertical: boolean) => {
                const len = vertical ? h : w;
                const across = vertical ? w : h;
                let run = -1;
                for (let i = 0; i <= len; i++) {
                    let wet = false;
                    if (i < len) {
                        for (let j = 0; j < across && !wet; j++) {
                            wet = vertical ? waterAt(x0 + j, y0 + i) : waterAt(x0 + i, y0 + j);
                        }
                    }
                    if (wet && run < 0) run = i;
                    if (!wet && run >= 0) {
                        // Pad the break so the shore eases out of the road.
                        const s = Math.max(0, run - 2);
                        const e = Math.min(len, i + 2);
                        for (let ii = s; ii < e; ii++) {
                            for (let j = 0; j < across; j++) {
                                if (vertical) tile(x0 + j, y0 + ii);
                                else tile(x0 + ii, y0 + j);
                            }
                        }
                        if (vertical) drawHydrologyGap(x0, y0 + s, w, e - s);
                        else drawHydrologyGap(x0 + s, y0, e - s, h);
                        run = -1;
                    }
                }
            };
            for (let k = -r; k <= r + 1; k++) {
                for (let p = -r; p <= r; p++) {
                    paintRuns(k * PLOT_PITCH - PLOT_GAP, p * PLOT_PITCH, PLOT_GAP, PLOT_TILES, true);
                    paintRuns(p * PLOT_PITCH, k * PLOT_PITCH - PLOT_GAP, PLOT_TILES, PLOT_GAP, false);
                }
            }
            for (let k = -r; k <= r + 1; k++) {
                for (let j = -r; j <= r + 1; j++) {
                    const jx0 = k * PLOT_PITCH - PLOT_GAP;
                    const jy0 = j * PLOT_PITCH - PLOT_GAP;
                    let wet = false;
                    for (let a = 0; a < PLOT_GAP && !wet; a++) {
                        for (let b = 0; b < PLOT_GAP && !wet; b++) wet = waterAt(jx0 + a, jy0 + b);
                    }
                    if (wet) {
                        for (let a = 0; a < PLOT_GAP; a++) {
                            for (let b = 0; b < PLOT_GAP; b++) tile(jx0 + a, jy0 + b);
                        }
                        drawHydrologyGap(jx0, jy0, PLOT_GAP, PLOT_GAP);
                    }
                }
            }
        }

        // The static road atlas is stroked, so its last antialiased rut pixel
        // can extend just outside the nominal two-tile band. Repaint the known
        // joined band directly above postcards with the same absolute wild
        // palette. The fractional outer bleed is only 0.08 tile and every
        // wilderness prop is inset well beyond it.
        const gapSurface = this.wildernessGapSurface ?? this.scene.add.graphics();
        this.wildernessGapSurface = gapSurface;
        gapSurface.clear();
        gapSurface.setDepth(27_400);
        // Pixel-pass call: these per-tile quads stay flat fills with NO edge
        // pass. Every edge is grass-on-grass — tile-vs-tile is the same
        // low-contrast absolute checker the quantized postcards wear, and the
        // 0.08 outer bleed lands on postcard tiles of the IDENTICAL checker
        // colour (both sample grassTileColorAt on absolute world tiles), so
        // no silhouette against a different colour ever exists here.
        const GAP_BLEED = 0.08;
        const fillWildRect = (x0: number, y0: number, x1: number, y1: number, sampleX: number, sampleY: number) => {
            const worldTileX = worldOriginX + sampleX;
            const worldTileY = worldOriginY + sampleY;
            const color = grassTileColorAt(worldTileX, worldTileY, palette);
            const points = [
                IsoUtils.cartToIso(x0, y0),
                IsoUtils.cartToIso(x1, y0),
                IsoUtils.cartToIso(x1, y1),
                IsoUtils.cartToIso(x0, y1)
            ].map(point => new Phaser.Math.Vector2(point.x, point.y));
            gapSurface.fillStyle(color, 1);
            gapSurface.fillPoints(points, true);
        };
        for (const join of topology.verticalJoins) {
            const x0 = join.boundaryX * PLOT_PITCH - PLOT_GAP;
            const y0 = join.plotY * PLOT_PITCH;
            for (let gy = 0; gy < PLOT_TILES; gy++) {
                fillWildRect(x0 - GAP_BLEED, y0 + gy, x0 + 1, y0 + gy + 1, x0, y0 + gy);
                fillWildRect(x0 + 1, y0 + gy, x0 + PLOT_GAP + GAP_BLEED, y0 + gy + 1, x0 + 1, y0 + gy);
            }
        }
        for (const join of topology.horizontalJoins) {
            const x0 = join.plotX * PLOT_PITCH;
            const y0 = join.boundaryY * PLOT_PITCH - PLOT_GAP;
            for (let gx = 0; gx < PLOT_TILES; gx++) {
                fillWildRect(x0 + gx, y0 - GAP_BLEED, x0 + gx + 1, y0 + 1, x0 + gx, y0);
                fillWildRect(x0 + gx, y0 + 1, x0 + gx + 1, y0 + PLOT_GAP + GAP_BLEED, x0 + gx, y0 + 1);
            }
        }
        for (const join of topology.junctionJoins) {
            const x0 = join.boundaryX * PLOT_PITCH - PLOT_GAP;
            const y0 = join.boundaryY * PLOT_PITCH - PLOT_GAP;
            for (let gy = 0; gy < PLOT_GAP; gy++) {
                for (let gx = 0; gx < PLOT_GAP; gx++) {
                    fillWildRect(
                        x0 + gx - (gx === 0 ? GAP_BLEED : 0),
                        y0 + gy - (gy === 0 ? GAP_BLEED : 0),
                        x0 + gx + 1 + (gx === PLOT_GAP - 1 ? GAP_BLEED : 0),
                        y0 + gy + 1 + (gy === PLOT_GAP - 1 ? GAP_BLEED : 0),
                        x0 + gx,
                        y0 + gy
                    );
                }
            }
        }

        // Rounded-corner covers. Every wild postcard rounds its lawn corner
        // wherever the junction it faces still carries road
        // (wildCornerCutFlags), and that cut bakes a quarter-arc shoulder
        // stroke over the links layer's packed-earth bed. Where one of the
        // corner's two junction faces is a JOINED grass band, the cut now
        // bites a shoulder-and-earth beak into what must read as one
        // continuous meadow. Cover exactly the plot's corner tile from
        // above with its own absolute checker colour — the same flat fill
        // the postcard painted, so the cover is invisible over lawn and
        // only the cut wedge changes. The size derives from the cut
        // geometry itself: GRASS_CORNER_CUT_RADIUS plus safety margin for
        // the arc's stroke width and the postcard's texel snap, capped at
        // one tile so the single-tile colour sample stays exact. Corners
        // whose faces are BOTH roads keep their rounded lawn look, and an
        // absent arm implies both adjoining plots are wild, so a village
        // corner is never covered.
        const CORNER_COVER = Math.min(1, GRASS_CORNER_CUT_RADIUS + 0.1);
        const coverCorners: ReadonlyArray<{
            quadrant: WildernessJunctionQuadrant;
            dx: number; // into-plot direction from the junction-square corner
            dy: number;
        }> = [
            { quadrant: 'nw', dx: -1, dy: -1 },
            { quadrant: 'ne', dx: 1, dy: -1 },
            { quadrant: 'se', dx: 1, dy: 1 },
            { quadrant: 'sw', dx: -1, dy: 1 }
        ];
        for (const junction of topology.roadJunctions) {
            // Fully joined crossings bake no cuts; full road crossings keep
            // their rounded corners. Only cuts beside a joined face need cover.
            if (junction.shape === 'none') continue;
            const x0 = junction.boundaryX * PLOT_PITCH - PLOT_GAP;
            const y0 = junction.boundaryY * PLOT_PITCH - PLOT_GAP;
            for (const spec of coverCorners) {
                const faces = QUADRANT_FACES[spec.quadrant];
                if (junction.arms[faces[0]] && junction.arms[faces[1]]) continue;
                const cornerX = spec.dx < 0 ? x0 : x0 + PLOT_GAP;
                const cornerY = spec.dy < 0 ? y0 : y0 + PLOT_GAP;
                const inX = cornerX + spec.dx * CORNER_COVER;
                const inY = cornerY + spec.dy * CORNER_COVER;
                fillWildRect(
                    Math.min(cornerX, inX),
                    Math.min(cornerY, inY),
                    Math.max(cornerX, inX),
                    Math.max(cornerY, inY),
                    cornerX + Math.min(0, spec.dx), // the plot's corner tile
                    cornerY + Math.min(0, spec.dy)
                );
            }
        }

        // Plot postcards live in painter bands up to ~26_004; fog starts at
        // 28_500. Render each absolute feature once between them. This removes
        // every internal RT/gap boundary by construction while fog still clips
        // the horizon. The server permanently reserves every intersected plot,
        // so the layer cannot cover a village or an active road.
        const featureLayer = this.worldHydrologyLayer ?? this.scene.add.graphics();
        this.worldHydrologyLayer = featureLayer;
        featureLayer.clear();
        featureLayer.setDepth(27_500);
        this.worldHydrologyGapLife = [];
        if (hydrology.length > 0) {
            const localMin = -topology.radius * PLOT_PITCH;
            const localMax = topology.radius * PLOT_PITCH + PLOT_TILES;
            const results = WorldHydrologyRenderer.drawFeatures(featureLayer, hydrology, {
                clip: {
                    minX: worldOriginX + localMin,
                    minY: worldOriginY + localMin,
                    maxX: worldOriginX + localMax,
                    maxY: worldOriginY + localMax
                },
                localGridX: localMin,
                localGridY: localMin,
                includeDetails: true,
                presentationSeedVersion: this.presentationSeedVersion
            });
            // Water life inside PLOTS animates via each postcard's own
            // anchors; life sitting in the ROAD-GAP bands belongs to no plot
            // window, so the overlay pass adopts those anchors itself (the
            // renderer no longer bakes frozen fish — see its drawFeature).
            const inGapBand = (v: number) => ((v % PLOT_PITCH) + PLOT_PITCH) % PLOT_PITCH >= PLOT_TILES;
            for (const result of results) {
                for (const anchor of result.life) {
                    if (anchor.kind !== 'fish' && anchor.kind !== 'frog') continue;
                    if (!inGapBand(anchor.localGridX) && !inGapBand(anchor.localGridY)) continue;
                    this.worldHydrologyGapLife.push({
                        kind: anchor.kind,
                        gx: anchor.localGridX,
                        gy: anchor.localGridY,
                        phase: anchor.phase,
                        scale: anchor.scale
                    });
                }
            }
        }

        // Roofs win over water: every village postcard carries 90 px of roof
        // headroom above its plot diamond, and in screen space that band lies
        // over its north neighbours — where this 27_500 overlay would slice
        // the roofline whenever the adjacent plot holds water. An inverted
        // geometry mask punches exactly those headroom bands out of the
        // overlay (and its life layer): the postcards' own baked water — the
        // same vectors at the same world anchors — shows through instead.
        const maskGfx = this.worldHydrologyMaskGfx ?? this.scene.make.graphics({ x: 0, y: 0 }, false);
        this.worldHydrologyMaskGfx = maskGfx;
        maskGfx.clear();
        let maskedBands = 0;
        if (hydrology.length > 0) {
            const HEADROOM = 90; // matches renderSnapshot's capture headroom
            const bandFor = (dx: number, dy: number) => {
                const offX = dx * PLOT_PITCH;
                const offY = dy * PLOT_PITCH;
                const topC = IsoUtils.cartToIso(offX, offY);
                const rightC = IsoUtils.cartToIso(offX + PLOT_TILES, offY);
                const leftC = IsoUtils.cartToIso(offX, offY + PLOT_TILES);
                maskGfx.fillStyle(0xffffff, 1);
                maskGfx.fillRect(leftC.x, topC.y - HEADROOM, rightC.x - leftC.x, HEADROOM);
                maskedBands++;
            };
            for (const view of this.views.values()) {
                if (view.plot.kind !== 'player' && view.plot.kind !== 'bot') continue;
                bandFor(view.dx, view.dy);
            }
            // The live village on the local grid (home or battlefield) has
            // real per-building depths below 27_500 — same headroom rule.
            bandFor(0, 0);
        }
        if (maskedBands > 0) {
            if (!this.worldHydrologyMask) {
                this.worldHydrologyMask = maskGfx.createGeometryMask();
                this.worldHydrologyMask.setInvertAlpha(true);
            }
            featureLayer.setMask(this.worldHydrologyMask);
        } else {
            featureLayer.clearMask();
        }
    }

    private ensureWilderness(radius = 2) {
        if (this.wilderness) return;
        const g = this.scene.add.graphics();
        g.setDepth(-450); // above the void backdrop (-500), below everything else
        // Production sight tops out at r=2. Offline full-atlas renderers use
        // the same painter at a larger radius instead of approximating roads.
        const r = Number.isFinite(radius) ? Math.max(2, Math.min(8, Math.floor(radius))) : 2;
        const min = -r * PLOT_PITCH - PLOT_GAP;
        const max = (r + 1) * PLOT_PITCH;
        const P = (x: number, y: number) => IsoUtils.cartToIso(x, y);
        const quad = (a: { x: number; y: number }, b: { x: number; y: number }, c: { x: number; y: number }, d: { x: number; y: number }, color: number, alpha = 1) => {
            g.fillStyle(color, alpha);
            g.fillPoints([
                new Phaser.Math.Vector2(a.x, a.y),
                new Phaser.Math.Vector2(b.x, b.y),
                new Phaser.Math.Vector2(c.x, c.y),
                new Phaser.Math.Vector2(d.x, d.y)
            ], true);
        };

        // Meadow under everything.
        quad(P(min, min), P(max, min), P(max, max), P(min, max), 0x497e3c);

        // Road bands: the gap tiles [k*PITCH - GAP, k*PITCH) in both axes.
        const bands: Array<[number, number]> = [];
        for (let k = -r; k <= r + 1; k++) {
            bands.push([k * PLOT_PITCH - PLOT_GAP, k * PLOT_PITCH]);
        }
        const EARTH = ROAD_EARTH;
        const CROWN = ROAD_CROWN;
        const RUT = ROAD_RUT;
        const SHOULDER = ROAD_SHOULDER;
        const COBBLE = ROAD_COBBLE;
        const blend = roadBlend;
        // Packed-earth base.
        for (const [a, b] of bands) {
            quad(P(a, min), P(b, min), P(b, max), P(a, max), EARTH);
            quad(P(min, a), P(max, a), P(max, b), P(min, b), EARTH);
        }
        // Sunlit crown down the middle of each lane.
        for (const [a, b] of bands) {
            const m0 = a + 0.45;
            const m1 = b - 0.45;
            quad(P(m0, min), P(m1, min), P(m1, max), P(m0, max), CROWN);
            quad(P(min, m0), P(max, m0), P(max, m1), P(min, m1), CROWN);
        }
        // A line along one axis, broken wherever it enters a crossing: the
        // junction floor stays clean packed earth (no X of lines through it).
        const segmented = (draw: (t0: number, t1: number) => void) => {
            const cuts = bands.slice().sort((x, y) => x[0] - y[0]);
            let t = min;
            for (const [a, b] of cuts) {
                if (a > t) draw(t, a);
                t = Math.max(t, b);
            }
            if (t < max) draw(t, max);
        };
        // Wheel ruts worn by the merchants' carts — walked cell-by-cell so
        // the rut is pixel texels, not an AA line.
        for (const [a, b] of bands) {
            for (const off of [0.55, PLOT_GAP - 0.55]) {
                segmented((t0, t1) => {
                    const v0 = P(a + off, t0);
                    const v1 = P(a + off, t1);
                    pixelLine(g, v0.x, v0.y, v1.x, v1.y, 1, RUT);
                    const h0 = P(t0, a + off);
                    const h1 = P(t1, a + off);
                    pixelLine(g, h0.x, h0.y, h1.x, h1.y, 1, RUT);
                });
                void b;
            }
        }
        // Road shoulders where the lane meets the grass.
        for (const [a, b] of bands) {
            for (const edge of [a, b]) {
                segmented((t0, t1) => {
                    const v0 = P(edge, t0);
                    const v1 = P(edge, t1);
                    pixelLine(g, v0.x, v0.y, v1.x, v1.y, 1, SHOULDER);
                    const h0 = P(t0, edge);
                    const h1 = P(t1, edge);
                    pixelLine(g, h0.x, h0.y, h1.x, h1.y, 1, SHOULDER);
                });
            }
        }
        // Cobbles and pebbles, seeded — the same road every time.
        let seed = 43;
        const rand = () => {
            seed = (seed * 1103515245 + 12345) & 0x7fffffff;
            return seed / 0x7fffffff;
        };
        // Crossing floors stay clean packed earth: no cobbles, flagstones or
        // grass breaks land inside a junction square.
        const inCrossing = (t: number) => bands.some(([a2, b2]) => t >= a2 - 0.9 && t < b2 + 0.9);
        for (const [a] of bands) {
            for (let t = min + 1; t < max - 1; t += 1.1 + rand() * 1.4) {
                const off = 0.35 + rand() * (PLOT_GAP - 0.7);
                if (inCrossing(t)) continue;
                const pv = P(a + off, t);
                pixelEllipse(g, pv.x, pv.y, (3.2 + rand() * 2.4) / 2, (1.7 + rand() * 1.2) / 2, COBBLE);
                const ph = P(t, a + off);
                pixelEllipse(g, ph.x, ph.y, (3.2 + rand() * 2.4) / 2, (1.7 + rand() * 1.2) / 2, COBBLE);
            }
        }

        // ---- surface variety: no two stretches of road read the same ----
        const FLAG = blend(CROWN, 0xa79a80, 0.7);
        const FLAG_EDGE = blend(FLAG, 0x6f6048, 0.5);
        const ROCK = 0x8c8676;
        const ROCK_DARK = 0x6e685a;
        const GRASS_BREAK = blend(EARTH, 0x497e3c, 0.55);
        for (const [a] of bands) {
            for (let t = min + 2; t < max - 2; t += 3 + rand() * 5) {
                const roll = rand();
                const off = 0.4 + rand() * (PLOT_GAP - 0.8);
                if (inCrossing(t)) continue;
                for (const axis of [0, 1] as const) {
                    const gx = axis === 0 ? a + off : t;
                    const gy = axis === 0 ? t : a + off;
                    const c = P(gx, gy);
                    if (roll < 0.3) {
                        // A patch of old flagstones sunk into the earth.
                        for (let f = 0; f < 3 + Math.floor(rand() * 3); f++) {
                            const fx = c.x + (rand() - 0.5) * 22;
                            const fy = c.y + (rand() - 0.5) * 10;
                            const w = 7 + rand() * 5;
                            pixelEllipse(g, fx, fy + 0.8, w / 2, w * 0.25, FLAG_EDGE);
                            pixelEllipse(g, fx, fy, (w - 1.6) / 2, (w - 1.6) * 0.25, FLAG);
                        }
                    } else if (roll < 0.5) {
                        // Rocks shouldered off the lane.
                        pixelEllipse(g, c.x + 1, c.y + 1.4, 2.7, 1.4, ROCK_DARK);
                        pixelEllipse(g, c.x, c.y, 2.5, 1.3, ROCK);
                        pixelEllipse(g, c.x + 4 + rand() * 3, c.y + rand() * 2 - 1, 1.3, 0.7, ROCK);
                    } else if (roll < 0.68) {
                        // Grass reclaiming a worn stretch.
                        pixelEllipse(g, c.x, c.y, (9 + rand() * 8) / 2, (4 + rand() * 3) / 2, GRASS_BREAK);
                    }
                }
            }
        }
        // Roadside posts pace the shoulders; a lantern-capped milestone marks
        // the crossings (drawn with height, so they sit ON the shoulder).
        const post = (gx: number, gy: number, tall: boolean) => {
            const c = P(gx, gy);
            pixelEllipse(g, c.x, c.y + 1, 2.5, 1.1, 0x2c2418, 0.35);
            const h = tall ? 15 : 9;
            pixelRect(g, c.x - 1.4, c.y - h, 2.8, h, 0x5c4a30);
            pixelRect(g, c.x - 1.4, c.y - h, 1.2, h, 0x6e5a3c);
            if (tall) {
                pixelRect(g, c.x - 2.6, c.y - h - 2.4, 5.2, 2.8, 0x3c3222);
                pixelRect(g, c.x - 1.5, c.y - h + 1.4, 3, 2.6, 0xffd76a);
            } else {
                pixelRect(g, c.x - 2.2, c.y - h, 4.4, 1.6, 0x4a3a26);
            }
        };
        for (const [a, b] of bands) {
            for (let t = min + 4; t < max - 4; t += 9 + rand() * 6) {
                // Skip posts inside crossings.
                const inCrossing = bands.some(([c0, c1]) => t > c0 - 1 && t < c1 + 1);
                if (inCrossing) continue;
                const side = rand() < 0.5 ? a - 0.35 : b + 0.35;
                if (rand() < 0.6) post(side, t, false);
                if (rand() < 0.6) post(t, side, false);
            }
            void b;
        }
        // Milestones with lanterns at every road crossing corner (one per crossing).
        for (const [a] of bands) {
            for (const [c0] of bands) {
                if (rand() < 0.55) post(a - 0.4, c0 - 0.4, true);
            }
        }
        // Roads and props draw as hand-placed pixel cells (PixelDraw) on the
        // world grid — pan-rigid pixel art with zero texture memory. The flat
        // band/meadow fills stay plain quads: solid colors have nothing to
        // quantize, and the shoulder cell-lines own the visible edges. The
        // meadow's outer diamond never needs an edge pass either: the fog's
        // opaque haze floor starts 0.4 tile INSIDE it (ensureFog's inner.min)
        // and the cloud bank stacks over that, so the meadow-to-void
        // silhouette is buried at every sight radius.
        this.wilderness = g;
    }

    // No always-on nameplates: a neighbour's name/trophies/shield show in the
    // plot bubble on tap (openPanel below) — the map itself stays clean.

    // ================= battle indicators & the siege alarm =================

    /** A pulsing battle marker over a plot that is under live attack. */
    private ensureBattle(view: NeighborView, dx: number, dy: number, underAttack: boolean) {
        if (!underAttack) {
            view.battleTween?.stop();
            view.battleTween = null;
            view.battle?.destroy();
            view.battle = null;
            return;
        }
        if (view.battle) return;
        const top = IsoUtils.cartToIso(dx * PLOT_PITCH + PLOT_TILES / 2, dy * PLOT_PITCH + PLOT_TILES / 2);
        const marker = this.scene.add.graphics();
        // Crossed blades over a dark pennon — hand-authored pixel cells
        // (PixelDraw bitmap, LOCAL anchoring: the icon scales with its pulse
        // tween like a baked sprite would). Same palette as the old vector
        // pin; fat 9x9 cells so it reads at map distance.
        const PIN = [
            'rrrrrrrrr',
            'r.......r',
            'r.b...b.r',
            'r..b.b..r',
            'r...b...r',
            'r..b.b..r',
            'r.b...b.r',
            'rg.....gr',
            'rrrrrrrrr'
        ];
        const PIN_CELL = 3.6; // 9 cells ≈ the old 32px pennon
        // Dark pennon plate first (its 0.85 alpha kept), then the opaque
        // border/blades/guards over it.
        pixelBitmap(marker, -16.2, -16.2, PIN.map(row => row.replace(/./g, 'k')),
            { k: 0x2b0f0f }, 0.85, PIN_CELL);
        pixelBitmap(marker, -16.2, -16.2, PIN,
            { r: 0xd82f2f, b: 0xffb0a0, g: 0xd8a24a }, 1, PIN_CELL);
        marker.setPosition(top.x, top.y - 190);
        marker.setDepth(29_400);
        view.battle = marker;
        view.battleTween = this.scene.tweens.add({
            targets: marker,
            scaleX: 1.18,
            scaleY: 1.18,
            alpha: 0.75,
            yoyo: true,
            repeat: -1,
            duration: 520,
            ease: 'Sine.easeInOut'
        });
    }

    /**
     * Single-authority siege signal: driven by MainScene's setUnderAttack
     * (which the App's 2.5s incoming-attack poll feeds). This system never
     * detects sieges itself — one detector, one banner, one panic driver.
     */
    setSiege(attackId: string | null) {
        if (!attackId) {
            if (this.homeAttackId) {
                this.homeAttackId = null;
                this.onSiegeEnded();
            }
            return;
        }
        if (attackId === this.homeAttackId) return;
        this.homeAttackId = attackId;
        if (attackId !== this.dismissedSiegeId) this.onSiegeStarted(attackId);
    }

    /** "LATER" anywhere hides the banner everywhere (the raid stays live). */
    dismissSiege() {
        this.dismissedSiegeId = this.homeAttackId;
        this.scene.villageBubbles?.clear('siege');
    }

    private onSiegeStarted(attackId: string) {
        void attackId;
        // ONE EVENT, ONE SURFACE; history goes to the bell. The pxf
        // incoming-attack card in App.tsx (same 2.5s poll) is THE surface —
        // the watchtower bubble that used to raise here duplicated its text
        // AND its WATCH action, so it stays suppressed. The scene keeps only
        // the diegetic alarm: the horn below and the villager panic that
        // MainScene.setUnderAttack drives.
        soundSystem.play('horn');
    }

    private onSiegeEnded() {
        this.scene.villageBubbles?.clear('siege');
        this.dismissedSiegeId = null;
        // No end-of-attack toast: one event, one surface — the outcome lands
        // in the bell as the defense-log notification (badge increments),
        // and the shield bubble already reports any granted protection.
    }

    // ================= home defence heartbeat =================

    /** Apply the compact server heartbeat forwarded by React. Incoming-attack
     * state uses setSiege; this method owns clock/shield presentation only. */
    applyHomeStatus(authoritativeNow: number, shieldUntil: number) {
        if (!Number.isFinite(authoritativeNow)) return;
        DayNightSystem.serverOffsetMs = authoritativeNow - Date.now();
        const meShield = Math.max(0, Number(shieldUntil) || 0);
        const serverNow = authoritativeNow;
        if (meShield > serverNow + 1000 && meShield > this.myShieldUntil + 1000) {
            const mins = Math.round((meShield - serverNow) / 60_000);
            this.scene.villageBubbles?.raise({
                key: 'shield',
                buildingType: 'town_hall',
                icon: 'sym sym-shield',
                text: `Shielded — ${mins >= 60 ? `${Math.floor(mins / 60)}h ${mins % 60}m` : `${mins}m`}`,
                ttlMs: 9000
            });
            // A brand-new shield after boot means a raid just ended here.
            // The shield band encodes how bad it was (1h/2h/4h) — scar the
            // village accordingly and send the repair crews out.
            if (this.myShieldUntil > 0) {
                const destruction = mins > 150 ? 90 : mins > 80 ? 55 : 25;
                this.scene.villageLife?.applyBattleScars(destruction);
            }
        }
        this.myShieldUntil = meShield;
    }

    // ================= taps & the neighbour sheet =================

    /**
     * Route a world tap: plots resolve through the plot grid (the 2-tile road
     * gaps are dead space), the home plot falls through to village life.
     */
    handleTap(gridX: number, gridY: number): boolean {
        if (this.scene.mode !== 'HOME' || this.views.size === 0) return false;
        const px = Math.floor(gridX / PLOT_PITCH);
        const py = Math.floor(gridY / PLOT_PITCH);
        if (px === 0 && py === 0) return false; // home: village life owns it
        const localX = gridX - px * PLOT_PITCH;
        const localY = gridY - py * PLOT_PITCH;
        if (localX >= PLOT_TILES || localY >= PLOT_TILES) {
            const joined = this.wildernessTopology
                ? classifyJoinedWildernessGapTap(this.wildernessTopology, gridX, gridY, { plotTiles: PLOT_TILES, plotGap: PLOT_GAP })
                : null;
            if (!joined) return false; // an active road remains non-interactive
            const selected = joined.selectedLocalPlot;
            const view = this.views.get(`${joined.selectedWorldPlot.x},${joined.selectedWorldPlot.y}`);
            if (!view) return false;
            this.openPanel(view, selected.x, selected.y);
            return true;
        }
        const view = this.views.get(`${this.myPlot.x + px},${this.myPlot.y + py}`);
        if (!view) return false;
        this.openPanel(view, px, py);
        return true;
    }

    closePanel() {
        gameManager.closePlotPanel();
    }

    /**
     * Claim a chosen bot/open coordinate through server authority, then move
     * the already-live village's world anchor and eagerly paint its new ring.
     * The local layout stays at the scene origin; relocation changes only
     * which absolute plot and neighbours surround it.
     */
    async settlePlot(x: number, y: number): Promise<boolean> {
        if (this.settlementInFlight) return await this.settlementInFlight;
        const task = (async () => {
            if (this.scene.mode !== 'HOME' || this.focusPlot) return false;
            const result = await Backend.relocate(x, y);
            if (!result) {
                gameManager.showToast('That plot cannot be settled right now.');
                return false;
            }
            this.fenceMapRequests(result.serverNow);
            this.applyHomePlot(result.me);
            this.nextRefreshAt = 0;
            await this.refresh();
            gameManager.showToast(`The village packed up and moved to (${result.me.x}, ${result.me.y})!`);
            return true;
        })();
        this.settlementInFlight = task;
        try {
            return await task;
        } finally {
            if (this.settlementInFlight === task) this.settlementInFlight = null;
        }
    }

    /**
     * The neighbour action sheet is DOM (React), not world-space canvas, so it
     * stays fixed-size, accessible and readable at map zoom. This just assembles
     * the actions; the App renders and army-gates them.
     */
    private openPanel(view: NeighborView, dx: number, dy: number) {
        // The bubble hangs over the tapped village, nameplate-style.
        const anchorIso = IsoUtils.cartToIso(dx * PLOT_PITCH + PLOT_TILES / 2, dy * PLOT_PITCH + PLOT_TILES / 2);
        const anchor = { x: anchorIso.x, y: anchorIso.y - 120 };
        // Mirror point under the village art for when the bubble can't fit above.
        const anchorBelow = { x: anchorIso.x, y: anchorIso.y + 120 };
        if (this.fallbackViewsActive) {
            gameManager.openPlotPanel({
                title: 'Uncharted wilderness',
                anchor,
                anchorBelow,
                actions: [{
                    label: 'Map connection unavailable',
                    kind: 'info',
                    run: () => gameManager.showToast('The wilds are visible, but reconnect before scouting or settling.')
                }]
            });
            return;
        }
        const plot = view.plot;
        const nature = plot.kind === 'empty'
            ? WildernessRenderer.natureAt(plot.x, plot.y, this.presentationSeedVersion)
            : null;
        const hydrology = plot.kind === 'empty'
            ? classifyHydrologyPlot(plot.x, plot.y, this.presentationSeedVersion)
            : null;
        const hydrologyFeature = hydrology?.features[0];
        const title = plot.kind === 'empty'
            ? `${plot.settleable === false ? 'Protected wilderness' : 'Unclaimed wilderness'} · ${hydrologyFeature?.label ?? nature?.label ?? 'Wild country'}`
            : (plot.username ?? '???');
        const actions: PlotPanelAction[] = [];
        const settleHere = (): PlotPanelAction => ({
            label: 'Settle here',
            kind: 'settle',
            run: () => { void this.settlePlot(plot.x, plot.y); }
        });
        const requests = gameManager as unknown as {
            requestScoutOnUser(ownerId: string, username: string): void;
            requestWatchLiveAttack(attackId: string, username: string): void;
        };
        if (plot.kind === 'player') {
            if (plot.underAttack && plot.attackId) {
                actions.push({ label: 'Watch live battle', kind: 'watch', run: () => requests.requestWatchLiveAttack(plot.attackId as string, plot.username ?? 'Village') });
            }
            if (plot.ownerId && plot.ownerId !== this.scene.userId) {
                if ((plot as { shielded?: boolean }).shielded) {
                    actions.push({ label: 'Shielded (revenge only)', kind: 'info', run: () => gameManager.showToast('That village is protected — only a revenge right gets through.') });
                } else {
                    actions.push({ label: 'Attack', kind: 'attack', run: () => this.scene.attackPlayerPlotByRoad(plot.ownerId as string, plot.username ?? '???', plot.x, plot.y) });
                }
                actions.push({ label: 'Scout', kind: 'scout', run: () => requests.requestScoutOnUser(plot.ownerId as string, plot.username ?? '???') });
            }
        } else if (plot.kind === 'bot') {
            actions.push({ label: 'Attack', kind: 'attack', run: () => this.scene.attackBotPlot(plot.seed ?? 1, plot.username ?? 'Bot clan', plot.x, plot.y) });
            actions.push(settleHere());
        } else if (plot.settleable !== false) {
            actions.push(settleHere());
        } else {
            actions.push({
                label: hydrologyFeature
                    ? hydrologyFeature.lake
                        ? 'Great Lake preserve'
                        : 'Protected waterway'
                    : 'Wilderness preserve',
                kind: 'info',
                run: () => gameManager.showToast(hydrologyFeature
                    ? `${hydrologyFeature.label} and its watershed are permanently protected.`
                    : 'This wild land is permanently protected and cannot be settled.')
            });
        }
        gameManager.openPlotPanel({ title, trophies: plot.kind === 'empty' ? undefined : plot.trophies ?? 0, anchor, anchorBelow, actions });
    }

    // ================= postcard life =================

    private nextLifeDrawAt = 0;

    /**
     * Keep authoritative worlds for the earned window, but only keep their
     * expensive 1:1 GPU texture near the camera. Ring one is unconditional;
     * visible ring-two views materialize immediately and one offscreen
     * prefetch is admitted per pass to keep camera movement hitch-free.
     */
    private reconcileVillageTextureResidency(time: number) {
        if (time < this.nextResidencyCheckAt) return;
        this.nextResidencyCheckAt = time + 100;
        const camera = this.cameraWorldRect();
        const candidates = [...this.views.values()]
            .filter(view => (view.plot.kind === 'player' || view.plot.kind === 'bot') && view.sourceWorld)
            .map(view => ({
                view,
                decision: decidePostcardResidency({
                    dx: view.dx,
                    dy: view.dy,
                    camera,
                    now: time,
                    lastInterestedAt: view.lastTextureInterestAt,
                    resident: view.contentKind === 'village' && view.rt !== null
                })
            }));

        // Visible/required views cannot wait behind speculative prefetches.
        candidates.sort((a, b) =>
            Number(b.decision.required) - Number(a.decision.required)
            || Number(b.decision.visible) - Number(a.decision.visible)
            || Number(b.decision.prefetched) - Number(a.decision.prefetched));

        let prefetchBudget = 1;
        for (const { view, decision } of candidates) {
            view.lastTextureInterestAt = decision.nextLastInterestedAt;
            if (decision.evict) {
                this.releaseViewVisuals(view, true);
                continue;
            }
            const stale = view.renderedRevision !== view.sourceRevision || view.contentKind !== 'village';
            if ((!decision.materialize && !stale) || !decision.interested || !view.sourceWorld) continue;
            if (!decision.required && !decision.visible) {
                if (prefetchBudget <= 0) continue;
                prefetchBudget--;
            }
            try {
                this.renderSnapshot(view, view.sourceWorld, view.dx, view.dy);
                view.renderedRevision = view.sourceRevision;
                this.ensureBattle(view, view.dx, view.dy, Boolean(view.plot.underAttack));
            } catch (error) {
                console.warn(`postcard rematerialization failed for ${view.key}:`, error);
                this.releaseViewVisuals(view, false);
            }
        }
    }

    private drawNaturePostcardLife(
        g: Phaser.GameObjects.Graphics,
        anchors: readonly WildernessLifeAnchor[],
        time: number,
        nightFactor: number
    ) {
        for (const anchor of anchors) {
            if (anchor.kind === 'fish') {
                const swim = time * 0.00115 + anchor.phase;
                const gx = anchor.gx + Math.cos(swim) * 0.28 * anchor.scale;
                const gy = anchor.gy + Math.sin(swim) * 0.16 * anchor.scale;
                const p = IsoUtils.cartToIso(gx, gy);
                WorldFigureRenderer.drawFish(g, p.x, p.y, time, anchor.phase, anchor.scale);
                continue;
            }

            if (anchor.kind === 'frog') {
                const beat = (time * 0.00038 + anchor.phase / (Math.PI * 2)) % 1;
                const p = IsoUtils.cartToIso(anchor.gx, anchor.gy);
                if (beat < 0.62) {
                    // The spreading ripple as perimeter pixel cells.
                    pixelRing(g, p.x, p.y, (5 + beat * 18) / 2, (2 + beat * 7) / 2,
                        0xb7dcda, 0.34 * (1 - beat / 0.62));
                }
                const blink = Math.sin(time * 0.004 + anchor.phase) > -0.78;
                if (blink) {
                    pixelEllipse(g, p.x, p.y - 1, 3 * anchor.scale, 1.7 * anchor.scale, 0x496f3d, 0.92);
                    pixelEllipse(g, p.x - 1.4 * anchor.scale, p.y - 2.2,
                        0.65 * anchor.scale, 0.65 * anchor.scale, 0xb8c96c, 0.9);
                    pixelEllipse(g, p.x + 1.4 * anchor.scale, p.y - 2.2,
                        0.65 * anchor.scale, 0.65 * anchor.scale, 0xb8c96c, 0.9);
                }
                continue;
            }

            const orbit = time * 0.00065 + anchor.phase;
            const p = IsoUtils.cartToIso(
                anchor.gx + Math.cos(orbit) * 0.55 * anchor.scale,
                anchor.gy + Math.sin(orbit * 0.83) * 0.38 * anchor.scale
            );
            if (nightFactor > 0.38) {
                for (let i = 0; i < 3; i++) {
                    const phase = orbit + i * 2.13;
                    const pulse = 0.45 + Math.sin(time * 0.004 + anchor.phase + i) * 0.35;
                    const x = p.x + Math.cos(phase) * (7 + i * 2) * anchor.scale;
                    const y = p.y - 8 - i * 4 + Math.sin(phase * 1.3) * 4;
                    pixelEllipse(g, x, y, 3.2 * anchor.scale, 3.2 * anchor.scale,
                        0xdff06f, pulse * nightFactor * 0.18);
                    pixelEllipse(g, x, y, 0.9 * anchor.scale, 0.9 * anchor.scale,
                        0xf4f6a6, pulse * nightFactor);
                }
            } else {
                // A tiny butterfly/bird flickers between tree crowns by day —
                // each wing one cell-walked streak (the classic pixel bird V).
                const flap = Math.sin(time * 0.012 + anchor.phase) * 2.2 * anchor.scale;
                const wingAlpha = 0.82 * (1 - nightFactor);
                pixelLine(g, p.x, p.y, p.x - 4 * anchor.scale, p.y - flap, 1, 0xe6c25b, wingAlpha);
                pixelLine(g, p.x, p.y, p.x + 4 * anchor.scale, p.y - flap, 1, 0xe6c25b, wingAlpha);
                pixelRect(g, p.x - 0.6, p.y - 1, 1.2, 4 * anchor.scale, 0x4a3923, 0.9);
            }
        }
    }

    /**
     * Postcards breathe through one compact decoration layer plus exact
     * resident vectors. Static bases stay cached; only visible life redraws.
     */
    private updatePostcardLife(time: number) {
        // Decorations (smoke, pennant, night windows) redraw on the coarse
        // 15 Hz pass; the resident sims are OFFERED a tick every frame and
        // self-gate to their LOD hz — a 66 ms outer gate on the tick calls
        // capped the near ring's shared 24 Hz figure clock at ~12–15 Hz.
        const decorate = time >= this.nextLifeDrawAt;
        if (decorate) this.nextLifeDrawAt = time + 66; // 15Hz decoration pass
        const nf = this.scene.dayNight?.nightFactor() ?? 0;
        const serverWallTime = Date.now() + DayNightSystem.serverOffsetMs;
        // Water life adopted from the road-gap bands (no plot postcard owns
        // it) swims on the overlay's own band, under the same roof mask.
        if (decorate) {
            if (this.worldHydrologyGapLife.length > 0) {
                if (!this.worldHydrologyLifeLayer) {
                    this.worldHydrologyLifeLayer = this.scene.add.graphics();
                    this.worldHydrologyLifeLayer.setDepth(27_501);
                }
                const layer = this.worldHydrologyLifeLayer;
                if (this.worldHydrologyMask) layer.setMask(this.worldHydrologyMask);
                else layer.clearMask();
                layer.clear();
                this.drawNaturePostcardLife(layer, this.worldHydrologyGapLife, time, nf);
            } else if (this.worldHydrologyLifeLayer) {
                this.worldHydrologyLifeLayer.destroy();
                this.worldHydrologyLifeLayer = null;
            }
        }
        for (const view of this.views.values()) {
            if (!view.rt) {
                view.life?.destroy();
                view.life = null;
                view.glow?.destroy();
                view.glow = null;
                continue;
            }
            if (view.contentKind === 'nature') {
                if (!decorate) continue; // no resident sim — 15 Hz is its clock
                if (view.natureLife.length === 0) {
                    view.life?.destroy();
                    view.life = null;
                    continue;
                }
                if (!view.life) {
                    // Per-frame vector life: smooth until its sprite bake
                    // lands (tools/art-preview/AGENTS_SPRITE_PIPELINE.md step 5).
                    view.life = this.scene.add.graphics();
                }
                const hydrologyLife = String(view.renderedRevision).includes('_hydroart_');
                view.life.setDepth(hydrologyLife ? 27_501 : view.rt.depth + 1);
                // Above the seam-free water overlay, the fish still yield to
                // village roof headroom: same inverted mask as the overlay.
                if (hydrologyLife && this.worldHydrologyMask) view.life.setMask(this.worldHydrologyMask);
                else view.life.clearMask();
                view.life.clear();
                this.drawNaturePostcardLife(view.life, view.natureLife, time, nf);
                continue;
            }
            if (!view.hearth) {
                view.life?.destroy();
                view.life = null;
                continue;
            }
            if (decorate) {
                if (!view.life) {
                    view.life = this.scene.add.graphics();
                    view.life.setDepth(view.rt.depth + 1);
                }
                const g = view.life;
                g.setDepth(view.rt.depth + 1);
                g.clear();
                const hearthPos = IsoUtils.cartToIso(view.hearth.gx, view.hearth.gy);
                const seed = hashString(view.key);
                const sway = windSway(view.hearth.gx, view.hearth.gy, time);

                // Chimney smoke: three puffs cycling upward, leaning with the wind.
                const chimneyX = hearthPos.x + 9;
                const chimneyY = hearthPos.y - 34;
                for (let i = 0; i < 3; i++) {
                    const cycle = ((time * 0.00016 + i / 3 + (seed % 97) / 97) % 1);
                    const puffR = 1.8 + cycle * 3;
                    pixelEllipse(g, chimneyX + cycle * (7 + sway * 9), chimneyY - cycle * 20,
                        puffR, puffR, 0xdfe3e8, 0.22 * (1 - cycle));
                }

                // The village standard on the hall roof — the neighbour's
                // REAL heraldry (their explicit banner choice riding the
                // postcard payload, with a fallback only for bots), miniature
                // but exact: the same design their town hall flies up close.
                // Pole foot on the gold apex ball, same per-level geometry
                // the live hall banner uses (townHallApexLift) — the old
                // hand-tuned (−8, −30) sat the pole in the roof slope.
                const poleX = hearthPos.x;
                const poleY = hearthPos.y - townHallApexLift(view.hearth.level);
                const bannerSource = sanitizeVillageBanner(
                    (view.sourceWorld as WorldPostcard | null)?.banner
                    ?? view.plot.world?.banner
                );
                const flagIdentity = view.plot.kind === 'bot'
                    ? `bot_${view.plot.seed ?? 0}`
                    : (view.plot.ownerId ?? view.key);
                const allowFallback = view.plot.kind === 'bot';
                const flagKey = `${flagIdentity}|${bannerSource ? `${bannerSource.palette}.${bannerSource.emblem}.${bannerSource.pattern}` : allowFallback ? 'bot-default' : 'empty'}`;
                if (!bannerSource && !allowFallback) {
                    view.flag = null;
                    view.flagKey = flagKey;
                } else {
                    if (!view.flag || view.flagKey !== flagKey) {
                        view.flag = bannerDesignFor(flagIdentity, bannerSource);
                        view.flagKey = flagKey;
                    }
                    // 2x of the old miniature (owner request, in step with the
                    // live hall banner's 2x) — reads at postcard distance
                    // without dominating the plot.
                    drawVillageFlag(g, poleX, poleY, time, view.flag, 1, { poleH: 28, clothW: 26, clothH: 16, amp: 2 });
                }

                // After dark: two warm windows glowing by the hall.
                if (nf > 0.05) {
                    pixelEllipse(g, hearthPos.x - 14, hearthPos.y - 8, 3.5, 2.2, 0xffc36a, 0.34 * nf);
                    pixelEllipse(g, hearthPos.x + 12, hearthPos.y - 4, 3, 1.9, 0xffc36a, 0.34 * nf);
                }
            }

            // The neighbours are HOME: real villagers walking real routes —
            // the same pathfinding and door-visits the live village runs,
            // redrawn often up close and sparsely at the horizon. Their state
            // is sampled from shared server wall time, independent of redraws.
            const [kx, ky] = view.key.split(',').map(Number);
            const centerPlot = this.focusPlot ?? this.myPlot;
            const ring = Math.max(Math.abs(kx - (centerPlot?.x ?? 0)), Math.abs(ky - (centerPlot?.y ?? 0)));
            const cam = this.scene.cameras.main;
            const vw = cam.width / cam.zoom;
            const vh = cam.height / cam.zoom;
            const vx = cam.scrollX + (cam.width - vw) * 0.5;
            const vy = cam.scrollY + (cam.height - vh) * 0.5;
            const onScreen = view.rt.x < vx + vw + 200 && view.rt.x + view.rt.width / (view.rt.scaleX || 1) > vx - 200
                && view.rt.y < vy + vh + 200 && view.rt.y + view.rt.height / (view.rt.scaleY || 1) > vy - 200;
            // Near neighbors animate on the SAME shared figure clock as the
            // home village (2× the old LOD rate — the owner's sweet spot);
            // far rings stay lean, off-screen stays a heartbeat.
            const hz = !onScreen ? 1.5 : ring <= 1 ? FIGURE_ANIM_HZ : 10;
            this.neighborLife.tick(view.key, serverWallTime, hz, onScreen, nf);
        }
    }

    // ================= lifecycle =================

    /** Drop only GPU/display resources; retained sourceWorld remains cheap and authoritative. */
    private releaseViewVisuals(view: NeighborView, countEviction: boolean) {
        const hadVillageTexture = view.contentKind === 'village' && view.rt !== null;
        // Per-key registries are shared between the live ring and hidden
        // pending-focus views under the same absolute keys: only the view
        // that actually registered may clear them, or dropping an abandoned
        // battle ring kills its live twin's villagers and night lights.
        if (view.residentsRegistered) {
            this.scene.dayNight?.clearPostcardLights?.(view.key);
            this.neighborLifeSim?.removeVillage(view.key);
            view.residentsRegistered = false;
        }
        view.rt?.destroy();
        view.rt = null;
        view.glow?.destroy();
        view.glow = null;
        view.lightAnchors = [];
        view.contentKind = null;
        view.renderedRevision = null;
        view.battleTween?.stop();
        view.battleTween = null;
        view.battle?.destroy();
        view.battle = null;
        view.life?.destroy();
        view.life = null;
        view.hearth = null;
        view.natureLife = [];
        view.natureWaters = null;
        if (countEviction && hadVillageTexture) this.textureEvictions += 1;
    }

    private destroyView(view: NeighborView) {
        this.releaseViewVisuals(view, false);
        view.sourceWorld = null;
        view.sourceRevision = null;
    }

    teardown(invalidateMapRequests = true) {
        this.neighborLifeSim?.destroy();
        if (invalidateMapRequests) this.fenceMapRequests();
        ++this.focusEpoch;
        this.cancelMarch();
        this.dropPendingFocus();
        for (let i = this.travellers.length - 1; i >= 0; i--) this.removeTraveller(i);
        this.lastTravellerUpdateAt = 0;
        for (const view of this.views.values()) this.destroyView(view);
        this.views.clear();
        if (this.parkedHomeViews) {
            for (const view of this.parkedHomeViews.values()) this.destroyView(view);
            this.parkedHomeViews.clear();
            this.parkedHomeViews = null;
        }
        this.parkedHomeKindHints = null;
        this.fallbackViewsActive = false;
        this.wilderness?.destroy();
        this.wilderness = null;
        this.wildernessLinks?.destroy();
        this.wildernessLinks = null;
        this.wildernessGapSurface?.destroy();
        this.wildernessGapSurface = null;
        this.worldHydrologyLayer?.destroy();
        this.worldHydrologyLayer = null;
        this.worldHydrologyLifeLayer?.destroy();
        this.worldHydrologyLifeLayer = null;
        this.worldHydrologyGapLife = [];
        this.worldHydrologyMask?.destroy();
        this.worldHydrologyMask = null;
        this.worldHydrologyMaskGfx?.destroy();
        this.worldHydrologyMaskGfx = null;
        this.wildernessTopology = null;
        // The layers above are gone; the cached paint signature MUST die with
        // them, or the next rebuild (after a replay/scout/failed-attack round
        // trip) early-returns into a world with no grass bridges, no junction
        // bends, no gap surface and no hydrology overlay — and joined-gap
        // taps dead because wildernessTopology stays null.
        this.wildernessLinkSignature = null;
        this.knownPlotKindHints.clear();
        this.fogStatic?.destroy();
        this.fogStatic = null;
        this.fogStaticCover = null;
        this.fogEdge?.destroy();
        this.fogEdge = null;
        this.fogRadius = -1;
        // A reveal caught mid-animation dies with the fog it was driving;
        // the next mode-appropriate ensureFog rebuilds the final state.
        this.cancelPendingFogReveal();
        this.fogReveal = null;
        this.fogRevealBoundary = null;
    }


    // ================= fog of war =================
    //
    // Past the watchtower's sight the world dissolves into cloud, built from
    // ONE shape family: the plump flat-bottomed cumulus — a chain of grounded
    // dome lobes over a level base, drawn as three stacked opaque silhouettes
    // (belly shadow, sunlit body lifted off it, crown light on the NW
    // shoulders — the Clash-of-Clans cloud). ONE field model, two layers:
    //
    //   1. The DEEP BANK (fogStatic; rebuilt on sight/coverage change, ~15 Hz
    //      while a reveal marches): a WORLD-ANCHORED LATTICE FIELD. Every
    //      lattice cell owns at most one puff whose seed — size, lobes,
    //      breath, jitter — is a pure hash of its world cell coords, and
    //      whose ROLE derives from its Chebyshev distance to the revealed
    //      square (paintFogBank): just past the rampart sits the packed
    //      front band, behind it the paler back band dissolving into one
    //      flat near-white floor to the horizon, and past that NOTHING —
    //      every sculpted shape lives at the shore; deep sky is clean.
    //      There are NO per-side rows and NO contour parameterization:
    //      corners resolve naturally on the lattice (a corner cell's outward
    //      normal points diagonally), so an animated boundary can never
    //      stretch the bank into strips or cross it at the corners. During a
    //      reveal the boundary square interpolates and each cell re-derives
    //      its role per frame: cells swallowed by the new sight EVAPORATE in
    //      place (opaque quantized shrink + a push along their own outward
    //      normal — never translucency), cells ahead of the shore condense
    //      in, and the landed frame IS the steady generation by construction.
    //   2. The LIVING EDGE (fogEdge, ~15 Hz, view-culled): the breathing
    //      front rampart riding the (possibly animating) boundary square —
    //      huge masses on an ABSOLUTE t-lattice (stable seeds while the
    //      square grows), with taller crests swelling behind. It CARRIES the
    //      shore role outward during a reveal, so the shore stays a shore
    //      for the whole march.

    /**
     * One plump cumulus, base level at (x, y), body width w. Three opaque
     * passes — shadow silhouette, the same silhouette lifted for the sunlit
     * body (a sliver of shadow stays visible under every lobe), crown light
     * on the two tallest domes. Opaque fills only: overlaps never darken.
     */
    /** Fat storybook cloud texel — clouds read from far away, so they use a
     *  7.5× cell (owner calls: 5×, then "1.5× more pixelated"). Shared by the
     *  puffs AND the reveal veil so every fog edge sits on ONE cell grid. */
    private static readonly CLOUD_CELL = 1.35 * 7.5;

    private static puff(
        g: Phaser.GameObjects.Graphics,
        x: number, y: number, w: number, seed: number,
        shadow: number, body: number, crown: number,
        breath = 0.5, alpha = 1
    ) {
        const s = w * (0.92 + breath * 0.16);
        const lift = s * 0.085;
        const lobeN = 3 + (seed % 3);
        const lobes: Array<[number, number, number]> = [];
        for (let i = 0; i < lobeN; i++) {
            const t = (i / (lobeN - 1)) * 2 - 1;
            const rj = ((seed >> (i * 3)) % 7) / 7;
            const r = s * (0.30 - 0.105 * t * t + rj * 0.055);
            lobes.push([x + t * s * 0.36, y - r * 0.94, r]);
        }
        // Lobes land as whole pixel cells (PixelDraw): the cloud wall — both
        // the static bank and the living edge — is chunky pixel art with no
        // AA rim.
        const CLOUD_CELL = WorldMapSystem.CLOUD_CELL;
        const pass = (color: number, dy: number) => {
            for (const [cx, cy, r] of lobes) pixelEllipse(g, cx, cy + dy, r, r, color, alpha, CLOUD_CELL);
            pixelRect(g, x - s * 0.42, y - s * 0.13 + dy, s * 0.84, s * 0.13, color, alpha, CLOUD_CELL);
        };
        pass(shadow, 0);
        pass(body, -lift);
        const tall = [...lobes].sort((a, b) => b[2] - a[2]);
        for (let i = 0; i < 2 && i < tall.length; i++) {
            const [cx, cy, r] = tall[i];
            pixelEllipse(g, cx - r * 0.22, cy - r * 0.26 - lift, r * 0.52, r * 0.52, crown, alpha, CLOUD_CELL);
        }
    }

    /** The revealed inner square a given sight radius earns. */
    private static fogSquareOf(radius: number): { min: number; max: number } {
        return { min: -radius * PLOT_PITCH - PLOT_GAP - 0.4, max: (radius + 1) * PLOT_PITCH + 0.4 };
    }

    private ensureFog(radius: number) {
        // A live reveal owns fogStatic; any direct ensureFog call while one
        // runs (focus swap, wilderness fallback, home relocation) is an
        // interruption and must snap straight to the caller's final state —
        // cancelFogReveal invalidates fogRadius so the cache check below can
        // never keep a half-faded transition frame alive.
        this.cancelFogReveal();
        if (radius === this.fogRadius && this.fogStatic) return;
        this.fogRadius = radius;
        this.fogStatic?.destroy();
        const g = this.scene.add.graphics();
        g.setDepth(28_500); // above every postcard, below the day/night grade
        const inner = WorldMapSystem.fogSquareOf(radius);
        // Roaming lights (edge-camp bonfires, the caravan lantern) must never
        // wash over the cloud bank: hand the discovered square to the light
        // system so it hems pools in as they near this boundary.
        this.scene.dayNight?.setSightBound?.({ min: inner.min, max: inner.max });
        this.paintFogFloor(g, inner);
        // Deep cloud bank: every puff already lands as pixel cells via
        // WorldMapSystem.puff → PixelDraw.
        const cover = this.fogCoverRect(700);
        this.paintFogBank(g, inner, cover);
        this.fogStaticCover = cover;
        this.fogStatic = g;
    }

    /** Camera rect (plus margin) a culled bank build is valid for. */
    private fogCoverRect(margin: number) {
        const wv = this.scene.cameras.main.worldView;
        const mx = wv.width * 0.5 + margin;
        const my = wv.height * 0.5 + margin;
        return { x: wv.x - mx, y: wv.y - my, right: wv.right + mx, bottom: wv.bottom + my };
    }

    /**
     * 1. The floor: one flat, near-white frame from `inner` out to the
     * horizon. Past the edge line the sky is deliberately EMPTY — the bank
     * silhouette does all the talking.
     */
    private paintFogFloor(g: Phaser.GameObjects.Graphics, inner: { min: number; max: number }) {
        const far = 7 * PLOT_PITCH;
        const P = (x: number, y: number) => IsoUtils.cartToIso(x, y);
        const HAZE = 0xeaf0f6;
        g.fillStyle(HAZE, 1);
        const lo = inner.min - far;
        const hi = inner.max + far;
        const frame = (ax: number, ay: number, bx: number, by: number, cx: number, cy: number, dx: number, dy: number) => {
            const a = P(ax, ay), b = P(bx, by), c = P(cx, cy), d = P(dx, dy);
            g.fillPoints([
                new Phaser.Math.Vector2(a.x, a.y),
                new Phaser.Math.Vector2(b.x, b.y),
                new Phaser.Math.Vector2(c.x, c.y),
                new Phaser.Math.Vector2(d.x, d.y)
            ], true);
        };
        // E/W bands overlap the N/S bands by a tile so no hairline seam
        // shows where adjacent opaque quads meet.
        frame(lo, lo, hi, lo, hi, inner.min + 1, lo, inner.min + 1);
        frame(lo, inner.max - 1, hi, inner.max - 1, hi, hi, lo, hi);
        frame(lo, inner.min, inner.min + 1, inner.min, inner.min + 1, inner.max, lo, inner.max);
        frame(inner.max - 1, inner.min, hi, inner.min, hi, inner.max, inner.max - 1, inner.max);
    }

    /**
     * The deep bank's field constants. Depths are measured on dEff — the
     * signed Chebyshev distance to the revealed square plus the north-facing
     * TUCK — in world tiles:
     *
     *      dEff <  IN            swept by the sight: quantized evaporation
     *   IN ≤ dEff < SPLIT        front band (shoulders the rampart)
     *   SPLIT ≤ dEff < OUT       back band (bigger, paler, half a step deep)
     *      dEff ≥  OUT           nothing — the flat haze floor only
     *
     * PITCH×PITCH lattice cells at JITTERed centers reproduce the old two
     * packed rows' linear density (~0.53 puffs per shore tile); GROW ramps
     * the outer fringe in over quantized size steps so the back band still
     * dissolves into the floor, and a marching boundary condenses its bank
     * ahead of the shore instead of popping it in.
     */
    private static readonly FOG_FIELD = {
        PITCH: 3.0,
        JITTER: 0.95,
        IN: 2.1,
        SPLIT: 4.9,
        OUT: 7.7,
        GROW: 1.5,
        /** Tiles of continued sweep over which a swallowed cell dissolves. */
        EVAP: 4.0,
        /** Outward push (world tiles, × dissolve) on an evaporating cell. */
        DRIFT: 2.5,
        /** A cumulus BODY always rises up-screen from its base. On the two
         *  SOUTH-facing sides (screen-bottom edges) that body climbs back
         *  over the boundary and buries the horizon road; on the NORTH-
         *  facing sides (screen-top edges) it climbs AWAY, leaving the road
         *  bare to the haze floor. Tucking north-side bases ~half a body
         *  height further in seats their flat bottoms over that road with
         *  only a modest lap onto the outermost lawns (owner-tuned 3.0; the
         *  full-height 6.0 crowded the lawns). Blended across corner wedges
         *  so the band never steps. */
        TUCK: 3.0
    } as const;

    /** Deterministic 32-bit hash of a lattice cell — THE puff seed. */
    private static fogHash(i: number, j: number): number {
        let h = Math.imul(i, 0x9e3779b1) ^ Math.imul(j + 0x5f356495, 0x85ebca6b);
        h ^= h >>> 13;
        h = Math.imul(h, 0xc2b2ae35);
        h ^= h >>> 16;
        return h >>> 0;
    }

    /**
     * The cloud field at a world point: signed Chebyshev distance to the
     * revealed square (positive = in the fog), the outward normal (diagonal
     * in corner wedges — corners resolve naturally, they can never cross),
     * and the tuck-adjusted band depth dEff.
     */
    private static fogFieldAt(gx: number, gy: number, b: { min: number; max: number }) {
        const ox = Math.max(b.min - gx, gx - b.max);
        const oy = Math.max(b.min - gy, gy - b.max);
        const d = Math.max(ox, oy);
        let nx: number;
        let ny: number;
        if (d > 0) {
            // Outside: direction from the nearest boundary point — pure axis
            // beside a side, swinging continuously to the diagonal past a
            // corner (the Euclidean projection direction).
            const vx = gx < b.min ? gx - b.min : gx > b.max ? gx - b.max : 0;
            const vy = gy < b.min ? gy - b.min : gy > b.max ? gy - b.max : 0;
            const len = Math.hypot(vx, vy) || 1;
            nx = vx / len;
            ny = vy / len;
        } else if (ox >= oy) {
            // Inside (an evaporating cell): toward the nearest side.
            nx = gx - b.min < b.max - gx ? -1 : 1;
            ny = 0;
        } else {
            nx = 0;
            ny = gy - b.min < b.max - gy ? -1 : 1;
        }
        // North-facing tuck weight: 1 on the up-screen sides, 0 on the
        // down-screen sides, blending across mixed-corner wedges.
        const t = Math.min(1, (Math.max(0, -nx) + Math.max(0, -ny)) / (Math.abs(nx) + Math.abs(ny) || 1));
        return { d, nx, ny, dEff: d + WorldMapSystem.FOG_FIELD.TUCK * t };
    }

    /**
     * 2. The deep bank as a world-anchored lattice field around `bound` (the
     * steady revealed square, or the animated one mid-reveal). Every cell's
     * puff — position jitter, size, breath, palette band, departure step —
     * is a pure function of (cell hash, its dEff against `bound`), so the
     * bank can neither stretch nor crosshatch: a marching boundary just
     * re-ranks the same world-anchored puffs, and the landed frame is the
     * steady generation by construction.
     *
     * Shadow tones sit near the neighbour layer's body tone so overlap rims
     * read as soft creases, not outlines. Paint order: evaporating cells,
     * then the front band, then the back band over it (the old row order).
     * Dissolve is opaque EVAPORATION, never translucency: puff is a
     * stacked-silhouette design — any alpha < 1 leaks the shadow pass
     * through the lifted body and double-darkens the deliberately packed
     * overlaps. Each swallowed cell owns one of five quantized departure
     * steps; past its step it is GONE, before it it wanes and drifts along
     * its own outward normal — every survivor still paints fully opaque.
     * `cull` keeps generation to the camera's neighbourhood (see
     * fogStaticCover for the escape-repaint contract).
     */
    private paintFogBank(
        g: Phaser.GameObjects.Graphics,
        bound: { min: number; max: number },
        cull: { x: number; y: number; right: number; bottom: number } | null
    ) {
        const F = WorldMapSystem.FOG_FIELD;
        const L = F.PITCH;
        const reach = F.OUT + F.JITTER + 0.5;
        const innerReach = F.IN - F.EVAP - F.JITTER - F.TUCK - 0.5;
        const i0 = Math.floor((bound.min - reach) / L);
        const i1 = Math.ceil((bound.max + reach) / L);
        // Widest puff paints ~±170 px around its base; pad the screen cull.
        const PAD = 340;
        type Op = { x: number; y: number; w: number; seed: number; breath: number };
        const evap: Op[] = [];
        const front: Op[] = [];
        const back: Op[] = [];
        for (let j = i0; j <= i1; j++) {
            for (let i = i0; i <= i1; i++) {
                // Cheap ring reject on the raw center (jitter/tuck in slack).
                const cgx = (i + 0.5) * L;
                const cgy = (j + 0.5) * L;
                const cd = Math.max(
                    Math.max(bound.min - cgx, cgx - bound.max),
                    Math.max(bound.min - cgy, cgy - bound.max));
                if (cd > reach || cd < innerReach) continue;
                const h = WorldMapSystem.fogHash(i, j);
                const gx = cgx + ((h & 1023) / 1023 - 0.5) * 2 * F.JITTER;
                const gy = cgy + (((h >>> 10) & 1023) / 1023 - 0.5) * 2 * F.JITTER;
                const f = WorldMapSystem.fogFieldAt(gx, gy, bound);
                if (f.dEff >= F.OUT) continue;
                const isFront = f.dEff < F.SPLIT;
                let w = (isFront ? 215 : 262) + (h % 55);
                // The front band plumps toward the old row-A line so the
                // shoulder against the rampart stays continuous.
                if (isFront) w *= 1 + 0.12 * Math.max(0, 1 - Math.abs(f.dEff - 3.4) / 1.4);
                let drift = 0;
                if (f.dEff < F.IN) {
                    // Swallowed by the (marching) sight: quantized opaque
                    // evaporation over the next EVAP tiles of sweep. Each
                    // cell departs at its own step (spread past p=0.15 so a
                    // freshly swallowed cell never blinks out instantly);
                    // survivors wane and chase the wall.
                    const p = Math.min(1, (F.IN - f.dEff) / F.EVAP);
                    if (0.15 + (((h >>> 4) % 5) / 5) * 0.75 < p - 1e-6) continue;
                    w *= 1 - p * 0.45;
                    drift = F.DRIFT * p;
                } else {
                    // Condensing in at the outer fringe — in steady state
                    // this is the back band's soft dissolve into the floor.
                    const q = Math.ceil(Math.min(1, (F.OUT - f.dEff) / F.GROW) * 5) / 5;
                    w *= 0.55 + 0.45 * q;
                }
                const c = IsoUtils.cartToIso(gx + f.nx * drift, gy + f.ny * drift);
                if (cull && (c.x < cull.x - PAD || c.x > cull.right + PAD
                    || c.y < cull.y - PAD || c.y > cull.bottom + PAD)) continue;
                (f.dEff < F.IN ? evap : isFront ? front : back)
                    .push({ x: c.x, y: c.y, w, seed: h % 100000, breath: ((h >>> 16) % 100) / 100 });
            }
        }
        const paint = (ops: Op[], shadow: number, body: number, crown: number) => {
            for (const o of ops) WorldMapSystem.puff(g, o.x, o.y, o.w, o.seed, shadow, body, crown, o.breath);
        };
        paint(evap, 0xc3d1e0, 0xe5ecf3, 0xf3f7fb);
        paint(front, 0xc3d1e0, 0xe5ecf3, 0xf3f7fb);
        paint(back, 0xc0cddb, 0xd8e2ec, 0xe9eff5);
    }

    /** Hold a sight gain at its old boundary while the expanded postcards paint. */
    private queueFogReveal(fromRadius: number, toRadius: number) {
        const epoch = ++this.fogRevealPreparationEpoch;
        this.pendingFogReveal = {
            // Two rapid gains collapse into one covered preload/reveal. If a
            // prior target is still preparing, keep its original cloud wall.
            fromRadius: this.pendingFogReveal?.fromRadius ?? fromRadius,
            toRadius,
            epoch,
            ready: false
        };
        this.nextRefreshAt = 0;
        void this.preparePendingFogReveal(epoch);
    }

    /** Fetch the exact target window and force every normally-deferred village
     *  postcard resident. Completion only arms the NEXT update frame. */
    private async preparePendingFogReveal(epoch: number): Promise<void> {
        const pending = this.pendingFogReveal;
        if (!pending || pending.epoch !== epoch || pending.ready) return;
        try {
            const result = await this.refresh({
                requiredRadius: pending.toRadius,
                forceVillageTextures: true
            });
            const current = this.pendingFogReveal;
            if (!current || current.epoch !== epoch || current.ready) return;
            if (result.accepted
                && result.requestedRadius >= current.toRadius
                && this.revealWindowReady(current.toRadius)) {
                current.ready = true;
                this.nextRefreshAt = this.lastUpdateTime + REFRESH_MS;
                return;
            }
        } catch (error) {
            console.warn('Watchtower reveal preparation failed; keeping clouds closed:', error);
        }
        const current = this.pendingFogReveal;
        if (current?.epoch === epoch) this.nextRefreshAt = this.lastUpdateTime + 750;
    }

    /** Every coordinate must own its final/current visual, not just metadata. */
    private revealWindowReady(radius: number): boolean {
        const now = this.scene.time?.now ?? this.lastUpdateTime;
        for (let dy = -radius; dy <= radius; dy++) {
            for (let dx = -radius; dx <= radius; dx++) {
                if (dx === 0 && dy === 0) continue;
                const x = this.myPlot.x + dx;
                const y = this.myPlot.y + dy;
                if (x < -WORLD_COORD_LIMIT || x > WORLD_COORD_LIMIT
                    || y < -WORLD_COORD_LIMIT || y > WORLD_COORD_LIMIT) continue;
                const view = this.views.get(`${x},${y}`);
                if (!view || view.dx !== dx || view.dy !== dy) return false;
                const expectedNatureRevision = view.plot.kind === 'empty'
                    ? this.wildernessRevisionAt(x, y)
                    : undefined;
                const ready = isRevealPostcardReady({
                    kind: view.plot.kind,
                    hasTexture: Boolean(view.rt?.active),
                    contentKind: view.contentKind,
                    renderedRevision: view.renderedRevision,
                    sourceRevision: view.sourceRevision,
                    hasSourceWorld: view.sourceWorld !== null,
                    expectedNatureRevision
                });
                if (!ready) return false;
                // Forced ring-two textures survive the complete 3 s pull-back;
                // normal camera-driven residency takes over afterward.
                if (view.plot.kind !== 'empty') view.lastTextureInterestAt = now;
            }
        }
        return true;
    }

    /** Called only from update(): the prepared textures therefore receive one
     *  fully covered render frame at t=0 before the boundary can move. */
    private startPreparedFogReveal() {
        const pending = this.pendingFogReveal;
        if (!pending?.ready) return;
        this.pendingFogReveal = null;
        this.beginFogReveal(pending.fromRadius, pending.toRadius);
    }

    private cancelPendingFogReveal() {
        this.fogRevealPreparationEpoch += 1;
        this.pendingFogReveal = null;
    }

    /**
     * An in-session watchtower sight gain: instead of swapping the cloud
     * bank in one frame, pull it back over ~3 s with the musical flourish
     * and the neighborhood camera framing (500 ms Sine zoom-out overlapping
     * the reveal). Every animation frame is a pure function of
     * (transition state, time) — no per-frame randomness anywhere.
     */
    private beginFogReveal(fromRadius: number, toRadius: number) {
        // A second gain landing mid-reveal chains from wherever the clouds
        // are RIGHT NOW instead of teleporting back to the old square — and
        // it silently extends the SAME reveal: one stinger, one toast, one
        // camera framing per pull-back, never a re-fired fanfare. The field
        // painter reads only the animated boundary, so retargeting is
        // seamless by construction: no dissolve state restarts, no lattice
        // swaps, no single-frame pop — the shore just keeps marching toward
        // the new square.
        const chained = this.fogReveal !== null;
        const fromBound = this.fogRevealBoundary
            ? { ...this.fogRevealBoundary }
            : WorldMapSystem.fogSquareOf(fromRadius);
        this.fogReveal = {
            fromBound,
            toBound: WorldMapSystem.fogSquareOf(toRadius),
            startTime: this.lastUpdateTime,
            durationMs: 3000
        };
        // Seed the animated boundary immediately: drawFogEdge keys its
        // liveness off it, so a reveal begun while the fog is torn down
        // (fogRadius === -1) still grows its breathing front edge from the
        // very first frame instead of only at completion.
        this.fogRevealBoundary = { ...fromBound };
        this.nextFogRevealRebuildAt = 0;
        if (chained) return;
        musicSystem.stinger('reveal');
        // showNeighborhood() is a zoom TOGGLE: invoked at/near the world
        // overview zoom it would zoom IN to the village instead. Mirror its
        // own threshold (MainScene.showNeighborhood clamps neighborhoodZoom
        // to at most min(defaultZoom, sight >= 2 ? 0.24 : 0.42) and opens the
        // world only when the current logical zoom exceeds it by 0.06) using
        // that clamp ceiling as a conservative bound — frame the world only
        // when the toggle is guaranteed to zoom OUT.
        const zoomCeil = Math.min(MobileUtils.getDefaultZoom(), toRadius >= 2 ? 0.24 : 0.42);
        if (toLogicalZoom(this.scene.cameras.main.zoom) > zoomCeil + 0.06) {
            gameManager.showNeighborhood();
        }
        gameManager.showToast('The clouds pull back — new lands revealed!');
    }

    /** Drop a live reveal; the next ensureFog snaps to the final state. */
    private cancelFogReveal() {
        if (!this.fogReveal) return;
        this.fogReveal = null;
        this.fogRevealBoundary = null;
        // fogStatic currently holds a mid-transition frame — it must never
        // satisfy ensureFog's `radius === fogRadius` cache check.
        this.fogRadius = -1;
    }

    /** One reveal animation frame: deep bank + haze at the eased boundary. */
    private updateFogReveal(time: number) {
        const tr = this.fogReveal;
        if (!tr) return;
        const t = Phaser.Math.Clamp((time - tr.startTime) / tr.durationMs, 0, 1);
        if (t >= 1) {
            // Land EXACTLY in the instant path's final state: fogStatic at
            // the new radius, fogRadius set, setSightBound final.
            this.fogReveal = null;
            this.fogRevealBoundary = null;
            this.ensureFog(this.pendingFogReveal?.fromRadius ?? this.computeViewRadius());
            return;
        }
        // The living edge redraws at 15 Hz; the marching bank matches it —
        // rebuilding a few hundred puffs faster buys nothing visible.
        if (time < this.nextFogRevealRebuildAt) return;
        this.nextFogRevealRebuildAt = time + 66;
        const e = 0.5 - 0.5 * Math.cos(Math.PI * t); // easeInOutSine
        const anim = {
            min: Phaser.Math.Linear(tr.fromBound.min, tr.toBound.min, e),
            max: Phaser.Math.Linear(tr.fromBound.max, tr.toBound.max, e)
        };
        this.fogRevealBoundary = anim;
        // Lighting expands with the clouds, not behind them.
        this.scene.dayNight?.setSightBound?.({ min: anim.min, max: anim.max });
        this.fogStatic?.destroy();
        const g = this.scene.add.graphics();
        g.setDepth(28_500);
        this.paintFogFloor(g, anim);
        // ONE call paints the whole animation frame: the world-anchored
        // field re-derives every cell's role from the animated boundary —
        // swallowed cells evaporate in place along their own normals, the
        // bank condenses in ahead of the marching shore, corners stay
        // corners, and the landed frame is the steady generation itself.
        const cover = this.fogCoverRect(700);
        this.paintFogBank(g, anim, cover);
        this.fogStaticCover = cover;
        this.fogStatic = g;
    }

    /**
     * The living edge, redrawn ~15 times a second and culled to the camera.
     * Not a row of clouds — ONE continuous billowing rampart: huge masses
     * packed at less than half their own width, so every silhouette lobe
     * belongs to the same bank, each breathing and looming on its own slow
     * clock, with taller crests swelling behind.
     */
    private drawFogEdge(time: number) {
        // A live reveal is its own liveness signal: it can begin while the
        // fog is torn down (fogRadius === -1 — a gain landing right after a
        // cloud-transition teardown) and the marching bank still needs its
        // breathing front edge for the whole animation, not just at the end.
        if (this.fogRadius < 0 && !this.fogRevealBoundary) return;
        if (time < this.nextFogEdgeAt) return;
        this.nextFogEdgeAt = time + 66;
        if (!this.fogEdge) {
            // Living rampart is per-frame vector: smooth until its sprite
            // bake lands (tools/art-preview/AGENTS_SPRITE_PIPELINE.md step 5).
            this.fogEdge = this.scene.add.graphics();
            this.fogEdge.setDepth(28_502);
        }
        const g = this.fogEdge;
        g.clear();
        // A live reveal drives the rampart at the animated boundary, so the
        // living edge marches out in step with the deep bank behind it.
        const inner = this.fogRevealBoundary
            ?? { min: -this.fogRadius * PLOT_PITCH - PLOT_GAP - 0.4, max: (this.fogRadius + 1) * PLOT_PITCH + 0.4 };
        const T = time * 0.001;
        const wv = this.scene.cameras.main.worldView;
        const CULL = 420;

        // Shadow rims near the bank rows' body tones — the front rampart
        // blends into the rows behind instead of outlining against them.
        const SHADOW = 0xc9d6e3;
        const BODY = 0xe9eff5;
        const CROWN = 0xf9fbfd;
        const CREST_SHADOW = 0xc2cfdd;
        const CREST_BODY = 0xdbe4ee;
        const CREST_CROWN = 0xedf2f7;

        const step = 2.0;
        for (let side = 0; side < 4; side++) {
            // Absolute t-lattice (multiples of `step`), NOT anchored on
            // inner.min: while a reveal animates the boundary every mass
            // keeps its seed — anchoring on the moving edge re-rolled every
            // silhouette ~15×/s into a boiling wall.
            for (let t = Math.ceil((inner.min - 4) / step) * step; t <= inner.max + 4; t += step) {
                const ix = Math.round((t + 10_000) * 7) + side * 7919;
                const h = (Math.imul(ix, 2654435761) >>> 0) % 1000;
                // Big masses swell slowly — compress the breath so the bank
                // rolls instead of popping.
                const phase = T * (0.1 + (h % 5) * 0.035) + h;
                const breath = 0.32 + 0.36 * (0.5 + 0.5 * Math.sin(phase));
                const drift = Math.sin(T * 0.05 + h * 0.7) * 0.8;
                const along = t + drift;
                const out = 1.1 + ((h >> 3) % 20) / 24;
                // North-facing sides tuck in (see FOG_FIELD.TUCK): the
                // rampart's flat bottoms must swallow the horizon road there,
                // because their bodies billow away from the map instead of
                // back over the boundary like the south sides' do. Scaled
                // with FOG_FIELD.TUCK (same half-step back from 3.9).
                const EDGE_TUCK = 2.0;
                let gx: number;
                let gy: number;
                if (side === 0) { gx = along; gy = inner.min - out + EDGE_TUCK; }
                else if (side === 1) { gx = along; gy = inner.max + out; }
                else if (side === 2) { gx = inner.min - out + EDGE_TUCK; gy = along; }
                else { gx = inner.max + out; gy = along; }
                const c = IsoUtils.cartToIso(gx, gy);
                if (c.x < wv.x - CULL || c.x > wv.right + CULL || c.y < wv.y - CULL || c.y > wv.bottom + CULL) continue;
                const size = 190 + (h % 90);
                const bob = Math.sin(T * 0.14 + h * 1.1) * 2.6;

                // Taller crests swelling behind the rampart — every third
                // mass, merged into it rather than floating above.
                if (h % 3 === 0) {
                    const pPhase = T * 0.07 + h * 1.7;
                    const rise = (0.5 + 0.5 * Math.sin(pPhase)) * 10;
                    const px = c.x + ((h >> 5) % 60) - 30;
                    WorldMapSystem.puff(g, px, c.y + bob - size * 0.2 - rise, size * 0.8, h >> 2,
                        CREST_SHADOW, CREST_BODY, CREST_CROWN, 0.32 + 0.36 * (0.5 + 0.5 * Math.sin(pPhase + 1)));
                }

                WorldMapSystem.puff(g, c.x, c.y + bob, size, h, SHADOW, BODY, CROWN, breath);
            }
        }
    }

}
