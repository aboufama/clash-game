import { randomBytes } from 'node:crypto'
import { BUILDING_DEFINITIONS, GENERATED_ONLY, STARTER_VILLAGE, TROOP_DEFINITIONS, createStarterVillage, getTroopStats, isTrainableTroopType, normalizeTroopLevel, troopFoodCostOf, troopTrainingRequirement, type BuildingType, type TroopType } from '../src/game/config/GameDefinitions'
import {
  BOT_RAID_COOLDOWN_MS,
  RAIDABLE_SHARE,
  armySpaceUsed,
  campCapacityOf,
  barracksLevelForTroop,
  maxCompletedArmyCampLevel,
  merchantOffersFor,
  isWildernessPreserveAt,
  resourceCapacity,
  storehouseProtection,
  watchtowerSightOf,
  worldDayIndex
} from '../src/game/config/Economy'
import { clearWorldHydrologyCache } from '../src/game/config/WorldHydrology'
import { sanitizeVillageBanner, villageBannersEqual, type SerializedBuilding, type SerializedObstacle, type SerializedWorld, type VillageBanner } from '../src/game/data/Models'
import type {
  AttackNotificationItem,
  AttackRecord,
  EndAttackResponse,
  IncomingAttack,
  LeaderboardEntry,
  PlayerProfile,
  PublicWorldSnapshot,
  ReplayFrame,
  SessionResponse,
  StartedAttackResponse
} from './protocol'
import { MATCHMAKE_EXCLUSION_LIMIT, type MatchmakeRequest } from './runtime/contracts'
import { JsonCollection } from './store'
import {
  ATTACK_SIMULATION_VERSION,
  applyAttackCommand,
  applyBotAttackCommand,
  AttackDomainError,
  cancelAttack,
  combatSnapshotHash,
  engageAttack,
  expireAttack,
  finalizeAttack,
  prepareAttack,
  prepareBotAttack,
  settleAttack,
  type AttackAggregate,
  type AttackCommand,
  type CombatVillageSnapshot,
  type ReservableTroopType,
  type TroopCounts
} from './attack-domain'
import type {
  AdminAccessState,
  AdminApiService,
  AdminAttackSummary,
  AdminAuditEntry,
  AdminBotSummary,
  AdminConfig,
  AdminEconomy,
  AdminMutationResult,
  AdminOperationRequest,
  AdminOverview,
  AdminPlayerActionRequest,
  AdminPlayerDetail,
  AdminPlayerSummary
} from './admin-contract'
import {
  STARTING_POPULATION,
  VillageRuleError,
  advanceVillage,
  appearanceRevisionDelta,
  populationCapacity,
  priceVillageMutation,
  sameCombatLayout,
  sanitizeArmy,
  sanitizeBuildings,
  sanitizeObstacles,
  normalizePersistedBuildings,
  staffingFactor,
  troopLevelOf,
  validateVillageLayout,
  withoutCollidingObstacles,
  workersNeeded
} from './domain/village'
import {
  InMemoryAuthRateLimiter,
  guestSessionsAllowed,
  hashPassword,
  hashSessionToken as hashToken,
  isValidUsername,
  issueSessionToken,
  migrateLegacyTokenHashes,
  normalizeSessionToken,
  normalizeUsernameKey,
  registrationRequiredResponse,
  revokeSessionToken,
  validateRegistrationCredentials,
  verifyPassword,
  type RegistrationRequiredResponse
} from './domain/auth'
import {
  CURRENT_WORLD_GENERATION_VERSION,
  DEFAULT_GUEST_PLOT_TTL_MS,
  LEGACY_WORLD_ID,
  MAX_WORLD_COORDINATE,
  WORLD_PLOT_RADIUS,
  allocateNextPlayerPlot,
  allocationOrdinalOf,
  botFrontierRadiusForCursor,
  classifyPlot,
  coordinateAtAllocationOrdinal,
  createAllocationIndex,
  INITIAL_WORLD_PRESENTATION_SEED_VERSION,
  isSpiralSettleable,
  nextWorldPresentationSeedVersion,
  normalizeAllocationIndex,
  normalizeWorldPresentationSeedVersion,
  persistentBotVillageIdAt,
  releasePlayerPlotForTopology,
  settledFrontierBotVillageSeedAt,
  spiralHoleOrdinalsBelowCursor,
  type ReleasedPlotSlot,
  type WorldAllocationIndex
} from './domain/world'
import {
  PROCEDURAL_VILLAGE_GENERATOR_VERSION,
  generateProceduralVillage,
  proceduralVillageDifficulty,
  proceduralVillageTrophies
} from './domain/world/procedural-village'
import { PlayerDirectory } from './domain/player'
import { RequestReplayIndex } from './domain/idempotency'
import { ApiError, bannerRequiredError } from './errors'
export { ApiError } from './errors'

const MAX_BALANCE = 1_000_000_000
const ADMIN_PLAYER_LIMIT = 100
const ADMIN_BOT_LIMIT = 200
const ADMIN_ATTACK_LIMIT = 200
const ADMIN_AUDIT_LIMIT = 250
const ADMIN_BOT_RADIUS = 127
const MAX_ADMIN_AUDIT_RECORDS = 10_000
const ADMIN_CONFIG_KEY = 'main'

// Upgrade clocks run at real duration (upgradeDurationMs) times this scale.
// Tests set CLASH_UPGRADE_TIME_SCALE=0.001 so cheap upgrades mature within a
// round trip while expensive ones stay observable as pending.
const UPGRADE_TIME_SCALE = (() => {
  const raw = Number(process.env.CLASH_UPGRADE_TIME_SCALE ?? '1')
  return Number.isFinite(raw) && raw >= 0 ? raw : 1
})()

// Local development can use one exact duration for every timed upgrade.
// Production leaves this unset and continues to use the normal scaled clock.
const FIXED_UPGRADE_DURATION_MS = (() => {
  const configured = process.env.CLASH_UPGRADE_DURATION_MS
  if (configured === undefined || configured.trim() === '') return undefined
  const raw = Number(configured)
  return Number.isFinite(raw) && raw >= 0 ? Math.round(raw) : undefined
})()

// ---- ore & food ----
// Two server-authoritative resources, persisted per player and spendable
// through the same idempotent /resources/apply endpoint as GOLD. Mines dig
// ore (gates building/wall upgrades) and farms grow food (feeds population
// growth); production accrues in accrue() at the staffed rate and is capped
// by storehouse capacity.
type ResourceKind = 'gold' | 'ore' | 'food'
const MAX_REQUEST_KEYS = 400
const MAX_REPLAY_FRAMES = 900
const MAX_REPLAY_BYTES = 2 * 1024 * 1024
const MAX_TOTAL_REPLAY_BYTES = 64 * 1024 * 1024
const MAX_NOTIFICATIONS = 50
/** New villages get a grace period before the wolves may descend (env-tunable for tests). */
const STARTER_SHIELD_MS = Number(process.env.CLASH_STARTER_SHIELD_MS ?? 2 * 60 * 60 * 1000)
/** Post-raid shields scale with how badly the defence was breached. */
function shieldForDestruction(destruction: number): number {
  if (destruction >= 90) return 4 * 60 * 60 * 1000
  if (destruction >= 50) return 2 * 60 * 60 * 1000
  if (destruction >= 30) return 60 * 60 * 1000
  return 0
}
const MAX_REVENGE_RIGHTS = 3
const MAX_REVENGE_OPPONENTS = 32
const REVENGE_RIGHT_TTL_MS = 48 * 60 * 60 * 1000

interface RevengeRight {
  count: number
  expiresAt: number
  /** Read-only import compatibility; canonical saves always replace it with expiresAt. */
  grantedAt?: number
}

// The only positive /resources/apply deltas a normal client may send: the tiny
// ambient grants earned by village theatre (villagers hauling what the player
// taps). Size-capped per call and per rolling hour; everything else that adds
// resources is priced by a dedicated server-side transaction.
const AMBIENT_GRANTS: Record<string, { kind: 'ore' | 'food'; perCall: number; perHour: number }> = {
  egg_collect: { kind: 'food', perCall: 90, perHour: 500 },
  rock_haul: { kind: 'ore', perCall: 25, perHour: 250 }
}

const MAX_REPLAYS_PER_VICTIM = 50
// An attack that has started streaming frames but goes silent this long is treated as a crashed attacker.
const LIVE_ATTACK_STALE_MS = Math.max(100, Number(process.env.CLASH_LIVE_ATTACK_STALE_MS ?? 90_000))
// A registered attack with no frames yet (attacker still choosing troops) gets a longer grace window,
// and no attack may stay live past the hard cap.
const PENDING_ATTACK_STALE_MS = 10 * 60_000
const MAX_ATTACK_DURATION_MS = 15 * 60_000
const ONLINE_WINDOW_MS = 60_000
// lastSeen only feeds the 60s "online" indicator, so persisting it this often is plenty.
const LAST_SEEN_PERSIST_MS = 30_000
// A registered account can be signed in on this many devices at once; the oldest session is evicted.
const MAX_SESSIONS_PER_PLAYER = 8
const LOGIN_MAX_FAILURES = 8
const LOGIN_LOCKOUT_MS = 60_000
const LOGIN_ADDRESS_WINDOW_MS = 60_000
const LOGIN_ADDRESS_ATTEMPT_LIMIT = Math.max(1, Number(process.env.CLASH_LOGIN_ATTEMPTS_PER_MINUTE ?? 30))
const GUEST_CREATION_WINDOW_MS = 60 * 60_000
const GUEST_CREATION_LIMIT = Math.max(1, Number(process.env.CLASH_GUEST_LIMIT_PER_HOUR ?? 30))
const WORLD_COORD_LIMIT = MAX_WORLD_COORDINATE
// Homes stay two cells inside the world envelope so the maximum earned 5x5
// watchtower window is never clipped. The outer band remains available to
// visible wilderness/bot camps and battle-map context.
const HOME_COORD_LIMIT = WORLD_COORD_LIMIT - 2
// One main server for now: the atlas lists literally everyone, capped at the
// server's intended player capacity. Multi-server paging can come later.
const ATLAS_PLAYER_LIMIT = 1000
const BOT_RAID_SESSION_MS = 15 * 60_000
const MAX_FINISHED_BOT_RAIDS = 500
const MAX_BOT_RAID_COOLDOWNS = 128
// Hard caps on client-supplied collections, to keep one request from exhausting memory.
const MAX_FRAME_BUILDINGS = 800
const MAX_FRAME_TROOPS = 600
const MAX_FRAMES_PER_PUSH = 240
const MAX_FRAME_CLOCK_LEAD_MS = 1_500
/** Temporary test/import bridge. Production clients must publish commands explicitly. */
const ALLOW_LEGACY_FRAME_COMMANDS = process.env.CLASH_ALLOW_LEGACY_FRAME_COMMANDS === '1'
// Replay capture is buffered before the first HTTP batch reaches the server.
// Grant one bounded second so honest first volleys are not lost to receipt time.
const DEPLOYMENT_RECEIPT_ALLOWANCE_MS = 1_000
const MAX_COMBAT_CREDIT_MS = 75_000

/** Persistent per-player record. Balance is a float internally; clients always see floor(balance). */
interface PlayerRecord {
  id: string
  /** Active session tokens (hashed). Guests have exactly one; registered accounts one per device. */
  tokenHashes: string[]
  /** Lowercase username, present (and globally unique) only once the account is registered. */
  usernameKey?: string
  /** `scrypt:<salt>:<hash>`; presence marks the account as registered. */
  passwordHash?: string
  username: string
  createdAt: number
  lastSeen: number
  trophies: number
  /** Permanent coordinates on the global village grid (see WORLD MAP below). */
  plotX?: number
  plotY?: number
  /** Increments whenever the village vacates or reclaims a plot. */
  plotVersion?: number
  /** Guests hold renewable leases; registered accounts own permanent plots. */
  plotLeaseId?: string
  plotLeaseExpiresAt?: number
  /** Dev-reseed caller override: its real village survives generated topology changes. */
  worldTopologyPinned?: true
  /** Post-raid protection: no one can start an attack on this base until then. */
  shieldUntil?: number
  /** attackerId -> bounded, expiring revenge attacks (each pierces their shield once). */
  revengeRights?: Record<string, RevengeRight | number>
  /** "x,y" -> last time this player looted that bot camp (cooldown gate). */
  botRaids?: Record<string, number>
  /** Dedicated merchant redemption ledger; not evictable by generic request ids. */
  merchantRedemptions?: Record<string, number>
  /** Dedicated bot WAL application keys; generic request ids cannot evict these. */
  botSettlements?: Record<string, number>
  /** Dedicated PvP WAL application keys. */
  battleSettlements?: Record<string, number>
  /** Dedicated attack-start WAL application keys. */
  attackStarts?: Record<string, number>
  balance: number
  lastAccrualAt: number
  // Real "layout/economy changed" time — drives client freshness checks. Unlike lastAccrualAt,
  // it is NOT bumped by passive production reads.
  lastMutationAt: number
  revision: number
  buildings: SerializedBuilding[]
  obstacles: SerializedObstacle[]
  army: Record<string, number>
  wallLevel: number
  requestKeys: string[]
  /** Village inhabitants; grows toward the layout's housing capacity over time. */
  population: { count: number; lastGrowthAt: number; bornAt?: number[] }
  /** Raw ore stock — mine output, spent on upgrades. Integer. */
  ore: number
  /** Food stores — farm output, feeds population growth. Integer. */
  food: number
  /** Fractional mine/farm output carried across short accrual slices. */
  productionRemainders?: { ore: number; food: number }
  /** Versioned deterministic lazy-simulation checkpoint. */
  simulationVersion?: number
  simulatedThrough?: number
  /** Public presentation revisions are independent from private economy writes. */
  layoutRevision?: number
  appearanceRevision?: number
  /** Owner-chosen village heraldry; absent means onboarding is incomplete. */
  banner?: VillageBanner
}

interface AdminNoticeItem {
  id: string
  kind: 'admin_notice'
  title: string
  message: string
  severity: 'info' | 'warning' | 'critical'
  time: number
  read: boolean
}

type LegacyNotificationItem = AttackNotificationItem | AdminNoticeItem

interface NotificationRecord {
  items: LegacyNotificationItem[]
}

interface AdminModerationRecord {
  playerId: string
  state: AdminAccessState
  reason: string | null
  until: number | null
  updatedAt: number
  revision: number
}

interface AdminRuntimeConfigRecord {
  maintenanceEnabled: boolean
  maintenanceMessage: string | null
  updatedAt: number
  revision: number
}

interface LegacyAdminAuditRecord extends AdminAuditEntry {}

interface WorldStateRecord {
  allocation: WorldAllocationIndex
  releasedSlots: ReleasedPlotSlot[]
  /** Mutable topology epoch for bots, preserves, hydrology and all generated nature. */
  presentationSeedVersion: number
  /** Epoch for which allocation/released slots were rebuilt. Missing means legacy epoch zero. */
  allocationSeedVersion?: number
  /**
   * Settlement-model marker. Missing/1 = the pre-spiral world whose admission
   * skipped bot ordinals; 2 = central bot ordinals below the cursor have been
   * indexed as free slots once, so new accounts fill the world center first.
   */
  spiralModelVersion?: number
}

/** Durable JSON-authority counterpart of the PostgreSQL bot_villages row. */
interface LegacyBotVillageRecord {
  id: string
  worldId: string
  x: number
  y: number
  plotVersion: number
  worldGenerationVersion: number
  presentationSeedVersion: number
  generatorVersion: number
  seed: number
  username: string
  trophies: number
  profile: { difficulty: string; generator: string; generatorVersion: number }
  world: SerializedWorld
  revision: number
  createdAt: number
  updatedAt: number
}

type LeaderboardSnapshotRow = Omit<LeaderboardEntry, 'online' | 'inScoutRange'>

interface SettlementRecord {
  attackId: string
  state: 'prepared' | 'committed'
  status: 'finished' | 'aborted'
  endedAt: number
  destruction: number
  goldLooted: number
  oreLooted: number
  foodLooted: number
  trophyDelta: number
  deployed: Record<string, number>
}

interface BotRaidRecord {
  raidId: string
  attackerId: string
  x: number
  y: number
  seed: number
  botId?: string
  botVillageRevision?: number
  botPlotVersion?: number
  botGeneratorVersion?: number
  visibleAtStart: boolean
  status: 'live' | 'settling' | 'finished' | 'aborted'
  startedAt: number
  expiresAt: number
  reservedArmy: Record<string, number>
  /** Server-authoritative lab level captured before the raid leaves home. */
  troopLevel: number
  /** The same deterministic command aggregate used by PLAYER attacks. */
  authority?: AttackAggregate
  startRequestId?: string
  /** Hash of the device token that opened the raid. Internal only. */
  ownerTokenHash?: string
  settleRequestId?: string
  preparedSettlement?: {
    lootApplied: number
    botRevisionBefore: number
    botRevisionAfter: number
    botGoldAfter: number
    deployed: Record<string, number>
    destruction?: number
    resultHash?: string
    settledAt: number
  }
  finalResult?: { lootApplied: number; attackerBalance: number; army: Record<string, number>; revision: number }
}

/**
 * One world-day of economy flow, for tuning: what entered the economy
 * (faucets), what left it (sinks), what merely changed hands (loot), and what
 * came back (refunds). If faucets persistently outrun sinks, prices are too
 * low or production too high — the ledger turns that from a feeling into a number.
 */
interface LedgerDay {
  day: number
  faucets: { gold: number; ore: number; food: number }
  sinks: { gold: number; ore: number; food: number }
  refunds: { gold: number; ore: number; food: number }
  loot: { gold: number; ore: number; food: number }
  counts: { saves: number; trades: number; battles: number; botRaids: number }
}

function emptyLedgerDay(day: number): LedgerDay {
  return {
    day,
    faucets: { gold: 0, ore: 0, food: 0 },
    sinks: { gold: 0, ore: 0, food: 0 },
    refunds: { gold: 0, ore: 0, food: 0 },
    loot: { gold: 0, ore: 0, food: 0 },
    counts: { saves: 0, trades: 0, battles: 0, botRaids: 0 }
  }
}

function plotKey(x: number, y: number) {
  return `${x},${y}`
}

function clampInt(raw: unknown, min: number, max: number, fallback: number): number {
  const n = typeof raw === 'string' ? Number.parseInt(raw, 10) : typeof raw === 'number' ? Math.floor(raw) : NaN
  if (!Number.isFinite(n)) return fallback
  return Math.max(min, Math.min(max, n))
}

function worldCoord(raw: unknown, fallback: number): number {
  if (raw === undefined || raw === null || raw === '') return fallback
  const n = typeof raw === 'string' ? Number(raw) : raw
  if (typeof n !== 'number' || !Number.isInteger(n) || n < -WORLD_COORD_LIMIT || n > WORLD_COORD_LIMIT) {
    throw new ApiError(400, 'Plot coordinates are outside the world')
  }
  return n
}

function randomHex(bytes: number) {
  return randomBytes(bytes).toString('hex')
}

function toInt(value: unknown, fallback: number) {
  const n = Number(value)
  return Number.isFinite(n) ? Math.floor(n) : fallback
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value))
}

function debugGrantsEnabled(): boolean {
  return process.env.CLASH_ALLOW_DEBUG_GRANTS === '1'
}

function infiniteResourcesEnabled(): boolean {
  return process.env.CLASH_INFINITE_RESOURCES === '1'
}

/** Apply storage rules, preserving existing overflow only in debug mode. */
function storedResourceAfterDelta(
  current: number,
  delta: number,
  capacity: number,
  allowOverflow = false,
  preserveOverflow = false
): number {
  const stored = clamp(toInt(current, 0), 0, MAX_BALANCE)
  if (allowOverflow) return clamp(stored + delta, 0, MAX_BALANCE)
  if (!preserveOverflow) return clamp(stored + delta, 0, capacity)
  if (delta <= 0) return Math.max(0, stored + delta)
  if (stored >= capacity) return stored
  return Math.min(capacity, stored + delta)
}

function hasOwn(record: object, key: PropertyKey): boolean {
  return Object.prototype.hasOwnProperty.call(record, key)
}

/** Whether a presentation-only generated troop has evidence of its trained
 * root in this attack. Roman Warriors are released by a Phalanx on death;
 * summoned types use the declarative summonType relationship. Exported so a
 * narrow regression can pin replay filtering and lease-refresh authority. */
export function generatedTroopHasRootDeployment(
  type: string,
  deployedCounts: Readonly<Record<string, number>>
): boolean {
  if (!GENERATED_ONLY.has(type)) return false
  if (type === 'romanwarrior') return (deployedCounts.phalanx ?? 0) > 0
  return Object.values(TROOP_DEFINITIONS).some(definition =>
    definition.summonType === type && (deployedCounts[definition.id] ?? 0) > 0)
}

function sanitizeId(value: unknown): string {
  return String(value ?? '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 96)
}

function isAttackNotification(item: LegacyNotificationItem): item is AttackNotificationItem {
  return !('kind' in item) || item.kind !== 'admin_notice'
}

function adminInteger(raw: unknown, name: string, minimum: number, maximum: number): number {
  const parsed = Number(raw)
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new ApiError(400, `${name} must be an integer between ${minimum} and ${maximum}`, 'ADMIN_INVALID_INPUT')
  }
  return parsed
}

function adminOptionalText(raw: unknown, name: string, maximum: number): string | null {
  if (raw === undefined || raw === null) return null
  if (typeof raw !== 'string') throw new ApiError(400, `${name} must be text`, 'ADMIN_INVALID_INPUT')
  const value = raw.trim()
  if (value.length > maximum) {
    throw new ApiError(400, `${name} may not exceed ${maximum} characters`, 'ADMIN_INVALID_INPUT')
  }
  return value || null
}

function adminRequiredText(raw: unknown, name: string, maximum: number): string {
  const value = adminOptionalText(raw, name, maximum)
  if (!value) throw new ApiError(400, `${name} is required`, 'ADMIN_INVALID_INPUT')
  return value
}

function adminReason(raw: unknown): string {
  const reason = adminRequiredText(raw, 'reason', 500)
  if (reason.length < 3) {
    throw new ApiError(400, 'reason must contain at least 3 characters', 'ADMIN_INVALID_INPUT')
  }
  return reason
}

function adminSafeId(raw: unknown, label: string): string {
  const value = adminRequiredText(raw, label, 96)
  if (sanitizeId(value) !== value) throw new ApiError(400, `${label} is invalid`, 'ADMIN_INVALID_INPUT')
  return value
}

function adminAttackStateOf(
  phase: AttackAggregate['phase'] | undefined,
  fallback: 'live' | 'finished' | 'aborted'
): AdminAttackSummary['state'] {
  if (phase) return phase.toLowerCase() as AdminAttackSummary['state']
  if (fallback === 'finished') return 'settled'
  if (fallback === 'aborted') return 'cancelled'
  return 'preparing'
}

/** Bounded strict NEXT-cycling exclusion list (see MatchmakeRequest). */
function parseMatchmakeExclusions(value: unknown): Set<string> {
  if (value === undefined) return new Set()
  if (!Array.isArray(value) || value.length > MATCHMAKE_EXCLUSION_LIMIT) {
    throw new ApiError(400, `excludeTargetIds must be an array of at most ${MATCHMAKE_EXCLUSION_LIMIT} ids`)
  }
  return new Set(value.map(entry => strictSafeId(entry, 'excludeTargetIds entry')))
}

function strictSafeId(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{1,120}$/.test(value)) {
    throw new ApiError(400, `${label} must be a safe identifier`)
  }
  return value
}

function sanitizeFrame(raw: unknown): ReplayFrame | null {
  if (!raw || typeof raw !== 'object') return null
  const frame = raw as Partial<ReplayFrame>
  const buildings = Array.isArray(frame.buildings)
    ? frame.buildings.slice(0, MAX_FRAME_BUILDINGS).flatMap(entry => {
        const id = sanitizeId((entry as { id?: unknown })?.id)
        if (!id) return []
        return [{
          id,
          health: Math.max(0, toInt((entry as { health?: unknown }).health, 0)),
          isDestroyed: Boolean((entry as { isDestroyed?: unknown }).isDestroyed)
        }]
      })
    : []
  const troops = Array.isArray(frame.troops)
    ? frame.troops.slice(0, MAX_FRAME_TROOPS).flatMap(entry => {
        const troop = entry as unknown as Record<string, unknown>
        const id = sanitizeId(troop?.id)
        const type = sanitizeId(troop?.type)
        if (!id || !type) return []
        const facing = Number(troop.facingAngle)
        return [{
          id,
          type,
          level: Math.max(1, toInt(troop.level, 1)),
          owner: troop.owner === 'ENEMY' ? 'ENEMY' as const : 'PLAYER' as const,
          gridX: Number(troop.gridX) || 0,
          gridY: Number(troop.gridY) || 0,
          ...(Number.isFinite(Number(troop.visualOffsetY))
            ? { visualOffsetY: clamp(Number(troop.visualOffsetY), -100, 100) }
            : {}),
          health: Math.max(0, Number(troop.health) || 0),
          maxHealth: Math.max(1, Number(troop.maxHealth) || 1),
          ...(Number.isFinite(facing) ? { facingAngle: facing } : {}),
          hasTakenDamage: Boolean(troop.hasTakenDamage)
        }]
      })
    : []
  return {
    t: Math.max(0, toInt(frame.t, 0)),
    destruction: clamp(Number(frame.destruction) || 0, 0, 100),
    // Accept the Solana-era field name from stale clients for one version.
    goldLooted: Math.max(0, toInt(frame.goldLooted ?? (raw as { solLooted?: unknown }).solLooted, 0)),
    oreLooted: Math.max(0, toInt(frame.oreLooted, 0)),
    foodLooted: Math.max(0, toInt(frame.foodLooted, 0)),
    buildings,
    troops
  }
}

function serializedBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), 'utf8')
}

/** Serialized replay bytes including the byteSize field itself, at its stable value. */
function exactReplayBytes(replay: AttackRecord): number {
  let guess = Number.isFinite(replay.byteSize) ? Math.max(0, Math.floor(replay.byteSize ?? 0)) : 0
  for (let attempt = 0; attempt < 8; attempt++) {
    const measured = serializedBytes({ ...replay, byteSize: guess })
    if (measured === guess) return measured
    guess = measured
  }
  return serializedBytes({ ...replay, byteSize: guess })
}

function chebyshevDistance(ax: number, ay: number, bx: number, by: number): number {
  return Math.max(Math.abs(ax - bx), Math.abs(ay - by))
}

function appearanceRevisionOf(player: PlayerRecord): number {
  return Math.max(0, toInt(player.appearanceRevision, player.revision))
}

function publicWorldOf(player: PlayerRecord): PublicWorldSnapshot {
  return {
    id: `world_${player.id}`,
    ownerId: player.id,
    username: player.username,
    buildings: player.buildings.map(building => ({ ...building })),
    obstacles: player.obstacles.map(obstacle => ({ ...obstacle })),
    wallLevel: player.wallLevel,
    lastSaveTime: player.lastMutationAt || player.lastAccrualAt,
    revision: appearanceRevisionOf(player),
    life: {
      version: 1,
      identity: player.id,
      population: player.population.count,
      bornAt: [...(player.population.bornAt ?? [])],
      simulatedThrough: player.simulatedThrough ?? player.lastAccrualAt
    },
    ...(player.banner ? { banner: { ...player.banner } } : {})
  }
}

function parseKnownRevisions(raw: unknown): Map<string, { ownerId: string; revision: number }> {
  const known = new Map<string, { ownerId: string; revision: number }>()
  if (typeof raw !== 'string') return known
  // Wire format: "x,y:ownerId:revision;x,y:ownerId:revision". URLSearchParams has already
  // decoded the individual components by the time this runs.
  for (const pair of raw.split(';').slice(0, 100)) {
    const revisionAt = pair.lastIndexOf(':')
    const ownerAt = pair.lastIndexOf(':', revisionAt - 1)
    if (ownerAt <= 0 || revisionAt <= ownerAt) continue
    const key = pair.slice(0, ownerAt)
    if (!/^-?\d+,-?\d+$/.test(key)) continue
    const ownerId = sanitizeId(pair.slice(ownerAt + 1, revisionAt))
    const revision = toInt(pair.slice(revisionAt + 1), -1)
    if (ownerId && revision >= 0) known.set(key, { ownerId, revision })
  }
  return known
}

export class GameService implements AdminApiService {
  private readonly players: JsonCollection<PlayerRecord>
  private readonly replays: JsonCollection<AttackRecord>
  private readonly notifications: JsonCollection<NotificationRecord>
  private readonly ledger: JsonCollection<LedgerDay>
  private readonly settlements: JsonCollection<SettlementRecord>
  private readonly botRaidSessions: JsonCollection<BotRaidRecord>
  private readonly botVillages: JsonCollection<LegacyBotVillageRecord>
  private readonly worldState: JsonCollection<WorldStateRecord>
  private readonly adminModeration: JsonCollection<AdminModerationRecord>
  private readonly adminRuntimeConfig: JsonCollection<AdminRuntimeConfigRecord>
  private readonly adminAuditLog: JsonCollection<LegacyAdminAuditRecord>
  private allocationState: WorldStateRecord
  private readonly tokenIndex = new Map<string, string>()
  private readonly playerDirectory = new PlayerDirectory()
  private readonly startRequestIndex = new RequestReplayIndex()
  /** lowercase username -> playerId, registered accounts only */
  private readonly usernameIndex = new Map<string, string>()
  private readonly authLimiter = new InMemoryAuthRateLimiter({
    loginMaximumFailures: LOGIN_MAX_FAILURES,
    loginLockoutMs: LOGIN_LOCKOUT_MS,
    loginAddressWindowMs: LOGIN_ADDRESS_WINDOW_MS,
    loginAddressAttemptLimit: LOGIN_ADDRESS_ATTEMPT_LIMIT,
    guestCreationWindowMs: GUEST_CREATION_WINDOW_MS,
    guestCreationLimit: GUEST_CREATION_LIMIT
  })
  /** victimId -> attackIds currently live against that base */
  private readonly liveByVictim = new Map<string, Set<string>>()
  /** attackerId -> its one currently-live attack */
  private readonly liveByAttacker = new Map<string, string>()
  /** attackerId -> its one currently-live bot raid */
  private readonly liveBotByAttacker = new Map<string, string>()
  /** Bounded newest-first cleanup index; rebuilt once at boot, never by a request scan. */
  private readonly finishedBotRaids: Array<{ raidId: string; startedAt: number }> = []
  private readonly finishedBotRaidIds = new Set<string>()
  /** playerId -> when lastSeen was last persisted; throttles pure-presence disk writes */
  private readonly lastSeenPersistedAt = new Map<string, number>()
  /** playerId -> rolling-hour ambient grant totals (egg/rock micro-income rate cap) */
  private readonly grantWindows = new Map<string, { startedAt: number; granted: Record<string, number> }>()
  /** Global map: plot "x,y" -> playerId. Rebuilt from player records on boot. */
  private plotIndex = new Map<string, string>()
  private replayBytesTotal = 0
  private leaderboardCache: { expiresAt: number; rows: LeaderboardSnapshotRow[] } | null = null

