import type { QueryResultRow } from 'pg'
import type {
  AccountRecord,
  AttackAuthorityCommandWrite,
  AttackAuthorityWrite,
  AttackCandidateQuery,
  AttackCandidateRecord,
  BalanceLedgerRecord,
  BalanceLedgerDaySummary,
  AttackCommandRecord,
  AttackCommandQuery,
  AttackRecord,
  AttackState,
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
  VillageRecord,
  WorldAllocationRecord,
  WorldAtlasEntry,
  WorldAtlasQuery,
  WorldPlayerEntry,
  WorldPlotRecord,
  WorldRegionRecord
} from '../model'
import type {
  AccountRepository,
  AttackRepository,
  BalanceLedgerRepository,
  IdempotencyRepository,
  NotificationRepository,
  OperationMarkerRepository,
  OutboxRepository,
  ReplayRepository,
  SessionRepository,
  UnitOfWork,
  VillageRepository,
  WorldRepository
} from '../repositories'
import { PersistenceConflictError } from '../repositories'
import {
  boundAttackCandidateQuery,
  boundAttackCommandQuery,
  boundAttackPlayerBatch,
  boundedLimit,
  boundNotificationQuery,
  boundParticipantReplayQuery,
  boundWorldAtlasQuery,
  boundWorldOccupancyBatch,
  QUERY_LIMITS
} from '../query-bounds'
import type { SqlExecutor } from './database'
import { isDeepStrictEqual } from 'node:util'
import {
  assertAttackRecordAuthority,
  assertAuthorityCommand,
  attackRecordWithAuthority
} from '../attack-authority'
import { allocationOrdinalOf } from '../../domain/world/allocation'

function date(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value)
}

function optionalDate(value: Date | string | null): Date | null {
  return value === null ? null : date(value)
}

interface AccountRow extends QueryResultRow {
  id: string
  username: string
  username_key: string | null
  password_hash: string | null
  registered: boolean
  trophies: number
  shield_until: Date | string | null
  created_at: Date | string
  last_seen_at: Date | string
  revision: string | number
  revenge_rights: JsonObject
  bot_raid_cooldowns: JsonObject
}

function accountFromRow(row: AccountRow): AccountRecord {
  return {
    id: row.id,
    username: row.username,
    usernameKey: row.username_key,
    passwordHash: row.password_hash,
    registered: row.registered,
    trophies: row.trophies,
    shieldUntil: optionalDate(row.shield_until),
    createdAt: date(row.created_at),
    lastSeenAt: date(row.last_seen_at),
    revision: Number(row.revision),
    revengeRights: row.revenge_rights,
    botRaidCooldowns: row.bot_raid_cooldowns
  }
}

interface PlayerSummaryRow extends QueryResultRow {
  player_id: string
  username: string
  trophies: number
  shield_until: Date | string | null
  last_seen_at: Date | string
  revision: string | number
}

function playerSummaryFromRow(row: PlayerSummaryRow): PlayerSummaryRecord {
  return {
    playerId: row.player_id,
    username: row.username,
    trophies: row.trophies,
    shieldUntil: optionalDate(row.shield_until),
    lastSeenAt: date(row.last_seen_at),
    revision: Number(row.revision)
  }
}

const PLAYER_SUMMARY_COLUMNS = String.raw`
  p.player_id, p.username, p.trophies, p.shield_until, p.last_seen_at, p.revision
`

const ACCOUNT_SELECT = String.raw`
  SELECT a.id, a.username_key, a.password_hash, a.registered, a.created_at,
    p.username, p.trophies, p.shield_until, p.last_seen_at, p.revision,
    p.revenge_rights, p.bot_raid_cooldowns
  FROM accounts a JOIN player_profiles p ON p.player_id = a.id
`

class PgAccounts implements AccountRepository {
  private readonly sql: SqlExecutor

  constructor(sql: SqlExecutor) {
    this.sql = sql
  }

  async getById(id: string, options: { forUpdate?: boolean } = {}): Promise<AccountRecord | null> {
    const result = await this.sql.query<AccountRow>(
      `${ACCOUNT_SELECT} WHERE a.id = $1${options.forUpdate ? ' FOR UPDATE OF a, p' : ''}`,
      [id]
    )
    return result.rows[0] ? accountFromRow(result.rows[0]) : null
  }

  async getByUsernameKey(usernameKey: string, options: { forUpdate?: boolean } = {}): Promise<AccountRecord | null> {
    const result = await this.sql.query<AccountRow>(
      `${ACCOUNT_SELECT} WHERE a.username_key = $1${options.forUpdate ? ' FOR UPDATE OF a, p' : ''}`,
      [usernameKey]
    )
    return result.rows[0] ? accountFromRow(result.rows[0]) : null
  }

  async listLeaderboard(query: LeaderboardQuery): Promise<PlayerSummaryRecord[]> {
    const limit = boundedLimit(query.limit, QUERY_LIMITS.leaderboard)
    const result = await this.sql.query<PlayerSummaryRow>(String.raw`
      SELECT ${PLAYER_SUMMARY_COLUMNS}
      FROM player_profiles p
      ORDER BY p.trophies DESC, p.player_id
      LIMIT $1
    `, [limit])
    return result.rows.map(playerSummaryFromRow)
  }

  async listLeaderboardDetails(query: LeaderboardQuery & { now: Date }): Promise<LeaderboardPlayerRecord[]> {
    const limit = boundedLimit(query.limit, QUERY_LIMITS.leaderboard)
    const result = await this.sql.query<PlayerSummaryRow & {
      world_id: string
      x: number
      y: number
      building_count: string | number
    }>(String.raw`
      SELECT ${PLAYER_SUMMARY_COLUMNS}, plot.world_id, plot.x, plot.y,
        jsonb_array_length(v.buildings) AS building_count
      FROM player_profiles p
      JOIN world_plots plot ON plot.player_id = p.player_id
        AND (plot.lease_expires_at IS NULL OR plot.lease_expires_at > $2)
      JOIN villages v ON v.player_id = p.player_id
      ORDER BY p.trophies DESC, building_count DESC, p.username, p.player_id
      LIMIT $1
    `, [limit, query.now])
    return result.rows.map(row => ({
      ...playerSummaryFromRow(row),
      worldId: row.world_id,
      x: row.x,
      y: row.y,
      buildingCount: Number(row.building_count)
    }))
  }

  async insert(record: AccountRecord): Promise<void> {
    await this.sql.query(
      'INSERT INTO accounts(id, username_key, password_hash, registered, created_at) VALUES ($1, $2, $3, $4, $5)',
      [record.id, record.usernameKey, record.passwordHash, record.registered, record.createdAt]
    )
    await this.sql.query(String.raw`
      INSERT INTO player_profiles(
        player_id, username, trophies, shield_until, last_seen_at, revision,
        revenge_rights, bot_raid_cooldowns
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
    `, [
      record.id,
      record.username,
      record.trophies,
      record.shieldUntil,
      record.lastSeenAt,
      record.revision,
      record.revengeRights,
      record.botRaidCooldowns
    ])
  }

  async update(record: AccountRecord, expectedRevision: number): Promise<boolean> {
    if (record.revision !== expectedRevision + 1) {
      throw new Error('Account revision must advance by exactly one')
    }
    const result = await this.sql.query(String.raw`
      WITH changed_profile AS (
        UPDATE player_profiles SET
          username = $3, trophies = $4, shield_until = $5, last_seen_at = $6,
          revision = $7, revenge_rights = $8, bot_raid_cooldowns = $9
        WHERE player_id = $1 AND revision = $2
        RETURNING player_id
      ), changed_account AS (
        UPDATE accounts SET username_key = $10, password_hash = $11, registered = $12
        WHERE id IN (SELECT player_id FROM changed_profile)
        RETURNING id
      )
      SELECT id FROM changed_account
    `, [
      record.id,
      expectedRevision,
      record.username,
      record.trophies,
      record.shieldUntil,
      record.lastSeenAt,
      record.revision,
      record.revengeRights,
      record.botRaidCooldowns,
      record.usernameKey,
      record.passwordHash,
      record.registered
    ])
    return result.rowCount === 1
  }

  async touchLastSeen(id: string, seenAt: Date): Promise<boolean> {
    return (await this.sql.query(
      'UPDATE player_profiles SET last_seen_at = GREATEST(last_seen_at, $2) WHERE player_id = $1',
      [id, seenAt]
    )).rowCount === 1
  }

  async clearShields(now: Date, requestedLimit: number): Promise<number> {
    const limit = Math.max(1, Math.min(1_000, Math.floor(requestedLimit)))
    const result = await this.sql.query(String.raw`
      WITH candidates AS (
        SELECT player_id FROM player_profiles
        WHERE shield_until > $1
        ORDER BY shield_until, player_id
        LIMIT $2
        FOR UPDATE SKIP LOCKED
      )
      UPDATE player_profiles profile SET shield_until = NULL, revision = revision + 1
      FROM candidates
      WHERE profile.player_id = candidates.player_id
    `, [now, limit])
    return result.rowCount ?? 0
  }

  async delete(id: string): Promise<boolean> {
    return (await this.sql.query('DELETE FROM accounts WHERE id = $1', [id])).rowCount === 1
  }

  async deleteUnreferencedGuests(ids: readonly string[]): Promise<number> {
    const bounded = [...new Set(ids)].slice(0, 500)
    if (bounded.length === 0) return 0
    const result = await this.sql.query(String.raw`
      DELETE FROM accounts account
      WHERE account.id = ANY($1::text[])
        AND account.registered = false
        AND NOT EXISTS (SELECT 1 FROM world_plots plot WHERE plot.player_id = account.id)
        AND NOT EXISTS (
          SELECT 1 FROM attacks attack
          WHERE attack.attacker_id = account.id OR attack.defender_id = account.id
        )
        AND NOT EXISTS (SELECT 1 FROM balance_ledger ledger WHERE ledger.player_id = account.id)
    `, [bounded])
    return result.rowCount ?? 0
  }
}

