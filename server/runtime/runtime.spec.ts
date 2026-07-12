import assert from 'node:assert/strict'
import test from 'node:test'
import { merchantOffersFor, worldDayIndex } from '../../src/game/config/Economy'
import { engageAttack, prepareAttack } from '../attack-domain/domain'
import { combatSnapshotHash } from '../attack-domain/simulation'
import type { CombatVillageSnapshot } from '../attack-domain/types'
import { createApiHandler, type ApiResult } from '../http'
import { ApiError } from '../errors'
import {
  attackRecordFromAuthority,
  MemoryPersistence,
  type AccountRecord,
  type Persistence,
  type UnitOfWork
} from '../persistence'
import type { SessionResponse } from '../protocol'
import type { RuntimeAttackService, RuntimePrincipal } from './contracts'
import { PersistenceGameService } from './service'
import { VillageAuthority } from './village-authority'

class CountingPersistence implements Persistence {
  readonly base = new MemoryPersistence()
  incomingQueries = 0
  bulkQueries = 0
  sessionTouches = 0
  failGuestArchive = false
  authorityReads = { sessions: 0, accounts: 0, villages: 0, plots: 0, forUpdate: 0 }
  lockOrder: Array<'sessions' | 'accounts' | 'villages' | 'plots'> = []

  resetAuthorityReads() {
    this.authorityReads = { sessions: 0, accounts: 0, villages: 0, plots: 0, forUpdate: 0 }
    this.lockOrder = []
  }

  private countAuthorityRead(kind: 'sessions' | 'accounts' | 'villages' | 'plots', args: unknown[]) {
    this.authorityReads[kind] += 1
    const options = args[1]
    if (options && typeof options === 'object' && 'forUpdate' in options && options.forUpdate === true) {
      this.authorityReads.forUpdate += 1
      this.lockOrder.push(kind)
    }
  }

  transaction<T>(work: (tx: UnitOfWork) => Promise<T>): Promise<T> {
    return this.base.transaction(tx => work(new Proxy(tx, {
      get: (target, property, receiver) => {
        if (property === 'accounts') {
          return new Proxy(target.accounts, {
            get: (accounts, method, accountReceiver) => {
              const value = Reflect.get(accounts, method, accountReceiver) as unknown
              if (method === 'getById' && typeof value === 'function') {
                return (...args: unknown[]) => {
                  this.countAuthorityRead('accounts', args)
                  return Reflect.apply(value, accounts, args) as unknown
                }
              }
              if (method === 'deleteUnreferencedGuests' && typeof value === 'function') {
                return (...args: unknown[]) => {
                  if (this.failGuestArchive) throw new Error('injected guest archive failure')
                  return Reflect.apply(value, accounts, args) as unknown
                }
              }
              return value
            }
          })
        }
        if (property === 'sessions') {
          return new Proxy(target.sessions, {
            get: (sessions, method, sessionReceiver) => {
              const value = Reflect.get(sessions, method, sessionReceiver) as unknown
              if (method === 'getByTokenHash' && typeof value === 'function') {
                return (...args: unknown[]) => {
                  this.countAuthorityRead('sessions', args)
                  return Reflect.apply(value, sessions, args) as unknown
                }
              }
              if (method === 'touch' && typeof value === 'function') {
                return (...args: unknown[]) => {
                  this.sessionTouches += 1
                  return Reflect.apply(value, sessions, args) as unknown
                }
              }
              return value
            }
          })
        }
        if (property === 'villages') {
          return new Proxy(target.villages, {
            get: (villages, method, villageReceiver) => {
              const value = Reflect.get(villages, method, villageReceiver) as unknown
              if (method === 'get' && typeof value === 'function') {
                return (...args: unknown[]) => {
                  this.countAuthorityRead('villages', args)
                  return Reflect.apply(value, villages, args) as unknown
                }
              }
              return value
            }
          })
        }
        if (property === 'world') {
          return new Proxy(target.world, {
            get: (world, method, worldReceiver) => {
              const value = Reflect.get(world, method, worldReceiver) as unknown
              if (method === 'getPlayerPlot' && typeof value === 'function') {
                return (...args: unknown[]) => {
                  this.countAuthorityRead('plots', args)
                  return Reflect.apply(value, world, args) as unknown
                }
              }
              return value
            }
          })
        }
        if (property !== 'attacks') return Reflect.get(target, property, receiver) as unknown
        return new Proxy(target.attacks, {
          get: (attacks, method, attackReceiver) => {
            const value = Reflect.get(attacks, method, attackReceiver) as unknown
            if (method === 'listLeasedIncoming' && typeof value === 'function') {
              return (...args: unknown[]) => {
                this.incomingQueries += 1
                return Reflect.apply(value, attacks, args) as unknown
              }
            }
            if (method === 'listLeasedIncomingForDefenders' && typeof value === 'function') {
              return (...args: unknown[]) => {
                this.bulkQueries += 1
                return Reflect.apply(value, attacks, args) as unknown
              }
            }
            return value
          }
        })
      }
    }) as UnitOfWork))
  }