  constructor(dataRoot: string) {
    this.players = new JsonCollection<PlayerRecord>(dataRoot, 'players')
    // Replays are large and append-heavy while an attack streams in; a longer debounce
    // avoids re-serializing a growing multi-MB record every 150ms.
    this.replays = new JsonCollection<AttackRecord>(dataRoot, 'replays', 2000)
    this.notifications = new JsonCollection<NotificationRecord>(dataRoot, 'notifications')
    this.ledger = new JsonCollection<LedgerDay>(dataRoot, 'ledger')
    this.settlements = new JsonCollection<SettlementRecord>(dataRoot, 'settlements')
    this.botRaidSessions = new JsonCollection<BotRaidRecord>(dataRoot, 'bot-raids')
    this.botVillages = new JsonCollection<LegacyBotVillageRecord>(dataRoot, 'bot-villages')
    this.worldState = new JsonCollection<WorldStateRecord>(dataRoot, 'world-state')
    this.adminModeration = new JsonCollection<AdminModerationRecord>(dataRoot, 'admin-moderation')
    this.adminRuntimeConfig = new JsonCollection<AdminRuntimeConfigRecord>(dataRoot, 'admin-config')
    this.adminAuditLog = new JsonCollection<LegacyAdminAuditRecord>(dataRoot, 'admin-audit')
    if (!this.adminRuntimeConfig.get(ADMIN_CONFIG_KEY)) {
      this.adminRuntimeConfig.set(ADMIN_CONFIG_KEY, {
        maintenanceEnabled: false,
        maintenanceMessage: null,
        updatedAt: Date.now(),
        revision: 1
      })
    }
    const storedWorldState = this.worldState.get(LEGACY_WORLD_ID)
    this.allocationState = storedWorldState
      ? {
          ...storedWorldState,
          presentationSeedVersion: normalizeWorldPresentationSeedVersion(storedWorldState.presentationSeedVersion),
          allocationSeedVersion: normalizeWorldPresentationSeedVersion(storedWorldState.allocationSeedVersion)
        }
      : {
          allocation: createAllocationIndex({ worldId: LEGACY_WORLD_ID }),
          releasedSlots: [],
          presentationSeedVersion: INITIAL_WORLD_PRESENTATION_SEED_VERSION,
          allocationSeedVersion: INITIAL_WORLD_PRESENTATION_SEED_VERSION
        }
    // Rebuild plot occupancy, then migrate the old origin scan to one durable
    // high-water cursor plus indexed reusable slots. Future allocation never
    // rescans the populated world from zero.
    const plotless: PlayerRecord[] = []
    for (const player of this.players.values()) {
      const x = player.plotX as number
      const y = player.plotY as number
      const key = plotKey(x, y)
      // Once a development topology exists, every remaining stored record is
      // an explicit real-player override: reseed already deleted disposable
      // guests. Registered accounts and the reseed caller may therefore sit
      // where the new generated epoch would otherwise put water, a preserve,
      // or a bot. Epoch-zero startup retains the legacy relocation migration.
      const pinnedByGeneratedEpoch = this.allocationState.presentationSeedVersion > 0
        || player.worldTopologyPinned === true
      // Spiral settlement: villages legitimately sit on bot-classified land
      // (their claim replaced the camp), so only preserves/water relocate.
      if (Number.isInteger(x) && Number.isInteger(y)
        && Math.abs(x) <= HOME_COORD_LIMIT && Math.abs(y) <= HOME_COORD_LIMIT
        && (pinnedByGeneratedEpoch || isSpiralSettleable(
          { x, y },
          CURRENT_WORLD_GENERATION_VERSION,
          this.allocationState.presentationSeedVersion
        ))
        && !this.plotIndex.has(key)) {
        this.plotIndex.set(key, player.id)
      } else {
        player.plotX = undefined
        player.plotY = undefined
        plotless.push(player)
      }
    }
    const occupiedOrdinals = [...this.plotIndex.keys()].map(key => {
      const [x, y] = key.split(',').map(Number)
      return allocationOrdinalOf({ x, y })
    })
    const greatestOccupiedOrdinal = occupiedOrdinals.length > 0 ? Math.max(...occupiedOrdinals) : -1
    if (!storedWorldState) {
      const nextOrdinal = greatestOccupiedOrdinal + 1
      const releasedSlots: ReleasedPlotSlot[] = []
      // The legacy envelope is tiny, so index its holes once at cutover
      // (bounded by the shared scan limit for unexpectedly huge imports).
      // Bot ordinals are settleable spiral holes now, so they index too.
      for (const ordinal of spiralHoleOrdinalsBelowCursor({
        nextOrdinal,
        generationVersion: CURRENT_WORLD_GENERATION_VERSION,
        worldSeedVersion: this.allocationState.presentationSeedVersion
      })) {
        const coordinate = coordinateAtAllocationOrdinal(ordinal)
        if (!this.plotIndex.has(plotKey(coordinate.x, coordinate.y))) {
          releasedSlots.push({ ordinal, plotVersion: 1 })
        }
      }
      this.allocationState = {
        allocation: createAllocationIndex({ worldId: LEGACY_WORLD_ID, nextOrdinal }),
        releasedSlots,
        presentationSeedVersion: INITIAL_WORLD_PRESENTATION_SEED_VERSION,
        allocationSeedVersion: INITIAL_WORLD_PRESENTATION_SEED_VERSION,
        spiralModelVersion: 2
      }
      this.worldState.set(LEGACY_WORLD_ID, this.allocationState)
    } else {
      this.allocationState = {
        allocation: normalizeAllocationIndex(storedWorldState.allocation),
        releasedSlots: Array.isArray(storedWorldState.releasedSlots) ? storedWorldState.releasedSlots : [],
        presentationSeedVersion: normalizeWorldPresentationSeedVersion(storedWorldState.presentationSeedVersion),
        allocationSeedVersion: normalizeWorldPresentationSeedVersion(storedWorldState.allocationSeedVersion),
        spiralModelVersion: Number.isSafeInteger(storedWorldState.spiralModelVersion)
          ? storedWorldState.spiralModelVersion
          : 1
      }
      if (this.allocationState.allocation.nextOrdinal <= greatestOccupiedOrdinal) {
        this.allocationState.allocation = {
          ...this.allocationState.allocation,
          nextOrdinal: greatestOccupiedOrdinal + 1
        }
      }
      // JsonCollection persists the object it owns. Hydration deliberately
      // creates a normalized copy, so install that exact copy even when no
      // cursor repair was required; later in-place epoch bumps then persist.
      this.worldState.set(LEGACY_WORLD_ID, this.allocationState)
    }
    if (this.allocationState.allocationSeedVersion !== this.allocationState.presentationSeedVersion) {
      this.rebuildAllocationForGeneratedTopology()
    }
    this.upgradeAllocationToSpiralModel()
    plotless.sort((a, b) => a.createdAt - b.createdAt)
    for (const player of plotless) {
      this.assignPlot(player)
      this.players.markDirty(player.id)
    }

    for (const [id, player] of this.players.entries()) {
      this.playerDirectory.add(id)
      if (!Number.isSafeInteger(player.plotVersion) || (player.plotVersion ?? 0) < 1) {
        player.plotVersion = 1
        this.players.markDirty(id)
      }
      if (player.passwordHash) {
        if (player.plotLeaseId || player.plotLeaseExpiresAt) {
          delete player.plotLeaseId
          delete player.plotLeaseExpiresAt
          this.players.markDirty(id)
        }
      } else if (!player.plotLeaseId || !Number.isFinite(player.plotLeaseExpiresAt)) {
        player.plotLeaseId = `guest_${player.id}`
        player.plotLeaseExpiresAt = Date.now() + DEFAULT_GUEST_PLOT_TTL_MS
        this.players.markDirty(id)
      }
      const safeArmy = sanitizeArmy(player.army)
      const armyChanged = JSON.stringify(safeArmy) !== JSON.stringify(player.army ?? {})
      player.army = safeArmy
      if (armyChanged) this.players.markDirty(id)
      const normalizedBuildings = normalizePersistedBuildings(player.buildings)
      const safeBuildings = normalizedBuildings.buildings
      if (normalizedBuildings.changed) {
        const revision = Math.max(0, toInt(player.revision, 0))
        const layoutRevision = Math.max(0, toInt(player.layoutRevision, revision))
        const appearanceRevision = Math.max(0, toInt(player.appearanceRevision, revision))
        player.buildings = safeBuildings
        player.revision = revision + 1
        player.layoutRevision = layoutRevision + 1
        player.appearanceRevision = appearanceRevision + 1
        player.lastMutationAt = Date.now()
        this.players.markDirty(id)
      }
      const currentObstacles = Array.isArray(player.obstacles) ? player.obstacles : []
      const safeObstacles = withoutCollidingObstacles(safeBuildings, currentObstacles)
      if (safeObstacles.length !== currentObstacles.length || !Array.isArray(player.obstacles)) {
        player.obstacles = safeObstacles
        player.revision = Math.max(0, toInt(player.revision, 0)) + 1
        player.lastMutationAt = Date.now()
        this.players.markDirty(id)
      }
      // Migrate pre-account records that stored a single tokenHash.
      const legacy = (player as PlayerRecord & { tokenHash?: string }).tokenHash
      const migratedTokenHashes = migrateLegacyTokenHashes(player.tokenHashes, legacy)
      if (!Array.isArray(player.tokenHashes)
        || JSON.stringify(migratedTokenHashes) !== JSON.stringify(player.tokenHashes)
        || legacy) {
        player.tokenHashes = migratedTokenHashes
        delete (player as PlayerRecord & { tokenHash?: string }).tokenHash
        this.players.markDirty(id)
      }
      for (const hash of player.tokenHashes) this.tokenIndex.set(hash, id)
      if (player.passwordHash && player.usernameKey) this.usernameIndex.set(player.usernameKey, id)
      // Pre-population records get a starter population.
      if (!player.population || !Number.isFinite(player.population.count)) {
        player.population = { count: STARTING_POPULATION, lastGrowthAt: Date.now() }
        this.players.markDirty(id)
      }
      // Pre-ore/food records get the starter stocks.
      if (!Number.isFinite(player.ore) || !Number.isFinite(player.food)) {
        player.ore = STARTER_VILLAGE.resources.ore
        player.food = STARTER_VILLAGE.resources.food
        this.players.markDirty(id)
      }
      const remainder = player.productionRemainders
      if (!remainder || !Number.isFinite(remainder.ore) || !Number.isFinite(remainder.food)
        || remainder.ore < 0 || remainder.ore >= 1 || remainder.food < 0 || remainder.food >= 1) {
        player.productionRemainders = { ore: 0, food: 0 }
        this.players.markDirty(id)
      }
      if (!Number.isFinite(player.layoutRevision) || !Number.isFinite(player.appearanceRevision)) {
        const legacyRevision = Math.max(0, toInt(player.revision, 0))
        player.layoutRevision = legacyRevision
        player.appearanceRevision = legacyRevision
        player.simulatedThrough = Number.isFinite(player.lastAccrualAt) ? player.lastAccrualAt : Date.now()
        this.players.markDirty(id)
      }
      if ('botRaidResults' in player) {
        delete (player as PlayerRecord & { botRaidResults?: unknown }).botRaidResults
        this.players.markDirty(id)
      }
      // A corrupt persisted banner never reaches clients. Dropping it makes
      // banner onboarding mandatory again instead of preserving bad data.
      if (player.banner !== undefined) {
        const safeBanner = sanitizeVillageBanner(player.banner)
        if (!safeBanner) {
          delete player.banner
          this.players.markDirty(id)
        } else if (!villageBannersEqual(safeBanner, player.banner)) {
          player.banner = safeBanner
          this.players.markDirty(id)
        }
      }
    }
    // One-time migration: Solana-era records used sol* field names for the
    // gold currency. Rename in place so the rest of the server never sees them.
    for (const [id, replay] of this.replays.entries()) {
      if (replay.startRequestId) {
        this.startRequestIndex.set('pvp-start', replay.attackerId, replay.startRequestId, replay.attackId, replay.startedAt)
      }
      let migrated = false
      if (replay.troopLevel === undefined) {
        replay.troopLevel = troopLevelOf(this.players.get(replay.attackerId)?.buildings ?? [])
        migrated = true
      }
      if (!Array.isArray(replay.destroyedBuildingIds)) {
        replay.destroyedBuildingIds = [...this.observedDestroyedIds(replay)]
        migrated = true
      }
      const replayVictim = this.players.get(replay.victimId)
      if (replay.victimPlotX === undefined) {
        replay.victimPlotX = replayVictim?.plotX ?? 0
        migrated = true
      }
      if (replay.victimPlotY === undefined) {
        replay.victimPlotY = replayVictim?.plotY ?? 0
        migrated = true
      }
      if (replay.victimPlotVersion === undefined) {
        replay.victimPlotVersion = replayVictim?.plotVersion ?? 1
        migrated = true
      }
      const finals = replay.finalResult as (NonNullable<AttackRecord['finalResult']> & { solLooted?: number }) | undefined
      if (finals && finals.solLooted !== undefined) {
        if (finals.goldLooted === undefined) finals.goldLooted = finals.solLooted
        delete finals.solLooted
        migrated = true
      }
      for (const frame of replay.frames) {
        const legacy = frame as ReplayFrame & { solLooted?: number }
        if (legacy.solLooted !== undefined) {
          if (frame.goldLooted === undefined) frame.goldLooted = legacy.solLooted
          delete legacy.solLooted
          migrated = true
        }
      }
      // Bound pre-hardening records while retaining both the opening and the
      // newest terminal evidence. Dropping the tail made capped battles settle
      // from a stale mid-fight snapshot after a restart.
      while (replay.frames.length > MAX_REPLAY_FRAMES) {
        replay.frames.splice(replay.frames.length > 2 ? 1 : 0, 1)
        migrated = true
      }
      let bytes = exactReplayBytes(replay)
      while (bytes > MAX_REPLAY_BYTES && replay.frames.length > 1) {
        replay.frames.splice(replay.frames.length > 2 ? 1 : 0, 1)
        bytes = exactReplayBytes(replay)
        migrated = true
      }
      if (bytes > MAX_REPLAY_BYTES && replay.frames.length === 1) {
        const safeNewest = sanitizeFrame(replay.frames[0])
        replay.frames = safeNewest ? [safeNewest] : []
        bytes = exactReplayBytes(replay)
        migrated = true
      }
      if (replay.byteSize !== bytes) migrated = true
      replay.byteSize = bytes
      this.replayBytesTotal += bytes
      if (migrated) this.replays.markDirty(id)
    }
    for (const [id, record] of this.notifications.entries()) {
      let migrated = false
      for (const item of record.items) {
        if (!isAttackNotification(item)) continue
        const legacy = item as AttackNotificationItem & { solLost?: number }
        if (legacy.solLost !== undefined) {
          if (item.goldLost === undefined) item.goldLost = legacy.solLost
          delete legacy.solLost
          migrated = true
        }
      }
      if (migrated) this.notifications.markDirty(id)
    }
    for (const replay of this.replays.values()) {
      if (replay.status === 'live') {
        this.trackLive(replay)
        const attacker = this.players.get(replay.attackerId)
        if (replay.status === 'live' && attacker) this.applyAttackStartEffects(replay, attacker)
      }
    }
    this.expireAllStaleAttacks()
    const now = Date.now()
    for (const [raidId, raid] of this.botRaidSessions.entries()) {
      if (raid.startRequestId) {
        this.startRequestIndex.set('bot-start', raid.attackerId, raid.startRequestId, raid.raidId, raid.startedAt)
      }
      const attacker = this.players.get(raid.attackerId)
      if (raid.troopLevel === undefined) {
        raid.troopLevel = troopLevelOf(attacker?.buildings ?? [])
        this.botRaidSessions.markDirty(raidId)
      }
      if (raid.status !== 'live') continue
      if (!raid.authority && attacker) {
        try {
          raid.authority = this.prepareBotAuthority(attacker, raid)
          this.botRaidSessions.markDirty(raidId)
        } catch {
          raid.status = 'aborted'
          this.botRaidSessions.markDirty(raidId)
          continue
        }
      }
      if (!attacker || this.liveBotByAttacker.has(raid.attackerId)) {
        raid.status = 'aborted'
        this.botRaidSessions.markDirty(raidId)
      } else {
        this.liveBotByAttacker.set(raid.attackerId, raidId)
        if (raid.expiresAt <= now) this.expireBotRaid(raid, attacker, now)
      }
    }
    this.recoverBotSettlements()
    this.pruneFinishedBotRaids(true)
    this.pruneGlobalReplayStorage()
    this.recoverSettlements()
  }

  flush(): boolean {
    const playersSaved = this.players.flush()
    const replaysSaved = this.replays.flush()
    const notificationsSaved = this.notifications.flush()
    const settlementsSaved = this.settlements.flush()
    const botRaidsSaved = this.botRaidSessions.flush()
    const botVillagesSaved = this.botVillages.flush()
    const ledgerSaved = this.ledger.flush()
    const worldStateSaved = this.worldState.flush()
    const adminModerationSaved = this.adminModeration.flush()
    const adminConfigSaved = this.adminRuntimeConfig.flush()
    const adminAuditSaved = this.adminAuditLog.flush()
    return playersSaved
      && replaysSaved
      && notificationsSaved
      && settlementsSaved
      && botRaidsSaved
      && botVillagesSaved
      && ledgerSaved
      && worldStateSaved
      && adminModerationSaved
      && adminConfigSaved
      && adminAuditSaved
  }

  // ---- economy ledger ----

  private ledgerDay(day: number): LedgerDay {
    const key = `d${day}`
    let record = this.ledger.get(key)
    if (!record) {
      record = emptyLedgerDay(day)
      this.ledger.set(key, record)
    }
    return record
  }

  /** Book an economy flow into today's ledger. Disk writes are throttled. */
  private book(bucket: 'faucets' | 'sinks' | 'refunds' | 'loot', kind: 'gold' | 'ore' | 'food', amount: number) {
    const value = Math.floor(amount)
    if (value <= 0) return
    const day = this.ledgerDay(worldDayIndex(Date.now()))
    day[bucket][kind] += value
    this.ledger.markDirty(`d${day.day}`)
  }

  private bookCount(field: keyof LedgerDay['counts']) {
    const day = this.ledgerDay(worldDayIndex(Date.now()))
    day.counts[field] += 1
    this.ledger.markDirty(`d${day.day}`)
  }

  /** The tuning sheet: last N world-days of faucets vs sinks vs transfers. */
  economyLedger(rawDays: unknown): { today: number; days: LedgerDay[] } {
    if (process.env.CLASH_ALLOW_DEBUG_GRANTS !== '1') throw new ApiError(403, 'Debug tools are disabled')
    const days = clampInt(rawDays, 1, 30, 7)
    const today = worldDayIndex(Date.now())
    const out: LedgerDay[] = []
    for (let day = today; day > today - days; day--) {
      out.push(this.ledger.get(`d${day}`) ?? emptyLedgerDay(day))
    }
    return { today, days: out }
  }

  /**
   * Local-only world cleanup for iterating on MMO presentation. The current
   * device is always a real player for this operation, even before account
   * registration; registered accounts are also permanent. Every other guest
   * and every multiplayer record that references one is discarded together.
   */
  debugReseedWorld(caller: PlayerRecord): {
    ok: true
    removedGuests: number
    preservedPlayers: number
    seedVersion: number
    removedActivity: { attacks: number; botRaids: number; notifications: number }
  } {
    if (process.env.CLASH_ALLOW_WORLD_RESEED !== '1') {
      throw new ApiError(404, 'Unknown route: POST /api/debug/reseed-world')
    }
    if (!this.players.get(caller.id)) throw new ApiError(401, 'Unknown device token')

    const removedPlayers = [...this.players.values()]
      .filter(player => player.id !== caller.id && !player.passwordHash)
    const removedIds = new Set(removedPlayers.map(player => player.id))
    const preservedPlayers = this.players.size - removedPlayers.length

    // Rotate the durable root for every generated system: bot occupancy and
    // appearance, preserves, hydrology and nature. The caller becomes a
    // durable coordinate override so a restart cannot relocate its real
    // village even if the new epoch generates water or a bot beneath it.
    const nextSeedVersion = nextWorldPresentationSeedVersion(
      this.allocationState.presentationSeedVersion
    )
    caller.worldTopologyPinned = true
    this.players.markDirty(caller.id)

    const removedAttackIds = new Set<string>()
    for (const replay of this.replays.values()) {
      if (removedIds.has(replay.attackerId) || removedIds.has(replay.victimId)) {
        removedAttackIds.add(replay.attackId)
      }
    }
    // A bot raid snapshots the old generated clan. Invalidate all of those
    // sessions, including raids owned by preserved players, instead of
    // letting a pre-reseed village settle against the new epoch.
    const removedBotRaidIds = new Set(
      [...this.botRaidSessions.entries()].map(([raidId]) => raidId)
    )
    let removedNotifications = 0
    for (const [recipientId, record] of this.notifications.entries()) {
      removedNotifications += removedIds.has(recipientId)
        ? record.items.length
        : record.items.filter(item => isAttackNotification(item)
          && (removedIds.has(item.attackerId) || removedAttackIds.has(item.attackId))).length
    }

    // Tear down live indexes first. Captured ids above also cover terminal
    // history and settlement journals that cancelPlayerActivity does not own.
    for (const player of removedPlayers) this.cancelPlayerActivity(player.id)
    for (const attackId of removedAttackIds) {
      this.settlements.delete(attackId)
      this.deleteReplay(attackId)
    }
    for (const raidId of removedBotRaidIds) {
      const raid = this.botRaidSessions.get(raidId)
      if (raid && this.liveBotByAttacker.get(raid.attackerId) === raidId) {
        this.liveBotByAttacker.delete(raid.attackerId)
      }
      this.botRaidSessions.delete(raidId)
    }
    // Persisted bots belong to the old presentation epoch. Remove the rows
    // explicitly; the next map/attack provisions the new epoch before use.
    for (const [botId] of [...this.botVillages.entries()]) {
      if (!this.botVillages.delete(botId)) {
        throw new ApiError(503, 'Could not retire persisted bot villages for reseed')
      }
    }

    // Preserved players must not retain revenge or write-ahead markers for
    // activity removed with a synthetic guest.
    for (const [playerId, player] of this.players.entries()) {
      if (removedIds.has(playerId)) continue
      let changed = false
      if (player.revengeRights) {
        for (const removedId of removedIds) {
          if (!hasOwn(player.revengeRights, removedId)) continue
          delete player.revengeRights[removedId]
          changed = true
        }
      }
      if (player.botRaids && Object.keys(player.botRaids).length > 0) {
        player.botRaids = {}
        changed = true
      }
      for (const field of ['attackStarts', 'battleSettlements'] as const) {
        const markers = player[field]
        if (!markers) continue
        for (const key of Object.keys(markers)) {
          const attackId = key.slice(key.lastIndexOf(':') + 1)
          if (!removedAttackIds.has(attackId)) continue
          delete markers[key]
          changed = true
        }
      }
      if (changed) this.players.markDirty(playerId)
    }

    for (const [recipientId, record] of [...this.notifications.entries()]) {
      if (removedIds.has(recipientId)) {
        this.notifications.delete(recipientId)
        continue
      }
      const kept = record.items.filter(item => !isAttackNotification(item)
        || (!removedIds.has(item.attackerId) && !removedAttackIds.has(item.attackId)))
      if (kept.length === record.items.length) continue
      if (kept.length === 0) this.notifications.delete(recipientId)
      else {
        record.items = kept
        this.notifications.markDirty(recipientId)
      }
    }

    for (const player of removedPlayers) {
      this.lastSeenPersistedAt.delete(player.id)
      this.grantWindows.delete(player.id)
      this.deleteGuestPlayer(player, false)
    }
    this.finishedBotRaids.length = 0
    this.finishedBotRaidIds.clear()
    this.pruneFinishedBotRaids(true)
    this.startRequestIndex.deleteReferences({
      actorIds: removedIds,
      aggregateIds: new Set([...removedAttackIds, ...removedBotRaidIds])
    })
    this.leaderboardCache = null
    this.allocationState.presentationSeedVersion = nextSeedVersion
    clearWorldHydrologyCache()
    this.rebuildAllocationForGeneratedTopology()

    return {
      ok: true,
      removedGuests: removedPlayers.length,
      preservedPlayers,
      seedVersion: this.allocationState.presentationSeedVersion,
      removedActivity: {
        attacks: removedAttackIds.size,
        botRaids: removedBotRaidIds.size,
        notifications: removedNotifications
      }
    }
  }

  // ---- auth ----

  private currentAdminConfig(): AdminRuntimeConfigRecord {
    const stored = this.adminRuntimeConfig.get(ADMIN_CONFIG_KEY)
    if (stored) return stored
    const created: AdminRuntimeConfigRecord = {
      maintenanceEnabled: false,
      maintenanceMessage: null,
      updatedAt: Date.now(),
      revision: 1
    }
    this.adminRuntimeConfig.set(ADMIN_CONFIG_KEY, created)
    return created
  }

  private effectiveModeration(playerId: string, now = Date.now()): {
    state: AdminAccessState
    reason: string | null
    until: number | null
    updatedAt: number | null
  } {
    const record = this.adminModeration.get(playerId)
    if (!record) return { state: 'active', reason: null, until: null, updatedAt: null }
    if (record.state === 'suspended' && record.until !== null && record.until <= now) {
      return { state: 'active', reason: null, until: null, updatedAt: record.updatedAt }
    }
    return {
      state: record.state,
      reason: record.state === 'active' ? null : record.reason,
      until: record.state === 'suspended' ? record.until : null,
      updatedAt: record.updatedAt
    }
  }

  private revokeAllSessions(player: PlayerRecord): number {
    const revoked = player.tokenHashes.length
    for (const tokenHash of player.tokenHashes) this.tokenIndex.delete(tokenHash)
    if (revoked > 0) {
      player.tokenHashes = []
      this.players.markDirty(player.id)
    }
    return revoked
  }

  private assertMaintenanceAvailable(): void {
    const config = this.currentAdminConfig()
    if (!config.maintenanceEnabled) return
    throw new ApiError(
      503,
      config.maintenanceMessage || 'The game is temporarily unavailable for maintenance',
      'GAME_MAINTENANCE'
    )
  }

  private assertPlayerAccess(player: PlayerRecord): void {
    const moderation = this.effectiveModeration(player.id)
    if (moderation.state === 'active') return
    this.revokeAllSessions(player)
    if (moderation.state === 'banned') {
      throw new ApiError(403, 'This account has been banned', 'ACCOUNT_BANNED')
    }
    throw new ApiError(
      403,
      moderation.until === null
        ? 'This account has been suspended'
        : `This account is suspended until ${new Date(moderation.until).toISOString()}`,
      'ACCOUNT_SUSPENDED'
    )
  }

  private sessionFor(player: PlayerRecord, token: string, created: boolean): SessionResponse {
    return {
      token,
      player: this.profileOf(player),
      world: this.worldOf(player),
      created,
      unread: this.unreadCount(player.id),
      features: { infiniteResources: infiniteResourcesEnabled() }
    }
  }

  /** Mint a new session token for a player, evicting the oldest if the device cap is hit. */
  private issueToken(player: PlayerRecord): string {
    const issued = issueSessionToken(player.tokenHashes, { maximumSessions: MAX_SESSIONS_PER_PLAYER })
    player.tokenHashes = issued.tokenHashes
    for (const evicted of issued.evictedTokenHashes) this.tokenIndex.delete(evicted)
    this.tokenIndex.set(issued.tokenHash, player.id)
    this.players.markDirty(player.id)
    return issued.token
  }

  // ===================== WORLD MAP =====================
  //
  // Every village owns a plot on one global grid. Bot-classified coordinates
  // cross a durable provisioning boundary before they are ever exposed; map,
  // attack, replay and settlement all read that one persisted village. A real
  // player claim temporarily hides the bot record at the same coordinate.
  // Development reseeds explicitly replace generated topology and bot rows,
  // while real player coordinates remain explicit overrides.

  /**
   * Reset reusable-coordinate discovery for the current generated topology.
   * Old released rows encode now-invalid eligibility and cannot survive. The
   * high-water cursor is eligibility-agnostic, however, and stays beyond every
   * prior frontier claim; retaining it prevents the first post-reseed player
   * from rescanning a densely populated MMO world. The bounded spiral-model
   * upgrade then re-indexes the settleable central holes under the new seed,
   * so admission keeps filling the world center first after a reseed too.
   */
  private rebuildAllocationForGeneratedTopology(): void {
    const previous = normalizeAllocationIndex(this.allocationState.allocation)
    this.allocationState = {
      allocation: previous,
      releasedSlots: [],
      presentationSeedVersion: this.allocationState.presentationSeedVersion,
      allocationSeedVersion: this.allocationState.presentationSeedVersion,
      spiralModelVersion: 1
    }
    this.worldState.set(LEGACY_WORLD_ID, this.allocationState)
    this.upgradeAllocationToSpiralModel()
  }

