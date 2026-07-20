import type {
  AccountRecord,
  AccountModerationRecord,
  AdminBaseResetRecord,
  AdminAttackQuery,
  AdminAuditRecord,
  AdminOverviewRecord,
  AdminPlayerQuery,
  AdminPlayerRecord,
  AdminRuntimeConfigRecord,
  AttackAuthorityCommandWrite,
  AttackAuthorityWrite,
  AttackCandidateQuery,
  AttackCandidateRecord,
  AttackCommandRecord,
  AttackCommandQuery,
  AttackRecord,
  AttackState,
  BalanceLedgerRecord,
  BalanceLedgerDaySummary,
  BotVillageRecord,
  IdempotencyClaim,
  IdempotencyRecord,
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
  VillageRecord,
  WorldAllocationRecord,
  WorldAtlasEntry,
  WorldAtlasQuery,
  WorldPlayerDirectoryQuery,
  WorldPlayerEntry,
  WorldPlotRecord,
  WorldRegionRecord
} from './model'
import type {
  AccountRepository,
  AdminRepository,
  AttackRepository,
  BalanceLedgerRepository,
  IdempotencyRepository,
  NotificationRepository,
  OperationMarkerRepository,
  OutboxRepository,
  Persistence,
  ReplayRepository,
  SessionRepository,
  UnitOfWork,
  VillageRepository,
  WorldRepository
} from './repositories'
import { AdminBaseResetPreconditionError, PersistenceConflictError } from './repositories'
import {
  boundAttackCommandQuery,
  boundAdminAttackQuery,
  boundAdminPlayerQuery,
  boundAttackPlayerBatch,
  boundAttackCandidateQuery,
  boundedLimit,
  boundNotificationQuery,
  boundParticipantReplayQuery,
  boundWorldAtlasQuery,
  boundWorldPlayerDirectoryQuery,
  boundWorldOccupancyBatch,
  boundBotVillageProvisionBatch,
  QUERY_LIMITS
} from './query-bounds'
import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import {
  assertAttackRecordAuthority,
  assertAuthorityCommand,
  attackRecordWithAuthority
} from './attack-authority'
import { allocationOrdinalOf } from '../domain/world/allocation'

interface MemoryState {
  accounts: Map<string, AccountRecord>
  sessions: Map<string, SessionRecord>
  villages: Map<string, VillageRecord>
  worldAllocations: Map<string, WorldAllocationRecord>
  worldRegions: Map<string, WorldRegionRecord>
  releasedWorldPlots: Map<string, ReleasedWorldPlotRecord>
  plotsByPlayer: Map<string, WorldPlotRecord>
  plotOccupants: Map<string, string>
  botVillages: Map<string, BotVillageRecord>
  botVillageIdsByPlot: Map<string, string>
  attacks: Map<string, AttackRecord>
  commandsBySequence: Map<string, AttackCommandRecord>
  commandIds: Map<string, string>
  settlements: Map<string, SettlementRecord>
  replayChunks: Map<string, ReplayChunkRecord>
  presentationBytes: Map<string, number>
  presentationUsage: Map<string, { bytes: number; chunks: number }>
  notifications: Map<string, NotificationRecord>
  idempotency: Map<string, IdempotencyRecord>
  outbox: Map<string, OutboxEventRecord>
  markers: Map<string, Date>
  balanceLedger: Map<string, BalanceLedgerRecord>
  moderation: Map<string, AccountModerationRecord>
  adminAudit: Map<string, AdminAuditRecord>
  adminConfig: AdminRuntimeConfigRecord
  outboxSequence: number
}

function emptyState(): MemoryState {
  return {
    accounts: new Map(),
    sessions: new Map(),
    villages: new Map(),
    worldAllocations: new Map(),
    worldRegions: new Map(),
    releasedWorldPlots: new Map(),
    plotsByPlayer: new Map(),
    plotOccupants: new Map(),
    botVillages: new Map(),
    botVillageIdsByPlot: new Map(),
    attacks: new Map(),
    commandsBySequence: new Map(),
    commandIds: new Map(),
    settlements: new Map(),
    replayChunks: new Map(),
    presentationBytes: new Map(),
    presentationUsage: new Map(),
    notifications: new Map(),
    idempotency: new Map(),
    outbox: new Map(),
    markers: new Map(),
    balanceLedger: new Map(),
    moderation: new Map(),
    adminAudit: new Map(),
    adminConfig: {
      maintenanceEnabled: false,
      maintenanceMessage: null,
      updatedAt: new Date(0),
      revision: 1
    },
    outboxSequence: 0
  }
}

function copy<T>(value: T): T {
  return structuredClone(value)
}

function plotKey(worldId: string, x: number, y: number): string {
  return `${worldId}\u0000${x}\u0000${y}`
}

function regionKey(worldId: string, regionX: number, regionY: number): string {
  return tupleKey(worldId, regionX, regionY)
}

function releasedPlotKey(worldId: string, ordinal: number): string {
  return tupleKey(worldId, ordinal)
}

function assertBotVillageRecord(record: BotVillageRecord): void {
  if (!record.id || !record.worldId || !record.username) throw new Error('Bot village identity is required')
  if (!Number.isSafeInteger(record.x) || !Number.isSafeInteger(record.y)) {
    throw new Error('Bot village coordinates must be safe integers')
  }
  for (const [field, value] of [
    ['plotVersion', record.plotVersion],
    ['worldGenerationVersion', record.worldGenerationVersion],
    ['generatorVersion', record.generatorVersion],
    ['seed', record.seed],
    ['revision', record.revision]
  ] as const) {
    if (!Number.isSafeInteger(value) || value < 1) throw new Error(`Bot village ${field} must be a positive safe integer`)
  }
  if (!Number.isSafeInteger(record.trophies) || record.trophies < 0) {
    throw new Error('Bot village trophies must be a non-negative safe integer')
  }
  if (!(record.createdAt instanceof Date) || !Number.isFinite(record.createdAt.getTime())
    || !(record.updatedAt instanceof Date) || !Number.isFinite(record.updatedAt.getTime())
    || record.updatedAt < record.createdAt) {
    throw new Error('Bot village timestamps are invalid')
  }
  if (!record.profile || typeof record.profile !== 'object' || Array.isArray(record.profile)) {
    throw new Error('Bot village profile must be an object')
  }
  if (!record.world || record.world.id !== record.id || record.world.ownerId !== record.id
    || !Array.isArray(record.world.buildings)
    || !record.world.resources || typeof record.world.resources !== 'object') {
    throw new Error('Bot village world must be a complete self-owned serialized world')
  }
}

/** Concurrent first-read provisioners may stamp different wall-clock times. */
function sameBotVillageProvision(left: BotVillageRecord, right: BotVillageRecord): boolean {
  const { createdAt: _leftCreated, updatedAt: _leftUpdated, ...leftStable } = left
  const { createdAt: _rightCreated, updatedAt: _rightUpdated, ...rightStable } = right
  return isDeepStrictEqual(leftStable, rightStable)
}

function tupleKey(...parts: Array<string | number>): string {
  return parts.join('\u0000')
}

const ACTIVE_ATTACK_STATES = new Set<AttackState>(['preparing', 'engaged', 'active', 'finalizing'])
const DEFENDER_LEASE_STATES = new Set<AttackState>(['engaged', 'active', 'finalizing'])

function playerSummary(account: AccountRecord): PlayerSummaryRecord {
  return {
    playerId: account.id,
    username: account.username,
    trophies: account.trophies,
    shieldUntil: account.shieldUntil,
    lastSeenAt: account.lastSeenAt,
    revision: account.revision
  }
}

function publicVillage(village: VillageRecord): WorldAtlasEntry['village'] {
  return {
    playerId: village.playerId,
    buildings: village.buildings,
    obstacles: village.obstacles,
    wallLevel: village.wallLevel,
    population: village.population,
    banner: village.banner,
    simulatedThrough: village.simulatedThrough,
    lastMutationAt: village.lastMutationAt,
    layoutRevision: village.layoutRevision,
    appearanceRevision: village.appearanceRevision,
    simulationVersion: village.simulationVersion,
    nextEventAt: village.nextEventAt
  }
}

class MemoryAccounts implements AccountRepository {
  private readonly state: MemoryState

  constructor(state: MemoryState) {
    this.state = state
  }

  async getById(id: string): Promise<AccountRecord | null> {
    const record = this.state.accounts.get(id)
    return record ? copy(record) : null
  }

  async getByUsernameKey(usernameKey: string): Promise<AccountRecord | null> {
    for (const account of this.state.accounts.values()) {
      if (account.usernameKey === usernameKey) return copy(account)
    }
    return null
  }

  async listLeaderboard(query: LeaderboardQuery): Promise<PlayerSummaryRecord[]> {
    const limit = boundedLimit(query.limit, QUERY_LIMITS.leaderboard)
    return copy([...this.state.accounts.values()]
      .sort((a, b) => b.trophies - a.trophies || a.id.localeCompare(b.id))
      .slice(0, limit)
      .map(playerSummary))
  }

