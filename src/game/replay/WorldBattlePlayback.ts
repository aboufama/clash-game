import type Phaser from 'phaser';
import {
    Backend,
    type AttackReplayState,
    type ReplayFrameSnapshot
} from '../backend/GameBackend';
import {
    BUILDING_DEFINITIONS,
    TROOP_DEFINITIONS,
    getBuildingStats,
    getTroopStats,
    type BuildingType,
    type TroopType
} from '../config/GameDefinitions';
import type { SerializedWorld } from '../data/Models';
import { figureTick, pixelEllipse, pixelLine, pixelRect } from '../render/PixelDraw';
import { SpriteBank, battleSpriteRequirements } from '../render/SpriteBank';
import { drawBuildingVisual } from '../renderers/BuildingVisualDispatcher';
import { ProjectileRenderer } from '../renderers/ProjectileRenderer';
import { TroopDeathRenderer, isLargeTroopDeathType } from '../renderers/TroopDeathRenderer';
import { TroopRenderer } from '../renderers/TroopRenderer';
import { WreckRenderer } from '../renderers/WreckRenderer';
import {
    depthForBuilding,
    depthForGroundDecal,
    depthForGroundEffect,
    depthForProjectile,
    depthForRubble,
    depthForTroop
} from '../systems/DepthSystem';
import { IsoUtils } from '../utils/IsoUtils';
import type {
    ReplayAttackStyle,
    ReplayDefenseWeapon,
    ReplayEntityRef,
    ReplayPresentationEvent,
    ReplayPresentationPoint,
    ProjectileLaunchPayload,
    EntityDeathPayload,
    BuildingDestroyPayload,
    CombatAttackPayload,
    DefenseFirePayload
} from './ReplayPresentationEvents';
import {
    ReplayPresentationDispatcher,
    type ReplayV2Chunk
} from './ReplayPresentationStream';
import {
    ReplayTimeline,
    type ReplayTimelineSample
} from './ReplayTimeline';
import {
    WorldBattlePlaybackModel,
    createReplaySequenceCursor,
    observeReplaySequences,
    presentationOverlapsReplayJoin,
    sampleWorldBattleTroop,
    terminalReplayGapFrom,
    worldBattlePreRollBaseline,
    worldBattleTroopPoseAt,
    type ReplaySequenceCursor,
    type WorldBattleFrameTransition
} from './WorldBattlePlaybackModel';
import {
    WorldBattlePresentationModel,
    sampleWorldBattleProjectile,
    worldBattleImpactVisual
} from './WorldBattlePresentationModel';
import type { SampledWorldBattleTroop } from './WorldBattlePlaybackModel';

const LIVE_POLL_MS = 900;
const LIVE_POLL_BACKOFF_MAX_MS = 5_400;
/** Same reconstruction window as MainScene live replay: covers long arcs,
 * charge telegraphs, and stateful attack poses already in progress at join. */
const LIVE_PREROLL_MS = 5_500;
const DEFAULT_ATTACK_TRACE_MS = 420;

function assertNeverReplayPresentationEvent(event: never): never {
    throw new Error(`Unhandled world-battle replay event: ${JSON.stringify(event)}`);
}

/** Mirrors the authored live launchers. Until projectile.launch is published
 * by MainScene, combat.attack is the postcard's travel fallback. */
const ATTACK_TRACE_DURATION_MS: Record<ReplayAttackStyle, number> = {
    'melee-punch': 120,
    'archer-arrow': 200,
    'generic-tracer': 160,
    'necromancer-orb': 420,
    'mobile-mortar': 600,
    trebuchet: 900,
    'ornithopter-bomb': 420,
    'storm-lightning': 160,
    'stone-golem-slam': 200,
    'ice-golem-slam': 200,
    'da-vinci-cannon': 200,
    'phalanx-thrust': 140,
    'war-elephant-trample': 140,
    'battering-ram': 140,
    'wall-breaker-detonation': 80,
    'clockwork-beetle-latch': 125,
    'clockwork-beetle-detonation': 80,
    'siege-tower-park': 700
};

/** Fixed windup plus authored screen-pixel speed for defensive launchers. */
const DEFENSE_TRACE_TIMING: Record<ReplayDefenseWeapon, { windupMs: number; pxPerMs?: number; fixedMs?: number }> = {
    cannon: { windupMs: 0, pxPerMs: 0.8 },
    ballista: { windupMs: 400, pxPerMs: 1.2 },
    xbow: { windupMs: 0, pxPerMs: 1.5 },
    mortar: { windupMs: 0, pxPerMs: 0.3 },
    tesla: { windupMs: 0, fixedMs: 150 },
    prism: { windupMs: 0, fixedMs: 100 },
    'dragons-breath': { windupMs: 0, fixedMs: 800 },
    'spike-launcher': { windupMs: 150, pxPerMs: 0.45 }
};

interface BuildingVisualMeta {
    id: string;
    type: BuildingType;
    level: number;
    gridX: number;
    gridY: number;
    width: number;
    height: number;
    maxHealth: number;
    /** Replay-authored turret pose. Every rotating defense renderer reads the
     * same historical field name used by the live scene. */
    ballistaAngle?: number;
    lastFireTime?: number;
    teslaCharging?: boolean;
    teslaChargeStart?: number;
    teslaCharged?: boolean;
}

interface ImpactPulse {
    id: string;
    at: ReplayPresentationPoint;
    startT: number;
    durationMs: number;
    color: number;
    radius: number;
}

interface WorldBattleTroopDeathVisual {
    payload: EntityDeathPayload;
    startT: number;
    seed: number;
    carrier: Phaser.GameObjects.Graphics;
    ground?: Phaser.GameObjects.Graphics;
}

interface WorldBattleWreckVisual {
    body: Phaser.GameObjects.Graphics;
    ground: Phaser.GameObjects.Graphics;
}

interface WorldBattleBuildingCollapseVisual {
    id: string;
    payload: BuildingDestroyPayload;
    startT: number;
    seed: number;
    body: Phaser.GameObjects.Graphics;
    ground: Phaser.GameObjects.Graphics;
}

const PROJECTILE_BAKE = {
    'archer-arrow': { unit: 'arrow', angles: 16 },
    'mobile-mortar-shell': { unit: 'mm_shell', angles: 1 },
    'trebuchet-stone': { unit: 'trebuchet_stone', angles: 16 },
    'ornithopter-bomb': { unit: 'ornithopter_bomb', angles: 1 },
    cannonball: { unit: 'cannonball', angles: 1 },
    'mortar-shell': { unit: 'mortar_shell', angles: 16 },
    'ballista-bolt': { unit: 'ballista_bolt', angles: 16 },
    'xbow-bolt': { unit: 'xbow_bolt', angles: 16 },
    'dragon-rocket': { unit: 'dragon_rocket', angles: 16 },
    'spike-ball': { unit: 'spike_ball', angles: 16 }
} as const satisfies Partial<Record<ProjectileLaunchPayload['projectile'], {
    unit: string;
    angles: number;
}>>;

export interface WorldBattlePlaybackPlacement {
    gridOffsetX: number;
    gridOffsetY: number;
    baseDepth: number;
}

export interface WorldBattlePlaybackCallbacks {
    /** Initial replay snapshot is ready and can replace the normal postcard. */
    onWorldReady?: (playback: WorldBattlePlayback) => void;
    /** A collapse/correction changed which static buildings belong in the postcard. */
    onDestroyedBuildingsChanged?: (playback: WorldBattlePlayback) => void;
    /** The stream drained after the server marked the attack terminal. */
    onEnded?: (playback: WorldBattlePlayback) => void;
}

/**
 * Lightweight live-replay surface for one resident world-map postcard.
 *
 * It consumes the same keyframe/event stream as MainScene, but owns only the
 * presentation needed at map scale: baked moving troops, exact event-timed
 * health transitions, projectile/tracer cues, health bars, and destruction.
 * No scene-wide time scale or combat simulation is touched.
 */
export class WorldBattlePlayback {
    readonly attackId: string;
    private readonly scene: Phaser.Scene;
    private readonly callbacks: WorldBattlePlaybackCallbacks;
    private placement: WorldBattlePlaybackPlacement;
    private timeline = new ReplayTimeline<ReplayFrameSnapshot, ReplayPresentationEvent>({
        timestampMode: 'v2-relative',
        clockMode: 'live',
        minimumLiveDelayMs: 1_500,
        maximumLiveDelayMs: 10_000
    });
    private dispatcher: ReplayPresentationDispatcher<ReplayFrameSnapshot> | null = null;
    private model = new WorldBattlePlaybackModel();
    private readonly presentation = new WorldBattlePresentationModel();
    private sequenceCursor: ReplaySequenceCursor = createReplaySequenceCursor();
    /** One scene-level group per postcard. Its root depth keeps the battle
     * inside the postcard's plot band, while child depths use DepthSystem's
     * unscaled 0.1/0.5 isometric sub-bands exactly. */
    private readonly battleLayer: Phaser.GameObjects.Layer;
    private readonly carriers = new Map<string, Phaser.GameObjects.Graphics>();
    private readonly carrierFacing = new Map<string, number>();
    /** Exactly one pose sample per troop per replay tick. Every tracker, bar,
     * and sprite reads this cache instead of independently crossing a
     * keyframe boundary (the old Tesla/Prism endpoint jump). */
    private readonly sampledTroops = new Map<string, SampledWorldBattleTroop>();
    /** Per-battery wake/sleep ease state for the dragons_breath proximity
     * deploy mirror (threatT = last replayT a live raider stood inside the
     * wake radius; anchorT/from/target = the current ease leg). */
    private readonly dragonDeploy = new Map<string, { threatT?: number; anchorT: number; from: number; target: 0 | 1 }>();
    private readonly buildingCarriers = new Map<string, Phaser.GameObjects.Graphics>();
    private readonly buildingMeta = new Map<string, BuildingVisualMeta>();
    private readonly wallIdsByCell = new Map<string, string>();
    private readonly impactPulses: ImpactPulse[] = [];
    private readonly impactTimeByEventId = new Map<string, number>();
    private readonly airCarriers = new Map<string, Phaser.GameObjects.Graphics>();
    private readonly troopDeaths = new Map<string, WorldBattleTroopDeathVisual>();
    private readonly buildingCollapses = new Map<string, WorldBattleBuildingCollapseVisual>();
    private readonly wrecks = new Map<string, WorldBattleWreckVisual>();
    private readonly groundOverlay: Phaser.GameObjects.Graphics;
    private readonly healthOverlay: Phaser.GameObjects.Graphics;
    private sourceWorldValue: SerializedWorld | null = null;
    private readyValue = false;
    private visible = true;
    private destroyed = false;
    private lifecycleEpoch = 0;
    private statusValue: AttackReplayState['status'] = 'live';
    private usesV2 = false;
    private lastFetchedFrameT = -1;
    private lastLegacyAppliedT = -1;
    private nextPollAt = 0;
    private pollInFlight = false;
    private pollFailures = 0;
    private catchingUp = false;
    private catchUpTargetT = -1;
    private endedNotified = false;
    private terminalOnlyV2 = false;
    private terminalGapChunk: Extract<ReplayV2Chunk<ReplayFrameSnapshot>, { kind: 'keyframe' }> | null = null;
    private lastFigureTick = -1;

    constructor(
        scene: Phaser.Scene,
        attackId: string,
        placement: WorldBattlePlaybackPlacement,
        callbacks: WorldBattlePlaybackCallbacks = {}
    ) {
        this.scene = scene;
        this.attackId = attackId;
        this.placement = { ...placement };
        this.callbacks = callbacks;
        this.battleLayer = scene.add.layer();
        this.battleLayer.setDepth(placement.baseDepth + 0.5);
        this.groundOverlay = scene.add.graphics();
        this.groundOverlay.setDepth(depthForGroundDecal('crater'));
        this.healthOverlay = scene.add.graphics();
        // Bars are the sole always-on-top child. Every projectile, status,
        // collapse and airborne primitive owns a canonically sorted carrier.
        this.healthOverlay.setDepth(30_000);
        this.battleLayer.add([this.groundOverlay, this.healthOverlay]);
    }

    get ready(): boolean {
        return this.readyValue;
    }

    get status(): AttackReplayState['status'] {
        return this.statusValue;
    }

    get sourceWorld(): SerializedWorld | null {
        return this.sourceWorldValue;
    }

    get destroyedBuildingIds(): ReadonlySet<string> {
        return this.model.destroyedBuildingIds;
    }

    async start(): Promise<boolean> {
        const epoch = ++this.lifecycleEpoch;
        let replay: AttackReplayState | null = null;
        try {
            replay = await Backend.getLiveAttackState(this.attackId);
        } catch (error) {
            console.warn(`World battle ${this.attackId} could not start:`, error);
        }
        if (!this.isCurrent(epoch) || !replay?.enemyWorld) return false;

        this.statusValue = replay.status;
        this.terminalOnlyV2 = replay.terminalOnlyV2 === true;
        this.installWorld(replay.enemyWorld);
        await this.ensureReplayAssets(replay);
        if (!this.isCurrent(epoch)) return false;
        this.installInitialReplay(replay);
        this.readyValue = this.timeline.keyframes.length > 0 || this.model.frameT >= 0;
        this.nextPollAt = (this.scene.time?.now ?? 0) + LIVE_POLL_MS;
        if (this.readyValue) this.callbacks.onWorldReady?.(this);
        if (this.statusValue !== 'live') this.timeline.setMode('recorded');
        return this.readyValue;
    }