interface SessionRow extends QueryResultRow {
  token_hash: string
  player_id: string
  created_at: Date | string
  last_used_at: Date | string
  expires_at: Date | string
  device_id: string | null
}

function sessionFromRow(row: SessionRow): SessionRecord {
  return {
    tokenHash: row.token_hash,
    playerId: row.player_id,
    createdAt: date(row.created_at),
    lastUsedAt: date(row.last_used_at),
    expiresAt: date(row.expires_at),
    deviceId: row.device_id
  }
}

class PgSessions implements SessionRepository {
  private readonly sql: SqlExecutor

  constructor(sql: SqlExecutor) {
    this.sql = sql
  }

  async getByTokenHash(tokenHash: string, options: { forUpdate?: boolean } = {}): Promise<SessionRecord | null> {
    const result = await this.sql.query<SessionRow>(String.raw`
      SELECT token_hash, player_id, created_at, last_used_at, expires_at, device_id
      FROM sessions WHERE token_hash = $1${options.forUpdate ? ' FOR UPDATE' : ''}
    `, [tokenHash])
    return result.rows[0] ? sessionFromRow(result.rows[0]) : null
  }

  async listForPlayer(
    playerId: string,
    requestedLimit: number,
    options: { forUpdate?: boolean } = {}
  ): Promise<SessionRecord[]> {
    const limit = Math.max(1, Math.min(100, Math.floor(requestedLimit)))
    const result = await this.sql.query<SessionRow>(String.raw`
      SELECT token_hash, player_id, created_at, last_used_at, expires_at, device_id
      FROM sessions
      WHERE player_id = $1
      ORDER BY created_at, token_hash
      LIMIT $2${options.forUpdate ? ' FOR UPDATE' : ''}
    `, [playerId, limit])
    return result.rows.map(sessionFromRow)
  }

  async insert(record: SessionRecord): Promise<void> {
    await this.sql.query(String.raw`
      INSERT INTO sessions(token_hash, player_id, created_at, last_used_at, expires_at, device_id)
      VALUES ($1, $2, $3, $4, $5, $6)
    `, [record.tokenHash, record.playerId, record.createdAt, record.lastUsedAt, record.expiresAt, record.deviceId])
  }

  async touch(tokenHash: string, usedAt: Date): Promise<boolean> {
    const result = await this.sql.query(
      'UPDATE sessions SET last_used_at = GREATEST(last_used_at, $2) WHERE token_hash = $1',
      [tokenHash, usedAt]
    )
    return result.rowCount === 1
  }

  async delete(tokenHash: string): Promise<boolean> {
    return (await this.sql.query('DELETE FROM sessions WHERE token_hash = $1', [tokenHash])).rowCount === 1
  }

  async deleteForPlayer(playerId: string): Promise<number> {
    return (await this.sql.query('DELETE FROM sessions WHERE player_id = $1', [playerId])).rowCount ?? 0
  }
}

interface VillageRow extends QueryResultRow {
  player_id: string
  buildings: JsonValue[]
  obstacles: JsonValue[]
  army: JsonObject
  wall_level: number
  gold: string | number
  ore: string | number
  food: string | number
  production_remainders: { ore: number; food: number }
  population: JsonObject
  simulated_through: Date | string
  last_mutation_at: Date | string
  layout_revision: string | number
  appearance_revision: string | number
  economy_revision: string | number
  simulation_version: number
  next_event_at: Date | string | null
}

function villageFromRow(row: VillageRow): VillageRecord {
  return {
    playerId: row.player_id,
    buildings: row.buildings,
    obstacles: row.obstacles,
    army: row.army,
    wallLevel: row.wall_level,
    gold: Number(row.gold),
    ore: Number(row.ore),
    food: Number(row.food),
    productionRemainders: row.production_remainders,
    population: row.population,
    simulatedThrough: date(row.simulated_through),
    lastMutationAt: date(row.last_mutation_at),
    layoutRevision: Number(row.layout_revision),
    appearanceRevision: Number(row.appearance_revision),
    economyRevision: Number(row.economy_revision),
    simulationVersion: row.simulation_version,
    nextEventAt: optionalDate(row.next_event_at)
  }
}

const VILLAGE_COLUMNS = String.raw`
  player_id, buildings, obstacles, army, wall_level, gold, ore, food,
  production_remainders, population, simulated_through, last_mutation_at,
  layout_revision, appearance_revision, economy_revision, simulation_version, next_event_at
`

class PgVillages implements VillageRepository {
  private readonly sql: SqlExecutor

  constructor(sql: SqlExecutor) {
    this.sql = sql
  }

  async get(playerId: string, options: { forUpdate?: boolean } = {}): Promise<VillageRecord | null> {
    const result = await this.sql.query<VillageRow>(
      `SELECT ${VILLAGE_COLUMNS} FROM villages WHERE player_id = $1${options.forUpdate ? ' FOR UPDATE' : ''}`,
      [playerId]
    )
    return result.rows[0] ? villageFromRow(result.rows[0]) : null
  }

  async insert(record: VillageRecord): Promise<void> {
    await this.sql.query(String.raw`
      INSERT INTO villages(${VILLAGE_COLUMNS})
      VALUES ($1, $2::jsonb, $3::jsonb, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
    `, villageValues(record))
  }

  async update(record: VillageRecord, expectedEconomyRevision: number): Promise<boolean> {
    if (record.economyRevision !== expectedEconomyRevision + 1) {
      throw new Error('Village economy revision must advance by exactly one')
    }
    const values = villageValues(record)
    values.push(expectedEconomyRevision)
    const result = await this.sql.query(String.raw`
      UPDATE villages SET
        buildings = $2::jsonb, obstacles = $3::jsonb, army = $4, wall_level = $5,
        gold = $6, ore = $7, food = $8, production_remainders = $9,
        population = $10, simulated_through = $11, last_mutation_at = $12,
        layout_revision = $13, appearance_revision = $14, economy_revision = $15,
        simulation_version = $16, next_event_at = $17
      WHERE player_id = $1 AND economy_revision = $18
    `, values)
    return result.rowCount === 1
  }
}

function villageValues(record: VillageRecord): unknown[] {
  return [
    record.playerId,
    // node-postgres serializes a top-level JavaScript array as a PostgreSQL
    // array literal. These columns are JSON arrays, so encode them explicitly
    // before the jsonb cast (objects are JSON-encoded by pg automatically).
    JSON.stringify(record.buildings),
    JSON.stringify(record.obstacles),
    record.army,
    record.wallLevel,
    record.gold,
    record.ore,
    record.food,
    record.productionRemainders,
    record.population,
    record.simulatedThrough,
    record.lastMutationAt,
    record.layoutRevision,
    record.appearanceRevision,
    record.economyRevision,
    record.simulationVersion,
    record.nextEventAt
  ]
}

interface AllocationRow extends QueryResultRow {
  world_id: string
  schema_version: number
  region_size: number
  current_generation_version: number
  next_ordinal: string | number
  allocation_model: number
  revision: string | number
  updated_at: Date | string
}

function allocationFromRow(row: AllocationRow): WorldAllocationRecord {
  return {
    worldId: row.world_id,
    schemaVersion: row.schema_version,
    regionSize: row.region_size,
    currentGenerationVersion: row.current_generation_version,
    nextOrdinal: Number(row.next_ordinal),
    allocationModel: row.allocation_model,
    revision: Number(row.revision),
    updatedAt: date(row.updated_at)
  }
}

const ALLOCATION_SELECT = String.raw`
  SELECT world_id, schema_version, region_size, current_generation_version,
    next_ordinal, allocation_model, revision, updated_at
  FROM world_allocation_state
`

interface RegionRow extends QueryResultRow {
  world_id: string
  region_id: string
  region_x: number
  region_y: number
  size: number
  generation_version: number
  created_at: Date | string
}

function regionFromRow(row: RegionRow): WorldRegionRecord {
  return {
    worldId: row.world_id,
    regionId: row.region_id,
    regionX: row.region_x,
    regionY: row.region_y,
    size: row.size,
    generationVersion: row.generation_version,
    createdAt: date(row.created_at)
  }
}

const REGION_SELECT = String.raw`
  SELECT world_id, region_id, region_x, region_y, size, generation_version, created_at
  FROM world_regions
`

interface ReleasedPlotRow extends QueryResultRow {
  world_id: string
  ordinal: string | number
  plot_version: string | number
  released_at: Date | string
}

function releasedPlotFromRow(row: ReleasedPlotRow): ReleasedWorldPlotRecord {
  return {
    worldId: row.world_id,
    ordinal: Number(row.ordinal),
    plotVersion: Number(row.plot_version),
    releasedAt: date(row.released_at)
  }
}

interface PlotRow extends QueryResultRow {
  world_id: string
  x: number
  y: number
  region_id: string
  player_id: string
  plot_version: string | number
  assigned_at: Date | string
  lease_id: string | null
  lease_issued_at: Date | string | null
  lease_renewed_at: Date | string | null
  lease_expires_at: Date | string | null
}

function plotFromRow(row: PlotRow): WorldPlotRecord {
  return {
    worldId: row.world_id,
    x: row.x,
    y: row.y,
    regionId: row.region_id,
    playerId: row.player_id,
    plotVersion: Number(row.plot_version),
    assignedAt: date(row.assigned_at),
    leaseId: row.lease_id,
    leaseIssuedAt: optionalDate(row.lease_issued_at),
    leaseRenewedAt: optionalDate(row.lease_renewed_at),
    leaseExpiresAt: optionalDate(row.lease_expires_at)
  }
}