  /**
   * One-time (per world, per topology rebuild) spiral-model upgrade: index
   * every settleable, unoccupied ordinal below the high-water cursor as a
   * free slot. Pre-spiral admission skipped bot-classified ordinals — the
   * entire dense center — so without this backfill an upgraded world would
   * keep spawning new accounts on its old frontier instead of replacing the
   * central bot neighbourhood from the inside out.
   */
  private upgradeAllocationToSpiralModel(): void {
    if ((this.allocationState.spiralModelVersion ?? 1) >= 2) return
    const indexed = new Set(this.allocationState.releasedSlots.map(slot => slot.ordinal))
    for (const ordinal of spiralHoleOrdinalsBelowCursor({
      nextOrdinal: this.allocationState.allocation.nextOrdinal,
      generationVersion: this.allocationState.allocation.currentGenerationVersion,
      worldSeedVersion: this.allocationState.presentationSeedVersion
    })) {
      if (indexed.has(ordinal)) continue
      const coordinate = coordinateAtAllocationOrdinal(ordinal)
      if (this.plotIndex.has(plotKey(coordinate.x, coordinate.y))) continue
      this.allocationState.releasedSlots.push({ ordinal, plotVersion: 1 })
    }
    this.allocationState.releasedSlots.sort((a, b) => a.ordinal - b.ordinal)
    this.allocationState.spiralModelVersion = 2
    this.worldState.set(LEGACY_WORLD_ID, this.allocationState)
  }

  /** Unclaimed spiral plots inside this Chebyshev radius present as bot camps. */
  private botFrontierRadius(): number {
    return botFrontierRadiusForCursor(this.allocationState.allocation.nextOrdinal)
  }

  /**
   * Sole legacy-JSON generation boundary. The completed record is fsync'd by
   * JsonCollection before it can be rendered, returned, or attacked.
   */
  private persistedBotVillageAt(x: number, y: number, seed: number): LegacyBotVillageRecord {
    const id = persistentBotVillageIdAt(LEGACY_WORLD_ID, x, y)
    const stored = this.botVillages.get(id)
    if (stored) {
      if (stored.id !== id || stored.world.id !== id || stored.world.ownerId !== id
        || stored.worldId !== LEGACY_WORLD_ID || stored.x !== x || stored.y !== y
        || stored.seed !== seed
        || stored.presentationSeedVersion !== this.allocationState.presentationSeedVersion) {
        throw new ApiError(409, 'Persisted bot village provenance differs; reseed migration is required')
      }
      // A record baked by an older generator keeps serving its stale (often
      // near-empty) layout forever — provenance only pins WHERE/WHO, not the
      // generator revision. Regenerate in place when the generator advanced,
      // unless a live raid is mid-fight against the old layout (its authority
      // snapshot is already cloned, but the idempotent start-retry path
      // re-reads this record and must keep matching that snapshot).
      if (stored.generatorVersion !== PROCEDURAL_VILLAGE_GENERATOR_VERSION) {
        let liveAgainstThisBot = false
        for (const raid of this.botRaidSessions.values()) {
          if (raid.status === 'live' && raid.botId === id) { liveAgainstThisBot = true; break }
        }
        if (!liveAgainstThisBot) {
          const difficulty = proceduralVillageDifficulty(seed)
          const world = generateProceduralVillage(seed, { id, ownerId: id, difficulty })
          world.revision = stored.revision + 1
          world.lastSaveTime = 0
          stored.world = world
          stored.generatorVersion = PROCEDURAL_VILLAGE_GENERATOR_VERSION
          stored.username = world.username ?? stored.username
          stored.trophies = proceduralVillageTrophies(seed)
          stored.profile = {
            difficulty,
            generator: 'procedural-village',
            generatorVersion: PROCEDURAL_VILLAGE_GENERATOR_VERSION
          }
          stored.revision += 1
          stored.updatedAt = Date.now()
          if (!this.botVillages.flushOne(id)) {
            throw new ApiError(503, 'Could not persist regenerated bot village')
          }
        }
      }
      return stored
    }

    const now = Date.now()
    const difficulty = proceduralVillageDifficulty(seed)
    const world = generateProceduralVillage(seed, { id, ownerId: id, difficulty })
    world.revision = 1
    world.lastSaveTime = 0
    const record: LegacyBotVillageRecord = {
      id,
      worldId: LEGACY_WORLD_ID,
      x,
      y,
      plotVersion: 1,
      worldGenerationVersion: CURRENT_WORLD_GENERATION_VERSION,
      presentationSeedVersion: this.allocationState.presentationSeedVersion,
      generatorVersion: PROCEDURAL_VILLAGE_GENERATOR_VERSION,
      seed,
      username: world.username ?? `Clan ${seed.toString(16).toUpperCase()}`,
      trophies: proceduralVillageTrophies(seed),
      profile: {
        difficulty,
        generator: 'procedural-village',
        generatorVersion: PROCEDURAL_VILLAGE_GENERATOR_VERSION
      },
      world,
      revision: 1,
      createdAt: now,
      updatedAt: now
    }
    this.botVillages.set(id, record)
    if (!this.botVillages.flushOne(id)) {
      this.botVillages.delete(id)
      throw new ApiError(503, 'Could not persist bot village')
    }
    return record
  }

  private publicBotWorldOf(bot: LegacyBotVillageRecord): PublicWorldSnapshot {
    const world = bot.world
    return {
      id: bot.id,
      ownerId: bot.id,
      username: bot.username,
      buildings: world.buildings.map(building => ({ ...building })),
      obstacles: (world.obstacles ?? []).map(obstacle => ({ ...obstacle })),
      wallLevel: world.wallLevel ?? 1,
      lastSaveTime: world.lastSaveTime,
      revision: bot.revision,
      life: world.life ? structuredClone(world.life) : {
        version: 1,
        identity: bot.id,
        population: world.population?.count ?? 0,
        bornAt: [...(world.population?.bornAt ?? [])],
        simulatedThrough: world.lastSaveTime
      },
      ...(world.banner ? { banner: { ...world.banner } } : {})
    }
  }

  private assignPlot(player: PlayerRecord) {
    const spot = this.nextFreePlot()
    player.plotX = spot.x
    player.plotY = spot.y
    player.plotVersion = spot.plotVersion
    this.plotIndex.set(plotKey(spot.x, spot.y), player.id)
    // The claim replaces any bot camp presented at this spiral plot; the
    // claimant's own raid cooldown for the coordinate dies with the camp.
    if (player.botRaids) delete player.botRaids[plotKey(spot.x, spot.y)]
  }

  /** Allocate from indexed releases first, then resume the durable frontier. */
  private nextFreePlot(): { x: number; y: number; plotVersion: number } {
    for (let page = 0; page < 128; page += 1) {
      const result = allocateNextPlayerPlot(this.allocationState.allocation, {
        releasedSlots: this.allocationState.releasedSlots,
        worldSeedVersion: this.allocationState.presentationSeedVersion,
        isOccupied: candidate => this.plotIndex.has(plotKey(candidate.coordinate.x, candidate.coordinate.y))
      })
      const consumed = new Set(result.consumedReleasedOrdinals)
      this.allocationState.releasedSlots = this.allocationState.releasedSlots
        .filter(slot => !consumed.has(slot.ordinal))
      this.allocationState.allocation = result.index
      this.worldState.markDirty(LEGACY_WORLD_ID)
      if (result.allocation) {
        return {
          x: result.allocation.coordinate.x,
          y: result.allocation.coordinate.y,
          plotVersion: result.allocation.plotVersion
        }
      }
      if (result.exhausted) break
    }
    throw new ApiError(503, 'No world plot is currently allocatable')
  }

  private releasePlot(x: number, y: number, plotVersion: number): void {
    const ordinal = allocationOrdinalOf({ x, y })
    const existing = this.allocationState.releasedSlots.findIndex(slot => slot.ordinal === ordinal)
    // A real player may be pinned over newly generated water/bot/preserve.
    // Vacating that override reveals generated land; it must never enter the
    // reusable player-plot index.
    const released = releasePlayerPlotForTopology(this.allocationState.allocation, {
      coordinate: { x, y },
      plotVersion: Math.max(1, toInt(plotVersion, 1))
    }, this.allocationState.presentationSeedVersion)
    if (!released.releasedSlot) {
      if (existing >= 0) this.allocationState.releasedSlots.splice(existing, 1)
      this.worldState.markDirty(LEGACY_WORLD_ID)
      return
    }
    if (existing >= 0) this.allocationState.releasedSlots[existing] = released.releasedSlot
    else this.allocationState.releasedSlots.push(released.releasedSlot)
    this.allocationState.releasedSlots.sort((a, b) => a.ordinal - b.ordinal)
    this.worldState.markDirty(LEGACY_WORLD_ID)
  }

  /** Map window around (x, y): players, deterministic bots, live battles. */
  map(player: PlayerRecord, rawX: unknown, rawY: unknown, rawR: unknown, rawKnown?: unknown) {
    // Mature the viewer's own clocks FIRST: a watchtower upgrade that just
    // completed must widen this very window. Without this, the refresh the
    // client fires at completion reads the stale pre-upgrade level (the loop
    // below only advances plot owners AFTER sight is computed) and the newly
    // earned ring waits a whole client refresh cadence to fill in.
    this.advancePlayer(player)
    const homeX = player.plotX ?? 0
    const homeY = player.plotY ?? 0
    const cx = worldCoord(rawX, homeX)
    const cy = worldCoord(rawY, homeY)
    // Sight is EARNED: the map never returns more than the player's
    // watchtower can see, whatever center/radius a modified client asks for.
    const sight = watchtowerSightOf(player.buildings)
    const centerDistance = chebyshevDistance(cx, cy, homeX, homeY)
    const active = this.activeAttackFor(player.id)
    const activeVictim = active ? this.players.get(active.victimId) : undefined
    const centeredOnActiveVictim = Boolean(active?.mapFocusAuthorized && activeVictim && (activeVictim.plotX ?? 0) === cx && (activeVictim.plotY ?? 0) === cy)
    const activeBot = this.activeBotRaidFor(player.id)
    // Selection never changes presentation authority: every issued bot raid,
    // including matchmaking, may focus its canonical world plot while live.
    const centeredOnActiveBot = Boolean(activeBot && activeBot.x === cx && activeBot.y === cy)
    if (centerDistance > sight && !centeredOnActiveVictim && !centeredOnActiveBot) {
      throw new ApiError(403, 'That map center is beyond your watchtower sight')
    }
    // A live raid is always presented as a real place in the shared world.
    // Even a new account without a watchtower receives the immediate 3x3
    // destination context; watchtowers still gate every ordinary map read and
    // expand an active focus to the earned 5x5 ring. Without this floor the
    // canonical focus technically used the right coordinates but rendered as
    // an isolated one-plot island, visually recreating the retired detached
    // attack scene.
    const radiusBudget = centeredOnActiveVictim || centeredOnActiveBot
      ? Math.max(1, sight)
      : centerDistance === 0
        ? sight
        : Math.max(0, sight - centerDistance)
    const r = Math.min(clampInt(rawR, 0, 2, 1), radiusBudget)
    const known = parseKnownRevisions(rawKnown)
    const plots: Array<Record<string, unknown>> = []
    for (let y = cy - r; y <= cy + r; y++) {
      for (let x = cx - r; x <= cx + r; x++) {
        if (x < -WORLD_COORD_LIMIT || x > WORLD_COORD_LIMIT || y < -WORLD_COORD_LIMIT || y > WORLD_COORD_LIMIT) continue
        const ownerId = this.plotIndex.get(plotKey(x, y))
        if (ownerId) {
          const owner = this.players.get(ownerId)
          if (owner) {
            this.advancePlayer(owner)
            this.expireStaleAttacks(owner.id)
            const live = this.liveByVictim.get(owner.id)
            let attackId: string | undefined
            if (live) {
              for (const id of live) {
                const rec = this.replays.get(id)
                if (rec && rec.status === 'live') { attackId = id; break }
              }
            }
            const withinDirectSight = chebyshevDistance(x, y, homeX, homeY) <= sight
            const appearanceRevision = appearanceRevisionOf(owner)
            const plot: Record<string, unknown> = {
              x, y,
              kind: 'player',
              ownerId: owner.id,
              username: owner.username,
              trophies: owner.trophies,
              revision: appearanceRevision,
              underAttack: Boolean(attackId),
              ...(withinDirectSight && attackId ? { attackId } : {}),
              shielded: (owner.shieldUntil ?? 0) > Date.now(),
              stoneMaturity: this.stoneMaturityOf(owner)
            }
            const cached = known.get(plotKey(x, y))
            if (!cached || cached.ownerId !== owner.id || cached.revision !== appearanceRevision) plot.world = publicWorldOf(owner)
            plots.push(plot)
            continue
          }
        }
        const seed = settledFrontierBotVillageSeedAt({ x, y }, {
          frontierRadius: this.botFrontierRadius(),
          presentationSeedVersion: this.allocationState.presentationSeedVersion
        })
        if (seed !== null) {
          const bot = this.persistedBotVillageAt(x, y, seed)
          const plot: Record<string, unknown> = {
            x,
            y,
            kind: 'bot',
            seed: bot.seed,
            ownerId: bot.id,
            username: bot.username,
            trophies: bot.trophies,
            revision: bot.revision
          }
          const cached = known.get(plotKey(x, y))
          if (!cached || cached.ownerId !== bot.id || cached.revision !== bot.revision) {
            plot.world = this.publicBotWorldOf(bot)
          }
          plots.push(plot)
        } else {
          plots.push({
            x,
            y,
            kind: 'empty',
            settleable: !isWildernessPreserveAt(x, y, this.allocationState.presentationSeedVersion)
          })
        }
      }
    }
    return {
      plots,
      me: { x: player.plotX ?? 0, y: player.plotY ?? 0, shieldUntil: player.shieldUntil ?? 0 },
      serverNow: Date.now(),
      seedVersion: this.allocationState.presentationSeedVersion
    }
  }

  /** Pack the wagons: free the current plot and settle an unowned one. */
  relocate(player: PlayerRecord, rawX: unknown, rawY: unknown) {
    if (this.activeAttackFor(player.id)) throw new ApiError(409, 'Cannot relocate during an active PvP attack')
    if (this.activeBotRaidFor(player.id)) throw new ApiError(409, 'Cannot relocate during an active bot raid')
    this.expireStaleAttacks(player.id)
    if ((this.liveByVictim.get(player.id)?.size ?? 0) > 0) throw new ApiError(409, 'Cannot relocate while your village is under attack')
    const oldX = player.plotX ?? 0
    const oldY = player.plotY ?? 0
    const oldVersion = player.plotVersion ?? 1
    const oldKey = plotKey(oldX, oldY)
    let target: { x: number; y: number; plotVersion: number }
    if (rawX === undefined && rawY === undefined) {
      // "Just move me": the next spot on the frontier. Search while the old
      // plot is still claimed — freeing it first made it eligible again, and
      // the spiral would happily "move" you back into your own house.
      target = this.nextFreePlot()
      this.plotIndex.delete(oldKey)
      this.releasePlot(oldX, oldY, oldVersion)
    } else {
      const x = worldCoord(rawX, Number.NaN)
      const y = worldCoord(rawY, Number.NaN)
      if (!Number.isFinite(x) || !Number.isFinite(y)) throw new ApiError(400, 'Bad plot coordinates')
      if (Math.abs(x) > HOME_COORD_LIMIT || Math.abs(y) > HOME_COORD_LIMIT) {
        throw new ApiError(400, 'Village plots must leave room for the full watchtower horizon')
      }
      const key = plotKey(x, y)
      if (key === oldKey) throw new ApiError(400, 'You already live there')
      const sight = watchtowerSightOf(player.buildings)
      if (chebyshevDistance(x, y, player.plotX ?? 0, player.plotY ?? 0) > sight) {
        throw new ApiError(403, 'That relocation plot is beyond your watchtower sight')
      }
      if (this.plotIndex.has(key)) throw new ApiError(409, 'That plot is taken')
      // Spiral settlement: an unclaimed bot camp is claimable land — settling
      // there replaces the camp. Only preserves/water refuse a village.
      const eligibility = classifyPlot(
        { x, y },
        CURRENT_WORLD_GENERATION_VERSION,
        this.allocationState.presentationSeedVersion
      )
      if (eligibility.kind === 'PRESERVE') throw new ApiError(409, 'That wilderness is permanently protected')
      const targetOrdinal = allocationOrdinalOf({ x, y })
      const releasedIndex = this.allocationState.releasedSlots.findIndex(slot => slot.ordinal === targetOrdinal)
      const targetVersion = releasedIndex >= 0 ? this.allocationState.releasedSlots[releasedIndex].plotVersion : 1
      if (releasedIndex >= 0) this.allocationState.releasedSlots.splice(releasedIndex, 1)
      this.plotIndex.delete(oldKey)
      this.releasePlot(oldX, oldY, oldVersion)
      target = { x, y, plotVersion: targetVersion }
    }
    player.plotX = target.x
    player.plotY = target.y
    player.plotVersion = target.plotVersion
    this.plotIndex.set(plotKey(target.x, target.y), player.id)
    // Claiming a plot dissolves any bot camp presented there; the mover's own
    // raid cooldown for that coordinate is now meaningless. Everyone else's
    // entries are inert (occupancy is checked before any cooldown) and expire.
    if (player.botRaids) delete player.botRaids[plotKey(target.x, target.y)]
    player.revision += 1
    player.lastMutationAt = Date.now()
    this.players.markDirty(player.id)
    return { me: { x: target.x, y: target.y, plotVersion: target.plotVersion }, serverNow: Date.now() }
  }

  /**
   * Device-token session: a valid token resumes its account (guest or
   * registered — existing villages are grandfathered). Without one, the
   * production registration wall answers `{ registrationRequired: true }`;
   * only with CLASH_ALLOW_GUESTS=1 (dev/harnesses) is a fresh playable guest
   * minted instead.
   */
  ensureSession(rawToken: unknown, rawAddress?: unknown): SessionResponse | RegistrationRequiredResponse {
    this.assertMaintenanceAvailable()
    const now = Date.now()
    const token = normalizeSessionToken(rawToken)
    if (token) {
      const playerId = this.tokenIndex.get(hashToken(token))
      const player = playerId ? this.players.get(playerId) : undefined
      if (player) {
        if (!player.passwordHash && (player.plotLeaseExpiresAt ?? 0) <= now) {
          this.deleteGuestPlayer(player)
        } else {
          this.assertPlayerAccess(player)
          this.touch(player)
          return this.sessionFor(player, token, false)
        }
      }
    }

    if (!guestSessionsAllowed()) return registrationRequiredResponse()

    const guestCreation = this.authLimiter.consumeGuestCreation(rawAddress, now)
    if (!guestCreation.allowed) {
      throw new ApiError(429, 'Too many new villages from this address — try again later')
    }

    const issuedSession = issueSessionToken([], { maximumSessions: MAX_SESSIONS_PER_PLAYER })
    const newToken = issuedSession.token
    const player = this.createStarterPlayer(now, issuedSession.tokenHashes, {
      username: `Chief-${randomHex(2).toUpperCase()}`
    })
    this.players.set(player.id, player)
    this.playerDirectory.add(player.id)
    this.tokenIndex.set(issuedSession.tokenHash, player.id)
    return this.sessionFor(player, newToken, true)
  }

  /**
   * Mint a starter player record and claim its plot through the shared
   * allocation path. Guests (no credentials) get a renewable plot lease;
   * registered accounts (credentials present) own their plot permanently.
   */
  private createStarterPlayer(
    now: number,
    tokenHashes: string[],
    identity: { username: string; usernameKey?: string; passwordHash?: string }
  ): PlayerRecord {
    const registered = Boolean(identity.passwordHash)
    const starter = createStarterVillage(() => `b_${randomHex(6)}`)
    const player: PlayerRecord = {
      id: `p_${randomHex(8)}`,
      tokenHashes,
      username: identity.username,
      ...(registered ? { usernameKey: identity.usernameKey, passwordHash: identity.passwordHash } : {}),
      createdAt: now,
      lastSeen: now,
      trophies: 0,
      balance: starter.resources.gold,
      lastAccrualAt: now,
      lastMutationAt: now,
      revision: 1,
      layoutRevision: 1,
      appearanceRevision: 1,
      simulatedThrough: now,
      buildings: starter.buildings,
      obstacles: starter.obstacles,
      army: starter.army,
      wallLevel: starter.wallLevel,
      requestKeys: [],
      population: { count: STARTING_POPULATION, lastGrowthAt: now },
      ore: starter.resources.ore,
      food: starter.resources.food,
      shieldUntil: now + STARTER_SHIELD_MS
    }
    if (!registered) {
      player.plotLeaseId = `guest_${player.id}`
      player.plotLeaseExpiresAt = now + DEFAULT_GUEST_PLOT_TTL_MS
    }
    this.assignPlot(player)
    return player
  }

  authenticate(rawToken: unknown): PlayerRecord {
    this.assertMaintenanceAvailable()
    const token = normalizeSessionToken(rawToken)
    const playerId = token ? this.tokenIndex.get(hashToken(token)) : undefined
    const player = playerId ? this.players.get(playerId) : undefined
    if (!player) throw new ApiError(401, 'Unknown device token')
    if (!player.passwordHash && (player.plotLeaseExpiresAt ?? 0) <= Date.now()) {
      this.deleteGuestPlayer(player)
      throw new ApiError(401, 'Guest village lease expired')
    }
    this.assertPlayerAccess(player)
    this.touch(player)
    return player
  }

  /**
   * HTTP calls this only for an authenticated player and only for a durable
   * gameplay mutation. Generated map camps/bots never authenticate and never
   * pass through this player-onboarding gate.
   */
  assertGameplayReady(player: PlayerRecord): void {
    if (!sanitizeVillageBanner(player.banner)) throw bannerRequiredError()
  }

  /**
   * Create or claim a username + password account. With a valid device token,
   * the caller's current (guest) account is upgraded in place: the village
   * they already built becomes loadable from any device and the token keeps
   * working as this device's session. With NO token (the production
   * registration wall), the account is created from scratch — starter
   * village, a permanent plot through the shared allocation path, and a fresh
   * device session, returned as a full session envelope.
   */
  register(
    rawToken: unknown,
    rawUsername: unknown,
    rawPassword: unknown,
    rawAddress?: unknown
  ): { player: PlayerProfile } | SessionResponse {
    this.assertMaintenanceAvailable()
    const token = normalizeSessionToken(rawToken)
    const credentials = validateRegistrationCredentials(rawUsername, rawPassword)
    if (!credentials.ok) throw new ApiError(400, credentials.message)
    const { username, password } = credentials
    const key = normalizeUsernameKey(username)

    if (token) {
      // A presented token must be live — a dead session never silently mints
      // a second account under the player's feet (401 -> normal expiry flow).
      const player = this.authenticate(token)
      if (player.passwordHash) {
        throw new ApiError(409, 'This village is already registered — log out to create a different account')
      }
      const existing = this.usernameIndex.get(key)
      if (existing && existing !== player.id) {
        throw new ApiError(409, 'That username is already taken', 'USERNAME_TAKEN')
      }
      player.username = username
      player.usernameKey = key
      player.passwordHash = hashPassword(password)
      delete player.plotLeaseId
      delete player.plotLeaseExpiresAt
      player.revision += 1
      player.appearanceRevision = appearanceRevisionOf(player) + 1
      player.lastMutationAt = Date.now()
      this.usernameIndex.set(key, player.id)
      this.players.markDirty(player.id)
      return { player: this.profileOf(player) }
    }

    // Anonymous registration: account + village + permanent plot in one step.
    if (this.usernameIndex.has(key)) {
      throw new ApiError(409, 'That username is already taken — use LOG IN instead', 'USERNAME_TAKEN')
    }
    const now = Date.now()
    // New accounts occupy world plots exactly like guests; share their budget.
    const creation = this.authLimiter.consumeGuestCreation(rawAddress, now)
    if (!creation.allowed) {
      throw new ApiError(429, 'Too many new villages from this address — try again later')
    }
    const issuedSession = issueSessionToken([], { maximumSessions: MAX_SESSIONS_PER_PLAYER })
    const player = this.createStarterPlayer(now, issuedSession.tokenHashes, {
      username,
      usernameKey: key,
      passwordHash: hashPassword(password)
    })
    this.players.set(player.id, player)
    this.playerDirectory.add(player.id)
    this.tokenIndex.set(issuedSession.tokenHash, player.id)
    this.usernameIndex.set(key, player.id)
    return this.sessionFor(player, issuedSession.token, true)
  }

  /** Log into a registered account from any device. Issues a fresh session token for this device. */
  login(rawUsername: unknown, rawPassword: unknown, rawAddress?: unknown): SessionResponse {
    this.assertMaintenanceAvailable()
    const username = String(rawUsername ?? '').trim()
    const password = typeof rawPassword === 'string' ? rawPassword : ''
    if (!username || !password) throw new ApiError(400, 'Username and password are required')

    const key = normalizeUsernameKey(username)
    const now = Date.now()
    const attempt = this.authLimiter.beginLogin(rawAddress, key, now)
    if (!attempt.allowed && attempt.reason === 'ADDRESS_LIMIT') {
      throw new ApiError(429, 'Too many login attempts from this address')
    }
    if (!attempt.allowed) {
      throw new ApiError(429, 'Too many failed attempts — try again in a minute')
    }

    const playerId = this.usernameIndex.get(key)
    const player = playerId ? this.players.get(playerId) : undefined
    if (!player?.passwordHash) throw new ApiError(404, 'No account found with that username')

    if (!verifyPassword(password, player.passwordHash)) {
      this.authLimiter.recordLoginFailure(attempt.failureKey, now)
      throw new ApiError(401, 'Incorrect password')
    }

    this.authLimiter.recordLoginSuccess(attempt.failureKey)
    this.assertPlayerAccess(player)
    this.touch(player)
    return this.sessionFor(player, this.issueToken(player), false)
  }

  /**
   * Revoke one session token. The account (and its other devices) stay intact —
   * unless this was an UNREGISTERED guest's only token: the village would be
   * unreachable forever (no username/password to return with), so the ghost
   * record is deleted and its plot returned to the wilderness instead of
   * squatting the world map for eternity.
   */
  private deleteGuestPlayer(player: PlayerRecord, releaseCoordinate = true): void {
    if (player.passwordHash) return
    this.cancelPlayerActivity(player.id)
    for (const tokenHash of player.tokenHashes) this.tokenIndex.delete(tokenHash)
    const x = player.plotX ?? 0
    const y = player.plotY ?? 0
    this.plotIndex.delete(plotKey(x, y))
    if (releaseCoordinate) this.releasePlot(x, y, player.plotVersion ?? 1)
    this.notifications.delete(player.id)
    this.players.delete(player.id)
    this.playerDirectory.remove(player.id)
  }

  logout(rawToken: unknown): void {
    const token = normalizeSessionToken(rawToken)
    if (!token) return
    const tokenHash = hashToken(token)
    const playerId = this.tokenIndex.get(tokenHash)
    this.tokenIndex.delete(tokenHash)
    const player = playerId ? this.players.get(playerId) : undefined
    if (!player) return
    player.tokenHashes = revokeSessionToken(player.tokenHashes, token).tokenHashes
    if (!player.passwordHash && player.tokenHashes.length === 0) {
      this.deleteGuestPlayer(player)
      return
    }
    this.players.markDirty(player.id)
  }

  private cancelPlayerActivity(playerId: string) {
    const outgoingId = this.liveByAttacker.get(playerId)
    if (outgoingId) {
      const replay = this.replays.get(outgoingId)
      if (replay) {
        this.untrackLive(replay)
        this.deleteReplay(replay.attackId)
      }
    }
    for (const attackId of [...(this.liveByVictim.get(playerId) ?? [])]) {
      const replay = this.replays.get(attackId)
      if (!replay) continue
      this.untrackLive(replay)
      this.deleteReplay(replay.attackId)
    }
    const botId = this.liveBotByAttacker.get(playerId)
    if (botId) {
      const raid = this.botRaidSessions.get(botId)
      if (raid?.status === 'live') {
        raid.status = 'aborted'
        this.botRaidSessions.markDirty(botId)
        this.noteFinishedBotRaid(raid)
        this.pruneFinishedBotRaids()
      }
      this.liveBotByAttacker.delete(playerId)
    }
  }

  rename(player: PlayerRecord, rawName: unknown): PlayerProfile {
    const name = String(rawName ?? '').trim()
    if (!isValidUsername(name)) {
      throw new ApiError(400, 'Name must be 3-18 characters: letters, numbers, "_" or "-"')
    }
    const key = normalizeUsernameKey(name)
    const owner = this.usernameIndex.get(key)
    if (owner && owner !== player.id) {
      throw new ApiError(409, 'That name belongs to a registered account')
    }
    if (player.username === name) return this.profileOf(player)
    if (player.passwordHash && player.usernameKey && player.usernameKey !== key) {
      // A registered player renaming also moves their login name.
      this.usernameIndex.delete(player.usernameKey)
      this.usernameIndex.set(key, player.id)
      player.usernameKey = key
    }
    player.username = name
    player.revision += 1
    player.appearanceRevision = appearanceRevisionOf(player) + 1
    player.lastMutationAt = Date.now()
    this.players.markDirty(player.id)
    return this.profileOf(player)
  }

  /**
   * Choose the village banner flown at the town hall, carried to war and
   * shown on every neighbour's world map. Every axis is a required bounded
   * enum; once onboarding is complete there is no implicit-default reset.
   * Bumping appearanceRevision (not the economy revision) refreshes neighbour
   * postcards without invalidating in-flight layout saves.
   */
  setBanner(player: PlayerRecord, rawBanner: unknown): { banner: VillageBanner } {
    const banner = sanitizeVillageBanner(rawBanner)
    if (!banner) throw new ApiError(400, 'Invalid banner: palette 0-7, emblem 0-5, and pattern 0-4 are all required')
    if (villageBannersEqual(player.banner, banner)) return { banner: { ...banner } }
    player.banner = banner
    player.appearanceRevision = appearanceRevisionOf(player) + 1
    player.lastMutationAt = Date.now()
    this.players.markDirty(player.id)
    return { banner: { ...banner } }
  }

  // ---- world / resources ----