  async listLeaderboardDetails(query: LeaderboardQuery & { now: Date }): Promise<LeaderboardPlayerRecord[]> {
    const limit = boundedLimit(query.limit, QUERY_LIMITS.leaderboard)
    const rows: LeaderboardPlayerRecord[] = []
    for (const account of this.state.accounts.values()) {
      const plot = this.state.plotsByPlayer.get(account.id)
      const village = this.state.villages.get(account.id)
      if (!plot || !village || (plot.leaseExpiresAt !== null && plot.leaseExpiresAt <= query.now)) continue
      rows.push({
        ...playerSummary(account),
        worldId: plot.worldId,
        x: plot.x,
        y: plot.y,
        buildingCount: village.buildings.length
      })
    }
    rows.sort((a, b) => b.trophies - a.trophies || b.buildingCount - a.buildingCount
      || a.username.localeCompare(b.username) || a.playerId.localeCompare(b.playerId))
    return copy(rows.slice(0, limit))
  }

  async insert(record: AccountRecord): Promise<void> {
    if (this.state.accounts.has(record.id)) throw new Error(`Account already exists: ${record.id}`)
    if (record.usernameKey && await this.getByUsernameKey(record.usernameKey)) {
      throw new Error(`Username already exists: ${record.usernameKey}`)
    }
    this.state.accounts.set(record.id, copy(record))
  }

  async update(record: AccountRecord, expectedRevision: number): Promise<boolean> {
    const current = this.state.accounts.get(record.id)
    if (!current || current.revision !== expectedRevision) return false
    if (record.revision !== expectedRevision + 1) throw new Error('Account revision must advance by exactly one')
    if (record.usernameKey) {
      const duplicate = await this.getByUsernameKey(record.usernameKey)
      if (duplicate && duplicate.id !== record.id) throw new Error(`Username already exists: ${record.usernameKey}`)
    }
    this.state.accounts.set(record.id, copy(record))
    return true
  }

  async touchLastSeen(id: string, seenAt: Date): Promise<boolean> {
    const account = this.state.accounts.get(id)
    if (!account) return false
    if (seenAt > account.lastSeenAt) account.lastSeenAt = copy(seenAt)
    return true
  }

  async clearShields(now: Date, limit: number): Promise<number> {
    const bounded = Math.max(1, Math.min(1_000, Math.floor(limit)))
    const accounts = [...this.state.accounts.values()]
      .filter(account => account.shieldUntil !== null && account.shieldUntil > now)
      .sort((a, b) => a.shieldUntil!.getTime() - b.shieldUntil!.getTime() || a.id.localeCompare(b.id))
      .slice(0, bounded)
    for (const account of accounts) {
      account.shieldUntil = null
      account.revision += 1
    }
    return accounts.length
  }

  async delete(id: string): Promise<boolean> {
    if (!this.state.accounts.has(id)) return false
    for (const attack of this.state.attacks.values()) {
      if (attack.attackerId === id || attack.defenderId === id) {
        throw new Error(`Account is retained by attack history: ${id}`)
      }
    }
    for (const entry of this.state.balanceLedger.values()) {
      if (entry.playerId === id) throw new Error(`Account is retained by balance history: ${id}`)
    }
    this.state.accounts.delete(id)
    this.state.moderation.delete(id)
    this.state.villages.delete(id)
    for (const [tokenHash, session] of this.state.sessions) {
      if (session.playerId === id) this.state.sessions.delete(tokenHash)
    }
    const plot = this.state.plotsByPlayer.get(id)
    if (plot) {
      this.state.plotsByPlayer.delete(id)
      this.state.plotOccupants.delete(plotKey(plot.worldId, plot.x, plot.y))
    }
    for (const [key, notification] of this.state.notifications) {
      if (notification.playerId === id) this.state.notifications.delete(key)
    }
    for (const marker of this.state.markers.keys()) {
      if (marker.startsWith(`${id}\u0000`)) this.state.markers.delete(marker)
    }
    return true
  }

  async deleteUnreferencedGuests(ids: readonly string[]): Promise<number> {
    let deleted = 0
    for (const id of [...new Set(ids)].slice(0, 500)) {
      const account = this.state.accounts.get(id)
      if (!account || account.registered || this.state.plotsByPlayer.has(id)) continue
      const hasAttack = [...this.state.attacks.values()]
        .some(attack => attack.attackerId === id || attack.defenderId === id)
      const hasLedger = [...this.state.balanceLedger.values()].some(entry => entry.playerId === id)
      if (!hasAttack && !hasLedger && await this.delete(id)) deleted += 1
    }
    return deleted
  }
}

class MemorySessions implements SessionRepository {
  private readonly state: MemoryState

  constructor(state: MemoryState) {
    this.state = state
  }

  async getByTokenHash(tokenHash: string): Promise<SessionRecord | null> {
    const record = this.state.sessions.get(tokenHash)
    return record ? copy(record) : null
  }

  async listForPlayer(playerId: string, limit: number): Promise<SessionRecord[]> {
    const bounded = Math.max(1, Math.min(100, Math.floor(limit)))
    return copy([...this.state.sessions.values()]
      .filter(session => session.playerId === playerId)
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime()
        || a.tokenHash.localeCompare(b.tokenHash))
      .slice(0, bounded))
  }

  async insert(record: SessionRecord): Promise<void> {
    if (!this.state.accounts.has(record.playerId)) throw new Error(`Unknown session owner: ${record.playerId}`)
    if (this.state.sessions.has(record.tokenHash)) throw new Error('Session token already exists')
    this.state.sessions.set(record.tokenHash, copy(record))
  }

  async touch(tokenHash: string, usedAt: Date): Promise<boolean> {
    const record = this.state.sessions.get(tokenHash)
    if (!record) return false
    if (usedAt > record.lastUsedAt) record.lastUsedAt = copy(usedAt)
    return true
  }

  async delete(tokenHash: string): Promise<boolean> {
    return this.state.sessions.delete(tokenHash)
  }

  async deleteForPlayer(playerId: string): Promise<number> {
    let deleted = 0
    for (const [tokenHash, session] of this.state.sessions) {
      if (session.playerId === playerId && this.state.sessions.delete(tokenHash)) deleted += 1
    }
    return deleted
  }
}

class MemoryVillages implements VillageRepository {
  private readonly state: MemoryState

  constructor(state: MemoryState) {
    this.state = state
  }

  async get(playerId: string): Promise<VillageRecord | null> {
    const record = this.state.villages.get(playerId)
    return record ? copy(record) : null
  }

  async insert(record: VillageRecord): Promise<void> {
    if (!this.state.accounts.has(record.playerId)) throw new Error(`Unknown village owner: ${record.playerId}`)
    if (this.state.villages.has(record.playerId)) throw new Error(`Village already exists: ${record.playerId}`)
    this.state.villages.set(record.playerId, copy(record))
  }

  async update(record: VillageRecord, expectedEconomyRevision: number): Promise<boolean> {
    const current = this.state.villages.get(record.playerId)
    if (!current || current.economyRevision !== expectedEconomyRevision) return false
    if (record.economyRevision !== expectedEconomyRevision + 1) {
      throw new Error('Village economy revision must advance by exactly one')
    }
    this.state.villages.set(record.playerId, copy(record))
    return true
  }

  async updateAppearance(record: VillageRecord, expectedAppearanceRevision: number): Promise<boolean> {
    const current = this.state.villages.get(record.playerId)
    if (!current || current.appearanceRevision !== expectedAppearanceRevision) return false
    if (record.appearanceRevision !== expectedAppearanceRevision + 1) {
      throw new Error('Village appearance revision must advance by exactly one')
    }
    current.banner = copy(record.banner)
    current.lastMutationAt = copy(record.lastMutationAt)
    current.appearanceRevision = record.appearanceRevision
    return true
  }
}

class MemoryWorld implements WorldRepository {
  private readonly state: MemoryState

  constructor(state: MemoryState) {
    this.state = state
  }

  async getAllocation(worldId: string): Promise<WorldAllocationRecord | null> {
    const record = this.state.worldAllocations.get(worldId)
    return record ? copy(record) : null
  }

  async insertAllocation(record: WorldAllocationRecord): Promise<void> {
    if (this.state.worldAllocations.has(record.worldId)) {
      throw new Error(`World allocation already exists: ${record.worldId}`)
    }
    this.state.worldAllocations.set(record.worldId, copy(record))
  }

  async updateAllocation(record: WorldAllocationRecord, expectedRevision: number): Promise<boolean> {
    const current = this.state.worldAllocations.get(record.worldId)
    if (!current || current.revision !== expectedRevision) return false
    if (record.revision !== expectedRevision + 1) {
      throw new Error('World allocation revision must advance by exactly one')
    }
    if (record.schemaVersion !== current.schemaVersion || record.regionSize !== current.regionSize) {
      throw new Error('World allocation schema and region size are immutable')
    }
    if (record.nextOrdinal < current.nextOrdinal) return false
    if ((record.allocationModel ?? 1) < (current.allocationModel ?? 1)) return false
    if ((record.botRevisionEpoch ?? 1) < (current.botRevisionEpoch ?? 1)) return false
    this.state.worldAllocations.set(record.worldId, copy(record))
    return true
  }

  async getRegion(worldId: string, regionX: number, regionY: number): Promise<WorldRegionRecord | null> {
    const record = this.state.worldRegions.get(regionKey(worldId, regionX, regionY))
    return record ? copy(record) : null
  }