const PLOT_SELECT = String.raw`
  SELECT world_id, x, y, region_id, player_id, plot_version, assigned_at,
    lease_id, lease_issued_at, lease_renewed_at, lease_expires_at
  FROM world_plots
`

interface AtlasRow extends PlotRow {
  account_created_at: Date | string
  username: string
  trophies: number
  shield_until: Date | string | null
  last_seen_at: Date | string
  revision: string | number
  village_buildings: JsonValue[]
  village_obstacles: JsonValue[]
  village_wall_level: number
  village_population: JsonObject
  village_simulated_through: Date | string
  village_last_mutation_at: Date | string
  village_layout_revision: string | number
  village_appearance_revision: string | number
  village_simulation_version: number
  village_next_event_at: Date | string | null
  village_gold: string | number
  village_ore: string | number
  village_food: string | number
  village_production_remainders: { ore: number; food: number }
  village_economy_revision: string | number
}

function atlasFromRow(row: AtlasRow): WorldAtlasEntry {
  return {
    plot: plotFromRow(row),
    player: playerSummaryFromRow(row),
    village: {
      playerId: row.player_id,
      buildings: row.village_buildings,
      obstacles: row.village_obstacles,
      wallLevel: row.village_wall_level,
      population: row.village_population,
      simulatedThrough: date(row.village_simulated_through),
      lastMutationAt: date(row.village_last_mutation_at),
      layoutRevision: Number(row.village_layout_revision),
      appearanceRevision: Number(row.village_appearance_revision),
      simulationVersion: row.village_simulation_version,
      nextEventAt: optionalDate(row.village_next_event_at)
    },
    accountCreatedAt: date(row.account_created_at),
    simulation: {
      gold: Number(row.village_gold),
      ore: Number(row.village_ore),
      food: Number(row.village_food),
      productionRemainders: row.village_production_remainders,
      economyRevision: Number(row.village_economy_revision)
    }
  }
}

class PgWorld implements WorldRepository {
  private readonly sql: SqlExecutor

  constructor(sql: SqlExecutor) {
    this.sql = sql
  }

  async getAllocation(worldId: string, options: { forUpdate?: boolean } = {}): Promise<WorldAllocationRecord | null> {
    const result = await this.sql.query<AllocationRow>(
      `${ALLOCATION_SELECT} WHERE world_id = $1${options.forUpdate ? ' FOR UPDATE' : ''}`,
      [worldId]
    )
    return result.rows[0] ? allocationFromRow(result.rows[0]) : null
  }

  async insertAllocation(record: WorldAllocationRecord): Promise<void> {
    await this.sql.query(String.raw`
      INSERT INTO world_allocation_state(
        world_id, schema_version, region_size, current_generation_version,
        next_ordinal, allocation_model, revision, updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
    `, [
      record.worldId,
      record.schemaVersion,
      record.regionSize,
      record.currentGenerationVersion,
      record.nextOrdinal,
      record.allocationModel ?? 1,
      record.revision,
      record.updatedAt
    ])
  }

  async updateAllocation(record: WorldAllocationRecord, expectedRevision: number): Promise<boolean> {
    if (record.revision !== expectedRevision + 1) {
      throw new Error('World allocation revision must advance by exactly one')
    }
    const result = await this.sql.query(String.raw`
      UPDATE world_allocation_state SET
        schema_version = $3, region_size = $4, current_generation_version = $5,
        next_ordinal = $6, allocation_model = $7, revision = $8, updated_at = $9
      WHERE world_id = $1 AND revision = $2
        AND schema_version = $3 AND region_size = $4 AND next_ordinal <= $6
        AND allocation_model <= $7
    `, [
      record.worldId,
      expectedRevision,
      record.schemaVersion,
      record.regionSize,
      record.currentGenerationVersion,
      record.nextOrdinal,
      record.allocationModel ?? 1,
      record.revision,
      record.updatedAt
    ])
    return result.rowCount === 1
  }

  async getRegion(worldId: string, regionX: number, regionY: number): Promise<WorldRegionRecord | null> {
    const result = await this.sql.query<RegionRow>(
      `${REGION_SELECT} WHERE world_id = $1 AND region_x = $2 AND region_y = $3`,
      [worldId, regionX, regionY]
    )
    return result.rows[0] ? regionFromRow(result.rows[0]) : null
  }

  async ensureRegion(record: WorldRegionRecord): Promise<'inserted' | 'existing'> {
    const result = await this.sql.query(String.raw`
      INSERT INTO world_regions(
        world_id, region_id, region_x, region_y, size, generation_version, created_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7)
      ON CONFLICT DO NOTHING
      RETURNING region_id
    `, [
      record.worldId,
      record.regionId,
      record.regionX,
      record.regionY,
      record.size,
      record.generationVersion,
      record.createdAt
    ])
    if (result.rowCount === 1) return 'inserted'
    const same = await this.sql.query(String.raw`
      SELECT 1 FROM world_regions
      WHERE world_id = $1 AND region_id = $2 AND region_x = $3 AND region_y = $4
        AND size = $5 AND generation_version = $6
    `, [
      record.worldId,
      record.regionId,
      record.regionX,
      record.regionY,
      record.size,
      record.generationVersion
    ])
    if (same.rowCount !== 1) throw new PersistenceConflictError('World region metadata is immutable')
    return 'existing'
  }

  async getReleasedSlots(
    worldId: string,
    limit: number,
    options: { forUpdate?: boolean; excludeOrdinals?: readonly number[] } = {}
  ): Promise<ReleasedWorldPlotRecord[]> {
    const boundedLimit = Math.max(1, Math.min(100_000, Math.floor(limit)))
    const excluded = [...new Set(options.excludeOrdinals ?? [])].slice(0, 256)
    const result = await this.sql.query<ReleasedPlotRow>(String.raw`
      SELECT world_id, ordinal, plot_version, released_at
      FROM world_released_slots
      WHERE world_id = $1 AND NOT (ordinal = ANY($3::bigint[]))
      ORDER BY ordinal
      LIMIT $2${options.forUpdate ? ' FOR UPDATE' : ''}
    `, [worldId, boundedLimit, excluded])
    return result.rows.map(releasedPlotFromRow)
  }

  async getReleasedSlot(
    worldId: string,
    ordinal: number,
    options: { forUpdate?: boolean } = {}
  ): Promise<ReleasedWorldPlotRecord | null> {
    const result = await this.sql.query<ReleasedPlotRow>(String.raw`
      SELECT world_id, ordinal, plot_version, released_at
      FROM world_released_slots
      WHERE world_id = $1 AND ordinal = $2${options.forUpdate ? ' FOR UPDATE' : ''}
    `, [worldId, ordinal])
    return result.rows[0] ? releasedPlotFromRow(result.rows[0]) : null
  }

  async putReleasedSlot(record: ReleasedWorldPlotRecord): Promise<void> {
    await this.sql.query(String.raw`
      INSERT INTO world_released_slots(world_id, ordinal, plot_version, released_at)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (world_id, ordinal) DO UPDATE SET
        plot_version = GREATEST(world_released_slots.plot_version, EXCLUDED.plot_version),
        released_at = CASE
          WHEN EXCLUDED.plot_version >= world_released_slots.plot_version THEN EXCLUDED.released_at
          ELSE world_released_slots.released_at
        END
    `, [record.worldId, record.ordinal, record.plotVersion, record.releasedAt])
  }

  async deleteReleasedSlots(worldId: string, ordinals: readonly number[]): Promise<number> {
    if (ordinals.length === 0) return 0
    const result = await this.sql.query(
      'DELETE FROM world_released_slots WHERE world_id = $1 AND ordinal = ANY($2::bigint[])',
      [worldId, [...new Set(ordinals)]]
    )
    return result.rowCount ?? 0
  }

  async getPlayerPlot(playerId: string, options: { forUpdate?: boolean } = {}): Promise<WorldPlotRecord | null> {
    const result = await this.sql.query<PlotRow>(
      `${PLOT_SELECT} WHERE player_id = $1${options.forUpdate ? ' FOR UPDATE' : ''}`,
      [playerId]
    )
    return result.rows[0] ? plotFromRow(result.rows[0]) : null
  }

  async getOccupant(worldId: string, x: number, y: number, options: { forUpdate?: boolean } = {}): Promise<WorldPlotRecord | null> {
    const result = await this.sql.query<PlotRow>(
      `${PLOT_SELECT} WHERE world_id = $1 AND x = $2 AND y = $3${options.forUpdate ? ' FOR UPDATE' : ''}`,
      [worldId, x, y]
    )
    return result.rows[0] ? plotFromRow(result.rows[0]) : null
  }

  async listOccupantsAt(
    worldId: string,
    rawCoordinates: readonly { x: number; y: number }[]
  ): Promise<WorldPlotRecord[]> {
    const coordinates = boundWorldOccupancyBatch(rawCoordinates)
    if (coordinates.length === 0) return []
    const result = await this.sql.query<PlotRow>(String.raw`
      WITH requested(x, y) AS (
        SELECT * FROM unnest($2::integer[], $3::integer[])
      )
      SELECT plot.world_id, plot.x, plot.y, plot.region_id, plot.player_id,
        plot.plot_version, plot.assigned_at, plot.lease_id,
        plot.lease_issued_at, plot.lease_renewed_at, plot.lease_expires_at
      FROM world_plots plot
      JOIN requested ON requested.x = plot.x AND requested.y = plot.y
      WHERE plot.world_id = $1
      ORDER BY plot.y, plot.x, plot.player_id
    `, [worldId, coordinates.map(coordinate => coordinate.x), coordinates.map(coordinate => coordinate.y)])
    return result.rows.map(plotFromRow)
  }