  /**
   * Update presence. lastSeen stays exact in memory (the leaderboard reads it there);
   * the disk write is throttled because polling clients would otherwise rewrite every
   * player file several times a second for nothing.
   */
  private touch(player: PlayerRecord) {
    const now = Date.now()
    player.lastSeen = now
    if (!player.passwordHash && (player.plotLeaseExpiresAt ?? 0) - now < DEFAULT_GUEST_PLOT_TTL_MS / 2) {
      player.plotLeaseExpiresAt = now + DEFAULT_GUEST_PLOT_TTL_MS
      player.plotLeaseId ||= `guest_${player.id}`
      this.players.markDirty(player.id)
    }
    const persistedAt = this.lastSeenPersistedAt.get(player.id) ?? 0
    if (now - persistedAt >= LAST_SEEN_PERSIST_MS) {
      this.lastSeenPersistedAt.set(player.id, now)
      this.players.markDirty(player.id)
    }
  }

  private productionRemaindersOf(player: PlayerRecord): { ore: number; food: number } {
    const current = player.productionRemainders
    if (current && Number.isFinite(current.ore) && current.ore >= 0 && current.ore < 1
      && Number.isFinite(current.food) && current.food >= 0 && current.food < 1) return current
    return (player.productionRemainders = { ore: 0, food: 0 })
  }

  /** A full store discards overflow instead of banking a hidden fraction for after the next spend. */
  private discardCappedProduction(player: PlayerRecord, caps = resourceCapacity(player.buildings)): void {
    const remainder = this.productionRemaindersOf(player)
    if (player.ore >= caps.ore) remainder.ore = 0
    if (player.food >= caps.food) remainder.food = 0
  }

  /**
   * Materialize every time-derived village change through one deterministic
   * event clock. Upgrade completion, production, storage caps and population
   * staffing now produce the same result regardless of polling cadence.
   */
  private advancePlayer(player: PlayerRecord, now = Date.now()) {
    const result = advanceVillage(player, now, {
      maxBalance: MAX_BALANCE,
      // Food is raid loot. Once a deployment owns the victim lease, births
      // pause until settlement so the advertised cap cannot shrink mid-fight.
      // Do not run expiry from inside simulation: expiry settles an attack and
      // settlement itself advances both villages. The tracked lease is the
      // exact lock signal needed here and avoids a recursive settlement loop.
      populationLocked: (this.liveByVictim.get(player.id)?.size ?? 0) > 0,
      preserveOverCapacity: debugGrantsEnabled()
    })
    this.book('faucets', 'gold', result.produced.gold)
    this.book('faucets', 'ore', result.produced.ore)
    this.book('faucets', 'food', result.produced.food)
    this.book('sinks', 'food', result.foodConsumed)
    const revisionDelta = appearanceRevisionDelta(result)
    if (revisionDelta > 0) {
      player.appearanceRevision = Math.max(0, toInt(player.appearanceRevision, player.revision)) + revisionDelta
      if (result.appearanceChanged) {
        player.lastMutationAt = Math.max(player.lastMutationAt, ...player.buildings.map(building => building.builtAt ?? 0))
      }
      this.players.markDirty(player.id)
    }
    return result
  }

  /** Compatibility wrappers while command handlers are split into modules. */
  private resolveUpgrades(player: PlayerRecord, now = Date.now()) { this.advancePlayer(player, now) }
  private accrue(player: PlayerRecord, now = Date.now()) { this.advancePlayer(player, now) }
  private accruePopulation(player: PlayerRecord, now = Date.now()) { this.advancePlayer(player, now) }

  private profileOf(player: PlayerRecord): PlayerProfile {
    return {
      id: player.id,
      username: player.username,
      trophies: player.trophies,
      createdAt: player.createdAt,
      lastSeen: player.lastSeen,
      plotX: player.plotX ?? 0,
      plotY: player.plotY ?? 0,
      shieldUntil: player.shieldUntil ?? 0,
      registered: Boolean(player.passwordHash)
    }
  }

  worldOf(player: PlayerRecord): SerializedWorld {
    this.advancePlayer(player)
    return {
      id: `world_${player.id}`,
      ownerId: player.id,
      username: player.username,
      buildings: player.buildings.map(b => ({ ...b })),
      obstacles: player.obstacles.map(o => ({ ...o })),
      resources: { gold: Math.floor(player.balance), ore: player.ore, food: player.food },
      storage: resourceCapacity(player.buildings),
      population: {
        count: player.population.count,
        capacity: populationCapacity(player.buildings),
        workersNeeded: workersNeeded(player.buildings),
        staffing: staffingFactor(player.buildings, player.population.count),
        bornAt: [...(player.population.bornAt ?? [])]
      },
      army: { ...player.army },
      // Own-world payloads carry trophies so a defense loss reaches the HUD
      // on the ordinary world poll instead of waiting for the next attack.
      trophies: player.trophies,
      // The effective upgrade clock, so client-advertised durations can never
      // drift from what this server will actually bill.
      upgradePolicy: {
        ...(FIXED_UPGRADE_DURATION_MS !== undefined ? { fixedDurationMs: FIXED_UPGRADE_DURATION_MS } : {}),
        timeScale: UPGRADE_TIME_SCALE
      },
      wallLevel: player.wallLevel,
      // Real change time, so the client's "is the remote newer than my local?" check stays meaningful.
      lastSaveTime: player.lastMutationAt || player.lastAccrualAt,
      revision: player.revision,
      ...(player.banner ? { banner: { ...player.banner } } : {})
    }
  }

  /** Stone paving is SERVER truth: a pure function of account age (fully
   *  paved after ~9 minutes of village life), so every viewer — including
   *  the owner across devices — sees the same lanes at the same age. */
  stoneMaturityOf(player: PlayerRecord): number {
    return Math.min(1, Math.max(0, (Date.now() - player.createdAt) / (9 * 60_000)))
  }

  getWorld(player: PlayerRecord): SerializedWorld {
    return { ...this.worldOf(player), stoneMaturity: this.stoneMaturityOf(player) } as SerializedWorld
  }

  scout(viewer: PlayerRecord, targetId: unknown): PublicWorldSnapshot {
    const target = this.players.get(sanitizeId(targetId))
    if (!target) throw new ApiError(404, 'Player not found')
    const sight = watchtowerSightOf(viewer.buildings)
    const distance = chebyshevDistance(viewer.plotX ?? 0, viewer.plotY ?? 0, target.plotX ?? 0, target.plotY ?? 0)
    if (target.id !== viewer.id && distance > sight) throw new ApiError(403, 'That village is beyond your watchtower sight')
    this.advancePlayer(target)
    return publicWorldOf(target)
  }

  private normalizeKey(requestId: unknown): string {
    return typeof requestId === 'string' ? requestId.trim().slice(0, 160) : ''
  }

  private hasRequestKey(player: PlayerRecord, key: string): boolean {
    return key !== '' && player.requestKeys.includes(key)
  }

  /**
   * Record a request key so retries are deduplicated. Call this ONLY after the
   * operation has actually committed — a key recorded for a rejected/failed
   * request would make a legitimate retry a silent no-op.
   */
  private recordRequestKey(player: PlayerRecord, key: string): void {
    if (!key) return
    player.requestKeys.push(key)
    if (player.requestKeys.length > MAX_REQUEST_KEYS) {
      player.requestKeys.splice(0, player.requestKeys.length - MAX_REQUEST_KEYS)
    }
  }

  /**
   * Persist the player's base layout — and CHARGE for it. The layout is
   * client-authoritative in shape, but every level it claims is priced here
   * against the stored state: placements, upgrades and obstacle clearing are
   * paid out of the server balance, demolitions refund, and a save the player
   * cannot afford is rejected wholesale. The save IS the purchase; there is no
   * other way to acquire levels. The army is NOT part of the save at all —
   * troops move only through train/untrain and battle consumption.
   */
  saveWorld(player: PlayerRecord, body: { world?: Partial<SerializedWorld>; requestId?: unknown }): SerializedWorld {
    const world = body?.world
    if (!world || typeof world !== 'object') throw new ApiError(400, 'Missing world payload')

    // Already-applied save: return the current state without re-applying.
    const key = this.normalizeKey(body.requestId)
    if (this.hasRequestKey(player, key)) {
      return this.worldOf(player)
    }

    // Land matured upgrade timers BEFORE diffing: a client whose local clock
    // already materialized the level must not be re-charged for it.
    this.resolveUpgrades(player)

    const expectedRevision = toInt(world.revision, Number.NaN)
    if (!Number.isFinite(expectedRevision) || expectedRevision !== player.revision) {
      throw new ApiError(409, `Stale world revision (expected ${player.revision})`, 'STALE_REVISION', {
        currentRevision: player.revision,
        world: this.worldOf(player)
      })
    }
    this.assertBaseEconomyUnlocked(player)

    // Validate BEFORE recording the key, so a rejected save can be retried.
    // Domain failures stay transport-neutral until this API boundary.
    const applyVillageRules = <T>(operation: () => T): T => {
      try {
        return operation()
      } catch (error) {
        if (!(error instanceof VillageRuleError)) throw error
        const details = error.rule === 'UPGRADE_IN_PROGRESS'
          ? { world: this.worldOf(player) }
          : error.details
        throw new ApiError(error.failure === 'CONFLICT' ? 409 : 400, error.message, error.clientCode, details)
      }
    }
    const sanitizeContext = {
      now: Date.now(),
      createId: (prefix: 'b' | 'o') => `${prefix}_${randomHex(6)}`
    }
    const proposedBuildings = applyVillageRules(() => sanitizeBuildings(world.buildings, sanitizeContext))
    const proposedObstacles = applyVillageRules(() => sanitizeObstacles(world.obstacles, sanitizeContext))
    const proposal = applyVillageRules(() => validateVillageLayout({
      currentBuildings: player.buildings,
      currentObstacles: player.obstacles,
      currentWallLevel: player.wallLevel,
      proposedBuildings,
      proposedObstacles,
      proposedWallLevel: world.wallLevel,
      army: player.army
    }))

    // A save that changes no authority-owned layout field is a read, not a
    // revision/fsync mutation. This also makes retries with a fresh request id
    // harmless after the original response was lost.
    if (!proposal.changed) return this.worldOf(player)

    this.accrue(player)
    this.accruePopulation(player) // grow at the OLD capacity before the layout changes

    // ---- price the diff (charges, refunds and rewards booked separately) ----
    const pricing = applyVillageRules(() => priceVillageMutation({
      currentBuildings: player.buildings,
      currentObstacles: player.obstacles,
      proposedBuildings: proposal.buildings,
      proposedObstacles: proposal.obstacles,
      now: Date.now(),
      upgradeTimeScale: UPGRADE_TIME_SCALE,
      fixedUpgradeDurationMs: FIXED_UPGRADE_DURATION_MS
    }))
    const { buildings, charges, refundGold, obstacleRewards, bill } = pricing
    const obstacles = proposal.obstacles
    const infiniteResources = infiniteResourcesEnabled()

    // ---- settle or refuse (before any mutation, so a refusal changes nothing) ----
    if (!infiniteResources && bill.gold > 0 && Math.floor(player.balance) < bill.gold) {
      throw new ApiError(409, `Not enough gold for these changes (need ${bill.gold})`, 'INSUFFICIENT_RESOURCES', { resource: 'gold' })
    }
    if (!infiniteResources && bill.ore > 0 && player.ore < bill.ore) {
      throw new ApiError(409, `Not enough ore for these changes (need ${bill.ore})`, 'INSUFFICIENT_RESOURCES', { resource: 'ore' })
    }

    if (!infiniteResources) player.balance = clamp(player.balance - bill.gold, 0, MAX_BALANCE)
    player.buildings = buildings
    player.obstacles = obstacles
    // Ore settles against the NEW layout's storage (a save may add the storehouse it fills).
    const caps = resourceCapacity(player.buildings)
    if (!infiniteResources) {
      player.ore = storedResourceAfterDelta(player.ore, -bill.ore, caps.ore, false, debugGrantsEnabled())
      player.food = storedResourceAfterDelta(player.food, 0, caps.food, false, debugGrantsEnabled())
    }
    this.discardCappedProduction(player, caps)
    player.wallLevel = proposal.wallLevel
    // The new layout may house fewer people; never let count exceed capacity.
    player.population.count = Math.min(player.population.count, populationCapacity(player.buildings))
    player.revision += 1
    player.layoutRevision = Math.max(0, toInt(player.layoutRevision, player.revision - 1)) + 1
    player.appearanceRevision = appearanceRevisionOf(player) + 1
    player.lastMutationAt = Date.now()
    this.recordRequestKey(player, key)
    this.players.markDirty(player.id)
    if (!infiniteResources) {
      this.book('sinks', 'gold', charges.gold)
      this.book('sinks', 'ore', charges.ore)
      this.book('refunds', 'gold', refundGold)
      this.book('faucets', 'gold', obstacleRewards)
    }
    if (charges.gold > 0 || charges.ore > 0 || refundGold > 0) this.bookCount('saves')
    return this.worldOf(player)
  }

  /**
   * Apply a spend/grant to one of the player's resources (default: gold).
   * Idempotent per requestId; overdrafts are refused without consuming the key.
   *
   * GRANTS ARE NOT OPEN: every real income source (production, loot, merchant,
   * refunds) is priced server-side elsewhere. The only positive deltas this
   * endpoint accepts are the tiny ambient village grants (egg collecting, rock
   * hauling), whitelisted by reason, size-capped per call and rate-capped per
   * hour — plus an explicit debug grant gated behind CLASH_ALLOW_DEBUG_GRANTS
   * for tests and local tinkering.
   */
  applyResources(player: PlayerRecord, body: { delta?: unknown; resource?: unknown; reason?: unknown; requestId?: unknown }): { applied: boolean; gold: number; ore: number; food: number; revision: number } {
    this.accrue(player)
    const delta = toInt(body?.delta, Number.NaN)
    if (!Number.isFinite(delta)) throw new ApiError(400, 'delta must be a finite number')
    const resource: ResourceKind = body?.resource === 'ore' ? 'ore' : body?.resource === 'food' ? 'food' : 'gold'
    const reason = typeof body?.reason === 'string' ? body.reason.slice(0, 40) : ''
    const isDebugGrant = delta > 0 && reason === 'debug_grant' && debugGrantsEnabled()

    const balances = () => ({
      gold: Math.floor(player.balance),
      ore: player.ore,
      food: player.food,
      revision: player.revision
    })

    const key = this.normalizeKey(body?.requestId)
    // Already-applied delta: echo the committed result, do not apply again.
    if (this.hasRequestKey(player, key)) {
      return { applied: true, ...balances() }
    }

    if (delta === 0) return { applied: false, ...balances() }
    if (delta < 0) this.assertBaseEconomyUnlocked(player)

    if (delta > 0 && !isDebugGrant) {
      const rule = AMBIENT_GRANTS[reason]
      if (!rule || rule.kind !== resource) {
        throw new ApiError(403, 'Resources are earned, not granted')
      }
      if (delta > rule.perCall) throw new ApiError(403, 'Grant exceeds the ambient cap')
      const now = Date.now()
      let window = this.grantWindows.get(player.id)
      if (!window || now - window.startedAt > 60 * 60_000) {
        window = { startedAt: now, granted: {} }
        this.grantWindows.set(player.id, window)
      }
      const soFar = window.granted[reason] ?? 0
      if (soFar + delta > rule.perHour) {
        // Ambient overflow is not an error — the village just banks nothing more this hour.
        return { applied: false, ...balances() }
      }
      window.granted[reason] = soFar + delta
    }

    const infiniteSpend = delta < 0 && infiniteResourcesEnabled()
    // Reject overdrafts WITHOUT recording the key, so the client can retry after earning more.
    const current = resource === 'gold' ? Math.floor(player.balance) : player[resource]
    if (!infiniteSpend && delta < 0 && current + delta < 0) {
      return { applied: false, ...balances() }
    }

    if (!infiniteSpend) {
      if (resource === 'gold') {
        player.balance = clamp(player.balance + delta, 0, MAX_BALANCE)
      } else {
        const caps = resourceCapacity(player.buildings)
        player[resource] = storedResourceAfterDelta(
          player[resource], delta, caps[resource], isDebugGrant, debugGrantsEnabled()
        )
        this.discardCappedProduction(player, caps)
      }
    }
    if (delta > 0) this.book('faucets', resource, delta)
    else if (!infiniteSpend) this.book('sinks', resource, -delta)
    player.revision += 1
    player.lastMutationAt = Date.now()
    this.recordRequestKey(player, key)
    this.players.markDirty(player.id)
    return { applied: true, ...balances() }
  }

  // ---- army (server-owned: the only doors are train, untrain and battle) ----

  /**
   * Train troops: the server checks the barracks unlock, camp housing and the
   * bill (gold + food), then adds to the ONE authoritative army. World saves
   * carry no army at all, so a forged save cannot conjure a horde.
   */
  trainTroop(player: PlayerRecord, body: { type?: unknown; count?: unknown; requestId?: unknown }): { army: Record<string, number>; gold: number; ore: number; food: number; revision: number } {
    const type = sanitizeId(body?.type) as TroopType
    const def = hasOwn(TROOP_DEFINITIONS, type) ? TROOP_DEFINITIONS[type] : undefined
    if (!def || !isTrainableTroopType(type)) throw new ApiError(404, 'Unknown troop type')
    const count = clamp(toInt(body?.count, 1), 1, 50)

    const key = this.normalizeKey(body?.requestId)
    if (this.hasRequestKey(player, key)) {
      return this.armyBalances(player)
    }

    if (this.activeAttackFor(player.id)) throw new ApiError(409, 'Army is reserved for an active attack')
    if (this.activeBotRaidFor(player.id)) throw new ApiError(409, 'Army is reserved for an active bot raid')
    this.assertBaseEconomyUnlocked(player)

    this.accrue(player)
    const trainingRequirement = troopTrainingRequirement(type)
    if (!trainingRequirement) throw new ApiError(404, 'Unknown troop type')
    if (trainingRequirement.kind === 'core') {
      if (maxCompletedArmyCampLevel(player.buildings) < trainingRequirement.unlockLevel) {
        throw new ApiError(403, `${def.name} needs a level ${trainingRequirement.unlockLevel} ${trainingRequirement.campName}`)
      }
    } else if (barracksLevelForTroop(player.buildings, type) < trainingRequirement.unlockLevel) {
      throw new ApiError(403, `${def.name} needs a level ${trainingRequirement.unlockLevel} ${trainingRequirement.barracksName}`)
    }
    if (armySpaceUsed(player.army) + def.space * count > campCapacityOf(player.buildings)) {
      throw new ApiError(409, 'Not enough housing space in the camps')
    }
    const goldCost = def.cost * count
    const foodCost = troopFoodCostOf(type) * count
    const infiniteResources = infiniteResourcesEnabled()
    if (!infiniteResources && Math.floor(player.balance) < goldCost) throw new ApiError(409, `Not enough gold (need ${goldCost})`)
    if (!infiniteResources && player.food < foodCost) throw new ApiError(409, `Not enough food (need ${foodCost})`)

    if (!infiniteResources) {
      player.balance = clamp(player.balance - goldCost, 0, MAX_BALANCE)
      player.food -= foodCost
    }
    player.army[type] = (player.army[type] ?? 0) + count
    if (!infiniteResources) {
      this.book('sinks', 'gold', goldCost)
      this.book('sinks', 'food', foodCost)
    }
    player.revision += 1
    player.lastMutationAt = Date.now()
    this.recordRequestKey(player, key)
    this.players.markDirty(player.id)
    return this.armyBalances(player)
  }

  /** Dismiss troops for a full refund of their training bill. */
  untrainTroop(player: PlayerRecord, body: { type?: unknown; count?: unknown; requestId?: unknown }): { army: Record<string, number>; gold: number; ore: number; food: number; revision: number } {
    const type = sanitizeId(body?.type) as TroopType
    const def = hasOwn(TROOP_DEFINITIONS, type) ? TROOP_DEFINITIONS[type] : undefined
    if (!def) throw new ApiError(404, 'Unknown troop type')
    const count = clamp(toInt(body?.count, 1), 1, 50)

    const key = this.normalizeKey(body?.requestId)
    if (this.hasRequestKey(player, key)) {
      return this.armyBalances(player)
    }

    if (this.activeAttackFor(player.id)) throw new ApiError(409, 'Army is reserved for an active attack')
    if (this.activeBotRaidFor(player.id)) throw new ApiError(409, 'Army is reserved for an active bot raid')

    const have = player.army[type] ?? 0
    if (have < count) throw new ApiError(409, 'Not that many troops in camp')

    this.accrue(player)
    if (have - count <= 0) delete player.army[type]
    else player.army[type] = have - count
    if (!infiniteResourcesEnabled()) {
      player.balance = clamp(player.balance + def.cost * count, 0, MAX_BALANCE)
      const caps = resourceCapacity(player.buildings)
      player.food = storedResourceAfterDelta(
        player.food, troopFoodCostOf(type) * count, caps.food, false, debugGrantsEnabled()
      )
      this.discardCappedProduction(player, caps)
      this.book('refunds', 'gold', def.cost * count)
      this.book('refunds', 'food', troopFoodCostOf(type) * count)
    }
    player.revision += 1
    player.lastMutationAt = Date.now()
    this.recordRequestKey(player, key)
    this.players.markDirty(player.id)
    return this.armyBalances(player)
  }

  private armyBalances(player: PlayerRecord) {
    return {
      army: { ...player.army },
      gold: Math.floor(player.balance),
      ore: player.ore,
      food: player.food,
      revision: player.revision
    }
  }

  // ---- the travelling merchant (server-priced) ----

  /**
   * Take one of today's merchant deals. The offers are a pure function of
   * (playerId, world-day) that the client renders from the same shared code —
   * the server just re-derives them, so no client can invent an exchange rate.
   * Each deal can be taken once per world-day.
   */
  merchantTrade(player: PlayerRecord, body: { offerId?: unknown; requestId?: unknown }): { applied: boolean; offerId: number; gold: number; ore: number; food: number; revision: number } {
    const dayIndex = worldDayIndex(Date.now())
    const offers = merchantOffersFor(player.id, dayIndex)
    const offer = offers.find(o => o.id === toInt(body?.offerId, -1))
    if (!offer) throw new ApiError(404, 'The merchant has no such deal today')

    const balances = () => ({
      gold: Math.floor(player.balance),
      ore: player.ore,
      food: player.food,
      revision: player.revision
    })

    const key = this.normalizeKey(body?.requestId)
    if (this.hasRequestKey(player, key)) {
      return { applied: true, offerId: offer.id, ...balances() }
    }
    const onceKey = `merchant:${dayIndex}:${offer.id}`
    const redemptionKey = `${dayIndex}:${offer.id}`
    if (player.merchantRedemptions?.[redemptionKey] || this.hasRequestKey(player, onceKey)) {
      throw new ApiError(409, 'That deal is done for today')
    }

    this.assertBaseEconomyUnlocked(player)

    this.accrue(player)
    const have = offer.give.kind === 'gold' ? Math.floor(player.balance) : player[offer.give.kind]
    const infiniteResources = infiniteResourcesEnabled()
    if (!infiniteResources && have < offer.give.amount) {
      return { applied: false, offerId: offer.id, ...balances() }
    }

    if (!infiniteResources) {
      const caps = resourceCapacity(player.buildings)
      const pay = (kind: 'gold' | 'ore' | 'food', delta: number) => {
        if (kind === 'gold') player.balance = clamp(player.balance + delta, 0, MAX_BALANCE)
        else player[kind] = storedResourceAfterDelta(player[kind], delta, caps[kind], false, debugGrantsEnabled())
      }
      pay(offer.give.kind, -offer.give.amount)
      pay(offer.get.kind, offer.get.amount)
      this.discardCappedProduction(player, caps)
      this.book('sinks', offer.give.kind, offer.give.amount)
      this.book('faucets', offer.get.kind, offer.get.amount)
    }
    this.bookCount('trades')
    player.revision += 1
    player.lastMutationAt = Date.now()
    this.recordRequestKey(player, key)
    const redemptions = player.merchantRedemptions ?? (player.merchantRedemptions = {})
    redemptions[redemptionKey] = Date.now()
    for (const oldKey of Object.keys(redemptions)) {
      const day = toInt(oldKey.split(':')[0], dayIndex)
      if (day < dayIndex - 2) delete redemptions[oldKey]
    }
    this.players.markDirty(player.id)
    return { applied: true, offerId: offer.id, ...balances() }
  }

  // ---- bot raids (deterministic camps on the world map) ----

  private pruneBotRaidCooldowns(player: PlayerRecord, now = Date.now()): Record<string, number> {
    const raids = player.botRaids ?? (player.botRaids = {})
    let changed = false
    for (const [key, settledAt] of Object.entries(raids)) {
      if (!Number.isFinite(settledAt) || now - settledAt >= BOT_RAID_COOLDOWN_MS) {
        delete raids[key]
        changed = true
      }
    }
    const newest = Object.entries(raids)
      .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    for (const [key] of newest.slice(MAX_BOT_RAID_COOLDOWNS)) {
      delete raids[key]
      changed = true
    }
    if (changed) {
      player.botRaids = raids
      this.players.markDirty(player.id)
    }
    return raids
  }

  private botCampForStart(player: PlayerRecord, rawX: unknown, rawY: unknown): { x: number; y: number; seed: number; visibleAtStart: boolean } {
    const explicit = rawX !== undefined || rawY !== undefined
    const now = Date.now()
    const raids = this.pruneBotRaidCooldowns(player, now)
    const eligible = (x: number, y: number) => {
      if (this.plotIndex.has(plotKey(x, y))) return null
      // The same settled-frontier rule the map presents: structural clans
      // everywhere, plus fill camps at unclaimed central spiral plots — a
      // camp the map shows is always a camp the player can raid.
      const seed = settledFrontierBotVillageSeedAt({ x, y }, {
        frontierRadius: this.botFrontierRadius(),
        presentationSeedVersion: this.allocationState.presentationSeedVersion
      })
      if (seed === null || now - (raids[plotKey(x, y)] ?? 0) < BOT_RAID_COOLDOWN_MS) return null
      return { x, y, seed }
    }
    if (explicit) {
      if (rawX === undefined || rawY === undefined) throw new ApiError(400, 'Both camp coordinates are required')
      const x = worldCoord(rawX, Number.NaN)
      const y = worldCoord(rawY, Number.NaN)
      const sight = watchtowerSightOf(player.buildings)
      const distance = chebyshevDistance(x, y, player.plotX ?? 0, player.plotY ?? 0)
      if (distance === 0 || distance > sight) throw new ApiError(403, 'That camp is beyond your watchtower sight')
      const camp = eligible(x, y)
      if (!camp) throw new ApiError(409, 'That camp is unavailable or still recovering')
      return { ...camp, visibleAtStart: true }
    }

    // Cloud matchmaking may pick a remote deterministic camp. Start just
    // beyond direct sight so this route cannot be confused with map vision.
    const homeX = player.plotX ?? 0
    const homeY = player.plotY ?? 0
    const startRadius = Math.max(1, watchtowerSightOf(player.buildings) + 1)
    for (let radius = startRadius; radius <= WORLD_COORD_LIMIT * 2; radius++) {
      for (let y = Math.max(-WORLD_COORD_LIMIT, homeY - radius); y <= Math.min(WORLD_COORD_LIMIT, homeY + radius); y++) {
        for (let x = Math.max(-WORLD_COORD_LIMIT, homeX - radius); x <= Math.min(WORLD_COORD_LIMIT, homeX + radius); x++) {
          if (chebyshevDistance(x, y, homeX, homeY) !== radius) continue
          const camp = eligible(x, y)
          if (camp) return { ...camp, visibleAtStart: false }
        }
      }
    }
    throw new ApiError(404, 'No bot camps are available')
  }

  /** Build the immutable BOT target and reserve the army through the shared attack aggregate. */
  private prepareBotAuthority(
    player: PlayerRecord,
    raid: Pick<BotRaidRecord, 'raidId' | 'x' | 'y' | 'seed' | 'visibleAtStart' | 'reservedArmy' | 'troopLevel' | 'startedAt' | 'expiresAt'>,
    bot = this.persistedBotVillageAt(raid.x, raid.y, raid.seed)
  ): AttackAggregate {
    const world = structuredClone(bot.world)
    return prepareBotAttack({
      attackId: raid.raidId,
      attackerId: player.id,
      attackerName: player.username,
      sourceArmyVersion: player.revision,
      selectionSource: raid.visibleAtStart ? 'BOT_MAP' : 'BOT_MATCHMADE',
      worldId: LEGACY_WORLD_ID,
      botId: bot.id,
      botGeneratorVersion: bot.generatorVersion,
      botVillageRevision: bot.revision,
      botPlotVersion: bot.plotVersion,
      x: raid.x,
      y: raid.y,
      seed: raid.seed,
      world,
      reservedArmy: sanitizeArmy(raid.reservedArmy) as TroopCounts,
      troopLevel: raid.troopLevel,
      startedAt: raid.startedAt,
      expiresAt: raid.expiresAt,
      raidableShare: RAIDABLE_SHARE
    })
  }

