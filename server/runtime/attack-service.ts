import { createHash, randomBytes } from 'node:crypto'
import {
  RAIDABLE_SHARE,
  hashString,
  mulberry32,
  resourceCapacity,
  storehouseProtection,
  watchtowerSightOf
} from '../../src/game/config/Economy'
import type { SerializedWorld } from '../../src/game/data/Models'
import { GENERATED_ONLY } from '../../src/game/config/GameDefinitions'
import {
  applyAttackCommand,
  cancelAttack,
  compactReplay,
  engageAttack,
  expireAttack,
  finalizeAttack,
  prepareAttack,
  settleAttack
} from '../attack-domain/domain'
import { prepareBotAttack } from '../attack-domain/bot'
import { AttackDomainError } from '../attack-domain/errors'
import { combatSnapshotHash, stableHash } from '../attack-domain/simulation'
import type {
  AttackAggregate,
  AttackCommand,
  AttackSettlementReceipt,
  CombatVillageSnapshot,
  ResourceAmounts,
  TroopCounts
} from '../attack-domain/types'
import { troopLevelOf } from '../domain/village'
import {
  CURRENT_WORLD_GENERATION_VERSION,
  botFrontierRadiusForCursor,
  settledFrontierBotVillageSeedAt
} from '../domain/world'
import {
  BOT_RAID_COOLDOWN_MS,
  grantRevengeRight,
  normalizeBotRaidCooldowns,
  normalizeRevengeRights,
  recordBotRaidCooldown,
  spendRevengeRight
} from '../domain/attack-retention'
import { ApiError } from '../errors'
import {
  PersistenceConflictError,
  attackCommandsFromAuthority,
  attackRecordFromAuthority,
  idempotentMutation,
  outboxEvent,
  type AccountRecord,
  type AttackRecord,
  type BotVillageRecord,
  type JsonObject,
  type JsonValue,
  type Persistence,
  type ReplayChunkRecord,
  type UnitOfWork,
  type VillageRecord,
  type WorldPlotRecord
} from '../persistence'
import {
  BOT_CAMP_EXCLUSION_LIMIT,
  MATCHMAKE_EXCLUSION_LIMIT,
  type AttackCommandRequest,
  type AttackEndRequest,
  type AttackFrameRequest,
  type AttackStartRequest,
  type BotSettleRequest,
  type BotStartRequest,
  type MatchmakeRequest,
  type RuntimeAttackService,
  type RuntimePrincipal
} from './contracts'
import {
  MAX_PLAYER_GOLD,
  materializeVillage,
  publicWorldOf,
  serializedWorldOf,
  villageArmy,
  villageBuildings
} from './village-state'
import { botWorldForAttack, ensurePersistedBotVillage } from './bot-villages'
import { assertGameplayMutationAllowed } from './maintenance-fence'

const WORLD_COORD_LIMIT = 1_000_000
const START_IDEMPOTENCY_TTL_MS = 24 * 60 * 60_000
const BOT_RAID_SESSION_MS = 15 * 60_000
const MATCHMAKE_LIMIT = 64
const BOT_PROBE_LIMIT = 64
const ACTIVE_LIMIT = 16
const REPLAY_PAGE_SIZE = 128
const REPLAY_PAGE_LIMIT = 8
const MAX_REPLAY_FRAMES = 512
export const MAX_PRESENTATION_REPLAY_BYTES = 2 * 1024 * 1024
export const PRESENTATION_REPLAY_RETENTION_MS = 7 * 24 * 60 * 60_000
const FINAL_REPLAY_SEQUENCE = 2_000_000_000

type Clock = () => Date
type IdFactory = (prefix: 'atk' | 'botraid') => string

export interface PersistenceAttackServiceOptions {
  now?: Clock
  createId?: IdFactory
  preserveOverCapacity?: boolean
}

type StartedPlayerAttack = {
  attackId: string
  world: SerializedWorld
  lootCap: number
  lootCapOre: number
  lootCapFood: number
  target: { worldId: string; x: number; y: number; plotVersion: number }
}

type StartedBotAttack = {
  raidId: string
  x: number
  y: number
  seed: number
  world: SerializedWorld
  expiresAt: number
}

type SettlementResponse = {
  lootApplied: number
  oreApplied: number
  foodApplied: number
  attackerBalance: number
  attackerOre: number
  attackerFood: number
  trophyDelta: number
  attackerTrophies: number
  revision: number
  army: Record<string, number>
}

type CommandResponse = {
  attackId: string
  raidId?: string
  phase: AttackAggregate['phase']
  version: number
  lastCommandSequence: number
  receipts: Array<Record<string, JsonValue>>
}

type ReplayFrame = {
  t: number
  destruction: number
  goldLooted: number
  oreLooted: number
  foodLooted: number
  buildings: Array<{ id: string; health: number; isDestroyed: boolean }>
  troops: Array<{
    id: string
    type: string
    level: number
    owner: 'PLAYER' | 'ENEMY'
    gridX: number
    gridY: number
    visualOffsetY?: number
    health: number
    maxHealth: number
    facingAngle?: number
    hasTakenDamage?: boolean
  }>
}

function randomId(prefix: 'atk' | 'botraid'): string {
  return `${prefix}_${randomBytes(12).toString('hex')}`
}

function tokenHash(raw: unknown): string {
  return typeof raw === 'string' && raw
    ? createHash('sha256').update(raw).digest('hex')
    : ''
}

function jsonValue<T>(value: T): JsonValue {
  return structuredClone(value) as unknown as JsonValue
}

function jsonObject<T extends object>(value: T): JsonObject {
  return structuredClone(value) as unknown as JsonObject
}

function strictId(raw: unknown, label: string): string {
  if (typeof raw !== 'string' || !/^[a-zA-Z0-9_-]{1,120}$/.test(raw)) {
    throw new ApiError(400, `${label} must be a safe identifier`)
  }
  return raw
}

/** Bounded strict NEXT-cycling exclusion list (see MatchmakeRequest). */
function matchmakeExclusions(raw: unknown): Set<string> {
  if (raw === undefined) return new Set()
  if (!Array.isArray(raw) || raw.length > MATCHMAKE_EXCLUSION_LIMIT) {
    throw new ApiError(400, `excludeTargetIds must be an array of at most ${MATCHMAKE_EXCLUSION_LIMIT} ids`)
  }
  return new Set(raw.map(entry => strictId(entry, 'excludeTargetIds entry')))
}

function botCampExclusions(raw: unknown): Set<string> {
  if (raw === undefined) return new Set()
  if (!Array.isArray(raw) || raw.length > BOT_CAMP_EXCLUSION_LIMIT) {
    throw new ApiError(400, `excludeCampKeys must contain at most ${BOT_CAMP_EXCLUSION_LIMIT} coordinates`)
  }
  const exclusions = new Set<string>()
  for (const value of raw) {
    if (typeof value !== 'string' || !/^-?\d+,-?\d+$/.test(value)) {
      throw new ApiError(400, 'Every excluded camp must use the x,y coordinate format')
    }
    const [rawX, rawY] = value.split(',')
    const x = Number(rawX)
    const y = Number(rawY)
    if (!Number.isSafeInteger(x) || !Number.isSafeInteger(y)
      || Math.abs(x) > WORLD_COORD_LIMIT || Math.abs(y) > WORLD_COORD_LIMIT) {
      throw new ApiError(400, 'Excluded camp coordinates are outside the world')
    }
    exclusions.add(`${x},${y}`)
  }
  return exclusions
}

function requestId(raw: unknown, operation: string): string {
  if (typeof raw !== 'string' || raw.length < 1 || raw.length > 160 || !/^[a-zA-Z0-9_.:-]+$/.test(raw)) {
    throw new ApiError(400, `${operation} requires a stable requestId`)
  }
  return raw
}

function coordinate(raw: unknown, label: string): number {
  const value = Number(raw)
  if (!Number.isSafeInteger(value) || value < -WORLD_COORD_LIMIT || value > WORLD_COORD_LIMIT) {
    throw new ApiError(400, `${label} must be a world coordinate`)
  }
  return value
}

function nonNegativeInt(raw: unknown, fallback = 0, maximum = 2_147_483_647): number {
  const value = Number(raw)
  if (!Number.isFinite(value)) return fallback
  return Math.max(0, Math.min(maximum, Math.floor(value)))
}

function finiteNumber(raw: unknown, fallback = 0, minimum = -1_000_000, maximum = 1_000_000): number {
  const value = Number(raw)
  return Number.isFinite(value) ? Math.max(minimum, Math.min(maximum, value)) : fallback
}

function safeArmy(raw: unknown): TroopCounts {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const out: TroopCounts = {}
  for (const [type, rawCount] of Object.entries(raw as Record<string, unknown>)) {
    if (!/^[a-zA-Z0-9_-]{1,80}$/.test(type) || GENERATED_ONLY.has(type)) continue
    const count = nonNegativeInt(rawCount, 0, 10_000)
    if (count > 0) out[type as keyof TroopCounts] = count
  }
  return out
}

function armyCount(army: TroopCounts): number {
  return Object.values(army).reduce((sum, count) => sum + (count ?? 0), 0)
}

function mergeArmy(current: Record<string, number>, returned: TroopCounts): Record<string, number> {
  const army = { ...current }
  for (const [type, count] of Object.entries(returned)) {
    if (!count) continue
    army[type] = Math.min(10_000, (army[type] ?? 0) + count)
  }
  return army
}