  async listAtlas(input: WorldAtlasQuery): Promise<WorldAtlasEntry[]> {
    const query = boundWorldAtlasQuery(input)
    const result = await this.sql.query<AtlasRow>(String.raw`
      SELECT
        plot.world_id, plot.x, plot.y, plot.region_id, plot.player_id,
        plot.plot_version, plot.assigned_at, plot.lease_id, plot.lease_issued_at,
        plot.lease_renewed_at, plot.lease_expires_at,
        p.username, p.trophies, p.shield_until, p.last_seen_at, p.revision,
        account.created_at AS account_created_at,
        v.buildings AS village_buildings,
        v.obstacles AS village_obstacles,
        v.wall_level AS village_wall_level,
        v.population AS village_population,
        v.simulated_through AS village_simulated_through,
        v.last_mutation_at AS village_last_mutation_at,
        v.layout_revision AS village_layout_revision,
        v.appearance_revision AS village_appearance_revision,
        v.simulation_version AS village_simulation_version,
        v.next_event_at AS village_next_event_at
        ,v.gold AS village_gold
        ,v.ore AS village_ore
        ,v.food AS village_food
        ,v.production_remainders AS village_production_remainders
        ,v.economy_revision AS village_economy_revision
      FROM world_plots plot
      JOIN accounts account ON account.id = plot.player_id
      JOIN player_profiles p ON p.player_id = plot.player_id
      JOIN villages v ON v.player_id = plot.player_id
      WHERE plot.world_id = $1
        AND plot.y BETWEEN $2 AND $3
        AND plot.x BETWEEN $4 AND $5
        AND (plot.lease_expires_at IS NULL OR plot.lease_expires_at > $6)
      ORDER BY plot.y, plot.x, plot.player_id
      LIMIT $7
    `, [query.worldId, query.minY, query.maxY, query.minX, query.maxX, query.now, query.limit])
    return result.rows.map(atlasFromRow)
  }

  async listPlayers(input: WorldAtlasQuery): Promise<WorldPlayerEntry[]> {
    const query = boundWorldAtlasQuery(input)
    const result = await this.sql.query<PlotRow & PlayerSummaryRow>(String.raw`
      SELECT
        plot.world_id, plot.x, plot.y, plot.region_id, plot.player_id,
        plot.plot_version, plot.assigned_at, plot.lease_id, plot.lease_issued_at,
        plot.lease_renewed_at, plot.lease_expires_at,
        p.username, p.trophies, p.shield_until, p.last_seen_at, p.revision
      FROM world_plots plot
      JOIN player_profiles p ON p.player_id = plot.player_id
      WHERE plot.world_id = $1
        AND plot.y BETWEEN $2 AND $3
        AND plot.x BETWEEN $4 AND $5
        AND (plot.lease_expires_at IS NULL OR plot.lease_expires_at > $6)
      ORDER BY plot.y, plot.x, plot.player_id
      LIMIT $7
    `, [query.worldId, query.minY, query.maxY, query.minX, query.maxX, query.now, query.limit])
    return result.rows.map(row => ({ plot: plotFromRow(row), player: playerSummaryFromRow(row) }))
  }

  async claimExpiredGuestAccountIds(worldId: string, now: Date, limit: number): Promise<string[]> {
    const boundedLimit = Math.max(1, Math.min(1_000, Math.floor(limit)))
    const result = await this.sql.query<{ player_id: string } & QueryResultRow>(String.raw`
      WITH candidates AS MATERIALIZED (
        SELECT plot.player_id, plot.lease_expires_at
        FROM world_plots plot
        JOIN accounts owner ON owner.id = plot.player_id
        WHERE plot.world_id = $1 AND plot.lease_expires_at <= $2
          AND owner.registered = false
        ORDER BY plot.lease_expires_at, plot.player_id
        LIMIT $3
      )
      SELECT candidate.player_id
      FROM candidates candidate
      JOIN accounts owner ON owner.id = candidate.player_id
      ORDER BY candidate.player_id
      LIMIT $4
      FOR UPDATE OF owner SKIP LOCKED
    `, [worldId, now, Math.min(4_000, boundedLimit * 4), boundedLimit])
    return result.rows.map(row => row.player_id)
  }

  async assign(record: WorldPlotRecord): Promise<void> {
    const result = await this.sql.query(String.raw`
      INSERT INTO world_plots(
        world_id, x, y, region_id, player_id, plot_version, assigned_at,
        lease_id, lease_issued_at, lease_renewed_at, lease_expires_at
      )
      SELECT
        $1::text, $2::integer, $3::integer, $4::text, $5::text, $6::bigint,
        $7::timestamptz, $8::text, $9::timestamptz, $10::timestamptz, $11::timestamptz
      FROM world_regions region
      WHERE region.world_id = $1 AND region.region_id = $4
        AND region.region_x = floor($2::integer::numeric / region.size)::integer
        AND region.region_y = floor($3::integer::numeric / region.size)::integer
      RETURNING player_id
    `, [
      record.worldId,
      record.x,
      record.y,
      record.regionId,
      record.playerId,
      record.plotVersion,
      record.assignedAt,
      record.leaseId,
      record.leaseIssuedAt,
      record.leaseRenewedAt,
      record.leaseExpiresAt
    ])
    if (result.rowCount !== 1) {
      throw new Error('Plot coordinate does not belong to its generation-pinned region')
    }
    // Keep claims and reusable ordinals mutually exclusive even when a release
    // commits while a frontier allocator is waiting on the old coordinate.
    // A separate statement intentionally gets the newest READ COMMITTED
    // snapshot; under SERIALIZABLE, an overlapping write is retried instead.
    await this.deleteReleasedSlots(record.worldId, [allocationOrdinalOf({ x: record.x, y: record.y })])
  }

  async renewGuestLease(
    playerId: string,
    leaseId: string,
    renewedAt: Date,
    expiresAt: Date
  ): Promise<boolean> {
    const result = await this.sql.query(String.raw`
      UPDATE world_plots SET
        lease_renewed_at = GREATEST(lease_renewed_at, $3),
        lease_expires_at = GREATEST(lease_expires_at, $4)
      WHERE player_id = $1 AND lease_id = $2
        AND lease_expires_at > $3 AND $4::timestamptz > $3::timestamptz
    `, [playerId, leaseId, renewedAt, expiresAt])
    return result.rowCount === 1
  }

  async promoteGuestLease(playerId: string, leaseId: string, now: Date): Promise<boolean> {
    const result = await this.sql.query(String.raw`
      UPDATE world_plots SET
        lease_id = NULL, lease_issued_at = NULL,
        lease_renewed_at = NULL, lease_expires_at = NULL
      WHERE player_id = $1 AND lease_id = $2 AND lease_expires_at > $3
    `, [playerId, leaseId, now])
    return result.rowCount === 1
  }

  async release(playerId: string): Promise<boolean> {
    return (await this.sql.query('DELETE FROM world_plots WHERE player_id = $1', [playerId])).rowCount === 1
  }
}

interface AttackRow extends QueryResultRow {
  id: string
  attacker_id: string
  defender_id: string | null
  target_kind: AttackRecord['targetKind']
  target_id: string
  world_id: string
  target_x: number
  target_y: number
  target_plot_version: string | number
  state: AttackState
  state_version: string | number
  simulation_version: number
  seed: string
  fencing_token_hash: string
  defender_snapshot: JsonObject
  reserved_army: JsonObject
  created_at: Date | string
  engaged_at: Date | string | null
  updated_at: Date | string
  deadline_at: Date | string
  ended_at: Date | string | null
  result: JsonObject | null
  authority: AttackRecord['authority']
}

function attackFromRow(row: AttackRow): AttackRecord {
  return {
    id: row.id,
    attackerId: row.attacker_id,
    defenderId: row.defender_id,
    targetKind: row.target_kind,
    targetId: row.target_id,
    worldId: row.world_id,
    targetX: row.target_x,
    targetY: row.target_y,
    targetPlotVersion: Number(row.target_plot_version),
    state: row.state,
    stateVersion: Number(row.state_version),
    simulationVersion: row.simulation_version,
    seed: row.seed,
    fencingTokenHash: row.fencing_token_hash,
    defenderSnapshot: row.defender_snapshot,
    reservedArmy: row.reserved_army,
    createdAt: date(row.created_at),
    engagedAt: optionalDate(row.engaged_at),
    updatedAt: date(row.updated_at),
    deadlineAt: date(row.deadline_at),
    endedAt: optionalDate(row.ended_at),
    result: row.result,
    authority: row.authority
  }
}

const ATTACK_COLUMNS = String.raw`
  id, attacker_id, defender_id, target_kind, target_id, world_id, target_x, target_y, target_plot_version,
  state, state_version, simulation_version, seed, fencing_token_hash,
  defender_snapshot, reserved_army, created_at, engaged_at, updated_at, deadline_at,
  ended_at, result, authority
`

const ACTIVE_ATTACK_STATE_VALUES: readonly AttackState[] = ['preparing', 'engaged', 'active', 'finalizing']

interface CandidateRow extends PlotRow {
  username: string
  trophies: number
  shield_until: Date | string | null
  last_seen_at: Date | string
  revision: string | number
  layout_revision: string | number
}

function candidateFromRow(row: CandidateRow, targetTrophies: number): AttackCandidateRecord {
  return {
    player: playerSummaryFromRow(row),
    plot: plotFromRow(row),
    layoutRevision: Number(row.layout_revision),
    trophyDistance: Math.abs(row.trophies - targetTrophies)
  }
}

interface AttackCommandRow extends QueryResultRow {
  attack_id: string
  sequence: number
  actor_id: string
  command_id: string
  command_type: string
  payload: JsonObject
  accepted_at: Date | string
}

const ATTACK_COMMAND_COLUMNS = String.raw`
  attack_id, sequence, actor_id, command_id, command_type, payload, accepted_at
`