  close(): Promise<void> {
    return this.base.close()
  }
}

function unavailable(): Promise<never> {
  return Promise.reject(new Error('attack route not used by this core runtime spec'))
}

function attackStub(authorized: Set<string>, onAuthorize: () => void = () => {}): RuntimeAttackService {
  return {
    botSettle: unavailable,
    botStart: unavailable,
    activeOutgoingBattle: unavailable,
    abortActiveOutgoingBattle: unavailable,
    startAttack: unavailable,
    matchmake: unavailable,
    pushFrames: unavailable,
    pushCommands: unavailable,
    endAttack: unavailable,
    incomingAttacks: unavailable,
    getReplay: unavailable,
    authorizeMapFocus: async (_principal, x, y) => {
      onAuthorize()
      return authorized.has(`${x},${y}`)
    }
  }
}

function record(value: unknown): Record<string, unknown> {
  assert(value && typeof value === 'object' && !Array.isArray(value))
  return value as Record<string, unknown>
}

function account(id: string, now: Date): AccountRecord {
  return {
    id,
    username: id,
    usernameKey: null,
    passwordHash: null,
    registered: true,
    trophies: 0,
    shieldUntil: null,
    createdAt: now,
    lastSeenAt: now,
    revision: 1,
    revengeRights: {},
    botRaidCooldowns: {}
  }
}

function incomingAttack(
  id: string,
  attackerId: string,
  defenderId: string,
  startedAt: number,
  leased = false
) {
  const snapshot: CombatVillageSnapshot = {
    schemaVersion: 1,
    snapshotId: `snapshot-${id}`,
    villageVersion: 'appearance_1',
    buildings: [{ id: 'town-hall', type: 'town_hall', level: 1, gridX: 10, gridY: 10 }]
  }
  let authority = prepareAttack({
    attackId: id,
    attackerId,
    attackerName: attackerId,
    selectionSource: 'NEIGHBOR',
    target: {
      kind: 'PLAYER',
      targetId: defenderId,
      playerId: defenderId,
      shieldBypass: 'NONE',
      plot: { worldId: 'main', x: 1, y: 1, version: '1' },
      villageVersion: snapshot.villageVersion,
      snapshotId: snapshot.snapshotId,
      snapshotHash: combatSnapshotHash(snapshot)
    },
    snapshot,
    simulationSeed: `seed-${id}`,
    rewardPolicy: {
      lootCaps: { gold: 100, ore: 10, food: 5 },
      winTrophyBase: 10,
      winTrophyPerFivePercent: 1,
      lossTrophyDelta: -5
    },
    requestedArmy: { warrior: 1 },
    troopLevel: 1,
    now: startedAt
  }, {
    reserveArmy: request => ({
      reservationId: `reservation-${id}`,
      sourceArmyVersion: 1,
      reserved: request.requested,
      troopLevel: request.troopLevel
    })
  })
  if (leased) {
    const observedAt = startedAt + 1
    authority = engageAttack(authority, {
      expectedPhase: authority.phase,
      expectedVersion: authority.version
    }, observedAt, {
      validateAndLockTarget: request => ({
        available: true,
        targetId: request.target.targetId,
        plot: request.target.plot,
        villageVersion: request.target.villageVersion,
        shieldUntil: 0,
        observedAt,
        engagementLease: {
          leaseId: `lease-${id}`,
          acquiredAt: observedAt,
          expiresAt: observedAt + 120_000
        }
      })
    })
  }
  return attackRecordFromAuthority(authority, {
    fencingTokenHash: id,
    targetPlotVersion: 1,
    updatedAt: new Date(leased ? startedAt + 1 : startedAt)
  })
}