function villageFingerprint(village: VillageRecord): string {
  return JSON.stringify({
    buildings: village.buildings,
    obstacles: village.obstacles,
    army: village.army,
    wallLevel: village.wallLevel,
    gold: village.gold,
    ore: village.ore,
    food: village.food,
    productionRemainders: village.productionRemainders,
    population: village.population,
    layoutRevision: village.layoutRevision,
    appearanceRevision: village.appearanceRevision,
    simulationVersion: village.simulationVersion
  })
}

function accountFingerprint(account: AccountRecord): string {
  return JSON.stringify({
    trophies: account.trophies,
    shieldUntil: account.shieldUntil?.getTime() ?? null,
    revengeRights: account.revengeRights,
    botRaidCooldowns: account.botRaidCooldowns
  })
}

function phaseIsActive(phase: AttackAggregate['phase']): boolean {
  return phase === 'PREPARING' || phase === 'ENGAGED' || phase === 'ACTIVE' || phase === 'FINALIZING'
}

function terminalStatus(attack: AttackAggregate): 'live' | 'finished' | 'aborted' {
  if (attack.phase === 'SETTLED') return 'finished'
  if (attack.phase === 'CANCELLED' || attack.phase === 'EXPIRED') return 'aborted'
  return 'live'
}

function domainFailure(error: unknown): never {
  if (!(error instanceof AttackDomainError)) throw error
  const forbidden = error.code === 'TARGET_SHIELDED'
  const badRequest = error.code === 'INVALID_INPUT'
    || error.code === 'COMMAND_SEQUENCE_GAP'
    || error.code === 'COMMAND_SEQUENCE_REPLAY'
    || error.code === 'COMMAND_ID_REUSED'
  throw new ApiError(forbidden ? 403 : badRequest ? 400 : 409, error.message, error.code, error.details)
}

function attackWorld(account: AccountRecord, village: VillageRecord, caps: ResourceAmounts): SerializedWorld {
  return {
    ...publicWorldOf(account, village),
    resources: { ...caps }
  }
}

function snapshotFor(village: VillageRecord, attackId: string): CombatVillageSnapshot {
  return {
    schemaVersion: 1,
    snapshotId: `snap_${attackId}`,
    villageVersion: `appearance_${village.appearanceRevision}`,
    buildings: villageBuildings(village).map(building => ({
      id: building.id,
      type: building.type,
      level: building.level,
      gridX: building.gridX,
      gridY: building.gridY
    }))
  }
}

function botCooldown(account: AccountRecord, x: number, y: number): number {
  return nonNegativeInt(account.botRaidCooldowns[`${x},${y}`])
}

function ensureVillage(record: VillageRecord | null, label = 'Village'): VillageRecord {
  if (!record) throw new ApiError(404, `${label} not found`)
  return record
}

function ensureAccount(record: AccountRecord | null, label = 'Player'): AccountRecord {
  if (!record) throw new ApiError(404, `${label} not found`)
  return record
}

function ensurePlot(record: WorldPlotRecord | null, label = 'Village plot'): WorldPlotRecord {
  if (!record) throw new ApiError(404, `${label} not found`)
  return record
}

async function updateVillage(tx: UnitOfWork, village: VillageRecord, expectedRevision: number, now: Date): Promise<void> {
  village.economyRevision = expectedRevision + 1
  village.lastMutationAt = new Date(Math.max(village.lastMutationAt.getTime(), now.getTime()))
  if (!await tx.villages.update(village, expectedRevision)) {
    throw new PersistenceConflictError('Village authority changed during attack transaction')
  }
}

async function updateAccount(tx: UnitOfWork, account: AccountRecord, expectedRevision: number): Promise<void> {
  account.revision = expectedRevision + 1
  if (!await tx.accounts.update(account, expectedRevision)) {
    throw new PersistenceConflictError('Account authority changed during attack transaction')
  }
}

function sanitizeFrame(raw: unknown, maxT: number): ReplayFrame | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const source = raw as Record<string, unknown>
  const t = nonNegativeInt(source.t, 0, maxT)
  const buildings = Array.isArray(source.buildings)
    ? source.buildings.slice(0, 1_000).flatMap(item => {
        if (!item || typeof item !== 'object' || Array.isArray(item)) return []
        const state = item as Record<string, unknown>
        if (typeof state.id !== 'string' || !/^[a-zA-Z0-9_-]{1,120}$/.test(state.id)) return []
        return [{
          id: state.id,
          health: nonNegativeInt(state.health, 0, 100_000_000),
          isDestroyed: Boolean(state.isDestroyed) && nonNegativeInt(state.health) === 0
        }]
      })
    : []
  const troops = Array.isArray(source.troops)
    ? source.troops.slice(0, 1_000).flatMap(item => {
        if (!item || typeof item !== 'object' || Array.isArray(item)) return []
        const state = item as Record<string, unknown>
        if (typeof state.id !== 'string' || !/^[a-zA-Z0-9_-]{1,120}$/.test(state.id)
          || typeof state.type !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(state.type)) return []
        const owner = state.owner === 'ENEMY' ? 'ENEMY' as const : 'PLAYER' as const
        return [{
          id: state.id,
          type: state.type,
          level: Math.max(1, nonNegativeInt(state.level, 1, 100)),
          owner,
          gridX: finiteNumber(state.gridX),
          gridY: finiteNumber(state.gridY),
          ...(state.visualOffsetY === undefined ? {} : { visualOffsetY: finiteNumber(state.visualOffsetY, 0, -100, 100) }),
          health: nonNegativeInt(state.health, 0, 100_000_000),
          maxHealth: Math.max(1, nonNegativeInt(state.maxHealth, 1, 100_000_000)),
          ...(state.facingAngle === undefined ? {} : { facingAngle: finiteNumber(state.facingAngle, 0, -100, 100) }),
          ...(state.hasTakenDamage === undefined ? {} : { hasTakenDamage: Boolean(state.hasTakenDamage) })
        }]
      })
    : []
  const frame: ReplayFrame = {
    t,
    destruction: nonNegativeInt(source.destruction, 0, 100),
    goldLooted: nonNegativeInt(source.goldLooted, 0, MAX_PLAYER_GOLD),
    oreLooted: nonNegativeInt(source.oreLooted, 0, MAX_PLAYER_GOLD),
    foodLooted: nonNegativeInt(source.foodLooted, 0, MAX_PLAYER_GOLD),
    buildings,
    troops
  }
  return JSON.stringify(frame).length <= 256_000 ? frame : null
}

function replayPayload(chunk: ReplayChunkRecord): Record<string, unknown> | null {
  return chunk.payload && typeof chunk.payload === 'object' && !Array.isArray(chunk.payload)
    ? chunk.payload as Record<string, unknown>
    : null
}

function presentationSequence(t: number, maxDurationMs: number): number {
  const bucketMs = Math.max(1, Math.ceil((maxDurationMs + 1) / MAX_REPLAY_FRAMES))
  return Math.min(MAX_REPLAY_FRAMES, Math.floor(t / bucketMs) + 1)
}

/** Normalized persistence authority for every player and bot combat route. */
export class PersistenceAttackService implements RuntimeAttackService {
  private readonly persistence: Persistence
  private readonly now: Clock
  private readonly createId: IdFactory
  private readonly preserveOverCapacity: boolean

  constructor(persistence: Persistence, options: PersistenceAttackServiceOptions = {}) {
    this.persistence = persistence
    this.now = options.now ?? (() => new Date())
    this.createId = options.createId ?? randomId
    this.preserveOverCapacity = options.preserveOverCapacity
      ?? process.env.CLASH_ALLOW_DEBUG_GRANTS === '1'
  }

  private async serializable<T>(work: (tx: UnitOfWork, now: Date) => Promise<T>): Promise<T> {
    const now = this.now()
    try {
      return await this.persistence.transaction(async tx => {
        await assertGameplayMutationAllowed(tx)
        return work(tx, now)
      }, {
        isolation: 'serializable',
        maxRetries: 3
      })
    } catch (error) {
      if (error instanceof ApiError) throw error
      if (error instanceof AttackDomainError) domainFailure(error)
      if (error instanceof PersistenceConflictError
        || (error instanceof Error && /active attack|defender.*lease|compare-and-swap|serialization/i.test(error.message))) {
        throw new ApiError(409, 'Attack authority changed; retry the request', 'ATTACK_CONFLICT')
      }
      throw error
    }
  }

  private async materializeWithAudit(
    tx: UnitOfWork,
    village: VillageRecord,
    now: Date,
    populationLocked = false
  ) {
    const before = { gold: village.gold, ore: village.ore, food: village.food }
    const result = materializeVillage(village, now, {
      populationLocked,
      preserveOverCapacity: this.preserveOverCapacity
    })
    const auditId = `sim:${result.from}:${result.through}`
    for (const currency of ['gold', 'ore', 'food'] as const) {
      const delta = village[currency] - before[currency]
      if (delta === 0) continue
      await tx.balanceLedger.append({
        playerId: village.playerId,
        operation: 'village.simulation',
        requestId: auditId,
        currency,
        delta,
        balanceAfter: village[currency],
        metadata: {
          simulationVersion: result.simulationVersion,
          from: result.from,
          through: result.through
        },
        createdAt: now
      })
    }
    return result
  }