function attackCommandFromRow(row: AttackCommandRow): AttackCommandRecord {
  return {
    attackId: row.attack_id,
    sequence: row.sequence,
    actorId: row.actor_id,
    commandId: row.command_id,
    commandType: row.command_type,
    payload: row.payload,
    acceptedAt: date(row.accepted_at)
  }
}

function attackCommandMatches(left: AttackCommandRecord, right: AttackCommandRecord): boolean {
  return left.attackId === right.attackId
    && left.sequence === right.sequence
    && left.actorId === right.actorId
    && left.commandId === right.commandId
    && left.commandType === right.commandType
    && isDeepStrictEqual(left.payload, right.payload)
}

function commandValues(record: AttackCommandRecord): unknown[] {
  return [
    record.attackId,
    record.sequence,
    record.actorId,
    record.commandId,
    record.commandType,
    record.payload,
    record.acceptedAt
  ]
}

class PgAttacks implements AttackRepository {
  private readonly sql: SqlExecutor

  constructor(sql: SqlExecutor) {
    this.sql = sql
  }

  async get(id: string, options: { forUpdate?: boolean } = {}): Promise<AttackRecord | null> {
    const result = await this.sql.query<AttackRow>(
      `SELECT ${ATTACK_COLUMNS} FROM attacks WHERE id = $1${options.forUpdate ? ' FOR UPDATE' : ''}`,
      [id]
    )
    return result.rows[0] ? attackFromRow(result.rows[0]) : null
  }

  async findCandidates(input: AttackCandidateQuery): Promise<AttackCandidateRecord[]> {
    const query = boundAttackCandidateQuery(input)
    const minTrophies = Math.max(0, query.targetTrophies - query.trophyRadius)
    const maxTrophies = Math.min(2_147_483_647, query.targetTrophies + query.trophyRadius)
    const result = await this.sql.query<CandidateRow>(String.raw`
      WITH higher AS MATERIALIZED (
        SELECT
          plot.world_id, plot.x, plot.y, plot.region_id, plot.player_id,
          plot.plot_version, plot.assigned_at, plot.lease_id, plot.lease_issued_at,
          plot.lease_renewed_at, plot.lease_expires_at,
          p.username, p.trophies, p.shield_until, p.last_seen_at, p.revision,
          v.layout_revision
        FROM player_profiles p
        JOIN world_plots plot ON plot.player_id = p.player_id AND plot.world_id = $2
        JOIN villages v ON v.player_id = p.player_id
        WHERE p.player_id <> $1
          AND p.trophies BETWEEN $3 AND $5
          AND (p.shield_until IS NULL OR p.shield_until <= $6)
          AND (plot.lease_expires_at IS NULL OR plot.lease_expires_at > $6)
          AND NOT EXISTS (
            SELECT 1 FROM attacks lease
            WHERE lease.defender_id = p.player_id AND lease.target_kind = 'player'
              AND lease.state IN ('engaged', 'active', 'finalizing')
          )
        ORDER BY p.trophies, p.player_id DESC
        LIMIT $7
      ), lower AS MATERIALIZED (
        SELECT
          plot.world_id, plot.x, plot.y, plot.region_id, plot.player_id,
          plot.plot_version, plot.assigned_at, plot.lease_id, plot.lease_issued_at,
          plot.lease_renewed_at, plot.lease_expires_at,
          p.username, p.trophies, p.shield_until, p.last_seen_at, p.revision,
          v.layout_revision
        FROM player_profiles p
        JOIN world_plots plot ON plot.player_id = p.player_id AND plot.world_id = $2
        JOIN villages v ON v.player_id = p.player_id
        WHERE p.player_id <> $1
          AND p.trophies >= $4 AND p.trophies < $3
          AND (p.shield_until IS NULL OR p.shield_until <= $6)
          AND (plot.lease_expires_at IS NULL OR plot.lease_expires_at > $6)
          AND NOT EXISTS (
            SELECT 1 FROM attacks lease
            WHERE lease.defender_id = p.player_id AND lease.target_kind = 'player'
              AND lease.state IN ('engaged', 'active', 'finalizing')
          )
        ORDER BY p.trophies DESC, p.player_id
        LIMIT $7
      )
      SELECT candidate.*
      FROM (SELECT * FROM higher UNION ALL SELECT * FROM lower) candidate
      ORDER BY abs(candidate.trophies - $3), candidate.trophies DESC, candidate.player_id
      LIMIT $7
    `, [
      query.attackerId,
      query.worldId,
      query.targetTrophies,
      minTrophies,
      maxTrophies,
      query.now,
      query.limit
    ])
    return result.rows.map(row => candidateFromRow(row, query.targetTrophies))
  }

  async listActiveIncoming(defenderId: string, requestedLimit: number): Promise<AttackRecord[]> {
    const limit = boundedLimit(requestedLimit, QUERY_LIMITS.activeAttacks)
    const result = await this.sql.query<AttackRow>(String.raw`
      SELECT ${ATTACK_COLUMNS} FROM attacks
      WHERE target_kind = 'player' AND defender_id = $1 AND state = ANY($2::text[])
      ORDER BY created_at DESC, id DESC
      LIMIT $3
    `, [defenderId, ACTIVE_ATTACK_STATE_VALUES, limit])
    return result.rows.map(attackFromRow)
  }

  async listLeasedIncoming(defenderId: string, requestedLimit: number): Promise<AttackRecord[]> {
    const limit = boundedLimit(requestedLimit, QUERY_LIMITS.activeAttacks)
    const result = await this.sql.query<AttackRow>(String.raw`
      SELECT ${ATTACK_COLUMNS} FROM attacks
      WHERE target_kind = 'player' AND defender_id = $1
        AND state IN ('engaged', 'active', 'finalizing')
      ORDER BY created_at DESC, id DESC
      LIMIT $2
    `, [defenderId, limit])
    return result.rows.map(attackFromRow)
  }

  async listActiveOutgoing(attackerId: string, requestedLimit: number): Promise<AttackRecord[]> {
    const limit = boundedLimit(requestedLimit, QUERY_LIMITS.activeAttacks)
    const result = await this.sql.query<AttackRow>(String.raw`
      SELECT ${ATTACK_COLUMNS} FROM attacks
      WHERE attacker_id = $1 AND state = ANY($2::text[])
      ORDER BY created_at DESC, id DESC
      LIMIT $3
    `, [attackerId, ACTIVE_ATTACK_STATE_VALUES, limit])
    return result.rows.map(attackFromRow)
  }

  async claimDue(now: Date, requestedLimit: number): Promise<AttackRecord[]> {
    const limit = boundedLimit(requestedLimit, QUERY_LIMITS.activeAttacks)
    if (!(now instanceof Date) || !Number.isFinite(now.getTime())) throw new RangeError('now must be a valid Date')
    const result = await this.sql.query<AttackRow>(String.raw`
      SELECT ${ATTACK_COLUMNS} FROM attacks
      WHERE state = ANY($2::text[]) AND deadline_at <= $1
      ORDER BY deadline_at, id
      LIMIT $3
      FOR UPDATE SKIP LOCKED
    `, [now, ACTIVE_ATTACK_STATE_VALUES, limit])
    return result.rows.map(attackFromRow)
  }

  async listActiveForPlayers(playerIds: readonly string[], requestedLimit: number): Promise<AttackRecord[]> {
    const query = boundAttackPlayerBatch(playerIds, requestedLimit)
    if (query.playerIds.length === 0) return []
    const result = await this.sql.query<AttackRow>(String.raw`
      SELECT ${ATTACK_COLUMNS} FROM attacks
      WHERE state = ANY($2::text[])
        AND (attacker_id = ANY($1::text[]) OR defender_id = ANY($1::text[]))
      ORDER BY created_at DESC, id DESC
      LIMIT $3
    `, [query.playerIds, ACTIVE_ATTACK_STATE_VALUES, query.limit])
    return result.rows.map(attackFromRow)
  }

  async listLeasedIncomingForDefenders(
    defenderIds: readonly string[],
    requestedLimit: number
  ): Promise<AttackRecord[]> {
    const query = boundAttackPlayerBatch(defenderIds, requestedLimit)
    if (query.playerIds.length === 0) return []
    const result = await this.sql.query<AttackRow>(String.raw`
      SELECT ${ATTACK_COLUMNS} FROM attacks
      WHERE target_kind = 'player' AND defender_id = ANY($1::text[])
        AND state IN ('engaged', 'active', 'finalizing')
      ORDER BY created_at DESC, id DESC
      LIMIT $2
    `, [query.playerIds, query.limit])
    return result.rows.map(attackFromRow)
  }

  async insert(record: AttackRecord): Promise<void> {
    assertAttackRecordAuthority(record)
    await this.sql.query(String.raw`
      INSERT INTO attacks(${ATTACK_COLUMNS})
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23)
    `, attackValues(record))
  }

  private async persistAuthority(
    current: AttackRecord,
    next: AttackRecord,
    expectedState: AttackState,
    expectedVersion: number
  ): Promise<boolean> {
    const result = await this.sql.query(String.raw`
      UPDATE attacks SET
        state = $4, state_version = $5, simulation_version = $6, seed = $7,
        defender_snapshot = $8, reserved_army = $9, engaged_at = $10,
        updated_at = $11, deadline_at = $12, ended_at = $13, result = $14,
        authority = $15
      WHERE id = $1 AND state = $2 AND state_version = $3 AND authority IS NOT NULL
    `, [
      current.id,
      expectedState,
      expectedVersion,
      next.state,
      next.stateVersion,
      next.simulationVersion,
      next.seed,
      next.defenderSnapshot,
      next.reservedArmy,
      next.engagedAt,
      next.updatedAt,
      next.deadlineAt,
      next.endedAt,
      next.result,
      next.authority
    ])
    return result.rowCount === 1
  }

