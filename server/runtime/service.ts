import {
  TROOP_DEFINITIONS,
  getTroopUnlockLevel,
  troopFoodCostOf,
  type TroopType
} from '../../src/game/config/GameDefinitions'
import {
  armySpaceUsed,
  botNameFor,
  campCapacityOf,
  isWildernessPreserveAt,
  maxBarracksLevel,
  merchantOffersFor,
  resourceCapacity,
  watchtowerSightOf,
  worldDayIndex,
  botSeedAt
} from '../../src/game/config/Economy'
import type { SerializedWorld } from '../../src/game/data/Models'
import {
  VillageRuleError,
  populationCapacity,
  priceVillageMutation,
  sanitizeBuildings,
  sanitizeObstacles,
  validateVillageLayout
} from '../domain/village'
import {
  CURRENT_WORLD_GENERATION_VERSION,
  MAX_WORLD_COORDINATE,
  classifyPlot
} from '../domain/world'
import { ApiError } from '../errors'
import type {
  AccountRecord,
  JsonObject,
  JsonValue,
  Persistence,
  UnitOfWork,
  VillageRecord,
  WorldAtlasEntry
} from '../persistence'
import { outboxEvent } from '../persistence'
import { AuthSessionService } from './auth-service'
import type {
  ApiService,
  ArmyMutationRequest,
  AttackCommandRequest,
  AttackEndRequest,
  AttackFrameRequest,
  AttackStartRequest,
  BotSettleRequest,
  BotStartRequest,
  MerchantTradeRequest,
  ResourceMutationRequest,
  RuntimeAttackService,
  RuntimePrincipal,
  SaveWorldRequest
} from './contracts'
import { randomId } from './ids'
import {
  MAX_PLAYER_GOLD,
  materializeVillage,
  publicWorldOf,
  serializedWorldOf,
  stoneMaturityOf,
  villageArmy,
  villageBuildings,
  villageObstacles,
  villagePopulation
} from './village-state'
import {
  ACTIVE_INCOMING_STATES,
  VillageAuthority,
  villageMaterialFingerprint
} from './village-authority'
import {
  allocatePlayerPlot,
  claimSpecificPlayerPlot,
  releasePlayerPlotClaim
} from './world-authority'

const ONLINE_WINDOW_MS = 60_000
const IDEMPOTENCY_TTL_MS = 24 * 60 * 60_000
const OUTBOX_PUBLISHED_RETENTION_MS = 24 * 60 * 60_000
const OUTBOX_DELIVERY_WINDOW_MS = 7 * 24 * 60 * 60_000
const OPERATION_MARKER_RETENTION_MS = 2 * 24 * 60 * 60_000
const ATLAS_RADIUS = 24
const ATLAS_LIMIT = 500
const HOME_COORD_LIMIT = MAX_WORLD_COORDINATE - 2

const AMBIENT_GRANTS: Record<string, { resource: 'ore' | 'food'; perCall: number; perHour: number }> = {
  egg_collect: { resource: 'food', perCall: 90, perHour: 500 },
  rock_haul: { resource: 'ore', perCall: 25, perHour: 250 }
}

interface RuntimeOptions {
  attacks?: RuntimeAttackService
  now?: () => Date
  starterShieldMs?: number
  sessionTtlMs?: number
  allowDebugGrants?: boolean
  upgradeTimeScale?: number
}

class NoCommitResponse extends Error {
  readonly response: unknown

  constructor(response: unknown) {
    super('Return this response without committing the transaction')
    this.response = response
  }
}

function unsupportedAttack(): never {
  throw new ApiError(501, 'The normalized attack application service is not configured', 'ATTACK_RUNTIME_UNAVAILABLE')
}

const NO_ATTACKS: RuntimeAttackService = {
  botSettle: unsupportedAttack,
  botStart: unsupportedAttack,
  activeOutgoingBattle: unsupportedAttack,
  abortActiveOutgoingBattle: unsupportedAttack,
  startAttack: unsupportedAttack,
  matchmake: unsupportedAttack,
  pushFrames: unsupportedAttack,
  pushCommands: unsupportedAttack,
  endAttack: unsupportedAttack,
  incomingAttacks: unsupportedAttack,
  getReplay: unsupportedAttack,
  authorizeMapFocus: async () => false
}

function toInteger(value: unknown, fallback: number): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? Math.floor(parsed) : fallback
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value))
}

function sanitizeId(value: unknown): string {
  return String(value ?? '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 96)
}

function requestId(value: unknown): string {
  return typeof value === 'string' ? value.trim().slice(0, 160) : ''
}

function asJson(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue
}

function cloneJson<T>(value: T): T {
  return structuredClone(value)
}

function worldCoordinate(value: unknown, fallback: number): number {
  if (value === undefined || value === null || value === '') return fallback
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || Math.abs(parsed) > MAX_WORLD_COORDINATE) {
    throw new ApiError(400, 'Plot coordinates are outside the world')
  }
  return parsed
}

function chebyshev(ax: number, ay: number, bx: number, by: number): number {
  return Math.max(Math.abs(ax - bx), Math.abs(ay - by))
}

function accountForSummary(entry: WorldAtlasEntry): AccountRecord {
  return {
    id: entry.player.playerId,
    username: entry.player.username,
    usernameKey: null,
    passwordHash: null,
    registered: true,
    trophies: entry.player.trophies,
    shieldUntil: entry.player.shieldUntil,
    createdAt: entry.accountCreatedAt,
    lastSeenAt: entry.player.lastSeenAt,
    revision: entry.player.revision,
    revengeRights: {},
    botRaidCooldowns: {}
  }
}