    setPlacement(placement: WorldBattlePlaybackPlacement): void {
        const moved = placement.gridOffsetX !== this.placement.gridOffsetX
            || placement.gridOffsetY !== this.placement.gridOffsetY;
        this.placement = { ...placement };
        this.battleLayer.setDepth(placement.baseDepth + 0.5);
        if (moved) {
            const wreckIds = [...this.wrecks.keys()];
            for (const id of wreckIds) this.destroyWreck(id);
            for (const id of wreckIds) this.ensureWreck(id);
            for (const death of this.troopDeaths.values()) {
                const at = this.placePoint(death.payload.at);
                death.carrier.setPosition(at.x, at.y);
                death.ground?.setPosition(at.x, at.y + 8);
            }
            for (const collapse of this.buildingCollapses.values()) {
                const at = this.placePoint(collapse.payload.at);
                collapse.body.setPosition(at.x, at.y);
                collapse.ground.setPosition(at.x, at.y + 20);
            }
        }
    }

    setVisible(visible: boolean): void {
        this.visible = visible;
        this.battleLayer.setVisible(visible);
        this.groundOverlay.setVisible(visible);
        this.healthOverlay.setVisible(visible);
        for (const carrier of this.carriers.values()) carrier.setVisible(visible);
        for (const carrier of this.buildingCarriers.values()) carrier.setVisible(visible);
        for (const carrier of this.airCarriers.values()) carrier.setVisible(visible);
        for (const death of this.troopDeaths.values()) {
            death.carrier.setVisible(visible);
            death.ground?.setVisible(visible);
        }
        for (const collapse of this.buildingCollapses.values()) {
            collapse.body.setVisible(visible);
            collapse.ground.setVisible(visible);
        }
        for (const wreck of this.wrecks.values()) {
            wreck.body.setVisible(visible);
            wreck.ground.setVisible(visible);
        }
    }

    update(sceneTime: number, deltaMs: number): void {
        if (this.destroyed) return;
        if (this.statusValue === 'live' && sceneTime >= this.nextPollAt && !this.pollInFlight) {
            void this.poll(sceneTime);
        }
        if (!this.readyValue) return;

        const step = this.timeline.advance(Math.max(0, Math.min(250, Number(deltaMs) || 0)));
        if (this.usesV2) {
            const dispatch = this.dispatcher?.dispatchThrough(step.toT);
            const gap = this.terminalGapChunk;
            if (this.terminalOnlyV2 && this.statusValue !== 'live' && gap
                && gap.t <= step.toT && dispatch?.nextSequence !== undefined
                && gap.sequence > dispatch.nextSequence) {
                this.dispatcher?.reset(gap.sequence);
                this.dispatcher?.ingest([gap]);
                this.dispatcher?.dispatchThrough(step.toT);
                this.sequenceCursor = createReplaySequenceCursor(gap.sequence);
                this.terminalGapChunk = null;
            }
        } else {
            const previous = step.sample.previous;
            if (previous && previous.t > this.lastLegacyAppliedT) {
                this.handleTransition(this.applyReplayFrame(previous.frame));
                this.lastLegacyAppliedT = previous.t;
            }
        }

        this.render(step.sample, step.toT, deltaMs);
        const drained = step.toT >= this.timeline.headT;
        if (this.statusValue !== 'live' && drained && !this.endedNotified) {
            this.endedNotified = true;
            this.callbacks.onEnded?.(this);
        }
    }

    destroy(): void {
        if (this.destroyed) return;
        this.destroyed = true;
        this.lifecycleEpoch += 1;
        this.groundOverlay.destroy();
        this.healthOverlay.destroy();
        for (const carrier of this.carriers.values()) carrier.destroy();
        for (const carrier of this.buildingCarriers.values()) carrier.destroy();
        for (const carrier of this.airCarriers.values()) carrier.destroy();
        for (const death of this.troopDeaths.values()) {
            death.carrier.destroy();
            death.ground?.destroy();
        }
        for (const collapse of this.buildingCollapses.values()) {
            collapse.body.destroy();
            collapse.ground.destroy();
        }
        for (const wreck of this.wrecks.values()) {
            wreck.body.destroy();
            wreck.ground.destroy();
        }
        this.carriers.clear();
        this.carrierFacing.clear();
        this.sampledTroops.clear();
        this.dragonDeploy.clear();
        this.buildingCarriers.clear();
        this.airCarriers.clear();
        this.troopDeaths.clear();
        this.buildingCollapses.clear();
        this.wrecks.clear();
        this.battleLayer.destroy();
        this.impactPulses.length = 0;
        this.presentation.reset();
    }

    private installWorld(world: SerializedWorld): void {
        this.sourceWorldValue = world;
        this.presentation.reset();
        const maxHealth = new Map<string, number>();
        this.buildingMeta.clear();
        this.wallIdsByCell.clear();
        for (const building of world.buildings ?? []) {
            const type = building.type as BuildingType;
            const definition = BUILDING_DEFINITIONS[type];
            if (!definition) continue;
            const level = Math.max(1, Math.floor(Number(building.level) || 1));
            const stats = getBuildingStats(type, level);
            maxHealth.set(building.id, stats.maxHealth);
            this.buildingMeta.set(building.id, {
                id: building.id,
                type,
                level,
                gridX: Number(building.gridX) || 0,
                gridY: Number(building.gridY) || 0,
                width: definition.width,
                height: definition.height,
                maxHealth: stats.maxHealth
            });
            if (type === 'wall') {
                this.wallIdsByCell.set(`${Number(building.gridX) || 0},${Number(building.gridY) || 0}`, building.id);
            }
        }
        this.model = new WorldBattlePlaybackModel(maxHealth);
    }

    private async ensureReplayAssets(replay: AttackReplayState): Promise<void> {
        const troopTypes = new Set<string>();
        const addFrame = (frame: ReplayFrameSnapshot | null | undefined) => {
            for (const troop of frame?.troops ?? []) {
                if (Object.prototype.hasOwnProperty.call(TROOP_DEFINITIONS, troop.type)) {
                    troopTypes.add(troop.type);
                }
            }
        };
        const visit = (value: unknown, depth = 0): void => {
            if (depth > 6 || value == null) return;
            if (Array.isArray(value)) {
                for (const entry of value) visit(entry, depth + 1);
                return;
            }
            if (typeof value !== 'object') return;
            const record = value as Record<string, unknown>;
            if (record.kind === 'troop' && typeof record.type === 'string'
                && Object.prototype.hasOwnProperty.call(TROOP_DEFINITIONS, record.type)) {
                troopTypes.add(record.type);
            }
            for (const nested of Object.values(record)) visit(nested, depth + 1);
        };

        addFrame(replay.latestFrame);
        for (const frame of replay.frames ?? []) addFrame(frame);
        for (const chunk of replay.v2Chunks ?? []) {
            if (chunk.kind === 'keyframe') addFrame(chunk.frame);
            else visit(chunk.event.payload);
        }
        for (const troop of this.model.troops.values()) troopTypes.add(troop.type);

        const world = replay.enemyWorld ?? this.sourceWorldValue;
        await SpriteBank.ensureUnits(this.scene, battleSpriteRequirements({
            buildingTypes: (world?.buildings ?? []).map(building => building.type),
            obstacleTypes: (world?.obstacles ?? []).map(obstacle => obstacle.type),
            troopTypes
        }));
    }

    private installInitialReplay(replay: AttackReplayState): void {
        const chunks = (replay.v2Chunks ?? []).slice().sort((a, b) => a.sequence - b.sequence);
        const v2Keyframes = chunks.filter(
            (chunk): chunk is Extract<ReplayV2Chunk<ReplayFrameSnapshot>, { kind: 'keyframe' }> =>
                chunk.kind === 'keyframe'
        );
        if (v2Keyframes.length > 0) {
            this.usesV2 = true;
            this.indexImpactTimes(chunks);
            this.timeline.ingestV2Chunks(chunks);
            const join = this.timeline.seekLiveEdge();
            const baseline = worldBattlePreRollBaseline(
                this.timeline.keyframes,
                join.t,
                LIVE_PREROLL_MS
            );
            this.handleTransition(this.applyReplayFrame(baseline.frame));
            this.lastFetchedFrameT = Math.max(...v2Keyframes.map(chunk => chunk.frame.t));
            const baselineSequence = baseline.sequence ?? Math.max(0, chunks[0].sequence - 1);
            if (this.terminalOnlyV2) {
                this.terminalGapChunk = terminalReplayGapFrom(chunks, baselineSequence);
            }
            this.sequenceCursor = observeReplaySequences(
                createReplaySequenceCursor(baselineSequence),
                chunks.map(chunk => chunk.sequence).filter(sequence => sequence > baselineSequence)
            );
            this.installDispatcher(baselineSequence + 1);
            this.dispatcher?.ingest(chunks);
            this.catchingUp = true;
            this.catchUpTargetT = join.t;
            try {
                this.dispatcher?.dispatchThrough(join.t);
            } finally {
                this.catchingUp = false;
                this.catchUpTargetT = -1;
            }
            return;
        }

        const frames: ReplayFrameSnapshot[] = [];
        if (Array.isArray(replay.frames)) frames.push(...replay.frames);
        if (replay.latestFrame) frames.push(replay.latestFrame);
        if (frames.length === 0) return;
        this.timeline.ingestLegacyKeyframes(frames);
        const join = this.timeline.seekLiveEdge();
        const baseline = join.previous ?? this.timeline.keyframes[0];
        this.handleTransition(this.applyReplayFrame(baseline.frame));
        this.lastLegacyAppliedT = baseline.t;
        this.lastFetchedFrameT = Math.max(...frames.map(frame => frame.t));
    }

    private installDispatcher(initialSequence: number): void {
        this.dispatcher = new ReplayPresentationDispatcher<ReplayFrameSnapshot>({
            initialSequence,
            maxPendingChunks: 8_192,
            onKeyframe: chunk => {
                this.lastFetchedFrameT = Math.max(this.lastFetchedFrameT, chunk.frame.t);
                this.handleTransition(this.applyReplayFrame(chunk.frame));
            },
            onEvent: (event, context) => this.applyEvent(event, context.chunk.t)
        });
    }

    /** Apply correction-only turret headings at the same ordered seam as
     * health and troop state. Later defense events may then override them
     * without an older keyframe being re-applied on every render tick. */
    private applyReplayFrame(frame: ReplayFrameSnapshot): WorldBattleFrameTransition {
        for (const snapshot of frame.buildings) {
            if (!Number.isFinite(snapshot.ballistaAngle)) continue;
            const meta = this.buildingMeta.get(snapshot.id);
            if (meta) meta.ballistaAngle = Number(snapshot.ballistaAngle);
        }
        return this.model.applyFrame(frame);
    }

    private ingestIncremental(replay: AttackReplayState): void {
        this.statusValue = replay.status;
        this.terminalOnlyV2 ||= replay.terminalOnlyV2 === true;
        const chunks = replay.v2Chunks ?? [];
        if (chunks.length > 0) {
            this.indexImpactTimes(chunks);
            if (!this.usesV2) {
                // A legacy publisher may upgrade mid-watch. The current model
                // is already authoritative; start ordered dispatch at the first
                // new sequence and do not replay its old history over the card.
                this.usesV2 = true;
                const first = Math.min(...chunks.map(chunk => chunk.sequence));
                this.installDispatcher(first);
                this.sequenceCursor = createReplaySequenceCursor(first - 1);
            }
            this.timeline.ingestV2Chunks(chunks);
            this.dispatcher?.ingest(chunks);
            const terminalGap = this.terminalOnlyV2
                ? terminalReplayGapFrom(chunks, this.sequenceCursor.contiguous)
                : null;
            this.sequenceCursor = observeReplaySequences(
                this.sequenceCursor,
                chunks.map(chunk => chunk.sequence)
            );
            for (const chunk of chunks) {
                if (chunk.kind === 'keyframe') {
                    this.lastFetchedFrameT = Math.max(this.lastFetchedFrameT, chunk.frame.t);
                }
            }
            if (terminalGap) this.terminalGapChunk = terminalGap;
        } else if (!this.usesV2) {
            const frames: ReplayFrameSnapshot[] = [];
            if (Array.isArray(replay.frames)) frames.push(...replay.frames);
            if (replay.latestFrame && replay.latestFrame.t > this.lastFetchedFrameT) frames.push(replay.latestFrame);
            if (frames.length > 0) {
                this.timeline.ingestLegacyKeyframes(frames);
                this.lastFetchedFrameT = Math.max(this.lastFetchedFrameT, ...frames.map(frame => frame.t));
            }
        }
        if (this.statusValue !== 'live') this.timeline.setMode('recorded');
    }

    private async poll(sceneTime: number): Promise<void> {
        if (this.pollInFlight || this.destroyed) return;
        this.pollInFlight = true;
        const epoch = this.lifecycleEpoch;
        try {
            const replay = await Backend.getLiveAttackState(
                this.attackId,
                this.lastFetchedFrameT,
                this.sequenceCursor.contiguous
            );
            if (!this.isCurrent(epoch)) return;
            if (!replay) throw new Error('live replay unavailable');
            await this.ensureReplayAssets(replay);
            if (!this.isCurrent(epoch)) return;
            this.pollFailures = 0;
            this.ingestIncremental(replay);
            this.nextPollAt = sceneTime + LIVE_POLL_MS;
        } catch (error) {
            if (!this.isCurrent(epoch)) return;
            this.pollFailures += 1;
            const delay = Math.min(LIVE_POLL_BACKOFF_MAX_MS, LIVE_POLL_MS * (2 ** this.pollFailures));
            this.nextPollAt = sceneTime + delay;
            if (this.pollFailures === 1) {
                console.warn(`World battle ${this.attackId} poll paused:`, error);
            }
        } finally {
            if (this.isCurrent(epoch)) this.pollInFlight = false;
        }
    }