  async ensureRegion(record: WorldRegionRecord): Promise<'inserted' | 'existing'> {
    const key = regionKey(record.worldId, record.regionX, record.regionY)
    const current = this.state.worldRegions.get(key)
    if (current) {
      if (current.regionId !== record.regionId || current.size !== record.size
        || current.generationVersion !== record.generationVersion) {
        throw new PersistenceConflictError('World region metadata is immutable')
      }
      return 'existing'
    }
    for (const region of this.state.worldRegions.values()) {
      if (region.worldId === record.worldId && region.regionId === record.regionId) {
        throw new PersistenceConflictError('World region id is already assigned')
      }
    }
    this.state.worldRegions.set(key, copy(record))
    return 'inserted'
  }

  async getReleasedSlots(
    worldId: string,
    limit: number,
    options: { excludeOrdinals?: readonly number[] } = {}
  ): Promise<ReleasedWorldPlotRecord[]> {
    const boundedLimit = Math.max(1, Math.min(100_000, Math.floor(limit)))
    const excluded = new Set(options.excludeOrdinals ?? [])
    return copy([...this.state.releasedWorldPlots.values()]
      .filter(slot => slot.worldId === worldId && !excluded.has(slot.ordinal))
      .sort((a, b) => a.ordinal - b.ordinal)
      .slice(0, boundedLimit))
  }

  async getReleasedSlot(worldId: string, ordinal: number): Promise<ReleasedWorldPlotRecord | null> {
    const record = this.state.releasedWorldPlots.get(releasedPlotKey(worldId, ordinal))
    return record ? copy(record) : null
  }

  async putReleasedSlot(record: ReleasedWorldPlotRecord): Promise<void> {
    const key = releasedPlotKey(record.worldId, record.ordinal)
    const current = this.state.releasedWorldPlots.get(key)
    if (!current || current.plotVersion <= record.plotVersion) {
      this.state.releasedWorldPlots.set(key, copy(record))
    }
  }

  async deleteReleasedSlots(worldId: string, ordinals: readonly number[]): Promise<number> {
    let deleted = 0
    for (const ordinal of new Set(ordinals)) {
      if (this.state.releasedWorldPlots.delete(releasedPlotKey(worldId, ordinal))) deleted += 1
    }
    return deleted
  }

  async getPlayerPlot(playerId: string): Promise<WorldPlotRecord | null> {
    const record = this.state.plotsByPlayer.get(playerId)
    return record ? copy(record) : null
  }

  async getOccupant(worldId: string, x: number, y: number): Promise<WorldPlotRecord | null> {
    const playerId = this.state.plotOccupants.get(plotKey(worldId, x, y))
    return playerId ? this.getPlayerPlot(playerId) : null
  }

  async listOccupantsAt(
    worldId: string,
    rawCoordinates: readonly { x: number; y: number }[]
  ): Promise<WorldPlotRecord[]> {
    const coordinates = boundWorldOccupancyBatch(rawCoordinates)
    const occupants: WorldPlotRecord[] = []
    for (const coordinate of coordinates) {
      const playerId = this.state.plotOccupants.get(plotKey(worldId, coordinate.x, coordinate.y))
      if (!playerId) continue
      const plot = this.state.plotsByPlayer.get(playerId)
      if (plot) occupants.push(plot)
    }
    return copy(occupants)
  }

  async getBotVillage(id: string): Promise<BotVillageRecord | null> {
    const record = this.state.botVillages.get(id)
    return record ? copy(record) : null
  }

  async getBotVillageAt(worldId: string, x: number, y: number): Promise<BotVillageRecord | null> {
    const id = this.state.botVillageIdsByPlot.get(plotKey(worldId, x, y))
    return id ? this.getBotVillage(id) : null
  }

  async listBotVillages(input: WorldAtlasQuery): Promise<BotVillageRecord[]> {
    const query = boundWorldAtlasQuery(input)
    return copy([...this.state.botVillages.values()]
      .filter(record => record.worldId === query.worldId
        && record.x >= query.minX && record.x <= query.maxX
        && record.y >= query.minY && record.y <= query.maxY)
      .sort((left, right) => left.y - right.y || left.x - right.x || left.id.localeCompare(right.id))
      .slice(0, query.limit))
  }

  async insertBotVillage(record: BotVillageRecord): Promise<'inserted' | 'existing'> {
    assertBotVillageRecord(record)
    const coordinateKey = plotKey(record.worldId, record.x, record.y)
    if (this.state.plotOccupants.has(coordinateKey)) {
      throw new PersistenceConflictError('A player already occupies that bot village coordinate')
    }
    const currentById = this.state.botVillages.get(record.id)
    const currentIdAtPlot = this.state.botVillageIdsByPlot.get(coordinateKey)
    if (currentById || currentIdAtPlot) {
      const current = currentById ?? this.state.botVillages.get(currentIdAtPlot!)
      if (current && current.id === record.id && sameBotVillageProvision(current, record)) return 'existing'
      throw new PersistenceConflictError('Bot village identity or coordinate already exists with different data')
    }
    this.state.botVillages.set(record.id, copy(record))
    this.state.botVillageIdsByPlot.set(coordinateKey, record.id)
    return 'inserted'
  }

  async provisionBotVillages(rawRecords: readonly BotVillageRecord[]): Promise<void> {
    const records = boundBotVillageProvisionBatch(rawRecords)
    for (const record of records) {
      assertBotVillageRecord(record)
      const coordinateKey = plotKey(record.worldId, record.x, record.y)
      if (this.state.plotOccupants.has(coordinateKey)) continue
      const currentById = this.state.botVillages.get(record.id)
      const currentIdAtPlot = this.state.botVillageIdsByPlot.get(coordinateKey)
      const current = currentById ?? (currentIdAtPlot
        ? this.state.botVillages.get(currentIdAtPlot)
        : undefined)
      if (!current) {
        this.state.botVillages.set(record.id, copy(record))
        this.state.botVillageIdsByPlot.set(coordinateKey, record.id)
        continue
      }
      if (current.id !== record.id || current.worldId !== record.worldId
        || current.x !== record.x || current.y !== record.y || current.seed !== record.seed
        || current.plotVersion !== record.plotVersion
        || current.worldGenerationVersion !== record.worldGenerationVersion) {
        throw new PersistenceConflictError('Bot village identity or coordinate already exists with different provenance')
      }
      if (record.generatorVersion === current.generatorVersion) continue
      if (record.generatorVersion < current.generatorVersion) continue
      if (record.revision !== current.revision + 1
        || record.createdAt.getTime() !== current.createdAt.getTime()) {
        throw new PersistenceConflictError('Bot village generator upgrade lost its revision fence')
      }
      this.state.botVillages.set(record.id, copy(record))
    }
  }

  async updateBotVillage(record: BotVillageRecord, expectedRevision: number): Promise<boolean> {
    assertBotVillageRecord(record)
    const current = this.state.botVillages.get(record.id)
    if (!current || current.revision !== expectedRevision) return false
    if (record.revision !== expectedRevision + 1) {
      throw new Error('Bot village revision must advance by exactly one')
    }
    if (record.worldId !== current.worldId || record.x !== current.x || record.y !== current.y
      || record.plotVersion !== current.plotVersion
      || record.worldGenerationVersion !== current.worldGenerationVersion
      || record.generatorVersion !== current.generatorVersion || record.seed !== current.seed
      || record.createdAt.getTime() !== current.createdAt.getTime()) {
      throw new Error('Bot village identity, coordinate and generator provenance are immutable')
    }
    this.state.botVillages.set(record.id, copy(record))
    return true
  }

  async deleteBotVillage(id: string): Promise<boolean> {
    const current = this.state.botVillages.get(id)
    if (!current) return false
    this.state.botVillages.delete(id)
    this.state.botVillageIdsByPlot.delete(plotKey(current.worldId, current.x, current.y))
    return true
  }

  async listAtlas(input: WorldAtlasQuery): Promise<WorldAtlasEntry[]> {
    const query = boundWorldAtlasQuery(input)
    const entries: WorldAtlasEntry[] = []
    for (const plot of this.state.plotsByPlayer.values()) {
      if (plot.worldId !== query.worldId || plot.x < query.minX || plot.x > query.maxX
        || plot.y < query.minY || plot.y > query.maxY
        || (plot.leaseExpiresAt !== null && plot.leaseExpiresAt <= query.now)) continue
      const account = this.state.accounts.get(plot.playerId)
      const village = this.state.villages.get(plot.playerId)
      if (!account || !village) continue
      entries.push({
        plot,
        player: playerSummary(account),
        village: publicVillage(village),
        accountCreatedAt: account.createdAt,
        simulation: {
          gold: village.gold,
          ore: village.ore,
          food: village.food,
          productionRemainders: village.productionRemainders,
          economyRevision: village.economyRevision
        }
      })
    }
    entries.sort((a, b) => a.plot.y - b.plot.y || a.plot.x - b.plot.x || a.plot.playerId.localeCompare(b.plot.playerId))
    return copy(entries.slice(0, query.limit))
  }