test('MemoryPersistence serves the async core routes without global scans or checkpoint revisions', async () => {
  const persistence = new CountingPersistence()
  let now = new Date('2026-07-11T12:00:00.000Z')
  const authorized = new Set<string>()
  let authorizationQueries = 0
  const service = new PersistenceGameService(persistence, {
    attacks: attackStub(authorized, () => { authorizationQueries += 1 }),
    now: () => new Date(now),
    starterShieldMs: 0,
    allowDebugGrants: true
  })
  const handle = createApiHandler(service)
  const call = async (
    method: string,
    path: string,
    input: { token?: string; body?: unknown } = {}
  ): Promise<ApiResult> => {
    const url = new URL(path, 'http://runtime.test')
    return handle({
      method,
      path: url.pathname,
      query: url.searchParams,
      token: input.token ?? null,
      clientAddress: 'runtime-spec',
      body: input.body
    })
  }

  const created = await call('POST', '/auth/session')
  assert.equal(created.status, 200)
  const session = created.body as SessionResponse
  const token = session.token
  const principal: RuntimePrincipal = { playerId: session.player.id }
  assert.equal(session.created, true)
  assert.equal(session.world.resources.gold, 1_000)

  persistence.resetAuthorityReads()
  assert.deepEqual(await service.authenticate(token), principal)
  assert.deepEqual(persistence.authorityReads, {
    sessions: 1,
    accounts: 1,
    villages: 0,
    plots: 1,
    forUpdate: 0
  }, 'healthy authentication is read-mostly and skips village authority')

  persistence.resetAuthorityReads()
  const resumed = await service.ensureSession(token, 'resume-lock-order')
  assert.equal(resumed.created, false)
  assert.deepEqual(
    persistence.lockOrder.slice(0, 4),
    ['accounts', 'villages', 'plots', 'sessions'],
    'session resume locks player authority before the token row'
  )

  // Advancing only the wall clock must not turn a semantic no-op save into a
  // client revision conflict/write.
  now = new Date(now.getTime() + 1)
  const noOp = await call('POST', '/world/save', {
    token,
    body: { world: session.world, requestId: 'noop-save' }
  })
  assert.equal(noOp.status, 200)
  assert.equal((record(noOp.body).world as { revision: number }).revision, session.world.revision)
  await persistence.base.transaction(async tx => {
    assert.equal((await tx.villages.get(session.player.id))?.economyRevision, session.world.revision)
  })
  assert.equal(persistence.sessionTouches, 0, 'hot requests do not rewrite the device session row')
  now = new Date(now.getTime() + 30_000)
  await service.authenticate(token)
  await service.authenticate(token)
  assert.equal(persistence.sessionTouches, 1, 'session presence is durably sampled once per interval')

  const logoutGuest = await service.ensureSession('', 'logout-cleanup')
  await service.logout(logoutGuest.token)
  await persistence.base.transaction(async tx => {
    assert.equal(await tx.accounts.getById(logoutGuest.player.id), null)
    assert.equal(await tx.villages.get(logoutGuest.player.id), null)
    assert.equal(await tx.world.getPlayerPlot(logoutGuest.player.id), null)
  })

  const oreGrant = await call('POST', '/resources/apply', {
    token,
    body: { resource: 'ore', delta: 1_000, reason: 'debug_grant', requestId: 'ore-cap' }
  })
  assert.equal(oreGrant.status, 200)
  assert.equal(record(oreGrant.body).ore, 150)
  await persistence.base.transaction(async tx => {
    assert.equal(await tx.balanceLedger.sumSince(
      session.player.id,
      'resources:debug_grant',
      'ore',
      new Date('2026-07-11T00:00:00.000Z')
    ), 125, 'ledger records the clamped delta, not the requested 1000')
  })
  const oreReplay = await call('POST', '/resources/apply', {
    token,
    body: { resource: 'ore', delta: 1_000, reason: 'debug_grant', requestId: 'ore-cap' }
  })
  assert.deepEqual(oreReplay.body, oreGrant.body)
  const ledger = await call('GET', '/economy/ledger?days=1', { token })
  assert.equal(ledger.status, 200)
  assert.equal((record(ledger.body).days as unknown[]).length, 1)
  const debugShields = await call('POST', '/debug/clear-shields', { token })
  assert.equal(debugShields.status, 200)

  const merchantOffer = merchantOffersFor(session.player.id, worldDayIndex(now.getTime()))
    .find(offer => offer.id === 1)!
  const goldBeforeMerchant = Number(record(oreGrant.body).gold)
  const merchant = await call('POST', '/merchant/trade', {
    token,
    body: { offerId: 1, requestId: 'merchant-one' }
  })
  assert.equal(merchant.status, 200)
  assert.equal(
    record(merchant.body).gold,
    goldBeforeMerchant - merchantOffer.give.amount,
    'merchant debits the advertised cost exactly once'
  )

  const goldGrant = await call('POST', '/resources/apply', {
    token,
    body: { delta: 2_000, reason: 'debug_grant', requestId: 'gold-build' }
  })
  assert.equal(goldGrant.status, 200)
  const beforeBuild = record((await call('GET', '/world', { token })).body).world as SessionResponse['world']
  const watchtowerSave = await call('POST', '/world/save', {
    token,
    body: {
      world: {
        ...beforeBuild,
        buildings: [
          ...beforeBuild.buildings,
          { id: 'runtime-watchtower', type: 'watchtower', gridX: 0, gridY: 0, level: 1 }
        ]
      },
      requestId: 'build-watchtower'
    }
  })
  assert.equal(watchtowerSave.status, 200)

  const trained = await call('POST', '/army/train', {
    token,
    body: { type: 'warrior', count: 2, requestId: 'train-two' }
  })
  assert.equal(trained.status, 200)
  assert.equal((record(trained.body).army as Record<string, number>).warrior, 2)
  const untrained = await call('POST', '/army/untrain', {
    token,
    body: { type: 'warrior', count: 1, requestId: 'untrain-one' }
  })
  assert.equal(untrained.status, 200)

  // Populate several neighboring authorities, then prove the local map uses
  // one bounded active-edge projection rather than one incoming query per row.
  for (let index = 0; index < 8; index += 1) await service.ensureSession('', `neighbor-${index}`)
  persistence.incomingQueries = 0
  persistence.bulkQueries = 0
  const homeMap = await service.map(principal, session.player.plotX, session.player.plotY, 1)
  assert.equal(record(homeMap).plots instanceof Array, true)
  assert.equal(persistence.incomingQueries, 1, 'only the owner lock check uses the single-player query')
  assert.equal(persistence.bulkQueries, 1, 'all visible attack edges use one bounded batch query')
  assert.equal(authorizationQueries, 0, 'the home center does not open an attack authorization transaction')

  const adjacent = `${session.player.plotX + 1},${session.player.plotY}`
  const remote = `${session.player.plotX + 20},${session.player.plotY + 20}`
  authorized.add(adjacent)
  authorized.add(remote)
  const adjacentMap = await service.map(principal, session.player.plotX + 1, session.player.plotY, 1)
  const remoteMap = await service.map(principal, session.player.plotX + 20, session.player.plotY + 20, 1)
  assert.equal((record(adjacentMap).plots as unknown[]).length, 9, 'adjacent active target receives the full battle ring')
  assert.equal((record(remoteMap).plots as unknown[]).length, 9, 'remote active target receives the full battle ring')
  assert.equal(authorizationQueries, 2, 'non-home centers retain active-attack focus authorization')

  const raceA = await service.ensureSession('', 'register-race-a')
  const raceB = await service.ensureSession('', 'register-race-b')
  const registrationRace = await Promise.allSettled([
    service.register({ playerId: raceA.player.id }, 'OneSharedName', 'correct-horse'),
    service.register({ playerId: raceB.player.id }, 'OneSharedName', 'correct-horse')
  ])
  assert.equal(registrationRace.filter(result => result.status === 'fulfilled').length, 1)
  const rejectedRegistration = registrationRace.find(result => result.status === 'rejected')
  assert(rejectedRegistration?.status === 'rejected')
  assert(rejectedRegistration.reason instanceof ApiError)
  assert.equal(rejectedRegistration.reason.status, 409)
  assert.equal(rejectedRegistration.reason.code, 'USERNAME_TAKEN')

  const registered = await call('POST', '/auth/register', {
    token,
    body: { username: 'RuntimeChief', password: 'correct-horse' }
  })
  assert.equal(registered.status, 200)
  assert.equal(record(record(registered.body).player).registered, true)
  persistence.resetAuthorityReads()
  await call('POST', '/auth/logout', { token })
  assert.deepEqual(
    persistence.lockOrder.slice(0, 2),
    ['accounts', 'sessions'],
    'registered logout locks the account before its token row'
  )
  assert.equal((await call('GET', '/world', { token })).status, 401)
  const loggedIn = await call('POST', '/auth/login', {
    body: { username: 'RuntimeChief', password: 'correct-horse' }
  })
  assert.equal(loggedIn.status, 200)
  const loginSession = loggedIn.body as SessionResponse

  assert.equal((await call('GET', '/leaderboard', { token: loginSession.token })).status, 200)
  const atlas = await call('GET', '/map/atlas', { token: loginSession.token })
  assert.equal(atlas.status, 200)
  assert.equal(Array.isArray(record(atlas.body).players), true)
  const selfScout = await call('GET', `/players/${session.player.id}/world`, { token: loginSession.token })
  assert.equal(selfScout.status, 200)
  assert.equal(record(record(selfScout.body).world).ownerId, session.player.id)
  assert.equal((await call('GET', '/notifications', { token: loginSession.token })).status, 200)
  assert.equal((await call('POST', '/notifications/read', { token: loginSession.token })).status, 200)

  const relocated = await call('POST', '/map/relocate', { token: loginSession.token, body: {} })
  assert.equal(relocated.status, 200)
  assert.notDeepEqual(record(record(relocated.body).me), {
    x: session.player.plotX,
    y: session.player.plotY,
    plotVersion: 1
  })

  const expiringGuest = await service.ensureSession('', 'lease-atomicity')
  const authExpiredGuest = await service.ensureSession('', 'auth-expired-lease')
  now = new Date(now.getTime() + 8 * 24 * 60 * 60_000)
  persistence.resetAuthorityReads()
  await assert.rejects(service.authenticate(authExpiredGuest.token), error => (
    error instanceof ApiError && error.status === 401
  ))
  assert.deepEqual(
    persistence.lockOrder.slice(0, 3),
    ['accounts', 'plots', 'sessions'],
    'expired authentication cleanup locks account and plot before its token row'
  )
  await persistence.base.transaction(async tx => {
    assert.equal(await tx.world.getPlayerPlot(authExpiredGuest.player.id), null)
    assert.equal(await tx.accounts.getById(authExpiredGuest.player.id), null)
  })
  persistence.failGuestArchive = true
  await assert.rejects(service.sweepExpiredGuestLeases(50), /injected guest archive failure/)
  await persistence.base.transaction(async tx => {
    assert(await tx.world.getPlayerPlot(expiringGuest.player.id), 'lease release rolls back with archival')
  })
  persistence.failGuestArchive = false
  const swept = await service.sweepExpiredGuestLeases(50)
  assert(swept.released > 0)
  await persistence.base.transaction(async tx => {
    assert((await tx.world.getReleasedSlots('main', 100)).length > 0)
    assert.equal(await tx.world.getPlayerPlot(expiringGuest.player.id), null)
  })

  const idempotencyCreatedAt = new Date('2026-07-09T12:00:00.000Z')
  const idempotencyExpiresAt = new Date('2026-07-10T12:00:00.000Z')
  await persistence.base.transaction(async tx => {
    for (let index = 0; index < 520; index += 1) {
      await tx.idempotency.claim(
        'maintenance-probe',
        'bound-check',
        `expired-${index}`,
        idempotencyCreatedAt,
        idempotencyExpiresAt
      )
    }
  })
  assert.equal(await service.pruneExpiredIdempotency(10_000), 500, 'one prune cannot exceed its hard cap')
  assert.equal(await service.pruneExpiredIdempotency(20), 20, 'the next bounded batch drains the remainder')

  await service.close()
})

