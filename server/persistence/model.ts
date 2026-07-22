/**
 * Persistence-facing domain records.
 *
 * These types deliberately contain no Phaser/client imports. The server database is
 * a domain boundary, not a serialized copy of a scene graph.
 */
import type { AttackAggregate } from '../attack-domain/types'
import type { StarterVillageConfig } from '../../src/game/config/StarterVillage'
import type { SerializedWorld, VillageBanner } from '../../src/game/data/Models'

export type JsonPrimitive = string | number | boolean | null
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue }
export type JsonObject = { [key: string]: JsonValue }

export interface AccountRecord {
  id: string
  username: string
  usernameKey: string | null
  passwordHash: string | null
  registered: boolean
  trophies: number
  shieldUntil: Date | null
  createdAt: Date
  lastSeenAt: Date
  revision: number
  revengeRights: JsonObject
  botRaidCooldowns: JsonObject
  /** Last Test Mode activation atomically claimed by any session for this account. */
  testModeAcknowledgedActivationId: string | null
  /** False only for accounts created after mandatory intro-battle onboarding shipped. */
  introBattleCompleted: boolean
}

/** Public account fields used by bounded discovery queries. */
export interface PlayerSummaryRecord {
  playerId: string
  username: string
  trophies: number
  shieldUntil: Date | null
  lastSeenAt: Date
  revision: number
}

export interface LeaderboardQuery {
  limit: number
}

/** One bounded leaderboard row with the public village/plot projection. */
export interface LeaderboardPlayerRecord extends PlayerSummaryRecord {
  worldId: string
  x: number
  y: number
  buildingCount: number
}

export interface SessionRecord {
  tokenHash: string
  playerId: string
  createdAt: Date
  lastUsedAt: Date
  expiresAt: Date
  deviceId: string | null
}

export interface VillageRecord {
  playerId: string
  buildings: JsonValue[]
  obstacles: JsonValue[]
  army: JsonObject
  wallLevel: number
  gold: number
  ore: number
  food: number
  productionRemainders: { ore: number; food: number }
  population: JsonObject
  banner: VillageBanner | null
  simulatedThrough: Date
  lastMutationAt: Date
  layoutRevision: number
  /** Public building/population presentation fence used by world-map caches. */
  appearanceRevision: number
  economyRevision: number
  simulationVersion: number
  nextEventAt: Date | null
}

/** Village fields required to draw an accurate world-map neighbour. */
export interface PublicVillageRecord {
  playerId: string
  buildings: JsonValue[]
  obstacles: JsonValue[]
  wallLevel: number
  population: JsonObject
  banner: VillageBanner | null
  simulatedThrough: Date
  lastMutationAt: Date
  layoutRevision: number
  appearanceRevision: number
  simulationVersion: number
  nextEventAt: Date | null
}

export interface WorldPlotRecord {
  worldId: string
  x: number
  y: number
  /** Immutable generation-pinned region containing this plot. */
  regionId: string
  playerId: string
  plotVersion: number
  assignedAt: Date
  /** All four lease fields are null for a registered/permanent claim. */
  leaseId: string | null
  leaseIssuedAt: Date | null
  leaseRenewedAt: Date | null
  leaseExpiresAt: Date | null
}

/**
 * One server-owned procedural village after it has crossed the persistence
 * boundary. The generator provenance is immutable; ordinary presentation or
 * balance changes advance `revision` instead of silently regenerating it.
 */
export interface BotVillageRecord {
  id: string
  worldId: string
  x: number
  y: number
  /** Changes when this coordinate is vacated and later receives a new owner. */
  plotVersion: number
  /** Version of the world-topology rules that selected this coordinate. */
  worldGenerationVersion: number
  /** Version of the procedural village algorithm that authored `world`. */
  generatorVersion: number
  /** Persisted safe-integer generator input; never reconstructed by a client. */
  seed: number
  username: string
  trophies: number
  /** Generator-owned audit/tuning metadata (difficulty, archetype, districts, etc.). */
  profile: JsonObject
  /** Complete immutable-at-attack-start village payload served to map and combat clients. */
  world: SerializedWorld
  /** Public cache/CAS revision for this persisted village. */
  revision: number
  createdAt: Date
  updatedAt: Date
}

export interface WorldAtlasQuery {
  worldId: string
  minX: number
  maxX: number
  minY: number
  maxY: number
  now: Date
  limit: number
}

/**
 * Bounded global player-directory read for the atlas modal. Unlike
 * `WorldAtlasQuery`, this deliberately has no coordinate window: the atlas
 * charts every settled chief in the world and caps the result nearest-first.
 */
export interface WorldPlayerDirectoryQuery {
  worldId: string
  centerX: number
  centerY: number
  now: Date
  limit: number
}