  async listPlayers(input: WorldAtlasQuery): Promise<WorldPlayerEntry[]> {
    const query = boundWorldAtlasQuery(input)
    const entries: WorldPlayerEntry[] = []
    for (const plot of this.state.plotsByPlayer.values()) {
      if (plot.worldId !== query.worldId || plot.x < query.minX || plot.x > query.maxX
        || plot.y < query.minY || plot.y > query.maxY
        || (plot.leaseExpiresAt !== null && plot.leaseExpiresAt <= query.now)) continue
      const account = this.state.accounts.get(plot.playerId)
      const village = this.state.villages.get(plot.playerId)
      if (account && village) entries.push({
        plot,
        player: playerSummary(account),
        banner: village.banner
      })
    }
    entries.sort((a, b) => a.plot.y - b.plot.y || a.plot.x - b.plot.x
      || a.plot.playerId.localeCompare(b.plot.playerId))
    return copy(entries.slice(0, query.limit))
  }

  async listPlayersGlobal(input: WorldPlayerDirectoryQuery): Promise<WorldPlayerEntry[]> {
    const query = boundWorldPlayerDirectoryQuery(input)
    const entries: WorldPlayerEntry[] = []
    for (const plot of this.state.plotsByPlayer.values()) {
      if (plot.worldId !== query.worldId
        || (plot.leaseExpiresAt !== null && plot.leaseExpiresAt <= query.now)) continue
      const account = this.state.accounts.get(plot.playerId)
      const village = this.state.villages.get(plot.playerId)
      if (account && village) entries.push({
        plot,
        player: playerSummary(account),
        banner: village.banner
      })
    }
    entries.sort((left, right) => {
      const leftDistance = Math.max(
        Math.abs(left.plot.x - query.centerX),
        Math.abs(left.plot.y - query.centerY)
      )
      const rightDistance = Math.max(
        Math.abs(right.plot.x - query.centerX),
        Math.abs(right.plot.y - query.centerY)
      )
      return leftDistance - rightDistance
        || left.plot.y - right.plot.y
        || left.plot.x - right.plot.x
        || left.plot.playerId.localeCompare(right.plot.playerId)
    })
    return copy(entries.slice(0, query.limit))
  }

  async claimExpiredGuestAccountIds(worldId: string, now: Date, limit: number): Promise<string[]> {
    const boundedLimit = Math.max(1, Math.min(1_000, Math.floor(limit)))
    return [...this.state.plotsByPlayer.values()]
      .filter(plot => plot.worldId === worldId && plot.leaseExpiresAt !== null && plot.leaseExpiresAt <= now
        && this.state.accounts.get(plot.playerId)?.registered === false)
      .sort((a, b) => a.leaseExpiresAt!.getTime() - b.leaseExpiresAt!.getTime()
        || a.playerId.localeCompare(b.playerId))
      .slice(0, boundedLimit * 4)
      .map(plot => plot.playerId)
      .sort((a, b) => a.localeCompare(b))
      .slice(0, boundedLimit)
  }

  async assign(record: WorldPlotRecord): Promise<void> {
    if (!this.state.accounts.has(record.playerId)) throw new Error(`Unknown plot owner: ${record.playerId}`)
    if (this.state.plotsByPlayer.has(record.playerId)) throw new Error(`Player already has a plot: ${record.playerId}`)
    const region = [...this.state.worldRegions.values()]
      .find(item => item.worldId === record.worldId && item.regionId === record.regionId)
    if (!region) throw new Error(`Unknown world region: ${record.worldId}/${record.regionId}`)
    if (Math.floor(record.x / region.size) !== region.regionX
      || Math.floor(record.y / region.size) !== region.regionY) {
      throw new Error('Plot coordinate does not belong to its generation-pinned region')
    }
    const leaseFields = [record.leaseId, record.leaseIssuedAt, record.leaseRenewedAt, record.leaseExpiresAt]
    const permanent = leaseFields.every(value => value === null)
    const guest = leaseFields.every(value => value !== null)
    if (!permanent && !guest) throw new Error('Guest plot lease fields must be supplied together')
    if (guest && (record.leaseIssuedAt! > record.leaseRenewedAt!
      || record.leaseRenewedAt! >= record.leaseExpiresAt!)) {
      throw new Error('Guest plot lease timestamps are inconsistent')
    }
    if (record.leaseId) {
      for (const plot of this.state.plotsByPlayer.values()) {
        if (plot.leaseId === record.leaseId) throw new Error(`Guest plot lease already exists: ${record.leaseId}`)
      }
    }
    const key = plotKey(record.worldId, record.x, record.y)
    if (this.state.plotOccupants.has(key)) throw new Error(`Plot is occupied: ${record.worldId}/${record.x}/${record.y}`)
    this.state.plotsByPlayer.set(record.playerId, copy(record))
    this.state.plotOccupants.set(key, record.playerId)
    this.state.releasedWorldPlots.delete(releasedPlotKey(
      record.worldId,
      allocationOrdinalOf({ x: record.x, y: record.y })
    ))
  }

  async renewGuestLease(
    playerId: string,
    leaseId: string,
    renewedAt: Date,
    expiresAt: Date
  ): Promise<boolean> {
    const record = this.state.plotsByPlayer.get(playerId)
    if (!record || record.leaseId !== leaseId || record.leaseExpiresAt === null
      || record.leaseExpiresAt <= renewedAt || expiresAt <= renewedAt) return false
    if (record.leaseRenewedAt === null || renewedAt > record.leaseRenewedAt) {
      record.leaseRenewedAt = copy(renewedAt)
    }
    if (expiresAt > record.leaseExpiresAt) record.leaseExpiresAt = copy(expiresAt)
    return true
  }

  async promoteGuestLease(playerId: string, leaseId: string, now: Date): Promise<boolean> {
    const record = this.state.plotsByPlayer.get(playerId)
    if (!record || record.leaseId !== leaseId || record.leaseExpiresAt === null || record.leaseExpiresAt <= now) {
      return false
    }
    record.leaseId = null
    record.leaseIssuedAt = null
    record.leaseRenewedAt = null
    record.leaseExpiresAt = null
    return true
  }

  async release(playerId: string): Promise<boolean> {
    const record = this.state.plotsByPlayer.get(playerId)
    if (!record) return false
    this.state.plotsByPlayer.delete(playerId)
    this.state.plotOccupants.delete(plotKey(record.worldId, record.x, record.y))
    return true
  }
}

function assertAttackLeaseAvailable(state: MemoryState, incoming: AttackRecord, ignoreId?: string): void {
  if (!ACTIVE_ATTACK_STATES.has(incoming.state)) return
  for (const attack of state.attacks.values()) {
    if (attack.id === ignoreId) continue
    if (!ACTIVE_ATTACK_STATES.has(attack.state)) continue
    if (attack.attackerId === incoming.attackerId) throw new Error('Attacker already has an active attack')
    if (incoming.targetKind === 'player' && attack.targetKind === 'player'
      && DEFENDER_LEASE_STATES.has(incoming.state) && DEFENDER_LEASE_STATES.has(attack.state)
      && attack.defenderId === incoming.defenderId) {
      throw new Error('Defender already has an active attack lease')
    }
  }
}

function memoryCommandMatches(existing: AttackCommandRecord, incoming: AttackCommandRecord): boolean {
  return existing.attackId === incoming.attackId
    && existing.sequence === incoming.sequence
    && existing.actorId === incoming.actorId
    && existing.commandId === incoming.commandId
    && existing.commandType === incoming.commandType
    && isDeepStrictEqual(existing.payload, incoming.payload)
}

function findMemoryCommand(state: MemoryState, record: AttackCommandRecord): AttackCommandRecord | undefined {
  const bySequence = state.commandsBySequence.get(tupleKey(record.attackId, record.sequence))
  const commandSequenceKey = state.commandIds.get(tupleKey(record.attackId, record.commandId))
  const byCommandId = commandSequenceKey ? state.commandsBySequence.get(commandSequenceKey) : undefined
  if (bySequence && byCommandId && bySequence === byCommandId) return bySequence
  return bySequence ?? byCommandId
}

class MemoryAttacks implements AttackRepository {
  private readonly state: MemoryState

  constructor(state: MemoryState) {
    this.state = state
  }

  async get(id: string): Promise<AttackRecord | null> {
    const record = this.state.attacks.get(id)
    return record ? copy(record) : null
  }

  async findCandidates(input: AttackCandidateQuery): Promise<AttackCandidateRecord[]> {
    const query = boundAttackCandidateQuery(input)
    const minTrophies = query.targetTrophies - query.trophyRadius
    const maxTrophies = query.targetTrophies + query.trophyRadius
    const leasedDefenders = new Set([...this.state.attacks.values()]
      .filter(attack => attack.targetKind === 'player' && attack.defenderId !== null
        && DEFENDER_LEASE_STATES.has(attack.state))
      .map(attack => attack.defenderId!))
    const candidates: AttackCandidateRecord[] = []
    for (const account of this.state.accounts.values()) {
      if (account.id === query.attackerId || account.trophies < minTrophies || account.trophies > maxTrophies
        || (account.shieldUntil !== null && account.shieldUntil > query.now)) continue
      const plot = this.state.plotsByPlayer.get(account.id)
      const village = this.state.villages.get(account.id)
      if (!plot || !village || plot.worldId !== query.worldId
        || (plot.leaseExpiresAt !== null && plot.leaseExpiresAt <= query.now)) continue
      if (leasedDefenders.has(account.id)) continue
      candidates.push({
        player: playerSummary(account),
        plot,
        layoutRevision: village.layoutRevision,
        trophyDistance: Math.abs(account.trophies - query.targetTrophies)
      })
    }
    candidates.sort((a, b) => a.trophyDistance - b.trophyDistance
      || b.player.trophies - a.player.trophies
      || a.player.playerId.localeCompare(b.player.playerId))
    return copy(candidates.slice(0, query.limit))
  }

