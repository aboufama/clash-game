import type {
  AccountRecord,
  AccountModerationRecord,
  AdminAttackQuery,
  AdminAuditRecord,
  AdminOverviewRecord,
  AdminPlayerQuery,
  AdminPlayerRecord,
  AdminRuntimeConfigRecord,
  AttackCandidateQuery,
  AttackCandidateRecord,
  AttackAuthorityCommandWrite,
  AttackAuthorityWrite,
  BalanceLedgerRecord,
  BalanceLedgerDaySummary,
  AttackCommandRecord,
  AttackCommandQuery,
  AttackRecord,
  BotVillageRecord,
  IdempotencyClaim,
  JsonObject,
  JsonValue,
  LeaderboardPlayerRecord,
  LeaderboardQuery,
  NotificationQuery,
  NotificationRecord,
  OutboxEventRecord,
  ParticipantReplayQuery,
  PlayerSummaryRecord,
  ReleasedWorldPlotRecord,
  ReplayChunkRecord,
  SessionRecord,
  SettlementRecord,
  TransactionOptions,
  VillageRecord,
  WorldAllocationRecord,
  WorldAtlasEntry,
  WorldAtlasQuery,
  WorldPlayerDirectoryQuery,
  WorldPlayerEntry,
  WorldPlotRecord,
  WorldRegionRecord
} from './model'

export class PersistenceConflictError extends Error {
  constructor(message: string) {
    super(message)
  }
}

export interface AccountRepository {
  getById(id: string, options?: { forUpdate?: boolean }): Promise<AccountRecord | null>
  getByUsernameKey(usernameKey: string, options?: { forUpdate?: boolean }): Promise<AccountRecord | null>
  listLeaderboard(query: LeaderboardQuery): Promise<PlayerSummaryRecord[]>
  listLeaderboardDetails(query: LeaderboardQuery & { now: Date }): Promise<LeaderboardPlayerRecord[]>
  insert(record: AccountRecord): Promise<void>
  update(record: AccountRecord, expectedRevision: number): Promise<boolean>
  /** Presence-only write; deliberately does not advance gameplay/profile revision. */
  touchLastSeen(id: string, seenAt: Date): Promise<boolean>
  /** Clears one indexed batch and advances profile revisions atomically. */
  clearShields(now: Date, limit: number): Promise<number>
  /** Deletes the account root; dependent authority rows cascade with it. */
  delete(id: string): Promise<boolean>
  /** Archives unreachable guests only when no immutable combat/economy history references them. */
  deleteUnreferencedGuests(ids: readonly string[]): Promise<number>
}

export interface SessionRepository {
  getByTokenHash(tokenHash: string, options?: { forUpdate?: boolean }): Promise<SessionRecord | null>
  /** Oldest-first bounded device sessions, used to enforce a hard session cap. */
  listForPlayer(playerId: string, limit: number, options?: { forUpdate?: boolean }): Promise<SessionRecord[]>
  insert(record: SessionRecord): Promise<void>
  touch(tokenHash: string, usedAt: Date): Promise<boolean>
  delete(tokenHash: string): Promise<boolean>
  deleteForPlayer(playerId: string): Promise<number>
}

export interface VillageRepository {
  get(playerId: string, options?: { forUpdate?: boolean }): Promise<VillageRecord | null>
  insert(record: VillageRecord): Promise<void>
  update(record: VillageRecord, expectedEconomyRevision: number): Promise<boolean>
  updateAppearance(record: VillageRecord, expectedAppearanceRevision: number): Promise<boolean>
}