  private async outgoingAfterExpiry(tx: UnitOfWork, playerId: string, now: Date): Promise<AttackRecord[]> {
    const records = await tx.attacks.listActiveOutgoing(playerId, ACTIVE_LIMIT)
    for (const record of records) await this.expireIfDue(tx, record, now)
    return (await tx.attacks.listActiveOutgoing(playerId, ACTIVE_LIMIT))
      .filter(record => record.authority && phaseIsActive(record.authority.phase))
  }

  /** Match the core runtime's account -> village -> plot lock order for every participant. */
  private async lockParticipants(tx: UnitOfWork, playerIds: readonly string[]): Promise<void> {
    for (const playerId of [...new Set(playerIds)].sort()) {
      await tx.accounts.getById(playerId, { forUpdate: true })
      await tx.villages.get(playerId, { forUpdate: true })
      await tx.world.getPlayerPlot(playerId, { forUpdate: true })
    }
  }

  private async reserveVillageArmy(tx: UnitOfWork, playerId: string, now: Date): Promise<{
    account: AccountRecord
    village: VillageRecord
    plot: WorldPlotRecord
    reservedArmy: TroopCounts
    troopLevel: number
  }> {
    const account = ensureAccount(await tx.accounts.getById(playerId, { forUpdate: true }))
    const village = ensureVillage(await tx.villages.get(playerId, { forUpdate: true }))
    const plot = ensurePlot(await tx.world.getPlayerPlot(playerId, { forUpdate: true }))
    const expectedRevision = village.economyRevision
    await this.materializeWithAudit(tx, village, now)
    const reservedArmy = safeArmy(villageArmy(village))
    if (armyCount(reservedArmy) <= 0) throw new ApiError(409, 'Train troops before starting an attack')
    village.army = {}
    await updateVillage(tx, village, expectedRevision, now)
    return { account, village, plot, reservedArmy, troopLevel: troopLevelOf(villageBuildings(village)) }
  }

  private async persistStartChunk(tx: UnitOfWork, attack: AttackAggregate, world: SerializedWorld, now: Date): Promise<void> {
    const payload = jsonValue({ world })
    await tx.replays.append({
      attackId: attack.attackId,
      sequence: 0,
      format: 'attack-start-v1',
      payload,
      objectKey: null,
      checksum: stableHash(payload),
      createdAt: now
    })
  }

  private async startPlayerInTransaction(
    tx: UnitOfWork,
    principal: RuntimePrincipal,
    targetId: string,
    matchmade: boolean,
    fencingTokenHash: string,
    now: Date
  ): Promise<StartedPlayerAttack> {
    if ((await this.outgoingAfterExpiry(tx, principal.playerId, now)).length > 0) {
      throw new ApiError(409, 'Finish or abort your active attack first')
    }
    if (targetId === principal.playerId) throw new ApiError(400, 'Cannot attack yourself')
    await this.lockParticipants(tx, [principal.playerId, targetId])
    const attacker = await this.reserveVillageArmy(tx, principal.playerId, now)

    const defenderAccount = ensureAccount(await tx.accounts.getById(targetId, { forUpdate: true }), 'Target player')
    const defenderVillage = ensureVillage(await tx.villages.get(targetId, { forUpdate: true }), 'Target village')
    const defenderPlot = ensurePlot(await tx.world.getPlayerPlot(targetId, { forUpdate: true }), 'Target plot')
    if (defenderPlot.worldId !== attacker.plot.worldId
      || (defenderPlot.leaseExpiresAt !== null && defenderPlot.leaseExpiresAt <= now)) {
      throw new ApiError(404, 'Target village is unavailable')
    }
    const defenderExpected = defenderVillage.economyRevision
    const defenderBefore = villageFingerprint(defenderVillage)
    await this.materializeWithAudit(tx, defenderVillage, now)
    if (villageFingerprint(defenderVillage) !== defenderBefore) {
      await updateVillage(tx, defenderVillage, defenderExpected, now)
    }

    const distance = Math.max(Math.abs(attacker.plot.x - defenderPlot.x), Math.abs(attacker.plot.y - defenderPlot.y))
    const attackerAccountRevision = attacker.account.revision
    const attackerAccountBefore = accountFingerprint(attacker.account)
    const revengeRights = normalizeRevengeRights(attacker.account.revengeRights, now.getTime())
    attacker.account.revengeRights = jsonObject(revengeRights)
    const revengeRight = !matchmade ? revengeRights[targetId] : undefined
    const revenge = Boolean(revengeRight)
    if (!matchmade && distance > watchtowerSightOf(villageBuildings(attacker.village)) && !revenge) {
      throw new ApiError(403, 'That village is beyond your watchtower sight')
    }
    if (defenderAccount.shieldUntil && defenderAccount.shieldUntil > now && !revenge) {
      throw new ApiError(403, 'That village is under a shield', 'TARGET_SHIELDED')
    }

    if (revenge) {
      attacker.account.revengeRights = jsonObject(spendRevengeRight(
        attacker.account.revengeRights, targetId, now.getTime()
      ))
    }
    if (accountFingerprint(attacker.account) !== attackerAccountBefore) {
      await updateAccount(tx, attacker.account, attackerAccountRevision)
    }

    const protection = storehouseProtection(villageBuildings(defenderVillage))
    const lootCaps: ResourceAmounts = {
      gold: Math.floor(defenderVillage.gold * RAIDABLE_SHARE),
      ore: Math.floor(defenderVillage.ore * RAIDABLE_SHARE * (1 - protection)),
      food: Math.floor(defenderVillage.food * RAIDABLE_SHARE * (1 - protection))
    }
    const attackId = this.createId('atk')
    const snapshot = snapshotFor(defenderVillage, attackId)
    const authority = prepareAttack({
      attackId,
      attackerId: attacker.account.id,
      attackerName: attacker.account.username,
      selectionSource: matchmade ? 'MATCHMADE' : revenge ? 'REVENGE' : 'NEIGHBOR',
      target: {
        kind: 'PLAYER',
        targetId,
        playerId: targetId,
        shieldBypass: revenge ? 'REVENGE' : 'NONE',
        ...(revengeRight ? { shieldBypassExpiresAt: revengeRight.expiresAt } : {}),
        plot: {
          worldId: defenderPlot.worldId,
          x: defenderPlot.x,
          y: defenderPlot.y,
          version: String(defenderPlot.plotVersion)
        },
        villageVersion: snapshot.villageVersion,
        snapshotId: snapshot.snapshotId,
        snapshotHash: combatSnapshotHash(snapshot)
      },
      snapshot,
      simulationSeed: randomBytes(16).toString('hex'),
      rewardPolicy: {
        lootCaps,
        winTrophyBase: 15,
        winTrophyPerFivePercent: 1,
        lossTrophyDelta: -12
      },
      requestedArmy: attacker.reservedArmy,
      troopLevel: attacker.troopLevel,
      now: now.getTime()
    }, {
      reserveArmy: request => ({
        reservationId: `reserve_${attackId}`,
        sourceArmyVersion: attacker.village.economyRevision,
        reserved: { ...request.requested },
        troopLevel: request.troopLevel
      })
    })
    const record = attackRecordFromAuthority(authority, {
      fencingTokenHash,
      targetPlotVersion: defenderPlot.plotVersion,
      updatedAt: now
    })
    await tx.attacks.insert(record)
    const world = attackWorld(defenderAccount, defenderVillage, lootCaps)
    await this.persistStartChunk(tx, authority, world, now)
    await tx.outbox.add(outboxEvent({
      topic: 'combat', aggregateType: 'attack', aggregateId: attackId,
      eventType: 'attack.prepared', payload: { targetKind: 'player', defenderId: targetId }, now
    }))
    return {
      attackId,
      world,
      lootCap: lootCaps.gold,
      lootCapOre: lootCaps.ore,
      lootCapFood: lootCaps.food,
      target: {
        worldId: defenderPlot.worldId,
        x: defenderPlot.x,
        y: defenderPlot.y,
        plotVersion: defenderPlot.plotVersion
      }
    }
  }

  async startAttack(
    principal: RuntimePrincipal,
    body: AttackStartRequest,
    matchmade = false,
    rawToken?: unknown
  ): Promise<StartedPlayerAttack> {
    const operationId = requestId(body?.requestId, 'Attack start')
    const targetId = strictId(body?.targetId, 'targetId')
    return this.serializable(async (tx, now) => {
      const result = await idempotentMutation(tx, {
        actorId: principal.playerId,
        operation: 'attack-start',
        requestId: operationId,
        now,
        expiresAt: new Date(now.getTime() + START_IDEMPOTENCY_TTL_MS)
      }, async () => jsonValue(await this.startPlayerInTransaction(
        tx, principal, targetId, matchmade, tokenHash(rawToken), now
      )))
      return result.response as unknown as StartedPlayerAttack
    })
  }