    private applyEvent(event: ReplayPresentationEvent, eventT: number): void {
        switch (event.type) {
            case 'troop.spawn': {
                const payload = event.payload;
                this.model.spawnTroop({
                    id: payload.troop.id,
                    type: payload.troop.type,
                    level: payload.troop.level,
                    owner: payload.troop.owner,
                    gridX: payload.at.gridX,
                    gridY: payload.at.gridY,
                    health: payload.maxHealth,
                    maxHealth: payload.maxHealth,
                    facingAngle: payload.facingAngle,
                    hasTakenDamage: false
                }, eventT);
                if (this.presentDuringCatchUp(eventT, 220)) {
                    this.addImpact(`${event.id}:spawn`, payload.at, eventT, 220, 0xd8b878, 6);
                }
                break;
            }
            case 'combat.attack': {
                const payload = event.payload;
                this.model.markTroopAttack(
                    payload.actor.id,
                    eventT,
                    payload.style,
                    payload.facingAngle,
                    payload.pose
                );
                const fallback = this.fallbackTroopProjectile(event.id, payload, eventT);
                if (fallback && this.presentDuringCatchUp(
                    eventT,
                    fallback.trajectory.kind === 'continuous'
                        ? DEFAULT_ATTACK_TRACE_MS
                        : fallback.trajectory.durationMs,
                    event.id
                )) {
                    this.presentation.applyProjectileLaunch(fallback, eventT, event.seed, {
                        eventId: event.id,
                        fallback: true
                    });
                }
                break;
            }
            case 'defense.charge': {
                const payload = event.payload;
                const meta = this.buildingMeta.get(payload.defense.id);
                if (meta) {
                    meta.ballistaAngle = payload.facingAngle;
                    if (payload.phase === 'start') {
                        meta.teslaCharging = true;
                        meta.teslaChargeStart = eventT;
                        meta.teslaCharged = false;
                    } else if (payload.phase === 'complete') {
                        meta.teslaCharging = false;
                        meta.teslaCharged = true;
                    } else {
                        meta.teslaCharging = false;
                        meta.teslaCharged = false;
                    }
                }
                this.presentation.applyDefenseCharge(payload, eventT, event.seed);
                break;
            }
            case 'defense.fire': {
                const payload = event.payload;
                const meta = this.buildingMeta.get(payload.defense.id);
                if (meta) {
                    meta.ballistaAngle = payload.facingAngle;
                    meta.lastFireTime = eventT;
                    if (payload.weapon === 'tesla') {
                        meta.teslaCharging = false;
                        meta.teslaCharged = true;
                    }
                }
                const timing = DEFENSE_TRACE_TIMING[payload.weapon];
                const distance = Math.hypot(
                    payload.targetPoint.worldX - payload.source.worldX,
                    payload.targetPoint.worldY - payload.source.worldY
                );
                const durationMs = timing.fixedMs
                    ?? timing.windupMs + distance / Math.max(0.01, timing.pxPerMs ?? 1);
                this.presentation.applyDefenseFire(
                    payload,
                    event.id,
                    eventT,
                    event.seed,
                    this.impactTimeByEventId.get(event.id) ?? eventT + durationMs
                );
                const fallback = this.fallbackDefenseProjectile(event.id, payload, eventT, durationMs);
                if (fallback && this.presentDuringCatchUp(eventT, durationMs, event.id)) {
                    const fallbackStartT = eventT + (payload.weapon === 'ballista' ? 400 : 0);
                    this.presentation.applyProjectileLaunch(fallback, fallbackStartT, event.seed, {
                        eventId: event.id,
                        fallback: true
                    });
                }
                break;
            }
            case 'projectile.launch': {
                const payload = event.payload;
                this.presentation.applyProjectileLaunch(payload, eventT, event.seed, {
                    eventId: event.id
                });
                break;
            }
            case 'projectile.impact': {
                this.presentation.applyProjectileImpact(event.payload, eventT, event.seed);
                break;
            }
            case 'combat.damage': {
                const payload = event.payload;
                this.handleTransition(this.model.damageEntity(
                    payload.target.kind,
                    payload.target.id,
                    payload.healthAfter,
                    payload.maxHealth
                ));
                if (this.presentDuringCatchUp(eventT, 240)
                    && !this.presentation.hasImpactForLaunch(
                        payload.linkedPresentationEventId,
                        eventT
                    )) {
                    const color = payload.damageKind === 'continuous-beam' ? 0xff7cf4
                        : payload.damageKind === 'chain' ? 0x87edff
                            : 0xff6b45;
                    this.addImpact(`${event.id}:damage`, payload.at, eventT, 240, color, 6);
                }
                break;
            }
            case 'combat.heal': {
                const payload = event.payload;
                this.model.healTroop(payload.target.id, payload.healthAfter, payload.maxHealth);
                if (this.presentDuringCatchUp(eventT, 300)) {
                    this.addImpact(`${event.id}:heal`, payload.at, eventT, 300, 0x72ec9a, 7);
                }
                break;
            }
            case 'entity.death': {
                this.startTroopDeath(event.payload, eventT, event.seed);
                this.model.removeTroop(event.payload.entity.id);
                this.presentation.removeTroop(event.payload.entity.id);
                break;
            }
            case 'building.destroy': {
                this.handleTransition(this.model.destroyBuilding(event.payload.building.id));
                this.presentation.removeBuilding(event.payload.building.id);
                if (!event.payload.createRubble) this.destroyWreck(event.payload.building.id);
                const collapseDurationMs = event.payload.style === 'town-hall' ? 900 : 650;
                if (!event.payload.silent
                    && this.presentDuringCatchUp(eventT, collapseDurationMs)) {
                    this.startBuildingCollapse(event.id, event.payload, eventT, event.seed);
                }
                break;
            }
            case 'ability': {
                const payload = event.payload;
                this.presentation.applyAbility(
                    payload,
                    event.id,
                    eventT,
                    event.seed,
                    entity => this.pointForEntity(entity)
                );
                switch (payload.ability) {
                    case 'siege-tower-park':
                        this.model.markTroopAttack(payload.actor.id, eventT, 'siege-tower-park');
                        break;
                    case 'stone-golem-slam':
                        this.model.markTroopAttack(payload.actor.id, eventT, 'stone-golem-slam');
                        break;
                    case 'ice-golem-slam':
                        this.model.markTroopAttack(payload.actor.id, eventT, 'ice-golem-slam');
                        break;
                    case 'phalanx-thrust':
                        this.model.markTroopAttack(payload.actor.id, eventT, 'phalanx-thrust');
                        break;
                    case 'battering-ram-punch':
                        this.model.markTroopAttack(payload.actor.id, eventT, 'battering-ram');
                        break;
                    case 'war-elephant-trample':
                        this.model.markTroopAttack(payload.actor.id, eventT, 'war-elephant-trample');
                        break;
                    case 'clockwork-beetle-latch':
                        this.model.markTroopAttack(payload.actor.id, eventT, 'clockwork-beetle-latch');
                        break;
                    case 'clockwork-beetle-detonate':
                        this.model.markTroopAttack(payload.actor.id, eventT, 'clockwork-beetle-detonation');
                        break;
                    default:
                        break;
                }
                break;
            }
            case 'status':
                this.presentation.applyStatus(event.payload, eventT, event.seed);
                break;
            case 'fx':
                this.presentation.applyFx(event.payload, event.id, eventT, event.seed);
                break;
            case 'sound':
                // Nearby battles are ambient world activity. Replaying their
                // sound would hijack the local village mix; visuals remain exact.
                break;
            default:
                assertNeverReplayPresentationEvent(event);
        }
    }

    private presentDuringCatchUp(eventT: number, durationMs: number, eventId?: string): boolean {
        if (!this.catchingUp) return true;
        const exactImpactT = eventId ? this.impactTimeByEventId.get(eventId) : undefined;
        const endT = exactImpactT ?? eventT + Math.max(0, durationMs);
        return presentationOverlapsReplayJoin(eventT, endT, this.catchUpTargetT);
    }

    private fallbackTroopProjectile(
        eventId: string,
        payload: CombatAttackPayload,
        eventT: number
    ): ProjectileLaunchPayload | null {
        if (!payload.targetPoint || payload.phase !== 'release') return null;
        const offsetSource = (dy: number): ReplayPresentationPoint => ({
            ...payload.at,
            worldY: payload.at.worldY + dy
        });
        const exactDuration = this.impactTimeByEventId.has(eventId)
            ? Math.max(1, this.impactTimeByEventId.get(eventId)! - eventT)
            : ATTACK_TRACE_DURATION_MS[payload.style];
        let projectile: ProjectileLaunchPayload['projectile'];
        let source = payload.at;
        let trajectory: ProjectileLaunchPayload['trajectory'];
        switch (payload.style) {
            case 'archer-arrow':
                projectile = 'archer-arrow';
                source = offsetSource(-17);
                trajectory = { kind: 'linear', durationMs: exactDuration, ease: 'Linear' };
                break;
            case 'generic-tracer':
                projectile = 'generic-tracer';
                source = offsetSource(-11);
                trajectory = { kind: 'instant', durationMs: Math.max(1, exactDuration) };
                break;
            case 'necromancer-orb':
                projectile = 'necromancer-orb';
                source = offsetSource(-18);
                trajectory = {
                    kind: 'parabolic',
                    durationMs: exactDuration,
                    apexWorldY: Math.min(source.worldY, payload.targetPoint.worldY) - 36,
                    spinRadians: 0
                };
                break;
            case 'mobile-mortar':
                projectile = 'mobile-mortar-shell';
                source = offsetSource(-18);
                trajectory = {
                    kind: 'parabolic', durationMs: exactDuration,
                    riseMs: exactDuration / 2,
                    apexWorldY: Math.min(source.worldY, payload.targetPoint.worldY) - 80,
                    spinRadians: 0
                };
                break;
            case 'trebuchet':
                projectile = 'trebuchet-stone';
                source = offsetSource(-30);
                trajectory = {
                    kind: 'parabolic', durationMs: exactDuration,
                    riseMs: exactDuration / 2,
                    apexWorldY: Math.min(source.worldY, payload.targetPoint.worldY) - 200,
                    spinRadians: Math.PI * 4
                };
                break;
            case 'ornithopter-bomb':
                projectile = 'ornithopter-bomb';
                source = offsetSource(-34);
                trajectory = {
                    kind: 'parabolic', durationMs: exactDuration,
                    riseMs: exactDuration / 2,
                    apexWorldY: Math.min(source.worldY, payload.targetPoint.worldY - 20) - 24,
                    spinRadians: 0
                };
                break;
            case 'da-vinci-cannon':
                projectile = 'da-vinci-cannonball';
                source = offsetSource(-8);
                trajectory = { kind: 'linear', durationMs: exactDuration, ease: 'Quad.easeIn' };
                break;
            case 'storm-lightning':
                projectile = 'storm-lightning';
                source = offsetSource(-16);
                trajectory = { kind: 'instant', durationMs: Math.max(1, exactDuration) };
                break;
            case 'melee-punch':
            case 'stone-golem-slam':
            case 'ice-golem-slam':
            case 'phalanx-thrust':
            case 'war-elephant-trample':
            case 'battering-ram':
            case 'wall-breaker-detonation':
            case 'clockwork-beetle-latch':
            case 'clockwork-beetle-detonation':
            case 'siege-tower-park':
                return null;
            default:
                return null;
        }
        const rotation = Math.atan2(
            payload.targetPoint.worldY - source.worldY,
            payload.targetPoint.worldX - source.worldX
        );
        return {
            projectileId: `fallback:${eventId}`,
            projectile,
            sourceEntity: payload.actor,
            targetEntity: payload.target,
            source,
            target: payload.targetPoint,
            level: Math.max(1, payload.actor.level || 1),
            rotation,
            scale: projectile === 'da-vinci-cannonball' ? 0.55 : 1,
            trajectory
        };
    }

