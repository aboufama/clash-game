import Phaser from 'phaser';
import {
    BUILDING_DEFINITIONS,
    OBSTACLE_DEFINITIONS,
    PLAYER_TROOP_TYPES,
    type BuildingType,
    type TroopType
} from '../config/GameDefinitions';
import { merchantOffersFor, worldDayIndex, type MerchantOffer } from '../config/Economy';
import { DayNightSystem } from './DayNightSystem';
import type { PlacedBuilding, PlacedObstacle } from '../types/GameTypes';
import { IsoUtils } from '../utils/IsoUtils';
import { depthForBuilding, depthForTroop } from './DepthSystem';
import { windAt } from './Wind';
import { PathfindingSystem } from './PathfindingSystem';
import { drawStoneLane } from '../renderers/StonePathRenderer';
import { Backend } from '../backend/GameBackend';
import { TroopRenderer } from '../renderers/TroopRenderer';
import { gameManager } from '../GameManager';
import { soundSystem } from './SoundSystem';
import { ObstacleRenderer } from '../renderers/ObstacleRenderer';
import { SpriteBank } from '../render/SpriteBank';
import { applyPixelSnap } from '../render/PixelSnap';

/**
 * Ambient village life: villagers, dogs and chickens that wander the base
 * using real pathfinding around buildings, plus army figures that march from
 * the barracks to the army camps and idle there (Clash-of-Clans style).
 *
 * When a raid begins (`panic()`), everyone drops what they're doing and rushes
 * into the town hall.
 *
 * Perf model matches the rest of the scene: entities are a handful of small
 * Graphics; moving entities redraw per frame, idle ones on a 3-frame stagger,
 * off-screen ones not at all, and camp figures standing still draw exactly once.
 */

interface LifeHost extends Phaser.Scene {
    buildings: PlacedBuilding[];
    obstacles: PlacedObstacle[];
    mode: string;
    mapSize: number;
    battleInPlace?: boolean;
    removeObstacle(obstacleId: string): boolean;
    dayNight: {
        nightFactor(): number;
        setFestivalGlow(spot: { x: number; y: number } | null): void;
        addTransientLight(opts: { gx: number; gy: number; radius?: number; tint?: number; until: number }): number;
        removeTransientLight(id: number): void;
    };
}

type LifeKind = 'villager' | 'dog' | 'chicken' | 'bird';
const DRAGON_SCALE = 3.4;

type LifeState = 'idle' | 'walk' | 'panic' | 'inside' | 'gone';
/**
 * Villager professions: workers seek out their workplace and play a work loop
 * there. Builders maintain the defenses; farmers tend the greenery. ('miner'
 * is reserved for a future economy role.)
 */
export type LifeRole = 'peasant' | 'builder' | 'miner' | 'farmer';
const FARMABLE = new Set<string>(['grass_patch', 'tree_oak', 'tree_pine']);

interface LifeEntity {
    id: number;
    kind: LifeKind;
    gfx: Phaser.GameObjects.Graphics;
    x: number;
    y: number;
    path: Phaser.Math.Vector2[] | null;
    state: LifeState;
    stateUntil: number;
    speed: number;
    baseSpeed: number;
    facing: 1 | -1;
    animOffset: number;
    palette: number;
    style: number;
    homeX: number;
    homeY: number;
    panicAt: number;
    /** Door building this entity is fleeing into during a panic. */
    panicRefugeId?: string;
    /** No reachable shelter: crouch in place instead of disappearing. */
    cowering?: boolean;
    lastDepth?: number;
    stagger: number;
    /** Cute hover/click reactions: pose until, and per-entity cooldown. */
    reactUntil: number;
    reactCooldownUntil: number;
    /** Mid-chinwag with this entity id (both stand and trade bubbles). */
    chattingWith?: number;
    chatCooldownUntil?: number;
    /** Festival night: dancing at the jukebox instead of going to bed. */
    dancing?: boolean;
    role: LifeRole;
    /** Grey hair, beard, cane, unhurried pace. */
    elder?: boolean;
    /** Born of population growth: small, quick, never works. Grows up. */
    child?: boolean;
    matureAt?: number;
    /** Night: this one carries the lantern and keeps watch while others sleep. */
    lantern?: boolean;
    /** Asleep (indoors or, if shelterless, standing right where they are). */
    sleeping?: boolean;
    /** Inside a building (through its door): hidden until this time. */
    insideId?: string;
    hiddenUntil?: number;
    /** Set while walking toward a door with intent to enter. */
    pendingEnterId?: string;
    /** Work loop at a workplace building. */
    workUntil?: number;
    workBuildingId?: string;
    /** Grid point to face while working (building center or tended obstacle). */
    workFaceAt?: { x: number; y: number };
    lastWorkFxAt?: number;
    /** Construction site this villager was summoned to build. */
    buildSiteId?: string;
    /** Night-watch patrol progress (index into the perimeter route). */
    patrolIx?: number;
    /** Wall tile currently being crossed (subtle bounce over it). */
    hopTile?: { x: number; y: number };
    /** Chickens: when the next egg arrives. */
    nextEggAt?: number;
    /** Rock-hauling chore: which obstacle, and which leg of the trip. */
    haulObstacleId?: string;
    haulStage?: 'toRock' | 'toStorage' | 'deliver' | 'toShroom';
    carryingRock?: 'small' | 'large';
    /** Produce sack on the back: a delivery run from mine/farm to the storehouse. */
    carryingPack?: 'ore' | 'food';
    haulDepotId?: string;
    /** Mushroom patch this villager is off to pick. */
    forageObstacleId?: string;
    /** Food granted when this pack reaches the depot (mine/farm runs stay visual-only). */
    packAmount?: number;
    sitting?: boolean;
    pecking?: boolean;
    followId?: number;
    // Birds fly in a straight line and ignore everything.
    birdVX?: number;
    birdVY?: number;
    /** 0 dove, 1 sparrow, 2 heron, 3 the dragon's shadow. */
    birdType?: number;
}

type CampState = 'march' | 'idle' | 'shift' | 'dismiss';

interface CampFigure {
    id: number;
    type: TroopType;
    gfx: Phaser.GameObjects.Graphics;
    x: number;
    y: number;
    path: Phaser.Math.Vector2[] | null;
    state: CampState;
    campId: string;
    facing: 1 | -1;
    speed: number;
    stagger: number;
    lastDepth?: number;
    idleUntil: number;
    needsIdleDraw: boolean;
    marchThroughId?: string;
    hopTile?: { x: number; y: number };
}

export const VILLAGER_PALETTES = [
    { tunic: 0x8d6e4a, dark: 0x6b5138, hair: 0x3b2a1a, skin: 0xdeb887 },
    { tunic: 0x5f7a4a, dark: 0x475e36, hair: 0x1f1a14, skin: 0xd8a878 },
    { tunic: 0x7a5a7a, dark: 0x5c4260, hair: 0x6b4a2a, skin: 0xe6c298 },
    { tunic: 0x4a6a7a, dark: 0x37505e, hair: 0x8a7550, skin: 0xdeb887 },
    { tunic: 0xa07444, dark: 0x7c5832, hair: 0x2a2a2a, skin: 0xcfa06a }
];

export const DOG_PALETTES = [
    { fur: 0x9a7648, dark: 0x74572f },
    { fur: 0x6e6e6e, dark: 0x4f4f4f },
    { fur: 0xc9a86a, dark: 0x9d8046 }
];

// Every trainable troop can appear at camp; the catalog is the one source of
// truth so a newly added troop cannot train correctly but vanish from home.
const CAMP_RENDERABLE = new Set<string>(PLAYER_TROOP_TYPES);

const MAX_CAMP_FIGURES = 18;
const ARMY_SYNC_MS = 1200;
/** Buildings with an actual drawn door villagers can go in and out of. */
const ENTERABLE = new Set<string>(['town_hall', 'barracks', 'lab', 'storage']);
const DOOR_PULSE_MS = 1150;

function isDefense(type: string): boolean {
    return BUILDING_DEFINITIONS[type as BuildingType]?.category === 'defense';
}

/** Add a track to the songbook with a fanfare (only fires the first time). */
function unlockTrack(id: string, name: string) {
    if (soundSystem.unlockTrack(id)) {
        soundSystem.play('eggCollect');
        gameManager.showToast(`Track unlocked: ${name}`);
    }
}

/** FNV-1a — deterministic villager identities from (village id, index). */
function hashString(s: string): number {
    let h = 2166136261;
    for (let i = 0; i < s.length; i++) {
        h ^= s.charCodeAt(i);
        h = Math.imul(h, 16777619);
    }
    return h >>> 0;
}

// The offer shape (and the deterministic generator) lives in shared Economy
// code so the server prices exactly what this system displays.
export type { MerchantOffer } from '../config/Economy';

interface MerchantState {
    gfx: Phaser.GameObjects.Graphics;
    stallGfx: Phaser.GameObjects.Graphics;
    x: number;
    y: number;
    path: Phaser.Math.Vector2[] | null;
    state: 'arriving' | 'building' | 'trading' | 'leaving';
    leaveAt: number;
    offers: MerchantOffer[];
    facing: 1 | -1;
    speed: number;
    hopTile?: { x: number; y: number };
    stallDrawn: boolean;
    /** When the stall raising finishes (state 'building' only). */
    buildUntil?: number;
    /** Next mallet knock, so the hammering keeps a beat. */
    nextKnockAt?: number;
}

/** How long the merchant spends raising his stall before opening shop. */
const STALL_BUILD_MS = 5200;

export class VillageLifeSystem {
    private readonly scene: LifeHost;
    private entities: LifeEntity[] = [];
    private campFigures: CampFigure[] = [];
    private nextId = 1;
    private panicking = false;
    private nightMode = false;
    private rainMode = false;
    /** Scaffolded builds/upgrades currently being 'worked on' (visual only). */
    private constructionSites: Array<{ id: string; buildingId: string; until: number; duration: number; stage: number; gfx: Phaser.GameObjects.Graphics; builderAssigned: boolean }> = [];
    /** Post-raid damage at home: smoke + rubble until the repair crew gets there. */
    private scars: Array<{ buildingId: string; gfx: Phaser.GameObjects.Graphics; repairAt: number; repairing: boolean; seed: number; rendered: boolean }> = [];
    /** Night events: the owl, the midnight forge, wolves at the treeline. */
    private nextOwlAt = 0;
    private owl: { x: number; y: number; dirX: number; dirY: number; gfx: Phaser.GameObjects.Graphics; bornAt: number; hooted: boolean } | null = null;
    private nextForgeAt = 0;
    private forge: { buildingId: string; until: number; lightId: number; nextClinkAt: number } | null = null;
    private nextWolvesAt = 0;
    private wolves: { x: number; y: number; until: number; gfx: Phaser.GameObjects.Graphics; howled: boolean } | null = null;
    /** The night watch walks a real beat around the village. */
    private patrolRoute: Array<{ x: number; y: number }> | null = null;
    private populatedFor: 'PLAYER' | 'ENEMY' | null = null;
    private showCampFigures = false;
    private nextArmySyncAt = 0;
    /** False until the first army sync after populate — the standing army appears already stationed. */
    private armySynced = false;
    private nextBirdAt = 0;
    /** Rare easter egg: a dragon's shadow sweeps over the village. */
    private nextDragonAt = 0;
    /** Villagers wander off to pick mushrooms on their own now and then. */
    private nextForageAt = 0;
    /** The traveling merchant: rolls in, trades a while, moves on. */
    private merchant: MerchantState | null = null;
    private nextMerchantAt = 0;
    /** True while the current panic was caused by the dragon overhead. */
    private dragonScare = false;

    // ---- stone paths: the village paves its important routes over time ----
    private stoneGfx: Phaser.GameObjects.Graphics | null = null;
    /** Each lane ages on its own: untouched lanes keep their stones exactly
     *  as laid, while a re-routed lane grows back in at its crew's own pace —
     *  and its abandoned course lingers as `retiring`, pulled up stone by
     *  stone. `anchor` records the endpoints the lane was built for. */
    private stoneRoutes: Array<{
        key: string;
        anchor: string;
        points: Phaser.Math.Vector2[];
        laidSeconds: number;
        fillSeconds: number;
        retiring?: { points: Phaser.Math.Vector2[]; maturityAtRetire: number; ageSeconds: number };
    }> = [];
    private stoneLayoutHash = '';
    /** 0..1 — the village age's paving budget (no lane out-paves the village). */
    private stoneMaturity = 0;
    private stoneMaturitySeconds = 0;
    private lastStoneTickAt = 0;
    private nextStoneUpdateAt = 0;
    private nextStoneSaveAt = 0;
    /** Per-route maturity bands at the last draw — redraw only when a stone lands. */
    private stoneBandSignature = '';
    /** Lane ages survive a same-village repopulate (world syncs repopulate
     *  constantly — a mid-transition wipe would snap lanes to done). */
    private stoneStash: { identity: string; routes: VillageLifeSystem['stoneRoutes'] } | null = null;

    // ---- Night stories: festival at the jukebox, a thief in the dark ----
    private festivalGfx: Phaser.GameObjects.Graphics | null = null;
    private festivalOn = false;
    private thief: { gfx: Phaser.GameObjects.Graphics; x: number; y: number; path: Phaser.Math.Vector2[] | null; speed: number; facing: 1 | -1; state: 'sneak' | 'flee'; sack: boolean; animOffset: number } | null = null;
    private nextThiefAt = 0;
    private nextChatScanAt = 0;
    private nextBrowseAt = 0;
    /** Dawn chore: the elder scatters feed and the chickens come running. */
    private feedPlan: { at: number; elderId?: number; spot?: { x: number; y: number }; stage: 'wait' | 'walking' | 'scattering' } | null = null;
    private feedSpot: { x: number; y: number; until: number; gfx: Phaser.GameObjects.Graphics } | null = null;
    private nextFeedNudgeAt = 0;

    // ---- Cloud shade: soft blobs sailing on the prevailing wind ----
    private staggerFrame = 0;
    private calmTimer: Phaser.Time.TimerEvent | null = null;

    constructor(scene: LifeHost) {
        this.scene = scene;
    }

    // ---------------------------------------------------------------- public

    /** Remember the server's population so re-populates (e.g. after a raid) keep the right head-count. */
    private populationCount: number | null = null;

    /** Stable per-village key so villager #N is the same person every session. */
    private identityKey = 'village';

    /** Spawn ambient life for the currently instantiated base. */
    populate(owner: 'PLAYER' | 'ENEMY', options: { fromHall?: boolean; population?: number; identity?: string; bornAt?: number[] } = {}) {
        const rememberedPopulation = this.populationCount; // clear() resets it
        const rememberedIdentity = this.identityKey;
        const rememberedNight = this.nightMode;
        const rememberedRain = this.rainMode;
        this.clear();
        this.populationCount = rememberedPopulation;
        this.identityKey = options.identity ?? rememberedIdentity;
        this.populatedFor = owner;
        this.loadStoneMaturity();
        this.stoneLayoutHash = '';
        this.stoneBandSignature = '';
        this.lastStoneTickAt = 0;
        this.nextStoneUpdateAt = 0;
        this.nextStoneSaveAt = this.scene.time.now + 30_000;
        // Same village again (world syncs repopulate constantly): the lanes
        // pick up exactly where they were, mid-transition and all. The next
        // stone tick re-validates every course against the fresh layout.
        if (owner === 'PLAYER' && this.stoneStash?.identity === this.identityKey) {
            this.stoneRoutes = this.stoneStash.routes;
        }
        this.stoneStash = null;
        this.showCampFigures = owner === 'PLAYER';
        const now = this.scene.time.now;
        this.nextArmySyncAt = now + 500;
        this.armySynced = false;
        this.nextBirdAt = now + 4000 + Math.random() * 8000;
        this.nextForageAt = now + 20_000 + Math.random() * 25_000;
        this.nextMerchantAt = now + 100_000 + Math.random() * 120_000;
        // Somewhere between 6 and 14 minutes from now, if you're lucky...
        this.nextDragonAt = now + 360_000 + Math.random() * 480_000;

        const structures = this.scene.buildings.filter(b => b.type !== 'wall' && b.health > 0);
        if (structures.length === 0) return;

        const hall = structures.find(b => b.type === 'town_hall');
        const anchor = hall ?? structures[0];
        const anchorDoor = this.doorOf(anchor);

        // The server-authoritative population drives the exact visible head
        // count. Thirty is the simulation's hard domain maximum, so this stays
        // bounded without hiding real residents behind a visual-only cap.
        if (typeof options.population === 'number') this.populationCount = options.population;
        const villagerCount = this.populationCount !== null
            ? Phaser.Math.Clamp(Math.floor(this.populationCount), 0, 30)
            : Phaser.Math.Clamp(2 + Math.floor(structures.length / 4), 2, 7);
        const dogCount = structures.length >= 10 ? 2 : 1;
        const chickenCount = 2 + Math.floor(Math.random() * 3);

        // One builder if there's anything to maintain, one farmer if there's
        // anything to tend — the rest are regular peasants.
        const roles: LifeRole[] = [];
        if (structures.some(b => isDefense(b.type))) roles.push('builder');
        if (structures.some(b => b.type === 'mine')) roles.push('miner');
        if (structures.some(b => b.type === 'farm') || this.scene.obstacles.some(o => FARMABLE.has(o.type))) roles.push('farmer');
        while (roles.length < villagerCount) roles.push('peasant');

        const spawned: LifeEntity[] = [];
        for (let i = 0; i < villagerCount; i++) {
            const spot = options.fromHall
                ? anchorDoor
                : this.openTileNear(structures[Math.floor(Math.random() * structures.length)]) ?? anchorDoor;
            if (!spot) continue;
            const e = this.spawnEntity('villager', spot.x, spot.y);
            spawned.push(e);
            // Villager #i is one PERSON: everything about their look derives from
            // a stable per-village seed, so the same individual greets you every
            // session — and attackers scouting your base see the same faces.
            const seed = hashString(`${this.identityKey}:${i}`);
            e.role = roles[i] ?? 'peasant';
            e.palette = seed % VILLAGER_PALETTES.length;
            e.elder = e.role === 'peasant' && ((seed >> 4) % 5 === 0); // ~1 in 5 peasants
            e.style = e.role === 'peasant' && !e.elder && ((seed >> 8) % 5 < 2) ? 1 : 0;
            e.animOffset = (seed >> 12) % 10000;
            if (e.elder) {
                e.baseSpeed *= 0.55; // grandpa pace
                e.speed = e.baseSpeed;
            }
            // Walking out of the hall after an attack: stream out one by one.
            e.stateUntil = now + (options.fromHall ? 300 + i * 450 : Math.random() * 2500);
        }
        // The youngest villagers are CHILDREN until they come of age — real
        // days, across sessions, from the server's birth records. They take
        // the tail slots (plain peasants), never the last working adult.
        const AGE_MS = 2 * 86_400_000;
        const youngBirths = (options.bornAt ?? [])
            .filter(b => Date.now() - b < AGE_MS)
            .sort((a, b) => b - a);
        const childCount = Math.min(youngBirths.length, Math.max(0, spawned.length - 1));
        for (let k = 0; k < childCount; k++) {
            const e = spawned[spawned.length - 1 - k];
            const bornWall = youngBirths[k];
            e.child = true;
            e.elder = false;
            // Wall-clock maturity mapped into scene time (scene clocks start at 0).
            e.matureAt = now + Math.max(0, bornWall + AGE_MS - Date.now());
            e.baseSpeed *= 1.35;
            e.speed = e.baseSpeed;
        }
        if (options.fromHall && hall) {
            // Hold the hall door open while everyone files back out.
            hall.doorOpenUntil = now + 300 + villagerCount * 450 + 400;
        }
        for (let i = 0; i < dogCount; i++) {
            const spot = this.openTileNear(anchor, 4) ?? anchorDoor;
            if (!spot) continue;
            const e = this.spawnEntity('dog', spot.x, spot.y);
            // The village dog is also one particular dog.
            e.palette = hashString(`${this.identityKey}:dog:${i}`) % DOG_PALETTES.length;
            e.stateUntil = now + Math.random() * 2000;
        }

        // Chickens cluster around one "coop" spot near a resource building.
        const coopHost = anchor;
        const coop = this.openTileNear(coopHost, 3) ?? anchorDoor;
        if (coop) {
            for (let i = 0; i < chickenCount; i++) {
                const e = this.spawnEntity('chicken', coop.x + (Math.random() - 0.5), coop.y + (Math.random() - 0.5));
                e.homeX = coop.x;
                e.homeY = coop.y;
                e.stateUntil = now + Math.random() * 1200;
                // Baseline food: hens lay collectible eggs now and then.
                e.nextEggAt = now + 25_000 + Math.random() * 60_000;
            }
        }

        // Reapply climate only after every villager and animal exists. The old
        // ordering put villagers to bed before dogs/chickens were spawned and
        // never reapplied an already-active rain state at all.
        if (rememberedNight) this.setNightMode(true);
        if (rememberedRain) this.setRain(true);
    }

    /**
     * The server's population moved. Births toddle out of the town hall as
     * children (they grow up on their own); a shrinking count sends the
     * youngest back inside first.
     */
    syncPopulation(count: number) {
        if (this.populatedFor !== 'PLAYER') return;
        count = Phaser.Math.Clamp(Math.floor(Number(count) || 0), 0, 30);
        const current = this.populationCount ?? this.entities.filter(e => e.kind === 'villager').length;
        if (count === current) return;
        const now = this.scene.time.now;

        if (count > current) {
            const hall = this.scene.buildings.find(b => b.type === 'town_hall' && b.health > 0);
            const door = hall ? this.doorOf(hall) : null;
            const births = count - current;
            for (let i = 0; i < births; i++) {
                const spot = door ?? this.openTileAt(12, 14) ?? { x: 12, y: 14 };
                const e = this.spawnEntity('villager', spot.x + 0.5, spot.y + 0.5);
                const seed = hashString(`${this.identityKey}:child:${count - births + i}`);
                e.child = true;
                // Two real days of childhood (the server's birth record keeps
                // this consistent across sessions; see populate()).
                e.matureAt = now + 2 * 86_400_000 + (seed % 60_000);
                e.palette = seed % VILLAGER_PALETTES.length;
                e.baseSpeed *= 1.35; // kids scamper
                e.speed = e.baseSpeed;
                e.animOffset = (seed >> 8) % 10000;
                e.stateUntil = now + 400 + i * 600;
                if (hall) hall.doorOpenUntil = now + DOOR_PULSE_MS;
            }
            soundSystem.play('eggCollect');
            gameManager.showToast('A new villager was born!');
        } else {
            // Housing shrank: children first, then the newest adults.
            let toRemove = current - count;
            const removable = [...this.entities]
                .filter(e => e.kind === 'villager' && e.state !== 'gone')
                .sort((a, b) => Number(Boolean(b.child)) - Number(Boolean(a.child)));
            for (const e of removable) {
                if (toRemove <= 0) break;
                e.gfx.destroy();
                e.state = 'gone';
                toRemove--;
            }
            this.entities = this.entities.filter(e => e.state !== 'gone');
        }
        this.populationCount = count;
    }

    /**
     * Everyone sprints for shelter — the town hall door first, any other door
     * building second. Nobody ever evaporates: an entity with no reachable
     * door cowers in place until the danger passes. Idempotent.
     */
    panic() {
        if (this.panicking) return;
        if (this.entities.length === 0) return;
        this.panicking = true;
        this.endFestival();
        if (this.thief) this.scareThief(false);
        soundSystem.play('horn');
        const now = this.scene.time.now;
        for (const e of this.entities) {
            if (e.state === 'gone' || e.kind === 'bird') continue;
            if (e.state === 'inside') continue; // already safe indoors
            this.interruptChore(e);
            e.workUntil = undefined;
            e.workBuildingId = undefined;
            e.workFaceAt = undefined;
            e.pendingEnterId = undefined;
            e.cowering = false;
            e.state = 'panic';
            e.path = null;
            e.panicRefugeId = undefined;
            // Staggered reactions + a startled hop read far more naturally than lockstep.
            e.panicAt = now + Math.random() * 650;
            e.speed = e.baseSpeed * (e.kind === 'dog' ? 1.7 : 2.3);
            this.scene.tweens.add({ targets: e.gfx, y: e.gfx.y - 6, duration: 90, yoyo: true, ease: 'Quad.easeOut' });
        }
    }

    /**
     * The threat has passed: whoever hid indoors files back out through the
     * doors they entered; anyone caught cowering outside shakes it off.
     */
    calm() {
        if (!this.panicking) return;
        this.panicking = false;
        this.calmTimer?.remove();
        this.calmTimer = this.scene.time.delayedCall(1500, () => {
            this.calmTimer = null;
            if (this.scene.mode !== 'HOME' || this.populatedFor !== 'PLAYER') return;
            const now = this.scene.time.now;
            let exitSlot = 0;
            for (const e of this.entities) {
                if (e.state === 'inside') {
                    // Stagger the walk-outs so the village refills naturally.
                    e.hiddenUntil = now + 400 + exitSlot * 480 + Math.random() * 250;
                    exitSlot++;
                } else if (e.state === 'panic') {
                    e.cowering = false;
                    e.state = 'idle';
                    e.path = null;
                    e.speed = e.baseSpeed;
                    e.stateUntil = now + 500 + Math.random() * 2000;
                    this.resumeCarriedChore(e, now);
                }
            }
            // Nothing survived (fresh scene, cleared entities): start over from the hall.
            if (this.entities.length === 0) {
                this.populate('PLAYER', { fromHall: true });
            }
        });
    }


