import Phaser from 'phaser';
import { BUILDING_DEFINITIONS, OBSTACLE_DEFINITIONS, TROOP_DEFINITIONS, WORLD_COORD_LIMIT, type BuildingType } from '../config/GameDefinitions';
import type { SerializedWorld } from '../data/Models';
import {
    Backend,
    type KnownMapPlot,
    type WorldMapPlot,
    type WorldMapWindow,
    type WorldPostcard
} from '../backend/GameBackend';
import { BOT_WORLD_GENERATION_VERSION, generateBotWorldFromSeed } from '../backend/BotWorlds';
import { drawBuildingVisual } from '../renderers/BuildingVisualDispatcher';
import { IsoUtils } from '../utils/IsoUtils';
import { villageFlagFor, drawFlagBearer, drawVillageFlag, type FlagDesign } from '../renderers/VillageFlagRenderer';
import { gameManager, type PlotPanelAction } from '../GameManager';
import { soundSystem } from './SoundSystem';
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
import type { LakeTerrain } from '../renderers/WildernessTerrain';
import { WorldHydrologyRenderer } from '../renderers/WorldHydrologyRenderer';
import {
    normalizeWorldNatureSeedVersion,
    wildernessPlotPresentationSeed
} from '../renderers/WorldNatureSeed';
import { ObstacleRenderer } from '../renderers/ObstacleRenderer';
import { applyTextureSampling, registerPixelSurface, TextureSampling } from '../renderers/TextureRenderPolicy';
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
    type ScreenRect
} from './WorldPostcardResidency';

/**
 * THE GLOBAL MAP — every village in the game tiles onto one shared,
 * persistent grid. Your village lives at its permanent plot; this system
 * renders the neighbourhood around it so other players' bases (and the
 * deterministic bot clans between them) are physically THERE, one lawn over.
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
const REFRESH_MS = 25_000;
const SNAPSHOT_SCALE = PLAYER_POSTCARD_SCALE; // player villages are never downsampled

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
    /** Scene-grid position of the neighbour's town hall (their hearth). */
    hearth: { gx: number; gy: number } | null;
    /** Deterministic water/forest life anchors emitted by nature rendering. */
    natureLife: WildernessLifeAnchor[];
    /** Plot-local lake/brook geometry kept after the art bakes into the RT,
     * so weather can ask what a falling drop actually lands on. */
    natureWaters?: { lakes: LakeTerrain[]; streams: WildernessStream[] } | null;
    /** Retained authoritative data can rematerialize an evicted GPU texture
     * without another request or any loss of detail. */
    sourceWorld: PostcardWorld | null;
    sourceRevision: number | string | null;
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