    private fallbackDefenseProjectile(
        eventId: string,
        payload: DefenseFirePayload,
        eventT: number,
        fallbackDurationMs: number
    ): ProjectileLaunchPayload | null {
        const exactDuration = this.impactTimeByEventId.has(eventId)
            ? Math.max(1, this.impactTimeByEventId.get(eventId)! - eventT)
            : Math.max(1, fallbackDurationMs);
        const facing = payload.facingAngle;
        const source = { ...payload.source };
        let projectile: ProjectileLaunchPayload['projectile'];
        let trajectory: ProjectileLaunchPayload['trajectory'];
        switch (payload.weapon) {
            case 'cannon':
                projectile = 'cannonball';
                source.worldX += Math.cos(facing) * 28;
                source.worldY += -14 + Math.sin(facing) * 14;
                trajectory = {
                    kind: 'homing', durationMs: exactDuration,
                    ease: 'Quad.easeIn', trackTargetId: payload.target.id
                };
                break;
            case 'ballista':
                projectile = 'ballista-bolt';
                source.worldX += Math.cos(facing) * 14;
                source.worldY += -28 + Math.sin(facing) * 7;
                trajectory = {
                    kind: 'homing', durationMs: Math.max(1, exactDuration - 400),
                    ease: 'Linear', trackTargetId: payload.target.id
                };
                break;
            case 'xbow':
                projectile = 'xbow-bolt';
                source.worldY -= 24;
                trajectory = {
                    kind: 'homing', durationMs: exactDuration,
                    ease: 'Linear', trackTargetId: payload.target.id
                };
                break;
            case 'mortar':
                projectile = 'mortar-shell';
                source.worldY -= 35;
                trajectory = {
                    kind: 'parabolic', durationMs: exactDuration,
                    apexWorldY: (source.worldY + payload.targetPoint.worldY) / 2 - 350,
                    spinRadians: Math.PI * 4
                };
                break;
            case 'tesla':
                projectile = 'tesla-bolt';
                source.worldY -= 29;
                trajectory = {
                    kind: 'instant', durationMs: Math.max(120, exactDuration)
                };
                break;
            case 'spike-launcher': {
                projectile = 'spike-ball';
                source.worldY -= 40;
                const delay = Math.min(150, Math.max(0, exactDuration - 1));
                trajectory = {
                    kind: 'parabolic',
                    durationMs: Math.max(1, exactDuration - delay),
                    launchDelayMs: delay,
                    apexWorldY: (source.worldY + payload.targetPoint.worldY) / 2 - 60,
                    spinRadians: Math.PI * 2.5
                };
                break;
            }
            case 'prism':
            case 'dragons-breath':
                return null;
            default:
                return null;
        }
        return {
            projectileId: `fallback:${eventId}`,
            projectile,
            sourceEntity: payload.defense,
            targetEntity: payload.target,
            source,
            target: payload.targetPoint,
            level: Math.max(1, payload.defense.level || 1),
            rotation: facing,
            scale: 1,
            trajectory
        };
    }

    private handleTransition(transition: WorldBattleFrameTransition): void {
        for (const id of transition.removedTroopIds) {
            this.presentation.removeTroop(id);
            this.destroyCarrier(id);
        }
        for (const id of transition.newlyDestroyedBuildingIds) {
            this.presentation.removeBuilding(id);
            this.destroyBuildingCarrier(id);
            this.ensureWreck(id);
        }
        for (const id of transition.restoredBuildingIds) this.destroyWreck(id);
        if (transition.destroyedChanged) this.callbacks.onDestroyedBuildingsChanged?.(this);
    }

    private startTroopDeath(payload: EntityDeathPayload, eventT: number, seed: number): void {
        this.destroyTroopDeath(payload.entity.id);
        const carrier = this.scene.add.graphics();
        const point = this.placePoint(payload.at);
        carrier.setPosition(point.x, point.y);
        carrier.setDepth(isLargeTroopDeathType(payload.entity.type)
            ? depthForTroop(payload.at.gridX, payload.at.gridY, payload.entity.type)
            : depthForGroundEffect(payload.at.gridX, payload.at.gridY));
        carrier.setVisible(this.visible);
        const ground = isLargeTroopDeathType(payload.entity.type)
            ? undefined
            : this.scene.add.graphics();
        if (ground) {
            ground.setPosition(point.x, point.y + 8);
            ground.setDepth(depthForGroundDecal('shockfront'));
            ground.setVisible(this.visible);
            this.battleLayer.add([ground, carrier]);
        } else {
            this.battleLayer.add(carrier);
        }
        this.troopDeaths.set(payload.entity.id, {
            payload,
            startT: eventT,
            seed,
            carrier,
            ground
        });
    }

    private drawTroopDeaths(replayT: number): void {
        for (const [id, death] of this.troopDeaths) {
            const payload = death.payload;
            if (!isLargeTroopDeathType(payload.entity.type)) {
                this.drawCommonTroopDeath(id, death, replayT);
                continue;
            }
            const duration = Math.max(1, payload.animationMs);
            const age = replayT - death.startT;
            if (age < 0) continue;
            const remnant = age >= duration;
            if (remnant && !payload.leaveRemnant) {
                this.destroyTroopDeath(id);
                continue;
            }
            const rawPhase = Math.max(0, Math.min(0.999999, age / duration));
            const easedPhase = payload.entity.type === 'siegetower'
                ? rawPhase
                : rawPhase < 0.5
                    ? 4 * rawPhase * rawPhase * rawPhase
                    : 1 - Math.pow(-2 * rawPhase + 2, 3) / 2;
            const phase = remnant ? 1 : easedPhase;
            const siegePose = payload.style === 'siege-tower-collapse-parked'
                ? 'parked' as const
                : 'rolling' as const;
            death.carrier.clear().setRotation(0).setScale(1);
            death.carrier.setDepth(remnant
                ? depthForRubble(payload.at.gridX, payload.at.gridY, 1, 1)
                : depthForTroop(payload.at.gridX, payload.at.gridY, payload.entity.type));
            if (SpriteBank.syncTroopDeath(
                this.scene,
                death.carrier,
                payload.entity.type,
                payload.entity.owner,
                payload.entity.level,
                payload.facingAngle,
                phase,
                remnant,
                siegePose
            )) continue;
            SpriteBank.release(death.carrier);
            TroopDeathRenderer.drawWorld(
                death.carrier,
                payload.entity.type,
                payload.entity.owner,
                payload.entity.level,
                payload.facingAngle,
                phase,
                siegePose
            );
        }
    }

    private drawCommonTroopDeath(
        id: string,
        death: WorldBattleTroopDeathVisual,
        replayT: number
    ): void {
        const payload = death.payload;
        const age = replayT - death.startT;
        if (age < 0) return;
        const duration = payload.style === 'wall-breaker-detonation'
            || payload.style === 'clockwork-beetle-detonation'
            ? Math.max(650, payload.animationMs)
            : payload.style === 'phalanx-split'
                ? Math.max(560, payload.animationMs)
                : Math.max(420, payload.animationMs);
        if (age > duration) {
            this.destroyTroopDeath(id);
            return;
        }

        const progress = Math.max(0, Math.min(1, age / Math.max(1, duration)));
        death.carrier.clear().setRotation(0).setScale(1).setAlpha(1);
        death.carrier.setDepth(depthForGroundEffect(
            payload.at.gridX,
            payload.at.gridY
        ));
        SpriteBank.release(death.carrier);
        death.ground?.clear().setRotation(0).setScale(1).setAlpha(1);

        switch (payload.style) {
            case 'wall-breaker-detonation':
                this.drawDetonatorDeath(death, progress, false);
                break;
            case 'clockwork-beetle-detonation':
                this.drawDetonatorDeath(death, progress, true);
                break;
            case 'phalanx-split':
                this.drawPhalanxSplitDeath(death, progress);
                break;
            case 'standard-poof':
                this.drawStandardTroopPoof(death, progress);
                break;
            default:
                // Bespoke large styles are handled by the baked branch above.
                this.drawStandardTroopPoof(death, progress);
                break;
        }
    }

    private drawDetonatorDeath(
        death: WorldBattleTroopDeathVisual,
        progress: number,
        beetle: boolean
    ): void {
        const body = death.carrier;
        const ground = death.ground;
        const ringColor = beetle ? 0xc9973a : 0xff6600;
        const washColor = beetle ? 0x8a6420 : 0xff4400;
        const ringMax = beetle ? 22 : 30;
        const fade = 1 - progress;
        if (ground) {
            const radius = 10 + ringMax * Math.min(1, progress * 1.55);
            this.drawPixelRing(ground, 0, 0, radius, radius * 0.5,
                2, ringColor, 0.72 * fade);
            pixelEllipse(ground, 0, 0, radius, radius * 0.5,
                washColor, 0.16 * fade);
        }

        const flashProgress = Math.min(1, progress / 0.24);
        pixelEllipse(body, 0, -13, 6 + flashProgress * 16, 6 + flashProgress * 12,
            beetle ? 0xffe582 : 0xffff88, 0.9 * (1 - flashProgress));
        pixelEllipse(body, 0, -10, 8 + progress * 18, 7 + progress * 12,
            beetle ? 0xc07824 : 0xff4a19, 0.72 * fade);

        const count = beetle ? 10 : 14;
        for (let index = 0; index < count; index++) {
            const angle = this.replayNoise(death.seed, index * 4) * Math.PI * 2;
            const distance = 15 + this.replayNoise(death.seed, index * 4 + 1) * 35;
            const flight = Math.min(1, progress / 0.88);
            const x = Math.cos(angle) * distance * flight;
            const y = Math.sin(angle) * distance * 0.5 * flight
                - Math.sin(flight * Math.PI) * (18 + this.replayNoise(death.seed, index * 4 + 2) * 22);
            const color = beetle
                ? [0x7a5c20, 0xb08d3a, 0x555555][index % 3]
                : [0x5a3a1a, 0x8b6b4a, 0x777777, 0x993300][index % 4];
            if (beetle && index % 3 === 0) {
                pixelEllipse(body, x, y, 2.4, 2.4, color, 0.95 * fade);
                pixelRect(body, x - 0.7, y - 0.7, 1.4, 1.4, 0x3a2c10, 0.9 * fade);
            } else {
                pixelRect(body, x - 1.8, y - 1.2, 3.6, 2.4,
                    color, 0.95 * fade);
            }
        }

        for (let index = 0; index < 4; index++) {
            const delayed = Math.max(0, Math.min(1, progress * 1.35 - index * 0.08));
            const x = (this.replayNoise(death.seed ^ 0x51f15e, index) - 0.5) * 16;
            const y = -8 - delayed * (18 + index * 3);
            pixelRect(body, x - 3.5, y - 3.5, 7, 7,
                index < 2 ? 0x252525 : 0x4a4a4a,
                0.42 * (1 - delayed));
        }
    }

    private drawPhalanxSplitDeath(
        death: WorldBattleTroopDeathVisual,
        progress: number
    ): void {
        const body = death.carrier;
        const ground = death.ground;
        const fade = 1 - progress;
        if (ground) {
            const radius = 12 + progress * 26;
            pixelEllipse(ground, 0, 0, radius, radius * 0.5,
                0x777064, 0.3 * fade);
            this.drawPixelRing(ground, 0, 0, radius, radius * 0.5,
                1, 0xc9a961, 0.45 * fade);
        }
        const flash = Math.max(0, 1 - progress / 0.35);
        pixelEllipse(body, 0, -10, 8 + progress * 18, 5 + progress * 10,
            0xffc45f, 0.82 * flash);

        // Nine staggered flecks preserve the authored 3x3 split rhythm. The
        // actual Roman Warriors arrive through their own troop.spawn events.
        for (let index = 0; index < 9; index++) {
            const stagger = index * 0.035;
            const p = Math.max(0, Math.min(1, (progress - stagger) / Math.max(0.01, 0.72 - stagger)));
            if (p <= 0) continue;
            const col = index % 3 - 1;
            const row = Math.floor(index / 3) - 1;
            const x = col * (5 + 12 * p);
            const y = row * (2.5 + 6 * p) - Math.sin(p * Math.PI) * 9;
            pixelRect(body, x - 1.5, y - 3, 3, 5,
                index % 2 === 0 ? 0xe1c07b : 0x7d6750, 0.9 * (1 - p));
            pixelLine(body, x + 1.5, y - 4, x + 5, y - 8,
                1, 0xd8d8d8, 0.85 * (1 - p));
        }
    }

    private drawStandardTroopPoof(
        death: WorldBattleTroopDeathVisual,
        progress: number
    ): void {
        const body = death.carrier;
        const ground = death.ground;
        const [bright, bodyColor] = this.standardDeathPalette(death.payload.entity.type);
        const fade = 1 - progress;
        if (ground) {
            const radius = 5 + progress * 15;
            pixelEllipse(ground, 0, 0, radius, radius * 0.45,
                0x6f675b, 0.18 * fade);
        }
        const flash = Math.max(0, 1 - progress / 0.28);
        pixelRect(body, -5 - progress * 5, -13 - progress * 5,
            10 + progress * 10, 10 + progress * 10,
            0xffffff, 0.82 * flash);
        for (let index = 0; index < 8; index++) {
            const angle = (index / 8) * Math.PI * 2
                + (this.replayNoise(death.seed, index) - 0.5) * 0.24;
            const distance = (18 + this.replayNoise(death.seed, index + 12) * 10) * progress;
            const x = Math.cos(angle) * distance;
            const y = -8 + Math.sin(angle) * distance * 0.55
                - Math.sin(progress * Math.PI) * 12;
            pixelRect(body, x - 2, y - 2, 4, 4,
                index % 2 === 0 ? bright : bodyColor, 0.9 * fade);
        }
        const smokeProgress = Math.max(0, Math.min(1, progress * 1.15));
        pixelRect(body, -7 - smokeProgress * 4, -9 - smokeProgress * 20,
            14 + smokeProgress * 8, 14 + smokeProgress * 8,
            0x666666, 0.42 * (1 - smokeProgress));
    }

    private standardDeathPalette(type: string): readonly [number, number] {
        switch (type) {
            case 'warrior':
            case 'romanwarrior': return [0xffdf55, 0xc78335];
            case 'archer': return [0x54d8ff, 0x386c94];
            case 'physicianscart': return [0xe9f0dc, 0x65b77b];
            case 'goblinplunderer': return [0xa6e65f, 0x8e5d2d];
            case 'stormmage': return [0x71efff, 0x315a9c];
            case 'necromancer':
            case 'skeleton': return [0xcaa8ff, 0x6f3aa8];
            case 'ornithopter':
            case 'mobilemortar':
            case 'ram': return [0xffb24f, 0x68513a];
            default: return [0xffb65f, 0x9a6840];
        }
    }

