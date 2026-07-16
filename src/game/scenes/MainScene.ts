
import Phaser from 'phaser';
import { Backend, type AttackEndResult, type AttackReplayState, type ReplayFrameSnapshot, type ReplayTroopSnapshot } from '../backend/GameBackend';
import type { SerializedBuilding, SerializedWorld, VillageBanner } from '../data/Models';
import { bannerDesignFor, drawVillageFlag, type FlagDesign } from '../renderers/VillageFlagRenderer';
import { BUILDING_DEFINITIONS, GENERATED_ONLY, OBSTACLE_DEFINITIONS, TROOP_DEFINITIONS, getBuildingStats, getTroopStats, type BuildingType, type ObstacleType, type TroopType } from '../config/GameDefinitions';
import { LootSystem } from '../systems/LootSystem';
import type { PlacedBuilding, Troop, PlacedObstacle } from '../types/GameTypes';
import { drawBuildingVisual, type WallNeighborTopology } from '../renderers/BuildingVisualDispatcher';
import { TroopRenderer } from '../renderers/TroopRenderer';
import { ObstacleRenderer } from '../renderers/ObstacleRenderer';
import { ProjectileRenderer } from '../renderers/ProjectileRenderer';
import { WreckRenderer, wreckNeedsAnimation } from '../renderers/WreckRenderer';
import { DefenseSystem } from '../systems/DefenseSystem';
import { TargetingSystem } from '../systems/TargetingSystem';
import { DEFENSE_BEHAVIOR_CATALOG } from '../systems/DefenseBehaviorCatalog';
import { CombatNavigationSystem, type CombatNavigationSelection } from '../systems/CombatNavigationSystem';
import { depthForBuilding, depthForGroundEffect, depthForGroundPlane, depthForObstacle, depthForProjectile, depthForRubble, depthForTroop } from '../systems/DepthSystem';
import { IsoUtils, TILE_HEIGHT, TILE_WIDTH } from '../utils/IsoUtils';
import { cameraCssHeight, cameraCssWidth, getRenderScale, toBackingZoom, toLogicalZoom } from '../utils/DisplayResolution';
import { MobileUtils } from '../utils/MobileUtils';
import { Auth } from '../backend/Auth';
import { gameManager } from '../GameManager';
import { particleManager } from '../systems/ParticleManager';
import { VillageLifeSystem } from '../systems/VillageLifeSystem';
import { VillageBubbles } from '../systems/VillageBubbles';
import { onCameraFrame } from '../../ui/cameraFrame';
import { soundSystem } from '../systems/SoundSystem';
import { DayNightSystem } from '../systems/DayNightSystem';
import { WeatherSystem } from '../systems/WeatherSystem';
import { windAtScreen } from '../systems/Wind';
import { WorldMapSystem } from '../systems/WorldMapSystem';
import { hashString, mulberry32, watchtowerSightOf } from '../config/Economy';
import { serverUpgradeDurationMs } from '../config/UpgradePolicy';
import { drawGrassTile, grassPaletteFor, type GrassCornerCut } from '../renderers/GrassRenderer';
import { PLOT_PITCH } from '../systems/WorldMapSystem';
import type { BattleOverlayScene } from './BattleOverlayScene';
import type { GameMode } from '../types/GameMode';
import { SceneInputController } from './controllers/SceneInputController';
import { installBakeBridge } from '../dev/BakeBridge';
import { SpriteBank } from '../render/SpriteBank';
import { installPixelModeHandle, registerPixelSurface, settleLogicalZoom, zoomSettleEnabled } from '../renderers/TextureRenderPolicy';
import { pixelBitmap, pixelEllipse, pixelLine, pixelRect, PIXEL_CELL } from '../render/PixelDraw';
import { PixelFx } from '../systems/PixelFx';

const BUILDINGS = BUILDING_DEFINITIONS as any;
const OBSTACLES = OBSTACLE_DEFINITIONS as any;

type UpgradeTimedSerializedBuilding = SerializedBuilding & { upgradeStartedAt?: number };
type UpgradeTimedPlacedBuilding = PlacedBuilding & { upgradeStartedAt?: number };

interface EnemyInstantiationSummary {
    requested: number;
    prepared: number;
    placed: number;
    playablePlaced: number;
    skippedUnknownType: number;
    skippedOutOfBounds: number;
    failedInstantiation: number;
}

interface EnemyWorldMeta {
    id: string;
    username: string;
    isBot: boolean;
    attackId?: string;
    botRaidId?: string;
    botPlot?: { x: number; y: number };
    /** The server already applied raid shares/protection to world.resources. */
    lootPreCapped?: boolean;
}

type ReplayWatchMode = 'live' | 'replay';

interface ReplayCaptureState {
    attackId: string;
    victimId: string;
    startedAt: number;
    startedRemotely: boolean;
    framePushInFlight: boolean;
    lastFramePushAt: number;
    ended: boolean;
}

interface ReplayWatchState {
    attackId: string;
    mode: ReplayWatchMode;
    renderClockT: number;
    clockStarted: boolean;
    nextFrameIndex: number;
    lastAppliedFrameT: number;
    lastFetchedFrameT: number;
    status: 'live' | 'finished' | 'aborted';
    pollInFlight: boolean;
    frames: ReplayFrameSnapshot[];
    pollEvent?: Phaser.Time.TimerEvent;
    /** Peeked troop positions from the first UNAPPLIED frame — the forward
     *  bracket for interpolation (rebuilt whenever that frame's t changes). */
    nextSampleT?: number;
    nextSamples?: Map<string, { x: number; y: number }>;
}













export class MainScene extends Phaser.Scene {
    public tileWidth = 64;
    private groundRenderTexture!: Phaser.GameObjects.RenderTexture;
    private tempGraphics!: Phaser.GameObjects.Graphics;
    private readonly RT_OFFSET_X = 1000;
    private readonly RT_OFFSET_Y = 500;
    public tileHeight = 32;
    public mapSize = 25;
    public buildings: PlacedBuilding[] = [];
    public rubble: { gridX: number; gridY: number; width: number; height: number; type: string; level: number; graphics: Phaser.GameObjects.Graphics; baseGraphics: Phaser.GameObjects.Graphics; createdAt: number; animationDone?: boolean; fxGraphics?: Phaser.GameObjects.Graphics }[] = [];
    public obstacles: PlacedObstacle[] = [];
    public troops: Troop[] = [];
    public ghostBuilding!: Phaser.GameObjects.Graphics;
    public deploymentGraphics!: Phaser.GameObjects.Graphics;
    public forbiddenGraphics!: Phaser.GameObjects.Graphics;
    /** Geometry cache key for updateDeploymentHighlight: the zone diamonds
     *  (~5–7k world-anchored pixel cells) re-record only when this changes;
     *  the per-frame fades ride the Graphics objects' own alpha. */
    private deployZoneSignature = '';
    public cursorKeys!: Phaser.Types.Input.Keyboard.CursorKeys;
    public inputController!: SceneInputController;

    public selectedBuildingType: string | null = null;
    public selectedInWorld: PlacedBuilding | null = null;
    public isMoving = false;
    public ghostGridPos: { x: number; y: number } | null = null;
    public isDragging = false;
    public dragOrigin: Phaser.Math.Vector2 = new Phaser.Math.Vector2();
    public dragStartCam: Phaser.Math.Vector2 = new Phaser.Math.Vector2();
    public dragStartScreen: Phaser.Math.Vector2 = new Phaser.Math.Vector2();
    public hoverGrid: Phaser.Math.Vector2 = new Phaser.Math.Vector2(-100, -100);
    public preferredWallLevel = 1;
    // 'snap' mode post-gesture zoom settle: debounce timer + the easing tween.
    private zoomSettleTimer: Phaser.Time.TimerEvent | null = null;
    private zoomSettleTween: Phaser.Tweens.Tween | null = null;

    public mode: GameMode = 'HOME';
    public isScouting = false;
    // Rotating stagger slot (0-2) for throttled ambient building redraws.
    private buildingAnimFrame = 0;
    // Next allowed battle-end scan (throttled to 4Hz).
    private nextBattleEndCheckAt = 0;
    // Ambient villagers/dogs/chickens + army figures at the camps.
    public villageLife!: VillageLifeSystem;
    // Sunset, night lights, moon and stars — the village's mood lighting.
    public dayNight!: DayNightSystem;
    // Diegetic speech bubbles the buildings raise over their own roofs.
    public villageBubbles!: VillageBubbles;
    private stopCameraFrameSync: (() => void) | null = null;
    public weather!: WeatherSystem;
    private nextAmbienceAt = 0;
    public worldMap!: WorldMapSystem;

    // Combat stuff

    private readonly defenseSystem = new DefenseSystem({
        fire: {
            cannon: (defense, target) => this.shootAt(defense, target),
            ballista: (defense, target) => this.shootBallistaAt(defense, target),
            xbow: (defense, target) => this.shootXBowAt(defense, target),
            mortar: (defense, target) => this.shootMortarAt(defense, target),
            tesla: (defense, target) => this.shootTeslaAt(defense, target),
            prism: (defense, target, time) => this.shootPrismContinuousLaser(defense, target, time),
            dragons_breath: (defense, target) => this.shootDragonsBreathAt(defense, target),
            spike_launcher: (defense, target) => this.shootSpikeLauncherAt(defense, target),
            frostfall: (defense, _target, time) => this.shootFrostfallShard(defense, time)
        },
        idle: {
            cleanupPrismLaser: defense => this.cleanupPrismLaser(defense)
        }
    });

    /** Incremented whenever live structure geometry changes. Combat plans are
     * never followed across revisions; their strategic intent is replanned. */
    private combatTopologyRevision = 0;

    /** Enemy wall ids serving as ALLY RAMPS (a parked siege tower), keyed by
     *  the tower's owner. Threaded into CombatNavigationSystem only for
     *  same-owner ground troops; lifecycle: park → add + plain revision bump,
     *  tower death / wall destruction → delete + plain revision bump (NEVER
     *  the removal-promotion path — losing a ramp CLOSES routes). */
    private readonly rampedWallsByOwner: Record<'PLAYER' | 'ENEMY', Set<string>> = {
        PLAYER: new Set<string>(),
        ENEMY: new Set<string>()
    };

    /** Shared per-combat-frame graphics for the support-kit auras (physician
     *  heal ring, quartermaster drum ring) — redrawn every frame as a
     *  deterministic f(time, troop id), like the old ward aura. */
    private kitAuraGfx: Phaser.GameObjects.Graphics | null = null;

    /** Deterministic skeleton spawn offsets around a summoner — rotated by
     *  wave index so waves fan out without Math.random. */
    private static readonly SUMMON_OFFSETS = [
        { dx: -0.7, dy: 0.4 }, { dx: 0.7, dy: 0.4 }, { dx: -0.4, dy: -0.8 },
        { dx: 0.4, dy: -0.8 }, { dx: -1.0, dy: -0.2 }, { dx: 1.0, dy: -0.2 }
    ] as const;

    // Battle stats tracking
    public initialEnemyBuildings = 0;
    public lastDeployTime = 0;
    public deployStartTime = 0;
    public lastForbiddenInteractionTime = 0;
    public lastGrassGrowTime = 0;

    public destroyedBuildings = 0;
    public goldLooted = 0;
    public oreLooted = 0;
    public foodLooted = 0;
    /** Capped raidable pools for the current enemy world — the client mirror
     *  of the server's lootCaps. The HUD loot counter is pool × destruction%
     *  (HP-weighted, like the settlement), recomputed in updateBattleStats. */
    private battleLootPools: { gold: number; ore: number; food: number } | null = null;
    /** Total max HP of the enemy's scoring (non-wall) buildings at battle
     *  start — the denominator of the server's HP-weighted destruction%. */
    private initialEnemyScoringHP = 0;
    /** Coarse tick for the HP-weighted battle-stats refresh in updateCore. */
    private nextBattleStatsRefreshAt = 0;
    public hasDeployed = false;
    public raidEndScheduled = false; // Prevent multiple end calls
    /** First-generation troops deployed this battle, by type — the server consumes these on bot raids. */
    public deployedThisBattle: Record<string, number> = {};
    private botRaidSettled = false;
    private pendingBotSettlement: Promise<number> | null = null;
    public pendingSpawnCount = 0; // Prevent battle end during troop splits (phalanx)
    private readonly HEALTH_BAR_IDLE_MS = 5000;
    private readonly HEALTH_BAR_FADE_MS = 600;
    private readonly REPLAY_LIVE_POLL_INTERVAL_MS = 300;
    /** Live spectating rides this far behind the newest frame — the jitter buffer. */
    private readonly REPLAY_LIVE_DELAY_MS = 1500;
    /** Recorded replays play back at a brisk fixed speed. */
    private readonly REPLAY_SPEED = 1.6;

    public villageNameLabel!: Phaser.GameObjects.Text;
    public attackModeSelectedBuilding: PlacedBuilding | null = null;
    /** The range ring's infinite pulse tween — killed on reselect/hide
     *  (destroying the graphics alone leaves the tween running forever). */
    private rangeIndicatorPulseTween: Phaser.Tweens.Tween | null = null;

    // Online attack tracking
    public currentEnemyWorld: EnemyWorldMeta | null = null;
    /** True while a neighbour raid is being fought IN PLACE on the world map
     *  (no cloud, no lighting/weather cutover — the world just keeps going). */
    public battleInPlace = false;
    /** The cached home world held for the homecoming swap (null = no march home in flight). */
    private pendingHomecoming: { world: SerializedWorld } | null = null;
    /** Whose lawn the ground texture is currently baked as. */
    private groundPaletteKey = 'village';
    public playerLabLevel = 1;
    private needsDefaultBase = false;
    private sceneReadyForBaseLoad = false;
    private replayCaptureState: ReplayCaptureState | null = null;
    /** Destroyed buildings leave `this.buildings`; keep their terminal replay state in every later frame. */
    private replayDestroyedBuildings = new Map<string, { id: string; health: number; isDestroyed: boolean }>();
    private pendingAttackSettlement: Promise<AttackEndResult | null> | null = null;
    // Attacks already settled via a battle end, so a later abandon can't re-settle them as aborted.
    private settledAttackIds = new Set<string>();
    private replayWatchState: ReplayWatchState | null = null;
    private replaySimulationTime = 0;
    private isApplyingReplayFrame = false;
    /** True only while a baseline/catch-up frame rebuilds mid-battle state on
     *  join — destruction lands silently (no FX) instead of detonating every
     *  already-dead building at once. */
    private isApplyingReplayBaseline = false;
    private replayAutoExitQueued = false;
    /** Bumped on every replay-watch start/teardown so a stale auto-exit timer
     *  from the previous session can never fire into the next one. */
    private replayWatchEpoch = 0;
    /** One exclusive navigation at a time; stale async continuations must not commit. */
    private transitionEpoch = 0;
    private transitionBusy = false;
    private transitionLabel = '';
    private battleEpoch = 0;
    private battleTimerEvents = new Set<Phaser.Time.TimerEvent>();
    /** Loose battle-effect objects (projectiles, blooms, craters, scorch…)
     *  not owned by any building/troop. clearScene sweeps them so no effect
     *  can outlive a mode transition and land re-anchored on the home lawn. */
    private battleFx = new Set<Phaser.GameObjects.GameObject>();
    /** Battle tweens that target plain state objects (progress drivers) but
     *  draw/spawn battle visuals from onUpdate — killed on the same sweep. */
    private battleFxTweens = new Set<Phaser.Tweens.Tween>();
    /** Optimistic scaffolds wait for a matching authoritative world ack before
     *  their local deadline is allowed to reveal the upgraded level. */
    private pendingUpgradeAuthority = new Set<string>();
    /** Whose heraldry the CURRENT scene's town hall flies: the owner's at
     *  home, the DEFENDER's during raids/replays. Null = no banner planted. */
    private villageBannerMeta: { identity: string; banner: VillageBanner | null } | null = null;
    private hallBannerGfx: Phaser.GameObjects.Graphics | null = null;
    private hallBannerDesign: FlagDesign | null = null;
    private hallBannerDesignKey = '';
    /** Invalidates network continuations when this scene is stopped/destroyed. */
    private lifecycleEpoch = 0;

    public get userId(): string {
        try {
            const user = Auth.getCurrentUser();
            return user?.id || 'default_player';
        } catch (error) {
            console.error('Error getting user ID:', error);
            return 'default_player';
        }
    }

    public isLockingDragForTroops = false;
    public selectionGraphics!: Phaser.GameObjects.Graphics;

    public cameraSensitivity = 1.0;
    public hasUserMovedCamera = false;


    constructor() {
        super('MainScene');
    }

    /**
     * Stroked-ellipse ring rasterized as whole pixel cells — thin wrapper over
     * PixelFx.stampRing (the shared primitive) so the many call sites keep
     * their shape. rx/ry are RADII. `thick` is in cells (≈ old lineWidth /
     * 1.35, min 1). One-shot expanding rings should use PixelFx.ring instead.
     */
    private pixelRing(g: Phaser.GameObjects.Graphics, cx: number, cy: number, rx: number, ry: number, thick: number, color: number, alpha = 1) {
        PixelFx.stampRing(g, cx, cy, rx, ry, thick, color, alpha);
    }

    private normalizeBuildingType(type: string): BuildingType | null {
        if (!type) return null;
        const canonical = type.trim().toLowerCase().replace(/[\s-]+/g, '_');
        // Legacy compatibility: accept names that differ only by underscores.
        if (!BUILDINGS[canonical]) {
            const compactCanonical = canonical.replace(/_/g, '');
            for (const key of Object.keys(BUILDINGS)) {
                if (key.replace(/_/g, '') === compactCanonical) {
                    return key as BuildingType;
                }
            }
        }
        return BUILDINGS[canonical] ? (canonical as BuildingType) : null;
    }

    private getAttackEnemyBuildings(): PlacedBuilding[] {
        if (this.mode === 'ATTACK') {
            return this.buildings.filter(b => b.type !== 'wall');
        }
        return this.buildings.filter(b => b.owner === 'ENEMY' && b.type !== 'wall');
    }

    private snapshotPlayerLabLevel() {
        const maxLab = this.buildings.reduce((max, building) => {
            // Mirror the server rule (troopLevelOf): a lab that is mid-upgrade
            // is offline and contributes NOTHING — troops drop to level 1.
            if (building.owner !== 'PLAYER' || building.type !== 'lab' || building.upgradingTo) return max;
            return Math.max(max, Math.max(1, building.level || 1));
        }, 0);
        // A NEXT transition may already have cleared the enemy scene. Keep the
        // home snapshot in ATTACK mode instead of mistaking an empty frame for
        // a level-zero home; HOME is the only authoritative place to reset it.
        if (this.mode === 'HOME' || maxLab > 0) this.playerLabLevel = maxLab;
    }

    private beginExclusiveTransition(label: string): number | null {
        if (this.transitionBusy) {
            gameManager.showToast(`${this.transitionLabel || 'Another journey'} is already underway.`);
            return null;
        }
        this.transitionBusy = true;
        this.transitionLabel = label;
        return ++this.transitionEpoch;
    }

    private isTransitionCurrent(epoch: number): boolean {
        return this.transitionBusy && epoch === this.transitionEpoch;
    }

    private finishExclusiveTransition(epoch: number) {
        if (epoch !== this.transitionEpoch) return;
        this.transitionBusy = false;
        this.transitionLabel = '';
    }

    private invalidateTransitions() {
        this.transitionEpoch++;
        this.transitionBusy = false;
        this.transitionLabel = '';
    }

    private scheduleBattleCall(delay: number, callback: () => void): Phaser.Time.TimerEvent {
        const epoch = this.battleEpoch;
        let event!: Phaser.Time.TimerEvent;
        event = this.time.delayedCall(delay, () => {
            this.battleTimerEvents.delete(event);
            if (epoch !== this.battleEpoch) return;
            callback();
        });
        this.battleTimerEvents.add(event);
        return event;
    }

    private cancelBattleAsyncWork() {
        this.battleEpoch++;
        for (const event of this.battleTimerEvents) event.remove(false);
        this.battleTimerEvents.clear();
        this.pendingSpawnCount = 0;
        this.raidEndScheduled = false;
    }

    /** Register a loose battle-effect object; it self-deregisters on destroy
     *  and is force-destroyed (tweens killed) by clearBattleFx. */
    private trackBattleFx<T extends Phaser.GameObjects.GameObject>(obj: T): T {
        this.battleFx.add(obj);
        obj.once(Phaser.GameObjects.Events.DESTROY, () => this.battleFx.delete(obj));
        return obj;
    }

    /** Register a battle tween whose TARGET is a plain state object (so
     *  killTweensOf(gameObject) cannot reach it) but whose callbacks draw or
     *  spawn battle visuals. Self-deregisters when it finishes. */
    private trackBattleFxTween(tween: Phaser.Tweens.Tween): Phaser.Tweens.Tween {
        this.battleFxTweens.add(tween);
        const forget = () => this.battleFxTweens.delete(tween);
        tween.once(Phaser.Tweens.Events.TWEEN_COMPLETE, forget);
        tween.once(Phaser.Tweens.Events.TWEEN_STOP, forget);
        return tween;
    }

    /** Destroy every registered loose battle effect and stop its tweens.
     *  Timer-scheduled cleanups may already be cancelled by
     *  cancelBattleAsyncWork — this sweep is what guarantees no effect
     *  survives into the next scene. */
    private clearBattleFx() {
        for (const tween of this.battleFxTweens) tween.remove();
        this.battleFxTweens.clear();
        for (const obj of this.battleFx) {
            this.tweens.killTweensOf(obj);
            obj.destroy();
        }
        this.battleFx.clear();
    }

    /** Shared preamble for every attack-mode transition. */
    private async beginAttackSession(scouting: boolean, epoch?: number): Promise<boolean> {
        if (!await this.flushPendingSaveForTransition()) return false;
        if (epoch !== undefined && !this.isTransitionCurrent(epoch)) return false;
        // A scout scene contains only ENEMY buildings. Preserve the home lab
        // snapshot when converting that scout directly into an attack.
        if (this.mode === 'HOME') this.snapshotPlayerLabLevel();
        gameManager.setGameMode('ATTACK');
        this.mode = 'ATTACK';
        this.isScouting = scouting;
        this.clearScene();
        return true;
    }

    /** Reset per-raid battle stats once the enemy world is in place. */
    private resetBattleStats() {
        this.initialEnemyBuildings = this.getAttackEnemyBuildings().length;
        this.initialEnemyScoringHP = this.getAttackEnemyBuildings()
            .filter(b => b.type !== 'wall')
            .reduce((sum, b) => sum + Math.max(0, b.maxHealth), 0);
        this.destroyedBuildings = 0;
        this.goldLooted = 0;
        this.oreLooted = 0;
        this.foodLooted = 0;
        this.deployedThisBattle = {};
        this.botRaidSettled = false;
        this.replayDestroyedBuildings.clear();
        this.raidEndScheduled = false;
        this.updateBattleStats();
    }

    private getLabLevelForOwner(owner: 'PLAYER' | 'ENEMY'): number {
        if (owner === 'PLAYER' && this.mode === 'ATTACK') {
            return Math.max(0, this.playerLabLevel);
        }
        const maxLab = this.buildings.reduce((max, building) => {
            // Server rule (troopLevelOf): labs mid-upgrade are offline and
            // grant no troop level, so the client must not simulate the old one.
            if (building.owner !== owner || building.type !== 'lab' || building.upgradingTo) return max;
            return Math.max(max, Math.max(1, building.level || 1));
        }, 0);
        if (owner === 'PLAYER') {
            this.playerLabLevel = maxLab;
        }
        return maxLab;
    }

    private getTroopLevelForOwner(owner: 'PLAYER' | 'ENEMY'): number {
        const labLevel = this.getLabLevelForOwner(owner);
        return Math.max(1, Math.min(labLevel, 3));
    }

    private getTroopCombatStats(troop: Troop) {
        return getTroopStats(troop.type, troop.level || 1);
    }

    private getBattleTotals() {
        const enemies = this.getAttackEnemyBuildings();
        const remaining = enemies.filter(b => b.health > 0 && !b.isDestroyed).length;
        const totalKnown = Math.max(this.initialEnemyBuildings, this.destroyedBuildings + remaining, enemies.length);
        return { remaining, totalKnown };
    }

    public getHomePlayableBuildingCount() {
        if (this.mode !== 'HOME') return 0;
        return this.buildings.filter(b => b.owner === 'PLAYER' && b.type !== 'wall').length;
    }

    preload() {
    }

    create() {
        this.cameras.main.setBackgroundColor('#141824'); // Deep midnight navy background

        // Set default zoom based on device. In 'snap' mode the boot zoom must
        // already put one baked texel on a whole number of backing pixels.
        const defaultZoom = zoomSettleEnabled()
            ? settleLogicalZoom(MobileUtils.getDefaultZoom(), getRenderScale())
            : MobileUtils.getDefaultZoom();
        this.cameras.main.setZoom(toBackingZoom(defaultZoom));

        this.scale.on('resize', () => {
            if (!this.hasUserMovedCamera) {
                this.centerCamera();
            }
        });

        // Global runtime pixelation is intentionally absent. Live vector art is
        // antialiased; baked pixel sprites opt into NEAREST per texture through
        // TextureRenderPolicy. See docs/AGENTS_SPRITE_PIPELINE.md.

        // Battle UI (health bars + level chips) renders in a mirrored scene
        // above this one — see BattleOverlayScene.
        if (!this.scene.isActive('BattleOverlay')) {
            this.scene.launch('BattleOverlay');
        }

        gameManager.registerScene({
            // Startup path: App already fetched cloud state and cached it, so avoid a second cloud refresh here.
            loadBase: () => this.sceneReadyForBaseLoad
                ? this.reloadHomeBase({ refreshOnline: false })
                : Promise.resolve(false),
            setUnderAttack: (underAttack: boolean, attackId?: string | null) => {
                if (this.mode !== 'HOME') return;
                if (underAttack) this.villageLife.panic();
                else this.villageLife.calm();
                // One detector (the App's 2.5s incoming poll) drives everything:
                // villager panic AND the in-scene siege banner.
                this.worldMap?.setSiege(underAttack ? attackId ?? null : null);
            },
            dismissSiegeBanner: () => {
                this.worldMap?.dismissSiege();
            },
            advanceDayNight: () => {
                this.dayNight.advancePhase();
            },
            summonDragon: () => {
                this.villageLife.spawnDragonShadow();
            },
            showNeighborhood: () => {
                this.showNeighborhood();
            },
            syncPopulation: (count: number) => {
                if (this.mode === 'HOME') this.villageLife.syncPopulation(count);
            }
        });

        installBakeBridge(this);
        installPixelModeHandle();
        // Baked sprite atlases (buildings/troops/wrecks/obstacles) — loads in
        // the background; until ready every draw falls back to vector.
        SpriteBank.init(this);
        // The bank finishing AFTER first paint left one-shot art stuck on the
        // vector fallback forever — walls especially, whose change gate skips
        // them outside explicit repaints. Bust every building's draw cache
        // once so the next update repaints the whole village from the bank.
        this.events.once('spritebank:ready', () => {
            for (const b of this.buildings) b.lastDrawHealth = undefined;
            // Obstacles are one-shot too: only foliage re-draws (for sway), so
            // rocks and the rest would keep their smooth vector fallback.
            for (const o of this.obstacles) this.drawObstacle(o, this.time.now);
        });

        this.inputController = new SceneInputController(this);
        this.input.on('pointerdown', (pointer: Phaser.Input.Pointer) => {
            // A new gesture owns the camera; a pending settle re-arms and
            // waits the gesture out instead of being dropped.
            if (this.zoomSettleTimer || this.zoomSettleTween) this.settleZoomAfterGesture();
            this.inputController.onPointerDown(pointer);
        });
        this.input.on('pointermove', (pointer: Phaser.Input.Pointer) => this.inputController.onPointerMove(pointer));
        this.input.on('pointerup', (pointer: Phaser.Input.Pointer) => this.inputController.onPointerUp(pointer));

        this.input.on('wheel', (pointer: Phaser.Input.Pointer, _gameObjects: any, _deltaX: number, deltaY: number, _deltaZ: number) => {
            this.cancelPendingZoomSettle();
            const camera = this.cameras.main;
            const maxZoom = MobileUtils.getMaxZoom();

            const oldBackingZoom = camera.zoom;
            const oldZoom = toLogicalZoom(oldBackingZoom);
            // Never yank a camera the world view legitimately parked below the
            // floor — below it, wheel-out is inert and wheel-in still works.
            const minZoom = Math.min(this.minGestureZoom(), oldZoom);
            const newZoom = Phaser.Math.Clamp(oldZoom - deltaY * 0.002, minZoom, maxZoom);

            if (newZoom === oldZoom) return;
            this.hasUserMovedCamera = true;
            const newBackingZoom = toBackingZoom(newZoom);

            // Pointer position on screen (relative to canvas)
            const screenX = pointer.x;
            const screenY = pointer.y;

            // In Phaser, camera.scrollX/Y is where the CENTER of the camera view is in world space
            // Screen to world formula: worldX = scrollX + (screenX - viewportWidth/2) / zoom
            const viewportCenterX = camera.width / 2;
            const viewportCenterY = camera.height / 2;

            // Calculate the world point under the cursor with current zoom
            const worldX = camera.scrollX + (screenX - viewportCenterX) / oldBackingZoom;
            const worldY = camera.scrollY + (screenY - viewportCenterY) / oldBackingZoom;

            // Apply new zoom
            camera.setZoom(newBackingZoom);

            // Calculate new scroll so the same world point stays under the cursor
            // worldX = newScrollX + (screenX - viewportCenterX) / newZoom
            // newScrollX = worldX - (screenX - viewportCenterX) / newZoom
            camera.scrollX = worldX - (screenX - viewportCenterX) / newBackingZoom;
            camera.scrollY = worldY - (screenY - viewportCenterY) / newBackingZoom;

            this.settleZoomAfterGesture();
        });

        const onAttackInvalidated = (event: Event) => {
            const detail = (event as CustomEvent<{ attackId?: string; message?: string }>).detail;
            const attackId = detail?.attackId;
            if (!attackId || this.mode !== 'ATTACK' || this.currentEnemyWorld?.attackId !== attackId) return;
            // Another army won the deferred victim lock, or the village moved
            // before our first troop landed. Stop publishing the dead replay
            // and return to authoritative home state immediately.
            if (this.replayCaptureState?.attackId === attackId) {
                this.replayCaptureState.ended = true;
                this.replayCaptureState = null;
            }
            this.settledAttackIds.add(attackId);
            this.currentEnemyWorld = { ...this.currentEnemyWorld, attackId: undefined };
            gameManager.showToast(detail.message || 'That village changed before your army arrived.');
            void this.goHome();
        };
        window.addEventListener('clash:attack-invalidated', onAttackInvalidated);
        const onWorldSynced = (event: Event) => {
            const world = (event as CustomEvent<{ world?: SerializedWorld }>).detail?.world;
            if (world) this.reconcileUpgradeAuthority(world);
        };
        window.addEventListener('clash:world-synced', onWorldSynced);
        const onBannerChanged = (event: Event) => {
            const detail = (event as CustomEvent<{ userId?: string; banner?: VillageBanner | null }>).detail;
            // Only the OWN standard hot-swaps; an enemy scene keeps the
            // defender's snapshot heraldry for the whole battle.
            if (!detail || detail.userId !== this.userId || this.mode !== 'HOME') return;
            if (this.villageBannerMeta) {
                this.villageBannerMeta = { ...this.villageBannerMeta, banner: detail.banner ?? null };
            }
        };
        window.addEventListener('clash:banner-changed', onBannerChanged);
        const onDesignChanged = (event: Event) => {
            const unit = (event as CustomEvent<{ unit?: string }>).detail?.unit;
            // Design Lab switched a unit's variant slot (DesignRegistry
            // setActiveSlot). Baked frames resolve the slot on every pick and
            // the vector delegators re-read the same key per draw, so all
            // that's needed is a repaint of anything CACHED:
            //  - placed buildings: bust the draw cache (the spritebank:ready
            //    pattern) so the next update repaints body art, and re-stamp
            //    the ground decal (designs ship their own pads) — unbake
            //    restores the grass + overlapping neighbours underneath.
            //  - troops/figures: redrawn every frame (battle troops, camp
            //    figures on the 24 Hz tick), so they re-pick automatically.
            for (const b of this.buildings) {
                if (unit && b.type !== unit) continue;
                b.lastDrawHealth = undefined;
                this.unbakeBuildingFromGround(b);
                this.bakeBuildingToGround(b);
            }
        };
        window.addEventListener('clash:design-changed', onDesignChanged);

        let sceneCleanedUp = false;
        const cleanupScene = () => {
            if (sceneCleanedUp) return;
            sceneCleanedUp = true;
            this.lifecycleEpoch++;
            this.sceneReadyForBaseLoad = false;
            this.invalidateTransitions();
            this.endAttackReplayCapture('aborted');
            this.clearReplayWatchState();
            this.cancelBattleAsyncWork();
            this.dropGroundBake();
            this.pendingHomecoming = null;
            this.currentEnemyWorld = null;
            this.villageLife?.clear();
            this.villageBubbles?.teardown();
            this.stopCameraFrameSync?.();
            this.stopCameraFrameSync = null;
            this.dayNight?.clearLights();
            this.weather?.destroy();
            this.worldMap?.teardown();
            this.time.removeAllEvents();
            this.tweens.killAll();
            window.removeEventListener('clash:attack-invalidated', onAttackInvalidated);
            window.removeEventListener('clash:world-synced', onWorldSynced);
            window.removeEventListener('clash:banner-changed', onBannerChanged);
            window.removeEventListener('clash:design-changed', onDesignChanged);
            gameManager.clearScene();
            particleManager.clearAll();
        };
        // A normal scene stop emits shutdown; destroying the Phaser.Game can
        // go straight to destroy. Clean external DOM/audio state in both paths.
        this.events.once(Phaser.Scenes.Events.SHUTDOWN, cleanupScene);
        this.events.once(Phaser.Scenes.Events.DESTROY, cleanupScene);

        particleManager.init(this);
        soundSystem.attach();
        this.villageLife = new VillageLifeSystem(this);
        this.villageBubbles = new VillageBubbles(this);
        this.dayNight = new DayNightSystem(this);
        this.weather = new WeatherSystem(this);
        this.worldMap = new WorldMapSystem(this);
        // World-anchored DOM (bubbles, and any tag that tracks the world)
        // positions on POST_RENDER — never in update(), whose worldView is a
        // frame stale during drags.
        this.stopCameraFrameSync = onCameraFrame(cam => {
            this.villageBubbles?.reposition(cam);
        });
        this.dayNight.setLanternProvider(() => this.villageLife.getLanternPositions());
        // One sky for everything: rain dims the hearths and sends everyone indoors.
        this.weather.onRainChange((raining) => {
            this.villageLife.setRain(raining);
        });

        this.tempGraphics = this.add.graphics().setVisible(false);
        this.createIsoGrid();
        // Center immediately so the first rendered frame is in the village center.
        this.centerCamera();
        this.createUI();

        this.selectionGraphics = this.add.graphics();
        this.ghostBuilding = this.add.graphics();
        this.ghostBuilding.setVisible(false);

        this.deploymentGraphics = this.add.graphics();
        this.deploymentGraphics.setVisible(false);

        this.forbiddenGraphics = this.add.graphics();
        this.forbiddenGraphics.setDepth(5);
        this.forbiddenGraphics.setVisible(false);

        // Interaction overlays (selection ring, placement ghost, deploy zones)
        // are intentionally smooth UI feedback — never pixel-snapped.

        if (this.input.keyboard) {
            this.cursorKeys = this.input.keyboard.createCursorKeys();
            // createCursorKeys() registers key CAPTURES (arrows, Space,
            // Shift) that preventDefault at the keyboard-manager level —
            // before any DOM input sees the event. The isTypingInDomField
            // guards silence game ACTIONS while typing, but captures still
            // swallowed the characters (Space never reached the Village
            // Name field). Release global capture while a DOM text field
            // owns the keyboard; restore it when focus returns to the game.
            const syncKeyCapture = () => {
                const kb = this.input.keyboard;
                if (!kb) return;
                if (this.isTypingInDomField()) kb.disableGlobalCapture();
                else kb.enableGlobalCapture();
            };
            document.addEventListener('focusin', syncKeyCapture);
            document.addEventListener('focusout', syncKeyCapture);
            this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
                document.removeEventListener('focusin', syncKeyCapture);
                document.removeEventListener('focusout', syncKeyCapture);
            });
            this.input.keyboard.on('keydown-ESC', () => {
                // Same focus guard as App.tsx's M-key: typing in a DOM field
                // (username, chat...) must never leak hotkeys into the game.
                if (this.isTypingInDomField()) return;
                this.cancelPlacement();
            });
            // NOTE: no keydown-M here. The ONE move-building hotkey path is
            // App.tsx's window listener (which also guards typing in inputs)
            // -> gameManager.moveSelectedBuilding() -> the scene command
            // registered below. A second Phaser-side binding used to run a
            // divergent copy of the move side effects on every M press.
        }

        this.input.on('gameout', (_time: number, event: MouseEvent | TouchEvent | undefined) => {
            // 'gameout' fires whenever the pointer leaves the CANVAS —
            // including onto DOM HUD elements floating over the lawn (the
            // shield bubble, panels, toasts). Crossing those must not
            // silently drop a carried building or a shop placement:
            // relatedTarget is the DOM element the pointer entered, so only
            // a true exit from the page (relatedTarget null) cancels.
            const related = event && 'relatedTarget' in event ? event.relatedTarget : null;
            if (related) return;
            if (this.selectedBuildingType || this.isMoving) {
                this.cancelPlacement();
            }
        });

        // Right-click to cancel building placement/movement
        this.input.on('pointerdown', (pointer: Phaser.Input.Pointer) => {
            if (pointer.rightButtonDown()) {
                if (this.selectedBuildingType || this.isMoving) {
                    this.cancelPlacement();
                }
            }
        });

        this.sceneReadyForBaseLoad = true;

        // Base load is commanded by App once auth/session initialization is complete.
    }

    private centerCamera() {
        const centerGrid = this.mapSize / 2;
        const pos = IsoUtils.cartToIso(centerGrid, centerGrid);
        const cam = this.cameras.main;
        // Every mode transition lands here behind cloud cover (attack swap,
        // replay start, homecoming): a camera parked at the watchtower's
        // zoomed-out world view — or any stale battle zoom — must not carry
        // over, so the recenter snaps zoom back to the boot default too.
        this.cancelPendingZoomSettle();
        cam.zoomEffect.reset();
        const defaultZoom = zoomSettleEnabled()
            ? settleLogicalZoom(MobileUtils.getDefaultZoom(), getRenderScale())
            : MobileUtils.getDefaultZoom();
        cam.setZoom(toBackingZoom(defaultZoom));
        cam.centerOn(pos.x, pos.y);
        this.hasUserMovedCamera = false;
        // The nameplate's on-screen clamp depends on the final framing, and
        // updateVillageName often runs before this recenter — lay it out
        // again now that scroll/zoom are settled.
        this.layoutVillageNameLabel();
    }

    /**
     * The gesture zoom floor: wheel/pinch zoom-out stops once the view holds
     * the village plot, its meadow apron and the near cloud bank — the far
     * world is reached through the watchtower world view (showNeighborhood),
     * never by scrolling out into the haze. Cover-fit (max ratio) so neither
     * axis ever shows more than the apron square; clamped so a tiny window
     * can still zoom out at least a little from the default.
     */
    public minGestureZoom(): number {
        const camera = this.cameras.main;
        const APRON_TILES = 16; // slightly wider meadow/fog ring for more zoom-out headroom
        const CLOUD_HEADROOM = 130; // world px: cloud puffs stand above their base line
        const span = this.mapSize + APRON_TILES * 2;
        const fit = Math.max(
            cameraCssWidth(camera) / (span * TILE_WIDTH),
            cameraCssHeight(camera) / (span * TILE_HEIGHT + CLOUD_HEADROOM)
        );
        return Phaser.Math.Clamp(fit, MobileUtils.getMinZoom(), MobileUtils.getDefaultZoom() * 0.92);
    }

    private cancelPendingZoomSettle() {
        this.zoomSettleTimer?.remove(false);
        this.zoomSettleTimer = null;
        this.zoomSettleTween?.stop();
        this.zoomSettleTween = null;
    }

    /**
     * 'snap' mode only: after a wheel/pinch gesture, ease the camera to the
     * nearest zoom where one baked texel spans a whole number of backing
     * pixels (settleLogicalZoom), so texel columns stay even. Debounced —
     * a gesture burst settles once. Called from the wheel handler here and
     * by SceneInputController when a pinch ends.
     */
    public settleZoomAfterGesture() {
        if (!zoomSettleEnabled()) return;
        this.cancelPendingZoomSettle();
        this.zoomSettleTimer = this.time.delayedCall(180, () => {
            this.zoomSettleTimer = null;
            // A live gesture still owns the camera — wait it out.
            if (this.inputController?.isPinchGesture() || this.input.activePointer.isDown) {
                this.settleZoomAfterGesture();
                return;
            }
            const camera = this.cameras.main;
            const currentZoom = toLogicalZoom(camera.zoom);
            // Mirror the gesture handlers: a camera legitimately parked below
            // the gesture floor (watchtower world view) is never yanked up.
            if (currentZoom < this.minGestureZoom()) return;
            const target = Phaser.Math.Clamp(
                settleLogicalZoom(currentZoom, getRenderScale()),
                this.minGestureZoom(),
                MobileUtils.getMaxZoom()
            );
            if (Math.abs(target - currentZoom) <= 0.0005) return;
            this.zoomSettleTween = this.tweens.add({
                targets: camera,
                zoom: toBackingZoom(target),
                duration: 120,
                ease: 'Sine.easeOut',
                onComplete: () => { this.zoomSettleTween = null; }
            });
        });
    }

    /**
     * WeatherSystem probe: what does a raindrop land on at a scene-grid
     * point? The live plot is lawn or a standing roof; everything beyond it
     * defers to the world map's lake/river/brook geometry.
     */
    public rainSurfaceAt(gx: number, gy: number): 'water' | 'bank' | 'grass' | 'blocked' {
        if (gx >= 0 && gy >= 0 && gx < this.mapSize && gy < this.mapSize) {
            const tx = Math.floor(gx);
            const ty = Math.floor(gy);
            for (const building of this.buildings) {
                if (building.health <= 0) continue;
                const info = BUILDING_DEFINITIONS[building.type as BuildingType];
                if (!info) continue;
                if (tx >= building.gridX && tx < building.gridX + info.width
                    && ty >= building.gridY && ty < building.gridY + info.height) {
                    return 'blocked';
                }
            }
            return 'grass';
        }
        return this.worldMap?.rainSurfaceAt(gx, gy) ?? 'grass';
    }

    private showNeighborhood() {
        if (this.mode !== 'HOME') return;
        // Same completion gate as WorldMapSystem.computeViewRadius: a tower
        // whose placement scaffold is still up has earned no sight yet.
        const completed = this.buildings.filter(b => b.health > 0
            && !(b.type === 'watchtower' && this.villageLife?.isPlacementUnderConstruction(b.id)));
        const sight = watchtowerSightOf(completed as unknown as SerializedBuilding[]);
        if (sight <= 0) {
            gameManager.showToast('Build a Watchtower to discover the surrounding world.');
            return;
        }

        const camera = this.cameras.main;
        // Fit the complete discovered square, including the outer plot edges,
        // instead of relying on a desktop-only magic zoom.  The isometric
        // diamond is twice as wide as it is tall, so narrow phones are the
        // limiting case and may legitimately need to zoom below the normal
        // gesture floor for this one overview transition.
        const minGrid = -sight * PLOT_PITCH;
        const maxGrid = sight * PLOT_PITCH + this.mapSize;
        const corners = [
            IsoUtils.cartToIso(minGrid, minGrid),
            IsoUtils.cartToIso(maxGrid, minGrid),
            IsoUtils.cartToIso(minGrid, maxGrid),
            IsoUtils.cartToIso(maxGrid, maxGrid)
        ];
        const worldWidth = Math.max(...corners.map(point => point.x))
            - Math.min(...corners.map(point => point.x));
        const worldHeight = Math.max(...corners.map(point => point.y))
            - Math.min(...corners.map(point => point.y));
        const horizontalInset = MobileUtils.isMobile() ? 28 : 88;
        const verticalInset = MobileUtils.isMobile() ? 148 : 128;
        const fitZoom = Math.min(
            Math.max(1, cameraCssWidth(camera) - horizontalInset) / Math.max(1, worldWidth),
            Math.max(1, cameraCssHeight(camera) - verticalInset) / Math.max(1, worldHeight)
        );
        const neighborhoodZoom = Phaser.Math.Clamp(
            fitZoom * 0.96,
            0.035,
            Math.min(MobileUtils.getDefaultZoom(), sight >= 2 ? 0.24 : 0.42)
        );
        const openingWorld = toLogicalZoom(camera.zoom) > neighborhoodZoom + 0.06;
        const targetZoom = openingWorld ? neighborhoodZoom : MobileUtils.getDefaultZoom();
        const centerGrid = this.mapSize / 2;
        const center = IsoUtils.cartToIso(centerGrid, centerGrid);
        camera.centerOn(center.x, center.y);
        camera.zoomTo(toBackingZoom(targetZoom), 500, 'Sine.easeInOut');
        this.hasUserMovedCamera = true;

        if (openingWorld) {
            void this.worldMap.prime(this.time.now);
            gameManager.showToast('World view — tap a village or wilderness plot to explore.');
        }
    }

    public cancelPlacement() {
        if (this.isMoving && this.selectedInWorld) {
            this.bakeBuildingToGround(this.selectedInWorld);
            // The carry hid the carrier (and with it the baked shadow sprite).
            this.selectedInWorld.graphics.setVisible(true);
            this.selectedInWorld.baseGraphics?.setVisible(true);
        }
        this.selectedBuildingType = null;
        this.isMoving = false;
        this.ghostGridPos = null;
        this.ghostBuilding.clear();
        this.ghostBuilding.setVisible(false);
        this.selectedInWorld = null;
        this.clearBuildingRangeIndicator();
        gameManager.onPlacementCancelled();
    }

    /** Errors this frame are logged (throttled) and the frame is skipped —
     *  the game loop itself must never die to a single bad update. */
    private updateErrorCount = 0;
    private lastUpdateErrorLogAt = 0;

    update(time: number, delta: number) {
        try {
            this.updateCore(time, delta);
        } catch (error) {
            this.updateErrorCount += 1;
            if (time - this.lastUpdateErrorLogAt > 5000) {
                this.lastUpdateErrorLogAt = time;
                console.error(`[bulkhead] update() error #${this.updateErrorCount} (frame skipped, loop alive):`, error);
            }
        }
    }

    private updateCore(time: number, delta: number) {
        // A road caravan owns a durable battle session before the scene flips
        // from HOME to ATTACK, so keep the tab lease alive through the march
        // and focus/save waits too. The backend no-ops when no session exists.
        Backend.heartbeatActiveBattle();

        if (this.mode === 'REPLAY') {
            this.handleCameraMovement(delta);
            this.updateReplayWatchPlayback(time, delta);
            this.updateReplayTroopSmoothing(delta);
            this.updateCombat(this.animClockNow());
            this.updateSpikeZones();
            this.refreshBuildingHealthBars();
            // Building redraws measure firing/charge ages, so they ride the
            // replay clock — the same one the defense sim stamps with.
            this.updateBuildingAnimations(this.animClockNow());
            this.updateHallBanner(time);
            this.updateObstacleAnimations(time);
            this.updateRubbleAnimations(time);
            this.dayNight.update(time);
            this.weather.update(time);
            this.dayNight.setRainFactor(this.weather.rainFactor());
            this.maybeQuantizeGround(time);
            this.worldMap.update(time);
            // Carrier→shadow reconciliation runs LAST in every mode, once all
            // systems have moved/hidden/faded their carriers this frame.
            SpriteBank.update(time);
            return;
        }

        this.checkBattleEnd();

        // Partial structural damage moves the (HP-weighted) loot counter
        // between destructions too — refresh on a coarse tick, not per hit.
        if (this.mode === 'ATTACK' && this.hasDeployed && time >= this.nextBattleStatsRefreshAt) {
            this.nextBattleStatsRefreshAt = time + 250;
            this.updateBattleStats();
        }

        this.handleCameraMovement(delta);
        // Clock-driven input repeats (hold-to-deploy) — event handlers only
        // fire on pointer MOVEMENT, and a still hold must keep deploying.
        this.inputController.update();
        this.updateCombat(time);
        this.updateSpikeZones();
        this.updateTroops(delta);
        this.maybePushReplayFrame();
        this.refreshBuildingHealthBars();
        this.updateSelectionHighlight();
        this.updateDeploymentHighlight();
        this.updateBuildingAnimations(time);
        this.updateHallBanner(time);
        this.updateObstacleAnimations(time);
        this.dayNight.update(time);
        this.weather.update(time);
        this.dayNight.setRainFactor(this.weather.rainFactor());
        this.stepGroundBake();
        this.maybeQuantizeGround(time);
        this.worldMap.update(time);
        this.villageBubbles.update(time);
        soundSystem.setNightFactor(this.dayNight.nightFactor());
        // The audible wind rides the same gust field the flags sample (throttled).
        if (time >= this.nextAmbienceAt) {
            this.nextAmbienceAt = time + 240;
            const cam = this.cameras.main;
            soundSystem.setWindLevel(Math.max(0, windAtScreen(cam.worldView.centerX, cam.worldView.centerY, time)));
        }
        this.villageLife.setNightMode(this.mode === 'HOME' && this.dayNight.nightFactor() > 0.6);
        this.villageLife.update(time, delta);
        this.growGrass(time);
        this.updateRubbleAnimations(time);
        this.resolveLocalUpgrades(time);
        // Carrier→shadow reconciliation runs LAST: every baked sprite copies
        // its carrier's position/depth/alpha/visibility/scale after all the
        // systems above have moved, hidden or faded their carriers. Nothing
        // else propagates carrier changes between stamps (this also reaps
        // dead carriers at 1 Hz — the old standalone sweep call).
        SpriteBank.update(time);
    }

    /**
     * The village banner on the town hall's ROOF flagpole — the same heraldry
     * the war camp carries and the world-map postcards fly (owner priority
     * #1). The baked hall sprite ships only the gold apex ball (the old baked
     * red pennant was removed from the vector art); the real cloth is redrawn
     * per frame here (a pure function of time via drawVillageFlag) so it
     * always shows the OWNER's banner at home and the DEFENDER's during
     * raids/replays, hot-swapping on 'clash:banner-changed'. The pole foot
     * plants on the apex ball — drawTownHall's story (24) + roof (30) put the
     * apex at centre − 54, ball centre at − 55 — and the pole/cloth sizes
     * reproduce the old baked flag's visual weight (pole to peak − 17, cloth
     * ~15 × 9.5 from peak − 16.5 down). One depth step above the hall keeps
     * the cloth over its own roof without crossing the next iso row.
     * A destroyed hall drops its standard.
     */
    private updateHallBanner(time: number) {
        const meta = this.villageBannerMeta;
        const hall = meta ? this.buildings.find(b => b.type === 'town_hall' && b.health > 0) : undefined;
        if (!meta || !hall) {
            if (this.hallBannerGfx) {
                this.hallBannerGfx.destroy();
                this.hallBannerGfx = null;
            }
            return;
        }
        const key = `${meta.identity}|${meta.banner ? `${meta.banner.palette}.${meta.banner.emblem}.${meta.banner.pattern ?? 'd'}` : 'default'}`;
        if (!this.hallBannerDesign || this.hallBannerDesignKey !== key) {
            this.hallBannerDesign = bannerDesignFor(meta.identity, meta.banner);
            this.hallBannerDesignKey = key;
        }
        if (!this.hallBannerGfx) this.hallBannerGfx = this.add.graphics();
        const def = BUILDINGS[hall.type];
        const apex = IsoUtils.cartToIso(
            hall.gridX + (def?.width ?? 3) / 2,
            hall.gridY + (def?.height ?? 3) / 2
        );
        const g = this.hallBannerGfx;
        g.clear();
        g.setDepth(depthForBuilding(hall.gridX, hall.gridY, 'town_hall') + 1);
        drawVillageFlag(g, apex.x, apex.y - 55, time, this.hallBannerDesign, 1,
            { poleH: 16, clothW: 15, clothH: 9.5 });
    }

    /**
     * Land matured upgrade timers locally (the server does the same on its
     * next read — resolveUpgrades in server/game.ts; both derive the same
     * level from the same deadline, so they never disagree).
     */
    private resolveLocalUpgrades(_time: number) {
        if (this.mode !== 'HOME') return;
        const now = this.serverEpochNow();
        for (const b of this.buildings) {
            if (this.pendingUpgradeAuthority.has(b.id)) continue;
            if (!b.upgradingTo || (b.upgradeEndsAt ?? 0) > now) continue;
            const target = Math.min(b.upgradingTo, BUILDINGS[b.type]?.maxLevel ?? b.upgradingTo);
            this.completeLocalUpgrade(b, target, now);
        }
    }

    private serverEpochNow(): number {
        return Date.now() + DayNightSystem.serverOffsetMs;
    }

    private completeLocalUpgrade(b: PlacedBuilding, target: number, now: number) {
        const completedAt = Number.isFinite(Number(b.upgradeEndsAt)) ? Number(b.upgradeEndsAt) : now;
        b.upgradingTo = undefined;
        b.upgradeEndsAt = undefined;
        delete (b as UpgradeTimedPlacedBuilding).upgradeStartedAt;
        b.level = Math.min(target, BUILDINGS[b.type]?.maxLevel ?? target);
        b.builtAt = completedAt;
        // Backend owns the durable save, but its in-memory cache must mature
        // with the live scene. Otherwise the next rapid dev upgrade sees the
        // stale `upgradingTo` marker and returns before sending a save; balance
        // syncs would also keep cloning/rebroadcasting that stale timer.
        const cached = Backend.getCachedWorld(this.userId);
        const cachedBuilding = cached?.buildings.find(candidate => candidate.id === b.id);
        if (cachedBuilding) {
            cachedBuilding.level = Math.max(cachedBuilding.level ?? 1, b.level);
            cachedBuilding.builtAt = completedAt;
            cachedBuilding.upgradingTo = undefined;
            cachedBuilding.upgradeEndsAt = undefined;
            delete (cachedBuilding as UpgradeTimedSerializedBuilding).upgradeStartedAt;
        }
        const stats = getBuildingStats(b.type as BuildingType, b.level);
        b.maxHealth = stats.maxHealth;
        b.health = stats.maxHealth;
        b.graphics.clear();
        if (b.baseGraphics) b.baseGraphics.clear();
        this.drawBuildingVisuals(b.graphics, b.gridX, b.gridY, b.type, 1, null, b, b.baseGraphics);
        this.updateHealthBar(b);
        this.unbakeBuildingFromGround(b);
        this.bakeBuildingToGround(b);
        // A live scaffold owns the topping-out celebration. Hydrated upgrades
        // without a site still get the compact legacy sparkle as a fallback.
        if (!this.villageLife.completeConstruction(b)) this.playUpgradeEffect(b);
        if (b.type === 'army_camp') {
            const campLevels = this.buildings.filter(x => x.type === 'army_camp').map(x => x.level ?? 1);
            gameManager.refreshCampCapacity(campLevels);
        }
        if (b.type === 'lab' && b.owner === 'PLAYER') {
            this.playerLabLevel = Math.max(this.playerLabLevel, b.level);
        }
        // The bubble may be open on this building: refresh it to the finished
        // level so the countdown gives way to the new stats.
        if (this.selectedInWorld === b) {
            gameManager.onBuildingSelected({ id: b.id, type: b.type as BuildingType, level: b.level, gridX: b.gridX, gridY: b.gridY });
        }
    }

    /** Reconcile only upgrade clock fields from a merged server world. Layout
     *  edits stay under the existing Backend rebase path and are not applied here. */
    private reconcileUpgradeAuthority(world: SerializedWorld) {
        if (this.mode !== 'HOME' || (world.ownerId && world.ownerId !== this.userId)) return;
        const remoteById = new Map(world.buildings.map(building => [building.id, building as UpgradeTimedSerializedBuilding]));
        const now = this.serverEpochNow();
        for (const b of this.buildings) {
            if (b.owner !== 'PLAYER') continue;
            const remote = remoteById.get(b.id);
            if (!remote) continue;
            const localTiming = b as UpgradeTimedPlacedBuilding;
            const target = Number(remote.upgradingTo);
            const endsAt = Number(remote.upgradeEndsAt);
            if (Number.isFinite(target) && target > 0 && Number.isFinite(endsAt)) {
                // A duplicate pending snapshot can arrive after this client
                // already landed the same deadline. Never resurrect its site
                // or replay the topping-out celebration.
                if (!b.upgradingTo && b.level >= target) {
                    this.pendingUpgradeAuthority.delete(b.id);
                    continue;
                }
                const remoteStart = Number(remote.upgradeStartedAt);
                const localStart = Number(localTiming.upgradeStartedAt);
                const fallbackDuration = serverUpgradeDurationMs(b.type, target);
                localTiming.upgradeStartedAt = Number.isFinite(remoteStart)
                    ? remoteStart
                    : (Number.isFinite(localStart) ? localStart : endsAt - fallbackDuration);
                b.upgradingTo = Math.floor(target);
                b.upgradeEndsAt = endsAt;
                this.pendingUpgradeAuthority.delete(b.id);
                if (endsAt <= now) this.completeLocalUpgrade(b, b.upgradingTo, now);
                else this.villageLife.syncUpgradeConstruction(b);
                continue;
            }

            if (!b.upgradingTo) continue;
            const localTarget = b.upgradingTo;
            const remoteLevel = Number(remote.level);
            const remoteBuiltAt = Number(remote.builtAt);
            const localEndsAt = Number(b.upgradeEndsAt);
            // An unrelated earlier response can arrive while this optimistic
            // save is in flight. Only a pending timer or the completed target
            // with a NEW server completion stamp is proof that this particular
            // upgrade reached authority; balance-only syncs clone the old stamp.
            const provesCompletedUpgrade = Number.isFinite(remoteLevel) && remoteLevel >= localTarget
                && Number.isFinite(remoteBuiltAt) && Number.isFinite(localEndsAt)
                && remoteBuiltAt >= localEndsAt;
            if (this.pendingUpgradeAuthority.has(b.id) && !provesCompletedUpgrade) continue;
            this.pendingUpgradeAuthority.delete(b.id);
            if (Number.isFinite(remoteLevel) && remoteLevel >= localTarget) {
                this.completeLocalUpgrade(b, localTarget, now);
            } else {
                b.upgradingTo = undefined;
                b.upgradeEndsAt = undefined;
                delete localTiming.upgradeStartedAt;
                this.villageLife.cancelConstruction(b.id);
            }
        }
    }

    private refreshBuildingHealthBars() {
        this.buildings.forEach(building => {
            if (building.isDestroyed) return;
            // Optional-chained: a building with a missing/destroyed bar must
            // not throw here — one bad entry would freeze every later
            // building's bar mid-fade for the rest of the battle (the
            // update() bulkhead swallows the error each frame).
            if (building.health >= building.maxHealth && !building.healthBar?.visible) return;
            this.updateHealthBar(building);
        });
    }

    private checkBattleEnd() {
        // Only check if we are attacking and have started deploying
        if (this.mode !== 'ATTACK' || !this.hasDeployed || this.raidEndScheduled) return;

        // End-of-battle is not frame-sensitive; scanning armies/troops/buildings
        // 4x per second instead of every frame is imperceptible (≤250ms delay).
        if (this.time.now < this.nextBattleEndCheckAt) return;
        this.nextBattleEndCheckAt = this.time.now + 250;

        // 1. Check Army Remaining (troops not yet converted to entities)
        const army = gameManager.getArmy();
        const armyRemaining = Object.values(army).reduce((total: number, count: any) => total + (typeof count === 'number' ? count : 0), 0) as number;

        // 2. Check Active Troops (entities on the field)
        // We filter by health > 0 to exclude dying troops that might still be in the array for animation handling
        const activeTroops = this.troops.filter(t => t.health > 0).length;

        const { remaining } = this.getBattleTotals();

        // Debug info (console logs would be visible in browser)
        // console.log(`Battle State: Army: ${armyRemaining}, Active: ${activeTroops}, Remaining: ${remaining}`);

        // END CONDITION:
        // A) No reinforcements left AND no troops fighting AND no pending spawns (splits)
        // B) Base is 100% destroyed (no non-wall buildings remain)
        const noEnemiesRemaining = remaining === 0 && (this.destroyedBuildings > 0 || this.initialEnemyBuildings > 0);
        if ((armyRemaining <= 0 && activeTroops === 0 && this.pendingSpawnCount === 0) || noEnemiesRemaining) {
            this.raidEndScheduled = true;

            // 2-second delay to let final animations play / player realize what happened
            const raidEpoch = this.battleEpoch;
            this.scheduleBattleCall(2000, () => {
                void (async () => {
                    // Settle AFTER the grace window, not before it: splash
                    // damage, burn ticks and deaths landing in these 2 seconds
                    // must reach the final replay frame and the server
                    // settlement. (A retreat during the grace cancels this
                    // timer and settles through goHome instead.)
                    const settlement = this.endAttackReplayCapture('finished');
                    // The authoritative balance/army revision must land before
                    // React switches HUDs or home reload reads the cache.
                    let settlementDelayed = false;
                    const attackResult = await settlement?.catch(error => {
                        console.warn('Attack settlement failed before raid handoff:', error);
                        settlementDelayed = true;
                        return null;
                    }) ?? null;
                    // World-map bot camps settle server-side (capped loot on a
                    // cooldown + troop consumption) BEFORE the payout reaches
                    // the UI — the number shown is the number banked.
                    let payout = Math.max(0, Math.floor(attackResult?.lootApplied ?? 0));
                    if (this.currentEnemyWorld?.isBot) {
                        try {
                            payout = await this.settleBotRaid();
                        } catch {
                            payout = 0;
                            // Only a real pending camp settlement is "delayed";
                            // practice drills settle nothing.
                            settlementDelayed = settlementDelayed
                                || (!!this.currentEnemyWorld?.botRaidId && !this.botRaidSettled);
                        }
                    }
                    if (raidEpoch !== this.battleEpoch || this.mode !== 'ATTACK') return;
                    // Trigger the end sequence via the game manager callback (same pathway as "Return Home").
                    let handled = false;
                    try {
                        // Pass the server-APPLIED ore/food alongside the gold
                        // payout: the client battle counters over-count (loot
                        // caps, concurrent raids), and the report must show
                        // what was actually banked. A transport failure is NOT
                        // a zero payout — flag it so the report reads
                        // "settling" instead of a false 0 (the loot still
                        // lands when the settlement goes through).
                        handled = gameManager.onRaidEnded(payout, {
                            ore: attackResult?.oreApplied,
                            food: attackResult?.foodApplied,
                            settlementDelayed: settlementDelayed || undefined
                        });
                    } catch (error) {
                        console.error('onRaidEnded handler failed:', error);
                    }
                    if (!handled) {
                        // Every retreat — battles-in-place included — closes
                        // behind the clouds; nobody walks the roads home.
                        this.showCloudTransition(async () => {
                            gameManager.setGameMode('HOME');
                            await this.goHome();
                        });
                    }
                })();
            });
        }
    }

    private getDefenseStats(def: PlacedBuilding) {
        return getBuildingStats(def.type as BuildingType, def.level || 1);
    }

    private isOffScreen(gridX: number, gridY: number, _size: number = 1): boolean {
        const iso = IsoUtils.cartToIso(gridX, gridY);
        // Add significant padding for effects/UI
        const padding = 200;
        const cam = this.cameras.main;

        // Simple screen bounds check
        // Note: iso coordinates are world space, camera scroll is top-left
        // But we need to account for zoom. WorldView is easiest.
        const view = cam.worldView;

        return (iso.x < view.x - padding ||
            iso.x > view.x + view.width + padding ||
            iso.y < view.y - padding ||
            iso.y > view.y + view.height + padding);
    }

    private updateBuildingAnimations(time: number) {
        this.buildingAnimFrame = (this.buildingAnimFrame + 1) % 3;

        // Redraw all buildings for idle animations
        this.buildings.forEach(b => {
            const shouldAnimateBuilding = this.mode === 'ATTACK' || this.mode === 'REPLAY' || b.owner === 'PLAYER';
            if (shouldAnimateBuilding) {
                if (this.isOffScreen(b.gridX, b.gridY, (BUILDINGS[b.type]?.width || 1))) return;

                // Hide original building if being moved (ghost is shown instead).
                // clear() only empties the vector art — the baked shadow sprite
                // follows carrier VISIBILITY (SpriteBank.update), so hide the
                // carrier too or the sprite stays behind as a second copy.
                if (this.isMoving && this.selectedInWorld === b) {
                    b.graphics.clear();
                    b.graphics.setVisible(false);
                    b.baseGraphics?.clear();
                    b.baseGraphics?.setVisible(false);
                    return;
                }
                // Self-heal after the carry ends by ANY path (drop, cancel,
                // shop selection): a live building draws visible.
                if (!b.graphics.visible && !b.isDestroyed && b.health > 0) {
                    b.graphics.setVisible(true);
                    b.baseGraphics?.setVisible(true);
                }

                // Smoothly interpolate ballista, xbow, and cannon angle towards target
                // OR towards mouse if selected in HOME mode
                let targetAngle = b.ballistaTargetAngle;

                if (this.mode === 'HOME' && this.selectedInWorld === b &&
                    (b.type === 'ballista' || b.type === 'xbow' || b.type === 'cannon')) {
                    const info = BUILDINGS[b.type];
                    const center = IsoUtils.cartToIso(b.gridX + info.width / 2, b.gridY + info.height / 2);
                    const pointer = this.input.activePointer;
                    const worldPoint = this.cameras.main.getWorldPoint(pointer.x, pointer.y);
                    targetAngle = Math.atan2(worldPoint.y - (center.y - 14), worldPoint.x - center.x);
                }

                if ((b.type === 'ballista' || b.type === 'xbow' || b.type === 'cannon') && targetAngle !== undefined) {
                    const currentAngle = b.ballistaAngle ?? 0;

                    // Calculate shortest rotation direction
                    let diff = targetAngle - currentAngle;
                    while (diff > Math.PI) diff -= Math.PI * 2;
                    while (diff < -Math.PI) diff += Math.PI * 2;

                    // Smooth rotation (adjust speed as needed)
                    const rotationSpeed = 0.15;
                    if (Math.abs(diff) > 0.01) {
                        b.ballistaAngle = currentAngle + diff * rotationSpeed;
                    } else {
                        b.ballistaAngle = targetAngle;
                    }
                }

                // === IDLE SWIVEL for rotating defenses ===
                // When not firing, swivel on an absolute, seeded clock. This
                // remains identical at 30/60/144fps and across redraw skips.
                // A frozen turret (ice golem freeze-on-death) holds its
                // bearing solid — no idle swivel while the ice grips it.
                if ((b.type === 'ballista' || b.type === 'xbow' || b.type === 'cannon') && !b.isFiring
                    && !(b.frozenUntil !== undefined && time < b.frozenUntil)) {
                    // Shots stamp ballistaTargetAngle but nothing ever cleared
                    // it, so turrets froze on their last combat bearing
                    // forever. Release it after a target-less grace (one fire
                    // interval plus slack) so the ambient swivel resumes.
                    if (b.ballistaTargetAngle !== undefined
                        && time - (b.lastFireTime ?? 0) > (this.getDefenseStats(b).fireRate || 2500) + 1500) {
                        b.ballistaTargetAngle = undefined;
                    }
                    // Only apply idle swivel if no combat target
                    if (b.ballistaTargetAngle === undefined) {
                        const seed = hashString(`${b.id}:idle-swivel`);
                        const base = (seed / 0xffffffff) * Math.PI * 2;
                        const phase = time * 0.00024 + (seed % 8192) * 0.001;
                        const idleAngle = base
                            + Math.sin(phase) * 0.34
                            + Math.sin(phase * 0.47 + 1.7) * 0.14;
                        b.idleTargetAngle = idleAngle;
                        // Re-entry from a combat bearing eases back; once
                        // converged the swivel is a pure function of absolute
                        // time again (framerate-independent).
                        const currentIdle = b.ballistaAngle ?? idleAngle;
                        let drift = idleAngle - currentIdle;
                        while (drift > Math.PI) drift -= Math.PI * 2;
                        while (drift < -Math.PI) drift += Math.PI * 2;
                        b.ballistaAngle = Math.abs(drift) > 0.05
                            ? currentIdle + drift * 0.08
                            : idleAngle;
                    }
                }

                // Transparency near cursor (ghost building)
                let alpha = 1;
                if (this.mode === 'HOME' && this.selectedBuildingType) {
                    const dist = Phaser.Math.Distance.Between(b.gridX, b.gridY, this.hoverGrid.x, this.hoverGrid.y);
                    if (dist < 4) alpha = 0.4;
                }

                // Production fill for mines/farms: builds over ~90s, harvested by
                // the delivery runs. Purely visual progress/aesthetics.
                if (b.type === 'mine' || b.type === 'farm') {
                    if (b.lastHarvestAt === undefined) {
                        // Seeded starting phase so fields do not ripen in lockstep.
                        b.lastHarvestAt = this.time.now - (hashString(`${b.id}:harvest-phase`) % 90_000);
                    }
                    b.fillLevel = Math.min(1, (this.time.now - b.lastHarvestAt) / 90_000);
                }

                // Ease the door toward open while a villager is passing through it.
                const doorTarget = (b.doorOpenUntil ?? 0) > this.time.now ? 1 : 0;
                const doorCurrent = b.doorOpen ?? 0;
                if (Math.abs(doorTarget - doorCurrent) > 0.001) {
                    b.doorOpen = doorCurrent + (doorTarget - doorCurrent) * 0.16;
                    if (Math.abs(doorTarget - b.doorOpen) < 0.02) b.doorOpen = doorTarget;
                }

                // Full vector re-tessellation is the most expensive per-frame cost in the
                // game, so redraw immediately only when something the player can notice
                // changed (turret angle, firing, hover alpha, damage state, selection).
                // Ambient time-based animation still ticks at 20fps via a per-building
                // stagger slot, which spreads the redraw cost across frames.
                if (b.drawStagger === undefined) b.drawStagger = hashString(`${b.id}:draw-stagger`) % 3;
                const angle = b.ballistaAngle ?? 0;
                const changed =
                    b.isFiring ||
                    this.selectedInWorld === b ||
                    alpha !== (b.lastDrawAlpha ?? 1) ||
                    b.health !== b.lastDrawHealth ||
                    Math.abs((b.doorOpen ?? 0) - (b.lastDrawDoorOpen ?? 0)) > 0.01 ||
                    Math.abs((b.fillLevel ?? 0) - (b.lastDrawFill ?? 0)) > 0.04 ||
                    Math.abs(angle - (b.lastDrawAngle ?? 0)) > 0.002;
                // Wall art has no time-driven state. Neighbor changes are
                // repainted explicitly by refreshWallNeighbors,
                // so an unchanged wall never needs the ambient stagger pass.
                if (!changed && b.type === 'wall') return;
                if (!changed && b.drawStagger !== this.buildingAnimFrame) return;
                b.lastDrawAngle = angle;
                b.lastDrawAlpha = alpha;
                b.lastDrawHealth = b.health;
                b.lastDrawDoorOpen = b.doorOpen ?? 0;
                b.lastDrawFill = b.fillLevel ?? 0;

                b.graphics.clear();
                b.baseGraphics?.clear();
                // If baseGraphics is missing (baked), skipBase=true. If present (moving), skipBase=false.
                this.drawBuildingVisuals(b.graphics, b.gridX, b.gridY, b.type, alpha, null, b, b.baseGraphics, !b.baseGraphics);

                // JUKEBOX: floating notes while a chosen track plays \u2014
                // hand-authored cell glyphs (quaver / beamed pair), not AA
                // text glyphs on the world layer. AUDIBLE state only: a
                // muted game emits no notes.
                if (b.type === 'jukebox' && soundSystem.overrideActive && !soundSystem.muted) {
                    const noteSlot = Math.floor(time / 900);
                    if (b.lastTrailTime !== noteSlot) {
                        b.lastTrailTime = noteSlot;
                        const noteRng = mulberry32(hashString(`${b.id}:jukebox-note:${noteSlot}`));
                        const notePos = IsoUtils.cartToIso(b.gridX + 0.5, b.gridY + 0.5);
                        const note = this.add.graphics();
                        const glyph = Math.floor(noteRng() * 2) === 0
                            ? ['.ff.', '.f.f', '.f..', '.f..', 'ff..', 'ff..']            // quaver
                            : ['ffffff', 'f....f', 'f....f', 'f....f', 'ff..ff', 'ff..ff']; // beamed pair
                        pixelBitmap(note, 0, 0, glyph, { f: 0xd8a8ff }, 1);
                        note.setPosition(notePos.x + 10, notePos.y - 38);
                        note.setDepth(b.graphics.depth + 2).setAlpha(0.9);
                        this.tweens.add({
                            targets: note,
                            y: note.y - 22,
                            x: note.x + (noteRng() - 0.5) * 16,
                            alpha: 0,
                            duration: 1600,
                            ease: 'Sine.easeOut',
                            onComplete: () => note.destroy()
                        });
                    }
                }
            }
        });
    }



    // Persistent state is now managed by Backend service automatically on modification

    private isWorldValid(world: SerializedWorld): boolean {
        if (!Array.isArray(world.buildings) || world.buildings.length === 0) return false;
        let hasValidBuilding = false;
        for (const building of world.buildings) {
            const normalizedType = this.normalizeBuildingType(String((building as { type?: unknown }).type ?? ''));
            if (!normalizedType) continue;
            const definition = BUILDINGS[normalizedType];
            if (!definition) continue;
            const rawX = Number((building as { gridX?: unknown }).gridX);
            const rawY = Number((building as { gridY?: unknown }).gridY);
            if (!Number.isFinite(rawX) || !Number.isFinite(rawY)) continue;
            hasValidBuilding = true;
        }
        return hasValidBuilding;
    }

    private applyWorldToScene(world: SerializedWorld): { requested: number; placed: number; playablePlaced: number } {
        const requested = Array.isArray(world.buildings) ? world.buildings.length : 0;
        let placed = 0;
        let playablePlaced = 0;

        // Clear existing graphics and state before instantiation
        this.clearScene();
        this.pendingUpgradeAuthority.clear();

        // The home lawn flies the OWNER's banner (explicit choice, or the
        // deterministic identity default when none was ever picked).
        this.villageBannerMeta = {
            identity: world.ownerId || this.userId,
            banner: world.banner ?? null
        };

        const maxWallFromWorld = (Array.isArray(world.buildings) ? world.buildings : []).reduce((max, building) => {
            const normalizedType = this.normalizeBuildingType(String((building as { type?: unknown }).type ?? ''));
            if (normalizedType !== 'wall') return max;
            return Math.max(max, Math.max(1, Number((building as { level?: unknown }).level) || 1));
        }, 1);
        const maxLabFromWorld = (Array.isArray(world.buildings) ? world.buildings : []).reduce((max, building) => {
            const normalizedType = this.normalizeBuildingType(String((building as { type?: unknown }).type ?? ''));
            if (normalizedType !== 'lab') return max;
            // Server rule (troopLevelOf): a lab mid-upgrade is offline and
            // grants no troop level until the work lands.
            if (Number((building as { upgradingTo?: unknown }).upgradingTo) > 0) return max;
            return Math.max(max, Math.max(1, Number((building as { level?: unknown }).level) || 1));
        }, 0);
        this.preferredWallLevel = Math.max(1, Math.max(world.wallLevel || 1, maxWallFromWorld));
        this.playerLabLevel = maxLabFromWorld;

        // Load buildings with strict per-building validation so one bad entry cannot blank the scene.
        (Array.isArray(world.buildings) ? world.buildings : []).forEach(rawBuilding => {
            const normalizedType = this.normalizeBuildingType(String((rawBuilding as { type?: unknown }).type ?? ''));
            if (!normalizedType) return;

            const definition = BUILDINGS[normalizedType];
            if (!definition) return;

            const rawX = Number((rawBuilding as { gridX?: unknown }).gridX);
            const rawY = Number((rawBuilding as { gridY?: unknown }).gridY);
            if (!Number.isFinite(rawX) || !Number.isFinite(rawY)) return;

            const gridX = Phaser.Math.Clamp(Math.floor(rawX), 0, Math.max(0, this.mapSize - definition.width));
            const gridY = Phaser.Math.Clamp(Math.floor(rawY), 0, Math.max(0, this.mapSize - definition.height));

            const rawLevel = Number((rawBuilding as { level?: unknown }).level ?? 1);
            const level = Number.isFinite(rawLevel) ? Math.max(1, Math.floor(rawLevel)) : 1;
            const id = typeof (rawBuilding as { id?: unknown }).id === 'string' && String((rawBuilding as { id?: unknown }).id).length > 0
                ? String((rawBuilding as { id?: unknown }).id)
                : Phaser.Utils.String.UUID();

            try {
                const rawUpgradeStartedAt = Number((rawBuilding as UpgradeTimedSerializedBuilding).upgradeStartedAt);
                const rawUpgradingTo = Number((rawBuilding as UpgradeTimedSerializedBuilding).upgradingTo);
                const rawUpgradeEndsAt = Number((rawBuilding as UpgradeTimedSerializedBuilding).upgradeEndsAt);
                const hydratedBuilding = {
                        id,
                        type: normalizedType,
                        gridX,
                        gridY,
                        level,
                        builtAt: Number.isFinite(Number((rawBuilding as { builtAt?: unknown }).builtAt))
                            ? Number((rawBuilding as { builtAt?: unknown }).builtAt)
                            : undefined,
                        ...(Number.isFinite(rawUpgradeStartedAt) ? { upgradeStartedAt: rawUpgradeStartedAt } : {}),
                        ...(Number.isFinite(rawUpgradingTo) && rawUpgradingTo > 0 ? { upgradingTo: Math.floor(rawUpgradingTo) } : {}),
                        ...(Number.isFinite(rawUpgradeEndsAt) ? { upgradeEndsAt: rawUpgradeEndsAt } : {})
                    } as UpgradeTimedSerializedBuilding;
                const inst = this.instantiateBuilding(hydratedBuilding, 'PLAYER');
                if (!inst) return;
                placed++;
                if (inst.type !== 'wall') {
                    playablePlaced++;
                }
            } catch (error) {
                console.error('applyWorldToScene: failed to instantiate player building', {
                    buildingId: id,
                    buildingType: normalizedType,
                    error
                });
            }
        });

        // Load obstacles from backend, or spawn some if none exist
        if (placed > 0 && world.obstacles && world.obstacles.length > 0) {
            world.obstacles.forEach(o => {
                this.placeObstacle(o.gridX, o.gridY, o.type, true, o.id); // skipBackend=true to prevent duplication
            });
        }

        const campLevels = this.buildings.filter(b => b.type === 'army_camp').map(b => b.level ?? 1);
        gameManager.refreshCampCapacity(campLevels);
        gameManager.closeMenus?.(); // Ensure UI is reset when loading
        // Bring the village to life: villagers, dogs, chickens, camp troops.
        // Head-count comes from the server-authoritative population when present.
        if (playablePlaced > 0 && this.mode === 'HOME') {
            this.villageLife.populate('PLAYER', {
                population: world.population?.count,
                identity: world.ownerId || this.userId,
                bornAt: world.population?.bornAt
            });
            const now = this.serverEpochNow();
            for (const building of this.buildings) {
                if (building.owner !== 'PLAYER' || !building.upgradingTo || (building.upgradeEndsAt ?? 0) <= now) continue;
                this.villageLife.onConstruction(building, 'upgrade');
            }
        }

        return { requested, placed, playablePlaced };
    }

    private async refreshHomeBaseFromCloud(lastKnownSaveTime: number) {
        if (!Auth.isOnlineMode()) return;
        if (this.mode !== 'HOME') return;
        if (Backend.hasPendingSave(this.userId)) return;
        const lifecycleEpoch = this.lifecycleEpoch;
        const editSequence = Backend.getLocalEditSequence(this.userId);
        const refreshed = await Backend.refreshWorldFromCloud(this.userId);
        if (lifecycleEpoch !== this.lifecycleEpoch || !this.sceneReadyForBaseLoad) return;
        if (!refreshed || !this.isWorldValid(refreshed)) return;
        if (Backend.getLocalEditSequence(this.userId) !== editSequence || Backend.hasPendingSave(this.userId)) return;
        const refreshedSave = refreshed.lastSaveTime ?? 0;
        if (refreshedSave <= lastKnownSaveTime) return;
        if (this.mode !== 'HOME') return;
        this.applyWorldToScene(refreshed);
    }

    private canUseAppliedHomeWorld(summary: { requested: number; placed: number; playablePlaced: number }): boolean {
        if (summary.playablePlaced > 0) return true;
        console.warn('Home world applied with no playable structures', summary);
        return false;
    }

    private logWorldLoadDiagnostics(world: SerializedWorld | null, stage: string, summary?: { requested: number; placed: number; playablePlaced: number }) {
        if (!world) {
            console.warn(`loadSavedBase diagnostics (${stage}): world is null`);
            return;
        }
        const buildings = Array.isArray(world.buildings) ? world.buildings : [];
        const hasTownHall = buildings.some(building => this.normalizeBuildingType(String((building as { type?: unknown }).type ?? '')) === 'town_hall');
        const typeHistogram: Record<string, number> = {};
        buildings.forEach(building => {
            const rawType = String((building as { type?: unknown }).type ?? 'unknown');
            typeHistogram[rawType] = (typeHistogram[rawType] ?? 0) + 1;
        });
        console.warn(`loadSavedBase diagnostics (${stage})`, {
            worldId: world.id,
            userId: this.userId,
            buildingCount: buildings.length,
            hasTownHall,
            sampleTypes: Object.entries(typeHistogram).slice(0, 12),
            summary
        });
    }

    private async loadSavedBase(
        forceOnline: boolean = false,
        options: { preferCache?: boolean; refreshOnline?: boolean } = {}
    ): Promise<boolean> {
        const lifecycleEpoch = this.lifecycleEpoch;
        // Load player home world from Backend
        this.needsDefaultBase = false;
        let world: SerializedWorld | null = null;
        let lastKnownSaveTime = 0;

        if (options.preferCache) {
            const cached = Backend.getCachedWorld(this.userId);
            if (cached && this.isWorldValid(cached)) {
                const cacheSummary = this.applyWorldToScene(cached);
                if (this.canUseAppliedHomeWorld(cacheSummary)) {
                    world = cached;
                    lastKnownSaveTime = cached.lastSaveTime ?? 0;
                } else {
                    console.warn('loadSavedBase: Cached world failed visual instantiation checks, forcing remote read path.');
                    this.logWorldLoadDiagnostics(cached, 'cache_failed_visual_apply', cacheSummary);
                }
            }
        }

        if (!world) {
            world = forceOnline && Auth.isOnlineMode()
                ? await Backend.forceLoadFromCloud(this.userId)
                : await Backend.getWorld(this.userId);
            if (lifecycleEpoch !== this.lifecycleEpoch) return false;

            // If world doesn't exist, create it (empty)
            if (!world) {
                if (!Auth.isOnlineMode()) {
                    world = await Backend.createWorld(this.userId, 'PLAYER');
                    if (lifecycleEpoch !== this.lifecycleEpoch) return false;
                } else {
                    console.warn('loadSavedBase: Online base unavailable, skipping default placement.');
                    return false;
                }
            }

            // Check if there's anything valid to load
            if (!this.isWorldValid(world)) {
                if (world.buildings.length === 0) {
                    console.log("loadSavedBase: Empty base. Triggering default placement.");
                    this.needsDefaultBase = true;
                } else {
                    console.warn("loadSavedBase: No renderable buildings after sanitization. Skipping default placement to avoid data loss.");
                    this.needsDefaultBase = !Auth.isOnlineMode();
                }
                this.logWorldLoadDiagnostics(world, 'invalid_world_payload');
                return false;
            }

            const summary = this.applyWorldToScene(world);
            if (!this.canUseAppliedHomeWorld(summary)) {
                this.logWorldLoadDiagnostics(world, 'applied_world_not_playable', summary);
                return false;
            }
            lastKnownSaveTime = world.lastSaveTime ?? 0;
        }

        if (options.refreshOnline && Auth.isOnlineMode()) {
            void this.refreshHomeBaseFromCloud(lastKnownSaveTime);
        }

        return true;
    }

    private async reloadHomeBase(options: { refreshOnline?: boolean } = {}): Promise<boolean> {
        const lifecycleEpoch = this.lifecycleEpoch;
        const refreshOnline = options.refreshOnline ?? true;
        // Our own lawn has its own seeded tint too — neighbours see the same
        // grass on our postcard that we stand on here.
        if (this.userId) this.rebakeGround(this.userId);
        let success = await this.loadSavedBase(false, { preferCache: true, refreshOnline });
        if (lifecycleEpoch !== this.lifecycleEpoch) return false;

        // If local/cache hydration failed, force a direct cloud fetch once before giving up.
        if (!success && Auth.isOnlineMode()) {
            success = await this.loadSavedBase(true, { preferCache: false, refreshOnline: false });
            if (lifecycleEpoch !== this.lifecycleEpoch) return false;
        }

        if (!success && this.needsDefaultBase) {
            // Never auto-write a fallback base in online mode; this can overwrite a valid remote base.
            if (Auth.isOnlineMode()) {
                console.error('reloadHomeBase: refusing automatic default base creation while online to avoid destructive overwrite');
                return false;
            }

            const offlineWorld = await Backend.createWorld(this.userId, 'PLAYER');
            if (lifecycleEpoch !== this.lifecycleEpoch) return false;
            const summary = this.applyWorldToScene(offlineWorld);
            if (!this.canUseAppliedHomeWorld(summary)) {
                return false;
            }
            this.centerCamera();
            return true;
        }
        if (success) {
            this.centerCamera();
        }
        if (success && this.mode === 'HOME') {
            if (lifecycleEpoch !== this.lifecycleEpoch) return false;
            // Everything the reveal shows must already be there: night lights
            // burning and every neighbour postcard drawn, not popping in late.
            this.dayNight?.resyncLights();
            await this.worldMap?.prime(this.time.now);
            if (lifecycleEpoch !== this.lifecycleEpoch) return false;
        }
        return success;
    }


    private createIsoGrid() {
        // Initialize Ground Render Texture
        // 2000x1200 covers the map range (-800 to 800 X, 0 to 800 Y) with padding
        this.groundRenderTexture = this.add.renderTexture(-this.RT_OFFSET_X, -this.RT_OFFSET_Y, 2000, 1500);
        // Baked surface: sampling (NEAREST vs legacy LINEAR) follows the pixel mode.
        registerPixelSurface(this.groundRenderTexture.texture);
        this.groundRenderTexture.setDepth(depthForGroundPlane());
        this.groundRenderTexture.setOrigin(0, 0);

        // Draw all tiles with lush grass variation to the texture
        for (let x = 0; x < this.mapSize; x++) {
            for (let y = 0; y < this.mapSize; y++) {
                this.tempGraphics.clear();
                this.drawIsoTile(this.tempGraphics, x, y);
                this.groundRenderTexture.draw(this.tempGraphics, this.RT_OFFSET_X, this.RT_OFFSET_Y);
            }
        }

        // Add username label in the left corner (Grid 0, mapSize)
        const leftCorner = IsoUtils.cartToIso(0, this.mapSize);

        this.villageNameLabel = this.add.text(leftCorner.x + 20, leftCorner.y - 15, '', {
            fontFamily: 'Outfit, Arial Black, sans-serif',
            fontSize: '28px',
            fontStyle: 'bold',
            color: '#ffffff',
            stroke: '#000000',
            strokeThickness: 6
        })
            .setOrigin(0, 1)
            .setAlpha(1.0) // Full brightness
            // Above the world-map road band (-450) and roadside props (-440),
            // below all plot content (ground RT at 0). At -500 it TIED the
            // void backdrop and sat under the roads painted next to the lawn.
            .setDepth(-430)
            .setAngle(-26.5); // Align with isometric left axis

        this.updateVillageName();
    }

    /** Pointer hover over the map — lets nearby villagers/dogs/chickens notice the cursor. */
    public hoverVillageLife(gridX: number, gridY: number) {
        this.villageLife?.handleHover(gridX, gridY);
    }

    /** Tap/click on the map — neighbour plots first, then the critters at home. */
    public pokeVillageLife(gridX: number, gridY: number) {
        if (this.worldMap?.handleTap(gridX, gridY)) return;
        this.worldMap?.closePanel();
        this.villageLife?.handlePoke(gridX, gridY);
    }

    /**
     * Attack a bot clan straight off the global map, behind the cloud
     * transition. The server issues the raid session and canonical seeded
     * world; the clouds part directly on the target with the war standard
     * already planted (no march — see plantWarCamp).
     */
    public attackBotPlot(seed: number, username: string, plotX?: number, plotY?: number) {
        const requestedSeed = seed >>> 0;
        this.showCloudTransition(async epoch => {
            if (!await this.flushPendingSaveForTransition() || !this.isTransitionCurrent(epoch)) return;
            const started = await Backend.botStart(plotX, plotY);
            if (!started) {
                gameManager.showToast('That camp cannot be raided right now.');
                return;
            }
            if (plotX !== undefined && started.seed !== requestedSeed) {
                console.warn('Bot camp seed changed between map view and raid start.', { requestedSeed, issuedSeed: started.seed });
            }
            const meta = {
                id: `bot_${started.seed >>> 0}`,
                username: plotX !== undefined && plotY !== undefined ? username : (started.world.username || username),
                isBot: true,
                attackId: started.raidId,
                botRaidId: started.raidId,
                botPlot: { x: started.x, y: started.y }
            };
            if (!this.isTransitionCurrent(epoch)) {
                await this.abortBotSession(meta);
                return;
            }
            started.world.username = meta.username;
            const plot = { x: started.x, y: started.y };
            this.worldMap.prepareFocus(plot);
            this.prepareGroundBake(meta.id);
            await this.arriveAndFight(plot, started.world, meta, epoch, {
                cameraArrivedAtGate: false,
                finishTransition: false
            });
        });
    }

    private async abortBotSession(meta: { botRaidId?: string; botPlot?: { x: number; y: number } }): Promise<void> {
        if (!meta.botRaidId || !meta.botPlot) return;
        await Backend.botSettle(meta.botRaidId, meta.botPlot.x, meta.botPlot.y, 0, {});
    }

    /**
     * Attack a neighbouring PLAYER straight off the global map. Rides the
     * exact same cloud flow as a leaderboard attack (registration, shields,
     * aborts): clouds close, the battle frame swaps in, and the clouds part
     * with the war standard already planted — no road march.
     */
    public attackPlayerPlotByRoad(ownerId: string, username: string, _plotX: number, _plotY: number) {
        gameManager.startAttackOnUser(ownerId, username);
    }

    /**
     * The clouds have closed: swap the battle in WITHOUT leaving the world —
     * the neighbourhood re-renders around the battlefield (the player's own
     * home becomes one of the postcards), the war standard is planted at
     * their gate, and the fight happens right there on the map.
     */
    private async arriveAndFight(
        plot: { x: number; y: number },
        world: SerializedWorld,
        meta: EnemyWorldMeta,
        epoch: number,
        options: { cameraArrivedAtGate?: boolean; finishTransition?: boolean } = {}
    ) {
        const cameraArrivedAtGate = options.cameraArrivedAtGate ?? true;
        const finishTransition = options.finishTransition ?? true;
        const finish = () => {
            if (finishTransition) this.finishExclusiveTransition(epoch);
        };
        // How far the world is about to re-anchor (target plot becomes origin).
        const shift = this.worldMap.travelOffsetFor(plot.x, plot.y);

        // EVERYTHING slow happens first, while the column stands at their
        // gate: the hidden post-swap world finishes rendering and pending
        // saves flush. Only then does the swap run — one synchronous block,
        // one frame, nothing for the eye to catch.
        const focusReady = await this.worldMap.waitForFocusReady();
        if (!this.isTransitionCurrent(epoch)) {
            if (!meta.isBot && meta.attackId) await Backend.endAttack(meta.attackId, 'aborted', 0, 0).catch(() => undefined);
            if (meta.botRaidId) await this.abortBotSession(meta);
            return;
        }
        if (!focusReady) {
            if (!meta.isBot && meta.attackId) void Backend.endAttack(meta.attackId, 'aborted', 0, 0).catch(() => undefined);
            if (meta.botRaidId) await this.abortBotSession(meta);
            this.worldMap.teardown();
            this.dropGroundBake();
            gameManager.showToast('The road ahead could not be loaded. Please try again.');
            finish();
            return;
        }
        if (!await this.flushPendingSaveForTransition() || !this.isTransitionCurrent(epoch)) {
            if (!meta.isBot && meta.attackId) void Backend.endAttack(meta.attackId, 'aborted', 0, 0).catch(() => undefined);
            if (meta.botRaidId) await this.abortBotSession(meta);
            this.worldMap.teardown();
            this.dropGroundBake();
            finish();
            return;
        }

        // ---- the swap: a single frame ----
        this.battleInPlace = true;
        this.snapshotPlayerLabLevel();
        gameManager.setGameMode('ATTACK');
        this.mode = 'ATTACK';
        this.isScouting = false;
        this.clearScene();
        this.worldMap.commitFocus();
        this.commitGroundBake(meta.id);
        const summary = this.instantiateEnemyWorld(world, meta);
        if (summary.playablePlaced === 0) {
            if (!meta.isBot && meta.attackId) void Backend.endAttack(meta.attackId, 'aborted', 0, 0).catch(() => undefined);
            if (meta.botRaidId) await this.abortBotSession(meta);
            await this.goHome();
            finish();
            return;
        }
        // The bearer is ALREADY at their gate — standard planted, standing in
        // his final position — from the very first frame the clouds part.
        // Placed, never walked; his audio handover (drums, horn) rides along.
        this.worldMap.plantWarCamp(shift);
        // No UI theatre either: the name label stays hidden — the only
        // change on screen is the attack HUD arriving.
        this.setVillageNameVisible(false);
        if (shift && cameraArrivedAtGate) {
            // The world re-anchored by exactly (-dx, -dy) plots; the camera
            // moves by the same world-space delta. Because the march glide
            // ended centred on the target, this lands pixel-identical.
            const delta = IsoUtils.cartToIso(shift.dx * PLOT_PITCH, shift.dy * PLOT_PITCH);
            const cam = this.cameras.main;
            cam.scrollX -= delta.x;
            cam.scrollY -= delta.y;
        } else {
            this.centerCamera();
        }
        this.resetBattleStats();
        finish();
    }

    /** Live destruction percentage, same math the battle HUD shows. */
    private currentDestructionPct(): number {
        const { totalKnown } = this.getBattleTotals();
        return totalKnown > 0
            ? Math.min(100, Math.round((this.destroyedBuildings / totalKnown) * 100))
            : 0;
    }

    /**
     * Settle a world-map bot raid exactly once (natural end or retreat): the
     * server derives the camp's wealth from its issued session, pays capped
     * loot on a per-camp cooldown and consumes deployed troops. Even a
     * zero-deployment retreat is sent so the reservation closes immediately.
     * Practice drills have no raidId and therefore settle nothing.
     */
    private async settleBotRaid(): Promise<number> {
        const enemy = this.currentEnemyWorld;
        if (!enemy?.isBot || !enemy.botRaidId || !enemy.botPlot || this.botRaidSettled) return 0;
        if (this.pendingBotSettlement) return this.pendingBotSettlement;
        const task = (async () => {
            const result = await Backend.botSettle(
                enemy.botRaidId as string,
                enemy.botPlot!.x,
                enemy.botPlot!.y,
                this.currentDestructionPct(),
                { ...this.deployedThisBattle }
            );
            if (!result) throw new Error('Bot raid settlement is still pending');
            this.botRaidSettled = true;
            return Math.max(0, Math.floor(result.lootApplied ?? 0));
        })();
        this.pendingBotSettlement = task;
        try {
            return await task;
        } finally {
            if (this.pendingBotSettlement === task) this.pendingBotSettlement = null;
        }
    }

    /** Clicked on (or near) the visiting merchant: open his trade offers. */
    public tryOpenMerchant(gridX: number, gridY: number): boolean {
        if (this.mode !== 'HOME') return false;
        if (!this.villageLife?.merchantAt(gridX, gridY)) return false;
        soundSystem.play('merchant');
        gameManager.openMerchant(this.villageLife.getMerchantOffers());
        return true;
    }

    /**
     * Clicked a mushroom patch in HOME: the picking is villagers' work — this
     * just points one at the patch. They walk over, kneel to pick, and carry
     * the haul to the storehouse; the food arrives when they do.
     */
    public tryPickMushrooms(gridX: number, gridY: number): boolean {
        if (this.mode !== 'HOME') return false;
        const patch = this.obstacles.find(o =>
            o.type === 'grass_patch' && o.gridX === gridX && o.gridY === gridY);
        if (!patch) return false;
        const look = ObstacleRenderer.grassLookOf(patch.id);
        const golden = look.egg === 0;
        if (!golden && look.variant !== 3) return false;

        const assigned = this.villageLife.assignForage(patch);
        if (assigned) {
            // Ring pulse so the click clearly landed (gold for the lucky find).
            const pos = IsoUtils.cartToIso(patch.gridX + 0.5, patch.gridY + 0.5);
            PixelFx.ring(this, pos.x, pos.y, {
                r0: 11, r1: 17.6, squash: 0.5, thick0: 1,
                color: golden ? 0xffd84a : 0xffffff, alpha: 0.8,
                life: 380, ease: 'Quad.easeOut',
                depth: patch.graphics.depth + 1
            });
        }
        return assigned;
    }

    /**
     * Clicked a rock in HOME: a villager hauls it to the storehouse for ore
     * (the baseline ore trickle before any mine exists).
     */
    public tryStartRockHaul(gridX: number, gridY: number): boolean {
        if (this.mode !== 'HOME') return false;
        const rock = this.obstacles.find(o => {
            if (o.type !== 'rock_small' && o.type !== 'rock_large') return false;
            const info = OBSTACLES[o.type];
            return gridX >= o.gridX && gridX < o.gridX + (info?.width ?? 1) &&
                gridY >= o.gridY && gridY < o.gridY + (info?.height ?? 1);
        });
        if (!rock) return false;
        const assigned = this.villageLife.assignRockHaul(rock);
        if (assigned) {
            // Quick ring pulse so the click clearly landed.
            const info = OBSTACLES[rock.type];
            const pos = IsoUtils.cartToIso(rock.gridX + (info?.width ?? 1) / 2, rock.gridY + (info?.height ?? 1) / 2);
            PixelFx.ring(this, pos.x, pos.y, {
                r0: 12, r1: 19.2, squash: 0.5, thick0: 1,
                color: 0xffffff, alpha: 0.8,
                life: 380, ease: 'Quad.easeOut',
                depth: rock.graphics.depth + 1
            });
        }
        return assigned;
    }

    /** Renames arrive from the App; the label itself never shows the OWN
     * village's name (owner call), so a rename only needs the home label
     * to stay hidden. Foreign titles come from updateVillageName. */
    public updateUsername(_name: string) {
        if (!this.villageNameLabel) return;

        if (this.mode === 'HOME') {
            // No title floats over your OWN village — you know whose it is.
            // The label exists to identify TARGETS (attack, scout, replay).
            this.villageNameLabel.setVisible(false);
        } else {
            this.villageNameLabel.setText(`ENEMY VILLAGE`);
        }
    }

    private updateVillageName() {
        if (!this.villageNameLabel) return;

        if (this.mode === 'HOME') {
            // Own village: never titled (see updateUsername).
            this.villageNameLabel.setVisible(false);
            return;
        }
        // The enemy's username identifies the target of an attack/scout.
        const name = this.currentEnemyWorld?.username || 'ENEMY';
        this.villageNameLabel.setText(`${name.toUpperCase()}'S VILLAGE`);
        this.layoutVillageNameLabel();
    }

    /**
     * Keep the angled nameplate on screen: its home anchor is the plot's
     * west corner, but the default scout/attack/replay framing (centerCamera)
     * can put that corner outside the viewport — the ribbon then reads
     * "…9'S VILLAGE" cut at x=0 for the whole session. When that happens,
     * slide the label ALONG its -26.5° edge (toward the north corner) just
     * far enough to clear the camera's left edge. It stays a world-anchored
     * signpost on the same edge line — only its perch moves.
     */
    private layoutVillageNameLabel() {
        const label = this.villageNameLabel;
        if (!label) return;
        const corner = IsoUtils.cartToIso(0, this.mapSize);
        const baseX = corner.x + 20;
        const baseY = corner.y - 15;
        label.setPosition(baseX, baseY);
        if (!label.visible) return;

        // worldView is stale until the camera's next preRender, so derive
        // the view from the just-set scroll/zoom instead.
        const cam = this.cameras.main;
        const viewLeft = cam.scrollX + (cam.width - cam.width / cam.zoom) / 2;
        const margin = 16;
        const bounds = label.getBounds();
        const deficit = (viewLeft + margin) - bounds.x;
        if (deficit <= 0) return;

        // Unit step along the NW edge (one grid tile toward (0,0)):
        // iso delta (+TILE_W/2, -TILE_H/2) — the label's own -26.5° line.
        const step = IsoUtils.cartToIso(0, this.mapSize - 1);
        const dx = step.x - corner.x;
        const dy = step.y - corner.y;
        const len = Math.sqrt(dx * dx + dy * dy);
        const ux = dx / len;
        const uy = dy / len;
        // Never slide past the north corner: keep the whole ribbon on the edge.
        const edgeLen = this.mapSize * len;
        const labelAlongEdge = bounds.width / Math.max(0.0001, ux);
        const maxSlide = Math.max(0, edgeLen - labelAlongEdge - 30);
        const slide = Math.min(deficit / ux, maxSlide);
        label.setPosition(baseX + ux * slide, baseY + uy * slide);
    }

    private setVillageNameVisible(visible: boolean) {
        if (!this.villageNameLabel) return;
        // The home village never wears a nameplate; only foreign villages
        // (attack, scout, replay targets) are titled.
        this.villageNameLabel.setVisible(visible && this.mode !== 'HOME');
    }

    /** The four plot-corner tiles get their outer corner rounded off — the
     *  junction's packed-earth bed (WorldMapSystem) shows through the cut. */
    private lawnCornerCut(x: number, y: number): GrassCornerCut | undefined {
        const last = this.mapSize - 1;
        if (x === 0 && y === 0) return 'nw';
        if (x === last && y === 0) return 'ne';
        if (x === last && y === last) return 'se';
        if (x === 0 && y === last) return 'sw';
        return undefined;
    }

    private drawIsoTile(graphics: Phaser.GameObjects.Graphics, x: number, y: number, fillOnly: boolean = false) {
        // Shared with the world-map postcards: the SAME function, palette and
        // per-tile pattern — a village's lawn is pixel-identical whether seen
        // from home or stood on in battle (the seamless-invasion contract).
        const pos = IsoUtils.cartToIso(x, y);
        drawGrassTile(graphics, pos.x, pos.y, this.tileWidth, this.tileHeight, x, y, grassPaletteFor(this.groundPaletteKey), !fillOnly, this.lawnCornerCut(x, y));
    }

    /** Re-bake the ground as another village's lawn (or back to ours). */
    public rebakeGround(paletteKey: string) {
        if (paletteKey === this.groundPaletteKey || !this.groundRenderTexture) return;
        this.groundPaletteKey = paletteKey;
        this.groundRenderTexture.clear();
        for (let x = 0; x < this.mapSize; x++) {
            for (let y = 0; y < this.mapSize; y++) {
                this.tempGraphics.clear();
                this.drawIsoTile(this.tempGraphics, x, y);
                this.groundRenderTexture.draw(this.tempGraphics, this.RT_OFFSET_X, this.RT_OFFSET_Y);
            }
        }
        this.markGroundPixelDirty();
    }

    // ---- pre-baked lawn for the seamless swap ----
    private pendingGroundRT: Phaser.GameObjects.RenderTexture | null = null;
    private pendingGroundKey: string | null = null;
    private pendingGroundCursor = 0;

    /**
     * Start baking the target's lawn into a HIDDEN second render texture.
     * The bake is CHUNKED — ~50 tiles per frame from the update loop — so
     * pressing attack never stalls a frame (a 625-tile bake in one tick was
     * a visible hitch, i.e. "the flash").
     */
    public prepareGroundBake(paletteKey: string) {
        this.pendingGroundRT?.destroy();
        this.pendingGroundRT = this.add.renderTexture(-this.RT_OFFSET_X, -this.RT_OFFSET_Y, 2000, 1500);
        registerPixelSurface(this.pendingGroundRT.texture); // same pixel-mode contract as the live ground RT
        this.pendingGroundRT.setDepth(depthForGroundPlane());
        this.pendingGroundRT.setOrigin(0, 0);
        this.pendingGroundRT.setVisible(false);
        this.pendingGroundKey = paletteKey;
        this.pendingGroundCursor = 0;
    }

    /** A slice of the hidden bake; called every frame while one is pending. */
    private stepGroundBake(tilesPerFrame = 50) {
        if (!this.pendingGroundRT || !this.pendingGroundKey) return;
        const total = this.mapSize * this.mapSize;
        if (this.pendingGroundCursor >= total) return;
        const palette = grassPaletteFor(this.pendingGroundKey);
        const end = Math.min(total, this.pendingGroundCursor + tilesPerFrame);
        for (; this.pendingGroundCursor < end; this.pendingGroundCursor++) {
            const x = this.pendingGroundCursor % this.mapSize;
            const y = Math.floor(this.pendingGroundCursor / this.mapSize);
            this.tempGraphics.clear();
            const pos = IsoUtils.cartToIso(x, y);
            drawGrassTile(this.tempGraphics, pos.x, pos.y, this.tileWidth, this.tileHeight, x, y, palette, true, this.lawnCornerCut(x, y));
            this.pendingGroundRT.draw(this.tempGraphics, this.RT_OFFSET_X, this.RT_OFFSET_Y);
        }
    }

    /** The one-frame lawn flip (finishes any bake remainder synchronously). */
    private commitGroundBake(fallbackKey: string) {
        if (this.pendingGroundRT && this.pendingGroundKey) {
            this.stepGroundBake(this.mapSize * this.mapSize); // whatever is left
            this.groundRenderTexture.destroy();
            this.groundRenderTexture = this.pendingGroundRT;
            this.groundRenderTexture.setVisible(true);
            this.groundPaletteKey = this.pendingGroundKey;
            this.pendingGroundRT = null;
            this.pendingGroundKey = null;
            this.markGroundPixelDirty();
        } else {
            this.rebakeGround(fallbackKey);
        }
    }

    private instantiateBuilding(data: SerializedBuilding, owner: 'PLAYER' | 'ENEMY') {
        const { gridX, gridY, type, id, level = 1, builtAt, upgradingTo, upgradeEndsAt } = data;
        const upgradeStartedAt = Number((data as UpgradeTimedSerializedBuilding).upgradeStartedAt);
        const normalizedType = this.normalizeBuildingType(type as string);
        if (!normalizedType) {
            console.warn('Unknown building type skipped:', type);
            return;
        }

        // Calculate stats based on level
        const stats = getBuildingStats(normalizedType as BuildingType, level);

        const graphics = this.add.graphics();
        const baseGraphics = undefined; // Optimization: Bake to Ground Texture instead of per-building graphics
        const building: PlacedBuilding = {
            id, type: normalizedType, gridX, gridY, level, builtAt, upgradingTo, upgradeEndsAt, graphics, baseGraphics,
            healthBar: this.createHealthBarGraphics(),
            health: stats.maxHealth || 100,
            maxHealth: stats.maxHealth || 100,
            owner
        };
        if (Number.isFinite(upgradeStartedAt)) (building as UpgradeTimedPlacedBuilding).upgradeStartedAt = upgradeStartedAt;

        // Bake the base to the ground texture
        this.bakeBuildingToGround(building);

        // Depth BEFORE the first draw: the baked-sprite stamp copies carrier
        // depth immediately, and a fresh Graphics still sits at depth 0 — the
        // first frame would paint the building under the whole village.
        const depth = depthForBuilding(gridX, gridY, normalizedType as BuildingType);
        graphics.setDepth(depth);

        // Draw dynamic visuals (skipBase=true implied by bake, but drawBuildingVisuals handles default)
        // We pass skipBase=true to ensure only dynamic parts are drawn to 'graphics'
        this.drawBuildingVisuals(graphics, gridX, gridY, normalizedType, 1, null, building, baseGraphics, true);

        // Initialize cannon angle
        if (normalizedType === 'cannon') {
            building.ballistaAngle = Math.PI / 4; // Default facing bottom-right
        }

        this.buildings.push(building);
        this.combatTopologyRevision++;
        this.updateHealthBar(building);

        if (normalizedType === 'army_camp') {
            const campLevels = this.buildings.filter(b => b.type === 'army_camp').map(b => b.level ?? 1);
            gameManager.refreshCampCapacity(campLevels);
        }

        if (normalizedType === 'wall') {
            this.preferredWallLevel = Math.max(this.preferredWallLevel, level || 1);
        }

        if (normalizedType === 'lab' && owner === 'PLAYER' && !upgradingTo) {
            // A lab hydrated mid-upgrade is offline (server troopLevelOf rule);
            // completeLocalUpgrade raises the level when the clock matures.
            this.playerLabLevel = Math.max(this.playerLabLevel, level || 1);
        }

        // Update neighbor wall connections when a new wall is placed
        if (normalizedType === 'wall') {
            this.refreshWallNeighbors(gridX, gridY, owner);
        }

        return building;
    }

    public async placeBuilding(gridX: number, gridY: number, type: string, owner: 'PLAYER' | 'ENEMY' = 'PLAYER', isFree: boolean = false): Promise<boolean> {
        // Remove any obstacles that overlap with this building
        const info = BUILDINGS[type];
        if (info) {
            this.removeOverlappingObstacles(gridX, gridY, info.width, info.height);
        }

        if (owner === 'PLAYER') {
            // Backend Validation & Placement
            const data = await Backend.placeBuilding(this.userId, type as BuildingType, gridX, gridY);
            if (data) {
                const inst = this.instantiateBuilding(data, 'PLAYER');
                gameManager.onBuildingPlaced(type, isFree);
                soundSystem.play('thud');
                // Lanes re-route around the new footprint; critters caught
                // under it scatter (same treatment as a moved building).
                if (inst) this.villageLife.onBuildingPlaced(inst);
                if (inst && !isFree) this.villageLife.onConstruction(inst, 'place');
                return true;
            }
            return false;
        } else {
            // For Enemy (Manual placement, e.g. from old generators if still used)
            // We create a temp serialized object
            const data: SerializedBuilding = {
                id: Phaser.Utils.String.UUID(),
                type: type as BuildingType,
                gridX, gridY, level: 1
            };
            this.instantiateBuilding(data, 'ENEMY');
            return true;
        }
        return false;
    }

    public removeOverlappingObstacles(gridX: number, gridY: number, width: number, height: number) {
        const toRemove: string[] = [];

        for (const o of this.obstacles) {
            const oInfo = OBSTACLES[o.type];
            // Check overlap
            const overlapX = Math.max(0, Math.min(gridX + width, o.gridX + oInfo.width) - Math.max(gridX, o.gridX));
            const overlapY = Math.max(0, Math.min(gridY + height, o.gridY + oInfo.height) - Math.max(gridY, o.gridY));
            if (overlapX > 0 && overlapY > 0) {
                toRemove.push(o.id);
            }
        }

        // Remove overlapping obstacles
        toRemove.forEach(id => this.removeObstacle(id));
    }





    public isPositionValid(gridX: number, gridY: number, type: string, buildingToIgnore: string | null = null): boolean {
        const info = BUILDINGS[type];
        if (gridX < 0 || gridY < 0 || gridX + info.width > this.mapSize || gridY + info.height > this.mapSize) {
            return false;
        }
        for (const b of this.buildings) {
            if (b.id === buildingToIgnore) continue;
            const bInfo = BUILDINGS[b.type];
            const overlapX = Math.max(0, Math.min(gridX + info.width, b.gridX + bInfo.width) - Math.max(gridX, b.gridX));
            const overlapY = Math.max(0, Math.min(gridY + info.height, b.gridY + bInfo.height) - Math.max(gridY, b.gridY));
            if (overlapX > 0 && overlapY > 0) return false;
        }
        return true;
    }

    private bakeBuildingToGround(b: PlacedBuilding) {
        // Walls are fully dynamic (level + neighbor links), so they should never be baked.
        if (b.type === 'wall') return;
        if (!this.groundRenderTexture || !this.tempGraphics) return;
        // Sprite-backed buildings stamp their baked ground DECAL (contact
        // shadow + pad) straight into the ground texture.
        const ground = SpriteBank.buildingGround(b.type, b.level ?? 1);
        if (ground) {
            const info = BUILDINGS[b.type];
            const cx = (b.gridX + info.width / 2 - (b.gridY + info.height / 2)) * 32;
            const cy = (b.gridX + info.width / 2 + (b.gridY + info.height / 2)) * 16;
            const img = this.make.image({ key: ground.atlasKey, frame: ground.meta.file }, false)
                .setOrigin(ground.meta.originX, ground.meta.originY)
                .setScale(ground.meta.cellWorldPx);
            this.groundRenderTexture.draw(img, cx + this.RT_OFFSET_X, cy + this.RT_OFFSET_Y);
            img.destroy();
            this.markGroundPixelDirty();
            return;
        }
        this.tempGraphics.clear();
        // Draw ONLY the base to temporary graphics
        this.drawBuildingVisuals(this.tempGraphics, b.gridX, b.gridY, b.type, 1, null, b, undefined, false, true);
        // Stamp to texture (additive)
        this.groundRenderTexture.draw(this.tempGraphics, this.RT_OFFSET_X, this.RT_OFFSET_Y);
        this.markGroundPixelDirty();
    }

    /** Ground-layer pixel treatment: the whole ground RT (grass tiles, worn
     * paths, stone lanes, baked decals) re-quantizes into 1.35 world-px cells
     * shortly after any bake write — the world-glued equivalent of the baked
     * sprites (docs/AGENTS_SPRITE_PIPELINE.md). */
    private groundPixelDirtyAt = 0;
    private groundPixelEpoch = 0;
    private markGroundPixelDirty() {
        this.groundPixelDirtyAt = this.time.now + 250;
        this.groundPixelEpoch++;
        // A quantize snapshot may be in flight from the PREVIOUS epoch: its
        // async callback would write pre-write pixels back over the bake that
        // just landed. Invalidate so that callback discards itself.
        if (this.groundRenderTexture) {
            SpriteBank.invalidateQuantize(this.groundRenderTexture);
        }
    }
    private maybeQuantizeGround(time: number) {
        if (!SpriteBank.enabled || this.groundPixelDirtyAt === 0 || time < this.groundPixelDirtyAt) return;
        this.groundPixelDirtyAt = 0;
        if (this.groundRenderTexture) {
            SpriteBank.quantizeRenderTexture(this, this.groundRenderTexture, 1.35, this.groundPixelEpoch);
        }
    }

    // Call this before moving/deleting to restore grass
    private unbakeBuildingFromGround(b: PlacedBuilding) {
        if (b.type === 'wall') return;
        if (!this.groundRenderTexture || !this.tempGraphics) return;

        const info = BUILDINGS[b.type];
        // Margin tiles use fillOnly to cover border stroke bleed without introducing
        // semi-transparent edge highlights that would composite on top of neighboring
        // tiles and create a visible seam.
        const margin = 1;
        const clearMinX = b.gridX - margin;
        const clearMinY = b.gridY - margin;
        const clearMaxX = b.gridX + info.width + margin;
        const clearMaxY = b.gridY + info.height + margin;

        for (let x = clearMinX; x < clearMaxX; x++) {
            for (let y = clearMinY; y < clearMaxY; y++) {
                if (x >= 0 && x < this.mapSize && y >= 0 && y < this.mapSize) {
                    // Margin tiles: fill only (no edge highlights that bleed into neighbors)
                    // Footprint tiles: full redraw with edges
                    const isMargin = x < b.gridX || x >= b.gridX + info.width ||
                        y < b.gridY || y >= b.gridY + info.height;
                    this.tempGraphics.clear();
                    this.drawIsoTile(this.tempGraphics, x, y, isMargin);
                    this.groundRenderTexture.draw(this.tempGraphics, this.RT_OFFSET_X, this.RT_OFFSET_Y);
                }
            }
        }

        // Re-bake bases of any neighboring buildings whose footprints overlap the cleared area
        for (const other of this.buildings) {
            if (other === b) continue;
            const oi = BUILDINGS[other.type];
            const otherMaxX = other.gridX + oi.width;
            const otherMaxY = other.gridY + oi.height;
            if (other.gridX < clearMaxX && otherMaxX > clearMinX &&
                other.gridY < clearMaxY && otherMaxY > clearMinY) {
                this.bakeBuildingToGround(other);
            }
        }

        // The restored tiles are a fresh smooth-vector write: without a dirty
        // mark they'd skip re-quantization (and an in-flight snapshot could
        // clobber them) whenever no overlapping neighbor re-baked above.
        this.markGroundPixelDirty();
    }

    public drawBuildingVisuals(graphics: Phaser.GameObjects.Graphics, gridX: number, gridY: number, type: string, alpha: number = 1, tint: number | null = null, building?: PlacedBuilding, baseGraphics?: Phaser.GameObjects.Graphics, skipBase: boolean = false, onlyBase: boolean = false) {
        let wallNeighbors: WallNeighborTopology | undefined;
        if (type === 'wall') {
            const owner = building?.owner ?? 'PLAYER';
            const hasWallNeighbor = (dx: number, dy: number) => this.buildings.some(candidate =>
                candidate.type === 'wall'
                && candidate.gridX === gridX + dx
                && candidate.gridY === gridY + dy
                && candidate.owner === owner
            );
            wallNeighbors = {
                nN: hasWallNeighbor(0, -1),
                nS: hasWallNeighbor(0, 1),
                nE: hasWallNeighbor(1, 0),
                nW: hasWallNeighbor(-1, 0),
                owner
            };
        }
        // Sprite-backed types swap the vector body for baked-frame selection;
        // the carrier graphics stays (empty) as the position/depth owner. The
        // ground pass keeps its own path via bakeBuildingToGround.
        if (!onlyBase && SpriteBank.backed('buildings', type)) {
            const wallTag = type === 'wall' && wallNeighbors
                ? SpriteBank.wallTag(wallNeighbors)
                : undefined;
            graphics.clear();
            const synced = SpriteBank.syncBuilding(
                this, graphics, gridX, gridY, type, building?.level ?? 1, alpha, tint,
                building, this.animClockNow(),
                { wallTag, jukeboxPlaying: soundSystem.overrideActive }
            );
            if (synced) {
                // The carrier still renders (a hair ABOVE its shadow sprite,
                // see SpriteBank.syncBuilding) — so age patina keeps working
                // on the baked path instead of vanishing with the vector body.
                this.drawBuildingPatina(graphics, gridX, gridY, type, alpha, building, onlyBase);
                return;
            }
            SpriteBank.release(graphics);
        }
        // Walls never bake into the ground RT (fully dynamic), so the redraw
        // paths' skipBase — which exists to avoid re-painting RT-baked bases —
        // would silently drop the wall contact shadow on the vector fallback.
        // Force the wall ground pass back on; every other type keeps the flag.
        const visual = drawBuildingVisual({
            graphics,
            gridX,
            gridY,
            type,
            alpha,
            tint,
            building,
            baseGraphics,
            skipBase: type === 'wall' ? false : skipBase,
            onlyBase,
            time: this.animClockNow(),
            jukeboxPlaying: soundSystem.overrideActive,
            wallNeighbors
        });
        if (!visual) return;
        this.drawBuildingPatina(graphics, gridX, gridY, type, alpha, building, onlyBase);
    }

    // ---- patina: buildings age, upgrades scrub them clean ----
    // Weeks since the server's builtAt stamp grow a whisper of moss and
    // soot along the lower edges. Deliberately faint (a texture you feel
    // more than see), deterministic per building, skipped for walls (a
    // hundred mossy stubs would read as noise) and for ghost previews.
    // Shared by the vector body and the baked-sprite path (where it draws
    // into the carrier graphics, which renders just above the sprite).
    private drawBuildingPatina(graphics: Phaser.GameObjects.Graphics, gridX: number, gridY: number, type: string, alpha: number, building: PlacedBuilding | undefined, onlyBase: boolean) {
        if (onlyBase || !building?.builtAt || building.type === 'wall' || alpha < 1) return;
        const info = BUILDINGS[type];
        if (!info) return;
        const weeks = (Date.now() - building.builtAt) / (7 * 86_400_000);
        const strength = Math.min(0.4, weeks * 0.1);
        if (strength <= 0.05) return;
        const c1 = IsoUtils.cartToIso(gridX, gridY);
        const c2 = IsoUtils.cartToIso(gridX + info.width, gridY);
        const c3 = IsoUtils.cartToIso(gridX + info.width, gridY + info.height);
        const c4 = IsoUtils.cartToIso(gridX, gridY + info.height);
        const center = IsoUtils.cartToIso(gridX + info.width / 2, gridY + info.height / 2);
        const rng = mulberry32(hashString(`${building.id}:patina`));
        const foot = [c1, c2, c3, c4];
        const specks = 3 + Math.floor(rng() * 3) + Math.floor(Math.min(4, weeks));
        for (let s = 0; s < specks; s++) {
            const a = foot[Math.floor(rng() * 4)];
            const b = foot[(Math.floor(rng() * 4) + 1) % 4];
            const f = rng();
            const px = a.x + (b.x - a.x) * f + (rng() - 0.5) * 6;
            const py = a.y + (b.y - a.y) * f - rng() * 5;
            graphics.fillStyle(rng() < 0.6 ? 0x51683a : 0x2a241c, strength * (0.5 + rng() * 0.5));
            graphics.fillRect(px, py, 1.6 + rng() * 1.2, 1.2 + rng() * 0.8);
        }
        // One faint weather streak down a front face.
        const sx = center.x + (rng() - 0.5) * 14;
        graphics.fillStyle(0x1c1410, strength * 0.35);
        graphics.fillRect(sx, center.y - 10 - rng() * 6, 1.1, 7 + rng() * 5);
    }

    /**
     * Redraw walls adjacent to a given position to update their neighbor connections.
     * Call this after moving/placing/removing a wall.
     */
    public refreshWallNeighbors(gridX: number, gridY: number, owner: 'PLAYER' | 'ENEMY') {
        const offsets = [
            { dx: 0, dy: -1 },  // North
            { dx: 0, dy: 1 },   // South
            { dx: 1, dy: 0 },   // East
            { dx: -1, dy: 0 }   // West
        ];

        for (const { dx, dy } of offsets) {
            const neighbor = this.buildings.find(b =>
                b.type === 'wall' &&
                b.gridX === gridX + dx &&
                b.gridY === gridY + dy &&
                b.owner === owner
            );
            if (neighbor) {
                neighbor.graphics.clear();
                this.drawBuildingVisuals(
                    neighbor.graphics,
                    neighbor.gridX,
                    neighbor.gridY,
                    'wall',
                    1,
                    null,
                    neighbor
                );
            }
        }
    }







    // === RUBBLE SYSTEM (Destroyed Building Remains) ===
    private createRubble(gridX: number, gridY: number, width: number, height: number, type = 'generic', level = 1) {
        const graphics = this.add.graphics();
        const baseGraphics = this.add.graphics();
        graphics.setDepth(depthForRubble(gridX, gridY, width, height));
        baseGraphics.setDepth(depthForGroundPlane());

        // Baked wreck sprites (clean rubble; burn/smoke are runtime FX below).
        const spriteBacked = SpriteBank.syncWreck(this, graphics, baseGraphics, type, level, gridX, gridY, width, height);
        if (!spriteBacked) {
            WreckRenderer.drawWreck(graphics, gridX, gridY, width, height, type, level, 0, 1, baseGraphics);
        }

        // Sprite-backed wrecks burn too: the baked stamp stays clean while
        // the authored 15s burn + 30s smolder plays on a runtime FX layer
        // (updateRubbleAnimations redraws it in whole pixel cells).
        const wantsBurn = wreckNeedsAnimation(type, width, height, 1);
        let fxGraphics: Phaser.GameObjects.Graphics | undefined;
        if (spriteBacked && wantsBurn) {
            fxGraphics = this.trackBattleFx(this.add.graphics());
            fxGraphics.setDepth(graphics.depth + 1);
        }

        this.rubble.push({
            gridX,
            gridY,
            width,
            height,
            type,
            level,
            graphics,
            baseGraphics,
            createdAt: Date.now(),
            animationDone: !wantsBurn,
            fxGraphics,
        });
    }



    // Greenery approaches this fraction of the map and stops — never overgrows.
    private readonly GRASS_FILL_TARGET = 0.05;
    private readonly GRASS_GROW_INTERVAL_MS = 25_000;

    private growGrass(time: number) {
        if (this.mode !== 'HOME') return;
        if (time < this.lastGrassGrowTime + this.GRASS_GROW_INTERVAL_MS) return;
        this.lastGrassGrowTime = time;

        const grass = this.obstacles.filter(o => o.type === 'grass_patch');
        const targetCount = this.mapSize * this.mapSize * this.GRASS_FILL_TARGET;
        const fill = grass.length / targetCount;
        if (fill >= 1) return;

        // Asymptotic approach: growth gets rarer as cover nears the target,
        // so the village greens up early on and then just about holds steady.
        if (Math.random() < fill * 0.8) return;

        // Spread logic: Pick random grass, try neighbor (high probability)
        const spreadChance = grass.length > 5 ? 0.9 : 0.4; // If established, spread mostly

        // Grown greenery persists to the village save (skipBackend=false):
        // the same patch — including a lucky easter egg — is still there
        // tomorrow, on any device, because the variant hashes off its saved id.
        if (grass.length > 0 && Math.random() < spreadChance) {
            const parent = grass[Math.floor(Math.random() * grass.length)];
            const neighbors = [
                { x: parent.gridX + 1, y: parent.gridY },
                { x: parent.gridX - 1, y: parent.gridY },
                { x: parent.gridX, y: parent.gridY + 1 },
                { x: parent.gridX, y: parent.gridY - 1 }
            ];
            const spot = neighbors[Math.floor(Math.random() * neighbors.length)];
            // placeObstacle checks validity (bounds + optimization)
            this.placeObstacle(spot.x, spot.y, 'grass_patch', false);
        } else {
            // Spontaneous generation
            const x = Math.floor(Math.random() * (this.mapSize - 4)) + 2;
            const y = Math.floor(Math.random() * (this.mapSize - 4)) + 2;
            this.placeObstacle(x, y, 'grass_patch', false);
        }
    }

    private updateRubbleAnimations(time: number) {
        const now = Date.now();
        this.rubble.forEach(r => {
            if (r.animationDone) return;
            // Fire fades out over time: full for 15s, then fades over 30s.
            const age = (now - r.createdAt) / 1000;
            const fireIntensity = age > 15 ? Math.max(0, 1 - (age - 15) / 30) : 1;
            // Sprite-backed wrecks: the baked stamp is untouched; the burn +
            // smolder redraws on its own overlay until the fire dies.
            if (r.fxGraphics) {
                if (!r.fxGraphics.scene) {
                    r.fxGraphics = undefined;
                    r.animationDone = true;
                    return;
                }
                r.fxGraphics.clear();
                if (fireIntensity > 0.01) {
                    this.drawWreckBurnFx(r.fxGraphics, r, time, fireIntensity);
                    return;
                }
                r.fxGraphics.destroy();
                r.fxGraphics = undefined;
                r.animationDone = true;
                return;
            }
            if (!r.graphics.scene || !r.baseGraphics.scene) return;
            r.graphics.clear();
            r.baseGraphics.clear();
            if (wreckNeedsAnimation(r.type, r.width, r.height, fireIntensity)) {
                WreckRenderer.drawWreck(r.graphics, r.gridX, r.gridY, r.width, r.height, r.type, r.level, time, fireIntensity, r.baseGraphics);
                return;
            }
            // Draw one terminal zero-intensity frame so the last smoke/fire
            // frame cannot remain frozen after animation shuts down.
            WreckRenderer.drawWreck(r.graphics, r.gridX, r.gridY, r.width, r.height, r.type, r.level, time, 0, r.baseGraphics);
            r.animationDone = true;
        });
    }

    /**
     * Runtime burn + smolder for SPRITE-BACKED wrecks — the same fire-spot /
     * rising-ember / smoke language WreckRenderer.burnFx bakes into vector
     * wrecks (identical 15s-burn → 30s-fade windows), rebuilt from whole
     * pixel cells and sized to the wreck footprint. Deterministic f(time);
     * per-wreck variation comes from the grid-position seed.
     */
    private drawWreckBurnFx(
        g: Phaser.GameObjects.Graphics,
        r: { gridX: number; gridY: number; width: number; height: number },
        time: number,
        fire: number
    ) {
        const seed = r.gridX * 1000 + r.gridY;
        const R = (i: number, k: number) => Math.sin(seed + i * k) * 0.5 + 0.5;
        // Footprint centre + spread in iso px (matches WreckRenderer's P map;
        // spreads sized like its burnFx call sites, e.g. 3x3 → ~74×38).
        const cx = (r.gridX + r.width / 2 - r.gridY - r.height / 2) * 32;
        const cy = (r.gridX + r.width / 2 + r.gridY + r.height / 2) * 16;
        const sx = r.width * 24;
        const sy = r.height * 12;
        if (fire > 0.05) {
            for (let i = 0; i < 3; i++) {
                const fx = cx + (R(i, 30.3) - 0.5) * sx;
                const fy = cy + (R(i, 31.4) - 0.5) * sy;
                const flicker = Math.sin(time / 100 + i * 2) * 0.3 + 0.7;
                const fs = Math.floor((5 + Math.sin(time / 150 + i) * 2.5) * fire);
                const gs = fs + 6;
                pixelRect(g, fx - gs / 2, fy - gs / 2, gs, gs, 0xff6600, 0.4 * flicker * fire);
                if (fs > 0) {
                    pixelRect(g, fx - fs / 2, fy - 2 - fs / 2, fs, fs, 0xff4400, 0.7 * flicker * fire);
                    const ts = Math.max(2, fs * 0.5);
                    const ty = fy - 5 - Math.sin(time / 80 + i) * 2;
                    pixelRect(g, fx - ts / 2, ty - ts / 2, ts, ts, 0xffaa00, 0.8 * flicker * fire);
                }
            }
            for (let i = 0; i < 5; i++) {
                const r1 = R(i, 40.4), r2 = R(i, 41.5);
                const cyc = ((time / 2000) + r1) % 1;
                const ex = cx + (r1 - 0.5) * sx * 0.7 + Math.sin(time / 300 + i) * 5;
                const ey = cy + (r2 - 0.5) * sy * 0.7 - cyc * 30;
                pixelRect(g, ex - 1, ey - 1, 3, 3, 0xff6600, (1 - cyc) * 0.8 * fire);
            }
        }
        // Smoke trails the dying fire and dies with it (same law as the bake).
        const smokeIntensity = Math.min(1, Math.max(0, fire * 1.4));
        if (smokeIntensity <= 0.01) return;
        const n = fire > 0.3 ? 3 : 5;
        for (let i = 0; i < n; i++) {
            const r1 = R(i, 50.5), r2 = R(i, 51.6);
            const cyc = ((time / 3000) + r1) % 1;
            const sxp = cx + (r1 - 0.5) * sx * 0.5 + Math.sin(time / 500 + i) * 8;
            const syp = cy + (r2 - 0.5) * sy * 0.5 - cyc * 50;
            const ss = Math.floor(4 + cyc * 10);
            pixelRect(g, sxp - ss / 2, syp - ss / 2, ss, ss, 0x555555, (1 - cyc) * 0.3 * smokeIntensity);
        }
    }

    private clearRubble() {
        this.rubble.forEach(r => {
            r.graphics.destroy();
            r.baseGraphics.destroy();
            r.fxGraphics?.destroy();
        });
        this.rubble = [];
    }

    // === OBSTACLE SYSTEM (Rocks, Trees, Grass) ===
    public placeObstacle(gridX: number, gridY: number, type: ObstacleType, skipBackend: boolean = false, idOverride?: string) {
        const info = OBSTACLES[type];
        if (!info) return false;

        // Check if position is valid (not overlapping buildings or other obstacles)
        if (!this.isObstaclePositionValid(gridX, gridY, info.width, info.height)) return false;

        const graphics = this.add.graphics();
        const animOffset = Math.random() * Math.PI * 2;

        const obstacle: PlacedObstacle = {
            id: idOverride || Phaser.Utils.String.UUID(),
            type,
            gridX,
            gridY,
            graphics,
            animOffset
        };

        this.drawObstacle(obstacle);

        graphics.setDepth(depthForObstacle(gridX, gridY, info.width, info.height));

        this.obstacles.push(obstacle);

        // Persist to backend if in HOME mode and not skipping. The SAME id must
        // be saved — grass variants (and easter eggs) hash off it, so an id
        // mismatch would reroll every patch's look on the next load.
        if (this.mode === 'HOME' && !skipBackend) {
            Backend.placeObstacle(this.userId, type, gridX, gridY, obstacle.id);
        }
        return true;
    }

    private isObstaclePositionValid(gridX: number, gridY: number, width: number, height: number): boolean {
        if (gridX < 0 || gridY < 0 || gridX + width > this.mapSize || gridY + height > this.mapSize) return false;

        // Check buildings
        for (const b of this.buildings) {
            const bInfo = BUILDINGS[b.type];
            const overlapX = Math.max(0, Math.min(gridX + width, b.gridX + bInfo.width) - Math.max(gridX, b.gridX));
            const overlapY = Math.max(0, Math.min(gridY + height, b.gridY + bInfo.height) - Math.max(gridY, b.gridY));
            if (overlapX > 0 && overlapY > 0) return false;
        }

        // Check other obstacles
        for (const o of this.obstacles) {
            const oInfo = OBSTACLES[o.type];
            const overlapX = Math.max(0, Math.min(gridX + width, o.gridX + oInfo.width) - Math.max(gridX, o.gridX));
            const overlapY = Math.max(0, Math.min(gridY + height, o.gridY + oInfo.height) - Math.max(gridY, o.gridY));
            if (overlapX > 0 && overlapY > 0) return false;
        }

        return true;
    }

    private drawObstacle(obstacle: PlacedObstacle, time: number = 0) {
        obstacle.graphics.clear();
        if (SpriteBank.syncObstacle(this, obstacle.graphics, obstacle.type, obstacle.id, obstacle.gridX, obstacle.gridY, time)) return;
        ObstacleRenderer.drawObstacle(obstacle.graphics, obstacle, time);
    }



    private updateObstacleAnimations(time: number) {
        // Foliage sway is ambient — stagger redraws across 3 frames (20fps) and
        // skip anything the camera can't see; grass alone can be 100+ patches.
        const staggerSlot = this.buildingAnimFrame;
        this.obstacles.forEach((obstacle, index) => {
            if (obstacle.type === 'tree_oak' || obstacle.type === 'tree_pine' || obstacle.type === 'grass_patch') {
                if (index % 3 !== staggerSlot) return;
                if (this.isOffScreen(obstacle.gridX, obstacle.gridY)) return;
                this.drawObstacle(obstacle, time);
            }
        });
    }

    public removeObstacle(obstacleId: string): boolean {
        const index = this.obstacles.findIndex(o => o.id === obstacleId);
        if (index === -1) return false;

        const obstacle = this.obstacles[index];
        obstacle.graphics.destroy();
        this.obstacles.splice(index, 1);

        // Persist to backend if in HOME mode
        if (this.mode === 'HOME') {
            Backend.removeObstacle(this.userId, obstacleId);
        }
        return true;
    }

    private clearObstacles() {
        this.obstacles.forEach(o => o.graphics.destroy());
        this.obstacles = [];
    }

    // === LEVEL 1: WOODEN PALISADE ===

    // === LEVEL 2: STONE WALL ===

    // === LEVEL 3: FORTIFIED DARK STONE ===





    /** Health bars live in the BattleOverlay scene: its camera mirrors this
     *  one, keeping bars and level digits above the night grade / rain layers.
     *  Falls back to this scene if
     *  the overlay hasn't booted yet (only possible during initial create). */
    private createHealthBarGraphics(): Phaser.GameObjects.Graphics {
        const overlay = this.scene.get('BattleOverlay');
        if (overlay && overlay.sys.displayList) {
            return overlay.add.graphics();
        }
        return this.add.graphics();
    }

    public updateHealthBar(item: PlacedBuilding | Troop) {
        if (!item.healthBar || !item.healthBar.scene) return; // Ignore destroyed health bars
        if ('isDestroyed' in item && item.isDestroyed) return;
        const bar = item.healthBar;
        const now = this.time.now;

        if (item.lastHealthBarValue === undefined || item.lastHealthBarValue !== item.health) {
            item.lastHealthBarValue = item.health;
            item.lastHealthChangeTime = now;
        }

        // Only show health bar if damage has been taken
        const hasDamage = item.health < item.maxHealth;
        const isTroop = !('graphics' in item);
        const showBar = isTroop ? (item as Troop).hasTakenDamage : hasDamage;

        if (!showBar) {
            bar.setVisible(false);
            bar.setAlpha(1);
            if (isTroop) (item as Troop).levelTag?.setVisible(false);
            return;
        }

        const lastChangeTime = item.lastHealthChangeTime ?? now;
        const elapsedSinceChange = Math.max(0, now - lastChangeTime);
        let alpha = 1;
        if (elapsedSinceChange > this.HEALTH_BAR_IDLE_MS) {
            const fadeElapsed = elapsedSinceChange - this.HEALTH_BAR_IDLE_MS;
            alpha = Phaser.Math.Clamp(1 - (fadeElapsed / this.HEALTH_BAR_FADE_MS), 0, 1);
        }

        if (alpha <= 0) {
            bar.setVisible(false);
            bar.setAlpha(1);
            if (isTroop) (item as Troop).levelTag?.setVisible(false);
            return;
        }

        bar.setVisible(true);
        bar.setAlpha(alpha);

        let x: number, y: number, width: number, height: number;
        const isBuilding = 'graphics' in item;

        if (isBuilding) {
            const info = BUILDINGS[item.type];
            if (!info) return;
            const p = IsoUtils.cartToIso(item.gridX + info.width / 2, item.gridY + info.height / 2);
            width = 36 + info.width * 8;
            height = 8;
            x = p.x - width / 2;
            // Anchor the bar just above the baked silhouette's top (stable
            // first idle frame, cached per level). The old blind
            // "-50 - h*10" guess floats 30-60px of air above squat sprites
            // (walls, storages, mines), so their bars landed over whatever
            // tile lay behind — reading as unowned bars hovering over rubble
            // or open grass. Vector fallback keeps the formula.
            // `== null` on purpose: a null lookup (bank still loading, or a
            // vector-fallback type) is retried on every draw instead of being
            // cached forever — the lookup is two map reads, and the anchor
            // must upgrade itself the moment the atlases land.
            if (item.barAnchorTop == null || item.barAnchorLevel !== (item.level ?? 1)) {
                item.barAnchorLevel = item.level ?? 1;
                item.barAnchorTop = SpriteBank.buildingTopOffset(item.type, item.level ?? 1);
            }
            y = item.barAnchorTop != null
                ? p.y - item.barAnchorTop - height - 4
                : p.y - 50 - (info.height * 10);
        } else {
            const troop = item as Troop;
            const pos = IsoUtils.cartToIso(troop.gridX, troop.gridY);
            width = 28;
            height = 6;
            x = pos.x - width / 2;

            // Adjust health bar height based on unit size (humanoids are
            // villager-scale now, so the default rides much lower).
            let yOffset = 22;
            if (troop.type === 'golem' || troop.type === 'icegolem') yOffset = 70;
            else if (troop.type === 'davincitank') yOffset = 48;
            else if (troop.type === 'mobilemortar') yOffset = 26;

            y = pos.y - yOffset;
        }

        // The level tag is a separate Image riding the bar: sync its position
        // every frame so it tracks the bar even when the geometry redraw
        // below gets skipped.
        if (isTroop) this.syncTroopLevelTag(item as Troop, x, y, width, height, alpha);

        // Geometry only depends on health and position — if neither moved since the
        // last draw, the existing paths are still correct and only the alpha/visibility
        // (already applied above) needed updating. This runs per entity per frame.
        if (item.lastBarDrawHealth === item.health && item.lastBarDrawX === x && item.lastBarDrawY === y) {
            return;
        }
        item.lastBarDrawHealth = item.health;
        item.lastBarDrawX = x;
        item.lastBarDrawY = y;
        bar.clear();

        const healthPct = Math.max(0, item.health / item.maxHealth);
        // Hand-pixelated styling: chunky 1.5-unit cells drawn directly in the
        // overlay scene, independent of the smooth world sampling policy.
        const C = 1.5;

        // Border (dark ring, one cell thick, stepped corners)
        bar.fillStyle(0x1a1a1a, 0.9);
        this.drawPixelPill(bar, x - C, y - C, width + C * 2, height + C * 2, C);

        // Background (dark red/maroon for empty health)
        bar.fillStyle(0x4a1a1a, 1);
        this.drawPixelPill(bar, x, y, width, height, C);

        // Health fill color
        let fillColor: number;
        let highlightColor: number;
        if (healthPct > 0.6) {
            fillColor = 0x2ecc71;
            highlightColor = 0x58d68d;
        } else if (healthPct > 0.35) {
            fillColor = 0xf39c12;
            highlightColor = 0xf7dc6f;
        } else {
            fillColor = 0xe74c3c;
            highlightColor = 0xf1948a;
        }

        // Main health fill, quantized to whole cells so it depletes in steps
        if (healthPct > 0) {
            const fillWidth = Math.max(C, Math.round((width * healthPct) / C) * C);
            bar.fillStyle(fillColor, 1);
            this.drawPixelPill(bar, x, y, fillWidth, height, C);

            // Top shadow row, then a glossy band under it (one cell each)
            bar.fillStyle(0x000000, 0.2);
            bar.fillRect(x + C, y, Math.max(0, fillWidth - C * 2), C);
            bar.fillStyle(highlightColor, 0.4);
            bar.fillRect(x + C, y + C, Math.max(0, fillWidth - C * 2), C);

            // Specular sparkle: a short detached run of bright cells
            bar.fillStyle(0xffffff, 0.3);
            bar.fillRect(x + C * 2, y + C, Math.min(C * 3, Math.max(0, fillWidth - C * 4)), C);

            // Health segments (CoC-style dividers), one cell wide
            if (isBuilding && width > 30) {
                bar.fillStyle(0x000000, 0.3);
                const segments = Math.floor(width / 12);
                for (let i = 1; i < segments; i++) {
                    const segX = x + Math.round(((width / segments) * i) / C) * C;
                    bar.fillRect(segX, y + C, C, height - C * 2);
                }
            }
        }

        // Always set depth when bar is visible to ensure proper layering
        bar.setDepth(30000);
    }

    /** The troop level tag: a pre-pixelated chip texture (baked once in the
     *  BattleOverlay scene) shown as an Image at fixed WORLD size, so it
     *  shrinks with distance like the bar itself — Clash Royale style. It
     *  stays crisp because its texture explicitly samples NEAREST. Lifecycle
     *  rides on the health bar:
     *  created lazily here, hidden and faded with the bar, destroyed when
     *  the bar's Graphics is. */
    private syncTroopLevelTag(troop: Troop, barX: number, barY: number, _barW: number, barH: number, alpha: number) {
        if (!troop.levelTag || !troop.levelTag.scene) {
            const overlay = this.scene.get('BattleOverlay') as BattleOverlayScene | null;
            if (!overlay || !overlay.sys.displayList) return;
            const level = Math.max(1, Math.min(3, Math.floor(troop.level || 1)));
            const img = overlay.add.image(0, 0, overlay.ensureLevelChipTexture(level)).setDepth(30001);
            troop.healthBar.once(Phaser.GameObjects.Events.DESTROY, () => img.destroy());
            troop.levelTag = img;
        }
        const tag = troop.levelTag;
        // One texture cell per world unit: locked world size, never
        // counter-scaled against zoom, so the chip and the bar shrink
        // together when you pull the camera back.
        const scale = 1;
        tag.setScale(scale);
        // Docked Clash-Royale style: right edge overlapping the bar's left
        // border cell (C = 1.5), vertically centred on the bar.
        tag.setPosition(barX + 1.5 - (tag.width * scale) / 2, barY + barH / 2);
        tag.setVisible(true);
        tag.setAlpha(alpha);
    }

    /** Pixel-art pill: a rect with one corner cell cut on each corner —
     *  the chunky equivalent of a rounded rect, used by the battle bars. */
    private drawPixelPill(g: Phaser.GameObjects.Graphics, x: number, y: number, w: number, h: number, cell: number) {
        if (w < cell * 2 + 0.1 || h < cell * 2 + 0.1) {
            g.fillRect(x, y, w, h);
            return;
        }
        g.fillRect(x + cell, y, w - cell * 2, h);
        g.fillRect(x, y + cell, cell, h - cell * 2);
        g.fillRect(x + w - cell, y + cell, cell, h - cell * 2);
    }

    /**
     * THE animation clock. Replay watch stamps combat state (lastFireTime,
     * teslaChargeStart, lastAttackTime) on the stream clock, so every reader
     * (building/troop redraws, baked frame pickers) must measure ages against
     * the same clock — otherwise recoil/tension/charge animations never play
     * while spectating. Everywhere else it is plain scene time.
     */
    private animClockNow(): number {
        return this.mode === 'REPLAY' ? this.replaySimulationTime : this.time.now;
    }

    /** A troop whose kit heals allies (physician's cart) — the support-
     *  follower predicate that generalizes the deleted ward lane. */
    private isSupportHealer(troop: Pick<Troop, 'type' | 'level'>): boolean {
        const stats = getTroopStats(troop.type, troop.level || 1);
        return (stats.healRadius ?? 0) > 0 && (stats.healAmount ?? 0) > 0;
    }

    /**
     * The support kits' shared per-frame pass. Runs in ATTACK and REPLAY
     * watch (auras + pulse FX show while spectating) but never mutates
     * health during replay — the frame stream owns it. All ring motion is a
     * deterministic f(time, troop id); the pulse FX + heals fire on the
     * cart's 6s cadence (its attackDelay) from a deploy-anchored clock.
     */
    private updateSupportKits(time: number, isReplayWatch: boolean) {
        let hasSupport = false;
        for (const troop of this.troops) {
            if (troop.health <= 0) continue;
            const stats = this.getTroopCombatStats(troop);
            if ((stats.healRadius ?? 0) > 0 || (stats.boostRadius ?? 0) > 0) {
                hasSupport = true;
                break;
            }
        }
        if (!hasSupport) {
            if (this.kitAuraGfx?.active) this.kitAuraGfx.clear();
            return;
        }

        if (!this.kitAuraGfx || !this.kitAuraGfx.active) {
            this.kitAuraGfx = this.trackBattleFx(this.add.graphics());
            this.kitAuraGfx.setDepth(7);
        }
        const gfx = this.kitAuraGfx;
        gfx.clear();

        for (const troop of this.troops) {
            if (troop.health <= 0) continue;
            const stats = this.getTroopCombatStats(troop);

            // --- PHYSICIAN'S CART: heal aura + 6s burst heal ---------------
            if ((stats.healRadius ?? 0) > 0 && (stats.healAmount ?? 0) > 0) {
                const pos = IsoUtils.cartToIso(troop.gridX, troop.gridY);
                const aura = this.gridRangeToIsoRadii(stats.healRadius ?? 5.5);
                const glow = troop.owner === 'PLAYER' ? 0x58d68d : 0x45b39d;
                const seed = hashString(`${troop.id}:aura`) % 1000;
                const pulse = 0.5 + 0.5 * Math.sin((time + seed) / 420);
                this.pixelRing(gfx, pos.x, pos.y + 5, aura.rx, aura.ry, 2, glow, 0.14 + 0.1 * pulse);

                const cadence = stats.attackDelay ?? 6000;
                if (troop.lastHealPulseAt === undefined) troop.lastHealPulseAt = time;
                if (time > troop.lastHealPulseAt + cadence) {
                    troop.lastHealPulseAt = time;

                    // (a) The heal wave — an expanding iso ring to the radius.
                    this.trackBattleFx(PixelFx.ring(this, pos.x, pos.y + 5, {
                        r0: 8, r1: aura.rx, squash: aura.ry / Math.max(1, aura.rx),
                        thick0: 3, thick1: 1, color: 0x8ef5b6, alpha: 0.85,
                        life: 460, ease: 'Quad.easeOut',
                        depth: depthForGroundEffect(troop.gridX, troop.gridY) + 1
                    }));

                    // (b) Burst-heal ALL allies in radius (+ floating green
                    // numbers) — battle sim only; replay frames own health.
                    if (!isReplayWatch) {
                        let seq = 0;
                        for (const other of this.troops) {
                            if (other.owner !== troop.owner || other.health <= 0 || other.id === troop.id) continue;
                            if (other.health >= other.maxHealth) continue;
                            const d = Phaser.Math.Distance.Between(troop.gridX, troop.gridY, other.gridX, other.gridY);
                            if (d > (stats.healRadius ?? 0)) continue;
                            const healed = Math.min(other.maxHealth - other.health, stats.healAmount ?? 0);
                            if (healed <= 0) continue;
                            other.health += healed;
                            this.updateHealthBar(other);
                            this.showHealNumber(other, healed, seq++);
                        }
                    }
                }
            }

            // --- QUARTERMASTER: drum-ring aura + beat pulse ----------------
            if ((stats.boostRadius ?? 0) > 0) {
                const pos = IsoUtils.cartToIso(troop.gridX, troop.gridY);
                const aura = this.gridRangeToIsoRadii(stats.boostRadius ?? 6);
                const seed = hashString(`${troop.id}:drums`) % 1000;
                // Steady rim on an exact 2000ms harmonic...
                const rim = 0.5 + 0.5 * Math.sin(((time + seed) % 2000) / 2000 * Math.PI * 2);
                this.pixelRing(gfx, pos.x, pos.y + 5, aura.rx, aura.ry, 2, 0xd4a017, 0.12 + 0.08 * rim);
                // ...and a subtle beat ring rolling out every 1000ms.
                const beat = ((time + seed) % 1000) / 1000;
                const sf = 0.18 + beat * 0.82;
                this.pixelRing(gfx, pos.x, pos.y + 5, aura.rx * sf, aura.ry * sf, 1, 0xe8bd54, 0.22 * (1 - beat));
            }
        }
    }

    /** Floating heal number (BattleOverlay DIGITS_5X7 texture, NEAREST-
     *  sampled, world-anchored): rises 13px and fades — the plus-sign tween
     *  recipe. `seq` staggers side-by-side numbers in one pulse. */
    private showHealNumber(troop: Troop, amount: number, seq: number) {
        const overlay = this.scene.get('BattleOverlay') as BattleOverlayScene | null;
        if (!overlay || !overlay.sys.displayList) return;
        const key = overlay.ensureHealNumberTexture(amount);
        const pos = IsoUtils.cartToIso(troop.gridX, troop.gridY);
        const img = overlay.add.image(pos.x + ((seq % 3) - 1) * 5, pos.y - 24, key);
        img.setDepth(30002);
        this.trackBattleFx(img);
        this.tweens.add({
            targets: img,
            y: img.y - 13,
            alpha: 0,
            duration: 500,
            ease: 'Quad.easeOut',
            onComplete: () => img.destroy()
        });
    }

    /** Necromancer cast flourish, keyed to the summon tick: grave-light
     *  flash at the staff + a rolling ground ring. */
    private showSummonFlourish(troop: Troop) {
        const pos = IsoUtils.cartToIso(troop.gridX, troop.gridY);
        const groundDepth = depthForGroundEffect(troop.gridX, troop.gridY);
        this.trackBattleFx(PixelFx.flash(this, pos.x, pos.y - 16, {
            r: 7, color: 0xb08aff, alpha: 0.9, scaleTo: 1.8, life: 220,
            depth: depthForTroop(troop.gridX, troop.gridY, troop.type) + 0.5
        }));
        this.trackBattleFx(PixelFx.ring(this, pos.x, pos.y + 5, {
            r0: 6, r1: 34, squash: 0.5, thick0: 2, thick1: 1,
            color: 0x8a63cc, alpha: 0.7, life: 380, ease: 'Quad.easeOut',
            depth: groundDepth + 1
        }));
        this.redrawTroopWithMovement(troop, false);
    }

    /**
     * SIEGE TOWER PARKING. The tower becomes stationary (still targetable),
     * tweens its parked01 driver 0→1 through the redraw path (the
     * TroopDesignFn `driver` arg / the baked 'deactivated' pose), and — when
     * its charge line stopped at an enemy wall — marks that wall as an ALLY
     * RAMP: same-owner ground troops path over it at COST_OPEN+12. Plain
     * topology bump (never the removal-promotion path) so affected troops
     * replan into the opening.
     */
    private parkSiegeTower(troop: Troop, time: number) {
        void time;
        troop.parked01 = 0.0001; // parked marker; the tween carries it to 1
        troop.path = undefined;
        troop.navigationPlan = undefined;
        troop.velocityX = 0;
        troop.velocityY = 0;

        const target = troop.target as PlacedBuilding | null;
        if (target && target.type === 'wall' && target.owner !== troop.owner
            && target.health > 0 && !target.isDestroyed) {
            troop.parkedWallId = target.id;
            this.rampedWallsByOwner[troop.owner].add(target.id);
            this.combatTopologyRevision++; // plain bump — replans discover the ramp
        }
        troop.target = null;
        troop.strategicTarget = null;

        const driver = { p: 0 };
        this.trackBattleFxTween(this.tweens.add({
            targets: driver,
            p: 1,
            duration: 700,
            ease: 'Sine.easeOut',
            onUpdate: () => {
                if (troop.health <= 0) return;
                troop.parked01 = driver.p;
                this.redrawTroopWithMovement(troop, false);
            },
            onComplete: () => {
                if (troop.health <= 0) return;
                troop.parked01 = 1;
                this.redrawTroopWithMovement(troop, false);
            }
        }));

        // Settling dust as the ramp drops.
        const pos = IsoUtils.cartToIso(troop.gridX, troop.gridY);
        PixelFx.burst(this, pos.x, pos.y + 6, {
            count: 6, colors: [0x8b7355, 0x9b8365], alpha: 0.55,
            r: 2, rJitter: 1.5, spread: 14, up: 6, upJitter: 4,
            life: 320, lifeJitter: 120, scaleTo: 1.6,
            depth: depthForGroundEffect(troop.gridX, troop.gridY)
        });
        this.cameras.main.shake(30, 0.001);
    }

    /** The ally-ramp set threaded into navigation for THIS troop — only
     *  same-owner troops ride a tower's ramp; undefined when none exist. */
    private rampSetFor(troop: Pick<Troop, 'owner'>): ReadonlySet<string> | undefined {
        const set = this.rampedWallsByOwner[troop.owner];
        return set.size > 0 ? set : undefined;
    }

    private updateCombat(time: number) {
        const isReplayWatch = this.mode === 'REPLAY';
        if (this.mode !== 'ATTACK' && !isReplayWatch) return;

        // Thaw pass BEFORE the defense tick so an expired freeze drops its
        // icy dressing on the same frame the defense resumes firing.
        this.updateFrozenDefenses(time);

        this.defenseSystem.update(time, this.buildings, this.troops);

        // Support-kit presentation + (outside replay) the burst heals: runs in
        // BOTH modes so auras/pulse FX show while spectating, but never
        // mutates health during replay watch (the frame stream owns it).
        this.updateSupportKits(time, isReplayWatch);

        // Replay watch: the frame stream owns troop state. Defenses above still
        // aim/fire (their shots and recoil are presentation, stamped on the
        // replay clock), but the local troop attack sim stays OFF — its damage
        // and kills would saw-tooth against every authoritative frame sync and
        // re-detonate suicide units the frames already resolved.
        if (isReplayWatch) return;

        this.troops.forEach(troop => {
            if (troop.health <= 0) return;



            // Validate strategic intent before the active damage target. A wall
            // may be the current interaction target, but never replaces the
            // building this troop is actually trying to reach. A parked siege
            // tower is terminal: it never renavigates.
            if (troop.parked01 === undefined) this.ensureTroopNavigation(troop, time);

            // NECROMANCER — summon waves ride a deploy-anchored timer (NOT the
            // attack clock): every summonIntervalMs raise summonCount
            // generated units at deterministic offsets, capped to summonCap
            // ALIVE per summoner (summonedBy === troop.id). Skipped waves
            // (at cap) keep the cadence. Skeletons die permanently.
            const kitStats = this.getTroopCombatStats(troop);
            if (kitStats.summonType && (kitStats.summonIntervalMs ?? 0) > 0) {
                if (troop.lastSummonTime === undefined) troop.lastSummonTime = time;
                if (time > troop.lastSummonTime + (kitStats.summonIntervalMs ?? 5000)) {
                    troop.lastSummonTime = time;
                    const alive = this.troops.filter(other =>
                        other.summonedBy === troop.id && other.health > 0).length;
                    const room = Math.min(
                        kitStats.summonCount ?? 0,
                        Math.max(0, (kitStats.summonCap ?? Number.POSITIVE_INFINITY) - alive)
                    );
                    if (room > 0) {
                        const wave = troop.summonWaves = (troop.summonWaves ?? 0) + 1;
                        this.showSummonFlourish(troop);
                        const summonType = kitStats.summonType;
                        const summonerId = troop.id;
                        const owner = troop.owner;
                        const level = troop.level || 1;
                        for (let i = 0; i < room; i++) {
                            const off = MainScene.SUMMON_OFFSETS[
                                (wave * (kitStats.summonCount ?? 1) + i) % MainScene.SUMMON_OFFSETS.length];
                            const sx = troop.gridX + off.dx;
                            const sy = troop.gridY + off.dy;
                            this.pendingSpawnCount++;
                            this.scheduleBattleCall(i * 40, () => {
                                const spawned = this.spawnTroop(sx, sy, summonType, owner, level);
                                if (spawned) spawned.summonedBy = summonerId;
                                this.pendingSpawnCount--;
                            });
                        }
                    }
                }
            }
            // A missing/stale plan must not silence the attack tick: a troop
            // already standing in range keeps swinging while its staggered
            // replan slot is pending (the range gates below stay in force).
            // Gating attacks on plan presence fed the stuck-replan cycle.
            if (!troop.target) return;

            if (troop.target) {
                const b = troop.target;
                const isBuilding = ('type' in b && BUILDINGS[b.type]);
                const tw = isBuilding ? BUILDINGS[b.type].width : 0.5;
                const th = isBuilding ? BUILDINGS[b.type].height : 0.5;
                const bx = isBuilding ? b.gridX : b.gridX - tw / 2;
                const by = isBuilding ? b.gridY : b.gridY - th / 2;

                const dx = Math.max(bx - troop.gridX, 0, troop.gridX - (bx + tw));
                const dy = Math.max(by - troop.gridY, 0, troop.gridY - (by + th));
                const dist = Math.sqrt(dx * dx + dy * dy);

                const stats = this.getTroopCombatStats(troop);
                const isEnemy = b.owner !== troop.owner;

                if (dist <= stats.range + 0.1) {
                    if (time > troop.lastAttackTime + troop.attackDelay) {
                        // ATTACK LOGIC
                        if (isEnemy) {
                            troop.lastAttackTime = time;

                            if (troop.type === 'archer') {
                                this.showArcherProjectile(troop, troop.target, stats.damage);
                            } else if (troop.type === 'mobilemortar') {
                                // Mobile Mortar - arcing splash attack like mortar building
                                this.showMobileMortarShot(troop, troop.target, stats.damage);
                            } else if (troop.type === 'trebuchet') {
                                // TREBUCHET — r11 artillery on the mobile-mortar
                                // pattern: high boulder arc, splash on impact,
                                // never moves while firing (in-range hold).
                                this.showTrebuchetShot(troop, troop.target, stats.damage);
                            } else if (troop.type === 'ornithopter') {
                                // ORNITHOPTER — lobs an iron bomb from altitude.
                                this.showOrnithopterBomb(troop, troop.target, stats.damage);
                            } else if (troop.type === 'stormmage') {
                                this.showStormLightning(troop, troop.target, stats.damage);
                            } else if (troop.type === 'golem' || troop.type === 'icegolem') {
                                // GOLEM GROUND POUND - Single slam with AoE damage
                                // (icegolem shares the slam-class attack contract)
                                const currentPos = IsoUtils.cartToIso(troop.gridX, troop.gridY);

                                // Initialize slamOffset if not set
                                if (troop.slamOffset === undefined) troop.slamOffset = 0;

                                // Single slam animation - body/head drops down (using slamOffset)
                                const slamTarget = { offset: 0 };
                                this.tweens.add({
                                    targets: slamTarget,
                                    offset: 12, // Body/head slam down amount
                                    duration: 200,
                                    ease: 'Quad.easeIn',
                                    onUpdate: () => {
                                        troop.slamOffset = slamTarget.offset;
                                        this.redrawTroopWithMovement(troop, false);
                                    },
                                    onComplete: () => {
                                        // Screen shake at impact
                                        this.cameras.main.shake(50, 0.0015);

                                        // Deal damage to all buildings within 3 tile radius
                                        const aoeTiles = 3;

                                        // Ground crack effect (moved higher to align with
                                        // slam), scaled to the DAMAGE radius so the art
                                        // covers everything the slam actually hits. The
                                        // ice golem lands its own frost vocabulary (rime
                                        // fissures, not stone dust) — same envelope.
                                        if (troop.type === 'icegolem') {
                                            this.showIceGolemCrackEffect(currentPos.x, currentPos.y + 15, aoeTiles, troop.owner);
                                        } else {
                                            this.showGolemCrackEffect(currentPos.x, currentPos.y + 15, aoeTiles);
                                        }
                                        [...this.buildings].forEach(b => {
                                            if (b.owner !== troop.owner && b.health > 0) {
                                                const bdx = (b.gridX + BUILDINGS[b.type].width / 2) - troop.gridX;
                                                const bdy = (b.gridY + BUILDINGS[b.type].height / 2) - troop.gridY;
                                                const bdist = Math.sqrt(bdx * bdx + bdy * bdy);
                                                if (bdist <= aoeTiles) {
                                                    b.health -= stats.damage;
                                                    this.updateHealthBar(b);
                                                    if (b.health <= 0) {
                                                        this.destroyBuilding(b);
                                                    }
                                                }
                                            }
                                        });

                                        // Rise back up. The ice golem settles FORWARD through
                                        // slamOffset 12→24 (drawIceGolem maps >12 to its own
                                        // authored recovery poses): SpriteBank picks attack
                                        // frames by nearest slamOffset VALUE, so the 12→0
                                        // retrace would re-display the overhead hoist right
                                        // after the crash. pose(24) ≡ pose(0); onComplete
                                        // snaps the driver back to 0 so the attack branch
                                        // releases to idle. The stone golem keeps its
                                        // original 12→0 retrace untouched.
                                        this.tweens.add({
                                            targets: slamTarget,
                                            offset: troop.type === 'icegolem' ? 24 : 0,
                                            duration: 400,
                                            ease: 'Quad.easeOut',
                                            onUpdate: () => {
                                                troop.slamOffset = slamTarget.offset;
                                                this.redrawTroopWithMovement(troop, false);
                                            },
                                            onComplete: () => {
                                                troop.slamOffset = 0;
                                                this.redrawTroopWithMovement(troop, false);
                                            }
                                        });
                                    }
                                });

                            } else if (troop.type === 'davincitank') {
                                // DA VINCI TANK - Fire cannon from closest 45° position toward target
                                const tankPos = IsoUtils.cartToIso(troop.gridX, troop.gridY);
                                const targetBuilding = troop.target;
                                const targetInfo = BUILDINGS[targetBuilding.type];
                                const targetPos = IsoUtils.cartToIso(
                                    targetBuilding.gridX + targetInfo.width / 2,
                                    targetBuilding.gridY + targetInfo.height / 2
                                );

                                // Store current angle for rotation after shot
                                const currentAngle = troop.facingAngle || 0;

                                // Calculate angle TO target
                                const angleToTarget = Math.atan2(targetPos.y - tankPos.y, targetPos.x - tankPos.x);

                                // Snap to nearest 45° increment (8 cannons = PI/4 spacing)
                                const snapIncrement = Math.PI / 4;
                                const firingAngle = Math.round(angleToTarget / snapIncrement) * snapIncrement;

                                // Muzzle effects appear CLOSER to tank
                                const muzzleOffset = 30;
                                const muzzleX = tankPos.x + Math.cos(firingAngle) * muzzleOffset;
                                const muzzleY = tankPos.y + Math.sin(firingAngle) * muzzleOffset * 0.5 - 10;

                                // Cannonball starts FARTHER from tank
                                const ballOffset = 45;
                                const ballX = tankPos.x + Math.cos(firingAngle) * ballOffset;
                                const ballY = tankPos.y + Math.sin(firingAngle) * ballOffset * 0.5 - 12;

                                // Painter's-order depth from the shot's ground track: launch at
                                // the tank's tile, then per-frame along the track (onUpdate below)
                                // — "behind when shooting up" falls out of the row math for free.
                                const launchGX = troop.gridX;
                                const launchGY = troop.gridY;
                                const shotTargetGX = targetBuilding.gridX + targetInfo.width / 2;
                                const shotTargetGY = targetBuilding.gridY + targetInfo.height / 2;
                                const ballDepth = depthForProjectile(launchGX, launchGY);

                                // Muzzle flash
                                const flash = this.trackBattleFx(this.add.graphics());
                                pixelEllipse(flash, 0, 0, 8, 8, 0xffaa00, 0.9);
                                pixelEllipse(flash, 0, 0, 4, 4, 0xffff00, 0.7);
                                flash.setPosition(muzzleX, muzzleY);
                                flash.setDepth(depthForGroundEffect(launchGX, launchGY));
                                this.tweens.add({
                                    targets: flash,
                                    scale: 2, alpha: 0,
                                    duration: 150,
                                    onComplete: () => flash.destroy()
                                });

                                // Cannonball projectile - 2x SMALLER (3px radius)
                                const ball = this.trackBattleFx(this.add.graphics());
                                pixelEllipse(ball, 0, 0, 3, 3, 0x2a2a2a, 1);
                                pixelEllipse(ball, -0.5, -0.5, 1, 1, 0x4a4a4a, 1);
                                ball.setPosition(ballX, ballY);
                                ball.setDepth(ballDepth);

                                // Smoke puff at muzzle - smaller
                                particleManager.emitSmokeTracker('troop_fire_' + troop.id, muzzleX, muzzleY, time, depthForGroundEffect(launchGX, launchGY), 3, 0);

                                // Light screen shake on fire
                                this.cameras.main.shake(25, 0.0005);

                                // ROTATE AFTER SHOT - delayed until cannonball is in flight
                                const newAngle = currentAngle + Math.PI / 4;
                                this.scheduleBattleCall(150, () => {
                                    const rotationTarget = { angle: currentAngle };
                                    this.tweens.add({
                                        targets: rotationTarget,
                                        angle: newAngle,
                                        duration: 200,
                                        ease: 'Quad.easeOut',
                                        onUpdate: () => {
                                            troop.facingAngle = rotationTarget.angle % (Math.PI * 2);
                                            this.redrawTroopWithMovement(troop, false);
                                        }
                                    });
                                });

                                // Store target reference for damage application
                                const targetRef = targetBuilding;
                                const damage = stats.damage;

                                // Cannonball flies to target - FASTER, damage on IMPACT
                                this.tweens.add({
                                    targets: ball,
                                    x: targetPos.x,
                                    y: targetPos.y - 10,
                                    duration: 200,  // Faster flight
                                    ease: 'Quad.easeIn',
                                    onUpdate: (tween) => {
                                        // Depth follows the ground track under the shot.
                                        const t = tween.progress;
                                        ball.setDepth(depthForProjectile(
                                            launchGX + (shotTargetGX - launchGX) * t,
                                            launchGY + (shotTargetGY - launchGY) * t));
                                    },
                                    onComplete: () => {
                                        // Impact effect - isometric oval
                                        const impact = this.trackBattleFx(this.add.graphics());
                                        pixelEllipse(impact, 0, 0, 8, 4, 0xff6600, 0.6);
                                        impact.setPosition(targetPos.x, targetPos.y - 10);
                                        impact.setDepth(depthForGroundEffect(shotTargetGX, shotTargetGY));
                                        this.tweens.add({
                                            targets: impact,
                                            scale: 1.5, alpha: 0,
                                            duration: 200,
                                            onComplete: () => impact.destroy()
                                        });
                                        ball.destroy();

                                        // DAMAGE APPLIED ON IMPACT
                                        if (targetRef && targetRef.health > 0) {
                                            targetRef.health -= damage;
                                            this.updateHealthBar(targetRef);

                                            if (targetRef.health <= 0) {
                                                this.destroyBuilding(targetRef);
                                                troop.target = null;
                                            }
                                        }
                                    }
                                });

                            } else if (troop.type === 'phalanx') {
                                // PHALANX - Spear thrust attack
                                const targetBuilding = troop.target;

                                // Reset and tilt facing angle toward target
                                const tankPos = IsoUtils.cartToIso(troop.gridX, troop.gridY);
                                const targetInfo = BUILDINGS[targetBuilding.type];
                                const targetPos = IsoUtils.cartToIso(
                                    targetBuilding.gridX + targetInfo.width / 2,
                                    targetBuilding.gridY + targetInfo.height / 2
                                );
                                troop.facingAngle = Math.atan2(targetPos.y - tankPos.y, targetPos.x - tankPos.x);

                                // Spear thrust animation
                                troop.phalanxSpearOffset = 0;
                                this.tweens.add({
                                    targets: troop,
                                    phalanxSpearOffset: 1,
                                    duration: 150,
                                    yoyo: true,
                                    ease: 'Quad.easeIn',
                                    onUpdate: () => {
                                        this.redrawTroopWithMovement(troop, false);
                                    },
                                    onComplete: () => {
                                        troop.phalanxSpearOffset = 0;
                                        this.redrawTroopWithMovement(troop, false);
                                    }
                                });

                                // Apply damage directly
                                targetBuilding.health -= stats.damage;
                                this.updateHealthBar(targetBuilding);

                                if (targetBuilding.health <= 0) {
                                    this.destroyBuilding(targetBuilding);
                                    troop.target = null;
                                }
                            } else if (stats.detonateOnAttack) {
                                // SHARED DETONATION MODEL (wallbreaker, clockwork
                                // beetle) — one strike delivered as an
                                // edge-measured splash, then the troop dies
                                // through the REAL death path (destroyTroop keys
                                // the per-type boom FX). Behavior-identical to
                                // the old bespoke wallbreaker suicide.
                                troop.lastAttackTime = time;
                                const wallMult = troop.target.type === 'wall' ? ((stats as any).wallDamageMultiplier ?? 1) : 1;
                                const sRadius = (stats as any).splashRadius || 2.5;

                                // Apply splash damage to all buildings in radius.
                                // Splash is measured to the FOOTPRINT EDGE (the
                                // same geometry the movement stop uses) — the
                                // center measure let a bomber die adjacent to a
                                // large building's corner for zero damage.
                                [...this.buildings].forEach(b => {
                                    if (b.owner !== troop.owner && b.health > 0) {
                                        const bdist = this.getTargetEdgeDistance(troop, b);
                                        if (bdist <= sRadius) {
                                            const bMult = b.type === 'wall' ? wallMult : 1;
                                            const dmg = bdist < 0.5 ? stats.damage * bMult : stats.damage * bMult * 0.6;
                                            b.health -= dmg;
                                            this.updateHealthBar(b);
                                            if (b.health <= 0) {
                                                this.destroyBuilding(b);
                                            }
                                        }
                                    }
                                });

                                // Kill itself and trigger explosion visual
                                troop.health = 0;
                                this.destroyTroop(troop);
                            } else if (troop.type === 'siegetower') {
                                // SIEGE TOWER — never fights. On reaching what
                                // its charge line stopped at, it PARKS; a wall
                                // target becomes the ally ramp.
                                if (troop.parked01 === undefined) {
                                    this.parkSiegeTower(troop, time);
                                }
                            } else if (stats.damage <= 0) {
                                // Pure support (physician's cart, quartermaster):
                                // no attack — their kits run outside this tick.
                            } else {
                                // Melee: immediate damage (Warrior, Ram, Elephant)
                                let finalDamage = stats.damage;
                                const isWallStrike = troop.target.type === 'wall';
                                if (isWallStrike) {
                                    // Data-driven wall multiplier (ram ×4 —
                                    // unchanged — war elephant ×20: one instant
                                    // strike fells up to an L4 wall).
                                    finalDamage *= (stats as any).wallDamageMultiplier || 1;
                                }
                                if ((stats as any).resourceDamageMultiplier
                                    && BUILDINGS[troop.target.type]?.category === 'resource') {
                                    // Goblin plunderer: resource-class bonus.
                                    finalDamage *= (stats as any).resourceDamageMultiplier;
                                }

                                troop.target.health -= finalDamage;
                                this.updateHealthBar(troop.target);

                                const currentPos = IsoUtils.cartToIso(troop.gridX, troop.gridY);
                                const targetPos = IsoUtils.cartToIso(bx + tw / 2, by + th / 2);
                                const angle = Math.atan2(targetPos.y - currentPos.y, targetPos.x - currentPos.x);

                                if (troop.type === 'warelephant' && isWallStrike) {
                                    // WAR ELEPHANT TRAMPLE — the wall strike is
                                    // movement-inline: no punch tween, keep the
                                    // walk cycle so it reads as trampling
                                    // straight through, plus a dust burst at the
                                    // wall. One strike kills the wall; the
                                    // topology invalidation below replans it
                                    // onward with minimal stop.
                                    this.cameras.main.shake(50, 0.0022);
                                    PixelFx.burst(this, targetPos.x, targetPos.y + 4, {
                                        count: 8, colors: [0x8b7355, 0x9b8365, 0x6b5344], alpha: 0.7,
                                        r: 2.2, rJitter: 1.6, spread: 14, up: 9, upJitter: 6,
                                        life: 320, lifeJitter: 120, scaleTo: 1.6,
                                        depth: depthForGroundEffect(bx + tw / 2, by + th / 2)
                                    });
                                    this.redrawTroopWithMovement(troop, true);
                                } else {
                                    // Ram gets a bigger punch animation
                                    const punchDist = troop.type === 'ram' ? 18 : 10;
                                    this.tweens.add({
                                        targets: troop.gameObject,
                                        x: currentPos.x + Math.cos(angle) * punchDist,
                                        y: currentPos.y + Math.sin(angle) * (punchDist * 0.5),
                                        duration: troop.type === 'ram' ? 100 : 50,
                                        yoyo: true
                                    });

                                    // Screen shake for Ram impact
                                    if (troop.type === 'ram') {
                                        this.cameras.main.shake(40, 0.002);
                                    }
                                }

                                if (troop.target.health <= 0) {
                                    this.destroyBuilding(troop.target);
                                    troop.target = null;
                                }
                            }
                        }
                    }
                }
            }
        });

    }


    private shootMortarAt(mortar: PlacedBuilding, troop: Troop) {
        const info = BUILDINGS['mortar'];
        const stats = this.getDefenseStats(mortar);
        const start = IsoUtils.cartToIso(mortar.gridX + info.width / 2, mortar.gridY + info.height / 2);
        const end = IsoUtils.cartToIso(troop.gridX, troop.gridY);

        // Set angle for subtle mortar rotation
        const angle = Math.atan2(end.y - start.y, end.x - start.x);
        mortar.ballistaAngle = angle;

        // Level-based scaling - L3 is 1.3x bigger
        const level = mortar.level ?? 1;
        const shellScale = level >= 3 ? 1.3 : 1.0;
        const mortarDamage = stats.damage || 62;

        // Mortar shell - starts invisible, appears as it leaves barrel.
        // Depth is painter's order along the shot's ground track (launch tile
        // now, per-frame in onUpdate below).
        const launchGX = mortar.gridX + info.width / 2;
        const launchGY = mortar.gridY + info.height / 2;
        const shotTargetGX = troop.gridX;
        const shotTargetGY = troop.gridY;
        const ball = this.trackBattleFx(this.add.graphics());
        ball.setPosition(start.x, start.y - 35);
        ball.setDepth(depthForProjectile(launchGX, launchGY));
        ball.setAlpha(0);
        const ballBaked = this.syncProjectileSprite(ball, 'mortar_shell', Math.min(level, 4), 0);
        if (!ballBaked) ProjectileRenderer.drawMortarShell(ball, level);

        const midY = (start.y + end.y) / 2 - 350;

        // Muzzle flash and smoke effect
        this.createSmokeEffect(start.x, start.y - 35, depthForGroundEffect(launchGX, launchGY) + 1);

        const flash = this.trackBattleFx(this.add.graphics());
        pixelEllipse(flash, 0, 0, 8 * shellScale, 8 * shellScale, 0xff8800, 0.8);
        pixelEllipse(flash, 0, 0, 5 * shellScale, 5 * shellScale, 0xffcc00, 0.6);
        flash.setPosition(start.x, start.y - 35);
        flash.setDepth(depthForGroundEffect(launchGX, launchGY));
        this.tweens.add({
            targets: flash,
            alpha: 0,
            scale: 2,
            duration: 100,
            onComplete: () => flash.destroy()
        });

        // Animate the projectile - fade in quickly as it emerges
        this.tweens.add({
            targets: ball,
            alpha: 1,
            duration: 80,
            ease: 'Linear'
        });

        const dist = Phaser.Math.Distance.Between(start.x, start.y, end.x, end.y);
        this.tweens.add({
            targets: ball, x: end.x, duration: dist / 0.3, ease: 'Linear',
            onUpdate: (tween) => {
                const t = tween.progress;
                ball.y = (1 - t) * (1 - t) * (start.y - 35) + 2 * (1 - t) * t * midY + t * t * end.y;
                const scale = 0.5 + (1 - Math.abs(t - 0.5) * 2) * 0.6;
                ball.setScale(scale);
                ball.setRotation(t * Math.PI * 4);
                ball.setDepth(depthForProjectile(
                    launchGX + (shotTargetGX - launchGX) * t,
                    launchGY + (shotTargetGY - launchGY) * t));
                if (ballBaked) this.syncProjectileSprite(ball, 'mortar_shell', Math.min(level, 4), t * Math.PI * 4);
            },
            onComplete: () => {
                ball.destroy();
                this.createMortarExplosion(end.x, end.y, mortar.owner, troop.gridX, troop.gridY, level, mortarDamage);
            }
        });
    }

    private createMortarExplosion(
        x: number,
        y: number,
        owner: 'PLAYER' | 'ENEMY',
        targetGx: number,
        targetGy: number,
        level: number = 1,
        damage: number = 62
    ) {
        const scale = level >= 3 ? 1.3 : 1.0;
        // Airborne explosion layers sort with the world at the impact tile;
        // small ±N offsets keep the effect's internal stacking.
        const fxDepth = depthForGroundEffect(targetGx, targetGy);
        this.cameras.main.shake(50, 0.001 * scale);

        // Ground crater/scorch mark (L1-L2 only, L3 uses cracks instead) —
        // ground-decal band: above the stone-lanes RT (2.5), below scorches (5/6).
        if (level < 3) {
            const crater = this.trackBattleFx(this.add.graphics());
            pixelEllipse(crater, x, y + 5, 20 * scale, 10 * scale, 0x2a1a0a, 0.6);
            crater.setDepth(3);
            this.tweens.add({ targets: crater, alpha: 0, duration: 2000, delay: 500, onComplete: () => crater.destroy() });
        }

        // L3: Ground cracks radiating from impact (no circular crater)
        if (level >= 3) {
            const cracks = this.trackBattleFx(this.add.graphics());
            cracks.setDepth(3); // ground-decal band, above the stone-lanes RT (2.5)
            // Draw 6 cracks radiating outward
            for (let i = 0; i < 6; i++) {
                const angle = (i / 6) * Math.PI * 2 + Math.random() * 0.3;
                const length = 25 + Math.random() * 20;
                const midX = x + Math.cos(angle) * length * 0.5;
                const midY = y + Math.sin(angle) * length * 0.3; // Flatten for isometric
                const endX = x + Math.cos(angle) * length;
                const endY = y + Math.sin(angle) * length * 0.5;
                // Jagged crack line
                const jagX = midX + (Math.random() - 0.5) * 8;
                const jagY = midY + (Math.random() - 0.5) * 4;
                pixelLine(cracks, x, y, jagX, jagY, 1, 0x1a1a1a, 0.7);
                pixelLine(cracks, jagX, jagY, endX, endY, 1, 0x1a1a1a, 0.7);
                // Branch cracks
                if (Math.random() > 0.5) {
                    const branchAngle = angle + (Math.random() - 0.5) * 0.8;
                    pixelLine(cracks, midX, midY, midX + Math.cos(branchAngle) * 12, midY + Math.sin(branchAngle) * 6, 1, 0x1a1a1a, 0.7);
                }
            }
            this.tweens.add({ targets: cracks, alpha: 0, duration: 3000, delay: 800, onComplete: () => cracks.destroy() });
        }

        // Initial flash (isometric oval) — stepped redraw, never cell-scaling
        this.trackBattleFx(PixelFx.flash(this, x, y, {
            r: 5 * scale, squash: 0.5, color: 0xffffcc, alpha: 1,
            scaleTo: 10, life: 100, depth: fxDepth + 1
        }));

        // Primary shockwave ring (isometric oval)
        const shock = this.trackBattleFx(this.add.graphics());
        this.pixelRing(shock, x, y, 10 * scale, 5 * scale, 3, 0xff6600, 0.8);
        shock.setDepth(fxDepth);
        this.tweens.add({
            targets: shock, alpha: 0, duration: 400,
            onUpdate: (tween) => {
                shock.clear();
                const r = 10 * scale + tween.progress * 70 * scale;
                const shockThick = Math.max(1, Math.round((4 - tween.progress * 3) / 1.35));
                this.pixelRing(shock, x, y, r, r / 2, shockThick, 0xff6600, 0.8 - tween.progress * 0.8);
            },
            onComplete: () => shock.destroy()
        });

        // Secondary shockwave (isometric oval)
        this.scheduleBattleCall(50, () => {
            const shock2 = this.trackBattleFx(this.add.graphics());
            this.pixelRing(shock2, x, y, 15 * scale, 7.5 * scale, 1, 0xffaa00, 0.5);
            shock2.setDepth(fxDepth - 1);
            this.tweens.add({
                targets: shock2, alpha: 0, duration: 350,
                onUpdate: (tween) => {
                    shock2.clear();
                    const r2 = 15 * scale + tween.progress * 60 * scale;
                    this.pixelRing(shock2, x, y, r2, r2 / 2, 1, 0xffaa00, 0.5 - tween.progress * 0.5);
                },
                onComplete: () => shock2.destroy()
            });
        });

        // Fire particles (pixelated rectangles)
        const fireCount = level >= 3 ? 16 : 12;
        for (let i = 0; i < fireCount; i++) {
            const angle = (i / fireCount) * Math.PI * 2;
            const dist = (15 + Math.random() * 25) * scale;
            const fireColors = [0xff4400, 0xff6600, 0xff8800, 0xffaa00];
            const fireSize = (6 + Math.floor(Math.random() * 8)) * scale;
            const fire = this.trackBattleFx(this.add.graphics());
            pixelRect(fire, -fireSize / 2, -fireSize / 2, fireSize, fireSize, fireColors[Math.floor(Math.random() * 4)], 0.9);
            fire.setPosition(x, y);
            fire.setDepth(fxDepth + 2);
            this.tweens.add({
                targets: fire,
                x: x + Math.cos(angle) * dist,
                y: y + Math.sin(angle) * dist * 0.5 - 30 * scale - Math.random() * 40 * scale,
                alpha: 0, scale: 0.2,
                duration: 300 + Math.random() * 200,
                ease: 'Quad.easeOut',
                onComplete: () => fire.destroy()
            });
        }

        // Smoke plume (pixelated rectangles)
        for (let i = 0; i < 8; i++) {
            const delay = i * 30;
            this.scheduleBattleCall(delay, () => {
                const smokeColors = [0x444444, 0x555555, 0x666666];
                const smokeSize = 8 + Math.floor(Math.random() * 12);
                const smoke = this.trackBattleFx(this.add.graphics());
                pixelRect(smoke, -smokeSize / 2, -smokeSize / 2, smokeSize, smokeSize, smokeColors[Math.floor(Math.random() * 3)], 0.6);
                smoke.setPosition(x + (Math.random() - 0.5) * 30, y);
                smoke.setDepth(fxDepth - 2);
                this.tweens.add({
                    targets: smoke,
                    y: smoke.y - 60 - Math.random() * 40,
                    x: smoke.x + (Math.random() - 0.5) * 30,
                    scale: 2.5, alpha: 0,
                    duration: 800 + Math.random() * 400,
                    ease: 'Quad.easeOut',
                    onComplete: () => smoke.destroy()
                });
            });
        }

        // Debris/dirt chunks
        for (let i = 0; i < 6; i++) {
            const angle = Math.random() * Math.PI * 2;
            const debris = this.trackBattleFx(this.add.graphics());
            pixelRect(debris, -3, -3, 6, 6, 0x5a4a3a, 1);
            debris.setPosition(x, y);
            debris.setDepth(fxDepth + 3);

            const dist = 30 + Math.random() * 40;
            const peakY = y - 40 - Math.random() * 30;

            this.tweens.add({
                targets: debris,
                x: x + Math.cos(angle) * dist,
                duration: 500 + Math.random() * 200,
                ease: 'Quad.easeOut'
            });
            this.tweens.add({
                targets: debris,
                y: [peakY, y + 10],
                duration: 500 + Math.random() * 200,
                ease: 'Quad.easeIn',
                onComplete: () => debris.destroy()
            });
        }

        // Deal damage (smaller splash radius)
        const splashRadius = 2.5;
        this.troops.slice().forEach(t => {
            const d = Phaser.Math.Distance.Between(t.gridX, t.gridY, targetGx, targetGy);
            if (d < splashRadius && t.owner !== owner) {
                this.applyLocalTroopDamage(t, damage);
            }
        });
    }


    private shootAt(cannon: PlacedBuilding, troop: Troop): boolean {
        // Previous ball still in flight: refuse the shot WITHOUT consuming
        // the cooldown (DefenseSystem skips its lastFireTime stamp on false).
        if (cannon.isFiring) return false;
        cannon.isFiring = true;

        // Capture target reference at the start
        const targetTroop = troop;
        const stats = this.getDefenseStats(cannon);
        const cannonDamage = stats.damage || 70;

        const info = BUILDINGS['cannon'];
        const start = IsoUtils.cartToIso(cannon.gridX + info.width / 2, cannon.gridY + info.height / 2);
        const end = IsoUtils.cartToIso(targetTroop.gridX, targetTroop.gridY);
        const angle = Math.atan2(end.y - (start.y - 14), end.x - start.x);

        // Set target angle for smooth rotation (same system as ballista/xbow)
        cannon.ballistaTargetAngle = angle;

        // Painter's-order depth along the shot's ground track: launch tile
        // now, per-frame in the flight tween's onUpdate (the old
        // `cannon.depth + 50` left the ball behind anything a row south of
        // the cannon for its whole flight).
        const launchGX = cannon.gridX + info.width / 2;
        const launchGY = cannon.gridY + info.height / 2;
        const ballDepth = depthForProjectile(launchGX, launchGY);
        const muzzleFxDepth = depthForGroundEffect(launchGX, launchGY);

        // Calculate barrel tip position for muzzle flash
        const barrelLength = 28;
        const barrelHeight = -14;
        const barrelTipX = start.x + Math.cos(angle) * barrelLength;
        const barrelTipY = start.y + barrelHeight + Math.sin(angle) * 0.5 * barrelLength;

        // Muzzle flash at barrel tip - pixelated rectangles
        const flash = this.trackBattleFx(this.add.graphics());
        pixelRect(flash, barrelTipX - 12, barrelTipY - 12, 24, 24, 0xffcc00, 0.9);
        pixelRect(flash, barrelTipX - 6, barrelTipY - 6, 12, 12, 0xffffff, 0.9);
        flash.setDepth(muzzleFxDepth);
        this.tweens.add({ targets: flash, alpha: 0, duration: 100, onComplete: () => flash.destroy() });

        // Gunpowder smoke - pixelated rectangles
        for (let i = 0; i < 3; i++) {
            const smoke = this.trackBattleFx(this.add.graphics());
            const smokeSize = 4 + Math.floor(Math.random() * 4);
            const smokeAngle = angle + (Math.random() - 0.5) * 0.5;
            const dist = 10 + Math.random() * 15;
            const sx = barrelTipX + Math.cos(smokeAngle) * dist * 0.2; // Start near tip
            const sy = barrelTipY + Math.sin(smokeAngle) * dist * 0.2;

            pixelRect(smoke, -smokeSize / 2, -smokeSize / 2, smokeSize, smokeSize, 0xdddddd, 0.6);
            smoke.setPosition(sx, sy);
            smoke.setDepth(muzzleFxDepth + 1); // Above flash

            this.tweens.add({
                targets: smoke,
                x: sx + Math.cos(smokeAngle) * dist,
                y: sy + Math.sin(smokeAngle) * dist * 0.5 - 10 - Math.random() * 10, // Drift up
                alpha: 0,
                scale: 1.5,
                duration: 400 + Math.random() * 300,
                onComplete: () => smoke.destroy()
            });
        }

        // === BARREL RECOIL ===
        // Set recoil to max and tween back to 0
        cannon.cannonRecoilOffset = 1;
        this.tweens.add({
            targets: cannon,
            cannonRecoilOffset: 0,
            duration: 200,
            ease: 'Back.easeOut'
        });

        // Cannonball (pixelated rectangle)
        const cLevel = cannon.level ?? 1;
        const ball = this.trackBattleFx(this.add.graphics());
        ball.setPosition(barrelTipX, barrelTipY);
        ball.setDepth(ballDepth);
        const ballBaked = this.syncProjectileSprite(ball, 'cannonball', Math.min(cLevel, 4), 0, 1);
        if (!ballBaked) ProjectileRenderer.drawCannonball(ball, cLevel);

        // Projectile HOMES onto the troop's live position: the flight tween
        // drives progress only; each update re-aims at where the troop is
        // now, so the impact effect and the damage land on the same spot.
        const aim = { x: end.x, y: end.y };
        const dist = Phaser.Math.Distance.Between(barrelTipX, barrelTipY, end.x, end.y);
        const flight = { t: 0 };
        this.trackBattleFxTween(this.tweens.add({
            targets: flight, t: 1, duration: dist / 0.8, ease: 'Quad.easeIn',
            onUpdate: () => {
                if (targetTroop.health > 0 && targetTroop.gameObject.active) {
                    const live = IsoUtils.cartToIso(targetTroop.gridX, targetTroop.gridY);
                    aim.x = live.x;
                    aim.y = live.y;
                }
                ball.setPosition(
                    barrelTipX + (aim.x - barrelTipX) * flight.t,
                    barrelTipY + (aim.y - barrelTipY) * flight.t
                );
                // Depth follows the ground track under the shot.
                ball.setDepth(depthForProjectile(
                    launchGX + (targetTroop.gridX - launchGX) * flight.t,
                    launchGY + (targetTroop.gridY - launchGY) * flight.t));
                if (ballBaked) this.syncProjectileSprite(ball, 'cannonball', Math.min(cLevel, 4), 0, 1);
            },
            onComplete: () => {
                ball.destroy();
                cannon.isFiring = false;

                // Impact effect (pixelated rectangle)
                const impact = this.trackBattleFx(this.add.graphics());
                pixelRect(impact, aim.x - 8, aim.y, 16, 8, 0x8b7355, 0.6);
                impact.setDepth(depthForGroundEffect(targetTroop.gridX, targetTroop.gridY) - 1);
                this.tweens.add({ targets: impact, alpha: 0, duration: 300, onComplete: () => impact.destroy() });

                // Apply damage to captured target using level-based damage
                if (targetTroop && targetTroop.health > 0) {
                    // Hit flash effect (pixelated rectangle) — presentation,
                    // shown whether or not the local damage sim is live.
                    const troopPos = IsoUtils.cartToIso(targetTroop.gridX, targetTroop.gridY);
                    const hitFlash = this.trackBattleFx(this.add.graphics());
                    pixelRect(hitFlash, troopPos.x - 8, troopPos.y - 18, 16, 16, 0xffffff, 0.6);
                    hitFlash.setDepth(depthForGroundEffect(targetTroop.gridX, targetTroop.gridY));
                    this.tweens.add({ targets: hitFlash, alpha: 0, duration: 80, onComplete: () => hitFlash.destroy() });

                    this.applyLocalTroopDamage(targetTroop, cannonDamage);
                }
            }
        }));
        return true;
    }


    private shootTeslaAt(tesla: PlacedBuilding, troop: Troop) {
        const stats = this.getDefenseStats(tesla);
        const start = IsoUtils.cartToIso(tesla.gridX + 0.5, tesla.gridY + 0.5);
        start.y -= 40; // From the orb
        // World-sorted depths via DepthSystem, like every other combat FX —
        // fixed 10000-band depths floated the zap over unrelated rows.
        const towerGX = tesla.gridX + 0.5;
        const towerGY = tesla.gridY + 0.5;

        // Orb pulse effect (pixelated rectangle)
        const orbPulse = this.trackBattleFx(this.add.graphics());
        pixelRect(orbPulse, -12, -12, 24, 24, 0x88eeff, 0.6);
        orbPulse.setPosition(start.x, start.y);
        orbPulse.setDepth(depthForGroundEffect(towerGX, towerGY) + 2);
        this.tweens.add({ targets: orbPulse, scale: 1.5, alpha: 0, duration: 150, onComplete: () => orbPulse.destroy() });

        const chainCount = 3;
        const chainRadius = 3;
        let currentTargets: (Troop | null)[] = [troop];

        // Find chain targets
        for (let i = 1; i < chainCount; i++) {
            const prev = currentTargets[i - 1];
            if (!prev) { currentTargets.push(null); continue; }
            const next = this.troops.find(t =>
                t.owner !== tesla.owner && t.health > 0 && !currentTargets.includes(t) &&
                Phaser.Math.Distance.Between(prev.gridX, prev.gridY, t.gridX, t.gridY) < chainRadius
            );
            currentTargets.push(next || null);
        }

        // Crackling lightning: draw 4 successive bolts over ~200ms
        const boltCount = 4;
        const boltInterval = 50;
        const validTargets = currentTargets.filter(t => t !== null) as Troop[];

        for (let bolt = 0; bolt < boltCount; bolt++) {
            const isFinalBolt = bolt === boltCount - 1;
            let boltLastTarget = { ...start };

            validTargets.forEach((t, idx) => {
                const end = IsoUtils.cartToIso(t.gridX, t.gridY);

                // Draw multiple lightning layers for thickness effect. Each
                // chain segment sorts at the FORWARD end of its span in the
                // projectile band (small -layer offsets keep the core on top).
                const segDepth = Math.max(
                    depthForProjectile(towerGX, towerGY),
                    depthForProjectile(t.gridX, t.gridY)
                );
                for (let layer = 0; layer < 3; layer++) {
                    const lightning = this.trackBattleFx(this.add.graphics());
                    const alpha = layer === 0 ? 1 : (layer === 1 ? 0.6 : 0.3);
                    const width = layer === 0 ? 3 : (layer === 1 ? 5 : 8);
                    const color = layer === 0 ? 0xffffff : (layer === 1 ? 0x88eeff : 0x00ccff);

                    const thick = Math.max(1, Math.round(width / 1.35));
                    lightning.setDepth(segDepth - layer);

                    // Only the FIRST bolt is visible from frame 0 — later
                    // "successive" bolts stay dark until their 50ms slot, so
                    // the crackle actually crackles instead of stacking all
                    // four at once. (A cancelled reveal just leaves the bolt
                    // invisible until the battle-FX sweep destroys it.)
                    if (bolt > 0) {
                        lightning.setAlpha(0);
                        this.scheduleBattleCall(bolt * boltInterval, () => {
                            if (lightning.active) lightning.setAlpha(1);
                        });
                    }

                    // Jagged branching path with unique random jitter per bolt
                    let prevX = boltLastTarget.x;
                    let prevY = boltLastTarget.y;

                    const segments = 6;
                    const jitter = layer === 0 ? 8 : 12;
                    for (let j = 1; j < segments; j++) {
                        const progress = j / segments;
                        const tx = boltLastTarget.x + (end.x - boltLastTarget.x) * progress;
                        const ty = boltLastTarget.y + (end.y - boltLastTarget.y) * progress;
                        const nx = tx + (Math.random() - 0.5) * jitter;
                        const ny = ty + (Math.random() - 0.5) * jitter;
                        pixelLine(lightning, prevX, prevY, nx, ny, thick, color, alpha);
                        prevX = nx;
                        prevY = ny;
                    }
                    pixelLine(lightning, prevX, prevY, end.x, end.y, thick, color, alpha);

                    if (isFinalBolt) {
                        // Final bolt fades out normally. Explicit from:1 —
                        // the bolt was created dark for its stagger slot and
                        // the reveal timer can race this tween's start.
                        this.tweens.add({
                            targets: lightning,
                            alpha: { from: 1, to: 0 },
                            duration: 150 + layer * 50,
                            delay: bolt * boltInterval + idx * 40,
                            onComplete: () => lightning.destroy()
                        });
                    } else {
                        // Non-final bolts die as the next bolt strikes. This is
                        // a TWEEN, not a scheduleBattleCall: cancelBattleAsyncWork
                        // removes battle timers WITHOUT firing them, which used
                        // to strand up to 9 bolts forever on a fast exit. The
                        // tween is killed by the battle-FX sweep, which also
                        // destroys the registered bolt graphic itself.
                        this.tweens.add({
                            targets: lightning,
                            alpha: 0,
                            duration: 20,
                            delay: bolt * boltInterval + boltInterval - 20,
                            onComplete: () => lightning.destroy()
                        });
                    }
                }

                boltLastTarget = { x: end.x, y: end.y };
            });
        }

        // Impact effects on final bolt timing
        validTargets.forEach((t, idx) => {
            const end = IsoUtils.cartToIso(t.gridX, t.gridY);
            const impactDelay = (boltCount - 1) * boltInterval;
            const impactFxDepth = depthForGroundEffect(t.gridX, t.gridY);

            // Electric spark particles at impact
            for (let s = 0; s < 4; s++) {
                const spark = this.trackBattleFx(this.add.graphics());
                const sparkLen = 5 + Math.random() * 10;
                const sparkAngle = Math.random() * Math.PI * 2;
                pixelLine(spark,
                    end.x, end.y,
                    end.x + Math.cos(sparkAngle) * sparkLen,
                    end.y + Math.sin(sparkAngle) * sparkLen,
                    1, 0x88eeff, 0.8
                );
                spark.setDepth(impactFxDepth + 1);
                this.tweens.add({
                    targets: spark,
                    alpha: 0,
                    duration: 100 + Math.random() * 100,
                    delay: impactDelay + idx * 40,
                    onComplete: () => spark.destroy()
                });
            }

            // Glow at impact point
            this.trackBattleFx(PixelFx.flash(this, end.x, end.y, {
                r: 8, color: 0x00ccff, alpha: 0.5, scaleTo: 2,
                life: 200, delay: impactDelay + idx * 40, depth: impactFxDepth
            }));

            // Damage lands WITH the visible final-bolt impact (150ms + chain
            // step), not at cast time — the health bar used to drop before
            // any bolt had visibly arrived. (Use stats.damage, not 25.)
            const chainDamage = stats.damage! / (idx + 1);
            this.scheduleBattleCall(impactDelay + idx * 40, () => {
                if (t.health > 0) this.applyLocalTroopDamage(t, chainDamage);
            });
        });
    }

    // === PRISM TOWER - CONTINUOUS CRAZY LASER BEAM ===
    private shootPrismContinuousLaser(prism: PlacedBuilding, target: Troop, time: number) {
        const info = BUILDINGS['prism'];
        const stats = this.getDefenseStats(prism);
        const tickInterval = Math.max(25, stats.fireRate ?? 100);
        const prismDps = stats.damage ?? 0;
        const start = IsoUtils.cartToIso(prism.gridX + info.width / 2, prism.gridY + info.height / 2);
        start.y -= 55; // From the crystal tip
        const end = IsoUtils.cartToIso(target.gridX, target.gridY);

        // Rainbow cycling color
        const hue = (time / 10) % 360;
        const beamColor = Phaser.Display.Color.HSLToColor(hue / 360, 1, 0.5).color;
        const glowColor = Phaser.Display.Color.HSLToColor(hue / 360, 1, 0.7).color;

        // World-sorted beam depth via DepthSystem (refreshed every redraw —
        // the target moves): the beam rides the projectile band at the
        // FORWARD end of its span; the old fixed 10000s floated it over rows
        // in front of the fight.
        const prismCenterGX = prism.gridX + info.width / 2;
        const prismCenterGY = prism.gridY + info.height / 2;
        const beamDepth = Math.max(
            depthForProjectile(prismCenterGX, prismCenterGY),
            depthForProjectile(target.gridX, target.gridY)
        );

        // Create or update the laser graphics
        if (!prism.prismLaserGraphics) {
            prism.prismLaserGraphics = this.add.graphics();
        }
        if (!prism.prismLaserCore) {
            prism.prismLaserCore = this.add.graphics();
        }
        prism.prismLaserGraphics.setDepth(beamDepth);
        prism.prismLaserCore.setDepth(beamDepth + 1);

        // Clear and redraw laser every frame
        prism.prismLaserGraphics.clear();
        prism.prismLaserCore.clear();

        // Outer glow beam
        pixelLine(prism.prismLaserGraphics, start.x, start.y, end.x, end.y, 3, glowColor, 0.3);

        // Main beam with multiple layers for intense effect
        pixelLine(prism.prismLaserGraphics, start.x, start.y, end.x, end.y, 2, beamColor, 0.9);

        // Inner bright core
        pixelLine(prism.prismLaserCore, start.x, start.y, end.x, end.y, 1, 0xffffff, 1);


        // Crazy sparkle particles along beam
        const angle = Math.atan2(end.y - start.y, end.x - start.x);

        // Spawn particles every few frames
        if (time % 50 < 20) {
            for (let i = 0; i < 3; i++) {
                const t = Math.random();
                const px = start.x + (end.x - start.x) * t + (Math.random() - 0.5) * 15;
                const py = start.y + (end.y - start.y) * t + (Math.random() - 0.5) * 10;

                const particle = this.trackBattleFx(this.add.graphics());
                const particleColor = Phaser.Display.Color.HSLToColor(((hue + Math.random() * 60) % 360) / 360, 1, 0.5).color;
                const particleR = 2 + Math.random() * 3;
                pixelEllipse(particle, 0, 0, particleR, particleR, particleColor, 1);
                particle.setPosition(px, py);
                particle.setDepth(beamDepth + 2);

                // Particles fly outward
                const perpAngle = angle + Math.PI / 2 * (Math.random() > 0.5 ? 1 : -1);
                this.tweens.add({
                    targets: particle,
                    x: px + Math.cos(perpAngle) * (20 + Math.random() * 20),
                    y: py + Math.sin(perpAngle) * (10 + Math.random() * 10),
                    alpha: 0,
                    scale: 0.2,
                    duration: 200 + Math.random() * 150,
                    ease: 'Quad.easeOut',
                    onComplete: () => particle.destroy()
                });
            }
        }

        // SCORCH MARKS / CHASM TRAIL (Jagged Pen-like Trail)
        // Reset trail if target changed significantly (or initialization)
        if (!prism.prismTrailLastPos) {
            prism.prismTrailLastPos = {
                x: end.x + (Math.random() - 0.5) * 10,
                y: end.y + (Math.random() - 0.5) * 10
            };
        } else if (prism.prismTarget !== target && prism.prismTarget?.id !== target.id) {
            // Target switched, reset pos
            prism.prismTrailLastPos = {
                x: end.x + (Math.random() - 0.5) * 10,
                y: end.y + (Math.random() - 0.5) * 10
            };
        }

        // Calculate Jagged Current Target for the segment end
        const jaggedEndX = end.x + (Math.random() - 0.5) * 6;
        const jaggedEndY = end.y + (Math.random() - 0.5) * 6;

        const distLast = Phaser.Math.Distance.Between(prism.prismTrailLastPos.x, prism.prismTrailLastPos.y, jaggedEndX, jaggedEndY);

        if (distLast > 2) {
            // MOVING: Draw connected segment
            const scorch = this.trackBattleFx(this.add.graphics());

            // Thick, dark charcoal
            pixelLine(scorch, prism.prismTrailLastPos.x, prism.prismTrailLastPos.y, jaggedEndX, jaggedEndY, 4, 0x0a0505, 0.7);
            scorch.setDepth(5);

            // Persist for a while, then fade out slowly
            this.tweens.add({
                targets: scorch,
                alpha: 0,
                duration: 4000,
                ease: 'Quad.easeIn',
                onComplete: () => scorch.destroy()
            });

            // Update last pos to the JAGGED point to ensure exact continuity
            prism.prismTrailLastPos = { x: jaggedEndX, y: jaggedEndY };

        } else if (time % 200 < 20) {
            // STATIONARY: Random scratch around target (static)
            const scratch = this.trackBattleFx(this.add.graphics());

            const sx = end.x + (Math.random() - 0.5) * 15;
            const sy = end.y + (Math.random() - 0.5) * 15;
            pixelLine(scratch, sx, sy, sx + (Math.random() - 0.5) * 12, sy + (Math.random() - 0.5) * 8, 3, 0x0a0505, 0.6);

            scratch.setDepth(5);

            this.tweens.add({
                targets: scratch,
                alpha: 0,
                duration: 2500,
                onComplete: () => scratch.destroy()
            });
        }

        // Impact sparkles at target — ground-effect band at the impact tile.
        const impactGlow = this.trackBattleFx(this.add.graphics());
        const impactGlowR = 12 + Math.sin(time / 25) * 5;
        pixelEllipse(impactGlow, end.x, end.y, impactGlowR, impactGlowR, beamColor, 0.6);
        impactGlow.setDepth(depthForGroundEffect(target.gridX, target.gridY) + 1);
        this.tweens.add({
            targets: impactGlow,
            alpha: 0,
            duration: 60,
            onComplete: () => impactGlow.destroy()
        });

        // Crystal charging glow — rides just above the beam at the tower.
        const crystalGlow = this.trackBattleFx(this.add.graphics());
        pixelEllipse(crystalGlow, start.x, start.y, 10, 10, 0xffffff, 0.4 + Math.sin(time / 15) * 0.3);
        crystalGlow.setDepth(depthForProjectile(prismCenterGX, prismCenterGY) + 2);
        this.tweens.add({
            targets: crystalGlow,
            alpha: 0,
            duration: 50,
            onComplete: () => crystalGlow.destroy()
        });

        const shouldApplyDamage = prism.prismLastDamageTime === undefined || time >= prism.prismLastDamageTime + tickInterval;
        if (prismDps > 0 && shouldApplyDamage) {
            prism.prismLastDamageTime = time;
            const damagePerTick = prismDps * (tickInterval / 1000);
            if (this.applyLocalTroopDamage(target, damagePerTick) && target.health <= 0) {
                this.cleanupPrismLaser(prism);
            }
        }

        prism.prismTarget = target;
    }

    // Clean up prism laser graphics when no target
    public cleanupPrismLaser(prism: PlacedBuilding) {
        if (prism.prismLaserGraphics) {
            prism.prismLaserGraphics.destroy();
            prism.prismLaserGraphics = undefined;
        }
        if (prism.prismLaserCore) {
            prism.prismLaserCore.destroy();
            prism.prismLaserCore = undefined;
        }
        prism.prismTarget = undefined;
        prism.prismTrailLastPos = undefined;
        prism.prismLastDamageTime = undefined;
    }

    // The dispatch passes the fire `time`, but every timestamp inside this
    // effect must anchor on the clock at IMPACT (~4.8s later) — see the
    // impactTime notes below — so the fire time is deliberately unused.
    private shootFrostfallShard(frostfall: PlacedBuilding, _time: number): boolean {
        const info = BUILDINGS['frostfall'];
        const stats = this.getDefenseStats(frostfall);
        const damage = stats.damage || 15;
        const range = stats.range || 6.0;

        // NOTE: Cooldown is handled by updateCombat loop. Do NOT add a cooldown check here.

        const centerX = frostfall.gridX + info.width / 2;
        const centerY = frostfall.gridY + info.height / 2;

        // Find the closest enemy troop in range
        let bestTarget: Troop | null = null;
        let bestDist = Infinity;

        this.troops.forEach(troop => {
            if (troop.health <= 0 || troop.owner === frostfall.owner) return;
            const dist = Phaser.Math.Distance.Between(centerX, centerY, troop.gridX, troop.gridY);
            if (dist <= range && dist < bestDist) {
                bestDist = dist;
                bestTarget = troop;
            }
        });

        // Nothing in the monolith's own range: refuse the shot so the
        // cooldown is not consumed (DefenseSystem honors a false return).
        if (!bestTarget) return false;

        // Signal the renderer to start the trapdoor + crystal rise animation
        frostfall.isFiring = true;
        frostfall.frostfallProjectileActive = false; // Crystal is rising, not launched yet

        const level = frostfall.level ?? 1;
        const crystalHeight = level >= 3 ? 45 : (level === 2 ? 40 : 35);
        const crystalWidth = level >= 3 ? 22 : (level === 2 ? 20 : 18);
        const baseHeight = 10;

        // Wait for the crystal to swing forward (renderer timeline: 4200ms after lastFireTime)
        this.scheduleBattleCall(4200, () => {
            // The crystal is now fully risen — LAUNCH it as the projectile!
            frostfall.frostfallProjectileActive = true; // Tell renderer to hide its crystal

            // Re-check target position
            let targetX: number;
            let targetY: number;
            if (bestTarget && bestTarget.health > 0) {
                targetX = bestTarget.gridX;
                targetY = bestTarget.gridY;
            } else {
                // Target died while rising; find a new one
                let fallback: Troop | null = null;
                let fallbackDist = Infinity;
                this.troops.forEach(t => {
                    if (t.health <= 0 || t.owner === frostfall.owner) return;
                    const d = Phaser.Math.Distance.Between(centerX, centerY, t.gridX, t.gridY);
                    if (d <= range && d < fallbackDist) {
                        fallbackDist = d;
                        fallback = t;
                    }
                });
                if (!fallback) {
                    frostfall.frostfallProjectileActive = false;
                    // Fire animation is over with nothing launched — without
                    // this the 20fps stagger redraw stays defeated forever.
                    frostfall.isFiring = false;
                    return; // No targets
                }
                // TS cannot see the assignment inside the forEach closure, so it
                // narrows `fallback` to never here without the explicit type.
                targetX = (fallback as Troop).gridX;
                targetY = (fallback as Troop).gridY;
            }

            const start = IsoUtils.cartToIso(centerX, centerY);
            const end = IsoUtils.cartToIso(targetX, targetY);

            // Create the projectile — smaller, matching renderer crystal size
            // (shape + level sizing live in ProjectileRenderer).
            const shard = this.trackBattleFx(this.add.graphics());

            // Start from the crystal's position near the top beam.
            // Painter's-order depth along the ground track (per-frame below).
            const startY = start.y - baseHeight;
            shard.setPosition(start.x, startY);
            shard.setDepth(depthForProjectile(centerX, centerY));
            const shardBaked = this.syncProjectileSprite(shard, 'frostfall_shard', Math.min(level, 3), 0);
            if (!shardBaked) ProjectileRenderer.drawFrostfallShard(shard, level);

            const travelTime = 600;

            // Dynamic arc based on distance
            const distPixels = Phaser.Math.Distance.Between(start.x, startY, end.x, end.y);
            const arcHeight = Math.min(200, distPixels * 0.5 + 60);
            const midY = (startY + end.y) / 2 - arcHeight;

            this.tweens.add({
                targets: shard,
                x: end.x,
                duration: travelTime,
                ease: 'Sine.easeIn',
                onUpdate: (tween) => {
                    const t = tween.progress;
                    // Quadratic Bezier arc
                    shard.y = (1 - t) * (1 - t) * startY + 2 * (1 - t) * t * midY + t * t * end.y;
                    // Rotate as it flies — tip forward
                    shard.setRotation(t * Math.PI * 0.4);
                    // Keep scale consistent (no growth)
                    shard.setScale(1.0);
                    shard.setDepth(depthForProjectile(
                        centerX + (targetX - centerX) * t,
                        centerY + (targetY - centerY) * t));
                    if (shardBaked) this.syncProjectileSprite(shard, 'frostfall_shard', Math.min(level, 3), t * Math.PI * 0.4);
                },
                onComplete: () => {
                    shard.destroy();
                    frostfall.frostfallProjectileActive = false; // New crystal can rise on next cycle
                    // The fire-animation window (rise + swing + flight) ends
                    // here. Only cannon used to reset isFiring; frostfall left
                    // it stuck true, forcing a full redraw every frame for the
                    // rest of the battle.
                    frostfall.isFiring = false;

                    // === IMPACT: a real cold snap ===
                    this.cameras.main.shake(130, 0.0022);

                    // Pale flash of the freeze.
                    const iceFlash = this.trackBattleFx(this.add.graphics());
                    iceFlash.setBlendMode(Phaser.BlendModes.ADD);
                    pixelEllipse(iceFlash, 0, 0, 15, 7.5, 0xdcf2ff, 0.85);
                    iceFlash.setPosition(end.x, end.y);
                    iceFlash.setDepth(depthForGroundEffect(targetX, targetY) + 1);
                    this.tweens.add({ targets: iceFlash, alpha: 0, scale: 2.1, duration: 130, onComplete: () => iceFlash.destroy() });

                    // Frost rime rushes across the ground to the exact edge of
                    // the slow zone — the debuff painted where it applies.
                    // STEPPED REDRAW while it rushes out (never a scale tween:
                    // the cells must stay 1.35px at every radius).
                    const rime = this.trackBattleFx(this.add.graphics());
                    const rimeR = 2.5 * 32; // AoE radius in iso px (half-width)
                    const drawRime = (p: number) => {
                        rime.clear();
                        const r = rimeR * (0.2 + 0.8 * p);
                        this.pixelRing(rime, 0, 0, r, r / 2, 1, 0xcfeaff, 0.75);
                        pixelEllipse(rime, 0, 0, r, r / 2, 0xdcf2ff, 0.16);
                        // Rime crystals sparkling inside the ring.
                        for (let i = 0; i < 14; i++) {
                            const a = (i / 14) * Math.PI * 2 + 0.4;
                            const rr = r * (0.35 + ((i * 37) % 10) / 16);
                            pixelBitmap(rime,
                                Math.cos(a) * rr - 1.5 * PIXEL_CELL, Math.sin(a) * rr * 0.5 - 2,
                                ['.f.', 'fff'], { f: 0xffffff }, 0.55);
                        }
                    };
                    drawRime(0);
                    rime.setPosition(end.x, end.y);
                    rime.setDepth(7);
                    rime.setAlpha(0.9);
                    const rimeRush = { p: 0 };
                    this.trackBattleFxTween(this.tweens.add({
                        targets: rimeRush, p: 1, duration: 240, ease: 'Cubic.easeOut',
                        onUpdate: () => { if (rime.active) drawRime(rimeRush.p); }
                    }));
                    this.tweens.add({ targets: rime, alpha: 0, delay: 2600, duration: 1600, onComplete: () => rime.destroy() });

                    // The EMBEDDED crystal, stuck tip-up in the ground —
                    // scanline-rasterized in whole cells (body, shaded left
                    // facet, crown light), no AA fill paths on the live layer.
                    const embedded = this.trackBattleFx(this.add.graphics());
                    const embedHeight = crystalHeight;
                    const embedWidth = crystalWidth;
                    // Half-width of the rhombus at local yy: 0 at the tip
                    // (-0.8H), widest at the shoulder (-0.3H), 0 at +0.1H.
                    const crystalHalfW = (yy: number): number => {
                        if (yy <= -embedHeight * 0.3) {
                            return embedWidth * 0.5 * (yy + embedHeight * 0.8) / (embedHeight * 0.5);
                        }
                        return embedWidth * 0.5 * (embedHeight * 0.1 - yy) / (embedHeight * 0.4);
                    };
                    for (let yy = -embedHeight * 0.8; yy < embedHeight * 0.1; yy += PIXEL_CELL) {
                        const hw = Math.max(0, crystalHalfW(yy + PIXEL_CELL / 2));
                        if (hw < 0.3) continue;
                        pixelRect(embedded, -hw, yy, hw * 2, PIXEL_CELL, 0xaaddff, 0.92);
                        // Left interior facet, in shadow.
                        pixelRect(embedded, -hw, yy, hw, PIXEL_CELL, 0x77bbee, 0.5);
                        // Crown light on the upper-right facet.
                        if (yy > -embedHeight * 0.75 && yy < -embedHeight * 0.5) {
                            pixelRect(embedded, hw * 0.25, yy, hw * 0.75, PIXEL_CELL, 0xcceeff, 0.4);
                        }
                    }
                    pixelLine(embedded, 0, -embedHeight * 0.8, embedWidth * 0.5, -embedHeight * 0.3, 1, 0x5599cc, 0.6);
                    pixelLine(embedded, embedWidth * 0.5, -embedHeight * 0.3, 0, embedHeight * 0.1, 1, 0x5599cc, 0.6);
                    pixelLine(embedded, 0, embedHeight * 0.1, -embedWidth * 0.5, -embedHeight * 0.3, 1, 0x5599cc, 0.6);
                    pixelLine(embedded, -embedWidth * 0.5, -embedHeight * 0.3, 0, -embedHeight * 0.8, 1, 0x5599cc, 0.6);
                    // Painter's order at its own tile — the crystal stands IN
                    // the world (in front of walls behind it, behind troops
                    // that walk past), instead of hiding under everything.
                    const crystalDepth = depthForProjectile(targetX, targetY);
                    embedded.setDepth(crystalDepth);
                    // It EMBEDS: arrives above the dirt and rams itself in —
                    // a hard drop, a squash, and a ring of broken earth.
                    embedded.setPosition(end.x, end.y - 9);
                    embedded.setRotation(0.12);
                    this.tweens.add({
                        targets: embedded,
                        y: end.y + 3,
                        duration: 90,
                        ease: 'Quad.easeIn',
                        onComplete: () => {
                            // Broken soil heaped around the shaft.
                            const mound = this.trackBattleFx(this.add.graphics());
                            pixelEllipse(mound, 0, 0, 8, 3, 0x5c4c34, 0.8);
                            pixelEllipse(mound, -4, -1, 3, 1.3, 0x6e5c3e, 0.9);
                            pixelEllipse(mound, 5, 0.5, 2.5, 1.1, 0x6e5c3e, 0.9);
                            mound.setPosition(end.x, end.y + 3);
                            mound.setDepth(crystalDepth - 1);
                            this.tweens.add({ targets: mound, alpha: 0, delay: 6200, duration: 1200, onComplete: () => mound.destroy() });
                            for (let d = 0; d < 4; d++) {
                                const clod = this.trackBattleFx(this.add.graphics());
                                pixelEllipse(clod, 0, 0, 1.5, 1, 0x6e5c3e, 0.95);
                                clod.setPosition(end.x, end.y + 1);
                                clod.setDepth(crystalDepth + 1);
                                const ca = Math.random() * Math.PI * 2;
                                this.tweens.add({
                                    targets: clod,
                                    x: end.x + Math.cos(ca) * (8 + Math.random() * 10),
                                    y: end.y + Math.sin(ca) * 5 + 2,
                                    alpha: 0,
                                    duration: 260 + Math.random() * 140,
                                    ease: 'Quad.easeOut',
                                    onComplete: () => clod.destroy()
                                });
                            }
                        }
                    });

                    // The MELT: one clock drives everything, so the crystal
                    // visibly BECOMES the puddle — as it slumps, the water
                    // spreads by exactly that much, streaks run down its
                    // faces, drips fall from the tip, and at the end it
                    // collapses with a splash and the puddle dries.
                    const puddle = this.trackBattleFx(this.add.graphics());
                    pixelEllipse(puddle, 0, 2, 22, 10, 0x6fb4e8, 0.42);
                    pixelEllipse(puddle, -3, 1, 13, 5.5, 0xa8d8f8, 0.35);
                    pixelEllipse(puddle, -7, -1, 3.5, 1.5, 0xe8f6ff, 0.5);
                    puddle.setPosition(end.x, end.y + 2);
                    puddle.setDepth(6);
                    puddle.setScale(0.1);
                    puddle.setAlpha(0);

                    const meltFx = this.trackBattleFx(this.add.graphics());
                    meltFx.setPosition(end.x, end.y);
                    meltFx.setDepth(crystalDepth + 1);

                    const melt = { t: 0 };
                    let lastDripAt = 0;
                    // Tracked: this progress tween spawns drip graphics from
                    // onUpdate — left running after a scene swap it would keep
                    // sprinkling meltwater over the home lawn for 6.5s.
                    this.trackBattleFxTween(this.tweens.add({
                        targets: melt,
                        t: 1,
                        duration: 6500,
                        ease: 'Sine.easeIn',
                        onUpdate: () => {
                            const t = melt.t;
                            // Crystal slumps: shorter, wider, leaning as it goes.
                            embedded.setScale(1 + t * 0.4, Math.max(0.02, 1 - t * 0.98));
                            embedded.setRotation(0.12 + t * 0.14);
                            embedded.setAlpha(t < 0.8 ? 0.95 : 0.95 * (1 - (t - 0.8) / 0.22));
                            // The puddle grows by exactly what the crystal loses.
                            puddle.setAlpha(Math.min(1, t * 1.6));
                            puddle.setScale(0.25 + t * 1.05);
                            // Meltwater: a sheen line sliding down the faces +
                            // streaks running off the tip.
                            meltFx.clear();
                            if (t < 0.94) {
                                const topY = -embedHeight * 0.8 * (1 - t * 0.98);
                                pixelLine(meltFx, -embedWidth * 0.4 * (1 + t * 0.4), topY * 0.45, embedWidth * 0.4 * (1 + t * 0.4), topY * 0.55, 1, 0xe8f6ff, 0.7 * (1 - t * 0.5));
                                for (let s = 0; s < 3; s++) {
                                    const run = ((t * 3.2 + s * 0.37) % 1);
                                    const sx = (s - 1) * embedWidth * 0.24 * (1 + t * 0.4);
                                    pixelLine(meltFx, sx, topY * (1 - run * 0.8), sx + 0.8, topY * (1 - run * 0.8) + 4.5, 1, 0xbfe4ff, 0.65 * (1 - run));
                                }
                            }
                            // Drips off the tip, steady as a thaw.
                            const now = this.time.now;
                            if (now - lastDripAt > 420 && melt.t > 0.08 && melt.t < 0.92) {
                                lastDripAt = now;
                                const drip = this.trackBattleFx(this.add.graphics());
                                pixelEllipse(drip, 0, 0, 1, 1.5, 0xbfe4ff, 0.85);
                                const tipY = end.y - embedHeight * 0.8 * (1 - melt.t * 0.98);
                                drip.setPosition(end.x + (Math.random() - 0.5) * embedWidth * 0.5, tipY);
                                drip.setDepth(crystalDepth + 2);
                                this.tweens.add({
                                    targets: drip,
                                    y: end.y + 2,
                                    alpha: 0.2,
                                    duration: 300,
                                    ease: 'Quad.easeIn',
                                    onComplete: () => {
                                        // A tiny ripple where it lands.
                                        drip.clear();
                                        this.pixelRing(drip, 0, 0, 2, 1, 1, 0xd8eeff, 0.5);
                                        this.tweens.add({ targets: drip, alpha: 0, scale: 2, duration: 260, onComplete: () => drip.destroy() });
                                    }
                                });
                            }
                        },
                        onComplete: () => {
                            // The last of it collapses — one soft splash ring.
                            meltFx.destroy();
                            embedded.destroy();
                            const splash = this.trackBattleFx(this.add.graphics());
                            this.pixelRing(splash, 0, 0, 6, 3, 1, 0xd8eeff, 0.7);
                            splash.setPosition(end.x, end.y + 2);
                            splash.setDepth(crystalDepth + 1);
                            this.tweens.add({ targets: splash, alpha: 0, scale: 2.4, duration: 320, onComplete: () => splash.destroy() });
                            this.tweens.add({ targets: puddle, scaleX: puddle.scaleX + 0.15, scaleY: puddle.scaleY + 0.15, duration: 300, ease: 'Quad.easeOut' });
                            // ...and the sun takes the puddle back.
                            this.tweens.add({ targets: puddle, alpha: 0, delay: 1500, duration: 2800, ease: 'Quad.easeIn', onComplete: () => puddle.destroy() });
                        }
                    }));

                    // === ICE SHATTER FRAGMENTS on impact ===
                    // Chunky cell diamonds (two sizes) — no AA fill paths.
                    for (let i = 0; i < 12; i++) {
                        const frag = this.trackBattleFx(this.add.graphics());
                        const fragColor = i % 3 === 0 ? 0xdcf2ff : (i % 3 === 1 ? 0xaaddff : 0x88ccff);
                        if (Math.random() > 0.45) {
                            pixelBitmap(frag, -2.5 * PIXEL_CELL, -2.5 * PIXEL_CELL,
                                ['..f..', '.fff.', 'fffff', '.fff.', '..f..'], { f: fragColor }, 0.95);
                        } else {
                            pixelBitmap(frag, -1.5 * PIXEL_CELL, -1.5 * PIXEL_CELL,
                                ['.f.', 'fff', '.f.'], { f: fragColor }, 0.95);
                        }
                        frag.setPosition(end.x, end.y - embedHeight * 0.3);
                        frag.setDepth(10001);
                        const fragAngle = (i / 12) * Math.PI * 2;
                        const fragDist = 15 + Math.random() * 46;
                        this.tweens.add({
                            targets: frag,
                            x: end.x + Math.cos(fragAngle) * fragDist,
                            y: end.y + Math.sin(fragAngle) * fragDist * 0.5 - 10 - Math.random() * 15,
                            alpha: 0,
                            rotation: Math.random() * Math.PI,
                            duration: 300 + Math.random() * 300,
                            ease: 'Quad.easeOut',
                            onComplete: () => frag.destroy()
                        });
                    }

                    // === APPLY AOE DAMAGE AND DEBUFF ===
                    // Impact happens ~4.8s after the captured fire `time`
                    // (4200ms crystal rise + 600ms flight). The knockback and
                    // pause windows must anchor on the clock NOW — stamped on
                    // the stale fire time they are born expired and the
                    // impulse never integrates (updateTroops gates the shove
                    // on `now < knockbackUntil`).
                    const impactTime = this.time.now;
                    this.troops.forEach(troop => {
                        if (troop.health <= 0 || troop.owner === frostfall.owner) return;

                        const dx = troop.gridX - targetX;
                        const dy = troop.gridY - targetY;
                        const distToImpact = Math.sqrt(dx * dx + dy * dy);

                        if (distToImpact <= 2.5) {
                            // Hit flash on troop
                            const troopPos = IsoUtils.cartToIso(troop.gridX, troop.gridY);
                            particleManager.emitHitFlash(troopPos.x, troopPos.y, 10006);

                            if (this.applyLocalTroopDamage(troop, damage)) {
                                (troop as any).chillRemainingMs = 4000; // Massive Slow

                                // Physical Pushback & Stun: a per-frame
                                // impulse (grid units/frame) integrated by
                                // the knockback window in updateTroops via
                                // the collision resolver — total shove ≈ 1
                                // tile as the pause branch decays it.
                                if (distToImpact > 0.1) {
                                    troop.velocityX = (troop.velocityX ?? 0) + (dx / distToImpact) * 0.45;
                                    troop.velocityY = (troop.velocityY ?? 0) + (dy / distToImpact) * 0.45;
                                    troop.knockbackUntil = impactTime + 450;
                                    troop.retargetPauseUntil = impactTime + 600;
                                }
                            }
                        }
                    });

                    // Emit frost burst particles — stamped with the IMPACT
                    // clock, not the ~4.8s-stale fire `time` (a stale stamp
                    // makes the tracker's lifetime math treat them as long
                    // expired).
                    if (particleManager) {
                        for (let i = 0; i < 30; i++) {
                            const angle = Math.random() * Math.PI * 2;
                            const r = Math.random() * 80;
                            particleManager.emitSparkTracker(
                                `${frostfall.id}:chill-burst:${i}`,
                                end.x + Math.cos(angle) * r,
                                end.y + Math.sin(angle) * r * 0.5 - 10,
                                impactTime,
                                depthForGroundEffect(targetX, targetY)
                            );
                        }
                    }
                }
            });
        });
        return true;
    }

    private showArcherProjectile(troop: Troop, target: PlacedBuilding, damage: number) {
        const start = IsoUtils.cartToIso(troop.gridX, troop.gridY);
        const info = BUILDINGS[target.type];
        const end = IsoUtils.cartToIso(target.gridX + info.width / 2, target.gridY + info.height / 2);
        const angle = Math.atan2(end.y - start.y, end.x - start.x);

        const targetBuilding = target;

        troop.facingAngle = angle;
        this.redrawTroop(troop);

        // Bow kickback animation - quick squish effect without moving the troop
        this.tweens.add({
            targets: troop.gameObject,
            scaleX: 0.85,
            scaleY: 1.1,
            duration: 40,
            yoyo: true,
            ease: 'Power2'
        });


        // Arrow drawn identical to the nocked arrow in TroopRenderer (small,
        // villager-scale) so the loosed shaft is the one we saw on the string.
        const arrow = this.trackBattleFx(this.add.graphics());

        // Painter's-order depth along the shot's ground track.
        const launchGX = troop.gridX;
        const launchGY = troop.gridY;
        const shotTargetGX = target.gridX + info.width / 2;
        const shotTargetGY = target.gridY + info.height / 2;

        // Leave from the bow itself (arm's reach toward the aim, chest high).
        arrow.setPosition(start.x + Math.cos(angle) * 5.2, start.y - 4 + Math.sin(angle) * 2.6);
        arrow.setRotation(angle);
        arrow.setDepth(depthForProjectile(launchGX, launchGY));
        const arrowBaked = this.syncProjectileSprite(arrow, 'arrow', 1, angle);
        if (!arrowBaked) ProjectileRenderer.drawArcherArrow(arrow);

        // Straight line trajectory
        const endY = end.y - 25;

        this.tweens.add({
            targets: arrow,
            x: end.x,
            y: endY,
            duration: 200,
            ease: 'Linear',
            onUpdate: (tween) => {
                const t = tween.progress;
                arrow.setDepth(depthForProjectile(
                    launchGX + (shotTargetGX - launchGX) * t,
                    launchGY + (shotTargetGY - launchGY) * t));
                if (arrowBaked) this.syncProjectileSprite(arrow, 'arrow', 1, angle);
            },
            onComplete: () => {
                arrow.destroy();

                // Apply damage on hit
                if (targetBuilding && targetBuilding.health > 0) {
                    targetBuilding.health -= damage;
                    this.updateHealthBar(targetBuilding);

                    if (targetBuilding.health <= 0) {
                        this.destroyBuilding(targetBuilding);
                        this.troops.forEach(t => {
                            if (t.target && t.target.id === targetBuilding.id) {
                                t.target = null;
                            }
                        });
                    }
                }

                // Small impact effect
                this.trackBattleFx(PixelFx.flash(this, end.x, endY, { r: 3, color: 0x8b4513, alpha: 0.6, scaleTo: 0.5, life: 120, depth: depthForGroundEffect(shotTargetGX, shotTargetGY) }));

                // Impact sparkle
                PixelFx.burst(this, end.x, endY, {
                    count: 2, colors: [0x88ccff], alpha: 0.7, r: 1.5,
                    spread: 8, spreadY: 8, speed: 0, up: 8, life: 80,
                    depth: depthForGroundEffect(shotTargetGX, shotTargetGY) + 1
                });
            }
        });
    }

    private showMobileMortarShot(troop: Troop, target: PlacedBuilding, damage: number) {
        const stats = this.getTroopCombatStats(troop);
        const start = IsoUtils.cartToIso(troop.gridX, troop.gridY);
        const info = BUILDINGS[target.type];
        const end = IsoUtils.cartToIso(target.gridX + info.width / 2, target.gridY + info.height / 2);

        // Mortar is offset to the left of the troop position
        // Face target
        const angle = Math.atan2(end.y - start.y, end.x - start.x);
        troop.facingAngle = angle;

        // Mortar is offset relative to the troop based on facing direction
        // (matches the cart position/tube top drawn in TroopRenderer).
        const facingLeft = Math.abs(angle) > Math.PI / 2;
        const flip = facingLeft ? -1 : 1;
        const mortarX = start.x - (11 * flip);
        const mortarY = start.y - 18;

        // MORTAR RECOIL - animates only the mortar, not the soldier
        // Initialize if needed
        if (troop.mortarRecoil === undefined) {
            troop.mortarRecoil = 0;
        }

        // Animate the mortar jumping back
        this.tweens.add({
            targets: troop,
            mortarRecoil: 3, // Mortar kicks down slightly
            duration: 60,
            ease: 'Power2',
            yoyo: true,
            onUpdate: () => {
                this.redrawTroop(troop);
            },
            onComplete: () => {
                troop.mortarRecoil = 0;
                this.redrawTroop(troop);
            }
        });

        // Painter's-order depth along the shot's ground track (the two tween
        // phases below each cover half of it).
        const launchGX = troop.gridX;
        const launchGY = troop.gridY;
        const shotTargetGX = target.gridX + info.width / 2;
        const shotTargetGY = target.gridY + info.height / 2;

        // Mortar shell - spawns from the mortar position
        const shell = this.trackBattleFx(this.add.graphics());
        shell.setPosition(mortarX, mortarY);
        shell.setDepth(depthForProjectile(launchGX, launchGY));
        const shellBaked = this.syncProjectileSprite(shell, 'mm_shell', 1, 0, 1);
        if (!shellBaked) ProjectileRenderer.drawMobileMortarShell(shell);

        // Muzzle flash at mortar position
        particleManager.emitHitFlash(mortarX, mortarY, depthForGroundEffect(launchGX, launchGY));

        // THIN BLACK SMOKE - rising slowly from mortar muzzle
        for (let i = 0; i < 6; i++) {
            this.scheduleBattleCall(i * 80, () => {
                particleManager.emitDustBurst(mortarX, mortarY, depthForGroundEffect(launchGX, launchGY) + 1);
            });
        }

        // Arcing trajectory
        const midY = Math.min(start.y - 20, end.y - 25) - 80;
        const endY = end.y;

        this.tweens.add({
            targets: shell,
            x: { value: (start.x + end.x) / 2, duration: 300, ease: 'Linear' },
            y: { value: midY, duration: 300, ease: 'Quad.easeOut' },
            onUpdate: (tween) => {
                const t = tween.progress * 0.5; // first half of the ground track
                shell.setDepth(depthForProjectile(
                    launchGX + (shotTargetGX - launchGX) * t,
                    launchGY + (shotTargetGY - launchGY) * t));
                if (shellBaked) this.syncProjectileSprite(shell, 'mm_shell', 1, 0, 1);
            },
            onComplete: () => {
                this.tweens.add({
                    targets: shell,
                    x: { value: end.x, duration: 300, ease: 'Linear' },
                    y: { value: endY, duration: 300, ease: 'Quad.easeIn' },
                    onUpdate: (tween) => {
                        const t = 0.5 + tween.progress * 0.5; // second half of the track
                        shell.setDepth(depthForProjectile(
                            launchGX + (shotTargetGX - launchGX) * t,
                            launchGY + (shotTargetGY - launchGY) * t));
                        if (shellBaked) this.syncProjectileSprite(shell, 'mm_shell', 1, 0, 1);
                    },
                    onComplete: () => {
                        shell.destroy();

                        // Explosion effect
                        this.cameras.main.shake(25, 0.001);
                        particleManager.emitExplosion(end.x, endY, depthForGroundEffect(shotTargetGX, shotTargetGY));

                        // Splash damage to all buildings in radius
                        const targetInfo = BUILDINGS[target.type];
                        const tCenterX = target.gridX + targetInfo.width / 2;
                        const tCenterY = target.gridY + targetInfo.height / 2;
                        const sRadius = stats.splashRadius || 2;

                        [...this.buildings].forEach(b => {
                            if (b.owner !== troop.owner && b.health > 0) {
                                const bInfo = BUILDINGS[b.type];
                                const bCenterX = b.gridX + bInfo.width / 2;
                                const bCenterY = b.gridY + bInfo.height / 2;
                                const bdx = bCenterX - tCenterX;
                                const bdy = bCenterY - tCenterY;
                                const bdist = Math.sqrt(bdx * bdx + bdy * bdy);

                                if (bdist <= sRadius) {
                                    // Full damage at center, half at edge
                                    const splashDamage = bdist < 0.5 ? damage : damage * 0.6;
                                    b.health -= splashDamage;
                                    this.updateHealthBar(b);
                                    if (b.health <= 0) {
                                        this.destroyBuilding(b);
                                    }
                                }
                            }
                        });
                    }
                });
            }
        });
    }

    /**
     * TREBUCHET — r11 artillery on the mobile-mortar pattern: two chained
     * tweens (up: Quad.easeOut / down: Quad.easeIn) with the projectile depth
     * lerped along the GRID ground track, a much higher apex, a tumbling
     * baked boulder (nearest of 16 baked rotations, never setRotation), and
     * splash measured to FOOTPRINT EDGES on impact (wallbreaker precedent).
     */
    private showTrebuchetShot(troop: Troop, target: PlacedBuilding, damage: number) {
        const stats = this.getTroopCombatStats(troop);
        const start = IsoUtils.cartToIso(troop.gridX, troop.gridY);
        const info = BUILDINGS[target.type];
        const end = IsoUtils.cartToIso(target.gridX + info.width / 2, target.gridY + info.height / 2);

        // Face target; the arm swing itself rides attackAge in the troop art.
        troop.facingAngle = Math.atan2(end.y - start.y, end.x - start.x);
        this.redrawTroopWithMovement(troop, false);

        const launchGX = troop.gridX;
        const launchGY = troop.gridY;
        const shotTargetGX = target.gridX + info.width / 2;
        const shotTargetGY = target.gridY + info.height / 2;
        const level = Math.min(troop.level || 1, 3);

        const stone = this.trackBattleFx(this.add.graphics());
        stone.setPosition(start.x, start.y - 30); // sling release height
        stone.setDepth(depthForProjectile(launchGX, launchGY));
        const rotFor = (t: number) => t * Math.PI * 4; // tumble (mortar-shell precedent)
        const stoneBaked = this.syncProjectileSprite(stone, 'trebuchet_stone', level, 0);
        if (!stoneBaked) ProjectileRenderer.drawTrebuchetStone(stone, level);

        particleManager.emitDustBurst(start.x, start.y - 6, depthForGroundEffect(launchGX, launchGY) + 1);

        const flightMs = 900; // slow counterweight lob
        const midY = Math.min(start.y, end.y) - 200; // high apex

        this.tweens.add({
            targets: stone,
            x: { value: (start.x + end.x) / 2, duration: flightMs / 2, ease: 'Linear' },
            y: { value: midY, duration: flightMs / 2, ease: 'Quad.easeOut' },
            onUpdate: (tween) => {
                const t = tween.progress * 0.5; // first half of the ground track
                stone.setDepth(depthForProjectile(
                    launchGX + (shotTargetGX - launchGX) * t,
                    launchGY + (shotTargetGY - launchGY) * t));
                if (stoneBaked) this.syncProjectileSprite(stone, 'trebuchet_stone', level, rotFor(t));
            },
            onComplete: () => {
                this.tweens.add({
                    targets: stone,
                    x: { value: end.x, duration: flightMs / 2, ease: 'Linear' },
                    y: { value: end.y, duration: flightMs / 2, ease: 'Quad.easeIn' },
                    onUpdate: (tween) => {
                        const t = 0.5 + tween.progress * 0.5; // second half
                        stone.setDepth(depthForProjectile(
                            launchGX + (shotTargetGX - launchGX) * t,
                            launchGY + (shotTargetGY - launchGY) * t));
                        if (stoneBaked) this.syncProjectileSprite(stone, 'trebuchet_stone', level, rotFor(t));
                    },
                    onComplete: () => {
                        stone.destroy();

                        this.cameras.main.shake(45, 0.0018);
                        particleManager.emitExplosion(end.x, end.y, depthForGroundEffect(shotTargetGX, shotTargetGY));

                        // Splash to FOOTPRINT EDGES around the impact point —
                        // the center measure starves large buildings' corners.
                        const sRadius = stats.splashRadius || 2;
                        [...this.buildings].forEach(b => {
                            if (b.owner !== troop.owner && b.health > 0) {
                                const bInfo = BUILDINGS[b.type];
                                const bdx = Math.max(b.gridX - shotTargetGX, 0, shotTargetGX - (b.gridX + bInfo.width));
                                const bdy = Math.max(b.gridY - shotTargetGY, 0, shotTargetGY - (b.gridY + bInfo.height));
                                const bdist = Math.hypot(bdx, bdy);
                                if (bdist <= sRadius) {
                                    const splashDamage = bdist < 0.5 ? damage : damage * 0.6;
                                    b.health -= splashDamage;
                                    this.updateHealthBar(b);
                                    if (b.health <= 0) this.destroyBuilding(b);
                                }
                            }
                        });
                    }
                });
            }
        });
    }

    /**
     * ORNITHOPTER — lobs an iron bomb from flight height: a short mm_shell-
     * style two-phase arc with the depth lerped along the ground track, then
     * a splash on impact (center-distance, mobile-mortar model).
     */
    private showOrnithopterBomb(troop: Troop, target: PlacedBuilding, damage: number) {
        const stats = this.getTroopCombatStats(troop);
        const start = IsoUtils.cartToIso(troop.gridX, troop.gridY);
        const info = BUILDINGS[target.type];
        const end = IsoUtils.cartToIso(target.gridX + info.width / 2, target.gridY + info.height / 2);
        troop.facingAngle = Math.atan2(end.y - start.y, end.x - start.x);

        const launchGX = troop.gridX;
        const launchGY = troop.gridY;
        const shotTargetGX = target.gridX + info.width / 2;
        const shotTargetGY = target.gridY + info.height / 2;

        const bomb = this.trackBattleFx(this.add.graphics());
        bomb.setPosition(start.x, start.y - 34); // released from altitude
        bomb.setDepth(depthForProjectile(launchGX, launchGY));
        const bombBaked = this.syncProjectileSprite(bomb, 'ornithopter_bomb', 1, 0, 1);
        if (!bombBaked) ProjectileRenderer.drawOrnithopterBomb(bomb);

        const flightMs = 420;
        const midY = Math.min(start.y - 34, end.y - 20) - 24;

        this.tweens.add({
            targets: bomb,
            x: { value: (start.x + end.x) / 2, duration: flightMs / 2, ease: 'Linear' },
            y: { value: midY, duration: flightMs / 2, ease: 'Quad.easeOut' },
            onUpdate: (tween) => {
                const t = tween.progress * 0.5;
                bomb.setDepth(depthForProjectile(
                    launchGX + (shotTargetGX - launchGX) * t,
                    launchGY + (shotTargetGY - launchGY) * t));
                if (bombBaked) this.syncProjectileSprite(bomb, 'ornithopter_bomb', 1, 0, 1);
            },
            onComplete: () => {
                this.tweens.add({
                    targets: bomb,
                    x: { value: end.x, duration: flightMs / 2, ease: 'Linear' },
                    y: { value: end.y, duration: flightMs / 2, ease: 'Quad.easeIn' },
                    onUpdate: (tween) => {
                        const t = 0.5 + tween.progress * 0.5;
                        bomb.setDepth(depthForProjectile(
                            launchGX + (shotTargetGX - launchGX) * t,
                            launchGY + (shotTargetGY - launchGY) * t));
                        if (bombBaked) this.syncProjectileSprite(bomb, 'ornithopter_bomb', 1, 0, 1);
                    },
                    onComplete: () => {
                        bomb.destroy();

                        this.cameras.main.shake(20, 0.0008);
                        particleManager.emitExplosion(end.x, end.y, depthForGroundEffect(shotTargetGX, shotTargetGY));

                        const sRadius = stats.splashRadius || 1.2;
                        [...this.buildings].forEach(b => {
                            if (b.owner !== troop.owner && b.health > 0) {
                                const bInfo = BUILDINGS[b.type];
                                const bCenterX = b.gridX + bInfo.width / 2;
                                const bCenterY = b.gridY + bInfo.height / 2;
                                const bdist = Math.hypot(bCenterX - shotTargetGX, bCenterY - shotTargetGY);
                                if (bdist <= sRadius) {
                                    const splashDamage = bdist < 0.5 ? damage : damage * 0.6;
                                    b.health -= splashDamage;
                                    this.updateHealthBar(b);
                                    if (b.health <= 0) this.destroyBuilding(b);
                                }
                            }
                        });
                    }
                });
            }
        });
    }

    private showStormLightning(troop: Troop, target: PlacedBuilding, damage: number) {
        // Redraw to show attack pose (could be facing change or effect)
        const start = IsoUtils.cartToIso(troop.gridX, troop.gridY);
        const info = BUILDINGS[target.type];
        const end = IsoUtils.cartToIso(target.gridX + info.width / 2, target.gridY + info.height / 2);

        // Face target
        const angle = Math.atan2(end.y - start.y, end.x - start.x);
        troop.facingAngle = angle;
        this.redrawTroop(troop);

        // Calculate chain targets
        const stormStats = this.getTroopCombatStats(troop);
        const chainCount = stormStats.chainCount || 4;
        const chainRange = stormStats.chainRange || 5;
        const targets = this.findChainTargets(target, chainCount, chainRange, troop.owner);

        // Initial Zap Visual (Troop -> First Target)
        // Start from the staff crystal (raised two-handed while casting).
        // The bolt spans two tiles: painter depth of the FRONT endpoint so it
        // clears both, while rows in front of both still cover it.
        const staffTipX = start.x + 3.5;
        const staffTipY = start.y - 16;
        this.drawLightningBolt(staffTipX, staffTipY, end.x, end.y - 15, 0x00ffff,
            Math.max(
                depthForProjectile(troop.gridX, troop.gridY),
                depthForProjectile(target.gridX + info.width / 2, target.gridY + info.height / 2)));

        // Apply damage to primary
        this.applyLightningDamage(target, damage);

        // Chain logic (Target -> Next -> Next)
        let previous = target;
        // Use 80% damage for subsequent hits
        let currentDamage = damage * 0.8;

        targets.forEach((nextTarget, index) => {
            this.scheduleBattleCall(100 * (index + 1), () => {
                if (nextTarget.health > 0 && (previous.health > 0 || index === 0)) { // Allow chaining from dead primary
                    const pInfo = BUILDINGS[previous.type];
                    // Get center of previous, or its last known pos if dead (approx)
                    const pPos = IsoUtils.cartToIso(previous.gridX + pInfo.width / 2, previous.gridY + pInfo.height / 2);

                    const nInfo = BUILDINGS[nextTarget.type];
                    const nPos = IsoUtils.cartToIso(nextTarget.gridX + nInfo.width / 2, nextTarget.gridY + nInfo.height / 2);

                    this.drawLightningBolt(pPos.x, pPos.y - 15, nPos.x, nPos.y - 15, 0x00ccff,
                        Math.max(
                            depthForProjectile(previous.gridX + pInfo.width / 2, previous.gridY + pInfo.height / 2),
                            depthForProjectile(nextTarget.gridX + nInfo.width / 2, nextTarget.gridY + nInfo.height / 2)));
                    this.applyLightningDamage(nextTarget, currentDamage);

                    currentDamage *= 0.8; // Further decay
                    previous = nextTarget;
                }
            });
        });
    }

    private findChainTargets(startNode: PlacedBuilding, count: number, range: number, attackerOwner: string): PlacedBuilding[] {
        const found: PlacedBuilding[] = [];
        let current = startNode;
        // Find all enemies excluding the start node and walls
        const enemies = this.buildings.filter(b => b.owner !== attackerOwner && b.health > 0 && b.id !== startNode.id && b.type !== 'wall');

        // Simple greedy chain
        for (let i = 0; i < count; i++) {
            // Find closest unvisited enemy to 'current'
            let nearest: PlacedBuilding | null = null;
            let minDist = range;

            const infoCurr = BUILDINGS[current.type];

            for (const enemy of enemies) {
                if (found.includes(enemy)) continue;

                const infoEnemy = BUILDINGS[enemy.type];
                const dist = Phaser.Math.Distance.Between(
                    current.gridX + infoCurr.width / 2, current.gridY + infoCurr.height / 2,
                    enemy.gridX + infoEnemy.width / 2, enemy.gridY + infoEnemy.height / 2
                );

                if (dist < minDist) {
                    minDist = dist;
                    nearest = enemy;
                }
            }

            if (nearest) {
                found.push(nearest);
                current = nearest;
            } else {
                break; // No more targets in range
            }
        }
        return found;
    }

    private drawLightningBolt(x1: number, y1: number, x2: number, y2: number, color: number, depth: number) {
        const graphics = this.trackBattleFx(this.add.graphics());
        graphics.setDepth(depth);

        // Jittered bolt path, stroked twice below (main pass, then glow pass).
        const boltPts: Array<{ x: number; y: number }> = [{ x: x1, y: y1 }];

        const dist = Phaser.Math.Distance.Between(x1, y1, x2, y2);
        // Ensure steps is at least 2 to prevent loops
        const steps = Math.max(Math.floor(dist / 10), 2);
        const angle = Math.atan2(y2 - y1, x2 - x1);

        let cx = x1;
        let cy = y1;

        for (let i = 1; i < steps; i++) {
            const progress = i / steps;
            const tx = x1 + (x2 - x1) * progress;
            const ty = y1 + (y2 - y1) * progress;

            // Jitter perpendicular to line
            const jitter = (Math.random() - 0.5) * 15;
            const px = tx + Math.cos(angle + Math.PI / 2) * jitter;
            const py = ty + Math.sin(angle + Math.PI / 2) * jitter;

            boltPts.push({ x: px, y: py });
            cx = px;
            cy = py;

            // Occasional fork logic
            if (Math.random() > 0.7) {
                const forkLen = 15;
                const forkAngle = angle + (Math.random() - 0.5);
                const fx = cx + Math.cos(forkAngle) * forkLen;
                const fy = cy + Math.sin(forkAngle) * forkLen;

                const fork = this.trackBattleFx(this.add.graphics());
                fork.setDepth(depth);
                pixelLine(fork, cx, cy, fx, fy, 1, color, 0.7);
                this.tweens.add({
                    targets: fork,
                    alpha: 0,
                    duration: 150,
                    onComplete: () => fork.destroy()
                });
            }
        }
        boltPts.push({ x: x2, y: y2 });
        // Draw main bolt
        for (let i = 1; i < boltPts.length; i++) {
            pixelLine(graphics, boltPts[i - 1].x, boltPts[i - 1].y, boltPts[i].x, boltPts[i].y, 1, color, 1);
        }

        // Glow effect
        for (let i = 1; i < boltPts.length; i++) {
            pixelLine(graphics, boltPts[i - 1].x, boltPts[i - 1].y, boltPts[i].x, boltPts[i].y, 4, color, 0.3);
        }

        // Fast Fade out
        this.tweens.add({
            targets: graphics,
            alpha: 0,
            duration: 200,
            onComplete: () => graphics.destroy()
        });
    }

    private applyLightningDamage(target: PlacedBuilding, damage: number) {
        if (target && target.health > 0) {
            target.health -= damage;
            this.updateHealthBar(target);

            if (target.health <= 0) {
                this.destroyBuilding(target);
                // Clear targets targeting this dead building
                this.troops.forEach(t => {
                    if (t.target && t.target.id === target.id) {
                        t.target = null;
                    }
                });
            }
        }
    }

    private shootBallistaAt(ballista: PlacedBuilding, troop: Troop) {
        const info = BUILDINGS['ballista'];
        const stats = this.getDefenseStats(ballista);
        const start = IsoUtils.cartToIso(ballista.gridX + info.width / 2, ballista.gridY + info.height / 2);
        const end = IsoUtils.cartToIso(troop.gridX, troop.gridY);
        const angle = Math.atan2(end.y - start.y, end.x - start.x);
        const targetTroop = troop;
        const ballistaDamage = stats.damage || 240;
        // Painter's-order depth along the shot's ground track.
        const launchGX = ballista.gridX + info.width / 2;
        const launchGY = ballista.gridY + info.height / 2;

        // Set target angle for smooth rotation (handled in updateBuildingAnimations)
        ballista.ballistaTargetAngle = angle;

        // Initialize ballista state if not set
        if (ballista.ballistaAngle === undefined) {
            ballista.ballistaAngle = angle; // Start facing the target
        }
        ballista.ballistaBoltLoaded = true;
        ballista.ballistaStringTension = 0;

        // Wind-back animation: tween the string tension from 0 to 1.
        // Tracked: its onComplete SPAWNS the bolt — uninterrupted it would
        // fire a fresh projectile over the home lawn after a fast exit.
        this.trackBattleFxTween(this.tweens.add({
            targets: { tension: 0 },
            tension: 1,
            duration: 400,
            ease: 'Power2',
            onUpdate: (tween) => {
                ballista.ballistaStringTension = tween.getValue() ?? 0;
            },
            onComplete: () => {
                // Fire! Hide the bolt on the ballista
                ballista.ballistaBoltLoaded = false;
                // Create flying bolt projectile
                const bolt = this.trackBattleFx(this.add.graphics());

                // Huge spear matching the loaded bolt on the machine
                const bLevel = ballista.level ?? 1;

                // Exit exactly where the loaded bolt sits on the rail
                const boltStartX = start.x + Math.cos(angle) * 14;
                const boltStartY = start.y - 28 + Math.sin(angle) * 0.5 * 14;
                bolt.setPosition(boltStartX, boltStartY);
                bolt.setRotation(angle);
                bolt.setDepth(depthForProjectile(launchGX, launchGY));
                const boltBaked = this.syncProjectileSprite(bolt, 'ballista_bolt', Math.min(bLevel, 3), angle);
                if (!boltBaked) ProjectileRenderer.drawBallistaBolt(bolt, bLevel);



                // Release the string (tension snaps back to 0)
                this.tweens.add({
                    targets: { tension: 1 },
                    tension: 0,
                    duration: 100,
                    ease: 'Back.out',
                    onUpdate: (tween) => {
                        ballista.ballistaStringTension = tween.getValue() ?? 0;
                    }
                });

                // Bolt HOMES onto the troop's live position (the 400ms windup
                // above made fire-time aim ~a tile stale): the tween drives
                // progress; each update re-aims so impact FX and damage agree.
                const dist = Phaser.Math.Distance.Between(start.x, start.y, end.x, end.y);
                let lastTrailTime = 0;
                const aim = { x: end.x, y: end.y };

                // Ground shadow tracking under the bolt
                const boltShadow = this.trackBattleFx(this.add.graphics());
                pixelEllipse(boltShadow, 0, 0, 15, 4.5, 0x18220f, 0.28);
                boltShadow.setPosition(boltStartX, start.y + 3);
                boltShadow.setRotation(angle);
                boltShadow.setDepth(950);

                const flight = { t: 0 };
                this.trackBattleFxTween(this.tweens.add({
                    targets: flight,
                    t: 1,
                    duration: dist / 1.2,
                    ease: 'Linear',
                    onUpdate: () => {
                        if (targetTroop.health > 0 && targetTroop.gameObject.active) {
                            const live = IsoUtils.cartToIso(targetTroop.gridX, targetTroop.gridY);
                            aim.x = live.x;
                            aim.y = live.y;
                        }
                        const t = flight.t;
                        const liveAngle = Math.atan2(aim.y - boltStartY, aim.x - boltStartX);
                        bolt.setPosition(boltStartX + (aim.x - boltStartX) * t, boltStartY + (aim.y - boltStartY) * t);
                        bolt.setRotation(liveAngle);
                        // Depth follows the ground track under the bolt.
                        bolt.setDepth(depthForProjectile(
                            launchGX + (targetTroop.gridX - launchGX) * t,
                            launchGY + (targetTroop.gridY - launchGY) * t));
                        boltShadow.setPosition(bolt.x, (start.y + 3) + (aim.y - start.y) * t);
                        boltShadow.setRotation(liveAngle);
                        if (boltBaked) this.syncProjectileSprite(bolt, 'ballista_bolt', Math.min(bLevel, 3), liveAngle);
                        // White trail particles at TAIL - Aggressive
                        const now = this.time.now;
                        if (now - lastTrailTime > 10) {
                            lastTrailTime = now;
                            const trail = this.trackBattleFx(this.add.graphics());
                            pixelEllipse(trail, 0, 0, 3, 3, 0xffffff, 0.7);

                            // Calculate tail position (bolt is ~30px long, tail at -16 local)
                            // Responsive offset: Starts at 0, grows to 70 based on travel
                            const traveled = t * dist;
                            const currentOffset = Math.min(traveled, 70);

                            const rot = bolt.rotation;
                            const tailX = bolt.x - Math.cos(rot) * currentOffset;
                            const tailY = bolt.y - Math.sin(rot) * currentOffset;

                            trail.setPosition(tailX, tailY);
                            trail.setDepth(bolt.depth - 1);
                            this.tweens.add({
                                targets: trail,
                                alpha: 0,
                                scale: 0.2,
                                duration: 300,
                                onComplete: () => trail.destroy()
                            });
                        }
                    },
                    onComplete: () => {
                        this.cameras.main.shake(50, 0.00025, true);
                        bolt.destroy();
                        boltShadow.destroy();
                        // Deal damage
                        if (targetTroop && targetTroop.health > 0) {
                            this.applyLocalTroopDamage(targetTroop, ballistaDamage);
                        }

                        // === EXPLOSION EFFECT === (sorts with the world at
                        // the impact tile; ±N keeps the internal stacking)
                        const fxDepth = depthForGroundEffect(targetTroop.gridX, targetTroop.gridY);
                        // Initial flash
                        const flash = this.trackBattleFx(this.add.graphics());
                        pixelEllipse(flash, 0, 0, 15, 15, 0xffffcc, 0.9);
                        flash.setPosition(aim.x, aim.y);
                        flash.setDepth(fxDepth + 2);
                        this.tweens.add({
                            targets: flash,
                            scale: 2, alpha: 0,
                            duration: 80,
                            onComplete: () => flash.destroy()
                        });

                        // Shockwave ring
                        this.trackBattleFx(PixelFx.ring(this, aim.x, aim.y, {
                            r0: 8, r1: 38, thick0: 3 / 1.35, thick1: 1 / 1.35,
                            color: 0xff8800, alpha: 0.7,
                            life: 200, fadePow: 2, depth: fxDepth + 1
                        }));

                        // Fire/explosion particles
                        for (let i = 0; i < 6; i++) {
                            const particle = this.trackBattleFx(this.add.graphics());
                            const pAngle = Math.random() * Math.PI * 2;
                            const pDist = 15 + Math.random() * 20;
                            const pR = 4 + Math.random() * 4;
                            pixelEllipse(particle, 0, 0, pR, pR, 0xff6600 + Math.floor(Math.random() * 0x3300), 0.9);
                            particle.setPosition(aim.x, aim.y);
                            particle.setDepth(fxDepth);

                            this.tweens.add({
                                targets: particle,
                                x: aim.x + Math.cos(pAngle) * pDist,
                                y: aim.y + Math.sin(pAngle) * pDist * 0.5 - 10,
                                scale: 0.3,
                                alpha: 0,
                                duration: 200 + Math.random() * 100,
                                ease: 'Quad.easeOut',
                                onComplete: () => particle.destroy()
                            });
                        }

                        // Main impact glow (isometric oval)
                        const impact = this.trackBattleFx(this.add.graphics());
                        pixelEllipse(impact, 0, 0, 12, 6, 0xff4400, 0.8);
                        pixelEllipse(impact, 0, 0, 6, 3, 0xffcc00, 0.6);
                        impact.setPosition(aim.x, aim.y);
                        impact.setDepth(fxDepth - 1);
                        this.tweens.add({
                            targets: impact,
                            scale: 2, alpha: 0,
                            duration: 200,
                            onComplete: () => impact.destroy()
                        });
                    }
                }));

                // Reload bolt based on configured fire cadence.
                const reloadDelay = Math.max(300, (stats.fireRate ?? 1900) - 250);
                this.scheduleBattleCall(reloadDelay, () => {
                    ballista.ballistaBoltLoaded = true;
                });
            }
        }));
    }

    private shootXBowAt(xbow: PlacedBuilding, troop: Troop) {
        const info = BUILDINGS['xbow'];
        const stats = this.getDefenseStats(xbow);
        const xbowDamage = stats.damage || 14;
        const start = IsoUtils.cartToIso(xbow.gridX + info.width / 2, xbow.gridY + info.height / 2);
        const end = IsoUtils.cartToIso(troop.gridX, troop.gridY);
        const angle = Math.atan2(end.y - start.y, end.x - start.x);
        const targetTroop = troop;

        // Set targeting angle for X-Bow rotation (uses same system as ballista)
        xbow.ballistaTargetAngle = angle;
        if (xbow.ballistaAngle === undefined) {
            xbow.ballistaAngle = angle;
        }

        // Fast string pullback animation
        xbow.ballistaStringTension = 1;
        this.tweens.add({
            targets: xbow,
            ballistaStringTension: 0,
            duration: 80, // Super fast pullback
            ease: 'Cubic.easeOut'
        });

        // Small, narrow arrow (shuttle).
        // Painter's-order depth along the shot's ground track.
        const launchGX = xbow.gridX + info.width / 2;
        const launchGY = xbow.gridY + info.height / 2;
        const xbowLevel = xbow.level ?? 1;
        const arrow = this.trackBattleFx(this.add.graphics());

        const arrowStartX = start.x;
        const arrowStartY = start.y - 20;
        arrow.setPosition(arrowStartX, arrowStartY);
        arrow.setRotation(angle);
        arrow.setDepth(depthForProjectile(launchGX, launchGY));
        const arrowBaked = this.syncProjectileSprite(arrow, 'xbow_bolt', Math.min(xbowLevel, 3), angle);
        if (!arrowBaked) ProjectileRenderer.drawXbowBolt(arrow, xbowLevel);

        // Shuttle HOMES onto the troop's live position so the impact flash
        // and the damage land together (fire-time aim drifted ~a tile).
        const aim = { x: end.x, y: end.y };
        const dist = Phaser.Math.Distance.Between(start.x, start.y, end.x, end.y);
        const flight = { t: 0 };
        this.trackBattleFxTween(this.tweens.add({
            targets: flight,
            t: 1,
            duration: dist / 1.5, // Constant speed (1500 px/s)
            ease: 'Linear',
            onUpdate: () => {
                if (targetTroop.health > 0 && targetTroop.gameObject.active) {
                    const live = IsoUtils.cartToIso(targetTroop.gridX, targetTroop.gridY);
                    aim.x = live.x;
                    aim.y = live.y;
                }
                const liveAngle = Math.atan2(aim.y - arrowStartY, aim.x - arrowStartX);
                arrow.setPosition(arrowStartX + (aim.x - arrowStartX) * flight.t, arrowStartY + (aim.y - arrowStartY) * flight.t);
                arrow.setRotation(liveAngle);
                // Depth follows the ground track under the shot.
                arrow.setDepth(depthForProjectile(
                    launchGX + (targetTroop.gridX - launchGX) * flight.t,
                    launchGY + (targetTroop.gridY - launchGY) * flight.t));
                if (arrowBaked) this.syncProjectileSprite(arrow, 'xbow_bolt', Math.min(xbowLevel, 3), liveAngle);
            },
            onComplete: () => {
                arrow.destroy();
                // Deal level-scaled damage.
                if (targetTroop && targetTroop.health > 0) {
                    this.applyLocalTroopDamage(targetTroop, xbowDamage);
                }
                // Small impact
                this.trackBattleFx(PixelFx.flash(this, aim.x, aim.y, { r: 4, color: 0x8b4513, alpha: 0.6, scaleTo: 1.5, life: 100, depth: depthForGroundEffect(targetTroop.gridX, targetTroop.gridY) }));
            }
        }));
    }

    private redrawTroop(troop: Troop) {
        const g = troop.gameObject;
        // Attack animations tween plain objects whose callbacks outlive the
        // troop (golem slam, tank rotation, phalanx thrust). Drawing on a
        // destroyed Graphics throws inside Phaser's tween step and would kill
        // the whole game loop — a dead troop just skips its redraw.
        if (!g || !g.active || !g.scene) return;
        g.clear();
        // Parked siege tower: the baked 'deactivated' (ramp-down) pose wins;
        // the vector path below carries the continuous parked01 driver.
        if (troop.type === 'siegetower' && (troop.parked01 ?? 0) >= 0.5
            && SpriteBank.syncTroopPose(this, g, 'siegetower', troop.owner, troop.level || 1, troop.facingAngle || 0, 'deactivated')) return;
        if (SpriteBank.syncTroop(this, troop, true, this.troopAttackAge(troop), this.animClockNow())) return;
        TroopRenderer.drawTroopVisual(g, troop.type, troop.owner, troop.facingAngle, true, troop.slamOffset || 0, troop.mortarRecoil || 0, troop.parked01 ?? 0, troop.phalanxSpearOffset || 0, troop.level || 1, this.animClockNow(), this.troopAttackAge(troop), troop.attackDelay);
    }

    private redrawTroopWithMovement(troop: Troop, isMoving: boolean) {
        const g = troop.gameObject;
        if (!g || !g.active || !g.scene) return; // see redrawTroop
        g.clear();
        if (troop.type === 'siegetower' && (troop.parked01 ?? 0) >= 0.5
            && SpriteBank.syncTroopPose(this, g, 'siegetower', troop.owner, troop.level || 1, troop.facingAngle || 0, 'deactivated')) return;
        if (SpriteBank.syncTroop(this, troop, isMoving, this.troopAttackAge(troop), this.animClockNow())) return;
        TroopRenderer.drawTroopVisual(g, troop.type, troop.owner, troop.facingAngle, isMoving, troop.slamOffset || 0, troop.mortarRecoil || 0, troop.parked01 ?? 0, troop.phalanxSpearOffset || 0, troop.level || 1, this.animClockNow(), this.troopAttackAge(troop), troop.attackDelay);
    }

    /**
     * ms since this troop's last damage tick — the renderer keys wind-up /
     * strike animation off it so attacks land exactly when damage fires.
     * Live troops whose tick is stale (not actually fighting: pathing
     * pauses) report -1 so idle stances stay idle;
     * replay troops never update lastAttackTime, so in REPLAY mode the stale
     * age passes through and the renderer free-runs the cycle instead.
     */
    private troopAttackAge(troop: Troop): number {
        const age = this.animClockNow() - troop.lastAttackTime;
        if (age < 0) return -1; // chill effect pushes lastAttackTime ahead of the clock
        if (this.mode !== 'REPLAY' && age > troop.attackDelay + 600) return -1;
        return age;
    }

    /** Baked-sprite stamp for a rigid projectile; false → caller draws vector.
     *  Carrier scale rides along so in-flight size pulses (mortar arc,
     *  spike-ball wobble) survive on the baked path. */
    private syncProjectileSprite(carrier: Phaser.GameObjects.Graphics, unit: string, level: number, rot = 0, angles = 16): boolean {
        const TAU = Math.PI * 2;
        const a = Math.round((((rot % TAU) + TAU) % TAU) / (TAU / angles)) % angles;
        const variant = angles === 1 ? `l${level}` : `l${level}_a${String(a).padStart(2, '0')}`;
        return SpriteBank.syncFigure(this, carrier, unit, variant, 'idle', 0, false,
            { kind: 'projectiles', scaleMul: Math.abs(carrier.scaleX) || 1 });
    }

    private setTroopRetargetPause(troop: Troop, minMs: number = 70, maxMs: number = 180) {
        const pauseScale = 1.15; // Slightly longer hesitation for clearer "decision" feel.
        const scaledMin = Math.max(0, Math.round(minMs * pauseScale));
        const scaledMax = Math.max(scaledMin, Math.round(maxMs * pauseScale));
        // Hesitation varies per troop, not per roll: stable id hash instead
        // of RNG so identical battles replay with identical pauses.
        const jitter = this.navigationSlot(troop, scaledMax - scaledMin + 1);
        const until = this.time.now + scaledMin + jitter;
        troop.retargetPauseUntil = Math.max(troop.retargetPauseUntil ?? 0, until);
    }

    private liveBuildingById(id: string | undefined): PlacedBuilding | null {
        if (!id) return null;
        return this.buildings.find(building =>
            building.id === id && building.health > 0 && !building.isDestroyed
        ) ?? null;
    }

    private isLiveTroopTarget(value: unknown): value is Troop {
        if (!value || typeof value !== 'object') return false;
        const candidate = value as Troop;
        return candidate.health > 0 && this.troops.some(troop => troop.id === candidate.id);
    }

    /** Follow-target pick for support healers (physician's cart): closest
     *  INJURED combat ally first, else the closest combat ally, else an
     *  enemy building so the last cart standing still advances. Healers
     *  never follow other healers — the last two would orbit each other. */
    private findHealerFollowTarget(healer: Troop): Troop | PlacedBuilding | null {
        const allies = this.troops.filter(t =>
            t.owner === healer.owner && t.id !== healer.id && t.health > 0
            && !this.isSupportHealer(t)
        );

        const byDistance = (a: Troop, b: Troop) => {
            const da = Phaser.Math.Distance.Between(healer.gridX, healer.gridY, a.gridX, a.gridY);
            const db = Phaser.Math.Distance.Between(healer.gridX, healer.gridY, b.gridX, b.gridY);
            return da - db || a.id.localeCompare(b.id);
        };

        const injured = allies.filter(t => t.health < t.maxHealth);
        if (injured.length > 0) {
            injured.sort(byDistance);
            return injured[0];
        }
        if (allies.length > 0) {
            allies.sort(byDistance);
            return allies[0];
        }
        return TargetingSystem.findTarget(healer, this.buildings);
    }

    /** A followed leader died: its healers re-pick immediately. */
    private invalidateSupportFollowers(removedTroopId: string) {
        for (const follower of this.troops) {
            if (!this.isSupportHealer(follower)) continue;
            if ((follower.target as { id?: string } | null)?.id !== removedTroopId) continue;
            follower.target = null;
            follower.navigationPlan = undefined;
            follower.path = undefined;
            follower.nextPathTime = 0;
        }
    }

    private navigationSlot(troop: Troop, span: number): number {
        let hash = 2166136261;
        for (let i = 0; i < troop.id.length; i++) {
            hash ^= troop.id.charCodeAt(i);
            hash = Math.imul(hash, 16777619);
        }
        return (hash >>> 0) % Math.max(1, span);
    }

    private nextNavigationDelay(troop: Troop): number {
        // Stable staggering avoids pathfinding bursts without injecting
        // per-frame randomness into AI decisions. Support followers track a
        // moving ally, so they replan on a tighter cadence (ward precedent).
        const base = this.isSupportHealer(troop) ? 180 : 340;
        return base + this.navigationSlot(troop, base);
    }

    private applyCombatNavigation(troop: Troop, selection: CombatNavigationSelection, now: number) {
        const previousIntentId = troop.strategicTarget?.id;
        const previousActiveId = (troop.target as { id?: string } | null)?.id;

        troop.strategicTarget = selection.strategicTarget;
        troop.navigationPlan = selection.plan ?? undefined;
        troop.target = selection.activeTarget;
        troop.path = selection.plan?.waypoints.map(point => ({ x: point.x, y: point.y }));
        troop.nextPathTime = now + this.nextNavigationDelay(troop);

        // An "already in range, hold position" verdict is a terminal state,
        // not a failed route: reset stuck tracking so recovery stops looping
        // clear-plan → replan → same empty plan every ~900ms.
        if (selection.plan && selection.plan.waypoints.length === 0) {
            troop.stuckTicks = 0;
            troop.lastProgressTime = undefined;
        }

        const intentChanged = previousIntentId !== selection.strategicTarget?.id;
        const activeChanged = previousActiveId !== selection.activeTarget?.id;
        if (intentChanged || activeChanged) {
            troop.lastTargetSwitchTime = now;
            if (intentChanged) troop.lastOpportunityScanTime = now;
            this.setTroopRetargetPause(troop, activeChanged ? 45 : 25, activeChanged ? 120 : 75);
        }
    }

    /** Acquire a route-aware objective. The returned active target may be a
     * required wall, while `strategicTarget` always remains the real building. */
    private acquireTroopNavigation(troop: Troop, now: number) {
        if (this.isSupportHealer(troop)) {
            this.acquireHealerNavigation(troop, now);
            return;
        }
        const selection = CombatNavigationSystem.selectTargetAndPlan(
            troop,
            this.buildings,
            this.troops,
            this.combatTopologyRevision,
            now,
            troop.strategicTarget ?? undefined,
            this.rampSetFor(troop)
        );
        this.applyCombatNavigation(troop, selection, now);
    }

    /**
     * PHYSICIAN'S CART follow lane (the deleted ward lane, generalized by
     * the healer predicate): follow the nearest damaged ally, else the
     * nearest ally — advancing with the push — else fall through to a
     * building objective so the cart never idles alone on the field.
     */
    private acquireHealerNavigation(troop: Troop, now: number) {
        const followTarget = this.findHealerFollowTarget(troop);
        const previousId = (troop.target as { id?: string } | null)?.id;
        troop.target = followTarget;
        troop.strategicTarget = followTarget && BUILDINGS[(followTarget as { type?: string }).type ?? '']
            ? followTarget as PlacedBuilding
            : null;

        if (followTarget && this.isLiveTroopTarget(followTarget)) {
            const followRange = Math.min(2.5, Math.max(1.25, this.getTroopCombatStats(troop).range));
            const plan = CombatNavigationSystem.planToPoint(
                troop,
                { id: followTarget.id, gridX: followTarget.gridX, gridY: followTarget.gridY },
                followRange,
                this.buildings,
                this.troops,
                this.combatTopologyRevision,
                now,
                this.rampSetFor(troop)
            );
            troop.navigationPlan = plan ?? undefined;
            troop.path = plan?.waypoints.map(point => ({ x: point.x, y: point.y }));
        } else if (troop.strategicTarget) {
            const plan = CombatNavigationSystem.planToBuilding(
                troop,
                troop.strategicTarget,
                this.buildings,
                this.troops,
                this.combatTopologyRevision,
                now,
                this.rampSetFor(troop)
            );
            const active = this.liveBuildingById(plan?.activeTargetId) ?? troop.strategicTarget;
            troop.target = active;
            troop.navigationPlan = plan ?? undefined;
            troop.path = plan?.waypoints.map(point => ({ x: point.x, y: point.y }));
        } else {
            troop.navigationPlan = undefined;
            troop.path = undefined;
        }

        troop.nextPathTime = now + this.nextNavigationDelay(troop);
        if (previousId !== (troop.target as { id?: string } | null)?.id) {
            troop.lastTargetSwitchTime = now;
            this.setTroopRetargetPause(troop, 45, 110);
        }
    }

    private refreshTroopNavigation(troop: Troop, now: number) {
        if (this.isSupportHealer(troop) && this.isLiveTroopTarget(troop.target)) {
            const leader = troop.target as Troop;
            const followRange = Math.min(2.5, Math.max(1.25, this.getTroopCombatStats(troop).range));
            const plan = CombatNavigationSystem.planToPoint(
                troop,
                { id: leader.id, gridX: leader.gridX, gridY: leader.gridY },
                followRange,
                this.buildings,
                this.troops,
                this.combatTopologyRevision,
                now,
                this.rampSetFor(troop)
            );
            troop.navigationPlan = plan ?? undefined;
            troop.path = plan?.waypoints.map(point => ({ x: point.x, y: point.y }));
            troop.nextPathTime = now + this.nextNavigationDelay(troop);
            return;
        }

        const strategic = this.liveBuildingById(troop.strategicTarget?.id);
        if (!strategic) {
            this.acquireTroopNavigation(troop, now);
            return;
        }

        // Clash-style target lock with route-aware opportunity switching: a
        // troop stays committed unless another same-tier objective beats the
        // current route by the planner's hysteresis margin.
        if (now >= (troop.lastOpportunityScanTime ?? 0) + 900) {
            troop.lastOpportunityScanTime = now;
            const selection = CombatNavigationSystem.selectTargetAndPlan(
                troop,
                this.buildings,
                this.troops,
                this.combatTopologyRevision,
                now,
                strategic,
                this.rampSetFor(troop)
            );
            if (selection.plan) {
                this.applyCombatNavigation(troop, selection, now);
                return;
            }
        }

        const plan = CombatNavigationSystem.planToBuilding(
            troop,
            strategic,
            this.buildings,
            this.troops,
            this.combatTopologyRevision,
            now,
            this.rampSetFor(troop)
        );
        const activeTarget = this.liveBuildingById(plan?.activeTargetId);
        this.applyCombatNavigation(troop, {
            strategicTarget: plan ? strategic : null,
            activeTarget,
            plan
        }, now);
    }

    private ensureTroopNavigation(troop: Troop, now: number) {
        if (this.isSupportHealer(troop) && this.isLiveTroopTarget(troop.target)) {
            if (!troop.navigationPlan || troop.navigationPlan.topologyRevision !== this.combatTopologyRevision) {
                if (now >= (troop.nextPathTime ?? 0)) this.refreshTroopNavigation(troop, now);
            }
            return;
        }

        const strategic = this.liveBuildingById(troop.strategicTarget?.id);
        const active = this.liveBuildingById((troop.target as { id?: string } | null)?.id);
        const planIsCurrent = !!troop.navigationPlan
            && troop.navigationPlan.topologyRevision === this.combatTopologyRevision
            && troop.navigationPlan.strategicTargetId === strategic?.id
            && troop.navigationPlan.activeTargetId === active?.id;

        if (!strategic) {
            if (now >= (troop.nextPathTime ?? 0)) this.acquireTroopNavigation(troop, now);
        } else if (!planIsCurrent && now >= (troop.nextPathTime ?? 0)) {
            this.refreshTroopNavigation(troop, now);
        }
    }

    private invalidateCombatTopologyForRemoval(removed: PlacedBuilding) {
        this.combatTopologyRevision++;
        const nextRevision = this.combatTopologyRevision;
        const now = this.time.now;

        for (const troop of this.troops) {
            const intentDestroyed = troop.strategicTarget?.id === removed.id;
            const activeDestroyed = (troop.target as { id?: string } | null)?.id === removed.id;
            const routeBlockerDestroyed = troop.navigationPlan?.blockerId === removed.id;

            if (intentDestroyed) {
                // This is the reported stale-wall case: losing the objective
                // cancels all breach work undertaken solely for that objective.
                troop.strategicTarget = null;
                troop.target = null;
            } else if (activeDestroyed) {
                troop.target = this.liveBuildingById(troop.strategicTarget?.id);
            }

            const urgent = intentDestroyed || activeDestroyed || routeBlockerDestroyed;
            if (urgent) {
                troop.navigationPlan = undefined;
                troop.path = undefined;
            } else if (troop.navigationPlan) {
                // Removing geometry can only open routes; it cannot make the
                // existing collision-safe route invalid.  Promote that route
                // to the new revision so unrelated destruction never freezes
                // movement or attacks, then stagger an opportunistic shorter
                // replan that may discover the new opening.
                troop.navigationPlan.topologyRevision = nextRevision;
            }
            troop.nextPathTime = now + this.navigationSlot(troop, urgent ? 180 : 360);
            if (urgent) {
                this.setTroopRetargetPause(troop, 30, 90);
            }
        }
    }

    private nearestWalkableTroopPoint(
        profile: Pick<Troop, 'type' | 'level'>,
        gridX: number,
        gridY: number
    ): { x: number; y: number } {
        if (CombatNavigationSystem.isPositionWalkable(profile, gridX, gridY, this.buildings, this.mapSize)) {
            return { x: gridX, y: gridY };
        }

        // Split troops and area knock-backs can land inside newly-live geometry.
        // Project to the nearest legal sample before rendering the first frame.
        for (let ring = 1; ring <= 12; ring++) {
            const radius = ring * 0.2;
            const samples = Math.max(12, ring * 4);
            for (let sample = 0; sample < samples; sample++) {
                const angle = (sample / samples) * Math.PI * 2;
                const x = gridX + Math.cos(angle) * radius;
                const y = gridY + Math.sin(angle) * radius;
                if (CombatNavigationSystem.isPositionWalkable(profile, x, y, this.buildings, this.mapSize)) {
                    return { x, y };
                }
            }
        }
        return { x: gridX, y: gridY };
    }

    private rotateTroopToward(troop: Troop, desiredAngle: number, delta: number): boolean {
        const turnRate = (troop.type === 'golem' || troop.type === 'icegolem') ? 0.004 : troop.type === 'ram' ? 0.006 : 0.01;
        const maxStep = turnRate * Math.max(1, delta);
        const before = troop.facingAngle || 0;
        troop.facingAngle = Phaser.Math.Angle.RotateTo(before, desiredAngle, maxStep);
        return Math.abs(Phaser.Math.Angle.Wrap(troop.facingAngle - before)) > 0.01;
    }

    private getTargetEdgeDistance(troop: Troop, target: PlacedBuilding | Troop): number {
        const isBuilding = !!BUILDINGS[target.type];
        const tw = isBuilding ? BUILDINGS[target.type].width : 0.5;
        const th = isBuilding ? BUILDINGS[target.type].height : 0.5;
        const bx = isBuilding ? target.gridX : target.gridX - tw / 2;
        const by = isBuilding ? target.gridY : target.gridY - th / 2;
        const dx = Math.max(bx - troop.gridX, 0, troop.gridX - (bx + tw));
        const dy = Math.max(by - troop.gridY, 0, troop.gridY - (by + th));
        return Math.sqrt(dx * dx + dy * dy);
    }


    private handleStuckTroop(troop: Troop, now: number, distToTarget: number): boolean {
        if (troop.lastProgressTime === undefined) {
            troop.lastProgressTime = now;
            troop.lastProgressX = troop.gridX;
            troop.lastProgressY = troop.gridY;
            troop.stuckTicks = 0;
            return false;
        }

        if (now - troop.lastProgressTime < 450) return false;

        const moved = Phaser.Math.Distance.Between(
            troop.gridX,
            troop.gridY,
            troop.lastProgressX ?? troop.gridX,
            troop.lastProgressY ?? troop.gridY
        );

        if (distToTarget > 0.6 && moved < 0.05) {
            troop.stuckTicks = (troop.stuckTicks ?? 0) + 1;
        } else {
            troop.stuckTicks = 0;
        }

        troop.lastProgressX = troop.gridX;
        troop.lastProgressY = troop.gridY;
        troop.lastProgressTime = now;

        if ((troop.stuckTicks ?? 0) < 2) return false;

        troop.stuckTicks = 0;
        troop.path = undefined;
        troop.navigationPlan = undefined;
        troop.nextPathTime = now;
        this.setTroopRetargetPause(troop, 60, 140);
        return true;
    }

    private updateTroops(delta: number) {
        const now = this.time.now;
        const movementDelta = Math.min(delta, 250);

        // Local avoidance remains deliberately separate from global planning.
        // It makes a formation feel alive, while the collision resolver below
        // remains authoritative over every final displacement.
        const SEPARATION_CELL = 2;
        const cellKey = (gx: number, gy: number) =>
            (Math.floor(gx / SEPARATION_CELL) + 64) * 4096 + (Math.floor(gy / SEPARATION_CELL) + 64);
        const separationGrid = new Map<number, Troop[]>();
        for (const candidate of this.troops) {
            if (candidate.health <= 0) continue;
            const key = cellKey(candidate.gridX, candidate.gridY);
            const bucket = separationGrid.get(key);
            if (bucket) bucket.push(candidate);
            else separationGrid.set(key, [candidate]);
        }
        const forEachNeighbor = (of: Troop, fn: (other: Troop) => void) => {
            const cx = Math.floor(of.gridX / SEPARATION_CELL);
            const cy = Math.floor(of.gridY / SEPARATION_CELL);
            for (let ix = cx - 1; ix <= cx + 1; ix++) {
                for (let iy = cy - 1; iy <= cy + 1; iy++) {
                    const bucket = separationGrid.get((ix + 64) * 4096 + (iy + 64));
                    if (!bucket) continue;
                    for (const other of bucket) fn(other);
                }
            }
        };

        const geometryFor = (troop: Troop, target: Troop | PlacedBuilding) => {
            const isBuilding = !!BUILDINGS[(target as { type?: string }).type ?? ''];
            const width = isBuilding ? BUILDINGS[(target as PlacedBuilding).type].width : 0.5;
            const height = isBuilding ? BUILDINGS[(target as PlacedBuilding).type].height : 0.5;
            const bx = isBuilding ? target.gridX : target.gridX - width / 2;
            const by = isBuilding ? target.gridY : target.gridY - height / 2;
            const dx = Math.max(bx - troop.gridX, 0, troop.gridX - (bx + width));
            const dy = Math.max(by - troop.gridY, 0, troop.gridY - (by + height));
            const stats = this.getTroopCombatStats(troop);
            // Support healers trailing an ALLY hold a follow distance instead
            // of their (tiny) attack range — the ward-follow contract.
            const followsAlly = !isBuilding
                && (target as Troop).owner === troop.owner
                && this.isSupportHealer(troop);
            // The planner accepts attack slots out to range+0.08; movement
            // must accept the same verdict, or a troop parked in
            // (range, range+0.08] replan-thrashes forever without attacking.
            // The attack tick's own gate is range+0.1, so it still fires.
            const stopRange = (followsAlly
                ? Math.min(2.5, Math.max(1.25, stats.range))
                : stats.range) + 0.08;
            return {
                centerX: bx + width / 2,
                centerY: by + height / 2,
                distance: Math.hypot(dx, dy),
                stopRange,
                stats
            };
        };

        // QUARTERMASTER WAR DRUMS — the deterministic aura lookup (drummers
        // sorted by id; the FIRST in-radius drummer applies, so multiple
        // quartermasters never stack). Consumed at the march-speed formula
        // and the attack-clock adjust below (chill precedent, sign-flipped).
        const drummers = this.troops
            .filter(t => {
                if (t.health <= 0) return false;
                const s = this.getTroopCombatStats(t);
                return (s.boostRadius ?? 0) > 0
                    && (((s.boostAmount ?? 1) > 1) || ((s.boostCadence ?? 0) > 0));
            })
            .sort((a, b) => a.id.localeCompare(b.id));
        const boostFor = (unit: Troop) => {
            for (const drummer of drummers) {
                if (drummer.id === unit.id || drummer.owner !== unit.owner) continue;
                const s = this.getTroopCombatStats(drummer);
                const d = Math.hypot(drummer.gridX - unit.gridX, drummer.gridY - unit.gridY);
                if (d <= (s.boostRadius ?? 0)) return s;
            }
            return null;
        };

        for (const troop of this.troops) {
            if (troop.health <= 0) continue;

            if (troop.parked01 === undefined) this.ensureTroopNavigation(troop, now);

            // --- CHILLED STATUS EFFECT ---
            // Graphics carriers have no tint of their own — the frost blue
            // rides the baked shadow sprite through SpriteBank.setCarrierTint.
            if ((troop.chillRemainingMs ?? 0) > 0) {
                troop.chillRemainingMs = (troop.chillRemainingMs ?? 0) - delta;
                if (troop.chillRemainingMs <= 0) {
                    troop.chillRemainingMs = 0;
                    SpriteBank.setCarrierTint(troop.gameObject, null);
                } else {
                    SpriteBank.setCarrierTint(troop.gameObject, 0x88ccff);
                    if (troop.lastAttackTime) troop.lastAttackTime += delta * 1.5;
                }
            }

            // --- HAWK-EYE CLOAK SHIMMER --- (carrier-level alpha; SpriteBank
            // reconciliation copies it onto the baked shadow sprite)
            if (troop.untargetableUntil !== undefined) {
                if (now < troop.untargetableUntil) {
                    troop.gameObject.setAlpha(0.55 + 0.07 * Math.sin(now / 150));
                } else {
                    troop.untargetableUntil = undefined;
                    troop.gameObject.setAlpha(1);
                }
            }

            // --- QUARTERMASTER AURA (one application max) ---
            let marchBoost = 1;
            const drum = drummers.length > 0 ? boostFor(troop) : null;
            if (drum) {
                marchBoost = drum.boostAmount ?? 1;
                const cadence = drum.boostCadence ?? 0;
                if (cadence > 0 && troop.lastAttackTime) {
                    // Effective attack delay × (1 − cadence): pull the attack
                    // clock back so its age accrues at 1/(1−cadence) rate —
                    // the chill slow (+delta·1.5) inverted.
                    troop.lastAttackTime -= delta * (1 / (1 - cadence) - 1);
                }
                const newlyBuffed = (troop.lastBoostedAt ?? -Infinity) < now - 250;
                troop.lastBoostedAt = now;
                if (newlyBuffed) troop.boostTintUntil = now + 320;
            }
            // Brief gold flash on newly buffed allies (chill's frost wins).
            if (troop.boostTintUntil !== undefined && (troop.chillRemainingMs ?? 0) <= 0) {
                if (now < troop.boostTintUntil) {
                    SpriteBank.setCarrierTint(troop.gameObject, 0xffd27a);
                } else {
                    troop.boostTintUntil = undefined;
                    SpriteBank.setCarrierTint(troop.gameObject, null);
                }
            }

            // --- PARKED SIEGE TOWER: stationary (still targetable) ---
            if (troop.parked01 !== undefined) {
                troop.velocityX = 0;
                troop.velocityY = 0;
                if (!this.isOffScreen(troop.gridX, troop.gridY)) {
                    this.redrawTroopWithMovement(troop, false);
                }
                continue;
            }

            let movedThisFrame = false;
            let target = troop.target as Troop | PlacedBuilding | null;
            let geometry = target ? geometryFor(troop, target) : null;

            // Knockback impulses (frostfall shove) integrate through the
            // collision resolver for their brief window — the pause/idle
            // branches below only decay velocity and would otherwise turn
            // the impulse into a no-op that never displaces the troop.
            if (now < (troop.knockbackUntil ?? 0)
                && Math.hypot(troop.velocityX ?? 0, troop.velocityY ?? 0) > 0.002) {
                const shove = CombatNavigationSystem.resolveMovement(
                    troop,
                    troop.velocityX ?? 0,
                    troop.velocityY ?? 0,
                    0,
                    0,
                    this.buildings,
                    this.mapSize,
                    this.rampSetFor(troop)
                );
                troop.gridX = shove.x;
                troop.gridY = shove.y;
                if (Math.hypot(shove.dx, shove.dy) > 0.001) {
                    movedThisFrame = true;
                    const pos = IsoUtils.cartToIso(troop.gridX, troop.gridY);
                    troop.gameObject.setPosition(pos.x, pos.y);
                    this.updateHealthBar(troop);
                    const troopDepth = Math.round(depthForTroop(troop.gridX, troop.gridY, troop.type));
                    if (troopDepth !== troop.lastDepth) {
                        troop.lastDepth = troopDepth;
                        troop.gameObject.setDepth(troopDepth);
                    }
                    geometry = target ? geometryFor(troop, target) : null;
                }
            }

            if (target && geometry && now < (troop.retargetPauseUntil ?? 0)) {
                const currentPos = IsoUtils.cartToIso(troop.gridX, troop.gridY);
                const targetPos = IsoUtils.cartToIso(geometry.centerX, geometry.centerY);
                this.rotateTroopToward(
                    troop,
                    Math.atan2(targetPos.y - currentPos.y, targetPos.x - currentPos.x),
                    movementDelta
                );
                troop.velocityX = (troop.velocityX ?? 0) * 0.55;
                troop.velocityY = (troop.velocityY ?? 0) * 0.55;
            } else if (target && geometry
                && (geometry.distance > geometry.stopRange || (troop.path?.length ?? 0) > 0)) {
                // A troop already in range still walks out its remaining
                // waypoints: the planner spread attack slots around the rim,
                // and stopping at the first in-range corridor point re-stacks
                // the whole cohort on one cell.
                const routeIsStale = !troop.navigationPlan
                    || troop.navigationPlan.topologyRevision !== this.combatTopologyRevision
                    || now >= (troop.nextPathTime ?? 0)
                    || troop.path === undefined;

                if (routeIsStale && now >= (troop.nextPathTime ?? 0)) {
                    this.refreshTroopNavigation(troop, now);
                    target = troop.target as Troop | PlacedBuilding | null;
                    geometry = target ? geometryFor(troop, target) : null;
                }

                // Topology additions (replay correction/spawned geometry) can
                // invalidate a route.  Never consume stale waypoints while its
                // deterministic replan slot is pending.  Removal-only changes
                // are promoted to the current revision above and keep moving.
                if (!troop.navigationPlan
                    || troop.navigationPlan.topologyRevision !== this.combatTopologyRevision) {
                    troop.path = undefined;
                }

                if (target && geometry && now >= (troop.retargetPauseUntil ?? 0)
                    && (geometry.distance > geometry.stopRange || (troop.path?.length ?? 0) > 0)) {
                    while (troop.path && troop.path.length > 0) {
                        const waypoint = troop.path[0];
                        if (Math.hypot(waypoint.x - troop.gridX, waypoint.y - troop.gridY) >= 0.04) break;
                        troop.path.shift();
                    }

                    const waypoint = troop.path?.[0];
                    if (waypoint) {
                        const moveDir = new Phaser.Math.Vector2(
                            waypoint.x - troop.gridX,
                            waypoint.y - troop.gridY
                        );
                        if (moveDir.lengthSq() > 0.0001) {
                            const waypointDistance = moveDir.length();
                            moveDir.normalize();

                            const separation = new Phaser.Math.Vector2(0, 0);
                            const sidestep = new Phaser.Math.Vector2(0, 0);
                            const sideNormal = new Phaser.Math.Vector2(-moveDir.y, moveDir.x);
                            let idHash = 0;
                            for (let i = 0; i < troop.id.length; i++) {
                                idHash = Math.imul(idHash ^ troop.id.charCodeAt(i), 16777619);
                            }
                            const stableSide = (idHash & 1) === 0 ? -1 : 1;

                            forEachNeighbor(troop, other => {
                                if (other === troop || other.health <= 0) return;
                                const ox = other.gridX - troop.gridX;
                                const oy = other.gridY - troop.gridY;
                                const distance = Math.hypot(ox, oy);
                                if (distance <= 0.001 || distance >= 1.8) return;

                                const weight = (1.8 - distance) / 1.8;
                                separation.x -= (ox / distance) * weight;
                                separation.y -= (oy / distance) * weight;

                                if (distance < 1.4) {
                                    const forwardDot = ((ox * moveDir.x) + (oy * moveDir.y)) / distance;
                                    if (forwardDot > 0.25) {
                                        const lateral = (sideNormal.x * ox) + (sideNormal.y * oy);
                                        const side = Math.abs(lateral) < 0.03 ? stableSide : (lateral >= 0 ? -1 : 1);
                                        const sideWeight = (1.4 - distance) / 1.4;
                                        sidestep.x += sideNormal.x * side * sideWeight;
                                        sidestep.y += sideNormal.y * side * sideWeight;
                                    }
                                }
                            });

                            const desiredMove = moveDir.clone()
                                .add(separation.scale(0.5))
                                .add(sidestep.scale(0.28));
                            if (desiredMove.lengthSq() < 0.0001) desiredMove.copy(moveDir);
                            else desiredMove.normalize();

                            const chilled = (troop.chillRemainingMs ?? 0) > 0;
                            const speed = geometry.stats.speed
                                * troop.speedMult
                                * movementDelta
                                * 1.12
                                * (chilled ? 0.4 : 1)
                                * marchBoost; // quartermaster war drums (×1 unbuffed)
                            const targetVx = ((desiredMove.x * 0.82) + (moveDir.x * 0.18)) * speed;
                            const targetVy = ((desiredMove.y * 0.82) + (moveDir.y * 0.18)) * speed;
                            troop.velocityX = Phaser.Math.Linear(troop.velocityX ?? targetVx, targetVx, 0.45);
                            troop.velocityY = Phaser.Math.Linear(troop.velocityY ?? targetVy, targetVy, 0.45);

                            const velocityMagnitude = Math.hypot(troop.velocityX, troop.velocityY);
                            const maxVelocity = Math.min(speed * 1.3, waypointDistance);
                            if (velocityMagnitude > maxVelocity && velocityMagnitude > 0.0001) {
                                const scale = maxVelocity / velocityMagnitude;
                                troop.velocityX *= scale;
                                troop.velocityY *= scale;
                            }

                            const fromX = troop.gridX;
                            const fromY = troop.gridY;
                            const motion = CombatNavigationSystem.resolveMovement(
                                troop,
                                troop.velocityX,
                                troop.velocityY,
                                moveDir.x * speed,
                                moveDir.y * speed,
                                this.buildings,
                                this.mapSize,
                                this.rampSetFor(troop)
                            );

                            troop.gridX = motion.x;
                            troop.gridY = motion.y;
                            troop.velocityX = motion.dx;
                            troop.velocityY = motion.dy;
                            movedThisFrame = Math.hypot(motion.dx, motion.dy) > 0.001;

                            if (motion.blocked && !movedThisFrame) {
                                troop.velocityX *= 0.35;
                                troop.velocityY *= 0.35;
                            }

                            if (movedThisFrame) {
                                const fromPos = IsoUtils.cartToIso(fromX, fromY);
                                const pos = IsoUtils.cartToIso(troop.gridX, troop.gridY);
                                troop.gameObject.setPosition(pos.x, pos.y);
                                this.updateHealthBar(troop);

                                const troopDepth = Math.round(depthForTroop(troop.gridX, troop.gridY, troop.type));
                                if (troopDepth !== troop.lastDepth) {
                                    troop.lastDepth = troopDepth;
                                    troop.gameObject.setDepth(troopDepth);
                                }

                                const facing = Math.atan2(pos.y - fromPos.y, pos.x - fromPos.x);
                                this.rotateTroopToward(troop, facing, movementDelta);
                            }

                            this.handleStuckTroop(troop, now, geometry.distance);
                        }
                    } else {
                        // A failed or exhausted route never becomes permission to
                        // walk directly through geometry. Stuck recovery replans
                        // the retained objective instead.
                        troop.velocityX = (troop.velocityX ?? 0) * 0.45;
                        troop.velocityY = (troop.velocityY ?? 0) * 0.45;
                        this.handleStuckTroop(troop, now, geometry.distance);
                    }
                }
            } else if (target && geometry) {
                troop.velocityX = (troop.velocityX ?? 0) * 0.7;
                troop.velocityY = (troop.velocityY ?? 0) * 0.7;
                const pos = IsoUtils.cartToIso(troop.gridX, troop.gridY);
                const targetPos = IsoUtils.cartToIso(geometry.centerX, geometry.centerY);
                this.rotateTroopToward(
                    troop,
                    Math.atan2(targetPos.y - pos.y, targetPos.x - pos.x),
                    movementDelta
                );

                // Gentle separation for troops standing at their attack
                // slots: stopped troops must not interpenetrate. Micro-steps
                // run through the same collision resolver and are rejected
                // outright if they would break the in-range hold.
                const push = new Phaser.Math.Vector2(0, 0);
                forEachNeighbor(troop, other => {
                    if (other === troop || other.health <= 0) return;
                    const ox = other.gridX - troop.gridX;
                    const oy = other.gridY - troop.gridY;
                    const d = Math.hypot(ox, oy);
                    if (d >= 0.5) return;
                    if (d < 0.001) {
                        // Exactly coincident troops: split along a stable
                        // per-id direction instead of a random one.
                        const jitter = (this.navigationSlot(troop, 6283) / 6283) * Math.PI * 2;
                        push.x += Math.cos(jitter);
                        push.y += Math.sin(jitter);
                        return;
                    }
                    const w = (0.5 - d) / 0.5;
                    push.x -= (ox / d) * w;
                    push.y -= (oy / d) * w;
                });
                if (push.lengthSq() > 0.0025) {
                    const step = Math.min(0.012, 0.0007 * movementDelta);
                    push.normalize();
                    const micro = CombatNavigationSystem.resolveMovement(
                        troop,
                        push.x * step,
                        push.y * step,
                        0,
                        0,
                        this.buildings,
                        this.mapSize,
                        this.rampSetFor(troop)
                    );
                    if (Math.hypot(micro.dx, micro.dy) > 0.0005) {
                        const prevX = troop.gridX;
                        const prevY = troop.gridY;
                        troop.gridX = micro.x;
                        troop.gridY = micro.y;
                        if (this.getTargetEdgeDistance(troop, target) > geometry.stopRange) {
                            // Holding the slot beats sliding out of range.
                            troop.gridX = prevX;
                            troop.gridY = prevY;
                        } else {
                            const microPos = IsoUtils.cartToIso(troop.gridX, troop.gridY);
                            troop.gameObject.setPosition(microPos.x, microPos.y);
                            this.updateHealthBar(troop);
                            const troopDepth = Math.round(depthForTroop(troop.gridX, troop.gridY, troop.type));
                            if (troopDepth !== troop.lastDepth) {
                                troop.lastDepth = troopDepth;
                                troop.gameObject.setDepth(troopDepth);
                            }
                        }
                    }
                }
            } else {
                troop.velocityX = (troop.velocityX ?? 0) * 0.65;
                troop.velocityY = (troop.velocityY ?? 0) * 0.65;
            }

            if (!this.isOffScreen(troop.gridX, troop.gridY)) {
                this.redrawTroopWithMovement(troop, movedThisFrame);
            }
        }
    }


    private destroyBuilding(b: PlacedBuilding) {
        // SAFETY: Town Hall cannot be deleted by the player
        if (this.mode === 'HOME' && b.type === 'town_hall') {
            console.log("Cannot destroy Town Hall in HOME mode.");
            return;
        }

        const index = this.buildings.findIndex(x => x.id === b.id);
        if (index === -1) return;

        // During replay watch, combat simulation should never authoritatively remove buildings.
        // Only synced replay frames are allowed to do that.
        if (this.mode === 'REPLAY' && !this.isApplyingReplayFrame) {
            b.health = Math.max(1, b.health);
            b.isDestroyed = false;
            return;
        }

        if (b.isDestroyed) return;
        b.isDestroyed = true;
        if (this.mode === 'ATTACK' && b.owner === 'ENEMY') {
            this.replayDestroyedBuildings.set(b.id, { id: b.id, health: 0, isDestroyed: true });
        }
        // Baseline/catch-up replay frames rebuild mid-battle state on join:
        // those buildings fell long ago, so they come down silently (rubble
        // only) instead of every wreck detonating at once.
        const silent = this.isApplyingReplayBaseline;
        if (!silent) soundSystem.play('destroy');

        const info = BUILDINGS[b.type];
        if (!info) {
            if (b.graphics) b.graphics.destroy();
            if (b.baseGraphics) b.baseGraphics.destroy();
            if (b.barrelGraphics) b.barrelGraphics.destroy();
            if (b.rangeIndicator) b.rangeIndicator.destroy();
            if (b.healthBar) b.healthBar.destroy();
            this.buildings.splice(index, 1);
            this.invalidateCombatTopologyForRemoval(b);
            return;
        }

        // Remove any baked base from the ground layer so ruins can replace it.
        this.unbakeBuildingFromGround(b);

        // Cleanup graphics
        b.graphics.destroy();
        if (b.baseGraphics) b.baseGraphics.destroy();

        // Clean up prism laser if this is a prism tower
        if (b.type === 'prism') {
            this.cleanupPrismLaser(b);
        }

        // Clean up range indicator if this building was selected
        if (b.rangeIndicator) {
            b.rangeIndicator.destroy();
        }

        // ENTITY CLEANUP BEFORE DEATH FX. The FX body below is dozens of
        // tween/graphics calls; if any of them ever throws, the update()
        // bulkhead swallows the error and this method never resumes — with
        // the cleanup at the bottom that leaked a zombie building whose
        // health bar floated over the wreck for the rest of the battle.
        // Bookkeeping first, presentation second.
        if (b.barrelGraphics) b.barrelGraphics.destroy();
        b.healthBar.destroy();
        this.buildings.splice(index, 1);
        this.invalidateCombatTopologyForRemoval(b);

        // Wall visuals still need their neighbor joins refreshed; navigation
        // invalidation above already preserves each troop's real objective and
        // makes the new gap visible on the next plan.
        if (b.type === 'wall') {
            this.refreshWallNeighbors(b.gridX, b.gridY, b.owner);
            // A ramped wall going down releases the siege-tower ramp. The
            // tile is now fully open, so this is a pure removal — the
            // invalidation above already covers the replans.
            if (this.rampedWallsByOwner.PLAYER.delete(b.id) || this.rampedWallsByOwner.ENEMY.delete(b.id)) {
                for (const tower of this.troops) {
                    if (tower.parkedWallId === b.id) tower.parkedWallId = undefined;
                }
            }
        }

        const pos = IsoUtils.cartToIso(b.gridX + info.width / 2, b.gridY + info.height / 2);
        const size = Math.max(info.width, info.height);

        // Screen shake proportional to building size
        const shakeIntensity = (0.0015 + size * 0.001) * (this.mode === 'HOME' ? 0.2 : 1.0);
        if (!silent) this.cameras.main.shake(75 + size * 50, shakeIntensity);

        // Initial flash
        if (!silent) this.trackBattleFx(PixelFx.flash(this, pos.x, pos.y - 20, { r: 10 * size, color: 0xffffcc, alpha: 0.8, scaleTo: 2, life: 100, depth: 30001 }));

        // Rubble/debris chunks
        for (let i = 0; i < (silent ? 0 : 8 + size * 4); i++) {
            const angle = Math.random() * Math.PI * 2;
            const dist = 20 + Math.random() * 30 * size;
            const rubbleColors = [0x8b7355, 0x6b5344, 0x5a4a3a, 0x4a3a2a];
            const rubble = this.trackBattleFx(this.add.graphics());
            const rubbleSize = 3 + Math.random() * 5;
            pixelRect(rubble, -rubbleSize / 2, -rubbleSize / 2, rubbleSize, rubbleSize, rubbleColors[Math.floor(Math.random() * 4)], 1);
            rubble.setPosition(pos.x, pos.y - 15);
            rubble.setDepth(30000);

            const peakY = pos.y - 40 - Math.random() * 30 * size;
            this.tweens.add({
                targets: rubble,
                x: pos.x + Math.cos(angle) * dist,
                duration: 400 + Math.random() * 200,
                ease: 'Quad.easeOut'
            });
            this.tweens.add({
                targets: rubble,
                y: [peakY, pos.y + 5],
                duration: 400 + Math.random() * 200,
                ease: 'Quad.easeIn',
                onComplete: () => rubble.destroy()
            });
        }

        // Dust cloud (pixelated rectangles)
        for (let i = 0; i < (silent ? 0 : 6 + size * 2); i++) {
            this.scheduleBattleCall(i * 30, () => {
                const dustColors = [0x8b7355, 0x9b8365, 0x7b6345];
                const dustSize = 8 + Math.floor(Math.random() * 10);
                const dust = this.trackBattleFx(this.add.graphics());
                pixelRect(dust, -dustSize / 2, -dustSize / 2, dustSize, dustSize, dustColors[Math.floor(Math.random() * 3)], 0.6);
                dust.setPosition(pos.x + (Math.random() - 0.5) * 40 * size, pos.y - 10);
                dust.setDepth(29999);
                this.tweens.add({
                    targets: dust,
                    y: dust.y - 30 - Math.random() * 20,
                    x: dust.x + (Math.random() - 0.5) * 30,
                    scale: 2, alpha: 0,
                    duration: 600 + Math.random() * 300,
                    onComplete: () => dust.destroy()
                });
            });
        }

        // Type-specific effects
        if (!silent && b.type === 'town_hall') {
            // Massive fire and explosion (pixelated rectangles)
            for (let i = 0; i < 25; i++) {
                const delay = i * 40;
                this.scheduleBattleCall(delay, () => {
                    const fireColors = [0xff4400, 0xff6600, 0xff8800, 0xffaa00];
                    const fireSize = 8 + Math.floor(Math.random() * 15);
                    const fire = this.trackBattleFx(this.add.graphics());
                    pixelRect(fire, -fireSize / 2, -fireSize / 2, fireSize, fireSize, fireColors[Math.floor(Math.random() * 4)], 0.9);
                    fire.setPosition(pos.x + (Math.random() - 0.5) * 80, pos.y - 10 - (Math.random() * 40));
                    fire.setDepth(30000);
                    this.tweens.add({
                        targets: fire,
                        y: fire.y - 80,
                        scale: 0.3, alpha: 0,
                        duration: 500 + Math.random() * 300,
                        onComplete: () => fire.destroy()
                    });
                });
            }
        } else if (!silent && (b.type === 'cannon' || b.type === 'mortar' || b.type === 'tesla')) {
            // Sparks for defensive buildings
            for (let i = 0; i < 12; i++) {
                const spark = this.trackBattleFx(this.add.graphics());
                const len = 5 + Math.random() * 15;
                const angle = Math.random() * Math.PI * 2;
                pixelLine(spark, 0, 0, Math.cos(angle) * len, Math.sin(angle) * len, 1, b.type === 'tesla' ? 0x00ccff : 0xffaa00, 0.8);
                spark.setPosition(pos.x, pos.y - 15);
                spark.setDepth(30002);
                this.tweens.add({
                    targets: spark,
                    x: pos.x + (Math.random() - 0.5) * 50,
                    y: pos.y - 30 - Math.random() * 30,
                    alpha: 0,
                    duration: 200 + Math.random() * 200,
                    onComplete: () => spark.destroy()
                });
            }
        }

        // Create rubble at the building location (attack mode only)
        if (this.mode === 'ATTACK' || this.mode === 'REPLAY') {
            const info = BUILDINGS[b.type];
            if (info) {
                this.createRubble(b.gridX, b.gridY, info.width, info.height, b.type, b.level ?? 1);
            }
        }

        if (this.mode === 'ATTACK') {
            // Track destruction stats; loot is recomputed from the capped
            // pools × HP-weighted destruction inside updateBattleStats (the
            // server settlement's model), not banked per building.
            if (b.type !== 'wall') this.destroyedBuildings++;

            this.updateBattleStats();
            this.maybePushReplayFrame(true);

        } else {
            if (b.type === 'army_camp') {
                const campLevels = this.buildings.filter(bc => bc.type === 'army_camp').map(bc => bc.level ?? 1);
                gameManager.refreshCampCapacity(campLevels);
            }
            // Remove from backend when player building is deleted
            if (b.owner === 'PLAYER') {
                Backend.removeBuilding(this.userId, b.id);
                // The lane network may reclaim the freed ground.
                this.villageLife.invalidateStonePaths();
            }
        }
    }


    /**
     * The server's HP-weighted destruction% (simulation v2): structural
     * damage over ALL non-wall enemy buildings, partial damage included.
     * The count-based `currentDestructionPct` remains the HUD's headline
     * number; THIS one prices the loot exactly like the settlement does.
     */
    private hpWeightedDestructionPct(): number {
        if (this.initialEnemyScoringHP <= 0) return 0;
        const remaining = this.buildings.reduce((sum, b) => {
            if (b.owner !== 'ENEMY' || b.type === 'wall') return sum;
            return sum + Math.max(0, Math.min(b.health, b.maxHealth));
        }, 0);
        const dealt = Math.max(0, this.initialEnemyScoringHP - remaining);
        return Math.min(100, Math.round((dealt * 100) / this.initialEnemyScoringHP));
    }

    private updateBattleStats() {
        const { totalKnown } = this.getBattleTotals();
        const destruction = totalKnown > 0
            ? Math.min(100, Math.round((this.destroyedBuildings / totalKnown) * 100))
            : 0;
        // The loot counter mirrors the server settlement: capped pools ×
        // HP-weighted destruction% (floored), so the HUD number converges to
        // the real payout instead of drifting per destroyed building.
        if (this.mode === 'ATTACK' && this.battleLootPools) {
            const pct = this.hpWeightedDestructionPct();
            this.goldLooted = Math.floor(this.battleLootPools.gold * pct / 100);
            this.oreLooted = Math.floor(this.battleLootPools.ore * pct / 100);
            this.foodLooted = Math.floor(this.battleLootPools.food * pct / 100);
        }
        gameManager.updateBattleStats(destruction, this.goldLooted, this.oreLooted, this.foodLooted);
    }



    /**
     * The one gate for locally-simulated shot damage against troops. During
     * replay watch the frame stream owns every health value, so defense shots
     * stay visual-only there — mutating health would saw-tooth against each
     * frame sync. Returns whether the damage was applied (kill included).
     */
    private applyLocalTroopDamage(t: Troop, damage: number): boolean {
        if (this.mode === 'REPLAY') return false;
        t.health -= damage;
        t.hasTakenDamage = true;
        this.updateHealthBar(t);
        // Stone golem per-tick hit reaction (throttled inside; dies <300 ms).
        if (t.type === 'golem' && t.health > 0) this.showStoneGolemHitFx(t);
        // Ice golem hit reaction (throttled inside): chips of ice + frost puff.
        if (t.type === 'icegolem' && t.health > 0) this.emitIceGolemHitFx(t);
        // Pavise-redirected impact: the soak lands with a shield spark
        // (DefenseSystem armed guardFlareUntil when it swung the shot).
        if (t.health > 0 && (t.guardFlareUntil ?? 0) > this.time.now) {
            t.guardFlareUntil = 0;
            const sparkPos = IsoUtils.cartToIso(t.gridX, t.gridY);
            const sparkDepth = depthForTroop(t.gridX, t.gridY, t.type) + 0.5;
            this.trackBattleFx(PixelFx.flash(this, sparkPos.x - 3, sparkPos.y - 12, {
                r: 5, color: 0x9fd4ff, alpha: 0.9, scaleTo: 1.6, life: 160, depth: sparkDepth
            }));
            PixelFx.burst(this, sparkPos.x - 3, sparkPos.y - 12, {
                count: 4, colors: [0xcfe8ff, 0x2e6e8e], alpha: 0.9,
                r: 1.2, rJitter: 0.6, spread: 8, up: 5, upJitter: 3,
                life: 200, lifeJitter: 60, depth: sparkDepth + 0.1
            });
        }
        if (t.health <= 0) this.destroyTroop(t);
        return true;
    }

    private destroyTroop(t: Troop) {
        if (t.id === 'dummy_target') return; // Ignore dummy targets used for fun shooting

        // During replay watch, troop removals come from replay frame sync only.
        if (this.mode === 'REPLAY' && !this.isApplyingReplayFrame) {
            t.health = Math.max(1, t.health);
            t.hasTakenDamage = true;
            this.updateHealthBar(t);
            return;
        }

        // A troop can die mid attack/recoil tween — kill those before the game
        // object is destroyed so no orphaned tween keeps driving a dead target
        // (buildings already do this in their destroy path).
        this.tweens.killTweensOf(t.gameObject);

        // ENTITY CLEANUP BEFORE DEATH FX (mirrors destroyBuilding): the
        // per-type death effects below never resume if one of them throws —
        // the update() bulkhead swallows the error — and a dead troop left in
        // the array kept its last-drawn health bar floating at the corpse
        // site for the rest of the battle. Bar + roster bookkeeping first;
        // the branch-local repeats below are harmless no-ops after this.
        this.troops = this.troops.filter(x => x.id !== t.id);
        t.healthBar.destroy();

        // Kit bookkeeping (all death branches): healers tracking this troop
        // re-pick a leader; a parked siege tower RELEASES its ramp with a
        // PLAIN revision bump — losing a ramp CLOSES routes, so it must never
        // ride the removal-promotion path.
        this.invalidateSupportFollowers(t.id);
        if (t.parkedWallId) {
            this.rampedWallsByOwner[t.owner].delete(t.parkedWallId);
            t.parkedWallId = undefined;
            this.combatTopologyRevision++;
        }

        const pos = IsoUtils.cartToIso(t.gridX, t.gridY);

        // SHARED DETONATION BOOM (wallbreaker powder barrel / clockwork
        // beetle brass burst): one FX skeleton, per-type palette + scale.
        if (t.type === 'wallbreaker' || t.type === 'clockworkbeetle') {
            const isBeetle = t.type === 'clockworkbeetle';
            const ringMax = isBeetle ? 22 : 30;
            const ringColor = isBeetle ? 0xc9973a : 0xff6600;
            const washColor = isBeetle ? 0x8a6420 : 0xff4400;
            const ex = pos.x;
            const ey = pos.y - 5;

            // 1. Area damage ring — expanding ground circle showing blast
            // radius, REDRAWN per step (ring + interior wash) so the cells
            // stay 1.35px instead of scaling up ×4.
            const ring = this.trackBattleFx(this.add.graphics());
            ring.setPosition(ex, ey + 8);
            ring.setDepth(29999);
            const drawBlast = (p: number) => {
                ring.clear();
                const r = 10 + ringMax * p;
                const fade = 1 - p;
                this.pixelRing(ring, 0, 0, r, r / 2, 2, ringColor, 0.7 * fade); // isometric ellipse
                pixelEllipse(ring, 0, 0, r, r / 2, washColor, 0.15 * fade);
            };
            drawBlast(0);
            const blastState = { p: 0 };
            this.trackBattleFxTween(this.tweens.add({
                targets: blastState, p: 1,
                duration: 400, ease: 'Quad.easeOut',
                onUpdate: () => { if (ring.active) drawBlast(blastState.p); },
                onComplete: () => ring.destroy()
            }));

            // 2. Core flash — bright white/yellow burst
            const flash = this.trackBattleFx(this.add.graphics());
            pixelEllipse(flash, 0, 0, 6, 6, 0xffffff, 0.9);
            pixelEllipse(flash, 0, 0, 10, 10, 0xffff44, 0.7);
            flash.setPosition(ex, ey);
            flash.setDepth(30005);
            this.tweens.add({ targets: flash, scale: 2.5, alpha: 0, duration: 150, onComplete: () => flash.destroy() });

            // 3. Fireball — orange/red expanding ball
            const fireball = this.trackBattleFx(this.add.graphics());
            pixelEllipse(fireball, 0, 0, 10, 10, 0xff4400, 0.8);
            pixelEllipse(fireball, -2, -2, 6, 6, 0xff8800, 0.6);
            fireball.setPosition(ex, ey);
            fireball.setDepth(30003);
            this.tweens.add({ targets: fireball, scale: 2, alpha: 0, duration: 300, onComplete: () => fireball.destroy() });

            // 4. Screen shake
            this.cameras.main.shake(60, 0.003);

            // 5. Debris — barrel chunks + splinters (wallbreaker) or brass
            // gears + cogs (clockwork beetle)
            for (let i = 0; i < (isBeetle ? 10 : 14); i++) {
                const debrisAngle = Math.random() * Math.PI * 2;
                const debrisDist = 15 + Math.random() * 35;
                const debris = this.trackBattleFx(this.add.graphics());
                const isChunk = Math.random() > 0.4;
                if (isChunk) {
                    // Wood/barrel chunk — or a brass plate off the beetle
                    const chunkColors = isBeetle
                        ? [0x7a5c20, 0x9a7a30, 0xb08d3a]
                        : [0x5a3a1a, 0x6b4a2a, 0x8b6b4a];
                    pixelRect(debris, -1.5, -1, 3, 2 + Math.random() * 2, chunkColors[Math.floor(Math.random() * 3)], 0.9);
                } else {
                    // Metal band / stone bit — or a flying gear
                    const debrisR = 1 + Math.random() * 1.5;
                    const bitColors = isBeetle
                        ? [0xb08d3a, 0x7a5c20, 0x555555]
                        : [0x555555, 0x777777, 0x993300];
                    pixelEllipse(debris, 0, 0, debrisR, debrisR, bitColors[Math.floor(Math.random() * 3)], 0.9);
                    if (isBeetle) pixelRect(debris, -0.7, -0.7, 1.4, 1.4, 0x3a2c10, 0.9); // gear hub
                }
                debris.setPosition(ex, ey);
                debris.setDepth(30001);
                const arcHeight = -20 - Math.random() * 20;
                const endX = ex + Math.cos(debrisAngle) * debrisDist;
                const endY = ey + Math.sin(debrisAngle) * debrisDist * 0.5;
                const midX = (ex + endX) / 2;
                const midY = (ey + endY) / 2 + arcHeight;
                const dur = 350 + Math.random() * 250;
                // Arcing trajectory
                this.tweens.add({
                    targets: debris,
                    x: { value: midX, duration: dur * 0.5, ease: 'Sine.easeOut' },
                    duration: dur
                });
                this.tweens.add({
                    targets: debris,
                    x: { value: endX, duration: dur * 0.5, delay: dur * 0.5, ease: 'Sine.easeIn' },
                    duration: dur
                });
                this.tweens.add({
                    targets: debris,
                    y: [{ value: midY, duration: dur * 0.5, ease: 'Sine.easeOut' }, { value: endY, duration: dur * 0.5, ease: 'Sine.easeIn' }],
                    alpha: 0,
                    rotation: Math.random() * 6,
                    duration: dur,
                    onComplete: () => debris.destroy()
                });
            }

            // 6. Smoke puffs — multiple rising smoke clouds
            for (let i = 0; i < 4; i++) {
                const smoke = this.trackBattleFx(this.add.graphics());
                const smokeSize = 6 + Math.random() * 8;
                const smokeAlpha = 0.3 + Math.random() * 0.2;
                pixelEllipse(smoke, 0, 0, smokeSize, smokeSize, i < 2 ? 0x222222 : 0x444444, smokeAlpha);
                const offsetX = (Math.random() - 0.5) * 16;
                const offsetY = (Math.random() - 0.5) * 8;
                smoke.setPosition(ex + offsetX, ey + offsetY);
                smoke.setDepth(30000);
                this.tweens.add({
                    targets: smoke,
                    y: ey + offsetY - 25 - Math.random() * 15,
                    x: ex + offsetX + (Math.random() - 0.5) * 10,
                    scale: 2 + Math.random(),
                    alpha: 0,
                    duration: 600 + Math.random() * 400,
                    delay: i * 50,
                    onComplete: () => smoke.destroy()
                });
            }

            // 7. Sparks — small bright particles
            for (let i = 0; i < 6; i++) {
                const spark = this.trackBattleFx(this.add.graphics());
                pixelEllipse(spark, 0, 0, 1, 1, [0xffaa00, 0xff6600, 0xffff00][Math.floor(Math.random() * 3)], 1);
                spark.setPosition(ex, ey);
                spark.setDepth(30004);
                const sparkAngle = Math.random() * Math.PI * 2;
                const sparkDist = 20 + Math.random() * 25;
                this.tweens.add({
                    targets: spark,
                    x: ex + Math.cos(sparkAngle) * sparkDist,
                    y: ey + Math.sin(sparkAngle) * sparkDist * 0.5 - 10,
                    alpha: 0,
                    duration: 200 + Math.random() * 150,
                    onComplete: () => spark.destroy()
                });
            }

            // Remove troop and skip default death effects
            this.troops = this.troops.filter(x => x.id !== t.id);
            t.gameObject.destroy();
            t.healthBar.destroy();
            return;
        }

        // === GOLEM DEATH ANIMATION (stone + ice share the collapse hook) ===
        if (t.type === 'golem') {
            // THE BINDING FAILS — rune-bond flare, escaping sparks, then the
            // megaliths collapse into a brief cairn (shared with replay
            // watch via showReplayTroopDeath).
            this.playStoneGolemDeath(t);
            this.troops = this.troops.filter(x => x.id !== t.id);
            t.gameObject.destroy();
            t.healthBar.destroy();
            return; // Skip normal death effects
        }
        if (t.type === 'icegolem') {
            // GLACIAL SHATTER + FREEZE BURST — the Glacial Warden bursts
            // into ice and the released cold locks every enemy defense
            // within 2.5 tiles for 2.5 s (visuals shared with replay watch
            // via showReplayTroopDeath; the debuff is client battle-sim
            // only — server settlement ignores debuffs by design).
            this.troops = this.troops.filter(x => x.id !== t.id);
            t.gameObject.destroy();
            t.healthBar.destroy();

            this.showIceGolemShatterFx(t, pos);
            this.applyIceGolemFreezeBurst(t);

            return; // Skip normal death effects
        }
        // === END GOLEM DEATH ANIMATION ===

        // === PHALANX DEATH - Splits into 9 warriors ===
        if (t.type === 'phalanx') {
            // Flash effect
            this.trackBattleFx(PixelFx.flash(this, pos.x, pos.y, { r: 25, color: 0xffaa00, alpha: 0.8, scaleTo: 2, life: 300, depth: 30002 }));

            // Spawn 9 warriors in a 3x3 grid
            const offsets = [
                { dx: -0.5, dy: -0.5 }, { dx: 0, dy: -0.5 }, { dx: 0.5, dy: -0.5 },
                { dx: -0.5, dy: 0 }, { dx: 0, dy: 0 }, { dx: 0.5, dy: 0 },
                { dx: -0.5, dy: 0.5 }, { dx: 0, dy: 0.5 }, { dx: 0.5, dy: 0.5 }
            ];
            for (let i = 0; i < offsets.length; i++) {
                const off = offsets[i];
                this.pendingSpawnCount++;
                this.scheduleBattleCall(i * 30, () => { // Staggered spawn
                    this.spawnTroop(t.gridX + off.dx, t.gridY + off.dy, 'romanwarrior', t.owner, t.level || 1);
                    this.pendingSpawnCount--;
                });
            }

            // Debris dust (isometric oval)
            const dust = this.trackBattleFx(this.add.graphics());
            pixelEllipse(dust, 0, 0, 20, 10, 0x888888, 0.3);
            dust.setPosition(pos.x, pos.y);
            dust.setDepth(5);
            this.tweens.add({
                targets: dust,
                scale: 2.5, alpha: 0,
                duration: 800,
                onComplete: () => dust.destroy()
            });

            // Don't return - let normal death cleanup happen
        }

        // === DA VINCI TANK DEATH - Leaves deactivated husk ===
        if (t.type === 'davincitank') {
            const isPlayer = t.owner === 'PLAYER';

            // Remove the troop from active list
            this.troops = this.troops.filter(x => x.id !== t.id);
            t.gameObject.destroy();
            t.healthBar.destroy();

            // === SMOKE BURST to cover the transition ===
            // Create multiple small smoke puffs
            for (let i = 0; i < 8; i++) {
                const smoke = this.trackBattleFx(this.add.graphics());
                const smokeSize = 2 + Math.random() * 2;  // TINY (2-4px radius)
                // Very dark black smoke
                pixelEllipse(smoke, 0, 0, smokeSize, smokeSize, 0x1a1a1a, 0.85);
                const offsetX = (Math.random() - 0.5) * 15;  // Tight spread
                const offsetY = (Math.random() - 0.5) * 10 - 5;
                smoke.setPosition(pos.x + offsetX, pos.y + offsetY);
                smoke.setDepth(30000 + i);  // Above everything temporarily

                this.tweens.add({
                    targets: smoke,
                    scale: 1.5, alpha: 0,  // Minimal expansion
                    x: pos.x + offsetX + (Math.random() - 0.5) * 10,
                    y: pos.y + offsetY - 15 - Math.random() * 10,
                    duration: 1800 + Math.random() * 800,
                    delay: i * 50,
                    ease: 'Quad.easeOut',
                    onComplete: () => smoke.destroy()
                });
            }

            // Fire/explosion spark at center
            const spark = this.trackBattleFx(this.add.graphics());
            pixelEllipse(spark, 0, 0, 15, 15, 0xff6600, 0.8);
            spark.setPosition(pos.x, pos.y - 15);
            spark.setDepth(30010);
            this.tweens.add({
                targets: spark,
                scale: 2, alpha: 0,
                duration: 200,
                onComplete: () => spark.destroy()
            });

            // Create husk AFTER smoke starts (delayed slightly)
            this.scheduleBattleCall(100, () => {
                const husk = this.trackBattleFx(this.add.graphics());
                husk.setPosition(pos.x, pos.y);
                husk.setDepth(depthForTroop(t.gridX, t.gridY, t.type));

                // Baked 'deactivated' husk frame (per direction/level/owner);
                // vector fallback draws the real level + scene time — the
                // old call omitted both, reverting the husk to L1 colors.
                if (!SpriteBank.syncTroopPose(this, husk, 'davincitank', t.owner, t.level || 1, t.facingAngle || 0, 'deactivated')) {
                    TroopRenderer.drawDaVinciTank(husk, isPlayer, false, true, t.facingAngle || 0, t.level || 1, this.time.now);
                }

                // Small dust cloud on impact
                const dust = this.trackBattleFx(this.add.graphics());
                pixelEllipse(dust, 0, 0, 30, 30, 0x888888, 0.2);
                dust.setPosition(pos.x, pos.y + 10);
                dust.setDepth(4);
                this.tweens.add({
                    targets: dust,
                    scale: 2.5, alpha: 0, y: pos.y - 5,
                    duration: 2500,
                    ease: 'Quad.easeOut',
                    onComplete: () => dust.destroy()
                });

                // Fade out husk slowly over time
                this.tweens.add({
                    targets: husk,
                    alpha: 0,
                    duration: 20000,
                    delay: 15000,
                    onComplete: () => husk.destroy()
                });
            });

            return; // Skip normal death effects
        }
        // === END DA VINCI TANK DEATH ===
        // Death explosion effect (pixelated rectangle)
        const flash = this.trackBattleFx(this.add.graphics());
        flash.fillRect(-6, -6, 12, 12);
        flash.setPosition(pos.x, pos.y);
        flash.setDepth(30001);
        this.tweens.add({ targets: flash, scale: 2, alpha: 0, duration: 100, onComplete: () => flash.destroy() });

        // Particle burst (pixelated rectangles)
        const particleColors = t.type === 'warrior' ? [0xffff00, 0xffcc00] :
            t.type === 'archer' ? [0x00ccff, 0x0088cc] :
                [0xff8800, 0xcc6600];
        for (let i = 0; i < 8; i++) {
            const angle = (i / 8) * Math.PI * 2;
            const particle = this.trackBattleFx(this.add.graphics());
            pixelRect(particle, -3, -3, 6, 6, particleColors[i % 2], 0.9);
            particle.setPosition(pos.x, pos.y);
            particle.setDepth(30000);
            this.tweens.add({
                targets: particle,
                x: pos.x + Math.cos(angle) * 25,
                y: pos.y + Math.sin(angle) * 15 - 15,
                alpha: 0, scale: 0.3,
                duration: 250 + Math.random() * 100,
                ease: 'Quad.easeOut',
                onComplete: () => particle.destroy()
            });
        }

        // Smoke puff (pixelated rectangle)
        const smoke = this.trackBattleFx(this.add.graphics());
        pixelRect(smoke, -10, -10, 20, 20, 0x666666, 0.5);
        smoke.setPosition(pos.x, pos.y);
        smoke.setDepth(29999);
        this.tweens.add({
            targets: smoke,
            y: pos.y - 20,
            scale: 2, alpha: 0,
            duration: 400,
            onComplete: () => smoke.destroy()
        });

        this.troops = this.troops.filter(x => x.id !== t.id);
        t.gameObject.destroy();
        t.healthBar.destroy();
    }

    // ================= ICE GOLEM (Glacial Warden) FX KIT =================

    /** Ice family by owner — mirrors the IceGolem.ts palettes (player
     *  glacial cyan, enemy amethyst). */
    private iceGolemColors(owner: 'PLAYER' | 'ENEMY') {
        return owner === 'PLAYER'
            ? { chip: 0x9cc2d6, chipLit: 0xd2e6ee, core: 0x66e4ff, hot: 0xdcfaff, deep: 0x3a70a4 }
            : { chip: 0xac9cc2, chipLit: 0xe0d8e8, core: 0xce70f6, hot: 0xf2dcff, deep: 0x564288 };
    }

    /** Visual half of the ice golem death — THE GLACIER CALVES. Staged like
     *  playStoneGolemDeath: Stage 1 the frozen heart flares and the eye-
     *  lights wink out; Stage 2 the hewn bergs of the Warden's stack calve
     *  off and fall along arcs, each landing in a frost puff; Stage 3 the
     *  freeze front rolls out, shards and haze fly, and an icicle-spear
     *  eruption ring melts away with the rime patch. Deterministic from
     *  death time + troop id (stoneGolemFxRng). Presentation only —
     *  shared verbatim by destroyTroop and showReplayTroopDeath. */
    private showIceGolemShatterFx(t: Troop, pos: { x: number; y: number }) {
        const c = this.iceGolemColors(t.owner);
        const radiusPx = 2.5 * this.tileWidth * 0.5 * Math.SQRT2; // = the debuff radius
        const groundDepth = depthForGroundEffect(t.gridX, t.gridY);
        const baseDepth = depthForTroop(t.gridX, t.gridY, t.type);
        const groundY = pos.y + 12; // IceGolem GROUND_Y — the feet line
        const rng = this.stoneGolemFxRng(t.id, Math.floor(this.time.now));
        const fa = Number.isFinite(t.facingAngle) ? t.facingAngle : 0;
        const dirX = Math.cos(fa);
        const dirY = Math.sin(fa) * 0.5;

        // Impact weight: heavier than the old pop (stays under the frostfall
        // ceiling 130/0.0022), plus a delayed micro-thud as the torso berg
        // lands (playStoneGolemDeath precedent).
        this.cameras.main.shake(110, 0.0022);
        this.scheduleBattleCall(380, () => this.cameras.main.shake(40, 0.001));

        // --- Stage 1: the frozen heart lets go ------------------------------
        this.trackBattleFx(PixelFx.flash(this, pos.x, pos.y - 22, {
            r: 14, color: c.hot, alpha: 0.95, life: 220, scaleTo: 2.2, depth: 30004
        }));
        this.trackBattleFx(PixelFx.flash(this, pos.x, pos.y - 22, {
            r: 8, color: c.core, alpha: 0.85, life: 160, scaleTo: 1.4,
            blend: Phaser.BlendModes.ADD, depth: 30004
        }));
        // …and the cold eye-lights wink out at the keystone head.
        for (const eside of [-1, 1]) {
            this.trackBattleFx(PixelFx.flash(this,
                pos.x + dirX * 8 - Math.sin(fa) * 2.2 * eside,
                pos.y - 34 + dirY * 4 + Math.cos(fa) * 1.1 * eside, {
                r: 2.5, color: c.hot, alpha: 0.9, life: 140, scaleTo: 0.25,
                blend: Phaser.BlendModes.ADD, depth: baseDepth + 0.4
            }));
        }
        // Ground frost bloom under the collapse.
        this.trackBattleFx(PixelFx.flash(this, pos.x, groundY - 5, {
            r: 16, squash: 0.5, color: c.hot, alpha: 0.55, life: 320,
            scaleTo: 2.0, ease: 'Quad.easeOut', depth: groundDepth + 1
        }));

        // --- Stage 2: the bergs calve and fall -------------------------------
        // Hewn ice chunk: 3-tone berg (chip body, deep shadow facet, lit rim)
        // via whole-cell primitives; some pieces keep a dying inner light.
        const drawBerg = (g: Phaser.GameObjects.Graphics, rx: number, ry: number, slab: boolean, seed: number) => {
            if (slab) {
                pixelRect(g, -rx, -ry, rx * 2, ry * 2, c.chip, 1);
                pixelRect(g, -rx + 1.35, ry * 0.1, rx * 2 - 2.7, ry * 0.9, c.deep, 0.9);
                pixelRect(g, -rx + 1.35, -ry, rx * 2 - 2.7, Math.max(1.35, ry * 0.45), c.chipLit, 0.9);
            } else {
                pixelEllipse(g, 0, 0, rx, ry, c.chip, 1);
                pixelEllipse(g, rx * 0.28, ry * 0.32, rx * 0.55, ry * 0.5, c.deep, 0.9);
                pixelEllipse(g, -rx * 0.3, -ry * 0.38, rx * 0.42, ry * 0.36, c.chipLit, 0.9);
            }
            if (seed % 2 === 0) pixelRect(g, -1.35, -1.35, 2.7, 2.7, c.core, 0.35);
        };
        // Piece rig mirrors the Warden's stack (pelvis 15-24.6 / torso 24-44 /
        // capstones 38-48.5 / keystone head 40-55 / lintel fists low). dOff
        // keeps painter's order inside the character band.
        const pieces = [
            // keystone head + brow — topples forward along the facing
            { sx: dirX * 8, sy: -35 + dirY * 4, rx: 5.5, ry: 4.5, slab: false, landDx: dirX * 18, landDy: -3 + dirY * 6, fall: 300, delay: 40, dOff: 0.10 },
            // capstone shoulders — calve off either side
            { sx: -12, sy: -31, rx: 6.5, ry: 4, slab: true, landDx: -17, landDy: -3, fall: 280, delay: 100, dOff: 0.03 },
            { sx: 12, sy: -31, rx: 6.5, ry: 4, slab: true, landDx: 17, landDy: -2, fall: 270, delay: 130, dOff: 0.06 },
            // torso stele — the heaviest berg, drops onto the pelvis
            { sx: 0, sy: -22, rx: 11, ry: 6.5, slab: true, landDx: 2, landDy: -8, fall: 260, delay: 190, dOff: 0.02 },
            // pelvis block — barely falls
            { sx: 0, sy: -8, rx: 9, ry: 5.5, slab: false, landDx: 0, landDy: -5, fall: 180, delay: 250, dOff: 0.04 },
            // lintel fists — thud early either side
            { sx: 13 + dirX * 4, sy: 1, rx: 5.5, ry: 4, slab: true, landDx: 15 + dirX * 4, landDy: -2, fall: 130, delay: 60, dOff: 0.08 },
            { sx: -13 + dirX * 3, sy: 1.5, rx: 5, ry: 4, slab: false, landDx: -15 + dirX * 3, landDy: -2, fall: 120, delay: 80, dOff: 0.07 },
        ];
        pieces.forEach((piece, i) => {
            const g = this.trackBattleFx(this.add.graphics());
            drawBerg(g, piece.rx, piece.ry, piece.slab, i);
            g.setPosition(pos.x + piece.sx, pos.y + piece.sy);
            g.setDepth(baseDepth + piece.dOff);
            const landX = pos.x + piece.landDx + (rng() - 0.5) * 5;
            const landY = groundY + piece.landDy + (rng() - 0.5) * 2;
            this.tweens.add({
                targets: g, x: landX,
                duration: piece.fall, delay: piece.delay, ease: 'Sine.easeOut'
            });
            // fall → tiny bounce (yoyo) → settle, then the berg melts out
            this.tweens.add({
                targets: g, y: landY,
                duration: piece.fall, delay: piece.delay, ease: 'Quad.easeIn',
                onComplete: () => {
                    this.tweens.add({
                        targets: g, y: landY - 2, duration: 70, yoyo: true, ease: 'Quad.easeOut',
                        onComplete: () => {
                            this.tweens.add({
                                targets: g, alpha: 0,
                                delay: 800 + rng() * 400, duration: 700, ease: 'Quad.easeIn',
                                onComplete: () => g.destroy()
                            });
                        }
                    });
                }
            });
            // landfall frost puff
            this.scheduleBattleCall(piece.delay + piece.fall, () => {
                if (!g.active) return;
                PixelFx.burst(this, landX, landY + piece.ry * 0.7, {
                    count: 3, colors: [c.hot, 0xffffff], alpha: 0.55,
                    r: 1.3, rJitter: 0.7, spread: 11, up: 6, upJitter: 4,
                    life: 240, lifeJitter: 60, scaleTo: 1.7,
                    depth: groundDepth + 1, rng
                });
            });
        });

        // --- Stage 3: the released cold rolls out ----------------------------
        // Freeze front: an expanding iso ring out to the debuff radius, with
        // a fainter trailing ring — cold rolling across the ground.
        this.trackBattleFx(PixelFx.ring(this, pos.x, pos.y + 6, {
            r0: 8, r1: radiusPx, squash: 0.5, thick0: 3, thick1: 1.5,
            color: c.core, alpha: 0.85, life: 420, ease: 'Quad.easeOut',
            depth: groundDepth + 2
        }));
        this.trackBattleFx(PixelFx.ring(this, pos.x, pos.y + 6, {
            r0: 6, r1: radiusPx * 0.9, squash: 0.5, thick0: 2, thick1: 1,
            color: c.hot, alpha: 0.6, life: 460, delay: 90, ease: 'Quad.easeOut',
            depth: groundDepth + 1
        }));

        // Body shards: chunky berg fragments thrown outward and up...
        PixelFx.burst(this, pos.x, pos.y - 18, {
            count: 24, colors: [c.chipLit, c.chip, c.hot], square: true,
            r: 2.6, rJitter: 2, spread: 12, spreadY: 14,
            radial: 34, radialJitter: 12, ySquash: 0.5, up: 14, upJitter: 12,
            alpha: 0.95, life: 520, lifeJitter: 220, rot0: 0.6, spin: 2.4,
            depth: baseDepth + 1, rng
        });
        // ...and a fine frost haze that hangs, then settles.
        PixelFx.burst(this, pos.x, pos.y - 14, {
            count: 12, colors: [c.hot, 0xffffff, c.core],
            r: 1.4, rJitter: 0.8, spread: 20, spreadY: 12, up: 6, upJitter: 6,
            alpha: 0.75, life: 700, lifeJitter: 250, fadeDelay: 0.3,
            depth: groundDepth + 3, rng
        });

        // Icicle-spear eruption ring around the footprint — snaps up with
        // the freeze front, melts away with the rime patch (spear vocabulary
        // shared with applyDefenseFreezeVisual).
        const spears = this.trackBattleFx(this.add.graphics());
        const spearR = 24;
        for (let i = 0; i < 6; i++) {
            const ang = (i / 6) * Math.PI * 2 + 0.35 + (rng() - 0.5) * 0.3;
            const sxp = Math.cos(ang) * spearR;
            const syp = Math.sin(ang) * spearR * 0.5;
            const hgt = 8 + rng() * 4;
            pixelRect(spears, sxp - 1.6, syp - hgt, 3.2, hgt, c.chipLit, 0.95);
            pixelRect(spears, sxp - 0.6, syp - hgt - 2.5, 1.4, 3, c.hot, 0.95);
            pixelRect(spears, sxp + 0.2, syp - hgt + 1, 1, hgt - 2, c.deep, 0.6);
        }
        spears.setPosition(pos.x, groundY - 4);
        spears.setDepth(groundDepth + 2);
        spears.setAlpha(0);
        this.tweens.add({ targets: spears, alpha: 1, duration: 130, delay: 60 });
        this.tweens.add({
            targets: spears, alpha: 0, duration: 1400, delay: 900,
            ease: 'Quad.easeIn', onComplete: () => spears.destroy()
        });

        // Rime patch where the Warden stood — fades out over the freeze
        // window (tween rides the tracked graphics, so the sweep reaches it).
        const rime = this.trackBattleFx(this.add.graphics());
        pixelEllipse(rime, 0, 0, 26, 13, c.hot, 0.4);
        pixelEllipse(rime, 0, 0, 17, 8.5, 0xffffff, 0.3);
        this.pixelRing(rime, 0, 0, 24, 12, 1, c.core, 0.5);
        rime.setPosition(pos.x, pos.y + 6);
        rime.setDepth(groundDepth);
        this.tweens.add({
            targets: rime, alpha: 0, duration: 2100, delay: 400,
            ease: 'Quad.easeIn', onComplete: () => rime.destroy()
        });
    }

    /** Mechanical half of the freeze-on-death: every enemy DEFENSE within
     *  2.5 tiles holds fire for 2.5 s (DefenseSystem skips frozen defenses
     *  entirely) and gets the icy dressing. Deterministic — pure grid-radius
     *  test, no RNG. Client battle sim + presentation only: the server's
     *  settlement simulation ignores debuffs by design, so replay watch may
     *  apply it too (there it merely silences the locally-generated defense
     *  FX; the frame stream owns the sim). */
    private applyIceGolemFreezeBurst(t: Troop) {
        const radiusTiles = 2.5;
        const freezeMs = 2500;
        const now = this.time.now;
        for (const b of this.buildings) {
            if (b.owner === t.owner || b.health <= 0 || b.isDestroyed) continue;
            if (!(b.type in DEFENSE_BEHAVIOR_CATALOG)) continue; // only firing defenses freeze
            const info = BUILDINGS[b.type];
            if (!info) continue;
            const bdx = (b.gridX + info.width / 2) - t.gridX;
            const bdy = (b.gridY + info.height / 2) - t.gridY;
            if (Math.hypot(bdx, bdy) > radiusTiles) continue;

            b.frozenUntil = Math.max(b.frozenUntil ?? 0, now + freezeMs);
            if (b.type === 'prism') this.cleanupPrismLaser(b); // kill a live beam instantly
            this.applyDefenseFreezeVisual(b, t.owner);
        }
    }

    /** Icy dressing for one frozen defense: frost tint on the baked body
     *  sprite plus a tracked overlay (rime ring + ice spears + glints) at
     *  the building's footprint. updateFrozenDefenses thaws it. */
    private applyDefenseFreezeVisual(b: PlacedBuilding, golemOwner: 'PLAYER' | 'ENEMY') {
        const c = this.iceGolemColors(golemOwner);
        const info = BUILDINGS[b.type];
        const center = IsoUtils.cartToIso(b.gridX + info.width / 2, b.gridY + info.height / 2);

        SpriteBank.setCarrierTint(b.graphics, 0xb4e2ff);

        b.frostOverlay?.destroy(); // re-freeze: replace the dressing
        const overlay = this.trackBattleFx(this.add.graphics());
        const rx = (info.width * 0.5 + 0.35) * this.tileWidth * 0.5 * Math.SQRT2;
        // rime ring hugging the footprint
        this.pixelRing(overlay, 0, 0, rx, rx * 0.5, 1.5, c.hot, 0.75);
        this.pixelRing(overlay, 0, 0, rx * 0.8, rx * 0.4, 1, 0xffffff, 0.4);
        // ice spears jutting from the ground around the base (fixed angles)
        for (let i = 0; i < 4; i++) {
            const ang = (i / 4) * Math.PI * 2 + 0.5;
            const sx = Math.cos(ang) * rx * 0.75;
            const sy = Math.sin(ang) * rx * 0.75 * 0.5;
            const hgt = 7 + (i % 2) * 3;
            pixelRect(overlay, sx - 1.6, sy - hgt, 3.2, hgt, c.chipLit, 0.95);
            pixelRect(overlay, sx - 0.6, sy - hgt - 2.5, 1.4, 3, c.hot, 0.95);
            pixelRect(overlay, sx + 0.2, sy - hgt + 1, 1, hgt - 2, c.deep, 0.6);
        }
        // static frost glints on the body
        pixelRect(overlay, -4, -14, 1.5, 1.5, 0xffffff, 0.9);
        pixelRect(overlay, 5, -20, 1.5, 1.5, c.hot, 0.85);
        overlay.setPosition(center.x, center.y);
        overlay.setDepth(b.graphics.depth + 2);
        overlay.setAlpha(0);
        this.tweens.add({ targets: overlay, alpha: 1, duration: 120 });

        // freeze snap: small crystallizing pop at the building
        this.trackBattleFx(PixelFx.flash(this, center.x, center.y - 8, {
            r: 9, color: c.hot, alpha: 0.7, life: 180, scaleTo: 1.8, depth: b.graphics.depth + 3
        }));

        b.frostOverlay = overlay;
    }

    /** Thaw pass, run each combat frame just before the defense tick:
     *  expired (or destroyed) frozen defenses drop the tint and their
     *  overlay melts away with a drip of motes. Self-heals any state the
     *  epoch-guarded timers could miss at battle end. */
    private updateFrozenDefenses(time: number) {
        for (const b of this.buildings) {
            if (b.frozenUntil === undefined) continue;
            if (time < b.frozenUntil && b.health > 0 && !b.isDestroyed) continue;

            b.frozenUntil = undefined;
            SpriteBank.setCarrierTint(b.graphics, null);
            const overlay = b.frostOverlay;
            b.frostOverlay = undefined;
            if (overlay && overlay.active) {
                this.tweens.add({
                    targets: overlay, alpha: 0, duration: 260,
                    onComplete: () => overlay.destroy()
                });
                if (b.health > 0 && !b.isDestroyed) {
                    // melt drip on a clean thaw (a destroyed building's own
                    // wreck FX owns the moment instead)
                    PixelFx.burst(this, overlay.x, overlay.y - 4, {
                        count: 5, colors: [0xffffff, 0xdcfaff],
                        r: 1.2, rJitter: 0.6, spread: 10, spreadY: 5,
                        up: -8, upJitter: 4, alpha: 0.7, life: 320, lifeJitter: 100,
                        depth: overlay.depth
                    });
                }
            }
        }
    }

    /** On-hit reaction for the ice golem — chips of ice and a frost puff
     *  where the shot lands. Throttled per troop so continuous-beam damage
     *  ticks don't strobe. Fire-and-forget one-shots (Math.random allowed). */
    private emitIceGolemHitFx(t: Troop) {
        const now = this.time.now;
        if (now - (t.frostHitFxAt ?? 0) < 160) return;
        t.frostHitFxAt = now;
        const pos = IsoUtils.cartToIso(t.gridX, t.gridY);
        const c = this.iceGolemColors(t.owner);
        const depth = depthForTroop(t.gridX, t.gridY, t.type) + 1;
        PixelFx.burst(this, pos.x, pos.y - 24, {
            count: 5, colors: [c.chipLit, c.chip, c.hot], square: true,
            r: 1.6, rJitter: 1, spread: 9, spreadY: 7,
            up: -12, upJitter: 10, speed: 10,
            alpha: 0.95, life: 300, lifeJitter: 120, rot0: 0.4, spin: 1.6,
            depth
        });
        this.trackBattleFx(PixelFx.flash(this, pos.x, pos.y - 24, {
            r: 5, color: c.hot, alpha: 0.5, life: 140, scaleTo: 1.6, depth
        }));
    }

    private showGolemCrackEffect(x: number, y: number, radiusTiles: number = 3) {
        // STONE GOLEM SLAM IMPACT — mineral, no faction glow (the baked slam
        // pose already carries the rune flare at the fists): a dust
        // shockfront over the damage radius, radiating ground cracks grown by
        // stepped redraw, and thrown stone chips.
        const radiusPx = radiusTiles * this.tileWidth * 0.5 * Math.SQRT2;
        const grid = IsoUtils.isoToCart(x, y);
        const groundDepth = depthForGroundEffect(grid.x, grid.y);
        const rng = this.stoneGolemFxRng(`slam:${Math.round(x)}:${Math.round(y)}`, 0x51a3);

        // Dust shockfront expanding to the damage radius.
        this.trackBattleFx(PixelFx.ring(this, x, y, {
            r0: 8, r1: radiusPx, squash: 0.5, thick0: 2, thick1: 1,
            color: 0x9b8f7a, alpha: 0.5, life: 380, ease: 'Quad.easeOut',
            fadePow: 1.6, depth: groundDepth + 1
        }));
        // Central dust bloom right under the fists.
        this.trackBattleFx(PixelFx.flash(this, x, y, {
            r: 13, squash: 0.45, color: 0xa89b8d, alpha: 0.5,
            life: 260, scaleTo: 1.8, ease: 'Quad.easeOut', depth: groundDepth
        }));
        // Thrown stone chips, iso-squashed radially.
        PixelFx.burst(this, x, y, {
            count: 10, square: true, colors: [0x94917f, 0x655f4f, 0xb4b1a1],
            r: 1.6, rJitter: 1, radial: radiusPx * 0.4, radialJitter: radiusPx * 0.3,
            ySquash: 0.5, up: 12, upJitter: 8, life: 320, lifeJitter: 140,
            scaleTo: 0.5, ease: 'Quad.easeOut', depth: groundDepth + 2, rng
        });

        // Radiating cracks: jagged polylines grown outward over the first
        // ~240 ms of the tween, held, then faded — REDRAWN per step so the
        // cells stay 1.35 px (never a scale tween).
        const g = this.trackBattleFx(this.add.graphics());
        g.setPosition(x, y);
        g.setDepth(groundDepth + 1.5);
        const cracks: Array<Array<{ px: number; py: number }>> = [];
        const arms = 6;
        for (let i = 0; i < arms; i++) {
            let ang = (i / arms) * Math.PI * 2 + (rng() - 0.5) * 0.8;
            let reach = 0;
            const line = [{ px: 0, py: 0 }];
            for (let s = 0; s < 3; s++) {
                reach += radiusPx * (0.17 + rng() * 0.13);
                ang += (rng() - 0.5) * 0.7;
                line.push({ px: Math.cos(ang) * reach, py: Math.sin(ang) * reach * 0.5 });
            }
            cracks.push(line);
        }
        const drawCracks = (p: number) => {
            g.clear();
            const grow = Math.min(1, p / 0.3);
            const fade = p < 0.5 ? 1 : 1 - (p - 0.5) / 0.5;
            for (const line of cracks) {
                const segs = line.length - 1;
                for (let s = 0; s < segs; s++) {
                    const segP = Math.max(0, Math.min(1, grow * segs - s));
                    if (segP <= 0) break;
                    const a = line[s], b = line[s + 1];
                    pixelLine(g, a.px, a.py,
                        a.px + (b.px - a.px) * segP, a.py + (b.py - a.py) * segP,
                        s === 0 ? 2 : 1, 0x3a342c, 0.7 * fade);
                }
            }
        };
        drawCracks(0);
        // Progress rides ON the graphics so killTweensOf(g) — and therefore
        // the battle-FX sweep — reaches this tween (PixelFx.flash pattern).
        const carrier = g as Phaser.GameObjects.Graphics & { fxProgress: number };
        carrier.fxProgress = 0;
        this.tweens.add({
            targets: carrier, fxProgress: 1, duration: 800, ease: 'Linear',
            onUpdate: () => { if (g.active) drawCracks(carrier.fxProgress); },
            onComplete: () => g.destroy()
        });
    }

    /** ICE GOLEM SLAM IMPACT — the overhead glacier crush lands: a frost
     *  shockfront over the damage radius, radiating RIME fissures (pale,
     *  crystalline — grown by stepped redraw like the stone cracks) and
     *  thrown ice chips. Modelled line-for-line on showGolemCrackEffect —
     *  same depths, same envelope, same damage tick — but speaking the
     *  iceGolemColors vocabulary so the two golems' attacks read apart. */
    private showIceGolemCrackEffect(x: number, y: number, radiusTiles: number, owner: 'PLAYER' | 'ENEMY') {
        const c = this.iceGolemColors(owner);
        const radiusPx = radiusTiles * this.tileWidth * 0.5 * Math.SQRT2;
        const grid = IsoUtils.isoToCart(x, y);
        const groundDepth = depthForGroundEffect(grid.x, grid.y);
        const rng = this.stoneGolemFxRng(`iceslam:${Math.round(x)}:${Math.round(y)}`, 0x1ce5);

        // Frost shockfront expanding to the damage radius.
        this.trackBattleFx(PixelFx.ring(this, x, y, {
            r0: 8, r1: radiusPx, squash: 0.5, thick0: 2, thick1: 1,
            color: c.core, alpha: 0.55, life: 380, ease: 'Quad.easeOut',
            fadePow: 1.6, depth: groundDepth + 1
        }));
        // Central cold bloom right under the joined fists.
        this.trackBattleFx(PixelFx.flash(this, x, y, {
            r: 13, squash: 0.45, color: c.hot, alpha: 0.55,
            life: 260, scaleTo: 1.8, ease: 'Quad.easeOut', depth: groundDepth
        }));
        // Thrown ice chips, iso-squashed radially.
        PixelFx.burst(this, x, y, {
            count: 10, square: true, colors: [c.chipLit, c.chip, c.hot],
            r: 1.6, rJitter: 1, radial: radiusPx * 0.4, radialJitter: radiusPx * 0.3,
            ySquash: 0.5, up: 12, upJitter: 8, life: 320, lifeJitter: 140,
            scaleTo: 0.5, ease: 'Quad.easeOut', depth: groundDepth + 2, rng
        });

        // Radiating rime fissures: pale crystalline polylines grown outward
        // over the first ~240 ms, held, then faded — REDRAWN per step so the
        // cells stay 1.35 px (never a scale tween).
        const g = this.trackBattleFx(this.add.graphics());
        g.setPosition(x, y);
        g.setDepth(groundDepth + 1.5);
        const fissures: Array<Array<{ px: number; py: number }>> = [];
        const arms = 6;
        for (let i = 0; i < arms; i++) {
            let ang = (i / arms) * Math.PI * 2 + (rng() - 0.5) * 0.8;
            let reach = 0;
            const line = [{ px: 0, py: 0 }];
            for (let sSeg = 0; sSeg < 3; sSeg++) {
                reach += radiusPx * (0.17 + rng() * 0.13);
                ang += (rng() - 0.5) * 0.7;
                line.push({ px: Math.cos(ang) * reach, py: Math.sin(ang) * reach * 0.5 });
            }
            fissures.push(line);
        }
        const drawFissures = (p: number) => {
            g.clear();
            const grow = Math.min(1, p / 0.3);
            const fade = p < 0.5 ? 1 : 1 - (p - 0.5) / 0.5;
            for (const line of fissures) {
                const segs = line.length - 1;
                for (let sSeg = 0; sSeg < segs; sSeg++) {
                    const segP = Math.max(0, Math.min(1, grow * segs - sSeg));
                    if (segP <= 0) break;
                    const a = line[sSeg], b = line[sSeg + 1];
                    pixelLine(g, a.px, a.py,
                        a.px + (b.px - a.px) * segP, a.py + (b.py - a.py) * segP,
                        sSeg === 0 ? 2 : 1, c.hot, 0.65 * fade);
                }
            }
        };
        drawFissures(0);
        // Progress rides ON the graphics so killTweensOf(g) — and therefore
        // the battle-FX sweep — reaches this tween (PixelFx.flash pattern).
        const carrier = g as Phaser.GameObjects.Graphics & { fxProgress: number };
        carrier.fxProgress = 0;
        this.tweens.add({
            targets: carrier, fxProgress: 1, duration: 800, ease: 'Linear',
            onUpdate: () => { if (g.active) drawFissures(carrier.fxProgress); },
            onComplete: () => g.destroy()
        });
    }

    // ============== STONE GOLEM FX (clean-room redesign, 2026-07) ==========
    // Styled to GolemC "The Runebound Cairn": five hewn megaliths held
    // together only by a glowing faction-colored rune-bond. The FX vocabulary
    // is chipped stone, mineral dust, and that bond's glow — hit ticks chip
    // the stone and make the seam flicker; death is the BINDING FAILING
    // (flare, sparks escape, orbit motes drop) and then the megaliths
    // collapsing into a brief cairn of rubble.

    /** GolemC's stone + glow palette, mirrored for FX use. */
    private stoneGolemFxPalette(isPlayer: boolean, troopLevel: number) {
        const glow = isPlayer ? 0x6fd0ff : 0xff9440;
        const core = isPlayer ? 0xdff4ff : 0xffe6c0;
        const level = Math.max(1, Math.min(3, Math.floor(troopLevel || 1)));
        if (level >= 3) {
            return isPlayer
                ? { base: 0xbfb49a, dark: 0x8d8164, lite: 0xd8cfb6, glow, core }
                : { base: 0xb1a286, dark: 0x80725a, lite: 0xc9bda3, glow, core };
        }
        if (level === 2) {
            return isPlayer
                ? { base: 0x83837d, dark: 0x585853, lite: 0xa2a29b, glow, core }
                : { base: 0x7c7064, dark: 0x524940, lite: 0x998c80, glow, core };
        }
        return isPlayer
            ? { base: 0x94917f, dark: 0x655f4f, lite: 0xb4b1a1, glow, core }
            : { base: 0x8c7f70, dark: 0x5e5245, lite: 0xa89b8d, glow, core };
    }

    /** Deterministic RNG (mulberry32 seeded from a string + salt) so golem FX
     *  replay identically from death time + troop seed. */
    private stoneGolemFxRng(seedStr: string, salt: number): () => number {
        let h = salt >>> 0;
        for (let i = 0; i < seedStr.length; i++) {
            h = Math.imul(h ^ seedStr.charCodeAt(i), 2654435761);
        }
        return () => {
            h = (h + 0x6d2b79f5) | 0;
            let z = Math.imul(h ^ (h >>> 15), 1 | h);
            z = (z + Math.imul(z ^ (z >>> 7), 61 | z)) ^ z;
            return ((z ^ (z >>> 14)) >>> 0) / 4294967296;
        };
    }

    /** Stone golem per-damage-tick reaction: a couple of stone chips knocked
     *  loose plus a flicker of the rune-bond seam. Throttled per troop so
     *  burst-fire defenses don't stack it; everything dies within 300 ms. */
    private showStoneGolemHitFx(t: Troop) {
        const now = this.time.now;
        const carrier = t as Troop & { __stoneHitFxAt?: number };
        if (now - (carrier.__stoneHitFxAt ?? -1e9) < 90) return;
        carrier.__stoneHitFxAt = now;

        const pos = IsoUtils.cartToIso(t.gridX, t.gridY);
        const pal = this.stoneGolemFxPalette(t.owner === 'PLAYER', t.level || 1);
        const depth = depthForTroop(t.gridX, t.gridY, t.type) + 0.5;
        const rng = this.stoneGolemFxRng(t.id, Math.floor(now));

        // Chipped stone motes knocked off the struck body, falling.
        PixelFx.burst(this, pos.x, pos.y - 16, {
            count: 3, square: true, colors: [pal.base, pal.dark, pal.lite],
            r: 1.5, rJitter: 0.8, spread: 14, spreadY: 10,
            speed: 16, up: -9, upJitter: -7,
            life: 240, lifeJitter: 50, scaleTo: 0.6, ease: 'Quad.easeIn',
            depth, rng
        });
        // The rune-bond seam flickers as the binding absorbs the blow.
        this.trackBattleFx(PixelFx.flash(this, pos.x, pos.y - 22, {
            r: 6, squash: 0.4, color: pal.glow, alpha: 0.5,
            life: 140, scaleTo: 1.3, depth, blend: Phaser.BlendModes.ADD
        }));
    }

    /** THE BINDING FAILS — staged stone golem collapse, shared by the live
     *  death path (destroyTroop) and replay watch (showReplayTroopDeath).
     *  Stage 1: the rune-bond flares out, its sparks escape upward and the
     *  orbiting gravel motes drop from the field. Stage 2: the megaliths
     *  fall — head-stone topples along the facing, capstone slides off,
     *  torso drops onto the pelvis, the fists thud — each landing in a dust
     *  puff. Stage 3: the cairn of rubble settles and fades. Purely visual
     *  (tracked graphics/tweens only, no sim mutation), deterministic from
     *  death time + the troop id. */
    private playStoneGolemDeath(t: Troop) {
        const pos = IsoUtils.cartToIso(t.gridX, t.gridY);
        const isPlayer = t.owner === 'PLAYER';
        const pal = this.stoneGolemFxPalette(isPlayer, t.level || 1);
        const level = Math.max(1, Math.min(3, Math.floor(t.level || 1)));
        const rng = this.stoneGolemFxRng(t.id, Math.floor(this.time.now));
        const baseDepth = depthForTroop(t.gridX, t.gridY, t.type);
        const groundDepth = depthForGroundEffect(t.gridX, t.gridY);
        const groundY = pos.y + 11; // GolemC GROUND_Y — the feet line
        const fa = Number.isFinite(t.facingAngle) ? t.facingAngle : 0;
        const dirX = Math.cos(fa);
        const dirY = Math.sin(fa) * 0.5;

        // --- Stage 1: the rune-bond flares and snaps -----------------------
        this.trackBattleFx(PixelFx.flash(this, pos.x, pos.y - 23, {
            r: 15, squash: 0.32, color: pal.glow, alpha: 0.75,
            life: 220, scaleTo: 1.5, blend: Phaser.BlendModes.ADD, depth: baseDepth + 0.3
        }));
        this.trackBattleFx(PixelFx.flash(this, pos.x, pos.y - 23, {
            r: 8, squash: 0.32, color: pal.core, alpha: 0.8,
            life: 160, scaleTo: 1.2, blend: Phaser.BlendModes.ADD, depth: baseDepth + 0.35
        }));
        // The eye-light winks out at the head-stone.
        this.trackBattleFx(PixelFx.flash(this, pos.x + dirX * 9, pos.y - 29 + dirY * 4, {
            r: 3, color: pal.core, alpha: 0.9, life: 130, scaleTo: 0.3,
            blend: Phaser.BlendModes.ADD, depth: baseDepth + 0.4
        }));
        // The binding escapes upward as rune sparks…
        PixelFx.burst(this, pos.x, pos.y - 22, {
            count: 7, colors: [pal.glow, pal.core], r: 1.2, rJitter: 0.8,
            spread: 20, spreadY: 6, speed: 10, up: 30, upJitter: 16,
            life: 460, lifeJitter: 140, scaleTo: 0.4, ease: 'Quad.easeOut',
            blend: Phaser.BlendModes.ADD, depth: baseDepth + 0.45, rng
        });
        // …and the orbiting gravel motes lose the field and scatter down.
        PixelFx.burst(this, pos.x, pos.y - 20, {
            count: 3, colors: [pal.base, pal.dark], r: 1.8, rJitter: 0.6,
            ringAngles: true, radial: 24, radialJitter: 8, ySquash: 0.5,
            up: -6, upJitter: -10, life: 380, lifeJitter: 80,
            scaleTo: 0.7, ease: 'Quad.easeIn', depth: baseDepth + 0.2, rng
        });

        // --- Stage 2: the megaliths fall ------------------------------------
        // Hewn chunk: 3-tone stone (base body, SE dark facet, NW light rim)
        // via whole-cell primitives; some pieces keep a faint dead rune scar.
        const drawChunk = (g: Phaser.GameObjects.Graphics, rx: number, ry: number, slab: boolean, seed: number) => {
            if (slab) {
                pixelRect(g, -rx, -ry, rx * 2, ry * 2, pal.base, 1);
                pixelRect(g, -rx + 1.35, ry * 0.1, rx * 2 - 2.7, ry * 0.9, pal.dark, 0.9);
                pixelRect(g, -rx + 1.35, -ry, rx * 2 - 2.7, Math.max(1.35, ry * 0.45), pal.lite, 0.9);
                if (level >= 2) {
                    // iron clamp (L2) / gold bond ring (L3) survives on the slab
                    pixelRect(g, -rx + 2.7, -0.7, rx * 2 - 5.4, 1.4, level >= 3 ? 0xdaa520 : 0x474b52, 0.9);
                }
            } else {
                pixelEllipse(g, 0, 0, rx, ry, pal.base, 1);
                pixelEllipse(g, rx * 0.28, ry * 0.32, rx * 0.55, ry * 0.5, pal.dark, 0.9);
                pixelEllipse(g, -rx * 0.3, -ry * 0.38, rx * 0.42, ry * 0.36, pal.lite, 0.9);
            }
            if (seed % 2 === 0) pixelRect(g, -1.35, -1.35, 2.7, 2.7, pal.glow, 0.25);
        };
        // Piece rig mirrors GolemC's stack (pelvis 17 / torso 31 / cap 45 /
        // head 42 / fists ~7 above the feet). dOff keeps painter's order
        // inside the character band: torso lies ON the pelvis, head lands
        // furthest forward.
        const pieces = [
            { sx: dirX * 10, sy: -31 + dirY * 5, rx: 6, ry: 5, slab: false, landDx: dirX * 16, landDy: -3 + dirY * 6, fall: 300, delay: 40, dOff: 0.10 },
            { sx: 0, sy: -34, rx: 13, ry: 4.5, slab: true, landDx: -9 - dirX * 3, landDy: -4, fall: 320, delay: 110, dOff: 0.02 },
            { sx: 0, sy: -20, rx: 10.5, ry: 6, slab: true, landDx: 3, landDy: -8, fall: 270, delay: 190, dOff: 0.08 },
            { sx: 0, sy: -6, rx: 10, ry: 7, slab: false, landDx: 0, landDy: -5, fall: 190, delay: 260, dOff: 0.04 },
            { sx: 10 + dirX * 6, sy: 2, rx: 6, ry: 4.5, slab: true, landDx: 12 + dirX * 6, landDy: -2, fall: 140, delay: 60, dOff: 0.06 },
            { sx: -10 + dirX * 4, sy: 3, rx: 5.5, ry: 4.5, slab: false, landDx: -13 + dirX * 4, landDy: -2, fall: 130, delay: 90, dOff: 0.05 },
        ];
        pieces.forEach((piece, i) => {
            const g = this.trackBattleFx(this.add.graphics());
            drawChunk(g, piece.rx, piece.ry, piece.slab, i);
            g.setPosition(pos.x + piece.sx, pos.y + piece.sy);
            g.setDepth(baseDepth + piece.dOff);
            const landX = pos.x + piece.landDx + (rng() - 0.5) * 5;
            const landY = groundY + piece.landDy + (rng() - 0.5) * 2;
            this.tweens.add({
                targets: g, x: landX,
                duration: piece.fall, delay: piece.delay, ease: 'Sine.easeOut'
            });
            // fall → tiny bounce (yoyo) → settle, then the rubble fades out
            this.tweens.add({
                targets: g, y: landY,
                duration: piece.fall, delay: piece.delay, ease: 'Quad.easeIn',
                onComplete: () => {
                    this.tweens.add({
                        targets: g, y: landY - 2.5,
                        duration: 75, yoyo: true, ease: 'Quad.easeOut',
                        onComplete: () => {
                            this.tweens.add({
                                targets: g, alpha: 0,
                                delay: 900 + rng() * 400, duration: 800, ease: 'Quad.easeIn',
                                onComplete: () => g.destroy()
                            });
                        }
                    });
                }
            });
            // landfall dust puff
            this.scheduleBattleCall(piece.delay + piece.fall, () => {
                if (!g.active) return;
                PixelFx.burst(this, landX, landY + piece.ry * 0.7, {
                    count: 3, square: true, colors: [0x6f6552, 0x554c3e], alpha: 0.45,
                    r: 1.4, rJitter: 0.8, spread: 12, up: 7, upJitter: 5,
                    life: 220, lifeJitter: 60, scaleTo: 1.7,
                    depth: groundDepth + 1, rng
                });
            });
        });

        // --- Stage 3: the cairn settles -------------------------------------
        this.scheduleBattleCall(430, () => {
            this.trackBattleFx(PixelFx.ring(this, pos.x, groundY - 2, {
                r0: 6, r1: 30, squash: 0.5, thick0: 2, thick1: 1,
                color: 0x9b8f7a, alpha: 0.4, life: 420, ease: 'Quad.easeOut',
                fadePow: 1.5, depth: groundDepth
            }));
            PixelFx.burst(this, pos.x, groundY - 4, {
                count: 5, colors: [0x7d7361, 0x6f6552], alpha: 0.28,
                r: 2, rJitter: 1.2, spread: 30, spreadY: 10, up: 8,
                life: 700, lifeJitter: 300, scaleTo: 1.6,
                depth: groundDepth + 1, rng
            });
        });
        // heaviest landfall (the torso megalith) — a tiny ground thud
        this.scheduleBattleCall(460, () => this.cameras.main.shake(40, 0.001));
    }

    public spawnTroop(
        gx: number,
        gy: number,
        type: TroopType = 'warrior',
        owner: 'PLAYER' | 'ENEMY' = 'PLAYER',
        troopLevelOverride?: number
    ): Troop | null {
        // Bounds check - Relaxed for deployment margin
        const margin = 2;
        if (gx < -margin || gy < -margin || gx >= this.mapSize + margin || gy >= this.mapSize + margin) {
            return null;
        }
        const troopLevel = Math.max(1, Math.floor(troopLevelOverride ?? this.getTroopLevelForOwner(owner)));
        const stats = getTroopStats(type, troopLevel);
        // Deterministic fallback: an RNG delay here made otherwise-identical
        // battles diverge for any troop type missing an explicit attackDelay.
        const attackDelay = stats.attackDelay ?? 850;
        const firstAttackDelay = stats.firstAttackDelay ?? 0;
        const spawnTime = this.time.now;
        const legalSpawn = this.nearestWalkableTroopPoint({ type, level: troopLevel }, gx, gy);
        gx = legalSpawn.x;
        gy = legalSpawn.y;
        const pos = IsoUtils.cartToIso(gx, gy);

        // Create detailed troop graphic
        const troopGraphic = this.add.graphics();
        troopGraphic.setPosition(pos.x, pos.y);
        troopGraphic.setDepth(depthForTroop(gx, gy, type));
        if (!SpriteBank.syncLooseTroop(this, troopGraphic, type, owner, troopLevel, 0, true, this.time.now)) {
            TroopRenderer.drawTroopVisual(troopGraphic, type, owner, 0, true, 0, 0, false, 0, troopLevel, this.time.now);
        }

        // Spawn dust effect - depth just below troop for proper layering
        const troopDepth = depthForTroop(gx, gy, type);
        PixelFx.burst(this, pos.x, pos.y + 5, {
            count: 5, colors: [0x8b7355], alpha: 0.5, r: 3, rJitter: 3,
            spread: 15, speed: 20, up: 10, scaleTo: 1.5,
            life: 300, lifeJitter: 200, depth: troopDepth - 1
        });

        // Landing bounce animation
        troopGraphic.setScale(0.5);
        troopGraphic.y -= 20;
        this.tweens.add({
            targets: troopGraphic,
            scaleX: 1, scaleY: 1,
            y: pos.y,
            duration: 200,
            ease: 'Bounce.easeOut'
        });

        const troopHealth = stats.health;

        const troop: Troop = {
            id: Phaser.Utils.String.UUID(),
            type: type,
            level: troopLevel,
            gameObject: troopGraphic,
            healthBar: this.createHealthBarGraphics(),
            gridX: gx, gridY: gy,
            health: troopHealth, maxHealth: troopHealth,
            target: null, owner: owner,
            lastAttackTime: spawnTime - attackDelay + firstAttackDelay,
            attackDelay,
            speedMult: 0.9 + Math.random() * 0.2,
            hasTakenDamage: false,
            facingAngle: 0
        };

        // Kit clocks anchor at deploy time (deterministic, never per-frame).
        if (stats.untargetableMs) troop.untargetableUntil = spawnTime + stats.untargetableMs;
        if (stats.summonType) troop.lastSummonTime = spawnTime;
        if ((stats.healRadius ?? 0) > 0 && (stats.healAmount ?? 0) > 0) troop.lastHealPulseAt = spawnTime;

        this.troops.push(troop);
        this.hasDeployed = true;
        if (owner === 'PLAYER' && this.mode === 'ATTACK' && !GENERATED_ONLY.has(type)) {
            // Deploys leave the camp; generated spawns (romanwarrior split,
            // necromancer skeletons) never publish.
            this.deployedThisBattle[type] = (this.deployedThisBattle[type] ?? 0) + 1;
            const attackId = this.currentEnemyWorld?.attackId;
            if (attackId) {
                void Backend.publishAttackDeployment(attackId, {
                    id: troop.id,
                    type: troop.type,
                    gridX: troop.gridX,
                    gridY: troop.gridY
                }).catch(error => {
                    console.warn('Authoritative troop deployment was rejected:', error);
                });
            }
        }
        if (owner === 'PLAYER') soundSystem.play('deploy');
        if (owner === 'PLAYER' && this.mode === 'ATTACK') {
            // First boots on the ground: the whole village sprints for the town hall.
            this.villageLife.panic();
        }
        if (owner === 'PLAYER' && this.mode === 'ATTACK' && !this.isScouting) {
            this.setVillageNameVisible(false);
            this.beginAttackReplayCapture();
        }
        this.updateHealthBar(troop);
        this.acquireTroopNavigation(troop, spawnTime);

        if (this.mode === 'ATTACK') {
            // Alpha handled by lerp in updateDeploymentHighlight
        }
        return troop;
    }




    // === DEPLOY-FORBIDDEN TILES (CoC model) ===
    // Troop deployment is blocked per BUILDING — each alive enemy building's
    // footprint expanded by 1 tile (walls block only their own tile), NOT the
    // old whole-base bounding rectangle, which silently swallowed taps over
    // open grass anywhere between the base's extremes (one stray wall made
    // most of the map dead). Tiles free up as buildings are destroyed.
    private deployForbiddenTiles = new Set<number>();
    private deployForbiddenSignature: string | null = null;

    /** Rebuilds the forbidden-tile set when the alive enemy roster changed;
     *  returns the roster signature (also the redraw key for the red zone). */
    private refreshDeployForbiddenTiles(): string {
        const parts: string[] = [];
        this.buildings.forEach(b => {
            if (b.owner !== 'ENEMY' || b.health <= 0) return;
            parts.push(`${b.type === 'wall' ? 'w' : 'b'}${b.gridX},${b.gridY},${b.type}`);
        });
        const signature = `${this.mapSize}|${parts.join(';')}`;
        if (signature === this.deployForbiddenSignature) return signature;
        this.deployForbiddenSignature = signature;
        this.deployForbiddenTiles.clear();
        this.buildings.forEach(b => {
            if (b.owner !== 'ENEMY' || b.health <= 0) return;
            const info = BUILDINGS[b.type];
            const buffer = b.type === 'wall' ? 0 : 1;
            const x0 = Math.max(0, b.gridX - buffer);
            const x1 = Math.min(this.mapSize - 1, b.gridX + info.width - 1 + buffer);
            const y0 = Math.max(0, b.gridY - buffer);
            const y1 = Math.min(this.mapSize - 1, b.gridY + info.height - 1 + buffer);
            for (let y = y0; y <= y1; y++) {
                for (let x = x0; x <= x1; x++) {
                    this.deployForbiddenTiles.add(y * this.mapSize + x);
                }
            }
        });
        return signature;
    }

    /** Deploy legality for a (float) grid position — must agree exactly with
     *  the red overlay drawn by updateDeploymentHighlight. */
    public isDeployForbidden(gridX: number, gridY: number): boolean {
        this.refreshDeployForbiddenTiles();
        const tx = Math.floor(gridX);
        const ty = Math.floor(gridY);
        if (tx < 0 || ty < 0 || tx >= this.mapSize || ty >= this.mapSize) return false;
        return this.deployForbiddenTiles.has(ty * this.mapSize + tx);
    }

    private updateDeploymentHighlight() {
        if (this.mode !== 'ATTACK' || this.isScouting) {
            if (this.deployZoneSignature !== '') {
                this.deploymentGraphics.clear();
                this.forbiddenGraphics.clear();
                this.deployZoneSignature = '';
            }
            this.deploymentGraphics.setVisible(false);
            this.forbiddenGraphics.setVisible(false);
            return;
        }

        this.deploymentGraphics.setVisible(true);
        this.forbiddenGraphics.setVisible(true);

        const isRecentlyDeployed = (this.time.now - this.lastDeployTime < 1000);
        const isPointerDown = this.input.activePointer.isDown;
        const isInteractingWithForbidden = (this.time.now - this.lastForbiddenInteractionTime < 1500);

        const targetMarginAlpha = (isPointerDown || isRecentlyDeployed) ? 0.6 : 0.15;
        const targetForbiddenAlpha = isInteractingWithForbidden ? 0.6 : 0.0;

        // Smoothly lerp alphas for immersion
        this.deploymentGraphics.alpha += (targetMarginAlpha - this.deploymentGraphics.alpha) * 0.15;

        // Red zone fades slower (0.02 factor on fade out for extra grace, 0.2 on fade in)
        const redLerp = this.forbiddenGraphics.alpha < targetForbiddenAlpha ? 0.2 : 0.02;
        this.forbiddenGraphics.alpha += (targetForbiddenAlpha - this.forbiddenGraphics.alpha) * redLerp;

        // The zone diamonds rasterize to ~5–7k world-anchored pixel cells —
        // far too many fillRects to re-record per frame for geometry that
        // only moves when the map or the enemy roster changes. Cells sit on
        // the fixed world PIXEL_CELL grid, so zoom never alters the recorded
        // shapes; the fades above ride the Graphics alpha without a redraw.
        const signature = this.refreshDeployForbiddenTiles();
        if (signature === this.deployZoneSignature) {
            this.deploymentGraphics.setDepth(5);
            return;
        }
        this.deployZoneSignature = signature;
        this.deploymentGraphics.clear();
        this.forbiddenGraphics.clear();

        const margin = 2;

        // 1. Draw LUSH LIGHT GREEN deployment margin
        const m1 = IsoUtils.cartToIso(-margin, -margin);
        const m2 = IsoUtils.cartToIso(this.mapSize + margin, -margin);
        const m3 = IsoUtils.cartToIso(this.mapSize + margin, this.mapSize + margin);
        const m4 = IsoUtils.cartToIso(-margin, this.mapSize + margin);

        const i1 = IsoUtils.cartToIso(0, 0);
        const i2 = IsoUtils.cartToIso(this.mapSize, 0);
        const i3 = IsoUtils.cartToIso(this.mapSize, this.mapSize);
        const i4 = IsoUtils.cartToIso(0, this.mapSize);

        // Deployment area fill
        this.deploymentGraphics.fillStyle(0x7ed957, 0.4);
        this.deploymentGraphics.fillPoints([m1, m2, m3, m4], true);

        // Map boundary separator
        const innerPts = [i1, i2, i3, i4];
        for (let e = 0; e < 4; e++) {
            const pa = innerPts[e], pb = innerPts[(e + 1) % 4];
            pixelLine(this.deploymentGraphics, pa.x, pa.y, pb.x, pb.y, 1, 0xffffff, 0.4);
        }

        // Grid highlight (also crisps the margin fill's diamond edges)
        const marginPts = [m1, m2, m3, m4];
        for (let e = 0; e < 4; e++) {
            const pa = marginPts[e], pb = marginPts[(e + 1) % 4];
            pixelLine(this.deploymentGraphics, pa.x, pa.y, pb.x, pb.y, 1, 0xadffad, 0.6);
        }

        // 2. Draw INNER forbidden zone (into red graphics): the per-tile
        // union of every alive enemy building's buffered footprint — the
        // exact same set isDeployForbidden() checks, so the red paint and
        // the deploy legality can never disagree. Contiguous tiles of each
        // grid row merge into one iso strip (fewer polys, no seam stacking);
        // borders are pixelLine edges wherever a forbidden tile faces a
        // deployable neighbour.
        if (this.deployForbiddenTiles.size > 0) {
            const has = (x: number, y: number) =>
                x >= 0 && y >= 0 && x < this.mapSize && y < this.mapSize &&
                this.deployForbiddenTiles.has(y * this.mapSize + x);

            this.forbiddenGraphics.fillStyle(0xff0000, 0.2);
            for (let y = 0; y < this.mapSize; y++) {
                for (let x = 0; x < this.mapSize; x++) {
                    if (!has(x, y)) continue;
                    let runEnd = x;
                    while (has(runEnd + 1, y)) runEnd++;
                    const r1 = IsoUtils.cartToIso(x, y);
                    const r2 = IsoUtils.cartToIso(runEnd + 1, y);
                    const r3 = IsoUtils.cartToIso(runEnd + 1, y + 1);
                    const r4 = IsoUtils.cartToIso(x, y + 1);
                    this.forbiddenGraphics.fillPoints([r1, r2, r3, r4], true);
                    x = runEnd;
                }
            }

            this.deployForbiddenTiles.forEach(key => {
                const tx = key % this.mapSize;
                const ty = Math.floor(key / this.mapSize);
                const c1 = IsoUtils.cartToIso(tx, ty);
                const c2 = IsoUtils.cartToIso(tx + 1, ty);
                const c3 = IsoUtils.cartToIso(tx + 1, ty + 1);
                const c4 = IsoUtils.cartToIso(tx, ty + 1);
                if (!has(tx, ty - 1)) pixelLine(this.forbiddenGraphics, c1.x, c1.y, c2.x, c2.y, 1, 0xff0000, 0.5);
                if (!has(tx + 1, ty)) pixelLine(this.forbiddenGraphics, c2.x, c2.y, c3.x, c3.y, 1, 0xff0000, 0.5);
                if (!has(tx, ty + 1)) pixelLine(this.forbiddenGraphics, c3.x, c3.y, c4.x, c4.y, 1, 0xff0000, 0.5);
                if (!has(tx - 1, ty)) pixelLine(this.forbiddenGraphics, c4.x, c4.y, c1.x, c1.y, 1, 0xff0000, 0.5);
            });
        }

        this.deploymentGraphics.setDepth(5);
    }

    private playUpgradeEffect(building: PlacedBuilding) {
        const bInfo = BUILDINGS[building.type];

        // Calculate VISUAL center (considering isometric height)
        const groundCenter = IsoUtils.cartToIso(building.gridX + bInfo.width / 2, building.gridY + bInfo.height / 2);

        // Approximate visual center based on building type (most have some height)
        let heightOffset = 50;
        if (building.type === 'wall') heightOffset = 10;
        else if (building.type === 'army_camp') heightOffset = 20;
        else if (building.type === 'tesla') heightOffset = 80;

        const centerX = groundCenter.x;
        const centerY = groundCenter.y - heightOffset / 2;

        // Sparkle particles: an even ring of gold/yellow/white motes thrown
        // outward, rising and dying small.
        PixelFx.burst(this, centerX, centerY, {
            count: 12, colors: [0xFFD700, 0xFFA500, 0xFFFF00, 0xFFFFFF, 0xFFE4B5],
            r: 3, rJitter: 3, speed: 0,
            radial: 40, radialJitter: 40, ringAngles: true,
            up: 40, upJitter: 30, scaleTo: 0.2,
            life: 800, lifeJitter: 400, ease: 'Cubic.easeOut',
            depth: building.graphics.depth + 100
        });

        // Create rising star effect — a four-point cell star (no AA fill
        // paths on the live layer).
        for (let i = 0; i < 3; i++) {
            const star = this.add.graphics();
            star.setDepth(building.graphics.depth + 110);
            pixelBitmap(star, -4.5 * PIXEL_CELL, -4.5 * PIXEL_CELL, [
                '....f....',
                '....f....',
                '...fff...',
                '..fffff..',
                'fffffffff',
                '..fffff..',
                '...fff...',
                '....f....',
                '....f....'
            ], { f: 0xFFD700 }, 1);
            star.x = centerX + (Math.random() - 0.5) * 30;
            star.y = centerY;

            this.tweens.add({
                targets: star,
                y: centerY - 60 - Math.random() * 40,
                alpha: { from: 1, to: 0 },
                scale: { from: 1.5, to: 0.5 },
                duration: 800 + Math.random() * 400,
                delay: i * 100,
                ease: 'Cubic.easeOut',
                onComplete: () => star.destroy()
            });
        }

        // Pop Animation
        this.tweens.killTweensOf(building.graphics);
        if (building.baseGraphics) this.tweens.killTweensOf(building.baseGraphics);

        building.graphics.y = 0;
        if (building.baseGraphics) building.baseGraphics.y = 0;

        this.tweens.add({
            targets: building.graphics,
            y: -10,
            duration: 150,
            yoyo: true,
            ease: 'Quad.easeOut',
            onComplete: () => { building.graphics.y = 0; }
        });

        if (building.baseGraphics) {
            this.tweens.add({
                targets: building.baseGraphics,
                y: -5,
                duration: 150,
                yoyo: true,
                ease: 'Quad.easeOut',
                onComplete: () => { if (building.baseGraphics) building.baseGraphics.y = 0; }
            });
        }
    }

    // === BUILDING RANGE INDICATOR ===
    /** THE grid-radius → iso-ellipse conversion for every range ring.
     *  Combat range checks measure plain grid distance, and a grid-circle of
     *  radius R projects isometrically to an ellipse whose semi-axes carry
     *  the Math.SQRT2 grid-diagonal factor. Inner (minRange) and outer rings
     *  must both go through here or they disagree with the sim by ~29%. */
    private gridRangeToIsoRadii(rangeTiles: number): { rx: number; ry: number } {
        return {
            rx: rangeTiles * this.tileWidth * 0.5 * Math.SQRT2,
            ry: rangeTiles * this.tileHeight * 0.5 * Math.SQRT2
        };
    }

    public showBuildingRangeIndicator(building: PlacedBuilding) {
        // Only show range for defensive buildings
        const info = BUILDINGS[building.type];
        if (info.category !== 'defense' || building.type === 'wall') return;

        // Clear any existing indicator
        this.clearBuildingRangeIndicator();

        // Range from centralized PER-LEVEL stats — range upgrades with level,
        // so the ring must read the defense's current level, not the base
        // definition (which is level 1).
        const stats = this.getDefenseStats(building);
        const range = stats.range || 0;
        const deadZone = stats.minRange || 0;

        if (range === 0) return;

        // Calculate center position
        const center = IsoUtils.cartToIso(building.gridX + info.width / 2, building.gridY + info.height / 2);

        // Create range indicator graphics
        const rangeGraphics = this.add.graphics();
        rangeGraphics.setDepth(building.graphics.depth + 2);

        // Isometric ellipse size (range in pixels) via the shared conversion.
        const { rx: radiusX, ry: radiusY } = this.gridRangeToIsoRadii(range);

        // Draw subtle filled area
        pixelEllipse(rangeGraphics, center.x, center.y, radiusX, radiusY, 0x4488ff, 0.08);

        // Draw dashed outline (whole pixel cells stamped along each dash arc)
        const dashCount = 24;
        const dashGap = 0.4; // Gap ratio
        for (let i = 0; i < dashCount; i++) {
            const startAngle = (i / dashCount) * Math.PI * 2;
            const endAngle = ((i + (1 - dashGap)) / dashCount) * Math.PI * 2;

            const arcLen = (endAngle - startAngle) * (radiusX + radiusY) / 2;
            const steps = Math.max(2, Math.ceil(arcLen / PIXEL_CELL));
            for (let j = 0; j <= steps; j++) {
                const t = startAngle + (endAngle - startAngle) * (j / steps);
                const x = center.x + Math.cos(t) * radiusX;
                const y = center.y + Math.sin(t) * radiusY;
                pixelRect(rangeGraphics, x - PIXEL_CELL / 2, y - PIXEL_CELL / 2, PIXEL_CELL, PIXEL_CELL, 0x4488ff, 0.4);
            }
        }

        // Add a subtle glow
        this.pixelRing(rangeGraphics, center.x, center.y, radiusX, radiusY, 3, 0x4488ff, 0.15);

        // === DEAD ZONE INDICATOR ===
        if (deadZone > 0) {
            // Same conversion as the outer ring — the mortar blind spot is
            // checked in grid distance too, so it needs the SQRT2 factor.
            const { rx: deadRadiusX, ry: deadRadiusY } = this.gridRangeToIsoRadii(deadZone);

            // Draw dead zone filled area (red, more opaque)
            pixelEllipse(rangeGraphics, center.x, center.y, deadRadiusX, deadRadiusY, 0xff4444, 0.15);

            // Draw dead zone dashed outline (red, whole cells at angle steps)
            for (let i = 0; i < dashCount; i++) {
                const startAngle = (i / dashCount) * Math.PI * 2;
                const endAngle = ((i + (1 - dashGap)) / dashCount) * Math.PI * 2;

                const arcLen = (endAngle - startAngle) * (deadRadiusX + deadRadiusY) / 2;
                const steps = Math.max(2, Math.ceil(arcLen / PIXEL_CELL));
                for (let j = 0; j <= steps; j++) {
                    const t = startAngle + (endAngle - startAngle) * (j / steps);
                    const x = center.x + Math.cos(t) * deadRadiusX;
                    const y = center.y + Math.sin(t) * deadRadiusY;
                    pixelRect(rangeGraphics, x - PIXEL_CELL / 2, y - PIXEL_CELL / 2, PIXEL_CELL, PIXEL_CELL, 0xff4444, 0.5);
                }
            }
        }

        building.rangeIndicator = rangeGraphics;
        this.attackModeSelectedBuilding = building;

        // A long-range defense (dragons_breath reaches 14 tiles) can have its
        // ENTIRE ring outside the camera view when zoomed in — selection then
        // shows no range feedback at all. If no part of the ring's edge is on
        // screen, ease the camera out just enough to reveal it. Never during
        // a move-carry: the camera must not lurch mid-drag (the carry re-shows
        // the ring on every tile change).
        if (!this.isMoving) {
            this.ensureRangeRingVisible(center.x, center.y, radiusX, radiusY);
        }

        // Add subtle pulse animation. Track the handle: destroying the
        // graphics does NOT stop its tweens, so every reselect used to leak
        // one infinite (repeat:-1) tween ticking a dead graphics forever.
        this.rangeIndicatorPulseTween = this.tweens.add({
            targets: rangeGraphics,
            alpha: 0.6,
            duration: 800,
            yoyo: true,
            repeat: -1,
            ease: 'Sine.easeInOut'
        });
    }

    /**
     * A zoomed-in view can sit entirely INSIDE a long-range ring (dragons_
     * breath reaches 14 tiles) with at most a corner-nick of its edge peeking
     * in — no usable range feedback. Sample the ring's perimeter: if no
     * sample is comfortably on screen (inner 70% of the view) and under a
     * quarter of the edge is visible at all, pan onto the defense and zoom
     * out just enough to fit the ring — never zooming IN, never below the
     * gesture floor.
     */
    private ensureRangeRingVisible(cx: number, cy: number, rx: number, ry: number) {
        const camera = this.cameras.main;
        const view = camera.worldView;
        const SAMPLES = 48;
        const marginX = view.width * 0.15;
        const marginY = view.height * 0.15;
        let visible = 0;
        let comfortable = 0;
        for (let i = 0; i < SAMPLES; i++) {
            const t = (i / SAMPLES) * Math.PI * 2;
            const px = cx + Math.cos(t) * rx;
            const py = cy + Math.sin(t) * ry;
            if (px < view.x || px > view.right || py < view.y || py > view.bottom) continue;
            visible++;
            if (px >= view.x + marginX && px <= view.right - marginX &&
                py >= view.y + marginY && py <= view.bottom - marginY) comfortable++;
        }
        if (comfortable > 0 || visible >= SAMPLES * 0.25) return;

        // CSS insets keep the ring clear of the HUD bar and the info bubble.
        const fitZoom = Math.min(
            (cameraCssWidth(camera) - 72) / (rx * 2),
            (cameraCssHeight(camera) - 120) / (ry * 2)
        );
        const targetZoom = Phaser.Math.Clamp(
            fitZoom,
            this.minGestureZoom(),
            toLogicalZoom(camera.zoom)
        );
        camera.pan(cx, cy, 380, 'Sine.easeInOut');
        camera.zoomTo(toBackingZoom(targetZoom), 380, 'Sine.easeInOut');
        this.hasUserMovedCamera = true;
    }

    public clearBuildingRangeIndicator() {
        if (this.rangeIndicatorPulseTween) {
            this.rangeIndicatorPulseTween.remove();
            this.rangeIndicatorPulseTween = null;
        }
        if (this.attackModeSelectedBuilding?.rangeIndicator) {
            this.attackModeSelectedBuilding.rangeIndicator.destroy();
            this.attackModeSelectedBuilding.rangeIndicator = undefined;
        }
        this.attackModeSelectedBuilding = null;
    }

    /** True while a DOM text field owns the keyboard — game hotkeys (arrows,
     *  ESC) must not reach the scene. Mirrors App.tsx's M-key focus guard. */
    private isTypingInDomField(): boolean {
        const el = document.activeElement as HTMLElement | null;
        return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable);
    }

    private handleCameraMovement(delta: number) {
        if (!this.cursorKeys) return;
        // Arrow keys pressed while typing in a DOM input scroll the caret,
        // not the camera.
        if (this.isTypingInDomField()) return;
        const speed = 0.5 * delta * this.cameraSensitivity;
        const movedX = this.cursorKeys.left?.isDown || this.cursorKeys.right?.isDown;
        const movedY = this.cursorKeys.up?.isDown || this.cursorKeys.down?.isDown;
        if (this.cursorKeys.left?.isDown) this.cameras.main.scrollX -= speed;
        else if (this.cursorKeys.right?.isDown) this.cameras.main.scrollX += speed;
        if (this.cursorKeys.up?.isDown) this.cameras.main.scrollY -= speed;
        else if (this.cursorKeys.down?.isDown) this.cameras.main.scrollY += speed;
        if (movedX || movedY) {
            this.hasUserMovedCamera = true;
        }
    }

    private updateSelectionHighlight() {
        if (!this.selectionGraphics) return;
        this.selectionGraphics.clear();

        if (this.mode === 'HOME' && this.selectedInWorld) {
            // While carrying, the ghost draws its own green/red validity
            // footprint at the cursor — a cyan outline on top of it muddied
            // the verdict color, so the selection outline yields for the carry.
            if (this.isMoving) return;
            const b = this.selectedInWorld;
            const info = BUILDINGS[b.type];

            const gx = b.gridX;
            const gy = b.gridY;

            // Draw bright border around base
            const p1 = IsoUtils.cartToIso(gx, gy);
            const p2 = IsoUtils.cartToIso(gx + info.width, gy);
            const p3 = IsoUtils.cartToIso(gx + info.width, gy + info.height);
            const p4 = IsoUtils.cartToIso(gx, gy + info.height);

            // Bright Cyan pixel edges
            pixelLine(this.selectionGraphics, p1.x, p1.y, p2.x, p2.y, 3, 0x00ffff, 1);
            pixelLine(this.selectionGraphics, p2.x, p2.y, p3.x, p3.y, 3, 0x00ffff, 1);
            pixelLine(this.selectionGraphics, p3.x, p3.y, p4.x, p4.y, 3, 0x00ffff, 1);
            pixelLine(this.selectionGraphics, p4.x, p4.y, p1.x, p1.y, 3, 0x00ffff, 1);

            // Subtle, slow pulsing opacity (0.6 to 1.0)
            this.selectionGraphics.setAlpha(0.8 + 0.2 * Math.sin(this.time.now / 800));

            // Layer BEHIND the building base (simulate on ground)
            // UPDATE: User wants it OVERLAPPING other objects (high visibility)
            // We set it to max depth.
            this.selectionGraphics.setDepth(200000);
        }
    }

    private async flushPendingSaveForTransition(): Promise<boolean> {
        const userId = this.userId;
        if (!Backend.hasPendingSave(userId)) return true;

        const maxWaitMs = 1200;
        let timeoutHandle: number | null = null;
        const flushPromise = Backend.flushPendingSave();
        const timeoutPromise = new Promise<'timeout'>(resolve => {
            timeoutHandle = window.setTimeout(() => resolve('timeout'), maxWaitMs);
        });

        try {
            const result = await Promise.race([
                flushPromise.then(() => 'flushed' as const),
                timeoutPromise
            ]);
            if (timeoutHandle !== null) {
                window.clearTimeout(timeoutHandle);
            }
            if (result === 'timeout') {
                console.warn(`flushPendingSaveForTransition: continuing after ${maxWaitMs}ms budget`);
                void flushPromise.catch(error => {
                    console.warn('flushPendingSaveForTransition: background flush failed:', error);
                });
                gameManager.showToast('Your village is still saving. Try that journey again in a moment.');
                return false;
            }
            return true;
        } catch (error) {
            console.warn('Failed to flush pending save before transition:', error);
            gameManager.showToast('Village save failed. Reconnect before leaving home.');
            return false;
        }
    }

    private showCloudTransition(onMidpoint: (epoch: number) => void | Promise<void>) {
        const epoch = this.beginExclusiveTransition('Another journey');
        if (epoch === null) return;
        this.forceFinishHomecoming();
        // Show React overlay to cover UI.
        gameManager.showCloudOverlay();

        // CSS cloud close animation is 600ms; add a small cushion before swapping scenes.
        const cloudCloseMs = 620;
        // Keep this short to reduce cloud time while still allowing one frame for draw completion.
        const readyBufferMs = 90;

        this.time.delayedCall(cloudCloseMs, () => {
            if (!this.isTransitionCurrent(epoch)) return;
            void Promise.resolve()
                .then(() => onMidpoint(epoch))
                .catch(error => {
                    console.error('Cloud transition midpoint failed:', error);
                })
                .finally(() => {
                    if (!this.isTransitionCurrent(epoch)) return;
                    this.time.delayedCall(readyBufferMs, () => {
                        if (!this.isTransitionCurrent(epoch)) return;
                        gameManager.hideCloudOverlay();
                        this.finishExclusiveTransition(epoch);
                    });
                });
        });
    }

    private createUI() {
        gameManager.registerScene({
            selectBuilding: (type: string | null) => {
                this.selectedBuildingType = type;
                this.isMoving = false;
                this.ghostGridPos = null;
                if (!this.selectedBuildingType) {
                    this.ghostBuilding.setVisible(false);
                } else {
                    // Immediately show ghost building by triggering
                    // onPointerMove with the TRACKED gameplay pointer —
                    // activePointer can be a pinch's second finger.
                    this.inputController.onPointerMove(this.inputController.getGameplayPointer());
                }
            },
            startAttack: () => {
                this.showCloudTransition(async epoch => {
                    if (!await this.flushPendingSaveForTransition() || !this.isTransitionCurrent(epoch)) return;
                    const loaded = await this.generateEnemyVillage(epoch);
                    if (!this.isTransitionCurrent(epoch)) return;
                    if (!loaded) {
                        await this.goHome();
                        return;
                    }
                });
            },
            startPracticeAttack: () => {
                this.showCloudTransition(async epoch => {
                    if (!await this.beginAttackSession(false, epoch)) return;
                    // Load player's own base as the enemy
                    let playerWorld: SerializedWorld | null = null;
                    try {
                        playerWorld = await Backend.getWorld(this.userId);
                    } catch (error) {
                        console.error('startPracticeAttack: failed to load player world', error);
                    }
                    if (!this.isTransitionCurrent(epoch)) return;

                    let loadedPracticeBase = false;
                    if (playerWorld && Array.isArray(playerWorld.buildings) && playerWorld.buildings.length > 0) {
                        // Drills pay nothing: zero the loot so the battle HUD is honest.
                        const drillWorld = { ...playerWorld, resources: { gold: 0, ore: 0, food: 0 } };
                        const summary = this.instantiateEnemyWorld(drillWorld, {
                            id: 'practice',
                            username: 'Your Base',
                            isBot: true
                        });
                        loadedPracticeBase = summary.playablePlaced > 0;
                        if (!loadedPracticeBase) {
                            console.warn('startPracticeAttack: player world had no playable structures, using fallback practice base', {
                                worldId: playerWorld.id,
                                summary
                            });
                        }
                    }

                    if (!loadedPracticeBase) {
                        // Fallback to local visual-only base if player world fails to load.
                        // Do not call placeBuilding here, to avoid mutating/saving the player's home world.
                        const fallbackWorld: SerializedWorld = {
                            id: `practice_fallback_${Date.now()}`,
                            ownerId: 'practice',
                            username: 'Default Base',
                            buildings: [
                                { id: Phaser.Utils.String.UUID(), type: 'town_hall', gridX: 11, gridY: 11, level: 1 },
                                { id: Phaser.Utils.String.UUID(), type: 'cannon', gridX: 8, gridY: 11, level: 1 },
                                { id: Phaser.Utils.String.UUID(), type: 'barracks', gridX: 15, gridY: 11, level: 1 },
                                { id: Phaser.Utils.String.UUID(), type: 'army_camp', gridX: 11, gridY: 15, level: 1 }
                            ],
                            obstacles: [],
                            resources: { gold: 0 },
                            army: {},
                            wallLevel: 1,
                            lastSaveTime: Date.now(),
                            revision: 1
                        };
                        const fallbackSummary = this.instantiateEnemyWorld(fallbackWorld, {
                            id: 'practice',
                            username: 'Default Base',
                            isBot: true
                        });
                        loadedPracticeBase = fallbackSummary.playablePlaced > 0;
                        if (!loadedPracticeBase) {
                            console.error('startPracticeAttack: fallback visual base failed to instantiate', fallbackSummary);
                        }
                        this.currentEnemyWorld = {
                            id: 'practice',
                            username: 'Default Base',
                            isBot: true
                        };
                    }
                    this.updateVillageName();
                    this.centerCamera();
                    this.resetBattleStats();
                });
            },
            startOnlineAttack: () => {
                this.showCloudTransition(async epoch => {
                    if (!await this.flushPendingSaveForTransition() || !this.isTransitionCurrent(epoch)) return;
                    // Matchmaking selects a real world plot; the shared focus
                    // path below installs that neighborhood and enters the
                    // same battle-in-place flow as a nearby road attack.
                    const loaded = await this.generateOnlineEnemyVillage(epoch);
                    if (!this.isTransitionCurrent(epoch)) return;
                    if (!loaded) {
                        await this.goHome();
                        return;
                    }
                });
            },
            startAttackOnUser: (userId: string, username: string) => {
                this.showCloudTransition(async epoch => {
                    if (!await this.flushPendingSaveForTransition() || !this.isTransitionCurrent(epoch)) return;
                    const success = await this.generateEnemyVillageFromUser(userId, username, true, epoch);
                    if (!this.isTransitionCurrent(epoch)) return;
                    if (!success) {
                        gameManager.showToast(`${username}'s village cannot be attacked right now.`);
                        await this.goHome();
                        return;
                    }
                });
            },
            startScoutOnUser: (userId: string, username: string) => {
                this.showCloudTransition(async epoch => {
                    if (!await this.beginAttackSession(true, epoch)) return;
                    const success = await this.generateEnemyVillageFromUser(userId, username, false, epoch);
                    if (!this.isTransitionCurrent(epoch)) return;
                    if (!success) {
                        await this.goHome();
                        return;
                    }
                    this.centerCamera();
                    this.resetBattleStats();
                });
            },
            watchLiveAttack: (attackId: string) => {
                this.showCloudTransition(async epoch => {
                    if (!await this.flushPendingSaveForTransition()) return;
                    if (!this.isTransitionCurrent(epoch)) return;
                    gameManager.setGameMode('REPLAY');
                    this.mode = 'REPLAY';
                    this.isScouting = true;
                    this.clearScene();

                    let loaded = false;
                    try {
                        loaded = await this.startReplayWatch(attackId, 'live');
                    } catch (error) {
                        console.warn('Unable to watch live attack:', error);
                    }
                    if (!this.isTransitionCurrent(epoch)) return;
                    if (!loaded) {
                        gameManager.showToast('That live battle is unavailable.');
                        await this.goHome();
                        return;
                    }
                    this.centerCamera();
                });
            },
            watchReplay: (attackId: string) => {
                this.showCloudTransition(async epoch => {
                    if (!await this.flushPendingSaveForTransition()) return;
                    if (!this.isTransitionCurrent(epoch)) return;
                    gameManager.setGameMode('REPLAY');
                    this.mode = 'REPLAY';
                    this.isScouting = true;
                    this.clearScene();

                    let loaded = false;
                    try {
                        loaded = await this.startReplayWatch(attackId, 'replay');
                    } catch (error) {
                        console.warn('Unable to load replay:', error);
                    }
                    if (!this.isTransitionCurrent(epoch)) return;
                    if (!loaded) {
                        gameManager.showToast('That replay is unavailable.');
                        await this.goHome();
                        return;
                    }
                    this.centerCamera();
                });
            },
            findNewMap: () => {
                // Only allow before the first deployment. Gate on hasDeployed (not the
                // live troop count) so a raid whose troops all died can't slip through
                // and leave its replay capture leaking.
                if (this.hasDeployed) {
                    // Could show feedback here, but for now just don't do anything
                    return;
                }

                this.showCloudTransition(async epoch => {
                    // End any live capture, then settle the registered online attack as an abort.
                    await this.endAttackReplayCapture('aborted')?.catch(() => undefined);
                    await this.abandonCurrentAttack();
                    if (this.currentEnemyWorld?.isBot && !this.botRaidSettled) {
                        try {
                            await this.settleBotRaid();
                        } catch (error) {
                            console.warn('Could not close the previous bot raid before NEXT:', error);
                            gameManager.showToast('The previous raid is still settling. Try NEXT again in a moment.');
                            return;
                        }
                    }
                    if (!this.isTransitionCurrent(epoch)) return;
                    // Clear and regenerate enemy village
                    this.clearScene();
                    this.currentEnemyWorld = null;
                    const loaded = await this.generateEnemyVillage(epoch);
                    if (!this.isTransitionCurrent(epoch)) return;
                    if (!loaded) {
                        await this.goHome();
                        return;
                    }
                    this.centerCamera();
                    // Reset battle stats for new village (includes the
                    // HP-weighted loot baseline for the fresh roster).
                    this.resetBattleStats();
                });
            },
            deleteSelectedBuilding: () => {
                const selected = this.selectedInWorld;
                if (!selected) return false;
                this.destroyBuilding(selected);
                const deleted = !this.buildings.some(building => building.id === selected.id);
                if (deleted) this.selectedInWorld = null;
                return deleted;
            },
            deselectBuilding: () => {
                // UI-initiated deselect (e.g. the InfoPanel TRACKS button
                // swapping to the jukebox modal): drop the in-world selection
                // ring/range indicator, not just the React panel.
                if (!this.selectedInWorld) return;
                if (this.selectedInWorld.type === 'prism') {
                    this.cleanupPrismLaser(this.selectedInWorld);
                }
                this.selectedInWorld = null;
                this.clearBuildingRangeIndicator();
                gameManager.onBuildingSelected(null);
            },
            moveSelectedBuilding: () => {
                if (this.selectedInWorld) {
                    // Unbake the building from ground texture before moving to prevent artifacts
                    this.unbakeBuildingFromGround(this.selectedInWorld);
                    // Villagers react to the lift (and the drop handler's
                    // onBuildingPlaced expects a preceding lift).
                    this.villageLife.onBuildingLifted(this.selectedInWorld);
                }
                this.isMoving = true;
                this.selectedBuildingType = null;
                // Hide the info popup while carrying the building — it sits
                // right where you're dragging and steals the pointer. The
                // drop handler re-emits the selection at the new spot.
                gameManager.onBuildingSelected(null);
                // Immediate visual feedback (tracked gameplay pointer —
                // activePointer can be a non-gameplay finger).
                this.inputController.onPointerMove(this.inputController.getGameplayPointer());
            },
            upgradeSelectedBuilding: () => {
                if (this.selectedInWorld) {
                    const prevLevel = this.selectedInWorld.level || 1;
                    const maxLvl = BUILDINGS[this.selectedInWorld.type]?.maxLevel ?? 1;
                    if (prevLevel >= maxLvl) return null;
                    if (this.selectedInWorld.upgradingTo) return null; // clock already running

                    // Walls stay instant (the cohort levels as one, and the
                    // server applies wall levels without a timer).
                    if (this.selectedInWorld.type === 'wall') {
                        this.selectedInWorld.level = prevLevel + 1;
                        const stats = getBuildingStats('wall' as BuildingType, this.selectedInWorld.level);
                        this.preferredWallLevel = Math.max(this.preferredWallLevel, this.selectedInWorld.level || 1);
                        this.buildings.forEach(b => {
                            if (b.type === 'wall' && (b.level || 1) === prevLevel && b.id !== this.selectedInWorld!.id) {
                                b.level = this.selectedInWorld!.level;
                            }
                            if (b.type !== 'wall' || (b.level || 1) !== this.selectedInWorld!.level) return;
                            b.maxHealth = stats.maxHealth;
                            b.health = b.maxHealth;
                            b.graphics.clear();
                            if (b.baseGraphics) b.baseGraphics.clear();
                            this.drawBuildingVisuals(b.graphics, b.gridX, b.gridY, b.type, 1, null, b, b.baseGraphics);
                            this.playUpgradeEffect(b);
                        });
                        return this.selectedInWorld.level;
                    }

                    // Everything else buys a TIMED upgrade: the level stays
                    // put (and the building goes offline) until the server's
                    // clock — mirrored here — matures in resolveLocalUpgrades.
                    const targetLevel = prevLevel + 1;
                    const provisionalStart = this.serverEpochNow();
                    (this.selectedInWorld as UpgradeTimedPlacedBuilding).upgradeStartedAt = provisionalStart;
                    this.selectedInWorld.upgradingTo = targetLevel;
                    // Provisional deadline from the SERVER-advertised policy;
                    // the authoritative save response replaces it either way.
                    this.selectedInWorld.upgradeEndsAt = provisionalStart
                        + serverUpgradeDurationMs(this.selectedInWorld.type, targetLevel);
                    if (Auth.isOnlineMode()) this.pendingUpgradeAuthority.add(this.selectedInWorld.id);
                    this.villageLife.onConstruction(this.selectedInWorld, 'upgrade');
                    this.updateHealthBar(this.selectedInWorld);

                    // NOTE: Do NOT call Backend.upgradeBuilding here.
                    // App.tsx handleUpgradeBuilding already calls it before
                    // invoking this scene command. Calling it twice would
                    // double-increment the building level in the cached world.

                    return targetLevel;
                }
                return null;
            }
        });
    }

    public async goHome() {
        // Retreat owns the scene now. Cancel delayed split spawns and the
        // scheduled natural-end handoff before they can fire against home.
        this.cancelBattleAsyncWork();
        // A MID-RAID retreat (troops deployed, natural end not yet scheduled)
        // still banks partial loot/trophies below — that must never be
        // silent. Snapshot the report inputs before the flags reset.
        const retreatReport = this.mode === 'ATTACK' && !this.isScouting && this.hasDeployed
            && !this.raidEndScheduled && this.currentEnemyWorld?.id !== 'practice'
            ? { destruction: this.currentDestructionPct() }
            : null;
        this.hasDeployed = false;
        this.raidEndScheduled = true;
        if (this.mode === 'ATTACK') {
            const settlement = this.endAttackReplayCapture('aborted');
            let applied: AttackEndResult | null = null;
            let settlementDelayed = false;
            if (settlement) {
                applied = await settlement.catch(error => {
                    console.warn('Attack settlement failed before home reload:', error);
                    settlementDelayed = true;
                    return null;
                });
            } else {
                // If the attack was registered but no troop ever deployed,
                // settle it as a zero-result abort before reading home truth.
                await this.abandonCurrentAttack();
            }
            // A retreat from a bot camp still consumed the troops that marched
            // (and banks whatever loot the destruction so far earned).
            let botPayout: number | null = null;
            try {
                botPayout = await this.settleBotRaid();
            } catch {
                if (this.currentEnemyWorld?.botRaidId && !this.botRaidSettled) settlementDelayed = true;
            }
            if (retreatReport) {
                // Reuse the raid-report surface ("Retreated" variant) so the
                // banked partial loot + trophy delta are acknowledged.
                gameManager.onRetreatEnded({
                    destruction: retreatReport.destruction,
                    goldLooted: Math.max(0, Math.floor(applied?.lootApplied ?? botPayout ?? 0)),
                    oreLooted: Math.max(0, Math.floor(applied?.oreApplied ?? 0)),
                    foodLooted: Math.max(0, Math.floor(applied?.foodApplied ?? 0)),
                    trophyDelta: applied?.trophyDelta,
                    settlementDelayed: settlementDelayed || undefined
                });
            }
        }
        this.currentEnemyWorld = null;
        // Every retreat rides the clouds home — no homecoming march. The war
        // camp is torn down by endFocus below; the drums stop with it (the
        // marching column used to silence them, so it is explicit now).
        soundSystem.setBattleMusic(false);
        this.forceFinishHomecoming(); // completes any stale homecoming swap
        this.worldMap.endFocus();
        this.battleInPlace = false;
        // Back on our own lawn — which never wears a nameplate, so the
        // target's label simply goes away with the battle.
        this.rebakeGround(this.userId || 'village');
        this.setVillageNameVisible(false);
        this.clearReplayWatchState();
        this.cancelPlacement();
        gameManager.setGameMode('HOME');
        this.mode = 'HOME';
        this.isScouting = false;
        this.hasDeployed = false;
        await this.reloadHomeBase({ refreshOnline: true });
    }

    /**
     * Commit whatever home frame is prepared RIGHT NOW. Normally fires from
     * the marching column near the home gate; interrupts (a new attack, a
     * cloud transition) call it early so the world is never left anchored on
     * a neighbour's plot.
     */
    private forceFinishHomecoming() {
        const pending = this.pendingHomecoming;
        if (!pending) return;
        this.pendingHomecoming = null;
        if (this.mode !== 'HOME') {
            // A cloud transition (replay, scout, far raid) owns the scene now:
            // drop the battle frame quietly; its goHome rebuilds the long way.
            this.worldMap.abortHomecoming();
            this.worldMap.endFocus();
            this.dropGroundBake();
            return;
        }
        // ---- the swap home: a single frame ----
        const shift = this.worldMap.commitFocus();
        this.commitGroundBake(this.userId || 'village');
        this.applyWorldToScene(pending.world);
        this.setVillageNameVisible(true);
        this.updateVillageName();
        this.dayNight?.resyncLights();
        if (shift) {
            // The world re-anchored home by (dx, dy) plots; the camera moves
            // by the same world-space delta so nothing under the lens jumps.
            const delta = IsoUtils.cartToIso(shift.dx * PLOT_PITCH, shift.dy * PLOT_PITCH);
            const cam = this.cameras.main;
            cam.scrollX -= delta.x;
            cam.scrollY -= delta.y;
        } else {
            // No prepared frame to commit (dropped mid-flight): hard fallback.
            this.worldMap.endFocus();
            this.centerCamera();
        }
    }

    /** Drop a pending hidden lawn bake (homecoming aborted mid-flight). */
    private dropGroundBake() {
        this.pendingGroundRT?.destroy();
        this.pendingGroundRT = null;
        this.pendingGroundKey = null;
    }


    /**
     * Clear only the fighting pieces (troops, spike zones, the ghost troop) —
     * buildings stay. The homecoming march uses this so the wrecked village
     * remains on view while the column walks away from it.
     */
    private clearBattleActors() {
        this.troops.forEach(t => {
            this.tweens.killTweensOf(t.gameObject);
            this.tweens.killTweensOf(t);
            this.tweens.killTweensOf(t.healthBar);
            t.gameObject.destroy();
            t.healthBar.destroy();
        });
        this.troops = [];
        this.spikeZones.forEach(zone => {
            this.tweens.killTweensOf(zone.graphics);
            zone.graphics.destroy();
        });
        this.spikeZones = [];
    }

    private clearScene() {
        this.clearReplayWatchState();
        // MainScene is reused across villages. Cancel only battle-owned async
        // work; ambient/world systems retain their own timers and tweens.
        this.cancelBattleAsyncWork();
        // Loose battle effects (projectiles mid-flight, scorch fades, craters)
        // must not survive the swap and land re-anchored over the next scene.
        this.clearBattleFx();
        this.villageLife.clear();
        this.dayNight.clearLights();
        // clearLights() wipes every transient light, but the road-travellers
        // camped on the world map outlive a scene swap — their bonfires keep
        // burning, so their glow rigs must be re-registered immediately.
        this.worldMap?.resyncTravellerLights();

        // Drop particle emitter trackers from the finished battle; their keys are
        // per-entity, so without this the tracker map grows across every raid.
        particleManager.clearAll();

        // Clear all buildings and their associated graphics
        this.buildings.forEach(b => {
            this.tweens.killTweensOf(b);
            this.tweens.killTweensOf(b.graphics);
            b.graphics.destroy();
            if (b.baseGraphics) {
                this.tweens.killTweensOf(b.baseGraphics);
                b.baseGraphics.destroy();
            }
            if (b.barrelGraphics) {
                this.tweens.killTweensOf(b.barrelGraphics);
                b.barrelGraphics.destroy();
            }
            if (b.prismLaserGraphics) {
                this.tweens.killTweensOf(b.prismLaserGraphics);
                b.prismLaserGraphics.destroy();
            }
            if (b.prismLaserCore) {
                this.tweens.killTweensOf(b.prismLaserCore);
                b.prismLaserCore.destroy();
            }
            if (b.rangeIndicator) {
                this.tweens.killTweensOf(b.rangeIndicator);
                b.rangeIndicator.destroy();
            }
            this.tweens.killTweensOf(b.healthBar);
            b.healthBar.destroy();
        });
        this.buildings = [];
        this.combatTopologyRevision++;

        // The standard comes down with the village; the next world (home or
        // enemy) re-plants its own in applyWorldToScene/instantiateEnemyWorld.
        this.villageBannerMeta = null;
        this.hallBannerGfx?.destroy();
        this.hallBannerGfx = null;

        this.clearBattleActors();


        // Clear rubble and obstacles
        this.clearRubble();
        this.clearObstacles();

        // Reset selection state
        this.attackModeSelectedBuilding = null;
        this.selectedInWorld = null;
        this.selectedBuildingType = null;
        this.isMoving = false;
        this.ghostGridPos = null;
        this.hasDeployed = false;
        this.lastDeployTime = 0;
        this.deployStartTime = 0;
        this.replayDestroyedBuildings.clear();
        this.pendingSpawnCount = 0;
        this.raidEndScheduled = false;
        // Siege-tower ramps and the shared aura layer never outlive a battle.
        this.rampedWallsByOwner.PLAYER.clear();
        this.rampedWallsByOwner.ENEMY.clear();
        this.kitAuraGfx = null; // destroyed with the battle-FX sweep above

        // Clear all UI overlay graphics
        this.ghostBuilding.clear();
        this.ghostBuilding.setVisible(false);
        this.selectionGraphics.clear();
        this.deploymentGraphics.clear();
        this.deploymentGraphics.setVisible(false);
        this.forbiddenGraphics.clear();
        this.forbiddenGraphics.setVisible(false);
        this.deployZoneSignature = ''; // cleared out from under the geometry cache

        this.setVillageNameVisible(true);

        // Reset ground render texture - clear all baked building bases and redraw grass
        this.resetGroundTexture();

        // Update village name for new scene
        this.updateVillageName();
    }

    /**
     * Reset the ground render texture by clearing it and redrawing all grass tiles.
     * Call this when switching between villages to remove baked building bases.
     */
    private resetGroundTexture() {
        if (!this.groundRenderTexture || !this.tempGraphics) return;

        // Clear the entire texture
        this.groundRenderTexture.clear();

        // Redraw all grass tiles
        for (let x = 0; x < this.mapSize; x++) {
            for (let y = 0; y < this.mapSize; y++) {
                this.tempGraphics.clear();
                this.drawIsoTile(this.tempGraphics, x, y);
                this.groundRenderTexture.draw(this.tempGraphics, this.RT_OFFSET_X, this.RT_OFFSET_Y);
            }
        }
    }

    private instantiateEnemyWorld(
        world: SerializedWorld,
        meta: EnemyWorldMeta
    ): EnemyInstantiationSummary {
        const enemyBuildings = Array.isArray(world.buildings) ? world.buildings : [];
        const summary: EnemyInstantiationSummary = {
            requested: enemyBuildings.length,
            prepared: 0,
            placed: 0,
            playablePlaced: 0,
            skippedUnknownType: 0,
            skippedOutOfBounds: 0,
            failedInstantiation: 0
        };
        if (enemyBuildings.length === 0) return summary;

        const preparedBuildings: SerializedBuilding[] = [];
        enemyBuildings.forEach(rawBuilding => {
            const normalizedType = this.normalizeBuildingType(String((rawBuilding as { type?: unknown }).type ?? ''));
            if (!normalizedType) {
                summary.skippedUnknownType++;
                return;
            }

            const definition = BUILDINGS[normalizedType];
            const rawX = Number((rawBuilding as { gridX?: unknown }).gridX);
            const rawY = Number((rawBuilding as { gridY?: unknown }).gridY);
            if (!Number.isFinite(rawX) || !Number.isFinite(rawY)) {
                summary.skippedOutOfBounds++;
                return;
            }

            const gridX = Math.floor(rawX);
            const gridY = Math.floor(rawY);
            const inBounds = gridX >= 0 && gridY >= 0 && gridX + definition.width <= this.mapSize && gridY + definition.height <= this.mapSize;
            if (!inBounds) {
                summary.skippedOutOfBounds++;
                return;
            }

            const rawLevel = Number((rawBuilding as { level?: unknown }).level ?? 1);
            const level = Number.isFinite(rawLevel) ? Math.max(1, Math.floor(rawLevel)) : 1;
            const rawId = (rawBuilding as { id?: unknown }).id;
            const id = typeof rawId === 'string' && rawId.length > 0 ? rawId : Phaser.Utils.String.UUID();

            preparedBuildings.push({
                id,
                type: normalizedType as BuildingType,
                gridX,
                gridY,
                level
            });
        });
        summary.prepared = preparedBuildings.length;
        if (summary.prepared === 0) {
            console.warn('instantiateEnemyWorld: no valid enemy buildings after sanitization', {
                worldId: world.id,
                username: meta.username,
                summary
            });
            return summary;
        }

        this.currentEnemyWorld = meta;
        // A raided village still flies the DEFENDER's banner — their town
        // hall keeps their heraldry while the attacker's war camp plants ours.
        // ownerId (stable: player id / bot_<seed>) keys the identity default,
        // matching what the world-map postcard of the same village flies.
        this.villageBannerMeta = {
            identity: world.ownerId || meta.id,
            banner: world.banner ?? null
        };
        const lootAmount = Math.max(0, Math.floor(world.resources?.gold ?? 0));
        const lootOre = Math.max(0, Math.floor(world.resources?.ore ?? 0));
        const lootFood = Math.max(0, Math.floor(world.resources?.food ?? 0));
        // The battle HUD counter models the server settlement: capped pools ×
        // destruction%. No per-building loot split — that model drifted from
        // the real payout (see updateBattleStats).
        this.battleLootPools = LootSystem.calculateRaidablePools(
            preparedBuildings,
            lootAmount,
            lootOre,
            lootFood,
            meta.lootPreCapped === true
        );

        preparedBuildings.forEach(building => {
            try {
                const inst = this.instantiateBuilding(building, 'ENEMY');
                if (!inst) {
                    summary.failedInstantiation++;
                    return;
                }
                summary.placed++;
                if (inst.type !== 'wall') {
                    summary.playablePlaced++;
                }
            } catch (error) {
                summary.failedInstantiation++;
                console.error('instantiateEnemyWorld: building instantiation failed', {
                    worldId: world.id,
                    buildingId: building.id,
                    buildingType: building.type,
                    error
                });
            }
        });

        if (summary.playablePlaced > 0) {
            this.setVillageNameVisible(true);
            this.updateVillageName();
            // The enemy village goes about its day until the first troop lands.
            if (this.mode === 'ATTACK') {
                this.villageLife.populate('ENEMY', {
                    population: world.population?.count ?? world.life?.population,
                    identity: world.life?.identity || world.ownerId || meta.id,
                    bornAt: world.population?.bornAt ?? world.life?.bornAt
                });
            }
        } else {
            console.warn('instantiateEnemyWorld: enemy world had no playable buildings after instantiation', {
                worldId: world.id,
                username: meta.username,
                summary
            });
        }

        return summary;
    }

    /** Ask for a bot camp, focus its real plot, then use the local battle swap. */
    private async generateEnemyVillage(epoch?: number): Promise<boolean> {
        const started = await Backend.botStart();
        if (!started) {
            gameManager.showToast('No bot camp is available right now.');
            return false;
        }
        const username = started.world.username || 'Bot clan';
        const meta = {
            id: `bot_${started.seed >>> 0}`,
            username,
            isBot: true,
            attackId: started.raidId,
            botRaidId: started.raidId,
            botPlot: { x: started.x, y: started.y }
        };
        if (epoch === undefined || !this.isTransitionCurrent(epoch)) {
            await this.abortBotSession(meta);
            return false;
        }
        const plot = { x: started.x, y: started.y };
        this.worldMap.prepareFocus(plot);
        this.prepareGroundBake(meta.id);
        await this.arriveAndFight(plot, started.world, meta, epoch, {
            cameraArrivedAtGate: false,
            finishTransition: false
        });
        return this.mode === 'ATTACK' && this.currentEnemyWorld?.botRaidId === started.raidId;
    }

    // Matchmake against a random online player. The server snapshots the
    // defender's base and issues the attackId, so the fight is registered
    // before the first troop drops.
    public async generateOnlineEnemyVillage(epoch?: number): Promise<boolean> {
        const started = await Backend.startMatchedAttack();
        if (epoch !== undefined && !this.isTransitionCurrent(epoch)) {
            if (started?.attackId) void Backend.endAttack(started.attackId, 'aborted', 0, 0).catch(() => undefined);
            return false;
        }
        if (!started || !Array.isArray(started.world.buildings) || started.world.buildings.length === 0) {
            if (started?.attackId) await Backend.endAttack(started.attackId, 'aborted', 0, 0).catch(() => undefined);
            return false;
        }

        if (epoch === undefined) {
            await Backend.endAttack(started.attackId, 'aborted', 0, 0).catch(() => undefined);
            return false;
        }
        const plot = { x: started.target.x, y: started.target.y };
        const meta: EnemyWorldMeta = {
            id: started.world.ownerId,
            username: started.world.username || 'Unknown Player',
            isBot: false,
            attackId: started.attackId,
            lootPreCapped: true
        };
        this.worldMap.prepareFocus(plot);
        this.prepareGroundBake(meta.id);
        await this.arriveAndFight(plot, started.world, meta, epoch, {
            // Matchmade travel is covered by the cloud, but the destination is
            // still the canonical map plot and uses the local attack swap.
            cameraArrivedAtGate: false,
            finishTransition: false
        });
        return this.mode === 'ATTACK' && this.currentEnemyWorld?.attackId === started.attackId;
    }

    // Load a specific user's base (from leaderboard). When attacking, the
    // server opens the attack and returns its snapshot; when scouting it is a
    // plain read-only fetch.
    public async generateEnemyVillageFromUser(userId: string, username: string, forAttack: boolean, epoch?: number): Promise<boolean> {
        let userBase: SerializedWorld | null = null;
        let attackId: string | undefined;
        let startedAttack: Awaited<ReturnType<typeof Backend.startAttackOnUser>> = null;
        try {
            if (forAttack) {
                startedAttack = await Backend.startAttackOnUser(userId);
                userBase = startedAttack?.world ?? null;
                attackId = startedAttack?.attackId;
            } else {
                userBase = await Backend.loadFromCloud(userId);
            }
        } catch (error) {
            console.error('generateEnemyVillageFromUser: failed to load user base', { userId, error });
        }
        if (epoch !== undefined && !this.isTransitionCurrent(epoch)) {
            if (attackId) void Backend.endAttack(attackId, 'aborted', 0, 0).catch(() => undefined);
            return false;
        }
        if (!userBase || !Array.isArray(userBase.buildings) || userBase.buildings.length === 0) {
            // An explicit/revenge start is already live server-side at this
            // point. Never leave it orphaned just because its snapshot cannot
            // be presented locally.
            if (attackId) {
                await Backend.endAttack(attackId, 'aborted', 0, 0).catch(() => undefined);
            }
            return false;
        }

        if (forAttack) {
            if (!startedAttack || epoch === undefined) {
                if (attackId) await Backend.endAttack(attackId, 'aborted', 0, 0).catch(() => undefined);
                return false;
            }
            const plot = { x: startedAttack.target.x, y: startedAttack.target.y };
            const meta: EnemyWorldMeta = {
                id: userId,
                username: userBase.username || username,
                isBot: false,
                attackId: startedAttack.attackId,
                lootPreCapped: true
            };
            this.worldMap.prepareFocus(plot);
            this.prepareGroundBake(meta.id);
            await this.arriveAndFight(plot, userBase, meta, epoch, {
                cameraArrivedAtGate: false,
                finishTransition: false
            });
            return this.mode === 'ATTACK' && this.currentEnemyWorld?.attackId === startedAttack.attackId;
        }

        const summary = this.instantiateEnemyWorld(userBase, {
            id: userId,
            username: username,
            isBot: false,
            attackId: undefined,
            lootPreCapped: false
        });
        if (summary.playablePlaced === 0) {
            console.warn('generateEnemyVillageFromUser: loaded user base had no playable buildings', {
                userId,
                worldId: userBase.id,
                summary
            });
            await this.abandonCurrentAttack();
        }
        return summary.playablePlaced > 0;
    }

    /**
     * Settle a server-registered attack that ends without a battle (leaving,
     * NEXT button, failed load). No-op for bots, scouting, or attacks already
     * being resolved through the replay capture path.
     */
    private async abandonCurrentAttack(): Promise<void> {
        const attackId = this.currentEnemyWorld?.attackId;
        if (!attackId || this.currentEnemyWorld?.isBot) return;
        // A battle in progress, or one already settled by its end, must not be aborted.
        if (this.replayCaptureState && this.replayCaptureState.attackId === attackId) return;
        if (this.settledAttackIds.has(attackId)) return;
        this.settledAttackIds.add(attackId);
        this.currentEnemyWorld = this.currentEnemyWorld ? { ...this.currentEnemyWorld, attackId: undefined } : null;
        await Backend.endAttack(attackId, 'aborted', 0, 0).catch(error => {
            console.warn('Failed to abort attack:', error);
        });
    }

    private getReplayTroopType(type: string): TroopType | null {
        const normalized = String(type || '').trim().toLowerCase();
        if (!normalized) return null;
        if (Object.prototype.hasOwnProperty.call(TROOP_DEFINITIONS, normalized)) {
            return normalized as TroopType;
        }
        return null;
    }

    private clearReplayWatchState() {
        if (this.replayWatchState?.pollEvent) {
            this.replayWatchState.pollEvent.remove(false);
        }
        this.replayWatchState = null;
        this.replaySimulationTime = this.time.now;
        this.isApplyingReplayFrame = false;
        this.isApplyingReplayBaseline = false;
        this.replayAutoExitQueued = false;
        // Any auto-exit timer still pending belongs to the session that just
        // ended; the epoch bump strands it.
        this.replayWatchEpoch++;
        // Recorded playback may have accelerated tweens/timers to REPLAY_SPEED.
        this.tweens.timeScale = 1;
        this.time.timeScale = 1;
    }

    private queueReplayReturnHome(delayMs = 900) {
        if (this.replayAutoExitQueued) return;
        this.replayAutoExitQueued = true;
        const epoch = this.replayWatchEpoch;

        this.time.delayedCall(delayMs, () => {
            // A stale timer from a previous replay session must never yank the
            // player out of the replay they are watching NOW.
            if (epoch !== this.replayWatchEpoch) return;
            if (this.mode !== 'REPLAY') {
                this.replayAutoExitQueued = false;
                return;
            }

            this.showCloudTransition(async () => {
                await this.goHome();
            });
        });
    }

    private rebuildReplayFrameCursor(state: ReplayWatchState) {
        let index = 0;
        while (index < state.frames.length && state.frames[index].t <= state.lastAppliedFrameT) {
            index++;
        }
        state.nextFrameIndex = index;
    }

    private ingestReplayFrames(state: ReplayWatchState, incoming: ReplayFrameSnapshot[]) {
        if (!incoming || incoming.length === 0) return;

        const byT = new Map<number, ReplayFrameSnapshot>();
        for (const frame of state.frames) {
            byT.set(frame.t, frame);
        }
        for (const frame of incoming) {
            byT.set(frame.t, frame);
            if (frame.t > state.lastFetchedFrameT) {
                state.lastFetchedFrameT = frame.t;
            }
        }

        state.frames = Array.from(byT.values()).sort((a, b) => a.t - b.t);
        this.rebuildReplayFrameCursor(state);

        // Keep memory bounded while preserving a bit of already-played history.
        const maxFrames = 260;
        if (state.frames.length > maxFrames) {
            const keepFrom = Math.max(0, state.nextFrameIndex - 40);
            state.frames = state.frames.slice(keepFrom);
            this.rebuildReplayFrameCursor(state);
        }
    }

    private buildReplayFrameSnapshot(): ReplayFrameSnapshot {
        const startedAt = this.replayCaptureState?.startedAt ?? this.time.now;
        const { totalKnown } = this.getBattleTotals();
        const destruction = totalKnown > 0
            ? Math.min(100, Math.round((this.destroyedBuildings / totalKnown) * 100))
            : 0;
        const buildingStates = new Map<string, { id: string; health: number; isDestroyed: boolean }>();
        for (const building of this.buildings) {
            if (building.owner !== 'ENEMY') continue;
            buildingStates.set(building.id, {
                id: building.id,
                health: Math.max(0, Math.floor(building.health)),
                isDestroyed: Boolean(building.isDestroyed || building.health <= 0)
            });
        }
        // Terminal states remain present after their live Phaser objects were
        // removed, making destruction monotonic and visible to the server.
        for (const destroyed of this.replayDestroyedBuildings.values()) {
            buildingStates.set(destroyed.id, destroyed);
        }

        return {
            t: Math.max(0, Math.floor(this.time.now - startedAt)),
            destruction,
            goldLooted: Math.max(0, Math.floor(this.goldLooted)),
            oreLooted: Math.max(0, Math.floor(this.oreLooted)),
            foodLooted: Math.max(0, Math.floor(this.foodLooted)),
            buildings: Array.from(buildingStates.values()),
            troops: this.troops
                .filter(troop => troop.health > 0)
                .map(troop => ({
                    id: troop.id,
                    type: troop.type,
                    level: Math.max(1, Math.floor(troop.level || 1)),
                    owner: troop.owner,
                    gridX: troop.gridX,
                    gridY: troop.gridY,
                    health: Math.max(0, troop.health),
                    maxHealth: Math.max(1, troop.maxHealth),
                    facingAngle: troop.facingAngle,
                    hasTakenDamage: troop.hasTakenDamage
                }))
        };
    }

    private beginAttackReplayCapture() {
        if (!Auth.isOnlineMode()) return;
        if (this.mode !== 'ATTACK' || this.isScouting) return;
        if (!this.currentEnemyWorld || this.currentEnemyWorld.isBot || !this.currentEnemyWorld.attackId) return;
        if (this.replayCaptureState && this.replayCaptureState.attackId === this.currentEnemyWorld.attackId) return;

        // The server registered the attack (and snapshotted the base) when it
        // was loaded, so capture just means streaming frames from here on.
        Backend.beginReplayCapture(this.currentEnemyWorld.attackId);
        this.replayCaptureState = {
            attackId: this.currentEnemyWorld.attackId,
            victimId: this.currentEnemyWorld.id,
            startedAt: this.time.now,
            startedRemotely: true,
            framePushInFlight: false,
            lastFramePushAt: -Infinity,
            ended: false
        };
        this.maybePushReplayFrame(true);
    }

    private maybePushReplayFrame(force: boolean = false) {
        const state = this.replayCaptureState;
        if (!state || state.ended) return;

        const now = this.time.now;
        // Live viewers interpolate between samples, so long battles do not
        // benefit from publishing multi-kilobyte snapshots at a fixed 6fps.
        // Thin the routine stream as it ages; forced destruction/final frames
        // still bypass this cadence and preserve important state changes.
        const battleAge = Math.max(0, now - state.startedAt);
        const interval = battleAge < 30_000 ? 500 : battleAge < 90_000 ? 1000 : 2000;
        if (!force && now - state.lastFramePushAt < interval) return;
        state.lastFramePushAt = now;

        // Frames are buffered client-side and shipped in ~1s batches.
        Backend.pushAttackReplayFrame(state.attackId, this.buildReplayFrameSnapshot());
    }

    private endAttackReplayCapture(status: 'finished' | 'aborted'): Promise<AttackEndResult | null> | null {
        const state = this.replayCaptureState;
        if (!state || state.ended) return this.pendingAttackSettlement;
        state.ended = true;
        const finalFrame = this.buildReplayFrameSnapshot();
        this.replayCaptureState = null;

        // This attack is now settled; block any later abandon from re-settling it.
        this.settledAttackIds.add(state.attackId);
        Backend.pushAttackReplayFrame(state.attackId, finalFrame);
        // Settles loot + trophies and notifies the defender, exactly once.
        const settlement = Backend.endAttack(state.attackId, status, finalFrame.destruction, finalFrame.goldLooted, finalFrame.oreLooted ?? 0, finalFrame.foodLooted ?? 0);
        this.pendingAttackSettlement = settlement;
        void settlement.finally(() => {
            if (this.pendingAttackSettlement === settlement) this.pendingAttackSettlement = null;
        }).catch(() => undefined);
        return settlement;
    }

    private createReplayTroop(snapshot: ReplayTroopSnapshot): Troop | undefined {
        const troopType = this.getReplayTroopType(snapshot.type);
        if (!troopType) return undefined;
        const troopLevel = Math.max(1, Math.floor(snapshot.level || 1));
        const stats = getTroopStats(troopType, troopLevel);
        const attackDelay = stats.attackDelay ?? 900;

        const pos = IsoUtils.cartToIso(snapshot.gridX, snapshot.gridY);
        const troopGraphic = this.add.graphics();
        troopGraphic.setPosition(pos.x, pos.y);
        troopGraphic.setDepth(depthForTroop(snapshot.gridX, snapshot.gridY, troopType));
        if (!SpriteBank.syncLooseTroop(this, troopGraphic, troopType, snapshot.owner, troopLevel, snapshot.facingAngle ?? 0, true, this.animClockNow())) {
            TroopRenderer.drawTroopVisual(
                troopGraphic,
                troopType,
                snapshot.owner,
                snapshot.facingAngle ?? 0,
                true,
                0,
                0,
                false,
                0,
                snapshot.level,
                this.animClockNow()
            );
        }

        const troop: Troop = {
            id: snapshot.id,
            type: troopType,
            level: troopLevel,
            gameObject: troopGraphic,
            healthBar: this.createHealthBarGraphics(),
            gridX: snapshot.gridX,
            gridY: snapshot.gridY,
            health: Math.max(0, snapshot.health),
            maxHealth: Math.max(1, snapshot.maxHealth),
            target: null,
            owner: snapshot.owner,
            lastAttackTime: this.replaySimulationTime - attackDelay,
            attackDelay,
            speedMult: 0,
            hasTakenDamage: Boolean(snapshot.hasTakenDamage),
            facingAngle: snapshot.facingAngle ?? 0,
            replayPrevSampleX: snapshot.gridX,
            replayPrevSampleY: snapshot.gridY,
            replayPrevSampleT: 0,
            replaySampleX: snapshot.gridX,
            replaySampleY: snapshot.gridY,
            replaySampleT: 0,
        };
        // Kit visual parity: the frame stream carries no kit state, so the
        // hawk-eye cloak window re-derives from first appearance (a deploy
        // shows up within a frame of its real time). Health stays authorial.
        if (stats.untargetableMs) {
            troop.untargetableUntil = this.replaySimulationTime + stats.untargetableMs;
        }
        return troop;
    }

    /**
     * Lightweight death poof for troops the replay stream removed. The full
     * local death FX live in destroyTroop, which frame-driven removals bypass
     * entirely — without this they blink out of existence mid-battle.
     */
    private showReplayTroopDeath(t: Troop) {
        // The stone golem keeps its bespoke collapse in replay watch too —
        // the helper is purely visual, so the frame stream stays in charge.
        if (t.type === 'golem') {
            this.playStoneGolemDeath(t);
            return;
        }
        // Ice golem: the recorded battle already simulated the freeze (its
        // defenses fall silent in the frame stream on their own) — replay
        // watch replays the shatter + icy dressing so the pause reads.
        // frozenUntil here only silences locally-generated defense FX.
        if (t.type === 'icegolem') {
            this.showIceGolemShatterFx(t, IsoUtils.cartToIso(t.gridX, t.gridY));
            this.applyIceGolemFreezeBurst(t);
            return;
        }
        const pos = IsoUtils.cartToIso(t.gridX, t.gridY);

        const flash = this.trackBattleFx(this.add.graphics());
        pixelRect(flash, -5, -5, 10, 10, 0xffffff, 0.85);
        flash.setPosition(pos.x, pos.y - 8);
        flash.setDepth(30001);
        this.tweens.add({ targets: flash, scale: 1.8, alpha: 0, duration: 120, onComplete: () => flash.destroy() });

        for (let i = 0; i < 6; i++) {
            const angle = (i / 6) * Math.PI * 2;
            const particle = this.trackBattleFx(this.add.graphics());
            pixelRect(particle, -2, -2, 4, 4, i % 2 === 0 ? 0xffcc66 : 0xd8d8d8, 0.9);
            particle.setPosition(pos.x, pos.y - 8);
            particle.setDepth(30000);
            this.tweens.add({
                targets: particle,
                x: pos.x + Math.cos(angle) * 18,
                y: pos.y - 8 + Math.sin(angle) * 10 - 10,
                alpha: 0, scale: 0.4,
                duration: 240,
                ease: 'Quad.easeOut',
                onComplete: () => particle.destroy()
            });
        }

        const smoke = this.trackBattleFx(this.add.graphics());
        pixelRect(smoke, -8, -8, 16, 16, 0x666666, 0.5);
        smoke.setPosition(pos.x, pos.y - 6);
        smoke.setDepth(29999);
        this.tweens.add({ targets: smoke, y: pos.y - 24, scale: 1.7, alpha: 0, duration: 350, onComplete: () => smoke.destroy() });
    }

    private applyReplayFrame(frame: ReplayFrameSnapshot) {
        const buildingById = new Map(frame.buildings.map(entry => [entry.id, entry]));

        this.isApplyingReplayFrame = true;
        try {
            const enemyBuildings = this.buildings.filter(building => building.owner === 'ENEMY');
            for (const building of enemyBuildings) {
                const state = buildingById.get(building.id);
                const shouldDestroy = !state || state.isDestroyed || Number(state.health) <= 0;
                if (shouldDestroy) {
                    this.destroyBuilding(building);
                    continue;
                }

                const nextHealth = Math.max(0, Math.min(building.maxHealth, Math.floor(state.health)));
                building.health = nextHealth;
                building.isDestroyed = false;
                building.graphics.setVisible(true);
                building.baseGraphics?.setVisible(true);
                building.barrelGraphics?.setVisible(true);
                building.prismLaserGraphics?.setVisible(true);
                building.prismLaserCore?.setVisible(true);
                this.updateHealthBar(building);
            }

            const existingTroops = new Map(this.troops.map(troop => [troop.id, troop]));
            const nextTroops: Troop[] = [];
            const frameT = Math.max(0, Math.floor(Number(frame.t) || 0));
            frame.troops.forEach(snapshot => {
                const troopType = this.getReplayTroopType(snapshot.type);
                if (!troopType) return;

                let troop = existingTroops.get(snapshot.id);
                const wasExisting = Boolean(troop);
                if (!troop) {
                    troop = this.createReplayTroop({ ...snapshot, type: troopType });
                    if (!troop) return;
                }
                existingTroops.delete(snapshot.id);

                troop.type = troopType;
                troop.level = Math.max(1, Math.floor(snapshot.level || 1));
                troop.owner = snapshot.owner;
                troop.health = Math.max(0, snapshot.health);
                troop.maxHealth = Math.max(1, snapshot.maxHealth);
                troop.hasTakenDamage = snapshot.hasTakenDamage ?? troop.health < troop.maxHealth;
                troop.facingAngle = Number.isFinite(snapshot.facingAngle) ? Number(snapshot.facingAngle) : troop.facingAngle;
                const troopStats = getTroopStats(troop.type, troop.level);
                troop.attackDelay = troopStats.attackDelay ?? troop.attackDelay;
                if (!Number.isFinite(troop.lastAttackTime) || troop.lastAttackTime <= 0) {
                    troop.lastAttackTime = this.replaySimulationTime - troop.attackDelay;
                }

                const sampleX = Number(snapshot.gridX) || 0;
                const sampleY = Number(snapshot.gridY) || 0;
                const prevSampleT = Number(troop.replaySampleT);
                const hadPrevSample = Number.isFinite(prevSampleT) && prevSampleT >= 0;

                if (!wasExisting || !hadPrevSample) {
                    troop.gridX = sampleX;
                    troop.gridY = sampleY;
                    troop.replayPrevSampleX = sampleX;
                    troop.replayPrevSampleY = sampleY;
                    troop.replayPrevSampleT = frameT;
                    troop.replaySampleX = sampleX;
                    troop.replaySampleY = sampleY;
                    troop.replaySampleT = frameT;
                } else {
                    // Slide the bracketing pair forward: the smoothing loop
                    // interpolates between these two samples on the stream clock.
                    troop.replayPrevSampleX = Number.isFinite(troop.replaySampleX) ? Number(troop.replaySampleX) : troop.gridX;
                    troop.replayPrevSampleY = Number.isFinite(troop.replaySampleY) ? Number(troop.replaySampleY) : troop.gridY;
                    troop.replayPrevSampleT = prevSampleT;
                    troop.replaySampleX = sampleX;
                    troop.replaySampleY = sampleY;
                    troop.replaySampleT = frameT;
                }

                if (!wasExisting) {
                    const pos = IsoUtils.cartToIso(troop.gridX, troop.gridY);
                    troop.gameObject.setPosition(pos.x, pos.y);
                    troop.gameObject.setDepth(depthForTroop(troop.gridX, troop.gridY, troop.type));
                    // Summon parity: a skeleton materializing mid-stream gets
                    // the necromancer grave-light poof (baseline joins silent).
                    if (troop.type === 'skeleton' && !this.isApplyingReplayBaseline
                        && !this.isOffScreen(troop.gridX, troop.gridY)) {
                        this.trackBattleFx(PixelFx.flash(this, pos.x, pos.y - 8, {
                            r: 5, color: 0xb08aff, alpha: 0.85, scaleTo: 1.6, life: 200, depth: 30001
                        }));
                    }
                }
                troop.gameObject.setVisible(troop.health > 0);

                if (troop.health <= 0) {
                    troop.healthBar.setVisible(false);
                } else {
                    this.updateHealthBar(troop);
                }
                nextTroops.push(troop);
            });

            existingTroops.forEach(troop => {
                // The stream dropped this troop — it died between frames. A
                // baseline frame rebuilding mid-battle state on join stays
                // silent; live playback shows a small death poof.
                if (!this.isApplyingReplayBaseline && troop.health > 0 && !this.isOffScreen(troop.gridX, troop.gridY)) {
                    this.showReplayTroopDeath(troop);
                }
                troop.gameObject.destroy();
                troop.healthBar.destroy();
            });
            this.troops = nextTroops;
        } finally {
            this.isApplyingReplayFrame = false;
        }

        const destruction = Math.max(0, Math.min(100, Math.floor(frame.destruction)));
        this.goldLooted = Math.max(0, Math.floor(frame.goldLooted));
        this.oreLooted = Math.max(0, Math.floor(frame.oreLooted ?? 0));
        this.foodLooted = Math.max(0, Math.floor(frame.foodLooted ?? 0));
        this.destroyedBuildings = Math.max(0, Math.round((destruction / 100) * Math.max(1, this.initialEnemyBuildings)));
        gameManager.updateBattleStats(destruction, this.goldLooted, this.oreLooted, this.foodLooted);
    }

    /**
     * Troop motion between stream frames: a pure interpolation between the
     * two samples that bracket the render clock. If the clock reaches the
     * newest sample (buffer dry), troops HOLD there — never extrapolated,
     * never snapped back. A short exponential smoothing eats sub-tile
     * correction noise; a genuinely new position (teleport in the data) is
     * trusted immediately.
     */
    private updateReplayTroopSmoothing(delta: number) {
        if (this.mode !== 'REPLAY') return;
        const replay = this.replayWatchState;
        if (!replay) return;
        const renderT = replay.renderClockT;

        // Forward bracket: frames apply once t ≤ renderT, so the pair that
        // brackets the clock is (last applied sample, first UNAPPLIED frame).
        // Peek that pending frame — rebuilt only when its t changes.
        const pending = replay.nextFrameIndex < replay.frames.length
            ? replay.frames[replay.nextFrameIndex]
            : null;
        if (!pending) {
            replay.nextSampleT = undefined;
            replay.nextSamples = undefined;
        } else if (replay.nextSampleT !== pending.t || !replay.nextSamples) {
            replay.nextSampleT = pending.t;
            replay.nextSamples = new Map(pending.troops.map(snapshot => [
                snapshot.id,
                { x: Number(snapshot.gridX) || 0, y: Number(snapshot.gridY) || 0 }
            ]));
        }

        for (const troop of this.troops) {
            if (troop.health <= 0) continue;

            const sampleX = Number(troop.replaySampleX);
            const sampleY = Number(troop.replaySampleY);
            const sampleT = Number(troop.replaySampleT);
            if (!Number.isFinite(sampleX) || !Number.isFinite(sampleY) || !Number.isFinite(sampleT)) continue;

            const prevX = Number.isFinite(troop.replayPrevSampleX) ? Number(troop.replayPrevSampleX) : sampleX;
            const prevY = Number.isFinite(troop.replayPrevSampleY) ? Number(troop.replayPrevSampleY) : sampleY;
            const prevT = Number.isFinite(troop.replayPrevSampleT) ? Number(troop.replayPrevSampleT) : sampleT;

            const nextSample = replay.nextSamples?.get(troop.id);
            const nextT = replay.nextSampleT;

            let targetX = sampleX;
            let targetY = sampleY;
            let bracketed = false;
            if (nextSample && nextT !== undefined && nextT > sampleT + 0.5 && renderT >= sampleT) {
                // The steady state: glide toward where the NEXT frame says this
                // troop will be, in exact step with the stream clock.
                const alphaT = Phaser.Math.Clamp((renderT - sampleT) / (nextT - sampleT), 0, 1);
                targetX = Phaser.Math.Linear(sampleX, nextSample.x, alphaT);
                targetY = Phaser.Math.Linear(sampleY, nextSample.y, alphaT);
                bracketed = true;
            } else if (renderT < sampleT && sampleT > prevT + 0.5) {
                // Clock still behind the newest applied sample (seek/baseline
                // join): interpolate on the applied pair instead.
                const alphaT = Phaser.Math.Clamp((renderT - prevT) / (sampleT - prevT), 0, 1);
                targetX = Phaser.Math.Linear(prevX, sampleX, alphaT);
                targetY = Phaser.Math.Linear(prevY, sampleY, alphaT);
                bracketed = true;
            }

            const prevRenderX = troop.gridX;
            const prevRenderY = troop.gridY;
            const errorDist = Phaser.Math.Distance.Between(prevRenderX, prevRenderY, targetX, targetY);
            if (errorDist > 2.5 && !bracketed) {
                // Genuinely unbracketed (buffer dry / fresh spawn) and far off:
                // trust the data outright.
                troop.gridX = targetX;
                troop.gridY = targetY;
            } else if (errorDist > 0.0001) {
                // Bracketed motion rides the lerped target; the short
                // exponential chase only eats sub-tile correction noise.
                const follow = 1 - Math.exp(-delta / 70);
                troop.gridX = Phaser.Math.Linear(prevRenderX, targetX, follow);
                troop.gridY = Phaser.Math.Linear(prevRenderY, targetY, follow);
            }

            const motionDx = troop.gridX - prevRenderX;
            const motionDy = troop.gridY - prevRenderY;
            const motionDist = Math.sqrt(motionDx * motionDx + motionDy * motionDy);
            if (motionDist > 0.0007) {
                const desiredAngle = Math.atan2(motionDy, motionDx);
                const currentAngle = Number.isFinite(troop.facingAngle) ? troop.facingAngle : desiredAngle;
                let angleDiff = desiredAngle - currentAngle;
                while (angleDiff > Math.PI) angleDiff -= Math.PI * 2;
                while (angleDiff < -Math.PI) angleDiff += Math.PI * 2;
                troop.facingAngle = currentAngle + angleDiff * 0.35;
            }

            const pos = IsoUtils.cartToIso(troop.gridX, troop.gridY);
            troop.gameObject.setPosition(pos.x, pos.y);
            const troopDepth = Math.round(depthForTroop(troop.gridX, troop.gridY, troop.type));
            if (troopDepth !== troop.lastDepth) {
                troop.lastDepth = troopDepth;
                troop.gameObject.setDepth(troopDepth);
            }

            // Kit visual parity in replay watch (the stream carries no kit
            // state): hawk-eye cloak shimmer on the replay clock, and the
            // siege tower eases into its parked pose once its samples go
            // still — both purely presentational, frames own everything else.
            const replayClock = this.animClockNow();
            if (troop.untargetableUntil !== undefined) {
                if (replayClock < troop.untargetableUntil) {
                    troop.gameObject.setAlpha(0.55 + 0.07 * Math.sin(replayClock / 150));
                } else {
                    troop.untargetableUntil = undefined;
                    troop.gameObject.setAlpha(1);
                }
            }
            if (troop.type === 'siegetower') {
                if (motionDist > 0.004) {
                    troop.replayStillSince = undefined;
                    troop.parked01 = undefined;
                } else {
                    if (troop.replayStillSince === undefined) troop.replayStillSince = replayClock;
                    if (replayClock - troop.replayStillSince > 900) {
                        troop.parked01 = Math.min(1, (troop.parked01 ?? 0) + delta / 700);
                    }
                }
            }

            const moving = errorDist > 0.05 || motionDist > 0.001;
            const onScreen = !this.isOffScreen(troop.gridX, troop.gridY);
            if (onScreen) {
                // Every troop type carries per-frame kit/walk/idle animation
                // now — the old handwritten whitelist silently froze any type
                // it missed, so it repaints unconditionally.
                this.redrawTroopWithMovement(troop, moving);
            }

            this.updateHealthBar(troop);
        }
    }

    private async startReplayWatch(attackId: string, mode: ReplayWatchMode): Promise<boolean> {
        let replay: AttackReplayState | null = mode === 'live'
            ? await Backend.getLiveAttackState(attackId)
            : await Backend.getAttackReplay(attackId);

        if (!replay && mode === 'live') {
            replay = await Backend.getAttackReplay(attackId);
        }

        if (!replay || !replay.enemyWorld || !Array.isArray(replay.enemyWorld.buildings) || replay.enemyWorld.buildings.length === 0) {
            return false;
        }

        this.clearReplayWatchState();

        // The battlefield wears the DEFENDER's lawn, exactly as the attacker
        // saw it (arriveAndFight commits the same palette before instantiating
        // the enemy world — building bases bake into this texture).
        this.rebakeGround(replay.victimId || 'village');

        const summary = this.instantiateEnemyWorld(replay.enemyWorld, {
            id: replay.victimId,
            username: replay.victimName || replay.enemyWorld.username || 'Village',
            isBot: true,
            attackId: replay.attackId,
            lootPreCapped: true
        });
        if (summary.playablePlaced === 0) return false;

        this.mode = 'REPLAY';
        this.isScouting = true;
        this.hasDeployed = false;
        this.raidEndScheduled = false;
        this.pendingSpawnCount = 0;
        this.initialEnemyBuildings = this.getAttackEnemyBuildings().length;
        this.destroyedBuildings = 0;
        this.goldLooted = 0;
        this.oreLooted = 0;
        this.foodLooted = 0;
        gameManager.updateBattleStats(0, 0);
        this.setVillageNameVisible(true);
        this.updateVillageName();
        this.replaySimulationTime = this.time.now;

        const watchState: ReplayWatchState = {
            attackId: replay.attackId,
            mode,
            renderClockT: 0,
            clockStarted: false,
            nextFrameIndex: 0,
            lastAppliedFrameT: -1,
            lastFetchedFrameT: -1,
            status: replay.status,
            pollInFlight: false,
            frames: []
        };
        this.replayWatchState = watchState;

        if (mode === 'replay') {
            // The recorded sim plays at REPLAY_SPEED; projectile/effect tweens
            // and battle timers must ride the same rate or they trail the
            // frames they illustrate. Restored by clearReplayWatchState.
            this.tweens.timeScale = this.REPLAY_SPEED;
            this.time.timeScale = this.REPLAY_SPEED;

            const replayFrames = replay.frames ?? [];
            const replayTimeOffset = replayFrames.length > 0 ? replayFrames[0].t : 0;
            const normalizedFrames = replayFrames.map(frame => ({
                ...frame,
                t: Math.max(0, frame.t - replayTimeOffset)
            }));
            this.ingestReplayFrames(watchState, normalizedFrames);

            if (watchState.frames.length > 0) {
                this.isApplyingReplayBaseline = true;
                try {
                    this.applyReplayFrame(watchState.frames[0]);
                } finally {
                    this.isApplyingReplayBaseline = false;
                }
                watchState.nextFrameIndex = 1;
                watchState.lastAppliedFrameT = watchState.frames[0].t;
                watchState.renderClockT = watchState.frames[0].t;
                watchState.clockStarted = true;
            } else {
                this.queueReplayReturnHome(700);
            }
            return true;
        }

        const initialFrames: ReplayFrameSnapshot[] = [];
        if (Array.isArray(replay.frames) && replay.frames.length > 0) {
            initialFrames.push(...replay.frames);
        }
        if (replay.latestFrame) {
            initialFrames.push(replay.latestFrame);
        }
        this.ingestReplayFrames(watchState, initialFrames);

        if (watchState.frames.length > 0) {
            // Join at the live edge minus the jitter buffer: apply the newest
            // frame at or before the join point as the baseline and play on
            // from there — never race the whole battle to catch up.
            const headT = watchState.frames[watchState.frames.length - 1].t;
            const joinT = Math.max(watchState.frames[0].t, headT - this.REPLAY_LIVE_DELAY_MS);
            let baseline = 0;
            while (baseline + 1 < watchState.frames.length && watchState.frames[baseline + 1].t <= joinT) baseline += 1;
            // Catch-up state, not live events: buildings already destroyed
            // before the join must not all detonate at once.
            this.isApplyingReplayBaseline = true;
            try {
                this.applyReplayFrame(watchState.frames[baseline]);
            } finally {
                this.isApplyingReplayBaseline = false;
            }
            watchState.lastAppliedFrameT = watchState.frames[baseline].t;
            watchState.nextFrameIndex = baseline + 1;
            watchState.renderClockT = joinT;
            watchState.clockStarted = true;
        } else if (watchState.status !== 'live') {
            this.queueReplayReturnHome(700);
        }

        watchState.pollEvent = this.time.addEvent({
            delay: this.REPLAY_LIVE_POLL_INTERVAL_MS,
            loop: true,
            callback: () => {
                const current = this.replayWatchState;
                if (!current || current.attackId !== watchState.attackId || current.mode !== 'live') return;
                if (current.pollInFlight) return;
                current.pollInFlight = true;

                void Backend.getLiveAttackState(current.attackId, current.lastFetchedFrameT)
                    .then(next => {
                        const active = this.replayWatchState;
                        if (!active || active.attackId !== current.attackId || active.mode !== 'live') return;
                        if (!next) {
                            this.queueReplayReturnHome(900);
                            return;
                        }

                        active.status = next.status;
                        const incoming: ReplayFrameSnapshot[] = [];
                        if (Array.isArray(next.frames) && next.frames.length > 0) {
                            incoming.push(...next.frames);
                        }
                        if (next.latestFrame && next.latestFrame.t > active.lastFetchedFrameT) {
                            incoming.push(next.latestFrame);
                        }
                        this.ingestReplayFrames(active, incoming);

                        if (next.status !== 'live' && active.pollEvent) {
                            active.pollEvent.remove(false);
                            active.pollEvent = undefined;
                            if (active.nextFrameIndex >= active.frames.length) {
                                this.queueReplayReturnHome(900);
                            }
                        }
                    })
                    .catch(error => {
                        console.warn('Live replay poll failed:', error);
                    })
                    .finally(() => {
                        const active = this.replayWatchState;
                        if (active && active.attackId === current.attackId) {
                            active.pollInFlight = false;
                        }
                    });
            }
        });

        return true;
    }

    /**
     * The stream clock. Live spectating rides a fixed jitter buffer behind
     * the newest frame: the clock never races ahead (no extrapolation, ever)
     * and never rubber-bands — it adapts its rate within ±15%, and if the
     * buffer runs dry (a network stall) it eases into a clean hold on the
     * last frame until data arrives. Recorded replays run the same pipeline
     * at a fixed speed. Defences, animations and combat visuals all share
     * this one clock, so nothing in the scene can drift apart.
     */
    private updateReplayWatchPlayback(time: number, delta: number) {
        const replay = this.replayWatchState;
        if (!replay) return;
        void time;

        const frames = replay.frames;
        if (frames.length === 0) {
            if (replay.mode === 'replay' || replay.status !== 'live') this.queueReplayReturnHome(900);
            return;
        }

        if (!replay.clockStarted) {
            replay.renderClockT = frames[0].t;
            replay.clockStarted = true;
        }

        const headT = frames[frames.length - 1].t;
        if (replay.mode === 'live' && replay.status === 'live') {
            const lead = headT - replay.renderClockT;
            // Gentle rate control toward the target buffer depth...
            let rate = Phaser.Math.Clamp(1 + (lead - this.REPLAY_LIVE_DELAY_MS) / 4000, 0.85, 1.15);
            // ...and a smooth-stepped hold when the buffer is nearly dry.
            const fuel = Phaser.Math.Clamp(lead / 350, 0, 1);
            rate *= fuel * fuel * (3 - 2 * fuel);
            replay.renderClockT += delta * rate;
        } else {
            replay.renderClockT = Math.min(headT, replay.renderClockT + delta * this.REPLAY_SPEED);
        }

        while (replay.nextFrameIndex < frames.length) {
            const frame = frames[replay.nextFrameIndex];
            if (frame.t > replay.renderClockT) break;
            this.applyReplayFrame(frame);
            replay.lastAppliedFrameT = frame.t;
            replay.nextFrameIndex += 1;
        }

        // One clock for everything that moves during a replay.
        this.replaySimulationTime = replay.renderClockT;

        // A recorded replay never polls, so its status can be frozen at 'live'
        // (battle still running when fetched) — exhausting its frames is
        // terminal for it regardless of that stale status.
        const playbackDone = replay.mode === 'replay' || replay.status !== 'live';
        if (playbackDone && replay.renderClockT >= headT && replay.nextFrameIndex >= frames.length) {
            this.queueReplayReturnHome(1100);
        }
    }


    public createSmokeEffect(x: number, y: number, depth: number = 10005) {
        particleManager.emitDustBurst(x, y, depth);
    }

    private shootDragonsBreathAt(db: PlacedBuilding, troop: Troop) {
        const stats = this.getDefenseStats(db);
        const range = stats.range || 13;
        const dbInfo = BUILDINGS['dragons_breath'];
        // Range is measured from the FOOTPRINT CENTER — the drawn range ring
        // is. Measuring from the corner shifted the salvo's reach half a
        // footprint north-west, hitting troops outside the ring on two sides.
        const dbCenterX = db.gridX + dbInfo.width / 2;
        const dbCenterY = db.gridY + dbInfo.height / 2;

        // Find all potential targets in range to distribute pods
        const potentialTargets = this.troops.filter(t =>
            t.owner !== db.owner &&
            t.health > 0 &&
            Phaser.Math.Distance.Between(dbCenterX, dbCenterY, t.gridX, t.gridY) <= range
        );

        // A soft rumble as the salvo begins
        this.cameras.main.shake(60, 0.0012);

        // One rocket per silo — the catalog's fire model is the single source
        // for the volley size (the UI derives its DPS from the same number).
        const salvoSize = DEFENSE_BEHAVIOR_CATALOG.dragons_breath.fireModel.salvoSize;
        for (let i = 0; i < salvoSize; i++) {
            this.scheduleBattleCall(i * 50, () => {
                if (!db || db.health <= 0) return;

                // Cycle through targets if we have them, otherwise fallback to the primary target
                const target = potentialTargets.length > 0
                    ? potentialTargets[i % potentialTargets.length]
                    : troop;

                if (target && target.health > 0) {
                    const jitterX = (Math.random() - 0.5) * 2.0;
                    const jitterY = (Math.random() - 0.5) * 2.0;
                    // Launch from this pod's actual silo so the standing rocket
                    // (hidden by the renderer at this exact moment) visibly
                    // becomes the projectile — no teleporting.
                    const col = i % 4;
                    const row = Math.floor(i / 4);
                    const siloGX = db.gridX + col + 0.5;
                    const siloGY = db.gridY + row + 0.5;
                    const silo = IsoUtils.cartToIso(siloGX, siloGY);
                    this.shootDragonPod(db, { x: silo.x, y: silo.y + 2 - 14 }, siloGX, siloGY, target.gridX + jitterX, target.gridY + jitterY, stats.damage || 25);
                }
            });
        }
    }

    private shootDragonPod(db: PlacedBuilding, start: { x: number, y: number }, launchGridX: number, launchGridY: number, targetGridX: number, targetGridY: number, damage: number) {
        const end = IsoUtils.cartToIso(targetGridX, targetGridY);
        const dbLevel = db.level ?? 1;

        // Create firecracker rocket graphics, standing exactly where the
        // silo's rocket was drawn. Painter's-order depth from the silo tile
        // now, along the ground track during the arc.
        const pod = this.trackBattleFx(this.add.graphics());
        const startX = start.x;
        const startY = start.y;
        pod.setPosition(startX, startY);
        pod.setDepth(depthForProjectile(launchGridX, launchGridY));

        // Draw the rocket EXACTLY like the pod standing in the silo (see
        // BuildingRenderer.drawDragonsBreath), so launch is seamless. The
        // shape lives in ProjectileRenderer (clears + redraws per call); the
        // flame is currently steady, so the per-frame flicker input is 0.
        const drawRocket = () => {
            ProjectileRenderer.drawDragonRocket(pod, dbLevel, 0);
        };

        // Initial draw: upright on the pad (baked stamp when the atlas has
        // this rocket; the vector redraw-per-frame path otherwise).
        const rocketLevel = dbLevel >= 2 ? 2 : 1;
        const podBaked = this.syncProjectileSprite(pod, 'dragon_rocket', rocketLevel, 0);
        if (!podBaked) drawRocket();
        pod.setRotation(0);

        // PHASE 1 — LIFTOFF: the rocket climbs straight out of its silo on a
        // building flame before tipping over into its arc.
        const riseY = startY - 52;
        this.tweens.add({
            targets: pod,
            y: riseY,
            duration: 230,
            ease: 'Quad.easeIn',
            onUpdate: () => {
                if (podBaked) this.syncProjectileSprite(pod, 'dragon_rocket', rocketLevel, 0);
                else drawRocket();
                if (Math.random() > 0.5) {
                    const blast = this.trackBattleFx(this.add.graphics());
                    const blastR = 2 + Math.random() * 2;
                    pixelEllipse(blast, 0, 0, blastR, blastR, 0xffaa33, 0.7);
                    blast.setPosition(pod.x + (Math.random() - 0.5) * 5, pod.y + 14);
                    blast.setDepth(pod.depth - 1);
                    this.tweens.add({ targets: blast, alpha: 0, y: blast.y + 8, duration: 180, onComplete: () => blast.destroy() });
                }
            },
            onComplete: () => flyArc()
        });

        const flyArc = () => {
        const arcStartY = riseY;
        const midY = (arcStartY + end.y) / 2 - 200; // Arc height
        const dist = Phaser.Math.Distance.Between(startX, arcStartY, end.x, end.y);
        let lastX = startX;
        let lastY = arcStartY;
        let lastEmberAt = 0;

        this.tweens.add({
            targets: pod,
            x: end.x,
            duration: dist / 0.4 + Math.random() * 100,
            ease: 'Linear',
            onUpdate: (tween) => {
                const t = tween.progress;
                // Bezier curve for arc
                pod.y = (1 - t) * (1 - t) * arcStartY + 2 * (1 - t) * t * midY + t * t * end.y;

                // Depth follows the ground track under the rocket's arc.
                pod.setDepth(depthForProjectile(
                    launchGridX + (targetGridX - launchGridX) * t,
                    launchGridY + (targetGridY - launchGridY) * t));
                // The rocket stays a rocket all the way down its arc.
                const angle = Math.atan2(pod.y - lastY, pod.x - lastX);
                pod.setRotation(angle + Math.PI / 2);
                if (podBaked) this.syncProjectileSprite(pod, 'dragon_rocket', rocketLevel, angle + Math.PI / 2);
                else drawRocket();

                // A tight ember ribbon — uniform glowing motes, no grey smog.
                const now = this.time.now;
                if (now - lastEmberAt > 26) {
                    lastEmberAt = now;
                    const ember = this.trackBattleFx(this.add.graphics());
                    ember.setBlendMode(Phaser.BlendModes.ADD);
                    pixelEllipse(ember, 0, 0, 2.2, 2.2, 0xffa14a, 0.8);
                    ember.setPosition(pod.x, pod.y + 4);
                    ember.setDepth(pod.depth - 1);
                    this.tweens.add({
                        targets: ember,
                        y: ember.y - 5,
                        alpha: 0,
                        scale: 0.2,
                        duration: 240,
                        ease: 'Quad.easeOut',
                        onComplete: () => ember.destroy()
                    });
                }

                lastX = pod.x;
                lastY = pod.y;
            },
            onComplete: () => {
                pod.destroy();
                this.cameras.main.shake(85, 0.0016);
                // Impact layers sort with the world at the impact tile.
                const fxDepth = depthForGroundEffect(targetGridX, targetGridY);

                // 1 — the white-hot flash.
                const flash = this.trackBattleFx(this.add.graphics());
                flash.setBlendMode(Phaser.BlendModes.ADD);
                pixelEllipse(flash, 0, 0, 13, 6.5, 0xfff6d8, 0.95);
                flash.setPosition(end.x, end.y);
                flash.setDepth(fxDepth + 4);
                this.tweens.add({ targets: flash, alpha: 0, scale: 2.3, duration: 110, onComplete: () => flash.destroy() });

                // 2 — the bloom: three stacked fire tongues, hottest inside.
                // Stepped redraw via PixelFx.flash (0.35→1.75 of the base
                // size), never a scale tween — scaling stretched the 1.35px
                // cells into soft blobs.
                const bloomSpec: Array<[number, number, number]> = [
                    [0xd8481e, 46, 420],
                    [0xffb545, 34, 330],
                    [0xfff3c4, 22, 240]
                ];
                bloomSpec.forEach(([color, size, dur], i) => {
                    this.trackBattleFx(PixelFx.flash(this, end.x, end.y, {
                        r: (size / 2) * 0.35, squash: 0.5, color, alpha: 0.88,
                        scaleTo: 1.75 / 0.35, life: dur,
                        ease: 'Cubic.easeOut', depth: fxDepth + 1 + i
                    }));
                });

                // 3 — the shockwave: one iso ring racing outward along the
                // ground, redrawn per frame (PixelFx.ring) so the cells stay
                // 1.35px at every radius instead of scaling up ×5.2.
                this.trackBattleFx(PixelFx.ring(this, end.x, end.y, {
                    r0: 9, r1: 47, squash: 0.5, thick0: 2,
                    color: 0xffd9a0, alpha: 0.85,
                    life: 380, ease: 'Cubic.easeOut', depth: fxDepth
                }));

                // 4 — embers thrown out, arcing and dying.
                for (let i = 0; i < 10; i++) {
                    const ember = this.trackBattleFx(this.add.graphics());
                    ember.setBlendMode(Phaser.BlendModes.ADD);
                    const emberR = 1.6 + Math.random() * 1.4;
                    pixelEllipse(ember, 0, 0, emberR, emberR, i % 2 === 0 ? 0xffc35a : 0xff7a22, 0.95);
                    ember.setPosition(end.x, end.y - 4);
                    ember.setDepth(fxDepth + 2);
                    const angle = Math.random() * Math.PI * 2;
                    const throwDist = 18 + Math.random() * 30;
                    this.tweens.add({
                        targets: ember,
                        x: end.x + Math.cos(angle) * throwDist,
                        y: end.y + Math.sin(angle) * throwDist * 0.5 - 8 + Math.random() * 16,
                        alpha: 0,
                        scale: 0.3,
                        duration: 320 + Math.random() * 220,
                        ease: 'Quad.easeOut',
                        onComplete: () => ember.destroy()
                    });
                }

                // 5 — dark smoke rolling up after the fire.
                for (let i = 0; i < 3; i++) {
                    this.scheduleBattleCall(70 + i * 90, () => {
                        const smoke = this.trackBattleFx(this.add.graphics());
                        pixelEllipse(smoke, 0, 0, 5 + i * 2, 5 + i * 2, 0x4a4038, 0.4);
                        smoke.setPosition(end.x + (Math.random() - 0.5) * 10, end.y - 6);
                        smoke.setDepth(fxDepth + 5);
                        this.tweens.add({
                            targets: smoke,
                            y: smoke.y - 20,
                            alpha: 0,
                            scale: 2.1,
                            duration: 680,
                            ease: 'Quad.easeOut',
                            onComplete: () => smoke.destroy()
                        });
                    });
                }

                // 6 — the ground remembers: a scorch that slowly fades.
                const scorch = this.trackBattleFx(this.add.graphics());
                pixelEllipse(scorch, 0, 0, 12, 5.5, 0x2b241c, 0.38);
                pixelEllipse(scorch, 2, 1, 6, 2.75, 0x1c1712, 0.3);
                scorch.setPosition(end.x, end.y + 1);
                scorch.setDepth(6);
                this.tweens.add({ targets: scorch, alpha: 0, duration: 3800, ease: 'Quad.easeIn', onComplete: () => scorch.destroy() });

                this.troops.slice().forEach(t => {
                    if (t.owner !== db.owner && t.health > 0) {
                        const d = Phaser.Math.Distance.Between(t.gridX, t.gridY, targetGridX, targetGridY);
                        if (d < 1.2) {
                            this.applyLocalTroopDamage(t, damage);
                        }
                    }
                });
            }
        });
        };
    }

    // ===== SPIKE LAUNCHER =====
    public spikeZones: { x: number; y: number; gridX: number; gridY: number; radius: number; damage: number; owner: 'PLAYER' | 'ENEMY'; endTime: number; graphics: Phaser.GameObjects.Graphics; lastTickTime: number }[] = [];


    private shootSpikeLauncherAt(launcher: PlacedBuilding, troop: Troop) {
        const info = BUILDINGS['spike_launcher'];
        const stats = this.getDefenseStats(launcher);
        const zoneDamage = stats.damage ?? 38;
        const impactDamage = Math.round(zoneDamage * 1.45);
        const level = launcher.level || 1;
        const zoneRadius = level >= 2 ? 2.4 : 2.1;
        const zoneDuration = 3600 + level * 400;
        const start = IsoUtils.cartToIso(launcher.gridX + info.width / 2, launcher.gridY + info.height / 2);
        const end = IsoUtils.cartToIso(troop.gridX, troop.gridY);
        const targetGridX = troop.gridX;
        const targetGridY = troop.gridY;

        // Calculate angle for trebuchet arm
        const angle = Math.atan2(end.y - start.y, end.x - start.x);
        launcher.ballistaAngle = angle;

        // SPIKY projectile - level-dependent appearance.
        // Painter's-order depth along the shot's ground track.
        const launchGX = launcher.gridX + info.width / 2;
        const launchGY = launcher.gridY + info.height / 2;
        const bag = this.trackBattleFx(this.add.graphics());

        bag.setPosition(start.x, start.y - 40);
        bag.setDepth(depthForProjectile(launchGX, launchGY));
        bag.setAlpha(0);
        const bagBaked = this.syncProjectileSprite(bag, 'spike_ball', Math.min(level, 4), 0);
        if (!bagBaked) ProjectileRenderer.drawSpikeBall(bag, level);

        // Fade in AFTER ball is farther from trebuchet (looks natural when shooting down)
        this.tweens.add({
            targets: bag,
            alpha: 1,
            delay: 300, // Wait until ball is a bit away from trebuchet
            duration: 80,
            ease: 'Linear'
        });

        // SHALLOW arc trajectory
        const arcHeight = 60;
        const midY = (start.y + end.y) / 2 - arcHeight;
        const dist = Phaser.Math.Distance.Between(start.x, start.y, end.x, end.y);

        // Spike trail effect
        let lastTrailTime = 0;

        // Ground shadow tracking under the arcing ball
        const bagShadow = this.trackBattleFx(this.add.graphics());
        pixelEllipse(bagShadow, 0, 0, 8, 3.5, 0x18220f, 0.26);
        bagShadow.setPosition(start.x, start.y + 2);
        bagShadow.setDepth(950);
        bagShadow.setAlpha(0);
        this.tweens.add({ targets: bagShadow, alpha: 1, delay: 300, duration: 80, ease: 'Linear' });
        this.tweens.add({
            targets: bagShadow,
            x: end.x,
            y: end.y + 2,
            delay: 150,
            duration: dist / 0.45,
            ease: 'Linear',
            onUpdate: (tw: Phaser.Tweens.Tween) => {
                // Slimmer while the ball is high at the arc's apex
                bagShadow.setScale(1 - (1 - Math.abs(tw.progress - 0.5) * 2) * 0.35);
            },
            onComplete: () => bagShadow.destroy()
        });

        // Delay projectile movement to sync with trebuchet release animation
        this.tweens.add({
            targets: bag,
            x: end.x,
            delay: 150, // Wait for trebuchet to release
            duration: dist / 0.45,
            ease: 'Linear',
            onUpdate: (tween) => {
                const t = tween.progress;
                // Shallow bezier arc
                bag.y = (1 - t) * (1 - t) * (start.y - 40) + 2 * (1 - t) * t * midY + t * t * end.y;
                // Spin rotation
                bag.setRotation(t * Math.PI * 2.5);
                // Depth follows the ground track under the arc.
                bag.setDepth(depthForProjectile(
                    launchGX + (targetGridX - launchGX) * t,
                    launchGY + (targetGridY - launchGY) * t));
                // Scale
                const scale = 0.7 + (1 - Math.abs(t - 0.5) * 2) * 0.4;
                bag.setScale(scale);
                if (bagBaked) this.syncProjectileSprite(bag, 'spike_ball', Math.min(level, 4), t * Math.PI * 2.5);

                // Drop spike trail every ~80ms
                const now = this.time.now;
                if (now - lastTrailTime > 80 && t > 0.1 && t < 0.9) {
                    lastTrailTime = now;
                    const trailSpike = this.trackBattleFx(this.add.graphics());
                    // Small falling spike (cell rows tapering to the tip)
                    pixelBitmap(trailSpike, -1.5 * PIXEL_CELL, -4, ['.s.', '.s.', '.s.', 'sss', 'sss', 'sss'], { s: 0x888888 }, 0.7);
                    trailSpike.setPosition(bag.x + (Math.random() - 0.5) * 10, bag.y);
                    trailSpike.setDepth(bag.depth - 1);
                    trailSpike.setRotation(Math.random() * Math.PI);

                    this.tweens.add({
                        targets: trailSpike,
                        y: trailSpike.y + 40 + Math.random() * 30,
                        alpha: 0,
                        rotation: trailSpike.rotation + Math.PI,
                        duration: 400,
                        onComplete: () => trailSpike.destroy()
                    });
                }
            },
            onComplete: () => {
                bag.destroy();
                this.createSpikeZone(end.x, end.y, targetGridX, targetGridY, launcher.owner, zoneDamage, zoneRadius, zoneDuration, impactDamage);
            }
        });

        // Launch smoke puff
        this.createSmokeEffect(start.x, start.y - 35, depthForGroundEffect(launchGX, launchGY) + 1);
    }

    private createSpikeZone(
        x: number,
        y: number,
        gridX: number,
        gridY: number,
        owner: 'PLAYER' | 'ENEMY',
        damage: number,
        radius: number,
        duration: number,
        impactDamage: number = Math.round(damage * 1.45)
    ) {
        // A heavy iron THUD — felt, not deafening.
        this.cameras.main.shake(70, 0.0012);
        // Impact layers sort with the world at the landing tile.
        const fxDepth = depthForGroundEffect(gridX, gridY);

        // The zone's teeth reach exactly as far as its DRAWN caltrops: the
        // ground patch spans 27.5px × footprintScale (plus ~6px of spike
        // sprite overhang), converted back to grid tiles with the same
        // grid→iso factor as gridRangeToIsoRadii. The raw stat radius
        // (2.1–2.4 tiles) damaged ~3× beyond the visible hazard.
        const footprintScale = Math.max(0.85, radius / 2);
        const damageRadiusTiles = (27.5 * footprintScale + 6) / (this.tileWidth * 0.5 * Math.SQRT2);

        // 1 — dull metal-on-earth flash (no fire: this is weight, not heat).
        const slamFlash = this.trackBattleFx(this.add.graphics());
        pixelEllipse(slamFlash, 0, 0, 10, 5, 0xd8b878, 0.7);
        slamFlash.setPosition(x, y);
        slamFlash.setDepth(fxDepth + 2);
        this.tweens.add({ targets: slamFlash, alpha: 0, scale: 1.9, duration: 130, onComplete: () => slamFlash.destroy() });

        // 2 — the dust shock: one iso ring of thrown earth racing outward,
        // redrawn per frame (PixelFx.ring) so the cells stay 1.35px at every
        // radius instead of scaling up ×4.4.
        this.trackBattleFx(PixelFx.ring(this, x, y + 1, {
            r0: 8, r1: 35, squash: 0.5, thick0: 2,
            color: 0xc9b593, alpha: 0.8,
            life: 340, ease: 'Cubic.easeOut', depth: fxDepth
        }));

        // 3 — the ground CRACKS under the blow: jagged lines that fade.
        const cracks = this.trackBattleFx(this.add.graphics());
        cracks.setPosition(x, y);
        cracks.setDepth(7);
        for (let c = 0; c < 5; c++) {
            const baseAngle = (c / 5) * Math.PI * 2 + 0.35;
            let cx = 0;
            let cy = 0;
            for (let seg = 0; seg < 3; seg++) {
                const jag = baseAngle + (Math.random() - 0.5) * 0.7;
                const len = 7 + Math.random() * 9;
                const nx = cx + Math.cos(jag) * len;
                const ny = cy + Math.sin(jag) * len * 0.5;
                pixelLine(cracks, cx, cy, nx, ny, 1, 0x3a3020, 0.85);
                cx = nx;
                cy = ny;
            }
        }
        this.tweens.add({ targets: cracks, alpha: 0, duration: 950, ease: 'Quad.easeIn', onComplete: () => cracks.destroy() });

        // 4 — the ball's quills BURST outward and land as the zone's caltrops:
        // the ejecta visually becomes the hazard the launcher leaves behind.
        const quillCount = 9;
        for (let q = 0; q < quillCount; q++) {
            const quill = this.trackBattleFx(this.add.graphics());
            pixelBitmap(quill, -1.5 * PIXEL_CELL, -5, ['.d.', '.d.', 'ddd', 'ddd', 'ddd', 'ddd'], { d: 0x777777 }, 1);
            pixelBitmap(quill, -0.5 * PIXEL_CELL, -5, ['l', 'l', 'l'], { l: 0xaaaaaa }, 0.9);
            quill.setPosition(x, y - 6);
            quill.setDepth(fxDepth + 1);
            const qa = (q / quillCount) * Math.PI * 2 + 0.2;
            // Quills land inside the drawn caltrop patch — they ARE the
            // hazard's look, so they must not overshoot the damage field.
            const qd = 12 + Math.random() * Math.max(6, 27.5 * footprintScale - 10);
            const landX = x + Math.cos(qa) * qd;
            const landY = y + Math.sin(qa) * qd * 0.5;
            this.tweens.add({
                targets: quill,
                x: landX,
                duration: 240 + Math.random() * 120,
                ease: 'Quad.easeOut',
                onUpdate: (tw: Phaser.Tweens.Tween) => {
                    // A little hop: up then embed.
                    const t = tw.progress;
                    quill.y = (y - 6) + (landY - (y - 6)) * t - Math.sin(t * Math.PI) * 12;
                    quill.setRotation((t - 0.5) * 1.2 * (q % 2 === 0 ? 1 : -1));
                },
                onComplete: () => {
                    // Stuck fast for a beat, then the persistent zone owns the look.
                    this.tweens.add({ targets: quill, alpha: 0, delay: 500, duration: 400, onComplete: () => quill.destroy() });
                }
            });
        }

        // 5 — clods of earth kicked loose.
        for (let d = 0; d < 6; d++) {
            const clod = this.trackBattleFx(this.add.graphics());
            pixelEllipse(clod, 0, 0, 1.7, 1.1, d % 2 === 0 ? 0x8a744e : 0x6e5c3e, 0.95);
            clod.setPosition(x, y - 3);
            clod.setDepth(fxDepth + 1);
            const da = Math.random() * Math.PI * 2;
            const dd = 10 + Math.random() * 22;
            this.tweens.add({
                targets: clod,
                x: x + Math.cos(da) * dd,
                y: y + Math.sin(da) * dd * 0.5 - 4 + Math.random() * 8,
                alpha: 0,
                rotation: Math.random() * 2,
                duration: 300 + Math.random() * 200,
                ease: 'Quad.easeOut',
                onComplete: () => clod.destroy()
            });
        }

        // IMPACT DAMAGE - immediate damage to troops in zone
        this.troops.forEach(t => {
            if (t.owner !== owner && t.health > 0) {
                const dist = Phaser.Math.Distance.Between(t.gridX, t.gridY, gridX, gridY);
                if (dist <= damageRadiusTiles + 0.5) { // Slightly larger radius for impact
                    // Impact flash
                    const pos = IsoUtils.cartToIso(t.gridX, t.gridY);
                    this.trackBattleFx(PixelFx.flash(this, pos.x, pos.y - 15, { r: 8, color: 0xffaa00, alpha: 0.8, scaleTo: 2, life: 200, depth: t.gameObject.depth + 1 }));

                    this.applyLocalTroopDamage(t, impactDamage);
                }
            }
        });

        // Create persistent spike zone graphics — ground-decal band: above
        // the stone-lanes RT (2.5) and mortar craters (3), below the prism
        // scorch (5) and dragons-breath scorch (6).
        const zoneGraphics = this.add.graphics();
        zoneGraphics.setDepth(4);

        // Draw scattered spikes on ground
        const drawSpikes = (alpha: number) => {
            zoneGraphics.clear();

            // Dark ground patch
            pixelEllipse(zoneGraphics, x, y + 3, 27.5 * footprintScale, 14 * footprintScale, 0x3a3020, alpha * 0.5);

            // Scattered metal spikes (caltrops)
            const spikePositions = [
                { dx: 0, dy: 0 },
                { dx: -15, dy: -5 },
                { dx: 12, dy: -3 },
                { dx: -8, dy: 8 },
                { dx: 18, dy: 6 },
                { dx: -20, dy: 2 },
                { dx: 5, dy: -10 },
                { dx: -12, dy: -8 },
                { dx: 22, dy: -2 },
                { dx: -5, dy: 10 },
                { dx: 10, dy: 9 },
                { dx: -18, dy: 7 }
            ];

            spikePositions.forEach((pos, i) => {
                const sx = x + pos.dx;
                const sy = y + pos.dy;

                // Metal spikes (4-pointed caltrops, whole-cell rows)
                // Upward spike
                pixelBitmap(zoneGraphics, sx - 1.5 * PIXEL_CELL, sy - 6, ['.s.', '.s.', 'sss', 'sss'], { s: 0x666666 }, alpha);
                // Side spikes
                pixelBitmap(zoneGraphics, sx - 4 * PIXEL_CELL, sy, ['..ss', 'ssss'], { s: 0x666666 }, alpha);
                pixelBitmap(zoneGraphics, sx, sy, ['ss..', 'ssss'], { s: 0x666666 }, alpha);
                // Highlight
                if (i % 3 === 0) {
                    pixelRect(zoneGraphics, sx - 1, sy - 5, 2, 3, 0x999999, alpha * 0.7);
                }
            });
        };

        drawSpikes(1);

        const zone = {
            x, y, gridX, gridY,
            // Damage field == visible caltrop field, not the raw stat radius.
            radius: damageRadiusTiles,
            damage,
            owner,
            endTime: this.time.now + duration,
            graphics: zoneGraphics,
            lastTickTime: this.time.now
        };

        this.spikeZones.push(zone);
    }

    public updateSpikeZones() {
        const now = this.time.now;
        const toRemove: number[] = [];

        this.spikeZones.forEach((zone, index) => {
            // Check expiration
            if (now >= zone.endTime) {
                // Fade out
                this.tweens.add({
                    targets: zone.graphics,
                    alpha: 0,
                    duration: 500,
                    onComplete: () => zone.graphics.destroy()
                });
                toRemove.push(index);
                return;
            }

            // Damage tick (every 500ms)
            const tickInterval = 500;
            if (now >= zone.lastTickTime + tickInterval) {
                zone.lastTickTime = now;

                // Damage troops in zone
                this.troops.forEach(t => {
                    if (t.owner !== zone.owner && t.health > 0) {
                        const dist = Phaser.Math.Distance.Between(t.gridX, t.gridY, zone.gridX, zone.gridY);
                        if (dist <= zone.radius) {
                            // Small blood/damage effect
                            const pos = IsoUtils.cartToIso(t.gridX, t.gridY);
                            PixelFx.burst(this, pos.x, pos.y - 10, {
                                count: 1, colors: [0xff4444], alpha: 0.8, r: 3,
                                speed: 0, up: 10, scaleTo: 0.5, life: 200,
                                depth: t.gameObject.depth + 1
                            });

                            this.applyLocalTroopDamage(t, zone.damage);
                        }
                    }
                });
            }

            // Fade effect near end
            const remaining = zone.endTime - now;
            if (remaining < 1000) {
                zone.graphics.setAlpha(remaining / 1000);
            }
        });

        // Remove expired zones (reverse order to preserve indices)
        for (let i = toRemove.length - 1; i >= 0; i--) {
            this.spikeZones.splice(toRemove[i], 1);
        }
    }

}