/** One self-contained map entry; callers do not need one query per neighbour. */
export interface WorldAtlasEntry {
  plot: WorldPlotRecord
  player: PlayerSummaryRecord
  village: PublicVillageRecord
  accountCreatedAt: Date
  /** Private clock inputs used only to derive a current postcard; never serialized to clients. */
  simulation: Pick<VillageRecord,
    'gold' | 'ore' | 'food' | 'productionRemainders' | 'economyRevision'>
}

/** Coarse spatial row for the atlas modal; excludes layout JSON but carries heraldry. */
export interface WorldPlayerEntry {
  plot: WorldPlotRecord
  player: PlayerSummaryRecord
  banner: VillageBanner | null
}

/** A region never changes generator after its first persisted claim/read. */
export interface WorldRegionRecord {
  worldId: string
  regionId: string
  regionX: number
  regionY: number
  size: number
  generationVersion: number
  createdAt: Date
}

/**
 * One optimistic-lockable high-water cursor per world. Automatic allocation
 * additionally takes a row lock, so multiple server processes cannot advance
 * the same frontier. Release and explicit-coordinate claims do not mutate it.
 */
export interface WorldAllocationRecord {
  worldId: string
  schemaVersion: number
  regionSize: number
  currentGenerationVersion: number
  nextOrdinal: number
  /**
   * Settlement-model marker (absent/1 = pre-spiral admission that skipped bot
   * ordinals; 2 = settleable central holes below the cursor were indexed as
   * free slots once, so admission fills the world center first). The record
   * shape itself is unchanged, hence not part of schemaVersion.
   */
  allocationModel?: number
  /**
   * Durable lower bound for the first revision of every newly provisioned bot
   * village. Destructive bot purges advance this beyond every retired bot so
   * a pre-purge map cache token can never suppress the replacement payload.
   */
  botRevisionEpoch?: number
  revision: number
  updatedAt: Date
}

export interface ReleasedWorldPlotRecord {
  worldId: string
  ordinal: number
  /** Version for the next occupant; it has already advanced past the old claim. */
  plotVersion: number
  releasedAt: Date
}

export const ATTACK_STATES = [
  'preparing',
  'engaged',
  'active',
  'finalizing',
  'settled',
  'cancelled',
  'expired'
] as const

export type AttackState = typeof ATTACK_STATES[number]
export type AttackTargetKind = 'player' | 'bot' | 'scenario'

export interface AttackRecord {
  id: string
  attackerId: string
  defenderId: string | null
  targetKind: AttackTargetKind
  targetId: string
  worldId: string
  targetX: number
  targetY: number
  targetPlotVersion: number
  state: AttackState
  stateVersion: number
  simulationVersion: number
  seed: string
  fencingTokenHash: string
  defenderSnapshot: JsonObject
  reservedArmy: JsonObject
  createdAt: Date
  engagedAt: Date | null
  updatedAt: Date
  deadlineAt: Date
  endedAt: Date | null
  result: JsonObject | null
  /**
   * Resumable server authority. Historical imports that predate the aggregate
   * remain null and are intentionally read-only.
   */
  authority: AttackAggregate | null
}

export interface AttackCandidateQuery {
  attackerId: string
  worldId: string
  targetTrophies: number
  trophyRadius: number
  now: Date
  limit: number
}

export interface AttackCandidateRecord {
  player: PlayerSummaryRecord
  plot: WorldPlotRecord
  layoutRevision: number
  trophyDistance: number
}

export interface AttackCommandRecord {
  attackId: string
  sequence: number
  actorId: string
  /** Domain commandId; transport request idempotency lives in IdempotencyRepository. */
  commandId: string
  commandType: string
  payload: JsonObject
  acceptedAt: Date
}

export interface AttackCommandQuery {
  attackId: string
  /** Exclusive sequence cursor. Use zero for the first domain command. */
  afterSequence: number
  limit: number
}

export interface AttackAuthorityCas {
  expectedState: AttackState
  expectedVersion: number
}

export interface AttackAuthorityWrite extends AttackAuthorityCas {
  attackId: string
  authority: AttackAggregate
  updatedAt: Date
}

/** One durable operation for the command row and its resulting aggregate. */
export interface AttackAuthorityCommandWrite extends AttackAuthorityWrite {
  command: AttackCommandRecord
}

export interface IdempotencyRecord {
  actorId: string
  operation: string
  requestId: string
  state: 'in_progress' | 'completed'
  response: JsonValue | null
  createdAt: Date
  expiresAt: Date
}

export type IdempotencyClaim =
  | { kind: 'claimed' }
  | { kind: 'completed'; response: JsonValue }