  async matchmake(
    principal: RuntimePrincipal,
    body: MatchmakeRequest = {},
    rawToken?: unknown
  ): Promise<StartedPlayerAttack> {
    const operationId = requestId(body?.requestId, 'Matchmaking')
    const excludeTargetId = body.excludeTargetId === undefined
      ? undefined
      : strictId(body.excludeTargetId, 'excludeTargetId')
    const excludedTargetIds = matchmakeExclusions(body.excludeTargetIds)
    return this.serializable(async (tx, now) => {
      const result = await idempotentMutation(tx, {
        actorId: principal.playerId,
        operation: 'attack-matchmake',
        requestId: operationId,
        now,
        expiresAt: new Date(now.getTime() + START_IDEMPOTENCY_TTL_MS)
      }, async () => {
        const account = ensureAccount(await tx.accounts.getById(principal.playerId))
        const plot = ensurePlot(await tx.world.getPlayerPlot(principal.playerId))
        const candidates = await tx.attacks.findCandidates({
          attackerId: principal.playerId,
          worldId: plot.worldId,
          targetTrophies: account.trophies,
          trophyRadius: 10_000,
          now,
          limit: MATCHMAKE_LIMIT + excludedTargetIds.size + (excludeTargetId ? 1 : 0)
        })
        if (candidates.length === 0) throw new ApiError(404, 'No opponents available', 'NO_OPPONENTS')
        // Strict NEXT-cycling exclusions: a base already offered this session
        // is never offered again. An exhausted pool is a distinct signal so
        // the client can transition to bot camps.
        const remaining = excludedTargetIds.size > 0
          ? candidates.filter(candidate => !excludedTargetIds.has(candidate.player.playerId))
          : candidates
        if (remaining.length === 0) {
          throw new ApiError(404, 'Every eligible player village has already been offered', 'MATCH_POOL_EXHAUSTED')
        }
        const alternatives = excludeTargetId
          ? remaining.filter(candidate => candidate.player.playerId !== excludeTargetId)
          : remaining
        // Soft exclusion is a NEXT preference, not a way to make a one-opponent
        // world unplayable. Reuse the sole candidate only when no alternative exists.
        const selectionPool = (alternatives.length > 0 ? alternatives : remaining)
          .slice(0, MATCHMAKE_LIMIT)
        const offset = hashString(`${principal.playerId}:${operationId}`) % selectionPool.length
        const targetId = selectionPool[offset]!.player.playerId
        return jsonValue(await this.startPlayerInTransaction(
          tx, principal, targetId, true, tokenHash(rawToken), now
        ))
      })
      return result.response as unknown as StartedPlayerAttack
    })
  }

  private async chooseBotCamp(
    tx: UnitOfWork,
    account: AccountRecord,
    village: VillageRecord,
    plot: WorldPlotRecord,
    rawX: unknown,
    rawY: unknown,
    operationId: string,
    excludedCampKeys: ReadonlySet<string>,
    now: Date
  ): Promise<{ x: number; y: number; seed: number; revisionEpoch: number; visible: boolean }> {
    const explicit = rawX !== undefined || rawY !== undefined
    // The settled-frontier rule the map presents: structural clans everywhere,
    // plus deterministic fill camps at unclaimed central spiral plots — a camp
    // the map shows is always a camp the player can raid. Occupancy is checked
    // separately below, so a claimed plot never validates as a camp.
    const allocation = await tx.world.getAllocation(plot.worldId)
    const frontierRadius = botFrontierRadiusForCursor(allocation?.nextOrdinal ?? 0)
    const revisionEpoch = allocation?.botRevisionEpoch ?? 1
    const candidateAt = (x: number, y: number) => {
      const seed = settledFrontierBotVillageSeedAt({ x, y }, { frontierRadius })
      if (seed === null || (!explicit && excludedCampKeys.has(`${x},${y}`))
        || now.getTime() - botCooldown(account, x, y) < BOT_RAID_COOLDOWN_MS) return null
      return { x, y, seed }
    }
    if (explicit) {
      if (rawX === undefined || rawY === undefined) throw new ApiError(400, 'Both camp coordinates are required')
      const x = coordinate(rawX, 'x')
      const y = coordinate(rawY, 'y')
      const distance = Math.max(Math.abs(x - plot.x), Math.abs(y - plot.y))
      if (distance === 0 || distance > watchtowerSightOf(villageBuildings(village))) {
        throw new ApiError(403, 'That camp is beyond your watchtower sight')
      }
      const camp = candidateAt(x, y)
      if (!camp || await tx.world.getOccupant(plot.worldId, x, y)) {
        throw new ApiError(409, 'That camp is unavailable or still recovering')
      }
      return { ...camp, revisionEpoch, visible: true }
    }

    // Prefer already-durable camps from map/cron provisioning. This removes
    // procedural generation from the cloud-match latency path in established
    // worlds while retaining the bounded deterministic probe as an empty-pool
    // fallback for a brand-new database.
    const persistedPool = await tx.world.listBotVillages({
      worldId: plot.worldId,
      minX: -127,
      maxX: 128,
      minY: -127,
      maxY: 128,
      now,
      limit: BOT_PROBE_LIMIT
    })
    if (persistedPool.length > 0) {
      const occupied = new Set((await tx.world.listOccupantsAt(
        plot.worldId,
        persistedPool.map(bot => ({ x: bot.x, y: bot.y }))
      )).map(item => `${item.x},${item.y}`))
      const eligible = persistedPool.filter(bot => {
        const key = `${bot.x},${bot.y}`
        const resources = bot.world.resources
        return !occupied.has(key)
          && !excludedCampKeys.has(key)
          && now.getTime() - botCooldown(account, bot.x, bot.y) >= BOT_RAID_COOLDOWN_MS
          && (resources.gold + (resources.ore ?? 0) + (resources.food ?? 0)) > 0
      })
      if (eligible.length > 0) {
        const selected = eligible[hashString(`${account.id}:${operationId}:persisted-bot`) % eligible.length]!
        return {
          x: selected.x,
          y: selected.y,
          seed: selected.seed,
          revisionEpoch,
          visible: false
        }
      }
    }

    const random = mulberry32(hashString(`${account.id}:${operationId}:bot`))
    const minimumDistance = watchtowerSightOf(villageBuildings(village)) + 1
    const candidates: Array<{ x: number; y: number; seed: number }> = []
    for (let probe = 0; probe < BOT_PROBE_LIMIT; probe += 1) {
      const distance = minimumDistance + 1 + Math.floor(random() * 4_096)
      const angle = random() * Math.PI * 2
      const x = Math.max(-WORLD_COORD_LIMIT, Math.min(WORLD_COORD_LIMIT, plot.x + Math.round(Math.cos(angle) * distance)))
      const y = Math.max(-WORLD_COORD_LIMIT, Math.min(WORLD_COORD_LIMIT, plot.y + Math.round(Math.sin(angle) * distance)))
      const camp = candidateAt(x, y)
      if (camp) candidates.push(camp)
    }
    const occupied = new Set((await tx.world.listOccupantsAt(plot.worldId, candidates))
      .map(occupant => `${occupant.x},${occupant.y}`))
    for (const camp of candidates) {
      if (!occupied.has(`${camp.x},${camp.y}`)) return { ...camp, revisionEpoch, visible: false }
    }
    throw new ApiError(404, 'No bot camps are available within the bounded search')
  }

  async botStart(principal: RuntimePrincipal, body: BotStartRequest, rawToken?: unknown): Promise<StartedBotAttack> {
    const operationId = requestId(body?.requestId, 'Bot raid start')
    const excludedCampKeys = botCampExclusions(body?.excludeCampKeys)
    return this.serializable(async (tx, now) => {
      const result = await idempotentMutation(tx, {
        actorId: principal.playerId,
        operation: 'bot-attack-start',
        requestId: operationId,
        now,
        expiresAt: new Date(now.getTime() + START_IDEMPOTENCY_TTL_MS)
      }, async () => {
        if ((await this.outgoingAfterExpiry(tx, principal.playerId, now)).length > 0) {
          throw new ApiError(409, 'Finish or abort your active attack first')
        }
        const attacker = await this.reserveVillageArmy(tx, principal.playerId, now)
        const attackerAccountRevision = attacker.account.revision
        const attackerAccountBefore = accountFingerprint(attacker.account)
        attacker.account.botRaidCooldowns = jsonObject(normalizeBotRaidCooldowns(
          attacker.account.botRaidCooldowns, now.getTime()
        ))
        const camp = await this.chooseBotCamp(
          tx, attacker.account, attacker.village, attacker.plot, body?.x, body?.y,
          operationId, excludedCampKeys, now
        )
        if (accountFingerprint(attacker.account) !== attackerAccountBefore) {
          await updateAccount(tx, attacker.account, attackerAccountRevision)
        }
        const bot = await ensurePersistedBotVillage(tx, {
          worldId: attacker.plot.worldId,
          worldGenerationVersion: CURRENT_WORLD_GENERATION_VERSION,
          revisionEpoch: camp.revisionEpoch,
          x: camp.x,
          y: camp.y,
          seed: camp.seed,
          now
        })
        const attackId = this.createId('botraid')
        const world = botWorldForAttack(bot)
        const expiresAt = now.getTime() + BOT_RAID_SESSION_MS
        const authority = prepareBotAttack({
          attackId,
          attackerId: attacker.account.id,
          attackerName: attacker.account.username,
          sourceArmyVersion: attacker.village.economyRevision,
          selectionSource: camp.visible ? 'BOT_MAP' : 'BOT_MATCHMADE',
          worldId: attacker.plot.worldId,
          botId: bot.id,
          botGeneratorVersion: bot.generatorVersion,
          botVillageRevision: bot.revision,
          botPlotVersion: bot.plotVersion,
          x: camp.x,
          y: camp.y,
          seed: bot.seed,
          world,
          reservedArmy: attacker.reservedArmy,
          troopLevel: attacker.troopLevel,
          startedAt: now.getTime(),
          expiresAt,
          raidableShare: RAIDABLE_SHARE
        })
        await tx.attacks.insert(attackRecordFromAuthority(authority, {
          fencingTokenHash: tokenHash(rawToken),
          targetPlotVersion: bot.plotVersion,
          updatedAt: now
        }))
        await this.persistStartChunk(tx, authority, world, now)
        await tx.outbox.add(outboxEvent({
          topic: 'combat', aggregateType: 'attack', aggregateId: attackId,
          eventType: 'attack.prepared', payload: { targetKind: 'bot', x: camp.x, y: camp.y }, now
        }))
        return jsonValue({ raidId: attackId, x: camp.x, y: camp.y, seed: bot.seed, world, expiresAt })
      })
      return result.response as unknown as StartedBotAttack
    })
  }