function villageForPostcard(entry: WorldAtlasEntry): VillageRecord {
  return {
    playerId: entry.village.playerId,
    buildings: cloneJson(entry.village.buildings),
    obstacles: cloneJson(entry.village.obstacles),
    army: {},
    wallLevel: entry.village.wallLevel,
    gold: entry.simulation.gold,
    ore: entry.simulation.ore,
    food: entry.simulation.food,
    productionRemainders: cloneJson(entry.simulation.productionRemainders),
    population: cloneJson(entry.village.population),
    simulatedThrough: entry.village.simulatedThrough,
    lastMutationAt: entry.village.lastMutationAt,
    layoutRevision: entry.village.layoutRevision,
    appearanceRevision: entry.village.appearanceRevision,
    economyRevision: entry.simulation.economyRevision,
    simulationVersion: entry.village.simulationVersion,
    nextEventAt: entry.village.nextEventAt
  }
}

function knownRevisions(raw: unknown): Map<string, { ownerId: string; revision: number }> {
  const known = new Map<string, { ownerId: string; revision: number }>()
  if (typeof raw !== 'string') return known
  for (const pair of raw.split(';').slice(0, 100)) {
    const revisionAt = pair.lastIndexOf(':')
    const ownerAt = pair.lastIndexOf(':', revisionAt - 1)
    if (ownerAt <= 0 || revisionAt <= ownerAt) continue
    const coordinate = pair.slice(0, ownerAt)
    const ownerId = sanitizeId(pair.slice(ownerAt + 1, revisionAt))
    const revision = toInteger(pair.slice(revisionAt + 1), -1)
    if (/^-?\d+,-?\d+$/.test(coordinate) && ownerId && revision >= 0) {
      known.set(coordinate, { ownerId, revision })
    }
  }
  return known
}

function villageRule<T>(operation: () => T): T {
  try {
    return operation()
  } catch (error) {
    if (!(error instanceof VillageRuleError)) throw error
    throw new ApiError(
      error.failure === 'CONFLICT' ? 409 : 400,
      error.message,
      error.clientCode,
      error.details
    )
  }
}

/** Transactional application service over normalized persistence. */
export class PersistenceGameService implements ApiService<RuntimePrincipal> {
  private readonly persistence: Persistence
  private readonly attacks: RuntimeAttackService
  private readonly clock: () => Date
  private readonly allowDebugGrants: boolean
  private readonly upgradeTimeScale: number
  private readonly authority: VillageAuthority
  private readonly auth: AuthSessionService

  constructor(persistence: Persistence, options: RuntimeOptions = {}) {
    this.persistence = persistence
    this.attacks = options.attacks ?? NO_ATTACKS
    this.clock = options.now ?? (() => new Date())
    this.allowDebugGrants = options.allowDebugGrants ?? process.env.CLASH_ALLOW_DEBUG_GRANTS === '1'
    const configuredScale = options.upgradeTimeScale ?? Number(process.env.CLASH_UPGRADE_TIME_SCALE ?? 1)
    this.upgradeTimeScale = Number.isFinite(configuredScale) && configuredScale >= 0 ? configuredScale : 1
    this.authority = new VillageAuthority()
    this.auth = new AuthSessionService(persistence, this.authority, {
      clock: this.clock,
      starterShieldMs: options.starterShieldMs,
      sessionTtlMs: options.sessionTtlMs
    })
  }

  async close(): Promise<void> {
    await this.persistence.close()
  }

  async sweepExpiredGuestLeases(limit = 50): Promise<{ released: number; archived: number }> {
    return this.auth.sweepExpiredGuestLeases(limit)
  }

  async pruneExpiredIdempotency(limit = 500): Promise<number> {
    const now = this.clock()
    return this.persistence.transaction(
      tx => tx.idempotency.pruneExpired(now, limit),
      { isolation: 'read committed' }
    )
  }

  async sweepRetention(limit = 500): Promise<{
    idempotency: number
    outboxPublished: number
    outboxExpired: number
    operationMarkers: number
  }> {
    const now = this.clock()
    return this.persistence.transaction(async tx => {
      const idempotency = await tx.idempotency.pruneExpired(now, limit)
      const outbox = await tx.outbox.prune(
        new Date(now.getTime() - OUTBOX_PUBLISHED_RETENTION_MS),
        new Date(now.getTime() - OUTBOX_DELIVERY_WINDOW_MS),
        now,
        limit
      )
      const operationMarkers = await tx.operationMarkers.pruneBefore(
        new Date(now.getTime() - OPERATION_MARKER_RETENTION_MS),
        limit
      )
      return {
        idempotency,
        outboxPublished: outbox.published,
        outboxExpired: outbox.expired,
        operationMarkers
      }
    }, { isolation: 'read committed' })
  }

  private async claimRequest(
    tx: UnitOfWork,
    principal: RuntimePrincipal,
    operation: string,
    id: string,
    now: Date
  ): Promise<{ replayed: false } | { replayed: true; response: JsonValue }> {
    if (!id) return { replayed: false }
    const claim = await tx.idempotency.claim(
      principal.playerId,
      operation,
      id,
      now,
      new Date(now.getTime() + IDEMPOTENCY_TTL_MS)
    )
    return claim.kind === 'completed'
      ? { replayed: true, response: claim.response }
      : { replayed: false }
  }

  private async completeRequest(
    tx: UnitOfWork,
    principal: RuntimePrincipal,
    operation: string,
    id: string,
    response: unknown
  ): Promise<void> {
    if (id) await tx.idempotency.complete(principal.playerId, operation, id, asJson(response))
  }

  private balances(village: VillageRecord) {
    return {
      gold: Math.floor(village.gold),
      ore: village.ore,
      food: village.food,
      revision: village.economyRevision
    }
  }

  async ensureSession(rawToken: unknown, rawAddress?: unknown) {
    return this.auth.ensureSession(rawToken, rawAddress)
  }

  async authenticate(rawToken: unknown): Promise<RuntimePrincipal> {
    return this.auth.authenticate(rawToken)
  }