    /**
     * Nightfall/daybreak. At night the village turns in: villagers head indoors
     * to sleep (one — an elder when there is one — stays out with a lantern as
     * the night watch), dogs curl up, chickens roost where they stand. At dawn
     * everyone files back out of the doors.
     */
    setNightMode(night: boolean) {
        // MainScene historically gates the argument on HOME. A seamless raid
        // deliberately keeps the shared sky, so derive the effective state
        // from that same clock while the enemy plot occupies the local grid.
        if (this.scene.battleInPlace) night = this.scene.dayNight.nightFactor() > 0.6;
        if (night === this.nightMode) return;
        this.nightMode = night;
        if (this.populatedFor === null) return;
        const now = this.scene.time.now;

        if (night) {
            const upAndAbout = this.entities.filter(e =>
                e.kind === 'villager' && !e.child && e.state !== 'inside' && e.state !== 'gone' && e.state !== 'panic');
            const availableForNightRole = upAndAbout.filter(e => !this.hasActiveChore(e));
            const watch = availableForNightRole.find(e => e.elder) ?? availableForNightRole[0];
            if (watch) watch.lantern = true;
            this.maybeStartFestival(now, availableForNightRole.filter(e => e !== watch));
            this.maybeScheduleThief(now);
            for (const e of this.entities) {
                if (e === watch || e.kind === 'bird' || e.dancing) continue;
                if (e.state === 'inside' || e.state === 'gone' || e.state === 'panic') continue;
                if (e.kind === 'villager') {
                    // Finish an already-reserved pickup/delivery before bed;
                    // changing its path would make it complete at a doorway.
                    if (this.hasActiveChore(e)) continue;
                    e.workUntil = undefined;
                    e.workBuildingId = undefined;
                    e.workFaceAt = undefined;
                    e.stateUntil = now + Math.random() * 2500; // drift off to bed one by one
                } else {
                    e.sleeping = true;
                    e.sitting = e.kind === 'dog';
                    e.state = 'idle';
                    e.path = null;
                    e.stateUntil = now + 3_600_000;
                }
            }
        } else {
            this.endFestival();
            if (this.thief && this.thief.state === 'sneak') this.scareThief(false);
            this.nextThiefAt = 0;
            // Breakfast for the flock, once everyone's up.
            if (this.populatedFor === 'PLAYER' && this.entities.some(e => e.kind === 'chicken')) {
                this.feedPlan = { at: now + 12_000 + Math.random() * 25_000, stage: 'wait' };
            }
            let slot = 0;
            for (const e of this.entities) {
                e.lantern = false;
                if (e.dancing) {
                    e.dancing = false;
                    e.stateUntil = now + 500 + Math.random() * 2000;
                }
                if (e.sleeping) {
                    e.sleeping = false;
                    e.sitting = false;
                    e.stateUntil = now + 500 + Math.random() * 2500;
                }
                if (e.state === 'inside' && e.hiddenUntil === Number.POSITIVE_INFINITY && !this.panicking) {
                    e.hiddenUntil = now + 600 + slot * 520 + Math.random() * 300;
                    slot++;
                }
            }
        }
    }

    /** Eggs waiting on the grass — the pre-farm food trickle. */
    private eggs: Array<{ id: number; x: number; y: number; gfx: Phaser.GameObjects.Graphics }> = [];

    private layEgg(chicken: LifeEntity) {
        const gfx = this.scene.add.graphics();
        const pos = IsoUtils.cartToIso(chicken.x, chicken.y);
        gfx.fillStyle(0x000000, 0.18);
        gfx.fillEllipse(0, 2.6, 5.5, 2.2);
        gfx.fillStyle(0xf7f2e6, 1);
        gfx.fillEllipse(0, 0, 5, 6);
        gfx.fillStyle(0xffffff, 0.85);
        gfx.fillCircle(-1, -1.4, 1.1);
        gfx.setPosition(pos.x + (Math.random() - 0.5) * 6, pos.y + 3);
        gfx.setDepth(this.characterDepth(chicken.x, chicken.y) - 2);
        gfx.setScale(0);
        this.scene.tweens.add({ targets: gfx, scaleX: 1, scaleY: 1, duration: 240, ease: 'Back.easeOut' });
        this.eggs.push({ id: this.nextId++, x: chicken.x, y: chicken.y, gfx });
        soundSystem.play('eggLay');
        // A proud little flap.
        this.scene.tweens.add({ targets: chicken.gfx, y: chicken.gfx.y - 5, duration: 110, yoyo: true, ease: 'Quad.easeOut' });
    }

    /** Try to collect an egg near a click; +food if one pops. */
    private collectEggAt(x: number, y: number): boolean {
        let best = -1;
        let bestD = 0.9;
        for (let i = 0; i < this.eggs.length; i++) {
            const d = Math.hypot(this.eggs[i].x - x, this.eggs[i].y - y);
            if (d < bestD) {
                bestD = d;
                best = i;
            }
        }
        if (best < 0) return false;
        const egg = this.eggs[best];
        this.eggs.splice(best, 1);
        // Pop up toward the counter and vanish in a sparkle.
        this.scene.tweens.add({
            targets: egg.gfx,
            y: egg.gfx.y - 24,
            alpha: 0,
            scaleX: 1.5,
            scaleY: 1.5,
            duration: 420,
            ease: 'Quad.easeOut',
            onComplete: () => egg.gfx.destroy()
        });
        const pos = IsoUtils.cartToIso(egg.x, egg.y);
        for (let i = 0; i < 3; i++) {
            const p = this.scene.add.circle(pos.x + (Math.random() - 0.5) * 8, pos.y, 1.3, 0xf2d268, 0.9);
            p.setDepth(egg.gfx.depth + 1);
            this.scene.tweens.add({
                targets: p, y: p.y - 8, alpha: 0, duration: 320,
                onComplete: () => p.destroy()
            });
        }
        gameManager.collectResource('food', 5);
        soundSystem.play('eggCollect');
        return true;
    }

    /**
     * Send the nearest free villager to pick a mushroom patch. They walk over,
     * kneel down for a moment, then carry the haul to the storehouse — the
     * food lands when the sack does. Used by clicks and by the autonomous
     * forage timer alike.
     */
    assignForage(patch: PlacedObstacle): boolean {
        if (this.populatedFor !== 'PLAYER' || this.nightMode || this.panicking) return false;
        if (this.entities.some(e => e.forageObstacleId === patch.id)) return false;

        let best: LifeEntity | null = null;
        let bestD = Number.POSITIVE_INFINITY;
        for (const e of this.entities) {
            if (e.kind !== 'villager') continue;
            if (e.state !== 'idle' && e.state !== 'walk') continue;
            if (e.child || e.sleeping || e.lantern || e.haulObstacleId || e.forageObstacleId || e.haulStage || e.carryingRock || e.carryingPack || e.pendingEnterId) continue;
            const d = Math.hypot(e.x - patch.gridX, e.y - patch.gridY);
            if (d < bestD) {
                bestD = d;
                best = e;
            }
        }
        if (!best) return false;

        const spot = this.openTileAt(patch.gridX + (Math.random() < 0.5 ? -1 : 1), patch.gridY + 1)
            ?? this.openTileAt(patch.gridX, patch.gridY);
        const path = spot
            ? PathfindingSystem.findAmbientPath(best.x, best.y, { gridX: spot.x, gridY: spot.y }, this.scene.buildings)
            : null;
        if (!path || path.length === 0) return false;

        best.forageObstacleId = patch.id;
        best.haulStage = 'toShroom';
        best.workUntil = undefined;
        best.workBuildingId = undefined;
        best.workFaceAt = undefined;
        best.pendingEnterId = undefined;
        best.path = path;
        best.state = 'walk';
        best.sitting = false;
        return true;
    }

    /** At the patch: kneel and pick for a moment (the weeding pose does the acting). */
    private startMushroomPick(e: LifeEntity, time: number) {
        const patch = this.scene.obstacles.find(o => o.id === e.forageObstacleId);
        if (!patch) {
            this.cancelUnpickedChore(e);
            e.state = 'idle';
            e.stateUntil = time + 600;
            return;
        }
        const info = OBSTACLE_DEFINITIONS[patch.type];
        const patchX = patch.gridX + (info?.width ?? 1) / 2;
        const patchY = patch.gridY + (info?.height ?? 1) / 2;
        if (Math.hypot(e.x - patchX, e.y - patchY) > 1.5) {
            // Another ambient action replaced the route. Release the patch so
            // another forager can take it instead of harvesting it remotely.
            this.cancelUnpickedChore(e);
            e.path = null;
            e.state = 'idle';
            e.stateUntil = time + 600;
            return;
        }
        e.haulStage = undefined;
        e.state = 'idle';
        e.workUntil = time + 1100;
        e.stateUntil = e.workUntil;
        e.workFaceAt = { x: patchX, y: patchY };
        this.faceToward(e, patchX, patchY);
    }

    /** Picking done: pocket the mushrooms and carry them to the depot. */
    private completeForagePick(e: LifeEntity, time: number) {
        const patch = this.scene.obstacles.find(o => o.id === e.forageObstacleId);
        e.forageObstacleId = undefined;
        if (!patch) {
            e.state = 'idle';
            e.stateUntil = time + 600;
            return;
        }
        const golden = ObstacleRenderer.grassLookOf(patch.id).egg === 0;
        const pos = IsoUtils.cartToIso(patch.gridX + 0.5, patch.gridY + 0.5);
        const depth = patch.graphics.depth + 1;
        this.scene.removeObstacle(patch.id); // persisted
        soundSystem.play(golden ? 'coin' : 'snip');
        const color = golden ? 0xffd84a : 0xe8875a;
        for (let i = 0; i < (golden ? 7 : 4); i++) {
            const p = this.scene.add.circle(pos.x + (Math.random() - 0.5) * 12, pos.y, 1.5, color, 0.95);
            p.setDepth(depth);
            this.scene.tweens.add({
                targets: p, y: p.y - 10 - Math.random() * 6, alpha: 0,
                duration: 380 + Math.random() * 180,
                onComplete: () => p.destroy()
            });
        }

        const amount = golden ? 50 : 6;
        const depot = this.scene.buildings.find(b => b.type === 'storage' && b.health > 0)
            ?? this.scene.buildings.find(b => b.type === 'town_hall' && b.health > 0);
        const door = depot ? this.doorOf(depot) : null;
        const path = door
            ? PathfindingSystem.findAmbientPath(e.x, e.y, { gridX: door.x, gridY: door.y }, this.scene.buildings)
            : null;
        if (depot && path && path.length > 0) {
            e.carryingPack = 'food';
            e.packAmount = amount;
            e.haulDepotId = depot.id;
            e.haulStage = 'deliver';
            e.path = path;
            e.state = 'walk';
            return;
        }
        // No depot to walk to: they eat well on the spot, the village still gains.
        gameManager.collectResource('food', amount);
        e.state = 'idle';
        e.stateUntil = time + this.idleDuration(e);
    }

    /**
     * A clicked rock becomes a chore: the nearest free villager walks over,
     * shoulders it and carries it to the storehouse (town hall failing that)
     * for ore. Returns false if nobody can take the job right now.
     */
    assignRockHaul(obstacle: PlacedObstacle): boolean {
        if (this.populatedFor !== 'PLAYER' || this.nightMode || this.panicking) return false;
        if (this.entities.some(e => e.haulObstacleId === obstacle.id)) return false;
        // Somewhere to bring it: a storehouse or the town hall.
        const depot = this.scene.buildings.find(b => b.type === 'storage' && b.health > 0)
            ?? this.scene.buildings.find(b => b.type === 'town_hall' && b.health > 0);
        if (!depot) return false;

        let best: LifeEntity | null = null;
        let bestD = Number.POSITIVE_INFINITY;
        for (const e of this.entities) {
            if (e.kind !== 'villager') continue;
            if (e.state !== 'idle' && e.state !== 'walk') continue;
            if (e.child || e.sleeping || e.lantern || e.haulObstacleId || e.forageObstacleId || e.haulStage || e.carryingRock || e.carryingPack || e.pendingEnterId) continue;
            const d = Math.hypot(e.x - obstacle.gridX, e.y - obstacle.gridY);
            if (d < bestD) {
                bestD = d;
                best = e;
            }
        }
        if (!best) return false;

        const spot = this.openTileAt(obstacle.gridX + 0.5, obstacle.gridY + 1.5)
            ?? this.openTileAt(obstacle.gridX, obstacle.gridY);
        const path = spot
            ? PathfindingSystem.findAmbientPath(best.x, best.y, { gridX: spot.x, gridY: spot.y }, this.scene.buildings)
            : null;
        if (!path || path.length === 0) return false;

        best.haulObstacleId = obstacle.id;
        best.haulStage = 'toRock';
        best.workUntil = undefined;
        best.workBuildingId = undefined;
        best.workFaceAt = undefined;
        best.pendingEnterId = undefined;
        best.path = path;
        best.state = 'walk';
        best.sitting = false;
        return true;
    }

    /** Arrived at the rock: shoulder it and turn for the depot. */
    private pickUpRock(e: LifeEntity, time: number) {
        const obstacle = this.scene.obstacles.find(o => o.id === e.haulObstacleId);
        if (!obstacle) {
            this.cancelUnpickedChore(e);
            e.state = 'idle';
            e.stateUntil = time + 600;
            return;
        }
        const info = OBSTACLE_DEFINITIONS[obstacle.type];
        const obstacleX = obstacle.gridX + (info?.width ?? 1) / 2;
        const obstacleY = obstacle.gridY + (info?.height ?? 1) / 2;
        if (Math.hypot(e.x - obstacleX, e.y - obstacleY) > 1.5) {
            // The walk was interrupted/replaced. Never remove an obstacle from
            // across the map, and release its reservation for another worker.
            this.cancelUnpickedChore(e);
            e.path = null;
            e.state = 'idle';
            e.stateUntil = time + 600;
            return;
        }
        e.haulStage = undefined;
        const size: 'small' | 'large' = obstacle.type === 'rock_large' ? 'large' : 'small';
        this.scene.removeObstacle(obstacle.id); // persists the pickup
        soundSystem.play('stone');
        e.carryingRock = size;
        e.haulObstacleId = undefined;

        const depot = this.scene.buildings.find(b => b.type === 'storage' && b.health > 0)
            ?? this.scene.buildings.find(b => b.type === 'town_hall' && b.health > 0);
        const door = depot ? this.doorOf(depot) : null;
        const path = door
            ? PathfindingSystem.findAmbientPath(e.x, e.y, { gridX: door.x, gridY: door.y }, this.scene.buildings)
            : null;
        if (!depot || !path || path.length === 0) {
            // The persisted obstacle is already gone. Settle its earned ore
            // locally rather than discarding the payload when no route exists.
            e.haulDepotId = undefined;
            this.depositRock(e, time);
            return;
        }
        e.haulStage = 'toStorage';
        e.haulDepotId = depot.id;
        e.path = path;
        e.state = 'walk';
        if (this.onScreen(e)) this.drawEntity(e, time, true);
    }

    /** Release an unpicked obstacle reservation without touching earned cargo. */
    private cancelUnpickedChore(e: LifeEntity) {
        e.haulObstacleId = undefined;
        e.forageObstacleId = undefined;
        e.haulStage = undefined;
        e.haulDepotId = undefined;
        if (!e.carryingRock && !e.carryingPack) e.packAmount = undefined;
        e.workUntil = undefined;
        e.workBuildingId = undefined;
        e.workFaceAt = undefined;
    }

    private hasActiveChore(e: LifeEntity): boolean {
        return Boolean(
            e.haulStage || e.haulObstacleId || e.forageObstacleId ||
            e.carryingRock || e.carryingPack
        );
    }

    /** Weather/panic cancels the route, but cargo already removed from the world remains earned. */
    private interruptChore(e: LifeEntity) {
        this.cancelUnpickedChore(e);
    }

    /** Resume preserved cargo after shelter, or settle it locally when no depot is reachable. */
    private resumeCarriedChore(e: LifeEntity, time: number): boolean {
        if (!e.carryingRock && !e.carryingPack) return false;
        const depot = this.scene.buildings.find(b => b.type === 'storage' && b.health > 0)
            ?? this.scene.buildings.find(b => b.type === 'town_hall' && b.health > 0);
        const door = depot ? this.doorOf(depot) : null;
        const path = door
            ? PathfindingSystem.findAmbientPath(e.x, e.y, { gridX: door.x, gridY: door.y }, this.scene.buildings)
            : null;
        if (depot && path && path.length > 0) {
            e.haulDepotId = depot.id;
            e.haulStage = e.carryingRock ? 'toStorage' : 'deliver';
            e.path = path;
            e.state = 'walk';
            e.sleeping = false;
            e.sitting = false;
            return true;
        }

        // The obstacle is already gone, so never discard its reward merely
        // because all depots disappeared or became unreachable meanwhile.
        if (e.carryingRock) this.depositRock(e, time);
        else this.depositPack(e, time);
        return false;
    }

    /** Arrived at the storehouse with the day's produce: drop the sack inside. */
    private depositPack(e: LifeEntity, time: number) {
        const depot = this.scene.buildings.find(b => b.id === e.haulDepotId && b.health > 0);
        const kind = e.carryingPack;
        const granted = e.packAmount ?? 0;
        e.haulStage = undefined;
        e.carryingPack = undefined;
        e.haulDepotId = undefined;
        e.packAmount = undefined;
        // Foraged goods actually land in the stores; mine/farm runs are the
        // visible face of production the server already accrues.
        if (granted > 0) {
            gameManager.collectResource('food', granted);
            unlockTrack('harvest_home', 'Harvest Home');
            if (granted >= 50) unlockTrack('golden_cap', 'Golden Cap');
        }
        if (depot) {
            depot.doorOpenUntil = time + DOOR_PULSE_MS;
            soundSystem.play('deposit');
            const info = BUILDING_DEFINITIONS[depot.type as BuildingType];
            this.faceToward(e, depot.gridX + (info?.width ?? 1) / 2, depot.gridY + (info?.height ?? 1) / 2);
        }
        const pos = IsoUtils.cartToIso(e.x, e.y);
        const color = kind === 'ore' ? 0xffd84a : 0xf2d268;
        for (let i = 0; i < 3; i++) {
            const p = this.scene.add.circle(pos.x + (Math.random() - 0.5) * 8, pos.y - 4, 1.3, color, 0.9);
            p.setDepth(e.gfx.depth + 1);
            this.scene.tweens.add({ targets: p, y: p.y - 8, alpha: 0, duration: 340, onComplete: () => p.destroy() });
        }
        e.state = 'idle';
        e.stateUntil = time + this.idleDuration(e);
        if (this.onScreen(e)) this.drawEntity(e, time, false);
    }

    /** Arrived at the depot door: drop the rock off for ore. */
    private depositRock(e: LifeEntity, time: number) {
        const depot = this.scene.buildings.find(b => b.id === e.haulDepotId && b.health > 0);
        if (depot) depot.doorOpenUntil = time + DOOR_PULSE_MS;
        const amount = e.carryingRock === 'large' ? 20 : 8;
        e.haulStage = undefined;
        e.carryingRock = undefined;
        e.haulDepotId = undefined;
        gameManager.collectResource('ore', amount);
        soundSystem.play('deposit');
        unlockTrack('miners_vein', "Miner's Vein");
        // A couple of ore glints as it lands in the store.
        const pos = IsoUtils.cartToIso(e.x, e.y);
        for (let i = 0; i < 3; i++) {
            const p = this.scene.add.circle(pos.x + (Math.random() - 0.5) * 8, pos.y - 4, 1.3, 0xffd84a, 0.9);
            p.setDepth(e.gfx.depth + 1);
            this.scene.tweens.add({ targets: p, y: p.y - 8, alpha: 0, duration: 340, onComplete: () => p.destroy() });
        }
        e.state = 'idle';
        e.stateUntil = time + this.idleDuration(e);
        if (this.onScreen(e)) this.drawEntity(e, time, false);
    }

    // ------------------------------------------------------------- merchant

    /** The merchant's whole visit: roll in, set up, trade, pack up, move on. */
    private updateMerchant(time: number, delta: number) {
        const m = this.merchant;

        // Time for a visit? Days only, peace only, player village only.
        if (!m) {
            if (this.populatedFor !== 'PLAYER' || this.nightMode || this.panicking) return;
            if (time < this.nextMerchantAt || this.nextMerchantAt === 0) return;
            this.nextMerchantAt = time + 360_000 + Math.random() * 360_000; // next visit 6-12 min out
            const hall = this.scene.buildings.find(b => b.type === 'town_hall' && b.health > 0);
            const spot = hall ? this.merchantSpotNear(hall) : this.openTileAt(12, 16);
            if (!spot) return;
            const fromLeft = Math.random() < 0.5;
            const m2 = this.scene.mapSize;
            const entryY = Math.floor(m2 / 2);
            const edgeX = fromLeft ? 0 : m2 - 1;
            const path = PathfindingSystem.findAmbientPath(edgeX + 0.5, entryY + 0.5, { gridX: spot.x, gridY: spot.y }, this.scene.buildings);
            if (!path || path.length === 0) return;
            // He comes up the BORDER ROAD: spawn on the lane outside the plot,
            // walk along it, turn in at the village edge, then path to the stall.
            const laneX = fromLeft ? -1.4 : m2 + 0.4;
            const roadStartY = entryY + (Math.random() < 0.5 ? -8 : 8);
            path.unshift(
                new Phaser.Math.Vector2(laneX, entryY + 0.5),
                new Phaser.Math.Vector2(fromLeft ? 0.5 : m2 - 0.5, entryY + 0.5)
            );
            this.merchant = {
                gfx: this.scene.add.graphics(),
                stallGfx: this.scene.add.graphics(),
                x: laneX,
                y: roadStartY + 0.5,
                path,
                state: 'arriving',
                leaveAt: 0,
                offers: this.rollOffers(),
                facing: fromLeft ? 1 : -1,
                speed: 0.0012,
                stallDrawn: false
            };
            this.placeMerchant();
            this.drawMerchant(time, true);
            soundSystem.play('merchant');
            (this.scene as unknown as { villageBubbles?: { raise(spec: object): void } }).villageBubbles?.raise({
                key: 'merchant',
                buildingType: 'town_hall',
                text: 'A trader calls from the square!',
                ttlMs: 10_000
            });
            return;
        }

        // Trouble or nightfall sends him packing early.
        if (m.state !== 'leaving' && (this.panicking || this.nightMode)) {
            this.merchantDepart(m);
        }

        if (m.state === 'arriving' || m.state === 'leaving') {
            const arrived = this.followPath(m, delta);
            this.placeMerchant();
            if (this.onScreenAt(m.x, m.y)) this.drawMerchant(time, !arrived || m.state === 'leaving');
            if (arrived) {
                if (m.state === 'arriving') {
                    // He doesn't open shop from thin air: the stall goes up
                    // plank by plank while he hammers away beside it.
                    m.state = 'building';
                    m.buildUntil = time + STALL_BUILD_MS;
                    m.nextKnockAt = time;
                    m.facing = 1; // face the stall beside him
                } else {
                    // Off the map edge — gone until next time.
                    m.gfx.destroy();
                    m.stallGfx.destroy();
                    this.merchant = null;
                }
            }
            return;
        }

        if (m.state === 'building') {
            const t = Math.max(0, Math.min(1, 1 - ((m.buildUntil ?? time) - time) / STALL_BUILD_MS));
            if (this.onScreenAt(m.x, m.y)) {
                this.drawStall(m, t);
                this.drawMerchant(time, false, true);
                if (time >= (m.nextKnockAt ?? 0)) {
                    m.nextKnockAt = time + 500; // one knock per mallet swing
                    soundSystem.play('tap');
                }
            }
            if (time >= (m.buildUntil ?? 0)) {
                m.state = 'trading';
                m.leaveAt = time + 115_000;
                this.drawStall(m, 1);
                this.drawMerchant(time, false);
                // Open for business — and he says so, with a way in.
                const at = IsoUtils.cartToIso(m.x, m.y);
                (this.scene as unknown as { villageBubbles?: { raise(spec: object): void } }).villageBubbles?.raise({
                    key: 'merchant-open',
                    anchor: { x: at.x, y: at.y - 26 },
                    text: 'Stall’s up! Fresh wares, friend.',
                    action: { label: 'BROWSE', run: () => gameManager.openMerchant(this.getMerchantOffers()) },
                    ttlMs: 12_000
                });
            }
            return;
        }

        // Trading: stand at the stall until it's time to go.
        if (time >= m.leaveAt) {
            this.merchantDepart(m);
        }
    }

    private merchantDepart(m: MerchantState) {
        if (m.state === 'leaving') return;
        m.state = 'leaving';
        m.stallGfx.clear();
        m.stallDrawn = false;
        (this.scene as unknown as { villageBubbles?: { clear(key: string): void } }).villageBubbles?.clear('merchant-open');
        gameManager.showToast('The merchant has moved on.');
        const edgeX = m.x < this.scene.mapSize / 2 ? 0 : this.scene.mapSize - 1;
        const path = PathfindingSystem.findAmbientPath(m.x, m.y, { gridX: edgeX, gridY: Math.floor(m.y) }, this.scene.buildings);
        if (path && path.length > 0) {
            // ...and he leaves the way he came: out to the road, then along it.
            const laneX = edgeX === 0 ? -1.4 : this.scene.mapSize + 0.4;
            const exitY = path[path.length - 1].y;
            path.push(
                new Phaser.Math.Vector2(laneX, exitY),
                new Phaser.Math.Vector2(laneX, exitY + (Math.random() < 0.5 ? -9 : 9))
            );
            m.path = path;
        } else {
            m.gfx.destroy();
            m.stallGfx.destroy();
            this.merchant = null;
        }
    }

    /**
     * A camera-facing tile by the hall: the stall must set up on the south or
     * east side (larger x+y faces the viewer) or it hides behind the roof.
     * Both the merchant's tile and the stall tile beside him must be open.
     */
    private merchantSpotNear(b: PlacedBuilding): { x: number; y: number } | null {
        const info = BUILDING_DEFINITIONS[b.type as BuildingType];
        if (!info) return null;
        const max = this.scene.mapSize - 2;
        const candidates: Array<{ x: number; y: number }> = [];
        for (let off = 2; off <= 3; off++) {
            const ks = Array.from({ length: Math.max(info.width, info.height) }, (_, i) => i)
                .sort((a, b2) => Math.abs(a - (info.width - 1) / 2) - Math.abs(b2 - (info.width - 1) / 2));
            for (const k of ks) {
                if (k < info.width) candidates.push({ x: b.gridX + k, y: b.gridY + info.height + off - 1 });
                if (k < info.height) candidates.push({ x: b.gridX + info.width + off - 1, y: b.gridY + k });
            }
        }
        for (const c of candidates) {
            if (c.x < 1 || c.y < 1 || c.x > max || c.y > max) continue;
            // He stands at c; the stall pitches on the tile just NE of him.
            if (!this.isBlocked(c.x, c.y) && !this.isBlocked(c.x + 1, c.y)) return c;
        }
        return this.openTileNear(b, 2);
    }

    /**
     * Three trades a visit, deterministic per (player, world-day) from shared
     * Economy code — the server re-derives and prices the identical set, so
     * the stall can never show a deal the server would refuse.
     */
    private rollOffers(): MerchantOffer[] {
        const dayIndex = worldDayIndex(Date.now() + DayNightSystem.serverOffsetMs);
        return merchantOffersFor(this.identityKey, dayIndex);
    }