    private destroyTroopDeath(id: string): void {
        const death = this.troopDeaths.get(id);
        if (!death) return;
        death.carrier.destroy();
        death.ground?.destroy();
        this.troopDeaths.delete(id);
    }

    private startBuildingCollapse(
        id: string,
        payload: BuildingDestroyPayload,
        eventT: number,
        seed: number
    ): void {
        const previous = this.buildingCollapses.get(id);
        previous?.body.destroy();
        previous?.ground.destroy();
        const at = this.placePoint(payload.at);
        const body = this.scene.add.graphics();
        const ground = this.scene.add.graphics();
        body.setPosition(at.x, at.y);
        ground.setPosition(at.x, at.y + 20);
        body.setDepth(depthForGroundEffect(payload.at.gridX, payload.at.gridY));
        ground.setDepth(depthForGroundDecal('shockfront'));
        body.setVisible(this.visible);
        ground.setVisible(this.visible);
        this.battleLayer.add([ground, body]);
        this.buildingCollapses.set(id, { id, payload, startT: eventT, seed, body, ground });
    }

    private drawBuildingCollapses(replayT: number): void {
        for (const [id, collapse] of this.buildingCollapses) {
            const duration = collapse.payload.style === 'town-hall' ? 900 : 650;
            const age = replayT - collapse.startT;
            if (age < 0) continue;
            if (age > duration) {
                collapse.body.destroy();
                collapse.ground.destroy();
                this.buildingCollapses.delete(id);
                continue;
            }
            const progress = Math.max(0, Math.min(1, age / duration));
            const fade = 1 - progress;
            const size = Math.max(
                collapse.payload.footprint.width,
                collapse.payload.footprint.height
            );
            const body = collapse.body.clear().setRotation(0).setScale(1).setAlpha(1);
            const ground = collapse.ground.clear().setRotation(0).setScale(1).setAlpha(1);
            SpriteBank.release(body);
            const radius = 7 + progress * (12 + size * 7);
            const style = collapse.payload.style;
            const ringColor = style === 'tesla-defense' ? 0x55dfff
                : style === 'town-hall' ? 0xffa03c
                    : style === 'defense' ? 0xe0b05c
                        : 0x8b7355;
            this.drawPixelRing(ground, 0, 0, radius, radius * 0.5,
                style === 'town-hall' ? 3 : 2, ringColor, 0.58 * fade);
            pixelEllipse(ground, 0, 0, radius, radius * 0.5,
                style === 'tesla-defense' ? 0x244d5b : 0x6b5344, 0.13 * fade);

            const flashProgress = Math.min(1, progress / (style === 'town-hall' ? 0.24 : 0.18));
            pixelEllipse(body, 0, -2, 8 + size * 4 + flashProgress * 12,
                6 + size * 3 + flashProgress * 9,
                style === 'tesla-defense' ? 0xcdf8ff : 0xffffcc,
                0.82 * (1 - flashProgress));

            const count = style === 'town-hall' ? 24
                : style === 'tesla-defense' ? 14
                    : style === 'defense' ? 12
                        : 9;
            for (let index = 0; index < count; index++) {
                const angle = this.replayNoise(collapse.seed, index * 4) * Math.PI * 2;
                const distance = (14 + this.replayNoise(collapse.seed, index * 4 + 1)
                    * (22 + size * 11)) * progress;
                const x = Math.cos(angle) * distance;
                const y = Math.sin(angle) * distance * 0.5
                    - Math.sin(progress * Math.PI)
                    * (18 + this.replayNoise(collapse.seed, index * 4 + 2) * 28 * size);
                const palette = style === 'tesla-defense'
                    ? [0x87edff, 0x8f9ba0, 0x376779]
                    : style === 'town-hall'
                        ? [0xffd35a, 0xff6a25, 0x8b7355, 0x5a3a2a]
                        : style === 'defense'
                            ? [0xffc45f, 0x777777, 0x5a4a3a]
                            : [0x9b8365, 0x6b5344, 0x4a3a2a];
                const color = palette[index % palette.length];
                if (style === 'tesla-defense' || (style === 'defense' && index % 3 === 0)) {
                    const length = 3 + this.replayNoise(collapse.seed, index * 4 + 3) * 8;
                    pixelLine(body, x, y, x + Math.cos(angle) * length,
                        y + Math.sin(angle) * length, 1, color, 0.9 * fade);
                } else {
                    const chunk = 2 + this.replayNoise(collapse.seed, index * 4 + 3) * 3;
                    pixelRect(body, x - chunk / 2, y - chunk / 2,
                        chunk, chunk, color, 0.9 * fade);
                }
            }

            if (style === 'tesla-defense') {
                for (let index = 0; index < 4; index++) {
                    const angle = index * Math.PI / 2 + progress * 2.4;
                    this.drawJaggedLightning(body, 0, -5,
                        Math.cos(angle) * (12 + progress * 18),
                        -5 + Math.sin(angle) * (8 + progress * 12),
                        collapse.seed, index + Math.floor(replayT / 55),
                        0x87edff, 1, 0.72 * fade);
                }
            } else if (style === 'town-hall') {
                for (let index = 0; index < 7; index++) {
                    const x = (this.replayNoise(collapse.seed ^ 0xa771, index) - 0.5) * 44;
                    const lift = Math.max(0, Math.min(1, progress * 1.35 - index * 0.035));
                    pixelRect(body, x - 3, 2 - lift * (28 + index * 4), 6, 9,
                        index % 2 === 0 ? 0xff6a25 : 0xffc342,
                        0.78 * (1 - lift));
                }
            }
        }
    }

    private ensureWreck(id: string): void {
        if (this.wrecks.has(id)) return;
        const meta = this.buildingMeta.get(id);
        if (!meta) return;
        const body = this.scene.add.graphics();
        const ground = this.scene.add.graphics();
        body.setDepth(depthForRubble(meta.gridX, meta.gridY, meta.width, meta.height));
        ground.setDepth(depthForGroundDecal('crater'));
        body.setVisible(this.visible);
        ground.setVisible(this.visible);
        this.battleLayer.add([ground, body]);
        const gridX = this.placement.gridOffsetX + meta.gridX;
        const gridY = this.placement.gridOffsetY + meta.gridY;
        if (!SpriteBank.syncWreck(
            this.scene,
            body,
            ground,
            meta.type,
            meta.level,
            gridX,
            gridY,
            meta.width,
            meta.height
        )) {
            WreckRenderer.drawWreck(
                body,
                gridX,
                gridY,
                meta.width,
                meta.height,
                meta.type,
                meta.level,
                0,
                1,
                ground
            );
        }
        this.wrecks.set(id, { body, ground });
    }

    private destroyWreck(id: string): void {
        const wreck = this.wrecks.get(id);
        if (!wreck) return;
        wreck.body.destroy();
        wreck.ground.destroy();
        this.wrecks.delete(id);
    }

    private indexImpactTimes(chunks: readonly ReplayV2Chunk<ReplayFrameSnapshot>[]): void {
        for (const chunk of chunks) {
            if (chunk.kind !== 'event' || chunk.event.type !== 'combat.damage') continue;
            const linked = chunk.event.payload.linkedPresentationEventId;
            if (!linked) continue;
            const current = this.impactTimeByEventId.get(linked);
            if (current === undefined || chunk.t < current) this.impactTimeByEventId.set(linked, chunk.t);
        }
    }

    private addImpact(
        id: string,
        at: ReplayPresentationPoint,
        startT: number,
        durationMs: number,
        color: number,
        radius: number
    ): void {
        this.impactPulses.push({ id, at, startT, durationMs, color, radius });
        while (this.impactPulses.length > 96) this.impactPulses.shift();
    }

    private render(
        sample: ReplayTimelineSample<ReplayFrameSnapshot>,
        replayT: number,
        deltaMs: number
    ): void {
        const liveIds = new Set(this.model.troops.keys());
        for (const id of [...this.carriers.keys()]) {
            if (!liveIds.has(id)) this.destroyCarrier(id);
        }
        this.sampledTroops.clear();
        for (const troop of this.model.troops.values()) {
            if (!Object.prototype.hasOwnProperty.call(TROOP_DEFINITIONS, troop.type)) continue;
            const sampled = sampleWorldBattleTroop(
                troop,
                sample,
                this.carrierFacing.get(troop.id),
                deltaMs
            );
            const facing = sampled.facingAngle ?? this.carrierFacing.get(troop.id) ?? 0;
            sampled.facingAngle = facing;
            this.carrierFacing.set(troop.id, facing);
            this.sampledTroops.set(troop.id, sampled);
        }

        const nextFigureTick = figureTick(replayT);
        const redrawFigures = nextFigureTick !== this.lastFigureTick;
        if (redrawFigures) this.lastFigureTick = nextFigureTick;

        const liveBuildingIds = new Set<string>();
        for (const [id, state] of this.model.buildings) {
            if (!state.isDestroyed && this.buildingMeta.has(id)) liveBuildingIds.add(id);
        }
        for (const id of [...this.buildingCarriers.keys()]) {
            if (!liveBuildingIds.has(id)) this.destroyBuildingCarrier(id);
        }
        for (const id of liveBuildingIds) {
            const meta = this.buildingMeta.get(id);
            const state = this.model.buildings.get(id);
            if (!meta || !state) continue;
            let carrier = this.buildingCarriers.get(id);
            const created = !carrier;
            if (!carrier) {
                carrier = this.scene.add.graphics();
                carrier.setVisible(this.visible);
                this.battleLayer.add(carrier);
                this.buildingCarriers.set(id, carrier);
            }
            // DepthSystem receives plot-local coordinates on purpose. The
            // battle Layer owns the plot's root depth, and the local call
            // preserves the exact same center-anchor/sub-band math as a full
            // MainScene without allowing this postcard to cross its neighbor.
            carrier.setDepth(depthForBuilding(meta.gridX, meta.gridY, meta.type));
            if (!redrawFigures && !created) continue;

            carrier.clear();
            const wallNeighbors = this.wallNeighbors(meta);
            const wallTag = wallNeighbors ? SpriteBank.wallTag(wallNeighbors) : undefined;
            const visualState = {
                id: meta.id,
                type: meta.type,
                gridX: this.placement.gridOffsetX + meta.gridX,
                gridY: this.placement.gridOffsetY + meta.gridY,
                level: meta.level,
                health: state.health,
                maxHealth: state.maxHealth,
                owner: 'ENEMY',
                ballistaAngle: meta.ballistaAngle,
                lastFireTime: meta.lastFireTime,
                teslaCharging: meta.teslaCharging,
                teslaChargeStart: meta.teslaChargeStart,
                teslaCharged: meta.teslaCharged,
                // Deployables (dragons_breath) mirror MainScene's PROXIMITY
                // wake/sleep driver on the playback clock and this tick's
                // sampled troops: risen while raiders are near, sunk back
                // into the dormant idol whenever the wake radius stays
                // empty — mid-battle included.
                deploy01: meta.type === 'dragons_breath'
                    ? this.dragonDeploy01(meta, replayT)
                    : 0
            };
            const gx = this.placement.gridOffsetX + meta.gridX;
            const gy = this.placement.gridOffsetY + meta.gridY;
            if (SpriteBank.syncBuilding(
                this.scene,
                carrier,
                gx,
                gy,
                meta.type,
                meta.level,
                1,
                null,
                visualState,
                replayT,
                { wallTag, jukeboxPlaying: false }
            )) continue;

            SpriteBank.release(carrier);
            drawBuildingVisual({
                graphics: carrier,
                gridX: gx,
                gridY: gy,
                type: meta.type,
                building: visualState,
                // Every non-wall base is already in the ground postcard. A
                // vector-fallback wall remains fully dynamic, matching the
                // SpriteBank wall body's attached ground shadow.
                skipBase: meta.type !== 'wall',
                onlyBase: false,
                time: replayT,
                jukeboxPlaying: false,
                wallNeighbors,
                recoverFromRendererError: true
            });
        }

        for (const troop of this.model.troops.values()) {
            if (!Object.prototype.hasOwnProperty.call(TROOP_DEFINITIONS, troop.type)) continue;
            const type = troop.type as TroopType;
            let carrier = this.carriers.get(troop.id);
            if (!carrier) {
                carrier = this.scene.add.graphics();
                carrier.setVisible(this.visible);
                this.battleLayer.add(carrier);
                this.carriers.set(troop.id, carrier);
            }
            const sampled = this.sampledTroops.get(troop.id);
            if (!sampled) continue;
            const facing = sampled.facingAngle ?? this.carrierFacing.get(troop.id) ?? 0;
            const pos = IsoUtils.cartToIso(
                this.placement.gridOffsetX + sampled.gridX,
                this.placement.gridOffsetY + sampled.gridY
            );
            carrier.setPosition(pos.x, pos.y + sampled.visualOffsetY);
            carrier.setDepth(depthForTroop(sampled.gridX, sampled.gridY, type));
            if (redrawFigures) {
                const stats = getTroopStats(type, sampled.level || 1);
                const attackDelay = stats.attackDelay ?? 1_000;
                const pose = worldBattleTroopPoseAt(sampled, replayT);
                let attackAge = sampled.lastAttackT === undefined ? -1 : replayT - sampled.lastAttackT;
                if (attackAge < 0 || attackAge > attackDelay + 600) attackAge = -1;
                carrier.clear();
                const baked = type === 'siegetower' && pose.parked01 >= 0.999
                    ? SpriteBank.syncTroopPose(
                        this.scene,
                        carrier,
                        type,
                        sampled.owner,
                        sampled.level || 1,
                        facing,
                        'deactivated'
                    )
                    : SpriteBank.syncTroop(this.scene, {
                    id: sampled.id,
                    type,
                    owner: sampled.owner,
                    level: sampled.level,
                    gameObject: carrier,
                    facingAngle: facing,
                    lastAttackTime: sampled.lastAttackT,
                    attackDelay,
                    slamOffset: pose.slamOffset,
                    phalanxSpearOffset: pose.phalanxSpearOffset,
                    parked01: pose.parked01,
                    tankSpin01: pose.tankSpin01
                }, sampled.moving, attackAge, replayT);
                if (!baked) {
                    SpriteBank.release(carrier);
                    TroopRenderer.drawWorldTroopVisual(
                        carrier,
                        type,
                        sampled.owner,
                        facing,
                        sampled.moving,
                        pose.slamOffset,
                        pose.mortarRecoil,
                        pose.parked01,
                        pose.phalanxSpearOffset,
                        sampled.level,
                        replayT,
                        attackAge,
                        attackDelay,
                        pose.tankSpin01
                    );
                }
            }
        }

        this.presentation.prune(replayT);
        this.groundOverlay.clear();
        this.drawPresentationGroundFx(replayT);
        this.groundOverlay.setVisible(this.visible);
        this.drawAttackFx(replayT);
        this.healthOverlay.clear();
        this.drawHealthBars();
        this.healthOverlay.setVisible(this.visible);
    }