  async register(
    principal: RuntimePrincipal,
    rawUsername: unknown,
    rawPassword: unknown
  ) {
    return this.auth.register(principal, rawUsername, rawPassword)
  }

  async login(rawUsername: unknown, rawPassword: unknown, rawAddress?: unknown) {
    return this.auth.login(rawUsername, rawPassword, rawAddress)
  }

  async logout(rawToken: unknown): Promise<void> {
    return this.auth.logout(rawToken)
  }

  async rename(principal: RuntimePrincipal, rawName: unknown) {
    return this.auth.rename(principal, rawName)
  }

  async getWorld(principal: RuntimePrincipal): Promise<SerializedWorld> {
    const now = this.clock()
    return this.persistence.transaction(async tx => {
      const state = await this.authority.owned(tx, principal.playerId, true)
      await this.authority.materializeOwned(
        tx,
        state.village,
        now,
        await this.authority.hasActiveIncoming(tx, principal.playerId)
      )
      return serializedWorldOf(state.account, state.village, now, { stoneMaturity: true })
    })
  }

  async saveWorld(principal: RuntimePrincipal, body: SaveWorldRequest): Promise<SerializedWorld> {
    const world = body.world
    if (!world || typeof world !== 'object') throw new ApiError(400, 'Missing world payload')
    const id = requestId(body.requestId)
    const now = this.clock()
    return this.persistence.transaction(async tx => {
      const claim = await this.claimRequest(tx, principal, 'world.save', id, now)
      if (claim.replayed) return claim.response as unknown as SerializedWorld
      const state = await this.authority.owned(tx, principal.playerId, true)
      if (await this.authority.hasActiveIncoming(tx, principal.playerId)) {
        throw new ApiError(409, 'Village resources and layout are locked while an incoming raid is live', 'BASE_UNDER_ATTACK')
      }
      if (await this.authority.hasActiveOutgoing(tx, principal.playerId)) {
        throw new ApiError(409, 'Village layout is locked while its army is reserved', 'ARMY_RESERVED')
      }
      const expectedRevision = toInteger(world.revision, Number.NaN)
      if (!Number.isFinite(expectedRevision) || expectedRevision !== state.village.economyRevision) {
        const current = cloneJson(state.village)
        materializeVillage(current, now)
        throw new ApiError(409, `Stale world revision (expected ${state.village.economyRevision})`, 'STALE_REVISION', {
          currentRevision: state.village.economyRevision,
          world: serializedWorldOf(state.account, current, now)
        })
      }
      const beforeSimulation = villageMaterialFingerprint(state.village)
      const simulation = await this.authority.materializeWithAudit(tx, state.village, now)
      const simulationChanged = villageMaterialFingerprint(state.village) !== beforeSimulation
      const beforeMutation = {
        gold: state.village.gold,
        ore: state.village.ore,
        food: state.village.food
      }
      const context = { now: now.getTime(), createId: (prefix: 'b' | 'o') => randomId(prefix, 6) }
      const proposedBuildings = villageRule(() => sanitizeBuildings(world.buildings, context))
      const proposedObstacles = villageRule(() => sanitizeObstacles(world.obstacles, context))
      const proposal = villageRule(() => validateVillageLayout({
        currentBuildings: villageBuildings(state.village),
        currentObstacles: villageObstacles(state.village),
        currentWallLevel: state.village.wallLevel,
        proposedBuildings,
        proposedObstacles,
        proposedWallLevel: world.wallLevel,
        army: villageArmy(state.village)
      }))
      let pricingSummary: { chargesGold: number; chargesOre: number; refundGold: number; obstacleRewards: number } | null = null
      if (proposal.changed) {
        const pricing = villageRule(() => priceVillageMutation({
          currentBuildings: villageBuildings(state.village),
          currentObstacles: villageObstacles(state.village),
          proposedBuildings: proposal.buildings,
          proposedObstacles: proposal.obstacles,
          now: now.getTime(),
          upgradeTimeScale: this.upgradeTimeScale
        }))
        if (pricing.bill.gold > 0 && Math.floor(state.village.gold) < pricing.bill.gold) {
          throw new ApiError(409, `Not enough gold for these changes (need ${pricing.bill.gold})`, 'INSUFFICIENT_RESOURCES', { resource: 'gold' })
        }
        if (pricing.bill.ore > 0 && state.village.ore < pricing.bill.ore) {
          throw new ApiError(409, `Not enough ore for these changes (need ${pricing.bill.ore})`, 'INSUFFICIENT_RESOURCES', { resource: 'ore' })
        }
        state.village.gold = clamp(state.village.gold - pricing.bill.gold, 0, MAX_PLAYER_GOLD)
        state.village.buildings = pricing.buildings as unknown as JsonValue[]
        state.village.obstacles = proposal.obstacles as unknown as JsonValue[]
        state.village.wallLevel = proposal.wallLevel
        const capacity = resourceCapacity(pricing.buildings)
        state.village.ore = clamp(state.village.ore - pricing.bill.ore, 0, capacity.ore)
        state.village.food = clamp(state.village.food, 0, capacity.food)
        if (state.village.ore >= capacity.ore) state.village.productionRemainders.ore = 0
        if (state.village.food >= capacity.food) state.village.productionRemainders.food = 0
        const population = villagePopulation(state.village)
        population.count = Math.min(population.count, populationCapacity(pricing.buildings))
        state.village.population = population as unknown as JsonObject
        state.village.layoutRevision += 1
        state.village.appearanceRevision += 1
        state.village.lastMutationAt = now
        pricingSummary = {
          chargesGold: pricing.charges.gold,
          chargesOre: pricing.charges.ore,
          refundGold: pricing.refundGold,
          obstacleRewards: pricing.obstacleRewards
        }
      }
      if (!proposal.changed && !simulationChanged) {
        const response = serializedWorldOf(state.account, state.village, now)
        await this.completeRequest(tx, principal, 'world.save', id, response)
        return response
      }
      await this.authority.updateVillage(tx, state.village, expectedRevision)
      const response = serializedWorldOf(state.account, state.village, now)
      await this.completeRequest(tx, principal, 'world.save', id, response)
      if (proposal.changed) {
        const auditId = id || randomId('world-save')
        for (const currency of ['gold', 'ore', 'food'] as const) {
          const delta = state.village[currency] - beforeMutation[currency]
          if (delta === 0) continue
          await tx.balanceLedger.append({
            playerId: principal.playerId,
            operation: 'world.save',
            requestId: auditId,
            currency,
            delta,
            balanceAfter: state.village[currency],
            metadata: {
              simulationFrom: simulation.from,
              simulationThrough: simulation.through,
              ...(pricingSummary ?? {})
            },
            createdAt: now
          })
        }
      }
      await tx.outbox.add(outboxEvent({
        topic: 'villages',
        aggregateType: 'village',
        aggregateId: principal.playerId,
        eventType: proposal.changed ? 'VILLAGE_LAYOUT_CHANGED' : 'VILLAGE_MATERIALIZED',
        now,
        payload: { layoutRevision: state.village.layoutRevision, appearanceRevision: state.village.appearanceRevision }
      }))
      return response
    })
  }

