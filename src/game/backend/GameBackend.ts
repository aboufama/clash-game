import { BUILDING_DEFINITIONS, MAP_SIZE, TROOP_DEFINITIONS, createStarterVillage, troopFoodCostOf, type BuildingType, type ObstacleType, type TroopType } from '../config/GameDefinitions';
import { resourceCapacity } from '../config/Economy';
import { adoptUpgradePolicy, type ServerUpgradePolicy } from '../config/UpgradePolicy';
import { sanitizeVillageBanner, type SerializedBuilding, type SerializedObstacle, type SerializedWorld, type VillageBanner, type VillageLifeManifest } from '../data/Models';
export type { VillageBanner, VillageLifeManifest } from '../data/Models';
import { Auth, type SessionFeatures } from './Auth';

const CACHE_PREFIX = 'clash.base.';
export interface WorldMapPlot {
  x: number;
  y: number;
  kind: 'player' | 'bot' | 'empty';
  ownerId?: string;
  username?: string;
  trophies?: number;
  seed?: number;
  underAttack?: boolean;
  attackId?: string;
  shielded?: boolean;
  /** False for permanent wilderness preserves that can be explored but not settled. */
  settleable?: boolean;
  /** Revision of the public postcard snapshot at this plot. */
  revision?: number | string;
  /** Server-computed paving age 0..1 for player plots. */
  stoneMaturity?: number;
  /** Omitted when the caller advertised the same revision in `known`. */
  world?: WorldPostcard;
}

/**
 * Compact server authority for a village's ambient residents. Animation is
 * derived locally from this stable identity and the shared server clock; the
 * population itself is never guessed when this manifest is present.
 */
/** Public, non-economic village snapshot embedded in map windows. */
export interface WorldPostcard {
  id: string;
  ownerId: string;
  username?: string;
  buildings: SerializedBuilding[];
  obstacles?: SerializedObstacle[];
  wallLevel?: number;
  lastSaveTime: number;
  revision?: number | string;
  /** Optional only for compatibility with bots and pre-manifest servers. */
  life?: VillageLifeManifest;
  /** Owner-chosen heraldry; omitted means first-run banner setup is required. */
  banner?: VillageBanner;
}

export interface WorldMapWindow {
  plots: WorldMapPlot[];
  me: { x: number; y: number; shieldUntil?: number };
  serverNow: number;
  /** Durable generated-village presentation epoch (development reseeds only). */
  seedVersion?: number;
}

export interface RelocateResult {
  me: { x: number; y: number; plotVersion?: number };
  serverNow: number;
}

const SAVE_DEBOUNCE_MS = 400;
const SAVE_RETRY_BASE_MS = 800;
const SAVE_RETRY_MAX_MS = 12_000;
const API_REQUEST_TIMEOUT_MS = 10_000;
const FRAME_FLUSH_MS = 350;
const FRAME_FLUSH_COUNT = 4;
const FRAME_SEND_ATTEMPTS = 3;
const ARMY_BATCH_DEBOUNCE_MS = 90;

type ResourceDeltaResult = { applied: boolean; gold: number; revision?: number };

export type KnownMapPlot = {
  ownerId: string;
  revision: number | string;
};

type AuthorityFields = {
  gold?: number;
  ore?: number;
  food?: number;
  revision?: number;
  army?: Record<string, number>;
  trophies?: number;
};

type ApiErrorPayload = {
  error?: string;
  code?: string;
  currentRevision?: number;
  world?: SerializedWorld;
  resource?: string;
};

type BackendApiError = Error & ApiErrorPayload & { status?: number };

export type AttackNotification = {
  id: string;
  kind?: 'attack' | 'admin_notice';
  attackId?: string;
  attackerId?: string;
  attackerName: string;
  title?: string;
  message?: string;
  severity?: 'info' | 'warning' | 'critical';
  goldLost?: number;
  oreLost?: number;
  foodLost?: number;
  destruction: number;
  trophyDelta?: number;
  timestamp: number;
  read: boolean;
  replayAvailable?: boolean;
};

export type LeaderboardPlayer = {
  id: string;
  username: string;
  trophies: number;
  buildingCount: number;
  lastSeen: number;
  online: boolean;
  plotX: number;
  plotY: number;
  inScoutRange: boolean;
};

export type ReplayBuildingSnapshot = {
  id: string;
  health: number;
  isDestroyed: boolean;
};

export type ReplayTroopSnapshot = {
  id: string;
  type: string;
  level: number;
  owner: 'PLAYER' | 'ENEMY';
  gridX: number;
  gridY: number;
  visualOffsetY?: number;
  health: number;
  maxHealth: number;
  facingAngle?: number;
  hasTakenDamage?: boolean;
};

export type ReplayFrameSnapshot = {
  t: number;
  destruction: number;
  goldLooted: number;
  oreLooted?: number;
  foodLooted?: number;
  buildings: ReplayBuildingSnapshot[];
  troops: ReplayTroopSnapshot[];
};

export type IncomingAttackSession = {
  attackId: string;
  attackerId: string;
  attackerName: string;
  victimId: string;
  startedAt: number;
  updatedAt: number;
};

export type AttackReplayState = {
  attackId: string;
  attackerId: string;
  attackerName: string;
  victimId: string;
  victimName?: string;
  status: 'live' | 'finished' | 'aborted';
  startedAt: number;
  updatedAt: number;
  endedAt?: number;
  /** Present on full fetches; incremental (afterT) polls omit it. */
  enemyWorld?: SerializedWorld;
  finalResult?: {
    destruction: number;
    goldLooted: number;
  };
  frameCount: number;
  latestFrame: ReplayFrameSnapshot | null;
  frames?: ReplayFrameSnapshot[];
};

export type StartedAttack = {
  attackId: string;
  world: SerializedWorld;
  /** Immutable attacker army captured by the server-side reservation. */
  reservedArmy: Record<string, number>;
  lootCap: number;
  lootCapOre?: number;
  lootCapFood?: number;
  /** Canonical world placement used by both nearby and matchmade attacks. */
  target: {
    worldId: string;
    x: number;
    y: number;
    plotVersion: number;
  };
  /** Presentation window returned with the authoritative start, avoiding a
   * second map round-trip before the battle can be shown. */
  focusWindow?: WorldMapWindow;
};

export type MatchmakingOptions = {
  /**
   * SOFT repeat-avoidance: the last presented player base. The server skips
   * it when another candidate exists but may reuse it in a one-opponent world.
   */
  excludeTargetId?: string;
  /**
   * STRICT NEXT-cycling exclusions: every base already offered this session
   * (bounded to 64, oldest dropped). The server never returns these; an
   * exhausted pool answers 404 MATCH_POOL_EXHAUSTED.
   */
  excludeTargetIds?: string[];
};

/**
 * Matchmaking outcome: a started attack, `'no-players'` when the server
 * reports an empty or exhausted player pool (the caller should fall back to
 * bot camps), or null for transient failures.
 */
export type MatchmakeAttempt = StartedAttack | 'no-players' | null;

export type AttackEndResult = {
  lootApplied: number;
  oreApplied?: number;
  foodApplied?: number;
  attackerBalance: number;
  attackerOre?: number;
  attackerFood?: number;
  trophyDelta?: number;
  attackerTrophies?: number;
  revision?: number;
  /** The attacker's army after server-side battle consumption. */
  army?: Record<string, number>;
};

export type ArmyTransactionResult = {
  army: Record<string, number>;
  gold: number;
  ore: number;
  food: number;
  revision: number;
  world?: SerializedWorld;
};

export type ArmyBatchOperation = {
  kind: 'train' | 'untrain';
  type: string;
  count: number;
};

type QueuedArmyOperation = ArmyBatchOperation & { readonly id: number };

export type MerchantTradeResult = {
  applied: boolean;
  offerId: number;
  gold: number;
  ore: number;
  food: number;
  revision: number;
};

export type BotSettleResult = {
  lootApplied: number;
  attackerBalance: number;
  army: Record<string, number>;
  revision?: number;
};

export type StartedBotRaid = {
  raidId: string;
  x: number;
  y: number;
  seed: number;
  world: SerializedWorld;
  /** Immutable attacker army captured by the server-side reservation. */
  reservedArmy: Record<string, number>;
  expiresAt: number;
  /** Presentation window returned with the authoritative start. */
  focusWindow?: WorldMapWindow;
};

export type HomeSyncResponse = {
  serverNow: number;
  world: { revision: number; lastSaveTime: number };
  shieldUntil: number;
  incomingAttack: IncomingAttackSession | null;
  features: SessionFeatures;
  upgradePolicy: ServerUpgradePolicy;
};

export type TestModeAnnouncementClaimResult = {
  show: boolean;
  activationId: string;
};

export type IntroBattleCompletionResult = {
  ok: true;
  introBattleRequired: false;
};

export type WatchtowerPlacementResult = {
  world: SerializedWorld;
  watchtowerPlacementRequired: false;
};

type RememberedBattle =
  | { kind: 'pvp'; attackId: string }
  | {
      kind: 'bot';
      raidId: string;
      x: number;
      y: number;
      settle?: {
        requestId: string;
        destruction: number;
        deployed: Record<string, number>;
      };
    };

type PendingBattleStart =
  | {
      kind: 'pvp-start';
      requestId: string;
      matchmade: boolean;
      targetId?: string;
      excludeTargetId?: string;
      excludeTargetIds?: string[];
    }
  | { kind: 'bot-start'; requestId: string; x?: number; y?: number; excludeCampKeys?: string[] };

type ServerActiveBattle =
  | {
      kind: 'pvp';
      attackId: string;
      startedAt: number;
      updatedAt: number;
      hasDeployments: boolean;
      ownedByCurrentSession: boolean;
    }
  | {
      kind: 'bot';
      raidId: string;
      x: number;
      y: number;
      startedAt: number;
      expiresAt: number;
      ownedByCurrentSession: boolean;
    };

type RememberedBattleRecord = {
  battle: RememberedBattle;
  ownerTabId: string;
  heartbeatAt: number;
};

type PendingBattleStartRecord = {
  pending: PendingBattleStart;
  ownerTabId: string;
  heartbeatAt: number;
};

const ACTIVE_BATTLE_PREFIX = 'clash.active-battle.';
const PENDING_BATTLE_START_PREFIX = 'clash.pending-battle-start.';
const BATTLE_HEARTBEAT_MS = 5_000;
const BATTLE_OWNER_STALE_MS = 20_000;

function getCacheKey(userId: string) {
  return `${CACHE_PREFIX}${userId}`;
}

