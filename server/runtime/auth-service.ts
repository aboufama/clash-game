import { randomBytes } from 'node:crypto'
import type { SerializedBuilding } from '../../src/game/data/Models'
import {
  InMemoryAuthRateLimiter,
  createOpaqueSessionToken,
  hashPasswordAsync,
  hashSessionToken,
  isValidUsername,
  normalizeSessionToken,
  normalizeUsernameKey,
  validateRegistrationCredentials,
  verifyPasswordAsync
} from '../domain/auth'
import { STARTING_POPULATION, VILLAGE_SIMULATION_VERSION } from '../domain/village'
import { DEFAULT_GUEST_PLOT_TTL_MS } from '../domain/world'
import { ApiError } from '../errors'
import type {
  AccountRecord,
  JsonValue,
  Persistence,
  SessionRecord,
  UnitOfWork,
  VillageRecord
} from '../persistence'
import { outboxEvent, postgresErrorCode } from '../persistence'
import type { SessionResponse } from '../protocol'
import type { RuntimePrincipal } from './contracts'
import { randomId } from './ids'
import { profileOf, serializedWorldOf, type AdvertisedUpgradePolicy } from './village-state'
import { VillageAuthority, type OwnedState } from './village-authority'
import {
  allocatePlayerPlot,
  releaseExpiredGuestPlotClaims,
  releasePlayerPlotClaim
} from './world-authority'

const STARTING_GOLD = 1_000
const STARTING_ORE = 25
const STARTING_FOOD = 50
const DEFAULT_STARTER_SHIELD_MS = 2 * 60 * 60_000
const DEFAULT_SESSION_TTL_MS = 30 * 24 * 60 * 60_000
const SESSION_TOUCH_INTERVAL_MS = 30_000
const MAX_SESSIONS_PER_PLAYER = 8

export interface AuthSessionOptions {
  clock: () => Date
  starterShieldMs?: number
  sessionTtlMs?: number
  infiniteResources?: boolean
  /** Effective upgrade clock advertised on session world payloads. */
  upgradePolicy?: AdvertisedUpgradePolicy
}

function starterBuildings(): SerializedBuilding[] {
  return [
    { id: randomId('b', 6), type: 'town_hall', gridX: 11, gridY: 11, level: 1 },
    { id: randomId('b', 6), type: 'cannon', gridX: 8, gridY: 11, level: 1 },
    { id: randomId('b', 6), type: 'barracks', gridX: 15, gridY: 11, level: 1 },
    { id: randomId('b', 6), type: 'army_camp', gridX: 11, gridY: 15, level: 1 }
  ]
}

function starterVillage(playerId: string, now: Date): VillageRecord {
  return {
    playerId,
    buildings: starterBuildings() as unknown as JsonValue[],
    obstacles: [],
    army: {},
    wallLevel: 1,
    gold: STARTING_GOLD,
    ore: STARTING_ORE,
    food: STARTING_FOOD,
    productionRemainders: { ore: 0, food: 0 },
    population: { count: STARTING_POPULATION, lastGrowthAt: now.getTime(), bornAt: [] },
    simulatedThrough: now,
    lastMutationAt: now,
    layoutRevision: 1,
    appearanceRevision: 1,
    economyRevision: 1,
    simulationVersion: VILLAGE_SIMULATION_VERSION,
    nextEventAt: null
  }
}

/** Account, credential, device-session, and guest-lease use cases. */
export class AuthSessionService {
  private readonly persistence: Persistence
  private readonly authority: VillageAuthority
  private readonly clock: () => Date
  private readonly starterShieldMs: number
  private readonly sessionTtlMs: number
  private readonly infiniteResources: boolean
  private readonly upgradePolicy?: AdvertisedUpgradePolicy
  private readonly limiter: InMemoryAuthRateLimiter

  constructor(persistence: Persistence, authority: VillageAuthority, options: AuthSessionOptions) {
    this.persistence = persistence
    this.authority = authority
    this.clock = options.clock
    this.starterShieldMs = options.starterShieldMs ?? DEFAULT_STARTER_SHIELD_MS
    this.sessionTtlMs = options.sessionTtlMs ?? DEFAULT_SESSION_TTL_MS
    this.infiniteResources = options.infiniteResources ?? false
    this.upgradePolicy = options.upgradePolicy
    this.limiter = new InMemoryAuthRateLimiter({
      loginMaximumFailures: 8,
      loginLockoutMs: 60_000,
      loginAddressWindowMs: 60_000,
      loginAddressAttemptLimit: 30,
      guestCreationWindowMs: 60 * 60_000,
      guestCreationLimit: 30
    })
  }