  botStart(player: PlayerRecord, body: { x?: unknown; y?: unknown; requestId?: unknown }, rawToken?: unknown): { raidId: string; x: number; y: number; seed: number; world: SerializedWorld; expiresAt: number } {
    this.pruneFinishedBotRaids()
    const requestId = this.normalizeKey(body?.requestId)
    if (requestId) {
      const existingId = this.startRequestIndex.get('bot-start', player.id, requestId)
      const existing = existingId ? this.botRaidSessions.get(existingId) : undefined
      if (existing?.status === 'live' && existing.expiresAt <= Date.now()) {
        this.expireBotRaid(existing, player, Date.now())
      }
      if (existingId && (!existing || existing.status !== 'live')) {
        throw new ApiError(409, 'That bot raid start request is no longer live')
      }
      if (existing) {
        const bot = this.persistedBotVillageAt(existing.x, existing.y, existing.seed)
        return {
          raidId: existing.raidId,
          x: existing.x,
          y: existing.y,
          seed: existing.seed,
          world: structuredClone(bot.world),
          expiresAt: existing.expiresAt
        }
      }
    }
    if (this.activeAttackFor(player.id)) throw new ApiError(409, 'Finish or abort your active PvP attack first')
    if (this.activeBotRaidFor(player.id)) throw new ApiError(409, 'Finish or retreat from your active bot raid first')
    if (armySpaceUsed(player.army) <= 0) throw new ApiError(409, 'Train troops before starting a bot raid')
    const camp = this.botCampForStart(player, body?.x, body?.y)
    const bot = this.persistedBotVillageAt(camp.x, camp.y, camp.seed)
    const now = Date.now()
    const raidId = `botraid_${randomHex(9)}`
    const raid: BotRaidRecord = {
      raidId,
      attackerId: player.id,
      x: camp.x,
      y: camp.y,
      seed: camp.seed,
      botId: bot.id,
      botVillageRevision: bot.revision,
      botPlotVersion: bot.plotVersion,
      botGeneratorVersion: bot.generatorVersion,
      visibleAtStart: camp.visibleAtStart,
      status: 'live',
      startedAt: now,
      expiresAt: now + BOT_RAID_SESSION_MS,
      reservedArmy: sanitizeArmy(player.army),
      troopLevel: troopLevelOf(player.buildings),
      ...(requestId ? { startRequestId: requestId } : {}),
      ...(typeof rawToken === 'string' && rawToken ? { ownerTokenHash: hashToken(rawToken) } : {})
    }
    const world = structuredClone(bot.world)
    try {
      raid.authority = this.prepareBotAuthority(player, raid, bot)
    } catch (error) {
      this.attackDomainError(error)
    }
    this.botRaidSessions.set(raid.raidId, raid)
    this.liveBotByAttacker.set(player.id, raid.raidId)
    if (!this.botRaidSessions.flush()) {
      this.liveBotByAttacker.delete(player.id)
      this.botRaidSessions.delete(raid.raidId)
      throw new ApiError(503, 'Could not persist bot raid session')
    }
    if (requestId) this.startRequestIndex.set('bot-start', player.id, requestId, raid.raidId, now)
    return { raidId: raid.raidId, x: camp.x, y: camp.y, seed: camp.seed, world, expiresAt: raid.expiresAt }
  }

  private applyBotAuthorityCommand(raid: BotRaidRecord, command: AttackCommand, now = Date.now()) {
    const authority = raid.authority
    if (!authority) throw new ApiError(409, 'This legacy bot raid must be restarted', 'ATTACK_INVALIDATED')
    try {
      const applied = applyBotAttackCommand(authority, command, now, raid.expiresAt)
      raid.authority = applied.attack
      this.botRaidSessions.markDirty(raid.raidId)
      return {
        ...applied.receipt,
        version: applied.attack.version,
        duplicate: applied.duplicate
      }
    } catch (error) {
      this.attackDomainError(error)
    }
  }

  private pushBotCommands(player: PlayerRecord, raid: BotRaidRecord, commands: unknown[]) {
    if (raid.attackerId !== player.id) throw new ApiError(403, 'That bot raid belongs to another player')
    if (commands.length !== 1) throw new ApiError(400, 'Exactly one combat command is required')
    if (raid.status !== 'live') {
      const commandId = sanitizeId((commands[0] as { commandId?: unknown } | undefined)?.commandId)
      if (!commandId || !raid.authority?.commandReceipts[commandId]) {
        throw new ApiError(409, 'That bot raid is no longer active', 'ATTACK_INVALIDATED')
      }
    }
    if (raid.status === 'live' && raid.expiresAt <= Date.now()) {
      this.expireBotRaid(raid, player, Date.now())
      throw new ApiError(409, 'That bot raid has expired', 'ATTACK_EXPIRED')
    }
    const receipts = [this.applyBotAuthorityCommand(raid, commands[0] as AttackCommand)]
    return {
      attackId: raid.raidId,
      raidId: raid.raidId,
      phase: raid.authority?.phase ?? 'EXPIRED',
      version: raid.authority?.version ?? 0,
      lastCommandSequence: raid.authority?.lastCommandSequence ?? 0,
      receipts
    }
  }

  /** Test/import bridge: turn legacy aggregate counts into genuine DEPLOY commands. */
  private applyLegacyBotDeployments(raid: BotRaidRecord, player: PlayerRecord, rawDeployed: unknown, now: number) {
    if (!ALLOW_LEGACY_FRAME_COMMANDS) return
    const desired = sanitizeArmy(rawDeployed)
    for (const [type, count] of Object.entries(desired)) {
      if (!hasOwn(TROOP_DEFINITIONS, type) || GENERATED_ONLY.has(type)) throw new ApiError(400, 'Unknown deployed troop')
      if (count <= 0 || count > (raid.reservedArmy[type] ?? 0) || count > (player.army[type] ?? 0)) {
        throw new ApiError(409, `Not enough reserved ${type} troops`)
      }
    }
    const alreadyDeployed = raid.authority?.reservation.deployed ?? {}
    for (const type of Object.keys(desired).sort()) {
      const requested = desired[type] ?? 0
      const existing = alreadyDeployed[type as ReservableTroopType] ?? 0
      for (let index = existing; index < requested; index += 1) {
        const sequence = (raid.authority?.lastCommandSequence ?? 0) + 1
        this.applyBotAuthorityCommand(raid, {
          type: 'DEPLOY',
          commandId: `legacy_${raid.raidId}_${type}_${index}`,
          sequence,
          troopInstanceId: `legacy_${raid.raidId}_${type}_${index}`,
          troopType: type as ReservableTroopType,
          gridX: 0,
          gridY: 0
        }, now)
      }
    }
  }

  /** Write the bot settlement journal before touching the player's army or balance. */
  private prepareBotSettlement(raid: BotRaidRecord, player: PlayerRecord, now: number, requestId?: string) {
    const result = raid.authority?.finalization?.result
    const deployed = sanitizeArmy(raid.authority?.reservation.deployed ?? {})
    const bot = this.persistedBotVillageAt(raid.x, raid.y, raid.seed)
    this.accrue(player, now)
    const lootApplied = Math.min(
      result?.loot.gold ?? 0,
      Math.floor(Math.max(0, bot.world.resources.gold)),
      Math.floor(Math.max(0, MAX_BALANCE - player.balance))
    )
    raid.status = 'settling'
    raid.preparedSettlement = {
      lootApplied,
      botRevisionBefore: bot.revision,
      botRevisionAfter: bot.revision + (lootApplied > 0 ? 1 : 0),
      botGoldAfter: Math.max(0, bot.world.resources.gold - lootApplied),
      deployed,
      destruction: result?.destruction ?? 0,
      ...(result?.resultHash ? { resultHash: result.resultHash } : {}),
      settledAt: now
    }
    raid.settleRequestId = requestId || undefined
    if (this.liveBotByAttacker.get(player.id) === raid.raidId) this.liveBotByAttacker.delete(player.id)
    this.botRaidSessions.markDirty(raid.raidId)
    if (!this.botRaidSessions.flush()) throw new ApiError(503, 'Could not prepare bot settlement')
    return this.applyPreparedBotSettlement(raid, player)
  }

  /** Close an expired BOT aggregate; deployed roots time out into a real settlement. */
  private expireBotRaid(raid: BotRaidRecord, player: PlayerRecord, now: number) {
    if (raid.status !== 'live') return
    let authority = raid.authority
    if (authority && (authority.phase === 'PREPARING' || authority.phase === 'ENGAGED' || authority.phase === 'ACTIVE')) {
      try {
        authority = expireAttack(authority, {
          expectedPhase: authority.phase,
          expectedVersion: authority.version
        }, Math.max(now, authority.timestamps.expiresAt))
      } catch (error) {
        this.attackDomainError(error)
      }
      raid.authority = authority
    }
    if (authority?.phase === 'FINALIZING') {
      this.prepareBotSettlement(raid, player, now, `timeout_${raid.raidId}`)
      return
    }
    raid.status = 'aborted'
    if (this.liveBotByAttacker.get(player.id) === raid.raidId) this.liveBotByAttacker.delete(player.id)
    this.botRaidSessions.markDirty(raid.raidId)
    this.noteFinishedBotRaid(raid)
    this.pruneFinishedBotRaids()
  }

  botSettle(player: PlayerRecord, body: { raidId?: unknown; x?: unknown; y?: unknown; destruction?: unknown; deployed?: unknown; requestId?: unknown }): { lootApplied: number; attackerBalance: number; army: Record<string, number>; revision: number } {
    const raidId = sanitizeId(body?.raidId)
    if (!raidId) throw new ApiError(400, 'A server-issued bot raidId is required')
    const raid = this.botRaidSessions.get(raidId)
    if (!raid) throw new ApiError(404, 'Bot raid session not found')
    if (raid.attackerId !== player.id) throw new ApiError(403, 'That bot raid belongs to another player')
    if (raid.status === 'settling') return this.applyPreparedBotSettlement(raid, player)
    if (raid.status !== 'live') {
      if (raid.finalResult) return { ...raid.finalResult, army: { ...raid.finalResult.army } }
      throw new ApiError(409, 'That bot raid is no longer live')
    }
    if (raid.expiresAt <= Date.now()) {
      this.expireBotRaid(raid, player, Date.now())
      const expiredRaid = this.botRaidSessions.get(raidId)
      if (expiredRaid?.status === 'settling') return this.applyPreparedBotSettlement(expiredRaid, player)
      if (expiredRaid?.finalResult) return { ...expiredRaid.finalResult, army: { ...expiredRaid.finalResult.army } }
      throw new ApiError(409, 'That bot raid has expired')
    }
    if (body?.x !== undefined || body?.y !== undefined) {
      if (body.x === undefined || body.y === undefined) throw new ApiError(400, 'Both camp coordinates are required')
      const x = worldCoord(body.x, Number.NaN)
      const y = worldCoord(body.y, Number.NaN)
      if (x !== raid.x || y !== raid.y) throw new ApiError(409, 'Camp coordinates do not match the bot raid session')
    }

    const now = Date.now()
    this.applyLegacyBotDeployments(raid, player, body?.deployed, now)
    let authority = raid.authority
    if (authority?.phase === 'ACTIVE') {
      try {
        authority = finalizeAttack(authority, {
          expectedPhase: authority.phase,
          expectedVersion: authority.version
        }, 'OBJECTIVE_COMPLETE', now)
      } catch (error) {
        this.attackDomainError(error)
      }
      raid.authority = authority
    } else if (authority?.phase === 'PREPARING' || authority?.phase === 'ENGAGED') {
      try {
        authority = cancelAttack(authority, {
          expectedPhase: authority.phase,
          expectedVersion: authority.version
        }, now, 'bot raid ended before deployment')
      } catch (error) {
        this.attackDomainError(error)
      }
      raid.authority = authority
    }
    const response = this.prepareBotSettlement(raid, player, now, this.normalizeKey(body?.requestId))
    this.pruneFinishedBotRaids()
    return response
  }

  /** DEV ONLY (CLASH_ALLOW_DEBUG_GRANTS=1): drop every shield in the world so attacks can be tested freely. */
  debugClearShields(): { cleared: number } {
    if (process.env.CLASH_ALLOW_DEBUG_GRANTS !== '1') throw new ApiError(403, 'Debug tools are disabled')
    let cleared = 0
    for (const [id, player] of this.players.entries()) {
      if ((player.shieldUntil ?? 0) > 0) {
        player.shieldUntil = 0
        this.players.markDirty(id)
        cleared += 1
      }
    }
    return { cleared }
  }

  leaderboard(viewer: PlayerRecord): LeaderboardEntry[] {
    const now = Date.now()
    const sight = watchtowerSightOf(viewer.buildings)
    if (!this.leaderboardCache || this.leaderboardCache.expiresAt <= now) {
      const rows: LeaderboardSnapshotRow[] = []
      const compare = (a: LeaderboardSnapshotRow, b: LeaderboardSnapshotRow) =>
        b.trophies - a.trophies || b.buildingCount - a.buildingCount || a.username.localeCompare(b.username)
      // Keep only the best 100 while scanning. The legacy JSON runtime does
      // O(players * 100) bounded memory once per second, not a full allocation
      // and O(players log players) sort on every leaderboard request. The
      // PostgreSQL runtime uses its indexed LIMIT query.
      for (const player of this.players.values()) {
        const row: LeaderboardSnapshotRow = {
          id: player.id,
          username: player.username,
          trophies: player.trophies,
          buildingCount: player.buildings.length,
          lastSeen: player.lastSeen,
          plotX: player.plotX ?? 0,
          plotY: player.plotY ?? 0
        }
        const index = rows.findIndex(existing => compare(row, existing) < 0)
        if (index < 0) {
          if (rows.length < 100) rows.push(row)
        } else {
          rows.splice(index, 0, row)
          if (rows.length > 100) rows.pop()
        }
      }
      this.leaderboardCache = { expiresAt: now + 1_000, rows }
    }
    return this.leaderboardCache.rows.map(row => ({
      ...row,
      online: row.id === viewer.id || now - row.lastSeen < ONLINE_WINDOW_MS,
      inScoutRange: row.id === viewer.id
        || chebyshevDistance(viewer.plotX ?? 0, viewer.plotY ?? 0, row.plotX, row.plotY) <= sight
    }))
  }

  /**
   * The world atlas: EVERY settled player plot in the world — the map-menu's
   * data. Coarse public facts only (name, plot, trophies, shield, battle),
   * no layouts; sight gates what you can SEE up close, not who exists.
   * One main server for now: the chart frame is the ±WORLD_PLOT_RADIUS
   * square, grown to include any legacy outlier plot beyond it.
   */
  atlas(viewer: PlayerRecord): { me: { x: number; y: number }; sight: number; worldPlotLimit: number; players: Array<{ x: number; y: number; username: string; trophies: number; shielded: boolean; underAttack: boolean; me: boolean; online: boolean }>; battles: Array<{ ax: number; ay: number; vx: number; vy: number }>; window: { minX: number; maxX: number; minY: number; maxY: number }; truncated: boolean } {
    const now = Date.now()
    const meX = viewer.plotX ?? 0
    const meY = viewer.plotY ?? 0
    // The watchtower's own default-sight radius (0-2 plots) — the atlas
    // marks this ring so a chief can see it against the wider chart window.
    const sight = watchtowerSightOf(viewer.buildings)
    // Walk the plot index directly: O(settled players), independent of the
    // coordinate space, and it can never miss a far-flung village.
    const candidates: PlayerRecord[] = []
    for (const id of new Set(this.plotIndex.values())) {
      const player = this.players.get(id)
      if (player) candidates.push(player)
    }
    // Nearest-first so the 1,000-player cap (if it ever binds) drops the
    // farthest chiefs, not arbitrary ones.
    candidates.sort((a, b) => chebyshevDistance(a.plotX ?? 0, a.plotY ?? 0, meX, meY) - chebyshevDistance(b.plotX ?? 0, b.plotY ?? 0, meX, meY))
    const visible = candidates.slice(0, ATLAS_PLAYER_LIMIT)
    const visibleIds = new Set(visible.map(player => player.id))
    const players = []
    for (const player of visible) {
      this.expireStaleAttacks(player.id)
      players.push({
        x: player.plotX ?? 0,
        y: player.plotY ?? 0,
        username: player.username,
        trophies: player.trophies,
        shielded: (player.shieldUntil ?? 0) > now,
        underAttack: (this.liveByVictim.get(player.id)?.size ?? 0) > 0,
        me: player.id === viewer.id,
        online: player.id === viewer.id || now - player.lastSeen < ONLINE_WINDOW_MS
      })
    }
    const battles: Array<{ ax: number; ay: number; vx: number; vy: number }> = []
    for (const victimId of visibleIds) {
      const set = this.liveByVictim.get(victimId)
      if (!set) continue
      for (const attackId of set) {
        const replay = this.replays.get(attackId)
        if (!replay || replay.status !== 'live') continue
        const att = this.players.get(replay.attackerId)
        const vic = this.players.get(replay.victimId)
        if (!att || !vic || !visibleIds.has(att.id) || !visibleIds.has(vic.id)) continue
        battles.push({ ax: att.plotX ?? 0, ay: att.plotY ?? 0, vx: vic.plotX ?? 0, vy: vic.plotY ?? 0 })
      }
    }
    // The world square, grown to cover any outlier so nobody charts off-map.
    let minX = -WORLD_PLOT_RADIUS
    let maxX = WORLD_PLOT_RADIUS
    let minY = -WORLD_PLOT_RADIUS
    let maxY = WORLD_PLOT_RADIUS
    for (const player of visible) {
      minX = Math.min(minX, player.plotX ?? 0)
      maxX = Math.max(maxX, player.plotX ?? 0)
      minY = Math.min(minY, player.plotY ?? 0)
      maxY = Math.max(maxY, player.plotY ?? 0)
    }
    return {
      me: { x: meX, y: meY },
      sight,
      worldPlotLimit: WORLD_PLOT_RADIUS,
      players,
      battles,
      window: { minX, maxX, minY, maxY },
      truncated: candidates.length > visible.length
    }
  }

  // ---- attacks & replays ----

  private trackLive(replay: AttackRecord) {
    const existing = this.liveByAttacker.get(replay.attackerId)
    if (existing && existing !== replay.attackId) {
      // Corrupt/pre-hardening data may contain multiple live raids for one
      // attacker. Keep the oldest tracked record; retire the duplicate.
      replay.status = 'aborted'
      replay.updatedAt = Date.now()
      replay.endedAt = replay.updatedAt
      this.replays.markDirty(replay.attackId)
      return
    }
    // Selecting an army/deployment edge is private preparation, not an
    // exclusive lock on the defender. The victim lock starts only once a
    // server-validated root troop enters an accepted frame.
    if (Object.keys(replay.validatedDeployments ?? {}).length > 0 && !this.lockVictim(replay)) {
      replay.status = 'aborted'
      replay.updatedAt = Date.now()
      replay.endedAt = replay.updatedAt
      this.replays.markDirty(replay.attackId)
      return
    }
    this.liveByAttacker.set(replay.attackerId, replay.attackId)
  }

  private victimIsLockedBy(replay: AttackRecord): boolean {
    return this.liveByVictim.get(replay.victimId)?.has(replay.attackId) ?? false
  }

  private lockVictim(replay: AttackRecord): boolean {
    let set = this.liveByVictim.get(replay.victimId)
    if (!set) {
      set = new Set()
      this.liveByVictim.set(replay.victimId, set)
    }
    for (const attackId of [...set]) {
      const other = this.replays.get(attackId)
      if (!other || other.status !== 'live') set.delete(attackId)
      else if (attackId !== replay.attackId) return false
    }
    set.add(replay.attackId)
    return true
  }

  private pruneRevengeRights(player: PlayerRecord, now = Date.now()): Record<string, RevengeRight> {
    const source = player.revengeRights ?? {}
    const kept: Array<[string, RevengeRight]> = []
    for (const [opponentId, raw] of Object.entries(source)) {
      const legacyCount = typeof raw === 'number'
        ? raw
        : raw?.count ?? (Number.isFinite(Number(raw?.grantedAt)) ? 1 : 0)
      const count = clamp(toInt(legacyCount, 0), 0, MAX_REVENGE_RIGHTS)
      const importedGrant = typeof raw === 'number' ? Number.NaN : Number(raw?.grantedAt)
      const expiresAt = typeof raw === 'number'
        ? now + REVENGE_RIGHT_TTL_MS
        : Number.isFinite(Number(raw?.expiresAt))
          ? Number(raw?.expiresAt)
          : importedGrant + REVENGE_RIGHT_TTL_MS
      if (!sanitizeId(opponentId) || count <= 0 || !Number.isFinite(expiresAt) || expiresAt <= now) continue
      kept.push([opponentId, { count, expiresAt }])
    }
    kept.sort((a, b) => b[1].expiresAt - a[1].expiresAt || a[0].localeCompare(b[0]))
    const rights = Object.fromEntries(kept.slice(0, MAX_REVENGE_OPPONENTS)) as Record<string, RevengeRight>
    if (JSON.stringify(source) !== JSON.stringify(rights)) {
      player.revengeRights = rights
      this.players.markDirty(player.id)
    }
    return rights
  }

  private grantRevengeRight(player: PlayerRecord, opponentId: string, earnedAt: number): void {
    const now = Date.now()
    const expiresAt = earnedAt + REVENGE_RIGHT_TTL_MS
    if (expiresAt <= now) return
    const rights = this.pruneRevengeRights(player, now)
    const current = rights[opponentId]
    rights[opponentId] = {
      count: Math.min(MAX_REVENGE_RIGHTS, (current?.count ?? 0) + 1),
      expiresAt: Math.max(current?.expiresAt ?? 0, expiresAt)
    }
    player.revengeRights = rights
    // Re-run the bounded sort after insertion so a flood of attackers cannot
    // grow the persisted map forever.
    this.pruneRevengeRights(player, now)
  }

  private applyAttackStartEffects(replay: AttackRecord, attacker: PlayerRecord): boolean {
    const effects = replay.startEffects
    if (!effects || replay.startEffectsApplied) return true
    // Pending deployment selection is non-exclusive and may lose the race or
    // become stale. Consume shield/revenge state only after a real root troop
    // has acquired the defender lock.
    if (Object.keys(replay.validatedDeployments ?? {}).length === 0 || !this.victimIsLockedBy(replay)) return true
    const applied = attacker.attackStarts ?? (attacker.attackStarts = {})
    if (!applied[replay.attackId]) {
      if (effects.revengeVictimId) {
        const rights = this.pruneRevengeRights(attacker)
        const right = rights[effects.revengeVictimId]
        if (!right || right.count <= 1) delete rights[effects.revengeVictimId]
        else right.count -= 1
        attacker.revengeRights = rights
      }
      if (effects.dropShield) attacker.shieldUntil = 0
      applied[replay.attackId] = replay.startedAt
      const old = Object.entries(applied).sort((a, b) => b[1] - a[1])
      for (const [oldAttackId] of old.slice(1_000)) {
        const oldReplay = this.replays.get(oldAttackId)
        if (oldReplay?.status === 'live' && !oldReplay.startEffectsApplied) continue
        delete applied[oldAttackId]
      }
    }
    // The marker may already exist only in memory after a previous synchronous
    // write failed. Re-mark and flush on every retry before committing the
    // replay flag, otherwise a retry could make the replay durable while the
    // shield/revenge mutation is still absent from disk.
    this.players.markDirty(attacker.id)
    if (!this.players.flushOne(attacker.id)) return false
    const replayBytes = replay.byteSize ?? exactReplayBytes(replay)
    replay.startEffectsApplied = true
    replay.byteSize = exactReplayBytes(replay)
    this.replayBytesTotal = Math.max(0, this.replayBytesTotal + replay.byteSize - replayBytes)
    this.replays.markDirty(replay.attackId)
    return this.replays.flushOne(replay.attackId)
  }

  private untrackLive(replay: AttackRecord) {
    const set = this.liveByVictim.get(replay.victimId)
    if (set) {
      set.delete(replay.attackId)
      if (set.size === 0) this.liveByVictim.delete(replay.victimId)
    }
    if (this.liveByAttacker.get(replay.attackerId) === replay.attackId) {
      this.liveByAttacker.delete(replay.attackerId)
    }
  }

  private deleteReplay(attackId: string) {
    const replay = this.replays.get(attackId)
    if (replay) {
      this.replayBytesTotal = Math.max(0, this.replayBytesTotal - (replay.byteSize ?? serializedBytes(replay)))
      const notifications = this.notifications.get(replay.victimId)
      const item = notifications?.items.find(
        (entry): entry is AttackNotificationItem => isAttackNotification(entry) && entry.attackId === attackId
      )
      if (item?.replayAvailable) {
        item.replayAvailable = false
        this.notifications.markDirty(replay.victimId)
      }
    }
    this.replays.delete(attackId)
  }

  private pruneGlobalReplayStorage(requiredBytes = 0): boolean {
    if (this.replayBytesTotal + requiredBytes <= MAX_TOTAL_REPLAY_BYTES) return true
    const finished = [...this.replays.values()]
      .filter(replay => replay.status !== 'live' && !this.settlements.get(replay.attackId))
      .sort((a, b) => (a.endedAt ?? a.updatedAt) - (b.endedAt ?? b.updatedAt))
    for (const replay of finished) {
      this.deleteReplay(replay.attackId)
      if (this.replayBytesTotal + requiredBytes <= MAX_TOTAL_REPLAY_BYTES) return true
    }
    return this.replayBytesTotal + requiredBytes <= MAX_TOTAL_REPLAY_BYTES
  }

  private activeAttackFor(attackerId: string): AttackRecord | undefined {
    const attackId = this.liveByAttacker.get(attackerId)
    if (!attackId) return undefined
    const replay = this.replays.get(attackId)
    if (!replay || replay.status !== 'live') {
      this.liveByAttacker.delete(attackerId)
      return undefined
    }
    this.expireStaleAttack(replay)
    const refreshed = this.replays.get(attackId)
    return refreshed?.status === 'live' ? refreshed : undefined
  }

  private activeBotRaidFor(attackerId: string): BotRaidRecord | undefined {
    const raidId = this.liveBotByAttacker.get(attackerId)
    if (!raidId) return undefined
    const raid = this.botRaidSessions.get(raidId)
    if (!raid || raid.status !== 'live') {
      this.liveBotByAttacker.delete(attackerId)
      return undefined
    }
    if (raid.expiresAt <= Date.now()) {
      const player = this.players.get(attackerId)
      if (player) this.expireBotRaid(raid, player, Date.now())
      else {
        raid.status = 'aborted'
        this.liveBotByAttacker.delete(attackerId)
        this.botRaidSessions.markDirty(raidId)
        this.noteFinishedBotRaid(raid)
        this.pruneFinishedBotRaids()
      }
      return undefined
    }
    return raid
  }

  /**
   * Recoverability contract for reloads/storage loss. The token fingerprint
   * lets the client auto-close only a session opened by this same device;
   * another device is reported but left alone until an explicit takeover.
   */
  activeOutgoingBattle(player: PlayerRecord, rawToken: unknown): {
    session: null | {
      kind: 'pvp'
      attackId: string
      startedAt: number
      updatedAt: number
      hasDeployments: boolean
      ownedByCurrentSession: boolean
    } | {
      kind: 'bot'
      raidId: string
      x: number
      y: number
      startedAt: number
      expiresAt: number
      ownedByCurrentSession: boolean
    }
  } {
    const tokenHash = typeof rawToken === 'string' && rawToken ? hashToken(rawToken) : ''
    const attack = this.activeAttackFor(player.id)
    if (attack) {
      return {
        session: {
          kind: 'pvp',
          attackId: attack.attackId,
          startedAt: attack.startedAt,
          updatedAt: attack.updatedAt,
          hasDeployments: Object.keys(attack.validatedDeployments ?? {}).length > 0,
          ownedByCurrentSession: Boolean(tokenHash && attack.ownerTokenHash === tokenHash)
        }
      }
    }
    const raid = this.activeBotRaidFor(player.id)
    if (raid) {
      return {
        session: {
          kind: 'bot',
          raidId: raid.raidId,
          x: raid.x,
          y: raid.y,
          startedAt: raid.startedAt,
          expiresAt: raid.expiresAt,
          ownedByCurrentSession: Boolean(tokenHash && raid.ownerTokenHash === tokenHash)
        }
      }
    }
    return { session: null }
  }

  /** Explicit account-level takeover, invoked only by a user starting a new raid. */
  abortActiveOutgoingBattle(player: PlayerRecord): { aborted: boolean; kind?: 'pvp' | 'bot'; world: SerializedWorld } {
    const attack = this.activeAttackFor(player.id)
    if (attack) {
      this.finishAttack(attack, { destruction: 0, goldLooted: 0, status: 'aborted' })
      return { aborted: true, kind: 'pvp', world: this.worldOf(player) }
    }
    const raid = this.activeBotRaidFor(player.id)
    if (raid) {
      this.botSettle(player, {
        raidId: raid.raidId,
        x: raid.x,
        y: raid.y,
        destruction: 0,
        deployed: {},
        requestId: `takeover_${raid.raidId}`
      })
      return { aborted: true, kind: 'bot', world: this.worldOf(player) }
    }
    return { aborted: false, world: this.worldOf(player) }
  }

  private noteFinishedBotRaid(raid: BotRaidRecord) {
    if ((raid.status !== 'finished' && raid.status !== 'aborted') || this.finishedBotRaidIds.has(raid.raidId)) return
    this.finishedBotRaidIds.add(raid.raidId)
    this.finishedBotRaids.push({ raidId: raid.raidId, startedAt: raid.startedAt })
  }

  private pruneFinishedBotRaids(rebuild = false) {
    // Loading legacy JSON is the one allowed O(total raids) pass. Request
    // paths append terminal ids directly and sort at most the retained bound.
    if (rebuild) {
      this.finishedBotRaids.length = 0
      this.finishedBotRaidIds.clear()
      for (const raid of this.botRaidSessions.values()) this.noteFinishedBotRaid(raid)
    }
    this.finishedBotRaids.sort((a, b) => b.startedAt - a.startedAt || a.raidId.localeCompare(b.raidId))
    while (this.finishedBotRaids.length > MAX_FINISHED_BOT_RAIDS) {
      const expired = this.finishedBotRaids.pop()
      if (!expired) break
      this.finishedBotRaidIds.delete(expired.raidId)
      this.botRaidSessions.delete(expired.raidId)
    }
  }