function randomId(prefix = 'b_') {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `${prefix}${crypto.randomUUID()}`;
  }
  return `${prefix}${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function makeRequestId(prefix: string) {
  return randomId(`${prefix}_`);
}

function activeBattleKey(userId: string) {
  return `${ACTIVE_BATTLE_PREFIX}${userId}`;
}

function pendingBattleStartKey(userId: string) {
  return `${PENDING_BATTLE_START_PREFIX}${userId}`;
}

let memoryTabId = '';
function currentBattleTabId(): string {
  if (memoryTabId) return memoryTabId;
  if (typeof window === 'undefined') return 'server';
  // sessionStorage is copied when a tab is duplicated. Persisting this id
  // there made the duplicate look like the original owner and allowed it to
  // abort a live raid during boot recovery. A document-scoped id is unique;
  // after a true reload recovery waits for the old 20s heartbeat lease.
  return (memoryTabId = makeRequestId('page'));
}

function parseRememberedBattle(value: unknown): RememberedBattle | null {
  if (!value || typeof value !== 'object') return null;
  const parsed = value as Partial<RememberedBattle>;
  if (parsed.kind === 'pvp' && typeof parsed.attackId === 'string' && parsed.attackId) {
    return { kind: 'pvp', attackId: parsed.attackId };
  }
  if (parsed.kind === 'bot'
    && typeof parsed.raidId === 'string' && parsed.raidId
    && Number.isInteger(parsed.x) && Number.isInteger(parsed.y)) {
    const settle = parsed.settle;
    return {
      kind: 'bot',
      raidId: parsed.raidId,
      x: Number(parsed.x),
      y: Number(parsed.y),
      ...(settle
        && typeof settle.requestId === 'string'
        && Number.isFinite(Number(settle.destruction))
        && settle.deployed
        && typeof settle.deployed === 'object'
        ? {
            settle: {
              requestId: settle.requestId,
              destruction: Math.max(0, Math.min(100, Number(settle.destruction))),
              deployed: { ...settle.deployed }
            }
          }
        : {})
    };
  }
  return null;
}

function readRememberedBattleRecord(userId: string): RememberedBattleRecord | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(activeBattleKey(userId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<RememberedBattleRecord> & { kind?: unknown };
    const battle = parseRememberedBattle(parsed.battle ?? parsed);
    if (!battle) return null;
    // Bare pre-lease records are immediately recoverable by the current tab.
    return {
      battle,
      ownerTabId: typeof parsed.ownerTabId === 'string' ? parsed.ownerTabId : '',
      heartbeatAt: Number(parsed.heartbeatAt) || 0
    };
  } catch {
    // Storage-blocked browsers still keep the live in-memory scene state.
  }
  return null;
}

function readRememberedBattle(userId: string): RememberedBattle | null {
  return readRememberedBattleRecord(userId)?.battle ?? null;
}

function rememberBattle(userId: string, battle: RememberedBattle) {
  if (typeof window === 'undefined') return;
  try {
    const record: RememberedBattleRecord = {
      battle,
      ownerTabId: currentBattleTabId(),
      heartbeatAt: Date.now()
    };
    window.localStorage.setItem(activeBattleKey(userId), JSON.stringify(record));
  } catch {
    // Best-effort crash recovery only; the server still expires orphaned sessions.
  }
}

function forgetBattle(userId: string, predicate?: (battle: RememberedBattle) => boolean) {
  if (typeof window === 'undefined') return;
  try {
    const remembered = readRememberedBattle(userId);
    if (!predicate || !remembered || predicate(remembered)) {
      window.localStorage.removeItem(activeBattleKey(userId));
    }
  } catch {
    // Storage unavailable.
  }
}

const lastBattleHeartbeatWrite = new Map<string, number>();
function heartbeatBattle(userId: string) {
  if (typeof window === 'undefined') return;
  const now = Date.now();
  if (now - (lastBattleHeartbeatWrite.get(userId) ?? 0) < BATTLE_HEARTBEAT_MS) return;
  // Throttle the probe itself, not just successful writes: HOME mode calls
  // this cheaply every frame so road sessions are covered before ATTACK mode.
  lastBattleHeartbeatWrite.set(userId, now);
  const ownerTabId = currentBattleTabId();
  const record = readRememberedBattleRecord(userId);
  const pending = readPendingBattleStartRecord(userId);
  if ((!record || record.ownerTabId !== ownerTabId)
    && (!pending || pending.ownerTabId !== ownerTabId)) return;
  try {
    if (record?.ownerTabId === ownerTabId) {
      window.localStorage.setItem(activeBattleKey(userId), JSON.stringify({ ...record, heartbeatAt: now }));
    }
    if (pending?.ownerTabId === ownerTabId) {
      window.localStorage.setItem(pendingBattleStartKey(userId), JSON.stringify({ ...pending, heartbeatAt: now }));
    }
  } catch {
    // Best effort.
  }
}

function rememberPendingBattleStart(userId: string, pending: PendingBattleStart) {
  if (typeof window === 'undefined') return;
  try {
    const record: PendingBattleStartRecord = {
      pending,
      ownerTabId: currentBattleTabId(),
      heartbeatAt: Date.now()
    };
    window.localStorage.setItem(pendingBattleStartKey(userId), JSON.stringify(record));
  } catch {
    // Best effort; in-call retries still use the stable id.
  }
}

function parsePendingBattleStart(value: unknown): PendingBattleStart | null {
  if (!value || typeof value !== 'object') return null;
  const parsed = value as {
    kind?: unknown;
    requestId?: unknown;
    matchmade?: unknown;
    targetId?: unknown;
    excludeTargetId?: unknown;
    excludeTargetIds?: unknown;
    excludeCampKeys?: unknown;
    x?: unknown;
    y?: unknown;
  };
  if (parsed.kind === 'pvp-start' && typeof parsed.requestId === 'string' && parsed.requestId) {
    const excludeTargetIds = Array.isArray(parsed.excludeTargetIds)
      ? parsed.excludeTargetIds.filter((id): id is string => typeof id === 'string' && id.length > 0).slice(-64)
      : [];
    return {
      kind: 'pvp-start',
      requestId: parsed.requestId,
      matchmade: Boolean(parsed.matchmade),
      ...(typeof parsed.targetId === 'string' && parsed.targetId ? { targetId: parsed.targetId } : {}),
      ...(typeof parsed.excludeTargetId === 'string' && parsed.excludeTargetId
        ? { excludeTargetId: parsed.excludeTargetId }
        : {}),
      ...(excludeTargetIds.length > 0 ? { excludeTargetIds } : {})
    };
  }
  if (parsed.kind === 'bot-start' && typeof parsed.requestId === 'string' && parsed.requestId) {
    const hasCoords = Number.isInteger(parsed.x) && Number.isInteger(parsed.y);
    const excludeCampKeys = Array.isArray(parsed.excludeCampKeys)
      ? parsed.excludeCampKeys
        .filter((key): key is string => typeof key === 'string' && /^-?\d+,-?\d+$/.test(key))
        .slice(-64)
      : [];
    return {
      kind: 'bot-start',
      requestId: parsed.requestId,
      ...(hasCoords ? { x: Number(parsed.x), y: Number(parsed.y) } : {}),
      ...(excludeCampKeys.length > 0 ? { excludeCampKeys } : {})
    };
  }
  return null;
}

function readPendingBattleStartRecord(userId: string): PendingBattleStartRecord | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(pendingBattleStartKey(userId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as {
      pending?: unknown;
      ownerTabId?: unknown;
      heartbeatAt?: unknown;
      kind?: unknown;
    };
    // Accept the short-lived pre-owner format so a user who upgrades while a
    // response is in flight can still recover it. A zero heartbeat makes it
    // immediately eligible for takeover.
    const pending = parsePendingBattleStart(parsed.pending ?? parsed);
    if (!pending) return null;
    return {
      pending,
      ownerTabId: typeof parsed.ownerTabId === 'string' ? parsed.ownerTabId : '',
      heartbeatAt: Number(parsed.heartbeatAt) || 0
    };
  } catch {
    // Storage unavailable.
  }
  return null;
}

function readPendingBattleStart(userId: string): PendingBattleStart | null {
  return readPendingBattleStartRecord(userId)?.pending ?? null;
}

function ownedByAnotherLiveTab(record: { ownerTabId: string; heartbeatAt: number }): boolean {
  return Boolean(record.ownerTabId)
    && record.ownerTabId !== currentBattleTabId()
    && Date.now() - record.heartbeatAt < BATTLE_OWNER_STALE_MS;
}

function forgetPendingBattleStart(userId: string) {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.removeItem(pendingBattleStartKey(userId));
  } catch {
    // Storage unavailable.
  }
}

function cloneWorld(world: SerializedWorld): SerializedWorld {
  return {
    ...world,
    buildings: world.buildings.map(building => ({ ...building })),
    obstacles: world.obstacles?.map(obstacle => ({ ...obstacle })),
    resources: { ...world.resources },
    storage: world.storage ? { ...world.storage } : undefined,
    population: world.population ? {
      ...world.population,
      bornAt: world.population.bornAt ? [...world.population.bornAt] : undefined
    } : undefined,
    army: world.army ? { ...world.army } : undefined,
    banner: world.banner ? { ...world.banner } : undefined
  };
}

/** Overlay unconfirmed clicks on server truth so an earlier batch response
 * never makes later optimistic orders disappear from the HUD. */
function rebasePendingArmy(
  world: SerializedWorld,
  operations: readonly ArmyBatchOperation[],
  infiniteResources: boolean,
  includeArmyCounts = true
): SerializedWorld {
  if (operations.length === 0) return world;
  const rebased = cloneWorld(world);
  const army: Record<string, number> = { ...(rebased.army ?? {}) };
  const foodCapacity = rebased.storage?.food ?? resourceCapacity(rebased.buildings).food;
  for (const operation of operations) {
    const definition = TROOP_DEFINITIONS[operation.type as TroopType];
    if (!definition) continue;
    const count = Math.max(1, Math.min(50, Math.floor(Number(operation.count) || 1)));
    if (operation.kind === 'train') {
      if (includeArmyCounts) army[operation.type] = (army[operation.type] ?? 0) + count;
      if (!infiniteResources) {
        rebased.resources.gold = Math.max(0, rebased.resources.gold - definition.cost * count);
        rebased.resources.food = Math.max(0, Number(rebased.resources.food ?? 0) - troopFoodCostOf(operation.type as TroopType) * count);
      }
      continue;
    }
    const removed = includeArmyCounts ? Math.min(army[operation.type] ?? 0, count) : count;
    if (removed <= 0) continue;
    if (includeArmyCounts) {
      if ((army[operation.type] ?? 0) === removed) delete army[operation.type];
      else army[operation.type] -= removed;
    }
    if (!infiniteResources) {
      rebased.resources.gold += definition.cost * removed;
      rebased.resources.food = Math.min(
        foodCapacity,
        Number(rebased.resources.food ?? 0) + troopFoodCostOf(operation.type as TroopType) * removed
      );
    }
  }
  rebased.army = army;
  return rebased;
}

function sameBuildingLayout(left: SerializedBuilding, right: SerializedBuilding): boolean {
  return left.type === right.type
    && left.gridX === right.gridX
    && left.gridY === right.gridY
    && left.level === right.level;
}

function sameObstacleLayout(left: SerializedObstacle, right: SerializedObstacle): boolean {
  return left.type === right.type
    && left.gridX === right.gridX
    && left.gridY === right.gridY;
}

/** Apply only the local layout delta (base -> local) on top of fresh server truth. */
function rebaseLayout(base: SerializedWorld, local: SerializedWorld, server: SerializedWorld): SerializedWorld {
  const rebased = cloneWorld(server);
  const baseBuildings = new Map(base.buildings.map(building => [building.id, building]));
  const localBuildings = new Map(local.buildings.map(building => [building.id, building]));
  const serverBuildings = new Map(server.buildings.map(building => [building.id, building]));
  const buildingUpserts = new Map<string, SerializedBuilding>();
  const buildingDeletes = new Set<string>();

  for (const id of new Set([...baseBuildings.keys(), ...localBuildings.keys()])) {
    const before = baseBuildings.get(id);
    const after = localBuildings.get(id);
    if (before && !after) buildingDeletes.add(id);
    else if (after && !before) buildingUpserts.set(id, { ...after });
    else if (before && after && !sameBuildingLayout(before, after)) {
      const remote = serverBuildings.get(id);
      buildingUpserts.set(id, remote ? {
        ...remote,
        type: after.type !== before.type ? after.type : remote.type,
        gridX: after.gridX !== before.gridX ? after.gridX : remote.gridX,
        gridY: after.gridY !== before.gridY ? after.gridY : remote.gridY,
        level: after.level !== before.level ? after.level : remote.level,
      } : { ...after });
    }
  }

  rebased.buildings = rebased.buildings
    .filter(building => !buildingDeletes.has(building.id))
    .map(building => buildingUpserts.get(building.id) ?? building);
  const existingBuildingIds = new Set(rebased.buildings.map(building => building.id));
  for (const [id, building] of buildingUpserts) {
    if (!existingBuildingIds.has(id)) rebased.buildings.push({ ...building });
  }

  const baseObstacles = new Map((base.obstacles ?? []).map(obstacle => [obstacle.id, obstacle]));
  const localObstacles = new Map((local.obstacles ?? []).map(obstacle => [obstacle.id, obstacle]));
  const serverObstacles = new Map((server.obstacles ?? []).map(obstacle => [obstacle.id, obstacle]));
  const obstacleUpserts = new Map<string, SerializedObstacle>();
  const obstacleDeletes = new Set<string>();
  for (const id of new Set([...baseObstacles.keys(), ...localObstacles.keys()])) {
    const before = baseObstacles.get(id);
    const after = localObstacles.get(id);
    if (before && !after) obstacleDeletes.add(id);
    else if (after && !before) obstacleUpserts.set(id, { ...after });
    else if (before && after && !sameObstacleLayout(before, after)) {
      const remote = serverObstacles.get(id);
      obstacleUpserts.set(id, remote ? {
        ...remote,
        type: after.type !== before.type ? after.type : remote.type,
        gridX: after.gridX !== before.gridX ? after.gridX : remote.gridX,
        gridY: after.gridY !== before.gridY ? after.gridY : remote.gridY,
      } : { ...after });
    }
  }
  rebased.obstacles = (rebased.obstacles ?? [])
    .filter(obstacle => !obstacleDeletes.has(obstacle.id))
    .map(obstacle => obstacleUpserts.get(obstacle.id) ?? obstacle);
  const existingObstacleIds = new Set(rebased.obstacles.map(obstacle => obstacle.id));
  for (const [id, obstacle] of obstacleUpserts) {
    if (!existingObstacleIds.has(id)) rebased.obstacles.push({ ...obstacle });
  }

  if ((local.wallLevel ?? 1) !== (base.wallLevel ?? 1)) rebased.wallLevel = local.wallLevel;
  rebased.lastSaveTime = Math.max(server.lastSaveTime ?? 0, local.lastSaveTime ?? 0);
  return rebased;
}

/**
 * Client gateway to the game server.
 *
 * Model: the local cache (memory + localStorage) mirrors the base for instant
 * rendering; every layout mutation triggers a debounced full save. The server
 * is authoritative for GOLD balance, trophies, attacks, loot and replays — the
 * client never writes those directly.
 */
export class Backend {
  private static memoryCache = new Map<string, SerializedWorld>();
  private static saveTimers = new Map<string, number>();
  private static inFlightSaves = new Map<string, Promise<void>>();
  /** Monotonic edit sequence + last-launched save id, so the unload flush can
   *  detect "nothing new" and resend the SAME requestId — the server's
   *  idempotency dedupe then makes arrival order harmless. */
  private static saveSeq = new Map<string, number>();
  private static sentSeq = new Map<string, number>();
  private static sentRequestId = new Map<string, string>();
  private static saveRetryAttempts = new Map<string, number>();
  private static committedSaveSeq = new Map<string, number>();
  /** Server layout from immediately before the first still-pending local edit. */
  private static pendingLayoutBases = new Map<string, SerializedWorld>();
  /** All revision-changing requests for one account pass through this chain. */
  private static mutationChains = new Map<string, Promise<void>>();
  /** Debounced click bursts. `unconfirmed` also includes the prefix currently
   * in flight, which lets every intervening world response rebase correctly. */
  private static armyQueues = new Map<string, QueuedArmyOperation[]>();
  private static armyUnconfirmed = new Map<string, QueuedArmyOperation[]>();
  private static armyAuthorityBases = new Map<string, SerializedWorld>();
  private static armyFlushTimers = new Map<string, number>();
  private static armyDrainPromises = new Map<string, Promise<void>>();
  private static armyOperationSequence = 0;
  private static authorityRequestSeq = new Map<string, number>();
  private static authorityResponseSeq = new Map<string, number>();
  private static knownRevision = new Map<string, number>();
  /** A banner acknowledged in this session wins later cache adoptions, so an
   *  older own-world response cannot undo onboarding or an explicit edit. */
  private static confirmedBanners = new Map<string, VillageBanner>();
  private static battleReconcileTimers = new Map<string, number>();

  // ---- transport ----

  private static authHeaders(): Record<string, string> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    const token = Auth.getToken();
    if (token) headers.Authorization = `Bearer ${token}`;
    return headers;
  }

  private static sessionExpiredAnnounced = false;

  /** A 401 means the token is dead (revoked or expired) — every later call
   *  will fail identically, so tell the player once instead of drowning the
   *  console while the UI quietly stops updating. */
  private static noteAuthFailure(status: number) {
    if (status !== 401 || Backend.sessionExpiredAnnounced) return;
    Backend.sessionExpiredAnnounced = true;
    try {
      window.dispatchEvent(new CustomEvent('clash:session-expired'));
    } catch {
      // Non-browser context (tests) — nothing to announce to.
    }
  }

  private static async apiPost<T>(path: string, body: unknown, keepalive = false): Promise<T> {
    const controller = !keepalive && typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timeout = controller
      ? globalThis.setTimeout(() => controller.abort(), API_REQUEST_TIMEOUT_MS)
      : null;
    try {
      const response = await fetch(path, {
        method: 'POST',
        headers: Backend.authHeaders(),
        body: JSON.stringify(body ?? {}),
        cache: 'no-store',
        keepalive,
        signal: controller?.signal
      });
      if (!response.ok) {
        Backend.noteAuthFailure(response.status);
        const detail = await response.json().catch(() => null) as ApiErrorPayload | null;
        const error = new Error(detail?.error ?? `API ${path} failed (${response.status})`) as BackendApiError;
        error.status = response.status;
        if (detail?.code) error.code = detail.code;
        if (typeof detail?.currentRevision === 'number') error.currentRevision = detail.currentRevision;
        if (detail?.world) error.world = detail.world;
        if (detail?.resource) error.resource = detail.resource;
        throw error;
      }
      return (await response.json()) as T;
    } catch (rawError) {
      if ((rawError as { name?: string } | null)?.name === 'AbortError') {
        const error = new Error(`API ${path} timed out`) as BackendApiError;
        error.status = 408;
        error.code = 'REQUEST_TIMEOUT';
        throw error;
      }
      throw rawError;
    } finally {
      if (timeout !== null) globalThis.clearTimeout(timeout);
    }
  }

  private static async apiGet<T>(path: string): Promise<T> {
    const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timeout = controller
      ? globalThis.setTimeout(() => controller.abort(), API_REQUEST_TIMEOUT_MS)
      : null;
    try {
      const response = await fetch(path, {
        method: 'GET',
        headers: Backend.authHeaders(),
        cache: 'no-store',
        signal: controller?.signal
      });
      if (!response.ok) {
        Backend.noteAuthFailure(response.status);
        const detail = await response.json().catch(() => null) as ApiErrorPayload | null;
        const error = new Error(detail?.error ?? `API ${path} failed (${response.status})`) as BackendApiError;
        error.status = response.status;
        if (detail?.code) error.code = detail.code;
        if (typeof detail?.currentRevision === 'number') error.currentRevision = detail.currentRevision;
        if (detail?.world) error.world = detail.world;
        if (detail?.resource) error.resource = detail.resource;
        throw error;
      }
      return (await response.json()) as T;
    } catch (rawError) {
      if ((rawError as { name?: string } | null)?.name === 'AbortError') {
        const error = new Error(`API ${path} timed out`) as BackendApiError;
        error.status = 408;
        error.code = 'REQUEST_TIMEOUT';
        throw error;
      }
      throw rawError;
    } finally {
      if (timeout !== null) globalThis.clearTimeout(timeout);
    }
  }

  private static retryableRequest(error: unknown): boolean {
    const status = (error as { status?: number } | null)?.status;
    return status === undefined || status === 408 || status >= 500;
  }

  private static async postWithRetry<T>(path: string, body: unknown, attempts = 3): Promise<T> {
    let lastError: unknown = new Error(`API ${path} failed`);
    for (let attempt = 0; attempt < attempts; attempt++) {
      try {
        const user = Auth.getCurrentUser();
        if (user) heartbeatBattle(user.id);
        return await Backend.apiPost<T>(path, body);
      } catch (error) {
        lastError = error;
        if (!Backend.retryableRequest(error) || attempt + 1 >= attempts) throw error;
        await new Promise(resolve => setTimeout(resolve, 300 * 2 ** attempt));
      }
    }
    throw lastError;
  }

  /** Start an attack without a speculative active-session read. The normal
   * case is one POST; only the exceptional cross-device lock pays for an
   * abort and retry. The original idempotency key is preserved. */
  private static async postAttackStartWithTakeover<T>(
    path: string,
    body: unknown,
    userId: string
  ): Promise<T> {
    try {
      return await Backend.postWithRetry<T>(path, body);
    } catch (error) {
      const status = (error as { status?: number } | null)?.status;
      const message = error instanceof Error ? error.message : '';
      if (status !== 409 || !/active attack|finish or abort/i.test(message)) throw error;

      const authoritySeq = Backend.nextAuthorityRequest(userId);
      const aborted = await Backend.apiPost<{ world?: SerializedWorld }>('/api/attacks/active/abort', {});
      if (aborted.world) {
        const effective = Backend.adoptRemoteWorld(userId, aborted.world, authoritySeq, true);
        if (effective) Backend.announceWorldSync(effective);
      }
      return await Backend.postWithRetry<T>(path, body);
    }
  }

  private static scheduleBattleReconciliation(userId: string, delayMs = 3_000) {
    if (typeof window === 'undefined' || Backend.battleReconcileTimers.has(userId)) return;
    const timer = window.setTimeout(() => {
      Backend.battleReconcileTimers.delete(userId);
      const current = Auth.getCurrentUser();
      if (!Auth.isOnlineMode() || current?.id !== userId) return;
      void Backend.reconcileInterruptedBattle().catch(error => {
        console.warn('Interrupted battle reconciliation retry failed:', error);
      });
    }, Math.max(250, delayMs));
    Backend.battleReconcileTimers.set(userId, timer);
  }

  private static clearBattleReconciliation(userId: string) {
    const timer = Backend.battleReconcileTimers.get(userId);
    if (timer !== undefined && typeof window !== 'undefined') window.clearTimeout(timer);
    Backend.battleReconcileTimers.delete(userId);
  }

  private static terminalBattleStartFailure(error: unknown): boolean {
    const status = (error as { status?: number } | null)?.status;
    return typeof status === 'number'
      && status >= 400
      && status < 500
      && status !== 401
      && status !== 408
      && status !== 429;
  }

  /** A malformed presentation payload must still retain enough identity for
   * crash recovery to close the server-side reservation. In particular, a
   * mixed-version response may omit reservedArmy: refuse to render it, but do
   * not strand the raid until its TTL by refusing to settle it too. */
  private static validStartedBotRaidIdentity(result: StartedBotRaid | null | undefined): boolean {
    return Boolean(
      result
      && typeof result.raidId === 'string'
      && result.raidId.length > 0
      && Array.isArray(result.world?.buildings)
      && Number.isInteger(result.x)
      && Number.isInteger(result.y)
      && Number.isInteger(result.seed)
    );
  }

  /** Runtime-check the full presentation contract before it enters battle UI. */
  private static validReservedArmy(value: unknown): value is Record<string, number> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const entries = Object.entries(value as Record<string, unknown>);
    return entries.length > 0 && entries.every(([type, count]) => (
      type.length > 0
      && Number.isInteger(count)
      && Number(count) > 0
    ));
  }

  private static validStartedBotRaid(result: StartedBotRaid | null | undefined): result is StartedBotRaid {
    return Boolean(
      Backend.validStartedBotRaidIdentity(result)
      && result
      && Backend.validReservedArmy(result.reservedArmy)
    );
  }

  // ---- local cache ----

  static getCachedWorld(userId: string): SerializedWorld | null {
    const memory = Backend.memoryCache.get(userId);
    if (memory) return memory;
    if (typeof window === 'undefined') return null;
    // Storage-blocked browsers throw on the READ too, not just setItem —
    // and this runs synchronously inside the Phaser scene load.
    try {
      const raw = localStorage.getItem(getCacheKey(userId));
      if (!raw) return null;
      const world = JSON.parse(raw) as SerializedWorld;
      // Solana-era caches stored the gold balance under `sol`.
      const legacy = world.resources as (typeof world.resources & { sol?: number }) | undefined;
      if (legacy && legacy.gold === undefined && typeof legacy.sol === 'number') {
        legacy.gold = legacy.sol;
        delete legacy.sol;
      }
      Backend.memoryCache.set(userId, world);
      const revision = Number(world.revision);
      if (Number.isFinite(revision)) Backend.knownRevision.set(userId, Math.max(Backend.knownRevision.get(userId) ?? 0, revision));
      return world;
    } catch {
      return null;
    }
  }

  private static setCachedWorld(userId: string, world: SerializedWorld) {
    const confirmedBanner = Backend.confirmedBanners.get(userId);
    const effectiveWorld = confirmedBanner
      ? { ...world, banner: { ...confirmedBanner } }
      : world;
    Backend.memoryCache.set(userId, effectiveWorld);
    const revision = Number(effectiveWorld.revision);
    if (Number.isFinite(revision)) Backend.knownRevision.set(userId, Math.max(Backend.knownRevision.get(userId) ?? 0, revision));
    if (typeof window !== 'undefined') {
      try {
        localStorage.setItem(getCacheKey(userId), JSON.stringify(effectiveWorld));
      } catch {
        // Quota exceeded — memory cache still holds the world.
      }
    }
  }

  private static nextAuthorityRequest(userId: string): number {
    const next = (Backend.authorityRequestSeq.get(userId) ?? 0) + 1;
    Backend.authorityRequestSeq.set(userId, next);
    return next;
  }

  /** Revision wins first; request order breaks ties for production-only responses. */
  private static canAdoptAuthority(userId: string, revision: number | undefined, requestSeq: number): boolean {
    const incoming = Number(revision);
    const known = Backend.knownRevision.get(userId) ?? Number(Backend.getCachedWorld(userId)?.revision ?? 0);
    if (!Number.isFinite(incoming)) return known <= 0;
    if (incoming < known) return false;
    if (incoming === known && requestSeq < (Backend.authorityResponseSeq.get(userId) ?? 0)) return false;
    return true;
  }

  private static markAuthorityAdopted(userId: string, revision: number | undefined, requestSeq: number) {
    const incoming = Number(revision);
    if (Number.isFinite(incoming)) {
      Backend.knownRevision.set(userId, Math.max(Backend.knownRevision.get(userId) ?? 0, incoming));
    }
    Backend.authorityResponseSeq.set(userId, Math.max(Backend.authorityResponseSeq.get(userId) ?? 0, requestSeq));
  }

  /** Adopt a full own-world response without erasing pending local layout edits. */
  private static adoptRemoteWorld(
    userId: string,
    serverWorld: SerializedWorld,
    requestSeq: number,
    preservePendingLayout = true
  ): SerializedWorld | null {
    const current = Backend.getCachedWorld(userId);
    if (!Backend.canAdoptAuthority(userId, serverWorld.revision, requestSeq)) return current;

    let next = cloneWorld(serverWorld);
    const base = Backend.pendingLayoutBases.get(userId);
    if (preservePendingLayout && base && current) {
      next = rebaseLayout(base, current, serverWorld);
      Backend.pendingLayoutBases.set(userId, cloneWorld(serverWorld));
    }
    next = Backend.withPendingArmy(userId, next);
    Backend.markAuthorityAdopted(userId, serverWorld.revision, requestSeq);
    Backend.setCachedWorld(userId, next);
    Backend.adoptWorldAdvertisements(serverWorld);
    return next;
  }

  /**
   * Server-advertised facts riding on every own-world payload. Trophies flow
   * through the same event the settlement path uses, so a defense loss
   * reaches the HUD on the ordinary world poll; the upgrade-clock policy
   * keeps every advertised duration honest to THIS server's billing.
   */
  private static adoptWorldAdvertisements(world: SerializedWorld) {
    adoptUpgradePolicy(world.upgradePolicy);
    if (typeof world.trophies === 'number' && typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('clash:trophies-synced', {
        detail: { trophies: Math.max(0, Math.floor(world.trophies)) }
      }));
    }
  }

  private static captureLayoutBase(userId: string, world: SerializedWorld) {
    if (!Backend.pendingLayoutBases.has(userId)) {
      Backend.pendingLayoutBases.set(userId, cloneWorld(world));
    }
  }

  private static markLayoutEdited(userId: string) {
    Backend.saveSeq.set(userId, (Backend.saveSeq.get(userId) ?? 0) + 1);
  }

  private static withPendingArmy(userId: string, world: SerializedWorld): SerializedWorld {
    return rebasePendingArmy(
      world,
      Backend.armyUnconfirmed.get(userId) ?? [],
      Boolean(Auth.getFeatures().infiniteResources)
    );
  }

  private static enqueueMutation<T>(userId: string, operation: () => Promise<T>): Promise<T> {
    const previous = Backend.mutationChains.get(userId) ?? Promise.resolve();
    const task = previous.catch(() => undefined).then(operation);
    const settled = task.then(() => undefined, () => undefined);
    Backend.mutationChains.set(userId, settled);
    return task.finally(() => {
      if (Backend.mutationChains.get(userId) === settled) Backend.mutationChains.delete(userId);
    });
  }

  static primeWorldCache(userId: string, world: SerializedWorld | null | undefined) {
    if (!world) return;
    const requestSeq = Backend.nextAuthorityRequest(userId);
    Backend.adoptRemoteWorld(userId, world, requestSeq);
  }

  static clearCacheForUser(userId: string) {
    Backend.memoryCache.delete(userId);
    const timer = Backend.saveTimers.get(userId);
    if (timer) {
      window.clearTimeout(timer);
      Backend.saveTimers.delete(userId);
    }
    Backend.inFlightSaves.delete(userId);
    Backend.saveRetryAttempts.delete(userId);
    Backend.saveSeq.delete(userId);
    Backend.sentSeq.delete(userId);
    Backend.sentRequestId.delete(userId);
    Backend.committedSaveSeq.delete(userId);
    Backend.pendingLayoutBases.delete(userId);
    Backend.mutationChains.delete(userId);
    const armyTimer = Backend.armyFlushTimers.get(userId);
    if (armyTimer !== undefined && typeof window !== 'undefined') window.clearTimeout(armyTimer);
    Backend.armyFlushTimers.delete(userId);
    Backend.armyQueues.delete(userId);
    Backend.armyUnconfirmed.delete(userId);
    Backend.armyAuthorityBases.delete(userId);
    Backend.armyDrainPromises.delete(userId);
    Backend.authorityRequestSeq.delete(userId);
    Backend.authorityResponseSeq.delete(userId);
    Backend.knownRevision.delete(userId);
    Backend.confirmedBanners.delete(userId);
    if (typeof window !== 'undefined') {
      try {
        localStorage.removeItem(getCacheKey(userId));
      } catch {
        // Storage blocked — the memory cache is already cleared.
      }
    }
  }

  static clearAllCaches() {
    Backend.memoryCache.clear();
    Backend.saveTimers.forEach(timer => window.clearTimeout(timer));
    Backend.saveTimers.clear();
    Backend.inFlightSaves.clear();
    Backend.saveRetryAttempts.clear();
    Backend.saveSeq.clear();
    Backend.sentSeq.clear();
    Backend.sentRequestId.clear();
    Backend.committedSaveSeq.clear();
    Backend.pendingLayoutBases.clear();
    Backend.mutationChains.clear();
    Backend.armyFlushTimers.forEach(timer => window.clearTimeout(timer));
    Backend.armyFlushTimers.clear();
    Backend.armyQueues.clear();
    Backend.armyUnconfirmed.clear();
    Backend.armyAuthorityBases.clear();
    Backend.armyDrainPromises.clear();
    Backend.authorityRequestSeq.clear();
    Backend.authorityResponseSeq.clear();
    Backend.knownRevision.clear();
    Backend.confirmedBanners.clear();
    Backend.frameBuffer = [];
    Backend.frameBufferAttackId = null;
    Backend.failedFrameBatches.clear();
    Backend.frameFlushChain = Promise.resolve();
    if (typeof window !== 'undefined') {
      try {
        Object.keys(localStorage)
          .filter(key => key.startsWith(CACHE_PREFIX))
          .forEach(key => localStorage.removeItem(key));
      } catch {
        // Storage blocked — nothing persisted there anyway.
      }
    }
  }

  // ---- saving ----

  static hasPendingSave(userId?: string): boolean {
    if (userId) {
      return Backend.saveTimers.has(userId) || Backend.inFlightSaves.has(userId);
    }
    return Backend.saveTimers.size > 0 || Backend.inFlightSaves.size > 0;
  }

  static hasPendingArmy(userId?: string): boolean {
    if (userId) {
      return (Backend.armyUnconfirmed.get(userId)?.length ?? 0) > 0
        || Backend.armyDrainPromises.has(userId);
    }
    return Backend.armyUnconfirmed.size > 0 || Backend.armyDrainPromises.size > 0;
  }

  /** Monotonic local layout edit sequence, used to reject stale background reads. */
  static getLocalEditSequence(userId: string): number {
    return Backend.saveSeq.get(userId) ?? 0;
  }

  /** Ordinary layout persistence starts only after every authored onboarding gate. */
  private static ordinaryLayoutSavesBlocked(userId: string): boolean {
    const features = Auth.getFeatures();
    if (features.introBattleRequired || features.watchtowerPlacementRequired) return true;
    return !sanitizeVillageBanner(Backend.getCachedWorld(userId)?.banner);
  }

  /** Debounced save: rapid edits (wall drags, redesigns) collapse into one request. */
  private static scheduleSave(userId: string) {
    if (!Auth.isOnlineMode() || Backend.ordinaryLayoutSavesBlocked(userId)) return;
    const existing = Backend.saveTimers.get(userId);
    if (existing) window.clearTimeout(existing);
    Backend.saveTimers.set(userId, window.setTimeout(() => {
      Backend.saveTimers.delete(userId);
      void Backend.saveNow(userId).catch(error => {
        console.warn('Background save attempt failed:', error);
      });
    }, SAVE_DEBOUNCE_MS));
  }

  private static scheduleSaveRetry(userId: string) {
    if (!Auth.isOnlineMode() || Backend.ordinaryLayoutSavesBlocked(userId) || Backend.saveTimers.has(userId)) return;
    const attempt = (Backend.saveRetryAttempts.get(userId) ?? 0) + 1;
    Backend.saveRetryAttempts.set(userId, attempt);
    const delay = Math.min(SAVE_RETRY_MAX_MS, SAVE_RETRY_BASE_MS * 2 ** Math.min(4, attempt - 1));
    Backend.saveTimers.set(userId, window.setTimeout(() => {
      Backend.saveTimers.delete(userId);
      void Backend.saveNow(userId).catch(error => {
        console.warn('Layout save retry failed:', error);
      });
    }, delay));
  }

  /** Serialize layout saves, then serialize them with every other account mutation. */
  private static saveNow(userId: string, tutorialWatchtower = false): Promise<void> {
    if (!Auth.isOnlineMode()) return Promise.resolve();
    if (!tutorialWatchtower && Backend.ordinaryLayoutSavesBlocked(userId)) return Promise.resolve();
    const timer = Backend.saveTimers.get(userId);
    if (timer) {
      window.clearTimeout(timer);
      Backend.saveTimers.delete(userId);
    }
    const queued = Backend.inFlightSaves.get(userId) ?? Promise.resolve();
    const task = queued.catch(() => undefined).then(async () => {
      const targetSeq = Backend.saveSeq.get(userId) ?? 0;
      if (targetSeq <= (Backend.committedSaveSeq.get(userId) ?? 0)) return;
      await Backend.enqueueMutation(userId, () => Backend.saveWorldDirect(userId, targetSeq, tutorialWatchtower));
    });
    Backend.inFlightSaves.set(userId, task);
    return task.finally(() => {
      if (Backend.inFlightSaves.get(userId) === task) {
        Backend.inFlightSaves.delete(userId);
      }
    });
  }

  private static async fetchOwnWorldForReconcile(userId: string): Promise<{ world: SerializedWorld; requestSeq: number } | null> {
    const requestSeq = Backend.nextAuthorityRequest(userId);
    const response = await Backend.apiGet<{ world: SerializedWorld | null }>('/api/world');
    return response.world ? { world: response.world, requestSeq } : null;
  }

  private static async saveWorldDirect(
    userId: string,
    targetSeq: number,
    tutorialWatchtower = false
  ): Promise<void> {
    if (!Backend.getCachedWorld(userId) || !Auth.isOnlineMode()) return;
    let requestId = '';
    let requestIdSeq = -1;

    for (let staleAttempt = 0; staleAttempt < 3; staleAttempt++) {
      const world = Backend.getCachedWorld(userId);
      if (!world) return;
      // The save may have waited behind an economy mutation. Include every
      // edit present when this payload is captured and commit that exact seq.
      const attemptedSeq = Math.max(targetSeq, Backend.saveSeq.get(userId) ?? 0);
      if (requestIdSeq !== attemptedSeq) {
        requestId = Backend.sentSeq.get(userId) === attemptedSeq
          ? (Backend.sentRequestId.get(userId) ?? makeRequestId('save'))
          : makeRequestId('save');
        requestIdSeq = attemptedSeq;
        Backend.sentSeq.set(userId, attemptedSeq);
        Backend.sentRequestId.set(userId, requestId);
      }
      const sentWorld = cloneWorld(world);
      const requestSeq = Backend.nextAuthorityRequest(userId);
      try {
        const data = await Backend.apiPost<{ world?: SerializedWorld; watchtowerPlacementRequired?: boolean }>(
          tutorialWatchtower ? '/api/watchtower-tutorial/place' : '/api/world/save', {
          world: sentWorld,
          expectedRevision: sentWorld.revision,
          requestId
          }
        );
        Backend.saveRetryAttempts.delete(userId);
        if (data.world) {
          const merged = Backend.mergeServerResponse(userId, data.world, attemptedSeq, sentWorld, requestSeq);
          if (merged) Backend.announceWorldSync(merged);
        }
        if (tutorialWatchtower && data.watchtowerPlacementRequired === false) {
          Auth.resolveWatchtowerPlacement();
        }
        return;
      } catch (rawError) {
        const error = rawError as BackendApiError;
        const isLegacyStale = error.status === 409 && /stale world revision/i.test(error.message);
        if (error.code === 'STALE_REVISION' || isLegacyStale) {
          const suppliedTruth = error.world
            ? { world: error.world, requestSeq }
            : await Backend.fetchOwnWorldForReconcile(userId);
          if (!suppliedTruth) {
            if (!tutorialWatchtower) Backend.scheduleSaveRetry(userId);
            throw new Error('Server truth was unavailable after a stale layout save');
          }
          const rebased = Backend.adoptRemoteWorld(userId, suppliedTruth.world, suppliedTruth.requestSeq, true);
          if (rebased) Backend.announceWorldSync(rebased);
          continue;
        }

        const isAffordability = error.code === 'INSUFFICIENT_RESOURCES'
          || (error.status === 409 && /not enough (gold|ore).*changes/i.test(error.message));
        const isArmyCapacityRejection = error.code === 'ARMY_OVER_CAPACITY'
          || (error.status === 409 && /army.*(over|exceed|capacity|housing)/i.test(error.message));
        const isIncomingAttackLock = error.code === 'BASE_UNDER_ATTACK';
        const isUpgradeLock = error.code === 'UPGRADE_IN_PROGRESS';
        const isDeterministicLayoutRejection = isAffordability || isArmyCapacityRejection
          || isIncomingAttackLock || isUpgradeLock || error.status === 400
          || (tutorialWatchtower && error.status === 409);
        if (isDeterministicLayoutRejection) {
          console.warn('Save rejected, reverting the rejected layout delta:', error);
          try {
            const suppliedTruth = error.world
              ? { world: error.world, requestSeq }
              : await Backend.fetchOwnWorldForReconcile(userId);
            if (!suppliedTruth) throw new Error('Server truth was unavailable after save rejection');
            const current = Backend.getCachedWorld(userId);
            const hasNewerEdits = (Backend.saveSeq.get(userId) ?? 0) > attemptedSeq;
            const mayAdoptSupplied = Backend.canAdoptAuthority(userId, suppliedTruth.world.revision, suppliedTruth.requestSeq);
            let authorityWorld = cloneWorld(
              mayAdoptSupplied
                ? suppliedTruth.world
                : (Backend.pendingLayoutBases.get(userId) ?? suppliedTruth.world)
            );
            let authoritySeq = suppliedTruth.requestSeq;
            if (!mayAdoptSupplied && current) {
              authorityWorld = {
                ...authorityWorld,
                resources: { ...current.resources },
                storage: current.storage ? { ...current.storage } : undefined,
                population: current.population ? {
                  ...current.population,
                  bornAt: current.population.bornAt ? [...current.population.bornAt] : undefined
                } : undefined,
                army: current.army ? { ...current.army } : undefined,
                revision: current.revision,
                lastSaveTime: Math.max(authorityWorld.lastSaveTime ?? 0, current.lastSaveTime ?? 0),
              };
              authoritySeq = Backend.authorityResponseSeq.get(userId) ?? suppliedTruth.requestSeq;
            }
            let effective = cloneWorld(authorityWorld);
            if (current && hasNewerEdits) {
              effective = rebaseLayout(sentWorld, current, authorityWorld);
              Backend.pendingLayoutBases.set(userId, cloneWorld(authorityWorld));
            } else {
              Backend.pendingLayoutBases.delete(userId);
            }
            effective = Backend.withPendingArmy(userId, effective);
            Backend.markAuthorityAdopted(userId, authorityWorld.revision, authoritySeq);
            Backend.setCachedWorld(userId, effective);
            Backend.committedSaveSeq.set(userId, Math.max(Backend.committedSaveSeq.get(userId) ?? 0, attemptedSeq));
            if (typeof window !== 'undefined') {
              window.dispatchEvent(new CustomEvent('clash:save-rejected', {
                detail: { message: error.message || 'Save rejected', resource: error.resource, world: effective }
              }));
            }
          } catch (reconcileError) {
            if (!tutorialWatchtower) Backend.scheduleSaveRetry(userId);
            throw reconcileError;
          }
          Backend.saveRetryAttempts.delete(userId);
          return;
        }

        console.warn('Save failed:', error);
        if (!tutorialWatchtower && error.status !== 401) Backend.scheduleSaveRetry(userId);
        throw error;
      }
    }

    if (!tutorialWatchtower) Backend.scheduleSaveRetry(userId);
    throw new Error('Layout changed repeatedly while saving; retry scheduled');
  }

  /** Commit the one pre-banner layout mutation through its narrow server route. */
  static async completeWatchtowerPlacement(userId: string): Promise<void> {
    await Backend.saveNow(userId, true);
    if (Auth.getFeatures().watchtowerPlacementRequired) {
      throw new Error('Watchtower placement returned without authoritative completion');
    }
  }

  /** Tell the React shell a server-authoritative world state just arrived. */
  private static announceWorldSync(world: SerializedWorld) {
    if (typeof window === 'undefined') return;
    try {
      window.dispatchEvent(new CustomEvent('clash:world-synced', { detail: { world } }));
    } catch {
      // Non-browser context (tests).
    }
  }

  /** Adopt a successful save while retaining edits made after its payload was captured. */
  private static mergeServerResponse(
    userId: string,
    serverWorld: SerializedWorld,
    targetSeq: number,
    sentWorld: SerializedWorld,
    requestSeq: number
  ): SerializedWorld | null {
    const current = Backend.getCachedWorld(userId);
    Backend.committedSaveSeq.set(userId, Math.max(Backend.committedSaveSeq.get(userId) ?? 0, targetSeq));
    const hasNewerEdits = (Backend.saveSeq.get(userId) ?? 0) > targetSeq;
    if (!Backend.canAdoptAuthority(userId, serverWorld.revision, requestSeq)) {
      if (!hasNewerEdits) Backend.pendingLayoutBases.delete(userId);
      return current;
    }
    let next = cloneWorld(serverWorld);
    if (current && hasNewerEdits) {
      next = rebaseLayout(sentWorld, current, serverWorld);
      Backend.pendingLayoutBases.set(userId, cloneWorld(serverWorld));
    } else {
      Backend.pendingLayoutBases.delete(userId);
    }
    next = Backend.withPendingArmy(userId, next);
    Backend.markAuthorityAdopted(userId, serverWorld.revision, requestSeq);
    Backend.setCachedWorld(userId, next);
    return next;
  }

  static async flushPendingSave(): Promise<void> {
    const pending = new Set<string>([
      ...Backend.saveTimers.keys(),
      ...Backend.inFlightSaves.keys()
    ]);
    // saveNow serializes behind any request already in flight. Awaiting these
    // returned promises therefore means every edit known at call time reached
    // the server (or this method truthfully rejects).
    await Promise.all(Array.from(pending).map(async userId => {
      await Backend.saveNow(userId);
    }));
  }

  /** Account/session switches need both independent persistence lanes. */
  static async flushAllPending(): Promise<void> {
    await Backend.flushPendingArmy();
    await Backend.flushPendingSave();
  }

  /** Fire-and-forget keepalive save for `beforeunload`. */
  static flushBeforeUnload() {
    const user = Auth.getCurrentUser();
    if (!user || !Auth.isOnlineMode()) return;
    const timer = Backend.saveTimers.get(user.id);
    if (timer) {
      window.clearTimeout(timer);
      Backend.saveTimers.delete(user.id);
    }
    const world = Backend.getCachedWorld(user.id);
    if (!world) return;
    const editSeq = Backend.saveSeq.get(user.id) ?? 0;
    if (editSeq <= (Backend.committedSaveSeq.get(user.id) ?? 0)) return;
    try {
      // If nothing changed since the last save we launched, reuse its
      // requestId: should both requests land, the server dedupes and arrival
      // order cannot resurrect a stale world. Fresh edits get a fresh id.
      const unchanged = editSeq === Backend.sentSeq.get(user.id);
      const requestId = unchanged
        ? (Backend.sentRequestId.get(user.id) ?? makeRequestId('save'))
        : makeRequestId('save');
      Backend.sentSeq.set(user.id, editSeq);
      Backend.sentRequestId.set(user.id, requestId);
      void Backend.apiPost('/api/world/save', { world: cloneWorld(world), expectedRevision: world.revision, requestId }, true).catch(() => undefined);
    } catch {
      // Page is unloading.
    }
  }

  // ---- world loading ----

  /** Population poll; adopts authority fields while preserving unsaved layout edits. */
  static async fetchWorldSnapshot(): Promise<SerializedWorld | null> {
    if (!Auth.isOnlineMode()) return null;
    const user = Auth.getCurrentUser();
    if (!user) return null;
    try {
      const requestSeq = Backend.nextAuthorityRequest(user.id);
      const response = await Backend.apiGet<{ world: SerializedWorld | null }>('/api/world');
      return response.world ? Backend.adoptRemoteWorld(user.id, response.world, requestSeq, true) : null;
    } catch {
      return null;
    }
  }

  /** Compact HOME heartbeat: one small response replaces the incoming-raid,
   * shield and full-world polling loops. A full world is fetched separately
   * only when this revision says the cached snapshot is stale. */
  static async fetchHomeSync(): Promise<HomeSyncResponse | null> {
    if (!Auth.isOnlineMode() || !Auth.getCurrentUser()) return null;
    try {
      const response = await Backend.apiGet<HomeSyncResponse>('/api/home/sync');
      // These are effective, per-player server facts. Adopt them before any
      // queued economy/layout work can consult the old session entitlements.
      if (response.features) Auth.adoptFeatures(response.features);
      if (response.upgradePolicy) adoptUpgradePolicy(response.upgradePolicy);
      return response;
    } catch (error) {
      console.warn('Home sync failed:', error);
      return null;
    }
  }

  /** Atomically win (or lose) this account's one announcement for an activation. */
  static async claimTestModeAnnouncement(activationId: string): Promise<TestModeAnnouncementClaimResult> {
    if (!activationId) return { show: false, activationId };
    try {
      const response = await Backend.apiPost<TestModeAnnouncementClaimResult>(
        '/api/test-mode/announcement/claim',
        { activationId }
      );
      return response.activationId === activationId
        ? { show: response.show === true, activationId }
        : { show: false, activationId };
    } catch (error) {
      const apiError = error as BackendApiError;
      if (apiError.status === 409 && apiError.code === 'TEST_MODE_ACTIVATION_STALE') {
        return { show: false, activationId };
      }
      throw error;
    }
  }

  static async completeIntroBattle(): Promise<IntroBattleCompletionResult> {
    const response = await Backend.apiPost<IntroBattleCompletionResult>(
      '/api/intro-battle/complete',
      {}
    );
    if (response.ok !== true || response.introBattleRequired !== false) {
      throw new Error('Intro battle completion returned an invalid response');
    }
    Auth.resolveIntroBattle();
    return response;
  }

  static async forceLoadFromCloud(userId: string): Promise<SerializedWorld | null> {
    if (!Auth.isOnlineMode()) return null;
    // /api/world is ALWAYS the signed-in player's own base. Guard against a
    // foreign id here: caching my world under someone else's key poisoned
    // every later fetch for that player (their village rendered as a copy
    // of mine on the world map).
    if (Auth.getCurrentUser()?.id !== userId) {
      return await Backend.loadFromCloud(userId);
    }
    const requestSeq = Backend.nextAuthorityRequest(userId);
    const response = await Backend.apiGet<{ world: SerializedWorld | null }>('/api/world');
    if (!response.world) return null;
    const effective = Backend.adoptRemoteWorld(userId, response.world, requestSeq, true);
    if (effective) Backend.announceWorldSync(effective);
    return effective;
  }

  static async refreshWorldFromCloud(userId: string): Promise<SerializedWorld | null> {
    if (!Auth.isOnlineMode()) return null;
    if (Auth.getCurrentUser()?.id !== userId) return await Backend.loadFromCloud(userId);
    const requestSeq = Backend.nextAuthorityRequest(userId);
    const response = await Backend.apiGet<{ world: SerializedWorld | null }>('/api/world');
    return response.world ? Backend.adoptRemoteWorld(userId, response.world, requestSeq, true) : null;
  }

  /** Load another player's base (scouting). */
  static async loadFromCloud(userId: string): Promise<SerializedWorld | null> {
    if (!Auth.isOnlineMode()) return null;
    const response = await Backend.apiGet<{ world: SerializedWorld | null }>(`/api/players/${encodeURIComponent(userId)}/world`);
    return response.world ?? null;
  }

  /**
   * One window of the global village grid. Pass null coordinates to let the
   * SERVER center the window on the caller's own plot — the client does not
   * know its plot before the first response, and guessing (0,0) painted the
   * whole neighbourhood at wrong offsets on first load.
   */
  static async fetchMap(
    x: number | null,
    y: number | null,
    r: number,
    knownPlots?: Record<string, KnownMapPlot>
  ): Promise<WorldMapWindow | null> {
    if (!Auth.isOnlineMode()) return null;
    try {
      const query = new URLSearchParams();
      if (x !== null && y !== null) {
        query.set('x', String(x));
        query.set('y', String(y));
      }
      query.set('r', String(r));
      const known = Object.entries(knownPlots ?? {})
        .filter(([key, token]) => /^-?\d+,-?\d+$/.test(key)
          && typeof token?.ownerId === 'string'
          && token.ownerId.length > 0
          && !token.ownerId.includes(':')
          && (typeof token.revision === 'string' || (typeof token.revision === 'number' && Number.isFinite(token.revision)))
          && !String(token.revision).includes(':'))
        .map(([key, token]) => `${key}:${token.ownerId}:${String(token.revision)}`)
        .join(';');
      if (known) query.set('known', known);
      return await Backend.apiGet<WorldMapWindow>(`/api/map?${query.toString()}`);
    } catch (error) {
      console.warn('Map fetch failed:', error);
      return null;
    }
  }

  /** A bounded regional chart around the caller; the server reports truncation. */
  static async fetchAtlas(): Promise<{
    me: { x: number; y: number };
    /** The watchtower's default-sight radius in plots (0-2); 0 with no watchtower. */
    sight: number;
    /** The world's coordinate bound: plots span ±worldPlotLimit on both axes. */
    worldPlotLimit: number;
    seedVersion: number;
    players: Array<{ id: string; x: number; y: number; username: string; trophies: number; shielded: boolean; underAttack: boolean; me: boolean; online: boolean }>;
    battles: Array<{ ax: number; ay: number; vx: number; vy: number }>;
    window: { minX: number; maxX: number; minY: number; maxY: number };
    truncated: boolean;
  } | null> {
    if (!Auth.isOnlineMode()) return null;
    try {
      const raw = await Backend.apiGet<{
        me?: { x?: unknown; y?: unknown };
        sight?: unknown;
        worldPlotLimit?: unknown;
        seedVersion?: unknown;
        players?: unknown;
        battles?: unknown;
        window?: { minX?: unknown; maxX?: unknown; minY?: unknown; maxY?: unknown };
        truncated?: unknown;
      }>('/api/map/atlas');
      // The transport boundary owns shape trust. The dev server hot-reloads
      // the client while the mounted game-server process keeps running old
      // code, so protocol drift can hand this method ANY 200 JSON body. The
      // atlas modal dereferences `me.x` on arrival — an unchecked malformed
      // payload used to throw in render and unmount the whole app. Malformed
      // charts degrade to null: the modal keeps its retry note instead.
      const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
      const me = raw?.me;
      if (!me || !finite(me.x) || !finite(me.y) || !Array.isArray(raw.players)) {
        console.warn('Atlas payload malformed (server/client version drift?) — chart postponed:', raw);
        return null;
      }
      const players = (raw.players as Array<Record<string, unknown> | null>)
        .filter((p): p is Record<string, unknown> => Boolean(p) && finite((p as Record<string, unknown>).x) && finite((p as Record<string, unknown>).y))
        .map(p => ({
          id: typeof p.id === 'string' ? p.id : '',
          x: p.x as number,
          y: p.y as number,
          username: typeof p.username === 'string' ? p.username : 'Unknown chief',
          trophies: finite(p.trophies) ? p.trophies : 0,
          shielded: p.shielded === true,
          underAttack: p.underAttack === true,
          me: p.me === true,
          online: p.online === true
        }));
      const battles = (Array.isArray(raw.battles) ? raw.battles as Array<Record<string, unknown> | null> : [])
        .filter((b): b is Record<string, unknown> => Boolean(b))
        .filter(b => finite(b.ax) && finite(b.ay) && finite(b.vx) && finite(b.vy))
        .map(b => ({ ax: b.ax as number, ay: b.ay as number, vx: b.vx as number, vy: b.vy as number }));
      const window = raw.window && finite(raw.window.minX) && finite(raw.window.maxX)
        && finite(raw.window.minY) && finite(raw.window.maxY)
        ? { minX: raw.window.minX, maxX: raw.window.maxX, minY: raw.window.minY, maxY: raw.window.maxY }
        : { minX: me.x, maxX: me.x, minY: me.y, maxY: me.y };
      const sight = finite(raw.sight) ? Math.max(0, Math.min(2, Math.floor(raw.sight))) : 0;
      // 24 mirrors the server's WORLD_PLOT_RADIUS (the main server's ±bound,
      // 49×49 = 2,401 plots) for servers that predate the field.
      const worldPlotLimit = finite(raw.worldPlotLimit) && raw.worldPlotLimit > 0
        ? Math.floor(raw.worldPlotLimit)
        : 24;
      const seedVersion = finite(raw.seedVersion) && raw.seedVersion >= 0
        ? Math.floor(raw.seedVersion)
        : 0;
      return { me: { x: me.x, y: me.y }, sight, worldPlotLimit, seedVersion, players, battles, window, truncated: raw.truncated === true };
    } catch (error) {
      console.warn('Atlas fetch failed:', error);
      return null;
    }
  }

  /** Pack the wagons: settle a chosen plot (or the next frontier plot if omitted). */
  static async relocate(x?: number, y?: number): Promise<RelocateResult | null> {
    if (!Auth.isOnlineMode()) return null;
    const requestId = makeRequestId('relocate');
    try {
      return await Backend.postWithRetry<RelocateResult>(
        '/api/map/relocate',
        x === undefined ? { requestId } : { x, y, requestId }
      );
    } catch (error) {
      console.warn('Relocation failed:', error);
      return null;
    }
  }

  static async getWorld(userId: string): Promise<SerializedWorld | null> {
    // The cache mirrors MY base only. Another player's world is always a
    // fresh scout fetch — a stale (or, worse, mis-keyed) copy must never
    // masquerade as a neighbour's village.
    if (Auth.getCurrentUser()?.id !== userId) {
      if (!Auth.isOnlineMode()) return null;
      return await Backend.loadFromCloud(userId);
    }
    const cached = Backend.getCachedWorld(userId);
    if (cached) return cached;
    if (!Auth.isOnlineMode()) return null;
    return await Backend.forceLoadFromCloud(userId);
  }

  /** Offline-only starter village; online players get theirs from the server. */
  static async createWorld(userId: string, owner: 'PLAYER' | 'ENEMY'): Promise<SerializedWorld> {
    const starter = createStarterVillage(randomId);
    const world: SerializedWorld = {
      id: `world_${userId}`,
      ownerId: userId,
      buildings: starter.buildings,
      obstacles: starter.obstacles,
      resources: starter.resources,
      army: starter.army,
      wallLevel: starter.wallLevel,
      lastSaveTime: Date.now(),
      revision: 1
    };
    if (owner === 'PLAYER') {
      Backend.setCachedWorld(userId, world);
    }
    return world;
  }

  static async getBuildingCounts(userId: string): Promise<Record<BuildingType, number>> {
    const world = await Backend.getWorld(userId);
    const counts = {} as Record<BuildingType, number>;
    if (!world) return counts;
    for (const building of world.buildings) {
      const key = building.type as BuildingType;
      counts[key] = (counts[key] ?? 0) + 1;
    }
    return counts;
  }

  // ---- resources ----

  /** Sync balance with the server; returns how much accrued while away. */
  static async calculateOfflineProduction(userId: string): Promise<{ gold: number }> {
    if (!Auth.isOnlineMode()) return { gold: 0 };
    try {
      const before = Backend.getCachedWorld(userId)?.resources.gold ?? 0;
      const world = await Backend.forceLoadFromCloud(userId);
      if (!world) return { gold: 0 };
      return { gold: Math.max(0, world.resources.gold - before) };
    } catch (error) {
      console.warn('Offline production sync skipped:', error);
      return { gold: 0 };
    }
  }

  /**
   * Persist the owner's complete banner and mirror it into the cached world
   * so the town-hall flag, war camp and picker all redraw immediately.
   * Announces the change via a window event; the server refreshes neighbour
   * postcards through its appearance revision.
   */
  static async setVillageBanner(userId: string, banner: VillageBanner): Promise<VillageBanner> {
    const requested = sanitizeVillageBanner(banner);
    if (!requested) throw new Error('A complete banner choice is required');
    const apply = (applied: VillageBanner) => {
      Backend.confirmedBanners.set(userId, { ...applied });
      const cached = Backend.getCachedWorld(userId);
      if (cached) Backend.setCachedWorld(userId, { ...cached, banner: { ...applied } });
      try {
        window.dispatchEvent(new CustomEvent('clash:banner-changed', { detail: { userId, banner: applied } }));
      } catch {
        // Non-browser context (tests) — nothing to announce to.
      }
      return applied;
    };

    if (!Auth.isOnlineMode()) return apply(requested);

    return await Backend.enqueueMutation(userId, async () => {
      const authoritySeq = Backend.nextAuthorityRequest(userId);
      const response = await Backend.apiPost<{ banner?: VillageBanner }>('/api/player/banner', { banner: requested });
      const applied = sanitizeVillageBanner(response.banner);
      if (!applied) throw new Error('Banner mutation returned no complete banner');
      // Banner changes advance the server's appearance revision rather than
      // the economy revision carried by own-world payloads. Record request
      // order explicitly, and retain the acknowledged choice if an older GET
      // or save response arrives without heraldry afterward.
      Backend.markAuthorityAdopted(userId, undefined, authoritySeq);
      return apply(applied);
    });
  }

  static async applyResourceDelta(userId: string, delta: number, reason: string, refId?: string, requestId?: string, resource: 'gold' | 'ore' | 'food' = 'gold'): Promise<ResourceDeltaResult> {
    if (!Auth.isOnlineMode()) {
      const world = Backend.getCachedWorld(userId);
      if (world) {
        const current = Number(world.resources[resource] ?? 0);
        world.resources[resource] = Math.max(0, current + delta);
        Backend.setCachedWorld(userId, world);
      }
      return { applied: true, gold: world?.resources.gold ?? 0 };
    }

    const stableRequestId = requestId ?? makeRequestId('delta');
    return await Backend.enqueueMutation(userId, async () => {
      const authoritySeq = Backend.nextAuthorityRequest(userId);
      const response = await Backend.apiPost<{ applied: boolean; gold: number; ore?: number; food?: number; revision?: number }>('/api/resources/apply', {
        delta,
        resource,
        reason,
        refId,
        requestId: stableRequestId
      });
      Backend.adoptBalances(userId, response, authoritySeq);
      return { applied: response.applied, gold: response.gold, revision: response.revision };
    });
  }

  /** Adopt server-authoritative balances (and optionally army/trophies) into the cache. */
  private static adoptBalances(userId: string, balances: AuthorityFields, requestSeq: number): boolean {
    if (!Backend.canAdoptAuthority(userId, balances.revision, requestSeq)) return false;
    const cached = Backend.getCachedWorld(userId);
    const world = cached ? cloneWorld(cached) : null;
    if (world) {
      if (typeof balances.gold === 'number') world.resources.gold = Math.max(0, Math.floor(balances.gold));
      if (typeof balances.ore === 'number') world.resources.ore = Math.max(0, Math.floor(balances.ore));
      if (typeof balances.food === 'number') world.resources.food = Math.max(0, Math.floor(balances.food));
      if (typeof balances.revision === 'number') world.revision = balances.revision;
      if (balances.army) world.army = { ...balances.army };
      const effective = rebasePendingArmy(
        world,
        Backend.armyUnconfirmed.get(userId) ?? [],
        Boolean(Auth.getFeatures().infiniteResources),
        Boolean(balances.army)
      );
      Backend.markAuthorityAdopted(userId, balances.revision, requestSeq);
      Backend.setCachedWorld(userId, effective);
      Backend.announceWorldSync(effective);
    } else {
      Backend.markAuthorityAdopted(userId, balances.revision, requestSeq);
    }
    if (typeof balances.trophies === 'number' && typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('clash:trophies-synced', {
        detail: { trophies: Math.max(0, Math.floor(balances.trophies)) }
      }));
    }
    return true;
  }

  private static scheduleArmyDrain(userId: string) {
    const existing = Backend.armyFlushTimers.get(userId);
    if (existing !== undefined && typeof window !== 'undefined') window.clearTimeout(existing);
    if (typeof window === 'undefined') {
      void Backend.drainArmyQueue(userId).catch(() => undefined);
      return;
    }
    Backend.armyFlushTimers.set(userId, window.setTimeout(() => {
      Backend.armyFlushTimers.delete(userId);
      void Backend.drainArmyQueue(userId).catch(() => undefined);
    }, ARMY_BATCH_DEBOUNCE_MS));
  }

  /** Queue one optimistic click. Adjacent identical clicks coalesce up to the
   * server's existing 50-troop count cap; mixed operations retain click order. */
  static queueArmyOperation(kind: 'train' | 'untrain', type: string, count = 1): boolean {
    if (!Auth.isOnlineMode()) return false;
    const user = Auth.getCurrentUser();
    const definition = TROOP_DEFINITIONS[type as TroopType];
    if (!user || !definition) return false;
    let remaining = Math.max(1, Math.min(50, Math.floor(Number(count) || 1)));
    const optimisticCount = remaining;
    const queue = Backend.armyQueues.get(user.id) ?? [];
    const unconfirmed = Backend.armyUnconfirmed.get(user.id) ?? [];
    const cached = Backend.getCachedWorld(user.id);
    if (unconfirmed.length === 0 && cached) {
      Backend.armyAuthorityBases.set(user.id, cloneWorld(cached));
    }
    while (remaining > 0) {
      const previous = queue[queue.length - 1];
      if (previous && previous.kind === kind && previous.type === type && previous.count < 50) {
        const added = Math.min(remaining, 50 - previous.count);
        previous.count += added;
        remaining -= added;
        continue;
      }
      const operation: QueuedArmyOperation = {
        id: ++Backend.armyOperationSequence,
        kind,
        type,
        count: Math.min(50, remaining)
      };
      queue.push(operation);
      unconfirmed.push(operation);
      remaining -= operation.count;
    }
    Backend.armyQueues.set(user.id, queue);
    Backend.armyUnconfirmed.set(user.id, unconfirmed);
    if (cached) {
      Backend.memoryCache.set(user.id, rebasePendingArmy(
        cached,
        [{ kind, type, count: optimisticCount }],
        Boolean(Auth.getFeatures().infiniteResources)
      ));
    }
    Backend.scheduleArmyDrain(user.id);
    return true;
  }

  private static clearArmyOrders(userId: string) {
    const timer = Backend.armyFlushTimers.get(userId);
    if (timer !== undefined && typeof window !== 'undefined') window.clearTimeout(timer);
    Backend.armyFlushTimers.delete(userId);
    Backend.armyQueues.delete(userId);
    Backend.armyUnconfirmed.delete(userId);
    Backend.armyAuthorityBases.delete(userId);
  }

  private static async reconcileFailedArmyBatch(userId: string, error: unknown) {
    const authorityBase = Backend.armyAuthorityBases.get(userId);
    const current = Backend.getCachedWorld(userId);
    Backend.clearArmyOrders(userId);
    if (authorityBase) {
      const restored = current ? {
        ...current,
        resources: { ...authorityBase.resources },
        storage: authorityBase.storage ? { ...authorityBase.storage } : current.storage,
        army: authorityBase.army ? { ...authorityBase.army } : {},
        revision: Math.max(Number(current.revision ?? 0), Number(authorityBase.revision ?? 0))
      } : cloneWorld(authorityBase);
      Backend.setCachedWorld(userId, restored);
      Backend.announceWorldSync(restored);
    }
    try {
      const truth = await Backend.fetchOwnWorldForReconcile(userId);
      if (truth) {
        const effective = Backend.adoptRemoteWorld(userId, truth.world, truth.requestSeq, true);
        if (effective) Backend.announceWorldSync(effective);
      }
    } catch (reconcileError) {
      console.warn('Failed to reconcile rejected army batch:', reconcileError);
    }
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('clash:army-sync-failed', {
        detail: { message: error instanceof Error ? error.message : 'Army update failed' }
      }));
    }
  }

  private static drainArmyQueue(userId: string): Promise<void> {
    const existing = Backend.armyDrainPromises.get(userId);
    if (existing) return existing;
    const timer = Backend.armyFlushTimers.get(userId);
    if (timer !== undefined && typeof window !== 'undefined') window.clearTimeout(timer);
    Backend.armyFlushTimers.delete(userId);

    const task = (async () => {
      while (true) {
        const queue = Backend.armyQueues.get(userId);
        if (!queue || queue.length === 0) {
          Backend.armyQueues.delete(userId);
          return;
        }
        const batch = queue.splice(0, 50);
        const requestId = makeRequestId('army-batch');
        try {
          const authoritySeq = Backend.nextAuthorityRequest(userId);
          const result = await Backend.enqueueMutation(userId, () => Backend.postWithRetry<ArmyTransactionResult>(
            '/api/army/batch',
            {
              operations: batch.map(({ kind, type, count }) => ({ kind, type, count })),
              requestId
            }
          ));
          const confirmedIds = new Set(batch.map(operation => operation.id));
          const pending = (Backend.armyUnconfirmed.get(userId) ?? [])
            .filter(operation => !confirmedIds.has(operation.id));
          if (pending.length > 0) Backend.armyUnconfirmed.set(userId, pending);
          else Backend.armyUnconfirmed.delete(userId);

          if (result.world) {
            if (pending.length > 0) Backend.armyAuthorityBases.set(userId, cloneWorld(result.world));
            else Backend.armyAuthorityBases.delete(userId);
            const effective = Backend.adoptRemoteWorld(userId, result.world, authoritySeq, true);
            if (effective) Backend.announceWorldSync(effective);
          } else {
            if (pending.length === 0) Backend.armyAuthorityBases.delete(userId);
            Backend.adoptBalances(userId, result, authoritySeq);
          }
        } catch (error) {
          await Backend.reconcileFailedArmyBatch(userId, error);
          throw error;
        }
      }
    })();
    const tracked = task.finally(() => {
      if (Backend.armyDrainPromises.get(userId) === tracked) {
        Backend.armyDrainPromises.delete(userId);
      }
    });
    Backend.armyDrainPromises.set(userId, tracked);
    return tracked;
  }

  /** Drain every order currently known to the Backend. Attack starts call
   * this directly, so there is no latent React queue that can race reservation. */
  static async flushPendingArmy(userId?: string): Promise<void> {
    const ids = userId
      ? [userId]
      : Array.from(new Set([
        ...Backend.armyQueues.keys(),
        ...Backend.armyUnconfirmed.keys(),
        ...Backend.armyDrainPromises.keys()
      ]));
    await Promise.all(ids.map(id => Backend.drainArmyQueue(id)));
  }

  /** Compatibility helpers for callers that need an immediate acknowledged
   * single operation rather than the UI's debounced fire-and-continue path. */
  static async trainTroop(type: string, count = 1): Promise<ArmyTransactionResult | null> {
    if (!Backend.queueArmyOperation('train', type, count)) return null;
    const user = Auth.getCurrentUser();
    if (!user) return null;
    await Backend.flushPendingArmy(user.id);
    const world = Backend.getCachedWorld(user.id);
    return world ? {
      army: { ...(world.army ?? {}) },
      gold: world.resources.gold,
      ore: Number(world.resources.ore ?? 0),
      food: Number(world.resources.food ?? 0),
      revision: Number(world.revision ?? 0),
      world
    } : null;
  }

  static async untrainTroop(type: string, count = 1): Promise<ArmyTransactionResult | null> {
    if (!Backend.queueArmyOperation('untrain', type, count)) return null;
    const user = Auth.getCurrentUser();
    if (!user) return null;
    await Backend.flushPendingArmy(user.id);
    const world = Backend.getCachedWorld(user.id);
    return world ? {
      army: { ...(world.army ?? {}) },
      gold: world.resources.gold,
      ore: Number(world.resources.ore ?? 0),
      food: Number(world.resources.food ?? 0),
      revision: Number(world.revision ?? 0),
      world
    } : null;
  }

  /** Take one of today's merchant deals; the server re-derives and prices it. */
  static async merchantTrade(offerId: number): Promise<MerchantTradeResult | null> {
    if (!Auth.isOnlineMode()) return null;
    const user = Auth.getCurrentUser();
    if (!user) return null;
    const requestId = makeRequestId('trade');
    return await Backend.enqueueMutation(user.id, async () => {
      const authoritySeq = Backend.nextAuthorityRequest(user.id);
      const result = await Backend.apiPost<MerchantTradeResult>('/api/merchant/trade', { offerId, requestId });
      Backend.adoptBalances(user.id, result, authoritySeq);
      return result;
    });
  }

  /**
   * Open a server-issued bot raid. Explicit coordinates are used for a camp
   * selected on the visible world map; omitting them asks the server for a
   * cloud opponent. The stable request id makes a lost response retry safe.
   */
  static async botStart(
    x?: number,
    y?: number,
    options: { excludeCampKeys?: string[] } = {}
  ): Promise<StartedBotRaid | null> {
    if (!Auth.isOnlineMode()) return null;
    const user = Auth.getCurrentUser();
    if (!user) return null;
    try {
      await Backend.flushPendingArmy(user.id);
    } catch (error) {
      console.warn('Army synchronization failed before bot raid:', error);
      return null;
    }
    // The clean path has no active battle, so do not pay for a speculative
    // /attacks/active GET. Local recovery metadata still reconciles eagerly;
    // a remote-device conflict is handled after the start's 409 below.
    if (readRememberedBattle(user.id) || readPendingBattleStart(user.id)) {
      await Backend.reconcileInterruptedBattle({ takeover: true }).catch(error => {
        console.warn('A previous battle is still being reconciled:', error);
      });
    }
    if (readRememberedBattle(user.id) || readPendingBattleStart(user.id)) return null;
    const requestId = makeRequestId('botstart');
    const excludeCampKeys = (options.excludeCampKeys ?? [])
      .filter(key => /^-?\d+,-?\d+$/.test(key))
      .slice(-64);
    const pending: PendingBattleStart = {
      kind: 'bot-start',
      requestId,
      ...(x !== undefined && y !== undefined ? { x, y } : {}),
      ...(excludeCampKeys.length > 0 ? { excludeCampKeys } : {})
    };
    rememberPendingBattleStart(user.id, pending);
    try {
      return await Backend.enqueueMutation(user.id, async () => {
        const body = {
          ...(x !== undefined && y !== undefined ? { x, y } : {}),
          ...(excludeCampKeys.length > 0 ? { excludeCampKeys } : {}),
          requestId
        };
        const result = await Backend.postAttackStartWithTakeover<StartedBotRaid>('/api/attacks/bot-start', body, user.id);
        if (!Backend.validStartedBotRaid(result)) {
          throw new Error('Bot raid start returned an invalid world');
        }
        rememberBattle(user.id, { kind: 'bot', raidId: result.raidId, x: result.x, y: result.y });
        forgetPendingBattleStart(user.id);
        return result;
      });
    } catch (error) {
      if (Backend.terminalBattleStartFailure(error)) forgetPendingBattleStart(user.id);
      else Backend.scheduleBattleReconciliation(user.id);
      console.warn('Bot raid start failed:', error);
      return null;
    }
  }

  /**
   * Close a server-issued bot raid. A pending settlement (including its
   * request id) is kept in sessionStorage until the authoritative response
   * arrives, so reloads and dropped responses cannot orphan the army lock.
   */
  static async botSettle(
    raidId: string,
    x: number,
    y: number,
    destruction: number,
    deployed: Record<string, number>
  ): Promise<BotSettleResult | null> {
    if (!Auth.isOnlineMode() || !raidId) return null;
    const user = Auth.getCurrentUser();
    if (!user) return null;
    const remembered = readRememberedBattle(user.id);
    const priorSettle = remembered?.kind === 'bot' && remembered.raidId === raidId
      ? remembered.settle
      : undefined;
    const requestId = priorSettle?.requestId ?? makeRequestId('botsettle');
    const settlement = {
      requestId,
      destruction: priorSettle?.destruction ?? Math.max(0, Math.min(100, Number(destruction) || 0)),
      deployed: priorSettle?.deployed ?? { ...deployed }
    };
    rememberBattle(user.id, { kind: 'bot', raidId, x, y, settle: settlement });
    try {
      const commands = Backend.attackCommandStates.get(raidId);
      if (commands) await commands.chain;
      const result = await Backend.enqueueMutation(user.id, async () => {
        const authoritySeq = Backend.nextAuthorityRequest(user.id);
        const response = await Backend.postWithRetry<BotSettleResult>('/api/attacks/bot-settle', {
          raidId,
          x,
          y,
          destruction: settlement.destruction,
          deployed: settlement.deployed,
          requestId: settlement.requestId
        });
        Backend.adoptBalances(user.id, { gold: response.attackerBalance, army: response.army, revision: response.revision }, authoritySeq);
        return response;
      });
      Backend.attackCommandStates.delete(raidId);
      forgetBattle(user.id, battle => battle.kind === 'bot' && battle.raidId === raidId);
      return result;
    } catch (error) {
      const status = (error as { status?: number }).status;
      const message = error instanceof Error ? error.message : '';
      if (status === 403 || status === 404 || (status === 409 && /expired|no longer live/i.test(message))) {
        Backend.attackCommandStates.delete(raidId);
        forgetBattle(user.id, battle => battle.kind === 'bot' && battle.raidId === raidId);
      } else if (Backend.retryableRequest(error) || status === 401 || status === 429) {
        Backend.scheduleBattleReconciliation(user.id);
      }
      console.warn('Bot raid settlement failed:', error);
      return null;
    }
  }

  /** Keep the owning tab's recovery lease fresh while a battle scene is live. */
  static heartbeatActiveBattle() {
    if (!Auth.isOnlineMode()) return;
    const user = Auth.getCurrentUser();
    if (user) heartbeatBattle(user.id);
  }

  /** Finish a battle remembered by this browser tab after a reload/crash. */
  static async reconcileInterruptedBattle(options: { takeover?: boolean } = {}): Promise<void> {
    if (!Auth.isOnlineMode()) return;
    const user = Auth.getCurrentUser();
    if (!user) return;
    let activeRecord = readRememberedBattleRecord(user.id);
    const initialPendingRecord = readPendingBattleStartRecord(user.id);

    // localStorage can be cleared or blocked, and registered accounts work on
    // multiple devices. Discover the server-side lock when local recovery
    // metadata is absent. Same-token reloads can close automatically; a
    // different device is left untouched unless a new-raid click explicitly
    // requests takeover.
    if (!activeRecord && !initialPendingRecord) {
      const remote = await Backend.apiGet<{ session: ServerActiveBattle | null }>('/api/attacks/active');
      if (remote.session) {
        if (!remote.session.ownedByCurrentSession) {
          if (!options.takeover) {
            if (typeof window !== 'undefined') {
              window.dispatchEvent(new CustomEvent('clash:active-battle-elsewhere', {
                detail: { session: remote.session }
              }));
            }
            return;
          }
          const authoritySeq = Backend.nextAuthorityRequest(user.id);
          const result = await Backend.apiPost<{ world?: SerializedWorld }>('/api/attacks/active/abort', {});
          if (result.world) {
            const effective = Backend.adoptRemoteWorld(user.id, result.world, authoritySeq, true);
            if (effective) Backend.announceWorldSync(effective);
          }
          return;
        }
        const battle: RememberedBattle = remote.session.kind === 'bot'
          ? { kind: 'bot', raidId: remote.session.raidId, x: remote.session.x, y: remote.session.y }
          : { kind: 'pvp', attackId: remote.session.attackId };
        activeRecord = {
          battle,
          ownerTabId: currentBattleTabId(),
          heartbeatAt: Date.now()
        };
        rememberBattle(user.id, battle);
      }
    }

    if (activeRecord) {
      if (ownedByAnotherLiveTab(activeRecord)) {
        const wait = BATTLE_OWNER_STALE_MS - (Date.now() - activeRecord.heartbeatAt) + 250;
        Backend.scheduleBattleReconciliation(user.id, wait);
        return;
      }
      // Every document has a unique owner id. A replacement page/tab may take
      // over only after the previous document's heartbeat lease is stale.
      rememberBattle(user.id, activeRecord.battle);
      if (activeRecord.battle.kind === 'bot') {
        const settlement = activeRecord.battle.settle;
        await Backend.botSettle(
          activeRecord.battle.raidId,
          activeRecord.battle.x,
          activeRecord.battle.y,
          settlement?.destruction ?? 0,
          settlement?.deployed ?? {}
        );
      } else {
        const attackId = activeRecord.battle.attackId;
        try {
          await Backend.endAttack(attackId, 'aborted', 0, 0);
        } catch (error) {
          const status = (error as { status?: number }).status;
          if (status === 403 || status === 404) {
            forgetBattle(user.id, battle => battle.kind === 'pvp' && battle.attackId === attackId);
          } else {
            Backend.scheduleBattleReconciliation(user.id);
            throw error;
          }
        }
      }
      if (readRememberedBattle(user.id)) Backend.scheduleBattleReconciliation(user.id);
      else if (!readPendingBattleStart(user.id)) Backend.clearBattleReconciliation(user.id);
      return;
    }

    const pendingRecord = initialPendingRecord ?? readPendingBattleStartRecord(user.id);
    if (!pendingRecord) {
      Backend.clearBattleReconciliation(user.id);
      return;
    }
    if (ownedByAnotherLiveTab(pendingRecord)) {
      const wait = BATTLE_OWNER_STALE_MS - (Date.now() - pendingRecord.heartbeatAt) + 250;
      Backend.scheduleBattleReconciliation(user.id, wait);
      return;
    }

    const pending = pendingRecord.pending;
    rememberPendingBattleStart(user.id, pending);
    try {
      if (pending.kind === 'bot-start') {
        const result = await Backend.enqueueMutation(user.id, () => Backend.postWithRetry<StartedBotRaid>(
          '/api/attacks/bot-start',
          {
            ...(pending.x !== undefined && pending.y !== undefined ? { x: pending.x, y: pending.y } : {}),
            ...(pending.excludeCampKeys?.length ? { excludeCampKeys: pending.excludeCampKeys } : {}),
            requestId: pending.requestId
          }
        ));
        if (!Backend.validStartedBotRaidIdentity(result)) {
          throw new Error('Recovered bot raid start returned an invalid identity');
        }
        rememberBattle(user.id, { kind: 'bot', raidId: result.raidId, x: result.x, y: result.y });
        forgetPendingBattleStart(user.id);
        await Backend.botSettle(result.raidId, result.x, result.y, 0, {});
      } else {
        if (!pending.matchmade && !pending.targetId) {
          forgetPendingBattleStart(user.id);
          return;
        }
        const path = pending.matchmade ? '/api/attacks/matchmake' : '/api/attacks/start';
        const result = await Backend.enqueueMutation(user.id, () => Backend.postWithRetry<StartedAttack>(path, {
          ...(!pending.matchmade ? { targetId: pending.targetId } : {}),
          ...(pending.matchmade && pending.excludeTargetId ? { excludeTargetId: pending.excludeTargetId } : {}),
          ...(pending.matchmade && pending.excludeTargetIds?.length
            ? { excludeTargetIds: pending.excludeTargetIds }
            : {}),
          requestId: pending.requestId
        }));
        if (!result?.attackId || !Array.isArray(result.world?.buildings)) {
          throw new Error('Recovered attack start returned an invalid world');
        }
        rememberBattle(user.id, { kind: 'pvp', attackId: result.attackId });
        forgetPendingBattleStart(user.id);
        await Backend.endAttack(result.attackId, 'aborted', 0, 0);
      }
    } catch (error) {
      if (Backend.terminalBattleStartFailure(error)) forgetPendingBattleStart(user.id);
      else Backend.scheduleBattleReconciliation(user.id);
      throw error;
    }
    if (!readRememberedBattle(user.id) && !readPendingBattleStart(user.id)) {
      Backend.clearBattleReconciliation(user.id);
    }
  }

  /**
   * Display-only balance update. The server owns the real balance (it accrues
   * production itself), so local ticks must never trigger a network save — and
   * they update the memory cache only: stringifying the whole world into
   * localStorage every production tick was pure main-thread waste, since the
   * balance is re-fetched from the server on every load anyway.
   */
  static updateResources(userId: string, gold: number) {
    const world = Backend.memoryCache.get(userId) ?? Backend.getCachedWorld(userId);
    if (!world) return;
    const nextSol = Math.max(0, Math.floor(Number(gold) || 0));
    if (world.resources.gold === nextSol) return;
    world.resources.gold = nextSol;
    Backend.memoryCache.set(userId, world);
  }

  // ---- base editing ----

  private static armiesEqual(left: Record<string, number> | undefined, right: Record<string, number> | undefined): boolean {
    const a = left ?? {};
    const b = right ?? {};
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const key of keys) {
      if ((Math.floor(Number(a[key]) || 0)) !== (Math.floor(Number(b[key]) || 0))) return false;
    }
    return true;
  }

  /**
   * Keep the cached world's army in sync for DISPLAY. The server owns the
   * real army (train/untrain endpoints + battle consumption), so this never
   * schedules a save — the army field in a world save is ignored anyway.
   */
  static updateArmy(userId: string, army: Record<string, number>) {
    const world = Backend.getCachedWorld(userId);
    if (!world) return;
    if (Backend.armiesEqual(world.army, army)) return;
    world.army = { ...army };
    Backend.setCachedWorld(userId, world);
  }

  private static clampWallLevel(level: number): number {
    const maxWallLevel = BUILDING_DEFINITIONS.wall.maxLevel ?? 1;
    return Math.max(1, Math.min(maxWallLevel, Math.floor(level)));
  }

  private static resolveWallPlacementLevel(world: SerializedWorld): number {
    let maxPlaced = 0;
    for (const building of world.buildings) {
      if (building.type !== 'wall') continue;
      maxPlaced = Math.max(maxPlaced, Math.floor(Number(building.level) || 1));
    }
    if (maxPlaced > 0) return Backend.clampWallLevel(maxPlaced);
    const stored = Number(world.wallLevel ?? 0);
    return stored > 0 ? Backend.clampWallLevel(stored) : 1;
  }

  static async placeBuilding(userId: string, type: BuildingType, gridX: number, gridY: number): Promise<SerializedBuilding | null> {
    const world = Backend.getCachedWorld(userId);
    if (!world) return null;
    const definition = BUILDING_DEFINITIONS[type];
    if (!definition) return null;
    if (gridX < 0 || gridY < 0 || gridX + definition.width > MAP_SIZE || gridY + definition.height > MAP_SIZE) {
      return null;
    }
    for (const existing of world.buildings) {
      const existingDef = BUILDING_DEFINITIONS[existing.type as BuildingType];
      if (!existingDef) continue;
      const overlapX = Math.max(0, Math.min(gridX + definition.width, existing.gridX + existingDef.width) - Math.max(gridX, existing.gridX));
      const overlapY = Math.max(0, Math.min(gridY + definition.height, existing.gridY + existingDef.height) - Math.max(gridY, existing.gridY));
      if (overlapX > 0 && overlapY > 0) {
        return null;
      }
    }
    const level = type === 'wall' ? Backend.resolveWallPlacementLevel(world) : 1;
    const building: SerializedBuilding = { id: randomId(), type, gridX, gridY, level };
    Backend.captureLayoutBase(userId, world);
    world.buildings.push(building);
    if (type === 'wall') world.wallLevel = level;
    world.lastSaveTime = Date.now();
    Backend.setCachedWorld(userId, world);
    Backend.markLayoutEdited(userId);
    Backend.scheduleSave(userId);
    return building;
  }

  static async moveBuilding(userId: string, buildingId: string, gridX: number, gridY: number): Promise<boolean> {
    const world = Backend.getCachedWorld(userId);
    if (!world) return false;
    const target = world.buildings.find(b => b.id === buildingId);
    if (!target) return false;
    if (target.gridX === gridX && target.gridY === gridY) return true;
    Backend.captureLayoutBase(userId, world);
    target.gridX = gridX;
    target.gridY = gridY;
    world.lastSaveTime = Date.now();
    Backend.setCachedWorld(userId, world);
    Backend.markLayoutEdited(userId);
    Backend.scheduleSave(userId);
    return true;
  }

  static removeBuilding(userId: string, buildingId: string) {
    const world = Backend.getCachedWorld(userId);
    if (!world) return;
    if (!world.buildings.some(building => building.id === buildingId)) return;
    Backend.captureLayoutBase(userId, world);
    world.buildings = world.buildings.filter(b => b.id !== buildingId);
    world.lastSaveTime = Date.now();
    Backend.setCachedWorld(userId, world);
    Backend.markLayoutEdited(userId);
    Backend.scheduleSave(userId);
  }

  static upgradeBuilding(userId: string, buildingId: string): Promise<void> {
    const world = Backend.getCachedWorld(userId);
    if (!world) return Promise.resolve();
    const target = world.buildings.find(b => b.id === buildingId);
    if (!target) return Promise.resolve();
    // The server owns the upgrade clock: while it runs, there is nothing to buy.
    if (target.upgradingTo) return Promise.resolve();
    const maxLevel = BUILDING_DEFINITIONS[target.type as BuildingType]?.maxLevel ?? 1;
    const currentLevel = target.level ?? 1;
    const nextLevel = Math.min(currentLevel + 1, maxLevel);
    if (nextLevel === currentLevel) return Promise.resolve();
    Backend.captureLayoutBase(userId, world);

    if (target.type === 'wall') {
      // Walls upgrade as a cohort: every segment at the current level advances together.
      world.buildings.forEach(building => {
        if (building.type === 'wall' && (building.level ?? 1) === currentLevel) {
          building.level = nextLevel;
        }
      });
      world.wallLevel = Backend.clampWallLevel(nextLevel);
    } else {
      target.level = nextLevel;
    }

    world.lastSaveTime = Date.now();
    Backend.setCachedWorld(userId, world);
    Backend.markLayoutEdited(userId);
    return Backend.saveNow(userId);
  }

  static placeObstacle(userId: string, type: ObstacleType, gridX: number, gridY: number, id?: string) {
    const world = Backend.getCachedWorld(userId);
    if (!world) return;
    if (!world.obstacles) world.obstacles = [];
    Backend.captureLayoutBase(userId, world);
    // Keep the scene's id when given: obstacle looks (grass variants, easter
    // eggs) are hashed from the persisted id, so it must survive round-trips.
    world.obstacles.push({ id: id ?? randomId('o_'), type, gridX, gridY });
    Backend.setCachedWorld(userId, world);
    Backend.markLayoutEdited(userId);
    Backend.scheduleSave(userId);
  }

  static removeObstacle(userId: string, obstacleId: string) {
    const world = Backend.getCachedWorld(userId);
    if (!world?.obstacles) return;
    if (!world.obstacles.some(obstacle => obstacle.id === obstacleId)) return;
    Backend.captureLayoutBase(userId, world);
    world.obstacles = world.obstacles.filter(o => o.id !== obstacleId);
    Backend.setCachedWorld(userId, world);
    Backend.markLayoutEdited(userId);
    Backend.scheduleSave(userId);
  }

  // ---- bots ----

  // ---- attacks ----

  /**
   * Server picks an opponent, snapshots their base and opens the attack.
   * Returns 'no-players' when the eligible player pool is empty or the
   * NEXT-cycling exclusions exhausted it — the caller falls back to bots.
   */
  static async startMatchedAttack(options: MatchmakingOptions = {}): Promise<MatchmakeAttempt> {
    if (!Auth.isOnlineMode()) return null;
    const user = Auth.getCurrentUser();
    if (!user) return null;
    try {
      await Backend.flushPendingArmy(user.id);
    } catch (error) {
      console.warn('Army synchronization failed before matchmaking:', error);
      return null;
    }
    if (readRememberedBattle(user.id) || readPendingBattleStart(user.id)) {
      await Backend.reconcileInterruptedBattle({ takeover: true }).catch(error => {
        console.warn('A previous battle is still being reconciled:', error);
      });
    }
    if (readRememberedBattle(user.id) || readPendingBattleStart(user.id)) return null;
    const requestId = makeRequestId('matchmake');
    const excludeTargetId = typeof options.excludeTargetId === 'string' && options.excludeTargetId
      ? options.excludeTargetId
      : undefined;
    const excludeTargetIds = Array.isArray(options.excludeTargetIds)
      ? options.excludeTargetIds.filter(id => typeof id === 'string' && id.length > 0).slice(-64)
      : [];
    rememberPendingBattleStart(user.id, {
      kind: 'pvp-start',
      requestId,
      matchmade: true,
      ...(excludeTargetId ? { excludeTargetId } : {}),
      ...(excludeTargetIds.length > 0 ? { excludeTargetIds } : {})
    });
    try {
      return await Backend.enqueueMutation(user.id, async () => {
        const result = await Backend.postAttackStartWithTakeover<StartedAttack>('/api/attacks/matchmake', {
          ...(excludeTargetId ? { excludeTargetId } : {}),
          ...(excludeTargetIds.length > 0 ? { excludeTargetIds } : {}),
          requestId
        }, user.id);
        if (!result?.attackId || !Array.isArray(result.world?.buildings)
          || !Backend.validReservedArmy(result.reservedArmy)
          || !Number.isInteger(result.target?.x) || !Number.isInteger(result.target?.y)) {
          throw new Error('Matchmaking returned an invalid world');
        }
        rememberBattle(user.id, { kind: 'pvp', attackId: result.attackId });
        forgetPendingBattleStart(user.id);
        return result;
      });
    } catch (error) {
      if (Backend.terminalBattleStartFailure(error)) forgetPendingBattleStart(user.id);
      else Backend.scheduleBattleReconciliation(user.id);
      // An empty/exhausted player pool is an expected outcome, not a failure:
      // the attack flow continues into the bot-camp fallback.
      if ((error as { status?: number } | null)?.status === 404) return 'no-players';
      console.warn('Matchmaking failed:', error);
      return null;
    }
  }

  static async startAttackOnUser(targetId: string): Promise<StartedAttack | null> {
    if (!Auth.isOnlineMode()) return null;
    const user = Auth.getCurrentUser();
    if (!user) return null;
    try {
      await Backend.flushPendingArmy(user.id);
    } catch (error) {
      console.warn('Army synchronization failed before attack:', error);
      return null;
    }
    if (readRememberedBattle(user.id) || readPendingBattleStart(user.id)) {
      await Backend.reconcileInterruptedBattle({ takeover: true }).catch(error => {
        console.warn('A previous battle is still being reconciled:', error);
      });
    }
    if (readRememberedBattle(user.id) || readPendingBattleStart(user.id)) return null;
    const requestId = makeRequestId('attackstart');
    rememberPendingBattleStart(user.id, { kind: 'pvp-start', requestId, matchmade: false, targetId });
    try {
      return await Backend.enqueueMutation(user.id, async () => {
        const result = await Backend.postAttackStartWithTakeover<StartedAttack>(
          '/api/attacks/start',
          { targetId, requestId },
          user.id
        );
        if (!result?.attackId || !Array.isArray(result.world?.buildings)
          || !Backend.validReservedArmy(result.reservedArmy)
          || !Number.isInteger(result.target?.x) || !Number.isInteger(result.target?.y)) {
          throw new Error('Attack start returned an invalid world');
        }
        rememberBattle(user.id, { kind: 'pvp', attackId: result.attackId });
        forgetPendingBattleStart(user.id);
        return result;
      });
    } catch (error) {
      if (Backend.terminalBattleStartFailure(error)) forgetPendingBattleStart(user.id);
      else Backend.scheduleBattleReconciliation(user.id);
      console.warn('Attack start failed:', error);
      return null;
    }
  }

  /**
   * End the battle: the server settles loot and trophies exactly once
   * (idempotent per attackId) and notifies the defender.
   */
  static async endAttack(
    attackId: string,
    status: 'finished' | 'aborted',
    destruction: number,
    goldLooted: number,
    oreLooted = 0,
    foodLooted = 0
  ): Promise<AttackEndResult | null> {
    if (!Auth.isOnlineMode() || !attackId) return null;
    const user = Auth.getCurrentUser();
    if (!user) return null;
    try {
      const commands = Backend.attackCommandStates.get(attackId);
      if (commands) await commands.chain;
      // Give the final frames every chance to land first, but a frame endpoint
      // failure must not veto settlement. The server settles from the accepted
      // prefix; skipping /end entirely would turn an honest win into a stale
      // abort. A retained batch remains available if the end request also fails
      // and recovery retries this attack later.
      try {
        await Backend.flushReplayFrames(attackId);
      } catch (error) {
        console.warn('Final replay frames could not be uploaded; settling from accepted frames:', error);
      }
      return await Backend.enqueueMutation(user.id, async () => {
        // Settlement is idempotent server-side: retry through transient failures
        // rather than silently losing the loot and trophies to one bad request.
        const authoritySeq = Backend.nextAuthorityRequest(user.id);
        const result = await Backend.postWithRetry<AttackEndResult>('/api/attacks/end', {
          attackId,
          status,
          destruction,
          goldLooted,
          oreLooted,
          foodLooted
        });
        Backend.adoptBalances(user.id, {
          gold: typeof result.attackerBalance === 'number' ? result.attackerBalance : undefined,
          ore: typeof result.attackerOre === 'number' ? result.attackerOre : undefined,
          food: typeof result.attackerFood === 'number' ? result.attackerFood : undefined,
          army: result.army,
          revision: result.revision,
          trophies: typeof result.attackerTrophies === 'number' ? result.attackerTrophies : undefined
        }, authoritySeq);
        Backend.failedFrameBatches.delete(attackId);
        if (Backend.frameBufferAttackId === attackId) {
          Backend.frameBuffer = [];
          Backend.frameBufferAttackId = null;
        }
        Backend.attackCommandStates.delete(attackId);
        forgetBattle(user.id, battle => battle.kind === 'pvp' && battle.attackId === attackId);
        return result;
      });
    } catch (error) {
      const statusCode = (error as { status?: number } | null)?.status;
      const errorCode = (error as { code?: string } | null)?.code;
      if (statusCode === 403 || statusCode === 404 || errorCode === 'ATTACK_INVALIDATED') {
        forgetBattle(user.id, battle => battle.kind === 'pvp' && battle.attackId === attackId);
      } else if (Backend.retryableRequest(error) || statusCode === 401 || statusCode === 429) {
        Backend.scheduleBattleReconciliation(user.id);
      }
      throw error;
    }
  }

  // ---- replay capture (attacker side) ----

  private static attackCommandStates = new Map<string, { nextSequence: number; chain: Promise<void> }>();

  /**
   * Publish the compact, authoritative deploy intent. Visual replay frames are
   * sent separately and can never create troops or determine settlement.
   */
  static publishAttackDeployment(
    attackId: string,
    troop: { id: string; type: string; gridX: number; gridY: number }
  ): Promise<void> {
    if (!Auth.isOnlineMode() || !attackId) return Promise.resolve();
    let state = Backend.attackCommandStates.get(attackId);
    if (!state) {
      state = { nextSequence: 1, chain: Promise.resolve() };
      Backend.attackCommandStates.set(attackId, state);
    }
    const sequence = state.nextSequence++;
    const command = {
      type: 'DEPLOY',
      commandId: `deploy_${troop.id}`,
      sequence,
      troopInstanceId: troop.id,
      troopType: troop.type,
      gridX: troop.gridX,
      gridY: troop.gridY
    };
    state.chain = state.chain
      .catch(() => undefined)
      .then(async () => {
        try {
          const response = await Backend.postWithRetry<{ lastCommandSequence?: number }>(
            '/api/attacks/commands',
            { attackId, commands: [command] }
          );
          const accepted = Math.max(0, Math.floor(Number(response.lastCommandSequence) || sequence));
          state!.nextSequence = Math.max(state!.nextSequence, accepted + 1);
        } catch (error) {
          const status = (error as { status?: number }).status;
          const code = (error as { code?: string }).code;
          if (code === 'ATTACK_INVALIDATED' || status === 403 || status === 404 || status === 409) {
            Backend.invalidateAttackCapture(
              attackId,
              error instanceof Error ? error.message : 'That village is no longer available'
            );
          }
          throw error;
        }
      });
    return state.chain;
  }

  private static frameBuffer: ReplayFrameSnapshot[] = [];
  private static frameBufferAttackId: string | null = null;
  private static lastFrameFlush = 0;
  private static frameFlushChain: Promise<void> = Promise.resolve();
  private static pushedFrameCount = 0;
  private static failedFrameBatches = new Map<string, ReplayFrameSnapshot[]>();

  private static invalidateAttackCapture(attackId: string, message: string) {
    Backend.attackCommandStates.delete(attackId);
    Backend.failedFrameBatches.delete(attackId);
    if (Backend.frameBufferAttackId === attackId) {
      Backend.frameBuffer = [];
      Backend.frameBufferAttackId = null;
    }
    const user = Auth.getCurrentUser();
    if (user) {
      forgetBattle(user.id, battle =>
        (battle.kind === 'pvp' && battle.attackId === attackId)
        || (battle.kind === 'bot' && battle.raidId === attackId));
    }
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('clash:attack-invalidated', {
        detail: { attackId, message }
      }));
    }
  }

  static beginReplayCapture(attackId: string) {
    Backend.frameBuffer = [];
    Backend.frameBufferAttackId = attackId;
    Backend.lastFrameFlush = Date.now();
    Backend.pushedFrameCount = 0;
    if (!Backend.attackCommandStates.has(attackId)) {
      Backend.attackCommandStates.set(attackId, { nextSequence: 1, chain: Promise.resolve() });
    }
  }

  /** Buffer a frame; batches are shipped about once per second. */
  static pushAttackReplayFrame(attackId: string, frame: ReplayFrameSnapshot): number {
    if (!Auth.isOnlineMode() || !attackId) return 0;
    if (Backend.frameBufferAttackId !== attackId) Backend.beginReplayCapture(attackId);
    Backend.frameBuffer.push(frame);
    const due = Date.now() - Backend.lastFrameFlush >= FRAME_FLUSH_MS || Backend.frameBuffer.length >= FRAME_FLUSH_COUNT;
    if (due) void Backend.flushReplayFrames(attackId).catch(() => undefined);
    return Backend.pushedFrameCount + Backend.frameBuffer.length;
  }

  private static flushReplayFrames(attackId: string): Promise<void> {
    const freshFrames = Backend.frameBufferAttackId === attackId ? Backend.frameBuffer : [];
    const hasRetainedFrames = (Backend.failedFrameBatches.get(attackId)?.length ?? 0) > 0;
    if (freshFrames.length === 0 && !hasRetainedFrames) {
      return Backend.frameFlushChain;
    }
    if (Backend.frameBufferAttackId === attackId) Backend.frameBuffer = [];
    Backend.lastFrameFlush = Date.now();
    Backend.frameFlushChain = Backend.frameFlushChain
      .catch(() => undefined)
      .then(async () => {
        const queued = Backend.failedFrameBatches.get(attackId) ?? [];
        Backend.failedFrameBatches.delete(attackId);
        const byTime = new Map<number, ReplayFrameSnapshot>();
        for (const frame of [...queued, ...freshFrames]) byTime.set(frame.t, frame);
        const frames = Array.from(byTime.values()).sort((a, b) => a.t - b.t);
        let lastError: unknown = null;
        for (let attempt = 0; attempt < FRAME_SEND_ATTEMPTS; attempt++) {
          try {
            const response = await Backend.apiPost<{ frameCount?: number }>('/api/attacks/frames', { attackId, frames });
            Backend.pushedFrameCount = Math.max(0, Math.floor(Number(response.frameCount) || 0));
            return;
          } catch (error) {
            lastError = error;
            const status = (error as { status?: number }).status;
            const code = (error as { code?: string }).code;
            if (code === 'ATTACK_INVALIDATED' || status === 403 || status === 404 || status === 409) {
              Backend.invalidateAttackCapture(
                attackId,
                error instanceof Error ? error.message : 'That village is no longer available'
              );
              return;
            }
            if (!Backend.retryableRequest(error) || status === 401) break;
            if (attempt + 1 < FRAME_SEND_ATTEMPTS) {
              await new Promise(resolve => setTimeout(resolve, 250 * 2 ** attempt));
            }
          }
        }
        Backend.failedFrameBatches.set(attackId, frames);
        console.warn('Replay frame push failed; batch retained for retry:', lastError);
        throw lastError;
      });
    return Backend.frameFlushChain;
  }

  // ---- replay playback / live watch ----

  private static toReplayState(record: Record<string, unknown> | null | undefined): AttackReplayState | null {
    if (!record) return null;
    const attackId = typeof record.attackId === 'string' ? record.attackId : '';
    const enemyWorldRaw = record.enemyWorld as SerializedWorld | undefined;
    if (!attackId) return null;
    // Incremental (afterT) spectate polls are slim by design — the server
    // omits the enemy world the watcher already holds. Only the initial full
    // fetch carries it, and those callers check for it explicitly.
    const enemyWorld = enemyWorldRaw && Array.isArray(enemyWorldRaw.buildings) ? enemyWorldRaw : undefined;
    const statusRaw = typeof record.status === 'string' ? record.status : 'live';
    const frames = Array.isArray(record.frames) ? (record.frames as ReplayFrameSnapshot[]) : [];
    const finalRaw = record.finalResult as { destruction?: number; goldLooted?: number } | undefined;
    return {
      attackId,
      attackerId: typeof record.attackerId === 'string' ? record.attackerId : '',
      attackerName: typeof record.attackerName === 'string' ? record.attackerName : 'Unknown',
      victimId: typeof record.victimId === 'string' ? record.victimId : '',
      victimName: typeof record.victimName === 'string' ? record.victimName : undefined,
      status: statusRaw === 'finished' || statusRaw === 'aborted' ? statusRaw : 'live',
      startedAt: Number(record.startedAt) || Date.now(),
      updatedAt: Number(record.updatedAt) || Date.now(),
      endedAt: Number.isFinite(Number(record.endedAt)) ? Number(record.endedAt) : undefined,
      enemyWorld,
      finalResult: finalRaw
        ? {
            destruction: Math.max(0, Math.min(100, Number(finalRaw.destruction) || 0)),
            goldLooted: Math.max(0, Math.floor(Number(finalRaw.goldLooted) || 0))
          }
        : undefined,
      frameCount: frames.length,
      latestFrame: frames.length > 0 ? frames[frames.length - 1] : null,
      frames: frames.length > 0 ? frames : undefined
    };
  }

  /** One request returns the whole replay — playback can start immediately. */
  static async getAttackReplay(attackId: string): Promise<AttackReplayState | null> {
    if (!Auth.isOnlineMode() || !attackId) return null;
    const response = await Backend.apiGet<{ replay?: Record<string, unknown> }>(`/api/replays/${encodeURIComponent(attackId)}`);
    return Backend.toReplayState(response.replay ?? null);
  }

  /** Incremental fetch for spectating a live defense. */
  static async getLiveAttackState(attackId: string, afterT?: number): Promise<AttackReplayState | null> {
    if (!Auth.isOnlineMode() || !attackId) return null;
    const suffix = Number.isFinite(Number(afterT)) ? `?afterT=${Number(afterT)}` : '';
    const response = await Backend.apiGet<{ replay?: Record<string, unknown> }>(`/api/replays/${encodeURIComponent(attackId)}${suffix}`);
    return Backend.toReplayState(response.replay ?? null);
  }

  static async getIncomingAttacks(userId: string): Promise<IncomingAttackSession[]> {
    void userId;
    if (!Auth.isOnlineMode()) return [];
    const response = await Backend.apiGet<{ sessions?: IncomingAttackSession[] }>('/api/attacks/incoming');
    return response.sessions ?? [];
  }

  // ---- leaderboard & notifications ----

  static async getLeaderboard(): Promise<LeaderboardPlayer[]> {
    if (!Auth.isOnlineMode()) return [];
    const response = await Backend.apiGet<{ players?: LeaderboardPlayer[] }>('/api/leaderboard');
    return response.players ?? [];
  }

  static async getUnreadNotificationCount(userId: string): Promise<number> {
    void userId;
    if (!Auth.isOnlineMode()) return 0;
    const response = await Backend.apiGet<{ unread?: number }>('/api/notifications');
    return response.unread ?? 0;
  }

  static async getNotifications(userId: string): Promise<AttackNotification[]> {
    void userId;
    if (!Auth.isOnlineMode()) return [];
    const response = await Backend.apiGet<{ items?: Array<Record<string, unknown>> }>('/api/notifications');
    return (response.items ?? []).map(item => ({
      id: typeof item.id === 'string' && item.id ? item.id : makeRequestId('notif'),
      kind: item.kind === 'admin_notice' ? 'admin_notice' as const : 'attack' as const,
      attackId: typeof item.attackId === 'string' ? item.attackId : undefined,
      attackerId: typeof item.attackerId === 'string' ? item.attackerId : undefined,
      attackerName: typeof item.attackerName === 'string' && item.attackerName
        ? item.attackerName
        : item.kind === 'admin_notice' ? 'Kingdom notice' : 'Unknown',
      title: typeof item.title === 'string' ? item.title : undefined,
      message: typeof item.message === 'string' ? item.message : undefined,
      severity: item.severity === 'warning' || item.severity === 'critical' ? item.severity : 'info',
      goldLost: typeof item.goldLost === 'number' ? item.goldLost : undefined,
      oreLost: typeof item.oreLost === 'number' ? item.oreLost : undefined,
      foodLost: typeof item.foodLost === 'number' ? item.foodLost : undefined,
      destruction: Math.max(0, Math.floor(Number(item.destruction) || 0)),
      trophyDelta: typeof item.trophyDelta === 'number' ? item.trophyDelta : undefined,
      timestamp: Math.max(0, Math.floor(Number(item.time) || Date.now())),
      read: Boolean(item.read),
      replayAvailable: Boolean(item.replayAvailable)
    }));
  }

  static async markNotificationsRead(userId: string) {
    void userId;
    if (!Auth.isOnlineMode()) return;
    await Backend.apiPost('/api/notifications/read', {});
  }
}