  private async engagePrepared(tx: UnitOfWork, record: AttackRecord, now: Date): Promise<AttackAggregate> {
    const authority = record.authority
    if (!authority || authority.phase !== 'PREPARING') throw new ApiError(409, 'Attack is not preparing')
    let observation: Parameters<typeof engageAttack>[3] extends { validateAndLockTarget(request: never): infer R } ? R : never
    if (authority.target.kind === 'PLAYER') {
      const account = await tx.accounts.getById(authority.target.playerId, { forUpdate: true })
      const village = await tx.villages.get(authority.target.playerId, { forUpdate: true })
      const plot = await tx.world.getPlayerPlot(authority.target.playerId, { forUpdate: true })
      if (village) {
        const expected = village.economyRevision
        const before = villageFingerprint(village)
        await this.materializeWithAudit(tx, village, now, true)
        if (villageFingerprint(village) !== before) await updateVillage(tx, village, expected, now)
      }
      const plotRef = {
        worldId: plot?.worldId ?? authority.target.plot.worldId,
        x: plot?.x ?? authority.target.plot.x,
        y: plot?.y ?? authority.target.plot.y,
        version: String(plot?.plotVersion ?? 'missing')
      }
      const available = Boolean(account && village && plot && plot.playerId === authority.target.playerId)
      observation = {
        available,
        targetId: authority.target.playerId,
        plot: plotRef,
        villageVersion: village ? `appearance_${village.appearanceRevision}` : 'missing',
        shieldUntil: account?.shieldUntil?.getTime() ?? 0,
        observedAt: now.getTime(),
        ...(available ? {
          engagementLease: {
            leaseId: `lease_${authority.attackId}`,
            acquiredAt: now.getTime(),
            expiresAt: now.getTime() + authority.rules.maxCombatDurationMs + authority.rules.engagedTtlMs
          }
        } : {})
      } as typeof observation
    } else {
      observation = {
        available: true,
        targetId: authority.target.targetId,
        plot: { ...authority.target.plot },
        villageVersion: authority.target.villageVersion,
        shieldUntil: 0,
        observedAt: now.getTime(),
        engagementLease: {
          leaseId: `lease_${authority.attackId}`,
          acquiredAt: now.getTime(),
          expiresAt: now.getTime() + authority.rules.maxCombatDurationMs + authority.rules.engagedTtlMs
        }
      } as typeof observation
    }
    const engaged = engageAttack(authority, {
      expectedPhase: authority.phase,
      expectedVersion: authority.version
    }, now.getTime(), { validateAndLockTarget: () => observation })
    try {
      if (!await tx.attacks.compareAndSwapAuthority({
        attackId: record.id,
        expectedState: record.state,
        expectedVersion: record.stateVersion,
        authority: engaged,
        updatedAt: now
      })) throw new PersistenceConflictError('Attack engagement compare-and-swap failed')
    } catch (error) {
      if (authority.target.kind === 'PLAYER' && error instanceof Error
        && /defender.*(?:lease|active attack)|already.*attack/i.test(error.message)) {
        throw new ApiError(409, 'Another army reached that village first', 'ATTACK_INVALIDATED')
      }
      throw error
    }
    return engaged
  }

  private commandRecord(attack: AttackAggregate, commandId: string) {
    const command = attackCommandsFromAuthority(attack).find(item => item.commandId === commandId)
    if (!command) throw new Error(`Resulting authority omitted command ${commandId}`)
    return command
  }

  async pushCommands(principal: RuntimePrincipal, body: AttackCommandRequest): Promise<CommandResponse> {
    const id = strictId(body?.attackId ?? body?.raidId, 'attackId')
    const commands = Array.isArray(body?.commands) ? body.commands : []
    if (commands.length !== 1) throw new ApiError(400, 'Exactly one combat command is required')
    if (!commands[0] || typeof commands[0] !== 'object' || Array.isArray(commands[0])) {
      throw new ApiError(400, 'Combat command must be an object')
    }
    const rawCommand = commands[0] as AttackCommand
    try {
      return await this.serializable(async (tx, now) => {
      let record = await tx.attacks.get(id, { forUpdate: true })
      if (!record || !record.authority) throw new ApiError(404, 'Attack not found')
      if (record.attackerId !== principal.playerId) throw new ApiError(403, 'That attack belongs to another player')

      const priorId = typeof rawCommand?.commandId === 'string' ? rawCommand.commandId : ''
      const prior = priorId ? record.authority.commandReceipts[priorId] : undefined
      if (prior) {
        const applied = applyAttackCommand(record.authority, {
          expectedPhase: record.authority.phase,
          expectedVersion: record.authority.version
        }, rawCommand, now.getTime())
        await tx.attacks.commitAuthorityCommand({
          attackId: record.id,
          expectedState: record.state,
          expectedVersion: record.stateVersion,
          authority: applied.attack,
          command: this.commandRecord(applied.attack, priorId),
          updatedAt: now
        })
        return this.commandResponse(applied.attack, applied.receipt, true)
      }
      record = await this.expireIfDue(tx, record, now)
      if (!record.authority || !phaseIsActive(record.authority.phase)) {
        throw new ApiError(409, 'That attack is no longer active', 'ATTACK_INVALIDATED')
      }

      let authority = record.authority
      const wasPreparing = authority.phase === 'PREPARING'
      if (authority.phase === 'PREPARING') {
        try {
          if (authority.target.kind === 'PLAYER') {
            await this.lockParticipants(tx, [authority.attackerId, authority.target.playerId])
          }
          authority = await this.engagePrepared(tx, record, now)
          record = ensureAttack(await tx.attacks.get(id, { forUpdate: true }))
          authority = record.authority!
        } catch (error) {
          if (error instanceof AttackDomainError) domainFailure(error)
          throw error
        }
      }
      const applied = applyAttackCommand(authority, {
        expectedPhase: authority.phase,
        expectedVersion: authority.version
      }, rawCommand, now.getTime())
      const command = this.commandRecord(applied.attack, rawCommand.commandId)
      await tx.attacks.commitAuthorityCommand({
        attackId: record.id,
        expectedState: record.state,
        expectedVersion: record.stateVersion,
        authority: applied.attack,
        command,
        updatedAt: now
      })
      await tx.outbox.add(outboxEvent({
        topic: 'combat', aggregateType: 'attack', aggregateId: record.id,
        eventType: `attack.command.${rawCommand.type.toLowerCase()}`,
        payload: { sequence: rawCommand.sequence, commandId: rawCommand.commandId }, now
      }))

      if (wasPreparing && applied.attack.phase === 'ACTIVE') {
        const attacker = ensureAccount(await tx.accounts.getById(principal.playerId, { forUpdate: true }))
        if (attacker.shieldUntil && attacker.shieldUntil > now) {
          const revision = attacker.revision
          attacker.shieldUntil = null
          await updateAccount(tx, attacker, revision)
        }
      }
      if (applied.attack.phase === 'CANCELLED') {
        await this.returnArmy(tx, applied.attack, applied.attack.reservation.reserved, now)
      } else if (applied.attack.phase === 'FINALIZING') {
        const latest = ensureAttack(await tx.attacks.get(id, { forUpdate: true }))
        await this.settleFinalizing(tx, latest, latest.authority!, now)
      }
        return this.commandResponse(applied.attack, applied.receipt, applied.duplicate)
      })
    } catch (error) {
      const code = error instanceof ApiError ? error.code : undefined
      if (code === 'TARGET_MOVED' || code === 'TARGET_VERSION_CHANGED' || code === 'TARGET_SHIELDED'
        || code === 'TARGET_UNAVAILABLE' || code === 'TARGET_LOCK_REQUIRED' || code === 'ATTACK_INVALIDATED') {
        await this.cancelInvalidatedAttack(principal.playerId, id)
      }
      throw error
    }
  }

  private async cancelInvalidatedAttack(playerId: string, attackId: string): Promise<void> {
    await this.serializable(async (tx, now) => {
      const record = await tx.attacks.get(attackId, { forUpdate: true })
      const authority = record?.authority
      if (!record || !authority || record.attackerId !== playerId || authority.phase !== 'PREPARING') return
      const cancelled = cancelAttack(authority, {
        expectedPhase: authority.phase,
        expectedVersion: authority.version
      }, now.getTime(), 'target invalidated before engagement')
      if (!await tx.attacks.compareAndSwapAuthority({
        attackId,
        expectedState: record.state,
        expectedVersion: record.stateVersion,
        authority: cancelled,
        updatedAt: now
      })) return
      await this.returnArmy(tx, cancelled, cancelled.reservation.reserved, now)
      await tx.outbox.add(outboxEvent({
        topic: 'combat', aggregateType: 'attack', aggregateId: attackId,
        eventType: 'attack.invalidated', now
      }))
    })
  }