  async listActiveIncoming(defenderId: string, requestedLimit: number): Promise<AttackRecord[]> {
    const limit = boundedLimit(requestedLimit, QUERY_LIMITS.activeAttacks)
    return copy([...this.state.attacks.values()]
      .filter(attack => attack.targetKind === 'player' && attack.defenderId === defenderId
        && ACTIVE_ATTACK_STATES.has(attack.state))
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || b.id.localeCompare(a.id))
      .slice(0, limit))
  }

  async listLeasedIncoming(defenderId: string, requestedLimit: number): Promise<AttackRecord[]> {
    const limit = boundedLimit(requestedLimit, QUERY_LIMITS.activeAttacks)
    return copy([...this.state.attacks.values()]
      .filter(attack => attack.targetKind === 'player' && attack.defenderId === defenderId
        && DEFENDER_LEASE_STATES.has(attack.state))
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || b.id.localeCompare(a.id))
      .slice(0, limit))
  }

  async listActiveOutgoing(attackerId: string, requestedLimit: number): Promise<AttackRecord[]> {
    const limit = boundedLimit(requestedLimit, QUERY_LIMITS.activeAttacks)
    return copy([...this.state.attacks.values()]
      .filter(attack => attack.attackerId === attackerId && ACTIVE_ATTACK_STATES.has(attack.state))
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || b.id.localeCompare(a.id))
      .slice(0, limit))
  }

  async claimDue(now: Date, requestedLimit: number): Promise<AttackRecord[]> {
    const limit = boundedLimit(requestedLimit, QUERY_LIMITS.activeAttacks)
    if (!(now instanceof Date) || !Number.isFinite(now.getTime())) throw new RangeError('now must be a valid Date')
    return copy([...this.state.attacks.values()]
      .filter(attack => ACTIVE_ATTACK_STATES.has(attack.state) && attack.deadlineAt <= now)
      .sort((a, b) => a.deadlineAt.getTime() - b.deadlineAt.getTime() || a.id.localeCompare(b.id))
      .slice(0, limit))
  }

  async listActiveForPlayers(playerIds: readonly string[], requestedLimit: number): Promise<AttackRecord[]> {
    const query = boundAttackPlayerBatch(playerIds, requestedLimit)
    if (query.playerIds.length === 0) return []
    const participants = new Set(query.playerIds)
    return copy([...this.state.attacks.values()]
      .filter(attack => ACTIVE_ATTACK_STATES.has(attack.state)
        && (participants.has(attack.attackerId)
          || (attack.defenderId !== null && participants.has(attack.defenderId))))
      .sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime()
        || right.id.localeCompare(left.id))
      .slice(0, query.limit))
  }

  async listLeasedIncomingForDefenders(
    defenderIds: readonly string[],
    requestedLimit: number
  ): Promise<AttackRecord[]> {
    const query = boundAttackPlayerBatch(defenderIds, requestedLimit)
    if (query.playerIds.length === 0) return []
    const defenders = new Set(query.playerIds)
    return copy([...this.state.attacks.values()]
      .filter(attack => attack.defenderId !== null && defenders.has(attack.defenderId)
        && DEFENDER_LEASE_STATES.has(attack.state))
      .sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime()
        || right.id.localeCompare(left.id))
      .slice(0, query.limit))
  }

  async insert(record: AttackRecord): Promise<void> {
    if (this.state.attacks.has(record.id)) throw new Error(`Attack already exists: ${record.id}`)
    if (!this.state.accounts.has(record.attackerId)
      || (record.defenderId !== null && !this.state.accounts.has(record.defenderId))) {
      throw new Error('Attack references an unknown player')
    }
    if ((record.targetKind === 'player') !== (record.defenderId !== null)
      || (record.targetKind === 'player' && record.targetId !== record.defenderId)) {
      throw new Error('Attack target is inconsistent')
    }
    assertAttackRecordAuthority(record)
    assertAttackLeaseAvailable(this.state, record)
    this.state.attacks.set(record.id, copy(record))
  }

  async compareAndSwapAuthority(write: AttackAuthorityWrite): Promise<boolean> {
    const current = this.state.attacks.get(write.attackId)
    if (!current || !current.authority
      || current.state !== write.expectedState
      || current.stateVersion !== write.expectedVersion) return false
    const next = attackRecordWithAuthority(current, write.authority, write.updatedAt, { replacing: true })
    if (!DEFENDER_LEASE_STATES.has(current.state) && DEFENDER_LEASE_STATES.has(next.state)) {
      assertAttackLeaseAvailable(this.state, next, current.id)
    }
    this.state.attacks.set(current.id, copy(next))
    return true
  }

  async commitAuthorityCommand(write: AttackAuthorityCommandWrite): Promise<'inserted' | 'duplicate'> {
    const current = this.state.attacks.get(write.attackId)
    if (!current) throw new Error(`Unknown attack: ${write.attackId}`)
    const existing = findMemoryCommand(this.state, write.command)
    if (existing) {
      if (memoryCommandMatches(existing, write.command)
        && current.authority
        && isDeepStrictEqual(current.authority, write.authority)) return 'duplicate'
      throw new PersistenceConflictError('Attack command id was reused with different content or authority')
    }
    if (!current.authority
      || current.state !== write.expectedState
      || current.stateVersion !== write.expectedVersion) {
      throw new PersistenceConflictError('Attack authority compare-and-swap failed')
    }
    assertAuthorityCommand(write.command, write.authority)
    const next = attackRecordWithAuthority(current, write.authority, write.updatedAt, { replacing: true })
    if (!DEFENDER_LEASE_STATES.has(current.state) && DEFENDER_LEASE_STATES.has(next.state)) {
      assertAttackLeaseAvailable(this.state, next, current.id)
    }
    const sequenceKey = tupleKey(write.command.attackId, write.command.sequence)
    const commandKey = tupleKey(write.command.attackId, write.command.commandId)
    this.state.commandsBySequence.set(sequenceKey, copy(write.command))
    this.state.commandIds.set(commandKey, sequenceKey)
    this.state.attacks.set(current.id, copy(next))
    return 'inserted'
  }

  async listCommands(input: AttackCommandQuery): Promise<AttackCommandRecord[]> {
    const query = boundAttackCommandQuery(input)
    return copy([...this.state.commandsBySequence.values()]
      .filter(command => command.attackId === query.attackId && command.sequence > query.afterSequence)
      .sort((left, right) => left.sequence - right.sequence)
      .slice(0, query.limit))
  }

  async appendCommand(record: AttackCommandRecord): Promise<'inserted' | 'duplicate'> {
    if (!this.state.attacks.has(record.attackId)) throw new Error(`Unknown attack: ${record.attackId}`)
    const sequenceKey = tupleKey(record.attackId, record.sequence)
    const commandKey = tupleKey(record.attackId, record.commandId)
    const existing = findMemoryCommand(this.state, record)
    if (existing) {
      if (memoryCommandMatches(existing, record)) return 'duplicate'
      throw new PersistenceConflictError('Attack command id was reused with different content')
    }
    this.state.commandsBySequence.set(sequenceKey, copy(record))
    this.state.commandIds.set(commandKey, sequenceKey)
    return 'inserted'
  }

  async settle(record: SettlementRecord): Promise<'inserted' | 'duplicate'> {
    if (!this.state.attacks.has(record.attackId)) throw new Error(`Unknown attack: ${record.attackId}`)
    const existing = this.state.settlements.get(record.attackId)
    if (existing) {
      if (existing.attackerId === record.attackerId && existing.defenderId === record.defenderId
        && isDeepStrictEqual(existing.outcome, record.outcome)) return 'duplicate'
      throw new PersistenceConflictError('Attack settlement was replayed with a different outcome')
    }
    this.state.settlements.set(record.attackId, copy(record))
    return 'inserted'
  }
}

class MemoryReplays implements ReplayRepository {
  private readonly state: MemoryState

  constructor(state: MemoryState) {
    this.state = state
  }

  async append(record: ReplayChunkRecord): Promise<'inserted' | 'duplicate'> {
    if (!this.state.attacks.has(record.attackId)) throw new Error(`Unknown attack: ${record.attackId}`)
    if (record.format === 'presentation-frame-v1') {
      throw new Error('Presentation frames must use appendPresentation so storage is budgeted')
    }
    if ((record.payload === null) === (record.objectKey === null)) {
      throw new Error('Replay chunk must have exactly one payload location')
    }
    const key = tupleKey(record.attackId, record.sequence)
    const current = this.state.replayChunks.get(key)
    if (current) {
      if (isDeepStrictEqual(current, record)) return 'duplicate'
      throw new PersistenceConflictError('Replay chunk sequence was reused with different content')
    }
    this.state.replayChunks.set(key, copy(record))
    return 'inserted'
  }

