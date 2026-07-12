
import Phaser from 'phaser';
import { Backend, type AttackEndResult, type AttackReplayState, type ReplayFrameSnapshot, type ReplayTroopSnapshot } from '../backend/GameBackend';
import type { SerializedBuilding, SerializedWorld } from '../data/Models';
import { BUILDING_DEFINITIONS, OBSTACLE_DEFINITIONS, TROOP_DEFINITIONS, getBuildingStats, getTroopStats, type BuildingType, type ObstacleType, type TroopType } from '../config/GameDefinitions';
import { LootSystem } from '../systems/LootSystem';
import type { PlacedBuilding, Troop, PlacedObstacle } from '../types/GameTypes';
import { drawBuildingVisual, type WallNeighborTopology } from '../renderers/BuildingVisualDispatcher';
import { TroopRenderer } from '../renderers/TroopRenderer';
import { ObstacleRenderer } from '../renderers/ObstacleRenderer';
import { WreckRenderer, wreckNeedsAnimation } from '../renderers/WreckRenderer';
import { TargetingSystem } from '../systems/TargetingSystem';
import { DefenseSystem } from '../systems/DefenseSystem';
import { CombatNavigationSystem, type CombatNavigationSelection } from '../systems/CombatNavigationSystem';
import { depthForBuilding, depthForGroundPlane, depthForObstacle, depthForRubble, depthForTroop } from '../systems/DepthSystem';
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
import { hashString, mulberry32, upgradeDurationMs, watchtowerSightOf } from '../config/Economy';
import { drawGrassTile, grassPaletteFor, type GrassCornerCut } from '../renderers/GrassRenderer';
import { PLOT_PITCH } from '../systems/WorldMapSystem';
import type { BattleOverlayScene } from './BattleOverlayScene';
import type { GameMode } from '../types/GameMode';
import { SceneInputController } from './controllers/SceneInputController';
import { installBakeBridge } from '../dev/BakeBridge';
import { SpriteBank } from '../render/SpriteBank';
import { installPixelModeHandle, registerPixelSurface, settleLogicalZoom, zoomSettleEnabled } from '../renderers/TextureRenderPolicy';