    /** Is the merchant open for business at this tile? */
    merchantAt(gx: number, gy: number): boolean {
        const m = this.merchant;
        if (!m || m.state !== 'trading') return false;
        return Math.hypot(m.x - (gx + 0.5), m.y - (gy + 0.5)) < 2.2;
    }

    getMerchantOffers(): MerchantOffer[] {
        return this.merchant?.offers ?? [];
    }

    private placeMerchant() {
        const m = this.merchant;
        if (!m) return;
        const pos = IsoUtils.cartToIso(m.x, m.y);
        m.gfx.setPosition(pos.x, pos.y - this.hopOffsetOf(m));
        m.gfx.setDepth(this.characterDepth(m.x, m.y));
    }

    /** Hooded trader hauling a two-wheeled cart of wares. */
    private drawMerchant(time: number, moving: boolean, building = false) {
        const m = this.merchant;
        if (!m) return;
        applyPixelSnap(this.scene, m.gfx);
        applyPixelSnap(this.scene, m.stallGfx);
        const g = m.gfx;
        g.clear();
        g.setScale(m.facing === -1 ? -0.85 : 0.85, 0.85);
        const phase = ((time + 137) % 520) / 520;
        const swing = moving ? Math.sin(phase * Math.PI * 2) * 2.2 : 0;
        const bob = moving ? Math.abs(Math.sin(phase * Math.PI * 2)) * 1.2 : 0;

        // Cart trailing behind (drawn first)
        g.fillStyle(0x5c4326, 1);
        g.fillRect(-16, -6 - bob * 0.4, 10, 7);
        g.fillStyle(0x7a5a38, 1);
        g.fillRect(-15, -8 - bob * 0.4, 8, 3);
        // Goods peeking out
        g.fillStyle(0xffd84a, 1);
        g.fillCircle(-13, -8.5 - bob * 0.4, 1.4);
        g.fillStyle(0xc9a86a, 1);
        g.fillCircle(-10, -8.2 - bob * 0.4, 1.6);
        // Wheel
        g.fillStyle(0x3a2c1e, 1);
        g.fillCircle(-11, 2, 3.4);
        g.fillStyle(0x8a6a3a, 1);
        g.fillCircle(-11, 2, 1.2);
        // Cart handle to the hand
        g.lineStyle(1.4, 0x5c4326, 1);
        g.lineBetween(-7, -4 - bob * 0.4, -2, -2 - bob);

        // Shadow under the trader
        g.fillStyle(0x000000, 0.22);
        g.fillEllipse(0, 11, 10, 4);
        // Legs
        g.fillStyle(0x3a2438, 1);
        g.fillRect(-2.5 - swing, 4 - bob, 2, 6 + bob);
        g.fillRect(0.5 + swing, 4 - bob, 2, 6 + bob);
        // Deep red robe
        g.fillStyle(0x8a2f3c, 1);
        g.fillCircle(0, -1 - bob, 5.4);
        g.fillStyle(0x6d2430, 1);
        g.fillRect(-5.4, 1 - bob, 10.8, 2.2);
        // Gold sash
        g.fillStyle(0xc9a227, 1);
        g.fillRect(-5, -0.4 - bob, 10, 1.2);
        // Coin pouch
        g.fillStyle(0x7a5a38, 1);
        g.fillCircle(4, 1.4 - bob, 2);
        // Hooded head
        g.fillStyle(0x8a2f3c, 1);
        g.fillCircle(0, -8.4 - bob, 4.2);
        g.fillStyle(0x1c1216, 1);
        g.fillCircle(0.8, -8 - bob, 2.6);
        g.fillStyle(0xd8a878, 1);
        g.fillCircle(1.2, -7.8 - bob, 1.6);
        // Arm on the cart handle
        g.fillStyle(0x8a2f3c, 1);
        g.fillRect(-4.5, -3 - bob, 2, 4.5);

        if (building) {
            // Mallet arm working the stall beside him: a slow lift, then the
            // strike snaps down — same 500ms beat as the knock sound.
            const ph = (time % 500) / 500;
            const lift = ph < 0.6 ? ph / 0.6 : 1 - (ph - 0.6) / 0.4;
            const ang = -0.15 - lift * 1.5; // down-forward → raised overhead
            const sx = 3.5, sy = -3.5;
            const hx = sx + Math.cos(ang) * 6, hy = sy + Math.sin(ang) * 6;
            g.lineStyle(2, 0x8a2f3c, 1);
            g.lineBetween(sx, sy, hx, hy);
            // Mallet: haft past the hand, iron head at the tip
            const tx = sx + Math.cos(ang) * 10.5, ty = sy + Math.sin(ang) * 10.5;
            g.lineStyle(1.6, 0x7a5a38, 1);
            g.lineBetween(hx, hy, tx, ty);
            g.fillStyle(0x6b6e78, 1);
            g.fillRect(tx - 2.2, ty - 2.2, 4.4, 4.4);
            g.fillStyle(0x8a8f99, 1);
            g.fillRect(tx - 2.2, ty - 2.2, 4.4, 1.4);
        }
    }