  async appendPresentation(
    record: ReplayChunkRecord,
    budget: { byteSize: number; maxBytes: number; maxChunks: number }
  ): Promise<'inserted' | 'duplicate' | 'dropped'> {
    if (record.format !== 'presentation-frame-v1' || record.payload === null || record.objectKey !== null) {
      throw new Error('Presentation replay budget accepts only inline presentation-frame-v1 chunks')
    }
    if (!Number.isSafeInteger(budget.byteSize) || budget.byteSize < 0
      || !Number.isSafeInteger(budget.maxBytes) || budget.maxBytes < 1
      || !Number.isSafeInteger(budget.maxChunks) || budget.maxChunks < 1) {
      throw new RangeError('Presentation replay budget is invalid')
    }
    if (!this.state.attacks.has(record.attackId)) throw new Error(`Unknown attack: ${record.attackId}`)
    const key = tupleKey(record.attackId, record.sequence)
    const current = this.state.replayChunks.get(key)
    if (current) {
      if (current.format === record.format && current.checksum === record.checksum
        && isDeepStrictEqual(current.payload, record.payload) && current.objectKey === record.objectKey) return 'duplicate'
      throw new PersistenceConflictError('Replay chunk sequence was reused with different content')
    }
    const usage = this.state.presentationUsage.get(record.attackId) ?? { bytes: 0, chunks: 0 }
    if (budget.byteSize > budget.maxBytes || usage.bytes + budget.byteSize > budget.maxBytes
      || usage.chunks >= budget.maxChunks) return 'dropped'
    this.state.replayChunks.set(key, copy(record))
    this.state.presentationBytes.set(key, budget.byteSize)
    this.state.presentationUsage.set(record.attackId, {
      bytes: usage.bytes + budget.byteSize,
      chunks: usage.chunks + 1
    })
    return 'inserted'
  }

  async listForParticipant(input: ParticipantReplayQuery): Promise<ReplayChunkRecord[]> {
    const query = boundParticipantReplayQuery(input)
    const attack = this.state.attacks.get(query.attackId)
    if (!attack || (attack.attackerId !== query.participantId && attack.defenderId !== query.participantId)) return []
    return copy([...this.state.replayChunks.values()]
      .filter(chunk => chunk.attackId === query.attackId && chunk.sequence > query.afterSequence)
      .sort((a, b) => a.sequence - b.sequence)
      .slice(0, query.limit))
  }

  async prunePresentation(before: Date, requestedLimit: number): Promise<number> {
    if (!(before instanceof Date) || !Number.isFinite(before.getTime())) throw new RangeError('before must be a valid Date')
    const limit = Math.max(1, Math.min(100, Math.floor(requestedLimit)))
    const attackIds = [...this.state.attacks.values()]
      .filter(attack => attack.endedAt !== null && attack.endedAt < before
        && [...this.state.replayChunks.values()].some(chunk => chunk.attackId === attack.id && chunk.format === 'presentation-frame-v1'))
      .sort((a, b) => a.endedAt!.getTime() - b.endedAt!.getTime() || a.id.localeCompare(b.id))
      .slice(0, limit)
      .map(attack => attack.id)
    const selected = new Set(attackIds)
    let deleted = 0
    for (const [key, chunk] of this.state.replayChunks) {
      if (!selected.has(chunk.attackId) || chunk.format !== 'presentation-frame-v1') continue
      this.state.replayChunks.delete(key)
      this.state.presentationBytes.delete(key)
      deleted += 1
    }
    for (const attackId of selected) this.state.presentationUsage.delete(attackId)
    return deleted
  }
}

class MemoryNotifications implements NotificationRepository {
  private readonly state: MemoryState

  constructor(state: MemoryState) {
    this.state = state
  }

  async add(record: NotificationRecord): Promise<'inserted' | 'duplicate'> {
    if (!this.state.accounts.has(record.playerId)) throw new Error(`Unknown notification owner: ${record.playerId}`)
    const key = tupleKey(record.playerId, record.id)
    const current = this.state.notifications.get(key)
    if (current) {
      if (isDeepStrictEqual(current, record)) return 'duplicate'
      throw new PersistenceConflictError('Notification id was reused with different content')
    }
    this.state.notifications.set(key, copy(record))
    const retained = new Set([...this.state.notifications.entries()]
      .filter(([, notification]) => notification.playerId === record.playerId)
      .sort((a, b) => b[1].occurredAt.getTime() - a[1].occurredAt.getTime()
        || b[1].id.localeCompare(a[1].id))
      .slice(0, QUERY_LIMITS.notificationRetention)
      .map(([notificationKey]) => notificationKey))
    for (const [notificationKey, notification] of this.state.notifications) {
      if (notification.playerId === record.playerId && !retained.has(notificationKey)) {
        this.state.notifications.delete(notificationKey)
      }
    }
    return 'inserted'
  }

  async listForPlayer(input: NotificationQuery): Promise<NotificationRecord[]> {
    const query = boundNotificationQuery(input)
    return copy([...this.state.notifications.values()]
      .filter(notification => {
        if (notification.playerId !== query.playerId || (query.unreadOnly && notification.readAt !== null)) return false
        if (!query.before) return true
        const timeDifference = notification.occurredAt.getTime() - query.before.occurredAt.getTime()
        return timeDifference < 0 || (timeDifference === 0 && notification.id < query.before.id)
      })
      .sort((a, b) => b.occurredAt.getTime() - a.occurredAt.getTime() || b.id.localeCompare(a.id))
      .slice(0, query.limit))
  }

  async markAllRead(playerId: string, readAt: Date): Promise<number> {
    let changed = 0
    for (const notification of this.state.notifications.values()) {
      if (notification.playerId === playerId && notification.readAt === null) {
        notification.readAt = copy(readAt)
        changed += 1
      }
    }
    return changed
  }
}

class MemoryIdempotency implements IdempotencyRepository {
  private readonly state: MemoryState

  constructor(state: MemoryState) {
    this.state = state
  }

  async claim(actorId: string, operation: string, requestId: string, now: Date, expiresAt: Date): Promise<IdempotencyClaim> {
    const key = tupleKey(actorId, operation, requestId)
    const current = this.state.idempotency.get(key)
    if (current && current.expiresAt > now) {
      if (current.state === 'in_progress') throw new Error('Idempotent operation is still in progress')
      if (current.response === null) throw new Error('Completed idempotency record has no response')
      return { kind: 'completed', response: copy(current.response) }
    }
    this.state.idempotency.set(key, {
      actorId,
      operation,
      requestId,
      state: 'in_progress',
      response: null,
      createdAt: copy(now),
      expiresAt: copy(expiresAt)
    })
    return { kind: 'claimed' }
  }

  async complete(actorId: string, operation: string, requestId: string, response: JsonValue): Promise<void> {
    const key = tupleKey(actorId, operation, requestId)
    const current = this.state.idempotency.get(key)
    if (!current || current.state !== 'in_progress') throw new Error('Idempotency claim is missing or already complete')
    current.state = 'completed'
    current.response = copy(response)
  }

  async pruneExpired(now: Date, requestedLimit: number): Promise<number> {
    const limit = boundedLimit(requestedLimit, QUERY_LIMITS.idempotencyPrune)
    const expired = [...this.state.idempotency.entries()]
      .filter(([, record]) => record.expiresAt <= now)
      .sort((a, b) => a[1].expiresAt.getTime() - b[1].expiresAt.getTime()
        || a[0].localeCompare(b[0]))
      .slice(0, limit)
    for (const [key] of expired) this.state.idempotency.delete(key)
    return expired.length
  }
}

class MemoryOutbox implements OutboxRepository {
  private readonly state: MemoryState

  constructor(state: MemoryState) {
    this.state = state
  }

  async add(event: Omit<OutboxEventRecord, 'id' | 'publishedAt' | 'attempts' | 'lockedBy' | 'lockedUntil'>): Promise<string> {
    const id = String(++this.state.outboxSequence)
    this.state.outbox.set(id, {
      ...copy(event),
      id,
      publishedAt: null,
      attempts: 0,
      lockedBy: null,
      lockedUntil: null
    })
    return id
  }

  async claimBatch(workerId: string, now: Date, lockedUntil: Date, limit: number): Promise<OutboxEventRecord[]> {
    const available = [...this.state.outbox.values()]
      .filter(event => !event.publishedAt && event.availableAt <= now && (!event.lockedUntil || event.lockedUntil <= now))
      .sort((a, b) => a.availableAt.getTime() - b.availableAt.getTime() || Number(a.id) - Number(b.id))
      .slice(0, Math.max(1, Math.min(500, Math.floor(limit))))
    for (const event of available) {
      event.lockedBy = workerId
      event.lockedUntil = copy(lockedUntil)
      event.attempts += 1
    }
    return copy(available)
  }

  async markPublished(id: string, workerId: string, publishedAt: Date): Promise<boolean> {
    const event = this.state.outbox.get(id)
    if (!event || event.publishedAt || event.lockedBy !== workerId) return false
    event.publishedAt = copy(publishedAt)
    event.lockedBy = null
    event.lockedUntil = null
    return true
  }