    private drawPresentationGroundFx(replayT: number): void {
        for (const zone of this.presentation.spikeZones.values()) {
            if (replayT < zone.startT || replayT > zone.endT + 500) continue;
            const at = this.placePoint(zone.at);
            const fade = replayT <= zone.endT
                ? Math.min(1, (replayT - zone.startT) / 120)
                : Math.max(0, 1 - (replayT - zone.endT) / 500);
            const footprintScale = Math.max(0.85, zone.radiusTiles / 2);
            pixelEllipse(this.groundOverlay, at.x, at.y + 3,
                27.5 * footprintScale, 14 * footprintScale, 0x3a3020, 0.48 * fade);
            for (let index = 0; index < 12; index++) {
                const angle = (index / 12) * Math.PI * 2
                    + this.replayNoise(zone.seed, index * 2) * 0.45;
                const distance = 5 + this.replayNoise(zone.seed, index * 2 + 1)
                    * 22 * footprintScale;
                const x = at.x + Math.cos(angle) * distance;
                const y = at.y + Math.sin(angle) * distance * 0.5;
                pixelLine(this.groundOverlay, x - 3, y + 1, x + 3, y - 1,
                    1, 0x666666, fade);
                pixelLine(this.groundOverlay, x, y + 2, x, y - 5,
                    1, index % 3 === 0 ? 0x9b9b9b : 0x707070, fade);
            }
        }

        for (const frozen of this.presentation.frozenBuildings.values()) {
            if (replayT < frozen.startT || replayT > frozen.endT) continue;
            const at = this.placePoint(frozen.at);
            const remaining = Math.min(1, (frozen.endT - replayT) / 450);
            this.drawPixelRing(this.groundOverlay, at.x, at.y + 2,
                15, 7.5, 1, 0x8edfff, 0.34 * remaining);
        }

        this.drawTimedPresentationPrimitives(this.groundOverlay, replayT, true);
    }

    private drawStatefulAttackFx(replayT: number, activeCarriers: Set<string>): void {
        this.drawAirPresentationPrimitives(replayT, activeCarriers);

        for (const charge of this.presentation.teslaCharges.values()) {
            if (replayT < charge.startT || replayT > charge.endT) continue;
            const sourcePoint = this.pointForEntity(charge.defense);
            if (!sourcePoint) continue;
            const source = this.placePoint(sourcePoint);
            const progress = Math.max(0, Math.min(1,
                (replayT - charge.startT) / Math.max(1, charge.endT - charge.startT)));
            const radius = charge.phase === 'charging' ? 5 + progress * 12 : 17 - progress * 5;
            const ringKey = `state:tesla-ring:${charge.defense.id}`;
            const ring = this.airCarrier(ringKey,
                this.buildingDressingDepth(charge.defense, sourcePoint, 0.35));
            activeCarriers.add(ringKey);
            ring.clear().setPosition(source.x, source.y - 29).setScale(1).setRotation(0).setAlpha(1);
            SpriteBank.release(ring);
            this.drawPixelRing(ring, 0, 0, radius, radius,
                2, 0x87edff, 0.35 + 0.45 * (1 - progress));

            const targetPoint = charge.target ? this.pointForEntity(charge.target) : undefined;
            if (charge.phase === 'charging' && targetPoint) {
                const target = this.placePoint(targetPoint);
                const linkKey = `state:tesla-link:${charge.defense.id}`;
                const link = this.airCarrier(linkKey, depthForProjectile(
                    (sourcePoint.gridX + targetPoint.gridX) / 2,
                    (sourcePoint.gridY + targetPoint.gridY) / 2
                ));
                activeCarriers.add(linkKey);
                link.clear().setPosition(0, 0).setScale(1).setRotation(0).setAlpha(1);
                SpriteBank.release(link);
                this.drawJaggedLightning(link,
                    source.x, source.y - 29, target.x, target.y - 10,
                    charge.seed, Math.floor(replayT / 80), 0x87edff, 1, 0.38 + progress * 0.35);
            }
        }

        for (const frozen of this.presentation.frozenBuildings.values()) {
            if (replayT < frozen.startT || replayT > frozen.endT) continue;
            const point = this.pointForEntity(frozen.building) ?? frozen.at;
            const at = this.placePoint(point);
            const key = `state:freeze:${frozen.building.id}`;
            const carrier = this.airCarrier(key,
                this.buildingDressingDepth(frozen.building, point, 0.4));
            activeCarriers.add(key);
            carrier.clear().setPosition(at.x, at.y).setScale(1).setRotation(0).setAlpha(1);
            SpriteBank.release(carrier);
            const fade = Math.min(1, (frozen.endT - replayT) / 350);
            for (let index = 0; index < 7; index++) {
                const angle = (index / 7) * Math.PI * 2;
                const radius = 10 + this.replayNoise(frozen.seed, index) * 9;
                const x = Math.cos(angle) * radius;
                const y = -8 + Math.sin(angle) * radius * 0.55;
                pixelLine(carrier, x, y + 5, x + Math.cos(angle) * 4, y - 5,
                    1, index % 2 === 0 ? 0xd8f7ff : 0x86dff5, 0.72 * fade);
            }
        }

        for (const beam of this.presentation.prismBeams.values()) {
            if (replayT < beam.startT || replayT > beam.endT) continue;
            const sourcePoint = this.pointForEntity(beam.defense) ?? beam.source;
            const targetPoint = beam.target ? this.pointForEntity(beam.target) : beam.targetPoint;
            if (!targetPoint) continue;
            const source = this.placePoint(sourcePoint);
            const target = this.placePoint(targetPoint);
            const key = `state:prism:${beam.defense.id}`;
            const carrier = this.airCarrier(key, depthForProjectile(
                (sourcePoint.gridX + targetPoint.gridX) / 2,
                (sourcePoint.gridY + targetPoint.gridY) / 2
            ));
            activeCarriers.add(key);
            carrier.clear().setPosition(0, 0).setScale(1).setRotation(0).setAlpha(1);
            SpriteBank.release(carrier);
            const hue = (beam.hue + (replayT - beam.startT) / 10) % 360;
            const color = this.hslColor(hue, 1, 0.52);
            pixelLine(carrier, source.x, source.y - 55, target.x, target.y - 10,
                3, this.hslColor(hue, 1, 0.72), 0.32);
            pixelLine(carrier, source.x, source.y - 55, target.x, target.y - 10,
                2, color, 0.92);
            pixelLine(carrier, source.x, source.y - 55, target.x, target.y - 10,
                1, 0xffffff, 1);
            const pulse = 5 + 3 * (0.5 + 0.5 * Math.sin(replayT / 35));
            pixelEllipse(carrier, target.x, target.y - 10, pulse, pulse,
                color, 0.5);
        }

        for (const rocket of this.presentation.dragonRockets) {
            if (replayT < rocket.startT || replayT > rocket.endT + 420) continue;
            const source = this.placePoint(rocket.source);
            const target = this.placePoint(rocket.target);
            const key = `state:dragon:${rocket.id}`;
            if (replayT >= rocket.endT) {
                const carrier = this.airCarrier(key,
                    depthForGroundEffect(rocket.target.gridX, rocket.target.gridY));
                activeCarriers.add(key);
                carrier.clear().setPosition(target.x, target.y).setScale(1).setRotation(0).setAlpha(1);
                SpriteBank.release(carrier);
                const impactAge = replayT - rocket.endT;
                const p = Math.max(0, Math.min(1, impactAge / 420));
                pixelEllipse(carrier, 0, 0,
                    4 + 20 * p, 2 + 10 * p, 0xff7b32, 0.8 * (1 - p));
                continue;
            }
            const duration = Math.max(1, rocket.endT - rocket.startT);
            const age = replayT - rocket.startT;
            const lift01 = Math.min(1, age / 230);
            let x: number;
            let y: number;
            let previousX: number;
            let previousY: number;
            let groundProgress = 0;
            if (age <= 230) {
                const lift = lift01 * lift01;
                const lean = (this.replayNoise(rocket.seed, 0) - 0.5) * 18;
                x = source.x + lean * lift;
                y = source.y - 52 * lift;
                previousX = source.x + lean * Math.max(0, lift - 0.12);
                previousY = source.y - 52 * Math.max(0, lift - 0.12);
            } else {
                groundProgress = Math.max(0, Math.min(1,
                    (age - 230) / Math.max(1, duration - 230)));
                const startX = source.x + (this.replayNoise(rocket.seed, 0) - 0.5) * 18;
                const startY = source.y - 52;
                const wobble = Math.sin(groundProgress * Math.PI * 5
                    + this.replayNoise(rocket.seed, 1) * Math.PI * 2)
                    * 20 * (1 - groundProgress);
                const dx = target.x - startX;
                const dy = target.y - startY;
                const length = Math.max(1, Math.hypot(dx, dy));
                const px = -dy / length;
                const py = dx / length;
                const arc = -35 * Math.sin(groundProgress * Math.PI);
                x = startX + dx * groundProgress + px * wobble;
                y = startY + dy * groundProgress + py * wobble + arc;
                const prior = Math.max(0, groundProgress - 0.04);
                const priorWobble = Math.sin(prior * Math.PI * 5
                    + this.replayNoise(rocket.seed, 1) * Math.PI * 2)
                    * 20 * (1 - prior);
                previousX = startX + dx * prior + px * priorWobble;
                previousY = startY + dy * prior + py * priorWobble
                    - 35 * Math.sin(prior * Math.PI);
            }
            const groundX = rocket.source.gridX
                + (rocket.target.gridX - rocket.source.gridX) * groundProgress;
            const groundY = rocket.source.gridY
                + (rocket.target.gridY - rocket.source.gridY) * groundProgress;
            const carrier = this.airCarrier(key, depthForProjectile(groundX, groundY));
            activeCarriers.add(key);
            carrier.clear().setPosition(x, y).setScale(1).setRotation(0).setAlpha(1);
            pixelLine(carrier, previousX - x, previousY - y, 0, 0,
                2, 0xffa14a, 0.72);
            const angle = Math.atan2(y - previousY, x - previousX);
            const tau = Math.PI * 2;
            const angleIndex = Math.round((((angle % tau) + tau) % tau) / (tau / 16)) % 16;
            const baked = SpriteBank.syncFigure(
                this.scene,
                carrier,
                'dragon_rocket',
                `l1_a${String(angleIndex).padStart(2, '0')}`,
                'idle',
                0,
                false,
                { kind: 'projectiles' }
            );
            if (!baked) {
                SpriteBank.release(carrier);
                carrier.setRotation(angle);
                ProjectileRenderer.drawDragonRocket(carrier, 1, 0);
            }
        }
    }

    /** PROXIMITY wake/sleep mirror of MainScene's dragons_breath deploy
     * driver: rises (1100 ms cubic-out) while any live raider stands inside
     * (fire range + 3 tiles) of the footprint center, sinks back (900 ms)
     * once the radius has been empty for the 2500 ms grace — a dormant idol
     * otherwise, mid-battle included. Playback-clock restarts reset the
     * anchors (same stale-future-stamp guard as MainScene). */
    private dragonDeploy01(meta: BuildingVisualMeta, replayT: number): number {
        const def = getBuildingStats(meta.type, meta.level);
        const wakeCX = meta.gridX + (def.width ?? 3) / 2;
        const wakeCY = meta.gridY + (def.height ?? 3) / 2;
        const wakeR = (def.range ?? 13) + 3;
        let threat = false;
        for (const troop of this.model.troops.values()) {
            if (troop.health <= 0) continue;
            const at = this.sampledTroops.get(troop.id) ?? troop;
            if (Math.hypot(at.gridX - wakeCX, at.gridY - wakeCY) <= wakeR) { threat = true; break; }
        }
        let state = this.dragonDeploy.get(meta.id);
        if (!state || state.anchorT > replayT
            || (state.threatT !== undefined && state.threatT > replayT)) {
            state = { anchorT: replayT, from: 0, target: 0 };
            this.dragonDeploy.set(meta.id, state);
        }
        if (threat) state.threatT = replayT;
        const wake = threat
            || (state.threatT !== undefined && replayT - state.threatT < 2500);
        const target: 0 | 1 = wake ? 1 : 0;
        if (state.target !== target) {
            // Freeze the current eased value as the new leg's start.
            const u0 = Math.min(1, Math.max(0, (replayT - state.anchorT) / (state.target === 1 ? 1100 : 900)));
            state.from = state.from + (state.target - state.from) * (1 - Math.pow(1 - u0, 3));
            state.target = target;
            state.anchorT = replayT;
        }
        const dur = target === 1 ? 1100 : 900;
        const u = Math.min(1, Math.max(0, (replayT - state.anchorT) / dur));
        return state.from + (state.target - state.from) * (1 - Math.pow(1 - u, 3));
    }