  private commandResponse(
    attack: AttackAggregate,
    receipt: { commandId: string; sequence: number; commandDigest: string; appliedVersion: number; phase: AttackAggregate['phase']; eventIndex: number },
    duplicate: boolean
  ): CommandResponse {
    return {
      attackId: attack.attackId,
      ...(attack.target.kind === 'BOT' ? { raidId: attack.attackId } : {}),
      phase: attack.phase,
      version: attack.version,
      lastCommandSequence: attack.lastCommandSequence,
      receipts: [{ ...receipt, duplicate } as unknown as Record<string, JsonValue>]
    }
  }

  private async returnArmy(tx: UnitOfWork, attack: AttackAggregate, counts: TroopCounts, now: Date): Promise<VillageRecord> {
    const village = ensureVillage(await tx.villages.get(attack.attackerId, { forUpdate: true }))
    const expected = village.economyRevision
    const before = villageFingerprint(village)
    await this.materializeWithAudit(tx, village, now)
    village.army = jsonObject(mergeArmy(villageArmy(village), counts))
    if (villageFingerprint(village) !== before) await updateVillage(tx, village, expected, now)
    return village
  }

  private async expireIfDue(tx: UnitOfWork, record: AttackRecord, now: Date): Promise<AttackRecord> {
    const authority = record.authority
    if (!authority || !phaseIsActive(authority.phase) || authority.timestamps.expiresAt > now.getTime()) return record
    if (authority.phase === 'FINALIZING') {
      await this.settleFinalizing(tx, record, authority, now)
      return ensureAttack(await tx.attacks.get(record.id, { forUpdate: true }))
    }
    const expired = expireAttack(authority, {
      expectedPhase: authority.phase,
      expectedVersion: authority.version
    }, now.getTime())
    if (!await tx.attacks.compareAndSwapAuthority({
      attackId: record.id,
      expectedState: record.state,
      expectedVersion: record.stateVersion,
      authority: expired,
      updatedAt: now
    })) throw new PersistenceConflictError('Attack expiry compare-and-swap failed')
    const latest = ensureAttack(await tx.attacks.get(record.id, { forUpdate: true }))
    const persisted = latest.authority!
    if (persisted.phase === 'EXPIRED') {
      await this.returnArmy(tx, persisted, persisted.reservation.reserved, now)
      await tx.outbox.add(outboxEvent({
        topic: 'combat', aggregateType: 'attack', aggregateId: record.id,
        eventType: 'attack.expired', now
      }))
    } else {
      await this.settleFinalizing(tx, latest, persisted, now)
    }
    return ensureAttack(await tx.attacks.get(record.id, { forUpdate: true }))
  }

  private async appendLedger(
    tx: UnitOfWork,
    playerId: string,
    attackId: string,
    balances: { gold: number; ore: number; food: number; trophies: number },
    deltas: { gold: number; ore: number; food: number; trophies: number },
    now: Date,
    role: 'attacker' | 'defender',
    operation: 'attack-settlement' | 'bot-attack-settlement'
  ): Promise<void> {
    for (const currency of ['gold', 'ore', 'food', 'trophies'] as const) {
      if (deltas[currency] === 0) continue
      await tx.balanceLedger.append({
        playerId,
        operation,
        requestId: attackId,
        currency,
        delta: deltas[currency],
        balanceAfter: balances[currency],
        metadata: { attackId, role },
        createdAt: now
      })
    }
  }

  private async settleFinalizing(
    tx: UnitOfWork,
    record: AttackRecord,
    authority: AttackAggregate,
    now: Date
  ): Promise<SettlementResponse> {
    if (authority.phase !== 'FINALIZING' || !authority.finalization) {
      throw new ApiError(409, 'Attack is not ready to settle')
    }
    if (authority.target.kind === 'PLAYER') {
      await this.lockParticipants(tx, [authority.attackerId, authority.target.playerId])
    }
    const attackerAccount = ensureAccount(await tx.accounts.getById(authority.attackerId, { forUpdate: true }))
    const attackerVillage = ensureVillage(await tx.villages.get(authority.attackerId, { forUpdate: true }))
    const attackerAccountRevision = attackerAccount.revision
    const attackerVillageRevision = attackerVillage.economyRevision
    const attackerAccountBefore = accountFingerprint(attackerAccount)
    const attackerVillageBefore = villageFingerprint(attackerVillage)
    await this.materializeWithAudit(tx, attackerVillage, now)

    let defenderAccount: AccountRecord | null = null
    let defenderVillage: VillageRecord | null = null
    let botVillage: BotVillageRecord | null = null
    let defenderAccountRevision = 0
    let defenderVillageRevision = 0
    let defenderAccountBefore = ''
    let defenderVillageBefore = ''
    if (authority.target.kind === 'PLAYER') {
      defenderAccount = ensureAccount(await tx.accounts.getById(authority.target.playerId, { forUpdate: true }))
      defenderVillage = ensureVillage(await tx.villages.get(authority.target.playerId, { forUpdate: true }))
      defenderAccountRevision = defenderAccount.revision
      defenderVillageRevision = defenderVillage.economyRevision
      defenderAccountBefore = accountFingerprint(defenderAccount)
      defenderVillageBefore = villageFingerprint(defenderVillage)
      await this.materializeWithAudit(tx, defenderVillage, now, true)
    } else if (authority.target.kind === 'BOT') {
      botVillage = await tx.world.getBotVillage(authority.target.botId, { forUpdate: true })
      if (!botVillage
        || botVillage.worldId !== authority.target.plot.worldId
        || botVillage.x !== authority.target.plot.x
        || botVillage.y !== authority.target.plot.y
        || botVillage.plotVersion !== record.targetPlotVersion) {
        throw new ApiError(409, 'The persisted bot village for this attack is no longer available')
      }
    }

    const result = authority.finalization.result
    const caps = resourceCapacity(villageBuildings(attackerVillage))
    const requested = result.loot
    const available: ResourceAmounts = defenderVillage
      ? { gold: Math.floor(defenderVillage.gold), ore: defenderVillage.ore, food: defenderVillage.food }
      : botVillage
        ? {
            gold: Math.floor(Math.max(0, botVillage.world.resources.gold)),
            ore: Math.floor(Math.max(0, botVillage.world.resources.ore ?? 0)),
            food: Math.floor(Math.max(0, botVillage.world.resources.food ?? 0))
          }
        : requested
    const loot: ResourceAmounts = {
      gold: Math.min(requested.gold, available.gold, Math.max(0, Math.floor(MAX_PLAYER_GOLD - attackerVillage.gold))),
      ore: Math.min(requested.ore, available.ore, Math.max(0, caps.ore - attackerVillage.ore)),
      food: Math.min(requested.food, available.food, Math.max(0, caps.food - attackerVillage.food))
    }
    const trophyDelta = result.requestedTrophyDelta < 0
      ? -Math.min(-result.requestedTrophyDelta, attackerAccount.trophies)
      : result.requestedTrophyDelta

    attackerVillage.gold += loot.gold
    attackerVillage.ore += loot.ore
    attackerVillage.food += loot.food
    attackerVillage.army = jsonObject(mergeArmy(villageArmy(attackerVillage), authority.finalization.settlement.releaseArmy))
    attackerAccount.trophies = Math.max(0, attackerAccount.trophies + trophyDelta)
    if (authority.target.kind === 'BOT') {
      attackerAccount.botRaidCooldowns = jsonObject(recordBotRaidCooldown(
        attackerAccount.botRaidCooldowns,
        authority.target.plot.x,
        authority.target.plot.y,
        now.getTime()
      ))
    }
    if (villageFingerprint(attackerVillage) !== attackerVillageBefore) {
      await updateVillage(tx, attackerVillage, attackerVillageRevision, now)
    }
    if (accountFingerprint(attackerAccount) !== attackerAccountBefore) {
      await updateAccount(tx, attackerAccount, attackerAccountRevision)
    }

    if (defenderAccount && defenderVillage) {
      defenderVillage.gold = Math.max(0, defenderVillage.gold - loot.gold)
      defenderVillage.ore = Math.max(0, defenderVillage.ore - loot.ore)
      defenderVillage.food = Math.max(0, defenderVillage.food - loot.food)
      defenderAccount.trophies = Math.max(0, defenderAccount.trophies - trophyDelta)
      const shieldUntil = authority.finalization.settlement.defender?.shieldUntilAtLeast ?? 0
      if (shieldUntil > (defenderAccount.shieldUntil?.getTime() ?? 0)) defenderAccount.shieldUntil = new Date(shieldUntil)
      defenderAccount.revengeRights = jsonObject(grantRevengeRight(
        defenderAccount.revengeRights, authority.attackerId, now.getTime()
      ))
      if (villageFingerprint(defenderVillage) !== defenderVillageBefore) {
        await updateVillage(tx, defenderVillage, defenderVillageRevision, now)
      }
      if (accountFingerprint(defenderAccount) !== defenderAccountBefore) {
        await updateAccount(tx, defenderAccount, defenderAccountRevision)
      }
    }

    if (botVillage && (loot.gold > 0 || loot.ore > 0 || loot.food > 0)) {
      const expectedRevision = botVillage.revision
      botVillage.world.resources = {
        gold: Math.max(0, botVillage.world.resources.gold - loot.gold),
        ore: Math.max(0, (botVillage.world.resources.ore ?? 0) - loot.ore),
        food: Math.max(0, (botVillage.world.resources.food ?? 0) - loot.food)
      }
      botVillage.revision += 1
      botVillage.updatedAt = now
      botVillage.world.revision = botVillage.revision
      botVillage.world.lastSaveTime = now.getTime()
      if (!await tx.world.updateBotVillage(botVillage, expectedRevision)) {
        throw new PersistenceConflictError('Bot village settlement compare-and-swap failed')
      }
    }

    const receipt: AttackSettlementReceipt = {
      settlementId: authority.finalization.settlement.settlementId,
      transactionId: `tx_${authority.attackId}`,
      resultHash: result.resultHash,
      committedAt: now.getTime(),
      applied: {
        loot,
        trophyDelta,
        consumedArmy: { ...authority.finalization.settlement.consumeArmy }
      }
    }
    const settled = settleAttack(authority, {
      expectedPhase: authority.phase,
      expectedVersion: authority.version
    }, receipt)
    if (!await tx.attacks.compareAndSwapAuthority({
      attackId: record.id,
      expectedState: record.state,
      expectedVersion: record.stateVersion,
      authority: settled,
      updatedAt: now
    })) throw new PersistenceConflictError('Attack settlement compare-and-swap failed')

    const response: SettlementResponse = {
      lootApplied: loot.gold,
      oreApplied: loot.ore,
      foodApplied: loot.food,
      attackerBalance: Math.floor(attackerVillage.gold),
      attackerOre: attackerVillage.ore,
      attackerFood: attackerVillage.food,
      trophyDelta,
      attackerTrophies: attackerAccount.trophies,
      revision: attackerVillage.economyRevision,
      army: { ...villageArmy(attackerVillage) }
    }
    const ledgerOperation = authority.target.kind === 'BOT'
      ? 'bot-attack-settlement' as const
      : 'attack-settlement' as const
    await tx.attacks.settle({
      attackId: authority.attackId,
      attackerId: authority.attackerId,
      defenderId: authority.target.kind === 'PLAYER' ? authority.target.playerId : null,
      outcome: jsonObject({ response, resultHash: result.resultHash }),
      committedAt: now
    })
    const replay = jsonValue(compactReplay(settled, { includeEconomy: true }))
    await tx.replays.append({
      attackId: authority.attackId,
      sequence: FINAL_REPLAY_SEQUENCE,
      format: 'compact-authority-v1',
      payload: replay,
      objectKey: null,
      checksum: stableHash(replay),
      createdAt: now
    })
    await this.appendLedger(tx, attackerAccount.id, authority.attackId, {
      gold: Math.floor(attackerVillage.gold), ore: attackerVillage.ore, food: attackerVillage.food,
      trophies: attackerAccount.trophies
    }, { gold: loot.gold, ore: loot.ore, food: loot.food, trophies: trophyDelta }, now, 'attacker', ledgerOperation)
    if (defenderAccount && defenderVillage) {
      await this.appendLedger(tx, defenderAccount.id, authority.attackId, {
        gold: Math.floor(defenderVillage.gold), ore: defenderVillage.ore, food: defenderVillage.food,
        trophies: defenderAccount.trophies
      }, { gold: -loot.gold, ore: -loot.ore, food: -loot.food, trophies: -trophyDelta }, now, 'defender', ledgerOperation)
      await tx.notifications.add({
        playerId: defenderAccount.id,
        id: authority.attackId,
        eventType: 'attack-settled',
        payload: {
          attackId: authority.attackId,
          attackerId: authority.attackerId,
          attackerName: authority.attackerName,
          goldLost: loot.gold,
          oreLost: loot.ore,
          foodLost: loot.food,
          destruction: result.destruction,
          trophyDelta: -trophyDelta,
          replayAvailable: true
        },
        occurredAt: now,
        readAt: null
      })
    }
    await tx.outbox.add(outboxEvent({
      topic: 'combat', aggregateType: 'attack', aggregateId: authority.attackId,
      eventType: 'attack.settled', payload: { targetKind: authority.target.kind.toLowerCase(), resultHash: result.resultHash }, now
    }))
    return response
  }

