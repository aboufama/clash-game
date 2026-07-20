import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import {
  allocationOrdinalOf,
  coordinateAtAllocationOrdinal
} from '../domain/world/allocation'
import { persistentBotVillageIdAt } from '../domain/world/bot-village-identity'
import { regionAddressForPlot } from '../domain/world/coordinates'
import {
  INITIAL_WORLD_PRESENTATION_SEED_VERSION,
  isSpiralSettleable,
  LEGACY_WORLD_COORD_LIMIT,
  normalizeWorldPresentationSeedVersion
} from '../domain/world/generation'
import { VILLAGE_SIMULATION_VERSION } from '../domain/village/simulation'
import { assertAttackInvariants } from '../attack-domain/domain'
import type { AttackAggregate } from '../attack-domain/types'
import { sanitizeVillageBanner } from '../../src/game/data/Models'
import {
  LEGACY_COLLECTIONS,
  verifyFrozenLegacySnapshot,
  type LegacyCollection
} from './legacy-snapshot'
import type { AttackRecord, BotVillageRecord, JsonObject, JsonValue } from './model'
import {
  attackCommandsFromAuthority,
  attackRecordFromAuthority
} from './attack-authority'
import type { SqlDatabase, SqlExecutor } from './postgres/database'
import { PostgresUnitOfWork } from './postgres/repositories'

const MAX_WORLD_ALLOCATION_ORDINAL = 4_000_004_000_000

export interface LegacySourceRecord {
  collection: LegacyCollection
  key: string
  sha256: string
  value: JsonObject
}

export interface ImportIssue {
  severity: 'error' | 'warning'
  code: string
  record: string
  message: string
}

export interface LegacyImportPlan {
  dataRoot: string
  cutoffAt: Date
  records: LegacySourceRecord[]
  issues: ImportIssue[]
  counts: Record<LegacyCollection, number>
}

export interface LegacyImportResult {
  importedAt: Date
  counts: Record<LegacyCollection, number>
  sessions: number
  plots: number
  operationMarkers: number
  replayChunks: number
  attackCommands: number
}

export interface LegacyVerificationReport {
  ok: boolean
  issues: string[]
  sourceRecords: number
  importedRecords: number
}

function isObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function object(value: JsonValue | undefined): JsonObject {
  return isObject(value) ? value : {}
}

function array(value: JsonValue | undefined): JsonValue[] {
  return Array.isArray(value) ? value : []
}

function string(value: JsonValue | undefined, fallback = ''): string {
  return typeof value === 'string' ? value : fallback
}