  async applyResources(principal: RuntimePrincipal, body: ResourceMutationRequest) {
    const delta = toInteger(body.delta, Number.NaN)
    if (!Number.isFinite(delta)) throw new ApiError(400, 'delta must be a finite number')
    const resource = body.resource === 'ore' ? 'ore' : body.resource === 'food' ? 'food' : 'gold'
    const reason = typeof body.reason === 'string' ? body.reason.slice(0, 40) : ''
    const id = requestId(body.requestId)
    if (delta > 0 && !id) throw new ApiError(400, 'requestId is required for resource grants')
    const now = this.clock()
    try {
      return await this.persistence.transaction(async tx => {
        const claim = await this.claimRequest(tx, principal, 'resources.apply', id, now)
        if (claim.replayed) return claim.response
        const state = await this.authority.owned(tx, principal.playerId, true)
        const incoming = await this.authority.hasActiveIncoming(tx, principal.playerId)
        if (delta < 0 && incoming) {
          throw new ApiError(409, 'Village resources and layout are locked while an incoming raid is live', 'BASE_UNDER_ATTACK')
        }
        await this.authority.materializeWithAudit(
          tx,
          state.village,
          now,
          incoming
        )
        if (delta === 0) throw new NoCommitResponse({ applied: false, ...this.balances(state.village) })
        if (delta > 0 && !(reason === 'debug_grant' && this.allowDebugGrants)) {
          const rule = AMBIENT_GRANTS[reason]
          if (!rule || rule.resource !== resource) throw new ApiError(403, 'Resources are earned, not granted')
          if (delta > rule.perCall) throw new ApiError(403, 'Grant exceeds the ambient cap')
          const granted = await tx.balanceLedger.sumSince(
            principal.playerId,
            `ambient:${reason}`,
            resource,
            new Date(now.getTime() - 60 * 60_000)
          )
          if (granted + delta > rule.perHour) {
            throw new NoCommitResponse({ applied: false, ...this.balances(state.village) })
          }
        }
        const current = resource === 'gold' ? Math.floor(state.village.gold) : state.village[resource]
        if (delta < 0 && current + delta < 0) {
          throw new NoCommitResponse({ applied: false, ...this.balances(state.village) })
        }
        const beforeApplied = state.village[resource]
        if (resource === 'gold') state.village.gold = clamp(state.village.gold + delta, 0, MAX_PLAYER_GOLD)
        else {
          const capacity = resourceCapacity(villageBuildings(state.village))
          state.village[resource] = clamp(state.village[resource] + delta, 0, capacity[resource])
          if (state.village[resource] >= capacity[resource]) state.village.productionRemainders[resource] = 0
        }
        state.village.lastMutationAt = now
        const expected = state.village.economyRevision
        await this.authority.updateVillage(tx, state.village, expected)
        const response = { applied: true, ...this.balances(state.village) }
        const actualDelta = state.village[resource] - beforeApplied
        await this.completeRequest(tx, principal, 'resources.apply', id, response)
        const auditId = id || randomId('resource')
        await tx.balanceLedger.append({
          playerId: principal.playerId,
          operation: delta > 0 && AMBIENT_GRANTS[reason] ? `ambient:${reason}` : `resources:${reason || 'client'}`,
          requestId: auditId,
          currency: resource,
          delta: actualDelta,
          balanceAfter: state.village[resource],
          metadata: { reason, requestedDelta: delta },
          createdAt: now
        })
        return response
      })
    } catch (error) {
      if (error instanceof NoCommitResponse) return error.response
      throw error
    }
  }

