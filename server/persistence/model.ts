/**
 * Persistence-facing domain records.
 *
 * These types deliberately contain no Phaser/client imports. The server database is
 * a domain boundary, not a serialized copy of a scene graph.
 */
import type { AttackAggregate } from '../attack-domain/types'

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

export interface WorldAtlasQuery {
  worldId: string
  minX: number
  maxX: number
  minY: number
  maxY: number
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

/** Coarse spatial row for the atlas modal; deliberately excludes village JSON. */
export interface WorldPlayerEntry {
  plot: WorldPlotRecord
  player: PlayerSummaryRecord
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

export interface TransactionOptions {
  isolation?: 'read committed' | 'repeatable read' | 'serializable'
  /** Safe only when the callback performs no non-database side effects. */
  maxRetries?: number
}