  private zeroSettlement(account: AccountRecord, village: VillageRecord): SettlementResponse {
    return {
      lootApplied: 0,
      oreApplied: 0,
      foodApplied: 0,
      attackerBalance: Math.floor(village.gold),
      attackerOre: village.ore,
      attackerFood: village.food,
      trophyDelta: 0,
      attackerTrophies: account.trophies,
      revision: village.economyRevision,
      army: { ...villageArmy(village) }
    }
  }

  private async settleById(
    principal: RuntimePrincipal,
    id: string,
    reason: 'OBJECTIVE_COMPLETE' | 'SURRENDER'
  ): Promise<SettlementResponse> {
    return this.serializable(async (tx, now) => {
      let record = await tx.attacks.get(id, { forUpdate: true })
      if (!record?.authority) throw new ApiError(404, 'Attack not found')
      if (record.attackerId !== principal.playerId) throw new ApiError(403, 'Only the attacker can end an attack')
      record = await this.expireIfDue(tx, record, now)
      let authority = record.authority!
      if (authority.phase === 'SETTLED') {
        const account = ensureAccount(await tx.accounts.getById(principal.playerId))
        const village = ensureVillage(await tx.villages.get(principal.playerId))
        const applied = authority.finalization?.receipt?.applied
        return {
          ...this.zeroSettlement(account, village),
          lootApplied: applied?.loot.gold ?? 0,
          oreApplied: applied?.loot.ore ?? 0,
          foodApplied: applied?.loot.food ?? 0,
          trophyDelta: applied?.trophyDelta ?? 0
        }
      }
      if (authority.phase === 'CANCELLED' || authority.phase === 'EXPIRED') {
        const account = ensureAccount(await tx.accounts.getById(principal.playerId))
        const village = ensureVillage(await tx.villages.get(principal.playerId))
        return this.zeroSettlement(account, village)
      }
      if (authority.phase === 'PREPARING' || authority.phase === 'ENGAGED') {
        const cancelled = cancelAttack(authority, {
          expectedPhase: authority.phase,
          expectedVersion: authority.version
        }, now.getTime(), 'attacker ended before deployment')
        if (!await tx.attacks.compareAndSwapAuthority({
          attackId: record.id,
          expectedState: record.state,
          expectedVersion: record.stateVersion,
          authority: cancelled,
          updatedAt: now
        })) throw new PersistenceConflictError('Attack cancellation compare-and-swap failed')
        const village = await this.returnArmy(tx, cancelled, cancelled.reservation.reserved, now)
        const account = ensureAccount(await tx.accounts.getById(principal.playerId))
        await tx.outbox.add(outboxEvent({
          topic: 'combat', aggregateType: 'attack', aggregateId: record.id,
          eventType: 'attack.cancelled', now
        }))
        return this.zeroSettlement(account, village)
      }
      if (authority.phase === 'ACTIVE') {
        authority = finalizeAttack(authority, {
          expectedPhase: authority.phase,
          expectedVersion: authority.version
        }, reason, now.getTime())
        if (!await tx.attacks.compareAndSwapAuthority({
          attackId: record.id,
          expectedState: record.state,
          expectedVersion: record.stateVersion,
          authority,
          updatedAt: now
        })) throw new PersistenceConflictError('Attack finalization compare-and-swap failed')
        record = ensureAttack(await tx.attacks.get(record.id, { forUpdate: true }))
        authority = record.authority!
      }
      return this.settleFinalizing(tx, record, authority, now)
    })
  }

  async endAttack(principal: RuntimePrincipal, body: AttackEndRequest): Promise<SettlementResponse> {
    const id = strictId(body?.attackId, 'attackId')
    return this.settleById(principal, id, body?.status === 'aborted' ? 'SURRENDER' : 'OBJECTIVE_COMPLETE')
  }

  async botSettle(principal: RuntimePrincipal, body: BotSettleRequest): Promise<{
    lootApplied: number
    attackerBalance: number
    army: Record<string, number>
    revision: number
  }> {
    const id = strictId(body?.raidId, 'raidId')
    const record = await this.persistence.transaction(tx => tx.attacks.get(id))
    if (!record?.authority || record.authority.target.kind !== 'BOT') throw new ApiError(404, 'Bot raid not found')
    if (body?.x !== undefined || body?.y !== undefined) {
      if (body.x === undefined || body.y === undefined) throw new ApiError(400, 'Both camp coordinates are required')
      if (coordinate(body.x, 'x') !== record.targetX || coordinate(body.y, 'y') !== record.targetY) {
        throw new ApiError(409, 'Camp coordinates do not match the bot raid')
      }
    }
    const result = await this.settleById(principal, id, 'OBJECTIVE_COMPLETE')
    return {
      lootApplied: result.lootApplied,
      attackerBalance: result.attackerBalance,
      army: result.army,
      revision: result.revision
    }
  }