  async compareAndSwapAuthority(write: AttackAuthorityWrite): Promise<boolean> {
    const current = await this.get(write.attackId, { forUpdate: true })
    if (!current || !current.authority
      || current.state !== write.expectedState
      || current.stateVersion !== write.expectedVersion) return false
    const next = attackRecordWithAuthority(current, write.authority, write.updatedAt, { replacing: true })
    return this.persistAuthority(current, next, write.expectedState, write.expectedVersion)
  }

  async commitAuthorityCommand(write: AttackAuthorityCommandWrite): Promise<'inserted' | 'duplicate'> {
    const current = await this.get(write.attackId, { forUpdate: true })
    if (!current) throw new Error(`Unknown attack: ${write.attackId}`)
    const collisions = await this.sql.query<AttackCommandRow>(String.raw`
      SELECT ${ATTACK_COMMAND_COLUMNS} FROM attack_commands
      WHERE attack_id = $1 AND (sequence = $2 OR command_id = $3)
      ORDER BY sequence
    `, [write.command.attackId, write.command.sequence, write.command.commandId])
    if (collisions.rows.length > 0) {
      const exact = collisions.rows.length === 1
        && attackCommandMatches(attackCommandFromRow(collisions.rows[0]!), write.command)
      if (exact && current.authority && isDeepStrictEqual(current.authority, write.authority)) return 'duplicate'
      throw new PersistenceConflictError('Attack command id was reused with different content or authority')
    }
    if (!current.authority
      || current.state !== write.expectedState
      || current.stateVersion !== write.expectedVersion) {
      throw new PersistenceConflictError('Attack authority compare-and-swap failed')
    }
    assertAuthorityCommand(write.command, write.authority)
    const next = attackRecordWithAuthority(current, write.authority, write.updatedAt, { replacing: true })
    await this.sql.query(String.raw`
      INSERT INTO attack_commands(attack_id, sequence, actor_id, command_id, command_type, payload, accepted_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
    `, commandValues(write.command))
    if (!await this.persistAuthority(current, next, write.expectedState, write.expectedVersion)) {
      throw new PersistenceConflictError('Attack authority compare-and-swap failed')
    }
    return 'inserted'
  }

  async listCommands(input: AttackCommandQuery): Promise<AttackCommandRecord[]> {
    const query = boundAttackCommandQuery(input)
    const result = await this.sql.query<AttackCommandRow>(String.raw`
      SELECT ${ATTACK_COMMAND_COLUMNS} FROM attack_commands
      WHERE attack_id = $1 AND sequence > $2
      ORDER BY sequence
      LIMIT $3
    `, [query.attackId, query.afterSequence, query.limit])
    return result.rows.map(attackCommandFromRow)
  }

  async appendCommand(record: AttackCommandRecord): Promise<'inserted' | 'duplicate'> {
    const result = await this.sql.query(String.raw`
      INSERT INTO attack_commands(attack_id, sequence, actor_id, command_id, command_type, payload, accepted_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      ON CONFLICT DO NOTHING RETURNING sequence
    `, [
      record.attackId,
      record.sequence,
      record.actorId,
      record.commandId,
      record.commandType,
      record.payload,
      record.acceptedAt
    ])
    if (result.rowCount === 1) return 'inserted'
    const same = await this.sql.query(String.raw`
      SELECT 1 FROM attack_commands
      WHERE attack_id = $1 AND sequence = $2 AND actor_id = $3 AND command_id = $4
        AND command_type = $5 AND payload = $6::jsonb
    `, [record.attackId, record.sequence, record.actorId, record.commandId, record.commandType, record.payload])
    if (same.rowCount !== 1) throw new PersistenceConflictError('Attack command id was reused with different content')
    return 'duplicate'
  }

  async settle(record: SettlementRecord): Promise<'inserted' | 'duplicate'> {
    const result = await this.sql.query(String.raw`
      INSERT INTO attack_settlements(attack_id, attacker_id, defender_id, outcome, committed_at)
      VALUES ($1, $2, $3, $4, $5)
      ON CONFLICT (attack_id) DO NOTHING RETURNING attack_id
    `, [record.attackId, record.attackerId, record.defenderId, record.outcome, record.committedAt])
    if (result.rowCount === 1) return 'inserted'
    const same = await this.sql.query(String.raw`
      SELECT 1 FROM attack_settlements
      WHERE attack_id = $1 AND attacker_id = $2 AND defender_id IS NOT DISTINCT FROM $3
        AND outcome = $4::jsonb
    `, [record.attackId, record.attackerId, record.defenderId, record.outcome])
    if (same.rowCount !== 1) throw new PersistenceConflictError('Attack settlement was replayed with a different outcome')
    return 'duplicate'
  }
}

function attackValues(record: AttackRecord): unknown[] {
  return [
    record.id,
    record.attackerId,
    record.defenderId,
    record.targetKind,
    record.targetId,
    record.worldId,
    record.targetX,
    record.targetY,
    record.targetPlotVersion,
    record.state,
    record.stateVersion,
    record.simulationVersion,
    record.seed,
    record.fencingTokenHash,
    record.defenderSnapshot,
    record.reservedArmy,
    record.createdAt,
    record.engagedAt,
    record.updatedAt,
    record.deadlineAt,
    record.endedAt,
    record.result,
    record.authority
  ]
}

interface ReplayChunkRow extends QueryResultRow {
  attack_id: string
  sequence: number
  format: string
  payload: JsonValue | null
  object_key: string | null
  checksum: string
  created_at: Date | string
}

interface PresentationUsageRow extends QueryResultRow {
  bytes_used: string | number
  chunk_count: number
}

function replayChunkFromRow(row: ReplayChunkRow): ReplayChunkRecord {
  return {
    attackId: row.attack_id,
    sequence: row.sequence,
    format: row.format,
    payload: row.payload,
    objectKey: row.object_key,
    checksum: row.checksum,
    createdAt: date(row.created_at)
  }
}

class PgReplays implements ReplayRepository {
  private readonly sql: SqlExecutor

  constructor(sql: SqlExecutor) {
    this.sql = sql
  }

  async append(record: ReplayChunkRecord): Promise<'inserted' | 'duplicate'> {
    if (record.format === 'presentation-frame-v1') {
      throw new Error('Presentation frames must use appendPresentation so storage is budgeted')
    }
    if ((record.payload === null) === (record.objectKey === null)) {
      throw new Error('Replay chunk must have exactly one payload location')
    }
    const result = await this.sql.query(String.raw`
      INSERT INTO replay_chunks(attack_id, sequence, format, payload, object_key, checksum, created_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      ON CONFLICT (attack_id, sequence) DO NOTHING
      RETURNING sequence
    `, [
      record.attackId,
      record.sequence,
      record.format,
      record.payload,
      record.objectKey,
      record.checksum,
      record.createdAt
    ])
    if (result.rowCount === 1) return 'inserted'
    const same = await this.sql.query(String.raw`
      SELECT 1 FROM replay_chunks
      WHERE attack_id = $1 AND sequence = $2 AND format = $3
        AND payload IS NOT DISTINCT FROM $4::jsonb
        AND object_key IS NOT DISTINCT FROM $5::text
        AND checksum = $6 AND created_at = $7
    `, [
      record.attackId,
      record.sequence,
      record.format,
      record.payload,
      record.objectKey,
      record.checksum,
      record.createdAt
    ])
    if (same.rowCount !== 1) throw new PersistenceConflictError('Replay chunk sequence was reused with different content')
    return 'duplicate'
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
    await this.sql.query(String.raw`
      INSERT INTO replay_presentation_usage(attack_id, bytes_used, chunk_count, updated_at)
      VALUES ($1, 0, 0, $2)
      ON CONFLICT (attack_id) DO NOTHING
    `, [record.attackId, record.createdAt])
    const usageResult = await this.sql.query<PresentationUsageRow>(String.raw`
      SELECT bytes_used, chunk_count FROM replay_presentation_usage
      WHERE attack_id = $1
      FOR UPDATE
    `, [record.attackId])
    const usage = usageResult.rows[0]
    if (!usage) throw new Error('Presentation replay usage row is missing')

    const existing = await this.sql.query<ReplayChunkRow>(String.raw`
      SELECT attack_id, sequence, format, payload, object_key, checksum, created_at
      FROM replay_chunks
      WHERE attack_id = $1 AND sequence = $2
    `, [record.attackId, record.sequence])
    const collision = existing.rows[0] ? replayChunkFromRow(existing.rows[0]) : null
    if (collision) {
      if (collision.format === record.format && collision.checksum === record.checksum
        && isDeepStrictEqual(collision.payload, record.payload) && collision.objectKey === record.objectKey) return 'duplicate'
      throw new PersistenceConflictError('Replay chunk sequence was reused with different content')
    }

    const bytesUsed = Number(usage.bytes_used)
    if (budget.byteSize > budget.maxBytes || bytesUsed + budget.byteSize > budget.maxBytes
      || usage.chunk_count >= budget.maxChunks) return 'dropped'
    await this.sql.query(String.raw`
      UPDATE replay_presentation_usage
      SET bytes_used = bytes_used + $2, chunk_count = chunk_count + 1, updated_at = $3
      WHERE attack_id = $1
    `, [record.attackId, budget.byteSize, record.createdAt])
    await this.sql.query(String.raw`
      INSERT INTO replay_chunks(attack_id, sequence, format, payload, object_key, checksum, created_at)
      VALUES ($1, $2, $3, $4, NULL, $5, $6)
    `, [record.attackId, record.sequence, record.format, record.payload, record.checksum, record.createdAt])
    return 'inserted'
  }