  async sweepExpiredGuestLeases(limit = 50): Promise<{ released: number; archived: number }> {
    const now = this.clock()
    return this.persistence.transaction(async tx => {
      const releasedIds = (await releaseExpiredGuestPlotClaims(tx, now, limit))
        .map(plot => plot.playerId)
      const archived = await tx.accounts.deleteUnreferencedGuests(releasedIds)
      return { released: releasedIds.length, archived }
    })
  }

  private async usernameMutation<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work()
    } catch (error) {
      const constraint = error && typeof error === 'object' && 'constraint' in error
        ? String(error.constraint)
        : ''
      if ((postgresErrorCode(error) === '23505' && (!constraint || /username/i.test(constraint)))
        || (error instanceof Error && /username.*(exists|taken)|username_key/i.test(error.message))) {
        throw new ApiError(409, 'That username is already taken', 'USERNAME_TAKEN')
      }
      throw error
    }
  }

  private async touchSession(
    tx: UnitOfWork,
    session: { tokenHash: string; lastUsedAt: Date },
    now: Date
  ): Promise<void> {
    if (now.getTime() - session.lastUsedAt.getTime() < SESSION_TOUCH_INTERVAL_MS) return
    if (await tx.sessions.touch(session.tokenHash, now)) session.lastUsedAt = now
  }

  private async sessionResponse(
    tx: UnitOfWork,
    state: OwnedState,
    token: string,
    created: boolean,
    now: Date
  ): Promise<SessionResponse> {
    await this.authority.materializeOwned(
      tx,
      state.village,
      now,
      await this.authority.hasActiveIncoming(tx, state.account.id)
    )
    const unread = (await tx.notifications.listForPlayer({
      playerId: state.account.id,
      unreadOnly: true,
      limit: 100
    })).length
    return {
      token,
      player: profileOf(state.account, state.plot),
      world: serializedWorldOf(state.account, state.village, now, { upgradePolicy: this.upgradePolicy }),
      created,
      unread,
      features: { infiniteResources: this.infiniteResources }
    }
  }

  private async resumeSession(token: string): Promise<SessionResponse | null> {
    const tokenHash = hashSessionToken(token)
    const now = this.clock()
    return this.persistence.transaction(async tx => {
      const discovered = await tx.sessions.getByTokenHash(tokenHash)
      if (!discovered) return null
      // Lock player authority before the token row. Guest reaping/account
      // deletion uses the same order, avoiding a session/account inversion.
      const account = await tx.accounts.getById(discovered.playerId, { forUpdate: true })
      const village = await tx.villages.get(discovered.playerId, { forUpdate: true })
      const plot = await tx.world.getPlayerPlot(discovered.playerId, { forUpdate: true })
      const session = await tx.sessions.getByTokenHash(tokenHash, { forUpdate: true })
      if (!session || session.playerId !== discovered.playerId) return null
      if (!account || !village || !plot) {
        await tx.sessions.delete(tokenHash)
        if (account) await tx.accounts.deleteUnreferencedGuests([account.id])
        return null
      }
      const state: OwnedState = { account, village, plot }
      if (session.expiresAt <= now) {
        await tx.sessions.delete(tokenHash)
        return null
      }
      if (state.plot.leaseExpiresAt !== null && state.plot.leaseExpiresAt <= now) {
        await tx.sessions.deleteForPlayer(session.playerId)
        await releasePlayerPlotClaim(tx, state.plot, now)
        await tx.accounts.deleteUnreferencedGuests([state.account.id])
        return null
      }
      await this.touchSession(tx, session, now)
      if (state.plot.leaseId && state.plot.leaseExpiresAt
        && state.plot.leaseExpiresAt.getTime() - now.getTime() < DEFAULT_GUEST_PLOT_TTL_MS / 2) {
        const renewed = await tx.world.renewGuestLease(
          state.account.id,
          state.plot.leaseId,
          now,
          new Date(now.getTime() + DEFAULT_GUEST_PLOT_TTL_MS)
        )
        if (renewed) {
          state.plot.leaseRenewedAt = now
          state.plot.leaseExpiresAt = new Date(now.getTime() + DEFAULT_GUEST_PLOT_TTL_MS)
        }
      }
      await this.authority.touchPresence(tx, state.account, now)
      return this.sessionResponse(tx, state, token, false, now)
    })
  }

  async ensureSession(rawToken: unknown, rawAddress?: unknown): Promise<SessionResponse> {
    const token = normalizeSessionToken(rawToken)
    if (token) {
      const resumed = await this.resumeSession(token)
      if (resumed) return resumed
    }
    const now = this.clock()
    const allowance = this.limiter.consumeGuestCreation(rawAddress, now.getTime())
    if (!allowance.allowed) throw new ApiError(429, 'Too many new villages from this address — try again later')

    const newToken = createOpaqueSessionToken()
    return this.persistence.transaction(async tx => {
      const playerId = randomId('p')
      const account: AccountRecord = {
        id: playerId,
        username: `Chief-${randomBytes(2).toString('hex').toUpperCase()}`,
        usernameKey: null,
        passwordHash: null,
        registered: false,
        trophies: 0,
        shieldUntil: new Date(now.getTime() + this.starterShieldMs),
        createdAt: now,
        lastSeenAt: now,
        revision: 1,
        revengeRights: {},
        botRaidCooldowns: {}
      }
      await tx.accounts.insert(account)
      const village = starterVillage(playerId, now)
      await tx.villages.insert(village)
      await tx.sessions.insert({
        tokenHash: hashSessionToken(newToken),
        playerId,
        createdAt: now,
        lastUsedAt: now,
        expiresAt: new Date(now.getTime() + this.sessionTtlMs),
        deviceId: null
      })
      const plot = await allocatePlayerPlot(tx, { playerId, registered: false, now })
      await tx.outbox.add(outboxEvent({
        topic: 'players',
        aggregateType: 'player',
        aggregateId: playerId,
        eventType: 'PLAYER_CREATED',
        now,
        payload: { worldId: plot.worldId, x: plot.x, y: plot.y }
      }))
      // No other transaction can observe this player before commit, so a new
      // starter cannot yet have incoming attacks or notifications. Returning
      // the known response directly keeps extra reads outside the world-cursor
      // admission critical section.
      return {
        token: newToken,
        player: profileOf(account, plot),
        world: serializedWorldOf(account, village, now, { upgradePolicy: this.upgradePolicy }),
        created: true,
        unread: 0,
        features: { infiniteResources: this.infiniteResources }
      }
    })
  }

  async authenticate(rawToken: unknown): Promise<RuntimePrincipal> {
    const token = normalizeSessionToken(rawToken)
    if (!token) throw new ApiError(401, 'Unknown device token')
    const tokenHash = hashSessionToken(token)
    const now = this.clock()
    const observed = await this.persistence.transaction(async tx => {
      const session = await tx.sessions.getByTokenHash(tokenHash)
      if (!session) return { kind: 'missing' as const }
      if (session.expiresAt <= now) return { kind: 'cleanup' as const, playerId: session.playerId }
      const account = await tx.accounts.getById(session.playerId)
      const plot = await tx.world.getPlayerPlot(session.playerId)
      if (!account || !plot || (plot.leaseExpiresAt !== null && plot.leaseExpiresAt <= now)) {
        return { kind: 'cleanup' as const, playerId: session.playerId }
      }
      await this.touchSession(tx, session, now)
      if (plot.leaseId && plot.leaseExpiresAt
        && plot.leaseExpiresAt.getTime() - now.getTime() < DEFAULT_GUEST_PLOT_TTL_MS / 2) {
        await tx.world.renewGuestLease(
          account.id,
          plot.leaseId,
          now,
          new Date(now.getTime() + DEFAULT_GUEST_PLOT_TTL_MS)
        )
      }
      await this.authority.touchPresence(tx, account, now)
      return { kind: 'valid' as const, playerId: session.playerId }
    }, { isolation: 'read committed' })
    if (observed.kind === 'valid') return { playerId: observed.playerId }
    if (observed.kind === 'missing') throw new ApiError(401, 'Unknown device token')

    // Error cases are rare. Re-read them under locks so expiry cleanup cannot
    // race registration, lease renewal, relocation, or another API process.
    const recovered = await this.persistence.transaction(async tx => {
      const account = await tx.accounts.getById(observed.playerId, { forUpdate: true })
      const plot = await tx.world.getPlayerPlot(observed.playerId, { forUpdate: true })
      const session = await tx.sessions.getByTokenHash(tokenHash, { forUpdate: true })
      if (!session || session.playerId !== observed.playerId) return null
      const sessionExpired = session.expiresAt <= now
      const plotExpired = Boolean(plot?.leaseExpiresAt && plot.leaseExpiresAt <= now)
      const incomplete = !account || !plot
      if (sessionExpired || plotExpired || incomplete) {
        await tx.sessions.delete(tokenHash)
        // A device session can expire before its guest plot, and imported
        // accounts may have another live device. Session expiry alone must not
        // tear down otherwise-valid village authority; the lease reaper owns
        // that later cleanup. A dead/missing plot invalidates every session.
        if (plotExpired || incomplete) {
          await tx.sessions.deleteForPlayer(session.playerId)
          if (plot && (plot.leaseId !== null || !account)) {
            await releasePlayerPlotClaim(tx, plot, now)
          }
          if (account) await tx.accounts.deleteUnreferencedGuests([account.id])
        }
        return null
      }

      // A concurrent renewal/promotion can make the earlier observation stale.
      await this.touchSession(tx, session, now)
      if (plot.leaseId && plot.leaseExpiresAt
        && plot.leaseExpiresAt.getTime() - now.getTime() < DEFAULT_GUEST_PLOT_TTL_MS / 2) {
        await tx.world.renewGuestLease(
          account.id,
          plot.leaseId,
          now,
          new Date(now.getTime() + DEFAULT_GUEST_PLOT_TTL_MS)
        )
      }
      await this.authority.touchPresence(tx, account, now)
      return { playerId: session.playerId }
    })
    if (recovered) return recovered
    throw new ApiError(401, 'Unknown device token')
  }

  async register(principal: RuntimePrincipal, rawUsername: unknown, rawPassword: unknown) {
    const credentials = validateRegistrationCredentials(rawUsername, rawPassword)
    if (!credentials.ok) throw new ApiError(400, credentials.message)
    const key = normalizeUsernameKey(credentials.username)
    const now = this.clock()
    const passwordHash = await hashPasswordAsync(credentials.password)
    return this.usernameMutation(() => this.persistence.transaction(async tx => {
      const state = await this.authority.owned(tx, principal.playerId, true)
      if (state.account.registered) {
        throw new ApiError(409, 'This village is already registered — log out to create a different account')
      }
      const existing = await tx.accounts.getByUsernameKey(key, { forUpdate: true })
      if (existing && existing.id !== state.account.id) {
        throw new ApiError(409, 'That username is already taken', 'USERNAME_TAKEN')
      }
      if (!state.plot.leaseId || !await tx.world.promoteGuestLease(state.account.id, state.plot.leaseId, now)) {
        throw new ApiError(409, 'The guest village lease expired before registration')
      }
      const accountRevision = state.account.revision
      state.account.username = credentials.username
      state.account.usernameKey = key
      state.account.passwordHash = passwordHash
      state.account.registered = true
      state.account.lastSeenAt = now
      await this.authority.updateAccount(tx, state.account, accountRevision)
      const villageRevision = state.village.economyRevision
      state.village.appearanceRevision += 1
      state.village.lastMutationAt = now
      await this.authority.updateVillage(tx, state.village, villageRevision)
      state.plot.leaseId = null
      state.plot.leaseIssuedAt = null
      state.plot.leaseRenewedAt = null
      state.plot.leaseExpiresAt = null
      return profileOf(state.account, state.plot)
    }))
  }

  async login(rawUsername: unknown, rawPassword: unknown, rawAddress?: unknown): Promise<SessionResponse> {
    const username = String(rawUsername ?? '').trim()
    const password = typeof rawPassword === 'string' ? rawPassword : ''
    if (!username || !password) throw new ApiError(400, 'Username and password are required')
    const key = normalizeUsernameKey(username)
    const now = this.clock()
    const attempt = this.limiter.beginLogin(rawAddress, key, now.getTime())
    if (!attempt.allowed) throw new ApiError(429, 'Too many failed attempts — try again in a minute')
    const account = await this.persistence.transaction(tx => tx.accounts.getByUsernameKey(key))
    if (!account?.passwordHash) throw new ApiError(404, 'No account found with that username')
    if (!await verifyPasswordAsync(password, account.passwordHash)) {
      this.limiter.recordLoginFailure(attempt.failureKey, now.getTime())
      throw new ApiError(401, 'Incorrect password')
    }
    this.limiter.recordLoginSuccess(attempt.failureKey)
    const token = createOpaqueSessionToken()
    return this.persistence.transaction(async tx => {
      const state = await this.authority.owned(tx, account.id, true)
      const sessions = await tx.sessions.listForPlayer(account.id, MAX_SESSIONS_PER_PLAYER + 16, { forUpdate: true })
      if (!state.account.passwordHash || state.account.passwordHash !== account.passwordHash) {
        throw new ApiError(401, 'Incorrect password')
      }
      const live: SessionRecord[] = []
      for (const session of sessions) {
        if (session.expiresAt <= now) await tx.sessions.delete(session.tokenHash)
        else live.push(session)
      }
      while (live.length >= MAX_SESSIONS_PER_PLAYER) {
        await tx.sessions.delete(live.shift()!.tokenHash)
      }
      await tx.sessions.insert({
        tokenHash: hashSessionToken(token),
        playerId: account.id,
        createdAt: now,
        lastUsedAt: now,
        expiresAt: new Date(now.getTime() + this.sessionTtlMs),
        deviceId: null
      })
      await this.authority.touchPresence(tx, state.account, now)
      return this.sessionResponse(tx, state, token, false, now)
    })
  }

  async logout(rawToken: unknown): Promise<void> {
    const token = normalizeSessionToken(rawToken)
    if (!token) return
    const now = this.clock()
    const hash = hashSessionToken(token)
    await this.persistence.transaction(async tx => {
      const discovered = await tx.sessions.getByTokenHash(hash)
      if (!discovered) return
      const account = await tx.accounts.getById(discovered.playerId, { forUpdate: true })
      const plot = !account || !account.registered
        ? await tx.world.getPlayerPlot(discovered.playerId, { forUpdate: true })
        : null
      const session = await tx.sessions.getByTokenHash(hash, { forUpdate: true })
      if (!session || session.playerId !== discovered.playerId) return
      await tx.sessions.delete(hash)
      if (!account) {
        if (plot) await releasePlayerPlotClaim(tx, plot, now)
        return
      }
      if (account.registered) return
      const remaining = await tx.sessions.listForPlayer(account.id, 1, { forUpdate: true })
      if (remaining.length > 0) return
      if (plot) {
        await releasePlayerPlotClaim(tx, plot, now)
      }
      // Accounts retained by immutable attack/economy history remain compact
      // audit roots; fresh guests disappear with their final device session.
      await tx.accounts.deleteUnreferencedGuests([account.id])
    })
  }

  async rename(principal: RuntimePrincipal, rawName: unknown) {
    const name = String(rawName ?? '').trim()
    if (!isValidUsername(name)) {
      throw new ApiError(400, 'Name must be 3-18 characters: letters, numbers, "_" or "-"')
    }
    const key = normalizeUsernameKey(name)
    const now = this.clock()
    return this.usernameMutation(() => this.persistence.transaction(async tx => {
      const state = await this.authority.owned(tx, principal.playerId, true)
      if (state.account.username === name) return profileOf(state.account, state.plot)
      const existing = await tx.accounts.getByUsernameKey(key, { forUpdate: true })
      if (existing && existing.id !== state.account.id) {
        throw new ApiError(409, 'That name belongs to a registered account', 'USERNAME_TAKEN')
      }
      const accountRevision = state.account.revision
      state.account.username = name
      if (state.account.registered) state.account.usernameKey = key
      state.account.lastSeenAt = now
      await this.authority.updateAccount(tx, state.account, accountRevision)
      const villageRevision = state.village.economyRevision
      state.village.appearanceRevision += 1
      state.village.lastMutationAt = now
      await this.authority.updateVillage(tx, state.village, villageRevision)
      return profileOf(state.account, state.plot)
    }))
  }
}