test('preparing attacks cannot crowd an engaged defender lease out of authority reads', async () => {
  const persistence = new MemoryPersistence()
  const authority = new VillageAuthority()
  const startedAt = new Date('2026-07-11T12:00:00.000Z').getTime()
  await persistence.transaction(async tx => {
    await tx.accounts.insert(account('crowded-defender', new Date(startedAt)))
    await tx.accounts.insert(account('leased-attacker', new Date(startedAt)))
    await tx.attacks.insert(incomingAttack(
      'engaged-lease',
      'leased-attacker',
      'crowded-defender',
      startedAt,
      true
    ))
    for (let index = 0; index < 101; index += 1) {
      const attackerId = `preparing-attacker-${String(index).padStart(3, '0')}`
      await tx.accounts.insert(account(attackerId, new Date(startedAt + index + 1_000)))
      await tx.attacks.insert(incomingAttack(
        `preparing-${String(index).padStart(3, '0')}`,
        attackerId,
        'crowded-defender',
        startedAt + index + 1_000
      ))
    }
  })

  await persistence.transaction(async tx => {
    const genericWindow = await tx.attacks.listActiveIncoming('crowded-defender', 100)
    assert.equal(genericWindow.some(attack => attack.state !== 'preparing'), false, 'regression setup crowds the generic page')
    assert.equal(await authority.hasActiveIncoming(tx, 'crowded-defender'), true)
    assert.deepEqual(
      (await authority.leasedIncomingForPlayers(tx, ['crowded-defender'])).map(attack => attack.id),
      ['engaged-lease']
    )
  })
  await persistence.close()
})

test('global economy ledger is unavailable when debug tools are disabled', async () => {
  const service = new PersistenceGameService(new MemoryPersistence(), {
    now: () => new Date('2026-07-11T12:00:00.000Z'),
    allowDebugGrants: false
  })
  await assert.rejects(service.economyLedger(1), error => (
    error instanceof ApiError && error.status === 403
  ))
  await service.close()
})

test('device-session expiry does not tear down an otherwise-live guest lease', async () => {
  const persistence = new MemoryPersistence()
  let now = new Date('2026-07-11T12:00:00.000Z')
  const service = new PersistenceGameService(persistence, {
    now: () => new Date(now),
    starterShieldMs: 0,
    sessionTtlMs: 1
  })
  const guest = await service.ensureSession('', 'short-device-session')
  now = new Date(now.getTime() + 2)
  await assert.rejects(service.authenticate(guest.token), error => (
    error instanceof ApiError && error.status === 401
  ))
  await persistence.transaction(async tx => {
    assert(await tx.accounts.getById(guest.player.id), 'the guest account remains until its plot lease expires')
    assert(await tx.world.getPlayerPlot(guest.player.id), 'the live guest plot is not released with one device session')
  })
  await service.close()
})
