import assert from 'node:assert/strict'
import test from 'node:test'
import '../faction-training.spec'
import '../legacy-combat-adapter.spec'
import { merchantOffersFor, placementCharge, upgradeCharge, worldDayIndex } from '../../src/game/config/Economy'
import { engageAttack, prepareAttack } from '../attack-domain/domain'
import { combatSnapshotHash } from '../attack-domain/simulation'
import type { CombatVillageSnapshot } from '../attack-domain/types'
import { createApiHandler, type ApiResult } from '../http'
import { ApiError } from '../errors'
import { grantedSession, isRegistrationRequired } from '../domain/auth'
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

const EXPECTED_STARTER_BUILDINGS = [
  { type: 'army_camp', level: 1, gridX: 11, gridY: 16 },
  { type: 'barracks', level: 1, gridX: 7, gridY: 15 },
  { type: 'farm', level: 1, gridX: 15, gridY: 10 },
  { type: 'mine', level: 1, gridX: 8, gridY: 11 },
  { type: 'mystic_barracks', level: 1, gridX: 16, gridY: 15 },
  { type: 'town_hall', level: 1, gridX: 11, gridY: 11 }
]

function starterBuildingPlacements(world: SessionResponse['world']) {
  return world.buildings
    .map(({ type, level, gridX, gridY }) => ({ type, level, gridX, gridY }))
    .sort((left, right) => left.type.localeCompare(right.type))
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
    botRaidCooldowns: {},
    testModeAcknowledgedActivationId: null,
    introBattleCompleted: true
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

test('normalized banner authority rejects incomplete choices and propagates the persisted banner', async () => {
  const persistence = new MemoryPersistence()
  const now = new Date('2026-07-11T11:00:00.000Z')
  const service = new PersistenceGameService(persistence, {
    now: () => new Date(now),
    starterShieldMs: 0,
    allowGuestSessions: true
  })
  try {
    const session = grantedSession(await service.ensureSession('', 'banner-authority'))
    const principal: RuntimePrincipal = { playerId: session.player.id }
    assert.equal(session.world.banner, undefined)
    for (const invalid of [
      null,
      { palette: 1, emblem: 2 },
      { palette: '1', emblem: 2, pattern: 3 },
      { palette: 1, emblem: 2, pattern: 5 }
    ]) {
      await assert.rejects(service.setBanner(principal, invalid), error => (
        error instanceof ApiError && error.status === 400 && error.code === 'INVALID_BANNER'
      ))
    }

    await service.completeIntroBattle(principal)
    await assert.rejects(
      service.setBanner(principal, { palette: 6, emblem: 3, pattern: 4 }),
      error => error instanceof ApiError
        && error.status === 409
        && error.code === 'WATCHTOWER_PLACEMENT_REQUIRED'
    )
    const towerPlacement = await service.placeTutorialWatchtower(principal, {
      world: {
        ...session.world,
        buildings: [
          ...session.world.buildings,
          { id: 'banner-authority-watchtower', type: 'watchtower', gridX: 2, gridY: 2, level: 1 }
        ]
      },
      requestId: 'banner-authority-watchtower'
    })
    session.world = towerPlacement.world

    const before = await persistence.transaction(async tx => tx.villages.get(principal.playerId))
    assert(before)
    const banner = { palette: 6, emblem: 3, pattern: 4 }
    assert.deepEqual(await service.setBanner(principal, banner), { banner })
    const stored = await persistence.transaction(async tx => tx.villages.get(principal.playerId))
    assert(stored)
    assert.deepEqual(stored.banner, banner)
    assert.equal(stored.appearanceRevision, before.appearanceRevision + 1)
    assert.equal(stored.economyRevision, before.economyRevision)
    assert.deepEqual((await service.getWorld(principal)).banner, banner)
    assert.deepEqual((await service.scout(principal, principal.playerId)).banner, banner)

    const map = record(await service.map(principal, session.player.plotX, session.player.plotY, 0))
    const selfPostcard = (map.plots as unknown[]).map(record)
      .find(plot => plot.ownerId === principal.playerId)
    assert(selfPostcard)
    assert.deepEqual(record(selfPostcard.world).banner, banner)
    const atlas = record(await service.atlas(principal))
    const selfAtlas = (atlas.players as unknown[]).map(record).find(player => player.me === true)
    assert(selfAtlas)
    assert.deepEqual(selfAtlas.banner, banner)

    assert.deepEqual(await service.setBanner(principal, banner), { banner })
    assert.equal(
      (await persistence.transaction(async tx => tx.villages.get(principal.playerId)))?.appearanceRevision,
      stored.appearanceRevision,
      'the current explicit choice is an appearance-revision no-op'
    )
  } finally {
    await service.close()
  }
})

test('normalized attack starts include an optional target-centered focus window', async () => {
  const persistence = new MemoryPersistence()
  const targetX = 1
  const targetY = 0
  const authorized = new Set([`${targetX},${targetY}`])
  const attacks = attackStub(authorized)
  let world: SessionResponse['world']
  attacks.matchmake = async () => ({
    attackId: 'focus-window-attack',
    world,
    lootCap: 0,
    lootCapOre: 0,
    lootCapFood: 0,
    target: { worldId: 'main', x: targetX, y: targetY, plotVersion: 1 }
  })
  const service = new PersistenceGameService(persistence, {
    attacks,
    now: () => new Date('2026-07-11T11:15:00.000Z'),
    starterShieldMs: 0,
    allowGuestSessions: true
  })
  try {
    const session = grantedSession(await service.ensureSession('', 'focus-window'))
    world = session.world
    const started = record(await service.matchmake(
      { playerId: session.player.id },
      { requestId: 'focus-window' },
      session.token
    ))
    const focusWindow = record(started.focusWindow)
    assert.equal((focusWindow.plots as unknown[]).length, 9)
    assert.equal(record(focusWindow.me).x, session.player.plotX)
    assert.equal(record(focusWindow.me).y, session.player.plotY)
  } finally {
    await service.close()
  }
})

test('normalized HTTP authority enforces intro, exact Watchtower placement, then banner', async () => {
  const persistence = new MemoryPersistence()
  const now = new Date('2026-07-11T11:30:00.000Z')
  const service = new PersistenceGameService(persistence, {
    now: () => new Date(now),
    starterShieldMs: 0,
    allowDebugGrants: true,
    allowGuestSessions: true
  })
  const handle = createApiHandler(service)
  const call = async (method: string, path: string, token: string | null, body: unknown = {}) => handle({
    method,
    path,
    query: new URLSearchParams(),
    token,
    clientAddress: 'banner-gate-spec',
    body
  })

  try {
    const created = await call('POST', '/auth/session', null)
    assert.equal(created.status, 200)
    const session = created.body as SessionResponse

    for (const path of ['/world', '/map', '/map/atlas', '/notifications']) {
      const readable = await call('GET', path, session.token)
      assert.equal(readable.status, 200, `${path} stays readable during banner onboarding`)
    }

    const gatedMutations = [
      ['/world/save', { world: session.world, requestId: 'blocked-save' }],
      ['/resources/apply', { delta: 1, reason: 'debug_grant', requestId: 'blocked-grant' }],
      ['/army/batch', { operations: [{ kind: 'train', type: 'warrior', count: 1 }], requestId: 'blocked-army-batch' }],
      ['/army/train', { type: 'warrior', count: 1, requestId: 'blocked-train' }],
      ['/player/rename', { name: 'BlockedChief' }],
      ['/attacks/matchmake', { requestId: 'blocked-match' }],
      ['/map/relocate', { x: 3, y: 3 }]
    ] as const;

    for (const [path, body] of gatedMutations) {
      const blocked = await call('POST', path, session.token, body)
      assert.equal(blocked.status, 409, `${path} is gated`)
      assert.equal(record(blocked.body).code, 'INTRO_BATTLE_REQUIRED')
    }

    const chosen = { palette: 2, emblem: 1, pattern: 4 }
    const earlyBanner = await call('POST', '/player/banner', session.token, { banner: chosen })
    assert.equal(earlyBanner.status, 409)
    assert.equal(record(earlyBanner.body).code, 'INTRO_BATTLE_REQUIRED')

    const completed = await call('POST', '/intro-battle/complete', session.token)
    assert.equal(completed.status, 200)

    for (const [path, body] of gatedMutations) {
      const blocked = await call('POST', path, session.token, body)
      assert.equal(blocked.status, 409, `${path} stays gated until the Watchtower is authoritative`)
      assert.equal(record(blocked.body).code, 'WATCHTOWER_PLACEMENT_REQUIRED')
    }
    const towerGatedBanner = await call('POST', '/player/banner', session.token, { banner: chosen })
    assert.equal(towerGatedBanner.status, 409)
    assert.equal(record(towerGatedBanner.body).code, 'WATCHTOWER_PLACEMENT_REQUIRED')

    const towerWorld = {
      ...session.world,
      buildings: [
        ...session.world.buildings,
        { id: 'tutorial-watchtower', type: 'watchtower', gridX: 2, gridY: 2, level: 1 }
      ]
    }
    const invalidTower = await call('POST', '/watchtower-tutorial/place', session.token, {
      world: {
        ...towerWorld,
        buildings: towerWorld.buildings.map(building => (
          building.type === 'town_hall' ? { ...building, gridX: building.gridX + 1 } : building
        ))
      },
      requestId: 'invalid-first-tower'
    })
    assert.equal(invalidTower.status, 409)
    assert.equal(record(invalidTower.body).code, 'WATCHTOWER_PLACEMENT_ONLY')

    const placedTower = await call('POST', '/watchtower-tutorial/place', session.token, {
      world: towerWorld,
      requestId: 'first-tower'
    })
    assert.equal(placedTower.status, 200)
    assert.equal(record(placedTower.body).watchtowerPlacementRequired, false)
    const authoritativeTowerWorld = record(placedTower.body).world as SessionResponse['world']
    assert.equal(authoritativeTowerWorld.buildings.filter(building => building.type === 'watchtower').length, 1)
    const persistedPlacement = await persistence.transaction(async tx => ({
      account: await tx.accounts.getById(session.player.id),
      village: await tx.villages.get(session.player.id)
    }))
    assert.equal(persistedPlacement.account?.watchtowerPlacementCompleted, true,
      'the onboarding completion flag is durable on the account root')
    assert.equal(
      (persistedPlacement.village?.buildings as Array<{ type?: unknown }> | undefined)
        ?.filter(building => building.type === 'watchtower').length,
      1,
      'the Watchtower and completion flag commit together'
    )

    const sameKeyRetry = await call('POST', '/watchtower-tutorial/place', session.token, {
      world: towerWorld,
      requestId: 'first-tower'
    })
    assert.equal(sameKeyRetry.status, 200, 'same-key retry replays the committed placement')
    const differentKeyReplay = await call('POST', '/watchtower-tutorial/place', session.token, {
      world: authoritativeTowerWorld,
      requestId: 'second-first-tower'
    })
    assert.equal(differentKeyReplay.status, 409)
    assert.equal(record(differentKeyReplay.body).code, 'WATCHTOWER_PLACEMENT_COMPLETE')

    const preBanner = await call('POST', '/world/save', session.token, {
      world: authoritativeTowerWorld,
      requestId: 'pre-banner-save'
    })
    assert.equal(preBanner.status, 409)
    assert.equal(record(preBanner.body).code, 'BANNER_REQUIRED')

    const banner = await call('POST', '/player/banner', session.token, { banner: chosen })
    assert.equal(banner.status, 200)
    assert.deepEqual(record(banner.body).banner, chosen)

    const saved = await call('POST', '/world/save', session.token, {
      world: authoritativeTowerWorld,
      requestId: 'ready-save'
    })
    assert.equal(saved.status, 200, 'the same gameplay mutation succeeds after choosing a banner')
  } finally {
    await service.close()
  }
})

test('MemoryPersistence serves the async core routes without global scans or checkpoint revisions', async () => {
  const persistence = new CountingPersistence()
  let now = new Date('2026-07-11T12:00:00.000Z')
  const authorized = new Set<string>()
  let authorizationQueries = 0
  const service = new PersistenceGameService(persistence, {
    attacks: attackStub(authorized, () => { authorizationQueries += 1 }),
    now: () => new Date(now),
    starterShieldMs: 0,
    allowDebugGrants: true,
    allowGuestSessions: true,
    infiniteResources: false,
    fixedUpgradeDurationMs: 1_000
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
  assert.deepEqual(session.world.resources, { gold: 100_000, ore: 100_000, food: 100_000 })
  assert.deepEqual(starterBuildingPlacements(session.world), EXPECTED_STARTER_BUILDINGS)
  await service.completeIntroBattle(principal)
  const onboardingTower = await service.placeTutorialWatchtower(principal, {
    world: {
      ...session.world,
      buildings: [
        ...session.world.buildings,
        { id: 'runtime-onboarding-watchtower', type: 'watchtower', gridX: 2, gridY: 2, level: 1 }
      ]
    },
    requestId: 'runtime-onboarding-watchtower'
  })
  assert.equal(onboardingTower.watchtowerPlacementRequired, false)
  assert.equal(onboardingTower.world.buildings.filter(building => building.type === 'watchtower').length, 1)
  assert.equal(
    onboardingTower.world.resources.ore,
    (session.world.resources.ore ?? 0) - placementCharge('watchtower', 1).ore,
    'the required Watchtower still pays the normal authoritative placement price'
  )
  session.world = onboardingTower.world
  const appearanceAfterTower = await persistence.base.transaction(async tx => (
    (await tx.villages.get(session.player.id))?.appearanceRevision
  ))
  assert(appearanceAfterTower !== undefined)
  const chosenBanner = { palette: 1, emblem: 4, pattern: 3 }
  assert.equal((await call('POST', '/player/banner', {
    token,
    body: { banner: chosenBanner }
  })).status, 200)

  persistence.resetAuthorityReads()
  assert.deepEqual(await service.authenticate(token), principal)
  assert.deepEqual(persistence.authorityReads, {
    sessions: 1,
    accounts: 1,
    villages: 0,
    plots: 1,
    forUpdate: 1
  }, 'healthy authentication locks only the account root so moderation cannot race; village authority stays skipped')

  persistence.resetAuthorityReads()
  await Promise.all([
    service.authenticate(token),
    service.authenticate(token),
    service.authenticate(token)
  ])
  assert.deepEqual(persistence.authorityReads, {
    sessions: 1,
    accounts: 1,
    villages: 0,
    plots: 1,
    forUpdate: 1
  }, 'same-instance authentication bursts coalesce into one database transaction')

  persistence.resetAuthorityReads()
  const resumed = grantedSession(await service.ensureSession(token, 'resume-lock-order'))
  assert.equal(resumed.created, false)
  assert.deepEqual(
    persistence.lockOrder.slice(0, 4),
    ['accounts', 'villages', 'plots', 'sessions'],
    'session resume locks player authority before the token row'
  )

  // An onboarded layout no-op remains accepted even when the starter mine
  // advances the economy checkpoint between creation and save.
  now = new Date(now.getTime() + 1)
  const noOp = await call('POST', '/world/save', {
    token,
    body: { world: session.world, requestId: 'noop-save' }
  })
  assert.equal(noOp.status, 200)
  const noOpWorld = record(noOp.body).world as SessionResponse['world']
  assert.deepEqual(starterBuildingPlacements(noOpWorld), [
    ...EXPECTED_STARTER_BUILDINGS,
    { type: 'watchtower', level: 1, gridX: 2, gridY: 2 }
  ])
  await persistence.base.transaction(async tx => {
    assert.equal((await tx.villages.get(session.player.id))?.economyRevision, noOpWorld.revision)
  })

  for (const invalidBanner of [
    null,
    { palette: 1, emblem: 2 },
    { palette: '1', emblem: 2, pattern: 3 },
    { palette: 1, emblem: 2, pattern: 5 }
  ]) {
    const rejected = await call('POST', '/player/banner', {
      token,
      body: { banner: invalidBanner }
    })
    assert.equal(rejected.status, 400)
    assert.equal(record(rejected.body).code, 'INVALID_BANNER')
  }
  const raisedBanner = await call('POST', '/player/banner', {
    token,
    body: { banner: chosenBanner }
  })
  assert.equal(raisedBanner.status, 200)
  assert.deepEqual(record(raisedBanner.body).banner, chosenBanner)
  const ownedAfterBanner = record((await call('GET', '/world', { token })).body).world as SessionResponse['world']
  assert.deepEqual(ownedAfterBanner.banner, chosenBanner)
  await persistence.base.transaction(async tx => {
    const stored = await tx.villages.get(session.player.id)
    assert.deepEqual(stored?.banner, chosenBanner)
    assert.equal(stored?.appearanceRevision, appearanceAfterTower + 1)
    assert.equal(stored?.economyRevision, noOpWorld.revision,
      'appearance-only writes do not invalidate layout/economy revisions')
  })
  assert.equal((await call('POST', '/player/banner', {
    token,
    body: { banner: chosenBanner }
  })).status, 200)
  await persistence.base.transaction(async tx => {
    assert.equal((await tx.villages.get(session.player.id))?.appearanceRevision, appearanceAfterTower + 1,
      'raising the already-current banner is a revision no-op')
  })
  assert.equal(persistence.sessionTouches, 0, 'hot requests do not rewrite the device session row')
  now = new Date(now.getTime() + 30_000)
  await service.authenticate(token)
  await service.authenticate(token)
  assert.equal(persistence.sessionTouches, 1, 'session presence is durably sampled once per interval')

  const logoutGuest = grantedSession(await service.ensureSession('', 'logout-cleanup'))
  await service.logout(logoutGuest.token)
  await persistence.base.transaction(async tx => {
    assert.equal(await tx.accounts.getById(logoutGuest.player.id), null)
    assert.equal(await tx.villages.get(logoutGuest.player.id), null)
    assert.equal(await tx.world.getPlayerPlot(logoutGuest.player.id), null)
  })

  const beforeDebugGrants = await service.getWorld(principal)
  const oreGrant = await call('POST', '/resources/apply', {
    token,
    body: { resource: 'ore', delta: 1_000, reason: 'debug_grant', requestId: 'ore-cap' }
  })
  assert.equal(oreGrant.status, 200)
  assert.equal(record(oreGrant.body).ore, (beforeDebugGrants.resources.ore ?? 0) + 1_000)
  const foodGrant = await call('POST', '/resources/apply', {
    token,
    body: { resource: 'food', delta: 1_000, reason: 'debug_grant', requestId: 'food-over-cap' }
  })
  assert.equal(foodGrant.status, 200)
  assert.equal(record(foodGrant.body).ore, record(oreGrant.body).ore, 'the following request does not collapse over-cap ore')
  assert.equal(record(foodGrant.body).food, (beforeDebugGrants.resources.food ?? 0) + 1_000)
  now = new Date(now.getTime() + 1_000)
  const durableDebugWorld = record((await call('GET', '/world', { token })).body).world as SessionResponse['world']
  assert.equal(durableDebugWorld.resources.ore, record(oreGrant.body).ore)
  assert.equal(durableDebugWorld.resources.food, record(foodGrant.body).food)
  await persistence.base.transaction(async tx => {
    assert.equal(await tx.balanceLedger.sumSince(
      session.player.id,
      'resources:debug_grant',
      'ore',
      new Date('2026-07-11T00:00:00.000Z')
    ), 1_000, 'the ledger records the full over-cap debug grant')
    const village = await tx.villages.get(session.player.id)
    assert.equal(village?.ore, record(oreGrant.body).ore)
    assert.equal(village?.food, record(foodGrant.body).food)
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
  const goldBeforeMerchant = durableDebugWorld.resources.gold
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
  const builtWorld = record((await call('GET', '/world', { token })).body).world as SessionResponse['world']
  assert.ok(
    (builtWorld.resources.ore ?? 0) > (builtWorld.storage?.ore ?? Number.MAX_SAFE_INTEGER),
    'tutorial placement and subsequent writes preserve the remaining debug overflow'
  )

  const upgradeStartedAt = now.getTime()
  const watchtowerUpgrade = await call('POST', '/world/save', {
    token,
    body: {
      world: {
        ...builtWorld,
        buildings: builtWorld.buildings.map(building => (
          building.id === 'runtime-onboarding-watchtower' ? { ...building, level: 2 } : building
        ))
      },
      requestId: 'upgrade-watchtower'
    }
  })
  assert.equal(watchtowerUpgrade.status, 200)
  const pendingWorld = record(watchtowerUpgrade.body).world as SessionResponse['world']
  const pendingWatchtower = pendingWorld.buildings.find(building => building.id === 'runtime-onboarding-watchtower')
  assert.equal(pendingWatchtower?.level, 1)
  assert.equal(pendingWatchtower?.upgradingTo, 2)
  assert.equal(pendingWatchtower?.upgradeStartedAt, upgradeStartedAt)
  assert.equal(pendingWatchtower?.upgradeEndsAt, upgradeStartedAt + 1_000)
  assert.equal(
    pendingWorld.resources.ore,
    (builtWorld.resources.ore ?? 0) - upgradeCharge('watchtower', 1, 2).ore
  )

  now = new Date(upgradeStartedAt + 999)
  const almostDone = record((await call('GET', '/world', { token })).body).world as SessionResponse['world']
  const almostDoneWatchtower = almostDone.buildings.find(building => building.id === 'runtime-onboarding-watchtower')
  assert.equal(almostDoneWatchtower?.upgradingTo, 2)
  assert.equal(almostDoneWatchtower?.upgradeStartedAt, upgradeStartedAt)
  assert.equal(almostDoneWatchtower?.upgradeEndsAt, upgradeStartedAt + 1_000)
  now = new Date(upgradeStartedAt + 1_000)
  const upgradeDone = record((await call('GET', '/world', { token })).body).world as SessionResponse['world']
  const upgradeDoneWatchtower = upgradeDone.buildings.find(building => building.id === 'runtime-onboarding-watchtower')
  assert.equal(upgradeDoneWatchtower?.level, 2)
  assert.equal(upgradeDoneWatchtower?.upgradingTo, undefined)
  assert.equal(upgradeDoneWatchtower?.upgradeStartedAt, undefined)
  assert.equal(upgradeDoneWatchtower?.upgradeEndsAt, undefined)

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
  const armyBatch = await call('POST', '/army/batch', {
    token,
    body: {
      operations: [
        { kind: 'train', type: 'warrior', count: 2 },
        { kind: 'untrain', type: 'warrior', count: 1 }
      ],
      requestId: 'runtime-mixed-army-batch'
    }
  })
  assert.equal(armyBatch.status, 200)
  assert.equal((record(armyBatch.body).army as Record<string, number>).warrior, 2)
  assert.equal(record(record(armyBatch.body).world).revision, record(armyBatch.body).revision)
  const homeSync = await call('GET', '/home/sync', { token })
  assert.equal(homeSync.status, 200)
  assert.equal(typeof record(homeSync.body).serverNow, 'number')
  assert.equal(typeof record(record(homeSync.body).world).revision, 'number')
  assert.equal(typeof record(record(homeSync.body).world).lastSaveTime, 'number')
  assert.equal(record(homeSync.body).incomingAttack, null)

  // Populate several neighboring authorities, then prove the local map uses
  // one bounded active-edge projection rather than one incoming query per row.
  for (let index = 0; index < 8; index += 1) await service.ensureSession('', `neighbor-${index}`)
  persistence.incomingQueries = 0
  persistence.bulkQueries = 0
  const homeMap = await service.map(principal, session.player.plotX, session.player.plotY, 1)
  assert.equal(record(homeMap).plots instanceof Array, true)
  const ownPostcard = (record(homeMap).plots as unknown[])
    .map(record)
    .find(plot => plot.ownerId === session.player.id)
  assert(ownPostcard)
  assert.deepEqual(record(ownPostcard.world).banner, chosenBanner)
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

  const raceA = grantedSession(await service.ensureSession('', 'register-race-a'))
  const raceB = grantedSession(await service.ensureSession('', 'register-race-b'))
  const registrationRace = await Promise.allSettled([
    service.register(raceA.token, 'OneSharedName', 'correct-horse'),
    service.register(raceB.token, 'OneSharedName', 'correct-horse')
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
  const atlasSelf = (record(atlas.body).players as unknown[])
    .map(record)
    .find(player => player.me === true)
  assert(atlasSelf)
  assert.deepEqual(atlasSelf.banner, chosenBanner)
  const selfScout = await call('GET', `/players/${session.player.id}/world`, { token: loginSession.token })
  assert.equal(selfScout.status, 200)
  assert.equal(record(record(selfScout.body).world).ownerId, session.player.id)
  assert.deepEqual(record(record(selfScout.body).world).banner, chosenBanner)
  assert.equal((await call('GET', '/notifications', { token: loginSession.token })).status, 200)
  assert.equal((await call('POST', '/notifications/read', { token: loginSession.token })).status, 200)

  const relocated = await call('POST', '/map/relocate', { token: loginSession.token, body: {} })
  assert.equal(relocated.status, 200)
  assert.notDeepEqual(record(record(relocated.body).me), {
    x: session.player.plotX,
    y: session.player.plotY,
    plotVersion: 1
  })

  const expiringGuest = grantedSession(await service.ensureSession('', 'lease-atomicity'))
  const authExpiredGuest = grantedSession(await service.ensureSession('', 'auth-expired-lease'))
  now = new Date(now.getTime() + 8 * 24 * 60 * 60_000)
  persistence.resetAuthorityReads()
  await assert.rejects(service.authenticate(authExpiredGuest.token), error => (
    error instanceof ApiError && error.status === 401
  ))
  assert.deepEqual(
    persistence.lockOrder.slice(0, 4),
    ['accounts', 'accounts', 'plots', 'sessions'],
    'authentication fences moderation first, then cleanup locks account and plot before its token row'
  )
  await persistence.base.transaction(async tx => {
    assert.equal(await tx.world.getPlayerPlot(authExpiredGuest.player.id), null)
    assert.equal(await tx.accounts.getById(authExpiredGuest.player.id), null)
  })
  const expiredCoordinate = `${expiringGuest.player.plotX},${expiringGuest.player.plotY}`
  authorized.add(expiredCoordinate)
  const hiddenBotBefore = await persistence.base.transaction(tx => tx.world.getBotVillageAt(
    'main', expiringGuest.player.plotX, expiringGuest.player.plotY
  ))
  const expiredLeaseMap = record(await service.map(
    principal, expiringGuest.player.plotX, expiringGuest.player.plotY, 0
  ))
  const expiredLeasePlot = (expiredLeaseMap.plots as unknown[]).map(record)[0]
  assert.deepEqual(expiredLeasePlot, {
    x: expiringGuest.player.plotX,
    y: expiringGuest.player.plotY,
    kind: 'empty',
    settleable: false
  }, 'an expired-but-unreaped claim cannot be exposed or provisioned as a bot')
  assert.deepEqual(await persistence.base.transaction(tx => tx.world.getBotVillageAt(
    'main', expiringGuest.player.plotX, expiringGuest.player.plotY
  )), hiddenBotBefore, 'map leaves any bot hidden beneath an unreaped claim unchanged')
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

test('explicit infinite resources waive every player spend without weakening game rules', async () => {
  const persistence = new MemoryPersistence()
  const now = new Date('2026-07-14T12:00:00.000Z')
  const service = new PersistenceGameService(persistence, {
    now: () => new Date(now),
    starterShieldMs: 0,
    allowDebugGrants: false,
    allowGuestSessions: true,
    infiniteResources: true
  })

  const session = grantedSession(await service.ensureSession('', 'runtime-infinite'))
  const principal: RuntimePrincipal = { playerId: session.player.id }
  const initial = { ...session.world.resources }
  assert.equal(session.features.infiniteResources, true)
  assert.deepEqual(initial, { gold: 100_000, ore: 100_000, food: 100_000 })

  const freeSpend = record(await service.applyResources(principal, {
    resource: 'gold',
    delta: -999_999,
    requestId: 'infinite-negative'
  }))
  assert.deepEqual(
    { gold: freeSpend.gold, ore: freeSpend.ore, food: freeSpend.food },
    initial,
    'an otherwise-impossible direct spend is accepted without debiting a finite stored balance'
  )
  assert.deepEqual(await service.applyResources(principal, {
    resource: 'gold',
    delta: -999_999,
    requestId: 'infinite-negative'
  }), freeSpend, 'the waived spend remains idempotent')

  const beforePlacement = await service.getWorld(principal)
  const placed = await service.saveWorld(principal, {
    world: {
      ...beforePlacement,
      buildings: [
        ...beforePlacement.buildings,
        { id: 'infinite-prism', type: 'prism', gridX: 2, gridY: 18, level: 1 }
      ]
    },
    requestId: 'infinite-place-prism'
  })
  assert(placed.buildings.some(building => building.id === 'infinite-prism'))
  assert.deepEqual(
    placed.resources,
    initial,
    'an otherwise-unaffordable prism can be placed without charging either currency'
  )

  const upgrading = await service.saveWorld(principal, {
    world: {
      ...placed,
      buildings: placed.buildings.map(building => (
        building.id === 'infinite-prism' ? { ...building, level: 2 } : building
      ))
    },
    requestId: 'infinite-upgrade-prism'
  })
  const pendingPrism = upgrading.buildings.find(building => building.id === 'infinite-prism')
  assert.equal(pendingPrism?.level, 1)
  assert.equal(pendingPrism?.upgradingTo, 2)
  assert.deepEqual(
    upgrading.resources,
    initial,
    'an otherwise-unaffordable prism upgrade starts without a debit'
  )

  const trained = record(await service.trainTroop(principal, {
    type: 'warrior',
    count: 50,
    requestId: 'infinite-train-capacity'
  }))
  assert.equal(record(trained.army).warrior, 50)
  assert.deepEqual(
    { gold: trained.gold, ore: trained.ore, food: trained.food },
    initial,
    'training can consume the full starter food stock without changing stored balances'
  )
  await assert.rejects(service.trainTroop(principal, {
    type: 'warrior',
    count: 1,
    requestId: 'infinite-over-housing'
  }), error => (
    error instanceof ApiError && error.status === 409 && /housing/i.test(error.message)
  ), 'infinite resources do not grant infinite army housing')

  const traded = record(await service.merchantTrade(principal, {
    offerId: 1,
    requestId: 'infinite-merchant'
  }))
  assert.equal(traded.applied, true)
  assert.deepEqual(
    { gold: traded.gold, ore: traded.ore, food: traded.food },
    initial,
    'redeeming a merchant offer records its state without moving resource balances'
  )
  assert.deepEqual(await service.merchantTrade(principal, {
    offerId: 1,
    requestId: 'infinite-merchant'
  }), traded, 'the merchant response replays idempotently')
  await assert.rejects(service.merchantTrade(principal, {
    offerId: 1,
    requestId: 'infinite-merchant-second-key'
  }), error => error instanceof ApiError && error.status === 409,
  'the once-per-day merchant rule still applies')

  await persistence.transaction(async tx => {
    const stored = await tx.villages.get(session.player.id)
    assert(stored)
    assert.deepEqual(
      { gold: stored.gold, ore: stored.ore, food: stored.food },
      initial,
      'infinite mode never persists a giant sentinel balance'
    )
  })
  await service.close()
})

test('finite persistence mode still rejects unaffordable layouts and charges spends', async () => {
  const now = new Date('2026-07-14T12:00:00.000Z')
  const service = new PersistenceGameService(new MemoryPersistence(), {
    now: () => new Date(now),
    starterShieldMs: 0,
    allowDebugGrants: false,
    allowGuestSessions: true,
    infiniteResources: false
  })
  const session = grantedSession(await service.ensureSession('', 'runtime-finite-control'))
  const principal: RuntimePrincipal = { playerId: session.player.id }
  assert.equal(session.features.infiniteResources, false)

  // This control exercises low-wallet rejection semantics explicitly. Starter
  // balances are live-ops tuning and may intentionally begin above capacity.
  for (const [resource, target] of [['gold', 2_000], ['ore', 100], ['food', 100]] as const) {
    await service.applyResources(principal, {
      resource,
      delta: target - (session.world.resources[resource] ?? 0),
      requestId: `finite-control-${resource}`
    })
  }
  const lowWalletWorld = await service.getWorld(principal)

  await assert.rejects(service.saveWorld(principal, {
    world: {
      ...lowWalletWorld,
      buildings: [
        ...lowWalletWorld.buildings,
        { id: 'finite-prism', type: 'prism', gridX: 2, gridY: 18, level: 1 }
      ]
    },
    requestId: 'finite-place-prism'
  }), error => (
    error instanceof ApiError
      && error.status === 409
      && error.code === 'INSUFFICIENT_RESOURCES'
      && error.details?.resource === 'ore'
  ), 'the same prism is rejected at an explicit low ore balance')

  const trained = record(await service.trainTroop(principal, {
    type: 'warrior',
    count: 2,
    requestId: 'finite-train-two'
  }))
  assert.equal(trained.gold, 1_950)
  assert.equal(trained.food, 96)

  const spent = record(await service.applyResources(principal, {
    resource: 'gold',
    delta: -10,
    requestId: 'finite-negative'
  }))
  assert.equal(spent.gold, 1_940)

  const traded = record(await service.merchantTrade(principal, {
    offerId: 1,
    requestId: 'finite-merchant'
  }))
  assert.equal(traded.applied, true)
  assert(Number(traded.gold) < Number(spent.gold), 'finite merchant trades still debit their give-side')
  assert(Number(traded.ore) > Number(spent.ore), 'finite merchant trades still credit their get-side')

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
    allowDebugGrants: false,
    infiniteResources: false
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
    sessionTtlMs: 1,
    allowGuestSessions: true,
    infiniteResources: false
  })
  const guest = grantedSession(await service.ensureSession('', 'short-device-session'))
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

test('production registration wall: no guest villages, registration creates account + plot, tokens grandfather', async () => {
  const persistence = new MemoryPersistence()
  const now = new Date('2026-07-18T12:00:00.000Z')
  // Dev-flavored service on the SAME persistence: mints the pre-existing
  // guest that must stay grandfathered once the wall is up.
  const devService = new PersistenceGameService(persistence, {
    now: () => new Date(now),
    starterShieldMs: 0,
    allowGuestSessions: true
  })
  const legacyGuest = grantedSession(await devService.ensureSession('', 'pre-wall-guest'))

  const service = new PersistenceGameService(persistence, {
    now: () => new Date(now),
    starterShieldMs: 0,
    allowGuestSessions: false
  })

  try {
    // A fresh device gets the wall — and neither an account nor a plot exists for it.
    const walled = await service.ensureSession('', 'walled-device')
    assert.equal(isRegistrationRequired(walled), true)
    assert.deepEqual(walled, { registrationRequired: true })
    assert.throws(() => grantedSession(walled))

    // Registration with NO token creates the account AND allocates its plot.
    const registered = await service.register(null, 'WallChief', 'correct-horse-battery')
    assert.equal('token' in registered, true, 'anonymous registration answers a full session envelope')
    const session = registered as SessionResponse
    assert.equal(session.created, true)
    assert.equal(session.player.registered, true)
    assert.equal(session.player.username, 'WallChief')
    assert.equal(Number.isFinite(session.player.plotX) && Number.isFinite(session.player.plotY), true)
    assert.deepEqual(session.world.resources, { gold: 100_000, ore: 100_000, food: 100_000 })
    assert.deepEqual(starterBuildingPlacements(session.world), EXPECTED_STARTER_BUILDINGS)
    await persistence.transaction(async tx => {
      const plot = await tx.world.getPlayerPlot(session.player.id)
      assert(plot, 'registration claimed a plot through the shared allocation path')
      assert.equal(plot.leaseId, null, 'registered plots are permanent, not guest leases')
    })

    // The issued token resumes; a second device logs in with the same credentials.
    const resumed = grantedSession(await service.ensureSession(session.token, 'walled-device'))
    assert.equal(resumed.player.id, session.player.id)
    const secondDevice = await service.login('wallchief', 'correct-horse-battery')
    assert.equal(secondDevice.player.id, session.player.id)
    assert.notEqual(secondDevice.token, session.token)

    // Same username cannot be registered twice anonymously.
    await assert.rejects(service.register(null, 'WALLCHIEF', 'another-password'), error => (
      error instanceof ApiError && error.status === 409 && error.code === 'USERNAME_TAKEN'
    ))
    // A presented-but-dead token is a 401, never a silent second account.
    await assert.rejects(service.register('tok_bogus', 'GhostChief', 'correct-horse-battery'), error => (
      error instanceof ApiError && error.status === 401
    ))
    // Credential validation still runs before anything is created.
    await assert.rejects(service.register(null, 'x!', 'correct-horse-battery'), error => (
      error instanceof ApiError && error.status === 400
    ))
    await assert.rejects(service.register(null, 'ShortPwChief', 'short'), error => (
      error instanceof ApiError && error.status === 400
    ))

    // Pre-wall guests are grandfathered: their token resumes and they can
    // still upgrade in place through the token-bearing register path.
    const grandfathered = grantedSession(await service.ensureSession(legacyGuest.token, 'pre-wall-guest'))
    assert.equal(grandfathered.player.id, legacyGuest.player.id)
    const upgraded = await service.register(legacyGuest.token, 'GrandfatheredChief', 'correct-horse-battery')
    assert.equal('token' in upgraded, false, 'token-bearing registration keeps the in-place upgrade shape')
    const upgradedPlayer = (upgraded as { player: { id: string; registered: boolean } }).player
    assert.equal(upgradedPlayer.id, legacyGuest.player.id)
    assert.equal(upgradedPlayer.registered, true)
  } finally {
    await service.close()
  }
})