  async release(id: string, workerId: string, retryAt: Date): Promise<boolean> {
    const event = this.state.outbox.get(id)
    if (!event || event.publishedAt || event.lockedBy !== workerId) return false
    event.availableAt = copy(retryAt)
    event.lockedBy = null
    event.lockedUntil = null
    return true
  }

  async prune(
    publishedBefore: Date,
    unpublishedBefore: Date,
    now: Date,
    requestedLimit: number
  ): Promise<{ published: number; expired: number }> {
    const limit = boundedLimit(requestedLimit, QUERY_LIMITS.outboxPrune)
    const victims = [...this.state.outbox.values()]
      .filter(event => event.publishedAt
        ? event.publishedAt <= publishedBefore
        : event.createdAt <= unpublishedBefore && (!event.lockedUntil || event.lockedUntil <= now))
      .sort((a, b) => (a.publishedAt ?? a.createdAt).getTime() - (b.publishedAt ?? b.createdAt).getTime()
        || Number(a.id) - Number(b.id))
      .slice(0, limit)
    let published = 0
    let expired = 0
    for (const event of victims) {
      this.state.outbox.delete(event.id)
      if (event.publishedAt) published += 1
      else expired += 1
    }
    return { published, expired }
  }
}

class MemoryOperationMarkers implements OperationMarkerRepository {
  private readonly state: MemoryState

  constructor(state: MemoryState) {
    this.state = state
  }

  async add(playerId: string, kind: string, markerKey: string, observedAt: Date): Promise<void> {
    if (!this.state.accounts.has(playerId)) throw new Error(`Unknown marker owner: ${playerId}`)
    const key = tupleKey(playerId, kind, markerKey)
    if (!this.state.markers.has(key)) this.state.markers.set(key, copy(observedAt))
  }

  async has(playerId: string, kind: string, markerKey: string): Promise<boolean> {
    return this.state.markers.has(tupleKey(playerId, kind, markerKey))
  }

  async pruneBefore(before: Date, requestedLimit: number): Promise<number> {
    const limit = boundedLimit(requestedLimit, QUERY_LIMITS.operationMarkerPrune)
    const victims = [...this.state.markers.entries()]
      .filter(([, observedAt]) => observedAt < before)
      .sort((a, b) => a[1].getTime() - b[1].getTime() || a[0].localeCompare(b[0]))
      .slice(0, limit)
    for (const [key] of victims) this.state.markers.delete(key)
    return victims.length
  }
}

class MemoryBalanceLedger implements BalanceLedgerRepository {
  private readonly state: MemoryState

  constructor(state: MemoryState) {
    this.state = state
  }

  async append(record: BalanceLedgerRecord): Promise<'inserted' | 'duplicate'> {
    if (!this.state.accounts.has(record.playerId)) throw new Error(`Unknown ledger owner: ${record.playerId}`)
    const key = tupleKey(record.playerId, record.operation, record.requestId, record.currency)
    const existing = this.state.balanceLedger.get(key)
    if (existing) {
      if (existing.playerId === record.playerId && existing.operation === record.operation
        && existing.requestId === record.requestId && existing.currency === record.currency
        && existing.delta === record.delta && existing.balanceAfter === record.balanceAfter
        && isDeepStrictEqual(existing.metadata, record.metadata)) return 'duplicate'
      throw new PersistenceConflictError('Balance ledger key was reused with a different effect')
    }
    this.state.balanceLedger.set(key, copy(record))
    return 'inserted'
  }

  async sumSince(
    playerId: string,
    operation: string,
    currency: BalanceLedgerRecord['currency'],
    since: Date
  ): Promise<number> {
    let total = 0
    for (const record of this.state.balanceLedger.values()) {
      if (record.playerId === playerId && record.operation === operation
        && record.currency === currency && record.createdAt >= since) total += record.delta
    }
    return total
  }

  async summarizeDays(fromDay: number, throughDay: number): Promise<BalanceLedgerDaySummary[]> {
    const rows = new Map<string, BalanceLedgerDaySummary & { requests: Set<string> }>()
    for (const record of this.state.balanceLedger.values()) {
      const day = Math.floor(record.createdAt.getTime() / 86_400_000)
      if (day < fromDay || day > throughDay) continue
      const key = tupleKey(day, record.operation, record.currency)
      let row = rows.get(key)
      if (!row) {
        row = {
          day,
          operation: record.operation,
          currency: record.currency,
          positive: 0,
          negative: 0,
          operationCount: 0,
          requests: new Set()
        }
        rows.set(key, row)
      }
      if (record.delta > 0) row.positive += record.delta
      if (record.delta < 0) row.negative += -record.delta
      row.requests.add(tupleKey(record.playerId, record.requestId))
    }
    return copy([...rows.values()].map(({ requests, ...row }) => ({
      ...row,
      operationCount: requests.size
    })))
  }
}

function effectiveModeration(
  record: AccountModerationRecord | undefined,
  now: Date
): Pick<AdminPlayerRecord, 'accessState' | 'accessReason' | 'accessUntil' | 'moderationUpdatedAt'> {
  if (!record || record.state === 'active'
    || (record.state === 'suspended' && record.until !== null && record.until <= now)) {
    return {
      accessState: 'active',
      accessReason: null,
      accessUntil: null,
      moderationUpdatedAt: record?.updatedAt ?? null
    }
  }
  return {
    accessState: record.state,
    accessReason: record.reason,
    accessUntil: record.until,
    moderationUpdatedAt: record.updatedAt
  }
}

class MemoryAdmin implements AdminRepository {
  private readonly state: MemoryState

  constructor(state: MemoryState) {
    this.state = state
  }

  async overview(now: Date, onlineSince: Date): Promise<AdminOverviewRecord> {
    const accounts = [...this.state.accounts.values()]
    const villages = [...this.state.villages.values()]
    const attacks = [...this.state.attacks.values()]
    let suspendedPlayers = 0
    let bannedPlayers = 0
    for (const moderation of this.state.moderation.values()) {
      const effective = effectiveModeration(moderation, now).accessState
      if (effective === 'suspended') suspendedPlayers += 1
      if (effective === 'banned') bannedPlayers += 1
    }
    const byState = (state: AttackState) => attacks.filter(attack => attack.state === state).length
    return {
      players: accounts.length,
      registeredPlayers: accounts.filter(account => account.registered).length,
      onlinePlayers: accounts.filter(account => account.lastSeenAt >= onlineSince).length,
      playerVillages: villages.length,
      botVillages: this.state.botVillages.size,
      preparingAttacks: byState('preparing'),
      engagedAttacks: byState('engaged'),
      activeAttacks: byState('active'),
      finalizingAttacks: byState('finalizing'),
      totalGold: villages.reduce((sum, village) => sum + village.gold, 0),
      totalOre: villages.reduce((sum, village) => sum + village.ore, 0),
      totalFood: villages.reduce((sum, village) => sum + village.food, 0),
      averageTrophies: accounts.length === 0
        ? 0
        : accounts.reduce((sum, account) => sum + account.trophies, 0) / accounts.length,
      suspendedPlayers,
      bannedPlayers
    }
  }

  private player(account: AccountRecord, now: Date): AdminPlayerRecord {
    const village = this.state.villages.get(account.id)
    const plot = this.state.plotsByPlayer.get(account.id)
    const moderation = effectiveModeration(this.state.moderation.get(account.id), now)
    return {
      id: account.id,
      username: account.username,
      registered: account.registered,
      trophies: account.trophies,
      shieldUntil: account.shieldUntil,
      createdAt: account.createdAt,
      lastSeenAt: account.lastSeenAt,
      profileRevision: account.revision,
      ...moderation,
      worldId: plot?.worldId ?? null,
      x: plot?.x ?? null,
      y: plot?.y ?? null,
      plotVersion: plot?.plotVersion ?? null,
      gold: village?.gold ?? 0,
      ore: village?.ore ?? 0,
      food: village?.food ?? 0,
      economyRevision: village?.economyRevision ?? 0,
      layoutRevision: village?.layoutRevision ?? 0,
      appearanceRevision: village?.appearanceRevision ?? 0,
      buildings: village?.buildings.length ?? 0,
      obstacles: village?.obstacles.length ?? 0,
      army: copy(village?.army ?? {}),
      population: copy(village?.population ?? {}),
      activeSessions: [...this.state.sessions.values()]
        .filter(session => session.playerId === account.id && session.expiresAt > now).length,
      activeAttacks: [...this.state.attacks.values()]
        .filter(attack => ACTIVE_ATTACK_STATES.has(attack.state)
          && (attack.attackerId === account.id || attack.defenderId === account.id)).length
    }
  }

  async listPlayers(rawQuery: AdminPlayerQuery): Promise<AdminPlayerRecord[]> {
    const query = boundAdminPlayerQuery(rawQuery)
    const search = query.search.trim().toLocaleLowerCase('en-US')
    return copy([...this.state.accounts.values()]
      .filter(account => !search
        || account.id.toLocaleLowerCase('en-US').includes(search)
        || account.username.toLocaleLowerCase('en-US').includes(search))
      .sort((a, b) => b.lastSeenAt.getTime() - a.lastSeenAt.getTime() || a.id.localeCompare(b.id))
      .slice(0, query.limit)
      .map(account => this.player(account, query.now)))
  }