  async pushFrames(principal: RuntimePrincipal, body: AttackFrameRequest): Promise<{ frameCount: number }> {
    const id = strictId(body?.attackId, 'attackId')
    const rawFrames = Array.isArray(body?.frames) ? body.frames : []
    if (rawFrames.length > 16) throw new ApiError(400, 'Replay frame batches may contain at most 16 frames')
    return this.serializable(async (tx, now) => {
      const record = await tx.attacks.get(id)
      if (!record?.authority) throw new ApiError(404, 'Attack not found')
      if (record.attackerId !== principal.playerId) throw new ApiError(403, 'Only the attacker can publish replay frames')
      if (!phaseIsActive(record.authority.phase)) throw new ApiError(409, 'That attack is no longer active', 'ATTACK_INVALIDATED')
      const maxT = record.authority.rules.maxCombatDurationMs
      let highWater = 0
      for (const raw of rawFrames) {
        const frame = sanitizeFrame(raw, maxT)
        if (!frame) continue
        // Mirror legacy game.ts: stored replay frames advertise the settled
        // loot curve (authoritative caps × destruction), never the attacker's
        // claimed counters — defender-side replays/reports must not inflate.
        const lootCaps = record.authority.rewardPolicy.lootCaps
        frame.goldLooted = Math.floor(lootCaps.gold * frame.destruction / 100)
        frame.oreLooted = Math.floor(lootCaps.ore * frame.destruction / 100)
        frame.foodLooted = Math.floor(lootCaps.food * frame.destruction / 100)
        const checksum = stableHash(frame)
        const sequence = presentationSequence(frame.t, maxT)
        const existing = (await tx.replays.listForParticipant({
          attackId: id,
          participantId: principal.playerId,
          afterSequence: sequence - 1,
          limit: 1
        }))[0]
        highWater = Math.max(highWater, sequence)
        // One deterministic sample per duration bucket keeps storage capped at
        // MAX_REPLAY_FRAMES without scanning prior chunks on every append.
        if (existing?.sequence === sequence) continue
        const chunk: ReplayChunkRecord = {
          attackId: id,
          sequence,
          format: 'presentation-frame-v1',
          payload: jsonValue(frame),
          objectKey: null,
          checksum,
          createdAt: now
        }
        await tx.replays.appendPresentation(chunk, {
          byteSize: Buffer.byteLength(JSON.stringify(frame), 'utf8'),
          maxBytes: MAX_PRESENTATION_REPLAY_BYTES,
          maxChunks: MAX_REPLAY_FRAMES
        })
      }
      return { frameCount: highWater }
    })
  }

  private async loadReplayChunks(
    tx: UnitOfWork,
    attackId: string,
    participantId: string,
    afterSequence: number
  ): Promise<ReplayChunkRecord[]> {
    const chunks: ReplayChunkRecord[] = []
    let cursor = afterSequence
    for (let page = 0; page < REPLAY_PAGE_LIMIT; page += 1) {
      const next = await tx.replays.listForParticipant({
        attackId,
        participantId,
        afterSequence: cursor,
        limit: REPLAY_PAGE_SIZE
      })
      chunks.push(...next)
      if (next.length < REPLAY_PAGE_SIZE) break
      cursor = next[next.length - 1]!.sequence
    }
    return chunks
  }

  async getReplay(principal: RuntimePrincipal, rawAttackId: unknown, afterT?: unknown): Promise<Record<string, unknown>> {
    const attackId = strictId(rawAttackId, 'attackId')
    return this.persistence.transaction(async tx => {
      const record = await tx.attacks.get(attackId)
      if (!record?.authority) throw new ApiError(404, 'Replay not found')
      if (record.attackerId !== principal.playerId && record.defenderId !== principal.playerId) {
        throw new ApiError(403, 'Not authorized to watch this attack')
      }
      const incremental = afterT !== undefined && Number.isFinite(Number(afterT))
      const afterSequence = incremental
        ? presentationSequence(nonNegativeInt(afterT), record.authority.rules.maxCombatDurationMs)
        : -1
      const chunks = await this.loadReplayChunks(tx, attackId, principal.playerId, afterSequence)
      const frames = chunks
        .filter(chunk => chunk.format === 'presentation-frame-v1')
        .map(replayPayload)
        .filter((frame): frame is Record<string, unknown> => Boolean(frame))
        .slice(-260)
      const start = incremental ? null : chunks.find(chunk => chunk.format === 'attack-start-v1')
      const world = start ? replayPayload(start)?.world : undefined
      const result = record.authority.finalization
      const applied = result?.receipt?.applied
      return {
        attackId,
        attackerId: record.attackerId,
        attackerName: record.authority.attackerName,
        victimId: record.authority.target.targetId,
        victimName: world && typeof world === 'object' ? (world as { username?: unknown }).username : undefined,
        status: terminalStatus(record.authority),
        startedAt: record.createdAt.getTime(),
        updatedAt: record.updatedAt.getTime(),
        ...(record.endedAt ? { endedAt: record.endedAt.getTime() } : {}),
        ...(!incremental && world ? { enemyWorld: world } : {}),
        ...(result ? {
          finalResult: {
            destruction: result.result.destruction,
            goldLooted: applied?.loot.gold ?? 0,
            oreLooted: applied?.loot.ore ?? 0,
            foodLooted: applied?.loot.food ?? 0,
            trophyDelta: applied?.trophyDelta ?? 0
          }
        } : {}),
        frameCount: frames.length,
        latestFrame: frames.length > 0 ? frames[frames.length - 1] : null,
        frames
      }
    })
  }

  async incomingAttacks(principal: RuntimePrincipal): Promise<Array<Record<string, unknown>>> {
    return this.serializable(async (tx, now) => {
      const records = await tx.attacks.listLeasedIncoming(principal.playerId, ACTIVE_LIMIT)
      for (const record of records) await this.expireIfDue(tx, record, now)
      return (await tx.attacks.listLeasedIncoming(principal.playerId, ACTIVE_LIMIT))
        .filter(record => record.authority && phaseIsActive(record.authority.phase))
        .map(record => ({
          attackId: record.id,
          attackerId: record.attackerId,
          attackerName: record.authority!.attackerName,
          victimId: principal.playerId,
          startedAt: record.createdAt.getTime(),
          updatedAt: record.updatedAt.getTime()
        }))
    })
  }

  async activeOutgoingBattle(principal: RuntimePrincipal, rawToken: unknown): Promise<{ session: Record<string, unknown> | null }> {
    return this.serializable(async (tx, now) => {
      const records = await this.outgoingAfterExpiry(tx, principal.playerId, now)
      const record = records[0]
      if (!record?.authority) return { session: null }
      const ownedByCurrentSession = Boolean(record.fencingTokenHash && record.fencingTokenHash === tokenHash(rawToken))
      if (record.authority.target.kind === 'BOT') {
        return { session: {
          kind: 'bot', raidId: record.id, x: record.targetX, y: record.targetY,
          startedAt: record.createdAt.getTime(), expiresAt: record.deadlineAt.getTime(), ownedByCurrentSession
        } }
      }
      return { session: {
        kind: 'pvp', attackId: record.id, startedAt: record.createdAt.getTime(),
        updatedAt: record.updatedAt.getTime(), hasDeployments: record.authority.lastCommandSequence > 0,
        ownedByCurrentSession
      } }
    })
  }

  async abortActiveOutgoingBattle(principal: RuntimePrincipal): Promise<{
    aborted: boolean
    kind?: 'pvp' | 'bot'
    world: SerializedWorld
  }> {
    const active = await this.serializable(async (tx, now) => {
      const records = await this.outgoingAfterExpiry(tx, principal.playerId, now)
      return records[0]?.authority
        ? { id: records[0].id, kind: records[0].authority!.target.kind === 'BOT' ? 'bot' as const : 'pvp' as const }
        : null
    })
    if (active) await this.settleById(principal, active.id, 'SURRENDER')
    const world = await this.persistence.transaction(async tx => {
      const now = this.now()
      const account = ensureAccount(await tx.accounts.getById(principal.playerId))
      const village = ensureVillage(await tx.villages.get(principal.playerId))
      return serializedWorldOf(account, village, now)
    })
    return { aborted: Boolean(active), ...(active ? { kind: active.kind } : {}), world }
  }

  /**
   * Bounded background maintenance. PostgreSQL claims due rows with
   * `FOR UPDATE SKIP LOCKED`, so many API processes can run this safely.
   */
  async sweepDueAttacks(limit = 50): Promise<{ processed: number; settled: number; expired: number }> {
    const bounded = Math.max(1, Math.min(100, Math.floor(limit)))
    return this.serializable(async (tx, now) => {
      const due = await tx.attacks.claimDue(now, bounded)
      let settled = 0
      let expired = 0
      for (const record of due) {
        const next = await this.expireIfDue(tx, record, now)
        if (next.authority?.phase === 'SETTLED') settled += 1
        else if (next.authority?.phase === 'EXPIRED') expired += 1
      }
      await tx.replays.prunePresentation(
        new Date(now.getTime() - PRESENTATION_REPLAY_RETENTION_MS),
        Math.min(10, bounded)
      )
      return { processed: due.length, settled, expired }
    })
  }

  async authorizeMapFocus(principal: RuntimePrincipal, x: number, y: number): Promise<boolean> {
    return this.serializable(async (tx, now) => {
      const records = await this.outgoingAfterExpiry(tx, principal.playerId, now)
      return records.some(record => record.targetX === x && record.targetY === y && record.authority && phaseIsActive(record.authority.phase))
    })
  }
}

function ensureAttack(record: AttackRecord | null): AttackRecord {
  if (!record?.authority) throw new ApiError(404, 'Attack not found')
  return record
}

export function createPersistenceAttackService(
  persistence: Persistence,
  options: PersistenceAttackServiceOptions = {}
): PersistenceAttackService {
  return new PersistenceAttackService(persistence, options)
}