  async trainTroop(principal: RuntimePrincipal, body: ArmyMutationRequest) {
    const type = sanitizeId(body.type) as TroopType
    const definition = TROOP_DEFINITIONS[type]
    if (!definition || type === 'romanwarrior') throw new ApiError(404, 'Unknown troop type')
    const count = clamp(toInteger(body.count, 1), 1, 50)
    const id = requestId(body.requestId)
    const now = this.clock()
    return this.persistence.transaction(async tx => {
      const claim = await this.claimRequest(tx, principal, 'army.train', id, now)
      if (claim.replayed) return claim.response
      const state = await this.authority.owned(tx, principal.playerId, true)
      if (await this.authority.hasActiveOutgoing(tx, principal.playerId)) throw new ApiError(409, 'Army is reserved for an active attack')
      if (await this.authority.hasActiveIncoming(tx, principal.playerId)) throw new ApiError(409, 'Village is locked while an incoming raid is live', 'BASE_UNDER_ATTACK')
      await this.authority.materializeWithAudit(tx, state.village, now)
      const buildings = villageBuildings(state.village)
      const army = villageArmy(state.village)
      if (maxBarracksLevel(buildings) < getTroopUnlockLevel(type)) {
        throw new ApiError(403, `${definition.name} needs a level ${getTroopUnlockLevel(type)} barracks`)
      }
      if (armySpaceUsed(army) + definition.space * count > campCapacityOf(buildings)) {
        throw new ApiError(409, 'Not enough housing space in the camps')
      }
      const goldCost = definition.cost * count
      const foodCost = troopFoodCostOf(type) * count
      if (Math.floor(state.village.gold) < goldCost) throw new ApiError(409, `Not enough gold (need ${goldCost})`)
      if (state.village.food < foodCost) throw new ApiError(409, `Not enough food (need ${foodCost})`)
      state.village.gold -= goldCost
      state.village.food -= foodCost
      army[type] = (army[type] ?? 0) + count
      state.village.army = army as unknown as JsonObject
      state.village.lastMutationAt = now
      const expected = state.village.economyRevision
      await this.authority.updateVillage(tx, state.village, expected)
      const response = { army: { ...army }, ...this.balances(state.village) }
      await this.completeRequest(tx, principal, 'army.train', id, response)
      const auditId = id || randomId('train')
      await tx.balanceLedger.append({
        playerId: principal.playerId, operation: 'army.train', requestId: auditId,
        currency: 'gold', delta: -goldCost, balanceAfter: response.gold,
        metadata: { troopType: type, count }, createdAt: now
      })
      await tx.balanceLedger.append({
        playerId: principal.playerId, operation: 'army.train', requestId: auditId,
        currency: 'food', delta: -foodCost, balanceAfter: response.food,
        metadata: { troopType: type, count }, createdAt: now
      })
      return response
    })
  }

  async untrainTroop(principal: RuntimePrincipal, body: ArmyMutationRequest) {
    const type = sanitizeId(body.type) as TroopType
    const definition = TROOP_DEFINITIONS[type]
    if (!definition) throw new ApiError(404, 'Unknown troop type')
    const count = clamp(toInteger(body.count, 1), 1, 50)
    const id = requestId(body.requestId)
    const now = this.clock()
    return this.persistence.transaction(async tx => {
      const claim = await this.claimRequest(tx, principal, 'army.untrain', id, now)
      if (claim.replayed) return claim.response
      const state = await this.authority.owned(tx, principal.playerId, true)
      if (await this.authority.hasActiveOutgoing(tx, principal.playerId)) throw new ApiError(409, 'Army is reserved for an active attack')
      const army = villageArmy(state.village)
      if ((army[type] ?? 0) < count) throw new ApiError(409, 'Not that many troops in camp')
      await this.authority.materializeWithAudit(
        tx,
        state.village,
        now,
        await this.authority.hasActiveIncoming(tx, principal.playerId)
      )
      const beforeRefund = { gold: state.village.gold, food: state.village.food }
      if ((army[type] ?? 0) === count) delete army[type]
      else army[type] -= count
      state.village.gold = clamp(state.village.gold + definition.cost * count, 0, MAX_PLAYER_GOLD)
      const capacity = resourceCapacity(villageBuildings(state.village))
      state.village.food = clamp(state.village.food + troopFoodCostOf(type) * count, 0, capacity.food)
      if (state.village.food >= capacity.food) state.village.productionRemainders.food = 0
      state.village.army = army as unknown as JsonObject
      state.village.lastMutationAt = now
      const expected = state.village.economyRevision
      await this.authority.updateVillage(tx, state.village, expected)
      const response = { army: { ...army }, ...this.balances(state.village) }
      await this.completeRequest(tx, principal, 'army.untrain', id, response)
      const auditId = id || randomId('untrain')
      await tx.balanceLedger.append({
        playerId: principal.playerId, operation: 'army.untrain', requestId: auditId,
        currency: 'gold', delta: state.village.gold - beforeRefund.gold, balanceAfter: state.village.gold,
        metadata: { troopType: type, count, requestedRefund: definition.cost * count }, createdAt: now
      })
      await tx.balanceLedger.append({
        playerId: principal.playerId, operation: 'army.untrain', requestId: auditId,
        currency: 'food', delta: state.village.food - beforeRefund.food, balanceAfter: state.village.food,
        metadata: { troopType: type, count, requestedRefund: troopFoodCostOf(type) * count }, createdAt: now
      })
      return response
    })
  }