interface MapHost extends Phaser.Scene {
    mode: string;
    mapSize: number;
    userId: string;
    buildings: Array<{ type: string; level?: number; health: number }>;
    attackBotPlot(seed: number, username: string, plotX?: number, plotY?: number): void;
    attackPlayerPlotByRoad(ownerId: string, username: string, plotX: number, plotY: number): void;
    villageLife?: { applyBattleScars(destructionPct: number): void };
    villageBubbles?: {
        raise(spec: { key: string; text: string; kind?: 'info' | 'danger'; buildingType?: string; anchor?: { x: number; y: number }; ttlMs?: number; action?: { label: string; run: () => void }; closable?: boolean; icon?: string; animate?: boolean; progress?: () => number }): void;
        clear(key: string): void;
    };
    dayNight?: {
        nightFactor(): number;
        addTransientLight(opts: { gx: number; gy: number; radius?: number; tint?: number; until: number }): number;
        removeTransientLight(id: number): void;
        moveTransientLight?(id: number, gx: number, gy: number): void;
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
    private wildernessTopology: WildernessTopology | null = null;
    /** Cache key for the painted links layer: topology PLUS every palette
     *  input (the owner id arrives from auth after the first paint). */
    private wildernessLinkSignature: string | null = null;
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
    private nextFogEdgeAt = 0;
    private nextRefreshAt = 0;
    private refreshing = false;
    private refreshInFlight: Promise<void> | null = null;
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
    private nextHomePollAt = 0;
    private homePolling = false;
    private homePollInFlight: Promise<void> | null = null;
    private homeAttackId: string | null = null;
    private dismissedSiegeId: string | null = null;
    private myShieldUntil = 0;
    /**
     * Battle-in-place: when set, the LOCAL grid hosts this plot's village
     * (the battlefield) and the neighbourhood renders around IT — including
     * the player's own home as a postcard. The world never cuts away.
     */
    private focusPlot: { x: number; y: number } | null = null;
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
        /** The village's own heraldry, carried huge by the bearer. */
        flag: FlagDesign;
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
        const home = this.scene.mode === 'HOME';
        // Battles fought IN PLACE keep the whole world on screen; every other
        // non-HOME mode (replays, cloud-transition raids) clears the map.
        if (!home && !this.focusPlot) {
            if (this.views.size > 0 || this.wilderness) this.teardown();
            return;
        }
        if (home && !this.focusPlot) {
            this.ensureFog(this.computeViewRadius());
            if (time >= this.nextRefreshAt && !this.refreshing) {
                this.nextRefreshAt = time + REFRESH_MS;
                void this.refresh();
            }
            if (time >= this.nextHomePollAt && !this.homePolling) {
                this.nextHomePollAt = time + 8000;
                void this.pollHome();
            }
        }
        this.drawFogEdge(time);
        this.updateCaravan(time);
        this.reconcileVillageTextureResidency(time);
        this.updatePostcardLife(time);
        this.updateTravellers(time);
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

    prepareFocus(target: { x: number; y: number }) {
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
            let window: Awaited<ReturnType<typeof Backend.fetchMap>> = null;
            try {
                window = await Backend.fetchMap(target.x, target.y, focusRadius);
            } catch (error) {
                // The live target world is already loaded by the attack
                // start. A failed neighbour postcard request can safely fall
                // back to deterministic wilderness without stalling the road.
                console.warn('focus map request failed; using wilderness ring:', error);
            }
            if (!this.focusIsLive(pending)) return;
            if (window) this.adoptPresentationSeedVersion(window.seedVersion, window.serverNow);

            // Build the expected square explicitly. A short/failed response is
            // filled with deterministic wilds, so the swap can never expose a
            // partially painted ring.
            const received = new Map((window?.plots ?? []).map(plot => [`${plot.x},${plot.y}`, plot]));
            const plots = this.fallbackFocusPlots(target, focusRadius).map(fallback => received.get(`${fallback.x},${fallback.y}`) ?? fallback);
            const expectedViews = plots.length - 1; // target itself stays live
            for (const plot of plots) {
                const dx = plot.x - target.x;
                const dy = plot.y - target.y;
                if (dx === 0 && dy === 0) continue; // the battlefield itself
                if (!this.focusIsLive(pending)) return;

                // One postcard per frame: eight synchronous RT paints in a
                // single tick stalls the click frame visibly.
                await new Promise(resolve => setTimeout(resolve, 34));
                if (!this.focusIsLive(pending)) return;
                const view = this.createView(`${plot.x},${plot.y}`, plot, dx, dy);
                try {
                    let world: PostcardWorld | null = null;
                    let revision: number | string = 0;
                    if (plot.kind === 'bot') {
                        world = generateBotWorldFromSeed(plot.seed ?? 1);
                        revision = `bot_v${BOT_WORLD_GENERATION_VERSION}_${plot.seed}`;
                    } else if (plot.kind === 'player' && plot.ownerId) {
                        const enriched = plot as MapPlotWithSnapshot;
                        // An unconditioned focus request carries all snapshots.
                        // Do not fall back to one request per player.
                        world = enriched.world ?? null;
                        revision = `player_${plot.ownerId}_${enriched.revision ?? world?.revision ?? 0}`;
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
                            this.renderSnapshot(view, world, dx, dy);
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
        for (const view of this.views.values()) this.destroyView(view);
        this.views = pending.views;
        for (const view of this.views.values()) view.rt?.setVisible(true);
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
            if (trav.lightId !== null) this.scene.dayNight?.moveTransientLight?.(trav.lightId, trav.x + 0.7, trav.y);
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
        // Focused battles get at least one visible world ring even when the
        // player's home sight is zero. Rebuild the fog in the swap frame so
        // the prepared neighboring villages are not immediately covered by
        // the old one-plot cloud mask.
        this.ensureFog(this.computeViewRadius());
        this.rebuildWildernessLinks(pending.target);
        // Home again: refresh immediately — with revisions recorded the pass
        // only recreates the nameplates; every postcard is reused as-is.
        if (homeAgain) this.nextRefreshAt = 0;
        return { dx: shiftPlotsX, dy: shiftPlotsY };
    }

    /** Back home: drop focus and let the normal HOME refresh rebuild the map. */
    endFocus() {
        this.dropPendingFocus();
        if (!this.focusPlot) return;
        this.focusPlot = null;
        this.teardown();
        this.nextRefreshAt = 0;
        this.nextHomePollAt = 0;
    }

    private dropPendingFocus() {
        const pending = this.pendingFocus;
        if (!pending) return;
        this.pendingFocus = null;
        for (const view of pending.views.values()) this.destroyView(view);
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
            speed: 0.0075 * Math.max(1, totalLen / 55),
            clothDir: 0,
            clothClimb: 0,
            flag: villageFlagFor(this.scene.userId || 'village')
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
            speed: 0.0075 * Math.max(1, totalLen / 55),
            clothDir: 0,
            clothClimb: 0,
            flag: villageFlagFor(this.scene.userId || 'village')
        };
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
        // The border roads between plots shed water like the lawn does.
        if (localX >= PLOT_TILES || localY >= PLOT_TILES) return 'grass';
        const plotX = anchor.x + plotDx;
        const plotY = anchor.y + plotDy;

        const worldX = plotX * PLOT_PITCH + localX;
        const worldY = plotY * PLOT_PITCH + localY;
        for (const feature of hydrologyFeaturesForPlot(plotX, plotY, this.presentationSeedVersion)) {
            if (featureContainsWorldPoint(feature, worldX, worldY)) return 'water';
            for (const reach of feature.network.reaches) {
                if (reach.kind === 'lake-passage' || reach.width <= 0) continue;
                const d = WorldMapSystem.distanceToPolyline(reach.points, worldX, worldY);
                if (d <= reach.width * 0.5) return 'water';
                if (d <= reach.width * 0.5 + 1.1) return 'bank';
            }
            if (featureContainsWorldPoint(feature, worldX, worldY, 'bank')) return 'bank';
        }

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
        if (c.lightId !== null) this.scene.dayNight?.removeTransientLight(c.lightId);
        if (!c.arriving && !silent) c.onCancel?.();
    }

    private updateCaravan(time: number) {
        const c = this.caravan;
        if (!c) return;
        // Marching column + camp are per-frame vector figures: smooth until
        // their sprite bake lands (docs/AGENTS_SPRITE_PIPELINE.md step 5).
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
        return dz < 0 ? 420.5 + dz : dz === 0 ? 785 : 26_000.5 + dz;
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
            flag: FlagDesign;
        },
        time: number
    ) {
        const g = c.gfx;
        g.clear();
        g.setDepth(this.roadDepthAt(c.x, c.y));

        // One troop on foot: cloaked in its type colour, spear shouldered,
        // heavier types drawn bigger — the column LOOKS like your army.
        const soldier = (x: number, y: number, type: string, wobble: number) => {
            const def = TROOP_DEFINITIONS[type as keyof typeof TROOP_DEFINITIONS];
            const s = (def && def.space >= 5 ? 1.45 : def && def.space >= 3 ? 1.18 : 1) * 1.32;
            g.fillStyle(0x000000, 0.15);
            g.fillEllipse(x, y + 2.6 * s, 7.4 * s, 2.9 * s);
            // Dark edge first so the cloak pops off any grass tone.
            g.fillStyle(0x1c1a16, 0.85);
            g.fillTriangle(x - 3.8 * s, y + 2.4 * s, x + 3.8 * s, y + 2.4 * s, x, y - (8.2 + wobble) * s);
            g.fillStyle(def?.color ?? 0xb8bfca, 1);
            g.fillTriangle(x - 3.1 * s, y + 2 * s, x + 3.1 * s, y + 2 * s, x, y - (7.5 + wobble) * s);
            g.fillStyle(0xd9b38c, 1);
            g.fillCircle(x, y - (8.6 + wobble) * s, 1.9 * s);
            // Spear on the shoulder, steel tip catching the light.
            g.lineStyle(1.4, 0x6e5136, 1);
            g.lineBetween(x + 2.2 * s, y + 1.8 * s, x + 4.4 * s, y - (12 + wobble) * s);
            g.fillStyle(0xd8d8e0, 1);
            g.fillTriangle(
                x + 4.4 * s - 1.2, y - (12 + wobble) * s,
                x + 4.4 * s + 1.2, y - (12 + wobble) * s,
                x + 4.4 * s, y - (14.4 + wobble) * s
            );
        };

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
                if (homebound && along >= c.totalLen - 0.05) return;
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
                const wobble = Math.abs(Math.sin(time * 0.009 + e * 1.31)) * 1.3;
                soldier(pos.x, pos.y, type, wobble);
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
            // The strike kicks up a ring of dust.
            if (thrust > 0 && settle < 0.6) {
                const dust = Math.min(1, thrust * 0.4 + settle);
                g.lineStyle(2, 0xbfae8e, 0.5 * (1 - dust));
                g.strokeEllipse(pos.x + facing * 1.3, groundY, 8 + dust * 22, (8 + dust * 22) * 0.42);
            }
            // The bearer: gripping through the hoist, stepping back after.
            const bx = pos.x - facing * (2 + 6 * settle);
            const bob = thrust > 0 && thrust < 1 ? 1.4 : 0;
            g.fillStyle(0x000000, 0.16);
            g.fillEllipse(bx, groundY + 1, 9, 3.4);
            g.fillStyle(c.flag.field, 1);
            g.fillTriangle(bx - 3.6, groundY, bx + 3.6, groundY, bx, groundY - 10.5 + bob);
            g.fillStyle(0xd9b38c, 1);
            g.fillCircle(bx, groundY - 11.6 + bob, 2.1);
            if (settle < 0.4) {
                // Both fists still on the pole, high from the hoist.
                g.fillStyle(0xd9b38c, 1);
                g.fillCircle(pos.x + facing * 0.4, groundY - 12 - lift * 0.6, 1.1);
                g.fillCircle(pos.x + facing * 0.1, groundY - 8.5 - lift * 0.6, 1.1);
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
                    trav.lightId = this.scene.dayNight?.addTransientLight({
                        gx: trav.x + 0.7,
                        gy: trav.y,
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

    private drawTraveller(trav: { kind: string; x: number; y: number; tx: number; ty: number; gfx: Phaser.GameObjects.Graphics; seed: number; state: string }, time: number) {
        // Road walkers are per-frame vector figures: smooth until their
        // sprite bake lands (docs/AGENTS_SPRITE_PIPELINE.md step 5).
        const pos = IsoUtils.cartToIso(trav.x, trav.y);
        const wv = this.scene.cameras.main.worldView;
        const g = trav.gfx;
        g.clear();
        if (pos.x < wv.x - 60 || pos.x > wv.right + 60 || pos.y < wv.y - 60 || pos.y > wv.bottom + 60) return;
        g.setDepth(this.roadDepthAt(trav.x, trav.y));

        const facing = trav.tx >= trav.x ? 1 : -1;
        if (trav.state === 'camp') {
            // Bedroll + bonfire: crossed logs and a flickering two-tongue flame.
            g.fillStyle(0x000000, 0.16);
            g.fillEllipse(pos.x, pos.y + 3, 22, 8);
            g.lineStyle(2, 0x5c4326, 1);
            g.lineBetween(pos.x + 6, pos.y + 2, pos.x + 13, pos.y - 1);
            g.lineBetween(pos.x + 6, pos.y - 1, pos.x + 13, pos.y + 2);
            const lick = Math.sin(time * 0.02 + trav.seed) * 1.6;
            g.fillStyle(0xff7a2a, 0.95);
            g.fillTriangle(pos.x + 7, pos.y, pos.x + 12, pos.y, pos.x + 9.5 + lick * 0.4, pos.y - 7 - Math.abs(lick));
            g.fillStyle(0xffc36a, 0.95);
            g.fillTriangle(pos.x + 8, pos.y, pos.x + 11, pos.y, pos.x + 9.5 + lick * 0.3, pos.y - 4.4 - Math.abs(lick) * 0.6);
            // The traveller sits by it, hood up.
            g.fillStyle(0x4a4258, 1);
            g.fillEllipse(pos.x - 2, pos.y - 3, 7.5, 8);
            g.fillStyle(0xd9b38c, 1);
            g.fillCircle(pos.x - 2, pos.y - 8, 2.4);
            g.fillStyle(0x3c3648, 1);
            g.fillEllipse(pos.x - 2, pos.y - 9.4, 5.4, 3);
            return;
        }

        const bob = Math.abs(Math.sin(time * 0.008 + trav.seed)) * 1.4;

        // A little walking figure, reused by several kinds.
        const walker = (x: number, y: number, cloak: number, skin: number, hood: number | null, wobble: number) => {
            g.fillStyle(0x000000, 0.15);
            g.fillEllipse(x, y + 3, 9, 3.6);
            g.fillStyle(cloak, 1);
            g.fillTriangle(x - 4, y + 2, x + 4, y + 2, x, y - 9 - wobble);
            g.fillStyle(skin, 1);
            g.fillCircle(x, y - 10 - wobble, 2.3);
            if (hood !== null) {
                g.fillStyle(hood, 1);
                g.fillEllipse(x, y - 11.4 - wobble, 5, 2.8);
            }
        };
        switch (trav.kind) {
            case 'courier': {
                // A runner at full stride: satchel bouncing, dust at his heels.
                const stride = Math.abs(Math.sin(time * 0.016 + trav.seed)) * 2.6;
                walker(pos.x, pos.y, 0x2f5f8a, 0xd9b38c, null, stride);
                g.fillStyle(0x8a6a42, 1);
                g.fillEllipse(pos.x - 3.4 * facing, pos.y - 6 - stride * 0.4, 3.6, 2.8);
                g.lineStyle(1, 0x6a5432, 1);
                g.lineBetween(pos.x - 3.4 * facing, pos.y - 8 - stride * 0.4, pos.x + 1 * facing, pos.y - 11 - stride);
                for (let d = 0; d < 2; d++) {
                    const cycle = ((time * 0.003 + d * 0.5 + trav.seed) % 1);
                    g.fillStyle(0xcbb894, 0.28 * (1 - cycle));
                    g.fillCircle(pos.x - (7 + cycle * 7) * facing, pos.y + 2, 1.4 + cycle * 1.8);
                }
                break;
            }
            case 'monk': {
                // A brown-robed brother, hands folded, unhurried.
                walker(pos.x, pos.y, 0x6a4f30, 0xd9b38c, 0x59422a, bob * 0.6);
                g.fillStyle(0x8a6a42, 1);
                g.fillEllipse(pos.x, pos.y - 4 - bob * 0.6, 5.6, 1.6); // rope belt
                g.fillStyle(0xd9b38c, 1);
                g.fillEllipse(pos.x + 2.6 * facing, pos.y - 5.4 - bob * 0.6, 2.2, 1.6); // folded hands
                break;
            }
            case 'hunter': {
                // Green hood, bow across the back — a lean dog trots ahead.
                walker(pos.x, pos.y, 0x3f5f38, 0xd9b38c, 0x33502e, bob);
                g.lineStyle(1.3, 0x8a6a42, 1);
                g.beginPath();
                g.arc(pos.x - 2 * facing, pos.y - 6 - bob, 5.4, -1.2, 1.2);
                g.strokePath();
                g.lineStyle(0.8, 0xd8d2c4, 0.9);
                g.lineBetween(pos.x - 2 * facing, pos.y - 11.2 - bob, pos.x - 2 * facing, pos.y - 0.8 - bob);
                const dogX = pos.x + 11 * facing + Math.sin(time * 0.006 + trav.seed) * 2;
                const trot = Math.abs(Math.sin(time * 0.014 + trav.seed)) * 1;
                g.fillStyle(0x000000, 0.13);
                g.fillEllipse(dogX, pos.y + 3, 7, 2.6);
                g.fillStyle(0x5a4a36, 1);
                g.fillEllipse(dogX, pos.y - 1 - trot, 7, 3.4);
                g.fillCircle(dogX + 3.6 * facing, pos.y - 3 - trot, 1.9);
                g.lineStyle(1.1, 0x5a4a36, 1);
                g.lineBetween(dogX - 3.4 * facing, pos.y - 2 - trot, dogX - 5.4 * facing, pos.y - 4.6 - trot);
                break;
            }
            case 'woodcutter': {
                // Broad fellow under a shoulder-load of logs.
                walker(pos.x, pos.y, 0x7a5638, 0xd9b38c, null, bob * 0.7);
                g.fillStyle(0x8a6440, 1);
                g.fillRect(pos.x - 7, pos.y - 12.5 - bob * 0.7, 14, 2.2);
                g.fillStyle(0x6e4e30, 1);
                g.fillRect(pos.x - 7, pos.y - 14.7 - bob * 0.7, 14, 2.2);
                g.fillStyle(0xc9b593, 1);
                g.fillEllipse(pos.x - 7, pos.y - 13.6 - bob * 0.7, 1.6, 2.8);
                g.fillEllipse(pos.x + 7, pos.y - 13.6 - bob * 0.7, 1.6, 2.8);
                break;
            }
            case 'marketgoer': {
                // Off to the neighbours' stalls: bright dress, full basket.
                walker(pos.x, pos.y, 0x8a4a62, 0xd9b38c, 0xc9a24a, bob);
                g.fillStyle(0x8a6a42, 1);
                g.fillEllipse(pos.x + 4.4 * facing, pos.y - 4.6 - bob, 4.2, 3);
                g.lineStyle(1, 0x6a5432, 1);
                g.beginPath();
                g.arc(pos.x + 4.4 * facing, pos.y - 6.2 - bob, 2, Math.PI, 0);
                g.strokePath();
                g.fillStyle(0xd85a3c, 1);
                g.fillCircle(pos.x + 3.4 * facing, pos.y - 6 - bob, 0.9);
                g.fillStyle(0x6fae4a, 1);
                g.fillCircle(pos.x + 5.4 * facing, pos.y - 6.2 - bob, 0.9);
                break;
            }
            case 'shepherd': {
                walker(pos.x, pos.y, 0x6a5a3c, 0xd9b38c, 0x8a744e, bob);
                g.lineStyle(1.4, 0x8a6a42, 1);
                g.lineBetween(pos.x + 4 * facing, pos.y + 3, pos.x + 5.5 * facing, pos.y - 9 - bob);
                g.lineStyle(1.4, 0x8a6a42, 1);
                const hookX = pos.x + 5.5 * facing;
                g.lineBetween(hookX, pos.y - 9 - bob, hookX + 2 * facing, pos.y - 10.5 - bob);
                // Two sheep amble behind, out of step with each other.
                for (let s = 0; s < 2; s++) {
                    const sx = pos.x - (9 + s * 8) * facing + Math.sin(time * 0.004 + s * 2 + trav.seed) * 1.6;
                    const sy = pos.y + 1 + Math.cos(time * 0.005 + s * 3) * 0.8;
                    const hop = Math.abs(Math.sin(time * 0.009 + s * 1.7 + trav.seed)) * 1;
                    g.fillStyle(0x000000, 0.14);
                    g.fillEllipse(sx, sy + 2.4, 7, 2.6);
                    g.fillStyle(0xe8e2d4, 1);
                    g.fillEllipse(sx, sy - 2 - hop, 7.5, 5);
                    g.fillStyle(0x3c3226, 1);
                    g.fillEllipse(sx + 3.6 * facing, sy - 3 - hop, 2.6, 2.2);
                    g.lineStyle(1, 0x3c3226, 1);
                    g.lineBetween(sx - 2, sy, sx - 2, sy + 2.2);
                    g.lineBetween(sx + 2, sy, sx + 2, sy + 2.2);
                }
                break;
            }
            case 'patrol': {
                // A guard walking the beat: mail, kite shield, tall spear.
                walker(pos.x, pos.y, 0x5a6470, 0xd9b38c, null, bob);
                g.fillStyle(0x8a9aae, 1);
                g.fillEllipse(pos.x, pos.y - 11.6 - bob, 4.6, 3.4);
                g.fillStyle(0x2f5f8a, 1);
                g.fillTriangle(pos.x - 4.5 * facing, pos.y - 7 - bob, pos.x - 1.5 * facing, pos.y - 7 - bob, pos.x - 3 * facing, pos.y - 1 - bob);
                g.lineStyle(1.3, 0x8a6a42, 1);
                g.lineBetween(pos.x + 3.5 * facing, pos.y + 2, pos.x + 3.5 * facing, pos.y - 14 - bob);
                g.fillStyle(0xc8d4e4, 1);
                g.fillTriangle(pos.x + 3.5 * facing - 1.4, pos.y - 14 - bob, pos.x + 3.5 * facing + 1.4, pos.y - 14 - bob, pos.x + 3.5 * facing, pos.y - 17.5 - bob);
                break;
            }
            default: {
                // The hooded wanderer, staff in hand.
                walker(pos.x, pos.y, 0x4a4258, 0xd9b38c, 0x3c3648, bob);
                g.lineStyle(1.4, 0x8a6a42, 1);
                g.lineBetween(pos.x + 4 * facing, pos.y + 3, pos.x + 5.5 * facing, pos.y - 8 - bob);
            }
        }
    }


    // ================= neighbourhood refresh =================

    /** How far this player can see, in plots: 0 without a watchtower, then 1 or 2. */
    private viewRadiusValue = 1;

    private computeViewRadius(): number {
        // Only the HOME scene holds MY buildings; battles keep the last value.
        // ONE source of truth: the same shared sight function the server uses.
        if (this.scene.mode === 'HOME' && !this.focusPlot) {
            const standing = (this.scene.buildings ?? []).filter(b => b.health > 0);
            const next = watchtowerSightOf(standing as never);
            if (next !== this.viewRadiusValue) {
                this.viewRadiusValue = next;
                // Pulling the fog back without postcards underneath produces a
                // blank meadow for the remainder of the normal 25 s cadence.
                this.nextRefreshAt = 0;
            }
        }
        return this.focusPlot ? Math.max(1, this.viewRadiusValue) : this.viewRadiusValue;
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

    /** Commit a local relocation and release coalesced GETs so a fresh ring can start immediately. */
    private fenceMapRequests(serverNow?: number) {
        this.mapAuthorityEpoch += 1;
        this.latestHomeResponseSequence = this.mapRequestSequence;
        if (Number.isFinite(serverNow)) this.latestHomeServerNow = Math.max(this.latestHomeServerNow, Number(serverNow));
        this.refreshInFlight = null;
        this.homePollInFlight = null;
        this.refreshing = false;
        this.homePolling = false;
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
    private ensureInitialWildernessFallback() {
        if (!this.sceneLive() || this.views.size > 0) return;
        const radius = this.computeViewRadius();
        this.ensureWilderness();
        this.ensureFog(radius);
        if (radius <= 0) return;

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
        this.nextHomePollAt = now + 8000;
        // Boot must have a deadline. Both requests are transport-bounded and
        // independent, so run them together and degrade to wilderness if one
        // fails instead of holding the village reveal open indefinitely.
        const results = await Promise.allSettled([this.refresh(), this.pollHome()]);
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

    private refresh(): Promise<void> {
        if (this.refreshInFlight) return this.refreshInFlight;
        if (!this.sceneLive()) return Promise.resolve();
        this.refreshing = true;
        const ticket = this.beginMapRequest();
        const run = this.performRefresh(ticket);
        const task = run.finally(() => {
            if (this.refreshInFlight === task) {
                this.refreshInFlight = null;
                this.refreshing = false;
            }
        });
        this.refreshInFlight = task;
        return task;
    }

    private async performRefresh(ticket: MapRequestTicket): Promise<void> {
        const radius = this.computeViewRadius();
        const knownPlots: Record<string, KnownMapPlot> = {};
        for (const view of this.views.values()) {
            if (view.plot.kind === 'player' && view.plot.ownerId && view.knownRevision !== null) {
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
            if (!window) this.ensureInitialWildernessFallback();
            return;
        }
        if (!this.acceptMapHome(window, ticket)) return;
        DayNightSystem.serverOffsetMs = window.serverNow - Date.now();
        this.clearFallbackViews();
        this.ensureWilderness();

        // Drop views that left the window (relocation, radius change).
        const present = new Set(window.plots.map(p => `${p.x},${p.y}`));
        for (const [key, view] of [...this.views]) {
            if (!present.has(key)) {
                this.destroyView(view);
                this.views.delete(key);
            }
        }

        for (const plot of window.plots) {
            const dx = plot.x - this.myPlot.x;
            const dy = plot.y - this.myPlot.y;
            if (dx === 0 && dy === 0) continue; // that's us, live on the local grid
            try {
                await this.ensureView(`${plot.x},${plot.y}`, plot, dx, dy);
            } catch (error) {
                // A single corrupt/temporarily unavailable neighbour must
                // not blank the rest of the ring or reject the poll task.
                console.warn(`map postcard failed for ${plot.x},${plot.y}:`, error);
            }
            if (!this.sceneLive()) return;
        }
        this.rebuildWildernessLinks(this.myPlot);
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

    private async ensureView(key: string, plot: WorldMapPlot, dx: number, dy: number) {
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
        if (plot.kind === 'bot') {
            revision = `bot_v${BOT_WORLD_GENERATION_VERSION}_${plot.seed}`;
            if (view.sourceRevision !== revision || !view.sourceWorld) {
                world = generateBotWorldFromSeed(plot.seed ?? 1);
            }
        } else if (plot.ownerId) {
            const enriched = plot as MapPlotWithSnapshot;
            revision = `player_${plot.ownerId}_${enriched.revision ?? enriched.world?.revision ?? 0}`;
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
            if (plot.kind === 'player') {
                view.knownRevision = (plot as MapPlotWithSnapshot).revision ?? world.revision ?? null;
            }
        }

        const interested = this.villageTextureInterested(view, this.scene.time.now);
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
        const base = WildernessRenderer.renderRevision(plotX, plotY, this.presentationSeedVersion);
        const featureIds = classifyHydrologyPlot(plotX, plotY, this.presentationSeedVersion)
            .features.map(feature => feature.id).join('|');
        return featureIds
            ? `${base}_hydroart_v${WorldHydrologyRenderer.RENDER_VERSION}_${hashString(featureIds).toString(16)}`
            : base;
    }

    private fallbackNatureRevision(plot: WorldMapPlot, viewKey: string): string {
        return `fallback_${plot.ownerId ?? plot.seed ?? viewKey}_nature_s${this.presentationSeedVersion}`;
    }

    private renderNaturePostcard(view: NeighborView, dx: number, dy: number) {
        this.neighborLifeSim?.removeVillage(view.key);
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
        const SNAP = hydrology.length > 0
            ? SNAPSHOT_SCALE
            : ringDist >= 3 ? 0.25 : ringDist >= 2 ? 0.35 : SNAPSHOT_SCALE;
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
        for (let ty = 0; ty < PLOT_TILES; ty++) {
            for (let tx = 0; tx < PLOT_TILES; tx++) {
                const p = IsoUtils.cartToIso(offX + tx, offY + ty);
                const worldTileX = view.plot.x * PLOT_PITCH + tx;
                const worldTileY = view.plot.y * PLOT_PITCH + ty;
                drawGrassTile(g, p.x, p.y, 64, 32, worldTileX, worldTileY, palette, false);
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
        g.setScale(SNAP);
        rt.draw(g, -bx * SNAP, -by * SNAP);
        g.destroy();
        // World-layer pixel treatment: the postcard (lawn, lakes, roads,
        // scenery) quantizes once into 1.35 world-px cells — same math as the
        // baked sprites, world-anchored because the postcard is world-glued.
        SpriteBank.quantizeRenderTexture(this.scene, rt, 1.35 * SNAP);
        const dz = dx + dy;
        rt.setDepth(dz < 0 ? 420 + dz : dz === 0 ? 780 : 26_000 + dz);
        view.rt = rt;
        view.contentKind = 'nature';
    }

    /** One full-resolution cached postcard of a neighbour's exact base. */
    private renderSnapshot(view: NeighborView, world: PostcardWorld, dx: number, dy: number) {
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
        this.scene.dayNight?.setPostcardLights?.(view.key,
            Array.isArray(world.buildings) ? world.buildings : [], offX, offY);


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
            layer.setScale(SNAP);
            rt.draw(layer, -bx * SNAP, -by * SNAP);
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
            ? { gx: dx * PLOT_PITCH + hall.gridX + 1.5, gy: dy * PLOT_PITCH + hall.gridY + 1.5 }
            : null;
        const fallbackLifeIdentity = view.plot.kind === 'bot'
            ? `bot:${view.plot.seed ?? view.key}`
            : world.ownerId || view.plot.ownerId || view.key;
        this.neighborLife.setVillage(view.key,
            Array.isArray(world.buildings) ? world.buildings : [], offX, offY, fallbackLifeIdentity,
            rt.depth + 1, (world as WorldPostcard).life);
        view.natureLife = [];
    }

    /**
     * Static painter's-order render of a whole postcard world at a grid
     * offset. time=0 for this cached layer; resident motion stays separate.
     * Mirrors MainScene.drawBuildingVisuals' dispatch exactly, one building at
     * a time inside a try/catch — a bad record falls back to a generic block
     * rather than killing the whole postcard.
     */
    private drawWorldStatic(ground: Phaser.GameObjects.Graphics, world: PostcardWorld, offX: number, offY: number): Phaser.GameObjects.Graphics[] {
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

        const raised: Array<{ depth: number; g: Phaser.GameObjects.Graphics }> = [];
        for (const b of buildings) {
            if (!BUILDING_DEFINITIONS[b.type as BuildingType]) continue;
            const layer = this.scene.make.graphics({ x: 0, y: 0 }, false);
            drawBuilding(layer, b, true, false);
            raised.push({ depth: depthForBuilding(offX + b.gridX, offY + b.gridY, b.type as BuildingType), g: layer });
        }
        for (const obstacle of world.obstacles ?? []) {
            const info = OBSTACLE_DEFINITIONS[obstacle.type];
            if (!info) continue;
            const layer = this.scene.make.graphics({ x: 0, y: 0 }, false);
            ObstacleRenderer.drawObstacle(layer, {
                ...obstacle,
                gridX: offX + obstacle.gridX,
                gridY: offY + obstacle.gridY,
                animOffset: hashString(obstacle.id) % 10_000
            }, 0);
            raised.push({ depth: depthForObstacle(offX + obstacle.gridX, offY + obstacle.gridY, info.width, info.height), g: layer });
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
                const arcPoint = (step: number, radius: number) => {
                    const angle = step / ARC_STEPS * Math.PI * 0.5;
                    return {
                        x: pivot.x + pivotGeometry.sx * Math.cos(angle) * radius,
                        y: pivot.y + pivotGeometry.sy * Math.sin(angle) * radius
                    };
                };
                const outerArc: Array<{ x: number; y: number }> = [];
                for (let step = 0; step <= ARC_STEPS; step++) outerArc.push(arcPoint(step, PLOT_GAP));
                g.fillStyle(ROAD_EARTH, 1);
                g.fillPoints([toIsoVector(pivot), ...outerArc.map(toIsoVector)], true);
                // Crown: a quarter-annulus joining the two straight crowns
                // ([lane+0.45, lane+GAP-0.45]) edge-to-edge.
                const crown: Array<{ x: number; y: number }> = [];
                for (let step = 0; step <= ARC_STEPS; step++) crown.push(arcPoint(step, PLOT_GAP - 0.45));
                for (let step = ARC_STEPS; step >= 0; step--) crown.push(arcPoint(step, 0.45));
                g.fillStyle(ROAD_CROWN, 1);
                g.fillPoints(crown.map(toIsoVector), true);
                // Ruts at the same offsets the straight lanes wear them.
                g.lineStyle(2, ROAD_RUT, 1);
                for (const radius of [0.55, PLOT_GAP - 0.55]) {
                    const rut: Phaser.Math.Vector2[] = [];
                    for (let step = 0; step <= ARC_STEPS; step++) rut.push(toIsoVector(arcPoint(step, radius)));
                    g.strokePoints(rut, false);
                }
                g.lineStyle(1.4, ROAD_SHOULDER, 1);
                g.strokePoints(outerArc.map(toIsoVector), false);
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
                g.lineStyle(1.4, ROAD_SHOULDER, 1);
                for (const face of faces) {
                    if (junction.arms[face.arm]) continue;
                    const a = toIsoVector(face.a);
                    const b = toIsoVector(face.b);
                    g.lineBetween(a.x, a.y, b.x, b.y);
                }
            }

            // Under every KNOWN-village lawn corner, a packed-earth bed the
            // size of the lawn's rounded cut: the lawn above (drawn with its
            // corner tile arc-cut, see drawGrassTile's cornerCut) reveals
            // clean road earth through the cut, and the bed buries the static
            // atlas's shoulder-line stubs that still run to the old sharp
            // corner. The cut's own arc stroke is the shoulder around the
            // bend — tangent to the straight shoulders where the bed ends.
            for (const quadrant of quadrants) {
                if (junction.cornerStates[quadrant] !== 'occupied') continue;
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
    private rebuildWildernessLinks(center = this.focusPlot ?? this.myPlot) {
        const topology = buildWildernessTopology(
            center,
            this.focusPlot ? Math.max(1, this.viewRadiusValue) : this.viewRadiusValue,
            [...this.views.values()].map(view => view.plot)
        );
        const linkSignature = `${topology.signature}|owner=${this.scene.userId || 'village'}|nature=${this.presentationSeedVersion}`;
        if (linkSignature === this.wildernessLinkSignature) return;
        this.wildernessLinkSignature = linkSignature;
        this.wildernessTopology = topology;

        const g = this.wildernessLinks ?? this.scene.add.graphics();
        this.wildernessLinks = g;
        g.clear();
        g.setDepth(-440); // above roads (-450), below every postcard/live lawn
        const palette = wildernessGrassPalette(this.presentationSeedVersion);
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

        // Plot postcards live in painter bands up to ~26_004; fog starts at
        // 28_500. Render each absolute feature once between them. This removes
        // every internal RT/gap boundary by construction while fog still clips
        // the horizon. The server permanently reserves every intersected plot,
        // so the layer cannot cover a village or an active road.
        const featureLayer = this.worldHydrologyLayer ?? this.scene.add.graphics();
        this.worldHydrologyLayer = featureLayer;
        featureLayer.clear();
        featureLayer.setDepth(27_500);
        if (hydrology.length > 0) {
            const localMin = -topology.radius * PLOT_PITCH;
            const localMax = topology.radius * PLOT_PITCH + PLOT_TILES;
            WorldHydrologyRenderer.drawFeatures(featureLayer, hydrology, {
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
        }
    }

    private ensureWilderness() {
        if (this.wilderness) return;
        const g = this.scene.add.graphics();
        g.setDepth(-450); // above the void backdrop (-500), below everything else
        const r = 2; // draw for the widest possible sight, cheap either way
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
        // Wheel ruts worn by the merchants' carts.
        g.lineStyle(2, RUT, 1);
        for (const [a, b] of bands) {
            for (const off of [0.55, PLOT_GAP - 0.55]) {
                segmented((t0, t1) => {
                    const v0 = P(a + off, t0);
                    const v1 = P(a + off, t1);
                    g.lineBetween(v0.x, v0.y, v1.x, v1.y);
                    const h0 = P(t0, a + off);
                    const h1 = P(t1, a + off);
                    g.lineBetween(h0.x, h0.y, h1.x, h1.y);
                });
                void b;
            }
        }
        // Road shoulders where the lane meets the grass.
        g.lineStyle(1.4, SHOULDER, 1);
        for (const [a, b] of bands) {
            for (const edge of [a, b]) {
                segmented((t0, t1) => {
                    const v0 = P(edge, t0);
                    const v1 = P(edge, t1);
                    g.lineBetween(v0.x, v0.y, v1.x, v1.y);
                    const h0 = P(t0, edge);
                    const h1 = P(t1, edge);
                    g.lineBetween(h0.x, h0.y, h1.x, h1.y);
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
        g.fillStyle(COBBLE, 1);
        for (const [a] of bands) {
            for (let t = min + 1; t < max - 1; t += 1.1 + rand() * 1.4) {
                const off = 0.35 + rand() * (PLOT_GAP - 0.7);
                if (inCrossing(t)) continue;
                const pv = P(a + off, t);
                g.fillEllipse(pv.x, pv.y, 3.2 + rand() * 2.4, 1.7 + rand() * 1.2);
                const ph = P(t, a + off);
                g.fillEllipse(ph.x, ph.y, 3.2 + rand() * 2.4, 1.7 + rand() * 1.2);
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
                            g.fillStyle(FLAG_EDGE, 1);
                            g.fillEllipse(fx, fy + 0.8, w, w * 0.5);
                            g.fillStyle(FLAG, 1);
                            g.fillEllipse(fx, fy, w - 1.6, (w - 1.6) * 0.5);
                        }
                    } else if (roll < 0.5) {
                        // Rocks shouldered off the lane.
                        g.fillStyle(ROCK_DARK, 1);
                        g.fillEllipse(c.x + 1, c.y + 1.4, 5.4, 2.8);
                        g.fillStyle(ROCK, 1);
                        g.fillEllipse(c.x, c.y, 5, 2.6);
                        g.fillEllipse(c.x + 4 + rand() * 3, c.y + rand() * 2 - 1, 2.6, 1.4);
                    } else if (roll < 0.68) {
                        // Grass reclaiming a worn stretch.
                        g.fillStyle(GRASS_BREAK, 1);
                        g.fillEllipse(c.x, c.y, 9 + rand() * 8, 4 + rand() * 3);
                    }
                }
            }
        }
        // Roadside posts pace the shoulders; a lantern-capped milestone marks
        // the crossings (drawn with height, so they sit ON the shoulder).
        const post = (gx: number, gy: number, tall: boolean) => {
            const c = P(gx, gy);
            g.fillStyle(0x2c2418, 0.35);
            g.fillEllipse(c.x, c.y + 1, 5, 2.2);
            const h = tall ? 15 : 9;
            g.fillStyle(0x5c4a30, 1);
            g.fillRect(c.x - 1.4, c.y - h, 2.8, h);
            g.fillStyle(0x6e5a3c, 1);
            g.fillRect(c.x - 1.4, c.y - h, 1.2, h);
            if (tall) {
                g.fillStyle(0x3c3222, 1);
                g.fillRect(c.x - 2.6, c.y - h - 2.4, 5.2, 2.8);
                g.fillStyle(0xffd76a, 1);
                g.fillRect(c.x - 1.5, c.y - h + 1.4, 3, 2.6);
            } else {
                g.fillStyle(0x4a3a26, 1);
                g.fillRect(c.x - 2.2, c.y - h, 4.4, 1.6);
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
        // Roads, gap grass and every roadside prop are vector. Built once,
        // so a one-time RT quantize (as the postcards do) is the follow-up.
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
        // Crossed blades over a dark pennon — drawn, never an emoji.
        marker.fillStyle(0x2b0f0f, 0.85);
        marker.fillRoundedRect(-16, -14, 32, 26, 5);
        marker.lineStyle(2, 0xd82f2f, 1);
        marker.strokeRoundedRect(-16, -14, 32, 26, 5);
        marker.lineStyle(2.4, 0xffb0a0, 1);
        marker.lineBetween(-8, -7, 8, 7);
        marker.lineBetween(8, -7, -8, 7);
        marker.lineStyle(2.2, 0xd8a24a, 1);
        marker.lineBetween(-9.5, 5, -6, 8.5);
        marker.lineBetween(9.5, 5, 6, 8.5);
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
        soundSystem.play('horn');
        const requests = gameManager as unknown as {
            requestWatchLiveAttack(id: string, username: string): void;
        };
        // The WATCHTOWER sounds the alarm — a danger bubble over its deck
        // (the town hall bell rings it for tower-less villages). Same pixel
        // speech-bubble system as every other village report.
        this.scene.villageBubbles?.raise({
            key: 'siege',
            kind: 'danger',
            buildingType: 'watchtower',
            text: 'RAIDERS AT THE GATES!',
            ttlMs: 0,
            closable: true,
            action: { label: 'WATCH THE DEFENCE', run: () => requests.requestWatchLiveAttack(attackId, 'Raiders') }
        });
    }

    private onSiegeEnded() {
        this.scene.villageBubbles?.clear('siege');
        this.dismissedSiegeId = null;
        gameManager.showToast('The attack on your village has ended.');
    }

    // ================= home defence heartbeat =================

    /**
     * The fast heartbeat: is MY village under siege right now? Rides a tiny
     * r=0 map query so the alarm sounds within seconds of the first torch.
     */
    private pollHome(): Promise<void> {
        if (this.homePollInFlight) return this.homePollInFlight;
        if (!this.sceneLive()) return Promise.resolve();
        this.homePolling = true;
        const ticket = this.beginMapRequest();
        const run = this.performHomePoll(ticket);
        const task = run.finally(() => {
            if (this.homePollInFlight === task) {
                this.homePollInFlight = null;
                this.homePolling = false;
            }
        });
        this.homePollInFlight = task;
        return task;
    }

    private async performHomePoll(ticket: MapRequestTicket): Promise<void> {
        const window = await Backend.fetchMap(null, null, 0);
        if (!window || !this.sceneLive() || !this.acceptMapHome(window, ticket)) return;
        DayNightSystem.serverOffsetMs = window.serverNow - Date.now();
        // An r=0 heartbeat can be the first request to recover after an
        // outage. Drop the coordinate-placeholder ring and pull the real one
        // on the next frame.
        if (this.fallbackViewsActive) {
            this.clearFallbackViews();
            this.nextRefreshAt = 0;
        }
        const meShield = Number((window.me as { shieldUntil?: number }).shieldUntil ?? 0);
        const serverNow = Date.now() + DayNightSystem.serverOffsetMs;
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
        } else if (plot.settleable !== false) {
            actions.push({
                label: 'Settle here', kind: 'settle', run: () => {
                    void Backend.relocate(plot.x, plot.y).then(res => {
                        if (res) {
                            const relocationServerNow = Number((res as typeof res & { serverNow?: number }).serverNow);
                            this.fenceMapRequests(relocationServerNow);
                            gameManager.showToast(`The village packed up and moved to (${res.me.x}, ${res.me.y})!`);
                            const reanchored = this.applyHomePlot(res.me);
                            if (!reanchored) this.teardown();
                            this.nextRefreshAt = 0;
                        } else {
                            gameManager.showToast('That plot cannot be settled right now.');
                        }
                    });
                }
            });
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
                const facing = Math.cos(swim) >= 0 ? 1 : -1;
                g.fillStyle(0x163e49, 0.5);
                g.fillEllipse(p.x, p.y, 8 * anchor.scale, 3.3 * anchor.scale);
                g.fillTriangle(
                    p.x - facing * 3.3 * anchor.scale, p.y,
                    p.x - facing * 6.4 * anchor.scale, p.y - 2.2 * anchor.scale,
                    p.x - facing * 6.4 * anchor.scale, p.y + 2.2 * anchor.scale
                );
                const ripple = (time * 0.00052 + anchor.phase / (Math.PI * 2)) % 1;
                g.lineStyle(1, 0xc6e5e3, 0.34 * (1 - ripple));
                g.strokeEllipse(p.x, p.y, 5 + ripple * 18 * anchor.scale, 2 + ripple * 7 * anchor.scale);
                continue;
            }

            if (anchor.kind === 'frog') {
                const beat = (time * 0.00038 + anchor.phase / (Math.PI * 2)) % 1;
                const p = IsoUtils.cartToIso(anchor.gx, anchor.gy);
                if (beat < 0.62) {
                    g.lineStyle(1, 0xb7dcda, 0.34 * (1 - beat / 0.62));
                    g.strokeEllipse(p.x, p.y, 5 + beat * 18, 2 + beat * 7);
                }
                const blink = Math.sin(time * 0.004 + anchor.phase) > -0.78;
                if (blink) {
                    g.fillStyle(0x496f3d, 0.92);
                    g.fillEllipse(p.x, p.y - 1, 6 * anchor.scale, 3.4 * anchor.scale);
                    g.fillStyle(0xb8c96c, 0.9);
                    g.fillCircle(p.x - 1.4 * anchor.scale, p.y - 2.2, 0.65 * anchor.scale);
                    g.fillCircle(p.x + 1.4 * anchor.scale, p.y - 2.2, 0.65 * anchor.scale);
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
                    g.fillStyle(0xdff06f, pulse * nightFactor * 0.18);
                    g.fillCircle(x, y, 3.2 * anchor.scale);
                    g.fillStyle(0xf4f6a6, pulse * nightFactor);
                    g.fillCircle(x, y, 0.9 * anchor.scale);
                }
            } else {
                // A tiny butterfly/bird flickers between tree crowns by day.
                const flap = Math.sin(time * 0.012 + anchor.phase) * 2.2 * anchor.scale;
                g.fillStyle(0xe6c25b, 0.82 * (1 - nightFactor));
                g.fillTriangle(p.x, p.y, p.x - 4 * anchor.scale, p.y - flap, p.x - 1, p.y + 1.5);
                g.fillTriangle(p.x, p.y, p.x + 4 * anchor.scale, p.y - flap, p.x + 1, p.y + 1.5);
                g.fillStyle(0x4a3923, 0.9);
                g.fillRect(p.x - 0.6, p.y - 1, 1.2, 4 * anchor.scale);
            }
        }
    }

    /**
     * Postcards breathe through one compact decoration layer plus exact
     * resident vectors. Static bases stay cached; only visible life redraws.
     */
    private updatePostcardLife(time: number) {
        if (time < this.nextLifeDrawAt) return;
        this.nextLifeDrawAt = time + 66; // 15Hz pass; per-village sims LOD below it
        const nf = this.scene.dayNight?.nightFactor() ?? 0;
        const serverWallTime = Date.now() + DayNightSystem.serverOffsetMs;
        for (const view of this.views.values()) {
            if (!view.rt) {
                view.life?.destroy();
                view.life = null;
                view.glow?.destroy();
                view.glow = null;
                continue;
            }
            if (view.contentKind === 'nature') {
                if (view.natureLife.length === 0) {
                    view.life?.destroy();
                    view.life = null;
                    continue;
                }
                if (!view.life) {
                    // Per-frame vector life: smooth until its sprite bake
                    // lands (docs/AGENTS_SPRITE_PIPELINE.md step 5).
                    view.life = this.scene.add.graphics();
                }
                const hydrologyLife = String(view.renderedRevision).includes('_hydroart_');
                view.life.setDepth(hydrologyLife ? 27_501 : view.rt.depth + 1);
                view.life.clear();
                this.drawNaturePostcardLife(view.life, view.natureLife, time, nf);
                continue;
            }
            if (!view.hearth) {
                view.life?.destroy();
                view.life = null;
                continue;
            }
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
                g.fillStyle(0xdfe3e8, 0.22 * (1 - cycle));
                g.fillCircle(chimneyX + cycle * (7 + sway * 9), chimneyY - cycle * 20, 1.8 + cycle * 3);
            }

            // The clan pennant snapping on the hall roof.
            const poleX = hearthPos.x - 8;
            const poleY = hearthPos.y - 30;
            g.lineStyle(1.2, 0x6e5335, 0.95);
            g.lineBetween(poleX, poleY, poleX, poleY - 11);
            const flagColor = view.plot.kind === 'bot' ? 0x8a3d2f : 0x2f5f8a;
            g.fillStyle(flagColor, 0.95);
            const tip = 8 + sway * 2.4;
            g.fillTriangle(poleX, poleY - 11, poleX + tip, poleY - 9 + sway * 1.6, poleX, poleY - 6.6);

            // After dark: two warm windows glowing by the hall.
            if (nf > 0.05) {
                g.fillStyle(0xffc36a, 0.34 * nf);
                g.fillEllipse(hearthPos.x - 14, hearthPos.y - 8, 7, 4.4);
                g.fillEllipse(hearthPos.x + 12, hearthPos.y - 4, 6, 3.8);
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
            const hz = !onScreen ? 1.5 : ring <= 1 ? 12 : 5;
            this.neighborLife.tick(view.key, serverWallTime, hz, onScreen, nf);
        }
    }

    // ================= lifecycle =================

    /** Drop only GPU/display resources; retained sourceWorld remains cheap and authoritative. */
    private releaseViewVisuals(view: NeighborView, countEviction: boolean) {
        const hadVillageTexture = view.contentKind === 'village' && view.rt !== null;
        this.scene.dayNight?.clearPostcardLights?.(view.key);
        this.neighborLifeSim?.removeVillage(view.key);
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
        this.fallbackViewsActive = false;
        this.wilderness?.destroy();
        this.wilderness = null;
        this.wildernessLinks?.destroy();
        this.wildernessLinks = null;
        this.wildernessGapSurface?.destroy();
        this.wildernessGapSurface = null;
        this.worldHydrologyLayer?.destroy();
        this.worldHydrologyLayer = null;
        this.wildernessTopology = null;
        this.fogStatic?.destroy();
        this.fogStatic = null;
        this.fogEdge?.destroy();
        this.fogEdge = null;
        this.fogRadius = -1;
    }


    // ================= fog of war =================
    //
    // Past the watchtower's sight the world dissolves into cloud, built from
    // ONE shape family: the plump flat-bottomed cumulus — a chain of grounded
    // dome lobes over a level base, drawn as three stacked opaque silhouettes
    // (belly shadow, sunlit body lifted off it, crown light on the NW
    // shoulders — the Clash-of-Clans cloud). Two layers:
    //   1. The DEEP BANK (static, rebuilt only when sight changes): two
    //      packed rows of big puffs hugging the meadow, then NOTHING — one
    //      flat near-white floor to the horizon. Every sculpted shape lives
    //      in the edge line; past it the sky is clean.
    //   2. The LIVING EDGE (~15Hz, view-culled): the big front-row masses
    //      that breathe and loom, with taller crests swelling behind.

    /**
     * One plump cumulus, base level at (x, y), body width w. Three opaque
     * passes — shadow silhouette, the same silhouette lifted for the sunlit
     * body (a sliver of shadow stays visible under every lobe), crown light
     * on the two tallest domes. Opaque fills only: overlaps never darken.
     */
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
        const pass = (color: number, dy: number) => {
            g.fillStyle(color, alpha);
            for (const [cx, cy, r] of lobes) g.fillCircle(cx, cy + dy, r);
            g.fillRect(x - s * 0.42, y - s * 0.13 + dy, s * 0.84, s * 0.13);
        };
        pass(shadow, 0);
        pass(body, -lift);
        g.fillStyle(crown, alpha);
        const tall = [...lobes].sort((a, b) => b[2] - a[2]);
        for (let i = 0; i < 2 && i < tall.length; i++) {
            const [cx, cy, r] = tall[i];
            g.fillCircle(cx - r * 0.22, cy - r * 0.26 - lift, r * 0.52);
        }
    }

    private ensureFog(radius: number) {
        if (radius === this.fogRadius && this.fogStatic) return;
        this.fogRadius = radius;
        this.fogStatic?.destroy();
        const g = this.scene.add.graphics();
        g.setDepth(28_500); // above every postcard, below the day/night grade
        const inner = { min: -radius * PLOT_PITCH - PLOT_GAP - 0.4, max: (radius + 1) * PLOT_PITCH + 0.4 };
        const far = 7 * PLOT_PITCH;
        const P = (x: number, y: number) => IsoUtils.cartToIso(x, y);
        let seedState = 131;
        const rand = () => {
            seedState = (seedState * 1103515245 + 12345) & 0x7fffffff;
            return seedState / 0x7fffffff;
        };

        // 1. The floor: one flat, near-white frame out to the horizon. Past
        // the edge line the sky is deliberately EMPTY — the bank silhouette
        // does all the talking.
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

        // 2. Two packed rows just behind the living edge — the whole of the
        // visible bank. Row A shoulders right up against the front masses;
        // row B is bigger, paler, half a step deeper, dissolving into the
        // flat floor behind it.
        const ROWS: Array<{ d: number; w: number; step: number; shadow: number; body: number; crown: number }> = [
            { d: 3.4, w: 215, step: 3.4, shadow: 0xb6c6d8, body: 0xe2eaf1, crown: 0xf3f7fb },
            { d: 8.6, w: 255, step: 4.8, shadow: 0xb0c0d3, body: 0xd8e2ec, crown: 0xe9eff5 }
        ];
        for (const row of ROWS) {
            for (let side = 0; side < 4; side++) {
                for (let t = inner.min - row.d - 8; t <= inner.max + row.d + 8; t += row.step * (0.82 + rand() * 0.36)) {
                    const d = row.d + (rand() - 0.5) * 2.6;
                    let gx: number;
                    let gy: number;
                    if (side === 0) { gx = t; gy = inner.min - d; }
                    else if (side === 1) { gx = t; gy = inner.max + d; }
                    else if (side === 2) { gx = inner.min - d; gy = t; }
                    else { gx = inner.max + d; gy = t; }
                    const c = P(gx, gy);
                    const seed = (Math.imul((Math.round(t * 7) + side * 7919 + row.d * 131) | 0, 2654435761) >>> 0) % 100000;
                    WorldMapSystem.puff(g, c.x, c.y, row.w + (seed % 55), seed,
                        row.shadow, row.body, row.crown, (seed % 100) / 100);
                }
            }
        }
        // Deep cloud bank is built once — candidate for a one-time RT
        // quantize as follow-up.
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
        if (this.fogRadius < 0) return;
        if (time < this.nextFogEdgeAt) return;
        this.nextFogEdgeAt = time + 66;
        if (!this.fogEdge) {
            // Living rampart is per-frame vector: smooth until its sprite
            // bake lands (docs/AGENTS_SPRITE_PIPELINE.md step 5).
            this.fogEdge = this.scene.add.graphics();
            this.fogEdge.setDepth(28_502);
        }
        const g = this.fogEdge;
        g.clear();
        const inner = { min: -this.fogRadius * PLOT_PITCH - PLOT_GAP - 0.4, max: (this.fogRadius + 1) * PLOT_PITCH + 0.4 };
        const T = time * 0.001;
        const wv = this.scene.cameras.main.worldView;
        const CULL = 420;

        const SHADOW = 0xbfcedd;
        const BODY = 0xe9eff5;
        const CROWN = 0xf9fbfd;
        const CREST_SHADOW = 0xb2c2d4;
        const CREST_BODY = 0xdbe4ee;
        const CREST_CROWN = 0xedf2f7;

        const step = 2.0;
        for (let side = 0; side < 4; side++) {
            for (let t = inner.min - 4; t <= inner.max + 4; t += step) {
                const ix = Math.round((t + 10_000) * 7) + side * 7919;
                const h = (Math.imul(ix, 2654435761) >>> 0) % 1000;
                // Big masses swell slowly — compress the breath so the bank
                // rolls instead of popping.
                const phase = T * (0.1 + (h % 5) * 0.035) + h;
                const breath = 0.32 + 0.36 * (0.5 + 0.5 * Math.sin(phase));
                const drift = Math.sin(T * 0.05 + h * 0.7) * 0.8;
                const along = t + drift;
                const out = 1.1 + ((h >> 3) % 20) / 24;
                let gx: number;
                let gy: number;
                if (side === 0) { gx = along; gy = inner.min - out; }
                else if (side === 1) { gx = along; gy = inner.max + out; }
                else if (side === 2) { gx = inner.min - out; gy = along; }
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