  async getPlayer(playerId: string, now: Date): Promise<AdminPlayerRecord | null> {
    const account = this.state.accounts.get(playerId)
    return account ? copy(this.player(account, now)) : null
  }

  async isUsernameTaken(usernameKey: string, excludingPlayerId: string): Promise<boolean> {
    return [...this.state.accounts.values()].some(account => account.id !== excludingPlayerId
      && account.username.trim().toLocaleLowerCase('en-US') === usernameKey)
  }

  async listAttacks(rawQuery: AdminAttackQuery): Promise<AttackRecord[]> {
    const query = boundAdminAttackQuery(rawQuery)
    return copy([...this.state.attacks.values()]
      .filter(attack => query.state === null || attack.state === query.state)
      .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime() || b.id.localeCompare(a.id))
      .slice(0, query.limit))
  }

  async getModeration(playerId: string): Promise<AccountModerationRecord | null> {
    const record = this.state.moderation.get(playerId)
    return record ? copy(record) : null
  }

  async upsertModeration(record: AccountModerationRecord, expectedRevision: number | null): Promise<boolean> {
    if (!this.state.accounts.has(record.playerId)) throw new Error(`Unknown moderation target: ${record.playerId}`)
    const current = this.state.moderation.get(record.playerId)
    if (expectedRevision === null) {
      if (current) return false
      if (record.revision !== 1) throw new Error('Initial moderation revision must be one')
    } else {
      if (!current || current.revision !== expectedRevision) return false
      if (record.revision !== expectedRevision + 1) throw new Error('Moderation revision must advance by one')
    }
    this.state.moderation.set(record.playerId, copy(record))
    return true
  }

  async getConfig(): Promise<AdminRuntimeConfigRecord> {
    return copy(this.state.adminConfig)
  }

  async updateConfig(record: AdminRuntimeConfigRecord, expectedRevision: number): Promise<boolean> {
    if (this.state.adminConfig.revision !== expectedRevision) return false
    if (record.revision !== expectedRevision + 1) throw new Error('Admin config revision must advance by one')
    this.state.adminConfig = copy(record)
    return true
  }

  async listAudit(requestedLimit: number): Promise<AdminAuditRecord[]> {
    const limit = boundedLimit(requestedLimit, QUERY_LIMITS.adminAudit)
    return copy([...this.state.adminAudit.values()]
      .sort((a, b) => b.occurredAt.getTime() - a.occurredAt.getTime() || b.id.localeCompare(a.id))
      .slice(0, limit))
  }

  async appendAudit(record: AdminAuditRecord): Promise<void> {
    if (this.state.adminAudit.has(record.id)) throw new Error(`Admin audit id already exists: ${record.id}`)
    this.state.adminAudit.set(record.id, copy(record))
  }

  async resetAllBases(starter: VillageRecord, starterShieldUntil: Date): Promise<AdminBaseResetRecord> {
    const incompleteAccounts = [...this.state.accounts.values()].filter(account => (
      !this.state.villages.has(account.id) || !this.state.plotsByPlayer.has(account.id)
    )).length
    const orphanBotWorlds = new Set(
      [...this.state.botVillages.values()]
        .filter(bot => !this.state.worldAllocations.has(bot.worldId))
        .map(bot => bot.worldId)
    ).size
    if (incompleteAccounts > 0 || orphanBotWorlds > 0) {
      throw new AdminBaseResetPreconditionError(incompleteAccounts, orphanBotWorlds)
    }
    const accountsPreserved = this.state.accounts.size
    const sessionsPreserved = this.state.sessions.size
    const playerPlotsPreserved = this.state.plotsByPlayer.size
    const botVillagesPurged = this.state.botVillages.size
    const attacksPurged = this.state.attacks.size
    const combatRecordsPurged = attacksPurged
      + this.state.commandsBySequence.size
      + this.state.settlements.size
      + this.state.replayChunks.size
      + this.state.presentationUsage.size
    const notificationsPurged = this.state.notifications.size
    const economyRecordsPurged = this.state.balanceLedger.size
    const auxiliaryRecordsPurged = this.state.idempotency.size
      + this.state.outbox.size
      + this.state.markers.size

    const highestBotRevisionByWorld = new Map<string, number>()
    for (const bot of this.state.botVillages.values()) {
      highestBotRevisionByWorld.set(
        bot.worldId,
        Math.max(highestBotRevisionByWorld.get(bot.worldId) ?? 0, bot.revision)
      )
    }
    for (const [worldId, current] of this.state.worldAllocations) {
      const allocation = copy(current)
      allocation.botRevisionEpoch = Math.max(
        allocation.botRevisionEpoch ?? 1,
        highestBotRevisionByWorld.get(worldId) ?? 0
      ) + 1
      allocation.revision += 1
      allocation.updatedAt = new Date(starter.lastMutationAt)
      this.state.worldAllocations.set(worldId, allocation)
    }

    for (const [playerId, currentAccount] of this.state.accounts) {
      const account = copy(currentAccount)
      const previous = this.state.villages.get(playerId)
      const resetRevision = Math.max(
        account.revision,
        previous?.layoutRevision ?? 0,
        previous?.appearanceRevision ?? 0,
        previous?.economyRevision ?? 0
      ) + 1
      account.trophies = 0
      account.shieldUntil = new Date(starterShieldUntil)
      account.revengeRights = {}
      account.botRaidCooldowns = {}
      account.revision = resetRevision
      this.state.accounts.set(playerId, account)
      const buildings = starter.buildings.map((building, index) => {
        if (!building || typeof building !== 'object' || Array.isArray(building)) return copy(building)
        const sourceId = typeof building.id === 'string' ? building.id : String(index)
        const digest = createHash('sha256')
          .update(`${playerId}\u0000${starter.playerId}\u0000${sourceId}\u0000${index}`)
          .digest('hex')
          .slice(0, 24)
        return { ...copy(building), id: `b_${digest}` }
      })
      this.state.villages.set(playerId, {
        ...copy(starter),
        playerId,
        buildings,
        banner: null,
        layoutRevision: resetRevision,
        appearanceRevision: resetRevision,
        economyRevision: resetRevision
      })
    }

    this.state.botVillages.clear()
    this.state.botVillageIdsByPlot.clear()
    this.state.attacks.clear()
    this.state.commandsBySequence.clear()
    this.state.commandIds.clear()
    this.state.settlements.clear()
    this.state.replayChunks.clear()
    this.state.presentationBytes.clear()
    this.state.presentationUsage.clear()
    this.state.notifications.clear()
    this.state.idempotency.clear()
    this.state.outbox.clear()
    this.state.markers.clear()
    this.state.balanceLedger.clear()

    return {
      accountsPreserved,
      sessionsPreserved,
      playerPlotsPreserved,
      playerVillagesReset: accountsPreserved,
      botVillagesPurged,
      attacksPurged,
      combatRecordsPurged,
      notificationsPurged,
      economyRecordsPurged,
      auxiliaryRecordsPurged
    }
  }
}

class MemoryUnitOfWork implements UnitOfWork {
  readonly accounts: AccountRepository
  readonly sessions: SessionRepository
  readonly villages: VillageRepository
  readonly world: WorldRepository
  readonly attacks: AttackRepository
  readonly replays: ReplayRepository
  readonly notifications: NotificationRepository
  readonly idempotency: IdempotencyRepository
  readonly outbox: OutboxRepository
  readonly operationMarkers: OperationMarkerRepository
  readonly balanceLedger: BalanceLedgerRepository
  readonly admin: AdminRepository

  constructor(state: MemoryState) {
    this.accounts = new MemoryAccounts(state)
    this.sessions = new MemorySessions(state)
    this.villages = new MemoryVillages(state)
    this.world = new MemoryWorld(state)
    this.attacks = new MemoryAttacks(state)
    this.replays = new MemoryReplays(state)
    this.notifications = new MemoryNotifications(state)
    this.idempotency = new MemoryIdempotency(state)
    this.outbox = new MemoryOutbox(state)
    this.operationMarkers = new MemoryOperationMarkers(state)
    this.balanceLedger = new MemoryBalanceLedger(state)
    this.admin = new MemoryAdmin(state)
  }
}

/**
 * Hermetic transaction implementation for tests and local tools. Transactions
 * are serialized and copy-on-write, so a thrown callback leaves no partial state.
 */
export class MemoryPersistence implements Persistence {
  private state = emptyState()
  private gate: Promise<void> = Promise.resolve()
  private closed = false

  async transaction<T>(work: (tx: UnitOfWork) => Promise<T>): Promise<T> {
    if (this.closed) throw new Error('Persistence is closed')
    const previous = this.gate
    let unlock: (() => void) | undefined
    this.gate = new Promise<void>(resolve => { unlock = resolve })
    await previous
    try {
      const draft = copy(this.state)
      const result = await work(new MemoryUnitOfWork(draft))
      this.state = draft
      return result
    } finally {
      unlock?.()
    }
  }

  async close(): Promise<void> {
    await this.gate
    this.closed = true
  }
}