  async listForParticipant(input: ParticipantReplayQuery): Promise<ReplayChunkRecord[]> {
    const query = boundParticipantReplayQuery(input)
    const result = await this.sql.query<ReplayChunkRow>(String.raw`
      SELECT chunk.attack_id, chunk.sequence, chunk.format, chunk.payload,
        chunk.object_key, chunk.checksum, chunk.created_at
      FROM attacks attack
      JOIN replay_chunks chunk ON chunk.attack_id = attack.id
      WHERE attack.id = $1
        AND (attack.attacker_id = $2 OR attack.defender_id = $2)
        AND chunk.sequence > $3
      ORDER BY chunk.sequence
      LIMIT $4
    `, [query.attackId, query.participantId, query.afterSequence, query.limit])
    return result.rows.map(replayChunkFromRow)
  }

  async prunePresentation(before: Date, requestedLimit: number): Promise<number> {
    if (!(before instanceof Date) || !Number.isFinite(before.getTime())) throw new RangeError('before must be a valid Date')
    const limit = Math.max(1, Math.min(100, Math.floor(requestedLimit)))
    const result = await this.sql.query<{ deleted_count: string }>(String.raw`
      WITH victims AS MATERIALIZED (
        SELECT attack.id
        FROM attacks attack
        WHERE attack.ended_at IS NOT NULL AND attack.ended_at < $1
          AND EXISTS (
            SELECT 1 FROM replay_chunks chunk
            WHERE chunk.attack_id = attack.id AND chunk.format = 'presentation-frame-v1'
          )
        ORDER BY attack.ended_at, attack.id
        LIMIT $2
        FOR UPDATE SKIP LOCKED
      ), deleted_chunks AS (
        DELETE FROM replay_chunks chunk
        USING victims
        WHERE chunk.attack_id = victims.id AND chunk.format = 'presentation-frame-v1'
        RETURNING chunk.attack_id
      ), deleted_usage AS (
        DELETE FROM replay_presentation_usage usage
        USING victims
        WHERE usage.attack_id = victims.id
        RETURNING usage.attack_id
      )
      SELECT count(*)::text AS deleted_count FROM deleted_chunks
    `, [before, limit])
    return Number(result.rows[0]?.deleted_count ?? 0)
  }
}

interface NotificationRow extends QueryResultRow {
  player_id: string
  id: string
  event_type: string
  payload: JsonObject
  occurred_at: Date | string
  read_at: Date | string | null
}

function notificationFromRow(row: NotificationRow): NotificationRecord {
  return {
    playerId: row.player_id,
    id: row.id,
    eventType: row.event_type,
    payload: row.payload,
    occurredAt: date(row.occurred_at),
    readAt: optionalDate(row.read_at)
  }
}

class PgNotifications implements NotificationRepository {
  private readonly sql: SqlExecutor

  constructor(sql: SqlExecutor) {
    this.sql = sql
  }

  private async enforceRetention(playerId: string): Promise<void> {
    await this.sql.query(String.raw`
      WITH retained AS MATERIALIZED (
        SELECT id FROM notifications
        WHERE player_id = $1
        ORDER BY occurred_at DESC, id DESC
        LIMIT $2
      )
      DELETE FROM notifications notification
      WHERE notification.player_id = $1
        AND NOT EXISTS (SELECT 1 FROM retained WHERE retained.id = notification.id)
    `, [playerId, QUERY_LIMITS.notificationRetention])
  }

  async add(record: NotificationRecord): Promise<'inserted' | 'duplicate'> {
    // Serialize writers per player so two API processes cannot each observe a
    // different top-50 snapshot and leave 51 rows behind.
    const owner = await this.sql.query(
      'SELECT player_id FROM player_profiles WHERE player_id = $1 FOR UPDATE',
      [record.playerId]
    )
    if (owner.rowCount !== 1) throw new Error(`Unknown notification owner: ${record.playerId}`)
    const result = await this.sql.query(String.raw`
      INSERT INTO notifications(player_id, id, event_type, payload, occurred_at, read_at)
      VALUES ($1, $2, $3, $4, $5, $6)
      ON CONFLICT (player_id, id) DO NOTHING
      RETURNING id
    `, [record.playerId, record.id, record.eventType, record.payload, record.occurredAt, record.readAt])
    if (result.rowCount === 1) {
      await this.enforceRetention(record.playerId)
      return 'inserted'
    }
    const same = await this.sql.query(String.raw`
      SELECT 1 FROM notifications
      WHERE player_id = $1 AND id = $2 AND event_type = $3 AND payload = $4::jsonb
        AND occurred_at = $5 AND read_at IS NOT DISTINCT FROM $6::timestamptz
    `, [record.playerId, record.id, record.eventType, record.payload, record.occurredAt, record.readAt])
    if (same.rowCount !== 1) throw new PersistenceConflictError('Notification id was reused with different content')
    await this.enforceRetention(record.playerId)
    return 'duplicate'
  }

  async listForPlayer(input: NotificationQuery): Promise<NotificationRecord[]> {
    const query = boundNotificationQuery(input)
    const unreadClause = query.unreadOnly ? ' AND notification.read_at IS NULL' : ''
    const cursorClause = query.before
      ? ' AND (notification.occurred_at, notification.id) < ($2::timestamptz, $3::text)'
      : ''
    const limitParameter = query.before ? '$4' : '$2'
    const parameters: unknown[] = query.before
      ? [query.playerId, query.before.occurredAt, query.before.id, query.limit]
      : [query.playerId, query.limit]
    const result = await this.sql.query<NotificationRow>(String.raw`
      SELECT player_id, id, event_type, payload, occurred_at, read_at
      FROM notifications notification
      WHERE notification.player_id = $1${cursorClause}${unreadClause}
      ORDER BY notification.occurred_at DESC, notification.id DESC
      LIMIT ${limitParameter}
    `, parameters)
    return result.rows.map(notificationFromRow)
  }

  async markAllRead(playerId: string, readAt: Date): Promise<number> {
    return (await this.sql.query(String.raw`
      UPDATE notifications SET read_at = $2
      WHERE player_id = $1 AND read_at IS NULL
    `, [playerId, readAt])).rowCount ?? 0
  }
}

export class IdempotencyInProgressError extends Error {
  constructor() {
    super('An idempotent operation with this request id is still in progress')
  }
}

interface IdempotencyRow extends QueryResultRow {
  state: 'in_progress' | 'completed'
  response: JsonValue | null
}

class PgIdempotency implements IdempotencyRepository {
  private readonly sql: SqlExecutor

  constructor(sql: SqlExecutor) {
    this.sql = sql
  }

  async claim(actorId: string, operation: string, requestId: string, now: Date, expiresAt: Date): Promise<IdempotencyClaim> {
    await this.sql.query(String.raw`
      DELETE FROM idempotency_keys
      WHERE actor_id = $1 AND operation = $2 AND request_id = $3 AND expires_at <= $4
    `, [actorId, operation, requestId, now])
    const inserted = await this.sql.query(String.raw`
      INSERT INTO idempotency_keys(actor_id, operation, request_id, state, response, created_at, expires_at)
      VALUES ($1, $2, $3, 'in_progress', NULL, $4, $5)
      ON CONFLICT DO NOTHING RETURNING request_id
    `, [actorId, operation, requestId, now, expiresAt])
    if (inserted.rowCount === 1) return { kind: 'claimed' }

    const existing = await this.sql.query<IdempotencyRow>(String.raw`
      SELECT state, response FROM idempotency_keys
      WHERE actor_id = $1 AND operation = $2 AND request_id = $3
      FOR UPDATE
    `, [actorId, operation, requestId])
    const row = existing.rows[0]
    if (!row) throw new Error('Idempotency record disappeared during claim')
    if (row.state === 'in_progress') throw new IdempotencyInProgressError()
    if (row.response === null) throw new Error('Completed idempotency record has no response')
    return { kind: 'completed', response: row.response }
  }

  async complete(actorId: string, operation: string, requestId: string, response: JsonValue): Promise<void> {
    const result = await this.sql.query(String.raw`
      UPDATE idempotency_keys SET state = 'completed', response = $4
      WHERE actor_id = $1 AND operation = $2 AND request_id = $3 AND state = 'in_progress'
    `, [actorId, operation, requestId, response])
    if (result.rowCount !== 1) throw new Error('Idempotency claim is missing or already complete')
  }

  async pruneExpired(now: Date, requestedLimit: number): Promise<number> {
    const limit = boundedLimit(requestedLimit, QUERY_LIMITS.idempotencyPrune)
    const result = await this.sql.query(String.raw`
      WITH expired AS (
        SELECT actor_id, operation, request_id
        FROM idempotency_keys
        WHERE expires_at <= $1
        ORDER BY expires_at, actor_id, operation, request_id
        LIMIT $2
        FOR UPDATE SKIP LOCKED
      )
      DELETE FROM idempotency_keys target
      USING expired
      WHERE target.actor_id = expired.actor_id
        AND target.operation = expired.operation
        AND target.request_id = expired.request_id
    `, [now, limit])
    return result.rowCount ?? 0
  }
}

interface OutboxRow extends QueryResultRow {
  id: string
  topic: string
  aggregate_type: string
  aggregate_id: string
  event_type: string
  payload: JsonObject
  created_at: Date | string
  available_at: Date | string
  published_at: Date | string | null
  attempts: number
  locked_by: string | null
  locked_until: Date | string | null
}

interface OutboxPruneRow extends QueryResultRow {
  published_count: string | number
  expired_count: string | number
}

function outboxFromRow(row: OutboxRow): OutboxEventRecord {
  return {
    id: String(row.id),
    topic: row.topic,
    aggregateType: row.aggregate_type,
    aggregateId: row.aggregate_id,
    eventType: row.event_type,
    payload: row.payload,
    createdAt: date(row.created_at),
    availableAt: date(row.available_at),
    publishedAt: optionalDate(row.published_at),
    attempts: row.attempts,
    lockedBy: row.locked_by,
    lockedUntil: optionalDate(row.locked_until)
  }
}