  async merchantTrade(principal: RuntimePrincipal, body: MerchantTradeRequest) {
    const now = this.clock()
    const day = worldDayIndex(now.getTime())
    const offer = merchantOffersFor(principal.playerId, day).find(candidate => candidate.id === toInteger(body.offerId, -1))
    if (!offer) throw new ApiError(404, 'The merchant has no such deal today')
    const id = requestId(body.requestId)
    try {
      return await this.persistence.transaction(async tx => {
        const claim = await this.claimRequest(tx, principal, 'merchant.trade', id, now)
        if (claim.replayed) return claim.response
        const state = await this.authority.owned(tx, principal.playerId, true)
        if (await this.authority.hasActiveIncoming(tx, principal.playerId)) {
          throw new ApiError(409, 'Village resources are locked while an incoming raid is live', 'BASE_UNDER_ATTACK')
        }
        const marker = `${day}:${offer.id}`
        if (await tx.operationMarkers.has(principal.playerId, 'merchant', marker)) {
          throw new ApiError(409, 'That deal is done for today')
        }
        await this.authority.materializeWithAudit(tx, state.village, now)
        const have = offer.give.kind === 'gold' ? Math.floor(state.village.gold) : state.village[offer.give.kind]
        if (have < offer.give.amount) {
          throw new NoCommitResponse({ applied: false, offerId: offer.id, ...this.balances(state.village) })
        }
        const beforeTrade = {
          gold: state.village.gold,
          ore: state.village.ore,
          food: state.village.food
        }
        const capacity = resourceCapacity(villageBuildings(state.village))
        const apply = (kind: 'gold' | 'ore' | 'food', delta: number) => {
          if (kind === 'gold') state.village.gold = clamp(state.village.gold + delta, 0, MAX_PLAYER_GOLD)
          else state.village[kind] = clamp(state.village[kind] + delta, 0, capacity[kind])
        }
        apply(offer.give.kind, -offer.give.amount)
        apply(offer.get.kind, offer.get.amount)
        state.village.lastMutationAt = now
        const expected = state.village.economyRevision
        await this.authority.updateVillage(tx, state.village, expected)
        await tx.operationMarkers.add(principal.playerId, 'merchant', marker, now)
        const response = { applied: true, offerId: offer.id, ...this.balances(state.village) }
        await this.completeRequest(tx, principal, 'merchant.trade', id, response)
        const auditId = id || randomId('merchant')
        await tx.balanceLedger.append({
          playerId: principal.playerId, operation: 'merchant.trade', requestId: auditId,
          currency: offer.give.kind,
          delta: state.village[offer.give.kind] - beforeTrade[offer.give.kind],
          balanceAfter: state.village[offer.give.kind],
          metadata: { offerId: offer.id, requestedDelta: -offer.give.amount }, createdAt: now
        })
        await tx.balanceLedger.append({
          playerId: principal.playerId, operation: 'merchant.trade', requestId: auditId,
          currency: offer.get.kind,
          delta: state.village[offer.get.kind] - beforeTrade[offer.get.kind],
          balanceAfter: state.village[offer.get.kind],
          metadata: { offerId: offer.id, requestedDelta: offer.get.amount }, createdAt: now
        })
        return response
      })
    } catch (error) {
      if (error instanceof NoCommitResponse) return error.response
      throw error
    }
  }

  async scout(principal: RuntimePrincipal, rawTargetId: unknown) {
    const targetId = sanitizeId(rawTargetId)
    const now = this.clock()
    return this.persistence.transaction(async tx => {
      const viewer = await this.authority.owned(tx, principal.playerId)
      const target = await this.authority.owned(tx, targetId, true)
      const sight = watchtowerSightOf(villageBuildings(viewer.village))
      if (targetId !== principal.playerId
        && chebyshev(viewer.plot.x, viewer.plot.y, target.plot.x, target.plot.y) > sight) {
        throw new ApiError(403, 'That village is beyond your watchtower sight')
      }
      await this.authority.materializeOwned(
        tx,
        target.village,
        now,
        await this.authority.hasActiveIncoming(tx, targetId)
      )
      return publicWorldOf(target.account, target.village)
    })
  }

  async map(
    principal: RuntimePrincipal,
    rawX?: unknown,
    rawY?: unknown,
    rawRadius?: unknown,
    rawKnown?: unknown
  ) {
    const now = this.clock()
    const viewer = await this.persistence.transaction(async tx => {
      const state = await this.authority.owned(tx, principal.playerId, true)
      await this.authority.materializeOwned(
        tx,
        state.village,
        now,
        await this.authority.hasActiveIncoming(tx, principal.playerId)
      )
      return state
    })
    const cx = worldCoordinate(rawX, viewer.plot.x)
    const cy = worldCoordinate(rawY, viewer.plot.y)
    const sight = watchtowerSightOf(villageBuildings(viewer.village))
    const centerDistance = chebyshev(cx, cy, viewer.plot.x, viewer.plot.y)
    const attackAuthorized = centerDistance > 0
      && Boolean(await this.attacks.authorizeMapFocus?.(principal, cx, cy))
    if (centerDistance > sight && !attackAuthorized) {
      throw new ApiError(403, 'That map center is beyond your watchtower sight')
    }
    const radiusBudget = attackAuthorized
      ? Math.max(1, sight)
      : centerDistance === 0 ? sight : Math.max(0, sight - centerDistance)
    const radius = Math.min(clamp(toInteger(rawRadius, 1), 0, 2), radiusBudget)
    const minX = Math.max(-MAX_WORLD_COORDINATE, cx - radius)
    const maxX = Math.min(MAX_WORLD_COORDINATE, cx + radius)
    const minY = Math.max(-MAX_WORLD_COORDINATE, cy - radius)
    const maxY = Math.min(MAX_WORLD_COORDINATE, cy + radius)
    const known = knownRevisions(rawKnown)

    return this.persistence.transaction(async tx => {
      const entries = await tx.world.listAtlas({
        worldId: viewer.plot.worldId,
        minX, maxX, minY, maxY, now, limit: 25
      })
      const byCoordinate = new Map(entries.map(entry => [`${entry.plot.x},${entry.plot.y}`, entry]))
      const activeByDefender = new Map<string, string>()
      const playerIds = entries.map(entry => entry.player.playerId)
      for (const attack of await this.authority.leasedIncomingForPlayers(tx, playerIds)) {
        if (attack.defenderId && ACTIVE_INCOMING_STATES.has(attack.state)) {
          activeByDefender.set(attack.defenderId, attack.id)
        }
      }
      const plots: Array<Record<string, unknown>> = []
      for (let y = minY; y <= maxY; y += 1) {
        for (let x = minX; x <= maxX; x += 1) {
          const entry = byCoordinate.get(`${x},${y}`)
          if (entry) {
            const account = accountForSummary(entry)
            const village = villageForPostcard(entry)
            materializeVillage(village, now, { populationLocked: activeByDefender.has(account.id) })
            const attackId = activeByDefender.get(account.id)
            const withinSight = chebyshev(x, y, viewer.plot.x, viewer.plot.y) <= sight
            const plot: Record<string, unknown> = {
              x, y, kind: 'player', ownerId: account.id, username: account.username,
              trophies: account.trophies, revision: village.appearanceRevision,
              underAttack: Boolean(attackId),
              ...(withinSight && attackId ? { attackId } : {}),
              shielded: (account.shieldUntil?.getTime() ?? 0) > now.getTime(),
              stoneMaturity: stoneMaturityOf(account, now)
            }
            const cached = known.get(`${x},${y}`)
            if (!cached || cached.ownerId !== account.id || cached.revision !== village.appearanceRevision) {
              plot.world = publicWorldOf(account, village)
            }
            plots.push(plot)
            continue
          }
          const seed = botSeedAt(x, y)
          plots.push(seed === null
            ? { x, y, kind: 'empty', settleable: !isWildernessPreserveAt(x, y) }
            : { x, y, kind: 'bot', seed, username: botNameFor(seed), trophies: 100 + seed % 900 })
        }
      }
      return {
        plots,
        me: { x: viewer.plot.x, y: viewer.plot.y, shieldUntil: viewer.account.shieldUntil?.getTime() ?? 0 },
        serverNow: now.getTime()
      }
    })
  }