export interface WorldRepository {
  getAllocation(worldId: string, options?: { forUpdate?: boolean }): Promise<WorldAllocationRecord | null>
  insertAllocation(record: WorldAllocationRecord): Promise<void>
  updateAllocation(record: WorldAllocationRecord, expectedRevision: number): Promise<boolean>
  getRegion(worldId: string, regionX: number, regionY: number): Promise<WorldRegionRecord | null>
  /** Idempotently persists immutable region metadata; mismatched metadata conflicts. */
  ensureRegion(record: WorldRegionRecord): Promise<'inserted' | 'existing'>
  getReleasedSlots(
    worldId: string,
    limit: number,
    options?: { forUpdate?: boolean; excludeOrdinals?: readonly number[] }
  ): Promise<ReleasedWorldPlotRecord[]>
  getReleasedSlot(
    worldId: string,
    ordinal: number,
    options?: { forUpdate?: boolean }
  ): Promise<ReleasedWorldPlotRecord | null>
  putReleasedSlot(record: ReleasedWorldPlotRecord): Promise<void>
  deleteReleasedSlots(worldId: string, ordinals: readonly number[]): Promise<number>
  getPlayerPlot(playerId: string, options?: { forUpdate?: boolean }): Promise<WorldPlotRecord | null>
  getOccupant(worldId: string, x: number, y: number, options?: { forUpdate?: boolean }): Promise<WorldPlotRecord | null>
  /** Bounded exact-coordinate occupancy projection for randomized world probes. */
  listOccupantsAt(worldId: string, coordinates: readonly { x: number; y: number }[]): Promise<WorldPlotRecord[]>
  /** Exact persisted bot identity lookup; generation is never a read fallback. */
  getBotVillage(id: string, options?: { forUpdate?: boolean }): Promise<BotVillageRecord | null>
  /** Exact-coordinate persisted bot lookup used by map and attack start. */
  getBotVillageAt(
    worldId: string,
    x: number,
    y: number,
    options?: { forUpdate?: boolean }
  ): Promise<BotVillageRecord | null>
  /** Bounded persisted-bot window; callers must never synthesize missing rows. */
  listBotVillages(query: WorldAtlasQuery): Promise<BotVillageRecord[]>
  /** Idempotent only for equivalent content/provenance; the committed row's timestamps win. */
  insertBotVillage(record: BotVillageRecord): Promise<'inserted' | 'existing'>
  /** CAS update; identity, coordinate, plot version and generator provenance are immutable. */
  updateBotVillage(record: BotVillageRecord, expectedRevision: number): Promise<boolean>
  deleteBotVillage(id: string): Promise<boolean>
  listAtlas(query: WorldAtlasQuery): Promise<WorldAtlasEntry[]>
  listPlayers(query: WorldAtlasQuery): Promise<WorldPlayerEntry[]>
  /** Global atlas directory, bounded by result count and ordered nearest-first. */
  listPlayersGlobal(query: WorldPlayerDirectoryQuery): Promise<WorldPlayerEntry[]>
  /**
   * Claims expired guest account roots in stable ID order. PostgreSQL locks
   * accounts (not plots) with SKIP LOCKED so cleanup follows account -> plot.
   */
  claimExpiredGuestAccountIds(worldId: string, now: Date, limit: number): Promise<string[]>
  /**
   * Inserts one unique claim and consumes any released-slot row for the same
   * coordinate in the same transaction. This repository-level invariant also
   * covers a frontier allocator racing a release beyond the current cursor.
   */
  assign(record: WorldPlotRecord): Promise<void>
  renewGuestLease(
    playerId: string,
    leaseId: string,
    renewedAt: Date,
    expiresAt: Date
  ): Promise<boolean>
  promoteGuestLease(playerId: string, leaseId: string, now: Date): Promise<boolean>
  release(playerId: string): Promise<boolean>
}