  private applyPreparedBotSettlement(raid: BotRaidRecord, player: PlayerRecord) {
    const prepared = raid.preparedSettlement
    if (!prepared) throw new ApiError(500, 'Bot settlement journal is incomplete')
    const bot = this.persistedBotVillageAt(raid.x, raid.y, raid.seed)
    // Upgrade an old settling journal before touching the newly durable bot.
    if (!Number.isSafeInteger(prepared.botRevisionBefore)
      || !Number.isSafeInteger(prepared.botRevisionAfter)
      || !Number.isFinite(prepared.botGoldAfter)) {
      prepared.lootApplied = Math.min(prepared.lootApplied, Math.floor(Math.max(0, bot.world.resources.gold)))
      prepared.botRevisionBefore = bot.revision
      prepared.botRevisionAfter = bot.revision + (prepared.lootApplied > 0 ? 1 : 0)
      prepared.botGoldAfter = Math.max(0, bot.world.resources.gold - prepared.lootApplied)
      this.botRaidSessions.markDirty(raid.raidId)
      if (!this.botRaidSessions.flushOne(raid.raidId)) {
        throw new ApiError(503, 'Could not upgrade bot settlement journal')
      }
    }
    if (bot.revision === prepared.botRevisionBefore && prepared.botRevisionAfter > prepared.botRevisionBefore) {
      bot.world.resources.gold = prepared.botGoldAfter
      bot.revision = prepared.botRevisionAfter
      bot.updatedAt = prepared.settledAt
      bot.world.revision = bot.revision
      bot.world.lastSaveTime = prepared.settledAt
      this.botVillages.markDirty(bot.id)
      if (!this.botVillages.flushOne(bot.id)) {
        throw new ApiError(503, 'Could not persist bot village settlement')
      }
    } else if (bot.revision !== prepared.botRevisionAfter
      || Math.floor(bot.world.resources.gold) !== Math.floor(prepared.botGoldAfter)) {
      throw new ApiError(409, 'Persisted bot village changed during settlement')
    }
    const marched = Object.values(prepared.deployed).some(count => count > 0)
    const applied = player.botSettlements ?? (player.botSettlements = {})
    if (!applied[raid.raidId]) {
      for (const [type, count] of Object.entries(prepared.deployed)) {
        const next = Math.max(0, (player.army[type] ?? 0) - count)
        if (next === 0) delete player.army[type]
        else player.army[type] = next
      }
      this.accrue(player, prepared.settledAt)
      player.balance = clamp(player.balance + prepared.lootApplied, 0, MAX_BALANCE)
      if (marched) {
        this.pruneBotRaidCooldowns(player, prepared.settledAt)[plotKey(raid.x, raid.y)] = prepared.settledAt
        this.pruneBotRaidCooldowns(player, prepared.settledAt)
      }
      if (marched || prepared.lootApplied > 0) {
        player.revision += 1
        player.lastMutationAt = prepared.settledAt
      }
      applied[raid.raidId] = prepared.settledAt
      const old = Object.entries(applied).sort((a, b) => b[1] - a[1])
      for (const [oldRaidId] of old.slice(1_000)) {
        if (this.botRaidSessions.get(oldRaidId)?.status === 'settling') continue
        delete applied[oldRaidId]
      }
      this.players.markDirty(player.id)
      if (prepared.lootApplied > 0) this.book('loot', 'gold', prepared.lootApplied)
      if (marched) this.bookCount('botRaids')
    }
    const response = {
      lootApplied: prepared.lootApplied,
      attackerBalance: Math.floor(player.balance),
      army: { ...player.army },
      revision: player.revision
    }
    if (!this.players.flushOne(player.id)) return response
    if (raid.authority?.phase === 'FINALIZING' && raid.authority.finalization) {
      const finalization = raid.authority.finalization
      if (prepared.resultHash && prepared.resultHash !== finalization.result.resultHash) {
        throw new ApiError(500, 'Bot settlement journal result does not match its combat aggregate')
      }
      try {
        raid.authority = settleAttack(raid.authority, {
          expectedPhase: raid.authority.phase,
          expectedVersion: raid.authority.version
        }, {
          settlementId: finalization.settlement.settlementId,
          transactionId: `botsettle_${raid.raidId}`,
          resultHash: finalization.result.resultHash,
          committedAt: Math.max(prepared.settledAt, raid.authority.timestamps.finalizedAt ?? 0),
          applied: {
            loot: { gold: prepared.lootApplied, ore: 0, food: 0 },
            trophyDelta: 0,
            consumedArmy: sanitizeArmy(prepared.deployed) as TroopCounts
          }
        })
      } catch (error) {
        this.attackDomainError(error)
      }
    }
    raid.status = marched ? 'finished' : 'aborted'
    raid.finalResult = response
    this.noteFinishedBotRaid(raid)
    this.pruneFinishedBotRaids()
    this.botRaidSessions.markDirty(raid.raidId)
    this.botRaidSessions.flush()
    return response
  }

  private recoverBotSettlements() {
    for (const raid of this.botRaidSessions.values()) {
      if (raid.status !== 'settling' || !raid.preparedSettlement) continue
      const player = this.players.get(raid.attackerId)
      if (player) this.applyPreparedBotSettlement(raid, player)
    }
  }

  private deploymentCounts(replay: AttackRecord): Record<string, number> {
    const counts = Object.create(null) as Record<string, number>
    for (const type of Object.values(replay.validatedDeployments ?? {})) {
      if (hasOwn(TROOP_DEFINITIONS, type) && !GENERATED_ONLY.has(type)) counts[type] = (counts[type] ?? 0) + 1
    }
    return counts
  }

  private destructibleTargets(world: SerializedWorld) {
    return world.buildings.flatMap(building => {
      if (building.type === 'wall') return []
      const def = hasOwn(BUILDING_DEFINITIONS, building.type) ? BUILDING_DEFINITIONS[building.type as BuildingType] : undefined
      if (!def) return []
      const level = clamp(toInt(building.level, 1), 1, def.maxLevel ?? 1)
      return [{
        id: building.id,
        hp: Math.max(1, def.levels?.[level - 1]?.hp ?? def.maxHealth),
        x: building.gridX + def.width / 2,
        y: building.gridY + def.height / 2
      }]
    })
  }

  /**
   * Safe maximum number of scoring buildings one area hit can touch. Mortar
   * shells are centered on a building and use their exact radius. Golem and
   * wall-breaker centers are mobile, so the 2r neighborhood around any hit
   * target is a cheap mathematical upper bound for every target in that hit.
   */
  private splashTargetCeiling(world: SerializedWorld, radius: number, centeredOnBuilding: boolean): number {
    const targets = this.destructibleTargets(world)
    if (targets.length === 0) return 0
    const centers = centeredOnBuilding
      ? world.buildings.flatMap(building => {
          const def = hasOwn(BUILDING_DEFINITIONS, building.type) ? BUILDING_DEFINITIONS[building.type as BuildingType] : undefined
          return def ? [{ x: building.gridX + def.width / 2, y: building.gridY + def.height / 2 }] : []
        })
      : targets
    const reach = centeredOnBuilding ? radius : radius * 2
    let max = 1
    for (const center of centers) {
      let count = 0
      for (const target of targets) {
        if (Math.hypot(target.x - center.x, target.y - center.y) <= reach) count += 1
      }
      max = Math.max(max, count)
    }
    return Math.min(targets.length, max)
  }

  private attackCountCeiling(type: TroopType, level: number, activeMs: number): number {
    const stats = getTroopStats(type, level)
    const elapsed = clamp(activeMs, 0, MAX_COMBAT_CREDIT_MS)
    const firstDelay = Math.max(0, stats.firstAttackDelay ?? 0)
      + Math.max(0, stats.detonationDelayMs ?? 0)
    if (elapsed < firstDelay) return 0
    // Most troops may strike on their first client combat tick. Suicide
    // detonators (wall breaker, clockwork beetle) can do so only once; every
    // other troop follows its cadence.
    if (stats.detonateOnAttack) return 1
    const delay = Math.max(150, stats.attackDelay ?? 1000)
    return 1 + Math.floor((elapsed - firstDelay) / delay)
  }

  /** Worst-case honest building damage from one trained root troop. */
  private rootDamageCeiling(world: SerializedWorld, type: TroopType, level: number, activeMs: number): number {
    if (GENERATED_ONLY.has(type) || !hasOwn(TROOP_DEFINITIONS, type)) return 0
    const stats = getTroopStats(type, level)
    const attacks = this.attackCountCeiling(type, level, activeMs)
    if (attacks <= 0) return 0

    if (type === 'phalanx') {
      const soldier = getTroopStats('romanwarrior', level)
      const soldierAttacks = this.attackCountCeiling('romanwarrior', level, activeMs)
      // A formation can fight, die, and release all nine level-matched soldiers.
      return stats.damage * attacks + 9 * soldier.damage * soldierAttacks
    }

    if (stats.summonType && (stats.summonCount ?? 0) > 0 && hasOwn(TROOP_DEFINITIONS, stats.summonType)) {
      // A summoner (necromancer) can keep its full alive-cap of summons
      // fighting beside it for its whole window (phalanx-pattern generosity).
      const summon = getTroopStats(stats.summonType, level)
      const summonAttacks = this.attackCountCeiling(stats.summonType, level, activeMs)
      const summonPeak = Math.max(stats.summonCount ?? 1, stats.summonCap ?? 1)
      return stats.damage * attacks + summonPeak * summon.damage * summonAttacks
    }

    let perVolley = stats.damage
    if (type === 'golem' || type === 'icegolem') {
      // The two slam golems predate the declarative splash field and retain
      // their authored full-damage, radius-three ceiling.
      perVolley *= this.splashTargetCeiling(world, 3, false)
    } else if ((stats.chainCount ?? 0) > 0) {
      // Chain damage is a declarative kit, not a Storm Mage identity check.
      // Keep the legacy validator's intentionally-generous interpretation of
      // chainCount as extra hops so already-open attacks cannot be clipped.
      const targets = this.destructibleTargets(world).length
      const extraChains = Math.min(Math.max(0, stats.chainCount ?? 0), Math.max(0, targets - 1))
      let chainMultiplier = 1
      for (let hop = 1; hop <= extraChains; hop++) chainMultiplier += 0.8 ** hop
      perVolley *= chainMultiplier
    } else if ((stats.splashRadius ?? 0) > 0) {
      // Every declarative splash kit gets the same full-primary / 60%-nearby
      // ceiling as the local adapter. Detonators can burst from any contact
      // point; ordinary attacks center their hit on a struck building.
      const hits = this.splashTargetCeiling(world, stats.splashRadius ?? 0, !stats.detonateOnAttack)
      perVolley *= 1 + Math.max(0, hits - 1) * 0.6
    }
    if ((stats.resourceDamageMultiplier ?? 1) > 1) {
      // Resource raider (goblin plunderer): worst honest case lands every
      // strike on a resource building at the full multiplier. Keep this
      // independent of area-kit credit for future declarative combinations.
      perVolley *= stats.resourceDamageMultiplier ?? 1
    }
    // Pure supports (physician's cart and siege tower) declare damage 0, so
    // their own ceiling contribution is intentionally zero.
    return perVolley * attacks
  }

  /** Convert a generous raw-damage budget to a building-count percentage. */
  private destructionCeilingFromDamage(world: SerializedWorld, damage: number): number {
    const targets = this.destructibleTargets(world)
    if (targets.length === 0 || !Number.isFinite(damage) || damage <= 0) return 0
    const cheapest = targets.map(target => target.hp).sort((a, b) => a - b)
    let spent = 0
    let count = 0
    for (const hp of cheapest) {
      if (spent + hp > damage + 1e-6) break
      spent += hp
      count += 1
    }
    return clamp(Math.round(count / targets.length * 100), 0, 100)
  }

  private observedDestroyedIds(replay: AttackRecord, frame?: ReplayFrame): Set<string> {
    if (!replay.enemyWorld) return new Set()
    const targetIds = new Set(this.destructibleTargets(replay.enemyWorld).map(target => target.id))
    const destroyed = new Set((replay.destroyedBuildingIds ?? []).filter(id => targetIds.has(id)))
    // Migration path for live records created before the monotonic ledger.
    if (!replay.destroyedBuildingIds) {
      for (const accepted of replay.frames) {
        for (const state of accepted.buildings) {
          if (targetIds.has(state.id) && state.isDestroyed && state.health <= 0) destroyed.add(state.id)
        }
      }
    }
    if (frame) {
      for (const state of frame.buildings) {
        if (targetIds.has(state.id) && state.isDestroyed && state.health <= 0) destroyed.add(state.id)
      }
    }
    return destroyed
  }

  private authoritativeDestruction(replay: AttackRecord, frame?: ReplayFrame, observed = this.observedDestroyedIds(replay, frame)): number {
    if (!replay.enemyWorld) return 0
    const targets = this.destructibleTargets(replay.enemyWorld)
    if (targets.length === 0) return 0
    const claimed = Math.round(observed.size / targets.length * 100)
    return Math.min(claimed, this.timedCombatPowerCeiling(replay))
  }

  private timedCombatPowerCeiling(replay: AttackRecord, now = Date.now()): number {
    if (!replay.enemyWorld) return 0
    const level = normalizeTroopLevel(replay.troopLevel ?? 1)
    let damage = 0
    for (const [id, rawType] of Object.entries(replay.validatedDeployments ?? {})) {
      const type = rawType as TroopType
      const deployedAt = replay.deploymentTimes?.[id] ?? now
      const contribution = this.rootDamageCeiling(replay.enemyWorld, type, level, now - deployedAt + DEPLOYMENT_RECEIPT_ALLOWANCE_MS)
      if (Number.isFinite(contribution) && contribution > 0) damage += contribution
    }
    return this.destructionCeilingFromDamage(replay.enemyWorld, damage)
  }

  /**
   * Abort live attacks the attacker has clearly abandoned. Two windows:
   * an attack that never started streaming frames (attacker still picking troops)
   * gets a long grace period; one that was streaming and went silent is treated
   * as a crashed tab. Either way, nothing may stay live past the hard cap.
   */
  private expireStaleAttack(replay: AttackRecord, now = Date.now()): boolean {
    if (replay.status !== 'live') return false
    const silentMs = now - replay.updatedAt
    const staleWindow = Object.keys(replay.validatedDeployments ?? {}).length > 0 ? LIVE_ATTACK_STALE_MS : PENDING_ATTACK_STALE_MS
    const expired = silentMs > staleWindow || now - replay.startedAt > MAX_ATTACK_DURATION_MS
    if (!expired) return false
    this.finishAttack(replay, { destruction: 0, goldLooted: 0, status: 'aborted' })
    return true
  }

  private expireAllStaleAttacks(now = Date.now()) {
    for (const replay of [...this.replays.values()]) {
      if (replay.status === 'live') this.expireStaleAttack(replay, now)
    }
  }

  private expireStaleAttacks(victimId: string) {
    const set = this.liveByVictim.get(victimId)
    if (!set) return
    const now = Date.now()
    for (const attackId of [...set]) {
      const replay = this.replays.get(attackId)
      if (!replay) {
        set.delete(attackId)
        continue
      }
      if (replay.status !== 'live') {
        set.delete(attackId)
        continue
      }
      this.expireStaleAttack(replay, now)
    }
  }

  private hasLiveIncomingAttack(playerId: string): boolean {
    this.expireStaleAttacks(playerId)
    return (this.liveByVictim.get(playerId)?.size ?? 0) > 0
  }

  private assertBaseEconomyUnlocked(player: PlayerRecord) {
    if (this.hasLiveIncomingAttack(player.id)) {
      throw new ApiError(409, 'Village resources and layout are locked while an incoming raid is live', 'BASE_UNDER_ATTACK')
    }
  }

  /**
   * Begin an attack. The server snapshots the defender's base and fixes the
   * loot cap here, so the client never supplies the enemy world and the loot
   * can never exceed what the defender actually had.
   */
  private retryAttackStart(attacker: PlayerRecord, requestId: string): StartedAttackResponse | undefined {
    if (!requestId) return undefined
    const attackId = this.startRequestIndex.get('pvp-start', attacker.id, requestId)
    if (!attackId) return undefined
    const candidate = this.replays.get(attackId)
    if (candidate?.status === 'live') this.expireStaleAttack(candidate)
    const existing = this.replays.get(attackId)
    if (!existing || existing.status !== 'live' || !existing.enemyWorld) {
      throw new ApiError(409, 'That attack start request is no longer live')
    }
    if (!this.applyAttackStartEffects(existing, attacker)) throw new ApiError(503, 'Could not persist attack start')
    return {
      attackId: existing.attackId,
      world: existing.enemyWorld,
      lootCap: existing.lootCap,
      lootCapOre: existing.lootCapOre ?? 0,
      lootCapFood: existing.lootCapFood ?? 0,
      target: {
        worldId: 'main',
        x: existing.victimPlotX ?? 0,
        y: existing.victimPlotY ?? 0,
        plotVersion: existing.victimPlotVersion ?? 1
      }
    }
  }

  startAttack(attacker: PlayerRecord, body: { targetId?: unknown; requestId?: unknown }, matchmade = false, rawToken?: unknown): StartedAttackResponse {
    const requestId = this.normalizeKey(body?.requestId)
    const retry = this.retryAttackStart(attacker, requestId)
    if (retry) return retry
    const targetId = sanitizeId(body?.targetId)
    const victim = this.players.get(targetId)
    if (!victim) throw new ApiError(404, 'Target player not found')
    if (victim.id === attacker.id) throw new ApiError(400, 'Cannot attack yourself')

    const existingAttack = this.activeAttackFor(attacker.id)
    if (existingAttack) throw new ApiError(409, 'Finish or abort your active attack first')
    if (this.activeBotRaidFor(attacker.id)) throw new ApiError(409, 'Finish or retreat from your bot raid first')

    const now = Date.now()
    const sight = watchtowerSightOf(attacker.buildings)
    const targetDistance = chebyshevDistance(attacker.plotX ?? 0, attacker.plotY ?? 0, victim.plotX ?? 0, victim.plotY ?? 0)
    const revengeRight = this.pruneRevengeRights(attacker, now)[victim.id]
    const revengeRightCount = revengeRight?.count ?? 0
    const inSight = targetDistance <= sight
    if (!matchmade && !inSight && revengeRightCount <= 0) {
      throw new ApiError(403, 'That village is beyond your watchtower sight')
    }

    this.expireStaleAttacks(victim.id)
    if ((this.liveByVictim.get(victim.id)?.size ?? 0) > 0) {
      throw new ApiError(409, 'That base is already under attack')
    }

    // Shields: a freshly raided base is protected — unless the attacker holds
    // a revenge right against this player, which pierces the shield once.
    const victimShielded = (victim.shieldUntil ?? 0) > now
    if (victimShielded && revengeRightCount <= 0) throw new ApiError(403, 'That village is under a shield')
    if (armySpaceUsed(attacker.army) <= 0) throw new ApiError(409, 'Train troops before starting an attack')
    // An explicit attack spends an outstanding revenge right even when the
    // target happens to be nearby and unshielded; otherwise rights accumulate
    // forever through ordinary rematches.
    const useRevengeRight = !matchmade && revengeRightCount > 0
    // Accrue privately, then hand the attacker only combat geometry. Exact
    // balances, population, storage and the defender's army are not scouting
    // data; fixed loot caps below are all combat settlement needs.
    this.accrue(victim)
    this.accruePopulation(victim)
    // Mirrors the client's LootSystem: a fixed share of every stock is
    // raidable; storehouses shield part of the ore/food (never the gold).
    const protection = storehouseProtection(victim.buildings)
    const lootCap = Math.floor(victim.balance * RAIDABLE_SHARE)
    const lootCapOre = Math.floor(victim.ore * RAIDABLE_SHARE * (1 - protection))
    const lootCapFood = Math.floor(victim.food * RAIDABLE_SHARE * (1 - protection))
    const postcard = publicWorldOf(victim)
    const enemyWorld: SerializedWorld = {
      ...postcard,
      // These are already-safe maximum raid shares, not the defender's
      // private stocks. They let battle visuals show what can be won.
      resources: { gold: lootCap, ore: lootCapOre, food: lootCapFood }
    }
    const attackId = `atk_${randomHex(9)}`
    const troopLevel = troopLevelOf(attacker.buildings)
    const reservedArmy = sanitizeArmy(attacker.army) as TroopCounts
    const snapshot: CombatVillageSnapshot = {
      schemaVersion: 1,
      snapshotId: `snap_${attackId}`,
      villageVersion: `appearance_${appearanceRevisionOf(victim)}`,
      buildings: victim.buildings.map(building => ({
        id: building.id,
        type: building.type,
        level: building.level,
        gridX: building.gridX,
        gridY: building.gridY
      }))
    }
    const snapshotHash = combatSnapshotHash(snapshot)
    let authority: AttackAggregate
    try {
      authority = prepareAttack({
        attackId,
        attackerId: attacker.id,
        attackerName: attacker.username,
        selectionSource: matchmade ? 'MATCHMADE' : useRevengeRight ? 'REVENGE' : 'NEIGHBOR',
        target: {
          kind: 'PLAYER',
          targetId: victim.id,
          playerId: victim.id,
          shieldBypass: useRevengeRight ? 'REVENGE' : 'NONE',
          ...(useRevengeRight && revengeRight ? { shieldBypassExpiresAt: revengeRight.expiresAt } : {}),
          plot: {
            worldId: 'main',
            x: victim.plotX ?? 0,
            y: victim.plotY ?? 0,
            version: String(victim.plotVersion ?? 1)
          },
          villageVersion: snapshot.villageVersion,
          snapshotId: snapshot.snapshotId,
          snapshotHash
        },
        snapshot,
        simulationSeed: randomHex(16),
        rewardPolicy: {
          lootCaps: { gold: lootCap, ore: lootCapOre, food: lootCapFood },
          winTrophyBase: 15,
          winTrophyPerFivePercent: 1,
          lossTrophyDelta: -12
        },
        requestedArmy: reservedArmy,
        troopLevel,
        now
      }, {
        reserveArmy: request => ({
          reservationId: `reserve_${attackId}`,
          sourceArmyVersion: attacker.revision,
          reserved: { ...request.requested },
          troopLevel: request.troopLevel
        })
      })
    } catch (error) {
      if (error instanceof AttackDomainError) throw new ApiError(409, error.message, error.code, error.details)
      throw error
    }
    const replay: AttackRecord = {
      attackId,
      attackerId: attacker.id,
      attackerName: attacker.username,
      victimId: victim.id,
      victimName: victim.username,
      status: 'live',
      startedAt: now,
      updatedAt: now,
      enemyWorld,
      lootCap,
      lootCapOre,
      lootCapFood,
      reservedArmy,
      validatedDeployments: Object.create(null) as Record<string, string>,
      deploymentTimes: Object.create(null) as Record<string, number>,
      troopLevel,
      destroyedBuildingIds: [],
      victimPlotX: victim.plotX ?? 0,
      victimPlotY: victim.plotY ?? 0,
      victimPlotVersion: victim.plotVersion ?? 1,
      // Selection changes only how the target is found. Every issued attack
      // authorizes the same target-centered, in-world battle presentation.
      mapFocusAuthorized: true,
      authority,
      ...(requestId ? { startRequestId: requestId } : {}),
      ...(typeof rawToken === 'string' && rawToken ? { ownerTokenHash: hashToken(rawToken) } : {}),
      startEffects: {
        dropShield: (attacker.shieldUntil ?? 0) > now,
        ...(useRevengeRight ? { revengeVictimId: victim.id } : {})
      },
      startEffectsApplied: false,
      frames: []
    }
    replay.byteSize = exactReplayBytes(replay)
    if (replay.byteSize > MAX_REPLAY_BYTES || !this.pruneGlobalReplayStorage(replay.byteSize)) {
      throw new ApiError(503, 'Replay storage is temporarily full')
    }
    this.replays.set(replay.attackId, replay)
    this.replayBytesTotal += replay.byteSize
    this.trackLive(replay)
    if (!this.replays.flush()) {
      this.untrackLive(replay)
      this.deleteReplay(replay.attackId)
      throw new ApiError(503, 'Could not persist attack session')
    }
    if (requestId) this.startRequestIndex.set('pvp-start', attacker.id, requestId, replay.attackId, now)
    if (!this.applyAttackStartEffects(replay, attacker)) throw new ApiError(503, 'Could not persist attack start')
    return {
      attackId: replay.attackId,
      world: enemyWorld,
      lootCap: replay.lootCap,
      lootCapOre,
      lootCapFood,
      target: {
        worldId: 'main',
        x: victim.plotX ?? 0,
        y: victim.plotY ?? 0,
        plotVersion: victim.plotVersion ?? 1
      }
    }
  }

  /**
   * Random matchmaking: pick another player's base that isn't already under
   * attack. Eligibility keeps only the principled exclusions — self, bases
   * without a town hall, defenders with a live attack lease, and shielded
   * villages (starter + post-raid shields both protect a base from raids).
   */
  matchmake(attacker: PlayerRecord, body: MatchmakeRequest = {}, rawToken?: unknown): StartedAttackResponse {
    const requestId = this.normalizeKey(body?.requestId)
    const excludeTargetId = body.excludeTargetId === undefined
      ? undefined
      : strictSafeId(body.excludeTargetId, 'excludeTargetId')
    const excludedTargetIds = parseMatchmakeExclusions(body.excludeTargetIds)
    const retry = this.retryAttackStart(attacker, requestId)
    if (retry) return retry
    const candidates: PlayerRecord[] = []
    // Probe a bounded slice of the dense directory. This makes selection cost
    // independent of total account count while still scanning every account
    // in small/test worlds.
    for (const playerId of this.playerDirectory.probe({ exclude: attacker.id, limit: 2_048 })) {
      const player = this.players.get(playerId)
      if (!player) continue
      if (!player.buildings.some(b => b.type === 'town_hall')) continue
      this.expireStaleAttacks(player.id)
      if ((this.liveByVictim.get(player.id)?.size ?? 0) > 0) continue
      if ((player.shieldUntil ?? 0) > Date.now()) continue
      candidates.push(player)
    }
    if (candidates.length === 0) throw new ApiError(404, 'No opponents available', 'NO_OPPONENTS')
    // Strict NEXT-cycling exclusions: a base already offered this session is
    // never offered again. An exhausted pool is a distinct signal so the
    // client can transition to bot camps.
    const remaining = excludedTargetIds.size > 0
      ? candidates.filter(candidate => !excludedTargetIds.has(candidate.id))
      : candidates
    if (remaining.length === 0) {
      throw new ApiError(404, 'Every eligible player village has already been offered', 'MATCH_POOL_EXHAUSTED')
    }
    // Soft exclusion is a repeat-avoidance preference, not a way to make a
    // one-opponent world unplayable. Reuse the sole candidate when needed.
    const alternatives = excludeTargetId
      ? remaining.filter(candidate => candidate.id !== excludeTargetId)
      : remaining
    const selectionPool = alternatives.length > 0 ? alternatives : remaining
    const victim = selectionPool[Math.floor(Math.random() * selectionPool.length)]
    return this.startAttack(attacker, { targetId: victim.id, requestId }, true, rawToken)
  }

  private getReplayFor(player: PlayerRecord, attackId: unknown, allowLiveSpectator = false): AttackRecord {
    const id = sanitizeId(attackId)
    let replay = this.replays.get(id)
    if (!replay) throw new ApiError(404, 'Replay not found')
    if (replay.status === 'live') {
      this.expireStaleAttack(replay)
      replay = this.replays.get(id)
      if (!replay) throw new ApiError(404, 'Replay not found')
    }
    if (replay.attackerId !== player.id && replay.victimId !== player.id) {
      const victim = this.players.get(replay.victimId)
      const sight = watchtowerSightOf(player.buildings)
      const visible = victim && chebyshevDistance(player.plotX ?? 0, player.plotY ?? 0, victim.plotX ?? 0, victim.plotY ?? 0) <= sight
      if (!allowLiveSpectator || replay.status !== 'live' || !visible) {
        throw new ApiError(403, 'Not authorized to watch this attack')
      }
    }
    return replay
  }

  private attackDomainError(error: unknown): never {
    if (!(error instanceof AttackDomainError)) throw error
    const forbidden = error.code === 'TARGET_SHIELDED'
    const badRequest = error.code === 'INVALID_INPUT'
      || error.code === 'COMMAND_SEQUENCE_GAP'
      || error.code === 'COMMAND_SEQUENCE_REPLAY'
      || error.code === 'COMMAND_ID_REUSED'
    throw new ApiError(forbidden ? 403 : badRequest ? 400 : 409, error.message, error.code, error.details)
  }

  /**
   * Apply one compact combat intent to the persisted attack aggregate. Frames
   * remain presentation/replay data; only these commands can alter the result.
   */
  private applyAuthorityCommand(replay: AttackRecord, attacker: PlayerRecord, command: AttackCommand, now = Date.now()) {
    let authority = replay.authority
    if (!authority) throw new ApiError(409, 'This legacy attack must be restarted', 'ATTACK_INVALIDATED')
    let acquiredVictimLock = false
    let commandApplied = false
    try {
      if (command.type === 'SURRENDER' && (authority.phase === 'PREPARING' || authority.phase === 'ENGAGED')) {
        authority = cancelAttack(authority, {
          expectedPhase: authority.phase,
          expectedVersion: authority.version
        }, now, 'attacker surrendered before combat')
        replay.authority = authority
        return { commandId: command.commandId, sequence: command.sequence, phase: authority.phase, version: authority.version, duplicate: false }
      }

      if (command.type === 'DEPLOY' && authority.phase === 'PREPARING') {
        const victim = this.players.get(replay.victimId)
        if (victim) this.advancePlayer(victim, now)
        const plotCurrent = Boolean(victim
          && (victim.plotX ?? 0) === (replay.victimPlotX ?? 0)
          && (victim.plotY ?? 0) === (replay.victimPlotY ?? 0)
          && (victim.plotVersion ?? 1) === (replay.victimPlotVersion ?? 1))
        const villageCurrent = Boolean(victim && replay.enemyWorld
          && sameCombatLayout(replay.enemyWorld.buildings, victim.buildings)
          && authority.target.villageVersion === `appearance_${appearanceRevisionOf(victim)}`)
        const shieldBypassed = authority.target.kind === 'PLAYER'
          && authority.target.shieldBypass === 'REVENGE'
          && (authority.target.shieldBypassExpiresAt ?? 0) > now
        const shieldAllowsEntry = Boolean(victim && ((victim.shieldUntil ?? 0) <= now || shieldBypassed))
        acquiredVictimLock = Boolean(plotCurrent && villageCurrent && shieldAllowsEntry && this.lockVictim(replay))
        // A changed or shielded target still exists. Report its current state
        // so the domain returns MOVED/VERSION/SHIELDED instead of hiding every
        // failed validation behind a generic unavailable response. A current,
        // unshielded target without a lease means another raid won the race.
        const targetCanBeObserved = Boolean(victim
          && (!plotCurrent || !villageCurrent || !shieldAllowsEntry || acquiredVictimLock))
        authority = engageAttack(authority, {
          expectedPhase: authority.phase,
          expectedVersion: authority.version
        }, now, {
          validateAndLockTarget: () => ({
            available: targetCanBeObserved,
            targetId: replay.victimId,
            plot: {
              worldId: 'main',
              x: victim?.plotX ?? replay.victimPlotX ?? 0,
              y: victim?.plotY ?? replay.victimPlotY ?? 0,
              version: String(victim?.plotVersion ?? replay.victimPlotVersion ?? 1)
            },
            villageVersion: victim ? `appearance_${appearanceRevisionOf(victim)}` : 'missing',
            shieldUntil: victim?.shieldUntil ?? 0,
            observedAt: now,
            ...(acquiredVictimLock ? {
              engagementLease: {
                leaseId: `lease_${replay.attackId}`,
                acquiredAt: now,
                expiresAt: now + MAX_ATTACK_DURATION_MS
              }
            } : {})
          })
        })
      }

      const applied = applyAttackCommand(authority, {
        expectedPhase: authority.phase,
        expectedVersion: authority.version
      }, command, now)
      replay.authority = applied.attack
      commandApplied = true
      if (command.type === 'DEPLOY') {
        const validated = replay.validatedDeployments ?? (replay.validatedDeployments = Object.create(null) as Record<string, string>)
        const deploymentTimes = replay.deploymentTimes ?? (replay.deploymentTimes = Object.create(null) as Record<string, number>)
        validated[command.troopInstanceId] = command.troopType
        deploymentTimes[command.troopInstanceId] ??= now
        // A shield earned after selection is still dropped at the real engage
        // transition; preparation never captures authority over future state.
        replay.startEffects = {
          ...(replay.startEffects ?? { dropShield: false }),
          dropShield: (attacker.shieldUntil ?? 0) > now
        }
        if (!this.applyAttackStartEffects(replay, attacker)) {
          throw new ApiError(503, 'Could not persist attack engagement')
        }
      }
      replay.updatedAt = now
      const previousBytes = replay.byteSize ?? exactReplayBytes(replay)
      replay.byteSize = exactReplayBytes(replay)
      this.replayBytesTotal = Math.max(0, this.replayBytesTotal + replay.byteSize - previousBytes)
      this.replays.markDirty(replay.attackId)
      return {
        ...applied.receipt,
        version: applied.attack.version,
        duplicate: applied.duplicate
      }
    } catch (error) {
      // Target locking is the only mutation performed before command
      // validation. Roll it back when that command never became authoritative.
      if (acquiredVictimLock && !commandApplied) {
        const set = this.liveByVictim.get(replay.victimId)
        set?.delete(replay.attackId)
        if (set?.size === 0) this.liveByVictim.delete(replay.victimId)
      }
      this.attackDomainError(error)
    }
  }