const OUTBOX_COLUMNS = String.raw`
  event.id::text AS id, event.topic, event.aggregate_type, event.aggregate_id,
  event.event_type, event.payload, event.created_at, event.available_at,
  event.published_at, event.attempts, event.locked_by, event.locked_until
`

class PgOutbox implements OutboxRepository {
  private readonly sql: SqlExecutor

  constructor(sql: SqlExecutor) {
    this.sql = sql
  }

  async add(event: Omit<OutboxEventRecord, 'id' | 'publishedAt' | 'attempts' | 'lockedBy' | 'lockedUntil'>): Promise<string> {
    const result = await this.sql.query<{ id: string }>(String.raw`
      INSERT INTO outbox_events(topic, aggregate_type, aggregate_id, event_type, payload, created_at, available_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id::text AS id
    `, [event.topic, event.aggregateType, event.aggregateId, event.eventType, event.payload, event.createdAt, event.availableAt])
    const id = result.rows[0]?.id
    if (!id) throw new Error('Outbox insert did not return an id')
    return id
  }

  async claimBatch(workerId: string, now: Date, lockedUntil: Date, limit: number): Promise<OutboxEventRecord[]> {
    const boundedLimit = Math.max(1, Math.min(500, Math.floor(limit)))
    const result = await this.sql.query<OutboxRow>(String.raw`
      WITH candidates AS (
        SELECT id FROM outbox_events
        WHERE published_at IS NULL AND available_at <= $2
          AND (locked_until IS NULL OR locked_until <= $2)
        ORDER BY available_at, id
        LIMIT $4
        FOR UPDATE SKIP LOCKED
      )
      UPDATE outbox_events event SET
        locked_by = $1, locked_until = $3, attempts = event.attempts + 1
      FROM candidates WHERE event.id = candidates.id
      RETURNING ${OUTBOX_COLUMNS}
    `, [workerId, now, lockedUntil, boundedLimit])
    return result.rows.map(outboxFromRow)
  }

  async markPublished(id: string, workerId: string, publishedAt: Date): Promise<boolean> {
    const result = await this.sql.query(String.raw`
      UPDATE outbox_events SET published_at = $3, locked_by = NULL, locked_until = NULL
      WHERE id = $1::bigint AND locked_by = $2 AND published_at IS NULL
    `, [id, workerId, publishedAt])
    return result.rowCount === 1
  }

  async release(id: string, workerId: string, retryAt: Date): Promise<boolean> {
    const result = await this.sql.query(String.raw`
      UPDATE outbox_events SET available_at = $3, locked_by = NULL, locked_until = NULL
      WHERE id = $1::bigint AND locked_by = $2 AND published_at IS NULL
    `, [id, workerId, retryAt])
    return result.rowCount === 1
  }

  async prune(
    publishedBefore: Date,
    unpublishedBefore: Date,
    now: Date,
    requestedLimit: number
  ): Promise<{ published: number; expired: number }> {
    const limit = boundedLimit(requestedLimit, QUERY_LIMITS.outboxPrune)
    for (const [name, value] of [
      ['publishedBefore', publishedBefore],
      ['unpublishedBefore', unpublishedBefore],
      ['now', now]
    ] as const) {
      if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
        throw new RangeError(`${name} must be a valid Date`)
      }
    }
    const result = await this.sql.query<OutboxPruneRow>(String.raw`
      WITH victims AS MATERIALIZED (
        SELECT id
        FROM outbox_events
        WHERE (published_at IS NOT NULL AND published_at <= $1)
          OR (published_at IS NULL AND created_at <= $2
            AND (locked_until IS NULL OR locked_until <= $3))
        ORDER BY COALESCE(published_at, created_at), id
        LIMIT $4
        FOR UPDATE SKIP LOCKED
      ), deleted AS (
        DELETE FROM outbox_events event
        USING victims
        WHERE event.id = victims.id
        RETURNING event.published_at
      )
      SELECT
        COUNT(*) FILTER (WHERE published_at IS NOT NULL)::text AS published_count,
        COUNT(*) FILTER (WHERE published_at IS NULL)::text AS expired_count
      FROM deleted
    `, [publishedBefore, unpublishedBefore, now, limit])
    return {
      published: Number(result.rows[0]?.published_count ?? 0),
      expired: Number(result.rows[0]?.expired_count ?? 0)
    }
  }
}

class PgOperationMarkers implements OperationMarkerRepository {
  private readonly sql: SqlExecutor

  constructor(sql: SqlExecutor) {
    this.sql = sql
  }

  async add(playerId: string, kind: string, markerKey: string, observedAt: Date): Promise<void> {
    await this.sql.query(String.raw`
      INSERT INTO operation_markers(player_id, kind, marker_key, observed_at)
      VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING
    `, [playerId, kind, markerKey, observedAt])
  }

  async has(playerId: string, kind: string, markerKey: string): Promise<boolean> {
    const result = await this.sql.query(
      'SELECT 1 FROM operation_markers WHERE player_id = $1 AND kind = $2 AND marker_key = $3',
      [playerId, kind, markerKey]
    )
    return result.rowCount === 1
  }

  async pruneBefore(before: Date, requestedLimit: number): Promise<number> {
    if (!(before instanceof Date) || !Number.isFinite(before.getTime())) {
      throw new RangeError('before must be a valid Date')
    }
    const limit = boundedLimit(requestedLimit, QUERY_LIMITS.operationMarkerPrune)
    const result = await this.sql.query(String.raw`
      WITH victims AS (
        SELECT player_id, kind, marker_key
        FROM operation_markers
        WHERE observed_at < $1
        ORDER BY observed_at, player_id, kind, marker_key
        LIMIT $2
        FOR UPDATE SKIP LOCKED
      )
      DELETE FROM operation_markers marker
      USING victims
      WHERE marker.player_id = victims.player_id
        AND marker.kind = victims.kind
        AND marker.marker_key = victims.marker_key
    `, [before, limit])
    return result.rowCount ?? 0
  }
}

class PgBalanceLedger implements BalanceLedgerRepository {
  private readonly sql: SqlExecutor

  constructor(sql: SqlExecutor) {
    this.sql = sql
  }

  async append(record: BalanceLedgerRecord): Promise<'inserted' | 'duplicate'> {
    const result = await this.sql.query(String.raw`
      INSERT INTO balance_ledger(
        player_id, operation, request_id, currency, delta, balance_after, metadata, created_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      ON CONFLICT (player_id, operation, request_id, currency) DO NOTHING
      RETURNING id
    `, [
      record.playerId,
      record.operation,
      record.requestId,
      record.currency,
      record.delta,
      record.balanceAfter,
      record.metadata,
      record.createdAt
    ])
    if (result.rowCount === 1) return 'inserted'
    const same = await this.sql.query(String.raw`
      SELECT 1 FROM balance_ledger
      WHERE player_id = $1 AND operation = $2 AND request_id = $3 AND currency = $4
        AND delta = $5 AND balance_after = $6 AND metadata = $7::jsonb
    `, [
      record.playerId,
      record.operation,
      record.requestId,
      record.currency,
      record.delta,
      record.balanceAfter,
      record.metadata
    ])
    if (same.rowCount !== 1) throw new PersistenceConflictError('Balance ledger key was reused with a different effect')
    return 'duplicate'
  }

  async sumSince(
    playerId: string,
    operation: string,
    currency: BalanceLedgerRecord['currency'],
    since: Date
  ): Promise<number> {
    const result = await this.sql.query<{ total: string | number }>(String.raw`
      SELECT COALESCE(SUM(delta), 0) AS total
      FROM balance_ledger
      WHERE player_id = $1 AND operation = $2 AND currency = $3 AND created_at >= $4
    `, [playerId, operation, currency, since])
    return Number(result.rows[0]?.total ?? 0)
  }

  async summarizeDays(fromDay: number, throughDay: number): Promise<BalanceLedgerDaySummary[]> {
    if (!Number.isSafeInteger(fromDay) || !Number.isSafeInteger(throughDay)
      || fromDay > throughDay || throughDay - fromDay >= 30) {
      throw new RangeError('Economy ledger window must contain at most 30 ordered days')
    }
    const from = new Date(fromDay * 86_400_000)
    const through = new Date((throughDay + 1) * 86_400_000)
    const result = await this.sql.query<{
      day: number | string
      operation: string
      currency: BalanceLedgerRecord['currency']
      positive: number | string
      negative: number | string
      operation_count: number | string
    }>(String.raw`
      SELECT
        floor(extract(epoch FROM created_at) / 86400)::integer AS day,
        operation,
        currency,
        COALESCE(SUM(delta) FILTER (WHERE delta > 0), 0) AS positive,
        COALESCE(-SUM(delta) FILTER (WHERE delta < 0), 0) AS negative,
        COUNT(DISTINCT (player_id, request_id)) AS operation_count
      FROM balance_ledger
      WHERE created_at >= $1 AND created_at < $2
      GROUP BY day, operation, currency
      ORDER BY day DESC, operation, currency
    `, [from, through])
    return result.rows.map(row => ({
      day: Number(row.day),
      operation: row.operation,
      currency: row.currency,
      positive: Number(row.positive),
      negative: Number(row.negative),
      operationCount: Number(row.operation_count)
    }))
  }
}

export class PostgresUnitOfWork implements UnitOfWork {
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

  constructor(sql: SqlExecutor) {
    this.accounts = new PgAccounts(sql)
    this.sessions = new PgSessions(sql)
    this.villages = new PgVillages(sql)
    this.world = new PgWorld(sql)
    this.attacks = new PgAttacks(sql)
    this.replays = new PgReplays(sql)
    this.notifications = new PgNotifications(sql)
    this.idempotency = new PgIdempotency(sql)
    this.outbox = new PgOutbox(sql)
    this.operationMarkers = new PgOperationMarkers(sql)
    this.balanceLedger = new PgBalanceLedger(sql)
  }
}