  async atlas(principal: RuntimePrincipal) {
    const now = this.clock()
    return this.persistence.transaction(async tx => {
      const viewer = await this.authority.owned(tx, principal.playerId)
      const minX = Math.max(-MAX_WORLD_COORDINATE, viewer.plot.x - ATLAS_RADIUS)
      const maxX = Math.min(MAX_WORLD_COORDINATE, viewer.plot.x + ATLAS_RADIUS)
      const minY = Math.max(-MAX_WORLD_COORDINATE, viewer.plot.y - ATLAS_RADIUS)
      const maxY = Math.min(MAX_WORLD_COORDINATE, viewer.plot.y + ATLAS_RADIUS)
      const entries = await tx.world.listPlayers({
        worldId: viewer.plot.worldId,
        minX, maxX, minY, maxY, now, limit: ATLAS_LIMIT
      })
      const activeByDefender = new Map<string, Awaited<ReturnType<UnitOfWork['attacks']['listLeasedIncomingForDefenders']>>[number]>()
      for (const attack of await this.authority.leasedIncomingForPlayers(tx, entries.map(entry => entry.player.playerId))) {
        if (attack.defenderId && ACTIVE_INCOMING_STATES.has(attack.state)) {
          activeByDefender.set(attack.defenderId, attack)
        }
      }
      const coordinates = new Map(entries.map(entry => [entry.player.playerId, entry.plot]))
      const battles = []
      for (const attack of activeByDefender.values()) {
        const attacker = coordinates.get(attack.attackerId)
        const defender = attack.defenderId ? coordinates.get(attack.defenderId) : undefined
        if (attacker && defender) battles.push({ ax: attacker.x, ay: attacker.y, vx: defender.x, vy: defender.y })
      }
      return {
        me: { x: viewer.plot.x, y: viewer.plot.y },
        players: entries.map(entry => ({
          x: entry.plot.x,
          y: entry.plot.y,
          username: entry.player.username,
          trophies: entry.player.trophies,
          shielded: (entry.player.shieldUntil?.getTime() ?? 0) > now.getTime(),
          underAttack: activeByDefender.has(entry.player.playerId),
          me: entry.player.playerId === principal.playerId,
          online: entry.player.playerId === principal.playerId
            || now.getTime() - entry.player.lastSeenAt.getTime() < ONLINE_WINDOW_MS
        })),
        battles,
        window: { minX, maxX, minY, maxY },
        truncated: entries.length >= ATLAS_LIMIT
      }
    })
  }

  async leaderboard(principal: RuntimePrincipal) {
    const now = this.clock()
    return this.persistence.transaction(async tx => {
      const viewer = await this.authority.owned(tx, principal.playerId)
      const sight = watchtowerSightOf(villageBuildings(viewer.village))
      const rows = await tx.accounts.listLeaderboardDetails({ limit: 100, now })
      return rows.map(row => ({
        id: row.playerId,
        username: row.username,
        trophies: row.trophies,
        buildingCount: row.buildingCount,
        lastSeen: row.lastSeenAt.getTime(),
        online: row.playerId === principal.playerId || now.getTime() - row.lastSeenAt.getTime() < ONLINE_WINDOW_MS,
        plotX: row.x,
        plotY: row.y,
        inScoutRange: row.playerId === principal.playerId
          || chebyshev(viewer.plot.x, viewer.plot.y, row.x, row.y) <= sight
      }))
    })
  }

  async relocate(principal: RuntimePrincipal, rawX: unknown, rawY: unknown) {
    const now = this.clock()
    return this.persistence.transaction(async tx => {
      const state = await this.authority.owned(tx, principal.playerId, true)
      if (await this.authority.hasActiveOutgoing(tx, principal.playerId)) throw new ApiError(409, 'Cannot relocate during an active attack')
      if (await this.authority.hasActiveIncoming(tx, principal.playerId)) throw new ApiError(409, 'Cannot relocate while your village is under attack')
      let coordinate: { x: number; y: number } | null = null
      if (rawX !== undefined || rawY !== undefined) {
        const x = worldCoordinate(rawX, Number.NaN)
        const y = worldCoordinate(rawY, Number.NaN)
        if (!Number.isFinite(x) || !Number.isFinite(y)) throw new ApiError(400, 'Bad plot coordinates')
        if (Math.abs(x) > HOME_COORD_LIMIT || Math.abs(y) > HOME_COORD_LIMIT) {
          throw new ApiError(400, 'Village plots must leave room for the full watchtower horizon')
        }
        if (x === state.plot.x && y === state.plot.y) throw new ApiError(400, 'You already live there')
        if (chebyshev(x, y, state.plot.x, state.plot.y) > watchtowerSightOf(villageBuildings(state.village))) {
          throw new ApiError(403, 'That relocation plot is beyond your watchtower sight')
        }
        const eligibility = classifyPlot({ x, y }, CURRENT_WORLD_GENERATION_VERSION)
        if (eligibility.kind === 'PRESERVE') throw new ApiError(409, 'That wilderness is permanently protected')
        if (eligibility.kind === 'BOT') throw new ApiError(409, 'A bot camp already occupies that plot')
        coordinate = { x, y }
      }
      const old = state.plot
      await releasePlayerPlotClaim(tx, old, now)
      const plot = coordinate
        ? await claimSpecificPlayerPlot(tx, {
            playerId: state.account.id,
            registered: state.account.registered,
            coordinate,
            now
          })
        : await allocatePlayerPlot(tx, {
            playerId: state.account.id,
            registered: state.account.registered,
            now,
            exclude: [{ x: old.x, y: old.y }]
          })
      await this.authority.touchPresence(tx, state.account, now)
      return { me: { x: plot.x, y: plot.y, plotVersion: plot.plotVersion }, serverNow: now.getTime() }
    })
  }