  pushCommands(attacker: PlayerRecord, body: { attackId?: unknown; raidId?: unknown; commands?: unknown }) {
    const commands = Array.isArray(body?.commands) ? body.commands : []
    const explicitRaidId = sanitizeId(body?.raidId)
    const candidateRaidId = explicitRaidId || sanitizeId(body?.attackId)
    const botRaid = candidateRaidId ? this.botRaidSessions.get(candidateRaidId) : undefined
    if (explicitRaidId || botRaid) {
      if (!botRaid) throw new ApiError(404, 'Bot raid session not found')
      return this.pushBotCommands(attacker, botRaid, commands)
    }
    const replay = this.getReplayFor(attacker, body?.attackId)
    if (replay.attackerId !== attacker.id) throw new ApiError(403, 'Only the attacker can publish commands')
    if (replay.status !== 'live') throw new ApiError(409, 'That attack is no longer active', 'ATTACK_INVALIDATED')
    // One idempotent command per durable request prevents a later invalid
    // item from partially applying an otherwise successful batch.
    if (commands.length !== 1) throw new ApiError(400, 'Exactly one combat command is required')
    const receipts = [this.applyAuthorityCommand(replay, attacker, commands[0] as AttackCommand)]
    return {
      attackId: replay.attackId,
      phase: replay.authority?.phase ?? 'EXPIRED',
      version: replay.authority?.version ?? 0,
      lastCommandSequence: replay.authority?.lastCommandSequence ?? 0,
      receipts
    }
  }

  pushFrames(attacker: PlayerRecord, body: { attackId?: unknown; frames?: unknown }): { frameCount: number } {
    const replay = this.getReplayFor(attacker, body?.attackId)
    if (replay.attackerId !== attacker.id) throw new ApiError(403, 'Only the attacker can publish frames')
    if (replay.status !== 'live') {
      throw new ApiError(409, 'That attack was already closed by another session', 'ATTACK_INVALIDATED')
    }

    const incoming = Array.isArray(body?.frames) ? body.frames.slice(0, MAX_FRAMES_PER_PUSH) : []
    const enemyById = new Map((replay.enemyWorld?.buildings ?? []).map(building => [building.id, building]))
    const preNormalizationBytes = replay.byteSize ?? exactReplayBytes(replay)
    const validated = Object.assign(Object.create(null) as Record<string, string>, replay.validatedDeployments ?? {})
    const deploymentTimes = Object.assign(Object.create(null) as Record<string, number>, replay.deploymentTimes ?? {})
    const reserved = sanitizeArmy(replay.reservedArmy ?? attacker.army)
    replay.validatedDeployments = validated
    replay.deploymentTimes = deploymentTimes
    replay.reservedArmy = reserved
    replay.byteSize = exactReplayBytes(replay)
    this.replayBytesTotal = Math.max(0, this.replayBytesTotal + replay.byteSize - preNormalizationBytes)
    const deployedCounts = this.deploymentCounts(replay)
    let accepted = 0
    let leaseEvidence = false
    const rollbackDeployments = (ids: string[]) => {
      for (const id of ids) {
        if (replay.authority?.events.some(event => event.type === 'TROOP_DEPLOYED' && event.troopInstanceId === id)) continue
        const type = hasOwn(validated, id) ? validated[id] : undefined
        delete validated[id]
        delete deploymentTimes[id]
        if (type) deployedCounts[type] = Math.max(0, (deployedCounts[type] ?? 1) - 1)
      }
    }
    for (const raw of incoming) {
      const frame = sanitizeFrame(raw)
      if (!frame) continue
      const newDeploymentIds: string[] = []
      // The stream flows forward only: watchers interpolate on frame time,
      // so an out-of-order frame would make troops walk backwards.
      const lastT = replay.frames.length > 0 ? replay.frames[replay.frames.length - 1].t : -1
      if (frame.t <= lastT) continue
      if (frame.t > Date.now() - replay.startedAt + MAX_FRAME_CLOCK_LEAD_MS) continue

      const seenBuildings = new Set<string>()
      frame.buildings = frame.buildings.flatMap(state => {
        const building = enemyById.get(state.id)
        if (!building || seenBuildings.has(state.id)) return []
        seenBuildings.add(state.id)
        const def = hasOwn(BUILDING_DEFINITIONS, building.type) ? BUILDING_DEFINITIONS[building.type as BuildingType] : undefined
        const level = def ? clamp(toInt(building.level, 1), 1, def.maxLevel ?? 1) : 1
        const maxHealth = def ? (def.levels?.[level - 1]?.hp ?? def.maxHealth) : state.health
        const health = clamp(state.health, 0, Math.max(0, maxHealth))
        return [{ ...state, health, isDestroyed: state.isDestroyed && health === 0 }]
      })

      const metadataBefore = serializedBytes({
        validatedDeployments: validated,
        deploymentTimes,
        destroyedBuildingIds: replay.destroyedBuildingIds ?? []
      })
      const seenTroops = new Set<string>()
      frame.troops = frame.troops.filter(troop => {
        if (seenTroops.has(troop.id)) return false
        seenTroops.add(troop.id)
        if (troop.owner !== 'PLAYER') return true
        if (GENERATED_ONLY.has(troop.type)) {
          // Generated-only presentation rows are valid only when the trained
          // root that can create them was deployed in this attack.
          if (!generatedTroopHasRootDeployment(troop.type, deployedCounts)) return false
          troop.level = normalizeTroopLevel(replay.troopLevel ?? 1)
          return true
        }
        if (!hasOwn(TROOP_DEFINITIONS, troop.type)) return false
        const priorType = hasOwn(validated, troop.id) ? validated[troop.id] : undefined
        if (priorType) {
          troop.level = normalizeTroopLevel(replay.troopLevel ?? 1)
          return priorType === troop.type
        }
        const used = deployedCounts[troop.type] ?? 0
        const reservedCount = hasOwn(reserved, troop.type) ? reserved[troop.type] : 0
        if (used >= reservedCount) return false
        // Production authority accepts deployments only through the compact
        // command endpoint. The opt-in bridge exists solely for legacy data
        // migration and the old HTTP compatibility regression suite.
        if (!ALLOW_LEGACY_FRAME_COMMANDS || GENERATED_ONLY.has(troop.type)) return false
        this.applyAuthorityCommand(replay, attacker, {
          type: 'DEPLOY',
          commandId: `legacy_${troop.id}`,
          sequence: (replay.authority?.lastCommandSequence ?? 0) + 1,
          troopInstanceId: troop.id,
          troopType: troop.type as ReservableTroopType,
          gridX: troop.gridX,
          gridY: troop.gridY
        })
        if (validated[troop.id] !== troop.type) return false
        newDeploymentIds.push(troop.id)
        deployedCounts[troop.type] = used + 1
        troop.level = normalizeTroopLevel(replay.troopLevel ?? 1)
        return true
      })

      const priorDestroyedCount = replay.destroyedBuildingIds?.length ?? 0
      const observedDestroyed = this.observedDestroyedIds(replay, frame)
      frame.destruction = this.authoritativeDestruction(replay, frame, observedDestroyed)
      frame.goldLooted = Math.floor(replay.lootCap * frame.destruction / 100)
      frame.oreLooted = Math.floor((replay.lootCapOre ?? 0) * frame.destruction / 100)
      frame.foodLooted = Math.floor((replay.lootCapFood ?? 0) * frame.destruction / 100)
      const frameBytes = serializedBytes(frame)
      const replayBytes = replay.byteSize ?? exactReplayBytes(replay)
      const nextDestroyedIds = [...observedDestroyed]
      const metadataAfter = serializedBytes({
        validatedDeployments: validated,
        deploymentTimes,
        destroyedBuildingIds: nextDestroyedIds
      })
      let projectedBytes = replayBytes + frameBytes + (replay.frames.length > 0 ? 1 : 0) + metadataAfter - metadataBefore
      const dropIndices: number[] = []
      const dropOrder = replay.frames.length > 1
        ? [...Array.from({ length: replay.frames.length - 1 }, (_, index) => index + 1), 0]
        : replay.frames.length === 1 ? [0] : []
      while ((replay.frames.length + 1 - dropIndices.length > MAX_REPLAY_FRAMES || projectedBytes > MAX_REPLAY_BYTES)
        && dropIndices.length < dropOrder.length) {
        const index = dropOrder[dropIndices.length]
        dropIndices.push(index)
        // The incoming frame guarantees the resulting array remains non-empty,
        // so removing any stored frame also removes exactly one comma.
        projectedBytes -= serializedBytes(replay.frames[index]) + 1
      }
      if (projectedBytes > MAX_REPLAY_BYTES || replay.frames.length + 1 - dropIndices.length > MAX_REPLAY_FRAMES
        || !this.pruneGlobalReplayStorage(Math.max(0, projectedBytes - replayBytes))) {
        rollbackDeployments(newDeploymentIds)
        break
      }

      const hasRootDeployment = Object.keys(validated).length > 0
      if (hasRootDeployment && !this.victimIsLockedBy(replay)) {
        const victim = this.players.get(replay.victimId)
        if (victim) {
          this.accrue(victim)
          this.accruePopulation(victim)
        }
        const snapshotStillCurrent = Boolean(
          victim && replay.enemyWorld &&
          sameCombatLayout(replay.enemyWorld.buildings, victim.buildings) &&
          (victim.plotX ?? 0) === (replay.victimPlotX ?? victim.plotX ?? 0) &&
          (victim.plotY ?? 0) === (replay.victimPlotY ?? victim.plotY ?? 0) &&
          (victim.plotVersion ?? 1) === (replay.victimPlotVersion ?? victim.plotVersion ?? 1)
        )
        const displayedLootStillAvailable = Boolean(
          victim
          && Math.floor(victim.balance) >= replay.lootCap
          && victim.ore >= (replay.lootCapOre ?? 0)
          && victim.food >= (replay.lootCapFood ?? 0)
        )
        const shieldStillAllowsEntry = Boolean(
          victim && ((victim.shieldUntil ?? 0) <= Date.now() || replay.startEffects?.revengeVictimId === victim.id)
        )
        if (!snapshotStillCurrent || !displayedLootStillAvailable || !shieldStillAllowsEntry || !this.lockVictim(replay)) {
          rollbackDeployments(newDeploymentIds)
          this.untrackLive(replay)
          this.deleteReplay(replay.attackId)
          throw new ApiError(409, 'That village changed or another army reached it first; start a fresh attack', 'ATTACK_INVALIDATED')
        }
      }

      const metadataBytes = exactReplayBytes(replay)
      replay.byteSize = metadataBytes
      this.replayBytesTotal = Math.max(0, this.replayBytesTotal + metadataBytes - replayBytes)
      if (hasRootDeployment && !this.applyAttackStartEffects(replay, attacker)) {
        throw new ApiError(503, 'Could not persist attack deployment')
      }
      const accountedAfterEffects = replay.byteSize ?? metadataBytes

      // Apply the precomputed thinning only after every authorization/lock
      // check succeeds. Opening and newest frames survive; deployment and
      // destroyed-building ledgers remain monotonic outside the frame array.
      for (const index of dropIndices.sort((a, b) => b - a)) replay.frames.splice(index, 1)
      replay.frames.push(frame)
      replay.destroyedBuildingIds = nextDestroyedIds
      let actualBytes = exactReplayBytes(replay)
      while (actualBytes > MAX_REPLAY_BYTES && replay.frames.length > 1) {
        replay.frames.splice(replay.frames.length > 2 ? 1 : 0, 1)
        actualBytes = exactReplayBytes(replay)
      }
      while (actualBytes > accountedAfterEffects && !this.pruneGlobalReplayStorage(actualBytes - accountedAfterEffects) && replay.frames.length > 1) {
        replay.frames.splice(replay.frames.length > 2 ? 1 : 0, 1)
        actualBytes = exactReplayBytes(replay)
      }
      replay.byteSize = actualBytes
      this.replayBytesTotal = Math.max(0, this.replayBytesTotal + actualBytes - accountedAfterEffects)
      accepted += 1
      const validPlayerTroop = frame.troops.some(troop =>
        troop.owner === 'PLAYER' && (
          hasOwn(validated, troop.id) ||
          generatedTroopHasRootDeployment(troop.type, deployedCounts)
        )
      )
      const damagedBuilding = frame.buildings.some(state => {
        const building = enemyById.get(state.id)
        const def = building && hasOwn(BUILDING_DEFINITIONS, building.type) ? BUILDING_DEFINITIONS[building.type as BuildingType] : undefined
        if (!building || !def) return false
        const level = clamp(toInt(building.level, 1), 1, def.maxLevel ?? 1)
        return state.health < (def.levels?.[level - 1]?.hp ?? def.maxHealth)
      })
      if (newDeploymentIds.length > 0 || validPlayerTroop || damagedBuilding || nextDestroyedIds.length > priorDestroyedCount) {
        leaseEvidence = true
      }
    }
    // Persist accepted replay data, but only genuine troop/building evidence
    // refreshes the live lease. Empty forward frames cannot hold a base open.
    if (accepted > 0) {
      const accountedBytes = replay.byteSize ?? exactReplayBytes(replay)
      if (leaseEvidence) replay.updatedAt = Date.now()
      let actualBytes = exactReplayBytes(replay)
      while (actualBytes > MAX_REPLAY_BYTES && replay.frames.length > 1) {
        replay.frames.splice(replay.frames.length > 2 ? 1 : 0, 1)
        actualBytes = exactReplayBytes(replay)
      }
      while (actualBytes > accountedBytes && !this.pruneGlobalReplayStorage(actualBytes - accountedBytes) && replay.frames.length > 1) {
        replay.frames.splice(replay.frames.length > 2 ? 1 : 0, 1)
        actualBytes = exactReplayBytes(replay)
      }
      replay.byteSize = actualBytes
      this.replayBytesTotal = Math.max(0, this.replayBytesTotal + actualBytes - accountedBytes)
      this.replays.markDirty(replay.attackId)
    }
    return { frameCount: replay.frames.length }
  }

  /** Idempotent battle resolution: loot moves once, trophies move once, the defender gets one notification. */
  endAttack(attacker: PlayerRecord, body: { attackId?: unknown; destruction?: unknown; goldLooted?: unknown; status?: unknown }): EndAttackResponse {
    const replay = this.getReplayFor(attacker, body?.attackId)
    if (replay.attackerId !== attacker.id) throw new ApiError(403, 'Only the attacker can end an attack')

    if (replay.status !== 'live') {
      this.accrue(attacker)
      return {
        lootApplied: replay.finalResult?.goldLooted ?? 0,
        oreApplied: replay.finalResult?.oreLooted ?? 0,
        foodApplied: replay.finalResult?.foodLooted ?? 0,
        attackerBalance: Math.floor(attacker.balance),
        attackerOre: attacker.ore,
        attackerFood: attacker.food,
        trophyDelta: replay.finalResult?.trophyDelta ?? 0,
        attackerTrophies: attacker.trophies,
        revision: attacker.revision,
        army: { ...attacker.army }
      }
    }

    return this.finishAttack(replay, {
      // Client counters are intentionally ignored. The final accepted frame,
      // immutable defender snapshot and reserved army determine the outcome.
      destruction: 0,
      goldLooted: 0,
      status: body?.status === 'aborted' ? 'aborted' : 'finished'
    })
  }

  private finishAttack(
    replay: AttackRecord,
    result: { destruction: number; goldLooted: number; oreLooted?: number; foodLooted?: number; status: 'finished' | 'aborted' }
  ): EndAttackResponse {
    const attacker = this.players.get(replay.attackerId)
    const victim = this.players.get(replay.victimId)
    const now = Date.now()
    const deployed = this.deploymentCounts(replay)
    const fought = Object.values(deployed).some(count => count > 0)
    if (!fought) {
      this.untrackLive(replay)
      this.deleteReplay(replay.attackId)
      return {
        lootApplied: 0,
        attackerBalance: attacker ? Math.floor(attacker.balance) : 0,
        trophyDelta: 0,
        attackerTrophies: attacker?.trophies ?? 0,
        revision: attacker?.revision,
        army: attacker ? { ...attacker.army } : undefined
      }
    }

    let deterministicResult = replay.authority?.finalization?.result
    if (replay.authority?.phase === 'ACTIVE') {
      try {
        replay.authority = finalizeAttack(replay.authority, {
          expectedPhase: replay.authority.phase,
          expectedVersion: replay.authority.version
        }, result.status === 'aborted' ? 'SURRENDER' : 'OBJECTIVE_COMPLETE', now)
        deterministicResult = replay.authority.finalization?.result
      } catch (error) {
        this.attackDomainError(error)
      }
    }
    // New attacks settle exclusively from the deterministic command log. The
    // old frame ceiling remains only for imported pre-migration replays.
    const destruction = deterministicResult?.destruction ?? this.authoritativeDestruction(replay)
    if (victim) this.accrue(victim, now)
    if (attacker) this.accrue(attacker, now)
    const requestedLoot = deterministicResult?.loot ?? {
      gold: Math.floor(replay.lootCap * destruction / 100),
      ore: Math.floor((replay.lootCapOre ?? 0) * destruction / 100),
      food: Math.floor((replay.lootCapFood ?? 0) * destruction / 100)
    }
    const attackerCaps = attacker ? resourceCapacity(attacker.buildings) : { ore: 0, food: 0 }
    const goldHeadroom = attacker ? Math.max(0, Math.floor(MAX_BALANCE - attacker.balance)) : 0
    const oreHeadroom = attacker ? Math.max(0, attackerCaps.ore - attacker.ore) : 0
    const foodHeadroom = attacker ? Math.max(0, attackerCaps.food - attacker.food) : 0
    const goldLooted = victim ? Math.min(requestedLoot.gold, Math.floor(victim.balance), goldHeadroom) : 0
    const oreLooted = victim ? Math.min(requestedLoot.ore, victim.ore, oreHeadroom) : 0
    const foodLooted = victim ? Math.min(requestedLoot.food, victim.food, foodHeadroom) : 0
    const requestedTrophyDelta = deterministicResult?.requestedTrophyDelta
      ?? (destruction >= 50 ? 15 + Math.round(destruction / 5) : -12)
    // Wins remain the game's rating bootstrap (new accounts and bots begin at
    // zero), but a loss can transfer only trophies the attacker actually owns.
    // This closes throwaway-alt minting while preserving the existing ladder.
    const trophyDelta = requestedTrophyDelta < 0
      ? -Math.min(-requestedTrophyDelta, attacker?.trophies ?? 0)
      : requestedTrophyDelta
    const finalFrame = replay.frames[replay.frames.length - 1]
    if (finalFrame) {
      finalFrame.destruction = destruction
      finalFrame.goldLooted = goldLooted
      finalFrame.oreLooted = oreLooted
      finalFrame.foodLooted = foodLooted
    }
    const replayBytesBeforeFinal = replay.byteSize ?? exactReplayBytes(replay)
    let finalizedReplayBytes = exactReplayBytes(replay)
    while (finalizedReplayBytes > MAX_REPLAY_BYTES && replay.frames.length > 1) {
      replay.frames.splice(replay.frames.length > 2 ? 1 : 0, 1)
      finalizedReplayBytes = exactReplayBytes(replay)
    }
    while (finalizedReplayBytes > replayBytesBeforeFinal
      && !this.pruneGlobalReplayStorage(finalizedReplayBytes - replayBytesBeforeFinal)
      && replay.frames.length > 1) {
      replay.frames.splice(replay.frames.length > 2 ? 1 : 0, 1)
      finalizedReplayBytes = exactReplayBytes(replay)
    }
    replay.byteSize = finalizedReplayBytes
    this.replayBytesTotal = Math.max(0, this.replayBytesTotal + replay.byteSize - replayBytesBeforeFinal)
    const settlement: SettlementRecord = {
      attackId: replay.attackId,
      state: 'prepared',
      status: result.status,
      endedAt: now,
      destruction,
      goldLooted,
      oreLooted,
      foodLooted,
      trophyDelta,
      deployed
    }

    // Write-ahead journal: if the process dies between the two player files,
    // startup replays this exact delta and participant request keys prevent a
    // side from receiving it twice.
    if (!this.replays.flush()) throw new ApiError(503, 'Could not persist battle replay')
    this.settlements.set(replay.attackId, settlement)
    if (!this.settlements.flush()) throw new ApiError(503, 'Could not prepare battle settlement')
    this.applySettlement(settlement, replay)
    const playersSaved = this.players.flush()
    const notificationsSaved = this.notifications.flush()
    const replaySaved = this.replays.flush()
    if (playersSaved && notificationsSaved && replaySaved) {
      settlement.state = 'committed'
      this.settlements.markDirty(replay.attackId)
      if (this.settlements.flush()) this.settlements.delete(replay.attackId)
    }

    this.book('loot', 'gold', goldLooted)
    this.book('loot', 'ore', oreLooted)
    this.book('loot', 'food', foodLooted)
    this.bookCount('battles')
    this.pruneReplays(replay.victimId)

    return {
      lootApplied: goldLooted,
      oreApplied: oreLooted,
      foodApplied: foodLooted,
      attackerBalance: attacker ? Math.floor(attacker.balance) : 0,
      attackerOre: attacker?.ore,
      attackerFood: attacker?.food,
      trophyDelta,
      attackerTrophies: attacker?.trophies ?? 0,
      revision: attacker?.revision,
      army: attacker ? { ...attacker.army } : undefined
    }
  }

  private applySettlement(settlement: SettlementRecord, replay: AttackRecord) {
    const attacker = this.players.get(replay.attackerId)
    const victim = this.players.get(replay.victimId)
    const victimKey = `settle:v:${replay.attackId}`
    const attackerKey = `settle:a:${replay.attackId}`
    const appliedFor = (player: PlayerRecord) => player.battleSettlements ?? (player.battleSettlements = {})
    const remember = (player: PlayerRecord, key: string) => {
      const applied = appliedFor(player)
      applied[key] = settlement.endedAt
      const old = Object.entries(applied).sort((a, b) => b[1] - a[1])
      for (const [oldKey] of old.slice(2_000)) {
        const attackId = oldKey.slice(oldKey.lastIndexOf(':') + 1)
        if (this.settlements.get(attackId)?.state === 'prepared') continue
        delete applied[oldKey]
      }
    }

    if (victim && !appliedFor(victim)[victimKey]) {
      this.accrue(victim, settlement.endedAt)
      victim.balance = clamp(victim.balance - settlement.goldLooted, 0, MAX_BALANCE)
      victim.ore = Math.max(0, victim.ore - settlement.oreLooted)
      victim.food = Math.max(0, victim.food - settlement.foodLooted)
      victim.trophies = Math.max(0, victim.trophies - settlement.trophyDelta)
      const shieldDuration = shieldForDestruction(settlement.destruction)
      if (shieldDuration > 0) {
        victim.shieldUntil = Math.max(victim.shieldUntil ?? 0, settlement.endedAt + shieldDuration)
      }
      this.grantRevengeRight(victim, replay.attackerId, settlement.endedAt)
      victim.revision += 1
      victim.lastMutationAt = settlement.endedAt
      remember(victim, victimKey)
      this.players.markDirty(victim.id)
    }
    if (victim) {
      // Notification persistence is independent from the player file. Always
      // re-assert it during recovery; notify() deduplicates by attack id.
      this.notify(victim.id, {
        id: replay.attackId,
        attackId: replay.attackId,
        attackerId: replay.attackerId,
        attackerName: replay.attackerName,
        goldLost: settlement.goldLooted,
        oreLost: settlement.oreLooted,
        foodLost: settlement.foodLooted,
        destruction: settlement.destruction,
        trophyDelta: -settlement.trophyDelta,
        time: settlement.endedAt,
        read: false,
        replayAvailable: true
      })
    }

    if (attacker && !appliedFor(attacker)[attackerKey]) {
      this.accrue(attacker, settlement.endedAt)
      attacker.balance = clamp(attacker.balance + settlement.goldLooted, 0, MAX_BALANCE)
      const caps = resourceCapacity(attacker.buildings)
      attacker.ore = storedResourceAfterDelta(
        attacker.ore, settlement.oreLooted, caps.ore, false, debugGrantsEnabled()
      )
      attacker.food = storedResourceAfterDelta(
        attacker.food, settlement.foodLooted, caps.food, false, debugGrantsEnabled()
      )
      this.discardCappedProduction(attacker, caps)
      attacker.trophies = Math.max(0, attacker.trophies + settlement.trophyDelta)
      for (const [type, count] of Object.entries(settlement.deployed)) {
        const remaining = Math.max(0, (attacker.army[type] ?? 0) - count)
        if (remaining === 0) delete attacker.army[type]
        else attacker.army[type] = remaining
      }
      attacker.revision += 1
      attacker.lastMutationAt = settlement.endedAt
      remember(attacker, attackerKey)
      this.players.markDirty(attacker.id)
    }

    this.untrackLive(replay)
    replay.status = settlement.status
    replay.updatedAt = settlement.endedAt
    replay.endedAt = settlement.endedAt
    replay.finalResult = {
      destruction: settlement.destruction,
      goldLooted: settlement.goldLooted,
      oreLooted: settlement.oreLooted,
      foodLooted: settlement.foodLooted,
      trophyDelta: settlement.trophyDelta
    }
    if (replay.authority?.phase === 'FINALIZING' && replay.authority.finalization) {
      try {
        replay.authority = settleAttack(replay.authority, {
          expectedPhase: replay.authority.phase,
          expectedVersion: replay.authority.version
        }, {
          settlementId: replay.authority.finalization.settlement.settlementId,
          transactionId: `tx_${replay.attackId}`,
          resultHash: replay.authority.finalization.result.resultHash,
          committedAt: settlement.endedAt,
          applied: {
            loot: {
              gold: settlement.goldLooted,
              ore: settlement.oreLooted,
              food: settlement.foodLooted
            },
            trophyDelta: settlement.trophyDelta,
            consumedArmy: { ...settlement.deployed } as TroopCounts
          }
        })
      } catch (error) {
        this.attackDomainError(error)
      }
    }
    const oldBytes = replay.byteSize ?? exactReplayBytes(replay)
    replay.byteSize = exactReplayBytes(replay)
    this.replayBytesTotal = Math.max(0, this.replayBytesTotal + replay.byteSize - oldBytes)
    this.replays.markDirty(replay.attackId)
  }

  private recoverSettlements() {
    for (const [attackId, settlement] of [...this.settlements.entries()]) {
      if (settlement.state === 'committed') {
        this.settlements.delete(attackId)
        continue
      }
      const replay = this.replays.get(attackId)
      if (!replay) continue
      this.applySettlement(settlement, replay)
      const playersSaved = this.players.flush()
      const notificationsSaved = this.notifications.flush()
      const replaySaved = this.replays.flush()
      if (playersSaved && notificationsSaved && replaySaved) {
        settlement.state = 'committed'
        this.settlements.markDirty(attackId)
        if (this.settlements.flush()) this.settlements.delete(attackId)
      }
    }
  }

  private pruneReplays(victimId: string) {
    const finished: AttackRecord[] = []
    for (const replay of this.replays.values()) {
      if (replay.victimId === victimId && replay.status !== 'live' && !this.settlements.get(replay.attackId)) finished.push(replay)
    }
    if (finished.length <= MAX_REPLAYS_PER_VICTIM) return
    finished.sort((a, b) => (b.endedAt ?? b.updatedAt) - (a.endedAt ?? a.updatedAt))
    for (const stale of finished.slice(MAX_REPLAYS_PER_VICTIM)) {
      this.deleteReplay(stale.attackId)
    }
  }