    /**
     * The merchant's market stall: a proper little iso structure — waist-high
     * counter box (SE dark / SW lit), corner posts, and a striped canopy
     * sloping toward the viewer. One contact-shadow ellipse grounds it.
     *
     * `progress` (0..1) raises it in build order — posts, then the counter,
     * then the canopy sweeping across, wares set out last — so the merchant
     * visibly assembles it instead of conjuring it.
     */
    private drawStall(m: MerchantState, progress = 1) {
        const p = Math.max(0, Math.min(1, progress));
        if (m.stallDrawn && p >= 1) return;
        m.stallDrawn = p >= 1;
        const g = m.stallGfx;
        g.clear();
        const pos = IsoUtils.cartToIso(m.x + 1.1, m.y - 0.4);
        g.setPosition(pos.x, pos.y);
        g.setDepth(this.characterDepth(m.x + 1.1, m.y - 0.4));

        const quad = (pts: number[][], color: number, a: number) => {
            g.fillStyle(color, a);
            g.beginPath();
            g.moveTo(pts[0][0], pts[0][1]);
            for (let i = 1; i < pts.length; i++) g.lineTo(pts[i][0], pts[i][1]);
            g.closePath();
            g.fillPath();
        };
        const mix = (a: number[], b: number[], t: number): number[] =>
            [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
        // Per-part build windows within the overall progress.
        const stage = (a: number, b: number) => Math.max(0, Math.min(1, (p - a) / (b - a)));
        const postsT = stage(0, 0.3);      // corner posts rise first
        const counterT = stage(0.28, 0.55); // counter boards go up
        const canopyT = stage(0.55, 0.88);  // stripes sweep west to east
        const waresT = stage(0.9, 1);       // goods set out last

        // Footprint diamond (local iso space), counter and canopy metrics
        const cN = [0, -10], cE = [20, 0], cS = [0, 10], cW = [-20, 0];
        const counterH = 8 * counterT;
        const backH = 30, frontH = 22; // canopy slopes down toward the viewer

        // Contact shadow — one ellipse, growing with the structure
        g.fillStyle(0x1d2a12, 0.3 * (0.35 + 0.65 * p));
        g.fillEllipse(0, 2, 52 * (0.5 + 0.5 * p), 24 * (0.5 + 0.5 * p));

        // Corner posts (far pair first, then the counter hides their feet)
        const post = (c: number[], h: number) => {
            if (h <= 0) return;
            g.fillStyle(0x5c4326, 1);
            g.fillRect(c[0] - 1.1, c[1] - h, 2.2, h);
        };
        post(cN, (backH + 2) * postsT);
        post(cW, (backH - 3) * postsT);
        post(cE, (backH - 3) * postsT);

        // Counter: SE face (dark), SW face (lit), plank top
        const up = (pt: number[], h: number): number[] => [pt[0], pt[1] - h];
        if (counterT > 0) {
            quad([cE, cS, up(cS, counterH), up(cE, counterH)], 0x6b4226, 1);
            quad([cS, cW, up(cW, counterH), up(cS, counterH)], 0x8a5c38, 1);
            quad([up(cN, counterH), up(cE, counterH), up(cS, counterH), up(cW, counterH)], 0x9c6c42, 1);
            if (counterT >= 1) {
                g.lineStyle(1, 0x5c4326, 0.7);
                g.lineBetween(cW[0], cW[1] - counterH * 0.5, cS[0], cS[1] - counterH * 0.5);
                g.lineBetween(cS[0], cS[1] - counterH * 0.5, cE[0], cE[1] - counterH * 0.5);
            }
        }
        post(cS, frontH * postsT); // near post stands on the counter line

        // Wares on the counter top: ore chunk, wheat sheaf, coin stack —
        // each settles down a touch as it lands.
        if (waresT > 0) {
            const drop = (1 - waresT) * 3;
            g.fillStyle(0x6b6e78, 1);
            g.fillEllipse(-8, -counterH - 1.5 - drop, 5.5, 3.6);
            g.fillStyle(0xffd84a, 1);
            g.fillCircle(-8, -counterH - 2.2 - drop, 0.9);
            if (waresT > 0.4) {
                g.fillStyle(0xd8a83e, 1);
                g.fillRect(-1.2, -counterH - 5 - drop, 2.4, 4.6);
                g.fillStyle(0xe8c04a, 1);
                g.fillEllipse(0, -counterH - 5.4 - drop, 3.4, 1.8);
            }
            if (waresT > 0.7) {
                g.fillStyle(0xffd700, 1);
                g.fillEllipse(8, -counterH - 1.6 - drop, 4, 1.6);
                g.fillEllipse(8, -counterH - 2.8 - drop, 4, 1.6);
            }
        }

        // Striped canopy: a sloped plane over the posts, overhanging a touch
        const oh = 1.28;
        const A = [cN[0] * oh, cN[1] * oh - backH - 2]; // back corner (high)
        const B = [cE[0] * oh, cE[1] * oh - backH + 3];
        const C = [cS[0] * oh, cS[1] * oh - frontH];    // front corner (low)
        const D = [cW[0] * oh, cW[1] * oh - backH + 3];
        const STRIPES = 6;
        for (let i = 0; i < STRIPES; i++) {
            const t0 = i / STRIPES;
            const t1 = Math.min((i + 1) / STRIPES, canopyT);
            if (t1 <= t0) break; // canvas rolled out only this far yet
            // Bands sweep from the west edge to the east edge across the plane
            quad([mix(D, A, t0), mix(D, A, t1), mix(C, B, t1), mix(C, B, t0)],
                i % 2 === 0 ? 0xc23b2e : 0xe8ddc8, 1);
        }
        // Hanging valance along the two near eaves — trimmed on last
        if (canopyT >= 1 && p > 0.92) {
            const valance = (from: number[], to: number[]) => {
                for (let i = 0; i < 4; i++) {
                    const t0 = i / 4;
                    const t1 = (i + 1) / 4;
                    quad([mix(from, to, t0), mix(from, to, t1),
                        [mix(from, to, t1)[0], mix(from, to, t1)[1] + 3.4],
                        [mix(from, to, t0)[0], mix(from, to, t0)[1] + 3.4]],
                        i % 2 === 0 ? 0xa8301f : 0xd8cdb8, 1);
                }
            };
            valance(D, C);
            valance(C, B);
        }
    }

    /** Grid positions of lantern carriers, for the lighting system. */
    getLanternPositions(): Array<{ x: number; y: number }> {
        const spots: Array<{ x: number; y: number }> = [];
        for (const e of this.entities) {
            if (e.lantern && e.state !== 'inside' && e.state !== 'gone') {
                spots.push({ x: e.x, y: e.y });
            }
        }
        return spots;
    }

    /** Pointer glides near a critter: it notices you — turns, little hop, soft greeting. */
    handleHover(x: number, y: number) {
        const time = this.scene.time.now;
        const e = this.nearestEntity(x, y, 0.9);
        if (!e || time < e.reactCooldownUntil) return;
        if (e.kind !== 'bird') {
            soundSystem.voice(
                e.kind === 'villager' ? 'villager' : e.kind === 'dog' ? 'dog' : 'chicken',
                e.child ? 1 : (e.animOffset % 1000) / 1000,
                Boolean(e.elder),
                true
            );
        }
        e.reactCooldownUntil = time + 2600;
        e.reactUntil = time + 700;
        const screenDx = (x - e.x) - (y - e.y);
        if (Math.abs(screenDx) > 0.05) e.facing = screenDx >= 0 ? 1 : -1;
        if (e.state === 'idle') e.stateUntil = Math.max(e.stateUntil, time + 900);
        this.scene.tweens.add({ targets: e.gfx, y: e.gfx.y - 4, duration: 90, yoyo: true, ease: 'Quad.easeOut' });
        if (this.onScreen(e)) this.drawEntity(e, time, false);
    }

    /** Clicked on a critter: full delight. Hearts, hops, feathers. Eggs get collected. */
    handlePoke(x: number, y: number) {
        const time = this.scene.time.now;
        if (this.collectEggAt(x, y)) return;
        if (this.thief && this.thief.state === 'sneak' && Math.hypot(this.thief.x - x, this.thief.y - y) < 1.3) {
            this.scareThief(true);
            return;
        }
        const e = this.nearestEntity(x, y, 1.0);
        if (!e || time < e.reactCooldownUntil - 1400) return; // pokes allow a shorter cooldown than hovers
        e.reactCooldownUntil = time + 2600;
        e.reactUntil = time + 1000;
        const screenDx = (x - e.x) - (y - e.y);
        if (Math.abs(screenDx) > 0.05) e.facing = screenDx >= 0 ? 1 : -1;
        if (e.state === 'idle') e.stateUntil = Math.max(e.stateUntil, time + 1300);
        e.sitting = false;

        // Everyone answers a click: "hi!", a bark, a cluck — the village talks back.
        if (e.kind !== 'bird') {
            // Sleepers answer with a drowsy half-voice instead of a greeting.
            soundSystem.voice(
                e.kind === 'villager' ? 'villager' : e.kind === 'dog' ? 'dog' : 'chicken',
                e.child ? 1 : (e.animOffset % 1000) / 1000,
                Boolean(e.elder),
                Boolean(e.sleeping)
            );
        }
        if (e.kind === 'chicken') {
            // Startled flutter + drifting feathers.
            this.scene.tweens.add({ targets: e.gfx, y: e.gfx.y - 9, duration: 140, yoyo: true, ease: 'Quad.easeOut' });
            this.spawnFeathers(e);
        } else {
            const hops = e.kind === 'dog' ? 1 : 0; // dogs double-hop
            this.scene.tweens.add({
                targets: e.gfx,
                y: e.gfx.y - 7,
                duration: 130,
                yoyo: true,
                repeat: hops,
                ease: 'Quad.easeOut'
            });
            this.spawnHearts(e);
        }
        if (this.onScreen(e)) this.drawEntity(e, time, false);
    }

    private nearestEntity(x: number, y: number, maxDist: number): LifeEntity | null {
        let best: LifeEntity | null = null;
        let bestD = maxDist;
        for (const e of this.entities) {
            if (e.state === 'gone' || e.state === 'inside' || e.state === 'panic' || e.kind === 'bird') continue;
            const d = Math.hypot(e.x - x, e.y - y);
            if (d < bestD) {
                bestD = d;
                best = e;
            }
        }
        return best;
    }

    private spawnHearts(e: LifeEntity) {
        const pos = IsoUtils.cartToIso(e.x, e.y);
        const count = 2;
        for (let i = 0; i < count; i++) {
            const heart = this.scene.add.graphics();
            heart.fillStyle(0xe75a7c, 1);
            heart.fillCircle(-1.3, 0, 1.6);
            heart.fillCircle(1.3, 0, 1.6);
            heart.fillTriangle(-2.8, 0.8, 2.8, 0.8, 0, 4);
            heart.setPosition(pos.x + (i === 0 ? -4 : 5), pos.y - 16);
            heart.setDepth(e.gfx.depth + 2);
            heart.setAlpha(0.95);
            this.scene.tweens.add({
                targets: heart,
                y: heart.y - 14 - Math.random() * 6,
                x: heart.x + (Math.random() - 0.5) * 8,
                alpha: 0,
                scale: 1.35,
                duration: 750 + i * 180,
                ease: 'Quad.easeOut',
                onComplete: () => heart.destroy()
            });
        }
    }

    private spawnFeathers(e: LifeEntity) {
        const pos = IsoUtils.cartToIso(e.x, e.y);
        for (let i = 0; i < 3; i++) {
            const feather = this.scene.add.graphics();
            feather.fillStyle(0xf3ecdd, 0.95);
            feather.fillEllipse(0, 0, 4, 1.6);
            feather.setPosition(pos.x + (Math.random() - 0.5) * 8, pos.y - 8 - Math.random() * 4);
            feather.setDepth(e.gfx.depth + 2);
            feather.setAngle(Math.random() * 60 - 30);
            this.scene.tweens.add({
                targets: feather,
                y: feather.y + 12 + Math.random() * 6,
                x: feather.x + (Math.random() - 0.5) * 14,
                angle: feather.angle + (Math.random() - 0.5) * 140,
                alpha: 0,
                duration: 900 + Math.random() * 400,
                ease: 'Sine.easeInOut',
                onComplete: () => feather.destroy()
            });
        }
    }

    clear() {
        this.calmTimer?.remove();
        this.calmTimer = null;
        this.dragonScare = false;
        for (const site of this.constructionSites) {
            this.bubbles()?.clear(`construct_${site.buildingId}`);
            site.gfx.destroy();
        }
        this.constructionSites = [];
        for (const scar of this.scars) scar.gfx.destroy();
        this.scars = [];
        this.owl?.gfx.destroy();
        this.owl = null;
        if (this.forge) this.endForge();
        this.wolves?.gfx.destroy();
        this.wolves = null;
        this.nextOwlAt = 0;
        this.nextForgeAt = 0;
        this.nextWolvesAt = 0;
        this.patrolRoute = null;
        this.saveStoneMaturity();
        this.stoneGfx?.destroy();
        this.stoneGfx = null;
        // Keep the lane ages: a same-village repopulate restores them so an
        // in-flight re-lay doesn't snap to done. populate() clears twice in a
        // row (an external clear, then its own) — never let the second, empty
        // wipe clobber the stash holding the real routes.
        if (this.stoneRoutes.length > 0) {
            this.stoneStash = { identity: this.identityKey, routes: this.stoneRoutes };
        }
        this.stoneRoutes = [];
        this.stoneLayoutHash = '';
        this.stoneBandSignature = '';
        this.lastStoneTickAt = 0;
        this.endFestival();
        this.despawnThief();
        this.clearFeedSpot();
        this.feedPlan = null;
        for (const e of this.entities) e.gfx.destroy();
        for (const f of this.campFigures) f.gfx.destroy();
        for (const egg of this.eggs) egg.gfx.destroy();
        if (this.merchant) {
            this.merchant.gfx.destroy();
            this.merchant.stallGfx.destroy();
            this.merchant = null;
        }
        this.entities = [];
        this.campFigures = [];
        this.eggs = [];
        this.panicking = false;
        this.nightMode = false;
        this.rainMode = false;
        this.populatedFor = null;
        this.showCampFigures = false;
        this.populationCount = null;
        this.nextStoneSaveAt = 0;
    }

    update(time: number, delta: number) {
        if (this.entities.length === 0 && this.campFigures.length === 0 && !this.showCampFigures) {
            if (this.populatedFor === null) return;
        }
        this.staggerFrame = (this.staggerFrame + 1) % 3;

        if (this.showCampFigures && !this.panicking && this.scene.mode === 'HOME' && time >= this.nextArmySyncAt) {
            this.nextArmySyncAt = time + ARMY_SYNC_MS;
            this.syncArmyFigures(time);
        }

        // The odd bird flying over makes even an empty stretch of map feel
        // alive — but birds roost at night; the sky belongs to the dark.
        if (this.populatedFor !== null && time >= this.nextBirdAt) {
            this.nextBirdAt = time + 12000 + Math.random() * 22000;
            if (!this.nightMode) this.spawnBird();
        }
        this.updateMerchant(time, delta);

        // Foragers head out on their own: any mushroom patch is fair game.
        if (this.populatedFor === 'PLAYER' && !this.nightMode && !this.panicking && time >= this.nextForageAt) {
            this.nextForageAt = time + 45_000 + Math.random() * 45_000;
            const shrooms = this.scene.obstacles.filter(o => {
                if (o.type !== 'grass_patch') return false;
                const look = ObstacleRenderer.grassLookOf(o.id);
                return look.variant === 3 || look.egg === 0;
            });
            const patch = shrooms[Math.floor(Math.random() * shrooms.length)];
            if (patch) this.assignForage(patch);
        }

        // ...and once in a very long while, something much bigger passes overhead.
        if (this.populatedFor !== null && this.nextDragonAt > 0 && time >= this.nextDragonAt) {
            this.nextDragonAt = time + 720_000 + Math.random() * 780_000; // 12-25 min until the next
            this.spawnDragonShadow();
        }

        this.updateChats(time);
        this.updateThief(time, delta);
        this.updateElderFeeding(time);
        this.updateMerchantBrowsers(time);
        this.updateConstruction(time);
        this.updateScars(time);
        this.updateNightEvents(time, delta);
        this.updateStonePaths(time);

        for (const e of this.entities) this.updateEntity(e, time, delta);
        this.entities = this.entities.filter(e => e.state !== 'gone');

        for (const f of [...this.campFigures]) this.updateCampFigure(f, time, delta);
    }

    // ------------------------------------------------------------ entity AI

    private spawnEntity(kind: LifeKind, x: number, y: number): LifeEntity {
        const baseSpeed =
            kind === 'dog' ? 0.0021 :
            kind === 'chicken' ? 0.0013 :
            kind === 'bird' ? 0.006 :
            0.00085 + Math.random() * 0.0004;
        const e: LifeEntity = {
            id: this.nextId++,
            kind,
            gfx: this.scene.add.graphics(),
            x, y,
            path: null,
            state: 'idle',
            stateUntil: 0,
            speed: baseSpeed,
            baseSpeed,
            facing: Math.random() < 0.5 ? 1 : -1,
            animOffset: Math.random() * 10000,
            palette: 0,
            style: 0,
            homeX: x,
            homeY: y,
            panicAt: 0,
            stagger: Math.floor(Math.random() * 3),
            reactUntil: 0,
            reactCooldownUntil: 0,
            role: 'peasant'
        };
        this.placeGfx(e);
        this.drawEntity(e, this.scene.time.now, false);
        this.entities.push(e);
        return e;
    }

    private updateEntity(e: LifeEntity, time: number, delta: number) {
        if (e.state === 'gone') return;

        // Festival bounce: dancers bob on the beat and turn to the music.
        if (e.dancing && e.state === 'idle') {
            this.placeGfx(e);
            e.gfx.y -= Math.abs(Math.sin((time + e.animOffset) * 0.008)) * 3;
            const turn = Math.sin((time + e.animOffset) * 0.0021);
            e.facing = turn >= 0 ? 1 : -1;
            if (this.onScreen(e)) this.drawEntity(e, time, true);
            return;
        }

        if (e.kind === 'bird') {
            e.x += (e.birdVX ?? 0) * delta;
            e.y += (e.birdVY ?? 0) * delta;
            const margin = e.birdType === 3 ? 8 : 4;
            if (e.x < -margin || e.y < -margin || e.x > this.scene.mapSize + margin || e.y > this.scene.mapSize + margin) {
                e.gfx.destroy();
                e.state = 'gone';
                if (e.birdType === 3) {
                    if (this.dragonScare) {
                        // The shadow has passed — the village dares to breathe again.
                        this.dragonScare = false;
                        if (this.scene.mode === 'HOME') this.calm();
                    }
                }
                return;
            }
            // The dragon is only a shadow cast DOWN; real birds fly high.
            this.placeGfx(e, e.birdType === 3 ? 0 : -58);
            if (this.onScreen(e)) this.drawEntity(e, time, true);
            return;
        }

        if (e.state === 'panic') {
            this.updatePanic(e, time, delta);
            return;
        }

        if (e.state === 'inside') {
            // Safe indoors: wait out the visit (or the whole raid).
            if (this.panicking) return;
            if (time >= (e.hiddenUntil ?? 0)) this.exitBuilding(e, time);
            return;
        }

        if (e.state === 'walk') {
            const arrived = this.followPath(e, delta);
            this.placeGfx(e);
            if (arrived) {
                e.path = null;
                if (e.haulStage === 'toRock') {
                    this.pickUpRock(e, time);
                    return;
                }
                if (e.haulStage === 'toStorage') {
                    this.depositRock(e, time);
                    return;
                }
                if (e.haulStage === 'deliver') {
                    this.depositPack(e, time);
                    return;
                }
                if (e.haulStage === 'toShroom') {
                    this.startMushroomPick(e, time);
                    return;
                }
                if (e.pendingEnterId) {
                    this.enterBuilding(e, time);
                    return;
                }
                e.state = 'idle';
                if (e.workFaceAt) {
                    // Reached the workplace: hammer/hoe away for a while.
                    e.workUntil = time + 2600 + Math.random() * 3800;
                    e.stateUntil = e.workUntil;
                    this.faceToward(e, e.workFaceAt.x, e.workFaceAt.y);
                    // Step off the tile center to its edge so they stand right AT
                    // the thing they're working on instead of a half-tile away.
                    const wdx = e.workFaceAt.x - e.x;
                    const wdy = e.workFaceAt.y - e.y;
                    const wd = Math.hypot(wdx, wdy) || 1;
                    e.x += (wdx / wd) * 0.42;
                    e.y += (wdy / wd) * 0.42;
                    this.placeGfx(e);
                } else if ((this.nightMode || this.rainMode) && e.kind === 'villager' && !e.lantern && !e.dancing) {
                    // Arrived in darkness or rain: pause, then seek shelter.
                    e.stateUntil = time + 300 + Math.random() * 500;
                } else {
                    e.sitting = e.kind === 'dog' && Math.random() < 0.5;
                    e.stateUntil = time + this.idleDuration(e);
                    this.faceNearbyFriend(e);
                }
            }
            if (this.onScreen(e)) this.drawEntity(e, time, !arrived);
            return;
        }

        // idle
        const working = e.workUntil !== undefined && time < e.workUntil;
        if (working) {
            this.emitWorkEffects(e, time);
            // The workplace shows the shift: the mine's pulley hurries, ore glints.
            if (e.workBuildingId) {
                const wb = this.scene.buildings.find(b => b.id === e.workBuildingId);
                if (wb) wb.crewedUntil = time + 1600;
            }
            if (this.onScreen(e)) this.drawEntity(e, time, false);
            return;
        }
        if (e.workUntil !== undefined) {
            if (e.forageObstacleId) {
                e.workUntil = undefined;
                e.workFaceAt = undefined;
                this.completeForagePick(e, time);
                return;
            }
            const finishedBuilding = this.scene.buildings.find(b => b.id === e.workBuildingId && b.health > 0);
            e.workUntil = undefined;
            e.workBuildingId = undefined;
            e.workFaceAt = undefined;
            // Shift's over at a mine or farm: shoulder the produce and run it to
            // the storehouse. Purely visual — the server accrues the actual
            // ore/food; this is the delivery you get to SEE.
            if (
                finishedBuilding && (finishedBuilding.type === 'mine' || finishedBuilding.type === 'farm') &&
                !this.nightMode && !this.panicking
            ) {
                const depot = this.scene.buildings.find(b => b.type === 'storage' && b.health > 0);
                const door = depot ? this.doorOf(depot) : null;
                const path = door
                    ? PathfindingSystem.findAmbientPath(e.x, e.y, { gridX: door.x, gridY: door.y }, this.scene.buildings)
                    : null;
                if (depot && path && path.length > 0) {
                    e.carryingPack = finishedBuilding.type === 'mine' ? 'ore' : 'food';
                    // The pile/crop was just hauled off: the fill starts over.
                    finishedBuilding.lastHarvestAt = time;
                    e.haulDepotId = depot.id;
                    e.haulStage = 'deliver';
                    e.path = path;
                    e.state = 'walk';
                    return;
                }
            }
        }
        if (time >= e.stateUntil) {
            this.chooseNextAction(e, time);
        } else if (e.kind === 'chicken' && !e.sleeping) {
            // Egg time? Only in the player's own village, and never mid-panic.
            if (this.populatedFor === 'PLAYER' && !this.nightMode && !this.panicking &&
                e.nextEggAt !== undefined && time >= e.nextEggAt && this.eggs.length < 4) {
                e.nextEggAt = time + 70_000 + Math.random() * 80_000;
                this.layEgg(e);
            }
            // Peck cycle while idling.
            const phase = ((time + e.animOffset) % 900) / 900;
            const pecking = phase < 0.35;
            if (pecking !== e.pecking) {
                e.pecking = pecking;
                if (this.onScreen(e)) this.drawEntity(e, time, false);
                return;
            }
        }
        if (this.onScreen(e) && (e.id + this.staggerFrame) % 3 === 0) {
            this.drawEntity(e, time, false);
        }
    }

    private chooseNextAction(e: LifeEntity, time: number) {
        // Growing up: the child becomes one of the village's adults.
        if (e.child && e.matureAt !== undefined && time >= e.matureAt) {
            e.child = false;
            e.matureAt = undefined;
            e.baseSpeed /= 1.35;
            e.speed = e.baseSpeed;
            const seed = hashString(`${this.identityKey}:grown:${e.id}`);
            e.style = (seed >> 3) % 5 < 2 ? 1 : 0;
            const pos = IsoUtils.cartToIso(e.x, e.y);
            for (let i = 0; i < 5; i++) {
                const p = this.scene.add.circle(pos.x + (Math.random() - 0.5) * 12, pos.y - 6, 1.4, 0xffe9a8, 0.95);
                p.setDepth(e.gfx.depth + 1);
                this.scene.tweens.add({
                    targets: p, y: p.y - 12, alpha: 0, duration: 500,
                    onComplete: () => p.destroy()
                });
            }
            if (this.onScreen(e)) this.drawEntity(e, time, false);
        }

        // Children just play: scamper somewhere, or tag along after an adult.
        if (e.child && !this.nightMode && !this.rainMode) {
            let dest: { x: number; y: number } | null = null;
            if (Math.random() < 0.35) {
                const adults = this.entities.filter(o =>
                    o.kind === 'villager' && !o.child && o.state !== 'gone' && o.state !== 'inside');
                const adult = adults[Math.floor(Math.random() * adults.length)];
                if (adult) dest = this.openTileAt(adult.x + (Math.random() - 0.5) * 2, adult.y + (Math.random() - 0.5) * 2);
            }
            if (!dest) {
                dest = this.openTileAt(e.x + (Math.random() - 0.5) * 10, e.y + (Math.random() - 0.5) * 10);
            }
            if (dest) {
                const path = PathfindingSystem.findAmbientPath(e.x, e.y, { gridX: dest.x, gridY: dest.y }, this.scene.buildings);
                if (path && path.length > 0) {
                    e.path = path;
                    e.state = 'walk';
                    return;
                }
            }
            e.stateUntil = time + 500 + Math.random() * 1200;
            return;
        }

        // Night or rain: everyone but the lantern-carrying watch seeks shelter.
        if ((this.nightMode || this.rainMode) && !e.lantern && !e.sleeping && e.kind !== 'bird') {
            if (e.kind === 'villager') {
                const refuge = this.findRefuge(e);
                const door = refuge ? this.doorOf(refuge) : null;
                const path = door
                    ? PathfindingSystem.findAmbientPath(e.x, e.y, { gridX: door.x, gridY: door.y }, this.scene.buildings)
                    : null;
                if (refuge && path && path.length > 0) {
                    e.path = path;
                    e.state = 'walk';
                    e.pendingEnterId = refuge.id;
                    e.sitting = false;
                    return;
                }
            }
            // No bed tonight (or a dog/chicken): doze off right here.
            e.sleeping = true;
            e.sitting = e.kind === 'dog';
            e.state = 'idle';
            e.stateUntil = time + 3_600_000;
            if (this.onScreen(e)) this.drawEntity(e, time, false);
            return;
        }

        const structures = this.scene.buildings.filter(b => b.type !== 'wall' && b.health > 0);
        let dest: { x: number; y: number } | null = null;
        e.pendingEnterId = undefined;
        e.workBuildingId = undefined;
        e.workFaceAt = undefined;

        const workplaceOf = (role: LifeRole) =>
            role === 'builder' ? structures.filter(b => isDefense(b.type))
            : role === 'miner' ? structures.filter(b => b.type === 'mine')
            : [];

        if (e.kind === 'chicken') {
            // Chickens never stray far from the coop.
            dest = this.openTileAt(
                e.homeX + (Math.random() - 0.5) * 3.2,
                e.homeY + (Math.random() - 0.5) * 3.2
            );
        } else if (e.kind === 'dog' && Math.random() < 0.4) {
            // Trot over to a villager and keep them company.
            const friends = this.entities.filter(o => o.kind === 'villager' && o.state !== 'gone' && o.state !== 'inside');
            const friend = friends[Math.floor(Math.random() * friends.length)];
            if (friend) {
                e.followId = friend.id;
                dest = this.openTileAt(friend.x + (Math.random() - 0.5) * 2, friend.y + (Math.random() - 0.5) * 2);
            }
        } else if (e.kind === 'villager' && e.role === 'farmer' && !this.nightMode && Math.random() < 0.55) {
            // The farmer works the farm when there is one; otherwise tends wild greenery.
            const farms = structures.filter(b => b.type === 'farm');
            const farm = farms[Math.floor(Math.random() * farms.length)];
            if (farm) {
                dest = this.openTileNear(farm);
                if (dest) {
                    const finfo = BUILDING_DEFINITIONS[farm.type as BuildingType];
                    e.workBuildingId = farm.id;
                    e.workFaceAt = {
                        x: farm.gridX + (finfo?.width ?? 1) / 2,
                        y: farm.gridY + (finfo?.height ?? 1) / 2
                    };
                }
            }
            const plants = this.scene.obstacles.filter(o => FARMABLE.has(o.type));
            const plant = plants[Math.floor(Math.random() * plants.length)];
            if (!dest && plant) {
                const info = OBSTACLE_DEFINITIONS[plant.type];
                const cx = plant.gridX + (info?.width ?? 1) / 2;
                const cy = plant.gridY + (info?.height ?? 1) / 2;
                dest = this.openTileAt(cx + (Math.random() < 0.5 ? -1 : 1), cy + (Math.random() < 0.5 ? -1 : 1));
                if (dest) e.workFaceAt = { x: cx, y: cy };
            }
        } else if (e.kind === 'villager' && e.role === 'peasant' && !this.nightMode && Math.random() < 0.16 &&
            this.scene.obstacles.some(o => FARMABLE.has(o.type))) {
            // Anyone might kneel down and weed the garden for a spell.
            const plants = this.scene.obstacles.filter(o => FARMABLE.has(o.type));
            const plant = plants[Math.floor(Math.random() * plants.length)];
            if (plant) {
                const pinfo = OBSTACLE_DEFINITIONS[plant.type];
                const cx = plant.gridX + (pinfo?.width ?? 1) / 2;
                const cy = plant.gridY + (pinfo?.height ?? 1) / 2;
                dest = this.openTileAt(cx + (Math.random() < 0.5 ? -1 : 1), cy + (Math.random() < 0.5 ? -1 : 1));
                if (dest) e.workFaceAt = { x: cx, y: cy };
            }
        } else if (e.kind === 'villager' && e.role !== 'peasant' && !this.nightMode && Math.random() < 0.55) {
            // Workers head to a workplace and put in a shift.
            const options = workplaceOf(e.role);
            const site = options[Math.floor(Math.random() * options.length)];
            if (site) {
                dest = this.openTileNear(site);
                if (dest) {
                    e.workBuildingId = site.id;
                    const info = BUILDING_DEFINITIONS[site.type as BuildingType];
                    e.workFaceAt = {
                        x: site.gridX + (info?.width ?? 1) / 2,
                        y: site.gridY + (info?.height ?? 1) / 2
                    };
                }
            }
        } else if (e.kind === 'villager' && Math.random() < 0.18) {
            // Pop into a building through its door for a bit.
            const enterables = structures.filter(b => ENTERABLE.has(b.type));
            const target = enterables[Math.floor(Math.random() * enterables.length)];
            if (target) {
                const door = this.doorOf(target);
                if (door) {
                    dest = door;
                    e.pendingEnterId = target.id;
                }
            }
        } else if (Math.random() < 0.45 && structures.length > 0) {
            // Visit a building — stand by its door like you work there.
            const poi = structures[Math.floor(Math.random() * structures.length)];
            dest = this.openTileNear(poi);
        } else {
            // Meander somewhere nearby.
            dest = this.openTileAt(
                e.x + (Math.random() - 0.5) * 9,
                e.y + (Math.random() - 0.5) * 9
            );
        }

        if (dest) {
            const path = PathfindingSystem.findAmbientPath(e.x, e.y, { gridX: dest.x, gridY: dest.y }, this.scene.buildings);
            if (path && path.length > 0) {
                e.path = path;
                e.state = 'walk';
                e.sitting = false;
                return;
            }
        }
        // Nowhere to go right now — stay put a little longer.
        e.pendingEnterId = undefined;
        e.workBuildingId = undefined;
        e.workFaceAt = undefined;
        e.stateUntil = time + 800 + Math.random() * 1500;
    }

    /** Slip in through the door: door swings open, villager fades inside. */
    private enterBuilding(e: LifeEntity, time: number) {
        const building = this.scene.buildings.find(b => b.id === e.pendingEnterId && b.health > 0 && !b.isDestroyed);
        e.pendingEnterId = undefined;
        if (!building) {
            e.state = 'idle';
            e.stateUntil = time + this.idleDuration(e);
            return;
        }
        // A night-time entry is bedtime: stay in until dawn releases everyone.
        const until = (this.nightMode || this.rainMode) && !e.lantern
            ? Number.POSITIVE_INFINITY
            : time + 3500 + Math.random() * 7000;
        this.hideInside(e, building, time, until);
    }

    /**
     * The one legitimate way a character leaves the map: through an open door.
     * Steps toward the doorway while fading, then waits inside until
     * `hiddenUntil` (Infinity = until calm() releases them).
     */
    private hideInside(e: LifeEntity, building: PlacedBuilding, time: number, hiddenUntil: number) {
        building.doorOpenUntil = time + DOOR_PULSE_MS;
        soundSystem.play('door');
        e.state = 'inside';
        e.insideId = building.id;
        e.hiddenUntil = hiddenUntil;
        e.path = null;
        e.speed = e.baseSpeed;
        // Step INTO the doorway (toward the building's center), not into thin air.
        const info = BUILDING_DEFINITIONS[building.type as BuildingType];
        const center = IsoUtils.cartToIso(
            building.gridX + (info?.width ?? 1) / 2,
            building.gridY + (info?.height ?? 1) / 2
        );
        const stepX = e.gfx.x + (center.x - e.gfx.x) * 0.35;
        const stepY = e.gfx.y + (center.y - e.gfx.y) * 0.35;
        this.scene.tweens.add({
            targets: e.gfx,
            x: stepX,
            y: stepY,
            alpha: 0,
            duration: 320,
            ease: 'Quad.easeIn',
            onComplete: () => e.gfx.setVisible(false)
        });
    }

    /** Step back out of the doorway. */
    private exitBuilding(e: LifeEntity, time: number) {
        const building = this.scene.buildings.find(b => b.id === e.insideId && b.health > 0 && !b.isDestroyed);
        e.insideId = undefined;
        if (building) {
            building.doorOpenUntil = time + DOOR_PULSE_MS;
            soundSystem.play('door');
            const door = this.doorOf(building);
            if (door) {
                e.x = door.x + 0.5;
                e.y = door.y + 0.5;
            }
        }
        e.state = 'idle';
        e.stateUntil = time + this.idleDuration(e);
        const resumedCargo = this.resumeCarriedChore(e, time);
        e.gfx.setVisible(true);
        e.gfx.setAlpha(0);
        this.placeGfx(e);
        this.drawEntity(e, time, resumedCargo);
        this.scene.tweens.add({ targets: e.gfx, alpha: 1, duration: 320 });
    }

    /** Face a grid point (used while working at a building or plant). */
    private faceToward(e: LifeEntity, x: number, y: number) {
        const screenDx = (x - e.x) - (y - e.y);
        e.facing = screenDx >= 0 ? 1 : -1;
    }

    /** Sparks for the builder's hammer, clippings for the farmer's hoe — on the swing beat. */
    private emitWorkEffects(e: LifeEntity, time: number) {
        if (time < (e.lastWorkFxAt ?? 0) + 640) return;
        e.lastWorkFxAt = time;
        if (!this.onScreen(e)) return;
        const pos = IsoUtils.cartToIso(e.x, e.y);
        if (Math.random() < 0.6) {
            // Positional: the clink arrives from where the work is happening.
            const spatial = this.panGainFor(pos.x, pos.y);
            if (e.role === 'builder') soundSystem.hammerTap(spatial.pan, spatial.gain);
            else soundSystem.play('snip');
        }
        const fxX = pos.x + e.facing * 8;
        const fxY = pos.y - 2;
        const color = e.role === 'builder' ? 0xffd76a : (e.role === 'farmer' || e.role === 'peasant') ? 0x6fbf5a : 0xa89a7c;
        for (let i = 0; i < 2; i++) {
            const p = this.scene.add.circle(fxX + (Math.random() - 0.5) * 4, fxY, 1.4, color, 0.9);
            p.setDepth(e.gfx.depth + 1);
            this.scene.tweens.add({
                targets: p,
                x: p.x + (Math.random() - 0.5) * 10,
                y: p.y - 4 - Math.random() * 5,
                alpha: 0,
                duration: 260 + Math.random() * 120,
                onComplete: () => p.destroy()
            });
        }
    }

    private updatePanic(e: LifeEntity, time: number, delta: number) {
        if (time < e.panicAt) return; // still reacting

        if (e.cowering) {
            // Nowhere to run: crouch on the spot until it's over. Nobody vanishes.
            if (this.onScreen(e) && (e.id + this.staggerFrame) % 3 === 0) {
                this.drawEntity(e, time, false);
            }
            return;
        }

        if (!e.path) {
            const refuge = this.findRefuge(e);
            if (refuge) {
                const door = this.doorOf(refuge);
                const path = door
                    ? PathfindingSystem.findAmbientPath(e.x, e.y, { gridX: door.x, gridY: door.y }, this.scene.buildings)
                    : null;
                if (path && path.length > 0) {
                    e.path = path;
                    e.panicRefugeId = refuge.id;
                } else {
                    e.cowering = true;
                    return;
                }
            } else {
                e.cowering = true;
                return;
            }
        }

        const arrived = this.followPath(e, delta);
        this.placeGfx(e);
        if (arrived) {
            const refuge = this.scene.buildings.find(b => b.id === e.panicRefugeId && b.health > 0 && !b.isDestroyed);
            if (refuge) {
                // Duck inside; the door closes behind them until calm() lets them out.
                this.hideInside(e, refuge, time, Number.POSITIVE_INFINITY);
            } else {
                // Their shelter was destroyed mid-run: freeze and cower.
                e.cowering = true;
            }
            return;
        }
        if (this.onScreen(e)) this.drawEntity(e, time, true);
    }

    /** Nearest standing door building; the town hall gets a strong preference. */
    private findRefuge(e: LifeEntity): PlacedBuilding | null {
        let best: PlacedBuilding | null = null;
        let bestScore = Number.POSITIVE_INFINITY;
        for (const b of this.scene.buildings) {
            if (!ENTERABLE.has(b.type) || b.health <= 0 || b.isDestroyed) continue;
            const info = BUILDING_DEFINITIONS[b.type as BuildingType];
            const cx = b.gridX + (info?.width ?? 1) / 2;
            const cy = b.gridY + (info?.height ?? 1) / 2;
            const score = Math.hypot(cx - e.x, cy - e.y) - (b.type === 'town_hall' ? 6 : 0);
            if (score < bestScore) {
                bestScore = score;
                best = b;
            }
        }
        return best;
    }

    private idleDuration(e: LifeEntity): number {
        if (e.kind === 'chicken') return 900 + Math.random() * 2200;
        if (e.kind === 'dog') return e.sitting ? 2500 + Math.random() * 3500 : 900 + Math.random() * 1800;
        return 1800 + Math.random() * 4500;
    }

    /** Two idle villagers near each other turn to face one another — instant "conversation". */
    private faceNearbyFriend(e: LifeEntity) {
        if (e.kind !== 'villager') return;
        for (const o of this.entities) {
            if (o === e || o.kind !== 'villager' || o.state !== 'idle') continue;
            const dx = o.x - e.x;
            const dy = o.y - e.y;
            if (dx * dx + dy * dy > 4) continue;
            const sdx = dx - dy; // grid direction -> screen direction
            e.facing = sdx >= 0 ? 1 : -1;
            o.facing = sdx >= 0 ? -1 : 1;
            e.stateUntil += 1500;
            break;
        }
    }

    private spawnBird() {
        const fromLeft = Math.random() < 0.5;
        const m = this.scene.mapSize;
        const e = this.spawnEntity(
            'bird',
            fromLeft ? -3 : m + 3,
            Math.random() * m
        );
        // Three species: quick fluttery sparrows, steady doves, gliding herons.
        const roll = Math.random();
        e.birdType = roll < 0.4 ? 1 : roll < 0.8 ? 0 : 2;
        const speed = e.birdType === 1 ? 0.0085 : e.birdType === 2 ? 0.0042 : 0.006;
        const angle = (Math.random() - 0.5) * 0.6;
        const dir = fromLeft ? 1 : -1;
        e.birdVX = Math.cos(angle) * speed * dir;
        e.birdVY = Math.sin(angle) * speed;
        e.facing = dir as 1 | -1;
        e.state = 'walk'; // anything but idle/gone; birds are handled separately
    }

    /** The rare one: a huge winged shadow ripples across the grass. Also summonable (D key). */
    spawnDragonShadow() {
        const fromLeft = Math.random() < 0.5;
        const m = this.scene.mapSize;
        const e = this.spawnEntity('bird', fromLeft ? -6 : m + 6, m * (0.3 + Math.random() * 0.4));
        e.birdType = 3;
        // MULTIPLY: the one closed silhouette uniformly dims everything under
        // it — buildings included — like a real shadow, in a single pass.
        e.gfx.setBlendMode(Phaser.BlendModes.MULTIPLY);
        soundSystem.play('dragon');
        unlockTrack('dragons_shadow', "Dragon's Shadow");
        const dir = fromLeft ? 1 : -1;
        const angle = (Math.random() - 0.5) * 0.35;
        e.birdVX = Math.cos(angle) * 0.0035 * dir;
        e.birdVY = Math.sin(angle) * 0.0035;
        e.facing = dir as 1 | -1;
        e.state = 'walk';
        // Something vast just blotted out the sun — everyone dives for cover
        // until the shadow has passed.
        if (this.scene.mode === 'HOME' && this.populatedFor === 'PLAYER') {
            this.dragonScare = true;
            this.panic();
        }
    }

    // -------------------------------------------------------- army figures

    private syncArmyFigures(time: number) {
        const camps = this.scene.buildings.filter(b => b.type === 'army_camp' && b.health > 0);
        const barracks = this.scene.buildings.find(b => b.type === 'barracks' && b.health > 0);
        const stations = camps.length > 0 ? camps : (barracks ? [barracks] : []);
        if (stations.length === 0) {
            for (const f of this.campFigures) f.gfx.destroy();
            this.campFigures = [];
            return;
        }

        // Reassign figures whose camp was sold/destroyed.
        const stationIds = new Set(stations.map(s => s.id));
        for (const f of this.campFigures) {
            if (!stationIds.has(f.campId)) {
                f.campId = stations[Math.floor(Math.random() * stations.length)].id;
                f.state = 'idle';
                f.idleUntil = time; // reposition on next tick
            }
        }

        const army = gameManager.getArmy();
        const desired: Array<[TroopType, number]> = [];
        let budget = MAX_CAMP_FIGURES;
        for (const [type, count] of Object.entries(army)) {
            if (!CAMP_RENDERABLE.has(type) || count <= 0 || budget <= 0) continue;
            const want = Math.min(count, budget);
            desired.push([type as TroopType, want]);
            budget -= want;
        }

        // Dismissing figures are already on their way out — they don't count.
        const haveByType = new Map<string, CampFigure[]>();
        for (const f of this.campFigures) {
            if (f.state === 'dismiss') continue;
            const list = haveByType.get(f.type) ?? [];
            list.push(f);
            haveByType.set(f.type, list);
        }

        // Troops that no longer exist (deployed/untrained) march back into the
        // barracks and leave through its door — nobody just fades into nothing.
        const wantByType = new Map(desired);
        for (const [type, figures] of haveByType) {
            const want = wantByType.get(type as TroopType) ?? 0;
            for (let i = figures.length - 1; i >= want; i--) {
                this.dismissCampFigure(figures[i], barracks);
            }
        }

        // Spawn missing ones at the barracks and march them to a camp — at most
        // two per sync so a big training batch trickles out naturally. The
        // first sync after load is the STANDING army, not fresh recruits:
        // it appears already stationed at the camps, no barracks parade.
        const firstSync = !this.armySynced;
        this.armySynced = true;
        let spawnsLeft = firstSync ? Number.POSITIVE_INFINITY : 2;
        for (const [type, want] of desired) {
            if (spawnsLeft <= 0) break;
            const have = (haveByType.get(type) ?? []).filter(f => this.campFigures.includes(f)).length;
            for (let i = have; i < want && spawnsLeft > 0; i++, spawnsLeft--) {
                this.spawnCampFigure(type, stations, barracks, time, firstSync);
            }
        }
    }

    private spawnCampFigure(type: TroopType, stations: PlacedBuilding[], barracks: PlacedBuilding | undefined, time: number, instant = false) {
        const camp = stations[Math.floor(Math.random() * stations.length)];
        const origin = (!instant && barracks) ? this.doorOf(barracks) : this.pointAround(camp);
        if (!origin) return;
        // Fresh recruit steps out through the barracks door.
        if (!instant && barracks) barracks.doorOpenUntil = time + DOOR_PULSE_MS;
        const f: CampFigure = {
            id: this.nextId++,
            type,
            gfx: this.scene.add.graphics(),
            x: origin.x,
            y: origin.y,
            path: null,
            state: 'march',
            campId: camp.id,
            facing: 1,
            speed: 0.0016,
            stagger: Math.floor(Math.random() * 3),
            idleUntil: 0,
            needsIdleDraw: true,
            marchThroughId: camp.id
        };
        const spot = this.pointAround(camp);
        f.path = (!instant && spot)
            ? PathfindingSystem.findAmbientPath(f.x, f.y, { gridX: spot.x, gridY: spot.y }, this.scene.buildings, camp.id)
            : null;
        if (!f.path || f.path.length === 0) {
            // Standing army on load, or no walkable route (fully walled
            // camp): appear at the camp directly.
            const at = spot ?? this.doorOf(camp);
            if (!at) {
                f.gfx.destroy();
                return;
            }
            f.x = at.x;
            f.y = at.y;
            f.state = 'idle';
            f.idleUntil = time + 3000 + Math.random() * 6000;
        }
        f.gfx.setScale(0.92);
        this.placeCampGfx(f);
        this.drawCampFigure(f, false);
        this.campFigures.push(f);
    }

    /** Walk back to the barracks and step in through its door (fade fallback only if it's gone). */
    private dismissCampFigure(f: CampFigure, barracks: PlacedBuilding | undefined) {
        const door = barracks ? this.doorOf(barracks) : null;
        const path = door
            ? PathfindingSystem.findAmbientPath(f.x, f.y, { gridX: door.x, gridY: door.y }, this.scene.buildings)
            : null;
        if (barracks && path && path.length > 0) {
            f.state = 'dismiss';
            f.path = path;
            f.marchThroughId = barracks.id;
            return;
        }
        // No barracks to return to — the figure has nowhere real to go; quick fade.
        this.campFigures.splice(this.campFigures.indexOf(f), 1);
        this.scene.tweens.add({ targets: f.gfx, alpha: 0, duration: 350, onComplete: () => f.gfx.destroy() });
    }

    private updateCampFigure(f: CampFigure, time: number, delta: number) {
        if (f.state === 'march' || f.state === 'shift' || f.state === 'dismiss') {
            const arrived = this.followPath(f, delta);
            this.placeCampGfx(f);
            if (arrived) {
                if (f.state === 'dismiss') {
                    // Step in through the barracks door and stand down.
                    const barracks = this.scene.buildings.find(b => b.id === f.marchThroughId && b.health > 0);
                    if (barracks) {
                        barracks.doorOpenUntil = time + DOOR_PULSE_MS;
                        const info = BUILDING_DEFINITIONS[barracks.type as BuildingType];
                        const center = IsoUtils.cartToIso(
                            barracks.gridX + (info?.width ?? 1) / 2,
                            barracks.gridY + (info?.height ?? 1) / 2
                        );
                        this.scene.tweens.add({
                            targets: f.gfx,
                            x: f.gfx.x + (center.x - f.gfx.x) * 0.35,
                            y: f.gfx.y + (center.y - f.gfx.y) * 0.35,
                            alpha: 0,
                            duration: 320,
                            ease: 'Quad.easeIn',
                            onComplete: () => f.gfx.destroy()
                        });
                    } else {
                        f.gfx.destroy();
                    }
                    this.campFigures.splice(this.campFigures.indexOf(f), 1);
                    return;
                }
                f.state = 'idle';
                f.path = null;
                f.idleUntil = time + 4000 + Math.random() * 8000;
                f.needsIdleDraw = true;
            }
            if (this.onScreenAt(f.x, f.y)) this.drawCampFigure(f, !arrived);
            return;
        }

        // Idle: fully static — drawn once, zero per-frame cost.
        if (f.needsIdleDraw) {
            f.needsIdleDraw = false;
            this.drawCampFigure(f, false);
        }
        if (time >= f.idleUntil) {
            f.idleUntil = time + 4000 + Math.random() * 8000;
            if (Math.random() < 0.45) {
                const camp = this.scene.buildings.find(b => b.id === f.campId && b.health > 0);
                const spot = camp ? this.pointAround(camp) : null;
                if (spot) {
                    const path = PathfindingSystem.findAmbientPath(f.x, f.y, { gridX: spot.x, gridY: spot.y }, this.scene.buildings, f.campId);
                    if (path && path.length > 0) {
                        f.path = path;
                        f.state = 'shift';
                    }
                }
            } else {
                // Just turn around now and then.
                f.facing = f.facing === 1 ? -1 : 1;
                f.needsIdleDraw = true;
            }
        }
    }

    private placeCampGfx(f: CampFigure) {
        const pos = IsoUtils.cartToIso(f.x, f.y);
        f.gfx.setPosition(pos.x, pos.y - this.hopOffsetOf(f));
        const depth = this.characterDepth(f.x, f.y);
        if (depth !== f.lastDepth) {
            f.lastDepth = depth;
            f.gfx.setDepth(depth);
        }
    }

    private drawCampFigure(f: CampFigure, moving: boolean) {
        f.gfx.clear();
        f.gfx.setScale(f.facing === -1 ? -0.92 : 0.92, 0.92);
        // Trained-troop figures use the SAME baked sprites as battle troops.
        if (SpriteBank.syncLooseTroop(
            this.scene, f.gfx, f.type, 'PLAYER', 1,
            f.facing === -1 ? Math.PI : 0, moving, this.scene.time.now,
            f.facing === -1
        )) return;
        TroopRenderer.drawTroopVisual(f.gfx, f.type as Parameters<typeof TroopRenderer.drawTroopVisual>[1], 'PLAYER', 0, moving, 0, 0, 0, false, 0, 1);
    }

    // ------------------------------------------------------------- helpers

    private followPath(
        e: { x: number; y: number; path: Phaser.Math.Vector2[] | null; speed: number; facing: 1 | -1; hopTile?: { x: number; y: number } },
        delta: number
    ): boolean {
        if (!e.path || e.path.length === 0) return true;
        const wp = e.path[0];
        // Heading onto a wall tile → that's a hop (visual arc applied in placeGfx).
        if (!e.hopTile && this.isWallTile(wp.x, wp.y)) {
            e.hopTile = { x: wp.x + 0.5, y: wp.y + 0.5 };
        }
        const tx = wp.x + 0.5;
        const ty = wp.y + 0.5;
        const dx = tx - e.x;
        const dy = ty - e.y;
        const dist = Math.hypot(dx, dy);
        // The bounce over the wall itself is quick; the approach is a normal walk.
        const crossing = e.hopTile !== undefined &&
            Math.hypot(e.x - e.hopTile.x, e.y - e.hopTile.y) < 0.65;
        const step = e.speed * delta * (crossing ? 3.2 : 1);
        if (dist <= Math.max(step, 0.06)) {
            e.x = tx;
            e.y = ty;
            e.path.shift();
            return e.path.length === 0;
        }
        e.x += (dx / dist) * step;
        e.y += (dy / dist) * step;
        // The crossing is over once we're clear of the wall tile.
        if (e.hopTile && Math.hypot(e.x - e.hopTile.x, e.y - e.hopTile.y) > 0.7) {
            e.hopTile = undefined;
        }
        const screenDx = dx - dy; // iso projection: screen-x sign is (dx - dy)
        if (Math.abs(screenDx) > 0.05) e.facing = screenDx >= 0 ? 1 : -1;
        return false;
    }

    private isWallTile(gx: number, gy: number): boolean {
        for (const b of this.scene.buildings) {
            if (b.type !== 'wall' || b.health <= 0 || b.isDestroyed) continue;
            if (b.gridX === gx && b.gridY === gy) return true;
        }
        return false;
    }

    /**
     * Wall crossing: the character walks flat right up to the wall's edge
     * (~0.55 tiles from its center — as close as possible without clipping),
     * then pops up and over in one quick, subtle bounce. No spin, no dust,
     * no squash — just the bounce.
     */
    private hopOffsetOf(e: { x: number; y: number; hopTile?: { x: number; y: number } }): number {
        if (!e.hopTile) return 0;
        const d = Math.hypot(e.x - e.hopTile.x, e.y - e.hopTile.y);
        if (d >= 0.55) return 0;
        return Math.cos((d / 0.55) * Math.PI / 2) * 10;
    }

    private placeGfx(e: LifeEntity, yOffset = 0) {
        const pos = IsoUtils.cartToIso(e.x, e.y);
        e.gfx.setPosition(pos.x, pos.y + yOffset - this.hopOffsetOf(e));
        const depth = e.kind === 'bird'
            // The dragon's shadow is ONE multiply pass cast over the whole
            // scene (grass, roofs, walls alike) — accurate everywhere with no
            // per-roof seams. Real birds still fly under the UI.
            ? (e.birdType === 3 ? 29_500 : 28000)
            : this.characterDepth(e.x, e.y);
        if (depth !== e.lastDepth) {
            e.lastDepth = depth;
            e.gfx.setDepth(depth);
        }
    }

    /**
     * Depth for ground characters. Walls (and buildings) have visual height,
     * so a character only counts as "in front" once their feet pass the
     * occluder's CENTER line — one tile later than the raw troop formula,
     * which flipped them in front while still walking behind a wall's top.
     * Anchor shifted a full tile back, compensated with a larger layer bonus:
     * the flip now happens at (occluder anchor + ~0.9 tiles).
     */
    private characterDepth(x: number, y: number): number {
        return Math.round(depthForTroop(x - 0.5, y - 0.5, 'warrior')) + 4;
    }

    private onScreen(e: LifeEntity): boolean {
        return this.onScreenAt(e.x, e.y);
    }

    private onScreenAt(x: number, y: number): boolean {
        const iso = IsoUtils.cartToIso(x, y);
        const view = this.scene.cameras.main.worldView;
        const pad = 120;
        return iso.x >= view.x - pad && iso.x <= view.x + view.width + pad &&
            iso.y >= view.y - pad && iso.y <= view.y + view.height + pad;
    }

    private isBlocked(gx: number, gy: number): boolean {
        if (gx < 0 || gy < 0 || gx >= this.scene.mapSize || gy >= this.scene.mapSize) return true;
        for (const b of this.scene.buildings) {
            if (b.health <= 0 || b.isDestroyed) continue;
            const info = BUILDING_DEFINITIONS[b.type as BuildingType];
            if (!info) continue;
            if (gx >= b.gridX && gx < b.gridX + info.width && gy >= b.gridY && gy < b.gridY + info.height) {
                return true;
            }
        }
        return false;
    }

    private openTileAt(x: number, y: number): { x: number; y: number } | null {
        const gx = Math.floor(x);
        const gy = Math.floor(y);
        if (!this.isBlocked(gx, gy)) return { x: gx, y: gy };
        for (let r = 1; r <= 2; r++) {
            for (let dx = -r; dx <= r; dx++) {
                for (let dy = -r; dy <= r; dy++) {
                    if (!this.isBlocked(gx + dx, gy + dy)) return { x: gx + dx, y: gy + dy };
                }
            }
        }
        return null;
    }

    /** An open tile hugging a building's edge (its "door step"). */
    private openTileNear(b: PlacedBuilding, spread = 1): { x: number; y: number } | null {
        const info = BUILDING_DEFINITIONS[b.type as BuildingType];
        if (!info) return null;
        for (let attempt = 0; attempt < 6; attempt++) {
            const side = Math.floor(Math.random() * 4);
            const along = Math.random();
            let gx: number;
            let gy: number;
            const offset = 1 + Math.floor(Math.random() * spread);
            if (side === 0) { gx = b.gridX + Math.floor(along * info.width); gy = b.gridY - offset; }
            else if (side === 1) { gx = b.gridX + Math.floor(along * info.width); gy = b.gridY + info.height + offset - 1; }
            else if (side === 2) { gx = b.gridX - offset; gy = b.gridY + Math.floor(along * info.height); }
            else { gx = b.gridX + info.width + offset - 1; gy = b.gridY + Math.floor(along * info.height); }
            if (!this.isBlocked(gx, gy)) return { x: gx, y: gy };
        }
        return null;
    }

    /** Front-center tile of a building (villagers "enter/exit" here). */
    private doorOf(b: PlacedBuilding): { x: number; y: number } | null {
        const info = BUILDING_DEFINITIONS[b.type as BuildingType];
        if (!info) return null;
        const door = { x: b.gridX + Math.floor(info.width / 2), y: b.gridY + info.height };
        if (!this.isBlocked(door.x, door.y)) return door;
        return this.openTileNear(b);
    }

    private pointAround(b: PlacedBuilding): { x: number; y: number } | null {
        return this.openTileNear(b, 2);
    }

    // ------------------------------------------------- village stories

    /** The player hoists a building: villagers nearby stop and stare. */
    onBuildingLifted(b: PlacedBuilding) {
        if (this.populatedFor !== 'PLAYER') return;
        const info = BUILDING_DEFINITIONS[b.type as BuildingType];
        const cx = b.gridX + (info?.width ?? 1) / 2;
        const cy = b.gridY + (info?.height ?? 1) / 2;
        const time = this.scene.time.now;
        for (const e of this.entities) {
            if (e.kind !== 'villager' || (e.state !== 'idle' && e.state !== 'walk')) continue;
            if (e.sleeping || e.dancing || e.haulStage || e.haulObstacleId || e.forageObstacleId || Math.hypot(e.x - cx, e.y - cy) > 5.5) continue;
            e.state = 'idle';
            e.path = null;
            e.stateUntil = Math.max(e.stateUntil, time + 2600);
            this.faceToward(e, cx, cy);
            if (this.onScreen(e)) this.drawEntity(e, time, false);
        }
    }

    /** ...and a happy little hop when it lands. */
    onBuildingPlaced(b: PlacedBuilding) {
        if (this.populatedFor !== 'PLAYER') return;
        // The cobbled lanes re-route around the new silhouette (never under
        // it), and anything alive caught beneath the footprint bolts clear.
        this.invalidateStonePaths();
        this.scatterFromFootprint(b);
        const info = BUILDING_DEFINITIONS[b.type as BuildingType];
        const cx = b.gridX + (info?.width ?? 1) / 2;
        const cy = b.gridY + (info?.height ?? 1) / 2;
        for (const e of this.entities) {
            if (e.kind !== 'villager' || e.state !== 'idle' || e.sleeping || e.dancing) continue;
            if (Math.hypot(e.x - cx, e.y - cy) > 5.5) continue;
            this.faceToward(e, cx, cy);
            this.scene.tweens.add({
                targets: e.gfx,
                y: e.gfx.y - 5,
                duration: 120,
                yoyo: true,
                delay: Math.random() * 260,
                ease: 'Quad.easeOut'
            });
        }
    }

    /**
     * A building just landed here: no chicken keeps pecking under a barracks.
     * Everything alive inside the footprint bolts out the nearest side with a
     * startled hop — the panic idiom in miniature (interrupt work cleanly,
     * brief speed burst, settle back to baseSpeed).
     */
    private scatterFromFootprint(b: PlacedBuilding) {
        const info = BUILDING_DEFINITIONS[b.type as BuildingType];
        const w = info?.width ?? 1;
        const h = info?.height ?? 1;
        const margin = 0.35;
        const time = this.scene.time.now;
        for (const e of this.entities) {
            if (e.kind === 'bird') continue; // above it all
            if (e.state === 'inside' || e.insideId) continue;
            if (e.x < b.gridX - margin || e.x > b.gridX + w + margin) continue;
            if (e.y < b.gridY - margin || e.y > b.gridY + h + margin) continue;
            // Bolt out the nearest side, a stride past the wall line.
            const push = 0.6 + Math.random() * 0.9;
            const exits = [
                { d: e.x - b.gridX, x: b.gridX - push, y: e.y },
                { d: b.gridX + w - e.x, x: b.gridX + w + push, y: e.y },
                { d: e.y - b.gridY, x: e.x, y: b.gridY - push },
                { d: b.gridY + h - e.y, x: e.x, y: b.gridY + h + push }
            ].sort((p, q) => p.d - q.d);
            let spot: { x: number; y: number } | null = null;
            for (const exit of exits) {
                spot = this.openTileAt(exit.x, exit.y);
                if (spot) break;
            }
            if (!spot) continue;
            // Interrupt whatever they were doing — same clean break as a panic.
            e.sleeping = false;
            e.sitting = false;
            e.pecking = false;
            e.workUntil = undefined;
            e.workBuildingId = undefined;
            e.workFaceAt = undefined;
            e.pendingEnterId = undefined;
            e.chattingWith = undefined;
            e.state = 'walk';
            e.stateUntil = time + 600 + Math.random() * 900;
            e.path = [new Phaser.Math.Vector2(spot.x + 0.5, spot.y + 0.5)];
            e.speed = e.baseSpeed * (e.kind === 'chicken' ? 2.6 : e.kind === 'dog' ? 2.0 : 1.6);
            this.scene.time.delayedCall(1500, () => {
                if (e.state !== 'panic') e.speed = e.baseSpeed;
            });
            this.faceToward(e, spot.x + 0.5, spot.y + 0.5);
            this.scene.tweens.add({ targets: e.gfx, y: e.gfx.y - 6, duration: 90, yoyo: true, ease: 'Quad.easeOut' });
        }
    }

    /**
     * Chance encounters: two idle villagers whose paths cross stop for a
     * chinwag — they face each other and trade little speech bubbles, and a
     * nearby dog often wanders over to listen. One new chat per scan keeps
     * it an event rather than a habit.
     */
    private updateChats(time: number) {
        if (time < this.nextChatScanAt) return;
        this.nextChatScanAt = time + 1400;
        // Sweep ended chats.
        for (const e of this.entities) {
            if (e.chattingWith !== undefined && (e.state !== 'idle' || time >= e.stateUntil)) {
                e.chattingWith = undefined;
            }
        }
        if (this.nightMode || this.panicking) return;
        const free = this.entities.filter(e =>
            e.kind === 'villager' && !e.child &&
            (e.state === 'idle' || e.state === 'walk') &&
            !e.sleeping && !e.dancing && e.workUntil === undefined &&
            !e.carryingRock && !e.carryingPack && !e.pendingEnterId &&
            !e.haulObstacleId && !e.forageObstacleId && !e.haulStage &&
            e.chattingWith === undefined && time >= (e.chatCooldownUntil ?? 0));
        for (let i = 0; i < free.length; i++) {
            for (let j = i + 1; j < free.length; j++) {
                const a = free[i];
                const b = free[j];
                if (Math.hypot(a.x - b.x, a.y - b.y) > 1.35) continue;
                const dur = 3400 + Math.random() * 2200;
                for (const [e, other] of [[a, b], [b, a]] as Array<[LifeEntity, LifeEntity]>) {
                    e.state = 'idle';
                    e.path = null;
                    e.stateUntil = time + dur;
                    e.chattingWith = other.id;
                    e.chatCooldownUntil = time + 50_000 + Math.random() * 40_000;
                    this.faceToward(e, other.x, other.y);
                }
                const dog = this.entities.find(d =>
                    d.kind === 'dog' && d.state === 'idle' && !d.sleeping &&
                    Math.hypot(d.x - a.x, d.y - a.y) < 5);
                if (dog) {
                    const mid = { x: (a.x + b.x) / 2 + 0.8, y: (a.y + b.y) / 2 + 0.5 };
                    const p = PathfindingSystem.findAmbientPath(dog.x, dog.y, { gridX: Math.floor(mid.x), gridY: Math.floor(mid.y) }, this.scene.buildings);
                    if (p && p.length > 0) {
                        dog.path = p;
                        dog.state = 'walk';
                        dog.stateUntil = time + dur;
                        dog.sitting = true;
                    }
                }
                return;
            }
        }
    }

    /** A tiny speech bubble with progressive dots, above the speaker's head. */
    private static drawChatBubble(g: Phaser.GameObjects.Graphics, phase: number) {
        const bx = 6;
        const by = -21;
        g.fillStyle(0xf5f1e6, 0.95);
        g.fillRoundedRect(bx - 5.5, by - 4, 11, 8, 2.5);
        g.fillTriangle(bx - 3, by + 3.4, bx, by + 6.4, bx + 1.5, by + 3.4);
        g.fillStyle(0x6b5138, 0.9);
        const dots = 1 + Math.floor(phase * 3);
        for (let i = 0; i < dots; i++) {
            g.fillCircle(bx - 2.6 + i * 2.6, by, 0.9);
        }
    }

    /** While the merchant trades, window-shoppers drift over for a look. */
    private updateMerchantBrowsers(time: number) {
        const mch = this.merchant;
        if (!mch || mch.state !== 'trading' || this.nightMode || this.panicking) return;
        // Idlers by the stall turn to eye the goods.
        for (const e of this.entities) {
            if (e.kind !== 'villager' || e.state !== 'idle' || e.sleeping || e.dancing || e.chattingWith !== undefined) continue;
            if (Math.hypot(e.x - mch.x, e.y - mch.y) < 2.6) this.faceToward(e, mch.x, mch.y);
        }
        if (time < this.nextBrowseAt) return;
        this.nextBrowseAt = time + 9000 + Math.random() * 7000;
        const shopper = this.entities.find(e =>
            e.kind === 'villager' && !e.child && e.state === 'idle' && !e.sleeping && !e.dancing &&
            e.workUntil === undefined && e.chattingWith === undefined &&
            Math.hypot(e.x - mch.x, e.y - mch.y) > 2.5 && Math.hypot(e.x - mch.x, e.y - mch.y) < 14);
        if (!shopper) return;
        const p = PathfindingSystem.findAmbientPath(
            shopper.x, shopper.y,
            { gridX: Math.floor(mch.x + (Math.random() < 0.5 ? -1.4 : 1.4)), gridY: Math.floor(mch.y + 1.2) },
            this.scene.buildings
        );
        if (p && p.length > 0) {
            shopper.path = p;
            shopper.state = 'walk';
            shopper.stateUntil = time + 9000;
        }
    }

    // ---- dawn chore: the elder feeds the chickens ----

    private updateElderFeeding(time: number) {
        if (this.feedSpot && time >= this.feedSpot.until) this.clearFeedSpot();
        if (this.feedSpot && time >= this.nextFeedNudgeAt && !this.panicking) {
            this.nextFeedNudgeAt = time + 1500;
            let sent = 0;
            for (const c of this.entities) {
                if (sent >= 2) break;
                if (c.kind !== 'chicken' || c.state !== 'idle' || c.sleeping) continue;
                const d = Math.hypot(c.x - this.feedSpot.x, c.y - this.feedSpot.y);
                if (d < 0.9) {
                    c.pecking = true;
                    continue;
                }
                if (d > 9) continue;
                const p = PathfindingSystem.findAmbientPath(
                    c.x, c.y,
                    { gridX: Math.floor(this.feedSpot.x + (Math.random() - 0.5) * 1.4), gridY: Math.floor(this.feedSpot.y + (Math.random() - 0.5) * 1.4) },
                    this.scene.buildings
                );
                if (p && p.length > 0) {
                    c.path = p;
                    c.state = 'walk';
                    c.stateUntil = time + 12_000;
                    sent++;
                }
            }
        }
        const plan = this.feedPlan;
        if (!plan || this.nightMode || this.rainMode || this.panicking) return;

        if (plan.stage === 'wait') {
            if (time < plan.at) return;
            const chickens = this.entities.filter(e => e.kind === 'chicken' && e.state !== 'gone');
            const feeder = this.entities.find(e =>
                e.kind === 'villager' && e.elder && e.state === 'idle' && !e.sleeping &&
                e.workUntil === undefined && !e.haulStage && !e.haulObstacleId && !e.forageObstacleId
            ) ?? this.entities.find(e =>
                e.kind === 'villager' && !e.child && e.state === 'idle' && !e.sleeping &&
                e.workUntil === undefined && !e.haulStage && !e.haulObstacleId && !e.forageObstacleId
            );
            if (chickens.length === 0 || !feeder) {
                this.feedPlan = null;
                return;
            }
            const cx = chickens.reduce((sum, c) => sum + c.x, 0) / chickens.length;
            const cy = chickens.reduce((sum, c) => sum + c.y, 0) / chickens.length;
            const spot = this.openTileAt(Math.round(cx), Math.round(cy));
            if (!spot) {
                this.feedPlan = null;
                return;
            }
            const path = PathfindingSystem.findAmbientPath(feeder.x, feeder.y, { gridX: spot.x, gridY: spot.y }, this.scene.buildings);
            if (!path || path.length === 0) {
                this.feedPlan = null;
                return;
            }
            feeder.path = path;
            feeder.state = 'walk';
            feeder.stateUntil = time + 30_000;
            plan.stage = 'walking';
            plan.elderId = feeder.id;
            plan.spot = { x: spot.x + 0.5, y: spot.y + 0.5 };
            return;
        }

        const feeder = this.entities.find(e => e.id === plan.elderId);
        if (!feeder || feeder.state === 'gone' || feeder.state === 'panic') {
            this.feedPlan = null;
            return;
        }

        if (plan.stage === 'walking') {
            if (feeder.state !== 'idle' || !plan.spot) return;
            if (Math.hypot(feeder.x - plan.spot.x, feeder.y - plan.spot.y) > 1.2) {
                // Rain/chat/panic may have replaced the walk. An idle feeder
                // elsewhere is not an arrival and must not scatter feed remotely.
                this.feedPlan = null;
                return;
            }
            // Arrived: scatter the feed in a wide arm sweep.
            feeder.workUntil = time + 4200;
            feeder.stateUntil = feeder.workUntil;
            feeder.workFaceAt = { x: plan.spot.x + 0.6, y: plan.spot.y + 0.6 };
            plan.stage = 'scattering';
            const gfx = this.scene.add.graphics();
            gfx.setDepth(4);
            const c = IsoUtils.cartToIso(plan.spot.x, plan.spot.y);
            gfx.fillStyle(0xe8d49a, 0.9);
            let sx = 17;
            for (let i = 0; i < 9; i++) {
                sx = (sx * 73 + 31) % 97;
                gfx.fillCircle(c.x + (sx / 97 - 0.5) * 34, c.y + (((sx * 7) % 53) / 53 - 0.5) * 16, 1.1);
            }
            this.feedSpot = { x: plan.spot.x, y: plan.spot.y, until: time + 17_000, gfx };
            soundSystem.play('snip');
            return;
        }

        // Scattering: once the sweep ends the chore is done — the feed stays a while.
        if (feeder.workUntil === undefined || time >= feeder.workUntil) {
            this.feedPlan = null;
        }
    }

    private clearFeedSpot() {
        if (!this.feedSpot) return;
        this.feedSpot.gfx.destroy();
        this.feedSpot = null;
    }

    // ---- festival nights at the jukebox ----

    /** Some nights the jukebox wins over bedtime: lanterns go up, and a few villagers dance. */
    private maybeStartFestival(now: number, candidates: LifeEntity[]) {
        if (this.festivalOn || this.populatedFor !== 'PLAYER') return;
        if (Math.random() > 0.45) return;
        const jukebox = this.scene.buildings.find(b => b.type === 'jukebox' && b.health > 0);
        if (!jukebox) return;
        const info = BUILDING_DEFINITIONS[jukebox.type as BuildingType];
        const spot = this.openTileAt(jukebox.gridX + (info?.width ?? 1) + 1, jukebox.gridY + (info?.height ?? 1));
        if (!spot) return;
        const dancers = candidates.filter(e =>
            !e.sleeping && e.state !== 'inside' && !this.hasActiveChore(e)
        ).slice(0, 4);
        if (dancers.length < 2) return;

        this.festivalOn = true;
        const center = { x: spot.x + 0.5, y: spot.y + 0.5 };
        dancers.forEach((e, i) => {
            const a = (i / dancers.length) * Math.PI * 2;
            const tx = center.x + Math.cos(a) * 1.1;
            const ty = center.y + Math.sin(a) * 1.1;
            const path = PathfindingSystem.findAmbientPath(e.x, e.y, { gridX: Math.floor(tx), gridY: Math.floor(ty) }, this.scene.buildings);
            e.dancing = true;
            e.workUntil = undefined;
            e.workBuildingId = undefined;
            e.workFaceAt = undefined;
            e.pendingEnterId = undefined;
            e.stateUntil = now + 3_600_000;
            if (path && path.length > 0) {
                e.path = path;
                e.state = 'walk';
            }
        });

        // Strung lanterns over the dance ground.
        this.festivalGfx?.destroy();
        const g = this.scene.add.graphics();
        g.setDepth(this.characterDepth(center.x, center.y) + 4);
        const c = IsoUtils.cartToIso(center.x, center.y);
        const poleL = { x: c.x - 46, y: c.y - 8 };
        const poleR = { x: c.x + 46, y: c.y + 8 };
        for (const pole of [poleL, poleR]) {
            g.fillStyle(0x5d4037, 1);
            g.fillRect(pole.x - 1.5, pole.y - 34, 3, 34);
            g.fillStyle(0x795548, 1);
            g.fillEllipse(pole.x, pole.y, 8, 4);
        }
        g.lineStyle(1.2, 0x3a2a1a, 0.9);
        const segs = 10;
        for (let i = 0; i < segs; i++) {
            const t0 = i / segs;
            const t1 = (i + 1) / segs;
            const sag = (t: number) => Math.sin(t * Math.PI) * 9;
            g.lineBetween(
                poleL.x + (poleR.x - poleL.x) * t0, poleL.y - 34 + (poleR.y - poleL.y) * t0 + sag(t0),
                poleL.x + (poleR.x - poleL.x) * t1, poleL.y - 34 + (poleR.y - poleL.y) * t1 + sag(t1)
            );
        }
        for (let i = 1; i < 6; i++) {
            const t = i / 6;
            const bx = poleL.x + (poleR.x - poleL.x) * t;
            const by = poleL.y - 34 + (poleR.y - poleL.y) * t + Math.sin(t * Math.PI) * 9 + 3;
            g.fillStyle(0x8a3b2e, 1);
            g.fillRect(bx - 1.6, by - 2.4, 3.2, 2);
            g.fillStyle(0xffc36a, 1);
            g.fillCircle(bx, by, 1.8);
        }
        this.festivalGfx = g;
        this.scene.dayNight.setFestivalGlow(center);
        soundSystem.play('merchant');
        gameManager.showToast('Festival night at the jukebox!');
    }

    private endFestival() {
        if (!this.festivalOn && !this.festivalGfx) return;
        this.festivalOn = false;
        this.festivalGfx?.destroy();
        this.festivalGfx = null;
        this.scene.dayNight.setFestivalGlow(null);
        const now = this.scene.time.now;
        for (const e of this.entities) {
            if (e.dancing) {
                e.dancing = false;
                e.stateUntil = now + 400 + Math.random() * 1600;
            }
        }
    }

    // ---- the storehouse thief ----

    private maybeScheduleThief(now: number) {
        this.nextThiefAt = 0;
        if (this.populatedFor !== 'PLAYER' || Math.random() > 0.4) return;
        if (!this.scene.buildings.some(b => b.type === 'storage' && b.health > 0)) return;
        this.nextThiefAt = now + 25_000 + Math.random() * 110_000;
    }

    /**
     * A hooded little critter slips in from the map edge and creeps toward
     * the storehouse in the dark, freezing mid-step, then scurrying on.
     * Tap it to send it bolting empty-handed; miss it and it makes off with
     * a sack (purely cosmetic — the server holds your real ore).
     */
    private updateThief(time: number, delta: number) {
        const t = this.thief;
        if (!t) {
            if (!this.nightMode || this.panicking || this.nextThiefAt === 0 || time < this.nextThiefAt) return;
            this.nextThiefAt = 0;
            const store = this.scene.buildings.find(b => b.type === 'storage' && b.health > 0);
            if (!store) return;
            const door = this.openTileNear(store);
            if (!door) return;
            const m = this.scene.mapSize;
            const fromLeft = Math.random() < 0.5;
            const start = { x: fromLeft ? 0.5 : m - 0.5, y: Math.random() * (m - 4) + 2 };
            const path = PathfindingSystem.findAmbientPath(start.x, start.y, { gridX: door.x, gridY: door.y }, this.scene.buildings);
            if (!path || path.length === 0) return;
            this.thief = {
                gfx: this.scene.add.graphics(),
                x: start.x,
                y: start.y,
                path,
                speed: 0.0011,
                facing: fromLeft ? 1 : -1,
                state: 'sneak',
                sack: false,
                animOffset: Math.random() * 1000
            };
            return;
        }

        // Creep-freeze-creep while sneaking; flat out when fleeing.
        const skulk = t.state === 'sneak' ? Math.max(0, 0.35 + 0.8 * Math.sin(time * 0.0035 + t.animOffset)) : 1;
        t.speed = (t.state === 'flee' ? 0.0034 : 0.0011) * Math.max(0.001, skulk);
        const arrived = this.followPath(t as unknown as LifeEntity, delta);

        if (arrived) {
            if (t.state === 'sneak') {
                // Reached the storehouse: shoulder a sack and bolt.
                t.sack = true;
                t.state = 'flee';
                const m = this.scene.mapSize;
                const edgeX = t.x < m / 2 ? 0 : m - 1;
                const path = PathfindingSystem.findAmbientPath(t.x, t.y, { gridX: edgeX, gridY: Math.max(1, Math.min(m - 2, Math.floor(t.y))) }, this.scene.buildings);
                if (path && path.length > 0) {
                    t.path = path;
                } else {
                    this.despawnThief();
                    return;
                }
            } else {
                if (t.sack) gameManager.showToast('Something small made off with a sack in the night...');
                this.despawnThief();
                return;
            }
        }

        const pos = IsoUtils.cartToIso(t.x, t.y);
        t.gfx.setPosition(pos.x, pos.y);
        t.gfx.setDepth(this.characterDepth(t.x, t.y));
        if (this.onScreenAt(t.x, t.y)) {
            VillageLifeSystem.drawThief(t.gfx, ((time + t.animOffset) % 520) / 520, t.facing, t.state === 'sneak' ? skulk : 1, t.sack);
        }
    }

    /** A tap (or dawn, or the war horn) sends the thief bolting; a nearby dog gives chase. */
    private scareThief(tapped: boolean) {
        const t = this.thief;
        if (!t) return;
        t.sack = false;
        t.state = 'flee';
        const m = this.scene.mapSize;
        const edgeX = t.x < m / 2 ? 0 : m - 1;
        const path = PathfindingSystem.findAmbientPath(t.x, t.y, { gridX: edgeX, gridY: Math.max(1, Math.min(m - 2, Math.floor(t.y))) }, this.scene.buildings);
        if (path && path.length > 0) {
            t.path = path;
        } else {
            this.despawnThief();
            return;
        }
        if (tapped) {
            this.scene.tweens.add({ targets: t.gfx, y: t.gfx.y - 8, duration: 110, yoyo: true, ease: 'Quad.easeOut' });
            gameManager.showToast('You scared off a thief!');
            soundSystem.play('tap');
            const dog = this.entities.find(d => d.kind === 'dog' && d.state !== 'gone' && Math.hypot(d.x - t.x, d.y - t.y) < 7);
            if (dog) {
                dog.sleeping = false;
                dog.sitting = false;
                const p = PathfindingSystem.findAmbientPath(dog.x, dog.y, { gridX: Math.floor(t.x), gridY: Math.floor(t.y) }, this.scene.buildings);
                if (p && p.length > 0) {
                    dog.path = p;
                    dog.state = 'walk';
                    dog.speed = dog.baseSpeed * 1.8;
                    dog.stateUntil = this.scene.time.now + 4000;
                }
            }
        }
    }

    private despawnThief() {
        if (!this.thief) return;
        this.thief.gfx.destroy();
        this.thief = null;
    }

    /** Hooded scavenger with mask eyes; hauls a sack once it has loot. */
    private static drawThief(g: Phaser.GameObjects.Graphics, phase: number, facing: 1 | -1, creep: number, sack: boolean) {
        g.clear();
        g.setScale(facing, 1);
        const scurry = Math.sin(phase * Math.PI * 2) * creep;
        // shadow
        g.fillStyle(0x000000, 0.22);
        g.fillEllipse(0, 3, 10, 3.6);
        // legs scurrying
        g.fillStyle(0x232028, 1);
        g.fillRect(-3 + scurry, -1, 2, 4);
        g.fillRect(1 - scurry, -1, 2, 4);
        // hunched hooded body
        g.fillStyle(0x2f2a33, 1);
        g.fillEllipse(0, -5, 9, 7.5);
        g.fillStyle(0x232028, 1);
        g.fillEllipse(2.5, -8.5, 6, 5);
        // mask band + eyes
        g.fillStyle(0x111014, 1);
        g.fillRect(1, -9.6, 5.4, 2.2);
        g.fillStyle(0xf5e9c8, 1);
        g.fillCircle(3, -8.6, 0.8);
        g.fillCircle(5.2, -8.6, 0.8);
        // striped tail
        g.fillStyle(0x3a3440, 1);
        g.fillEllipse(-6, -4, 6, 2.6);
        g.fillStyle(0x232028, 1);
        g.fillRect(-8, -5, 1.6, 2.4);
        if (sack) {
            g.fillStyle(0x6b5a40, 1);
            g.fillEllipse(-2, -11, 7, 5.5);
            g.lineStyle(1, 0x4a3a24, 1);
            g.lineBetween(-2, -8.5, 1, -6.5);
        }
    }

    // ------------------------------------------------------------ rendering

    private drawEntity(e: LifeEntity, time: number, moving: boolean) {
        const g = e.gfx;
        // Villagers, dogs, chickens, children — per-frame vector figures get
        // the pixel-snap layer pass until their own sprite bake lands.
        applyPixelSnap(this.scene, g);
        g.clear();
        const scale =
            e.kind === 'villager' ? (e.child ? 0.55 : 0.8) :
            e.kind === 'dog' ? 0.85 :
            e.kind === 'bird' ? (e.birdType === 3 ? DRAGON_SCALE : 0.8) :
            0.7;
        const phase = ((time + e.animOffset) % 460) / 460;
        const reacting = time < e.reactUntil && e.state !== 'panic';
        const working = e.workUntil !== undefined && time < e.workUntil && !moving;
        const workPhase = ((time + e.animOffset) % 640) / 640;
        g.setScale(e.facing === -1 ? -scale : scale, scale);
        switch (e.kind) {
            case 'villager':
                VillageLifeSystem.drawVillager(
                    g, VILLAGER_PALETTES[e.palette], e.style, phase, moving,
                    e.state === 'panic' && time >= e.panicAt, reacting,
                    e.role, working, workPhase, Boolean(e.elder),
                    Boolean(e.sleeping) && !moving, Boolean(e.lantern),
                    e.carryingRock, e.carryingPack, Boolean(e.child)
                );
                if (e.chattingWith !== undefined && e.state === 'idle' && !e.sleeping) {
                    // Partners trade the bubble back and forth.
                    const slot = e.id < e.chattingWith ? 0 : 1;
                    if (Math.floor(time / 1400) % 2 === slot) {
                        VillageLifeSystem.drawChatBubble(g, (time % 1400) / 1400);
                    }
                }
                break;
            case 'dog':
                VillageLifeSystem.drawDog(
                    g, DOG_PALETTES[e.palette], phase, moving,
                    Boolean(e.sitting) && !moving && !reacting,
                    e.state === 'panic' && time >= e.panicAt, reacting,
                    Boolean(e.sleeping) && !moving
                );
                break;
            case 'chicken':
                VillageLifeSystem.drawChicken(g, phase, moving, Boolean(e.pecking) && !moving, Boolean(e.sleeping) && !moving);
                break;
            case 'bird': {
                if (e.birdType === 3) {
                    // Rotation carries the direction; a mirror would fight it.
                    g.setScale(scale, scale);
                    VillageLifeSystem.drawDragonShadow(
                        g,
                        ((time + e.animOffset) % 1400) / 1400,
                        Math.atan2(e.birdVY ?? 0, (e.birdVX ?? 0) || 1)
                    );
                } else if (e.birdType === 1) {
                    VillageLifeSystem.drawSparrow(g, ((time + e.animOffset) % 200) / 200);
                } else if (e.birdType === 2) {
                    VillageLifeSystem.drawHeron(g, ((time + e.animOffset) % 700) / 700);
                } else {
                    VillageLifeSystem.drawBird(g, ((time + e.animOffset) % 320) / 320);
                }
                break;
            }
        }
    }

    private static drawPanicMark(g: Phaser.GameObjects.Graphics, topY: number) {
        g.fillStyle(0xd82f2f, 1);
        g.fillRect(-1, topY - 7, 2, 5);
        g.fillCircle(0, topY, 1.2);
    }

    /** Two drowsy Zs drifting up from a sleeper. */
    private static drawZzz(g: Phaser.GameObjects.Graphics, x: number, y: number, phase: number) {
        const drift = phase * 4;
        const zed = (zx: number, zy: number, s: number, a: number) => {
            g.lineStyle(1, 0xdfe6f2, a);
            g.beginPath();
            g.moveTo(zx - s, zy - s);
            g.lineTo(zx + s, zy - s);
            g.lineTo(zx - s, zy + s);
            g.lineTo(zx + s, zy + s);
            g.strokePath();
        };
        zed(x + 1, y - drift, 1.6, 0.85 * (1 - phase * 0.5));
        zed(x + 4, y - 4 - drift * 1.3, 1.1, 0.6 * (1 - phase * 0.6));
    }

    static drawVillager(
        g: Phaser.GameObjects.Graphics,
        p: { tunic: number; dark: number; hair: number; skin: number },
        style: number,
        phase: number,
        moving: boolean,
        panicked: boolean,
        cheering: boolean = false,
        role: LifeRole = 'peasant',
        working: boolean = false,
        workPhase: number = 0,
        elder: boolean = false,
        sleeping: boolean = false,
        lantern: boolean = false,
        carryingRock?: 'small' | 'large',
        carryingPack?: 'ore' | 'food',
        child: boolean = false
    ) {
        // Elders shuffle: smaller stride, gentler bob, a permanent stoop.
        const strideScale = elder ? 0.55 : 1;
        const swing = moving ? Math.sin(phase * Math.PI * 2) * 2.6 * strideScale : 0;
        const bob = moving ? Math.abs(Math.sin(phase * Math.PI * 2)) * 1.4 * strideScale : 0;
        const stoop = (elder ? 1.6 : 0) + (sleeping ? 1.8 : 0) + (working && role === 'peasant' ? 1.4 : 0); // droop when sleeping or weeding
        // Tool swing: wind up slowly, strike fast (skewed sine).
        const strike = working ? Math.pow(Math.sin(workPhase * Math.PI), 3) : 0;

        // Shadow
        g.fillStyle(0x000000, 0.22);
        g.fillEllipse(0, 11, 9, 4);

        if (style === 1) {
            // Long dress: a trapezoid skirt instead of visible legs.
            g.fillStyle(p.dark, 1);
            g.beginPath();
            g.moveTo(-3, 2 - bob);
            g.lineTo(3, 2 - bob);
            g.lineTo(4 + swing * 0.3, 10);
            g.lineTo(-4 - swing * 0.3, 10);
            g.closePath();
            g.fillPath();
        } else {
            // Legs
            g.fillStyle(0x40342a, 1);
            g.fillRect(-2.5 - swing, 4 - bob, 2, 6 + bob);
            g.fillRect(0.5 + swing, 4 - bob, 2, 6 + bob);
            // Feet
            g.fillStyle(0x2a211a, 1);
            g.fillEllipse(-1.5 - swing, 10.5, 3, 1.6);
            g.fillEllipse(1.5 + swing, 10.5, 3, 1.6);
        }

        // Produce sack riding on the back (behind the body).
        if (carryingPack) {
            const sackColor = carryingPack === 'ore' ? 0x8a8d94 : 0xc9a86a;
            const sackDark = carryingPack === 'ore' ? 0x6b6e75 : 0xa8894e;
            g.fillStyle(sackDark, 1);
            g.fillEllipse(-4.6, -3.5 - bob, 6.5, 8.5);
            g.fillStyle(sackColor, 1);
            g.fillEllipse(-4.2, -4 - bob, 5.5, 7.5);
            // Tied-off neck
            g.fillStyle(0x5c4326, 1);
            g.fillRect(-5.2, -8.6 - bob, 2.2, 1.4);
            if (carryingPack === 'ore') {
                g.fillStyle(0xffd84a, 0.9);
                g.fillCircle(-4.8, -5.5 - bob, 0.9);
            }
        }

        // Tunic body
        g.fillStyle(p.tunic, 1);
        g.fillCircle(0, -1 - bob, 5);
        g.fillStyle(p.dark, 1);
        g.fillRect(-5, 1 - bob, 10, 2);
        // Belt buckle
        g.fillStyle(0xc9a227, 1);
        g.fillRect(-1, 1 - bob, 2, 2);
        if (carryingPack) {
            // Shoulder strap holding the sack on.
            g.lineStyle(1.2, 0x5c4326, 1);
            g.lineBetween(-3.5, -5.5 - bob, 3, 0.5 - bob);
        }

        // Arms: swing while walking, thrown in the air while panicking or cheering,
        // or both up holding a hauled rock overhead.
        g.fillStyle(p.skin, 1);
        if (carryingRock) {
            g.fillRect(-5.5, -10 - bob, 2, 6);
            g.fillRect(3.5, -10 - bob, 2, 6);
            const rw = carryingRock === 'large' ? 13 : 9;
            const rh = carryingRock === 'large' ? 8 : 6;
            g.fillStyle(0x7d7f88, 1);
            g.fillEllipse(0, -14.5 - bob, rw, rh);
            g.fillStyle(0x9a9ca6, 1);
            g.fillEllipse(-1.5, -15.5 - bob, rw * 0.45, rh * 0.4);
            g.fillStyle(0x5c5f68, 1);
            g.fillEllipse(2, -13 - bob, rw * 0.3, rh * 0.3);
            g.fillStyle(p.skin, 1);
        } else if (panicked || cheering) {
            g.fillRect(-6.5, -8 - bob, 2, 6);
            g.fillRect(4.5, -8 - bob, 2, 6);
        } else if (working && role === 'peasant') {
            // Weeding: both hands reaching down into the plants.
            const reach = 1.5 + strike * 2;
            g.fillRect(-4.5, -1 - bob + reach * 0.4, 2, 4 + reach * 0.6);
            g.fillRect(2.5, -1 - bob + reach * 0.4, 2, 4 + reach * 0.6);
        } else if (working) {
            // Off hand braced on hip; tool arm handled below with the tool.
            g.fillRect(-6, -3 - bob, 2, 5);
        } else if (elder) {
            // One hand resting on a walking cane, the other tucked behind the back.
            g.fillRect(-5.5, -2 - bob, 2, 4);
            g.fillRect(4, -2 - bob + swing * 0.3, 2, 4);
            g.lineStyle(1.6, 0x6a4a2a, 1);
            g.beginPath();
            g.moveTo(5 + swing * 0.3, 1 - bob);
            g.lineTo(6 + swing * 0.6, 10);
            g.strokePath();
            g.fillStyle(0x8a6438, 1);
            g.fillCircle(5 + swing * 0.3, 0.6 - bob, 1.2); // cane knob
            g.fillStyle(p.skin, 1);
        } else {
            g.fillRect(-6, -3 - bob + swing * 0.5, 2, 5);
            g.fillRect(4, -3 - bob - swing * 0.5, 2, 5);
        }

        // Worker tools: hammer for the builder, pickaxe for the miner.
        if (role !== 'peasant') {
            const toolAngle = working
                ? -1.5 + strike * 1.9         // overhead wind-up -> strike
                : (moving ? -0.5 : -0.9);     // carried on the shoulder
            const shoulderX = 4.6;
            const shoulderY = -3 - bob;
            const handleLen = 9;
            const hx = shoulderX + Math.sin(toolAngle) * handleLen;
            const hy = shoulderY - Math.cos(toolAngle) * handleLen;
            // Arm along the handle base
            g.fillStyle(p.skin, 1);
            g.fillRect(shoulderX - 0.6, shoulderY - 0.6, 2, 4);
            // Handle
            g.lineStyle(1.6, 0x6a4a2a, 1);
            g.beginPath();
            g.moveTo(shoulderX, shoulderY);
            g.lineTo(hx, hy);
            g.strokePath();
            if (role === 'builder') {
                // Hammer head
                g.fillStyle(0x8f8f98, 1);
                g.fillRect(hx - 2.6, hy - 2, 5.2, 3.2);
            } else if (role === 'farmer') {
                // Hoe blade angled off the handle tip
                g.fillStyle(0x7d7d86, 1);
                g.fillTriangle(hx - 0.5, hy - 1, hx + 3.6, hy + 1.4, hx - 0.5, hy + 2.4);
            } else {
                // Pickaxe head (two points)
                g.fillStyle(0x7d7d86, 1);
                g.fillTriangle(hx - 4.5, hy + 0.5, hx, hy - 2.2, hx, hy + 0.8);
                g.fillTriangle(hx + 4.5, hy + 0.5, hx, hy - 2.2, hx, hy + 0.8);
            }
        }

        // Head + hair (elders stoop forward a touch; children are mostly head)
        const headX = elder ? 1 : 0;
        const headY = -8 - bob + stoop;
        g.fillStyle(p.skin, 1);
        g.fillCircle(headX, headY, child ? 4.4 : 3.6);
        if (elder) {
            // Snow-white hair and a proper beard.
            g.fillStyle(0xe8e4da, 1);
            g.beginPath();
            g.arc(headX, headY - 0.6, 3.6, Math.PI, 0, false);
            g.closePath();
            g.fillPath();
            g.fillTriangle(headX - 2.6, headY + 1.4, headX + 2.6, headY + 1.4, headX, headY + 6);
            // Bushy brows
            g.fillRect(headX - 2.6, headY - 1.4, 2, 0.9);
            g.fillRect(headX + 0.6, headY - 1.4, 2, 0.9);
        } else if (role === 'builder') {
            // Leather work cap with a little brim.
            g.fillStyle(0x9c6a30, 1);
            g.beginPath();
            g.arc(0, -8.8 - bob, 3.7, Math.PI, 0, false);
            g.closePath();
            g.fillPath();
            g.fillRect(-4.6, -9 - bob, 9.2, 1.4);
        } else if (role === 'miner') {
            // Rounded helmet with a warm lamp dot.
            g.fillStyle(0x8a8d94, 1);
            g.beginPath();
            g.arc(0, -8.8 - bob, 3.8, Math.PI, 0, false);
            g.closePath();
            g.fillPath();
            g.fillStyle(0xffd76a, 1);
            g.fillCircle(2.4, -10 - bob, 1);
        } else if (role === 'farmer') {
            // Wide-brimmed straw hat.
            g.fillStyle(0xd9b862, 1);
            g.fillEllipse(0, -9.6 - bob, 10.5, 3.2);
            g.fillStyle(0xc9a84e, 1);
            g.beginPath();
            g.arc(0, -9.8 - bob, 3, Math.PI, 0, false);
            g.closePath();
            g.fillPath();
        } else {
            g.fillStyle(p.hair, 1);
            g.beginPath();
            g.arc(0, -8.6 - bob, 3.6, Math.PI, 0, false);
            g.closePath();
            g.fillPath();
            if (style === 1) {
                // Long hair falling on one side.
                g.fillRect(2.2, -9 - bob, 1.8, 6);
            }
        }

        // Lantern on a short pole in the leading hand — the night watch's badge.
        if (lantern && !panicked && !cheering && !working) {
            const lx = 6.5;
            const ly = -1 - bob + swing * 0.4;
            g.lineStyle(1.2, 0x5a4326, 1);
            g.beginPath();
            g.moveTo(4.5, -3 - bob);
            g.lineTo(lx, ly);
            g.strokePath();
            // Little glass box with a warm flame
            g.fillStyle(0x3a3126, 1);
            g.fillRect(lx - 2, ly, 4, 5);
            g.fillStyle(0xffd76a, 0.95);
            g.fillRect(lx - 1.2, ly + 0.8, 2.4, 3.4);
            g.fillStyle(0xffe9a8, 0.35);
            g.fillCircle(lx, ly + 2.5, 5);
        }

        if (sleeping) VillageLifeSystem.drawZzz(g, 3, -14 - bob, phase);
        if (panicked) VillageLifeSystem.drawPanicMark(g, -17 - bob);
    }

    static drawDog(
        g: Phaser.GameObjects.Graphics,
        p: { fur: number; dark: number },
        phase: number,
        moving: boolean,
        sitting: boolean,
        panicked: boolean,
        excited: boolean = false,
        sleeping: boolean = false
    ) {
        const gallop = moving ? Math.sin(phase * Math.PI * 4) * 2 : 0;

        // Shadow
        g.fillStyle(0x000000, 0.22);
        g.fillEllipse(0, 10, 12, 4);

        if (sleeping) {
            // Curled into a doughnut, chin on tail, chest slowly rising.
            const breathe = Math.sin(phase * Math.PI * 2) * 0.4;
            g.fillStyle(p.fur, 1);
            g.fillEllipse(0, 5 - breathe * 0.4, 13, 7 + breathe);
            g.fillStyle(p.dark, 1);
            g.fillEllipse(-3, 6, 6, 3); // tail wrapped around
            g.fillStyle(p.fur, 1);
            g.fillCircle(4.5, 4.5, 3); // head resting low
            g.fillStyle(p.dark, 1);
            g.fillEllipse(6.8, 5.2, 2.6, 1.8); // snout tucked
            g.fillTriangle(3, 1.6, 4.4, 3.4, 2.2, 3.2); // ear
            VillageLifeSystem.drawZzz(g, 5, -6, phase);
            return;
        }

        if (sitting) {
            // Haunches + upright chest
            g.fillStyle(p.fur, 1);
            g.fillEllipse(-3, 5, 8, 7);
            g.fillEllipse(2, 2, 6, 8);
            // Front legs
            g.fillStyle(p.dark, 1);
            g.fillRect(1, 5, 1.8, 5);
            g.fillRect(3.5, 5, 1.8, 5);
            // Head
            g.fillStyle(p.fur, 1);
            g.fillCircle(3, -4, 3.4);
            g.fillStyle(p.dark, 1);
            g.fillEllipse(5.5, -3.2, 3, 2); // snout
            g.fillCircle(5.8, -3.2, 0.7);
            // Ears
            g.fillTriangle(1.4, -7, 2.8, -5.5, 0.8, -5);
            g.fillTriangle(4.6, -7.2, 5.6, -5.2, 3.4, -5.8);
            // Tail curled by the ground, wags slowly
            const wag = Math.sin(phase * Math.PI * 2) * 2;
            g.fillStyle(p.dark, 1);
            g.fillEllipse(-7, 8 + wag * 0.3, 5, 2);
        } else {
            // Body
            g.fillStyle(p.fur, 1);
            g.fillEllipse(0, 3, 12, 6);
            // Legs (gallop kick)
            g.fillStyle(p.dark, 1);
            g.fillRect(-5 - gallop * 0.6, 6, 1.8, 4.5);
            g.fillRect(-2.5 + gallop * 0.6, 6, 1.8, 4.5);
            g.fillRect(1.5 - gallop * 0.6, 6, 1.8, 4.5);
            g.fillRect(4 + gallop * 0.6, 6, 1.8, 4.5);
            // Head
            g.fillStyle(p.fur, 1);
            g.fillCircle(6.5, -1, 3.4);
            g.fillStyle(p.dark, 1);
            g.fillEllipse(9, 0, 3, 2); // snout
            g.fillCircle(9.4, -0.2, 0.7); // nose
            // Ears
            g.fillTriangle(4.8, -4.4, 6.2, -2.6, 4, -2.2);
            g.fillTriangle(7.6, -4.6, 8.8, -2.4, 6.6, -3);
            // Tail: happy wag — a blur of joy when excited.
            const wag = Math.sin(phase * Math.PI * (excited ? 12 : moving ? 6 : 2)) * (excited ? 0.9 : 0.6);
            g.lineStyle(2, p.dark, 1);
            g.beginPath();
            g.moveTo(-6, 1);
            g.lineTo(-9, -2 + wag * 3);
            g.strokePath();
            if (excited) {
                // Tongue out.
                g.fillStyle(0xe0707c, 1);
                g.fillEllipse(8.6, 1.6, 1.6, 2.4);
            }
        }

        if (panicked) VillageLifeSystem.drawPanicMark(g, -12);
    }

    static drawChicken(g: Phaser.GameObjects.Graphics, phase: number, moving: boolean, pecking: boolean, sleeping: boolean = false) {
        // Shadow
        g.fillStyle(0x000000, 0.2);
        g.fillEllipse(0, 8, 7, 3);

        if (sleeping) {
            // Roosting: puffed into a ball, head tucked into the feathers.
            const breathe = Math.sin(phase * Math.PI * 2) * 0.3;
            g.fillStyle(0xf3ecdd, 1);
            g.fillEllipse(0, 4 - breathe * 0.3, 9, 6.5 + breathe);
            g.fillStyle(0xd8cbb2, 1);
            g.fillTriangle(-4.5, 2, -7.5, -0.5, -3.6, 4.4); // tail
            g.fillStyle(0xd8402a, 1);
            g.fillRect(2.2, 0.2, 1.4, 1.4); // comb peeking out of the fluff
            VillageLifeSystem.drawZzz(g, 3, -4, phase);
            return;
        }

        const waddle = moving ? Math.sin(phase * Math.PI * 4) * 1.2 : 0;
        const headDip = pecking ? 3.5 : 0;

        // Legs
        g.lineStyle(1.2, 0xd9902a, 1);
        g.beginPath();
        g.moveTo(-1.5 - waddle * 0.4, 5);
        g.lineTo(-1.5 - waddle, 8);
        g.moveTo(1.5 + waddle * 0.4, 5);
        g.lineTo(1.5 + waddle, 8);
        g.strokePath();

        // Body
        g.fillStyle(0xf3ecdd, 1);
        g.fillEllipse(0, 3, 8, 6);
        // Tail feathers
        g.fillStyle(0xd8cbb2, 1);
        g.fillTriangle(-4, 1, -7, -2, -3.4, 3.4);
        // Wing line
        g.fillStyle(0xe2d7bf, 1);
        g.fillEllipse(-0.5, 3, 4.5, 3);

        // Head (dips to peck)
        g.fillStyle(0xf3ecdd, 1);
        g.fillCircle(3.4, -1.5 + headDip, 2.4);
        // Comb
        g.fillStyle(0xd8402a, 1);
        g.fillRect(2.7, -4.6 + headDip, 1.6, 1.6);
        // Beak
        g.fillStyle(0xe8a72e, 1);
        g.fillTriangle(5.6, -1.7 + headDip, 7.4, -1 + headDip, 5.6, -0.4 + headDip);
        // Eye
        g.fillStyle(0x1e1a14, 1);
        g.fillCircle(4, -2 + headDip, 0.5);
    }

    private static drawBird(g: Phaser.GameObjects.Graphics, phase: number) {
        const flap = Math.sin(phase * Math.PI * 2);
        // Ground shadow far below the flight height.
        g.fillStyle(0x000000, 0.12);
        g.fillEllipse(0, 58, 8, 3);
        // Body
        g.fillStyle(0x3d434d, 1);
        g.fillEllipse(0, 0, 7, 3.4);
        g.fillStyle(0x2c313a, 1);
        g.fillCircle(3.4, -0.6, 1.8);
        g.fillStyle(0xe8a72e, 1);
        g.fillTriangle(5, -0.8, 6.6, -0.3, 5, 0.2);
        // Wings
        g.fillStyle(0x2c313a, 1);
        g.fillTriangle(-1, -1, -4.5, -1 - flap * 5, 2.5, -1);
        g.fillTriangle(-1, 0.4, -5.5, 0.4 + flap * 4, 2, 0.4);
    }

    /** Small, brown, frantic — flits more than it flies. */
    private static drawSparrow(g: Phaser.GameObjects.Graphics, phase: number) {
        const flap = Math.sin(phase * Math.PI * 2);
        const flit = Math.sin(phase * Math.PI * 4) * 1.2; // busy vertical jitter
        g.fillStyle(0x000000, 0.1);
        g.fillEllipse(0, 58, 5, 2);
        // Body (warm brown, buff breast)
        g.fillStyle(0x8a6a44, 1);
        g.fillEllipse(0, flit, 4.6, 2.6);
        g.fillStyle(0xc9ae86, 1);
        g.fillEllipse(0.6, flit + 0.8, 2.6, 1.4);
        // Head + beak
        g.fillStyle(0x6e5234, 1);
        g.fillCircle(2.4, flit - 0.6, 1.4);
        g.fillStyle(0x3a2e20, 1);
        g.fillTriangle(3.6, flit - 0.8, 4.6, flit - 0.5, 3.6, flit - 0.2);
        // Stubby tail
        g.fillStyle(0x5c4630, 1);
        g.fillTriangle(-2, flit - 0.6, -4.4, flit - 1.4, -2, flit + 0.6);
        // Fast little wings
        g.fillStyle(0x5c4630, 1);
        g.fillTriangle(-0.5, flit - 0.5, -2.5, flit - 0.5 - flap * 4, 1.5, flit - 0.5);
    }

    /** Big, white, unhurried — long neck out front, legs trailing behind. */
    private static drawHeron(g: Phaser.GameObjects.Graphics, phase: number) {
        const flap = Math.sin(phase * Math.PI * 2);
        g.fillStyle(0x000000, 0.14);
        g.fillEllipse(0, 58, 13, 4);
        // Trailing legs
        g.lineStyle(1.2, 0x3a3428, 1);
        g.beginPath();
        g.moveTo(-4, 1.5);
        g.lineTo(-10, 3.4);
        g.strokePath();
        // Body
        g.fillStyle(0xe9e6dc, 1);
        g.fillEllipse(0, 0, 11, 4.4);
        // Long neck kinked back onto the shoulders, then the head
        g.lineStyle(2, 0xe9e6dc, 1);
        g.beginPath();
        g.moveTo(4, -0.6);
        g.lineTo(7.4, -2.6);
        g.strokePath();
        g.fillStyle(0xdcd8cc, 1);
        g.fillCircle(8, -3, 1.7);
        // Black crest stripe + dagger beak
        g.fillStyle(0x2c2c30, 1);
        g.fillRect(7.2, -4.4, 2.2, 0.9);
        g.fillStyle(0xd8a83e, 1);
        g.fillTriangle(9.4, -3.4, 12.4, -2.8, 9.4, -2.2);
        // Broad slow wings
        g.fillStyle(0xd2cec2, 1);
        g.fillTriangle(-2, -1.4, -8, -1.4 - flap * 7, 4, -1.4);
        g.fillStyle(0xc4c0b4, 1);
        g.fillTriangle(-2, 0.6, -9, 0.6 + flap * 5.5, 3, 0.6);
    }

    /**
     * The dragon itself is somewhere above the clouds — all you ever see is
     * its shadow sweeping across the grass. Rare enough that spotting it
     * feels like an event.
     *
     * ONE closed silhouette polygon at uniform alpha — overlapping separate
     * shapes would double-darken at every joint. Designed top-down (+x =
     * flight direction), rotated to the ground heading, then squashed 2:1 so
     * the shadow lies flat on the isometric lawn and always points exactly
     * where it is flying.
     */
    private static dragonSilhouette(phase: number): number[][] {
        const beat = Math.sin(phase * Math.PI * 2);       // slow wing beat
        const spread = 0.78 + Math.abs(beat) * 0.3;       // wings extend/contract
        const sway = Math.sin(phase * Math.PI * 4) * 1.6; // tail ripple
        const w = (ly: number) => ly * spread;

        return [
            [34, 0],                  // nose
            [27, 2.8],                // head
            [22, 7],                  // swept horn
            [23, 2.6],
            [15, 2.2],                // neck
            [9, 3.6],                 // shoulder
            [2, w(15)],               // wing leading edge
            [-9, w(28)],              // wingtip
            [-8, w(18.5)],            //   scallop
            [-13.5, w(20.5)],         // membrane finger
            [-11, w(11)],             //   scallop
            [-16, w(12)],             // membrane finger
            [-12, 4.8],               //   membrane root
            [-14, 2.6],               // hip
            [-25, 1.3 + sway * 0.4],  // tail
            [-27, 4 + sway],          // spade barb
            [-34, sway],              // tail tip
            [-27, -4 + sway],         // spade barb
            [-25, -1.3 + sway * 0.4],
            [-14, -2.6],              // mirrored left side back to the nose
            [-12, -4.8],
            [-16, -w(12)],
            [-11, -w(11)],
            [-13.5, -w(20.5)],
            [-8, -w(18.5)],
            [-9, -w(28)],
            [2, -w(15)],
            [9, -3.6],
            [15, -2.2],
            [23, -2.6],
            [22, -7],
            [27, -2.8]
        ];
    }

    private static drawDragonShadow(g: Phaser.GameObjects.Graphics, phase: number, heading: number) {
        const pts = VillageLifeSystem.dragonSilhouette(phase);
        // Grid axes sit 45 degrees from screen axes; rotate in ground space,
        // then the isometric 2:1 squash flattens the shadow onto the lawn.
        const psi = heading + Math.PI / 4;
        const cos = Math.cos(psi);
        const sin = Math.sin(psi);
        g.fillStyle(0x05070c, 0.27);
        g.beginPath();
        for (let i = 0; i < pts.length; i++) {
            const sx = pts[i][0] * cos - pts[i][1] * sin;
            const sy = (pts[i][0] * sin + pts[i][1] * cos) * 0.5;
            if (i === 0) g.moveTo(sx, sy);
            else g.lineTo(sx, sy);
        }
        g.closePath();
        g.fillPath();
    }

    // ================= weather, works & night events =================

    /** Stereo position + distance falloff for a world point, for ambient one-shots. */
    private panGainFor(screenX: number, screenY: number): { pan: number; gain: number } {
        const wv = this.scene.cameras.main.worldView;
        const pan = Math.max(-1, Math.min(1, (screenX - wv.centerX) / Math.max(1, wv.width * 0.55)));
        const dist = Math.hypot(screenX - wv.centerX, screenY - wv.centerY);
        const gain = Math.max(0.15, 1 - dist / Math.max(wv.width, 900));
        return { pan, gain };
    }

    /**
     * Rain: everyone dashes for a doorway (the night-watch keeps the beat,
     * lantern hissing in the wet); animals hunker down where they stand. When
     * it passes — and it isn't night — the village files back out.
     */
    setRain(raining: boolean) {
        if (raining === this.rainMode) return;
        this.rainMode = raining;
        if (this.populatedFor === null) return;
        const now = this.scene.time.now;
        if (raining) {
            if (this.thief && this.thief.state === 'sneak') this.scareThief(false);
            this.endFestival();
            for (const e of this.entities) {
                if (e.kind === 'bird' || e.lantern) continue;
                if (e.state === 'inside' || e.state === 'gone' || e.state === 'panic') continue;
                if (e.kind === 'villager') {
                    this.interruptChore(e);
                    e.workUntil = undefined;
                    e.workBuildingId = undefined;
                    e.workFaceAt = undefined;
                    e.pendingEnterId = undefined;
                    e.path = null;
                    e.state = 'idle';
                    e.stateUntil = now + Math.random() * 1600; // dash for shelter one by one
                } else {
                    e.sleeping = true;
                    e.sitting = e.kind === 'dog';
                    e.state = 'idle';
                    e.path = null;
                    e.stateUntil = now + 3_600_000;
                }
            }
        } else if (!this.nightMode && !this.panicking) {
            let slot = 0;
            for (const e of this.entities) {
                if (e.sleeping) {
                    e.sleeping = false;
                    e.sitting = false;
                    e.stateUntil = now + 500 + Math.random() * 2500;
                }
                if (e.state === 'inside' && e.hiddenUntil === Number.POSITIVE_INFINITY) {
                    e.hiddenUntil = now + 500 + slot * 450 + Math.random() * 300;
                    slot++;
                } else if (e.kind === 'villager' && e.state === 'idle') {
                    this.resumeCarriedChore(e, now);
                }
            }
        }
    }

    // ---- construction theatre ----

    /**
     * A new building (or a fresh upgrade) spends a short while under wooden
     * scaffolding with a builder hammering at it. Purely visual — the economy
     * settled at the save — but the village visibly BUILDS itself.
     */
    onConstruction(b: PlacedBuilding, kind: 'place' | 'upgrade') {
        if (this.populatedFor !== 'PLAYER' || this.scene.mode !== 'HOME') return;
        if (b.type === 'wall') return; // wall drags would carpet the map in scaffolds
        const info = BUILDING_DEFINITIONS[b.type as BuildingType];
        if (!info) return;
        this.clearConstructionFor(b.id);
        const gfx = this.scene.add.graphics();
        gfx.setDepth(depthForBuilding(b.gridX, b.gridY, b.type as BuildingType) + 45);
        this.drawScaffold(gfx, b, info.width, info.height, 0);
        const started = this.scene.time.now;
        const duration = kind === 'place' ? 30_000 : 20_000;
        this.constructionSites.push({
            id: `site_${b.id}`,
            buildingId: b.id,
            until: started + duration,
            duration,
            stage: 0,
            gfx,
            builderAssigned: false
        });
        // The site raises its own tag: hammer at work, live progress bar.
        const centre = IsoUtils.cartToIso(b.gridX + info.width / 2, b.gridY + info.height / 2);
        this.bubbles()?.raise({
            key: `construct_${b.id}`,
            anchor: { x: centre.x, y: centre.y - 52 - info.height * 13 },
            text: kind === 'place' ? 'BUILDING' : 'UPGRADING',
            icon: 'build-icon',
            animate: true,
            ttlMs: 0,
            progress: () => (this.scene.time.now - started) / duration
        });
    }

    /** The scene's bubble layer (typed loosely: villageLife must not import scene internals). */
    private bubbles(): { raise(spec: object): void; clear(key: string): void } | null {
        return (this.scene as unknown as { villageBubbles?: { raise(spec: object): void; clear(key: string): void } }).villageBubbles ?? null;
    }

    private clearConstructionFor(buildingId: string) {
        this.bubbles()?.clear(`construct_${buildingId}`);
        for (let i = this.constructionSites.length - 1; i >= 0; i--) {
            const site = this.constructionSites[i];
            if (site.buildingId !== buildingId) continue;
            this.releaseConstructionWorker(site.id);
            site.gfx.destroy();
            this.constructionSites.splice(i, 1);
        }
    }

    private releaseConstructionWorker(siteId: string) {
        for (const worker of this.entities) {
            if (worker.buildSiteId !== siteId) continue;
            worker.buildSiteId = undefined;
            worker.workUntil = undefined;
            worker.workBuildingId = undefined;
            worker.workFaceAt = undefined;
        }
    }

    /**
     * Wooden corner poles, plank runs, lashings and braces — raised in stages
     * as the work progresses: 0 = poles and footing with the first low run,
     * 1 = planked and braced, 2 = topping out (top run, counter-brace, walk
     * boards). Light from the NW: the SW face runs draw lit, the SE shaded.
     */
    private drawScaffold(g: Phaser.GameObjects.Graphics, b: PlacedBuilding, w: number, h: number, stage: number) {
        const POLE = 0x6e5335;
        const POLE_DARK = 0x4f3a24;
        const POLE_LIT = 0x94714a;
        const PLANK = 0x8a6a42;
        const PLANK_LIT = 0xa5814f;
        const rise = 14 + Math.max(w, h) * 7;
        const corners = [
            IsoUtils.cartToIso(b.gridX, b.gridY + h),         // W corner (left)
            IsoUtils.cartToIso(b.gridX + w, b.gridY + h),     // S corner (bottom)
            IsoUtils.cartToIso(b.gridX + w, b.gridY)          // E corner (right)
        ];
        // A board run along both camera-facing faces at a given lift: a dark
        // underside with a lit top edge, so it reads as a plank, not a wire.
        const run = (lift: number) => {
            for (let side = 0; side < 2; side++) {
                const a = corners[side];
                const c = corners[side + 1];
                g.lineStyle(2.6, POLE_DARK, 0.9);
                g.lineBetween(a.x, a.y - lift + 1.2, c.x, c.y - lift + 1.2);
                g.lineStyle(1.6, side === 0 ? PLANK_LIT : PLANK, 0.95);
                g.lineBetween(a.x, a.y - lift, c.x, c.y - lift);
            }
            // Lashings: a dark cross where the run is tied to each pole.
            g.lineStyle(1.1, POLE_DARK, 0.9);
            for (const c of corners) {
                g.lineBetween(c.x - 2.1, c.y - lift - 2.1, c.x + 2.1, c.y - lift + 2.1);
                g.lineBetween(c.x + 2.1, c.y - lift - 2.1, c.x - 2.1, c.y - lift + 2.1);
            }
        };

        // Footing: stakes at each pole and a pile of spare boards by the
        // W corner — the site reads as a working yard from the first frame.
        g.fillStyle(POLE_DARK, 0.85);
        for (const c of corners) g.fillRect(c.x - 2.6, c.y - 1, 5.2, 2.4);
        const pile = corners[0];
        g.fillStyle(PLANK, 0.95);
        g.fillRect(pile.x + 4, pile.y - 2.2, 10, 2);
        g.fillStyle(PLANK_LIT, 0.95);
        g.fillRect(pile.x + 5.5, pile.y - 4, 10, 2);

        // Corner poles: a dark core with a lit western edge and a top cap.
        for (const c of corners) {
            g.lineStyle(2.4, POLE, 0.95);
            g.lineBetween(c.x, c.y + 1, c.x, c.y - rise);
            g.lineStyle(1, POLE_LIT, 0.9);
            g.lineBetween(c.x - 1, c.y, c.x - 1, c.y - rise + 2);
            g.fillStyle(POLE_DARK, 0.95);
            g.fillRect(c.x - 1.8, c.y - rise - 1.6, 3.6, 1.8);
        }

        run(rise * 0.3);
        if (stage >= 1) {
            run(rise * 0.62);
            // Diagonal brace on the lit SW face sells the carpentry.
            g.lineStyle(1.6, POLE, 0.85);
            g.lineBetween(corners[0].x, corners[0].y - rise * 0.62, corners[1].x, corners[1].y - rise * 0.3);
        }
        if (stage >= 2) {
            run(rise * 0.92);
            // Counter-brace on the shaded face, walk boards along the top.
            g.lineStyle(1.6, POLE_DARK, 0.85);
            g.lineBetween(corners[1].x, corners[1].y - rise * 0.92, corners[2].x, corners[2].y - rise * 0.62);
            g.fillStyle(PLANK_LIT, 0.95);
            for (const c of corners) g.fillRect(c.x - 3.2, c.y - rise * 0.92 - 1.1, 6.4, 2.2);
        }
    }

    private updateConstruction(time: number) {
        for (let i = this.constructionSites.length - 1; i >= 0; i--) {
            const site = this.constructionSites[i];
            const b = this.scene.buildings.find(x => x.id === site.buildingId && x.health > 0);
            if (!b) {
                this.bubbles()?.clear(`construct_${site.buildingId}`);
                this.releaseConstructionWorker(site.id);
                site.gfx.destroy();
                this.constructionSites.splice(i, 1);
                continue;
            }
            // Summon the nearest free villager: the existing work loop makes
            // them walk over and hammer (sparks, taps, the lot).
            if (!site.builderAssigned && !this.panicking && !this.nightMode && !this.rainMode) {
                const worker = this.entities.find(e =>
                    e.kind === 'villager' && !e.child && !e.lantern && !e.buildSiteId &&
                    (e.state === 'idle' || e.state === 'walk') && !e.workUntil && !e.carryingPack && !e.carryingRock &&
                    !e.haulStage && !e.haulObstacleId && !e.forageObstacleId);
                if (worker) {
                    const spot = this.openTileNear(b, 2);
                    if (spot) {
                        const path = PathfindingSystem.findAmbientPath(worker.x, worker.y, { gridX: spot.x, gridY: spot.y }, this.scene.buildings);
                        if (path && path.length > 0) {
                            worker.buildSiteId = site.id;
                            worker.path = path;
                            worker.state = 'walk';
                            worker.workBuildingId = b.id;
                            worker.workFaceAt = { x: b.gridX + (BUILDING_DEFINITIONS[b.type as BuildingType]?.width ?? 1) / 2, y: b.gridY + (BUILDING_DEFINITIONS[b.type as BuildingType]?.height ?? 1) / 2 };
                            site.builderAssigned = true;
                        }
                    }
                }
            }
            if (time < site.until) {
                // The scaffold climbs with the work: redraw at stage changes.
                const progress = 1 - Math.max(0, (site.until - time) / site.duration);
                const stage = progress < 0.4 ? 0 : progress < 0.75 ? 1 : 2;
                if (stage !== site.stage) {
                    site.stage = stage;
                    const def = BUILDING_DEFINITIONS[b.type as BuildingType];
                    site.gfx.clear();
                    this.drawScaffold(site.gfx, b, def?.width ?? 1, def?.height ?? 1, stage);
                }
                continue;
            }
            // Topping-out: dust and a brief confetti toss, then the scaffold
            // comes down. No flagpole — the celebration is the animation.
            const info = BUILDING_DEFINITIONS[b.type as BuildingType];
            const c = IsoUtils.cartToIso(b.gridX + (info?.width ?? 1) / 2, b.gridY + (info?.height ?? 1) / 2);
            for (let d = 0; d < 6; d++) {
                const puff = this.scene.add.circle(c.x + (Math.random() - 0.5) * 18, c.y + (Math.random() - 0.5) * 8, 2.5 + Math.random() * 2, 0xc9b593, 0.5);
                puff.setDepth(site.gfx.depth + 1);
                this.scene.tweens.add({ targets: puff, y: puff.y - 8 - Math.random() * 6, alpha: 0, scale: 1.7, duration: 420 + Math.random() * 200, onComplete: () => puff.destroy() });
            }
            const CONFETTI = [0xffd700, 0xd8563c, 0x9fd0ff, 0xa7e39f, 0xefe3bb];
            const roof = c.y - 14 - (info ? Math.max(info.width, info.height) * 8 : 14);
            for (let d = 0; d < 16; d++) {
                const piece = this.scene.add.rectangle(
                    c.x + (Math.random() - 0.5) * 16,
                    roof - Math.random() * 8,
                    3, 2,
                    CONFETTI[d % CONFETTI.length], 1
                );
                piece.setDepth(site.gfx.depth + 2);
                piece.rotation = Math.random() * Math.PI;
                const fall = 850 + Math.random() * 500;
                this.scene.tweens.add({
                    targets: piece,
                    x: piece.x + (Math.random() - 0.5) * 38,
                    y: piece.y + 30 + Math.random() * 22,
                    rotation: piece.rotation + (Math.random() - 0.5) * 6,
                    duration: fall,
                    ease: 'Cubic.easeIn',
                    onComplete: () => piece.destroy()
                });
                // Full colour on the toss; fade only through the second half.
                this.scene.tweens.add({ targets: piece, alpha: 0, delay: fall * 0.5, duration: fall * 0.5 });
            }
            soundSystem.play('deposit');
            this.bubbles()?.clear(`construct_${site.buildingId}`);
            this.bubbles()?.raise({
                key: `built_${site.buildingId}`,
                anchor: { x: c.x, y: c.y - 52 - (info ? info.height * 13 : 13) },
                text: b.level && b.level > 1 ? `LEVEL ${b.level}!` : 'WORK COMPLETE!',
                icon: 'sym sym-castle',
                ttlMs: 3000
            });
            this.releaseConstructionWorker(site.id);
            site.gfx.destroy();
            this.constructionSites.splice(i, 1);
        }
        // Keep the summoned builder hammering for the site's whole life.
        for (const site of this.constructionSites) {
            const worker = this.entities.find(e => e.buildSiteId === site.id);
            if (worker && worker.state === 'idle' && worker.workBuildingId === site.buildingId) {
                worker.workUntil = Math.max(worker.workUntil ?? 0, Math.min(site.until, time + 4000));
                worker.stateUntil = worker.workUntil;
            }
        }
    }

    // ---- battle scars & the repair crew ----

    /**
     * The raid is over and it shows: a share of the buildings smoke and stand
     * scorched until villagers walk over, hammer for a bit, and put things
     * right. Damage bands come from the shield the server granted.
     */
    applyBattleScars(destructionPct: number) {
        if (this.populatedFor !== 'PLAYER' || this.scene.mode !== 'HOME') return;
        for (const scar of this.scars) scar.gfx.destroy();
        this.scars = [];
        const candidates = this.scene.buildings.filter(b => b.owner === 'PLAYER' && b.type !== 'wall' && b.health > 0);
        if (candidates.length === 0) return;
        const count = Math.max(1, Math.round(candidates.length * Math.min(0.6, destructionPct / 100) * 0.5));
        const shuffled = [...candidates].sort(() => Math.random() - 0.5).slice(0, count);
        const now = this.scene.time.now;
        shuffled.forEach((b, i) => {
            const gfx = this.scene.add.graphics();
            gfx.setDepth(depthForBuilding(b.gridX, b.gridY, b.type as BuildingType) + 46);
            this.scars.push({ buildingId: b.id, gfx, repairAt: now + 9000 + i * 22_000, repairing: false, seed: Math.floor(Math.random() * 1e6), rendered: false });
        });
    }

    private updateScars(time: number) {
        for (let i = this.scars.length - 1; i >= 0; i--) {
            const scar = this.scars[i];
            const b = this.scene.buildings.find(x => x.id === scar.buildingId && x.health > 0);
            if (!b) {
                scar.gfx.destroy();
                this.scars.splice(i, 1);
                continue;
            }
            const info = BUILDING_DEFINITIONS[b.type as BuildingType];
            const w = info?.width ?? 1;
            const h = info?.height ?? 1;
            const c = IsoUtils.cartToIso(b.gridX + w / 2, b.gridY + h / 2);
            // Repair timing below remains unconditional, but there is no need
            // to rebuild off-screen graphics every frame. Smoke resumes from
            // the deterministic current-time phase when the camera returns.
            if (this.onScreenAt(b.gridX + w / 2, b.gridY + h / 2)) {
                const depth = depthForBuilding(b.gridX, b.gridY, b.type as BuildingType) + 46;
                if (scar.gfx.depth !== depth) scar.gfx.setDepth(depth);
                scar.gfx.setVisible(true);
                scar.gfx.clear();
                const rng = (n: number) => ((scar.seed * 73 + n * 971) % 997) / 997;
                scar.gfx.fillStyle(0x2b241c, 0.34);
                scar.gfx.fillEllipse(c.x + (rng(1) - 0.5) * w * 18, c.y + 4 + (rng(2) - 0.5) * 6, 16 + w * 4, 7 + h * 1.4);
                scar.gfx.fillStyle(0x4a4038, 0.8);
                for (let r = 0; r < 3; r++) {
                    scar.gfx.fillRect(c.x + (rng(3 + r) - 0.5) * w * 22, c.y + 2 + (rng(6 + r) - 0.5) * 8, 3.4, 2.4);
                }
                const wind = windAt(b.gridX, b.gridY, time);
                for (let s = 0; s < 3; s++) {
                    const cycle = ((time * 0.00023 + s * 0.33 + rng(9 + s)) % 1);
                    const px = c.x + (rng(12 + s) - 0.5) * w * 10 + cycle * (8 + wind * 14);
                    const py = c.y - 6 - cycle * 26;
                    scar.gfx.fillStyle(0x565656, 0.30 * (1 - cycle));
                    scar.gfx.fillCircle(px, py, 2 + cycle * 3.4);
                }
                scar.rendered = true;
            } else if (scar.rendered) {
                // A building can move while its scar persists. Clear/hide the
                // old absolute drawing once so it cannot linger on-screen.
                scar.gfx.clear();
                scar.gfx.setVisible(false);
                scar.rendered = false;
            }
            // Send the repair crew when it is time (and the village is calm).
            if (!scar.repairing && time >= scar.repairAt && !this.panicking && !this.nightMode && !this.rainMode) {
                const worker = this.entities.find(e =>
                    e.kind === 'villager' && !e.child && !e.lantern && !e.buildSiteId &&
                    (e.state === 'idle' || e.state === 'walk') && !e.workUntil && !e.carryingPack && !e.carryingRock &&
                    !e.haulStage && !e.haulObstacleId && !e.forageObstacleId);
                const spot = worker ? this.openTileNear(b, 2) : null;
                if (worker && spot) {
                    const path = PathfindingSystem.findAmbientPath(worker.x, worker.y, { gridX: spot.x, gridY: spot.y }, this.scene.buildings);
                    if (path && path.length > 0) {
                        worker.path = path;
                        worker.state = 'walk';
                        worker.workBuildingId = b.id;
                        worker.workFaceAt = { x: b.gridX + w / 2, y: b.gridY + h / 2 };
                        scar.repairing = true;
                        scar.repairAt = time + 11_000; // hammering time before it heals
                    }
                } else {
                    scar.repairAt = time + 5000; // try again shortly
                }
            } else if (scar.repairing && time >= scar.repairAt) {
                // Patched up: a few bright motes and the soot is gone.
                for (let d = 0; d < 4; d++) {
                    const p = this.scene.add.circle(c.x + (Math.random() - 0.5) * 14, c.y, 1.5, 0xffe9a8, 0.9);
                    p.setDepth(scar.gfx.depth + 1);
                    this.scene.tweens.add({ targets: p, y: p.y - 9, alpha: 0, duration: 420, onComplete: () => p.destroy() });
                }
                soundSystem.play('deposit');
                scar.gfx.destroy();
                this.scars.splice(i, 1);
            }
        }
    }

    // ---- night events ----

    private updateNightEvents(time: number, delta: number) {
        const atHome = this.populatedFor === 'PLAYER' && this.scene.mode === 'HOME';
        if (!atHome) return;

        // The night watch walks a real beat around the village perimeter.
        this.updatePatrol(time);

        if (this.nightMode && !this.panicking) {
            if (this.nextOwlAt === 0) this.nextOwlAt = time + 25_000 + Math.random() * 90_000;
            if (this.nextForgeAt === 0) this.nextForgeAt = time + 40_000 + Math.random() * 120_000;
            if (this.nextWolvesAt === 0) this.nextWolvesAt = time + 30_000 + Math.random() * 150_000;
            if (!this.owl && time >= this.nextOwlAt) {
                this.nextOwlAt = time + 150_000 + Math.random() * 200_000;
                this.spawnOwl();
            }
            if (!this.forge && time >= this.nextForgeAt) {
                this.nextForgeAt = time + 260_000 + Math.random() * 240_000;
                this.startMidnightForge(time);
            }
            if (!this.wolves && time >= this.nextWolvesAt) {
                this.nextWolvesAt = time + 200_000 + Math.random() * 260_000;
                this.spawnWolves(time);
            }
        } else {
            this.nextOwlAt = 0;
            this.nextForgeAt = 0;
            this.nextWolvesAt = 0;
            if (this.forge) this.endForge();
        }

        this.updateOwl(time, delta);
        this.updateForge(time);
        this.updateWolves(time);
    }

    /** Perimeter waypoints just outside the built-up area (clamped to the map). */
    private buildPatrolRoute(): Array<{ x: number; y: number }> {
        const buildings = this.scene.buildings.filter(b => b.owner === 'PLAYER' && b.type !== 'wall');
        let minX = 9;
        let minY = 9;
        let maxX = 15;
        let maxY = 15;
        for (const b of buildings) {
            const info = BUILDING_DEFINITIONS[b.type as BuildingType];
            minX = Math.min(minX, b.gridX - 2);
            minY = Math.min(minY, b.gridY - 2);
            maxX = Math.max(maxX, b.gridX + (info?.width ?? 1) + 2);
            maxY = Math.max(maxY, b.gridY + (info?.height ?? 1) + 2);
        }
        const clampTile = (v: number) => Math.max(1, Math.min(this.scene.mapSize - 2, v));
        minX = clampTile(minX); minY = clampTile(minY); maxX = clampTile(maxX); maxY = clampTile(maxY);
        const midX = Math.floor((minX + maxX) / 2);
        const midY = Math.floor((minY + maxY) / 2);
        const raw = [
            { x: minX, y: minY }, { x: midX, y: minY }, { x: maxX, y: minY }, { x: maxX, y: midY },
            { x: maxX, y: maxY }, { x: midX, y: maxY }, { x: minX, y: maxY }, { x: minX, y: midY }
        ];
        return raw.filter(pt => !this.isBlocked(pt.x, pt.y));
    }

    private updatePatrol(time: number) {
        if (!this.nightMode) {
            this.patrolRoute = null;
            return;
        }
        const watch = this.entities.find(e => e.lantern && e.state !== 'inside' && e.state !== 'gone' && e.state !== 'panic');
        if (!watch) return;
        if (!this.patrolRoute || this.patrolRoute.length < 3) this.patrolRoute = this.buildPatrolRoute();
        if (this.patrolRoute.length < 3) return;
        // Between legs the watch pauses, lantern swinging, then moves on.
        if (watch.state === 'idle' && !watch.path && time >= watch.stateUntil - 100) {
            watch.patrolIx = ((watch.patrolIx ?? -1) + 1) % this.patrolRoute.length;
            const stop = this.patrolRoute[watch.patrolIx];
            const path = PathfindingSystem.findAmbientPath(watch.x, watch.y, { gridX: stop.x, gridY: stop.y }, this.scene.buildings);
            if (path && path.length > 0) {
                watch.path = path;
                watch.state = 'walk';
            } else {
                watch.stateUntil = time + 4000; // blocked corner; look around, retry next leg
            }
        }
    }

    /** A silent silhouette gliding over the rooftops — then two soft hoots. */
    private spawnOwl() {
        const gfx = this.scene.add.graphics();
        gfx.setDepth(30005);
        // Fly straight along an iso diagonal, like everything airborne here.
        const fromLeft = Math.random() < 0.5;
        this.owl = {
            x: fromLeft ? -3 : this.scene.mapSize + 3,
            y: Math.random() * this.scene.mapSize,
            dirX: fromLeft ? 1 : -1,
            dirY: (Math.random() - 0.5) * 0.5,
            gfx,
            bornAt: this.scene.time.now,
            hooted: false
        };
    }

    private updateOwl(time: number, delta: number) {
        const owl = this.owl;
        if (!owl) return;
        const age = time - owl.bornAt;
        const stepMs = Math.min(250, Math.max(0, delta));
        owl.x += owl.dirX * 0.0075 * stepMs;
        owl.y += owl.dirY * 0.0075 * stepMs;
        if (age > 14_000 || owl.x < -5 || owl.x > this.scene.mapSize + 5) {
            owl.gfx.destroy();
            this.owl = null;
            return;
        }
        if (!owl.hooted && age > 2500) {
            owl.hooted = true;
            const pos = IsoUtils.cartToIso(owl.x, owl.y);
            const spatial = this.panGainFor(pos.x, pos.y);
            soundSystem.owlHoot(spatial.pan, spatial.gain * 0.8);
        }
        const pos = IsoUtils.cartToIso(owl.x, owl.y);
        const g = owl.gfx;
        g.clear();
        const flap = Math.sin(time * 0.02) * 3;
        // One closed outline, iso-squashed: a moving patch of deeper night.
        g.fillStyle(0x0a0c12, 0.30);
        g.beginPath();
        g.moveTo(pos.x - 11, pos.y - flap * 0.5);
        g.lineTo(pos.x - 3.5, pos.y - 2.2);
        g.lineTo(pos.x, pos.y - 3.2);
        g.lineTo(pos.x + 3.5, pos.y - 2.2);
        g.lineTo(pos.x + 11, pos.y - flap * 0.5);
        g.lineTo(pos.x + 3.2, pos.y + 1.6);
        g.lineTo(pos.x, pos.y + 3.6);
        g.lineTo(pos.x - 3.2, pos.y + 1.6);
        g.closePath();
        g.fillPath();
    }

    /** Someone can't sleep: the barracks glows and rings with hammer blows. */
    private startMidnightForge(time: number) {
        const smithy = this.scene.buildings.find(b => b.owner === 'PLAYER' && b.health > 0 && (b.type === 'barracks' || b.type === 'lab'));
        if (!smithy) return;
        const info = BUILDING_DEFINITIONS[smithy.type as BuildingType];
        const cx = smithy.gridX + (info?.width ?? 1) / 2;
        const cy = smithy.gridY + (info?.height ?? 1) / 2;
        const until = Date.now() + 22_000;
        const lightId = this.scene.dayNight.addTransientLight({ gx: cx, gy: cy + 0.6, radius: 55, tint: 0xffb050, until });
        this.forge = { buildingId: smithy.id, until: time + 22_000, lightId, nextClinkAt: time + 600 };
    }

    private updateForge(time: number) {
        const forge = this.forge;
        if (!forge) return;
        if (time >= forge.until) {
            this.endForge();
            return;
        }
        const b = this.scene.buildings.find(x => x.id === forge.buildingId && x.health > 0);
        if (!b) {
            this.endForge();
            return;
        }
        b.doorOpenUntil = time + 800;
        if (time >= forge.nextClinkAt) {
            forge.nextClinkAt = time + 560 + Math.random() * 420;
            const info = BUILDING_DEFINITIONS[b.type as BuildingType];
            const c = IsoUtils.cartToIso(b.gridX + (info?.width ?? 1) / 2, b.gridY + (info?.height ?? 1) / 2);
            const spatial = this.panGainFor(c.x, c.y);
            soundSystem.hammerTap(spatial.pan, spatial.gain);
            // A spray of forge sparks out the doorway.
            for (let s = 0; s < 3; s++) {
                const p = this.scene.add.circle(c.x + (Math.random() - 0.5) * 6, c.y + 4, 1.2, 0xffc36a, 0.95);
                p.setDepth(depthForBuilding(b.gridX, b.gridY, b.type as BuildingType) + 47);
                this.scene.tweens.add({
                    targets: p,
                    x: p.x + (Math.random() - 0.5) * 16,
                    y: p.y - 3 - Math.random() * 8,
                    alpha: 0,
                    duration: 300 + Math.random() * 180,
                    onComplete: () => p.destroy()
                });
            }
        }
    }

    private endForge() {
        if (!this.forge) return;
        this.scene.dayNight.removeTransientLight(this.forge.lightId);
        this.forge = null;
    }

    /** Eyes at the treeline. The dog answers before they melt back into the dark. */
    private spawnWolves(time: number) {
        const side = Math.floor(Math.random() * 4);
        const t = 3 + Math.random() * (this.scene.mapSize - 6);
        const x = side === 0 ? -1.2 : side === 1 ? this.scene.mapSize + 0.2 : t;
        const y = side === 2 ? -1.2 : side === 3 ? this.scene.mapSize + 0.2 : t;
        const gfx = this.scene.add.graphics();
        gfx.setDepth(30005);
        this.wolves = { x, y, until: time + 13_000, gfx, howled: false };
    }

    private updateWolves(time: number) {
        const wolves = this.wolves;
        if (!wolves) return;
        if (time >= wolves.until) {
            wolves.gfx.destroy();
            this.wolves = null;
            return;
        }
        const pos = IsoUtils.cartToIso(wolves.x, wolves.y);
        if (!wolves.howled && time >= wolves.until - 11_000) {
            wolves.howled = true;
            const spatial = this.panGainFor(pos.x, pos.y);
            soundSystem.wolfHowl(spatial.pan, spatial.gain * 0.9);
            // The dog hears it: up, alert, a dash toward the treeline.
            const dog = this.entities.find(e => e.kind === 'dog' && e.state !== 'gone' && e.state !== 'inside');
            if (dog) {
                dog.sleeping = false;
                dog.sitting = false;
                const toward = {
                    gridX: Math.max(1, Math.min(this.scene.mapSize - 2, Math.round(wolves.x - Math.sign(wolves.x - dog.x) * 3))),
                    gridY: Math.max(1, Math.min(this.scene.mapSize - 2, Math.round(wolves.y - Math.sign(wolves.y - dog.y) * 3)))
                };
                const path = PathfindingSystem.findAmbientPath(dog.x, dog.y, toward, this.scene.buildings);
                if (path && path.length > 0) {
                    dog.path = path;
                    dog.state = 'walk';
                    dog.speed = dog.baseSpeed * 1.6;
                }
                this.scene.tweens.add({ targets: dog.gfx, y: dog.gfx.y - 5, duration: 90, yoyo: true, repeat: 2 });
            }
        }
        // Two pairs of amber eyes blinking out of the dark.
        const g = wolves.gfx;
        g.clear();
        for (let wolfIx = 0; wolfIx < 2; wolfIx++) {
            const blink = (Math.sin(time * 0.004 + wolfIx * 2.4) + 1) / 2;
            if (blink < 0.18) continue; // mid-blink
            const ox = wolfIx * 9 - 4.5;
            const oy = wolfIx * 3 - 1.5;
            const fade = Math.min(1, (wolves.until - time) / 2500);
            g.fillStyle(0xffb636, 0.75 * fade);
            g.fillCircle(pos.x + ox - 1.9, pos.y + oy, 1.05);
            g.fillCircle(pos.x + ox + 1.9, pos.y + oy, 1.05);
        }
    }


    // ================= stone paths =================
    //
    // The village gradually PAVES its important routes: thin cobbled lanes
    // (about half a tile wide) grow from the town hall to the barracks, the
    // storehouse, the mine and the farm. Fully procedural — recomputed when
    // the layout changes, persisted maturity so the paving continues where it
    // left off. Enemy villages arrive fully paved: they have lived there for
    // years. One consistent stone texture along the whole run, stones set in
    // deterministic order so the lane visibly fills in as the village ages.

    private saveStoneMaturity() {
        if (this.populatedFor !== 'PLAYER') return;
        try {
            localStorage.setItem(`clash.stones.${this.identityKey}`, String(Math.round(this.stoneMaturitySeconds)));
        } catch { /* cosmetic */ }
    }

    private loadStoneMaturity() {
        this.stoneMaturitySeconds = 0;
        if (this.populatedFor !== 'PLAYER') return;
        let local = 0;
        try {
            local = Number(localStorage.getItem(`clash.stones.${this.identityKey}`) ?? 0) || 0;
        } catch { /* cosmetic */ }
        // The SERVER owns paving age (a pure function of village age), so
        // the same lanes greet you on every device; the local count only
        // ever runs ahead of it within a session.
        const userId = (this.scene as unknown as { userId?: string }).userId ?? '';
        const server = Backend.getCachedWorld(userId)?.stoneMaturity;
        const serverSeconds = typeof server === 'number' ? Math.max(0, Math.min(1, server)) * 540 : 0;
        this.stoneMaturitySeconds = Math.max(local, serverSeconds);
    }

    /**
     * The layout changed under the lane network (building placed, moved or
     * sold): re-examine on the very next tick. Lanes the change didn't touch
     * keep their stones exactly as laid; stones now under the new footprint
     * are occluded immediately; a lane that got built over re-lays its new
     * course gradually while the abandoned course is pulled up stone by
     * stone (see the keep/re-lay logic in updateStonePaths).
     */
    invalidateStonePaths() {
        this.stoneLayoutHash = '';
        this.stoneBandSignature = ''; // occlusion may change with no band move
        this.nextStoneUpdateAt = 0;
    }

    /** A lane's own 0..1 fill — clamped by the village age; enemy lanes are done. */
    private routeMaturity(route: { laidSeconds: number; fillSeconds: number }): number {
        if (this.populatedFor !== 'PLAYER') return 1;
        return Math.min(1, this.stoneMaturity, route.laidSeconds / route.fillSeconds);
    }

    /** An abandoned course drains over ~90s: the same hash gate run backwards,
     *  so the most recently laid stones are the first the crew lifts. */
    private retireMaturity(retiring: { maturityAtRetire: number; ageSeconds: number }): number {
        return retiring.maturityAtRetire * Math.max(0, 1 - retiring.ageSeconds / 90);
    }

    /**
     * True if any part of this lane now runs under a building (footprint plus
     * a little bleed for the lane's width). The lane's own endpoints tuck into
     * the hall/target on purpose, so the caller passes those to ignore.
     */
    private routeBlocked(points: Phaser.Math.Vector2[], ignore: ReadonlySet<PlacedBuilding>): boolean {
        const pad = 0.15;
        const hit = (x: number, y: number): boolean => {
            for (const b of this.scene.buildings) {
                if (b.health <= 0 || ignore.has(b)) continue;
                const info = BUILDING_DEFINITIONS[b.type as BuildingType];
                if (!info) continue;
                if (x > b.gridX - pad && x < b.gridX + info.width + pad &&
                    y > b.gridY - pad && y < b.gridY + info.height + pad) return true;
            }
            return false;
        };
        for (let s = 0; s < points.length - 1; s++) {
            const a = points[s];
            const b = points[s + 1];
            const segLen = Phaser.Math.Distance.Between(a.x, a.y, b.x, b.y);
            const steps = Math.max(1, Math.ceil(segLen / 0.5));
            for (let i = 0; i <= steps; i++) {
                const t = i / steps;
                if (hit(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t)) return true;
            }
        }
        return false;
    }

    private updateStonePaths(time: number) {
        if (this.populatedFor === null) return;
        if (time < this.nextStoneUpdateAt) return;
        this.nextStoneUpdateAt = time + 2000;

        // The player's paving matures with real village time (~9 minutes to a
        // fully laid network); enemy villages are old — theirs is finished.
        // The same dt also advances each lane's own laying crew below.
        const dtSeconds = this.lastStoneTickAt > 0 ? (time - this.lastStoneTickAt) / 1000 : 0;
        this.lastStoneTickAt = time;
        if (this.populatedFor === 'PLAYER') {
            this.stoneMaturitySeconds += dtSeconds;
            this.stoneMaturity = Math.min(1, this.stoneMaturitySeconds / 540);
            if (time >= this.nextStoneSaveAt) {
                this.nextStoneSaveAt = time + 30_000;
                this.saveStoneMaturity();
            }
        } else {
            this.stoneMaturity = 1;
        }

        // Recompute routes when the layout changes under them.
        const hall = this.scene.buildings.find(b => b.type === 'town_hall' && b.health > 0);
        if (!hall) {
            this.stoneGfx?.clear();
            return;
        }
        const targets: PlacedBuilding[] = [];
        for (const type of ['barracks', 'storage', 'mine', 'farm'] as const) {
            let best: PlacedBuilding | null = null;
            let bestD = Infinity;
            for (const b of this.scene.buildings) {
                if (b.type !== type || b.health <= 0) continue;
                const d = Math.hypot(b.gridX - hall.gridX, b.gridY - hall.gridY);
                if (d < bestD) { bestD = d; best = b; }
            }
            if (best) targets.push(best);
        }
        const layoutHash = [hall, ...targets].map(b => `${b.type}@${b.gridX},${b.gridY}`).join('|');
        if (layoutHash !== this.stoneLayoutHash) {
            this.stoneLayoutHash = layoutHash;
            // Re-path ONLY what the layout actually broke. An untouched lane
            // keeps its object — points and age — so its stones don't move.
            // A lane that got built over (or whose endpoints moved) keeps its
            // old course as `retiring` — the buried stones are occluded at
            // draw time, the rest get pulled up gradually — while the crew
            // lays the new course at a working pace (~2 min), stone by stone.
            const previous = new Map(this.stoneRoutes.map(route => [route.key, route]));
            this.stoneRoutes = [];
            const hallInfo = BUILDING_DEFINITIONS.town_hall;
            const from = { x: hall.gridX + (hallInfo?.width ?? 3) / 2, y: hall.gridY + (hallInfo?.height ?? 3) + 0.4 };
            for (const target of targets) {
                const key = `${target.type}`;
                const anchor = `${hall.gridX},${hall.gridY}>${target.gridX},${target.gridY}`;
                const old = previous.get(key);
                if (old && old.points.length > 1 && old.anchor === anchor && !this.routeBlocked(old.points, new Set([hall, target]))) {
                    this.stoneRoutes.push(old);
                    continue;
                }
                // The abandoned course — or the one already draining — keeps
                // fading out under whatever happens next.
                const retiring = old && old.points.length > 1
                    ? { points: old.points, maturityAtRetire: this.routeMaturity(old), ageSeconds: 0 }
                    : old?.retiring;
                const info = BUILDING_DEFINITIONS[target.type as BuildingType];
                const spot = this.openTileNear(target, 1);
                const path = spot ? PathfindingSystem.findAmbientPath(from.x, from.y, { gridX: spot.x, gridY: spot.y }, this.scene.buildings) : null;
                if (!path || path.length < 2) {
                    // No way through right now: the lane has no live course,
                    // but its old stones are still pulled up one by one rather
                    // than blinking out; any layout change retries the path.
                    if (retiring) this.stoneRoutes.push({ key, anchor: 'unroutable', points: [], laidSeconds: 0, fillSeconds: 120, retiring });
                    continue;
                }
                // Anchor both ends at the buildings themselves.
                const pts = [new Phaser.Math.Vector2(from.x, from.y), ...path];
                const c = new Phaser.Math.Vector2(target.gridX + (info?.width ?? 1) / 2, target.gridY + (info?.height ?? 1) / 2);
                const last = pts[pts.length - 1];
                const toward = c.clone().subtract(last);
                const len = toward.length() || 1;
                pts.push(last.clone().add(toward.scale((len - 0.9) / len)));
                this.stoneRoutes.push({
                    key,
                    anchor,
                    points: pts,
                    // A brand-new lane joins at the village's age (as before);
                    // a re-route starts bare and fills back in briskly while
                    // its abandoned course fades out beside it.
                    laidSeconds: old ? 0 : this.stoneMaturitySeconds,
                    fillSeconds: old ? 120 : 540,
                    retiring
                });
            }
        }

        // Every lane's crew lays on; abandoned courses drain and drop away.
        for (const route of this.stoneRoutes) {
            route.laidSeconds += dtSeconds;
            if (route.retiring) {
                route.retiring.ageSeconds += dtSeconds;
                if (this.retireMaturity(route.retiring) <= 0.02) route.retiring = undefined;
            }
        }

        // Only redraw when a stone actually landed or got pulled up.
        const signature = this.stoneRoutes
            .map(route => `${Math.floor(this.routeMaturity(route) * 60)}:${route.retiring ? Math.floor(this.retireMaturity(route.retiring) * 60) : ''}`)
            .join(',');
        if (signature === this.stoneBandSignature) return;
        this.stoneBandSignature = signature;
        this.drawStonePaths();
    }

    private drawStonePaths() {
        if (!this.stoneGfx) {
            this.stoneGfx = this.scene.add.graphics();
            this.stoneGfx.setDepth(2.5); // above the baked ground, under everything alive
            // Cobbled lanes live outside the ground RT (they mature live) —
            // the pixel-snap layer pass keeps the stones in the pixel world.
            applyPixelSnap(this.scene, this.stoneGfx);
        }
        const g = this.stoneGfx;
        g.clear();
        if (this.stoneRoutes.length === 0) return;

        const m = this.scene.mapSize;

        // Stones never show under a roof: whatever course they belong to,
        // anything the layout has since covered is occluded outright.
        const solid = this.scene.buildings.filter(b => b.health > 0);
        const occluded = (x: number, y: number): boolean => {
            const pad = 0.12;
            for (const b of solid) {
                const info = BUILDING_DEFINITIONS[b.type as BuildingType];
                if (!info) continue;
                if (x > b.gridX - pad && x < b.gridX + info.width + pad &&
                    y > b.gridY - pad && y < b.gridY + info.height + pad) return true;
            }
            return false;
        };

        // The shared stone kit lays every lane (postcards use the same one,
        // so a village's paving looks identical wherever it is drawn).
        const lane = (pts: Phaser.Math.Vector2[], maturity: number) =>
            drawStoneLane(g, pts, maturity, { mapSize: m, occluded });

        for (const route of this.stoneRoutes) {
            // The abandoned course fades out while the new one grows in.
            if (route.retiring) lane(route.retiring.points, this.retireMaturity(route.retiring));
            lane(route.points, this.routeMaturity(route));
        }
    }

}