    private drawAirPresentationPrimitives(
        replayT: number,
        activeCarriers: Set<string>
    ): void {
        for (const ring of this.presentation.rings) {
            if (ring.ground || replayT < ring.startT || replayT > ring.endT) continue;
            const progress = (replayT - ring.startT) / Math.max(1, ring.endT - ring.startT);
            const at = this.placePoint(ring.at);
            const key = `air:ring:${ring.id}`;
            const carrier = this.airCarrier(key,
                depthForGroundEffect(ring.at.gridX, ring.at.gridY));
            activeCarriers.add(key);
            carrier.clear().setPosition(at.x, at.y).setScale(1).setRotation(0).setAlpha(1);
            SpriteBank.release(carrier);
            const radius = ring.radiusFrom + (ring.radiusTo - ring.radiusFrom) * progress;
            const thickness = Math.max(1, Math.round(
                ring.thicknessFrom + (ring.thicknessTo - ring.thicknessFrom) * progress));
            this.drawPixelRing(carrier, 0, 0, radius, radius * ring.squash,
                thickness, ring.color, ring.alpha * (1 - progress));
        }
        for (const flash of this.presentation.flashes) {
            if (flash.ground || replayT < flash.startT || replayT > flash.endT) continue;
            const progress = (replayT - flash.startT) / Math.max(1, flash.endT - flash.startT);
            const at = this.placePoint(flash.at);
            const key = `air:flash:${flash.id}`;
            const carrier = this.airCarrier(key,
                depthForGroundEffect(flash.at.gridX, flash.at.gridY));
            activeCarriers.add(key);
            carrier.clear().setPosition(at.x, at.y).setScale(1).setRotation(0).setAlpha(1);
            SpriteBank.release(carrier);
            const scale = 1 + (flash.scaleTo - 1) * progress;
            pixelEllipse(carrier, 0, 0,
                flash.radius * scale, flash.radius * flash.squash * scale,
                flash.color, flash.alpha * (1 - progress));
        }
        for (const burst of this.presentation.bursts) {
            if (burst.ground || replayT < burst.startT || replayT > burst.endT) continue;
            const progress = (replayT - burst.startT) / Math.max(1, burst.endT - burst.startT);
            const at = this.placePoint(burst.at);
            const key = `air:burst:${burst.id}`;
            const carrier = this.airCarrier(key,
                depthForGroundEffect(burst.at.gridX, burst.at.gridY));
            activeCarriers.add(key);
            carrier.clear().setPosition(at.x, at.y).setScale(1).setRotation(0).setAlpha(1);
            SpriteBank.release(carrier);
            for (let index = 0; index < Math.min(48, burst.count); index++) {
                const angle = this.replayNoise(burst.seed, index * 4) * Math.PI * 2;
                const radial = this.replayNoise(burst.seed, index * 4 + 1);
                const x = (this.replayNoise(burst.seed, index * 4 + 2) - 0.5)
                    * burst.spreadX * progress + Math.cos(angle) * burst.radial * radial * progress;
                const y = (this.replayNoise(burst.seed, index * 4 + 3) - 0.5)
                    * burst.spreadY * progress + Math.sin(angle) * burst.radial * radial * progress
                    - burst.up * Math.sin(progress * Math.PI);
                const radius = Math.max(1.2, burst.radius * (1 - progress * 0.55));
                const color = burst.colors[index % Math.max(1, burst.colors.length)] ?? 0xffffff;
                if (burst.square) {
                    pixelRect(carrier, x - radius, y - radius, radius * 2, radius * 2,
                        color, burst.alpha * (1 - progress));
                } else {
                    pixelEllipse(carrier, x, y, radius, radius,
                        color, burst.alpha * (1 - progress));
                }
            }
        }
        for (const lightning of this.presentation.lightning) {
            if (replayT < lightning.startT || replayT > lightning.endT) continue;
            const fade = 1 - (replayT - lightning.startT)
                / Math.max(1, lightning.endT - lightning.startT);
            for (let index = 1; index < lightning.points.length; index++) {
                const fromPoint = lightning.points[index - 1];
                const toPoint = lightning.points[index];
                const from = this.placePoint(fromPoint);
                const to = this.placePoint(toPoint);
                const key = `air:lightning:${lightning.id}:${index}`;
                const carrier = this.airCarrier(key, depthForProjectile(
                    (fromPoint.gridX + toPoint.gridX) / 2,
                    (fromPoint.gridY + toPoint.gridY) / 2
                ));
                activeCarriers.add(key);
                carrier.clear().setPosition(0, 0).setScale(1).setRotation(0).setAlpha(1);
                SpriteBank.release(carrier);
                this.drawJaggedLightning(carrier, from.x, from.y - 10, to.x, to.y - 10,
                    lightning.seed, index + Math.floor(replayT / 55), lightning.color,
                    Math.max(1, Math.round(lightning.width)), lightning.alpha * fade);
            }
        }
    }

    private buildingDressingDepth(
        entity: ReplayEntityRef,
        fallback: ReplayPresentationPoint,
        bias: number
    ): number {
        if (entity.kind === 'building') {
            const meta = this.buildingMeta.get(entity.id);
            if (meta) return depthForBuilding(meta.gridX, meta.gridY, meta.type) + bias;
        }
        return depthForGroundEffect(fallback.gridX, fallback.gridY);
    }

    private drawTimedPresentationPrimitives(
        graphics: Phaser.GameObjects.Graphics,
        replayT: number,
        ground: boolean
    ): void {
        for (const ring of this.presentation.rings) {
            if (ring.ground !== ground || replayT < ring.startT || replayT > ring.endT) continue;
            const progress = (replayT - ring.startT) / Math.max(1, ring.endT - ring.startT);
            const radius = ring.radiusFrom + (ring.radiusTo - ring.radiusFrom) * progress;
            const thickness = Math.max(1, Math.round(
                ring.thicknessFrom + (ring.thicknessTo - ring.thicknessFrom) * progress));
            const at = this.placePoint(ring.at);
            this.drawPixelRing(graphics, at.x, at.y, radius, radius * ring.squash,
                thickness, ring.color, ring.alpha * (1 - progress));
        }
        for (const flash of this.presentation.flashes) {
            if (flash.ground !== ground || replayT < flash.startT || replayT > flash.endT) continue;
            const progress = (replayT - flash.startT) / Math.max(1, flash.endT - flash.startT);
            const scale = 1 + (flash.scaleTo - 1) * progress;
            const at = this.placePoint(flash.at);
            pixelEllipse(graphics, at.x, at.y,
                flash.radius * scale, flash.radius * flash.squash * scale,
                flash.color, flash.alpha * (1 - progress));
        }
        for (const burst of this.presentation.bursts) {
            if (burst.ground !== ground || replayT < burst.startT || replayT > burst.endT) continue;
            const progress = (replayT - burst.startT) / Math.max(1, burst.endT - burst.startT);
            const at = this.placePoint(burst.at);
            for (let index = 0; index < Math.min(48, burst.count); index++) {
                const angle = this.replayNoise(burst.seed, index * 4) * Math.PI * 2;
                const radial = this.replayNoise(burst.seed, index * 4 + 1);
                const x = at.x
                    + (this.replayNoise(burst.seed, index * 4 + 2) - 0.5) * burst.spreadX * progress
                    + Math.cos(angle) * burst.radial * radial * progress;
                const y = at.y
                    + (this.replayNoise(burst.seed, index * 4 + 3) - 0.5) * burst.spreadY * progress
                    + Math.sin(angle) * burst.radial * radial * progress
                    - burst.up * Math.sin(progress * Math.PI);
                const radius = Math.max(1.2, burst.radius * (1 - progress * 0.55));
                const color = burst.colors[index % Math.max(1, burst.colors.length)] ?? 0xffffff;
                if (burst.square) {
                    pixelRect(graphics, x - radius, y - radius, radius * 2, radius * 2,
                        color, burst.alpha * (1 - progress));
                } else {
                    pixelEllipse(graphics, x, y, radius, radius,
                        color, burst.alpha * (1 - progress));
                }
            }
        }
        if (ground) return;
        for (const lightning of this.presentation.lightning) {
            if (replayT < lightning.startT || replayT > lightning.endT) continue;
            const fade = 1 - (replayT - lightning.startT)
                / Math.max(1, lightning.endT - lightning.startT);
            for (let index = 1; index < lightning.points.length; index++) {
                const from = this.placePoint(lightning.points[index - 1]);
                const to = this.placePoint(lightning.points[index]);
                this.drawJaggedLightning(graphics, from.x, from.y - 10, to.x, to.y - 10,
                    lightning.seed, index + Math.floor(replayT / 55), lightning.color,
                    Math.max(1, Math.round(lightning.width)), lightning.alpha * fade);
            }
        }
    }

    private drawPixelRing(
        graphics: Phaser.GameObjects.Graphics,
        centerX: number,
        centerY: number,
        radiusX: number,
        radiusY: number,
        thickness: number,
        color: number,
        alpha: number
    ): void {
        const segments = Math.max(12, Math.ceil(radiusX * 0.8));
        let previousX = centerX + radiusX;
        let previousY = centerY;
        for (let index = 1; index <= segments; index++) {
            const angle = (index / segments) * Math.PI * 2;
            const x = centerX + Math.cos(angle) * radiusX;
            const y = centerY + Math.sin(angle) * radiusY;
            pixelLine(graphics, previousX, previousY, x, y, thickness, color, alpha);
            previousX = x;
            previousY = y;
        }
    }

    private drawJaggedLightning(
        graphics: Phaser.GameObjects.Graphics,
        fromX: number,
        fromY: number,
        toX: number,
        toY: number,
        seed: number,
        phase: number,
        color: number,
        thickness: number,
        alpha: number
    ): void {
        const dx = toX - fromX;
        const dy = toY - fromY;
        const length = Math.max(1, Math.hypot(dx, dy));
        const px = -dy / length;
        const py = dx / length;
        const segments = Math.max(3, Math.min(10, Math.ceil(length / 30)));
        let previousX = fromX;
        let previousY = fromY;
        for (let index = 1; index <= segments; index++) {
            const progress = index / segments;
            const endpoint = index === segments;
            const jitter = endpoint ? 0
                : (this.replayNoise(seed ^ phase, index) - 0.5) * 13;
            const x = fromX + dx * progress + px * jitter;
            const y = fromY + dy * progress + py * jitter;
            pixelLine(graphics, previousX, previousY, x, y,
                thickness, color, alpha);
            previousX = x;
            previousY = y;
        }
    }

    private replayNoise(seed: number, index: number): number {
        let value = (seed + Math.imul(index + 1, 0x9e3779b9)) >>> 0;
        value = Math.imul(value ^ (value >>> 16), 0x21f0aaad);
        value = Math.imul(value ^ (value >>> 15), 0x735a2d97);
        return ((value ^ (value >>> 15)) >>> 0) / 0x1_0000_0000;
    }

    private hslColor(hue: number, saturation: number, lightness: number): number {
        const h = ((hue % 360) + 360) % 360 / 360;
        const channel = (offset: number) => {
            const k = (offset + h * 12) % 12;
            const a = saturation * Math.min(lightness, 1 - lightness);
            return lightness - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
        };
        const red = Math.round(channel(0) * 255);
        const green = Math.round(channel(8) * 255);
        const blue = Math.round(channel(4) * 255);
        return (red << 16) | (green << 8) | blue;
    }

    private drawAttackFx(replayT: number): void {
        const activeCarriers = new Set<string>();
        this.drawStatefulAttackFx(replayT, activeCarriers);
        this.drawProjectiles(replayT, activeCarriers);
        this.drawProjectileImpacts(replayT, activeCarriers);
        for (let index = this.impactPulses.length - 1; index >= 0; index--) {
            const pulse = this.impactPulses[index];
            const age = replayT - pulse.startT;
            if (age > pulse.durationMs) {
                this.impactPulses.splice(index, 1);
                continue;
            }
            if (age < 0) continue;
            const p = this.placePoint(pulse.at);
            const progress = Math.max(0, Math.min(1, age / pulse.durationMs));
            const radius = 2 + pulse.radius * progress;
            const key = `impact:${pulse.id}`;
            const carrier = this.airCarrier(key, depthForGroundEffect(pulse.at.gridX, pulse.at.gridY));
            activeCarriers.add(key);
            carrier.clear().setPosition(p.x, p.y).setScale(1).setRotation(0);
            SpriteBank.release(carrier);
            pixelEllipse(carrier, 0, 0, radius, radius * 0.55,
                pulse.color, 0.75 * (1 - progress));
        }
        for (const [key, carrier] of this.airCarriers) {
            if (activeCarriers.has(key)) continue;
            carrier.destroy();
            this.airCarriers.delete(key);
        }
        this.drawTroopDeaths(replayT);
        this.drawBuildingCollapses(replayT);
    }