  async listNotifications(principal: RuntimePrincipal) {
    return this.persistence.transaction(async tx => {
      const items = await tx.notifications.listForPlayer({ playerId: principal.playerId, limit: 50 })
      return items.map(item => ({
        ...item.payload,
        id: item.id,
        time: item.occurredAt.getTime(),
        read: item.readAt !== null
      }))
    }, { isolation: 'read committed' })
  }

  async getUnread(principal: RuntimePrincipal): Promise<number> {
    return this.persistence.transaction(async tx => (
      await tx.notifications.listForPlayer({ playerId: principal.playerId, unreadOnly: true, limit: 100 })
    ).length, { isolation: 'read committed' })
  }

  async markNotificationsRead(principal: RuntimePrincipal): Promise<void> {
    const now = this.clock()
    await this.persistence.transaction(async tx => {
      await tx.notifications.markAllRead(principal.playerId, now)
    })
  }

  async debugClearShields() {
    if (!this.allowDebugGrants) throw new ApiError(403, 'Debug tools are disabled')
    const now = this.clock()
    return this.persistence.transaction(async tx => {
      const cleared = await tx.accounts.clearShields(now, 1_000)
      return { cleared, truncated: cleared === 1_000 }
    })
  }

  async economyLedger(rawDays?: unknown) {
    if (!this.allowDebugGrants) throw new ApiError(403, 'Debug tools are disabled')
    const days = clamp(toInteger(rawDays, 7), 1, 30)
    const today = worldDayIndex(this.clock().getTime())
    return this.persistence.transaction(async tx => {
      const summaries = await tx.balanceLedger.summarizeDays(today - days + 1, today)
      const output = Array.from({ length: days }, (_, offset) => ({
        day: today - offset,
        faucets: { gold: 0, ore: 0, food: 0 },
        sinks: { gold: 0, ore: 0, food: 0 },
        refunds: { gold: 0, ore: 0, food: 0 },
        loot: { gold: 0, ore: 0, food: 0 },
        counts: { saves: 0, trades: 0, battles: 0, botRaids: 0 }
      }))
      const byDay = new Map(output.map(day => [day.day, day]))
      const counts = new Map<string, number>()
      for (const row of summaries) {
        const day = byDay.get(row.day)
        if (!day || row.currency === 'trophies') continue
        const currency = row.currency
        if (row.operation === 'attack-settlement' || row.operation === 'bot-attack-settlement') {
          day.loot[currency] += row.positive
        } else if (row.operation === 'army.untrain') {
          day.refunds[currency] += row.positive
          day.sinks[currency] += row.negative
        } else {
          day.faucets[currency] += row.positive
          day.sinks[currency] += row.negative
        }
        counts.set(`${row.day}\u0000${row.operation}`, Math.max(
          counts.get(`${row.day}\u0000${row.operation}`) ?? 0,
          row.operationCount
        ))
      }
      for (const [key, count] of counts) {
        const [rawDay, operation] = key.split('\u0000')
        const day = byDay.get(Number(rawDay))
        if (!day) continue
        if (operation === 'world.save') day.counts.saves = count
        if (operation === 'merchant.trade') day.counts.trades = count
        if (operation === 'attack-settlement') day.counts.battles = count
        if (operation === 'bot-attack-settlement') day.counts.botRaids = count
      }
      return { today, days: output }
    }, { isolation: 'read committed' })
  }

  botSettle(player: RuntimePrincipal, body: BotSettleRequest) {
    return this.attacks.botSettle(player, body)
  }

  botStart(player: RuntimePrincipal, body: BotStartRequest, rawToken?: unknown) {
    return this.attacks.botStart(player, body, rawToken)
  }

  activeOutgoingBattle(player: RuntimePrincipal, rawToken: unknown) {
    return this.attacks.activeOutgoingBattle(player, rawToken)
  }

  abortActiveOutgoingBattle(player: RuntimePrincipal) {
    return this.attacks.abortActiveOutgoingBattle(player)
  }

  startAttack(player: RuntimePrincipal, body: AttackStartRequest, matchmade = false, rawToken?: unknown) {
    return this.attacks.startAttack(player, body, matchmade, rawToken)
  }

  matchmake(player: RuntimePrincipal, body: { requestId?: unknown } = {}, rawToken?: unknown) {
    return this.attacks.matchmake(player, body, rawToken)
  }

  pushFrames(player: RuntimePrincipal, body: AttackFrameRequest) {
    return this.attacks.pushFrames(player, body)
  }

  pushCommands(player: RuntimePrincipal, body: AttackCommandRequest) {
    return this.attacks.pushCommands(player, body)
  }

  endAttack(player: RuntimePrincipal, body: AttackEndRequest) {
    return this.attacks.endAttack(player, body)
  }

  incomingAttacks(player: RuntimePrincipal) {
    return this.attacks.incomingAttacks(player)
  }

  getReplay(player: RuntimePrincipal, attackId: unknown, afterT?: unknown) {
    return this.attacks.getReplay(player, attackId, afterT)
  }
}