  incomingAttacks(player: PlayerRecord): IncomingAttack[] {
    this.expireStaleAttacks(player.id)
    const attackIds = this.liveByVictim.get(player.id)
    if (!attackIds) return []
    const sessions: IncomingAttack[] = []
    for (const attackId of attackIds) {
      const replay = this.replays.get(attackId)
      if (!replay || replay.status !== 'live') continue
      sessions.push({
        attackId: replay.attackId,
        attackerId: replay.attackerId,
        attackerName: replay.attackerName,
        victimId: replay.victimId,
        startedAt: replay.startedAt,
        updatedAt: replay.updatedAt
      })
    }
    sessions.sort((a, b) => b.updatedAt - a.updatedAt)
    return sessions
  }

  /**
   * Fetch a replay. One request returns everything needed to play it back
   * instantly. `afterT` narrows the frames for cheap live-spectate polling.
   */
  getReplay(player: PlayerRecord, attackId: unknown, afterT?: unknown): AttackRecord {
    const replay = this.getReplayFor(player, attackId, true)
    const {
      reservedArmy: _reserved,
      validatedDeployments: _deployments,
      deploymentTimes: _deploymentTimes,
      troopLevel: _troopLevel,
      destroyedBuildingIds: _destroyedIds,
      victimPlotX: _victimPlotX,
      victimPlotY: _victimPlotY,
      victimPlotVersion: _victimPlotVersion,
      mapFocusAuthorized: _mapFocus,
      authority: _authority,
      startRequestId: _startRequestId,
      ownerTokenHash: _ownerTokenHash,
      startEffects: _startEffects,
      startEffectsApplied: _startEffectsApplied,
      byteSize: _bytes,
      ...publicReplay
    } = replay
    void _reserved
    void _deployments
    void _deploymentTimes
    void _troopLevel
    void _destroyedIds
    void _victimPlotX
    void _victimPlotY
    void _victimPlotVersion
    void _mapFocus
    void _authority
    void _startRequestId
    void _ownerTokenHash
    void _startEffects
    void _startEffectsApplied
    void _bytes
    const participant = replay.attackerId === player.id || replay.victimId === player.id
    let visibleReplay = publicReplay
    if (!participant) {
      const {
        lootCap: _lootCap,
        lootCapOre: _lootCapOre,
        lootCapFood: _lootCapFood,
        enemyWorld,
        ...spectatorReplay
      } = publicReplay
      void _lootCap
      void _lootCapOre
      void _lootCapFood
      visibleReplay = {
        ...spectatorReplay,
        ...(enemyWorld ? { enemyWorld: { ...enemyWorld, resources: { gold: 0, ore: 0, food: 0 } } } : {})
      } as typeof publicReplay
    }
    const after = Number(afterT)
    if (!Number.isFinite(after)) return visibleReplay
    // Incremental spectate poll: the watcher already holds the enemy world
    // from its first full fetch — re-shipping the whole base (plus every
    // older frame) up to 3x a second was pure bandwidth rot.
    const { enemyWorld: _fullWorld, ...slim } = visibleReplay
    void _fullWorld
    return { ...slim, frames: replay.frames.filter(frame => frame.t > after) }
  }

  // ---- admin authority ----

  private adminPlayerSummaryOf(player: PlayerRecord, now = Date.now()): AdminPlayerSummary {
    const moderation = this.effectiveModeration(player.id, now)
    const hasPlot = Number.isInteger(player.plotX) && Number.isInteger(player.plotY)
    return {
      id: player.id,
      username: player.username,
      registered: Boolean(player.passwordHash),
      trophies: Math.max(0, toInt(player.trophies, 0)),
      shieldUntil: (player.shieldUntil ?? 0) > 0 ? player.shieldUntil! : null,
      createdAt: player.createdAt,
      lastSeenAt: player.lastSeen,
      online: player.lastSeen >= now - ONLINE_WINDOW_MS,
      access: moderation.state,
      accessUntil: moderation.until,
      world: hasPlot
        ? {
            worldId: LEGACY_WORLD_ID,
            x: player.plotX!,
            y: player.plotY!,
            plotVersion: Math.max(1, toInt(player.plotVersion, 1))
          }
        : null
    }
  }

  private adminActiveAttackCount(playerId: string): number {
    let count = 0
    for (const replay of this.replays.values()) {
      const state = adminAttackStateOf(replay.authority?.phase, replay.status)
      if (!['preparing', 'engaged', 'active', 'finalizing'].includes(state)) continue
      if (replay.attackerId === playerId || replay.victimId === playerId) count += 1
    }
    for (const raid of this.botRaidSessions.values()) {
      const fallback = raid.status === 'finished'
        ? 'finished'
        : raid.status === 'aborted'
          ? 'aborted'
          : 'live'
      const state = raid.status === 'settling'
        ? 'finalizing'
        : adminAttackStateOf(raid.authority?.phase, fallback)
      if (raid.attackerId === playerId && ['preparing', 'engaged', 'active', 'finalizing'].includes(state)) count += 1
    }
    return count
  }

  private appendAdminAudit(
    action: string,
    targetId: string | null,
    details: Record<string, unknown>,
    occurredAt = Date.now()
  ): string {
    const id = `admin_audit_${randomHex(10)}`
    this.adminAuditLog.set(id, {
      id,
      actor: 'admin',
      action,
      targetType: targetId === null ? 'system' : 'player',
      targetId,
      reason: typeof details.reason === 'string' ? details.reason : 'Administrative action',
      outcome: 'success',
      requestId: id,
      details: structuredClone(details),
      createdAt: occurredAt,
      occurredAt
    })
    if (this.adminAuditLog.size > MAX_ADMIN_AUDIT_RECORDS) {
      const stale = [...this.adminAuditLog.values()]
        .sort((left, right) => left.occurredAt - right.occurredAt || left.id.localeCompare(right.id))
        .slice(0, this.adminAuditLog.size - MAX_ADMIN_AUDIT_RECORDS)
      for (const entry of stale) this.adminAuditLog.delete(entry.id)
    }
    return id
  }

  adminOverview(): AdminOverview {
    const now = Date.now()
    let registered = 0
    let online = 0
    let playerVillages = 0
    let gold = 0
    let ore = 0
    let food = 0
    let trophies = 0
    let suspended = 0
    let banned = 0
    for (const player of this.players.values()) {
      if (player.passwordHash) registered += 1
      if (player.lastSeen >= now - ONLINE_WINDOW_MS) online += 1
      if (Number.isInteger(player.plotX) && Number.isInteger(player.plotY)) playerVillages += 1
      gold += Math.max(0, Math.floor(Number(player.balance) || 0))
      ore += Math.max(0, Math.floor(Number(player.ore) || 0))
      food += Math.max(0, Math.floor(Number(player.food) || 0))
      trophies += Math.max(0, Math.floor(Number(player.trophies) || 0))
      const access = this.effectiveModeration(player.id, now).state
      if (access === 'suspended') suspended += 1
      else if (access === 'banned') banned += 1
    }

    const states = { preparing: 0, engaged: 0, active: 0, finalizing: 0 }
    const countState = (state: AdminAttackSummary['state']) => {
      if (state === 'preparing' || state === 'engaged' || state === 'active' || state === 'finalizing') {
        states[state] += 1
      }
    }
    for (const replay of this.replays.values()) {
      countState(adminAttackStateOf(replay.authority?.phase, replay.status))
    }
    for (const raid of this.botRaidSessions.values()) {
      const fallback = raid.status === 'finished'
        ? 'finished'
        : raid.status === 'aborted'
          ? 'aborted'
          : 'live'
      countState(raid.status === 'settling'
        ? 'finalizing'
        : adminAttackStateOf(raid.authority?.phase, fallback))
    }

    const total = this.players.size
    return {
      generatedAt: now,
      players: { total, registered, guests: total - registered, online },
      villages: { playerVillages, botVillages: this.botVillages.size },
      attacks: {
        active: states.preparing + states.engaged + states.active + states.finalizing,
        preparing: states.preparing,
        engaged: states.engaged + states.active,
        finalizing: states.finalizing
      },
      economy: {
        gold,
        ore,
        food,
        averageTrophies: total > 0 ? trophies / total : 0
      },
      moderation: { suspended, banned },
      maintenance: this.currentAdminConfig().maintenanceEnabled
    }
  }

  adminPlayers(rawSearch?: unknown, rawLimit?: unknown): AdminPlayerSummary[] {
    const search = rawSearch === undefined || rawSearch === null ? '' : String(rawSearch).trim()
    if (search.length > 64) throw new ApiError(400, 'Player search may not exceed 64 characters', 'ADMIN_INVALID_INPUT')
    const limit = rawLimit === undefined
      ? 50
      : adminInteger(rawLimit, 'limit', 1, ADMIN_PLAYER_LIMIT)
    const normalized = search.toLocaleLowerCase('en-US')
    const now = Date.now()
    return [...this.players.values()]
      .filter(player => !normalized
        || player.id.toLocaleLowerCase('en-US').includes(normalized)
        || player.username.toLocaleLowerCase('en-US').includes(normalized))
      .sort((left, right) => right.lastSeen - left.lastSeen || left.id.localeCompare(right.id))
      .slice(0, limit)
      .map(player => this.adminPlayerSummaryOf(player, now))
  }

  adminPlayer(rawId: unknown): AdminPlayerDetail {
    const id = adminSafeId(rawId, 'player id')
    const player = this.players.get(id)
    if (!player) throw new ApiError(404, 'Player not found', 'ADMIN_PLAYER_NOT_FOUND')
    const now = Date.now()
    const moderation = this.effectiveModeration(id, now)
    const revision = Math.max(0, toInt(player.revision, 0))
    const previewPlayer = structuredClone(player)
    const previewAdvance = advanceVillage(previewPlayer, now, {
      maxBalance: MAX_BALANCE,
      populationLocked: (this.liveByVictim.get(id)?.size ?? 0) > 0,
      preserveOverCapacity: debugGrantsEnabled()
    })
    const previewRevisionDelta = appearanceRevisionDelta(previewAdvance)
    if (previewRevisionDelta > 0) {
      previewPlayer.appearanceRevision = appearanceRevisionOf(previewPlayer) + previewRevisionDelta
      if (previewAdvance.appearanceChanged) {
        previewPlayer.lastMutationAt = Math.max(
          previewPlayer.lastMutationAt,
          ...previewPlayer.buildings.map(building => building.builtAt ?? 0)
        )
      }
    }
    return {
      ...this.adminPlayerSummaryOf(player, now),
      resources: {
        gold: Math.max(0, Math.floor(Number(player.balance) || 0)),
        ore: Math.max(0, Math.floor(Number(player.ore) || 0)),
        food: Math.max(0, Math.floor(Number(player.food) || 0))
      },
      revisions: {
        profile: revision,
        economy: revision,
        layout: Math.max(0, toInt(player.layoutRevision, revision)),
        appearance: Math.max(0, toInt(player.appearanceRevision, revision))
      },
      buildingCount: player.buildings.length,
      obstacleCount: player.obstacles.length,
      army: { ...player.army },
      population: Math.max(0, toInt(player.population?.count, 0)),
      activeSessions: player.tokenHashes.length,
      activeAttacks: this.adminActiveAttackCount(id),
      moderationReason: moderation.reason,
      moderationUpdatedAt: moderation.updatedAt,
      village: {
        ...publicWorldOf(previewPlayer),
        stoneMaturity: this.stoneMaturityOf(previewPlayer)
      }
    }
  }

  adminBots(
    rawCenter: { worldId?: unknown; x?: unknown; y?: unknown } = {},
    rawRadius?: unknown,
    rawLimit?: unknown
  ): AdminBotSummary[] {
    const worldId = rawCenter.worldId === undefined
      ? LEGACY_WORLD_ID
      : adminRequiredText(rawCenter.worldId, 'world id', 64)
    if (!/^[a-zA-Z0-9_-]+$/.test(worldId)) throw new ApiError(400, 'World id is invalid', 'ADMIN_INVALID_INPUT')
    const x = rawCenter.x === undefined
      ? 0
      : adminInteger(rawCenter.x, 'center x', -MAX_WORLD_COORDINATE, MAX_WORLD_COORDINATE)
    const y = rawCenter.y === undefined
      ? 0
      : adminInteger(rawCenter.y, 'center y', -MAX_WORLD_COORDINATE, MAX_WORLD_COORDINATE)
    const radius = rawRadius === undefined
      ? 25
      : adminInteger(rawRadius, 'radius', 0, ADMIN_BOT_RADIUS)
    const limit = rawLimit === undefined
      ? 100
      : adminInteger(rawLimit, 'limit', 1, ADMIN_BOT_LIMIT)
    return [...this.botVillages.values()]
      .filter(bot => bot.worldId === worldId
        && bot.x >= x - radius && bot.x <= x + radius
        && bot.y >= y - radius && bot.y <= y + radius)
      .sort((left, right) => left.y - right.y || left.x - right.x || left.id.localeCompare(right.id))
      .slice(0, limit)
      .map(bot => ({
        id: bot.id,
        username: bot.username,
        worldId: bot.worldId,
        x: bot.x,
        y: bot.y,
        plotVersion: bot.plotVersion,
        generatorVersion: bot.generatorVersion,
        seed: bot.seed,
        difficulty: typeof bot.profile?.difficulty === 'string' ? bot.profile.difficulty : null,
        trophies: bot.trophies,
        revision: bot.revision,
        resources: {
          gold: Number(bot.world.resources?.gold ?? 0),
          ore: Number(bot.world.resources?.ore ?? 0),
          food: Number(bot.world.resources?.food ?? 0)
        },
        buildingCount: bot.world.buildings.length,
        createdAt: bot.createdAt,
        updatedAt: bot.updatedAt
      }))
  }

  private adminReplaySummary(replay: AttackRecord): AdminAttackSummary {
    const authority = replay.authority
    const target = authority?.target
    const state = adminAttackStateOf(authority?.phase, replay.status)
    return {
      id: replay.attackId,
      attackerId: replay.attackerId,
      defenderId: target?.kind === 'PLAYER' ? target.playerId : replay.victimId,
      targetKind: target ? target.kind.toLowerCase() as AdminAttackSummary['targetKind'] : 'player',
      targetId: target?.targetId ?? replay.victimId,
      worldId: target?.plot.worldId ?? LEGACY_WORLD_ID,
      targetX: target?.plot.x ?? replay.victimPlotX ?? 0,
      targetY: target?.plot.y ?? replay.victimPlotY ?? 0,
      state,
      stateVersion: authority?.version ?? 0,
      simulationVersion: authority?.rules.simulationVersion ?? ATTACK_SIMULATION_VERSION,
      createdAt: authority?.timestamps.createdAt ?? replay.startedAt,
      engagedAt: authority?.timestamps.engagedAt ?? null,
      updatedAt: replay.updatedAt,
      deadlineAt: authority?.timestamps.expiresAt ?? replay.startedAt + MAX_ATTACK_DURATION_MS,
      endedAt: replay.endedAt ?? null
    }
  }

  private adminBotRaidSummary(raid: BotRaidRecord): AdminAttackSummary {
    const authority = raid.authority
    const target = authority?.target
    const fallback = raid.status === 'finished'
      ? 'finished'
      : raid.status === 'aborted'
        ? 'aborted'
        : 'live'
    const state = raid.status === 'settling'
      ? 'finalizing'
      : adminAttackStateOf(authority?.phase, fallback)
    return {
      id: raid.raidId,
      attackerId: raid.attackerId,
      defenderId: target?.kind === 'PLAYER' ? target.playerId : null,
      targetKind: target ? target.kind.toLowerCase() as AdminAttackSummary['targetKind'] : 'bot',
      targetId: target?.targetId ?? raid.botId ?? persistentBotVillageIdAt(LEGACY_WORLD_ID, raid.x, raid.y),
      worldId: target?.plot.worldId ?? LEGACY_WORLD_ID,
      targetX: target?.plot.x ?? raid.x,
      targetY: target?.plot.y ?? raid.y,
      state,
      stateVersion: authority?.version ?? 0,
      simulationVersion: authority?.rules.simulationVersion ?? ATTACK_SIMULATION_VERSION,
      createdAt: authority?.timestamps.createdAt ?? raid.startedAt,
      engagedAt: authority?.timestamps.engagedAt ?? null,
      updatedAt: authority?.timestamps.phaseChangedAt ?? raid.preparedSettlement?.settledAt ?? raid.startedAt,
      deadlineAt: authority?.timestamps.expiresAt ?? raid.expiresAt,
      endedAt: authority?.timestamps.settledAt
        ?? authority?.timestamps.cancelledAt
        ?? authority?.timestamps.expiredAt
        ?? raid.preparedSettlement?.settledAt
        ?? null
    }
  }

  adminAttacks(rawState?: unknown, rawLimit?: unknown): AdminAttackSummary[] {
    const state = rawState === undefined || rawState === null || rawState === ''
      ? null
      : String(rawState)
    if (state !== null && ![
      'preparing', 'engaged', 'active', 'finalizing', 'settled', 'cancelled', 'expired'
    ].includes(state)) throw new ApiError(400, 'Unknown attack state', 'ADMIN_INVALID_INPUT')
    const limit = rawLimit === undefined
      ? 100
      : adminInteger(rawLimit, 'limit', 1, ADMIN_ATTACK_LIMIT)
    const attacks = [
      ...[...this.replays.values()].map(replay => this.adminReplaySummary(replay)),
      ...[...this.botRaidSessions.values()].map(raid => this.adminBotRaidSummary(raid))
    ]
    return attacks
      .filter(attack => state === null || attack.state === state)
      .sort((left, right) => right.updatedAt - left.updatedAt || right.id.localeCompare(left.id))
      .slice(0, limit)
  }

  adminAudit(rawLimit?: unknown): AdminAuditEntry[] {
    const limit = rawLimit === undefined
      ? 100
      : adminInteger(rawLimit, 'limit', 1, ADMIN_AUDIT_LIMIT)
    return [...this.adminAuditLog.values()]
      .sort((left, right) => right.occurredAt - left.occurredAt || right.id.localeCompare(left.id))
      .slice(0, limit)
      .map(entry => ({
        ...entry,
        reason: typeof entry.reason === 'string'
          ? entry.reason
          : typeof entry.details?.reason === 'string' ? entry.details.reason : 'Administrative action',
        outcome: 'success',
        requestId: entry.requestId || entry.id,
        createdAt: entry.createdAt || entry.occurredAt,
        details: structuredClone(entry.details)
      }))
  }

  adminConfig(): AdminConfig {
    const config = this.currentAdminConfig()
    return {
      maintenance: {
        enabled: config.maintenanceEnabled,
        message: config.maintenanceMessage
      },
      accessPolicy: {
        suspendedSessionsRevoked: true,
        bannedSessionsRevoked: true
      },
      safeLimits: {
        playerList: ADMIN_PLAYER_LIMIT,
        botList: ADMIN_BOT_LIMIT,
        attackList: ADMIN_ATTACK_LIMIT,
        auditList: ADMIN_AUDIT_LIMIT,
        botRadius: ADMIN_BOT_RADIUS
      },
      updatedAt: config.updatedAt,
      revision: config.revision
    }
  }

  adminEconomy(rawDays?: unknown): AdminEconomy {
    const days = rawDays === undefined ? 7 : adminInteger(rawDays, 'days', 1, 30)
    const today = worldDayIndex(Date.now())
    const output = Array.from({ length: days }, (_, offset) => {
      const day = today - offset
      const stored = this.ledger.get(`d${day}`) ?? emptyLedgerDay(day)
      return structuredClone(stored)
    })
    return { today, days: output }
  }

  adminPlayerAction(rawId: unknown, rawAction: AdminPlayerActionRequest): AdminMutationResult {
    const id = adminSafeId(rawId, 'player id')
    const player = this.players.get(id)
    if (!player) throw new ApiError(404, 'Player not found', 'ADMIN_PLAYER_NOT_FOUND')
    if (!rawAction || typeof rawAction !== 'object') {
      throw new ApiError(400, 'Admin action is required', 'ADMIN_INVALID_INPUT')
    }
    const type = String(rawAction.type ?? '')
    const reason = adminReason(rawAction.reason)
    const now = Date.now()
    let changed = false
    let affected = 0
    let details: Record<string, unknown> = { reason }

    if (type === 'adjust_resources') {
      const input = rawAction as Extract<AdminPlayerActionRequest, { type: 'adjust_resources' }>
      const deltas = {
        gold: input.gold === undefined ? 0 : adminInteger(input.gold, 'gold delta', -MAX_BALANCE, MAX_BALANCE),
        ore: input.ore === undefined ? 0 : adminInteger(input.ore, 'ore delta', -MAX_BALANCE, MAX_BALANCE),
        food: input.food === undefined ? 0 : adminInteger(input.food, 'food delta', -MAX_BALANCE, MAX_BALANCE)
      }
      const before = {
        gold: Math.max(0, Math.floor(Number(player.balance) || 0)),
        ore: Math.max(0, Math.floor(Number(player.ore) || 0)),
        food: Math.max(0, Math.floor(Number(player.food) || 0))
      }
      const after = {
        gold: clamp(before.gold + deltas.gold, 0, MAX_BALANCE),
        ore: clamp(before.ore + deltas.ore, 0, MAX_BALANCE),
        food: clamp(before.food + deltas.food, 0, MAX_BALANCE)
      }
      changed = before.gold !== after.gold || before.ore !== after.ore || before.food !== after.food
      if (changed) {
        player.balance = after.gold
        player.ore = after.ore
        player.food = after.food
        player.revision += 1
        player.lastMutationAt = now
        this.players.markDirty(id)
        for (const resource of ['gold', 'ore', 'food'] as const) {
          const delta = after[resource] - before[resource]
          if (delta === 0) continue
          affected += 1
          this.book(delta > 0 ? 'faucets' : 'sinks', resource, Math.abs(delta))
        }
      }
      details = { reason, deltas, before, after }
    } else if (type === 'set_trophies') {
      const input = rawAction as Extract<AdminPlayerActionRequest, { type: 'set_trophies' }>
      const trophies = adminInteger(input.trophies, 'trophies', 0, 2_147_483_647)
      const before = player.trophies
      changed = before !== trophies
      if (changed) {
        player.trophies = trophies
        player.revision += 1
        player.lastMutationAt = now
        this.players.markDirty(id)
        affected = 1
      }
      details = { reason, before, after: trophies }
    } else if (type === 'set_shield') {
      const input = rawAction as Extract<AdminPlayerActionRequest, { type: 'set_shield' }>
      const until = input.until === undefined || input.until === null
        ? null
        : adminInteger(input.until, 'shield expiry', now, now + 365 * 24 * 60 * 60_000)
      const before = (player.shieldUntil ?? 0) > 0 ? player.shieldUntil! : null
      changed = before !== until
      if (changed) {
        player.shieldUntil = until ?? 0
        player.revision += 1
        player.lastMutationAt = now
        this.players.markDirty(id)
        affected = 1
      }
      details = { reason, before, after: until }
    } else if (type === 'rename') {
      const input = rawAction as Extract<AdminPlayerActionRequest, { type: 'rename' }>
      const username = adminRequiredText(input.username, 'username', 18)
      if (!isValidUsername(username)) throw new ApiError(400, 'Username must be 3-18 letters, numbers, _ or -')
      const usernameKey = normalizeUsernameKey(username)
      const duplicate = [...this.players.values()].find(candidate => candidate.id !== id
        && normalizeUsernameKey(candidate.username) === usernameKey)
      if (duplicate) throw new ApiError(409, 'That username is already taken', 'USERNAME_TAKEN')
      const before = player.username
      changed = before !== username
      if (changed) {
        if (player.passwordHash && player.usernameKey && player.usernameKey !== usernameKey) {
          this.usernameIndex.delete(player.usernameKey)
        }
        if (player.passwordHash) {
          player.usernameKey = usernameKey
          this.usernameIndex.set(usernameKey, id)
        }
        player.username = username
        player.revision += 1
        player.appearanceRevision = appearanceRevisionOf(player) + 1
        player.lastMutationAt = now
        this.players.markDirty(id)
        affected = 1
      }
      details = { reason, before, after: username }
    } else if (type === 'revoke_sessions') {
      affected = this.revokeAllSessions(player)
      changed = affected > 0
      details = { reason, revoked: affected }
    } else if (type === 'set_access') {
      const input = rawAction as Extract<AdminPlayerActionRequest, { type: 'set_access' }>
      const state = String(input.state ?? '')
      if (!['active', 'suspended', 'banned'].includes(state)) {
        throw new ApiError(400, 'Access state must be active, suspended, or banned', 'ADMIN_INVALID_INPUT')
      }
      let until: number | null = null
      if (state === 'suspended' && input.until !== undefined && input.until !== null) {
        until = adminInteger(input.until, 'suspension expiry', now + 1, now + 10 * 365 * 24 * 60 * 60_000)
      } else if (state !== 'suspended' && input.until !== undefined && input.until !== null) {
        throw new ApiError(400, 'Only suspensions may have an expiry', 'ADMIN_INVALID_INPUT')
      }
      const current = this.adminModeration.get(id)
      const nextReason = state === 'active' ? null : reason
      changed = !current || current.state !== state || current.reason !== nextReason || current.until !== until
      if (changed) {
        this.adminModeration.set(id, {
          playerId: id,
          state: state as AdminAccessState,
          reason: nextReason,
          until,
          updatedAt: now,
          revision: (current?.revision ?? 0) + 1
        })
        affected = 1
      }
      const revoked = state === 'active' ? 0 : this.revokeAllSessions(player)
      details = {
        reason,
        before: current?.state ?? 'active',
        after: state,
        until,
        sessionsRevoked: revoked
      }
    } else if (type === 'send_notice') {
      const input = rawAction as Extract<AdminPlayerActionRequest, { type: 'send_notice' }>
      const title = adminRequiredText(input.title, 'notice title', 80)
      const message = adminRequiredText(input.message, 'notice message', 500)
      const severity = String(input.severity ?? 'info')
      if (!['info', 'warning', 'critical'].includes(severity)) {
        throw new ApiError(400, 'Notice severity must be info, warning, or critical', 'ADMIN_INVALID_INPUT')
      }
      const record = this.notifications.get(id) ?? { items: [] }
      const notice: AdminNoticeItem = {
        id: `notice_${randomHex(10)}`,
        kind: 'admin_notice',
        title,
        message,
        severity: severity as AdminNoticeItem['severity'],
        time: now,
        read: false
      }
      record.items.unshift(notice)
      record.items.length = Math.min(record.items.length, MAX_NOTIFICATIONS)
      this.notifications.set(id, record)
      changed = true
      affected = 1
      details = { reason, title, severity }
    } else {
      throw new ApiError(400, 'Unknown admin player action', 'ADMIN_INVALID_INPUT')
    }

    const auditId = this.appendAdminAudit(type, id, details, now)
    this.leaderboardCache = null
    return { ok: true, action: type, targetId: id, changed, affected, auditId }
  }

  adminOperation(rawAction: AdminOperationRequest): AdminMutationResult {
    if (!rawAction || typeof rawAction !== 'object') {
      throw new ApiError(400, 'Admin operation is required', 'ADMIN_INVALID_INPUT')
    }
    const type = String(rawAction.type ?? '')
    const reason = adminReason(rawAction.reason)
    const now = Date.now()
    let changed = false
    let affected = 0
    let details: Record<string, unknown> = { reason }

    if (type === 'clear_shields') {
      const candidates = [...this.players.values()]
        .filter(player => (player.shieldUntil ?? 0) > now)
        .sort((left, right) => (left.shieldUntil ?? 0) - (right.shieldUntil ?? 0) || left.id.localeCompare(right.id))
        .slice(0, 1_000)
      for (const player of candidates) {
        player.shieldUntil = 0
        player.revision += 1
        player.lastMutationAt = now
        this.players.markDirty(player.id)
      }
      affected = candidates.length
      changed = affected > 0
      details = { reason, cleared: affected, truncated: affected === 1_000 }
    } else if (type === 'set_maintenance') {
      const input = rawAction as Extract<AdminOperationRequest, { type: 'set_maintenance' }>
      if (typeof input.enabled !== 'boolean') {
        throw new ApiError(400, 'Maintenance enabled must be a boolean', 'ADMIN_INVALID_INPUT')
      }
      const message = adminOptionalText(input.message, 'maintenance message', 500)
      const current = this.currentAdminConfig()
      const nextMessage = input.enabled ? message : null
      const before = {
        enabled: current.maintenanceEnabled,
        message: current.maintenanceMessage
      }
      changed = current.maintenanceEnabled !== input.enabled || current.maintenanceMessage !== nextMessage
      if (changed) {
        current.maintenanceEnabled = input.enabled
        current.maintenanceMessage = nextMessage
        current.updatedAt = now
        current.revision += 1
        this.adminRuntimeConfig.markDirty(ADMIN_CONFIG_KEY)
        affected = 1
      }
      details = {
        reason,
        before: before.enabled,
        beforeMessage: before.message,
        after: input.enabled,
        message: nextMessage
      }
    } else {
      throw new ApiError(400, 'Unknown admin operation', 'ADMIN_INVALID_INPUT')
    }

    const auditId = this.appendAdminAudit(type, null, details, now)
    this.leaderboardCache = null
    return { ok: true, action: type, targetId: null, changed, affected, auditId }
  }

  // ---- notifications ----

  private notify(playerId: string, item: AttackNotificationItem) {
    const record = this.notifications.get(playerId) ?? { items: [] }
    if (record.items.some(existing => existing.id === item.id)) return
    record.items.unshift(item)
    record.items.length = Math.min(record.items.length, MAX_NOTIFICATIONS)
    this.notifications.set(playerId, record)
  }

  private unreadCount(playerId: string): number {
    const record = this.notifications.get(playerId)
    if (!record) return 0
    return record.items.reduce((sum, item) => sum + (item.read ? 0 : 1), 0)
  }

  listNotifications(player: PlayerRecord): LegacyNotificationItem[] {
    return (this.notifications.get(player.id)?.items ?? []).map(item => ({ ...item }))
  }

  markNotificationsRead(player: PlayerRecord): void {
    const record = this.notifications.get(player.id)
    if (!record) return
    let changed = false
    for (const item of record.items) {
      if (!item.read) {
        item.read = true
        changed = true
      }
    }
    if (changed) this.notifications.markDirty(player.id)
  }

  getUnread(player: PlayerRecord): number {
    return this.unreadCount(player.id)
  }
}