export interface OutboxEventRecord {
  id: string
  topic: string
  aggregateType: string
  aggregateId: string
  eventType: string
  payload: JsonObject
  createdAt: Date
  availableAt: Date
  publishedAt: Date | null
  attempts: number
  lockedBy: string | null
  lockedUntil: Date | null
}

export interface SettlementRecord {
  attackId: string
  attackerId: string
  defenderId: string | null
  outcome: JsonObject
  committedAt: Date
}

export interface ReplayChunkRecord {
  attackId: string
  sequence: number
  format: string
  payload: JsonValue | null
  objectKey: string | null
  checksum: string
  createdAt: Date
}

export interface ParticipantReplayQuery {
  attackId: string
  participantId: string
  /** Exclusive sequence cursor. Use -1 for the first page. */
  afterSequence: number
  limit: number
}

export interface NotificationRecord {
  playerId: string
  id: string
  eventType: string
  payload: JsonObject
  occurredAt: Date
  readAt: Date | null
}

export interface NotificationCursor {
  occurredAt: Date
  id: string
}

export interface NotificationQuery {
  playerId: string
  /** Exclusive newest-first cursor. Omit for the first page. */
  before?: NotificationCursor
  unreadOnly?: boolean
  limit: number
}

export type BalanceCurrency = 'gold' | 'ore' | 'food' | 'trophies'

export interface BalanceLedgerRecord {
  playerId: string
  operation: string
  requestId: string
  currency: BalanceCurrency
  delta: number
  balanceAfter: number
  metadata: JsonObject
  createdAt: Date
}

/** Pre-aggregated, bounded tuning row; one operation/currency/day. */
export interface BalanceLedgerDaySummary {
  day: number
  operation: string
  currency: BalanceCurrency
  positive: number
  negative: number
  operationCount: number
}

export type AccountAccessState = 'active' | 'suspended' | 'banned'

/** Moderation is separate from credentials so no admin read can expose hashes. */
export interface AccountModerationRecord {
  playerId: string
  state: AccountAccessState
  reason: string | null
  until: Date | null
  updatedAt: Date
  revision: number
}

export interface AdminOverviewRecord {
  players: number
  registeredPlayers: number
  onlinePlayers: number
  playerVillages: number
  botVillages: number
  preparingAttacks: number
  engagedAttacks: number
  activeAttacks: number
  finalizingAttacks: number
  totalGold: number
  totalOre: number
  totalFood: number
  averageTrophies: number
  suspendedPlayers: number
  bannedPlayers: number
}

export interface AdminPlayerQuery {
  search: string
  limit: number
  now: Date
  onlineSince: Date
}

/** Secret-free account projection used only by bounded operator queries. */
export interface AdminPlayerRecord {
  id: string
  username: string
  registered: boolean
  trophies: number
  shieldUntil: Date | null
  createdAt: Date
  lastSeenAt: Date
  profileRevision: number
  accessState: AccountAccessState
  accessReason: string | null
  accessUntil: Date | null
  moderationUpdatedAt: Date | null
  worldId: string | null
  x: number | null
  y: number | null
  plotVersion: number | null
  gold: number
  ore: number
  food: number
  economyRevision: number
  layoutRevision: number
  appearanceRevision: number
  buildings: number
  obstacles: number
  army: JsonObject
  population: JsonObject
  activeSessions: number
  activeAttacks: number
}

export interface AdminAttackQuery {
  state: AttackState | null
  limit: number
}

export interface AdminAuditRecord {
  id: string
  actor: string
  action: string
  targetType: 'player' | 'system'
  targetId: string | null
  details: JsonObject
  occurredAt: Date
}

export interface AdminRuntimeConfigRecord {
  maintenanceEnabled: boolean
  maintenanceMessage: string | null
  testModeEnabled: boolean
  /** Player id -> explicit enabled/disabled; absence inherits the global flag. */
  testModeOverrides: Record<string, boolean>
  /** Shared activation for inherited players; null while global mode is off. */
  testModeGlobalActivationId: string | null
  /** Sparse continuity/activation ids for player-specific policy transitions. */
  testModePlayerActivationIds: Record<string, string>
  /** Null means use the shipped STARTER_VILLAGE template. */
  starterVillage: StarterVillageConfig | null
  updatedAt: Date
  revision: number
}

/** Atomic authority rows affected by the guarded, system-wide village reset. */
export interface AdminBaseResetRecord {
  accountsPreserved: number
  sessionsPreserved: number
  playerPlotsPreserved: number
  playerVillagesReset: number
  botVillagesPurged: number
  attacksPurged: number
  combatRecordsPurged: number
  notificationsPurged: number
  economyRecordsPurged: number
  auxiliaryRecordsPurged: number
}

export interface TransactionOptions {
  isolation?: 'read committed' | 'repeatable read' | 'serializable'
  /** Safe only when the callback performs no non-database side effects. */
  maxRetries?: number
}