function number(value: JsonValue | undefined, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function integer(value: JsonValue | undefined, fallback = 0): number {
  return Math.trunc(number(value, fallback))
}

function millis(value: JsonValue | undefined, fallback: Date): Date {
  const parsed = number(value, NaN)
  return Number.isFinite(parsed) ? new Date(parsed) : new Date(fallback)
}

function nullableMillis(value: JsonValue | undefined): Date | null {
  const parsed = number(value, NaN)
  return Number.isFinite(parsed) && parsed > 0 ? new Date(parsed) : null
}

function authorityFromSource(source: JsonObject): AttackAggregate | null {
  if (source.authority === undefined || source.authority === null) return null
  if (!isObject(source.authority)) throw new Error('Attack authority must be a JSON object')
  const authority = structuredClone(source.authority) as unknown as AttackAggregate
  assertAttackInvariants(authority)
  return authority
}

function validateAttackAuthority(record: LegacySourceRecord, issues: ImportIssue[]): void {
  if (record.value.authority === undefined || record.value.authority === null) return
  try {
    const authority = authorityFromSource(record.value)
    if (!authority) return
    const source = record.value
    const expectedId = record.collection === 'replays' ? string(source.attackId) : string(source.raidId)
    const expectedKind = record.collection === 'replays' ? 'PLAYER' : 'BOT'
    if (authority.attackId !== expectedId || authority.attackerId !== string(source.attackerId)) {
      throw new Error('Aggregate identity differs from the legacy record')
    }
    if (authority.target.kind !== expectedKind) {
      throw new Error(`Legacy ${record.collection} record must contain ${expectedKind} authority`)
    }
    if (expectedKind === 'PLAYER'
      && authority.target.kind === 'PLAYER'
      && authority.target.playerId !== string(source.victimId)) {
      throw new Error('Aggregate defender differs from the legacy replay')
    }
    if (authority.target.plot.x !== integer(expectedKind === 'PLAYER' ? source.victimPlotX : source.x)
      || authority.target.plot.y !== integer(expectedKind === 'PLAYER' ? source.victimPlotY : source.y)) {
      throw new Error('Aggregate target coordinates differ from the legacy record')
    }
    if (authority.target.kind === 'BOT' && authority.target.seed !== integer(source.seed)) {
      throw new Error('Aggregate bot seed differs from the legacy raid')
    }
    const status = source.status
    const terminalMatches = status === 'finished'
      ? authority.phase === 'SETTLED'
      : status === 'aborted'
        ? authority.phase === 'CANCELLED' || authority.phase === 'EXPIRED'
        : true
    if (!terminalMatches) throw new Error(`Legacy status ${String(status)} disagrees with aggregate phase ${authority.phase}`)
  } catch (error) {
    pushIssue(
      issues,
      record,
      'error',
      'ATTACK_AUTHORITY',
      error instanceof Error ? error.message : String(error)
    )
  }
}

function recordName(record: LegacySourceRecord): string {
  return `${record.collection}/${record.key}`
}

function pushIssue(
  issues: ImportIssue[],
  record: LegacySourceRecord,
  severity: ImportIssue['severity'],
  code: string,
  message: string
): void {
  issues.push({ severity, code, record: recordName(record), message })
}

function readCollection(dataRoot: string, collection: LegacyCollection, issues: ImportIssue[]): LegacySourceRecord[] {
  const directory = path.join(dataRoot, collection)
  if (!existsSync(directory)) return []
  const records: LegacySourceRecord[] = []
  for (const filename of readdirSync(directory).filter(name => name.endsWith('.json')).sort()) {
    const key = filename.slice(0, -'.json'.length)
    const raw = readFileSync(path.join(directory, filename), 'utf8')
    let value: unknown
    try {
      value = JSON.parse(raw)
    } catch (error) {
      issues.push({
        severity: 'error',
        code: 'INVALID_JSON',
        record: `${collection}/${key}`,
        message: error instanceof Error ? error.message : 'JSON parsing failed'
      })
      continue
    }
    if (!isObject(value)) {
      issues.push({
        severity: 'error',
        code: 'INVALID_RECORD',
        record: `${collection}/${key}`,
        message: 'Top-level JSON value must be an object'
      })
      continue
    }
    records.push({
      collection,
      key,
      sha256: createHash('sha256').update(raw).digest('hex'),
      value
    })
  }
  return records
}

function validatePlayer(
  record: LegacySourceRecord,
  issues: ImportIssue[],
  playerIds: Set<string>,
  usernames: Map<string, string>,
  tokens: Map<string, string>,
  plots: Map<string, string>,
  cutoffAt: Date,
  generationVersion: number,
  presentationSeedVersion: number
): void {
  const value = record.value
  const id = string(value.id)
  if (!id || id !== record.key) pushIssue(issues, record, 'error', 'PLAYER_ID', 'Player id must match its filename')
  if (playerIds.has(id)) pushIssue(issues, record, 'error', 'DUPLICATE_PLAYER', `Duplicate player id ${id}`)
  playerIds.add(id)
  if (!string(value.username).trim()) pushIssue(issues, record, 'error', 'USERNAME', 'Username is required')
  if (!Array.isArray(value.buildings)) pushIssue(issues, record, 'error', 'BUILDINGS', 'Buildings must be an array')
  if (!Array.isArray(value.obstacles)) pushIssue(issues, record, 'error', 'OBSTACLES', 'Obstacles must be an array')
  if (!isObject(value.army)) pushIssue(issues, record, 'error', 'ARMY', 'Army must be an object')
  for (const field of ['createdAt', 'lastSeen', 'lastAccrualAt', 'lastMutationAt', 'revision', 'balance', 'ore', 'food'] as const) {
    if (typeof value[field] !== 'number' || !Number.isFinite(value[field])) {
      pushIssue(issues, record, 'error', 'NUMBER_FIELD', `${field} must be a finite number`)
    }
  }
  if (number(value.balance, -1) < 0 || number(value.ore, -1) < 0 || number(value.food, -1) < 0) {
    pushIssue(issues, record, 'error', 'NEGATIVE_RESOURCE', 'Resources cannot be negative')
  }
  const usernameKey = string(value.usernameKey)
  const passwordHash = string(value.passwordHash)
  if ((usernameKey.length > 0) !== (passwordHash.length > 0)) {
    pushIssue(issues, record, 'error', 'REGISTRATION_FIELDS', 'Registered accounts require both usernameKey and passwordHash')
  }
  if (usernameKey) {
    const owner = usernames.get(usernameKey)
    if (owner && owner !== id) pushIssue(issues, record, 'error', 'DUPLICATE_USERNAME', `${usernameKey} is also owned by ${owner}`)
    usernames.set(usernameKey, id)
  }
  const tokenHashes = array(value.tokenHashes)
  if (tokenHashes.length === 0) pushIssue(issues, record, 'warning', 'NO_SESSION', 'Player has no active session')
  for (const item of tokenHashes) {
    if (typeof item !== 'string' || !/^[0-9a-f]{64}$/.test(item)) {
      pushIssue(issues, record, 'error', 'TOKEN_HASH', 'Every token hash must be 64 lowercase hexadecimal characters')
      continue
    }
    const owner = tokens.get(item)
    if (owner && owner !== id) pushIssue(issues, record, 'error', 'DUPLICATE_TOKEN', `Token is also owned by ${owner}`)
    tokens.set(item, id)
  }
  const x = value.plotX
  const y = value.plotY
  if ((x === undefined) !== (y === undefined) || (x !== undefined && (!Number.isInteger(x) || !Number.isInteger(y)))) {
    pushIssue(issues, record, 'error', 'PLOT', 'Plot coordinates must be an integer pair or both absent')
  } else if (typeof x === 'number' && typeof y === 'number') {
    if (Math.abs(x) > LEGACY_WORLD_COORD_LIMIT || Math.abs(y) > LEGACY_WORLD_COORD_LIMIT) {
      pushIssue(
        issues,
        record,
        'error',
        'LEGACY_PLOT_RANGE',
        `Legacy plot coordinates must remain within +/-${LEGACY_WORLD_COORD_LIMIT}`
      )
    } else if (!isSpiralSettleable({ x, y }, generationVersion, presentationSeedVersion)) {
      pushIssue(
        issues,
        record,
        'error',
        'INELIGIBLE_PLAYER_PLOT',
        `Legacy player occupies protected plot ${x},${y}`
      )
    }
    const key = `${x},${y}`
    const owner = plots.get(key)
    if (owner && owner !== id) pushIssue(issues, record, 'error', 'DUPLICATE_PLOT', `Plot ${key} is also owned by ${owner}`)
    plots.set(key, id)
    const plotVersion = number(value.plotVersion, 1)
    if (!Number.isSafeInteger(plotVersion) || plotVersion < 1) {
      pushIssue(issues, record, 'error', 'PLOT_VERSION', 'plotVersion must be a positive safe integer')
    }
  }
  const accrualAt = number(value.lastAccrualAt, 0)
  if (accrualAt > cutoffAt.getTime()) {
    pushIssue(issues, record, 'error', 'FUTURE_CHECKPOINT', 'lastAccrualAt is after the selected cutover')
  } else if (accrualAt !== cutoffAt.getTime()) {
    pushIssue(
      issues,
      record,
      'error',
      'UNMATERIALIZED_PLAYER',
      'Village must be materialized at the exact cutover before import'
    )
  }
  if (number(value.simulatedThrough, -1) !== cutoffAt.getTime()) {
    pushIssue(issues, record, 'error', 'SIMULATION_CHECKPOINT', 'simulatedThrough must equal the exact cutover')
  }
  if (integer(value.simulationVersion, -1) !== VILLAGE_SIMULATION_VERSION) {
    pushIssue(
      issues,
      record,
      'error',
      'SIMULATION_VERSION',
      `simulationVersion must be ${VILLAGE_SIMULATION_VERSION}`
    )
  }
  for (const field of ['layoutRevision', 'appearanceRevision'] as const) {
    const revision = number(value[field], -1)
    if (!Number.isSafeInteger(revision) || revision < 0) {
      pushIssue(issues, record, 'error', 'VILLAGE_REVISION', `${field} must be a non-negative safe integer`)
    }
  }
  if (value.nextEventAt !== undefined
    && (typeof value.nextEventAt !== 'number'
      || !Number.isFinite(value.nextEventAt)
      || value.nextEventAt < cutoffAt.getTime())) {
    pushIssue(issues, record, 'error', 'NEXT_SIMULATION_EVENT', 'nextEventAt must be at or after the cutover')
  }
}

function validateBotVillages(
  records: LegacySourceRecord[],
  issues: ImportIssue[],
  cutoffAt: Date
): void {
  const bots = records.filter(record => record.collection === 'bot-villages')
  const coordinates = new Map<string, string>()
  const worldState = records.find(record => record.collection === 'world-state' && record.key === 'main')
  const expectedPresentationSeedVersion = normalizeWorldPresentationSeedVersion(
    worldState?.value.presentationSeedVersion
  )
  for (const record of bots) {
    const source = record.value
    const id = string(source.id)
    const worldId = string(source.worldId)
    const x = number(source.x, NaN)
    const y = number(source.y, NaN)
    if (!id || id !== record.key) {
      pushIssue(issues, record, 'error', 'BOT_VILLAGE_ID', 'Bot village id must match its filename')
    }
    if (worldId !== 'main') {
      pushIssue(issues, record, 'error', 'BOT_VILLAGE_WORLD', 'Legacy bot village must belong to the main world')
    }
    if (!Number.isSafeInteger(x) || !Number.isSafeInteger(y)
      || Math.abs(x) > LEGACY_WORLD_COORD_LIMIT || Math.abs(y) > LEGACY_WORLD_COORD_LIMIT) {
      pushIssue(issues, record, 'error', 'BOT_VILLAGE_COORDINATE', 'Bot village coordinates are outside the legacy world')
    } else {
      const expectedId = persistentBotVillageIdAt(worldId, x, y)
      if (id !== expectedId) {
        pushIssue(issues, record, 'error', 'BOT_VILLAGE_IDENTITY', 'Bot village id is not scoped to its world coordinate')
      }
      const coordinate = `${worldId}:${x},${y}`
      const prior = coordinates.get(coordinate)
      if (prior && prior !== id) {
        pushIssue(issues, record, 'error', 'DUPLICATE_BOT_VILLAGE', `Coordinate ${coordinate} is also owned by ${prior}`)
      }
      coordinates.set(coordinate, id)
    }
    for (const field of [
      'plotVersion',
      'worldGenerationVersion',
      'generatorVersion',
      'seed',
      'revision'
    ] as const) {
      const value = number(source[field], NaN)
      if (!Number.isSafeInteger(value) || value < 1) {
        pushIssue(issues, record, 'error', 'BOT_VILLAGE_PROVENANCE', `${field} must be a positive safe integer`)
      }
    }
    const presentationSeedVersion = number(source.presentationSeedVersion, NaN)
    if (!Number.isSafeInteger(presentationSeedVersion) || presentationSeedVersion < 0) {
      pushIssue(
        issues,
        record,
        'error',
        'BOT_VILLAGE_PRESENTATION_SEED',
        'presentationSeedVersion must be a non-negative safe integer'
      )
    } else if (presentationSeedVersion !== expectedPresentationSeedVersion) {
      pushIssue(
        issues,
        record,
        'error',
        'BOT_VILLAGE_PRESENTATION_SEED',
        `Bot village epoch ${presentationSeedVersion} differs from world epoch ${expectedPresentationSeedVersion}`
      )
    }
    if (!string(source.username).trim()) {
      pushIssue(issues, record, 'error', 'BOT_VILLAGE_USERNAME', 'Bot village username is required')
    }
    const trophies = number(source.trophies, NaN)
    if (!Number.isSafeInteger(trophies) || trophies < 0) {
      pushIssue(issues, record, 'error', 'BOT_VILLAGE_TROPHIES', 'Bot village trophies must be a non-negative safe integer')
    }
    if (!isObject(source.profile)) {
      pushIssue(issues, record, 'error', 'BOT_VILLAGE_PROFILE', 'Bot village profile must be an object')
    }
    const world = source.world
    if (!isObject(world)) {
      pushIssue(issues, record, 'error', 'BOT_VILLAGE_PAYLOAD', 'Bot village world must be an object')
    } else {
      if (string(world.id) !== id || string(world.ownerId) !== id) {
        pushIssue(issues, record, 'error', 'BOT_VILLAGE_PAYLOAD_ID', 'Bot village world must be self-owned')
      }
      if (!Array.isArray(world.buildings)) {
        pushIssue(issues, record, 'error', 'BOT_VILLAGE_BUILDINGS', 'Bot village buildings must be an array')
      }
      if (world.obstacles !== undefined && !Array.isArray(world.obstacles)) {
        pushIssue(issues, record, 'error', 'BOT_VILLAGE_OBSTACLES', 'Bot village obstacles must be an array when present')
      }
      if (!isObject(world.resources)) {
        pushIssue(issues, record, 'error', 'BOT_VILLAGE_RESOURCES', 'Bot village resources must be an object')
      } else {
        for (const resource of ['gold', 'ore', 'food'] as const) {
          if (world.resources[resource] === undefined && resource !== 'gold') continue
          const amount = number(world.resources[resource], NaN)
          if (!Number.isFinite(amount) || amount < 0) {
            pushIssue(issues, record, 'error', 'BOT_VILLAGE_RESOURCES', `${resource} must be non-negative`)
          }
        }
      }
      const worldRevision = number(world.revision, NaN)
      if (!Number.isSafeInteger(worldRevision) || worldRevision !== number(source.revision, NaN)) {
        pushIssue(issues, record, 'error', 'BOT_VILLAGE_REVISION', 'Bot village record and world revisions must match')
      }
      const lastSaveTime = number(world.lastSaveTime, NaN)
      if (!Number.isFinite(lastSaveTime) || lastSaveTime < 0 || lastSaveTime > cutoffAt.getTime()) {
        pushIssue(issues, record, 'error', 'BOT_VILLAGE_CHECKPOINT', 'Bot village lastSaveTime is outside the cutover')
      }
    }
    const createdAt = number(source.createdAt, NaN)
    const updatedAt = number(source.updatedAt, NaN)
    if (!Number.isFinite(createdAt) || !Number.isFinite(updatedAt)
      || createdAt < 0 || updatedAt < createdAt || updatedAt > cutoffAt.getTime()) {
      pushIssue(issues, record, 'error', 'BOT_VILLAGE_TIMESTAMP', 'Bot village timestamps are invalid at the cutover')
    }
  }
}

function validateWorldStates(
  records: LegacySourceRecord[],
  issues: ImportIssue[],
  plots: Map<string, string>
): void {
  const states = records.filter(record => record.collection === 'world-state')
  if (states.length > 1) {
    for (const record of states) pushIssue(issues, record, 'error', 'WORLD_STATE_COUNT', 'Only the main world is importable')
  }
  for (const record of states) {
    const allocation = object(record.value.allocation)
    const generationVersion = integer(allocation.currentGenerationVersion, 1)
    const presentationSeedVersion = normalizeWorldPresentationSeedVersion(record.value.presentationSeedVersion)
    if (record.key !== 'main' || string(allocation.worldId) !== 'main') {
      pushIssue(issues, record, 'error', 'WORLD_STATE_ID', 'World allocation record must be main')
    }
    if (integer(allocation.schemaVersion) !== 1
      || integer(allocation.regionSize) !== 32
      || integer(allocation.currentGenerationVersion) !== 1) {
      pushIssue(
        issues,
        record,
        'error',
        'WORLD_STATE_VERSION',
        'Legacy PostgreSQL cutover requires allocation schema 1, region size 32, and generation 1'
      )
    }
    if (presentationSeedVersion !== INITIAL_WORLD_PRESENTATION_SEED_VERSION) {
      pushIssue(
        issues,
        record,
        'error',
        'WORLD_PRESENTATION_SEED',
        'PostgreSQL cutover requires production presentation epoch zero; reseeded development worlds must be reset first'
      )
    }
    const nextOrdinal = number(allocation.nextOrdinal, -1)
    if (!Number.isSafeInteger(nextOrdinal) || nextOrdinal < 0 || nextOrdinal > MAX_WORLD_ALLOCATION_ORDINAL + 1) {
      pushIssue(issues, record, 'error', 'WORLD_NEXT_ORDINAL', 'World nextOrdinal is outside the allocation envelope')
      continue
    }
    const occupied = new Set<number>()
    for (const key of plots.keys()) {
      const [x, y] = key.split(',').map(Number)
      try { occupied.add(allocationOrdinalOf({ x, y })) } catch { /* player range validation reports this */ }
    }
    const maximumOccupied = occupied.size > 0 ? Math.max(...occupied) : -1
    if (nextOrdinal <= maximumOccupied) {
      pushIssue(issues, record, 'error', 'WORLD_FRONTIER', 'World nextOrdinal must be beyond every occupied plot')
    }
    const released = new Set<number>()
    for (const rawSlot of array(record.value.releasedSlots)) {
      if (!isObject(rawSlot)) {
        pushIssue(issues, record, 'error', 'WORLD_RELEASED_SLOT', 'Every released slot must be an object')
        continue
      }
      const ordinal = number(rawSlot.ordinal, -1)
      const plotVersion = number(rawSlot.plotVersion, -1)
      if (!Number.isSafeInteger(ordinal) || ordinal < 0 || ordinal > MAX_WORLD_ALLOCATION_ORDINAL || ordinal >= nextOrdinal
        || !Number.isSafeInteger(plotVersion) || plotVersion < 1) {
        pushIssue(issues, record, 'error', 'WORLD_RELEASED_SLOT', 'Released slot ordinal/version is invalid')
        continue
      }
      if (released.has(ordinal)) {
        pushIssue(issues, record, 'error', 'WORLD_RELEASED_DUPLICATE', `Released ordinal ${ordinal} is duplicated`)
        continue
      }
      released.add(ordinal)
      if (occupied.has(ordinal)) {
        pushIssue(issues, record, 'error', 'WORLD_RELEASED_OCCUPIED', `Released ordinal ${ordinal} is occupied`)
      } else if (!isSpiralSettleable(
        coordinateAtAllocationOrdinal(ordinal),
        generationVersion,
        presentationSeedVersion
      )) {
        pushIssue(issues, record, 'error', 'WORLD_RELEASED_INELIGIBLE', `Released ordinal ${ordinal} is protected`)
      }
    }
  }
}

function validateReference(
  record: LegacySourceRecord,
  issues: ImportIssue[],
  playerIds: Set<string>,
  field: string
): void {
  const id = string(record.value[field])
  if (!id || !playerIds.has(id)) pushIssue(issues, record, 'error', 'MISSING_PLAYER', `${field} references missing player ${id || '<empty>'}`)
}

function validateRelationships(records: LegacySourceRecord[], issues: ImportIssue[], playerIds: Set<string>): void {
  const attackIds = new Set<string>()
  for (const record of records) {
    if (record.collection === 'replays') {
      const id = string(record.value.attackId)
      if (!id || id !== record.key) pushIssue(issues, record, 'error', 'ATTACK_ID', 'Attack id must match its filename')
      if (attackIds.has(id)) pushIssue(issues, record, 'error', 'DUPLICATE_ATTACK', `Duplicate attack id ${id}`)
      attackIds.add(id)
      validateReference(record, issues, playerIds, 'attackerId')
      validateReference(record, issues, playerIds, 'victimId')
      if (record.value.status !== 'finished' && record.value.status !== 'aborted') {
        pushIssue(issues, record, 'error', 'LIVE_ATTACK', 'Drain or abort all live attacks before cutover')
      }
      validateAttackAuthority(record, issues)
    }
    if (record.collection === 'bot-raids') {
      if (string(record.value.raidId) !== record.key) pushIssue(issues, record, 'error', 'RAID_ID', 'Raid id must match its filename')
      validateReference(record, issues, playerIds, 'attackerId')
      if (record.value.status !== 'finished' && record.value.status !== 'aborted') {
        pushIssue(issues, record, 'error', 'LIVE_BOT_RAID', 'Drain or abort all live bot raids before cutover')
      }
      validateAttackAuthority(record, issues)
    }
  }
  for (const record of records) {
    if (record.collection === 'settlements') {
      const attackId = string(record.value.attackId)
      if (!attackId || attackId !== record.key) pushIssue(issues, record, 'error', 'SETTLEMENT_ID', 'Settlement id must match its filename')
      if (!attackIds.has(attackId)) pushIssue(issues, record, 'error', 'MISSING_ATTACK', `Settlement references missing attack ${attackId}`)
    }
    if (record.collection === 'notifications' && !playerIds.has(record.key)) {
      pushIssue(issues, record, 'error', 'MISSING_NOTIFICATION_OWNER', 'Notification collection owner no longer exists')
    }
  }
}

export function buildLegacyImportPlan(dataRoot: string, cutoffAt: Date): LegacyImportPlan {
  if (!Number.isFinite(cutoffAt.getTime())) throw new Error('Cutover timestamp is invalid')
  const resolvedRoot = path.resolve(dataRoot)
  const issues: ImportIssue[] = []
  const records = LEGACY_COLLECTIONS.flatMap(collection => readCollection(resolvedRoot, collection, issues))
  const playerIds = new Set<string>()
  const usernames = new Map<string, string>()
  const tokens = new Map<string, string>()
  const plots = new Map<string, string>()
  const storedWorld = records.find(record => record.collection === 'world-state' && record.key === 'main')
  const storedAllocation = object(storedWorld?.value.allocation)
  const generationVersion = integer(storedAllocation.currentGenerationVersion, 1)
  const presentationSeedVersion = normalizeWorldPresentationSeedVersion(storedWorld?.value.presentationSeedVersion)
  for (const record of records) {
    if (record.collection === 'players') {
      validatePlayer(
        record,
        issues,
        playerIds,
        usernames,
        tokens,
        plots,
        cutoffAt,
        generationVersion,
        presentationSeedVersion
      )
    }
  }
  validateBotVillages(records, issues, cutoffAt)
  validateRelationships(records, issues, playerIds)
  validateWorldStates(records, issues, plots)
  for (const message of verifyFrozenLegacySnapshot(resolvedRoot, cutoffAt)) {
    issues.push({ severity: 'error', code: 'FROZEN_SNAPSHOT', record: '<snapshot>', message })
  }
  issues.sort((a, b) => a.severity.localeCompare(b.severity) || a.record.localeCompare(b.record) || a.code.localeCompare(b.code))
  return {
    dataRoot: resolvedRoot,
    cutoffAt: new Date(cutoffAt),
    records,
    issues,
    counts: Object.fromEntries(LEGACY_COLLECTIONS.map(collection => [
      collection,
      records.filter(record => record.collection === collection).length
    ])) as Record<LegacyCollection, number>
  }
}

function playerAccount(record: LegacySourceRecord) {
  const source = record.value
  const usernameKey = string(source.usernameKey).trim() || null
  const passwordHash = string(source.passwordHash) || null
  return {
    id: string(source.id),
    username: string(source.username),
    usernameKey,
    passwordHash,
    registered: usernameKey !== null && passwordHash !== null,
    trophies: Math.max(0, integer(source.trophies)),
    shieldUntil: nullableMillis(source.shieldUntil),
    createdAt: millis(source.createdAt, new Date(0)),
    lastSeenAt: millis(source.lastSeen, new Date(0)),
    revision: Math.max(0, integer(source.revision)),
    revengeRights: object(source.revengeRights),
    botRaidCooldowns: object(source.botRaids)
  }
}

function playerVillage(record: LegacySourceRecord) {
  const source = record.value
  const remainder = object(source.productionRemainders)
  return {
    playerId: string(source.id),
    buildings: array(source.buildings),
    obstacles: array(source.obstacles),
    army: object(source.army),
    wallLevel: Math.max(1, integer(source.wallLevel, 1)),
    gold: Math.max(0, number(source.balance)),
    ore: Math.max(0, integer(source.ore)),
    food: Math.max(0, integer(source.food)),
    productionRemainders: {
      ore: Math.max(0, Math.min(0.999999, number(remainder.ore))),
      food: Math.max(0, Math.min(0.999999, number(remainder.food)))
    },
    population: object(source.population),
    banner: sanitizeVillageBanner(source.banner),
    simulatedThrough: millis(source.simulatedThrough, new Date(0)),
    lastMutationAt: millis(source.lastMutationAt, new Date(0)),
    layoutRevision: Math.max(0, integer(source.layoutRevision, integer(source.revision))),
    appearanceRevision: Math.max(0, integer(source.appearanceRevision, integer(source.revision))),
    economyRevision: Math.max(0, integer(source.revision)),
    simulationVersion: Math.max(1, integer(source.simulationVersion, VILLAGE_SIMULATION_VERSION)),
    nextEventAt: nullableMillis(source.nextEventAt)
  }
}

/** Lossless canonical mapping for one already-persisted legacy bot village. */
export function mapLegacyBotVillage(record: LegacySourceRecord): BotVillageRecord {
  const source = record.value
  return {
    id: string(source.id),
    worldId: string(source.worldId),
    x: integer(source.x),
    y: integer(source.y),
    plotVersion: integer(source.plotVersion),
    worldGenerationVersion: integer(source.worldGenerationVersion),
    generatorVersion: integer(source.generatorVersion),
    seed: integer(source.seed),
    username: string(source.username),
    trophies: integer(source.trophies),
    profile: structuredClone(object(source.profile)),
    world: structuredClone(object(source.world)) as unknown as BotVillageRecord['world'],
    revision: integer(source.revision),
    createdAt: millis(source.createdAt, new Date(0)),
    updatedAt: millis(source.updatedAt, new Date(0))
  }
}

async function importBotVillage(uow: PostgresUnitOfWork, record: LegacySourceRecord): Promise<void> {
  const result = await uow.world.insertBotVillage(mapLegacyBotVillage(record))
  if (result !== 'inserted') throw new Error(`Legacy bot village already exists: ${record.key}`)
}

async function importPlayer(
  uow: PostgresUnitOfWork,
  record: LegacySourceRecord,
  counters: { sessions: number; plots: number; operationMarkers: number }
): Promise<void> {
  const source = record.value
  const account = playerAccount(record)
  await uow.accounts.insert(account)
  await uow.villages.insert(playerVillage(record))
  for (const token of array(source.tokenHashes)) {
    if (typeof token !== 'string') continue
    await uow.sessions.insert({
      tokenHash: token,
      playerId: account.id,
      createdAt: account.createdAt,
      lastUsedAt: account.lastSeenAt,
      expiresAt: new Date(account.lastSeenAt.getTime() + (account.registered ? 90 : 7) * 86_400_000),
      deviceId: null
    })
    counters.sessions += 1
  }
  if (typeof source.plotX === 'number' && typeof source.plotY === 'number') {
    const x = Math.trunc(source.plotX)
    const y = Math.trunc(source.plotY)
    const region = regionAddressForPlot({
      worldId: 'main',
      generationVersion: 1,
      coordinate: { x, y },
      size: 32
    })
    await uow.world.ensureRegion({
      worldId: region.worldId,
      regionId: region.id,
      regionX: region.x,
      regionY: region.y,
      size: region.size,
      generationVersion: region.generationVersion,
      createdAt: new Date(0)
    })
    const sourceLeaseExpiry = nullableMillis(source.plotLeaseExpiresAt)
    const leaseExpiresAt = account.registered
      ? null
      : (sourceLeaseExpiry && sourceLeaseExpiry > account.lastSeenAt
          ? sourceLeaseExpiry
          : new Date(account.lastSeenAt.getTime() + 7 * 86_400_000))
    await uow.world.assign({
      worldId: 'main',
      x,
      y,
      regionId: region.id,
      playerId: account.id,
      plotVersion: Math.max(1, integer(source.plotVersion, 1)),
      assignedAt: account.createdAt,
      leaseId: account.registered
        ? null
        : string(source.plotLeaseId) || `legacy:${createHash('sha256').update(account.id).digest('hex')}`,
      leaseIssuedAt: account.registered
        ? null
        : new Date(Math.min(account.createdAt.getTime(), account.lastSeenAt.getTime())),
      leaseRenewedAt: account.registered ? null : account.lastSeenAt,
      leaseExpiresAt
    })
    counters.plots += 1
  }
  const markerGroups: Array<[string, JsonValue | undefined]> = [
    ['legacy_request', source.requestKeys],
    ['merchant_redemption', source.merchantRedemptions],
    ['bot_settlement', source.botSettlements],
    ['battle_settlement', source.battleSettlements],
    ['attack_start', source.attackStarts]
  ]
  for (const [kind, rawMarkers] of markerGroups) {
    const entries = Array.isArray(rawMarkers)
      ? rawMarkers.map(marker => [marker, account.lastSeenAt.getTime()] as const)
      : Object.entries(object(rawMarkers))
    for (const [markerKey, rawTime] of entries) {
      if (typeof markerKey !== 'string' || !markerKey) continue
      await uow.operationMarkers.add(account.id, kind, markerKey, millis(rawTime as JsonValue, account.lastSeenAt))
      counters.operationMarkers += 1
    }
  }
}

/** Build the one-time free-slot index; future allocations never rescan legacy rings. */
async function seedLegacyWorldAllocation(
  sql: SqlExecutor,
  uow: PostgresUnitOfWork,
  importedAt: Date,
  plan: LegacyImportPlan
): Promise<void> {
  const plots = await sql.query<{ x: number; y: number }>(
    'SELECT x, y FROM world_plots WHERE world_id = $1',
    ['main']
  )
  const occupied = new Set(plots.rows.map(row => allocationOrdinalOf({ x: row.x, y: row.y })))
  const stored = plan.records.find(record => record.collection === 'world-state' && record.key === 'main')
  const storedAllocation = stored ? object(stored.value.allocation) : null
  const generationVersion = integer(storedAllocation?.currentGenerationVersion, 1)
  const presentationSeedVersion = normalizeWorldPresentationSeedVersion(stored?.value.presentationSeedVersion)
  const botRevisionEpoch = Math.max(1, integer(stored?.value.botRevisionEpoch, 1))
  const nextOrdinal = storedAllocation
    ? integer(storedAllocation.nextOrdinal)
    : (occupied.size === 0 ? 0 : Math.max(...occupied) + 1)
  const releasedSlots = stored
    ? array(stored.value.releasedSlots).filter(isObject).map(slot => ({
      ordinal: integer(slot.ordinal),
      plotVersion: integer(slot.plotVersion, 1)
    }))
    : Array.from({ length: nextOrdinal }, (_, ordinal) => ({ ordinal, plotVersion: 1 }))
      .filter(slot => !occupied.has(slot.ordinal)
        && isSpiralSettleable(
          coordinateAtAllocationOrdinal(slot.ordinal),
          generationVersion,
          presentationSeedVersion
        ))
  for (const slot of releasedSlots) {
    await uow.world.putReleasedSlot({
      worldId: 'main',
      ordinal: slot.ordinal,
      plotVersion: slot.plotVersion,
      releasedAt: importedAt
    })
  }
  const allocation = await uow.world.getAllocation('main', { forUpdate: true })
  if (!allocation) throw new Error('Migrated database is missing the main world allocation row')
  if (!await uow.world.updateAllocation({
    ...allocation,
    nextOrdinal,
    botRevisionEpoch,
    revision: allocation.revision + 1,
    updatedAt: importedAt
  }, allocation.revision)) {
    throw new Error('Main world allocation changed during the frozen legacy import')
  }
}

function terminalState(status: JsonValue | undefined): AttackRecord['state'] {
  if (status === 'finished') return 'settled'
  if (status === 'aborted') return 'cancelled'
  return 'active'
}

function attachImportedAuthority(
  base: AttackRecord,
  source: JsonObject,
  updatedAt: Date,
  expectedKind: 'PLAYER' | 'BOT'
): AttackRecord {
  const authority = authorityFromSource(source)
  if (!authority) return base
  if (authority.attackId !== base.id || authority.attackerId !== base.attackerId
    || authority.target.kind !== expectedKind) {
    throw new Error('Legacy attack authority identity does not match its source record')
  }
  if (authority.target.plot.worldId !== base.worldId
    || authority.target.plot.x !== base.targetX
    || authority.target.plot.y !== base.targetY) {
    throw new Error('Legacy attack authority plot does not match its source record')
  }
  if (authority.target.kind === 'PLAYER' && authority.target.playerId !== base.defenderId) {
    throw new Error('Legacy attack authority defender does not match its source record')
  }
  return attackRecordFromAuthority(authority, {
    fencingTokenHash: base.fencingTokenHash,
    targetPlotVersion: base.targetPlotVersion,
    updatedAt
  })
}

export function mapLegacyReplayAttack(record: LegacySourceRecord): AttackRecord {
  const source = record.value
  const state = terminalState(source.status)
  const createdAt = millis(source.startedAt, new Date(0))
  const updatedAt = millis(source.updatedAt, createdAt)
  const endedAt = state === 'active' ? null : millis(source.endedAt, updatedAt)
  const seed = createHash('sha256').update(record.key).digest('hex').slice(0, 16)
  const base: AttackRecord = {
    id: string(source.attackId),
    attackerId: string(source.attackerId),
    defenderId: string(source.victimId),
    targetKind: 'player',
    targetId: string(source.victimId),
    worldId: 'main',
    targetX: integer(source.victimPlotX),
    targetY: integer(source.victimPlotY),
    targetPlotVersion: Math.max(1, integer(source.victimPlotVersion, 1)),
    state,
    stateVersion: 0,
    simulationVersion: 1,
    seed,
    fencingTokenHash: string(source.ownerTokenHash, 'legacy'),
    defenderSnapshot: object(source.enemyWorld),
    reservedArmy: object(source.reservedArmy),
    createdAt,
    engagedAt: Object.keys(object(source.validatedDeployments)).length > 0 ? createdAt : null,
    updatedAt,
    deadlineAt: state === 'active' ? new Date(updatedAt.getTime() + 120_000) : (endedAt ?? updatedAt),
    endedAt,
    result: isObject(source.finalResult) ? source.finalResult : null,
    authority: null
  }
  return attachImportedAuthority(base, source, updatedAt, 'PLAYER')
}

async function importReplay(
  sql: SqlExecutor,
  uow: PostgresUnitOfWork,
  record: LegacySourceRecord,
  importedAt: Date
): Promise<number> {
  const attack = mapLegacyReplayAttack(record)
  await uow.attacks.insert(attack)
  for (const command of attack.authority ? attackCommandsFromAuthority(attack.authority) : []) {
    await uow.attacks.appendCommand(command)
  }
  const frames = array(record.value.frames)
  if (frames.length === 0) return 0
  const checksum = createHash('sha256').update(JSON.stringify(frames)).digest('hex')
  await sql.query(String.raw`
    INSERT INTO replay_chunks(attack_id, sequence, format, payload, object_key, checksum, created_at)
    VALUES ($1, 0, 'legacy-client-frames-v1', $2, NULL, $3, $4)
  `, [record.key, frames, checksum, importedAt])
  return 1
}

async function importSettlement(sql: SqlExecutor, record: LegacySourceRecord): Promise<void> {
  const source = record.value
  const attack = await sql.query<{ attacker_id: string; defender_id: string }>(
    'SELECT attacker_id, defender_id FROM attacks WHERE id = $1',
    [record.key]
  )
  const row = attack.rows[0]
  if (!row) throw new Error(`Settlement references missing attack ${record.key}`)
  await sql.query(String.raw`
    INSERT INTO attack_settlements(attack_id, attacker_id, defender_id, outcome, committed_at)
    VALUES ($1, $2, $3, $4, $5)
  `, [record.key, row.attacker_id, row.defender_id, source, millis(source.endedAt, new Date(0))])
}

export function mapLegacyBotRaidAttack(record: LegacySourceRecord): AttackRecord {
  const source = record.value
  const state = terminalState(source.status === 'finished' ? 'finished' : source.status)
  const createdAt = millis(source.startedAt, new Date(0))
  const deadlineAt = millis(source.expiresAt, createdAt)
  const endedAt = state === 'active' ? null : millis(object(source.preparedSettlement).settledAt, deadlineAt)
  const x = integer(source.x)
  const y = integer(source.y)
  const base: AttackRecord = {
    id: record.key,
    attackerId: string(source.attackerId),
    defenderId: null,
    targetKind: 'bot',
    targetId: `bot:${x},${y}`,
    worldId: 'main',
    targetX: x,
    targetY: y,
    targetPlotVersion: 1,
    state,
    stateVersion: 0,
    simulationVersion: 1,
    seed: String(integer(source.seed)),
    fencingTokenHash: string(source.ownerTokenHash, 'legacy'),
    defenderSnapshot: { legacyBotRaid: source },
    reservedArmy: object(source.reservedArmy),
    createdAt,
    engagedAt: createdAt,
    updatedAt: endedAt ?? createdAt,
    deadlineAt,
    endedAt,
    result: isObject(source.finalResult) ? source.finalResult : null,
    authority: null
  }
  return attachImportedAuthority(base, source, endedAt ?? createdAt, 'BOT')
}

async function importBotRaid(uow: PostgresUnitOfWork, record: LegacySourceRecord): Promise<number> {
  const attack = mapLegacyBotRaidAttack(record)
  await uow.attacks.insert(attack)
  const commands = attack.authority ? attackCommandsFromAuthority(attack.authority) : []
  for (const command of commands) await uow.attacks.appendCommand(command)
  return commands.length
}

async function importNotifications(sql: SqlExecutor, record: LegacySourceRecord): Promise<void> {
  for (const item of array(record.value.items)) {
    if (!isObject(item)) continue
    const occurredAt = millis(item.time, new Date(0))
    await sql.query(String.raw`
      INSERT INTO notifications(player_id, id, event_type, payload, occurred_at, read_at)
      VALUES ($1, $2, 'attack', $3, $4, $5)
    `, [record.key, string(item.id), item, occurredAt, item.read === true ? occurredAt : null])
  }
}

/** Import a validated, frozen JSON snapshot into an empty migrated database. */
export async function importLegacyPlan(database: SqlDatabase, plan: LegacyImportPlan): Promise<LegacyImportResult> {
  const errors = plan.issues.filter(issue => issue.severity === 'error')
  if (errors.length > 0) throw new Error(`Legacy import has ${errors.length} validation error(s); refusing to write`)
  const importedAt = new Date(plan.cutoffAt)
  const counters = { sessions: 0, plots: 0, operationMarkers: 0, replayChunks: 0, attackCommands: 0 }
  await database.withTransaction(async sql => {
    await sql.query('SELECT pg_advisory_xact_lock($1)', [738_104_222])
    const existing = await sql.query<{ count: string }>('SELECT count(*)::text AS count FROM accounts')
    if (existing.rows[0]?.count !== '0') throw new Error('Legacy import requires an empty accounts table')
    const uow = new PostgresUnitOfWork(sql)
    // Bot rows go first so a real-player claim at the same coordinate can
    // continue hiding (rather than erasing) the durable camp after cutover.
    for (const record of plan.records.filter(item => item.collection === 'bot-villages')) {
      await importBotVillage(uow, record)
    }
    for (const record of plan.records.filter(item => item.collection === 'players')) {
      await importPlayer(uow, record, counters)
    }
    await seedLegacyWorldAllocation(sql, uow, importedAt, plan)
    for (const record of plan.records.filter(item => item.collection === 'replays')) {
      counters.replayChunks += await importReplay(sql, uow, record, importedAt)
      const authority = authorityFromSource(record.value)
      counters.attackCommands += authority ? authority.lastCommandSequence : 0
    }
    for (const record of plan.records.filter(item => item.collection === 'settlements')) {
      await importSettlement(sql, record)
    }
    for (const record of plan.records.filter(item => item.collection === 'bot-raids')) {
      counters.attackCommands += await importBotRaid(uow, record)
    }
    for (const record of plan.records.filter(item => item.collection === 'notifications')) {
      await importNotifications(sql, record)
    }
    for (const record of plan.records.filter(item => item.collection === 'ledger')) {
      await sql.query(
        'INSERT INTO economy_ledger_days(day, data, imported_at) VALUES ($1, $2, $3)',
        [integer(record.value.day), record.value, importedAt]
      )
    }
    for (const record of plan.records) {
      await sql.query(String.raw`
        INSERT INTO legacy_import_manifest(collection, record_key, sha256, payload, imported_at)
        VALUES ($1, $2, $3, $4, $5)
      `, [record.collection, record.key, record.sha256, record.value, importedAt])
    }
  }, { isolation: 'serializable', maxRetries: 0 })
  return { importedAt, counts: plan.counts, ...counters }
}

function expectedSessionCount(plan: LegacyImportPlan): number {
  return plan.records
    .filter(record => record.collection === 'players')
    .reduce((sum, record) => sum + array(record.value.tokenHashes).filter(token => typeof token === 'string').length, 0)
}

function expectedNotificationCount(plan: LegacyImportPlan): number {
  return plan.records
    .filter(record => record.collection === 'notifications')
    .reduce((sum, record) => sum + array(record.value.items).filter(isObject).length, 0)
}

function expectedAttackCommandCount(plan: LegacyImportPlan): number {
  return plan.records
    .filter(record => record.collection === 'replays' || record.collection === 'bot-raids')
    .reduce((sum, record) => sum + (authorityFromSource(record.value)?.lastCommandSequence ?? 0), 0)
}

/** Compare canonical row counts, resource totals, and every source checksum after import. */
export async function verifyLegacyImport(database: SqlDatabase, plan: LegacyImportPlan): Promise<LegacyVerificationReport> {
  const issues: string[] = []
  let importedRecords = 0
  await database.withTransaction(async sql => {
    const manifest = await sql.query<{ collection: string; record_key: string; sha256: string }>(
      'SELECT collection, record_key, sha256 FROM legacy_import_manifest ORDER BY collection, record_key'
    )
    importedRecords = manifest.rowCount ?? 0
    const importedHashes = new Map(manifest.rows.map(row => [`${row.collection}/${row.record_key}`, row.sha256]))
    for (const record of plan.records) {
      const key = recordName(record)
      const digest = importedHashes.get(key)
      if (!digest) issues.push(`Missing import manifest record ${key}`)
      else if (digest !== record.sha256) issues.push(`Checksum mismatch for ${key}`)
    }
    for (const key of importedHashes.keys()) {
      if (!plan.records.some(record => recordName(record) === key)) issues.push(`Unexpected import manifest record ${key}`)
    }

    const counts = await sql.query<{
      accounts: string
      villages: string
      sessions: string
      plots: string
      bot_villages: string
      attacks: string
      attack_commands: string
      notifications: string
      ledger: string
    }>(String.raw`
      SELECT
        (SELECT count(*) FROM accounts)::text AS accounts,
        (SELECT count(*) FROM villages)::text AS villages,
        (SELECT count(*) FROM sessions)::text AS sessions,
        (SELECT count(*) FROM world_plots)::text AS plots,
        (SELECT count(*) FROM bot_villages)::text AS bot_villages,
        (SELECT count(*) FROM attacks)::text AS attacks,
        (SELECT count(*) FROM attack_commands)::text AS attack_commands,
        (SELECT count(*) FROM notifications)::text AS notifications,
        (SELECT count(*) FROM economy_ledger_days)::text AS ledger
    `)
    const actual = counts.rows[0]
    const playerCount = plan.counts.players
    const expected: Record<keyof NonNullable<typeof actual>, number> = {
      accounts: playerCount,
      villages: playerCount,
      sessions: expectedSessionCount(plan),
      plots: plan.records.filter(record => record.collection === 'players'
        && typeof record.value.plotX === 'number' && typeof record.value.plotY === 'number').length,
      bot_villages: plan.counts['bot-villages'],
      attacks: plan.counts.replays + plan.counts['bot-raids'],
      attack_commands: expectedAttackCommandCount(plan),
      notifications: expectedNotificationCount(plan),
      ledger: plan.counts.ledger
    }
    if (!actual) {
      issues.push('Could not read canonical table counts')
    } else {
      for (const [name, expectedCount] of Object.entries(expected)) {
        const actualCount = Number(actual[name as keyof typeof actual])
        if (actualCount !== expectedCount) issues.push(`${name}: expected ${expectedCount}, found ${actualCount}`)
      }
    }

    const botRows = await sql.query<{
      id: string
      world_id: string
      x: number
      y: number
      plot_version: string | number
      world_generation_version: number
      generator_version: number
      seed: string | number
      username: string
      trophies: number
      profile: JsonObject
      world: BotVillageRecord['world']
      revision: string | number
      created_at: Date | string
      updated_at: Date | string
    }>(String.raw`
      SELECT id, world_id, x, y, plot_version, world_generation_version,
        generator_version, seed, username, trophies, profile, world, revision,
        created_at, updated_at
      FROM bot_villages ORDER BY id
    `)
    const botsById = new Map(botRows.rows.map(row => [row.id, {
      id: row.id,
      worldId: row.world_id,
      x: row.x,
      y: row.y,
      plotVersion: Number(row.plot_version),
      worldGenerationVersion: row.world_generation_version,
      generatorVersion: row.generator_version,
      seed: Number(row.seed),
      username: row.username,
      trophies: row.trophies,
      profile: row.profile,
      world: row.world,
      revision: Number(row.revision),
      createdAt: new Date(row.created_at instanceof Date ? row.created_at.getTime() : row.created_at),
      updatedAt: new Date(row.updated_at instanceof Date ? row.updated_at.getTime() : row.updated_at)
    } satisfies BotVillageRecord]))
    for (const sourceBot of plan.records.filter(record => record.collection === 'bot-villages')) {
      const expectedBot = mapLegacyBotVillage(sourceBot)
      const actualBot = botsById.get(expectedBot.id)
      if (!actualBot) {
        issues.push(`Missing canonical bot village ${expectedBot.id}`)
      } else if (!isDeepStrictEqual(actualBot, expectedBot)) {
        issues.push(`Canonical bot village ${expectedBot.id} differs from its frozen full-world record`)
      }
    }

    const appearanceRows = await sql.query<{ player_id: string; appearance_revision: string }>(
      'SELECT player_id, appearance_revision::text AS appearance_revision FROM villages ORDER BY player_id'
    )
    const appearanceByPlayer = new Map(
      appearanceRows.rows.map(row => [row.player_id, Number(row.appearance_revision)])
    )
    for (const player of plan.records.filter(record => record.collection === 'players')) {
      const expectedAppearance = Math.max(0, integer(player.value.appearanceRevision, integer(player.value.revision)))
      const actualAppearance = appearanceByPlayer.get(player.key)
      if (actualAppearance !== expectedAppearance) {
        issues.push(`appearance revision for ${player.key}: expected ${expectedAppearance}, found ${String(actualAppearance)}`)
      }
    }

    const sourceCoordinates = plan.records
      .filter(record => record.collection === 'players'
        && typeof record.value.plotX === 'number' && typeof record.value.plotY === 'number')
      .map(record => ({ x: integer(record.value.plotX), y: integer(record.value.plotY) }))
    const occupiedOrdinals = new Set(sourceCoordinates.map(allocationOrdinalOf))
    const storedWorld = plan.records.find(record => record.collection === 'world-state' && record.key === 'main')
    const storedAllocation = object(storedWorld?.value.allocation)
    const generationVersion = integer(storedAllocation.currentGenerationVersion, 1)
    const presentationSeedVersion = normalizeWorldPresentationSeedVersion(
      storedWorld?.value.presentationSeedVersion
    )
    const expectedNextOrdinal = storedWorld
      ? integer(storedAllocation.nextOrdinal)
      : (occupiedOrdinals.size === 0 ? 0 : Math.max(...occupiedOrdinals) + 1)
    let expectedReleasedSlots = storedWorld ? array(storedWorld.value.releasedSlots).length : 0
    if (!storedWorld) {
      for (let ordinal = 0; ordinal < expectedNextOrdinal; ordinal += 1) {
        if (!occupiedOrdinals.has(ordinal)
          && isSpiralSettleable(
            coordinateAtAllocationOrdinal(ordinal),
            generationVersion,
            presentationSeedVersion
          )) {
          expectedReleasedSlots += 1
        }
      }
    }
    const expectedRegions = new Set(sourceCoordinates.map(coordinate => {
      const region = regionAddressForPlot({
        worldId: 'main',
        generationVersion: 1,
        coordinate,
        size: 32
      })
      return `${region.x},${region.y}`
    })).size
    const worldIndex = await sql.query<{
      next_ordinal: string
      regions: string
      released_slots: string
    }>(String.raw`
      SELECT allocation.next_ordinal::text,
        (SELECT count(*) FROM world_regions WHERE world_id = 'main')::text AS regions,
        (SELECT count(*) FROM world_released_slots WHERE world_id = 'main')::text AS released_slots
      FROM world_allocation_state allocation WHERE allocation.world_id = 'main'
    `)
    const index = worldIndex.rows[0]
    if (!index) {
      issues.push('Missing main world allocation state')
    } else {
      if (Number(index.next_ordinal) !== expectedNextOrdinal) {
        issues.push(`world next ordinal: expected ${expectedNextOrdinal}, found ${index.next_ordinal}`)
      }
      if (Number(index.regions) !== expectedRegions) {
        issues.push(`world regions: expected ${expectedRegions}, found ${index.regions}`)
      }
      if (Number(index.released_slots) !== expectedReleasedSlots) {
        issues.push(`released world slots: expected ${expectedReleasedSlots}, found ${index.released_slots}`)
      }
    }

    const sourceTotals = plan.records
      .filter(record => record.collection === 'players')
      .reduce((totals, record) => ({
        gold: totals.gold + number(record.value.balance),
        ore: totals.ore + integer(record.value.ore),
        food: totals.food + integer(record.value.food),
        trophies: totals.trophies + Math.max(0, integer(record.value.trophies))
      }), { gold: 0, ore: 0, food: 0, trophies: 0 })
    const databaseTotals = await sql.query<{
      gold: string
      ore: string
      food: string
      trophies: string
    }>(String.raw`
      SELECT
        COALESCE((SELECT sum(gold) FROM villages), 0)::text AS gold,
        COALESCE((SELECT sum(ore) FROM villages), 0)::text AS ore,
        COALESCE((SELECT sum(food) FROM villages), 0)::text AS food,
        COALESCE((SELECT sum(trophies) FROM player_profiles), 0)::text AS trophies
    `)
    const totals = databaseTotals.rows[0]
    if (!totals) {
      issues.push('Could not read canonical economy totals')
    } else {
      for (const name of ['gold', 'ore', 'food', 'trophies'] as const) {
        const tolerance = name === 'gold' ? 1e-9 : 0
        if (Math.abs(Number(totals[name]) - sourceTotals[name]) > tolerance) {
          issues.push(`${name} total: expected ${sourceTotals[name]}, found ${totals[name]}`)
        }
      }
    }
  }, { isolation: 'repeatable read', maxRetries: 0 })
  return { ok: issues.length === 0, issues, sourceRecords: plan.records.length, importedRecords }
}