export interface AttackRepository {
  get(id: string, options?: { forUpdate?: boolean }): Promise<AttackRecord | null>
  findCandidates(query: AttackCandidateQuery): Promise<AttackCandidateRecord[]>
  /** Selection/audit history including PREPARING; never use this to decide defender locking. */
  listActiveIncoming(defenderId: string, limit: number): Promise<AttackRecord[]>
  /** Defender leases only: ENGAGED/ACTIVE/FINALIZING; PREPARING cannot crowd these rows out. */
  listLeasedIncoming(defenderId: string, limit: number): Promise<AttackRecord[]>
  listActiveOutgoing(attackerId: string, limit: number): Promise<AttackRecord[]>
  /** Deadline-ordered maintenance claims; PostgreSQL uses SKIP LOCKED. */
  claimDue(now: Date, limit: number): Promise<AttackRecord[]>
  /** Selection/audit lookup including PREPARING; never use this for defender lease metadata. */
  listActiveForPlayers(playerIds: readonly string[], limit: number): Promise<AttackRecord[]>
  /** One bounded atlas/map lookup for defenders that currently own an engagement lease. */
  listLeasedIncomingForDefenders(defenderIds: readonly string[], limit: number): Promise<AttackRecord[]>
  insert(record: AttackRecord): Promise<void>
  /** CAS-persist one complete domain aggregate and refresh its query projection. */
  compareAndSwapAuthority(write: AttackAuthorityWrite): Promise<boolean>
  /** Atomically append one audit command and CAS-persist its resulting aggregate. */
  commitAuthorityCommand(write: AttackAuthorityCommandWrite): Promise<'inserted' | 'duplicate'>
  /** Bounded, sequence-ordered audit/idempotency log. */
  listCommands(query: AttackCommandQuery): Promise<AttackCommandRecord[]>
  /** Audit/import primitive. Runtime command handling should use commitAuthorityCommand. */
  appendCommand(record: AttackCommandRecord): Promise<'inserted' | 'duplicate'>
  settle(record: SettlementRecord): Promise<'inserted' | 'duplicate'>
}

export interface ReplayRepository {
  append(record: ReplayChunkRecord): Promise<'inserted' | 'duplicate'>
  /** Atomically charges a durable per-attack byte/chunk budget before append. */
  appendPresentation(
    record: ReplayChunkRecord,
    budget: { byteSize: number; maxBytes: number; maxChunks: number }
  ): Promise<'inserted' | 'duplicate' | 'dropped'>
  /** Returns no rows unless participantId is the attack's attacker or defender. */
  listForParticipant(query: ParticipantReplayQuery): Promise<ReplayChunkRecord[]>
  /** Deletes only presentation chunks for a bounded set of old terminal attacks. */
  prunePresentation(before: Date, attackLimit: number): Promise<number>
}

export interface NotificationRepository {
  add(record: NotificationRecord): Promise<'inserted' | 'duplicate'>
  listForPlayer(query: NotificationQuery): Promise<NotificationRecord[]>
  markAllRead(playerId: string, readAt: Date): Promise<number>
}

export interface IdempotencyRepository {
  claim(actorId: string, operation: string, requestId: string, now: Date, expiresAt: Date): Promise<IdempotencyClaim>
  complete(actorId: string, operation: string, requestId: string, response: JsonValue): Promise<void>
  /** Deletes one expiry-ordered maintenance batch; PostgreSQL uses SKIP LOCKED. */
  pruneExpired(now: Date, limit: number): Promise<number>
}

export interface OutboxRepository {
  add(event: Omit<OutboxEventRecord, 'id' | 'publishedAt' | 'attempts' | 'lockedBy' | 'lockedUntil'>): Promise<string>
  claimBatch(workerId: string, now: Date, lockedUntil: Date, limit: number): Promise<OutboxEventRecord[]>
  markPublished(id: string, workerId: string, publishedAt: Date): Promise<boolean>
  release(id: string, workerId: string, retryAt: Date): Promise<boolean>
  /**
   * Deletes one bounded retention batch. Published hints age out quickly;
   * unpublished best-effort hints expire after their longer delivery window.
   */
  prune(
    publishedBefore: Date,
    unpublishedBefore: Date,
    now: Date,
    limit: number
  ): Promise<{ published: number; expired: number }>
}