    private drawProjectiles(replayT: number, activeCarriers: Set<string>): void {
        for (const projectile of this.presentation.projectiles.values()) {
            if (replayT < projectile.startT || replayT > projectile.endT) continue;
            const sample = sampleWorldBattleProjectile(
                projectile,
                replayT,
                entity => this.pointForEntity(entity)
            );
            const key = `projectile:${projectile.id}`;
            const carrier = this.airCarrier(
                key,
                depthForProjectile(sample.ground.gridX, sample.ground.gridY)
            );
            activeCarriers.add(key);
            carrier.clear().setAlpha(1).setVisible(this.visible);
            const payload = projectile.payload;
            const trajectory = payload.trajectory;
            if (payload.projectile === 'mortar-shell') {
                carrier.setAlpha(Math.max(0, Math.min(1, (replayT - projectile.startT) / 80)));
            } else if (payload.projectile === 'spike-ball') {
                carrier.setAlpha(Math.max(0, Math.min(1, (replayT - projectile.startT - 300) / 80)));
            }
            if (trajectory.kind === 'instant' || trajectory.kind === 'continuous') {
                carrier.setPosition(0, 0).setScale(1).setRotation(0);
                SpriteBank.release(carrier);
                const source = this.placePoint(payload.source);
                const targetPoint = payload.targetEntity
                    ? this.pointForEntity(payload.targetEntity) ?? payload.target
                    : payload.target;
                const target = this.placePoint(targetPoint);
                if (trajectory.kind === 'instant' && trajectory.segments?.length) {
                    for (let index = 0; index < trajectory.segments.length; index++) {
                        const segment = trajectory.segments[index];
                        if (replayT < projectile.startT + segment.delayMs) continue;
                        const from = this.placePoint(segment.from);
                        const to = this.placePoint(segment.to);
                        this.drawProjectileLine(carrier, payload.projectile, from, to,
                            projectile.seed + index, replayT);
                    }
                } else {
                    this.drawProjectileLine(
                        carrier,
                        payload.projectile,
                        source,
                        target,
                        projectile.seed,
                        replayT
                    );
                }
                continue;
            }

            const point = this.placePoint(sample.point);
            carrier.setPosition(point.x, point.y).setScale(1).setRotation(0);
            const bake = (PROJECTILE_BAKE as Partial<Record<ProjectileLaunchPayload['projectile'], {
                unit: string;
                angles: number;
            }>>)[payload.projectile];
            let baked = false;
            if (bake) {
                const level = this.projectileBakeLevel(payload.projectile, payload.level);
                const tau = Math.PI * 2;
                const angleIndex = Math.round(
                    (((sample.rotation % tau) + tau) % tau) / (tau / bake.angles)
                ) % bake.angles;
                const variant = bake.angles === 1
                    ? `l${level}`
                    : `l${level}_a${String(angleIndex).padStart(2, '0')}`;
                baked = SpriteBank.syncFigure(
                    this.scene,
                    carrier,
                    bake.unit,
                    variant,
                    'idle',
                    0,
                    false,
                    { kind: 'projectiles', scaleMul: sample.scale }
                );
            }
            if (baked) continue;
            SpriteBank.release(carrier);
            carrier.setScale(sample.scale).setRotation(sample.rotation);
            this.drawProjectileFallback(carrier, payload);
        }
    }

    private drawProjectileImpacts(replayT: number, activeCarriers: Set<string>): void {
        for (const impact of this.presentation.projectileImpacts) {
            if (replayT < impact.startT || replayT > impact.endT) continue;
            const style = worldBattleImpactVisual(impact.payload.style);
            const progress = (replayT - impact.startT) / Math.max(1, impact.endT - impact.startT);
            const point = this.placePoint(impact.payload.at);
            const key = `projectile-impact:${impact.id}`;
            const depth = style.ground
                ? depthForGroundDecal('shockfront')
                : depthForGroundEffect(impact.payload.at.gridX, impact.payload.at.gridY);
            const carrier = this.airCarrier(key, depth);
            activeCarriers.add(key);
            carrier.clear().setPosition(point.x, point.y).setScale(1).setRotation(0);
            SpriteBank.release(carrier);
            const authoredRadius = Math.max(style.radius, impact.payload.radiusTiles * 8);
            const radius = 3 + authoredRadius * progress;
            pixelEllipse(carrier, 0, 0, radius, radius * (style.ground ? 0.5 : 0.65),
                style.color, 0.86 * (1 - progress));
            if (!style.ground && progress < 0.58) {
                const core = Math.max(2, authoredRadius * (0.75 - progress));
                pixelRect(carrier, -core, -core, core * 2, core * 2,
                    0xffe2a0, 0.78 * (1 - progress));
            }
        }
    }

    private drawProjectileLine(
        graphics: Phaser.GameObjects.Graphics,
        kind: ProjectileLaunchPayload['projectile'],
        from: { x: number; y: number },
        to: { x: number; y: number },
        seed: number,
        replayT: number
    ): void {
        if (kind === 'tesla-bolt' || kind === 'storm-lightning') {
            this.drawJaggedLightning(graphics, from.x, from.y, to.x, to.y,
                seed, Math.floor(replayT / 55), kind === 'tesla-bolt' ? 0x87edff : 0x71efff,
                2, 0.95);
            return;
        }
        if (kind === 'prism-beam') {
            pixelLine(graphics, from.x, from.y, to.x, to.y, 4, 0xff7cf4, 0.3);
            pixelLine(graphics, from.x, from.y, to.x, to.y, 2, 0xffffff, 0.95);
            return;
        }
        pixelLine(graphics, from.x, from.y, to.x, to.y,
            kind === 'generic-tracer' ? 2 : 1,
            kind === 'generic-tracer' ? 0xdde8ff : 0xffd27a,
            0.9);
    }

    private drawProjectileFallback(
        graphics: Phaser.GameObjects.Graphics,
        payload: ProjectileLaunchPayload
    ): void {
        const level = Math.max(1, Math.floor(payload.level || 1));
        switch (payload.projectile) {
            case 'archer-arrow': ProjectileRenderer.drawArcherArrow(graphics); break;
            case 'mobile-mortar-shell': ProjectileRenderer.drawMobileMortarShell(graphics); break;
            case 'trebuchet-stone': ProjectileRenderer.drawTrebuchetStone(graphics, level); break;
            case 'ornithopter-bomb': ProjectileRenderer.drawOrnithopterBomb(graphics); break;
            case 'da-vinci-cannonball':
            case 'cannonball': ProjectileRenderer.drawCannonball(graphics, level); break;
            case 'mortar-shell': ProjectileRenderer.drawMortarShell(graphics, level); break;
            case 'ballista-bolt': ProjectileRenderer.drawBallistaBolt(graphics, level); break;
            case 'xbow-bolt': ProjectileRenderer.drawXbowBolt(graphics, level); break;
            case 'dragon-rocket': ProjectileRenderer.drawDragonRocket(graphics, level, 0); break;
            case 'spike-ball': ProjectileRenderer.drawSpikeBall(graphics, level); break;
            case 'necromancer-orb':
                pixelEllipse(graphics, 0, 0, 6, 6, 0x6f3aa8, 0.95);
                pixelEllipse(graphics, -1, -1, 3, 3, 0xcaa8ff, 0.9);
                break;
            case 'generic-tracer':
            case 'tesla-bolt':
            case 'storm-lightning':
            case 'prism-beam':
                break;
            default:
                break;
        }
    }

    private projectileBakeLevel(kind: ProjectileLaunchPayload['projectile'], level: number): number {
        const value = Math.max(1, Math.floor(level || 1));
        if (kind === 'archer-arrow' || kind === 'mobile-mortar-shell'
            || kind === 'ornithopter-bomb') return 1;
        if (kind === 'trebuchet-stone' || kind === 'ballista-bolt'
            || kind === 'xbow-bolt') return Math.min(3, value);
        if (kind === 'dragon-rocket') return Math.min(2, value);
        return Math.min(4, value);
    }

    private airCarrier(key: string, depth: number): Phaser.GameObjects.Graphics {
        let carrier = this.airCarriers.get(key);
        if (!carrier) {
            carrier = this.scene.add.graphics();
            carrier.setVisible(this.visible);
            this.battleLayer.add(carrier);
            this.airCarriers.set(key, carrier);
        }
        carrier.setDepth(depth);
        return carrier;
    }

    private drawHealthBars(): void {
        for (const building of this.model.buildings.values()) {
            if (building.isDestroyed) continue;
            const meta = this.buildingMeta.get(building.id);
            if (!meta) continue;
            const center = IsoUtils.cartToIso(
                this.placement.gridOffsetX + meta.gridX + meta.width / 2,
                this.placement.gridOffsetY + meta.gridY + meta.height / 2
            );
            const wallTag = meta.type === 'wall'
                ? SpriteBank.wallTag(this.wallNeighbors(meta)!)
                : undefined;
            const top = SpriteBank.buildingTopOffset(meta.type, meta.level, wallTag)
                ?? 22 + Math.max(meta.width, meta.height) * 9;
            this.drawHealthBar(center.x, center.y - top - 5,
                22 + Math.max(meta.width, meta.height) * 5,
                building.health / building.maxHealth);
        }

        for (const sampled of this.sampledTroops.values()) {
            const pos = IsoUtils.cartToIso(
                this.placement.gridOffsetX + sampled.gridX,
                this.placement.gridOffsetY + sampled.gridY
            );
            const top = SpriteBank.troopTopOffset(
                sampled.type,
                sampled.owner,
                sampled.level || 1
            ) ?? 21;
            this.drawHealthBar(pos.x, pos.y + sampled.visualOffsetY - top - 5,
                sampled.maxHealth >= 3_000 ? 34 : 26,
                sampled.health / Math.max(1, sampled.maxHealth));
        }
    }

    private drawHealthBar(x: number, y: number, width: number, ratio: number): void {
        const clamped = Math.max(0, Math.min(1, ratio));
        const height = 3;
        pixelRect(this.healthOverlay, x - width / 2 - 1, y - 1, width + 2, height + 2, 0x171a18, 0.9);
        pixelRect(this.healthOverlay, x - width / 2, y, width, height, 0x4a332d, 0.9);
        const color = clamped > 0.6 ? 0x48d06f : clamped > 0.3 ? 0xe3c44d : 0xe5534b;
        if (clamped > 0) pixelRect(this.healthOverlay, x - width / 2, y, width * clamped, height, color, 1);
    }

    private placePoint(point: ReplayPresentationPoint): { x: number; y: number } {
        const localBase = IsoUtils.cartToIso(point.gridX, point.gridY);
        const placedBase = IsoUtils.cartToIso(
            this.placement.gridOffsetX + point.gridX,
            this.placement.gridOffsetY + point.gridY
        );
        return {
            x: placedBase.x + (point.worldX - localBase.x),
            y: placedBase.y + (point.worldY - localBase.y)
        };
    }

    private pointForEntity(entity: ReplayEntityRef): ReplayPresentationPoint | undefined {
        if (entity.kind === 'building') {
            const meta = this.buildingMeta.get(entity.id);
            if (!meta) return undefined;
            const gridX = meta.gridX + meta.width / 2;
            const gridY = meta.gridY + meta.height / 2;
            const world = IsoUtils.cartToIso(gridX, gridY);
            return { gridX, gridY, worldX: world.x, worldY: world.y };
        }
        const troop = this.sampledTroops.get(entity.id) ?? this.model.troops.get(entity.id);
        if (!troop) return undefined;
        const gridX = Number(troop.gridX) || 0;
        const gridY = Number(troop.gridY) || 0;
        const world = IsoUtils.cartToIso(gridX, gridY);
        return {
            gridX,
            gridY,
            worldX: world.x,
            worldY: world.y + (Number(troop.visualOffsetY) || 0)
        };
    }

    private wallNeighbors(meta: BuildingVisualMeta): {
        nN: boolean;
        nS: boolean;
        nE: boolean;
        nW: boolean;
        owner: string;
    } | undefined {
        if (meta.type !== 'wall') return undefined;
        const aliveAt = (x: number, y: number): boolean => {
            const id = this.wallIdsByCell.get(`${x},${y}`);
            return Boolean(id && !this.model.destroyedBuildingIds.has(id));
        };
        return {
            nN: aliveAt(meta.gridX, meta.gridY - 1),
            nS: aliveAt(meta.gridX, meta.gridY + 1),
            nE: aliveAt(meta.gridX + 1, meta.gridY),
            nW: aliveAt(meta.gridX - 1, meta.gridY),
            owner: 'ENEMY'
        };
    }

    private destroyBuildingCarrier(id: string): void {
        this.buildingCarriers.get(id)?.destroy();
        this.buildingCarriers.delete(id);
    }

    private destroyCarrier(id: string): void {
        this.carriers.get(id)?.destroy();
        this.carriers.delete(id);
        this.carrierFacing.delete(id);
        this.sampledTroops.delete(id);
    }

    private isCurrent(epoch: number): boolean {
        if (this.destroyed || epoch !== this.lifecycleEpoch) return false;
        try {
            return Boolean(this.scene.scene?.isActive());
        } catch {
            return false;
        }
    }
}