const BUILDINGS = BUILDING_DEFINITIONS as any;
const OBSTACLES = OBSTACLE_DEFINITIONS as any;

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
    public rubble: { gridX: number; gridY: number; width: number; height: number; type: string; level: number; graphics: Phaser.GameObjects.Graphics; baseGraphics: Phaser.GameObjects.Graphics; createdAt: number; animationDone?: boolean }[] = [];
    public obstacles: PlacedObstacle[] = [];
    public troops: Troop[] = [];
    public ghostBuilding!: Phaser.GameObjects.Graphics;
    public deploymentGraphics!: Phaser.GameObjects.Graphics;
    public forbiddenGraphics!: Phaser.GameObjects.Graphics;
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
    public hasDeployed = false;
    public raidEndScheduled = false; // Prevent multiple end calls
    /** First-generation troops deployed this battle, by type — the server consumes these on bot raids. */
    public deployedThisBattle: Record<string, number> = {};
    private botRaidSettled = false;
    private pendingBotSettlement: Promise<number> | null = null;
    public pendingSpawnCount = 0; // Prevent battle end during troop splits (phalanx/recursion)
    private readonly HEALTH_BAR_IDLE_MS = 5000;
    private readonly HEALTH_BAR_FADE_MS = 600;
    private readonly REPLAY_LIVE_POLL_INTERVAL_MS = 300;
    /** Live spectating rides this far behind the newest frame — the jitter buffer. */
    private readonly REPLAY_LIVE_DELAY_MS = 1500;
    /** Recorded replays play back at a brisk fixed speed. */
    private readonly REPLAY_SPEED = 1.6;

    public villageNameLabel!: Phaser.GameObjects.Text;
    public attackModeSelectedBuilding: PlacedBuilding | null = null;

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
    private replayAutoExitQueued = false;
    /** One exclusive navigation at a time; stale async continuations must not commit. */
    private transitionEpoch = 0;
    private transitionBusy = false;
    private transitionLabel = '';
    private battleEpoch = 0;
    private battleTimerEvents = new Set<Phaser.Time.TimerEvent>();
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
            if (building.owner !== 'PLAYER' || building.type !== 'lab') return max;
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
            if (building.owner !== owner || building.type !== 'lab') return max;
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
            this.input.keyboard.on('keydown-ESC', () => {
                this.cancelPlacement();
            });
            this.input.keyboard.on('keydown-M', () => {
                if (this.selectedInWorld) {
                    this.unbakeBuildingFromGround(this.selectedInWorld);
                    this.isMoving = true;
                    this.selectedBuildingType = null;
                    this.villageLife.onBuildingLifted(this.selectedInWorld);
                    this.inputController.onPointerMove(this.input.activePointer);
                }
            });
        }

        this.input.on('gameout', () => {
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
        this.cameras.main.centerOn(pos.x, pos.y);
        this.hasUserMovedCamera = false;
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
        const APRON_TILES = 12; // meadow ring + the front row of fog cumulus
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
        const sight = watchtowerSightOf(this.buildings as unknown as SerializedBuilding[]);
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
            this.updateCombat(this.replaySimulationTime);
            this.updateSpikeZones();
            this.refreshBuildingHealthBars();
            this.updateBuildingAnimations(time);
            this.updateObstacleAnimations(time);
            this.updateRubbleAnimations(time);
            this.dayNight.update(time);
            this.weather.update(time);
            this.dayNight.setRainFactor(this.weather.rainFactor());
            this.worldMap.update(time);
            return;
        }

        this.checkBattleEnd();

        this.handleCameraMovement(delta);
        this.updateCombat(time);
        this.updateSpikeZones();
        this.updateTroops(delta);
        this.maybePushReplayFrame();
        this.refreshBuildingHealthBars();
        this.updateSelectionHighlight();
        this.updateDeploymentHighlight();
        this.updateBuildingAnimations(time);
        this.updateObstacleAnimations(time);
        this.dayNight.update(time);
        this.weather.update(time);
        this.dayNight.setRainFactor(this.weather.rainFactor());
        this.stepGroundBake();
        this.maybeQuantizeGround(time);
        SpriteBank.sweep(time);
        this.worldMap.update(time);
        this.villageBubbles.update(time);
        if (this.wallGateRecomputeAt !== 0 && time >= this.wallGateRecomputeAt) {
            this.wallGateRecomputeAt = 0;
            this.recomputeWallGates();
        }
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
    }

    /**
     * Land matured upgrade timers locally (the server does the same on its
     * next read — resolveUpgrades in server/game.ts; both derive the same
     * level from the same deadline, so they never disagree).
     */
    private nextUpgradeScanAt = 0;
    private resolveLocalUpgrades(time: number) {
        if (time < this.nextUpgradeScanAt) return;
        this.nextUpgradeScanAt = time + 500;
        if (this.mode !== 'HOME') return;
        const now = Date.now();
        for (const b of this.buildings) {
            if (!b.upgradingTo || (b.upgradeEndsAt ?? 0) > now) continue;
            const target = Math.min(b.upgradingTo, BUILDINGS[b.type]?.maxLevel ?? b.upgradingTo);
            b.upgradingTo = undefined;
            b.upgradeEndsAt = undefined;
            b.level = target;
            b.builtAt = now;
            const stats = getBuildingStats(b.type as BuildingType, target);
            b.maxHealth = stats.maxHealth;
            b.health = stats.maxHealth;
            b.graphics.clear();
            if (b.baseGraphics) b.baseGraphics.clear();
            this.drawBuildingVisuals(b.graphics, b.gridX, b.gridY, b.type, 1, null, b, b.baseGraphics);
            this.updateHealthBar(b);
            this.unbakeBuildingFromGround(b);
            this.bakeBuildingToGround(b);
            this.playUpgradeEffect(b);
            if (b.type === 'army_camp') {
                const campLevels = this.buildings.filter(x => x.type === 'army_camp').map(x => x.level ?? 1);
                gameManager.refreshCampCapacity(campLevels);
            }
            if (b.type === 'lab' && b.owner === 'PLAYER') {
                this.playerLabLevel = Math.max(this.playerLabLevel, target);
            }
            // The bubble may be open on this building: refresh it to the
            // finished level so the countdown gives way to the new stats.
            if (this.selectedInWorld === b) {
                gameManager.onBuildingSelected({ id: b.id, type: b.type as BuildingType, level: target, gridX: b.gridX, gridY: b.gridY });
            }
        }
    }

    private refreshBuildingHealthBars() {
        this.buildings.forEach(building => {
            if (building.isDestroyed) return;
            if (building.health >= building.maxHealth && !building.healthBar.visible) return;
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
            const settlement = this.endAttackReplayCapture('finished');

            // 2-second delay to let final animations play / player realize what happened
            const raidEpoch = this.battleEpoch;
            this.scheduleBattleCall(2000, () => {
                void (async () => {
                    // The authoritative balance/army revision must land before
                    // React switches HUDs or home reload reads the cache.
                    const attackResult = await settlement?.catch(error => {
                        console.warn('Attack settlement failed before raid handoff:', error);
                        return null;
                    });
                    // World-map bot camps settle server-side (capped loot on a
                    // cooldown + troop consumption) BEFORE the payout reaches
                    // the UI — the number shown is the number banked.
                    let payout = Math.max(0, Math.floor(attackResult?.lootApplied ?? 0));
                    if (this.currentEnemyWorld?.isBot) {
                        payout = await this.settleBotRaid().catch(() => 0);
                    }
                    if (raidEpoch !== this.battleEpoch || this.mode !== 'ATTACK') return;
                    // Trigger the end sequence via the game manager callback (same pathway as "Return Home").
                    let handled = false;
                    try {
                        handled = gameManager.onRaidEnded(payout);
                    } catch (error) {
                        console.error('onRaidEnded handler failed:', error);
                    }
                    if (!handled) {
                        if (this.battleInPlace) {
                            await this.goHome(); // marches home, no clouds
                        } else {
                            this.showCloudTransition(async () => {
                                gameManager.setGameMode('HOME');
                                await this.goHome();
                            });
                        }
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

                // Hide original building if being moved (ghost is shown instead)
                if (this.isMoving && this.selectedInWorld === b) {
                    b.graphics.clear();
                    b.baseGraphics?.clear();
                    return;
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
                if ((b.type === 'ballista' || b.type === 'xbow' || b.type === 'cannon') && !b.isFiring) {
                    // Only apply idle swivel if no combat target
                    if (b.ballistaTargetAngle === undefined) {
                        const seed = hashString(`${b.id}:idle-swivel`);
                        const base = (seed / 0xffffffff) * Math.PI * 2;
                        const phase = time * 0.00024 + (seed % 8192) * 0.001;
                        const idleAngle = base
                            + Math.sin(phase) * 0.34
                            + Math.sin(phase * 0.47 + 1.7) * 0.14;
                        b.idleTargetAngle = idleAngle;
                        b.ballistaAngle = idleAngle;
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
                // Wall art has no time-driven state. Neighbor/gate changes are
                // repainted explicitly by refreshWallNeighbors/recomputeGates,
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

                // JUKEBOX: floating notes while a chosen track plays.
                if (b.type === 'jukebox' && soundSystem.overrideActive) {
                    const noteSlot = Math.floor(time / 900);
                    if (b.lastTrailTime !== noteSlot) {
                        b.lastTrailTime = noteSlot;
                        const noteRng = mulberry32(hashString(`${b.id}:jukebox-note:${noteSlot}`));
                        const notePos = IsoUtils.cartToIso(b.gridX + 0.5, b.gridY + 0.5);
                        const note = this.add.text(notePos.x + 10, notePos.y - 38, ['\u266A', '\u266B'][Math.floor(noteRng() * 2)], {
                            fontSize: '12px',
                            color: '#d8a8ff'
                        }).setDepth(b.graphics.depth + 2).setAlpha(0.9);
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

        const maxWallFromWorld = (Array.isArray(world.buildings) ? world.buildings : []).reduce((max, building) => {
            const normalizedType = this.normalizeBuildingType(String((building as { type?: unknown }).type ?? ''));
            if (normalizedType !== 'wall') return max;
            return Math.max(max, Math.max(1, Number((building as { level?: unknown }).level) || 1));
        }, 1);
        const maxLabFromWorld = (Array.isArray(world.buildings) ? world.buildings : []).reduce((max, building) => {
            const normalizedType = this.normalizeBuildingType(String((building as { type?: unknown }).type ?? ''));
            if (normalizedType !== 'lab') return max;
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
                const inst = this.instantiateBuilding(
                    {
                        id,
                        type: normalizedType,
                        gridX,
                        gridY,
                        level,
                        builtAt: Number.isFinite(Number((rawBuilding as { builtAt?: unknown }).builtAt))
                            ? Number((rawBuilding as { builtAt?: unknown }).builtAt)
                            : undefined
                    },
                    'PLAYER'
                );
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
        this.scheduleGateRecompute();

        // Bring the village to life: villagers, dogs, chickens, camp troops.
        // Head-count comes from the server-authoritative population when present.
        if (playablePlaced > 0 && this.mode === 'HOME') {
            this.villageLife.populate('PLAYER', {
                population: world.population?.count,
                identity: world.ownerId || this.userId,
                bornAt: world.population?.bornAt
            });
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
            .setDepth(-500)
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
     * Attack a bot clan straight off the global map. The server first issues
     * the raid session and canonical seeded world; only then may the caravan
     * leave, so a canceled/failed march can close that exact reservation.
     */
    public attackBotPlot(seed: number, username: string, plotX?: number, plotY?: number) {
        const requestedSeed = seed >>> 0;
        // A camp one lawn over is not a cloud trip: the army marches there
        // down the roads and the battle happens ON the world map.
        const travel = plotX !== undefined && plotY !== undefined
            ? this.worldMap.travelOffsetFor(plotX, plotY)
            : null;
        if (travel) {
            const epoch = this.beginExclusiveTransition('A war caravan');
            if (epoch === null) return;
            let issuedMeta: EnemyWorldMeta | null = null;
            void (async () => {
                if (!await this.flushPendingSaveForTransition() || !this.isTransitionCurrent(epoch)) {
                    this.finishExclusiveTransition(epoch);
                    return;
                }
                const started = await Backend.botStart(plotX, plotY);
                if (!started) {
                    gameManager.showToast('That camp cannot be raided right now.');
                    this.finishExclusiveTransition(epoch);
                    return;
                }
                if (started.seed !== requestedSeed) {
                    console.warn('Bot camp seed changed between map view and raid start.', { requestedSeed, issuedSeed: started.seed });
                }
                const meta = {
                    id: `bot_${started.seed >>> 0}`,
                    username,
                    isBot: true,
                    attackId: started.raidId,
                    botRaidId: started.raidId,
                    botPlot: { x: started.x, y: started.y }
                };
                issuedMeta = meta;
                if (!this.isTransitionCurrent(epoch)) {
                    await this.abortBotSession(meta);
                    return;
                }
                const world = started.world;
                world.username = username;
                // Start every allocation before installing the moving callback.
                // If either setup step throws, no caravan is left behind to
                // invoke a second cancellation path.
                this.worldMap.prepareFocus({ x: started.x, y: started.y });
                this.prepareGroundBake(meta.id);
                this.worldMap.marchTo(
                    { x: started.x, y: started.y },
                    this.armyFigures(),
                    () => this.arriveAndFightSafely({ x: started.x, y: started.y }, world, meta, epoch),
                    () => {
                        void this.abortBotSession(meta).finally(() => this.finishExclusiveTransition(epoch));
                    }
                );
            })().catch(error => {
                if (issuedMeta) {
                    return this.recoverIssuedAttackFailure(issuedMeta, epoch, error);
                }
                console.error('Bot road attack setup failed:', error);
                gameManager.showToast('The war caravan could not depart. Please try again.');
                this.finishExclusiveTransition(epoch);
            });
            return;
        }
        this.showCloudTransition(async epoch => {
            if (!await this.flushPendingSaveForTransition() || !this.isTransitionCurrent(epoch)) return;
            const started = await Backend.botStart(plotX, plotY);
            if (!started) {
                gameManager.showToast('That camp cannot be raided right now.');
                return;
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
     * One failure boundary for a server-issued road attack. Rendering and GPU
     * allocation can fail after the server has reserved both participants; the
     * reservation must close and the scene must leave transition mode even in
     * that exceptional path.
     */
    private async recoverIssuedAttackFailure(meta: EnemyWorldMeta, epoch: number, error: unknown): Promise<void> {
        console.error('Issued road attack could not enter its battle frame:', error);
        try {
            try {
                if (meta.isBot) {
                    await this.abortBotSession(meta);
                } else if (meta.attackId) {
                    this.settledAttackIds.add(meta.attackId);
                    await Backend.endAttack(meta.attackId, 'aborted', 0, 0);
                }
            } catch (closeError) {
                // Backend recovery metadata remains durable when the close call
                // itself is interrupted, so scene recovery must still continue.
                console.warn('Failed to close the issued road attack immediately:', closeError);
            }

            if (!this.isTransitionCurrent(epoch)) return;
            this.currentEnemyWorld = null;
            this.battleInPlace = false;
            this.worldMap.teardown();
            this.dropGroundBake();
            gameManager.showToast('The destination could not be rendered. Returning home.');
            try {
                await this.goHome();
            } catch (homeError) {
                console.error('Failed to restore home after an attack handoff error:', homeError);
            }
        } catch (recoveryError) {
            // Never let recovery itself become an unhandled callback rejection.
            console.error('Unexpected road attack recovery failure:', recoveryError);
        } finally {
            this.finishExclusiveTransition(epoch);
        }
    }

    /** Fire-and-contain the asynchronous gate-to-battle handoff. */
    private arriveAndFightSafely(
        plot: { x: number; y: number },
        world: SerializedWorld,
        meta: EnemyWorldMeta,
        epoch: number
    ): void {
        void this.arriveAndFight(plot, world, meta, epoch).catch(error =>
            this.recoverIssuedAttackFailure(meta, epoch, error));
    }

    /**
     * Attack a neighbouring PLAYER by road. The attack is registered with the
     * server BEFORE the army marches (shields refuse it at the gate, not after
     * a pointless walk); a cancelled march aborts the registered attack.
     */
    public attackPlayerPlotByRoad(ownerId: string, username: string, plotX: number, plotY: number) {
        const travel = this.worldMap.travelOffsetFor(plotX, plotY);
        if (!travel) {
            gameManager.startAttackOnUser(ownerId, username);
            return;
        }
        const epoch = this.beginExclusiveTransition('A war caravan');
        if (epoch === null) return;
        let issuedMeta: EnemyWorldMeta | null = null;
        void (async () => {
            if (!await this.flushPendingSaveForTransition() || !this.isTransitionCurrent(epoch)) {
                this.finishExclusiveTransition(epoch);
                return;
            }
            let started: Awaited<ReturnType<typeof Backend.startAttackOnUser>> = null;
            try {
                started = await Backend.startAttackOnUser(ownerId);
            } catch (error) {
                console.warn('road attack registration failed:', error);
            }
            if (!this.isTransitionCurrent(epoch)) {
                if (started?.attackId) void Backend.endAttack(started.attackId, 'aborted', 0, 0).catch(() => undefined);
                return;
            }
            if (!started || !Array.isArray(started.world?.buildings) || started.world.buildings.length === 0) {
                // Registration may have succeeded even when the returned combat
                // snapshot is unusable. Close that exact server reservation now;
                // otherwise both attacker and defender stay locked until later
                // recovery or expiry.
                if (started?.attackId) {
                    await Backend.endAttack(started.attackId, 'aborted', 0, 0).catch(() => undefined);
                }
                gameManager.showToast('That village cannot be attacked right now.');
                this.finishExclusiveTransition(epoch);
                return;
            }
            const attackId = started.attackId;
            const world = started.world;
            const targetPlot = { x: started.target.x, y: started.target.y };
            const meta: EnemyWorldMeta = {
                id: ownerId,
                username,
                isBot: false,
                attackId,
                lootPreCapped: true
            };
            issuedMeta = meta;
            this.worldMap.prepareFocus(targetPlot);
            this.prepareGroundBake(ownerId);
            this.worldMap.marchTo(
                targetPlot,
                this.armyFigures(),
                () => this.arriveAndFightSafely(targetPlot, world, meta, epoch),
                () => {
                    // March called off before the gate: a frameless abort — the
                    // server settles it as a complete no-op.
                    void Backend.endAttack(attackId, 'aborted', 0, 0).catch(() => undefined);
                    this.finishExclusiveTransition(epoch);
                }
            );
        })().catch(error => {
            if (issuedMeta) {
                return this.recoverIssuedAttackFailure(issuedMeta, epoch, error);
            }
            console.error('Player road attack setup failed:', error);
            gameManager.showToast('The war caravan could not depart. Please try again.');
            this.finishExclusiveTransition(epoch);
        });
    }

    /**
     * The caravan is at their gate: swap the battle in WITHOUT leaving the
     * world — the neighbourhood re-renders around the battlefield (the
     * player's own home becomes one of the postcards) and the fight happens
     * right there on the map. No cloud transition.
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
        // No transition means no UI theatre either: the name label stays
        // hidden — the only change on screen is the attack HUD arriving.
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
            const ring = this.add.graphics();
            ring.lineStyle(2, golden ? 0xffd84a : 0xffffff, 0.8);
            ring.strokeEllipse(0, 0, 22, 11);
            ring.setPosition(pos.x, pos.y);
            ring.setDepth(patch.graphics.depth + 1);
            this.tweens.add({
                targets: ring, scaleX: 1.6, scaleY: 1.6, alpha: 0,
                duration: 380, ease: 'Quad.easeOut',
                onComplete: () => ring.destroy()
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
            const ring = this.add.graphics();
            ring.lineStyle(2, 0xffffff, 0.8);
            ring.strokeEllipse(0, 0, 24, 12);
            ring.setPosition(pos.x, pos.y);
            ring.setDepth(rock.graphics.depth + 1);
            this.tweens.add({
                targets: ring, scaleX: 1.6, scaleY: 1.6, alpha: 0,
                duration: 380, ease: 'Quad.easeOut',
                onComplete: () => ring.destroy()
            });
        }
        return assigned;
    }

    public updateUsername(name: string) {
        if (!this.villageNameLabel) return;

        if (this.mode === 'HOME') {
            this.villageNameLabel.setText(`${name.toUpperCase()}'S VILLAGE`);
        } else {
            this.villageNameLabel.setText(`ENEMY VILLAGE`);
        }
    }

    private updateVillageName() {
        if (!this.villageNameLabel) return;

        let name = 'COMMANDER';
        if (this.mode === 'HOME') {
            name = Auth.getCurrentUser()?.username || 'COMMANDER';
        } else {
            // Use the enemy's username if attacking an online base
            name = this.currentEnemyWorld?.username || 'ENEMY';
        }

        this.villageNameLabel.setText(`${name.toUpperCase()}'S VILLAGE`);
    }

    private setVillageNameVisible(visible: boolean) {
        if (!this.villageNameLabel) return;
        this.villageNameLabel.setVisible(visible);
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

        // Bake the base to the ground texture
        this.bakeBuildingToGround(building);

        // Draw dynamic visuals (skipBase=true implied by bake, but drawBuildingVisuals handles default)
        // We pass skipBase=true to ensure only dynamic parts are drawn to 'graphics'
        this.drawBuildingVisuals(graphics, gridX, gridY, normalizedType, 1, null, building, baseGraphics, true);

        const depth = depthForBuilding(gridX, gridY, normalizedType as BuildingType);
        graphics.setDepth(depth);

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

        if (normalizedType === 'lab' && owner === 'PLAYER') {
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
                ? SpriteBank.wallTag(wallNeighbors, Boolean(building?.isGate))
                : undefined;
            graphics.clear();
            const synced = SpriteBank.syncBuilding(
                this, graphics, gridX, gridY, type, building?.level ?? 1, alpha, tint,
                building, this.time.now,
                { wallTag, jukeboxPlaying: soundSystem.overrideActive }
            );
            if (synced) return;
            SpriteBank.release(graphics);
        }
        const visual = drawBuildingVisual({
            graphics,
            gridX,
            gridY,
            type,
            alpha,
            tint,
            building,
            baseGraphics,
            skipBase,
            onlyBase,
            time: this.time.now,
            jukeboxPlaying: soundSystem.overrideActive,
            wallNeighbors
        });
        if (!visual) return;
        const { c1, c2, c3, c4, center } = visual;

        // ---- patina: buildings age, upgrades scrub them clean ----
        // Weeks since the server's builtAt stamp grow a whisper of moss and
        // soot along the lower edges. Deliberately faint (a texture you feel
        // more than see), deterministic per building, skipped for walls (a
        // hundred mossy stubs would read as noise) and for ghost previews.
        if (!onlyBase && building?.builtAt && building.type !== 'wall' && alpha >= 1) {
            const weeks = (Date.now() - building.builtAt) / (7 * 86_400_000);
            const strength = Math.min(0.4, weeks * 0.1);
            if (strength > 0.05) {
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
        }
    }

    // ---- wall gates: every enclosed pocket keeps a door ----
    private wallGateRecomputeAt = 0;

    /** Debounced: wall layouts change in bursts (drags, loads, breaks). */
    public scheduleGateRecompute() {
        this.wallGateRecomputeAt = this.time.now + 150;
    }

    /**
     * Designate GATES so a villager can walk from any pocket of the village
     * to any other: flood-fill the open ground into regions, then connect
     * every region to the outside with one doorway per wall it shares —
     * a deterministic spanning tree over straight wall pieces (posts and
     * double-thick ramparts are skipped; the ambient pathfinder keeps its
     * expensive hop as the fallback of last resort). Purely decorative in
     * battle: a gate fights exactly like the wall it is.
     */
    private recomputeWallGates() {
        // Home decor only: battle walls (enemy layouts, mid-raid breaks) keep
        // whatever they were instantiated with — no doorways popping open as
        // loops fall.
        if (this.mode !== 'HOME') return;
        const size = this.mapSize;
        const walls = this.buildings.filter(b => b.type === 'wall' && b.health > 0 && !b.isDestroyed && b.owner === 'PLAYER');
        const wallAt = new Map<number, PlacedBuilding>();
        for (const w of walls) wallAt.set(w.gridY * size + w.gridX, w);

        // Region labels: 0 = outside (connected to the border), 1.. = pockets.
        const region = new Int16Array(size * size).fill(-1);
        const flood = (seeds: number[], label: number) => {
            const queue = [...seeds];
            for (const s of queue) region[s] = label;
            while (queue.length) {
                const at = queue.pop() as number;
                const ax = at % size;
                const ay = Math.floor(at / size);
                for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
                    const nx = ax + dx;
                    const ny = ay + dy;
                    if (nx < 0 || ny < 0 || nx >= size || ny >= size) continue;
                    const ni = ny * size + nx;
                    if (region[ni] !== -1 || wallAt.has(ni)) continue;
                    region[ni] = label;
                    queue.push(ni);
                }
            }
        };
        const border: number[] = [];
        for (let i = 0; i < size; i++) {
            for (const cell of [i, (size - 1) * size + i, i * size, i * size + size - 1]) {
                if (!wallAt.has(cell) && region[cell] === -1) border.push(cell);
            }
        }
        flood(border, 0);
        let regions = 1;
        for (let i = 0; i < size * size; i++) {
            if (region[i] === -1 && !wallAt.has(i)) flood([i], regions++);
        }

        const newGates = new Set<string>();
        if (regions > 1) {
            // Candidate doorways: straight wall pieces separating two regions.
            const candidates: Array<{ a: number; b: number; wall: PlacedBuilding; straight: boolean }> = [];
            for (const w of walls) {
                const x = w.gridX;
                const y = w.gridY;
                const has = (dx: number, dy: number) => wallAt.has((y + dy) * size + (x + dx));
                const straight = (has(0, -1) && has(0, 1) && !has(1, 0) && !has(-1, 0))
                    || (has(1, 0) && has(-1, 0) && !has(0, -1) && !has(0, 1));
                const touching = new Set<number>();
                for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
                    const nx = x + dx;
                    const ny = y + dy;
                    if (nx < 0 || ny < 0 || nx >= size || ny >= size) { touching.add(0); continue; }
                    const r = region[ny * size + nx];
                    if (r >= 0) touching.add(r);
                }
                if (touching.size >= 2) {
                    const [a, b] = [...touching].sort((p, q) => p - q);
                    candidates.push({ a, b, wall: w, straight });
                }
            }
            // Deterministic spanning tree: straight pieces first, then reading order.
            candidates.sort((p, q) =>
                Number(q.straight) - Number(p.straight)
                || (p.wall.gridY - q.wall.gridY)
                || (p.wall.gridX - q.wall.gridX));
            const parent = Array.from({ length: regions }, (_, i) => i);
            const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
            for (const c of candidates) {
                const ra = find(c.a);
                const rb = find(c.b);
                if (ra === rb) continue;
                parent[ra] = rb;
                if (c.straight) newGates.add(c.wall.id);
                // Non-straight separators connect regions for the solver but
                // carry no doorway art — the pathfinder's hop covers them.
            }
        }

        // Apply the diff and repaint only what changed.
        for (const w of walls) {
            const gate = newGates.has(w.id);
            if (Boolean(w.isGate) === gate) continue;
            w.isGate = gate;
            w.graphics.clear();
            this.drawBuildingVisuals(w.graphics, w.gridX, w.gridY, 'wall', 1, null, w);
        }
    }

    /**
     * Redraw walls adjacent to a given position to update their neighbor connections.
     * Call this after moving/placing/removing a wall.
     */
    public refreshWallNeighbors(gridX: number, gridY: number, owner: 'PLAYER' | 'ENEMY') {
        this.scheduleGateRecompute();
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

        // Baked wreck sprites (clean rubble; burn/smoke become runtime FX).
        const spriteBacked = SpriteBank.syncWreck(this, graphics, baseGraphics, type, level, gridX, gridY, width, height);
        if (!spriteBacked) {
            WreckRenderer.drawWreck(graphics, gridX, gridY, width, height, type, level, 0, 1, baseGraphics);
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
            animationDone: spriteBacked || !wreckNeedsAnimation(type, width, height, 1),
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

    private clearRubble() {
        this.rubble.forEach(r => {
            r.graphics.destroy();
            r.baseGraphics.destroy();
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
            y = p.y - 50 - (info.height * 10);
        } else {
            const troop = item as Troop;
            const pos = IsoUtils.cartToIso(troop.gridX, troop.gridY);
            width = 28;
            height = 6;
            x = pos.x - width / 2;

            // Adjust health bar height based on unit size (humanoids are
            // villager-scale now, so the default rides much lower).
            let yOffset = 22;
            if (troop.type === 'golem') yOffset = 70;
            else if (troop.type === 'davincitank') yOffset = 48;
            else if (troop.type === 'giant') yOffset = 30;
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

    private updateCombat(time: number) {
        const isReplayWatch = this.mode === 'REPLAY';
        if (this.mode !== 'ATTACK' && !isReplayWatch) return;

        this.defenseSystem.update(time, this.buildings, this.troops);

        this.troops.forEach(troop => {
            if (troop.health <= 0) return;



            if (troop.type === 'ward') {
                // --- PASSIVE WARD HEAL ---
                const wardStats = this.getTroopCombatStats(troop);
                const healDelay = 500; // Heal every 0.5 seconds
                if (!(troop as any).lastPassiveHeal || time > (troop as any).lastPassiveHeal + healDelay) {
                    (troop as any).lastPassiveHeal = time;

                    this.troops.forEach(other => {
                        if (other.owner === troop.owner && other.health > 0 && other.health < other.maxHealth) {
                            const d = Phaser.Math.Distance.Between(troop.gridX, troop.gridY, other.gridX, other.gridY);
                            if (d <= (wardStats.healRadius ?? 0)) {
                                other.health = Math.min(other.maxHealth, other.health + (wardStats.healAmount ?? 0));
                                this.updateHealthBar(other);

                                // Green plus sign heal indicator
                                const pos = IsoUtils.cartToIso(other.gridX, other.gridY);
                                const plusGfx = this.add.graphics();
                                plusGfx.setPosition(pos.x, pos.y - 12);
                                plusGfx.setDepth(other.gameObject.depth + 1);
                                plusGfx.fillStyle(0x00ff88, 0.7);
                                plusGfx.fillRect(-1, -4, 2, 8); // vertical bar
                                plusGfx.fillRect(-4, -1, 8, 2); // horizontal bar
                                this.tweens.add({
                                    targets: plusGfx,
                                    y: pos.y - 25,
                                    alpha: 0,
                                    scaleX: 1.5,
                                    scaleY: 1.5,
                                    duration: 500,
                                    onComplete: () => plusGfx.destroy()
                                });
                            }
                        }
                    });
                }

                // Retarget if follow target is dead (Ward doesn't 'heal' single targets anymore, just follows/attacks)
                if (troop.target && troop.target.health <= 0) {
                    troop.target = null;
                }
            }

            // Validate strategic intent before the active damage target. A wall
            // may be the current interaction target, but never replaces the
            // building this troop is actually trying to reach.
            this.ensureTroopNavigation(troop, time);
            if (!troop.navigationPlan
                || troop.navigationPlan.topologyRevision !== this.combatTopologyRevision) return;

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

                if (troop.type === 'ward' && time > troop.lastAttackTime + troop.attackDelay) {
                    // Ward specialized attack behavior (Grand Warden style)
                    const wardStats = stats;
                    const enemies = this.buildings.filter(b => b.owner !== troop.owner && b.health > 0);
                    let attackTarget: PlacedBuilding | null = null;

                    // 1. If targeting an enemy directly, use it
                    if (isEnemy && dist <= wardStats.range + 0.1) {
                        attackTarget = troop.target;
                    }
                    // 2. Otherwise ASSIST the leader if they have an enemy target
                    else {
                        const leader = troop.target;
                        if (leader && leader.target && leader.target.owner !== troop.owner) {
                            const targetBuilding = leader.target as PlacedBuilding;
                            const tInfo = BUILDINGS[targetBuilding.type];
                            const tdx = Math.max(targetBuilding.gridX - troop.gridX, 0, troop.gridX - (targetBuilding.gridX + (tInfo?.width || 1)));
                            const tdy = Math.max(targetBuilding.gridY - troop.gridY, 0, troop.gridY - (targetBuilding.gridY + (tInfo?.height || 1)));
                            const tdist = Math.sqrt(tdx * tdx + tdy * tdy);

                            if (tdist <= wardStats.range) {
                                attackTarget = targetBuilding;
                            }
                        }

                        // A following ward retains its ally as the follow target,
                        // but can help open the wall selected by its own route.
                        if (!attackTarget) {
                            const blocker = this.liveBuildingById(troop.navigationPlan?.blockerId);
                            if (blocker && this.getTargetEdgeDistance(troop, blocker) <= wardStats.range + 0.1) {
                                attackTarget = blocker;
                            }
                        }

                        // 3. If no leader target, find nearest building in range (PRIORITIZE NON-WALLS)
                        if (!attackTarget) {
                            const buildings = enemies.filter(b => b.type !== 'wall');
                            let minDist = wardStats.range;
                            buildings.forEach(b => {
                                const info = BUILDINGS[b.type];
                                const bdx = Math.max(b.gridX - troop.gridX, 0, troop.gridX - (b.gridX + info.width));
                                const bdy = Math.max(b.gridY - troop.gridY, 0, troop.gridY - (b.gridY + info.height));
                                const bd = Math.sqrt(bdx * bdx + bdy * bdy);
                                if (bd <= minDist) {
                                    minDist = bd;
                                    attackTarget = b;
                                }
                            });
                        }
                    }

                    if (attackTarget) {
                        troop.lastAttackTime = time;
                        this.showWardLaser(troop, attackTarget, wardStats.damage);
                    }
                } else if (dist <= stats.range + 0.1) {
                    if (time > troop.lastAttackTime + troop.attackDelay) {
                        // ATTACK LOGIC (Non-Ward Enemies)
                        if (isEnemy && troop.type !== 'ward') {
                            troop.lastAttackTime = time;

                            if (troop.type === 'archer') {
                                this.showArcherProjectile(troop, troop.target, stats.damage);
                            } else if (troop.type === 'sharpshooter') {
                                // Sharpshooter - enhanced archer projectile
                                this.showSharpshooterProjectile(troop, troop.target, stats.damage);
                            } else if (troop.type === 'mobilemortar') {
                                // Mobile Mortar - arcing splash attack like mortar building
                                this.showMobileMortarShot(troop, troop.target, stats.damage);
                            } else if (troop.type === 'stormmage') {
                                this.showStormLightning(troop, troop.target, stats.damage);
                            } else if (troop.type === 'golem') {
                                // GOLEM GROUND POUND - Single slam with AoE damage
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

                                        // Ground crack effect (moved higher to align with slam)
                                        this.showGolemCrackEffect(currentPos.x, currentPos.y + 15);

                                        // Deal damage to all buildings within 3 tile radius
                                        const aoeTiles = 3;
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

                                        // Rise back up
                                        this.tweens.add({
                                            targets: slamTarget,
                                            offset: 0,
                                            duration: 400,
                                            ease: 'Quad.easeOut',
                                            onUpdate: () => {
                                                troop.slamOffset = slamTarget.offset;
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

                                // Adjust depth: when shooting upward (negative Y direction), put ball behind tank
                                const isShootingUp = firingAngle < 0 || firingAngle > Math.PI;
                                const ballDepth = isShootingUp ? 5000 : 25000;

                                // Muzzle flash
                                const flash = this.add.graphics();
                                flash.fillStyle(0xffaa00, 0.9);
                                flash.fillCircle(0, 0, 8);
                                flash.fillStyle(0xffff00, 0.7);
                                flash.fillCircle(0, 0, 4);
                                flash.setPosition(muzzleX, muzzleY);
                                flash.setDepth(ballDepth);
                                this.tweens.add({
                                    targets: flash,
                                    scale: 2, alpha: 0,
                                    duration: 150,
                                    onComplete: () => flash.destroy()
                                });

                                // Cannonball projectile - 2x SMALLER (3px radius)
                                const ball = this.add.graphics();
                                ball.fillStyle(0x2a2a2a, 1);
                                ball.fillCircle(0, 0, 3);
                                ball.fillStyle(0x4a4a4a, 1);
                                ball.fillCircle(-0.5, -0.5, 1);
                                ball.setPosition(ballX, ballY);
                                ball.setDepth(ballDepth);

                                // Smoke puff at muzzle - smaller
                                particleManager.emitSmokeTracker('troop_fire_' + troop.id, muzzleX, muzzleY, time, ballDepth - 1, 3, 0);

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
                                    onComplete: () => {
                                        // Impact effect - isometric oval
                                        const impact = this.add.graphics();
                                        impact.fillStyle(0xff6600, 0.6);
                                        impact.fillEllipse(0, 0, 16, 8);
                                        impact.setPosition(targetPos.x, targetPos.y - 10);
                                        impact.setDepth(5000);
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
                            } else if (troop.type === 'wallbreaker') {
                                // WALL BREAKER — Suicide explosion on first attack
                                troop.lastAttackTime = time;
                                const wallMult = troop.target.type === 'wall' ? ((stats as any).wallDamageMultiplier || 3) : 1;
                                const sRadius = (stats as any).splashRadius || 2.5;

                                // Apply splash damage to all buildings in radius
                                [...this.buildings].forEach(b => {
                                    if (b.owner !== troop.owner && b.health > 0) {
                                        const bInfo = BUILDINGS[b.type];
                                        const bCenterX = b.gridX + bInfo.width / 2;
                                        const bCenterY = b.gridY + bInfo.height / 2;
                                        const bdist = Phaser.Math.Distance.Between(troop.gridX, troop.gridY, bCenterX, bCenterY);
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
                            } else {
                                // Melee: immediate damage (Warrior, Giant, Ram)
                                let finalDamage = stats.damage;
                                if ((troop.type === 'ram' || troop.type === 'giant') && troop.target.type === 'wall') {
                                    finalDamage *= (stats as any).wallDamageMultiplier || 1;
                                }

                                troop.target.health -= finalDamage;
                                this.updateHealthBar(troop.target);

                                // Giant uses renderer-driven lean, no separate punch tween
                                if (troop.type !== 'giant') {
                                    const currentPos = IsoUtils.cartToIso(troop.gridX, troop.gridY);
                                    const targetPos = IsoUtils.cartToIso(bx + tw / 2, by + th / 2);
                                    const angle = Math.atan2(targetPos.y - currentPos.y, targetPos.x - currentPos.x);

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
        const shellRadius = 8 * shellScale;
        const mortarDamage = stats.damage || 62;

        // Mortar shell - starts invisible, appears as it leaves barrel
        const ball = this.add.graphics();
        if (level >= 4) {
            // Gold-studded shell
            ball.fillStyle(0xb8860b, 1);
            ball.fillCircle(0, 0, shellRadius);
            ball.fillStyle(0xdaa520, 1);
            ball.fillCircle(-2 * shellScale, -2 * shellScale, 4 * shellScale);
            // Gold studs
            ball.fillStyle(0xffd700, 0.9);
            ball.fillCircle(shellRadius * 0.5, -shellRadius * 0.3, 1.5);
            ball.fillCircle(-shellRadius * 0.3, shellRadius * 0.5, 1.5);
            ball.fillCircle(shellRadius * 0.4, shellRadius * 0.4, 1.5);
            ball.fillCircle(-shellRadius * 0.6, -shellRadius * 0.1, 1.5);
        } else {
            ball.fillStyle(0x3a3a3a, 1);
            ball.fillCircle(0, 0, shellRadius);
            ball.fillStyle(0x5a5a5a, 1);
            ball.fillCircle(-2 * shellScale, -2 * shellScale, 3 * shellScale);
            if (level >= 3) {
                ball.fillStyle(0xaaaaaa, 0.6);
                ball.fillCircle(-3 * shellScale, -3 * shellScale, 2);
            }
        }
        ball.setPosition(start.x, start.y - 35);
        ball.setDepth(5000);
        ball.setAlpha(0);

        const midY = (start.y + end.y) / 2 - 350;

        // Muzzle flash and smoke effect
        this.createSmokeEffect(start.x, start.y - 35);

        const flash = this.add.graphics();
        flash.fillStyle(0xff8800, 0.8);
        flash.fillCircle(0, 0, 8 * shellScale);
        flash.fillStyle(0xffcc00, 0.6);
        flash.fillCircle(0, 0, 5 * shellScale);
        flash.setPosition(start.x, start.y - 35);
        flash.setDepth(5001);
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
        this.cameras.main.shake(50, 0.001 * scale);

        // Ground crater/scorch mark (L1-L2 only, L3 uses cracks instead)
        if (level < 3) {
            const crater = this.add.graphics();
            crater.fillStyle(0x2a1a0a, 0.6);
            crater.fillEllipse(x, y + 5, 40 * scale, 20 * scale);
            crater.setDepth(1);
            this.tweens.add({ targets: crater, alpha: 0, duration: 2000, delay: 500, onComplete: () => crater.destroy() });
        }

        // L3: Ground cracks radiating from impact (no circular crater)
        if (level >= 3) {
            const cracks = this.add.graphics();
            cracks.lineStyle(2, 0x1a1a1a, 0.7);
            cracks.setDepth(1);
            // Draw 6 cracks radiating outward
            for (let i = 0; i < 6; i++) {
                const angle = (i / 6) * Math.PI * 2 + Math.random() * 0.3;
                const length = 25 + Math.random() * 20;
                const midX = x + Math.cos(angle) * length * 0.5;
                const midY = y + Math.sin(angle) * length * 0.3; // Flatten for isometric
                const endX = x + Math.cos(angle) * length;
                const endY = y + Math.sin(angle) * length * 0.5;
                cracks.beginPath();
                cracks.moveTo(x, y);
                // Jagged crack line
                cracks.lineTo(midX + (Math.random() - 0.5) * 8, midY + (Math.random() - 0.5) * 4);
                cracks.lineTo(endX, endY);
                cracks.strokePath();
                // Branch cracks
                if (Math.random() > 0.5) {
                    const branchAngle = angle + (Math.random() - 0.5) * 0.8;
                    cracks.beginPath();
                    cracks.moveTo(midX, midY);
                    cracks.lineTo(midX + Math.cos(branchAngle) * 12, midY + Math.sin(branchAngle) * 6);
                    cracks.strokePath();
                }
            }
            this.tweens.add({ targets: cracks, alpha: 0, duration: 3000, delay: 800, onComplete: () => cracks.destroy() });
        }

        // Initial flash (isometric oval)
        const flash = this.add.graphics();
        flash.fillStyle(0xffffcc, 1);
        flash.fillEllipse(0, 0, 10 * scale, 5 * scale);
        flash.setPosition(x, y);
        flash.setDepth(10001);
        this.tweens.add({ targets: flash, alpha: 0, scaleX: 10, scaleY: 10, duration: 100, onComplete: () => flash.destroy() });

        // Primary shockwave ring (isometric oval)
        const shock = this.add.graphics();
        shock.lineStyle(4, 0xff6600, 0.8);
        shock.strokeEllipse(x, y, 20 * scale, 10 * scale);
        shock.setDepth(10000);
        this.tweens.add({
            targets: shock, alpha: 0, duration: 400,
            onUpdate: (tween) => {
                shock.clear();
                const r = 10 * scale + tween.progress * 70 * scale;
                shock.lineStyle(4 - tween.progress * 3, 0xff6600, 0.8 - tween.progress * 0.8);
                shock.strokeEllipse(x, y, r * 2, r);
            },
            onComplete: () => shock.destroy()
        });

        // Secondary shockwave (isometric oval)
        this.scheduleBattleCall(50, () => {
            const shock2 = this.add.graphics();
            shock2.lineStyle(2, 0xffaa00, 0.5);
            shock2.strokeEllipse(x, y, 30 * scale, 15 * scale);
            shock2.setDepth(9999);
            this.tweens.add({
                targets: shock2, alpha: 0, duration: 350,
                onUpdate: (tween) => {
                    shock2.clear();
                    const r2 = 15 * scale + tween.progress * 60 * scale;
                    shock2.lineStyle(2, 0xffaa00, 0.5 - tween.progress * 0.5);
                    shock2.strokeEllipse(x, y, r2 * 2, r2);
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
            const fire = this.add.graphics();
            fire.fillStyle(fireColors[Math.floor(Math.random() * 4)], 0.9);
            fire.fillRect(-fireSize / 2, -fireSize / 2, fireSize, fireSize);
            fire.setPosition(x, y);
            fire.setDepth(10002);
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
                const smoke = this.add.graphics();
                smoke.fillStyle(smokeColors[Math.floor(Math.random() * 3)], 0.6);
                smoke.fillRect(-smokeSize / 2, -smokeSize / 2, smokeSize, smokeSize);
                smoke.setPosition(x + (Math.random() - 0.5) * 30, y);
                smoke.setDepth(9998);
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
            const debris = this.add.graphics();
            debris.fillStyle(0x5a4a3a, 1);
            debris.fillRect(-3, -3, 6, 6);
            debris.setPosition(x, y);
            debris.setDepth(10003);

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
                t.health -= damage;
                t.hasTakenDamage = true;
                this.updateHealthBar(t);
                if (t.health <= 0) this.destroyTroop(t);
            }
        });
    }


    private shootAt(cannon: PlacedBuilding, troop: Troop) {
        if (cannon.isFiring) return;
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

        const ballDepth = cannon.graphics.depth + 50;

        // Calculate barrel tip position for muzzle flash
        const barrelLength = 28;
        const barrelHeight = -14;
        const barrelTipX = start.x + Math.cos(angle) * barrelLength;
        const barrelTipY = start.y + barrelHeight + Math.sin(angle) * 0.5 * barrelLength;

        // Muzzle flash at barrel tip - pixelated rectangles
        const flash = this.add.graphics();
        flash.fillStyle(0xffcc00, 0.9);
        flash.fillRect(barrelTipX - 12, barrelTipY - 12, 24, 24);
        flash.fillStyle(0xffffff, 0.9);
        flash.fillRect(barrelTipX - 6, barrelTipY - 6, 12, 12);
        flash.setDepth(ballDepth + 10);
        this.tweens.add({ targets: flash, alpha: 0, duration: 100, onComplete: () => flash.destroy() });

        // Gunpowder smoke - pixelated rectangles
        for (let i = 0; i < 3; i++) {
            const smoke = this.add.graphics();
            const smokeSize = 4 + Math.floor(Math.random() * 4);
            const smokeAngle = angle + (Math.random() - 0.5) * 0.5;
            const dist = 10 + Math.random() * 15;
            const sx = barrelTipX + Math.cos(smokeAngle) * dist * 0.2; // Start near tip
            const sy = barrelTipY + Math.sin(smokeAngle) * dist * 0.2;

            smoke.fillStyle(0xdddddd, 0.6);
            smoke.fillRect(-smokeSize / 2, -smokeSize / 2, smokeSize, smokeSize);
            smoke.setPosition(sx, sy);
            smoke.setDepth(ballDepth + 20); // Above flash

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
        const ball = this.add.graphics();
        if (cLevel >= 4) {
            // Gold cannonball with marble core
            ball.fillStyle(0xb8860b, 1);
            ball.fillRect(-7, -7, 14, 14);
            ball.fillStyle(0xdaa520, 1);
            ball.fillRect(-6, -6, 8, 8);
            ball.fillStyle(0xffd700, 0.6);
            ball.fillRect(-4, -4, 4, 4);
        } else {
            ball.fillStyle(0x1a1a1a, 1);
            ball.fillRect(-7, -7, 14, 14);
            ball.fillStyle(0x3a3a3a, 1);
            ball.fillRect(-6, -6, 8, 8);
        }
        ball.setPosition(barrelTipX, barrelTipY);
        ball.setDepth(ballDepth);

        // Projectile flies to target
        const dist = Phaser.Math.Distance.Between(barrelTipX, barrelTipY, end.x, end.y);
        this.tweens.add({
            targets: ball, x: end.x, y: end.y, duration: dist / 0.8, ease: 'Quad.easeIn',
            onComplete: () => {
                ball.destroy();
                cannon.isFiring = false;

                // Impact effect (pixelated rectangle)
                const impact = this.add.graphics();
                impact.fillStyle(0x8b7355, 0.6);
                impact.fillRect(end.x - 8, end.y, 16, 8);
                impact.setDepth(ballDepth - 10);
                this.tweens.add({ targets: impact, alpha: 0, duration: 300, onComplete: () => impact.destroy() });

                // Apply damage to captured target using level-based damage
                if (targetTroop && targetTroop.health > 0) {
                    targetTroop.health -= cannonDamage;
                    targetTroop.hasTakenDamage = true;
                    this.updateHealthBar(targetTroop);

                    // Hit flash effect (pixelated rectangle)
                    const troopPos = IsoUtils.cartToIso(targetTroop.gridX, targetTroop.gridY);
                    const hitFlash = this.add.graphics();
                    hitFlash.fillStyle(0xffffff, 0.6);
                    hitFlash.fillRect(troopPos.x - 8, troopPos.y - 18, 16, 16);
                    hitFlash.setDepth(ballDepth + 5);
                    this.tweens.add({ targets: hitFlash, alpha: 0, duration: 80, onComplete: () => hitFlash.destroy() });

                    if (targetTroop.health <= 0) this.destroyTroop(targetTroop);
                }
            }
        });
    }


    private shootTeslaAt(tesla: PlacedBuilding, troop: Troop) {
        const stats = this.getDefenseStats(tesla);
        const start = IsoUtils.cartToIso(tesla.gridX + 0.5, tesla.gridY + 0.5);
        start.y -= 40; // From the orb

        // Orb pulse effect (pixelated rectangle)
        const orbPulse = this.add.graphics();
        orbPulse.fillStyle(0x88eeff, 0.6);
        orbPulse.fillRect(-12, -12, 24, 24);
        orbPulse.setPosition(start.x, start.y);
        orbPulse.setDepth(10001);
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

                // Draw multiple lightning layers for thickness effect
                for (let layer = 0; layer < 3; layer++) {
                    const lightning = this.add.graphics();
                    const alpha = layer === 0 ? 1 : (layer === 1 ? 0.6 : 0.3);
                    const width = layer === 0 ? 3 : (layer === 1 ? 5 : 8);
                    const color = layer === 0 ? 0xffffff : (layer === 1 ? 0x88eeff : 0x00ccff);

                    lightning.lineStyle(width, color, alpha);
                    lightning.setDepth(10000 - layer);

                    // Jagged branching path with unique random jitter per bolt
                    lightning.beginPath();
                    lightning.moveTo(boltLastTarget.x, boltLastTarget.y);

                    const segments = 6;
                    const jitter = layer === 0 ? 8 : 12;
                    for (let j = 1; j < segments; j++) {
                        const progress = j / segments;
                        const tx = boltLastTarget.x + (end.x - boltLastTarget.x) * progress;
                        const ty = boltLastTarget.y + (end.y - boltLastTarget.y) * progress;
                        lightning.lineTo(
                            tx + (Math.random() - 0.5) * jitter,
                            ty + (Math.random() - 0.5) * jitter
                        );
                    }
                    lightning.lineTo(end.x, end.y);
                    lightning.strokePath();

                    if (isFinalBolt) {
                        // Final bolt fades out normally
                        this.tweens.add({
                            targets: lightning,
                            alpha: 0,
                            duration: 150 + layer * 50,
                            delay: bolt * boltInterval + idx * 40,
                            onComplete: () => lightning.destroy()
                        });
                    } else {
                        // Non-final bolts get destroyed when next bolt appears
                        this.scheduleBattleCall(bolt * boltInterval + boltInterval, () => lightning.destroy());
                    }
                }

                boltLastTarget = { x: end.x, y: end.y };
            });
        }

        // Impact effects on final bolt timing
        validTargets.forEach((t, idx) => {
            const end = IsoUtils.cartToIso(t.gridX, t.gridY);
            const impactDelay = (boltCount - 1) * boltInterval;

            // Electric spark particles at impact
            for (let s = 0; s < 4; s++) {
                const spark = this.add.graphics();
                spark.lineStyle(1, 0x88eeff, 0.8);
                const sparkLen = 5 + Math.random() * 10;
                const sparkAngle = Math.random() * Math.PI * 2;
                spark.lineBetween(
                    end.x, end.y,
                    end.x + Math.cos(sparkAngle) * sparkLen,
                    end.y + Math.sin(sparkAngle) * sparkLen
                );
                spark.setDepth(10002);
                this.tweens.add({
                    targets: spark,
                    alpha: 0,
                    duration: 100 + Math.random() * 100,
                    delay: impactDelay + idx * 40,
                    onComplete: () => spark.destroy()
                });
            }

            // Glow at impact point
            const impactGlow = this.add.circle(end.x, end.y, 8, 0x00ccff, 0.5);
            impactGlow.setDepth(9999);
            this.tweens.add({
                targets: impactGlow,
                scale: 2, alpha: 0,
                duration: 200,
                delay: impactDelay + idx * 40,
                onComplete: () => impactGlow.destroy()
            });

            // Use stats.damage instead of hardcoded 25
            t.health -= stats.damage! / (idx + 1);
            t.hasTakenDamage = true;
            this.updateHealthBar(t);
            if (t.health <= 0) this.destroyTroop(t);
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

        // Calculate beam thickness based on time for pulsing effect
        const pulseThickness = 8 + Math.sin(time / 30) * 4;
        const coreThickness = 3 + Math.sin(time / 20) * 1.5;

        // Rainbow cycling color
        const hue = (time / 10) % 360;
        const beamColor = Phaser.Display.Color.HSLToColor(hue / 360, 1, 0.5).color;
        const glowColor = Phaser.Display.Color.HSLToColor(hue / 360, 1, 0.7).color;

        // Create or update the laser graphics
        if (!prism.prismLaserGraphics) {
            prism.prismLaserGraphics = this.add.graphics();
            prism.prismLaserGraphics.setDepth(10000);
        }
        if (!prism.prismLaserCore) {
            prism.prismLaserCore = this.add.graphics();
            prism.prismLaserCore.setDepth(10001);
        }

        // Clear and redraw laser every frame
        prism.prismLaserGraphics.clear();
        prism.prismLaserCore.clear();

        // Outer glow beam
        prism.prismLaserGraphics.lineStyle(pulseThickness + 8, glowColor, 0.3);
        prism.prismLaserGraphics.lineBetween(start.x, start.y, end.x, end.y);

        // Main beam with multiple layers for intense effect
        prism.prismLaserGraphics.lineStyle(pulseThickness, beamColor, 0.9);
        prism.prismLaserGraphics.lineBetween(start.x, start.y, end.x, end.y);

        // Inner bright core
        prism.prismLaserCore.lineStyle(coreThickness, 0xffffff, 1);
        prism.prismLaserCore.lineBetween(start.x, start.y, end.x, end.y);


        // Crazy sparkle particles along beam
        const angle = Math.atan2(end.y - start.y, end.x - start.x);

        // Spawn particles every few frames
        if (time % 50 < 20) {
            for (let i = 0; i < 3; i++) {
                const t = Math.random();
                const px = start.x + (end.x - start.x) * t + (Math.random() - 0.5) * 15;
                const py = start.y + (end.y - start.y) * t + (Math.random() - 0.5) * 10;

                const particle = this.add.graphics();
                const particleColor = Phaser.Display.Color.HSLToColor(((hue + Math.random() * 60) % 360) / 360, 1, 0.5).color;
                particle.fillStyle(particleColor, 1);
                particle.fillCircle(0, 0, 2 + Math.random() * 3);
                particle.setPosition(px, py);
                particle.setDepth(10002);

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
            const scorch = this.add.graphics();

            scorch.lineStyle(6, 0x0a0505, 0.7); // Thick, dark charcoal
            scorch.lineBetween(prism.prismTrailLastPos.x, prism.prismTrailLastPos.y, jaggedEndX, jaggedEndY);
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
            const scratch = this.add.graphics();
            scratch.lineStyle(4, 0x0a0505, 0.6);

            const sx = end.x + (Math.random() - 0.5) * 15;
            const sy = end.y + (Math.random() - 0.5) * 15;
            scratch.lineBetween(sx, sy, sx + (Math.random() - 0.5) * 12, sy + (Math.random() - 0.5) * 8);

            scratch.setDepth(5);

            this.tweens.add({
                targets: scratch,
                alpha: 0,
                duration: 2500,
                onComplete: () => scratch.destroy()
            });
        }

        // Impact sparkles at target
        const impactGlow = this.add.graphics();
        impactGlow.fillStyle(beamColor, 0.6);
        impactGlow.fillCircle(end.x, end.y, 12 + Math.sin(time / 25) * 5);
        impactGlow.setDepth(10003);
        this.tweens.add({
            targets: impactGlow,
            alpha: 0,
            duration: 60,
            onComplete: () => impactGlow.destroy()
        });

        // Crystal charging glow
        const crystalGlow = this.add.graphics();
        crystalGlow.fillStyle(0xffffff, 0.4 + Math.sin(time / 15) * 0.3);
        crystalGlow.fillCircle(start.x, start.y, 10);
        crystalGlow.setDepth(10002);
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
            target.health -= damagePerTick;
            target.hasTakenDamage = true;
            this.updateHealthBar(target);
            if (target.health <= 0) {
                this.destroyTroop(target);
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

    private shootFrostfallShard(frostfall: PlacedBuilding, time: number) {
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

        if (!bestTarget) return;

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
            const shard = this.add.graphics();

            // Simple diamond shape matching renderer
            shard.fillStyle(0xaaddff, 0.9);
            shard.beginPath();
            shard.moveTo(0, -crystalHeight * 0.5);
            shard.lineTo(crystalWidth * 0.5, 0);
            shard.lineTo(0, crystalHeight * 0.5);
            shard.lineTo(-crystalWidth * 0.5, 0);
            shard.closePath();
            shard.fillPath();

            // Left face
            shard.fillStyle(0x77bbee, 0.5);
            shard.beginPath();
            shard.moveTo(0, -crystalHeight * 0.5);
            shard.lineTo(0, crystalHeight * 0.5);
            shard.lineTo(-crystalWidth * 0.5, 0);
            shard.closePath();
            shard.fillPath();

            // Highlight
            shard.fillStyle(0xcceeFF, 0.4);
            shard.beginPath();
            shard.moveTo(0, -crystalHeight * 0.5);
            shard.lineTo(crystalWidth * 0.5, 0);
            shard.lineTo(crystalWidth * 0.15, -crystalHeight * 0.1);
            shard.closePath();
            shard.fillPath();

            // Outline
            shard.lineStyle(1, 0x5599cc, 0.6);
            shard.strokePoints([
                new Phaser.Math.Vector2(0, -crystalHeight * 0.5),
                new Phaser.Math.Vector2(crystalWidth * 0.5, 0),
                new Phaser.Math.Vector2(0, crystalHeight * 0.5),
                new Phaser.Math.Vector2(-crystalWidth * 0.5, 0),
            ], true, true);

            // Start from the crystal's position near the top beam
            const startY = start.y - baseHeight;
            shard.setPosition(start.x, startY);
            shard.setDepth(10000);

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
                },
                onComplete: () => {
                    shard.destroy();
                    frostfall.frostfallProjectileActive = false; // New crystal can rise on next cycle

                    // === IMPACT: a real cold snap ===
                    this.cameras.main.shake(130, 0.0022);

                    // Pale flash of the freeze.
                    const iceFlash = this.add.graphics();
                    iceFlash.setBlendMode(Phaser.BlendModes.ADD);
                    iceFlash.fillStyle(0xdcf2ff, 0.85);
                    iceFlash.fillEllipse(0, 0, 30, 15);
                    iceFlash.setPosition(end.x, end.y);
                    iceFlash.setDepth(10004);
                    this.tweens.add({ targets: iceFlash, alpha: 0, scale: 2.1, duration: 130, onComplete: () => iceFlash.destroy() });

                    // Frost rime rushes across the ground to the exact edge of
                    // the slow zone — the debuff painted where it applies.
                    const rime = this.add.graphics();
                    const rimeR = 2.5 * 32; // AoE radius in iso px (half-width)
                    rime.lineStyle(2, 0xcfeaff, 0.75);
                    rime.strokeEllipse(0, 0, rimeR * 2, rimeR);
                    rime.fillStyle(0xdcf2ff, 0.16);
                    rime.fillEllipse(0, 0, rimeR * 2, rimeR);
                    // Rime crystals sparkling inside the ring.
                    for (let i = 0; i < 14; i++) {
                        const a = (i / 14) * Math.PI * 2 + 0.4;
                        const rr = rimeR * (0.35 + ((i * 37) % 10) / 16);
                        rime.fillStyle(0xffffff, 0.55);
                        rime.fillTriangle(
                            Math.cos(a) * rr, Math.sin(a) * rr * 0.5 - 2,
                            Math.cos(a) * rr - 1.6, Math.sin(a) * rr * 0.5 + 1.2,
                            Math.cos(a) * rr + 1.6, Math.sin(a) * rr * 0.5 + 1.2
                        );
                    }
                    rime.setPosition(end.x, end.y);
                    rime.setDepth(7);
                    rime.setScale(0.2);
                    rime.setAlpha(0.9);
                    this.tweens.add({ targets: rime, scaleX: 1, scaleY: 1, duration: 240, ease: 'Cubic.easeOut' });
                    this.tweens.add({ targets: rime, alpha: 0, delay: 2600, duration: 1600, onComplete: () => rime.destroy() });

                    // The EMBEDDED crystal, stuck tip-up in the ground.
                    const embedded = this.add.graphics();
                    const embedHeight = crystalHeight;
                    const embedWidth = crystalWidth;
                    embedded.fillStyle(0xaaddff, 0.92);
                    embedded.beginPath();
                    embedded.moveTo(0, -embedHeight * 0.8);
                    embedded.lineTo(embedWidth * 0.5, -embedHeight * 0.3);
                    embedded.lineTo(0, embedHeight * 0.1);
                    embedded.lineTo(-embedWidth * 0.5, -embedHeight * 0.3);
                    embedded.closePath();
                    embedded.fillPath();
                    embedded.fillStyle(0x77bbee, 0.5);
                    embedded.beginPath();
                    embedded.moveTo(0, -embedHeight * 0.8);
                    embedded.lineTo(0, embedHeight * 0.1);
                    embedded.lineTo(-embedWidth * 0.5, -embedHeight * 0.3);
                    embedded.closePath();
                    embedded.fillPath();
                    embedded.fillStyle(0xcceeFF, 0.4);
                    embedded.beginPath();
                    embedded.moveTo(0, -embedHeight * 0.8);
                    embedded.lineTo(embedWidth * 0.5, -embedHeight * 0.3);
                    embedded.lineTo(embedWidth * 0.15, -embedHeight * 0.5);
                    embedded.closePath();
                    embedded.fillPath();
                    embedded.lineStyle(1, 0x5599cc, 0.6);
                    embedded.beginPath();
                    embedded.moveTo(0, -embedHeight * 0.8);
                    embedded.lineTo(embedWidth * 0.5, -embedHeight * 0.3);
                    embedded.lineTo(0, embedHeight * 0.1);
                    embedded.lineTo(-embedWidth * 0.5, -embedHeight * 0.3);
                    embedded.closePath();
                    embedded.strokePath();
                    // Painter's order at its own tile — the crystal stands IN
                    // the world (in front of walls behind it, behind troops
                    // that walk past), instead of hiding under everything.
                    const crystalDepth = 1000 + (targetX + targetY) * 100 + 60;
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
                            const mound = this.add.graphics();
                            mound.fillStyle(0x5c4c34, 0.8);
                            mound.fillEllipse(0, 0, 16, 6);
                            mound.fillStyle(0x6e5c3e, 0.9);
                            mound.fillEllipse(-4, -1, 6, 2.6);
                            mound.fillEllipse(5, 0.5, 5, 2.2);
                            mound.setPosition(end.x, end.y + 3);
                            mound.setDepth(crystalDepth - 1);
                            this.tweens.add({ targets: mound, alpha: 0, delay: 6200, duration: 1200, onComplete: () => mound.destroy() });
                            for (let d = 0; d < 4; d++) {
                                const clod = this.add.graphics();
                                clod.fillStyle(0x6e5c3e, 0.95);
                                clod.fillEllipse(0, 0, 3, 2);
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
                    const puddle = this.add.graphics();
                    puddle.fillStyle(0x6fb4e8, 0.42);
                    puddle.fillEllipse(0, 2, 44, 20);
                    puddle.fillStyle(0xa8d8f8, 0.35);
                    puddle.fillEllipse(-3, 1, 26, 11);
                    puddle.fillStyle(0xe8f6ff, 0.5);
                    puddle.fillEllipse(-7, -1, 7, 3);
                    puddle.setPosition(end.x, end.y + 2);
                    puddle.setDepth(6);
                    puddle.setScale(0.1);
                    puddle.setAlpha(0);

                    const meltFx = this.add.graphics();
                    meltFx.setPosition(end.x, end.y);
                    meltFx.setDepth(crystalDepth + 1);

                    const melt = { t: 0 };
                    let lastDripAt = 0;
                    this.tweens.add({
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
                                meltFx.lineStyle(1.2, 0xe8f6ff, 0.7 * (1 - t * 0.5));
                                meltFx.lineBetween(-embedWidth * 0.4 * (1 + t * 0.4), topY * 0.45, embedWidth * 0.4 * (1 + t * 0.4), topY * 0.55);
                                for (let s = 0; s < 3; s++) {
                                    const run = ((t * 3.2 + s * 0.37) % 1);
                                    const sx = (s - 1) * embedWidth * 0.24 * (1 + t * 0.4);
                                    meltFx.lineStyle(1, 0xbfe4ff, 0.65 * (1 - run));
                                    meltFx.lineBetween(sx, topY * (1 - run * 0.8), sx + 0.8, topY * (1 - run * 0.8) + 4.5);
                                }
                            }
                            // Drips off the tip, steady as a thaw.
                            const now = this.time.now;
                            if (now - lastDripAt > 420 && melt.t > 0.08 && melt.t < 0.92) {
                                lastDripAt = now;
                                const drip = this.add.graphics();
                                drip.fillStyle(0xbfe4ff, 0.85);
                                drip.fillEllipse(0, 0, 2, 3);
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
                                        drip.lineStyle(1, 0xd8eeff, 0.5);
                                        drip.strokeEllipse(0, 0, 4, 2);
                                        this.tweens.add({ targets: drip, alpha: 0, scale: 2, duration: 260, onComplete: () => drip.destroy() });
                                    }
                                });
                            }
                        },
                        onComplete: () => {
                            // The last of it collapses — one soft splash ring.
                            meltFx.destroy();
                            embedded.destroy();
                            const splash = this.add.graphics();
                            splash.lineStyle(1.4, 0xd8eeff, 0.7);
                            splash.strokeEllipse(0, 0, 12, 6);
                            splash.setPosition(end.x, end.y + 2);
                            splash.setDepth(crystalDepth + 1);
                            this.tweens.add({ targets: splash, alpha: 0, scale: 2.4, duration: 320, onComplete: () => splash.destroy() });
                            this.tweens.add({ targets: puddle, scaleX: puddle.scaleX + 0.15, scaleY: puddle.scaleY + 0.15, duration: 300, ease: 'Quad.easeOut' });
                            // ...and the sun takes the puddle back.
                            this.tweens.add({ targets: puddle, alpha: 0, delay: 1500, duration: 2800, ease: 'Quad.easeIn', onComplete: () => puddle.destroy() });
                        }
                    });

                    // === ICE SHATTER FRAGMENTS on impact ===
                    for (let i = 0; i < 12; i++) {
                        const frag = this.add.graphics();
                        frag.fillStyle(i % 3 === 0 ? 0xdcf2ff : (i % 3 === 1 ? 0xaaddff : 0x88ccff), 0.95);
                        const fragSize = 2 + Math.random() * 4.4;
                        frag.beginPath();
                        frag.moveTo(0, -fragSize);
                        frag.lineTo(fragSize * 0.6, 0);
                        frag.lineTo(0, fragSize * 0.5);
                        frag.lineTo(-fragSize * 0.6, 0);
                        frag.closePath();
                        frag.fillPath();
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
                    this.troops.forEach(troop => {
                        if (troop.health <= 0 || troop.owner === frostfall.owner) return;

                        const dx = troop.gridX - targetX;
                        const dy = troop.gridY - targetY;
                        const distToImpact = Math.sqrt(dx * dx + dy * dy);

                        if (distToImpact <= 2.5) {
                            troop.health -= damage;
                            troop.hasTakenDamage = true;
                            this.updateHealthBar(troop);

                            (troop as any).chillRemainingMs = 4000; // Massive Slow

                            // Physical Pushback & Stun
                            if (troop.velocityX !== undefined && troop.velocityY !== undefined && distToImpact > 0.1) {
                                troop.velocityX += (dx / distToImpact) * 5;
                                troop.velocityY += (dy / distToImpact) * 5;
                                troop.retargetPauseUntil = time + 600;
                            }

                            // Hit flash on troop
                            const troopPos = IsoUtils.cartToIso(troop.gridX, troop.gridY);
                            particleManager.emitHitFlash(troopPos.x, troopPos.y, 10006);

                            if (troop.health <= 0) {
                                this.destroyTroop(troop);
                            }
                        }
                    });

                    // Emit frost burst particles
                    if (particleManager) {
                        for (let i = 0; i < 30; i++) {
                            const angle = Math.random() * Math.PI * 2;
                            const r = Math.random() * 80;
                            particleManager.emitSparkTracker(
                                `${frostfall.id}:chill-burst:${i}`,
                                end.x + Math.cos(angle) * r,
                                end.y + Math.sin(angle) * r * 0.5 - 10,
                                time,
                                10001
                            );
                        }
                    }
                }
            });
        });
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
        const arrow = this.add.graphics();
        arrow.fillStyle(0x4a341f, 1);
        arrow.fillRect(-4.5, -0.6, 9, 1.2);
        arrow.fillStyle(0xaab0ba, 1);
        arrow.fillTriangle(7, 0, 4.5, -1.4, 4.5, 1.4);
        arrow.fillStyle(0x2e7d32, 1);
        arrow.fillTriangle(-4.5, 0, -2.8, -1.6, -2.8, 1.6);

        // Leave from the bow itself (arm's reach toward the aim, chest high).
        arrow.setPosition(start.x + Math.cos(angle) * 5.2, start.y - 4 + Math.sin(angle) * 2.6);
        arrow.setRotation(angle);
        arrow.setDepth(10000);

        // Straight line trajectory
        const endY = end.y - 25;

        this.tweens.add({
            targets: arrow,
            x: end.x,
            y: endY,
            duration: 200,
            ease: 'Linear',
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
                const thud = this.add.circle(end.x, endY, 3, 0x8b4513, 0.6);
                thud.setDepth(100);
                this.tweens.add({ targets: thud, scale: 0.5, alpha: 0, duration: 120, onComplete: () => thud.destroy() });

                // Impact sparkle
                for (let i = 0; i < 2; i++) {
                    const spark = this.add.circle(
                        end.x + (Math.random() - 0.5) * 8,
                        endY + (Math.random() - 0.5) * 8,
                        1.5, 0x88ccff, 0.7
                    );
                    spark.setDepth(101);
                    this.tweens.add({
                        targets: spark,
                        y: spark.y - 8,
                        alpha: 0,
                        duration: 80,
                        onComplete: () => spark.destroy()
                    });
                }
            }
        });
    }

    private showSharpshooterProjectile(troop: Troop, target: PlacedBuilding, damage: number) {
        const start = IsoUtils.cartToIso(troop.gridX, troop.gridY);
        const info = BUILDINGS[target.type];
        const end = IsoUtils.cartToIso(target.gridX + info.width / 2, target.gridY + info.height / 2);
        const angle = Math.atan2(end.y - start.y, end.x - start.x);

        const targetBuilding = target;

        troop.facingAngle = angle;

        // The sharpshooter is a musketeer now: the pose (shoulder the piece,
        // aim, hammer-fall recoil, powder smoke) is animated inside
        // TroopRenderer off attackAge. The ball leaves the muzzle exactly at
        // MUSKET_FIRE_MS after the damage tick, so the renderer's flash and
        // this projectile are one event and can never drift apart.
        this.scheduleBattleCall(TroopRenderer.MUSKET_FIRE_MS, () => {
            // Body recoil nudge the instant the piece fires.
            const g = troop.gameObject;
            if (g && g.active && g.scene) {
                this.tweens.add({
                    targets: g,
                    scaleX: 0.94,
                    duration: 45,
                    yoyo: true,
                    ease: 'Power2'
                });
            }
            this.launchSharpshooterArrow(troop, start, end, angle, targetBuilding, damage);
        });
    }

    private launchSharpshooterArrow(troop: Troop, start: Phaser.Math.Vector2, end: Phaser.Math.Vector2, angle: number, targetBuilding: PlacedBuilding, damage: number) {
        // Musket ball + a fading powder tracer. The ball spawns where the
        // renderer draws the muzzle when the piece is shouldered.
        const barrelLen = (troop.level || 1) >= 3 ? 12 : 10.8;
        const mx = start.x + Math.cos(angle) * barrelLen;
        const my = start.y - 7 + Math.sin(angle) * 0.5 * barrelLen;

        const ball = this.add.graphics();
        ball.fillStyle(0x2a2d33, 1);
        ball.fillCircle(0, 0, 1.4);
        ball.fillStyle(0x9aa0aa, 0.9);
        ball.fillCircle(-0.4, -0.4, 0.5);
        ball.setPosition(mx, my);
        ball.setDepth(10000);

        // Tracer line that fades behind the ball.
        const trail = this.add.graphics();
        trail.setDepth(9999);

        const endY = end.y - 14;
        const dist = Math.sqrt((end.x - mx) ** 2 + (endY - my) ** 2);
        const duration = Math.min(220, 40 + dist * 0.16); // near-instant shot

        this.tweens.add({
            targets: ball,
            x: end.x,
            y: endY,
            duration: duration,
            ease: 'Linear',
            onUpdate: () => {
                trail.clear();
                trail.lineStyle(1.2, 0xe8e2d0, 0.35);
                trail.lineBetween(mx, my, ball.x, ball.y);
            },
            onComplete: () => {
                ball.destroy();
                trail.destroy();

                if (targetBuilding && targetBuilding.health > 0) {
                    targetBuilding.health -= damage;
                    this.updateHealthBar(targetBuilding);

                    if (targetBuilding.health <= 0) {
                        this.destroyBuilding(targetBuilding);
                    }
                }

                // Stone-chip impact: a grey dust pop, no arrow thud.
                const thud = this.add.circle(end.x, endY, 5, 0x8a8478, 0.7);
                thud.setDepth(100);
                this.tweens.add({ targets: thud, scale: 0.3, alpha: 0, duration: 150, onComplete: () => thud.destroy() });
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

        // Mortar shell - spawns from the mortar position
        const shell = this.add.graphics();
        shell.fillStyle(0x3a3a3a, 1);
        shell.fillCircle(0, 0, 5);
        shell.fillStyle(0x555555, 1);
        shell.fillCircle(-1.5, -1.5, 2.5);
        shell.setPosition(mortarX, mortarY);
        shell.setDepth(10000);

        // Muzzle flash at mortar position
        particleManager.emitHitFlash(mortarX, mortarY, 10001);

        // THIN BLACK SMOKE - rising slowly from mortar muzzle
        for (let i = 0; i < 6; i++) {
            this.scheduleBattleCall(i * 80, () => {
                particleManager.emitDustBurst(mortarX, mortarY, 10002);
            });
        }

        // Arcing trajectory
        const midY = Math.min(start.y - 20, end.y - 25) - 80;
        const endY = end.y;

        this.tweens.add({
            targets: shell,
            x: { value: (start.x + end.x) / 2, duration: 300, ease: 'Linear' },
            y: { value: midY, duration: 300, ease: 'Quad.easeOut' },
            onComplete: () => {
                this.tweens.add({
                    targets: shell,
                    x: { value: end.x, duration: 300, ease: 'Linear' },
                    y: { value: endY, duration: 300, ease: 'Quad.easeIn' },
                    onComplete: () => {
                        shell.destroy();

                        // Explosion effect
                        this.cameras.main.shake(25, 0.001);
                        particleManager.emitExplosion(end.x, endY, 5000);

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
        const staffTipX = start.x + 3.5;
        const staffTipY = start.y - 16;
        this.drawLightningBolt(staffTipX, staffTipY, end.x, end.y - 15, 0x00ffff);

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

                    this.drawLightningBolt(pPos.x, pPos.y - 15, nPos.x, nPos.y - 15, 0x00ccff);
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

    private drawLightningBolt(x1: number, y1: number, x2: number, y2: number, color: number) {
        const graphics = this.add.graphics();
        graphics.setDepth(20000);

        // Draw main bolt
        graphics.lineStyle(2, color, 1);
        graphics.beginPath();
        graphics.moveTo(x1, y1);

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

            graphics.lineTo(px, py);
            cx = px;
            cy = py;

            // Occasional fork logic
            if (Math.random() > 0.7) {
                const forkLen = 15;
                const forkAngle = angle + (Math.random() - 0.5);
                const fx = cx + Math.cos(forkAngle) * forkLen;
                const fy = cy + Math.sin(forkAngle) * forkLen;

                const fork = this.add.graphics();
                fork.setDepth(20000);
                fork.lineStyle(1, color, 0.7);
                fork.lineBetween(cx, cy, fx, fy);
                this.tweens.add({
                    targets: fork,
                    alpha: 0,
                    duration: 150,
                    onComplete: () => fork.destroy()
                });
            }
        }
        graphics.lineTo(x2, y2);
        graphics.strokePath();

        // Glow effect
        graphics.lineStyle(6, color, 0.3);
        graphics.strokePath();

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

        // Set target angle for smooth rotation (handled in updateBuildingAnimations)
        ballista.ballistaTargetAngle = angle;

        // Initialize ballista state if not set
        if (ballista.ballistaAngle === undefined) {
            ballista.ballistaAngle = angle; // Start facing the target
        }
        ballista.ballistaBoltLoaded = true;
        ballista.ballistaStringTension = 0;

        // Wind-back animation: tween the string tension from 0 to 1
        this.tweens.add({
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
                const bolt = this.add.graphics();

                // Huge spear matching the loaded bolt on the machine
                const bLevel = ballista.level ?? 1;
                // L3: gold bolt, L2: grey, L1: wood
                bolt.fillStyle(bLevel >= 3 ? 0xb8860b : 0x5d4e37, 1);
                bolt.fillRect(-24, -2.8, 48, 5.6);
                bolt.fillStyle(bLevel >= 3 ? 0xffd700 : (bLevel >= 2 ? 0x9a9aa6 : 0xa8845e), 0.8);
                bolt.fillRect(-24, -2.8, 48, 2);
                // Big leaf arrowhead
                bolt.fillStyle(bLevel >= 3 ? 0xdaa520 : 0x3a3a3a, 1);
                bolt.beginPath();
                bolt.moveTo(35, 0);
                bolt.lineTo(27, -6);
                bolt.lineTo(24, 0);
                bolt.lineTo(27, 6);
                bolt.closePath();
                bolt.fillPath();
                // Fletching - Gold for L3, Grey for L2, Red for L1
                const fletchColor = bLevel >= 3 ? 0xffd700 : (bLevel >= 2 ? 0x444444 : 0xcc3333);
                bolt.fillStyle(fletchColor, 1);
                bolt.beginPath();
                bolt.moveTo(-24, 0);
                bolt.lineTo(-16, -8);
                bolt.lineTo(-8, 0);
                bolt.closePath();
                bolt.fillPath();
                bolt.beginPath();
                bolt.moveTo(-24, 0);
                bolt.lineTo(-16, 8);
                bolt.lineTo(-8, 0);
                bolt.closePath();
                bolt.fillPath();

                // Exit exactly where the loaded bolt sits on the rail
                bolt.setPosition(start.x + Math.cos(angle) * 14, start.y - 28 + Math.sin(angle) * 0.5 * 14);
                bolt.setRotation(angle);
                bolt.setDepth(20000);



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

                // Animate bolt flying to target
                const dist = Phaser.Math.Distance.Between(start.x, start.y, end.x, end.y);
                let lastTrailTime = 0;

                // Ground shadow tracking under the bolt
                const boltShadow = this.add.graphics();
                boltShadow.fillStyle(0x18220f, 0.28);
                boltShadow.fillEllipse(0, 0, 30, 9);
                boltShadow.setPosition(start.x + Math.cos(angle) * 14, start.y + 3);
                boltShadow.setRotation(angle);
                boltShadow.setDepth(950);
                this.tweens.add({
                    targets: boltShadow,
                    x: end.x,
                    y: end.y + 3,
                    duration: dist / 1.2,
                    ease: 'Linear',
                    onComplete: () => boltShadow.destroy()
                });

                this.tweens.add({
                    targets: bolt,
                    x: end.x,
                    y: end.y,
                    duration: dist / 1.2,
                    ease: 'Linear',
                    onUpdate: (tween: Phaser.Tweens.Tween) => {
                        // White trail particles at TAIL - Aggressive
                        const now = this.time.now;
                        if (now - lastTrailTime > 10) {
                            lastTrailTime = now;
                            const trail = this.add.graphics();
                            trail.fillStyle(0xffffff, 0.7);
                            trail.fillCircle(0, 0, 3);

                            // Calculate tail position (bolt is ~30px long, tail at -16 local)
                            // Responsive offset: Starts at 0, grows to 70 based on travel
                            const traveled = tween.progress * dist;
                            const currentOffset = Math.min(traveled, 70);

                            const rot = bolt.rotation;
                            const tailX = bolt.x - Math.cos(rot) * currentOffset;
                            const tailY = bolt.y - Math.sin(rot) * currentOffset;

                            trail.setPosition(tailX, tailY);
                            trail.setDepth(19999);
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
                        // Deal damage
                        if (targetTroop && targetTroop.health > 0) {
                            targetTroop.health -= ballistaDamage;
                            targetTroop.hasTakenDamage = true;
                            this.updateHealthBar(targetTroop);
                            if (targetTroop.health <= 0) this.destroyTroop(targetTroop);
                        }

                        // === EXPLOSION EFFECT ===
                        // Initial flash
                        const flash = this.add.graphics();
                        flash.fillStyle(0xffffcc, 0.9);
                        flash.fillCircle(0, 0, 15);
                        flash.setPosition(end.x, end.y);
                        flash.setDepth(20002);
                        this.tweens.add({
                            targets: flash,
                            scale: 2, alpha: 0,
                            duration: 80,
                            onComplete: () => flash.destroy()
                        });

                        // Shockwave ring
                        const shock = this.add.graphics();
                        shock.lineStyle(3, 0xff8800, 0.7);
                        shock.strokeCircle(0, 0, 8);
                        shock.setPosition(end.x, end.y);
                        shock.setDepth(20001);
                        this.tweens.add({
                            targets: shock,
                            alpha: 0,
                            duration: 200,
                            onUpdate: (tween) => {
                                shock.clear();
                                const r = 8 + tween.progress * 30;
                                shock.lineStyle(3 - tween.progress * 2, 0xff8800, 0.7 - tween.progress * 0.7);
                                shock.strokeCircle(0, 0, r);
                            },
                            onComplete: () => shock.destroy()
                        });

                        // Fire/explosion particles
                        for (let i = 0; i < 6; i++) {
                            const particle = this.add.graphics();
                            const pAngle = Math.random() * Math.PI * 2;
                            const pDist = 15 + Math.random() * 20;
                            particle.fillStyle(0xff6600 + Math.floor(Math.random() * 0x3300), 0.9);
                            particle.fillCircle(0, 0, 4 + Math.random() * 4);
                            particle.setPosition(end.x, end.y);
                            particle.setDepth(20000);

                            this.tweens.add({
                                targets: particle,
                                x: end.x + Math.cos(pAngle) * pDist,
                                y: end.y + Math.sin(pAngle) * pDist * 0.5 - 10,
                                scale: 0.3,
                                alpha: 0,
                                duration: 200 + Math.random() * 100,
                                ease: 'Quad.easeOut',
                                onComplete: () => particle.destroy()
                            });
                        }

                        // Main impact glow (isometric oval)
                        const impact = this.add.graphics();
                        impact.fillStyle(0xff4400, 0.8);
                        impact.fillEllipse(0, 0, 24, 12);
                        impact.fillStyle(0xffcc00, 0.6);
                        impact.fillEllipse(0, 0, 12, 6);
                        impact.setPosition(end.x, end.y);
                        impact.setDepth(19999);
                        this.tweens.add({
                            targets: impact,
                            scale: 2, alpha: 0,
                            duration: 200,
                            onComplete: () => impact.destroy()
                        });
                    }
                });

                // Reload bolt based on configured fire cadence.
                const reloadDelay = Math.max(300, (stats.fireRate ?? 1900) - 250);
                this.scheduleBattleCall(reloadDelay, () => {
                    ballista.ballistaBoltLoaded = true;
                });
            }
        });
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

        // Small, narrow arrow (shuttle)
        const xbowLevel = xbow.level ?? 1;
        const arrow = this.add.graphics();
        // L3: gold shaft, L2: grey, L1: wood
        arrow.fillStyle(xbowLevel >= 3 ? 0xb8860b : 0x5d4e37, 1);
        arrow.fillRect(-6, -0.8, 12, 1.6);
        // Small arrowhead
        arrow.fillStyle(xbowLevel >= 3 ? 0xdaa520 : 0x4a4a4a, 1);
        arrow.beginPath();
        arrow.moveTo(7, 0);
        arrow.lineTo(4, -2);
        arrow.lineTo(4, 2);
        arrow.closePath();
        arrow.fillPath();
        // Fletching - Gold for L3, Grey for L2, Red for L1
        const fletchColor = xbowLevel >= 3 ? 0xffd700 : (xbowLevel >= 2 ? 0x444444 : 0xcc4444);
        arrow.fillStyle(fletchColor, 0.8);
        arrow.beginPath();
        arrow.moveTo(-6, 0);
        arrow.lineTo(-4, -2);
        arrow.lineTo(-2, 0);
        arrow.closePath();
        arrow.fillPath();

        arrow.setPosition(start.x, start.y - 20);
        arrow.setRotation(angle);
        arrow.setDepth(20000);



        const dist = Phaser.Math.Distance.Between(start.x, start.y, end.x, end.y);
        this.tweens.add({
            targets: arrow,
            x: end.x,
            y: end.y,
            duration: dist / 1.5, // Constant speed (1500 px/s)
            ease: 'Linear',
            onComplete: () => {
                arrow.destroy();
                // Deal level-scaled damage.
                if (targetTroop && targetTroop.health > 0) {
                    targetTroop.health -= xbowDamage;
                    targetTroop.hasTakenDamage = true;
                    this.updateHealthBar(targetTroop);
                    if (targetTroop.health <= 0) this.destroyTroop(targetTroop);
                }
                // Small impact
                const impact = this.add.circle(end.x, end.y, 4, 0x8b4513, 0.6);
                impact.setDepth(19999);
                this.tweens.add({
                    targets: impact,
                    scale: 1.5, alpha: 0,
                    duration: 100,
                    onComplete: () => impact.destroy()
                });
            }
        });
    }

    private showWardLaser(troop: Troop, target: Troop | PlacedBuilding, damage: number) {
        const start = IsoUtils.cartToIso(troop.gridX, troop.gridY);

        const isBuilding = ('type' in target && !!BUILDINGS[target.type]);
        const width = isBuilding ? BUILDINGS[target.type].width : 0.5;
        const height = isBuilding ? BUILDINGS[target.type].height : 0.5;

        const end = IsoUtils.cartToIso(target.gridX + width / 2, target.gridY + height / 2);

        const angle = Math.atan2(end.y - start.y, end.x - start.x);
        troop.facingAngle = angle;
        this.redrawTroop(troop);

        // Green for heal (negative damage), Cyan for attack
        const color = damage < 0 ? 0x00ff00 : 0x88ffcc;

        // Beam leaves the staff orb (villager-scale ward: orb at ~(4.6,-12)).
        const laser = this.add.graphics();
        laser.lineStyle(3, color, 0.9);
        laser.lineBetween(start.x + 4.6, start.y - 12, end.x, end.y - 20);
        laser.lineStyle(1.5, 0xffffff, 0.6);
        laser.lineBetween(start.x + 4.6, start.y - 12, end.x, end.y - 20);
        laser.setDepth(25000);

        const orb = this.add.circle(start.x + 4.6, start.y - 12, 4.5, color, 0.8);
        orb.setDepth(25001);

        // DEAL DAMAGE IMMEDIATELY ON LASER SPAWN (Attack Mode Only)
        if (damage > 0 && 'health' in target && target.health > 0) {
            target.health -= damage;

            // Only buildings show hit effect/health bar update this way
            if ('graphics' in target) {
                this.updateHealthBar(target);

                if (target.health <= 0) {
                    // It's a building
                    if ('type' in target && BUILDINGS[target.type]) {
                        this.destroyBuilding(target as PlacedBuilding);
                    } else {
                        // Troop death (if Ward attacks troops in future)
                        this.destroyTroop(target as unknown as Troop);
                    }
                }
            }
        }

        // Instant impact sparkle at target
        const sparkle = this.add.circle(end.x, end.y - 20, 8, 0x88ffcc, 0.7);
        sparkle.setDepth(25000);
        this.tweens.add({
            targets: sparkle,
            scale: 2, alpha: 0,
            duration: 200,
            onComplete: () => sparkle.destroy()
        });

        // Fade out the laser visual
        this.tweens.add({
            targets: [laser, orb],
            alpha: 0,
            duration: 300,
            onComplete: () => {
                laser.destroy();
                orb.destroy();
            }
        });
    }


    private redrawTroop(troop: Troop) {
        const g = troop.gameObject;
        // Attack animations tween plain objects whose callbacks outlive the
        // troop (golem slam, tank rotation, phalanx thrust). Drawing on a
        // destroyed Graphics throws inside Phaser's tween step and would kill
        // the whole game loop — a dead troop just skips its redraw.
        if (!g || !g.active || !g.scene) return;
        g.clear();
        if (SpriteBank.syncTroop(this, troop, true, this.troopAttackAge(troop), this.time.now)) return;
        TroopRenderer.drawTroopVisual(g, troop.type, troop.owner, troop.facingAngle, true, troop.slamOffset || 0, troop.bowDrawProgress || 0, troop.mortarRecoil || 0, false, troop.phalanxSpearOffset || 0, troop.level || 1, this.time.now, this.troopAttackAge(troop), troop.attackDelay);
    }

    private redrawTroopWithMovement(troop: Troop, isMoving: boolean) {
        const g = troop.gameObject;
        if (!g || !g.active || !g.scene) return; // see redrawTroop
        g.clear();
        if (SpriteBank.syncTroop(this, troop, isMoving, this.troopAttackAge(troop), this.time.now)) return;
        TroopRenderer.drawTroopVisual(g, troop.type, troop.owner, troop.facingAngle, isMoving, troop.slamOffset || 0, troop.bowDrawProgress || 0, troop.mortarRecoil || 0, false, troop.phalanxSpearOffset || 0, troop.level || 1, this.time.now, this.troopAttackAge(troop), troop.attackDelay);
    }

    /**
     * ms since this troop's last damage tick — the renderer keys wind-up /
     * strike animation off it so attacks land exactly when damage fires.
     * Live troops whose tick is stale (not actually fighting: pathing pauses,
     * wards trailing their leader) report -1 so idle stances stay idle;
     * replay troops never update lastAttackTime, so in REPLAY mode the stale
     * age passes through and the renderer free-runs the cycle instead.
     */
    private troopAttackAge(troop: Troop): number {
        const age = this.time.now - troop.lastAttackTime;
        if (age < 0) return -1; // chill effect pushes lastAttackTime ahead of the clock
        if (this.mode !== 'REPLAY' && age > troop.attackDelay + 600) return -1;
        return age;
    }

    private setTroopRetargetPause(troop: Troop, minMs: number = 70, maxMs: number = 180) {
        const pauseScale = 1.15; // Slightly longer hesitation for clearer "decision" feel.
        const scaledMin = Math.max(0, Math.round(minMs * pauseScale));
        const scaledMax = Math.max(scaledMin, Math.round(maxMs * pauseScale));
        const until = this.time.now + Phaser.Math.Between(scaledMin, scaledMax);
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
        // per-frame randomness into AI decisions.
        const base = troop.type === 'ward' ? 180 : 340;
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
        if (troop.type === 'ward') {
            const followTarget = this.findWardTarget(troop);
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
                    now
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
                    now
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
            return;
        }

        const selection = CombatNavigationSystem.selectTargetAndPlan(
            troop,
            this.buildings,
            this.troops,
            this.combatTopologyRevision,
            now,
            troop.strategicTarget ?? undefined
        );
        this.applyCombatNavigation(troop, selection, now);
    }

    private refreshTroopNavigation(troop: Troop, now: number) {
        if (troop.type === 'ward' && this.isLiveTroopTarget(troop.target)) {
            const leader = troop.target as Troop;
            const followRange = Math.min(2.5, Math.max(1.25, this.getTroopCombatStats(troop).range));
            const plan = CombatNavigationSystem.planToPoint(
                troop,
                { id: leader.id, gridX: leader.gridX, gridY: leader.gridY },
                followRange,
                this.buildings,
                this.troops,
                this.combatTopologyRevision,
                now
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
                strategic
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
            now
        );
        const activeTarget = this.liveBuildingById(plan?.activeTargetId);
        this.applyCombatNavigation(troop, {
            strategicTarget: plan ? strategic : null,
            activeTarget,
            plan
        }, now);
    }

    private ensureTroopNavigation(troop: Troop, now: number) {
        if (troop.type === 'ward' && this.isLiveTroopTarget(troop.target)) {
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

    private invalidateWardFollowers(removedTroopId: string) {
        for (const ward of this.troops) {
            if (ward.type !== 'ward' || (ward.target as { id?: string } | null)?.id !== removedTroopId) continue;
            ward.target = null;
            ward.navigationPlan = undefined;
            ward.path = undefined;
            ward.nextPathTime = 0;
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
        const turnRate = troop.type === 'golem' ? 0.004 : troop.type === 'ram' ? 0.006 : 0.01;
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
            const followsAlly = troop.type === 'ward'
                && !isBuilding
                && target.owner === troop.owner;
            const stopRange = followsAlly
                ? Math.min(2.5, Math.max(1.25, stats.range))
                : stats.range;
            return {
                centerX: bx + width / 2,
                centerY: by + height / 2,
                distance: Math.hypot(dx, dy),
                stopRange,
                stats
            };
        };

        for (const troop of this.troops) {
            if (troop.health <= 0) continue;

            this.ensureTroopNavigation(troop, now);

            // --- CHILLED STATUS EFFECT ---
            if ((troop.chillRemainingMs ?? 0) > 0) {
                troop.chillRemainingMs = (troop.chillRemainingMs ?? 0) - delta;
                if (troop.chillRemainingMs <= 0) {
                    troop.chillRemainingMs = 0;
                    const tinted = troop.gameObject as Phaser.GameObjects.Graphics & { clearTint?: () => void };
                    tinted.clearTint?.();
                } else {
                    const tinted = troop.gameObject as Phaser.GameObjects.Graphics & { setTint?: (color: number) => void };
                    tinted.setTint?.(0x88ccff);
                    if (troop.lastAttackTime) troop.lastAttackTime += delta * 1.5;
                }
            }

            let movedThisFrame = false;
            let target = troop.target as Troop | PlacedBuilding | null;
            let geometry = target ? geometryFor(troop, target) : null;

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
            } else if (target && geometry && geometry.distance > geometry.stopRange) {
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
                    && geometry.distance > geometry.stopRange) {
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
                                * (chilled ? 0.4 : 1);
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
                                this.mapSize
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
        soundSystem.play('destroy');

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

        const pos = IsoUtils.cartToIso(b.gridX + info.width / 2, b.gridY + info.height / 2);
        const size = Math.max(info.width, info.height);

        // Screen shake proportional to building size
        const shakeIntensity = (0.0015 + size * 0.001) * (this.mode === 'HOME' ? 0.2 : 1.0);
        this.cameras.main.shake(75 + size * 50, shakeIntensity);

        // Initial flash
        const flash = this.add.circle(pos.x, pos.y - 20, 10 * size, 0xffffcc, 0.8);
        flash.setDepth(30001);
        this.tweens.add({ targets: flash, scale: 2, alpha: 0, duration: 100, onComplete: () => flash.destroy() });

        // Rubble/debris chunks
        for (let i = 0; i < 8 + size * 4; i++) {
            const angle = Math.random() * Math.PI * 2;
            const dist = 20 + Math.random() * 30 * size;
            const rubbleColors = [0x8b7355, 0x6b5344, 0x5a4a3a, 0x4a3a2a];
            const rubble = this.add.graphics();
            rubble.fillStyle(rubbleColors[Math.floor(Math.random() * 4)], 1);
            const rubbleSize = 3 + Math.random() * 5;
            rubble.fillRect(-rubbleSize / 2, -rubbleSize / 2, rubbleSize, rubbleSize);
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
        for (let i = 0; i < 6 + size * 2; i++) {
            this.scheduleBattleCall(i * 30, () => {
                const dustColors = [0x8b7355, 0x9b8365, 0x7b6345];
                const dustSize = 8 + Math.floor(Math.random() * 10);
                const dust = this.add.graphics();
                dust.fillStyle(dustColors[Math.floor(Math.random() * 3)], 0.6);
                dust.fillRect(-dustSize / 2, -dustSize / 2, dustSize, dustSize);
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
        if (b.type === 'town_hall') {
            // Massive fire and explosion (pixelated rectangles)
            for (let i = 0; i < 25; i++) {
                const delay = i * 40;
                this.scheduleBattleCall(delay, () => {
                    const fireColors = [0xff4400, 0xff6600, 0xff8800, 0xffaa00];
                    const fireSize = 8 + Math.floor(Math.random() * 15);
                    const fire = this.add.graphics();
                    fire.fillStyle(fireColors[Math.floor(Math.random() * 4)], 0.9);
                    fire.fillRect(-fireSize / 2, -fireSize / 2, fireSize, fireSize);
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
        } else if (b.type === 'cannon' || b.type === 'mortar' || b.type === 'tesla') {
            // Sparks for defensive buildings
            for (let i = 0; i < 12; i++) {
                const spark = this.add.graphics();
                spark.lineStyle(2, b.type === 'tesla' ? 0x00ccff : 0xffaa00, 0.8);
                const len = 5 + Math.random() * 15;
                const angle = Math.random() * Math.PI * 2;
                spark.lineBetween(0, 0, Math.cos(angle) * len, Math.sin(angle) * len);
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

        if (b.barrelGraphics) b.barrelGraphics.destroy();
        b.healthBar.destroy();
        this.buildings.splice(index, 1);
        this.invalidateCombatTopologyForRemoval(b);

        // Wall visuals still need their neighbor joins refreshed; navigation
        // invalidation above already preserves each troop's real objective and
        // makes the new gap visible on the next plan.
        if (b.type === 'wall') {
            this.refreshWallNeighbors(b.gridX, b.gridY, b.owner);
        }

        if (this.mode === 'ATTACK') {
            // Track destruction stats and loot
            if (b.type !== 'wall') this.destroyedBuildings++;

            // Award loot if available
            if (b.loot) {
                this.goldLooted += b.loot.gold;
                this.oreLooted += b.loot.ore;
                this.foodLooted += b.loot.food;
            }

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


    private updateBattleStats() {
        const { totalKnown } = this.getBattleTotals();
        const destruction = totalKnown > 0
            ? Math.min(100, Math.round((this.destroyedBuildings / totalKnown) * 100))
            : 0;
        gameManager.updateBattleStats(destruction, this.goldLooted, this.oreLooted, this.foodLooted);
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

        const pos = IsoUtils.cartToIso(t.gridX, t.gridY);

        // WALL BREAKER EXPLOSION: Detailed boom with smoke, debris, and area ring
        if (t.type === 'wallbreaker') {
            const ex = pos.x;
            const ey = pos.y - 5;

            // 1. Area damage ring — expanding ground circle showing blast radius
            const ring = this.add.graphics();
            ring.lineStyle(3, 0xff6600, 0.7);
            ring.strokeEllipse(0, 0, 20, 10); // isometric ellipse
            ring.fillStyle(0xff4400, 0.15);
            ring.fillEllipse(0, 0, 20, 10);
            ring.setPosition(ex, ey + 8);
            ring.setDepth(29999);
            this.tweens.add({
                targets: ring, scaleX: 4, scaleY: 4, alpha: 0,
                duration: 400, ease: 'Quad.easeOut',
                onComplete: () => ring.destroy()
            });

            // 2. Core flash — bright white/yellow burst
            const flash = this.add.graphics();
            flash.fillStyle(0xffffff, 0.9);
            flash.fillCircle(0, 0, 6);
            flash.fillStyle(0xffff44, 0.7);
            flash.fillCircle(0, 0, 10);
            flash.setPosition(ex, ey);
            flash.setDepth(30005);
            this.tweens.add({ targets: flash, scale: 2.5, alpha: 0, duration: 150, onComplete: () => flash.destroy() });

            // 3. Fireball — orange/red expanding ball
            const fireball = this.add.graphics();
            fireball.fillStyle(0xff4400, 0.8);
            fireball.fillCircle(0, 0, 10);
            fireball.fillStyle(0xff8800, 0.6);
            fireball.fillCircle(-2, -2, 6);
            fireball.setPosition(ex, ey);
            fireball.setDepth(30003);
            this.tweens.add({ targets: fireball, scale: 2, alpha: 0, duration: 300, onComplete: () => fireball.destroy() });

            // 4. Screen shake
            this.cameras.main.shake(60, 0.003);

            // 5. Debris — barrel chunks, wood splinters, stone bits
            for (let i = 0; i < 14; i++) {
                const debrisAngle = Math.random() * Math.PI * 2;
                const debrisDist = 15 + Math.random() * 35;
                const debris = this.add.graphics();
                const isWood = Math.random() > 0.4;
                if (isWood) {
                    // Wood/barrel chunk
                    debris.fillStyle([0x5a3a1a, 0x6b4a2a, 0x8b6b4a][Math.floor(Math.random() * 3)], 0.9);
                    debris.fillRect(-1.5, -1, 3, 2 + Math.random() * 2);
                } else {
                    // Metal band / stone bit
                    debris.fillStyle([0x555555, 0x777777, 0x993300][Math.floor(Math.random() * 3)], 0.9);
                    debris.fillCircle(0, 0, 1 + Math.random() * 1.5);
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
                const smoke = this.add.graphics();
                const smokeSize = 6 + Math.random() * 8;
                const smokeAlpha = 0.3 + Math.random() * 0.2;
                smoke.fillStyle(i < 2 ? 0x222222 : 0x444444, smokeAlpha);
                smoke.fillCircle(0, 0, smokeSize);
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
                const spark = this.add.graphics();
                spark.fillStyle([0xffaa00, 0xff6600, 0xffff00][Math.floor(Math.random() * 3)], 1);
                spark.fillCircle(0, 0, 1);
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
            this.invalidateWardFollowers(t.id);
            t.gameObject.destroy();
            t.healthBar.destroy();
            return;
        }

        // RECURSION SPLIT: Spawn two smaller recursions on death if generation < 2
        if (t.type === 'recursion' && (t.recursionGen ?? 0) < 2) {
            const nextGen = (t.recursionGen ?? 0) + 1;
            // Spawn split effect
            const splitFlash = this.add.circle(pos.x, pos.y, 15, 0x00ffaa, 0.8);
            splitFlash.setDepth(30002);
            this.tweens.add({
                targets: splitFlash,
                scale: 2.5, alpha: 0,
                duration: 200,
                onComplete: () => splitFlash.destroy()
            });

            // Spawn two smaller recursions slightly offset
            const offsets = [
                { dx: -0.5, dy: -0.3 },
                { dx: 0.5, dy: 0.3 }
            ];
            for (const off of offsets) {
                this.pendingSpawnCount++;
                this.scheduleBattleCall(50, () => {
                    this.spawnTroop(t.gridX + off.dx, t.gridY + off.dy, 'recursion', t.owner, nextGen, t.level || 1);
                    this.pendingSpawnCount--;
                });
            }
        }

        // === GOLEM DEATH ANIMATION ===
        if (t.type === 'golem') {
            const isPlayer = t.owner === 'PLAYER';
            // Stone colors with ancient weathering - EXACTLY as in drawTroopVisual
            const stoneBase = isPlayer ? 0x5a6a7a : 0x6a5a5a;
            const stoneDark = isPlayer ? 0x3a4a5a : 0x4a3a3a;
            const stoneLight = isPlayer ? 0x7a8a9a : 0x8a7a7a;
            const stoneAccent = isPlayer ? 0x4a5a6a : 0x5a4a4a;
            const mossColor = isPlayer ? 0x4a6a3a : 0x5a4a3a;

            // Remove the troop immediately but keep visual debris
            this.troops = this.troops.filter(x => x.id !== t.id);
            this.invalidateWardFollowers(t.id);
            t.gameObject.destroy();
            t.healthBar.destroy();

            // Debris Depth: Render at the bottom (on ground level)
            const debrisDepth = 5;

            // 1. LEFT ARM PIECE
            const leftArm = this.add.graphics();
            leftArm.setPosition(pos.x, pos.y);
            leftArm.setDepth(debrisDepth);
            // Reconstruct Left Arm exactly:
            const lax = -18; const lay = -20;
            leftArm.fillStyle(stoneDark, 1);
            leftArm.beginPath(); leftArm.moveTo(lax - 4, lay); leftArm.lineTo(lax - 8, lay + 18); leftArm.lineTo(lax + 4, lay + 20); leftArm.lineTo(lax + 4, lay + 2); leftArm.closePath(); leftArm.fillPath();
            leftArm.fillStyle(stoneBase, 1);
            leftArm.beginPath(); leftArm.moveTo(lax - 2, lay + 2); leftArm.lineTo(lax - 4, lay + 16); leftArm.lineTo(lax + 2, lay + 17); leftArm.lineTo(lax + 2, lay + 3); leftArm.closePath(); leftArm.fillPath();
            const lfx = lax - 2; const lfy = lay + 18;
            leftArm.fillStyle(stoneAccent, 1);
            leftArm.beginPath(); leftArm.moveTo(lfx - 5, lfy); leftArm.lineTo(lfx - 7, lfy + 17); leftArm.lineTo(lfx + 5, lfy + 18); leftArm.lineTo(lfx + 6, lfy + 1); leftArm.closePath(); leftArm.fillPath();
            const lfistX = lfx - 1; const lfistY = lfy + 22;
            leftArm.fillStyle(stoneDark, 1); leftArm.fillCircle(lfistX, lfistY, 9);
            leftArm.fillStyle(stoneBase, 1); leftArm.fillCircle(lfistX - 1, lfistY - 1, 7);
            leftArm.fillStyle(stoneLight, 0.5); leftArm.fillCircle(lfistX - 4, lfistY - 3, 2); leftArm.fillCircle(lfistX, lfistY - 4, 2); leftArm.fillCircle(lfistX + 4, lfistY - 3, 2);

            this.tweens.add({
                targets: leftArm,
                x: pos.x - 12, y: pos.y + 10, rotation: -1.2, // Arms not as far (-22 -> -12)
                duration: 2800, // Slower (2400 -> 2800)
                ease: 'Bounce.easeOut',
                onComplete: () => {
                    this.tweens.add({ targets: leftArm, alpha: 0, duration: 4000, delay: 5000, onComplete: () => leftArm.destroy() });
                }
            });

            // 2. RIGHT ARM PIECE
            const rightArm = this.add.graphics();
            rightArm.setPosition(pos.x, pos.y);
            rightArm.setDepth(debrisDepth);
            // Reconstruct Right Arm exactly:
            const rax = 18; const ray = -20;
            rightArm.fillStyle(stoneDark, 1);
            rightArm.beginPath(); rightArm.moveTo(rax + 4, ray); rightArm.lineTo(rax + 8, ray + 18); rightArm.lineTo(rax - 4, ray + 20); rightArm.lineTo(rax - 4, ray + 2); rightArm.closePath(); rightArm.fillPath();
            rightArm.fillStyle(stoneBase, 1);
            rightArm.beginPath(); rightArm.moveTo(rax + 2, ray + 2); rightArm.lineTo(rax + 4, ray + 16); rightArm.lineTo(rax - 2, ray + 17); rightArm.lineTo(rax - 2, ray + 3); rightArm.closePath(); rightArm.fillPath();
            const rfx = rax + 2; const rfy = ray + 18;
            rightArm.fillStyle(stoneAccent, 1);
            rightArm.beginPath(); rightArm.moveTo(rfx + 5, rfy); rightArm.lineTo(rfx + 7, rfy + 17); rightArm.lineTo(rfx - 5, rfy + 18); rightArm.lineTo(rfx - 6, rfy + 1); rightArm.closePath(); rightArm.fillPath();
            const rfistX = rfx + 1; const rfistY = rfy + 22;
            rightArm.fillStyle(stoneDark, 1); rightArm.fillCircle(rfistX, rfistY, 9);
            rightArm.fillStyle(stoneBase, 1); rightArm.fillCircle(rfistX + 1, rfistY - 1, 7);
            rightArm.fillStyle(stoneLight, 0.5); rightArm.fillCircle(rfistX + 4, rfistY - 3, 2); rightArm.fillCircle(rfistX, rfistY - 4, 2); rightArm.fillCircle(rfistX - 4, rfistY - 3, 2);

            this.tweens.add({
                targets: rightArm,
                x: pos.x + 15, y: pos.y + 15, rotation: 1.4, // Arms not as far (+28 -> +15)
                duration: 3000, // Slower (2600 -> 3000)
                ease: 'Bounce.easeOut',
                onComplete: () => {
                    this.tweens.add({ targets: rightArm, alpha: 0, duration: 4000, delay: 4800, onComplete: () => rightArm.destroy() });
                }
            });

            // 3. LEFT LEG PIECE
            const leftLeg = this.add.graphics();
            leftLeg.setPosition(pos.x, pos.y);
            leftLeg.setDepth(debrisDepth);
            const legSpread = 12;
            leftLeg.fillStyle(stoneDark, 1);
            leftLeg.beginPath(); leftLeg.moveTo(-legSpread - 6, -5); leftLeg.lineTo(-legSpread - 8, 12); leftLeg.lineTo(-legSpread + 4, 14); leftLeg.lineTo(-legSpread + 2, -3); leftLeg.closePath(); leftLeg.fillPath();
            leftLeg.fillStyle(stoneBase, 1);
            leftLeg.beginPath(); leftLeg.moveTo(-legSpread - 4, -4); leftLeg.lineTo(-legSpread - 5, 10); leftLeg.lineTo(-legSpread, 11); leftLeg.lineTo(-legSpread + 1, -3); leftLeg.closePath(); leftLeg.fillPath();
            leftLeg.fillStyle(stoneDark, 1); leftLeg.fillRect(-legSpread - 10, 12, 16, 6);
            leftLeg.fillStyle(stoneAccent, 1); leftLeg.fillRect(-legSpread - 8, 11, 12, 3);

            this.tweens.add({
                targets: leftLeg,
                x: pos.x - 10, y: pos.y + 15, rotation: -0.5,
                duration: 2300, // Slightly slower (2000 -> 2300)
                ease: 'Bounce.easeOut',
                onComplete: () => {
                    this.tweens.add({ targets: leftLeg, alpha: 0, duration: 4000, delay: 5200, onComplete: () => leftLeg.destroy() });
                }
            });

            // 4. RIGHT LEG PIECE
            const rightLeg = this.add.graphics();
            rightLeg.setPosition(pos.x, pos.y);
            rightLeg.setDepth(debrisDepth);
            rightLeg.fillStyle(stoneDark, 1);
            rightLeg.beginPath(); rightLeg.moveTo(legSpread + 6, -5); rightLeg.lineTo(legSpread + 8, 12); rightLeg.lineTo(legSpread - 4, 14); rightLeg.lineTo(legSpread - 2, -3); rightLeg.closePath(); rightLeg.fillPath();
            rightLeg.fillStyle(stoneBase, 1);
            rightLeg.beginPath(); rightLeg.moveTo(legSpread + 4, -4); rightLeg.lineTo(legSpread + 5, 10); rightLeg.lineTo(legSpread, 11); rightLeg.lineTo(legSpread - 1, -3); rightLeg.closePath(); rightLeg.fillPath();
            rightLeg.fillStyle(stoneDark, 1); rightLeg.fillRect(legSpread - 6, 12, 16, 6);
            rightLeg.fillStyle(stoneAccent, 1); rightLeg.fillRect(legSpread - 4, 11, 12, 3);

            this.tweens.add({
                targets: rightLeg,
                x: pos.x + 12, y: pos.y + 12, rotation: 0.6,
                duration: 2500, // Slightly slower (2200 -> 2500)
                ease: 'Bounce.easeOut',
                onComplete: () => {
                    this.tweens.add({ targets: rightLeg, alpha: 0, duration: 4000, delay: 5100, onComplete: () => rightLeg.destroy() });
                }
            });

            // 5. TORSO RUIN
            const torso = this.add.graphics();
            torso.setPosition(pos.x, pos.y);
            torso.setDepth(debrisDepth);
            // Reconstruct Torso exactly. Note bodySlam=0 now.
            torso.fillStyle(stoneDark, 1);
            torso.beginPath(); torso.moveTo(-22, -8); torso.lineTo(-18, -28); torso.lineTo(18, -28); torso.lineTo(22, -8); torso.lineTo(16, 2); torso.lineTo(-16, 2); torso.closePath(); torso.fillPath();
            torso.fillStyle(stoneBase, 1);
            torso.beginPath(); torso.moveTo(-20, -10); torso.lineTo(-16, -30); torso.lineTo(16, -30); torso.lineTo(20, -10); torso.lineTo(14, 0); torso.lineTo(-14, 0); torso.closePath(); torso.fillPath();
            torso.fillStyle(stoneLight, 1);
            torso.beginPath(); torso.moveTo(-12, -24); torso.lineTo(-8, -28); torso.lineTo(8, -28); torso.lineTo(12, -24); torso.lineTo(10, -14); torso.lineTo(-10, -14); torso.closePath(); torso.fillPath();
            // DARK EYES on chest rune (no glow)
            torso.fillStyle(stoneDark, 1);
            torso.beginPath(); torso.moveTo(0, -26); torso.lineTo(-4, -22); torso.lineTo(0, -18); torso.lineTo(4, -22); torso.closePath(); torso.fillPath();
            // Cracks
            torso.lineStyle(1, stoneDark, 0.6); torso.lineBetween(-15, -20, -10, -15); torso.lineBetween(12, -25, 16, -18); torso.lineBetween(-8, -8, -3, -12); torso.lineBetween(5, -6, 10, -10);
            // Moss
            torso.fillStyle(mossColor, 0.7); torso.fillCircle(-14, -16, 3); torso.fillCircle(16, -12, 2.5); torso.fillCircle(-8, -4, 2);
            // Neck
            torso.fillStyle(stoneDark, 1); torso.fillRect(-8, -38, 16, 10);
            // Head
            torso.fillStyle(stoneBase, 1);
            torso.beginPath(); torso.moveTo(-14, -36); torso.lineTo(-16, -48); torso.lineTo(-10, -54); torso.lineTo(10, -54); torso.lineTo(16, -48); torso.lineTo(14, -36); torso.closePath(); torso.fillPath();
            torso.fillStyle(stoneDark, 1);
            torso.beginPath(); torso.moveTo(-14, -46); torso.lineTo(-12, -50); torso.lineTo(12, -50); torso.lineTo(14, -46); torso.lineTo(10, -44); torso.lineTo(-10, -44); torso.closePath(); torso.fillPath();
            // DARK EYES (lights off)
            torso.fillStyle(0x1a1a1a, 1); torso.fillCircle(-6, -45, 4); torso.fillCircle(6, -45, 4);

            this.tweens.add({
                targets: torso,
                y: pos.y + 5, scaleY: 0.85, rotation: 0.15, // Tilted to the side
                duration: 1600, // Even slower
                ease: 'Bounce.easeOut',
                onComplete: () => {
                    // (Rubble spawn removed as per request to fix "weird rectangles")
                    this.tweens.add({ targets: torso, alpha: 0, duration: 14000, delay: 8000, onComplete: () => torso.destroy() });
                }
            });

            // Dust cloud
            const dust = this.add.graphics();
            dust.fillStyle(0x888888, 0.1);
            dust.fillCircle(0, 0, 40);
            dust.setPosition(pos.x, pos.y + 10);
            dust.setDepth(debrisDepth - 2);
            this.tweens.add({
                targets: dust,
                scale: 3, alpha: 0, y: pos.y - 15,
                duration: 4800, // Even slower
                ease: 'Quad.easeOut',
                onComplete: () => dust.destroy()
            });

            return; // Skip normal death effects
        }
        // === END GOLEM DEATH ANIMATION ===

        // === PHALANX DEATH - Splits into 9 warriors ===
        if (t.type === 'phalanx') {
            // Flash effect
            const splitFlash = this.add.circle(pos.x, pos.y, 25, 0xffaa00, 0.8);
            splitFlash.setDepth(30002);
            this.tweens.add({
                targets: splitFlash,
                scale: 2, alpha: 0,
                duration: 300,
                onComplete: () => splitFlash.destroy()
            });

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
                    this.spawnTroop(t.gridX + off.dx, t.gridY + off.dy, 'romanwarrior', t.owner, 0, t.level || 1);
                    this.pendingSpawnCount--;
                });
            }

            // Debris dust (isometric oval)
            const dust = this.add.graphics();
            dust.fillStyle(0x888888, 0.3);
            dust.fillEllipse(0, 0, 40, 20);
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
            this.invalidateWardFollowers(t.id);
            t.gameObject.destroy();
            t.healthBar.destroy();

            // === SMOKE BURST to cover the transition ===
            // Create multiple small smoke puffs
            for (let i = 0; i < 8; i++) {
                const smoke = this.add.graphics();
                smoke.fillStyle(0x1a1a1a, 0.85);  // Very dark black smoke
                const smokeSize = 2 + Math.random() * 2;  // TINY (2-4px radius)
                smoke.fillCircle(0, 0, smokeSize);
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
            const spark = this.add.graphics();
            spark.fillStyle(0xff6600, 0.8);
            spark.fillCircle(0, 0, 15);
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
                const husk = this.add.graphics();
                husk.setPosition(pos.x, pos.y);
                husk.setDepth(depthForTroop(t.gridX, t.gridY, t.type));

                // Draw the deactivated tank
                TroopRenderer.drawDaVinciTank(husk, isPlayer, false, true, t.facingAngle || 0);

                // Small dust cloud on impact
                const dust = this.add.graphics();
                dust.fillStyle(0x888888, 0.2);
                dust.fillCircle(0, 0, 30);
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
        const flash = this.add.graphics();
        flash.fillRect(-6, -6, 12, 12);
        flash.setPosition(pos.x, pos.y);
        flash.setDepth(30001);
        this.tweens.add({ targets: flash, scale: 2, alpha: 0, duration: 100, onComplete: () => flash.destroy() });

        // Particle burst (pixelated rectangles)
        const particleColors = t.type === 'warrior' ? [0xffff00, 0xffcc00] :
            t.type === 'archer' ? [0x00ccff, 0x0088cc] :
                t.type === 'recursion' ? [0x00ffaa, 0x00cc88] :
                    [0xff8800, 0xcc6600];
        for (let i = 0; i < 8; i++) {
            const angle = (i / 8) * Math.PI * 2;
            const particle = this.add.graphics();
            particle.fillStyle(particleColors[i % 2], 0.9);
            particle.fillRect(-3, -3, 6, 6);
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
        const smoke = this.add.graphics();
        smoke.fillStyle(0x666666, 0.5);
        smoke.fillRect(-10, -10, 20, 20);
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
        this.invalidateWardFollowers(t.id);
        t.gameObject.destroy();
        t.healthBar.destroy();
    }

    private showGolemCrackEffect(x: number, y: number) {
        // Create ground crack effect for Golem ground pound
        const crackGraphics = this.add.graphics();
        crackGraphics.setPosition(x, y);
        crackGraphics.setDepth(5);

        // Draw radial cracks
        const crackColor = 0x3a3a3a;
        const crackCount = 8;
        const maxLength = 60;

        for (let i = 0; i < crackCount; i++) {
            const angle = (i / crackCount) * Math.PI * 2 + Math.random() * 0.3;
            const length = maxLength * (0.6 + Math.random() * 0.4);

            // Main crack line
            crackGraphics.lineStyle(3, crackColor, 0.8);
            crackGraphics.beginPath();
            crackGraphics.moveTo(0, 0);

            // Jagged path
            let cx = 0, cy = 0;
            const segments = 3;
            for (let s = 1; s <= segments; s++) {
                const progress = s / segments;
                const jitter = (Math.random() - 0.5) * 15;
                cx = Math.cos(angle) * length * progress + Math.cos(angle + Math.PI / 2) * jitter;
                cy = Math.sin(angle) * length * progress * 0.5 + Math.sin(angle + Math.PI / 2) * jitter * 0.5;
                crackGraphics.lineTo(cx, cy);
            }
            crackGraphics.strokePath();

            // Branch cracks
            if (Math.random() > 0.4) {
                const branchAngle = angle + (Math.random() - 0.5) * 0.8;
                const branchLen = length * 0.4;
                crackGraphics.lineStyle(2, crackColor, 0.6);
                crackGraphics.beginPath();
                crackGraphics.moveTo(cx * 0.6, cy * 0.6);
                crackGraphics.lineTo(
                    cx * 0.6 + Math.cos(branchAngle) * branchLen,
                    cx * 0.6 + Math.sin(branchAngle) * branchLen * 0.5
                );
                crackGraphics.strokePath();
            }
        }

        // Fade out cracks
        this.tweens.add({
            targets: crackGraphics,
            alpha: 0,
            duration: 1200, // Slightly longer fade for better "settling" feel
            delay: 400,
            onComplete: () => crackGraphics.destroy()
        });
    }

    public spawnTroop(
        gx: number,
        gy: number,
        type: TroopType = 'warrior',
        owner: 'PLAYER' | 'ENEMY' = 'PLAYER',
        recursionGen: number = 0,
        troopLevelOverride?: number
    ) {
        // Bounds check - Relaxed for deployment margin
        const margin = 2;
        if (gx < -margin || gy < -margin || gx >= this.mapSize + margin || gy >= this.mapSize + margin) {
            return;
        }
        const troopLevel = Math.max(1, Math.floor(troopLevelOverride ?? this.getTroopLevelForOwner(owner)));
        const stats = getTroopStats(type, troopLevel);
        const attackDelay = stats.attackDelay ?? (700 + Math.random() * 300);
        const firstAttackDelay = stats.firstAttackDelay ?? 0;
        const spawnTime = this.time.now;
        const legalSpawn = this.nearestWalkableTroopPoint({ type, level: troopLevel }, gx, gy);
        gx = legalSpawn.x;
        gy = legalSpawn.y;
        const pos = IsoUtils.cartToIso(gx, gy);

        // Scale factor for recursions based on generation (each split = 75% size)
        const scaleFactor = type === 'recursion' ? Math.pow(0.75, recursionGen) : 1;

        // Create detailed troop graphic
        const troopGraphic = this.add.graphics();
        troopGraphic.setPosition(pos.x, pos.y);
        troopGraphic.setDepth(depthForTroop(gx, gy, type));
        if (!SpriteBank.syncLooseTroop(this, troopGraphic, type, owner, troopLevel, 0, true, this.time.now)) {
            TroopRenderer.drawTroopVisual(troopGraphic, type, owner, 0, true, 0, 0, 0, false, 0, troopLevel, this.time.now);
        }

        // Spawn dust effect - depth just below troop for proper layering
        const troopDepth = depthForTroop(gx, gy, type);
        for (let i = 0; i < 5; i++) {
            const dust = this.add.circle(
                pos.x + (Math.random() - 0.5) * 15,
                pos.y + 5,
                3 + Math.random() * 3,
                0x8b7355,
                0.5
            );
            dust.setDepth(troopDepth - 1);
            this.tweens.add({
                targets: dust,
                x: dust.x + (Math.random() - 0.5) * 20,
                y: dust.y - 10,
                alpha: 0, scale: 1.5,
                duration: 300 + Math.random() * 200,
                onComplete: () => dust.destroy()
            });
        }

        // Landing bounce animation
        troopGraphic.setScale(0.5 * scaleFactor);
        troopGraphic.y -= 20;
        this.tweens.add({
            targets: troopGraphic,
            scaleX: scaleFactor, scaleY: scaleFactor,
            y: pos.y,
            duration: 200,
            ease: 'Bounce.easeOut'
        });

        // Recursions have reduced health per generation (70% per gen)
        const healthMod = type === 'recursion' ? Math.pow(0.7, recursionGen) : 1;
        const troopHealth = stats.health * healthMod;

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
            facingAngle: 0,
            recursionGen: type === 'recursion' ? recursionGen : undefined
        };

        this.troops.push(troop);
        this.hasDeployed = true;
        if (owner === 'PLAYER' && this.mode === 'ATTACK' && type !== 'romanwarrior' && recursionGen === 0) {
            // First-generation deploys leave the camp; splits are battlefield spawns.
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
    }




    public getBuildingsBounds(owner: 'PLAYER' | 'ENEMY') {
        const ownerBuildings = this.buildings.filter(b => b.owner === owner);
        if (ownerBuildings.length === 0) return null;
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        ownerBuildings.forEach(b => {
            const info = BUILDINGS[b.type];
            minX = Math.min(minX, b.gridX);
            minY = Math.min(minY, b.gridY);
            maxX = Math.max(maxX, b.gridX + info.width);
            maxY = Math.max(maxY, b.gridY + info.height);
        });
        const buffer = 1;
        // Clamp to map bounds
        return {
            minX: Math.max(0, minX - buffer),
            minY: Math.max(0, minY - buffer),
            maxX: Math.min(this.mapSize, maxX + buffer),
            maxY: Math.min(this.mapSize, maxY + buffer)
        };
    }

    private updateDeploymentHighlight() {
        this.deploymentGraphics.clear();
        this.forbiddenGraphics.clear();

        if (this.mode !== 'ATTACK' || this.isScouting) {
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
        this.deploymentGraphics.lineStyle(2, 0xffffff, 0.4);
        this.deploymentGraphics.strokePoints([i1, i2, i3, i4], true, true);

        // Grid highlight
        this.deploymentGraphics.lineStyle(2, 0xadffad, 0.6);
        this.deploymentGraphics.strokePoints([m1, m2, m3, m4], true, true);

        // 2. Draw INNER forbidden zone (into red graphics)
        const bounds = this.getBuildingsBounds('ENEMY');
        if (bounds) {
            const b1 = IsoUtils.cartToIso(bounds.minX, bounds.minY);
            const b2 = IsoUtils.cartToIso(bounds.maxX, bounds.minY);
            const b3 = IsoUtils.cartToIso(bounds.maxX, bounds.maxY);
            const b4 = IsoUtils.cartToIso(bounds.minX, bounds.maxY);

            // Red zone fill
            this.forbiddenGraphics.fillStyle(0xff0000, 0.2);
            this.forbiddenGraphics.fillPoints([b1, b2, b3, b4], true);

            // Red zone border
            this.forbiddenGraphics.lineStyle(2, 0xff0000, 0.5);
            this.forbiddenGraphics.strokePoints([b1, b2, b3, b4], true, true);
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

        // Create sparkle particles
        const numParticles = 12;
        for (let i = 0; i < numParticles; i++) {
            const angle = (i / numParticles) * Math.PI * 2;
            const speed = 40 + Math.random() * 40;
            const particle = this.add.graphics();
            particle.setDepth(building.graphics.depth + 100);

            // Random gold/yellow/white colors
            const colors = [0xFFD700, 0xFFA500, 0xFFFF00, 0xFFFFFF, 0xFFE4B5];
            const color = colors[Math.floor(Math.random() * colors.length)];
            const size = 3 + Math.random() * 3;

            particle.fillStyle(color, 1);
            particle.fillCircle(0, 0, size);
            particle.x = centerX;
            particle.y = centerY;

            this.tweens.add({
                targets: particle,
                x: centerX + Math.cos(angle) * speed,
                y: centerY + Math.sin(angle) * speed - 40 - Math.random() * 30,
                alpha: 0,
                scale: { from: 1, to: 0.2 },
                duration: 800 + Math.random() * 400,
                ease: 'Cubic.easeOut',
                onComplete: () => particle.destroy()
            });
        }

        // Create rising star effect
        for (let i = 0; i < 3; i++) {
            const star = this.add.graphics();
            star.setDepth(building.graphics.depth + 110);
            star.fillStyle(0xFFD700, 1);
            star.beginPath();
            star.moveTo(0, -6);
            star.lineTo(2, -2);
            star.lineTo(6, 0);
            star.lineTo(2, 2);
            star.lineTo(0, 6);
            star.lineTo(-2, 2);
            star.lineTo(-6, 0);
            star.lineTo(-2, -2);
            star.closePath();
            star.fillPath();
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
    public showBuildingRangeIndicator(building: PlacedBuilding) {
        // Only show range for defensive buildings
        const info = BUILDINGS[building.type];
        if (info.category !== 'defense' || building.type === 'wall') return;

        // Clear any existing indicator
        this.clearBuildingRangeIndicator();

        // Get the range for this building type
        // Get range from centralized stats
        const range = info.range || 0;
        const deadZone = info.minRange || 0;

        if (range === 0) return;

        // Calculate center position
        const center = IsoUtils.cartToIso(building.gridX + info.width / 2, building.gridY + info.height / 2);

        // Create range indicator graphics
        const rangeGraphics = this.add.graphics();
        rangeGraphics.setDepth(building.graphics.depth + 2);

        // Calculate isometric ellipse size (range in pixels)
        // Note: We need Math.SQRT2 factor because isometric projection of a grid-circle
        // creates an ellipse where the major axis corresponds to the grid diagonal.
        const radiusX = range * this.tileWidth * 0.5 * Math.SQRT2;
        const radiusY = range * this.tileHeight * 0.5 * Math.SQRT2;

        // Draw subtle filled area
        rangeGraphics.fillStyle(0x4488ff, 0.08);
        rangeGraphics.fillEllipse(center.x, center.y, radiusX * 2, radiusY * 2);

        // Draw dashed outline (simulate with multiple arcs)
        rangeGraphics.lineStyle(2, 0x4488ff, 0.4);
        const dashCount = 24;
        const dashGap = 0.4; // Gap ratio
        for (let i = 0; i < dashCount; i++) {
            const startAngle = (i / dashCount) * Math.PI * 2;
            const endAngle = ((i + (1 - dashGap)) / dashCount) * Math.PI * 2;

            // Draw arc segment as a series of lines
            rangeGraphics.beginPath();
            const steps = 5;
            for (let j = 0; j <= steps; j++) {
                const t = startAngle + (endAngle - startAngle) * (j / steps);
                const x = center.x + Math.cos(t) * radiusX;
                const y = center.y + Math.sin(t) * radiusY;
                if (j === 0) {
                    rangeGraphics.moveTo(x, y);
                } else {
                    rangeGraphics.lineTo(x, y);
                }
            }
            rangeGraphics.strokePath();
        }

        // Add a subtle glow
        rangeGraphics.lineStyle(4, 0x4488ff, 0.15);
        rangeGraphics.strokeEllipse(center.x, center.y, radiusX * 2, radiusY * 2);

        // === DEAD ZONE INDICATOR ===
        if (deadZone > 0) {
            const deadRadiusX = deadZone * this.tileWidth * 0.5;
            const deadRadiusY = deadZone * this.tileHeight * 0.5;

            // Draw dead zone filled area (red, more opaque)
            rangeGraphics.fillStyle(0xff4444, 0.15);
            rangeGraphics.fillEllipse(center.x, center.y, deadRadiusX * 2, deadRadiusY * 2);

            // Draw dead zone dashed outline (red)
            rangeGraphics.lineStyle(2, 0xff4444, 0.5);
            for (let i = 0; i < dashCount; i++) {
                const startAngle = (i / dashCount) * Math.PI * 2;
                const endAngle = ((i + (1 - dashGap)) / dashCount) * Math.PI * 2;

                rangeGraphics.beginPath();
                const steps = 5;
                for (let j = 0; j <= steps; j++) {
                    const t = startAngle + (endAngle - startAngle) * (j / steps);
                    const x = center.x + Math.cos(t) * deadRadiusX;
                    const y = center.y + Math.sin(t) * deadRadiusY;
                    if (j === 0) {
                        rangeGraphics.moveTo(x, y);
                    } else {
                        rangeGraphics.lineTo(x, y);
                    }
                }
                rangeGraphics.strokePath();
            }
        }

        building.rangeIndicator = rangeGraphics;
        this.attackModeSelectedBuilding = building;

        // Add subtle pulse animation
        this.tweens.add({
            targets: rangeGraphics,
            alpha: 0.6,
            duration: 800,
            yoyo: true,
            repeat: -1,
            ease: 'Sine.easeInOut'
        });
    }

    public clearBuildingRangeIndicator() {
        if (this.attackModeSelectedBuilding?.rangeIndicator) {
            this.attackModeSelectedBuilding.rangeIndicator.destroy();
            this.attackModeSelectedBuilding.rangeIndicator = undefined;
        }
        this.attackModeSelectedBuilding = null;
    }

    private handleCameraMovement(delta: number) {
        if (!this.cursorKeys) return;
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
            const b = this.selectedInWorld;
            const info = BUILDINGS[b.type];

            // When moving, draw outline at ghost position instead of actual position
            const gx = (this.isMoving && this.ghostGridPos) ? this.ghostGridPos.x : b.gridX;
            const gy = (this.isMoving && this.ghostGridPos) ? this.ghostGridPos.y : b.gridY;

            // Draw bright border around base
            const p1 = IsoUtils.cartToIso(gx, gy);
            const p2 = IsoUtils.cartToIso(gx + info.width, gy);
            const p3 = IsoUtils.cartToIso(gx + info.width, gy + info.height);
            const p4 = IsoUtils.cartToIso(gx, gy + info.height);

            this.selectionGraphics.lineStyle(4, 0x00ffff, 1); // Bright Cyan
            this.selectionGraphics.beginPath();
            this.selectionGraphics.moveTo(p1.x, p1.y);
            this.selectionGraphics.lineTo(p2.x, p2.y);
            this.selectionGraphics.lineTo(p3.x, p3.y);
            this.selectionGraphics.lineTo(p4.x, p4.y);
            this.selectionGraphics.closePath();
            this.selectionGraphics.strokePath();

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
                    // Immediately show ghost building by triggering onPointerMove
                    if (this.input.activePointer) {
                        this.inputController.onPointerMove(this.input.activePointer);
                    }
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
                    // Reset battle stats for new village
                    this.initialEnemyBuildings = this.getAttackEnemyBuildings().length;
                    this.destroyedBuildings = 0;
                    this.goldLooted = 0;
        this.oreLooted = 0;
        this.foodLooted = 0;
                    this.updateBattleStats();
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
            moveSelectedBuilding: () => {
                if (this.selectedInWorld) {
                    // Unbake the building from ground texture before moving to prevent artifacts
                    this.unbakeBuildingFromGround(this.selectedInWorld);
                }
                this.isMoving = true;
                this.selectedBuildingType = null;
                // Hide the info popup while carrying the building — it sits
                // right where you're dragging and steals the pointer. The
                // drop handler re-emits the selection at the new spot.
                gameManager.onBuildingSelected(null);
                // Immediate visual feedback
                this.inputController.onPointerMove(this.input.activePointer);
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
                    this.selectedInWorld.upgradingTo = targetLevel;
                    this.selectedInWorld.upgradeEndsAt = Date.now() + upgradeDurationMs(this.selectedInWorld.type, targetLevel);
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
        this.hasDeployed = false;
        this.raidEndScheduled = true;
        if (this.mode === 'ATTACK') {
            const settlement = this.endAttackReplayCapture('aborted');
            if (settlement) {
                await settlement.catch(error => {
                    console.warn('Attack settlement failed before home reload:', error);
                });
            } else {
                // If the attack was registered but no troop ever deployed,
                // settle it as a zero-result abort before reading home truth.
                await this.abandonCurrentAttack();
            }
            // A retreat from a bot camp still consumed the troops that marched
            // (and banks whatever loot the destruction so far earned).
            await this.settleBotRaid().catch(() => undefined);
        }
        this.currentEnemyWorld = null;
        // A next-door battle retreats the way it came: the column marches
        // home on screen and the home frame swaps in silently mid-glide.
        if (this.battleInPlace && this.beginHomecomingMarch()) return;
        this.forceFinishHomecoming(); // a second goHome mid-march completes it
        this.worldMap.endFocus();
        this.battleInPlace = false;
        // Back on our own lawn (and our name back over the gate).
        this.rebakeGround(this.userId || 'village');
        this.setVillageNameVisible(true);
        this.clearReplayWatchState();
        this.cancelPlacement();
        gameManager.setGameMode('HOME');
        this.mode = 'HOME';
        this.isScouting = false;
        this.hasDeployed = false;
        await this.reloadHomeBase({ refreshOnline: true });
    }

    /**
     * The seamless half of the retreat, mirroring the invasion: the battle
     * frame stays up, the flag bearer leads the undeployed troops home down
     * the roads, and the home frame renders hidden while they walk. Returns
     * false when a silent swap is impossible (fall back to the hard cut).
     */
    private beginHomecomingMarch(): boolean {
        if (!this.userId || !this.worldMap.inBattleFrame()) return false;
        const home = Backend.getCachedWorld(this.userId);
        if (!home || !Array.isArray(home.buildings) || home.buildings.length === 0) return false;
        this.battleInPlace = false;
        this.clearReplayWatchState();
        this.cancelPlacement();
        this.clearBattleActors();
        gameManager.setGameMode('HOME');
        this.mode = 'HOME';
        this.isScouting = false;
        this.hasDeployed = false;
        this.pendingHomecoming = { world: home };
        // Hidden preparation, exactly like the outbound march.
        this.worldMap.prepareFocus(this.worldMap.homePlot());
        this.prepareGroundBake(this.userId);
        this.worldMap.marchHome(
            this.armyFigures(),
            () => void this.finishHomecoming(),
            () => this.forceFinishHomecoming()
        );
        return true;
    }

    private async finishHomecoming() {
        await this.worldMap.waitForFocusReady();
        this.forceFinishHomecoming();
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

    /** One figure per troop for the marching column, actual army composition. */
    private armyFigures(cap = 24): string[] {
        const army = gameManager.getArmy();
        return Object.entries(army)
            .filter(([, count]) => Number(count) > 0)
            .sort((a, b) => Number(b[1]) - Number(a[1]))
            .flatMap(([type, count]) => new Array<string>(Math.max(0, Math.floor(Number(count)))).fill(type))
            .slice(0, cap);
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
        this.villageLife.clear();
        this.dayNight.clearLights();

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

        // Clear all UI overlay graphics
        this.ghostBuilding.clear();
        this.ghostBuilding.setVisible(false);
        this.selectionGraphics.clear();
        this.deploymentGraphics.clear();
        this.deploymentGraphics.setVisible(false);
        this.forbiddenGraphics.clear();
        this.forbiddenGraphics.setVisible(false);

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
        const lootAmount = Math.max(0, Math.floor(world.resources?.gold ?? 0));
        const lootOre = Math.max(0, Math.floor(world.resources?.ore ?? 0));
        const lootFood = Math.max(0, Math.floor(world.resources?.food ?? 0));
        const lootMap = LootSystem.calculateLootDistribution(
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
                inst.loot = lootMap.get(building.id);
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
        this.replayAutoExitQueued = false;
    }

    private queueReplayReturnHome(delayMs = 900) {
        if (this.replayAutoExitQueued) return;
        this.replayAutoExitQueued = true;

        this.time.delayedCall(delayMs, () => {
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
                    recursionGen: troop.recursionGen,
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
        if (!SpriteBank.syncLooseTroop(this, troopGraphic, troopType, snapshot.owner, troopLevel, snapshot.facingAngle ?? 0, true, this.time.now)) {
            TroopRenderer.drawTroopVisual(
                troopGraphic,
                troopType,
                snapshot.owner,
                snapshot.facingAngle ?? 0,
                true,
                0,
                0,
                0,
                false,
                0,
                snapshot.level,
                this.time.now
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
            recursionGen: snapshot.recursionGen,
            replayPrevSampleX: snapshot.gridX,
            replayPrevSampleY: snapshot.gridY,
            replayPrevSampleT: 0,
            replaySampleX: snapshot.gridX,
            replaySampleY: snapshot.gridY,
            replaySampleT: 0,
        };
        return troop;
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
                troop.recursionGen = snapshot.recursionGen;
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

        for (const troop of this.troops) {
            if (troop.health <= 0) continue;

            const sampleX = Number(troop.replaySampleX);
            const sampleY = Number(troop.replaySampleY);
            const sampleT = Number(troop.replaySampleT);
            if (!Number.isFinite(sampleX) || !Number.isFinite(sampleY) || !Number.isFinite(sampleT)) continue;

            const prevX = Number.isFinite(troop.replayPrevSampleX) ? Number(troop.replayPrevSampleX) : sampleX;
            const prevY = Number.isFinite(troop.replayPrevSampleY) ? Number(troop.replayPrevSampleY) : sampleY;
            const prevT = Number.isFinite(troop.replayPrevSampleT) ? Number(troop.replayPrevSampleT) : sampleT;

            let targetX = sampleX;
            let targetY = sampleY;
            if (renderT < sampleT && sampleT > prevT + 0.5) {
                const alphaT = Phaser.Math.Clamp((renderT - prevT) / (sampleT - prevT), 0, 1);
                targetX = Phaser.Math.Linear(prevX, sampleX, alphaT);
                targetY = Phaser.Math.Linear(prevY, sampleY, alphaT);
            }

            const prevRenderX = troop.gridX;
            const prevRenderY = troop.gridY;
            const errorDist = Phaser.Math.Distance.Between(prevRenderX, prevRenderY, targetX, targetY);
            if (errorDist > 2.5) {
                // The data really moved (spawn reposition / scripted jump): trust it.
                troop.gridX = targetX;
                troop.gridY = targetY;
            } else if (errorDist > 0.0001) {
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

            const moving = errorDist > 0.05 || motionDist > 0.001;
            const onScreen = !this.isOffScreen(troop.gridX, troop.gridY);
            if (onScreen && (
                troop.type === 'warrior' ||
                troop.type === 'archer' ||
                troop.type === 'giant' ||
                troop.type === 'ram' ||
                troop.type === 'golem' ||
                troop.type === 'sharpshooter' ||
                troop.type === 'mobilemortar' ||
                troop.type === 'davincitank' ||
                troop.type === 'phalanx' ||
                troop.type === 'romanwarrior' ||
                troop.type === 'wallbreaker' ||
                troop.type === 'stormmage' ||
                troop.type === 'ward' ||
                troop.type === 'recursion'
            )) {
                this.redrawTroopWithMovement(troop, moving);
            } else if (onScreen && moving) {
                this.redrawTroop(troop);
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
            const replayFrames = replay.frames ?? [];
            const replayTimeOffset = replayFrames.length > 0 ? replayFrames[0].t : 0;
            const normalizedFrames = replayFrames.map(frame => ({
                ...frame,
                t: Math.max(0, frame.t - replayTimeOffset)
            }));
            this.ingestReplayFrames(watchState, normalizedFrames);

            if (watchState.frames.length > 0) {
                this.applyReplayFrame(watchState.frames[0]);
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
            this.applyReplayFrame(watchState.frames[baseline]);
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
            if (replay.status !== 'live') this.queueReplayReturnHome(900);
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

        if (replay.status !== 'live' && replay.renderClockT >= headT && replay.nextFrameIndex >= frames.length) {
            this.queueReplayReturnHome(1100);
        }
    }


    private findWardTarget(ward: Troop): Troop | PlacedBuilding | null {
        // Wards support combat troops, never other wards. If the healers are
        // all that remain they must fall through to an enemy building instead
        // of selecting each other as permanent follow targets.
        const allies = this.troops.filter(t =>
            t.owner === ward.owner && t !== ward && t.type !== 'ward' && t.health > 0
        );

        // 1. Closest INJURED ally (Priority)
        const injured = allies.filter(t => t.health < t.maxHealth);
        if (injured.length > 0) {
            injured.sort((a, b) => {
                const da = Phaser.Math.Distance.Between(ward.gridX, ward.gridY, a.gridX, a.gridY);
                const db = Phaser.Math.Distance.Between(ward.gridX, ward.gridY, b.gridX, b.gridY);
                return da - db;
            });
            return injured[0];
        }

        // 2. Closest Ally (to follow)
        if (allies.length > 0) {
            allies.sort((a, b) => {
                const da = Phaser.Math.Distance.Between(ward.gridX, ward.gridY, a.gridX, a.gridY);
                const db = Phaser.Math.Distance.Between(ward.gridX, ward.gridY, b.gridX, b.gridY);
                return da - db;
            });
            return allies[0];
        }

        // 3. Enemy
        return TargetingSystem.findTarget(ward, this.buildings);
    }
    public createSmokeEffect(x: number, y: number) {
        particleManager.emitDustBurst(x, y, 10005);
    }

    private shootDragonsBreathAt(db: PlacedBuilding, troop: Troop) {
        const stats = this.getDefenseStats(db);
        const range = stats.range || 13;

        // Find all potential targets in range to distribute pods
        const potentialTargets = this.troops.filter(t =>
            t.owner !== db.owner &&
            t.health > 0 &&
            Phaser.Math.Distance.Between(db.gridX, db.gridY, t.gridX, t.gridY) <= range
        );

        // A soft rumble as the salvo begins
        this.cameras.main.shake(60, 0.0012);

        for (let i = 0; i < 16; i++) {
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
                    const silo = IsoUtils.cartToIso(db.gridX + col + 0.5, db.gridY + row + 0.5);
                    this.shootDragonPod(db, { x: silo.x, y: silo.y + 2 - 14 }, target.gridX + jitterX, target.gridY + jitterY, stats.damage || 25);
                }
            });
        }
    }

    private shootDragonPod(db: PlacedBuilding, start: { x: number, y: number }, targetGridX: number, targetGridY: number, damage: number) {
        const end = IsoUtils.cartToIso(targetGridX, targetGridY);
        const dbLevel = db.level ?? 1;

        // Create firecracker rocket graphics, standing exactly where the
        // silo's rocket was drawn.
        const pod = this.add.graphics();
        const startX = start.x;
        const startY = start.y;
        pod.setPosition(startX, startY);
        pod.setDepth(5000);

        // Draw the rocket EXACTLY like the pod standing in the silo (see
        // BuildingRenderer.drawDragonsBreath), so launch is seamless.
        const drawRocket = () => {
            pod.clear();

            // Body with a lit flank
            pod.fillStyle(dbLevel >= 2 ? 0x9c1f1f : 0xa03028, 1);
            pod.fillRect(-5, -8, 10, 20);
            pod.fillStyle(dbLevel >= 2 ? 0xc22e2e : 0xb84438, 1);
            pod.fillRect(-5, -8, 4, 20);

            // Rune band + stud
            pod.lineStyle(1.3, dbLevel >= 2 ? 0xe6dcc2 : 0xd8c49a, 1);
            pod.lineBetween(-5, 6, 5, 6);
            if (dbLevel >= 2) {
                pod.fillStyle(0xffd700, 0.9);
                pod.fillCircle(0, 6, 1.4);
            }

            // Nose cone
            pod.fillStyle(dbLevel >= 2 ? 0xdaa520 : 0x8a6a2a, 1);
            pod.beginPath();
            pod.moveTo(0, -16);
            pod.lineTo(-5, -8);
            pod.lineTo(5, -8);
            pod.closePath();
            pod.fillPath();

            // Fin tails (max level)
            if (dbLevel >= 2) {
                pod.fillStyle(0xb8860b, 1);
                pod.beginPath();
                pod.moveTo(-5, 8);
                pod.lineTo(-8, 13);
                pod.lineTo(-5, 12.5);
                pod.closePath();
                pod.fillPath();
                pod.beginPath();
                pod.moveTo(5, 8);
                pod.lineTo(8, 13);
                pod.lineTo(5, 12.5);
                pod.closePath();
                pod.fillPath();
            }

            // Exhaust flame
            pod.fillStyle(0xff6600, 0.9);
            pod.beginPath();
            pod.moveTo(-3, 12);
            pod.lineTo(0, 20);
            pod.lineTo(3, 12);
            pod.closePath();
            pod.fillPath();
            pod.fillStyle(0xffd25e, 0.85);
            pod.beginPath();
            pod.moveTo(-1.8, 12);
            pod.lineTo(0, 16.5);
            pod.lineTo(1.8, 12);
            pod.closePath();
            pod.fillPath();
        };

        // Initial draw: upright on the pad
        drawRocket();
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
                drawRocket();
                if (Math.random() > 0.5) {
                    const blast = this.add.graphics();
                    blast.fillStyle(0xffaa33, 0.7);
                    blast.fillCircle(0, 0, 2 + Math.random() * 2);
                    blast.setPosition(pod.x + (Math.random() - 0.5) * 5, pod.y + 14);
                    blast.setDepth(4999);
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

                void t;
                // The rocket stays a rocket all the way down its arc.
                const angle = Math.atan2(pod.y - lastY, pod.x - lastX);
                pod.setRotation(angle + Math.PI / 2);
                drawRocket();

                // A tight ember ribbon — uniform glowing motes, no grey smog.
                const now = this.time.now;
                if (now - lastEmberAt > 26) {
                    lastEmberAt = now;
                    const ember = this.add.graphics();
                    ember.setBlendMode(Phaser.BlendModes.ADD);
                    ember.fillStyle(0xffa14a, 0.8);
                    ember.fillCircle(0, 0, 2.2);
                    ember.setPosition(pod.x, pod.y + 4);
                    ember.setDepth(4998);
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

                // 1 — the white-hot flash.
                const flash = this.add.graphics();
                flash.setBlendMode(Phaser.BlendModes.ADD);
                flash.fillStyle(0xfff6d8, 0.95);
                flash.fillEllipse(0, 0, 26, 13);
                flash.setPosition(end.x, end.y);
                flash.setDepth(5003);
                this.tweens.add({ targets: flash, alpha: 0, scale: 2.3, duration: 110, onComplete: () => flash.destroy() });

                // 2 — the bloom: three stacked fire tongues, hottest inside.
                const bloomSpec: Array<[number, number, number]> = [
                    [0xd8481e, 46, 420],
                    [0xffb545, 34, 330],
                    [0xfff3c4, 22, 240]
                ];
                bloomSpec.forEach(([color, size, dur], i) => {
                    const bloom = this.add.graphics();
                    bloom.fillStyle(color, 0.88);
                    bloom.fillEllipse(0, 0, size, size * 0.5);
                    bloom.setPosition(end.x, end.y);
                    bloom.setDepth(5001 + i);
                    bloom.setScale(0.35);
                    this.tweens.add({
                        targets: bloom,
                        alpha: 0,
                        scale: 1.75,
                        duration: dur,
                        ease: 'Cubic.easeOut',
                        onComplete: () => bloom.destroy()
                    });
                });

                // 3 — the shockwave: one iso ring racing outward along the ground.
                const ring = this.add.graphics();
                ring.lineStyle(2.4, 0xffd9a0, 0.85);
                ring.strokeEllipse(0, 0, 18, 9);
                ring.setPosition(end.x, end.y);
                ring.setDepth(5000);
                this.tweens.add({
                    targets: ring,
                    alpha: 0,
                    scaleX: 5.2,
                    scaleY: 5.2,
                    duration: 380,
                    ease: 'Cubic.easeOut',
                    onComplete: () => ring.destroy()
                });

                // 4 — embers thrown out, arcing and dying.
                for (let i = 0; i < 10; i++) {
                    const ember = this.add.graphics();
                    ember.setBlendMode(Phaser.BlendModes.ADD);
                    ember.fillStyle(i % 2 === 0 ? 0xffc35a : 0xff7a22, 0.95);
                    ember.fillCircle(0, 0, 1.6 + Math.random() * 1.4);
                    ember.setPosition(end.x, end.y - 4);
                    ember.setDepth(5002);
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
                        const smoke = this.add.graphics();
                        smoke.fillStyle(0x4a4038, 0.4);
                        smoke.fillCircle(0, 0, 5 + i * 2);
                        smoke.setPosition(end.x + (Math.random() - 0.5) * 10, end.y - 6);
                        smoke.setDepth(5004);
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
                const scorch = this.add.graphics();
                scorch.fillStyle(0x2b241c, 0.38);
                scorch.fillEllipse(0, 0, 24, 11);
                scorch.fillStyle(0x1c1712, 0.3);
                scorch.fillEllipse(2, 1, 12, 5.5);
                scorch.setPosition(end.x, end.y + 1);
                scorch.setDepth(6);
                this.tweens.add({ targets: scorch, alpha: 0, duration: 3800, ease: 'Quad.easeIn', onComplete: () => scorch.destroy() });

                this.troops.slice().forEach(t => {
                    if (t.owner !== db.owner && t.health > 0) {
                        const d = Phaser.Math.Distance.Between(t.gridX, t.gridY, targetGridX, targetGridY);
                        if (d < 1.2) {
                            t.health -= damage;
                            t.hasTakenDamage = true;
                            this.updateHealthBar(t);
                            if (t.health <= 0) this.destroyTroop(t);
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

        // SPIKY projectile - level-dependent appearance
        const bag = this.add.graphics();
        const spikeScale = level >= 4 ? 1.3 : (level >= 3 ? 1.2 : 1.0);
        let coreColor: number, spikeColor: number, highlightColor: number;
        if (level >= 4) {
            // White marble boulder with gold spikes
            coreColor = 0xeeeedd;
            spikeColor = 0xdaa520;
            highlightColor = 0xffd700;
        } else if (level >= 3) {
            // Dark iron with red-hot tips
            coreColor = 0x333333;
            spikeColor = 0x888888;
            highlightColor = 0xcc3300;
        } else {
            // Basic grey
            coreColor = 0x555555;
            spikeColor = 0xaaaaaa;
            highlightColor = 0xcccccc;
        }
        // Core/base
        bag.fillStyle(coreColor, 1);
        bag.fillCircle(0, 0, 6 * spikeScale);
        // Spikes
        bag.fillStyle(spikeColor, 1);
        const s = spikeScale;
        // Top spikes
        bag.fillTriangle(0, -6 * s, -3 * s, -14 * s, 3 * s, -14 * s);
        bag.fillTriangle(-4 * s, -5 * s, -8 * s, -12 * s, -2 * s, -10 * s);
        bag.fillTriangle(4 * s, -5 * s, 8 * s, -12 * s, 2 * s, -10 * s);
        // Bottom spikes
        bag.fillTriangle(0, 6 * s, -3 * s, 14 * s, 3 * s, 14 * s);
        bag.fillTriangle(-4 * s, 5 * s, -8 * s, 12 * s, -2 * s, 10 * s);
        bag.fillTriangle(4 * s, 5 * s, 8 * s, 12 * s, 2 * s, 10 * s);
        // Side spikes
        bag.fillTriangle(-6 * s, 0, -14 * s, -3 * s, -14 * s, 3 * s);
        bag.fillTriangle(6 * s, 0, 14 * s, -3 * s, 14 * s, 3 * s);
        bag.fillTriangle(-5 * s, -4 * s, -12 * s, -8 * s, -10 * s, -2 * s);
        bag.fillTriangle(5 * s, -4 * s, 12 * s, -8 * s, 10 * s, -2 * s);
        bag.fillTriangle(-5 * s, 4 * s, -12 * s, 8 * s, -10 * s, 2 * s);
        bag.fillTriangle(5 * s, 4 * s, 12 * s, 8 * s, 10 * s, 2 * s);
        // Spike highlights / tips
        bag.fillStyle(highlightColor, 0.8);
        bag.fillTriangle(0, -7 * s, -1 * s, -12 * s, 1 * s, -12 * s);
        bag.fillTriangle(-6 * s, -1 * s, -12 * s, 0, -12 * s, 2 * s);
        bag.fillTriangle(6 * s, -1 * s, 12 * s, 0, 12 * s, 2 * s);

        bag.setPosition(start.x, start.y - 40);
        bag.setDepth(5000);
        bag.setAlpha(0);

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
        const bagShadow = this.add.graphics();
        bagShadow.fillStyle(0x18220f, 0.26);
        bagShadow.fillEllipse(0, 0, 16, 7);
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
                // Scale
                const scale = 0.7 + (1 - Math.abs(t - 0.5) * 2) * 0.4;
                bag.setScale(scale);

                // Drop spike trail every ~80ms
                const now = this.time.now;
                if (now - lastTrailTime > 80 && t > 0.1 && t < 0.9) {
                    lastTrailTime = now;
                    const trailSpike = this.add.graphics();
                    trailSpike.fillStyle(0x888888, 0.7);
                    // Small falling spike
                    trailSpike.fillTriangle(0, -4, -2, 4, 2, 4);
                    trailSpike.setPosition(bag.x + (Math.random() - 0.5) * 10, bag.y);
                    trailSpike.setDepth(4999);
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
        this.createSmokeEffect(start.x, start.y - 35);
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

        // 1 — dull metal-on-earth flash (no fire: this is weight, not heat).
        const slamFlash = this.add.graphics();
        slamFlash.fillStyle(0xd8b878, 0.7);
        slamFlash.fillEllipse(0, 0, 20, 10);
        slamFlash.setPosition(x, y);
        slamFlash.setDepth(5002);
        this.tweens.add({ targets: slamFlash, alpha: 0, scale: 1.9, duration: 130, onComplete: () => slamFlash.destroy() });

        // 2 — the dust shock: one iso ring of thrown earth racing outward.
        const dustRing = this.add.graphics();
        dustRing.lineStyle(3, 0xc9b593, 0.8);
        dustRing.strokeEllipse(0, 0, 16, 8);
        dustRing.setPosition(x, y + 1);
        dustRing.setDepth(5000);
        this.tweens.add({
            targets: dustRing,
            alpha: 0,
            scaleX: 4.4,
            scaleY: 4.4,
            duration: 340,
            ease: 'Cubic.easeOut',
            onComplete: () => dustRing.destroy()
        });

        // 3 — the ground CRACKS under the blow: jagged lines that fade.
        const cracks = this.add.graphics();
        cracks.setPosition(x, y);
        cracks.setDepth(7);
        cracks.lineStyle(1.6, 0x3a3020, 0.85);
        for (let c = 0; c < 5; c++) {
            const baseAngle = (c / 5) * Math.PI * 2 + 0.35;
            let cx = 0;
            let cy = 0;
            cracks.beginPath();
            cracks.moveTo(0, 0);
            for (let seg = 0; seg < 3; seg++) {
                const jag = baseAngle + (Math.random() - 0.5) * 0.7;
                const len = 7 + Math.random() * 9;
                cx += Math.cos(jag) * len;
                cy += Math.sin(jag) * len * 0.5;
                cracks.lineTo(cx, cy);
            }
            cracks.strokePath();
        }
        this.tweens.add({ targets: cracks, alpha: 0, duration: 950, ease: 'Quad.easeIn', onComplete: () => cracks.destroy() });

        // 4 — the ball's quills BURST outward and land as the zone's caltrops:
        // the ejecta visually becomes the hazard the launcher leaves behind.
        const quillCount = 9;
        for (let q = 0; q < quillCount; q++) {
            const quill = this.add.graphics();
            quill.fillStyle(0x777777, 1);
            quill.fillTriangle(0, -5, -2.2, 3, 2.2, 3);
            quill.fillStyle(0xaaaaaa, 0.9);
            quill.fillTriangle(0, -5, -0.9, -1, 0.9, -1);
            quill.setPosition(x, y - 6);
            quill.setDepth(5001);
            const qa = (q / quillCount) * Math.PI * 2 + 0.2;
            const qd = 12 + Math.random() * (radius * 14);
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
            const clod = this.add.graphics();
            clod.fillStyle(d % 2 === 0 ? 0x8a744e : 0x6e5c3e, 0.95);
            clod.fillEllipse(0, 0, 3.4, 2.2);
            clod.setPosition(x, y - 3);
            clod.setDepth(5001);
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
                if (dist <= radius + 0.5) { // Slightly larger radius for impact
                    t.health -= impactDamage;
                    t.hasTakenDamage = true;
                    this.updateHealthBar(t);

                    // Impact flash
                    const pos = IsoUtils.cartToIso(t.gridX, t.gridY);
                    const flash = this.add.circle(pos.x, pos.y - 15, 8, 0xffaa00, 0.8);
                    flash.setDepth(t.gameObject.depth + 1);
                    this.tweens.add({
                        targets: flash,
                        scale: 2,
                        alpha: 0,
                        duration: 200,
                        onComplete: () => flash.destroy()
                    });

                    if (t.health <= 0) {
                        this.destroyTroop(t);
                    }
                }
            }
        });

        // Create persistent spike zone graphics
        const zoneGraphics = this.add.graphics();
        zoneGraphics.setDepth(2);

        // Draw scattered spikes on ground
        const drawSpikes = (alpha: number) => {
            zoneGraphics.clear();
            const footprintScale = Math.max(0.85, radius / 2);

            // Dark ground patch
            zoneGraphics.fillStyle(0x3a3020, alpha * 0.5);
            zoneGraphics.fillEllipse(x, y + 3, 55 * footprintScale, 28 * footprintScale);

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

                // Metal spikes (4-pointed caltrops)
                zoneGraphics.fillStyle(0x666666, alpha);
                // Upward spike
                zoneGraphics.fillTriangle(sx, sy - 6, sx - 2, sy, sx + 2, sy);
                // Side spikes
                zoneGraphics.fillTriangle(sx - 5, sy + 2, sx, sy, sx, sy + 3);
                zoneGraphics.fillTriangle(sx + 5, sy + 2, sx, sy, sx, sy + 3);
                // Highlight
                if (i % 3 === 0) {
                    zoneGraphics.fillStyle(0x999999, alpha * 0.7);
                    zoneGraphics.fillTriangle(sx - 1, sy - 5, sx, sy - 2, sx + 1, sy - 5);
                }
            });
        };

        drawSpikes(1);

        const zone = {
            x, y, gridX, gridY,
            radius,
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
                            t.health -= zone.damage;
                            t.hasTakenDamage = true;
                            this.updateHealthBar(t);

                            // Small blood/damage effect
                            const pos = IsoUtils.cartToIso(t.gridX, t.gridY);
                            const spark = this.add.circle(pos.x, pos.y - 10, 3, 0xff4444, 0.8);
                            spark.setDepth(t.gameObject.depth + 1);
                            this.tweens.add({
                                targets: spark,
                                y: pos.y - 20,
                                alpha: 0,
                                scale: 0.5,
                                duration: 200,
                                onComplete: () => spark.destroy()
                            });

                            if (t.health <= 0) {
                                this.destroyTroop(t);
                            }
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