export interface OperationMarkerRepository {
  add(playerId: string, kind: string, markerKey: string, observedAt: Date): Promise<void>
  has(playerId: string, kind: string, markerKey: string): Promise<boolean>
  /** Deletes one oldest-first maintenance batch; current merchant days remain. */
  pruneBefore(before: Date, limit: number): Promise<number>
}

export interface BalanceLedgerRepository {
  append(record: BalanceLedgerRecord): Promise<'inserted' | 'duplicate'>
  sumSince(
    playerId: string,
    operation: string,
    currency: BalanceLedgerRecord['currency'],
    since: Date
  ): Promise<number>
  summarizeDays(fromDay: number, throughDay: number): Promise<BalanceLedgerDaySummary[]>
}

/** Bounded, secret-free reads and durable mutations for the operator surface. */
export interface AdminRepository {
  overview(now: Date, onlineSince: Date): Promise<AdminOverviewRecord>
  listPlayers(query: AdminPlayerQuery): Promise<AdminPlayerRecord[]>
  getPlayer(playerId: string, now: Date): Promise<AdminPlayerRecord | null>
  isUsernameTaken(usernameKey: string, excludingPlayerId: string): Promise<boolean>
  listAttacks(query: AdminAttackQuery): Promise<AttackRecord[]>
  getModeration(playerId: string, options?: { forUpdate?: boolean }): Promise<AccountModerationRecord | null>
  upsertModeration(record: AccountModerationRecord, expectedRevision: number | null): Promise<boolean>
  getConfig(options?: { forUpdate?: boolean }): Promise<AdminRuntimeConfigRecord>
  updateConfig(record: AdminRuntimeConfigRecord, expectedRevision: number): Promise<boolean>
  listAudit(limit: number): Promise<AdminAuditRecord[]>
  appendAudit(record: AdminAuditRecord): Promise<void>
}

export interface UnitOfWork {
  accounts: AccountRepository
  sessions: SessionRepository
  villages: VillageRepository
  world: WorldRepository
  attacks: AttackRepository
  replays: ReplayRepository
  notifications: NotificationRepository
  idempotency: IdempotencyRepository
  outbox: OutboxRepository
  operationMarkers: OperationMarkerRepository
  balanceLedger: BalanceLedgerRepository
  admin: AdminRepository
}

export interface Persistence {
  transaction<T>(work: (tx: UnitOfWork) => Promise<T>, options?: TransactionOptions): Promise<T>
  close(): Promise<void>
}

/** Execute a mutation and persist its exact response in the same transaction. */
export async function idempotentMutation<T extends JsonValue>(
  tx: UnitOfWork,
  input: {
    actorId: string
    operation: string
    requestId: string
    now: Date
    expiresAt: Date
  },
  mutate: () => Promise<T>
): Promise<{ replayed: boolean; response: T }> {
  const claim = await tx.idempotency.claim(
    input.actorId,
    input.operation,
    input.requestId,
    input.now,
    input.expiresAt
  )
  if (claim.kind === 'completed') return { replayed: true, response: claim.response as T }
  const response = await mutate()
  await tx.idempotency.complete(input.actorId, input.operation, input.requestId, response)
  return { replayed: false, response }
}

export function outboxEvent(input: {
  topic: string
  aggregateType: string
  aggregateId: string
  eventType: string
  payload?: JsonObject
  now: Date
  availableAt?: Date
}): Omit<OutboxEventRecord, 'id' | 'publishedAt' | 'attempts' | 'lockedBy' | 'lockedUntil'> {
  return {
    topic: input.topic,
    aggregateType: input.aggregateType,
    aggregateId: input.aggregateId,
    eventType: input.eventType,
    payload: input.payload ?? {},
    createdAt: input.now,
    availableAt: input.availableAt ?? input.now
  }
}
