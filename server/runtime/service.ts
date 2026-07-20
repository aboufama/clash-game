import {
  TROOP_DEFINITIONS,
  isTrainableTroopType,
  troopTrainingRequirement,
  troopFoodCostOf,
  type TroopType
} from '../../src/game/config/GameDefinitions'
import {
  armySpaceUsed,
  campCapacityOf,
  isWildernessPreserveAt,
  barracksLevelForTroop,
  maxCompletedArmyCampLevel,
  merchantOffersFor,
  resourceCapacity,
  watchtowerSightOf,
  worldDayIndex
} from '../../src/game/config/Economy'
import {
  VILLAGE_BANNER_EMBLEMS,
  VILLAGE_BANNER_PALETTES,
  VILLAGE_BANNER_PATTERNS,
  type SerializedWorld,
  type VillageBanner
} from '../../src/game/data/Models'
import {
  VILLAGE_SIMULATION_VERSION,
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
  WORLD_PLOT_RADIUS,
  botFrontierRadiusForCursor,
  classifyPlot,
  settledFrontierBotVillageSeedAt
} from '../domain/world'
import { ApiError, bannerRequiredError } from '../errors'
import { isValidUsername, normalizeUsernameKey } from '../domain/auth'
import type {
  AdminApiService,
  AdminAttackSummary,
  AdminAuditEntry,
  AdminBaseResetSummary,
  AdminBotSummary,
  AdminConfig,
  AdminEconomy,
  AdminMutationResult,
  AdminOperationRequest,
  AdminOverview,
  AdminPlayerActionRequest,
  AdminPlayerDetail,
  AdminPlayerSummary,
  AdminVillageSnapshot
} from '../admin-contract'
import type {
  AccountRecord,
  AdminPlayerRecord,
  JsonObject,
  JsonValue,
  Persistence,
  UnitOfWork,
  VillageRecord,
  WorldAtlasEntry
} from '../persistence'
import { AdminBaseResetPreconditionError, outboxEvent, QUERY_LIMITS } from '../persistence'
import { AuthSessionService, createStarterVillageRecord } from './auth-service'
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
  MatchmakeRequest,
  ResourceMutationRequest,
  RuntimeAttackService,
  RuntimePrincipal,
  SaveWorldRequest
} from './contracts'
import { randomId } from './ids'
import {
  MAX_PLAYER_GOLD,
  hasUnsupportedVillageArmy,
  hasUnsupportedVillageBuildings,
  materializeVillage,
  publicWorldOf,
  serializedWorldOf,
  stoneMaturityOf,
  villageArmy,
  villageBuildings,
  villageObstacles,
  villagePopulation,
  type AdvertisedUpgradePolicy
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
import { ensurePersistedBotVillage, publicBotWorldOf } from './bot-villages'
import { assertGameplayMutationAllowed } from './maintenance-fence'

const ONLINE_WINDOW_MS = 60_000
const DEFAULT_STARTER_SHIELD_MS = 2 * 60 * 60_000
const ADMIN_RESET_CONFIRMATION = 'RESET ALL BASES'
const IDEMPOTENCY_TTL_MS = 24 * 60 * 60_000
const OUTBOX_PUBLISHED_RETENTION_MS = 24 * 60 * 60_000
const OUTBOX_DELIVERY_WINDOW_MS = 7 * 24 * 60 * 60_000
const OPERATION_MARKER_RETENTION_MS = 2 * 24 * 60 * 60_000
// One main server for now: the atlas lists literally everyone, capped at the
// server's intended player capacity. Multi-server paging can come later.
const ATLAS_LIMIT = 1000
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
  infiniteResources?: boolean
  upgradeTimeScale?: number
  fixedUpgradeDurationMs?: number
  /**
   * Whether tokenless /auth/session mints a playable guest. Defaults to the
   * shared CLASH_ALLOW_GUESTS env rule — production keeps the registration
   * wall; `npm run dev` (and the art harnesses behind it) opt guests in.
   */
  allowGuestSessions?: boolean
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

/** Apply storage rules, preserving existing overflow only in debug mode. */
function storedResourceAfterDelta(
  current: number,
  delta: number,
  capacity: number,
  allowOverflow = false,
  preserveOverflow = false
): number {
  const stored = clamp(toInteger(current, 0), 0, MAX_PLAYER_GOLD)
  if (allowOverflow) return clamp(stored + delta, 0, MAX_PLAYER_GOLD)
  if (!preserveOverflow) return clamp(stored + delta, 0, capacity)
  if (delta <= 0) return Math.max(0, stored + delta)
  if (stored >= capacity) return stored
  return Math.min(capacity, stored + delta)
}

function sanitizeId(value: unknown): string {
  return String(value ?? '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 96)
}

function requestId(value: unknown): string {
  return typeof value === 'string' ? value.trim().slice(0, 160) : ''
}

/** Banner mutations never accept implicit/default axes or numeric coercion. */
function explicitVillageBanner(raw: unknown): VillageBanner | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const candidate = raw as { palette?: unknown; emblem?: unknown; pattern?: unknown }
  if (!Number.isInteger(candidate.palette)
    || (candidate.palette as number) < 0
    || (candidate.palette as number) >= VILLAGE_BANNER_PALETTES
    || !Number.isInteger(candidate.emblem)
    || (candidate.emblem as number) < 0
    || (candidate.emblem as number) >= VILLAGE_BANNER_EMBLEMS
    || !Number.isInteger(candidate.pattern)
    || (candidate.pattern as number) < 0
    || (candidate.pattern as number) >= VILLAGE_BANNER_PATTERNS) return null
  return {
    palette: candidate.palette as number,
    emblem: candidate.emblem as number,
    pattern: candidate.pattern as number
  }
}

function sameBanner(left: VillageBanner | null, right: VillageBanner): boolean {
  return left !== null
    && left.palette === right.palette
    && left.emblem === right.emblem
    && left.pattern === right.pattern
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
    banner: entry.village.banner ? { ...entry.village.banner } : null,
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

function adminPlayerSummaryOf(row: AdminPlayerRecord, now: Date): AdminPlayerSummary {
  return {
    id: row.id,
    username: row.username,
    registered: row.registered,
    trophies: row.trophies,
    shieldUntil: row.shieldUntil?.getTime() ?? null,
    createdAt: row.createdAt.getTime(),
    lastSeenAt: row.lastSeenAt.getTime(),
    online: row.lastSeenAt.getTime() >= now.getTime() - ONLINE_WINDOW_MS,
    access: row.accessState,
    accessUntil: row.accessUntil?.getTime() ?? null,
    world: row.worldId !== null && row.x !== null && row.y !== null && row.plotVersion !== null
      ? { worldId: row.worldId, x: row.x, y: row.y, plotVersion: row.plotVersion }
      : null
  }
}

function adminVillageSnapshotOf(
  account: AccountRecord,
  village: VillageRecord,
  now: Date
): AdminVillageSnapshot {
  return {
    ...publicWorldOf(account, village),
    stoneMaturity: stoneMaturityOf(account, now)
  }
}

function adminPlayerDetailOf(
  row: AdminPlayerRecord,
  now: Date,
  village: AdminVillageSnapshot | null
): AdminPlayerDetail {
  const summary = adminPlayerSummaryOf(row, now)
  const army: Record<string, number> = {}
  for (const [type, count] of Object.entries(row.army)) {
    if (typeof count === 'number' && Number.isFinite(count)) army[type] = count
  }
  const population = typeof row.population.count === 'number'
    ? Math.max(0, Math.floor(row.population.count))
    : 0
  return {
    ...summary,
    resources: { gold: row.gold, ore: row.ore, food: row.food },
    revisions: {
      profile: row.profileRevision,
      economy: row.economyRevision,
      layout: row.layoutRevision,
      appearance: row.appearanceRevision
    },
    buildingCount: row.buildings,
    obstacleCount: row.obstacles,
    army,
    population,
    activeSessions: row.activeSessions,
    activeAttacks: row.activeAttacks,
    moderationReason: row.accessReason,
    moderationUpdatedAt: row.moderationUpdatedAt?.getTime() ?? null,
    village
  }
}

/** Transactional application service over normalized persistence. */
export class PersistenceGameService implements ApiService<RuntimePrincipal>, AdminApiService {
  private readonly persistence: Persistence
  private readonly attacks: RuntimeAttackService
  private readonly clock: () => Date
  private readonly starterShieldMs: number
  private readonly allowDebugGrants: boolean
  private readonly infiniteResources: boolean
  private readonly upgradeTimeScale: number
  private readonly fixedUpgradeDurationMs?: number
  private readonly upgradePolicy: AdvertisedUpgradePolicy
  private readonly authority: VillageAuthority
  private readonly auth: AuthSessionService

  constructor(persistence: Persistence, options: RuntimeOptions = {}) {
    this.persistence = persistence
    this.attacks = options.attacks ?? NO_ATTACKS
    this.clock = options.now ?? (() => new Date())
    this.starterShieldMs = options.starterShieldMs ?? DEFAULT_STARTER_SHIELD_MS
    this.allowDebugGrants = options.allowDebugGrants ?? process.env.CLASH_ALLOW_DEBUG_GRANTS === '1'
    this.infiniteResources = options.infiniteResources ?? process.env.CLASH_INFINITE_RESOURCES === '1'
    const configuredScale = options.upgradeTimeScale ?? Number(process.env.CLASH_UPGRADE_TIME_SCALE ?? 1)
    this.upgradeTimeScale = Number.isFinite(configuredScale) && configuredScale >= 0 ? configuredScale : 1
    const envDuration = process.env.CLASH_UPGRADE_DURATION_MS?.trim()
    const configuredDuration = options.fixedUpgradeDurationMs
      ?? (envDuration ? Number(envDuration) : undefined)
    this.fixedUpgradeDurationMs = typeof configuredDuration === 'number'
      && Number.isFinite(configuredDuration) && configuredDuration >= 0
      ? Math.round(configuredDuration)
      : undefined
    // Advertised on every owned world payload so client-displayed durations
    // always derive from the clock THIS server will actually bill.
    this.upgradePolicy = {
      ...(this.fixedUpgradeDurationMs !== undefined ? { fixedDurationMs: this.fixedUpgradeDurationMs } : {}),
      timeScale: this.upgradeTimeScale
    }
    this.authority = new VillageAuthority(this.allowDebugGrants)
    this.auth = new AuthSessionService(persistence, this.authority, {
      clock: this.clock,
      starterShieldMs: this.starterShieldMs,
      sessionTtlMs: options.sessionTtlMs,
      infiniteResources: this.infiniteResources,
      upgradePolicy: this.upgradePolicy,
      allowGuestSessions: options.allowGuestSessions
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
    rawToken: unknown,
    rawUsername: unknown,
    rawPassword: unknown,
    rawAddress?: unknown
  ) {
    return this.auth.register(rawToken, rawUsername, rawPassword, rawAddress)
  }

  async login(rawUsername: unknown, rawPassword: unknown, rawAddress?: unknown) {
    return this.auth.login(rawUsername, rawPassword, rawAddress)
  }

  async logout(rawToken: unknown): Promise<void> {
    return this.auth.logout(rawToken)
  }

  /**
   * This principal was issued only after authentication, so it represents a
   * persisted player account. Generated wilderness/bot identities are map
   * projections, never RuntimePrincipals, and intentionally bypass onboarding.
   */
  async assertGameplayReady(principal: RuntimePrincipal): Promise<void> {
    await this.persistence.transaction(async tx => {
      const village = await tx.villages.get(principal.playerId)
      if (!village) throw new ApiError(401, 'Player authority is incomplete')
      if (!explicitVillageBanner(village.banner)) throw bannerRequiredError()
    })
  }

  async rename(principal: RuntimePrincipal, rawName: unknown) {
    return this.auth.rename(principal, rawName)
  }

  async setBanner(principal: RuntimePrincipal, rawBanner: unknown) {
    const banner = explicitVillageBanner(rawBanner)
    if (!banner) {
      throw new ApiError(
        400,
        'Invalid banner: palette 0-7, emblem 0-5, and pattern 0-4 are all required',
        'INVALID_BANNER'
      )
    }
    const now = this.clock()
    return this.persistence.transaction(async tx => {
      await assertGameplayMutationAllowed(tx)
      const state = await this.authority.owned(tx, principal.playerId, true)
      if (sameBanner(state.village.banner, banner)) return { banner: { ...banner } }
      const expectedAppearanceRevision = state.village.appearanceRevision
      state.village.banner = { ...banner }
      state.village.appearanceRevision = expectedAppearanceRevision + 1
      state.village.lastMutationAt = now
      if (!await tx.villages.updateAppearance(state.village, expectedAppearanceRevision)) {
        throw new ApiError(409, 'Village appearance changed; reload and retry', 'APPEARANCE_REVISION_CONFLICT')
      }
      await tx.outbox.add(outboxEvent({
        topic: 'villages',
        aggregateType: 'village',
        aggregateId: principal.playerId,
        eventType: 'VILLAGE_BANNER_CHANGED',
        now,
        payload: {
          appearanceRevision: state.village.appearanceRevision,
          banner: { palette: banner.palette, emblem: banner.emblem, pattern: banner.pattern }
        }
      }))
      return { banner: { ...banner } }
    })
  }

  async getWorld(principal: RuntimePrincipal): Promise<SerializedWorld> {
    const now = this.clock()
    return this.persistence.transaction(async tx => {
      await assertGameplayMutationAllowed(tx)
      const state = await this.authority.owned(tx, principal.playerId, true)
      await this.authority.materializeOwned(
        tx,
        state.village,
        now,
        await this.authority.hasActiveIncoming(tx, principal.playerId)
      )
      return serializedWorldOf(state.account, state.village, now, { stoneMaturity: true, upgradePolicy: this.upgradePolicy })
    })
  }

  async saveWorld(principal: RuntimePrincipal, body: SaveWorldRequest): Promise<SerializedWorld> {
    const world = body.world
    if (!world || typeof world !== 'object') throw new ApiError(400, 'Missing world payload')
    const id = requestId(body.requestId)
    const now = this.clock()
    return this.persistence.transaction(async tx => {
      await assertGameplayMutationAllowed(tx)
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
        materializeVillage(current, now, { preserveOverCapacity: this.allowDebugGrants })
        throw new ApiError(409, `Stale world revision (expected ${state.village.economyRevision})`, 'STALE_REVISION', {
          currentRevision: state.village.economyRevision,
          world: serializedWorldOf(state.account, current, now, { upgradePolicy: this.upgradePolicy })
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
          upgradeTimeScale: this.upgradeTimeScale,
          fixedUpgradeDurationMs: this.fixedUpgradeDurationMs
        }))
        if (!this.infiniteResources && pricing.bill.gold > 0 && Math.floor(state.village.gold) < pricing.bill.gold) {
          throw new ApiError(409, `Not enough gold for these changes (need ${pricing.bill.gold})`, 'INSUFFICIENT_RESOURCES', { resource: 'gold' })
        }
        if (!this.infiniteResources && pricing.bill.ore > 0 && state.village.ore < pricing.bill.ore) {
          throw new ApiError(409, `Not enough ore for these changes (need ${pricing.bill.ore})`, 'INSUFFICIENT_RESOURCES', { resource: 'ore' })
        }
        if (!this.infiniteResources) {
          state.village.gold = clamp(state.village.gold - pricing.bill.gold, 0, MAX_PLAYER_GOLD)
        }
        state.village.buildings = pricing.buildings as unknown as JsonValue[]
        state.village.obstacles = proposal.obstacles as unknown as JsonValue[]
        state.village.wallLevel = proposal.wallLevel
        const capacity = resourceCapacity(pricing.buildings)
        if (!this.infiniteResources) {
          state.village.ore = storedResourceAfterDelta(
            state.village.ore, -pricing.bill.ore, capacity.ore, false, this.allowDebugGrants
          )
          state.village.food = storedResourceAfterDelta(
            state.village.food, 0, capacity.food, false, this.allowDebugGrants
          )
        }
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
        const response = serializedWorldOf(state.account, state.village, now, { upgradePolicy: this.upgradePolicy })
        await this.completeRequest(tx, principal, 'world.save', id, response)
        return response
      }
      await this.authority.updateVillage(tx, state.village, expectedRevision)
      const response = serializedWorldOf(state.account, state.village, now, { upgradePolicy: this.upgradePolicy })
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
        await assertGameplayMutationAllowed(tx)
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
        const isDebugGrant = delta > 0 && reason === 'debug_grant' && this.allowDebugGrants
        if (delta > 0 && !isDebugGrant) {
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
        const infiniteSpend = delta < 0 && this.infiniteResources
        const current = resource === 'gold' ? Math.floor(state.village.gold) : state.village[resource]
        if (!infiniteSpend && delta < 0 && current + delta < 0) {
          throw new NoCommitResponse({ applied: false, ...this.balances(state.village) })
        }
        const beforeApplied = state.village[resource]
        if (!infiniteSpend) {
          if (resource === 'gold') state.village.gold = clamp(state.village.gold + delta, 0, MAX_PLAYER_GOLD)
          else {
            const capacity = resourceCapacity(villageBuildings(state.village))
            state.village[resource] = storedResourceAfterDelta(
              state.village[resource], delta, capacity[resource], isDebugGrant, this.allowDebugGrants
            )
            if (state.village[resource] >= capacity[resource]) state.village.productionRemainders[resource] = 0
          }
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
    if (!definition || !isTrainableTroopType(type)) throw new ApiError(404, 'Unknown troop type')
    const count = clamp(toInteger(body.count, 1), 1, 50)
    const id = requestId(body.requestId)
    const now = this.clock()
    return this.persistence.transaction(async tx => {
      await assertGameplayMutationAllowed(tx)
      const claim = await this.claimRequest(tx, principal, 'army.train', id, now)
      if (claim.replayed) return claim.response
      const state = await this.authority.owned(tx, principal.playerId, true)
      if (await this.authority.hasActiveOutgoing(tx, principal.playerId)) throw new ApiError(409, 'Army is reserved for an active attack')
      if (await this.authority.hasActiveIncoming(tx, principal.playerId)) throw new ApiError(409, 'Village is locked while an incoming raid is live', 'BASE_UNDER_ATTACK')
      await this.authority.materializeWithAudit(tx, state.village, now)
      const buildings = villageBuildings(state.village)
      const army = villageArmy(state.village)
      const trainingRequirement = troopTrainingRequirement(type)
      if (!trainingRequirement) throw new ApiError(404, 'Unknown troop type')
      if (trainingRequirement.kind === 'core') {
        if (maxCompletedArmyCampLevel(buildings) < trainingRequirement.unlockLevel) {
          throw new ApiError(403, `${definition.name} needs a level ${trainingRequirement.unlockLevel} ${trainingRequirement.campName}`)
        }
      } else if (barracksLevelForTroop(buildings, type) < trainingRequirement.unlockLevel) {
        throw new ApiError(403, `${definition.name} needs a level ${trainingRequirement.unlockLevel} ${trainingRequirement.barracksName}`)
      }
      if (armySpaceUsed(army) + definition.space * count > campCapacityOf(buildings)) {
        throw new ApiError(409, 'Not enough housing space in the camps')
      }
      const goldCost = definition.cost * count
      const foodCost = troopFoodCostOf(type) * count
      if (!this.infiniteResources && Math.floor(state.village.gold) < goldCost) throw new ApiError(409, `Not enough gold (need ${goldCost})`)
      if (!this.infiniteResources && state.village.food < foodCost) throw new ApiError(409, `Not enough food (need ${foodCost})`)
      const beforeTraining = { gold: state.village.gold, food: state.village.food }
      if (!this.infiniteResources) {
        state.village.gold -= goldCost
        state.village.food -= foodCost
      }
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
        currency: 'gold', delta: state.village.gold - beforeTraining.gold, balanceAfter: response.gold,
        metadata: { troopType: type, count }, createdAt: now
      })
      await tx.balanceLedger.append({
        playerId: principal.playerId, operation: 'army.train', requestId: auditId,
        currency: 'food', delta: state.village.food - beforeTraining.food, balanceAfter: response.food,
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
      await assertGameplayMutationAllowed(tx)
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
      if (!this.infiniteResources) {
        state.village.gold = clamp(state.village.gold + definition.cost * count, 0, MAX_PLAYER_GOLD)
        const capacity = resourceCapacity(villageBuildings(state.village))
        state.village.food = storedResourceAfterDelta(
          state.village.food, troopFoodCostOf(type) * count, capacity.food, false, this.allowDebugGrants
        )
        if (state.village.food >= capacity.food) state.village.productionRemainders.food = 0
      }
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
        await assertGameplayMutationAllowed(tx)
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
        if (!this.infiniteResources && have < offer.give.amount) {
          throw new NoCommitResponse({ applied: false, offerId: offer.id, ...this.balances(state.village) })
        }
        const beforeTrade = {
          gold: state.village.gold,
          ore: state.village.ore,
          food: state.village.food
        }
        if (!this.infiniteResources) {
          const capacity = resourceCapacity(villageBuildings(state.village))
          const apply = (kind: 'gold' | 'ore' | 'food', delta: number) => {
            if (kind === 'gold') state.village.gold = clamp(state.village.gold + delta, 0, MAX_PLAYER_GOLD)
            else state.village[kind] = storedResourceAfterDelta(
              state.village[kind], delta, capacity[kind], false, this.allowDebugGrants
            )
          }
          apply(offer.give.kind, -offer.give.amount)
          apply(offer.get.kind, offer.get.amount)
        }
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
      await assertGameplayMutationAllowed(tx)
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
      await assertGameplayMutationAllowed(tx)
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
      await assertGameplayMutationAllowed(tx)
      // Unclaimed spiral plots inside the settled frontier present as bot
      // camps until a real account claims them; the radius follows the
      // world's admission cursor so the neighbourhood always looks alive.
      const allocation = await tx.world.getAllocation(viewer.plot.worldId)
      const frontierRadius = botFrontierRadiusForCursor(allocation?.nextOrdinal ?? 0)
      const entries = await tx.world.listAtlas({
        worldId: viewer.plot.worldId,
        minX, maxX, minY, maxY, now, limit: 25
      })
      const byCoordinate = new Map(entries.map(entry => [`${entry.plot.x},${entry.plot.y}`, entry]))
      // listAtlas deliberately omits expired guest leases, while their claim
      // row remains authoritative until the bounded reaper releases it. Do
      // one exact, bounded preflight so such a hidden claim is neither
      // presented as a bot nor allowed to collide with first provisioning.
      const missingCoordinates: Array<{ x: number; y: number }> = []
      for (let y = minY; y <= maxY; y += 1) {
        for (let x = minX; x <= maxX; x += 1) {
          if (!byCoordinate.has(`${x},${y}`)) missingCoordinates.push({ x, y })
        }
      }
      const hiddenClaims = new Set(
        (await tx.world.listOccupantsAt(viewer.plot.worldId, missingCoordinates))
          .map(plot => `${plot.x},${plot.y}`)
      )
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
            materializeVillage(village, now, {
              populationLocked: activeByDefender.has(account.id),
              preserveOverCapacity: this.allowDebugGrants
            })
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
          if (hiddenClaims.has(`${x},${y}`)) {
            plots.push({ x, y, kind: 'empty', settleable: false })
            continue
          }
          const seed = settledFrontierBotVillageSeedAt({ x, y }, { frontierRadius })
          if (seed === null) {
            plots.push({ x, y, kind: 'empty', settleable: !isWildernessPreserveAt(x, y) })
            continue
          }
          const bot = await ensurePersistedBotVillage(tx, {
            worldId: viewer.plot.worldId,
            worldGenerationVersion: CURRENT_WORLD_GENERATION_VERSION,
            revisionEpoch: allocation?.botRevisionEpoch ?? 1,
            x,
            y,
            seed,
            now
          })
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
          const cached = known.get(`${x},${y}`)
          if (!cached || cached.ownerId !== bot.id || cached.revision !== bot.revision) {
            plot.world = publicBotWorldOf(bot)
          }
          plots.push(plot)
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
      // The watchtower's own default-sight radius (0-2 plots) — the atlas
      // marks this ring so a chief can see it against the wider chart window.
      const sight = watchtowerSightOf(villageBuildings(viewer.village))
      // The WORLD atlas lists literally everyone on the (single, for now)
      // server — query the full coordinate space, capped at the server's
      // intended 1,000-player capacity.
      const entries = await tx.world.listPlayersGlobal({
        worldId: viewer.plot.worldId,
        centerX: viewer.plot.x,
        centerY: viewer.plot.y,
        now,
        limit: ATLAS_LIMIT
      })
      // The chart frame: the ±WORLD_PLOT_RADIUS world square, grown to
      // include any legacy outlier plot so nobody charts off-map.
      let minX = -WORLD_PLOT_RADIUS
      let maxX = WORLD_PLOT_RADIUS
      let minY = -WORLD_PLOT_RADIUS
      let maxY = WORLD_PLOT_RADIUS
      for (const entry of entries) {
        minX = Math.min(minX, entry.plot.x)
        maxX = Math.max(maxX, entry.plot.x)
        minY = Math.min(minY, entry.plot.y)
        maxY = Math.max(maxY, entry.plot.y)
      }
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
        sight,
        worldPlotLimit: WORLD_PLOT_RADIUS,
        players: entries.map(entry => ({
          x: entry.plot.x,
          y: entry.plot.y,
          username: entry.player.username,
          trophies: entry.player.trophies,
          banner: entry.banner ? { ...entry.banner } : null,
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
      await assertGameplayMutationAllowed(tx)
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
        // Spiral settlement: an unclaimed bot camp is claimable land — the
        // claim replaces the camp. Only preserves/water refuse a village.
        const eligibility = classifyPlot({ x, y }, CURRENT_WORLD_GENERATION_VERSION)
        if (eligibility.kind === 'PRESERVE') throw new ApiError(409, 'That wilderness is permanently protected')
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
      await assertGameplayMutationAllowed(tx)
      await tx.notifications.markAllRead(principal.playerId, now)
    })
  }

  private async appendAdminAudit(
    tx: UnitOfWork,
    input: {
      id: string
      action: string
      targetId: string | null
      details: JsonObject
      now: Date
    }
  ): Promise<void> {
    await tx.admin.appendAudit({
      id: input.id,
      actor: 'admin',
      action: input.action,
      targetType: input.targetId === null ? 'system' : 'player',
      targetId: input.targetId,
      details: input.details,
      occurredAt: input.now
    })
  }

  async adminOverview(): Promise<AdminOverview> {
    const now = this.clock()
    return this.persistence.transaction(async tx => {
      const overview = await tx.admin.overview(now, new Date(now.getTime() - ONLINE_WINDOW_MS))
      const config = await tx.admin.getConfig()
      return {
        generatedAt: now.getTime(),
        players: {
          total: overview.players,
          registered: overview.registeredPlayers,
          guests: overview.players - overview.registeredPlayers,
          online: overview.onlinePlayers
        },
        villages: {
          playerVillages: overview.playerVillages,
          botVillages: overview.botVillages
        },
        attacks: {
          active: overview.preparingAttacks + overview.engagedAttacks
            + overview.activeAttacks + overview.finalizingAttacks,
          preparing: overview.preparingAttacks,
          engaged: overview.engagedAttacks + overview.activeAttacks,
          finalizing: overview.finalizingAttacks
        },
        economy: {
          gold: overview.totalGold,
          ore: overview.totalOre,
          food: overview.totalFood,
          averageTrophies: overview.averageTrophies
        },
        moderation: {
          suspended: overview.suspendedPlayers,
          banned: overview.bannedPlayers
        },
        maintenance: config.maintenanceEnabled
      }
    }, { isolation: 'read committed' })
  }

  async adminPlayers(rawSearch?: unknown, rawLimit?: unknown): Promise<AdminPlayerSummary[]> {
    const search = rawSearch === undefined || rawSearch === null ? '' : String(rawSearch).trim()
    if (search.length > 64) throw new ApiError(400, 'Player search may not exceed 64 characters', 'ADMIN_INVALID_INPUT')
    const limit = rawLimit === undefined
      ? 50
      : adminInteger(rawLimit, 'limit', 1, QUERY_LIMITS.adminPlayers)
    const now = this.clock()
    return this.persistence.transaction(async tx => (
      await tx.admin.listPlayers({
        search,
        limit,
        now,
        onlineSince: new Date(now.getTime() - ONLINE_WINDOW_MS)
      })
    ).map(row => adminPlayerSummaryOf(row, now)), { isolation: 'read committed' })
  }

  async adminPlayer(rawId: unknown): Promise<AdminPlayerDetail> {
    const id = adminRequiredText(rawId, 'player id', 96)
    if (sanitizeId(id) !== id) throw new ApiError(400, 'Player id is invalid', 'ADMIN_INVALID_INPUT')
    const now = this.clock()
    return this.persistence.transaction(async tx => {
      const player = await tx.admin.getPlayer(id, now)
      if (!player) throw new ApiError(404, 'Player not found', 'ADMIN_PLAYER_NOT_FOUND')
      // Fetch the authority rows inside this same read transaction so the
      // public postcard cannot be paired with a different account revision.
      // Only publicWorldOf crosses the transport boundary; hashes, sessions,
      // private economy state and other account internals remain server-only.
      const account = await tx.accounts.getById(id)
      const village = account ? await tx.villages.get(id) : null
      const previewVillage = village ? cloneJson(village) : null
      if (account && previewVillage && (
        previewVillage.simulatedThrough.getTime() < now.getTime()
        || previewVillage.simulationVersion !== VILLAGE_SIMULATION_VERSION
        || hasUnsupportedVillageBuildings(previewVillage)
        || hasUnsupportedVillageArmy(previewVillage)
      )) {
        materializeVillage(previewVillage, now, {
          populationLocked: await this.authority.hasActiveIncoming(tx, id),
          preserveOverCapacity: this.allowDebugGrants
        })
      }
      return adminPlayerDetailOf(
        player,
        now,
        account && previewVillage ? adminVillageSnapshotOf(account, previewVillage, now) : null
      )
    }, { isolation: 'repeatable read' })
  }

  async adminBots(
    rawCenter: { worldId?: unknown; x?: unknown; y?: unknown } = {},
    rawRadius?: unknown,
    rawLimit?: unknown
  ): Promise<AdminBotSummary[]> {
    const worldId = rawCenter.worldId === undefined
      ? 'main'
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
      : adminInteger(rawRadius, 'radius', 0, QUERY_LIMITS.adminBotRadius)
    const limit = rawLimit === undefined
      ? 100
      : adminInteger(rawLimit, 'limit', 1, QUERY_LIMITS.adminBots)
    const now = this.clock()
    return this.persistence.transaction(async tx => {
      const bots = await tx.world.listBotVillages({
        worldId,
        minX: x - radius,
        maxX: x + radius,
        minY: y - radius,
        maxY: y + radius,
        now,
        limit
      })
      return bots.map((bot): AdminBotSummary => ({
        id: bot.id,
        username: bot.username,
        worldId: bot.worldId,
        x: bot.x,
        y: bot.y,
        plotVersion: bot.plotVersion,
        generatorVersion: bot.generatorVersion,
        seed: bot.seed,
        difficulty: typeof bot.profile.difficulty === 'string' ? bot.profile.difficulty : null,
        trophies: bot.trophies,
        revision: bot.revision,
        resources: {
          gold: Number(bot.world.resources.gold ?? 0),
          ore: Number(bot.world.resources.ore ?? 0),
          food: Number(bot.world.resources.food ?? 0)
        },
        buildingCount: bot.world.buildings.length,
        createdAt: bot.createdAt.getTime(),
        updatedAt: bot.updatedAt.getTime()
      }))
    }, { isolation: 'read committed' })
  }

  async adminAttacks(rawState?: unknown, rawLimit?: unknown): Promise<AdminAttackSummary[]> {
    const state = rawState === undefined || rawState === null || rawState === ''
      ? null
      : String(rawState)
    if (state !== null && ![
      'preparing', 'engaged', 'active', 'finalizing', 'settled', 'cancelled', 'expired'
    ].includes(state)) throw new ApiError(400, 'Unknown attack state', 'ADMIN_INVALID_INPUT')
    const limit = rawLimit === undefined
      ? 100
      : adminInteger(rawLimit, 'limit', 1, QUERY_LIMITS.adminAttacks)
    return this.persistence.transaction(async tx => (
      await tx.admin.listAttacks({ state: state as Parameters<typeof tx.admin.listAttacks>[0]['state'], limit })
    ).map((attack): AdminAttackSummary => ({
      id: attack.id,
      attackerId: attack.attackerId,
      defenderId: attack.defenderId,
      targetKind: attack.targetKind,
      targetId: attack.targetId,
      worldId: attack.worldId,
      targetX: attack.targetX,
      targetY: attack.targetY,
      state: attack.state,
      stateVersion: attack.stateVersion,
      simulationVersion: attack.simulationVersion,
      createdAt: attack.createdAt.getTime(),
      engagedAt: attack.engagedAt?.getTime() ?? null,
      updatedAt: attack.updatedAt.getTime(),
      deadlineAt: attack.deadlineAt.getTime(),
      endedAt: attack.endedAt?.getTime() ?? null
    })), { isolation: 'read committed' })
  }

  async adminAudit(rawLimit?: unknown): Promise<AdminAuditEntry[]> {
    const limit = rawLimit === undefined
      ? 100
      : adminInteger(rawLimit, 'limit', 1, QUERY_LIMITS.adminAudit)
    return this.persistence.transaction(async tx => (
      await tx.admin.listAudit(limit)
    ).map((entry): AdminAuditEntry => ({
      id: entry.id,
      actor: entry.actor,
      action: entry.action,
      targetType: entry.targetType,
      targetId: entry.targetId,
      reason: typeof entry.details.reason === 'string' ? entry.details.reason : '',
      outcome: 'success',
      requestId: entry.id,
      details: entry.details as Record<string, unknown>,
      createdAt: entry.occurredAt.getTime(),
      occurredAt: entry.occurredAt.getTime()
    })), { isolation: 'read committed' })
  }

  async adminConfig(): Promise<AdminConfig> {
    return this.persistence.transaction(async tx => {
      const config = await tx.admin.getConfig()
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
          playerList: QUERY_LIMITS.adminPlayers,
          botList: QUERY_LIMITS.adminBots,
          attackList: QUERY_LIMITS.adminAttacks,
          auditList: QUERY_LIMITS.adminAudit,
          botRadius: QUERY_LIMITS.adminBotRadius
        },
        updatedAt: config.updatedAt.getTime(),
        revision: config.revision
      }
    }, { isolation: 'read committed' })
  }

  async adminPlayerAction(rawId: unknown, rawAction: AdminPlayerActionRequest): Promise<AdminMutationResult> {
    const id = adminRequiredText(rawId, 'player id', 96)
    if (sanitizeId(id) !== id) throw new ApiError(400, 'Player id is invalid', 'ADMIN_INVALID_INPUT')
    if (!rawAction || typeof rawAction !== 'object') {
      throw new ApiError(400, 'Admin action is required', 'ADMIN_INVALID_INPUT')
    }
    const action = rawAction as AdminPlayerActionRequest
    const type = String(action.type ?? '')
    const now = this.clock()
    const auditId = randomId('admin_audit', 10)
    const reason = adminReason(action.reason)

    return this.persistence.transaction(async tx => {
      const account = await tx.accounts.getById(id, { forUpdate: true })
      if (!account) throw new ApiError(404, 'Player not found', 'ADMIN_PLAYER_NOT_FOUND')
      let changed = false
      let affected = 0
      let details: JsonObject = { reason }

      if (type === 'adjust_resources') {
        const input = action as Extract<AdminPlayerActionRequest, { type: 'adjust_resources' }>
        const deltas = {
          gold: input.gold === undefined ? 0 : adminInteger(input.gold, 'gold delta', -1_000_000_000, 1_000_000_000),
          ore: input.ore === undefined ? 0 : adminInteger(input.ore, 'ore delta', -1_000_000_000, 1_000_000_000),
          food: input.food === undefined ? 0 : adminInteger(input.food, 'food delta', -1_000_000_000, 1_000_000_000)
        }
        const village = await tx.villages.get(id, { forUpdate: true })
        if (!village) throw new ApiError(409, 'Player village is missing', 'ADMIN_VILLAGE_MISSING')
        const before = { gold: village.gold, ore: village.ore, food: village.food }
        const after = {
          gold: clamp(before.gold + deltas.gold, 0, MAX_PLAYER_GOLD),
          ore: clamp(before.ore + deltas.ore, 0, MAX_PLAYER_GOLD),
          food: clamp(before.food + deltas.food, 0, MAX_PLAYER_GOLD)
        }
        changed = before.gold !== after.gold || before.ore !== after.ore || before.food !== after.food
        if (changed) {
          const revision = village.economyRevision
          village.gold = after.gold
          village.ore = after.ore
          village.food = after.food
          village.lastMutationAt = now
          village.economyRevision += 1
          if (!await tx.villages.update(village, revision)) throw new ApiError(409, 'Village changed concurrently')
          for (const resource of ['gold', 'ore', 'food'] as const) {
            const delta = after[resource] - before[resource]
            if (delta === 0) continue
            affected += 1
            await tx.balanceLedger.append({
              playerId: id,
              operation: 'admin.adjust_resources',
              requestId: auditId,
              currency: resource,
              delta,
              balanceAfter: after[resource],
              metadata: { actor: 'admin', reason },
              createdAt: now
            })
          }
        }
        details = { reason, deltas, before, after }
      } else if (type === 'set_trophies') {
        const input = action as Extract<AdminPlayerActionRequest, { type: 'set_trophies' }>
        const trophies = adminInteger(input.trophies, 'trophies', 0, 2_147_483_647)
        const before = account.trophies
        changed = before !== trophies
        if (changed) {
          const revision = account.revision
          account.trophies = trophies
          account.revision += 1
          if (!await tx.accounts.update(account, revision)) throw new ApiError(409, 'Player changed concurrently')
          await tx.balanceLedger.append({
            playerId: id,
            operation: 'admin.set_trophies',
            requestId: auditId,
            currency: 'trophies',
            delta: trophies - before,
            balanceAfter: trophies,
            metadata: { actor: 'admin', reason },
            createdAt: now
          })
          affected = 1
        }
        details = { reason, before, after: trophies }
      } else if (type === 'set_shield') {
        const input = action as Extract<AdminPlayerActionRequest, { type: 'set_shield' }>
        let until: Date | null = null
        if (input.until !== undefined && input.until !== null) {
          const timestamp = adminInteger(
            input.until,
            'shield expiry',
            now.getTime(),
            now.getTime() + 365 * 24 * 60 * 60_000
          )
          until = new Date(timestamp)
        }
        const before = account.shieldUntil?.getTime() ?? null
        const after = until?.getTime() ?? null
        changed = before !== after
        if (changed) {
          const revision = account.revision
          account.shieldUntil = until
          account.revision += 1
          if (!await tx.accounts.update(account, revision)) throw new ApiError(409, 'Player changed concurrently')
          affected = 1
        }
        details = { reason, before, after }
      } else if (type === 'rename') {
        const input = action as Extract<AdminPlayerActionRequest, { type: 'rename' }>
        const username = adminRequiredText(input.username, 'username', 18)
        if (!isValidUsername(username)) throw new ApiError(400, 'Username must be 3-18 letters, numbers, _ or -')
        const usernameKey = normalizeUsernameKey(username)
        if (await tx.admin.isUsernameTaken(usernameKey, id)) {
          throw new ApiError(409, 'That username is already taken', 'USERNAME_TAKEN')
        }
        const before = account.username
        changed = before !== username
        if (changed) {
          const revision = account.revision
          account.username = username
          if (account.registered) account.usernameKey = usernameKey
          account.revision += 1
          if (!await tx.accounts.update(account, revision)) throw new ApiError(409, 'Player changed concurrently')
          affected = 1
        }
        details = { reason, before, after: username }
      } else if (type === 'revoke_sessions') {
        affected = await tx.sessions.deleteForPlayer(id)
        changed = affected > 0
        details = { reason, revoked: affected }
      } else if (type === 'set_access') {
        const input = action as Extract<AdminPlayerActionRequest, { type: 'set_access' }>
        const state = String(input.state ?? '')
        if (!['active', 'suspended', 'banned'].includes(state)) {
          throw new ApiError(400, 'Access state must be active, suspended, or banned', 'ADMIN_INVALID_INPUT')
        }
        let until: Date | null = null
        if (state === 'suspended' && input.until !== undefined && input.until !== null) {
          until = new Date(adminInteger(
            input.until,
            'suspension expiry',
            now.getTime() + 1,
            now.getTime() + 10 * 365 * 24 * 60 * 60_000
          ))
        } else if (state !== 'suspended' && input.until !== undefined && input.until !== null) {
          throw new ApiError(400, 'Only suspensions may have an expiry', 'ADMIN_INVALID_INPUT')
        }
        const current = await tx.admin.getModeration(id, { forUpdate: true })
        changed = !current || current.state !== state || current.reason !== (state === 'active' ? null : reason)
          || current.until?.getTime() !== until?.getTime()
        if (changed) {
          const expectedRevision = current?.revision ?? null
          const updated = await tx.admin.upsertModeration({
            playerId: id,
            state: state as 'active' | 'suspended' | 'banned',
            reason: state === 'active' ? null : reason,
            until,
            updatedAt: now,
            revision: (expectedRevision ?? 0) + 1
          }, expectedRevision)
          if (!updated) throw new ApiError(409, 'Moderation state changed concurrently')
          affected = 1
        }
        let revoked = 0
        if (state !== 'active') {
          revoked = await tx.sessions.deleteForPlayer(id)
          if (revoked > 0) changed = true
          affected += revoked
        }
        details = {
          reason,
          before: current?.state ?? 'active',
          after: state,
          until: until?.getTime() ?? null,
          sessionsRevoked: revoked
        }
      } else if (type === 'send_notice') {
        const input = action as Extract<AdminPlayerActionRequest, { type: 'send_notice' }>
        const title = adminRequiredText(input.title, 'notice title', 80)
        const message = adminRequiredText(input.message, 'notice message', 500)
        const severity = String(input.severity ?? 'info')
        if (!['info', 'warning', 'critical'].includes(severity)) {
          throw new ApiError(400, 'Notice severity must be info, warning, or critical', 'ADMIN_INVALID_INPUT')
        }
        await tx.notifications.add({
          playerId: id,
          id: randomId('notice', 10),
          eventType: 'admin_notice',
          payload: {
            kind: 'admin_notice',
            title,
            message,
            severity
          },
          occurredAt: now,
          readAt: null
        })
        changed = true
        affected = 1
        details = { reason, title, severity }
      } else {
        throw new ApiError(400, 'Unknown admin player action', 'ADMIN_INVALID_INPUT')
      }

      await this.appendAdminAudit(tx, { id: auditId, action: type, targetId: id, details, now })
      return { ok: true, action: type, targetId: id, changed, affected, auditId }
    }, { isolation: 'serializable', maxRetries: 3 })
  }

  async adminOperation(rawAction: AdminOperationRequest): Promise<AdminMutationResult> {
    if (!rawAction || typeof rawAction !== 'object') {
      throw new ApiError(400, 'Admin operation is required', 'ADMIN_INVALID_INPUT')
    }
    const type = String(rawAction.type ?? '')
    const reason = adminReason(rawAction.reason)
    const now = this.clock()
    const auditId = randomId('admin_audit', 10)
    return this.persistence.transaction(async tx => {
      let changed = false
      let affected = 0
      let details: JsonObject = { reason }
      let resetSummary: AdminBaseResetSummary | undefined
      if (type === 'clear_shields') {
        affected = await tx.accounts.clearShields(now, 1_000)
        changed = affected > 0
        details = { reason, cleared: affected, truncated: affected === 1_000 }
      } else if (type === 'set_maintenance') {
        const input = rawAction as Extract<AdminOperationRequest, { type: 'set_maintenance' }>
        if (typeof input.enabled !== 'boolean') {
          throw new ApiError(400, 'Maintenance enabled must be a boolean', 'ADMIN_INVALID_INPUT')
        }
        const message = adminOptionalText(input.message, 'maintenance message', 500)
        const current = await tx.admin.getConfig({ forUpdate: true })
        changed = current.maintenanceEnabled !== input.enabled
          || current.maintenanceMessage !== (input.enabled ? message : null)
        if (changed) {
          const updated = await tx.admin.updateConfig({
            maintenanceEnabled: input.enabled,
            maintenanceMessage: input.enabled ? message : null,
            updatedAt: now,
            revision: current.revision + 1
          }, current.revision)
          if (!updated) throw new ApiError(409, 'Admin config changed concurrently')
          affected = 1
        }
        details = {
          reason,
          before: current.maintenanceEnabled,
          after: input.enabled,
          message: input.enabled ? message : null
        }
      } else if (type === 'reset_all_bases') {
        const input = rawAction as Extract<AdminOperationRequest, { type: 'reset_all_bases' }>
        if (reason.length < 12) {
          throw new ApiError(400, 'Base reset reason must contain at least 12 characters', 'ADMIN_INVALID_INPUT')
        }
        if (input.confirmation !== ADMIN_RESET_CONFIRMATION) {
          throw new ApiError(
            400,
            `Type ${ADMIN_RESET_CONFIRMATION} to confirm the full base reset`,
            'ADMIN_RESET_CONFIRMATION_REQUIRED'
          )
        }
        const config = await tx.admin.getConfig({ forUpdate: true })
        if (!config.maintenanceEnabled) {
          throw new ApiError(
            409,
            'Enable maintenance mode before resetting all bases',
            'ADMIN_MAINTENANCE_REQUIRED'
          )
        }
        const starter = createStarterVillageRecord(auditId, now)
        try {
          resetSummary = await tx.admin.resetAllBases(
            starter,
            new Date(now.getTime() + this.starterShieldMs)
          )
        } catch (error) {
          if (!(error instanceof AdminBaseResetPreconditionError)) throw error
          throw new ApiError(
            409,
            'Cannot reset while base authority or bot revision epochs are incomplete',
            'ADMIN_RESET_INTEGRITY_FAILED',
            {
              incompleteAccounts: error.incompleteAccounts,
              orphanBotWorlds: error.orphanBotWorlds
            }
          )
        }
        affected = resetSummary.playerVillagesReset + resetSummary.botVillagesPurged
        changed = affected > 0
          || resetSummary.combatRecordsPurged > 0
          || resetSummary.notificationsPurged > 0
          || resetSummary.economyRecordsPurged > 0
          || resetSummary.auxiliaryRecordsPurged > 0
        details = { reason, confirmation: 'verified', ...resetSummary }
      } else {
        throw new ApiError(400, 'Unknown admin operation', 'ADMIN_INVALID_INPUT')
      }
      await this.appendAdminAudit(tx, { id: auditId, action: type, targetId: null, details, now })
      return {
        ok: true,
        action: type,
        targetId: null,
        changed,
        affected,
        auditId,
        ...(resetSummary ? { resetSummary } : {})
      }
    }, { isolation: 'serializable', maxRetries: 3 })
  }

  async debugClearShields() {
    if (!this.allowDebugGrants) throw new ApiError(403, 'Debug tools are disabled')
    const now = this.clock()
    return this.persistence.transaction(async tx => {
      await assertGameplayMutationAllowed(tx)
      const cleared = await tx.accounts.clearShields(now, 1_000)
      return { cleared, truncated: cleared === 1_000 }
    })
  }

  async economyLedger(rawDays?: unknown) {
    if (!this.allowDebugGrants) throw new ApiError(403, 'Debug tools are disabled')
    return this.adminEconomy(rawDays)
  }

  async adminEconomy(rawDays?: unknown): Promise<AdminEconomy> {
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

  matchmake(player: RuntimePrincipal, body: MatchmakeRequest = {}, rawToken?: unknown) {
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
